/**
 * @module @krusch/toolkit/raw-rag
 * Source-Preserving Episodic Retrieval & Append-Only Memory Primitives (arXiv:2610.30755).
 *
 * Implements the empirical invariants from "Is Complex Agentic Memory Always Needed?
 * Naive RAG Is Stronger Than We Thought" (Bao et al., 2026):
 * - Zero-LLM ingestion (`llmIngestionCalls === 0`): preserves verbatim dialogue, dates,
 *   identifiers, and multi-hop state transitions without lossy summarization or atomic extraction.
 * - Source-preserving 256-token sliding windows with 32-token overlap (`stride = 224`) and
 *   exact back-pointers to source conversation turns.
 * - Two-stage retrieval: wide dense recall (`Top-128`) + cross-encoder / System-1 YES-NO
 *   logprob reranking (`Top-15`).
 * - Graceful 5,000-token context budget degradation: disables turn expansion first before
 *   dropping or prefix-clipping any of the selected top-k evidence windows.
 * - Append-only write normalization (`ADD` / `NONE`): converts destructive `UPDATE` into
 *   non-destructive `ADD` with `supersedesId` lineage and blocks non-compliance `DELETE`.
 * - Coverage / Utilization (`C_hat`, `U_hat`) and Conditional Path Retention (`P(path|result)`)
 *   diagnostic evaluators, plus Appendix E (`Table 34`) RAG baseline auditing.
 */

import crypto from 'node:crypto';
import {
    DEFAULT_EMBED_MODEL,
    DEFAULT_EMBED_DIMS,
    embed,
    embedBatch,
    cosineSimilarity,
    calibrateQuerySimilarity,
    generateDeterministicVector
} from './embeddings.js';
import { calibrateChoiceLogprobs } from './decide.js';

export const RAW_RAG_DEFAULTS = Object.freeze({
    windowTokens: 256,
    overlapTokens: 32,
    strideTokens: 224,
    denseCandidateK: 128,
    finalRerankK: 15,
    maxEvidenceTokens: 5000,
    turnExpansion: true,
    deduplicateTurns: false,
    chronologicalOrder: true,
    llmIngestionCalls: 0
});

export const RAG_BASELINE_CONSTRAINTS = Object.freeze({
    minChunkTokens: 64,
    recommendedChunkRange: Object.freeze([128, 1024]),
    maxRecommendedChunkTokens: 1024,
    minRecommendedTopK: 5,
    optimalTopKRange: Object.freeze([10, 30]),
    maxDistractorSafeTopK: 60,
    recommendedDenseCandidateK: 128,
    requiresCrossEncoderRerank: true,
    allowDestructiveOverwrite: false
});

export const QWEN_RERANKER_TEMPLATE = Object.freeze({
    system: 'Judge whether the Document meets the requirements based on the Query and the Instruct provided. Note that the answer can only be "yes" or "no".',
    instruction: 'Given a question and a passage, determine if the passage contains information relevant to answering the question.'
});

const STOPWORDS = new Set([
    'the', 'and', 'for', 'that', 'this', 'with', 'from', 'have', 'has', 'had',
    'what', 'when', 'where', 'which', 'who', 'whom', 'whose', 'why', 'how',
    'was', 'were', 'are', 'been', 'being', 'into', 'onto', 'upon', 'about',
    'does', 'did', 'doing', 'would', 'could', 'should', 'will', 'shall', 'may',
    'might', 'must', 'can', 'their', 'there', 'they', 'them', 'then', 'than',
    'your', 'yours', 'our', 'ours', 'his', 'her', 'hers', 'its'
]);

export const LEGAL_BOILERPLATE_STOPWORDS = Object.freeze(new Set([
    'agreement', 'agreements', 'party', 'parties', 'company', 'contract', 'contracts',
    'section', 'sections', 'article', 'articles', 'clause', 'clauses', 'pursuant',
    'hereof', 'thereof', 'herein', 'therein', 'hereunder', 'including', 'applicable',
    'provision', 'provisions', 'terms'
]));

/**
 * Tokenize text while preserving exact character `[start, end)` offsets so 256-token
 * windows with 32-token overlap slice cleanly on token boundaries without splitting words.
 *
 * @param {string} text
 * @returns {Array<{ token: string, start: number, end: number }>}
 */
export function tokenizeWithOffsets(text) {
    if (typeof text !== 'string' || text.length === 0) return [];
    const tokens = [];
    const pattern = /[A-Za-z0-9_]+|[^\sA-Za-z0-9_]/g;
    let match;
    while ((match = pattern.exec(text)) !== null) {
        tokens.push({
            token: match[0],
            start: match.index,
            end: match.index + match[0].length
        });
    }
    return tokens;
}

/**
 * Deterministic token count matching `tokenizeWithOffsets`.
 *
 * @param {string} text
 * @returns {number}
 */
export function estimateTokenCount(text) {
    return tokenizeWithOffsets(text).length;
}

/**
 * Serialize a single dialogue turn preserving date (`"unknown"` when absent), speaker,
 * verbatim content, and optional inline image captions without LLM transformation.
 *
 * @param {object|string} turn
 * @param {number} [index=0]
 * @returns {{
 *   turnIndex: number,
 *   turnId: string,
 *   date: string,
 *   speaker: string,
 *   content: string,
 *   imageCaptions: string[],
 *   phase: number | null,
 *   timestamp: number | null,
 *   serialized: string
 * }}
 */
export function serializeConversationTurn(turn, index = 0) {
    if (typeof turn === 'string') {
        const content = turn.trim();
        const serialized = `[Date: unknown] Turn ${index + 1}: ${content}`;
        return {
            turnIndex: index,
            turnId: `turn_${index}`,
            date: 'unknown',
            speaker: `Turn ${index + 1}`,
            content,
            imageCaptions: [],
            phase: null,
            timestamp: null,
            serialized
        };
    }

    const safeTurn = turn && typeof turn === 'object' ? turn : {};
    const turnId = String(safeTurn.turnId ?? safeTurn.id ?? `turn_${index}`);
    const rawDate = safeTurn.date ?? safeTurn.sessionDate ?? safeTurn.createdAt ?? null;
    const date = rawDate !== null && rawDate !== undefined && String(rawDate).trim().length > 0
        ? String(rawDate).trim()
        : 'unknown';
    const speaker = String(safeTurn.speaker ?? safeTurn.role ?? `Speaker_${index + 1}`).trim() || `Speaker_${index + 1}`;
    const content = String(safeTurn.content ?? safeTurn.text ?? '').trim();

    const rawCaptions = Array.isArray(safeTurn.imageCaptions)
        ? safeTurn.imageCaptions
        : (typeof safeTurn.imageCaption === 'string' && safeTurn.imageCaption.trim() ? [safeTurn.imageCaption] : []);
    const imageCaptions = rawCaptions.map((c) => String(c).trim()).filter(Boolean);

    const phase = Number.isFinite(Number(safeTurn.phase)) ? Number(safeTurn.phase) : null;
    let timestamp = null;
    if (Number.isFinite(Number(safeTurn.timestamp))) {
        timestamp = Number(safeTurn.timestamp);
    } else if (date !== 'unknown') {
        const parsed = Date.parse(date);
        if (Number.isFinite(parsed)) timestamp = parsed;
    }

    const captionSuffix = imageCaptions.length > 0
        ? `\n${imageCaptions.map((cap) => `[Image Caption]: ${cap}`).join('\n')}`
        : '';
    const serialized = `[Date: ${date}] ${speaker}: ${content}${captionSuffix}`;

    return {
        turnIndex: index,
        turnId,
        date,
        speaker,
        content,
        imageCaptions,
        phase,
        timestamp,
        serialized
    };
}

