/**
 * @module idempotency
 * @description Atomic request idempotency lock, canonical payload SHA-256 fingerprinting,
 * bounded LRU replay cache, async execution wrapper, and Express / Node HTTP middleware
 * (`INV-LEGO-01`, `INV-LEGO-31`) for `@krusch/toolkit`.
 *
 * Security & correctness invariants enforced:
 * 1. Non-throwing runtime boundaries on untrusted keys, headers, payloads, and hostile getters.
 * 2. Deterministic canonical JSON SHA-256 fingerprinting over `{ method, path, body }` with
 *    cycle, nesting-depth, DAG-node, lone-surrogate, and non-JSON-type guards.
 * 3. Constant-time (`crypto.timingSafeEqual`) fingerprint and `lockToken` comparisons.
 * 4. Fencing tokens (`crypto.randomUUID()`) preventing timed-out handlers from committing or
 *    releasing locks owned by newer requests (`IDEMPOTENCY_LOCK_LOST`).
 * 5. Deep-cloned cached bodies on both `commit` and `REPLAY` to prevent shared-reference mutation,
 *    and active `IN_FLIGHT` lock preservation under capacity pressure (`IDEMPOTENCY_STORE_FULL`).
 */

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { okEnvelope, errorEnvelope } from './http.js';

/**
 * Default configuration constants for `@krusch/toolkit/idempotency` (`INV-LEGO-31`).
 */
export const DEFAULT_IDEMPOTENCY_OPTIONS = Object.freeze({
    ttlMs: 86_400_000,
    maxEntries: 10_000,
    inFlightTimeoutMs: 60_000,
    maxKeyLength: 255,
    headerName: 'idempotency-key',
});

const MAX_KEY_LENGTH_CEILING = 1024;
const MAX_DEPTH_CEILING = 512;
const MAX_CANONICAL_NODES = 100_000;
const MAX_CLONE_DEPTH = 64;
const MAX_CACHED_RESPONSE_BYTES = 2_097_152; // 2 MiB streaming capture ceiling
const ASCII_CONTROL_CHARS_RE = /[\x00-\x1f\x7f]/;
const HTTP_HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const FORBIDDEN_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const EXCLUDED_REPLAY_HEADERS = new Set([
    'connection',
    'content-length',
    'date',
    'idempotency-replayed',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'set-cookie',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
]);

/** @type {WeakMap<object, { maxKeyLength: number }>} */
const STORE_METADATA = new WeakMap();

/**
 * Safely extract a non-empty `tool` identifier from an untrusted options bag without throwing.
 *
 * @param {unknown} options - Candidate options object
 * @param {string} fallback - Default tool name
 * @returns {string}
 */
function resolveSafeTool(options, fallback) {
    try {
        if (options && typeof options === 'object' && !Array.isArray(options)) {
            const raw = /** @type {Record<string, unknown>} */ (options).tool;
            if (typeof raw === 'string' && raw.trim().length > 0) {
                return raw.trim();
            }
        }
    } catch {
        // Ignore hostile getters on options.tool
    }
    return fallback;
}

/**
 * Detect lone UTF-16 high/low surrogates in a string.
 *
 * @param {string} value - Candidate string
 * @returns {boolean}
 */
function hasLoneSurrogate(value) {
    if (typeof value.isWellFormed === 'function') {
        return !value.isWellFormed();
    }
    for (let i = 0; i < value.length; i += 1) {
        const code = value.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff) {
            const next = value.charCodeAt(i + 1);
            if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
            i += 1;
        } else if (code >= 0xdc00 && code <= 0xdfff) {
            return true;
        }
    }
    return false;
}

/**
 * Check whether an object is a raw byte view (`Buffer` or `Uint8Array`, excluding other `TypedArray`s).
 *
 * @param {unknown} value - Candidate value
 * @returns {value is Uint8Array}
 */
function isByteView(value) {
    if (!value || typeof value !== 'object') return false;
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) return true;
    return (
        ArrayBuffer.isView(value) &&
        value.constructor !== undefined &&
        value.constructor.name === 'Uint8Array'
    );
}

/**
 * Check whether an object has internal exotic/built-in slots or non-plain prototype.
 *
 * @param {object} value - Non-null object candidate
 * @returns {boolean}
 */
function isPlainRecordObject(value) {
    if (
        Array.isArray(value) ||
        value instanceof Date ||
        value instanceof RegExp ||
        value instanceof Map ||
        value instanceof Set ||
        value instanceof WeakMap ||
        value instanceof WeakSet ||
        value instanceof Promise ||
        value instanceof Error ||
        value instanceof ArrayBuffer ||
        ArrayBuffer.isView(value)
    ) {
        return false;
    }
    const proto = Object.getPrototypeOf(value);
    return proto === null || proto === Object.prototype;
}

/**
 * Compare two non-empty UTF-8 strings in constant time when byte lengths match.
 *
 * @param {unknown} a - First string
 * @param {unknown} b - Second string
 * @returns {boolean}
 */
function constantTimeStringEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');
    if (bufA.length === 0 || bufA.length !== bufB.length) {
        return false;
    }
    return timingSafeEqual(bufA, bufB);
}

/**
 * Validate and normalize an incoming `Idempotency-Key` string without throwing (`INV-LEGO-31`).
 *
 * @param {unknown} rawKey - Raw client idempotency key
 * @param {object} [options={}] - Validation options
 * @param {number} [options.maxKeyLength=255] - Maximum trimmed character length (`1..1024`)
 * @param {string} [options.tool='idempotency.key'] - Originating tool identifier
 * @returns {{ ok: true, tool: string, summary: string, data: { key: string } } | { ok: false, tool: string, summary: string, error: { code: string, message: string, details?: unknown } }}
 */
export function normalizeIdempotencyKey(rawKey, options = {}) {
    const safeTool = resolveSafeTool(options, 'idempotency.key');
    try {
        if (options !== undefined && options !== null && (typeof options !== 'object' || Array.isArray(options))) {
            return errorEnvelope(
                'IDEMPOTENCY_INVALID_OPTIONS',
                'Idempotency key options must be a plain object',
                null,
                safeTool
            );
        }

        const opts = /** @type {Record<string, unknown>} */ (options || {});
        const maxKeyLength =
            opts.maxKeyLength === undefined
                ? DEFAULT_IDEMPOTENCY_OPTIONS.maxKeyLength
                : opts.maxKeyLength;

        if (
            typeof maxKeyLength !== 'number' ||
            !Number.isInteger(maxKeyLength) ||
            maxKeyLength < 1 ||
            maxKeyLength > MAX_KEY_LENGTH_CEILING
        ) {
            return errorEnvelope(
                'IDEMPOTENCY_INVALID_OPTIONS',
                `maxKeyLength must be an integer between 1 and ${MAX_KEY_LENGTH_CEILING}`,
                { maxKeyLength },
                safeTool
            );
        }

        if (typeof rawKey !== 'string') {
            return errorEnvelope(
                'IDEMPOTENCY_KEY_MISSING',
                'Idempotency key must be a non-empty string',
                null,
                safeTool
            );
        }

        const trimmed = rawKey.trim();
        if (trimmed.length === 0) {
            return errorEnvelope(
                'IDEMPOTENCY_KEY_MISSING',
                'Idempotency key cannot be empty or whitespace-only',
                null,
                safeTool
            );
        }

        if (trimmed.length > maxKeyLength) {
            return errorEnvelope(
                'IDEMPOTENCY_KEY_TOO_LONG',
                `Idempotency key exceeds maximum length of ${maxKeyLength} characters`,
                { length: trimmed.length, maxKeyLength },
                safeTool
            );
        }

        if (ASCII_CONTROL_CHARS_RE.test(rawKey) || hasLoneSurrogate(rawKey)) {
            return errorEnvelope(
                'IDEMPOTENCY_KEY_INVALID',
                'Idempotency key must not contain ASCII control characters or lone UTF-16 surrogates',
                null,
                safeTool
            );
        }

        return okEnvelope(safeTool, 'Idempotency key valid', { key: trimmed });
    } catch (err) {
        return errorEnvelope(
            'IDEMPOTENCY_INVALID_OPTIONS',
            err instanceof Error ? err.message : 'Failed to validate idempotency key',
            null,
            safeTool
        );
    }
}

/**
 * Recursively serialize a payload value into deterministic canonical JSON.
 *
 * @param {unknown} value - Current value node
 * @param {number} depth - Current container nesting depth (`0` at root)
 * @param {number} maxDepth - Maximum allowed container nesting depth
 * @param {Set<object>} ancestors - Active ancestor chain for cycle detection
 * @param {{ nodes: number }} state - Shared visited-node counter guarding against DAG blowups
 * @returns {{ ok: true, json: string } | { ok: false, code: string, message: string, details?: Record<string, unknown> }}
 */
