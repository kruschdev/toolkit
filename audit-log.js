/**
 * @module @krusch/toolkit/audit-log
 * @description Tamper-evident SHA-256 / HMAC-SHA256 hash-chained compliance ledger (`INV-LEGO-32`).
 *
 * Provides:
 * - Deterministic RFC-8785-style canonical JSON serialization (`canonicalizeAuditPayload`)
 * - Domain-separated SHA-256 & HMAC-SHA256 entry hashing (`computeAuditEntryHash`)
 * - Constant-time $O(N)$ contiguous chain, tamper, and tail-truncation verification (`verifyAuditChain`)
 * - Fail-closed in-memory & durable `node:sqlite` WAL append-only ledger with SQLite
 *   `BEFORE UPDATE` / `BEFORE DELETE` immutability triggers (`createAuditLog`)
 *
 * Zero external npm packages (`node:crypto`, `node:sqlite`, `node:fs`, `node:path` + `./http.js`).
 */

import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { dirname } from 'node:path';
import { okEnvelope, errorEnvelope } from './http.js';

/**
 * Canonical 64-character lowercase hex genesis hash anchoring `seq = 1`.
 */
export const GENESIS_AUDIT_HASH = '0'.repeat(64);

const HEX64_RE = /^[0-9a-f]{64}$/;
const TABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_SQLITE_PREFIX_RE = /^sqlite_/i;
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;
const FORBIDDEN_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const HMAC_DOMAIN_PREFIX = 'krusch-audit-v1:';

function resolveToolName(rawTool, fallback) {
    return typeof rawTool === 'string' && rawTool.trim().length > 0 ? rawTool.trim() : fallback;
}

function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

function hasLoneSurrogate(str) {
    if (typeof str.isWellFormed === 'function') {
        return !str.isWellFormed();
    }
    for (let i = 0; i < str.length; i++) {
        const code = str.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff) {
            if (i + 1 >= str.length) return true;
            const next = str.charCodeAt(i + 1);
            if (next < 0xdc00 || next > 0xdfff) return true;
            i += 1;
        } else if (code >= 0xdc00 && code <= 0xdfff) {
            return true;
        }
    }
    return false;
}

function hasForbiddenPrototypeKeys(value, seen = new WeakSet()) {
    if (value === null || typeof value !== 'object') {
        return false;
    }
    if (seen.has(value)) {
        return false;
    }
    seen.add(value);

    try {
        const ownNames = Object.getOwnPropertyNames(value);
        for (let i = 0; i < ownNames.length; i++) {
            const key = ownNames[i];
            if (FORBIDDEN_OBJECT_KEYS.has(key)) {
                return true;
            }
            if (Array.isArray(value) && key === 'length') {
                continue;
            }
            if (hasForbiddenPrototypeKeys(value[key], seen)) {
                return true;
            }
        }
    } catch {
        return true;
    }
    return false;
}

function constantTimeHexEqual(actual, expectedHex64) {
    const expectedBuf = Buffer.from(expectedHex64, 'utf8');
    if (typeof actual !== 'string') {
        crypto.timingSafeEqual(expectedBuf, expectedBuf);
        return false;
    }
    const actualBuf = Buffer.from(actual, 'utf8');
    if (actualBuf.length !== expectedBuf.length) {
        crypto.timingSafeEqual(expectedBuf, expectedBuf);
        return false;
    }
    return crypto.timingSafeEqual(actualBuf, expectedBuf);
}

function deepFreezeClone(value) {
    if (value === null || value === undefined) {
        return value;
    }
    if (typeof value === 'number') {
        return Object.is(value, -0) ? 0 : value;
    }
    if (typeof value !== 'object') {
        return value;
    }
    if (
        value instanceof Boolean ||
        value instanceof Number ||
        value instanceof String
    ) {
        const unboxed = value.valueOf();
        return typeof unboxed === 'number' && Object.is(unboxed, -0) ? 0 : unboxed;
    }
    if (value instanceof Date) {
        const ms = value.getTime();
        return Number.isFinite(ms) ? value.toISOString() : null;
    }
    if (Array.isArray(value)) {
        const arr = value.map((item) => (item === undefined ? null : deepFreezeClone(item)));
        return Object.freeze(arr);
    }
    const out = {};
    const keys = Object.keys(value).sort();
    for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (!FORBIDDEN_OBJECT_KEYS.has(k) && value[k] !== undefined) {
            out[k] = deepFreezeClone(value[k]);
        }
    }
    return Object.freeze(out);
}

function createFrozenAuditEntry({
    seq,
    timestamp,
    tenantId,
    actor,
    action,
    resource,
    outcome,
    metadata,
    prevHash,
    entryHash,
}) {
    return Object.freeze({
        seq,
        timestamp,
        tenantId,
        actor,
        action,
        resource,
        outcome,
        metadata: deepFreezeClone(metadata),
        prevHash,
        entryHash,
    });
}

function createTailSnapshot(entry) {
    if (!entry) {
        return Object.freeze({
            seq: 0,
            tailHash: GENESIS_AUDIT_HASH,
            entry: null,
        });
    }
    return Object.freeze({
        seq: entry.seq,
        tailHash: entry.entryHash,
        entry,
    });
}

/**
 * Deterministically serialize an arbitrary JSON-compatible value following RFC-8785-style
 * canonicalization rules without throwing on untrusted inputs.
 *
 * - Sorts own enumerable string keys lexicographically (`Object.keys(val).sort()`), ignoring prototype properties
 * - Normalizes `-0` to `0`
 * - Omits `undefined` object property values (`undefined` array elements and root `undefined` serialize as `null`)
 * - Rejects circular references (`AUDIT_CIRCULAR_PAYLOAD`), `maxDepth` overflow (`AUDIT_MAX_DEPTH`),
 *   lone UTF-16 surrogates (`AUDIT_INVALID_UNICODE`), and `BigInt`/`Symbol`/`Function`/`NaN`/`Infinity` (`AUDIT_NONFINITE_VALUE`)
 *
 * @param {unknown} value - Input payload to canonicalize
 * @param {{ maxDepth?: number, tool?: string }} [options={}]
 * @returns {{ ok: true, tool: string, summary: string, data: { canonicalJson: string } } | { ok: false, tool: string, summary: string, error: { code: string, message: string, details?: unknown } }}
 */
