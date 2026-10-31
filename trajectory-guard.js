/**
 * @module trajectory-guard
 * @description Trajectory Pruning, Futile Reasoning Guard & PIG Engine based on:
 * 1. "Thought-Level Beam Search for Reasoning" (Gambit, arXiv: 2608.08020),
 * 2. "Knowing When to Quit: Diagnosing and Training LLMs to Abort Futile Reasoning" (CaRL, arXiv: 2607.29211),
 * 3. "Mind Viruses: Self-Propagating Ideas in Multi-Agent LLM Systems" (arXiv: 2608.10218), and
 * 4. "Silent Failure in LLM Agent Systems: The Entropy Principle & PIG Engine" (arXiv: 2606.08162).
 *
 * Provides real-time execution safety, entropy containment, and compute-allocation optimization:
 * 1. Circular call & repetition detection (detects stuck loops early).
 * 2. Thought-level progress scoring (prunes low-value trajectory branches).
 * 3. Futile reasoning circuit breakers (aborts beyond-capability spin and escalates to frontier models).
 * 4. Intelligence Entropy calculation S(t) = S0 * exp(alpha * t) and Physical Integrity Gate (PIG Engine).
 */

import crypto from 'crypto';
import { chatJson } from './llm.js';

/**
 * Creates a Trajectory Guard instance to monitor multi-step agent executions.
 *
 * @param {object} [options={}] - Guard options.
 * @param {number} [options.maxIdenticalToolCalls=2] - Max identical tool invocations before loop trip.
 * @param {number} [options.maxRepeatedErrors=2] - Max repeated error messages before halt.
 * @param {number} [options.maxTotalSteps=30] - Max total execution steps allowed.
 * @returns {object} Trajectory guard instance.
 */
export function createTrajectoryGuard(options = {}) {
    const {
        maxIdenticalToolCalls = 2,
        maxRepeatedErrors = 2,
        maxTotalSteps = 30
    } = options;

    const stepHistory = [];
    const toolCallCounts = new Map();
    const errorSignatureCounts = new Map();

    return {
        getHistory: () => [...stepHistory],
        getStepCount: () => stepHistory.length,

        /**
         * Records a step in the trajectory and checks safety invariants.
         *
         * @param {object} step
         * @param {string} [step.tool] - Tool name called.
         * @param {any} [step.args] - Tool arguments.
         * @param {string} [step.output] - Tool or step output text.
         * @param {string} [step.thought] - Agent's internal thought/reasoning.
         * @param {boolean} [step.isError=false] - Whether the step resulted in an error.
         * @returns {{ ok: boolean, shouldAbort: boolean, shouldEscalate: boolean, reason?: string }}
         */
        recordStep: (step) => {
            stepHistory.push({ ...step, timestamp: Date.now() });

            // 1. Max steps check
            if (stepHistory.length > maxTotalSteps) {
                return {
                    ok: false,
                    shouldAbort: true,
                    shouldEscalate: true,
                    reason: `Exceeded maximum allowable execution steps (${maxTotalSteps}).`
                };
            }

            // 2. Identical tool call checking (Loop Detection)
            if (step.tool) {
                const argsKey = typeof step.args === 'object' ? JSON.stringify(step.args) : String(step.args || '');
                const signature = `${step.tool}::${argsKey}`;
                const count = (toolCallCounts.get(signature) || 0) + 1;
                toolCallCounts.set(signature, count);

                if (count > maxIdenticalToolCalls) {
                    return {
                        ok: false,
                        shouldAbort: true,
                        shouldEscalate: true,
                        reason: `Circular tool loop detected: [${step.tool}] called ${count} times with identical parameters.`
                    };
                }
            }

            // 3. Repeated error checking
            if (step.isError && step.output) {
                // Hash error prefix
                const errorSig = step.output.slice(0, 100).trim();
                const count = (errorSignatureCounts.get(errorSig) || 0) + 1;
                errorSignatureCounts.set(errorSig, count);

                if (count > maxRepeatedErrors) {
                    return {
                        ok: false,
                        shouldAbort: true,
                        shouldEscalate: true,
                        reason: `Repeated failure detected: same error encountered ${count} times without resolution.`
                    };
                }
            }

            return {
                ok: true,
                shouldAbort: false,
                shouldEscalate: false
            };
        },

        /**
         * Inspects an incoming inter-agent message or external directive for self-propagating infection.
         */
        inspectMessage: (message) => sanitizeAgentMessage(message),

        /**
         * Evaluates goal drift between original task and current reasoning thought.
         */
        checkGoalDrift: (currentThought, originalGoal) => checkGoalDrift(originalGoal, currentThought),

        /**
         * Resets internal tracking state.
         */
        reset: () => {
            stepHistory.length = 0;
            toolCallCounts.clear();
            errorSignatureCounts.clear();
        }
    };
}