function serializeCanonicalValue(value, depth, maxDepth, ancestors, state) {
    state.nodes += 1;
    if (state.nodes > MAX_CANONICAL_NODES) {
        return {
            ok: false,
            code: 'IDEMPOTENCY_INVALID_PAYLOAD',
            message: `Payload exceeds maximum canonical node count of ${MAX_CANONICAL_NODES}`,
            details: { maxNodes: MAX_CANONICAL_NODES },
        };
    }

    if (value === null || value === undefined) {
        return { ok: true, json: 'null' };
    }

    const valueType = typeof value;
    if (valueType === 'boolean') {
        return { ok: true, json: value ? 'true' : 'false' };
    }

    if (valueType === 'number') {
        if (!Number.isFinite(value)) {
            return {
                ok: false,
                code: 'IDEMPOTENCY_INVALID_PAYLOAD',
                message: 'Payload must not contain NaN or Infinity',
            };
        }
        const normalizedNum = value === 0 ? 0 : value;
        return { ok: true, json: JSON.stringify(normalizedNum) };
    }

    if (valueType === 'string') {
        const strVal = /** @type {string} */ (value);
        if (hasLoneSurrogate(strVal)) {
            return {
                ok: false,
                code: 'IDEMPOTENCY_INVALID_PAYLOAD',
                message: 'Payload string contains lone UTF-16 surrogate',
            };
        }
        return { ok: true, json: JSON.stringify(strVal) };
    }

    if (valueType === 'bigint' || valueType === 'symbol' || valueType === 'function') {
        return {
            ok: false,
            code: 'IDEMPOTENCY_INVALID_PAYLOAD',
            message: `Unsupported non-JSON payload value type: ${valueType}`,
        };
    }

    const obj = /** @type {object} */ (value);

    if (isByteView(obj)) {
        const b64 = Buffer.from(obj.buffer, obj.byteOffset, obj.byteLength).toString('base64');
        return { ok: true, json: `{"$bytesBase64":${JSON.stringify(b64)}}` };
    }

    if (obj instanceof Date) {
        const timeMs = obj.getTime();
        if (!Number.isFinite(timeMs)) {
            return {
                ok: false,
                code: 'IDEMPOTENCY_INVALID_PAYLOAD',
                message: 'Payload contains an Invalid Date instance',
            };
        }
        return { ok: true, json: `{"$date":${JSON.stringify(obj.toISOString())}}` };
    }

    if (ancestors.has(obj)) {
        return {
            ok: false,
            code: 'IDEMPOTENCY_CIRCULAR_PAYLOAD',
            message: 'Payload contains a circular reference',
        };
    }

    if (Array.isArray(obj)) {
        const nextDepth = depth + 1;
        if (nextDepth > maxDepth) {
            return {
                ok: false,
                code: 'IDEMPOTENCY_MAX_DEPTH',
                message: `Payload exceeds maximum nesting depth of ${maxDepth}`,
                details: { maxDepth },
            };
        }
        ancestors.add(obj);
        try {
            const parts = [];
            for (let i = 0; i < obj.length; i += 1) {
                const elem = obj[i];
                const childRes = serializeCanonicalValue(
                    elem === undefined ? null : elem,
                    nextDepth,
                    maxDepth,
                    ancestors,
                    state
                );
                if (!childRes.ok) return childRes;
                parts.push(childRes.json);
            }
            return { ok: true, json: `[${parts.join(',')}]` };
        } finally {
            ancestors.delete(obj);
        }
    }

    if (!isPlainRecordObject(obj)) {
        return {
            ok: false,
            code: 'IDEMPOTENCY_INVALID_PAYLOAD',
            message: 'Payload contains unsupported non-plain class instance',
        };
    }

    if (Object.getOwnPropertySymbols(obj).length > 0) {
        return {
            ok: false,
            code: 'IDEMPOTENCY_INVALID_PAYLOAD',
            message: 'Payload object must not contain Symbol keys',
        };
    }

    const nextDepth = depth + 1;
    if (nextDepth > maxDepth) {
        return {
            ok: false,
            code: 'IDEMPOTENCY_MAX_DEPTH',
            message: `Payload exceeds maximum nesting depth of ${maxDepth}`,
            details: { maxDepth },
        };
    }

    ancestors.add(obj);
    try {
        const keys = Object.keys(obj).sort();
        const rec = /** @type {Record<string, unknown>} */ (obj);
        const parts = [];
        for (let i = 0; i < keys.length; i += 1) {
            const k = keys[i];
            if (hasLoneSurrogate(k)) {
                return {
                    ok: false,
                    code: 'IDEMPOTENCY_INVALID_PAYLOAD',
                    message: 'Payload object key contains lone UTF-16 surrogate',
                };
            }
            const propVal = rec[k];
            if (propVal === undefined) {
                continue;
            }
            const childRes = serializeCanonicalValue(propVal, nextDepth, maxDepth, ancestors, state);
            if (!childRes.ok) return childRes;
            parts.push(`${JSON.stringify(k)}:${childRes.json}`);
        }
        return { ok: true, json: `{${parts.join(',')}}` };
    } finally {
        ancestors.delete(obj);
    }
}

/**
 * Compute a deterministic canonical SHA-256 hex digest over `{ method, path, body }` without throwing (`INV-LEGO-31`).
 *
 * @param {unknown} payload - Request body or operation payload
 * @param {object} [options={}] - Fingerprinting options
 * @param {string} [options.method=''] - HTTP verb or action method
 * @param {string} [options.path=''] - Request route path
 * @param {number} [options.maxDepth=32] - Maximum container nesting depth (`1..512`)
 * @param {string} [options.tool='idempotency.fingerprint'] - Originating tool identifier
 * @returns {{ ok: true, tool: string, summary: string, data: { fingerprint: string } } | { ok: false, tool: string, summary: string, error: { code: string, message: string, details?: unknown } }}
 */
export function computePayloadFingerprint(payload, options = {}) {
    const safeTool = resolveSafeTool(options, 'idempotency.fingerprint');
    try {
        if (options !== undefined && options !== null && (typeof options !== 'object' || Array.isArray(options))) {
            return errorEnvelope(
                'IDEMPOTENCY_INVALID_OPTIONS',
                'Fingerprint options must be a plain object',
                null,
                safeTool
            );
        }

        const opts = /** @type {Record<string, unknown>} */ (options || {});
        const rawMethod = opts.method === undefined || opts.method === null ? '' : opts.method;
        const rawPath = opts.path === undefined || opts.path === null ? '' : opts.path;
        const maxDepth = opts.maxDepth === undefined ? 32 : opts.maxDepth;

        if (typeof rawMethod !== 'string' && typeof rawMethod !== 'number') {
            return errorEnvelope(
                'IDEMPOTENCY_INVALID_OPTIONS',
                'method option must be a string',
                null,
                safeTool
            );
        }
        if (typeof rawPath !== 'string' && typeof rawPath !== 'number') {
            return errorEnvelope(
                'IDEMPOTENCY_INVALID_OPTIONS',
                'path option must be a string',
                null,
                safeTool
            );
        }
        if (
            typeof maxDepth !== 'number' ||
            !Number.isInteger(maxDepth) ||
            maxDepth < 1 ||
            maxDepth > MAX_DEPTH_CEILING
        ) {
            return errorEnvelope(
                'IDEMPOTENCY_INVALID_OPTIONS',
                `maxDepth must be an integer between 1 and ${MAX_DEPTH_CEILING}`,
                { maxDepth },
                safeTool
            );
        }

        const normMethod = String(rawMethod).trim().toUpperCase();
        const normPath = String(rawPath).trim();
        if (hasLoneSurrogate(normMethod) || hasLoneSurrogate(normPath)) {
            return errorEnvelope(
                'IDEMPOTENCY_INVALID_PAYLOAD',
                'method or path contains lone UTF-16 surrogate',
                null,
                safeTool
            );
        }

        const bodySerialized = serializeCanonicalValue(
            payload === undefined ? null : payload,
            0,
            maxDepth,
            new Set(),
            { nodes: 0 }
        );
        if (!bodySerialized.ok) {
            return errorEnvelope(
                bodySerialized.code,
                bodySerialized.message,
                bodySerialized.details ?? null,
                safeTool
            );
        }

        const envelopeParts = {
            method: JSON.stringify(normMethod),
            path: JSON.stringify(normPath),
            body: bodySerialized.json,
        };
        const sortedEnvelopeEntries = Object.keys(envelopeParts)
            .sort()
            .map((k) => `${JSON.stringify(k)}:${envelopeParts[/** @type {keyof typeof envelopeParts} */ (k)]}`);
        const canonicalEnvelope = `{${sortedEnvelopeEntries.join(',')}}`;
        const fingerprint = createHash('sha256').update(canonicalEnvelope, 'utf8').digest('hex');

        return okEnvelope(safeTool, 'Payload fingerprint computed', { fingerprint });
    } catch (err) {
        return errorEnvelope(
            'IDEMPOTENCY_INVALID_PAYLOAD',
            err instanceof Error ? err.message : 'Failed to compute payload fingerprint',
            null,
            safeTool
        );
    }
}

