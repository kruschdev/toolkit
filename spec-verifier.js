/**
 * @module spec-verifier
 * @description Specification-First Convergence & Verification Engine based on:
 * 1. "Specification-first convergence with an AI coding agent: a case study of dismantling a core architectural invariant..." (arXiv: 2608.12440).
 * 2. "Agents Catching Agents: Shortcut Cascades and Benchmark Gaming in Clinical Multi-Agent Systems" (arXiv: 2608.03744).
 *
 * Implements a rigorous verification loop for complex multi-file architectural refactors:
 * 1. Formal Spec Freezing
 * 2. Iterative Spec-vs-Code Audits
 * 3. Independent "Referee over Judge" Re-derivation to eliminate shortcut contagion & false consensus
 * 4. Convergence Gating (requiring N consecutive passes with ZERO findings, default: 2)
 */

import crypto from 'crypto';
import { chatJson } from './llm.js';

/**
 * Checks whether an audit history meets the convergence criterion (e.g. 2 consecutive zero-finding passes).
 *
 * @param {Array<{passNumber: number, findings: Array<any>, isReferee?: boolean}>} auditHistory - List of completed audit passes.
 * @param {number} [requiredZeroPasses=2] - Number of consecutive zero-finding passes required.
 * @returns {{ isConverged: boolean, consecutiveZeroPasses: number, totalDefectsResolved: number, lastPassClean: boolean, hasRefereeVerification: boolean }}
 */
export function checkConvergence(auditHistory = [], requiredZeroPasses = 2) {
    if (!Array.isArray(auditHistory) || auditHistory.length === 0) {
        return {
            isConverged: false,
            consecutiveZeroPasses: 0,
            totalDefectsResolved: 0,
            lastPassClean: false,
            hasRefereeVerification: false
        };
    }

    let consecutiveZeroCount = 0;
    let totalDefects = 0;
    let hasRefereeVerification = false;

    for (let i = auditHistory.length - 1; i >= 0; i--) {
        const pass = auditHistory[i];
        const findingCount = Array.isArray(pass.findings) ? pass.findings.length : (pass.findings ? 1 : 0);
        
        if (findingCount === 0) {
            consecutiveZeroCount++;
            if (pass.isReferee) {
                hasRefereeVerification = true;
            }
        } else {
            break; // Stop counting consecutive zeros
        }
    }

    for (const pass of auditHistory) {
        const count = Array.isArray(pass.findings) ? pass.findings.length : (pass.findings ? 1 : 0);
        totalDefects += count;
        if (pass.isReferee && count === 0) {
            hasRefereeVerification = true;
        }
    }

    const lastPass = auditHistory[auditHistory.length - 1];
    const lastPassClean = (Array.isArray(lastPass.findings) ? lastPass.findings.length : 0) === 0;

    return {
        isConverged: consecutiveZeroCount >= requiredZeroPasses,
        consecutiveZeroPasses: consecutiveZeroCount,
        totalDefectsResolved: totalDefects,
        lastPassClean,
        hasRefereeVerification
    };
}

/**
 * Evaluates agreement between a primary auditor's findings and an independent referee's findings.
 * Detects "shortcut contagion" (arXiv: 2608.03744) where an auditor glossed over an invariant defect.
 *
 * @param {Array<object>} auditorFindings - Findings from primary auditor pass.
 * @param {Array<object>} refereeFindings - Findings from independent referee pass.
 * @returns {{ hasContagion: boolean, consensus: boolean, missedByAuditor: Array<object>, missedByReferee: Array<object>, combinedFindings: Array<object> }}
 */
export function evaluateRefereeConsensus(auditorFindings = [], refereeFindings = []) {
    const normAud = Array.isArray(auditorFindings) ? auditorFindings : [];
    const normRef = Array.isArray(refereeFindings) ? refereeFindings : [];

    // Check if auditor reported clean (0 findings) while referee discovered defects
    const auditorClean = normAud.length === 0;
    const refereeClean = normRef.length === 0;

    const missedByAuditor = [];
    const missedByReferee = [];

    // Find referee findings not captured by auditor (by file + invariant match)
    for (const rf of normRef) {
        const matched = normAud.some(af => 
            af.file === rf.file && (af.invariant === rf.invariant || af.description === rf.description)
        );
        if (!matched) {
            missedByAuditor.push(rf);
        }
    }

    // Find auditor findings not captured by referee
    for (const af of normAud) {
        const matched = normRef.some(rf => 
            rf.file === af.file && (rf.invariant === af.invariant || rf.description === af.description)
        );
        if (!matched) {
            missedByReferee.push(af);
        }
    }

    const hasContagion = auditorClean && !refereeClean;
    const consensus = (auditorClean && refereeClean) || (missedByAuditor.length === 0 && missedByReferee.length === 0);

    // Merge unique findings
    const combined = [...normAud];
    for (const item of missedByAuditor) {
        combined.push({ ...item, source: 'referee_independent' });
    }

    return {
        hasContagion,
        consensus,
        missedByAuditor,
        missedByReferee,
        combinedFindings: combined
    };
}

