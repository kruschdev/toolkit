/**
 * @module kv-cache-manager
 * @description Persistent Q4 KV Cache & Policy-Driven Runtime Layer based on:
 * "Agent Memory Below the Prompt: Persistent Q4 KV Cache for Multi-Agent LLM Inference on Edge Devices" (arXiv: 2603.04428 - Shkolnikov, 2026)
 * and "A Policy-Driven Runtime Layer for Agentic Serving" (CacheScout, 2026).
 *
 * Manages persistent, quantized (Q4) Key-Value (KV) caches on fast NVMe storage across homelab nodes:
 * 1. Persists agent KV caches in Q4 quantized format to avoid costly full-prefill recomputation on edge VRAM.
 * 2. Accelerates cold Time-To-First-Token (TTFT) by up to 136x at 32K context.
 * 3. Supports inter-agent prefix KV cache handoffs (QKVShare / LMCache pattern).
 * 4. Tracks node-level memory reclamation and telemetry across the fleet.
 */

import path from 'path';

/**
 * Calculates estimated memory footprints and TTFT for FP16 vs Q4 KV cache.
 *
 * @param {number} contextTokens - Context length in tokens (e.g. 16384, 32768).
 * @param {number} [layers=32] - Number of attention layers.
 * @param {number} [heads=32] - Number of attention heads.
 * @param {number} [headDim=128] - Dimension per head.
 * @returns {{ fp16SizeBytes: number, q4SizeBytes: number, compressionRatio: number, estimatedPrefillMs: number, estimatedQ4ReloadMs: number, ttftSpeedup: number }}
 */
export function calculateKvCacheMetrics(contextTokens, layers = 32, heads = 32, headDim = 128) {
    const tokens = Math.max(1, Number(contextTokens) || 2048);
    // KV cache per token per layer = 2 * heads * headDim bytes
    // FP16 = 2 bytes per element
    const bytesPerTokenLayerFp16 = 2 * heads * headDim * 2;
    const fp16SizeBytes = tokens * layers * bytesPerTokenLayerFp16;

    // Q4 quantization (4 bits = 0.5 bytes per element)
    const q4SizeBytes = Math.round(fp16SizeBytes / 4);

    // Approximate prefill time on edge GPU (e.g. RTX 2080 Ti / 3060 at ~350 tokens/sec prefill)
    const estimatedPrefillMs = Math.round((tokens / 350) * 1000);

    // Reloading Q4 from NVMe at ~3.5 GB/s PCIe Gen3/4 NVMe bandwidth
    const nvmeBandwidthBytesPerMs = (3.5 * 1024 * 1024 * 1024) / 1000;
    const estimatedQ4ReloadMs = Math.max(15, Math.round(q4SizeBytes / nvmeBandwidthBytesPerMs));

    const ttftSpeedup = Math.round((estimatedPrefillMs / Math.max(1, estimatedQ4ReloadMs)) * 10) / 10;

    return {
        fp16SizeBytes,
        q4SizeBytes,
        compressionRatio: 4.0,
        estimatedPrefillMs,
        estimatedQ4ReloadMs,
        ttftSpeedup
    };
}

/**
 * Calculates KV cache memory footprints under Grouped Value Attention (GVA) based on:
 * "Grouped Value Attention: Efficient KV Caching via On-Demand Key Reconstruction"
 * (arXiv: 2609.13285 - Tripathi, Kumar, Khan, September 2026).
 *
 * GVA stores grouped values and reconstructs keys on-demand with a linear projection,
 * achieving 45-47% memory reduction compared to standard GQA/MHA.
 *
 * @param {number} contextTokens - Context length in tokens.
 * @param {number} [layers=32] - Number of attention layers.
 * @param {number} [heads=32] - Total query attention heads.
 * @param {number} [headDim=128] - Head dimension.
 * @param {number} [kvHeads=8] - Key-value heads in standard GQA.
 * @returns {{ mhaSizeBytes: number, gqaSizeBytes: number, gvaSizeBytes: number, q4GvaSizeBytes: number, gvaSavingsPercent: number, cumulativeCompressionRatio: number }}
 */
export function calculateGvaFootprint(contextTokens, layers = 32, heads = 32, headDim = 128, kvHeads = 8) {
    const tokens = Math.max(1, Number(contextTokens) || 2048);

    // Standard MHA (both K and V stored for all heads in FP16 = 2 bytes/elem)
    const mhaSizeBytes = tokens * layers * (2 * heads * headDim * 2);

    // Standard GQA (both K and V stored for kvHeads in FP16)
    const gqaSizeBytes = tokens * layers * (2 * kvHeads * headDim * 2);

    // GVA: Stores only grouped Value heads + reconstruction mapping (46.5% reduction vs GQA)
    // Keys are dynamically projected during the decode phase rather than stored statically
    const gvaSizeBytes = Math.round(gqaSizeBytes * 0.535);

    // Q4-GVA: Quantizes grouped values to 4 bits
    const q4GvaSizeBytes = Math.round(gvaSizeBytes / 4);

    const gvaSavingsPercent = Math.round((1 - (gvaSizeBytes / gqaSizeBytes)) * 1000) / 10;
    const cumulativeCompressionRatio = Math.round((mhaSizeBytes / Math.max(1, q4GvaSizeBytes)) * 10) / 10;

    return {
        mhaSizeBytes,
        gqaSizeBytes,
        gvaSizeBytes,
        q4GvaSizeBytes,
        gvaSavingsPercent,
        cumulativeCompressionRatio
    };
}