/**
 * Partition a conversation history `H = (m_1, ..., m_T)` into overlapping 256-token
 * windows (`overlap = 32`, `stride = 224`) while retaining exact source turn indices
 * for display-time turn expansion and causal phase filtering.
 *
 * @param {Array<object|string>} turns
 * @param {object} [options={}]
 * @param {number} [options.windowTokens=256]
 * @param {number} [options.overlapTokens=32]
 * @param {string} [options.idPrefix='win']
 * @returns {{
 *   serializedTurns: ReturnType<typeof serializeConversationTurn>[],
 *   windows: Array<{
 *     windowId: string,
 *     windowIndex: number,
 *     text: string,
 *     contentHash: string,
 *     startToken: number,
 *     endToken: number,
 *     tokenCount: number,
 *     turnIndices: number[],
 *     turnIds: string[],
 *     minPhase: number | null,
 *     maxPhase: number | null,
 *     minTimestamp: number | null,
 *     maxTimestamp: number | null
 *   }>,
 *   totalTokens: number
 * }}
 */
export function chunkConversationWindows(turns = [], options = {}) {
    if (!Array.isArray(turns) || turns.length === 0) {
        return { serializedTurns: [], windows: [], totalTokens: 0 };
    }

    const windowTokens = Math.max(
        16,
        Number.isInteger(options.windowTokens) && options.windowTokens > 0
            ? options.windowTokens
            : RAW_RAG_DEFAULTS.windowTokens
    );
    const rawOverlap = Number.isInteger(options.overlapTokens) && options.overlapTokens >= 0
        ? options.overlapTokens
        : RAW_RAG_DEFAULTS.overlapTokens;
    const overlapTokens = Math.min(rawOverlap, Math.floor(windowTokens / 2));
    const stride = Math.max(1, windowTokens - overlapTokens);
    const idPrefix = String(options.idPrefix || 'win');
    const isolatePhases = Boolean(options.isolatePhases);

    const serializedTurns = turns.map((turn, idx) => serializeConversationTurn(turn, idx));

    const segments = [];
    if (!isolatePhases) {
        segments.push(serializedTurns);
    } else {
        let currentSegment = [];
        for (const sTurn of serializedTurns) {
            if (
                currentSegment.length > 0 &&
                sTurn.phase !== currentSegment[currentSegment.length - 1].phase &&
                (sTurn.phase !== null || currentSegment[currentSegment.length - 1].phase !== null)
            ) {
                segments.push(currentSegment);
                currentSegment = [sTurn];
            } else {
                currentSegment.push(sTurn);
            }
        }
        if (currentSegment.length > 0) segments.push(currentSegment);
    }

    const windows = [];
    let windowIndex = 0;
    let globalTokenOffset = 0;

    for (const segTurns of segments) {
        const pieces = [];
        const turnCharSpans = [];
        let cursor = 0;

        for (let i = 0; i < segTurns.length; i++) {
            if (i > 0) {
                pieces.push('\n');
                cursor += 1;
            }
            const segmentText = segTurns[i].serialized;
            const startChar = cursor;
            const endChar = cursor + segmentText.length;
            pieces.push(segmentText);
            turnCharSpans.push({ turnIndex: segTurns[i].turnIndex, startChar, endChar });
            cursor = endChar;
        }

        const segStream = pieces.join('');
        const segTokens = tokenizeWithOffsets(segStream);
        if (segTokens.length === 0) continue;

        for (let startTok = 0; startTok < segTokens.length; startTok += stride) {
            const endTok = Math.min(startTok + windowTokens, segTokens.length);
            const startChar = segTokens[startTok].start;
            const endChar = segTokens[endTok - 1].end;
            const text = segStream.slice(startChar, endChar);
            const contentHash = crypto.createHash('sha256').update(text).digest('hex');

            const turnIndices = [];
            for (const span of turnCharSpans) {
                if (span.endChar > startChar && span.startChar < endChar) {
                    turnIndices.push(span.turnIndex);
                }
            }

            const turnIds = turnIndices.map((idx) => serializedTurns[idx].turnId);
            const phases = turnIndices
                .map((idx) => serializedTurns[idx].phase)
                .filter((p) => p !== null);
            const timestamps = turnIndices
                .map((idx) => serializedTurns[idx].timestamp)
                .filter((ts) => ts !== null);

            windows.push({
                windowId: `${idPrefix}_${windowIndex}`,
                windowIndex,
                text,
                contentHash,
                startToken: globalTokenOffset + startTok,
                endToken: globalTokenOffset + endTok,
                tokenCount: endTok - startTok,
                turnIndices,
                turnIds,
                minPhase: phases.length > 0 ? Math.min(...phases) : null,
                maxPhase: phases.length > 0 ? Math.max(...phases) : null,
                minTimestamp: timestamps.length > 0 ? Math.min(...timestamps) : null,
                maxTimestamp: timestamps.length > 0 ? Math.max(...timestamps) : null
            });

            windowIndex += 1;
            if (endTok >= segTokens.length) break;
        }

        globalTokenOffset += segTokens.length;
    }

    return {
        serializedTurns,
        windows,
        totalTokens: globalTokenOffset
    };
}

/**
 * Audit a RAG or agentic memory retrieval configuration against Appendix E (`Table 34`)
 * and Section 5.4 (`Table 5`) baseline failure modes.
 *
 * @param {object} [config={}]
 * @returns {{
 *   valid: boolean,
 *   status: 'STRONG_RAW_RAG' | 'SUBOPTIMAL' | 'WEAKENED_BASELINE',
 *   findings: Array<{ code: string, severity: 'error' | 'warning', message: string }>,
 *   recommendedConfig: typeof RAW_RAG_DEFAULTS
 * }}
 */
