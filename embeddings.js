/**
 * @module @krusch/toolkit/embeddings
 * Unified Sovereign Embedding Engine for @krusch/toolkit.
 *
 * Enforces INV-01..INV-06:
 * - Modern Ollama POST /api/embed batching with automatic HTTP 404 fallback to /api/embeddings
 * - Matryoshka Representation Learning (MRL) dimension control (e.g., qwen3-embedding:4b -> 1024d)
 * - Context-window-aware overlapping chunking (512-ctx BGE vs 8K/32K Qwen3/Arctic/Nomic/Gemini)
 * - Asymmetric query vs document instruction prefixes
 * - Strict vector-space & LRU cache isolation (zero silent cross-model contamination)
 * - Rough-In Suite createEmbeddings(config, namespace, db) pgvector compatibility
 */

import crypto from 'node:crypto';

// Default local Ollama endpoint (override via OLLAMA_EMBED_HOST or OLLAMA_URL)
export const DEFAULT_EMBED_HOST = 'http://127.0.0.1:11434';
export const DEFAULT_EMBED_MODEL = 'snowflake-arctic-embed2';
export const DEFAULT_EMBED_DIMS = 1024;

const MAX_LRU_CACHE_SIZE = 512;

const QWEN3_DOMAIN_TASKS = Object.freeze({
    general: 'Given a search query, retrieve relevant passages that answer the query',
    code: 'Given a code search query, retrieve relevant source code snippets, symbols, and documentation',
    law: 'Given a legal query, retrieve controlling statutes, case law, and regulatory provisions',
    biz: 'Given a business or contract query, retrieve relevant clauses, agreements, and corporate records',
    memory: 'Given an agent context query, retrieve relevant episodic memories, architectural decisions, and invariants'
});

export const MODEL_PROFILES = Object.freeze({
    'bge-large': Object.freeze({
        provider: 'ollama',
        ctxTokens: 512,
        nativeDimensions: 1024,
        defaultDimensions: 1024,
        mrlDimensions: false,
        maxChunkChars: 1100,
        overlapChars: 180,
        queryStyle: 'bge'
    }),
    'qwen3-embedding:0.6b': Object.freeze({
        provider: 'ollama',
        ctxTokens: 32768,
        nativeDimensions: 1024,
        defaultDimensions: 1024,
        mrlDimensions: true,
        maxChunkChars: 6000,
        overlapChars: 400,
        queryStyle: 'qwen3'
    }),
    'qwen3-embedding:4b': Object.freeze({
        provider: 'ollama',
        ctxTokens: 32768,
        nativeDimensions: 2560,
        defaultDimensions: 1024,
        mrlDimensions: true,
        maxChunkChars: 6000,
        overlapChars: 400,
        queryStyle: 'qwen3'
    }),
    'snowflake-arctic-embed2': Object.freeze({
        provider: 'ollama',
        ctxTokens: 8192,
        nativeDimensions: 1024,
        defaultDimensions: 1024,
        mrlDimensions: false,
        maxChunkChars: 6000,
        overlapChars: 400,
        queryStyle: 'arctic'
    }),
    'nomic-embed-text': Object.freeze({
        provider: 'ollama',
        ctxTokens: 8192,
        nativeDimensions: 768,
        defaultDimensions: 768,
        mrlDimensions: true,
        maxChunkChars: 4000,
        overlapChars: 300,
        queryStyle: 'nomic'
    }),
    'gemini-embedding-001': Object.freeze({
        provider: 'gemini',
        ctxTokens: 8192,
        nativeDimensions: 3072,
        defaultDimensions: 1024,
        mrlDimensions: true,
        maxChunkChars: 6000,
        overlapChars: 400,
        queryStyle: 'none'
    })
});

const SAFE_DEFAULT_PROFILE = Object.freeze({
    provider: 'ollama',
    ctxTokens: 512,
    nativeDimensions: DEFAULT_EMBED_DIMS,
    defaultDimensions: DEFAULT_EMBED_DIMS,
    mrlDimensions: false,
    maxChunkChars: 1100,
    overlapChars: 180,
    queryStyle: 'none'
});

const embeddingLruCache = new Map();

