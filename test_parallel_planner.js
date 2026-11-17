import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    DEFAULT_CHOKE_POINT_FILES,
    normalizeRelativeCodePath,
    planDisjointTaskWaves,
    runNodePermissionSandbox,
} from './parallel-planner.js';

test('INV-LEGO-PP-01: planDisjointTaskWaves computes 2-hop blast cones, reserves choke points, and separates overlapping subagents into waves', () => {
    assert.ok(DEFAULT_CHOKE_POINT_FILES.includes('src/server.js'));
    assert.equal(normalizeRelativeCodePath('./src\\billing//fee-engine.js'), 'src/billing/fee-engine.js');
    assert.equal(normalizeRelativeCodePath('../../etc/passwd'), '');

    const edges = [
        // server.js imports both settlement.js and webhook-handler.js (shared choke point)
        { from: 'src/server.js', to: 'src/billing/settlement.js' },
        { from: 'src/server.js', to: 'src/webhooks/stripe-handler.js' },
        // 2-hop domain chain: fee-engine -> settlement -> sox-reconciler
        { from: 'src/billing/settlement.js', to: 'src/billing/fee-engine.js' },
        { from: 'src/compliance/sox-reconciler.js', to: 'src/billing/settlement.js' },
    ];

    // Case A: Disjoint domain tasks sharing only choke point src/server.js -> single parallel Wave 1!
    const disjointPlan = planDisjointTaskWaves({
        tasks: [
            { id: 'WO-101', title: 'Fix fee rounding', targetFiles: ['src/billing/fee-engine.js'] },
            { id: 'WO-102', title: 'Harden webhook HMAC', targetFiles: ['src/webhooks/stripe-handler.js'] },
        ],
        edges,
    });
    assert.equal(disjointPlan.ok, true);
    assert.equal(disjointPlan.data.waveCount, 1);
    assert.equal(disjointPlan.data.fullyParallelSingleWave, true);
    assert.deepEqual(disjointPlan.data.waves[0].taskIds, ['WO-101', 'WO-102']);
    assert.deepEqual(disjointPlan.data.reservedOrchestratorFiles, ['src/server.js']);

    const wo101 = disjointPlan.data.leases.find((l) => l.taskId === 'WO-101');
    assert.deepEqual(wo101.hop1Dependents, ['src/billing/settlement.js']);
    assert.deepEqual(wo101.hop2Dependents, ['src/compliance/sox-reconciler.js']);

    // Case B: Overlapping 2-hop cone (WO-103 touches sox-reconciler.js, which is in WO-101's 2-hop cone) -> split into Wave 1 & Wave 2!
    const collidingPlan = planDisjointTaskWaves({
        tasks: [
            { id: 'WO-101', targetFiles: ['src/billing/fee-engine.js'] },
            { id: 'WO-102', targetFiles: ['src/webhooks/stripe-handler.js'] },
            { id: 'WO-103', targetFiles: ['src/compliance/sox-reconciler.js'] },
        ],
        edges,
    });
    assert.equal(collidingPlan.data.waveCount, 2);
    assert.equal(collidingPlan.data.fullyParallelSingleWave, false);
    assert.deepEqual(collidingPlan.data.waves[0].taskIds, ['WO-101', 'WO-102']);
    assert.deepEqual(collidingPlan.data.waves[1].taskIds, ['WO-103']);
    assert.equal(collidingPlan.data.collisions.length, 1);
    assert.deepEqual(collidingPlan.data.collisions[0].sharedFiles, ['src/compliance/sox-reconciler.js']);
});

test('INV-LEGO-PP-02: runNodePermissionSandbox strips host env secrets, enforces read-only FS bounds, blocks writes/child_process, and extracts __emitResult JSON', async () => {
    const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-sandbox-ok-'));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-sandbox-outside-'));
    process.env.TEST_HOST_SECRET_DO_NOT_LEAK = 'top-secret-host-value';

    try {
        fs.writeFileSync(
            path.join(wsDir, 'math.js'),
            'export function allocateCents(total) { return [Math.floor(total / 2), total - Math.floor(total / 2)]; }\n',
            'utf8'
        );
        const outsideSecretFile = path.join(outsideDir, 'outside.txt');
        fs.writeFileSync(outsideSecretFile, 'OUTSIDE_DATA', 'utf8');

        // 1. Authorized workspace import + __emitResult + stripped host env
        const okRes = await runNodePermissionSandbox({
            workspaceDir: wsDir,
            script: `
                import { allocateCents } from './math.js';
                const parts = allocateCents(101);
                __emitResult({
                    parts,
                    sum: parts[0] + parts[1],
                    leakedSecret: process.env.TEST_HOST_SECRET_DO_NOT_LEAK ?? null
                });
            `,
            timeoutMs: 3000,
        });
        assert.equal(okRes.ok, true);
        assert.equal(okRes.data.passed, true);
        assert.deepEqual(okRes.data.result, {
            parts: [50, 51],
            sum: 101,
            leakedSecret: null,
        });

        // 2. Unauthorized read outside workspaceDir -> ERR_ACCESS_DENIED
        const escapeRead = await runNodePermissionSandbox({
            workspaceDir: wsDir,
            script: `
                import fs from 'node:fs';
                fs.readFileSync(${JSON.stringify(outsideSecretFile)}, 'utf8');
            `,
            timeoutMs: 3000,
        });
        assert.equal(escapeRead.ok, true);
        assert.equal(escapeRead.data.passed, false);
        assert.equal(escapeRead.data.permissionDenied, true);

        // 3. Unauthorized write inside workspaceDir (when allowWritePaths is empty) -> ERR_ACCESS_DENIED
        const blockedWrite = await runNodePermissionSandbox({
            workspaceDir: wsDir,
            script: `
                import fs from 'node:fs';
                fs.writeFileSync('./tampered.js', 'hacked', 'utf8');
            `,
            timeoutMs: 3000,
        });
        assert.equal(blockedWrite.ok, true);
        assert.equal(blockedWrite.data.passed, false);
        assert.equal(blockedWrite.data.permissionDenied, true);
    } finally {
        delete process.env.TEST_HOST_SECRET_DO_NOT_LEAK;
        fs.rmSync(wsDir, { recursive: true, force: true });
        fs.rmSync(outsideDir, { recursive: true, force: true });
    }
});