/**
 * Deep-clone a response body while rejecting circular references, excessive nesting,
 * lone surrogates, and non-cloneable JS values (`BigInt`, `Symbol`, `Function`, `NaN`, `Infinity`).
 *
 * @param {unknown} value - Candidate response body
 * @param {number} [depth=0] - Current nesting depth
 * @param {Set<object>} [ancestors=new Set()] - Active ancestor set
 * @param {{ nodes: number }} [state={ nodes: 0 }] - Shared node counter
 * @returns {{ ok: true, value: any } | { ok: false, message: string }}
 */
function cloneBodyValue(value, depth = 0, ancestors = new Set(), state = { nodes: 0 }) {
    state.nodes += 1;
    if (state.nodes > MAX_CANONICAL_NODES) {
        return {
            ok: false,
            message: `Response body exceeds maximum cloneable node count of ${MAX_CANONICAL_NODES}`,
        };
    }

    if (value === null || value === undefined) {
        return { ok: true, value: null };
    }

    const valueType = typeof value;
    if (valueType === 'boolean') {
        return { ok: true, value };
    }
    if (valueType === 'number') {
        if (!Number.isFinite(value)) {
            return { ok: false, message: 'Response body must not contain NaN or Infinity' };
        }
        return { ok: true, value: value === 0 ? 0 : value };
    }
    if (valueType === 'string') {
        if (hasLoneSurrogate(/** @type {string} */ (value))) {
            return { ok: false, message: 'Response body contains lone UTF-16 surrogate' };
        }
        return { ok: true, value };
    }
    if (valueType === 'bigint' || valueType === 'symbol' || valueType === 'function') {
        return { ok: false, message: `Response body contains non-cloneable ${valueType} value` };
    }

    const obj = /** @type {object} */ (value);
    if (Buffer.isBuffer(obj)) {
        return { ok: true, value: Buffer.from(obj) };
    }
    if (isByteView(obj)) {
        return { ok: true, value: new Uint8Array(obj.buffer.slice(obj.byteOffset, obj.byteOffset + obj.byteLength)) };
    }
    if (obj instanceof Date) {
        const ms = obj.getTime();
        if (!Number.isFinite(ms)) {
            return { ok: false, message: 'Response body contains an Invalid Date instance' };
        }
        return { ok: true, value: new Date(ms) };
    }

    if (ancestors.has(obj)) {
        return { ok: false, message: 'Response body contains a circular reference' };
    }
    if (depth + 1 > MAX_CLONE_DEPTH) {
        return { ok: false, message: `Response body exceeds maximum nesting depth of ${MAX_CLONE_DEPTH}` };
    }

    if (Array.isArray(obj)) {
        ancestors.add(obj);
        try {
            const out = new Array(obj.length);
            for (let i = 0; i < obj.length; i += 1) {
                const elem = obj[i];
                const clonedElem = cloneBodyValue(
                    elem === undefined ? null : elem,
                    depth + 1,
                    ancestors,
                    state
                );
                if (!clonedElem.ok) return clonedElem;
                out[i] = clonedElem.value;
            }
            return { ok: true, value: out };
        } finally {
            ancestors.delete(obj);
        }
    }

    if (!isPlainRecordObject(obj) || Object.getOwnPropertySymbols(obj).length > 0) {
        return { ok: false, message: 'Response body contains unsupported non-plain object or Symbol keys' };
    }

    ancestors.add(obj);
    try {
        /** @type {Record<string, unknown>} */
        const out = {};
        const rec = /** @type {Record<string, unknown>} */ (obj);
        for (const k of Object.keys(rec)) {
            if (hasLoneSurrogate(k)) {
                return { ok: false, message: 'Response body object key contains lone UTF-16 surrogate' };
            }
            const propVal = rec[k];
            if (propVal === undefined) {
                continue;
            }
            const clonedProp = cloneBodyValue(propVal, depth + 1, ancestors, state);
            if (!clonedProp.ok) return clonedProp;
            if (k === '__proto__') {
                Object.defineProperty(out, k, {
                    value: clonedProp.value,
                    enumerable: true,
                    configurable: true,
                    writable: true,
                });
            } else {
                out[k] = clonedProp.value;
            }
        }
        return { ok: true, value: out };
    } finally {
        ancestors.delete(obj);
    }
}

/**
 * Sanitize response headers for safe storage and replay, stripping CR/LF/NUL characters
 * and rejecting prototype-pollution keys.
 *
 * @param {unknown} rawHeaders - Candidate header map
 * @returns {{ ok: true, headers: Record<string, string> } | { ok: false, message: string }}
 */
function sanitizeCachedHeaders(rawHeaders) {
    if (rawHeaders === undefined || rawHeaders === null) {
        return { ok: true, headers: {} };
    }
    if (typeof rawHeaders !== 'object' || Array.isArray(rawHeaders)) {
        return { ok: false, message: 'headers must be a plain object' };
    }

    /** @type {Record<string, string>} */
    const cleaned = {};
    const rec = /** @type {Record<string, unknown>} */ (rawHeaders);
    for (const rawKey of Object.keys(rec)) {
        if (FORBIDDEN_OBJECT_KEYS.has(rawKey)) continue;
        const val = rec[rawKey];
        if (val === undefined || val === null) continue;
        const cleanName = rawKey.replace(/[\r\n\x00]+/g, '').trim();
        if (!cleanName || FORBIDDEN_OBJECT_KEYS.has(cleanName.toLowerCase())) continue;
        if (!HTTP_HEADER_NAME_RE.test(cleanName)) continue;
        const cleanVal = String(val).replace(/[\r\n\x00]+/g, '');
        cleaned[cleanName] = cleanVal;
    }
    return { ok: true, headers: cleaned };
}

/**
 * Create a bounded, prototype-safe, LRU idempotency lock and replay cache store (`INV-LEGO-31`).
 *
 * Throws `RangeError` only on invalid static developer configuration; all returned store
 * operations (`begin`, `commit`, `release`, `get`, `delete`, `clear`, `size`) are non-throwing.
 *
 * @param {object} [options={}] - Store configuration
 * @param {number} [options.ttlMs=86400000] - Replay retention TTL for `COMPLETED` entries (`>= 1`)
 * @param {number} [options.maxEntries=10000] - Maximum entries before expired/LRU eviction (`>= 1`)
 * @param {number} [options.inFlightTimeoutMs=60000] - Stale `IN_FLIGHT` lock timeout (`>= 1`)
 * @param {number} [options.maxKeyLength=255] - Maximum allowed key length (`1..1024`)
 * @param {() => number} [options.nowFn=Date.now] - Monotonic/epoch millisecond clock provider
 */
