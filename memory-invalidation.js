/**
 * @module memory-invalidation
 * @description Knowledge Invalidation & Temporal Fact Superseding Engine based on:
 * "MobileMem: Learning from a Year of Mobile Experiences" (arXiv: 2608.13606).
 *
 * Provides first-class support for:
 * 1. Tracking memory lifecycle states (ACTIVE, SUPERSEDED, INVALIDATED).
 * 2. Fact superseding and lineage traversal (handling changed hardware specs, updated credentials, revised policies).
 * 3. Temporal recency and contradiction filtering so agents never retrieve stale, invalidated knowledge.
 * 4. Semantic contradiction detection before recording new memories.
 */

import crypto from 'crypto';
import { chatJson } from './llm.js';

/**
 * Filter an arbitrary list of memory records to return only valid, non-superseded, non-invalidated records.
 *
 * @param {Array<object>} memories - List of memory objects from pgvector, SQLite, or in-memory arrays.
 * @param {object} [options={}] - Filtering options.
 * @param {boolean} [options.strictLineage=true] - If true, discards any record whose ID is marked as superseded by a newer record.
 * @param {boolean} [options.dedupByEntity=false] - If true, keeps only the most recent active memory for each entity/key.
 * @returns {Array<object>} Filtered list of active, authoritative memories.
 */
export function filterActiveMemories(memories = [], options = {}) {
    if (!Array.isArray(memories)) return [];

    const strictLineage = options.strictLineage !== false;
    const dedupByEntity = !!options.dedupByEntity;

    // 1. Identify all IDs that have been explicitly superseded or invalidated
    const supersededIds = new Set();
    const invalidatedIds = new Set();

    for (const mem of memories) {
        if (mem.supersedesId != null) {
            supersededIds.add(mem.supersedesId);
        }
        if (mem.supersedes_id != null) {
            supersededIds.add(mem.supersedes_id);
        }
        if (Array.isArray(mem.supersedesIds)) {
            mem.supersedesIds.forEach(id => supersededIds.add(id));
        }
        if (Array.isArray(mem.supersedes_ids)) {
            mem.supersedes_ids.forEach(id => supersededIds.add(id));
        }
        if (mem.status === 'SUPERSEDED') {
            supersededIds.add(mem.id);
        }
        if (mem.status === 'INVALIDATED') {
            invalidatedIds.add(mem.id);
        }
    }

    // 2. Filter candidate pool
    let activeCandidates = memories.filter(mem => {
        if (mem.status === 'INVALIDATED' || mem.status === 'SUPERSEDED') return false;
        if (strictLineage && supersededIds.has(mem.id)) return false;
        if (invalidatedIds.has(mem.id)) return false;
        return true;
    });

    // 3. Optional entity-level deduplication (keeping newest timestamp)
    if (dedupByEntity) {
        const entityMap = new Map();
        for (const mem of activeCandidates) {
            const key = mem.entity || mem.key || mem.id;
            const existing = entityMap.get(key);
            if (!existing) {
                entityMap.set(key, mem);
            } else {
                const existingTime = new Date(existing.timestamp || existing.created_at || 0).getTime();
                const memTime = new Date(mem.timestamp || mem.created_at || 0).getTime();
                if (memTime > existingTime) {
                    entityMap.set(key, mem);
                }
            }
        }
        activeCandidates = Array.from(entityMap.values());
    }

    return activeCandidates;
}

/**
 * Marks an old memory record as superseded by a new memory record, creating a verifiable lineage link.
 *
 * @param {object} oldRecord - The original memory record.
 * @param {object} newRecordData - Data for the replacement record.
 * @param {string} [reason="Updated with newer facts"] - Rationale for superseding.
 * @returns {{ updatedOld: object, createdNew: object }}
 */
export function supersedeMemoryRecord(oldRecord, newRecordData, reason = "Updated with newer facts") {
    const timestamp = new Date().toISOString();
    const updatedOld = {
        ...oldRecord,
        status: 'SUPERSEDED',
        supersededBy: newRecordData.id || `mem_${Date.now()}`,
        invalidationReason: reason,
        updated_at: timestamp
    };

    const createdNew = {
        ...newRecordData,
        id: newRecordData.id || updatedOld.supersededBy,
        supersedesId: oldRecord.id,
        status: 'ACTIVE',
        timestamp: newRecordData.timestamp || timestamp,
        created_at: newRecordData.created_at || timestamp
    };

    return { updatedOld, createdNew };
}

