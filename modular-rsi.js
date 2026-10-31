/**
 * @module modular-rsi
 * @description Modular and Generalizable Recursive Harness Self-Improvement based on:
 * "ModularRSI: Modular and Generalizable Recursive Harness Self-Improvement"
 * (arXiv: 2609.14857 - Wu, Ren, Li et al., September 2026).
 *
 * Decomposes agent harnesses into 5 independently evolvable functional modules:
 * 1. AgentLoop: execution pacing, step quotas, loop detection, and retry policies.
 * 2. ToolUse: schema validation, parameter repair, and fallback logic.
 * 3. ObservationManagement: noise reduction, log truncation, and relevance filtering.
 * 4. ContextManagement: lifecycle transitions, memory retrieval gating, and budget enforcement.
 * 5. TaskCompletionDetection: outcome verification, stopping criteria audits, and premature termination prevention.
 *
 * Implements contrastive trajectory analysis to attribute failure modes to specific harness
 * modules and synthesize target patches without retraining underlying model weights.
 */

/**
 * Standard module keys in a ModularRSI harness.
 */
export const RSI_MODULES = Object.freeze({
    AGENT_LOOP: 'AgentLoop',
    TOOL_USE: 'ToolUse',
    OBSERVATION_MGMT: 'ObservationManagement',
    CONTEXT_MGMT: 'ContextManagement',
    TASK_COMPLETION: 'TaskCompletionDetection'
});

/**
 * Default configurations for each of the 5 functional harness modules.
 */
export const DEFAULT_HARNESS_SPECS = Object.freeze({
    [RSI_MODULES.AGENT_LOOP]: {
        version: 1,
        maxIterations: 20,
        iterationPacingMs: 0,
        stopOnUnhandledError: false,
        maxConsecutiveErrors: 3,
        circuitBreakerThreshold: 5
    },
    [RSI_MODULES.TOOL_USE]: {
        version: 1,
        enforceSchemaTypes: true,
        autoCoerceJsonStrings: true,
        allowUnknownParams: false,
        retryOnMalformedArgs: true,
        maxToolRetries: 2
    },
    [RSI_MODULES.OBSERVATION_MGMT]: {
        version: 1,
        maxObservationBytes: 4096,
        stripAnsiCodes: true,
        truncateMiddle: true,
        relevanceFilter: false
    },
    [RSI_MODULES.CONTEXT_MGMT]: {
        version: 1,
        maxContextTokens: 16384,
        evictIntermediateReasoning: true,
        retrievalGateThreshold: 0.72,
        preserveSystemPrompt: true
    },
    [RSI_MODULES.TASK_COMPLETION]: {
        version: 1,
        requireDeterministicVerdict: true,
        verifyAllSubtasksComplete: true,
        preventZeroStepSuccess: true,
        minimumConfidenceScore: 0.80
    }
});

/**
 * Creates a ModularRSI Harness instance.
 *
 * @param {Object} [initialSpecs={}] - Optional custom initial module specs.
 * @returns {Object} ModularRsiHarness instance.
 */
