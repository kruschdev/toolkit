/**
 * @module @krusch/toolkit/brick-exchange/ontology
 * @description Cross-Stack, Data-Port, Communication-Channel, and MoE Specialist Ontology
 * with HydraScope Graph Compilation & Zero-Upload Hexagonal Binding Synthesis (`INV-LEGO-36`).
 *
 * Copyright (c) 2026 kruschdev
 *
 * Zero external npm dependencies; depends only on Node 22 built-in `node:crypto` and
 * sibling `@krusch/toolkit` runtime bricks.
 */

import crypto from 'node:crypto';
import { okEnvelope, errorEnvelope } from '../http.js';
import { scrubSensitiveText } from '../security.js';
import { toJsonSchema } from '../schema.js';
import { RUNTIME_BRICKS, PROJECT_ARCHETYPES } from '../catalog.js';
import { CANONICAL_SHARED_TYPES } from '../tool-graph.js';
import {
    DEFAULT_FLEET_CASCADE_TIERS,
    selectCascadeTier,
    executeWithCascadeFallback,
} from '../cascade.js';
import { canonicalBrickHash } from './sandbox.js';
import { verifyBrickBundle } from './seal-and-policy.js';
import { tryBrickLocally } from './store-and-matcher.js';

export { CANONICAL_SHARED_TYPES };

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const TOOL_GRAPH_SHARED_PORT_SET = new Set(CANONICAL_SHARED_TYPES);

const SAFE_PORT_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SAFE_SUPERSEDES_RE = /^(?:brick:)?(?:([a-z0-9][a-z0-9-_]{1,63})@)?([0-9a-f]{64})$/i;
const SAFE_CYPHER_REL_RE = /^[A-Z][A-Z0-9_]{1,47}$/;
const ISO_DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const NODE_HOST_BARE_MODULES = new Set([
    'assert',
    'assert/strict',
    'async_hooks',
    'buffer',
    'child_process',
    'cluster',
    'console',
    'constants',
    'crypto',
    'dgram',
    'diagnostics_channel',
    'dns',
    'dns/promises',
    'domain',
    'events',
    'fs',
    'fs/promises',
    'http',
    'http2',
    'https',
    'inspector',
    'inspector/promises',
    'module',
    'net',
    'os',
    'path',
    'path/posix',
    'path/win32',
    'perf_hooks',
    'process',
    'punycode',
    'querystring',
    'readline',
    'readline/promises',
    'repl',
    'sqlite',
    'stream',
    'stream/consumers',
    'stream/promises',
    'stream/web',
    'string_decoder',
    'sys',
    'timers',
    'timers/promises',
    'tls',
    'trace_events',
    'tty',
    'url',
    'util',
    'util/types',
    'v8',
    'vm',
    'wasi',
    'worker_threads',
    'zlib',
]);

const REGEX_PRECEDING_KEYWORDS = new Set([
    'return',
    'throw',
    'case',
    'delete',
    'void',
    'typeof',
    'yield',
    'await',
    'in',
    'instanceof',
    'of',
    'new',
    'else',
    'do',
]);

function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

function hasForbiddenKeyRecursive(value, depth = 0, seen = new WeakSet()) {
    if (value === null || typeof value !== 'object') {
        return null;
    }
    if (seen.has(value)) {
        return null;
    }
    if (depth > 24) {
        return '__MAX_DEPTH_EXCEEDED__';
    }
    seen.add(value);
    try {
        if (Array.isArray(value)) {
            for (let i = 0; i < value.length; i += 1) {
                const nested = hasForbiddenKeyRecursive(value[i], depth + 1, seen);
                if (nested) return nested;
            }
            return null;
        }
        if (!isPlainObject(value)) {
            return null;
        }
        const ownNames = Object.getOwnPropertyNames(value);
        for (let i = 0; i < ownNames.length; i += 1) {
            const key = ownNames[i];
            if (FORBIDDEN_KEYS.has(key)) {
                return key;
            }
            const nested = hasForbiddenKeyRecursive(value[key], depth + 1, seen);
            if (nested) return nested;
        }
        return null;
    } finally {
        seen.delete(value);
    }
}

function defineSafeProp(target, key, value) {
    if (FORBIDDEN_KEYS.has(key)) {
        return;
    }
    Object.defineProperty(target, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
    });
}

function deepFreezePlain(value) {
    if (value === null || typeof value !== 'object') {
        return value;
    }
    if (Array.isArray(value)) {
        return Object.freeze(value.map((item) => deepFreezePlain(item)));
    }
    const out = {};
    for (const key of Object.keys(value)) {
        if (FORBIDDEN_KEYS.has(key)) continue;
        defineSafeProp(out, key, deepFreezePlain(value[key]));
    }
    return Object.freeze(out);
}

function scrubText(value) {
    if (typeof value !== 'string' || value.length === 0) {
        return '';
    }
    return scrubSensitiveText(value, {
        redactEmails: true,
        redactPaths: true,
        redactPrivateNetwork: true,
    });
}

/**
 * Axis 1: Canonical Software Runtime Stacks (`INV-LEGO-36`).
 */
export const ONTOLOGY_STACKS = deepFreezePlain({
    'node-esm': {
        id: 'node-esm',
        name: 'Node.js 22+ ESM',
        runtimeFamily: 'js',
        catalogRuntime: 'node',
        requiresWebStandardPurity: false,
        supportsNodeBuiltins: true,
        adapterFileName: 'binding.js',
        projectArchetypes: ['node-api-sqlite', 'node-rag-pgvector', 'mcp-stdio-server'],
        summary: 'Native Node.js 22+ ECMAScript module runtime with capability-port support.',
    },
    'typescript-node': {
        id: 'typescript-node',
        name: 'TypeScript on Node.js 22+',
        runtimeFamily: 'js',
        catalogRuntime: 'node',
        requiresWebStandardPurity: false,
        supportsNodeBuiltins: true,
        adapterFileName: 'binding.ts',
        projectArchetypes: ['node-ts-service'],
        summary: 'Type-checked TypeScript runtime targeting Node.js 22+ native type stripping or tsc.',
    },
    'python-fastapi': {
        id: 'python-fastapi',
        name: 'Python 3.11+ FastAPI',
        runtimeFamily: 'python',
        catalogRuntime: 'python',
        requiresWebStandardPurity: false,
        supportsNodeBuiltins: false,
        adapterFileName: 'binding_adapter.py',
        projectArchetypes: ['python-fastapi-service'],
        summary: 'Python 3.11+ FastAPI/Pydantic service bridging bricks across hexagonal HTTP/MCP contracts.',
    },
    'react-vite': {
        id: 'react-vite',
        name: 'React + Vite Browser UI',
        runtimeFamily: 'js',
        catalogRuntime: 'react',
        requiresWebStandardPurity: true,
        supportsNodeBuiltins: false,
        adapterFileName: 'binding.js',
        projectArchetypes: ['fullstack-react-vite'],
        summary: 'Browser-pure React and Vite client runtime requiring zero Node host imports.',
    },
    'cloudflare-edge': {
        id: 'cloudflare-edge',
        name: 'Cloudflare Workers Edge',
        runtimeFamily: 'js',
        catalogRuntime: 'edge',
        requiresWebStandardPurity: true,
        supportsNodeBuiltins: false,
        adapterFileName: 'binding.js',
        projectArchetypes: ['cloudflare-worker'],
        summary: 'Web-Standards WinterCG isolate runtime requiring strict zero-node:* purity.',
    },
});

/**
 * Cross-stack runtime brick equivalence map linking Node (`@krusch/toolkit/*`),
 * Python (`krusch_toolkit.*`), React (`@krusch/toolkit/react`), and Edge (`@krusch/toolkit/edge`)
 * catalog bricks (`INV-LEGO-36`).
 */
export const CROSS_STACK_BRICK_EQUIVALENTS = deepFreezePlain({
    http: {
        id: 'http',
        capability: 'http-router-envelopes',
        node: 'http',
        python: 'fastapi_app',
        react: 'react',
        edge: 'edge',
        imports: {
            node: '@krusch/toolkit/http',
            python: 'krusch_toolkit.fastapi_app',
            react: '@krusch/toolkit/react',
            edge: '@krusch/toolkit/edge',
        },
        summary: 'INV-LEGO-01 envelopes, bounded JSON body parsing, /health + /doctor, and CORS across runtimes.',
    },
    streaming: {
        id: 'streaming',
        capability: 'sse-streaming',
        node: 'streaming',
        python: 'fastapi_app',
        react: 'react',
        edge: 'edge',
        imports: {
            node: '@krusch/toolkit/streaming',
            python: 'krusch_toolkit.fastapi_app',
            react: '@krusch/toolkit/react',
            edge: '@krusch/toolkit/edge',
        },
        summary: 'AbortController-managed Server-Sent Events (SSE) framing and heartbeat streams.',
    },
    mcp: {
        id: 'mcp',
        capability: 'mcp-tool-dispatch',
        node: 'mcp',
        python: 'python_mcp',
        react: null,
        edge: null,
        imports: {
            node: '@krusch/toolkit/mcp',
            python: 'krusch_toolkit.mcp',
        },
        summary: 'INV-STACK-03 4-boolean MCP tool annotations, argument validation, and envelope dispatch.',
    },
    pg: {
        id: 'pg',
        capability: 'postgres-pgvector',
        node: 'pg',
        python: 'python_pg',
        react: null,
        edge: null,
        imports: {
            node: '@krusch/toolkit/pg',
            python: 'krusch_toolkit.pg',
        },
        summary: 'PostgreSQL connection pooling, transactional SQL migrations, and 1024d pgvector cosine search.',
    },
    security: {
        id: 'security',
        capability: 'ssrf-outbound-guard',
        node: 'security',
        python: 'python_security',
        react: null,
        edge: null,
        imports: {
            node: '@krusch/toolkit/security',
            python: 'krusch_toolkit.security',
        },
        summary: 'DNS-rebinding-safe SSRF IP/URL validation, secret/IP redaction, and rate limiting.',
    },
    webhooks: {
        id: 'webhooks',
        capability: 'webhook-hmac-verification',
        node: 'webhooks',
        python: 'python_security',
        react: null,
        edge: null,
        imports: {
            node: '@krusch/toolkit/webhooks',
            python: 'krusch_toolkit.security',
        },
        summary: 'Constant-time HMAC-SHA256 webhook signature verification and replay-window enforcement.',
    },
    schema: {
        id: 'schema',
        capability: 'schema-validation',
        node: 'schema',
        python: 'python_schema',
        react: 'schema',
        edge: 'schema',
        imports: {
            node: '@krusch/toolkit/schema',
            python: 'krusch_toolkit.schema',
            react: '@krusch/toolkit/schema',
            edge: '@krusch/toolkit/schema',
        },
        summary: 'Prototype-safe JSON Schema, s.*, Zod, and Pydantic v2 payload validation.',
    },
    upload: {
        id: 'upload',
        capability: 'bounded-multipart-upload',
        node: 'upload',
        python: 'python_upload',
        react: null,
        edge: 'upload',
        imports: {
            node: '@krusch/toolkit/upload',
            python: 'krusch_toolkit.upload',
            edge: '@krusch/toolkit/upload',
        },
        summary: 'Pre-buffer byte-bounded multipart upload parsing, filename sanitization, and MIME magic sniffing.',
    },
    yaml: {
        id: 'yaml',
        capability: 'safe-yaml-loader',
        node: 'yaml',
        python: 'python_yaml',
        react: 'yaml',
        edge: 'yaml',
        imports: {
            node: '@krusch/toolkit/yaml',
            python: 'krusch_toolkit.yaml_loader',
            react: '@krusch/toolkit/yaml',
            edge: '@krusch/toolkit/yaml',
        },
        summary: 'YAML 1.2 Core schema safe loader blocking custom tags, alias bombs, and Norway booleans.',
    },
    db: {
        id: 'db',
        capability: 'sqlite-wal-engine',
        node: 'db',
        python: 'python_db_async',
        react: null,
        edge: null,
        imports: {
            node: '@krusch/toolkit/db',
            python: 'krusch_toolkit.db_async',
        },
        summary: 'Crash-safe SQLite WAL & managed SQLAlchemy engine pools with busy_timeout and foreign_keys.',
    },
    sqlite: {
        id: 'sqlite',
        capability: 'sqlite-fts5-rrf',
        node: 'sqlite',
        python: 'python_db_async',
        react: null,
        edge: null,
        imports: {
            node: '@krusch/toolkit/sqlite',
            python: 'krusch_toolkit.db_async',
        },
        summary: 'Zero-addon Node 22 node:sqlite WAL + FTS5 + RRF paired with Python async SQLite WAL engines.',
    },
    http_client: {
        id: 'http_client',
        capability: 'resilient-outbound-http',
        node: 'security',
        python: 'python_http_client',
        react: 'react',
        edge: null,
        imports: {
            node: '@krusch/toolkit/security',
            python: 'krusch_toolkit.http_client',
            react: '@krusch/toolkit/react',
        },
        summary: 'SSRF-guarded safeFetch / async_request_json with circuit breakers and AbortController timeouts.',
    },
    ui_shell: {
        id: 'ui_shell',
        capability: 'sovereign-ui-shell',
        node: null,
        python: 'python_streamlit_ui',
        react: 'react',
        edge: null,
        imports: {
            python: 'krusch_toolkit.streamlit_ui',
            react: '@krusch/toolkit/react',
        },
        summary: 'Air-gapped Streamlit sovereign RAG shell paired with React AppShell and StreamingChatPanel.',
    },
});

const CATALOG_BRICK_BY_ID = new Map(RUNTIME_BRICKS.map((b) => [b.id, b]));
const CATALOG_BRICK_BY_IMPORT = new Map(RUNTIME_BRICKS.map((b) => [b.importPath, b]));

function summarizeArchetype(arch) {
    return {
        id: arch.id,
        title: arch.title,
        runtime: arch.runtime,
        description: arch.description,
        bricks: Array.isArray(arch.bricks) ? [...arch.bricks] : [],
    };
}

/**
 * Resolve cross-stack `@krusch/toolkit` (JS/TS/React/Edge) and `krusch_toolkit` (Python)
 * catalog brick and blueprint equivalents (`INV-LEGO-36`).
 *
 * @param {string | null} [brickIdOrRuntime=null] - Brick ID, import path, catalog runtime (`node`|`python`|`react`|`edge`), ontology stack slug, or `null`/`'*'`
 * @returns {ReturnType<typeof okEnvelope> | ReturnType<typeof errorEnvelope>}
 */
export function resolveCrossStackCatalogEquivalents(brickIdOrRuntime = null) {
    const tool = 'brick-exchange.ontology.catalog';

    if (
        brickIdOrRuntime !== null &&
        brickIdOrRuntime !== undefined &&
        typeof brickIdOrRuntime !== 'string'
    ) {
        return errorEnvelope(
            'INVALID_CATALOG_QUERY',
            'brickIdOrRuntime must be a string or null',
            null,
            tool
        );
    }

    const query = typeof brickIdOrRuntime === 'string' ? brickIdOrRuntime.trim() : '';
    if (FORBIDDEN_KEYS.has(query)) {
        return errorEnvelope(
            'ONTOLOGY_FORBIDDEN_KEY',
            `Forbidden prototype-pollution key "${query}" rejected`,
            { key: query },
            tool
        );
    }

    const allArchetypes = Object.values(PROJECT_ARCHETYPES).map(summarizeArchetype);

    if (!query || query === '*') {
        const runtimeCounts = { node: 0, python: 0, react: 0, edge: 0 };
        for (const brick of RUNTIME_BRICKS) {
            if (Object.hasOwn(runtimeCounts, brick.runtime)) {
                runtimeCounts[brick.runtime] += 1;
            }
        }
        return okEnvelope(
            tool,
            `Resolved cross-stack catalog coverage across ${RUNTIME_BRICKS.length} runtime bricks and ${allArchetypes.length} blueprints`,
            {
                totalRuntimeBricks: RUNTIME_BRICKS.length,
                runtimeCounts,
                equivalents: CROSS_STACK_BRICK_EQUIVALENTS,
                archetypes: allArchetypes,
            }
        );
    }

    // Check if query is an ontology stack slug or catalog runtime
    const matchedStack = Object.hasOwn(ONTOLOGY_STACKS, query) ? ONTOLOGY_STACKS[query] : null;
    const runtimeKey = matchedStack
        ? matchedStack.catalogRuntime
        : ['node', 'python', 'react', 'edge'].includes(query)
          ? query
          : null;

    if (runtimeKey) {
        const runtimeBricks = RUNTIME_BRICKS.filter((b) => b.runtime === runtimeKey);
        const archetypes = matchedStack
            ? matchedStack.projectArchetypes
                  .map((id) => (Object.hasOwn(PROJECT_ARCHETYPES, id) ? summarizeArchetype(PROJECT_ARCHETYPES[id]) : null))
                  .filter(Boolean)
            : allArchetypes.filter((a) => a.runtime === runtimeKey);
        const equivalents = Object.values(CROSS_STACK_BRICK_EQUIVALENTS).filter(
            (eq) => eq[runtimeKey] !== null && eq[runtimeKey] !== undefined
        );

        return okEnvelope(
            tool,
            `Resolved ${runtimeBricks.length} catalog brick(s) and ${archetypes.length} blueprint(s) for "${query}"`,
            {
                query,
                runtime: runtimeKey,
                stack: matchedStack,
                bricks: runtimeBricks,
                archetypes,
                equivalents,
            }
        );
    }

    // Resolve by brick ID, capability ID, or importPath
    const catalogBrick =
        CATALOG_BRICK_BY_ID.get(query) || CATALOG_BRICK_BY_IMPORT.get(query) || null;
    const resolvedId = catalogBrick ? catalogBrick.id : query;

    let equivalenceEntry = Object.hasOwn(CROSS_STACK_BRICK_EQUIVALENTS, resolvedId)
        ? CROSS_STACK_BRICK_EQUIVALENTS[resolvedId]
        : null;

    if (!equivalenceEntry) {
        equivalenceEntry =
            Object.values(CROSS_STACK_BRICK_EQUIVALENTS).find(
                (eq) =>
                    eq.node === resolvedId ||
                    eq.python === resolvedId ||
                    eq.react === resolvedId ||
                    eq.edge === resolvedId ||
                    Object.values(eq.imports).includes(query)
            ) || null;
    }

    if (!catalogBrick && !equivalenceEntry) {
        return errorEnvelope(
            'UNKNOWN_CATALOG_TARGET',
            `Unknown runtime, ontology stack, or catalog brick "${query}"`,
            { query },
            tool
        );
    }

    const hydratedByRuntime = {
        node: equivalenceEntry?.node ? CATALOG_BRICK_BY_ID.get(equivalenceEntry.node) || null : null,
        python: equivalenceEntry?.python ? CATALOG_BRICK_BY_ID.get(equivalenceEntry.python) || null : null,
        react: equivalenceEntry?.react ? CATALOG_BRICK_BY_ID.get(equivalenceEntry.react) || null : null,
        edge: equivalenceEntry?.edge ? CATALOG_BRICK_BY_ID.get(equivalenceEntry.edge) || null : null,
    };

    if (catalogBrick && !hydratedByRuntime[catalogBrick.runtime]) {
        hydratedByRuntime[catalogBrick.runtime] = catalogBrick;
    }

    const matchingArchetypes = allArchetypes.filter((arch) =>
        arch.bricks.some(
            (bId) =>
                bId === resolvedId ||
                bId === equivalenceEntry?.node ||
                bId === equivalenceEntry?.python ||
                bId === equivalenceEntry?.react ||
                bId === equivalenceEntry?.edge
        )
    );

    return okEnvelope(
        tool,
        `Resolved cross-stack equivalents for "${resolvedId}"`,
        {
            query,
            brickId: resolvedId,
            brick: catalogBrick,
            equivalence: equivalenceEntry,
            byRuntime: hydratedByRuntime,
            archetypes: matchingArchetypes,
        }
    );
}