export function createIdempotencyStore(options = {}) {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
        throw new RangeError('createIdempotencyStore options must be a plain object');
    }

    const {
        ttlMs = DEFAULT_IDEMPOTENCY_OPTIONS.ttlMs,
        maxEntries = DEFAULT_IDEMPOTENCY_OPTIONS.maxEntries,
        inFlightTimeoutMs = DEFAULT_IDEMPOTENCY_OPTIONS.inFlightTimeoutMs,
        maxKeyLength = DEFAULT_IDEMPOTENCY_OPTIONS.maxKeyLength,
        nowFn = Date.now,
    } = options;

    if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs < 1) {
        throw new RangeError('ttlMs must be a finite positive number >= 1');
    }
    if (typeof maxEntries !== 'number' || !Number.isInteger(maxEntries) || maxEntries < 1) {
        throw new RangeError('maxEntries must be an integer >= 1');
    }
    if (
        typeof inFlightTimeoutMs !== 'number' ||
        !Number.isFinite(inFlightTimeoutMs) ||
        inFlightTimeoutMs < 1
    ) {
        throw new RangeError('inFlightTimeoutMs must be a finite positive number >= 1');
    }
    if (
        typeof maxKeyLength !== 'number' ||
        !Number.isInteger(maxKeyLength) ||
        maxKeyLength < 1 ||
        maxKeyLength > MAX_KEY_LENGTH_CEILING
    ) {
        throw new RangeError(`maxKeyLength must be an integer between 1 and ${MAX_KEY_LENGTH_CEILING}`);
    }
    if (typeof nowFn !== 'function') {
        throw new RangeError('nowFn must be a function');
    }

    /** @type {Map<string, any>} */
    const entries = new Map();

    const safeNow = () => {
        try {
            const ts = nowFn();
            return typeof ts === 'number' && Number.isFinite(ts) ? ts : Date.now();
        } catch {
            return Date.now();
        }
    };

    const isExpired = (entry, now) => {
        if (entry.state === 'IN_FLIGHT') {
            return now - entry.startedAt >= inFlightTimeoutMs;
        }
        return now >= entry.expiresAt;
    };

    const sweepExpired = (now) => {
        for (const [k, entry] of entries.entries()) {
            if (isExpired(entry, now)) {
                entries.delete(k);
            }
        }
    };

    const evictOldestCompleted = () => {
        for (const [k, entry] of entries.entries()) {
            if (entry.state === 'COMPLETED') {
                entries.delete(k);
                return true;
            }
        }
        return false;
    };

    const begin = (key, fingerprint, beginOptions = {}) => {
        const safeTool = resolveSafeTool(beginOptions, 'idempotency.store');
        try {
            if (
                beginOptions !== undefined &&
                beginOptions !== null &&
                (typeof beginOptions !== 'object' || Array.isArray(beginOptions))
            ) {
                return errorEnvelope(
                    'IDEMPOTENCY_INVALID_OPTIONS',
                    'begin options must be a plain object',
                    null,
                    safeTool
                );
            }

            const keyRes = normalizeIdempotencyKey(key, { maxKeyLength, tool: safeTool });
            if (!keyRes.ok) return keyRes;
            const normalizedKey = keyRes.data.key;

            if (
                typeof fingerprint !== 'string' ||
                fingerprint.trim().length === 0 ||
                fingerprint.length > MAX_KEY_LENGTH_CEILING ||
                ASCII_CONTROL_CHARS_RE.test(fingerprint) ||
                hasLoneSurrogate(fingerprint)
            ) {
                return errorEnvelope(
                    'IDEMPOTENCY_INVALID_FINGERPRINT',
                    'Fingerprint must be a non-empty valid string',
                    null,
                    safeTool
                );
            }
            const normFingerprint = fingerprint.trim();
            const now = safeNow();

            let existing = entries.get(normalizedKey);
            if (existing && isExpired(existing, now)) {
                entries.delete(normalizedKey);
                existing = undefined;
            }

            if (existing) {
                if (!constantTimeStringEqual(existing.fingerprint, normFingerprint)) {
                    return errorEnvelope(
                        'IDEMPOTENCY_PAYLOAD_MISMATCH',
                        'Idempotency key was already used with a different request payload',
                        { key: normalizedKey, statusCode: 422 },
                        safeTool
                    );
                }

                if (existing.state === 'IN_FLIGHT') {
                    return errorEnvelope(
                        'IDEMPOTENCY_IN_FLIGHT',
                        'A request with this idempotency key is currently in flight',
                        { key: normalizedKey, statusCode: 409 },
                        safeTool
                    );
                }

                // Refresh LRU order on COMPLETED replay hit
                entries.delete(normalizedKey);
                entries.set(normalizedKey, existing);

                const clonedBody = cloneBodyValue(existing.body);
                return okEnvelope(safeTool, 'Idempotency replay hit', {
                    outcome: 'REPLAY',
                    key: normalizedKey,
                    fingerprint: existing.fingerprint,
                    statusCode: existing.statusCode,
                    body: clonedBody.ok ? clonedBody.value : null,
                    headers: { ...existing.headers },
                    storedAt: existing.storedAt,
                });
            }

            if (entries.size >= maxEntries) {
                sweepExpired(now);
                while (entries.size >= maxEntries) {
                    if (!evictOldestCompleted()) {
                        return errorEnvelope(
                            'IDEMPOTENCY_STORE_FULL',
                            'Idempotency store capacity exhausted by active in-flight locks',
                            { maxEntries, statusCode: 503 },
                            safeTool
                        );
                    }
                }
            }

            const lockToken = randomUUID();
            entries.set(normalizedKey, {
                state: 'IN_FLIGHT',
                key: normalizedKey,
                fingerprint: normFingerprint,
                lockToken,
                startedAt: now,
                expiresAt: now + inFlightTimeoutMs,
            });

            return okEnvelope(safeTool, 'Idempotency lock acquired', {
                outcome: 'ACQUIRED',
                key: normalizedKey,
                fingerprint: normFingerprint,
                lockToken,
            });
        } catch (err) {
            return errorEnvelope(
                'IDEMPOTENCY_INVALID_OPTIONS',
                err instanceof Error ? err.message : 'Failed to begin idempotency transaction',
                null,
                safeTool
            );
        }
    };

    const commit = (key, lockToken, commitOptions = {}) => {
        const safeTool = resolveSafeTool(commitOptions, 'idempotency.store');
        try {
            if (
                commitOptions !== undefined &&
                commitOptions !== null &&
                (typeof commitOptions !== 'object' || Array.isArray(commitOptions))
            ) {
                return errorEnvelope(
                    'IDEMPOTENCY_INVALID_OPTIONS',
                    'commit options must be a plain object',
                    null,
                    safeTool
                );
            }

            const keyRes = normalizeIdempotencyKey(key, { maxKeyLength, tool: safeTool });
            if (!keyRes.ok) return keyRes;
            const normalizedKey = keyRes.data.key;

            if (typeof lockToken !== 'string' || lockToken.trim().length === 0) {
                return errorEnvelope(
                    'IDEMPOTENCY_LOCK_LOST',
                    'Idempotency lock token is missing or invalid',
                    { key: normalizedKey },
                    safeTool
                );
            }

            const now = safeNow();
            const existing = entries.get(normalizedKey);
            if (existing && isExpired(existing, now)) {
                entries.delete(normalizedKey);
                return errorEnvelope(
                    'IDEMPOTENCY_LOCK_LOST',
                    'Idempotency lock expired before commit',
                    { key: normalizedKey },
                    safeTool
                );
            }

            if (
                !existing ||
                existing.state !== 'IN_FLIGHT' ||
                !constantTimeStringEqual(existing.lockToken, lockToken)
            ) {
                return errorEnvelope(
                    'IDEMPOTENCY_LOCK_LOST',
                    'Idempotency lock is no longer owned by this token',
                    { key: normalizedKey },
                    safeTool
                );
            }

            const opts = /** @type {Record<string, unknown>} */ (commitOptions || {});
            const statusCode = opts.statusCode === undefined ? 200 : opts.statusCode;
            if (
                typeof statusCode !== 'number' ||
                !Number.isInteger(statusCode) ||
                statusCode < 100 ||
                statusCode > 599
            ) {
                return errorEnvelope(
                    'IDEMPOTENCY_INVALID_OPTIONS',
                    'statusCode must be an integer HTTP status code between 100 and 599',
                    { statusCode },
                    safeTool
                );
            }

            const headerRes = sanitizeCachedHeaders(opts.headers);
            if (!headerRes.ok) {
                return errorEnvelope(
                    'IDEMPOTENCY_INVALID_OPTIONS',
                    headerRes.message,
                    null,
                    safeTool
                );
            }

            const rawBody = opts.body === undefined ? null : opts.body;
            const clonedBody = cloneBodyValue(rawBody);
            if (!clonedBody.ok) {
                return errorEnvelope(
                    'IDEMPOTENCY_INVALID_PAYLOAD',
                    clonedBody.message,
                    { key: normalizedKey },
                    safeTool
                );
            }

            const expiresAt = now + ttlMs;
            const completedEntry = {
                state: 'COMPLETED',
                key: normalizedKey,
                fingerprint: existing.fingerprint,
                statusCode,
                body: clonedBody.value,
                headers: headerRes.headers,
                storedAt: now,
                expiresAt,
            };

            entries.delete(normalizedKey);
            entries.set(normalizedKey, completedEntry);

            return okEnvelope(safeTool, 'Idempotency response committed', {
                key: normalizedKey,
                fingerprint: existing.fingerprint,
                statusCode,
                storedAt: now,
                expiresAt,
            });
        } catch (err) {
            return errorEnvelope(
                'IDEMPOTENCY_INVALID_PAYLOAD',
                err instanceof Error ? err.message : 'Failed to commit idempotency entry',
                null,
                safeTool
            );
        }
    };

    const release = (key, lockToken, releaseOptions = {}) => {
        const safeTool = resolveSafeTool(releaseOptions, 'idempotency.store');
        try {
            if (
                releaseOptions !== undefined &&
                releaseOptions !== null &&
                (typeof releaseOptions !== 'object' || Array.isArray(releaseOptions))
            ) {
                return errorEnvelope(
                    'IDEMPOTENCY_INVALID_OPTIONS',
                    'release options must be a plain object',
                    null,
                    safeTool
                );
            }

            const keyRes = normalizeIdempotencyKey(key, { maxKeyLength, tool: safeTool });
            if (!keyRes.ok) return keyRes;
            const normalizedKey = keyRes.data.key;

            if (typeof lockToken !== 'string' || lockToken.trim().length === 0) {
                return okEnvelope(safeTool, 'Idempotency lock not owned', {
                    key: normalizedKey,
                    released: false,
                });
            }

            const now = safeNow();
            const existing = entries.get(normalizedKey);
            if (!existing) {
                return okEnvelope(safeTool, 'Idempotency lock already inactive', {
                    key: normalizedKey,
                    released: false,
                });
            }

            if (isExpired(existing, now)) {
                entries.delete(normalizedKey);
                return okEnvelope(safeTool, 'Idempotency lock already expired', {
                    key: normalizedKey,
                    released: false,
                });
            }

            if (
                existing.state !== 'IN_FLIGHT' ||
                !constantTimeStringEqual(existing.lockToken, lockToken)
            ) {
                return okEnvelope(safeTool, 'Idempotency lock not owned', {
                    key: normalizedKey,
                    released: false,
                });
            }

            entries.delete(normalizedKey);
            return okEnvelope(safeTool, 'Idempotency lock released', {
                key: normalizedKey,
                released: true,
            });
        } catch (err) {
            return errorEnvelope(
                'IDEMPOTENCY_INVALID_OPTIONS',
                err instanceof Error ? err.message : 'Failed to release idempotency lock',
                null,
                safeTool
            );
        }
    };

    const get = (key) => {
        try {
            const keyRes = normalizeIdempotencyKey(key, { maxKeyLength });
            if (!keyRes.ok) return null;
            const normalizedKey = keyRes.data.key;
            const now = safeNow();
            const existing = entries.get(normalizedKey);
            if (!existing) return null;
            if (isExpired(existing, now)) {
                entries.delete(normalizedKey);
                return null;
            }
            if (existing.state === 'IN_FLIGHT') {
                return Object.freeze({
                    state: 'IN_FLIGHT',
                    key: existing.key,
                    fingerprint: existing.fingerprint,
                    startedAt: existing.startedAt,
                    expiresAt: existing.expiresAt,
                });
            }
            const clonedBody = cloneBodyValue(existing.body);
            return Object.freeze({
                state: 'COMPLETED',
                key: existing.key,
                fingerprint: existing.fingerprint,
                statusCode: existing.statusCode,
                body: clonedBody.ok ? clonedBody.value : null,
                headers: { ...existing.headers },
                storedAt: existing.storedAt,
                expiresAt: existing.expiresAt,
            });
        } catch {
            return null;
        }
    };

    const deleteEntry = (key) => {
        try {
            const keyRes = normalizeIdempotencyKey(key, { maxKeyLength });
            if (!keyRes.ok) return false;
            const normalizedKey = keyRes.data.key;
            const now = safeNow();
            const existing = entries.get(normalizedKey);
            if (!existing) return false;
            entries.delete(normalizedKey);
            return !isExpired(existing, now);
        } catch {
            return false;
        }
    };

    const clear = () => {
        entries.clear();
    };

    const size = () => {
        sweepExpired(safeNow());
        return entries.size;
    };

    const storeHandle = Object.freeze({
        begin,
        commit,
        release,
        get,
        delete: deleteEntry,
        clear,
        size,
    });

    STORE_METADATA.set(storeHandle, { maxKeyLength });
    return storeHandle;
}

