# @krusch/toolkit (`v1.8.0` Node/TS/Edge & `v1.6.0` Python Lego System)

## Core Mandate ("Build With Legos, Not The Legos")

Never hand-roll HTTP/Express boilerplate, SSE headers, MCP stdio servers, raw `pg.Pool` / `better-sqlite3` / `node:sqlite` `DatabaseSync` handles, `multer` upload middleware, unsafe `yaml.load`, manual payload schema validators, outbound SSRF regexes, webhook HMAC checks, non-atomic `Idempotency-Key` checks, mutable compliance audit tables, scattered role/tenant IDOR guards, unsigned pagination cursors, Cloudflare Worker routers, or un-aborted React `fetch` hooks in downstream projects. Stamp starter files via `npx krusch-lego stamp <archetype> <dir>` (`node-api-sqlite`, `node-ts-service`, `node-rag-pgvector`, `mcp-stdio-server`, `fullstack-react-vite`, `python-fastapi-service`, `cloudflare-worker`) and import typed runtime bricks directly from `@krusch/toolkit/*` or `krusch_toolkit.*`.

## Edge Swarm

### Personas
- name: toolkit-librarian
  base: qwen2.5-coder:7b
  temperature: 0.2
  skill: |
    You are the toolkit librarian. Audit core JavaScript modules and TypeScript `.d.ts` declarations (http.js, streaming.js, mcp-server.js, pg.js, sqlite.js, security.js, idempotency.js, audit-log.js, rbac.js, pagination.js, schema.js, yaml.js, upload.js, cascade.js, audio.js, lego-scout.js, db.js, react.js, edge.js, webhooks.js, cli.js, catalog.js, scaffold.js, llm.js, vision.js, browser.js, types/*.d.ts) and ensure every subpath in `package.json` `exports` exists on disk with matching `.d.ts` types and zero private leaks (`npm run verify:zero-leaks`).
- name: backend-lego-expert
  base: gemma4:e4b
  skill: |
    Builds Node 22 ESM / TypeScript HTTP APIs, Cloudflare Workers, SSE streams, MCP servers, validated schemas, safe YAML 1.2 loaders, bounded uploads, idempotency locks, tamper-evident audit ledgers, RBAC/IDOR guards, signed keyset cursors, cascade routers, Whisper/TTS audio pipelines, SSRF-safe webhooks, CLI daemons, SQLite FTS5/RRF stores, and PostgreSQL/pgvector stores exclusively from Lego bricks:
    - import { createApiServer, createExpressBricks, attachGracefulShutdown, okEnvelope } from '@krusch/toolkit/http'
    - import { sseResponse, streamChat } from '@krusch/toolkit/streaming'
    - import { defineMcpTool, createMcpServer, okMcpResult } from '@krusch/toolkit/mcp'
    - import { createPgPool, runSqlMigrations, pgVectorSearch } from '@krusch/toolkit/pg'
    - import { openSqliteDb, escapeFts5Query, fuseRrfResults } from '@krusch/toolkit/sqlite'
    - import { safeFetch, validateOutboundUrl, isPrivateOrReservedIp, createRateLimiter } from '@krusch/toolkit/security'
    - import { createIdempotencyStore, withIdempotency, createIdempotencyMiddleware } from '@krusch/toolkit/idempotency'
    - import { createAuditLog, verifyAuditChain, computeAuditEntryHash } from '@krusch/toolkit/audit-log'
    - import { createRbacPolicy, evaluateAccess, assertTenantOwnership, createRbacGuard } from '@krusch/toolkit/rbac'
    - import { clampPageLimit, encodeCursor, decodeCursor, buildKeysetPage, paginateItems } from '@krusch/toolkit/pagination'
    - import { s, toJsonSchema, validateSchema, createSchemaMiddleware } from '@krusch/toolkit/schema'
    - import { parseSafeYaml, stringifySafeYaml, validateYamlConfig, loadSafeYamlPack } from '@krusch/toolkit/yaml'
    - import { parseBoundedMultipart, verifyUploadMime, sanitizeUploadFilename } from '@krusch/toolkit/upload'
    - import { createTierCircuitBreaker, selectCascadeTier, executeWithCascadeFallback } from '@krusch/toolkit/cascade'
    - import { encodeWavPcm16, parseWavHeader, transcribeWhisperAudio, synthesizeSpeechAudio } from '@krusch/toolkit/audio'
    - import { scoutHomelabLegoCandidates } from '@krusch/toolkit/lego-scout'
    - import { initDb, query, run } from '@krusch/toolkit/db'
    - import { createEdgeRouter, edgeSseResponse, createEdgeKvJsonStore } from '@krusch/toolkit/edge'
    - import { verifySlackSignature, verifyGithubSignature, verifyStripeSignature, verifyBearerToken } from '@krusch/toolkit/webhooks'
    - import { withSingleInstanceLock, attachDaemonSignals, appendJsonlRecord, defineCli } from '@krusch/toolkit/cli'
- name: frontend-lego-expert
  base: gemma4:e4b
  skill: |
    Builds React + Vite frontends using AbortController-safe hooks and UI shells from '@krusch/toolkit/react':
    import { cn, STYLES, useAesthetics, fetchApiJson, useApiQuery, useSSEStream, AppShell, MetricCard, StatusPill, StreamingChatPanel, ErrorBoundary } from '@krusch/toolkit/react'
- name: llm-expert
  base: qwen3-coder-30b-moe:latest
  skill: |
    Writes Node.js scripts for unified Gemini 4 (`gemini-4-argon` thinkingLevel & multi-hop CONTINUATION), Gemini Flash-Lite, xAI, and local Ollama inference using:
    import { chat, chatJson } from '@krusch/toolkit/llm'
