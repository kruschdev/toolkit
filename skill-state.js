/**
 * @module skill-state
 * @description SKILL.state: Scalable Long-Horizon Agent Skills based on:
 * "SKILL.state: Scalable Long-Horizon Agent Skills" (arXiv: 2608.26263 - Badhe, Tiwari, Chung, Aug 2026).
 *
 * Solves the append-only conversation history flaw in autonomous agent runtimes:
 * 1. Replaces accumulated conversation history with an explicit, mutable execution state (S_t).
 * 2. Inputs per step are strictly bounded: <SkillSpec_immutable, State_t, Observation_t>.
 * 3. Intermediate reasoning traces are immediately discarded once the state mutation is validated.
 * 4. Yields strictly O(1) prompt size bounds and up to 16x cumulative token reduction.
 */

/**
 * Calculates estimated token savings of SKILL.state versus traditional append-only conversation logs.
 *
 * @param {number} stepCount - Number of elapsed execution steps.
 * @param {number} [avgReasoningTokens=350] - Average tokens consumed by chain-of-thought/reasoning per step.
 * @param {number} [avgObservationTokens=250] - Average tokens in each tool observation.
 * @param {number} [stateSizeTokens=200] - Average size of structured execution state S_t.
 * @param {number} [skillSpecTokens=400] - Size of the immutable skill specification.
 * @returns {{ appendOnlyTokens: number, skillStateTokens: number, tokensSaved: number, savingsRatio: number }}
 */
export function calculateSkillStateSavings(
    stepCount,
    avgReasoningTokens = 350,
    avgObservationTokens = 250,
    stateSizeTokens = 200,
    skillSpecTokens = 400
) {
    if (stepCount <= 0) {
        return { appendOnlyTokens: skillSpecTokens, skillStateTokens: skillSpecTokens, tokensSaved: 0, savingsRatio: 1.0 };
    }

    // In append-only, at step i, prompt contains: spec + sum_{j=1}^{i-1} (reasoning + tool_call + observation) + observation_i
    // Cumulative prompt tokens across all steps grows quadratically: O(N^2)
    let appendOnlyTotalPromptTokens = 0;
    for (let i = 1; i <= stepCount; i++) {
        const historyTokens = (i - 1) * (avgReasoningTokens + avgObservationTokens);
        const promptTokens = skillSpecTokens + historyTokens + avgObservationTokens;
        appendOnlyTotalPromptTokens += promptTokens;
    }

    // In SKILL.state, at step i, prompt contains strictly: spec + state_i + observation_i (strictly O(1) per step, O(N) cumulative)
    const skillStatePerStepPromptTokens = skillSpecTokens + stateSizeTokens + avgObservationTokens;
    const skillStateTotalPromptTokens = stepCount * skillStatePerStepPromptTokens;

    const tokensSaved = Math.max(0, appendOnlyTotalPromptTokens - skillStateTotalPromptTokens);
    const savingsRatio = Math.round((appendOnlyTotalPromptTokens / Math.max(1, skillStateTotalPromptTokens)) * 100) / 100;

    return {
        appendOnlyTokens: appendOnlyTotalPromptTokens,
        skillStateTokens: skillStateTotalPromptTokens,
        tokensSaved,
        savingsRatio
    };
}

/**
 * Creates a SKILL.state Manager instance to govern long-horizon agent execution.
 *
 * @param {object} options
 * @param {string} options.skillSpec - The immutable skill instructions and procedural specification.
 * @param {object} [options.initialState={}] - Initial structured execution state S_0.
 * @param {Function} [options.stateValidator] - Optional validation function to verify state mutations.
 * @param {number} [options.maxSnapshots=15] - Maximum rollback snapshots to retain.
 * @returns {object} Skill state manager instance.
 */
