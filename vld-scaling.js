/**
 * @module vld-scaling
 * @description Virtual Logical Depth (VLD) Scaling Law & Recursive Computation Graph Engine
 * based on:
 * "Beyond Parameters: Exploring Virtual Logic Depth for Scaling Laws"
 * (arXiv: 2506.18233v3 — Zhu, Zhang, Li, Shi, Duan, Wang, Zhou, Banerjee, Qin).
 *
 * Core Principles:
 * 1. The 4th Scaling Dimension: Increases effective algorithmic depth (D_eff = L_base + VLD)
 *    by reusing base layer parameters in Sequence, Cycle, Inverse Cycle, or Late-Layer Cycle
 *    schedules without increasing parameter count.
 * 2. Knowledge Capacity Invariance: Factual/memorization capacity scales linearly with parameter
 *    count (~2 bits/param, Delta H = H1 - H2) and remains invariant under VLD scaling.
 * 3. Reasoning Decoupling: Multi-step reasoning accuracy (e.g., iGSM op15/op20/op21, Math500,
 *    AIME, GPQA, HumanEval, MBPP) improves substantially with Cycle and Late-Layer Cycle VLD,
 *    enabling smaller models to surpass 3x larger baselines.
 * 4. Non-Monotonic Fixed-Point Guard: Detects non-monotonic regressions (e.g., depth-32 cliff
 *    or factor-3 plateau) and halts recursive passes once a latent fixed point is reached.
 */

export const VLD_PATTERNS = Object.freeze({
    NONE: 'none',
    SEQUENCE: 'sequence',
    CYCLE: 'cycle',
    INVERSE_CYCLE: 'inverse_cycle',
    LATE_CYCLE: 'late_cycle'
});

export const DEFAULT_VOCAB_SIZE = 50257;
export const THEORETICAL_BITS_PER_PARAM = 2.0;
export const DEFAULT_ID_OP_CEILING = 15;

/**
 * Compiles a layer execution schedule for a given base layer count/array and VLD pattern.
 *
 * In the paper's notation (Section 3 & Table 1):
 * - Base model (no VLD) has vldFactor = 0 -> effectiveDepth = L_base, VLD = 0.
 * - VLD Depth xk (vldFactor = k >= 1) adds k virtual repetitions of the base block,
 *   yielding total repetitions = 1 + k, effectiveDepth = L_base * (1 + k) for full-layer
 *   patterns, and VLD = effectiveDepth - L_base.
 *
 * @param {number|Array<any>} baseLayers - Number of base layers or array of layer descriptors.
 * @param {Object} [options={}]
 * @param {string} [options.pattern=VLD_PATTERNS.CYCLE] - Reuse schedule pattern.
 * @param {number} [options.vldFactor=1] - Virtual repetition factor k (0 = no VLD).
 * @param {number} [options.lateStartRatio=0.5] - Fraction of early layers kept unrepeated in LATE_CYCLE (Appendix H.1: layers 5-8 on 8-layer model).
 * @returns {{
 *   pattern: string,
 *   baseLayerCount: number,
 *   vldFactor: number,
 *   effectiveDepth: number,
 *   virtualLogicalDepth: number,
 *   parameterMultiplier: number,
 *   schedule: Array<any>,
 *   layerStepMetadata: Array<{
 *     stepIndex: number,
 *     baseLayerIndex: number,
 *     descriptor: any,
 *     passNumber: number,
 *     isVirtualLayer: boolean,
 *     direction: 'forward'|'reverse'
 *   }>
 * }}
 */