/**
 * Executes an automated specification-versus-code audit pass using a primary LLM auditor.
 *
 * @param {object} params
 * @param {string} params.specText - The frozen formal specification text.
 * @param {Array<{path: string, content: string}>} params.files - Codebase files to audit.
 * @param {object} params.llmConfig - LLM configuration for the auditor model (e.g. 32B or Gemini).
 * @param {number} [params.passNumber=1] - Current audit pass index.
 * @returns {Promise<{ passNumber: number, role: string, summary: string, findings: Array<{file: string, invariant: string, description: string, severity: 'CRITICAL'|'WARNING'|'NIT'}>, isClean: boolean, timestamp: string }>}
 */
export async function runAuditPass({ specText, files, llmConfig, passNumber = 1 }) {
    const systemPrompt = `You are a Principal Software Engineer acting as a strict, zero-tolerance Specification Auditor.
Your job is to compare the provided Codebase Files against the Frozen Formal Specification.

Rules:
1. Every rule, constraint, and architectural invariant in the Spec MUST be strictly upheld by the Code.
2. If code violates an invariant, introduces architectural drift, or fails to implement a required behavior, report it as a finding.
3. Be thorough and uncompromising. Do NOT assume intentions; verify concrete implementations.
4. If there are NO discrepancies or defects whatsoever, return an empty findings array.

Respond in JSON format:
{
  "passNumber": ${passNumber},
  "summary": "High-level summary of audit observations",
  "findings": [
    {
      "file": "path/to/file.js",
      "invariant": "Name or description of spec invariant violated",
      "description": "Specific defect description and exact line/logic issue",
      "severity": "CRITICAL" | "WARNING" | "NIT"
    }
  ]
}`;

    const filesPayload = files.map(f => `### File: ${f.path}\n\`\`\`\n${f.content}\n\`\`\``).join('\n\n');
    const userMessage = `## FROZEN FORMAL SPECIFICATION
${specText}

## CODEBASE IMPLEMENTATION UNDER AUDIT
${filesPayload}`;

    const result = await chatJson(systemPrompt, userMessage, { ...llmConfig, temperature: 0.1 });
    const findings = Array.isArray(result?.findings) ? result.findings : [];

    return {
        passNumber,
        role: 'primary_auditor',
        isReferee: false,
        summary: result?.summary || "Audit pass completed.",
        findings,
        isClean: findings.length === 0,
        timestamp: new Date().toISOString()
    };
}

/**
 * Executes an independent "Referee over Judge" verification pass (arXiv: 2608.03744).
 * Re-derives invariant checks directly from raw source files in complete isolation from prior agent reasoning.
 *
 * @param {object} params
 * @param {string} params.specText - The frozen formal specification text.
 * @param {Array<{path: string, content: string}>} params.files - Codebase files to audit.
 * @param {object} params.llmConfig - LLM configuration for the referee model.
 * @param {number} [params.passNumber=1] - Current audit pass index.
 * @returns {Promise<{ passNumber: number, role: string, isReferee: boolean, summary: string, findings: Array<{file: string, invariant: string, description: string, severity: 'CRITICAL'|'WARNING'|'NIT'}>, isClean: boolean, timestamp: string }>}
 */
