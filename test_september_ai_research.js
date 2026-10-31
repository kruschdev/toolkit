/**
 * Test Suite: September 2026 AI Research Breakthroughs Integration
 * Tests SKILL.state, PIG Engine, Second Thought, Persistent Q4 KV Cache, and DHD Deliberation.
 */

import assert from 'assert';
import {
    createSkillStateManager,
    calculateSkillStateSavings,
    calculateIntelligenceEntropy,
    createPigEngine,
    createSecondThoughtEngine,
    createKvCacheManager,
    calculateKvCacheMetrics,
    extractTrajectoryValue,
    evaluateDHDConsensus
} from './index.js';

console.log("🚀 Starting September 2026 AI Research Breakthroughs Test Suite...\n");

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

    async function testAsync(name, fn) {
        totalTests++;
        try {
            await fn();
            console.log(`✔ ${name}`);
            passedTests++;
        } catch (err) {
            console.error(`❌ FAIL: ${name}`);
            console.error(err);
            process.exit(1);
        }
    }

    // ==========================================
    // 1. SKILL.state (arXiv: 2608.26263)
    // ==========================================
    console.log("--- 1. Testing SKILL.state Architecture (arXiv: 2608.26263) ---");

    test("SKILL.state: Bounded Prompt Generation", () => {
        const spec = "You are an SRE worker. Check disk space and clear logs.";
        const manager = createSkillStateManager({
            skillSpec: spec,
            initialState: { diskUsagePct: 78, cleaned: false }
        });

        const prompt = manager.formatStepPrompt("Tool output: /dev/sda1 at 78% usage");
        assert(prompt.includes("IMMUTABLE SKILL SPECIFICATION"), "Missing spec header");
        assert(prompt.includes(spec), "Missing spec text");
        assert(prompt.includes('"diskUsagePct": 78'), "Missing state json");
        assert(prompt.includes("Tool output: /dev/sda1 at 78% usage"), "Missing observation");
    });

    test("SKILL.state: State Mutation & Reasoning Trace Eviction", () => {
        const manager = createSkillStateManager({
            skillSpec: "SRE cleanup",
            initialState: { step: 0, cleanedDirs: [] },
            stateValidator: (candidate) => candidate.step >= 0
        });

        const transientCoT = "Let me think deeply about which logs to delete... Step 1 delete /tmp/logs. Step 2 delete caches.";
        const mutationResult = manager.applyStateMutation({
            stateDelta: { step: 1, cleanedDirs: ['/var/log/nginx'] },
            action: { name: "rm_logs", type: "TOOL_CALL" },
            intermediateReasoning: transientCoT,
            observationSummary: "Freed 420MB"
        });

        assert.strictEqual(mutationResult.success, true);
        assert.strictEqual(mutationResult.step, 1);
        assert.strictEqual(mutationResult.evictedReasoningLength, transientCoT.length);
        assert.deepStrictEqual(manager.getState().cleanedDirs, ['/var/log/nginx']);

        // Check that ledger holds compact record without transient CoT
        const ledger = manager.getExecutionLedger();
        assert.strictEqual(ledger.length, 1);
        assert.strictEqual(ledger[0].action, "rm_logs");
        assert(!JSON.stringify(ledger).includes(transientCoT), "Transient CoT leaked into persistent state");
    });

    test("SKILL.state: Validator Rejection & Rollback", () => {
        const manager = createSkillStateManager({
            skillSpec: "Invariant guard",
            initialState: { balance: 100 },
            stateValidator: (cand) => cand.balance >= 0 ? true : { valid: false, error: "Negative balance prohibited" }
        });

        // Failed mutation
        const failedResult = manager.applyStateMutation({
            stateDelta: { balance: -50 },
            intermediateReasoning: "invalid spending thought"
        });
        assert.strictEqual(failedResult.success, false);
        assert.strictEqual(manager.getState().balance, 100);

        // Valid mutation then rollback
        manager.applyStateMutation({ stateDelta: { balance: 80 } });
        assert.strictEqual(manager.getState().balance, 80);

        const rollbackResult = manager.rollback(0);
        assert.strictEqual(rollbackResult.restored, true);
        assert.strictEqual(manager.getState().balance, 100);
    });

    test("SKILL.state: Token Savings Quantification (O(1) vs O(N^2))", () => {
        const savings = calculateSkillStateSavings(20);
        assert(savings.tokensSaved > 0, "Tokens saved must be positive");
        assert(savings.savingsRatio > 2.0, `Expected savings ratio > 2.0x, got ${savings.savingsRatio}x`);
    });

    // ==========================================
    // 2. PIG Engine & Intelligence Entropy Gate (arXiv: 2606.08162)
    // ==========================================
    console.log("\n--- 2. Testing PIG Engine & Intelligence Entropy Gate (arXiv: 2606.08162) ---");

    test("PIG: Exponential Entropy Calculation S(t) = S0 * exp(alpha * t)", () => {
        const s0 = calculateIntelligenceEntropy({ t: 0, s0: 1.0, alpha: 0.05 });
        const s10 = calculateIntelligenceEntropy({ t: 10, s0: 1.0, alpha: 0.05 });
        const s30 = calculateIntelligenceEntropy({ t: 30, s0: 1.0, alpha: 0.05 });

        assert.strictEqual(s0, 1.0);
        assert(s10 > s0, "Entropy must grow with step count");
        assert(s30 > s10, "Entropy must grow exponentially");
        assert(s30 > 4.0, `Expected S(30) > 4.0, got ${s30}`);
    });

    test("PIG: Task Lifecycle Control (TLC) State Machine", () => {
        const pig = createPigEngine({ goal: "Upgrade database schema" });
        assert.strictEqual(pig.getStage(), 'INIT');

        // Valid transition
        const t1 = pig.transitionLifecycle('ANALYZING', "Inspecting migrations");
        assert.strictEqual(t1.success, true);
        assert.strictEqual(pig.getStage(), 'ANALYZING');

        // Illegal jump: ANALYZING -> COMMITTED (skipping EXECUTING & VERIFYING)
        const illegalTransition = pig.transitionLifecycle('COMMITTED', "Direct commit attempt");
        assert.strictEqual(illegalTransition.success, false);
        assert(illegalTransition.error.includes("TLC Violation"), "Must flag TLC violation");
        assert.strictEqual(pig.getStage(), 'ANALYZING');

        // Correct path
        assert.strictEqual(pig.transitionLifecycle('EXECUTING').success, true);
        assert.strictEqual(pig.transitionLifecycle('VERIFYING').success, true);
        assert.strictEqual(pig.transitionLifecycle('COMMITTED').success, true);
    });

    test("PIG: Direction Calibration Mechanism (DCM) & Drift Alert", () => {
        const pig = createPigEngine({
            goal: "Optimize PostgreSQL query indexing for users table",
            goalInvariants: ["preserve foreign keys", "zero downtime"],
            entropyThreshold: 2.0,
            alpha: 0.2
        });

        // Step 1: aligned thought
        const step1 = pig.calibrateDirection("Analyzing postgres execution plan and indexing users foreign keys");
        assert.strictEqual(step1.ok, true);
        assert.strictEqual(step1.isEntropyCritical, false);

        // Step 5: step count advances entropy past threshold 2.0 (1.0 * exp(0.2 * 5) = 2.718)
        pig.calibrateDirection("step 2");
        pig.calibrateDirection("step 3");
        pig.calibrateDirection("step 4");
        const step5 = pig.calibrateDirection("unrelated thoughts about music streaming");

        assert.strictEqual(step5.isEntropyCritical, true);
        assert.strictEqual(step5.calibrationRequired, true);
        assert(step5.reason.includes("Intelligence entropy"), "Must alert on entropy explosion");
    });

    test("PIG: Bidirectional Confirmation Protocol (BCP)", () => {
        const pig = createPigEngine({ goal: "Multi-agent sync" });
        const handshake = pig.createBcpHandshake({
            senderId: "krusch-director",
            recipientId: "gpu-worker",
            payload: { task: "run_vllm_benchmark", batchSize: 64 },
            nonce: 10442
        });

        assert(handshake.bcpToken.startsWith("BCP-"), "Invalid BCP token");
        assert.strictEqual(handshake.verified, true);
        assert.strictEqual(handshake.digest.length, 64);

        // Confirm receipt
        const confirmed = pig.confirmBcpReceipt(handshake.bcpToken);
        assert.strictEqual(confirmed, true);
        assert.strictEqual(pig.confirmBcpReceipt("BCP-non-existent"), false);
    });

    test("PIG: Comprehensive Autonomous Delivery Verification Gate (CADVP)", () => {
        const pig = createPigEngine({ goal: "Code ship" });

        const passingGate = pig.runDeliveryVerificationGate({
            assertions: [
                { name: "Unit tests pass", check: () => true },
                { name: "Linter clean", check: true }
            ]
        });
        assert.strictEqual(passingGate.passed, true);
        assert.strictEqual(passingGate.failedAssertions.length, 0);

        const failingGate = pig.runDeliveryVerificationGate({
            assertions: [
                { name: "VRAM within 11GB limit", check: () => false },
                { name: "Schema migration applied", check: true }
            ]
        });
        assert.strictEqual(failingGate.passed, false);
        assert.strictEqual(failingGate.failedAssertions[0], "VRAM within 11GB limit");
    });

    // ==========================================
    // 3. Second Thought Engine (arXiv: 2608.13667)
    // ==========================================
    console.log("\n--- 3. Testing Second Thought Engine (arXiv: 2608.13667) ---");

    await testAsync("Second Thought: Parallel Speculative Execution & Success Hit", async () => {
        const engine = createSecondThoughtEngine();

        const mockAction = { type: "TOOL_CALL", name: "ping_node", args: { host: "db-primary" } };

        const result = await engine.executeWithSecondThought({
            action: mockAction,
            executorFn: async () => {
                // Simulate 50ms network I/O
                await new Promise(r => setTimeout(r, 50));
                return "Host db-primary is reachable: 0.42ms ping";
            },
            context: { goal: "Verify node connectivity" },
            mockSpeculationFn: async () => ({
                successHypothesis: {
                    expectedObservationSignature: "reachable",
                    reasoning: "Node is online; proceed with deployment checks",
                    nextAction: { type: "TOOL_CALL", name: "check_docker", args: { host: "db-primary" } }
                },
                failureHypothesis: {
                    expectedObservationSignature: "timed out",
                    recoveryAction: { type: "TOOL_CALL", name: "restart_tailscale", args: {} }
                }
            })
        });

        assert.strictEqual(result.speculationHit, true);
        assert.strictEqual(result.matchedBranch, 'SUCCESS');
        assert.strictEqual(result.nextAction.name, "check_docker");
        assert(result.latencySavedMs > 0, "Must record latency savings");

        const telemetry = engine.getTelemetry();
        assert.strictEqual(telemetry.successfulHits, 1);
    });

    await testAsync("Second Thought: Parallel Speculation on Error Recovery Hit", async () => {
        const engine = createSecondThoughtEngine();

        const result = await engine.executeWithSecondThought({
            action: { type: "TOOL_CALL", name: "ssh_exec", args: { cmd: "systemctl status pg" } },
            executorFn: async () => {
                await new Promise(r => setTimeout(r, 40));
                return { isError: true, output: "fatal: connection refused on port 5432" };
            },
            context: { goal: "Check postgres" },
            mockSpeculationFn: async () => ({
                successHypothesis: {
                    reasoning: "DB active",
                    nextAction: { type: "PROCEED" }
                },
                failureHypothesis: {
                    reasoning: "Postgres daemon down; attempt systemctl restart postgresql",
                    recoveryAction: { type: "TOOL_CALL", name: "ssh_exec", args: { cmd: "systemctl restart postgresql" } }
                }
            })
        });

        assert.strictEqual(result.speculationHit, true);
        assert.strictEqual(result.matchedBranch, 'FAILURE');
        assert.strictEqual(result.nextAction.args.cmd, "systemctl restart postgresql");
    });

    // ==========================================
    // 4. Persistent Q4 KV Cache Manager (arXiv: 2603.04428 & CacheScout)
    // ==========================================
    console.log("\n--- 4. Testing Persistent Q4 KV Cache Manager (arXiv: 2603.04428) ---");

    test("KV Cache: Q4 Metrics & TTFT Speedup Modeling", () => {
        const metrics = calculateKvCacheMetrics(32768);
        assert.strictEqual(metrics.compressionRatio, 4.0);
        assert(metrics.q4SizeBytes < metrics.fp16SizeBytes);
        assert(metrics.ttftSpeedup > 10.0, `Expected TTFT speedup > 10x, got ${metrics.ttftSpeedup}x`);
    });

    test("KV Cache: Agent Persona Registration & Reload", () => {
        const manager = createKvCacheManager({ node: "gpu-node-0", storageDir: "./.cache/kv_cache" });

        const entry = manager.registerAgentKvCache("director_14b", {
            model: "qwen3-coder-30b-moe",
            contextTokens: 16384,
            quantization: "q4_0"
        });

        assert.strictEqual(entry.agentId, "director_14b");
        assert(entry.diskPath.endsWith(".safetensors"));

        const loadResult = manager.loadAgentKvCache("director_14b");
        assert.strictEqual(loadResult.success, true);
        assert(loadResult.speedup > 1.0);
        assert(loadResult.ttftMs < loadResult.baselinePrefillMs);
    });

    test("KV Cache: Inter-Agent Prefix Cache Handoff (QKVShare / LMCache)", () => {
        const manager = createKvCacheManager({ node: "gpu-node-0" });

        manager.registerAgentKvCache("architect", {
            model: "qwen3-coder-30b-moe",
            contextTokens: 8192,
            quantization: "q4_0"
        });

        const handoffResult = manager.handoffKvCache("architect", "stylist", 4096);
        assert.strictEqual(handoffResult.success, true);
        assert.strictEqual(handoffResult.sharedTokens, 4096);
        assert.strictEqual(handoffResult.targetEntry.inheritedFrom, "architect");

        const telemetry = manager.getTelemetry();
        assert.strictEqual(telemetry.totalHandoffs, 1);
        assert(telemetry.vramSavedBytes > 0);
    });

    // ==========================================
    // 5. Diverse Hypothesis Deliberation (arXiv: 2608.14375 & 2608.25937)
    // ==========================================
    console.log("\n--- 5. Testing Diverse Hypothesis Deliberation & Trajectory Value (arXiv: 2608.14375) ---");

    test("DHD: Trajectory Value Extraction from Failed Candidates", () => {
        const candidates = [
            {
                id: "worker-1",
                passed: true,
                steps: [{ action: "read_schema" }, { action: "create_index" }]
            },
            {
                id: "worker-2",
                passed: true,
                steps: [{ action: "read_schema" }, { action: "create_index" }]
            },
            {
                id: "worker-3",
                passed: false,
                errors: ["Dropping primary key cascaded into foreign key violation on orders table"],
                steps: [{ subGoal: "inspect_fk_dependencies", failed: false }]
            }
        ];

        const value = extractTrajectoryValue(candidates);
        assert(value.negativeConstraints.length > 0, "Must extract negative constraints from failed candidate");
        assert(value.negativeConstraints[0].includes("foreign key violation"), "Negative constraint content mismatch");
        assert(value.subGoalDecompositions.length > 0, "Must extract discovered sub-goals");
        assert(value.commonInvariants.some(i => i.includes("read_schema")), "Must extract common invariant step");
        assert(value.trajectoryValueScore > 0, "Trajectory value score must be positive");
    });

    await testAsync("DHD: Consensus Clustering & Referee Scoring (arXiv: 2608.25937)", async () => {
        const candidates = [
            { id: "c1", proposal: "Use btree index on users(created_at)", category: "btree", confidence: 0.85 },
            { id: "c2", proposal: "Use btree index on users(created_at)", category: "btree", confidence: 0.90 },
            { id: "c3", proposal: "Use hash index on users(created_at)", category: "hash", confidence: 0.60 }
        ];

        const result = await evaluateDHDConsensus(candidates, {
            refereeFn: async (cand) => cand.confidence
        });

        assert.strictEqual(result.winningCluster, "btree");
        assert.strictEqual(result.clusterDistribution["btree"], 2);
        assert.strictEqual(result.clusterDistribution["hash"], 1);
        assert(result.consensusConfidence >= 0.80, `Expected consensusConfidence >= 0.80, got ${result.consensusConfidence}`);
    });

    console.log(`\n🎉 ALL ${passedTests}/${totalTests} TESTS PASSED (100% SUCCESS)!`);
}

runTests().catch(err => {
    console.error("Test execution failed:", err);
    process.exit(1);
});