export function compileVldSchedule(baseLayers, options = {}) {
    const descriptors = Array.isArray(baseLayers)
        ? [...baseLayers]
        : Array.from({ length: Math.max(1, Math.floor(Number(baseLayers) || 1)) }, (_, idx) => idx);

    const baseLayerCount = descriptors.length;
    if (baseLayerCount === 0) {
        throw new Error('[VLD] baseLayers must contain at least 1 base layer.');
    }

    const pattern = options.pattern || VLD_PATTERNS.CYCLE;
    const validPatterns = Object.values(VLD_PATTERNS);
    if (!validPatterns.includes(pattern)) {
        throw new Error(`[VLD] Unknown pattern "${pattern}". Valid patterns: ${validPatterns.join(', ')}`);
    }

    const vldFactor = Math.max(0, Math.floor(Number(options.vldFactor ?? 1)));
    const totalPasses = pattern === VLD_PATTERNS.NONE ? 1 : 1 + vldFactor;

    const layerStepMetadata = [];
    let stepIndex = 0;

    if (pattern === VLD_PATTERNS.NONE || vldFactor === 0) {
        for (let i = 0; i < baseLayerCount; i++) {
            layerStepMetadata.push({
                stepIndex: stepIndex++,
                baseLayerIndex: i,
                descriptor: descriptors[i],
                passNumber: 1,
                isVirtualLayer: false,
                direction: 'forward'
            });
        }
    } else if (pattern === VLD_PATTERNS.SEQUENCE) {
        // Adjacent sharing: [L0, L0, ..., L1, L1, ..., Ln, Ln]
        for (let i = 0; i < baseLayerCount; i++) {
            for (let pass = 1; pass <= totalPasses; pass++) {
                layerStepMetadata.push({
                    stepIndex: stepIndex++,
                    baseLayerIndex: i,
                    descriptor: descriptors[i],
                    passNumber: pass,
                    isVirtualLayer: pass > 1,
                    direction: 'forward'
                });
            }
        }
    } else if (pattern === VLD_PATTERNS.CYCLE) {
        // Periodic block sharing: [L0..Ln, L0..Ln, ...]
        for (let pass = 1; pass <= totalPasses; pass++) {
            for (let i = 0; i < baseLayerCount; i++) {
                layerStepMetadata.push({
                    stepIndex: stepIndex++,
                    baseLayerIndex: i,
                    descriptor: descriptors[i],
                    passNumber: pass,
                    isVirtualLayer: pass > 1,
                    direction: 'forward'
                });
            }
        }
    } else if (pattern === VLD_PATTERNS.INVERSE_CYCLE) {
        // Alternating forward and reversed block sharing: [L0..Ln, Ln..L0, ...]
        for (let pass = 1; pass <= totalPasses; pass++) {
            const isReverse = pass % 2 === 0;
            const indices = Array.from({ length: baseLayerCount }, (_, idx) =>
                isReverse ? baseLayerCount - 1 - idx : idx
            );
            for (const i of indices) {
                layerStepMetadata.push({
                    stepIndex: stepIndex++,
                    baseLayerIndex: i,
                    descriptor: descriptors[i],
                    passNumber: pass,
                    isVirtualLayer: pass > 1,
                    direction: isReverse ? 'reverse' : 'forward'
                });
            }
        }
    } else if (pattern === VLD_PATTERNS.LATE_CYCLE) {
        // Appendix H.1: Execute early layers once, then cycle upper layers (1 + vldFactor) times
        const ratio = Math.min(0.9, Math.max(0.1, Number(options.lateStartRatio ?? 0.5)));
        const splitIndex = Math.max(1, Math.min(baseLayerCount - 1, Math.floor(baseLayerCount * ratio)));

        // Early layers (single pass)
        for (let i = 0; i < splitIndex; i++) {
            layerStepMetadata.push({
                stepIndex: stepIndex++,
                baseLayerIndex: i,
                descriptor: descriptors[i],
                passNumber: 1,
                isVirtualLayer: false,
                direction: 'forward'
            });
        }

        // Late layers (repeated totalPasses times in cycle order)
        for (let pass = 1; pass <= totalPasses; pass++) {
            for (let i = splitIndex; i < baseLayerCount; i++) {
                layerStepMetadata.push({
                    stepIndex: stepIndex++,
                    baseLayerIndex: i,
                    descriptor: descriptors[i],
                    passNumber: pass,
                    isVirtualLayer: pass > 1,
                    direction: 'forward'
                });
            }
        }
    }

    const schedule = layerStepMetadata.map(item => item.descriptor);
    const effectiveDepth = layerStepMetadata.length;
    const virtualLogicalDepth = effectiveDepth - baseLayerCount;

    return {
        pattern,
        baseLayerCount,
        vldFactor: pattern === VLD_PATTERNS.NONE ? 0 : vldFactor,
        effectiveDepth,
        virtualLogicalDepth,
        parameterMultiplier: 1.0,
        schedule,
        layerStepMetadata
    };
}

