/**
 * @module dhd-deliberation
 * @description Diverse Hypothesis Deliberation (DHD) & Trajectory Value Engine based on:
 * 1. "Wrong but Useful: Trajectory Value Beyond Answer Correctness in Multi-Agent Messages" (arXiv: 2608.14375 - late Aug 2026) and
 * 2. "Candidate supply and answer selection shape the value of LLM judging in multi-agent systems" (arXiv: 2608.25937 - late Aug 2026).
 *
 * Implements evolutionary multi-agent consensus and trajectory value extraction:
 * - Rescues structural value from failed/sub-optimal candidate trajectories ("Wrong but Useful").
 * - Extracts common invariants, negative constraints, and modular sub-goal decompositions.
 * - Blends candidate frequency clustering with referee selection pressure.
 */

import { chatJson } from './llm.js';

/**
 * Extracts structural trajectory value (invariants, negative constraints, sub-goals)
 * from a collection of candidate trajectories (both passing and failing).
 *
 * @param {Array<object>} candidates - Array of candidate runs: { id, solution, isCorrect, steps, errors, thoughts }.
 * @returns {{
 *   commonInvariants: string[],
 *   negativeConstraints: string[],
 *   subGoalDecompositions: string[],
 *   trajectoryValueScore: number
 * }}
 */
export function extractTrajectoryValue(candidates = []) {
    if (!Array.isArray(candidates) || candidates.length === 0) {
        return {
            commonInvariants: [],
            negativeConstraints: [],
            subGoalDecompositions: [],
            trajectoryValueScore: 0
        };
    }

    const successfulCandidates = candidates.filter(c => c.isCorrect || c.passed);
    const failedCandidates = candidates.filter(c => !c.isCorrect && !c.passed);

    const negativeConstraints = [];
    const subGoalDecompositions = [];
    const commonInvariants = [];

    // 1. Extract negative constraints from failed candidates ("what went wrong that all must avoid")
    for (const fc of failedCandidates) {
        if (fc.errors && Array.isArray(fc.errors)) {
            for (const err of fc.errors) {
                const constraint = `Avoid failure path: ${String(err).slice(0, 140)}`;
                if (!negativeConstraints.includes(constraint)) {
                    negativeConstraints.push(constraint);
                }
            }
        } else if (fc.errorReason) {
            const constraint = `Avoid failure: ${String(fc.errorReason).slice(0, 140)}`;
            if (!negativeConstraints.includes(constraint)) {
                negativeConstraints.push(constraint);
            }
        }

        // Check if failed candidate had useful sub-goals before failing
        if (Array.isArray(fc.steps)) {
            for (const step of fc.steps) {
                if (step.subGoal && !step.failed) {
                    const sg = `Sub-goal discovered: ${step.subGoal}`;
                    if (!subGoalDecompositions.includes(sg)) {
                        subGoalDecompositions.push(sg);
                    }
                }
            }
        }
    }

    // 2. Extract common invariants across successful candidates
    if (successfulCandidates.length > 0) {
        // Collect steps or tools used by all successful candidates
        const successfulStepsMap = new Map();
        for (const sc of successfulCandidates) {
            const steps = Array.isArray(sc.steps) ? sc.steps : [];
            for (const s of steps) {
                const name = s.name || s.tool || s.action || String(s);
                successfulStepsMap.set(name, (successfulStepsMap.get(name) || 0) + 1);
            }
        }

        for (const [stepName, count] of successfulStepsMap.entries()) {
            if (count >= Math.ceil(successfulCandidates.length * 0.6)) {
                commonInvariants.push(`Consensus invariant step: [${stepName}] validated by ${count}/${successfulCandidates.length} successful paths.`);
            }
        }
    }

    // Trajectory value score measures the information density extracted from non-trivial trajectories
    const totalUsefulSignals = commonInvariants.length + negativeConstraints.length + subGoalDecompositions.length;
    const trajectoryValueScore = Math.min(1.0, Math.round((totalUsefulSignals / (candidates.length * 2)) * 100) / 100);

    return {
        commonInvariants,
        negativeConstraints,
        subGoalDecompositions,
        trajectoryValueScore
    };
}

/**
 * Clusters candidate hypotheses and evaluates multi-agent consensus by combining
 * candidate frequency with referee evaluation (arXiv: 2608.25937).
 *
 * @param {Array<object>} candidates - Array of candidate runs { id, proposal, category, confidence }.
 * @param {object} [options={}]
 * @param {Function} [options.refereeFn] - Custom scoring/referee evaluation function.
 * @param {object} [options.llmConfig] - LLM config for AI referee evaluation.
 * @returns {Promise<{
 *   selectedCandidate: object,
 *   winningCluster: string,
 *   clusterDistribution: Record<string, number>,
 *   trajectoryValue: object,
 *   consensusConfidence: number
 * }>}
 */
export async function evaluateDHDConsensus(candidates = [], options = {}) {
    if (!Array.isArray(candidates) || candidates.length === 0) {
        throw new Error("DHD Consensus requires a non-empty array of candidate hypotheses.");
    }

    // 1. Group candidates into clusters
    const clusters = new Map();
    for (const c of candidates) {
        // Form cluster key from proposal hash or semantic signature
        const key = c.clusterKey || c.category || (typeof c.proposal === 'string' ? c.proposal.trim().slice(0, 80) : "default_cluster");
        if (!clusters.has(key)) {
            clusters.set(key, []);
        }
        clusters.get(key).push(c);
    }

    const clusterDistribution = {};
    for (const [key, list] of clusters.entries()) {
        clusterDistribution[key] = list.length;
    }

    // 2. Extract trajectory value across all candidates (including failed ones)
    const trajectoryValue = extractTrajectoryValue(candidates);

    // 3. Evaluate selection pressure: Frequency Prior + Referee Scoring
    let highestScore = -1;
    let selectedCandidate = candidates[0];
    let winningCluster = Object.keys(clusterDistribution)[0];

    for (const [key, clusterItems] of clusters.entries()) {
        // Frequency prior: proportion of candidates proposing this solution
        const frequencyPrior = clusterItems.length / candidates.length;

        for (const candidate of clusterItems) {
            let refereeScore = 0.5;

            if (typeof options.refereeFn === 'function') {
                refereeScore = await options.refereeFn(candidate, trajectoryValue);
            } else if (candidate.confidence !== undefined) {
                refereeScore = candidate.confidence;
            }

            // Combined selection score = 0.4 * frequencyPrior + 0.6 * refereeScore
            const totalScore = Math.round((0.4 * frequencyPrior + 0.6 * refereeScore) * 100) / 100;

            if (totalScore > highestScore) {
                highestScore = totalScore;
                selectedCandidate = candidate;
                winningCluster = key;
            }
        }
    }

    return {
        selectedCandidate,
        winningCluster,
        clusterDistribution,
        trajectoryValue,
        consensusConfidence: highestScore
    };
}