export function auditRagBaselineConfig(config = {}) {
    const chunkTokens = Number(config.chunkTokens ?? config.windowTokens ?? RAW_RAG_DEFAULTS.windowTokens);
    const finalTopK = Number(config.finalTopK ?? config.topK ?? config.finalRerankK ?? RAW_RAG_DEFAULTS.finalRerankK);
    const denseCandidateK = Number(config.denseCandidateK ?? RAW_RAG_DEFAULTS.denseCandidateK);
    const rerankerEnabled = config.rerankerEnabled !== undefined
        ? Boolean(config.rerankerEnabled)
        : Boolean(config.reranker ?? true);
    const allowDestructiveOverwrite = Boolean(config.allowDestructiveOverwrite || config.allowDelete);
    const llmIngestionTransform = Boolean(config.llmIngestionTransform);

    const findings = [];

    if (chunkTokens > RAG_BASELINE_CONSTRAINTS.maxRecommendedChunkTokens) {
        findings.push({
            code: 'CHUNK_TOO_LARGE',
            severity: 'error',
            message: `chunkTokens=${chunkTokens} exceeds 1024 tokens (Appendix E Table 34 anti-pattern: dilutes dense embeddings and wastes reader budget).`
        });
    } else if (chunkTokens < RAG_BASELINE_CONSTRAINTS.minChunkTokens) {
        findings.push({
            code: 'CHUNK_TOO_SMALL',
            severity: 'warning',
            message: `chunkTokens=${chunkTokens} is below 64 tokens and risks severing local conversational coreference.`
        });
    }

    if (finalTopK < RAG_BASELINE_CONSTRAINTS.minRecommendedTopK) {
        findings.push({
            code: 'TOP_K_TOO_LOW',
            severity: 'error',
            message: `finalTopK=${finalTopK} is < 5 (starves multi-session coverage; k=1 loses -11.73 pp on MemoryAgentBench).`
        });
    } else if (finalTopK > RAG_BASELINE_CONSTRAINTS.maxDistractorSafeTopK) {
        findings.push({
            code: 'TOP_K_DISTRACTOR_OVERFLOW',
            severity: 'error',
            message: `finalTopK=${finalTopK} exceeds 60 (floods reader context with distractors; k=120 loses -14.57 pp on MemoryAgentBench).`
        });
    } else if (
        finalTopK < RAG_BASELINE_CONSTRAINTS.optimalTopKRange[0] ||
        finalTopK > RAG_BASELINE_CONSTRAINTS.optimalTopKRange[1]
    ) {
        findings.push({
            code: 'TOP_K_SUBOPTIMAL_BAND',
            severity: 'warning',
            message: `finalTopK=${finalTopK} is outside the peak [10, 30] operating band (default Top-15).`
        });
    }

    if (!rerankerEnabled) {
        findings.push({
            code: 'MISSING_RERANKER',
            severity: 'error',
            message: 'Cross-encoder reranking is disabled (-3.92 pp degradation, p_Holm=0.0012 on MemoryAgentBench).'
        });
    } else if (denseCandidateK < Math.max(finalTopK * 2, 30)) {
        findings.push({
            code: 'DENSE_POOL_TOO_NARROW',
            severity: 'warning',
            message: `denseCandidateK=${denseCandidateK} narrows pre-rerank recall; Top-128 dense pool is recommended.`
        });
    }

    if (allowDestructiveOverwrite) {
        findings.push({
            code: 'DESTRUCTIVE_MUTATION_ENABLED',
            severity: 'error',
            message: 'In-place UPDATE/DELETE mutations enabled (<2% effective write rate; switching to append-only ADD/NONE gains +2.06 pp).'
        });
    }

    if (llmIngestionTransform) {
        findings.push({
            code: 'LLM_INGESTION_BOTTLENECK',
            severity: 'warning',
            message: 'LLM ingestion extraction enabled on episodic dialogue (risks -5.78 to -19.62 pp accuracy loss and 21M-109M ingestion tokens).'
        });
    }

    const errorCount = findings.filter((f) => f.severity === 'error').length;
    const warningCount = findings.filter((f) => f.severity === 'warning').length;

    return {
        valid: errorCount === 0,
        status: errorCount > 0 ? 'WEAKENED_BASELINE' : (warningCount > 0 ? 'SUBOPTIMAL' : 'STRONG_RAW_RAG'),
        findings,
        recommendedConfig: RAW_RAG_DEFAULTS
    };
}

