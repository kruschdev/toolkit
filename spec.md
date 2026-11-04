# `@krusch/toolkit` & `krusch_toolkit` Lego System — Specification

> **Status**: `FROZEN` (`2026-10-31T16:10:00-07:00`)
> **Packages**: `@krusch/toolkit` (`v1.7.0`) & `krusch-toolkit` (`python/` v1.6.0)
> **Enforcement**: `krusch-context-mcp` (`INV-LEGO-01`), `krusch-frontend-mcp`, `krusch-stack`, `scripts/verify-zero-leaks.js` (`INV-LEGO-26`)

---

## 1. Architectural Invariants

- **`INV-LEGO-01` (Universal Envelope Contract)**: Every HTTP helper, MCP tool helper, CLI inspector, and Python FastAPI factory MUST emit deterministic envelopes:
  - Success: `{ ok: true, tool: string, summary: string, data: object }`
  - Error: `{ ok: false, tool: string, summary: string, error: { code: string, message: string, details?: any } }`
- **`INV-LEGO-02` (Zero Ghost Exports & Headless Import Safety)**: Every subpath documented in `AGENTS.md` or `lib/README.md` MUST exist on disk, be mapped in `lib/package.json` `exports`, and succeed under `await import(...)` in pure Node 22 ESM even when optional UI peer libraries (`react`) are not installed locally in `lib/node_modules`.
- **`INV-LEGO-03` (`AbortController` & Bounded Payload Safety)**:
  - `sseResponse`, `streamChat`, `fetchApiJson`, `useApiQuery`, and `useSSEStream` MUST wire `AbortController` teardown on client disconnect / unmount / re-query.
  - `readBoundedJsonBody` MUST reject oversized bodies with HTTP `413` (`PAYLOAD_TOO_LARGE`) after draining/pausing safely without triggering raw TCP `ECONNRESET` before headers flush.
- **`INV-LEGO-04` (OS-Drive & Portable Host Hygiene)**:
  - Zero retired or hardcoded private LAN, 10GbE, or Tailscale host IPs and zero retired model names (`spectralquant`) in `lib/scaffold.js`, `lib/catalog.js`, or `lib/llm-queue.js`.
  - Generated `docker-compose.yml` blueprints MUST use Compose v2 syntax (no deprecated top-level `version:`), named or env-configurable data paths (`${DATA_DIR:-./data}`), and explicit comments warning against mounting persistent databases or model weights on OS boot drives.
  - Public-facing templates and runtime modules MUST obey `INV-STACK-04` & `INV-LEGO-26` (`127.0.0.1` / `localhost` / env vars only; zero hardcoded private LAN/CGNAT host IPs, zero host OS home or `/mnt` paths, and zero personal PII).
- **`INV-LEGO-05` (`krusch-stack` Tool Count & Annotation Invariant)**:
  - Adding canonical Lego starter templates to `krusch-stack/src/engines/frontend-engine.js` MUST preserve `ALL_STACK_TOOLS.length === 39` (`INV-STACK-09`) and `defineMcpTool` in `lib/mcp-server.js` MUST enforce all 4 boolean MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) plus `title` (`INV-STACK-03`).
- **`INV-LEGO-06` (`krusch-context-mcp` BEAM & `INV-12` Hygiene)**:
  - `projects/krusch-context-mcp/src/lego-boilerplate-guard.js` MUST contain zero BEAM oracle identifiers or dataset proper nouns banned by `benchmarks/verify_zero_leakage.js` (`probing_questions`, `source_chat_ids`, `ideal_response`, `OpenWeather`, `Formspree`, `BudgetTracker`, `Figma`, `Jira`, `Trello`, `DETAIL_HEAD_STEMS`, `ACTION_MODIFIER_STEMS`), and MUST preserve `39/39` valid `INV-12` span anchors.
- **`INV-LEGO-07` (GitHub Contributor Attribution)**:
  - Any commits or scaffolds embedding Git metadata/CI MUST attribute to `kruschdev <kruschdev@users.noreply.github.com>`.

---

## 2. Frozen Module Contracts & File Partition

### Subagent 1 — Disjoint Files: `lib/http.js`, `lib/streaming.js`
- **`lib/http.js` (`@krusch/toolkit/http`)**:
  - `okEnvelope(tool, summary, data = {})` -> `{ ok: true, tool, summary, data }`
  - `errorEnvelope(code, message, details = null, tool = 'http')` -> `{ ok: false, tool, summary: message, error: { code, message, details } }`
  - `asyncHandler(fn)` -> `(req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)`
  - `readBoundedJsonBody(req, res, { maxBytes = 1048576 } = {})` -> `Promise<object>`: Safely reads UTF-8 JSON up to `maxBytes`; if exceeded, drains remaining stream chunks safely and responds `413` JSON `errorEnvelope('PAYLOAD_TOO_LARGE', ...)` returning `null`; on malformed JSON responds `400` `INVALID_JSON` returning `null`.
  - `createCorsHeaders(origin, allowedOrigins = ['*'])` -> headers object.
  - `createExpressBricks({ serviceName = 'krusch-service', version = '1.0.0', corsOrigins = ['*'], healthCheck = null, logger = null } = {})` -> `{ requestContextMiddleware, corsMiddleware, healthHandler, doctorHandler, notFoundHandler, errorHandler }`.
  - `createApiServer({ serviceName = 'krusch-service', version = '1.0.0', corsOrigins = ['*'], maxBodyBytes = 1048576, healthCheck = null, routes = {}, logger = null } = {})`: Lightweight zero-Express native `node:http.Server` router supporting `"GET /path"` / `"POST /path"` handlers `(ctx) => object | void` where `ctx = { req, res, url, query, body, requestId, sendJson }`, built-in `GET /health` & `GET /doctor`, `OPTIONS` preflight, 404/500 JSON envelopes.
  - `attachGracefulShutdown(server, cleanupFns = [], { timeoutMs = 5000, logger = null, signals = ['SIGTERM', 'SIGINT'] } = {})` -> `{ shutdown, detach }`.
- **`lib/streaming.js` (`@krusch/toolkit/streaming`)**:
  - `sseResponse(res, req = null, { heartbeatMs = 15000, corsOrigin = '*', retryMs = 3000 } = {})`:
    - Writes HTTP `200` headers (`Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-cache, no-transform`, `Connection: keep-alive`, `X-Accel-Buffering: no`, `Access-Control-Allow-Origin`). Calls `res.flushHeaders?.()`.
    - Creates an `AbortController` (`controller.signal`) automatically aborted when `req` or `res` emits `'close'` or `'aborted'`, clearing the heartbeat timer.
    - Returns `{ signal, isClosed: () => boolean, send(event, data), sendToken(delta, meta), done(summaryOrPayload), error(err), close() }`.
  - `streamChat(res, req, { systemPrompt = '', userMessage = '', config = {}, chatFn = null, fetchImpl = globalThis.fetch, tool = 'streamChat' } = {})`:
    - Opens `sseResponse(res, req)`.
    - If `config.provider === 'ollama'` and `!chatFn`, streams NDJSON `/api/chat` (`stream: true`) with `signal` from `sse.signal`, emitting `sendToken(chunk)` per delta and `done({ ok: true, tool, summary: 'Stream complete', data: { text } })`.
    - Otherwise invokes `chatFn || chat` (`./llm.js`), checks `sse.signal.aborted`, emits `sendToken` + `done`, and catches errors into `sse.error(err)`.

### Subagent 2 — Disjoint Files: `lib/mcp-server.js`, `lib/pg.js`, `lib/llm-queue.js`
- **`lib/mcp-server.js` (`@krusch/toolkit/mcp` & `@krusch/toolkit/mcp-server`)**:
  - `defineMcpTool({ name, title, description, inputSchema, readOnlyHint = true, destructiveHint = false, idempotentHint = true, openWorldHint = false })`: Returns normalized MCP tool definition with mandatory 4-boolean `annotations` + `title` (`INV-STACK-03`).
  - `okMcpResult(tool, summary, data = {})`: Returns `{ content: [{ type: 'text', text: JSON.stringify({ ok: true, tool, summary, data }) }] }`.
  - `errorMcpResult(tool, code, message, details = null)`: Returns `{ isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, tool, summary: message, error: { code, message, details } }) }] }`.
  - `validateToolArgs(toolDef, args = {})`: Deterministic check for `inputSchema.required` fields.
  - `createMcpServer(name, version, tools, toolHandler, options = {})`: Preserves backward compatibility with existing signature while normalizing `tools` via `defineMcpTool` if annotations are omitted, validating required args when `options.validateArgs !== false`, and catching handler exceptions cleanly.
- **`lib/pg.js` (`@krusch/toolkit/pg`)**:
  - `buildPgConnectionString(dbConfig = {})`: Resolves `dbConfig.url || process.env.DATABASE_URL` or constructs `postgresql://user:pass@host:port/database` safely (`encodeURIComponent`).
  - `createPgPool(dbConfig = {}, { serviceName = 'krusch-pg', max = 15, idleTimeoutMillis = 30000, connectionTimeoutMillis = 3000, PoolClass = null, logger = null } = {})`: Returns `{ pool, query, queryOne, withTransaction, healthCheck, close }`.
  - `runSqlMigrations(pgClientOrWrapper, migrations = [], { tableName = 'schema_migrations' } = {})`: Runs idempotent `{ id, sql }` migrations inside `BEGIN`/`COMMIT` transactions, returning `{ ok: true, tool: 'pg.migrate', summary, data: { applied: string[], skipped: string[] } }`.
  - `pgVectorSearch(pgWrapper, { table, embeddingColumn = 'embedding', vector, selectColumns = ['id'], whereSql = '', params = [], limit = 10, expectedDims = 1024 } = {})`: Validates table/column identifiers (`^[a-zA-Z_][a-zA-Z0-9_]*$`) against SQL injection, validates `vector.length === expectedDims` via `validateVectorDimension` (`./embeddings.js`), formats `[v1,v2,...]::vector`, and executes `<=>` cosine similarity search returning `{ ok: true, tool: 'pg.vectorSearch', summary, data: { rows } }`.
- **`lib/llm-queue.js` (`@krusch/toolkit/llm-queue`)**:
  - Default `DEFAULT_FLEET_OLLAMA_NODES` to portable loopback (`Object.freeze(['http://127.0.0.1:11434'])`) overridable via `OLLAMA_NODES` / `OLLAMA_URL`, preserving `PRIORITY`, `AsyncLock`, and `PriorityQueue` exports.

### Subagent 3 — Disjoint File: `lib/react.js`
- **`lib/react.js` (`@krusch/toolkit/react`)**:
  - Headless-safe React resolution: `let _React = null; try { _React = await import('react'); } catch { _React = null; }` plus `export function setReactRuntime(runtime)` and `export function getReactRuntime()`.
  - Preserve existing exports: `cn`, `STYLES`, `useMounted`, `useMediaQuery`, `useClickOutside`, `useCopyToClipboard`.
  - Add `useAesthetics(variant = 'cyber')`: Pure/hook token resolver returning `{ surface, glow, headingText, bg, badge, buttonPrimary, input }` class bundles (usable even without React state, or memoized when `_React?.useMemo` is present).
  - Add `fetchApiJson(url, { signal, timeoutMs = 15000, headers = {}, ...init } = {})`: Combines caller `signal` + timeout `AbortController`, parses JSON, unwraps `{ ok, data, error }`, throws structured Error on `!res.ok || body?.ok === false`.
  - Add `useApiQuery(url, { enabled = true, deps = [], fetchImpl = globalThis.fetch, initialData = null } = {})`: React hook creating `new AbortController()` inside `useEffect`, aborting in cleanup (`() => controller.abort()`), returning `{ data, loading, error, reload }`.
  - Add `useSSEStream(url, { fetchImpl = globalThis.fetch, method = 'POST' } = {})`: React hook managing streaming SSE requests with `AbortController`, parsing `data: ...` SSE lines, accumulating `text` & `events`, returning `{ text, events, status, error, start, stop, reset }`.
  - Add pure `createElement` Lego UI Components (`AppShell`, `StatusPill`, `MetricCard`, `ErrorBoundary`, `StreamingChatPanel`) using `getReactRuntime().createElement`.

### Subagent 4 — Disjoint Files: `lib/catalog.js`, `lib/scaffold.js`, `lib/bin/krusch-lego.js`
- **`lib/catalog.js` (`@krusch/toolkit/catalog`)**:
  - `RUNTIME_BRICKS`: Frozen catalog array of core Lego bricks, each with `{ id, runtime: 'node'|'python'|'react'|'edge', importPath, exports, summary, snippet, replacesBoilerplate }`.
  - `PROJECT_ARCHETYPES`: Frozen dictionary of 7 zero-LLM project blueprints (`node-api-sqlite`, `node-rag-pgvector`, `mcp-stdio-server`, `fullstack-react-vite`, `python-fastapi-service`, `node-ts-service`, `cloudflare-worker`), each with `{ id, title, runtime, description, renderFiles({ projectName, port }) }`.
  - `listLegoBricks({ runtime } = {})`, `getLegoBrick(id)`, `listArchetypes()`, `getArchetype(id)`, `auditBoilerplateText(code, filePath = '')` -> `{ ok: true, tool: 'lego.catalog', summary, data: { findings } }`.
- **`lib/scaffold.js` (`@krusch/toolkit/scaffold`)**:
  - `scaffoldProject(targetDir = process.cwd(), { archetype = 'node-api-sqlite', projectName = '', port = 3000, force = false, dryRun = false, quiet = false } = {})`.
- **`lib/bin/krusch-lego.js`**:
  - Executable (`#!/usr/bin/env node`) zero-LLM CLI supporting `list`, `inspect`, `stamp`, `audit`, and `scout`.

### Subagent 5 — Disjoint Files: `lib-py/krusch_toolkit/fastapi_app.py`, `lib-py/tests/test_fastapi_lego.py`
- **`lib-py/krusch_toolkit/fastapi_app.py`**:
  - `ok_envelope`, `error_envelope`, `format_sse_frame`, `create_fastapi_app`, `sse_event_response`.

### Subagent 6 — Disjoint Files: `projects/krusch-context-mcp/src/lego-boilerplate-guard.js`, `projects/krusch-context-mcp/tests/lego-boilerplate-guard.test.js`
- **`projects/krusch-context-mcp/src/lego-boilerplate-guard.js`**:
  - Zero BEAM-banned tokens (`INV-LEGO-06`).
  - Exports `detectHandRolledBoilerplate(code = '', filePath = '')`.

---

## 3. Wave 2 Extension Contracts (`INV-LEGO-08`..`INV-LEGO-11`)

- **`INV-LEGO-08` (Web-Standards Edge Runtime Purity — `@krusch/toolkit/edge`)**:
  - `lib/edge.js` MUST contain **zero `node:*` imports** so it executes unmodified on Cloudflare Workers, Pages Functions, Deno, Bun, and Node 22 Web `fetch(request, env, ctx)`.
  - `edgeCorsHeaders` MUST reject `Origin: null`, `Origin: false`, and CR/LF characters; `readBoundedEdgeJson` MUST enforce `maxBytes` across both `Content-Length` headers and chunked `ReadableStream` bodies (`413 PAYLOAD_TOO_LARGE`); `edgeSseResponse` MUST propagate `AbortSignal` teardown on stream `cancel()` or `request.signal` abort; `createEdgeRouter` MUST emit `INV-LEGO-01` envelopes on `/health`, `/doctor`, `404`, `413`, and `500` (including CORS headers on error responses).
- **`INV-LEGO-09` (Constant-Time Webhook & Bearer Verification — `@krusch/toolkit/webhooks`)**:
  - `lib/webhooks.js` MUST verify HMAC-SHA256 signatures (`verifySlackSignature`, `verifyGithubSignature`, `verifyStripeSignature`) and `verifyBearerToken` using `crypto.timingSafeEqual` ONLY after verifying identical byte lengths, rejecting missing/blank secrets fail-closed, enforcing replay-window bounds (`toleranceSeconds`, rejecting NaN/expired/future timestamps), and returning `INV-LEGO-01` `{ ok, tool, summary, data | error }` envelopes without throwing on untrusted caller headers.
- **`INV-LEGO-10` (Atomic Single-Instance CLI & Daemon Lifecycle — `@krusch/toolkit/cli`)**:
  - `lib/cli.js` MUST use exclusive `wx` lockfile creation in `withSingleInstanceLock` with live-PID (`process.kill(pid, 0)`) + `staleMs` reclamation, callback exception wrapping into `CALLBACK_ERROR` `errorEnvelope` (`SRE-01`), and guaranteed `finally` unlink (only unlinking lockfiles owned by the current invocation), `attachDaemonSignals` with `AbortSignal` propagation, `appendJsonlRecord`, and `defineCli` emitting `INV-LEGO-01` JSON envelopes under `--json`.
- **`INV-LEGO-11` (Zero-Build TypeScript Declaration Parity — `lib/types/*.d.ts`)**:
  - `@krusch/toolkit` MUST remain zero-build runtime ESM `.js` while exposing strict `.d.ts` declarations (`"types"` condition before `"default"` in `lib/package.json` `"exports"`) verified by `tsc --noEmit --strict` against consumer `.ts` imports, plus `node-ts-service` and `cloudflare-worker` archetypes in `lib/catalog.js`.

---

## 4. Wave 3 Extension & Jean SRE Autonomous Lego Scout Contracts (`INV-LEGO-12`..`INV-LEGO-16`)