export function canonicalizeAuditPayload(value, options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    const resolvedTool = resolveToolName(opts.tool, 'audit.canonicalize');
    const maxDepth = opts.maxDepth === undefined ? 32 : opts.maxDepth;

    if (!Number.isSafeInteger(maxDepth) || maxDepth < 0) {
        return errorEnvelope(
            'AUDIT_MAX_DEPTH',
            'maxDepth must be a non-negative safe integer',
            { maxDepth },
            resolvedTool
        );
    }

    const ancestors = new Set();

    function serializeNode(node, depth, path) {
        if (node === null || node === undefined) {
            return { ok: true, json: 'null' };
        }

        let current = node;
        if (current instanceof Boolean || current instanceof Number || current instanceof String) {
            current = current.valueOf();
        }

        const type = typeof current;

        if (type === 'boolean') {
            return { ok: true, json: current ? 'true' : 'false' };
        }

        if (type === 'number') {
            if (!Number.isFinite(current)) {
                return {
                    ok: false,
                    code: 'AUDIT_NONFINITE_VALUE',
                    message: `Non-finite numeric value encountered at ${path}`,
                    details: { path, valueType: 'number' },
                };
            }
            if (Object.is(current, -0) || current === 0) {
                return { ok: true, json: '0' };
            }
            return { ok: true, json: JSON.stringify(current) };
        }

        if (type === 'string') {
            if (hasLoneSurrogate(current)) {
                return {
                    ok: false,
                    code: 'AUDIT_INVALID_UNICODE',
                    message: `Lone UTF-16 surrogate encountered in string at ${path}`,
                    details: { path },
                };
            }
            return { ok: true, json: JSON.stringify(current) };
        }

        if (type === 'bigint' || type === 'symbol' || type === 'function') {
            return {
                ok: false,
                code: 'AUDIT_NONFINITE_VALUE',
                message: `Unsupported ${type} value encountered at ${path}`,
                details: { path, valueType: type },
            };
        }

        if (current instanceof Date) {
            const ms = current.getTime();
            if (!Number.isFinite(ms)) {
                return {
                    ok: false,
                    code: 'AUDIT_NONFINITE_VALUE',
                    message: `Invalid Date encountered at ${path}`,
                    details: { path, valueType: 'Date' },
                };
            }
            return { ok: true, json: JSON.stringify(current.toISOString()) };
        }

        if (ancestors.has(current)) {
            return {
                ok: false,
                code: 'AUDIT_CIRCULAR_PAYLOAD',
                message: `Circular reference detected at ${path}`,
                details: { path },
            };
        }

        const nextDepth = depth + 1;
        if (nextDepth > maxDepth) {
            return {
                ok: false,
                code: 'AUDIT_MAX_DEPTH',
                message: `Payload exceeded maxDepth (${maxDepth}) at ${path}`,
                details: { path, maxDepth },
            };
        }

        ancestors.add(current);
        try {
            if (Array.isArray(current)) {
                const parts = new Array(current.length);
                for (let i = 0; i < current.length; i++) {
                    const elem = current[i] === undefined ? null : current[i];
                    const elemRes = serializeNode(elem, nextDepth, `${path}[${i}]`);
                    if (!elemRes.ok) {
                        return elemRes;
                    }
                    parts[i] = elemRes.json;
                }
                return { ok: true, json: `[${parts.join(',')}]` };
            }

            if (
                current instanceof Map ||
                current instanceof Set ||
                current instanceof WeakMap ||
                current instanceof WeakSet ||
                current instanceof RegExp ||
                typeof current.then === 'function'
            ) {
                return {
                    ok: false,
                    code: 'AUDIT_NONFINITE_VALUE',
                    message: `Unsupported non-plain object encountered at ${path}`,
                    details: { path, valueType: Object.prototype.toString.call(current) },
                };
            }

            const keys = Object.keys(current).sort();
            const parts = [];
            for (let i = 0; i < keys.length; i++) {
                const key = keys[i];
                if (hasLoneSurrogate(key)) {
                    return {
                        ok: false,
                        code: 'AUDIT_INVALID_UNICODE',
                        message: `Lone UTF-16 surrogate encountered in property key at ${path}`,
                        details: { path },
                    };
                }
                const propVal = current[key];
                if (propVal === undefined) {
                    continue;
                }
                const valRes = serializeNode(propVal, nextDepth, `${path}.${key}`);
                if (!valRes.ok) {
                    return valRes;
                }
                parts.push(`${JSON.stringify(key)}:${valRes.json}`);
            }
            return { ok: true, json: `{${parts.join(',')}}` };
        } finally {
            ancestors.delete(current);
        }
    }

    try {
        const res = serializeNode(value, 0, '$');
        if (!res.ok) {
            return errorEnvelope(res.code, res.message, res.details, resolvedTool);
        }
        return okEnvelope(resolvedTool, 'Audit payload canonicalized', {
            canonicalJson: res.json,
        });
    } catch (err) {
        if (err instanceof RangeError) {
            return errorEnvelope(
                'AUDIT_MAX_DEPTH',
                'Payload recursion depth exceeded runtime stack bounds',
                { maxDepth },
                resolvedTool
            );
        }
        return errorEnvelope(
            'AUDIT_INVALID_PAYLOAD',
            err instanceof Error ? err.message : 'Failed to canonicalize audit payload',
            null,
            resolvedTool
        );
    }
}