function normalizeComparableText(text) {
    return String(text || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');
}

/**
 * Enforce the `ADD` / `NONE` append-only memory write contract (Section 1, Figure 2, Table 1).
 * Converts destructive `UPDATE` proposals into non-destructive `ADD` records carrying
 * `supersedesId` provenance, suppresses duplicate/no-op writes, and blocks non-compliance `DELETE`.
 *
 * @param {object} [proposal={}]
 * @param {Array<{ id?: string, text?: string, content?: string, deleted?: boolean }>} [existingRecords=[]]
 * @param {object} [options={}]
 * @param {boolean} [options.explicitComplianceErase=false]
 * @returns {{
 *   action: 'ADD' | 'NONE' | 'COMPLIANCE_TOMBSTONE',
 *   originalAction: string,
 *   effectiveWrite: boolean,
 *   supersedesId: string | null,
 *   targetId: string | null,
 *   text: string,
 *   reason: string
 * }}
 */
export function normalizeAppendOnlyWriteOp(proposal = {}, existingRecords = [], options = {}) {
    const rawAction = String(proposal.action || 'NONE').trim().toUpperCase();
    const text = String(proposal.text ?? proposal.content ?? '').trim();
    const targetId = proposal.targetId !== undefined && proposal.targetId !== null
        ? String(proposal.targetId)
        : (proposal.id !== undefined && proposal.id !== null && rawAction !== 'ADD' ? String(proposal.id) : null);
    const activeRecords = Array.isArray(existingRecords)
        ? existingRecords.filter((rec) => rec && !rec.deleted)
        : [];

    if (rawAction === 'DELETE') {
        const matchedTarget = targetId
            ? activeRecords.find((rec) => String(rec.id) === targetId)
            : null;
        if (!matchedTarget) {
            return {
                action: 'NONE',
                originalAction: 'DELETE',
                effectiveWrite: false,
                supersedesId: null,
                targetId,
                text: '',
                reason: 'MALFORMED_TARGET_ID'
            };
        }
        if (options.explicitComplianceErase === true) {
            return {
                action: 'COMPLIANCE_TOMBSTONE',
                originalAction: 'DELETE',
                effectiveWrite: true,
                supersedesId: null,
                targetId,
                text: '',
                reason: 'EXPLICIT_COMPLIANCE_ERASE'
            };
        }
        return {
            action: 'NONE',
            originalAction: 'DELETE',
            effectiveWrite: false,
            supersedesId: null,
            targetId,
            text: '',
            reason: 'DESTRUCTIVE_DELETE_BLOCKED'
        };
    }

    if (rawAction === 'NONE') {
        return {
            action: 'NONE',
            originalAction: 'NONE',
            effectiveWrite: false,
            supersedesId: null,
            targetId,
            text,
            reason: 'EXPLICIT_NOOP'
        };
    }

    if (text.length === 0) {
        return {
            action: 'NONE',
            originalAction: rawAction,
            effectiveWrite: false,
            supersedesId: null,
            targetId,
            text: '',
            reason: 'EMPTY_CONTENT'
        };
    }

    const normCandidate = normalizeComparableText(text);
    const exactDuplicate = activeRecords.find(
        (rec) => normalizeComparableText(rec.text ?? rec.content) === normCandidate
    );
    if (exactDuplicate) {
        return {
            action: 'NONE',
            originalAction: rawAction,
            effectiveWrite: false,
            supersedesId: null,
            targetId: String(exactDuplicate.id ?? targetId ?? ''),
            text,
            reason: 'NOOP_IDENTICAL_TEXT'
        };
    }

    if (rawAction === 'UPDATE') {
        const matchedTarget = targetId
            ? activeRecords.find((rec) => String(rec.id) === targetId)
            : null;
        if (!matchedTarget) {
            return {
                action: 'ADD',
                originalAction: 'UPDATE',
                effectiveWrite: true,
                supersedesId: null,
                targetId,
                text,
                reason: 'UPDATE_MISSING_TARGET_CONVERTED_TO_ADD'
            };
        }
        return {
            action: 'ADD',
            originalAction: 'UPDATE',
            effectiveWrite: true,
            supersedesId: String(matchedTarget.id),
            targetId: String(matchedTarget.id),
            text,
            reason: 'APPEND_ONLY_SUPERSEDE'
        };
    }

    return {
        action: 'ADD',
        originalAction: rawAction,
        effectiveWrite: true,
        supersedesId: proposal.supersedesId ? String(proposal.supersedesId) : null,
        targetId: null,
        text,
        reason: 'APPEND_ONLY_ADD'
    };
}

/**
 * Audit a stream of raw memory controller write decisions (`ADD`, `UPDATE`, `DELETE`, `NONE`)
 * to quantify effective vs. redundant/malformed mutation rates (Figure 2 diagnostic).
 *
 * @param {Array<object>} [decisions=[]]
 * @param {object} [options={}]
 * @returns {{
 *   totalDecisions: number,
 *   rawCounts: Record<string, number>,
 *   normalizedCounts: Record<string, number>,
 *   effectiveAddCount: number,
 *   effectiveMutationCount: number,
 *   effectiveMutationRate: number,
 *   noopOrMalformedMutationCount: number,
 *   normalizedDecisions: ReturnType<typeof normalizeAppendOnlyWriteOp>[]
 * }}
 */
export function auditMutationStream(decisions = [], options = {}) {
    const store = [];
    const rawCounts = { ADD: 0, UPDATE: 0, DELETE: 0, NONE: 0 };
    const normalizedCounts = { ADD: 0, NONE: 0, COMPLIANCE_TOMBSTONE: 0 };
    const normalizedDecisions = [];

    let effectiveMutationCount = 0;
    let noopOrMalformedMutationCount = 0;
    let nextId = 1;

    for (const item of decisions) {
        const rawAction = String(item?.action || 'NONE').trim().toUpperCase();
        rawCounts[rawAction] = (rawCounts[rawAction] || 0) + 1;

        const normalized = normalizeAppendOnlyWriteOp(item, store, options);
        normalizedDecisions.push(normalized);
        normalizedCounts[normalized.action] = (normalizedCounts[normalized.action] || 0) + 1;

        if (rawAction === 'UPDATE' || rawAction === 'DELETE') {
            const hadValidTarget = normalized.reason === 'APPEND_ONLY_SUPERSEDE' ||
                normalized.reason === 'DESTRUCTIVE_DELETE_BLOCKED' ||
                normalized.reason === 'EXPLICIT_COMPLIANCE_ERASE';
            if (hadValidTarget && (normalized.reason === 'APPEND_ONLY_SUPERSEDE' || rawAction === 'DELETE')) {
                effectiveMutationCount += 1;
            } else {
                noopOrMalformedMutationCount += 1;
            }
        }

        if (normalized.action === 'ADD') {
            store.push({
                id: String(item?.newId ?? (rawAction === 'ADD' && item?.id ? item.id : `mem_${nextId++}`)),
                text: normalized.text,
                supersedesId: normalized.supersedesId
            });
        } else if (normalized.action === 'COMPLIANCE_TOMBSTONE' && normalized.targetId) {
            const target = store.find((rec) => rec.id === normalized.targetId);
            if (target) target.deleted = true;
        }
    }

    const totalDecisions = decisions.length;
    return {
        totalDecisions,
        rawCounts,
        normalizedCounts,
        effectiveAddCount: normalizedCounts.ADD,
        effectiveMutationCount,
        effectiveMutationRate: totalDecisions > 0
            ? Number((effectiveMutationCount / totalDecisions).toFixed(6))
            : 0,
        noopOrMalformedMutationCount,
        normalizedDecisions
    };
}

/**
 * Format the Appendix G.1 Qwen3-Reranker binary relevance prompt (`"yes"` / `"no"`).
 *
 * @param {string} query
 * @param {string} passage
 * @param {object} [options={}]
 * @returns {{ system: string, user: string }}
 */
export function buildQwenRerankerPrompt(query, passage, options = {}) {
    const instruction = options.instruction || QWEN_RERANKER_TEMPLATE.instruction;
    const system = options.system || QWEN_RERANKER_TEMPLATE.system;
    const user = `<Instruct>: ${instruction}\n<Query>: ${String(query || '').trim()}\n<Document>: ${String(passage || '').trim()}`;
    return { system, user };
}

/**
 * Determine whether post-rerank sub-span sentence narrowing is safe for the target domain.
 * Legal and contractual corpora (`domain === 'law'` / `'legal'`) preserve full clause windows
 * by default so exceptions, provisos ("provided, however..."), and definitions are never severed.
 *
 * @param {object} [options={}]
 * @returns {boolean}
 */
export function shouldNarrowCandidateSubSpan(options = {}) {
    if (typeof options?.allowSubSpanNarrowing === 'boolean') {
        return options.allowSubSpanNarrowing;
    }
    const domain = String(options?.domain || '').trim().toLowerCase();
    if (domain === 'law' || domain === 'legal') {
        return false;
    }
    return true;
}

/**
 * Deterministic cross-encoder relevance scorer combining content-word coverage, ordered
 * bigram phrase overlap, exact identifier/numeric grounding, and dense cosine similarity.
 *
 * When `options.domain === 'law'` (or `'legal'`), calibrated dense semantic similarity is
 * weighted as primary (`0.72 * dense + 0.20 * lexical + 0.08 * bigram`) and ubiquitous
 * contract boilerplate words (`agreement`, `party`, `company`, `section`, `hereof`, etc.)
 * are excluded from lexical overlap so generic boilerplate never outranks semantic clause hits.
 *
 * @param {string} query
 * @param {string} passage
 * @param {number} [denseScore=0]
 * @param {object} [options={}]
 * @returns {number}
 */
export function scoreDeterministicCrossEncoder(query, passage, denseScore = 0, options = {}) {
    const domain = String(options?.domain || '').trim().toLowerCase();
    const isLegalDomain = domain === 'law' || domain === 'legal';

    const baseQueryTokens = (String(query || '').toLowerCase().match(/[a-z0-9_]+/g) || [])
        .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
    const qTokens = isLegalDomain
        ? (() => {
            const nonBoilerplate = baseQueryTokens.filter((t) => !LEGAL_BOILERPLATE_STOPWORDS.has(t));
            return nonBoilerplate.length > 0 ? nonBoilerplate : baseQueryTokens;
        })()
        : baseQueryTokens;

    const pLower = String(passage || '').toLowerCase();
    const pTokenList = pLower.match(/[a-z0-9_]+/g) || [];
    const pSet = new Set(pTokenList);

    if (qTokens.length === 0) {
        return Math.max(0, Math.min(1, Number(denseScore) || 0));
    }

    let weightedHits = 0;
    let totalWeight = 0;
    for (const tok of qTokens) {
        const isIdentifierOrNumber = /\d|_/.test(tok) || tok.length >= 7;
        const weight = isIdentifierOrNumber ? 1.8 : 1.0;
        totalWeight += weight;
        if (pSet.has(tok)) {
            weightedHits += weight;
        }
    }
    const lexicalRecall = totalWeight > 0 ? weightedHits / totalWeight : 0;

    let bigramHits = 0;
    const totalBigrams = Math.max(0, qTokens.length - 1);
    if (totalBigrams > 0) {
        const pBigrams = new Set();
        for (let i = 0; i + 1 < pTokenList.length; i++) {
            const a = pTokenList[i];
            const b = pTokenList[i + 1];
            const skipA = STOPWORDS.has(a) || (isLegalDomain && LEGAL_BOILERPLATE_STOPWORDS.has(a));
            const skipB = STOPWORDS.has(b) || (isLegalDomain && LEGAL_BOILERPLATE_STOPWORDS.has(b));
            if (!skipA && !skipB) {
                pBigrams.add(`${a}_${b}`);
            }
        }
        for (let i = 0; i < totalBigrams; i++) {
            if (pBigrams.has(`${qTokens[i]}_${qTokens[i + 1]}`)) {
                bigramHits += 1;
            }
        }
    }
    const bigramScore = totalBigrams > 0 ? bigramHits / totalBigrams : 0;
    const clampedDense = Math.max(0, Math.min(1, Number(denseScore) || 0));

    const combined = isLegalDomain
        ? (0.72 * clampedDense + 0.20 * lexicalRecall + 0.08 * bigramScore)
        : (0.52 * lexicalRecall + 0.23 * bigramScore + 0.25 * clampedDense);
    return Number(Math.max(0, Math.min(1, combined)).toFixed(6));
}

async function scoreViaLogprobEndpoint(query, passage, options = {}) {
    const prompt = buildQwenRerankerPrompt(query, passage, options);
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    const baseUrl = String(options.endpoint || process.env.OLLAMA_URL || 'http://127.0.0.1:11434')
        .split(',')[0]
        .trim()
        .replace(/\/+$/, '');
    const url = baseUrl.endsWith('/v1/chat/completions')
        ? baseUrl
        : `${baseUrl}/v1/chat/completions`;
    const model = options.rerankerModel || process.env.OLLAMA_FAST_MODEL || 'qwen2.5-coder:7b';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(250, Number(options.timeoutMs) || 4000));
    try {
        const res = await fetchImpl(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model,
                messages: [
                    { role: 'system', content: prompt.system },
                    { role: 'user', content: prompt.user }
                ],
                max_tokens: 1,
                temperature: 0,
                logprobs: true,
                top_logprobs: 6,
                keep_alive: -1
            }),
            signal: controller.signal
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const firstChoice = data?.choices?.[0];
        const topLogprobs =
            firstChoice?.logprobs?.content?.[0]?.top_logprobs ||
            firstChoice?.logprobs?.top_logprobs?.[0] ||
            null;
        if (Array.isArray(topLogprobs) && topLogprobs.length > 0) {
            const calibrated = calibrateChoiceLogprobs(topLogprobs, ['YES', 'NO']);
            if (calibrated.matchedLogprobs) {
                return { score: calibrated.probabilities.YES, mode: 'logprobs' };
            }
        }
        const rawToken = String(firstChoice?.message?.content || firstChoice?.text || '').trim().toUpperCase();
        if (rawToken.startsWith('YES')) return { score: 0.9, mode: 'token' };
        if (rawToken.startsWith('NO')) return { score: 0.1, mode: 'token' };
    } finally {
        clearTimeout(timer);
    }
    return null;
}

