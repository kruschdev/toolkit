import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('INV-LEGO-12: @krusch/toolkit/sqlite wraps node:sqlite WAL, escapes adversarial FTS5 queries, nests savepoints, and fuses RRF safely', async () => {
    const {
        DatabaseSync,
        isSqliteCorruptionError,
        openSqliteDb,
        escapeFts5Query,
        fuseRrfResults
    } = await import('./sqlite.js');

    assert.equal(typeof DatabaseSync, 'function');
    assert.equal(isSqliteCorruptionError(Object.assign(new Error('SQLITE_CORRUPT: database disk image is malformed'), { code: 'SQLITE_CORRUPT' })), true);
    assert.equal(isSqliteCorruptionError(Object.assign(new Error('SQLITE_BUSY: database is locked'), { code: 'SQLITE_BUSY' })), false);

    // 1. Pragma SQL injection guard on synchronous option
    assert.throws(
        () => openSqliteDb(':memory:', { synchronous: 'NORMAL; DROP TABLE x;--' }),
        RangeError
    );

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lego-sqlite-w3-'));
    try {
        const dbFile = path.join(tmpDir, 'nested', 'store.db');
        const store = openSqliteDb(dbFile);
        assert.equal(store.isOpen(), true);
        assert.equal(store.healthCheck().ok, true);

        store.exec(`
            CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE NOT NULL, label TEXT NOT NULL);
            CREATE VIRTUAL TABLE docs_fts USING fts5(slug, body);
        `);

        // 2. Nested savepoint rollback preserves outer transaction while rolling back inner failure
        store.transaction(() => {
            store.run('INSERT INTO items (slug, label) VALUES (?, ?)', ['outer-1', 'Outer Item']);
            assert.throws(() => {
                store.transaction(() => {
                    store.run('INSERT INTO items (slug, label) VALUES (?, ?)', ['inner-fail', 'Rolled Back']);
                    throw new Error('inner_abort');
                });
            }, /inner_abort/);
            store.run('INSERT INTO items (slug, label) VALUES (?, ?)', ['outer-2', 'Outer Kept']);
        });

        // Async transaction callback is rejected synchronously and rolled back cleanly
        assert.throws(() => {
            store.transaction(async () => {
                store.run('INSERT INTO items (slug, label) VALUES (?, ?)', ['async-bad', 'Must Rollback']);
            });
        }, TypeError);

        const rows = store.query('SELECT slug, label FROM items ORDER BY id ASC');
        assert.equal(Object.getPrototypeOf(rows[0]), Object.prototype, 'Rows must be normalized to plain objects');
        assert.deepEqual(rows.map((r) => r.slug), ['outer-1', 'outer-2']);

        // 3. Adversarial FTS5 syntax characters never trigger fts5: syntax error
        store.run('INSERT INTO docs_fts (slug, body) VALUES (?, ?)', ['doc-cpp', 'Modern C++ vector search and PostgreSQL FTS5']);
        store.run('INSERT INTO docs_fts (slug, body) VALUES (?, ?)', ['doc-py', 'Python FastAPI async vector search']);

        const hostileQuery = 'C++ AND "unclosed NEAR(foo-bar) OR NOT* col:injection ^vector';
        const escapedAnd = escapeFts5Query(hostileQuery, { operator: 'OR', prefixLastToken: true });
        assert.ok(escapedAnd.length > 0);
        const ftsHits = store.query('SELECT slug FROM docs_fts WHERE docs_fts MATCH ?', [escapedAnd]);
        assert.ok(ftsHits.some((h) => h.slug === 'doc-cpp'));
        assert.equal(escapeFts5Query('   *** --- ::: ""   '), '');

        // 4. Prototype-safe Reciprocal Rank Fusion with duplicate-in-list protection & weights
        const bm25List = [
            { id: '__proto__', title: 'Proto Safe' },
            { id: 'doc-a', title: 'Doc A' },
            { id: 'doc-a', title: 'Doc A duplicate in same list' },
            { id: 'doc-b', title: 'Doc B' }
        ];
        const denseList = [
            { id: 'doc-a', denseSim: 0.92 },
            { id: 'doc-c', denseSim: 0.88 }
        ];
        const fused = fuseRrfResults([bm25List, denseList], { k: 60, idKey: 'id', weights: [1.0, 2.0], limit: 3 });
        assert.equal(fused[0].id, 'doc-a');
        assert.equal(fused[0].title, 'Doc A');
        assert.equal(fused[0].denseSim, 0.92);
        assert.equal(({}).polluted, undefined);

        store.close();
        assert.equal(store.isOpen(), false);
        assert.equal(store.healthCheck().ok, false);
        assert.equal(store.healthCheck().error.code, 'SQLITE_CLOSED');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('INV-LEGO-13: @krusch/toolkit/security blocks IPv4/IPv6/6to4/Teredo/metadata SSRF, strips cross-origin credentials, and bounds rate-limit memory', async () => {
    const {
        isPrivateOrReservedIp,
        validateOutboundUrl,
        safeFetch,
        createRateLimiter
    } = await import('./security.js');

    // 1. Exhaustive IPv4 + IPv6 + tunnel + non-canonical literal checks
    for (const blockedIp of [
        '',
        '127.0.0.1',
        '0.0.0.0',
        '169.254.169.254',
        '10.1.2.3',
        '172.16.5.4',
        '172.16.1.2',
        '100.64.1.2',
        '0177.0.0.1',
        '0x7f.0.0.1',
        '2130706433',
        '::1',
        '::',
        '::ffff:127.0.0.1',
        '::ffff:169.254.169.254',
        '::ffff:93.184.216.34',
        '64:ff9b::127.0.0.1',
        '2002:7f00:0001::1',
        '2002:5db8:d822::1',
        '2001:0000:4136:e378:8000:63bf:3fff:fdd2',
        '2001:10::1',
        '2001:20::1',
        '2001:db8::1',
        'fe80::1',
        'fe80::1%eth0',
        'fd00::1',
        'fd00:ec2::254'
    ]) {
        assert.equal(isPrivateOrReservedIp(blockedIp), true, `Expected ${blockedIp} to be blocked`);
    }

    assert.equal(isPrivateOrReservedIp('93.184.216.34'), false);
    assert.equal(isPrivateOrReservedIp('2606:4700:4700::1111'), false);
    assert.equal(isPrivateOrReservedIp('2001:4860:4860::8888'), false);
    assert.equal(isPrivateOrReservedIp('172.16.1.2', { allowPrivateLan: true }), false);
    assert.equal(isPrivateOrReservedIp('fd00::1', { allowPrivateLan: true }), false);
    assert.equal(isPrivateOrReservedIp('100.64.1.2', { allowTailscale: true }), false);
    // Cloud metadata & IPv6 transition prefixes are ALWAYS blocked even when allowPrivateLan + allowTailscale are true!
    assert.equal(isPrivateOrReservedIp('169.254.169.254', { allowPrivateLan: true, allowTailscale: true }), true);
    assert.equal(isPrivateOrReservedIp('fd00:ec2::254', { allowPrivateLan: true, allowTailscale: true }), true);
    assert.equal(isPrivateOrReservedIp('::ffff:93.184.216.34', { allowPrivateLan: true, allowTailscale: true }), true);

    const metaUrlCheck = await validateOutboundUrl('http://metadata.google.internal/computeMetadata/v1/', {
        allowPrivateLan: true,
        allowTailscale: true
    });
    assert.equal(metaUrlCheck.ok, false);

    // Dual-stack DNS where one record is private must fail closed
    const dualStack = await validateOutboundUrl('https://dual.example.com/api', {
        lookupFn: async () => [
            { address: '93.184.216.34', family: 4 },
            { address: '127.0.0.1', family: 4 }
        ]
    });
    assert.equal(dualStack.ok, false);
    assert.equal(dualStack.error.code, 'SSRF_PRIVATE_IP');

    // 2. safeFetch blocks redirect to cloud metadata & strips Authorization/Cookie on cross-origin redirect
    const seenRequests = [];
    const redirectRes = await safeFetch(
        'https://origin-a.example.com/start',
        { headers: { Authorization: 'Bearer super-secret', Cookie: 'sid=123', Accept: 'application/json' } },
        {
            lookupFn: async () => [{ address: '93.184.216.34', family: 4 }],
            fetchImpl: async (url, init) => {
                seenRequests.push({ url: String(url), headers: new Headers(init.headers) });
                if (String(url).includes('origin-a.example.com')) {
                    return new Response('', {
                        status: 302,
                        headers: { Location: 'https://origin-b.example.com/final' }
                    });
                }
                return new Response(JSON.stringify({ ok: true }), { status: 200 });
            }
        }
    );
    assert.equal(redirectRes.ok, true);
    assert.equal(redirectRes.data.redirected, true);
    assert.equal(seenRequests.length, 2);
    assert.equal(seenRequests[0].headers.get('authorization'), 'Bearer super-secret');
    assert.equal(seenRequests[1].headers.get('authorization'), null, 'Cross-origin redirect must strip Authorization');
    assert.equal(seenRequests[1].headers.get('cookie'), null, 'Cross-origin redirect must strip Cookie');
    assert.equal(seenRequests[1].headers.get('accept'), 'application/json');

    const metadataRedirect = await safeFetch(
        'https://origin-a.example.com/evil',
        {},
        {
            lookupFn: async () => [{ address: '93.184.216.34', family: 4 }],
            fetchImpl: async () =>
                new Response('', {
                    status: 302,
                    headers: { Location: 'http://169.254.169.254/latest/meta-data/' }
                })
        }
    );
    assert.equal(metadataRedirect.ok, false);
    assert.equal(metadataRedirect.error.code, 'SSRF_PRIVATE_IP');

    // 3. Bounded createRateLimiter enforces maxKeys cap, Retry-After headers, Express middleware, and Edge check
    let fakeNow = 1_700_000_000_000;
    const limiter = createRateLimiter({ windowMs: 10_000, max: 2, maxKeys: 3, nowFn: () => fakeNow });
    assert.equal(limiter.consume('ip-1').allowed, true);
    assert.equal(limiter.consume('ip-1').allowed, true);
    const blocked = limiter.consume('ip-1');
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.envelope.error.code, 'RATE_LIMITED');
    assert.equal(blocked.headers['Retry-After'], '10');

    limiter.consume('ip-2');
    limiter.consume('ip-3');
    limiter.consume('ip-4');
    assert.ok(limiter.size() <= 3, 'Rate limiter Map must never exceed maxKeys');

    const edgeBlocked = limiter.edgeCheck(new Request('https://edge.local/api', { headers: { 'cf-connecting-ip': 'ip-4' } }));
    assert.equal(edgeBlocked.allowed, true);
    const edgeBlocked2 = limiter.edgeCheck(new Request('https://edge.local/api', { headers: { 'cf-connecting-ip': 'ip-4' } }));
    assert.equal(edgeBlocked2.allowed, false);
    assert.equal(edgeBlocked2.response.status, 429);

    // Express/Node middleware test
    let bodyOut = '';
    const mockRes = {
        statusCode: 200,
        headersSent: false,
        setHeader() {},
        writeHead(code) { this.statusCode = code; },
        end(chunk) { bodyOut = String(chunk || ''); }
    };
    const mw = limiter.middleware({ keyGenerator: () => 'ip-4' });
    mw({ headers: {}, socket: { remoteAddress: '127.0.0.1' } }, mockRes, () => {});
    assert.equal(mockRes.statusCode, 429);
    assert.equal(JSON.parse(bodyOut).error.code, 'RATE_LIMITED');
});

test('INV-LEGO-15: @krusch/toolkit/lego-scout & krusch-lego scout enforce symlink containment, Rule-of-3 vs anti-bloat, and portable paths', async () => {
    const { scoutHomelabLegoCandidates } = await import('./lego-scout.js');
    const { auditBoilerplateText } = await import('./catalog.js');

    // raw-node-sqlite audit check
    const rawNodeSqlite = auditBoilerplateText(
        "import { DatabaseSync } from 'node:sqlite';\nconst db = new DatabaseSync('./app.db');\n",
        'src/store.js'
    );
    assert.equal(rawNodeSqlite.data.clean, false);
    assert.ok(rawNodeSqlite.data.findings.some((f) => f.ruleId === 'raw-node-sqlite'));

    const cleanNodeSqlite = auditBoilerplateText(
        "import { openSqliteDb } from '@krusch/toolkit/sqlite';\nconst db = openSqliteDb('./app.db');\n",
        'src/store.js'
    );
    assert.equal(cleanNodeSqlite.data.clean, true);

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lego-scout-w3-'));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lego-scout-outside-'));
    try {
        fs.writeFileSync(path.join(outsideDir, 'secret.js'), "import pg from 'pg';\nexport const p = new pg.Pool();\n", 'utf8');
        const projectsDir = path.join(tmpRoot, 'projects');
        fs.mkdirSync(projectsDir, { recursive: true });

        // 3 projects sharing Zod schema validation (v1.6) + Python httpx (covered in krusch_toolkit v1.5) + SQLAlchemy (Wave-6 candidate)
        for (const name of ['svc-alpha', 'svc-beta', 'svc-gamma']) {
            const pDir = path.join(projectsDir, name, 'src');
            fs.mkdirSync(pDir, { recursive: true });
            fs.writeFileSync(
                path.join(projectsDir, name, 'package.json'),
                JSON.stringify({ name, dependencies: { zod: '^3.23.0' } }),
                'utf8'
            );
            fs.writeFileSync(
                path.join(projectsDir, name, 'requirements.txt'),
                'httpx>=0.27.0\nsqlalchemy>=2.0.0\n',
                'utf8'
            );
            fs.writeFileSync(
                path.join(pDir, 'schema.js'),
                "import { z } from 'zod';\nexport const ItemSchema = z.object({ id: z.string() });\n",
                'utf8'
            );
        }

        // Only 1 project using XML parser + raw node:sqlite -> BELOW_THRESHOLD_DO_NOT_EXTRACT + raw-node-sqlite adoptionFinding
        const xmlDir = path.join(projectsDir, 'svc-xml-only', 'src');
        fs.mkdirSync(xmlDir, { recursive: true });
        fs.writeFileSync(
            path.join(projectsDir, 'svc-xml-only', 'package.json'),
            JSON.stringify({ name: 'svc-xml-only', dependencies: { 'fast-xml-parser': '^4.0.0' } }),
            'utf8'
        );
        fs.writeFileSync(
            path.join(xmlDir, 'xml.js'),
            "import { XMLParser } from 'fast-xml-parser';\nimport { DatabaseSync } from 'node:sqlite';\nexport const db = new DatabaseSync('./app.db');\nexport const parser = new XMLParser();\n",
            'utf8'
        );

        // Symlink escaping outside projectsDir MUST be ignored
        fs.symlinkSync(outsideDir, path.join(projectsDir, 'escaped-link'));

        const res = scoutHomelabLegoCandidates(projectsDir, { minProjects: 3, portablePaths: true });
        assert.equal(res.ok, true);
        assert.equal(res.data.projectsRoot, '<HOMELAB_ROOT>/projects');
        assert.equal(res.data.adoptionFindings.some((f) => f.project === 'escaped-link'), false, 'Escaped symlink must be skipped');
        const sqliteAdopt = res.data.adoptionFindings.find((f) => f.project === 'svc-xml-only');
        assert.ok(sqliteAdopt, 'Expected scout adoptionFindings to detect raw DatabaseSync project');
        assert.ok(sqliteAdopt.rulesTriggered.includes('raw-node-sqlite'));

        const schemaCluster = res.data.candidateClusters.find((c) => c.id === 'schema-contract-validation');
        assert.ok(schemaCluster, 'Expected schema-contract-validation cluster');
        assert.equal(schemaCluster.projectCount, 3);
        assert.equal(schemaCluster.status, 'ALREADY_COVERED_IN_TOOLKIT');
        assert.ok(schemaCluster.sampleEvidence.every((p) => p.startsWith('<HOMELAB_ROOT>/projects/')));

        const httpxCluster = res.data.candidateClusters.find((c) => c.id === 'python-httpx-resilience');
        assert.ok(httpxCluster, 'Expected python-httpx-resilience cluster');
        assert.equal(httpxCluster.projectCount, 3);
        assert.equal(httpxCluster.status, 'ALREADY_COVERED_IN_TOOLKIT');
        assert.ok(httpxCluster.sampleEvidence.every((p) => p.startsWith('<HOMELAB_ROOT>/projects/')));

        const sqlaCluster = res.data.candidateClusters.find((c) => c.id === 'python-sqlalchemy-wal-pool');
        assert.ok(sqlaCluster, 'Expected python-sqlalchemy-wal-pool cluster');
        assert.equal(sqlaCluster.projectCount, 3);
        assert.equal(sqlaCluster.status, 'ALREADY_COVERED_IN_TOOLKIT');
        assert.ok(sqlaCluster.sampleEvidence.every((p) => p.startsWith('<HOMELAB_ROOT>/projects/')));

        const xmlCluster = res.data.candidateClusters.find((c) => c.id === 'niche-xml-or-yaml');
        assert.ok(xmlCluster, 'Expected niche-xml-or-yaml cluster');
        assert.equal(xmlCluster.projectCount, 1);
        assert.equal(xmlCluster.status, 'BELOW_THRESHOLD_DO_NOT_EXTRACT');

        // CLI check: krusch-lego scout <projectsDir> --portable --json
        const cliOut = execFileSync(
            process.execPath,
            [path.join(__dirname, 'bin/krusch-lego.js'), 'scout', projectsDir, '--portable', '--json'],
            { encoding: 'utf8' }
        );
        const cliJson = JSON.parse(cliOut);
        assert.equal(cliJson.ok, true);
        assert.equal(cliJson.tool, 'krusch-lego');
        assert.equal(cliJson.data.projectsRoot, '<HOMELAB_ROOT>/projects');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
        fs.rmSync(outsideDir, { recursive: true, force: true });
    }
});