function validateAndNormalizeEntryFields(entryInput, resolvedTool) {
    if (!isPlainObject(entryInput)) {
        return {
            ok: false,
            envelope: errorEnvelope(
                'AUDIT_INVALID_ENTRY',
                'Audit entry input must be a plain object',
                { field: 'entryInput' },
                resolvedTool
            ),
        };
    }

    const seq = Object.hasOwn(entryInput, 'seq') ? entryInput.seq : undefined;
    if (!Number.isSafeInteger(seq) || seq < 1) {
        return {
            ok: false,
            envelope: errorEnvelope(
                'AUDIT_INVALID_ENTRY',
                'seq must be a safe integer >= 1',
                { field: 'seq', seq },
                resolvedTool
            ),
        };
    }

    const timestamp = Object.hasOwn(entryInput, 'timestamp') ? entryInput.timestamp : undefined;
    if (
        typeof timestamp !== 'string' ||
        timestamp.trim().length === 0 ||
        CONTROL_CHAR_RE.test(timestamp)
    ) {
        return {
            ok: false,
            envelope: errorEnvelope(
                'AUDIT_INVALID_ENTRY',
                'timestamp must be a non-empty string free of ASCII control characters',
                { field: 'timestamp' },
                resolvedTool
            ),
        };
    }

    const actor = Object.hasOwn(entryInput, 'actor') ? entryInput.actor : undefined;
    if (typeof actor !== 'string' || actor.trim().length === 0 || CONTROL_CHAR_RE.test(actor)) {
        return {
            ok: false,
            envelope: errorEnvelope(
                'AUDIT_INVALID_ENTRY',
                'actor must be a non-empty string free of ASCII control characters',
                { field: 'actor' },
                resolvedTool
            ),
        };
    }

    const action = Object.hasOwn(entryInput, 'action') ? entryInput.action : undefined;
    if (typeof action !== 'string' || action.trim().length === 0 || CONTROL_CHAR_RE.test(action)) {
        return {
            ok: false,
            envelope: errorEnvelope(
                'AUDIT_INVALID_ENTRY',
                'action must be a non-empty string free of ASCII control characters',
                { field: 'action' },
                resolvedTool
            ),
        };
    }

    const rawResource = Object.hasOwn(entryInput, 'resource') ? entryInput.resource : undefined;
    const resource = rawResource === undefined ? '' : rawResource;
    if (typeof resource !== 'string' || CONTROL_CHAR_RE.test(resource)) {
        return {
            ok: false,
            envelope: errorEnvelope(
                'AUDIT_INVALID_ENTRY',
                'resource must be a string free of ASCII control characters',
                { field: 'resource' },
                resolvedTool
            ),
        };
    }

    const rawTenantId = Object.hasOwn(entryInput, 'tenantId') ? entryInput.tenantId : undefined;
    const tenantId = rawTenantId === undefined ? '' : rawTenantId;
    if (typeof tenantId !== 'string' || CONTROL_CHAR_RE.test(tenantId)) {
        return {
            ok: false,
            envelope: errorEnvelope(
                'AUDIT_INVALID_ENTRY',
                'tenantId must be a string free of ASCII control characters',
                { field: 'tenantId' },
                resolvedTool
            ),
        };
    }

    const rawOutcome = Object.hasOwn(entryInput, 'outcome') ? entryInput.outcome : undefined;
    const outcome = rawOutcome === undefined ? 'SUCCESS' : rawOutcome;
    if (
        typeof outcome !== 'string' ||
        outcome.trim().length === 0 ||
        CONTROL_CHAR_RE.test(outcome)
    ) {
        return {
            ok: false,
            envelope: errorEnvelope(
                'AUDIT_INVALID_ENTRY',
                'outcome must be a non-empty string free of ASCII control characters',
                { field: 'outcome' },
                resolvedTool
            ),
        };
    }

    const prevHash = Object.hasOwn(entryInput, 'prevHash') ? entryInput.prevHash : undefined;
    if (typeof prevHash !== 'string' || !HEX64_RE.test(prevHash)) {
        return {
            ok: false,
            envelope: errorEnvelope(
                'AUDIT_INVALID_ENTRY',
                'prevHash must be a 64-character lowercase hex digest',
                { field: 'prevHash' },
                resolvedTool
            ),
        };
    }

    const rawMetadata = Object.hasOwn(entryInput, 'metadata') ? entryInput.metadata : undefined;
    const metadata = rawMetadata === undefined ? {} : rawMetadata;
    if (!isPlainObject(metadata) || hasForbiddenPrototypeKeys(metadata)) {
        return {
            ok: false,
            envelope: errorEnvelope(
                'AUDIT_INVALID_ENTRY',
                'metadata must be a plain object free of forbidden prototype keys',
                { field: 'metadata' },
                resolvedTool
            ),
        };
    }

    return {
        ok: true,
        normalized: {
            seq,
            timestamp,
            tenantId,
            actor,
            action,
            resource,
            outcome,
            metadata,
            prevHash,
        },
    };
}

/**
 * Compute the canonical SHA-256 (or domain-separated HMAC-SHA256) hex digest for an audit entry.
 *
 * @param {Record<string, unknown>} entryInput - Candidate entry fields
 * @param {{ hmacSecret?: string, tool?: string }} [options={}]
 * @returns {{ ok: true, tool: string, summary: string, data: { entryHash: string, canonicalJson: string } } | { ok: false, tool: string, summary: string, error: { code: string, message: string, details?: unknown } }}
 */
export function computeAuditEntryHash(entryInput, options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    const resolvedTool = resolveToolName(opts.tool, 'audit.hash');
    const hmacSecret = opts.hmacSecret === undefined ? '' : opts.hmacSecret;

    if (typeof hmacSecret !== 'string') {
        return errorEnvelope(
            'AUDIT_INVALID_HMAC_SECRET',
            'hmacSecret must be a string',
            { field: 'hmacSecret' },
            resolvedTool
        );
    }

    const check = validateAndNormalizeEntryFields(entryInput, resolvedTool);
    if (!check.ok) {
        return check.envelope;
    }

    const canonRes = canonicalizeAuditPayload(check.normalized, { tool: resolvedTool });
    if (!canonRes.ok) {
        return canonRes;
    }

    const { canonicalJson } = canonRes.data;
    const entryHash =
        hmacSecret.length > 0
            ? crypto
                  .createHmac('sha256', hmacSecret)
                  .update(`${HMAC_DOMAIN_PREFIX}${canonicalJson}`, 'utf8')
                  .digest('hex')
            : crypto.createHash('sha256').update(canonicalJson, 'utf8').digest('hex');

    return okEnvelope(resolvedTool, 'Audit entry hash computed', {
        entryHash,
        canonicalJson,
    });
}

