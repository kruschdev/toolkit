/**
 * @module modular-rsi
 * @description Modular and Continual Recursive Harness Self-Improvement based on:
 * - "ModularRSI: Modular and Generalizable Recursive Harness Self-Improvement"
 *   (arXiv: 2609.14857 - Wu, Ren, Li et al., September 2026)
 * - "Self-Improvement Memory Enables Continual Recursive Self-Improvement"
 *   (arXiv: 2611.18856 - Yu, Xia, Pan et al., November 2026)
 *
 * Decomposes agent harnesses into 5 independently evolvable functional modules:
 * 1. AgentLoop: execution pacing, step quotas, loop detection, and retry policies.
 * 2. ToolUse: schema validation, parameter repair, and fallback logic.
 * 3. ObservationManagement: noise reduction, log truncation, and relevance filtering.
 * 4. ContextManagement: lifecycle transitions, memory retrieval gating, and budget enforcement.
 * 5. TaskCompletionDetection: outcome verification, stopping criteria audits, and premature termination prevention.
 *
 * Pairs contrastive trajectory attribution with Self-Improvement Memory (SIM) so outer-loop
 * harness optimizers (Proposer & Selector) retain root-cause diagnoses, edit rationales,
 * pre/post-eval counterfactual outcomes (predicted vs. fixed/missed), and provenance across
 * cross-dataset and cross-model Continual RSI (CRSI) transitions without retraining weights.
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
 * Continual RSI (CRSI) transfer modes from arXiv:2611.18856 (§3.3).
 */
export const SIM_TRANSFER_MODES = Object.freeze({
    COLD_START: 'cold_start',
    HARNESS_TRANSFER: 'harness_transfer',
    PROBLEM_ONLY: 'problem_only',
    FULL_SIM: 'full_sim'
});

/**
 * Canonical Proposer & Selector SIM guidance rules from arXiv:2611.18856 (Appendix D.2).
 */
export const SIM_GUIDANCE_RULES = Object.freeze([
    'Treat entries as prior experience, with flexibility to choose a different edit.',
    'Check the domain, benchmark, and model behind each entry.',
    'Start with an existing diagnosis when it explains the current failure.',
    'Reuse the rationale and reassess the edit after a benchmark or model change.',
    'Revise, replace, or override a harness modification when new evidence warrants it.',
    'Revisit a tested direction only when new evidence justifies it.',
    'Create a new problem entry when existing diagnoses do not explain the failure.',
    'Give task-specific evidence more weight in similar settings and less when both benchmark and model change.'
]);

