/**
 * @module @krusch/toolkit/catalog
 * Deterministic Lego Brick Catalog, Project Archetype Blueprints, and Boilerplate Auditor.
 *
 * Enforces INV-LEGO-01..07:
 * - Frozen `RUNTIME_BRICKS` registry across Node 22 ESM, React, and Python 3.12 FastAPI
 * - Frozen `PROJECT_ARCHETYPES` zero-LLM blueprints (5 canonical service topologies)
 * - Deterministic `auditBoilerplateText` scanner catching hand-rolled infrastructure plumbing
 */

function freezeBrick(brick) {
    const antiPattern = brick.antiPatternDescription || brick.replacesBoilerplate || '';
    return Object.freeze({
        id: brick.id,
        runtime: brick.runtime,
        importPath: brick.importPath,
        exports: Object.freeze([...brick.exports]),
        summary: brick.summary,
        snippet: brick.snippet,
        antiPatternDescription: antiPattern,
        replacesBoilerplate: antiPattern
    });
}

export const RUNTIME_BRICKS = Object.freeze([
    freezeBrick({
        id: 'http',
        runtime: 'node',
        importPath: '@krusch/toolkit/http',
        exports: [
            'okEnvelope',
            'errorEnvelope',
            'asyncHandler',
            'readBoundedJsonBody',
            'createCorsHeaders',
            'createExpressBricks',
            'createApiServer',
            'attachGracefulShutdown'
        ],
        summary: 'Zero-Express HTTP router, Express middleware bricks, 413-safe JSON body reader, deterministic envelopes, and graceful signal teardown.',
        snippet: `import { createApiServer, attachGracefulShutdown, okEnvelope } from '@krusch/toolkit/http';

const server = createApiServer({
  serviceName: 'demo-api',
  routes: {
    'GET /api/ping': () => okEnvelope('demo.ping', 'Pong', { ts: Date.now() })
  }
});
attachGracefulShutdown(server);`,
        antiPatternDescription: 'Hand-rolled HTTP servers lacking bounded 413 JSON parsing, X-Request-ID tracing, /health + /doctor envelopes, or SIGTERM drain.'
    }),
    freezeBrick({
        id: 'streaming',
        runtime: 'node',
        importPath: '@krusch/toolkit/streaming',
        exports: ['sseResponse', 'streamChat'],
        summary: 'AbortController-backed Server-Sent Events (SSE) framing, keep-alive heartbeats, and Ollama/LLM token streaming.',
        snippet: `import { sseResponse } from '@krusch/toolkit/streaming';

const sse = sseResponse(res, req);
sse.sendToken('Hello ');
sse.done({ ok: true, tool: 'chat.stream', summary: 'Complete', data: {} });`,
        antiPatternDescription: 'Manual text/event-stream headers without X-Accel-Buffering: no, heartbeat timers, or client-disconnect AbortController cleanup.'
    }),
    freezeBrick({
        id: 'mcp',
        runtime: 'node',
        importPath: '@krusch/toolkit/mcp',
        exports: [
            'defineMcpTool',
            'okMcpResult',
            'errorMcpResult',
            'validateToolArgs',
            'registerMcpHandlers',
            'createMcpServer'
        ],
        summary: 'Stdio MCP server factory enforcing INV-STACK-03 4-boolean tool annotations, schema argument validation, and JSON envelopes.',
        snippet: `import { defineMcpTool, createMcpServer, okMcpResult } from '@krusch/toolkit/mcp';

const tools = [
  defineMcpTool({
    name: 'ping_status',
    title: 'Ping Status',
    description: 'Return deterministic service health.',
    inputSchema: { type: 'object', properties: {} },
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  })
];
await createMcpServer('demo-mcp', '0.1.0', tools, async (name) => okMcpResult(name, 'OK', {}));`,
        antiPatternDescription: 'Raw MCP SDK new Server() + StdioServerTransport boilerplate missing 4-boolean tool annotations or stdout-safe error envelopes.'
    }),
    freezeBrick({
        id: 'pg',
        runtime: 'node',
        importPath: '@krusch/toolkit/pg',
        exports: [
            'buildPgConnectionString',
            'createPgPool',
            'runSqlMigrations',
            'pgVectorSearch'
        ],
        summary: 'PostgreSQL connection pool wrapper, transactional schema migration runner, and SQL-injection-guarded pgvector cosine search.',
        snippet: `import { createPgPool, runSqlMigrations, pgVectorSearch } from '@krusch/toolkit/pg';

const db = createPgPool({ host: '127.0.0.1', port: 5432, database: 'appdb' });
await runSqlMigrations(db, [{ id: '001_init', sql: 'CREATE EXTENSION IF NOT EXISTS vector;' }]);
const hits = await pgVectorSearch(db, { table: 'documents', vector: queryVec, expectedDims: 1024 });`,
        antiPatternDescription: 'Raw new pg.Pool() boilerplate without idle error listeners, URI encoding, transactional migrations, or dimension-checked pgvector queries.'
    }),
    freezeBrick({
        id: 'db',
        runtime: 'node',
        importPath: '@krusch/toolkit/db',
        exports: [
            'initDb',
            'getDb',
            'run',
            'query',
            'queryOne',
            'exec',
            'transaction',
            'prepare',
            'closeDb',
            'isSqliteCorruptionError'
        ],
        summary: 'Crash-safe SQLite WAL singleton wrapper with busy_timeout, foreign_keys, and transient vs corruption fault classification.',
        snippet: `import { initDb, exec, run, query } from '@krusch/toolkit/db';

initDb('./data/app.db');
exec('CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)');
run('INSERT INTO notes (body) VALUES (?)', ['Ready']);
const rows = query('SELECT id, body FROM notes');`,
        antiPatternDescription: 'Raw better-sqlite3 new Database() calls missing WAL pragmas, busy_timeout, parent-dir creation, or corruption vs OOM/lock guards.'
    }),
    freezeBrick({
        id: 'llm',
        runtime: 'node',
        importPath: '@krusch/toolkit/llm',
        exports: [
            'chat',
            'chatJson',
            'isGemini4Model',
            'normalizeThinkingLevel',
            'resolveMaxOutputTokens'
        ],
        summary: 'Unified Gemini (gemini-4-argon with thinkingLevel & CONTINUATION), xAI, and Multi-Family Ollama chat client.',
        snippet: `import { chat } from '@krusch/toolkit/llm';

const reply = await chat(
  'You are a concise SRE assistant.',
  'Summarize health state.',
  {
    provider: 'ollama',
    model: 'qwen2.5-coder:7b',
    apiUrl: 'http://127.0.0.1:11434/v1/chat/completions'
  }
);`,
        antiPatternDescription: 'Ad-hoc fetch calls to LLM endpoints lacking Gemini 4 continuation hops, JSON fence recovery, or timeout handling.'
    }),
    freezeBrick({
        id: 'embeddings',
        runtime: 'node',
        importPath: '@krusch/toolkit/embeddings',
        exports: [
            'embed',
            'embedBatch',
            'embedChunkedCentroid',
            'createEmbeddings',
            'formatEmbeddingInput',
            'calibrateQuerySimilarity',
            'validateVectorDimension',
            'DEFAULT_EMBED_MODEL',
            'DEFAULT_EMBED_DIMS'
        ],
        summary: 'Batched /api/embed client (snowflake-arctic-embed2 1024d default) with asymmetric query prefixes, LRU cache, and cosine calibration.',
        snippet: `import { embed } from '@krusch/toolkit/embeddings';

const vec = await embed(' statutory compliance rule ', {
  model: 'snowflake-arctic-embed2',
  dimensions: 1024,
  mode: 'query'
});`,
        antiPatternDescription: 'Unbatched /api/embeddings calls lacking asymmetric query prefixes, L2 normalization, or 1024d vector-space isolation.'
    }),
    freezeBrick({
        id: 'raw-rag',
        runtime: 'node',
        importPath: '@krusch/toolkit/raw-rag',
        exports: [
            'createRawRagIndex',
            'chunkConversationWindows',
            'rerankCandidateWindows',
            'assembleReaderEvidence',
            'auditRagBaselineConfig',
            'normalizeAppendOnlyWriteOp'
        ],
        summary: 'Zero-LLM 256/32-token source-preserving episodic RAG index with Top-128 recall, Top-15 reranking, and ADD/NONE append-only writes.',
        snippet: `import { createRawRagIndex } from '@krusch/toolkit/raw-rag';

const rag = createRawRagIndex({ model: 'snowflake-arctic-embed2', dimensions: 1024 });
await rag.addTurns([{ speaker: 'user', content: 'Deploy target is /srv/app-data.' }]);
const result = await rag.retrieve('Where is the deploy target?');`,
        antiPatternDescription: 'Lossy LLM ingestion summarizers or fixed-character chunkers that destroy verbatim identifiers and multi-turn provenance.'
    }),
    freezeBrick({
        id: 'vision',
        runtime: 'node',
        importPath: '@krusch/toolkit/vision',
        exports: ['callGeminiMedia', 'callGeminiMediaJson'],
        summary: 'Multimodal gemini-4-argon vision client supporting multi-viewport mediaItems, thinkingLevel, 65K output tokens, and CONTINUATION.',
        snippet: `import { callGeminiMediaJson } from '@krusch/toolkit/vision';

const audit = await callGeminiMediaJson('Audit responsive layout.', null, 'image/png', {
  model: 'gemini-4-argon',
  mediaItems: [{ label: 'desktop-1440', base64Data }]
});`,
        antiPatternDescription: 'Single-image low-token vision calls that truncate reasoning tokens or ignore multi-viewport responsive screenshots.'
    }),
    freezeBrick({
        id: 'decide',
        runtime: 'node',
        importPath: '@krusch/toolkit/decide',
        exports: [
            'decide',
            'decideBatch',
            'calibrateChoiceLogprobs',
            'createSystem1Decider'
        ],
        summary: 'Non-autoregressive single-token logprob decision router with softmax calibration, LRU cache, and hermetic offline CI fallback.',
        snippet: `import { decide } from '@krusch/toolkit/decide';

const verdict = await decide({
  state: 'Migration modifies 8 files and alters SQL schema.',
  question: 'Escalate to L0 spec-first gate?',
  choices: ['YES', 'NO']
});`,
        antiPatternDescription: 'Verbose Chain-of-Thought prompts burned on binary routing decisions that can be resolved in 1 token via calibrated logprobs.'
    }),
    freezeBrick({
        id: 'auth',
        runtime: 'node',
        importPath: '@krusch/toolkit/auth',
        exports: ['createAuth'],
        summary: 'Closure-based JWT token signing, httpOnly cookie helpers, and Express authentication middlewares.',
        snippet: `import { createAuth } from '@krusch/toolkit/auth';

const auth = createAuth({ secret: process.env.JWT_SECRET, cookieName: 'app_session' });`,
        antiPatternDescription: 'Duplicated JWT cookie serialization and inconsistent SameSite/Secure flags across web services.'
    }),
    freezeBrick({
        id: 'config',
        runtime: 'node',
        importPath: '@krusch/toolkit/config',
        exports: [
            'loadProjectConfig',
            'createConfig',
            'loadJsonConfig',
            'envOr',
            'envInt',
            'envBool',
            'validateRequired'
        ],
        summary: 'Layered configuration loader merging defaults -> config.json -> .env -> process.env with typed coercion.',
        snippet: `import { loadProjectConfig, envInt, envOr } from '@krusch/toolkit/config';

const base = await loadProjectConfig(process.cwd(), { port: 3000 });
export const config = {
  port: envInt('PORT', base.port, 3000),
  dbPath: envOr('DB_PATH', base.dbPath, './data/app.db')
};`,
        antiPatternDescription: 'Scattered process.env reads with NaN parseInt bugs and hardcoded hostnames.'
    }),
    freezeBrick({
        id: 'log',
        runtime: 'node',
        importPath: '@krusch/toolkit/log',
        exports: ['setupLogging'],
        summary: 'Zero-dependency rotating JSON file + console logger with request_id and exception stack serialization.',
        snippet: `import { setupLogging } from '@krusch/toolkit/log';

const logger = setupLogging('billing-api', { logDir: './logs' });
logger.info('Server booted', { requestId: 'req_01' });`,
        antiPatternDescription: 'Unstructured console.log statements or unbounded log files without rotation.'
    }),
    freezeBrick({
        id: 'react',
        runtime: 'react',
        importPath: '@krusch/toolkit/react',
        exports: [
            'cn',
            'STYLES',
            'useAesthetics',
            'fetchApiJson',
            'useApiQuery',
            'useSSEStream',
            'AppShell',
            'StatusPill',
            'MetricCard',
            'ErrorBoundary',
            'StreamingChatPanel',
            'setReactRuntime',
            'getReactRuntime'
        ],
        summary: 'Headless-safe React design tokens, AbortController data/SSE hooks, and canonical createElement UI shells.',
        snippet: `import { AppShell, MetricCard, useApiQuery } from '@krusch/toolkit/react';

export function Dashboard() {
  const { data, loading } = useApiQuery('/api/metrics');
  return AppShell({
    title: 'Telemetry',
    status: loading ? 'streaming' : 'healthy',
    children: MetricCard({ title: 'Items', value: data?.itemCount ?? 0, status: 'healthy' })
  });
}`,
        antiPatternDescription: 'Un-aborted useEffect fetch() race conditions, raw EventSource leaks, or duplicated Tailwind shell chrome.'
    }),
    freezeBrick({
        id: 'fastapi_app',
        runtime: 'python',
        importPath: 'krusch_toolkit.fastapi_app',
        exports: [
            'create_fastapi_app',
            'ok_envelope',
            'error_envelope',
            'sse_event_response'
        ],
        summary: 'Lazy-imported FastAPI factory wiring lifespan hooks, CORS, X-Request-ID timing, deterministic JSON envelopes, /health, /doctor, and SSE.',
        snippet: `from krusch_toolkit.fastapi_app import create_fastapi_app, ok_envelope

app = create_fastapi_app(title="Krusch Service", version="0.1.0")

@app.get("/api/ping")
async def ping():
    return ok_envelope("service.ping", "Pong", {"ready": True})`,
        antiPatternDescription: 'Repeated FastAPI CORSMiddleware + ad-hoc @app.get("/health") + inconsistent HTTPException payloads.'
    }),
    freezeBrick({
        id: 'edge',
        runtime: 'edge',
        importPath: '@krusch/toolkit/edge',
        exports: [
            'edgeOkEnvelope',
            'edgeErrorEnvelope',
            'edgeCorsHeaders',
            'edgeJsonResponse',
            'edgeOkResponse',
            'edgeErrorResponse',
            'readBoundedEdgeJson',
            'edgeSseResponse',
            'createEdgeKvJsonStore',
            'createEdgeRouter'
        ],
        summary: 'Zero-node:* Web-Standards router, 413-bounded JSON reader, SSE stream, and KV JSON store for Cloudflare Workers and edge runtimes.',
        snippet: `import { createEdgeRouter, createEdgeKvJsonStore } from '@krusch/toolkit/edge';

export default createEdgeRouter({
  serviceName: 'edge-api',
  routes: {
    'GET /api/items': async ({ env, ok }) => {
      const kv = createEdgeKvJsonStore(env?.STATE_KV);
      return ok('Ready', { keys: (await kv.list()).keys });
    }
  }
});`,
        antiPatternDescription: 'Importing node:* APIs inside Cloudflare Workers or hand-rolling edge CORS, 413 stream bounds, and SSE cancel cleanup.'
    }),
    freezeBrick({
        id: 'webhooks',
        runtime: 'node',
        importPath: '@krusch/toolkit/webhooks',
        exports: [
            'constantTimeEqual',
            'signWebhookHmac',
            'verifySlackSignature',
            'verifyGithubSignature',
            'verifyStripeSignature',
            'verifyBearerToken'
        ],
        summary: 'Constant-time HMAC-SHA256 webhook signature verifiers (Slack, GitHub, Stripe) with replay-window guards and SHA-256 Bearer auth.',
        snippet: `import { verifyGithubSignature } from '@krusch/toolkit/webhooks';

const check = verifyGithubSignature({
  rawBody,
  signatureHeader: req.headers['x-hub-signature-256'],
  webhookSecret: process.env.GITHUB_WEBHOOK_SECRET
});`,
        antiPatternDescription: 'Timing-leaky === string comparisons on createHmac digests, missing replay timestamp checks, or verifying re-serialized req.body.'
    }),
    freezeBrick({
        id: 'cli',
        runtime: 'node',
        importPath: '@krusch/toolkit/cli',
        exports: [
            'withSingleInstanceLock',
            'attachDaemonSignals',
            'appendJsonlRecord',
            'defineCli'
        ],
        summary: 'Atomic wx PID/nonce single-instance cron lockfile guard, idempotent daemon signal teardown, NDJSON appender, and --json CLI builder.',
        snippet: `import { withSingleInstanceLock, defineCli } from '@krusch/toolkit/cli';

const cli = defineCli({
  name: 'sync-worker',
  commands: {
    run: { run: () => withSingleInstanceLock('/tmp/sync.lock', async () => ({ synced: true })) }
  }
});`,
        antiPatternDescription: 'Overlapping cron runs without PID/nonce lockfiles, uncleaned SIGTERM daemons, or hand-rolled argv parsers without --json envelopes.'
    }),
    freezeBrick({
        id: 'sqlite',
        runtime: 'node',
        importPath: '@krusch/toolkit/sqlite',
        exports: [
            'DatabaseSync',
            'isSqliteCorruptionError',
            'openSqliteDb',
            'escapeFts5Query',
            'fuseRrfResults'
        ],
        summary: 'Zero-native-addon Node 22 node:sqlite WAL wrapper with nested savepoint transactions, FTS5 query token escaping, and Reciprocal Rank Fusion.',
        snippet: `import { openSqliteDb, escapeFts5Query, fuseRrfResults } from '@krusch/toolkit/sqlite';

const store = openSqliteDb('./data/search.db');
store.exec('CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(title, body)');
const ftsHits = store.query('SELECT rowid AS id, title FROM docs WHERE docs MATCH ?', [escapeFts5Query('C++ vector OR graph')]);
const ranked = fuseRrfResults([ftsHits, vectorHits], { k: 60, idKey: 'id', limit: 10 });`,
        antiPatternDescription: 'Raw node:sqlite new DatabaseSync() without WAL/busy_timeout pragmas, unescaped FTS5 MATCH syntax errors, or duplicated RRF fusion loops.'
    }),
    freezeBrick({
        id: 'security',
        runtime: 'node',
        importPath: '@krusch/toolkit/security',
        exports: [
            'isPrivateOrReservedIp',
            'validateOutboundUrl',
            'safeFetch',
            'createRateLimiter'
        ],
        summary: 'DNS-rebinding-safe SSRF IP/URL validator, redirect-checking safeFetch with cross-origin credential stripping, and bounded Map rate limiter.',
        snippet: `import { safeFetch, createRateLimiter } from '@krusch/toolkit/security';

const limiter = createRateLimiter({ windowMs: 60_000, max: 30 });
const upstream = await safeFetch(userProvidedUrl, { headers: { Accept: 'application/json' } }, { maxRedirects: 2 });`,
        antiPatternDescription: 'Unvalidated fetch(userUrl) vulnerable to 169.254.169.254 metadata/DNS-rebinding SSRF, redirect credential leaks, or unbounded Map rate limiters.'
    }),
    freezeBrick({
        id: 'lego-scout',
        runtime: 'node',
        importPath: '@krusch/toolkit/lego-scout',
        exports: [
            'CANDIDATE_PATTERN_SIGNATURES',
            'formatPortableProjectPath',
            'scoutHomelabLegoCandidates'
        ],
        summary: 'Deterministic cross-repo Lego adoption & Rule-of-3 candidate cluster scanner with symlink containment and portable path scrubbing.',
        snippet: `import { scoutHomelabLegoCandidates } from '@krusch/toolkit/lego-scout';

const report = scoutHomelabLegoCandidates('/workspace/projects', { minProjects: 3, portablePaths: true });`,
        antiPatternDescription: 'Speculative single-project library extractions violating the Rule-of-3 anti-bloat bar or manual cross-repo boilerplate grep sweeps.'
    }),
    freezeBrick({
        id: 'python_mcp',
        runtime: 'python',
        importPath: 'krusch_toolkit.mcp',
        exports: [
            'define_mcp_tool',
            'ok_mcp_result',
            'error_mcp_result',
            'validate_tool_args',
            'dispatch_mcp_tool'
        ],
        summary: 'Zero-dependency Python 3.11+ MCP tool normalizer enforcing INV-STACK-03 4-boolean annotations, required-arg checks, and envelope dispatch.',
        snippet: `from krusch_toolkit.mcp import define_mcp_tool, dispatch_mcp_tool, ok_mcp_result

TOOLS = [define_mcp_tool(name="ping_law", description="Health check", read_only_hint=True)]
res = await dispatch_mcp_tool(TOOLS, lambda name, args: ok_mcp_result(name, "Ready", {}), "ping_law", {})`,
        antiPatternDescription: 'Python MCP tool definitions missing 4-boolean readOnlyHint/destructiveHint/idempotentHint/openWorldHint annotations or inconsistent error shapes.'
    }),
    freezeBrick({
        id: 'python_pg',
        runtime: 'python',
        importPath: 'krusch_toolkit.pg',
        exports: [
            'assert_safe_pg_identifier',
            'build_pg_connection_string',
            'format_pgvector_literal',
            'run_sql_migrations',
            'pg_vector_search'
        ],
        summary: 'SQL-injection-guarded PostgreSQL identifier checks, URL-encoded DSN builder, 1024d pgvector literal formatter, migrations, and cosine search.',
        snippet: `from krusch_toolkit.pg import build_pg_connection_string, pg_vector_search

dsn = build_pg_connection_string({"host": "127.0.0.1", "database": "lawdb"})
hits = pg_vector_search(conn, table="statutes", vector=query_vec, select_columns=("id", "citation"), expected_dims=1024)`,
        antiPatternDescription: 'f-string SQL table/column interpolation, unencoded PostgreSQL passwords in DSNs, or dimension-unchecked pgvector queries in Python services.'
    }),
    freezeBrick({
        id: 'python_security',
        runtime: 'python',
        importPath: 'krusch_toolkit.security',
        exports: [
            'constant_time_equal',
            'verify_webhook_hmac',
            'verify_bearer_token',
            'is_private_or_reserved_ip',
            'validate_outbound_url'
        ],
        summary: 'Stdlib constant-time HMAC-SHA256 webhook verifier, length-hiding SHA-256 Bearer auth, and IPv4/IPv6/6to4/Teredo/DNS SSRF URL validator.',
        snippet: `from krusch_toolkit.security import validate_outbound_url, verify_bearer_token

auth = verify_bearer_token(request.headers.get("Authorization"), expected_token)
ssrf = validate_outbound_url(target_url, allow_private_lan=False)`,
        antiPatternDescription: 'Python == secret comparisons leaking token length, unverified webhook HMAC headers, or httpx.get(user_url) without SSRF IP validation.'
    }),
    freezeBrick({
        id: 'schema',
        runtime: 'node',
        importPath: '@krusch/toolkit/schema',
        exports: [
            's',
            'toJsonSchema',
            'validateSchema',
            'validatePayload',
            'createSchemaMiddleware'
        ],
        summary: 'Zero-dependency isomorphic schema builder, Zod/JSON-Schema adapter, MCP inputSchema compiler, and prototype-safe VALIDATION_ERROR middleware.',
        snippet: `import { s, toJsonSchema, validateSchema } from '@krusch/toolkit/schema';

const CreateUser = s.object({ email: s.string({ format: 'email' }), age: s.integer({ min: 18 }).optional() });
const mcpSchema = toJsonSchema(CreateUser);
const checked = validateSchema(CreateUser, reqBody);`,
        antiPatternDescription: 'Scattered manual typeof checks, unguarded __proto__ payload copying, or duplicated Zod/JSON-Schema wiring without INV-LEGO-01 error envelopes.'
    }),
    freezeBrick({
        id: 'upload',
        runtime: 'node',
        importPath: '@krusch/toolkit/upload',
        exports: [
            'sanitizeUploadFilename',
            'sniffMimeMagic',
            'verifyUploadMime',
            'parseBoundedMultipart'
        ],
        summary: 'Stream-draining O(N) multipart/form-data parser with pre-buffer byte ceilings, path-traversal filename sanitizer, and magic-byte MIME verification.',
        snippet: `import { parseBoundedMultipart } from '@krusch/toolkit/upload';

const upload = await parseBoundedMultipart(req, {
  maxTotalBytes: 5 * 1024 * 1024,
  allowedMimeTypes: ['application/pdf', 'image/*']
});`,
        antiPatternDescription: 'Unbounded multer memoryStorage uploads, trusting spoofed Content-Type headers (e.g. image/svg+xml XSS), or ../ path traversal in filenames.'
    }),
    freezeBrick({
        id: 'cascade',
        runtime: 'node',
        importPath: '@krusch/toolkit/cascade',
        exports: [
            'DEFAULT_FLEET_CASCADE_TIERS',
            'createTierCircuitBreaker',
            'selectCascadeTier',
            'probeBurstEndpoint',
            'executeWithCascadeFallback'
        ],
        summary: 'Zero-node:* <25us multi-tier LLM cascade selector, single-flight HALF_OPEN circuit breaker, Colab G4 burst probe, and AbortController fallback runner.',
        snippet: `import { createTierCircuitBreaker, selectCascadeTier, executeWithCascadeFallback } from '@krusch/toolkit/cascade';

const breaker = createTierCircuitBreaker({ failureThreshold: 3, cooldownMs: 30_000 });
const plan = selectCascadeTier({ complexityScore: 0.72, requiresTools: true, breaker });
const res = await executeWithCascadeFallback(plan.data.candidateChain, (tier, { signal }) => callModel(tier, signal), { breaker });`,
        antiPatternDescription: 'Hardcoded single-endpoint LLM calls lacking circuit-breaker cooldowns, HALF_OPEN stampede guards, or deterministic L1->L2->L2.5->L3 escalation.'
    }),
    freezeBrick({
        id: 'audio',
        runtime: 'node',
        importPath: '@krusch/toolkit/audio',
        exports: [
            'encodeWavPcm16',
            'parseWavHeader',
            'transcribeWhisperAudio',
            'synthesizeSpeechAudio'
        ],
        summary: 'Zero-node:* RIFF/WAVE PCM16 encoder/parser (tolerant of JUNK/LIST chunks) plus AbortController-bounded Whisper STT and streaming TTS clients.',
        snippet: `import { encodeWavPcm16, transcribeWhisperAudio } from '@krusch/toolkit/audio';

const wavBytes = encodeWavPcm16(floatSamples, { sampleRate: 16_000, channels: 1 });
const stt = await transcribeWhisperAudio(wavBytes, { endpointUrl: 'http://127.0.0.1:9000/v1/audio/transcriptions' });`,
        antiPatternDescription: 'Fixed 44-byte WAV offsets breaking on JUNK/LIST chunks, unbounded TTS arrayBuffer downloads, or un-aborted Whisper STT fetch requests.'
    }),
    freezeBrick({
        id: 'python_schema',
        runtime: 'python',
        importPath: 'krusch_toolkit.schema',
        exports: [
            'validate_json_schema',
            'validate_payload'
        ],
        summary: 'Stdlib Python 3.11+ JSON Schema & duck-typed Pydantic v2 validator rejecting bool-as-int, NaN/Inf, deep recursion, and __proto__ keys.',
        snippet: `from krusch_toolkit.schema import validate_payload

res = validate_payload({"type": "object", "required": ["count"], "properties": {"count": {"type": "integer"}}}, payload)`,
        antiPatternDescription: 'Python isinstance(True, int) schema bugs, unguarded NaN/Infinity floats, or raw Pydantic ValidationError tracebacks instead of INV-LEGO-01 envelopes.'
    }),
    freezeBrick({
        id: 'python_upload',
        runtime: 'python',
        importPath: 'krusch_toolkit.upload',
        exports: [
            'sanitize_upload_filename',
            'sniff_mime_magic',
            'verify_upload_mime',
            'read_bounded_upload'
        ],
        summary: 'Stdlib Python upload filename sanitizer, binary magic-byte sniffer (blocking SVG XSS under image/*), and chunk-bounded async UploadFile reader.',
        snippet: `from krusch_toolkit.upload import read_bounded_upload

res = await read_bounded_upload(upload_file, max_bytes=5_242_880, allowed_mime_types=("application/pdf", "image/*"))`,
        antiPatternDescription: 'Calling await file.read() before enforcing byte limits (OOM DoS), trusting client content_type headers, or unsanitized UploadFile.filename paths.'
    }),
    freezeBrick({
        id: 'python_http_client',
        runtime: 'python',
        importPath: 'krusch_toolkit.http_client',
        exports: [
            'HttpCircuitBreaker',
            'create_http_circuit_breaker',
            'compute_retry_delay',
            'build_resilient_headers',
            'request_json',
            'async_request_json'
        ],
        summary: 'Lazy-httpx SSRF-guarded, DNS-pinned, byte-bounded JSON HTTP client with single-flight HALF_OPEN circuit breaking, Retry-After backoff, and INV-LEGO-01 envelopes.',
        snippet: `from krusch_toolkit.http_client import async_request_json, create_http_circuit_breaker

breaker = create_http_circuit_breaker(failure_threshold=3, cooldown_seconds=30.0)
res = await async_request_json("http://127.0.0.1:8085/api/query", method="POST", json_body={"q": "notice"}, allow_loopback=True, breaker=breaker)`,
        antiPatternDescription: 'Ad-hoc httpx.AsyncClient() blocks lacking SSRF redirect re-validation, max_response_bytes caps, Retry-After backoff, or cancellation-safe HALF_OPEN circuit breakers.'
    }),
    freezeBrick({
        id: 'python_streamlit_ui',
        runtime: 'python',
        importPath: 'krusch_toolkit.streamlit_ui',
        exports: [
            'AIRGAPPED_THEME_PRESETS',
            'build_airgapped_theme_css',
            'build_rag_auth_headers',
            'format_citation_badges_html',
            'render_citation_badges',
            'init_rag_session_state',
            'append_rag_turn',
            'render_sovereign_rag_shell'
        ],
        summary: 'Air-gapped Sovereign Dark Glassmorphism CSS, XSS-hardened citation badges, CRLF-guarded auth headers, and bounded Streamlit RAG chat state.',
        snippet: `from krusch_toolkit.streamlit_ui import render_sovereign_rag_shell, render_citation_badges

render_sovereign_rag_shell(title="KruschLaw", badge_text="AIR-GAPPED", accent="sky", health_status="healthy")
render_citation_badges([{"source": "Cal. Civ. Code § 1950.5", "score": 0.94, "span": "21 calendar days"}])`,
        antiPatternDescription: 'Duplicated Streamlit glassmorphism CSS with external font leaks, unescaped unsafe_allow_html citation links (javascript: XSS), or unbounded st.session_state chat arrays.'
    }),
    freezeBrick({
        id: 'yaml',
        runtime: 'node',
        importPath: '@krusch/toolkit/yaml',
        exports: [
            'DEFAULT_YAML_LIMITS',
            'parseSafeYaml',
            'stringifySafeYaml',
            'validateYamlConfig',
            'loadSafeYamlPack'
        ],
        summary: 'Zero-dependency, zero-node:* isomorphic YAML 1.2 Core parser/serializer with alias-bomb & tag guards, schema validation, and SHA-256 pack loading.',
        snippet: `import { loadSafeYamlPack } from '@krusch/toolkit/yaml';
import { s } from '@krusch/toolkit/schema';

const res = loadSafeYamlPack(rawYaml, {
  requiredKeys: ['pack_id', 'jurisdiction'],
  schema: s.object({ pack_id: s.string(), jurisdiction: s.string() })
});`,
        antiPatternDescription: 'Unsafe js-yaml yaml.load() calls permitting arbitrary tags, Billion-Laughs alias expansion bombs, Norway boolean coercion, or prototype pollution.'
    }),
    freezeBrick({
        id: 'python_yaml',
        runtime: 'python',
        importPath: 'krusch_toolkit.yaml_loader',
        exports: [
            'DEFAULT_YAML_LIMITS',
            'parse_safe_yaml',
            'dump_safe_yaml',
            'validate_yaml_config',
            'load_safe_yaml_pack'
        ],
        summary: 'Hardened PyYAML _SovereignSafeLoader enforcing YAML 1.2 Core types, tag/alias-bomb blocks, traversal-guarded pack reads, and SHA-256 provenance.',
        snippet: `from krusch_toolkit.yaml_loader import load_safe_yaml_pack

res = load_safe_yaml_pack(
    "packs/ca-security-deposit.yaml",
    base_dir="packs",
    from_file=True,
    required_keys=["pack_id", "jurisdiction"],
)`,
        antiPatternDescription: 'Raw PyYAML yaml.load()/unsafe_load()/full_load() permitting arbitrary code execution, unbounded Billion-Laughs aliases, or unpinned symlink reads.'
    }),
    freezeBrick({
        id: 'python_db_async',
        runtime: 'python',
        importPath: 'krusch_toolkit.db_async',
        exports: [
            'DEFAULT_SQLITE_PRAGMAS',
            'redact_database_url',
            'apply_sqlite_wal_pragmas',
            'create_managed_engine',
            'create_managed_async_engine',
            'session_scope',
            'async_session_scope',
            'check_engine_health',
            'check_async_engine_health'
        ],
        summary: 'Managed SQLAlchemy sync/async engine pools with SQLite WAL pragmas, credential-redacted DSNs, and cancellation-safe session scopes.',
        snippet: `from krusch_toolkit.db_async import create_managed_async_engine, async_session_scope

eng = create_managed_async_engine("sqlite+aiosqlite:///app.db")
async with async_session_scope(eng["data"]["session_factory"]) as session:
    await session.execute(...)`,
        antiPatternDescription: 'Ad-hoc create_engine/create_async_engine blocks missing SQLite WAL/busy_timeout pragmas, pool_pre_ping, DSN credential scrubbing, or CancelledError rollback shielding.'
    }),
    freezeBrick({
        id: 'idempotency',
        runtime: 'node',
        importPath: '@krusch/toolkit/idempotency',
        exports: [
            'DEFAULT_IDEMPOTENCY_OPTIONS',
            'normalizeIdempotencyKey',
            'computePayloadFingerprint',
            'createIdempotencyStore',
            'withIdempotency',
            'createIdempotencyMiddleware'
        ],
        summary: 'Atomic Idempotency-Key in-flight lock (409), SHA-256 payload-mismatch guard (422), fencing tokens, and tenant-scoped replay middleware.',
        snippet: `import { createIdempotencyStore, withIdempotency } from '@krusch/toolkit/idempotency';

const store = createIdempotencyStore({ ttlMs: 86_400_000, maxEntries: 10_000 });
const res = await withIdempotency(
  store,
  { key: req.headers['idempotency-key'], payload: req.body, method: 'POST', path: '/api/charges' },
  async () => ({ chargeId: 'ch_01', amountCents: 4999 })
);`,
        antiPatternDescription: 'Non-atomic check-then-act payment/webhook handlers vulnerable to duplicate concurrent charges, retry storms, or key reuse with mutated payloads.'
    }),
    freezeBrick({
        id: 'audit-log',
        runtime: 'node',
        importPath: '@krusch/toolkit/audit-log',
        exports: [
            'GENESIS_AUDIT_HASH',
            'canonicalizeAuditPayload',
            'computeAuditEntryHash',
            'verifyAuditChain',
            'createAuditLog'
        ],
        summary: 'Tamper-evident SHA-256 / HMAC hash-chained compliance ledger with canonical JSON serialization and SQLite BEFORE UPDATE/DELETE immutability triggers.',
        snippet: `import { createAuditLog } from '@krusch/toolkit/audit-log';

const audit = createAuditLog({ sqlitePath: './data/audit.db' });
audit.append({ tenantId: 'org_1', actor: 'usr_42', action: 'billing.refund', resource: 'inv_99', outcome: 'SUCCESS' });
const verified = audit.verify();`,
        antiPatternDescription: 'Mutable SQL audit tables or unstructured console logs where silent row edits, deletions, or truncations go undetected under SOX/HIPAA/SOC2 review.'
    }),
    freezeBrick({
        id: 'rbac',
        runtime: 'node',
        importPath: '@krusch/toolkit/rbac',
        exports: [
            'matchPermissionPattern',
            'createRbacPolicy',
            'assertTenantOwnership',
            'evaluateAccess',
            'createRbacGuard'
        ],
        summary: 'Zero-node:* deny-by-default role inheritance & scoped permission evaluator with explicit-deny precedence and OWASP A01 multi-tenant IDOR guards.',
        snippet: `import { createRbacPolicy, evaluateAccess } from '@krusch/toolkit/rbac';

const policy = createRbacPolicy({
  roles: { billing_admin: { allow: ['billing:*'], deny: ['billing:purge'] } }
});
const decision = evaluateAccess(policy, req.user, 'billing:refund', { resource: invoice });`,
        antiPatternDescription: 'Scattered req.user.role === "admin" checks missing explicit-deny precedence, role cycle checks, or strict subject.tenantId === resource.tenantId IDOR isolation.'
    }),
    freezeBrick({
        id: 'pagination',
        runtime: 'node',
        importPath: '@krusch/toolkit/pagination',
        exports: [
            'DEFAULT_PAGINATION_LIMITS',
            'clampPageLimit',
            'encodeCursor',
            'decodeCursor',
            'buildKeysetPage',
            'paginateItems'
        ],
        summary: 'Constant-time HMAC-SHA256 tamper-signed base64url keyset cursor encoder/decoder with scope/TTL binding and bounded page-limit clamps.',
        snippet: `import { clampPageLimit, decodeCursor, buildKeysetPage } from '@krusch/toolkit/pagination';

const limit = clampPageLimit(req.query.limit, { defaultLimit: 25, maxLimit: 100 });
const cursor = req.query.cursor ? decodeCursor(req.query.cursor, { secret: process.env.CURSOR_SECRET, expectedScope: req.user.tenantId }) : null;
const page = buildKeysetPage(rows, { limit, sortField: 'createdAt', idField: 'id', secret: process.env.CURSOR_SECRET, scope: req.user.tenantId });`,
        antiPatternDescription: 'Unbounded ?limit=9999999 queries causing OOMs, slow OFFSET scans, or unsigned base64 cursors vulnerable to cross-tenant cursor tampering.'
    })
]);