/**
 * Normalize model identifiers (e.g., 'bge-large:latest', 'models/gemini-embedding-001')
 * and return the matching model profile or a safe 1024d / 1100-char default.
 *
 * @param {string} [model=DEFAULT_EMBED_MODEL]
 * @returns {object}
 */
export function resolveEmbeddingProfile(model = DEFAULT_EMBED_MODEL) {
    const cleaned = String(model || DEFAULT_EMBED_MODEL)
        .trim()
        .toLowerCase()
        .replace(/^models\//, '');
    if (MODEL_PROFILES[cleaned]) {
        return { ...MODEL_PROFILES[cleaned] };
    }

    const withoutLatest = cleaned.replace(/:latest$/, '');
    if (MODEL_PROFILES[withoutLatest]) {
        return { ...MODEL_PROFILES[withoutLatest] };
    }

    if (withoutLatest.startsWith('bge-large') || withoutLatest.includes('/bge-large')) {
        return { ...MODEL_PROFILES['bge-large'] };
    }
    if (withoutLatest.startsWith('qwen3-embedding:4b')) {
        return { ...MODEL_PROFILES['qwen3-embedding:4b'] };
    }
    if (withoutLatest === 'qwen3-embedding' || withoutLatest.startsWith('qwen3-embedding:0.6b')) {
        return { ...MODEL_PROFILES['qwen3-embedding:0.6b'] };
    }
    if (withoutLatest.startsWith('qwen3-embedding')) {
        return { ...MODEL_PROFILES['qwen3-embedding:4b'] };
    }
    if (withoutLatest.startsWith('snowflake-arctic-embed2') || withoutLatest.includes('arctic-embed2')) {
        return { ...MODEL_PROFILES['snowflake-arctic-embed2'] };
    }
    if (withoutLatest.startsWith('nomic-embed-text')) {
        return { ...MODEL_PROFILES['nomic-embed-text'] };
    }
    if (withoutLatest.startsWith('gemini-embedding')) {
        return { ...MODEL_PROFILES['gemini-embedding-001'] };
    }

    return { ...SAFE_DEFAULT_PROFILE };
}

/**
 * Format input text with asymmetric query or document prefixes per model family (INV-04).
 *
 * @param {string} text
 * @param {object} [options={}]
 * @returns {string}
 */
export function formatEmbeddingInput(text, options = {}) {
    const rawText = text == null ? '' : String(text);
    if (rawText.length === 0) return '';

    const {
        model = DEFAULT_EMBED_MODEL,
        mode = 'document',
        domain = 'general',
        instruction,
        prefixDocuments = false
    } = options || {};

    const profile = resolveEmbeddingProfile(model);
    if (mode !== 'query') {
        if (profile.queryStyle === 'nomic' && prefixDocuments === true) {
            return `search_document: ${rawText}`;
        }
        return rawText;
    }

    if (profile.queryStyle === 'bge') {
        return `Represent this sentence for searching relevant passages: ${rawText}`;
    }
    if (profile.queryStyle === 'arctic') {
        return `query: ${rawText}`;
    }
    if (profile.queryStyle === 'nomic') {
        return `search_query: ${rawText}`;
    }
    if (profile.queryStyle === 'qwen3') {
        const customTask = typeof instruction === 'string' && instruction.trim().length > 0
            ? instruction.trim()
            : null;
        const domainTask = customTask || QWEN3_DOMAIN_TASKS[domain] || QWEN3_DOMAIN_TASKS.general;
        return `Instruct: ${domainTask}\nQuery:${rawText}`;
    }

    return rawText;
}

/**
 * Return an L2-normalized copy of a vector (returns copy unchanged if zero norm).
 *
 * @param {number[]} vector
 * @returns {number[]}
 */
export function l2Normalize(vector) {
    if (!Array.isArray(vector) && !ArrayBuffer.isView(vector)) return [];
    const copy = Array.from(vector);
    if (copy.length === 0) return copy;

    let sumSq = 0;
    for (let i = 0; i < copy.length; i++) {
        const val = copy[i];
        sumSq += val * val;
    }
    const norm = Math.sqrt(sumSq);
    if (norm === 0 || !Number.isFinite(norm)) return copy;

    for (let i = 0; i < copy.length; i++) {
        copy[i] = copy[i] / norm;
    }
    return copy;
}

/**
 * Check whether an embedding is missing, empty, or all zeros (INV-05 sqlite-vec guard).
 *
 * @param {number[]} vector
 * @returns {boolean}
 */
export function isZeroVector(vector) {
    if (!Array.isArray(vector) || vector.length === 0) return true;
    return vector.every((val) => val === 0);
}

/**
 * Safe float cosine similarity returning 0 on null, length mismatch, or zero norm.
 *
 * @param {number[]} vecA
 * @param {number[]} vecB
 * @returns {number}
 */
export function cosineSimilarity(vecA, vecB) {
    if (!Array.isArray(vecA) || !Array.isArray(vecB)) return 0;
    if (vecA.length === 0 || vecA.length !== vecB.length) return 0;

    let dot = 0;
    let normASq = 0;
    let normBSq = 0;
    for (let i = 0; i < vecA.length; i++) {
        const valA = vecA[i];
        const valB = vecB[i];
        if (!Number.isFinite(valA) || !Number.isFinite(valB)) return 0;
        dot += valA * valB;
        normASq += valA * valA;
        normBSq += valB * valB;
    }

    const denom = Math.sqrt(normASq) * Math.sqrt(normBSq);
    if (denom === 0 || !Number.isFinite(denom)) return 0;
    return dot / denom;
}

function isSparseSyntheticVector(vec) {
    if (!vec || typeof vec.length !== 'number') return false;
    const checkLen = Math.min(vec.length, 64);
    let nonZero = 0;
    for (let i = 0; i < checkLen; i++) {
        if (Math.abs(vec[i]) > 1e-7) nonZero++;
    }
    return nonZero < Math.min(12, checkLen);
}

/**
 * Calibrate raw query-to-document cosine similarity across embedding model geometries.
 * Anisotropic encoders (`bge-large`) cluster unrelated texts around ~0.48 and paraphrases around ~0.70,
 * whereas isotropic contrastive asymmetric encoders (`snowflake-arctic-embed2`, `qwen3-embedding`)
 * center unrelated texts near ~0.00 and paraphrases around ~0.36-0.55.
 *
 * @param {number} rawCosine
 * @param {{ model?: string, queryVec?: ArrayLike<number> | null }} [options={}]
 * @returns {number}
 */
export function calibrateQuerySimilarity(rawCosine, options = {}) {
    if (!Number.isFinite(rawCosine) || rawCosine <= 0) return 0;
    if (rawCosine >= 1) return 1;
    const { model = DEFAULT_EMBED_MODEL, queryVec = null } = options || {};
    if (queryVec && isSparseSyntheticVector(queryVec)) {
        return rawCosine;
    }
    const profile = resolveEmbeddingProfile(model);
    if (profile.queryStyle === 'arctic' || profile.queryStyle === 'qwen3') {
        if (rawCosine <= 0.12) {
            return rawCosine * 3.0;
        }
        if (rawCosine <= 0.38) {
            return 0.36 + ((rawCosine - 0.12) / 0.26) * 0.32;
        }
        if (rawCosine <= 0.60) {
            return 0.68 + ((rawCosine - 0.38) / 0.22) * 0.16;
        }
        return 0.84 + ((rawCosine - 0.60) / 0.40) * 0.16;
    }
    return rawCosine;
}

/**
 * Compute element-wise sum + L2 normalization across multiple vectors (null on empty).
 *
 * @param {number[][]} vectors
 * @returns {number[] | null}
 */
export function calculateCentroid(vectors) {
    if (!Array.isArray(vectors) || vectors.length === 0) return null;
    const valid = vectors.filter((vec) => Array.isArray(vec) && vec.length > 0);
    if (valid.length === 0) return null;

    const dim = valid[0].length;
    const summed = new Array(dim).fill(0);
    for (const vec of valid) {
        if (vec.length !== dim) {
            throw new Error(`[Centroid Dimension Mismatch] Expected ${dim} dimensions, received ${vec.length}.`);
        }
        for (let i = 0; i < dim; i++) {
            summed[i] += vec[i];
        }
    }
    return l2Normalize(summed);
}

/**
 * Assert vector dimension matches expectedDim; returns null for nullish/non-array inputs.
 *
 * @param {number[] | null | undefined} vector
 * @param {number} [expectedDim=DEFAULT_EMBED_DIMS]
 * @param {string} [context='Embedding']
 * @returns {number[] | null}
 */
export function validateVectorDimension(vector, expectedDim = DEFAULT_EMBED_DIMS, context = 'Embedding') {
    if (!Array.isArray(vector)) return null;
    if (vector.length !== expectedDim) {
        throw new Error(
            `[${context} Dimension Mismatch] Expected ${expectedDim} dimensions, received ${vector.length}.`
        );
    }
    for (let i = 0; i < vector.length; i++) {
        if (typeof vector[i] !== 'number' || !Number.isFinite(vector[i])) {
            throw new Error(`[${context} Invalid Value] Non-finite coordinate at index ${i}.`);
        }
    }
    return vector;
}

function projectSignedFeature(accumulator, feature, weight) {
    const digest = crypto.createHash('sha256').update(feature).digest();
    const dim = accumulator.length;
    for (let probe = 0; probe < 4; probe++) {
        const offset = probe * 5;
        const slot = digest.readUInt32BE(offset) % dim;
        const sign = (digest[offset + 4] & 1) === 0 ? 1 : -1;
        accumulator[slot] += sign * weight;
    }
}

/**
 * Generate a fast feature-hashed word unigram + bigram signed unit vector
 * for deterministic offline/CI semantic similarity.
 *
 * @param {string} text
 * @param {number} [dim=DEFAULT_EMBED_DIMS]
 * @returns {number[]}
 */
export function generateDeterministicVector(text, dim = DEFAULT_EMBED_DIMS) {
    const targetDim = Number.isInteger(dim) && dim > 0 ? dim : DEFAULT_EMBED_DIMS;
    if (!text || typeof text !== 'string') {
        return new Array(targetDim).fill(0);
    }

    const accumulator = new Array(targetDim).fill(0);
    const tokens = text.toLowerCase().match(/[a-z0-9_]+/g) || [];
    if (tokens.length === 0) {
        projectSignedFeature(accumulator, `raw:${text}`, 1.0);
        return l2Normalize(accumulator);
    }

    for (let i = 0; i < tokens.length; i++) {
        projectSignedFeature(accumulator, `u:${tokens[i]}`, 1.0);
        if (i + 1 < tokens.length) {
            projectSignedFeature(accumulator, `b:${tokens[i]}_${tokens[i + 1]}`, 1.15);
        }
    }
    return l2Normalize(accumulator);
}

function findChunkEnd(text, start, maxChars) {
    const hardEnd = Math.min(start + maxChars, text.length);
    if (hardEnd >= text.length) return text.length;

    const minBreak = start + Math.floor(maxChars * 0.8);
    const newlineIdx = text.lastIndexOf('\n', hardEnd);
    if (newlineIdx >= minBreak) return newlineIdx + 1;

    const spaceIdx = text.lastIndexOf(' ', hardEnd);
    if (spaceIdx >= minBreak) return spaceIdx + 1;

    return hardEnd;
}

/**
 * Split text into context-window-aware overlapping chunks driven by model profile (INV-03).
 *
 * @param {string} text
 * @param {object} [options={}]
 * @returns {string[]}
 */
export function chunkTextForEmbedding(text, options = {}) {
    if (!text || typeof text !== 'string' || text.trim().length === 0) return [];

    const profile = resolveEmbeddingProfile(options?.model);
    const maxChars = Math.max(
        64,
        Number(options?.maxChars) > 0 ? Math.floor(Number(options.maxChars)) : profile.maxChunkChars
    );
    const rawOverlap = options?.overlapChars !== undefined && options?.overlapChars !== null
        ? Math.floor(Number(options.overlapChars))
        : profile.overlapChars;
    const overlapChars = Math.max(0, Math.min(rawOverlap, Math.floor(maxChars / 2)));
    const maxChunks = Math.max(
        1,
        Number(options?.maxChunks) > 0 ? Math.floor(Number(options.maxChunks)) : 32
    );

    if (text.length <= maxChars) return [text];

    const chunks = [];
    let start = 0;
    while (start < text.length && chunks.length < maxChunks) {
        const end = findChunkEnd(text, start, maxChars);
        const slice = text.slice(start, end);
        if (slice.trim().length > 0) {
            chunks.push(slice);
        }
        if (end >= text.length) break;
        start = Math.max(start + 1, end - overlapChars);
    }

    if (chunks.length === maxChunks && start < text.length) {
        const tailSlice = text.slice(Math.max(0, text.length - maxChars));
        if (tailSlice.trim().length > 0) {
            chunks[maxChunks - 1] = tailSlice;
        }
    }
    return chunks;
}

/**
 * Clear the bounded 512-entry toolkit embedding LRU cache.
 */
export function clearToolkitEmbeddingCache() {
    embeddingLruCache.clear();
}

function getCachedVector(key) {
    if (!embeddingLruCache.has(key)) return null;
    const value = embeddingLruCache.get(key);
    embeddingLruCache.delete(key);
    embeddingLruCache.set(key, value);
    return [...value];
}

function setCachedVector(key, vector) {
    if (!Array.isArray(vector) || vector.length === 0) return;
    if (embeddingLruCache.has(key)) {
        embeddingLruCache.delete(key);
    } else if (embeddingLruCache.size >= MAX_LRU_CACHE_SIZE) {
        const oldestKey = embeddingLruCache.keys().next().value;
        embeddingLruCache.delete(oldestKey);
    }
    embeddingLruCache.set(key, [...vector]);
}

function normalizeOllamaBaseUrl(host) {
    const raw = String(
        host ||
        process.env.OLLAMA_EMBED_HOST ||
        process.env.OLLAMA_URL ||
        process.env.OLLAMA_BASE_URL ||
        DEFAULT_EMBED_HOST
    ).trim();
    return raw.replace(/\/api\/embed(?:dings)?\/?$/i, '').replace(/\/+$/, '');
}

async function readErrorBody(response) {
    try {
        if (typeof response?.text === 'function') return await response.text();
        if (typeof response?.json === 'function') return JSON.stringify(await response.json());
    } catch {
        // Ignore secondary body-parse errors on failed HTTP responses
    }
    return '';
}

async function postJsonWithTimeout(url, payload, timeoutMs, fetchImpl) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(250, Number(timeoutMs) || 30000));
    try {
        const response = await fetchImpl(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: controller.signal
        });
        if (response.status === 404) {
            return { ok: false, status: 404, data: null, errorText: 'Not Found' };
        }
        if (!response.ok) {
            const errorText = await readErrorBody(response);
            return { ok: false, status: response.status, data: null, errorText };
        }
        const data = await response.json();
        return { ok: true, status: response.status, data, errorText: '' };
    } catch (err) {
        throw new Error(`❌ Embedding request failed (${url}): ${err.message}`, { cause: err });
    } finally {
        clearTimeout(timer);
    }
}