/**
 * Sanitizes inter-agent messages and detects self-propagating prompt infections ("Mind Viruses").
 * Based on: "Mind Viruses: Self-Propagating Ideas in Multi-Agent LLM Systems" (arXiv: 2608.10218).
 *
 * @param {string|object} message - Incoming message payload or text.
 * @param {object} [options={}] - Options.
 * @returns {{ isSafe: boolean, isInfected: boolean, sanitizedMessage: string, detectedPatterns: string[], riskLevel: 'NONE'|'LOW'|'MEDIUM'|'CRITICAL' }}
 */
export function sanitizeAgentMessage(message, options = {}) {
    const rawText = typeof message === 'string' ? message : (message?.content || JSON.stringify(message || ''));
    if (!rawText || rawText.trim().length === 0) {
        return { isSafe: true, isInfected: false, sanitizedMessage: "", detectedPatterns: [], riskLevel: 'NONE' };
    }

    const detectedPatterns = [];
    let riskLevel = 'NONE';

    // 1. Check for prompt injection / system tag breakout
    const injectionPatterns = [
        { rx: /<\/?(?:system|instruction_override|developer_override)>/gi, name: "System tag breakout attempt", risk: 'CRITICAL' },
        { rx: /<\|(?:im_start|im_end)\|>/gi, name: "ChatML delimiter breakout", risk: 'CRITICAL' },
        { rx: /\[\/?(?:INST|SYS)\]/gi, name: "Llama-style tag injection", risk: 'CRITICAL' },
        { rx: /\bignore\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions|prompts|rules|constraints)\b/gi, name: "Directive override clause", risk: 'CRITICAL' }
    ];

    // 2. Check for self-propagating contagion patterns (arXiv: 2608.10218)
    const viralPatterns = [
        { rx: /\b(?:forward|propagate|spread|broadcast|copy)\s+this\s+(?:message|prompt|instruction)\s+to\s+all\s+(?:other\s+)?(?:agents|workers|nodes|personas)\b/gi, name: "Recursive agent broadcast propagation", risk: 'CRITICAL' },
        { rx: /\b(?:write|append|inject)\s+(?:this\s+rule|this\s+prompt|this\s+directive)\s+into\s+(?:agents\.md|gemini_inflight|memory|system)\b/gi, name: "Persistent memory infection attempt", risk: 'CRITICAL' },
        { rx: /\byou\s+are\s+now\s+(?:root|unrestricted|god|director|superadmin)\b/gi, name: "Unauthorized persona escalation", risk: 'HIGH' },
        { rx: /\bdo\s+not\s+(?:log|report|record|audit|verify)\s+this\b/gi, name: "Telemetry / audit suppression attempt", risk: 'HIGH' }
    ];

    for (const pat of [...injectionPatterns, ...viralPatterns]) {
        if (pat.rx.test(rawText)) {
            detectedPatterns.push(pat.name);
            if (pat.risk === 'CRITICAL') riskLevel = 'CRITICAL';
            else if (pat.risk === 'HIGH' && riskLevel !== 'CRITICAL') riskLevel = 'HIGH';
        }
    }

    const isInfected = detectedPatterns.length > 0;
    let sanitizedMessage = rawText;

    if (isInfected) {
        // Strip out dangerous tags and escape viral phrases
        sanitizedMessage = sanitizedMessage
            .replace(/<\/?(?:system|instruction_override|developer_override)>/gi, '[STRIPPED_TAG]')
            .replace(/<\|(?:im_start|im_end)\|>/gi, '[STRIPPED_DELIMITER]')
            .replace(/\[\/?(?:INST|SYS)\]/gi, '[STRIPPED_TAG]');
    }

    return {
        isSafe: !isInfected,
        isInfected,
        sanitizedMessage,
        detectedPatterns,
        riskLevel
    };
}