/**
 * Builds the complete lineage history for a given memory ID across ancestral and child records.
 *
 * @param {Array<object>} memories - Pool of all memories.
 * @param {string|number} memoryId - The memory ID to trace.
 * @returns {{ target: object|null, ancestors: Array<object>, descendants: Array<object> }}
 */
export function buildMemoryLineage(memories = [], memoryId) {
    const idMap = new Map(memories.map(m => [String(m.id), m]));
    const target = idMap.get(String(memoryId)) || null;

    if (!target) {
        return { target: null, ancestors: [], descendants: [] };
    }

    // Traverse ancestors (who did this memory supersede?)
    const ancestors = [];
    let currentAncestorId = target.supersedesId || target.supersedes_id;
    while (currentAncestorId && idMap.has(String(currentAncestorId))) {
        const anc = idMap.get(String(currentAncestorId));
        ancestors.push(anc);
        currentAncestorId = anc.supersedesId || anc.supersedes_id;
    }

    // Traverse descendants (who superseded this memory?)
    const descendants = [];
    let currentDescendantId = target.supersededBy || target.superseded_by;
    while (currentDescendantId && idMap.has(String(currentDescendantId))) {
        const desc = idMap.get(String(currentDescendantId));
        descendants.push(desc);
        currentDescendantId = desc.supersededBy || desc.superseded_by;
    }

    return { target, ancestors, descendants };
}

/**
 * Stateful Invalidation Engine managing local memory states with temporal and semantic validation.
 */
export class MemoryInvalidationEngine {
    constructor(initialMemories = []) {
        this.memories = new Map();
        for (const mem of initialMemories) {
            this.memories.set(String(mem.id), {
                status: 'ACTIVE',
                created_at: new Date().toISOString(),
                ...mem
            });
        }
    }

    /**
     * Store or register a memory. If supersedesId is provided, the previous memory is automatically marked SUPERSEDED.
     */
    addMemory(memory) {
        const id = String(memory.id || `mem_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`);
        const timestamp = memory.timestamp || new Date().toISOString();

        const record = {
            id,
            entity: memory.entity || null,
            key: memory.key || null,
            content: memory.content || "",
            category: memory.category || "general",
            tags: Array.isArray(memory.tags) ? memory.tags : [],
            status: memory.status || 'ACTIVE',
            supersedesId: memory.supersedesId ? String(memory.supersedesId) : null,
            supersededBy: null,
            invalidationReason: null,
            timestamp,
            created_at: memory.created_at || timestamp,
            metadata: memory.metadata || {}
        };

        // If this supersedes an existing record, update the old one
        if (record.supersedesId && this.memories.has(record.supersedesId)) {
            const old = this.memories.get(record.supersedesId);
            old.status = 'SUPERSEDED';
            old.supersededBy = id;
            old.invalidationReason = memory.invalidationReason || `Superseded by memory ${id}`;
            old.updated_at = timestamp;
        }

        this.memories.set(id, record);
        return record;
    }

    /**
     * Explicitly invalidate a memory (e.g. decommissioned host, retracted policy).
     */
    invalidateMemory(memoryId, reason = "Explicitly invalidated") {
        const id = String(memoryId);
        if (!this.memories.has(id)) {
            throw new Error(`Memory with ID ${memoryId} not found.`);
        }
        const mem = this.memories.get(id);
        mem.status = 'INVALIDATED';
        mem.invalidationReason = reason;
        mem.updated_at = new Date().toISOString();
        return mem;
    }

    /**
     * Returns all active, authoritative memories filtered by optional criteria.
     */
    getActiveMemories(filter = {}) {
        const all = Array.from(this.memories.values());
        let filtered = filterActiveMemories(all, { dedupByEntity: filter.dedupByEntity });

        if (filter.category) {
            filtered = filtered.filter(m => m.category === filter.category);
        }
        if (filter.entity) {
            filtered = filtered.filter(m => m.entity === filter.entity || m.key === filter.entity);
        }
        if (filter.tag) {
            filtered = filtered.filter(m => m.tags.includes(filter.tag));
        }

        return filtered;
    }

