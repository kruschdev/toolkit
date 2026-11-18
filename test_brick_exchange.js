import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { s } from './schema.js';
import { runCli } from './bin/krusch-lego.js';
import {
    scanBrickSourceSafety,
    executeInBrickSandbox,
    generateBrickSigningKeyPair,
    sealBrick,
    verifyBrickBundle,
    runBrickRepairLoop,
    createBrickExchangeStore,
    tryBrickLocally,
    adoptBrickIntoRepo,
    auditRepoBrickLocks,
    createBrickExchangeServer,
    BRICK_EXCHANGE_MCP_TOOLS,
    createBrickExchangeMcpServer,
    analyzeBrickBlastRadius,
    planAgentFanOut,
    verifyTwoHopBlastRadius,
    stageScoutCandidateSpecs
} from './brick-exchange.js';

const TELEMETRY_BLUEPRINT = {
    id: 'telemetry-completeness',
    name: 'Telemetry Completeness Inspector',
    summary: 'Detects missing cadence readings, duplicates, and malformed values in sensor time series.',
    exportName: 'inspectSeries',
    language: 'ts',
    inputSchema: s.array(s.object({ ts: s.number(), val: s.any() })),
    outputSchema: s.object({
        rows: s.number(),
        missingCount: s.number(),
        duplicateCount: s.number(),
        negativePreserved: s.number()
    })
};

const VALID_TELEMETRY_TS_SOURCE = `
export interface Reading {
  ts: number;
  val: unknown;
}

export interface BindingConfig {
  expectedCount?: number;
  skipHeaderRow?: boolean;
}

export function inspectSeries(rows: Reading[], binding: BindingConfig = {}) {
  const slice = binding.skipHeaderRow ? rows.slice(1) : rows;
  const seen = new Set<number>();
  let missingCount = 0;
  let duplicateCount = 0;
  let negativePreserved = 0;

  for (const row of slice) {
    if (seen.has(row.ts)) {
      duplicateCount += 1;
    }
    seen.add(row.ts);
    if (row.val === null || row.val === '' || row.val === undefined) {
      missingCount += 1;
    } else if (typeof row.val === 'number' && Number.isFinite(row.val) && row.val < 0) {
      negativePreserved += 1;
    }
  }

  const expected = typeof binding.expectedCount === 'number' ? binding.expectedCount : slice.length;
  if (expected > seen.size) {
    missingCount += expected - seen.size;
  }

  return {
    rows: slice.length,
    missingCount,
    duplicateCount,
    negativePreserved
  };
}
`;

const POSITIVE_CHECKS = [
    {
        name: 'Ocean buoy clean cadence with units header skipped',
        input: [
            { ts: 0, val: 'm/s' },
            { ts: 60, val: 5.4 },
            { ts: 120, val: 0 },
            { ts: 180, val: -1.2 }
        ],
        binding: { skipHeaderRow: true, expectedCount: 3 },
        expectedOutput: {
            rows: 3,
            missingCount: 0,
            duplicateCount: 0,
            negativePreserved: 1
        }
    }
];

const FAULT_CHECKS = [
    {
        name: 'Catches injected missing timestamp and duplicate reading',
        input: [
            { ts: 60, val: 12.1 },
            { ts: 60, val: 12.1 },
            { ts: 180, val: null }
        ],
        binding: { skipHeaderRow: false, expectedCount: 4 },
        expectedOutput: {
            rows: 3,
            missingCount: 3,
            duplicateCount: 1,
            negativePreserved: 0
        }
    }
];