/**
 * Axis 2: Canonical Schema-Typed Data Ports & Field-Alias Synonym Rings (`INV-LEGO-36`).
 */
export const ONTOLOGY_DATA_PORTS = deepFreezePlain({
    timeseries_window: {
        id: 'timeseries_window',
        shared: true,
        category: 'telemetry',
        requiredFields: ['ts', 'val'],
        fieldAliases: {
            ts: ['ts', 'timestamp', 'ts_ms', 'unix_ts', 'recorded_at', 'time'],
            val: ['val', 'value', 'reading', 'measurement', 'metric_value'],
        },
        summary: 'Ordered numeric or nullable sensor/metric readings keyed by epoch timestamp and value.',
    },
    ledger_event: {
        id: 'ledger_event',
        shared: true,
        category: 'finance',
        requiredFields: ['gross', 'currency'],
        fieldAliases: {
            gross: ['gross', 'gross_cents', 'amount', 'amount_cents', 'amount_minor', 'total_cents'],
            currency: ['currency', 'currency_code', 'iso_currency'],
            orgId: ['orgId', 'org_id', 'tenant_id', 'company_id', 'workspace_id'],
        },
        summary: 'Minor-unit integer financial ledger event carrying gross amount, ISO currency, and optional tenant scope.',
    },
    webhook_envelope: {
        id: 'webhook_envelope',
        shared: true,
        category: 'channel',
        requiredFields: ['eventId', 'signature', 'rawBody'],
        fieldAliases: {
            eventId: ['eventId', 'event_id', 'delivery_id', 'id'],
            signature: ['signature', 'sig', 'x_signature', 'hmac_signature'],
            rawBody: ['rawBody', 'raw_body', 'body', 'payload_raw'],
            timestamp: ['timestamp', 'ts', 'sent_at'],
        },
        summary: 'Signed inbound webhook delivery envelope with raw unparsed payload and replay timestamp.',
    },
    audit_record: {
        id: 'audit_record',
        shared: true,
        category: 'compliance',
        requiredFields: ['actor', 'action', 'resource'],
        fieldAliases: {
            actor: ['actor', 'actor_id', 'user_id', 'principal'],
            action: ['action', 'event_type', 'verb'],
            resource: ['resource', 'resource_id', 'target'],
            tenantId: ['tenantId', 'tenant_id', 'org_id'],
        },
        summary: 'Immutable compliance audit event attributing an action by an actor against a resource.',
    },
    identity_claims: {
        id: 'identity_claims',
        shared: true,
        category: 'auth',
        requiredFields: ['subjectId', 'tenantId'],
        fieldAliases: {
            subjectId: ['subjectId', 'sub', 'user_id', 'member_id'],
            tenantId: ['tenantId', 'tenant_id', 'org_id', 'orgId'],
            roles: ['roles', 'role_list', 'scopes'],
        },
        summary: 'Verified principal identity claims scoped to a subject, tenant, and RBAC role set.',
    },
    document_page: {
        id: 'document_page',
        shared: true,
        category: 'knowledge',
        requiredFields: ['docId', 'pageNumber', 'text'],
        fieldAliases: {
            docId: ['docId', 'doc_id', 'file_path', 'source_id'],
            pageNumber: ['pageNumber', 'page_number', 'page'],
            text: ['text', 'content', 'body'],
        },
        summary: 'Bounded document page slice carrying document identifier, page number, and extracted text.',
    },
});

/**
 * Axis 3: Canonical Communication & Ingestion Channels (`INV-LEGO-36`).
 */
export const ONTOLOGY_CHANNELS = deepFreezePlain({
    'webhook:github': {
        id: 'webhook:github',
        transport: 'https-webhook',
        inboundPorts: ['webhook_envelope', 'repo_path', 'commit_sha'],
        outboundPorts: ['audit_record', 'repo_path', 'commit_sha'],
        requiredSecurityBricks: ['@krusch/toolkit/webhooks'],
        verifierImport: '@krusch/toolkit/webhooks',
        verifierExport: 'verifyGithubSignature',
        mcpServer: null,
        mcpVerbs: [],
        requiresHmacVerification: true,
        requiresReplayWindow: true,
        requiresPiiScrub: true,
        scopedIdNamespace: 'github',
        summary: 'GitHub HMAC-SHA256 webhook ingestion channel verified via verifyGithubSignature.',
    },
    'webhook:slack': {
        id: 'webhook:slack',
        transport: 'https-webhook',
        inboundPorts: ['webhook_envelope', 'channel_name'],
        outboundPorts: ['audit_record', 'channel_name'],
        requiredSecurityBricks: ['@krusch/toolkit/webhooks'],
        verifierImport: '@krusch/toolkit/webhooks',
        verifierExport: 'verifySlackSignature',
        mcpServer: null,
        mcpVerbs: [],
        requiresHmacVerification: true,
        requiresReplayWindow: true,
        requiresPiiScrub: true,
        scopedIdNamespace: 'slack',
        summary: 'Slack v0 signing-secret webhook ingestion channel verified via verifySlackSignature.',
    },
    'webhook:stripe': {
        id: 'webhook:stripe',
        transport: 'https-webhook',
        inboundPorts: ['webhook_envelope'],
        outboundPorts: ['ledger_event', 'audit_record'],
        requiredSecurityBricks: ['@krusch/toolkit/webhooks'],
        verifierImport: '@krusch/toolkit/webhooks',
        verifierExport: 'verifyStripeSignature',
        mcpServer: null,
        mcpVerbs: [],
        requiresHmacVerification: true,
        requiresReplayWindow: true,
        requiresPiiScrub: true,
        scopedIdNamespace: 'stripe',
        summary: 'Stripe v1 HMAC-signed financial webhook channel verified via verifyStripeSignature.',
    },
    'workspace:gmail': {
        id: 'workspace:gmail',
        transport: 'workspace-api',
        inboundPorts: ['identity_claims', 'email_address'],
        outboundPorts: ['document_page', 'audit_record', 'email_address'],
        requiredSecurityBricks: ['@krusch/toolkit/security'],
        verifierImport: '@krusch/toolkit/security',
        verifierExport: 'scrubSensitiveData',
        mcpServer: 'g-krusch',
        mcpVerbs: ['search_gmail_messages', 'compose_gmail_message'],
        requiresHmacVerification: false,
        requiresReplayWindow: false,
        requiresPiiScrub: true,
        scopedIdNamespace: 'gmail',
        summary: 'Workspace Gmail channel (g-krusch) with mandatory PII/token scrubbing.',
    },
    'workspace:drive': {
        id: 'workspace:drive',
        transport: 'workspace-api',
        inboundPorts: ['identity_claims', 'file_path'],
        outboundPorts: ['document_page', 'file_path'],
        requiredSecurityBricks: ['@krusch/toolkit/security'],
        verifierImport: '@krusch/toolkit/security',
        verifierExport: 'scrubSensitiveData',
        mcpServer: 'g-krusch',
        mcpVerbs: [
            'search_drive_rag',
            'read_drive_file',
            'write_drive_file',
            'list_drive_workspace',
            'sync_drive_rag',
        ],
        requiresHmacVerification: false,
        requiresReplayWindow: false,
        requiresPiiScrub: true,
        scopedIdNamespace: 'drive',
        summary: 'Workspace Drive RAG & document storage channel (g-krusch) producing bounded document pages.',
    },
    'workspace:calendar': {
        id: 'workspace:calendar',
        transport: 'workspace-api',
        inboundPorts: ['identity_claims', 'email_address'],
        outboundPorts: ['timeseries_window', 'audit_record'],
        requiredSecurityBricks: ['@krusch/toolkit/security'],
        verifierImport: '@krusch/toolkit/security',
        verifierExport: 'scrubSensitiveData',
        mcpServer: 'g-krusch',
        mcpVerbs: ['list_calendar_events', 'create_calendar_event'],
        requiresHmacVerification: false,
        requiresReplayWindow: false,
        requiresPiiScrub: true,
        scopedIdNamespace: 'calendar',
        summary: 'Workspace Calendar scheduling channel (g-krusch) with tenant-scoped event claims.',
    },
    'mcp:stdio': {
        id: 'mcp:stdio',
        transport: 'stdio-jsonrpc',
        inboundPorts: ['identity_claims'],
        outboundPorts: ['document_page', 'audit_record'],
        requiredSecurityBricks: ['@krusch/toolkit/mcp'],
        verifierImport: '@krusch/toolkit/mcp',
        verifierExport: 'validateToolArgs',
        mcpServer: 'krusch-stack',
        mcpVerbs: ['defineMcpTool', 'createMcpServer'],
        requiresHmacVerification: false,
        requiresReplayWindow: false,
        requiresPiiScrub: true,
        scopedIdNamespace: 'mcp',
        summary: 'Model Context Protocol stdio JSON-RPC tool transport.',
    },
    'http:sse': {
        id: 'http:sse',
        transport: 'http-sse',
        inboundPorts: ['identity_claims'],
        outboundPorts: ['timeseries_window', 'document_page'],
        requiredSecurityBricks: ['@krusch/toolkit/streaming'],
        verifierImport: '@krusch/toolkit/streaming',
        verifierExport: 'sseResponse',
        mcpServer: null,
        mcpVerbs: [],
        requiresHmacVerification: false,
        requiresReplayWindow: false,
        requiresPiiScrub: false,
        scopedIdNamespace: 'sse',
        summary: 'AbortController-governed Server-Sent Events streaming channel.',
    },
    'telemetry:timeseries': {
        id: 'telemetry:timeseries',
        transport: 'telemetry-stream',
        inboundPorts: ['timeseries_window'],
        outboundPorts: ['timeseries_window', 'audit_record'],
        requiredSecurityBricks: [],
        verifierImport: null,
        verifierExport: null,
        mcpServer: null,
        mcpVerbs: [],
        requiresHmacVerification: false,
        requiresReplayWindow: false,
        requiresPiiScrub: false,
        scopedIdNamespace: 'telemetry',
        summary: 'High-cadence numeric sensor and infrastructure metric stream.',
    },
});

/**
 * Axis 4: MoE & Numerical Specialist Profiles Mapped to `@krusch/toolkit/cascade` Tiers (`INV-LEGO-36`).
 */
export const ONTOLOGY_MOE_PROFILES = deepFreezePlain({
    'timeseries-cadence-moe': {
        id: 'timeseries-cadence-moe',
        domain: 'telemetry',
        recommendedCascadeTier: 'L2_HEAVY_MOE',
        specialistModel: 'qwen3-coder-30b-moe:latest',
        fallbackChain: ['TIER_0_DETERMINISTIC', 'L1_FAST', 'L2_HEAVY_MOE'],
        numericalInvariants: {
            cadenceMs: 60_000,
            requireMonotonicTimestamps: true,
            preserveNegativeValues: true,
            nanInfPolicy: 'reject',
            anomalyMethod: 'iqr_zscore',
        },
        summary:
            'Time-series cadence gap, monotonic timestamp, and signed sensor value specialist routed to 30B MoE when deterministic alias rules need repair.',
    },
    'financial-integer-ledger': {
        id: 'financial-integer-ledger',
        domain: 'finance',
        recommendedCascadeTier: 'L2_HEAVY_MOE',
        specialistModel: 'qwen3-coder-30b-moe:latest',
        fallbackChain: ['TIER_0_DETERMINISTIC', 'L2_HEAVY_MOE', 'L3_FRONTIER_ARGON'],
        numericalInvariants: {
            integerMinorUnitsOnly: true,
            rejectFloatCurrency: true,
            preserveNegativeValues: true,
            nanInfPolicy: 'reject',
            anomalyMethod: 'exact_balance',
        },
        summary: 'Minor-unit integer financial reconciliation profile forbidding IEEE-754 float rounding drift.',
    },
    'cross-stack-schema-adapter': {
        id: 'cross-stack-schema-adapter',
        domain: 'interoperability',
        recommendedCascadeTier: 'TIER_0_DETERMINISTIC',
        specialistModel: 'gemma4:e4b',
        fallbackChain: ['TIER_0_DETERMINISTIC', 'L1_FAST', 'L2_HEAVY_MOE'],
        numericalInvariants: {
            preserveNegativeValues: true,
            nanInfPolicy: 'reject',
            anomalyMethod: 'schema_contract',
        },
        summary:
            'Zero-LLM synonym-ring field adapter escalating to L1 gemma4:e4b and L2 qwen3-coder-30b-moe only on unmapped schema mismatches.',
    },
    'channel-security-normalizer': {
        id: 'channel-security-normalizer',
        domain: 'security',
        recommendedCascadeTier: 'L1_FAST',
        specialistModel: 'gemma4:e4b',
        fallbackChain: ['TIER_0_DETERMINISTIC', 'L1_FAST', 'L2_HEAVY_MOE'],
        numericalInvariants: {
            requireReplayWindow: true,
            nanInfPolicy: 'reject',
            anomalyMethod: 'hmac_replay_guard',
        },
        summary: 'Webhook HMAC, SSRF, and replay-window normalization profile.',
    },
});

function isIdentStart(code) {
    return (
        (code >= 65 && code <= 90) ||
        (code >= 97 && code <= 122) ||
        code === 95 ||
        code === 36
    );
}

function isIdentPart(code) {
    return isIdentStart(code) || (code >= 48 && code <= 57);
}

function consumeTemplateBody(source, startIdx, out, templateBraceStack, currentBraceDepth) {
    const len = source.length;
    let i = startIdx;
    while (i < len) {
        const c = source[i];
        if (c === '\\' && i + 1 < len) {
            out.push(c, source[i + 1]);
            i += 2;
            continue;
        }
        if (c === '`') {
            out.push(c);
            i += 1;
            return i;
        }
        if (c === '$' && source[i + 1] === '{') {
            out.push('$', '{');
            templateBraceStack.push(currentBraceDepth);
            return i + 2;
        }
        out.push(c);
        i += 1;
    }
    return i;
}

function stripCommentsPreservingLiterals(source) {
    const len = source.length;
    const out = [];
    let i = 0;
    let canStartRegex = true;
    let braceDepth = 0;
    const templateBraceStack = [];

    while (i < len) {
        const ch = source[i];
        const next = i + 1 < len ? source[i + 1] : '';

        if (ch === '/' && next === '/') {
            out.push(' ', ' ');
            i += 2;
            while (i < len && source[i] !== '\n') {
                out.push(source[i] === '\r' ? '\r' : ' ');
                i += 1;
            }
            continue;
        }

        if (ch === '/' && next === '*') {
            out.push(' ', ' ');
            i += 2;
            while (i < len) {
                if (source[i] === '*' && source[i + 1] === '/') {
                    out.push(' ', ' ');
                    i += 2;
                    break;
                }
                out.push(source[i] === '\n' || source[i] === '\r' ? source[i] : ' ');
                i += 1;
            }
            continue;
        }

        if (ch === "'" || ch === '"') {
            const quote = ch;
            out.push(ch);
            i += 1;
            while (i < len) {
                const c = source[i];
                out.push(c);
                i += 1;
                if (c === '\\' && i < len) {
                    out.push(source[i]);
                    i += 1;
                    continue;
                }
                if (c === quote) break;
            }
            canStartRegex = false;
            continue;
        }

        if (ch === '`') {
            out.push(ch);
            i += 1;
            i = consumeTemplateBody(source, i, out, templateBraceStack, braceDepth);
            canStartRegex = templateBraceStack.length > 0;
            continue;
        }

        if (
            ch === '}' &&
            templateBraceStack.length > 0 &&
            braceDepth === templateBraceStack[templateBraceStack.length - 1]
        ) {
            templateBraceStack.pop();
            out.push(ch);
            i += 1;
            i = consumeTemplateBody(source, i, out, templateBraceStack, braceDepth);
            canStartRegex = templateBraceStack.length > 0;
            continue;
        }

        if (ch === '/' && canStartRegex && next !== '/' && next !== '*') {
            out.push(ch);
            i += 1;
            let inCharClass = false;
            while (i < len) {
                const c = source[i];
                out.push(c);
                i += 1;
                if (c === '\\' && i < len) {
                    out.push(source[i]);
                    i += 1;
                    continue;
                }
                if (c === '[') inCharClass = true;
                else if (c === ']') inCharClass = false;
                else if (c === '/' && !inCharClass) {
                    while (i < len && isIdentPart(source.charCodeAt(i))) {
                        out.push(source[i]);
                        i += 1;
                    }
                    break;
                } else if (c === '\n' || c === '\r') {
                    break;
                }
            }
            canStartRegex = false;
            continue;
        }

        if (isIdentStart(ch.charCodeAt(0))) {
            const start = i;
            while (i < len && isIdentPart(source.charCodeAt(i))) {
                out.push(source[i]);
                i += 1;
            }
            const word = source.slice(start, i);
            canStartRegex = REGEX_PRECEDING_KEYWORDS.has(word);
            continue;
        }

        if (ch >= '0' && ch <= '9') {
            while (i < len && (isIdentPart(source.charCodeAt(i)) || source[i] === '.')) {
                out.push(source[i]);
                i += 1;
            }
            canStartRegex = false;
            continue;
        }

        if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v') {
            out.push(ch);
            i += 1;
            continue;
        }

        if (ch === '{') {
            braceDepth += 1;
            canStartRegex = true;
        } else if (ch === '}') {
            braceDepth = Math.max(0, braceDepth - 1);
            canStartRegex = false;
        } else if (ch === ')' || ch === ']') {
            canStartRegex = false;
        } else if ((ch === '+' && next === '+') || (ch === '-' && next === '-')) {
            out.push(ch, next);
            i += 2;
            canStartRegex = false;
            continue;
        } else {
            canStartRegex = true;
        }

        out.push(ch);
        i += 1;
    }

    return out.join('');
}