/**
 * Non-throwing $O(N)$ audit chain verifier checking contiguous sequence numbers,
 * constant-time `prevHash` linkage, constant-time `entryHash` integrity, and optional
 * `expectedTailHash` truncation detection.
 *
 * @param {ReadonlyArray<Record<string, unknown>>} entries - Ordered audit chain slice
 * @param {{ expectedGenesisHash?: string, expectedTailHash?: string, hmacSecret?: string, startSeq?: number, tool?: string }} [options={}]
 * @returns {{ ok: true, tool: string, summary: string, data: { valid: true, verifiedCount: number, headHash: string, tailHash: string } } | { ok: false, tool: string, summary: string, error: { code: string, message: string, details?: unknown } }}
 */
export function verifyAuditChain(entries, options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    const resolvedTool = resolveToolName(opts.tool, 'audit.verify');

    if (!Array.isArray(entries)) {
        return errorEnvelope(
            'AUDIT_INVALID_CHAIN_INPUT',
            'Audit chain entries must be an array',
            null,
            resolvedTool
        );
    }

    const expectedGenesisHash =
        opts.expectedGenesisHash === undefined ? GENESIS_AUDIT_HASH : opts.expectedGenesisHash;
    const expectedTailHash = opts.expectedTailHash === undefined ? '' : opts.expectedTailHash;
    const hmacSecret = opts.hmacSecret === undefined ? '' : opts.hmacSecret;
    const startSeq = opts.startSeq === undefined ? 1 : opts.startSeq;

    if (typeof hmacSecret !== 'string') {
        return errorEnvelope(
            'AUDIT_INVALID_HMAC_SECRET',
            'hmacSecret must be a string',
            { field: 'hmacSecret' },
            resolvedTool
        );
    }

    if (typeof expectedGenesisHash !== 'string' || !HEX64_RE.test(expectedGenesisHash)) {
        return errorEnvelope(
            'AUDIT_INVALID_CHAIN_INPUT',
            'expectedGenesisHash must be a 64-character lowercase hex digest',
            { field: 'expectedGenesisHash' },
            resolvedTool
        );
    }

    if (typeof expectedTailHash !== 'string') {
        return errorEnvelope(
            'AUDIT_INVALID_CHAIN_INPUT',
            'expectedTailHash must be a string',
            { field: 'expectedTailHash' },
            resolvedTool
        );
    }

    if (!Number.isSafeInteger(startSeq) || startSeq < 1) {
        return errorEnvelope(
            'AUDIT_INVALID_CHAIN_INPUT',
            'startSeq must be a safe integer >= 1',
            { startSeq },
            resolvedTool
        );
    }

    let expectedPrevHash = expectedGenesisHash;

    for (let index = 0; index < entries.length; index++) {
        const entry = entries[index];
        if (!isPlainObject(entry)) {
            return errorEnvelope(
                'AUDIT_INVALID_ENTRY',
                `Audit entry at index ${index} must be a plain object`,
                { index },
                resolvedTool
            );
        }

        const expectedSeq = startSeq + index;
        const actualSeq = Object.hasOwn(entry, 'seq') ? entry.seq : undefined;
        if (!Number.isSafeInteger(actualSeq) || actualSeq !== expectedSeq) {
            return errorEnvelope(
                'AUDIT_SEQUENCE_GAP',
                `Audit sequence gap at index ${index}: expected seq ${expectedSeq}, got ${String(actualSeq)}`,
                { index, expectedSeq, actualSeq },
                resolvedTool
            );
        }

        const actualPrevHash = Object.hasOwn(entry, 'prevHash') ? entry.prevHash : undefined;
        if (!constantTimeHexEqual(actualPrevHash, expectedPrevHash)) {
            return errorEnvelope(
                'AUDIT_CHAIN_BROKEN',
                `Audit hash chain broken at seq ${expectedSeq}`,
                { index, seq: expectedSeq },
                resolvedTool
            );
        }

        const hashRes = computeAuditEntryHash(
            {
                seq: actualSeq,
                timestamp: Object.hasOwn(entry, 'timestamp') ? entry.timestamp : undefined,
                tenantId: Object.hasOwn(entry, 'tenantId') ? entry.tenantId : '',
                actor: Object.hasOwn(entry, 'actor') ? entry.actor : undefined,
                action: Object.hasOwn(entry, 'action') ? entry.action : undefined,
                resource: Object.hasOwn(entry, 'resource') ? entry.resource : '',
                outcome: Object.hasOwn(entry, 'outcome') ? entry.outcome : 'SUCCESS',
                metadata: Object.hasOwn(entry, 'metadata') ? entry.metadata : {},
                prevHash: expectedPrevHash,
            },
            { hmacSecret, tool: resolvedTool }
        );

        if (!hashRes.ok) {
            return hashRes;
        }

        const actualEntryHash = Object.hasOwn(entry, 'entryHash') ? entry.entryHash : undefined;
        if (!constantTimeHexEqual(actualEntryHash, hashRes.data.entryHash)) {
            return errorEnvelope(
                'AUDIT_ENTRY_TAMPERED',
                `Audit entry hash mismatch at seq ${expectedSeq}`,
                { index, seq: expectedSeq },
                resolvedTool
            );
        }

        expectedPrevHash = hashRes.data.entryHash;
    }

    const headHash = entries.length > 0 ? String(entries[0].entryHash) : expectedGenesisHash;
    const tailHash = expectedPrevHash;

    if (expectedTailHash !== '' && !constantTimeHexEqual(expectedTailHash, tailHash)) {
        return errorEnvelope(
            'AUDIT_TAIL_MISMATCH',
            'Audit chain tail hash does not match expected tail hash',
            { verifiedCount: entries.length, actualTailHash: tailHash },
            resolvedTool
        );
    }

    return okEnvelope(resolvedTool, `Audit chain verified (${entries.length} entries)`, {
        valid: true,
        verifiedCount: entries.length,
        headHash,
        tailHash,
    });
}