function finalizeVectors(rawVectors, expectedDim, context) {
    return rawVectors.map((rawVec) => {
        if (!Array.isArray(rawVec)) {
            throw new Error(`❌ [${context}] Missing embedding array in provider response.`);
        }
        validateVectorDimension(rawVec, expectedDim, context);
        return l2Normalize(rawVec);
    });
}

async function embedOllamaLegacySequential(baseUrl, model, batch, keepAlive, timeoutMs, fetchImpl) {
    const vectors = [];
    for (const item of batch) {
        const res = await postJsonWithTimeout(
            `${baseUrl}/api/embeddings`,
            { model, prompt: item, truncate: true, keep_alive: keepAlive },
            timeoutMs,
            fetchImpl
        );
        if (!res.ok) {
            throw new Error(`❌ Ollama /api/embeddings HTTP ${res.status}: ${res.errorText}`);
        }
        const rawVec = res.data?.embedding ?? res.data?.embeddings?.[0];
        vectors.push(rawVec);
    }
    return vectors;
}

async function embedOllamaSubBatch(baseUrl, model, profile, batch, dimensions, keepAlive, timeoutMs, fetchImpl) {
    const payload = {
        model,
        input: batch,
        truncate: true,
        keep_alive: keepAlive,
        ...(profile.mrlDimensions && dimensions ? { dimensions } : {})
    };
    const res = await postJsonWithTimeout(`${baseUrl}/api/embed`, payload, timeoutMs, fetchImpl);
    if (res.status === 404) {
        return await embedOllamaLegacySequential(baseUrl, model, batch, keepAlive, timeoutMs, fetchImpl);
    }
    if (!res.ok) {
        throw new Error(`❌ Ollama /api/embed HTTP ${res.status}: ${res.errorText}`);
    }

    if (Array.isArray(res.data?.embeddings) && res.data.embeddings.length === batch.length) {
        return res.data.embeddings;
    }
    if (batch.length === 1 && Array.isArray(res.data?.embedding)) {
        return [res.data.embedding];
    }
    throw new Error(`❌ Ollama /api/embed returned invalid embeddings count for batch of ${batch.length}.`);
}

