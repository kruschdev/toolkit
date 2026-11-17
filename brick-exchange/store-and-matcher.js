/**
 * @module @krusch/toolkit/brick-exchange/store-and-matcher
 * @description SQLite WAL store, hash-chained audit ledger integration, permission-first
 * explainable recipient matcher, optional HydraDB v2 context connector, and zero-hub
 * local repository brick lifecycle (`tryBrickLocally`, `adoptBrickIntoRepo`,
 * `auditRepoBrickLocks`) (`INV-LEGO-35`).
 *
 * License & Origin Attribution:
 * Multi-organization permission-before-discovery matching, workflow brief readiness,
 * and local-sample adoption concepts are adapted and generalized from
 * `0xANUSHKA/common-ground-8090` (`MIT License`, Copyright (c) 2026 Anushka Jogalekar
 * and Common Ground contributors).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { okEnvelope, errorEnvelope } from '../http.js';
import { openSqliteDb, escapeFts5Query } from '../sqlite.js';
import { createAuditLog } from '../audit-log.js';
import { scrubSensitiveText } from '../security.js';
import { validateSchema } from '../schema.js';
import { scoutHomelabLegoCandidates } from '../lego-scout.js';
import {
    canonicalBrickHash,
    executeInBrickSandbox,
    scanBrickSourceSafety,
} from './sandbox.js';
import {
    verifyBrickBundle,
    canPublishBrick,
    canReceiveBrick,
} from './seal-and-policy.js';

const SAFE_SLUG_RE = /^[a-z0-9][a-z0-9-_]{1,63}$/;
const VALID_RECEIVE_MODES = new Set(['off', 'team', 'federated']);
const FORBIDDEN_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const INLINE_SECRET_ASSIGNMENT_RE =
    /\b(?:api[_-]?key|secret|password|passwd|private[_-]?key|access[_-]?token)\s*[:=]\s*['"]?[A-Za-z0-9._~+/=-]{8,}/i;

const STOPWORDS = new Set([
    'about',
    'above',
    'across',
    'after',
    'again',
    'against',
    'allow',
    'allows',
    'also',
    'always',
    'among',
    'another',
    'around',
    'because',
    'before',
    'being',
    'below',
    'between',
    'both',
    'brick',
    'bricks',
    'build',
    'builds',
    'built',
    'call',
    'calls',
    'code',
    'common',
    'could',
    'create',
    'creates',
    'data',
    'default',
    'does',
    'done',
    'each',
    'either',
    'else',
    'ensure',
    'every',
    'export',
    'exports',
    'file',
    'files',
    'first',
    'from',
    'function',
    'functions',
    'general',
    'given',
    'handle',
    'handles',
    'have',
    'having',
    'helper',
    'helpers',
    'here',
    'input',
    'inputs',
    'into',
    'item',
    'items',
    'just',
    'keep',
    'like',
    'local',
    'make',
    'makes',
    'many',
    'module',
    'modules',
    'more',
    'most',
    'must',
    'name',
    'need',
    'needs',
    'never',
    'next',
    'none',
    'null',
    'object',
    'objects',
    'only',
    'other',
    'others',
    'output',
    'outputs',
    'over',
    'pass',
    'passed',
    'pure',
    'return',
    'returns',
    'same',
    'sealed',
    'service',
    'services',
    'shared',
    'should',
    'simple',
    'since',
    'some',
    'source',
    'still',
    'string',
    'strings',
    'such',
    'support',
    'supports',
    'system',
    'take',
    'takes',
    'team',
    'teams',
    'than',
    'that',
    'their',
    'them',
    'then',
    'there',
    'these',
    'they',
    'this',
    'those',
    'through',
    'tool',
    'tools',
    'true',
    'type',
    'types',
    'under',
    'unit',
    'until',
    'used',
    'user',
    'users',
    'uses',
    'using',
    'valid',
    'value',
    'values',
    'very',
    'want',
    'wants',
    'well',
    'were',
    'what',
    'when',
    'where',
    'which',
    'while',
    'with',
    'within',
    'without',
    'work',
    'workflow',
    'workflows',
    'works',
    'would',
    'your',
]);

function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

function normalizeStringArray(raw) {
    if (!Array.isArray(raw)) {
        return [];
    }
    const seen = new Set();
    const result = [];
    for (const item of raw) {
        if (typeof item !== 'string') continue;
        const trimmed = item.trim();
        if (trimmed.length === 0 || seen.has(trimmed)) continue;
        seen.add(trimmed);
        result.push(trimmed);
    }
    return result;
}

function parseJsonArraySafe(rawJson) {
    if (typeof rawJson !== 'string' || rawJson.trim().length === 0) {
        return [];
    }
    try {
        const parsed = JSON.parse(rawJson);
        return Array.isArray(parsed)
            ? parsed.filter((v) => typeof v === 'string')
            : [];
    } catch {
        return [];
    }
}

function sanitizeOrgCollectionName(orgId) {
    return `brick_org_${String(orgId || '').replace(/[^a-z0-9_]/gi, '_')}`;
}

function hasBriefZeroLeakViolation(text) {
    const str = String(text ?? '');
    if (str.length === 0) return false;
    if (scrubSensitiveText(str) !== str) {
        return true;
    }
    if (INLINE_SECRET_ASSIGNMENT_RE.test(str)) {
        return true;
    }
    return false;
}

function extractMeaningfulKeywords(values) {
    const tokens = new Set();
    const list = Array.isArray(values) ? values : [values];
    for (const entry of list) {
        if (typeof entry !== 'string' || entry.length === 0) continue;
        const matches = entry.toLowerCase().match(/[a-z0-9]{4,}/g);
        if (!matches) continue;
        for (const word of matches) {
            if (STOPWORDS.has(word)) continue;
            if (/^\d+$/.test(word)) continue;
            tokens.add(word);
        }
    }
    return tokens;
}

function normalizeCapabilitySet(capabilities) {
    const out = new Set();
    if (!Array.isArray(capabilities)) return out;
    for (const cap of capabilities) {
        if (typeof cap !== 'string') continue;
        const normalized = cap.trim().toLowerCase();
        if (normalized.length > 0) {
            out.add(normalized);
        }
    }
    return out;
}

function flattenRepoSignalStrings(rawSignalEntry) {
    const out = [];
    if (!rawSignalEntry) return out;
    if (typeof rawSignalEntry === 'string') {
        out.push(rawSignalEntry);
        return out;
    }
    if (Array.isArray(rawSignalEntry)) {
        for (const item of rawSignalEntry) {
            if (typeof item === 'string') {
                out.push(item);
            } else if (isPlainObject(item)) {
                for (const field of ['id', 'ruleId', 'brickId', 'importPath', 'title', 'signal']) {
                    if (typeof item[field] === 'string') out.push(item[field]);
                }
            }
        }
        return out;
    }
    if (isPlainObject(rawSignalEntry)) {
        for (const key of ['signals', 'boilerplate', 'boilerplateSignals', 'findings', 'rulesTriggered', 'recommendedBricks']) {
            if (Array.isArray(rawSignalEntry[key])) {
                out.push(...flattenRepoSignalStrings(rawSignalEntry[key]));
            }
        }
    }
    return out;
}

function extractBoilerplateTokens(values) {
    const tokens = new Set();
    for (const raw of values) {
        if (typeof raw !== 'string') continue;
        const trimmed = raw.trim().toLowerCase();
        if (!trimmed) continue;
        tokens.add(trimmed);
        const parts = trimmed.split(/[^a-z0-9]+/).filter((p) => p.length >= 3 && !STOPWORDS.has(p));
        for (const part of parts) {
            tokens.add(part);
        }
    }
    return tokens;
}

function sanitizeBindingForHashing(value, depth = 0, seen = new WeakSet()) {
    if (value === null || value === undefined) return null;
    const t = typeof value;
    if (t === 'boolean' || t === 'string') return value;
    if (t === 'number') return Number.isFinite(value) ? (Object.is(value, -0) ? 0 : value) : String(value);
    if (t === 'function') return `[Function:${value.name || 'anonymous'}]`;
    if (t !== 'object') return String(value);
    if (depth > 16) return '[MaxDepth]';
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    try {
        if (Array.isArray(value)) {
            return value.map((item) => sanitizeBindingForHashing(item, depth + 1, seen));
        }
        const sorted = {};
        for (const key of Object.keys(value).sort()) {
            if (FORBIDDEN_OBJECT_KEYS.has(key)) continue;
            if (value[key] === undefined) continue;
            sorted[key] = sanitizeBindingForHashing(value[key], depth + 1, seen);
        }
        return sorted;
    } finally {
        seen.delete(value);
    }
}

function computeBindingHash(binding) {
    if (binding === null || binding === undefined) {
        return canonicalBrickHash({});
    }
    if (typeof binding !== 'object') {
        return canonicalBrickHash(String(binding));
    }
    const sanitized = sanitizeBindingForHashing(binding);
    return canonicalBrickHash(sanitized);
}

function isPathStrictlyInside(realChild, realParent) {
    return (
        realChild === realParent ||
        realChild.startsWith(`${realParent}${path.sep}`)
    );
}

function extractHydraScoreAndRequestId(res) {
    if (!res || typeof res !== 'object') {
        return { hydraScore: 0, hydraRequestId: null };
    }
    const hydraRequestId =
        (typeof res._meta?.request_id === 'string' && res._meta.request_id) ||
        (typeof res.meta?.request_id === 'string' && res.meta.request_id) ||
        (typeof res.requestId === 'string' && res.requestId) ||
        null;

    const chunks = Array.isArray(res.chunks)
        ? res.chunks
        : Array.isArray(res.data?.chunks)
          ? res.data.chunks
          : [];

    let bestScore = 0;
    if (typeof res.score === 'number' && Number.isFinite(res.score)) {
        bestScore = Math.max(bestScore, res.score);
    }
    for (const chunk of chunks) {
        if (chunk && typeof chunk.score === 'number' && Number.isFinite(chunk.score)) {
            if (chunk.score > bestScore) {
                bestScore = chunk.score;
            }
        }
    }
    return {
        hydraScore: Number(Math.max(0, bestScore).toFixed(4)),
        hydraRequestId,
    };
}

/**
 * Create a durable or in-memory SQLite-backed Brick Exchange store paired with a
 * tamper-evident hash-chained audit ledger (`INV-LEGO-35`, `INV-LEGO-32`).
 *
 * @param {object} [options={}]
 * @param {string} [options.dbPath=':memory:']
 * @param {string} [options.auditHmacSecret='']
 * @param {any} [options.hydraClient=null]
 * @param {string} [options.hydraDatabase='default-tenant']
 * @param {() => number} [options.nowFn=() => Date.now()]
 */
