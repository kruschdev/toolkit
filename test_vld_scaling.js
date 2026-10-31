/**
 * Test Suite: Beyond Parameters — Virtual Logical Depth (VLD) Scaling Laws (arXiv: 2506.18233v3)
 * Verifies schedule compilation, information-theoretic knowledge capacity (Delta H = H1 - H2),
 * operational reasoning depth estimation (iGSM op15/op20/op21), and non-monotonic fixed-point halting.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    VLD_PATTERNS,
    compileVldSchedule,
    calculateKnowledgeCapacityEntropy,
    verifyVldCapacityInvariance,
    estimateReasoningDepth,
    detectVldFixedPoint,
    createVldScalingEngine
} from './index.js';

test('VLD Schedule Compilation: Sequence, Cycle, Inverse Cycle, and Late-Layer Cycle (Section 3 & Appendix H.1)', () => {
    // Figure 2: 3 base layers, VLD factor 1 -> effectiveDepth = 6, VLD = 3
    const seq = compileVldSchedule(['L1', 'L2', 'L3'], { pattern: VLD_PATTERNS.SEQUENCE, vldFactor: 1 });
    assert.equal(seq.baseLayerCount, 3);
    assert.equal(seq.effectiveDepth, 6);
    assert.equal(seq.virtualLogicalDepth, 3);
    assert.equal(seq.parameterMultiplier, 1.0);
    assert.deepEqual(seq.schedule, ['L1', 'L1', 'L2', 'L2', 'L3', 'L3']);

    const cyc = compileVldSchedule(['L1', 'L2', 'L3'], { pattern: VLD_PATTERNS.CYCLE, vldFactor: 1 });
    assert.deepEqual(cyc.schedule, ['L1', 'L2', 'L3', 'L1', 'L2', 'L3']);
    assert.equal(cyc.virtualLogicalDepth, 3);

    const inv = compileVldSchedule(['L1', 'L2', 'L3'], { pattern: VLD_PATTERNS.INVERSE_CYCLE, vldFactor: 1 });
    assert.deepEqual(inv.schedule, ['L1', 'L2', 'L3', 'L3', 'L2', 'L1']);
    assert.equal(inv.layerStepMetadata[3].direction, 'reverse');

    // Table 1: 4 base layers, Cycle x5 -> effectiveDepth = 24, VLD = 20
    const cyc5 = compileVldSchedule(4, { pattern: VLD_PATTERNS.CYCLE, vldFactor: 5 });
    assert.equal(cyc5.effectiveDepth, 24);
    assert.equal(cyc5.virtualLogicalDepth, 20);

    // Appendix H.1 (Table 7): 8-layer model with Late-Layer Cycle (layers 5-8 repeated)
    const late8 = compileVldSchedule([1, 2, 3, 4, 5, 6, 7, 8], {
        pattern: VLD_PATTERNS.LATE_CYCLE,
        vldFactor: 1,
        lateStartRatio: 0.5
    });
    assert.deepEqual(late8.schedule, [1, 2, 3, 4, 5, 6, 7, 8, 5, 6, 7, 8]);
    assert.equal(late8.effectiveDepth, 12);
    assert.equal(late8.virtualLogicalDepth, 4);
});

test('Knowledge Capacity Measurement (Delta H = H1 - H2) & VLD Capacity Invariance (Section 3.1 & Secondary Finding 2)', () => {
    // 5M parameter model, k = 640,000 tokens, vocab n = 50,257 (~15.617 bits/token, ~10M total bits)
    const cap5M = calculateKnowledgeCapacityEntropy({
        sequenceLength: 640000,
        vocabSize: 50257,
        parameterCount: 5_000_000,
        residualEntropyBits: 495_000 // ~9.5M bits absorbed (~1.9 bits/param)
    });

    assert.ok(cap5M.datasetEntropyBits > 9_990_000 && cap5M.datasetEntropyBits < 10_000_000);
    assert.ok(cap5M.absorbedEntropyBits > 9_490_000);
    assert.ok(cap5M.bitsPerParameter > 1.85 && cap5M.bitsPerParameter <= 2.0);
    assert.ok(cap5M.capacityUtilization > 0.9);

    // Direct softmax distribution entropy test: 2 tokens over vocab size 4 (max 2 bits/token = 4 bits total)
    const exactCap = calculateKnowledgeCapacityEntropy({
        vocabSize: 4,
        parameterCount: 10,
        softmaxDistributions: [
            [1, 0, 0, 0], // H = 0 bits (perfectly memorized)
            [0.5, 0.5, 0, 0] // H = 1 bit (half memorized)
        ]
    });
    assert.equal(exactCap.datasetEntropyBits, 4.0);
    assert.equal(exactCap.residualEntropyBits, 1.0);
    assert.equal(exactCap.absorbedEntropyBits, 3.0);

    // Secondary Finding 2: VLD scaling leaves absorbed knowledge entropy invariant within small variance
    const invariance = verifyVldCapacityInvariance(
        9_500_000,
        [9_480_000, 9_540_000, 9_515_000],
        0.05
    );
    assert.equal(invariance.invariantHolds, true);
    assert.ok(invariance.maxObservedDrift < 0.01);
});

test('Operational Reasoning Depth Estimator: Factual Lookup vs In-Distribution (op15) vs OOD (op20/op21)', () => {
    // 1. Pure factual lookup -> knowledge bound, VLD = 0
    const factual = estimateReasoningDepth('What is the capital of France?');
    assert.equal(factual.isKnowledgeBound, true);
    assert.equal(factual.distributionRegime, 'factual_lookup');
    assert.equal(factual.recommendedPattern, VLD_PATTERNS.NONE);
    assert.equal(factual.recommendedVldFactor, 0);

    // 2. In-distribution iGSM op15 on 4-layer model -> skips non-monotonic x3 and recommends x4
    const idMath = estimateReasoningDepth({
        text: 'Solve the multi-step dependency graph mod 23.',
        operations: 15
    }, { baseLayers: 4 });
    assert.equal(idMath.isKnowledgeBound, false);
    assert.equal(idMath.distributionRegime, 'in_distribution');
    assert.equal(idMath.recommendedPattern, VLD_PATTERNS.CYCLE);
    assert.equal(idMath.recommendedVldFactor, 4);
    assert.equal(idMath.effectiveDepth, 20);

    // 3. Out-of-distribution iGSM op21 on 4-layer model -> recommends Cycle x5 (effectiveDepth = 24)
    const oodMath = estimateReasoningDepth({
        text: 'Solve high-complexity OOD iGSM problem.',
        operations: 21
    }, { baseLayers: 4 });
    assert.equal(oodMath.distributionRegime, 'ood_extreme');
    assert.equal(oodMath.recommendedVldFactor, 5);
    assert.equal(oodMath.effectiveDepth, 24);

    // 4. 8-layer model in-distribution -> recommends Appendix H.1 LATE_CYCLE
    const lateModel = estimateReasoningDepth({
        text: 'Derive the intermediate variables step-by-step.',
        operations: 12
    }, { baseLayers: 8 });
    assert.equal(lateModel.recommendedPattern, VLD_PATTERNS.LATE_CYCLE);
    assert.equal(lateModel.recommendedVldFactor, 2);
    assert.equal(lateModel.effectiveDepth, 16);
});

test('Non-Monotonic Dip & Fixed-Point Detection (Table 1 & Discussion 2)', () => {
    // Table 1 (4-layer Cycle op15): Base 46.3 -> x1 54.9 -> x2 62.1 -> x3 61.6 (dip!) -> x4 65.7 -> x5 70.7
    const table1Trace = [
        { vldFactor: 0, effectiveDepth: 4, score: 0.463 },
        { vldFactor: 1, effectiveDepth: 8, score: 0.549 },
        { vldFactor: 2, effectiveDepth: 12, score: 0.621 },
        { vldFactor: 3, effectiveDepth: 16, score: 0.616 },
        { vldFactor: 4, effectiveDepth: 20, score: 0.657 },
        { vldFactor: 5, effectiveDepth: 24, score: 0.707 }
    ];

    const analysis = detectVldFixedPoint(table1Trace, { regressionTolerance: 0.003 });
    assert.equal(analysis.nonMonotonicDipDetected, true);
    assert.equal(analysis.dipEvents.length, 1);
    assert.equal(analysis.dipEvents[0].fromFactor, 2);
    assert.equal(analysis.dipEvents[0].toFactor, 3);
    assert.equal(analysis.optimalCheckpoint.vldFactor, 5);
    assert.equal(analysis.shouldHalt, false);
});

test('Stateful VLD Scaling Engine: Cyclic Modular Arithmetic with Fixed-Point Early Stopping', async () => {
    const engine = createVldScalingEngine({ baseLayers: 2, defaultPattern: VLD_PATTERNS.CYCLE });

    // Define 2 base layers that iteratively resolve variable dependencies until fixed point
    const layer0 = state => ({
        ...state,
        x: state.c * 2,
        m: ((state.x ?? 0) + state.c) % 23
    });
    const layer1 = state => ({
        ...state,
        target: state.m > 0 ? (state.m * 9) % 23 : 0
    });

    const result = await engine.executeVldPipeline(
        { c: 2, x: null, m: 0, target: 0 },
        [layer0, layer1],
        {
            pattern: VLD_PATTERNS.CYCLE,
            vldFactor: 5, // Up to 6 total passes (12 steps), but should converge at pass 3
            scoreFn: s => (s.target === 8 ? 1.0 : 0.5)
        }
    );

    assert.equal(result.finalState.c, 2);
    assert.equal(result.finalState.x, 4);
    assert.equal(result.finalState.m, 6);
    assert.equal(result.finalState.target, (6 * 9) % 23); // 54 mod 23 = 8
    assert.equal(result.haltedEarly, true);
    assert.ok(result.stepsExecuted < result.plannedEffectiveDepth, 'Must halt early once fixed point is reached');
    assert.equal(result.diagnostics.fixedPointReached, true);
});