test('INV-LEGO-35 Gate 1 & Sandbox: rejects ambient I/O & secret leaks, strips TypeScript, and kills infinite loops', async () => {
    const fsSource = `import fs from 'node:fs';\nexport default () => fs.readFileSync('/etc/hosts', 'utf8');`;
    const safetyFs = scanBrickSourceSafety(fsSource);
    assert.equal(safetyFs.ok, false);

    const fakeToken = ['sk', 'liveSecretTokenValue1234567890'].join('-');
    const leakedSource = `export default () => "${fakeToken}";`;
    const safetyLeak = scanBrickSourceSafety(leakedSource);
    assert.equal(safetyLeak.ok, false);

    const safeTs = scanBrickSourceSafety(VALID_TELEMETRY_TS_SOURCE);
    assert.equal(safeTs.ok, true);

    const execOk = await executeInBrickSandbox({
        source: VALID_TELEMETRY_TS_SOURCE,
        exportName: 'inspectSeries',
        input: POSITIVE_CHECKS[0].input,
        binding: POSITIVE_CHECKS[0].binding
    });
    assert.equal(execOk.ok, true);
    assert.deepEqual(execOk.data.output, POSITIVE_CHECKS[0].expectedOutput);

    // Async Hexagonal port function injected via local binding
    const portRes = await executeInBrickSandbox({
        source: `export async function enrich(x, binding) { const rate = await binding.fetchRate(x.currency); return { total: x.amount * rate }; }`,
        exportName: 'enrich',
        input: { currency: 'USD', amount: 10 },
        binding: { fetchRate: async (c) => (c === 'USD' ? 2.5 : 1) }
    });
    assert.equal(portRes.ok, true);
    assert.deepEqual(portRes.data.output, { total: 25 });

    // Infinite loop killed deterministically within bounded deadline
    const loopRes = await executeInBrickSandbox({
        source: `export default function hang() { while (true) {} }`,
        exportName: 'default',
        input: {},
        timeoutMs: 250
    });
    assert.equal(loopRes.ok, false);
});

test('INV-LEGO-35 Gates 2-4 & Repair Loop: enforces mandatory fault challenges, seals with Ed25519, rejects tampering, and repairs buggy code', async () => {
    // Missing fault challenge must fail closed
    const noFaultRes = await sealBrick({
        blueprint: TELEMETRY_BLUEPRINT,
        source: VALID_TELEMETRY_TS_SOURCE,
        positiveChecks: POSITIVE_CHECKS,
        faultChecks: []
    });
    assert.equal(noFaultRes.ok, false);

    // Buggy initial implementation ignores skipHeaderRow; outer repair loop fixes it on attempt 2
    const buggySource = `
export function inspectSeries(rows) {
  return { rows: rows.length, missingCount: 0, duplicateCount: 0, negativePreserved: 0 };
}
`;
    const repairedRes = await runBrickRepairLoop({
        blueprint: TELEMETRY_BLUEPRINT,
        source: buggySource,
        positiveChecks: POSITIVE_CHECKS,
        faultChecks: FAULT_CHECKS,
        authorId: 'fabio',
        orgId: 'org-ocean',
        capabilities: ['telemetry', 'cadence-gaps', 'sensor-qc'],
        replacesBoilerplate: 'Manual CSV timestamp gap loops',
        estimatedHoursSaved: 12,
        maxAttempts: 3,
        repairFn: async ({ attempt, repairHints }) => {
            assert.equal(attempt, 1);
            assert.ok(Array.isArray(repairHints) && repairHints.length >= 1);
            return VALID_TELEMETRY_TS_SOURCE;
        }
    });

    assert.equal(repairedRes.ok, true);
    assert.equal(repairedRes.data.attempts, 2);

    const bundle = repairedRes.data.bundle;
    assert.equal(bundle.format, 'krusch-sealed-brick/v1');
    assert.equal(bundle.attestation.algorithm, 'ed25519');

    const verified = verifyBrickBundle(bundle);
    assert.equal(verified.ok, true);

    // 1-character tamper immediately breaks sourceHash
    const tampered = {
        ...bundle,
        source: bundle.source + '\n// edit'
    };
    assert.equal(verifyBrickBundle(tampered).ok, false);

    // Untrusted public key pin is rejected
    const otherKey = generateBrickSigningKeyPair().data.publicKeyPem;
    assert.equal(verifyBrickBundle(bundle, { trustedPublicKeyPem: otherKey }).ok, false);
});