- **`INV-LEGO-12` (Zero-Native-Addon `node:sqlite` + FTS5 Escaping + Hybrid RRF — `@krusch/toolkit/sqlite`)**:
  - **Disjoint Files**: `lib/sqlite.js`, `lib/types/sqlite.d.ts`
  - Uses Node 22 built-in `DatabaseSync` (`node:sqlite`) with zero native addon dependencies, applying `INV-REC-01..05` WAL durability pragmas (`busy_timeout = 5000`, `journal_mode = WAL`, `synchronous = NORMAL`, `wal_autocheckpoint = 1000`, `foreign_keys = ON`) and closing the handle on pragma failure without leaking descriptors.
  - Exact exports:
    - `openSqliteDb(dbPath = ':memory:', { wal = true, busyTimeout = 5000, synchronous, walAutocheckpoint = 1000, readOnly = false, DatabaseClass = null } = {})`:
      - Returns `{ db, dbPath, isOpen: () => boolean, exec(sql), run(sql, params = []), query(sql, params = []), queryOne(sql, params = []), transaction(fn), healthCheck(), close() }`.
      - `query` and `queryOne` normalize null-prototype `node:sqlite` rows into standard plain objects (`{ ...row }`).
      - `transaction(fn)` uses `BEGIN IMMEDIATE` at depth 0 and `SAVEPOINT sp_<depth>` when nested, rolling back cleanly on exception without masking the original error.
      - `healthCheck()` returns `INV-LEGO-01` `okEnvelope('sqlite.health', ...)` or `errorEnvelope('SQLITE_UNHEALTHY', ...)` without throwing.
    - `escapeFts5Query(rawQuery = '', { operator = 'AND', prefixLastToken = false, maxTokens = 32 } = {})`:
      - Extracts Unicode alphanumeric/underscore tokens (`[\p{L}\p{N}_]+` `u`), caps input length (`<= 2048` chars) and token count (`maxTokens`), wraps each token in double quotes (`"token"`, escaping internal `"` as `""`), optionally appends `*` after the final quoted token (`"tok"*`) when `prefixLastToken === true`, and joins with validated `' AND '` or `' OR '`. Returns `''` when zero tokens match so callers never trigger `fts5: syntax error`.
    - `fuseRrfResults(rankedLists = [], { k = 60, idKey = 'id', limit = 20, weights = [] } = {})`:
      - Prototype-safe (`Object.hasOwn`) Reciprocal Rank Fusion computing $\sum_i w_i / (k + \text{rank}_i)$ (`1`-indexed `rank`, `k >= 1`), deduplicating by `String(item[idKey])`, attaching `rrfScore`, sorting descending with deterministic `String(id)` tie-breaker, and slicing to `limit`.
    - Re-exports `DatabaseSync` from `node:sqlite` and `isSqliteCorruptionError` from `./db.js`.