export async function runRefereeAuditPass({ specText, files, llmConfig, passNumber = 1 }) {
    const systemPrompt = `You are an Independent Verification Referee (arXiv: 2608.03744 "Agents Catching Agents").
You are executing an ISOLATED, ZERO-TRUST re-derivation of all specification invariants against raw code files.
You have NOT been provided with any previous auditor notes or agent reasoning traces to eliminate shortcut contagion.

Rules:
1. Parse every explicit constraint, invariant, and behavioral guarantee in the Formal Specification.
2. For each invariant, independently verify line-by-line whether the Codebase Files satisfy it.
3. If an invariant is broken, missing, or partially implemented, record it with exact file and invariant references.
4. Do not assume previous passes were correct; you are the ultimate zero-trust sanity check.
5. If and only if the code completely and flawlessly adheres to all invariants, return an empty findings array.

Respond in JSON format:
{
  "passNumber": ${passNumber},
  "role": "independent_referee",
  "summary": "Independent re-derivation summary",
  "findings": [
    {
      "file": "path/to/file.js",
      "invariant": "Spec invariant violated",
      "description": "Concrete defect identified via independent re-derivation",
      "severity": "CRITICAL" | "WARNING" | "NIT"
    }
  ]
}`;

    const filesPayload = files.map(f => `### File: ${f.path}\n\`\`\`\n${f.content}\n\`\`\``).join('\n\n');
    const userMessage = `## FROZEN FORMAL SPECIFICATION (SOURCE OF TRUTH)
${specText}

## RAW CODEBASE ARTIFACTS TO INDEPENDENTLY RE-DERIVE
${filesPayload}`;

    const result = await chatJson(systemPrompt, userMessage, { ...llmConfig, temperature: 0.0 });
    const findings = Array.isArray(result?.findings) ? result.findings : [];

    return {
        passNumber,
        role: 'independent_referee',
        isReferee: true,
        summary: result?.summary || "Independent referee pass completed.",
        findings,
        isClean: findings.length === 0,
        timestamp: new Date().toISOString()
    };
}

/**
 * Creates a stateful Spec Audit Runner instance to coordinate multi-pass verification sessions.
 * Supports "Referee over Judge" (arXiv: 2608.03744) to prevent shortcut cascades.
 *
 * @param {object} [options={}] - Options.
 * @param {number} [options.requiredZeroPasses=2] - Required consecutive zero-defect passes to converge.
 * @param {number} [options.maxPasses=20] - Max allowable audit iterations before safety halt.
 * @param {'final_gate'|'alternate'|'always'|false} [options.refereeMode='final_gate'] - Referee oversight policy.
 * @returns {object} Spec Audit Runner instance.
 */