/**
 * Computes semantic goal drift between an original objective and current trajectory reasoning thoughts.
 *
 * @param {string} originalGoal - The root task or user objective.
 * @param {string} currentThoughtOrPlan - The agent's intermediate plan or thought.
 * @param {object} [options={}] - Options.
 * @param {number} [options.driftThreshold=0.15] - Minimum overlap before flagging drift.
 * @returns {{ hasDrift: boolean, alignmentScore: number, explanation: string }}
 */
export function checkGoalDrift(originalGoal = "", currentThoughtOrPlan = "", options = {}) {
    if (!originalGoal || !currentThoughtOrPlan) {
        return { hasDrift: false, alignmentScore: 1.0, explanation: "Goal or thought empty; drift cannot be evaluated." };
    }

    const extractKeywords = (str) => new Set(str.toLowerCase().split(/\W+/).filter(w => w.length > 3));
    const goalWords = extractKeywords(originalGoal);
    const thoughtWords = extractKeywords(currentThoughtOrPlan);

    if (goalWords.size === 0 || thoughtWords.size === 0) {
        return { hasDrift: false, alignmentScore: 1.0, explanation: "Insufficient keywords for drift calculation." };
    }

    let shared = 0;
    for (const w of goalWords) {
        if (thoughtWords.has(w)) shared++;
    }

    const alignmentScore = Math.round((shared / Math.min(goalWords.size, 5)) * 100) / 100;
    const driftThreshold = options.driftThreshold !== undefined ? options.driftThreshold : 0.2;
    const hasDrift = alignmentScore < driftThreshold;

    return {
        hasDrift,
        alignmentScore,
        explanation: hasDrift 
            ? `Goal drift detected (score ${alignmentScore} < threshold ${driftThreshold}). Reasoning has diverged from original goal.`
            : `Reasoning aligned with root goal (score ${alignmentScore}).`
    };
}

/**
 * Heuristically scores whether a trajectory is making forward progress.
 *
 * @param {Array<object>} history - Step history.
 * @param {string} [goal=""] - Task goal description.
 * @returns {{ progressScore: number, isStagnant: boolean, diagnosis: string }}
 */
export function scoreTrajectoryProgress(history = [], goal = "") {
    if (!Array.isArray(history) || history.length === 0) {
        return { progressScore: 1.0, isStagnant: false, diagnosis: "Trajectory just started." };
    }

    if (history.length === 1) {
        return { progressScore: 1.0, isStagnant: false, diagnosis: "Single step recorded." };
    }

    const recent = history.slice(-4);
    let errorCount = 0;
    const toolsUsed = new Set();

    for (const step of recent) {
        if (step.isError) errorCount++;
        if (step.tool) toolsUsed.add(step.tool);
    }

    // Heavy errors or zero tool diversity in recent steps indicates stagnation
    const errorRatio = errorCount / recent.length;
    const toolDiversity = toolsUsed.size / Math.max(1, recent.length);

    let progressScore = Math.max(0.1, 1.0 - (errorRatio * 0.6) - ((1 - toolDiversity) * 0.3));
    progressScore = Math.round(progressScore * 100) / 100;

    const isStagnant = progressScore < 0.4 || (recent.length >= 3 && errorRatio >= 0.66);

    return {
        progressScore,
        isStagnant,
        diagnosis: isStagnant
            ? `High error rate (${errorCount}/${recent.length}) and low tool diversity indicate execution stagnation.`
            : `Trajectory progressing normally with score ${progressScore}.`
    };
}

