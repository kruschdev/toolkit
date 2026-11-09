import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import {
  HydraDbClient,
  createHydraDbClient,
  verifyHydraWebhookSignature,
  buildHydraContextString,
  DEFAULT_HYDRADB_BASE_URL,
  HYDRADB_API_VERSION,
} from './hydradb.js';
import {
  KruschGitClient,
  createKruschGitClient,
  DEFAULT_KRUSCH_GIT_URL,
} from './krusch-git.js';

function startMockHydraServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((res) => server.close(res)),
      });
    });
  });
}

test('HydraDB webhook signature verification (constant-time HMAC-SHA256)', () => {
  const secret = 'hydra_whsec_test_secret_123';
  const rawBody = JSON.stringify({
    event: 'context.indexed',
    database: 'krusch_context',
    ids: ['mem-101'],
  });
  const validHex = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

  const okRes = verifyHydraWebhookSignature(rawBody, `sha256=${validHex}`, secret);
  assert.equal(okRes.ok, true);
  assert.equal(okRes.data.verified, true);

  const tamperedRes = verifyHydraWebhookSignature(
    rawBody,
    `sha256=${validHex.slice(0, -1)}${validHex.endsWith('a') ? 'b' : 'a'}`,
    secret
  );
  assert.equal(tamperedRes.ok, false);
  assert.equal(tamperedRes.error.code, 'HYDRADB_WEBHOOK_SIGNATURE_MISMATCH');

  const missingSecretRes = verifyHydraWebhookSignature(rawBody, `sha256=${validHex}`, '');
  assert.equal(missingSecretRes.ok, false);
  assert.equal(missingSecretRes.error.code, 'HYDRADB_WEBHOOK_SECRET_MISSING');
});