/**
 * Calculates information-theoretic knowledge capacity (Delta H = H1 - H2) in bits
 * per Section 3.1 and Appendix G.1 of arXiv:2506.18233v3.
 *
 * @param {Object} params
 * @param {number} [params.sequenceLength=640000] - Number of IID random tokens k.
 * @param {number} [params.vocabSize=DEFAULT_VOCAB_SIZE] - Tokenizer vocabulary size n (default 50,257).
 * @param {number} [params.parameterCount=5000000] - Total unique model parameters P.
 * @param {number} [params.residualEntropyBits] - Total residual softmax entropy H2 across sequence (in bits).
 * @param {number} [params.meanTokenResidualEntropyBits] - Mean residual softmax entropy per token (H2 / k).
 * @param {Array<Array<number>>} [params.softmaxDistributions] - Optional sample of token probability distributions p_j(x_i) to compute H2 directly.
 * @returns {{
 *   datasetEntropyBits: number,
 *   residualEntropyBits: number,
 *   absorbedEntropyBits: number,
 *   maxTokenEntropyBits: number,
 *   meanAbsorbedBitsPerToken: number,
 *   bitsPerParameter: number,
 *   theoreticalCapacityBits: number,
 *   capacityUtilization: number
 * }}
 */
export function calculateKnowledgeCapacityEntropy(params = {}) {
    const vocabSize = Math.max(2, Math.floor(Number(params.vocabSize ?? DEFAULT_VOCAB_SIZE)));
    const maxTokenEntropyBits = Math.log2(vocabSize);

    let sequenceLength = Math.max(1, Math.floor(Number(params.sequenceLength ?? 640000)));
    const parameterCount = Math.max(1, Number(params.parameterCount ?? 5_000_000));

    let residualEntropyBits;

    if (Array.isArray(params.softmaxDistributions) && params.softmaxDistributions.length > 0) {
        sequenceLength = params.softmaxDistributions.length;
        let h2Sum = 0;
        for (const dist of params.softmaxDistributions) {
            if (!Array.isArray(dist)) continue;
            for (const p of dist) {
                if (p > 0) {
                    h2Sum += -p * Math.log2(p);
                }
            }
        }
        residualEntropyBits = h2Sum;
    } else if (typeof params.residualEntropyBits === 'number') {
        residualEntropyBits = Math.max(0, params.residualEntropyBits);
    } else if (typeof params.meanTokenResidualEntropyBits === 'number') {
        residualEntropyBits = Math.max(0, params.meanTokenResidualEntropyBits * sequenceLength);
    } else {
        // Default to unmemorized uniform output H2 = H1
        residualEntropyBits = sequenceLength * maxTokenEntropyBits;
    }

    const datasetEntropyBits = sequenceLength * maxTokenEntropyBits;
    const clampedResidual = Math.min(datasetEntropyBits, Math.max(0, residualEntropyBits));
    const absorbedEntropyBits = Math.max(0, datasetEntropyBits - clampedResidual);
    const meanAbsorbedBitsPerToken = absorbedEntropyBits / sequenceLength;
    const bitsPerParameter = absorbedEntropyBits / parameterCount;
    const theoreticalCapacityBits = parameterCount * THEORETICAL_BITS_PER_PARAM;
    const capacityUtilization = Math.min(1.5, Number((bitsPerParameter / THEORETICAL_BITS_PER_PARAM).toFixed(4)));

    return {
        datasetEntropyBits: Number(datasetEntropyBits.toFixed(2)),
        residualEntropyBits: Number(clampedResidual.toFixed(2)),
        absorbedEntropyBits: Number(absorbedEntropyBits.toFixed(2)),
        maxTokenEntropyBits: Number(maxTokenEntropyBits.toFixed(4)),
        meanAbsorbedBitsPerToken: Number(meanAbsorbedBitsPerToken.toFixed(4)),
        bitsPerParameter: Number(bitsPerParameter.toFixed(4)),
        theoreticalCapacityBits: Number(theoreticalCapacityBits.toFixed(2)),
        capacityUtilization
    };
}