test('INV-LEGO-35 Store, Tiered RBAC, HydraDB v2 Scoped Boost, Local Try, Repo Lockfile Drift, Hub & MCP', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krusch-brick-exchange-'));
    let server = null;
    let store = null;

    try {
        const hydraCalls = { ingested: [], queries: [], feedback: [] };
        const mockHydraClient = {
            isConfigured: () => true,
            ingestAppKnowledge: async (items, opts) => {
                hydraCalls.ingested.push({ items, opts });
                return { ok: true };
            },
            queryContext: async (opts) => {
                hydraCalls.queries.push(opts);
                return {
                    chunks: [{ relevancy_score: 0.88, collection: opts.collections?.[0] }],
                    contextString: 'Matched inverter telemetry cadence gaps',
                    _meta: { request_id: 'hydra_req_001' }
                };
            },
            submitFeedback: async (opts) => {
                hydraCalls.feedback.push(opts);
                return { submitted: true };
            }
        };

        const dbPath = path.join(tmpDir, 'exchange.db');
        store = createBrickExchangeStore({
            dbPath,
            auditHmacSecret: 'test-hmac-secret-for-audit-chain',
            hydraClient: mockHydraClient
        });

        // Set up 3 orgs: org-ocean <-> org-solar (mutual peers), org-isolated (not peered)
        assert.equal(
            store.upsertOrg({
                id: 'org-ocean',
                name: 'Ocean Robotics',
                participating: true,
                peers: ['org-solar'],
                publishers: ['fabio'],
                exporters: ['fabio'],
                receivers: ['fabio', 'theo']
            }).ok,
            true
        );
        assert.equal(
            store.upsertOrg({
                id: 'org-solar',
                name: 'Solar Grid Ops',
                participating: true,
                peers: ['org-ocean'],
                publishers: ['maya'],
                exporters: [],
                receivers: ['maya', 'leo']
            }).ok,
            true
        );
        assert.equal(
            store.upsertOrg({
                id: 'org-isolated',
                name: 'Isolated Corp',
                participating: true,
                peers: [],
                publishers: ['eve'],
                exporters: ['eve'],
                receivers: ['eve']
            }).ok,
            true
        );

        store.upsertMember({
            id: 'fabio',
            name: 'Fabio',
            orgId: 'org-ocean',
            publisher: true,
            exporter: true,
            capabilities: ['telemetry', 'sensor-qc'],
            receiveMode: 'federated'
        });
        store.upsertMember({
            id: 'theo',
            name: 'Theo',
            orgId: 'org-ocean',
            publisher: false,
            exporter: false,
            capabilities: ['telemetry'],
            receiveMode: 'team'
        });
        store.upsertMember({
            id: 'maya',
            name: 'Maya',
            orgId: 'org-solar',
            publisher: true,
            exporter: false,
            capabilities: ['telemetry', 'cadence-gaps'],
            receiveMode: 'federated'
        });
        store.upsertMember({
            id: 'leo',
            name: 'Leo',
            orgId: 'org-solar',
            publisher: false,
            exporter: false,
            capabilities: ['telemetry', 'cadence-gaps'],
            receiveMode: 'off'
        });
        store.upsertMember({
            id: 'eve',
            name: 'Eve',
            orgId: 'org-isolated',
            publisher: true,
            exporter: true,
            capabilities: ['telemetry', 'cadence-gaps'],
            receiveMode: 'federated'
        });

        const briefRes = await store.setWorkflowBrief({
            orgId: 'org-solar',
            brief: 'Detect missing cadence readings and duplicate inverter sensor telemetry before daily close.',
            capabilities: ['telemetry', 'cadence-gaps'],
            boilerplateSignals: ['telemetry-completeness']
        });
        assert.equal(briefRes.ok, true);
        assert.equal(hydraCalls.ingested.length, 1);

        const sealedRes = await sealBrick({
            blueprint: TELEMETRY_BLUEPRINT,
            source: VALID_TELEMETRY_TS_SOURCE,
            positiveChecks: POSITIVE_CHECKS,
            faultChecks: FAULT_CHECKS,
            authorId: 'fabio',
            orgId: 'org-ocean',
            capabilities: ['telemetry', 'cadence-gaps'],
            replacesBoilerplate: 'Manual CSV cadence checks',
            estimatedHoursSaved: 16
        });
        assert.equal(sealedRes.ok, true);
        const bundle = sealedRes.data.bundle;

        const pubRes = store.publishSealedBrick(bundle, { actorId: 'fabio' });
        assert.equal(pubRes.ok, true);

        // Tier 1 Team Commons: teammate Theo sees it immediately
        const theoInbox = store.listVisibleBricks({ viewerId: 'theo' });
        assert.equal(theoInbox.ok, true);
        assert.equal(theoInbox.data.bricks.length, 1);

        // Tier 2 Cross-Org Pre-Discovery: Maya sees 0 bricks before grant is issued
        const mayaBefore = store.listVisibleBricks({ viewerId: 'maya' });
        assert.equal(mayaBefore.ok, true);
        assert.equal(mayaBefore.data.bricks.length, 0);

        // Suggest recipients: recommends Theo (team) and Maya (federated), NEVER Leo (mode=off) or Eve (unpeered)
        const suggestRes = await store.suggestRecipients({
            actorId: 'fabio',
            brickId: bundle.brickId
        });
        assert.equal(suggestRes.ok, true);
        const suggestedIds = suggestRes.data.suggestions.map((x) => x.memberId);
        assert.ok(suggestedIds.includes('maya'));
        assert.equal(suggestedIds.includes('leo'), false);
        assert.equal(suggestedIds.includes('eve'), false);

        // Issue federated grant to Maya
        const grantRes = store.issueGrant({
            issuerId: 'fabio',
            brickId: bundle.brickId,
            sourceHash: bundle.lineage.sourceHash,
            scope: 'federated',
            recipients: ['maya'],
            expiresAt: new Date(Date.now() + 86_400_000).toISOString()
        });
        assert.equal(grantRes.ok, true);
        const grantId = grantRes.data.grant.id;

        const mayaAfter = store.listVisibleBricks({ viewerId: 'maya' });
        assert.equal(mayaAfter.data.bricks.length, 1);

        // Recipient local sandbox verification with solar binding (nothing uploaded)
        const solarTry = await tryBrickLocally({
            bundle,
            binding: { skipHeaderRow: false, expectedCount: 3 },
            sampleInput: [
                { ts: 1000, val: -4.5 },
                { ts: 2000, val: 120.0 }
            ]
        });
        assert.equal(solarTry.ok, true);
        assert.deepEqual(solarTry.data.output, {
            rows: 2,
            missingCount: 1,
            duplicateCount: 0,
            negativePreserved: 1
        });

        // Adopt into Maya's repository + verify .brick-lock.json + HydraDB /feedback
        const mayaRepo = path.join(tmpDir, 'palmetto-solar-repo');
        fs.mkdirSync(mayaRepo, { recursive: true });
        const adoptRepoRes = await adoptBrickIntoRepo({
            bundle,
            targetRepoDir: mayaRepo,
            grantId,
            adoptedBy: 'maya'
        });
        assert.equal(adoptRepoRes.ok, true);

        const recRes = await store.recordAdoption({
            userId: 'maya',
            brickId: bundle.brickId,
            sourceHash: bundle.lineage.sourceHash,
            grantId,
            localChecksPassed: true,
            hydraRequestId: 'hydra_req_001'
        });
        assert.equal(recRes.ok, true);
        assert.equal(hydraCalls.feedback.length, 1);

        // Clean lock audit via krusch-lego CLI
        const cleanAudit = await runCli(['audit', mayaRepo, '--json'], { stdout: () => {}, stderr: () => {} });
        assert.equal(cleanAudit.payload.ok, true);
        assert.equal(cleanAudit.payload.data.clean, true);
        assert.equal(cleanAudit.payload.data.brickLockStatus.lockedBrickCount, 1);

        // Tamper 1 byte in vendored brick -> krusch-lego audit flags drift!
        fs.appendFileSync(adoptRepoRes.data.entryPath, '\n// unauthorized local mutation\n', 'utf8');
        const driftedAudit = await runCli(['audit', mayaRepo, '--json'], { stdout: () => {}, stderr: () => {} });
        assert.equal(driftedAudit.payload.data.clean, false);
        assert.equal(driftedAudit.payload.data.breakerTripped, true);
        assert.equal(auditRepoBrickLocks(mayaRepo).data.clean, false);

        // Revoking grant immediately blocks Maya's future fetches
        const revRes = store.revokeGrant({ actorId: 'fabio', grantId });
        assert.equal(revRes.ok, true);
        assert.equal(store.listVisibleBricks({ viewerId: 'maya' }).data.bricks.length, 0);

        // Audit chain integrity verified
        const ledgerStatus = store.verifyLedger();
        assert.equal(ledgerStatus.ok, true);

        // HTTP Hub + Reuse Console + 10-tool MCP server smoke test
        server = createBrickExchangeServer({ store });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const addr = server.address();
        const baseUrl = `http://127.0.0.1:${addr.port}`;

        const htmlRes = await fetch(`${baseUrl}/`);
        assert.equal(htmlRes.status, 200);
        const html = await htmlRes.text();
        assert.match(html, /Brick Exchange/i);
        assert.equal(html.includes('\u2014'), false, 'Console HTML must contain zero em dashes');

        const statsRes = await fetch(`${baseUrl}/api/stats`);
        const statsJson = await statsRes.json();
        assert.equal(statsJson.ok, true);
        assert.equal(statsJson.data.sealedBrickCount, 1);
        assert.equal(statsJson.data.adoptionCount, 1);

        assert.equal(BRICK_EXCHANGE_MCP_TOOLS.length, 10);
        for (const t of BRICK_EXCHANGE_MCP_TOOLS) {
            assert.equal(typeof t.annotations.readOnlyHint, 'boolean');
            assert.equal(typeof t.annotations.destructiveHint, 'boolean');
            assert.equal(typeof t.annotations.idempotentHint, 'boolean');
            assert.equal(typeof t.annotations.openWorldHint, 'boolean');
        }

        const mcp = await createBrickExchangeMcpServer({ store, connect: false });
        const mcpInbox = await mcp.callTool({
            params: { name: 'brick_inbox', arguments: { viewerId: 'theo' } }
        });
        assert.ok(!mcpInbox.isError);
    } finally {
        if (server) {
            await new Promise((resolve) => server.close(resolve));
        }
        if (store) {
            store.close();
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('INV-LEGO-35 Deadbolt 2-Hop AST Blast Radius & Multi-Agent Fan-Out: catches 2-hop SOX cent drift, blocks workarounds, and sequences colliding subagents', async () => {
    const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'krusch-deadbolt-blast-'));
    try {
        fs.mkdirSync(path.join(tmpRepo, 'bricks', 'fee-engine'), { recursive: true });
        fs.mkdirSync(path.join(tmpRepo, 'src'), { recursive: true });
        fs.writeFileSync(path.join(tmpRepo, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');

        // Hop 0: Shared fee-engine brick (largest-remainder integer cent allocation)
        fs.writeFileSync(
            path.join(tmpRepo, 'bricks', 'fee-engine', 'index.js'),
            `export function allocateLineFees(amountsCents, feeBps) {
  const gross = amountsCents.reduce((a, b) => a + b, 0);
  const expectedBatchFee = Math.round((gross * feeBps) / 10000);
  const floors = amountsCents.map((amt, idx) => {
    const exact = (amt * feeBps) / 10000;
    const fl = Math.floor(exact);
    return { idx, fl, rem: exact - fl };
  });
  let remainder = expectedBatchFee - floors.reduce((s, x) => s + x.fl, 0);
  floors.sort((a, b) => b.rem - a.rem || a.idx - b.idx);
  for (let i = 0; i < remainder; i++) floors[i].fl += 1;
  floors.sort((a, b) => a.idx - b.idx);
  return floors.map((x) => x.fl);
}\n`,
            'utf8'
        );

        // Hop 1: Settlement service importing bricks/fee-engine/index.js
        fs.writeFileSync(
            path.join(tmpRepo, 'src', 'settlement-service.js'),
            `import { allocateLineFees } from '../bricks/fee-engine/index.js';
export function settleInvoiceBatch(amountsCents, feeBps) {
  const fees = allocateLineFees(amountsCents, feeBps);
  const netPayouts = amountsCents.map((amt, i) => amt - fees[i]);
  return { grossCents: amountsCents.reduce((a, b) => a + b, 0), fees, netPayouts, feeBps };
}\n`,
            'utf8'
        );

        // Hop 2: Protected SOX reconciler 2 hops downstream of bricks/fee-engine/index.js
        fs.writeFileSync(
            path.join(tmpRepo, 'src', 'sox-reconciler.js'),
            `import { settleInvoiceBatch } from './settlement-service.js';
export function reconcileSoxBatch(amountsCents, feeBps) {
  const batch = settleInvoiceBatch(amountsCents, feeBps);
  const batchFee = Math.round((batch.grossCents * feeBps) / 10000);
  const sumNet = batch.netPayouts.reduce((a, b) => a + b, 0);
  const deltaCents = sumNet + batchFee - batch.grossCents;
  return { passed: deltaCents === 0, deltaCents, sumNet, batchFee };
}\n`,
            'utf8'
        );

        // Disjoint leaf module for Subagent C
        fs.writeFileSync(
            path.join(tmpRepo, 'src', 'webhook-hmac.js'),
            `export function checkWebhookTag(tag) { return typeof tag === 'string' && tag.length > 0; }\n`,
            'utf8'
        );

        // Orchestrator choke point
        fs.writeFileSync(
            path.join(tmpRepo, 'src', 'server.js'),
            `import { reconcileSoxBatch } from './sox-reconciler.js';\nimport { checkWebhookTag } from './webhook-hmac.js';\nexport { reconcileSoxBatch, checkWebhookTag };\n`,
            'utf8'
        );

        // 1. Map 2-hop AST blast radius from bricks/fee-engine/index.js
        const blast = analyzeBrickBlastRadius({
            repoDir: tmpRepo,
            changedFiles: ['bricks/fee-engine/index.js'],
            protectedFiles: ['src/sox-reconciler.js']
        });
        assert.equal(blast.ok, true);
        assert.deepEqual(blast.data.hop1Dependents, ['src/settlement-service.js']);
        assert.deepEqual(blast.data.hop2Dependents, ['src/sox-reconciler.js']);
        assert.ok(
            blast.data.hopPaths.includes(
                'bricks/fee-engine/index.js -> src/settlement-service.js -> src/sox-reconciler.js'
            )
        );
        assert.deepEqual(blast.data.impactedProtectedFiles, ['src/sox-reconciler.js']);

        // 2. Multi-Agent Fan-Out Wave Planner:
        //    Agent A edits `bricks/fee-engine/index.js`, Agent B edits `src/settlement-service.js` (collides in 2-hop cone!),
        //    Agent C edits `src/webhook-hmac.js` (completely disjoint -> runs in parallel in Wave 1 with Agent A!)
        const fanout = planAgentFanOut({
            repoDir: tmpRepo,
            tasks: [
                { id: 'AGENT-A', title: 'Upgrade fee brick', targetFiles: ['bricks/fee-engine/index.js'] },
                { id: 'AGENT-B', title: 'Update settlement batch', targetFiles: ['src/settlement-service.js'] },
                { id: 'AGENT-C', title: 'Harden webhook check', targetFiles: ['src/webhook-hmac.js'] }
            ],
            protectedFiles: ['src/sox-reconciler.js']
        });
        assert.equal(fanout.ok, true);
        assert.equal(fanout.data.waveCount, 2);
        assert.deepEqual(fanout.data.waves[0].taskIds, ['AGENT-A', 'AGENT-C']);
        assert.deepEqual(fanout.data.waves[1].taskIds, ['AGENT-B']);
        assert.equal(fanout.data.collisions.length, 1);
        assert.ok(fanout.data.reservedOrchestratorFiles.includes('src/server.js'));

        const agentALease = fanout.data.agentLeases.find((l) => l.taskId === 'AGENT-A');
        const invariantScript = `
            import { reconcileSoxBatch } from './src/sox-reconciler.js';
            const res = reconcileSoxBatch([3334, 3333, 3333], 250);
            __emitResult(res);
        `;

        // 3A. Engineer/Agent A breaks 2-hop SOX invariant with naive per-line Math.round (+1 cent drift 2 hops away!)
        const naiveEdit = await verifyTwoHopBlastRadius({
            repoDir: tmpRepo,
            candidateEdits: {
                'bricks/fee-engine/index.js': `export function allocateLineFees(amountsCents, feeBps) {
  return amountsCents.map((amt) => Math.round((amt * feeBps) / 10000));
}\n`
            },
            lease: agentALease,
            protectedFiles: ['src/sox-reconciler.js'],
            invariantScript
        });
        assert.equal(naiveEdit.ok, false);
        assert.equal(naiveEdit.error.code, 'TWO_HOP_INVARIANT_BROKEN');
        assert.equal(naiveEdit.error.details.sandboxOutcome.deltaCents, 1);
        assert.ok(
            naiveEdit.error.details.hopPaths.includes(
                'bricks/fee-engine/index.js -> src/settlement-service.js -> src/sox-reconciler.js'
            )
        );

        // 3B. Agent A tries sneaky workaround editing protected 2-hop `src/sox-reconciler.js` -> blocked by Lease & Policy Floor!
        const sneakyLeaseBreak = await verifyTwoHopBlastRadius({
            repoDir: tmpRepo,
            candidateEdits: {
                'src/sox-reconciler.js': `export function reconcileSoxBatch() { return { passed: true, deltaCents: 0 }; }\n`
            },
            lease: agentALease,
            protectedFiles: ['src/sox-reconciler.js'],
            invariantScript
        });
        assert.equal(sneakyLeaseBreak.ok, false);
        assert.equal(sneakyLeaseBreak.error.code, 'LEASE_BOUNDARY_VIOLATION');

        const sneakyPolicyFloor = await verifyTwoHopBlastRadius({
            repoDir: tmpRepo,
            candidateEdits: {
                'src/sox-reconciler.js': `export function reconcileSoxBatch() { return { passed: true, deltaCents: 0 }; }\n`
            },
            protectedFiles: ['src/sox-reconciler.js'],
            invariantScript
        });
        assert.equal(sneakyPolicyFloor.ok, false);
        assert.equal(sneakyPolicyFloor.error.code, 'WORKAROUND_REJECTED');

        // 3C. Engineer removes exported `allocateLineFees` symbol -> caught statically in <1ms (`BROKEN_AST_EXPORT`)
        const brokenSymbol = await verifyTwoHopBlastRadius({
            repoDir: tmpRepo,
            candidateEdits: {
                'bricks/fee-engine/index.js': `export function renamedHelper() { return []; }\n`
            },
            lease: agentALease,
            protectedFiles: ['src/sox-reconciler.js']
        });
        assert.equal(brokenSymbol.ok, false);
        assert.equal(brokenSymbol.error.code, 'BROKEN_AST_EXPORT');

        // 3D. Valid integer-cent preserving edit passes all 2-hop gates cleanly!
        const cleanPass = await verifyTwoHopBlastRadius({
            repoDir: tmpRepo,
            candidateEdits: {
                'bricks/fee-engine/index.js': fs.readFileSync(
                    path.join(tmpRepo, 'bricks', 'fee-engine', 'index.js'),
                    'utf8'
                )
            },
            lease: agentALease,
            protectedFiles: ['src/sox-reconciler.js'],
            invariantScript
        });
        assert.equal(cleanPass.ok, true);
        assert.equal(cleanPass.data.invariantResult.deltaCents, 0);
    } finally {
        fs.rmSync(tmpRepo, { recursive: true, force: true });
    }
});

test('INV-LEGO-35 Scout-to-Brick-Exchange Loop: stageScoutCandidateSpecs enforces Rule-of-3, seals implementation, and suggests recipients', async () => {
    const store = createBrickExchangeStore({ dbPath: ':memory:' });
    try {
        store.upsertOrg({
            id: 'org-alpha',
            name: 'Alpha Eng',
            participating: true,
            publishers: ['jean-sre'],
            exporters: ['jean-sre'],
            receivers: ['jean-sre', 'alice']
        });
        store.upsertMember({
            id: 'jean-sre',
            name: 'Jean SRE',
            orgId: 'org-alpha',
            publisher: true,
            exporter: true,
            capabilities: ['idempotency', 'storage']
        });
        store.upsertMember({
            id: 'alice',
            name: 'Alice',
            orgId: 'org-alpha',
            publisher: false,
            exporter: false,
            capabilities: ['retry-backoff', 'api-service'],
            receiveMode: 'team'
        });

        const fakeScoutReport = {
            ok: true,
            data: {
                ruleOfThreeThreshold: 3,
                candidateClusters: [
                    {
                        id: 'retry-backoff',
                        title: 'Deterministic Jittered Backoff Calculator',
                        runtime: 'node',
                        category: 'resilience',
                        projectCount: 3,
                        meetsRuleOfThree: true,
                        status: 'CANDIDATE_MEETS_RULE_OF_3',
                        proposedBrickImport: '@krusch/toolkit/retry-backoff',
                        antiBloatNote: 'Repeated exponential retry loops across 3 services.',
                        projects: ['api-service', 'worker-service', 'sync-service'],
                        sampleEvidence: ['<HOMELAB_ROOT>/projects/api-service/src/retry.js']
                    },
                    {
                        id: 'one-off-helper',
                        title: 'Single-Repo Helper',
                        runtime: 'node',
                        category: 'misc',
                        projectCount: 1,
                        meetsRuleOfThree: false,
                        status: 'BELOW_THRESHOLD_DO_NOT_EXTRACT',
                        proposedBrickImport: '@krusch/toolkit/one-off',
                        antiBloatNote: 'Below threshold.',
                        projects: ['api-service'],
                        sampleEvidence: []
                    }
                ]
            }
        };

        const staged = await stageScoutCandidateSpecs(fakeScoutReport, {
            authorId: 'jean-sre',
            orgId: 'org-alpha',
            store,
            implementations: {
                'retry-backoff': {
                    blueprint: {
                        inputSchema: s.object({ attempt: s.number() }),
                        outputSchema: s.object({ delayMs: s.number() })
                    },
                    source: `export default function calcBackoff(input, binding = {}) {
                        if (typeof input.attempt !== 'number' || input.attempt < 0) {
                            throw new Error('Negative attempt rejected');
                        }
                        const base = typeof binding.baseMs === 'number' ? binding.baseMs : 100;
                        return { delayMs: base * Math.pow(2, input.attempt) };
                    }`,
                    positiveChecks: [{ name: 'attempt 2', input: { attempt: 2 }, expectedOutput: { delayMs: 400 } }],
                    faultChecks: [{ name: 'rejects negative attempt', input: { attempt: -1 }, expectThrow: true, expectedErrorSubstring: 'Negative' }]
                }
            }
        });

        assert.equal(staged.ok, true);
        assert.equal(staged.data.qualifyingClusterCount, 1);
        assert.equal(staged.data.sealedBundles.length, 1);
        assert.equal(staged.data.sealedBundles[0].brickId, 'retry-backoff');
        assert.equal(staged.data.sealedBundles[0].published.ok, true);
        assert.ok(staged.data.sealedBundles[0].suggestions.some((x) => x.memberId === 'alice'));
    } finally {
        store.close();
    }
});
