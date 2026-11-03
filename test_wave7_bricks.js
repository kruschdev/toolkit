import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('INV-LEGO-31..34: catalog registers 39 runtime bricks, CLI inspects all 4 Wave 7 bricks, and scoreLegoBrickCoverage detects sealed imports', async () => {
    const { RUNTIME_BRICKS, getLegoBrick, scoreLegoBrickCoverage } = await import('./catalog.js');
    const rootBarrel = await import('./index.js');

    assert.equal(RUNTIME_BRICKS.length, 39);

    for (const [id, importPath, expectedExports] of [
        ['idempotency', '@krusch/toolkit/idempotency', [
            'DEFAULT_IDEMPOTENCY_OPTIONS',
            'normalizeIdempotencyKey',
            'computePayloadFingerprint',
            'createIdempotencyStore',
            'withIdempotency',
            'createIdempotencyMiddleware'
        ]],
        ['audit-log', '@krusch/toolkit/audit-log', [
            'GENESIS_AUDIT_HASH',
            'canonicalizeAuditPayload',
            'computeAuditEntryHash',
            'verifyAuditChain',
            'createAuditLog'
        ]],
        ['rbac', '@krusch/toolkit/rbac', [
            'matchPermissionPattern',
            'createRbacPolicy',
            'assertTenantOwnership',
            'evaluateAccess',
            'createRbacGuard'
        ]],
        ['pagination', '@krusch/toolkit/pagination', [
            'DEFAULT_PAGINATION_LIMITS',
            'clampPageLimit',
            'encodeCursor',
            'decodeCursor',
            'buildKeysetPage',
            'paginateItems'
        ]]
    ]) {
        const brick = getLegoBrick(id);
        assert.ok(brick, `Expected brick ${id} in catalog`);
        assert.equal(brick.importPath, importPath);
        assert.deepEqual(brick.exports, expectedExports);
        for (const sym of expectedExports) {
            assert.ok(Object.hasOwn(rootBarrel, sym), `Root barrel missing export ${sym}`);
        }

        const cliOut = execFileSync(
            process.execPath,
            [path.join(__dirname, 'bin/krusch-lego.js'), 'inspect', id, '--json'],
            { encoding: 'utf8' }
        );
        const parsed = JSON.parse(cliOut);
        assert.equal(parsed.ok, true);
        assert.equal(parsed.data.brick.id, id);
    }

    const cov = scoreLegoBrickCoverage({
        'src/routes/charges.js': `
            import { createIdempotencyMiddleware } from '@krusch/toolkit/idempotency';
            import { createAuditLog } from '@krusch/toolkit/audit-log';
            import { createRbacGuard } from '@krusch/toolkit/rbac';
            import { buildKeysetPage } from '@krusch/toolkit/pagination';
        `
    });
    assert.equal(cov.ok, true);
    assert.deepEqual(cov.data.sealedBrickIds, ['audit-log', 'idempotency', 'pagination', 'rbac']);
    assert.equal(cov.data.sealedCoverageRatio, 1);
    assert.equal(cov.data.breakerTripped, false);
});