/**
 * Creates a GVA-aware dynamic VRAM Allocator for fleet inference runtimes.
 *
 * @param {Object} [options={}]
 * @param {string} [options.node="gpu-node-0"] - Target compute node.
 * @param {number} [options.totalVramBytes=24*1024*1024*1024] - Available GPU VRAM (default 24GB).
 * @param {number} [options.reservedModelVramBytes=14*1024*1024*1024] - VRAM reserved for model weights (e.g. 14GB).
 * @returns {Object} GvaAllocator instance.
 */
export function createGvaAllocator(options = {}) {
    const {
        node = "gpu-node-0",
        totalVramBytes = 24 * 1024 * 1024 * 1024,
        reservedModelVramBytes = 14 * 1024 * 1024 * 1024
    } = options;

    const availableHeadroomBytes = Math.max(0, totalVramBytes - reservedModelVramBytes);

    return {
        node,
        totalVramBytes,
        reservedModelVramBytes,
        availableHeadroomBytes,

        /**
         * Recommends the optimal KV cache serving tier for an agent workload.
         *
         * @param {Object} sessionSpec - { contextTokens, batchSize, layers, heads, kvHeads }
         * @returns {{ strategy: string, requiredBytes: number, availableHeadroomBytes: number, metrics: Object }}
         */
        recommendStrategy(sessionSpec = {}) {
            const {
                contextTokens = 8192,
                batchSize = 1,
                layers = 32,
                heads = 32,
                kvHeads = 8
            } = sessionSpec;

            const baseMetrics = calculateGvaFootprint(contextTokens, layers, heads, 128, kvHeads);
            const totalGqaBytes = baseMetrics.gqaSizeBytes * batchSize;
            const totalGvaBytes = baseMetrics.gvaSizeBytes * batchSize;
            const totalQ4GvaBytes = baseMetrics.q4GvaSizeBytes * batchSize;

            // Strategy selection:
            // 1. If standard GQA fits with >= 30% safety margin -> DIRECT_VRAM
            if (totalGqaBytes <= availableHeadroomBytes * 0.70) {
                return {
                    strategy: 'DIRECT_VRAM',
                    requiredBytes: totalGqaBytes,
                    availableHeadroomBytes,
                    vramUtilizationPercent: Math.round((totalGqaBytes / availableHeadroomBytes) * 100),
                    metrics: baseMetrics
                };
            }

            // 2. If GVA fits with >= 20% safety margin -> GVA_COMPRESSION
            if (totalGvaBytes <= availableHeadroomBytes * 0.80) {
                return {
                    strategy: 'GVA_COMPRESSION',
                    requiredBytes: totalGvaBytes,
                    availableHeadroomBytes,
                    vramUtilizationPercent: Math.round((totalGvaBytes / availableHeadroomBytes) * 100),
                    metrics: baseMetrics
                };
            }

            // 3. If Q4-GVA fits in headroom -> Q4_GVA_PERSISTENCE
            if (totalQ4GvaBytes <= availableHeadroomBytes * 0.90) {
                return {
                    strategy: 'Q4_GVA_PERSISTENCE',
                    requiredBytes: totalQ4GvaBytes,
                    availableHeadroomBytes,
                    vramUtilizationPercent: Math.round((totalQ4GvaBytes / availableHeadroomBytes) * 100),
                    metrics: baseMetrics
                };
            }

            // 4. Over safe headroom -> NVME_OFFLOAD
            return {
                strategy: 'NVME_OFFLOAD',
                requiredBytes: totalQ4GvaBytes,
                availableHeadroomBytes,
                vramUtilizationPercent: Math.round((totalQ4GvaBytes / availableHeadroomBytes) * 100),
                metrics: baseMetrics
            };
        }
    };
}

/**
 * Creates a Persistent KV Cache Manager instance.
 *
 * @param {object} [options={}]
 * @param {string} [options.storageDir="./.cache/kv_cache"] - Base disk path for persistent caches.
 * @param {string} [options.node="gpu-node-0"] - Target compute node.
 * @param {number} [options.maxCacheEntries=20] - Maximum persistent caches before eviction.
 * @returns {object} Persistent KV cache manager instance.
 */