/**
 * Verifies Secondary Finding 2: Knowledge capacity remains nearly constant under VLD scaling
 * when holding unique parameter count fixed.
 *
 * @param {number} baselineAbsorbedBits - Absorbed entropy Delta H of the base model (VLD = 0).
 * @param {Array<number>} vldAbsorbedBitsList - Absorbed entropy Delta H across VLD factors (e.g. x1, x2, x3).
 * @param {number} [maxRelativeDrift=0.06] - Maximum allowed relative variation (default 6%).
 * @returns {{
 *   invariantHolds: boolean,
 *   maxObservedDrift: number,
 *   meanAbsorbedBits: number,
 *   coefficientOfVariation: number
 * }}
 */
export function verifyVldCapacityInvariance(baselineAbsorbedBits, vldAbsorbedBitsList = [], maxRelativeDrift = 0.06) {
    const base = Number(baselineAbsorbedBits);
    if (!Number.isFinite(base) || base <= 0) {
        throw new Error('[VLD] baselineAbsorbedBits must be a positive number.');
    }

    const allSamples = [base, ...vldAbsorbedBitsList.map(Number).filter(Number.isFinite)];
    const mean = allSamples.reduce((acc, v) => acc + v, 0) / allSamples.length;
    const variance = allSamples.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / allSamples.length;
    const stdDev = Math.sqrt(variance);
    const coefficientOfVariation = mean > 0 ? stdDev / mean : 0;

    let maxObservedDrift = 0;
    for (const val of vldAbsorbedBitsList) {
        const drift = Math.abs(Number(val) - base) / base;
        if (drift > maxObservedDrift) {
            maxObservedDrift = drift;
        }
    }

    return {
        invariantHolds: maxObservedDrift <= maxRelativeDrift,
        maxObservedDrift: Number(maxObservedDrift.toFixed(4)),
        meanAbsorbedBits: Number(mean.toFixed(2)),
        coefficientOfVariation: Number(coefficientOfVariation.toFixed(4))
    };
}

/**
 * Estimates the operational dependency depth ("opN" in iGSM terms) of a task or prompt
 * and recommends the optimal VLD pattern and repetition factor without hitting
 * non-monotonic over-depth bottlenecks.
 *
 * @param {string|Object} taskInput - Problem prompt or structured task `{ text, operations, edges, baseLayers }`.
 * @param {Object} [options={}]
 * @param {number} [options.baseLayers=4] - Native layer or stage count of the target model/pipeline.
 * @param {number} [options.idOpCeiling=DEFAULT_ID_OP_CEILING] - Max operations seen during training (default 15).
 * @returns {{
 *   estimatedOperations: number,
 *   distributionRegime: 'factual_lookup'|'in_distribution'|'ood_moderate'|'ood_extreme',
 *   isKnowledgeBound: boolean,
 *   recommendedPattern: string,
 *   recommendedVldFactor: number,
 *   effectiveDepth: number,
 *   rationale: string
 * }}
 */