export function createBrickExchangeStore({
    dbPath = ':memory:',
    auditHmacSecret = '',
    hydraClient = null,
    hydraDatabase = 'default-tenant',
    nowFn = () => Date.now(),
} = {}) {
    if (typeof nowFn !== 'function') {
        throw new TypeError('createBrickExchangeStore requires nowFn to be a function');
    }

    const safeNowMs = () => {
        const val = Number(nowFn());
        return Number.isFinite(val) ? val : Date.now();
    };

    const sqliteHandle = openSqliteDb(dbPath);
    let auditLog;
    let ftsSupported = false;

    try {
        auditLog = createAuditLog({
            db: sqliteHandle,
            tableName: 'brick_exchange_audit_log',
            hmacSecret: auditHmacSecret || undefined,
            nowFn: () => new Date(safeNowMs()).toISOString(),
            tool: 'brick-exchange.audit',
        });

        sqliteHandle.exec(`
            CREATE TABLE IF NOT EXISTS orgs (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                participating INTEGER NOT NULL DEFAULT 1,
                peers_json TEXT NOT NULL DEFAULT '[]',
                publishers_json TEXT NOT NULL DEFAULT '[]',
                exporters_json TEXT NOT NULL DEFAULT '[]',
                receivers_json TEXT NOT NULL DEFAULT '[]',
                allowed_classes_json TEXT NOT NULL DEFAULT '[]',
                publishers_explicit INTEGER NOT NULL DEFAULT 0,
                exporters_explicit INTEGER NOT NULL DEFAULT 0,
                receivers_explicit INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS members (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                org_id TEXT NOT NULL,
                publisher INTEGER NOT NULL DEFAULT 0,
                exporter INTEGER NOT NULL DEFAULT 0,
                eligible INTEGER NOT NULL DEFAULT 1,
                capabilities_json TEXT NOT NULL DEFAULT '[]',
                receive_mode TEXT NOT NULL DEFAULT 'team',
                muted_senders_json TEXT NOT NULL DEFAULT '[]',
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_members_org_id ON members (org_id);

            CREATE TABLE IF NOT EXISTS workflow_briefs (
                org_id TEXT PRIMARY KEY,
                brief TEXT NOT NULL DEFAULT '',
                capabilities_json TEXT NOT NULL DEFAULT '[]',
                boilerplate_signals_json TEXT NOT NULL DEFAULT '[]',
                revision TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS sealed_bricks (
                brick_id TEXT NOT NULL,
                source_hash TEXT NOT NULL,
                name TEXT NOT NULL,
                summary TEXT NOT NULL DEFAULT '',
                brick_class TEXT NOT NULL DEFAULT 'general',
                author_id TEXT NOT NULL,
                org_id TEXT NOT NULL,
                capabilities_json TEXT NOT NULL DEFAULT '[]',
                replaces_boilerplate TEXT NOT NULL DEFAULT '',
                estimated_hours_saved REAL NOT NULL DEFAULT 0,
                key_id TEXT NOT NULL,
                bundle_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                published_at TEXT NOT NULL,
                PRIMARY KEY (brick_id, source_hash)
            );
            CREATE INDEX IF NOT EXISTS idx_sealed_bricks_org ON sealed_bricks (org_id);
            CREATE INDEX IF NOT EXISTS idx_sealed_bricks_published ON sealed_bricks (brick_id, published_at DESC);

            CREATE TABLE IF NOT EXISTS grants (
                id TEXT PRIMARY KEY,
                brick_id TEXT NOT NULL,
                source_hash TEXT NOT NULL,
                issuer_id TEXT NOT NULL,
                scope TEXT NOT NULL,
                recipients_json TEXT NOT NULL DEFAULT '[]',
                expires_at TEXT NOT NULL,
                revoked INTEGER NOT NULL DEFAULT 0,
                reshare INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                revoked_at TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_grants_brick ON grants (brick_id, source_hash);

            CREATE TABLE IF NOT EXISTS adoptions (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                org_id TEXT NOT NULL,
                brick_id TEXT NOT NULL,
                source_hash TEXT NOT NULL,
                grant_id TEXT,
                binding_hash TEXT NOT NULL DEFAULT '',
                local_checks_passed INTEGER NOT NULL DEFAULT 1,
                hydra_request_id TEXT,
                adopted_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_adoptions_brick ON adoptions (brick_id, source_hash);
            CREATE INDEX IF NOT EXISTS idx_adoptions_org ON adoptions (org_id);
            CREATE INDEX IF NOT EXISTS idx_adoptions_user ON adoptions (user_id);
        `);

        try {
            sqliteHandle.exec(`
                CREATE VIRTUAL TABLE IF NOT EXISTS sealed_bricks_fts USING fts5(
                    brick_id,
                    source_hash UNINDEXED,
                    name,
                    summary,
                    capabilities,
                    replaces_boilerplate
                );
            `);
            ftsSupported = true;
        } catch {
            ftsSupported = false;
        }
    } catch (err) {
        try {
            auditLog?.close();
        } catch {
            // Best-effort cleanup
        }
        try {
            sqliteHandle.close();
        } catch {
            // Best-effort cleanup
        }
        throw err;
    }

    function hydrateOrgRow(row) {
        if (!row) return null;
        const orgId = String(row.id);
        const needMemberFallback =
            Number(row.publishers_explicit) === 0 ||
            Number(row.exporters_explicit) === 0 ||
            Number(row.receivers_explicit) === 0;

        let orgMembers = [];
        if (needMemberFallback) {
            orgMembers = sqliteHandle.query(
                'SELECT id, publisher, exporter, eligible FROM members WHERE org_id = ? ORDER BY id ASC',
                [orgId]
            );
        }

        const publishers =
            Number(row.publishers_explicit) === 1
                ? parseJsonArraySafe(row.publishers_json)
                : orgMembers
                      .filter((m) => Number(m.publisher) === 1)
                      .map((m) => String(m.id));

        const exporters =
            Number(row.exporters_explicit) === 1
                ? parseJsonArraySafe(row.exporters_json)
                : orgMembers
                      .filter((m) => Number(m.exporter) === 1)
                      .map((m) => String(m.id));

        const receivers =
            Number(row.receivers_explicit) === 1
                ? parseJsonArraySafe(row.receivers_json)
                : orgMembers
                      .filter((m) => Number(m.eligible) === 1)
                      .map((m) => String(m.id));

        return {
            id: orgId,
            name: String(row.name),
            participating: Number(row.participating) === 1,
            peers: parseJsonArraySafe(row.peers_json),
            publishers,
            exporters,
            receivers,
            allowedClasses: parseJsonArraySafe(row.allowed_classes_json),
            updatedAt: String(row.updated_at),
        };
    }

    function hydrateMemberRow(row) {
        if (!row) return null;
        return {
            id: String(row.id),
            name: String(row.name),
            orgId: String(row.org_id),
            publisher: Number(row.publisher) === 1,
            exporter: Number(row.exporter) === 1,
            eligible: Number(row.eligible) === 1,
            capabilities: parseJsonArraySafe(row.capabilities_json),
            receiveMode: String(row.receive_mode || 'team'),
            mutedSenders: parseJsonArraySafe(row.muted_senders_json),
            updatedAt: String(row.updated_at),
        };
    }

    function hydrateGrantRow(row) {
        if (!row) return null;
        return {
            id: String(row.id),
            brickId: String(row.brick_id),
            sourceHash: String(row.source_hash),
            issuerId: String(row.issuer_id),
            scope: String(row.scope),
            recipients: parseJsonArraySafe(row.recipients_json),
            expiresAt: String(row.expires_at),
            revoked: Number(row.revoked) === 1,
            reshare: Number(row.reshare) === 1,
            createdAt: String(row.created_at),
            ...(row.revoked_at ? { revokedAt: String(row.revoked_at) } : {}),
        };
    }

    function hydrateAdoptionRow(row) {
        if (!row) return null;
        return {
            id: String(row.id),
            userId: String(row.user_id),
            orgId: String(row.org_id),
            brickId: String(row.brick_id),
            sourceHash: String(row.source_hash),
            grantId: row.grant_id ? String(row.grant_id) : null,
            bindingHash: String(row.binding_hash || ''),
            localChecksPassed: Number(row.local_checks_passed) === 1,
            hydraRequestId: row.hydra_request_id ? String(row.hydra_request_id) : null,
            adoptedAt: String(row.adopted_at),
        };
    }

    function getOrg(orgId) {
        if (typeof orgId !== 'string' || orgId.trim().length === 0) {
            return null;
        }
        const row = sqliteHandle.queryOne('SELECT * FROM orgs WHERE id = ?', [orgId.trim()]);
        return hydrateOrgRow(row);
    }

    function listOrgs() {
        const rows = sqliteHandle.query('SELECT * FROM orgs ORDER BY id ASC');
        return rows.map((row) => hydrateOrgRow(row)).filter(Boolean);
    }

    function upsertOrg(rawInput = {}) {
        const tool = 'brick-exchange.org';
        if (!isPlainObject(rawInput)) {
            return errorEnvelope('INVALID_ORG_INPUT', 'Organization payload must be an object', null, tool);
        }

        const {
            id,
            name,
            participating = true,
            peers = [],
            publishers = [],
            exporters = [],
            receivers = [],
            allowedClasses = [],
        } = rawInput;

        if (typeof id !== 'string' || !SAFE_SLUG_RE.test(id)) {
            return errorEnvelope(
                'INVALID_ORG_ID',
                'Organization id must match /^[a-z0-9][a-z0-9-_]{1,63}$/',
                { id },
                tool
            );
        }

        if (name !== undefined && (typeof name !== 'string' || name.trim().length === 0)) {
            return errorEnvelope(
                'INVALID_ORG_NAME',
                'Organization name must be a non-empty string',
                { id },
                tool
            );
        }

        const resolvedName = typeof name === 'string' && name.trim().length > 0 ? name.trim() : id;
        const cleanPeers = normalizeStringArray(peers);
        const cleanAllowedClasses = normalizeStringArray(allowedClasses);

        const existingRow = sqliteHandle.queryOne('SELECT * FROM orgs WHERE id = ?', [id]);

        const hasExplicitPublishers =
            Object.hasOwn(rawInput, 'publishers') && Array.isArray(rawInput.publishers);
        const hasExplicitExporters =
            Object.hasOwn(rawInput, 'exporters') && Array.isArray(rawInput.exporters);
        const hasExplicitReceivers =
            Object.hasOwn(rawInput, 'receivers') && Array.isArray(rawInput.receivers);

        const publishersExplicit = hasExplicitPublishers
            ? 1
            : rawInput.publishers === null
              ? 0
              : existingRow
                ? Number(existingRow.publishers_explicit)
                : 0;
        const exportersExplicit = hasExplicitExporters
            ? 1
            : rawInput.exporters === null
              ? 0
              : existingRow
                ? Number(existingRow.exporters_explicit)
                : 0;
        const receiversExplicit = hasExplicitReceivers
            ? 1
            : rawInput.receivers === null
              ? 0
              : existingRow
                ? Number(existingRow.receivers_explicit)
                : 0;

        const cleanPublishers = hasExplicitPublishers
            ? normalizeStringArray(publishers)
            : existingRow && publishersExplicit === 1
              ? parseJsonArraySafe(existingRow.publishers_json)
              : [];
        const cleanExporters = hasExplicitExporters
            ? normalizeStringArray(exporters)
            : existingRow && exportersExplicit === 1
              ? parseJsonArraySafe(existingRow.exporters_json)
              : [];
        const cleanReceivers = hasExplicitReceivers
            ? normalizeStringArray(receivers)
            : existingRow && receiversExplicit === 1
              ? parseJsonArraySafe(existingRow.receivers_json)
              : [];

        const updatedAt = new Date(safeNowMs()).toISOString();

        sqliteHandle.run(
            `INSERT INTO orgs (
                id, name, participating, peers_json, publishers_json, exporters_json,
                receivers_json, allowed_classes_json, publishers_explicit,
                exporters_explicit, receivers_explicit, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                participating = excluded.participating,
                peers_json = excluded.peers_json,
                publishers_json = excluded.publishers_json,
                exporters_json = excluded.exporters_json,
                receivers_json = excluded.receivers_json,
                allowed_classes_json = excluded.allowed_classes_json,
                publishers_explicit = excluded.publishers_explicit,
                exporters_explicit = excluded.exporters_explicit,
                receivers_explicit = excluded.receivers_explicit,
                updated_at = excluded.updated_at`,
            [
                id,
                resolvedName,
                participating !== false ? 1 : 0,
                JSON.stringify(cleanPeers),
                JSON.stringify(cleanPublishers),
                JSON.stringify(cleanExporters),
                JSON.stringify(cleanReceivers),
                JSON.stringify(cleanAllowedClasses),
                publishersExplicit,
                exportersExplicit,
                receiversExplicit,
                updatedAt,
            ]
        );

        const auditRes = auditLog.append({
            tenantId: id,
            actor: `org:${id}`,
            action: 'org.upsert',
            resource: `org:${id}`,
            outcome: 'SUCCESS',
            metadata: {
                orgId: id,
                participating: participating !== false,
                peerCount: cleanPeers.length,
            },
        });
        if (!auditRes.ok) {
            return auditRes;
        }

        return okEnvelope(tool, `Upserted organization "${id}"`, {
            org: getOrg(id),
        });
    }

    function getMember(memberId) {
        if (typeof memberId !== 'string' || memberId.trim().length === 0) {
            return null;
        }
        const row = sqliteHandle.queryOne('SELECT * FROM members WHERE id = ?', [memberId.trim()]);
        return hydrateMemberRow(row);
    }

    function listMembers({ orgId = null } = {}) {
        if (typeof orgId === 'string' && orgId.trim().length > 0) {
            const rows = sqliteHandle.query(
                'SELECT * FROM members WHERE org_id = ? ORDER BY id ASC',
                [orgId.trim()]
            );
            return rows.map((row) => hydrateMemberRow(row)).filter(Boolean);
        }
        const rows = sqliteHandle.query('SELECT * FROM members ORDER BY org_id ASC, id ASC');
        return rows.map((row) => hydrateMemberRow(row)).filter(Boolean);
    }

    function upsertMember(rawInput = {}) {
        const tool = 'brick-exchange.member';
        if (!isPlainObject(rawInput)) {
            return errorEnvelope('INVALID_MEMBER_INPUT', 'Member payload must be an object', null, tool);
        }

        const {
            id,
            name,
            orgId,
            publisher = false,
            exporter = false,
            eligible = true,
            capabilities = [],
            receiveMode = 'team',
            mutedSenders = [],
        } = rawInput;

        if (typeof id !== 'string' || !SAFE_SLUG_RE.test(id)) {
            return errorEnvelope(
                'INVALID_MEMBER_ID',
                'Member id must match /^[a-z0-9][a-z0-9-_]{1,63}$/',
                { id },
                tool
            );
        }

        if (typeof orgId !== 'string' || !getOrg(orgId)) {
            return errorEnvelope(
                'ORG_NOT_FOUND',
                `Organization "${String(orgId || '')}" does not exist`,
                { orgId },
                tool
            );
        }

        if (typeof receiveMode !== 'string' || !VALID_RECEIVE_MODES.has(receiveMode)) {
            return errorEnvelope(
                'INVALID_RECEIVE_MODE',
                'receiveMode must be "off", "team", or "federated"',
                { receiveMode },
                tool
            );
        }

        const resolvedName = typeof name === 'string' && name.trim().length > 0 ? name.trim() : id;
        const cleanCapabilities = normalizeStringArray(capabilities);
        const cleanMuted = normalizeStringArray(mutedSenders);
        const updatedAt = new Date(safeNowMs()).toISOString();

        sqliteHandle.run(
            `INSERT INTO members (
                id, name, org_id, publisher, exporter, eligible,
                capabilities_json, receive_mode, muted_senders_json, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                org_id = excluded.org_id,
                publisher = excluded.publisher,
                exporter = excluded.exporter,
                eligible = excluded.eligible,
                capabilities_json = excluded.capabilities_json,
                receive_mode = excluded.receive_mode,
                muted_senders_json = excluded.muted_senders_json,
                updated_at = excluded.updated_at`,
            [
                id,
                resolvedName,
                orgId,
                Boolean(publisher) ? 1 : 0,
                Boolean(exporter) ? 1 : 0,
                eligible !== false ? 1 : 0,
                JSON.stringify(cleanCapabilities),
                receiveMode,
                JSON.stringify(cleanMuted),
                updatedAt,
            ]
        );

        const auditRes = auditLog.append({
            tenantId: orgId,
            actor: id,
            action: 'member.upsert',
            resource: `member:${id}`,
            outcome: 'SUCCESS',
            metadata: {
                memberId: id,
                orgId,
                publisher: Boolean(publisher),
                exporter: Boolean(exporter),
                eligible: eligible !== false,
                receiveMode,
            },
        });
        if (!auditRes.ok) {
            return auditRes;
        }

        return okEnvelope(tool, `Upserted member "${id}" in organization "${orgId}"`, {
            member: getMember(id),
        });
    }

    function getWorkflowBrief(orgId) {
        if (typeof orgId !== 'string' || orgId.trim().length === 0) {
            return null;
        }
        const row = sqliteHandle.queryOne('SELECT * FROM workflow_briefs WHERE org_id = ?', [
            orgId.trim(),
        ]);
        if (!row) return null;
        return {
            orgId: String(row.org_id),
            brief: String(row.brief),
            capabilities: parseJsonArraySafe(row.capabilities_json),
            boilerplateSignals: parseJsonArraySafe(row.boilerplate_signals_json),
            revision: String(row.revision),
            updatedAt: String(row.updated_at),
        };
    }

    async function setWorkflowBrief(rawInput = {}) {
        const tool = 'brick-exchange.brief';
        if (!isPlainObject(rawInput)) {
            return errorEnvelope('INVALID_BRIEF_INPUT', 'Workflow brief payload must be an object', null, tool);
        }

        const {
            orgId,
            brief = '',
            capabilities = [],
            boilerplateSignals = [],
        } = rawInput;

        if (typeof orgId !== 'string' || !getOrg(orgId)) {
            return errorEnvelope(
                'ORG_NOT_FOUND',
                `Organization "${String(orgId || '')}" does not exist`,
                { orgId },
                tool
            );
        }

        if (typeof brief !== 'string') {
            return errorEnvelope(
                'INVALID_BRIEF_INPUT',
                'Workflow brief must be a string',
                { orgId },
                tool
            );
        }

        const cleanCaps = normalizeStringArray(capabilities);
        const cleanSignals = normalizeStringArray(boilerplateSignals);

        if (
            hasBriefZeroLeakViolation(brief) ||
            cleanCaps.some((c) => hasBriefZeroLeakViolation(c)) ||
            cleanSignals.some((s) => hasBriefZeroLeakViolation(s))
        ) {
            return errorEnvelope(
                'BRIEF_ZERO_LEAK_VIOLATION',
                'Workflow brief rejected by zero-leak guard (contains secret token, private network host/IP, host path, or PII)',
                { orgId },
                tool
            );
        }

        const revision = canonicalBrickHash(`${orgId}\n${brief}\n${cleanCaps.join(',')}`);
        const updatedAt = new Date(safeNowMs()).toISOString();

        sqliteHandle.run(
            `INSERT INTO workflow_briefs (
                org_id, brief, capabilities_json, boilerplate_signals_json, revision, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(org_id) DO UPDATE SET
                brief = excluded.brief,
                capabilities_json = excluded.capabilities_json,
                boilerplate_signals_json = excluded.boilerplate_signals_json,
                revision = excluded.revision,
                updated_at = excluded.updated_at`,
            [
                orgId,
                brief,
                JSON.stringify(cleanCaps),
                JSON.stringify(cleanSignals),
                revision,
                updatedAt,
            ]
        );

        let hydraSync = { state: 'disabled' };
        if (
            hydraClient &&
            typeof hydraClient.isConfigured === 'function' &&
            hydraClient.isConfigured()
        ) {
            const collection = sanitizeOrgCollectionName(orgId);
            const docId = `brief_${orgId}`;
            try {
                if (!brief.trim()) {
                    await hydraClient.deleteContext({
                        database: hydraDatabase,
                        collection,
                        ids: [docId],
                        type: 'knowledge',
                    });
                    hydraSync = { state: 'deleted', collection, docId, revision };
                } else {
                    await hydraClient.ingestAppKnowledge(
                        [
                            {
                                id: docId,
                                database: hydraDatabase,
                                collection,
                                title: `Workflow Brief: ${orgId}`,
                                text: brief,
                                additional_metadata: {
                                    orgId,
                                    revision,
                                    capabilities: cleanCaps,
                                },
                            },
                        ],
                        { database: hydraDatabase, collection, upsert: true }
                    );
                    hydraSync = { state: 'synced', collection, docId, revision };
                }
            } catch (err) {
                hydraSync = {
                    state: 'error',
                    message: err instanceof Error ? err.message : String(err),
                };
            }
        }

        const auditRes = auditLog.append({
            tenantId: orgId,
            actor: `org:${orgId}`,
            action: 'brief.set',
            resource: `brief:${orgId}`,
            outcome: 'SUCCESS',
            metadata: {
                orgId,
                revision,
                capabilityCount: cleanCaps.length,
                hydraState: hydraSync.state,
            },
        });
        if (!auditRes.ok) {
            return auditRes;
        }

        return okEnvelope(tool, `Updated workflow brief for "${orgId}"`, {
            orgId,
            brief,
            capabilities: cleanCaps,
            boilerplateSignals: cleanSignals,
            revision,
            updatedAt,
            hydraSync,
        });
    }

    function lookupStoredBundle(brickId, sourceHash = null) {
        if (typeof brickId !== 'string' || brickId.trim().length === 0) {
            return null;
        }
        const row =
            typeof sourceHash === 'string' && sourceHash.trim().length > 0
                ? sqliteHandle.queryOne(
                      'SELECT bundle_json FROM sealed_bricks WHERE brick_id = ? AND source_hash = ?',
                      [brickId.trim(), sourceHash.trim()]
                  )
                : sqliteHandle.queryOne(
                      'SELECT bundle_json FROM sealed_bricks WHERE brick_id = ? ORDER BY published_at DESC, rowid DESC LIMIT 1',
                      [brickId.trim()]
                  );
        if (!row || typeof row.bundle_json !== 'string') return null;
        try {
            return JSON.parse(row.bundle_json);
        } catch {
            return null;
        }
    }

    function publishSealedBrick(
        bundle,
        { actorId = null, trustedPublicKeyPem = null } = {}
    ) {
        const tool = 'brick-exchange.publish';
        const sealCheck = verifyBrickBundle(bundle, { trustedPublicKeyPem });
        if (!sealCheck || !sealCheck.ok) {
            return (
                sealCheck ||
                errorEnvelope('INVALID_BRICK_BUNDLE', 'Sealed bundle verification failed', null, tool)
            );
        }

        const safetyCheck = scanBrickSourceSafety(bundle.source);
        if (!safetyCheck || !safetyCheck.ok) {
            return errorEnvelope(
                'BRICK_SAFETY_FAILED',
                safetyCheck?.error?.message || 'Sealed brick source failed safety verification',
                safetyCheck?.error?.details ?? null,
                tool
            );
        }

        const effectiveActorId =
            typeof actorId === 'string' && actorId.trim().length > 0
                ? actorId.trim()
                : bundle.authorId;
        const actor = getMember(effectiveActorId);
        const org = getOrg(bundle.orgId);

        const pubPolicy = canPublishBrick({
            actor,
            org,
            bundle,
            scope: 'team',
        });
        if (!pubPolicy || !pubPolicy.ok) {
            return (
                pubPolicy ||
                errorEnvelope('PUBLISH_DENIED', 'Actor is not authorized to publish brick', null, tool)
            );
        }

        const sourceHash = bundle.lineage.sourceHash;
        const keyId = bundle.attestation.keyId;
        const cleanCaps = normalizeStringArray(bundle.capabilities);
        const publishedAt = new Date(safeNowMs()).toISOString();
        const createdAt =
            typeof bundle.createdAt === 'string' && bundle.createdAt.trim().length > 0
                ? bundle.createdAt
                : publishedAt;

        sqliteHandle.transaction(() => {
            sqliteHandle.run(
                `INSERT OR REPLACE INTO sealed_bricks (
                    brick_id, source_hash, name, summary, brick_class,
                    author_id, org_id, capabilities_json, replaces_boilerplate,
                    estimated_hours_saved, key_id, bundle_json, created_at, published_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    bundle.brickId,
                    sourceHash,
                    String(bundle.name || bundle.brickId),
                    String(bundle.summary || ''),
                    String(bundle.brickClass || 'general'),
                    bundle.authorId,
                    bundle.orgId,
                    JSON.stringify(cleanCaps),
                    String(bundle.replacesBoilerplate || ''),
                    Math.max(0, Number(bundle.estimatedHoursSaved) || 0),
                    keyId,
                    JSON.stringify(bundle),
                    createdAt,
                    publishedAt,
                ]
            );

            if (ftsSupported) {
                sqliteHandle.run(
                    'DELETE FROM sealed_bricks_fts WHERE brick_id = ? AND source_hash = ?',
                    [bundle.brickId, sourceHash]
                );
                sqliteHandle.run(
                    `INSERT INTO sealed_bricks_fts (
                        brick_id, source_hash, name, summary, capabilities, replaces_boilerplate
                    ) VALUES (?, ?, ?, ?, ?, ?)`,
                    [
                        bundle.brickId,
                        sourceHash,
                        String(bundle.name || bundle.brickId),
                        String(bundle.summary || ''),
                        cleanCaps.join(' '),
                        String(bundle.replacesBoilerplate || ''),
                    ]
                );
            }
        });

        const auditRes = auditLog.append({
            tenantId: bundle.orgId,
            actor: actor.id,
            action: 'brick.publish',
            resource: `brick:${bundle.brickId}@${sourceHash}`,
            outcome: 'SUCCESS',
            metadata: {
                brickId: bundle.brickId,
                sourceHash,
                keyId,
                brickClass: bundle.brickClass,
            },
        });
        if (!auditRes.ok) {
            return auditRes;
        }

        return okEnvelope(
            tool,
            `Published sealed brick "${bundle.brickId}"@${sourceHash.slice(0, 8)}`,
            {
                brickId: bundle.brickId,
                sourceHash,
                keyId,
            }
        );
    }

    function issueGrant(rawInput = {}) {
        const tool = 'brick-exchange.grant';
        if (!isPlainObject(rawInput)) {
            return errorEnvelope('INVALID_GRANT_INPUT', 'Grant payload must be an object', null, tool);
        }

        const {
            issuerId,
            brickId,
            sourceHash = null,
            scope = 'federated',
            recipients = [],
            expiresAt,
        } = rawInput;

        const bundle = lookupStoredBundle(brickId, sourceHash);
        if (!bundle) {
            return errorEnvelope(
                'BRICK_NOT_FOUND',
                `Sealed brick "${String(brickId || '')}" was not found`,
                null,
                tool
            );
        }

        const issuer = typeof issuerId === 'string' ? getMember(issuerId) : null;
        const org = getOrg(bundle.orgId);

        const pubPolicy = canPublishBrick({
            actor: issuer,
            org,
            bundle,
            scope,
        });
        if (!pubPolicy || !pubPolicy.ok) {
            return (
                pubPolicy ||
                errorEnvelope('PUBLISH_DENIED', 'Issuer is not authorized to grant brick', null, tool)
            );
        }

        const uniqueRecipients = normalizeStringArray(recipients);
        if (!Array.isArray(recipients) || uniqueRecipients.length === 0) {
            return errorEnvelope(
                'INVALID_GRANT_RECIPIENTS',
                'Grant recipients must be a non-empty array of member IDs',
                null,
                tool
            );
        }

        const nowMs = safeNowMs();
        const expiresMs =
            typeof expiresAt === 'string' || typeof expiresAt === 'number'
                ? Date.parse(String(expiresAt))
                : Number.NaN;
        if (!Number.isFinite(expiresMs) || expiresMs <= nowMs) {
            return errorEnvelope(
                'INVALID_GRANT_EXPIRY',
                'Grant expiresAt must be a valid future ISO timestamp',
                { expiresAt },
                tool
            );
        }

        const resolvedSourceHash = bundle.lineage.sourceHash;
        const grantId = `grant_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
        const createdAt = new Date(nowMs).toISOString();
        const normalizedExpiresAt = new Date(expiresMs).toISOString();

        const grant = {
            id: grantId,
            brickId: bundle.brickId,
            sourceHash: resolvedSourceHash,
            issuerId: issuer.id,
            scope,
            recipients: uniqueRecipients,
            expiresAt: normalizedExpiresAt,
            revoked: false,
            reshare: false,
            createdAt,
        };

        sqliteHandle.run(
            `INSERT INTO grants (
                id, brick_id, source_hash, issuer_id, scope,
                recipients_json, expires_at, revoked, reshare, created_at, revoked_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, NULL)`,
            [
                grant.id,
                grant.brickId,
                grant.sourceHash,
                grant.issuerId,
                grant.scope,
                JSON.stringify(grant.recipients),
                grant.expiresAt,
                grant.createdAt,
            ]
        );

        const auditRes = auditLog.append({
            tenantId: bundle.orgId,
            actor: issuer.id,
            action: 'grant.issue',
            resource: `grant:${grant.id}`,
            outcome: 'SUCCESS',
            metadata: {
                grantId: grant.id,
                brickId: grant.brickId,
                sourceHash: grant.sourceHash,
                scope: grant.scope,
                recipientCount: grant.recipients.length,
                expiresAt: grant.expiresAt,
            },
        });
        if (!auditRes.ok) {
            return auditRes;
        }

        return okEnvelope(
            tool,
            `Issued ${scope} grant "${grant.id}" for "${grant.brickId}"`,
            { grant }
        );
    }

    function revokeGrant({ actorId, grantId } = {}) {
        const tool = 'brick-exchange.revoke';
        if (typeof grantId !== 'string' || grantId.trim().length === 0) {
            return errorEnvelope('INVALID_GRANT_ID', 'grantId is required', null, tool);
        }
        if (typeof actorId !== 'string' || actorId.trim().length === 0) {
            return errorEnvelope('REVOKE_DENIED', 'actorId is required to revoke grant', null, tool);
        }

        const grantRow = sqliteHandle.queryOne('SELECT * FROM grants WHERE id = ?', [
            grantId.trim(),
        ]);
        if (!grantRow) {
            return errorEnvelope(
                'GRANT_NOT_FOUND',
                `Grant "${grantId}" does not exist`,
                null,
                tool
            );
        }

        const existingGrant = hydrateGrantRow(grantRow);
        const actor = getMember(actorId);
        const issuer = getMember(existingGrant.issuerId);
        const storedBundle = lookupStoredBundle(existingGrant.brickId, existingGrant.sourceHash);
        const ownerOrgId = storedBundle?.orgId || issuer?.orgId || null;
        const ownerOrg = ownerOrgId ? getOrg(ownerOrgId) : null;

        const isSameOrgPublisher =
            Boolean(actor) &&
            Boolean(ownerOrg) &&
            actor.orgId === ownerOrg.id &&
            actor.publisher === true &&
            (!Array.isArray(ownerOrg.publishers) || ownerOrg.publishers.includes(actor.id));

        if (!actor || (actor.id !== existingGrant.issuerId && !isSameOrgPublisher)) {
            return errorEnvelope(
                'REVOKE_DENIED',
                'Only the grant issuer or an authorized publisher in the source organization may revoke this grant',
                null,
                tool
            );
        }

        const revokedAt = new Date(safeNowMs()).toISOString();
        sqliteHandle.run(
            'UPDATE grants SET revoked = 1, revoked_at = ? WHERE id = ?',
            [revokedAt, existingGrant.id]
        );

        const updatedGrant = hydrateGrantRow(
            sqliteHandle.queryOne('SELECT * FROM grants WHERE id = ?', [existingGrant.id])
        );

        const auditRes = auditLog.append({
            tenantId: ownerOrgId || actor.orgId,
            actor: actor.id,
            action: 'grant.revoke',
            resource: `grant:${existingGrant.id}`,
            outcome: 'SUCCESS',
            metadata: {
                grantId: existingGrant.id,
                brickId: existingGrant.brickId,
                sourceHash: existingGrant.sourceHash,
            },
        });
        if (!auditRes.ok) {
            return auditRes;
        }

        return okEnvelope(tool, `Revoked grant "${existingGrant.id}"`, {
            grant: updatedGrant,
        });
    }

    function listGrants({ brickId = null, recipientId = null } = {}) {
        const rows =
            typeof brickId === 'string' && brickId.trim().length > 0
                ? sqliteHandle.query(
                      'SELECT * FROM grants WHERE brick_id = ? ORDER BY created_at DESC, id ASC',
                      [brickId.trim()]
                  )
                : sqliteHandle.query('SELECT * FROM grants ORDER BY created_at DESC, id ASC');

        let grants = rows.map((r) => hydrateGrantRow(r)).filter(Boolean);
        if (typeof recipientId === 'string' && recipientId.trim().length > 0) {
            const targetRecipient = recipientId.trim();
            grants = grants.filter((g) => g.recipients.includes(targetRecipient));
        }
        return grants;
    }

    function evaluateVisibilityForBundle(viewer, viewerOrg, bundle, evalNowMs) {
        const sourceOrg = getOrg(bundle.orgId);
        if (!sourceOrg) {
            return { allowed: false, policy: null };
        }

        if (viewer.orgId === bundle.orgId) {
            const teamRes = canReceiveBrick({
                recipient: viewer,
                recipientOrg: viewerOrg,
                sourceOrg,
                bundle,
                grant: null,
                nowMs: evalNowMs,
            });
            return { allowed: Boolean(teamRes?.ok), policy: teamRes };
        }

        const candidateGrantRows = sqliteHandle.query(
            'SELECT * FROM grants WHERE brick_id = ? AND source_hash = ? AND revoked = 0 ORDER BY created_at DESC, id ASC',
            [bundle.brickId, bundle.lineage.sourceHash]
        );

        let lastDenied = null;
        for (const gRow of candidateGrantRows) {
            const grant = hydrateGrantRow(gRow);
            if (!grant || !grant.recipients.includes(viewer.id)) {
                continue;
            }
            const issuer = getMember(grant.issuerId);
            const grantRes = canReceiveBrick({
                recipient: viewer,
                recipientOrg: viewerOrg,
                sourceOrg,
                issuer,
                bundle,
                grant,
                nowMs: evalNowMs,
            });
            if (grantRes?.ok) {
                return { allowed: true, policy: grantRes };
            }
            lastDenied = grantRes;
        }

        if (lastDenied) {
            return { allowed: false, policy: lastDenied };
        }

        const fallbackDenied = canReceiveBrick({
            recipient: viewer,
            recipientOrg: viewerOrg,
            sourceOrg,
            bundle,
            grant: null,
            nowMs: evalNowMs,
        });
        return { allowed: false, policy: fallbackDenied };
    }

    function countAdoptionsForBrick(brickId, sourceHash) {
        const row = sqliteHandle.queryOne(
            'SELECT COUNT(*) AS cnt FROM adoptions WHERE brick_id = ? AND source_hash = ?',
            [brickId, sourceHash]
        );
        return Number(row?.cnt ?? 0);
    }

    function getVisibleBrick({
        viewerId,
        brickId,
        sourceHash = null,
        nowMs = safeNowMs(),
    } = {}) {
        const tool = 'brick-exchange.brick';
        if (
            typeof viewerId !== 'string' ||
            viewerId.trim().length === 0 ||
            typeof brickId !== 'string' ||
            brickId.trim().length === 0
        ) {
            return errorEnvelope('ACCESS_DENIED', 'Brick access denied', null, tool);
        }

        const viewer = getMember(viewerId);
        const viewerOrg = viewer ? getOrg(viewer.orgId) : null;
        if (!viewer || !viewerOrg) {
            return errorEnvelope('ACCESS_DENIED', 'Brick access denied', null, tool);
        }

        const candidateRows =
            typeof sourceHash === 'string' && sourceHash.trim().length > 0
                ? sqliteHandle.query(
                      'SELECT bundle_json FROM sealed_bricks WHERE brick_id = ? AND source_hash = ?',
                      [brickId.trim(), sourceHash.trim()]
                  )
                : sqliteHandle.query(
                      'SELECT bundle_json FROM sealed_bricks WHERE brick_id = ? ORDER BY published_at DESC, rowid DESC',
                      [brickId.trim()]
                  );

        if (candidateRows.length === 0) {
            return errorEnvelope('ACCESS_DENIED', 'Brick access denied', null, tool);
        }

        for (const row of candidateRows) {
            let bundle;
            try {
                bundle = JSON.parse(String(row.bundle_json));
            } catch {
                continue;
            }
            const vis = evaluateVisibilityForBundle(viewer, viewerOrg, bundle, nowMs);
            if (vis.allowed) {
                const adoptionCount = countAdoptionsForBrick(
                    bundle.brickId,
                    bundle.lineage.sourceHash
                );
                return okEnvelope(
                    tool,
                    `Authorized visibility for sealed brick "${bundle.brickId}"`,
                    {
                        brick: bundle,
                        bundle,
                        adoptionCount,
                        access: vis.policy.data,
                    }
                );
            }
        }

        return errorEnvelope('ACCESS_DENIED', 'Brick access denied', null, tool);
    }

    function listVisibleBricks({
        viewerId,
        query = '',
        nowMs = safeNowMs(),
    } = {}) {
        const tool = 'brick-exchange.bricks';
        if (typeof viewerId !== 'string' || viewerId.trim().length === 0) {
            return errorEnvelope('VIEWER_REQUIRED', 'viewerId is required', null, tool);
        }

        const viewer = getMember(viewerId);
        const viewerOrg = viewer ? getOrg(viewer.orgId) : null;
        if (!viewer || !viewerOrg) {
            return okEnvelope(tool, 'Listed 0 visible bricks', { bricks: [] });
        }

        const allRows = sqliteHandle.query(
            'SELECT brick_id, source_hash, bundle_json FROM sealed_bricks ORDER BY published_at DESC, brick_id ASC'
        );

        const authorizedItems = [];
        for (const row of allRows) {
            let bundle;
            try {
                bundle = JSON.parse(String(row.bundle_json));
            } catch {
                continue;
            }
            const vis = evaluateVisibilityForBundle(viewer, viewerOrg, bundle, nowMs);
            if (!vis.allowed) {
                continue;
            }
            authorizedItems.push({
                key: `${bundle.brickId}:${bundle.lineage.sourceHash}`,
                bundle,
                access: vis.policy.data,
            });
        }

        const trimmedQuery = String(query ?? '').trim();
        let filteredItems = authorizedItems;

        if (trimmedQuery.length > 0 && authorizedItems.length > 0) {
            const matchedKeys = new Set();
            if (ftsSupported) {
                const escapedFts = escapeFts5Query(trimmedQuery, {
                    operator: 'OR',
                    prefixLastToken: true,
                });
                if (escapedFts.length > 0) {
                    try {
                        const ftsRows = sqliteHandle.query(
                            'SELECT brick_id, source_hash FROM sealed_bricks_fts WHERE sealed_bricks_fts MATCH ? ORDER BY bm25(sealed_bricks_fts)',
                            [escapedFts]
                        );
                        for (const fRow of ftsRows) {
                            matchedKeys.add(`${fRow.brick_id}:${fRow.source_hash}`);
                        }
                    } catch {
                        // Fall back cleanly to authorized in-memory token match
                    }
                }
            }

            const queryTokens = trimmedQuery
                .toLowerCase()
                .split(/\s+/)
                .filter((t) => t.length > 0);

            for (const item of authorizedItems) {
                if (matchedKeys.has(item.key)) continue;
                const haystack = [
                    item.bundle.brickId,
                    item.bundle.name,
                    item.bundle.summary,
                    item.bundle.replacesBoilerplate,
                    ...(Array.isArray(item.bundle.capabilities) ? item.bundle.capabilities : []),
                ]
                    .join(' ')
                    .toLowerCase();
                if (queryTokens.every((tok) => haystack.includes(tok))) {
                    matchedKeys.add(item.key);
                }
            }

            filteredItems = authorizedItems.filter((item) => matchedKeys.has(item.key));
        }

        const bricks = filteredItems.map((item) => ({
            ...item.bundle,
            adoptionCount: countAdoptionsForBrick(
                item.bundle.brickId,
                item.bundle.lineage.sourceHash
            ),
            access: item.access,
        }));

        return okEnvelope(tool, `Listed ${bricks.length} visible brick(s)`, { bricks });
    }

    async function suggestRecipients({
        actorId,
        brickId,
        sourceHash = null,
        repoSignalsByOrg = {},
        repoRoot = null,
        nowMs = safeNowMs(),
    } = {}) {
        const tool = 'brick-exchange.suggest';
        if (typeof actorId !== 'string' || actorId.trim().length === 0) {
            return errorEnvelope('ACTOR_REQUIRED', 'actorId is required', null, tool);
        }
        if (typeof brickId !== 'string' || brickId.trim().length === 0) {
            return errorEnvelope('BRICK_REQUIRED', 'brickId is required', null, tool);
        }

        const actor = getMember(actorId);
        if (!actor) {
            return errorEnvelope('ACTOR_NOT_FOUND', `Actor "${actorId}" was not found`, null, tool);
        }

        const bundle = lookupStoredBundle(brickId, sourceHash);
        if (!bundle) {
            return errorEnvelope('BRICK_NOT_FOUND', `Sealed brick "${brickId}" was not found`, null, tool);
        }

        const sealCheck = verifyBrickBundle(bundle);
        if (!sealCheck.ok) {
            return sealCheck;
        }

        const sourceOrg = getOrg(bundle.orgId);
        if (!sourceOrg || sourceOrg.participating === false) {
            return errorEnvelope(
                'SUGGEST_DENIED',
                'Source organization does not exist or is not participating',
                null,
                tool
            );
        }

        const isAuthorOrOrgExporter =
            actor.orgId === sourceOrg.id &&
            (actor.id === bundle.authorId || Boolean(actor.exporter) === true);
        if (!isAuthorOrOrgExporter) {
            return errorEnvelope(
                'SUGGEST_DENIED',
                'Actor must be the brick author or an exporter in the source organization',
                null,
                tool
            );
        }

        let scoutByProject = new Map();
        let globalScoutSignals = [];
        if (typeof repoRoot === 'string' && repoRoot.trim().length > 0) {
            const scoutRes = scoutHomelabLegoCandidates(repoRoot.trim(), {
                minProjects: 1,
                portablePaths: true,
            });
            if (scoutRes?.ok && scoutRes.data) {
                for (const finding of scoutRes.data.adoptionFindings || []) {
                    if (finding && typeof finding.project === 'string') {
                        scoutByProject.set(finding.project, [
                            ...(finding.rulesTriggered || []),
                            ...(finding.recommendedBricks || []),
                        ]);
                    }
                }
                for (const cluster of scoutRes.data.candidateClusters || []) {
                    if (cluster && typeof cluster.id === 'string') {
                        globalScoutSignals.push(cluster.id);
                        for (const proj of cluster.projects || []) {
                            const prev = scoutByProject.get(proj) || [];
                            prev.push(cluster.id);
                            scoutByProject.set(proj, prev);
                        }
                    }
                }
            }
        }

        const brickCapabilities = normalizeCapabilitySet(bundle.capabilities);
        const brickKeywords = extractMeaningfulKeywords([
            bundle.name,
            bundle.summary,
            bundle.replacesBoilerplate,
            ...(Array.isArray(bundle.capabilities) ? bundle.capabilities : []),
        ]);
        const brickBoilerplateTokens = extractBoilerplateTokens([
            bundle.brickId,
            bundle.replacesBoilerplate,
            ...(Array.isArray(bundle.capabilities) ? bundle.capabilities : []),
        ]);

        const allOrgs = new Map();
        for (const o of listOrgs()) {
            allOrgs.set(o.id, o);
        }

        const allMembers = listMembers();
        const hydraCacheByOrg = new Map();
        const hydraReady =
            Boolean(hydraClient) &&
            typeof hydraClient.isConfigured === 'function' &&
            hydraClient.isConfigured();

        const suggestions = [];

        for (const member of allMembers) {
            if (member.id === actor.id || member.id === bundle.authorId) {
                continue;
            }

            const targetOrg = allOrgs.get(member.orgId);
            if (!targetOrg || targetOrg.participating === false) {
                continue;
            }

            const sameOrg = member.orgId === sourceOrg.id;
            let structuralPolicy;
            if (sameOrg) {
                structuralPolicy = canReceiveBrick({
                    recipient: member,
                    recipientOrg: targetOrg,
                    sourceOrg,
                    bundle,
                    grant: null,
                    nowMs,
                });
            } else {
                const previewGrant = {
                    id: 'grant_eligibility_probe',
                    brickId: bundle.brickId,
                    sourceHash: bundle.lineage.sourceHash,
                    issuerId: actor.id,
                    scope: 'federated',
                    recipients: [member.id],
                    expiresAt: new Date(nowMs + 86_400_000).toISOString(),
                    revoked: false,
                    reshare: false,
                };
                structuralPolicy = canReceiveBrick({
                    recipient: member,
                    recipientOrg: targetOrg,
                    sourceOrg,
                    issuer: actor,
                    bundle,
                    grant: previewGrant,
                    nowMs,
                });
            }

            // Never evaluate relevance or query HydraDB for unauthorized candidates
            if (!structuralPolicy || !structuralPolicy.ok) {
                continue;
            }

            const targetBrief = getWorkflowBrief(targetOrg.id);
            const targetCapSet = normalizeCapabilitySet([
                ...(targetBrief?.capabilities || []),
                ...(member.capabilities || []),
            ]);

            const matchedCapabilities = [];
            for (const cap of brickCapabilities) {
                if (targetCapSet.has(cap)) {
                    matchedCapabilities.push(cap);
                }
            }
            matchedCapabilities.sort();

            const targetKeywordSet = extractMeaningfulKeywords([
                targetBrief?.brief || '',
                ...(targetBrief?.capabilities || []),
                ...(member.capabilities || []),
            ]);
            const matchedKeywords = [];
            for (const kw of brickKeywords) {
                if (targetKeywordSet.has(kw)) {
                    matchedKeywords.push(kw);
                }
            }
            matchedKeywords.sort();

            const rawOrgSignals =
                isPlainObject(repoSignalsByOrg) && Object.hasOwn(repoSignalsByOrg, targetOrg.id)
                    ? flattenRepoSignalStrings(repoSignalsByOrg[targetOrg.id])
                    : [];
            const scoutSignals = scoutByProject.get(targetOrg.id) || globalScoutSignals;
            const candidateBoilerplateSet = extractBoilerplateTokens([
                ...(targetBrief?.boilerplateSignals || []),
                ...rawOrgSignals,
                ...scoutSignals,
            ]);

            const matchedBoilerplate = [];
            for (const bp of brickBoilerplateTokens) {
                if (candidateBoilerplateSet.has(bp)) {
                    matchedBoilerplate.push(bp);
                }
            }
            matchedBoilerplate.sort();

            // Prior adoption signal (same brickClass or overlapping capabilities)
            const priorRows = sqliteHandle.query(
                `SELECT sb.brick_class, sb.capabilities_json
                 FROM adoptions a
                 JOIN sealed_bricks sb
                   ON sb.brick_id = a.brick_id AND sb.source_hash = a.source_hash
                 WHERE a.user_id = ?`,
                [member.id]
            );
            let priorReuseMatched = false;
            for (const pRow of priorRows) {
                if (
                    bundle.brickClass &&
                    bundle.brickClass !== 'general' &&
                    pRow.brick_class === bundle.brickClass
                ) {
                    priorReuseMatched = true;
                    break;
                }
                const prevCaps = normalizeCapabilitySet(parseJsonArraySafe(pRow.capabilities_json));
                for (const cap of brickCapabilities) {
                    if (prevCaps.has(cap)) {
                        priorReuseMatched = true;
                        break;
                    }
                }
                if (priorReuseMatched) break;
            }

            let hydraScore = 0;
            let hydraRequestId = null;
            if (hydraReady && targetBrief?.revision) {
                if (!hydraCacheByOrg.has(targetOrg.id)) {
                    const collection = sanitizeOrgCollectionName(targetOrg.id);
                    try {
                        const queryText = `${bundle.name}: ${bundle.summary}`.slice(0, 1000);
                        const hydraRes = await hydraClient.queryContext({
                            database: hydraDatabase,
                            collections: [collection],
                            query: queryText,
                            type: 'knowledge',
                            mode: 'fast',
                            maxResults: 3,
                            graphContext: true,
                            metadataFilters: {
                                additional_metadata: { revision: targetBrief.revision },
                            },
                        });
                        hydraCacheByOrg.set(targetOrg.id, extractHydraScoreAndRequestId(hydraRes));
                    } catch {
                        hydraCacheByOrg.set(targetOrg.id, { hydraScore: 0, hydraRequestId: null });
                    }
                }
                const cachedHydra = hydraCacheByOrg.get(targetOrg.id);
                hydraScore = cachedHydra.hydraScore;
                hydraRequestId = cachedHydra.hydraRequestId;
            }

            // Require at least 1 concrete evidence match (compatible schema alone is insufficient)
            const hasConcreteEvidence =
                matchedCapabilities.length >= 1 ||
                matchedKeywords.length >= 1 ||
                matchedBoilerplate.length >= 1 ||
                hydraScore >= 0.65;

            if (!hasConcreteEvidence) {
                continue;
            }

            const rawScore =
                matchedCapabilities.length * 0.35 +
                Math.min(matchedKeywords.length, 5) * 0.12 +
                matchedBoilerplate.length * 0.3 +
                (priorReuseMatched ? 0.1 : 0) +
                (hydraScore > 0 ? hydraScore * 0.25 : 0);
            const score = Number(rawScore.toFixed(4));

            const reasonParts = [];
            if (matchedCapabilities.length > 0) {
                reasonParts.push(`capabilities [${matchedCapabilities.join(', ')}]`);
            }
            if (matchedBoilerplate.length > 0) {
                reasonParts.push(`boilerplate [${matchedBoilerplate.join(', ')}]`);
            }
            if (matchedKeywords.length > 0) {
                reasonParts.push(`workflow keywords [${matchedKeywords.slice(0, 5).join(', ')}]`);
            }
            if (hydraScore >= 0.65) {
                reasonParts.push(`HydraDB brief similarity (${hydraScore.toFixed(2)})`);
            }
            if (priorReuseMatched) {
                reasonParts.push('prior related brick adoption');
            }

            const deliveryChannel = sameOrg ? 'team-commons' : 'requires-grant';

            suggestions.push({
                memberId: member.id,
                memberName: member.name,
                orgId: targetOrg.id,
                orgName: targetOrg.name,
                deliveryChannel,
                score,
                matchedCapabilities,
                matchedKeywords,
                matchedBoilerplate,
                hydraScore,
                hydraRequestId,
                reason: `Matched ${reasonParts.join('; ')}`,
            });
        }

        suggestions.sort(
            (a, b) =>
                b.score - a.score ||
                a.orgId.localeCompare(b.orgId) ||
                a.memberId.localeCompare(b.memberId)
        );

        return okEnvelope(
            tool,
            `Identified ${suggestions.length} eligible recipient suggestion(s) for "${bundle.brickId}"`,
            { suggestions }
        );
    }

    async function recordAdoption({
        userId,
        brickId,
        sourceHash = null,
        grantId = null,
        bindingHash = '',
        localChecksPassed = true,
        hydraRequestId = null,
        nowMs = safeNowMs(),
    } = {}) {
        const tool = 'brick-exchange.adopt';
        if (localChecksPassed !== true) {
            return errorEnvelope(
                'LOCAL_VERIFICATION_REQUIRED',
                'Recipient must verify sealed brick locally (localChecksPassed === true) before recording adoption',
                { brickId, userId },
                tool
            );
        }

        const visibleRes = getVisibleBrick({
            viewerId: userId,
            brickId,
            sourceHash,
            nowMs,
        });
        if (!visibleRes.ok) {
            return visibleRes;
        }

        const viewer = getMember(userId);
        const resolvedBundle = visibleRes.data.brick;
        const resolvedSourceHash = resolvedBundle.lineage.sourceHash;
        const effectiveGrantId =
            (typeof grantId === 'string' && grantId.trim().length > 0 ? grantId.trim() : null) ||
            visibleRes.data.access?.grantId ||
            null;
        const cleanHydraReqId =
            typeof hydraRequestId === 'string' && hydraRequestId.trim().length > 0
                ? hydraRequestId.trim()
                : null;
        const adoptedAt = new Date(nowMs).toISOString();

        const adoption = {
            id: `adopt_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
            userId: viewer.id,
            orgId: viewer.orgId,
            brickId: resolvedBundle.brickId,
            sourceHash: resolvedSourceHash,
            grantId: effectiveGrantId,
            bindingHash: String(bindingHash || ''),
            localChecksPassed: true,
            hydraRequestId: cleanHydraReqId,
            adoptedAt,
        };

        sqliteHandle.run(
            `INSERT INTO adoptions (
                id, user_id, org_id, brick_id, source_hash,
                grant_id, binding_hash, local_checks_passed, hydra_request_id, adopted_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
            [
                adoption.id,
                adoption.userId,
                adoption.orgId,
                adoption.brickId,
                adoption.sourceHash,
                adoption.grantId,
                adoption.bindingHash,
                adoption.hydraRequestId,
                adoption.adoptedAt,
            ]
        );

        const auditRes = auditLog.append({
            tenantId: viewer.orgId,
            actor: viewer.id,
            action: 'brick.adopt',
            resource: `brick:${adoption.brickId}@${adoption.sourceHash}`,
            outcome: 'SUCCESS',
            metadata: {
                adoptionId: adoption.id,
                brickId: adoption.brickId,
                sourceHash: adoption.sourceHash,
                grantId: adoption.grantId,
                bindingHash: adoption.bindingHash,
            },
        });
        if (!auditRes.ok) {
            return auditRes;
        }

        if (
            hydraClient &&
            typeof hydraClient.isConfigured === 'function' &&
            hydraClient.isConfigured() &&
            cleanHydraReqId &&
            typeof hydraClient.submitFeedback === 'function'
        ) {
            try {
                await hydraClient.submitFeedback({
                    requestId: cleanHydraReqId,
                    rating: 'positive',
                    source: 'user',
                    database: hydraDatabase,
                    metadata: {
                        brickId: adoption.brickId,
                        sourceHash: adoption.sourceHash,
                        userId: adoption.userId,
                    },
                });
            } catch {
                // Non-throwing telemetry feedback per HydraDB v2 contract
            }
        }

        return okEnvelope(
            tool,
            `Recorded verified adoption of "${adoption.brickId}" by "${adoption.userId}"`,
            { adoption }
        );
    }

    function listAdoptions({ brickId = null, orgId = null } = {}) {
        const clauses = [];
        const params = [];
        if (typeof brickId === 'string' && brickId.trim().length > 0) {
            clauses.push('brick_id = ?');
            params.push(brickId.trim());
        }
        if (typeof orgId === 'string' && orgId.trim().length > 0) {
            clauses.push('org_id = ?');
            params.push(orgId.trim());
        }
        const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
        const rows = sqliteHandle.query(
            `SELECT * FROM adoptions ${whereSql} ORDER BY adopted_at DESC, id ASC`,
            params
        );
        return rows.map((r) => hydrateAdoptionRow(r)).filter(Boolean);
    }

    function getPortfolioStats() {
        const tool = 'brick-exchange.stats';
        const orgCount = Number(
            sqliteHandle.queryOne('SELECT COUNT(*) AS cnt FROM orgs')?.cnt ?? 0
        );
        const liveOrgCount = Number(
            sqliteHandle.queryOne(
                'SELECT COUNT(*) AS cnt FROM orgs WHERE participating = 1'
            )?.cnt ?? 0
        );
        const memberCount = Number(
            sqliteHandle.queryOne('SELECT COUNT(*) AS cnt FROM members')?.cnt ?? 0
        );
        const sealedBrickCount = Number(
            sqliteHandle.queryOne('SELECT COUNT(*) AS cnt FROM sealed_bricks')?.cnt ?? 0
        );
        const adoptionCount = Number(
            sqliteHandle.queryOne('SELECT COUNT(*) AS cnt FROM adoptions')?.cnt ?? 0
        );
        const hoursRow = sqliteHandle.queryOne(
            `SELECT COALESCE(SUM(sb.estimated_hours_saved), 0) AS total_hours
             FROM adoptions a
             JOIN sealed_bricks sb
               ON sb.brick_id = a.brick_id AND sb.source_hash = a.source_hash`
        );
        const estimatedHoursSavedTotal = Number(
            Number(hoursRow?.total_hours ?? 0).toFixed(2)
        );
        const auditStatus = auditLog.verify();

        return okEnvelope(tool, 'Computed brick exchange portfolio statistics', {
            orgCount,
            liveOrgCount,
            memberCount,
            sealedBrickCount,
            adoptionCount,
            estimatedHoursSavedTotal,
            auditStatus,
        });
    }

    function verifyLedger() {
        return auditLog.verify();
    }

    function close() {
        auditLog.close();
        sqliteHandle.close();
        return okEnvelope('brick-exchange.close', 'Closed brick exchange store', {
            closed: true,
        });
    }

    return Object.freeze({
        upsertOrg,
        getOrg,
        listOrgs,
        upsertMember,
        getMember,
        listMembers,
        setWorkflowBrief,
        getWorkflowBrief,
        publishSealedBrick,
        issueGrant,
        revokeGrant,
        listGrants,
        getVisibleBrick,
        listVisibleBricks,
        suggestRecipients,
        recordAdoption,
        listAdoptions,
        getPortfolioStats,
        verifyLedger,
        close,
    });
}

/**
 * Execute a cryptographically sealed brick bundle locally against a recipient's
 * sample input and Hexagonal `binding` adapter with zero network upload (`INV-LEGO-35`).
 *
 * @param {object} [options={}]
 */
export async function tryBrickLocally({
    bundle,
    binding = {},
    sampleInput,
    customRunner = null,
    timeoutMs,
    maxMemoryMb,
} = {}) {
    const tool = 'brick-exchange.try';
    const sealCheck = verifyBrickBundle(bundle);
    if (!sealCheck || !sealCheck.ok) {
        return errorEnvelope(
            sealCheck?.error?.code || 'INVALID_BRICK_BUNDLE',
            sealCheck?.error?.message || 'Sealed brick bundle verification failed',
            sealCheck?.error?.details ?? null,
            tool
        );
    }

    const inputSchema = bundle.blueprint?.inputSchema;
    if (inputSchema !== undefined && inputSchema !== null) {
        const inRes = validateSchema(inputSchema, sampleInput, {
            stripUnknown: false,
            tool,
        });
        if (!inRes.ok) {
            return errorEnvelope(
                'SAMPLE_INPUT_INVALID',
                `Recipient sampleInput failed brick inputSchema validation: ${inRes.error.message}`,
                inRes.error.details ?? null,
                tool
            );
        }
    }

    const execRes = await executeInBrickSandbox({
        source: bundle.source,
        exportName: bundle.blueprint?.exportName || 'default',
        input: sampleInput,
        binding,
        customRunner,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(maxMemoryMb !== undefined ? { maxMemoryMb } : {}),
    });

    if (!execRes || !execRes.ok) {
        return errorEnvelope(
            execRes?.error?.code || 'SANDBOX_EXECUTION_ERROR',
            execRes?.error?.message || 'Sealed brick execution failed on local sample',
            execRes?.error?.details ?? null,
            tool
        );
    }

    const outputSchema = bundle.blueprint?.outputSchema;
    if (outputSchema !== undefined && outputSchema !== null) {
        const outRes = validateSchema(outputSchema, execRes.data.output, {
            stripUnknown: false,
            tool,
        });
        if (!outRes.ok) {
            return errorEnvelope(
                'SAMPLE_OUTPUT_INVALID',
                `Brick sandbox output failed outputSchema validation: ${outRes.error.message}`,
                outRes.error.details ?? null,
                tool
            );
        }
    }

    const bindingHash = computeBindingHash(binding);

    return okEnvelope(
        tool,
        `Verified sealed brick "${bundle.brickId}" locally against recipient sample`,
        {
            brickId: bundle.brickId,
            sourceHash: bundle.lineage.sourceHash,
            bindingHash,
            output: execRes.data.output,
            durationMs: execRes.data.durationMs,
        }
    );
}

/**
 * Vendor a verified sealed brick bundle into `<targetRepoDir>/bricks/<brickId>/`,
 * scaffold a non-destructive local `binding.js` if absent, and pin provenance in
 * `<targetRepoDir>/.brick-lock.json` (`INV-LEGO-35`).
 *
 * @param {object} [options={}]
 */
export async function adoptBrickIntoRepo({
    bundle,
    targetRepoDir,
    bindingSource = null,
    grantId = null,
    adoptedBy = 'local-dev',
    sampleInput = undefined,
    binding = {},
    customRunner = null,
} = {}) {
    const tool = 'brick-exchange.adopt-repo';
    const sealCheck = verifyBrickBundle(bundle);
    if (!sealCheck || !sealCheck.ok) {
        return errorEnvelope(
            sealCheck?.error?.code || 'INVALID_BRICK_BUNDLE',
            sealCheck?.error?.message || 'Sealed brick bundle verification failed',
            sealCheck?.error?.details ?? null,
            tool
        );
    }

    if (typeof targetRepoDir !== 'string' || targetRepoDir.trim().length === 0) {
        return errorEnvelope(
            'INVALID_TARGET_REPO',
            'targetRepoDir must be a non-empty directory path',
            null,
            tool
        );
    }

    if (typeof bundle.brickId !== 'string' || !SAFE_SLUG_RE.test(bundle.brickId)) {
        return errorEnvelope(
            'INVALID_BRICK_ID',
            'Brick identifier must match /^[a-z0-9][a-z0-9-_]{1,63}$/',
            { brickId: bundle.brickId },
            tool
        );
    }

    if (sampleInput !== undefined) {
        const tryRes = await tryBrickLocally({
            bundle,
            binding,
            sampleInput,
            customRunner,
        });
        if (!tryRes.ok) {
            return tryRes;
        }
    }

    const resolvedTargetInput = path.resolve(targetRepoDir);
    fs.mkdirSync(resolvedTargetInput, { recursive: true });
    const realRepoDir = fs.realpathSync(resolvedTargetInput);

    const bricksRootDir = path.join(realRepoDir, 'bricks');
    if (fs.existsSync(bricksRootDir)) {
        const lst = fs.lstatSync(bricksRootDir);
        if (lst.isSymbolicLink()) {
            return errorEnvelope(
                'BRICK_PATH_ESCAPE',
                'Refusing to vendor into symbolic link directory bricks/',
                null,
                tool
            );
        }
    }
    fs.mkdirSync(bricksRootDir, { recursive: true });

    const brickDir = path.join(bricksRootDir, bundle.brickId);
    if (fs.existsSync(brickDir)) {
        const lst = fs.lstatSync(brickDir);
        if (lst.isSymbolicLink()) {
            return errorEnvelope(
                'BRICK_PATH_ESCAPE',
                `Refusing to vendor into symbolic link bricks/${bundle.brickId}`,
                null,
                tool
            );
        }
    }
    fs.mkdirSync(brickDir, { recursive: true });

    const realBrickDir = fs.realpathSync(brickDir);
    if (!isPathStrictlyInside(realBrickDir, realRepoDir)) {
        return errorEnvelope(
            'BRICK_PATH_ESCAPE',
            'Resolved brick directory escapes target repository root',
            null,
            tool
        );
    }

    const entryFileName = bundle.blueprint?.language === 'ts' ? 'index.ts' : 'index.js';
    const entryPath = path.join(realBrickDir, entryFileName);
    const bundleSealPath = path.join(realBrickDir, 'bundle.seal.json');
    const bindingPath = path.join(realBrickDir, 'binding.js');
    const lockfilePath = path.join(realRepoDir, '.brick-lock.json');

    for (const candidateFile of [entryPath, bundleSealPath, bindingPath, lockfilePath]) {
        if (fs.existsSync(candidateFile) && fs.lstatSync(candidateFile).isSymbolicLink()) {
            return errorEnvelope(
                'BRICK_PATH_ESCAPE',
                `Refusing to write through symbolic link: ${path.basename(candidateFile)}`,
                null,
                tool
            );
        }
    }

    fs.writeFileSync(entryPath, bundle.source, 'utf8');
    fs.writeFileSync(bundleSealPath, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');

    if (!fs.existsSync(bindingPath)) {
        const starterBinding =
            typeof bindingSource === 'string' && bindingSource.length > 0
                ? bindingSource
                : `// Local adapter binding for ${bundle.brickId}\nexport const binding = {};\n`;
        fs.writeFileSync(bindingPath, starterBinding, 'utf8');
    }

    let lockData = { version: 1, bricks: {} };
    if (fs.existsSync(lockfilePath)) {
        try {
            const parsed = JSON.parse(fs.readFileSync(lockfilePath, 'utf8'));
            if (isPlainObject(parsed) && isPlainObject(parsed.bricks)) {
                lockData = {
                    version: Number.isInteger(parsed.version) ? parsed.version : 1,
                    bricks: { ...parsed.bricks },
                };
            }
        } catch {
            return errorEnvelope(
                'BRICK_LOCKFILE_CORRUPT',
                'Existing .brick-lock.json contains malformed JSON',
                { lockfilePath },
                tool
            );
        }
    }

    lockData.bricks[bundle.brickId] = {
        brickId: bundle.brickId,
        relativePath: `bricks/${bundle.brickId}/${entryFileName}`,
        bundlePath: `bricks/${bundle.brickId}/bundle.seal.json`,
        sourceHash: bundle.lineage.sourceHash,
        blueprintHash: bundle.lineage.blueprintHash,
        contractHash: bundle.lineage.contractHash,
        keyId: bundle.attestation.keyId,
        publicKeyPem: bundle.attestation.publicKeyPem,
        signature: bundle.attestation.signature,
        authorId: bundle.authorId,
        orgId: bundle.orgId,
        grantId: grantId || null,
        adoptedBy: String(adoptedBy || 'local-dev'),
        adoptedAt: new Date().toISOString(),
    };

    const sortedBricks = {};
    for (const key of Object.keys(lockData.bricks).sort()) {
        if (FORBIDDEN_OBJECT_KEYS.has(key)) continue;
        sortedBricks[key] = lockData.bricks[key];
    }

    const deterministicLock = {
        version: lockData.version,
        bricks: sortedBricks,
    };
    fs.writeFileSync(lockfilePath, `${JSON.stringify(deterministicLock, null, 2)}\n`, 'utf8');

    return okEnvelope(
        tool,
        `Vendored sealed brick "${bundle.brickId}" into ${path.join('bricks', bundle.brickId)}`,
        {
            brickId: bundle.brickId,
            sourceHash: bundle.lineage.sourceHash,
            entryPath,
            bindingPath,
            bundlePath: bundleSealPath,
            lockfilePath,
        }
    );
}

/**
 * Audit `<targetRepoDir>/.brick-lock.json` against vendored brick files on disk,
 * flagging 1-byte source edits (`BRICK_SOURCE_DRIFT`), tampered seals (`BRICK_SEAL_INVALID`),
 * missing vendored files (`BRICK_SOURCE_MISSING`), or symlink escapes (`BRICK_PATH_ESCAPE`).
 *
 * @param {string} targetRepoDir
 */
export function auditRepoBrickLocks(targetRepoDir) {
    const tool = 'brick-exchange.audit-locks';
    if (typeof targetRepoDir !== 'string' || targetRepoDir.trim().length === 0) {
        return errorEnvelope(
            'INVALID_TARGET_REPO',
            'targetRepoDir must be a non-empty path',
            null,
            tool
        );
    }

    const resolvedInput = path.resolve(targetRepoDir);
    if (!fs.existsSync(resolvedInput)) {
        return okEnvelope(tool, 'No .brick-lock.json present (0 vendored bricks)', {
            lockfilePresent: false,
            lockedBrickCount: 0,
            clean: true,
            findings: [],
        });
    }

    let baseDir = resolvedInput;
    try {
        const st = fs.statSync(resolvedInput);
        if (st.isFile()) {
            baseDir = path.dirname(resolvedInput);
        }
    } catch {
        return okEnvelope(tool, 'No .brick-lock.json present (0 vendored bricks)', {
            lockfilePresent: false,
            lockedBrickCount: 0,
            clean: true,
            findings: [],
        });
    }

    const realRepoDir = fs.realpathSync(baseDir);
    const lockfilePath = path.join(realRepoDir, '.brick-lock.json');

    let lockLstat = null;
    try {
        lockLstat = fs.lstatSync(lockfilePath);
    } catch {
        lockLstat = null;
    }

    if (!lockLstat) {
        return okEnvelope(tool, 'No .brick-lock.json present (0 vendored bricks)', {
            lockfilePresent: false,
            lockedBrickCount: 0,
            clean: true,
            findings: [],
        });
    }

    if (lockLstat.isSymbolicLink()) {
        const findings = [
            {
                ruleId: 'BRICK_PATH_ESCAPE',
                brickId: null,
                file: '.brick-lock.json',
                message: '.brick-lock.json must not be a symbolic link',
            },
        ];
        return okEnvelope(tool, 'Brick lock audit found 1 integrity violation(s)', {
            lockfilePresent: true,
            lockedBrickCount: 0,
            clean: false,
            findings,
        });
    }

    let parsedLock;
    try {
        parsedLock = JSON.parse(fs.readFileSync(lockfilePath, 'utf8'));
    } catch {
        const findings = [
            {
                ruleId: 'BRICK_LOCKFILE_CORRUPT',
                brickId: null,
                file: '.brick-lock.json',
                message: 'Failed to parse .brick-lock.json as valid JSON',
            },
        ];
        return okEnvelope(tool, 'Brick lock audit found 1 integrity violation(s)', {
            lockfilePresent: true,
            lockedBrickCount: 0,
            clean: false,
            findings,
        });
    }

    if (!isPlainObject(parsedLock) || !isPlainObject(parsedLock.bricks)) {
        const findings = [
            {
                ruleId: 'BRICK_LOCKFILE_CORRUPT',
                brickId: null,
                file: '.brick-lock.json',
                message: '.brick-lock.json must contain a plain "bricks" object map',
            },
        ];
        return okEnvelope(tool, 'Brick lock audit found 1 integrity violation(s)', {
            lockfilePresent: true,
            lockedBrickCount: 0,
            clean: false,
            findings,
        });
    }

    const findings = [];
    const brickKeys = Object.keys(parsedLock.bricks)
        .filter((k) => !FORBIDDEN_OBJECT_KEYS.has(k))
        .sort();

    for (const key of brickKeys) {
        const entry = parsedLock.bricks[key];
        const brickId = isPlainObject(entry) && typeof entry.brickId === 'string' ? entry.brickId : key;

        if (!isPlainObject(entry) || typeof entry.relativePath !== 'string' || !entry.relativePath.trim()) {
            findings.push({
                ruleId: 'BRICK_LOCK_ENTRY_INVALID',
                brickId,
                file: '.brick-lock.json',
                message: `Lock entry for "${brickId}" is missing relativePath`,
            });
            continue;
        }

        const relSource = entry.relativePath;
        if (path.isAbsolute(relSource)) {
            findings.push({
                ruleId: 'BRICK_PATH_ESCAPE',
                brickId,
                file: relSource,
                message: `Vendored brick "${brickId}" relativePath must not be absolute`,
            });
            continue;
        }

        const candidateSourceAbs = path.resolve(realRepoDir, relSource);
        if (!isPathStrictlyInside(candidateSourceAbs, realRepoDir)) {
            findings.push({
                ruleId: 'BRICK_PATH_ESCAPE',
                brickId,
                file: relSource,
                message: `Vendored brick "${brickId}" path escapes repository root`,
            });
            continue;
        }

        let sourceLstat = null;
        try {
            sourceLstat = fs.lstatSync(candidateSourceAbs);
        } catch {
            sourceLstat = null;
        }

        if (!sourceLstat) {
            findings.push({
                ruleId: 'BRICK_SOURCE_MISSING',
                brickId,
                file: relSource,
                message: `Vendored brick source file "${relSource}" is missing`,
            });
            continue;
        }

        let realSourceAbs;
        try {
            realSourceAbs = fs.realpathSync(candidateSourceAbs);
        } catch {
            realSourceAbs = '';
        }

        if (
            sourceLstat.isSymbolicLink() ||
            !realSourceAbs ||
            !isPathStrictlyInside(realSourceAbs, realRepoDir)
        ) {
            findings.push({
                ruleId: 'BRICK_PATH_ESCAPE',
                brickId,
                file: relSource,
                message: `Vendored brick "${brickId}" traverses a symbolic link or escapes repository root`,
            });
            continue;
        }

        const diskSource = fs.readFileSync(realSourceAbs, 'utf8');
        const actualHash = canonicalBrickHash(diskSource);
        if (actualHash !== entry.sourceHash) {
            findings.push({
                ruleId: 'BRICK_SOURCE_DRIFT',
                brickId,
                file: relSource,
                expectedHash: entry.sourceHash,
                actualHash,
                message: `Vendored brick "${brickId}" source drifted from sealed SHA-256 digest`,
            });
        }

        const relBundle =
            typeof entry.bundlePath === 'string' && entry.bundlePath.trim().length > 0
                ? entry.bundlePath
                : `bricks/${brickId}/bundle.seal.json`;

        if (path.isAbsolute(relBundle)) {
            findings.push({
                ruleId: 'BRICK_PATH_ESCAPE',
                brickId,
                file: relBundle,
                message: `Vendored brick "${brickId}" bundlePath must not be absolute`,
            });
            continue;
        }

        const candidateBundleAbs = path.resolve(realRepoDir, relBundle);
        if (!isPathStrictlyInside(candidateBundleAbs, realRepoDir)) {
            findings.push({
                ruleId: 'BRICK_PATH_ESCAPE',
                brickId,
                file: relBundle,
                message: `Vendored brick "${brickId}" bundlePath escapes repository root`,
            });
            continue;
        }

        if (fs.existsSync(candidateBundleAbs)) {
            const bundleLstat = fs.lstatSync(candidateBundleAbs);
            let realBundleAbs = '';
            try {
                realBundleAbs = fs.realpathSync(candidateBundleAbs);
            } catch {
                realBundleAbs = '';
            }
            if (
                bundleLstat.isSymbolicLink() ||
                !realBundleAbs ||
                !isPathStrictlyInside(realBundleAbs, realRepoDir)
            ) {
                findings.push({
                    ruleId: 'BRICK_PATH_ESCAPE',
                    brickId,
                    file: relBundle,
                    message: `Vendored brick "${brickId}" bundle.seal.json traverses a symbolic link`,
                });
                continue;
            }

            let parsedBundle;
            try {
                parsedBundle = JSON.parse(fs.readFileSync(realBundleAbs, 'utf8'));
            } catch {
                findings.push({
                    ruleId: 'BRICK_SEAL_INVALID',
                    brickId,
                    file: relBundle,
                    message: `Vendored bundle.seal.json for "${brickId}" contains invalid JSON`,
                });
                continue;
            }

            const sealRes = verifyBrickBundle(parsedBundle, {
                trustedPublicKeyPem: entry.publicKeyPem || null,
            });
            if (
                !sealRes.ok ||
                parsedBundle?.lineage?.sourceHash !== entry.sourceHash ||
                (entry.signature && parsedBundle?.attestation?.signature !== entry.signature)
            ) {
                findings.push({
                    ruleId: 'BRICK_SEAL_INVALID',
                    brickId,
                    file: relBundle,
                    message:
                        sealRes?.error?.message ||
                        `Cryptographic seal mismatch for vendored brick "${brickId}"`,
                });
            }
        }
    }

    const clean = findings.length === 0;
    const summary = clean
        ? `Verified ${brickKeys.length} locked brick(s) with 0 drift findings`
        : `Brick lock audit found ${findings.length} integrity violation(s) across ${brickKeys.length} locked brick(s)`;

    return okEnvelope(tool, summary, {
        lockfilePresent: true,
        lockedBrickCount: brickKeys.length,
        clean,
        findings,
    });
}