/**
 * Derive an HTTP status integer (`100..599`) from a handler return value when present.
 *
 * @param {unknown} result - Handler return value
 * @returns {number}
 */
function resolveHandlerStatusCode(result) {
    if (result && typeof result === 'object') {
        const rec = /** @type {Record<string, any>} */ (result);
        if (
            typeof rec.statusCode === 'number' &&
            Number.isInteger(rec.statusCode) &&
            rec.statusCode >= 100 &&
            rec.statusCode <= 599
        ) {
            return rec.statusCode;
        }
        const detailStatus = rec.error?.details?.statusCode;
        if (
            typeof detailStatus === 'number' &&
            Number.isInteger(detailStatus) &&
            detailStatus >= 100 &&
            detailStatus <= 599
        ) {
            return detailStatus;
        }
        if (rec.ok === false) {
            return 400;
        }
    }
    return 200;
}

/**
 * Verify that `store` exposes the required idempotency store methods.
 *
 * @param {unknown} store - Candidate store object
 * @returns {boolean}
 */
function isValidStoreHandle(store) {
    return Boolean(
        store &&
            typeof store === 'object' &&
            typeof /** @type {any} */ (store).begin === 'function' &&
            typeof /** @type {any} */ (store).commit === 'function' &&
            typeof /** @type {any} */ (store).release === 'function'
    );
}

/**
 * Execute an async handler under atomic idempotency protection (`INV-LEGO-31`).
 *
 * Normalizes `key`, computes canonical `fingerprint`, replays cached completions without
 * re-running `handlerFn`, releases active locks without caching on thrown exceptions or
 * `{ ok: false }` results (when `cacheErrors === false`), and commits deterministic results.
 *
 * @template TResult
 * @param {ReturnType<typeof createIdempotencyStore>} store - Idempotency store handle
 * @param {object} [options={}] - Execution options
 * @param {string} options.key - Client idempotency key
 * @param {unknown} [options.payload=null] - Operation payload for canonical fingerprinting
 * @param {string} [options.method='POST'] - Logical verb / HTTP method
 * @param {string} [options.path=''] - Logical route / operation path
 * @param {boolean} [options.cacheErrors=false] - Whether `{ ok: false }` envelopes should be cached
 * @param {string} [options.tool='idempotency.exec'] - Originating tool identifier
 * @param {(ctx: { key: string, fingerprint: string }) => TResult | Promise<TResult>} handlerFn - Idempotent operation callback
 * @returns {Promise<{ ok: true, tool: string, summary: string, data: { replayed: boolean, key: string, statusCode: number, result: TResult } } | { ok: false, tool: string, summary: string, error: { code: string, message: string, details?: unknown } }>}
 */
export async function withIdempotency(store, options = {}, handlerFn) {
    const safeTool = resolveSafeTool(options, 'idempotency.exec');
    try {
        if (!isValidStoreHandle(store)) {
            return errorEnvelope(
                'IDEMPOTENCY_INVALID_STORE',
                'Valid idempotency store handle is required',
                null,
                safeTool
            );
        }

        if (options === null || typeof options !== 'object' || Array.isArray(options)) {
            return errorEnvelope(
                'IDEMPOTENCY_INVALID_OPTIONS',
                'withIdempotency options must be a plain object',
                null,
                safeTool
            );
        }

        if (typeof handlerFn !== 'function') {
            return errorEnvelope(
                'IDEMPOTENCY_INVALID_HANDLER',
                'handlerFn must be a function',
                null,
                safeTool
            );
        }

        const opts = /** @type {Record<string, unknown>} */ (options);
        const rawKey = opts.key;
        const payload = opts.payload === undefined ? null : opts.payload;
        const method = opts.method === undefined ? 'POST' : /** @type {string} */ (opts.method);
        const path = opts.path === undefined ? '' : /** @type {string} */ (opts.path);
        const cacheErrors = opts.cacheErrors === undefined ? false : opts.cacheErrors;

        if (typeof cacheErrors !== 'boolean') {
            return errorEnvelope(
                'IDEMPOTENCY_INVALID_OPTIONS',
                'cacheErrors must be a boolean',
                { cacheErrors },
                safeTool
            );
        }

        const storeMaxKeyLength =
            STORE_METADATA.get(store)?.maxKeyLength ?? DEFAULT_IDEMPOTENCY_OPTIONS.maxKeyLength;

        const keyRes = normalizeIdempotencyKey(rawKey, {
            maxKeyLength: storeMaxKeyLength,
            tool: safeTool,
        });
        if (!keyRes.ok) return keyRes;
        const normalizedKey = keyRes.data.key;

        const fpRes = computePayloadFingerprint(payload, { method, path, tool: safeTool });
        if (!fpRes.ok) return fpRes;
        const { fingerprint } = fpRes.data;

        const beginRes = store.begin(normalizedKey, fingerprint, { tool: safeTool });
        if (!beginRes.ok) return beginRes;

        if (beginRes.data.outcome === 'REPLAY') {
            return okEnvelope(safeTool, 'Idempotent result replayed', {
                replayed: true,
                key: normalizedKey,
                statusCode: beginRes.data.statusCode,
                result: beginRes.data.body,
            });
        }

        const { lockToken } = beginRes.data;
        let rawResult;
        try {
            rawResult = await handlerFn({ key: normalizedKey, fingerprint });
        } catch (err) {
            store.release(normalizedKey, lockToken, { tool: safeTool });
            return errorEnvelope(
                'IDEMPOTENCY_HANDLER_ERROR',
                err instanceof Error ? err.message : String(err ?? 'Handler execution failed'),
                { key: normalizedKey },
                safeTool
            );
        }

        const isErrorResult = Boolean(
            rawResult && typeof rawResult === 'object' && /** @type {any} */ (rawResult).ok === false
        );

        if (isErrorResult && !cacheErrors) {
            store.release(normalizedKey, lockToken, { tool: safeTool });
            const errObj = /** @type {Record<string, any>} */ (rawResult);
            if (typeof errObj.error?.code === 'string' && typeof errObj.error?.message === 'string') {
                return errorEnvelope(
                    errObj.error.code,
                    errObj.error.message,
                    errObj.error.details !== undefined ? errObj.error.details : { key: normalizedKey },
                    typeof errObj.tool === 'string' && errObj.tool.trim().length > 0
                        ? errObj.tool
                        : safeTool
                );
            }
            return errorEnvelope(
                'IDEMPOTENCY_HANDLER_ERROR',
                typeof errObj.message === 'string' && errObj.message.trim().length > 0
                    ? errObj.message
                    : 'Handler returned an unsuccessful result',
                { key: normalizedKey },
                safeTool
            );
        }

        const normalizedResult = rawResult === undefined ? null : rawResult;
        const statusCode = resolveHandlerStatusCode(normalizedResult);
        const commitRes = store.commit(normalizedKey, lockToken, {
            statusCode,
            body: normalizedResult,
            tool: safeTool,
        });
        if (!commitRes.ok) {
            store.release(normalizedKey, lockToken, { tool: safeTool });
            return commitRes;
        }

        const clonedOut = cloneBodyValue(normalizedResult);
        return okEnvelope(safeTool, 'Idempotent execution completed', {
            replayed: false,
            key: normalizedKey,
            statusCode,
            result: clonedOut.ok ? clonedOut.value : null,
        });
    } catch (err) {
        return errorEnvelope(
            'IDEMPOTENCY_INVALID_OPTIONS',
            err instanceof Error ? err.message : 'Idempotent execution failed',
            null,
            safeTool
        );
    }
}

