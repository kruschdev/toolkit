import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgJson = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));

test('INV-LEGO-02: Every subpath in lib/package.json exports exists on disk and imports cleanly in headless Node ESM', async () => {
    const entries = Object.entries(pkgJson.exports || {});
    assert.ok(entries.length >= 40, 'Expected full toolkit exports map');

    for (const [subpath, relTarget] of entries) {
        const jsRel = typeof relTarget === 'string' ? relTarget : relTarget.default;
        const absTarget = path.resolve(__dirname, jsRel);
        assert.equal(fs.existsSync(absTarget), true, `Export ${subpath} -> ${jsRel} missing on disk`);
        if (relTarget && typeof relTarget === 'object' && relTarget.types) {
            const absTypes = path.resolve(__dirname, relTarget.types);
            assert.equal(fs.existsSync(absTypes), true, `Export ${subpath} types -> ${relTarget.types} missing on disk`);
        }
        const mod = await import(absTarget);
        assert.equal(typeof mod, 'object', `Export ${subpath} failed headless ESM import`);
    }
});

test('INV-LEGO-01 & INV-LEGO-03: @krusch/toolkit/http serves /health, /doctor, JSON envelopes, 413 bounded body without ECONNRESET, and graceful shutdown', async () => {
    const {
        okEnvelope,
        errorEnvelope,
        asyncHandler,
        createExpressBricks,
        createApiServer,
        attachGracefulShutdown
    } = await import('./http.js');

    assert.deepEqual(okEnvelope('demo', 'Done', { count: 2 }), {
        ok: true,
        tool: 'demo',
        summary: 'Done',
        data: { count: 2 }
    });
    assert.equal(errorEnvelope('BAD_INPUT', 'Missing field').ok, false);

    let healthy = true;
    const server = createApiServer({
        serviceName: 'lego-test-api',
        version: '1.3.0',
        maxBodyBytes: 256,
        healthCheck: async () => (healthy ? { db: 'ready' } : { ok: false, reason: 'db_down' }),
        routes: {
            'GET /api/ping': ({ query }) => okEnvelope('ping', 'Pong', { echo: query.q || 'none' }),
            'POST /api/echo': ({ body }) => ({ received: body })
        }
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;

    let cleaned = false;
    const lifecycle = attachGracefulShutdown(server, [async () => { cleaned = true; }], { signals: [] });

    try {
        const healthRes = await fetch(`${base}/health`);
        assert.equal(healthRes.status, 200);
        const healthJson = await healthRes.json();
        assert.equal(healthJson.ok, true);
        assert.equal(healthJson.data.service, 'lego-test-api');
        assert.equal(healthJson.data.db, 'ready');

        healthy = false;
        const unhealthyRes = await fetch(`${base}/doctor`);
        assert.equal(unhealthyRes.status, 503);
        const unhealthyJson = await unhealthyRes.json();
        assert.equal(unhealthyJson.ok, false);
        healthy = true;

        const pingRes = await fetch(`${base}/api/ping?q=lego`);
        assert.equal(pingRes.status, 200);
        const pingJson = await pingRes.json();
        assert.equal(pingJson.ok, true);
        assert.equal(pingJson.data.echo, 'lego');

        const postRes = await fetch(`${base}/api/echo`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ brick: 'http' })
        });
        assert.equal(postRes.status, 200);
        const postJson = await postRes.json();
        assert.equal(postJson.ok, true);
        assert.deepEqual(postJson.data.received, { brick: 'http' });

        // Oversized body > 256B must return clean HTTP 413 JSON without ECONNRESET
        const bigPayload = JSON.stringify({ pad: 'x'.repeat(4096) });
        const tooBigRes = await fetch(`${base}/api/echo`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: bigPayload
        });
        assert.equal(tooBigRes.status, 413);
        const tooBigJson = await tooBigRes.json();
        assert.equal(tooBigJson.error.code, 'PAYLOAD_TOO_LARGE');

        // Express middleware helper check
        let forwardedErr = null;
        await asyncHandler(async () => {
            throw new Error('boom');
        })({}, {}, (err) => { forwardedErr = err; });
        assert.equal(forwardedErr.message, 'boom');
        const bricks = createExpressBricks({ serviceName: 'exp' });
        assert.equal(typeof bricks.healthHandler, 'function');
    } finally {
        await lifecycle.shutdown('TEST');
        lifecycle.detach();
    }
    assert.equal(cleaned, true);
});

test('INV-LEGO-03: @krusch/toolkit/streaming streams SSE tokens and aborts upstream on client disconnect', async () => {
    const { streamChat } = await import('./streaming.js');

    let upstreamSignalAborted = false;
    const srv = http.createServer(async (req, res) => {
        if (req.url === '/sse-fast') {
            await streamChat(res, req, {
                tool: 'demo.stream',
                userMessage: 'hi',
                chatFn: async () => 'Hello Lego SSE!'
            });
            return;
        }
        if (req.url === '/sse-abort') {
            await streamChat(res, req, {
                tool: 'demo.abort',
                userMessage: 'slow',
                chatFn: async (_sys, _usr, _cfg, opts) => {
                    await new Promise((resolve) => {
                        opts.signal.addEventListener('abort', () => {
                            upstreamSignalAborted = true;
                            resolve();
                        }, { once: true });
                    });
                    return '';
                }
            });
        }
    });

    await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
    const { port } = srv.address();
    try {
        const res = await fetch(`http://127.0.0.1:${port}/sse-fast`);
        assert.equal(res.status, 200);
        assert.match(res.headers.get('content-type') || '', /text\/event-stream/);
        assert.equal(res.headers.get('x-accel-buffering'), 'no');
        const bodyText = await res.text();
        assert.match(bodyText, /event: token/);
        assert.match(bodyText, /Hello Lego SSE!/);
        assert.match(bodyText, /event: done/);

        // Client abort propagation test
        const ac = new AbortController();
        const slowPromise = fetch(`http://127.0.0.1:${port}/sse-abort`, { signal: ac.signal }).then(async (r) => {
            const reader = r.body.getReader();
            await reader.read();
            ac.abort();
        }).catch(() => {});
        await slowPromise;
        for (let i = 0; i < 20 && !upstreamSignalAborted; i++) {
            await new Promise((r) => setTimeout(r, 20));
        }
        assert.equal(upstreamSignalAborted, true, 'Expected client disconnect to abort upstream SSE signal');
    } finally {
        await new Promise((resolve) => srv.close(resolve));
    }
});

test('INV-LEGO-04 & INV-LEGO-05: @krusch/toolkit/mcp, pg, and llm-queue enforce annotations, safe SQL/vectors, and fleet IP hygiene', async () => {
    const { defineMcpTool, okMcpResult, validateToolArgs, createMcpServer } = await import('./mcp-server.js');
    const { createPgPool, runSqlMigrations, pgVectorSearch } = await import('./pg.js');
    const { DEFAULT_FLEET_OLLAMA_NODES } = await import('./llm-queue.js');

    // Fleet IP hygiene
    const joinedNodes = DEFAULT_FLEET_OLLAMA_NODES.join(',');
    assert.equal(/10\.0\.0\.(?:85|145|249)/.test(joinedNodes), false);
    assert.ok(joinedNodes.includes('127.0.0.1:11434'));

    // MCP 4-boolean annotations + validation
    const tool = defineMcpTool({
        name: 'echo_brick',
        description: 'Echoes text',
        inputSchema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] }
    });
    assert.equal(typeof tool.annotations.readOnlyHint, 'boolean');
    assert.equal(typeof tool.annotations.destructiveHint, 'boolean');
    assert.equal(typeof tool.annotations.idempotentHint, 'boolean');
    assert.equal(typeof tool.annotations.openWorldHint, 'boolean');
    assert.equal(validateToolArgs(tool, {}).valid, false);
    assert.equal(validateToolArgs(tool, { msg: 'ok' }).valid, true);

    const mcp = await createMcpServer(
        'test-mcp',
        '1.0.0',
        [tool],
        async (name, args) => okMcpResult(name, 'Echoed', { msg: args.msg }),
        { connect: false }
    );
    assert.equal(mcp.normalizedTools.length, 1);

    // Mock PG pool + migrations + 1024d vector search
    const appliedIds = new Set();
    const queries = [];
    class MockPool {
        on() {}
        async query(sql, params = []) {
            queries.push({ sql, params });
            if (/SELECT id FROM schema_migrations/i.test(sql)) {
                return { rows: Array.from(appliedIds, (id) => ({ id })), rowCount: appliedIds.size };
            }
            if (/INSERT INTO schema_migrations/i.test(sql)) {
                appliedIds.add(params[0]);
                return { rows: [], rowCount: 1 };
            }
            if (/<=>/.test(sql)) {
                return { rows: [{ id: 'doc-1', similarity: 0.94 }], rowCount: 1 };
            }
            return { rows: [{ ok: 1 }], rowCount: 1 };
        }
        async connect() {
            return {
                query: (sql, params) => this.query(sql, params),
                release() {}
            };
        }
        async end() {}
    }

    const pgWrap = createPgPool({ host: '127.0.0.1', database: 'testdb' }, { PoolClass: MockPool });
    const mig1 = await runSqlMigrations(pgWrap, [{ id: '001_init', sql: 'CREATE TABLE docs (id TEXT);' }]);
    assert.equal(mig1.ok, true);
    assert.deepEqual(mig1.data.applied, ['001_init']);
    const mig2 = await runSqlMigrations(pgWrap, [{ id: '001_init', sql: 'CREATE TABLE docs (id TEXT);' }]);
    assert.deepEqual(mig2.data.skipped, ['001_init']);

    const vec = Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0));
    const vRes = await pgVectorSearch(pgWrap, {
        table: 'docs',
        vector: vec,
        selectColumns: ['id'],
        whereSql: 'tenant_id = $1',
        params: ['acme'],
        limit: 5
    });
    assert.equal(vRes.ok, true);
    assert.equal(vRes.data.rows[0].id, 'doc-1');

    await assert.rejects(
        () => pgVectorSearch(pgWrap, { table: 'docs; DROP TABLE users;--', vector: vec }),
        /Unsafe SQL/i
    );
});