/**
 * Rerank dense candidate windows (`D_q`, default 128) down to `S_q` (`Top-15`, Eq. 2).
 * Supports custom `rerankerFn` (numeric score or `topLogprobs`), live System-1 `YES`/`NO`
 * logprob scoring, and hermetic deterministic cross-encoder scoring for offline/CI runs.
 *
 * @param {string} query
 * @param {Array<{ windowId: string, text: string, denseScore?: number }>} candidates
 * @param {object} [options={}]
 * @returns {Promise<Array<object>>}
 */
export async function rerankCandidateWindows(query, candidates = [], options = {}) {
    if (!Array.isArray(candidates) || candidates.length === 0) return [];

    const topK = Math.max(
        1,
        Number.isInteger(options.topK) && options.topK > 0
            ? options.topK
            : RAW_RAG_DEFAULTS.finalRerankK
    );
    const hasCustomReranker = typeof options.rerankerFn === 'function';
    const hasCustomFetch = typeof options.fetchImpl === 'function' && options.fetchImpl !== globalThis.fetch;
    const useLiveEndpoint = Boolean(
        !hasCustomReranker &&
        !options.offline &&
        (hasCustomFetch || (options.endpoint && process.env.CI !== 'true' && process.env.MOCK_LLM !== '1'))
    );

    const scored = await Promise.all(
        candidates.map(async (candidate) => {
            const denseScore = Number(candidate.denseScore ?? candidate.score ?? 0);

            if (hasCustomReranker) {
                const rawOut = await options.rerankerFn(query, candidate);
                if (typeof rawOut === 'number' && Number.isFinite(rawOut)) {
                    return {
                        ...candidate,
                        denseScore,
                        rerankScore: Number((rawOut + denseScore * 1e-4).toFixed(6)),
                        rerankMode: 'custom_fn'
                    };
                }
                if (rawOut && Array.isArray(rawOut.topLogprobs)) {
                    const calibrated = calibrateChoiceLogprobs(rawOut.topLogprobs, ['YES', 'NO']);
                    const probYes = calibrated.matchedLogprobs ? calibrated.probabilities.YES : 0.5;
                    return {
                        ...candidate,
                        denseScore,
                        rerankScore: Number((probYes + denseScore * 1e-4).toFixed(6)),
                        rerankMode: 'logprobs'
                    };
                }
                if (rawOut && typeof rawOut.score === 'number') {
                    return {
                        ...candidate,
                        denseScore,
                        rerankScore: Number((rawOut.score + denseScore * 1e-4).toFixed(6)),
                        rerankMode: 'custom_fn'
                    };
                }
            }

            if (useLiveEndpoint) {
                try {
                    const live = await scoreViaLogprobEndpoint(query, candidate.text, options);
                    if (live) {
                        return {
                            ...candidate,
                            denseScore,
                            rerankScore: Number((live.score + denseScore * 1e-4).toFixed(6)),
                            rerankMode: live.mode
                        };
                    }
                } catch {
                    // Graceful fallback to deterministic cross-encoder when endpoint is unreachable
                }
            }

            const detScore = scoreDeterministicCrossEncoder(query, candidate.text, denseScore, {
                domain: options.domain
            });
            return {
                ...candidate,
                denseScore,
                rerankScore: detScore,
                rerankMode: 'deterministic_cross_encoder'
            };
        })
    );

    scored.sort((a, b) => {
        if (b.rerankScore !== a.rerankScore) return b.rerankScore - a.rerankScore;
        if (b.denseScore !== a.denseScore) return b.denseScore - a.denseScore;
        return (a.windowIndex ?? 0) - (b.windowIndex ?? 0);
    });

    return scored.slice(0, topK);
}