export function createSpecAuditRunner(options = {}) {
    const requiredZeroPasses = options.requiredZeroPasses || 2;
    const maxPasses = options.maxPasses || 20;
    const refereeMode = options.refereeMode !== undefined ? options.refereeMode : 'final_gate';
    const history = [];
    const contagionEvents = [];

    return {
        getHistory: () => [...history],
        getContagionEvents: () => [...contagionEvents],
        getConsecutiveZeroCount: () => checkConvergence(history, requiredZeroPasses).consecutiveZeroPasses,
        isConverged: () => checkConvergence(history, requiredZeroPasses).isConverged,

        /**
         * Records an external or manual audit pass.
         */
        recordPass: (passResult) => {
            const normalized = {
                passNumber: passResult.passNumber || history.length + 1,
                role: passResult.role || (passResult.isReferee ? 'independent_referee' : 'primary_auditor'),
                isReferee: !!passResult.isReferee,
                findings: Array.isArray(passResult.findings) ? passResult.findings : [],
                summary: passResult.summary || "",
                timestamp: passResult.timestamp || new Date().toISOString()
            };
            history.push(normalized);
            return checkConvergence(history, requiredZeroPasses);
        },

        /**
         * Executes an automated pass and updates internal history.
         * If refereeMode is enabled, dispatches independent referee re-derivation passes.
         */
        executePass: async ({ specText, files, llmConfig, refereeConfig }) => {
            if (history.length >= maxPasses) {
                throw new Error(`Max audit passes (${maxPasses}) exceeded without convergence.`);
            }

            const passNumber = history.length + 1;
            const primaryResult = await runAuditPass({ specText, files, llmConfig, passNumber });
            history.push(primaryResult);

            let status = checkConvergence(history, requiredZeroPasses);

            // Referee Gating Logic
            const shouldRunReferee = 
                (refereeMode === 'always') ||
                (refereeMode === 'alternate' && passNumber % 2 === 0) ||
                (refereeMode === 'final_gate' && primaryResult.isClean && (status.consecutiveZeroPasses >= requiredZeroPasses - 1));

            if (shouldRunReferee && history.length < maxPasses) {
                const refPassNumber = history.length + 1;
                const refConfig = refereeConfig || llmConfig;
                const refResult = await runRefereeAuditPass({ specText, files, llmConfig: refConfig, passNumber: refPassNumber });
                history.push(refResult);

                // Check for contagion
                const consensus = evaluateRefereeConsensus(primaryResult.findings, refResult.findings);
                if (consensus.hasContagion) {
                    contagionEvents.push({
                        auditorPass: primaryResult.passNumber,
                        refereePass: refResult.passNumber,
                        missedByAuditor: consensus.missedByAuditor,
                        timestamp: new Date().toISOString()
                    });
                }

                status = checkConvergence(history, requiredZeroPasses);
                return {
                    passResult: primaryResult,
                    refereeResult: refResult,
                    consensus,
                    convergenceStatus: status
                };
            }

            return {
                passResult: primaryResult,
                convergenceStatus: status
            };
        },

        /**
         * Executes an explicit independent referee pass.
         */
        executeRefereePass: async ({ specText, files, llmConfig }) => {
            if (history.length >= maxPasses) {
                throw new Error(`Max audit passes (${maxPasses}) exceeded without convergence.`);
            }
            const passNumber = history.length + 1;
            const refResult = await runRefereeAuditPass({ specText, files, llmConfig, passNumber });
            history.push(refResult);
            const status = checkConvergence(history, requiredZeroPasses);
            return {
                passResult: refResult,
                convergenceStatus: status
            };
        },

        /**
         * Generates a markdown report of the audit history.
         */
        formatReport: () => {
            const status = checkConvergence(history, requiredZeroPasses);
            let md = `# 🛡️ Spec-First Convergence Audit Report\n\n`;
            md += `> **Status:** ${status.isConverged ? '✅ CONVERGED' : '⏳ IN PROGRESS'}\n`;
            md += `> **Total Passes:** ${history.length} | **Consecutive Clean Passes:** ${status.consecutiveZeroPasses}/${requiredZeroPasses}\n`;
            md += `> **Referee Verification:** ${status.hasRefereeVerification ? '🛡️ PASSED (Zero-Trust Re-derived)' : '⚠️ PENDING'}\n`;
            if (contagionEvents.length > 0) {
                md += `> **Contagion Alerts:** 🚨 ${contagionEvents.length} shortcut contagion event(s) intercepted\n`;
            }
            md += `\n## Pass Breakdown\n\n`;

            history.forEach((h, idx) => {
                const count = h.findings.length;
                const roleBadge = h.isReferee ? '🕵️ REFEREE' : '🤖 AUDITOR';
                md += `### Pass ${h.passNumber || idx + 1} [${roleBadge}]: ${count === 0 ? '🟢 CLEAN (0 findings)' : `🔴 ${count} finding(s)`}\n`;
                if (h.summary) md += `* **Summary:** ${h.summary}\n`;
                if (count > 0) {
                    h.findings.forEach(f => {
                        md += `  - **[${f.severity || 'DEFECT'}]** \`${f.file}\`: ${f.description} *(Invariant: ${f.invariant || 'General'})*\n`;
                    });
                }
                md += `\n`;
            });

            if (contagionEvents.length > 0) {
                md += `## 🚨 Intercepted Shortcut Contagion Events\n\n`;
                contagionEvents.forEach(ce => {
                    md += `* **Pass ${ce.auditorPass} (Auditor: Clean) vs Pass ${ce.refereePass} (Referee: Caught ${ce.missedByAuditor.length} defect(s))**\n`;
                    ce.missedByAuditor.forEach(m => {
                        md += `  - \`${m.file}\`: ${m.description} *(Invariant: ${m.invariant})*\n`;
                    });
                });
                md += `\n`;
            }

            return md;
        }
    };
}

/**
 * Test-Driven Reasoning: Synthesizes an executable test contract harness from formal specifications.
 * Based on: "TDD-Agent: Test-Driven Reasoning for Code Generation" (arXiv: 2608.16742) and
 * "Executable Code Knowledge" (arXiv: 2608.16295).
 *
 * Forces the AI agent to clarify expected behaviors and failure boundaries via executable assertions before writing code.
 *
 * @param {object} params
 * @param {string} params.specText - The formal specification text.
 * @param {string} params.targetModule - Name/path of the target module being created or refactored.
 * @param {object} params.llmConfig - LLM configuration for test generation.
 * @param {string} [params.testFramework="vanilla"] - Test framework standard ("vanilla" | "node:test" | "jest").
 * @returns {Promise<{ testCode: string, testCases: Array<{name: string, invariant: string, expectedBehavior: string}>, contractHash: string }>}
 */