- **`INV-LEGO-13` (DNS-Rebinding-Safe SSRF `safeFetch` & Bounded Rate Limiter — `@krusch/toolkit/security`)**:
  - **Disjoint Files**: `lib/security.js`, `lib/types/security.d.ts`
  - Exact exports:
    - `isPrivateOrReservedIp(ipString = '', { allowPrivateLan = false, allowTailscale = false } = {})`:
      - Fail-closed IPv4 + IPv6 classifier blocking unspecified (`0.0.0.0/8`, `::`), loopback (`127.0.0.0/8`, `::1`), link-local / cloud metadata (`169.254.0.0/16`, `fe80::/10`), multicast/reserved/documentation/benchmarking ranges (`192.0.0.0/24`, `192.0.2.0/24`, `198.18.0.0/15`, `198.51.100.0/24`, `203.0.113.0/24`, `224.0.0.0/4`, `ff00::/8`), IPv4-mapped/compatible/6to4/Teredo IPv6 (`::ffff:0:0/96`, `2002::/16`, `2001:0000::/32`), non-canonical octal/hex/single-integer IPv4 literals, Tailscale CGNAT (`100.64.0.0/10` unless `allowTailscale === true`), and RFC1918/ULA (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `fc00::/7` unless `allowPrivateLan === true`).
    - `validateOutboundUrl(rawUrl, { allowedProtocols = ['https:', 'http:'], allowPrivateLan = false, allowTailscale = false, allowedHosts = null, lookupFn = null, tool = 'security.ssrf' } = {})`:
      - Async non-throwing validator returning `INV-LEGO-01` `okEnvelope` (`{ url, hostname, port, resolvedAddresses }`) or `errorEnvelope` (`SSRF_INVALID_URL`, `SSRF_BLOCKED_PROTOCOL`, `SSRF_CREDENTIALS_FORBIDDEN`, `SSRF_HOST_NOT_ALLOWED`, `SSRF_PRIVATE_IP`, `SSRF_DNS_FAILED`). Rejects embedded URL credentials, localhost/metadata hostnames, and resolves all A/AAAA records, failing closed if **any** record is private/reserved.
    - `safeFetch(rawUrl, init = {}, { maxRedirects = 3, timeoutMs = 15000, allowPrivateLan = false, allowTailscale = false, allowedHosts = null, lookupFn = null, fetchImpl = globalThis.fetch, tool = 'security.fetch' } = {})`:
      - Validates every hop via `validateOutboundUrl`, enforces DNS-rebinding protection at socket connect via an `undici` `Agent` custom `lookup` hook when using native `globalThis.fetch` (closing the `Agent` cleanly or preventing TOCTOU rebinding), follows redirects manually (`redirect: 'manual'`), strips `Authorization` and `Cookie` headers on cross-origin redirects, enforces `AbortController` timeout + caller `signal` propagation, and returns `INV-LEGO-01` `okEnvelope` (`{ status, url, redirected, redirects, headers, response }`) or `errorEnvelope`.
    - `createRateLimiter({ windowMs = 60000, max = 60, maxKeys = 10000, nowFn = Date.now, tool = 'security.rateLimit' } = {})`:
      - Bounded `Map` rate limiter with expired-bucket pruning + oldest-key FIFO eviction at `maxKeys`, returning `{ consume(key, cost = 1), reset(key), clear(), size(), middleware(opts), edgeCheck(request, opts) }` with standard `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, and `Retry-After` headers plus `429` `RATE_LIMITED` `errorEnvelope`.

- **`INV-LEGO-14` (`krusch_toolkit` Python `v1.3.0` Parity — `mcp.py`, `pg.py`, `security.py`)**:
  - **Disjoint Files**: `lib-py/krusch_toolkit/mcp.py`, `lib-py/krusch_toolkit/pg.py`, `lib-py/krusch_toolkit/security.py`, `lib-py/tests/test_wave3_lego.py`
  - All three modules MUST import cleanly in bare Python 3.11+ without optional `fastapi` or live PostgreSQL servers running:
    - `krusch_toolkit.mcp`: `define_mcp_tool` (enforcing `INV-STACK-03` 4-boolean annotations + `title`), `ok_mcp_result`, `error_mcp_result`, `validate_tool_args` (`None` vs `0`/`False`/`""` accurate), and async `dispatch_mcp_tool`.
    - `krusch_toolkit.pg`: `assert_safe_pg_identifier` (`^[A-Za-z_][A-Za-z0-9_]*$`), `build_pg_connection_string` (URL-encoded), `format_pgvector_literal` (`validate_vector_dimension` 1024d default, rejecting `bool`/`NaN`/`Inf`), `run_sql_migrations`, and `pg_vector_search` (SQLi-guarded identifiers + `where_sql` semicolon/comment rejection + `1 <= limit <= 200`).
    - `krusch_toolkit.security`: `constant_time_equal`, `verify_webhook_hmac`, `verify_bearer_token` (SHA-256 pre-hashed before `hmac.compare_digest`), `is_private_or_reserved_ip` (covering IPv4-mapped/6to4/Teredo/metadata/RFC1918/Tailscale), and `validate_outbound_url`.

- **`INV-LEGO-15` (Cross-Repo Rule-of-3 Lego Scout Engine — `@krusch/toolkit/lego-scout` & `krusch-lego scout`)**:
  - **Disjoint Files**: `lib/lego-scout.js`, `lib/types/lego-scout.d.ts`
  - Exports `CANDIDATE_PATTERN_SIGNATURES`, `formatPortableProjectPath`, and `scoutHomelabLegoCandidates(projectsRoot, { minProjects = 3, maxFilesPerProject = 400, maxFileBytes = 262144, portablePaths = false } = {})`:
    - Safely walks `projectsRoot` (never following symlinks outside `projectsRoot`, skipping `krusch-stack`, `node_modules`, `.git`, `.venv`, `dist`, `build`, `tests`, `benchmarks`).
    - Computes `adoptionFindings` (existing `@krusch/toolkit` / `krusch_toolkit` boilerplate hits via `auditBoilerplateText`) and `candidateClusters` (recurring infrastructure patterns classified into `'ALREADY_COVERED_IN_TOOLKIT'`, `'CANDIDATE_MEETS_RULE_OF_3'` when `projectCount >= minProjects`, or `'BELOW_THRESHOLD_DO_NOT_EXTRACT'` when `< minProjects`).
    - When `portablePaths === true`, strips host-specific absolute prefixes so all paths are portable `<WORKSPACE_ROOT>/projects/<repo>/...` paths suitable for public SFT/DPO datasets (`INV-STACK-04`).
    - Returns `INV-LEGO-01` `okEnvelope('lego.scout', ...)` or `errorEnvelope('SCOUT_INVALID_ROOT', ...)`.

- **`INV-LEGO-16` (Autonomous `lego_scout` Loop & Zero-Leak SFT/DPO Training Flywheel)**:
  - **Orchestrator Files**: `projects/jean-sre/src/prompts.js`, `projects/jean-sre/src/jean_sre_sweep.js`, `projects/jean-sre/scripts/harvest_lego_and_referee_calibration.js`, `projects/jean-sre/scripts/export-120b-distillation.js`, `projects/jean-sre/tests/lego-sft-calibration.test.js`.
  - Adds `{ focus: 'lego_scout' }` to `INFRA_TARGETS`, injects deterministic `scoutHomelabLegoCandidates` JSON summary into `lego_scout` cycles (and `auditBoilerplateText` hints into `1.5_ANTI_PATTERN`), logs `lego_scout` findings under `/jean-loop-gate`, and harvests Wave-3 Lego + Rule-of-3 Spec Synthesis SFT rows and Anti-Bloat Architectural Judgment DPO pairs passing `10/10` `verifyZeroLeaks` gates.

---

## 5. Wave 4 Empirical Rule-of-3 Promotion Contracts (`INV-LEGO-17`..`INV-LEGO-20`)

Promotes all 4 empirical `CANDIDATE_MEETS_RULE_OF_3` clusters discovered across 100 workspace repositories by `scoutHomelabLegoCandidates` (`schema-contract-validation` [`16` repos], `multipart-file-upload` [`10` repos], `cascade-swarm-routing` [`9` repos], and `voice-whisper-audio` [`9` repos]) into zero-bloat runtime bricks (`@krusch/toolkit` `v1.6.0` & `krusch_toolkit` `v1.4.0`).

- **`INV-LEGO-17` (Zero-Dependency Composable Schema, `zod` Adapter & MCP JSON Schema Compiler — `@krusch/toolkit/schema`)**:
  - **Disjoint Files**: `lib/schema.js`, `lib/types/schema.d.ts`
  - **Runtime Purity**: Zero external npm dependencies and zero `node:*` imports (pure ECMAScript + `./http.js` envelopes or isomorphic envelope builders; safe in Node 22, browsers, and Cloudflare Workers).
  - Exact exports:
    - `s`: Frozen composable schema builder namespace exposing `s.string(opts)`, `s.number(opts)`, `s.integer(opts)`, `s.boolean(opts)`, `s.literal(value, opts)`, `s.enum(values, opts)`, `s.array(itemSchema, opts)`, `s.object(shape, opts)`, `s.record(valueSchema, opts)`, `s.union(schemas, opts)`, `s.optional(schema)`, `s.nullable(schema)`, and `s.any(opts)`. Every builder node MUST expose `.optional()`, `.nullable()`, `.safeParse(input, opts)` (`{ success: boolean, data?, error?: { issues } }`), and `.toJsonSchema()`.
    - `toJsonSchema(schema)`: Compiles any `s.*` builder or plain JSON Schema object into a clean JSON Schema Draft-7/2020-12 object (`{ type, properties, required, additionalProperties, ... }`) ready for MCP `defineMcpTool({ inputSchema })`.
    - `validateSchema(schema, payload, { coerce = false, stripUnknown = true, maxDepth = 16, tool = 'schema.validate' } = {})` and alias `validatePayload`:
      - Accepts `s.*` builders, duck-typed `{ safeParse(input) }` (`zod` v3/v4), or raw JSON Schema objects (`type`, `properties`, `required`, `items`, `enum`, `const`, `minimum`, `maximum`, `minLength`, `maxLength`, `minItems`, `maxItems`, `format`, `additionalProperties`).
      - Enforces `maxDepth` recursion cap (`SCHEMA_MAX_DEPTH`), circular-input `WeakSet` protection (`SCHEMA_CIRCULAR_REF`), prototype-pollution stripping (`__proto__`, `constructor`, `prototype` keys never copied via unsafe bracket assignment onto `Object.prototype`), `NaN`/`Infinity`/`boolean` rejection on numeric fields, and ReDoS-safe deterministic `format` validators (`email`, `uuid`, `url`, `iso-date`, `iso-datetime`, `ipv4`, `slug`).
      - Never throws on untrusted `payload`; returns `INV-LEGO-01` `okEnvelope(tool, 'Schema validation passed', validatedData)` or `errorEnvelope('VALIDATION_ERROR' | 'SCHEMA_MAX_DEPTH' | 'SCHEMA_CIRCULAR_REF' | 'INVALID_SCHEMA', message, { issues }, tool)`.
    - `createSchemaMiddleware(schema, { source = 'body', coerce = false, stripUnknown = true, tool = 'schema.middleware' } = {})`: Express/Node `(req, res, next)` middleware validating `req[source]`, attaching `req.validated`, or responding HTTP `400` JSON `errorEnvelope`.

- **`INV-LEGO-18` (Byte-Bounded Multipart Upload, Filename Sanitizer & Magic-Byte MIME Guard — `@krusch/toolkit/upload`)**:
  - **Disjoint Files**: `lib/upload.js`, `lib/types/upload.d.ts`
  - Exact exports:
    - `sanitizeUploadFilename(rawFilename = '', { fallback = 'upload.bin', maxLength = 128 } = {})`:
      - Strips POSIX/Windows directory prefixes (`/` and `\`), NUL bytes, ASCII/Unicode control & bidirectional override codepoints (`U+0000..U+001F`, `U+007F..U+009F`, `U+202A..U+202E`, `U+2066..U+2069`), leading dots (`.env`, `..`), trailing dots/spaces, and Windows reserved device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1..9`, `LPT1..9`), truncating cleanly to `maxLength` while preserving valid extensions and returning `fallback` when empty.
    - `sniffMimeMagic(bytes)`:
      - Inspects leading `Uint8Array` / `Buffer` magic signatures (`application/pdf`, `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `audio/wav`, `audio/mpeg`, `audio/ogg`, `video/webm`, `application/zip`), returning detected canonical MIME string or `null` when unrecognized.
    - `verifyUploadMime(bytes, declaredMime = '', { allowedMimeTypes = null, requireMagicMatch = true, tool = 'upload.mime' } = {})`:
      - Non-throwing validator comparing normalized `declaredMime` against `sniffMimeMagic(bytes)` (`UPLOAD_MIME_MISMATCH` on spoofed headers or missing magic signature when allowlist strictly requires magic-verifiable binary types) and enforcing `allowedMimeTypes` (exact MIME or wildcard `image/*`, `audio/*`, returning `UPLOAD_UNSUPPORTED_MIME`). Returns `INV-LEGO-01` `okEnvelope` or `errorEnvelope`.
    - `parseBoundedMultipart(input, { contentType = '', maxTotalBytes = 10485760, maxFileBytes = 5242880, maxFiles = 5, maxFields = 32, maxFieldBytes = 65536, allowedMimeTypes = null, requireMagicMatch = true, tool = 'upload.multipart' } = {})`:
      - Accepts Web `Request`, Node `IncomingMessage` / `Readable`, or `{ body: Uint8Array | Buffer, contentType: string }`.
      - Enforces `maxTotalBytes` while streaming BEFORE full buffering (draining/resuming Node `IncomingMessage` or canceling Web `ReadableStream` on overflow -> `UPLOAD_TOO_LARGE` without TCP `ECONNRESET` or OOM), scans RFC 7578 boundaries in linear $O(N)$ byte time without catastrophic regex backtracking, enforces `maxFiles`, `maxFields`, `maxFileBytes`, `maxFieldBytes`, prototype-safe `fields` (`__proto__`/`constructor`/`prototype` blocked), `sanitizeUploadFilename`, and `verifyUploadMime`. Returns `INV-LEGO-01` `okEnvelope(tool, ..., { fields, files, totalBytes })` or `errorEnvelope`.

- **`INV-LEGO-19` (Deterministic Multi-Tier LLM Cascade, Single-Flight Circuit Breaker & Burst Probe — `@krusch/toolkit/cascade`)**:
  - **Disjoint Files**: `lib/cascade.js`, `lib/types/cascade.d.ts`
  - **Portability (`INV-LEGO-04` / `INV-STACK-04`)**: Zero hardcoded private LAN or CGNAT host IPs; default URLs use `127.0.0.1` / env overrides (`OLLAMA_L1_URL`, `OLLAMA_L2_URL`, `COLAB_BURST_URL`).
  - Exact exports:
    - `DEFAULT_FLEET_CASCADE_TIERS`: Frozen 4-tier descriptor list (`L1_FAST`, `L2_HEAVY_MOE`, `L2_5_COLAB_BURST`, `L3_FRONTIER_ARGON`).
    - `createTierCircuitBreaker({ failureThreshold = 3, cooldownMs = 30000, maxTiers = 64, nowFn = Date.now } = {})`:
      - Bounded `Map` (`maxTiers` eviction, prototype-safe) managing `CLOSED`, `OPEN`, and single-flight `HALF_OPEN` probe transitions (`canAttempt`, `recordSuccess`, `recordFailure`, `getState`, `snapshot`, `reset`, `clear`) so concurrent callers never stampede a recovering tier during `HALF_OPEN`.
    - `selectCascadeTier({ complexityScore = 0, estimatedTokens = 0, requiresTools = false, requiresVision = false, allowBurst = false, allowFrontier = true, tiers = DEFAULT_FLEET_CASCADE_TIERS, breaker = null, tool = 'cascade.select' } = {})`:
      - Deterministic zero-I/O tier selector returning `INV-LEGO-01` `okEnvelope(tool, ..., { selectedTier, candidateChain, reason })` or `errorEnvelope('CASCADE_NO_HEALTHY_TIER', ...)`.
    - `probeBurstEndpoint(endpointUrl = 'http://127.0.0.1:11435', { timeoutMs = 1500, expectedModel = '', fetchImpl = globalThis.fetch, tool = 'cascade.probe' } = {})`:
      - Non-throwing `AbortController`-bounded Ollama `/api/tags` probe returning `INV-LEGO-01` `okEnvelope` (`{ reachable: true, endpointUrl, models, modelReady, latencyMs }`) or `errorEnvelope('BURST_UNREACHABLE' | 'BURST_MODEL_MISSING', ...)`.
    - `executeWithCascadeFallback(candidateChain, executorFn, { breaker = null, perAttemptTimeoutMs = 30000, signal = null, tool = 'cascade.execute' } = {})`:
      - Iterates healthy tiers with combined caller `signal` + per-attempt `AbortController` timeout (guaranteed timer & listener cleanup in `finally`), halts immediately with `CASCADE_ABORTED` if caller `signal` aborts externally, updates `breaker` state on attempt outcomes, and returns `INV-LEGO-01` `okEnvelope(tool, ..., { tierId, attemptCount, attempts, result })` or `errorEnvelope('CASCADE_EXHAUSTED' | 'CASCADE_ABORTED' | 'CASCADE_EMPTY_CHAIN', ...)`.

- **`INV-LEGO-20` (Isomorphic WAV/Whisper/TTS Audio Modality & Python `krusch_toolkit` `v1.4.0` Schema/Upload Parity — `@krusch/toolkit/audio`, `krusch_toolkit.schema`, `krusch_toolkit.upload`)**:
  - **Disjoint Files**: `lib/audio.js`, `lib/types/audio.d.ts`, `lib-py/krusch_toolkit/schema.py`, `lib-py/krusch_toolkit/upload.py`, `lib-py/tests/test_wave4_lego.py`
  - **Part A (`lib/audio.js` — Zero `node:*` imports, pure Web Standards)**:
    - `encodeWavPcm16(samples, { sampleRate = 16000, channels = 1 } = {})`: Encodes `Int16Array` or clamped `Float32Array` (`[-1, 1]`, `NaN -> 0`) into a canonical 44-byte RIFF/WAVE PCM16 little-endian `Uint8Array`.
    - `parseWavHeader(wavBytes, { tool = 'audio.wav' } = {})`: Bounds-checked RIFF/WAVE chunk walker (`fmt ` + `data`, tolerant of intermediate `JUNK`/`LIST` chunks) returning `INV-LEGO-01` `okEnvelope` (`{ audioFormat, channels, sampleRate, bitsPerSample, byteRate, dataOffset, dataBytes, durationSeconds }`) or `errorEnvelope('WAV_INVALID_HEADER', ...)`.
    - `transcribeWhisperAudio(audioBytes, { endpointUrl = 'http://127.0.0.1:9000/v1/audio/transcriptions', filename = 'audio.wav', mimeType = 'audio/wav', model = 'whisper-1', language = '', prompt = '', apiKey = '', maxAudioBytes = 26214400, timeoutMs = 30000, signal = null, fetchImpl = globalThis.fetch, tool = 'audio.stt' } = {})`: Enforces `0 < byteLength <= maxAudioBytes`, audio MIME allowlist, `AbortController` timeout + caller `signal` cleanup, and returns `INV-LEGO-01` `okEnvelope` (`{ text, language, duration, segments }`) or `errorEnvelope`.
    - `synthesizeSpeechAudio(text, { endpointUrl = 'http://127.0.0.1:8880/v1/audio/speech', voice = 'af_heart', model = 'tts-1', responseFormat = 'wav', speed = 1.0, apiKey = '', maxTextChars = 4096, maxResponseBytes = 26214400, timeoutMs = 30000, signal = null, fetchImpl = globalThis.fetch, tool = 'audio.tts' } = {})`: Enforces `maxTextChars`, streamed `maxResponseBytes` cap, `AbortController` teardown, and returns `INV-LEGO-01` `okEnvelope` (`{ audioBytes, mimeType, byteLength }`) or `errorEnvelope`.
  - **Part B (`krusch_toolkit` Python `v1.4.0` — `schema.py` & `upload.py`)**:
    - Both modules MUST import cleanly in bare Python 3.11+ stdlib without live servers or optional frameworks:
      - `krusch_toolkit.schema`: `validate_json_schema`, `validate_payload` (supporting JSON Schema dicts + duck-typed Pydantic v2 `model_validate`, strictly rejecting `bool` for `integer`/`number` and `NaN`/`Inf`, enforcing `max_depth`, stripping `__proto__`/`constructor`/`prototype`, and returning `ok_envelope` / `error_envelope("VALIDATION_ERROR", ...)`).
      - `krusch_toolkit.upload`: `sanitize_upload_filename`, `sniff_mime_magic`, `verify_upload_mime`, and async `read_bounded_upload` (chunked `max_bytes` enforcement before buffering + MIME magic verification returning `ok_envelope` / `error_envelope`).

---

## 6. Wave 5 Python Rule-of-3 Promotion & Sentinel Telemetry Contracts (`INV-LEGO-21`..`INV-LEGO-22` & `INV-SENTINEL-MEM-01`)

Promotes the 2 empirical Python `CANDIDATE_MEETS_RULE_OF_3` clusters discovered across 100 workspace repositories by `scoutHomelabLegoCandidates` (`python-httpx-resilience` [`12` repos] and `streamlit-rag-shell` [`6` repos]) into `krusch_toolkit` `v1.5.0` runtime bricks, registers Wave-6 empirical horizon detectors (`python-sqlalchemy-wal-pool` [`7` repos] and `yaml-safe-config-loader` [`7` repos]), and aligns Linux `MemAvailable` RAM telemetry in `krusch-sentinel-mcp`.

- **`INV-LEGO-21` (SSRF-Guarded, Bounded, Single-Flight Circuit-Broken Python HTTP Client — `krusch_toolkit.http_client`)**:
  - **Disjoint Subagent 1 File**: `lib-py/krusch_toolkit/http_client.py`
  - **Bare-Stdlib Import Purity**: Module MUST import cleanly in bare Python 3.11+ stdlib even when `httpx` is not installed (`import httpx` occurs lazily inside default transport execution when `client` and `send_fn` are omitted).
  - **Exact Exports & Return Contracts**:
    - `HttpCircuitBreaker(failure_threshold: int = 3, cooldown_seconds: float = 30.0, max_hosts: int = 64, clock_fn: Callable[[], float] = time.monotonic)` and factory `create_http_circuit_breaker(...)`:
      - Thread-safe (`threading.Lock`) bounded `OrderedDict` (`max_hosts` FIFO/LRU eviction, rejecting `bool`/non-positive bounds cleanly) managing `CLOSED`, `OPEN`, and single-flight `HALF_OPEN` probe states.
      - Methods: `can_attempt(key: str) -> dict[str, Any]` (`{"allowed": bool, "state": str, "probe": bool, "retry_after_seconds": float}`), `record_success(key: str) -> dict[str, Any]`, `record_failure(key: str, reason: str = "") -> dict[str, Any]`, `release_probe(key: str) -> None` (releases in-flight `HALF_OPEN` probe without recording failure if caller task is cancelled via `asyncio.CancelledError`), `get_state(key: str) -> dict[str, Any]`, `snapshot() -> dict[str, dict[str, Any]]`, `reset(key: str) -> None`, `clear() -> None`.
    - `compute_retry_delay(attempt: int, *, base_delay: float = 0.25, max_delay: float = 5.0, retry_after_header: str | None = None, jitter_ratio: float = 0.0, rng_fn: Callable[[], float] = random.random) -> float`:
      - Non-throwing pure float helper rejecting `bool`/`NaN`/`Inf`; honors non-negative integer/HTTP-seconds `Retry-After` headers clamped to `[0.0, max_delay]`, otherwise `min(max_delay, base_delay * (2 ** max(0, attempt - 1)))` with optional bounded jitter in `[0.0, max_delay]`.
    - `build_resilient_headers(headers: Mapping[str, str] | None = None, *, api_key: str | None = None, bearer_token: str | None = None, request_id: str | None = None, accept_json: bool = True, tool: str = "http_client.headers") -> dict[str, Any]`:
      - Validates all header names/values and auth tokens against `\r`, `\n`, `\x00`, and non-string types (`HTTP_INVALID_HEADER`), injects `X-Request-ID` (preserving caller's case-insensitively if already set) and `Accept: application/json`, and returns `INV-LEGO-01` `ok_envelope(tool, ..., {"headers": dict[str, str], "request_id": str})` or `error_envelope`.
    - `request_json(url: str, *, method: str = "GET", headers: Mapping[str, str] | None = None, json_body: Any = ..., timeout_seconds: float = 15.0, max_retries: int = 2, base_delay: float = 0.25, max_delay: float = 5.0, retry_on_post: bool = False, max_redirects: int = 3, max_response_bytes: int = 5_242_880, allow_private_lan: bool = False, allow_tailscale: bool = False, allow_loopback: bool = False, allowed_hosts: Sequence[str] | None = None, lookup_fn: Callable[[str], Sequence[str]] | None = None, breaker: HttpCircuitBreaker | None = None, client: Any = None, send_fn: Callable[..., Any] | None = None, sleep_fn: Callable[[float], None] = time.sleep, tool: str = "http_client.request") -> dict[str, Any]` and async twin `async_request_json(...)`:
      - Validates `method` in `{"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"}` (`HTTP_INVALID_METHOD`), headers via `build_resilient_headers`, and `json_body` (when provided) via `json.dumps(..., allow_nan=False)` (`HTTP_INVALID_JSON_BODY` on `NaN`/`Infinity`/cycles).
      - Validates initial URL and **every manual redirect hop** (`follow_redirects=False`, up to `max_redirects` -> `HTTP_TOO_MANY_REDIRECTS`) via `validate_outbound_url` (when `allow_loopback=True`, strictly permits `localhost`/`127.0.0.0/8`/`::1` while still enforcing `allowed_hosts` and blocking `0.0.0.0`, `169.254.169.254`, `fd00:ec2::254`, `metadata.google.internal`, and IPv6 transition prefixes). In `async_request_json`, when `lookup_fn is None` and the host is not an IP literal, resolves DNS via `await asyncio.get_running_loop().getaddrinfo(...)` so the event loop never blocks; when creating a default `httpx.Client` / `httpx.AsyncClient` (`client is None` and `send_fn is None`), pins the validated IP in the connect URL (`Host` header + `extensions={"sni_hostname": host_norm}` for `https`) to prevent connect-time DNS-rebinding TOCTOU.
      - Strips sensitive credentials (`Authorization`, `Cookie`, `X-API-Key`, `Proxy-Authorization` case-insensitively) across cross-origin redirects (`(scheme, hostname, port)` change) and rewrites `303` (or `301`/`302` on `POST`) to bodyless `GET`.
      - Enforces `max_response_bytes` on both `Content-Length` and chunked stream reads BEFORE full buffering (`HTTP_RESPONSE_TOO_LARGE`).
      - Parses JSON strictly rejecting `NaN`/`Infinity`/`-Infinity` (`HTTP_INVALID_JSON`, with `204`/`HEAD` empty body -> `None`).
      - Retries transient transport/timeout errors and `{408, 429, 502, 503, 504}` up to `max_retries` ONLY for idempotent methods (`GET`, `HEAD`, `OPTIONS`, `PUT`, `DELETE`) or `POST` when `retry_on_post=True`. Updates `breaker` per attempt and guarantees `breaker.release_probe(key)` in `finally` if `asyncio.CancelledError` interrupts an in-flight `HALF_OPEN` probe (re-raising `CancelledError`).
      - Returns `INV-LEGO-01` `ok_envelope(tool, ..., {"status": int, "url": str, "headers": dict[str, str], "body": Any, "attempts": int, "redirected": bool})` on `2xx`, or `error_envelope` (`HTTP_UPSTREAM_ERROR`, `HTTP_TIMEOUT`, `HTTP_NETWORK_ERROR`, `HTTP_CIRCUIT_OPEN`, `HTTP_RESPONSE_TOO_LARGE`, `HTTP_INVALID_JSON`, `SSRF_*`, etc.) without raising on untrusted inputs.

- **`INV-LEGO-22` (Air-Gapped, XSS-Hardened Streamlit Sovereign RAG Shell — `krusch_toolkit.streamlit_ui`)**:
  - **Disjoint Subagent 2 File**: `lib-py/krusch_toolkit/streamlit_ui.py`
  - **Disjoint Subagent 3 Test File**: `lib-py/tests/test_wave5_lego.py`
  - **Bare-Stdlib Import Purity**: Module MUST import cleanly in bare Python 3.11+ stdlib without `streamlit` installed (`st_module` injectable for deterministic headless testing; lazy `import streamlit` only when `st_module is None`).
  - **Exact Exports & Return Contracts**:
    - `AIRGAPPED_THEME_PRESETS`: Mapping Proxy (`types.MappingProxyType`) of frozen presets (`"sky"`, `"gold"`, `"emerald"`).
    - `build_airgapped_theme_css(accent: str = "sky") -> str`: Returns `<style>...</style>` CSS with offline system font stack, zero external `http://`/`https://`/`@import` URLs, and strict preset or `#RRGGBB` hex validation (preventing CSS injection via arbitrary `accent` strings).
    - `build_rag_auth_headers(session_state: Mapping[str, Any] | None = None, *, api_key: str | None = None, tenant_id: str | None = None, bearer_token: str | None = None, default_api_key: str = "", default_tenant_id: str = "", tool: str = "streamlit.auth") -> dict[str, Any]`: Resolves credentials from explicit args or `session_state`, rejects `\r`/`\n`/`\x00` (`STREAMLIT_INVALID_HEADER`), and returns `ok_envelope(tool, ..., {"headers": dict[str, str]})` or `error_envelope`.
    - `format_citation_badges_html(citations: Sequence[Mapping[str, Any]] | None, *, max_badges: int = 12, max_span_chars: int = 140) -> str`: Escapes all text fields via `html.escape(..., quote=True)`, formats numeric `[0.0, 1.0]` / `[0.0, 100.0]` confidence scores (ignoring `bool`/`NaN`/`Inf`), and ONLY emits `<a href="..." target="_blank" rel="noopener noreferrer">` when `url` parses cleanly as `http://` or `https://` without control/whitespace chars (neutralizing `javascript:`, `data:`, `vbscript:` XSS payloads into inert `<span>` badges).
    - `render_citation_badges(citations: Sequence[Mapping[str, Any]] | None, *, st_module: Any = None, max_badges: int = 12, max_span_chars: int = 140, tool: str = "streamlit.citations") -> dict[str, Any]`: Renders via `st.markdown(..., unsafe_allow_html=True)` and returns `ok_envelope(tool, ..., {"html": str, "rendered_count": int})` or `error_envelope("STREAMLIT_UNAVAILABLE", ...)`.
    - `init_rag_session_state(session_state: MutableMapping[str, Any] | None = None, *, st_module: Any = None, defaults: Mapping[str, Any] | None = None, messages_key: str = "messages", max_turns: int = 100, tool: str = "streamlit.state") -> dict[str, Any]`: Ensures bounded list `session_state[messages_key]` and deep-copied default keys without clobbering existing user values; returns `ok_envelope` or `error_envelope`.
    - `append_rag_turn(session_state: MutableMapping[str, Any] | None, role: str, content: str, *, citations: Sequence[Mapping[str, Any]] | None = None, st_module: Any = None, messages_key: str = "messages", max_turns: int = 100, tool: str = "streamlit.chat") -> dict[str, Any]`: Validates `role` in `{"user", "assistant", "system"}` (`STREAMLIT_INVALID_ROLE`), non-empty `str` `content` (`STREAMLIT_EMPTY_CONTENT`), integer `max_turns >= 1` (rejecting `bool`), sanitizes/copies `citations`, trims oldest turns beyond `max_turns`, and returns `ok_envelope(tool, ..., {"turn": dict, "turn_count": int})` or `error_envelope`.
    - `render_sovereign_rag_shell(*, title: str, subtitle: str = "", badge_text: str = "AIR-GAPPED", disclaimer: str = "", accent: str = "sky", page_icon: str = "🛡️", health_status: str | None = None, configure_page: bool = True, max_turns: int = 100, st_module: Any = None, tool: str = "streamlit.shell") -> dict[str, Any]`: Calls `st.set_page_config(...)` when `configure_page=True` (gracefully catching duplicate-call `StreamlitAPIException` / `StreamlitSetPageConfigMustBeFirstCommandError`), injects air-gapped CSS + `html.escape`-hardened header/health/disclaimer banner, initializes session state, and returns `ok_envelope` or `error_envelope`.

- **`INV-SENTINEL-MEM-01` (Linux `MemAvailable` Parity in `krusch-sentinel-mcp`)**:
  - **Disjoint Subagent 4 Files**: `projects/krusch-sentinel-mcp/src/tools/telemetry.ts`, `projects/krusch-sentinel-mcp/tests/sentinel.test.js` (plus `npx tsc` rebuild of `dist/`).
  - Exports pure `parseLinuxMeminfoBytes(meminfoText: string): { totalBytes: number; availableBytes: number } | null` parsing `MemTotal:` and `MemAvailable:` (falling back to `MemFree + Buffers + Cached` when `MemAvailable` is absent on legacy kernels, clamping `0 <= availableBytes <= totalBytes`).
  - Updates `getSystemStats(node?: string)` so local Linux nodes read `/proc/meminfo` (`MemAvailable` rather than raw `os.freemem()` `MemFree`) and remote Linux nodes read `/proc/meminfo` via `execRemote` (locale-independent, avoiding `LC_ALL` `free -b` header mismatches), computing `freeMemGB` from reclaimable-aware `availableBytes` and `usedMemPercent` from `((totalBytes - availableBytes) / totalBytes) * 100` while preserving 100% of existing return properties and error fallback contracts.

- **Orchestrator Choke Points (Phase 3B — Parent Orchestrator Only)**:
  - `lib-py/pyproject.toml` & `lib-py/krusch_toolkit/__init__.py` (`v1.5.0` exports)
  - `lib/catalog.js` (`python_http_client` & `python_streamlit_ui` -> `32` `RUNTIME_BRICKS`)
  - `lib/lego-scout.js` (`python-httpx-resilience` & `streamlit-rag-shell` -> `COVERED_BY_TOOLKIT_V1_5`, plus Wave-6 horizon detectors `python-sqlalchemy-wal-pool` & `yaml-safe-config-loader`)
  - `lib/test_wave3_bricks.js`, `lib/test_wave5_bricks.js`, `lib/README.md`, & workspace `AGENTS.md` (`< 18,432` bytes)

---

## 7. Wave 6 Rule-of-3 Promotion & Swarm Queue Janitor Contracts (`INV-LEGO-23`..`INV-LEGO-24` & `INV-JANITOR-01`)

> **STATUS: FROZEN (`2026-10-31`)** — Promotes the final 2 empirical `CANDIDATE_MEETS_RULE_OF_3` clusters across all 100 workspace repositories (`yaml-safe-config-loader` [`10` repos] and `python-sqlalchemy-wal-pool` [`9` repos]) into `@krusch/toolkit` `v1.7.0` & `krusch_toolkit` `v1.6.0` (`35` `RUNTIME_BRICKS`, achieving `100%` Rule-of-3 cluster coverage), and hardens the Jean SRE Swarm Queue Janitor (`INV-JANITOR-01`).

- **`INV-LEGO-23` (Cross-Runtime Safe YAML Config & Authority-Pack Loader — `@krusch/toolkit/yaml` & `krusch_toolkit.yaml_loader`)**:
  - **Disjoint Subagent 1 Files (Node/Edge/Browser)**: `lib/yaml.js`, `lib/types/yaml.d.ts`
    - **Zero-Dependency, Zero-`node:*` Isomorphic Purity**: `lib/yaml.js` MUST contain zero `node:*` strings (`/\bnode:[a-z_]+/i.test(src) === false`) and import only `{ validateSchema } from './schema.js'`, running unmodified in Node 22 ESM, Cloudflare Workers, and browsers.
    - **Exact Exports & Return Contracts**:
      - `DEFAULT_YAML_LIMITS`: Frozen `{ maxBytes: 1_048_576, maxDepth: 32, maxNodes: 10_000, maxAliases: 64, maxAliasExpansionNodes: 1_000 }`.
      - `parseSafeYaml(input, options = {})`: Accepts `string`, `Uint8Array`, or `ArrayBuffer` (else `errorEnvelope('YAML_INVALID_INPUT', ...)`). Enforces `maxBytes` pre-parse (`YAML_TOO_LARGE`), rejects non-positive/`bool`/`NaN` numeric options (`YAML_INVALID_OPTIONS`), rejects NUL bytes and invalid UTF-8 (`YAML_PARSE_ERROR`), and parses YAML 1.2 Core Schema (block/flow mappings & sequences, compact `- key: val` items, single/double-quoted escapes, literal `|`/`|-`/`|+` & folded `>`/`>-`/`>+` block scalars, `#` comments, `---`/`...` markers). Security invariants:
        1. **No Arbitrary Tags**: Rejects explicit tags (`!tag`, `!!python/...`, `!!js/...`, `!!binary`, `!!timestamp`, `!<...>`, `%TAG`) outside strings/comments with `YAML_FORBIDDEN_TAG`.
        2. **YAML 1.2 Core Types (Norway-Safe & JSON-Safe)**: Only `true`/`True`/`TRUE` and `false`/`False`/`FALSE` parse as booleans (`NO`, `yes`, `on`, `off` remain `string`); ISO dates (`2026-01-01`) remain `string`; `.nan`/`.inf`/`-.inf` are rejected with `YAML_NONFINITE_NUMBER`.
        3. **Prototype, Key & Duplicate Guards**: Rejects `__proto__`, `constructor`, `prototype` (`YAML_FORBIDDEN_KEY`), non-string mapping keys (`YAML_INVALID_KEY`), and duplicate keys within the same mapping (`YAML_DUPLICATE_KEY`).
        4. **Bounded Anchors/Aliases & Merge Keys (`&a`, `*a`, `<<`)**: Deep-clones dereferenced aliases while bounding total alias references (`<= maxAliases`) and cumulative cloned nodes (`<= maxAliasExpansionNodes`), aborting Billion-Laughs exponential blowups with `YAML_ALIAS_BOMB` (plus `YAML_MAX_DEPTH` and `YAML_MAX_NODES`). Rejects multi-document streams unless `allowMultipleDocuments === true` (`YAML_MULTIPLE_DOCUMENTS`).
        5. Returns `INV-LEGO-01` `okEnvelope(tool, ..., { value, byteLength, nodeCount, aliasCount })` or `errorEnvelope`.
      - `stringifySafeYaml(value, options = {})`: Cycle-guarded, depth-bounded (`maxDepth`), `NaN`/`Infinity`/`BigInt`/`function`/`symbol`-rejecting YAML 1.2 serializer quoting ambiguous scalars (`true`, `false`, `null`, `~`, numeric literals, empty strings, control chars, `: `, ` #`, leading indicator chars). Returns `okEnvelope(tool, ..., { yaml })` or `errorEnvelope('YAML_STRINGIFY_ERROR', ...)`.
      - `validateYamlConfig(input, schema, options = {})`: Parses via `parseSafeYaml` and validates via `validateSchema(value, schema, { tool })`, returning `okEnvelope(tool, ..., { value, byteLength, nodeCount })` or `errorEnvelope`.
      - `loadSafeYamlPack(input, options = {})`: Parses via `parseSafeYaml`, requires a plain JSON object root (`YAML_INVALID_PACK`), checks optional `requiredKeys` (`string[]`) and optional `schema`, computes pure-JS synchronous SHA-256 hex digest over canonical UTF-8 input bytes, and returns `okEnvelope(tool, ..., { pack, sha256, byteLength, nodeCount })` or `errorEnvelope`.
  - **Disjoint Subagent 2 File (Python)**: `lib-py/krusch_toolkit/yaml_loader.py`
    - **Bare-Stdlib Import Purity**: Module MUST import cleanly in bare Python 3.11+ stdlib (`import yaml` occurs lazily inside execution, returning `YAML_UNAVAILABLE` if PyYAML is absent and `yaml_module=False`).
    - **Exact Exports & Return Contracts**:
      - `DEFAULT_YAML_LIMITS` (`types.MappingProxyType`), `parse_safe_yaml`, `dump_safe_yaml`, `validate_yaml_config`, `load_safe_yaml_pack`.
      - Subclasses `yaml.SafeLoader` into `_SovereignSafeLoader` enforcing YAML 1.2 Core booleans (`true`/`false` only; `NO`/`on`/`off` stay `str`), keeping ISO dates as `str` (removing `tag:yaml.org,2002:timestamp` and `tag:yaml.org,2002:binary`/`omap`/`pairs`/`set`), rejecting all custom/arbitrary `!` tags (`YAML_FORBIDDEN_TAG`), `.nan`/`.inf` (`YAML_NONFINITE_NUMBER`), `__proto__`/`constructor`/`prototype` (`YAML_FORBIDDEN_KEY`), non-string keys (`YAML_INVALID_KEY`), duplicate keys (`YAML_DUPLICATE_KEY`), and enforcing `max_bytes` (`YAML_TOO_LARGE`), `max_depth` (`YAML_MAX_DEPTH`), `max_nodes` (`YAML_MAX_NODES`), `max_aliases` & `max_alias_expansion_nodes` (`YAML_ALIAS_BOMB` counted during composition BEFORE full graph construction, returning deep-cloned alias subtrees so mutating one branch never mutates another).
      - `load_safe_yaml_pack(path_or_text, *, base_dir=None, from_file=False, required_keys=None, schema=None, ...)`: When reading from disk (`from_file=True` or `os.PathLike`), enforces `realpath` containment inside `base_dir` (`YAML_PATH_TRAVERSAL`), verifies regular file via `os.open` + `os.fstat` (`S_ISREG`) and bounded `read(max_bytes + 1)` (`YAML_TOO_LARGE`), computes `hashlib.sha256`, validates dict root + `required_keys` + `validate_payload`, and returns `ok_envelope(tool, ..., {"pack": dict, "sha256": str, "byte_length": int, "node_count": int, "source_path": str | None})` or `error_envelope`.

- **`INV-LEGO-24` (Python SQLAlchemy Sync/Async Pool, SQLite WAL & Transactional Session Scopes — `krusch_toolkit.db_async`)**:
  - **Disjoint Subagent 3 File**: `lib-py/krusch_toolkit/db_async.py`
  - **Bare-Stdlib Import Purity**: Module MUST import cleanly in bare Python 3.11+ stdlib (`sqlalchemy` imported lazily inside functions or injected via `sa_module` / `async_engine_factory`).
  - **Exact Exports & Return Contracts**:
    - `DEFAULT_SQLITE_PRAGMAS` (`types.MappingProxyType`), `redact_database_url(database_url: str) -> str`, `apply_sqlite_wal_pragmas(dbapi_connection, *, busy_timeout_ms=5000, synchronous="NORMAL", foreign_keys=True, journal_mode="WAL") -> dict[str, Any]`.
    - `create_managed_engine(database_url=None, *, env_var="DATABASE_URL", pool_size=5, max_overflow=10, pool_timeout=30.0, pool_recycle=1800, busy_timeout_ms=5000, sqlite_wal=True, synchronous="NORMAL", foreign_keys=True, echo=False, sa_module=None, tool="db_async.engine") -> dict[str, Any]`:
      - Rejects `bool`/`NaN`/`Inf`/out-of-range numeric options and non-whitelisted `synchronous` values (`DB_INVALID_OPTIONS`), missing URL (`DB_MISSING_URL`), and async driver schemes (`+aiosqlite`, `+asyncpg`) passed to sync engine (`DB_ASYNC_DRIVER_MISMATCH`). Attaches SQLite `connect` event listener applying `WAL`/`synchronous`/`busy_timeout`/`foreign_keys`/`temp_store` pragmas and configures `pool_pre_ping=True` + bounded pool kwargs on pooled dialects. Returns `ok_envelope(tool, ..., {"engine": engine, "session_factory": session_factory, "dialect": str, "redacted_url": str, "is_async": False})` or `error_envelope` (scrubbing credentials on driver/parse failure).
    - `create_managed_async_engine(database_url=None, *, env_var="DATABASE_URL", pool_size=5, max_overflow=10, pool_timeout=30.0, pool_recycle=1800, busy_timeout_ms=5000, sqlite_wal=True, synchronous="NORMAL", foreign_keys=True, echo=False, async_engine_factory=None, tool="db_async.async_engine") -> dict[str, Any]`:
      - Validates async URL scheme (`sqlite+aiosqlite`, `postgresql+asyncpg`, `postgresql+psycopg`, etc.; rejects sync-only URLs when `async_engine_factory is None` with `DB_ASYNC_DRIVER_MISMATCH`), catches missing async DBAPI packages cleanly (`DB_DRIVER_UNAVAILABLE`), wires `sync_engine` SQLite WAL listener when present, and returns `ok_envelope(..., {"engine": engine, "session_factory": session_factory, "dialect": str, "redacted_url": str, "is_async": True})` or `error_envelope`.
    - `session_scope(session_factory)` (`@contextmanager`) and `async_session_scope(session_factory)` (`@asynccontextmanager`): Commit on clean exit, rollback and re-raise on `BaseException` (including `asyncio.CancelledError` / `KeyboardInterrupt`), and close in `finally` without masking the primary exception.
    - `check_engine_health(engine, *, tool="db_async.health")` and `check_async_engine_health(engine, *, tool="db_async.health")`: Execute `SELECT 1` (plus `PRAGMA journal_mode` for SQLite) and return `ok_envelope(tool, ..., {"healthy": True, "dialect": str, "journal_mode": str | None})` or credential-redacted `error_envelope("DB_UNHEALTHY", ...)`.

- **`INV-JANITOR-01` (Protected-Queue Swarm Janitor — `scripts/jean_queue_janitor.js`)**:
  - **Disjoint Subagent 4 Files**: `scripts/jean_queue_janitor.js`, `scripts/test_jean_queue_janitor.js`
  - Zero hardcoded database passwords or private LAN IPs in source; resolves `DATABASE_URL` from environment / `.env` files (`projects/jean-sre/.env`, `.env`) or `buildPgConnectionString` (`@krusch/toolkit/pg`), using `createPgPool` from `../lib/pg.js` (`INV-LEGO-01`).
  - `PROTECTED_JOB_TYPES = Object.freeze(['human_review', 'debate_proposal', 'debate_rebuttal'])`: `triageStaleJobs` MUST NEVER fail or mutate protected human-in-the-loop review items, and MUST evaluate staleness via `COALESCE(started_at_ms, (EXTRACT(EPOCH FROM created_at) * 1000)::bigint) < $1` so orphaned `pending` `intent` rows with `NULL` `started_at_ms` are also caught.
  - `commitSreMemory` provides explicit `crypto.randomUUID()` `id` when inserting into `ide_agent_memory` (handling `id uuid NOT NULL` safely without crashing if `gen_random_uuid()` default is absent).
  - Exports `PROTECTED_JOB_TYPES`, `resolveJanitorDatabaseUrl`, `triageStaleJobs`, `purgeOldLogs`, and `runQueueJanitor` returning `INV-LEGO-01` `{ ok, tool: 'sre.queue_janitor', summary, data | error }` envelopes while preserving CLI `--dry-run` (default) and `--execute` flags.

- **Orchestrator Choke Points (Phase 3B — Parent Orchestrator Only)**:
  - `lib/package.json` (`v1.7.0`, `./yaml` subpath), `lib/index.js`, `lib/types/index.d.ts`
  - `lib/catalog.js` (`yaml`, `python_yaml`, `python_db_async` -> `35` `RUNTIME_BRICKS` [`10` Python] + Rule 10 `unsafe-yaml-load` flagging raw `yaml.load(` without `SafeLoader` in Python or `js-yaml` `yaml.load(` without `@krusch/toolkit/yaml`)
  - `lib/lego-scout.js` (`python-sqlalchemy-wal-pool` -> `COVERED_BY_TOOLKIT_V1_6`, `yaml-safe-config-loader` -> `COVERED_BY_TOOLKIT_V1_7`, plus adopted-brick exemptions for `@krusch/toolkit/yaml`, `krusch_toolkit.yaml_loader`, and `krusch_toolkit.db_async`) & `projects/jean-sre/src/jean_sre_sweep.js` (`buildLegoScoutContextBrief` explicit `0 uncovered clusters` `CANDIDATE_MEETS_RULE_OF_3` line when `100%` covered)
  - `lib-py/pyproject.toml` & `lib-py/krusch_toolkit/__init__.py` (`v1.6.0` exports)
  - `lib/test_lego_bricks.js`, `lib/test_wave3_bricks.js`, `lib/test_wave5_bricks.js`, `lib/test_wave6_bricks.js`, `lib-py/tests/test_wave6_lego.py`, `lib/README.md`, & workspace `AGENTS.md` (`< 18,432` bytes)

---

## 8. Step 8B — Brownfield FastAPI Shell Parity & Sovereign Legal/Corporate Suite Migration (`INV-LEGO-25`)

> **STATUS: FROZEN (`2026-10-31T15:10:00-07:00`)** — Extends `krusch_toolkit.fastapi_app.create_fastapi_app` with opt-in, zero-regression brownfield compatibility switches and migrates all three Sovereign Legal & Corporate engines (`krusch-law`, `krusch-biz`, `krusch-bizlaw`) to `0` `krusch-lego audit` boilerplate findings while preserving 100% of existing REST, Streamlit, `krusch-gateway-mcp`, and standalone GitHub Actions CI contracts.

- **`INV-LEGO-25` (Brownfield FastAPI Shell Compatibility & Zero-Breakage Consumer Adoption)**:
  - **Disjoint Subagent 1 Files (`lib-py/`)**: `lib-py/krusch_toolkit/fastapi_app.py`, `lib-py/tests/test_fastapi_lego.py`
    - **100% Default Backward Compatibility**: Calling `create_fastapi_app(...)` with default keyword arguments MUST remain byte-identical to `v1.6.0` (`ok_envelope` only on `/health` & `/doctor`, strict `error_envelope` without `"detail"` on `HTTPException`/`RequestValidationError`/`500`, and `allow_credentials = len(resolved_origins) > 0 and "*" not in resolved_origins`).
    - **Extended Signature**:
      `create_fastapi_app(title: str = "Krusch Service", version: str = "1.0.0", *, description: str = "", docs_url: str | None = "/docs", redoc_url: str | None = "/redoc", service_name: str | None = None, cors_origins: list[str] | None = None, allow_credentials: bool | None = None, lifespan: Callable[[Any], Any] | None = None, health_check: Callable[..., Any] | None = None, flatten_health_payload: bool = False, legacy_error_detail: bool = False, startup_hooks: list[Callable[[], Any]] | None = None, shutdown_hooks: list[Callable[[], Any]] | None = None, logger: Any = None) -> Any`
    - **Lifespan Composition**: Runs `startup_hooks` in order, enters `async with lifespan(_app): yield` when `lifespan is not None` (else `yield`), and runs `shutdown_hooks` in `finally` without masking a primary startup/lifespan/runtime exception.
    - **CORS Credentials Guard**: When `allow_credentials` is `None`, computes `len(resolved_origins) > 0 and "*" not in resolved_origins`; when a `bool` is passed, clamps to `False` if `"*"` is in `resolved_origins` or `len(resolved_origins) == 0` so browsers never reject wildcard CORS preflights.
    - **Request-Aware Health & Doctor Probes**:
      - Inspects `health_check` via `inspect.signature`: if `health_check` accepts $\ge 1$ positional argument (`POSITIONAL_ONLY`, `POSITIONAL_OR_KEYWORD`, or `VAR_POSITIONAL`), passes `request` (`health_check(request)`), else calls `health_check()`.
      - Explicitly binds `__annotations__ = {"request": Request, "return": Any}` on route handlers so FastAPI's `get_typed_signature` resolves `starlette.requests.Request` cleanly under `from __future__ import annotations`.
      - `GET /doctor` ALWAYS returns strict `INV-LEGO-01` `ok_envelope(resolved_name, "Service healthy", payload)`.
      - `GET /health` returns strict `ok_envelope` when `flatten_health_payload=False`, and `{**payload, **ok_envelope(resolved_name, "Service healthy", payload)}` when `flatten_health_payload=True` (exposing top-level domain keys like `status`, `service`, `security`, `database_connected`, and `fleet_connectivity` alongside immutable `ok`, `tool`, `summary`, and `data` envelope fields; on `503` unhealthy responses when `legacy_error_detail=True`, attaches `"detail": msg`).
    - **Dual-Envelope Error Compatibility (`legacy_error_detail=True`)**:
      - Adds `423: "LOCKED"` and `424: "FAILED_DEPENDENCY"` to `_HTTP_STATUS_CODES`.
      - When `legacy_error_detail=True`, `_http_exception_handler` attaches `"detail": jsonable_encoder(raw_detail) if raw_detail is not None else message` to `error_envelope(...)`, and `_validation_exception_handler` attaches `"detail": encoded_errors` to `error_envelope(...)`.

  - **Disjoint Subagent 2 Files (`krusch-law`)**: `projects/krusch-law/src/backend/main.py`, `projects/krusch-law/tests/unit/test_fastapi_lego_shell.py`
    - Discovers sibling monorepo `lib-py` via `os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", "lib-py"))` (strictly zero hardcoded OS home paths and zero external cloud vendor strings `google|gemini|openai|anthropic` enforced by `ci.yml`).
    - Imports `from krusch_toolkit.fastapi_app import create_fastapi_app, error_envelope, ok_envelope` with a standalone CI `except ImportError:` fallback (using `app.add_api_route`, never `@app.get("/health")`) so standalone GitHub Actions runs pass on Python `3.11` & `3.12`.
    - Replaces hand-rolled `FastAPI(...)`, `CORSMiddleware`, and `@app.get("/health")` with `health_check()` + `create_fastapi_app(..., service_name="kruschlaw-backend", version="0.3.0", cors_origins=settings.cors_origins_list, allow_credentials=True, lifespan=lifespan, health_check=health_check, flatten_health_payload=True, legacy_error_detail=True, logger=logger)`.

  - **Disjoint Subagent 3 Files (`krusch-biz`)**: `projects/krusch-biz/src/backend/main.py`, `projects/krusch-biz/tests/test_fastapi_lego_shell.py`
    - Discovers sibling monorepo `lib-py` via `os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", "lib-py"))` (zero hardcoded OS home paths) and imports `from krusch_toolkit.fastapi_app import create_fastapi_app, error_envelope, ok_envelope` with standalone CI `except ImportError:` fallback.
    - Updates `health_check(db_or_request: Any = None)` so `request: Request` resolves DB sessions through `request.app.dependency_overrides.get(get_db, get_db)()` (closing the generator in `finally`), direct `Session` objects execute directly, and `None` uses `get_db()`, returning HTTP `200` `"healthy"`/`"degraded"` diagnostics via `create_fastapi_app(..., service_name="kruschbiz-backend", version="0.1.0-alpha.1", cors_origins=settings.cors_origins_list, allow_credentials=True, lifespan=lifespan, health_check=health_check, flatten_health_payload=True, legacy_error_detail=True, logger=logger)`.

  - **Disjoint Subagent 4 Files (`krusch-bizlaw`)**: `projects/krusch-bizlaw/src/backend/main.py`, `projects/krusch-bizlaw/tests/test_fastapi_lego_shell.py`
    - Discovers sibling monorepo `lib-py` via `os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", "lib-py"))` (zero hardcoded OS home paths) and imports `from krusch_toolkit.fastapi_app import create_fastapi_app, error_envelope, ok_envelope` with standalone CI `except ImportError:` fallback.
    - Replaces hand-rolled `FastAPI(...)`, `CORSMiddleware`, and `@app.get("/health")` with `health_check(request: Request)` + `create_fastapi_app(..., title="KruschBizLaw API", version="0.2.0", service_name="krusch-bizlaw", cors_origins=settings.cors_origins_list, allow_credentials=True, lifespan=lifespan, health_check=health_check, flatten_health_payload=True, legacy_error_detail=True, logger=logger)` followed by `_init_service_clients(app)`.

  - **Orchestrator Choke Points (Phase 3B — Parent Orchestrator Only)**:
    - `lib/spec.md` (Section 8 frozen contract)
    - Reconcile `krusch-biz` `INV-12` anchor `#8` (`.github/workflows/ci.yml`) via `krusch_context_revise`
    - Full `krusch-lego audit` (`0` boilerplate findings across `krusch-law`, `krusch-biz`, `krusch-bizlaw`), L0 Dual-Zero-Finding Referee convergence, GitHub Actions CI verification, multi-node `lib-py` sync, `kdcode` re-indexing, and `GEMINI_INFLIGHT.md` update.

---

## 9. Public Open-Source Release, Zero-Leak Sanitization & Unified Node + Python Distribution (`INV-LEGO-26`)

> **STATUS: FROZEN (`2026-10-31T16:10:00-07:00`)** — Publishes `@krusch/toolkit` (`v1.7.0` Node/TS/Workers at repository root) and `krusch_toolkit` (`v1.6.0` Python 3.11+ inside `python/`) to `https://github.com/kruschdev/toolkit` with deterministic Zero-Leak CI enforcement (`scripts/verify-zero-leaks.js`), clean orphan single-root Git history (`kruschdev <kruschdev@users.noreply.github.com>`), and companion cross-linking in `krusch-stack`.

- **`INV-LEGO-26` (Public Toolkit Zero-Leak Gate, Standalone Portability & Unified Distribution)**:
  - **Zero-Leak Invariant**: Every tracked file in `kruschdev/toolkit` (and upstream `lib/` + `lib-py/`) MUST pass `node ./scripts/verify-zero-leaks.js --strict-release` with `0` findings:
    1. **Zero Secret Tokens / Keys**: `0` matches for API keys, PATs, PEM blocks, or hardcoded DB credentials (`AIzaSy*`, `sk-*`, `ghp_*`, `github_pat_*`, `xox*`, `PRIVATE KEY`).
    2. **Zero Private Host IPs**: `0` hardcoded LAN/10GbE/Tailscale host IPs (`192.168.<h>.<h>`, `10.10.<h>.<h>`, `10.0.0.<1-255>`, `100.<65-127>.<h>.<h>`), permitting only RFC subnet CIDR masks (`10.0.0.0/8`, `192.168.0.0/16`, `100.64.0.0/10`) and generic RFC test vectors (`10.1.2.3`, `172.16.1.2`, `100.64.1.2`, `198.51.100.*`, `203.0.113.*`, `127.0.0.1`).
    3. **Zero Host Filesystem Paths**: `0` `/home/<user>/` or `/mnt/<volume>` host paths anywhere in runtime code, blueprints, docs, or tests.
    4. **Zero Internal Hostnames, DB Names, or Personal PII**: Enforced via SHA-256 salted token digests in `scripts/verify-zero-leaks.js` so the scanner itself never embeds plaintext PII or internal hostnames while catching any accidental re-introduction.
    5. **Zero Unlinked Git Emails & Zero Relative `file:..` / `git+ssh://` Dependencies (`--strict-release`)**: Author/committer attribution strictly `kruschdev <kruschdev@users.noreply.github.com>`; `package.json` and `package-lock.json` contain zero `"file:.."` parent monorepo references and zero `"git+ssh://"` URLs (`krusch-cascade-router` declared via SHA-512 integrity-pinned HTTPS tarball in `optionalDependencies` with lazy dynamic import in `lib/llm.js`).

  - **Disjoint Subagent 1 Files (JS Core Runtime Sanitization)**:
    - `lib/config.js`, `lib/embeddings.js`, `lib/llm.js`, `lib/llm-queue.js`, `lib/polygres.js`, `lib/dbos.js`, `lib/tracing.js`
    - Preserves all public function/class signatures (`getHomelabTopology`, `getHomelabContext`, `DEFAULT_EMBED_HOST = 'http://127.0.0.1:11434'`, `DEFAULT_FLEET_OLLAMA_NODES = Object.freeze(['http://127.0.0.1:11434'])`, lazy `await import('krusch-cascade-router')` in `lib/llm.js`, `bgBaseUrl = process.env.OLLAMA_BG_URL || ollamaBaseUrl`, `appdb` default in `polygres.js`, `os.tmpdir()` default trace path in `tracing.js`).

  - **Disjoint Subagent 2 Files (JS Governance, Skill & Spatial Sanitization)**:
    - `lib/prune.js`, `lib/trajectory-guard.js`, `lib/skiller.js`, `lib/types/skiller.d.ts`, `lib/evqa-grounding.js`, `lib/kv-cache-manager.js`, `lib/lego-scout.js`
    - Replaces personal/internal keywords in `prune.js` with generic infra & billing domain triggers; generalizes credential leak regex in `trajectory-guard.js`; defaults `stageSkillForMonorepo` `targetDir` to `path.join(process.cwd(), '.agent', 'skills')`; defaults `EvidenceGroundingEngine` `propertyId` to `'demo-property'`; defaults `createGvaAllocator` & `createKvCacheManager` `node` to `'gpu-node-0'` and `storageDir` to `'./.cache/kv_cache'`; generalizes OS home-path scrub comments in `lego-scout.js`.

  - **Disjoint Subagent 3 Files (JS Test Suites & Standalone CI Portability)**:
    - `lib/test_physical_ai_research.js`, `lib/test_new_research_refinements.js`, `lib/test_new_research_modules.js`, `lib/test_september_ai_research.js`, `lib/test_september_mid_ai_research.js`, `lib/test_raw_rag.js`, `lib/test_embeddings.js`, `lib/test_wave3_bricks.js`, `lib/test_wave4_bricks.js`, `lib/test_lego_bricks.js`, `lib/test-browser.js`
    - Scrubs residential street address & internal node/DB fixtures; updates `DEFAULT_EMBED_HOST` & `DEFAULT_FLEET_OLLAMA_NODES` assertions to `'http://127.0.0.1:11434'`; guards optional sibling repo assertions in `test_lego_bricks.js` (checking `./python` when `../lib-py` is absent and guarding `../projects/krusch-stack` with `fs.existsSync`); hardens headless Chrome skip guard across all steps in `test-browser.js`.

  - **Disjoint Subagent 4 Files (Python `krusch_toolkit` Runtime & Tests Sanitization)**:
    - `lib-py/krusch_toolkit/embeddings.py`, `lib-py/krusch_toolkit/tracing.py`, `lib-py/krusch_toolkit/system.py`, `lib-py/krusch_toolkit/swarm/architect.py`, `lib-py/krusch_toolkit/swarm/director.py`, `lib-py/krusch_toolkit/swarm/db_bridge.py`, `lib-py/tests/test_embeddings.py`, `lib-py/tests/test_raw_rag.py`, `lib-py/tests/test_wave3_lego.py`, `lib-py/tests/test_wave6_lego.py`, `lib-py/.gitignore`
    - Sets `DEFAULT_EMBED_HOST = "http://127.0.0.1:11434"`; uses `tempfile.gettempdir()` fallback in `tracing.py`; removes `sudo` and internal node references in `system.py`; replaces internal IPs, legacy placeholder keys, and DB names in `swarm/*`; updates all Python test fixtures to generic RFC test IPs and `appdb`.

  - **Orchestrator Choke Points (Phase 3B — Parent Orchestrator Only)**:
    - `lib/catalog.js`, `lib/AGENTS.md`, `lib/README.md`, `lib/.gitignore`, `lib/.env.example`, `lib/LICENSE` (MIT), `lib/package.json` (`v1.7.0`, MIT, `verify:zero-leaks`, `optionalDependencies`), `lib/scripts/verify-zero-leaks.js`, `lib/test_zero_leaks.js`
    - Standalone release assembly (`python/` synced from `lib-py/`, `.github/workflows/ci.yml`, clean `package-lock.json`, single-commit orphan push to `kruschdev/toolkit`)
    - Companion cross-link in `projects/krusch-stack/README.md` (`kruschdev/krusch-stack`)

---

## 10. Step 8C — Flagship Core Services `LEGO-ADOPT` Migration Batch (`INV-LEGO-27`)

> **STATUS: FROZEN (`2026-10-31T19:33:00-07:00`)** — Extends `@krusch/toolkit/streaming` (`deferHeaders`) and `krusch_toolkit.fastapi_app.sse_event_response` (`passthrough`) with 100%-backward-compatible brownfield transport options and migrates 5 flagship `AGENTS.md` core services (`krusch-ci-sentinel`, `berean`, `krusch-agentic-proxy`, `g-krusch`, `krusch-frontend-mcp`) to `0` `krusch-lego audit` boilerplate findings (`9` findings eliminated across `8` source files, reducing fleet `[LEGO-ADOPT]` from `37` $\rightarrow$ `32`).

- **`INV-LEGO-27` (Deferred-Header MCP SSE, Passthrough OpenAI SSE & Standalone CI Fallback Parity)**:
  - **Orchestrator Pre-Wire (Additive Toolkit Enhancements — Zero Breaking Changes)**:
    1. `lib/streaming.js` & `lib/types/streaming.d.ts`:
       - Adds `deferHeaders?: boolean` (`default: false`) to `sseResponse(res, req, options)`.
       - When `deferHeaders === false` (default): behavior is 100% byte-identical (`writeSseHeaders` + `retry: <ms>\n\n`).
       - When `deferHeaders === true`: sets `X-Accel-Buffering: no` via `res.setHeader` without flushing status/headers or writing an initial `retry:` frame so downstream transports (e.g. `@modelcontextprotocol/sdk`'s `SSEServerTransport.start()`) can call `res.writeHead(200, ...)` without `ERR_HTTP_HEADERS_SENT`, while attaching `AbortController` disconnect listeners and unref'd `: ping\n\n` heartbeats (writing heartbeats only once `res.headersSent === true`).
    2. `lib-py/krusch_toolkit/fastapi_app.py`:
       - Adds `passthrough: bool = False` (and `heartbeat_comment: str | None = "ping"`) to `sse_event_response`.
       - When `passthrough=False` (default): behavior is 100% byte-identical (`INV-LEGO-03` structured `event: token` / `event: done` / `event: error` frames).
       - When `passthrough=True`: yields raw `str | bytes` SSE chunks untouched (for OpenAI `chat.completion.chunk` `data: ...\n\ndata: [DONE]\n\n` streams and upstream `httpx` byte-stream proxies) while preserving `_is_request_disconnected(request)` cancellation, `aclosing(_iterate_sse_source(...))` deterministic upstream socket/generator cleanup, optional `: <heartbeat>\n\n` comment when `heartbeat_comment` is non-empty, and `Cache-Control: no-cache, no-transform` / `Connection: keep-alive` / `X-Accel-Buffering: no` anti-buffering headers.

  - **Disjoint Subagent 1 Files (`krusch-ci-sentinel`)**: `projects/krusch-ci-sentinel/src/mcp_bridge.js`, `projects/krusch-ci-sentinel/test/verifier.test.js`
    - Eliminates hardcoded host path in `mcp_bridge.js` by resolving `process.env.KRUSCH_CONTEXT_DB_PATH` or relative sibling `../../krusch-context-mcp/.agent/context.db` (plus optional `entry.dbPath` override for hermetic tests).
    - Loads `openSqliteDb` from sibling `../../../lib/sqlite.js` (`@krusch/toolkit/sqlite`) when available with a standalone CI fallback (`node:sqlite`), closing the handle in `finally` inside `recordContextMemory`.

  - **Disjoint Subagent 2 Files (`berean`)**: `projects/berean/db/pool.js`, `projects/berean/routes/api.js`, `projects/berean/tests/conversations.test.js`
    - Replaces raw `new pg.Pool(dbConfig)` in `db/pool.js` with `createPgPool(dbConfig, { serviceName: 'berean-db' })` from `@krusch/toolkit/pg` while preserving `export const dbConfig`, `export default pool`, exact `import { DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD } from '../src/config/dbConfig.js'`, and zero `process.env` reads (`ARCH-02`).
    - Replaces manual `res.writeHead(200, { 'Content-Type': 'text/event-stream', ... })` in `POST /api/ask/stream` (`routes/api.js`) with `sseResponse(res, req, { tool: 'berean.ask_stream' })` from `@krusch/toolkit/streaming`, emitting `{ type: 'meta' | 'chunk' | 'sources' | 'done' | 'error' }` payloads via `stream.send('message', ...)` and terminating with `stream.close()` so `client/dist/app.js` line-based `data: ` parsing remains 100% compatible.

  - **Disjoint Subagent 3 Files (`krusch-agentic-proxy`)**: `projects/krusch-agentic-proxy/src/api_gateway.py`, `projects/krusch-agentic-proxy/src/router.py`, `projects/krusch-agentic-proxy/tests/test_lego_sse.py`
    - Discovers sibling monorepo `lib-py` via `os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "lib-py"))` (strictly zero hardcoded OS home paths) and imports `from krusch_toolkit.fastapi_app import sse_event_response` with a standalone CI `except ImportError:` fallback (using `aclosing` + anti-buffering headers without literal raw `text/event-stream` boilerplate).
    - Wraps `_event_generator()` in `_build_sse_response` (`src/api_gateway.py`) and `stream_generator()` in `WaterfallRouter._try_stream` (`src/router.py`) with `sse_event_response(..., passthrough=True, heartbeat_comment="")`, preserving 100% of OpenAI `chat.completion.chunk` wire framing and upstream byte-stream passthrough.

  - **Disjoint Subagent 4 Files (`g-krusch`)**: `projects/g-krusch/src/index.js`, `projects/g-krusch/src/lib/db.js`, `projects/g-krusch/test/hardening.test.js`
    - Loads `sseResponse` from sibling `../../../lib/streaming.js` / `@krusch/toolkit/streaming` (with standalone CI fallback) in `src/index.js`, wiring `GET /mcp/sse` with `sseResponse(res, req, { deferHeaders: true, retryMs: 0, heartbeatMs: 15000, corsOrigin: false, tool: 'g-krusch.mcp_sse' })` so `SSEServerTransport.start()` owns `res.writeHead(200, ...)` without `ERR_HTTP_HEADERS_SENT` while preserving `GKR-01` & `GKR-07` (`app.get('/mcp/sse', apiLimiter, ...)` and `handlePostMessage(req, res, req.body)`) and zero hardcoded OS home paths (`INV-12`).
    - Loads `initDb` & `closeDb` from sibling `../../../../lib/db.js` / `@krusch/toolkit/db` (with standalone CI fallback) in `src/lib/db.js`, passing `_DatabaseClass: Database` (`better-sqlite3`) and `busyTimeout: 5000` so WAL/durability pragmas and test exit cleanup remain 100% preserved without modifying `package.json` (`npm ci` safe).

  - **Disjoint Subagent 5 Files (`krusch-frontend-mcp`)**: `projects/krusch-frontend-mcp/src/index.js`, `projects/krusch-frontend-mcp/src/lib/db.js`, `projects/krusch-frontend-mcp/tests/db.test.js`
    - Loads `createMcpServer` & `defineMcpTool` from sibling `../../../lib/mcp-server.js` / `@krusch/toolkit/mcp` (with standalone CI fallback) in `src/index.js`, normalizing `FRONTEND_TOOL_DEFINITIONS` via `defineMcpTool` and booting stdio via `createMcpServer("krusch-frontend-mcp", VERSION, FRONTEND_TOOL_DEFINITIONS, (name, args) => dispatchFrontendTool({ params: { name, arguments: args } }), { validateArgs: false })` while preserving `VERSION`, `FRONTEND_TOOL_CAPABILITIES`, `FRONTEND_TOOL_DEFINITIONS`, `dispatchFrontendTool`, and live child-process stdio execution (`scripts/evaluate-swarm.js`).
    - Loads `initDb` & `closeDb` from sibling `../../../../lib/db.js` / `@krusch/toolkit/db` (with standalone CI fallback) in `src/lib/db.js`, passing `_DatabaseClass: Database` (preserving `sqlite-vec` C-extension ABI compatibility, `validateDbPath`, `initDbAsync` mutex serialization, and `resetDbForTest` singleton reset).

---

## 11. Step 8D — Tier 1–3 Control Plane & Companion Suite `LEGO-ADOPT` Completion (`INV-LEGO-28`)

> **STATUS: FROZEN (`2026-10-31T21:08:00-07:00`)** — Extends `@krusch/toolkit/mcp` with synchronous `registerMcpHandlers` and cross-realm `rethrowMcpError` JSON-RPC protocol propagation, aligns `CATALOG_AUDIT_EXEMPT_PATH_RE` (`benchmarks?`) with `lego-scout` `SKIP_SUBDIRECTORIES` (`krusch-cascade-router/benchmark/routellm/...`), and migrates all 6 remaining `AGENTS.md` active core services (`krusch-context-mcp`, `krusch-git`, `krusch-coding-harness`, `krusch-companion`, `home-ai`, `first-things-first`) to `0` `krusch-lego audit` boilerplate findings — achieving **`24/24` (`100%`) Zero-Boilerplate Core Services** across `AGENTS.md` (`27` findings eliminated across `26` files; fleet `[LEGO-ADOPT]` reduced `32` $\rightarrow$ `26`).

- **`INV-LEGO-28` (Synchronous MCP Handler Registration, Cross-Realm `McpError` Propagation & 100% Core-Fleet Parity)**:
  - **Orchestrator Pre-Wire (Additive Toolkit Enhancements — Zero Breaking Changes)**:
    1. `lib/mcp-server.js`, `lib/index.js`, `lib/catalog.js`, `lib/types/mcp-server.d.ts`, `lib/types/index.d.ts`:
       - Exports synchronous `registerMcpHandlers(server, tools, toolHandler, options)` (called internally by `createMcpServer`), passing `(toolName, toolArgs, request)` to `toolHandler` so brownfield synchronous MCP server factories (`krusch-coding-harness`'s `createMcpServer()`, `krusch-git`'s exported `server`, and `krusch-context-mcp`'s `server.getClientVersion()` provenance hook) wire `ListToolsRequestSchema` and `CallToolRequestSchema` without breaking synchronous callers.
       - Adds `rethrowMcpError?: boolean` (`default: false`) and `capabilities?: Record<string, unknown>`: when `rethrowMcpError === true`, JSON-RPC `McpError` instances (`error instanceof McpError || error.name === 'McpError' || (typeof error.code === 'number' && error.code <= -32000)`) are rethrown across `node_modules` boundaries rather than wrapped into `errorMcpResult`, preserving 100% of `assert.rejects(..., McpError)` integration contracts.
    2. `lib/catalog.js`:
       - Updates `CATALOG_AUDIT_EXEMPT_PATH_RE` from `benchmarks` to `benchmarks?` to match `lib/lego-scout.js` `SKIP_SUBDIRECTORIES`, exempting vendored third-party benchmark suites (`krusch-cascade-router/benchmark/routellm/...`) without touching SHA-256-pinned `dist/index.js`.

  - **Standalone GitHub CI Invariant (`INV-LEGO-28A`)**:
    - Standalone GitHub repositories (`krusch-context-mcp`, `krusch-git`, `krusch-coding-harness`, `krusch-companion`) MUST NOT add relative `"file:../../lib"` dependencies to `package.json` (`npm ci` in GitHub Actions runs without sibling `lib/`). Each migrated module resolves its sibling `lib/<brick>.js` via `existsSync(new URL('...', import.meta.url))` $\rightarrow$ `import('@krusch/toolkit/<subpath>')` $\rightarrow$ deterministic standalone fallback free of raw boilerplate triggers and zero hardcoded OS home paths.
    - Monorepo-resident applications (`home-ai`, `first-things-first`) already declare `"@krusch/toolkit": "file:../../lib"` and import directly from `@krusch/toolkit/<subpath>`.
    - Zero SHA-256-pinned benchmark files (`68/68` pins) or `INV-12` quoted-span files may be modified, and zero BEAM evaluation dataset tokens may appear in `projects/krusch-context-mcp/src/*.js`.

  - **Disjoint Subagent 1 Files (`krusch-context-mcp` Storage & DB)**: `projects/krusch-context-mcp/db/pool.js`, `projects/krusch-context-mcp/scripts/clear_sqlite_embeddings.js`, `projects/krusch-context-mcp/src/sqlite-engine.js`, `projects/krusch-context-mcp/src/storage-adapter.js`
    - `db/pool.js`: Preserves lazy `pg` loading inside `getPoolInstance()` (`#877`: SQLite-only installs without `pg` never fail at module import time), checking `require.resolve('pg')` before delegating pool construction to `createPgPool` from sibling `../../../lib/pg.js` / `@krusch/toolkit/pg` (with standalone `pg` fallback).
    - `clear_sqlite_embeddings.js`, `src/sqlite-engine.js`, `src/storage-adapter.js`: Delegates `node:sqlite` connection opening to `openSqliteDb` from sibling `lib/sqlite.js` / `@krusch/toolkit/sqlite` (with standalone `node:sqlite` fallback), preserving `sqlite-engine.js` inode-rotation checks, corrupt-SQLite rotation recovery, WAL/`busy_timeout` pragmas, and zero dataset vocabulary in `src/*.js`.

  - **Disjoint Subagent 2 Files (`krusch-context-mcp` Stdio Server)**: `projects/krusch-context-mcp/src/index.js`
    - Normalizes `CORE_TOOL_DEFINITIONS` via `defineMcpTool`, registers tool handlers via `registerMcpHandlers` (`validateArgs: false, rethrowMcpError: true`) alongside `ListPromptsRequestSchema` / `GetPromptRequestSchema`, and connects stdio in `runServer()` via `createMcpServer` from `@krusch/toolkit/mcp` (with standalone CI fallback), preserving `VERSION`, `CORE_TOOLS`, `CORE_PROMPTS`, `connectedClient` provenance injection, legacy aliases (`retrieve`, `remember`, `revise`, `nudge`, `health`, `status`), and graceful shutdown.

  - **Disjoint Subagent 3 Files (`krusch-git`)**: `projects/krusch-git/db/pool.js`, `projects/krusch-git/server/mcp.js`, `projects/krusch-git/client/src/App.jsx`
    - `db/pool.js`: Delegates live pool creation to `createPgPool` (`@krusch/toolkit/pg` + standalone fallback) while preserving `KRUSCH_EPHEMERAL` / `CI` `mockPool` fallback and `export { query, pool }`.
    - `server/mcp.js`: Normalizes the 7 `krusch_git_*` tool schemas via `defineMcpTool`, attaches handlers synchronously on `export const server` via `registerMcpHandlers` (`validateArgs: false, rethrowMcpError: true`), and connects stdio in `main()` via `createMcpServer`, preserving `pg_git_*` backward-compatible aliases, `verifyDatabase()`, and `McpError` JSON-RPC rejections.
    - `client/src/App.jsx`: Wires `AbortController` `{ signal: controller.signal }` + `controller.abort()` teardown across all 3 `useEffect` hooks (`/api/repos`, `/api/tree`, `/api/blob`).

  - **Disjoint Subagent 4 Files (`krusch-coding-harness`)**: `projects/krusch-coding-harness/db/migrate.js`, `projects/krusch-coding-harness/src/brain/pool.js`, `projects/krusch-coding-harness/src/approvals/hitl-slack-gate.js`, `projects/krusch-coding-harness/src/server/mcp-server.js`
    - `db/migrate.js` & `src/brain/pool.js`: Delegates non-ephemeral PostgreSQL pool creation to `createPgPool` (`@krusch/toolkit/pg` + standalone fallback), preserving `PGlite` ephemeral mode, `getPool()`, `pool`, `query`, `withTransaction`, `closePool`, and `migrate()`.
    - `src/approvals/hitl-slack-gate.js`: Delegates HMAC computation and constant-time Slack `v0` verification to `signWebhookHmac` & `verifySlackSignature` (`@krusch/toolkit/webhooks` + standalone fallback), preserving `computeSlackSignature` (`TypeError` on missing secret) and exact `{ valid, reason }` return codes (`missing_signing_secret`, `invalid_timestamp`, `stale_timestamp_skew_*`, `invalid_signature_format`, `signature_mismatch`, `ok`) in `verifySlackWebhookSignature`.
    - `src/server/mcp-server.js`: Keeps `export function createMcpServer(options = {})` synchronous via `defineMcpTool` + `registerMcpHandlers` (`validateArgs: false, rethrowMcpError: true`), and connects stdio in `startMcpServer()` via `@krusch/toolkit/mcp`, preserving `server.registerTask`, `server.listTasks`, `server.close` drain hooks, and `McpError` rejections.

  - **Disjoint Subagent 5 Files (`krusch-companion` DB & React Views)**: `projects/krusch-companion/src/db/index.js`, `projects/krusch-companion/client/src/views/CompanionView.jsx`, `projects/krusch-companion/client/src/views/FocusView.jsx`, `projects/krusch-companion/client/src/views/SetupView.jsx`, `projects/krusch-companion/client/src/views/SystemMemoryView.jsx`, `projects/krusch-companion/client/src/views/TodayView.jsx`
    - `src/db/index.js`: Delegates SQLite WAL initialization to `initDb` / `closeDb` (`@krusch/toolkit/db` + standalone fallback with `_DatabaseClass: Database`), preserving `initCompanionDb(customPath)` singleton/custom-path semantics and all exported helpers.
    - React Views (`5` files): Wires `AbortController` `{ signal: controller.signal }` + `controller.abort()` cleanup across every `useEffect` `fetch(...)` call, ignoring `AbortError` on unmount.

  - **Disjoint Subagent 6 Files (`home-ai` & `first-things-first` Services/Routes)**: `projects/home-ai/scripts/seed-home-tasks.js`, `projects/home-ai/server/services/ollama.js`, `projects/home-ai/server/routes/api.js`, `projects/home-ai/server/routes/wall.js`, `projects/first-things-first/seed-home-tasks.js`
    - `seed-home-tasks.js` (`home-ai` & `first-things-first`): Uses `initDb` from `@krusch/toolkit/db` (converting `first-things-first/seed-home-tasks.js` from broken CommonJS to valid ESM).
    - `home-ai/server/services/ollama.js` & `home-ai/server/routes/api.js` (`/notifications/stream`): Replaces manual `text/event-stream` `writeHead` calls with `sseResponse` from `@krusch/toolkit/streaming`, preserving exact `data: ...\n\n` event payloads and `heartbeat.js` `addSSEClient(res)` compatibility.
    - `home-ai/server/routes/api.js` (`/transcribe`) & `home-ai/server/routes/wall.js` (`/photos/upload`, `/voice/transcribe`): Replaces `multer` with `parseBoundedMultipart`, `verifyUploadMime`, and `sanitizeUploadFilename` from `@krusch/toolkit/upload`, preserving byte limits (`10 MB` photos, `25 MB` audio), magic-byte image verification, disk write to `WALL_PHOTOS_DIR`, and exact HTTP `400`/`413`/`422`/`200` JSON responses.

  - **Parent Orchestrator Choke Points (Wired After Subagent Completion)**:
    - `projects/krusch-companion/src/server.js` & `projects/krusch-companion/src/agent/tools.js`: Replaces `multer` across `/api/companion/voice`, `/api/companion/transcribe`, and `/api/companion/vision` with `parseBoundedMultipart` (`@krusch/toolkit/upload` + standalone CI fallback), passing non-`multipart/form-data` requests (e.g., `application/json` `{ prompt, base64Image }` on `/api/companion/vision`) straight through to `next()` untouched, and guards `SKYLIGHT_CALENDAR_TOOL.execute` in `src/agent/tools.js` with an `existsSync` local-twin fallback when sibling `krusch-companion-skylight-connector` is absent in standalone GitHub Actions CI.
    - `projects/first-things-first/server.js`: Replaces `multer` on `/api/voice/transcribe` with `parseBoundedMultipart` + `sanitizeUploadFilename` from `@krusch/toolkit/upload`, ensuring `data/voice` directory creation and preserving exact response fields.

## 12. Step 8E — Scanner Hygiene, Standalone Connectors, Secondary MCPs, Orchestrator Scripts & Trade Suite LEGO-ADOPT Migration (INV-LEGO-29)

> **STATUS: FROZEN** — Pre-execution contract governing toolkit audit/scout scanner parity and the 6-subagent parallel `LEGO-ADOPT` migration across standalone connectors, secondary MCP servers, root `scripts/`, `roughin-suite`, `lightmind`, and clean 1–2 file monorepo apps (`44` target files + `3` toolkit scanner modules).

- **INV-LEGO-29 (Scanner Hygiene & Secondary Fleet Zero-Boilerplate Migration)**:
  - **Toolkit Scanner Alignment (`lib/catalog.js`, `lib/bin/krusch-lego.js`, `lib/lego-scout.js`)**:
    - `lib/catalog.js` (`CATALOG_AUDIT_EXEMPT_PATH_RE`): Exempts vendored/cache/scratch directory segments (`site-packages`, `__pycache__`, `vendor`, `third_party`, `archive`, `_archive`, `archive_scratch`, `scratch`) in addition to `lib`, `lib-py`, `krusch_toolkit`, `krusch-stack`, `test`/`tests`/`__tests__`, `benchmark`/`benchmarks`, and `node_modules`.
    - `lib/bin/krusch-lego.js` (`SKIP_DIRECTORIES`, `isExemptAuditPath`, `collectAuditFiles`): Adds `venv`, `env`, `site-packages`, `__pycache__`, `benchmark`, `vendor`, `third_party`, `archive`, `_archive`, `archive_scratch`, and `scratch` to `SKIP_DIRECTORIES`, and skips any directory (or ancestor directory up to 8 levels) containing `pyvenv.cfg` (matching `lib/lego-scout.js` virtualenv detection so custom-named virtualenvs such as `bench_venv` or `mcp_env` are never crawled).
    - `lib/lego-scout.js` (`SKIP_TOP_PROJECTS`, `SKIP_SUBDIRECTORIES`): Adds `vllm`, `lib`, `lib-py`, and `scratch` to `SKIP_TOP_PROJECTS` and `scratch` + `archive_scratch` to `SKIP_SUBDIRECTORIES`.
  - **Standalone Sibling-Optional Resolution (`INV-LEGO-28A` Continuation)** & **Legal Corpus Isolation (`INV-05`)**:
    - Standalone GitHub repositories (`kruschdev/krusch-polygres-connector`, `kruschdev/krusch-companion-skylight-connector`) and standalone-manifest projects without `@krusch/toolkit` in `package.json` resolve toolkit bricks via `fs.existsSync` sibling check (`../../../lib/<brick>.js` or `../../../../lib/<brick>.js`), then dynamic `import('@krusch/toolkit/<subpath>')`, then a deterministic local fallback using already-installed dependencies (`pg`, `node:sqlite`, `@modelcontextprotocol/sdk`, `node:buffer`) so fresh standalone `git clone && npm ci && npm test` runs pass without sibling `lib/` or `package.json` `file:..` mutations.
    - `projects/krusch-pocketlawyer-mcp/src/shared.js` strictly preserves `DB_PORT` default `5433` and `bge-large:latest` (`keep_alive: '5m'`) per `INV-05`.
  - **Explicitly Deferred Non-Target Directories (`8` Projects Untouched)**:
    - `dbos-worker` (`package.json` + `src/` legacy worker pending archive), `krusch-research-mcp` (unrelated uncommitted worktree edits), `card-game-context` (external upstream git remote), and 5 legacy untracked/archive prototypes (`annotated`, `heyjb`, `hivemind-companion-ext`, `krusch-life`, `krusch-worker`), plus `scripts/self_heal_infra.js` (`INV-12` span-anchored, `0` audit hits) and all `68/68` SHA-256-pinned benchmark files.

  - **Disjoint Subagent 1 Files (`Standalone Connectors — 4 files`)**: `projects/krusch-polygres-connector/src/index.js`, `projects/krusch-polygres-connector/src/context-bridge.js`, `projects/krusch-polygres-connector/src/git-bridge.js`, `projects/krusch-companion-skylight-connector/src/companion-bridge.js`
    - `krusch-polygres-connector`: Delegates PostgreSQL pool initialization to `createPgPool` (`../../../lib/pg.js` / `@krusch/toolkit/pg` + fallback) and SQLite opening in `context-bridge.js` to `openSqliteDb` (`../../../lib/sqlite.js` / `@krusch/toolkit/sqlite` + fallback), preserving `isEphemeralMode()`, `polygresPoolError` caching, and `[ContextBridge] Local SQLite database at '...' corrupt or unreadable` diagnostics.
    - `krusch-companion-skylight-connector`: Delegates SQLite WAL opening in `companion-bridge.js` to `openSqliteDb` (`../../../lib/sqlite.js` / `@krusch/toolkit/sqlite` + fallback), preserving `0o750`/`0o640` permissions, schema bootstrap, prepared statements, and `close()`.

  - **Disjoint Subagent 2 Files (`Secondary MCP Servers — 6 files`)**: `projects/krusch-pocketlawyer-mcp/src/shared.js`, `projects/krusch-pocketlawyer-mcp/src/index.js`, `projects/krusch-sequential-mcp/src/config.ts`, `projects/krusch-sequential-mcp/src/index.ts`, `projects/hivemind-mcp/src/index.js`, `projects/krusch-agentic-mcp/src/router.py`
    - `krusch-pocketlawyer-mcp`: Delegates PG pool creation in `src/shared.js` to `createPgPool` (`INV-05` `5433` + `bge-large:latest` preserved) and MCP stdio wiring in `src/index.js` to `defineMcpTool` / `registerMcpHandlers` / `createMcpServer`, preserving `handleListTools` and `handleCallTool(request, deps)`.
    - `krusch-sequential-mcp` & `hivemind-mcp`: Delegates PG pool creation (`config.ts`) to `createPgPool` and MCP tool normalization / stdio transport (`index.ts`, `hivemind-mcp/src/index.js`) to `defineMcpTool`, `registerMcpHandlers` (`validateArgs: false, rethrowMcpError: true`), and `createMcpServer`, preserving exported `server`, validation helpers, and `npm run build` TypeScript compilation.
    - `krusch-agentic-mcp/src/router.py`: Wraps `stream_generator()` with `sse_event_response(..., heartbeat_comment=None, passthrough=True)` from `krusch_toolkit.fastapi_app` (with `lib-py` `sys.path` + standalone fallback).

  - **Disjoint Subagent 3 Files (`Orchestrator scripts/ — 12 files`)**: `scripts/brain-wakeup.js`, `scripts/check_audits.js`, `scripts/check_db.js`, `scripts/check_queue.js`, `scripts/dispatch_mcp_jobs.js`, `scripts/dispatch_sandbox_audits.js`, `scripts/homelab_memory_mcp.js`, `scripts/query_episodes.js`, `scripts/query_local_jobs.js`, `scripts/query_orbit_jobs.js`, `scripts/search_all_tables.js`, `scripts/swarm_cli.js`
    - Delegates PostgreSQL pool creation across all 12 scripts to `createPgPool` via `'../lib/pg.js'` (with `import('@krusch/toolkit/pg')` fallback), and delegates MCP tool/stdio wiring in `scripts/homelab_memory_mcp.js` to `defineMcpTool`, `registerMcpHandlers`, and `createMcpServer` via `'../lib/mcp-server.js'`, preserving `validateQueueEnv` and `createQueuePool` exports in `scripts/check_queue.js`.

  - **Disjoint Subagent 4 Files (`roughin-suite Pool, React & Upload Middlewares — 6 files`)**: `projects/roughin-suite/db/pool.js`, `projects/roughin-suite/packages/climacore/public/src/pages/CodeRef.jsx`, `projects/roughin-suite/packages/drainflux/public/src/pages/CodeRef.jsx`, `projects/roughin-suite/packages/climacore/routes/middleware.js`, `projects/roughin-suite/packages/drainflux/routes/middleware.js`, `projects/roughin-suite/packages/spark/routes/middleware.js`
    - `db/pool.js`: Delegates pool creation to `createPgPool` from `@krusch/toolkit/pg`, preserving `query`, `queryOne`, `run`, `getPool`, `closePool`, and `export default pool`.
    - `CodeRef.jsx` (`climacore` & `drainflux`): Wires `AbortController` `{ signal: controller.signal }` + `controller.abort()` cleanup in `useEffect`.
    - `routes/middleware.js` (`climacore`, `drainflux`, `spark`): Replaces `multer` with `parseBoundedMultipart` + `sanitizeUploadFilename` from `@krusch/toolkit/upload` (`requireMagicMatch: false` for ISO-BMFF `mp4`/`mov`/`heic` compatibility, plus `<svg`/`<script` payload rejection on image uploads), preserving `asyncHandler`, `createUpload` (`spark`), `upload`, and `videoUpload` (`.single()` / `.fields()`), writing accepted files to `config.uploads.dir`, returning `413` on byte-cap overflow, and leaving `req.file = undefined` + `next()` on unsupported MIME so downstream route handlers emit their exact `400` messages.

  - **Disjoint Subagent 5 Files (`roughin-suite & lightmind Upload Routes — 6 files`)**: `projects/roughin-suite/packages/drainflux/routes/survey.js`, `projects/roughin-suite/packages/roughin/routes/auth.js`, `projects/roughin-suite/packages/roughin/routes/blueprints.js`, `projects/roughin-suite/packages/roughin/routes/photos.js`, `projects/roughin-suite/packages/roughin/routes/video-scan.js`, `projects/lightmind/server/routes/tracks.js`
    - Replaces `multer` across all 6 route modules with `parseBoundedMultipart` + `sanitizeUploadFilename` (`@krusch/toolkit/upload` in `roughin-suite`; sibling `../../../../lib/upload.js` + `@krusch/toolkit/upload` + fallback in `lightmind/server/routes/tracks.js`), using `requireMagicMatch: false` where `mp4`/`mov`/`heic`/`flac` are accepted, rejecting `<svg`/`<script` markup on image uploads, writing files to the exact per-route upload directories, and preserving `req.file` / `req.files` / `req.body` shapes and HTTP status codes (`400`/`404`/`413`/`200`/`201`).

  - **Disjoint Subagent 6 Files (`Clean Monorepo 1–2 File Apps — 10 files`)**: `projects/ai-watch/index.js`, `projects/Brain3/lib/db.js`, `projects/signet/lib/dbService.js`, `projects/caren/db/database.js`, `projects/caren/db/seed.js`, `projects/conversational-rag/lib/proxy.js`, `projects/parasite-proxy/server.js`, `projects/kruschstack/mcp-server.js`, `projects/kruschstack/server.js`, `projects/spectralquant-ollama-bridge/backend/server.py`
    - Delegates `ai-watch/index.js` to `createPgPool` (`@krusch/toolkit/pg`), `Brain3/lib/db.js` to `openSqliteDb` (`@krusch/toolkit/sqlite` + sibling fallback), `signet/lib/dbService.js` to read-only `openSqliteDb(filepath, { readOnly: true })` (`@krusch/toolkit/sqlite`, replacing raw `better-sqlite3` `new Database`), `caren/db/{database,seed}.js` to `initDb` / `SQLiteDatabase` (`@krusch/toolkit/db` + sibling fallback), `conversational-rag/lib/proxy.js` (`heartbeatMs: 0, retryMs: 0`) & `parasite-proxy/server.js` (`heartbeatMs: 15000, retryMs: 0`) to `sseResponse` (`@krusch/toolkit/streaming`), `kruschstack/{mcp-server,server}.js` to `@krusch/toolkit/mcp` & `@krusch/toolkit/streaming`, and `spectralquant-ollama-bridge/backend/server.py` to `sse_event_response(..., request=request, heartbeat_comment=None, passthrough=True)` from `krusch_toolkit.fastapi_app`.

---

## 13. Step 8F — Final 8 Brownfield Directories & 100% Zero-Boilerplate Workspace Completion (`INV-LEGO-30`)

- **STATUS: FROZEN** (`2026-11-01`)
- **Governance Tier**: `L0` (`77` source files across `8` brownfield project directories; `/spec-first-refactor` + `/parallel-build`)
- **Objective**: Migrate the final `8` `[LEGO-ADOPT]` brownfield directories (`79` boilerplate findings across `77` files) identified by `krusch-lego scout projects/` onto certified `@krusch/toolkit` bricks so the entire `99`-project workspace achieves **`0` `[LEGO-ADOPT]` findings (`99/99` = `100.0%` Zero-Boilerplate Workspace)** and **`0` uncovered Rule-of-3 clusters**, with `100%` backward compatibility across every unit test suite and TypeScript build.

### `INV-LEGO-30` (Final 8-Directory Brownfield Migration Contract)
1. **Zero Boilerplate Hits & Zero Regressions**:
   - `node bin/krusch-lego.js scout <projects-dir>` MUST report **`0` projects with adoption opportunities** and **`0` Rule-of-3 extraction candidates**.
   - Every migrated project's existing test suite and TypeScript compiler (`tsc`) MUST pass with `0` regressions, and no external upstream Git remote (`card-game-context`) may be pushed.
   - Pre-existing hardcoded fallback password literals in legacy debug/worker pool scripts MUST be replaced with environment-resolved configuration (`process.env.DATABASE_URL` / `@krusch/toolkit/pg` defaults).

2. **Disjoint Parallel Subagent Boundaries (`5` Code Migration Subagents, `77` Files)**:
   - **Disjoint Subagent 2 (`dbos-worker` Batch A — `28` files)**:
     `check_all_jobs.js`, `check_all_pending.js`, `check_connections.js`, `check_dbos_status.js`, `check_failed_jobs.js`, `check_job_payloads.js`, `check_locks.js`, `check_operation_outputs.js`, `check_schema.js`, `check_specific_intents.js`, `check_sre_jobs.js`, `check_summary.js`, `check_target_jobs.js`, `check_workflow_id.js`, `check_workflow_inputs.js`, `check_workflow_queue.js`, `find_job.js`, `heal_queue.js`, `list_dbos_tables.js`, `mass_deny.js`, `mcp_server.js`, `reset_all_ghosts.js`, `scratch_check.js`, `scratch_check_db.js`, `scratch_check_job_status.js`, `scratch_check_neurogolf_intents.js`, `scratch_check_outputs.js`, `scratch_check_parent.js`.
     - Delegates PostgreSQL pool creation across all `28` files (converting broken CJS `require('pg')` scripts inside ESM `"type": "module"` `dbos-worker` to valid ESM) to `createPgPool` from `'@krusch/toolkit/pg'`.
   - **Disjoint Subagent 3 (`dbos-worker` Batch B — `28` files)**:
     `scratch_check_recent_jobs.js`, `scratch_check_running_jobs.js`, `scratch_check_specifics.js`, `scratch_check_sre_jobs.js`, `scratch_clean_and_reset.js`, `scratch_clear.js`, `scratch_count.js`, `scratch_dates.js`, `scratch_force_fail.js`, `scratch_human_review.js`, `scratch_inspect_details.js`, `scratch_inspect_payload.js`, `scratch_inspect_whole_row.js`, `scratch_intent_results.js`, `scratch_jobs.js`, `scratch_list_queue.js`, `scratch_list_tables.js`, `scratch_query_intents.js`, `scratch_query_memory.js`, `scratch_query_queue.js`, `scratch_reject_human.js`, `scratch_requeue_sre_jobs.js`, `scratch_reset_job.js`, `scratch_reset_queue.js`, `scratch_test_new_tools.js`, `scratch_test_select.js`, `scratch_test_select_parts.js`, `scripts/unleash_swarm.js`.
     - Delegates PostgreSQL pool creation across all `28` files (including the remaining CJS `require('pg')` scripts) to ESM `createPgPool` from `'@krusch/toolkit/pg'`, preserving `dbos-worker` `6/6` tests.
   - **Disjoint Subagent 4 (`krusch-life` & `krusch-research-mcp` — `7` files)**:
     `projects/krusch-life/db/run.js`, `projects/krusch-life/src/db/adapter.js`, `projects/krusch-life/src/ingestion/gmail.js`, `projects/krusch-life/src/ingestion/imessage.js`, `projects/krusch-research-mcp/db/pool.js`, `projects/krusch-research-mcp/src/server.js`, `projects/krusch-research-mcp/src/sqlite-engine.js`.
     - `krusch-life`: Delegates PG pool creation (`db/run.js`, `adapter.js`, `gmail.js`, `imessage.js`) to `createPgPool` (`@krusch/toolkit/pg`) and SQLite opening (`adapter.js`, `imessage.js`) to `SQLiteDatabase` (`@krusch/toolkit/db`), preserving all exported functions (`initDb`, `createConnectionBundle`, etc.) across all 8 inbound callers (`10/10` tests).
     - `krusch-research-mcp`: Resolves sibling `../../lib/{pg,mcp-server,db}.js` (with `@krusch/toolkit/*` fallback) to delegate `db/pool.js` (`createPgPool`), `src/server.js` (`registerMcpHandlers` & `createMcpServer` with `{ validateArgs: false, rethrowMcpError: true }`), and `src/sqlite-engine.js` (`SQLiteDatabase`), preserving `3/3` tests and leaving pre-existing worktree state (`D .env`, `?? .gitignore`) untouched.
   - **Disjoint Subagent 5 (`krusch-worker`, `card-game-context`, `hivemind-companion-ext` — `7` files)**:
     `projects/krusch-worker/mcp_server.js`, `projects/krusch-worker/src/worker.ts`, `projects/krusch-worker/worker.js`, `projects/krusch-worker/scripts/local_audit_runner.js`, `projects/krusch-worker/scripts/swarm_researcher.js`, `projects/card-game-context/production/scripts/build-html.js`, `projects/hivemind-companion-ext/src/database/pgAdapter.ts`.
     - `krusch-worker`: Delegates PG pool creation in all 5 files to `createPgPool` (`@krusch/toolkit/pg`), preserving `resolveDatabaseUrl`, `resolveMcpDatabaseUrl`, `ALLOWED_MODELS`, `npm run build` (`tsc`), and `7/7` tests.
     - `card-game-context`: Uses Node 22 synchronous `require(esm)` on `../../../../lib/yaml.js` (`parseSafeYaml`, with `js-yaml` `CORE_SCHEMA` fallback) in `production/scripts/build-html.js`, preserving `37/37` YAML card validation tests (local-only, never pushed).
     - `hivemind-companion-ext`: Uses runtime `require` on `../../../../lib/pg.js` (`createPgPool`, respecting `tsconfig.json` `"rootDir": "src"`, with fallback if sibling absent) in `src/database/pgAdapter.ts`, preserving `npm run compile` (`tsc -p ./`) and `7/7` tests.
   - **Disjoint Subagent 6 (`annotated` & `heyjb` — `7` files)**:
     `projects/annotated/client/src/App.jsx`, `projects/annotated/client/src/SidePanelApp.jsx`, `projects/annotated/server/src/db.ts`, `projects/annotated/server/src/seed.ts`, `projects/heyjb/src/dashboard/routes/chat.js`, `projects/heyjb/src/dashboard/routes/mcp.js`, `projects/heyjb/src/dashboard/routes/media.js`.
     - `annotated`: Wires `AbortController` (`signal` + cleanup `controller.abort()`) into every `useEffect` calling `fetch(...)` in `App.jsx` and `SidePanelApp.jsx`, and delegates PG pool creation in `server/src/db.ts` (`10` inbound callers) and `server/src/seed.ts` via `createRequire(import.meta.url)('../../../../lib/pg.js').createPgPool` (`rootDir`-safe for `tsc`), preserving `npm --prefix server run build` and `3/3` tests.
     - `heyjb`: Delegates SSE headers/heartbeats in `chat.js` (checking `400` pre-conditions BEFORE `sseResponse`) and `mcp.js` (`heartbeatMs: 30000, retryMs: 0`) to `sseResponse` (`@krusch/toolkit/streaming`), and replaces `multer` in `media.js` with `parseBoundedMultipart` + `sanitizeUploadFilename` (`@krusch/toolkit/upload`, checking `getContentById` `404` BEFORE writing files, enforcing `/^\.[a-z0-9]{1,10}$/` extension hygiene, and blocking `<svg`/`<script` active markup under `image/*`), preserving `13/13` tests.
---

## 14. Wave 7 Enterprise Compliance, Access Control & Resilience Bricks (`INV-LEGO-31`..`INV-LEGO-34`)

> **STATUS: FROZEN (`2026-11-03`)** — Adds 4 zero-dependency enterprise application runtime bricks to `@krusch/toolkit` `v1.8.0` (`idempotency`, `audit-log`, `rbac`, `pagination`), advancing `RUNTIME_BRICKS` from `35` to `39` with 1:1 strict TypeScript `.d.ts` parity (`INV-LEGO-11`) and `INV-LEGO-26` Zero-Leak cleanliness.

- **`INV-LEGO-31` (Atomic Request Idempotency Lock, Payload Fingerprinting & Replay Cache — `@krusch/toolkit/idempotency`)**:
  - **Disjoint Subagent 1 Files**: `lib/idempotency.js`, `lib/types/idempotency.d.ts`
  - **Dependencies**: Built-in `node:crypto` + `{ okEnvelope, errorEnvelope } from './http.js'` (zero external npm packages).
  - **Exact Exports & Return Contracts**:
    - `DEFAULT_IDEMPOTENCY_OPTIONS`: `Object.freeze({ ttlMs: 86_400_000, maxEntries: 10_000, inFlightTimeoutMs: 60_000, maxKeyLength: 255, headerName: 'idempotency-key' })`.
    - `normalizeIdempotencyKey(rawKey, { maxKeyLength = 255, tool = 'idempotency.key' } = {})`:
      - Non-throwing validator rejecting invalid `maxKeyLength` (`!Number.isInteger(maxKeyLength) || maxKeyLength < 1 || maxKeyLength > 1024` -> `IDEMPOTENCY_INVALID_OPTIONS`), missing/non-string/whitespace-only keys (`IDEMPOTENCY_KEY_MISSING`), keys exceeding `maxKeyLength` after trim (`IDEMPOTENCY_KEY_TOO_LONG`), and ASCII control characters `[\x00-\x1f\x7f]` (`IDEMPOTENCY_KEY_INVALID`).
      - Returns `okEnvelope(tool, 'Idempotency key valid', { key })` or `errorEnvelope(code, message, details, tool)`.
    - `computePayloadFingerprint(payload, { method = '', path = '', maxDepth = 32, tool = 'idempotency.fingerprint' } = {})`:
      - Non-throwing canonical SHA-256 hex digest over `{ method: String(method).trim().toUpperCase(), path: String(path).trim(), body }`.
      - Sorts plain-object own keys deterministically (`Object.keys`), omits `undefined` object property values (mapping `undefined` array elements or root `undefined` to `null` and `-0` to `0`), encodes `Uint8Array`/`Buffer` cleanly as `{ $bytesBase64 }`, and rejects circular references (`IDEMPOTENCY_CIRCULAR_PAYLOAD`), `maxDepth` overflow (`IDEMPOTENCY_MAX_DEPTH`), lone UTF-16 surrogates, `BigInt`, `Symbol`, `Function`, and `NaN`/`Infinity` (`IDEMPOTENCY_INVALID_PAYLOAD`).
      - Returns `okEnvelope(tool, 'Payload fingerprint computed', { fingerprint })` or `errorEnvelope(code, message, details, tool)`.
    - `createIdempotencyStore({ ttlMs = 86_400_000, maxEntries = 10_000, inFlightTimeoutMs = 60_000, maxKeyLength = 255, nowFn = Date.now } = {})`:
      - Validates integer `maxEntries >= 1`, finite positive `ttlMs >= 1`, `inFlightTimeoutMs >= 1`, and `1 <= maxKeyLength <= 1024` (throwing `RangeError` on invalid developer config).
      - Uses a prototype-safe `Map` with LRU refresh on replay, automatic expiration of `COMPLETED` entries (`now >= expiresAt`) and stale `IN_FLIGHT` entries (`now - startedAt >= inFlightTimeoutMs`), and eviction of expired/oldest-`COMPLETED` entries at `maxEntries` (never evicting active `IN_FLIGHT` locks; returns `errorEnvelope('IDEMPOTENCY_STORE_FULL', ..., { statusCode: 503 }, tool)` fail-closed if all `maxEntries` are actively in flight).
      - Exposes frozen store API:
        - `begin(key, fingerprint, { tool = 'idempotency.store' } = {})`: Validates `key` and non-empty string `fingerprint` (`IDEMPOTENCY_INVALID_FINGERPRINT`). On fingerprint mismatch against an active `IN_FLIGHT` or `COMPLETED` entry, returns `errorEnvelope('IDEMPOTENCY_PAYLOAD_MISMATCH', ..., { key, statusCode: 422 }, tool)` using constant-time byte comparison (`crypto.timingSafeEqual`). On matching `IN_FLIGHT` entry, returns `errorEnvelope('IDEMPOTENCY_IN_FLIGHT', ..., { key, statusCode: 409 }, tool)`. On matching `COMPLETED` entry, returns `okEnvelope(tool, 'Idempotency replay hit', { outcome: 'REPLAY', key, fingerprint, statusCode, body: deepClone(body), headers: { ...headers }, storedAt })`. Otherwise acquires lock with `lockToken = crypto.randomUUID()` and returns `okEnvelope(tool, 'Idempotency lock acquired', { outcome: 'ACQUIRED', key, fingerprint, lockToken })`.
        - `commit(key, lockToken, { statusCode = 200, body = null, headers = {}, tool = 'idempotency.store' } = {})`: Verifies active `IN_FLIGHT` ownership of `lockToken` (`IDEMPOTENCY_LOCK_LOST`), deep-clones `body` (rejecting non-cloneable/circular bodies cleanly via `IDEMPOTENCY_INVALID_PAYLOAD`), strips CR/LF from `headers`, and marks `COMPLETED` until `now + ttlMs`.
        - `release(key, lockToken, { tool = 'idempotency.store' } = {})`: Deletes `IN_FLIGHT` entry only if `lockToken` matches, returning `okEnvelope(tool, ..., { released: boolean })`.
        - `get(key)`, `delete(key)`, `clear()`, `size()`.
    - `withIdempotency(store, { key, payload = null, method = 'POST', path = '', cacheErrors = false, tool = 'idempotency.exec' } = {}, handlerFn)`:
      - Async execution helper normalizing `key`, computing `fingerprint`, acquiring/replaying via `store.begin`, executing `handlerFn({ key, fingerprint })`, releasing lock without caching on thrown exceptions (`IDEMPOTENCY_HANDLER_ERROR`) or `{ ok: false }` results when `cacheErrors === false`, and committing + returning `okEnvelope(tool, ..., { replayed: boolean, key, statusCode, result })`.
    - `createIdempotencyMiddleware(store = createIdempotencyStore(), { headerName = 'idempotency-key', methods = ['POST', 'PUT', 'PATCH', 'DELETE'], requireHeader = false, scopeKeyFn = null, tool = 'idempotency.middleware' } = {})`:
      - Express / Node HTTP middleware `(req, res, next)` scoping keys by `${scope}:${method}:${pathname}:${key}` (default `scope` from `scopeKeyFn(req)` or `req.auth?.tenantId || req.user?.tenantId || req.user?.id || 'global'`), rejecting duplicate header arrays (`400`), missing required header (`400`), payload mismatch (`422`), concurrent in-flight (`409` + `Retry-After: 1`), setting `Idempotency-Replayed: false` on fresh executions and replaying cached responses with `Idempotency-Replayed: true`, and releasing locks without caching on `statusCode >= 500` or premature socket close before `res.writableEnded`.

- **`INV-LEGO-32` (Tamper-Evident SHA-256 Hash-Chained Compliance Ledger — `@krusch/toolkit/audit-log`)**:
  - **Disjoint Subagent 2 Files**: `lib/audit-log.js`, `lib/types/audit-log.d.ts`
  - **Dependencies**: Built-in `node:crypto`, `node:sqlite` (`DatabaseSync`), `node:fs`, `node:path` + `{ okEnvelope, errorEnvelope } from './http.js'` (zero external npm packages).
  - **Exact Exports & Return Contracts**:
    - `GENESIS_AUDIT_HASH`: `'0'.repeat(64)`.
    - `canonicalizeAuditPayload(value, { maxDepth = 32, tool = 'audit.canonicalize' } = {})`:
      - Non-throwing deterministic canonical JSON serializer sorting own keys lexicographically, normalizing `-0` to `0`, omitting `undefined` object keys (`undefined` array elements -> `null`), and rejecting circular references (`AUDIT_CIRCULAR_PAYLOAD`), `maxDepth` overflow (`AUDIT_MAX_DEPTH`), lone UTF-16 surrogates (`AUDIT_INVALID_UNICODE`), and `BigInt`/`Symbol`/`Function`/`NaN`/`Infinity` (`AUDIT_NONFINITE_VALUE`). Returns `okEnvelope(tool, ..., { canonicalJson })` or `errorEnvelope`.
    - `computeAuditEntryHash(entryInput, { hmacSecret = '', tool = 'audit.hash' } = {})`:
      - Validates `seq` (`>= 1` safe integer), non-empty `timestamp`, `actor`, `action` (all free of ASCII control chars `[\x00-\x1f\x7f]`), string `resource` / `tenantId` / `outcome`, 64-char lowercase hex `prevHash`, and plain-object `metadata` (`AUDIT_INVALID_ENTRY`).
      - Serializes `{ seq, timestamp, tenantId, actor, action, resource, outcome, metadata, prevHash }` via `canonicalizeAuditPayload` and computes SHA-256 hex digest (or HMAC-SHA256 hex digest over `'krusch-audit-v1:' + canonicalJson` when non-empty `hmacSecret` is provided). Returns `okEnvelope(tool, ..., { entryHash, canonicalJson })` or `errorEnvelope`.
    - `verifyAuditChain(entries, { expectedGenesisHash = GENESIS_AUDIT_HASH, expectedTailHash = '', hmacSecret = '', startSeq = 1, tool = 'audit.verify' } = {})`:
      - Non-throwing $O(N)$ chain verifier checking array input (`AUDIT_INVALID_CHAIN_INPUT`), contiguous monotonic `seq === startSeq + index` (`AUDIT_SEQUENCE_GAP`), constant-time `entry.prevHash === expectedPrevHash` (`AUDIT_CHAIN_BROKEN`), constant-time recomputed `entryHash === entry.entryHash` (`AUDIT_ENTRY_TAMPERED`), and optional `expectedTailHash` truncation check (`AUDIT_TAIL_MISMATCH`). Returns `okEnvelope(tool, ..., { valid: true, verifiedCount, headHash, tailHash })` or `errorEnvelope`.
    - `createAuditLog({ sqlitePath = '', db = null, tableName = 'audit_ledger', hmacSecret = '', maxEntries = 50_000, nowFn = () => new Date().toISOString(), tool = 'audit.log' } = {})`:
      - Supports in-memory append-only ledger (failing closed with `AUDIT_LOG_CAPACITY_EXCEEDED` at `maxEntries` rather than silently dropping compliance records) and durable `node:sqlite` `DatabaseSync` WAL mode (`synchronous = FULL`, `busy_timeout = 5000`, SQL-injection-guarded `tableName`, plus SQLite `BEFORE UPDATE` and `BEFORE DELETE` `RAISE(ABORT, 'AUDIT_LEDGER_IMMUTABLE')` immutability triggers).
      - Exposes frozen handle `{ append(record), verify(opts), query(filters), tail(), close() }` returning `INV-LEGO-01` envelopes on `append`, `verify`, and `query`.

- **`INV-LEGO-33` (Deny-by-Default RBAC Policy Evaluator & Multi-Tenant IDOR Guard — `@krusch/toolkit/rbac`)**:
  - **Disjoint Subagent 3 Files**: `lib/rbac.js`, `lib/types/rbac.d.ts`
  - **Runtime Purity**: Zero `node:*` imports (pure Web-standards ECMAScript with inline `INV-LEGO-01` `okEnvelope`/`errorEnvelope` helpers and zero host-specific transitive imports; runs unmodified in Node 22, Cloudflare Workers, and browsers).
  - **Exact Exports & Return Contracts**:
    - `matchPermissionPattern(grantedPattern, requiredPermission)`:
      - Deterministic ReDoS-free permission matcher supporting exact match, global `'*'`, multi-segment prefix `'domain:**'` (matching `'domain:read'` and `'domain:sub:write'`), and equal-length `':'` segment wildcards (`'billing:*'`, `'*:read'`). Rejects empty strings, whitespace, and control chars (`false`).
    - `createRbacPolicy(policyDefinition = {}, { maxInheritanceDepth = 16 } = {})`:
      - Prototype-safe (`Object.create(null)` / `Map`) static policy compiler validating `policyDefinition.roles` (`{ allow?: string[], deny?: string[], inherits?: string[], allowCrossTenant?: boolean, description?: string }`), throwing `RangeError` on `__proto__`/`constructor`/`prototype` keys, unknown `inherits` targets, inheritance cycles, or depth overflow.
      - Returns frozen `RbacPolicy` handle `{ listRoles(), getRolePermissions(roleName), evaluate(subject, permission, options) }`.
    - `assertTenantOwnership(subject, resource, { allowCrossTenant = false, checkOwner = false, ownerField = 'ownerId', tenantField = 'tenantId', tool = 'rbac.tenant' } = {})`:
      - Non-throwing OWASP A01 / IDOR guard using `Object.hasOwn` (blocking prototype-polluted `tenantId`/`ownerId` bypasses). Requires authenticated `subject` (`RBAC_UNAUTHENTICATED`, `statusCode: 401`), non-empty `subject.tenantId` (`RBAC_MISSING_SUBJECT_TENANT`, `403`), non-empty `resource[tenantField]` (`RBAC_MISSING_RESOURCE_TENANT`, `403`), and exact `subject.tenantId === resource[tenantField]` (`RBAC_CROSS_TENANT_DENIED`, `403`) unless BOTH `allowCrossTenant === true` AND `subject.allowCrossTenant === true`. When `checkOwner === true`, enforces non-empty `subject.id` matching `resource[ownerField]` (`RBAC_NOT_RESOURCE_OWNER`, `403`). Returns `okEnvelope` or `errorEnvelope`.
    - `evaluateAccess(policy, subject, permission, { resource = null, requireTenantMatch = true, checkOwner = false, ownerField = 'ownerId', tenantField = 'tenantId', tool = 'rbac.evaluate' } = {})`:
      - Deny-by-default evaluator: validates `policy`, `subject` (`401`), and `permission` (`400`); evaluates explicit `deny` rules BEFORE `allow` rules (`RBAC_EXPLICIT_DENY`, `403`); requires at least one matching `allow` grant across inherited roles or `subject.permissions` (`RBAC_FORBIDDEN`, `403`); enforces `assertTenantOwnership` whenever `resource` is provided and `requireTenantMatch !== false`; returns `okEnvelope(tool, 'Access granted', { allowed: true, subjectId, tenantId, permission, matchedGrant })` or `errorEnvelope`.
    - `createRbacGuard(policy, permission, { resolveSubject, resolveResource, requireTenantMatch = true, checkOwner = false, ownerField = 'ownerId', tenantField = 'tenantId', onAudit = null, tool = 'rbac.guard' } = {})`:
      - Async-safe HTTP/Express middleware `(req, res, next)` catching resolver/audit errors cleanly (`500` `RBAC_RESOLVER_ERROR`), invoking optional `onAudit` hook, responding `401`/`403` JSON `errorEnvelope` on denial, or attaching `req.authz` and calling `next()`.

- **`INV-LEGO-34` (HMAC-Signed Keyset Cursor & Bounded Limit Pagination — `@krusch/toolkit/pagination`)**:
  - **Disjoint Subagent 4 Files**: `lib/pagination.js`, `lib/types/pagination.d.ts`
  - **Dependencies**: Built-in `node:crypto` + `{ okEnvelope, errorEnvelope } from './http.js'` (zero external npm packages).
  - **Exact Exports & Return Contracts**:
    - `DEFAULT_PAGINATION_LIMITS`: `Object.freeze({ defaultLimit: 25, minLimit: 1, maxLimit: 100, maxCursorLength: 2048 })`.
    - `clampPageLimit(rawLimit, { defaultLimit = 25, minLimit = 1, maxLimit = 100 } = {})`:
      - Validates `1 <= minLimit <= defaultLimit <= maxLimit <= 10_000` (`RangeError` on invalid bounds); safely coerces `undefined`/`null`/`''`/`boolean`/`Symbol`/`NaN`/`Infinity`/non-integer strings to `defaultLimit` without throwing, and clamps integers into `[minLimit, maxLimit]`.
    - `encodeCursor(cursorPayload, { secret = '', scope = '', ttlMs = 0, maxCursorLength = 2048, nowFn = Date.now, tool = 'pagination.encode' } = {})`:
      - Non-throwing encoder validating plain-object `cursorPayload` (rejecting primitives, arrays, `__proto__`/`constructor`/`prototype` own keys, circular refs, `BigInt`, and `NaN`/`Infinity` with `CURSOR_INVALID_PAYLOAD`), wrapping `{ v: 1, d: cursorPayload, s?: scope, exp?: nowFn() + ttlMs }`, base64url-encoding, signing with domain-separated HMAC-SHA256 (`'krusch-cursor-v1.' + payloadB64`) when `secret` is provided, enforcing `<= maxCursorLength` (`CURSOR_TOO_LARGE`), and returning `okEnvelope(tool, ..., { cursor, signed, expiresAt })` or `errorEnvelope`.
    - `decodeCursor(rawCursor, { secret = '', requireSignature = Boolean(secret), expectedScope = '', maxCursorLength = 2048, nowFn = Date.now, tool = 'pagination.decode' } = {})`:
      - Non-throwing decoder enforcing length & charset bounds (`CURSOR_MISSING`, `CURSOR_TOO_LARGE`, `CURSOR_MALFORMED`), constant-time `crypto.timingSafeEqual` HMAC verification (`CURSOR_SECRET_REQUIRED`, `CURSOR_SIGNATURE_MISSING`, `CURSOR_INVALID_SIGNATURE`), prototype-safe JSON parsing, `exp` TTL expiration (`CURSOR_EXPIRED`), and `expectedScope` binding (`CURSOR_SCOPE_MISMATCH`). Returns `okEnvelope(tool, ..., { payload, scope, expiresAt, signed })` or `errorEnvelope`.
    - `buildKeysetPage(rows, { limit = 25, defaultLimit = 25, maxLimit = 100, sortField = 'createdAt', idField = 'id', secret = '', scope = '', ttlMs = 0, nowFn = Date.now, tool = 'pagination.page' } = {})`:
      - `limit + 1` lookahead keyset envelope builder slicing `rows` to `effectiveLimit`, computing `hasMore` and signed `nextCursor` over `{ sortValue, id, sortField, idField }`, and returning `okEnvelope(tool, ..., { items, pageInfo: { limit, count, hasMore, nextCursor } })` or `errorEnvelope`.
    - `paginateItems(allItems, { cursor = '', limit = 25, defaultLimit = 25, maxLimit = 100, sortField = 'id', idField = 'id', direction = 'asc', secret = '', scope = '', ttlMs = 0, nowFn = Date.now, tool = 'pagination.slice' } = {})`:
      - Deterministic in-memory keyset paginator sorting `(sortField, idField)` in `'asc' | 'desc'` (`PAGINATION_INVALID_DIRECTION`), verifying `cursor` signature/scope/expiry/sortField parity (`CURSOR_SORT_MISMATCH`), advancing strictly past `(sortValue, id)`, and returning `buildKeysetPage` `okEnvelope` or `errorEnvelope`.

- **Orchestrator Choke Points & `<1ms` Slop-Breaker Detectors (Phase 3B — Parent Orchestrator Only)**:
  - `lib/package.json` (`v1.8.0`, `./idempotency`, `./audit-log`, `./rbac`, `./pagination` subpaths), `lib/index.js`, `lib/types/index.d.ts`
  - `lib/catalog.js` (`RUNTIME_BRICKS` -> `39` bricks + deterministic $O(N)$ `auditBoilerplateText` Slop-Breaker rules `raw-idempotency-key`, `mutable-audit-ledger`, `raw-tenant-rbac`, and `unsafe-pagination-cursor` recommending `idempotency`, `audit-log`, `rbac`, and `pagination` in `scoreLegoBrickCoverage`), `lib/README.md`, `lib/test_lego_bricks.js`, `lib/test_wave5_bricks.js`, `lib/test_wave7_bricks.js`

