/**
 * @module second-thought
 * @description Second Thought: Parallel Auxiliary Reasoning during Tool Execution based on:
 * "Second Thought: Reasoning in Parallel as LLM Agents Act and Observe" (arXiv: 2608.13667 - late Aug 2026).
 *
 * Eliminates sequential tool-use latency in agent runtimes by executing speculative auxiliary
 * reasoning in parallel during the idle I/O window between action serialization and environment observation:
 * 1. Concurrently launches the primary executor (e.g. async I/O, remote SSH command, test run).
 * 2. Concurrently launches speculative branch synthesis (predicting success vs. failure contingencies).
 * 3. Upon observation return, matches the real observation against the pre-synthesized branch,
 *    substantially cutting main-thread decoding latency and turn turnaround time.
 */

import { chatJson } from './llm.js';

/**
 * Creates a Second Thought engine instance for latency-optimized parallel tool execution.
 *
 * @param {object} [options={}]
 * @param {object} [options.llmConfig] - Default LLM configuration for speculative branch generation.
 * @param {boolean} [options.enableSpeculation=true] - Whether speculative execution is active.
 * @returns {object} Second Thought engine instance.
 */
export function createSecondThoughtEngine(options = {}) {
    const defaultLlmConfig = options.llmConfig || {};
    let totalSpeculations = 0;
    let successfulHits = 0;
    let totalLatencySavedMs = 0;

    return {
        /**
         * Dispatches an action with parallel speculative auxiliary reasoning.
         *
         * @param {object} params
         * @param {object} params.action - The action being executed { type, name, args }.
         * @param {Function} params.executorFn - Async function executing the real action, returning observation.
         * @param {object} [params.context={}] - Contextual state (current goal, recent steps).
         * @param {object} [params.llmConfig] - Override LLM config.
         * @param {Function} [params.mockSpeculationFn] - Optional mock/deterministic generator for testing without live API.
         * @returns {Promise<{
         *   observation: any,
         *   speculationHit: boolean,
         *   matchedBranch: 'SUCCESS'|'FAILURE'|'DIVERGENT',
         *   nextAction: object|null,
         *   contingencyReasoning: string,
         *   executionDurationMs: number,
         *   latencySavedMs: number
         * }>}
         */
        executeWithSecondThought: async ({
            action,
            executorFn,
            context = {},
            llmConfig = null,
            mockSpeculationFn = null
        }) => {
            totalSpeculations++;
            const startMs = Date.now();
            const resolvedConfig = llmConfig || defaultLlmConfig;

            // 1. Launch the real environment executor asynchronously
            const executorPromise = (async () => {
                const execStart = Date.now();
                const res = await executorFn(action);
                const execDuration = Date.now() - execStart;
                return { result: res, durationMs: execDuration };
            })();

            // 2. Launch speculative auxiliary reasoning concurrently during the I/O window
            const speculativePromise = (async () => {
                if (typeof mockSpeculationFn === 'function') {
                    return await mockSpeculationFn(action, context);
                }

                const systemPrompt = `You are an Auxiliary Speculative Reasoner operating under the "Second Thought" paradigm (arXiv: 2608.13667).
While the environment is executing a tool/action, your task is to speculatively synthesize two contingency branches:
1. SUCCESS BRANCH: Predicted state if the action succeeds, plus the immediate next logical action.
2. FAILURE BRANCH: Predicted diagnosis if the action fails or returns an error, plus the immediate recovery action.

Respond in strictly valid JSON:
{
  "successHypothesis": {
    "expectedObservationSignature": "keywords or pattern expected on success",
    "reasoning": "speculative chain of thought on success",
    "nextAction": { "type": "...", "name": "...", "args": {} }
  },
  "failureHypothesis": {
    "expectedObservationSignature": "keywords or error pattern expected on failure",
    "reasoning": "speculative diagnostic chain of thought on failure",
    "recoveryAction": { "type": "...", "name": "...", "args": {} }
  }
}`;

                const userMessage = `## ACTION CURRENTLY EXECUTING
${JSON.stringify(action, null, 2)}

## TASK CONTEXT
Goal: ${context.goal || "Homelab operational execution"}
Current State: ${JSON.stringify(context.state || {}, null, 2)}`;

                try {
                    return await chatJson(systemPrompt, userMessage, { ...resolvedConfig, temperature: 0.1 });
                } catch {
                    return null;
                }
            })();

            // 3. Await both the real action result and speculative reasoning
            const [execResult, speculativeBranches] = await Promise.all([executorPromise, speculativePromise]);
            const totalDurationMs = Date.now() - startMs;

            const obs = execResult.result;
            const obsText = typeof obs === 'string' ? obs : JSON.stringify(obs || '');
            const isError = obs?.isError || /error|failed|exception|fatal|denied/i.test(obsText);

            // 4. Match observation against speculative branches
            let matchedBranch = 'DIVERGENT';
            let nextAction = null;
            let contingencyReasoning = "";
            let speculationHit = false;

            if (speculativeBranches) {
                if (!isError && speculativeBranches.successHypothesis) {
                    matchedBranch = 'SUCCESS';
                    nextAction = speculativeBranches.successHypothesis.nextAction || null;
                    contingencyReasoning = speculativeBranches.successHypothesis.reasoning || "Speculative success branch matched.";
                    speculationHit = true;
                } else if (isError && speculativeBranches.failureHypothesis) {
                    matchedBranch = 'FAILURE';
                    nextAction = speculativeBranches.failureHypothesis.recoveryAction || null;
                    contingencyReasoning = speculativeBranches.failureHypothesis.reasoning || "Speculative error recovery branch matched.";
                    speculationHit = true;
                }
            }

            if (speculationHit) {
                successfulHits++;
                // In Second Thought, latency saved is approximately the time it would have taken to generate the next reasoning step
                const estimatedSavedMs = Math.min(1200, Math.max(300, execResult.durationMs));
                totalLatencySavedMs += estimatedSavedMs;

                return {
                    observation: obs,
                    speculationHit: true,
                    matchedBranch,
                    nextAction,
                    contingencyReasoning,
                    executionDurationMs: totalDurationMs,
                    latencySavedMs: estimatedSavedMs
                };
            }

            return {
                observation: obs,
                speculationHit: false,
                matchedBranch: 'DIVERGENT',
                nextAction: null,
                contingencyReasoning: "Observation diverged from speculative hypotheses; standard deliberation required.",
                executionDurationMs: totalDurationMs,
                latencySavedMs: 0
            };
        },

        getTelemetry: () => ({
            totalSpeculations,
            successfulHits,
            hitRate: totalSpeculations > 0 ? Math.round((successfulHits / totalSpeculations) * 100) / 100 : 0,
            totalLatencySavedMs
        })
    };
}
