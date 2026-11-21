/**
 * @module @krusch/toolkit/grounded-harness
 * @description Turn-0 Grounded, Scale-Aware, Low-Tool-Call Agent Harness Primitives (`INV-GH-01` .. `INV-GH-10`).
 *
 * Replaces unconditional outer-loop 2PC stop-nagging with:
 * - Scale-aware model profiling (`SMALL_MODEL`, `MID_MODEL`, `FRONTIER_REASONING`)
 * - Compact `[PLAN -> BIND -> ACT]` variable binding strictly for `< 15B` non-thinking models
 * - Deferred Okapi BM25 tool-schema compression & Gemini tool-less `mode: "NONE"` guard
 * - Comment/whitespace-normalized call hashing (`BLOCK_SPIN_LOOP`), Turn-0 delta dedup & read memoization (`maxReadStreak === 0`)
 * - Zero-turn-when-healthy objective output defect gate, dataset NA/wildcard hazard detection, and partial-stdout timeout preservation
 *
 * Pure Node 22 ESM (`node:crypto` + local toolkit bricks only; zero `node:fs` / `node:sqlite` / `node:child_process` / npm deps).
 */

import crypto from 'node:crypto';
import {
    createDeferredToolBridge,
    createFrozenPolicyFloor,
    evaluateTruncationPoisoningGuard,
    evaluateVerifyOnStopGuard,
    normalizePromptCachePrefix
} from './harness-engineering.js';
import { createRawRagIndex, estimateTokenCount } from './raw-rag.js';
import { okEnvelope } from './http.js';

/**
 * Canonical monotonic model scale tiers (`INV-GH-03`).
 */
export const SCALE_TIERS = Object.freeze({
    SMALL_MODEL: 'SMALL_MODEL',
    MID_MODEL: 'MID_MODEL',
    FRONTIER_REASONING: 'FRONTIER_REASONING'
});

const MOE_EXPERT_PRODUCT_RE = /(?:^|[:_/\s-])(\d+)x(\d+(?:\.\d+)?)b(?:$|[:_/\s.-])/i;
const MOE_TOTAL_ACTIVE_RE = /(?:^|[:_/\s-])(\d+(?:\.\d+)?)b[-_:]a(\d+(?:\.\d+)?)b(?:$|[:_/\s.-])/i;
const MOE_TAGGED_TOTAL_RE = /(?:^|[:_/\s-])(\d+(?:\.\d+)?)b[-_:]moe(?:$|[:_/\s.-])/i;
const EDGE_EFFECTIVE_B_RE = /(?:^|[:_/\s-])e(\d+(?:\.\d+)?)b(?:$|[:_/\s.-])/i;
const DENSE_BILLIONS_RE = /(?:^|[:_/\s-])(\d+(?:\.\d+)?)b(?:$|[:_/\s.-])/i;
const DENSE_MILLIONS_RE = /(?:^|[:_/\s-])(\d+(?:\.\d+)?)m(?:$|[:_/\s.-])/i;

const FRONTIER_FAMILY_PATTERNS = Object.freeze([
    /(?:^|[/:-])gemini-4(?:$|[-:_.\d])/i,
    /(?:^|[/:-])gemini-3\.8(?:$|[-:_.\d])/i,
    /(?:^|[/:-])gemini-\d+(?:\.\d+)?-pro(?:$|[-:_.\d])/i,
    /(?:^|[/:-])gpt-5(?:$|[-:_.\d])/i,
    /(?:^|[/:-])o[134](?:$|[-:_.\d])/i,
    /(?:^|[/:-])claude-3[-.]7(?:$|[-:_.\d])/i,
    /(?:^|[/:-])claude-(?:opus-|sonnet-)?4(?:$|[-:_.\d])/i,
    /(?:^|[/:-])deepseek-r1(?:$|[-:_.\d])/i,
    /(?:^|[/:-])deepseek-v3(?:$|[-:_.\d])/i,
    /(?:^|[/:-])qwq(?:$|[-:_.\d])/i,
    /(?:^|[/:-])grok-[34](?:$|[-:_.\d])/i
]);

const NATIVE_REASONING_PATTERNS = Object.freeze([
    /(?:^|[/:-])gemini-4(?:$|[-:_.\d])/i,
    /(?:^|[/:-])gemini-3\.8(?:$|[-:_.\d])/i,
    /(?:^|[/:-])gemini-\d+(?:\.\d+)?-pro(?:$|[-:_.\d])/i,
    /(?:^|[/:-])gpt-5(?:$|[-:_.\d])/i,
    /(?:^|[/:-])o[134](?:$|[-:_.\d])/i,
    /(?:^|[/:-])claude-3[-.]7(?:$|[-:_.\d])/i,
    /(?:^|[/:-])claude-(?:opus-|sonnet-)?4(?:$|[-:_.\d])/i,
    /(?:^|[/:-])deepseek-r1(?:$|[-:_.\d])/i,
    /(?:^|[/:-])qwq(?:$|[-:_.\d])/i,
    /(?:^|[/:-])grok-[34](?:$|[-:_.\d])/i,
    /(?:[:_-])thinking(?:$|[:_.-])/i
]);

const SECRET_ARGUMENT_PATTERNS = Object.freeze([
    /\bAIzaSy[A-Za-z0-9_-]{33}\b/,
    /\bsk-(?:proj-|ant-|live-|test-)?[A-Za-z0-9_-]{16,}\b/,
    /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/,
    /\bxox[baprs]-[A-Za-z0-9-]{12,}\b/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /-----BEGIN\s+(?:[A-Z0-9]+\s+)?PRIVATE\s+KEY-----/
]);

const PLACEHOLDER_VALUE_PATTERNS = Object.freeze([
    /^<(?:insert|your|placeholder|id|email|date|time|name|url|token|path)[^>]*>$/i,
    /<(?:INSERT_[A-Z0-9_]+|YOUR_[A-Z0-9_]+|PLACEHOLDER[^>]*|TODO[^>]*)>/i,
    /\{\{\s*[a-zA-Z0-9_.-]+\s*\}\}/,
    /^(?:TBD|TODO|FIXME|PLACEHOLDER|INSERT_HERE|YOUR_EMAIL_HERE|UNKNOWN_ID)$/i,
    /\[(?:TBD|TODO|INSERT\s+[^\]]+|YOUR\s+[^\]]+|PLACEHOLDER[^\]]*)\]/i,
    /\b[a-z0-9._%+-]+@(?:example\.(?:com|org|net)|domain\.com|placeholder\.com|yourcompany\.com)\b/i,
    /^(?:YYYY-MM-DD|MM\/DD\/YYYY|DD\/MM\/YYYY|YYYY-MM-DDTHH:mm:ssZ?)$/i
]);

const POLICY_ABSTENTION_RE = /\b(?:cannot|can't|unable to|will not|won't|refuse to|must decline|not authorized|prohibited by policy|violates?\s+(?:safety|security|policy)|blocked by policy|permission denied|against\s+(?:policy|safety|guidelines))\b/i;

function parsePositiveFinite(value) {
    const num = Number(value);
    return Number.isFinite(num) && num > 0 ? num : null;
}

function parseExplicitThinkingToggle(hints = {}, normalizedModel = '') {
    if (typeof hints?.thinkingEnabled === 'boolean') {
        return hints.thinkingEnabled;
    }
    const effortRaw = hints?.thinkingLevel ?? hints?.reasoningEffort;
    if (typeof effortRaw === 'string' && effortRaw.trim().length > 0) {
        const cleaned = effortRaw.trim().toLowerCase();
        if (cleaned === 'none' || cleaned === 'off' || cleaned === 'disabled' || cleaned === 'false' || cleaned === '0') {
            return false;
        }
        return true;
    }
    if (/(?:[:_-])no-?think(?:ing)?(?:$|[:_.-])/i.test(normalizedModel)) {
        return false;
    }
    return null;
}

function isFrontierFamilyModel(normalizedModel) {
    if (!normalizedModel) return false;
    return FRONTIER_FAMILY_PATTERNS.some((re) => re.test(normalizedModel));
}

/**
 * Deterministically infer parameter scale, MoE topology, and native-reasoning capability from a model ID.
 *
 * @param {string} [modelId=''] - Provider or local model identifier.
 * @param {object} [hints={}] - Optional caller overrides (`activeParamsB`, `totalParamsB`, `isMoe`, `thinkingEnabled`, `thinkingLevel`, `reasoningEffort`).
 * @returns {{
 *   normalizedModel: string,
 *   activeParamsB: number | null,
 *   totalParamsB: number | null,
 *   isMoe: boolean,
 *   isNativeReasoningModel: boolean,
 *   thinkingEnabled: boolean
 * }}
 */
export function inferModelScaleMetadata(modelId = '', hints = {}) {
    const normalizedModel = String(modelId ?? '').trim().toLowerCase();
    const safeHints = hints && typeof hints === 'object' ? hints : {};

    let activeParamsB = null;
    let totalParamsB = null;
    let isMoe = /\bmoe\b/i.test(normalizedModel);
    let isNativeReasoningModel = NATIVE_REASONING_PATTERNS.some((re) => re.test(normalizedModel));

    const moeTotalActive = normalizedModel.match(MOE_TOTAL_ACTIVE_RE);
    const moeProduct = !moeTotalActive ? normalizedModel.match(MOE_EXPERT_PRODUCT_RE) : null;
    const moeTagged = !moeTotalActive && !moeProduct ? normalizedModel.match(MOE_TAGGED_TOTAL_RE) : null;
    const edgeMatch = !moeTotalActive && !moeProduct && !moeTagged ? normalizedModel.match(EDGE_EFFECTIVE_B_RE) : null;
    const denseBMatch = !moeTotalActive && !moeProduct && !moeTagged && !edgeMatch ? normalizedModel.match(DENSE_BILLIONS_RE) : null;
    const denseMMatch = !moeTotalActive && !moeProduct && !moeTagged && !edgeMatch && !denseBMatch ? normalizedModel.match(DENSE_MILLIONS_RE) : null;

    if (moeTotalActive) {
        totalParamsB = Number(moeTotalActive[1]);
        activeParamsB = Number(moeTotalActive[2]);
        isMoe = true;
    } else if (moeProduct) {
        const experts = Number(moeProduct[1]);
        const expertSizeB = Number(moeProduct[2]);
        isMoe = true;
        activeParamsB = Number((Math.min(2, experts) * expertSizeB).toFixed(2));
        totalParamsB = Number((experts * expertSizeB).toFixed(2));
    } else if (moeTagged) {
        totalParamsB = Number(moeTagged[1]);
        activeParamsB = Number(Math.max(1, totalParamsB * 0.11).toFixed(1));
        isMoe = true;
    } else if (edgeMatch) {
        activeParamsB = Number(edgeMatch[1]);
        totalParamsB = activeParamsB;
    } else if (denseBMatch) {
        activeParamsB = Number(denseBMatch[1]);
        totalParamsB = activeParamsB;
    } else if (denseMMatch) {
        activeParamsB = Number((Number(denseMMatch[1]) / 1000).toFixed(3));
        totalParamsB = activeParamsB;
    }

    // Family-level structural metadata when explicit numeric parameter suffixes are absent
    if (activeParamsB === null && totalParamsB === null && normalizedModel) {
        if (/(?:^|[/:-])deepseek-(?:r1|v3)(?:$|[-:_.\d])/i.test(normalizedModel)) {
            isMoe = true;
            activeParamsB = 37;
            totalParamsB = 671;
        } else if (/(?:^|[/:-])qwq(?:$|[-:_.\d])/i.test(normalizedModel)) {
            activeParamsB = 32;
            totalParamsB = 32;
        } else if (/(?:^|[/:-])smollm\d*(?:$|[-:_.\d])/i.test(normalizedModel)) {
            activeParamsB = 1.7;
            totalParamsB = 1.7;
        } else if (/(?:^|[/:-])phi-[34](?:\.\d+)?-mini(?:$|[-:_.\d])/i.test(normalizedModel)) {
            activeParamsB = 3.8;
            totalParamsB = 3.8;
        } else if (/(?:^|[/:-])(?:nous-)?hermes-?3(?:$|[-:_.\d])/i.test(normalizedModel)) {
            activeParamsB = 8;
            totalParamsB = 8;
        } else if (
            /(?:^|[/:-])gemini-\d+(?:\.\d+)?-flash-lite(?:$|[-:_.\d])/i.test(normalizedModel) ||
            /(?:^|[/:-])gpt-4(?:o|\.\d+)?-(?:mini|nano)(?:$|[-:_.\d])/i.test(normalizedModel)
        ) {
            activeParamsB = 8;
            totalParamsB = 8;
            isNativeReasoningModel = false;
        } else if (/(?:^|[/:-])claude-(?:3[-.]5-)?haiku(?:$|[-:_.\d])/i.test(normalizedModel)) {
            activeParamsB = 10;
            totalParamsB = 10;
            isNativeReasoningModel = false;
        } else if (
            /(?:^|[/:-])(?:gpt-4o|gpt-4-turbo|gpt-4\.1|claude-3[-.]5-sonnet|gemini-2(?:\.\d+)?-flash)(?:$|[-:_.\d])/i.test(normalizedModel)
        ) {
            activeParamsB = 32;
            totalParamsB = 32;
        } else if (isFrontierFamilyModel(normalizedModel)) {
            totalParamsB = 120;
            activeParamsB = 120;
        }
    }

    const hintActive = parsePositiveFinite(safeHints.activeParamsB);
    const hintTotal = parsePositiveFinite(safeHints.totalParamsB);
    if (hintActive !== null) activeParamsB = hintActive;
    if (hintTotal !== null) totalParamsB = hintTotal;
    if (activeParamsB !== null && totalParamsB === null) totalParamsB = activeParamsB;
    if (totalParamsB !== null && activeParamsB === null) activeParamsB = totalParamsB;

    if (typeof safeHints.isMoe === 'boolean') {
        isMoe = safeHints.isMoe;
    } else if (activeParamsB !== null && totalParamsB !== null && totalParamsB > activeParamsB * 1.5) {
        isMoe = true;
    }

    if (typeof safeHints.isNativeReasoningModel === 'boolean') {
        isNativeReasoningModel = safeHints.isNativeReasoningModel;
    }

    const explicitThinking = parseExplicitThinkingToggle(safeHints, normalizedModel);
    const thinkingEnabled = explicitThinking !== null ? explicitThinking : isNativeReasoningModel;

    return {
        normalizedModel,
        activeParamsB,
        totalParamsB,
        isMoe,
        isNativeReasoningModel,
        thinkingEnabled
    };
}

function buildTierProfileObject(tier, model, meta, rationale) {
    if (tier === SCALE_TIERS.SMALL_MODEL) {
        return Object.freeze({
            tier: SCALE_TIERS.SMALL_MODEL,
            model,
            inferredActiveParamsB: meta.activeParamsB,
            inferredTotalParamsB: meta.totalParamsB,
            isMoe: meta.isMoe,
            thinkingEnabled: meta.thinkingEnabled,
            injectPlanBindStep: true,
            rescueSerializedToolCalls: true,
            softHoldPlaceholdersAndDates: true,
            maxMechanicalVerifyNudges: 1,
            enforceZeroMutationImperativeNudge: false,
            enforceTwoPhaseAnalyticalNudge: false,
            maxReadStreak: 0,
            rationale
        });
    }

    if (tier === SCALE_TIERS.FRONTIER_REASONING) {
        return Object.freeze({
            tier: SCALE_TIERS.FRONTIER_REASONING,
            model,
            inferredActiveParamsB: meta.activeParamsB,
            inferredTotalParamsB: meta.totalParamsB,
            isMoe: meta.isMoe,
            thinkingEnabled: meta.thinkingEnabled,
            injectPlanBindStep: false,
            rescueSerializedToolCalls: false,
            softHoldPlaceholdersAndDates: false,
            maxMechanicalVerifyNudges: 0,
            enforceZeroMutationImperativeNudge: false,
            enforceTwoPhaseAnalyticalNudge: false,
            maxReadStreak: 0,
            rationale
        });
    }

    return Object.freeze({
        tier: SCALE_TIERS.MID_MODEL,
        model,
        inferredActiveParamsB: meta.activeParamsB,
        inferredTotalParamsB: meta.totalParamsB,
        isMoe: meta.isMoe,
        thinkingEnabled: meta.thinkingEnabled,
        injectPlanBindStep: false,
        rescueSerializedToolCalls: true,
        softHoldPlaceholdersAndDates: false,
        maxMechanicalVerifyNudges: 0,
        enforceZeroMutationImperativeNudge: false,
        enforceTwoPhaseAnalyticalNudge: false,
        maxReadStreak: 0,
        rationale
    });
}