test('HydraDbClient v2 headers, database readiness, multipart ingest, query & feedback', async () => {
  const recordedRequests = [];
  let statusPollCount = 0;
  let transientAttempt = 0;

  const mock = await startMockHydraServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const bodyStr = Buffer.concat(chunks).toString('utf8');
      recordedRequests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: bodyStr,
      });

      res.setHeader('Content-Type', 'application/json');
      res.setHeader('X-Request-ID', 'req_hydra_test_001');

      if (req.url === '/databases' && req.method === 'POST') {
        res.end(
          JSON.stringify({
            success: true,
            data: { database: 'krusch_context', created: true },
            error: null,
            meta: { request_id: 'req_db_create', latency_ms: 4.2 },
          })
        );
        return;
      }

      if (req.url.startsWith('/databases/status')) {
        statusPollCount += 1;
        res.end(
          JSON.stringify({
            success: true,
            data: {
              database: 'krusch_context',
              infra: { ready_for_ingestion: statusPollCount >= 2 },
            },
            error: null,
            meta: { request_id: 'req_db_status', latency_ms: 2.1 },
          })
        );
        return;
      }

      if (req.url === '/context/ingest' && req.method === 'POST') {
        res.end(
          JSON.stringify({
            success: true,
            data: {
              accepted: true,
              ids: ['mem-1', 'mem-2'],
              status: 'queued',
            },
            error: null,
            meta: { request_id: 'req_ingest_01', latency_ms: 11.4 },
          })
        );
        return;
      }

      if (req.url.startsWith('/context/status')) {
        if (req.url.includes('missing-scope-id')) {
          res.end(
            JSON.stringify({
              success: true,
              data: {
                items: [
                  {
                    id: 'missing-scope-id',
                    status: 'errored',
                    error_code: 'FILE_NOT_FOUND',
                  },
                ],
              },
              error: null,
              meta: { request_id: 'req_status_miss', latency_ms: 1.8 },
            })
          );
          return;
        }
        res.end(
          JSON.stringify({
            success: true,
            data: {
              items: [
                { id: 'mem-1', status: 'graph_creation' },
                { id: 'mem-2', status: 'completed' },
              ],
            },
            error: null,
            meta: { request_id: 'req_status_ok', latency_ms: 3.1 },
          })
        );
        return;
      }

      if (req.url === '/query' && req.method === 'POST') {
        if (transientAttempt === 0) {
          transientAttempt += 1;
          res.statusCode = 503;
          res.end(
            JSON.stringify({
              success: false,
              data: null,
              error: { code: 'SERVICE_UNAVAILABLE', message: 'Transient overload' },
            })
          );
          return;
        }
        res.end(
          JSON.stringify({
            success: true,
            data: {
              chunks: [
                {
                  id: 'chk-1',
                  source_id: 'mem-2',
                  title: 'INV-12 Drift Guard',
                  score: 0.942,
                  text: 'Distinguish SHA-256 content fingerprints from architectural invariants.',
                },
              ],
              sources: [{ id: 'mem-2', title: 'INV-12 Drift Guard' }],
              graph_context: {
                query_paths: ['mem-2 --[SUPERSEDES]--> mem-1'],
                chunk_relations: [
                  {
                    source: 'fee-engine.js',
                    relation: 'CALLS',
                    target: 'sox-reconciler.js',
                  },
                ],
              },
              additional_context: { project: 'krusch-context-mcp' },
            },
            error: null,
            meta: { request_id: 'req_query_99', latency_ms: 18.7 },
          })
        );
        return;
      }

      if (req.url === '/feedback' && req.method === 'POST') {
        res.statusCode = 500;
        res.end(JSON.stringify({ success: false, error: 'Simulated telemetry fault' }));
        return;
      }

      res.end(JSON.stringify({ success: true, data: { ok: true }, error: null }));
    });
  });

  try {
    assert.equal(DEFAULT_HYDRADB_BASE_URL, 'https://api.hydradb.com');
    assert.equal(HYDRADB_API_VERSION, '2');

    const client = createHydraDbClient({
      apiKey: 'hydra_live_test_key',
      baseUrl: mock.baseUrl,
      database: 'krusch_context',
      collection: 'homelab',
      retryDelayMs: 10,
    });
    assert.ok(client instanceof HydraDbClient);
    assert.equal(client.isConfigured(), true);

    const dbCreated = await client.createDatabase({
      metadataSchema: { category: 'string', project: 'string' },
    });
    assert.equal(dbCreated.created, true);
    assert.equal(recordedRequests[0].headers['api-version'], '2');
    assert.equal(recordedRequests[0].headers.authorization, 'Bearer hydra_live_test_key');

    const readyState = await client.waitForDatabaseReady({ pollIntervalMs: 10 });
    assert.equal(readyState.infra.ready_for_ingestion, true);

    const ingestMemRes = await client.ingestMemories([
      {
        id: 'mem-1',
        title: 'Initial Decision',
        text: 'Use SQLite WAL as local primary store.',
        metadata: { category: 'decision' },
      },
    ]);
    assert.equal(ingestMemRes.accepted, true);

    const ingestKnowRes = await client.ingestAppKnowledge([
      {
        id: 'mem-2',
        title: 'Superseding Decision',
        text: 'Mirror SQLite WAL to HydraDB v2 with explicit superseding relations.',
        relations: { ids: ['mem-1'], properties: { edge: 'SUPERSEDES' } },
      },
    ]);
    assert.equal(ingestKnowRes.accepted, true);

    const indexedReport = await client.waitForIndexing({
      ids: ['mem-1', 'mem-2'],
      pollIntervalMs: 10,
    });
    assert.equal(indexedReport.scopeMissDetected, false);

    await assert.rejects(
      () =>
        client.waitForIndexing({
          ids: ['missing-scope-id'],
          pollIntervalMs: 10,
        }),
      (err) => err.code === 'FILE_NOT_FOUND'
    );

    const queryRes = await client.queryContext({
      query: 'How does INV-12 handle superseding lineage?',
      mode: 'thinking',
      graphContext: true,
      queryForcefulRelations: true,
    });
    assert.equal(queryRes.chunks.length, 1);
    assert.equal(queryRes._meta.request_id, 'req_query_99');
    assert.match(queryRes.contextString, /INV-12 Drift Guard/);
    assert.match(queryRes.contextString, /SUPERSEDES/);
    assert.match(queryRes.contextString, /sox-reconciler\.js/);

    const formatted = buildHydraContextString(queryRes);
    assert.match(formatted, /Knowledge Graph Context/);

    // Feedback is strictly non-throwing even on HTTP 500
    const fbRes = await client.submitFeedback({
      requestId: 'req_query_99',
      rating: 'positive',
      feedback: 'Graph relation path resolved superseding decision accurately.',
    });
    assert.equal(fbRes.submitted, false);
    assert.match(fbRes.error, /500/);
  } finally {
    await mock.close();
  }
});