function consumeMaskedTemplateBody(code, startIdx, out, templateBraceStack, currentBraceDepth) {
    const len = code.length;
    let i = startIdx;
    while (i < len) {
        const c = code[i];
        if (c === '\\' && i + 1 < len) {
            out.push(' ', ' ');
            i += 2;
            continue;
        }
        if (c === '`') {
            out.push('`');
            return i + 1;
        }
        if (c === '$' && code[i + 1] === '{') {
            out.push('$', '{');
            templateBraceStack.push(currentBraceDepth);
            return i + 2;
        }
        out.push(c === '\n' || c === '\r' ? c : ' ');
        i += 1;
    }
    return i;
}

function maskStringAndTemplateBodies(commentStrippedCode) {
    const len = commentStrippedCode.length;
    const out = [];
    let i = 0;
    let canStartRegex = true;
    let braceDepth = 0;
    const templateBraceStack = [];

    while (i < len) {
        const ch = commentStrippedCode[i];
        const next = i + 1 < len ? commentStrippedCode[i + 1] : '';

        if (ch === "'" || ch === '"') {
            const quote = ch;
            out.push(quote);
            i += 1;
            while (i < len) {
                const c = commentStrippedCode[i];
                if (c === '\\' && i + 1 < len) {
                    out.push(' ', ' ');
                    i += 2;
                    continue;
                }
                if (c === quote) {
                    out.push(quote);
                    i += 1;
                    break;
                }
                out.push(c === '\n' || c === '\r' ? c : ' ');
                i += 1;
            }
            canStartRegex = false;
            continue;
        }

        if (ch === '`') {
            out.push('`');
            i += 1;
            i = consumeMaskedTemplateBody(
                commentStrippedCode,
                i,
                out,
                templateBraceStack,
                braceDepth
            );
            canStartRegex = templateBraceStack.length > 0;
            continue;
        }

        if (
            ch === '}' &&
            templateBraceStack.length > 0 &&
            braceDepth === templateBraceStack[templateBraceStack.length - 1]
        ) {
            templateBraceStack.pop();
            out.push('}');
            i += 1;
            i = consumeMaskedTemplateBody(
                commentStrippedCode,
                i,
                out,
                templateBraceStack,
                braceDepth
            );
            canStartRegex = templateBraceStack.length > 0;
            continue;
        }

        if (ch === '/' && canStartRegex && next !== '/' && next !== '*') {
            out.push('/');
            i += 1;
            let inCharClass = false;
            while (i < len) {
                const c = commentStrippedCode[i];
                if (c === '\\' && i + 1 < len) {
                    out.push(' ', ' ');
                    i += 2;
                    continue;
                }
                if (c === '[') {
                    inCharClass = true;
                    out.push(' ');
                    i += 1;
                    continue;
                }
                if (c === ']') {
                    inCharClass = false;
                    out.push(' ');
                    i += 1;
                    continue;
                }
                if (c === '/' && !inCharClass) {
                    out.push('/');
                    i += 1;
                    while (i < len && isIdentPart(commentStrippedCode.charCodeAt(i))) {
                        out.push(commentStrippedCode[i]);
                        i += 1;
                    }
                    break;
                }
                if (c === '\n' || c === '\r') {
                    out.push(c);
                    i += 1;
                    break;
                }
                out.push(' ');
                i += 1;
            }
            canStartRegex = false;
            continue;
        }

        if (isIdentStart(ch.charCodeAt(0))) {
            const start = i;
            while (i < len && isIdentPart(commentStrippedCode.charCodeAt(i))) {
                out.push(commentStrippedCode[i]);
                i += 1;
            }
            const word = commentStrippedCode.slice(start, i);
            canStartRegex = REGEX_PRECEDING_KEYWORDS.has(word);
            continue;
        }

        if (ch >= '0' && ch <= '9') {
            while (
                i < len &&
                (isIdentPart(commentStrippedCode.charCodeAt(i)) || commentStrippedCode[i] === '.')
            ) {
                out.push(commentStrippedCode[i]);
                i += 1;
            }
            canStartRegex = false;
            continue;
        }

        if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v') {
            out.push(ch);
            i += 1;
            continue;
        }

        if (ch === '{') {
            braceDepth += 1;
            canStartRegex = true;
        } else if (ch === '}') {
            braceDepth = Math.max(0, braceDepth - 1);
            canStartRegex = false;
        } else if (ch === ')' || ch === ']') {
            canStartRegex = false;
        } else if ((ch === '+' && next === '+') || (ch === '-' && next === '-')) {
            out.push(ch, next);
            i += 2;
            canStartRegex = false;
            continue;
        } else {
            canStartRegex = true;
        }

        out.push(ch);
        i += 1;
    }

    return out.join('');
}

/**
 * Inspect JS/TS source code for Web-Standard WinterCG/Browser purity (`INV-LEGO-36`).
 * Rejects `node:*` specifiers, bare Node host modules (`fs`, `path`, `crypto`, `child_process`, etc.),
 * non-literal dynamic `import(...)` / `require(...)`, `process` / `__dirname` / `__filename`, and Node `Buffer`.
 *
 * @param {string} source
 * @returns {{ pure: boolean, violations: string[] }}
 */