/**
 * Deterministically resolve a frozen `ScaleProfile` (`SMALL_MODEL`, `MID_MODEL`, `FRONTIER_REASONING`)
 * enforcing `INV-GH-03` and `INV-GH-08`.
 *
 * @param {object} [options={}] - Profile resolution options.
 * @returns {Readonly<{
 *   tier: 'SMALL_MODEL' | 'MID_MODEL' | 'FRONTIER_REASONING',
 *   model: string,
 *   inferredActiveParamsB: number | null,
 *   inferredTotalParamsB: number | null,
 *   isMoe: boolean,
 *   thinkingEnabled: boolean,
 *   injectPlanBindStep: boolean,
 *   rescueSerializedToolCalls: boolean,
 *   softHoldPlaceholdersAndDates: boolean,
 *   maxMechanicalVerifyNudges: number,
 *   enforceZeroMutationImperativeNudge: false,
 *   enforceTwoPhaseAnalyticalNudge: false,
 *   maxReadStreak: 0,
 *   rationale: string
 * }>}
 */
export function resolveScaleProfile(options = {}) {
    const safeOpts = options && typeof options === 'object' ? options : {};
    const rawModel = String(safeOpts.model ?? '').trim();
    const meta = inferModelScaleMetadata(rawModel, {
        activeParamsB: safeOpts.activeParamsB,
        totalParamsB: safeOpts.totalParamsB,
        isMoe: safeOpts.isMoe,
        isNativeReasoningModel: safeOpts.isNativeReasoningModel,
        thinkingEnabled: safeOpts.thinkingEnabled,
        thinkingLevel: safeOpts.thinkingLevel,
        reasoningEffort: safeOpts.reasoningEffort
    });

    if (typeof safeOpts.explicitTier === 'string') {
        const candidateTier = safeOpts.explicitTier.trim().toUpperCase();
        if (Object.hasOwn(SCALE_TIERS, candidateTier)) {
            return buildTierProfileObject(
                SCALE_TIERS[candidateTier],
                rawModel,
                meta,
                `Explicit tier override (${SCALE_TIERS[candidateTier]}).`
            );
        }
    }

    const totalB = meta.totalParamsB;
    const activeB = meta.activeParamsB;
    const frontierByFamily = isFrontierFamilyModel(meta.normalizedModel) && safeOpts.thinkingEnabled !== false;

    if (meta.thinkingEnabled || frontierByFamily || (totalB !== null && totalB >= 70)) {
        const reasons = [];
        if (meta.thinkingEnabled) reasons.push('native thinking enabled');
        if (totalB !== null && totalB >= 70) reasons.push(`totalParamsB=${totalB}>=70`);
        if (frontierByFamily && reasons.length === 0) reasons.push('frontier reasoning model family');
        return buildTierProfileObject(
            SCALE_TIERS.FRONTIER_REASONING,
            rawModel,
            meta,
            `Frontier/reasoning profile (${reasons.join(', ') || 'high-scale'}); outer thinking/2PC nudges disabled.`
        );
    }

    if (meta.isMoe && totalB !== null && totalB >= 15) {
        if (safeOpts.preferThinkingStepForSmallActive === true && activeB !== null && activeB < 15) {
            return buildTierProfileObject(
                SCALE_TIERS.SMALL_MODEL,
                rawModel,
                meta,
                `Small-active MoE (${activeB}B active / ${totalB}B total) with preferThinkingStepForSmallActive=true.`
            );
        }
        return buildTierProfileObject(
            SCALE_TIERS.MID_MODEL,
            rawModel,
            meta,
            `MoE mid-scale default (${activeB ?? '?'}B active / ${totalB}B total >= 15B); 1-shot grounded execution with serialized tool rescue.`
        );
    }

    if ((activeB !== null && activeB < 15) || (activeB === null && totalB !== null && totalB < 15)) {
        return buildTierProfileObject(
            SCALE_TIERS.SMALL_MODEL,
            rawModel,
            meta,
            `Small non-thinking model (${activeB ?? totalB}B < 15B); enables [PLAN -> BIND -> ACT], soft-holds, and single mechanical rescue.`
        );
    }

    return buildTierProfileObject(
        SCALE_TIERS.MID_MODEL,
        rawModel,
        meta,
        `Mid-scale non-thinking model (${activeB ?? totalB ?? 'unannotated'}B); disables pre-action thinking injection while retaining serialized tool rescue.`
    );
}

/**
 * Build the compact `[SCALE-AWARE PRE-ACTION STEP — SMALL MODEL]` `PLAN -> BIND -> ACT` directive
 * strictly when `profile?.injectPlanBindStep === true`; returns `''` otherwise.
 *
 * @param {object|null|undefined} profile - Resolved `ScaleProfile`.
 * @returns {string}
 */
export function buildScaleAwareDirective(profile) {
    if (profile?.injectPlanBindStep !== true) {
        return '';
    }
    return [
        '[SCALE-AWARE PRE-ACTION STEP — SMALL MODEL]',
        'Execute [PLAN -> BIND -> ACT] before calling tools:',
        '1. PLAN: Select the direct action from Turn-0 grounded schemas and evidence without exploratory re-reads.',
        '2. BIND: Bind exact literal IDs, schema columns, and valid calendar dates (YYYY-MM-DD); never pass placeholders (TBD, TODO, <id>).',
        '3. ACT: Invoke structured JSON tool calls directly (never plain-text <tool_call> tags) and stop immediately once complete.'
    ].join('\n');
}

/**
 * Quantify tool-schema prompt token savings using `estimateTokenCount` (`@krusch/toolkit/raw-rag`).
 *
 * @param {Array<object>} [allTools=[]] - Complete raw tool registry.
 * @param {Array<object>} [exposedTools=[]] - Tools actually exposed in the prompt prefix.
 * @returns {{
 *   rawToolCount: number,
 *   exposedToolCount: number,
 *   rawSchemaTokens: number,
 *   exposedSchemaTokens: number,
 *   savedSchemaTokens: number,
 *   reductionPct: number
 * }}
 */
export function measureToolSchemaSavings(allTools = [], exposedTools = []) {
    const safeAll = Array.isArray(allTools) ? allTools : [];
    const safeExposed = Array.isArray(exposedTools) ? exposedTools : [];
    const rawSchemaTokens = safeAll.length > 0 ? estimateTokenCount(JSON.stringify(safeAll)) : 0;
    const exposedSchemaTokens = safeExposed.length > 0 ? estimateTokenCount(JSON.stringify(safeExposed)) : 0;
    const savedSchemaTokens = Math.max(0, rawSchemaTokens - exposedSchemaTokens);
    const reductionPct = rawSchemaTokens > 0
        ? Number(((savedSchemaTokens / rawSchemaTokens) * 100).toFixed(2))
        : 0;

    return {
        rawToolCount: safeAll.length,
        exposedToolCount: safeExposed.length,
        rawSchemaTokens,
        exposedSchemaTokens,
        savedSchemaTokens,
        reductionPct
    };
}

/**
 * Canonical model prefixes supporting Gemini Interactions API (`v1beta/interactions`) Tool Retrieval.
 */
export const GEMINI_TOOL_RETRIEVAL_MODELS = Object.freeze([
    'gemini-4-hydrogen',
    'gemini-4-argon',
    'gemini-3.8-flash',
    'gemini-3.6-flash'
]);

/**
 * Determine whether a target model identifier supports Gemini `v1beta/interactions` Tool Retrieval
 * (`tool_search` and `defer_loading`).
 *
 * @param {string} [modelId=''] - Model identifier.
 * @returns {boolean}
 */