test('INV-LEGO-31: @krusch/toolkit/idempotency enforces 409 in-flight locks, 422 payload mismatches, fencing tokens, deep-clone replays, and HTTP middleware scoping', async () => {
    const {
        DEFAULT_IDEMPOTENCY_OPTIONS,
        normalizeIdempotencyKey,
        computePayloadFingerprint,
        createIdempotencyStore,
        withIdempotency,
        createIdempotencyMiddleware
    } = await import('./idempotency.js');

    assert.equal(DEFAULT_IDEMPOTENCY_OPTIONS.maxKeyLength, 255);

    // 1. Key validation
    assert.equal(normalizeIdempotencyKey('  idem_001  ').data.key, 'idem_001');
    assert.equal(normalizeIdempotencyKey('').error.code, 'IDEMPOTENCY_KEY_MISSING');
    assert.equal(normalizeIdempotencyKey('bad\r\nkey').error.code, 'IDEMPOTENCY_KEY_INVALID');
    assert.equal(normalizeIdempotencyKey('k'.repeat(256)).error.code, 'IDEMPOTENCY_KEY_TOO_LONG');

    // 2. Canonical payload fingerprinting
    const fp1 = computePayloadFingerprint({ b: 2, a: 1, skip: undefined }, { method: 'post', path: '/charges' });
    const fp2 = computePayloadFingerprint({ a: 1, b: 2 }, { method: 'POST', path: '/charges' });
    assert.equal(fp1.ok, true);
    assert.equal(fp1.data.fingerprint, fp2.data.fingerprint);

    const cyc = { a: 1 };
    cyc.self = cyc;
    assert.equal(computePayloadFingerprint(cyc).error.code, 'IDEMPOTENCY_CIRCULAR_PAYLOAD');
    assert.equal(computePayloadFingerprint({ bad: 10n }).error.code, 'IDEMPOTENCY_INVALID_PAYLOAD');
    assert.equal(computePayloadFingerprint({ bad: NaN }).error.code, 'IDEMPOTENCY_INVALID_PAYLOAD');

    // 3. Store fencing, active-lock preservation, and deep-cloned replay
    let now = 1_000_000;
    const store = createIdempotencyStore({
        ttlMs: 60_000,
        maxEntries: 2,
        inFlightTimeoutMs: 5_000,
        nowFn: () => now
    });

    const acqA = store.begin('k1', fp1.data.fingerprint);
    assert.equal(acqA.ok, true);
    assert.equal(acqA.data.outcome, 'ACQUIRED');

    // Concurrent same key + same payload -> 409
    const dupInFlight = store.begin('k1', fp1.data.fingerprint);
    assert.equal(dupInFlight.ok, false);
    assert.equal(dupInFlight.error.code, 'IDEMPOTENCY_IN_FLIGHT');
    assert.equal(dupInFlight.error.details.statusCode, 409);

    // Concurrent same key + different payload -> 422
    const otherFp = computePayloadFingerprint({ a: 999 }, { method: 'POST', path: '/charges' }).data.fingerprint;
    const mismatchInFlight = store.begin('k1', otherFp);
    assert.equal(mismatchInFlight.ok, false);
    assert.equal(mismatchInFlight.error.code, 'IDEMPOTENCY_PAYLOAD_MISMATCH');
    assert.equal(mismatchInFlight.error.details.statusCode, 422);

    // Active IN_FLIGHT locks are never evicted -> 503 IDEMPOTENCY_STORE_FULL
    const acqB = store.begin('k2', fp1.data.fingerprint);
    assert.equal(acqB.ok, true);
    const fullRes = store.begin('k3', fp1.data.fingerprint);
    assert.equal(fullRes.ok, false);
    assert.equal(fullRes.error.code, 'IDEMPOTENCY_STORE_FULL');

    // Stale lock timeout + fencing token prevents zombie overwrite
    now += 6_000;
    const reclaimed = store.begin('k1', fp1.data.fingerprint);
    assert.equal(reclaimed.ok, true);
    assert.equal(reclaimed.data.outcome, 'ACQUIRED');
    const zombieCommit = store.commit('k1', acqA.data.lockToken, { statusCode: 200, body: { zombie: true } });
    assert.equal(zombieCommit.ok, false);
    assert.equal(zombieCommit.error.code, 'IDEMPOTENCY_LOCK_LOST');

    assert.equal(
        store.commit('k1', reclaimed.data.lockToken, { statusCode: 201, body: { items: ['a'] } }).ok,
        true
    );
    const replay1 = store.begin('k1', fp1.data.fingerprint);
    assert.equal(replay1.ok, true);
    assert.equal(replay1.data.outcome, 'REPLAY');
    replay1.data.body.items.push('mutated');
    const replay2 = store.begin('k1', fp1.data.fingerprint);
    assert.deepEqual(replay2.data.body, { items: ['a'] });

    // 4. withIdempotency releases lock on transient error so retry succeeds
    const execStore = createIdempotencyStore();
    let attempts = 0;
    const failFirst = await withIdempotency(execStore, { key: 'op-1', payload: { cents: 500 } }, async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('upstream_timeout');
        return { ok: true, chargeId: 'ch_77' };
    });
    assert.equal(failFirst.ok, false);
    assert.equal(failFirst.error.code, 'IDEMPOTENCY_HANDLER_ERROR');

    const retryOk = await withIdempotency(execStore, { key: 'op-1', payload: { cents: 500 } }, async () => {
        attempts += 1;
        return { chargeId: 'ch_77' };
    });
    assert.equal(retryOk.ok, true);
    assert.equal(retryOk.data.replayed, false);
    assert.equal(attempts, 2);

    const cachedHit = await withIdempotency(execStore, { key: 'op-1', payload: { cents: 500 } }, async () => {
        attempts += 1;
        return { chargeId: 'NEVER_CALLED' };
    });
    assert.equal(cachedHit.ok, true);
    assert.equal(cachedHit.data.replayed, true);
    assert.equal(attempts, 2);
    assert.deepEqual(cachedHit.data.result, { chargeId: 'ch_77' });

    // 5. HTTP middleware tenant scoping + 5xx non-caching
    const mwStore = createIdempotencyStore();
    const mw = createIdempotencyMiddleware(mwStore, { requireHeader: true });
    let chargeSeq = 0;
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            req.body = raw ? JSON.parse(raw) : {};
            req.user = { tenantId: req.headers['x-tenant-id'] || 't1' };
            mw(req, res, () => {
                if (req.body.force500) {
                    res.writeHead(503, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: 'temporary' }));
                    return;
                }
                chargeSeq += 1;
                res.writeHead(201, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, seq: chargeSeq, tenant: req.user.tenantId }));
            });
        });
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
        const { port } = server.address();
        const base = `http://127.0.0.1:${port}/api/pay`;

        const r500 = await fetch(base, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'ik-500', 'X-Tenant-Id': 'org_a' },
            body: JSON.stringify({ force500: true })
        });
        assert.equal(r500.status, 503);

        // Same key after 503 must NOT replay 503 (payload changed check only applies if locked/cached, and lock was released!)
        const r201 = await fetch(base, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'ik-500', 'X-Tenant-Id': 'org_a' },
            body: JSON.stringify({ amount: 100 })
        });
        assert.equal(r201.status, 201);
        assert.equal(r201.headers.get('idempotency-replayed'), 'false');
        const b1 = await r201.json();
        assert.equal(b1.seq, 1);

        // Replay for org_a
        const rReplay = await fetch(base, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'ik-500', 'X-Tenant-Id': 'org_a' },
            body: JSON.stringify({ amount: 100 })
        });
        assert.equal(rReplay.status, 201);
        assert.equal(rReplay.headers.get('idempotency-replayed'), 'true');
        assert.deepEqual(await rReplay.json(), b1);

        // Different tenant org_b with identical Idempotency-Key gets isolated execution!
        const rTenantB = await fetch(base, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'ik-500', 'X-Tenant-Id': 'org_b' },
            body: JSON.stringify({ amount: 999 })
        });
        assert.equal(rTenantB.status, 201);
        const b2 = await rTenantB.json();
        assert.equal(b2.seq, 2);
        assert.equal(b2.tenant, 'org_b');
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test('INV-LEGO-32: @krusch/toolkit/audit-log enforces SHA-256/HMAC hash chains, detects tampering/gaps/truncation, and blocks SQLite UPDATE/DELETE via triggers', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const {
        GENESIS_AUDIT_HASH,
        canonicalizeAuditPayload,
        computeAuditEntryHash,
        verifyAuditChain,
        createAuditLog
    } = await import('./audit-log.js');

    assert.equal(GENESIS_AUDIT_HASH.length, 64);
    assert.equal(
        canonicalizeAuditPayload({ z: 1, a: -0, u: undefined, arr: [undefined, 'ok'] }).data.canonicalJson,
        '{"a":0,"arr":[null,"ok"],"z":1}'
    );

    // 1. In-memory capacity fail-closed + tamper/gap/truncation detection
    const memAudit = createAuditLog({ maxEntries: 3, hmacSecret: 'audit-hmac-key-01' });
    const e1 = memAudit.append({ tenantId: 't1', actor: 'u1', action: 'invoice.create', resource: 'inv_1', metadata: { cents: 1200 } });
    const e2 = memAudit.append({ tenantId: 't1', actor: 'u1', action: 'invoice.approve', resource: 'inv_1' });
    const e3 = memAudit.append({ tenantId: 't1', actor: 'u2', action: 'invoice.pay', resource: 'inv_1' });
    assert.equal(e3.ok, true);

    const capErr = memAudit.append({ tenantId: 't1', actor: 'u2', action: 'overflow' });
    assert.equal(capErr.ok, false);
    assert.equal(capErr.error.code, 'AUDIT_LOG_CAPACITY_EXCEEDED');

    const tailHash = memAudit.tail().tailHash;
    const validRes = memAudit.verify({ expectedTailHash: tailHash });
    assert.equal(validRes.ok, true);
    assert.equal(validRes.data.verifiedCount, 3);

    // Wrong HMAC secret fails verification
    const allEntries = memAudit.query({ limit: 10 }).data.entries;
    assert.equal(verifyAuditChain(allEntries, { hmacSecret: 'wrong-key' }).error.code, 'AUDIT_ENTRY_TAMPERED');

    // Tail truncation (dropping e3) caught by expectedTailHash
    assert.equal(
        verifyAuditChain(allEntries.slice(0, 2), { hmacSecret: 'audit-hmac-key-01', expectedTailHash: tailHash }).error.code,
        'AUDIT_TAIL_MISMATCH'
    );
    // Complete table wipe caught by expectedTailHash
    assert.equal(
        verifyAuditChain([], { hmacSecret: 'audit-hmac-key-01', expectedTailHash: tailHash }).error.code,
        'AUDIT_TAIL_MISMATCH'
    );
    // Sequence deletion gap (dropping e2)
    assert.equal(
        verifyAuditChain([allEntries[0], allEntries[2]], { hmacSecret: 'audit-hmac-key-01' }).error.code,
        'AUDIT_SEQUENCE_GAP'
    );

    // 2. SQLite WAL durability + BEFORE UPDATE / BEFORE DELETE immutability triggers
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lego-audit-w7-'));
    try {
        const dbPath = path.join(tmpDir, 'compliance.db');
        const sqlAudit = createAuditLog({ sqlitePath: dbPath });
        sqlAudit.append({ tenantId: 'org_9', actor: 'admin_1', action: 'role.grant', resource: 'usr_5' });
        sqlAudit.append({ tenantId: 'org_9', actor: 'usr_5', action: 'payout.execute', resource: 'po_88' });
        const savedTail = sqlAudit.tail().tailHash;
        assert.equal(sqlAudit.verify({ expectedTailHash: savedTail }).ok, true);
        sqlAudit.close();

        const rawDb = new DatabaseSync(dbPath);
        try {
            assert.throws(
                () => rawDb.prepare("UPDATE audit_ledger SET outcome = 'FORGED' WHERE seq = 1").run(),
                /AUDIT_LEDGER_IMMUTABLE/
            );
            assert.throws(
                () => rawDb.prepare('DELETE FROM audit_ledger WHERE seq = 2').run(),
                /AUDIT_LEDGER_IMMUTABLE/
            );
        } finally {
            rawDb.close();
        }

        const reopened = createAuditLog({ sqlitePath: dbPath });
        assert.equal(reopened.verify({ expectedTailHash: savedTail }).ok, true);
        const eNext = reopened.append({ tenantId: 'org_9', actor: 'auditor', action: 'ledger.seal' });
        assert.equal(eNext.data.seq, 3);
        assert.equal(reopened.verify().data.verifiedCount, 3);
        reopened.close();
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    assert.equal(typeof computeAuditEntryHash, 'function');
});