function buildExpandedEntries(selectedWindows, serializedTurns, deduplicateTurns, chronologicalOrder) {
    const orderedWindows = chronologicalOrder
        ? [...selectedWindows].sort((a, b) => (a.windowIndex ?? 0) - (b.windowIndex ?? 0))
        : [...selectedWindows];

    if (deduplicateTurns) {
        const seenTurns = new Set();
        const collectedTurnIndices = [];
        for (const win of orderedWindows) {
            for (const tIdx of win.turnIndices || []) {
                if (!seenTurns.has(tIdx) && serializedTurns[tIdx]) {
                    seenTurns.add(tIdx);
                    collectedTurnIndices.push(tIdx);
                }
            }
        }
        if (chronologicalOrder) {
            collectedTurnIndices.sort((a, b) => a - b);
        }
        return collectedTurnIndices.map((tIdx) => {
            const turn = serializedTurns[tIdx];
            const text = turn.serialized ?? serializeConversationTurn(turn, tIdx).serialized;
            return {
                entryId: turn.turnId ?? `turn_${tIdx}`,
                sourceType: 'expanded_turn',
                turnIndices: [tIdx],
                orderKey: tIdx,
                text,
                tokenCount: estimateTokenCount(text)
            };
        });
    }

    return orderedWindows.map((win, idx) => {
        const validTurnIndices = (win.turnIndices || []).filter((tIdx) => Boolean(serializedTurns[tIdx]));
        const text = validTurnIndices.length > 0
            ? validTurnIndices
                .map((tIdx) => serializedTurns[tIdx].serialized ?? serializeConversationTurn(serializedTurns[tIdx], tIdx).serialized)
                .join('\n')
            : win.text;
        return {
            entryId: win.windowId ?? `win_${idx}`,
            sourceType: validTurnIndices.length > 0 ? 'expanded_window_turns' : 'raw_window',
            windowId: win.windowId,
            turnIndices: validTurnIndices,
            orderKey: win.windowIndex ?? idx,
            text,
            tokenCount: estimateTokenCount(text)
        };
    });
}

function buildUnexpandedEntries(selectedWindows, chronologicalOrder) {
    const orderedWindows = chronologicalOrder
        ? [...selectedWindows].sort((a, b) => (a.windowIndex ?? 0) - (b.windowIndex ?? 0))
        : [...selectedWindows];

    return orderedWindows.map((win, idx) => ({
        entryId: win.windowId ?? `win_${idx}`,
        sourceType: 'raw_window',
        windowId: win.windowId,
        turnIndices: Array.isArray(win.turnIndices) ? [...win.turnIndices] : [],
        orderKey: win.windowIndex ?? idx,
        text: win.text,
        tokenCount: Number.isInteger(win.tokenCount) && win.tokenCount > 0
            ? win.tokenCount
            : estimateTokenCount(win.text)
    }));
}

/**
 * Assemble reader context from reranked windows with Appendix A.4.4 graceful budget policy:
 * 1. Expand selected windows to linked source turns when `turnExpansion === true`.
 * 2. If expanded turns exceed `maxEvidenceTokens` (`5,000`), disable turn expansion first so
 *    ALL `k` selected windows remain intact without dropping lower-ranked multi-hop chunks.
 * 3. Only if unexpanded raw windows still exceed `maxEvidenceTokens`, pack the longest prefix
 *    of complete window entries (preserving rank priority when prefix packing is required).
 *
 * @param {Array<object>} selectedWindows
 * @param {Array<object|string>} [turns=[]]
 * @param {object} [options={}]
 * @returns {{
 *   contextText: string,
 *   entries: Array<object>,
 *   tokenCount: number,
 *   selectedWindowCount: number,
 *   retainedEntryCount: number,
 *   turnExpansionApplied: boolean,
 *   budgetPolicyTriggered: 'NONE' | 'DISABLED_TURN_EXPANSION' | 'PREFIX_COMPLETE_WINDOWS'
 * }}
 */
export function assembleReaderEvidence(selectedWindows = [], turns = [], options = {}) {
    if (!Array.isArray(selectedWindows) || selectedWindows.length === 0) {
        return {
            contextText: '',
            entries: [],
            tokenCount: 0,
            selectedWindowCount: 0,
            retainedEntryCount: 0,
            turnExpansionApplied: false,
            budgetPolicyTriggered: 'NONE'
        };
    }

    const maxEvidenceTokens = Math.max(
        32,
        Number.isInteger(options.maxEvidenceTokens) && options.maxEvidenceTokens > 0
            ? options.maxEvidenceTokens
            : RAW_RAG_DEFAULTS.maxEvidenceTokens
    );
    const wantTurnExpansion = options.turnExpansion !== undefined
        ? Boolean(options.turnExpansion)
        : RAW_RAG_DEFAULTS.turnExpansion;
    const deduplicateTurns = options.deduplicateTurns !== undefined
        ? Boolean(options.deduplicateTurns)
        : RAW_RAG_DEFAULTS.deduplicateTurns;
    const chronologicalOrder = options.chronologicalOrder !== undefined
        ? Boolean(options.chronologicalOrder)
        : RAW_RAG_DEFAULTS.chronologicalOrder;

    const normalizedTurns = Array.isArray(turns) && turns.length > 0
        ? turns.map((t, idx) => (t && typeof t === 'object' && typeof t.serialized === 'string'
            ? t
            : serializeConversationTurn(t, idx)))
        : [];

    const sumEntryTokens = (list) => list.reduce((acc, item) => acc + item.tokenCount, 0);

    if (wantTurnExpansion && normalizedTurns.length > 0) {
        const expandedEntries = buildExpandedEntries(
            selectedWindows,
            normalizedTurns,
            deduplicateTurns,
            chronologicalOrder
        );
        const expandedTokens = sumEntryTokens(expandedEntries);
        if (expandedTokens <= maxEvidenceTokens) {
            return {
                contextText: expandedEntries.map((e) => e.text).join('\n\n'),
                entries: expandedEntries,
                tokenCount: expandedTokens,
                selectedWindowCount: selectedWindows.length,
                retainedEntryCount: expandedEntries.length,
                turnExpansionApplied: true,
                budgetPolicyTriggered: 'NONE'
            };
        }
    }

    const unexpandedByRank = buildUnexpandedEntries(selectedWindows, false);
    const unexpandedTotalTokens = sumEntryTokens(unexpandedByRank);
    const disabledExpansion = wantTurnExpansion && normalizedTurns.length > 0;

    if (unexpandedTotalTokens <= maxEvidenceTokens) {
        const ordered = chronologicalOrder
            ? buildUnexpandedEntries(selectedWindows, true)
            : unexpandedByRank;
        return {
            contextText: ordered.map((e) => e.text).join('\n\n'),
            entries: ordered,
            tokenCount: unexpandedTotalTokens,
            selectedWindowCount: selectedWindows.length,
            retainedEntryCount: ordered.length,
            turnExpansionApplied: false,
            budgetPolicyTriggered: disabledExpansion ? 'DISABLED_TURN_EXPANSION' : 'NONE'
        };
    }

    const packedByRank = [];
    let runningTokens = 0;
    for (const entry of unexpandedByRank) {
        if (packedByRank.length > 0 && runningTokens + entry.tokenCount > maxEvidenceTokens) {
            break;
        }
        packedByRank.push(entry);
        runningTokens += entry.tokenCount;
        if (runningTokens >= maxEvidenceTokens) break;
    }

    const finalEntries = chronologicalOrder
        ? [...packedByRank].sort((a, b) => a.orderKey - b.orderKey)
        : packedByRank;

    return {
        contextText: finalEntries.map((e) => e.text).join('\n\n'),
        entries: finalEntries,
        tokenCount: runningTokens,
        selectedWindowCount: selectedWindows.length,
        retainedEntryCount: finalEntries.length,
        turnExpansionApplied: false,
        budgetPolicyTriggered: 'PREFIX_COMPLETE_WINDOWS'
    };
}