export function createModularRsiHarness(initialSpecs = {}) {
    const moduleSpecs = {
        [RSI_MODULES.AGENT_LOOP]: { ...DEFAULT_HARNESS_SPECS[RSI_MODULES.AGENT_LOOP], ...(initialSpecs[RSI_MODULES.AGENT_LOOP] || {}) },
        [RSI_MODULES.TOOL_USE]: { ...DEFAULT_HARNESS_SPECS[RSI_MODULES.TOOL_USE], ...(initialSpecs[RSI_MODULES.TOOL_USE] || {}) },
        [RSI_MODULES.OBSERVATION_MGMT]: { ...DEFAULT_HARNESS_SPECS[RSI_MODULES.OBSERVATION_MGMT], ...(initialSpecs[RSI_MODULES.OBSERVATION_MGMT] || {}) },
        [RSI_MODULES.CONTEXT_MGMT]: { ...DEFAULT_HARNESS_SPECS[RSI_MODULES.CONTEXT_MGMT], ...(initialSpecs[RSI_MODULES.CONTEXT_MGMT] || {}) },
        [RSI_MODULES.TASK_COMPLETION]: { ...DEFAULT_HARNESS_SPECS[RSI_MODULES.TASK_COMPLETION], ...(initialSpecs[RSI_MODULES.TASK_COMPLETION] || {}) }
    };

    const evolutionHistory = [];

    return {
        /**
         * Gets the active specification for a specific harness module.
         * @param {string} moduleName
         * @returns {Object}
         */
        getModuleSpec(moduleName) {
            if (!moduleSpecs[moduleName]) {
                throw new Error(`[ModularRSI] Unknown module: "${moduleName}". Valid modules: ${Object.values(RSI_MODULES).join(', ')}`);
            }
            return { ...moduleSpecs[moduleName] };
        },

        /**
         * Gets all current module specifications.
         * @returns {Object}
         */
        getAllSpecs() {
            return JSON.parse(JSON.stringify(moduleSpecs));
        },

        /**
         * Executes an observation management pass on raw tool/environment output.
         * @param {string|Object} rawObservation
         * @returns {{ observation: string, originalBytes: number, processedBytes: number, truncated: boolean }}
         */
        processObservation(rawObservation) {
            const spec = moduleSpecs[RSI_MODULES.OBSERVATION_MGMT];
            let str = typeof rawObservation === 'string' ? rawObservation : JSON.stringify(rawObservation, null, 2);
            const originalBytes = Buffer.byteLength(str, 'utf8');

            if (spec.stripAnsiCodes) {
                str = str.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
            }

            let truncated = false;
            if (Buffer.byteLength(str, 'utf8') > spec.maxObservationBytes) {
                truncated = true;
                if (spec.truncateMiddle) {
                    const half = Math.floor(spec.maxObservationBytes / 2) - 30;
                    const head = str.slice(0, half);
                    const tail = str.slice(-half);
                    str = `${head}\n... [TRUNCATED ${originalBytes - spec.maxObservationBytes} BYTES BY MODULAR-RSI] ...\n${tail}`;
                } else {
                    str = str.slice(0, spec.maxObservationBytes) + '\n... [TRUNCATED BY MODULAR-RSI]';
                }
            }

            return {
                observation: str,
                originalBytes,
                processedBytes: Buffer.byteLength(str, 'utf8'),
                truncated
            };
        },

        /**
         * Validates and repairs a tool call argument payload before execution.
         * @param {Object} toolDefinition - Tool schema containing parameter specs.
         * @param {Object} candidateArgs - Raw arguments proposed by model.
         * @returns {{ valid: boolean, repairedArgs: Object, errors: string[] }}
         */
        sanitizeToolArgs(toolDefinition, candidateArgs = {}) {
            const spec = moduleSpecs[RSI_MODULES.TOOL_USE];
            const errors = [];
            let repairedArgs = { ...candidateArgs };

            if (!toolDefinition || typeof toolDefinition !== 'object') {
                return { valid: true, repairedArgs, errors: [] };
            }

            const expectedParams = toolDefinition.parameters?.properties || {};
            const requiredParams = toolDefinition.parameters?.required || [];

            // Check for unknown parameters
            if (!spec.allowUnknownParams) {
                for (const key of Object.keys(repairedArgs)) {
                    if (!expectedParams[key]) {
                        delete repairedArgs[key];
                    }
                }
            }

            // Type check and coercion
            for (const [paramName, paramSchema] of Object.entries(expectedParams)) {
                let val = repairedArgs[paramName];
                if (val === undefined) {
                    if (requiredParams.includes(paramName)) {
                        errors.push(`Missing required parameter: "${paramName}"`);
                    }
                    continue;
                }

                if (spec.autoCoerceJsonStrings && typeof val === 'string' && (paramSchema.type === 'object' || paramSchema.type === 'array')) {
                    try {
                        val = JSON.parse(val);
                        repairedArgs[paramName] = val;
                    } catch {
                        // ignore parse error, will fail type check below
                    }
                }

                if (spec.enforceSchemaTypes) {
                    if (paramSchema.type === 'number' || paramSchema.type === 'integer') {
                        if (typeof val === 'string' && !isNaN(Number(val))) {
                            repairedArgs[paramName] = Number(val);
                        } else if (typeof val !== 'number') {
                            errors.push(`Parameter "${paramName}" expected type ${paramSchema.type}, got ${typeof val}`);
                        }
                    } else if (paramSchema.type === 'boolean') {
                        if (typeof val === 'string') {
                            if (val.toLowerCase() === 'true') repairedArgs[paramName] = true;
                            else if (val.toLowerCase() === 'false') repairedArgs[paramName] = false;
                        } else if (typeof val !== 'boolean') {
                            errors.push(`Parameter "${paramName}" expected boolean, got ${typeof val}`);
                        }
                    } else if (paramSchema.type === 'array' && !Array.isArray(val)) {
                        errors.push(`Parameter "${paramName}" expected array, got ${typeof val}`);
                    }
                }
            }

            return {
                valid: errors.length === 0,
                repairedArgs,
                errors
            };
        },

        /**
         * Audits whether a task completion claim should be accepted or rejected.
         * @param {Object} proposal - Task completion claims { subtasksTotal, subtasksDone, confidence, stepsRun }
         * @returns {{ approved: boolean, reason: string }}
         */
        verifyTaskCompletion(proposal = {}) {
            const spec = moduleSpecs[RSI_MODULES.TASK_COMPLETION];
            const { subtasksTotal = 0, subtasksDone = 0, confidence = 1.0, stepsRun = 1 } = proposal;

            if (spec.preventZeroStepSuccess && stepsRun <= 0) {
                return { approved: false, reason: 'Zero-step completion rejected by TaskCompletionDetection policy.' };
            }

            if (spec.verifyAllSubtasksComplete && subtasksTotal > 0 && subtasksDone < subtasksTotal) {
                return {
                    approved: false,
                    reason: `Incomplete subtasks: ${subtasksDone}/${subtasksTotal} finished.`
                };
            }

            if (confidence < spec.minimumConfidenceScore) {
                return {
                    approved: false,
                    reason: `Confidence ${confidence.toFixed(2)} below minimum threshold ${spec.minimumConfidenceScore}.`
                };
            }

            return { approved: true, reason: 'Task completion criteria satisfied.' };
        },

        /**
         * Contrastive Trajectory Attribution:
         * Compares a failed trajectory against expected criteria or a successful baseline,
         * attributing the root failure to one of the 5 functional harness modules.
         *
         * @param {Object} failedTrajectory
         * @param {Object} [contrastiveBaseline={}]
         * @returns {{ attributedModule: string, deficiencyType: string, rationale: string, suggestedPatch: Object }}
         */
        attributeFailure(failedTrajectory = {}, contrastiveBaseline = {}) {
            const {
                errorCount = 0,
                iterations = 0,
                malformedToolCalls = 0,
                contextTokenPeak = 0,
                observationBytesPeak = 0,
                prematureExit = false,
                subtasksRemaining = 0,
                errorMessage = ''
            } = failedTrajectory;

            // 1. Tool Use attribution
            if (malformedToolCalls > 0 || errorMessage.toLowerCase().includes('schema') || errorMessage.toLowerCase().includes('argument')) {
                return {
                    attributedModule: RSI_MODULES.TOOL_USE,
                    deficiencyType: 'SCHEMA_ARGUMENT_ERROR',
                    rationale: `Trajectory failed with ${malformedToolCalls} malformed tool calls or schema violations.`,
                    suggestedPatch: {
                        autoCoerceJsonStrings: true,
                        retryOnMalformedArgs: true,
                        maxToolRetries: Math.max(3, moduleSpecs[RSI_MODULES.TOOL_USE].maxToolRetries + 1)
                    }
                };
            }

            // 2. Task Completion Detection attribution
            if (prematureExit || (subtasksRemaining > 0 && errorMessage.toLowerCase().includes('done'))) {
                return {
                    attributedModule: RSI_MODULES.TASK_COMPLETION,
                    deficiencyType: 'PREMATURE_TERMINATION',
                    rationale: `Agent reported completion with ${subtasksRemaining} uncompleted subtasks.`,
                    suggestedPatch: {
                        verifyAllSubtasksComplete: true,
                        minimumConfidenceScore: Math.min(0.95, moduleSpecs[RSI_MODULES.TASK_COMPLETION].minimumConfidenceScore + 0.05)
                    }
                };
            }

            // 3. Observation Management attribution
            if (observationBytesPeak > moduleSpecs[RSI_MODULES.OBSERVATION_MGMT].maxObservationBytes * 1.5) {
                return {
                    attributedModule: RSI_MODULES.OBSERVATION_MGMT,
                    deficiencyType: 'OBSERVATION_BLOWUP',
                    rationale: `Observation output (${observationBytesPeak} bytes) exceeded budget, causing context pollution.`,
                    suggestedPatch: {
                        maxObservationBytes: Math.floor(moduleSpecs[RSI_MODULES.OBSERVATION_MGMT].maxObservationBytes * 0.75),
                        truncateMiddle: true
                    }
                };
            }

            // 4. Context Management attribution
            if (contextTokenPeak > moduleSpecs[RSI_MODULES.CONTEXT_MGMT].maxContextTokens * 0.9) {
                return {
                    attributedModule: RSI_MODULES.CONTEXT_MGMT,
                    deficiencyType: 'CONTEXT_BUDGET_EXHAUSTION',
                    rationale: `Context token peak reached ${contextTokenPeak} tokens, approaching limit.`,
                    suggestedPatch: {
                        evictIntermediateReasoning: true,
                        retrievalGateThreshold: Math.min(0.85, moduleSpecs[RSI_MODULES.CONTEXT_MGMT].retrievalGateThreshold + 0.05)
                    }
                };
            }

            // 5. Agent Loop attribution (default fallback for timeouts / iteration exhaustions)
            return {
                attributedModule: RSI_MODULES.AGENT_LOOP,
                deficiencyType: iterations >= moduleSpecs[RSI_MODULES.AGENT_LOOP].maxIterations ? 'ITERATION_QUOTA_EXHAUSTED' : 'UNHANDLED_ERROR_LOOP',
                rationale: `Agent loop halted after ${iterations} iterations with errorCount=${errorCount}.`,
                suggestedPatch: {
                    maxIterations: Math.min(50, moduleSpecs[RSI_MODULES.AGENT_LOOP].maxIterations + 10),
                    circuitBreakerThreshold: Math.max(3, moduleSpecs[RSI_MODULES.AGENT_LOOP].circuitBreakerThreshold + 1)
                }
            };
        },

        /**
         * Applies a recursive self-improvement patch to a targeted harness module.
         * @param {string} moduleName
         * @param {Object} patchConfig
         * @param {string} [rationale='']
         * @returns {{ updatedSpec: Object, version: number }}
         */
        applyRsiPatch(moduleName, patchConfig = {}, rationale = '') {
            if (!moduleSpecs[moduleName]) {
                throw new Error(`[ModularRSI] Cannot patch unknown module: "${moduleName}"`);
            }

            const current = moduleSpecs[moduleName];
            const newVersion = (current.version || 1) + 1;
            const updatedSpec = {
                ...current,
                ...patchConfig,
                version: newVersion
            };

            moduleSpecs[moduleName] = updatedSpec;

            const evolutionRecord = {
                moduleName,
                fromVersion: current.version,
                toVersion: newVersion,
                patch: patchConfig,
                rationale,
                timestamp: new Date().toISOString()
            };
            evolutionHistory.push(evolutionRecord);

            return {
                updatedSpec: { ...updatedSpec },
                version: newVersion
            };
        },

        /**
         * Gets the full audit trail of recursive self-improvement patches.
         * @returns {Array<Object>}
         */
        getEvolutionHistory() {
            return [...evolutionHistory];
        }
    };
}