/**
 * Extract the client `Idempotency-Key` header from an incoming Node/Express request,
 * explicitly detecting duplicate header arrays or duplicate `rawHeaders` entries.
 *
 * @param {any} req - Incoming HTTP request
 * @param {string} lowerHeaderName - Lowercased header name
 * @returns {{ duplicate: true } | { duplicate: false, value: unknown }}
 */
function readRequestIdempotencyHeader(req, lowerHeaderName) {
    if (Array.isArray(req?.rawHeaders)) {
        let rawMatches = 0;
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
            if (String(req.rawHeaders[i] ?? '').toLowerCase() === lowerHeaderName) {
                rawMatches += 1;
                if (rawMatches > 1) {
                    return { duplicate: true };
                }
            }
        }
    }

    const headers = req?.headers;
    if (headers && typeof headers === 'object') {
        if (Object.hasOwn(headers, lowerHeaderName)) {
            const direct = headers[lowerHeaderName];
            if (Array.isArray(direct)) {
                return { duplicate: true };
            }
            // Also verify no differently-cased duplicate exists in mock header bags
            let matchedKeys = 0;
            for (const k of Object.keys(headers)) {
                if (k.toLowerCase() === lowerHeaderName) {
                    matchedKeys += 1;
                    if (matchedKeys > 1) return { duplicate: true };
                }
            }
            return { duplicate: false, value: direct };
        }

        let foundValue;
        let matchedKeys = 0;
        for (const k of Object.keys(headers)) {
            if (k.toLowerCase() === lowerHeaderName) {
                matchedKeys += 1;
                if (matchedKeys > 1) {
                    return { duplicate: true };
                }
                foundValue = headers[k];
            }
        }
        if (matchedKeys === 1) {
            if (Array.isArray(foundValue)) {
                return { duplicate: true };
            }
            return { duplicate: false, value: foundValue };
        }
    }

    if (typeof req?.get === 'function') {
        const viaGetter = req.get(lowerHeaderName);
        if (Array.isArray(viaGetter)) {
            return { duplicate: true };
        }
        return { duplicate: false, value: viaGetter };
    }

    return { duplicate: false, value: undefined };
}

/**
 * Write an HTTP JSON or empty (`204`/`304`) response across Express `res`, native `http.ServerResponse`, and mocks.
 *
 * @param {any} res - Outgoing HTTP response
 * @param {number} statusCode - HTTP status code
 * @param {unknown} body - Response payload
 * @param {Record<string, string>} [extraHeaders={}] - Additional response headers
 */
function writeHttpJsonResponse(res, statusCode, body, extraHeaders = {}) {
    if (!res || res.writableEnded || res.destroyed) return;

    const isEmptyStatus = statusCode === 204 || statusCode === 304;
    if (!res.headersSent) {
        if (typeof res.setHeader === 'function') {
            for (const [k, v] of Object.entries(extraHeaders)) {
                res.setHeader(k, v);
            }
        } else if (typeof res.set === 'function') {
            for (const [k, v] of Object.entries(extraHeaders)) {
                res.set(k, v);
            }
        }
    }

    res.statusCode = statusCode;
    if (typeof res.status === 'function') {
        res.status(statusCode);
    }

    if (isEmptyStatus) {
        if (typeof res.end === 'function') {
            res.end();
        }
        return;
    }

    if (typeof res.json === 'function') {
        res.json(body);
        return;
    }

    const serialized = JSON.stringify(body ?? null);
    const wireHeaders = {
        ...extraHeaders,
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': String(Buffer.byteLength(serialized, 'utf8')),
    };

    if (!res.headersSent) {
        if (typeof res.setHeader === 'function') {
            res.setHeader('Content-Type', wireHeaders['Content-Type']);
            res.setHeader('Content-Length', wireHeaders['Content-Length']);
        } else if (typeof res.writeHead === 'function') {
            res.writeHead(statusCode, wireHeaders);
        }
    }

    if (typeof res.end === 'function') {
        res.end(serialized);
    }
}

/**
 * Collect safe replayable response headers from `res` (excluding hop-by-hop and `Set-Cookie` headers).
 *
 * @param {any} res - Outgoing HTTP response
 * @param {Record<string, string>} trackedHeaders - Headers captured via `writeHead` / `setHeader`
 * @returns {Record<string, string>}
 */
function collectReplayableHeaders(res, trackedHeaders) {
    /** @type {Record<string, string>} */
    const merged = { ...trackedHeaders };
    if (typeof res?.getHeaders === 'function') {
        try {
            const raw = res.getHeaders();
            if (raw && typeof raw === 'object') {
                for (const [k, v] of Object.entries(raw)) {
                    if (v === undefined || v === null || Array.isArray(v)) continue;
                    merged[k] = String(v);
                }
            }
        } catch {
            // Ignore mocks with throwing getHeaders
        }
    }

    /** @type {Record<string, string>} */
    const filtered = {};
    for (const [k, v] of Object.entries(merged)) {
        const lower = k.toLowerCase().trim();
        if (!lower || EXCLUDED_REPLAY_HEADERS.has(lower) || FORBIDDEN_OBJECT_KEYS.has(lower)) {
            continue;
        }
        const cleanName = k.replace(/[\r\n\x00]+/g, '').trim();
        if (!cleanName || !HTTP_HEADER_NAME_RE.test(cleanName)) continue;
        filtered[cleanName] = String(v).replace(/[\r\n\x00]+/g, '');
    }
    return filtered;
}

/**
 * Create an Express / Node HTTP idempotency middleware (`INV-LEGO-31`).
 *
 * Scopes keys by `${scope}:${method}:${pathname}:${key}`, rejects duplicate header arrays (`400`),
 * enforces `requireHeader` (`400`), blocks payload mismatches (`422`), guards concurrent in-flight
 * executions (`409` + `Retry-After: 1`), replays cached JSON responses with `Idempotency-Replayed: true`,
 * and releases locks without caching on `statusCode >= 500` or premature socket disconnects.
 *
 * @param {ReturnType<typeof createIdempotencyStore>} [store=createIdempotencyStore()] - Idempotency store handle
 * @param {object} [options={}] - Middleware configuration
 * @param {string} [options.headerName='idempotency-key'] - Request header carrying the idempotency key
 * @param {readonly string[]} [options.methods=['POST', 'PUT', 'PATCH', 'DELETE']] - Mutating HTTP verbs to guard
 * @param {boolean} [options.requireHeader=false] - Reject guarded requests lacking the header with `400`
 * @param {((req: any) => string) | null} [options.scopeKeyFn=null] - Optional tenant/actor scope extractor
 * @param {string} [options.tool='idempotency.middleware'] - Originating tool identifier
 * @returns {(req: any, res: any, next?: (err?: unknown) => unknown) => unknown}
 */
