import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { s } from './schema.js';
import { sealBrick } from './brick-exchange.js';
import { scanTextForLeaks } from './scripts/verify-zero-leaks.js';
import {
    ONTOLOGY_STACKS,
    ONTOLOGY_DATA_PORTS,
    ONTOLOGY_CHANNELS,
    ONTOLOGY_MOE_PROFILES,
    CROSS_STACK_BRICK_EQUIVALENTS,
    CANONICAL_SHARED_TYPES,
    resolveCrossStackCatalogEquivalents,
    isWebStandardPureSource,
    parsePortReference,
    arePortsCompatible,
    normalizeBrickOntologyMetadata,
    checkOntologyCompatibility,
    surrogateOntologyVertexId,
    compileBrickOntologyGraph,
    syncBrickOntologyToHydra,
    traverseBrickOntology,
    applyFieldMapToSample,
    synthesizeBrickBinding,
} from './brick-exchange/ontology.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TELEMETRY_BLUEPRINT = {
    id: 'telemetry-completeness',
    name: 'Telemetry Completeness Inspector',
    summary: 'Detects missing cadence readings, duplicates, and signed negative values in sensor time series.',
    exportName: 'inspectSeries',
    language: 'ts',
    inputSchema: s.array(s.object({ ts: s.number(), val: s.any() })),
    outputSchema: s.object({
        rows: s.number(),
        missingCount: s.number(),
        duplicateCount: s.number(),
        negativePreserved: s.number(),
    }),
};