export function estimateReasoningDepth(taskInput, options = {}) {
    const baseLayers = Math.max(1, Math.floor(Number(options.baseLayers ?? 4)));
    const idOpCeiling = Math.max(1, Math.floor(Number(options.idOpCeiling ?? DEFAULT_ID_OP_CEILING)));

    let text = '';
    let explicitOps = null;
    let explicitEdges = 0;

    if (typeof taskInput === 'string') {
        text = taskInput;
    } else if (taskInput && typeof taskInput === 'object') {
        text = String(taskInput.text || taskInput.prompt || '');
        if (typeof taskInput.operations === 'number') {
            explicitOps = taskInput.operations;
        }
        if (typeof taskInput.edges === 'number') {
            explicitEdges = taskInput.edges;
        }
    }

    // Detect pure factual/memorization lookup vs multi-step reasoning
    const lower = text.toLowerCase();
    const reasoningIndicators = (text.match(/\b(equals|times as much|sum of|difference of|more than|less than|infer|derive|prove|step-by-step|implement|refactor|algorithm|system of equations|log_2|function|return|while|for)\b/gi) || []).length;
    const mathExpressions = (text.match(/[=+\-*/^]|\\frac|\\log|\bmod\b/g) || []).length;
    const clauseCount = (text.split(/[.?;!\n]+/).filter(s => s.trim().length > 10)).length;
    const factualLookupMatch = /^(what is the capital|who invented|when was|define |what port does|list the )/i.test(lower.trim()) && reasoningIndicators <= 1 && mathExpressions === 0;

    let estimatedOperations;
    if (explicitOps !== null) {
        estimatedOperations = Math.max(0, Math.floor(explicitOps));
    } else if (factualLookupMatch) {
        estimatedOperations = 1;
    } else {
        estimatedOperations = Math.max(
            1,
            Math.round(reasoningIndicators * 0.8 + mathExpressions * 0.6 + Math.max(0, clauseCount - 1) * 0.9 + explicitEdges * 0.25)
        );
    }

    const isKnowledgeBound = estimatedOperations <= 2 && factualLookupMatch;

    let distributionRegime = 'in_distribution';
    if (isKnowledgeBound) {
        distributionRegime = 'factual_lookup';
    } else if (estimatedOperations > idOpCeiling + 5) {
        distributionRegime = 'ood_extreme';
    } else if (estimatedOperations > idOpCeiling) {
        distributionRegime = 'ood_moderate';
    }

    // Recommend VLD pattern and factor while respecting Discussion 2 (non-monotonic dip at x3 and depth >= 32 cliff)
    let recommendedPattern = VLD_PATTERNS.CYCLE;
    let recommendedVldFactor = 0;

    if (isKnowledgeBound) {
        recommendedPattern = VLD_PATTERNS.NONE;
        recommendedVldFactor = 0;
    } else if (baseLayers >= 8) {
        // Appendix H.1: For >= 8 base layers, Late-Layer Cycle (layers 5-8) beats full-layer VLD
        // while avoiding the effectiveDepth >= 32 regression cliff noted in Discussion 2.
        recommendedPattern = estimatedOperations <= idOpCeiling ? VLD_PATTERNS.LATE_CYCLE : VLD_PATTERNS.CYCLE;
        if (estimatedOperations <= 6) {
            recommendedVldFactor = 1;
        } else if (estimatedOperations <= idOpCeiling) {
            recommendedVldFactor = 2;
        } else {
            // Note: Table 1 shows x3 dips slightly (61.0% vs 63.3% at x2), whereas x4 reaches 66.8%
            recommendedVldFactor = 4;
        }
    } else {
        // 4-layer regime (Table 1):
        // x1 -> 54.9%, x2 -> 62.1%, x3 -> 61.6% (non-monotonic plateau), x4 -> 65.7%, x5 -> 70.7%
        recommendedPattern = VLD_PATTERNS.CYCLE;
        if (estimatedOperations <= 5) {
            recommendedVldFactor = 1;
        } else if (estimatedOperations <= 12) {
            recommendedVldFactor = 2;
        } else if (estimatedOperations <= idOpCeiling) {
            recommendedVldFactor = 4; // Skip x3 non-monotonic plateau
        } else {
            recommendedVldFactor = 5; // OOD op20/op21 peak (43.8% / 40.2% vs 21.8% / 21.2% base)
        }
    }

    const scheduleInfo = compileVldSchedule(baseLayers, {
        pattern: recommendedPattern,
        vldFactor: recommendedVldFactor
    });

    const rationale = isKnowledgeBound
        ? 'Task is knowledge-capacity bound (~2 bits/param); VLD does not expand factual storage — route to RAG/MCP retrieval.'
        : `Estimated ${estimatedOperations} operational steps (${distributionRegime}); scheduled ${recommendedPattern} x${recommendedVldFactor} (effective depth ${scheduleInfo.effectiveDepth}, VLD +${scheduleInfo.virtualLogicalDepth}) avoiding non-monotonic plateau zones.`;

    return {
        estimatedOperations,
        distributionRegime,
        isKnowledgeBound,
        recommendedPattern,
        recommendedVldFactor,
        effectiveDepth: scheduleInfo.effectiveDepth,
        rationale
    };
}

/**
 * Analyzes a sequence of VLD depth evaluations or iterative latent states to detect
 * non-monotonic scaling regressions and fixed-point convergence (Discussion 2 & Appendix I).
 *
 * @param {Array<Object>} depthHistory - Ordered array of `{ vldFactor, effectiveDepth, score, stateSignature, residualDelta }`.
 * @param {Object} [options={}]
 * @param {number} [options.convergenceEpsilon=0.005] - Threshold on residualDelta or score delta for fixed-point halting.
 * @param {number} [options.regressionTolerance=0.003] - Drop threshold that flags a non-monotonic dip.
 * @returns {{
 *   fixedPointReached: boolean,
 *   nonMonotonicDipDetected: boolean,
 *   dipEvents: Array<{ fromFactor: number, toFactor: number, scoreDrop: number }>,
 *   optimalCheckpoint: Object|null,
 *   shouldHalt: boolean,
 *   haltReason: string
 * }}
 */