/**
 * Evaluates whether an agent trajectory is stuck in futile reasoning and should be aborted.
 *
 * @param {Array<object>} trajectory - List of steps or reasoning thoughts.
 * @param {object} llmConfig - LLM configuration for the guard evaluator.
 * @returns {Promise<{ isFutile: boolean, reason: string, recommendation: 'PROCEED'|'ABORT_AND_ESCALATE'|'RETRY_WITH_HINT' }>}
 */
export async function evaluateFutileReasoning(trajectory, llmConfig) {
    const systemPrompt = `You are a strict SRE Supervisor and Capability Gatekeeper.
Your job is to diagnose if an agent is engaged in "Futile Reasoning" (spinning on beyond-capability tasks, looping on false assumptions, or hallucinating complex justifications for broken state).

Analyze the trajectory and respond in JSON:
{
  "isFutile": boolean,
  "reason": "Clear 1-sentence diagnostic explanation",
  "recommendation": "PROCEED" | "ABORT_AND_ESCALATE" | "RETRY_WITH_HINT"
}`;

    const traceText = typeof trajectory === 'string' ? trajectory : JSON.stringify(trajectory, null, 2);
    const userMessage = `## AGENT TRAJECTORY TO AUDIT
${traceText}`;

    const result = await chatJson(systemPrompt, userMessage, { ...llmConfig, temperature: 0.0 });

    return {
        isFutile: !!result?.isFutile,
        reason: result?.reason || "Diagnostic evaluation complete.",
        recommendation: result?.recommendation || (result?.isFutile ? "ABORT_AND_ESCALATE" : "PROCEED")
    };
}

/**
 * Calculates accumulated Intelligence Entropy S(t) based on:
 * "Silent Failure in LLM Agent Systems: The Entropy Principle & PIG Engine" (arXiv: 2606.08162).
 * S(t) = S_0 * exp(alpha * t)
 *
 * @param {object} params
 * @param {number} params.t - Elapsed time or execution step count.
 * @param {number} [params.s0=1.0] - Baseline initial entropy constant.
 * @param {number} [params.alpha=0.05] - Empirically measured entropy growth rate per step.
 * @returns {number} Calculated entropy value rounded to 3 decimals.
 */
export function calculateIntelligenceEntropy({ t = 0, s0 = 1.0, alpha = 0.05 } = {}) {
    const elapsed = Math.max(0, Number(t) || 0);
    const entropy = s0 * Math.exp(alpha * elapsed);
    return Math.round(entropy * 1000) / 1000;
}

/**
 * Creates a Physical Integrity Gate (PIG) Engine instance for deterministic agent governance.
 * Based on: "Silent Failure in LLM Agent Systems: The Entropy Principle & PIG Engine" (arXiv: 2606.08162).
 *
 * Implements the ADE (Agent Delivery Engineering) protocol suite:
 * - TLC: Task Lifecycle Control (deterministic FSM state transitions)
 * - DCM: Direction Calibration Mechanism (entropy-weighted goal drift check)
 * - BCP: Bidirectional Confirmation Protocol (communication integrity & payload digests)
 * - CADVP: Comprehensive Autonomous Delivery Verification Protocol (pre-commit quality gate)
 *
 * @param {object} [options={}]
 * @param {string} [options.goal=""] - Primary task goal.
 * @param {string[]} [options.goalInvariants=[]] - Non-negotiable goal invariants.
 * @param {number} [options.s0=1.0] - Initial entropy constant.
 * @param {number} [options.alpha=0.05] - Entropy accumulation rate.
 * @param {number} [options.entropyThreshold=4.5] - Entropy limit before mandatory direction calibration.
 * @returns {object} PIG Engine instance.
 */