export function createIdempotencyMiddleware(store = createIdempotencyStore(), options = {}) {
    const safeTool = resolveSafeTool(options, 'idempotency.middleware');
    let headerName = DEFAULT_IDEMPOTENCY_OPTIONS.headerName;
    let requireHeader = false;
    /** @type {((req: any) => string) | null} */
    let scopeKeyFn = null;
    const allowedMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
    let configError = null;

    try {
        if (!isValidStoreHandle(store)) {
            configError = 'Valid idempotency store handle is required';
        } else if (
            options !== undefined &&
            options !== null &&
            (typeof options !== 'object' || Array.isArray(options))
        ) {
            configError = 'createIdempotencyMiddleware options must be a plain object';
        } else {
            const opts = /** @type {Record<string, unknown>} */ (options || {});
            if (opts.headerName !== undefined) {
                if (
                    typeof opts.headerName !== 'string' ||
                    opts.headerName.trim().length === 0 ||
                    ASCII_CONTROL_CHARS_RE.test(opts.headerName) ||
                    !HTTP_HEADER_NAME_RE.test(opts.headerName.trim())
                ) {
                    configError = 'headerName must be a valid non-empty HTTP header token';
                } else {
                    headerName = opts.headerName.trim().toLowerCase();
                }
            }

            if (!configError && opts.methods !== undefined) {
                if (!Array.isArray(opts.methods) || opts.methods.length === 0) {
                    configError = 'methods must be a non-empty array of HTTP verbs';
                } else {
                    allowedMethods.clear();
                    for (const m of opts.methods) {
                        if (typeof m === 'string' && m.trim().length > 0) {
                            allowedMethods.add(m.trim().toUpperCase());
                        }
                    }
                    if (allowedMethods.size === 0) {
                        configError = 'methods must contain at least one non-empty HTTP verb';
                    }
                }
            }

            if (!configError && opts.requireHeader !== undefined) {
                if (typeof opts.requireHeader !== 'boolean') {
                    configError = 'requireHeader must be a boolean';
                } else {
                    requireHeader = opts.requireHeader;
                }
            }

            if (!configError && opts.scopeKeyFn !== undefined && opts.scopeKeyFn !== null) {
                if (typeof opts.scopeKeyFn !== 'function') {
                    configError = 'scopeKeyFn must be a function or null';
                } else {
                    scopeKeyFn = /** @type {(req: any) => string} */ (opts.scopeKeyFn);
                }
            }
        }
    } catch (err) {
        configError = err instanceof Error ? err.message : 'Invalid middleware configuration';
    }

    return (req, res, next) => {
        try {
            if (configError) {
                const env = errorEnvelope('IDEMPOTENCY_INVALID_OPTIONS', configError, null, safeTool);
                writeHttpJsonResponse(res, 500, env);
                return env;
            }

            const method =
                typeof req?.method === 'string' && req.method.trim().length > 0
                    ? req.method.trim().toUpperCase()
                    : 'GET';

            if (!allowedMethods.has(method)) {
                if (typeof next === 'function') return next();
                return undefined;
            }

            const headerLookup = readRequestIdempotencyHeader(req, headerName);
            if (headerLookup.duplicate) {
                const env = errorEnvelope(
                    'IDEMPOTENCY_KEY_INVALID',
                    `Duplicate ${headerName} headers are not allowed`,
                    { header: headerName, statusCode: 400 },
                    safeTool
                );
                writeHttpJsonResponse(res, 400, env);
                return env;
            }

            if (headerLookup.value === undefined) {
                if (!requireHeader) {
                    if (typeof next === 'function') return next();
                    return undefined;
                }
                const env = errorEnvelope(
                    'IDEMPOTENCY_KEY_MISSING',
                    `Missing required ${headerName} header`,
                    { header: headerName, statusCode: 400 },
                    safeTool
                );
                writeHttpJsonResponse(res, 400, env);
                return env;
            }

            const storeMaxKeyLength =
                STORE_METADATA.get(store)?.maxKeyLength ?? DEFAULT_IDEMPOTENCY_OPTIONS.maxKeyLength;

            const keyRes = normalizeIdempotencyKey(headerLookup.value, {
                maxKeyLength: storeMaxKeyLength,
                tool: safeTool,
            });
            if (!keyRes.ok) {
                writeHttpJsonResponse(res, 400, keyRes);
                return keyRes;
            }
            const normalizedKey = keyRes.data.key;

            // Resolve tenant/actor scope safely (fail-closed if custom scopeKeyFn throws)
            let rawScope;
            if (scopeKeyFn) {
                try {
                    rawScope = scopeKeyFn(req);
                } catch (err) {
                    const env = errorEnvelope(
                        'IDEMPOTENCY_SCOPE_ERROR',
                        err instanceof Error ? err.message : 'Failed to resolve idempotency scope',
                        null,
                        safeTool
                    );
                    writeHttpJsonResponse(res, 500, env);
                    return env;
                }
            } else {
                rawScope =
                    req?.auth?.tenantId ??
                    req?.user?.tenantId ??
                    req?.user?.id ??
                    'global';
            }

            const scope =
                (typeof rawScope === 'string' || typeof rawScope === 'number'
                    ? String(rawScope)
                    : ''
                )
                    .replace(/[\x00-\x1f\x7f]+/g, '')
                    .trim() || 'global';

            const rawUrl =
                typeof req?.originalUrl === 'string' && req.originalUrl.length > 0
                    ? req.originalUrl
                    : typeof req?.url === 'string' && req.url.length > 0
                      ? req.url
                      : typeof req?.path === 'string' && req.path.length > 0
                        ? req.path
                        : '/';

            const cleanFullUrl = rawUrl.replace(/[\x00-\x1f\x7f]+/g, '').trim() || '/';
            const qIdx = cleanFullUrl.indexOf('?');
            const pathname = (qIdx >= 0 ? cleanFullUrl.slice(0, qIdx) : cleanFullUrl) || '/';

            const compositeScopedKey = `${scope}:${method}:${pathname}:${normalizedKey}`;
            const effectiveStoreKey =
                compositeScopedKey.length <= storeMaxKeyLength
                    ? compositeScopedKey
                    : `sha256:${createHash('sha256').update(compositeScopedKey, 'utf8').digest('hex')}`.slice(
                          0,
                          storeMaxKeyLength
                      );

            const fpRes = computePayloadFingerprint(req?.body !== undefined ? req.body : null, {
                method,
                path: cleanFullUrl,
                tool: safeTool,
            });
            if (!fpRes.ok) {
                writeHttpJsonResponse(res, 400, fpRes);
                return fpRes;
            }
            const { fingerprint } = fpRes.data;

            const beginRes = store.begin(effectiveStoreKey, fingerprint, { tool: safeTool });
            if (!beginRes.ok) {
                const code = beginRes.error.code;
                if (code === 'IDEMPOTENCY_PAYLOAD_MISMATCH') {
                    writeHttpJsonResponse(res, 422, beginRes);
                    return beginRes;
                }
                if (code === 'IDEMPOTENCY_IN_FLIGHT') {
                    writeHttpJsonResponse(res, 409, beginRes, { 'Retry-After': '1' });
                    return beginRes;
                }
                if (code === 'IDEMPOTENCY_STORE_FULL') {
                    writeHttpJsonResponse(res, 503, beginRes, { 'Retry-After': '1' });
                    return beginRes;
                }
                writeHttpJsonResponse(res, 400, beginRes);
                return beginRes;
            }

            if (beginRes.data.outcome === 'REPLAY') {
                if (req && typeof req === 'object') {
                    try {
                        req.idempotency = {
                            key: normalizedKey,
                            scopedKey: effectiveStoreKey,
                            fingerprint,
                            lockToken: '',
                            replayed: true,
                        };
                    } catch {
                        // Ignore frozen request mocks
                    }
                }
                const replayHeaders = {
                    ...beginRes.data.headers,
                    'Idempotency-Replayed': 'true',
                };
                writeHttpJsonResponse(res, beginRes.data.statusCode, beginRes.data.body, replayHeaders);
                return beginRes;
            }

            const { lockToken } = beginRes.data;
            if (req && typeof req === 'object') {
                try {
                    req.idempotency = {
                        key: normalizedKey,
                        scopedKey: effectiveStoreKey,
                        fingerprint,
                        lockToken,
                        replayed: false,
                    };
                } catch {
                    // Ignore frozen request mocks
                }
            }

            if (!res || typeof res !== 'object') {
                store.release(effectiveStoreKey, lockToken, { tool: safeTool });
                if (typeof next === 'function') return next();
                return undefined;
            }

            let settled = false;
            let endCalled = false;
            let hasCapturedJson = false;
            let capturedJsonBody = null;
            let bodyTooLargeToCache = false;
            let bufferedBytes = 0;
            /** @type {Buffer[]} */
            const rawChunks = [];
            /** @type {Record<string, string>} */
            const trackedHeaders = {};
            /** @type {number | null} */
            let writeHeadStatus = null;

            const cleanupListeners = () => {
                if (typeof res.removeListener === 'function') {
                    res.removeListener('close', onPrematureClose);
                    res.removeListener('error', onResponseError);
                } else if (typeof res.off === 'function') {
                    res.off('close', onPrematureClose);
                    res.off('error', onResponseError);
                }
            };

            const releaseWithoutCaching = () => {
                if (settled) return;
                settled = true;
                cleanupListeners();
                store.release(effectiveStoreKey, lockToken, { tool: safeTool });
            };

            const appendRawChunk = (chunk, encoding) => {
                if (bodyTooLargeToCache || chunk === undefined || chunk === null) return;
                let buf;
                if (Buffer.isBuffer(chunk)) {
                    buf = chunk;
                } else if (chunk instanceof Uint8Array) {
                    buf = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
                } else if (typeof chunk === 'string') {
                    const enc =
                        typeof encoding === 'string' && Buffer.isEncoding(encoding)
                            ? encoding
                            : 'utf8';
                    buf = Buffer.from(chunk, enc);
                } else {
                    bodyTooLargeToCache = true;
                    rawChunks.length = 0;
                    return;
                }

                bufferedBytes += buf.length;
                if (bufferedBytes > MAX_CACHED_RESPONSE_BYTES) {
                    bodyTooLargeToCache = true;
                    rawChunks.length = 0;
                    return;
                }
                rawChunks.push(buf);
            };

            const finalizeCommit = () => {
                if (settled) return;
                const finalStatus =
                    writeHeadStatus ??
                    (typeof res.statusCode === 'number' && Number.isInteger(res.statusCode)
                        ? res.statusCode
                        : 200);

                if (finalStatus >= 500 || finalStatus < 100) {
                    releaseWithoutCaching();
                    return;
                }

                let bodyToCommit = null;
                if (hasCapturedJson) {
                    bodyToCommit = capturedJsonBody;
                } else {
                    if (bodyTooLargeToCache) {
                        releaseWithoutCaching();
                        return;
                    }
                    const combinedText =
                        rawChunks.length > 0 ? Buffer.concat(rawChunks).toString('utf8') : '';
                    if (combinedText.trim().length === 0) {
                        if (finalStatus === 204 || finalStatus === 304) {
                            bodyToCommit = null;
                        } else {
                            // Empty non-204 body without res.json: only commit null if no non-JSON content-type was declared
                            const declaredType = String(
                                trackedHeaders['content-type'] ??
                                    trackedHeaders['Content-Type'] ??
                                    (typeof res.getHeader === 'function' ? res.getHeader('content-type') : '') ??
                                    ''
                            ).toLowerCase();
                            if (declaredType && !declaredType.includes('application/json')) {
                                releaseWithoutCaching();
                                return;
                            }
                            bodyToCommit = null;
                        }
                    } else {
                        try {
                            bodyToCommit = JSON.parse(combinedText);
                        } catch {
                            releaseWithoutCaching();
                            return;
                        }
                    }
                }

                settled = true;
                cleanupListeners();
                const headersToStore = collectReplayableHeaders(res, trackedHeaders);
                const commitRes = store.commit(effectiveStoreKey, lockToken, {
                    statusCode: finalStatus,
                    body: bodyToCommit,
                    headers: headersToStore,
                    tool: safeTool,
                });
                if (!commitRes.ok) {
                    store.release(effectiveStoreKey, lockToken, { tool: safeTool });
                }
            };

            function onPrematureClose() {
                const premature =
                    typeof res.writableEnded === 'boolean' ? !res.writableEnded : !endCalled;
                if (!settled && premature) {
                    releaseWithoutCaching();
                }
            }

            function onResponseError() {
                if (!settled) {
                    releaseWithoutCaching();
                }
            }

            if (typeof res.once === 'function') {
                res.once('close', onPrematureClose);
                res.once('error', onResponseError);
            } else if (typeof res.on === 'function') {
                res.on('close', onPrematureClose);
                res.on('error', onResponseError);
            }

            if (!res.headersSent) {
                if (typeof res.setHeader === 'function') {
                    res.setHeader('Idempotency-Replayed', 'false');
                } else if (typeof res.set === 'function') {
                    res.set('Idempotency-Replayed', 'false');
                }
            }

            if (typeof res.setHeader === 'function') {
                const origSetHeader = res.setHeader.bind(res);
                res.setHeader = function interceptedSetHeader(name, value) {
                    if (typeof name === 'string' && value !== undefined && value !== null && !Array.isArray(value)) {
                        trackedHeaders[name] = String(value);
                    }
                    return origSetHeader(name, value);
                };
            }

            if (typeof res.writeHead === 'function') {
                const origWriteHead = res.writeHead.bind(res);
                res.writeHead = function interceptedWriteHead(statusCode, arg2, arg3) {
                    if (typeof statusCode === 'number' && Number.isInteger(statusCode)) {
                        writeHeadStatus = statusCode;
                    }
                    const hdrObj =
                        arg3 && typeof arg3 === 'object'
                            ? arg3
                            : arg2 && typeof arg2 === 'object' && !Array.isArray(arg2)
                              ? arg2
                              : null;
                    if (hdrObj) {
                        for (const [k, v] of Object.entries(hdrObj)) {
                            if (v !== undefined && v !== null && !Array.isArray(v)) {
                                trackedHeaders[k] = String(v);
                            }
                        }
                    }
                    if (typeof res.setHeader !== 'function') {
                        const hasReplayedKey = hdrObj
                            ? Object.keys(hdrObj).some((k) => k.toLowerCase() === 'idempotency-replayed')
                            : false;
                        if (!hasReplayedKey) {
                            const mergedHeaders = { 'Idempotency-Replayed': 'false', ...(hdrObj ?? {}) };
                            if (typeof arg2 === 'string') {
                                return origWriteHead(statusCode, arg2, mergedHeaders);
                            }
                            return origWriteHead(statusCode, mergedHeaders);
                        }
                    }
                    return origWriteHead(statusCode, arg2, arg3);
                };
            }

            if (typeof res.write === 'function') {
                const origWrite = res.write.bind(res);
                res.write = function interceptedWrite(chunk, encoding, cb) {
                    if (!hasCapturedJson) {
                        appendRawChunk(
                            chunk,
                            typeof encoding === 'string' ? encoding : undefined
                        );
                    }
                    return origWrite(chunk, encoding, cb);
                };
            }

            if (typeof res.json === 'function') {
                const origJson = res.json.bind(res);
                res.json = function interceptedJson(body) {
                    hasCapturedJson = true;
                    capturedJsonBody = body === undefined ? null : body;
                    const ret = origJson(body);
                    if (!settled) {
                        finalizeCommit();
                    }
                    return ret;
                };
            }

            if (typeof res.end === 'function') {
                const origEnd = res.end.bind(res);
                res.end = function interceptedEnd(chunk, encoding, cb) {
                    if (
                        !hasCapturedJson &&
                        chunk !== undefined &&
                        chunk !== null &&
                        typeof chunk !== 'function'
                    ) {
                        appendRawChunk(
                            chunk,
                            typeof encoding === 'string' ? encoding : undefined
                        );
                    }
                    endCalled = true;
                    const ret = origEnd(chunk, encoding, cb);
                    if (typeof res.writableEnded === 'boolean' && !res.writableEnded && res.destroyed) {
                        releaseWithoutCaching();
                    } else {
                        finalizeCommit();
                    }
                    return ret;
                };
            }

            if (typeof next !== 'function') {
                return undefined;
            }

            const wrappedNext = (err) => {
                if (err !== undefined && err !== null) {
                    releaseWithoutCaching();
                }
                return next(err);
            };

            try {
                const maybePromise = wrappedNext();
                if (maybePromise && typeof /** @type {any} */ (maybePromise).then === 'function') {
                    return /** @type {Promise<unknown>} */ (maybePromise).catch((err) => {
                        releaseWithoutCaching();
                        const env = errorEnvelope(
                            'IDEMPOTENCY_HANDLER_ERROR',
                            err instanceof Error ? err.message : 'Unhandled downstream error',
                            { key: normalizedKey },
                            safeTool
                        );
                        writeHttpJsonResponse(res, 500, env);
                        return env;
                    });
                }
                return maybePromise;
            } catch (err) {
                releaseWithoutCaching();
                const env = errorEnvelope(
                    'IDEMPOTENCY_HANDLER_ERROR',
                    err instanceof Error ? err.message : 'Unhandled downstream error',
                    { key: normalizedKey },
                    safeTool
                );
                writeHttpJsonResponse(res, 500, env);
                return env;
            }
        } catch (err) {
            const env = errorEnvelope(
                'IDEMPOTENCY_HANDLER_ERROR',
                err instanceof Error ? err.message : 'Idempotency middleware failed',
                null,
                safeTool
            );
            try {
                writeHttpJsonResponse(res, 500, env);
            } catch {
                // Ignore broken response mock
            }
            return env;
        }
    };
}