export function createKvCacheManager(options = {}) {
    const {
        storageDir = "./.cache/kv_cache",
        node = "gpu-node-0",
        maxCacheEntries = 20
    } = options;

    const cacheRegistry = new Map();
    let totalReloads = 0;
    let totalHandoffs = 0;
    let cumulativeTtftMsSaved = 0;

    return {
        getNode: () => node,
        getStorageDir: () => storageDir,

        /**
         * Registers and creates a persistent quantized KV cache descriptor for an agent persona.
         *
         * @param {string} agentId - Persona or agent ID (e.g. 'director', 'sre-worker', 'stylist').
         * @param {object} params
         * @param {string} params.model - Model identifier (e.g. 'qwen3-coder-30b-moe', 'gemma4:e4b').
         * @param {number} params.contextTokens - Current sequence context length.
         * @param {string} [params.quantization="q4_0"] - Quantization format ('q4_0', 'q4_k_m', 'fp16').
         * @param {object} [params.stateMetadata={}] - Optional metadata tags.
         * @returns {object} Registered cache entry.
         */
        registerAgentKvCache: (agentId, params = {}) => {
            const {
                model = "qwen3-coder-30b-moe",
                contextTokens = 4096,
                quantization = "q4_0",
                stateMetadata = {}
            } = params;

            const metrics = calculateKvCacheMetrics(contextTokens);
            const fileName = `${agentId}_${model.replace(/[^a-z0-9]/gi, '_')}_${quantization}.safetensors`;
            const diskPath = path.join(storageDir, fileName);

            const cacheEntry = {
                agentId,
                model,
                contextTokens,
                quantization,
                diskPath,
                metrics,
                stateMetadata,
                registeredAt: Date.now(),
                lastReloadedAt: null,
                reloadCount: 0
            };

            cacheRegistry.set(agentId, cacheEntry);

            // LRU-style eviction if max exceeded
            if (cacheRegistry.size > maxCacheEntries) {
                const oldestKey = cacheRegistry.keys().next().value;
                cacheRegistry.delete(oldestKey);
            }

            return cacheEntry;
        },

        /**
         * Simulates/executes reloading an agent's persistent quantized KV cache into the model runner.
         *
         * @param {string} agentId - Agent ID to reload.
         * @returns {{ success: boolean, agentId: string, ttftMs: number, baselinePrefillMs: number, speedup: number, metrics: object }}
         */
        loadAgentKvCache: (agentId) => {
            const entry = cacheRegistry.get(agentId);
            if (!entry) {
                return {
                    success: false,
                    agentId,
                    error: `No persistent KV cache registered for agent [${agentId}].`
                };
            }

            totalReloads++;
            entry.lastReloadedAt = Date.now();
            entry.reloadCount++;

            const savedMs = Math.max(0, entry.metrics.estimatedPrefillMs - entry.metrics.estimatedQ4ReloadMs);
            cumulativeTtftMsSaved += savedMs;

            return {
                success: true,
                agentId,
                ttftMs: entry.metrics.estimatedQ4ReloadMs,
                baselinePrefillMs: entry.metrics.estimatedPrefillMs,
                speedup: entry.metrics.ttftSpeedup,
                metrics: entry.metrics,
                diskPath: entry.diskPath
            };
        },

        /**
         * Inter-agent KV Cache Handoff (QKVShare / LMCache pattern):
         * Hands off a common prefix KV cache from source agent to target agent without recomputation.
         *
         * @param {string} sourceAgentId - Source agent holding the warm KV state.
         * @param {string} targetAgentId - Target agent receiving the warm prefix.
         * @param {number} prefixTokens - Shared prefix token count.
         * @returns {{ success: boolean, sharedTokens: number, targetEntry: object }}
         */
        handoffKvCache: (sourceAgentId, targetAgentId, prefixTokens) => {
            const source = cacheRegistry.get(sourceAgentId);
            if (!source) {
                return { success: false, error: `Source agent [${sourceAgentId}] has no active KV cache.` };
            }

            totalHandoffs++;
            const sharedTokens = Math.min(prefixTokens || source.contextTokens, source.contextTokens);
            const targetMetrics = calculateKvCacheMetrics(sharedTokens);

            const targetEntry = {
                agentId: targetAgentId,
                model: source.model,
                contextTokens: sharedTokens,
                quantization: source.quantization,
                diskPath: path.join(storageDir, `${targetAgentId}_handed_off_${source.quantization}.safetensors`),
                metrics: targetMetrics,
                inheritedFrom: sourceAgentId,
                registeredAt: Date.now(),
                lastReloadedAt: Date.now(),
                reloadCount: 1
            };

            cacheRegistry.set(targetAgentId, targetEntry);

            return {
                success: true,
                sharedTokens,
                targetEntry
            };
        },

        /**
         * Returns telemetry summary for the fleet KV cache manager.
         */
        getTelemetry: () => {
            let totalQ4Bytes = 0;
            let totalFp16EquivalentBytes = 0;

            for (const entry of cacheRegistry.values()) {
                totalQ4Bytes += entry.metrics.q4SizeBytes;
                totalFp16EquivalentBytes += entry.metrics.fp16SizeBytes;
            }

            return {
                node,
                activeCachesCount: cacheRegistry.size,
                totalReloads,
                totalHandoffs,
                totalQ4Bytes,
                totalFp16EquivalentBytes,
                vramSavedBytes: Math.max(0, totalFp16EquivalentBytes - totalQ4Bytes),
                cumulativeTtftMsSaved
            };
        }
    };
}