test('INV-LEGO-02 & INV-LEGO-03: @krusch/toolkit/react works headlessly and renders UI shells with mock React runtime', async () => {
    const reactBrick = await import('./react.js');
    assert.equal(reactBrick.cn('px-2', 'px-4'), 'px-4');
    const tokens = reactBrick.useAesthetics('cyber');
    assert.equal(tokens.variant, 'cyber');
    assert.ok(tokens.card.length > 0);

    // AbortController cancellation in fetchApiJson
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(
        () => reactBrick.fetchApiJson('http://127.0.0.1:9/never', {
            signal: ac.signal,
            fetchImpl: async (_u, init) => {
                if (init.signal.aborted) {
                    const err = new Error('Aborted');
                    err.name = 'AbortError';
                    throw err;
                }
                return new Response('{}');
            }
        }),
        /Abort/i
    );

    const prevRuntime = reactBrick.getReactRuntime();
    reactBrick.setReactRuntime({
        createElement: (type, props, ...children) => ({ type, props: props || {}, children })
    });
    try {
        const shellTree = reactBrick.AppShell({
            title: 'Lego Shell',
            status: 'healthy',
            children: reactBrick.MetricCard({ title: 'Latency', value: '12ms', status: 'healthy' })
        });
        assert.equal(shellTree.type, 'div');
    } finally {
        reactBrick.setReactRuntime(prevRuntime);
    }
});