    /**
     * Retrieve lineage for an ID.
     */
    getLineage(memoryId) {
        return buildMemoryLineage(Array.from(this.memories.values()), memoryId);
    }

    /**
     * Uses an LLM to evaluate whether a new incoming fact contradicts or supersedes any existing active memories.
     *
     * @param {string} newFactText - The new observation or fact text.
     * @param {object} [llmConfig={}] - LLM configuration for analysis.
     * @returns {Promise<{ hasContradiction: boolean, conflictingMemoryIds: Array<string>, suggestedAction: 'SUPERSEDE'|'APPEND'|'REJECT', rationale: string }>}
     */
    async detectContradictions(newFactText, llmConfig = {}) {
        const activeMemories = this.getActiveMemories();
        if (activeMemories.length === 0) {
            return {
                hasContradiction: false,
                conflictingMemoryIds: [],
                suggestedAction: 'APPEND',
                rationale: "No existing memories to conflict with."
            };
        }

        const systemPrompt = `You are an AI Memory Auditor (MobileMem arXiv: 2608.13606).
Your job is to compare a NEW INCOMING FACT against EXISTING ACTIVE MEMORIES.
Determine whether the new fact directly contradicts, updates, or supersedes any of the existing memories.

Rules:
1. If the new fact updates a state (e.g. node hardware upgraded, service migrated to new port, password rotated), identify the conflicting memory IDs and specify "SUPERSEDE".
2. If the new fact is complementary/additive, specify "APPEND" with empty conflicting IDs.
3. If the new fact is invalid or hallucinated, specify "REJECT".

Respond in JSON format:
{
  "hasContradiction": boolean,
  "conflictingMemoryIds": ["id1", "id2"],
  "suggestedAction": "SUPERSEDE" | "APPEND" | "REJECT",
  "rationale": "Brief 1-2 sentence explanation"
}`;

        const memoriesContext = activeMemories.map(m => `[ID: ${m.id}] (Entity: ${m.entity || 'N/A'}, Category: ${m.category}): ${m.content}`).join('\n');
        const userMessage = `## EXISTING ACTIVE MEMORIES
${memoriesContext}

## NEW INCOMING FACT
${newFactText}`;

        const result = await chatJson(systemPrompt, userMessage, { ...llmConfig, temperature: 0.1 });

        return {
            hasContradiction: !!result?.hasContradiction,
            conflictingMemoryIds: Array.isArray(result?.conflictingMemoryIds) ? result.conflictingMemoryIds : [],
            suggestedAction: result?.suggestedAction || 'APPEND',
            rationale: result?.rationale || "Analysis completed."
        };
    }
}

/**
 * Computes a deterministic SHA-256 hash of a file or code artifact string.
 *
 * @param {string} content - Raw file or code content.
 * @returns {string} Hex hash string.
 */
export function computeArtifactHash(content = "") {
    return crypto.createHash('sha256').update(typeof content === 'string' ? content : JSON.stringify(content)).digest('hex');
}

/**
 * Artifact-Anchored Verification Memory (EA-Graph) based on:
 * "EA-Graph: Artifact-Anchored Verification Memory for Coding Agents under Upstream Drift" (arXiv: 2608.04278).
 *
 * Anchors verification assertions, test results, and spec compliance claims directly to source file content hashes.
 * Automatically invalidates dependent verification claims when upstream files experience drift.
 */
export class ArtifactVerificationGraph {
    constructor() {
        this.claims = new Map(); // claimId -> { claimId, statement, status, fileAnchors: [{ path, hash, symbol }], timestamp, metadata }
    }