function resolveInjectedSqliteDb(dbCandidate) {
    if (dbCandidate === null || dbCandidate === undefined) {
        return null;
    }
    if (
        typeof dbCandidate === 'object' &&
        typeof dbCandidate.exec === 'function' &&
        typeof dbCandidate.prepare === 'function'
    ) {
        return dbCandidate;
    }
    if (
        typeof dbCandidate === 'object' &&
        dbCandidate.db &&
        typeof dbCandidate.db === 'object' &&
        typeof dbCandidate.db.exec === 'function' &&
        typeof dbCandidate.db.prepare === 'function'
    ) {
        return dbCandidate.db;
    }
    throw new TypeError(
        'createAuditLog requires db to be a node:sqlite DatabaseSync instance or null'
    );
}

function hydrateSqliteRow(row, verifyTool) {
    let parsedMetadata;
    try {
        parsedMetadata = JSON.parse(String(row.metadata_json));
    } catch {
        return {
            ok: false,
            envelope: errorEnvelope(
                'AUDIT_ENTRY_TAMPERED',
                `Corrupted metadata_json at seq ${String(row.seq)}`,
                { seq: Number(row.seq) },
                verifyTool
            ),
        };
    }

    if (!isPlainObject(parsedMetadata) || hasForbiddenPrototypeKeys(parsedMetadata)) {
        return {
            ok: false,
            envelope: errorEnvelope(
                'AUDIT_ENTRY_TAMPERED',
                `Invalid metadata object at seq ${String(row.seq)}`,
                { seq: Number(row.seq) },
                verifyTool
            ),
        };
    }

    const entry = createFrozenAuditEntry({
        seq: Number(row.seq),
        timestamp: String(row.timestamp),
        tenantId: String(row.tenant_id),
        actor: String(row.actor),
        action: String(row.action),
        resource: String(row.resource),
        outcome: String(row.outcome),
        metadata: parsedMetadata,
        prevHash: String(row.prev_hash),
        entryHash: String(row.entry_hash),
    });

    return { ok: true, entry };
}

function validateQueryFilters(rawFilters, queryTool) {
    if (rawFilters !== undefined && rawFilters !== null && !isPlainObject(rawFilters)) {
        return {
            ok: false,
            envelope: errorEnvelope(
                'AUDIT_INVALID_QUERY',
                'Query filters must be a plain object',
                null,
                queryTool
            ),
        };
    }

    const filters = rawFilters || {};
    const stringFields = [
        'tenantId',
        'actor',
        'action',
        'resource',
        'outcome',
        'fromTimestamp',
        'toTimestamp',
    ];
    for (let i = 0; i < stringFields.length; i++) {
        const name = stringFields[i];
        const val = Object.hasOwn(filters, name) ? filters[name] : undefined;
        if (val !== undefined && typeof val !== 'string') {
            return {
                ok: false,
                envelope: errorEnvelope(
                    'AUDIT_INVALID_QUERY',
                    `${name} filter must be a string`,
                    { field: name },
                    queryTool
                ),
            };
        }
    }

    const fromSeq = Object.hasOwn(filters, 'fromSeq') ? filters.fromSeq : undefined;
    if (fromSeq !== undefined && (!Number.isSafeInteger(fromSeq) || fromSeq < 1)) {
        return {
            ok: false,
            envelope: errorEnvelope(
                'AUDIT_INVALID_QUERY',
                'fromSeq must be a safe integer >= 1',
                { field: 'fromSeq', fromSeq },
                queryTool
            ),
        };
    }

    const toSeq = Object.hasOwn(filters, 'toSeq') ? filters.toSeq : undefined;
    if (toSeq !== undefined && (!Number.isSafeInteger(toSeq) || toSeq < 1)) {
        return {
            ok: false,
            envelope: errorEnvelope(
                'AUDIT_INVALID_QUERY',
                'toSeq must be a safe integer >= 1',
                { field: 'toSeq', toSeq },
                queryTool
            ),
        };
    }

    const rawOrder = Object.hasOwn(filters, 'order') ? filters.order : undefined;
    const order = rawOrder === undefined ? 'asc' : String(rawOrder).toLowerCase();
    if (order !== 'asc' && order !== 'desc') {
        return {
            ok: false,
            envelope: errorEnvelope(
                'AUDIT_INVALID_QUERY',
                "order must be 'asc' or 'desc'",
                { field: 'order', order: rawOrder },
                queryTool
            ),
        };
    }

    const limit = Object.hasOwn(filters, 'limit') ? filters.limit : undefined;
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
        return {
            ok: false,
            envelope: errorEnvelope(
                'AUDIT_INVALID_QUERY',
                'limit must be a safe integer >= 1',
                { field: 'limit', limit },
                queryTool
            ),
        };
    }

    const rawOffset = Object.hasOwn(filters, 'offset') ? filters.offset : undefined;
    const offset = rawOffset === undefined ? 0 : rawOffset;
    if (!Number.isSafeInteger(offset) || offset < 0) {
        return {
            ok: false,
            envelope: errorEnvelope(
                'AUDIT_INVALID_QUERY',
                'offset must be a safe integer >= 0',
                { field: 'offset', offset },
                queryTool
            ),
        };
    }

    return {
        ok: true,
        normalized: {
            tenantId: Object.hasOwn(filters, 'tenantId') ? filters.tenantId : undefined,
            actor: Object.hasOwn(filters, 'actor') ? filters.actor : undefined,
            action: Object.hasOwn(filters, 'action') ? filters.action : undefined,
            resource: Object.hasOwn(filters, 'resource') ? filters.resource : undefined,
            outcome: Object.hasOwn(filters, 'outcome') ? filters.outcome : undefined,
            fromSeq,
            toSeq,
            fromTimestamp: Object.hasOwn(filters, 'fromTimestamp')
                ? filters.fromTimestamp
                : undefined,
            toTimestamp: Object.hasOwn(filters, 'toTimestamp') ? filters.toTimestamp : undefined,
            order,
            limit,
            offset,
        },
    };
}

/**
 * Create an append-only tamper-evident compliance audit ledger backed either by bounded
 * fail-closed memory (`!sqlitePath && !db`) or durable `node:sqlite` (`DatabaseSync`) with
 * `BEFORE UPDATE` / `BEFORE DELETE` immutability triggers.
 *
 * @param {{
 *   sqlitePath?: string,
 *   db?: DatabaseSync | { db: DatabaseSync } | null,
 *   tableName?: string,
 *   hmacSecret?: string,
 *   maxEntries?: number,
 *   nowFn?: () => string,
 *   tool?: string
 * }} [options={}]
 */