/**
 * Compute Evidence Coverage (`C_hat`), Conditional Evidence Utilization (`U_hat`),
 * Covered Contribution (`C_hat * U_hat`), and Uncovered Residual Accuracy (Section 5.1 Eq. 3).
 *
 * @param {Array<{ covered: boolean, accurate: number | boolean }>} [records=[]]
 * @returns {{
 *   totalQuestions: number,
 *   coveredCount: number,
 *   coverage: number,
 *   utilization: number,
 *   coveredContribution: number,
 *   uncoveredResidual: number,
 *   overallAccuracy: number,
 *   decompositionError: number
 * }}
 */
export function evaluateCoverageAndUtilization(records = []) {
    if (!Array.isArray(records) || records.length === 0) {
        return {
            totalQuestions: 0,
            coveredCount: 0,
            coverage: 0,
            utilization: 0,
            coveredContribution: 0,
            uncoveredResidual: 0,
            overallAccuracy: 0,
            decompositionError: 0
        };
    }

    const n = records.length;
    let coveredCount = 0;
    let coveredAccuracySum = 0;
    let uncoveredAccuracySum = 0;
    let totalAccuracySum = 0;

    for (const rec of records) {
        const covered = Boolean(rec?.covered);
        const y = typeof rec?.accurate === 'boolean'
            ? (rec.accurate ? 1 : 0)
            : Math.max(0, Math.min(1, Number(rec?.accurate) || 0));

        totalAccuracySum += y;
        if (covered) {
            coveredCount += 1;
            coveredAccuracySum += y;
        } else {
            uncoveredAccuracySum += y;
        }
    }

    const coverage = coveredCount / n;
    const utilization = coveredCount > 0 ? coveredAccuracySum / coveredCount : 0;
    const coveredContribution = coveredAccuracySum / n;
    const uncoveredResidual = uncoveredAccuracySum / n;
    const overallAccuracy = totalAccuracySum / n;
    const decompositionError = Math.abs(overallAccuracy - (coverage * utilization + uncoveredResidual));

    return {
        totalQuestions: n,
        coveredCount,
        coverage: Number(coverage.toFixed(6)),
        utilization: Number(utilization.toFixed(6)),
        coveredContribution: Number(coveredContribution.toFixed(6)),
        uncoveredResidual: Number(uncoveredResidual.toFixed(6)),
        overallAccuracy: Number(overallAccuracy.toFixed(6)),
        decompositionError: Number(decompositionError.toFixed(12))
    };
}

/**
 * Compute Outcome Result Coverage, Trajectory Path Coverage, and Conditional Path Retention
 * `P(path | result)` for multi-step state-evolution / temporal queries (Section 5.3 Table 9).
 *
 * @param {Array<{ hasResult: boolean, hasPath: boolean }>} [records=[]]
 * @returns {{
 *   totalQuestions: number,
 *   resultCount: number,
 *   jointPathAndResultCount: number,
 *   resultCoverage: number,
 *   pathCoverage: number,
 *   conditionalPathGivenResult: number
 * }}
 */
export function evaluateConditionalPathRetention(records = []) {
    if (!Array.isArray(records) || records.length === 0) {
        return {
            totalQuestions: 0,
            resultCount: 0,
            jointPathAndResultCount: 0,
            resultCoverage: 0,
            pathCoverage: 0,
            conditionalPathGivenResult: 0
        };
    }

    const n = records.length;
    let resultCount = 0;
    let pathCount = 0;
    let jointCount = 0;

    for (const rec of records) {
        const hasResult = Boolean(rec?.hasResult);
        const hasPath = Boolean(rec?.hasPath);
        if (hasResult) resultCount += 1;
        if (hasPath) pathCount += 1;
        if (hasResult && hasPath) jointCount += 1;
    }

    return {
        totalQuestions: n,
        resultCount,
        jointPathAndResultCount: jointCount,
        resultCoverage: Number((resultCount / n).toFixed(6)),
        pathCoverage: Number((pathCount / n).toFixed(6)),
        conditionalPathGivenResult: resultCount > 0
            ? Number((jointCount / resultCount).toFixed(6))
            : 0
    };
}

/**
 * Create a stateful, source-preserving `Raw-RAG` index (`0` LLM ingestion calls) with
 * incremental 256/32-token sliding-window caching, causal phase cutoffs, `Top-128` dense
 * retrieval, `Top-15` cross-encoder reranking, and `5,000`-token reader assembly.
 *
 * @param {object} [options={}]
 */