function normalizeSlug(rawName = '') {
    const cleaned = String(rawName || 'krusch-service')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return cleaned || 'krusch-service';
}

function normalizePort(port, fallback = 3000) {
    const parsed = Number(port);
    return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
}

function renderGithubNodeCi(extraSteps = '') {
    return `name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - run: npm install
${extraSteps ? `${extraSteps}\n` : ''}      - run: npm test
`;
}

function renderMitLicense() {
    return `MIT License

Copyright (c) 2026 kruschdev <kruschdev@users.noreply.github.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;
}

function renderScaffoldDockerignore() {
    return `node_modules
client/node_modules
.env
.env.*
!.env.example
data
logs
*.log
.git
__pycache__
*.pyc
.venv
.pytest_cache
`;
}

function renderNodeScaffoldDockerfile(slug, { port = null, cmd = '["node", "src/server.js"]' } = {}) {
    return `FROM node:22-bookworm-slim
ENV PUPPETEER_SKIP_DOWNLOAD=true
WORKDIR /workspace/projects/krusch-cascade-router
COPY --from=krusch_cascade_router package.json ./
COPY --from=krusch_cascade_router dist ./dist
WORKDIR /workspace/lib
COPY --from=krusch_toolkit package*.json ./
RUN npm install --omit=dev
COPY --from=krusch_toolkit . ./
WORKDIR /workspace/projects/${slug}
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV NODE_ENV=production
${port !== null ? `EXPOSE ${port}\n` : ''}CMD ${cmd}
`;
}

function sanitizeInlineTitle(value, fallback = 'krusch-app') {
    const clean = String(value ?? '').replace(/[\r\n\x00-\x1f]+/g, ' ').trim();
    return clean || fallback;
}

function escapeHtmlText(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function escapePythonDocstring(value) {
    return sanitizeInlineTitle(value)
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"');
}

function renderNodeApiSqliteFiles({ projectName = 'krusch-api', port = 3000 } = {}) {
    const slug = normalizeSlug(projectName);
    const displayTitle = sanitizeInlineTitle(projectName, slug);
    const resolvedPort = normalizePort(port, 3000);

    return {
        'AGENTS.md': `# ${displayTitle} (\`AGENTS.md\`)

Node 22 ESM API service stamped from the \`node-api-sqlite\` Lego archetype.

## Stack & Toolkit Bricks
- \`@krusch/toolkit/http\` (\`createApiServer\`, \`attachGracefulShutdown\`, \`okEnvelope\`)
- \`@krusch/toolkit/db\` (\`initDb\`, \`exec\`, \`query\`, \`run\`, \`closeDb\`)
- \`@krusch/toolkit/config\` (\`loadProjectConfig\`, \`envOr\`, \`envInt\`)
- \`@krusch/toolkit/log\` (\`setupLogging\`)

## Operational Rules
- **OS Drive Protection**: Mount persistent SQLite data from a dedicated data volume via \`DATA_DIR\` rather than the OS boot drive.
- **GitHub Attribution**: Author all commits as \`kruschdev <kruschdev@users.noreply.github.com>\`.

## Commands
\`\`\`bash
npm install
npm test
npm start
\`\`\`
`,
        'package.json': `${JSON.stringify(
            {
                name: slug,
                version: '0.1.0',
                private: true,
                type: 'module',
                description: `${displayTitle} — Node 22 ESM SQLite API built on @krusch/toolkit`,
                author: 'kruschdev <kruschdev@users.noreply.github.com>',
                license: 'MIT',
                engines: { node: '>=22.0.0' },
                scripts: {
                    start: 'node src/server.js',
                    dev: 'node --watch src/server.js',
                    test: 'node --test tests/*.test.js'
                },
                dependencies: {
                    '@krusch/toolkit': 'file:../../lib'
                }
            },
            null,
            2
        )}\n`,
        'config.json': `${JSON.stringify(
            {
                port: resolvedPort,
                serviceName: slug,
                dbPath: './data/app.db',
                logDir: './logs'
            },
            null,
            2
        )}\n`,
        'src/config.js': `import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProjectConfig, envOr, envInt } from '@krusch/toolkit/config';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaults = {
    port: ${resolvedPort},
    serviceName: '${slug}',
    dbPath: './data/app.db',
    logDir: './logs'
};

const baseConfig = await loadProjectConfig(projectRoot, defaults);

export const config = Object.freeze({
    port: envInt('PORT', baseConfig.port, ${resolvedPort}),
    serviceName: envOr('SERVICE_NAME', baseConfig.serviceName, '${slug}'),
    dbPath: envOr('DB_PATH', baseConfig.dbPath, './data/app.db'),
    logDir: envOr('LOG_DIR', baseConfig.logDir, './logs')
});
`,
        'src/server.js': `import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApiServer, attachGracefulShutdown, okEnvelope, errorEnvelope } from '@krusch/toolkit/http';
import { initDb, exec, query, run, closeDb } from '@krusch/toolkit/db';
import { setupLogging } from '@krusch/toolkit/log';
import { config } from './config.js';

export function buildServer({ dbPath = config.dbPath, serviceName = config.serviceName, logger = null } = {}) {
    const activeLogger = logger || setupLogging(serviceName, { logDir: config.logDir, console: false });
    initDb(dbPath);
    exec(\`
        CREATE TABLE IF NOT EXISTS items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
    \`);

    const server = createApiServer({
        serviceName,
        version: '0.1.0',
        logger: activeLogger,
        healthCheck: () => {
            const row = query('SELECT COUNT(*) AS count FROM items')[0];
            return { db: 'ok', items: row?.count ?? 0 };
        },
        routes: {
            'GET /api/items': () => {
                const items = query('SELECT id, title, created_at FROM items ORDER BY id DESC');
                return okEnvelope('items.list', \`Returned \${items.length} item(s)\`, { items });
            },
            'POST /api/items': (ctx) => {
                const title = String(ctx.body?.title || '').trim();
                if (!title) {
                    ctx.sendJson(400, errorEnvelope('VALIDATION_ERROR', 'Field "title" is required', null, 'items.create'));
                    return;
                }
                const result = run('INSERT INTO items (title) VALUES (?)', [title]);
                ctx.sendJson(
                    201,
                    okEnvelope('items.create', 'Created item', {
                        id: result.lastInsertRowid,
                        title
                    })
                );
            }
        }
    });

    return { server, close: () => closeDb() };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
    const logger = setupLogging(config.serviceName, { logDir: config.logDir });
    const { server, close } = buildServer({ logger });
    server.listen(config.port, () => {
        logger.info(\`\${config.serviceName} listening on port \${config.port}\`);
    });
    attachGracefulShutdown(server, [close], { logger });
}
`,
        '.env.example': `PORT=${resolvedPort}
SERVICE_NAME=${slug}
DB_PATH=./data/app.db
# Point DATA_DIR to a dedicated non-OS storage volume in production
DATA_DIR=./data
LOG_DIR=./logs
`,
        '.dockerignore': renderScaffoldDockerignore(),
        'docker-compose.yml': `# OS Drive Protection (INV-LEGO-04):
# Never store persistent SQLite databases, Docker volumes, or model caches on OS root drives.
# Point DATA_DIR to a dedicated non-OS storage volume in production.
services:
  app:
    build:
      context: .
      additional_contexts:
        krusch_toolkit: ../../lib
        krusch_cascade_router: ../../projects/krusch-cascade-router
    container_name: ${slug}
    restart: unless-stopped
    ports:
      - "\${PORT:-${resolvedPort}}:${resolvedPort}"
    environment:
      PORT: "${resolvedPort}"
      DB_PATH: /app/data/app.db
      LOG_DIR: /app/data/logs
    volumes:
      - \${DATA_DIR:-./data}:/app/data
`,
        'Dockerfile': renderNodeScaffoldDockerfile(slug, { port: resolvedPort }),
        '.github/workflows/ci.yml': renderGithubNodeCi('      - run: node --check src/server.js'),
        'tests/smoke.test.js': `import test from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from '../src/server.js';

test('${slug} /health and /api/items smoke flow', async (t) => {
    const { server, close } = buildServer({ dbPath: ':memory:' });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
        await new Promise((resolve) => server.close(resolve));
        close();
    });

    const { port } = server.address();
    const baseUrl = \`http://127.0.0.1:\${port}\`;

    const healthRes = await fetch(\`\${baseUrl}/health\`);
    assert.equal(healthRes.status, 200);
    const healthBody = await healthRes.json();
    assert.equal(healthBody.ok, true);

    const createRes = await fetch(\`\${baseUrl}/api/items\`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'First Lego item' })
    });
    assert.equal(createRes.status, 201);
    const createBody = await createRes.json();
    assert.equal(createBody.ok, true);
    assert.equal(createBody.data.title, 'First Lego item');

    const listRes = await fetch(\`\${baseUrl}/api/items\`);
    assert.equal(listRes.status, 200);
    const listBody = await listRes.json();
    assert.equal(listBody.ok, true);
    assert.equal(listBody.data.items.length, 1);
});
`
    };
}