export function detectVldFixedPoint(depthHistory = [], options = {}) {
    if (!Array.isArray(depthHistory) || depthHistory.length === 0) {
        return {
            fixedPointReached: false,
            nonMonotonicDipDetected: false,
            dipEvents: [],
            optimalCheckpoint: null,
            shouldHalt: false,
            haltReason: 'No depth evaluations recorded.'
        };
    }

    const convergenceEpsilon = Number(options.convergenceEpsilon ?? 0.005);
    const regressionTolerance = Number(options.regressionTolerance ?? 0.003);

    let optimalCheckpoint = depthHistory[0];
    const dipEvents = [];
    let fixedPointReached = false;
    let haltReason = 'Scaling continues monotonically.';

    for (let i = 1; i < depthHistory.length; i++) {
        const prev = depthHistory[i - 1];
        const curr = depthHistory[i];

        if (typeof curr.score === 'number' && typeof optimalCheckpoint.score === 'number') {
            if (curr.score >= optimalCheckpoint.score) {
                optimalCheckpoint = curr;
            }
        } else {
            optimalCheckpoint = curr;
        }

        // Check for non-monotonic regression between consecutive VLD factors
        if (typeof prev.score === 'number' && typeof curr.score === 'number') {
            const drop = prev.score - curr.score;
            if (drop > regressionTolerance) {
                dipEvents.push({
                    fromFactor: prev.vldFactor ?? i - 1,
                    toFactor: curr.vldFactor ?? i,
                    scoreDrop: Number(drop.toFixed(4))
                });
            }
        }

        // Check for latent fixed-point convergence (state signature match or residual delta <= epsilon)
        const sameSignature =
            curr.stateSignature !== undefined &&
            prev.stateSignature !== undefined &&
            String(curr.stateSignature) === String(prev.stateSignature);

        const smallResidual =
            typeof curr.residualDelta === 'number' &&
            curr.residualDelta <= convergenceEpsilon;

        if (sameSignature || smallResidual) {
            fixedPointReached = true;
            haltReason = sameSignature
                ? `Latent fixed point reached at VLD factor ${curr.vldFactor ?? i} (identical state signature).`
                : `Latent fixed point reached at VLD factor ${curr.vldFactor ?? i} (residualDelta ${curr.residualDelta} <= ${convergenceEpsilon}).`;
        }
    }

    const nonMonotonicDipDetected = dipEvents.length > 0;
    const latest = depthHistory[depthHistory.length - 1];
    const twoConsecutiveDrops =
        depthHistory.length >= 3 &&
        typeof latest.score === 'number' &&
        typeof depthHistory[depthHistory.length - 2].score === 'number' &&
        typeof depthHistory[depthHistory.length - 3].score === 'number' &&
        latest.score < depthHistory[depthHistory.length - 2].score - regressionTolerance &&
        depthHistory[depthHistory.length - 2].score < depthHistory[depthHistory.length - 3].score - regressionTolerance;

    const shouldHalt = fixedPointReached || twoConsecutiveDrops;
    if (twoConsecutiveDrops && !fixedPointReached) {
        haltReason = `Non-monotonic degradation across 2 consecutive VLD steps; roll back to optimal factor ${optimalCheckpoint.vldFactor ?? 0}.`;
    }

    return {
        fixedPointReached,
        nonMonotonicDipDetected,
        dipEvents,
        optimalCheckpoint,
        shouldHalt,
        haltReason
    };
}

/**
 * Creates a stateful Virtual Logical Depth (VLD) Scaling Engine that schedules and executes
 * weight-shared reasoning passes with automatic fixed-point halting.
 *
 * @param {Object} [config={}]
 * @param {number} [config.baseLayers=4]
 * @param {string} [config.defaultPattern=VLD_PATTERNS.CYCLE]
 * @param {number} [config.convergenceEpsilon=0.005]
 * @returns {Object} VldScalingEngine instance
 */