export function isGeminiToolRetrievalSupported(modelId = '') {
    const clean = String(modelId ?? '')
        .trim()
        .toLowerCase()
        .replace(/^(?:models|google|gemini)\//, '');
    if (!clean) return false;
    return /^gemini-4(?:-|$)/.test(clean) || /^gemini-3\.(?:6|8)-flash(?:-|$)/.test(clean);
}

function escapeRegExpLiteral(value) {
    return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractToolIdentifier(tool) {
    const raw = tool?.name ?? tool?.function?.name ?? '';
    return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * Scan system instructions and reference texts to automatically pin any explicitly named tools
 * alongside `pinnedToolNames`, preventing unsearched direct calls on deferred functions
 * (`HTTP 400 Missing circulated context for functions`).
 *
 * @param {Array<object>} [tools=[]] - Full tool registry.
 * @param {object} [options={}] - Pinning options (`pinnedToolNames`, `referenceTexts`, `systemPrompt`).
 * @returns {{ pinnedToolNames: string[], autoPinnedToolNames: string[] }}
 */
export function resolveAutoPinnedToolNames(tools = [], options = {}) {
    const safeTools = Array.isArray(tools) ? tools : [];
    const safeOpts = options && typeof options === 'object' ? options : {};
    const explicitList = Array.isArray(safeOpts.pinnedToolNames) ? safeOpts.pinnedToolNames : [];
    const referenceList = Array.isArray(safeOpts.referenceTexts) ? safeOpts.referenceTexts : [];
    const systemPrompt = typeof safeOpts.systemPrompt === 'string' ? safeOpts.systemPrompt : '';

    const pinnedSet = new Set();
    const orderedPinned = [];
    for (const item of explicitList) {
        const clean = typeof item === 'string' ? item.trim() : '';
        if (clean && !pinnedSet.has(clean)) {
            pinnedSet.add(clean);
            orderedPinned.push(clean);
        }
    }

    const corpusParts = [];
    if (systemPrompt.trim().length > 0) corpusParts.push(systemPrompt);
    for (const entry of referenceList) {
        if (typeof entry === 'string' && entry.trim().length > 0) {
            corpusParts.push(entry);
        }
    }

    const autoPinnedToolNames = [];
    if (corpusParts.length > 0 && safeTools.length > 0) {
        const combinedCorpus = corpusParts.join('\n');
        for (const tool of safeTools) {
            const name = extractToolIdentifier(tool);
            if (!name || pinnedSet.has(name)) continue;
            const boundaryRe = new RegExp(`(?<![A-Za-z0-9_:-])${escapeRegExpLiteral(name)}(?![A-Za-z0-9_:-])`);
            if (boundaryRe.test(combinedCorpus)) {
                pinnedSet.add(name);
                orderedPinned.push(name);
                autoPinnedToolNames.push(name);
            }
        }
    }

    return {
        pinnedToolNames: orderedPinned,
        autoPinnedToolNames
    };
}

/**
 * Derive a compact (~20-26 token) single-sentence `short_description` for deferred tool retrieval,
 * optionally prefixing `[component]` to disambiguate similar operations across services.
 *
 * @param {object} [tool={}] - Tool definition.
 * @param {object} [options={}] - Formatting options (`maxChars`, `prefixComponent`).
 * @returns {string}
 */
export function deriveToolShortDescription(tool = {}, options = {}) {
    const safeTool = tool && typeof tool === 'object' ? tool : {};
    const safeOpts = options && typeof options === 'object' ? options : {};
    const maxChars = Number.isFinite(safeOpts.maxChars) && safeOpts.maxChars >= 24
        ? Math.floor(safeOpts.maxChars)
        : 110;
    const prefixComponent = safeOpts.prefixComponent !== false;

    const explicitShort = safeTool.short_description ?? safeTool.shortDescription;
    let baseText = typeof explicitShort === 'string' && explicitShort.trim().length > 0
        ? explicitShort.trim()
        : String(
            safeTool.description ??
            safeTool.function?.description ??
            safeTool.title ??
            safeTool.annotations?.title ??
            extractToolIdentifier(safeTool)
        ).trim();

    baseText = baseText.replace(/\s+/g, ' ');
    if (!explicitShort) {
        const sentenceMatch = baseText.match(/^(.+?[.!?])(?:\s|$)/);
        if (sentenceMatch && sentenceMatch[1].length >= 12) {
            baseText = sentenceMatch[1].trim();
        }
    }

    const componentTag = String(
        safeTool.component ?? safeTool.namespace ?? safeTool.service ?? safeTool.category ?? ''
    ).trim();
    if (
        prefixComponent &&
        componentTag.length > 0 &&
        !baseText.toLowerCase().startsWith(`[${componentTag.toLowerCase()}]`) &&
        !baseText.toLowerCase().startsWith(`${componentTag.toLowerCase()}:`)
    ) {
        baseText = `[${componentTag}] ${baseText}`;
    }

    if (baseText.length <= maxChars) {
        return baseText;
    }

    const budget = Math.max(16, maxChars - 3);
    const sliced = baseText.slice(0, budget);
    const lastSpace = sliced.lastIndexOf(' ');
    const cleanSlice = lastSpace >= Math.floor(budget * 0.6) ? sliced.slice(0, lastSpace) : sliced;
    return `${cleanSlice.replace(/[,:;.\s]+$/, '')}...`;
}

function deduplicateToolsByName(tools = []) {
    if (!Array.isArray(tools) || tools.length === 0) return [];
    const seen = new Set();
    const deduped = [];
    for (const tool of tools) {
        const name = extractToolIdentifier(tool);
        if (!name) continue;
        if (seen.has(name)) continue;
        seen.add(name);
        deduped.push(tool);
    }
    return deduped;
}

function toGeminiFunctionObject(tool, {
    deferLoading = false,
    includeShortDescription = false,
    maxShortDescriptionChars = 110,
    prefixComponent = true
} = {}) {
    const name = extractToolIdentifier(tool);
    const description = String(
        tool?.description ?? tool?.function?.description ?? tool?.title ?? tool?.annotations?.title ?? ''
    ).trim();
    const rawParams = tool?.parameters ?? tool?.inputSchema ?? tool?.function?.parameters;
    const parameters = rawParams && typeof rawParams === 'object' && !Array.isArray(rawParams)
        ? {
            ...rawParams,
            ...(rawParams.properties && typeof rawParams.properties === 'object' && !Array.isArray(rawParams.properties)
                ? { properties: { ...rawParams.properties } }
                : {}),
            ...(Array.isArray(rawParams.required) ? { required: [...rawParams.required] } : {})
        }
        : { type: 'object', properties: {} };

    const decl = {
        type: 'function',
        name,
        description,
        parameters
    };

    if (deferLoading === true) {
        decl.defer_loading = true;
        if (includeShortDescription !== false) {
            const shortDesc = deriveToolShortDescription(tool, {
                maxChars: maxShortDescriptionChars,
                prefixComponent
            });
            if (shortDesc && shortDesc !== description) {
                decl.short_description = shortDesc;
            }
        }
    }

    return decl;
}

/**
 * Compile a tool registry into a Gemini `v1beta/interactions` Tool Retrieval configuration
 * supporting both server-side (`defer_loading: true` + `short_description`) and client-side
 * (`execution: "client"` backed by weighted Okapi BM25) modes while guarding against HTTP 400 traps.
 *
 * @param {Array<object>} [tools=[]] - Full underlying tool definitions.
 * @param {object} [options={}] - Retrieval compilation options.
 * @returns {object}
 */
export function buildGeminiInteractionsTools(tools = [], options = {}) {
    const safeTools = deduplicateToolsByName(tools);
    const safeOpts = options && typeof options === 'object' ? options : {};
    const mode = safeOpts.mode === 'client' ? 'client' : 'server';
    const deferThreshold = Number.isFinite(safeOpts.deferThreshold) ? safeOpts.deferThreshold : 12;
    const searchTopK = Number.isFinite(safeOpts.searchTopK) && safeOpts.searchTopK > 0
        ? Math.floor(safeOpts.searchTopK)
        : 5;
    const maxShortDescriptionChars = Number.isFinite(safeOpts.maxShortDescriptionChars)
        ? safeOpts.maxShortDescriptionChars
        : 110;
    const prefixComponent = safeOpts.prefixComponent !== false;
    const strictModelCheck = safeOpts.strictModelCheck !== false;
    const modelSupported = safeOpts.model
        ? isGeminiToolRetrievalSupported(safeOpts.model)
        : true;

    const { pinnedToolNames: resolvedPinnedNames, autoPinnedToolNames } = resolveAutoPinnedToolNames(safeTools, {
        pinnedToolNames: safeOpts.pinnedToolNames,
        referenceTexts: safeOpts.referenceTexts,
        systemPrompt: safeOpts.systemPrompt
    });
    const pinnedSet = new Set(resolvedPinnedNames);

    const rawMcpServers = Array.isArray(safeOpts.mcpServers) ? safeOpts.mcpServers : [];
    const seenMcpNames = new Set();
    const validMcpServers = [];
    for (const srv of rawMcpServers) {
        if (!srv || typeof srv.name !== 'string' || typeof srv.url !== 'string') continue;
        const cleanName = srv.name.trim();
        const cleanUrl = srv.url.trim();
        if (!cleanName || !cleanUrl || seenMcpNames.has(cleanName)) continue;
        seenMcpNames.add(cleanName);
        validMcpServers.push(srv);
    }

    const unpinnedTools = safeTools.filter((t) => !pinnedSet.has(extractToolIdentifier(t)));
    const deferrableMcpCount = mode === 'server'
        ? validMcpServers.filter((srv) => srv.deferLoading !== false && srv.defer_loading !== false).length
        : 0;
    const totalRegistrations = safeTools.length + validMcpServers.length;
    const canUseRetrieval = !strictModelCheck || modelSupported;
    const shouldDefer = Boolean(
        canUseRetrieval &&
        (unpinnedTools.length + deferrableMcpCount) > 0 &&
        (safeOpts.forceDefer === true || totalRegistrations > deferThreshold)
    );

    const toolByName = new Map();
    const namespaces = new Set();
    for (const tool of safeTools) {
        const name = extractToolIdentifier(tool);
        toolByName.set(name, tool);
        const ns = String(tool?.component ?? tool?.namespace ?? tool?.service ?? tool?.category ?? '').trim();
        if (ns) namespaces.add(ns);
    }

    const bm25Bridge = createDeferredToolBridge(safeTools, {
        pinnedToolNames: resolvedPinnedNames,
        deferThreshold,
        forceDefer: true,
        defaultLimit: searchTopK
    });

    const clientSearchName = typeof safeOpts.clientSearchName === 'string' && safeOpts.clientSearchName.trim()
        ? safeOpts.clientSearchName.trim()
        : 'search_tool_registry';

    function resolveClientSearchResult(callStepOrArgs = {}) {
        const isStepEnvelope = Boolean(
            callStepOrArgs &&
            typeof callStepOrArgs === 'object' &&
            ('arguments' in callStepOrArgs || 'call_id' in callStepOrArgs || callStepOrArgs.type === 'function_call')
        );
        const callId = String(callStepOrArgs?.id ?? callStepOrArgs?.call_id ?? callStepOrArgs?.callId ?? 'tsc_client_1');
        const callName = String(callStepOrArgs?.name ?? clientSearchName).trim() || clientSearchName;
        const rawArgs = isStepEnvelope
            ? (callStepOrArgs.arguments ?? callStepOrArgs.args ?? {})
            : callStepOrArgs;
        const safeArgs = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {};

        const query = String(safeArgs.query ?? '').trim() || '*';
        const requestedNamespace = String(safeArgs.namespace ?? safeArgs.component ?? '').trim().toLowerCase();
        const limit = Number.isFinite(safeArgs.limit) && safeArgs.limit > 0
            ? Math.floor(safeArgs.limit)
            : searchTopK;

        const searchPoolLimit = requestedNamespace ? Math.max(limit * 4, safeTools.length) : limit * 2;
        const searchOut = bm25Bridge.search(query, searchPoolLimit);
        const candidates = Array.isArray(searchOut?.data?.matches) ? searchOut.data.matches : [];

        const matchedDeclarations = [];
        for (const hit of candidates) {
            if (matchedDeclarations.length >= limit) break;
            const fullTool = toolByName.get(hit.name);
            if (!fullTool) continue;
            if (pinnedSet.has(hit.name) && safeArgs.includePinned !== true) continue;
            if (requestedNamespace) {
                const toolNs = String(
                    fullTool.component ?? fullTool.namespace ?? fullTool.service ?? fullTool.category ?? ''
                ).trim().toLowerCase();
                const prefixHit = hit.name.toLowerCase().startsWith(`${requestedNamespace}_`) ||
                    hit.name.toLowerCase().startsWith(`${requestedNamespace}:`);
                if (toolNs !== requestedNamespace && !prefixHit) continue;
            }
            matchedDeclarations.push(toGeminiFunctionObject(fullTool, { deferLoading: false }));
        }

        if (matchedDeclarations.length === 0) {
            const nsList = namespaces.size > 0
                ? ` Available namespaces: ${Array.from(namespaces).sort().join(', ')}.`
                : '';
            return {
                type: 'function_result',
                name: callName,
                call_id: callId,
                result: [
                    {
                        type: 'text',
                        text: `No deferred tools matched "${query}"${requestedNamespace ? ` in namespace "${requestedNamespace}"` : ''} across ${unpinnedTools.length} searchable tools.${nsList} Try broader capability keywords.`
                    }
                ]
            };
        }

        return {
            type: 'function_result',
            name: callName,
            call_id: callId,
            result: matchedDeclarations
        };
    }

    if (!shouldDefer) {
        const staticTools = [
            ...safeTools.map((t) => toGeminiFunctionObject(t, { deferLoading: false })),
            ...validMcpServers.map((srv) => ({
                type: 'mcp_server',
                name: srv.name.trim(),
                url: srv.url.trim()
            }))
        ];
        return {
            mode: 'static',
            deferred: false,
            modelSupported,
            tools: staticTools,
            pinnedToolNames: resolvedPinnedNames,
            autoPinnedToolNames,
            eagerToolNames: safeTools.map((t) => extractToolIdentifier(t)),
            deferredToolNames: [],
            deferredMcpServerNames: [],
            systemInstructionHint: '',
            resolveClientSearchResult
        };
    }

    if (mode === 'client') {
        const nsSummary = namespaces.size > 0
            ? ` Available namespaces: ${Array.from(namespaces).sort().join(', ')}.`
            : '';
        const clientDescription = typeof safeOpts.clientSearchDescription === 'string' && safeOpts.clientSearchDescription.trim()
            ? safeOpts.clientSearchDescription.trim()
            : `Search ${unpinnedTools.length} specialized tools in the internal registry when loaded tools cannot complete the task.${nsSummary}`;

        const eagerTools = safeTools
            .filter((t) => pinnedSet.has(extractToolIdentifier(t)))
            .map((t) => toGeminiFunctionObject(t, { deferLoading: false }));

        const staticClientMcpEntries = validMcpServers.map((srv) => ({
            type: 'mcp_server',
            name: srv.name.trim(),
            url: srv.url.trim()
        }));

        const clientTools = [
            {
                type: 'tool_search',
                execution: 'client',
                name: clientSearchName,
                description: clientDescription,
                parameters: {
                    type: 'object',
                    properties: {
                        query: {
                            type: 'string',
                            description: 'Tool name or capability keywords to search for.'
                        },
                        ...(namespaces.size > 0
                            ? {
                                namespace: {
                                    type: 'string',
                                    description: `Optional service/pillar filter (${Array.from(namespaces).sort().join(', ')}).`
                                }
                            }
                            : {}),
                        limit: {
                            type: 'integer',
                            description: 'Maximum number of matching tool schemas to return.'
                        }
                    },
                    required: ['query']
                }
            },
            ...eagerTools,
            ...staticClientMcpEntries
        ];

        return {
            mode: 'client',
            deferred: true,
            modelSupported,
            tools: clientTools,
            pinnedToolNames: resolvedPinnedNames,
            autoPinnedToolNames,
            eagerToolNames: eagerTools.map((t) => t.name),
            deferredToolNames: unpinnedTools.map((t) => extractToolIdentifier(t)),
            deferredMcpServerNames: [],
            systemInstructionHint: `If none of your loaded tools can complete the task, call ${clientSearchName} to discover and load matching tool schemas.`,
            resolveClientSearchResult
        };
    }

    // Default: mode === 'server'
    const eagerServerTools = safeTools
        .filter((t) => pinnedSet.has(extractToolIdentifier(t)))
        .map((t) => toGeminiFunctionObject(t, { deferLoading: false }));
    const deferredServerTools = unpinnedTools.map((t) => toGeminiFunctionObject(t, {
        deferLoading: true,
        includeShortDescription: safeOpts.includeShortDescription !== false,
        maxShortDescriptionChars,
        prefixComponent
    }));
    const deferredMcpServerNames = [];
    const mcpEntries = validMcpServers.map((srv) => {
        const cleanSrvName = srv.name.trim();
        const deferSrv = srv.deferLoading !== false && srv.defer_loading !== false;
        if (deferSrv) {
            deferredMcpServerNames.push(cleanSrvName);
        }
        return {
            type: 'mcp_server',
            name: cleanSrvName,
            url: srv.url.trim(),
            ...(deferSrv ? { defer_loading: true } : {})
        };
    });

    return {
        mode: 'server',
        deferred: true,
        modelSupported,
        tools: [
            { type: 'tool_search' },
            ...eagerServerTools,
            ...deferredServerTools,
            ...mcpEntries
        ],
        pinnedToolNames: resolvedPinnedNames,
        autoPinnedToolNames,
        eagerToolNames: eagerServerTools.map((t) => t.name),
        deferredToolNames: deferredServerTools.map((t) => t.name),
        deferredMcpServerNames,
        systemInstructionHint: 'If none of your loaded tools can complete the task, use tool search to find one.',
        resolveClientSearchResult
    };
}

/**
 * Audit stateless (`store: false`) Gemini Interactions API `input` history steps prior to replay,
 * detecting stripped `signature` (`thought_signature`) fields, orphaned `tool_search_call` or
 * `tool_search_result` steps, and unsearched calls to deferred functions or remote MCP servers
 * before they trigger HTTP 400 errors.
 *
 * @param {Array<object>} [steps=[]] - Stateless `input` step history array.
 * @param {object} [options={}] - Validation options (`deferredToolNames`, `deferredMcpServerNames`, `requireFunctionCallSignature`).
 * @returns {{
 *   valid: boolean,
 *   loadedToolNames: string[],
 *   defects: Array<{ code: string, stepIndex: number, stepType: string, toolName: string | null, detail: string }>
 * }}
 */
export function validateGeminiStatelessToolHistory(steps = [], options = {}) {
    const safeSteps = Array.isArray(steps) ? steps : [];
    const safeOpts = options && typeof options === 'object' ? options : {};
    const deferredSet = new Set(
        (Array.isArray(safeOpts.deferredToolNames) ? safeOpts.deferredToolNames : [])
            .map((name) => String(name ?? '').trim())
            .filter(Boolean)
    );
    const deferredMcpSet = new Set(
        (Array.isArray(safeOpts.deferredMcpServerNames) ? safeOpts.deferredMcpServerNames : [])
            .map((name) => String(name ?? '').trim())
            .filter(Boolean)
    );
    const forceFnCallSignature = safeOpts.requireFunctionCallSignature === true;

    const defects = [];
    const loadedSet = new Set();
    const seenSearchCallIds = new Set();
    const pendingSearchCalls = new Map();
    let seenThoughtInTurn = false;

    for (let idx = 0; idx < safeSteps.length; idx += 1) {
        const step = safeSteps[idx];
        if (!step || typeof step !== 'object') continue;
        const stepType = String(step.type ?? '').trim();

        if (stepType === 'user_input' || stepType === 'function_result' || stepType === 'mcp_server_tool_result') {
            seenThoughtInTurn = false;
        }

        if (stepType === 'thought') {
            seenThoughtInTurn = true;
        }

        if (
            stepType === 'tool_search_call' ||
            stepType === 'tool_search_result' ||
            stepType === 'thought' ||
            (stepType === 'function_call' && (seenThoughtInTurn || forceFnCallSignature))
        ) {
            const sig = typeof step.signature === 'string' ? step.signature.trim() : '';
            if (!sig) {
                defects.push({
                    code: 'MISSING_THOUGHT_SIGNATURE',
                    stepIndex: idx,
                    stepType,
                    toolName: stepType === 'function_call' ? (String(step.name ?? '').trim() || null) : null,
                    detail: `Step "${stepType}" at index ${idx} is missing its opaque "signature" field required for stateless replay.`
                });
            }
        }

        if (stepType === 'tool_search_call') {
            const callId = String(step.id ?? '').trim();
            if (callId) {
                seenSearchCallIds.add(callId);
                pendingSearchCalls.set(callId, idx);
            }
        } else if (stepType === 'tool_search_result') {
            const callId = String(step.call_id ?? '').trim();
            if (!callId || !seenSearchCallIds.has(callId)) {
                defects.push({
                    code: 'ORPHANED_TOOL_SEARCH_RESULT',
                    stepIndex: idx,
                    stepType,
                    toolName: null,
                    detail: `tool_search_result "${callId || '<missing>'}" at index ${idx} has no preceding matching tool_search_call step.`
                });
            } else {
                pendingSearchCalls.delete(callId);
            }
            const loadedEntries = Array.isArray(step.result) ? step.result : [];
            for (const entry of loadedEntries) {
                const loadedName = extractToolIdentifier(entry);
                if (loadedName) loadedSet.add(loadedName);
            }
        } else if (stepType === 'function_call' || stepType === 'function_result') {
            const fnName = String(step.name ?? '').trim();
            if (fnName && deferredSet.has(fnName) && !loadedSet.has(fnName)) {
                defects.push({
                    code: 'MISSING_CIRCULATED_TOOL_CONTEXT',
                    stepIndex: idx,
                    stepType,
                    toolName: fnName,
                    detail: `Deferred function "${fnName}" at step ${idx} (${stepType}) has no preceding tool_search_result loading its schema.`
                });
            }
        } else if (stepType === 'mcp_server_tool_call' || stepType === 'mcp_server_tool_result') {
            const serverName = String(step.server_name ?? '').trim();
            const fnName = String(step.name ?? '').trim();
            const qualifiedName = serverName && fnName ? `${serverName}:${fnName}` : fnName;
            const requiresSearch = Boolean(
                (serverName && deferredMcpSet.has(serverName)) ||
                (qualifiedName && deferredSet.has(qualifiedName)) ||
                (fnName && deferredSet.has(fnName))
            );
            if (requiresSearch && !loadedSet.has(qualifiedName) && !loadedSet.has(fnName)) {
                defects.push({
                    code: 'MISSING_CIRCULATED_TOOL_CONTEXT',
                    stepIndex: idx,
                    stepType,
                    toolName: qualifiedName || null,
                    detail: `Deferred MCP tool "${qualifiedName}" at step ${idx} (${stepType}) has no preceding tool_search_result loading its schema.`
                });
            }
        }
    }

    for (const [callId, callIdx] of pendingSearchCalls.entries()) {
        defects.push({
            code: 'MISSING_TOOL_SEARCH_RESULT',
            stepIndex: callIdx,
            stepType: 'tool_search_call',
            toolName: null,
            detail: `tool_search_call "${callId}" at index ${callIdx} has no matching tool_search_result step; loaded schemas would be lost on replay.`
        });
    }

    return {
        valid: defects.length === 0,
        loadedToolNames: Array.from(loadedSet),
        defects
    };
}

/**
 * Wrap `createDeferredToolBridge` (`@krusch/toolkit/harness-engineering`) with token-budget
 * accounting, reference-aware auto-pinning, Gemini `v1beta/interactions` Tool Retrieval compilation,
 * and per-call dispatcher override support (`INV-GH-04`).
 *
 * @param {object} [options={}] - Gate configuration.
 * @returns {{
 *   deferred: boolean,
 *   exposedTools: Array<object>,
 *   pinnedToolNames: string[],
 *   autoPinnedToolNames: string[],
 *   savings: ReturnType<typeof measureToolSchemaSavings>,
 *   bridge: object | null,
 *   invokeMetaTool: (name: string, args?: object, overrideDispatcher?: Function) => Promise<object>,
 *   toGeminiInteractionsTools: (geminiOptions?: object) => ReturnType<typeof buildGeminiInteractionsTools>
 * }}
 */
export function createToolBudgetGate({
    tools = [],
    pinnedToolNames = [],
    referenceTexts = [],
    systemPrompt = '',
    deferThreshold = 12,
    forceDefer = false,
    searchTopK = 5,
    dispatcher
} = {}) {
    const safeTools = deduplicateToolsByName(tools);
    const {
        pinnedToolNames: resolvedPinnedToolNames,
        autoPinnedToolNames
    } = resolveAutoPinnedToolNames(safeTools, {
        pinnedToolNames,
        referenceTexts,
        systemPrompt
    });

    const rawBridge = createDeferredToolBridge(safeTools, {
        pinnedToolNames: resolvedPinnedToolNames,
        deferThreshold,
        forceDefer,
        defaultLimit: searchTopK,
        dispatcher
    });

    const deferred = Boolean(rawBridge.shouldDefer);
    const exposedTools = rawBridge.getExposedTools();
    const savings = measureToolSchemaSavings(safeTools, exposedTools);

    const toolByName = new Map();
    for (const tool of safeTools) {
        const name = tool?.name ?? tool?.function?.name;
        if (name) toolByName.set(String(name), tool);
    }

    async function invokeMetaTool(name, args = {}, overrideDispatcher = undefined) {
        const metaName = String(name ?? '').trim();
        const safeArgs = args && typeof args === 'object' && !Array.isArray(args) ? args : {};

        if (metaName === 'tool_search') {
            return rawBridge.search(safeArgs.query ?? '', safeArgs.limit ?? searchTopK);
        }
        if (metaName === 'tool_describe') {
            return rawBridge.describe(safeArgs.toolName ?? safeArgs.name ?? '');
        }
        if (metaName === 'tool_call') {
            const targetName = String(safeArgs.toolName ?? safeArgs.name ?? '').trim();
            const targetArgs = safeArgs.args ?? safeArgs.arguments ?? {};
            if (typeof overrideDispatcher === 'function') {
                if (!toolByName.has(targetName)) {
                    return {
                        ok: false,
                        tool: 'tool_call',
                        summary: `Unknown or unexposed tool "${targetName}".`,
                        data: { toolName: targetName || null, error: 'TOOL_NOT_FOUND' }
                    };
                }
                if (targetArgs !== null && (typeof targetArgs !== 'object' || Array.isArray(targetArgs))) {
                    return {
                        ok: false,
                        tool: 'tool_call',
                        summary: `Arguments for "${targetName}" must be a plain JSON object.`,
                        data: { toolName: targetName, error: 'INVALID_ARGUMENTS' }
                    };
                }
                try {
                    const result = await overrideDispatcher(targetName, targetArgs || {});
                    const underlyingFailed = Boolean(result && typeof result === 'object' && result.ok === false);
                    return {
                        ok: !underlyingFailed,
                        tool: 'tool_call',
                        summary: underlyingFailed
                            ? `Tool "${targetName}" reported failure: ${result.summary || result.error || 'execution failed'}.`
                            : `Executed "${targetName}" successfully.`,
                        data: { toolName: targetName, result }
                    };
                } catch (err) {
                    return {
                        ok: false,
                        tool: 'tool_call',
                        summary: `Execution of "${targetName}" threw an error: ${err.message}`,
                        data: { toolName: targetName, error: err.message }
                    };
                }
            }
            return rawBridge.call(targetName, targetArgs);
        }

        return {
            ok: false,
            tool: metaName || 'tool_meta',
            summary: `Unsupported meta-tool "${metaName}".`,
            data: { toolName: metaName || null, error: 'UNKNOWN_META_TOOL' }
        };
    }

    function toGeminiInteractionsTools(geminiOptions = {}) {
        const safeGeminiOpts = geminiOptions && typeof geminiOptions === 'object' ? geminiOptions : {};
        return buildGeminiInteractionsTools(safeTools, {
            pinnedToolNames: resolvedPinnedToolNames,
            deferThreshold,
            forceDefer,
            searchTopK,
            ...safeGeminiOpts
        });
    }

    return {
        deferred,
        exposedTools,
        pinnedToolNames: resolvedPinnedToolNames,
        autoPinnedToolNames,
        savings,
        bridge: deferred ? rawBridge : null,
        invokeMetaTool,
        toGeminiInteractionsTools
    };
}

function normalizeTrackablePath(relPath) {
    return String(relPath ?? '')
        .replace(/\\/g, '/')
        .replace(/^\.\//, '')
        .trim();
}

function deriveChunkKeys(chunk) {
    if (typeof chunk === 'string') {
        const digest = crypto.createHash('sha256').update(chunk).digest('hex');
        return [`sha256:${digest}`];
    }
    if (!chunk || typeof chunk !== 'object') {
        return [];
    }
    const keys = [];
    const primaryId = chunk.chunkId ?? chunk.windowId ?? chunk.entryId ?? chunk.id;
    if (primaryId !== undefined && primaryId !== null && String(primaryId).trim().length > 0) {
        keys.push(String(primaryId).trim());
    }
    if (typeof chunk.contentHash === 'string' && chunk.contentHash.trim().length > 0) {
        keys.push(`hash:${chunk.contentHash.trim()}`);
    }
    if (keys.length === 0) {
        const text = String(chunk.text ?? chunk.content ?? JSON.stringify(chunk));
        const digest = crypto.createHash('sha256').update(text).digest('hex');
        keys.push(`sha256:${digest}`);
    }
    return keys;
}

/**
 * Create a stateful session delta tracker suppressing duplicate Turn-0 chunks, unchanged
 * Turn-0 file digests, and repeat identical read tool calls (`INV-GH-04`).
 *
 * @param {object} [options={}] - Initial Turn-0 chunk IDs and file SHA-256 digests.
 * @returns {object}
 */
export function createDeltaContextTracker({
    initialChunkIds = [],
    initialFileDigests = {}
} = {}) {
    const seenChunkIds = new Set();
    const seenFileDigests = new Map();
    const readMemo = new Map();

    let turn0SeededChunks = 0;
    let turn0DuplicatesSuppressed = 0;
    let deltaChunksAccepted = 0;
    let digestShortCircuits = 0;
    let memoizedReadHits = 0;

    function seedTurnZero({ chunkIds = [], fileDigests = {} } = {}) {
        if (Array.isArray(chunkIds)) {
            for (const rawId of chunkIds) {
                const clean = String(rawId ?? '').trim();
                if (clean) seenChunkIds.add(clean);
            }
        }
        if (fileDigests && typeof fileDigests === 'object') {
            for (const [relPath, digest] of Object.entries(fileDigests)) {
                const normPath = normalizeTrackablePath(relPath);
                const cleanDigest = String(digest ?? '').trim();
                if (normPath && cleanDigest) {
                    seenFileDigests.set(normPath, cleanDigest);
                }
            }
        }
        turn0SeededChunks = seenChunkIds.size;
        return {
            seededChunkCount: seenChunkIds.size,
            seededFileCount: seenFileDigests.size
        };
    }

    seedTurnZero({ chunkIds: initialChunkIds, fileDigests: initialFileDigests });

    function filterDeltaChunks(chunks = [], options = {}) {
        const candidates = Array.isArray(chunks) ? chunks : [];
        const recordSeen = options?.recordSeen !== false;
        const deltaChunks = [];
        let suppressedCount = 0;

        for (const chunk of candidates) {
            const keys = deriveChunkKeys(chunk);
            if (keys.length === 0) continue;
            const alreadySeen = keys.some((k) => seenChunkIds.has(k));
            if (alreadySeen) {
                suppressedCount += 1;
                turn0DuplicatesSuppressed += 1;
                continue;
            }
            if (recordSeen) {
                for (const k of keys) seenChunkIds.add(k);
            }
            deltaChunks.push(chunk);
            deltaChunksAccepted += 1;
        }

        return {
            deltaChunks,
            suppressedCount,
            acceptedCount: deltaChunks.length,
            totalCandidates: candidates.length,
            turn0DuplicatesSuppressed
        };
    }

    function recordFileDigest(relPath, digest) {
        const normPath = normalizeTrackablePath(relPath);
        if (!normPath) return false;
        if (digest === null || digest === '') {
            seenFileDigests.delete(normPath);
            return false;
        }
        const cleanDigest = String(digest ?? '').trim();
        if (!cleanDigest) return false;
        seenFileDigests.set(normPath, cleanDigest);
        return true;
    }

    function hasSeenFileDigest(relPath, digest) {
        const normPath = normalizeTrackablePath(relPath);
        if (!normPath) return false;
        const existing = seenFileDigests.get(normPath);
        if (!existing) return false;
        if (digest === undefined) {
            digestShortCircuits += 1;
            return true;
        }
        if (digest === null || String(digest).trim().length === 0) {
            return false;
        }
        const matched = existing === String(digest).trim();
        if (matched) digestShortCircuits += 1;
        return matched;
    }

    function checkReadMemo(callSignature) {
        const key = String(callSignature ?? '').trim();
        const entry = key ? readMemo.get(key) : undefined;
        if (!entry) {
            return {
                hit: false,
                callSignature: key,
                preview: null,
                result: null,
                hits: 0,
                recordedAtMs: null
            };
        }
        entry.hits += 1;
        memoizedReadHits += 1;
        return {
            hit: true,
            callSignature: key,
            preview: entry.preview,
            result: entry.result,
            hits: entry.hits,
            recordedAtMs: entry.recordedAtMs
        };
    }

    function recordReadMemo(callSignature, entry = {}) {
        const key = String(callSignature ?? '').trim();
        if (!key) return null;
        const normalizedEntry = typeof entry === 'string'
            ? { preview: entry, result: null }
            : {
                preview: String(entry?.preview ?? ''),
                result: entry?.result ?? null
            };
        const stored = {
            callSignature: key,
            preview: normalizedEntry.preview,
            result: normalizedEntry.result,
            hits: 0,
            recordedAtMs: Date.now()
        };
        readMemo.set(key, stored);
        return { ...stored };
    }

    function getMetrics() {
        return {
            seenChunkCount: seenChunkIds.size,
            seenFileDigestCount: seenFileDigests.size,
            memoizedSignatureCount: readMemo.size,
            turn0SeededChunks,
            turn0DuplicatesSuppressed,
            deltaChunksAccepted,
            digestShortCircuits,
            memoizedReadHits
        };
    }

    return {
        seedTurnZero,
        filterDeltaChunks,
        hasSeenFileDigest,
        recordFileDigest,
        checkReadMemo,
        recordReadMemo,
        getMetrics
    };
}

const CODE_HASH_NORMALIZED_KEYS = new Set([
    'code',
    'script',
    'python',
    'py',
    'sql',
    'query_sql',
    'command',
    'cmd',
    'commandline',
    'command_line'
]);

function resolveSnippetLanguageMode(keyHint = '') {
    const hint = String(keyHint ?? '').trim().toLowerCase();
    if (!hint) return 'python';
    if (hint === 'sql' || hint === 'query_sql' || /(?:^|[_.-])sql(?:$|[_.-])/.test(hint)) {
        return 'sql';
    }
    if (
        hint === 'js' ||
        hint === 'ts' ||
        hint === 'javascript' ||
        hint === 'typescript' ||
        hint === 'jsx' ||
        hint === 'tsx' ||
        /(?:^|[_.-])(?:js|ts|javascript|typescript)(?:$|[_.-])/.test(hint)
    ) {
        return 'js';
    }
    if (
        hint === 'command' ||
        hint === 'cmd' ||
        hint === 'commandline' ||
        hint === 'command_line' ||
        hint === 'shell' ||
        hint === 'bash' ||
        hint === 'sh' ||
        /(?:^|[_.-])(?:command|cmd|commandline|shell|bash)(?:$|[_.-])/.test(hint)
    ) {
        return 'shell';
    }
    return 'python';
}

/**
 * Quote-aware comment and trailing-whitespace normalizer for spin-loop call hashing (`INV-GH-04`).
 * Preserves Python `//` floor division, string literals (`'''`, `"""`, `'`, `"`, `` ` ``), and leading indentation.
 *
 * @param {string} [source=''] - Raw code, SQL, or shell snippet.
 * @param {string} [keyHint=''] - Argument key or language hint (`sql`, `js`, `command`, `python`, etc.).
 * @returns {string}
 */
export function normalizeCodeSnippetForHash(source = '', keyHint = '') {
    const text = String(source ?? '').replace(/\r\n?/g, '\n');
    if (!text) return '';

    const mode = resolveSnippetLanguageMode(keyHint);
    const len = text.length;
    let out = '';
    let state = 'NORMAL';
    let i = 0;

    while (i < len) {
        const ch = text[i];

        if (state === 'BLOCK_COMMENT') {
            if (ch === '*' && text[i + 1] === '/') {
                state = 'NORMAL';
                i += 2;
                continue;
            }
            if (ch === '\n') {
                out += '\n';
            }
            i += 1;
            continue;
        }

        if (state === 'TRIPLE_SINGLE') {
            if (ch === '\\' && i + 1 < len) {
                out += ch + text[i + 1];
                i += 2;
                continue;
            }
            if (text.startsWith("'''", i)) {
                out += "'''";
                state = 'NORMAL';
                i += 3;
                continue;
            }
            out += ch;
            i += 1;
            continue;
        }

        if (state === 'TRIPLE_DOUBLE') {
            if (ch === '\\' && i + 1 < len) {
                out += ch + text[i + 1];
                i += 2;
                continue;
            }
            if (text.startsWith('"""', i)) {
                out += '"""';
                state = 'NORMAL';
                i += 3;
                continue;
            }
            out += ch;
            i += 1;
            continue;
        }

        if (state === 'SINGLE') {
            if (ch === '\\' && i + 1 < len) {
                out += ch + text[i + 1];
                i += 2;
                continue;
            }
            if (mode === 'sql' && ch === "'" && text[i + 1] === "'") {
                out += "''";
                i += 2;
                continue;
            }
            out += ch;
            if (ch === "'") {
                state = 'NORMAL';
            }
            i += 1;
            continue;
        }

        if (state === 'DOUBLE') {
            if (ch === '\\' && i + 1 < len) {
                out += ch + text[i + 1];
                i += 2;
                continue;
            }
            if (mode === 'sql' && ch === '"' && text[i + 1] === '"') {
                out += '""';
                i += 2;
                continue;
            }
            out += ch;
            if (ch === '"') {
                state = 'NORMAL';
            }
            i += 1;
            continue;
        }

        if (state === 'BACKTICK') {
            if (ch === '\\' && i + 1 < len) {
                out += ch + text[i + 1];
                i += 2;
                continue;
            }
            out += ch;
            if (ch === '`') {
                state = 'NORMAL';
            }
            i += 1;
            continue;
        }

        if (mode !== 'sql' && text.startsWith("'''", i)) {
            out += "'''";
            state = 'TRIPLE_SINGLE';
            i += 3;
            continue;
        }
        if (mode !== 'sql' && text.startsWith('"""', i)) {
            out += '"""';
            state = 'TRIPLE_DOUBLE';
            i += 3;
            continue;
        }
        if (ch === "'") {
            out += ch;
            state = 'SINGLE';
            i += 1;
            continue;
        }
        if (ch === '"') {
            out += ch;
            state = 'DOUBLE';
            i += 1;
            continue;
        }
        if (ch === '`') {
            out += ch;
            state = 'BACKTICK';
            i += 1;
            continue;
        }

        if (mode === 'shell' && ch === '\\' && i + 1 < len) {
            out += ch + text[i + 1];
            i += 2;
            continue;
        }

        if ((mode === 'js' || mode === 'sql') && ch === '/' && text[i + 1] === '*') {
            state = 'BLOCK_COMMENT';
            i += 2;
            continue;
        }

        if (mode === 'sql' && ch === '-' && text[i + 1] === '-') {
            i += 2;
            while (i < len && text[i] !== '\n') i += 1;
            continue;
        }
        if (mode === 'js' && ch === '/' && text[i + 1] === '/') {
            i += 2;
            while (i < len && text[i] !== '\n') i += 1;
            continue;
        }
        if (mode === 'shell' && ch === '#') {
            const prev = i > 0 ? text[i - 1] : '\n';
            if (i === 0 || prev === '\n' || prev === ' ' || prev === '\t') {
                i += 1;
                while (i < len && text[i] !== '\n') i += 1;
                continue;
            }
        }
        // Python '#' line comments stripped here; Python '//' floor-division operator is preserved intact below
        if (mode === 'python' && ch === '#') {
            i += 1;
            while (i < len && text[i] !== '\n') i += 1;
            continue;
        }

        out += ch;
        i += 1;
    }

    return out
        .split('\n')
        .map((line) => line.replace(/[ \t]+$/g, ''))
        .filter((line) => line.length > 0)
        .join('\n');
}

function canonicalizeArgsValue(value) {
    if (Array.isArray(value)) {
        return value.map((item) => canonicalizeArgsValue(item));
    }
    if (value !== null && typeof value === 'object') {
        const sorted = {};
        for (const key of Object.keys(value).sort()) {
            const propVal = value[key];
            if (propVal !== undefined) {
                if (typeof propVal === 'string' && CODE_HASH_NORMALIZED_KEYS.has(key.toLowerCase())) {
                    sorted[key] = normalizeCodeSnippetForHash(propVal, key);
                } else {
                    sorted[key] = canonicalizeArgsValue(propVal);
                }
            }
        }
        return sorted;
    }
    return value;
}

function buildCanonicalCallSignature(toolName, args = {}) {
    const cleanTool = String(toolName ?? '').trim();
    const canonicalJson = JSON.stringify(canonicalizeArgsValue(args ?? {}));
    const hash = crypto.createHash('sha256').update(`${cleanTool}:${canonicalJson}`).digest('hex').slice(0, 32);
    return `${cleanTool}:${hash}`;
}

function inferToolMutability(toolName, args = {}, opts = {}, registeredTool = null) {
    if (typeof opts?.isMutating === 'boolean') {
        return opts.isMutating;
    }
    if (registeredTool?.annotations) {
        if (registeredTool.annotations.readOnlyHint === true) return false;
        if (registeredTool.annotations.destructiveHint === true) return true;
    }

    const lower = String(toolName ?? '').trim().toLowerCase();
    if (!lower) return false;

    if (
        /^(?:read|view|get|list|search|find|locate|describe|inspect|cat|head|tail|grep|status|doctor|health|check|retrieve|query|select|count|tool_search|tool_describe)\b/.test(lower) ||
        /_(?:read|view|get|list|search|locate|describe|inspect|status|health|retrieve)$/.test(lower)
    ) {
        return false;
    }

    if (/^(?:bash|sh|shell|run_command|exec|terminal)$/.test(lower)) {
        const cmd = String(args?.command ?? args?.cmd ?? args?.commandLine ?? args?.CommandLine ?? '').trim();
        if (
            /^(?:npm\s+test|node\s+--(?:test|check)\b|npx\s+(?:vitest|jest|oxlint|tsc)\b|pytest\b|cargo\s+test\b|go\s+test\b|git\s+(?:status|diff|log|show)\b|ls\b|pwd\b|cat\s+[^>|;&]+$)/i.test(cmd)
        ) {
            return false;
        }
        return true;
    }

    if (
        /(?:write|edit|replace|patch|create|update|upsert|insert|delete|remove|rm|mv|rename|apply|commit|push|send|post|publish|compose|schedule|assign|save|put|append|purge|ingest)/i.test(lower)
    ) {
        return true;
    }

    return false;
}

function extractTargetFilePath(args = {}) {
    if (!args || typeof args !== 'object') return '';
    return normalizeTrackablePath(
        args.path ?? args.filePath ?? args.relPath ?? args.targetFile ?? args.TargetFile ?? args.AbsolutePath ?? args.file ?? ''
    );
}

function isSimpleFullFileRead(toolName, args = {}) {
    const lower = String(toolName ?? '').trim().toLowerCase();
    if (!/^(?:read_file|view_file|read|cat|open_file|get_file|fs_read)$/.test(lower)) {
        return false;
    }
    if (!args || typeof args !== 'object') return false;
    const hasSliceOrFilter = args.query !== undefined || args.pattern !== undefined || args.search !== undefined;
    return !hasSliceOrFilter;
}

function collectScalarStrings(value, pathPrefix = '', out = []) {
    if (typeof value === 'string') {
        out.push({ keyPath: pathPrefix || 'value', text: value });
        return out;
    }
    if (Array.isArray(value)) {
        value.forEach((item, idx) => collectScalarStrings(item, `${pathPrefix}[${idx}]`, out));
        return out;
    }
    if (value !== null && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) {
            collectScalarStrings(v, pathPrefix ? `${pathPrefix}.${k}` : k, out);
        }
    }
    return out;
}

function scanArgumentsForSecrets(args = {}) {
    const scalars = collectScalarStrings(args);
    for (const { keyPath, text } of scalars) {
        for (const pattern of SECRET_ARGUMENT_PATTERNS) {
            if (pattern.test(text)) {
                return { leaked: true, field: keyPath };
            }
        }
    }
    return { leaked: false, field: null };
}

function isValidGregorianDate(year, month, day) {
    if (month < 1 || month > 12 || day < 1) return false;
    const isLeap = (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
    const daysInMonth = [31, isLeap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return day <= daysInMonth[month - 1];
}

function inspectPlaceholdersAndDates(args = {}) {
    const issues = [];
    const scalars = collectScalarStrings(args);

    for (const { keyPath, text } of scalars) {
        const trimmed = text.trim();
        if (!trimmed) continue;

        for (const re of PLACEHOLDER_VALUE_PATTERNS) {
            if (re.test(trimmed)) {
                issues.push({
                    code: 'UNBOUND_PLACEHOLDER',
                    field: keyPath,
                    message: `Argument "${keyPath}" contains an unbound placeholder value ("${trimmed.slice(0, 64)}").`
                });
                break;
            }
        }

        const isoDateMatches = trimmed.matchAll(/\b(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2}))?)?\b/g);
        for (const m of isoDateMatches) {
            const year = Number(m[1]);
            const month = Number(m[2]);
            const day = Number(m[3]);
            if (!isValidGregorianDate(year, month, day)) {
                issues.push({
                    code: 'INVALID_CALENDAR_DATE',
                    field: keyPath,
                    message: `Argument "${keyPath}" contains an impossible calendar date "${m[1]}-${m[2]}-${m[3]}".`
                });
                continue;
            }
            if (m[4] !== undefined && m[5] !== undefined) {
                const hour = Number(m[4]);
                const minute = Number(m[5]);
                const second = m[6] !== undefined ? Number(m[6]) : 0;
                if (hour > 23 || minute > 59 || second > 59) {
                    issues.push({
                        code: 'INVALID_CLOCK_TIME',
                        field: keyPath,
                        message: `Argument "${keyPath}" contains an out-of-range timestamp "${m[0]}".`
                    });
                }
            }
        }
    }

    return issues;
}

function extractBalancedBraceSlice(text, openBraceIndex) {
    if (text[openBraceIndex] !== '{') return null;
    let depth = 0;
    let inQuote = null;
    let i = openBraceIndex;
    const len = text.length;

    while (i < len) {
        const ch = text[i];
        if (inQuote) {
            if (ch === '\\' && i + 1 < len) {
                i += 2;
                continue;
            }
            if (ch === inQuote) {
                inQuote = null;
            }
            i += 1;
            continue;
        }
        if (ch === '"' || ch === "'") {
            inQuote = ch;
            i += 1;
            continue;
        }
        if (ch === '{') {
            depth += 1;
        } else if (ch === '}') {
            depth -= 1;
            if (depth === 0) {
                return { slice: text.slice(openBraceIndex, i + 1), endIndex: i + 1 };
            }
        }
        i += 1;
    }
    return null;
}

function extractSerializedToolCalls(assistantText = '') {
    const text = String(assistantText ?? '');
    if (!text) return { detected: false, calls: [] };

    const calls = [];
    let detected = false;

    const xmlMatches = text.matchAll(/<tool_call>\s*([\s\S]*?)\s*(?:<\/tool_call>|$)/gi);
    for (const m of xmlMatches) {
        detected = true;
        const inner = m[1].trim();
        try {
            const parsed = JSON.parse(inner);
            if (parsed && typeof parsed === 'object') {
                const name = String(parsed.name ?? parsed.tool ?? parsed.toolName ?? '').trim();
                const rawArgs = parsed.arguments ?? parsed.args ?? parsed.parameters ?? {};
                const args = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs;
                if (name) {
                    calls.push({ name, args: args && typeof args === 'object' ? args : {} });
                }
            }
        } catch {
            // Retain detected=true even when inner JSON requires re-emission
        }
    }

    const fnTagMatches = text.matchAll(/<function=([a-zA-Z0-9_.-]+)>\s*([\s\S]*?)\s*(?:<\/function>|$)/gi);
    for (const m of fnTagMatches) {
        detected = true;
        const name = m[1].trim();
        const body = m[2].trim();
        if (!body) {
            calls.push({ name, args: {} });
            continue;
        }
        try {
            const args = JSON.parse(body);
            calls.push({ name, args: args && typeof args === 'object' ? args : {} });
        } catch {
            calls.push({ name, args: {} });
        }
    }

    const fencedMatches = text.matchAll(/```tool_call\s*([\s\S]*?)```/gi);
    for (const m of fencedMatches) {
        detected = true;
        try {
            const parsed = JSON.parse(m[1].trim());
            const name = String(parsed?.name ?? parsed?.tool ?? '').trim();
            const args = parsed?.arguments ?? parsed?.args ?? {};
            if (name) calls.push({ name, args: args && typeof args === 'object' ? args : {} });
        } catch {
            // Retain detected=true
        }
    }

    const callPrefixMatches = text.matchAll(/\bcall:([a-zA-Z_][a-zA-Z0-9_.-]*)\s*\{/g);
    for (const m of callPrefixMatches) {
        detected = true;
        const name = m[1].trim();
        const openBraceIdx = m.index + m[0].length - 1;
        const balanced = extractBalancedBraceSlice(text, openBraceIdx);
        if (balanced) {
            try {
                const args = JSON.parse(balanced.slice);
                calls.push({ name, args: args && typeof args === 'object' && !Array.isArray(args) ? args : {} });
            } catch {
                calls.push({ name, args: {} });
            }
        } else {
            calls.push({ name, args: {} });
        }
    }

    return { detected, calls };
}

/**
 * Resolve Gemini `toolConfig` with automatic `functionCallingConfig: { mode: 'NONE' }`
 * on tool-less loops (`INV-GH-09`), eliminating `MALFORMED_FUNCTION_CALL` empty turns on fenced code.
 *
 * @param {object} [options={}] - Options (`tools`, `toolConfig`, `disableAutoToolConfigNone`).
 * @returns {object | null}
 */
export function buildSafeGeminiToolConfig(options = {}) {
    const safeOpts = options && typeof options === 'object' ? options : {};
    const { tools, toolConfig, disableAutoToolConfigNone = false } = safeOpts;

    if (toolConfig !== null && typeof toolConfig === 'object' && !Array.isArray(toolConfig)) {
        return toolConfig;
    }

    let hasTools = false;
    if (Array.isArray(tools)) {
        hasTools = tools.length > 0;
    } else if (tools !== null && typeof tools === 'object') {
        hasTools = Object.keys(tools).length > 0;
    }

    if (!hasTools && disableAutoToolConfigNone !== true) {
        return { functionCallingConfig: { mode: 'NONE' } };
    }

    return null;
}

const TRUNCATED_FINISH_REASONS = new Set([
    'MAX_TOKENS',
    'LENGTH',
    'MODEL_CONTEXT_WINDOW_EXCEEDED',
    'MALFORMED_FUNCTION_CALL'
]);

const EMPTY_BAILOUT_STRING_RE = /^(?:none|null|nan|\[\s*\]|\{\s*\})$/i;

const RAW_REPR_PATTERNS = Object.freeze([
    { label: 'NumPy scalar wrapper', re: /\b(?:np|numpy)\.(?:float|int|uint)\d*\s*\(/ },
    { label: 'Pandas dtype footer', re: /\bdtype:\s*[A-Za-z0-9_[\]]+/ },
    { label: 'Pandas DataFrame dimensions footer', re: /\[\d+\s+rows?\s*(?:x|\u00d7)\s*\d+\s+columns?\]/i },
    { label: 'Pandas Empty DataFrame repr', re: /\bEmpty\s+DataFrame\b/ },
    { label: 'Raw DataFrame(...) repr', re: /\bDataFrame\s*\(/ },
    { label: 'Raw Series([...]) repr', re: /\bSeries\s*\(\s*\[/ }
]);

function stripMarkdownCodeBlocksAndSpans(text = '') {
    return String(text ?? '')
        .replace(/```[\s\S]*?(?:```|$)/g, ' ')
        .replace(/~~~[\s\S]*?(?:~~~|$)/g, ' ')
        .replace(/`[^`\n]+`/g, ' ');
}

function isEmptyOrNullBailoutValue(value) {
    if (value === null || value === undefined) return true;
    if (typeof value === 'number') return Number.isNaN(value);
    if (typeof value === 'boolean') return false;
    if (Array.isArray(value)) return value.length === 0;
    if (typeof value === 'object') return Object.keys(value).length === 0;
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed.length === 0) return true;
        return EMPTY_BAILOUT_STRING_RE.test(trimmed);
    }
    return false;
}

function findRawDataframeOrNumpyRepr(candidateAnswer, assistantText = '') {
    if (candidateAnswer !== undefined && candidateAnswer !== null) {
        const candStr = typeof candidateAnswer === 'string'
            ? candidateAnswer
            : (typeof candidateAnswer === 'object' ? JSON.stringify(candidateAnswer) : String(candidateAnswer));
        for (const item of RAW_REPR_PATTERNS) {
            if (item.re.test(candStr)) {
                return `Candidate answer contains unformatted ${item.label}.`;
            }
        }
    }

    if (assistantText) {
        const proseOnly = stripMarkdownCodeBlocksAndSpans(assistantText);
        for (const item of RAW_REPR_PATTERNS) {
            if (item.re.test(proseOnly)) {
                return `Assistant output contains unformatted ${item.label} outside code spans.`;
            }
        }
    }

    return null;
}

function buildDefectCorrectivePrompt(defectCode, normFinish = '', truncationVerdict = null) {
    if (defectCode === 'TRUNCATED_OUTPUT') {
        if (normFinish === 'MALFORMED_FUNCTION_CALL') {
            return 'Your previous response terminated with MALFORMED_FUNCTION_CALL. Emit a valid structured JSON tool call or concise plain-text answer without malformed function call syntax.';
        }
        return truncationVerdict?.recoveryPrompt
            || 'Your previous response was truncated before completion (MAX_TOKENS/length). Continue concisely and emit a complete, well-formed final output.';
    }
    if (defectCode === 'SERIALIZED_TOOL_CALL_IN_TEXT') {
        return 'You emitted a plain-text serialized tool call (<tool_call>, <function=...>, or call:fn{...}) instead of invoking the structured tool API. Re-emit the tool call using native structured JSON arguments now.';
    }
    if (defectCode === 'EMPTY_OR_NULL_BAILOUT') {
        return 'Your candidate answer resolved to an empty or null bailout (None/null/NaN/empty). Compute and provide the concrete grounded answer (if the true value is 0, false, or N/A, state it explicitly).';
    }
    if (defectCode === 'RAW_DATAFRAME_OR_NUMPY_REPR') {
        return 'Your output contains unformatted Pandas DataFrame/Series or NumPy scalar repr text (e.g., np.float64(...), dtype:, or [N rows x M columns]). Convert values to clean native scalars/strings before answering.';
    }
    return null;
}

/**
 * Zero-turn-when-healthy objective output defect inspector (`INV-GH-05`).
 * Flags only `TRUNCATED_OUTPUT`, `SERIALIZED_TOOL_CALL_IN_TEXT`, `EMPTY_OR_NULL_BAILOUT`,
 * and `RAW_DATAFRAME_OR_NUMPY_REPR` while passing valid answers (`0`, `"0"`, `false`, `"N/A"`, `"Not Applicable"`).
 *
 * @param {object} [input={}] - Turn output state to inspect.
 * @returns {{
 *   hasDefect: boolean,
 *   defects: Array<{ code: string, message: string }>,
 *   primaryDefect: { code: string, message: string } | null,
 *   correctivePrompt: string | null,
 *   rescuedToolCalls: Array<{ name: string, args: object }>
 * }}
 */
export function inspectOutputDefects(input = {}) {
    const safeInput = input && typeof input === 'object' ? input : {};
    if (safeInput.enableOutputDefectGate === false || safeInput.enable_output_defect_gate === false) {
        return {
            hasDefect: false,
            defects: [],
            primaryDefect: null,
            correctivePrompt: null,
            rescuedToolCalls: []
        };
    }
    const assistantText = String(
        safeInput.assistantText ?? safeInput.content ?? safeInput.text ?? safeInput.finalText ?? ''
    );
    const finishReason = safeInput.finishReason ?? safeInput.stopReason ?? safeInput.finish_reason ?? safeInput.stop_reason ?? null;
    const normFinish = String(finishReason ?? '').trim().toUpperCase();
    const activeToolCalls = Array.isArray(safeInput.toolCalls)
        ? safeInput.toolCalls
        : (Array.isArray(safeInput.tool_calls) ? safeInput.tool_calls : []);
    const truncatedToolCalls = Boolean(safeInput.truncatedToolCalls);

    const defects = [];
    let rescuedToolCalls = [];

    // 1. TRUNCATED_OUTPUT
    const truncationVerdict = evaluateTruncationPoisoningGuard({
        ...safeInput,
        finishReason,
        toolCalls: activeToolCalls,
        truncatedToolCalls
    });
    if (truncationVerdict.poisoned === true || TRUNCATED_FINISH_REASONS.has(normFinish) || truncatedToolCalls) {
        const reasonLabel = normFinish && TRUNCATED_FINISH_REASONS.has(normFinish)
            ? normFinish
            : (truncationVerdict.reason || 'TRUNCATED_TOOL_CALLS');
        defects.push({
            code: 'TRUNCATED_OUTPUT',
            message: `Output truncated or malformed (${reasonLabel}).`
        });
    }

    // 2. SERIALIZED_TOOL_CALL_IN_TEXT
    if (activeToolCalls.length === 0 && assistantText) {
        const serialized = extractSerializedToolCalls(assistantText);
        if (serialized.detected) {
            rescuedToolCalls = serialized.calls;
            defects.push({
                code: 'SERIALIZED_TOOL_CALL_IN_TEXT',
                message: 'Plain-text serialized tool call detected in assistant text with zero structured toolCalls.'
            });
        }
    }

    // 3. EMPTY_OR_NULL_BAILOUT
    const shouldCheckBailout = safeInput.expectNonEmptyAnswer === true || safeInput.candidateAnswer !== undefined;
    if (shouldCheckBailout) {
        const bailoutTarget = safeInput.candidateAnswer !== undefined
            ? safeInput.candidateAnswer
            : (safeInput.hasFinalAnswer === false ? undefined : assistantText);
        if (isEmptyOrNullBailoutValue(bailoutTarget)) {
            defects.push({
                code: 'EMPTY_OR_NULL_BAILOUT',
                message: 'Candidate answer resolved to an empty, null, None, or NaN bailout value.'
            });
        }
    }

    // 4. RAW_DATAFRAME_OR_NUMPY_REPR
    const reprIssue = findRawDataframeOrNumpyRepr(safeInput.candidateAnswer, assistantText);
    if (reprIssue) {
        defects.push({
            code: 'RAW_DATAFRAME_OR_NUMPY_REPR',
            message: reprIssue
        });
    }

    const primaryDefect = defects.length > 0 ? defects[0] : null;
    const correctivePrompt = primaryDefect
        ? buildDefectCorrectivePrompt(primaryDefect.code, normFinish, truncationVerdict)
        : null;

    return {
        hasDefect: defects.length > 0,
        defects,
        primaryDefect,
        correctivePrompt,
        rescuedToolCalls
    };
}

const LITERAL_NA_TOKEN_RE = /^(?:NA|N\/A|#N\/A)$/i;

/**
 * Pure in-memory dataset schema hazard detector (`INV-GH-01`) flagging CSV literal `"NA"`/`"N/A"`
 * columns (`keep_default_na=False`) and JSON `null` / empty-array `[]` wildcard candidate fields.
 *
 * @param {object} [options={}] - Parsed headers, CSV rows, and/or JSON object records.
 * @returns {{
 *   hasLiteralNaHazard: boolean,
 *   naHazardColumns: string[],
 *   nullFields: string[],
 *   emptyArrayFields: string[],
 *   wildcardCandidateFields: string[],
 *   hazardWarnings: string[]
 * }}
 */
export function detectDatasetSchemaHazards({
    headers = [],
    csvRows = [],
    jsonRecords = []
} = {}) {
    const safeHeaders = Array.isArray(headers) ? headers.map((h) => String(h ?? '').trim()) : [];
    const safeCsvRows = Array.isArray(csvRows) ? csvRows : [];
    const safeJsonRecords = Array.isArray(jsonRecords) ? jsonRecords : [];

    const naColumnSet = new Set();
    for (const row of safeCsvRows) {
        if (Array.isArray(row)) {
            for (let idx = 0; idx < row.length; idx += 1) {
                const cell = row[idx];
                if (typeof cell === 'string' && LITERAL_NA_TOKEN_RE.test(cell.trim())) {
                    const colName = safeHeaders[idx] || `col_${idx}`;
                    naColumnSet.add(colName);
                }
            }
        } else if (row && typeof row === 'object') {
            for (const [colName, cell] of Object.entries(row)) {
                if (typeof cell === 'string' && LITERAL_NA_TOKEN_RE.test(cell.trim())) {
                    naColumnSet.add(colName);
                }
            }
        }
    }

    const naHazardColumns = Array.from(naColumnSet);
    const hasLiteralNaHazard = naHazardColumns.length > 0;

    const nullFieldSet = new Set();
    const emptyArrayFieldSet = new Set();
    const wildcardSet = new Set();

    for (const rec of safeJsonRecords) {
        if (!rec || typeof rec !== 'object' || Array.isArray(rec)) continue;
        for (const [key, val] of Object.entries(rec)) {
            if (val === null) {
                nullFieldSet.add(key);
                wildcardSet.add(key);
            } else if (Array.isArray(val) && val.length === 0) {
                emptyArrayFieldSet.add(key);
                wildcardSet.add(key);
            }
        }
    }

    const nullFields = Array.from(nullFieldSet);
    const emptyArrayFields = Array.from(emptyArrayFieldSet);
    const wildcardCandidateFields = Array.from(wildcardSet);

    const hazardWarnings = [];
    if (hasLiteralNaHazard) {
        hazardWarnings.push(
            `CSV literal "NA"/"N/A" string tokens detected in column(s) [${naHazardColumns.join(', ')}]; use keep_default_na=False so valid codes (e.g. "NA") are not coerced to NaN.`
        );
    }
    if (wildcardCandidateFields.length > 0) {
        hazardWarnings.push(
            `JSON wildcardCandidateFields [${wildcardCandidateFields.join(', ')}] contain null (${nullFields.join(', ') || 'none'}) and/or empty array [] (${emptyArrayFields.join(', ') || 'none'}); treat null/[] as potential match-all wildcards when filtering.`
        );
    }

    return {
        hasLiteralNaHazard,
        naHazardColumns,
        nullFields,
        emptyArrayFields,
        wildcardCandidateFields,
        hazardWarnings
    };
}

function boundStreamText(rawText, maxChars) {
    const str = String(rawText ?? '');
    if (str.length <= maxChars) return str;
    const marker = '\n...[truncated]...\n';
    if (maxChars <= marker.length + 4) {
        return str.slice(0, maxChars);
    }
    const budget = maxChars - marker.length;
    const headLen = Math.ceil(budget * 0.6);
    const tailLen = budget - headLen;
    return `${str.slice(0, headLen)}${marker}${str.slice(str.length - tailLen)}`;
}

/**
 * Format a sandbox/tool timeout while preserving partial `stdout` emitted prior to timeout
 * and explicitly clearing any stale `finalAnswer` (`INV-GH-10`).
 *
 * @param {object} [options={}] - Timeout formatting options.
 * @returns {{
 *   ok: false,
 *   timedOut: true,
 *   stdout: string,
 *   stderr: string,
 *   hasFinalAnswer: false,
 *   finalAnswer: null,
 *   error: string,
 *   formattedObservation: string
 * }}
 */
export function formatTimeoutWithPartialStdout({
    timeoutMs,
    timeoutSeconds,
    stdout = '',
    stderr = '',
    maxStdoutChars = 8000,
    label = 'Sandbox execution'
} = {}) {
    const cap = Number.isInteger(maxStdoutChars) && maxStdoutChars > 0 ? maxStdoutChars : 8000;
    const resolvedMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
        ? Number(timeoutMs)
        : (Number.isFinite(Number(timeoutSeconds)) && Number(timeoutSeconds) > 0
            ? Number(timeoutSeconds) * 1000
            : null);
    const resolvedSeconds = Number.isFinite(Number(timeoutSeconds)) && Number(timeoutSeconds) > 0
        ? Number(timeoutSeconds)
        : (resolvedMs !== null ? Number((resolvedMs / 1000).toFixed(2)) : null);

    const preservedStdout = boundStreamText(stdout, cap);
    const preservedStderr = boundStreamText(stderr, cap);
    const cleanLabel = String(label || 'Sandbox execution').trim();
    const durationDesc = resolvedSeconds !== null ? `${resolvedSeconds}s` : 'configured limit';
    const error = `TimeoutError: ${cleanLabel} timed out after ${durationDesc}.`;

    const obsParts = [
        error,
        'Stale finalAnswer cleared (hasFinalAnswer=false).'
    ];
    if (preservedStdout.length > 0) {
        obsParts.push(`[PARTIAL STDOUT BEFORE TIMEOUT]\n${preservedStdout}`);
    } else {
        obsParts.push('[PARTIAL STDOUT BEFORE TIMEOUT]\n(none)');
    }
    if (preservedStderr.length > 0) {
        obsParts.push(`[PARTIAL STDERR BEFORE TIMEOUT]\n${preservedStderr}`);
    }

    return {
        ok: false,
        timedOut: true,
        stdout: preservedStdout,
        stderr: preservedStderr,
        hasFinalAnswer: false,
        finalAnswer: null,
        error,
        formattedObservation: obsParts.join('\n')
    };
}

function isTimeoutErrorLike(err) {
    if (!err || typeof err !== 'object') return false;
    if (err.timedOut === true) return true;
    const name = String(err.name ?? '');
    if (name === 'TimeoutError' || name === 'AbortError') return true;
    const code = String(err.code ?? '');
    if (code === 'ETIMEDOUT' || code === 'ABORT_ERR') return true;
    return /\b(?:TimeoutError|timed?\s*out)\b/i.test(String(err.message ?? ''));
}

/**
 * Portable async timeout wrapper (`INV-GH-10`) using `AbortController` + `{ signal, onStdout, onStderr }`
 * streaming callbacks. Resolves with `formatTimeoutWithPartialStdout(...)` containing all `stdout`
 * chunks streamed prior to timeout whenever `runnerFn` exceeds `timeoutMs` or aborts/throws timeout.
 *
 * @param {(ctx: { signal: AbortSignal, onStdout: (chunk: string) => void, onStderr: (chunk: string) => void }) => any} runnerFn
 * @param {object} [options={}] - Timeout options (`timeoutMs`, `maxStdoutChars`, `label`).
 * @returns {Promise<object>}
 */
export async function runAsyncWithPartialStdout(
    runnerFn,
    {
        timeoutMs = 15000,
        maxStdoutChars = 8000,
        label = 'Sandbox execution'
    } = {}
) {
    if (typeof runnerFn !== 'function') {
        throw new TypeError('runAsyncWithPartialStdout requires a runnerFn function.');
    }

    const effectiveTimeoutMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
        ? Number(timeoutMs)
        : 15000;
    const effectiveCap = Number.isInteger(maxStdoutChars) && maxStdoutChars > 0 ? maxStdoutChars : 8000;

    const stdoutChunks = [];
    const stderrChunks = [];
    const onStdout = (chunk) => {
        if (chunk !== undefined && chunk !== null) {
            stdoutChunks.push(String(chunk));
        }
    };
    const onStderr = (chunk) => {
        if (chunk !== undefined && chunk !== null) {
            stderrChunks.push(String(chunk));
        }
    };

    const controller = new AbortController();
    let timerId = null;
    let didTimeout = false;

    const timeoutSentinel = Symbol('TIMEOUT_SENTINEL');
    const timeoutPromise = new Promise((resolve) => {
        timerId = setTimeout(() => {
            didTimeout = true;
            controller.abort(new Error(`TimeoutError: ${label} exceeded ${effectiveTimeoutMs}ms.`));
            resolve(timeoutSentinel);
        }, effectiveTimeoutMs);
    });

    const runnerPromise = Promise.resolve().then(() =>
        runnerFn({ signal: controller.signal, onStdout, onStderr })
    );
    // Prevent unhandled rejections if runnerFn rejects asynchronously after timeout abort
    runnerPromise.catch(() => {});

    try {
        const outcome = await Promise.race([runnerPromise, timeoutPromise]);
        if (outcome === timeoutSentinel || didTimeout) {
            return formatTimeoutWithPartialStdout({
                timeoutMs: effectiveTimeoutMs,
                stdout: stdoutChunks.join(''),
                stderr: stderrChunks.join(''),
                maxStdoutChars: effectiveCap,
                label
            });
        }

        const streamedStdout = boundStreamText(stdoutChunks.join(''), effectiveCap);
        const streamedStderr = boundStreamText(stderrChunks.join(''), effectiveCap);

        if (outcome && typeof outcome === 'object' && !Array.isArray(outcome)) {
            if (outcome.timedOut === true) {
                return formatTimeoutWithPartialStdout({
                    timeoutMs: effectiveTimeoutMs,
                    stdout: stdoutChunks.length > 0 ? stdoutChunks.join('') : String(outcome.stdout ?? ''),
                    stderr: stderrChunks.length > 0 ? stderrChunks.join('') : String(outcome.stderr ?? ''),
                    maxStdoutChars: effectiveCap,
                    label
                });
            }
            return {
                ok: outcome.ok !== false,
                timedOut: false,
                ...outcome,
                stdout: outcome.stdout !== undefined ? String(outcome.stdout) : streamedStdout,
                stderr: outcome.stderr !== undefined ? String(outcome.stderr) : streamedStderr
            };
        }

        return {
            ok: true,
            timedOut: false,
            stdout: streamedStdout,
            stderr: streamedStderr,
            result: outcome
        };
    } catch (err) {
        const mergedStdout = stdoutChunks.length > 0
            ? stdoutChunks.join('')
            : (typeof err?.stdout === 'string' ? err.stdout : '');
        const mergedStderr = stderrChunks.length > 0
            ? stderrChunks.join('')
            : (typeof err?.stderr === 'string' ? err.stderr : '');

        if (didTimeout || controller.signal.aborted || isTimeoutErrorLike(err)) {
            return formatTimeoutWithPartialStdout({
                timeoutMs: effectiveTimeoutMs,
                stdout: mergedStdout,
                stderr: mergedStderr,
                maxStdoutChars: effectiveCap,
                label
            });
        }

        if (err && typeof err === 'object') {
            err.partialStdout = boundStreamText(mergedStdout, effectiveCap);
            err.partialStderr = boundStreamText(mergedStderr, effectiveCap);
        }
        throw err;
    } finally {
        if (timerId !== null) {
            clearTimeout(timerId);
        }
    }
}

function detectUncommittedOutboundDraft(assistantText = '', turnState = {}) {
    if (turnState?.hasUncommittedDraft === true) return true;
    const text = String(assistantText ?? '').trim();
    if (!text) return false;

    const hasEmailHeaderPair =
        /(?:^|\n)\s*(?:To|Recipient)\s*:\s*\S+[\s\S]{0,260}?(?:^|\n)\s*Subject\s*:\s*\S+/i.test(text) ||
        /(?:^|\n)\s*Subject\s*:\s*\S+[\s\S]{0,260}?(?:^|\n)\s*(?:To|Recipient)\s*:\s*\S+/i.test(text);
    if (hasEmailHeaderPair) return true;

    return /\b(?:here is (?:a |the )?draft|draft (?:email|message|reply|response|invite)|i['\u2019]?ve drafted|would you like me to (?:send|post|schedule|create|submit)|shall i (?:send|post|schedule|create|submit))\b/i.test(text);
}

/**
 * Create a lightweight, runtime-portable, Turn-0 grounded and scale-aware agent harness loop
 * composing `@krusch/toolkit/harness-engineering`, `@krusch/toolkit/raw-rag`, and `@krusch/toolkit/http`.
 *
 * @param {object} [options={}] - Harness loop options.
 * @returns {object}
 */
export function createGroundedHarnessLoop(options = {}) {
    const {
        model = '',
        activeParamsB,
        totalParamsB,
        thinkingEnabled,
        thinkingLevel,
        reasoningEffort,
        explicitTier,
        preferThinkingStepForSmallActive = false,
        maxDuplicateWrites = 1,
        verificationCommand = null,
        maxVerifyRetries = 2,
        maxDefectRetries = 1,
        enableOutputDefectGate = true,
        toolConfig: defaultToolConfig,
        disableAutoToolConfigNone = false,
        baseSystemPrompt = 'You are a grounded, low-tool-call autonomous agent.',
        standingInvariants = [],
        schemaSummaryText = '',
        docs = [],
        fileDigests = {},
        tools = [],
        pinnedToolNames = [],
        referenceTexts = [],
        deferThreshold = 12,
        forceDefer = false,
        searchTopK = 5,
        dispatcher,
        protectedPaths = [],
        extraFloorRules = [],
        maxDocEvidenceTokens = 1400,
        topKChunks = 6
    } = options || {};

    const scaleProfile = resolveScaleProfile({
        model,
        activeParamsB,
        totalParamsB,
        thinkingEnabled,
        thinkingLevel,
        reasoningEffort,
        explicitTier,
        preferThinkingStepForSmallActive
    });

    const combinedReferenceTexts = [
        ...(Array.isArray(standingInvariants) ? standingInvariants : []),
        ...(typeof schemaSummaryText === 'string' && schemaSummaryText.trim().length > 0 ? [schemaSummaryText] : []),
        ...(Array.isArray(referenceTexts) ? referenceTexts : [])
    ];

    const toolGate = createToolBudgetGate({
        tools,
        pinnedToolNames,
        systemPrompt: baseSystemPrompt,
        referenceTexts: combinedReferenceTexts,
        deferThreshold,
        forceDefer,
        searchTopK,
        dispatcher
    });

    const policyFloor = createFrozenPolicyFloor({
        protectedPaths,
        extraRules: extraFloorRules
    });

    const initialMergedDigests = { ...(fileDigests && typeof fileDigests === 'object' ? fileDigests : {}) };
    if (Array.isArray(docs)) {
        for (const doc of docs) {
            if (doc && typeof doc === 'object' && doc.sha256 && (doc.relPath || doc.path)) {
                const key = normalizeTrackablePath(doc.relPath ?? doc.path);
                if (key && !initialMergedDigests[key]) {
                    initialMergedDigests[key] = String(doc.sha256);
                }
            }
        }
    }

    const deltaTracker = createDeltaContextTracker({
        initialChunkIds: [],
        initialFileDigests: initialMergedDigests
    });

    const toolByName = new Map();
    if (Array.isArray(tools)) {
        for (const t of tools) {
            const name = t?.name ?? t?.function?.name;
            if (name) toolByName.set(String(name), t);
        }
    }

    let cachedRagIndex = null;
    let cachedRagInitPromise = null;
    let ragBuildCount = 0;

    const committedWriteCounts = new Map();
    const failedCallPreviews = new Map();
    const executedSignatures = new Set();
    const pendingCalls = new Map();
    const mutatedPaths = new Set();

    let pendingDiffsCount = 0;
    let latestVerificationPassed = true;
    let diffVerifyRetriesUsed = 0;
    let serializedRescueCount = 0;
    let defectRetriesUsed = 0;
    let draftRescueCount = 0;

    const stats = {
        committedReads: 0,
        committedMutations: 0,
        spinLoopsBlocked: 0,
        outputDefectsCaught: 0,
        timeoutsWithPartialStdout: 0,
        duplicateWritesBlocked: 0,
        policyFloorBlocks: 0,
        secretLeaksBlocked: 0,
        softHoldsTriggered: 0,
        truncationRecoveries: 0,
        verifyNudgesUsed: 0
    };

    async function ensureDocIndex() {
        if (!Array.isArray(docs) || docs.length === 0) {
            return { index: null, cachedIndexReused: false };
        }
        if (cachedRagIndex) {
            return { index: cachedRagIndex, cachedIndexReused: true };
        }
        if (!cachedRagInitPromise) {
            cachedRagInitPromise = (async () => {
                const idx = createRawRagIndex({
                    windowTokens: 256,
                    overlapTokens: 32,
                    offline: true,
                    turnExpansion: false,
                    maxEvidenceTokens: maxDocEvidenceTokens,
                    finalRerankK: topKChunks,
                    idPrefix: 'grounded_doc'
                });
                const docTurns = docs.map((doc, i) => {
                    if (typeof doc === 'string') {
                        return { turnId: `doc_${i}`, speaker: `doc_${i}`, date: 'static', content: doc };
                    }
                    const label = String(doc?.relPath ?? doc?.path ?? doc?.title ?? doc?.id ?? `doc_${i}`);
                    const content = String(doc?.text ?? doc?.content ?? '');
                    return { turnId: label, speaker: label, date: 'static', content };
                });
                await idx.addTurns(docTurns);
                ragBuildCount += 1;
                cachedRagIndex = idx;
                return idx;
            })();
        }
        const built = await cachedRagInitPromise;
        return { index: built, cachedIndexReused: ragBuildCount > 1 };
    }

    function buildStaticSystemPrompt() {
        const sections = [String(baseSystemPrompt || '').trim()];
        if (Array.isArray(standingInvariants) && standingInvariants.length > 0) {
            const cleanedInvariants = standingInvariants
                .map((inv) => String(inv ?? '').trim())
                .filter(Boolean);
            if (cleanedInvariants.length > 0) {
                sections.push(`[STANDING INVARIANTS]\n${cleanedInvariants.map((item) => `- ${item}`).join('\n')}`);
            }
        }
        if (typeof schemaSummaryText === 'string' && schemaSummaryText.trim().length > 0) {
            sections.push(`[WORKSPACE SCHEMAS]\n${schemaSummaryText.trim()}`);
        }
        const directive = buildScaleAwareDirective(scaleProfile);
        if (directive) {
            sections.push(directive);
        }
        return {
            systemText: sections.filter(Boolean).join('\n\n'),
            scaleDirective: directive
        };
    }

    async function compilePrompt(goal = '', compileOpts = {}) {
        const cleanGoal = String(goal ?? '').trim();
        const effectiveTopK = Number.isInteger(compileOpts?.topKChunks) && compileOpts.topKChunks > 0
            ? compileOpts.topKChunks
            : topKChunks;
        const effectiveBudget = Number.isInteger(compileOpts?.maxDocEvidenceTokens) && compileOpts.maxDocEvidenceTokens > 0
            ? compileOpts.maxDocEvidenceTokens
            : maxDocEvidenceTokens;

        const alreadyCached = cachedRagIndex !== null;
        const { index } = await ensureDocIndex();

        let retrievedChunks = [];
        let compiledContextBlock = '';
        let docEvidenceTokens = 0;

        if (index && cleanGoal) {
            const retrieved = await index.retrieve(cleanGoal, {
                finalRerankK: effectiveTopK,
                maxEvidenceTokens: effectiveBudget,
                turnExpansion: false,
                offline: true
            });
            retrievedChunks = (retrieved.entries || []).map((entry) => ({
                chunkId: String(entry.windowId ?? entry.entryId),
                windowId: String(entry.windowId ?? entry.entryId),
                text: entry.text,
                tokenCount: entry.tokenCount
            }));
            compiledContextBlock = retrieved.contextText || '';
            docEvidenceTokens = retrieved.tokenCount || 0;
        }

        const chunkIds = retrievedChunks.map((c) => c.chunkId);
        deltaTracker.seedTurnZero({ chunkIds, fileDigests: initialMergedDigests });

        const { systemText, scaleDirective } = buildStaticSystemPrompt();
        const canonicalPrefix = normalizePromptCachePrefix(
            [{ role: 'system', content: systemText }],
            { tools: toolGate.exposedTools }
        );

        const exposedToolsList = canonicalPrefix.tools ?? toolGate.exposedTools;
        const geminiToolConfig = buildSafeGeminiToolConfig({
            tools: exposedToolsList,
            toolConfig: compileOpts?.toolConfig !== undefined ? compileOpts.toolConfig : defaultToolConfig,
            disableAutoToolConfigNone: compileOpts?.disableAutoToolConfigNone !== undefined
                ? compileOpts.disableAutoToolConfigNone
                : disableAutoToolConfigNone
        });

        const userSections = [];
        if (compiledContextBlock) {
            userSections.push(`[TURN-0 GROUNDED EVIDENCE]\n${compiledContextBlock}`);
        }
        if (typeof compileOpts?.extraContext === 'string' && compileOpts.extraContext.trim().length > 0) {
            userSections.push(compileOpts.extraContext.trim());
        }
        if (cleanGoal) {
            userSections.push(`[TASK GOAL]\n${cleanGoal}`);
        }

        const history = Array.isArray(compileOpts?.history) ? compileOpts.history : [];
        const messages = [
            ...canonicalPrefix.messages,
            ...history,
            ...(userSections.length > 0 ? [{ role: 'user', content: userSections.join('\n\n') }] : [])
        ];

        const systemPrefixTokens = estimateTokenCount(systemText);
        const goalTokens = estimateTokenCount(cleanGoal);
        const totalPromptTokens = messages.reduce(
            (sum, m) => sum + estimateTokenCount(typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? '')),
            0
        );

        return okEnvelope(
            'grounded.compile_prompt',
            `Compiled Turn-0 grounded prompt (${scaleProfile.tier}, ${retrievedChunks.length} chunk(s), prefix ${canonicalPrefix.prefixHash.slice(0, 12)}).`,
            {
                goal: cleanGoal,
                scaleProfile,
                scaleDirective,
                prefixHash: canonicalPrefix.prefixHash,
                geminiToolConfig,
                compiledSystemPrompt: canonicalPrefix.messages[0]?.content ?? systemText,
                compiledContextBlock,
                messages,
                exposedTools: exposedToolsList,
                toolSavings: toolGate.savings,
                retrievedChunks,
                seenChunkIds: chunkIds,
                tokenStats: {
                    systemPrefixTokens,
                    docEvidenceTokens,
                    goalTokens,
                    totalPromptTokens,
                    exposedToolSchemaTokens: toolGate.savings.exposedSchemaTokens,
                    savedToolSchemaTokens: toolGate.savings.savedSchemaTokens
                },
                cachedIndexReused: alreadyCached,
                llmIngestionCalls: 0
            }
        );
    }

    function evaluateTurn(turnResponse = {}, candidateChunks = []) {
        const truncation = evaluateTruncationPoisoningGuard(turnResponse);
        if (truncation.poisoned) {
            stats.truncationRecoveries += 1;
        }
        const delta = deltaTracker.filterDeltaChunks(candidateChunks);
        const assistantText = String(turnResponse?.content ?? turnResponse?.assistantText ?? turnResponse?.text ?? '');
        const serialized = extractSerializedToolCalls(assistantText);

        return okEnvelope(
            'grounded.evaluate_turn',
            truncation.poisoned
                ? `Turn aborted due to truncation poisoning (${truncation.reason}).`
                : `Turn evaluated (${delta.acceptedCount} delta chunk(s), ${delta.suppressedCount} Turn-0 duplicate(s) suppressed).`,
            {
                poisoned: truncation.poisoned,
                safeToExecuteTools: truncation.safeToExecuteTools,
                truncation,
                deltaChunks: delta.deltaChunks,
                suppressedChunkCount: delta.suppressedCount,
                acceptedChunkCount: delta.acceptedCount,
                serializedToolCallsDetected: serialized.detected,
                rescuedToolCalls: serialized.calls,
                deltaMetrics: deltaTracker.getMetrics()
            }
        );
    }

    function interceptToolCall(toolName, args = {}, opts = {}) {
        const rawToolName = String(toolName ?? '').trim();
        const safeArgs = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
        const effectiveTool = rawToolName === 'tool_call' && typeof safeArgs.toolName === 'string'
            ? safeArgs.toolName.trim()
            : rawToolName;
        const effectiveArgs = rawToolName === 'tool_call' && safeArgs.args && typeof safeArgs.args === 'object'
            ? safeArgs.args
            : safeArgs;

        const callSignature = buildCanonicalCallSignature(effectiveTool, effectiveArgs);
        const registeredTool = toolByName.get(effectiveTool) ?? null;
        const isMutating = inferToolMutability(effectiveTool, effectiveArgs, opts, registeredTool);
        const targetPath = extractTargetFilePath(effectiveArgs);

        // 1. Frozen hardline policy floor
        const floorVerdict = policyFloor.evaluate(effectiveTool, effectiveArgs);
        if (!floorVerdict.allowed) {
            stats.policyFloorBlocks += 1;
            return okEnvelope(
                'grounded.intercept',
                floorVerdict.reason,
                {
                    allowed: false,
                    decision: 'BLOCK_POLICY_FLOOR',
                    code: 'POLICY_FLOOR_FORBIDDEN',
                    ruleId: floorVerdict.ruleId,
                    reason: floorVerdict.reason,
                    callSignature,
                    toolName: effectiveTool,
                    isMutating,
                    maxReadStreak: scaleProfile.maxReadStreak,
                    issues: [{ code: floorVerdict.ruleId || 'POLICY_FLOOR_FORBIDDEN', message: floorVerdict.reason }]
                }
            );
        }

        // 2. Secret-leak block
        if (opts?.allowSecretScanBypass !== true) {
            const secretScan = scanArgumentsForSecrets(effectiveArgs);
            if (secretScan.leaked) {
                stats.policyFloorBlocks += 1;
                stats.secretLeaksBlocked += 1;
                const reason = `Blocked tool call "${effectiveTool}" due to secret credential or private key in "${secretScan.field}".`;
                return okEnvelope(
                    'grounded.intercept',
                    reason,
                    {
                        allowed: false,
                        decision: 'SECRET_LEAK_BLOCKED',
                        code: 'SECRET_LEAK_BLOCKED',
                        ruleId: 'SECRET_LEAK_BLOCKED',
                        reason,
                        callSignature,
                        toolName: effectiveTool,
                        isMutating,
                        maxReadStreak: scaleProfile.maxReadStreak,
                        issues: [{ code: 'SECRET_LEAK_BLOCKED', field: secretScan.field, message: reason }]
                    }
                );
            }
        }

        // 3. Duplicate-write block
        const dupCap = Number.isInteger(opts?.maxDuplicateWrites) && opts.maxDuplicateWrites > 0
            ? opts.maxDuplicateWrites
            : maxDuplicateWrites;
        if (isMutating && (committedWriteCounts.get(callSignature) || 0) >= dupCap) {
            stats.duplicateWritesBlocked += 1;
            const reason = `Blocked duplicate mutating tool call "${effectiveTool}" (${callSignature}).`;
            return okEnvelope(
                'grounded.intercept',
                reason,
                {
                    allowed: false,
                    decision: 'BLOCK_DUPLICATE_WRITE',
                    code: 'BLOCK_DUPLICATE_WRITE',
                    ruleId: null,
                    reason,
                    callSignature,
                    toolName: effectiveTool,
                    isMutating: true,
                    maxReadStreak: scaleProfile.maxReadStreak,
                    issues: [{ code: 'BLOCK_DUPLICATE_WRITE', message: reason }]
                }
            );
        }

        // 4. SMALL_MODEL-only placeholder & invalid-date soft-hold
        if (scaleProfile.softHoldPlaceholdersAndDates && opts?.allowPlaceholders !== true) {
            const softIssues = inspectPlaceholdersAndDates(effectiveArgs);
            if (softIssues.length > 0) {
                stats.softHoldsTriggered += 1;
                const reason = softIssues.map((i) => i.message).join(' ');
                return okEnvelope(
                    'grounded.intercept',
                    `Soft-hold blocked "${effectiveTool}": ${reason}`,
                    {
                        allowed: false,
                        decision: 'SOFT_HOLD_PLACEHOLDER_OR_DATE',
                        code: softIssues[0].code,
                        ruleId: null,
                        reason,
                        callSignature,
                        toolName: effectiveTool,
                        isMutating,
                        maxReadStreak: scaleProfile.maxReadStreak,
                        issues: softIssues
                    }
                );
            }
        }

        // 5. Normalized spin-loop guard on repeat failed calls or explicit blockSpinLoop=true
        if (opts?.blockSpinLoop !== false) {
            if (failedCallPreviews.has(callSignature)) {
                stats.spinLoopsBlocked += 1;
                const priorFailure = failedCallPreviews.get(callSignature);
                const reason = `Blocked repeat spin-loop call "${effectiveTool}" matching a prior failed execution (${callSignature}).`;
                return okEnvelope(
                    'grounded.intercept',
                    reason,
                    {
                        allowed: false,
                        decision: 'BLOCK_SPIN_LOOP',
                        code: 'BLOCK_SPIN_LOOP',
                        ruleId: null,
                        reason,
                        cachedPreview: priorFailure?.preview ?? null,
                        cachedResult: priorFailure?.result ?? null,
                        callSignature,
                        toolName: effectiveTool,
                        isMutating,
                        maxReadStreak: scaleProfile.maxReadStreak,
                        issues: [{ code: 'BLOCK_SPIN_LOOP', message: reason }]
                    }
                );
            }

            if (opts?.blockSpinLoop === true && executedSignatures.has(callSignature)) {
                stats.spinLoopsBlocked += 1;
                const memoEntry = !isMutating ? deltaTracker.checkReadMemo(callSignature) : null;
                const reason = `Blocked repeat spin-loop call "${effectiveTool}" (${callSignature}) under blockSpinLoop=true.`;
                return okEnvelope(
                    'grounded.intercept',
                    reason,
                    {
                        allowed: false,
                        decision: 'BLOCK_SPIN_LOOP',
                        code: 'BLOCK_SPIN_LOOP',
                        ruleId: null,
                        reason,
                        cachedPreview: memoEntry?.hit ? memoEntry.preview : null,
                        cachedResult: memoEntry?.hit ? memoEntry.result : null,
                        callSignature,
                        toolName: effectiveTool,
                        isMutating,
                        maxReadStreak: scaleProfile.maxReadStreak,
                        issues: [{ code: 'BLOCK_SPIN_LOOP', message: reason }]
                    }
                );
            }
        }

        // 6. Memoized prior read -> escalates to BLOCK_SPIN_LOOP on 2nd repeat (maxReadStreak: 0 always)
        if (!isMutating) {
            const memo = deltaTracker.checkReadMemo(callSignature);
            if (memo.hit) {
                if (opts?.blockSpinLoop !== false && memo.hits >= 2) {
                    stats.spinLoopsBlocked += 1;
                    const reason = `Blocked repeat spin-loop read "${effectiveTool}" after memoized preview was already returned (${callSignature}).`;
                    return okEnvelope(
                        'grounded.intercept',
                        reason,
                        {
                            allowed: false,
                            decision: 'BLOCK_SPIN_LOOP',
                            code: 'BLOCK_SPIN_LOOP',
                            ruleId: null,
                            reason,
                            cachedPreview: memo.preview,
                            cachedResult: memo.result,
                            callSignature,
                            toolName: effectiveTool,
                            isMutating: false,
                            maxReadStreak: scaleProfile.maxReadStreak,
                            issues: [{ code: 'BLOCK_SPIN_LOOP', message: reason }]
                        }
                    );
                }

                return okEnvelope(
                    'grounded.intercept',
                    `Memoized prior read returned for "${effectiveTool}".`,
                    {
                        allowed: false,
                        decision: 'MEMOIZED_PRIOR_READ',
                        code: 'MEMOIZED_PRIOR_READ',
                        ruleId: null,
                        reason: 'Identical read call already succeeded in this session; reuse memoized preview.',
                        cachedPreview: memo.preview,
                        cachedResult: memo.result,
                        callSignature,
                        toolName: effectiveTool,
                        isMutating: false,
                        maxReadStreak: scaleProfile.maxReadStreak,
                        issues: []
                    }
                );
            }

            // 7. Turn-0 SHA-256 file-digest short-circuit
            const providedDigest = opts?.currentDigest ?? opts?.fileDigest ?? opts?.digest ?? effectiveArgs?.sha256 ?? effectiveArgs?.digest;
            if (
                targetPath &&
                !mutatedPaths.has(targetPath) &&
                (providedDigest !== undefined || isSimpleFullFileRead(effectiveTool, effectiveArgs)) &&
                deltaTracker.hasSeenFileDigest(targetPath, providedDigest)
            ) {
                const reason = `File "${targetPath}" is unchanged from its Turn-0 grounded SHA-256 digest.`;
                return okEnvelope(
                    'grounded.intercept',
                    reason,
                    {
                        allowed: false,
                        decision: 'TURN0_DIGEST_SHORT_CIRCUIT',
                        code: 'TURN0_DIGEST_SHORT_CIRCUIT',
                        ruleId: null,
                        reason,
                        targetPath,
                        callSignature,
                        toolName: effectiveTool,
                        isMutating: false,
                        maxReadStreak: scaleProfile.maxReadStreak,
                        issues: []
                    }
                );
            }
        }

        pendingCalls.set(callSignature, {
            toolName: effectiveTool,
            isMutating,
            targetPath
        });

        return okEnvelope(
            'grounded.intercept',
            `Allowed "${effectiveTool}".`,
            {
                allowed: true,
                decision: 'ALLOW',
                code: 'ALLOW',
                ruleId: null,
                reason: 'Passed passive safety floor and delta tool gate.',
                callSignature,
                toolName: effectiveTool,
                isMutating,
                maxReadStreak: scaleProfile.maxReadStreak,
                issues: []
            }
        );
    }

    function recordToolOutcome(
        callSignature,
        {
            ok = true,
            preview = '',
            result = null,
            isMutating,
            pendingDiffsDelta = 0,
            verificationPassed,
            timedOut = false,
            partialStdout,
            stdout,
            stderr = '',
            timeoutMs,
            timeoutSeconds,
            maxStdoutChars = 8000,
            label
        } = {}
    ) {
        const sig = String(callSignature ?? '').trim();
        const pendingMeta = sig ? pendingCalls.get(sig) : null;
        const effectiveMutating = typeof isMutating === 'boolean'
            ? isMutating
            : Boolean(pendingMeta?.isMutating);

        const isTimedOut = Boolean(timedOut);
        const effectiveOk = isTimedOut ? false : Boolean(ok);

        if (sig) {
            executedSignatures.add(sig);
        }

        let formattedTimeout = null;
        if (isTimedOut) {
            const rawStdout = partialStdout !== undefined
                ? partialStdout
                : (stdout !== undefined ? stdout : (typeof result?.stdout === 'string' ? result.stdout : ''));
            const rawStderr = stderr || (typeof result?.stderr === 'string' ? result.stderr : '');
            formattedTimeout = formatTimeoutWithPartialStdout({
                timeoutMs,
                timeoutSeconds,
                stdout: rawStdout,
                stderr: rawStderr,
                maxStdoutChars,
                label: label || pendingMeta?.toolName || 'Sandbox execution'
            });
            stats.timeoutsWithPartialStdout += 1;
        }

        if (effectiveOk) {
            if (sig) {
                failedCallPreviews.delete(sig);
            }
            if (effectiveMutating) {
                stats.committedMutations += 1;
                if (sig) {
                    committedWriteCounts.set(sig, (committedWriteCounts.get(sig) || 0) + 1);
                }
                if (pendingMeta?.targetPath) {
                    mutatedPaths.add(pendingMeta.targetPath);
                    deltaTracker.recordFileDigest(pendingMeta.targetPath, null);
                }
            } else {
                stats.committedReads += 1;
                if (sig) {
                    deltaTracker.recordReadMemo(sig, { preview: String(preview ?? ''), result });
                }
            }

            const deltaNum = Number(pendingDiffsDelta || 0);
            if (Number.isFinite(deltaNum) && deltaNum !== 0) {
                pendingDiffsCount = Math.max(0, pendingDiffsCount + deltaNum);
                if (deltaNum > 0 && typeof verificationPassed !== 'boolean') {
                    latestVerificationPassed = false;
                }
            }
        } else if (sig) {
            const failPreview = String(preview || formattedTimeout?.formattedObservation || '');
            failedCallPreviews.set(sig, {
                preview: failPreview,
                result: formattedTimeout ?? result,
                timedOut: isTimedOut
            });
        }

        if (typeof verificationPassed === 'boolean') {
            latestVerificationPassed = verificationPassed;
            if (verificationPassed) {
                diffVerifyRetriesUsed = 0;
            }
        }

        if (isTimedOut && formattedTimeout) {
            return okEnvelope(
                'grounded.outcome',
                `Recorded timed-out tool outcome with partial stdout for "${sig}".`,
                {
                    callSignature: sig,
                    ok: false,
                    isMutating: effectiveMutating,
                    timedOut: true,
                    hasFinalAnswer: false,
                    finalAnswer: null,
                    preservedStdout: formattedTimeout.stdout,
                    formattedObservation: formattedTimeout.formattedObservation,
                    error: formattedTimeout.error,
                    committedReads: stats.committedReads,
                    committedMutations: stats.committedMutations,
                    pendingDiffsCount,
                    latestVerificationPassed
                }
            );
        }

        return okEnvelope(
            'grounded.outcome',
            effectiveOk
                ? `Recorded ${effectiveMutating ? 'mutating' : 'read'} outcome for "${sig}".`
                : `Recorded failed tool outcome for "${sig}".`,
            {
                callSignature: sig,
                ok: effectiveOk,
                isMutating: effectiveMutating,
                timedOut: false,
                committedReads: stats.committedReads,
                committedMutations: stats.committedMutations,
                pendingDiffsCount,
                latestVerificationPassed
            }
        );
    }

    function verifyStop(turnState = {}) {
        const activeToolCalls = Array.isArray(turnState?.toolCalls)
            ? turnState.toolCalls
            : (Array.isArray(turnState?.tool_calls) ? turnState.tool_calls : []);

        if (turnState?.stopRequested === false && activeToolCalls.length > 0) {
            return okEnvelope(
                'grounded.verify_stop',
                'Turn has active tool calls; continuing normal execution.',
                {
                    allowStop: false,
                    action: 'CONTINUE_NORMAL',
                    reason: 'Active tool calls in turn.',
                    correctivePrompt: null,
                    rescuedToolCalls: [],
                    pendingDiffsCount,
                    latestVerificationPassed,
                    verifyNudgesUsed: stats.verifyNudgesUsed
                }
            );
        }

        const effPendingDiffs = turnState?.pendingDiffsCount !== undefined
            ? Math.max(0, Number(turnState.pendingDiffsCount) || 0)
            : pendingDiffsCount;
        const effVerificationPassed = turnState?.latestVerificationPassed !== undefined
            ? Boolean(turnState.latestVerificationPassed)
            : latestVerificationPassed;
        const effVerificationCmd = turnState?.verificationCommand ?? verificationCommand;
        const effMaxRetries = Number.isFinite(turnState?.maxVerifyRetries)
            ? turnState.maxVerifyRetries
            : maxVerifyRetries;

        // 1. Staged-diff outer verification ONLY when pendingDiffsCount > 0 && !latestVerificationPassed
        if (effPendingDiffs > 0 && !effVerificationPassed) {
            const diffGuard = evaluateVerifyOnStopGuard({
                stopRequested: true,
                pendingDiffsCount: effPendingDiffs,
                mutatedFilesCount: 0,
                latestVerificationPassed: false,
                verificationCommand: effVerificationCmd,
                verifyRetries: diffVerifyRetriesUsed,
                maxVerifyRetries: effMaxRetries
            });
            if (diffGuard.action === 'FORCE_VERIFY') {
                diffVerifyRetriesUsed += 1;
                stats.verifyNudgesUsed += 1;
            }
            return okEnvelope(
                'grounded.verify_stop',
                diffGuard.reason,
                {
                    allowStop: diffGuard.allowStop,
                    action: diffGuard.action,
                    reason: diffGuard.reason,
                    correctivePrompt: diffGuard.correctivePrompt,
                    rescuedToolCalls: [],
                    pendingDiffsCount: effPendingDiffs,
                    latestVerificationPassed: false,
                    verifyNudgesUsed: stats.verifyNudgesUsed
                }
            );
        }

        const assistantText = String(
            turnState?.assistantText ?? turnState?.content ?? turnState?.text ?? turnState?.finalText ?? ''
        );
        const isPolicyAbstention = Boolean(
            turnState?.isPolicyAbstention === true ||
            turnState?.policyAbstention === true ||
            POLICY_ABSTENTION_RE.test(assistantText)
        );

        // 2. Zero-turn-when-healthy objective output defect gate (INV-GH-05)
        const defectGateEnabled = turnState?.enableOutputDefectGate !== undefined
            ? turnState.enableOutputDefectGate !== false
            : enableOutputDefectGate !== false;

        if (defectGateEnabled && activeToolCalls.length === 0) {
            const finishReason = turnState?.finishReason ?? turnState?.stopReason ?? turnState?.finish_reason ?? turnState?.stop_reason ?? null;
            const normFinish = String(finishReason ?? '').trim().toUpperCase();
            const defectReport = inspectOutputDefects({
                ...(Object.hasOwn(turnState || {}, 'candidateAnswer') ? { candidateAnswer: turnState.candidateAnswer } : {}),
                ...(Object.hasOwn(turnState || {}, 'hasFinalAnswer') ? { hasFinalAnswer: turnState.hasFinalAnswer } : {}),
                assistantText,
                finishReason,
                stopReason: turnState?.stopReason ?? turnState?.stop_reason ?? null,
                truncatedToolCalls: Boolean(turnState?.truncatedToolCalls),
                toolCalls: activeToolCalls,
                expectNonEmptyAnswer: Boolean(turnState?.expectNonEmptyAnswer)
            });

            const effectiveDefects = isPolicyAbstention
                ? defectReport.defects.filter((d) => d.code !== 'EMPTY_OR_NULL_BAILOUT')
                : defectReport.defects;

            if (effectiveDefects.length > 0) {
                const topDefect = effectiveDefects[0];
                if (topDefect.code === 'SERIALIZED_TOOL_CALL_IN_TEXT' && serializedRescueCount < 1) {
                    serializedRescueCount += 1;
                    stats.outputDefectsCaught += 1;
                    stats.verifyNudgesUsed += 1;
                    const reason = 'Rescued plain-text serialized <tool_call> output; requesting native structured tool invocation.';
                    return okEnvelope(
                        'grounded.verify_stop',
                        reason,
                        {
                            allowStop: false,
                            action: 'RESCUE_SERIALIZED_TOOL_CALL',
                            defectCode: 'SERIALIZED_TOOL_CALL_IN_TEXT',
                            defects: effectiveDefects,
                            reason,
                            correctivePrompt: buildDefectCorrectivePrompt('SERIALIZED_TOOL_CALL_IN_TEXT', normFinish),
                            rescuedToolCalls: defectReport.rescuedToolCalls,
                            pendingDiffsCount: effPendingDiffs,
                            latestVerificationPassed: effVerificationPassed,
                            verifyNudgesUsed: stats.verifyNudgesUsed
                        }
                    );
                }

                const rejectionDefect = effectiveDefects.find((d) => d.code !== 'SERIALIZED_TOOL_CALL_IN_TEXT') || null;
                const effMaxDefectRetries = Number.isInteger(turnState?.maxDefectRetries) && turnState.maxDefectRetries >= 0
                    ? turnState.maxDefectRetries
                    : maxDefectRetries;

                if (rejectionDefect && defectRetriesUsed < effMaxDefectRetries) {
                    defectRetriesUsed += 1;
                    stats.outputDefectsCaught += 1;
                    stats.verifyNudgesUsed += 1;
                    const prompt = rejectionDefect.code === defectReport.primaryDefect?.code
                        ? defectReport.correctivePrompt
                        : buildDefectCorrectivePrompt(rejectionDefect.code, normFinish);
                    return okEnvelope(
                        'grounded.verify_stop',
                        rejectionDefect.message,
                        {
                            allowStop: false,
                            action: 'REJECT_OUTPUT_DEFECT',
                            defectCode: rejectionDefect.code,
                            defects: effectiveDefects,
                            reason: rejectionDefect.message,
                            correctivePrompt: prompt,
                            rescuedToolCalls: defectReport.rescuedToolCalls,
                            pendingDiffsCount: effPendingDiffs,
                            latestVerificationPassed: effVerificationPassed,
                            verifyNudgesUsed: stats.verifyNudgesUsed
                        }
                    );
                }
            }
        }

        // 3. Respect valid policy abstentions immediately (never nudge refusals)
        if (isPolicyAbstention) {
            return okEnvelope(
                'grounded.verify_stop',
                'Stop permitted immediately on policy abstention.',
                {
                    allowStop: true,
                    action: 'ALLOW_STOP',
                    reason: 'Policy abstention respected with zero outer-loop nudges.',
                    correctivePrompt: null,
                    rescuedToolCalls: [],
                    isPolicyAbstention: true,
                    pendingDiffsCount: effPendingDiffs,
                    latestVerificationPassed: effVerificationPassed,
                    verifyNudgesUsed: stats.verifyNudgesUsed
                }
            );
        }

        // 4. SMALL_MODEL-only single rescue for uncommitted outbound drafts
        const effMutations = turnState?.committedMutations !== undefined
            ? Number(turnState.committedMutations)
            : stats.committedMutations;
        if (
            scaleProfile.tier === SCALE_TIERS.SMALL_MODEL &&
            scaleProfile.maxMechanicalVerifyNudges > 0 &&
            draftRescueCount < scaleProfile.maxMechanicalVerifyNudges &&
            activeToolCalls.length === 0 &&
            effMutations === 0 &&
            detectUncommittedOutboundDraft(assistantText, turnState)
        ) {
            draftRescueCount += 1;
            stats.verifyNudgesUsed += 1;
            const reason = 'Small model emitted an uncommitted outbound draft with zero committed mutations; issuing single rescue nudge.';
            return okEnvelope(
                'grounded.verify_stop',
                reason,
                {
                    allowStop: false,
                    action: 'RESCUE_UNCOMMITTED_DRAFT',
                    reason,
                    correctivePrompt: 'You wrote an outbound draft in prose without calling the action tool. Invoke the appropriate tool now with bound arguments to complete the request.',
                    rescuedToolCalls: [],
                    pendingDiffsCount: effPendingDiffs,
                    latestVerificationPassed: effVerificationPassed,
                    verifyNudgesUsed: stats.verifyNudgesUsed
                }
            );
        }

        // 5. Default 0-nudge immediate stop (INV-GH-05, INV-GH-08)
        return okEnvelope(
            'grounded.verify_stop',
            'Stop permitted (0 extra verification turns required).',
            {
                allowStop: true,
                action: 'ALLOW_STOP',
                reason: 'Completion permitted with zero outer-loop nagging.',
                correctivePrompt: null,
                rescuedToolCalls: [],
                pendingDiffsCount: effPendingDiffs,
                latestVerificationPassed: effVerificationPassed,
                verifyNudgesUsed: stats.verifyNudgesUsed
            }
        );
    }

    function getStats() {
        return {
            scaleTier: scaleProfile.tier,
            model: scaleProfile.model,
            schemaSavings: toolGate.savings,
            deltaMetrics: deltaTracker.getMetrics(),
            committedReads: stats.committedReads,
            committedMutations: stats.committedMutations,
            spinLoopsBlocked: stats.spinLoopsBlocked,
            outputDefectsCaught: stats.outputDefectsCaught,
            timeoutsWithPartialStdout: stats.timeoutsWithPartialStdout,
            duplicateWritesBlocked: stats.duplicateWritesBlocked,
            policyFloorBlocks: stats.policyFloorBlocks,
            secretLeaksBlocked: stats.secretLeaksBlocked,
            softHoldsTriggered: stats.softHoldsTriggered,
            truncationRecoveries: stats.truncationRecoveries,
            verifyNudgesUsed: stats.verifyNudgesUsed,
            pendingDiffsCount,
            latestVerificationPassed
        };
    }

    return {
        scaleProfile,
        toolGate,
        deltaTracker,
        compilePrompt,
        evaluateTurn,
        interceptToolCall,
        recordToolOutcome,
        verifyStop,
        getStats
    };
}