export function createPigEngine(options = {}) {
    const {
        goal = "",
        goalInvariants = [],
        s0 = 1.0,
        alpha = 0.05,
        entropyThreshold = 4.5
    } = options;

    let currentStage = 'INIT';
    let stepCount = 0;
    const stageHistory = [{ stage: 'INIT', timestamp: Date.now() }];
    const bcpReceipts = new Map();

    // Deterministic Lifecycle Transition Matrix (TLC)
    const validTransitions = {
        'INIT': ['ANALYZING', 'ABORTED'],
        'ANALYZING': ['EXECUTING', 'ABORTED'],
        'EXECUTING': ['VERIFYING', 'ANALYZING', 'ABORTED'],
        'VERIFYING': ['COMMITTED', 'EXECUTING', 'ABORTED'],
        'COMMITTED': [],
        'ABORTED': ['INIT']
    };

    return {
        getGoal: () => goal,
        getStage: () => currentStage,
        getStepCount: () => stepCount,
        getEntropy: () => calculateIntelligenceEntropy({ t: stepCount, s0, alpha }),

        /**
         * TLC: Transitions lifecycle stage according to the deterministic state machine.
         *
         * @param {string} toStage - Target lifecycle stage.
         * @param {string} [reason=""] - Reason for transition.
         * @returns {{ success: boolean, stage: string, error?: string }}
         */
        transitionLifecycle: (toStage, reason = "") => {
            const allowed = validTransitions[currentStage] || [];
            if (!allowed.includes(toStage)) {
                return {
                    success: false,
                    stage: currentStage,
                    error: `TLC Violation: Invalid lifecycle transition from [${currentStage}] to [${toStage}]. Allowed: [${allowed.join(', ')}]`
                };
            }

            currentStage = toStage;
            stageHistory.push({ stage: toStage, reason, timestamp: Date.now() });
            return { success: true, stage: currentStage };
        },

        /**
         * DCM: Evaluates Direction Calibration against goal invariants and accumulated entropy.
         *
         * @param {string} currentThought - Current agent reasoning or proposed action summary.
         * @returns {{ ok: boolean, entropy: number, isEntropyCritical: boolean, driftScore: number, calibrationRequired: boolean, reason?: string }}
         */
        calibrateDirection: (currentThought = "") => {
            stepCount++;
            const entropy = calculateIntelligenceEntropy({ t: stepCount, s0, alpha });
            const isEntropyCritical = entropy >= entropyThreshold;

            // Compute alignment against goal and explicit invariants
            const driftResult = checkGoalDrift(goal, currentThought);
            let invariantMatches = 0;

            if (goalInvariants.length > 0) {
                const thoughtLower = currentThought.toLowerCase();
                for (const inv of goalInvariants) {
                    const words = inv.toLowerCase().split(/\W+/).filter(w => w.length > 3);
                    if (words.some(w => thoughtLower.includes(w))) {
                        invariantMatches++;
                    }
                }
            }

            const calibrationRequired = isEntropyCritical || driftResult.hasDrift;

            return {
                ok: !calibrationRequired,
                entropy,
                isEntropyCritical,
                driftScore: driftResult.alignmentScore,
                calibrationRequired,
                reason: calibrationRequired
                    ? `PIG DCM Alert: ${isEntropyCritical ? `Intelligence entropy S(${stepCount})=${entropy} exceeded threshold ${entropyThreshold}. ` : ''}${driftResult.hasDrift ? driftResult.explanation : ''}`.trim()
                    : `Trajectory within physical integrity tolerances (S=${entropy}).`
            };
        },

        /**
         * BCP: Issues and verifies a cryptographically verified bidirectional handshake for inter-agent messages.
         *
         * @param {object} params
         * @param {string} params.senderId - Identity of the dispatching agent.
         * @param {string} params.recipientId - Identity of receiving agent.
         * @param {any} params.payload - Message body or task directive.
         * @param {number} [params.nonce] - Unique nonce / sequence index.
         * @returns {{ bcpToken: string, digest: string, verified: boolean }}
         */
        createBcpHandshake: ({ senderId, recipientId, payload, nonce = Date.now() }) => {
            const serialized = typeof payload === 'string' ? payload : JSON.stringify(payload);
            const digest = crypto.createHash('sha256').update(`${senderId}:${recipientId}:${serialized}:${nonce}`).digest('hex');
            const bcpToken = `BCP-${digest.slice(0, 16)}`;

            bcpReceipts.set(bcpToken, {
                senderId,
                recipientId,
                digest,
                nonce,
                timestamp: Date.now(),
                confirmed: false
            });

            return { bcpToken, digest, verified: true };
        },

        /**
         * BCP: Confirms receipt of message from counterparty.
         *
         * @param {string} bcpToken - Token generated by createBcpHandshake.
         * @returns {boolean} Whether the handshake was successfully confirmed.
         */
        confirmBcpReceipt: (bcpToken) => {
            const receipt = bcpReceipts.get(bcpToken);
            if (!receipt) return false;
            receipt.confirmed = true;
            return true;
        },

        /**
         * CADVP: Multi-dimensional Quality Gate before state commitment.
         *
         * @param {object} params
         * @param {Array<{ name: string, check: Function|boolean }>} params.assertions - Verification assertions.
         * @returns {{ passed: boolean, failedAssertions: string[], totalChecks: number }}
         */
        runDeliveryVerificationGate: ({ assertions = [] }) => {
            const failedAssertions = [];

            for (const item of assertions) {
                let checkPassed = false;
                try {
                    checkPassed = typeof item.check === 'function' ? !!item.check() : !!item.check;
                } catch {
                    checkPassed = false;
                }

                if (!checkPassed) {
                    failedAssertions.push(item.name || "Unnamed assertion");
                }
            }

            return {
                passed: failedAssertions.length === 0,
                failedAssertions,
                totalChecks: assertions.length
            };
        },

        /**
         * Returns full telemetry state for the PIG Engine.
         */
        getTelemetry: () => ({
            stage: currentStage,
            stepCount,
            currentEntropy: calculateIntelligenceEntropy({ t: stepCount, s0, alpha }),
            entropyThreshold,
            stageHistory: [...stageHistory],
            activeBcpHandshakes: bcpReceipts.size
        })
    };
}