export function createSkillStateManager(options = {}) {
    const {
        skillSpec = "",
        initialState = {},
        stateValidator = null,
        maxSnapshots = 15
    } = options;

    if (!skillSpec || typeof skillSpec !== 'string') {
        throw new Error("SKILL.state manager requires an immutable skill specification string.");
    }

    let currentState = JSON.parse(JSON.stringify(initialState));
    let stepCount = 0;
    const snapshots = [];
    const executionLedger = []; // Compact metadata ledger (no raw reasoning logs)

    // Save initial state snapshot
    snapshots.push({ step: 0, state: JSON.parse(JSON.stringify(currentState)), timestamp: Date.now() });

    return {
        getSkillSpec: () => skillSpec,
        getState: () => JSON.parse(JSON.stringify(currentState)),
        getStepCount: () => stepCount,
        getExecutionLedger: () => [...executionLedger],

        /**
         * Formats the strictly bounded input prompt for step t:
         * Input_t = <SkillSpec_immutable, State_t, Observation_t>
         *
         * @param {string|object} latestObservation - Environment observation or tool execution result.
         * @returns {string} Fully formatted prompt for the agent.
         */
        formatStepPrompt: (latestObservation = "") => {
            const obsText = typeof latestObservation === 'string'
                ? latestObservation
                : JSON.stringify(latestObservation, null, 2);

            return [
                "### IMMUTABLE SKILL SPECIFICATION",
                skillSpec.trim(),
                "",
                "### CURRENT MUTABLE EXECUTION STATE (S_t)",
                JSON.stringify(currentState, null, 2),
                "",
                "### LATEST OBSERVATION (O_t)",
                obsText.trim() || "(Initial activation - begin execution)",
                "",
                "### DIRECTIVE",
                "Based ONLY on the immutable skill, current execution state, and latest observation, determine your next action and propose the state mutation delta (ΔS_t).",
                "Respond in JSON matching:",
                '{\n  "thought": "Transient reasoning (will be discarded after validation)",\n  "action": { "type": "TOOL_CALL" | "TASK_COMPLETE" | "USER_INTERACTION", "name": "...", "args": {} },\n  "stateDelta": { "key": "updated_value", ... }\n}'
            ].join("\n");
        },

        /**
         * Applies a validated state mutation ΔS_t, records the compact ledger entry,
         * and purges intermediate reasoning to maintain O(1) bounded state.
         *
         * @param {object} params
         * @param {object} params.stateDelta - Key-value mutations to apply to currentState.
         * @param {object} [params.action] - Action that was executed.
         * @param {string} [params.intermediateReasoning] - Chain-of-thought to be discarded.
         * @param {string} [params.observationSummary] - Short summary of observation.
         * @returns {{ success: boolean, updatedState: object, step: number, evictedReasoningLength: number, error?: string }}
         */
        applyStateMutation: ({ stateDelta = {}, action = null, intermediateReasoning = "", observationSummary = "" }) => {
            if (typeof stateDelta !== 'object' || stateDelta === null || Array.isArray(stateDelta)) {
                return {
                    success: false,
                    updatedState: currentState,
                    step: stepCount,
                    evictedReasoningLength: 0,
                    error: "stateDelta must be a non-null key-value object."
                };
            }

            // Propose candidate state
            const candidateState = {
                ...currentState,
                ...stateDelta,
                _lastUpdatedStep: stepCount + 1,
                _lastUpdatedTimestamp: Date.now()
            };

            // Run validator if provided
            if (typeof stateValidator === 'function') {
                const validationResult = stateValidator(candidateState, currentState, stateDelta);
                if (validationResult === false || (typeof validationResult === 'object' && validationResult.valid === false)) {
                    const errMsg = (typeof validationResult === 'object' && validationResult.error) 
                        ? validationResult.error 
                        : "State mutation failed validation.";
                    return {
                        success: false,
                        updatedState: currentState,
                        step: stepCount,
                        evictedReasoningLength: 0,
                        error: errMsg
                    };
                }
            }

            // Commit state mutation
            stepCount++;
            currentState = candidateState;

            // Evict intermediate reasoning trace from persistent memory
            const evictedReasoningLength = intermediateReasoning ? intermediateReasoning.length : 0;

            // Record compact ledger entry
            executionLedger.push({
                step: stepCount,
                action: action?.name || action?.type || "STATE_UPDATE",
                observationSummary: observationSummary.slice(0, 150),
                timestamp: Date.now()
            });

            // Save snapshot
            snapshots.push({ step: stepCount, state: JSON.parse(JSON.stringify(currentState)), timestamp: Date.now() });
            if (snapshots.length > maxSnapshots) {
                snapshots.shift();
            }

            return {
                success: true,
                updatedState: JSON.parse(JSON.stringify(currentState)),
                step: stepCount,
                evictedReasoningLength
            };
        },

        /**
         * Reverts current state to a previous snapshot step.
         *
         * @param {number} targetStep - Target step index to restore.
         * @returns {{ restored: boolean, step: number, state: object }}
         */
        rollback: (targetStep) => {
            const found = snapshots.find(s => s.step === targetStep);
            if (!found) {
                return { restored: false, step: stepCount, state: currentState };
            }

            currentState = JSON.parse(JSON.stringify(found.state));
            stepCount = found.step;
            return { restored: true, step: stepCount, state: currentState };
        },

        /**
         * Returns telemetry comparing SKILL.state bounded prompt size vs. append-only baseline.
         */
        getTelemetry: () => {
            const stateJson = JSON.stringify(currentState);
            const promptChars = skillSpec.length + stateJson.length;
            const savings = calculateSkillStateSavings(stepCount);

            return {
                stepCount,
                stateSizeBytes: Buffer.byteLength(stateJson, 'utf8'),
                currentPromptChars: promptChars,
                estimatedTokensSaved: savings.tokensSaved,
                savingsRatio: savings.savingsRatio
            };
        }
    };
}