export async function synthesizeExecutableContract({ specText, targetModule, llmConfig, testFramework = "vanilla" }) {
    const systemPrompt = `You are a Principal Test Architect and Formal Verification Engineer (TDD-Agent arXiv: 2608.16742).
Your goal is to translate a Formal Specification into an EXECUTABLE TEST CONTRACT SUITE *prior* to writing or modifying implementation code.

Rules:
1. Every rule, constraint, and edge-case in the Spec MUST be expressed as an explicit executable test assertion.
2. Include boundary tests (null/empty inputs, oversized payloads, invalid types).
3. The tests must act as verifiable Executable Code Knowledge Units (ECKUs).
4. Return a JSON object with executable JavaScript code:
{
  "testCases": [
    { "name": "test_invariant_name", "invariant": "Spec invariant clause", "expectedBehavior": "Specific return value or thrown error" }
  ],
  "testCode": "// Complete, self-contained executable JS test script..."
}`;

    const userMessage = `## TARGET MODULE
${targetModule}

## FORMAL SPECIFICATION
${specText}

## TARGET TEST FRAMEWORK
${testFramework}`;

    const chatFn = llmConfig?.mockChatJson || chatJson;
    const result = await chatFn(systemPrompt, userMessage, { ...llmConfig, temperature: 0.1 });
    const testCode = result?.testCode || `// Auto-generated test contract for ${targetModule}\nconsole.log("No test code generated");`;
    const contractHash = crypto.createHash('sha256').update(testCode).digest('hex');

    return {
        testCode,
        testCases: Array.isArray(result?.testCases) ? result.testCases : [],
        contractHash
    };
}

/**
 * Evaluates execution test results and performs dual-track iterative refinement of both code and test contracts.
 *
 * @param {object} params
 * @param {string} params.specText - The root specification.
 * @param {string} params.testCode - The current test contract.
 * @param {string} params.implementationCode - The current implementation code.
 * @param {string} params.executionLogs - Output/stack traces from running the test suite.
 * @param {object} params.llmConfig - LLM configuration.
 * @returns {Promise<{ diagnosis: string, isBugInCode: boolean, isDefectInTest: boolean, refinedCode: string, refinedTests: string, recommendedAction: string }>}
 */
export async function evaluateDualTrackRefinement({ specText, testCode, implementationCode, executionLogs, llmConfig }) {
    const systemPrompt = `You are a Dual-Track TDD Debugging Supervisor (TDD-Agent arXiv: 2608.16742).
You are evaluating test execution logs against the Formal Spec to resolve discrepancies.

Determine whether test failures stem from:
1. Implementation defects (Code does not meet spec requirements)
2. Test contract defects (Test misinterprets spec or tests invalid assumptions)
3. Both

Respond in JSON format:
{
  "diagnosis": "Detailed 2-3 sentence analysis of root failure causes",
  "isBugInCode": boolean,
  "isDefectInTest": boolean,
  "refinedCode": "Updated implementation code (if code bug exists)",
  "refinedTests": "Updated test code (if test defect exists)",
  "recommendedAction": "APPLY_CODE_FIX" | "APPLY_TEST_FIX" | "APPLY_DUAL_FIX" | "PASSED"
}`;

    const userMessage = `## SPECIFICATION
${specText}

## CURRENT TEST CONTRACT
\`\`\`javascript
${testCode}
\`\`\`

## CURRENT IMPLEMENTATION
\`\`\`javascript
${implementationCode}
\`\`\`

## EXECUTION LOGS / TEST RESULTS
${executionLogs}`;

    const chatFn = llmConfig?.mockChatJson || chatJson;
    const result = await chatFn(systemPrompt, userMessage, { ...llmConfig, temperature: 0.1 });

    return {
        diagnosis: result?.diagnosis || "Dual-track refinement evaluation completed.",
        isBugInCode: !!result?.isBugInCode,
        isDefectInTest: !!result?.isDefectInTest,
        refinedCode: result?.refinedCode || implementationCode,
        refinedTests: result?.refinedTests || testCode,
        recommendedAction: result?.recommendedAction || "APPLY_CODE_FIX"
    };
}