test('KruschGitClient REST wrapper: health, repos, code search, symbols, and dependency graph', async () => {
  const requests = [];
  const mock = await startMockHydraServer((req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    res.setHeader('Content-Type', 'application/json');

    if (req.url === '/api/health') {
      res.end(JSON.stringify({ status: 'ok', service: 'krusch-git' }));
      return;
    }
    if (req.url === '/api/repos' && req.method === 'GET') {
      res.end(JSON.stringify([{ id: 1, name: 'krusch-stack' }]));
      return;
    }
    if (req.url.startsWith('/api/search')) {
      res.end(
        JSON.stringify([
          {
            id: 'sha_blob_1',
            file_path: 'src/fee-engine.js',
            summary: 'Calculates deterministic ledger fees',
            rrf_score: 0.032,
          },
        ])
      );
      return;
    }
    if (req.url.startsWith('/api/symbols')) {
      res.end(
        JSON.stringify([
          {
            symbol_name: 'calculateLedgerFee',
            symbol_type: 'function',
            file_path: 'src/fee-engine.js',
            start_line: 10,
            end_line: 42,
          },
        ])
      );
      return;
    }
    if (req.url.startsWith('/api/graph')) {
      res.end(
        JSON.stringify({
          filePath: 'src/fee-engine.js',
          repositoryId: 1,
          symbols: [{ symbol_name: 'calculateLedgerFee', symbol_type: 'function' }],
          imports: [{ target_path: './sox-reconciler.js', relation: 'IMPORTS' }],
          dependents: [{ source_path: 'src/api/routes.js', relation: 'IMPORTS' }],
        })
      );
      return;
    }
    res.end(JSON.stringify({ ok: true }));
  });

  try {
    assert.equal(DEFAULT_KRUSCH_GIT_URL, 'http://127.0.0.1:4890');
    const git = createKruschGitClient({
      baseUrl: mock.baseUrl,
      apiKey: 'kgit_secret_token',
    });
    assert.ok(git instanceof KruschGitClient);
    assert.equal(git.isConfigured(), true);

    const health = await git.health();
    assert.equal(health.status, 'ok');
    assert.equal(requests[0].headers['x-api-key'], 'kgit_secret_token');

    const repos = await git.listRepos();
    assert.equal(repos.length, 1);
    assert.equal(repos[0].name, 'krusch-stack');

    const codeHits = await git.searchCode({
      query: 'ledger fee calculation',
      repo: 'krusch-stack',
      type: 'hybrid',
      limit: 5,
    });
    assert.equal(codeHits.length, 1);
    assert.equal(codeHits[0].file_path, 'src/fee-engine.js');

    const symbolHits = await git.searchSymbols({
      query: 'calculateLedgerFee',
      repo: 'krusch-stack',
      symbolType: 'function',
    });
    assert.equal(symbolHits.length, 1);
    assert.equal(symbolHits[0].symbol_name, 'calculateLedgerFee');

    const graph = await git.getDependencyGraph({
      repo: 'krusch-stack',
      file: 'src/fee-engine.js',
    });
    assert.equal(graph.imports.length, 1);
    assert.equal(graph.imports[0].target_path, './sox-reconciler.js');
    assert.equal(graph.dependents.length, 1);
  } finally {
    await mock.close();
  }
});