function renderNodeRagPgvectorFiles({ projectName = 'krusch-rag', port = 3000 } = {}) {
    const slug = normalizeSlug(projectName);
    const displayTitle = sanitizeInlineTitle(projectName, slug);
    const dbName = slug.replace(/-/g, '_');
    const resolvedPort = normalizePort(port, 3000);

    return {
        'AGENTS.md': `# ${displayTitle} (\`AGENTS.md\`)

Node 22 ESM RAG backend stamped from the \`node-rag-pgvector\` Lego archetype.

## Stack & Toolkit Bricks
- \`@krusch/toolkit/http\` (\`createApiServer\`, \`attachGracefulShutdown\`, \`okEnvelope\`)
- \`@krusch/toolkit/pg\` (\`createPgPool\`, \`runSqlMigrations\`, \`pgVectorSearch\`)
- \`@krusch/toolkit/embeddings\` (\`embed\`, \`snowflake-arctic-embed2\` 1024d)
- \`@krusch/toolkit/raw-rag\` (\`createRawRagIndex\`)
- \`@krusch/toolkit/config\` & \`@krusch/toolkit/log\`

## Operational Rules
- **OS Drive Protection**: Point \`PG_DATA_DIR\` and \`DATA_DIR\` to dedicated non-OS storage volumes in production. Never mount PostgreSQL data on OS boot drives.
- **GitHub Attribution**: Author all commits as \`kruschdev <kruschdev@users.noreply.github.com>\`.
`,
        'package.json': `${JSON.stringify(
            {
                name: slug,
                version: '0.1.0',
                private: true,
                type: 'module',
                description: `${displayTitle} — Sovereign 1024d pgvector + Raw-RAG service built on @krusch/toolkit`,
                author: 'kruschdev <kruschdev@users.noreply.github.com>',
                license: 'MIT',
                engines: { node: '>=22.0.0' },
                scripts: {
                    start: 'node src/server.js',
                    dev: 'node --watch src/server.js',
                    test: 'MOCK_EMBEDDINGS=1 node --test tests/*.test.js'
                },
                dependencies: {
                    '@krusch/toolkit': 'file:../../lib'
                }
            },
            null,
            2
        )}\n`,
        'config.json': `${JSON.stringify(
            {
                port: resolvedPort,
                serviceName: slug,
                embedModel: 'snowflake-arctic-embed2',
                embedDims: 1024,
                embedHost: 'http://127.0.0.1:11434',
                db: {
                    host: '127.0.0.1',
                    port: 5432,
                    user: 'postgres',
                    password: 'changeme',
                    database: dbName
                }
            },
            null,
            2
        )}\n`,
        'src/config.js': `import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProjectConfig, envOr, envInt } from '@krusch/toolkit/config';
import { DEFAULT_EMBED_MODEL, DEFAULT_EMBED_DIMS } from '@krusch/toolkit/embeddings';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseConfig = await loadProjectConfig(projectRoot, {
    port: ${resolvedPort},
    serviceName: '${slug}',
    embedModel: DEFAULT_EMBED_MODEL,
    embedDims: DEFAULT_EMBED_DIMS,
    embedHost: 'http://127.0.0.1:11434',
    db: {
        host: '127.0.0.1',
        port: 5432,
        user: 'postgres',
        password: 'changeme',
        database: '${dbName}'
    }
});

export const config = Object.freeze({
    port: envInt('PORT', baseConfig.port, ${resolvedPort}),
    serviceName: envOr('SERVICE_NAME', baseConfig.serviceName, '${slug}'),
    embedModel: envOr('EMBED_MODEL', baseConfig.embedModel, 'snowflake-arctic-embed2'),
    embedDims: envInt('EMBED_DIMS', baseConfig.embedDims, 1024),
    embedHost: envOr('OLLAMA_EMBED_HOST', baseConfig.embedHost, 'http://127.0.0.1:11434'),
    logDir: envOr('LOG_DIR', baseConfig.logDir, './logs'),
    db: Object.freeze({
        url: envOr('DATABASE_URL', null, null),
        host: envOr('DB_HOST', baseConfig.db?.host, '127.0.0.1'),
        port: envInt('DB_PORT', baseConfig.db?.port, 5432),
        user: envOr('DB_USER', baseConfig.db?.user, 'postgres'),
        password: envOr('DB_PASSWORD', baseConfig.db?.password, 'changeme'),
        database: envOr('DB_NAME', baseConfig.db?.database, '${dbName}')
    })
});
`,
        'src/migrations.js': `export const MIGRATIONS = Object.freeze([
    Object.freeze({
        id: '001_init_pgvector_documents',
        sql: \`
            CREATE EXTENSION IF NOT EXISTS vector;
            CREATE TABLE IF NOT EXISTS documents (
                id SERIAL PRIMARY KEY,
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                embedding vector(1024) NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
        \`
    })
]);
`,
        'src/server.js': `import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApiServer, attachGracefulShutdown, okEnvelope, errorEnvelope } from '@krusch/toolkit/http';
import { createPgPool, runSqlMigrations, pgVectorSearch } from '@krusch/toolkit/pg';
import { embed } from '@krusch/toolkit/embeddings';
import { createRawRagIndex } from '@krusch/toolkit/raw-rag';
import { setupLogging } from '@krusch/toolkit/log';
import { config } from './config.js';
import { MIGRATIONS } from './migrations.js';

export function buildRagServer({
    pgWrapper = null,
    offline = process.env.MOCK_EMBEDDINGS === '1',
    logger = null
} = {}) {
    const activeLogger = logger || setupLogging(config.serviceName, { logDir: config.logDir, console: false });
    const rawRag = createRawRagIndex({
        model: config.embedModel,
        dimensions: config.embedDims,
        host: config.embedHost,
        offline
    });

    const server = createApiServer({
        serviceName: config.serviceName,
        version: '0.1.0',
        logger: activeLogger,
        healthCheck: async () => {
            const pgStatus = pgWrapper ? await pgWrapper.healthCheck() : { ok: true, mode: 'in-memory-rag' };
            return {
                embedModel: config.embedModel,
                embedDims: config.embedDims,
                ragStats: rawRag.getStats(),
                pg: pgStatus
            };
        },
        routes: {
            'POST /api/ingest': async (ctx) => {
                const title = String(ctx.body?.title || 'untitled').trim();
                const content = String(ctx.body?.content || '').trim();
                if (!content) {
                    ctx.sendJson(400, errorEnvelope('VALIDATION_ERROR', 'Field "content" is required', null, 'rag.ingest'));
                    return;
                }

                const ragStatus = await rawRag.addTurns([{ speaker: title, content }]);
                const vector = await embed(content, {
                    model: config.embedModel,
                    dimensions: config.embedDims,
                    host: config.embedHost,
                    mode: 'document',
                    mock: offline
                });

                if (pgWrapper) {
                    const vectorLiteral = \`[\${vector.join(',')}]\`;
                    await pgWrapper.query(
                        'INSERT INTO documents (title, content, embedding) VALUES ($1, $2, $3::vector)',
                        [title, content, vectorLiteral]
                    );
                }

                ctx.sendJson(
                    201,
                    okEnvelope('rag.ingest', 'Ingested document into Raw-RAG index', {
                        title,
                        dimensions: vector.length,
                        totalWindows: ragStatus.totalWindows
                    })
                );
            },
            'POST /api/search': async (ctx) => {
                const queryText = String(ctx.body?.query || '').trim();
                if (!queryText) {
                    ctx.sendJson(400, errorEnvelope('VALIDATION_ERROR', 'Field "query" is required', null, 'rag.search'));
                    return;
                }

                const ragHits = await rawRag.retrieve(queryText);
                let pgRows = [];
                if (pgWrapper) {
                    const queryVec = await embed(queryText, {
                        model: config.embedModel,
                        dimensions: config.embedDims,
                        host: config.embedHost,
                        mode: 'query',
                        mock: offline
                    });
                    const searchRes = await pgVectorSearch(pgWrapper, {
                        table: 'documents',
                        vector: queryVec,
                        selectColumns: ['id', 'title', 'content'],
                        expectedDims: config.embedDims,
                        limit: 5
                    });
                    pgRows = searchRes.data.rows;
                }

                return okEnvelope('rag.search', 'Retrieved RAG evidence', {
                    contextText: ragHits.contextText,
                    windowCount: ragHits.selectedWindows.length,
                    pgRows
                });
            }
        }
    });

    return { server, rawRag };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
    const logger = setupLogging(config.serviceName, { logDir: config.logDir });
    const pgWrapper = createPgPool(config.db, { serviceName: config.serviceName, logger });
    await runSqlMigrations(pgWrapper, MIGRATIONS);
    const { server } = buildRagServer({ pgWrapper, logger });
    server.listen(config.port, () => {
        logger.info(\`\${config.serviceName} listening on port \${config.port}\`);
    });
    attachGracefulShutdown(server, [() => pgWrapper.close()], { logger });
}
`,
        '.env.example': `PORT=${resolvedPort}
SERVICE_NAME=${slug}
EMBED_MODEL=snowflake-arctic-embed2
EMBED_DIMS=1024
OLLAMA_EMBED_HOST=http://127.0.0.1:11434
DATABASE_URL=postgresql://postgres:changeme@127.0.0.1:5432/${dbName}
# OS Drive Protection: point PG_DATA_DIR and DATA_DIR to dedicated non-OS storage volumes
PG_DATA_DIR=./data/postgres
DATA_DIR=./data
`,
        '.dockerignore': renderScaffoldDockerignore(),
        'docker-compose.yml': `# OS Drive Protection (INV-LEGO-04):
# Point PG_DATA_DIR and DATA_DIR to dedicated non-OS storage volumes in production.
services:
  db:
    image: pgvector/pgvector:pg16
    container_name: ${slug}-db
    restart: unless-stopped
    environment:
      POSTGRES_USER: \${DB_USER:-postgres}
      POSTGRES_PASSWORD: \${DB_PASSWORD:-changeme}
      POSTGRES_DB: \${DB_NAME:-${dbName}}
    ports:
      - "\${DB_PORT:-5432}:5432"
    volumes:
      - \${PG_DATA_DIR:-./data/postgres}:/var/lib/postgresql/data

  app:
    build:
      context: .
      additional_contexts:
        krusch_toolkit: ../../lib
        krusch_cascade_router: ../../projects/krusch-cascade-router
    container_name: ${slug}-app
    restart: unless-stopped
    depends_on:
      - db
    ports:
      - "\${PORT:-${resolvedPort}}:${resolvedPort}"
    environment:
      PORT: "${resolvedPort}"
      DB_HOST: db
      DB_PORT: "5432"
      EMBED_MODEL: snowflake-arctic-embed2
      EMBED_DIMS: "1024"
      LOG_DIR: /app/data/logs
    volumes:
      - \${DATA_DIR:-./data}:/app/data
`,
        'Dockerfile': renderNodeScaffoldDockerfile(slug, { port: resolvedPort }),
        '.github/workflows/ci.yml': renderGithubNodeCi('      - run: node --check src/server.js'),
        'tests/smoke.test.js': `import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRagServer } from '../src/server.js';

test('${slug} hermetic 1024d ingest and search smoke test', async (t) => {
    const { server } = buildRagServer({ offline: true });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
        await new Promise((resolve) => server.close(resolve));
    });

    const { port } = server.address();
    const baseUrl = \`http://127.0.0.1:\${port}\`;

    const ingestRes = await fetch(\`\${baseUrl}/api/ingest\`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            title: 'ArchitectureSpec',
            content: 'Persistent PostgreSQL vectors reside on /var/lib/postgresql/data with snowflake-arctic-embed2 1024 dimensions.'
        })
    });
    assert.equal(ingestRes.status, 201);
    const ingestBody = await ingestRes.json();
    assert.equal(ingestBody.ok, true);
    assert.equal(ingestBody.data.dimensions, 1024);

    const searchRes = await fetch(\`\${baseUrl}/api/search\`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'Where do persistent PostgreSQL vectors reside?' })
    });
    assert.equal(searchRes.status, 200);
    const searchBody = await searchRes.json();
    assert.equal(searchBody.ok, true);
    assert.ok(searchBody.data.contextText.includes('/var/lib/postgresql/data'));
});
`
    };
}