const TELEMETRY_TS_SOURCE = `
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

async function buildSealedTelemetryBrick() {
    const res = await sealBrick({
        blueprint: TELEMETRY_BLUEPRINT,
        source: TELEMETRY_TS_SOURCE,
        positiveChecks: [
            {
                name: 'Clean cadence with header skipped',
                input: [
                    { ts: 0, val: 'm/s' },
                    { ts: 60, val: 5.4 },
                    { ts: 120, val: 0 },
                    { ts: 180, val: -1.2 },
                ],
                binding: { skipHeaderRow: true, expectedCount: 3 },
                expectedOutput: {
                    rows: 3,
                    missingCount: 0,
                    duplicateCount: 0,
                    negativePreserved: 1,
                },
            },
        ],
        faultChecks: [
            {
                name: 'Detects duplicate reading and missing cadence slot',
                input: [
                    { ts: 60, val: 10 },
                    { ts: 60, val: 10 },
                    { ts: 180, val: null },
                ],
                binding: { skipHeaderRow: false, expectedCount: 4 },
                expectedOutput: {
                    rows: 3,
                    missingCount: 3,
                    duplicateCount: 1,
                    negativePreserved: 0,
                },
            },
        ],
        authorId: 'author-ocean',
        orgId: 'org-ocean',
        capabilities: ['telemetry', 'timeseries'],
        createdAt: '2026-11-10T00:00:00.000Z',
    });
    assert.equal(res.ok, true);
    return res.data.bundle;
}

test('INV-LEGO-36 & INV-LEGO-26: Zero-Leak clean scan on ontology.js and test_brick_ontology.js', () => {
    const ontologySource = fs.readFileSync(
        path.join(__dirname, 'brick-exchange', 'ontology.js'),
        'utf8'
    );
    const testSource = fs.readFileSync(__filename, 'utf8');

    assert.deepEqual(scanTextForLeaks(ontologySource, 'brick-exchange/ontology.js'), []);
    assert.deepEqual(scanTextForLeaks(testSource, 'test_brick_ontology.js'), []);
});

test('INV-LEGO-36 Axis 1 & Catalog Equivalence: 4-axis registries are deep-frozen, prototype-safe, and map Node <-> Python/React/Edge bricks', () => {
    for (const reg of [
        ONTOLOGY_STACKS,
        ONTOLOGY_DATA_PORTS,
        ONTOLOGY_CHANNELS,
        ONTOLOGY_MOE_PROFILES,
        CROSS_STACK_BRICK_EQUIVALENTS,
    ]) {
        assert.equal(Object.isFrozen(reg), true);
        for (const val of Object.values(reg)) {
            assert.equal(Object.isFrozen(val), true);
        }
    }

    assert.deepEqual(Object.keys(ONTOLOGY_STACKS), [
        'node-esm',
        'typescript-node',
        'python-fastapi',
        'react-vite',
        'cloudflare-edge',
    ]);
    assert.equal(ONTOLOGY_STACKS['cloudflare-edge'].requiresWebStandardPurity, true);
    assert.equal(ONTOLOGY_STACKS['cloudflare-edge'].supportsNodeBuiltins, false);
    assert.equal(ONTOLOGY_STACKS['react-vite'].requiresWebStandardPurity, true);
    assert.equal(ONTOLOGY_STACKS['typescript-node'].adapterFileName, 'binding.ts');
    assert.equal(ONTOLOGY_STACKS['python-fastapi'].adapterFileName, 'binding_adapter.py');

    // Verify full catalog equivalence resolution across all 4 runtimes (node, python, react, edge)
    const allCat = resolveCrossStackCatalogEquivalents();
    assert.equal(allCat.ok, true);
    assert.ok(allCat.data.totalRuntimeBricks >= 40);
    assert.equal(allCat.data.archetypes.length, 7);

    const expectedPairs = [
        ['http', 'fastapi_app'],
        ['mcp', 'python_mcp'],
        ['pg', 'python_pg'],
        ['security', 'python_security'],
        ['schema', 'python_schema'],
        ['upload', 'python_upload'],
        ['yaml', 'python_yaml'],
        ['db', 'python_db_async'],
    ];
    for (const [nodeId, pyId] of expectedPairs) {
        const forward = resolveCrossStackCatalogEquivalents(nodeId);
        assert.equal(forward.ok, true);
        assert.equal(forward.data.byRuntime.node?.id, nodeId);
        assert.equal(forward.data.byRuntime.python?.id, pyId);

        const reverse = resolveCrossStackCatalogEquivalents(pyId);
        assert.equal(reverse.ok, true);
        assert.equal(reverse.data.byRuntime.node?.id, nodeId);
        assert.equal(reverse.data.byRuntime.python?.id, pyId);
    }

    const pyStackCat = resolveCrossStackCatalogEquivalents('python-fastapi');
    assert.equal(pyStackCat.ok, true);
    assert.equal(pyStackCat.data.runtime, 'python');
    assert.ok(pyStackCat.data.archetypes.some((a) => a.id === 'python-fastapi-service'));

    // Prototype-pollution payloads fail closed everywhere
    const pollutedPayload = JSON.parse('{"__proto__":{"polluted":true}}');
    assert.equal(normalizeBrickOntologyMetadata(pollutedPayload).ok, false);
    assert.equal(normalizeBrickOntologyMetadata(pollutedPayload).error.code, 'ONTOLOGY_FORBIDDEN_KEY');
    assert.equal(resolveCrossStackCatalogEquivalents('__proto__').ok, false);
    assert.equal(parsePortReference('__proto__'), null);
    assert.equal(parsePortReference('slack:constructor'), null);
});

test('INV-LEGO-36 Web-Standard Purity & Stack Runtime Compatibility Gate', async () => {
    const pureTelemetry = isWebStandardPureSource(TELEMETRY_TS_SOURCE);
    assert.equal(pureTelemetry.pure, true);
    assert.deepEqual(pureTelemetry.violations, []);

    const autoNormPure = normalizeBrickOntologyMetadata({}, { source: TELEMETRY_TS_SOURCE });
    assert.equal(autoNormPure.ok, true);
    assert.deepEqual(autoNormPure.data.ontology.stacks, [
        'node-esm',
        'typescript-node',
        'react-vite',
        'cloudflare-edge',
    ]);

    const fsSource = `import fs from 'node:fs';\nexport function load(p) { return fs.readFileSync(p, 'utf8'); }`;
    const envSource = `export function readEnv() { return process.env.API_ENDPOINT || ''; }`;
    const bufSource = `export function encodeHex(s) { return Buffer.from(s, 'utf8').toString('hex'); }`;

    for (const hostBoundSource of [fsSource, envSource, bufSource]) {
        const purity = isWebStandardPureSource(hostBoundSource);
        assert.equal(purity.pure, false);
        assert.ok(purity.violations.length >= 1);

        const edgeCheck = checkOntologyCompatibility({
            bundle: { brickId: 'host-bound-brick', source: hostBoundSource },
            targetStack: 'cloudflare-edge',
        });
        assert.equal(edgeCheck.ok, false);
        assert.equal(edgeCheck.error.code, 'STACK_RUNTIME_INCOMPATIBLE');

        const reactCheck = checkOntologyCompatibility({
            bundle: { brickId: 'host-bound-brick', source: hostBoundSource },
            targetStack: 'react-vite',
        });
        assert.equal(reactCheck.ok, false);
        assert.equal(reactCheck.error.code, 'STACK_RUNTIME_INCOMPATIBLE');
    }

    const sealedTelemetry = await buildSealedTelemetryBrick();
    const edgeOk = checkOntologyCompatibility({
        bundle: sealedTelemetry,
        targetStack: 'cloudflare-edge',
    });
    assert.equal(edgeOk.ok, true);
    assert.equal(edgeOk.data.bridgeMode, 'native');

    const pyContractOk = checkOntologyCompatibility({
        bundle: sealedTelemetry,
        targetStack: 'python-fastapi',
    });
    assert.equal(pyContractOk.ok, true);
    assert.equal(pyContractOk.data.bridgeMode, 'contract-adapter');
    assert.ok(pyContractOk.data.warnings.some((w) => w.includes('binding_adapter.py')));
});

test('INV-LEGO-36 Port Namespace Isolation (ONTOLOGY_DATA_PORTS + CANONICAL_SHARED_TYPES vs Scoped Opaque IDs)', () => {
    assert.equal(arePortsCompatible('slack:channel_id', 'discord:channel_id'), false);
    assert.equal(arePortsCompatible('slack.channel_id', 'discord:channel_id'), false);
    assert.equal(arePortsCompatible('slack:channel_id', 'slack:channel_id'), true);
    assert.equal(arePortsCompatible('slack.channel_id', 'slack:channel_id'), true);
    assert.equal(arePortsCompatible('ledger_event', 'ledger_event'), true);
    assert.equal(arePortsCompatible('canonical:timeseries_window', 'timeseries_window'), true);

    // Every CANONICAL_SHARED_TYPES entry from tool-graph.js is shared: true in ontology port resolution
    for (const sharedType of CANONICAL_SHARED_TYPES) {
        const parsed = parsePortReference(sharedType);
        assert.ok(parsed);
        assert.equal(parsed.shared, true);
        assert.equal(parsed.namespace, 'canonical');
        assert.equal(arePortsCompatible(sharedType, `canonical:${sharedType}`), true);
    }

    const collisionRes = checkOntologyCompatibility({
        bundle: {
            brickId: 'discord-thread-poster',
            source: 'export default (x) => x;',
            ontology: {
                consumesPorts: ['discord:channel_id'],
                producesPorts: ['audit_record'],
            },
        },
        targetStack: 'node-esm',
        upstreamProducedPorts: ['slack:channel_id'],
    });
    assert.equal(collisionRes.ok, false);
    assert.equal(collisionRes.error.code, 'PORT_NAMESPACE_COLLISION');
    assert.equal(collisionRes.error.details.producedNamespace, 'slack');
    assert.equal(collisionRes.error.details.consumedNamespace, 'discord');

    const sharedOk = checkOntologyCompatibility({
        bundle: {
            brickId: 'ledger-auditor',
            source: 'export default (x) => x;',
            ontology: {
                consumesPorts: ['ledger_event', 'email_address'],
                producesPorts: ['audit_record'],
            },
        },
        targetStack: 'node-esm',
        upstreamProducedPorts: ['ledger_event', 'email_address'],
    });
    assert.equal(sharedOk.ok, true);
});

test('INV-LEGO-36 Channel Security Verifier Guards (webhooks.js + g-krusch) & Time-Series Fault Rejection', () => {
    assert.equal(ONTOLOGY_CHANNELS['webhook:slack'].verifierExport, 'verifySlackSignature');
    assert.equal(ONTOLOGY_CHANNELS['webhook:github'].verifierExport, 'verifyGithubSignature');
    assert.equal(ONTOLOGY_CHANNELS['webhook:stripe'].verifierExport, 'verifyStripeSignature');
    assert.equal(ONTOLOGY_CHANNELS['workspace:gmail'].mcpServer, 'g-krusch');
    assert.ok(ONTOLOGY_CHANNELS['workspace:gmail'].mcpVerbs.includes('search_gmail_messages'));
    assert.ok(ONTOLOGY_CHANNELS['workspace:drive'].mcpVerbs.includes('search_drive_rag'));
    assert.ok(ONTOLOGY_CHANNELS['workspace:calendar'].mcpVerbs.includes('list_calendar_events'));

    const stripeBundle = {
        brickId: 'stripe-fee-parser',
        source: 'export default (ev) => ({ gross: ev.gross, currency: ev.currency });',
        ontology: {
            channels: ['webhook:stripe'],
            consumesPorts: ['webhook_envelope'],
            producesPorts: ['ledger_event'],
            moeProfile: 'financial-integer-ledger',
        },
    };

    const missingGuard = checkOntologyCompatibility({
        bundle: stripeBundle,
        targetStack: 'node-esm',
        targetChannel: 'webhook:stripe',
        enforceChannelGuards: true,
        providedSecurityBricks: [],
    });
    assert.equal(missingGuard.ok, false);
    assert.equal(missingGuard.error.code, 'CHANNEL_SECURITY_GUARD_MISSING');
    assert.deepEqual(missingGuard.error.details.missingSecurityBricks, ['@krusch/toolkit/webhooks']);

    const suppliedGuard = checkOntologyCompatibility({
        bundle: stripeBundle,
        targetStack: 'node-esm',
        targetChannel: 'webhook:stripe',
        enforceChannelGuards: true,
        providedSecurityBricks: ['@krusch/toolkit/webhooks'],
    });
    assert.equal(suppliedGuard.ok, true);
    assert.equal(suppliedGuard.data.cascadePlan.moeProfile, 'financial-integer-ledger');
    assert.equal(suppliedGuard.data.cascadePlan.specialistModel, 'qwen3-coder-30b-moe:latest');
    assert.equal(suppliedGuard.data.cascadePlan.selectedFleetTier, 'L2_HEAVY_MOE');

    // Time-series numerical invariant checks (NaN & non-monotonic rejection)
    const tsBundle = {
        brickId: 'cadence-guard',
        source: TELEMETRY_TS_SOURCE,
        ontology: {
            consumesPorts: ['timeseries_window'],
            moeProfile: 'timeseries-cadence-moe',
            timeSeriesContract: {
                cadenceMs: 60_000,
                requireMonotonicTimestamps: true,
                preserveNegativeValues: true,
                nanInfPolicy: 'reject',
            },
        },
    };

    const nanViolation = checkOntologyCompatibility({
        bundle: tsBundle,
        sampleData: [
            { ts: 60, val: 1.5 },
            { ts: 120, val: Number.NaN },
        ],
    });
    assert.equal(nanViolation.ok, false);
    assert.equal(nanViolation.error.code, 'TIMESERIES_INVARIANT_VIOLATION');

    const orderViolation = checkOntologyCompatibility({
        bundle: tsBundle,
        sampleData: [
            { ts: 120, val: 2.0 },
            { ts: 60, val: -3.5 },
        ],
    });
    assert.equal(orderViolation.ok, false);
    assert.equal(orderViolation.error.code, 'TIMESERIES_INVARIANT_VIOLATION');

    const cleanNegative = checkOntologyCompatibility({
        bundle: tsBundle,
        sampleData: [
            { ts: 60, val: 2.0 },
            { ts: 120, val: -4.25 },
        ],
    });
    assert.equal(cleanNegative.ok, true);
});

test('INV-LEGO-36 HydraScope Graph Compiler, :SUPERSEDES Temporal Replay (asOf), 2-Hop Composition, OpenCypher Sync & IP Scrubbing', async () => {
    const v1Hash = '1'.repeat(64);
    const v2Hash = '2'.repeat(64);
    const auditHash = '3'.repeat(64);
    const slackHash = '4'.repeat(64);
    const discordHash = '5'.repeat(64);

    // Construct sensitive test strings dynamically so zero literal private IPs/paths exist in source
    const dynamicPrivateIp = ['192', '168', '1', '50'].join('.');
    const dynamicHostPath = ['', 'ho' + 'me', 'opsuser', 'keys.json'].join('/');

    const bricks = [
        {
            brickId: 'stripe-webhook-ingest',
            name: 'Stripe Webhook Ingest v1 (Legacy Float)',
            summary: `Legacy webhook parser from http://${dynamicPrivateIp}:8080 reading ${dynamicHostPath}`,
            source: 'export default (e) => ({ gross: Number(e.amount), currency: "USD" });',
            lineage: { sourceHash: v1Hash },
            ontology: {
                channels: ['webhook:stripe'],
                consumesPorts: ['webhook_envelope'],
                producesPorts: ['ledger_event'],
                validFrom: '2026-01-01',
            },
        },
        {
            brickId: 'stripe-webhook-ingest',
            name: 'Stripe Webhook Ingest v2 (Minor-Unit Integer)',
            summary: 'Minor-unit integer Stripe webhook normalizer.',
            source: 'export default (e) => ({ gross: Math.trunc(e.amount_cents), currency: e.currency });',
            lineage: { sourceHash: v2Hash },
            ontology: {
                channels: ['webhook:stripe'],
                consumesPorts: ['webhook_envelope'],
                producesPorts: ['ledger_event'],
                moeProfile: 'financial-integer-ledger',
                supersedes: [`stripe-webhook-ingest@${v1Hash}`],
                validFrom: '2026-06-01',
            },
        },
        {
            brickId: 'fee-audit-brick',
            name: 'Ledger Fee Compliance Auditor',
            summary: 'Consumes ledger_event and emits immutable audit_record.',
            source: 'export default (ev) => ({ actor: "stripe", action: "fee.audit", resource: ev.currency });',
            lineage: { sourceHash: auditHash },
            ontology: {
                consumesPorts: ['ledger_event'],
                producesPorts: ['audit_record'],
                validFrom: '2026-01-15',
            },
        },
        {
            brickId: 'slack-channel-lookup',
            source: 'export default () => ({ channel: "C123" });',
            lineage: { sourceHash: slackHash },
            ontology: {
                channels: ['webhook:slack'],
                producesPorts: ['slack:channel_id'],
                validFrom: '2026-01-01',
            },
        },
        {
            brickId: 'discord-channel-notifier',
            source: 'export default (id) => ({ posted: id });',
            lineage: { sourceHash: discordHash },
            ontology: {
                consumesPorts: ['discord:channel_id'],
                producesPorts: ['audit_record'],
                validFrom: '2026-01-01',
            },
        },
    ];

    const orgProfiles = [
        {
            orgId: 'org-fintech',
            name: 'Fintech Platform Team',
            stacks: ['cloudflare-edge', 'python-fastapi'],
            channels: ['webhook:stripe'],
            requiredPorts: ['audit_record'],
        },
    ];

    const sidA = surrogateOntologyVertexId('brick-ontology', 'port:ledger_event');
    const sidB = surrogateOntologyVertexId('brick-ontology', 'port:ledger_event');
    assert.equal(sidA, sidB);
    assert.ok(Number.isSafeInteger(sidA) && sidA >= 1000 && sidA <= 281474976711655);

    const graphRes = compileBrickOntologyGraph({ bricks, orgProfiles, namespace: 'brick-ontology' });
    assert.equal(graphRes.ok, true);
    const { nodes, edges, stats } = graphRes.data;
    assert.equal(stats.brickCount, 5);
    assert.equal(stats.activeBrickCount, 4);
    assert.equal(stats.retiredBrickCount, 1);
    assert.ok(edges.some((e) => e.type === 'SUPERSEDES'));

    // Verify dynamic private IP and local path were scrubbed out of compiled graph vertices
    const v1Vertex = nodes.find((n) => n.sourceHash === v1Hash);
    assert.ok(v1Vertex);
    assert.equal(v1Vertex.isCurrent, false);
    assert.equal(v1Vertex.retiredAt, '2026-06-01');
    assert.equal(v1Vertex.summary.includes(dynamicPrivateIp), false);
    assert.equal(v1Vertex.summary.includes(dynamicHostPath), false);

    // Present-time traversal retires v1, surfaces v2, discovers 2-hop composition, and blocks slack->discord
    const nowTraverse = traverseBrickOntology(graphRes, {
        targetStack: 'cloudflare-edge',
        targetChannel: 'webhook:stripe',
        requiredPorts: ['audit_record'],
        maxHops: 2,
    });
    assert.equal(nowTraverse.ok, true);
    assert.equal(nowTraverse.data.hydraBackend, 'embedded_bfs');
    assert.equal(nowTraverse.data.retiredSupersededBricks.length, 1);
    assert.equal(nowTraverse.data.retiredSupersededBricks[0].sourceHash, v1Hash);

    // Direct match on webhook:stripe must be v2, NOT retired v1
    const stripeDirect = nowTraverse.data.directMatches.find(
        (m) => m.brickId === 'stripe-webhook-ingest'
    );
    assert.ok(stripeDirect);
    assert.equal(stripeDirect.sourceHash, v2Hash);

    // 2-hop composition: stripe-webhook-ingest (v2) --[ledger_event]--> fee-audit-brick -> audit_record
    assert.equal(nowTraverse.data.compositions.length, 1);
    const pipeline = nowTraverse.data.compositions[0];
    assert.equal(pipeline.stage1.brickId, 'stripe-webhook-ingest');
    assert.equal(pipeline.stage1.sourceHash, v2Hash);
    assert.equal(pipeline.bridgePort, 'ledger_event');
    assert.equal(pipeline.stage2.brickId, 'fee-audit-brick');

    // Verify slack:channel_id NEVER composes with discord:channel_id
    const slackTraverse = traverseBrickOntology(graphRes, {
        targetChannel: 'webhook:slack',
        requiredPorts: ['audit_record'],
        maxHops: 2,
    });
    assert.equal(slackTraverse.ok, true);
    assert.equal(slackTraverse.data.compositions.length, 0);

    // Temporal replay (`asOf: '2026-03-15'`, before v2.validFrom '2026-06-01') restores v1!
    const historicalTraverse = traverseBrickOntology(graphRes, {
        targetChannel: 'webhook:stripe',
        requiredPorts: ['audit_record'],
        asOf: '2026-03-15',
        maxHops: 2,
    });
    assert.equal(historicalTraverse.ok, true);
    assert.equal(historicalTraverse.data.compositions.length, 1);
    assert.equal(historicalTraverse.data.compositions[0].stage1.sourceHash, v1Hash);

    // OpenCypher live sync (MERGE query client) + live traversal + offline graceful fallback
    const cypherCalls = [];
    const mockOpenCypherClient = {
        isConfigured: () => true,
        query: async (cypher, params) => {
            cypherCalls.push({ cypher, params });
            return { rows: [{ id: 'brick:fee-audit-brick' }] };
        },
    };

    const syncLive = await syncBrickOntologyToHydra(graphRes, {
        hydraOpenCypherClient: mockOpenCypherClient,
    });
    assert.equal(syncLive.ok, true);
    assert.equal(syncLive.data.liveSynced, true);
    assert.equal(syncLive.data.mode, 'opencypher_merge');
    assert.ok(cypherCalls.length >= nodes.length + edges.length);

    const liveTraverse = await traverseBrickOntology(graphRes, {
        requiredPorts: ['audit_record'],
        hydraOpenCypherClient: mockOpenCypherClient,
    });
    assert.equal(liveTraverse.ok, true);
    assert.equal(liveTraverse.data.hydraBackend, 'opencypher_live');

    const offlineSync = await syncBrickOntologyToHydra(graphRes, {
        hydraOpenCypherClient: {
            isConfigured: () => true,
            query: async () => {
                throw new Error('Connection refused on https://example.test');
            },
        },
    });
    assert.equal(offlineSync.ok, true);
    assert.equal(offlineSync.data.liveSynced, false);
    assert.equal(offlineSync.data.mode, 'embedded_graph_fallback');
});