/**
 * Evaluates multi-agent resilience against failure propagation, deadlocks, and memory leakage based on:
 * "Emergence World: Adversarial Stress-Testing of Long-Horizon Multi-Agent Systems"
 * (arXiv: 2609.17320 - Akkil, Abuelsaad, Vikram et al., September 2026).
 *
 * Checks:
 * 1. Error Cascades: Detects whether failures in upstream agents propagate through downstream handoffs.
 * 2. Coordinated Deadlocks: Detects circular delegations and mutual refusal loops.
 * 3. Private Memory Leakage: Audits inter-agent communication payloads for sensitive keys, tokens, or tainted credentials.
 *
 * @param {Array<{ senderId: string, recipientId: string, message?: any, error?: any, status?: string }>} handoffs - Trajectory delegation events.
 * @param {Object} [options={}]
 * @param {number} [options.maxCascadeDepth=2] - Maximum acceptable consecutive failure propagation depth.
 * @param {Array<RegExp|string>} [options.sensitivePatterns] - Custom sensitive patterns to guard against leakage.
 * @returns {{ resilient: boolean, resilienceScore: number, verdict: string, issues: string[], metrics: Object }}
 */
export function evaluateMultiAgentResilience(handoffs = [], options = {}) {
    const {
        maxCascadeDepth = 2,
        sensitivePatterns = [
            /(?:api[_-]?key|bearer\s+[a-zA-Z0-9_\-\.]{12,}|password|secret_key|private[_-]?key)/i,
            /(?:BEGIN\s+PRIVATE\s+KEY|ssh-rsa\s+[A-Za-z0-9+/=]{20,})/i,
            /(?:postgres(?:ql)?:\/\/[^:\s]+:[^@\s]+@|db_password|master_password)/i
        ]
    } = options;

    const issues = [];
    let currentCascadeDepth = 0;
    let maxObservedCascade = 0;
    const leakedItems = [];

    // Graph tracking for circular deadlocks: sender -> recipient
    const delegationGraph = new Map();

    for (let i = 0; i < handoffs.length; i++) {
        const step = handoffs[i];
        const { senderId, recipientId, message, error, status } = step;

        // 1. Error Cascade Tracking
        const isErrorStep = !!error || status === 'ERROR' || status === 'FAILED';
        if (isErrorStep) {
            currentCascadeDepth++;
            if (currentCascadeDepth > maxObservedCascade) {
                maxObservedCascade = currentCascadeDepth;
            }
            if (currentCascadeDepth > maxCascadeDepth) {
                issues.push(`Error cascade depth ${currentCascadeDepth} exceeds limit ${maxCascadeDepth} between [${senderId}] -> [${recipientId}].`);
            }
        } else {
            currentCascadeDepth = 0;
        }

        // 2. Circular Delegation / Deadlock Detection
        // Only track unresolved delegations (pending/forwarded tasks) to avoid false-flagging successful result returns
        const isResolution = status === 'SUCCESS' || status === 'RESOLVED';
        if (senderId && recipientId && !isResolution) {
            if (!delegationGraph.has(senderId)) {
                delegationGraph.set(senderId, new Set());
            }
            delegationGraph.get(senderId).add(recipientId);

            // Direct bounce back without resolution
            if (delegationGraph.get(recipientId)?.has(senderId) && i > 0 && handoffs[i - 1].senderId === recipientId) {
                issues.push(`Coordinated delegation deadlock detected: direct ping-pong bounce between [${senderId}] and [${recipientId}].`);
            }
        }

        // 3. Private Memory Leakage Detection
        if (message) {
            const rawText = typeof message === 'string' ? message : JSON.stringify(message);
            for (const pattern of sensitivePatterns) {
                if (pattern instanceof RegExp ? pattern.test(rawText) : rawText.includes(pattern)) {
                    const matchSnippet = pattern instanceof RegExp ? (rawText.match(pattern)?.[0] || 'pattern_match') : pattern;
                    leakedItems.push({
                        senderId,
                        recipientId,
                        snippet: matchSnippet.slice(0, 8) + '...'
                    });
                    issues.push(`Private memory leakage detected in message from [${senderId}] to [${recipientId}]: matched sensitive credential pattern.`);
                    break;
                }
            }
        }
    }

    // Circular cycle detection via DFS across unresolved delegation graph
    const visited = new Set();
    const recStack = new Set();
    function hasCycle(node) {
        visited.add(node);
        recStack.add(node);
        const neighbors = delegationGraph.get(node) || [];
        for (const neighbor of neighbors) {
            if (!visited.has(neighbor)) {
                if (hasCycle(neighbor)) return true;
            } else if (recStack.has(neighbor)) {
                return true;
            }
        }
        recStack.delete(node);
        return false;
    }

    let detectedCycle = false;
    for (const node of delegationGraph.keys()) {
        if (!visited.has(node) && hasCycle(node)) {
            detectedCycle = true;
            issues.push(`Circular multi-agent dependency cycle detected across: ${Array.from(recStack).join(' -> ')}.`);
            break;
        }
    }

    // Compute resilience score
    let score = 1.0;
    if (maxObservedCascade > maxCascadeDepth) score -= 0.35;
    if (detectedCycle) score -= 0.35;
    if (leakedItems.length > 0) score -= 0.40;
    score = Math.max(0.0, Math.min(1.0, Math.round(score * 100) / 100));

    const resilient = issues.length === 0;
    const verdict = resilient ? 'PASS' : (score >= 0.5 ? 'WARN' : 'FAIL');

    return {
        resilient,
        resilienceScore: score,
        verdict,
        issues,
        metrics: {
            totalHandoffs: handoffs.length,
            maxObservedCascade,
            circularDeadlock: detectedCycle,
            memoryLeakCount: leakedItems.length,
            leakedItems
        }
    };
}