function renderMcpStdioServerFiles({ projectName = 'krusch-mcp-server', port = 3000 } = {}) {
    const slug = normalizeSlug(projectName);
    const displayTitle = sanitizeInlineTitle(projectName, slug);
    const toolPrefix = slug.replace(/-/g, '_');
    const resolvedPort = normalizePort(port, 3000);

    return {
        'AGENTS.md': `# ${displayTitle} (\`AGENTS.md\`)

Node 22 ESM MCP stdio server stamped from the \`mcp-stdio-server\` Lego archetype.

## Stack & Toolkit Bricks
- \`@krusch/toolkit/mcp\` (\`defineMcpTool\`, \`createMcpServer\`, \`okMcpResult\`, \`errorMcpResult\`)
- Enforces \`INV-STACK-03\` (4-boolean MCP annotations + \`title\` on every tool) and \`INV-LEGO-01\` JSON envelopes.
- Author all commits as \`kruschdev <kruschdev@users.noreply.github.com>\`.
`,
        'LICENSE': renderMitLicense(),
        'package.json': `${JSON.stringify(
            {
                name: slug,
                version: '0.1.0',
                type: 'module',
                description: `${displayTitle} — Stdio MCP server built on @krusch/toolkit/mcp`,
                author: 'kruschdev <kruschdev@users.noreply.github.com>',
                license: 'MIT',
                bin: {
                    [slug]: './src/index.js'
                },
                engines: { node: '>=22.0.0' },
                scripts: {
                    start: 'node src/index.js',
                    test: 'node --test tests/*.test.js'
                },
                dependencies: {
                    '@krusch/toolkit': 'file:../../lib'
                }
            },
            null,
            2
        )}\n`,
        'src/index.js': `#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    defineMcpTool,
    createMcpServer,
    okMcpResult,
    errorMcpResult
} from '@krusch/toolkit/mcp';

export const SERVER_NAME = '${slug}';
export const SERVER_VERSION = '0.1.0';

export const TOOLS = [
    defineMcpTool({
        name: '${toolPrefix}_ping',
        title: 'Ping Service Health',
        description: 'Return deterministic MCP health metadata and echo payload.',
        inputSchema: {
            type: 'object',
            properties: {
                message: { type: 'string', description: 'Optional echo message' }
            }
        },
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
    })
];

export async function handleToolCall(name, args = {}) {
    if (name === '${toolPrefix}_ping') {
        return okMcpResult(name, 'MCP server healthy', {
            server: SERVER_NAME,
            version: SERVER_VERSION,
            echo: args?.message ?? 'pong'
        });
    }
    return errorMcpResult(name, 'UNKNOWN_TOOL', \`Unknown MCP tool: \${name}\`);
}

export async function startServer(options = {}) {
    return createMcpServer(SERVER_NAME, SERVER_VERSION, TOOLS, handleToolCall, options);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
    await startServer();
}
`,
        '.env.example': `LOG_DIR=./logs
DATA_DIR=./data
PORT=${resolvedPort}
`,
        '.dockerignore': renderScaffoldDockerignore(),
        'docker-compose.yml': `# OS Drive Protection (INV-LEGO-04):
# Point DATA_DIR to a dedicated non-OS storage volume in production.
services:
  mcp:
    build:
      context: .
      additional_contexts:
        krusch_toolkit: ../../lib
        krusch_cascade_router: ../../projects/krusch-cascade-router
    container_name: ${slug}
    stdin_open: true
    environment:
      LOG_DIR: /app/data/logs
    volumes:
      - \${DATA_DIR:-./data}:/app/data
`,
        'Dockerfile': renderNodeScaffoldDockerfile(slug, { cmd: '["node", "src/index.js"]' }),
        '.github/workflows/ci.yml': renderGithubNodeCi('      - run: node --check src/index.js'),
        'tests/mcp.test.js': `import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS, handleToolCall, startServer } from '../src/index.js';

test('${slug} enforces INV-STACK-03 4-boolean annotations and connect: false startup', async () => {
    assert.equal(TOOLS.length, 1);
    const [tool] = TOOLS;
    assert.equal(typeof tool.annotations?.title, 'string');
    assert.equal(typeof tool.annotations?.readOnlyHint, 'boolean');
    assert.equal(typeof tool.annotations?.destructiveHint, 'boolean');
    assert.equal(typeof tool.annotations?.idempotentHint, 'boolean');
    assert.equal(typeof tool.annotations?.openWorldHint, 'boolean');

    const serverInstance = await startServer({ connect: false });
    assert.ok(serverInstance);

    const result = await handleToolCall(tool.name, { message: 'hello-mcp' });
    assert.ok(Array.isArray(result.content));
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.data.echo, 'hello-mcp');
});
`
    };
}

function renderFullstackReactViteFiles({ projectName = 'krusch-fullstack', port = 3000 } = {}) {
    const slug = normalizeSlug(projectName);
    const displayTitle = sanitizeInlineTitle(projectName, slug);
    const htmlTitle = escapeHtmlText(displayTitle);
    const resolvedPort = normalizePort(port, 3000);
    const vitePort = resolvedPort === 5173 ? 5174 : 5173;

    return {
        'AGENTS.md': `# ${displayTitle} (\`AGENTS.md\`)

Full-stack Node 22 ESM + Vite React application stamped from the \`fullstack-react-vite\` Lego archetype.

## Stack & Toolkit Bricks
- Backend: \`@krusch/toolkit/http\`, \`@krusch/toolkit/streaming\` (\`sseResponse\`), \`@krusch/toolkit/db\`, \`@krusch/toolkit/config\`, \`@krusch/toolkit/log\`
- Frontend: \`@krusch/toolkit/react\` (\`AppShell\`, \`StatusPill\`, \`MetricCard\`, \`useApiQuery\`, \`useSSEStream\`)
- **OS Drive Protection**: Point \`DATA_DIR\` to a dedicated non-OS storage volume in production.
- **GitHub Attribution**: Author all commits as \`kruschdev <kruschdev@users.noreply.github.com>\`.
`,
        'package.json': `${JSON.stringify(
            {
                name: slug,
                version: '0.1.0',
                private: true,
                type: 'module',
                description: `${displayTitle} — Full-stack Node 22 + React Vite service built on @krusch/toolkit`,
                author: 'kruschdev <kruschdev@users.noreply.github.com>',
                license: 'MIT',
                engines: { node: '>=22.0.0' },
                scripts: {
                    start: 'node src/server.js',
                    dev: 'node --watch src/server.js',
                    'client:dev': 'npm --prefix client run dev',
                    'client:build': 'npm --prefix client run build',
                    test: 'node --test tests/*.test.js'
                },
                dependencies: {
                    '@krusch/toolkit': 'file:../../lib'
                }
            },
            null,
            2
        )}\n`,
        'config.json': `${JSON.stringify(
            {
                port: resolvedPort,
                serviceName: slug,
                dbPath: './data/app.db',
                logDir: './logs'
            },
            null,
            2
        )}\n`,
        'src/config.js': `import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProjectConfig, envOr, envInt } from '@krusch/toolkit/config';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseConfig = await loadProjectConfig(projectRoot, {
    port: ${resolvedPort},
    serviceName: '${slug}',
    dbPath: './data/app.db',
    logDir: './logs'
});

export const config = Object.freeze({
    port: envInt('PORT', baseConfig.port, ${resolvedPort}),
    serviceName: envOr('SERVICE_NAME', baseConfig.serviceName, '${slug}'),
    dbPath: envOr('DB_PATH', baseConfig.dbPath, './data/app.db'),
    logDir: envOr('LOG_DIR', baseConfig.logDir, './logs')
});
`,
        'src/server.js': `import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApiServer, attachGracefulShutdown, okEnvelope } from '@krusch/toolkit/http';
import { sseResponse } from '@krusch/toolkit/streaming';
import { initDb, exec, query, run, closeDb } from '@krusch/toolkit/db';
import { setupLogging } from '@krusch/toolkit/log';
import { config } from './config.js';

export function buildServer({ dbPath = config.dbPath, logger = null } = {}) {
    const activeLogger = logger || setupLogging(config.serviceName, { logDir: config.logDir, console: false });
    initDb(dbPath);
    exec(\`
        CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            label TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
    \`);

    const server = createApiServer({
        serviceName: config.serviceName,
        version: '0.1.0',
        logger: activeLogger,
        routes: {
            'GET /api/metrics': () => {
                const row = query('SELECT COUNT(*) AS count FROM events')[0];
                return okEnvelope('metrics.read', 'Loaded dashboard metrics', {
                    service: config.serviceName,
                    eventCount: row?.count ?? 0
                });
            },
            'POST /api/stream': (ctx) => {
                const prompt = String(ctx.body?.prompt || 'ping').trim();
                run('INSERT INTO events (label) VALUES (?)', [prompt]);
                const sse = sseResponse(ctx.res, ctx.req);
                if (!sse.signal.aborted) {
                    sse.sendToken(\`Processed: \${prompt}\`);
                    sse.done(okEnvelope('stream.complete', 'SSE stream finished', { prompt }));
                }
            }
        }
    });

    return { server, close: () => closeDb() };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
    const logger = setupLogging(config.serviceName, { logDir: config.logDir });
    const { server, close } = buildServer({ logger });
    server.listen(config.port, () => {
        logger.info(\`\${config.serviceName} listening on port \${config.port}\`);
    });
    attachGracefulShutdown(server, [close], { logger });
}
`,
        'client/package.json': `${JSON.stringify(
            {
                name: `${slug}-client`,
                version: '0.1.0',
                private: true,
                type: 'module',
                scripts: {
                    dev: 'vite',
                    build: 'vite build',
                    preview: 'vite preview'
                },
                dependencies: {
                    '@krusch/toolkit': 'file:../../../lib',
                    react: '^19.0.0',
                    'react-dom': '^19.0.0'
                },
                devDependencies: {
                    '@vitejs/plugin-react': '^4.3.0',
                    vite: '^6.0.0'
                }
            },
            null,
            2
        )}\n`,
        'client/index.html': `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${htmlTitle}</title>
  </head>
  <body class="bg-slate-950 text-slate-100">
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
`,
        'client/vite.config.js': `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
    plugins: [react()],
    server: {
        port: ${vitePort},
        proxy: {
            '/api': 'http://127.0.0.1:${resolvedPort}',
            '/health': 'http://127.0.0.1:${resolvedPort}'
        }
    }
});
`,
        'client/src/main.jsx': `import React from 'react';
import { createRoot } from 'react-dom/client';
import { setReactRuntime } from '@krusch/toolkit/react';
import App from './App.jsx';

setReactRuntime(React);
createRoot(document.getElementById('root')).render(<App />);
`,
        'client/src/App.jsx': `import React from 'react';
import {
    AppShell,
    StatusPill,
    MetricCard,
    useApiQuery,
    useSSEStream
} from '@krusch/toolkit/react';

export default function App() {
    const { data, loading, reload } = useApiQuery('/api/metrics');
    const stream = useSSEStream('/api/stream');

    async function handleRunStream() {
        await stream.start({ prompt: 'status-check' });
        reload();
    }

    return (
        <AppShell
            title={${JSON.stringify(displayTitle)}}
            subtitle="Lego Full-Stack Starter"
            status={loading ? 'streaming' : 'healthy'}
        >
            <div className="grid gap-4 md:grid-cols-2">
                <MetricCard title="Recorded Events" value={data?.eventCount ?? 0} status="healthy" />
                <div className="rounded-xl border border-slate-800 p-4">
                    <div className="mb-2 flex items-center justify-between">
                        <button type="button" onClick={handleRunStream}>
                            Trigger SSE Stream
                        </button>
                        <StatusPill status={stream.status === 'streaming' ? 'streaming' : 'healthy'} />
                    </div>
                    <pre className="mt-2 text-xs">{stream.text}</pre>
                </div>
            </div>
        </AppShell>
    );
}
`,
        '.env.example': `PORT=${resolvedPort}
SERVICE_NAME=${slug}
DB_PATH=./data/app.db
# Point DATA_DIR to a dedicated non-OS storage volume in production
DATA_DIR=./data
LOG_DIR=./logs
`,
        '.dockerignore': renderScaffoldDockerignore(),
        'docker-compose.yml': `# OS Drive Protection (INV-LEGO-04):
# Point DATA_DIR to a dedicated non-OS storage volume in production.
services:
  app:
    build:
      context: .
      additional_contexts:
        krusch_toolkit: ../../lib
        krusch_cascade_router: ../../projects/krusch-cascade-router
    container_name: ${slug}
    restart: unless-stopped
    ports:
      - "\${PORT:-${resolvedPort}}:${resolvedPort}"
    environment:
      PORT: "${resolvedPort}"
      DB_PATH: /app/data/app.db
      LOG_DIR: /app/data/logs
    volumes:
      - \${DATA_DIR:-./data}:/app/data
`,
        'Dockerfile': renderNodeScaffoldDockerfile(slug, { port: resolvedPort }),
        '.github/workflows/ci.yml': renderGithubNodeCi('      - run: node --check src/server.js'),
        'tests/smoke.test.js': `import test from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from '../src/server.js';

test('${slug} metrics + SSE stream smoke flow', async (t) => {
    const { server, close } = buildServer({ dbPath: ':memory:' });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
        await new Promise((resolve) => server.close(resolve));
        close();
    });

    const { port } = server.address();
    const baseUrl = \`http://127.0.0.1:\${port}\`;

    const streamRes = await fetch(\`\${baseUrl}/api/stream\`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'hello-sse' })
    });
    assert.equal(streamRes.status, 200);
    assert.match(streamRes.headers.get('content-type') || '', /text\\/event-stream/);
    const rawSse = await streamRes.text();
    assert.ok(rawSse.includes('hello-sse'));

    const metricsRes = await fetch(\`\${baseUrl}/api/metrics\`);
    assert.equal(metricsRes.status, 200);
    const metricsBody = await metricsRes.json();
    assert.equal(metricsBody.ok, true);
    assert.equal(metricsBody.data.eventCount, 1);
});
`
    };
}

function renderPythonFastapiServiceFiles({ projectName = 'krusch-fastapi', port = 8000 } = {}) {
    const slug = normalizeSlug(projectName);
    const displayTitle = sanitizeInlineTitle(projectName, slug);
    const pyDocTitle = escapePythonDocstring(displayTitle);
    const tomlDescription = JSON.stringify(`${displayTitle} — FastAPI service built on krusch_toolkit`);
    const resolvedPort = normalizePort(port, 8000);

    return {
        'AGENTS.md': `# ${displayTitle} (\`AGENTS.md\`)

Python 3.12 FastAPI service stamped from the \`python-fastapi-service\` Lego archetype.

## Stack & Toolkit Bricks
- \`krusch_toolkit.fastapi_app\` (\`create_fastapi_app\`, \`ok_envelope\`, \`sse_event_response\`)
- \`krusch_toolkit.config\` (\`load_project_config\`, \`env_int\`, \`env_or\`)
- \`krusch_toolkit.log\` (\`setup_logging\`)

## Operational Rules
- **OS Drive Protection**: Point \`DATA_DIR\` to a dedicated non-OS storage volume in production.
- **GitHub Attribution**: Author all commits as \`kruschdev <kruschdev@users.noreply.github.com>\`.

## Commands
\`\`\`bash
pip install -e "../../lib-py[fastapi]"
pip install -e ".[dev]"
pytest
uvicorn app.main:app --host 127.0.0.1 --port ${resolvedPort}
\`\`\`
`,
        'pyproject.toml': `[build-system]
requires = ["setuptools>=68.0", "wheel"]
build-backend = "setuptools.build_meta"

[project]
name = "${slug}"
version = "0.1.0"
description = ${tomlDescription}
requires-python = ">=3.12"
authors = [
  { name = "kruschdev", email = "kruschdev@users.noreply.github.com" }
]
dependencies = [
  "fastapi>=0.115.0",
  "uvicorn[standard]>=0.30.0",
  "pydantic>=2.8.0",
  "python-dotenv>=1.0.1"
]

[project.optional-dependencies]
dev = [
  "pytest>=8.0.0",
  "httpx>=0.27.0"
]

[tool.setuptools.packages.find]
include = ["app*"]
`,
        'app/__init__.py': `"""${pyDocTitle} FastAPI service package."""

from .main import app, build_app

__all__ = ["app", "build_app"]
`,
        'app/main.py': `"""${pyDocTitle} entrypoint powered by krusch_toolkit.fastapi_app."""

from pathlib import Path
from fastapi import Request
from krusch_toolkit.config import env_int, env_or, load_project_config
from krusch_toolkit.fastapi_app import create_fastapi_app, ok_envelope, sse_event_response
from krusch_toolkit.log import setup_logging

PROJECT_ROOT = Path(__file__).resolve().parent.parent
BASE_CONFIG = load_project_config(str(PROJECT_ROOT))
SERVICE_NAME = env_or("SERVICE_NAME", BASE_CONFIG.get("service_name"), "${slug}")
PORT = env_int("PORT", BASE_CONFIG.get("port"), ${resolvedPort})
LOG_DIR = env_or("LOG_DIR", BASE_CONFIG.get("log_dir"), str(PROJECT_ROOT / "logs"))


def build_app():
    setup_logging(SERVICE_NAME, log_dir=LOG_DIR, console=False)
    service = create_fastapi_app(title=SERVICE_NAME, version="0.1.0")

    @service.get("/api/status")
    async def service_status():
        return ok_envelope(
            "service.status",
            f"{SERVICE_NAME} ready",
            {"service": SERVICE_NAME, "port": PORT},
        )

    @service.get("/api/stream")
    async def service_stream(request: Request):
        async def _events():
            yield {"event": "token", "data": {"delta": "ready"}}
            yield {"event": "done", "data": ok_envelope("service.stream", "Stream complete", {})}

        return sse_event_response(_events(), request=request)

    return service


app = build_app()
`,
        '.env.example': `PORT=${resolvedPort}
SERVICE_NAME=${slug}
# Point DATA_DIR to a dedicated non-OS storage volume in production
DATA_DIR=./data
LOG_DIR=./logs
`,
        '.dockerignore': renderScaffoldDockerignore(),
        'docker-compose.yml': `# OS Drive Protection (INV-LEGO-04):
# Point DATA_DIR to a dedicated non-OS storage volume in production.
services:
  app:
    build:
      context: .
      additional_contexts:
        krusch_toolkit_py: ../../lib-py
    container_name: ${slug}
    restart: unless-stopped
    ports:
      - "\${PORT:-${resolvedPort}}:${resolvedPort}"
    environment:
      PORT: "${resolvedPort}"
      SERVICE_NAME: "${slug}"
      LOG_DIR: /app/data/logs
    volumes:
      - \${DATA_DIR:-./data}:/app/data
`,
        'Dockerfile': `FROM python:3.12-slim
WORKDIR /app
COPY --from=krusch_toolkit_py . /krusch-lib-py
COPY pyproject.toml ./
COPY app ./app
RUN pip install --no-cache-dir "/krusch-lib-py[fastapi]" .
EXPOSE ${resolvedPort}
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "${resolvedPort}"]
`,
        '.github/workflows/ci.yml': `name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'
      - run: python -m py_compile app/__init__.py app/main.py tests/test_smoke.py
`,
        'tests/test_smoke.py': `"""Smoke tests for ${pyDocTitle}."""

from fastapi.testclient import TestClient
from app.main import build_app


def test_health_and_status_envelopes():
    client = TestClient(build_app())

    health = client.get("/health")
    assert health.status_code == 200
    assert health.json()["ok"] is True

    status = client.get("/api/status")
    assert status.status_code == 200
    body = status.json()
    assert body["ok"] is True
    assert body["data"]["service"] == "${slug}"
`
    };
}