export function createAuditLog(options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    const {
        sqlitePath = '',
        db = null,
        tableName = 'audit_ledger',
        hmacSecret = '',
        maxEntries = 50_000,
        nowFn = () => new Date().toISOString(),
        tool = 'audit.log',
    } = opts;

    if (
        typeof tableName !== 'string' ||
        !TABLE_NAME_RE.test(tableName) ||
        RESERVED_SQLITE_PREFIX_RE.test(tableName)
    ) {
        throw new RangeError(
            `Invalid audit tableName "${String(tableName)}": must match /^[A-Za-z_][A-Za-z0-9_]*$/ and not start with "sqlite_"`
        );
    }

    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
        throw new RangeError(
            `Invalid audit maxEntries "${String(maxEntries)}": must be an integer >= 1`
        );
    }

    if (typeof hmacSecret !== 'string') {
        throw new RangeError('createAuditLog requires hmacSecret to be a string');
    }

    if (typeof nowFn !== 'function') {
        throw new TypeError('createAuditLog requires nowFn to be a function');
    }

    if (sqlitePath !== undefined && sqlitePath !== null && typeof sqlitePath !== 'string') {
        throw new TypeError('createAuditLog requires sqlitePath to be a string');
    }

    const rawSqlitePath = sqlitePath ?? '';
    if (rawSqlitePath.length > 0 && rawSqlitePath.trim().length === 0) {
        throw new RangeError('createAuditLog sqlitePath cannot be whitespace-only');
    }
    const normalizedSqlitePath = rawSqlitePath.trim();
    const defaultTool = resolveToolName(tool, 'audit.log');

    const injectedDb = resolveInjectedSqliteDb(db);
    const ownsDb = !injectedDb && normalizedSqlitePath.length > 0;
    let sqliteDb = injectedDb;

    if (ownsDb) {
        if (normalizedSqlitePath !== ':memory:' && !normalizedSqlitePath.startsWith('file:')) {
            fs.mkdirSync(dirname(normalizedSqlitePath), { recursive: true });
        }
        sqliteDb = new DatabaseSync(normalizedSqlitePath);
    }

    if (sqliteDb) {
        try {
            sqliteDb.exec('PRAGMA busy_timeout = 5000;');
            if (ownsDb && normalizedSqlitePath !== ':memory:') {
                sqliteDb.exec('PRAGMA journal_mode = WAL;');
            }
            sqliteDb.exec('PRAGMA synchronous = FULL;');
            sqliteDb.exec('PRAGMA foreign_keys = ON;');

            sqliteDb.exec(`
                CREATE TABLE IF NOT EXISTS "${tableName}" (
                    seq INTEGER PRIMARY KEY,
                    timestamp TEXT NOT NULL,
                    tenant_id TEXT NOT NULL,
                    actor TEXT NOT NULL,
                    action TEXT NOT NULL,
                    resource TEXT NOT NULL,
                    outcome TEXT NOT NULL,
                    metadata_json TEXT NOT NULL,
                    prev_hash TEXT NOT NULL,
                    entry_hash TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS "idx_${tableName}_tenant_seq" ON "${tableName}" (tenant_id, seq);
                CREATE INDEX IF NOT EXISTS "idx_${tableName}_actor_seq" ON "${tableName}" (actor, seq);
                CREATE INDEX IF NOT EXISTS "idx_${tableName}_action_seq" ON "${tableName}" (action, seq);
                CREATE TRIGGER IF NOT EXISTS "trg_${tableName}_immutable_update"
                BEFORE UPDATE ON "${tableName}"
                BEGIN
                    SELECT RAISE(ABORT, 'AUDIT_LEDGER_IMMUTABLE');
                END;
                CREATE TRIGGER IF NOT EXISTS "trg_${tableName}_immutable_delete"
                BEFORE DELETE ON "${tableName}"
                BEGIN
                    SELECT RAISE(ABORT, 'AUDIT_LEDGER_IMMUTABLE');
                END;
            `);
        } catch (initErr) {
            if (ownsDb) {
                try {
                    sqliteDb.close();
                } catch {
                    // Best-effort cleanup of owned handle on initialization failure.
                }
            }
            throw initErr;
        }
    }

    const memoryEntries = [];
    let closed = false;
    let cachedTail = createTailSnapshot(null);

    if (sqliteDb) {
        const latestRow = sqliteDb
            .prepare(`SELECT * FROM "${tableName}" ORDER BY seq DESC LIMIT 1`)
            .get();
        if (latestRow) {
            const hydrated = hydrateSqliteRow(latestRow, defaultTool);
            if (hydrated.ok) {
                cachedTail = createTailSnapshot(hydrated.entry);
            }
        }
    }

    function append(record, appendOptions = {}) {
        const callOpts = appendOptions && typeof appendOptions === 'object' ? appendOptions : {};
        const callTool = resolveToolName(callOpts.tool, defaultTool);

        if (closed) {
            return errorEnvelope('AUDIT_LOG_CLOSED', 'Audit log handle is closed', null, callTool);
        }

        if (!isPlainObject(record)) {
            return errorEnvelope(
                'AUDIT_INVALID_ENTRY',
                'Audit record must be a plain object',
                { field: 'record' },
                callTool
            );
        }

        let resolvedTimestamp;
        if (Object.hasOwn(record, 'timestamp') && record.timestamp !== undefined) {
            resolvedTimestamp = record.timestamp;
        } else {
            try {
                resolvedTimestamp = nowFn();
            } catch (err) {
                return errorEnvelope(
                    'AUDIT_INVALID_ENTRY',
                    err instanceof Error ? err.message : 'Failed to generate audit timestamp',
                    { field: 'timestamp' },
                    callTool
                );
            }
        }

        const candidateBase = {
            timestamp: resolvedTimestamp,
            tenantId: Object.hasOwn(record, 'tenantId') ? record.tenantId : '',
            actor: Object.hasOwn(record, 'actor') ? record.actor : undefined,
            action: Object.hasOwn(record, 'action') ? record.action : undefined,
            resource: Object.hasOwn(record, 'resource') ? record.resource : '',
            outcome: Object.hasOwn(record, 'outcome') ? record.outcome : 'SUCCESS',
            metadata: Object.hasOwn(record, 'metadata') ? record.metadata : {},
        };

        // Pre-validate record fields before acquiring write lock or mutating memory.
        const preCheck = validateAndNormalizeEntryFields(
            { ...candidateBase, seq: 1, prevHash: GENESIS_AUDIT_HASH },
            callTool
        );
        if (!preCheck.ok) {
            return preCheck.envelope;
        }

        const metaCanonRes = canonicalizeAuditPayload(preCheck.normalized.metadata, {
            maxDepth: 31,
            tool: callTool,
        });
        if (!metaCanonRes.ok) {
            return metaCanonRes;
        }
        const canonicalMetadata = JSON.parse(metaCanonRes.data.canonicalJson);
        const normalizedBase = {
            ...preCheck.normalized,
            metadata: canonicalMetadata,
        };

        if (!sqliteDb) {
            if (memoryEntries.length >= maxEntries) {
                return errorEnvelope(
                    'AUDIT_LOG_CAPACITY_EXCEEDED',
                    `In-memory audit log reached maxEntries (${maxEntries}); failing closed`,
                    { maxEntries, currentEntries: memoryEntries.length },
                    callTool
                );
            }

            const prevEntry =
                memoryEntries.length > 0 ? memoryEntries[memoryEntries.length - 1] : null;
            const nextSeq = prevEntry ? prevEntry.seq + 1 : 1;
            const prevHash = prevEntry ? prevEntry.entryHash : GENESIS_AUDIT_HASH;

            const hashRes = computeAuditEntryHash(
                { ...normalizedBase, seq: nextSeq, prevHash },
                { hmacSecret, tool: callTool }
            );
            if (!hashRes.ok) {
                return hashRes;
            }

            const entry = createFrozenAuditEntry({
                ...normalizedBase,
                seq: nextSeq,
                prevHash,
                entryHash: hashRes.data.entryHash,
            });
            memoryEntries.push(entry);
            cachedTail = createTailSnapshot(entry);

            return okEnvelope(callTool, `Audit entry ${entry.seq} appended`, {
                entry,
                seq: entry.seq,
                prevHash: entry.prevHash,
                entryHash: entry.entryHash,
            });
        }

        let committed = false;
        try {
            sqliteDb.exec('BEGIN IMMEDIATE');

            const countRow = sqliteDb
                .prepare(`SELECT COUNT(*) AS cnt FROM "${tableName}"`)
                .get();
            const currentCount = Number(countRow?.cnt ?? 0);
            if (currentCount >= maxEntries) {
                sqliteDb.exec('ROLLBACK');
                committed = true;
                return errorEnvelope(
                    'AUDIT_LOG_CAPACITY_EXCEEDED',
                    `Audit log reached maxEntries (${maxEntries}); failing closed`,
                    { maxEntries, currentEntries: currentCount },
                    callTool
                );
            }

            const tailRow = sqliteDb
                .prepare(`SELECT seq, entry_hash FROM "${tableName}" ORDER BY seq DESC LIMIT 1`)
                .get();

            const nextSeq = tailRow ? Number(tailRow.seq) + 1 : 1;
            const prevHash = tailRow ? String(tailRow.entry_hash) : GENESIS_AUDIT_HASH;

            const hashRes = computeAuditEntryHash(
                { ...normalizedBase, seq: nextSeq, prevHash },
                { hmacSecret, tool: callTool }
            );
            if (!hashRes.ok) {
                sqliteDb.exec('ROLLBACK');
                committed = true;
                return hashRes;
            }

            sqliteDb
                .prepare(
                    `INSERT INTO "${tableName}" (
                        seq, timestamp, tenant_id, actor, action, resource, outcome, metadata_json, prev_hash, entry_hash
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                )
                .run(
                    nextSeq,
                    normalizedBase.timestamp,
                    normalizedBase.tenantId,
                    normalizedBase.actor,
                    normalizedBase.action,
                    normalizedBase.resource,
                    normalizedBase.outcome,
                    metaCanonRes.data.canonicalJson,
                    prevHash,
                    hashRes.data.entryHash
                );

            sqliteDb.exec('COMMIT');
            committed = true;

            const entry = createFrozenAuditEntry({
                ...normalizedBase,
                seq: nextSeq,
                prevHash,
                entryHash: hashRes.data.entryHash,
            });
            cachedTail = createTailSnapshot(entry);

            return okEnvelope(callTool, `Audit entry ${entry.seq} appended`, {
                entry,
                seq: entry.seq,
                prevHash: entry.prevHash,
                entryHash: entry.entryHash,
            });
        } catch (err) {
            if (!committed) {
                try {
                    sqliteDb.exec('ROLLBACK');
                } catch {
                    // Ignore secondary rollback error.
                }
            }
            return errorEnvelope(
                'AUDIT_STORAGE_ERROR',
                err instanceof Error ? err.message : 'Failed to append audit entry to SQLite',
                null,
                callTool
            );
        }
    }

    function verify(verifyOptions = {}) {
        const vOpts = verifyOptions && typeof verifyOptions === 'object' ? verifyOptions : {};
        const verifyTool = resolveToolName(vOpts.tool, defaultTool);

        if (closed) {
            return errorEnvelope('AUDIT_LOG_CLOSED', 'Audit log handle is closed', null, verifyTool);
        }

        const effectiveHmacSecret =
            vOpts.hmacSecret === undefined ? hmacSecret : vOpts.hmacSecret;
        const expectedGenesisHash =
            vOpts.expectedGenesisHash === undefined
                ? GENESIS_AUDIT_HASH
                : vOpts.expectedGenesisHash;
        const expectedTailHash =
            vOpts.expectedTailHash === undefined ? '' : vOpts.expectedTailHash;
        const startSeq = vOpts.startSeq === undefined ? 1 : vOpts.startSeq;

        if (!sqliteDb) {
            return verifyAuditChain(memoryEntries, {
                expectedGenesisHash,
                expectedTailHash,
                hmacSecret: effectiveHmacSecret,
                startSeq,
                tool: verifyTool,
            });
        }

        try {
            const rows = sqliteDb
                .prepare(`SELECT * FROM "${tableName}" ORDER BY seq ASC`)
                .all();
            const hydratedEntries = new Array(rows.length);
            for (let i = 0; i < rows.length; i++) {
                const hydrated = hydrateSqliteRow(rows[i], verifyTool);
                if (!hydrated.ok) {
                    return hydrated.envelope;
                }
                hydratedEntries[i] = hydrated.entry;
            }
            return verifyAuditChain(hydratedEntries, {
                expectedGenesisHash,
                expectedTailHash,
                hmacSecret: effectiveHmacSecret,
                startSeq,
                tool: verifyTool,
            });
        } catch (err) {
            return errorEnvelope(
                'AUDIT_STORAGE_ERROR',
                err instanceof Error ? err.message : 'Failed to read SQLite audit chain',
                null,
                verifyTool
            );
        }
    }

    function query(filters = {}) {
        const fObj = filters && typeof filters === 'object' ? filters : {};
        const queryTool = resolveToolName(fObj.tool, defaultTool);

        if (closed) {
            return errorEnvelope('AUDIT_LOG_CLOSED', 'Audit log handle is closed', null, queryTool);
        }

        const filterCheck = validateQueryFilters(filters, queryTool);
        if (!filterCheck.ok) {
            return filterCheck.envelope;
        }
        const f = filterCheck.normalized;

        if (!sqliteDb) {
            let matched = memoryEntries.filter((entry) => {
                if (f.tenantId !== undefined && entry.tenantId !== f.tenantId) return false;
                if (f.actor !== undefined && entry.actor !== f.actor) return false;
                if (f.action !== undefined && entry.action !== f.action) return false;
                if (f.resource !== undefined && entry.resource !== f.resource) return false;
                if (f.outcome !== undefined && entry.outcome !== f.outcome) return false;
                if (f.fromSeq !== undefined && entry.seq < f.fromSeq) return false;
                if (f.toSeq !== undefined && entry.seq > f.toSeq) return false;
                if (f.fromTimestamp !== undefined && entry.timestamp < f.fromTimestamp) return false;
                if (f.toTimestamp !== undefined && entry.timestamp > f.toTimestamp) return false;
                return true;
            });

            if (f.order === 'desc') {
                matched = matched.slice().reverse();
            }

            const total = matched.length;
            const end = f.limit === undefined ? total : f.offset + f.limit;
            const entries = Object.freeze(matched.slice(f.offset, end));

            return okEnvelope(queryTool, `Returned ${entries.length} audit entries`, {
                entries,
                count: entries.length,
                total,
            });
        }

        try {
            const clauses = [];
            const params = [];

            if (f.tenantId !== undefined) {
                clauses.push('tenant_id = ?');
                params.push(f.tenantId);
            }
            if (f.actor !== undefined) {
                clauses.push('actor = ?');
                params.push(f.actor);
            }
            if (f.action !== undefined) {
                clauses.push('action = ?');
                params.push(f.action);
            }
            if (f.resource !== undefined) {
                clauses.push('resource = ?');
                params.push(f.resource);
            }
            if (f.outcome !== undefined) {
                clauses.push('outcome = ?');
                params.push(f.outcome);
            }
            if (f.fromSeq !== undefined) {
                clauses.push('seq >= ?');
                params.push(f.fromSeq);
            }
            if (f.toSeq !== undefined) {
                clauses.push('seq <= ?');
                params.push(f.toSeq);
            }
            if (f.fromTimestamp !== undefined) {
                clauses.push('timestamp >= ?');
                params.push(f.fromTimestamp);
            }
            if (f.toTimestamp !== undefined) {
                clauses.push('timestamp <= ?');
                params.push(f.toTimestamp);
            }

            const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
            const orderSql = f.order === 'desc' ? 'ORDER BY seq DESC' : 'ORDER BY seq ASC';

            const countRow = sqliteDb
                .prepare(`SELECT COUNT(*) AS total FROM "${tableName}" ${whereSql}`)
                .get(...params);
            const total = Number(countRow?.total ?? 0);

            let paginationSql = '';
            const rowParams = [...params];
            if (f.limit !== undefined) {
                paginationSql = 'LIMIT ? OFFSET ?';
                rowParams.push(f.limit, f.offset);
            } else if (f.offset > 0) {
                paginationSql = 'LIMIT -1 OFFSET ?';
                rowParams.push(f.offset);
            }

            const rows = sqliteDb
                .prepare(
                    `SELECT * FROM "${tableName}" ${whereSql} ${orderSql} ${paginationSql}`
                )
                .all(...rowParams);

            const hydrated = new Array(rows.length);
            for (let i = 0; i < rows.length; i++) {
                const res = hydrateSqliteRow(rows[i], queryTool);
                if (!res.ok) {
                    return res.envelope;
                }
                hydrated[i] = res.entry;
            }
            const entries = Object.freeze(hydrated);

            return okEnvelope(queryTool, `Returned ${entries.length} audit entries`, {
                entries,
                count: entries.length,
                total,
            });
        } catch (err) {
            return errorEnvelope(
                'AUDIT_STORAGE_ERROR',
                err instanceof Error ? err.message : 'Failed to query SQLite audit log',
                null,
                queryTool
            );
        }
    }

    function tail() {
        if (!closed && sqliteDb) {
            try {
                const latestRow = sqliteDb
                    .prepare(`SELECT * FROM "${tableName}" ORDER BY seq DESC LIMIT 1`)
                    .get();
                if (!latestRow) {
                    cachedTail = createTailSnapshot(null);
                } else {
                    const hydrated = hydrateSqliteRow(latestRow, defaultTool);
                    if (hydrated.ok) {
                        cachedTail = createTailSnapshot(hydrated.entry);
                    }
                }
            } catch {
                // Fall back to last known cachedTail if external DB handle was closed externally.
            }
        }
        return cachedTail;
    }

    function close() {
        if (closed) {
            return;
        }
        closed = true;
        if (ownsDb && sqliteDb) {
            sqliteDb.close();
        }
    }

    return Object.freeze({
        append,
        verify,
        query,
        tail,
        close,
    });
}