export function createRawRagIndex(options = {}) {
    const config = {
        windowTokens: options.windowTokens ?? RAW_RAG_DEFAULTS.windowTokens,
        overlapTokens: options.overlapTokens ?? RAW_RAG_DEFAULTS.overlapTokens,
        denseCandidateK: options.denseCandidateK ?? RAW_RAG_DEFAULTS.denseCandidateK,
        finalRerankK: options.finalRerankK ?? RAW_RAG_DEFAULTS.finalRerankK,
        maxEvidenceTokens: options.maxEvidenceTokens ?? RAW_RAG_DEFAULTS.maxEvidenceTokens,
        turnExpansion: options.turnExpansion ?? RAW_RAG_DEFAULTS.turnExpansion,
        deduplicateTurns: options.deduplicateTurns ?? RAW_RAG_DEFAULTS.deduplicateTurns,
        chronologicalOrder: options.chronologicalOrder ?? RAW_RAG_DEFAULTS.chronologicalOrder,
        model: options.model || DEFAULT_EMBED_MODEL,
        dimensions: Number(options.dimensions) > 0 ? Number(options.dimensions) : DEFAULT_EMBED_DIMS,
        host: options.host,
        domain: options.domain || 'memory',
        offline: Boolean(options.offline || options.mock || process.env.MOCK_EMBEDDINGS === '1'),
        isolatePhases: options.isolatePhases ?? true,
        idPrefix: options.idPrefix || 'raw_win'
    };

    const rawTurns = [];
    let serializedTurns = [];
    let windows = [];
    const vectorByHash = new Map();
    const sidecarRecords = [];
    const mutationLog = [];

    async function embedMissingWindows(targetWindows) {
        const missing = targetWindows.filter((win) => !vectorByHash.has(win.contentHash));
        if (missing.length === 0) return;

        if (config.offline) {
            for (const win of missing) {
                vectorByHash.set(
                    win.contentHash,
                    generateDeterministicVector(win.text, config.dimensions)
                );
            }
            return;
        }

        const vectors = await embedBatch(
            missing.map((w) => w.text),
            {
                model: config.model,
                dimensions: config.dimensions,
                host: config.host,
                mode: 'document',
                domain: config.domain,
                fetchImpl: options.fetchImpl
            }
        );
        for (let i = 0; i < missing.length; i++) {
            vectorByHash.set(missing[i].contentHash, vectors[i]);
        }
    }

    async function computeQueryVector(queryText) {
        if (config.offline) {
            return generateDeterministicVector(queryText, config.dimensions);
        }
        return await embed(queryText, {
            model: config.model,
            dimensions: config.dimensions,
            host: config.host,
            mode: 'query',
            domain: config.domain,
            fetchImpl: options.fetchImpl
        });
    }

    return {
        /**
         * Append verbatim conversation turns and incrementally embed only newly formed windows.
         * Performs zero LLM extraction, summarization, or mutation calls.
         *
         * @param {Array<object|string>} newTurns
         */
        async addTurns(newTurns = []) {
            if (!Array.isArray(newTurns) || newTurns.length === 0) {
                return { addedTurns: 0, totalTurns: rawTurns.length, totalWindows: windows.length, llmIngestionCalls: 0 };
            }
            rawTurns.push(...newTurns);
            const chunked = chunkConversationWindows(rawTurns, {
                windowTokens: config.windowTokens,
                overlapTokens: config.overlapTokens,
                isolatePhases: config.isolatePhases,
                idPrefix: config.idPrefix
            });
            serializedTurns = chunked.serializedTurns;
            windows = chunked.windows;
            await embedMissingWindows(windows);

            return {
                addedTurns: newTurns.length,
                totalTurns: rawTurns.length,
                totalWindows: windows.length,
                llmIngestionCalls: 0
            };
        },

        /**
         * Apply a memory write proposal under the `ADD` / `NONE` non-destructive policy.
         * Accepted `ADD` entries are also appended as source turns so they participate in retrieval.
         *
         * @param {object} proposal
         * @param {object} [writeOptions={}]
         */
        async applyWriteProposal(proposal = {}, writeOptions = {}) {
            const normalized = normalizeAppendOnlyWriteOp(proposal, sidecarRecords, writeOptions);
            mutationLog.push(normalized);

            if (normalized.action === 'ADD') {
                const recordId = String(proposal.newId ?? (proposal.action === 'ADD' && proposal.id ? proposal.id : `rec_${sidecarRecords.length + 1}`));
                const entry = {
                    id: recordId,
                    text: normalized.text,
                    supersedesId: normalized.supersedesId,
                    date: proposal.date ?? 'unknown',
                    speaker: proposal.speaker ?? 'MemoryNote',
                    phase: proposal.phase ?? null
                };
                sidecarRecords.push(entry);
                await this.addTurns([{
                    turnId: recordId,
                    date: entry.date,
                    speaker: entry.speaker,
                    content: normalized.supersedesId
                        ? `[Supersedes ${normalized.supersedesId}] ${entry.text}`
                        : entry.text,
                    phase: entry.phase
                }]);
            } else if (normalized.action === 'COMPLIANCE_TOMBSTONE' && normalized.targetId) {
                const target = sidecarRecords.find((r) => r.id === normalized.targetId);
                if (target) target.deleted = true;
            }

            return normalized;
        },

        /**
         * Execute `Top-128` dense retrieval + `Top-15` cross-encoder reranking + `5,000`-token
         * budget-safe turn assembly with optional `maxPhase` / `maxTimestamp` causal filtering.
         *
         * @param {string} query
         * @param {object} [retrieveOptions={}]
         */
        async retrieve(query, retrieveOptions = {}) {
            const cleanQuery = String(query || '').trim();
            if (!cleanQuery || windows.length === 0) {
                return {
                    query: cleanQuery,
                    contextText: '',
                    entries: [],
                    selectedWindows: [],
                    denseCandidateCount: 0,
                    tokenCount: 0,
                    turnExpansionApplied: false,
                    budgetPolicyTriggered: 'NONE',
                    llmIngestionCalls: 0
                };
            }

            const maxPhase = Number.isFinite(Number(retrieveOptions.maxPhase))
                ? Number(retrieveOptions.maxPhase)
                : null;
            const maxTimestamp = Number.isFinite(Number(retrieveOptions.maxTimestamp))
                ? Number(retrieveOptions.maxTimestamp)
                : null;

            const visibleWindows = windows.filter((win) => {
                if (maxPhase !== null && win.maxPhase !== null && win.maxPhase > maxPhase) {
                    return false;
                }
                if (maxTimestamp !== null && win.maxTimestamp !== null && win.maxTimestamp > maxTimestamp) {
                    return false;
                }
                return true;
            });

            if (visibleWindows.length === 0) {
                return {
                    query: cleanQuery,
                    contextText: '',
                    entries: [],
                    selectedWindows: [],
                    denseCandidateCount: 0,
                    tokenCount: 0,
                    turnExpansionApplied: false,
                    budgetPolicyTriggered: 'NONE',
                    llmIngestionCalls: 0
                };
            }

            const queryVector = await computeQueryVector(cleanQuery);
            const denseCandidateK = Math.max(
                1,
                Number(retrieveOptions.denseCandidateK ?? config.denseCandidateK)
            );
            const finalRerankK = Math.max(
                1,
                Number(retrieveOptions.finalRerankK ?? retrieveOptions.topK ?? config.finalRerankK)
            );

            const denseScored = visibleWindows.map((win) => {
                const docVec = vectorByHash.get(win.contentHash);
                const rawCos = cosineSimilarity(queryVector, docVec);
                const calibrated = config.offline
                    ? Math.max(0, rawCos)
                    : calibrateQuerySimilarity(rawCos, { model: config.model, queryVec: queryVector });
                return {
                    ...win,
                    rawCosine: Number(rawCos.toFixed(6)),
                    denseScore: Number(calibrated.toFixed(6))
                };
            });

            denseScored.sort((a, b) => {
                if (b.denseScore !== a.denseScore) return b.denseScore - a.denseScore;
                return a.windowIndex - b.windowIndex;
            });

            const densePool = denseScored.slice(0, denseCandidateK);
            const selectedWindows = await rerankCandidateWindows(cleanQuery, densePool, {
                topK: finalRerankK,
                domain: retrieveOptions.domain ?? config.domain,
                offline: retrieveOptions.offline ?? config.offline,
                rerankerFn: retrieveOptions.rerankerFn ?? options.rerankerFn,
                endpoint: retrieveOptions.endpoint ?? options.endpoint,
                rerankerModel: retrieveOptions.rerankerModel ?? options.rerankerModel,
                fetchImpl: retrieveOptions.fetchImpl ?? options.fetchImpl
            });

            const assembled = assembleReaderEvidence(selectedWindows, serializedTurns, {
                maxEvidenceTokens: retrieveOptions.maxEvidenceTokens ?? config.maxEvidenceTokens,
                turnExpansion: retrieveOptions.turnExpansion ?? config.turnExpansion,
                deduplicateTurns: retrieveOptions.deduplicateTurns ?? config.deduplicateTurns,
                chronologicalOrder: retrieveOptions.chronologicalOrder ?? config.chronologicalOrder
            });

            return {
                query: cleanQuery,
                ...assembled,
                selectedWindows,
                denseCandidateCount: densePool.length,
                llmIngestionCalls: 0
            };
        },

        getStats() {
            return {
                turnCount: rawTurns.length,
                windowCount: windows.length,
                cachedVectors: vectorByHash.size,
                sidecarRecordCount: sidecarRecords.filter((r) => !r.deleted).length,
                mutationProposalCount: mutationLog.length,
                llmIngestionCalls: 0,
                config: { ...config }
            };
        },

        exportSnapshot() {
            return {
                serializedTurns: serializedTurns.map((t) => ({ ...t })),
                windows: windows.map((w) => ({ ...w, turnIndices: [...w.turnIndices], turnIds: [...w.turnIds] })),
                sidecarRecords: sidecarRecords.map((r) => ({ ...r })),
                mutationLog: mutationLog.map((m) => ({ ...m }))
            };
        }
    };
}