function renderNodeTsServiceFiles({ projectName = 'krusch-ts-api', port = 3000 } = {}) {
    const slug = normalizeSlug(projectName);
    const displayTitle = sanitizeInlineTitle(projectName, slug);
    const resolvedPort = normalizePort(port, 3000);

    return {
        'AGENTS.md': `# ${displayTitle} (\`AGENTS.md\`)

Node 22 Zero-Build TypeScript API service stamped from the \`node-ts-service\` Lego archetype (\`--experimental-strip-types\`).

## Stack & Toolkit Bricks
- \`@krusch/toolkit/http\` (\`createApiServer\`, \`attachGracefulShutdown\`, \`okEnvelope\`, \`errorEnvelope\`, \`ApiRouteContext\`)
- \`@krusch/toolkit/db\` (\`initDb\`, \`exec\`, \`query\`, \`run\`, \`closeDb\`)
- \`@krusch/toolkit/config\` (\`loadProjectConfig\`, \`envOr\`, \`envInt\`)
- \`@krusch/toolkit/log\` (\`setupLogging\`)

## Operational Rules
- **OS Drive Protection**: Mount persistent SQLite data from a dedicated data volume via \`DATA_DIR\` rather than the OS boot drive.
- **GitHub Attribution**: Author all commits as \`kruschdev <kruschdev@users.noreply.github.com>\`.

## Commands
\`\`\`bash
npm install
npm run typecheck
npm test
npm start
\`\`\`
`,
        'package.json': `${JSON.stringify(
            {
                name: slug,
                version: '0.1.0',
                private: true,
                type: 'module',
                description: `${displayTitle} — Node 22 Zero-Build TypeScript SQLite API built on @krusch/toolkit`,
                author: 'kruschdev <kruschdev@users.noreply.github.com>',
                license: 'MIT',
                engines: { node: '>=22.6.0' },
                scripts: {
                    start: 'node --experimental-strip-types src/server.ts',
                    dev: 'node --watch --experimental-strip-types src/server.ts',
                    typecheck: 'tsc --noEmit',
                    test: 'node --experimental-strip-types --test tests/*.test.ts'
                },
                dependencies: {
                    '@krusch/toolkit': 'file:../../lib'
                },
                devDependencies: {
                    '@types/node': '^22.0.0',
                    typescript: '^5.7.0'
                }
            },
            null,
            2
        )}\n`,
        'tsconfig.json': `${JSON.stringify(
            {
                compilerOptions: {
                    target: 'ES2022',
                    module: 'NodeNext',
                    moduleResolution: 'NodeNext',
                    strict: true,
                    noEmit: true,
                    allowImportingTsExtensions: true,
                    verbatimModuleSyntax: true,
                    skipLibCheck: true
                },
                include: ['src/**/*.ts', 'tests/**/*.ts']
            },
            null,
            2
        )}\n`,
        'config.json': `${JSON.stringify(
            {
                port: resolvedPort,
                serviceName: slug,
                dbPath: './data/app.db',
                logDir: './logs'
            },
            null,
            2
        )}\n`,
        'src/config.ts': `import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProjectConfig, envOr, envInt } from '@krusch/toolkit/config';

export interface AppConfig {
    readonly port: number;
    readonly serviceName: string;
    readonly dbPath: string;
    readonly logDir: string;
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaults: AppConfig = {
    port: ${resolvedPort},
    serviceName: '${slug}',
    dbPath: './data/app.db',
    logDir: './logs'
};

const baseConfig = await loadProjectConfig<AppConfig>(projectRoot, defaults);

export const config: AppConfig = Object.freeze({
    port: envInt('PORT', baseConfig.port, ${resolvedPort}),
    serviceName: envOr('SERVICE_NAME', baseConfig.serviceName, '${slug}'),
    dbPath: envOr('DB_PATH', baseConfig.dbPath, './data/app.db'),
    logDir: envOr('LOG_DIR', baseConfig.logDir, './logs')
});
`,
        'src/server.ts': `import type { Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    createApiServer,
    attachGracefulShutdown,
    okEnvelope,
    errorEnvelope,
    type ApiRouteContext,
    type HttpLoggerLike
} from '@krusch/toolkit/http';
import { initDb, exec, query, run, closeDb } from '@krusch/toolkit/db';
import { setupLogging } from '@krusch/toolkit/log';
import { config } from './config.ts';

export interface ItemRow {
    id: number;
    title: string;
    created_at: string;
}

export interface CreateItemBody {
    title?: string;
}

export interface BuiltServer {
    server: Server;
    close: () => void;
}

export function buildServer({
    dbPath = config.dbPath,
    serviceName = config.serviceName,
    logger = null
}: {
    dbPath?: string;
    serviceName?: string;
    logger?: HttpLoggerLike | null;
} = {}): BuiltServer {
    const activeLogger = logger || setupLogging(serviceName, { logDir: config.logDir, console: false });
    initDb(dbPath);
    exec(\`
        CREATE TABLE IF NOT EXISTS items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
    \`);

    const server = createApiServer({
        serviceName,
        version: '0.1.0',
        logger: activeLogger,
        healthCheck: () => {
            const row = query<{ count: number }>('SELECT COUNT(*) AS count FROM items')[0];
            return { db: 'ok', items: row?.count ?? 0 };
        },
        routes: {
            'GET /api/items': () => {
                const items = query<ItemRow>('SELECT id, title, created_at FROM items ORDER BY id DESC');
                return okEnvelope('items.list', \`Returned \${items.length} item(s)\`, { items });
            },
            'POST /api/items': (ctx: ApiRouteContext<CreateItemBody>) => {
                const title = String(ctx.body?.title || '').trim();
                if (!title) {
                    ctx.sendJson(400, errorEnvelope('VALIDATION_ERROR', 'Field "title" is required', null, 'items.create'));
                    return;
                }
                const result = run('INSERT INTO items (title) VALUES (?)', [title]);
                ctx.sendJson(
                    201,
                    okEnvelope('items.create', 'Created item', {
                        id: result.lastInsertRowid,
                        title
                    })
                );
            }
        }
    });

    return { server, close: () => closeDb() };
}

const isMain = Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
    const logger = setupLogging(config.serviceName, { logDir: config.logDir });
    const { server, close } = buildServer({ logger });
    server.listen(config.port, () => {
        logger.info(\`\${config.serviceName} listening on port \${config.port}\`);
    });
    attachGracefulShutdown(server, [close], { logger });
}
`,
        '.env.example': `PORT=${resolvedPort}
SERVICE_NAME=${slug}
DB_PATH=./data/app.db
# Point DATA_DIR to a dedicated non-OS storage volume in production
DATA_DIR=./data
LOG_DIR=./logs
`,
        '.dockerignore': renderScaffoldDockerignore(),
        'docker-compose.yml': `# OS Drive Protection (INV-LEGO-04):
# Never store persistent SQLite databases, Docker volumes, or model caches on OS root drives.
# Point DATA_DIR to a dedicated non-OS storage volume in production.
services:
  app:
    build:
      context: .
      additional_contexts:
        krusch_toolkit: ../../lib
        krusch_cascade_router: ../../projects/krusch-cascade-router
    container_name: ${slug}
    restart: unless-stopped
    ports:
      - "\${PORT:-${resolvedPort}}:${resolvedPort}"
    environment:
      PORT: "${resolvedPort}"
      DB_PATH: /app/data/app.db
      LOG_DIR: /app/data/logs
    volumes:
      - \${DATA_DIR:-./data}:/app/data
`,
        'Dockerfile': renderNodeScaffoldDockerfile(slug, {
            port: resolvedPort,
            cmd: '["node", "--experimental-strip-types", "src/server.ts"]'
        }),
        '.github/workflows/ci.yml': renderGithubNodeCi('      - run: npm run typecheck'),
        'tests/smoke.test.ts': `import test from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from '../src/server.ts';

test('${slug} TypeScript /health and /api/items smoke flow', async (t) => {
    const { server, close } = buildServer({ dbPath: ':memory:' });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    t.after(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        close();
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('Expected bound TCP AddressInfo');
    }
    const baseUrl = \`http://127.0.0.1:\${address.port}\`;

    const healthRes = await fetch(\`\${baseUrl}/health\`);
    assert.equal(healthRes.status, 200);
    const healthBody = (await healthRes.json()) as { ok: boolean };
    assert.equal(healthBody.ok, true);

    const createRes = await fetch(\`\${baseUrl}/api/items\`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Typed Lego item' })
    });
    assert.equal(createRes.status, 201);
    const createBody = (await createRes.json()) as { ok: boolean; data: { title: string } };
    assert.equal(createBody.ok, true);
    assert.equal(createBody.data.title, 'Typed Lego item');
});
`
    };
}

function renderCloudflareWorkerFiles({ projectName = 'krusch-worker', port = 8787 } = {}) {
    const slug = normalizeSlug(projectName);
    const displayTitle = sanitizeInlineTitle(projectName, slug);
    const resolvedPort = normalizePort(port, 8787);

    return {
        'AGENTS.md': `# ${displayTitle} (\`AGENTS.md\`)

Cloudflare Workers edge service stamped from the \`cloudflare-worker\` Lego archetype (\`INV-LEGO-08\`, zero \`node:*\` imports).

## Stack & Toolkit Bricks
- \`@krusch/toolkit/edge\` (\`createEdgeRouter\`, \`createEdgeKvJsonStore\`, \`edgeSseResponse\`, \`readBoundedEdgeJson\`)

## Operational Rules
- **Web-Standards Purity**: Keep \`src/worker.js\` 100% free of \`node:*\` imports so V8 isolates run without Node compatibility shims.
- **GitHub Attribution**: Author all commits as \`kruschdev <kruschdev@users.noreply.github.com>\`.

## Commands
\`\`\`bash
npm install
npm test
npx wrangler dev --port ${resolvedPort}
\`\`\`
`,
        'package.json': `${JSON.stringify(
            {
                name: slug,
                version: '0.1.0',
                private: true,
                type: 'module',
                description: `${displayTitle} — Zero-node:* Cloudflare Worker built on @krusch/toolkit/edge`,
                author: 'kruschdev <kruschdev@users.noreply.github.com>',
                license: 'MIT',
                engines: { node: '>=22.0.0' },
                scripts: {
                    dev: `wrangler dev --port ${resolvedPort}`,
                    deploy: 'wrangler deploy',
                    test: 'node --test tests/*.test.js'
                },
                dependencies: {
                    '@krusch/toolkit': 'file:../../lib'
                },
                devDependencies: {
                    wrangler: '^4.0.0'
                }
            },
            null,
            2
        )}\n`,
        'wrangler.jsonc': `${JSON.stringify(
            {
                name: slug,
                main: 'src/worker.js',
                compatibility_date: '2026-10-01',
                observability: { enabled: true },
                vars: {
                    SERVICE_NAME: slug
                }
            },
            null,
            2
        )}\n`,
        'src/worker.js': `import {
    createEdgeRouter,
    createEdgeKvJsonStore,
    edgeSseResponse
} from '@krusch/toolkit/edge';

export function buildWorker({ serviceName = '${slug}' } = {}) {
    let fallbackKv = null;
    const resolveStore = (env) => {
        if (env?.STATE_KV) {
            return createEdgeKvJsonStore(env.STATE_KV, { prefix: 'items:' });
        }
        if (!fallbackKv) {
            fallbackKv = createEdgeKvJsonStore(null, { prefix: 'items:' });
        }
        return fallbackKv;
    };

    return createEdgeRouter({
        serviceName,
        version: '0.1.0',
        routes: {
            'GET /api/items': async ({ env, ok }) => {
                const store = resolveStore(env);
                const listed = await store.list({ limit: 50 });
                const items = [];
                for (const key of listed.keys) {
                    const item = await store.get(key);
                    if (item) items.push(item);
                }
                return ok(\`Returned \${items.length} item(s)\`, { items });
            },
            'POST /api/items': async ({ env, body, ok, fail }) => {
                const title = String(body?.title || '').trim();
                if (!title) {
                    return fail('VALIDATION_ERROR', 'Field "title" is required', { status: 400 });
                }
                const id = globalThis.crypto.randomUUID();
                const record = { id, title, createdAt: new Date().toISOString() };
                const store = resolveStore(env);
                await store.put(id, record);
                return ok('Created edge item', record, { status: 201 });
            },
            'GET /api/stream': ({ request, corsHeaders }) =>
                edgeSseResponse(
                    async (sse) => {
                        sse.sendToken('Edge stream online');
                        sse.done('Stream complete', { service: serviceName });
                    },
                    { request, tool: \`\${serviceName}.sse\`, corsHeaders }
                )
        }
    });
}

const worker = buildWorker();
export default worker;
`,
        '.env.example': `PORT=${resolvedPort}
SERVICE_NAME=${slug}
DATA_DIR=./data
LOG_DIR=./logs
`,
        '.dockerignore': renderScaffoldDockerignore(),
        'docker-compose.yml': `# Local Wrangler / Edge preview container (OS Drive Protection INV-LEGO-04)
services:
  worker-preview:
    image: node:22-bookworm-slim
    working_dir: /app
    command: ["npx", "wrangler", "dev", "--ip", "0.0.0.0", "--port", "${resolvedPort}"]
    ports:
      - "\${PORT:-${resolvedPort}}:${resolvedPort}"
    environment:
      PORT: "${resolvedPort}"
      LOG_DIR: /app/data/logs
    volumes:
      - .:/app
      - \${DATA_DIR:-./data}:/app/data
`,
        '.github/workflows/ci.yml': renderGithubNodeCi('      - run: node --check src/worker.js'),
        'tests/smoke.test.js': `import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWorker } from '../src/worker.js';

test('${slug} Cloudflare Worker /health, KV CRUD, and SSE smoke flow', async () => {
    const worker = buildWorker();
    const env = {};

    const healthRes = await worker.fetch(new Request('https://edge.local/health'), env);
    assert.equal(healthRes.status, 200);
    const healthBody = await healthRes.json();
    assert.equal(healthBody.ok, true);

    const createRes = await worker.fetch(
        new Request('https://edge.local/api/items', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: 'Edge Lego item' })
        }),
        env
    );
    assert.equal(createRes.status, 201);
    const createBody = await createRes.json();
    assert.equal(createBody.ok, true);
    assert.equal(createBody.data.title, 'Edge Lego item');

    const listRes = await worker.fetch(new Request('https://edge.local/api/items'), env);
    assert.equal(listRes.status, 200);
    const listBody = await listRes.json();
    assert.equal(listBody.ok, true);
    assert.equal(listBody.data.items.length, 1);

    const sseRes = await worker.fetch(new Request('https://edge.local/api/stream'), env);
    assert.equal(sseRes.status, 200);
    const sseText = await sseRes.text();
    assert.match(sseText, /Edge stream online/);
});
`
    };
}

export const PROJECT_ARCHETYPES = Object.freeze({
    'node-api-sqlite': Object.freeze({
        id: 'node-api-sqlite',
        title: 'Node 22 ESM API + SQLite WAL',
        runtime: 'node',
        description: 'Zero-Express Node 22 ESM HTTP backend using @krusch/toolkit/http, SQLite WAL (@krusch/toolkit/db), layered config, and rotating JSON logs.',
        bricks: Object.freeze(['http', 'db', 'config', 'log']),
        renderFiles: renderNodeApiSqliteFiles
    }),
    'node-ts-service': Object.freeze({
        id: 'node-ts-service',
        title: 'Node 22 Zero-Build TypeScript API + SQLite WAL',
        runtime: 'node',
        description: 'Strict TypeScript Node 22 backend (--experimental-strip-types + tsconfig.json) wired to @krusch/toolkit/http and @krusch/toolkit/db.',
        bricks: Object.freeze(['http', 'db', 'config', 'log']),
        renderFiles: renderNodeTsServiceFiles
    }),
    'node-rag-pgvector': Object.freeze({
        id: 'node-rag-pgvector',
        title: 'Node 22 ESM Sovereign RAG + pgvector (1024d)',
        runtime: 'node',
        description: 'Sovereign RAG backend wiring @krusch/toolkit/pg, snowflake-arctic-embed2 (1024d) embeddings, and 256/32-tok Raw-RAG retrieval.',
        bricks: Object.freeze(['http', 'pg', 'embeddings', 'raw-rag', 'config', 'log']),
        renderFiles: renderNodeRagPgvectorFiles
    }),
    'mcp-stdio-server': Object.freeze({
        id: 'mcp-stdio-server',
        title: 'Node 22 ESM Stdio MCP Server',
        runtime: 'node',
        description: 'Stdio MCP server enforcing INV-STACK-03 4-boolean tool annotations and INV-LEGO-01 deterministic JSON envelopes.',
        bricks: Object.freeze(['mcp']),
        renderFiles: renderMcpStdioServerFiles
    }),
    'fullstack-react-vite': Object.freeze({
        id: 'fullstack-react-vite',
        title: 'Full-Stack Node 22 SSE API + Vite React Shell',
        runtime: 'react',
        description: 'Full-stack starter pairing a Node 22 SQLite + SSE backend with a Vite + React frontend powered by @krusch/toolkit/react.',
        bricks: Object.freeze(['http', 'streaming', 'db', 'config', 'log', 'react']),
        renderFiles: renderFullstackReactViteFiles
    }),
    'python-fastapi-service': Object.freeze({
        id: 'python-fastapi-service',
        title: 'Python 3.12 FastAPI Service',
        runtime: 'python',
        description: 'Python 3.12 FastAPI service using krusch_toolkit.fastapi_app envelopes, SSE helpers, layered config, and rotating JSON logs.',
        bricks: Object.freeze(['fastapi_app']),
        renderFiles: renderPythonFastapiServiceFiles
    }),
    'cloudflare-worker': Object.freeze({
        id: 'cloudflare-worker',
        title: 'Cloudflare Worker Edge Router + KV + SSE',
        runtime: 'edge',
        description: 'Zero-node:* Web-Standards Cloudflare Worker service using @krusch/toolkit/edge router, KV JSON store, and SSE streaming.',
        bricks: Object.freeze(['edge']),
        renderFiles: renderCloudflareWorkerFiles
    })
});

/**
 * List available Lego runtime bricks, optionally filtered by runtime ('node' | 'python' | 'react').
 *
 * @param {{ runtime?: string }} [options={}]
 * @returns {Array<object>}
 */
export function listLegoBricks({ runtime } = {}) {
    if (!runtime) return [...RUNTIME_BRICKS];
    const target = String(runtime).trim().toLowerCase();
    return RUNTIME_BRICKS.filter((brick) => brick.runtime === target);
}

/**
 * Look up a single Lego brick by id.
 *
 * @param {string} id
 * @returns {object | null}
 */
export function getLegoBrick(id) {
    const key = String(id || '').trim();
    if (!key) return null;
    return RUNTIME_BRICKS.find((brick) => brick.id === key) || null;
}

/**
 * List all frozen project archetypes, optionally filtered by runtime.
 *
 * @param {{ runtime?: string }} [options={}]
 * @returns {Array<object>}
 */
export function listArchetypes({ runtime } = {}) {
    const all = Object.values(PROJECT_ARCHETYPES);
    if (!runtime) return all;
    const target = String(runtime).trim().toLowerCase();
    return all.filter((arch) => arch.runtime === target);
}

/**
 * Look up a single project archetype by id.
 *
 * @param {string} id
 * @returns {object | null}
 */
export function getArchetype(id) {
    const key = String(id || '').trim();
    if (!key) return null;
    return Object.prototype.hasOwnProperty.call(PROJECT_ARCHETYPES, key)
        ? PROJECT_ARCHETYPES[key]
        : null;
}

const JS_REGEX_PREFIX_KEYWORDS = new Set([
    'return', 'throw', 'case', 'typeof', 'void', 'delete',
    'in', 'of', 'instanceof', 'yield', 'await', 'else', 'do'
]);