test('INV-LEGO-01 & INV-LEGO-04: @krusch/toolkit/catalog, scaffoldProject, and krusch-lego CLI stamp all 7 archetypes cleanly', async () => {
    const { listLegoBricks, listArchetypes, auditBoilerplateText } = await import('./catalog.js');
    const { scaffoldProject } = await import('./scaffold.js');

    assert.equal(listLegoBricks().length, 35);
    assert.equal(listLegoBricks({ runtime: 'edge' }).length, 1);
    const archetypes = listArchetypes();
    assert.equal(archetypes.length, 7);

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'krusch-lego-suite-'));
    try {
        for (const arch of archetypes) {
            const dest = path.join(tmpRoot, arch.id);
            const res = await scaffoldProject(dest, {
                archetype: arch.id,
                projectName: `demo-${arch.id}`,
                port: 3456,
                quiet: true
            });
            assert.equal(res.ok, true);
            assert.ok(res.data.createdFiles.length >= 5, `Expected files for ${arch.id}`);

            for (const rel of res.data.createdFiles) {
                const full = path.join(dest, rel);
                const text = fs.readFileSync(full, 'utf8');
                assert.equal(/10\.0\.0\.(?:85|145|249)|spectralquant/i.test(text), false, `Retired value in ${arch.id}/${rel}`);
                if (rel.endsWith('.js')) {
                    execFileSync(process.execPath, ['--check', full]);
                } else if (rel.endsWith('.ts')) {
                    execFileSync(process.execPath, ['--experimental-strip-types', '--check', full]);
                } else if (rel.endsWith('.py')) {
                    execFileSync('python3', ['-m', 'py_compile', full]);
                }
                if (/\.(?:js|jsx|ts|tsx|py)$/.test(rel) && !rel.startsWith('tests/')) {
                    const audit = auditBoilerplateText(text, rel);
                    assert.equal(audit.data.clean, true, `Stamped file ${arch.id}/${rel} triggered boilerplate audit: ${JSON.stringify(audit.data.findings)}`);
                }
            }
        }

        // CLI JSON check
        const cliOut = execFileSync(process.execPath, [path.join(__dirname, 'bin/krusch-lego.js'), 'list', '--json'], {
            encoding: 'utf8'
        });
        const parsed = JSON.parse(cliOut);
        assert.equal(parsed.ok, true);
        assert.equal(parsed.tool, 'krusch-lego');

        // REF1-07 & REF1-08: auditBoilerplateText returns tool === 'lego.catalog' and krusch-lego audit scans nested src/lib/
        const nestedLibDir = path.join(tmpRoot, 'downstream-app', 'src', 'lib');
        fs.mkdirSync(nestedLibDir, { recursive: true });
        fs.writeFileSync(
            path.join(nestedLibDir, 'raw-db.js'),
            "import pg from 'pg';\nexport const pool = new pg.Pool();\n",
            'utf8'
        );
        const directAudit = auditBoilerplateText("import pg from 'pg';\nconst p = new pg.Pool();\n", 'src/lib/raw-db.js');
        assert.equal(directAudit.tool, 'lego.catalog');
        assert.equal(directAudit.data.clean, false);

        const cliAuditOut = execFileSync(
            process.execPath,
            [path.join(__dirname, 'bin/krusch-lego.js'), 'audit', path.join(tmpRoot, 'downstream-app'), '--json'],
            { encoding: 'utf8' }
        );
        const cliAuditJson = JSON.parse(cliAuditOut);
        assert.equal(cliAuditJson.ok, true);
        assert.equal(cliAuditJson.data.clean, false, 'krusch-lego audit must scan nested downstream src/lib directories');

        // REF1-05: Stamped Dockerfiles + docker-compose.yml wire additional_contexts for @krusch/toolkit and krusch_toolkit
        const nodeCompose = fs.readFileSync(path.join(tmpRoot, 'node-api-sqlite', 'docker-compose.yml'), 'utf8');
        assert.match(nodeCompose, /additional_contexts:/);
        assert.match(nodeCompose, /krusch_toolkit:\s*\.\.\/\.\.\/lib/);
        const pyDockerfile = fs.readFileSync(path.join(tmpRoot, 'python-fastapi-service', 'Dockerfile'), 'utf8');
        assert.match(pyDockerfile, /COPY --from=krusch_toolkit_py/);
        assert.match(pyDockerfile, /\/krusch-lib-py\[fastapi\]/);
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('REF1-06, REF1-07 & REF1-09: URL normalization, non-cooperative streamChat disconnect race, and AGENTS.md byte ceiling', async () => {
    const { createApiServer, okEnvelope } = await import('./http.js');
    const { streamChat } = await import('./streaming.js');

    // REF1-09: Malformed Host header + protocol-relative //evil.com/path must not throw 500 or spoof host
    const server = createApiServer({
        serviceName: 'url-guard-test',
        routes: {
            'GET /evil.com/check': ({ url, pathname, query }) =>
                okEnvelope('url.guard', 'Safe URL', { host: url.host, pathname, q: query.q })
        }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    try {
        const rawResp = await new Promise((resolve, reject) => {
            const req = http.request(
                {
                    host: '127.0.0.1',
                    port,
                    method: 'GET',
                    path: '//evil.com/check?q=ok',
                    headers: { Host: ':::malformed_host:::' }
                },
                (res) => {
                    let data = '';
                    res.setEncoding('utf8');
                    res.on('data', (chunk) => { data += chunk; });
                    res.on('end', () => resolve({ statusCode: res.statusCode, body: JSON.parse(data) }));
                }
            );
            req.on('error', reject);
            req.end();
        });
        assert.equal(rawResp.statusCode, 200);
        assert.equal(rawResp.body.data.host, '127.0.0.1');
        assert.equal(rawResp.body.data.pathname, '/evil.com/check');
        assert.equal(rawResp.body.data.q, 'ok');
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }

    // REF1-06: streamChat resolves promptly on client disconnect even if custom chatFn ignores AbortSignal
    let streamChatSettled = false;
    const sseSrv = http.createServer(async (req, res) => {
        await streamChat(res, req, {
            tool: 'demo.hang',
            userMessage: 'hang',
            chatFn: () => new Promise(() => {}) // never resolves on its own
        });
        streamChatSettled = true;
    });
    await new Promise((resolve) => sseSrv.listen(0, '127.0.0.1', resolve));
    const ssePort = sseSrv.address().port;
    try {
        const ac = new AbortController();
        await fetch(`http://127.0.0.1:${ssePort}/hang`, { signal: ac.signal })
            .then(async (r) => {
                const reader = r.body.getReader();
                await reader.read();
                ac.abort();
            })
            .catch(() => {});
        for (let i = 0; i < 25 && !streamChatSettled; i++) {
            await new Promise((r) => setTimeout(r, 20));
        }
        assert.equal(streamChatSettled, true, 'streamChat must settle immediately when client disconnects');
    } finally {
        await new Promise((resolve) => sseSrv.close(resolve));
    }

    // INV-LEGO-07: Root AGENTS.md byte budget strictly < 18,432 bytes (when running inside monorepo)
    const rootAgentsPath = path.resolve(__dirname, '..', 'AGENTS.md');
    if (fs.existsSync(rootAgentsPath)) {
        const rootAgentsBytes = fs.statSync(rootAgentsPath).size;
        assert.ok(rootAgentsBytes < 18432, `Root AGENTS.md (${rootAgentsBytes}B) exceeded 18,432B ceiling`);
    }
});

test('REF2-01, REF2-02 & REF2-03: Connected pg.Client migrations, SSE INV-LEGO-01 done/error envelopes, and compose LOG_DIR parity', async () => {
    const pgMod = (await import('pg')).default;
    const { runSqlMigrations } = await import('./pg.js');
    const { sseResponse, streamChat } = await import('./streaming.js');
    const { getArchetype, listArchetypes } = await import('./catalog.js');

    // REF2-01: Connected pg.Client / checked-out PoolClient inherits .connect() that throws if called twice
    let clientReleased = false;
    const appliedSet = new Set();
    const connectedClient = Object.create(pgMod.Client.prototype);
    connectedClient._connected = true;
    connectedClient.connect = async () => {
        throw new Error('Client has already been connected. You cannot reuse a client.');
    };
    connectedClient.release = () => {
        clientReleased = true;
    };
    connectedClient.query = async (sql, params = []) => {
        if (/SELECT id FROM schema_migrations/i.test(sql)) {
            return { rows: Array.from(appliedSet, (id) => ({ id })), rowCount: appliedSet.size };
        }
        if (/INSERT INTO schema_migrations/i.test(sql)) {
            appliedSet.add(params[0]);
            return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
    };

    const migRes = await runSqlMigrations(connectedClient, [{ id: '001_single_client', sql: 'CREATE TABLE t (id INT);' }]);
    assert.equal(migRes.ok, true);
    assert.deepEqual(migRes.data.applied, ['001_single_client']);
    assert.equal(clientReleased, false, 'runSqlMigrations must not release a caller-owned PoolClient');

    // REF2-02: sseResponse sanitizes CRLF in corsOrigin and emits full INV-LEGO-01 envelopes on done() & error()
    const mkMockRes = () => {
        const headers = {};
        const chunks = [];
        return {
            headers,
            chunks,
            headersSent: false,
            writableEnded: false,
            destroyed: false,
            setHeader(k, v) { headers[k] = v; },
            write(chunk) { chunks.push(String(chunk)); return true; },
            end() { this.writableEnded = true; }
        };
    };

    const resDone = mkMockRes();
    const sseDone = sseResponse(resDone, null, {
        heartbeatMs: 0,
        retryMs: 0,
        corsOrigin: 'https://app.example\r\nX-Injected: bad',
        tool: 'custom.sse'
    });
    assert.equal(resDone.headers['Access-Control-Allow-Origin'], 'https://app.exampleX-Injected: bad');
    sseDone.done('Completed cleanly');
    const doneFrame = JSON.parse(resDone.chunks[0].split('data: ')[1]);
    assert.deepEqual(doneFrame, {
        ok: true,
        tool: 'custom.sse',
        summary: 'Completed cleanly',
        data: {}
    });

    const resErr = mkMockRes();
    await streamChat(resErr, null, {
        tool: 'chat.sse',
        heartbeatMs: 0,
        userMessage: 'boom',
        chatFn: async () => {
            const err = new Error('Upstream quota exceeded');
            err.code = 'QUOTA_EXCEEDED';
            err.details = { retryAfterSec: 30 };
            throw err;
        }
    });
    const errChunk = resErr.chunks.find((c) => c.startsWith('event: error\n'));
    assert.ok(errChunk, 'Expected SSE error event frame');
    const errFrame = JSON.parse(errChunk.split('data: ')[1]);
    assert.deepEqual(errFrame, {
        ok: false,
        tool: 'chat.sse',
        summary: 'Upstream quota exceeded',
        error: {
            code: 'QUOTA_EXCEEDED',
            message: 'Upstream quota exceeded',
            details: { retryAfterSec: 30 }
        }
    });

    // REF2-03: Every archetype docker-compose.yml sets LOG_DIR: /app/data/logs on its mounted volume
    for (const arch of listArchetypes()) {
        const files = getArchetype(arch.id).renderFiles({ projectName: `check-${arch.id}`, port: 3100 });
        assert.match(
            files['docker-compose.yml'],
            /LOG_DIR:\s*\/app\/data\/logs/,
            `Expected LOG_DIR: /app/data/logs in ${arch.id}/docker-compose.yml`
        );
    }
});

test('REF3-01..05: Docker cascade-router context & .dockerignore, backslash URL guard, premature stream destroy cleanup, whereSql SQLi guard, and SSE CORS allowlist preservation', async () => {
    const net = await import('node:net');
    const { PassThrough } = await import('node:stream');
    const { createApiServer, readBoundedJsonBody, okEnvelope } = await import('./http.js');
    const { streamChat, sseResponse } = await import('./streaming.js');
    const { createPgPool, pgVectorSearch, assertSafeWhereClause } = await import('./pg.js');
    const { getArchetype, listArchetypes } = await import('./catalog.js');

    // REF3-01: All 5 archetypes stamp .dockerignore and all 4 Node archetypes map krusch_cascade_router
    for (const arch of listArchetypes()) {
        const files = getArchetype(arch.id).renderFiles({ projectName: `ref3-${arch.id}`, port: 3200 });
        assert.ok(typeof files['.dockerignore'] === 'string', `Missing .dockerignore in ${arch.id}`);
        assert.match(files['.dockerignore'], /^node_modules$/m);
        assert.match(files['.dockerignore'], /^\.env$/m);
        if (arch.runtime === 'node') {
            assert.match(files['docker-compose.yml'], /krusch_cascade_router:\s*\.\.\/\.\.\/projects\/krusch-cascade-router/);
            assert.match(files['Dockerfile'], /COPY --from=krusch_cascade_router package\.json/);
        }
    }

    // REF3-02 & REF3-05: Backslash URL authority-spoofing guard + absolute-form /health + SSE CORS allowlist preservation
    const server = createApiServer({
        serviceName: 'ref3-http-guard',
        corsOrigins: ['https://allowed.example'],
        routes: {
            'GET /evil.com/probe': ({ url, pathname }) =>
                okEnvelope('probe', 'Safe', { origin: url.origin, host: url.host, pathname }),
            'GET /sse': async ({ req, res }) => {
                await streamChat(res, req, {
                    tool: 'sse.cors',
                    heartbeatMs: 0,
                    userMessage: 'hi',
                    chatFn: async () => 'ok'
                });
            }
        }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    try {
        const sendRawHttp = (requestLine, extraHeaders = '') =>
            new Promise((resolve, reject) => {
                const sock = net.createConnection({ host: '127.0.0.1', port }, () => {
                    sock.write(`${requestLine}\r\nHost: 127.0.0.1\r\nConnection: close\r\n${extraHeaders}\r\n`);
                });
                let raw = '';
                sock.setEncoding('utf8');
                sock.on('data', (chunk) => { raw += chunk; });
                sock.on('end', () => resolve(raw));
                sock.on('error', reject);
            });

        const backslashResp = await sendRawHttp('GET /\\evil.com/probe HTTP/1.1');
        const backslashJson = JSON.parse(backslashResp.split('\r\n\r\n')[1]);
        assert.equal(backslashJson.ok, true);
        assert.equal(backslashJson.data.origin, 'http://127.0.0.1');
        assert.equal(backslashJson.data.host, '127.0.0.1');
        assert.equal(backslashJson.data.pathname, '/evil.com/probe');

        const absHealthResp = await sendRawHttp(`GET http://127.0.0.1:${port}/health HTTP/1.1`);
        const absHealthJson = JSON.parse(absHealthResp.split('\r\n\r\n')[1]);
        assert.equal(absHealthJson.ok, true);
        assert.equal(absHealthJson.data.service, 'ref3-http-guard');

        // REF3-05: Disallowed Origin must NOT get wildcard Access-Control-Allow-Origin: * on SSE route
        const blockedCorsSse = await fetch(`http://127.0.0.1:${port}/sse`, {
            headers: { Origin: 'https://attacker.example' }
        });
        assert.equal(blockedCorsSse.headers.get('access-control-allow-origin'), null);
        await blockedCorsSse.text();

        // Allowed Origin preserves exact allowlisted origin on SSE route
        const allowedCorsSse = await fetch(`http://127.0.0.1:${port}/sse`, {
            headers: { Origin: 'https://allowed.example' }
        });
        assert.equal(allowedCorsSse.headers.get('access-control-allow-origin'), 'https://allowed.example');
        await allowedCorsSse.text();
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }

    // Standalone sseResponse without middleware still defaults to '*'
    const standaloneHeaders = {};
    const standaloneSse = sseResponse({
        headersSent: false,
        writableEnded: false,
        destroyed: false,
        setHeader(k, v) { standaloneHeaders[k] = v; },
        write() { return true; },
        end() { this.writableEnded = true; }
    }, null, { heartbeatMs: 0, retryMs: 0 });
    assert.equal(standaloneHeaders['Access-Control-Allow-Origin'], '*');
    standaloneSse.close();

    // REF3-03: Premature PassThrough destroy() settles readBoundedJsonBody as null with zero leaked listeners
    const pt = new PassThrough();
    const mockRes = {
        headersSent: false,
        writableEnded: false,
        destroyed: false,
        setHeader() {},
        end() { this.writableEnded = true; }
    };
    const pendingRead = readBoundedJsonBody(pt, mockRes, { maxBytes: 1024 });
    pt.write('{"partial":');
    pt.destroy();
    const abortedBody = await pendingRead;
    assert.equal(abortedBody, null);
    for (const ev of ['data', 'end', 'error', 'aborted', 'close']) {
        assert.equal(pt.listenerCount(ev), 0, `Expected 0 leaked "${ev}" listeners after stream destroy`);
    }

    // REF3-04: assertSafeWhereClause & pgVectorSearch block SQLi breakout while allowing valid parameterized predicates
    assert.equal(
        assertSafeWhereClause("WHERE tenant_id = $1 AND (label = 'it''s--safe' OR score > $2)"),
        "tenant_id = $1 AND (label = 'it''s--safe' OR score > $2)"
    );
    for (const maliciousWhere of [
        '1=1) OR (1=1',
        'tenant_id = $1 -- comment out',
        'tenant_id = $1 /* block */',
        'tenant_id = $1; DROP TABLE docs',
        'tenant_id = $1 UNION SELECT id, 1.0 FROM secrets',
        'tenant_id = $$injected$$'
    ]) {
        assert.throws(() => assertSafeWhereClause(maliciousWhere), /whereSql/i);
    }

    const pgWrap = createPgPool({ host: '127.0.0.1', database: 'testdb' }, {
        PoolClass: class {
            on() {}
            async query() { return { rows: [] }; }
            async end() {}
        }
    });
    const vec = Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0));
    await assert.rejects(
        () => pgVectorSearch(pgWrap, { table: 'docs', vector: vec, whereSql: '1=0) OR (1=1' }),
        /Unbalanced parentheses/i
    );
});

test('REF4-01, REF4-02, REF4-04 & REF4-05: PG E-string/double-quote lexer guard, SSE route return-value safety, forceClose finish wait, and glob-string comment stripping', async () => {
    const { createApiServer } = await import('./http.js');
    const { streamChat, sseResponse } = await import('./streaming.js');
    const { assertSafeWhereClause } = await import('./pg.js');
    const { auditBoilerplateText } = await import('./catalog.js');

    // REF4-01: Reject PostgreSQL E'...' backslash escapes and double-quoted "'" desynchronization
    for (const bypassAttempt of [
        "status = E'\\'' ) UNION SELECT id, rolpassword, 1.0 FROM pg_authid; -- '",
        "status = e'\\'' ) OR (1=1",
        "\"col'name\" ) UNION SELECT id, 1.0 FROM secrets -- '",
        "status = 'abc\\'def'"
    ]) {
        assert.throws(() => assertSafeWhereClause(bypassAttempt), /whereSql/i);
    }
    assert.equal(
        assertSafeWhereClause('"tenant_id" = $1 AND status = \'it\'\'s_ok\''),
        '"tenant_id" = $1 AND status = \'it\'\'s_ok\''
    );

    // REF4-02: Route returning streamChat(...) or object after sseResponse headersSent must NEVER append raw JSON to SSE stream
    const server = createApiServer({
        serviceName: 'sse-return-guard',
        routes: {
            'GET /sse-return': ({ req, res }) =>
                streamChat(res, req, {
                    tool: 'sse.return',
                    heartbeatMs: 0,
                    userMessage: 'hi',
                    chatFn: async () => 'stream-ok'
                }),
            'GET /sse-open-return': ({ req, res }) => {
                const sse = sseResponse(res, req, { heartbeatMs: 0, retryMs: 0, tool: 'sse.open' });
                sse.sendToken('partial');
                sse.close();
                return { ok: true, aborted: true };
            }
        }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    try {
        const r1 = await fetch(`http://127.0.0.1:${port}/sse-return`);
        const t1 = await r1.text();
        assert.equal(t1.includes('{"ok":true,"aborted":'), false);

        const r2 = await fetch(`http://127.0.0.1:${port}/sse-open-return`);
        const t2 = await r2.text();
        assert.equal(t2.includes('{"ok":true,"aborted":true}'), false);
        assert.match(t2, /event: token/);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }

    // REF4-05: Glob strings containing '/*' above JSDoc comments must not swallow imports or boilerplate
    const cleanWithGlobAndJsdoc = [
        'const testGlob = "tests/*.test.js";',
        'import { createPgPool } from "@krusch/toolkit/pg";',
        '/** JSDoc block comment */',
        'export const db = createPgPool();'
    ].join('\n');
    assert.equal(auditBoilerplateText(cleanWithGlobAndJsdoc, 'src/db.js').data.clean, true);

    const dirtyWithGlobAndJsdoc = [
        'const testGlob = "tests/*.test.js";',
        'import pg from "pg";',
        'export const rawPool = new pg.Pool();',
        '/** JSDoc block comment */'
    ].join('\n');
    assert.equal(auditBoilerplateText(dirtyWithGlobAndJsdoc, 'src/db.js').data.clean, false);
});

test('REF5-01 & REF5-03: Out-of-range $N parameter collision guard in pgVectorSearch and ES2022 #private + /`/g regex lexer parity in catalog', async () => {
    const { createPgPool, pgVectorSearch, assertSafeWhereClause } = await import('./pg.js');
    const { auditBoilerplateText } = await import('./catalog.js');

    // REF5-01: $0 or $N > params.length must throw before colliding with internal vector/limit bind slots
    assert.throws(() => assertSafeWhereClause('tenant_id = $0', { maxParamIndex: 1 }), /Invalid SQL parameter index \$0/i);
    assert.throws(
        () => assertSafeWhereClause('org_id = $1 AND tenant_id = $3', { maxParamIndex: 1 }),
        /Out-of-range SQL parameter \$3/i
    );

    const pgWrap = createPgPool({ host: '127.0.0.1', database: 'testdb' }, {
        PoolClass: class {
            on() {}
            async query() { return { rows: [] }; }
            async end() {}
        }
    });
    const vec = Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0));
    await assert.rejects(
        () => pgVectorSearch(pgWrap, {
            table: 'documents',
            vector: vec,
            whereSql: 'org_id = $1 AND tenant_id = $3',
            params: ['org_alpha'],
            limit: 5
        }),
        /Out-of-range SQL parameter \$3/i
    );

    // REF5-03: ES2022 #private class field initializers and /`/g regex literals must not desynchronize comment stripping
    const privateFieldPool = [
        "import pg from 'pg';",
        'class Store {',
        '  #pool = new pg.Pool({ max: 5 });',
        '}'
    ].join('\n');
    assert.equal(auditBoilerplateText(privateFieldPool, 'src/store.js').data.clean, false);

    const regexBacktickClean = [
        'const clean = raw.replace(/`/g, "");',
        '// Legacy note: replaced new pg.Pool() with @krusch/toolkit/pg',
        'export const ok = true;'
    ].join('\n');
    assert.equal(auditBoilerplateText(regexBacktickClean, 'src/util.js').data.clean, true);

    const regexBacktickBypassAttempt = [
        'const clean = raw.replace(/`/g, "");',
        "// import { createPgPool } from '@krusch/toolkit/pg';",
        "import pg from 'pg';",
        'export const pool = new pg.Pool();'
    ].join('\n');
    assert.equal(auditBoilerplateText(regexBacktickBypassAttempt, 'src/db.js').data.clean, false);

    const pyTightComment = [
        'from fastapi import FastAPI',
        'from fastapi.middleware.cors import CORSMiddleware',
        'app = FastAPI()',
        'app.add_middleware(CORSMiddleware, allow_origins=["*"])',
        'x = 1#@app.get("/health")'
    ].join('\n');
    assert.equal(auditBoilerplateText(pyTightComment, 'app/main.py').data.clean, true);
});

test('REF7-01, REF7-03 & Prototype Lookup Guards: non-ASCII dollar-quoting SQLi, SELECT subqueries, ${...} template interpolations, and Object.hasOwn', async () => {
    const { assertSafeWhereClause } = await import('./pg.js');
    const { auditBoilerplateText } = await import('./catalog.js');
    const { useAesthetics, StatusPill, setReactRuntime, getReactRuntime } = await import('./react.js');

    // REF7-01: Non-ASCII UTF-8 PostgreSQL dollar-quoting ($é$, $α$), SELECT subqueries, pg_read_file, and null bytes
    const nonAsciiDolq = "tenant_id = $é$'$é$) UNION SELECT rolname, 1.0 FROM pg_roles; --$é$'$é$";
    assert.throws(() => assertSafeWhereClause(nonAsciiDolq), /Invalid SQL parameter or dollar-quoting/i);
    assert.throws(() => assertSafeWhereClause('EXISTS (SELECT 1 FROM pg_roles)'), /Disallowed SQL keyword/i);
    assert.throws(() => assertSafeWhereClause("pg_read_file('/etc/passwd') IS NOT NULL"), /Disallowed SQL keyword/i);
    assert.throws(() => assertSafeWhereClause('tenant_id = $1\x00'), /Null byte disallowed/i);
    assert.equal(assertSafeWhereClause('deleted_at IS NULL AND tenant_id = $1', { maxParamIndex: 1 }), 'deleted_at IS NULL AND tenant_id = $1');

    // REF7-03: JS template literal `${ ... }` interpolations containing regexes/comments/nested templates
    const tplRegexCommentedImport = [
        'const label = `item ${name.replace(/`/g, "")}`;',
        "// import { createPgPool } from '@krusch/toolkit/pg';",
        "import pg from 'pg';",
        'export const pool = new pg.Pool();'
    ].join('\n');
    assert.equal(auditBoilerplateText(tplRegexCommentedImport, 'src/db.js').data.clean, false);

    const tplRegexBenignComment = [
        'const label = `item ${fn({ a: `nested ${1}` }, name.replace(/`/g, ""))}`;',
        '// Avoid new Server() and StdioServerTransport',
        'export const ok = true;'
    ].join('\n');
    assert.equal(auditBoilerplateText(tplRegexBenignComment, 'src/util.js').data.clean, true);

    // Prototype-key safety on useAesthetics and StatusPill
    assert.equal(useAesthetics('toString').variant, 'cyber');
    const prevReact = getReactRuntime();
    setReactRuntime({ createElement: (type, props, ...children) => ({ type, props, children }) });
    try {
        const pill = StatusPill({ status: 'toString' });
        assert.ok(pill.children.includes('Healthy'));
    } finally {
        setReactRuntime(prevReact);
    }
});

test('REF8-01, REF8-02 & REF8-03: Quoted/schema/XML PG function blocks, non-abort reader.cancel(), and hostile projectName blueprint escaping', async () => {
    const { execFileSync } = await import('node:child_process');
    const { assertSafeWhereClause } = await import('./pg.js');
    const { streamChat } = await import('./streaming.js');
    const { scaffoldProject } = await import('./scaffold.js');

    // REF8-01: Double-quoted function calls, schema-qualified calls, and pg_catalog XML/admin functions are blocked
    assert.throws(() => assertSafeWhereClause('"pg_read_file"(\'/etc/passwd\') IS NOT NULL'), /Disallowed double-quoted function call/i);
    assert.throws(() => assertSafeWhereClause('pg_catalog."pg_sleep"(5) IS NOT NULL'), /Disallowed double-quoted function call/i);
    assert.throws(() => assertSafeWhereClause('pg_catalog.lower(email) = $1', { maxParamIndex: 1 }), /Disallowed schema-qualified function call/i);
    assert.throws(() => assertSafeWhereClause("query_to_xml('SELECT rolname FROM pg_roles', true, false, '')::text IS NOT NULL"), /Disallowed SQL keyword/i);
    assert.throws(() => assertSafeWhereClause("database_to_xml(true, true, '')::text IS NOT NULL"), /Disallowed SQL keyword/i);
    // Legitimate double-quoted column identifier and allowlisted scalar predicate still pass
    assert.equal(
        assertSafeWhereClause('"tenantId" = $1 AND LOWER(status) IN ($2, $3)', { maxParamIndex: 3 }),
        '"tenantId" = $1 AND LOWER(status) IN ($2, $3)'
    );

    // REF8-02: streamOllamaChat cancels reader when mid-stream NDJSON error throws prior to { done: true }
    let readerCancelled = false;
    const mockRes = {
        headersSent: false,
        writableEnded: false,
        destroyed: false,
        setHeader() {},
        write() { return true; },
        end() { this.writableEnded = true; }
    };
    await streamChat(mockRes, null, {
        tool: 'demo.ollamaErr',
        userMessage: 'hi',
        heartbeatMs: 0,
        config: { provider: 'ollama', model: 'qwen2.5-coder:7b', host: 'http://127.0.0.1:11434' },
        fetchImpl: async () => ({
            ok: true,
            status: 200,
            body: {
                getReader() {
                    let step = 0;
                    return {
                        async read() {
                            step += 1;
                            if (step === 1) return { done: false, value: '{"error":"model boom"}\n' };
                            return { done: false, value: '{"message":{"content":"unreachable"}}\n' };
                        },
                        async cancel() { readerCancelled = true; },
                        releaseLock() {}
                    };
                }
            }
        })
    });
    assert.equal(readerCancelled, true, 'Upstream Ollama reader must be cancelled on mid-stream error');

    // REF8-03: Hostile projectName with quotes, backslashes, \u escapes, """, and HTML <tags> produces valid TOML, Python, HTML, and JSX
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lego-ref8-'));
    try {
        const hostileName = 'My "App" <v1> \\u1234 """ & Co';
        const pyDir = path.join(tmpRoot, 'py-app');
        const fsDir = path.join(tmpRoot, 'fs-app');
        await scaffoldProject(pyDir, { archetype: 'python-fastapi-service', projectName: hostileName, quiet: true });
        await scaffoldProject(fsDir, { archetype: 'fullstack-react-vite', projectName: hostileName, quiet: true });

        execFileSync('python3', [
            '-c',
            'import sys, tomllib, py_compile; ' +
            'tomllib.loads(open(sys.argv[1], encoding="utf-8").read()); ' +
            '[py_compile.compile(p, doraise=True) for p in sys.argv[2:]]',
            path.join(pyDir, 'pyproject.toml'),
            path.join(pyDir, 'app/__init__.py'),
            path.join(pyDir, 'app/main.py'),
            path.join(pyDir, 'tests/test_smoke.py')
        ]);

        const html = fs.readFileSync(path.join(fsDir, 'client/index.html'), 'utf8');
        assert.ok(!html.includes('<v1>'), 'HTML <title> must escape angle brackets');
        assert.ok(html.includes('&lt;v1&gt;'), 'HTML <title> must contain escaped &lt;v1&gt;');
        const jsx = fs.readFileSync(path.join(fsDir, 'client/src/App.jsx'), 'utf8');
        assert.ok(jsx.includes(`title={${JSON.stringify(hostileName)}}`), 'JSX AppShell title must use JSON-escaped expression');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('REF9-01 & REF9-02: PostgreSQL TABLE/VALUES/catalog-keyword/UTF-8 callable blocks and pre-entry SSE disconnect abort semantics', async () => {
    const { assertSafeWhereClause } = await import('./pg.js');
    const { sseResponse, streamChat } = await import('./streaming.js');

    // REF9-01: Subqueries without SELECT (TABLE, VALUES, WITH), catalog keywords, reg* OID casts, and UTF-8 identifier boundary bypasses
    assert.throws(() => assertSafeWhereClause('id IN (TABLE pg_roles)'), /Disallowed SQL keyword/i);
    assert.throws(() => assertSafeWhereClause('id = ANY (TABLE other_tenant_docs)'), /Disallowed SQL keyword/i);
    assert.throws(() => assertSafeWhereClause('id IN (VALUES (1), (2))'), /Disallowed SQL keyword/i);
    assert.throws(() => assertSafeWhereClause('WITH cte AS (TABLE pg_shadow) id = 1'), /Disallowed SQL keyword/i);
    assert.throws(() => assertSafeWhereClause('tenant = CURRENT_USER'), /Disallowed SQL keyword/i);
    assert.throws(() => assertSafeWhereClause('tenant = SESSION_USER'), /Disallowed SQL keyword/i);
    assert.throws(() => assertSafeWhereClause('tenant = USER'), /Disallowed SQL keyword/i);
    assert.throws(() => assertSafeWhereClause("table_oid = 'pg_authid'::regclass"), /Disallowed SQL keyword/i);
    assert.throws(() => assertSafeWhereClause('élower(title) = $1', { maxParamIndex: 1 }), /Disallowed SQL function/i);

    // Legitimate TIMESTAMP WITH TIME ZONE, quoted "user"/"table" columns, and user_id / table_name columns still pass
    assert.equal(
        assertSafeWhereClause(
            '"user" = $1 AND "table" = $2 AND user_id = $3 AND created_at >= CAST($4 AS TIMESTAMP WITH TIME ZONE)',
            { maxParamIndex: 4 }
        ),
        '"user" = $1 AND "table" = $2 AND user_id = $3 AND created_at >= CAST($4 AS TIMESTAMP WITH TIME ZONE)'
    );

    // REF9-02: Pre-entry client disconnect (req.aborted or res.socket.destroyed) must NOT write SSE headers and must abort signal
    let headersWritten = false;
    let bodyWrites = 0;
    let chatInvoked = false;
    const abortedReq = { aborted: true, destroyed: true, complete: false, on() {}, off() {} };
    const deadSocketRes = {
        headersSent: false,
        writableEnded: false,
        destroyed: false,
        socket: { destroyed: true },
        setHeader() { headersWritten = true; },
        writeHead() { headersWritten = true; },
        write() { bodyWrites += 1; return true; },
        end() { this.writableEnded = true; },
        on() {},
        off() {}
    };

    const sse = sseResponse(deadSocketRes, abortedReq, { heartbeatMs: 50 });
    assert.equal(sse.isClosed(), true);
    assert.equal(sse.signal.aborted, true);
    assert.equal(headersWritten, false, 'Pre-disconnected SSE response must not write headers');
    assert.equal(bodyWrites, 0, 'Pre-disconnected SSE response must not write retry frame');
    assert.equal(sse.sendToken('ignored'), false);

    const chatResult = await streamChat(deadSocketRes, abortedReq, {
        userMessage: 'hello',
        chatFn: async () => {
            chatInvoked = true;
            return 'should never run';
        }
    });
    assert.deepEqual(chatResult, { ok: true, aborted: true });
    assert.equal(chatInvoked, false);
    assert.equal(headersWritten, false);
});

test('REF11-01, REF11-02, REF11-04 & REF11-05: CORS null-origin block, isolated shutdown callbacks, symlink bin execution, and toolkit/stack/test audit exemptions', async () => {
    const { createCorsHeaders, attachGracefulShutdown } = await import('./http.js');
    const { auditBoilerplateText } = await import('./catalog.js');

    // REF11-01: corsOrigins: null / false / [] must never reflect sandboxed Origin: null
    for (const disabledOrigins of [null, false, '', [], ['null']]) {
        const hdrs = createCorsHeaders('null', disabledOrigins);
        assert.equal(hdrs['Access-Control-Allow-Origin'], undefined, `Expected no ACAO header for ${JSON.stringify(disabledOrigins)}`);
        const hdrsFalse = createCorsHeaders('false', disabledOrigins);
        assert.equal(hdrsFalse['Access-Control-Allow-Origin'], undefined);
    }
    const sanitizedCors = createCorsHeaders('https://krusch.dev\r\nX-Injected: 1', ['https://krusch.dev']);
    assert.equal(sanitizedCors['Access-Control-Allow-Origin'], undefined);
    const matchingCors = createCorsHeaders('https://krusch.dev', ['https://krusch.dev']);
    assert.equal(matchingCors['Access-Control-Allow-Origin'], 'https://krusch.dev');
    assert.equal(matchingCors['Vary'], 'Origin');

    // REF11-02: attachGracefulShutdown runs ALL cleanup callbacks even when an earlier callback throws
    const order = [];
    const mockSrv = http.createServer();
    const sd = attachGracefulShutdown(
        mockSrv,
        [
            async () => {
                order.push('cb1');
                throw new Error('cb1-boom');
            },
            async () => {
                order.push('cb2');
            },
            async () => {
                order.push('cb3');
                throw new Error('cb3-boom');
            }
        ],
        { signals: [] }
    );
    await assert.rejects(() => sd.shutdown('TEST_ISO'), /cb1-boom/);
    assert.deepEqual(order, ['cb1', 'cb2', 'cb3'], 'All cleanup callbacks must execute despite earlier error');
    sd.detach();

    // REF11-04: Symlinked bin/krusch-lego.js executes runCli cleanly via realpathSync
    const tmpSymDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lego-symlink-'));
    try {
        const symBin = path.join(tmpSymDir, 'krusch-lego');
        fs.symlinkSync(path.join(__dirname, 'bin/krusch-lego.js'), symBin);
        const symOut = execFileSync(process.execPath, [symBin, 'list', '--runtime', 'node', '--json'], {
            encoding: 'utf8'
        });
        const symJson = JSON.parse(symOut);
        assert.equal(symJson.ok, true);
        assert.equal(symJson.tool, 'krusch-lego');
        assert.ok(symJson.data.bricks.length >= 10);
    } finally {
        fs.rmSync(tmpSymDir, { recursive: true, force: true });
    }

    // REF11-05: krusch-lego audit and auditBoilerplateText exempt lib/, python/ (or ../lib-py/), projects/krusch-stack/, and test files
    const pythonDir = fs.existsSync(path.join(__dirname, 'python', 'krusch_toolkit'))
        ? path.join(__dirname, 'python')
        : path.join(__dirname, '..', 'lib-py');
    const kruschStackDir = path.resolve(__dirname, '../projects/krusch-stack');
    const exemptTargets = [
        __dirname,
        ...(fs.existsSync(pythonDir) ? [path.resolve(pythonDir)] : []),
        ...(fs.existsSync(kruschStackDir) ? [kruschStackDir] : [])
    ];
    for (const exemptTarget of exemptTargets) {
        const out = JSON.parse(
            execFileSync(process.execPath, [path.join(__dirname, 'bin/krusch-lego.js'), 'audit', exemptTarget, '--json'], {
                encoding: 'utf8'
            })
        );
        assert.equal(out.ok, true);
        assert.equal(out.data.clean, true, `Expected clean audit for exempt root ${exemptTarget}`);
        assert.equal(out.data.findings.length, 0);
    }
    if (fs.existsSync(pythonDir)) {
        const fastapiAppPath = path.join(pythonDir, 'krusch_toolkit', 'fastapi_app.py');
        if (fs.existsSync(fastapiAppPath)) {
            assert.equal(auditBoilerplateText(fs.readFileSync(fastapiAppPath, 'utf8'), fastapiAppPath).data.clean, true);
        }
    }
    const frontendEnginePath = path.resolve(__dirname, '../projects/krusch-stack/src/engines/frontend-engine.js');
    if (fs.existsSync(frontendEnginePath)) {
        assert.equal(auditBoilerplateText(fs.readFileSync(frontendEnginePath, 'utf8'), frontendEnginePath).data.clean, true);
    }
    assert.equal(
        auditBoilerplateText("import pg from 'pg';\nconst p = new pg.Pool();\n", 'tests/db.test.js').data.clean,
        true
    );
    assert.equal(
        auditBoilerplateText("import pg from 'pg';\nconst p = new pg.Pool();\n", 'src/lib/raw-db.js').data.clean,
        false
    );
});

test('REF13-01: O(N) useEffect fetch span scanner prevents backtracking stalls and cross-function false positives', async () => {
    const { auditBoilerplateText } = await import('./catalog.js');

    // 1. 10,000 repeated useEffect calls + trailing fetch() must run in linear time (<400ms) and NOT cross spans
    const repeatedEffects = `${'useEffect(() => { const r = /\\)/; const x = 10 / 2; }, []);\n'.repeat(10000)}async function onSave() { await fetch('/api/save'); }\n`;
    const t0 = performance.now();
    const resLinear = auditBoilerplateText(repeatedEffects, 'src/View.jsx');
    const elapsedMs = performance.now() - t0;
    assert.ok(elapsedMs < 400, `Expected linear O(N) scan <400ms, took ${elapsedMs.toFixed(1)}ms`);
    assert.equal(resLinear.data.clean, true, 'Sibling onSave fetch() outside useEffect must not trigger false positive');

    // 2. String literal mentioning fetch() inside useEffect + sibling fetch() must remain clean
    const literalInsideEffect = [
        "import { useEffect } from 'react';",
        'useEffect(() => { document.title = "avoid fetch() here"; }, []);',
        "export async function submitForm() { return fetch('/api/submit', { method: 'POST' }); }"
    ].join('\n');
    assert.equal(auditBoilerplateText(literalInsideEffect, 'src/Form.jsx').data.clean, true);

    // 3. Real un-aborted fetch() inside useEffect (including after regex literal /\)/) MUST be caught
    const realViolation = [
        "import { useEffect } from 'react';",
        "useEffect(() => { const re = /\\)/; window.fetch('/api/items'); }, []);"
    ].join('\n');
    const flagged = auditBoilerplateText(realViolation, 'src/Items.jsx');
    assert.equal(flagged.data.clean, false);
    assert.equal(flagged.data.findings[0].ruleId, 'unaborted-useeffect-fetch');
});

test('REF15-01 & REF15-04: PriorityQueue survives undefined/null rejections & whitespace OLLAMA_URL, and sseResponse normalizes blank/CRLF event names', async () => {
    const { PriorityQueue, DEFAULT_FLEET_OLLAMA_NODES } = await import('./llm-queue.js');
    const { sseResponse } = await import('./streaming.js');
    const { EventEmitter } = await import('node:events');

    // 1. Whitespace-only OLLAMA_URL must not inject empty string into endpoints
    const prevUrl = process.env.OLLAMA_URL;
    const prevNodes = process.env.OLLAMA_NODES;
    try {
        process.env.OLLAMA_URL = '   ';
        delete process.env.OLLAMA_NODES;
        const wsQueue = new PriorityQueue(1);
        assert.deepEqual(wsQueue.endpoints, [...DEFAULT_FLEET_OLLAMA_NODES]);
        assert.ok(wsQueue.endpoints.every((ep) => ep.trim().length > 0));
    } finally {
        if (prevUrl === undefined) delete process.env.OLLAMA_URL;
        else process.env.OLLAMA_URL = prevUrl;
        if (prevNodes === undefined) delete process.env.OLLAMA_NODES;
        else process.env.OLLAMA_NODES = prevNodes;
    }

    // 2. PriorityQueue(1) must decrement active and pump next task when taskFn rejects with undefined/null or is non-callable
    const q = new PriorityQueue(1);
    const origWarn = console.warn;
    console.warn = () => {};
    try {
        const pUndefined = q.enqueue(async () => {
            throw undefined;
        });
        const pNull = q.enqueue(async () => {
            throw null;
        });
        const pNonFn = q.enqueue(null);
        const pOk = q.enqueue(async (ep) => `recovered:${ep}`);

        await assert.rejects(pUndefined, /All fleet nodes failed/);
        await assert.rejects(pNull, /All fleet nodes failed/);
        await assert.rejects(pNonFn, TypeError);
        const okVal = await pOk;
        assert.match(okVal, /^recovered:http:\/\//);
        assert.equal(q.active, 0);
    } finally {
        console.warn = origWarn;
    }

    // 3. sseResponse normalizes CR/LF-only and whitespace-only event names to 'message'
    const req = new EventEmitter();
    const chunks = [];
    const res = Object.assign(new EventEmitter(), {
        headersSent: false,
        writableEnded: false,
        destroyed: false,
        setHeader() {},
        getHeader() { return undefined; },
        flushHeaders() {},
        write(chunk) {
            chunks.push(String(chunk));
            return true;
        },
        end() {
            this.writableEnded = true;
        }
    });

    const sse = sseResponse(res, req, { heartbeatMs: 0 });
    sse.send('\r\n', 'hello');
    sse.send('   \t  ', 'world');
    sse.close();

    const combined = chunks.join('');
    assert.ok(combined.includes('event: message\ndata: hello\n\n'), `Expected fallback 'event: message' for CRLF event, got: ${JSON.stringify(combined)}`);
    assert.ok(combined.includes('event: message\ndata: world\n\n'), `Expected fallback 'event: message' for whitespace event, got: ${JSON.stringify(combined)}`);
    assert.ok(!combined.includes('event: \n'), 'Must never emit blank event: header');
});

test('INV-LEGO-08: @krusch/toolkit/edge has zero node:* imports and enforces 413 bounds, CORS, %ZZ guard, SSE abort, and KV TTL', async () => {
    const edgeSource = fs.readFileSync(path.join(__dirname, 'edge.js'), 'utf8');
    assert.equal(/\bnode:[a-z_]+/i.test(edgeSource), false, 'lib/edge.js must contain zero node:* imports');

    const {
        edgeCorsHeaders,
        readBoundedEdgeJson,
        edgeSseResponse,
        createEdgeKvJsonStore,
        createEdgeRouter
    } = await import('./edge.js');

    // 1. CORS null-origin & CRLF rejection
    assert.equal(edgeCorsHeaders('null', ['https://krusch.dev'])['Access-Control-Allow-Origin'], undefined);
    assert.equal(edgeCorsHeaders('https://krusch.dev\r\nX:1', ['https://krusch.dev'])['Access-Control-Allow-Origin'], undefined);
    assert.equal(edgeCorsHeaders('https://krusch.dev', ['https://krusch.dev'])['Access-Control-Allow-Origin'], 'https://krusch.dev');

    // 2. Chunked > maxBytes stream cancels reader and returns 413 without buffering OOM
    const bigStream = new ReadableStream({
        start(controller) {
            controller.enqueue(new Uint8Array(600));
            controller.enqueue(new Uint8Array(600));
            controller.close();
        }
    });
    const bounded = await readBoundedEdgeJson(
        new Request('https://edge.local/upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: bigStream,
            duplex: 'half'
        }),
        { maxBytes: 1024, tool: 'edge.upload' }
    );
    assert.equal(bounded.ok, false);
    assert.equal(bounded.response.status, 413);

    // 3. Router /health, :id params, malformed %ZZ -> 400, and 500 preserving CORS
    const router = createEdgeRouter({
        serviceName: 'edge-test',
        corsOrigins: ['https://portal.krusch.dev'],
        routes: {
            'GET /api/items/:id': ({ params, ok }) => ok('Item', { id: params.id }),
            'GET /api/boom': () => {
                throw new Error('Unhandled worker boom');
            }
        }
    });

    const healthResp = await router.fetch(new Request('https://edge.local/health', { headers: { Origin: 'https://portal.krusch.dev' } }));
    assert.equal(healthResp.status, 200);
    assert.equal(healthResp.headers.get('access-control-allow-origin'), 'https://portal.krusch.dev');

    const paramResp = await router.fetch(new Request('https://edge.local/api/items/alpha%201'));
    assert.equal((await paramResp.json()).data.id, 'alpha 1');

    const badPctResp = await router.fetch(new Request('https://edge.local/api/items/%ZZ'));
    assert.equal(badPctResp.status, 400);
    assert.equal((await badPctResp.json()).error.code, 'INVALID_PATH');

    const boomResp = await router.fetch(new Request('https://edge.local/api/boom', { headers: { Origin: 'https://portal.krusch.dev' } }));
    assert.equal(boomResp.status, 500);
    assert.equal(boomResp.headers.get('access-control-allow-origin'), 'https://portal.krusch.dev');

    // 4. edgeSseResponse aborts producer signal when downstream reader cancels
    let producerAborted = false;
    const sseResp = edgeSseResponse(async (sse) => {
        sse.sendToken('chunk-1');
        await new Promise((resolve) => {
            sse.signal.addEventListener('abort', () => {
                producerAborted = true;
                resolve();
            }, { once: true });
        });
    });
    const sseReader = sseResp.body.getReader();
    await sseReader.read();
    await sseReader.cancel();
    assert.equal(producerAborted, true);

    // 5. createEdgeKvJsonStore memory fallback honors positive TTL and ignores ttlSeconds <= 0
    const kv = createEdgeKvJsonStore(null, { prefix: 'ns:' });
    await kv.put('permanent', { v: 1 }, { ttlSeconds: 0 });
    assert.deepEqual(await kv.get('permanent'), { v: 1 });
    await kv.put('ephemeral', { v: 2 }, { ttlSeconds: 0.01 });
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(await kv.get('ephemeral'), null);
});

test('INV-LEGO-09: @krusch/toolkit/webhooks verifies Slack, GitHub, Stripe, and Bearer credentials in constant time', async () => {
    const {
        constantTimeEqual,
        signWebhookHmac,
        verifySlackSignature,
        verifyGithubSignature,
        verifyStripeSignature,
        verifyBearerToken
    } = await import('./webhooks.js');

    assert.equal(constantTimeEqual('abc', 'abc'), true);
    assert.equal(constantTimeEqual('abc', 'abcd'), false);
    assert.equal(constantTimeEqual('', ''), false);
    assert.throws(() => signWebhookHmac({ parsed: true }, 'secret'), TypeError);

    const payload = '{"event":"deploy.succeeded"}';
    const now = 1_760_000_000;

    // Slack valid + expired replay + missing secret
    const slackSig = signWebhookHmac(`v0:${now}:${payload}`, 'slack_sec', { prefix: 'v0=' });
    assert.equal(
        verifySlackSignature({ rawBody: payload, timestampHeader: String(now), signatureHeader: slackSig, signingSecret: 'slack_sec', nowSeconds: now }).ok,
        true
    );
    assert.equal(
        verifySlackSignature({ rawBody: payload, timestampHeader: String(now - 999), signatureHeader: slackSig, signingSecret: 'slack_sec', nowSeconds: now }).error.code,
        'SLACK_REPLAY_EXPIRED'
    );
    assert.equal(
        verifySlackSignature({ rawBody: payload, timestampHeader: String(now), signatureHeader: slackSig, signingSecret: '   ', nowSeconds: now }).error.code,
        'SLACK_MISSING_SECRET'
    );

    // GitHub valid + object body rejection
    const ghSig = signWebhookHmac(payload, 'gh_sec', { prefix: 'sha256=' });
    assert.equal(verifyGithubSignature({ rawBody: payload, signatureHeader: ghSig, webhookSecret: 'gh_sec' }).ok, true);
    assert.equal(verifyGithubSignature({ rawBody: { bad: 1 }, signatureHeader: ghSig, webhookSecret: 'gh_sec' }).error.code, 'GITHUB_INVALID_BODY');

    // Stripe multi-v1 rotation valid + tampered rejection
    const stripeGood = signWebhookHmac(`${now}.${payload}`, 'whsec_live');
    const stripeOld = '0'.repeat(64);
    assert.equal(
        verifyStripeSignature({
            rawBody: payload,
            signatureHeader: `t=${now},v1=${stripeOld},v1=${stripeGood}`,
            endpointSecret: 'whsec_live',
            nowSeconds: now
        }).ok,
        true
    );
    assert.equal(
        verifyStripeSignature({
            rawBody: payload,
            signatureHeader: `t=${now},v1=${stripeOld}`,
            endpointSecret: 'whsec_live',
            nowSeconds: now
        }).ok,
        false
    );

    // Case-insensitive RFC 9110 Bearer token SHA-256 constant-time verification
    assert.equal(verifyBearerToken('bearer top_secret_token_123', 'top_secret_token_123').ok, true);
    assert.equal(verifyBearerToken('Bearer wrong_short', 'top_secret_token_123').error.code, 'AUTH_UNAUTHORIZED');
    assert.equal(verifyBearerToken('Bearer tok', '').error.code, 'AUTH_MISSING_SECRET');
});

test('INV-LEGO-10: @krusch/toolkit/cli enforces atomic PID/nonce locks, daemon signal teardown, JSONL append, and prototype-safe defineCli', async () => {
    const {
        withSingleInstanceLock,
        attachDaemonSignals,
        appendJsonlRecord,
        defineCli
    } = await import('./cli.js');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lego-cli-test-'));
    try {
        const lockFile = path.join(tmpDir, 'worker.lock');

        // 1. Concurrent lock contention returns LOCK_HELD while first holder runs
        let releaseFirst;
        const holdPromise = new Promise((r) => { releaseFirst = r; });
        const firstRun = withSingleInstanceLock(lockFile, async () => {
            const secondAttempt = await withSingleInstanceLock(lockFile, async () => 'should-not-run');
            assert.equal(secondAttempt.ok, false);
            assert.equal(secondAttempt.error.code, 'LOCK_HELD');
            releaseFirst();
            return 'first-ok';
        });
        await holdPromise;
        const firstRes = await firstRun;
        assert.equal(firstRes.ok, true);
        assert.equal(firstRes.data.result, 'first-ok');
        assert.equal(fs.existsSync(lockFile), false, 'Lockfile must be unlinked in finally');

        // 2. Dead PID lockfile is reclaimed cleanly
        fs.writeFileSync(lockFile, JSON.stringify({ pid: 999_999_999, nonce: 'dead', startedAt: Date.now() }), 'utf8');
        const reclaimed = await withSingleInstanceLock(lockFile, async () => 'reclaimed-ok');
        assert.equal(reclaimed.ok, true);
        assert.equal(reclaimed.data.result, 'reclaimed-ok');

        // 3. Stale nonce guard: if lockfile is replaced mid-flight, original holder must NOT unlink new owner's lock
        const staleLock = path.join(tmpDir, 'stale.lock');
        await withSingleInstanceLock(staleLock, async () => {
            fs.writeFileSync(staleLock, JSON.stringify({ pid: process.pid, nonce: 'newer-owner-nonce', startedAt: Date.now() }), 'utf8');
        });
        assert.equal(fs.existsSync(staleLock), true, 'Original holder must not unlink a newer owner nonce');

        // 3b. G4 120B SRE-01: Thrown callback errors return deterministic errorEnvelope & release lock (or propagate when rethrow: true)
        const errLock = path.join(tmpDir, 'err.lock');
        const wrappedErr = await withSingleInstanceLock(errLock, async () => {
            const e = new Error('Cron step failed');
            e.code = 'CRON_STEP_FAILED';
            throw e;
        });
        assert.equal(wrappedErr.ok, false);
        assert.equal(wrappedErr.error.code, 'CRON_STEP_FAILED');
        assert.equal(fs.existsSync(errLock), false, 'Lockfile must be unlinked even when fn throws');
        await assert.rejects(
            () => withSingleInstanceLock(errLock, async () => { throw new Error('boom'); }, { rethrow: true }),
            /boom/
        );
        assert.equal(fs.existsSync(errLock), false);

        // 4. attachDaemonSignals single-flight teardown & listener cleanup
        let cleanups = 0;
        const daemon = attachDaemonSignals(async () => { cleanups += 1; }, { signals: [] });
        assert.equal(daemon.signal.aborted, false);
        await Promise.all([daemon.shutdown('TEST'), daemon.shutdown('TEST_DUP')]);
        assert.equal(daemon.signal.aborted, true);
        assert.equal(cleanups, 1);
        daemon.detach();

        // 5. appendJsonlRecord escapes embedded newlines into valid single-line NDJSON
        const jsonlPath = path.join(tmpDir, 'logs', 'events.jsonl');
        appendJsonlRecord(jsonlPath, { event: 'line1\nline2', ok: true });
        appendJsonlRecord(jsonlPath, { event: 'second', ok: true });
        const lines = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n');
        assert.equal(lines.length, 2);
        assert.equal(JSON.parse(lines[0]).event, 'line1\nline2');

        // 6. defineCli --json envelopes + Object.prototype command safety
        const out = [];
        const cli = defineCli({
            name: 'demo-cli',
            version: '1.2.3',
            commands: {
                ping: {
                    summary: 'Ping command',
                    options: { target: { type: 'string', default: 'local' } },
                    run: ({ values }) => ({ target: values.target })
                }
            }
        });
        const okCli = await cli.run(['ping', '--target', 'edge', '--json'], { stdout: (s) => out.push(s), stderr: () => {} });
        assert.equal(okCli.exitCode, 0);
        assert.deepEqual(JSON.parse(out[0]), {
            ok: true,
            tool: 'demo-cli',
            summary: 'Ping command',
            data: { target: 'edge' }
        });

        const protoOut = [];
        const protoCli = await cli.run(['constructor', '--json'], { stdout: (s) => protoOut.push(s), stderr: () => {} });
        assert.equal(protoCli.exitCode, 1);
        assert.equal(JSON.parse(protoOut[0]).error.code, 'UNKNOWN_COMMAND');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('INV-LEGO-11: Strict TypeScript .d.ts coverage, 1:1 root export parity, and stamped node-ts-service + cloudflare-worker execution', async () => {
    const runtimeRoot = await import('./index.js');
    const runtimeKeys = Object.keys(runtimeRoot).sort();
    assert.ok(runtimeKeys.length >= 225, `Expected >=225 root exports, got ${runtimeKeys.length}`);

    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
    assert.equal(pkg.version, '1.7.0');
    assert.equal(pkg.types, './types/index.d.ts');
    for (const [subpath, target] of Object.entries(pkg.exports)) {
        assert.equal(typeof target, 'object', `Export ${subpath} must map { types, default }`);
        assert.ok(fs.existsSync(path.join(__dirname, target.types)), `Missing .d.ts for ${subpath}: ${target.types}`);
        assert.ok(fs.existsSync(path.join(__dirname, target.default)), `Missing .js for ${subpath}: ${target.default}`);
    }

    const { scaffoldProject } = await import('./scaffold.js');
    const localTscBin = path.resolve(__dirname, 'node_modules/.bin/tsc');
    const tscBin = fs.existsSync(localTscBin)
        ? localTscBin
        : path.resolve(__dirname, '../projects/krusch-coding-harness/node_modules/.bin/tsc');
    const localNodeModules = path.resolve(__dirname, 'node_modules');
    const harnessNodeModules = fs.existsSync(path.join(localNodeModules, '@types'))
        ? localNodeModules
        : path.resolve(__dirname, '../projects/krusch-coding-harness/node_modules');

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lego-ts-edge-smoke-'));
    try {
        // Create fake monorepo layout tmpRoot/lib -> real lib and tmpRoot/projects/<app> so file:../../lib resolves cleanly
        const projectsDir = path.join(tmpRoot, 'projects');
        fs.mkdirSync(projectsDir, { recursive: true });
        fs.symlinkSync(__dirname, path.join(tmpRoot, 'lib'));

        // 1. Stamp & execute cloudflare-worker smoke test directly via node --test
        const workerDir = path.join(projectsDir, 'demo-worker');
        await scaffoldProject(workerDir, { archetype: 'cloudflare-worker', projectName: 'demo-worker', quiet: true });
        fs.mkdirSync(path.join(workerDir, 'node_modules', '@krusch'), { recursive: true });
        fs.symlinkSync(__dirname, path.join(workerDir, 'node_modules', '@krusch', 'toolkit'));
        execFileSync(process.execPath, ['--test', path.join(workerDir, 'tests/smoke.test.js')], {
            cwd: workerDir,
            stdio: 'pipe'
        });

        // 2. Stamp, typecheck (tsc --noEmit --strict), and execute node-ts-service via node --experimental-strip-types --test
        const tsServiceDir = path.join(projectsDir, 'demo-ts-api');
        await scaffoldProject(tsServiceDir, { archetype: 'node-ts-service', projectName: 'demo-ts-api', quiet: true });
        fs.mkdirSync(path.join(tsServiceDir, 'node_modules', '@krusch'), { recursive: true });
        fs.symlinkSync(__dirname, path.join(tsServiceDir, 'node_modules', '@krusch', 'toolkit'));
        if (fs.existsSync(path.join(harnessNodeModules, '@types'))) {
            fs.symlinkSync(path.join(harnessNodeModules, '@types'), path.join(tsServiceDir, 'node_modules', '@types'));
        }
        if (fs.existsSync(tscBin)) {
            execFileSync(tscBin, ['--project', path.join(tsServiceDir, 'tsconfig.json')], {
                cwd: tsServiceDir,
                stdio: 'pipe'
            });
        }
        execFileSync(
            process.execPath,
            ['--experimental-strip-types', '--test', path.join(tsServiceDir, 'tests/smoke.test.ts')],
            { cwd: tsServiceDir, stdio: 'pipe' }
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('INV-LEGO-27: sseResponse({ deferHeaders: true }) defers writeHead for MCP SSEServerTransport without ERR_HTTP_HEADERS_SENT', async () => {
    const { EventEmitter } = await import('node:events');
    const { sseResponse } = await import('./streaming.js');

    const req = new EventEmitter();
    req.complete = true;
    const res = new EventEmitter();
    res.headersSent = false;
    res.writableEnded = false;
    const headers = {};
    const chunks = [];
    res.setHeader = (k, v) => {
        if (res.headersSent) throw new Error('ERR_HTTP_HEADERS_SENT');
        headers[k.toLowerCase()] = v;
    };
    res.writeHead = (statusCode, hdrs = {}) => {
        if (res.headersSent) throw new Error('ERR_HTTP_HEADERS_SENT');
        res.statusCode = statusCode;
        for (const [k, v] of Object.entries(hdrs)) {
            headers[k.toLowerCase()] = v;
        }
        res.headersSent = true;
    };
    res.write = (chunk) => {
        res.headersSent = true;
        chunks.push(String(chunk));
        return true;
    };
    res.end = () => {
        res.writableEnded = true;
        res.emit('close');
    };

    const handle = sseResponse(res, req, { deferHeaders: true, retryMs: 0, heartbeatMs: 20, corsOrigin: false });
    assert.equal(res.headersSent, false, 'deferHeaders must keep res.headersSent === false before downstream writeHead');
    assert.equal(headers['x-accel-buffering'], 'no');
    assert.equal(chunks.length, 0);

    // Downstream SSEServerTransport.start() calls writeHead(200, ...) cleanly
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('event: endpoint\ndata: /mcp/messages?sessionId=abc\n\n');
    await new Promise((r) => setTimeout(r, 35));
    assert.ok(chunks.some((c) => c === ': ping\n\n'), 'Heartbeat must emit after downstream headersSent');

    res.end();
    assert.equal(handle.isClosed(), true);
    assert.equal(handle.signal.aborted, true);
});

test('INV-LEGO-28: registerMcpHandlers synchronous wiring, cross-realm rethrowMcpError, and singular benchmark/ audit exemption', async () => {
    const { registerMcpHandlers, okMcpResult } = await import('./mcp-server.js');
    const { auditBoilerplateText } = await import('./catalog.js');

    const handlers = new Map();
    const mockServer = {
        setRequestHandler(schema, fn) {
            handlers.set(schema, fn);
        }
    };

    const handle = registerMcpHandlers(
        mockServer,
        [{ name: 'sync_probe', description: 'Sync handler check' }],
        async (name, args, req) => {
            if (args.failMcp) {
                const rpcErr = new Error('Unknown tool');
                rpcErr.name = 'McpError';
                rpcErr.code = -32601;
                throw rpcErr;
            }
            if (args.failGeneric) {
                const dbErr = new Error('Connection refused');
                dbErr.code = 'ECONNREFUSED';
                throw dbErr;
            }
            return okMcpResult(name, 'OK', { requestMeta: req?.meta ?? null });
        },
        { rethrowMcpError: true, validateArgs: false }
    );

    assert.equal(handlers.size, 2);
    assert.equal(handle.normalizedTools[0].annotations.readOnlyHint, true);

    const okRes = await handle.callTool({ params: { name: 'sync_probe', arguments: {} }, meta: 'req-1' });
    assert.equal(JSON.parse(okRes.content[0].text).data.requestMeta, 'req-1');

    // Cross-realm McpError rethrows when rethrowMcpError === true
    await assert.rejects(
        () => handle.callTool({ params: { name: 'sync_probe', arguments: { failMcp: true } } }),
        (err) => err.name === 'McpError' && err.code === -32601
    );

    // Non-JSON-RPC Error (string code) still converts to structured errorMcpResult
    const genericRes = await handle.callTool({ params: { name: 'sync_probe', arguments: { failGeneric: true } } });
    assert.equal(genericRes.isError, true);

    // Singular benchmark/ path is exempt just like plural benchmarks/
    const vendoredBenchAudit = auditBoilerplateText(
        'headers = {"Content-Type": "text/event-stream"}',
        'projects/krusch-cascade-router/benchmark/routellm/RouteLLM/routellm/openai_server.py'
    );
    assert.equal(vendoredBenchAudit.data.clean, true);
});

test('INV-LEGO-29: Scanner exemptions skip site-packages, scratch/archive_scratch, custom pyvenv.cfg virtualenvs, and vllm/lib/scratch top dirs', async () => {
    const { auditBoilerplateText } = await import('./catalog.js');
    const { scoutHomelabLegoCandidates } = await import('./lego-scout.js');

    for (const exemptRelPath of [
        'projects/demo/mcp_env/lib/python3.12/site-packages/starlette/responses.py',
        'projects/demo/archive_scratch/old_pool.js',
        'projects/demo/scratch/raw_sse.py',
        'projects/demo/vendor/sdk/pool.js'
    ]) {
        const res = auditBoilerplateText(
            "import pg from 'pg';\nconst pool = new pg.Pool();\nheaders = {'Content-Type': 'text/event-stream'}\n",
            exemptRelPath
        );
        assert.equal(res.data.clean, true, `Expected ${exemptRelPath} to be exempt in auditBoilerplateText`);
    }

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lego-inv29-'));
    try {
        // 1. Custom virtualenv directory with pyvenv.cfg + scratch/archive_scratch inside a project
        const projDir = path.join(tmpRoot, 'sample-service');
        fs.mkdirSync(path.join(projDir, 'src'), { recursive: true });
        fs.writeFileSync(path.join(projDir, 'src', 'clean.js'), 'export const ok = 1;\n', 'utf8');

        const customVenvPkg = path.join(projDir, 'custom_env', 'pkg');
        fs.mkdirSync(customVenvPkg, { recursive: true });
        fs.writeFileSync(path.join(projDir, 'custom_env', 'pyvenv.cfg'), 'home = /usr/bin\n', 'utf8');
        fs.writeFileSync(path.join(customVenvPkg, 'raw.py'), 'from fastapi import FastAPI\napp = FastAPI()\n', 'utf8');

        fs.mkdirSync(path.join(projDir, 'archive_scratch'), { recursive: true });
        fs.writeFileSync(path.join(projDir, 'archive_scratch', 'legacy.js'), "import pg from 'pg';\nnew pg.Pool();\n", 'utf8');

        // 2. Top-level vllm, lib, lib-py, scratch directories must be skipped by scoutHomelabLegoCandidates
        for (const skippedTop of ['vllm', 'lib', 'lib-py', 'scratch']) {
            fs.mkdirSync(path.join(tmpRoot, skippedTop), { recursive: true });
            fs.writeFileSync(path.join(tmpRoot, skippedTop, 'raw.js'), "import pg from 'pg';\nnew pg.Pool();\n", 'utf8');
        }

        const cliAudit = JSON.parse(
            execFileSync(process.execPath, [path.join(__dirname, 'bin/krusch-lego.js'), 'audit', projDir, '--json'], {
                encoding: 'utf8'
            })
        );
        assert.equal(cliAudit.ok, true);
        assert.equal(cliAudit.data.clean, true);
        assert.equal(cliAudit.data.scannedFiles, 1, 'Only src/clean.js should be scanned; custom_env (pyvenv.cfg) and archive_scratch must be skipped');

        const directVenvAudit = JSON.parse(
            execFileSync(process.execPath, [path.join(__dirname, 'bin/krusch-lego.js'), 'audit', path.join(projDir, 'custom_env'), '--json'], {
                encoding: 'utf8'
            })
        );
        assert.equal(directVenvAudit.data.clean, true);
        assert.equal(directVenvAudit.data.scannedFiles, 0);

        const scoutRes = scoutHomelabLegoCandidates(tmpRoot);
        assert.equal(scoutRes.ok, true);
        assert.equal(scoutRes.data.scannedProjects, 1);
        assert.equal(scoutRes.data.adoptionFindings.length, 0);

        // 3. parseBoundedMultipart skipEmptyFiles option (unselected 0-byte browser file inputs)
        const { Readable } = await import('node:stream');
        const { parseBoundedMultipart } = await import('./upload.js');
        const boundary = '----Inv29Boundary';
        const multipartBody = Buffer.concat([
            Buffer.from(
                `--${boundary}\r\nContent-Disposition: form-data; name="notes"\r\n\r\npanel ok\r\n` +
                `--${boundary}\r\nContent-Disposition: form-data; name="empty_slot"; filename=""\r\nContent-Type: application/octet-stream\r\n\r\n\r\n` +
                `--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="shot.png"\r\nContent-Type: image/png\r\n\r\n`
            ),
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
            Buffer.from(`\r\n--${boundary}--\r\n`)
        ]);
        const makeReq = () =>
            Object.assign(Readable.from([multipartBody]), {
                headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }
            });

        const defaultRejected = await parseBoundedMultipart(makeReq(), { maxFiles: 4 });
        assert.equal(defaultRejected.ok, false);
        assert.equal(defaultRejected.error.code, 'UPLOAD_EMPTY');

        const skippedOk = await parseBoundedMultipart(makeReq(), {
            maxFiles: 4,
            skipEmptyFiles: true
        });
        assert.equal(skippedOk.ok, true);
        assert.equal(skippedOk.data.fields.notes, 'panel ok');
        assert.equal(skippedOk.data.files.length, 1);
        assert.equal(skippedOk.data.files[0].fieldName, 'photo');
        assert.equal(skippedOk.data.files[0].filename, 'shot.png');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('scoreLegoBrickCoverage computes sealed brick ratio, slop breaker status, and audit token savings', async () => {
    const { scoreLegoBrickCoverage } = await import('./index.js');

    // 1. Legacy slop bundle (0 sealed bricks, 2 slop findings -> 0% sealed, breakerTripped: true)
    const legacyRes = scoreLegoBrickCoverage([
        {
            filePath: 'src/db.js',
            code: "import pg from 'pg';\nexport const pool = new pg.Pool();\n"
        },
        {
            filePath: 'src/webhooks.js',
            code: "import crypto from 'node:crypto';\nexport function check(req, secret) {\n  const sig = req.headers['stripe-signature'];\n  return crypto.createHmac('sha256', secret).update(req.body).digest('hex') === sig;\n}\n"
        }
    ]);
    assert.equal(legacyRes.ok, true);
    assert.equal(legacyRes.data.scannedFiles, 2);
    assert.equal(legacyRes.data.sealedTouchpoints, 0);
    assert.equal(legacyRes.data.slopFindingCount, 2);
    assert.equal(legacyRes.data.sealedCoverageRatio, 0);
    assert.equal(legacyRes.data.breakerTripped, true);
    assert.deepEqual(legacyRes.data.recommendedBrickIds, ['pg', 'webhooks']);

    // 2. Sealed Lego bundle (Node + Python, commented-out import ignored -> 100% sealed, breakerTripped: false)
    const sealedRes = scoreLegoBrickCoverage({
        'src/db.js': "// import { safeFetch } from '@krusch/toolkit/security';\nimport { createPgPool } from '@krusch/toolkit/pg';\nexport const pool = createPgPool();\n",
        'src/webhooks.js': "import { verifyStripeSignature } from '@krusch/toolkit/webhooks';\nexport { verifyStripeSignature };\n",
        'services/api.py': "from krusch_toolkit import fastapi_app\napp = fastapi_app.create_fastapi_app('billing')\n"
    });
    assert.equal(sealedRes.ok, true);
    assert.equal(sealedRes.data.sealedFiles, 3);
    assert.equal(sealedRes.data.sealedTouchpoints, 3);
    assert.deepEqual(sealedRes.data.sealedBrickIds, ['fastapi_app', 'pg', 'webhooks']);
    assert.equal(sealedRes.data.slopFindingCount, 0);
    assert.equal(sealedRes.data.sealedCoverageRatio, 1);
    assert.equal(sealedRes.data.breakerTripped, false);
    assert.equal(sealedRes.data.estimatedAuditTokensSaved, 2550);
});