export function createVldScalingEngine(config = {}) {
    const defaultBaseLayers = Math.max(1, Math.floor(Number(config.baseLayers ?? 4)));
    const defaultPattern = config.defaultPattern || VLD_PATTERNS.CYCLE;
    const convergenceEpsilon = Number(config.convergenceEpsilon ?? 0.005);

    return {
        compileSchedule(baseLayers = defaultBaseLayers, options = {}) {
            return compileVldSchedule(baseLayers, { pattern: defaultPattern, ...options });
        },

        estimateTaskDepth(taskInput, options = {}) {
            return estimateReasoningDepth(taskInput, { baseLayers: defaultBaseLayers, ...options });
        },

        measureKnowledgeCapacity(params = {}) {
            return calculateKnowledgeCapacityEntropy(params);
        },

        /**
         * Executes an array of base layer/stage transform functions over a compiled VLD schedule
         * with pass-level fixed-point detection.
         *
         * @param {any} initialState - Initial state/context passed into layer 0.
         * @param {Array<Function>} baseLayerFns - Array of functions `(state, stepMeta) => nextState | Promise<nextState>`.
         * @param {Object} [options={}]
         * @param {string} [options.pattern]
         * @param {number} [options.vldFactor]
         * @param {Function} [options.scoreFn] - Optional `(state) => number` quality evaluator per pass.
         * @param {Function} [options.signatureFn] - Optional `(state) => string` signature extractor for fixed-point checks.
         */
        async executeVldPipeline(initialState, baseLayerFns = [], options = {}) {
            if (!Array.isArray(baseLayerFns) || baseLayerFns.length === 0) {
                throw new Error('[VLD] baseLayerFns must be a non-empty array of functions.');
            }

            const pattern = options.pattern || defaultPattern;
            const vldFactor = options.vldFactor ?? 1;
            const compiled = compileVldSchedule(baseLayerFns.length, {
                pattern,
                vldFactor,
                lateStartRatio: options.lateStartRatio
            });

            let currentState = initialState;
            const passHistory = [];
            let stepsExecuted = 0;
            let haltedEarly = false;
            let haltDiagnostics = null;

            const signatureFn =
                typeof options.signatureFn === 'function'
                    ? options.signatureFn
                    : s => (typeof s === 'string' ? s : JSON.stringify(s));

            // Group steps by passNumber so we can check fixed-point convergence at pass boundaries
            const maxPass = compiled.layerStepMetadata.reduce((m, s) => Math.max(m, s.passNumber), 1);

            for (let pass = 1; pass <= maxPass; pass++) {
                const stepsInPass = compiled.layerStepMetadata.filter(s => s.passNumber === pass);
                for (const stepMeta of stepsInPass) {
                    const fn = baseLayerFns[stepMeta.baseLayerIndex];
                    currentState = await fn(currentState, stepMeta);
                    stepsExecuted++;
                }

                const score = typeof options.scoreFn === 'function' ? await options.scoreFn(currentState, pass) : undefined;
                const stateSignature = signatureFn(currentState);

                passHistory.push({
                    passNumber: pass,
                    vldFactor: pass - 1,
                    effectiveDepth: stepsExecuted,
                    score,
                    stateSignature,
                    stateSnapshot: currentState
                });

                if (passHistory.length >= 2) {
                    const fp = detectVldFixedPoint(passHistory, {
                        convergenceEpsilon,
                        regressionTolerance: options.regressionTolerance
                    });
                    if (fp.shouldHalt && pass < maxPass) {
                        haltedEarly = true;
                        haltDiagnostics = fp;
                        if (fp.optimalCheckpoint?.stateSnapshot !== undefined) {
                            currentState = fp.optimalCheckpoint.stateSnapshot;
                        }
                        break;
                    }
                }
            }

            const finalDiagnostics = haltDiagnostics || detectVldFixedPoint(passHistory, {
                convergenceEpsilon,
                regressionTolerance: options.regressionTolerance
            });

            return {
                finalState: currentState,
                pattern: compiled.pattern,
                baseLayerCount: compiled.baseLayerCount,
                configuredVldFactor: compiled.vldFactor,
                plannedEffectiveDepth: compiled.effectiveDepth,
                stepsExecuted,
                haltedEarly,
                passHistory: passHistory.map(({ stateSnapshot, ...rest }) => rest),
                diagnostics: finalDiagnostics
            };
        }
    };
}