function inferIsPythonSource(code = '', filePath = '') {
    const fp = String(filePath || '').trim();
    if (/\.pyw?$/i.test(fp)) return true;
    if (/\.[cm]?[jt]sx?$/i.test(fp)) return false;
    return /^\s*(?:from\s+[a-zA-Z_][\w.]*\s+import\s+|import\s+(?:fastapi|yaml)\b|(?:async\s+)?def\s+[a-zA-Z_]\w*\s*\(|@[a-zA-Z_]\w*\.(?:get|post|put|delete|patch)\s*\()/m.test(
        String(code || '')
    );
}

function tryScanJsRegex(text, startIdx) {
    const len = text.length;
    let j = startIdx + 1;
    let inCharClass = false;
    while (j < len) {
        const c = text[j];
        if (c === '\n' || c === '\r') return -1;
        if (c === '\\') {
            if (j + 1 >= len || text[j + 1] === '\n' || text[j + 1] === '\r') return -1;
            j += 2;
            continue;
        }
        if (c === '[') {
            inCharClass = true;
            j += 1;
            continue;
        }
        if (c === ']' && inCharClass) {
            inCharClass = false;
            j += 1;
            continue;
        }
        if (c === '/' && !inCharClass) {
            j += 1;
            while (j < len && /[dgimsuvy]/.test(text[j])) j += 1;
            return j;
        }
        j += 1;
    }
    return -1;
}

function stripCommentLines(source = '', { isPython = false } = {}) {
    const text = String(source || '');
    if (!text) return '';
    let out = '';
    const len = text.length;
    let i = 0;
    let lastSigChar = '';
    let lastWord = '';
    let wordBuf = '';

    const templateBraceStack = [];

    const flushWord = () => {
        if (wordBuf) {
            lastWord = wordBuf;
            wordBuf = '';
        }
    };

    const scanTemplateBody = () => {
        while (i < len) {
            if (text[i] === '\\' && i + 1 < len) {
                out += text[i] + text[i + 1];
                i += 2;
                continue;
            }
            if (text[i] === '$' && text[i + 1] === '{') {
                out += '${';
                i += 2;
                templateBraceStack.push(0);
                lastSigChar = '{';
                lastWord = '';
                return;
            }
            if (text[i] === '`') {
                out += '`';
                i += 1;
                lastSigChar = '`';
                lastWord = '';
                return;
            }
            out += text[i];
            i += 1;
        }
        lastSigChar = '`';
        lastWord = '';
    };

    while (i < len) {
        const ch = text[i];
        const next = text[i + 1] || '';
        const next2 = text[i + 2] || '';

        if (!isPython && ch === '/' && next === '*') {
            flushWord();
            i += 2;
            while (i < len && !(text[i] === '*' && text[i + 1] === '/')) {
                if (text[i] === '\n') out += '\n';
                i += 1;
            }
            if (i < len) i += 2;
            continue;
        }

        if (!isPython && ch === '/' && next === '/') {
            flushWord();
            i += 2;
            while (i < len && text[i] !== '\n') i += 1;
            continue;
        }

        if (isPython && ch === '#') {
            flushWord();
            i += 1;
            while (i < len && text[i] !== '\n') i += 1;
            continue;
        }

        if (!isPython && i === 0 && ch === '#' && next === '!') {
            i += 2;
            while (i < len && text[i] !== '\n') i += 1;
            continue;
        }

        if (isPython && ((ch === "'" && next === "'" && next2 === "'") || (ch === '"' && next === '"' && next2 === '"'))) {
            flushWord();
            const delim = ch;
            out += delim + delim + delim;
            i += 3;
            while (i < len) {
                if (text[i] === '\\' && i + 1 < len) {
                    out += text[i] + text[i + 1];
                    i += 2;
                    continue;
                }
                if (text[i] === delim && text[i + 1] === delim && text[i + 2] === delim) {
                    out += delim + delim + delim;
                    i += 3;
                    break;
                }
                out += text[i];
                i += 1;
            }
            lastSigChar = delim;
            lastWord = '';
            continue;
        }

        if (!isPython && ch === '/' && next !== '/' && next !== '*' && (i === 0 || text[i - 1] !== '<')) {
            flushWord();
            const canStartRegex =
                lastSigChar === '' ||
                '(,[=:{;!&|?+-*~^%>'.includes(lastSigChar) ||
                (/[a-zA-Z_$]/.test(lastSigChar) && JS_REGEX_PREFIX_KEYWORDS.has(lastWord));
            if (canStartRegex) {
                const regexEnd = tryScanJsRegex(text, i);
                if (regexEnd > i) {
                    out += text.slice(i, regexEnd);
                    lastSigChar = '/';
                    lastWord = '';
                    i = regexEnd;
                    continue;
                }
            }
        }

        if (!isPython && ch === '`') {
            flushWord();
            out += '`';
            i += 1;
            scanTemplateBody();
            continue;
        }

        if (ch === "'" || ch === '"') {
            flushWord();
            const quote = ch;
            out += quote;
            i += 1;
            while (i < len) {
                if (text[i] === '\\' && i + 1 < len) {
                    out += text[i] + text[i + 1];
                    i += 2;
                    continue;
                }
                if (text[i] === '\n') {
                    break;
                }
                out += text[i];
                i += 1;
                if (text[i - 1] === quote) {
                    break;
                }
            }
            lastSigChar = quote;
            lastWord = '';
            continue;
        }

        if (!isPython && templateBraceStack.length > 0) {
            if (ch === '{') {
                flushWord();
                templateBraceStack[templateBraceStack.length - 1] += 1;
                lastSigChar = '{';
                out += '{';
                i += 1;
                continue;
            }
            if (ch === '}') {
                flushWord();
                if (templateBraceStack[templateBraceStack.length - 1] > 0) {
                    templateBraceStack[templateBraceStack.length - 1] -= 1;
                    lastSigChar = '}';
                    out += '}';
                    i += 1;
                    continue;
                }
                templateBraceStack.pop();
                out += '}';
                i += 1;
                scanTemplateBody();
                continue;
            }
        }

        if (/[a-zA-Z0-9_$.]/.test(ch)) {
            wordBuf += ch;
            lastSigChar = ch;
        } else {
            flushWord();
            if (!/\s/.test(ch)) {
                lastSigChar = ch;
            }
        }

        out += ch;
        i += 1;
    }

    return out;
}

const CATALOG_AUDIT_EXEMPT_PATH_RE =
    /(?:^(?:lib|lib-py)(?:[\\/]|$)|(?:^|[\\/])homelab[\\/](?:lib|lib-py)(?:[\\/]|$)|(?:^|[\\/])(?:krusch_toolkit|krusch-stack|tests?|__tests__|benchmarks?|node_modules|site-packages|__pycache__|vendor|third_party|_?archive|archive_scratch|scratch)(?:[\\/]|$)|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|[\\/])test[_-]|\.(?:md|mdx|txt|rst|json|ya?ml|toml|lock|html|css|svg|sql|sh)$)/i;

const MAX_AUDIT_CHARS = 1_048_576;

/**
 * Scan comment-stripped JS/JSX source in O(N) linear time to check whether `fetch(`
 * occurs inside any `useEffect(...)` call span without crossing into sibling functions.
 *
 * @param {string} cleaned
 * @returns {boolean}
 */
function isWordOrDotCode(c) {
    return (
        (c >= 97 && c <= 122) || // a-z
        (c >= 65 && c <= 90) ||  // A-Z
        (c >= 48 && c <= 57) ||  // 0-9
        c === 95 || c === 36 || c === 46 // _ $ .
    );
}

function isSpaceCode(c) {
    return c === 32 || c === 10 || c === 13 || c === 9 || c === 12 || c === 11;
}

function hasFetchInsideUseEffect(cleaned) {
    if (!/\buseEffect\s*\(/.test(cleaned) || !/\bfetch\s*\(/.test(cleaned)) {
        return false;
    }

    const useEffectRe = /\buseEffect\s*\(/g;
    const len = cleaned.length;
    let cursor = 0;
    let match;

    while ((match = useEffectRe.exec(cleaned)) !== null) {
        if (match.index < cursor) continue;
        const openParenIdx = match.index + match[0].length - 1;
        let i = openParenIdx + 1;
        let depth = 1;
        const tplBraceStack = [];
        let lastSigChar = '(';
        let lastWord = '';
        let wordBuf = '';
        let codeSpan = '(';

        const flushWord = () => {
            if (wordBuf) {
                lastWord = wordBuf;
                wordBuf = '';
            }
        };

        const skipTemplateLiteral = () => {
            while (i < len) {
                const tc = cleaned.charCodeAt(i);
                if (tc === 92 && i + 1 < len) {
                    i += 2;
                    continue;
                }
                if (tc === 36 && cleaned.charCodeAt(i + 1) === 123) {
                    tplBraceStack.push(0);
                    lastSigChar = '{';
                    lastWord = '';
                    codeSpan += ' {';
                    i += 2;
                    return;
                }
                if (tc === 96) {
                    lastSigChar = '`';
                    lastWord = '';
                    codeSpan += ' ';
                    i += 1;
                    return;
                }
                i += 1;
            }
        };

        while (i < len && depth > 0) {
            const code = cleaned.charCodeAt(i);
            const ch = cleaned[i];

            if (code === 47 && (i === 0 || cleaned.charCodeAt(i - 1) !== 60)) {
                flushWord();
                const lastSigCode = lastSigChar ? lastSigChar.charCodeAt(0) : 0;
                const canStartRegex =
                    lastSigChar === '' ||
                    '(,[=:{;!&|?+-*~^%>'.includes(lastSigChar) ||
                    (((lastSigCode >= 97 && lastSigCode <= 122) ||
                        (lastSigCode >= 65 && lastSigCode <= 90) ||
                        lastSigCode === 95 ||
                        lastSigCode === 36) &&
                        JS_REGEX_PREFIX_KEYWORDS.has(lastWord));
                if (canStartRegex) {
                    const regexEnd = tryScanJsRegex(cleaned, i);
                    if (regexEnd > i) {
                        i = regexEnd;
                        lastSigChar = '/';
                        lastWord = '';
                        codeSpan += ' ';
                        continue;
                    }
                }
                lastSigChar = '/';
                codeSpan += '/';
                i += 1;
                continue;
            }

            if (code === 96) {
                flushWord();
                codeSpan += ' ';
                i += 1;
                skipTemplateLiteral();
                continue;
            }

            if (code === 39 || code === 34) {
                flushWord();
                const quoteCode = code;
                i += 1;
                while (i < len) {
                    const qc = cleaned.charCodeAt(i);
                    if (qc === 92 && i + 1 < len) {
                        i += 2;
                        continue;
                    }
                    if (qc === 10) break;
                    i += 1;
                    if (qc === quoteCode) break;
                }
                lastSigChar = ch;
                lastWord = '';
                codeSpan += ' ';
                continue;
            }

            if (tplBraceStack.length > 0) {
                if (code === 123) {
                    flushWord();
                    tplBraceStack[tplBraceStack.length - 1] += 1;
                    lastSigChar = '{';
                    codeSpan += '{';
                    i += 1;
                    continue;
                }
                if (code === 125) {
                    flushWord();
                    if (tplBraceStack[tplBraceStack.length - 1] > 0) {
                        tplBraceStack[tplBraceStack.length - 1] -= 1;
                        lastSigChar = '}';
                        codeSpan += '}';
                        i += 1;
                        continue;
                    }
                    tplBraceStack.pop();
                    codeSpan += '} ';
                    i += 1;
                    skipTemplateLiteral();
                    continue;
                }
            }

            if (code === 40) {
                flushWord();
                depth += 1;
                lastSigChar = '(';
                codeSpan += '(';
                i += 1;
                continue;
            }
            if (code === 41) {
                flushWord();
                depth -= 1;
                lastSigChar = ')';
                codeSpan += ')';
                i += 1;
                continue;
            }

            if (isWordOrDotCode(code)) {
                wordBuf += ch;
                lastSigChar = ch;
            } else {
                flushWord();
                if (!isSpaceCode(code)) {
                    lastSigChar = ch;
                }
            }
            codeSpan += ch;
            i += 1;
        }

        cursor = i;
        if (/(?:^|[^.\w$])fetch\s*\(/.test(codeSpan) || /\b(?:window|globalThis|self)\.fetch\s*\(/.test(codeSpan)) {
            return true;
        }
    }

    return false;
}

/**
 * Deterministically inspect source text for hand-rolled plumbing that should use @krusch/toolkit or krusch_toolkit.
 *
 * @param {string} [code='']
 * @param {string} [filePath='']
 * @returns {{ ok: boolean, tool: string, summary: string, data: { filePath: string, clean: boolean, findings: Array<object> } }}
 */
export function auditBoilerplateText(code = '', filePath = '') {
    const fullRaw = String(code || '');
    const raw = fullRaw.length > MAX_AUDIT_CHARS ? fullRaw.slice(0, MAX_AUDIT_CHARS) : fullRaw;
    const normalizedPath = String(filePath || '');
    if (normalizedPath && CATALOG_AUDIT_EXEMPT_PATH_RE.test(normalizedPath)) {
        return {
            ok: true,
            tool: 'lego.catalog',
            summary: 'Zero hand-rolled boilerplate detected (exempt path)',
            data: {
                filePath: normalizedPath,
                clean: true,
                findings: []
            }
        };
    }
    const isPython = inferIsPythonSource(raw, normalizedPath);
    const cleaned = stripCommentLines(raw, { isPython });
    const findings = [];

    // 1. Raw MCP Server + StdioServerTransport without @krusch/toolkit/mcp
    const hasRawMcp = /\bnew\s+Server\s*\(/.test(cleaned) && /\bStdioServerTransport\b/.test(cleaned);
    const usesToolkitMcp = /@krusch\/toolkit\/mcp(?:-server)?\b/.test(cleaned);
    if (hasRawMcp && !usesToolkitMcp) {
        findings.push({
            ruleId: 'raw-mcp-stdio',
            brickId: 'mcp',
            importPath: '@krusch/toolkit/mcp',
            severity: 'warn',
            message: 'Hand-rolled MCP Server + StdioServerTransport detected; replace with defineMcpTool and createMcpServer from @krusch/toolkit/mcp.'
        });
    }

    // 2. Manual text/event-stream SSE headers without @krusch/toolkit/streaming, @krusch/toolkit/edge, or krusch_toolkit.fastapi_app
    const hasManualSse = /text\/event-stream/i.test(cleaned);
    const usesToolkitStreaming =
        /@krusch\/toolkit\/(?:streaming|edge)\b/.test(cleaned) ||
        /\bkrusch_toolkit\.fastapi_app\b/.test(cleaned) ||
        /\bfrom\s+krusch_toolkit\s+import\b[^\n]*\bfastapi_app\b/.test(cleaned);
    if (hasManualSse && !usesToolkitStreaming) {
        findings.push({
            ruleId: 'manual-sse-headers',
            brickId: isPython ? 'fastapi_app' : 'streaming',
            importPath: isPython ? 'krusch_toolkit.fastapi_app' : '@krusch/toolkit/streaming',
            severity: 'warn',
            message: isPython
                ? 'Manual text/event-stream response detected; use sse_event_response from krusch_toolkit.fastapi_app.'
                : 'Manual text/event-stream plumbing detected; use sseResponse/streamChat (@krusch/toolkit/streaming) or edgeSseResponse (@krusch/toolkit/edge).'
        });
    }

    // 3. Raw PostgreSQL Pool without @krusch/toolkit/pg (or @krusch/toolkit/polygres)
    const hasRawPgPool =
        /\bnew\s+pg\.Pool\s*\(/.test(cleaned) ||
        (/\bnew\s+Pool\s*\(/.test(cleaned) && /(?:from\s+['"]pg['"]|require\(\s*['"]pg['"]\s*\))/.test(cleaned));
    const usesToolkitPg = /@krusch\/toolkit\/(?:pg|polygres)\b/.test(cleaned);
    if (hasRawPgPool && !usesToolkitPg) {
        findings.push({
            ruleId: 'raw-pg-pool',
            brickId: 'pg',
            importPath: '@krusch/toolkit/pg',
            severity: 'warn',
            message: 'Raw pg.Pool instantiation detected; use createPgPool, runSqlMigrations, and pgVectorSearch from @krusch/toolkit/pg.'
        });
    }

    // 4. Raw better-sqlite3 new Database( without @krusch/toolkit/db
    const hasRawSqlite =
        /\bnew\s+Database\s*\(/.test(cleaned) &&
        (/better-sqlite3/.test(cleaned) || /\.pragma\s*\(\s*['"]journal_mode/i.test(cleaned));
    const usesToolkitDb = /@krusch\/toolkit\/db\b/.test(cleaned);
    if (hasRawSqlite && !usesToolkitDb) {
        findings.push({
            ruleId: 'raw-sqlite-database',
            brickId: 'db',
            importPath: '@krusch/toolkit/db',
            severity: 'warn',
            message: 'Raw better-sqlite3 Database instantiation detected; use initDb, query, and run from @krusch/toolkit/db.'
        });
    }

    // 5. Raw FastAPI CORSMiddleware + @app.get("/health") without krusch_toolkit.fastapi_app
    const hasRawFastapi =
        /\bCORSMiddleware\b/.test(cleaned) &&
        /@\w+\.get\(\s*['"]\/health['"]/.test(cleaned);
    const usesToolkitFastapi =
        /\bkrusch_toolkit\.fastapi_app\b/.test(cleaned) ||
        /\bfrom\s+krusch_toolkit\s+import\b[^\n]*\bfastapi_app\b/.test(cleaned);
    if (hasRawFastapi && !usesToolkitFastapi) {
        findings.push({
            ruleId: 'raw-fastapi-boilerplate',
            brickId: 'fastapi_app',
            importPath: 'krusch_toolkit.fastapi_app',
            severity: 'warn',
            message: 'Hand-rolled FastAPI CORSMiddleware + /health route detected; use create_fastapi_app from krusch_toolkit.fastapi_app.'
        });
    }

    // 6. Un-aborted React useEffect fetch( without AbortController / signal / useApiQuery
    const hasUseEffectFetch = !isPython && hasFetchInsideUseEffect(cleaned);
    const hasFetchAbortGuard = /\bAbortController\b|\bsignal\b|\buseApiQuery\b|\buseSSEStream\b|\bfetchApiJson\b/.test(cleaned);
    if (hasUseEffectFetch && !hasFetchAbortGuard) {
        findings.push({
            ruleId: 'unaborted-useeffect-fetch',
            brickId: 'react',
            importPath: '@krusch/toolkit/react',
            severity: 'warn',
            message: 'Un-aborted fetch() inside React useEffect detected; pass AbortController signal or use useApiQuery from @krusch/toolkit/react.'
        });
    }

    // 7. Hand-rolled webhook HMAC verification without @krusch/toolkit/webhooks
    const hasRawWebhookHmac =
        !isPython &&
        /\bcreateHmac\s*\(/.test(cleaned) &&
        /\b(?:x-slack-signature|x-hub-signature-256|stripe-signature)\b/i.test(cleaned);
    const usesToolkitWebhooks = /@krusch\/toolkit\/webhooks\b|\b(?:verifySlackSignature|verifyGithubSignature|verifyStripeSignature)\b/.test(cleaned);
    if (hasRawWebhookHmac && !usesToolkitWebhooks) {
        findings.push({
            ruleId: 'raw-webhook-hmac',
            brickId: 'webhooks',
            importPath: '@krusch/toolkit/webhooks',
            severity: 'warn',
            message: 'Hand-rolled webhook HMAC check detected; use verifySlackSignature, verifyGithubSignature, or verifyStripeSignature from @krusch/toolkit/webhooks.'
        });
    }

    // 8. Raw Node 22 node:sqlite new DatabaseSync( without @krusch/toolkit/sqlite
    const hasRawNodeSqlite =
        !isPython &&
        /\bnew\s+DatabaseSync\s*\(/.test(cleaned);
    const usesToolkitSqlite = /@krusch\/toolkit\/sqlite\b|\bopenSqliteDb\b/.test(cleaned);
    if (hasRawNodeSqlite && !usesToolkitSqlite) {
        findings.push({
            ruleId: 'raw-node-sqlite',
            brickId: 'sqlite',
            importPath: '@krusch/toolkit/sqlite',
            severity: 'warn',
            message: 'Raw node:sqlite DatabaseSync instantiation detected; use openSqliteDb, escapeFts5Query, and fuseRrfResults from @krusch/toolkit/sqlite.'
        });
    }

    // 9. Raw multer( multipart upload middleware without @krusch/toolkit/upload
    const hasRawMulter =
        !isPython &&
        /\bmulter\s*\(/.test(cleaned);
    const usesToolkitUpload = /@krusch\/toolkit\/upload\b|\bparseBoundedMultipart\b/.test(cleaned);
    if (hasRawMulter && !usesToolkitUpload) {
        findings.push({
            ruleId: 'raw-multer-upload',
            brickId: 'upload',
            importPath: '@krusch/toolkit/upload',
            severity: 'warn',
            message: 'Raw multer() upload middleware detected; use parseBoundedMultipart, verifyUploadMime, and sanitizeUploadFilename from @krusch/toolkit/upload.'
        });
    }

    // 10. Unsafe YAML load without @krusch/toolkit/yaml or krusch_toolkit.yaml_loader
    if (hasUnsafeYamlLoad(cleaned, isPython)) {
        findings.push({
            ruleId: 'unsafe-yaml-load',
            brickId: isPython ? 'python_yaml' : 'yaml',
            importPath: isPython ? 'krusch_toolkit.yaml_loader' : '@krusch/toolkit/yaml',
            severity: 'warn',
            message: isPython
                ? 'Unsafe PyYAML yaml.load()/unsafe_load()/full_load() detected; use parse_safe_yaml, validate_yaml_config, or load_safe_yaml_pack from krusch_toolkit.yaml_loader.'
                : 'Unsafe js-yaml load() detected; use parseSafeYaml, validateYamlConfig, or loadSafeYamlPack from @krusch/toolkit/yaml.'
        });
    }

    // 11. Hand-rolled inbound Idempotency-Key handling without @krusch/toolkit/idempotency
    if (!isPython && /idempotency-key/i.test(cleaned)) {
        const hasRawIdempotency =
            /\b(?:req|request)\s*(?:\??\.\s*headers\s*(?:(?:\?\.\s*)?\[\s*['"`](?:x-)?idempotency-key['"`]\s*\]|\??\.\s*get\s*\(\s*['"`](?:x-)?idempotency-key['"`]\s*\))|\??\.\s*(?:get|header)\s*\(\s*['"`](?:x-)?idempotency-key['"`]\s*\))/i.test(
                cleaned
            ) ||
            /\{[^{}\n]{0,120}['"`](?:x-)?idempotency-key['"`]\s*:\s*[A-Za-z_$][\w$]*[^{}\n]{0,120}\}\s*=\s*(?:req|request)\??\.headers\b/i.test(
                cleaned
            );
        const usesToolkitIdempotency =
            /@krusch\/toolkit\/idempotency\b|\b(?:createIdempotencyStore|withIdempotency|createIdempotencyMiddleware|normalizeIdempotencyKey|computePayloadFingerprint)\b/.test(
                cleaned
            );
        if (hasRawIdempotency && !usesToolkitIdempotency) {
            findings.push({
                ruleId: 'raw-idempotency-key',
                brickId: 'idempotency',
                importPath: '@krusch/toolkit/idempotency',
                severity: 'warn',
                message: 'Hand-rolled Idempotency-Key request handling detected; use createIdempotencyStore, withIdempotency, or createIdempotencyMiddleware from @krusch/toolkit/idempotency.'
            });
        }
    }

    // 12. Mutable enterprise SQL audit tables or custom SHA-256 audit hash chains without @krusch/toolkit/audit-log
    if (!isPython && /(?:audit|ledger)/i.test(cleaned)) {
        const hasMutableAuditSql =
            (/\bCREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+(?:[`"\[]?[a-z_][\w]*[`"\]]?\.)?[`"\[]?(?:audit_ledger|audit_trail|compliance_audit\w*)\b/i.test(
                cleaned
            ) ||
                /\bCREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+(?:[`"\[]?[a-z_][\w]*[`"\]]?\.)?[`"\[]?audit_logs?\b[^;]{0,600}\b(?:tenant_id|org_id|organization_id|actor_id|actor)\b/i.test(
                    cleaned
                )) &&
            !/\bAUDIT_LEDGER_IMMUTABLE\b/.test(cleaned);
        const hasHandRolledAuditChain =
            /\bcreateHash\s*\(\s*['"`]sha256['"`]\s*\)/.test(cleaned) &&
            /\b(?:prevHash|prev_hash)\b/.test(cleaned);
        const usesToolkitAuditLog =
            /@krusch\/toolkit\/audit-log\b|\b(?:createAuditLog|computeAuditEntryHash|verifyAuditChain|canonicalizeAuditPayload|GENESIS_AUDIT_HASH)\b/.test(
                cleaned
            );
        if ((hasMutableAuditSql || hasHandRolledAuditChain) && !usesToolkitAuditLog) {
            findings.push({
                ruleId: 'mutable-audit-ledger',
                brickId: 'audit-log',
                importPath: '@krusch/toolkit/audit-log',
                severity: 'warn',
                message: 'Mutable or hand-rolled audit ledger detected; use createAuditLog and verifyAuditChain from @krusch/toolkit/audit-log for canonical SHA-256/HMAC chaining and SQLite immutability triggers.'
            });
        }
    }

    // 13. Hand-rolled multi-tenant IDOR / scoped RBAC checks without @krusch/toolkit/rbac
    if (!isPython && /\b(?:tenantId|tenant_id|permissions)\b/.test(cleaned)) {
        const hasTenantContext = /\b(?:tenantId|tenant_id)\b/.test(cleaned);
        const hasRawTenantIdor =
            /\b(?:(?:req|request)\??\.(?:user|auth)|user|auth|session|caller)\??\.(?:tenantId|tenant_id)\s*(?:!==|===|!=|==)/.test(
                cleaned
            ) ||
            /(?:!==|===|!=|==)\s*(?:(?:req|request)\??\.(?:user|auth)|user|auth|session|caller)\??\.(?:tenantId|tenant_id)\b/.test(
                cleaned
            );
        const hasRawTenantRoleCheck =
            hasTenantContext &&
            (/\b(?:req|request)\??\.(?:user|auth)\??\.(?:role\b\s*(?:===|!==|==|!=)|roles\??\.includes\s*\()/.test(
                cleaned
            ) ||
                /\.includes\s*\(\s*(?:req|request)\??\.(?:user|auth)\??\.role\s*\)/.test(cleaned));
        const hasRawScopedPermissionCheck =
            /\b(?:user|auth|subject|caller|session)\??\.permissions\??\.includes\s*\(\s*['"`][a-z0-9_-]+:[a-z0-9_*-]+['"`]\s*\)/i.test(
                cleaned
            );
        const usesToolkitRbac =
            /@krusch\/toolkit\/rbac\b|\b(?:createRbacPolicy|evaluateAccess|assertTenantOwnership|createRbacGuard|matchPermissionPattern)\b/.test(
                cleaned
            );
        if ((hasRawTenantIdor || hasRawTenantRoleCheck || hasRawScopedPermissionCheck) && !usesToolkitRbac) {
            findings.push({
                ruleId: 'raw-tenant-rbac',
                brickId: 'rbac',
                importPath: '@krusch/toolkit/rbac',
                severity: 'warn',
                message: 'Hand-rolled RBAC or multi-tenant IDOR check detected; use createRbacPolicy, evaluateAccess, assertTenantOwnership, or createRbacGuard from @krusch/toolkit/rbac.'
            });
        }
    }

    // 14. Unsigned base64 pagination cursors or unclamped query/ORM pagination without @krusch/toolkit/pagination
    if (!isPython) {
        const usesToolkitPagination =
            /@krusch\/toolkit\/pagination\b|\b(?:clampPageLimit|encodeCursor|decodeCursor|buildKeysetPage|paginateItems)\b/.test(
                cleaned
            );
        if (!usesToolkitPagination) {
            const hasUnsignedBase64Cursor =
                /\b(?:cursor|nextCursor|next_cursor)\b/i.test(cleaned) &&
                (/\bBuffer\.from\s*\([^()\n]{0,120}\bcursor\b[^()\n]{0,40},\s*['"`]base64(?:url)?['"`]\s*\)/i.test(
                    cleaned
                ) ||
                    /\b(?:nextCursor|next_cursor)\s*=\s*(?:Buffer\.from\s*\([^;\n]{0,160}\.toString\s*\(\s*['"`]base64(?:url)?['"`]\s*\)|btoa\s*\()/i.test(
                        cleaned
                    ) ||
                    /\b(?:atob|btoa)\s*\([^()\n]{0,80}\bcursor\b/i.test(cleaned)) &&
                !/\b(?:createHmac|timingSafeEqual)\b/.test(cleaned);
            const hasUnclampedQuerySqlOffset =
                /(?:req|request)\??\.query\b|\bsearchParams\b/.test(cleaned) &&
                /\bLIMIT\b/i.test(cleaned) &&
                /\bOFFSET\b/i.test(cleaned) &&
                /(?:\b(?:(?:req|request)\??\.query|searchParams\.get)\s*(?:\??\.\s*(?:limit|offset|page)\b|\(\s*['"`](?:limit|offset|page)['"`]\s*\))|\{[^{}\n]{0,120}\b(?:limit|offset|page)\b[^{}\n]{0,120}\}\s*=\s*(?:req|request)\??\.query\b)/.test(
                    cleaned
                ) &&
                /\b(?:LIMIT\s+(?:\$\d+|\?|:[\w]+|\d+|\$\{[^{}\n]{1,80}\})\s+OFFSET\s+(?:\$\d+|\?|:[\w]+|\d+|\$\{[^{}\n]{1,80}\})|OFFSET\s+(?:\$\d+|\?|:[\w]+|\d+|\$\{[^{}\n]{1,80}\})\s+LIMIT\s+(?:\$\d+|\?|:[\w]+|\d+|\$\{[^{}\n]{1,80}\}))/i.test(
                    cleaned
                ) &&
                !/\bMath\.min\s*\(/.test(cleaned);
            const hasUnclampedOrmPagination = hasUnclampedOrmOrQueryPagination(cleaned);
            if (hasUnsignedBase64Cursor || hasUnclampedQuerySqlOffset || hasUnclampedOrmPagination) {
                findings.push({
                    ruleId: 'unsafe-pagination-cursor',
                    brickId: 'pagination',
                    importPath: '@krusch/toolkit/pagination',
                    severity: 'warn',
                    message: 'Unsigned base64 cursor or unclamped query/ORM pagination detected; use clampPageLimit, encodeCursor, decodeCursor, or buildKeysetPage from @krusch/toolkit/pagination.'
                });
            }
        }
    }

    // 15. Unvalidated user-controlled outbound HTTP URL (SSRF) without @krusch/toolkit/security or krusch_toolkit.security
    if (hasUnvalidatedOutboundSsrf(cleaned, isPython)) {
        findings.push({
            ruleId: 'unvalidated-outbound-ssrf',
            brickId: isPython ? 'python_security' : 'security',
            importPath: isPython ? 'krusch_toolkit.security' : '@krusch/toolkit/security',
            severity: 'warn',
            message: isPython
                ? 'User-controlled outbound HTTP URL detected without SSRF IP validation; validate with validate_outbound_url from krusch_toolkit.security.'
                : 'User-controlled outbound HTTP URL detected without SSRF protection; use safeFetch or validateOutboundUrl from @krusch/toolkit/security.'
        });
    }

    // 16. Hardcoded JWT/session/cookie secret fallback without @krusch/toolkit/auth
    if (hasHardcodedAuthSecretFallback(cleaned, isPython)) {
        findings.push({
            ruleId: 'hardcoded-auth-secret-fallback',
            brickId: 'auth',
            importPath: '@krusch/toolkit/auth',
            severity: 'warn',
            message: 'Hardcoded JWT, session, or cookie secret fallback detected; require environment-injected secrets via createAuth from @krusch/toolkit/auth.'
        });
    }

    const clean = findings.length === 0;
    const summary = clean
        ? `No hand-rolled boilerplate detected${normalizedPath ? ` in ${normalizedPath}` : ''}`
        : `Found ${findings.length} boilerplate anti-pattern(s)${normalizedPath ? ` in ${normalizedPath}` : ''}`;

    return {
        ok: true,
        tool: 'lego.catalog',
        summary,
        data: {
            filePath: normalizedPath,
            clean,
            findings
        }
    };
}

const TAINTED_URL_PROP_RE =
    /^(?:url|targetUrl|target_url|webhookUrl|webhook_url|callbackUrl|callback_url|endpoint|endpointUrl|endpoint_url|proxyUrl|proxy_url|fetchUrl|fetch_url|feedUrl|feed_url|imageUrl|image_url|sourceUrl|source_url|remoteUrl|remote_url|destUrl|dest_url|uri|href)$/i;

function hasUnclampedOrmOrQueryPagination(cleaned) {
    if (!/\b(?:findMany|skip|limit|offset|query)\b/.test(cleaned)) return false;
    const codeOnly = stripStringBodiesForYamlAudit(cleaned, false);
    if (/\bMath\.min\s*\(/.test(codeOnly)) return false;

    if (/\bfindMany\s*\(/.test(codeOnly) && /\bskip\s*:/.test(codeOnly) && /\btake\s*:/.test(codeOnly)) {
        const findManyRe = /\bfindMany\s*\(/g;
        let match;
        while ((match = findManyRe.exec(codeOnly)) !== null) {
            let j = match.index + match[0].length;
            const maxEnd = Math.min(codeOnly.length, j + 800);
            let depth = 1;
            let argsSlice = '';
            while (j < maxEnd && depth > 0) {
                const c = codeOnly[j];
                if (c === '(') depth += 1;
                else if (c === ')') depth -= 1;
                if (depth > 0) argsSlice += c;
                j += 1;
            }
            const hasDynamicSkip = /\bskip\s*:\s*(?!\d+\s*[,}\r\n])/.test(argsSlice);
            const hasDynamicTake =
                /\btake\s*:\s*(?!\d+\s*[,}\r\n])(?:(?:Number|parseInt)\s*\(\s*|\+\s*)?(?:(?:req|request|query|params)\??\.\s*)?(?:limit|take|pageSize|perPage|per_page)\b/.test(
                    argsSlice
                );
            if (hasDynamicSkip && hasDynamicTake) {
                return true;
            }
        }
    }

    if (/(?:req|request)\??\.\s*query\b/.test(codeOnly)) {
        if (
            /\.(?:skip\s*\([^()\n]{1,120}\)\s*\.\s*limit\s*\(\s*(?!\d+\s*\))[^()\n]{1,120}\)|limit\s*\(\s*(?!\d+\s*\))[^()\n]{1,120}\)\s*\.\s*skip\s*\([^()\n]{1,120}\))/.test(
                codeOnly
            )
        ) {
            return true;
        }
        const hasCoercedLimit =
            /(?:Number|parseInt)\s*\(\s*(?:req|request)\??\.\s*query(?:\??\.\s*(?:limit|take|pageSize|per_page)\b|\[\s*['"`](?:limit|take|pageSize|per_page)['"`]\s*\])/.test(
                cleaned
            );
        const hasPairedOffset =
            /(?:req|request)\??\.\s*query(?:\??\.\s*(?:offset|skip|page)\b|\[\s*['"`](?:offset|skip|page)['"`]\s*\])/.test(
                cleaned
            );
        if (hasCoercedLimit && hasPairedOffset) {
            return true;
        }
    }

    return false;
}

function hasUnvalidatedOutboundSsrf(cleaned, isPython) {
    if (isPython) {
        if (!/\b(?:httpx|requests|aiohttp|urlopen)\b/.test(cleaned)) return false;
        const usesToolkitPySec =
            /\bkrusch_toolkit\.security\b/.test(cleaned) ||
            /\bfrom\s+krusch_toolkit\s+import\b[^\n]*\b(?:security|validate_outbound_url|is_private_or_reserved_ip)\b/.test(
                cleaned
            ) ||
            /\b(?:validate_outbound_url|is_private_or_reserved_ip)\b/.test(cleaned);
        if (usesToolkitPySec) return false;

        const codeOnly = stripStringBodiesForYamlAudit(cleaned, true);
        if (
            /\b(?:httpx|requests)\s*\.\s*(?:get|post|put|delete|patch|head|request)\s*\(\s*(?:str\s*\(\s*)?(?:request\s*\.\s*(?:query_params|args|form|values)|req\s*\.\s*(?:query_params|args))\b/.test(
                codeOnly
            ) ||
            /\burlopen\s*\(\s*(?:str\s*\(\s*)?request\s*\.\s*(?:query_params|args|form|values)\b/.test(codeOnly)
        ) {
            return true;
        }

        const pyTainted = new Set();
        for (const line of cleaned.split('\n')) {
            if (pyTainted.size >= 32) break;
            const m =
                /^\s*([A-Za-z_]\w*)\s*(?::\s*[A-Za-z_][\w[\],\s|]{0,40})?=\s*(?:str\s*\(\s*)?request\s*\.\s*(?:query_params|args|form|values)\b(.*)$/.exec(
                    line
                );
            if (!m) continue;
            const lhs = m[1];
            const rhsTail = m[2] || '';
            const keyMatch = /(?:\.\s*get\s*\(\s*['"]|\[\s*['"])([A-Za-z0-9_-]+)['"]/.exec(rhsTail);
            if (TAINTED_URL_PROP_RE.test(lhs) || (keyMatch && TAINTED_URL_PROP_RE.test(keyMatch[1]))) {
                pyTainted.add(lhs);
            }
        }

        if (/@(?:app|router)\s*\.\s*(?:get|post|put|delete|patch|api_route)\b/.test(codeOnly)) {
            const defRe = /\bdef\s+\w+\s*\(([^)]{1,240})\)/g;
            let dm;
            while ((dm = defRe.exec(codeOnly)) !== null && pyTainted.size < 32) {
                const paramRe =
                    /\b(url|target_url|webhook_url|callback_url|endpoint_url|proxy_url|feed_url|source_url)\s*:\s*(?:Optional\s*\[\s*)?str\b/g;
                let pm;
                while ((pm = paramRe.exec(dm[1])) !== null && pyTainted.size < 32) {
                    pyTainted.add(pm[1]);
                }
            }
        }

        for (const v of pyTainted) {
            const callRe = new RegExp(
                `\\b(?:httpx|requests|client|session)\\s*\\.\\s*(?:get|post|put|delete|patch|head|request)\\s*\\(\\s*(?:str\\s*\\(\\s*)?${v}\\s*(?:\\)\\s*)?[,)]|\\burlopen\\s*\\(\\s*${v}\\s*[,)]`
            );
            if (callRe.test(codeOnly)) {
                return true;
            }
        }
        return false;
    }

    if (!/\b(?:fetch|axios|needle|got|https?)\b/.test(cleaned)) return false;
    if (!/(?:req|request)\??\.\s*(?:query|body|params)\b|\bc\.req\.query\s*\(/.test(cleaned)) return false;
    if (/@krusch\/toolkit\/security\b|\b(?:safeFetch|validateOutboundUrl|isPrivateOrReservedIp)\b/.test(cleaned)) {
        return false;
    }

    const codeOnly = stripStringBodiesForYamlAudit(cleaned, false);
    const httpCallPrefix =
        '(?:(?:^|[^.\\w$])fetch|(?:globalThis|window|self)\\s*\\.\\s*fetch|\\baxios(?:\\s*\\.\\s*(?:get|post|put|delete|patch|head|request))?|\\bneedle(?:\\s*\\.\\s*(?:get|post|put|delete|head|request))?|\\bgot(?:\\s*\\.\\s*(?:get|post|put|delete|stream))?|\\bhttps?\\s*\\.\\s*(?:get|request))';

    const directCallRe = new RegExp(
        `${httpCallPrefix}\\s*\\(\\s*(?:new\\s+URL\\s*\\(\\s*)?(?:String\\s*\\(\\s*)?(?:(?:req|request)\\??\\.\\s*(?:query|body|params)\\b|c\\.req\\.query\\s*\\(|\`\\$\\{\\s*(?:req|request)\\??\\.\\s*(?:query|body|params)\\b)`
    );
    if (directCallRe.test(codeOnly)) return true;

    if (
        /\baxios(?:\s*\.\s*request)?\s*\(\s*\{[^{}]{0,240}?\burl\s*:\s*(?:String\s*\(\s*)?(?:(?:req|request)\??\.\s*(?:query|body|params)\b|c\.req\.query\s*\()/.test(
            codeOnly
        )
    ) {
        return true;
    }

    const taintedVars = new Set();
    const assignLineRe =
        /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)(?:\s*:\s*[^=;\n]{1,60})?\s*=\s*(?:new\s+URL\s*\(\s*)?(?:String\s*\(\s*)?(?:(?:req|request)\??\.\s*(?:query|body|params)(?:\??\.\s*([A-Za-z_$][\w$]*)|\[\s*['"`]([A-Za-z0-9_$-]+)['"`]\s*\])|`\$\{\s*(?:req|request)\??\.\s*(?:query|body|params)\??\.\s*([A-Za-z_$][\w$]*)|c\.req\.query\s*\(\s*['"`]([A-Za-z0-9_$-]+)['"`]\s*\))/;
    for (const line of cleaned.split('\n')) {
        if (taintedVars.size >= 32) break;
        const m = assignLineRe.exec(line);
        if (!m) continue;
        const lhs = m[1];
        const rhsProp = m[2] || m[3] || m[4] || m[5] || '';
        if (TAINTED_URL_PROP_RE.test(lhs) || TAINTED_URL_PROP_RE.test(rhsProp)) {
            taintedVars.add(lhs);
        }
    }

    const destructRe =
        /\b(?:const|let|var)\s*\{([^{}]{1,240})\}(?:\s*:\s*[^=;\n]{1,120})?\s*=\s*(?:req|request)\??\.\s*(?:query|body|params)\b/g;
    let dm;
    while ((dm = destructRe.exec(codeOnly)) !== null && taintedVars.size < 32) {
        for (const rawPart of dm[1].split(',')) {
            const noDefault = rawPart.split('=')[0].trim();
            const aliasMatch = /^([A-Za-z_$][\w$]*)(?:\s*:\s*([A-Za-z_$][\w$]*))?$/.exec(noDefault);
            if (!aliasMatch) continue;
            const propName = aliasMatch[1];
            const boundName = aliasMatch[2] || aliasMatch[1];
            if (TAINTED_URL_PROP_RE.test(propName)) {
                taintedVars.add(boundName);
            }
        }
    }

    for (const ident of taintedVars) {
        const esc = ident.replace(/\$/g, '\\$');
        const callRe = new RegExp(
            `${httpCallPrefix}\\s*\\(\\s*(?:new\\s+URL\\s*\\(\\s*)?(?:String\\s*\\(\\s*)?${esc}(?:\\s*\\.\\s*trim\\s*\\(\\s*\\))?(?:\\s*\\))?\\s*(?:[,)]|as\\b|\\+)`
        );
        if (callRe.test(codeOnly)) return true;

        const axiosObjRe = new RegExp(
            `\\baxios(?:\\s*\\.\\s*request)?\\s*\\(\\s*\\{[^{}]{0,240}?\\burl\\s*(?::\\s*${esc}\\b|${
                ident === 'url' ? '[,}]' : '(?!)'
            })`
        );
        if (axiosObjRe.test(codeOnly)) return true;
    }

    return false;
}

function hasHardcodedAuthSecretFallback(cleaned, isPython) {
    if (isPython) return false;
    if (/@krusch\/toolkit\/auth\b|\bcreateAuth\b/.test(cleaned)) return false;
    if (
        !/\b(?:JWT_SECRET|AUTH_SECRET|SESSION_SECRET|COOKIE_SECRET|TOKEN_SECRET|APP_SECRET|SIGNING_SECRET|jwt|session|cookieSession|expressjwt|jwtSecret|cookieSecret|sessionSecret)\b/.test(
            cleaned
        )
    ) {
        return false;
    }

    const codeOnly = stripStringBodiesForYamlAudit(cleaned, false);

    if (
        /\bprocess\s*\.\s*env\s*\.\s*(?:JWT_SECRET|AUTH_SECRET|SESSION_SECRET|COOKIE_SECRET|TOKEN_SECRET|APP_SECRET|SIGNING_SECRET)\s*(?:\|\||\?\?)\s*(?:(['"]) {4,}\1|` {4,}`)/.test(
            codeOnly
        )
    ) {
        return true;
    }

    const jwtCallRe = /\bjwt\s*\.\s*(?:sign|verify)\s*\(/g;
    let jm;
    while ((jm = jwtCallRe.exec(codeOnly)) !== null) {
        let j = jm.index + jm[0].length;
        const maxEnd = Math.min(codeOnly.length, j + 512);
        let parenDepth = 1;
        let braceDepth = 0;
        let bracketDepth = 0;
        let commaIdx = -1;
        while (j < maxEnd && parenDepth > 0) {
            const c = codeOnly[j];
            if (c === '(') parenDepth += 1;
            else if (c === ')') parenDepth -= 1;
            else if (c === '{') braceDepth += 1;
            else if (c === '}') braceDepth = Math.max(0, braceDepth - 1);
            else if (c === '[') bracketDepth += 1;
            else if (c === ']') bracketDepth = Math.max(0, bracketDepth - 1);
            else if (c === ',' && parenDepth === 1 && braceDepth === 0 && bracketDepth === 0) {
                commaIdx = j;
                break;
            }
            j += 1;
        }
        if (commaIdx !== -1) {
            const secondArg = codeOnly.slice(commaIdx + 1, Math.min(codeOnly.length, commaIdx + 200)).trimStart();
            if (/^(?:(['"]) {4,}\1|` {4,}`)\s*(?:[,)]|as\b)/.test(secondArg)) {
                return true;
            }
        }
    }

    const sessionCallRe = /\b(?:session|cookieSession|expressjwt|jwt)\s*\(\s*\{/g;
    let sm;
    while ((sm = sessionCallRe.exec(codeOnly)) !== null) {
        let j = sm.index + sm[0].length;
        const maxEnd = Math.min(codeOnly.length, j + 600);
        let braceDepth = 1;
        let topLevelObj = '';
        while (j < maxEnd && braceDepth > 0) {
            const c = codeOnly[j];
            if (c === '{') {
                if (braceDepth === 1) topLevelObj += '{}';
                braceDepth += 1;
            } else if (c === '}') {
                braceDepth -= 1;
            } else if (braceDepth === 1) {
                topLevelObj += c;
            }
            j += 1;
        }
        if (/\bsecret\s*:\s*(?:(['"]) {4,}\1|` {4,}`)/.test(topLevelObj)) {
            return true;
        }
    }

    if (/\b(?:jwtSecret|cookieSecret|sessionSecret)\s*:\s*(?:(['"]) {4,}\1|` {4,}`)/.test(codeOnly)) {
        return true;
    }

    return false;
}

function stripStringBodiesForYamlAudit(cleaned, isPython) {
    let out = '';
    const len = cleaned.length;
    let i = 0;
    const tplStack = [];

    const scanTpl = () => {
        while (i < len) {
            if (cleaned[i] === '\\' && i + 1 < len) {
                out += '  ';
                i += 2;
                continue;
            }
            if (cleaned[i] === '$' && cleaned[i + 1] === '{') {
                out += '${';
                i += 2;
                tplStack.push(0);
                return;
            }
            if (cleaned[i] === '`') {
                out += '`';
                i += 1;
                return;
            }
            out += cleaned[i] === '\n' ? '\n' : ' ';
            i += 1;
        }
    };

    while (i < len) {
        const ch = cleaned[i];
        if (
            isPython &&
            ((ch === "'" && cleaned[i + 1] === "'" && cleaned[i + 2] === "'") ||
                (ch === '"' && cleaned[i + 1] === '"' && cleaned[i + 2] === '"'))
        ) {
            const d = ch;
            out += d + d + d;
            i += 3;
            while (i < len) {
                if (cleaned[i] === '\\' && i + 1 < len) {
                    out += '  ';
                    i += 2;
                    continue;
                }
                if (cleaned[i] === d && cleaned[i + 1] === d && cleaned[i + 2] === d) {
                    out += d + d + d;
                    i += 3;
                    break;
                }
                out += cleaned[i] === '\n' ? '\n' : ' ';
                i += 1;
            }
            continue;
        }
        if (!isPython && ch === '`') {
            out += '`';
            i += 1;
            scanTpl();
            continue;
        }
        if (!isPython && tplStack.length > 0) {
            if (ch === '{') {
                tplStack[tplStack.length - 1] += 1;
                out += '{';
                i += 1;
                continue;
            }
            if (ch === '}') {
                if (tplStack[tplStack.length - 1] > 0) {
                    tplStack[tplStack.length - 1] -= 1;
                    out += '}';
                    i += 1;
                    continue;
                }
                tplStack.pop();
                out += '}';
                i += 1;
                scanTpl();
                continue;
            }
        }
        if (ch === "'" || ch === '"') {
            const q = ch;
            const start = i + 1;
            let j = start;
            while (j < len && cleaned[j] !== '\n') {
                if (cleaned[j] === '\\' && j + 1 < len) {
                    j += 2;
                    continue;
                }
                if (cleaned[j] === q) break;
                j += 1;
            }
            const inner = cleaned.slice(start, j);
            const hasClosing = j < len && cleaned[j] === q;
            const keepSpecifier =
                !isPython &&
                inner === 'js-yaml' &&
                /(?:\bfrom\s*|\brequire\s*\(\s*)$/.test(out);
            out += q + (keepSpecifier ? inner : ' '.repeat(inner.length)) + (hasClosing ? q : '');
            i = hasClosing ? j + 1 : j;
            continue;
        }
        out += ch;
        i += 1;
    }
    return out;
}

function hasUnsafeYamlLoad(cleaned, isPython) {
    if (isPython) {
        if (!cleaned.includes('yaml.')) return false;
        const usesToolkitPyYaml =
            /\bkrusch_toolkit\.yaml_loader\b/.test(cleaned) ||
            /\bfrom\s+krusch_toolkit\s+import\b[\s\S]{0,240}?\b(?:yaml_loader|parse_safe_yaml|load_safe_yaml_pack|validate_yaml_config|dump_safe_yaml)\b/.test(
                cleaned
            );
        if (usesToolkitPyYaml) return false;

        const codeOnly = stripStringBodiesForYamlAudit(cleaned, true);
        if (/\byaml\.(?:unsafe_load|full_load|unsafe_load_all|full_load_all)\s*\(/.test(codeOnly)) {
            return true;
        }
        const loadRe = /\byaml\.load(?:_all)?\s*\(/g;
        let match;
        while ((match = loadRe.exec(codeOnly)) !== null) {
            let j = match.index + match[0].length;
            const maxEnd = Math.min(codeOnly.length, j + 1024);
            let depth = 1;
            let argsSlice = '';
            while (j < maxEnd && depth > 0) {
                const c = codeOnly[j];
                if (c === '(') depth += 1;
                else if (c === ')') depth -= 1;
                if (depth > 0) argsSlice += c;
                j += 1;
            }
            if (!/\b(?:C?SafeLoader|_SovereignSafeLoader)\b/.test(argsSlice)) {
                return true;
            }
        }
        return false;
    }

    if (!cleaned.includes('js-yaml')) return false;
    const usesToolkitJsYaml =
        /@krusch\/toolkit\/yaml\b|\b(?:parseSafeYaml|loadSafeYamlPack|validateYamlConfig|stringifySafeYaml)\b/.test(
            cleaned
        );
    if (usesToolkitJsYaml) return false;

    const codeOnly = stripStringBodiesForYamlAudit(cleaned, false);
    if (!codeOnly.includes('js-yaml')) return false;
    if (/\brequire\s*\(\s*['"]js-yaml['"]\s*\)\s*\.load(?:All)?\s*\(/.test(codeOnly)) {
        return true;
    }

    const nsBindings = new Set();
    const fnBindings = new Set();

    const nsImportRe =
        /\bimport\s+(?:\*\s+as\s+([A-Za-z_$][\w$]*)|([A-Za-z_$][\w$]*)(?:\s*,\s*\{[^}]*\})?)\s+from\s*['"]js-yaml['"]/g;
    let m;
    while ((m = nsImportRe.exec(codeOnly)) !== null) {
        const ident = m[1] || m[2];
        if (ident) nsBindings.add(ident);
    }

    const nsRequireRe =
        /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*['"]js-yaml['"]\s*\)/g;
    while ((m = nsRequireRe.exec(codeOnly)) !== null) {
        if (m[1]) nsBindings.add(m[1]);
    }

    const namedRe =
        /(?:\bimport\s+(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]*)\}\s*from\s*['"]js-yaml['"]|\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\s*\(\s*['"]js-yaml['"]\s*\))/g;
    while ((m = namedRe.exec(codeOnly)) !== null) {
        const clause = m[1] || m[2] || '';
        for (const part of clause.split(',')) {
            const spec = part.trim();
            const sm =
                /^(load(?:All)?)(?:(?:\s+as\s+|\s*:\s*)([A-Za-z_$][\w$]*))?(?:\s*=[\s\S]*)?$/.exec(
                    spec
                );
            if (sm) {
                fnBindings.add(sm[2] || sm[1]);
            }
        }
    }

    for (const ns of nsBindings) {
        const esc = ns.replace(/\$/g, '\\$');
        if (new RegExp(`(?:^|[^.\\w$])${esc}\\s*\\.\\s*load(?:All)?\\s*\\(`).test(codeOnly)) {
            return true;
        }
    }
    for (const fn of fnBindings) {
        const esc = fn.replace(/\$/g, '\\$');
        if (new RegExp(`(?:^|[^.\\w$])${esc}\\s*\\(`).test(codeOnly)) {
            return true;
        }
    }
    return false;
}

function detectSealedBrickIdsForSource(cleaned, isPython) {
    const matchedIds = new Set();
    for (const brick of RUNTIME_BRICKS) {
        const imp = brick.importPath;
        if (imp.startsWith('@krusch/toolkit/')) {
            if (isPython) continue;
            const escaped = imp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            if (new RegExp(`['"]${escaped}['"]`).test(cleaned)) {
                matchedIds.add(brick.id);
                continue;
            }
            if (brick.id === 'mcp' && /['"]@krusch\/toolkit\/mcp-server['"]/.test(cleaned)) {
                matchedIds.add(brick.id);
            }
        } else if (imp.startsWith('krusch_toolkit.')) {
            if (!isPython) continue;
            const submod = imp.slice('krusch_toolkit.'.length).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const directRe = new RegExp(`\\bkrusch_toolkit\\.${submod}\\b`);
            const fromRe = new RegExp(`\\bfrom\\s+krusch_toolkit\\s+import\\b[^\\n]*\\b${submod}\\b`);
            if (directRe.test(cleaned) || fromRe.test(cleaned)) {
                matchedIds.add(brick.id);
            }
        }
    }
    return [...matchedIds].sort();
}

/**
 * Compute deterministic Sealed Lego Brick coverage vs. unsealed boilerplate slop
 * across a file list or `{ [filePath]: code }` map, including estimated downstream
 * agent audit-token compression (`tokensPerSealedBrick`, default `850`).
 *
 * @param {Array<{ filePath?: string, path?: string, code?: string, content?: string }> | Record<string, string>} [files=[]]
 * @param {{ tokensPerSealedBrick?: number }} [options={}]
 * @returns {{
 *   ok: boolean,
 *   tool: string,
 *   summary: string,
 *   data: {
 *     scannedFiles: number,
 *     cleanFiles: number,
 *     flaggedFiles: number,
 *     sealedFiles: number,
 *     sealedBrickIds: string[],
 *     sealedTouchpoints: number,
 *     slopFindingCount: number,
 *     recommendedBrickIds: string[],
 *     sealedCoverageRatio: number,
 *     breakerTripped: boolean,
 *     estimatedAuditTokensSaved: number,
 *     findings: Array<{ filePath: string, ruleId: string, brickId: string, importPath: string, severity: string, message: string }>
 *   }
 * }}
 */
export function scoreLegoBrickCoverage(files = [], options = {}) {
    const rawTokensPerBrick = Number(options?.tokensPerSealedBrick);
    const tokensPerBrick =
        Number.isFinite(rawTokensPerBrick) && rawTokensPerBrick >= 0 ? Math.round(rawTokensPerBrick) : 850;

    let normalizedEntries = [];
    if (Array.isArray(files)) {
        normalizedEntries = files.map((item) => ({
            filePath: String(item?.filePath ?? item?.path ?? ''),
            code: String(item?.code ?? item?.content ?? '')
        }));
    } else if (files && typeof files === 'object') {
        normalizedEntries = Object.entries(files).map(([filePath, code]) => ({
            filePath: String(filePath),
            code: String(code ?? '')
        }));
    }

    let cleanFiles = 0;
    let flaggedFiles = 0;
    let sealedFiles = 0;
    let sealedTouchpoints = 0;
    const allSealedIds = new Set();
    const recommendedIds = new Set();
    const findings = [];

    for (const entry of normalizedEntries) {
        const fullRaw = entry.code;
        const raw = fullRaw.length > MAX_AUDIT_CHARS ? fullRaw.slice(0, MAX_AUDIT_CHARS) : fullRaw;
        const normalizedPath = entry.filePath;
        const isExempt = Boolean(normalizedPath && CATALOG_AUDIT_EXEMPT_PATH_RE.test(normalizedPath));

        if (!isExempt) {
            const isPython = inferIsPythonSource(raw, normalizedPath);
            const cleaned = stripCommentLines(raw, { isPython });
            const brickIds = detectSealedBrickIdsForSource(cleaned, isPython);
            if (brickIds.length > 0) {
                sealedFiles += 1;
                sealedTouchpoints += brickIds.length;
                for (const id of brickIds) {
                    allSealedIds.add(id);
                }
            }
        }

        const report = auditBoilerplateText(raw, normalizedPath);
        if (report.data.clean) {
            cleanFiles += 1;
        } else {
            flaggedFiles += 1;
            for (const item of report.data.findings) {
                if (item.brickId) {
                    recommendedIds.add(item.brickId);
                }
                findings.push({
                    filePath: normalizedPath,
                    ...item
                });
            }
        }
    }

    const slopFindingCount = findings.length;
    const totalTouchpoints = sealedTouchpoints + slopFindingCount;
    const sealedCoverageRatio =
        totalTouchpoints === 0 ? 1 : Number((sealedTouchpoints / totalTouchpoints).toFixed(4));
    const breakerTripped = slopFindingCount > 0;
    const estimatedAuditTokensSaved = sealedTouchpoints * tokensPerBrick;
    const pct = Math.round(sealedCoverageRatio * 100);
    const summary = breakerTripped
        ? `Breaker tripped: ${slopFindingCount} slop finding(s) across ${flaggedFiles}/${normalizedEntries.length} file(s) (${pct}% sealed brick coverage)`
        : `Clean pass: ${pct}% sealed brick coverage across ${normalizedEntries.length} file(s) (${sealedTouchpoints} sealed brick import(s), ~${estimatedAuditTokensSaved} audit tokens saved)`;

    return {
        ok: true,
        tool: 'lego.catalog',
        summary,
        data: {
            scannedFiles: normalizedEntries.length,
            cleanFiles,
            flaggedFiles,
            sealedFiles,
            sealedBrickIds: [...allSealedIds].sort(),
            sealedTouchpoints,
            slopFindingCount,
            recommendedBrickIds: [...recommendedIds].sort(),
            sealedCoverageRatio,
            breakerTripped,
            estimatedAuditTokensSaved,
            findings
        }
    };
}