async function embedGeminiSubBatch(apiKey, model, batch, dimensions, mode, timeoutMs, fetchImpl) {
    const cleanModel = String(model || 'gemini-embedding-001').trim().replace(/^models\//, '');
    const modelResource = `models/${cleanModel}`;
    const taskType = mode === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT';
    const baseEndpoint = `https://generativelanguage.googleapis.com/v1beta/${modelResource}`;

    if (batch.length === 1) {
        const url = `${baseEndpoint}:embedContent?key=${encodeURIComponent(apiKey)}`;
        const payload = {
            model: modelResource,
            content: { parts: [{ text: batch[0] }] },
            taskType,
            outputDimensionality: dimensions
        };
        const res = await postJsonWithTimeout(url, payload, timeoutMs, fetchImpl);
        if (!res.ok) {
            throw new Error(`❌ Gemini embedContent HTTP ${res.status}: ${res.errorText}`);
        }
        const values = res.data?.embedding?.values ?? res.data?.embeddings?.[0]?.values ?? res.data?.embeddings?.[0];
        return [values];
    }

    const url = `${baseEndpoint}:batchEmbedContents?key=${encodeURIComponent(apiKey)}`;
    const requests = batch.map((text) => ({
        model: modelResource,
        content: { parts: [{ text }] },
        taskType,
        outputDimensionality: dimensions
    }));
    const res = await postJsonWithTimeout(url, { requests }, timeoutMs, fetchImpl);
    if (!res.ok) {
        throw new Error(`❌ Gemini batchEmbedContents HTTP ${res.status}: ${res.errorText}`);
    }
    const items = Array.isArray(res.data?.embeddings) ? res.data.embeddings : [];
    if (items.length !== batch.length) {
        throw new Error(`❌ Gemini batchEmbedContents returned ${items.length} vectors for batch of ${batch.length}.`);
    }
    return items.map((entry) => (Array.isArray(entry) ? entry : entry?.values));
}

function resolveBatchSettings(options = {}) {
    const model = options.model || process.env.EMBED_MODEL || process.env.EMBEDDING_MODEL || DEFAULT_EMBED_MODEL;
    const profile = resolveEmbeddingProfile(model);
    const envDims = Number(process.env.EMBED_DIMS || process.env.EMBEDDING_DIM);
    const dimensions = Number(options.dimensions) > 0
        ? Number(options.dimensions)
        : (Number.isInteger(envDims) && envDims > 0 ? envDims : (profile.defaultDimensions || DEFAULT_EMBED_DIMS));
    const isMock = Boolean(options.mock || process.env.MOCK_EMBEDDINGS === '1');
    const apiKey = options.apiKey ?? process.env.GEMINI_API_KEY ?? '';
    const isGeminiProvider = profile.provider === 'gemini' && !options.host;

    return {
        model,
        profile,
        dimensions,
        isMock,
        apiKey,
        isGeminiProvider,
        mode: options.mode || 'document',
        domain: options.domain || 'general',
        instruction: options.instruction,
        prefixDocuments: Boolean(options.prefixDocuments),
        keepAlive: options.keepAlive !== undefined ? options.keepAlive : -1,
        timeoutMs: Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 30000,
        batchSize: Math.max(1, Number(options.batchSize) || 32),
        fetchImpl: options.fetchImpl || globalThis.fetch,
        allowProviderFallback: Boolean(options.allowProviderFallback)
    };
}

/**
 * Embed a batch of strings via Ollama (/api/embed -> 404 /api/embeddings), Gemini, or offline mock.
 * Every returned vector is dimension-validated and L2-normalized.
 *
 * @param {string[]} texts
 * @param {object} [options={}]
 * @returns {Promise<number[][]>}
 */
export async function embedBatch(texts, options = {}) {
    if (!Array.isArray(texts) || texts.length === 0) return [];

    const cfg = resolveBatchSettings(options);
    if (cfg.isMock) {
        return texts.map((text) => {
            const vec = generateDeterministicVector(String(text ?? ''), cfg.dimensions);
            validateVectorDimension(vec, cfg.dimensions, 'MockEmbed');
            return vec;
        });
    }

    if (cfg.isGeminiProvider) {
        if (!cfg.apiKey && !cfg.allowProviderFallback) {
            throw new Error(
                `❌ Gemini embedding model "${cfg.model}" requires apiKey or GEMINI_API_KEY (cross-provider fallback disabled by INV-05).`
            );
        }
        if (cfg.apiKey) {
            try {
                const geminiVectors = [];
                for (let i = 0; i < texts.length; i += cfg.batchSize) {
                    const subBatch = texts.slice(i, i + cfg.batchSize).map((item) => String(item ?? ''));
                    const raw = await embedGeminiSubBatch(
                        cfg.apiKey, cfg.model, subBatch, cfg.dimensions, cfg.mode, cfg.timeoutMs, cfg.fetchImpl
                    );
                    geminiVectors.push(...finalizeVectors(raw, cfg.dimensions, 'GeminiEmbed'));
                }
                return geminiVectors;
            } catch (err) {
                if (!cfg.allowProviderFallback) throw err;
                console.warn(`⚠️ Gemini embedding failed (${err.message}); allowProviderFallback=true -> Ollama.`);
            }
        }
    }

    const fallbackToDefaultOllama = cfg.profile.provider === 'gemini' && cfg.allowProviderFallback;
    const ollamaModel = fallbackToDefaultOllama ? DEFAULT_EMBED_MODEL : cfg.model;
    const ollamaProfile = fallbackToDefaultOllama ? resolveEmbeddingProfile(DEFAULT_EMBED_MODEL) : cfg.profile;
    const baseUrl = normalizeOllamaBaseUrl(options.host);
    const formatted = texts.map((text) =>
        formatEmbeddingInput(String(text ?? ''), {
            model: ollamaModel,
            mode: cfg.mode,
            domain: cfg.domain,
            instruction: cfg.instruction,
            prefixDocuments: cfg.prefixDocuments
        })
    );

    const results = [];
    for (let i = 0; i < formatted.length; i += cfg.batchSize) {
        const subBatch = formatted.slice(i, i + cfg.batchSize);
        const raw = await embedOllamaSubBatch(
            baseUrl, ollamaModel, ollamaProfile, subBatch, cfg.dimensions, cfg.keepAlive, cfg.timeoutMs, cfg.fetchImpl
        );
        results.push(...finalizeVectors(raw, cfg.dimensions, 'OllamaEmbed'));
    }
    return results;
}

/**
 * Single-text embedding wrapper backed by the 512-entry mode/model-isolated LRU cache.
 *
 * @param {string} text
 * @param {object} [options={}]
 * @returns {Promise<number[] | null>}
 */
export async function embed(text, options = {}) {
    if (typeof text !== 'string' || text.trim().length === 0) return null;

    const cfg = resolveBatchSettings(options);
    const providerTag = cfg.isMock ? 'mock' : (cfg.isGeminiProvider ? 'gemini' : 'ollama');
    const domainTag = cfg.instruction ? `${cfg.domain}#${cfg.instruction}` : cfg.domain;
    const cacheKey = `${cfg.dimensions}:${providerTag}:${String(cfg.model).trim()}:${cfg.mode}:${domainTag}:${text}`;

    const cached = getCachedVector(cacheKey);
    if (cached) return cached;

    const [vector] = await embedBatch([text], options);
    if (!vector) return null;
    setCachedVector(cacheKey, vector);
    return [...vector];
}

/**
 * Split long text into context-safe overlapping windows, batch-embed, and compute unit centroid.
 *
 * @param {string} text
 * @param {object} [options={}]
 * @returns {Promise<number[] | null>}
 */
export async function embedChunkedCentroid(text, options = {}) {
    if (typeof text !== 'string' || text.trim().length === 0) return null;

    const chunks = chunkTextForEmbedding(text, options);
    if (chunks.length === 0) return null;

    const vectors = await embedBatch(chunks, options);
    return calculateCentroid(vectors);
}

const SIMILARITY_SEARCH_SQL = `SELECT c.id, c.document_id, c.content, c.chunk_index, c.metadata, d.title, d.source_type, d.source_ref, 1 - (c.embedding <=> $1::vector) AS similarity FROM chunks c JOIN documents d ON d.id = c.document_id WHERE c.embedding IS NOT NULL AND 1 - (c.embedding <=> $1::vector) >= $2 ORDER BY c.embedding <=> $1::vector LIMIT $3`;

/**
 * Create a scoped embeddings + pgvector similaritySearch client for Rough-In Suite packages (INV-06).
 *
 * @param {object} [config={}]
 * @param {string} [namespace='default']
 * @param {{ query: Function } | null} [db=null]
 * @returns {{ embedText: Function, embedBatch: Function, similaritySearch: Function }}
 */
export function createEmbeddings(config = {}, namespace = 'default', db = null) {
    const rawModel = config?.ai?.embeddingModel
        || process.env.EMBED_MODEL
        || process.env.EMBEDDING_MODEL
        || DEFAULT_EMBED_MODEL;
    const host = config?.ai?.ollamaUrl || process.env.OLLAMA_EMBED_HOST || process.env.OLLAMA_URL;
    const apiKey = config?.ai?.apiKey || process.env.GEMINI_API_KEY;
    const dimensions = Number(config?.ai?.embeddingDimensions)
        || Number(process.env.EMBED_DIMS)
        || DEFAULT_EMBED_DIMS;
    const configuredProvider = String(config?.ai?.provider || '').trim().toLowerCase();

    const normalizedRaw = String(rawModel).trim().replace(/^models\//, '');
    const useOllamaDefault =
        normalizedRaw === 'gemini-embedding-001' &&
        !apiKey &&
        Boolean(host) &&
        configuredProvider === 'ollama';
    const effectiveModel = useOllamaDefault ? DEFAULT_EMBED_MODEL : rawModel;
    const effectiveProfile = resolveEmbeddingProfile(effectiveModel);
    const baseOptions = {
        model: effectiveModel,
        dimensions,
        domain: namespace || 'general',
        ...(effectiveProfile.provider === 'ollama' && host ? { host } : {}),
        ...(apiKey ? { apiKey } : {})
    };

    const embedText = async (text, opts = {}) => await embed(text, { ...baseOptions, ...opts });
    const scopedEmbedBatch = async (texts, opts = {}) => await embedBatch(texts, { ...baseOptions, ...opts });

    const similaritySearch = async (queryText, searchOpts = {}, legacyThreshold = undefined) => {
        if (!db || typeof db.query !== 'function') {
            throw new Error(`❌ [${namespace}] Database client with query() is required for similaritySearch.`);
        }
        if (typeof queryText !== 'string' || queryText.trim().length === 0) return [];

        const defaultLimit = Number(config?.ai?.maxContextChunks) > 0 ? Number(config.ai.maxContextChunks) : 5;
        const defaultThreshold = Number.isFinite(Number(config?.ai?.similarityThreshold))
            ? Number(config.ai.similarityThreshold)
            : 0.3;
        const isNumericLimit = typeof searchOpts === 'number';
        const optsObj = !isNumericLimit && searchOpts && typeof searchOpts === 'object' ? searchOpts : {};
        const limit = isNumericLimit
            ? (Number.isFinite(searchOpts) && searchOpts > 0 ? searchOpts : defaultLimit)
            : (Number(optsObj.limit) > 0 ? Number(optsObj.limit) : defaultLimit);
        const threshold = typeof legacyThreshold === 'number' && Number.isFinite(legacyThreshold)
            ? legacyThreshold
            : (optsObj.threshold !== undefined && Number.isFinite(Number(optsObj.threshold))
                ? Number(optsObj.threshold)
                : defaultThreshold);

        const vec = await embed(queryText, { ...baseOptions, ...optsObj, mode: 'query' });
        if (!vec || isZeroVector(vec)) return [];

        const vecLiteral = `[${vec.join(',')}]`;
        const res = await db.query(SIMILARITY_SEARCH_SQL, [vecLiteral, threshold, limit]);
        return res?.rows ?? res ?? [];
    };

    return { embedText, embedBatch: scopedEmbedBatch, similaritySearch };
}
