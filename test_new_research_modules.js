/**
 * @file test_new_research_modules.js
 * @description Comprehensive automated test suite for the research-derived modules:
 * - Stage-Aware Context Pruner (arXiv: 2608.08389)
 * - Spec-First Convergence & Verification Engine (arXiv: 2608.12440)
 * - SKILLER Skill Staging & Extraction (arXiv: 2608.10538)
 * - Trajectory Guard & Futile Reasoning Circuit Breakers (Gambit 2608.08020 / CaRL 2607.29211)
 */

import assert from 'node:assert';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

import {
    prunePreRetrieval,
    prunePostRetrieval,
    prunePreSynthesis,
    createContextPruner,
    checkConvergence,
    createSpecAuditRunner,
    evaluateRefereeConsensus,
    MemoryInvalidationEngine,
    filterActiveMemories,
    supersedeMemoryRecord,
    buildMemoryLineage,
    stageSkillForMonorepo,
    createTrajectoryGuard,
    scoreTrajectoryProgress
} from './index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function runTests() {
    console.log("🚀 Starting Research Modules Test Suite...\n");

    // ==========================================
    // 1. Stage-Aware Context Pruning Tests
    // ==========================================
    console.log("--- 1. Testing Stage-Aware Context Pruner (arXiv: 2608.08389) ---");

    // 1.1 Pre-Retrieval
    const rawQuery = "Hey, could you please tell me what the latest status of postgres database backups is? Thanks in advance!";
    const rawHistory = [
        { role: 'user', content: 'Turn 1' },
        { role: 'assistant', content: 'Turn 2' },
        { role: 'user', content: 'Turn 3' },
        { role: 'assistant', content: 'Turn 4' },
        { role: 'user', content: 'Turn 5' },
        { role: 'assistant', content: 'Turn 6' },
        { role: 'user', content: 'Turn 7' }
    ];
    const preResult = prunePreRetrieval(rawQuery, rawHistory, { maxHistoryTurns: 3, stripPoliteness: true });
    
    assert.ok(!preResult.query.toLowerCase().includes("could you please"), "Preamble/politeness should be stripped");
    assert.ok(!preResult.query.toLowerCase().includes("thanks in advance"), "Closing pleasantry should be stripped");
    assert.strictEqual(preResult.history.length, 3, "History should be budgeted to 3 turns");
    assert.ok(preResult.tokensSavedEst > 0, "Tokens saved should be positive");
    console.log(`✔ Pre-Retrieval: Cleaned query -> "${preResult.query}" (Saved ~${preResult.tokensSavedEst} tokens)`);

    // 1.2 Post-Retrieval (Marginal Value Estimation)
    const mockChunks = [
        { id: 1, text: "PostgreSQL backups run every night at 2 AM using pg_dump on db-primary." },
        { id: 2, text: "PostgreSQL backups run every night at 2 AM using pg_dump on db-primary to backup database." }, // Highly redundant
        { id: 3, text: "The backup destination directory is /var/backups/postgres." },
        { id: 4, text: "Disk usage on the backup target is currently at 45% capacity." }
    ];

    const postResult = prunePostRetrieval(mockChunks, "backup", { redundancyThreshold: 0.5 });
    assert.strictEqual(postResult.originalCount, 4, "Original chunk count should be 4");
    assert.strictEqual(postResult.prunedCount, 3, "Redundant chunk 2 should be pruned");
    assert.strictEqual(postResult.chunks.some(c => c.id === 2), false, "Chunk 2 must not be in selected chunks");
    console.log(`✔ Post-Retrieval: Pruned ${postResult.originalCount} -> ${postResult.prunedCount} chunks (Eliminated near-duplicate)`);

    // 1.3 Pre-Synthesis
    const boilerplateDoc = `# Header
Copyright © 2026 Example Corp. All rights reserved.
Cookie Settings and Privacy Policy apply.
The database migration completed successfully with 0 errors on node db-primary.
System integrity checks are all passing as of today.
<!-- HTML Comment block -->`;

    const synthResult = prunePreSynthesis(boilerplateDoc, { stripBoilerplate: true });
    assert.ok(!synthResult.text.includes("Copyright © 2026"), "Copyright boilerplate should be removed");
    assert.ok(!synthResult.text.includes("Cookie Settings"), "Cookie notice should be removed");
    assert.ok(synthResult.text.includes("database migration completed"), "Core factual content must be preserved");
    console.log(`✔ Pre-Synthesis: Compacted context, stripped boilerplate (${synthResult.tokensSavedEst} tokens saved)`);

    // 1.4 End-to-end Context Pruner pipeline
    const pruner = createContextPruner();
    const pipelineRes = await pruner.executePipeline({
        query: "Please find the status of node db-primary",
        history: [{ role: 'user', content: 'test' }],
        fetchChunksFn: async () => [
            "Node db-primary is healthy.",
            "Node db-primary is healthy and active.",
            "Memory utilization is 12GB."
        ]
    });
    assert.ok(pipelineRes.selectedChunks.length <= 2, "Pipeline should discard duplicate chunks");
    assert.ok(pipelineRes.totalTokensSaved > 0, "Total tokens saved should be calculated");
    console.log(`✔ ContextPruner Pipeline: Executed 3-stage prune (Total saved ~${pipelineRes.totalTokensSaved} tokens)`);


    // ==========================================
    // 2. Specification-First Convergence & Referee Tests
    // ==========================================
    console.log("\n--- 2. Testing Spec-First Convergence & Referee Engine (arXiv: 2608.12440 / 2608.03744) ---");

    const historyWithDefects = [
        { passNumber: 1, findings: [{ file: 'a.js', description: 'Missing validation' }] },
        { passNumber: 2, findings: [{ file: 'b.js', description: 'Syntax error' }] },
        { passNumber: 3, findings: [] } // Only 1 clean pass
    ];
    const status1 = checkConvergence(historyWithDefects, 2);
    assert.strictEqual(status1.isConverged, false, "Should not converge on only 1 clean pass");
    assert.strictEqual(status1.consecutiveZeroPasses, 1);
    assert.strictEqual(status1.totalDefectsResolved, 2);

    const historyConverged = [
        ...historyWithDefects,
        { passNumber: 4, findings: [], isReferee: true } // Second consecutive clean pass by referee!
    ];
    const status2 = checkConvergence(historyConverged, 2);
    assert.strictEqual(status2.isConverged, true, "Should converge on 2 consecutive clean passes");
    assert.strictEqual(status2.consecutiveZeroPasses, 2);
    assert.strictEqual(status2.hasRefereeVerification, true, "Should confirm referee verification");
    console.log(`✔ Dual-Zero-Finding Gate: Correctly gated convergence until 2 consecutive zero-defect passes with referee verification`);

    // 2.2 Consensus & Shortcut Contagion Interception (arXiv: 2608.03744)
    const primaryFindingsEmpty = [];
    const refereeFoundDefect = [{ file: 'auth.js', invariant: 'JWT Expiry', description: 'Token expiry not enforced' }];
    const contagionResult = evaluateRefereeConsensus(primaryFindingsEmpty, refereeFoundDefect);
    
    assert.strictEqual(contagionResult.hasContagion, true, "Contagion must be detected when auditor is clean but referee finds defects");
    assert.strictEqual(contagionResult.consensus, false, "Consensus should be false on disagreement");
    assert.strictEqual(contagionResult.missedByAuditor.length, 1, "Missed defect must be recorded");
    console.log(`✔ Referee Consensus: Intercepted shortcut contagion -> Caught unaddressed defect in auth.js`);

    const runner = createSpecAuditRunner({ requiredZeroPasses: 2 });
    runner.recordPass({ findings: ['defect1'] });
    runner.recordPass({ findings: [] });
    assert.strictEqual(runner.isConverged(), false);
    runner.recordPass({ findings: [], isReferee: true });
    assert.strictEqual(runner.isConverged(), true);
    const report = runner.formatReport();
    assert.ok(report.includes("CONVERGED"), "Report should state CONVERGED");
    assert.ok(report.includes("REFEREE"), "Report should display REFEREE status");
    console.log(`✔ SpecAuditRunner: State tracking and markdown report generation validated with referee badges`);


    // ==========================================
    // 3. SKILLER Skill Staging Tests
    // ==========================================
    console.log("\n--- 3. Testing SKILLER Engine (arXiv: 2608.10538) ---");

    const testSkillName = "temp-test-dbos-healing";
    const testSkillMarkdown = `---
name: ${testSkillName}
description: Autonomous queue healing for deadlocked workers
---

# DBOS Queue Healing Skill

1. Check active job status.
2. Terminate stalled worker PID.
3. Re-queue pending jobs.
`;

    const tempStageDir = path.join(__dirname, 'temp_skills_stage');
    const stageResult = await stageSkillForMonorepo(testSkillName, testSkillMarkdown, tempStageDir);
    assert.ok(stageResult.bytesWritten > 0, "Skill file must be written to disk");
    const readBack = await fs.readFile(stageResult.skillPath, 'utf8');
    assert.strictEqual(readBack, testSkillMarkdown, "Saved skill markdown must match source");

    // Clean up temporary test directory
    await fs.rm(tempStageDir, { recursive: true, force: true });
    console.log(`✔ SKILLER: Staged and verified modular skill file at target directory`);


    // ==========================================
    // 4. Trajectory Guard & Futile Reasoning Circuit Breaker
    // ==========================================
    console.log("\n--- 4. Testing Trajectory Guard (Gambit 2608.08020 / CaRL 2607.29211) ---");

    const guard = createTrajectoryGuard({ maxIdenticalToolCalls: 2, maxRepeatedErrors: 2 });
    
    // Normal steps
    const step1 = guard.recordStep({ tool: 'run_command', args: { cmd: 'ls' }, output: 'file.txt' });
    assert.strictEqual(step1.ok, true);

    const step2 = guard.recordStep({ tool: 'run_command', args: { cmd: 'cat file.txt' }, output: 'data' });
    assert.strictEqual(step2.ok, true);

    // Call identical tool 3 times to trigger loop guard
    guard.recordStep({ tool: 'run_command', args: { cmd: 'curl http://failed' }, output: 'error 500' });
    guard.recordStep({ tool: 'run_command', args: { cmd: 'curl http://failed' }, output: 'error 500' });
    const loopTrip = guard.recordStep({ tool: 'run_command', args: { cmd: 'curl http://failed' }, output: 'error 500' });

    assert.strictEqual(loopTrip.shouldAbort, true, "Guard must trigger abort on circular loop");
    assert.strictEqual(loopTrip.shouldEscalate, true, "Guard must request escalation");
    assert.ok(loopTrip.reason.includes("Circular tool loop"), "Reason must specify circular loop");
    console.log(`✔ Trajectory Guard: Caught circular tool loop -> "${loopTrip.reason}"`);

    // Trajectory Progress Scoring
    const healthyHistory = [
        { tool: 'grep', isError: false },
        { tool: 'view_file', isError: false },
        { tool: 'replace_file', isError: false }
    ];
    const stagnantHistory = [
        { tool: 'run_command', isError: true, output: 'conn refused' },
        { tool: 'run_command', isError: true, output: 'conn refused' },
        { tool: 'run_command', isError: true, output: 'conn refused' }
    ];

    const healthyScore = scoreTrajectoryProgress(healthyHistory, "Fix bug");
    const stagnantScore = scoreTrajectoryProgress(stagnantHistory, "Fix bug");

    assert.strictEqual(healthyScore.isStagnant, false, "Healthy history should not be stagnant");
    assert.ok(healthyScore.progressScore >= 0.8, "Healthy progress score should be >= 0.8");

    assert.strictEqual(stagnantScore.isStagnant, true, "Error-heavy loop must be marked stagnant");
    assert.ok(stagnantScore.progressScore < 0.5, "Stagnant progress score should be low");
    console.log(`✔ Progress Scoring: Healthy Score = ${healthyScore.progressScore}, Stagnant Score = ${stagnantScore.progressScore}`);


    // ==========================================
    // 5. Knowledge Invalidation & Temporal Fact Superseding (MobileMem arXiv: 2608.13606)
    // ==========================================
    console.log("\n--- 5. Testing Knowledge Invalidation Engine (arXiv: 2608.13606) ---");

    const memoryEngine = new MemoryInvalidationEngine();

    // 5.1 Add initial hardware spec
    const mem1 = memoryEngine.addMemory({
        id: 'node_gpu_worker_v1',
        entity: 'gpu-worker-1',
        category: 'hardware',
        content: 'gpu-worker-1 has a single RTX 2080 Ti 11GB GPU installed.',
        timestamp: '2026-01-01T10:00:00Z'
    });
    assert.strictEqual(mem1.status, 'ACTIVE');

    // 5.2 Add upgraded hardware spec that supersedes v1
    const mem2 = memoryEngine.addMemory({
        id: 'node_gpu_worker_v2',
        entity: 'gpu-worker-1',
        category: 'hardware',
        content: 'gpu-worker-1 has Dual RTX 2080 Ti 22GB GPUs installed.',
        supersedesId: 'node_gpu_worker_v1',
        timestamp: '2026-06-01T10:00:00Z'
    });

    // Verify that mem1 is now SUPERSEDED and mem2 is ACTIVE
    const activeHardware = memoryEngine.getActiveMemories({ entity: 'gpu-worker-1' });
    assert.strictEqual(activeHardware.length, 1, "Only the active upgraded memory must be returned");
    assert.strictEqual(activeHardware[0].id, 'node_gpu_worker_v2', "Newest superseding memory must be active");
    assert.strictEqual(memoryEngine.memories.get('node_gpu_worker_v1').status, 'SUPERSEDED');
    console.log(`✔ Memory Superseding: Verified older memory was superseded by v2`);

    // 5.3 Verify Lineage Traversal
    const lineage = memoryEngine.getLineage('node_gpu_worker_v2');
    assert.strictEqual(lineage.ancestors.length, 1, "Lineage must trace back to v1 ancestor");
    assert.strictEqual(lineage.ancestors[0].id, 'node_gpu_worker_v1');
    console.log(`✔ Memory Lineage: Correctly traversed ancestor chain v2 -> v1`);

    // 5.4 Explicit Invalidation
    const memTemp = memoryEngine.addMemory({
        id: 'temp_secret_key',
        entity: 'auth',
        category: 'secrets',
        content: 'Old temporary API key',
        timestamp: '2026-07-01T10:00:00Z'
    });
    memoryEngine.invalidateMemory('temp_secret_key', 'Key revoked and rotated');
    const activeSecrets = memoryEngine.getActiveMemories({ category: 'secrets' });
    assert.strictEqual(activeSecrets.length, 0, "Revoked memory must not appear in active query");
    console.log(`✔ Memory Invalidation: Explicitly invalidated revoked credential`);

    // 5.5 Pure helper filterActiveMemories
    const rawMemList = [
        { id: 1, entity: 'db_primary_ip', content: '198.51.100.10', timestamp: '2026-01-01' },
        { id: 2, entity: 'db_primary_ip', content: '198.51.100.11', supersedesId: 1, timestamp: '2026-02-01' },
        { id: 3, entity: 'db_primary_ip', content: '198.51.100.99 (invalid)', status: 'INVALIDATED', timestamp: '2026-03-01' }
    ];
    const filteredPure = filterActiveMemories(rawMemList);
    assert.strictEqual(filteredPure.length, 1, "Pure filter should return only ID 2");
    assert.strictEqual(filteredPure[0].id, 2);
    console.log(`✔ Pure Memory Filter: Successfully filtered raw candidate array`);

    console.log("\n🎉 ALL UNIT & INTEGRATION TESTS PASSED CLEANLY (100% SUCCESS)!\n");
}

runTests().catch(err => {
    console.error("❌ Test suite failed with error:", err);
    process.exit(1);
});

