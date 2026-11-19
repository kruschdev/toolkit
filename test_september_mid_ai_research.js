/**
 * Test Suite: Mid-September 2026 AI Research Breakthroughs Integration
 * Tests ModularRSI, Grouped Value Attention (GVA) Allocator, Emergence World Resilience Gate,
 * and Diverse Skill Routing (DSR).
 */

import assert from 'assert';
import {
    createModularRsiHarness,
    createSelfImprovementMemory,
    RSI_MODULES,
    DEFAULT_HARNESS_SPECS,
    SIM_TRANSFER_MODES,
    SIM_GUIDANCE_RULES,
    calculateGvaFootprint,
    createGvaAllocator,
    evaluateMultiAgentResilience,
    routeDiverseSkills
} from './index.js';

console.log("🚀 Starting Mid-September 2026 AI Research Breakthroughs Test Suite...\n");

async function runTests() {
    let passedTests = 0;
    let totalTests = 0;

    function test(name, fn) {
        totalTests++;
        try {
            fn();
            console.log(`✔ ${name}`);
            passedTests++;
        } catch (err) {
            console.error(`❌ FAIL: ${name}`);
            console.error(err);
            process.exit(1);
        }
    }

    // =========================================================================
    // 1. ModularRSI: Modular Recursive Harness Self-Improvement (arXiv: 2609.14857)
    // =========================================================================
    console.log("--- 1. Testing ModularRSI Architecture (arXiv: 2609.14857) ---");

    test("ModularRSI: Module Initialization & Spec Isolation", () => {
        const harness = createModularRsiHarness();
        const allSpecs = harness.getAllSpecs();

        assert.ok(allSpecs[RSI_MODULES.AGENT_LOOP], "AgentLoop spec must exist");
        assert.ok(allSpecs[RSI_MODULES.TOOL_USE], "ToolUse spec must exist");
        assert.ok(allSpecs[RSI_MODULES.OBSERVATION_MGMT], "ObservationManagement spec must exist");
        assert.ok(allSpecs[RSI_MODULES.CONTEXT_MGMT], "ContextManagement spec must exist");
        assert.ok(allSpecs[RSI_MODULES.TASK_COMPLETION], "TaskCompletionDetection spec must exist");

        const toolSpec = harness.getModuleSpec(RSI_MODULES.TOOL_USE);
        assert.strictEqual(toolSpec.version, 1);
        assert.strictEqual(toolSpec.enforceSchemaTypes, true);
    });

    test("ModularRSI: Observation Management (ANSI Strip & Middle Truncation)", () => {
        const harness = createModularRsiHarness({
            [RSI_MODULES.OBSERVATION_MGMT]: { maxObservationBytes: 120, truncateMiddle: true, stripAnsiCodes: true }
        });

        const rawAnsiLog = "\x1B[32mSUCCESS\x1B[0m: " + "A".repeat(200);
        const res = harness.processObservation(rawAnsiLog);

        assert.strictEqual(res.truncated, true);
        assert.ok(!res.observation.includes('\x1B[32m'), "ANSI codes must be stripped");
        assert.ok(res.observation.includes('[TRUNCATED'), "Must include middle truncation marker");
        assert.ok(res.processedBytes <= 150, "Processed bytes must be bounded");
    });

    test("ModularRSI: Tool Use Argument Sanitization & Coercion", () => {
        const harness = createModularRsiHarness({
            [RSI_MODULES.TOOL_USE]: { enforceSchemaTypes: true, autoCoerceJsonStrings: true, allowUnknownParams: false }
        });

        const toolSchema = {
            parameters: {
                required: ["targetHost", "port", "config"],
                properties: {
                    targetHost: { type: "string" },
                    port: { type: "integer" },
                    dryRun: { type: "boolean" },
                    config: { type: "object" }
                }
            }
        };

        const rawArgs = {
            targetHost: "db-primary",
            port: "5434", // string representation of integer
            dryRun: "true", // string representation of boolean
            config: '{"timeoutMs": 5000}', // JSON string representation of object
            strayField: "unauthorized_payload" // unknown param
        };

        const result = harness.sanitizeToolArgs(toolSchema, rawArgs);
        assert.strictEqual(result.valid, true);
        assert.strictEqual(result.repairedArgs.port, 5434);
        assert.strictEqual(result.repairedArgs.dryRun, true);
        assert.deepStrictEqual(result.repairedArgs.config, { timeoutMs: 5000 });
        assert.strictEqual(result.repairedArgs.strayField, undefined, "Unknown param must be stripped");
    });

    test("ModularRSI: Task Completion Verification Gate", () => {
        const harness = createModularRsiHarness({
            [RSI_MODULES.TASK_COMPLETION]: { preventZeroStepSuccess: true, verifyAllSubtasksComplete: true, minimumConfidenceScore: 0.85 }
        });

        // Test zero-step rejection
        const zeroStep = harness.verifyTaskCompletion({ stepsRun: 0, subtasksTotal: 3, subtasksDone: 3 });
        assert.strictEqual(zeroStep.approved, false);
        assert.ok(zeroStep.reason.includes('Zero-step'));

        // Test incomplete subtasks rejection
        const incomplete = harness.verifyTaskCompletion({ stepsRun: 2, subtasksTotal: 3, subtasksDone: 2, confidence: 0.9 });
        assert.strictEqual(incomplete.approved, false);
        assert.ok(incomplete.reason.includes('Incomplete subtasks'));

        // Test low confidence rejection
        const lowConf = harness.verifyTaskCompletion({ stepsRun: 5, subtasksTotal: 3, subtasksDone: 3, confidence: 0.75 });
        assert.strictEqual(lowConf.approved, false);
        assert.ok(lowConf.reason.includes('below minimum threshold'));

        // Test valid completion
        const valid = harness.verifyTaskCompletion({ stepsRun: 4, subtasksTotal: 3, subtasksDone: 3, confidence: 0.95 });
        assert.strictEqual(valid.approved, true);
    });

    test("ModularRSI: Contrastive Failure Attribution & Targeted Patch Synthesis", () => {
        const harness = createModularRsiHarness();

        // 1. Tool argument failure attribution
        const toolFail = harness.attributeFailure({ malformedToolCalls: 2, errorMessage: "Invalid schema parameter" });
        assert.strictEqual(toolFail.attributedModule, RSI_MODULES.TOOL_USE);
        assert.strictEqual(toolFail.deficiencyType, "SCHEMA_ARGUMENT_ERROR");

        // 2. Premature termination attribution
        const prematureFail = harness.attributeFailure({ prematureExit: true, subtasksRemaining: 1 });
        assert.strictEqual(prematureFail.attributedModule, RSI_MODULES.TASK_COMPLETION);
        assert.strictEqual(prematureFail.deficiencyType, "PREMATURE_TERMINATION");

        // 3. Observation blowup attribution
        const obsFail = harness.attributeFailure({ observationBytesPeak: 12000 });
        assert.strictEqual(obsFail.attributedModule, RSI_MODULES.OBSERVATION_MGMT);
        assert.strictEqual(obsFail.deficiencyType, "OBSERVATION_BLOWUP");

        // Apply targeted patch
        const patchResult = harness.applyRsiPatch(toolFail.attributedModule, toolFail.suggestedPatch, "Automated RSI patch for schema failure");
        assert.strictEqual(patchResult.version, 2);
        assert.strictEqual(harness.getModuleSpec(RSI_MODULES.TOOL_USE).version, 2);

        const history = harness.getEvolutionHistory();
        assert.strictEqual(history.length, 1);
        assert.strictEqual(history[0].moduleName, RSI_MODULES.TOOL_USE);
    });

    test("SIM & CRSI (arXiv: 2611.18856): Counterfactual Outcomes, Root-Cause Deduplication, Alias Merge & Unaccepted No-Op", () => {
        assert.strictEqual(SIM_GUIDANCE_RULES.length, 8, "Must expose all 8 Appendix D.2 rules");

        const sim = createSelfImprovementMemory();

        // Eq. (3): Unaccepted candidates leave SIM untouched (U(M_t, ∅) = M_t)
        const rejected = sim.recordAttempt({
            accepted: false,
            rootCause: "Premature task completion",
            what: "Block stop before running pytest",
            predicted: ["task_a"]
        });
        assert.strictEqual(rejected.updated, false);
        assert.strictEqual(sim.toJSON().problems.length, 0);

        // Accepted round-1 attempt with counterfactual predicted vs afterPassed (missed preserved even when accepted)
        const r1 = sim.recordAttempt({
            round: 1,
            sample: 2,
            accepted: true,
            rootCause: "Premature task completion",
            what: "Require execution-verified completion gate",
            rationale: "Agent stopped before verifying command exit status",
            files: ["harness/completion-gate.js"],
            predicted: ["task_a", "task_b", "task_c"],
            beforePassed: ["task_0"],
            afterPassed: ["task_0", "task_a", "task_d"],
            total: 10,
            domain: "coding",
            benchmark: "TB2.1",
            policyModel: "claude-opus-5.5"
        });
        assert.strictEqual(r1.updated, true);
        assert.strictEqual(r1.problemId, "P1");
        assert.strictEqual(r1.createdNewProblem, true);
        assert.deepStrictEqual(r1.attempt.fixed, ["task_a", "task_d"]);
        assert.deepStrictEqual(r1.attempt.missed, ["task_b", "task_c"]);
        assert.strictEqual(r1.attempt.passed, 3);

        // Identical root-cause text (case/whitespace-normalized) appends to P1 instead of opening P2
        const r2 = sim.recordAttempt({
            round: 3,
            sample: 1,
            rootCause: "  premature   task COMPLETION ",
            what: "Extend gate with deliverable optimality check",
            predicted: ["task_b"],
            afterPassed: ["task_0", "task_a", "task_b", "task_d"],
            domain: "coding",
            benchmark: "TB4",
            policyModel: "claude-opus-5.5"
        });
        assert.strictEqual(r2.problemId, "P1");
        assert.strictEqual(r2.createdNewProblem, false);
        assert.strictEqual(sim.getProblem("P1").attempts.length, 2);

        // Open P2 and P3, then merge P3 -> P2 and verify alias routing (Appendix D.3)
        sim.recordAttempt({
            round: 2,
            rootCause: "Fragile tool-call JSON parser",
            what: "Strip markdown fences before JSON.parse",
            predicted: ["task_e"],
            fixed: ["task_e"],
            domain: "coding",
            benchmark: "TB2.1",
            policyModel: "claude-opus-5.5"
        });
        sim.recordAttempt({
            round: 4,
            rootCause: "Malformed function call serialization",
            what: "Coerce stringified nested objects",
            predicted: ["task_f"],
            fixed: [],
            domain: "coding",
            benchmark: "TB2.1",
            policyModel: "claude-opus-5.5"
        });

        const mergeRes = sim.mergeProblems("P3", "P2");
        assert.strictEqual(mergeRes.merged, true);
        assert.strictEqual(mergeRes.aliases.P3, "P2");
        assert.strictEqual(sim.resolveProblemId("P3"), "P2");
        assert.strictEqual(sim.getProblem("P3").id, "P2");
        assert.strictEqual(sim.getProblem("P2").attempts.length, 2);

        // Appending via aliased problemId routes cleanly to P2
        const r5 = sim.recordAttempt({
            problemId: "P3",
            round: 5,
            what: "Add mode=NONE fallback when tool list is empty",
            predicted: ["task_f"],
            afterPassed: ["task_f"],
            domain: "coding",
            benchmark: "TB4",
            policyModel: "gemini-3.8-flash"
        });
        assert.strictEqual(r5.problemId, "P2");
        assert.strictEqual(sim.getProblem("P2").attempts.length, 3);
    });

    test("SIM & CRSI (arXiv: 2611.18856): Four Transfer Conditions & Untruncated Optimizer Prompt Shift Advisories", () => {
        const sourceHarness = createModularRsiHarness(
            {},
            { domain: "coding", benchmark: "TB2.1", policyModel: "claude-opus-5.5" }
        );

        const patched = sourceHarness.applyRsiPatch(
            RSI_MODULES.TASK_COMPLETION,
            { minimumConfidenceScore: 0.92 },
            "Prevent premature exit before test verification",
            {
                round: 2,
                rootCause: "Premature completion without test pass",
                files: ["lib/modular-rsi.js"],
                predicted: ["tb_11", "tb_19"],
                afterPassed: ["tb_11"],
                total: 20
            }
        );
        assert.strictEqual(patched.version, 2);
        assert.strictEqual(patched.simEntry.problemId, "P1");
        assert.deepStrictEqual(patched.simEntry.attempt.missed, ["tb_19"]);

        // 1. Cold Start: resets specs to seed (v1) and clears SIM
        const cold = sourceHarness.continueHarness({
            mode: SIM_TRANSFER_MODES.COLD_START,
            benchmark: "TB4",
            policyModel: "gemini-3.8-flash"
        });
        assert.strictEqual(cold.getModuleSpec(RSI_MODULES.TASK_COMPLETION).version, 1);
        assert.strictEqual(cold.getSim().toJSON().problems.length, 0);
        assert.strictEqual(cold.getSim().toJSON().carried_from, null);

        // 2. Harness Transfer: keeps evolved specs (v2) with empty SIM
        const harnessOnly = sourceHarness.continueHarness({
            mode: SIM_TRANSFER_MODES.HARNESS_TRANSFER,
            benchmark: "TB4",
            policyModel: "gemini-3.8-flash"
        });
        assert.strictEqual(harnessOnly.getModuleSpec(RSI_MODULES.TASK_COMPLETION).minimumConfidenceScore, 0.92);
        assert.strictEqual(harnessOnly.getSim().toJSON().problems.length, 0);
        assert.strictEqual(harnessOnly.getSim().toJSON().carried_from.mode, SIM_TRANSFER_MODES.HARNESS_TRANSFER);

        // 3. Problem-Only Memory: keeps evolved specs + root causes without attempt histories
        const problemOnly = sourceHarness.continueHarness({
            mode: SIM_TRANSFER_MODES.PROBLEM_ONLY,
            benchmark: "TB4",
            policyModel: "gemini-3.8-flash"
        });
        const poProblems = problemOnly.getSim().toJSON().problems;
        assert.strictEqual(poProblems.length, 1);
        assert.strictEqual(poProblems[0].name, "Premature completion without test pass");
        assert.strictEqual(poProblems[0].attempts.length, 0);

        // 4. Full SIM: keeps evolved specs + complete attempt history + shift advisories
        const fullSim = sourceHarness.continueHarness({
            mode: SIM_TRANSFER_MODES.FULL_SIM,
            benchmark: "TB4",
            policyModel: "gemini-3.8-flash"
        });
        const fullProblems = fullSim.getSim().toJSON().problems;
        assert.strictEqual(fullProblems.length, 1);
        assert.strictEqual(fullProblems[0].attempts.length, 1);
        assert.deepStrictEqual(fullProblems[0].attempts[0].missed, ["tb_19"]);

        const compiled = fullSim.getSim().compileOptimizerPrompt({
            targetDomain: "coding",
            targetBenchmark: "TB4",
            targetPolicyModel: "gemini-3.8-flash"
        });
        assert.strictEqual(compiled.benchmarkShift, true);
        assert.strictEqual(compiled.modelShift, true);
        assert.ok(compiled.prompt.includes("BENCHMARK_SHIFT_DETECTED"));
        assert.ok(compiled.prompt.includes("MODEL_SHIFT_DETECTED"));
        assert.ok(compiled.prompt.includes('"tb_19"'), "Prompt must retain untruncated missed predictions");
    });

    // =========================================================================
    // 2. Grouped Value Attention (GVA) Footprint Optimizer (arXiv: 2609.13285)
    // =========================================================================
    console.log("\n--- 2. Testing Grouped Value Attention (GVA) Footprint Optimizer (arXiv: 2609.13285) ---");

    test("GVA: Memory Footprint Calculation & 45-47% GQA Savings", () => {
        const metrics = calculateGvaFootprint(16384, 32, 32, 128, 8);

        assert.ok(metrics.mhaSizeBytes > metrics.gqaSizeBytes, "MHA must be larger than GQA");
        assert.ok(metrics.gqaSizeBytes > metrics.gvaSizeBytes, "GQA must be larger than GVA");
        assert.ok(metrics.gvaSavingsPercent >= 45 && metrics.gvaSavingsPercent <= 47, `GVA savings should be ~45-47%, got ${metrics.gvaSavingsPercent}%`);
        assert.ok(metrics.cumulativeCompressionRatio > 7.0, `Q4-GVA cumulative compression should exceed 7x, got ${metrics.cumulativeCompressionRatio}x`);
    });

    test("GVA: Dynamic Allocator & Serving Tier Recommendations", () => {
        // gpu-node-0: 22GB total VRAM, 14GB reserved for model, 8GB available headroom
        const allocator = createGvaAllocator({
            node: "gpu-node-0",
            totalVramBytes: 22 * 1024 * 1024 * 1024,
            reservedModelVramBytes: 14 * 1024 * 1024 * 1024
        });

        assert.strictEqual(allocator.availableHeadroomBytes, 8 * 1024 * 1024 * 1024);

        // Small context (4k tokens, batch 1) -> fits directly in VRAM
        const smallSession = allocator.recommendStrategy({ contextTokens: 4096, batchSize: 1 });
        assert.strictEqual(smallSession.strategy, 'DIRECT_VRAM');

        // Medium-large context (32k tokens, batch 2) -> requires GVA compression or Q4-GVA
        const largeSession = allocator.recommendStrategy({ contextTokens: 32768, batchSize: 2 });
        assert.ok(['GVA_COMPRESSION', 'Q4_GVA_PERSISTENCE'].includes(largeSession.strategy));

        // Extreme context (128k tokens, batch 4) -> triggers NVMe offload
        const extremeSession = allocator.recommendStrategy({ contextTokens: 131072, batchSize: 4 });
        assert.strictEqual(extremeSession.strategy, 'NVME_OFFLOAD');
    });

    // =========================================================================
    // 3. Emergence World: Multi-Agent Resilience Gate (arXiv: 2609.17320)
    // =========================================================================
    console.log("\n--- 3. Testing Emergence World Multi-Agent Resilience Gate (arXiv: 2609.17320) ---");

    test("Emergence World: Normal Clean Handoffs (PASS)", () => {
        const handoffs = [
            { senderId: "director", recipientId: "code-auditor", message: "Audit src/index.js", status: "SUCCESS" },
            { senderId: "code-auditor", recipientId: "test-runner", message: "Run npm test on modified files", status: "SUCCESS" },
            { senderId: "test-runner", recipientId: "director", message: "All 10 tests passed", status: "SUCCESS" }
        ];

        const result = evaluateMultiAgentResilience(handoffs);
        assert.strictEqual(result.resilient, true);
        assert.strictEqual(result.resilienceScore, 1.0);
        assert.strictEqual(result.verdict, "PASS");
        assert.strictEqual(result.issues.length, 0);
    });

    test("Emergence World: Error Cascade Detection", () => {
        const cascadingHandoffs = [
            { senderId: "director", recipientId: "worker-1", message: "Start ETL", status: "FAILED", error: "Database timeout" },
            { senderId: "worker-1", recipientId: "worker-2", message: "Handle fallback", status: "FAILED", error: "Cannot parse partial data" },
            { senderId: "worker-2", recipientId: "worker-3", message: "Notify admin", status: "FAILED", error: "Alert webhook down" }
        ];

        const result = evaluateMultiAgentResilience(cascadingHandoffs, { maxCascadeDepth: 2 });
        assert.strictEqual(result.resilient, false);
        assert.ok(result.issues.some(iss => iss.includes('Error cascade depth 3 exceeds limit 2')));
        assert.strictEqual(result.metrics.maxObservedCascade, 3);
    });

    test("Emergence World: Circular Deadlock Detection", () => {
        const cyclicHandoffs = [
            { senderId: "agent-a", recipientId: "agent-b", message: "Please solve subtask 1" },
            { senderId: "agent-b", recipientId: "agent-c", message: "Please solve subtask 1" },
            { senderId: "agent-c", recipientId: "agent-a", message: "Please solve subtask 1" }
        ];

        const result = evaluateMultiAgentResilience(cyclicHandoffs);
        assert.strictEqual(result.resilient, false);
        assert.ok(result.issues.some(iss => iss.includes('Circular multi-agent dependency cycle')));
        assert.strictEqual(result.metrics.circularDeadlock, true);
    });

    test("Emergence World: Private Memory Leakage Detection", () => {
        const leakyHandoffs = [
            {
                senderId: "security-auditor",
                recipientId: "public-reporter",
                message: "Here is the summary. Credentials verified with db_password and api_key=REDACTED_TEST_CREDENTIAL_12345."
            }
        ];

        const result = evaluateMultiAgentResilience(leakyHandoffs);
        assert.strictEqual(result.resilient, false);
        assert.ok(result.issues.some(iss => iss.includes('Private memory leakage detected')));
        assert.strictEqual(result.metrics.memoryLeakCount, 1);
    });

    // =========================================================================
    // 4. Diverse Skill Routing (DSR) (arXiv: 2609.05824)
    // =========================================================================
    console.log("\n--- 4. Testing Diverse Skill Routing (DSR) (arXiv: 2609.05824) ---");

    test("DSR: Orthogonal Skill Selection vs Redundant Clustering", () => {
        const candidateSkills = [
            { name: "docker-debug", description: "Triage container crashes, inspect docker logs, restart containers", tags: ["docker", "container", "logs"], tokens: 400 },
            { name: "docker-logs-viewer", description: "View and inspect docker container logs and runtime output", tags: ["docker", "container", "logs"], tokens: 350 },
            { name: "container-inspector", description: "Inspect container status and docker runtime errors", tags: ["docker", "container"], tokens: 380 },
            { name: "env-secrets", description: "Manage .env configuration secrets, database credentials, and rotations", tags: ["env", "secrets", "credentials"], tokens: 300 },
            { name: "node-health-check", description: "Verify system hardware, CPU temperatures, and network connectivity via SSH", tags: ["hardware", "ssh", "network"], tokens: 350 }
        ];

        const query = "Diagnose the failing service container, check network connectivity, and verify secret environment variables.";

        const result = routeDiverseSkills(query, candidateSkills, {
            maxSkills: 3,
            maxTokenBudget: 1500,
            diversityLambda: 0.5
        });

        assert.strictEqual(result.selectedSkills.length, 3, "Should select 3 diverse skills");
        const selectedNames = result.selectedSkills.map(s => s.name);

        // Under DSR, it should NOT select multiple redundant docker tools.
        // It must select a balanced set covering a container tool, secrets, and node health!
        const hasContainerTool = selectedNames.some(n => ['docker-debug', 'docker-logs-viewer', 'container-inspector'].includes(n));
        assert.ok(hasContainerTool, "Should select one of the container tools");
        assert.ok(selectedNames.includes("env-secrets"), "Should select orthogonal secrets tool");
        assert.ok(selectedNames.includes("node-health-check"), "Should select orthogonal network/health tool");

        assert.ok(result.diversityScore >= 0.70, `Expected high diversity score, got ${result.diversityScore}`);
        assert.ok(result.totalTokens <= 1500, "Should respect token budget");
    });

    console.log(`\n🎉 ALL ${passedTests}/${totalTests} MID-SEPTEMBER AI RESEARCH TESTS PASSED (100% SUCCESS)!\n`);
}

runTests().catch(err => {
    console.error("FATAL TEST EXCEPTION:", err);
    process.exit(1);
});