test('INV-LEGO-33: @krusch/toolkit/rbac is zero-node:*, enforces explicit-deny over allow, blocks cross-tenant IDOR & prototype pollution, and wires HTTP guard', async () => {
    const rbacSrc = fs.readFileSync(path.join(__dirname, 'rbac.js'), 'utf8');
    assert.equal(/\bnode:[a-z_]+/i.test(rbacSrc), false, 'rbac.js must contain zero node:* imports');

    const {
        matchPermissionPattern,
        createRbacPolicy,
        assertTenantOwnership,
        evaluateAccess,
        createRbacGuard
    } = await import('./rbac.js');

    assert.equal(matchPermissionPattern('billing:*', 'billing:read'), true);
    assert.equal(matchPermissionPattern('billing:*', 'billing:invoices:delete'), false);
    assert.equal(matchPermissionPattern('billing:**', 'billing:invoices:delete'), true);
    assert.equal(matchPermissionPattern('billing:read', 'billing:*'), false);

    assert.throws(
        () => createRbacPolicy({ roles: { a: { inherits: ['b'] }, b: { inherits: ['a'] } } }),
        RangeError
    );

    const policy = createRbacPolicy({
        roles: {
            viewer: { allow: ['billing:read', 'invoices:read'] },
            operator: { inherits: ['viewer'], allow: ['billing:*'], deny: ['billing:purge'] },
            support_observer: { allow: ['tickets:read'], allowCrossTenant: true }
        }
    });

    const userA = { id: 'u_1', tenantId: 'tenant_alpha', roles: ['operator', 'support_observer'], allowCrossTenant: true };
    const invoiceAlpha = { id: 'inv_1', tenantId: 'tenant_alpha', ownerId: 'u_1' };
    const invoiceBeta = { id: 'inv_2', tenantId: 'tenant_beta', ownerId: 'u_9' };

    // Explicit deny beats billing:* wildcard
    const purgeRes = evaluateAccess(policy, userA, 'billing:purge', { resource: invoiceAlpha });
    assert.equal(purgeRes.ok, false);
    assert.equal(purgeRes.error.code, 'RBAC_EXPLICIT_DENY');

    // Cross-tenant ticket read succeeds because support_observer grants tickets:read with allowCrossTenant
    assert.equal(evaluateAccess(policy, userA, 'tickets:read', { resource: invoiceBeta }).ok, true);

    // Cross-tenant billing:refund MUST FAIL even though userA also holds support_observer!
    const crossRefund = evaluateAccess(policy, userA, 'billing:refund', { resource: invoiceBeta });
    assert.equal(crossRefund.ok, false);
    assert.equal(crossRefund.error.code, 'RBAC_CROSS_TENANT_DENIED');

    // Same-tenant billing:refund succeeds
    assert.equal(evaluateAccess(policy, userA, 'billing:refund', { resource: invoiceAlpha }).ok, true);

    // Prototype pollution check on resource lacking own tenantId
    const protoInheritedResource = Object.create({ tenantId: 'tenant_alpha', ownerId: 'u_1' });
    assert.equal(
        assertTenantOwnership(userA, protoInheritedResource).error.code,
        'RBAC_MISSING_RESOURCE_TENANT'
    );

    // Guard middleware + audit callback
    const auditEvents = [];
    const guard = createRbacGuard(policy, 'billing:refund', {
        resolveResource: async (req) => req.targetResource,
        onAudit: (evt) => auditEvents.push(evt)
    });

    const deniedRes = {
        statusCode: 200,
        headers: {},
        payload: '',
        setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
        end(body) { this.payload = body; }
    };
    let nextCalled = false;
    await guard({ user: userA, targetResource: invoiceBeta }, deniedRes, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(deniedRes.statusCode, 403);
    assert.equal(auditEvents.length, 1);
    assert.equal(auditEvents[0].allowed, false);
});

test('INV-LEGO-34: @krusch/toolkit/pagination clamps hostile limits, verifies constant-time HMAC cursors, binds tenant scopes, and traverses keyset pages cleanly', async () => {
    const {
        clampPageLimit,
        encodeCursor,
        decodeCursor,
        buildKeysetPage,
        paginateItems
    } = await import('./pagination.js');

    assert.equal(clampPageLimit(undefined), 25);
    assert.equal(clampPageLimit(Symbol('bad')), 25);
    assert.equal(clampPageLimit(true), 25);
    assert.equal(clampPageLimit('-50'), 1);
    assert.equal(clampPageLimit('999999999'), 100);

    const secret = 'cursor-signing-secret-v1';
    let now = 1_700_000_000_000;
    const enc = encodeCursor(
        { sortValue: '2026-11-03T00:00:00Z', id: 'inv_10', sortField: 'createdAt', idField: 'id' },
        { secret, scope: 'tenant_alpha', ttlMs: 30_000, nowFn: () => now }
    );
    assert.equal(enc.ok, true);
    assert.equal(enc.data.signed, true);

    // Tampered signature rejected
    const [pB64, sB64] = enc.data.cursor.split('.');
    const flippedSig = `${sB64.slice(0, -1)}${sB64.endsWith('A') ? 'B' : 'A'}`;
    assert.equal(decodeCursor(`${pB64}.${flippedSig}`, { secret }).error.code, 'CURSOR_INVALID_SIGNATURE');

    // Unsigned cursor rejected when secret is provided
    const unsigned = encodeCursor({ sortValue: 1, id: '1', sortField: 'id', idField: 'id' }).data.cursor;
    assert.equal(decodeCursor(unsigned, { secret }).error.code, 'CURSOR_SIGNATURE_MISSING');

    // Signed cursor rejected when secret is omitted
    assert.equal(decodeCursor(enc.data.cursor).error.code, 'CURSOR_SECRET_REQUIRED');

    // Scope mismatch (Tenant B replaying Tenant A's cursor) rejected
    assert.equal(
        decodeCursor(enc.data.cursor, { secret, expectedScope: 'tenant_beta', nowFn: () => now }).error.code,
        'CURSOR_SCOPE_MISMATCH'
    );

    // Expired cursor rejected
    assert.equal(
        decodeCursor(enc.data.cursor, { secret, expectedScope: 'tenant_alpha', nowFn: () => now + 31_000 }).error.code,
        'CURSOR_EXPIRED'
    );

    // Full keyset traversal across ties in both asc and desc order
    const dataset = [
        { id: 'inv_03', amountCents: 500 },
        { id: 'inv_01', amountCents: 500 },
        { id: 'inv_02', amountCents: 500 },
        { id: 'inv_05', amountCents: 900 },
        { id: 'inv_04', amountCents: 100 }
    ];

    for (const direction of ['asc', 'desc']) {
        const collected = [];
        let cursor = '';
        let guardCount = 0;
        do {
            guardCount += 1;
            assert.ok(guardCount <= 10);
            const page = paginateItems(dataset, {
                cursor,
                limit: 2,
                sortField: 'amountCents',
                idField: 'id',
                direction,
                secret,
                scope: 'tenant_alpha'
            });
            assert.equal(page.ok, true);
            collected.push(...page.data.items.map((x) => x.id));
            cursor = page.data.pageInfo.nextCursor || '';
        } while (cursor);

        const expectedIds =
            direction === 'asc'
                ? ['inv_04', 'inv_01', 'inv_02', 'inv_03', 'inv_05']
                : ['inv_05', 'inv_03', 'inv_02', 'inv_01', 'inv_04'];
        assert.deepEqual(collected, expectedIds);
    }

    assert.equal(typeof buildKeysetPage, 'function');
});

test('INV-LEGO-11 & INV-LEGO-31..34: Strict TypeScript tsc --noEmit --strict compiles consumer importing all 4 Wave 7 bricks', () => {
    const localTscBin = path.resolve(__dirname, 'node_modules/.bin/tsc');
    const tscBin = fs.existsSync(localTscBin)
        ? localTscBin
        : path.resolve(__dirname, '../projects/krusch-coding-harness/node_modules/.bin/tsc');
    if (!fs.existsSync(tscBin)) return;

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lego-w7-ts-'));
    try {
        fs.mkdirSync(path.join(tmpDir, 'node_modules', '@krusch'), { recursive: true });
        fs.symlinkSync(__dirname, path.join(tmpDir, 'node_modules', '@krusch', 'toolkit'));
        const localTypes = path.join(__dirname, 'node_modules', '@types');
        if (fs.existsSync(localTypes)) {
            fs.symlinkSync(localTypes, path.join(tmpDir, 'node_modules', '@types'));
        }

        fs.writeFileSync(
            path.join(tmpDir, 'tsconfig.json'),
            JSON.stringify({
                compilerOptions: {
                    target: 'ES2022',
                    module: 'NodeNext',
                    moduleResolution: 'NodeNext',
                    strict: true,
                    noEmit: true,
                    skipLibCheck: false
                },
                include: ['consumer.ts']
            }),
            'utf8'
        );

        fs.writeFileSync(
            path.join(tmpDir, 'consumer.ts'),
            `import { createIdempotencyStore, withIdempotency } from '@krusch/toolkit/idempotency';
import { createAuditLog, GENESIS_AUDIT_HASH } from '@krusch/toolkit/audit-log';
import { createRbacPolicy, evaluateAccess } from '@krusch/toolkit/rbac';
import { clampPageLimit, paginateItems } from '@krusch/toolkit/pagination';

const store = createIdempotencyStore({ maxEntries: 128 });
const audit = createAuditLog({ maxEntries: 128 });
const policy = createRbacPolicy({ roles: { admin: { allow: ['*'] } } });
const limit: number = clampPageLimit('50', { maxLimit: 100 });

export async function runCheck() {
    const access = evaluateAccess(policy, { id: 'u1', tenantId: 't1', role: 'admin' }, 'invoices:list');
    if (!access.ok) return access;
    const idem = await withIdempotency(store, { key: 'req_1', payload: { limit } }, async () => {
        audit.append({ tenantId: 't1', actor: 'u1', action: 'invoices.list' });
        return paginateItems([{ id: '1', createdAt: 1 }], { limit, sortField: 'createdAt', idField: 'id' });
    });
    return { head: GENESIS_AUDIT_HASH, idem };
}
`,
            'utf8'
        );

        execFileSync(tscBin, ['--project', path.join(tmpDir, 'tsconfig.json')], {
            cwd: tmpDir,
            stdio: 'pipe'
        });
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});