    /**
     * Anchors a verification claim to one or more source code artifacts.
     *
     * @param {object} claim
     * @param {string} claim.claimId - Unique claim identifier.
     * @param {string} claim.statement - Verification claim statement (e.g. "auth middleware satisfies JWT spec").
     * @param {Array<{path: string, content?: string, hash?: string, symbol?: string}>} claim.fileAnchors - Dependent file artifacts.
     * @param {object} [claim.metadata={}] - Optional metadata (e.g. testPassNumber, toolName).
     * @returns {object} The registered claim record.
     */
    anchorClaim(claim) {
        const claimId = String(claim.claimId || `claim_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`);
        const anchors = (claim.fileAnchors || []).map(a => ({
            path: a.path,
            hash: a.hash || (a.content ? computeArtifactHash(a.content) : ''),
            symbol: a.symbol || null
        }));

        const record = {
            claimId,
            statement: claim.statement || "",
            status: 'VALID', // 'VALID' | 'STALE_DRIFT' | 'INVALIDATED'
            fileAnchors: anchors,
            driftReason: null,
            timestamp: new Date().toISOString(),
            metadata: claim.metadata || {}
        };

        this.claims.set(claimId, record);
        return record;
    }

    /**
     * Checks current files against anchored claims to identify upstream drift.
     *
     * @param {Array<{path: string, content: string}>} currentFiles - List of current active files.
     * @returns {{ hasDrift: boolean, driftedClaimIds: Array<string>, details: Array<{claimId: string, driftedFile: string, expectedHash: string, currentHash: string}> }}
     */
    checkArtifactDrift(currentFiles = []) {
        const currentHashMap = new Map();
        for (const file of currentFiles) {
            currentHashMap.set(file.path, computeArtifactHash(file.content));
        }

        const driftedClaims = [];
        const details = [];

        for (const [claimId, claim] of this.claims.entries()) {
            if (claim.status === 'INVALIDATED') continue;

            for (const anchor of claim.fileAnchors) {
                if (currentHashMap.has(anchor.path)) {
                    const currentHash = currentHashMap.get(anchor.path);
                    if (anchor.hash && currentHash !== anchor.hash) {
                        driftedClaims.push(claimId);
                        details.push({
                            claimId,
                            driftedFile: anchor.path,
                            expectedHash: anchor.hash.slice(0, 10),
                            currentHash: currentHash.slice(0, 10)
                        });
                        break; // Claim is already drifted
                    }
                }
            }
        }

        return {
            hasDrift: driftedClaims.length > 0,
            driftedClaimIds: [...new Set(driftedClaims)],
            details
        };
    }

    /**
     * Automatically invalidates all claims affected by upstream file drift.
     *
     * @param {Array<{path: string, content: string}>} currentFiles - Current active files.
     * @returns {{ invalidatedCount: number, invalidatedClaims: Array<object> }}
     */
    invalidateDriftedClaims(currentFiles = []) {
        const drift = this.checkArtifactDrift(currentFiles);
        const invalidatedClaims = [];

        for (const claimId of drift.driftedClaimIds) {
            const claim = this.claims.get(claimId);
            if (claim && claim.status === 'VALID') {
                claim.status = 'STALE_DRIFT';
                const fileDetail = drift.details.find(d => d.claimId === claimId);
                claim.driftReason = fileDetail 
                    ? `Upstream source file "${fileDetail.driftedFile}" mutated (hash mismatch)`
                    : "Upstream code artifacts modified";
                claim.invalidatedAt = new Date().toISOString();
                invalidatedClaims.push(claim);
            }
        }

        return {
            invalidatedCount: invalidatedClaims.length,
            invalidatedClaims
        };
    }

    /**
     * Returns all currently valid claims whose code dependencies have not drifted.
     */
    getValidClaims() {
        return Array.from(this.claims.values()).filter(c => c.status === 'VALID');
    }
}

/**
 * Functional helper: Anchors a single verification claim into an EA-Graph.
 */
export function anchorVerificationClaim(graph, claim) {
    if (!graph || typeof graph.anchorClaim !== 'function') {
        throw new Error("A valid ArtifactVerificationGraph instance is required.");
    }
    return graph.anchorClaim(claim);
}

/**
 * Functional helper: Checks artifact drift for a list of claims.
 */
export function checkArtifactDrift(claims = [], currentFiles = []) {
    const graph = new ArtifactVerificationGraph();
    for (const c of claims) graph.anchorClaim(c);
    return graph.checkArtifactDrift(currentFiles);
}