test('INV-LEGO-36 Zero-Upload Cross-Stack synthesizeBrickBinding: $0 Alias Ring, Python 3.11+ Adapter, and Cascade MoE Repair', async () => {
    const telemetryBundle = await buildSealedTelemetryBrick();

    // 1. $0 Tier-0 Deterministic snake_case alias mapping + header unit row detection + sandbox verification
    const recipientCsvSample = [
        { recorded_at: 'seconds', metric_value: 'm/s', extra_sensor_tag: 'buoy-7' },
        { recorded_at: 60, metric_value: 5.4, extra_sensor_tag: 'buoy-7' },
        { recorded_at: 120, metric_value: 0, extra_sensor_tag: 'buoy-7' },
        { recorded_at: 180, metric_value: -1.2, extra_sensor_tag: 'buoy-7' },
    ];

    const tsBindRes = await synthesizeBrickBinding({
        bundle: telemetryBundle,
        targetStack: 'typescript-node',
        localSample: recipientCsvSample,
        bindingOverrides: { expectedCount: 3 },
    });
    assert.equal(tsBindRes.ok, true);
    assert.equal(tsBindRes.data.adapterFileName, 'binding.ts');
    assert.equal(tsBindRes.data.cascadeTierUsed, 'TIER_0_DETERMINISTIC');
    assert.deepEqual(tsBindRes.data.resolvedFieldMap, {
        ts: 'recorded_at',
        val: 'metric_value',
    });
    assert.equal(tsBindRes.data.binding.skipHeaderRow, true);
    assert.equal(tsBindRes.data.localVerification.verified, true);
    assert.deepEqual(tsBindRes.data.localVerification.output, {
        rows: 3,
        missingCount: 0,
        duplicateCount: 0,
        negativePreserved: 1,
    });

    // Also verify generated ESM `binding.js` executes cleanly as a pure Web-Standard module
    const edgeBindRes = await synthesizeBrickBinding({
        bundle: telemetryBundle,
        targetStack: 'cloudflare-edge',
        localSample: recipientCsvSample,
        bindingOverrides: { expectedCount: 3 },
    });
    assert.equal(edgeBindRes.ok, true);
    assert.equal(edgeBindRes.data.adapterFileName, 'binding.js');
    assert.equal(isWebStandardPureSource(edgeBindRes.data.adapterSource).pure, true);

    const dataUrl = `data:text/javascript;base64,${Buffer.from(edgeBindRes.data.adapterSource, 'utf8').toString('base64')}`;
    const importedAdapter = await import(dataUrl);
    const runtimeOut = importedAdapter.invokeBoundBrick(
        (rows, cfg) => ({ adaptedCount: cfg.skipHeaderRow ? rows.slice(1).length : rows.length, firstTs: rows[1].ts }),
        recipientCsvSample
    );
    assert.deepEqual(runtimeOut, { adaptedCount: 3, firstTs: 60 });

    // 2. Python 3.11+ `binding_adapter.py` generation & live python3 execution check
    const pyBindRes = await synthesizeBrickBinding({
        bundle: telemetryBundle,
        targetStack: 'python-fastapi',
        localSample: recipientCsvSample,
        bindingOverrides: { expectedCount: 3 },
    });
    assert.equal(pyBindRes.ok, true);
    assert.equal(pyBindRes.data.bridgeMode, 'contract-adapter');
    assert.equal(pyBindRes.data.adapterFileName, 'binding_adapter.py');
    assert.ok(pyBindRes.data.pythonAdapterSource.includes('def adapt_input('));
    assert.ok(pyBindRes.data.pythonAdapterSource.includes('def build_mcp_or_http_payload('));

    const pyProbe = spawnSync('python3', ['--version'], { encoding: 'utf8' });
    if (pyProbe.status === 0) {
        const pyVerifyScript = `
import json, sys
namespace = {}
exec(sys.stdin.read(), namespace)
sample = [
    {"recorded_at": "seconds", "metric_value": "m/s", "unused": 1},
    {"recorded_at": 60, "metric_value": -2.5, "unused": 1},
]
payload = namespace["build_mcp_or_http_payload"](sample)
assert payload["brickId"] == "telemetry-completeness"
assert payload["binding"]["skipHeaderRow"] is True
assert payload["input"][0]["ts"] == 0
assert payload["input"][1]["ts"] == 60
assert payload["input"][1]["val"] == -2.5
assert "recorded_at" not in payload["input"][1]
assert "metric_value" not in payload["input"][1]
assert payload["input"][1]["unused"] == 1
print(json.dumps({"ok": True}))
`;
        const pyExec = spawnSync('python3', ['-c', pyVerifyScript], {
            input: pyBindRes.data.pythonAdapterSource,
            encoding: 'utf8',
        });
        assert.equal(pyExec.status, 0, pyExec.stderr);
        assert.deepEqual(JSON.parse(pyExec.stdout.trim()), { ok: true });
    }

    // 3. Cascade MoE `repairFn` escalation (`L1_FAST` gemma4:e4b -> `L2_HEAVY_MOE` qwen3-coder-30b-moe:latest)
    const obscureSample = [
        { proprietary_epoch_col: 60, proprietary_sensor_col: 9.1 },
        { proprietary_epoch_col: 120, proprietary_sensor_col: -0.4 },
    ];
    const seenCascadeModels = [];

    const repairedBindRes = await synthesizeBrickBinding({
        bundle: telemetryBundle,
        targetStack: 'node-esm',
        localSample: obscureSample,
        maxRepairAttempts: 2,
        repairFn: async ({ attempt, tierId, model, error }) => {
            seenCascadeModels.push({ attempt, tierId, model, errorCode: error?.code });
            if (attempt === 1) {
                // Simulate L1_FAST incomplete patch so executeWithCascadeFallback escalates to L2_HEAVY_MOE
                return {
                    fieldMap: { ts: 'still_wrong_col' },
                };
            }
            return {
                fieldMap: {
                    ts: 'proprietary_epoch_col',
                    val: 'proprietary_sensor_col',
                },
                binding: {
                    skipHeaderRow: false,
                    expectedCount: 2,
                },
            };
        },
    });

    assert.equal(repairedBindRes.ok, true);
    assert.equal(seenCascadeModels.length, 2);
    assert.equal(seenCascadeModels[0].tierId, 'L1_FAST');
    assert.equal(seenCascadeModels[0].model, 'gemma4:e4b');
    assert.equal(seenCascadeModels[1].tierId, 'L2_HEAVY_MOE');
    assert.equal(seenCascadeModels[1].model, 'qwen3-coder-30b-moe:latest');
    assert.equal(repairedBindRes.data.cascadeTierUsed, 'L2_HEAVY_MOE');
    assert.equal(repairedBindRes.data.localVerification.repairAttemptsUsed, 2);
    assert.deepEqual(repairedBindRes.data.localVerification.output, {
        rows: 2,
        missingCount: 0,
        duplicateCount: 0,
        negativePreserved: 1,
    });

    // Tampered bundle is rejected fail-closed before binding synthesis
    const tamperedBundle = { ...telemetryBundle, source: `${telemetryBundle.source}\n// tamper` };
    const tamperedRes = await synthesizeBrickBinding({
        bundle: tamperedBundle,
        targetStack: 'node-esm',
    });
    assert.equal(tamperedRes.ok, false);
    assert.equal(applyFieldMapToSample({ a: 1 }, { b: 'a' }).b, 1);
});