export function isWebStandardPureSource(source) {
    if (typeof source !== 'string') {
        return { pure: false, violations: ['Source must be a string'] };
    }
    if (source.trim().length === 0) {
        return { pure: true, violations: [] };
    }

    const violations = [];
    const pushViolation = (msg) => {
        if (!violations.includes(msg)) {
            violations.push(msg);
        }
    };

    const commentStripped = stripCommentsPreservingLiterals(source)
        .replace(/\bimport\s+type\s+(?:[\s\S]*?\s+from\s+)?['"][^'"]+['"]\s*;?/g, ' ')
        .replace(/\bexport\s+type\s+\{[\s\S]*?\}(?:\s+from\s+['"][^'"]+['"])?\s*;?/g, ' ');

    const inspectSpecifier = (rawSpec, kind) => {
        const spec = String(rawSpec || '').trim();
        if (!spec) return;
        if (spec.startsWith('node:')) {
            pushViolation(`Node builtin ${kind} "${spec}" is incompatible with Web-Standard runtimes`);
            return;
        }
        const baseMod = spec.split('/')[0];
        if (NODE_HOST_BARE_MODULES.has(spec) || NODE_HOST_BARE_MODULES.has(baseMod)) {
            pushViolation(`Bare Node host module ${kind} "${spec}" is incompatible with Web-Standard runtimes`);
        }
    };

    let match;
    const staticImportRe = /\bimport\s+(?!type\b)[\s\S]*?\bfrom\s*(['"`])([^'"`$]+)\1/g;
    while ((match = staticImportRe.exec(commentStripped)) !== null) {
        inspectSpecifier(match[2], 'import');
    }

    const sideEffectImportRe = /\bimport\s*(['"`])([^'"`$]+)\1/g;
    while ((match = sideEffectImportRe.exec(commentStripped)) !== null) {
        inspectSpecifier(match[2], 'import');
    }

    const reExportRe = /\bexport\s+(?!type\b)(?:\*(?:\s+as\s+[A-Za-z_$][A-Za-z0-9_$]*)?|\{[\s\S]*?\})\s*from\s*(['"`])([^'"`$]+)\1/g;
    while ((match = reExportRe.exec(commentStripped)) !== null) {
        inspectSpecifier(match[2], 're-export');
    }

    const dynImportRe = /(?<!(?:\.\s*|\?\.\s*|function\s+))\bimport\s*\(\s*(['"`])([^'"`$]+)\1\s*\)/g;
    while ((match = dynImportRe.exec(commentStripped)) !== null) {
        inspectSpecifier(match[2], 'dynamic import()');
    }

    const requireRe = /(?<!(?:\.\s*|\?\.\s*|function\s+))\brequire\s*\(\s*(['"`])([^'"`$]+)\1\s*\)/g;
    while ((match = requireRe.exec(commentStripped)) !== null) {
        inspectSpecifier(match[2], 'require()');
    }

    const codeWithoutStringLiterals = maskStringAndTemplateBodies(commentStripped);

    if (
        /(?<!(?:\.\s*|\?\.\s*|function\s+))\bimport\s*\(\s*(?!(?:['"][\s]*['"]|`[\s]*`)\s*\))/.test(
            codeWithoutStringLiterals
        )
    ) {
        pushViolation('Non-literal dynamic import() is incompatible with Web-Standard purity verification');
    }

    if (
        /(?<!(?:\.\s*|\?\.\s*|function\s+))\brequire\s*\(\s*(?!(?:['"][\s]*['"]|`[\s]*`)\s*\))/.test(
            codeWithoutStringLiterals
        ) ||
        /\bcreateRequire\s*\(/.test(codeWithoutStringLiterals)
    ) {
        pushViolation('Non-literal or CommonJS require() is incompatible with Web-Standard runtimes');
    }

    if (
        /(?<!(?:\.\s*|\?\.\s*|function\s+|class\s+|const\s+|let\s+|var\s+|interface\s+|type\s+))\bprocess\b(?!\s*:)/.test(
            codeWithoutStringLiterals
        ) ||
        /\b(?:globalThis|global|self|window)\s*(?:\?\.)?\s*(?:\.\s*process\b|\[\s*(['"`])\s*process\s*\1\s*\])/.test(
            commentStripped
        ) ||
        /\b(?:const|let|var)\s*\{[^}]*\bprocess\b[^}]*\}\s*=\s*(?:globalThis|global|self|window)\b/.test(
            codeWithoutStringLiterals
        )
    ) {
        pushViolation('Node host process access is incompatible with Web-Standard runtimes');
    }

    if (
        /(?<!(?:\.\s*|\?\.\s*|const\s+|let\s+|var\s+|function\s+))\b(?:__dirname|__filename)\b(?!\s*:)/.test(
            codeWithoutStringLiterals
        ) ||
        /\bimport\s*\.\s*meta\s*\.\s*(?:dirname|filename)\b/.test(codeWithoutStringLiterals)
    ) {
        pushViolation('Node host __dirname/__filename access is incompatible with Web-Standard runtimes');
    }

    if (
        /(?<!(?:\.\s*|\?\.\s*|interface\s+|type\s+|class\s+|function\s+|const\s+|let\s+|var\s+))\bBuffer\b(?!\s*:)/.test(
            codeWithoutStringLiterals
        ) ||
        /\bnew\s+Buffer\s*\(/.test(codeWithoutStringLiterals) ||
        /\b(?:globalThis|global|self|window)\s*(?:\?\.)?\s*(?:\.\s*Buffer\b|\[\s*(['"`])\s*Buffer\s*\1\s*\])/.test(
            commentStripped
        ) ||
        /\b(?:const|let|var)\s*\{[^}]*\bBuffer\b[^}]*\}\s*=\s*(?:globalThis|global|self|window)\b/.test(
            codeWithoutStringLiterals
        )
    ) {
        pushViolation('Node Buffer API is incompatible with Web-Standard runtimes; use Uint8Array/TextEncoder');
    }

    return {
        pure: violations.length === 0,
        violations,
    };
}

function isCanonicalSharedPortName(bareName) {
    return Object.hasOwn(ONTOLOGY_DATA_PORTS, bareName) || TOOL_GRAPH_SHARED_PORT_SET.has(bareName);
}

/**
 * Normalize a port string into `{ id, namespace, bareName, shared }`.
 * Canonical ports registered in `ONTOLOGY_DATA_PORTS` or `CANONICAL_SHARED_TYPES` (`@krusch/toolkit/tool-graph`),
 * or explicitly prefixed with `canonical:`, resolve to `{ shared: true, namespace: 'canonical' }`;
 * `<ns>:<type>` (or `<ns>.<type>`) ports resolve to `{ shared: false, namespace: '<ns>', bareName: '<type>' }`.
 *
 * @param {unknown} rawPort
 * @returns {Readonly<{ id: string, namespace: string, bareName: string, shared: boolean }> | null}
 */
export function parsePortReference(rawPort) {
    if (isPlainObject(rawPort) && typeof rawPort.id === 'string') {
        return parsePortReference(rawPort.id);
    }
    if (typeof rawPort !== 'string') {
        return null;
    }
    const trimmed = rawPort.trim();
    if (trimmed.length === 0 || FORBIDDEN_KEYS.has(trimmed)) {
        return null;
    }

    const separator = trimmed.includes(':') ? ':' : trimmed.includes('.') ? '.' : null;

    if (separator !== null) {
        const parts = trimmed.split(separator);
        if (parts.length !== 2) {
            return null;
        }
        const rawNs = parts[0].trim().toLowerCase();
        const rawBare = parts[1].trim();
        if (
            !SAFE_PORT_SEGMENT_RE.test(rawNs) ||
            !SAFE_PORT_SEGMENT_RE.test(rawBare) ||
            FORBIDDEN_KEYS.has(rawNs) ||
            FORBIDDEN_KEYS.has(rawBare)
        ) {
            return null;
        }
        if (rawNs === 'canonical') {
            const canonicalId = isCanonicalSharedPortName(rawBare)
                ? rawBare
                : `canonical:${rawBare}`;
            return Object.freeze({
                id: canonicalId,
                namespace: 'canonical',
                bareName: rawBare,
                shared: true,
            });
        }
        return Object.freeze({
            id: `${rawNs}:${rawBare}`,
            namespace: rawNs,
            bareName: rawBare,
            shared: false,
        });
    }

    if (!SAFE_PORT_SEGMENT_RE.test(trimmed) || FORBIDDEN_KEYS.has(trimmed)) {
        return null;
    }
    if (isCanonicalSharedPortName(trimmed)) {
        return Object.freeze({
            id: trimmed,
            namespace: 'canonical',
            bareName: trimmed,
            shared: true,
        });
    }
    return Object.freeze({
        id: trimmed,
        namespace: 'unscoped',
        bareName: trimmed,
        shared: false,
    });
}

/**
 * Determine whether `producedPort` can safely satisfy `consumedPort` without crossing
 * incompatible opaque ID namespaces (`slack:channel_id` !== `discord:channel_id`).
 *
 * @param {string | object} producedPort
 * @param {string | object} consumedPort
 * @returns {boolean}
 */
export function arePortsCompatible(producedPort, consumedPort) {
    const prod = parsePortReference(producedPort);
    const cons = parsePortReference(consumedPort);
    if (!prod || !cons) {
        return false;
    }
    if (prod.shared && cons.shared && prod.namespace === 'canonical' && cons.namespace === 'canonical') {
        return prod.bareName === cons.bareName;
    }
    if (!prod.shared && (prod.namespace === 'unscoped' || cons.namespace === 'unscoped')) {
        return false;
    }
    if (!cons.shared && (prod.namespace === 'unscoped' || cons.namespace === 'unscoped')) {
        return false;
    }
    return prod.namespace === cons.namespace && prod.bareName === cons.bareName;
}

function normalizeIsoDateString(rawDate) {
    if (typeof rawDate !== 'string') {
        return null;
    }
    const trimmed = rawDate.trim();
    if (trimmed.length === 0) {
        return null;
    }
    const dateMatch = ISO_DATE_ONLY_RE.exec(trimmed);
    if (dateMatch) {
        const year = Number(dateMatch[1]);
        const month = Number(dateMatch[2]);
        const day = Number(dateMatch[3]);
        const utcMs = Date.UTC(year, month - 1, day);
        const dt = new Date(utcMs);
        if (
            dt.getUTCFullYear() !== year ||
            dt.getUTCMonth() + 1 !== month ||
            dt.getUTCDate() !== day
        ) {
            return null;
        }
        return trimmed;
    }
    const parsedMs = Date.parse(trimmed);
    if (!Number.isFinite(parsedMs)) {
        return null;
    }
    return new Date(parsedMs).toISOString().slice(0, 10);
}

/**
 * Validate and normalize 4-axis ontology metadata for a candidate or sealed brick (`INV-LEGO-36`).
 *
 * @param {object} [rawOntology={}]
 * @param {{ source?: string, blueprint?: object }} [options={}]
 * @returns {ReturnType<typeof okEnvelope> | ReturnType<typeof errorEnvelope>}
 */
export function normalizeBrickOntologyMetadata(rawOntology = {}, options = {}) {
    const tool = 'brick-exchange.ontology.normalize';
    if (!isPlainObject(rawOntology)) {
        return errorEnvelope(
            'INVALID_ONTOLOGY_METADATA',
            'Ontology metadata must be a plain object',
            null,
            tool
        );
    }

    const forbiddenInOntology = hasForbiddenKeyRecursive(rawOntology);
    if (forbiddenInOntology) {
        return errorEnvelope(
            'ONTOLOGY_FORBIDDEN_KEY',
            `Forbidden prototype-pollution key "${forbiddenInOntology}" rejected`,
            { key: forbiddenInOntology },
            tool
        );
    }

    const opts = isPlainObject(options) ? options : {};
    const forbiddenInOpts = hasForbiddenKeyRecursive(opts);
    if (forbiddenInOpts) {
        return errorEnvelope(
            'ONTOLOGY_FORBIDDEN_KEY',
            `Forbidden prototype-pollution key "${forbiddenInOpts}" rejected in options`,
            { key: forbiddenInOpts },
            tool
        );
    }

    const source = typeof opts.source === 'string' ? opts.source : '';
    const webStandardPurity = isWebStandardPureSource(source);

    let normalizedStacks = [];
    if (rawOntology.stacks === undefined || rawOntology.stacks === null) {
        normalizedStacks = webStandardPurity.pure
            ? ['node-esm', 'typescript-node', 'react-vite', 'cloudflare-edge']
            : ['node-esm', 'typescript-node'];
    } else if (!Array.isArray(rawOntology.stacks) || rawOntology.stacks.length === 0) {
        return errorEnvelope(
            'INVALID_ONTOLOGY_STACKS',
            'ontology.stacks must be a non-empty array of canonical stack slugs when provided',
            null,
            tool
        );
    } else {
        const seen = new Set();
        for (const item of rawOntology.stacks) {
            const slug = typeof item === 'string' ? item.trim() : '';
            if (!slug || FORBIDDEN_KEYS.has(slug) || !Object.hasOwn(ONTOLOGY_STACKS, slug)) {
                return errorEnvelope(
                    'UNKNOWN_ONTOLOGY_STACK',
                    `Unknown ontology stack "${String(item)}"`,
                    { stack: item, supportedStacks: Object.keys(ONTOLOGY_STACKS) },
                    tool
                );
            }
            if (!seen.has(slug)) {
                seen.add(slug);
                normalizedStacks.push(slug);
            }
        }
    }

    const parsePortList = (list, fieldName) => {
        if (list === undefined || list === null) return { ok: true, ports: [] };
        if (!Array.isArray(list)) {
            return {
                ok: false,
                err: errorEnvelope(
                    'INVALID_ONTOLOGY_PORT',
                    `ontology.${fieldName} must be an array of port strings`,
                    { field: fieldName },
                    tool
                ),
            };
        }
        const out = [];
        const seen = new Set();
        for (const rawItem of list) {
            const parsed = parsePortReference(rawItem);
            if (!parsed) {
                return {
                    ok: false,
                    err: errorEnvelope(
                        'INVALID_ONTOLOGY_PORT',
                        `Invalid port reference "${String(rawItem)}" in ontology.${fieldName}`,
                        { field: fieldName, port: rawItem },
                        tool
                    ),
                };
            }
            if (!seen.has(parsed.id)) {
                seen.add(parsed.id);
                out.push(parsed.id);
            }
        }
        return { ok: true, ports: out };
    };

    const consumesRes = parsePortList(rawOntology.consumesPorts, 'consumesPorts');
    if (!consumesRes.ok) return consumesRes.err;

    const producesRes = parsePortList(rawOntology.producesPorts, 'producesPorts');
    if (!producesRes.ok) return producesRes.err;

    const normalizedChannels = [];
    if (rawOntology.channels !== undefined && rawOntology.channels !== null) {
        if (!Array.isArray(rawOntology.channels)) {
            return errorEnvelope(
                'INVALID_ONTOLOGY_CHANNELS',
                'ontology.channels must be an array of canonical channel IDs',
                null,
                tool
            );
        }
        const seen = new Set();
        for (const rawCh of rawOntology.channels) {
            const ch = typeof rawCh === 'string' ? rawCh.trim() : '';
            if (!ch || FORBIDDEN_KEYS.has(ch) || !Object.hasOwn(ONTOLOGY_CHANNELS, ch)) {
                return errorEnvelope(
                    'UNKNOWN_ONTOLOGY_CHANNEL',
                    `Unknown ontology channel "${String(rawCh)}"`,
                    { channel: rawCh, supportedChannels: Object.keys(ONTOLOGY_CHANNELS) },
                    tool
                );
            }
            if (!seen.has(ch)) {
                seen.add(ch);
                normalizedChannels.push(ch);
            }
        }
    }

    let moeProfile = null;
    if (rawOntology.moeProfile !== undefined && rawOntology.moeProfile !== null && rawOntology.moeProfile !== '') {
        const rawMoe = typeof rawOntology.moeProfile === 'string' ? rawOntology.moeProfile.trim() : '';
        if (!rawMoe || FORBIDDEN_KEYS.has(rawMoe) || !Object.hasOwn(ONTOLOGY_MOE_PROFILES, rawMoe)) {
            return errorEnvelope(
                'UNKNOWN_MOE_PROFILE',
                `Unknown ontology MoE profile "${String(rawOntology.moeProfile)}"`,
                {
                    moeProfile: rawOntology.moeProfile,
                    supportedProfiles: Object.keys(ONTOLOGY_MOE_PROFILES),
                },
                tool
            );
        }
        moeProfile = rawMoe;
    }

    const supersedes = [];
    if (rawOntology.supersedes !== undefined && rawOntology.supersedes !== null) {
        if (!Array.isArray(rawOntology.supersedes)) {
            return errorEnvelope(
                'INVALID_SUPERSEDES_REF',
                'ontology.supersedes must be an array of 64-hex sourceHash or brickId@sourceHash references',
                null,
                tool
            );
        }
        const seen = new Set();
        for (const item of rawOntology.supersedes) {
            const rawStr = typeof item === 'string' ? item.trim() : '';
            const m = SAFE_SUPERSEDES_RE.exec(rawStr);
            if (!m) {
                return errorEnvelope(
                    'INVALID_SUPERSEDES_REF',
                    `Invalid supersedes reference "${String(item)}"; expected 64-hex sourceHash or brickId@sourceHash`,
                    { reference: item },
                    tool
                );
            }
            const normalizedRef = m[1] ? `${m[1]}@${m[2].toLowerCase()}` : m[2].toLowerCase();
            if (!seen.has(normalizedRef)) {
                seen.add(normalizedRef);
                supersedes.push(normalizedRef);
            }
        }
    }

    let validFrom = null;
    if (rawOntology.validFrom !== undefined && rawOntology.validFrom !== null && rawOntology.validFrom !== '') {
        validFrom = normalizeIsoDateString(rawOntology.validFrom);
        if (!validFrom) {
            return errorEnvelope(
                'INVALID_ONTOLOGY_DATE',
                `Invalid validFrom date "${String(rawOntology.validFrom)}"`,
                { field: 'validFrom', value: rawOntology.validFrom },
                tool
            );
        }
    }

    let retiredAt = null;
    if (rawOntology.retiredAt !== undefined && rawOntology.retiredAt !== null && rawOntology.retiredAt !== '') {
        retiredAt = normalizeIsoDateString(rawOntology.retiredAt);
        if (!retiredAt) {
            return errorEnvelope(
                'INVALID_ONTOLOGY_DATE',
                `Invalid retiredAt date "${String(rawOntology.retiredAt)}"`,
                { field: 'retiredAt', value: rawOntology.retiredAt },
                tool
            );
        }
    }

    let timeSeriesContract = null;
    if (rawOntology.timeSeriesContract !== undefined && rawOntology.timeSeriesContract !== null) {
        if (!isPlainObject(rawOntology.timeSeriesContract)) {
            return errorEnvelope(
                'INVALID_TIMESERIES_CONTRACT',
                'ontology.timeSeriesContract must be a plain object',
                null,
                tool
            );
        }
        const rawTs = rawOntology.timeSeriesContract;
        let cadenceMs = null;
        if (rawTs.cadenceMs !== undefined && rawTs.cadenceMs !== null) {
            if (typeof rawTs.cadenceMs !== 'number' || !Number.isFinite(rawTs.cadenceMs) || rawTs.cadenceMs <= 0) {
                return errorEnvelope(
                    'INVALID_TIMESERIES_CONTRACT',
                    'timeSeriesContract.cadenceMs must be a positive finite number',
                    { cadenceMs: rawTs.cadenceMs },
                    tool
                );
            }
            cadenceMs = rawTs.cadenceMs;
        }
        const nanInfPolicy =
            rawTs.nanInfPolicy === undefined ? 'reject' : String(rawTs.nanInfPolicy).trim();
        if (nanInfPolicy !== 'reject' && nanInfPolicy !== 'impute_null') {
            return errorEnvelope(
                'INVALID_TIMESERIES_CONTRACT',
                `Unsupported timeSeriesContract.nanInfPolicy "${nanInfPolicy}"`,
                { nanInfPolicy },
                tool
            );
        }
        timeSeriesContract = deepFreezePlain({
            ...(cadenceMs !== null ? { cadenceMs } : {}),
            requireMonotonicTimestamps: Boolean(rawTs.requireMonotonicTimestamps),
            preserveNegativeValues:
                rawTs.preserveNegativeValues === undefined
                    ? true
                    : Boolean(rawTs.preserveNegativeValues),
            nanInfPolicy,
        });
    }

    const ontology = deepFreezePlain({
        stacks: normalizedStacks,
        consumesPorts: consumesRes.ports,
        producesPorts: producesRes.ports,
        channels: normalizedChannels,
        moeProfile,
        supersedes,
        validFrom,
        retiredAt,
        timeSeriesContract,
    });

    return okEnvelope(tool, 'Normalized 4-axis brick ontology metadata', {
        ontology,
        webStandardPurity,
    });
}

function extractRawOntologyFromBundle(bundle, explicitOntology = null) {
    if (isPlainObject(explicitOntology)) {
        return explicitOntology;
    }
    if (isPlainObject(bundle?.lineage)) {
        if (isPlainObject(bundle?.blueprint?.ontology)) {
            return bundle.blueprint.ontology;
        }
        const isAttestedSealedBundle =
            bundle?.format === 'krusch-sealed-brick/v1' ||
            isPlainObject(bundle?.attestation) ||
            typeof bundle?.lineage?.blueprintHash === 'string' ||
            isPlainObject(bundle?.blueprint);
        if (isAttestedSealedBundle) {
            return {};
        }
    }
    if (isPlainObject(bundle?.blueprint?.ontology)) {
        return bundle.blueprint.ontology;
    }
    if (isPlainObject(bundle?.ontology)) {
        return bundle.ontology;
    }
    return {};
}

function validateTimeSeriesSample(sampleData, tsContract) {
    const rows = Array.isArray(sampleData)
        ? sampleData
        : isPlainObject(sampleData) && Array.isArray(sampleData.rows)
          ? sampleData.rows
          : isPlainObject(sampleData)
            ? [sampleData]
            : null;

    if (!rows) {
        return {
            ok: false,
            violation: 'INVALID_SAMPLE_SHAPE',
            message: 'Time-series sampleData must be an array of row objects or a row object',
            details: { sampleType: typeof sampleData },
        };
    }

    const tsAliases = ONTOLOGY_DATA_PORTS.timeseries_window.fieldAliases.ts;
    const valAliases = ONTOLOGY_DATA_PORTS.timeseries_window.fieldAliases.val;

    let prevTs = -Infinity;
    for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i];
        if (!isPlainObject(row)) {
            return {
                ok: false,
                violation: 'INVALID_ROW_OBJECT',
                message: `Time-series row at index ${i} must be an object`,
                details: { rowIndex: i },
            };
        }

        let tsKey = null;
        for (const candidate of tsAliases) {
            if (Object.hasOwn(row, candidate)) {
                tsKey = candidate;
                break;
            }
        }

        if (tsContract.nanInfPolicy === 'reject') {
            for (const key of Object.keys(row)) {
                if (FORBIDDEN_KEYS.has(key)) continue;
                const val = row[key];
                if (typeof val === 'number' && !Number.isFinite(val)) {
                    return {
                        ok: false,
                        violation: 'NON_FINITE_VALUE',
                        message: `Time-series sample contains non-finite number (${String(val)}) at row ${i}.${key}`,
                        details: { rowIndex: i, field: key, value: String(val) },
                    };
                }
                if (
                    typeof val === 'string' &&
                    valAliases.includes(key) &&
                    /^[+-]?(?:NaN|Infinity)$/i.test(val.trim())
                ) {
                    return {
                        ok: false,
                        violation: 'NON_FINITE_STRING',
                        message: `Time-series sample contains "${val}" literal at row ${i}.${key}`,
                        details: { rowIndex: i, field: key, value: val },
                    };
                }
            }
        }

        if (tsContract.requireMonotonicTimestamps && tsKey !== null) {
            const rawTs = row[tsKey];
            if (typeof rawTs !== 'number' || !Number.isFinite(rawTs)) {
                return {
                    ok: false,
                    violation: 'NON_NUMERIC_TIMESTAMP',
                    message: `Time-series timestamp at row ${i}.${tsKey} must be a finite number`,
                    details: { rowIndex: i, field: tsKey },
                };
            }
            if (rawTs < prevTs) {
                return {
                    ok: false,
                    violation: 'NON_MONOTONIC_TIMESTAMP',
                    message: `Non-monotonic timestamp at row ${i}: ${rawTs} < ${prevTs}`,
                    details: {
                        rowIndex: i,
                        field: tsKey,
                        timestamp: rawTs,
                        previousTimestamp: prevTs,
                    },
                };
            }
            prevTs = rawTs;
        }
    }

    return { ok: true };
}

function buildCascadePlanForProfile(moeProfileId) {
    const profile =
        (moeProfileId && Object.hasOwn(ONTOLOGY_MOE_PROFILES, moeProfileId)
            ? ONTOLOGY_MOE_PROFILES[moeProfileId]
            : null) || ONTOLOGY_MOE_PROFILES['cross-stack-schema-adapter'];

    const complexityScore =
        profile.recommendedCascadeTier === 'L3_FRONTIER_ARGON'
            ? 0.95
            : profile.recommendedCascadeTier === 'L2_HEAVY_MOE'
              ? 0.6
              : profile.recommendedCascadeTier === 'L1_FAST'
                ? 0.25
                : 0.15;

    const cascadeRes = selectCascadeTier({
        complexityScore,
        requiresTools: true,
        allowFrontier: profile.fallbackChain.includes('L3_FRONTIER_ARGON'),
        tiers: DEFAULT_FLEET_CASCADE_TIERS,
    });

    return {
        moeProfile: profile.id,
        recommendedCascadeTier: profile.recommendedCascadeTier,
        specialistModel: profile.specialistModel,
        fallbackChain: [...profile.fallbackChain],
        selectedFleetTier: cascadeRes.ok ? cascadeRes.data.selectedTier.id : null,
        candidateChain: cascadeRes.ok
            ? cascadeRes.data.candidateChain.map((t) => ({
                  id: t.id,
                  model: t.defaultModel || t.model,
                  provider: t.provider,
              }))
            : [],
    };
}

/**
 * `<1ms` Zero-LLM pre-flight answerability and cross-stack compatibility gate (`INV-LEGO-36`).
 *
 * @param {object} [options={}]
 * @returns {ReturnType<typeof okEnvelope> | ReturnType<typeof errorEnvelope>}
 */
export function checkOntologyCompatibility(options = {}) {
    const tool = 'brick-exchange.ontology.check';
    if (!isPlainObject(options)) {
        return errorEnvelope('INVALID_COMPATIBILITY_OPTIONS', 'Options must be a plain object', null, tool);
    }

    const forbiddenOpt = hasForbiddenKeyRecursive(options);
    if (forbiddenOpt) {
        return errorEnvelope(
            'ONTOLOGY_FORBIDDEN_KEY',
            `Forbidden prototype-pollution key "${forbiddenOpt}" rejected`,
            { key: forbiddenOpt },
            tool
        );
    }

    const {
        bundle,
        ontology: explicitOntology = null,
        targetStack = 'node-esm',
        targetChannel = null,
        providedSecurityBricks = [],
        enforceChannelGuards = false,
        upstreamProducedPorts = [],
        consumedPorts = null,
        sampleData = undefined,
        localSample = undefined,
        localSampleOrSchema = undefined,
    } = options;

    if (!isPlainObject(bundle) || typeof bundle.source !== 'string' || bundle.source.trim().length === 0) {
        return errorEnvelope(
            'INVALID_BRICK_BUNDLE',
            'bundle must be an object containing non-empty string source',
            null,
            tool
        );
    }

    if (
        typeof targetStack !== 'string' ||
        FORBIDDEN_KEYS.has(targetStack) ||
        !Object.hasOwn(ONTOLOGY_STACKS, targetStack)
    ) {
        return errorEnvelope(
            'UNKNOWN_ONTOLOGY_STACK',
            `Unknown targetStack "${String(targetStack)}"`,
            { targetStack, supportedStacks: Object.keys(ONTOLOGY_STACKS) },
            tool
        );
    }

    const stackDesc = ONTOLOGY_STACKS[targetStack];
    const rawOntology = extractRawOntologyFromBundle(bundle, explicitOntology);
    const normRes = normalizeBrickOntologyMetadata(rawOntology, {
        source: bundle.source,
        blueprint: isPlainObject(bundle.blueprint) ? bundle.blueprint : {},
    });
    if (!normRes.ok) {
        return errorEnvelope(
            normRes.error.code,
            normRes.error.message,
            normRes.error.details ?? null,
            tool
        );
    }

    const { ontology, webStandardPurity } = normRes.data;
    if (stackDesc.requiresWebStandardPurity && !webStandardPurity.pure) {
        return errorEnvelope(
            'STACK_RUNTIME_INCOMPATIBLE',
            `Brick "${bundle.brickId || 'candidate'}" is incompatible with Web-Standard stack "${targetStack}"`,
            {
                brickId: bundle.brickId || null,
                targetStack,
                violations: webStandardPurity.violations,
            },
            tool
        );
    }

    const warnings = [];
    const bridgeMode = stackDesc.runtimeFamily === 'python' ? 'contract-adapter' : 'native';
    if (bridgeMode === 'contract-adapter') {
        warnings.push(
            `Target stack "${targetStack}" uses hexagonal contract-adapter mode (${stackDesc.adapterFileName}); invoke JS/TS brick across HTTP/MCP or sandboxed subprocess rather than in-process Python import.`
        );
    } else if (
        Array.isArray(rawOntology.stacks) &&
        !ontology.stacks.includes(targetStack)
    ) {
        warnings.push(
            `Brick ontology explicitly declared stacks [${ontology.stacks.join(', ')}]; verify local binding on "${targetStack}".`
        );
    }

    let recommendedSecurityBricks = [];
    if (targetChannel !== null && targetChannel !== undefined && targetChannel !== '') {
        if (
            typeof targetChannel !== 'string' ||
            FORBIDDEN_KEYS.has(targetChannel) ||
            !Object.hasOwn(ONTOLOGY_CHANNELS, targetChannel)
        ) {
            return errorEnvelope(
                'UNKNOWN_ONTOLOGY_CHANNEL',
                `Unknown targetChannel "${String(targetChannel)}"`,
                { targetChannel, supportedChannels: Object.keys(ONTOLOGY_CHANNELS) },
                tool
            );
        }
        const channelDesc = ONTOLOGY_CHANNELS[targetChannel];
        recommendedSecurityBricks = [...channelDesc.requiredSecurityBricks];

        const providedSet = new Set();
        if (Array.isArray(providedSecurityBricks)) {
            for (const b of providedSecurityBricks) {
                if (typeof b === 'string' && b.trim()) {
                    const clean = b.trim();
                    providedSet.add(clean);
                    if (!clean.startsWith('@krusch/toolkit/')) {
                        providedSet.add(`@krusch/toolkit/${clean}`);
                    }
                }
            }
        }
        if (Array.isArray(bundle.capabilities)) {
            for (const cap of bundle.capabilities) {
                if (typeof cap === 'string' && cap.trim().startsWith('@krusch/toolkit/')) {
                    providedSet.add(cap.trim());
                }
            }
        }

        const missingSecurityBricks = recommendedSecurityBricks.filter((req) => !providedSet.has(req));
        if (missingSecurityBricks.length > 0) {
            if (enforceChannelGuards === true) {
                return errorEnvelope(
                    'CHANNEL_SECURITY_GUARD_MISSING',
                    `Channel "${targetChannel}" requires security guard brick(s): ${missingSecurityBricks.join(', ')}`,
                    {
                        targetChannel,
                        missingSecurityBricks,
                        requiredSecurityBricks: recommendedSecurityBricks,
                        verifierExport: channelDesc.verifierExport || null,
                    },
                    tool
                );
            }
            warnings.push(
                `Channel "${targetChannel}" recommends security brick(s): ${missingSecurityBricks.join(', ')}`
            );
        }
    }

    const activeConsumedPorts = Array.isArray(consumedPorts)
        ? consumedPorts
        : ontology.consumesPorts;

    if (Array.isArray(upstreamProducedPorts) && upstreamProducedPorts.length > 0) {
        const parsedUpstream = [];
        for (const up of upstreamProducedPorts) {
            const parsed = parsePortReference(up);
            if (!parsed) {
                return errorEnvelope(
                    'INVALID_ONTOLOGY_PORT',
                    `Invalid upstreamProducedPorts entry "${String(up)}"`,
                    { port: up },
                    tool
                );
            }
            parsedUpstream.push(parsed);
        }

        if (Array.isArray(activeConsumedPorts) && activeConsumedPorts.length > 0) {
            for (const rawConsumed of activeConsumedPorts) {
                const parsedConsumed = parsePortReference(rawConsumed);
                if (!parsedConsumed) {
                    return errorEnvelope(
                        'INVALID_ONTOLOGY_PORT',
                        `Invalid consumed port "${String(rawConsumed)}"`,
                        { port: rawConsumed },
                        tool
                    );
                }

                const satisfied = parsedUpstream.some((prod) =>
                    arePortsCompatible(prod, parsedConsumed)
                );
                if (!satisfied) {
                    const colliding = parsedUpstream.find(
                        (prod) =>
                            prod.bareName === parsedConsumed.bareName &&
                            prod.namespace !== parsedConsumed.namespace
                    );
                    if (colliding) {
                        return errorEnvelope(
                            'PORT_NAMESPACE_COLLISION',
                            `Port namespace collision: "${colliding.id}" (namespace "${colliding.namespace}") cannot wire into "${parsedConsumed.id}" (namespace "${parsedConsumed.namespace}")`,
                            {
                                producedPort: colliding.id,
                                consumedPort: parsedConsumed.id,
                                bareName: parsedConsumed.bareName,
                                producedNamespace: colliding.namespace,
                                consumedNamespace: parsedConsumed.namespace,
                            },
                            tool
                        );
                    }
                    return errorEnvelope(
                        'PORT_CONTRACT_UNSATISFIED',
                        `Consumed port "${parsedConsumed.id}" is not satisfied by upstream ports [${parsedUpstream.map((p) => p.id).join(', ')}]`,
                        {
                            consumedPort: parsedConsumed.id,
                            upstreamProducedPorts: parsedUpstream.map((p) => p.id),
                        },
                        tool
                    );
                }
            }
        }
    }

    const effectiveSample =
        sampleData !== undefined
            ? sampleData
            : localSample !== undefined
              ? localSample
              : localSampleOrSchema;

    if (effectiveSample !== undefined && effectiveSample !== null && ontology.timeSeriesContract) {
        const tsCheck = validateTimeSeriesSample(effectiveSample, ontology.timeSeriesContract);
        if (!tsCheck.ok) {
            return errorEnvelope(
                'TIMESERIES_INVARIANT_VIOLATION',
                tsCheck.message,
                {
                    violation: tsCheck.violation,
                    ...tsCheck.details,
                },
                tool
            );
        }
    }

    const cascadePlan = buildCascadePlanForProfile(ontology.moeProfile);

    return okEnvelope(
        tool,
        `Brick "${bundle.brickId || 'candidate'}" compatible with stack "${targetStack}" (${bridgeMode})`,
        {
            compatible: true,
            targetStack,
            bridgeMode,
            targetChannel: targetChannel || null,
            ontology,
            warnings,
            recommendedSecurityBricks,
            cascadePlan,
        }
    );
}

/**
 * Compute a deterministic 48-bit safe integer vertex ID in `[1000, 281474976711655]`
 * compatible with HydraScope / HydraDB OpenCypher integer vertex addressing (`INV-LEGO-36`).
 *
 * @param {string} namespace
 * @param {string} logicalId
 * @returns {number}
 */
export function surrogateOntologyVertexId(namespace, logicalId) {
    const ns = String(namespace || 'brick-ontology');
    const id = String(logicalId || '');
    return (
        crypto
            .createHash('sha256')
            .update(`${ns}\0${id}`, 'utf8')
            .digest()
            .readUIntBE(0, 6) + 1000
    );
}

/**
 * Compile sealed brick bundles, organization stack/channel/port profiles, and `:SUPERSEDES`
 * lineage into a Zero-Leak-scrubbed HydraScope property graph (`INV-LEGO-36`).
 *
 * @param {object} [options={}]
 * @returns {ReturnType<typeof okEnvelope> | ReturnType<typeof errorEnvelope>}
 */
export function compileBrickOntologyGraph(options = {}) {
    const tool = 'brick-exchange.ontology.graph';
    if (!isPlainObject(options)) {
        return errorEnvelope('INVALID_GRAPH_OPTIONS', 'Options must be a plain object', null, tool);
    }

    const forbiddenKey = hasForbiddenKeyRecursive(options);
    if (forbiddenKey) {
        return errorEnvelope(
            'ONTOLOGY_FORBIDDEN_KEY',
            `Forbidden prototype-pollution key "${forbiddenKey}" rejected`,
            { key: forbiddenKey },
            tool
        );
    }

    const {
        bricks = [],
        orgProfiles = [],
        namespace = 'brick-ontology',
    } = options;

    if (!Array.isArray(bricks) || !Array.isArray(orgProfiles)) {
        return errorEnvelope(
            'INVALID_GRAPH_OPTIONS',
            'bricks and orgProfiles must be arrays',
            null,
            tool
        );
    }

    const safeNamespace = scrubText(String(namespace || 'brick-ontology').trim()) || 'brick-ontology';
    const nodeMap = new Map();
    const edgeList = [];
    const edgeDedup = new Set();

    const addNode = (node) => {
        if (!nodeMap.has(node.id)) {
            nodeMap.set(node.id, node);
        }
        return nodeMap.get(node.id);
    };

    const addEdge = (from, to, type, extra = {}) => {
        if (!SAFE_CYPHER_REL_RE.test(type)) return;
        const key = `${from}\0${type}\0${to}`;
        if (edgeDedup.has(key)) return;
        edgeDedup.add(key);
        edgeList.push({
            from,
            to,
            type,
            ...extra,
        });
    };

    // Seed canonical 4-axis taxonomy vertices
    for (const stack of Object.values(ONTOLOGY_STACKS)) {
        const id = `stack:${stack.id}`;
        addNode({
            id,
            surrogateId: surrogateOntologyVertexId(safeNamespace, id),
            kind: 'stack',
            slug: stack.id,
            title: scrubText(stack.name),
            summary: scrubText(stack.summary),
            runtimeFamily: stack.runtimeFamily,
            catalogRuntime: stack.catalogRuntime,
            requiresWebStandardPurity: stack.requiresWebStandardPurity,
            isCurrent: true,
            validFrom: null,
            retiredAt: null,
            supersededBy: null,
        });
    }

    const ensurePortVertex = (rawPort) => {
        const parsed = parsePortReference(rawPort);
        if (!parsed) return null;
        const id = `port:${parsed.id}`;
        if (!nodeMap.has(id)) {
            const canonicalDesc =
                parsed.shared && Object.hasOwn(ONTOLOGY_DATA_PORTS, parsed.bareName)
                    ? ONTOLOGY_DATA_PORTS[parsed.bareName]
                    : null;
            const category = canonicalDesc
                ? canonicalDesc.category
                : TOOL_GRAPH_SHARED_PORT_SET.has(parsed.bareName)
                  ? 'tool-graph-shared'
                  : 'scoped';
            addNode({
                id,
                surrogateId: surrogateOntologyVertexId(safeNamespace, id),
                kind: 'port',
                portId: parsed.id,
                namespace: parsed.namespace,
                bareName: parsed.bareName,
                shared: parsed.shared,
                category,
                title: scrubText(parsed.id),
                summary: scrubText(
                    canonicalDesc ? canonicalDesc.summary : `Port ${parsed.id} (${category})`
                ),
                isCurrent: true,
                validFrom: null,
                retiredAt: null,
                supersededBy: null,
            });
        }
        return id;
    };

    for (const port of Object.values(ONTOLOGY_DATA_PORTS)) {
        ensurePortVertex(port.id);
    }

    for (const channel of Object.values(ONTOLOGY_CHANNELS)) {
        const id = `channel:${channel.id}`;
        addNode({
            id,
            surrogateId: surrogateOntologyVertexId(safeNamespace, id),
            kind: 'channel',
            channelId: channel.id,
            transport: channel.transport,
            scopedIdNamespace: channel.scopedIdNamespace,
            verifierExport: channel.verifierExport || null,
            mcpServer: channel.mcpServer || null,
            title: scrubText(channel.id),
            summary: scrubText(channel.summary),
            isCurrent: true,
            validFrom: null,
            retiredAt: null,
            supersededBy: null,
        });
    }

    for (const profile of Object.values(ONTOLOGY_MOE_PROFILES)) {
        const id = `moe_profile:${profile.id}`;
        addNode({
            id,
            surrogateId: surrogateOntologyVertexId(safeNamespace, id),
            kind: 'moe_profile',
            profileId: profile.id,
            domain: profile.domain,
            recommendedCascadeTier: profile.recommendedCascadeTier,
            specialistModel: scrubText(profile.specialistModel),
            title: scrubText(profile.id),
            summary: scrubText(profile.summary),
            isCurrent: true,
            validFrom: null,
            retiredAt: null,
            supersededBy: null,
        });
    }

    const brickNodes = [];
    const bySourceHash = new Map();
    const byCompositeRef = new Map();

    for (let idx = 0; idx < bricks.length; idx += 1) {
        const entry = bricks[idx];
        if (!isPlainObject(entry)) {
            return errorEnvelope(
                'INVALID_BRICK_ENTRY',
                `Brick entry at index ${idx} must be an object`,
                { index: idx },
                tool
            );
        }

        const bundle = isPlainObject(entry.bundle) ? entry.bundle : entry;
        const brickId = typeof bundle.brickId === 'string' ? bundle.brickId.trim() : '';
        const source = typeof bundle.source === 'string' ? bundle.source : '';
        if (!brickId || FORBIDDEN_KEYS.has(brickId) || !source) {
            return errorEnvelope(
                'INVALID_BRICK_ENTRY',
                `Brick entry at index ${idx} is missing brickId or source`,
                { index: idx },
                tool
            );
        }

        const sourceHash =
            typeof bundle.lineage?.sourceHash === 'string' && /^[0-9a-f]{64}$/i.test(bundle.lineage.sourceHash)
                ? bundle.lineage.sourceHash.toLowerCase()
                : canonicalBrickHash(source);

        const mergedRawOntology = {
            ...extractRawOntologyFromBundle(bundle),
            ...(isPlainObject(entry.ontology) ? entry.ontology : {}),
            ...(entry.validFrom !== undefined ? { validFrom: entry.validFrom } : {}),
            ...(entry.retiredAt !== undefined ? { retiredAt: entry.retiredAt } : {}),
            ...(entry.supersedes !== undefined ? { supersedes: entry.supersedes } : {}),
        };

        const normRes = normalizeBrickOntologyMetadata(mergedRawOntology, {
            source,
            blueprint: isPlainObject(bundle.blueprint) ? bundle.blueprint : {},
        });
        if (!normRes.ok) {
            return errorEnvelope(
                normRes.error.code,
                normRes.error.message,
                normRes.error.details ?? null,
                tool
            );
        }

        const { ontology } = normRes.data;
        const createdAtStr =
            typeof bundle.createdAt === 'string'
                ? bundle.createdAt
                : typeof bundle.lineage?.sealedAt === 'string'
                  ? bundle.lineage.sealedAt
                  : '';
        const createdDate = normalizeIsoDateString(createdAtStr);

        const nodeId = `brick:${brickId}@${sourceHash}`;
        const brickNode = {
            id: nodeId,
            surrogateId: surrogateOntologyVertexId(safeNamespace, nodeId),
            kind: 'brick',
            brickId: scrubText(brickId),
            sourceHash,
            orgId: scrubText(String(bundle.orgId || '')),
            authorId: scrubText(String(bundle.authorId || '')),
            title: scrubText(String(bundle.name || bundle.blueprint?.name || brickId)),
            summary: scrubText(String(bundle.summary || bundle.blueprint?.summary || '')),
            stacks: [...ontology.stacks],
            consumesPorts: [...ontology.consumesPorts],
            producesPorts: [...ontology.producesPorts],
            channels: [...ontology.channels],
            moeProfile: ontology.moeProfile,
            supersedes: [...ontology.supersedes],
            capabilities: Array.isArray(bundle.capabilities)
                ? bundle.capabilities.map((c) => scrubText(String(c)))
                : [],
            createdDate,
            isCurrent: ontology.retiredAt === null,
            validFrom: ontology.validFrom,
            retiredAt: ontology.retiredAt,
            supersededBy: null,
        };

        addNode(brickNode);
        brickNodes.push(brickNode);
        bySourceHash.set(sourceHash, brickNode);
        byCompositeRef.set(`${brickId}@${sourceHash}`, brickNode);

        for (const stackSlug of ontology.stacks) {
            addEdge(nodeId, `stack:${stackSlug}`, 'TARGETS_STACK');
        }
        for (const portRef of ontology.consumesPorts) {
            const portVertexId = ensurePortVertex(portRef);
            if (portVertexId) addEdge(nodeId, portVertexId, 'CONSUMES_PORT');
        }
        for (const portRef of ontology.producesPorts) {
            const portVertexId = ensurePortVertex(portRef);
            if (portVertexId) addEdge(nodeId, portVertexId, 'PRODUCES_PORT');
        }
        for (const channelId of ontology.channels) {
            addEdge(nodeId, `channel:${channelId}`, 'BRIDGES_CHANNEL');
        }
        if (ontology.moeProfile) {
            addEdge(nodeId, `moe_profile:${ontology.moeProfile}`, 'ROUTES_TO_MODEL');
        }
    }

    // Resolve `:SUPERSEDES` lineage across brick versions (same-org & cycle-free)
    const supersedesOutMap = new Map();
    const createsSupersedesCycle = (fromId, toId) => {
        if (fromId === toId) return true;
        const visited = new Set([toId]);
        const queue = [toId];
        while (queue.length > 0) {
            const cur = queue.shift();
            const nextSet = supersedesOutMap.get(cur);
            if (!nextSet) continue;
            for (const nxt of nextSet) {
                if (nxt === fromId) return true;
                if (!visited.has(nxt)) {
                    visited.add(nxt);
                    queue.push(nxt);
                }
            }
        }
        return false;
    };

    for (const newerBrick of brickNodes) {
        if (!Array.isArray(newerBrick.supersedes) || newerBrick.supersedes.length === 0) {
            continue;
        }
        for (const ref of newerBrick.supersedes) {
            const targetBrick = ref.includes('@')
                ? byCompositeRef.get(ref)
                : bySourceHash.get(ref);
            if (!targetBrick || newerBrick.id === targetBrick.id) {
                continue;
            }
            if (
                newerBrick.orgId &&
                targetBrick.orgId &&
                newerBrick.orgId !== targetBrick.orgId
            ) {
                continue;
            }
            if (createsSupersedesCycle(newerBrick.id, targetBrick.id)) {
                continue;
            }
            if (!supersedesOutMap.has(newerBrick.id)) {
                supersedesOutMap.set(newerBrick.id, new Set());
            }
            supersedesOutMap.get(newerBrick.id).add(targetBrick.id);

            targetBrick.isCurrent = false;
            targetBrick.supersededBy = newerBrick.id;
            if (!targetBrick.retiredAt) {
                targetBrick.retiredAt = newerBrick.validFrom || newerBrick.createdDate || null;
            }
            addEdge(newerBrick.id, targetBrick.id, 'SUPERSEDES');
        }
    }

    // Compile organization capability & channel profiles
    for (let idx = 0; idx < orgProfiles.length; idx += 1) {
        const profile = orgProfiles[idx];
        if (!isPlainObject(profile) || typeof profile.orgId !== 'string' || !profile.orgId.trim()) {
            return errorEnvelope(
                'INVALID_ORG_PROFILE',
                `orgProfiles[${idx}] must provide a non-empty orgId`,
                { index: idx },
                tool
            );
        }
        const cleanOrgId = scrubText(profile.orgId.trim());
        const orgVertexId = `org:${cleanOrgId}`;
        const orgStacks = Array.isArray(profile.stacks)
            ? profile.stacks.filter((s) => typeof s === 'string' && Object.hasOwn(ONTOLOGY_STACKS, s))
            : [];
        const orgChannels = Array.isArray(profile.channels)
            ? profile.channels.filter((c) => typeof c === 'string' && Object.hasOwn(ONTOLOGY_CHANNELS, c))
            : [];
        const orgRequiredPorts = Array.isArray(profile.requiredPorts)
            ? profile.requiredPorts.map((p) => parsePortReference(p)?.id).filter(Boolean)
            : [];
        const orgAvailablePorts = Array.isArray(profile.availablePorts)
            ? profile.availablePorts.map((p) => parsePortReference(p)?.id).filter(Boolean)
            : [];

        addNode({
            id: orgVertexId,
            surrogateId: surrogateOntologyVertexId(safeNamespace, orgVertexId),
            kind: 'org',
            orgId: cleanOrgId,
            title: scrubText(String(profile.name || profile.orgId)),
            summary: scrubText(String(profile.description || profile.summary || '')),
            stacks: orgStacks,
            channels: orgChannels,
            requiredPorts: orgRequiredPorts,
            availablePorts: orgAvailablePorts,
            isCurrent: true,
            validFrom: null,
            retiredAt: null,
            supersededBy: null,
        });

        for (const st of orgStacks) {
            addEdge(orgVertexId, `stack:${st}`, 'USES_STACK');
        }
        for (const ch of orgChannels) {
            addEdge(orgVertexId, `channel:${ch}`, 'LISTENS_CHANNEL');
        }
        for (const reqP of orgRequiredPorts) {
            const pNodeId = ensurePortVertex(reqP);
            if (pNodeId) addEdge(orgVertexId, pNodeId, 'REQUIRES_PORT');
        }
    }

    const nodes = Array.from(nodeMap.values());
    const activeBrickCount = brickNodes.filter((b) => b.isCurrent !== false).length;
    const retiredBrickCount = brickNodes.length - activeBrickCount;

    const stats = {
        totalNodes: nodes.length,
        totalEdges: edgeList.length,
        brickCount: brickNodes.length,
        activeBrickCount,
        retiredBrickCount,
        orgCount: orgProfiles.length,
        stackCount: nodes.filter((n) => n.kind === 'stack').length,
        portCount: nodes.filter((n) => n.kind === 'port').length,
        channelCount: nodes.filter((n) => n.kind === 'channel').length,
        moeProfileCount: nodes.filter((n) => n.kind === 'moe_profile').length,
    };

    return okEnvelope(
        tool,
        `Compiled ontology graph "${safeNamespace}" (${nodes.length} nodes, ${edgeList.length} edges)`,
        {
            namespace: safeNamespace,
            nodes,
            edges: edgeList,
            stats,
        }
    );
}

function unwrapCompiledGraph(graphInput) {
    if (isPlainObject(graphInput?.data) && Array.isArray(graphInput.data.nodes)) {
        return graphInput.data;
    }
    if (isPlainObject(graphInput) && Array.isArray(graphInput.nodes)) {
        return graphInput;
    }
    return null;
}

/**
 * Synchronize a compiled ontology property graph into a HydraScope / HydraDB OpenCypher client,
 * degrading gracefully to embedded graph fallback when unconfigured or unreachable (`INV-LEGO-36`).
 *
 * @param {object} graphInput
 * @param {{ hydraOpenCypherClient?: any, hydraClient?: any, graphId?: string | null }} [options={}]
 * @returns {Promise<ReturnType<typeof okEnvelope> | ReturnType<typeof errorEnvelope>>}
 */
export async function syncBrickOntologyToHydra(graphInput, options = {}) {
    const tool = 'brick-exchange.ontology.sync';
    const graph = unwrapCompiledGraph(graphInput);
    if (!graph || !Array.isArray(graph.edges)) {
        return errorEnvelope(
            'INVALID_ONTOLOGY_GRAPH',
            'Expected compiled ontology graph with nodes and edges arrays',
            null,
            tool
        );
    }

    const opts = isPlainObject(options) ? options : {};
    const client = opts.hydraOpenCypherClient || opts.hydraClient || null;
    const targetNamespace = String(opts.graphId || graph.namespace || 'brick-ontology');

    const isConfigured =
        Boolean(client) &&
        (typeof client.isConfigured !== 'function' || client.isConfigured() !== false);

    if (
        !isConfigured ||
        (typeof client.syncGraphSnapshot !== 'function' &&
            typeof client.query !== 'function' &&
            typeof client.executeCypher !== 'function')
    ) {
        return okEnvelope(
            tool,
            'Hydra OpenCypher client unconfigured; using embedded graph fallback',
            {
                liveSynced: false,
                mode: 'embedded_graph_fallback',
                namespace: targetNamespace,
                nodeCount: graph.nodes.length,
                edgeCount: graph.edges.length,
            }
        );
    }

    try {
        if (typeof client.syncGraphSnapshot === 'function') {
            const upstream = await client.syncGraphSnapshot({
                namespace: targetNamespace,
                nodes: graph.nodes,
                edges: graph.edges,
            });
            return okEnvelope(
                tool,
                `Synced ${graph.nodes.length} ontology nodes and ${graph.edges.length} edges via Hydra snapshot`,
                {
                    liveSynced: true,
                    mode: 'opencypher_snapshot',
                    namespace: targetNamespace,
                    nodeCount: graph.nodes.length,
                    edgeCount: graph.edges.length,
                    upstream: upstream ?? null,
                }
            );
        }

        const runCypher =
            typeof client.query === 'function'
                ? client.query.bind(client)
                : client.executeCypher.bind(client);

        let statementCount = 0;
        for (const node of graph.nodes) {
            await runCypher(
                'MERGE (n:Entity {id: $surrogateId, namespace: $ns, logicalId: $id, kind: $kind, title: $title, isCurrent: $isCurrent})',
                {
                    ns: targetNamespace,
                    id: node.id,
                    surrogateId: node.surrogateId,
                    kind: node.kind,
                    title: node.title || '',
                    isCurrent: node.isCurrent !== false,
                }
            );
            statementCount += 1;
        }

        const surrogateByLogical = new Map(graph.nodes.map((n) => [n.id, n.surrogateId]));
        for (const edge of graph.edges) {
            if (!SAFE_CYPHER_REL_RE.test(edge.type)) continue;
            const fromSurrogate =
                surrogateByLogical.get(edge.from) ??
                surrogateOntologyVertexId(targetNamespace, edge.from);
            const toSurrogate =
                surrogateByLogical.get(edge.to) ??
                surrogateOntologyVertexId(targetNamespace, edge.to);
            await runCypher(
                `MERGE (a:Entity {id: $fromId, namespace: $ns, logicalId: $from})-[r:${edge.type}]->(b:Entity {id: $toId, namespace: $ns, logicalId: $to})`,
                {
                    ns: targetNamespace,
                    fromId: fromSurrogate,
                    from: edge.from,
                    toId: toSurrogate,
                    to: edge.to,
                }
            );
            statementCount += 1;
        }

        return okEnvelope(
            tool,
            `Synced ${graph.nodes.length} ontology nodes and ${graph.edges.length} edges via OpenCypher MERGE`,
            {
                liveSynced: true,
                mode: 'opencypher_merge',
                namespace: targetNamespace,
                nodeCount: graph.nodes.length,
                edgeCount: graph.edges.length,
                statementCount,
            }
        );
    } catch (err) {
        return okEnvelope(
            tool,
            'Hydra OpenCypher endpoint unreachable; degraded to embedded graph fallback',
            {
                liveSynced: false,
                mode: 'embedded_graph_fallback',
                namespace: targetNamespace,
                nodeCount: graph.nodes.length,
                edgeCount: graph.edges.length,
                fallbackReason: scrubText(err instanceof Error ? err.message : 'sync_error'),
            }
        );
    }
}

function summarizeBrickVertex(node, bridgeMode) {
    return {
        id: node.id,
        brickId: node.brickId,
        sourceHash: node.sourceHash,
        title: node.title,
        summary: node.summary,
        orgId: node.orgId,
        stacks: Array.isArray(node.stacks) ? [...node.stacks] : [],
        consumesPorts: Array.isArray(node.consumesPorts) ? [...node.consumesPorts] : [],
        producesPorts: Array.isArray(node.producesPorts) ? [...node.producesPorts] : [],
        channels: Array.isArray(node.channels) ? [...node.channels] : [],
        moeProfile: node.moeProfile || null,
        validFrom: node.validFrom || null,
        retiredAt: node.retiredAt || null,
        bridgeMode,
    };
}

/**
 * Traverse a compiled ontology graph to discover 1-hop direct bricks and 2-hop port-compatible
 * pipelines while honoring `:SUPERSEDES` retirement and `asOf` temporal replay (`INV-LEGO-36`).
 *
 * Returns synchronously when no async `hydraOpenCypherClient` query is pending (also `await`-safe).
 *
 * @param {object} graphInput
 * @param {object} [options={}]
 */
export function traverseBrickOntology(graphInput, options = {}) {
    const tool = 'brick-exchange.ontology.traverse';
    const graph = unwrapCompiledGraph(graphInput);
    if (!graph || !Array.isArray(graph.edges)) {
        return errorEnvelope(
            'INVALID_ONTOLOGY_GRAPH',
            'Expected compiled ontology graph with nodes and edges arrays',
            null,
            tool
        );
    }

    if (!isPlainObject(options)) {
        return errorEnvelope('INVALID_TRAVERSE_OPTIONS', 'Options must be a plain object', null, tool);
    }

    const forbiddenOpt = hasForbiddenKeyRecursive(options);
    if (forbiddenOpt) {
        return errorEnvelope(
            'ONTOLOGY_FORBIDDEN_KEY',
            `Forbidden prototype-pollution key "${forbiddenOpt}" rejected`,
            { key: forbiddenOpt },
            tool
        );
    }

    const {
        targetStack = null,
        targetChannel = null,
        requiredPorts = [],
        availableInputPorts = [],
        asOf = null,
        maxHops = 2,
        hydraOpenCypherClient = null,
        hydraClient = null,
    } = options;

    if (
        targetStack !== null &&
        targetStack !== undefined &&
        targetStack !== '' &&
        (typeof targetStack !== 'string' ||
            FORBIDDEN_KEYS.has(targetStack) ||
            !Object.hasOwn(ONTOLOGY_STACKS, targetStack))
    ) {
        return errorEnvelope(
            'UNKNOWN_ONTOLOGY_STACK',
            `Unknown targetStack "${String(targetStack)}"`,
            { targetStack },
            tool
        );
    }

    if (
        targetChannel !== null &&
        targetChannel !== undefined &&
        targetChannel !== '' &&
        (typeof targetChannel !== 'string' ||
            FORBIDDEN_KEYS.has(targetChannel) ||
            !Object.hasOwn(ONTOLOGY_CHANNELS, targetChannel))
    ) {
        return errorEnvelope(
            'UNKNOWN_ONTOLOGY_CHANNEL',
            `Unknown targetChannel "${String(targetChannel)}"`,
            { targetChannel },
            tool
        );
    }

    let normalizedAsOf = null;
    if (asOf !== null && asOf !== undefined && asOf !== '') {
        normalizedAsOf = normalizeIsoDateString(asOf);
        if (!normalizedAsOf) {
            return errorEnvelope(
                'INVALID_AS_OF_DATE',
                `Invalid asOf date "${String(asOf)}"; expected YYYY-MM-DD`,
                { asOf },
                tool
            );
        }
    }

    const parsedRequiredPorts = [];
    if (Array.isArray(requiredPorts)) {
        for (const rp of requiredPorts) {
            const parsed = parsePortReference(rp);
            if (!parsed) {
                return errorEnvelope(
                    'INVALID_ONTOLOGY_PORT',
                    `Invalid requiredPorts entry "${String(rp)}"`,
                    { port: rp },
                    tool
                );
            }
            parsedRequiredPorts.push(parsed);
        }
    }

    const parsedAvailablePorts = [];
    if (Array.isArray(availableInputPorts)) {
        for (const ap of availableInputPorts) {
            const parsed = parsePortReference(ap);
            if (!parsed) {
                return errorEnvelope(
                    'INVALID_ONTOLOGY_PORT',
                    `Invalid availableInputPorts entry "${String(ap)}"`,
                    { port: ap },
                    tool
                );
            }
            parsedAvailablePorts.push(parsed);
        }
    }

    const allBricks = graph.nodes.filter((n) => n && n.kind === 'brick');
    const activeBricks = [];
    const retiredSupersededBricks = [];

    for (const b of allBricks) {
        const vFrom = typeof b.validFrom === 'string' && b.validFrom ? b.validFrom.slice(0, 10) : null;
        const rAt = typeof b.retiredAt === 'string' && b.retiredAt ? b.retiredAt.slice(0, 10) : null;

        let active;
        if (normalizedAsOf !== null) {
            active = (!vFrom || vFrom <= normalizedAsOf) && (!rAt || rAt > normalizedAsOf);
        } else {
            active = b.isCurrent !== false;
        }

        if (active) {
            activeBricks.push(b);
        } else {
            retiredSupersededBricks.push({
                id: b.id,
                brickId: b.brickId,
                sourceHash: b.sourceHash,
                title: b.title,
                validFrom: vFrom,
                retiredAt: rAt,
                supersededBy: b.supersededBy || null,
            });
        }
    }

    const resolveStackBridgeMode = (brickNode) => {
        if (!targetStack) return 'native';
        const stacks = Array.isArray(brickNode.stacks) ? brickNode.stacks : [];
        if (stacks.includes(targetStack)) return 'native';
        if (targetStack === 'python-fastapi') return 'contract-adapter';
        return null;
    };

    const stackEligible = [];
    for (const brickNode of activeBricks) {
        const bridgeMode = resolveStackBridgeMode(brickNode);
        if (bridgeMode !== null) {
            stackEligible.push({ node: brickNode, bridgeMode });
        }
    }

    const hasChannelFilter = Boolean(targetChannel);
    const hasRequiredPortsFilter = parsedRequiredPorts.length > 0;

    const directMatches = [];
    for (const { node, bridgeMode } of stackEligible) {
        const channels = Array.isArray(node.channels) ? node.channels : [];
        const produces = Array.isArray(node.producesPorts) ? node.producesPorts : [];

        const matchedChannel = hasChannelFilter && channels.includes(targetChannel);
        const matchedRequiredPorts = parsedRequiredPorts
            .filter((reqP) => produces.some((prodP) => arePortsCompatible(prodP, reqP)))
            .map((p) => p.id);

        if (!hasChannelFilter && !hasRequiredPortsFilter) {
            directMatches.push({
                ...summarizeBrickVertex(node, bridgeMode),
                matchedChannel: false,
                matchedRequiredPorts: [],
                score: 1,
            });
            continue;
        }

        if (matchedChannel || matchedRequiredPorts.length > 0) {
            const score =
                (matchedChannel ? 2 : 0) + matchedRequiredPorts.length * 2 + (bridgeMode === 'native' ? 0.5 : 0);
            directMatches.push({
                ...summarizeBrickVertex(node, bridgeMode),
                matchedChannel,
                matchedRequiredPorts,
                score,
            });
        }
    }

    directMatches.sort((a, b) => b.score - a.score || a.brickId.localeCompare(b.brickId));

    const compositions = [];
    const effectiveMaxHops = Number.isFinite(Number(maxHops)) ? Math.trunc(Number(maxHops)) : 2;

    if (effectiveMaxHops >= 2) {
        const hasStage1EntryConstraint = hasChannelFilter || parsedAvailablePorts.length > 0;

        for (let i = 0; i < stackEligible.length; i += 1) {
            const stage1 = stackEligible[i];
            const s1Channels = Array.isArray(stage1.node.channels) ? stage1.node.channels : [];
            const s1Consumes = Array.isArray(stage1.node.consumesPorts) ? stage1.node.consumesPorts : [];
            const s1Produces = Array.isArray(stage1.node.producesPorts) ? stage1.node.producesPorts : [];

            if (s1Produces.length === 0) continue;

            if (hasStage1EntryConstraint) {
                const bridgesTargetChannel = hasChannelFilter && s1Channels.includes(targetChannel);
                const consumesAvailableInput =
                    parsedAvailablePorts.length > 0 &&
                    s1Consumes.some((cPort) =>
                        parsedAvailablePorts.some((availP) => arePortsCompatible(availP, cPort))
                    );
                if (!bridgesTargetChannel && !consumesAvailableInput) {
                    continue;
                }
            }

            for (let j = 0; j < stackEligible.length; j += 1) {
                if (i === j) continue;
                const stage2 = stackEligible[j];
                if (stage1.node.brickId === stage2.node.brickId) continue;

                const s2Consumes = Array.isArray(stage2.node.consumesPorts) ? stage2.node.consumesPorts : [];
                const s2Produces = Array.isArray(stage2.node.producesPorts) ? stage2.node.producesPorts : [];
                if (s2Consumes.length === 0) continue;

                const bridgedPorts = [];
                for (const p1 of s1Produces) {
                    for (const p2 of s2Consumes) {
                        if (arePortsCompatible(p1, p2)) {
                            const normPort = parsePortReference(p1)?.id || p1;
                            if (!bridgedPorts.includes(normPort)) {
                                bridgedPorts.push(normPort);
                            }
                        }
                    }
                }
                if (bridgedPorts.length === 0) continue;

                let satisfiedRequiredPorts = [];
                if (hasRequiredPortsFilter) {
                    satisfiedRequiredPorts = parsedRequiredPorts
                        .filter((reqP) => s2Produces.some((prodP) => arePortsCompatible(prodP, reqP)))
                        .map((p) => p.id);
                    if (satisfiedRequiredPorts.length === 0) {
                        continue;
                    }
                }

                const s1Summary = summarizeBrickVertex(stage1.node, stage1.bridgeMode);
                const s2Summary = summarizeBrickVertex(stage2.node, stage2.bridgeMode);
                compositions.push({
                    id: `${stage1.node.brickId}->${bridgedPorts[0]}->${stage2.node.brickId}`,
                    stages: [s1Summary, s2Summary],
                    stage1: s1Summary,
                    stage2: s2Summary,
                    bridgePort: bridgedPorts[0],
                    bridgePorts: bridgedPorts,
                    satisfiedRequiredPorts,
                    targetStack: targetStack || null,
                });
            }
        }
    }

    const finalizeEnvelope = (hydraBackend) =>
        okEnvelope(
            tool,
            `Traversed ${activeBricks.length} active brick(s): ${directMatches.length} direct match(es), ${compositions.length} 2-hop composition(s)`,
            {
                activeBrickCount: activeBricks.length,
                retiredBrickCount: retiredSupersededBricks.length,
                directMatches,
                compositions,
                retiredSupersededBricks,
                hydraBackend,
            }
        );

    const client = hydraOpenCypherClient || hydraClient || null;
    const isClientActive =
        Boolean(client) &&
        (typeof client.isConfigured !== 'function' || client.isConfigured() !== false) &&
        (typeof client.query === 'function' || typeof client.executeCypher === 'function');

    if (!isClientActive) {
        return finalizeEnvelope('embedded_bfs');
    }

    const runCypher =
        typeof client.query === 'function'
            ? client.query.bind(client)
            : client.executeCypher.bind(client);

    try {
        const probeResult = runCypher(
            'MATCH (b:Entity {kind: $kind}) RETURN b.id AS id LIMIT 64',
            { kind: 'brick' }
        );
        if (probeResult && typeof probeResult.then === 'function') {
            return probeResult.then(
                () => finalizeEnvelope('opencypher_live'),
                () => finalizeEnvelope('embedded_bfs')
            );
        }
        return finalizeEnvelope('opencypher_live');
    } catch {
        return finalizeEnvelope('embedded_bfs');
    }
}

function normalizeComparisonToken(name) {
    return String(name || '')
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '')
        .trim();
}

function extractTargetSchemaInfo(rawInputSchema) {
    if (!rawInputSchema || typeof rawInputSchema !== 'object') {
        return {
            itemProperties: {},
            additionalProperties: true,
            isArrayInput: false,
        };
    }
    let jsonSchema = rawInputSchema;
    if (typeof rawInputSchema.toJsonSchema === 'function' || typeof rawInputSchema.safeParse === 'function') {
        try {
            jsonSchema = toJsonSchema(rawInputSchema);
        } catch {
            jsonSchema = rawInputSchema;
        }
    }

    if (jsonSchema?.type === 'array' && isPlainObject(jsonSchema.items)) {
        return {
            itemProperties: isPlainObject(jsonSchema.items.properties) ? jsonSchema.items.properties : {},
            additionalProperties: jsonSchema.items.additionalProperties !== false,
            isArrayInput: true,
        };
    }
    if (jsonSchema?.type === 'object') {
        return {
            itemProperties: isPlainObject(jsonSchema.properties) ? jsonSchema.properties : {},
            additionalProperties: jsonSchema.additionalProperties !== false,
            isArrayInput: false,
        };
    }
    return {
        itemProperties: {},
        additionalProperties: true,
        isArrayInput: false,
    };
}

function collectSampleObjects(localSample) {
    if (Array.isArray(localSample)) {
        return localSample.filter((item) => isPlainObject(item));
    }
    if (isPlainObject(localSample)) {
        return [localSample];
    }
    return [];
}

function detectHeaderUnitRow(localSample) {
    if (!Array.isArray(localSample) || localSample.length < 2) {
        return false;
    }
    const row0 = localSample[0];
    const row1 = localSample[1];
    if (!isPlainObject(row0) || !isPlainObject(row1)) {
        return false;
    }
    let sawHeaderStringVsNumber = false;
    for (const key of Object.keys(row0)) {
        if (FORBIDDEN_KEYS.has(key)) continue;
        const v0 = row0[key];
        const v1 = row1[key];
        if (
            typeof v0 === 'string' &&
            v0.trim().length > 0 &&
            Number.isNaN(Number(v0)) &&
            typeof v1 === 'number' &&
            Number.isFinite(v1)
        ) {
            sawHeaderStringVsNumber = true;
        }
    }
    return sawHeaderStringVsNumber;
}

function inferDeterministicFieldMap({
    explicitFieldMap = {},
    localSample = undefined,
    schemaProperties = {},
    consumesPorts = [],
}) {
    const resolved = {};
    for (const key of Object.keys(explicitFieldMap)) {
        if (FORBIDDEN_KEYS.has(key)) continue;
        const val = explicitFieldMap[key];
        if (typeof val === 'string' && val.trim() && !FORBIDDEN_KEYS.has(val.trim())) {
            defineSafeProp(resolved, key, val.trim());
        }
    }

    const sampleObjects = collectSampleObjects(localSample);
    const observedKeys = [];
    const seenObserved = new Set();
    for (const obj of sampleObjects) {
        for (const k of Object.keys(obj)) {
            if (!FORBIDDEN_KEYS.has(k) && !seenObserved.has(k)) {
                seenObserved.add(k);
                observedKeys.push(k);
            }
        }
    }
    if (observedKeys.length === 0) {
        return resolved;
    }

    const orderedPortDescriptors = [];
    const addedPortIds = new Set();
    for (const portRef of consumesPorts) {
        const parsed = parsePortReference(portRef);
        if (parsed && parsed.shared && Object.hasOwn(ONTOLOGY_DATA_PORTS, parsed.bareName)) {
            addedPortIds.add(parsed.bareName);
            orderedPortDescriptors.push(ONTOLOGY_DATA_PORTS[parsed.bareName]);
        }
    }
    for (const [portId, desc] of Object.entries(ONTOLOGY_DATA_PORTS)) {
        if (!addedPortIds.has(portId)) {
            orderedPortDescriptors.push(desc);
        }
    }

    const targetFields = new Set(Object.keys(schemaProperties).filter((k) => !FORBIDDEN_KEYS.has(k)));
    if (targetFields.size === 0) {
        for (const portRef of consumesPorts) {
            const parsed = parsePortReference(portRef);
            if (parsed && parsed.shared && Object.hasOwn(ONTOLOGY_DATA_PORTS, parsed.bareName)) {
                const desc = ONTOLOGY_DATA_PORTS[parsed.bareName];
                for (const field of Object.keys(desc.fieldAliases)) {
                    targetFields.add(field);
                }
            }
        }
    }

    const usedLocalKeys = new Set(Object.values(resolved));

    for (const canonicalField of targetFields) {
        if (Object.hasOwn(resolved, canonicalField)) continue;

        if (seenObserved.has(canonicalField) && !usedLocalKeys.has(canonicalField)) {
            defineSafeProp(resolved, canonicalField, canonicalField);
            usedLocalKeys.add(canonicalField);
            continue;
        }

        const normTarget = normalizeComparisonToken(canonicalField);
        const caseMatch = observedKeys.find(
            (k) => !usedLocalKeys.has(k) && normalizeComparisonToken(k) === normTarget
        );
        if (caseMatch) {
            defineSafeProp(resolved, canonicalField, caseMatch);
            usedLocalKeys.add(caseMatch);
            continue;
        }

        let matchedLocal = null;
        for (const desc of orderedPortDescriptors) {
            for (const [aliasCanonical, synonyms] of Object.entries(desc.fieldAliases)) {
                const ringMatchesTarget =
                    normalizeComparisonToken(aliasCanonical) === normTarget ||
                    synonyms.some((syn) => normalizeComparisonToken(syn) === normTarget);
                if (!ringMatchesTarget) continue;

                const synTokens = new Set([
                    normalizeComparisonToken(aliasCanonical),
                    ...synonyms.map((s) => normalizeComparisonToken(s)),
                ]);
                const candidateKey = observedKeys.find(
                    (k) => !usedLocalKeys.has(k) && synTokens.has(normalizeComparisonToken(k))
                );
                if (candidateKey) {
                    matchedLocal = candidateKey;
                    break;
                }
            }
            if (matchedLocal) break;
        }

        if (matchedLocal) {
            defineSafeProp(resolved, canonicalField, matchedLocal);
            usedLocalKeys.add(matchedLocal);
        }
    }

    return resolved;
}

/**
 * Transform a single local record or array of local records into the brick's canonical schema
 * using `fieldMap` (`{ canonicalField: localField }`) without mutating caller inputs (`INV-LEGO-36`).
 *
 * @param {unknown} sample
 * @param {Record<string, string>} [fieldMap={}]
 * @param {{ schemaProperties?: Record<string, any>, additionalProperties?: boolean, skipHeaderRow?: boolean }} [options={}]
 * @returns {unknown}
 */
export function applyFieldMapToSample(sample, fieldMap = {}, options = {}) {
    const safeMap = isPlainObject(fieldMap) ? fieldMap : {};
    const opts = isPlainObject(options) ? options : {};
    const schemaProperties = isPlainObject(opts.schemaProperties) ? opts.schemaProperties : {};
    const allowAdditional = opts.additionalProperties !== false;
    const skipHeaderRow = opts.skipHeaderRow === true;
    const hasSchemaKeys = Object.keys(schemaProperties).length > 0;

    const consumedSourceKeys = new Set();
    for (const [canonicalKey, sourceKey] of Object.entries(safeMap)) {
        if (FORBIDDEN_KEYS.has(canonicalKey) || FORBIDDEN_KEYS.has(sourceKey)) continue;
        consumedSourceKeys.add(sourceKey);
    }

    const transformRecord = (record, rowIndex) => {
        if (!isPlainObject(record)) return record;
        const out = {};

        for (const [canonicalKey, sourceKey] of Object.entries(safeMap)) {
            if (FORBIDDEN_KEYS.has(canonicalKey) || FORBIDDEN_KEYS.has(sourceKey)) continue;
            if (Object.hasOwn(record, sourceKey)) {
                let value = record[sourceKey];
                const propSchema = schemaProperties[canonicalKey];
                if (
                    rowIndex === 0 &&
                    skipHeaderRow &&
                    (propSchema?.type === 'number' || propSchema?.type === 'integer') &&
                    typeof value === 'string'
                ) {
                    const parsedNum = Number(value);
                    value = Number.isFinite(parsedNum) ? parsedNum : 0;
                }
                defineSafeProp(out, canonicalKey, value);
            }
        }

        for (const key of Object.keys(record)) {
            if (FORBIDDEN_KEYS.has(key)) continue;
            if (consumedSourceKeys.has(key)) continue;
            if (Object.hasOwn(out, key)) continue;
            if (!allowAdditional && hasSchemaKeys && !Object.hasOwn(schemaProperties, key)) {
                continue;
            }
            defineSafeProp(out, key, record[key]);
        }

        return out;
    };

    if (Array.isArray(sample)) {
        return sample.map((item, idx) => transformRecord(item, idx));
    }
    if (isPlainObject(sample)) {
        return transformRecord(sample, -1);
    }
    return sample;
}

function renderJsOrTsAdapterSource({
    brickId,
    sourceHash,
    targetStack,
    fieldMap,
    bindingConfig,
    schemaProperties,
    additionalProperties,
}) {
    const isTs = targetStack === 'typescript-node';
    const numericFields = Object.entries(schemaProperties || {})
        .filter(([, desc]) => desc?.type === 'number' || desc?.type === 'integer')
        .map(([k]) => k);
    const allowedKeys = Object.keys(schemaProperties || {});
    const stripUnknown = additionalProperties === false && allowedKeys.length > 0;

    const fieldMapJson = JSON.stringify(fieldMap, null, 2);
    const bindingJson = JSON.stringify(bindingConfig, null, 2);
    const numericFieldsJson = JSON.stringify(numericFields);
    const allowedKeysJson = JSON.stringify(allowedKeys);

    const header = [
        `/**`,
        ` * Generated Hexagonal Binding Adapter for sealed brick "${brickId}" (@${sourceHash.slice(0, 12)})`,
        ` * Target stack: ${targetStack}`,
        ` * Zero external dependencies; safe across Node 22, Vite, and Cloudflare Workers.`,
        ` */`,
        ``,
    ].join('\n');

    if (isTs) {
        return `${header}export const FIELD_MAP: Readonly<Record<string, string>> = Object.freeze(${fieldMapJson});

export const binding: Readonly<Record<string, unknown>> = Object.freeze(${bindingJson});

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const NUMERIC_HEADER_FIELDS = new Set<string>(${numericFieldsJson});
const ALLOWED_SCHEMA_KEYS = new Set<string>(${allowedKeysJson});
const STRIP_UNKNOWN_KEYS = ${stripUnknown ? 'true' : 'false'};

function adaptRecord(record: unknown, rowIndex: number): unknown {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    return record;
  }
  const src = record as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const mappedSources = new Set<string>(Object.values(FIELD_MAP));

  for (const [canonicalKey, localKey] of Object.entries(FIELD_MAP)) {
    if (FORBIDDEN_KEYS.has(canonicalKey) || FORBIDDEN_KEYS.has(localKey)) continue;
    if (Object.hasOwn(src, localKey)) {
      let val = src[localKey];
      if (rowIndex === 0 && Boolean(binding.skipHeaderRow) && NUMERIC_HEADER_FIELDS.has(canonicalKey) && typeof val === 'string') {
        const parsed = Number(val);
        val = Number.isFinite(parsed) ? parsed : 0;
      }
      out[canonicalKey] = val;
    }
  }

  for (const key of Object.keys(src)) {
    if (FORBIDDEN_KEYS.has(key) || mappedSources.has(key) || Object.hasOwn(out, key)) continue;
    if (STRIP_UNKNOWN_KEYS && !ALLOWED_SCHEMA_KEYS.has(key)) continue;
    out[key] = src[key];
  }

  return out;
}

export function adaptInput<T = unknown>(rawInput: T): unknown {
  if (Array.isArray(rawInput)) {
    return rawInput.map((row, idx) => adaptRecord(row, idx));
  }
  return adaptRecord(rawInput, -1);
}

export function invokeBoundBrick<TOut = unknown>(
  brickFn: (input: unknown, bindingConfig?: Record<string, unknown>) => TOut,
  rawInput: unknown,
  extraBinding: Record<string, unknown> = {}
): TOut {
  return brickFn(adaptInput(rawInput), { ...binding, ...extraBinding });
}
`;
    }

    return `${header}export const FIELD_MAP = Object.freeze(${fieldMapJson});

export const binding = Object.freeze(${bindingJson});

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const NUMERIC_HEADER_FIELDS = new Set(${numericFieldsJson});
const ALLOWED_SCHEMA_KEYS = new Set(${allowedKeysJson});
const STRIP_UNKNOWN_KEYS = ${stripUnknown ? 'true' : 'false'};

function adaptRecord(record, rowIndex) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    return record;
  }
  const out = {};
  const mappedSources = new Set(Object.values(FIELD_MAP));

  for (const [canonicalKey, localKey] of Object.entries(FIELD_MAP)) {
    if (FORBIDDEN_KEYS.has(canonicalKey) || FORBIDDEN_KEYS.has(localKey)) continue;
    if (Object.hasOwn(record, localKey)) {
      let val = record[localKey];
      if (rowIndex === 0 && Boolean(binding.skipHeaderRow) && NUMERIC_HEADER_FIELDS.has(canonicalKey) && typeof val === 'string') {
        const parsed = Number(val);
        val = Number.isFinite(parsed) ? parsed : 0;
      }
      out[canonicalKey] = val;
    }
  }

  for (const key of Object.keys(record)) {
    if (FORBIDDEN_KEYS.has(key) || mappedSources.has(key) || Object.hasOwn(out, key)) continue;
    if (STRIP_UNKNOWN_KEYS && !ALLOWED_SCHEMA_KEYS.has(key)) continue;
    out[key] = record[key];
  }

  return out;
}

export function adaptInput(rawInput) {
  if (Array.isArray(rawInput)) {
    return rawInput.map((row, idx) => adaptRecord(row, idx));
  }
  return adaptRecord(rawInput, -1);
}

export function invokeBoundBrick(brickFn, rawInput, extraBinding = {}) {
  return brickFn(adaptInput(rawInput), { ...binding, ...extraBinding });
}
`;
}

function toPythonLiteral(value, indentLevel = 0, seen = new WeakSet()) {
    if (indentLevel > 24) {
        throw new RangeError('Maximum nesting depth (24) exceeded in toPythonLiteral');
    }
    if (value === null || value === undefined) return 'None';
    if (typeof value === 'boolean') return value ? 'True' : 'False';
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'None';
    if (typeof value === 'string') return JSON.stringify(value);
    if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') {
        throw new TypeError(`Unsupported non-JSON ${typeof value} value in toPythonLiteral`);
    }
    if (typeof value === 'object') {
        if (seen.has(value)) {
            throw new TypeError('Circular reference detected in toPythonLiteral');
        }
        seen.add(value);
        try {
            const pad = '    '.repeat(indentLevel);
            const innerPad = '    '.repeat(indentLevel + 1);
            if (Array.isArray(value)) {
                if (value.length === 0) return '[]';
                const items = value.map(
                    (v) => `${innerPad}${toPythonLiteral(v, indentLevel + 1, seen)}`
                );
                return `[\n${items.join(',\n')},\n${pad}]`;
            }
            if (isPlainObject(value)) {
                const keys = Object.keys(value).filter(
                    (k) => !FORBIDDEN_KEYS.has(k) && value[k] !== undefined
                );
                if (keys.length === 0) return '{}';
                const pairs = keys.map(
                    (k) =>
                        `${innerPad}${JSON.stringify(k)}: ${toPythonLiteral(value[k], indentLevel + 1, seen)}`
                );
                return `{\n${pairs.join(',\n')},\n${pad}}`;
            }
        } finally {
            seen.delete(value);
        }
    }
    throw new TypeError('Unsupported non-plain object in toPythonLiteral');
}

function renderPythonFastApiAdapterSource({
    brickId,
    sourceHash,
    fieldMap,
    bindingConfig,
    schemaProperties,
    additionalProperties,
}) {
    const numericFields = Object.entries(schemaProperties || {})
        .filter(([, desc]) => desc?.type === 'number' || desc?.type === 'integer')
        .map(([k]) => k);
    const allowedKeys = Object.keys(schemaProperties || {});
    const stripUnknown = additionalProperties === false && allowedKeys.length > 0;

    return `"""Generated Hexagonal Contract Adapter for sealed brick ${JSON.stringify(brickId)}.

Target stack: python-fastapi (Python 3.11+ pure stdlib).
Normalizes Pydantic v2 models, SQLAlchemy row mappings, or plain dicts to the sealed brick contract.
"""

from __future__ import annotations

from typing import Any, Mapping

BRICK_ID: str = ${JSON.stringify(brickId)}
SOURCE_HASH: str = ${JSON.stringify(sourceHash)}

FIELD_MAP: dict[str, str] = ${toPythonLiteral(fieldMap, 0)}

BINDING_CONFIG: dict[str, Any] = ${toPythonLiteral(bindingConfig, 0)}

_FORBIDDEN_KEYS: frozenset[str] = frozenset({"__proto__", "constructor", "prototype"})
_NUMERIC_HEADER_FIELDS: frozenset[str] = frozenset(${toPythonLiteral(numericFields, 0)})
_ALLOWED_SCHEMA_KEYS: frozenset[str] = frozenset(${toPythonLiteral(allowedKeys, 0)})
_STRIP_UNKNOWN_KEYS: bool = ${stripUnknown ? 'True' : 'False'}


def _coerce_mapping(item: Any) -> Mapping[str, Any] | None:
    if hasattr(item, "model_dump") and callable(item.model_dump):
        dumped = item.model_dump()
        if isinstance(dumped, Mapping):
            return dumped
    if isinstance(item, Mapping):
        return item
    return None


def _adapt_record(record: Any, row_index: int) -> Any:
    mapping = _coerce_mapping(record)
    if mapping is None:
        return record

    out: dict[str, Any] = {}
    mapped_sources = set(FIELD_MAP.values())
    skip_header = bool(BINDING_CONFIG.get("skipHeaderRow", False))

    for canonical_key, local_key in FIELD_MAP.items():
        if canonical_key in _FORBIDDEN_KEYS or local_key in _FORBIDDEN_KEYS:
            continue
        if local_key in mapping:
            val = mapping[local_key]
            if (
                row_index == 0
                and skip_header
                and canonical_key in _NUMERIC_HEADER_FIELDS
                and isinstance(val, str)
            ):
                try:
                    val = float(val)
                except ValueError:
                    val = 0
            out[canonical_key] = val

    for key, val in mapping.items():
        if not isinstance(key, str):
            continue
        if key in _FORBIDDEN_KEYS or key in mapped_sources or key in out:
            continue
        if _STRIP_UNKNOWN_KEYS and key not in _ALLOWED_SCHEMA_KEYS:
            continue
        out[key] = val

    return out


def adapt_input(raw_input: Any) -> Any:
    """Adapt a local record or sequence of records to the brick's canonical input contract."""
    if isinstance(raw_input, (list, tuple)):
        return [_adapt_record(row, idx) for idx, row in enumerate(raw_input)]
    return _adapt_record(raw_input, -1)


def build_mcp_or_http_payload(
    raw_input: Any,
    extra_binding: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Build a canonical JSON envelope ready for hexagonal MCP or HTTP brick invocation."""
    merged_binding: dict[str, Any] = dict(BINDING_CONFIG)
    if extra_binding is not None:
        for key, val in extra_binding.items():
            if isinstance(key, str) and key not in _FORBIDDEN_KEYS:
                merged_binding[key] = val
    return {
        "brickId": BRICK_ID,
        "sourceHash": SOURCE_HASH,
        "input": adapt_input(raw_input),
        "binding": merged_binding,
    }
`;
}

function validateJsonSerializableBinding(
    value,
    depth = 0,
    seen = new WeakSet(),
    pathStr = 'bindingOverrides'
) {
    if (value === null || value === undefined) {
        return { ok: true };
    }
    const valType = typeof value;
    if (valType === 'boolean' || valType === 'string') {
        return { ok: true };
    }
    if (valType === 'number') {
        if (!Number.isFinite(value)) {
            return {
                ok: false,
                path: pathStr,
                reason: `Non-finite number (${String(value)}) is not JSON-serializable at ${pathStr}`,
            };
        }
        return { ok: true };
    }
    if (valType === 'bigint' || valType === 'function' || valType === 'symbol') {
        return {
            ok: false,
            path: pathStr,
            reason: `Non-JSON ${valType} value rejected at ${pathStr}`,
        };
    }
    if (valType === 'object') {
        if (seen.has(value)) {
            return {
                ok: false,
                path: pathStr,
                reason: `Circular reference rejected at ${pathStr}`,
            };
        }
        if (depth > 24) {
            return {
                ok: false,
                path: pathStr,
                reason: `Maximum nesting depth (24) exceeded at ${pathStr}`,
            };
        }
        if (!Array.isArray(value) && !isPlainObject(value)) {
            return {
                ok: false,
                path: pathStr,
                reason: `Non-plain object instance rejected at ${pathStr}`,
            };
        }
        if (Object.getOwnPropertySymbols(value).length > 0) {
            return {
                ok: false,
                path: pathStr,
                reason: `Symbol-keyed properties rejected at ${pathStr}`,
            };
        }
        seen.add(value);
        try {
            if (Array.isArray(value)) {
                for (let i = 0; i < value.length; i += 1) {
                    if (value[i] === undefined) {
                        return {
                            ok: false,
                            path: `${pathStr}[${i}]`,
                            reason: `Undefined array element rejected at ${pathStr}[${i}]`,
                        };
                    }
                    const nested = validateJsonSerializableBinding(
                        value[i],
                        depth + 1,
                        seen,
                        `${pathStr}[${i}]`
                    );
                    if (!nested.ok) return nested;
                }
                return { ok: true };
            }
            const ownNames = Object.getOwnPropertyNames(value);
            for (let i = 0; i < ownNames.length; i += 1) {
                const key = ownNames[i];
                if (FORBIDDEN_KEYS.has(key)) {
                    return {
                        ok: false,
                        forbiddenKey: key,
                        path: `${pathStr}.${key}`,
                        reason: `Forbidden prototype key "${key}" rejected at ${pathStr}.${key}`,
                    };
                }
                if (value[key] === undefined) continue;
                const nested = validateJsonSerializableBinding(
                    value[key],
                    depth + 1,
                    seen,
                    `${pathStr}.${key}`
                );
                if (!nested.ok) return nested;
            }
            return { ok: true };
        } finally {
            seen.delete(value);
        }
    }
    return {
        ok: false,
        path: pathStr,
        reason: `Unsupported value rejected at ${pathStr}`,
    };
}

function sanitizeBindingObject(rawObj) {
    const out = {};
    if (!isPlainObject(rawObj)) return out;
    for (const key of Object.keys(rawObj)) {
        if (FORBIDDEN_KEYS.has(key) || rawObj[key] === undefined) continue;
        defineSafeProp(out, key, rawObj[key]);
    }
    return out;
}

function buildRepairCascadeChain(moeProfileId, boundedRepairMax) {
    const profile =
        (moeProfileId && Object.hasOwn(ONTOLOGY_MOE_PROFILES, moeProfileId)
            ? ONTOLOGY_MOE_PROFILES[moeProfileId]
            : null) || ONTOLOGY_MOE_PROFILES['cross-stack-schema-adapter'];

    const complexityScore =
        profile.recommendedCascadeTier === 'L2_HEAVY_MOE'
            ? 0.6
            : profile.recommendedCascadeTier === 'L3_FRONTIER_ARGON'
              ? 0.95
              : 0.2;

    const sel = selectCascadeTier({
        complexityScore,
        requiresTools: true,
        allowFrontier: profile.fallbackChain.includes('L3_FRONTIER_ARGON'),
        tiers: DEFAULT_FLEET_CASCADE_TIERS,
    });

    const baseTiers = sel.ok && sel.data.candidateChain.length > 0
        ? sel.data.candidateChain
        : DEFAULT_FLEET_CASCADE_TIERS.filter((t) => !t.isBurst && !t.isFrontier);

    const schedule = [];
    for (let idx = 0; idx < boundedRepairMax; idx += 1) {
        const tierDesc = baseTiers[Math.min(idx, baseTiers.length - 1)];
        schedule.push(
            Object.freeze({
                ...tierDesc,
                id: `${tierDesc.id}#attempt_${idx + 1}`,
                canonicalTierId: tierDesc.id,
            })
        );
    }
    return schedule;
}

/**
 * Synthesize a zero-upload cross-stack Hexagonal `binding` adapter (`binding.js`, `binding.ts`, or
 * `binding_adapter.py`), infer `$0` field-alias mappings & header-row settings from `localSample`,
 * and verify locally inside `tryBrickLocally` with `@krusch/toolkit/cascade` (`executeWithCascadeFallback`)
 * MoE `repairFn` escalation (`L1_FAST` `gemma4:e4b` -> `L2_HEAVY_MOE` `qwen3-coder-30b-moe:latest`) (`INV-LEGO-36`).
 *
 * @param {object} [options={}]
 * @returns {Promise<ReturnType<typeof okEnvelope> | ReturnType<typeof errorEnvelope>>}
 */
export async function synthesizeBrickBinding(options = {}) {
    const tool = 'brick-exchange.ontology.bind';
    if (!isPlainObject(options)) {
        return errorEnvelope('INVALID_BINDING_OPTIONS', 'Options must be a plain object', null, tool);
    }

    if (options.bindingOverrides !== undefined) {
        if (!isPlainObject(options.bindingOverrides)) {
            return errorEnvelope(
                'INVALID_BINDING_OVERRIDES',
                'bindingOverrides must be a plain JSON-serializable object',
                null,
                tool
            );
        }
        const bindingValid = validateJsonSerializableBinding(
            options.bindingOverrides,
            0,
            new WeakSet(),
            'bindingOverrides'
        );
        if (!bindingValid.ok) {
            if (bindingValid.forbiddenKey) {
                return errorEnvelope(
                    'ONTOLOGY_FORBIDDEN_KEY',
                    bindingValid.reason,
                    { key: bindingValid.forbiddenKey },
                    tool
                );
            }
            return errorEnvelope(
                'INVALID_BINDING_OVERRIDES',
                bindingValid.reason,
                { path: bindingValid.path },
                tool
            );
        }
    }

    const forbiddenOpt = hasForbiddenKeyRecursive(options);
    if (forbiddenOpt) {
        return errorEnvelope(
            'ONTOLOGY_FORBIDDEN_KEY',
            `Forbidden prototype-pollution key "${forbiddenOpt}" rejected`,
            { key: forbiddenOpt },
            tool
        );
    }

    const {
        bundle,
        targetStack = 'node-esm',
        localSample = undefined,
        fieldMap = {},
        bindingOverrides = {},
        repairFn = null,
        maxRepairAttempts = 2,
        timeoutMs,
        maxMemoryMb,
    } = options;

    if (!isPlainObject(fieldMap) || !isPlainObject(bindingOverrides)) {
        return errorEnvelope(
            'INVALID_BINDING_OPTIONS',
            'fieldMap and bindingOverrides must be plain objects',
            null,
            tool
        );
    }

    const sealCheck = verifyBrickBundle(bundle);
    if (!sealCheck || !sealCheck.ok) {
        return errorEnvelope(
            sealCheck?.error?.code || 'INVALID_BRICK_BUNDLE',
            sealCheck?.error?.message || 'Sealed brick bundle verification failed',
            sealCheck?.error?.details ?? null,
            tool
        );
    }

    const compatRes = checkOntologyCompatibility({
        bundle,
        targetStack,
    });
    if (!compatRes.ok) {
        return errorEnvelope(
            compatRes.error.code,
            compatRes.error.message,
            compatRes.error.details ?? null,
            tool
        );
    }

    const { bridgeMode, ontology } = compatRes.data;
    const stackDesc = ONTOLOGY_STACKS[targetStack];
    const adapterFileName = stackDesc.adapterFileName;

    const schemaInfo = extractTargetSchemaInfo(bundle.blueprint?.inputSchema);

    let resolvedFieldMap = inferDeterministicFieldMap({
        explicitFieldMap: fieldMap,
        localSample,
        schemaProperties: schemaInfo.itemProperties,
        consumesPorts: ontology.consumesPorts,
    });

    const inferredSkipHeader = detectHeaderUnitRow(localSample);
    let resolvedBinding = sanitizeBindingObject({
        ...(inferredSkipHeader ? { skipHeaderRow: true } : {}),
        ...bindingOverrides,
    });

    let cascadeTierUsed = 'TIER_0_DETERMINISTIC';
    let localVerification = null;

    if (localSample !== undefined && targetStack !== 'python-fastapi') {
        const boundedRepairMax =
            Number.isInteger(maxRepairAttempts) && maxRepairAttempts >= 0
                ? Math.min(maxRepairAttempts, 5)
                : 2;

        let adaptedSample = applyFieldMapToSample(localSample, resolvedFieldMap, {
            schemaProperties: schemaInfo.itemProperties,
            additionalProperties: schemaInfo.additionalProperties,
            skipHeaderRow: Boolean(resolvedBinding.skipHeaderRow),
        });

        let tryRes = await tryBrickLocally({
            bundle,
            binding: resolvedBinding,
            sampleInput: adaptedSample,
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
            ...(maxMemoryMb !== undefined ? { maxMemoryMb } : {}),
        });

        let repairAttemptsUsed = 0;
        let cascadeAttempts = [];

        if (!tryRes.ok && typeof repairFn === 'function' && boundedRepairMax >= 1) {
            const repairChain = buildRepairCascadeChain(ontology.moeProfile, boundedRepairMax);
            let forbiddenRepairKey = null;

            const cascadeExec = await executeWithCascadeFallback(
                repairChain,
                async (tier, { signal, attemptIndex }) => {
                    const attempt = attemptIndex + 1;
                    repairAttemptsUsed = attempt;

                    const patch = await repairFn({
                        attempt,
                        tier,
                        tierId: tier.canonicalTierId || tier.id,
                        model: tier.defaultModel || tier.model || '',
                        signal,
                        error: tryRes.error,
                        currentFieldMap: { ...resolvedFieldMap },
                        currentBinding: { ...resolvedBinding },
                        localSample,
                    });

                    if (!isPlainObject(patch)) {
                        throw new Error('repairFn did not return a plain repair patch object');
                    }

                    const badKey = hasForbiddenKeyRecursive(patch);
                    if (badKey) {
                        forbiddenRepairKey = badKey;
                        throw new Error(`Forbidden prototype key "${badKey}"`);
                    }

                    if (isPlainObject(patch.fieldMap)) {
                        const baseMap = patch.replaceFieldMap === true ? {} : resolvedFieldMap;
                        const mergedMap = {};
                        for (const [k, v] of Object.entries({ ...baseMap, ...patch.fieldMap })) {
                            if (
                                !FORBIDDEN_KEYS.has(k) &&
                                typeof v === 'string' &&
                                v.trim() &&
                                !FORBIDDEN_KEYS.has(v.trim())
                            ) {
                                defineSafeProp(mergedMap, k, v.trim());
                            }
                        }
                        resolvedFieldMap = mergedMap;
                    }

                    if (isPlainObject(patch.binding)) {
                        const candidateMerged =
                            patch.replaceBinding === true
                                ? patch.binding
                                : { ...resolvedBinding, ...patch.binding };
                        const patchCheck = validateJsonSerializableBinding(
                            candidateMerged,
                            0,
                            new WeakSet(),
                            'patch.binding'
                        );
                        if (!patchCheck.ok) {
                            throw new Error(patchCheck.reason);
                        }
                        resolvedBinding = sanitizeBindingObject(candidateMerged);
                    }

                    adaptedSample = applyFieldMapToSample(localSample, resolvedFieldMap, {
                        schemaProperties: schemaInfo.itemProperties,
                        additionalProperties: schemaInfo.additionalProperties,
                        skipHeaderRow: Boolean(resolvedBinding.skipHeaderRow),
                    });

                    tryRes = await tryBrickLocally({
                        bundle,
                        binding: resolvedBinding,
                        sampleInput: adaptedSample,
                        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
                        ...(maxMemoryMb !== undefined ? { maxMemoryMb } : {}),
                    });

                    if (!tryRes.ok) {
                        throw new Error(
                            tryRes.error?.message || `Verification failed on ${tier.canonicalTierId}`
                        );
                    }

                    cascadeTierUsed =
                        typeof patch.cascadeTier === 'string' && patch.cascadeTier.trim()
                            ? patch.cascadeTier.trim()
                            : tier.canonicalTierId || tier.id;

                    return {
                        tierId: cascadeTierUsed,
                        model: tier.defaultModel || tier.model || '',
                        tryRes,
                    };
                },
                {
                    perAttemptTimeoutMs: 15_000,
                    tool: 'brick-exchange.ontology.repair-cascade',
                }
            );

            if (forbiddenRepairKey) {
                return errorEnvelope(
                    'ONTOLOGY_FORBIDDEN_KEY',
                    `Forbidden key "${forbiddenRepairKey}" returned by repairFn`,
                    { key: forbiddenRepairKey },
                    tool
                );
            }

            cascadeAttempts = Array.isArray(cascadeExec.data?.attempts)
                ? cascadeExec.data.attempts
                : Array.isArray(cascadeExec.error?.details?.attempts)
                  ? cascadeExec.error.details.attempts
                  : [];
        }

        if (!tryRes.ok) {
            return errorEnvelope(
                'BINDING_VERIFICATION_FAILED',
                `Failed to verify synthesized binding against local sample: ${tryRes.error?.message || 'sandbox verification failed'}`,
                {
                    brickId: bundle.brickId,
                    targetStack,
                    resolvedFieldMap,
                    binding: resolvedBinding,
                    repairAttemptsUsed,
                    cascadeAttempts,
                    lastError: tryRes.error ?? null,
                },
                tool
            );
        }

        localVerification = {
            verified: true,
            attempts: repairAttemptsUsed + 1,
            repairAttemptsUsed,
            cascadeAttempts,
            bindingHash: tryRes.data.bindingHash,
            output: tryRes.data.output,
            durationMs: tryRes.data.durationMs,
        };
    }

    const adapterSource =
        targetStack === 'python-fastapi'
            ? renderPythonFastApiAdapterSource({
                  brickId: bundle.brickId,
                  sourceHash: bundle.lineage.sourceHash,
                  fieldMap: resolvedFieldMap,
                  bindingConfig: resolvedBinding,
                  schemaProperties: schemaInfo.itemProperties,
                  additionalProperties: schemaInfo.additionalProperties,
              })
            : renderJsOrTsAdapterSource({
                  brickId: bundle.brickId,
                  sourceHash: bundle.lineage.sourceHash,
                  targetStack,
                  fieldMap: resolvedFieldMap,
                  bindingConfig: resolvedBinding,
                  schemaProperties: schemaInfo.itemProperties,
                  additionalProperties: schemaInfo.additionalProperties,
              });

    return okEnvelope(
        tool,
        `Synthesized ${adapterFileName} for "${bundle.brickId}" on stack "${targetStack}" (${cascadeTierUsed})`,
        {
            brickId: bundle.brickId,
            sourceHash: bundle.lineage.sourceHash,
            targetStack,
            bridgeMode,
            adapterFileName,
            adapterSource,
            pythonAdapterSource: targetStack === 'python-fastapi' ? adapterSource : null,
            resolvedFieldMap,
            binding: resolvedBinding,
            localVerification,
            cascadeTierUsed,
        }
    );
}