function normalizeRootCauseKey(text) {
    return String(text || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function uniqueStringList(items) {
    if (!Array.isArray(items)) return [];
    const seen = new Set();
    const out = [];
    for (const raw of items) {
        if (raw === null || raw === undefined) continue;
        const val = String(raw).trim();
        if (!val || seen.has(val)) continue;
        seen.add(val);
        out.push(val);
    }
    return out;
}

function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
}

/**
 * Creates a Self-Improvement Memory (SIM) store for outer-loop harness optimization
 * (Proposer & Selector) across continual dataset and policy-model transitions (arXiv:2611.18856).
 *
 * Schema follows Appendix D.3:
 * `{ next_id, carried_from, aliases, problems: [{ id, name, opened_round, attempts[] }] }`
 *
 * @param {Object} [initialState={}]
 * @returns {Object} SelfImprovementMemory instance.
 */
export function createSelfImprovementMemory(initialState = {}) {
    let nextId = Number.isInteger(initialState.next_id) && initialState.next_id >= 1
        ? initialState.next_id
        : 1;
    let carriedFrom = initialState.carried_from ? cloneJson(initialState.carried_from) : null;
    const aliases = initialState.aliases && typeof initialState.aliases === 'object'
        ? { ...initialState.aliases }
        : {};
    const problems = [];

    function allocateProblemId() {
        while (
            aliases[`P${nextId}`] ||
            problems.some((entry) => entry.id === `P${nextId}`)
        ) {
            nextId += 1;
        }
        const id = `P${nextId}`;
        nextId += 1;
        return id;
    }

    function resolveProblemId(idOrAlias) {
        if (!idOrAlias || typeof idOrAlias !== 'string') return null;
        let cur = idOrAlias.trim();
        const visited = new Set();
        while (aliases[cur]) {
            if (visited.has(cur)) break;
            visited.add(cur);
            cur = aliases[cur];
        }
        return cur;
    }

    function findProblemIndex(idOrName) {
        if (!idOrName) return -1;
        const resolvedId = resolveProblemId(String(idOrName));
        const byId = problems.findIndex((p) => p.id === resolvedId);
        if (byId !== -1) return byId;
        const targetKey = normalizeRootCauseKey(idOrName);
        if (!targetKey) return -1;
        return problems.findIndex((p) => normalizeRootCauseKey(p.name) === targetKey);
    }

    function normalizeAttemptRecord(raw = {}) {
        const predicted = uniqueStringList(raw.predicted);
        const hasAfterPassed = Array.isArray(raw.afterPassed);
        const afterSet = hasAfterPassed ? new Set(uniqueStringList(raw.afterPassed)) : null;
        const beforeSet = Array.isArray(raw.beforePassed) ? new Set(uniqueStringList(raw.beforePassed)) : null;

        let fixed;
        if (Array.isArray(raw.fixed)) {
            fixed = uniqueStringList(raw.fixed);
        } else if (afterSet) {
            const predictedFixed = predicted.filter((t) => afterSet.has(t));
            const newlyFixed = beforeSet
                ? [...afterSet].filter((t) => !beforeSet.has(t) && !predictedFixed.includes(t))
                : [];
            fixed = [...predictedFixed, ...newlyFixed];
        } else {
            fixed = [];
        }

        let missed;
        if (Array.isArray(raw.missed)) {
            missed = uniqueStringList(raw.missed);
        } else if (afterSet) {
            missed = predicted.filter((t) => !afterSet.has(t));
        } else {
            const fixedSet = new Set(fixed);
            missed = raw.computeMissedFromFixed ? predicted.filter((t) => !fixedSet.has(t)) : [];
        }

        const passed = typeof raw.passed === 'number'
            ? raw.passed
            : (afterSet ? afterSet.size : 0);
        const total = typeof raw.total === 'number'
            ? raw.total
            : Math.max(passed, predicted.length);

        return {
            round: Number.isInteger(raw.round) ? raw.round : 0,
            sample: Number.isInteger(raw.sample) ? raw.sample : 0,
            accepted: raw.accepted !== false,
            backfilled: Boolean(raw.backfilled),
            what: String(raw.what || raw.modification || '').trim(),
            rationale: String(raw.rationale || '').trim(),
            files: uniqueStringList(raw.files),
            predicted,
            fixed,
            missed,
            passed,
            total,
            domain: String(raw.domain || 'default').trim(),
            benchmark: raw.benchmark ? String(raw.benchmark).trim() : null,
            policyModel: raw.policyModel ? String(raw.policyModel).trim() : null,
            moduleName: raw.moduleName ? String(raw.moduleName).trim() : null,
            timestamp: raw.timestamp ? String(raw.timestamp) : new Date().toISOString()
        };
    }

    if (Array.isArray(initialState.problems)) {
        for (const rawProblem of initialState.problems) {
            if (!rawProblem || typeof rawProblem !== 'object') continue;
            const name = String(rawProblem.name || rawProblem.rootCause || '').trim();
            if (!name) continue;
            const openedRound = Number.isInteger(rawProblem.opened_round) ? rawProblem.opened_round : 0;
            const incomingAttempts = Array.isArray(rawProblem.attempts)
                ? rawProblem.attempts.map((a) => normalizeAttemptRecord(a))
                : [];

            // Deterministic identical root-cause deduplication on load (§3.2 & Appendix D.1)
            const existingIdx = problems.findIndex((p) => normalizeRootCauseKey(p.name) === normalizeRootCauseKey(name));
            if (existingIdx !== -1) {
                const target = problems[existingIdx];
                if (rawProblem.id && rawProblem.id !== target.id) {
                    aliases[String(rawProblem.id)] = target.id;
                }
                target.opened_round = Math.min(target.opened_round, openedRound);
                target.attempts.push(...incomingAttempts);
            } else {
                const id = rawProblem.id ? String(rawProblem.id).trim() : allocateProblemId();
                const matchNum = /^P(\d+)$/i.exec(id);
                if (matchNum) {
                    nextId = Math.max(nextId, Number(matchNum[1]) + 1);
                }
                problems.push({
                    id,
                    name,
                    opened_round: openedRound,
                    attempts: incomingAttempts
                });
            }
        }
    }

    return {
        /**
         * Resolves an entry ID through any merged aliases (e.g., `P6 -> P5`).
         * @param {string} idOrAlias
         * @returns {string|null}
         */
        resolveProblemId,

        /**
         * Records a selected harness modification attempt into SIM (`U(M_t, e_t)` in §3.2).
         * Per Eq. (3), unaccepted candidates (`accepted: false`) leave SIM unchanged unless
         * `includeRejected: true` is explicitly supplied; accepted candidates are recorded
         * even when predicted task fixes miss or overall scores regress.
         *
         * @param {Object} attemptInput
         * @returns {{ updated: boolean, problemId: string|null, createdNewProblem: boolean, attempt: Object|null }}
         */
        recordAttempt(attemptInput = {}) {
            if (!attemptInput || typeof attemptInput !== 'object') {
                throw new Error('[SIM] recordAttempt requires an attempt object.');
            }

            if (attemptInput.accepted === false && attemptInput.includeRejected !== true) {
                return { updated: false, problemId: null, createdNewProblem: false, attempt: null };
            }

            const attempt = normalizeAttemptRecord({
                ...attemptInput,
                computeMissedFromFixed: Array.isArray(attemptInput.fixed) && !Array.isArray(attemptInput.missed)
            });

            let targetIdx = -1;
            if (attemptInput.problemId) {
                const resolved = resolveProblemId(String(attemptInput.problemId));
                targetIdx = problems.findIndex((p) => p.id === resolved);
            }

            const rootCause = String(attemptInput.rootCause || attemptInput.name || '').trim();
            if (targetIdx === -1 && rootCause) {
                targetIdx = problems.findIndex(
                    (p) => normalizeRootCauseKey(p.name) === normalizeRootCauseKey(rootCause)
                );
            }

            let createdNewProblem = false;
            if (targetIdx === -1) {
                if (!rootCause) {
                    throw new Error('[SIM] New problem entry requires a non-empty `rootCause` (or existing `problemId`).');
                }
                const id = allocateProblemId();
                problems.push({
                    id,
                    name: rootCause,
                    opened_round: attempt.round,
                    attempts: [attempt]
                });
                targetIdx = problems.length - 1;
                createdNewProblem = true;
            } else {
                problems[targetIdx].attempts.push(attempt);
            }

            return {
                updated: true,
                problemId: problems[targetIdx].id,
                createdNewProblem,
                attempt: cloneJson(attempt)
            };
        },

        /**
         * Merges `sourceId` into `targetId`, preserving all attempts in `(round, sample)` order
         * and recording `aliases[sourceId] = targetId` (Appendix D.3).
         *
         * @param {string} sourceId
         * @param {string} targetId
         * @returns {{ merged: boolean, targetId: string, aliases: Object }}
         */
        mergeProblems(sourceId, targetId) {
            const resolvedSource = resolveProblemId(sourceId);
            const resolvedTarget = resolveProblemId(targetId);
            if (!resolvedSource || !resolvedTarget) {
                throw new Error('[SIM] mergeProblems requires valid sourceId and targetId.');
            }
            if (resolvedSource === resolvedTarget) {
                return { merged: false, targetId: resolvedTarget, aliases: { ...aliases } };
            }

            const sourceIdx = problems.findIndex((p) => p.id === resolvedSource);
            const targetIdx = problems.findIndex((p) => p.id === resolvedTarget);
            if (sourceIdx === -1 || targetIdx === -1) {
                throw new Error(`[SIM] Cannot merge unknown problem IDs: "${sourceId}" -> "${targetId}"`);
            }

            const sourceEntry = problems[sourceIdx];
            const targetEntry = problems[targetIdx];
            targetEntry.opened_round = Math.min(targetEntry.opened_round, sourceEntry.opened_round);
            targetEntry.attempts = [...targetEntry.attempts, ...sourceEntry.attempts].sort(
                (a, b) => (a.round - b.round) || (a.sample - b.sample)
            );

            problems.splice(sourceIdx, 1);
            aliases[resolvedSource] = resolvedTarget;
            for (const [aliasKey, aliasVal] of Object.entries(aliases)) {
                if (aliasVal === resolvedSource) {
                    aliases[aliasKey] = resolvedTarget;
                }
            }

            return { merged: true, targetId: resolvedTarget, aliases: { ...aliases } };
        },

        /**
         * Looks up a problem entry by ID, alias, or exact normalized root-cause text.
         * @param {string} idOrName
         * @returns {Object|null}
         */
        getProblem(idOrName) {
            const idx = findProblemIndex(idOrName);
            return idx === -1 ? null : cloneJson(problems[idx]);
        },

        /**
         * Produces a transferred SIM instance under one of the four CRSI conditions (§3.3):
         * - `cold_start` / `harness_transfer`: empty SIM `(H, ∅)`
         * - `problem_only`: root-cause hypotheses without attempts `(H_S, M_S^c)`
         * - `full_sim`: full problem & counterfactual outcome history `(H_S, M_S)`
         *
         * @param {Object} [options={}]
         * @returns {Object} Transferred SelfImprovementMemory instance.
         */
        transferTo(options = {}) {
            const {
                arm = 'source_rsi',
                domain = 'default',
                into = 'target_rsi',
                mode = SIM_TRANSFER_MODES.FULL_SIM
            } = options;

            if (!Object.values(SIM_TRANSFER_MODES).includes(mode)) {
                throw new Error(
                    `[SIM] Unknown transfer mode: "${mode}". Valid modes: ${Object.values(SIM_TRANSFER_MODES).join(', ')}`
                );
            }

            const provenanceHeader = mode === SIM_TRANSFER_MODES.COLD_START
                ? null
                : { arm, domain, into, mode };

            if (mode === SIM_TRANSFER_MODES.COLD_START || mode === SIM_TRANSFER_MODES.HARNESS_TRANSFER) {
                return createSelfImprovementMemory({
                    next_id: 1,
                    carried_from: provenanceHeader,
                    aliases: {},
                    problems: []
                });
            }

            if (mode === SIM_TRANSFER_MODES.PROBLEM_ONLY) {
                return createSelfImprovementMemory({
                    next_id: nextId,
                    carried_from: provenanceHeader,
                    aliases: { ...aliases },
                    problems: problems.map((p) => ({
                        id: p.id,
                        name: p.name,
                        opened_round: p.opened_round,
                        attempts: []
                    }))
                });
            }

            return createSelfImprovementMemory({
                next_id: nextId,
                carried_from: provenanceHeader,
                aliases: { ...aliases },
                problems: cloneJson(problems)
            });
        },

        /**
         * Returns aggregate diagnostics across stored problems and attempts.
         * @returns {Object}
         */
        getSummary() {
            let totalAttempts = 0;
            let unresolvedPredictionsCount = 0;
            const models = new Set();
            const benchmarks = new Set();
            const domains = new Set();

            for (const p of problems) {
                for (const a of p.attempts) {
                    totalAttempts += 1;
                    unresolvedPredictionsCount += a.missed.length;
                    if (a.policyModel) models.add(a.policyModel);
                    if (a.benchmark) benchmarks.add(a.benchmark);
                    if (a.domain) domains.add(a.domain);
                }
            }

            return {
                problemCount: problems.length,
                totalAttempts,
                aliasCount: Object.keys(aliases).length,
                unresolvedPredictionsCount,
                carriedFrom: carriedFrom ? cloneJson(carriedFrom) : null,
                domains: [...domains],
                benchmarks: [...benchmarks],
                policyModels: [...models]
            };
        },

        /**
         * Compiles the untruncated Proposer/Selector system-prompt block (§3.2, Appendix D.2 & F.5.4).
         * Never truncates entries so earlier replaced edits and unresolved predictions remain visible.
         *
         * @param {Object} [targetContext={}]
         * @returns {{ prompt: string, benchmarkShift: boolean, modelShift: boolean, summary: Object }}
         */
        compileOptimizerPrompt(targetContext = {}) {
            const {
                targetDomain = null,
                targetBenchmark = null,
                targetPolicyModel = null
            } = targetContext;

            const summary = this.getSummary();
            const benchmarkShift = Boolean(
                targetBenchmark &&
                summary.benchmarks.length > 0 &&
                summary.benchmarks.some((b) => b !== targetBenchmark)
            );
            const modelShift = Boolean(
                targetPolicyModel &&
                summary.policyModels.length > 0 &&
                summary.policyModels.some((m) => m !== targetPolicyModel)
            );

            const advisories = [];
            if (benchmarkShift) {
                advisories.push(
                    `BENCHMARK_SHIFT_DETECTED (${summary.benchmarks.join(', ')} -> ${targetBenchmark}): Retain transferable rationale, but re-verify completion gate sufficiency (e.g., execution success vs. optimality/rubric compliance).`
                );
            }
            if (modelShift) {
                advisories.push(
                    `MODEL_SHIFT_DETECTED (${summary.policyModels.join(', ')} -> ${targetPolicyModel}): Preserve model-independent deliverable/state checks, but re-evaluate parser repairs and re-calibrate budget triggers (e.g., wall-clock vs. step-ratio thresholds).`
                );
            }
            if (targetDomain && summary.domains.length > 0 && !summary.domains.includes(targetDomain)) {
                advisories.push(
                    `DOMAIN_SHIFT_DETECTED (${summary.domains.join(', ')} -> ${targetDomain}): Down-weight task-specific heuristics when both benchmark and model context differ.`
                );
            }

            const rulesBlock = SIM_GUIDANCE_RULES.map((rule, idx) => `${idx + 1}. ${rule}`).join('\n');
            const advisoryBlock = advisories.length > 0
                ? `\n### Transition Advisories\n${advisories.map((line) => `- ${line}`).join('\n')}\n`
                : '';

            const recordJson = JSON.stringify(this.toJSON(), null, 2);
            const prompt = [
                '## Self-Improvement Memory (SIM — Untruncated Optimizer Record)',
                '### Proposer & Selector Guidance',
                rulesBlock,
                advisoryBlock.trimEnd(),
                '### SIM Record JSON',
                recordJson
            ].filter(Boolean).join('\n\n');

            return {
                prompt,
                benchmarkShift,
                modelShift,
                summary
            };
        },

        /**
         * Exports the canonical Appendix D.3 JSON object.
         * @returns {{ next_id: number, carried_from: Object|null, aliases: Object, problems: Array<Object> }}
         */
        toJSON() {
            return {
                next_id: nextId,
                carried_from: carriedFrom ? cloneJson(carriedFrom) : null,
                aliases: { ...aliases },
                problems: cloneJson(problems)
            };
        }
    };
}

/**
 * Creates a ModularRSI Harness instance with integrated Self-Improvement Memory (SIM).
 *
 * @param {Object} [initialSpecs={}] - Optional custom initial module specs.
 * @param {Object} [options={}] - Optional CRSI/SIM context (`{ sim, domain, benchmark, policyModel }`).
 * @returns {Object} ModularRsiHarness instance.
 */
export function createModularRsiHarness(initialSpecs = {}, options = {}) {
    const moduleSpecs = {
        [RSI_MODULES.AGENT_LOOP]: { ...DEFAULT_HARNESS_SPECS[RSI_MODULES.AGENT_LOOP], ...(initialSpecs[RSI_MODULES.AGENT_LOOP] || {}) },
        [RSI_MODULES.TOOL_USE]: { ...DEFAULT_HARNESS_SPECS[RSI_MODULES.TOOL_USE], ...(initialSpecs[RSI_MODULES.TOOL_USE] || {}) },
        [RSI_MODULES.OBSERVATION_MGMT]: { ...DEFAULT_HARNESS_SPECS[RSI_MODULES.OBSERVATION_MGMT], ...(initialSpecs[RSI_MODULES.OBSERVATION_MGMT] || {}) },
        [RSI_MODULES.CONTEXT_MGMT]: { ...DEFAULT_HARNESS_SPECS[RSI_MODULES.CONTEXT_MGMT], ...(initialSpecs[RSI_MODULES.CONTEXT_MGMT] || {}) },
        [RSI_MODULES.TASK_COMPLETION]: { ...DEFAULT_HARNESS_SPECS[RSI_MODULES.TASK_COMPLETION], ...(initialSpecs[RSI_MODULES.TASK_COMPLETION] || {}) }
    };

    const harnessContext = {
        domain: options.domain || 'default',
        benchmark: options.benchmark || null,
        policyModel: options.policyModel || null
    };

    const sim = options.sim && typeof options.sim.recordAttempt === 'function'
        ? options.sim
        : createSelfImprovementMemory(options.sim || {});

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
         * Applies a recursive self-improvement patch to a targeted harness module,
         * and optionally records the structured counterfactual SIM entry (arXiv:2611.18856).
         *
         * @param {string} moduleName
         * @param {Object} patchConfig
         * @param {string} [rationale='']
         * @param {Object|null} [simMeta=null] - Optional SIM metadata (`{ problemId, rootCause, round, sample, predicted, fixed, missed, afterPassed, beforePassed, passed, total, files, domain, benchmark, policyModel }`).
         * @returns {{ updatedSpec: Object, version: number, simEntry: Object|null }}
         */
        applyRsiPatch(moduleName, patchConfig = {}, rationale = '', simMeta = null) {
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
            const timestamp = new Date().toISOString();

            const evolutionRecord = {
                moduleName,
                fromVersion: current.version,
                toVersion: newVersion,
                patch: patchConfig,
                rationale,
                timestamp
            };
            evolutionHistory.push(evolutionRecord);

            let simEntry = null;
            if (simMeta && typeof simMeta === 'object') {
                const defaultRootCause = simMeta.rootCause || simMeta.name || `${moduleName}_deficiency`;
                simEntry = sim.recordAttempt({
                    ...simMeta,
                    rootCause: defaultRootCause,
                    what: simMeta.what || `Patched ${moduleName} v${current.version}->v${newVersion}: ${JSON.stringify(patchConfig)}`,
                    rationale: simMeta.rationale || rationale,
                    domain: simMeta.domain || harnessContext.domain,
                    benchmark: simMeta.benchmark ?? harnessContext.benchmark,
                    policyModel: simMeta.policyModel ?? harnessContext.policyModel,
                    moduleName,
                    timestamp
                });
            }

            return {
                updatedSpec: { ...updatedSpec },
                version: newVersion,
                simEntry
            };
        },

        /**
         * Gets the full audit trail of recursive self-improvement patches.
         * @returns {Array<Object>}
         */
        getEvolutionHistory() {
            return [...evolutionHistory];
        },

        /**
         * Gets the attached Self-Improvement Memory (SIM) instance.
         * @returns {Object}
         */
        getSim() {
            return sim;
        },

        /**
         * Continues harness optimization into a new dataset or policy-model setting
         * under one of the four CRSI transfer modes (`cold_start`, `harness_transfer`,
         * `problem_only`, `full_sim`).
         *
         * @param {Object} [transferOptions={}]
         * @returns {Object} Target-stage ModularRsiHarness instance.
         */
        continueHarness(transferOptions = {}) {
            const {
                mode = SIM_TRANSFER_MODES.FULL_SIM,
                arm = harnessContext.benchmark || 'source_rsi',
                domain = transferOptions.targetDomain || harnessContext.domain,
                into = transferOptions.benchmark || 'target_rsi',
                benchmark = harnessContext.benchmark,
                policyModel = harnessContext.policyModel,
                seedSpecs = {}
            } = transferOptions;

            const transferredSim = sim.transferTo({ arm, domain, into, mode });
            const nextSpecs = mode === SIM_TRANSFER_MODES.COLD_START
                ? seedSpecs
                : this.getAllSpecs();

            return createModularRsiHarness(nextSpecs, {
                sim: transferredSim,
                domain,
                benchmark,
                policyModel
            });
        }
    };
}