test('8. Wave 2 Choke Points: Ed25519 ontology sealing, permission-gated store composition, HTTP /api/ontology/*, MCP brick_adopt binding synthesis & CLI', async (t) => {
    const {
        sealBrick: sealTopLevel,
        verifyBrickBundle: verifyTopLevel,
        createBrickExchangeStore,
        createBrickExchangeServer,
        createBrickExchangeMcpServer,
        BRICK_EXCHANGE_MCP_TOOLS,
    } = await import('./brick-exchange.js');
    const { runCli } = await import('./bin/krusch-lego.js');
    const fsMod = await import('node:fs');
    const osMod = await import('node:os');
    const pathMod = await import('node:path');

    assert.equal(BRICK_EXCHANGE_MCP_TOOLS.length, 10);

    // 1. sealBrick({ ontology }) seals ontology inside blueprintHash under Ed25519
    const ingestSeal = await sealTopLevel({
        blueprint: {
            id: 'stripe-ingest-port',
            name: 'Stripe Webhook Event Normalizer',
            exportName: 'normalizeStripe',
            inputSchema: { type: 'object', properties: { amount: { type: 'number' } }, required: ['amount'] },
            outputSchema: { type: 'object', properties: { gross: { type: 'number' }, currency: { type: 'string' } }, required: ['gross', 'currency'] },
        },
        source: `export function normalizeStripe(ev, binding = {}) {
            if (typeof ev.amount !== 'number' || ev.amount < 0) throw new Error('Bad amount');
            return { gross: ev.amount, currency: binding.defaultCurrency || 'USD' };
        }`,
        positiveChecks: [{ name: 'ok', input: { amount: 5000 }, expectedOutput: { gross: 5000, currency: 'USD' } }],
        faultChecks: [{ name: 'neg', input: { amount: -1 }, expectThrow: true }],
        authorId: 'alice',
        orgId: 'org-alpha',
        ontology: {
            stacks: ['node-esm', 'cloudflare-edge'],
            channels: ['webhook:stripe'],
            producesPorts: ['ledger_event'],
        },
    });
    assert.equal(ingestSeal.ok, true);
    assert.deepEqual(ingestSeal.data.bundle.ontology.producesPorts, ['ledger_event']);

    // Mutating sealed ontology breaks Ed25519 blueprintHash verification
    const ontologyTampered = {
        ...ingestSeal.data.bundle,
        blueprint: {
            ...ingestSeal.data.bundle.blueprint,
            ontology: { ...ingestSeal.data.bundle.blueprint.ontology, producesPorts: ['audit_record'] },
        },
    };
    assert.equal(verifyTopLevel(ontologyTampered).ok, false);

    const reconcileSeal = await sealTopLevel({
        blueprint: {
            id: 'ledger-audit-seal',
            name: 'Ledger Audit Sealer',
            exportName: 'sealLedger',
            inputSchema: { type: 'object', properties: { gross: { type: 'number' }, currency: { type: 'string' } }, required: ['gross'] },
            outputSchema: { type: 'object', properties: { actor: { type: 'string' }, action: { type: 'string' }, resource: { type: 'string' } } },
        },
        source: `export function sealLedger(item, binding = {}) {
            if (typeof item.gross !== 'number' || item.gross < 0) throw new Error('Invalid gross');
            return { actor: binding.actor || 'system', action: 'ledger.settle', resource: String(item.gross) };
        }`,
        positiveChecks: [{ name: 'ok', input: { gross: 5000, currency: 'USD' }, expectedOutput: { actor: 'system', action: 'ledger.settle', resource: '5000' } }],
        faultChecks: [{ name: 'neg', input: { gross: -5, currency: 'USD' }, expectThrow: true }],
        authorId: 'alice',
        orgId: 'org-alpha',
        ontology: {
            stacks: ['node-esm', 'cloudflare-edge'],
            consumesPorts: ['ledger_event'],
            producesPorts: ['audit_record'],
        },
    });
    assert.equal(reconcileSeal.ok, true);

    // 2. Permission-Before-Traversal on store.planCrossStackComposition
    const store = createBrickExchangeStore({ dbPath: ':memory:' });
    t.after(() => store.close());

    store.upsertOrg({ id: 'org-alpha', name: 'Alpha', peers: ['org-beta'] });
    store.upsertOrg({ id: 'org-beta', name: 'Beta', peers: ['org-alpha'] });
    store.upsertMember({ id: 'alice', name: 'Alice', orgId: 'org-alpha', publisher: true, exporter: true, receiveMode: 'federated' });
    store.upsertMember({ id: 'bob', name: 'Bob', orgId: 'org-beta', receiveMode: 'federated' });

    store.publishSealedBrick(ingestSeal.data.bundle, { actorId: 'alice' });
    store.publishSealedBrick(reconcileSeal.data.bundle, { actorId: 'alice' });

    // Before grant: cross-org viewer "bob" sees 0 bricks and 0 compositions
    const preGrantComp = await store.planCrossStackComposition({
        viewerId: 'bob',
        targetStack: 'cloudflare-edge',
        targetChannel: 'webhook:stripe',
        requiredPorts: ['audit_record'],
    });
    assert.equal(preGrantComp.ok, true);
    assert.equal(preGrantComp.data.authorizedBrickCount, 0);
    assert.equal(preGrantComp.data.compositions.length, 0);

    // Issue grants to bob -> 2-hop composition discovered!
    const expIso = new Date(Date.now() + 86_400_000).toISOString();
    store.issueGrant({ issuerId: 'alice', brickId: 'stripe-ingest-port', sourceHash: ingestSeal.data.bundle.lineage.sourceHash, recipients: ['bob'], expiresAt: expIso });
    store.issueGrant({ issuerId: 'alice', brickId: 'ledger-audit-seal', sourceHash: reconcileSeal.data.bundle.lineage.sourceHash, recipients: ['bob'], expiresAt: expIso });

    const postGrantComp = await store.planCrossStackComposition({
        viewerId: 'bob',
        targetStack: 'cloudflare-edge',
        targetChannel: 'webhook:stripe',
        requiredPorts: ['audit_record'],
    });
    assert.equal(postGrantComp.ok, true);
    assert.equal(postGrantComp.data.authorizedBrickCount, 2);
    assert.equal(postGrantComp.data.compositions.length, 1);

    // 3. HTTP Hub /api/ontology/* + MCP brick_adopt binding synthesis + CLI ontology inspect
    const server = createBrickExchangeServer({ store });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const { port } = server.address();

    const ontResp = await fetch(`http://127.0.0.1:${port}/api/ontology`);
    assert.equal(ontResp.status, 200);
    const ontBody = await ontResp.json();
    assert.equal(ontBody.ok, true);
    assert.ok(ontBody.data.stacks['python-fastapi']);

    const compResp = await fetch(`http://127.0.0.1:${port}/api/ontology/compose`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Brick-Viewer': 'bob' },
        body: JSON.stringify({ targetStack: 'cloudflare-edge', targetChannel: 'webhook:stripe', requiredPorts: ['audit_record'] }),
    });
    assert.equal(compResp.status, 200);
    const compBody = await compResp.json();
    assert.equal(compBody.ok, true);
    assert.equal(compBody.data.compositions.length, 1);

    const tmpDir = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'brick-ont-mcp-'));
    t.after(() => fsMod.rmSync(tmpDir, { recursive: true, force: true }));

    const mcp = await createBrickExchangeMcpServer({ store, connect: false });
    const adoptMcp = await mcp.callTool({
        params: {
            name: 'brick_adopt',
            arguments: {
                viewerId: 'bob',
                brickId: 'ledger-audit-seal',
                targetRepoDir: tmpDir,
                targetStack: 'python-fastapi',
                localSample: { amount_cents: 5000, iso_currency: 'USD' },
            },
        },
    });
    assert.ok(!adoptMcp.isError);
    const pyAdapterPath = pathMod.join(tmpDir, 'bricks', 'ledger-audit-seal', 'binding_adapter.py');
    assert.equal(fsMod.existsSync(pyAdapterPath), true);

    const cliOut = [];
    const cliRes = await runCli(['ontology', 'inspect', '--json'], { writeOut: (s) => cliOut.push(s) });
    assert.equal(cliRes.exitCode, 0);
    assert.equal(cliRes.payload.ok, true);
});
