/**
 * @module pagination
 * @description HMAC-signed keyset cursor encoding/decoding and bounded limit pagination
 * bricks (`INV-LEGO-34`) emitting deterministic `INV-LEGO-01` envelopes without throwing
 * on untrusted query parameters or cursor tokens.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { okEnvelope, errorEnvelope } from './http.js';

const CURSOR_DOMAIN_PREFIX = 'krusch-cursor-v1.';
const CURSOR_CHARSET_RE = /^[A-Za-z0-9_.-]+$/;
const INTEGER_STRING_RE = /^\s*-?\d+\s*$/;
const FORBIDDEN_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_ALLOWED_PAGE_LIMIT = 10_000;
const MAX_ALLOWED_CURSOR_LENGTH = 65_536;
const MAX_CURSOR_DEPTH = 32;

const UTF8_FATAL_DECODER = new TextDecoder('utf-8', { fatal: true });

/**
 * Default pagination bounds and cursor size limits (`INV-LEGO-34`).
 */
export const DEFAULT_PAGINATION_LIMITS = Object.freeze({
    defaultLimit: 25,
    minLimit: 1,
    maxLimit: 100,
    maxCursorLength: 2048,
});

/**
 * Resolve a non-empty tool identifier for `INV-LEGO-01` envelopes.
 *
 * @param {unknown} tool - Candidate tool name
 * @param {string} fallback - Default tool name
 * @returns {string}
 */
function resolveToolName(tool, fallback) {
    return typeof tool === 'string' && tool.trim().length > 0 ? tool.trim() : fallback;
}

/**
 * Format an arbitrary unknown value safely for `RangeError` diagnostics without invoking
 * hostile object coercions.
 *
 * @param {unknown} value - Candidate value
 * @returns {string}
 */
function formatSafeDiagnostic(value) {
    if (
        value === null ||
        value === undefined ||
        typeof value === 'number' ||
        typeof value === 'boolean' ||
        typeof value === 'string'
    ) {
        return String(value);
    }
    return typeof value;
}

/**
 * Check whether a value is a plain object (`{}` or `Object.create(null)`), excluding
 * arrays, primitives, built-in namespaces, and class instances.
 *
 * @param {unknown} value - Candidate value
 * @returns {boolean}
 */
function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
        return false;
    }
    return Object.prototype.toString.call(value) === '[object Object]';
}

/**
 * Detect lone UTF-16 surrogates in a JavaScript string so serialized JSON is guaranteed
 * to be well-formed UTF-8 across engines.
 *
 * @param {string} str - Input string
 * @returns {boolean}
 */
function hasLoneSurrogate(str) {
    for (let i = 0; i < str.length; i += 1) {
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

/**
 * Recursively validate and deep-clone a JSON-safe cursor value while rejecting forbidden
 * prototype keys (`__proto__`, `constructor`, `prototype`), class instances, circular
 * references, `BigInt`, `Symbol`, `Function`, `NaN`/`Infinity`, and lone surrogates.
 *
 * @param {unknown} value - Candidate cursor value
 * @param {Set<object>} seen - Active ancestor set for cycle detection
 * @param {number} depth - Current recursion depth
 * @returns {{ ok: true, value: unknown } | { ok: false, reason: string }}
 */
function sanitizeCursorValue(value, seen, depth) {
    if (depth > MAX_CURSOR_DEPTH) {
        return { ok: false, reason: `Cursor payload exceeds maximum depth (${MAX_CURSOR_DEPTH})` };
    }

    if (value === null || typeof value === 'boolean') {
        return { ok: true, value };
    }

    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            return { ok: false, reason: 'Cursor payload cannot contain NaN or Infinity' };
        }
        return { ok: true, value: Object.is(value, -0) ? 0 : value };
    }

    if (typeof value === 'string') {
        if (hasLoneSurrogate(value)) {
            return { ok: false, reason: 'Cursor payload cannot contain lone UTF-16 surrogates' };
        }
        return { ok: true, value };
    }

    if (
        typeof value === 'bigint' ||
        typeof value === 'symbol' ||
        typeof value === 'function' ||
        typeof value === 'undefined'
    ) {
        return { ok: false, reason: `Cursor payload cannot contain ${typeof value} values` };
    }

    if (Array.isArray(value)) {
        if (seen.has(value)) {
            return { ok: false, reason: 'Cursor payload contains a circular reference' };
        }
        let ownSymbols;
        let ownNames;
        try {
            ownSymbols = Object.getOwnPropertySymbols(value);
            ownNames = Object.getOwnPropertyNames(value);
        } catch {
            return { ok: false, reason: 'Cursor payload array could not be inspected safely' };
        }
        if (ownSymbols.length > 0) {
            return { ok: false, reason: 'Cursor payload cannot contain Symbol properties' };
        }
        for (const name of ownNames) {
            if (name !== 'length' && FORBIDDEN_OBJECT_KEYS.has(name)) {
                return { ok: false, reason: `Cursor payload contains forbidden key "${name}"` };
            }
        }

        seen.add(value);
        const out = [];
        try {
            for (let i = 0; i < value.length; i += 1) {
                const elem = value[i];
                if (elem === undefined) {
                    out.push(null);
                    continue;
                }
                const child = sanitizeCursorValue(elem, seen, depth + 1);
                if (!child.ok) return child;
                out.push(child.value);
            }
        } catch {
            return { ok: false, reason: 'Cursor payload array element getter threw an exception' };
        } finally {
            seen.delete(value);
        }
        return { ok: true, value: out };
    }

    if (isPlainObject(value)) {
        if (seen.has(value)) {
            return { ok: false, reason: 'Cursor payload contains a circular reference' };
        }
        let ownSymbols;
        let ownNames;
        let enumerableKeys;
        try {
            ownSymbols = Object.getOwnPropertySymbols(value);
            ownNames = Object.getOwnPropertyNames(value);
            enumerableKeys = Object.keys(value);
        } catch {
            return { ok: false, reason: 'Cursor payload object could not be inspected safely' };
        }
        if (ownSymbols.length > 0) {
            return { ok: false, reason: 'Cursor payload cannot contain Symbol properties' };
        }
        for (const key of ownNames) {
            if (FORBIDDEN_OBJECT_KEYS.has(key)) {
                return { ok: false, reason: `Cursor payload contains forbidden own key "${key}"` };
            }
            if (hasLoneSurrogate(key)) {
                return { ok: false, reason: 'Cursor payload key contains lone UTF-16 surrogates' };
            }
        }

        seen.add(value);
        const cleanObj = {};
        try {
            for (const key of enumerableKeys) {
                const propVal = value[key];
                if (propVal === undefined) {
                    continue;
                }
                const child = sanitizeCursorValue(propVal, seen, depth + 1);
                if (!child.ok) return child;
                Object.defineProperty(cleanObj, key, {
                    value: child.value,
                    enumerable: true,
                    writable: true,
                    configurable: true,
                });
            }
        } catch {
            return { ok: false, reason: 'Cursor payload property getter threw an exception' };
        } finally {
            seen.delete(value);
        }
        return { ok: true, value: cleanObj };
    }

    return { ok: false, reason: 'Cursor payload must contain only plain objects and JSON primitives' };
}

/**
 * Clamp an untrusted `rawLimit` input into `[minLimit, maxLimit]` without throwing on
 * malformed user input. Throws `RangeError` only when developer-configured bounds violate
 * `1 <= minLimit <= defaultLimit <= maxLimit <= 10_000`.
 *
 * @param {unknown} rawLimit - Untrusted limit parameter (e.g. query string or JSON value)
 * @param {object} [options={}] - Developer pagination bounds
 * @param {number} [options.defaultLimit=25] - Fallback limit when `rawLimit` is missing/invalid
 * @param {number} [options.minLimit=1] - Minimum permitted page size (`>= 1`)
 * @param {number} [options.maxLimit=100] - Maximum permitted page size (`<= 10_000`)
 * @returns {number}
 */
export function clampPageLimit(rawLimit, options = {}) {
    if (options !== null && options !== undefined && (typeof options !== 'object' || Array.isArray(options))) {
        throw new RangeError('Pagination bounds options must be a plain object');
    }
    const {
        defaultLimit = DEFAULT_PAGINATION_LIMITS.defaultLimit,
        minLimit = DEFAULT_PAGINATION_LIMITS.minLimit,
        maxLimit = DEFAULT_PAGINATION_LIMITS.maxLimit,
    } = options ?? {};
    if (
        !Number.isInteger(minLimit) ||
        !Number.isInteger(defaultLimit) ||
        !Number.isInteger(maxLimit) ||
        minLimit < 1 ||
        minLimit > defaultLimit ||
        defaultLimit > maxLimit ||
        maxLimit > MAX_ALLOWED_PAGE_LIMIT
    ) {
        throw new RangeError(
            `Invalid pagination bounds: expected integers satisfying 1 <= minLimit (${formatSafeDiagnostic(minLimit)}) <= defaultLimit (${formatSafeDiagnostic(defaultLimit)}) <= maxLimit (${formatSafeDiagnostic(maxLimit)}) <= ${MAX_ALLOWED_PAGE_LIMIT}`
        );
    }

    if (typeof rawLimit === 'number') {
        if (!Number.isFinite(rawLimit)) {
            return defaultLimit;
        }
        const truncated = Math.trunc(rawLimit);
        return Math.min(maxLimit, Math.max(minLimit, truncated));
    }

    if (typeof rawLimit === 'string') {
        if (!INTEGER_STRING_RE.test(rawLimit)) {
            return defaultLimit;
        }
        const parsed = Number(rawLimit.trim());
        if (Number.isNaN(parsed)) {
            return defaultLimit;
        }
        const integral = Number.isFinite(parsed) ? Math.trunc(parsed) : parsed;
        return Math.min(maxLimit, Math.max(minLimit, integral));
    }

    return defaultLimit;
}

/**
 * Validate and encode a plain-object cursor payload as an unpadded base64url token,
 * optionally bound to a scope, TTL expiration, and domain-separated HMAC-SHA256 signature.
 *
 * @param {Record<string, unknown>} cursorPayload - Plain object cursor state
 * @param {object} [options={}] - Encoding options
 * @param {string} [options.secret=''] - Optional HMAC-SHA256 signing secret
 * @param {string} [options.scope=''] - Optional logical endpoint/query scope binding
 * @param {number} [options.ttlMs=0] - Optional time-to-live in milliseconds (`0` disables expiry)
 * @param {number} [options.maxCursorLength=2048] - Maximum allowed encoded cursor length
 * @param {() => number} [options.nowFn=Date.now] - Deterministic clock function returning epoch ms
 * @param {string} [options.tool='pagination.encode'] - Originating tool identifier
 * @returns {{ ok: true, tool: string, summary: string, data: { cursor: string, signed: boolean, expiresAt: number | null } } | { ok: false, tool: string, summary: string, error: { code: string, message: string, details?: unknown } }}
 */
export function encodeCursor(cursorPayload, options = {}) {
    if (options !== null && options !== undefined && (typeof options !== 'object' || Array.isArray(options))) {
        return errorEnvelope(
            'CURSOR_INVALID_OPTIONS',
            'Cursor encode options must be a plain object',
            null,
            'pagination.encode'
        );
    }

    const opts = options ?? {};
    const toolName = resolveToolName(opts.tool, 'pagination.encode');
    const secret = opts.secret === undefined ? '' : opts.secret;
    const scope = opts.scope === undefined || opts.scope === null ? '' : opts.scope;
    const ttlMs = opts.ttlMs === undefined ? 0 : opts.ttlMs;
    const maxCursorLength =
        opts.maxCursorLength === undefined
            ? DEFAULT_PAGINATION_LIMITS.maxCursorLength
            : opts.maxCursorLength;
    const nowFn = opts.nowFn === undefined ? Date.now : opts.nowFn;

    if (
        !Number.isInteger(maxCursorLength) ||
        maxCursorLength < 1 ||
        maxCursorLength > MAX_ALLOWED_CURSOR_LENGTH
    ) {
        return errorEnvelope(
            'CURSOR_INVALID_OPTIONS',
            `maxCursorLength must be an integer between 1 and ${MAX_ALLOWED_CURSOR_LENGTH}`,
            { maxCursorLength },
            toolName
        );
    }

    if (typeof scope !== 'string' || hasLoneSurrogate(scope)) {
        return errorEnvelope(
            'CURSOR_INVALID_OPTIONS',
            'Cursor scope must be a valid UTF-16 string',
            null,
            toolName
        );
    }

    if (secret !== '' && (typeof secret !== 'string' || secret.trim().length === 0)) {
        return errorEnvelope(
            'CURSOR_INVALID_SECRET',
            'Cursor signing secret must be a non-empty, non-whitespace string when provided',
            null,
            toolName
        );
    }

    if (ttlMs !== 0 && (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= 0)) {
        return errorEnvelope(
            'CURSOR_INVALID_OPTIONS',
            'Cursor ttlMs must be 0 or a finite positive number',
            { ttlMs },
            toolName
        );
    }

    if (typeof nowFn !== 'function') {
        return errorEnvelope(
            'CURSOR_INVALID_OPTIONS',
            'Cursor nowFn must be a function',
            null,
            toolName
        );
    }

    if (!isPlainObject(cursorPayload)) {
        return errorEnvelope(
            'CURSOR_INVALID_PAYLOAD',
            'Cursor payload must be a non-null plain object',
            null,
            toolName
        );
    }

    const sanitized = sanitizeCursorValue(cursorPayload, new Set(), 0);
    if (!sanitized.ok) {
        return errorEnvelope('CURSOR_INVALID_PAYLOAD', sanitized.reason, null, toolName);
    }

    let expiresAt = null;
    if (ttlMs > 0) {
        let nowMs;
        try {
            nowMs = nowFn();
        } catch (err) {
            return errorEnvelope(
                'CURSOR_INVALID_OPTIONS',
                `Cursor nowFn threw an exception: ${err instanceof Error ? err.message : 'unknown error'}`,
                null,
                toolName
            );
        }
        if (typeof nowMs !== 'number' || !Number.isFinite(nowMs) || !Number.isFinite(nowMs + ttlMs)) {
            return errorEnvelope(
                'CURSOR_INVALID_OPTIONS',
                'Cursor nowFn must return a finite epoch timestamp',
                null,
                toolName
            );
        }
        expiresAt = Math.floor(nowMs + ttlMs);
    }

    const hasSecret = secret.length > 0;
    const envelope = {
        v: 1,
        d: sanitized.value,
        ...(scope ? { s: scope } : {}),
        ...(expiresAt !== null ? { exp: expiresAt } : {}),
    };

    const payloadB64 = Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64url');
    const cursor = hasSecret
        ? `${payloadB64}.${createHmac('sha256', secret).update(CURSOR_DOMAIN_PREFIX + payloadB64, 'utf8').digest('base64url')}`
        : payloadB64;

    if (cursor.length > maxCursorLength) {
        return errorEnvelope(
            'CURSOR_TOO_LARGE',
            `Encoded cursor length (${cursor.length}) exceeds maxCursorLength (${maxCursorLength})`,
            { length: cursor.length, maxCursorLength },
            toolName
        );
    }

    return okEnvelope(toolName, 'Cursor encoded', {
        cursor,
        signed: hasSecret,
        expiresAt,
    });
}

/**
 * Decode and verify an opaque pagination cursor in constant time without throwing on
 * malformed, tampered, wrong-scope, or expired tokens.
 *
 * @param {unknown} rawCursor - Raw cursor token from client request
 * @param {object} [options={}] - Verification options
 * @param {string} [options.secret=''] - HMAC-SHA256 signing secret
 * @param {boolean} [options.requireSignature=Boolean(secret)] - Require cryptographic signature
 * @param {string} [options.expectedScope=''] - Expected scope string when cursor is scope-bound
 * @param {number} [options.maxCursorLength=2048] - Maximum accepted cursor character length
 * @param {() => number} [options.nowFn=Date.now] - Deterministic clock function returning epoch ms
 * @param {string} [options.tool='pagination.decode'] - Originating tool identifier
 * @returns {{ ok: true, tool: string, summary: string, data: { payload: Record<string, unknown>, scope: string, expiresAt: number | null, signed: boolean } } | { ok: false, tool: string, summary: string, error: { code: string, message: string, details?: unknown } }}
 */
export function decodeCursor(rawCursor, options = {}) {
    if (options !== null && options !== undefined && (typeof options !== 'object' || Array.isArray(options))) {
        return errorEnvelope(
            'CURSOR_INVALID_OPTIONS',
            'Cursor decode options must be a plain object',
            null,
            'pagination.decode'
        );
    }

    const opts = options ?? {};
    const toolName = resolveToolName(opts.tool, 'pagination.decode');
    const secret = opts.secret === undefined ? '' : opts.secret;
    const requireSignature =
        opts.requireSignature === undefined ? Boolean(secret) : Boolean(opts.requireSignature);
    const expectedScope =
        opts.expectedScope === undefined || opts.expectedScope === null ? '' : opts.expectedScope;
    const maxCursorLength =
        opts.maxCursorLength === undefined
            ? DEFAULT_PAGINATION_LIMITS.maxCursorLength
            : opts.maxCursorLength;
    const nowFn = opts.nowFn === undefined ? Date.now : opts.nowFn;

    if (
        !Number.isInteger(maxCursorLength) ||
        maxCursorLength < 1 ||
        maxCursorLength > MAX_ALLOWED_CURSOR_LENGTH
    ) {
        return errorEnvelope(
            'CURSOR_INVALID_OPTIONS',
            `maxCursorLength must be an integer between 1 and ${MAX_ALLOWED_CURSOR_LENGTH}`,
            { maxCursorLength },
            toolName
        );
    }

    if (typeof expectedScope !== 'string') {
        return errorEnvelope(
            'CURSOR_INVALID_OPTIONS',
            'Cursor expectedScope must be a string',
            null,
            toolName
        );
    }

    if (typeof nowFn !== 'function') {
        return errorEnvelope(
            'CURSOR_INVALID_OPTIONS',
            'Cursor nowFn must be a function',
            null,
            toolName
        );
    }

    if (typeof rawCursor !== 'string' || rawCursor.length === 0) {
        return errorEnvelope('CURSOR_MISSING', 'Cursor must be a non-empty string', null, toolName);
    }

    if (rawCursor.length > maxCursorLength) {
        return errorEnvelope(
            'CURSOR_TOO_LARGE',
            `Cursor length (${rawCursor.length}) exceeds maxCursorLength (${maxCursorLength})`,
            { length: rawCursor.length, maxCursorLength },
            toolName
        );
    }

    if (!CURSOR_CHARSET_RE.test(rawCursor)) {
        return errorEnvelope(
            'CURSOR_MALFORMED',
            'Cursor contains characters outside the unpadded base64url alphabet',
            null,
            toolName
        );
    }

    const parts = rawCursor.split('.');
    if (parts.length > 2 || parts.some((segment) => segment.length === 0)) {
        return errorEnvelope('CURSOR_MALFORMED', 'Cursor structure is malformed', null, toolName);
    }

    const hasValidSecret = typeof secret === 'string' && secret.trim().length > 0;
    if (secret !== '' && !hasValidSecret && !requireSignature) {
        return errorEnvelope(
            'CURSOR_INVALID_SECRET',
            'Cursor signing secret must be a non-empty, non-whitespace string when provided',
            null,
            toolName
        );
    }

    const payloadB64 = parts[0];
    const sigB64 = parts.length === 2 ? parts[1] : null;
    let isSigned = false;

    if (requireSignature) {
        if (!hasValidSecret) {
            return errorEnvelope(
                'CURSOR_SECRET_REQUIRED',
                'A non-empty signing secret is required to verify signed cursors',
                null,
                toolName
            );
        }
        if (sigB64 === null) {
            return errorEnvelope(
                'CURSOR_SIGNATURE_MISSING',
                'Cursor is missing a required cryptographic signature',
                null,
                toolName
            );
        }
    } else if (sigB64 !== null && !hasValidSecret) {
        return errorEnvelope(
            'CURSOR_SECRET_REQUIRED',
            'A signing secret is required to decode a signed cursor',
            null,
            toolName
        );
    }

    if (sigB64 !== null && hasValidSecret) {
        const expectedSigBytes = createHmac('sha256', secret)
            .update(CURSOR_DOMAIN_PREFIX + payloadB64, 'utf8')
            .digest();
        const sigBytes = Buffer.from(sigB64, 'base64url');
        const isCanonicalSig =
            sigBytes.length > 0 && sigBytes.toString('base64url') === sigB64;
        const digestsMatch =
            sigBytes.length === expectedSigBytes.length &&
            timingSafeEqual(sigBytes, expectedSigBytes);

        if (!isCanonicalSig || !digestsMatch) {
            return errorEnvelope(
                'CURSOR_INVALID_SIGNATURE',
                'Cursor HMAC signature verification failed',
                null,
                toolName
            );
        }
        isSigned = true;
    }

    const payloadBytes = Buffer.from(payloadB64, 'base64url');
    if (payloadBytes.length === 0 || payloadBytes.toString('base64url') !== payloadB64) {
        return errorEnvelope(
            'CURSOR_MALFORMED',
            'Cursor payload is not canonical unpadded base64url',
            null,
            toolName
        );
    }

    let jsonText;
    try {
        jsonText = UTF8_FATAL_DECODER.decode(payloadBytes);
    } catch {
        return errorEnvelope(
            'CURSOR_MALFORMED',
            'Cursor payload is not valid UTF-8',
            null,
            toolName
        );
    }

    let parsedEnvelope;
    try {
        parsedEnvelope = JSON.parse(jsonText);
    } catch {
        return errorEnvelope(
            'CURSOR_MALFORMED',
            'Cursor payload is not valid JSON',
            null,
            toolName
        );
    }

    if (!isPlainObject(parsedEnvelope)) {
        return errorEnvelope(
            'CURSOR_MALFORMED',
            'Decoded cursor envelope must be a plain object',
            null,
            toolName
        );
    }

    for (const key of Object.getOwnPropertyNames(parsedEnvelope)) {
        if (FORBIDDEN_OBJECT_KEYS.has(key)) {
            return errorEnvelope(
                'CURSOR_MALFORMED',
                `Decoded cursor envelope contains forbidden key "${key}"`,
                null,
                toolName
            );
        }
    }

    if (parsedEnvelope.v !== 1 || !Object.hasOwn(parsedEnvelope, 'd') || !isPlainObject(parsedEnvelope.d)) {
        return errorEnvelope(
            'CURSOR_MALFORMED',
            'Decoded cursor envelope version or data payload is invalid',
            null,
            toolName
        );
    }

    if (Object.hasOwn(parsedEnvelope, 's') && typeof parsedEnvelope.s !== 'string') {
        return errorEnvelope(
            'CURSOR_MALFORMED',
            'Decoded cursor scope field is malformed',
            null,
            toolName
        );
    }

    if (
        Object.hasOwn(parsedEnvelope, 'exp') &&
        (typeof parsedEnvelope.exp !== 'number' || !Number.isFinite(parsedEnvelope.exp))
    ) {
        return errorEnvelope(
            'CURSOR_MALFORMED',
            'Decoded cursor expiration field is malformed',
            null,
            toolName
        );
    }

    const cleanData = sanitizeCursorValue(parsedEnvelope.d, new Set(), 0);
    if (!cleanData.ok || !isPlainObject(cleanData.value)) {
        return errorEnvelope(
            'CURSOR_MALFORMED',
            'Decoded cursor payload contains invalid or unsafe properties',
            null,
            toolName
        );
    }

    const exp = Object.hasOwn(parsedEnvelope, 'exp') ? parsedEnvelope.exp : null;
    if (typeof exp === 'number') {
        let nowMs;
        try {
            nowMs = nowFn();
        } catch (err) {
            return errorEnvelope(
                'CURSOR_INVALID_OPTIONS',
                `Cursor nowFn threw an exception: ${err instanceof Error ? err.message : 'unknown error'}`,
                null,
                toolName
            );
        }
        if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) {
            return errorEnvelope(
                'CURSOR_INVALID_OPTIONS',
                'Cursor nowFn must return a finite epoch timestamp',
                null,
                toolName
            );
        }
        if (nowMs > exp) {
            return errorEnvelope(
                'CURSOR_EXPIRED',
                'Pagination cursor has expired',
                { expiresAt: exp },
                toolName
            );
        }
    }

    const cursorScope = Object.hasOwn(parsedEnvelope, 's') ? parsedEnvelope.s : '';
    if (expectedScope && cursorScope !== expectedScope) {
        return errorEnvelope(
            'CURSOR_SCOPE_MISMATCH',
            `Cursor scope "${cursorScope}" does not match expected scope "${expectedScope}"`,
            { expectedScope, actualScope: cursorScope },
            toolName
        );
    }

    return okEnvelope(toolName, 'Cursor decoded', {
        payload: cleanData.value,
        scope: cursorScope,
        expiresAt: exp,
        signed: isSigned,
    });
}

/**
 * Normalize a sort or key field value so `Date` instances serialize cleanly as ISO-8601
 * strings and `undefined` normalizes to `null`.
 *
 * @param {unknown} value - Raw field value
 * @returns {unknown}
 */
function normalizeCursorFieldValue(value) {
    if (value === undefined || value === null) {
        return null;
    }
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return value.toISOString();
    }
    return value;
}

/**
 * Resolve effective pagination limit for `buildKeysetPage` / `paginateItems`, returning
 * either `{ ok: true, effectiveLimit }` or an `errorEnvelope`.
 *
 * @param {object} opts - Raw options object
 * @param {string} toolName - Envelope tool name
 * @returns {{ ok: true, effectiveLimit: number } | { ok: false, envelope: object }}
 */
function resolveEffectivePageLimit(opts, toolName) {
    const maxLimit =
        opts.maxLimit === undefined ? DEFAULT_PAGINATION_LIMITS.maxLimit : opts.maxLimit;
    const defaultLimit =
        opts.defaultLimit !== undefined
            ? opts.defaultLimit
            : Number.isInteger(maxLimit) && maxLimit >= 1
              ? Math.min(DEFAULT_PAGINATION_LIMITS.defaultLimit, maxLimit)
              : DEFAULT_PAGINATION_LIMITS.defaultLimit;

    try {
        const effectiveLimit = clampPageLimit(opts.limit, {
            defaultLimit,
            minLimit: DEFAULT_PAGINATION_LIMITS.minLimit,
            maxLimit,
        });
        return { ok: true, effectiveLimit };
    } catch (err) {
        return {
            ok: false,
            envelope: errorEnvelope(
                'PAGINATION_INVALID_OPTIONS',
                err instanceof Error ? err.message : 'Invalid pagination bounds',
                null,
                toolName
            ),
        };
    }
}

/**
 * Construct a keyset pagination envelope from a `limit + 1` lookahead query result array.
 * Slices `rows` to `effectiveLimit`, computes `hasMore`, and encodes `nextCursor` over
 * `{ sortValue, id, sortField, idField }` when additional rows exist.
 *
 * @param {ReadonlyArray<Record<string, unknown>>} rows - Candidate rows (`limit + 1` lookahead)
 * @param {object} [options={}] - Keyset page options
 * @param {unknown} [options.limit=25] - Requested page size
 * @param {number} [options.defaultLimit=25] - Fallback limit when `limit` is missing/invalid
 * @param {number} [options.maxLimit=100] - Maximum permitted page size
 * @param {string} [options.sortField='createdAt'] - Primary sort column property name
 * @param {string} [options.idField='id'] - Unique tie-breaker property name
 * @param {string} [options.secret=''] - Optional HMAC-SHA256 cursor signing secret
 * @param {string} [options.scope=''] - Optional cursor scope binding
 * @param {number} [options.ttlMs=0] - Optional cursor TTL in milliseconds
 * @param {number} [options.maxCursorLength=2048] - Maximum allowed encoded cursor length
 * @param {() => number} [options.nowFn=Date.now] - Deterministic clock function
 * @param {string} [options.tool='pagination.page'] - Originating tool identifier
 * @returns {{ ok: true, tool: string, summary: string, data: { items: Array<Record<string, unknown>>, pageInfo: { limit: number, count: number, hasMore: boolean, nextCursor: string | null } } } | { ok: false, tool: string, summary: string, error: { code: string, message: string, details?: unknown } }}
 */
export function buildKeysetPage(rows, options = {}) {
    if (options !== null && options !== undefined && (typeof options !== 'object' || Array.isArray(options))) {
        return errorEnvelope(
            'PAGINATION_INVALID_OPTIONS',
            'Pagination options must be a plain object',
            null,
            'pagination.page'
        );
    }

    const opts = options ?? {};
    const toolName = resolveToolName(opts.tool, 'pagination.page');

    if (!Array.isArray(rows)) {
        return errorEnvelope(
            'PAGINATION_INVALID_ROWS',
            'Pagination rows must be an array',
            null,
            toolName
        );
    }

    const sortField = opts.sortField === undefined ? 'createdAt' : opts.sortField;
    const idField = opts.idField === undefined ? 'id' : opts.idField;
    const secret = opts.secret === undefined ? '' : opts.secret;
    const scope = opts.scope === undefined || opts.scope === null ? '' : opts.scope;
    const ttlMs = opts.ttlMs === undefined ? 0 : opts.ttlMs;
    const maxCursorLength =
        opts.maxCursorLength === undefined
            ? DEFAULT_PAGINATION_LIMITS.maxCursorLength
            : opts.maxCursorLength;
    const nowFn = opts.nowFn === undefined ? Date.now : opts.nowFn;

    if (
        typeof sortField !== 'string' ||
        sortField.trim().length === 0 ||
        FORBIDDEN_OBJECT_KEYS.has(sortField) ||
        typeof idField !== 'string' ||
        idField.trim().length === 0 ||
        FORBIDDEN_OBJECT_KEYS.has(idField)
    ) {
        return errorEnvelope(
            'PAGINATION_INVALID_OPTIONS',
            'sortField and idField must be non-empty safe property names',
            { sortField, idField },
            toolName
        );
    }

    if (secret !== '' && (typeof secret !== 'string' || secret.trim().length === 0)) {
        return errorEnvelope(
            'CURSOR_INVALID_SECRET',
            'Cursor signing secret must be a non-empty, non-whitespace string when provided',
            null,
            toolName
        );
    }

    if (ttlMs !== 0 && (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= 0)) {
        return errorEnvelope(
            'CURSOR_INVALID_OPTIONS',
            'Cursor ttlMs must be 0 or a finite positive number',
            { ttlMs },
            toolName
        );
    }

    if (typeof nowFn !== 'function') {
        return errorEnvelope(
            'CURSOR_INVALID_OPTIONS',
            'Cursor nowFn must be a function',
            null,
            toolName
        );
    }

    const limitResult = resolveEffectivePageLimit(opts, toolName);
    if (!limitResult.ok) {
        return limitResult.envelope;
    }
    const { effectiveLimit } = limitResult;

    const hasMore = rows.length > effectiveLimit;
    const items = hasMore ? rows.slice(0, effectiveLimit) : rows.slice();
    let nextCursor = null;

    if (hasMore && items.length > 0) {
        const lastItem = items[items.length - 1];
        if (
            lastItem === null ||
            typeof lastItem !== 'object' ||
            Array.isArray(lastItem) ||
            !Object.hasOwn(lastItem, idField) ||
            lastItem[idField] === null ||
            lastItem[idField] === undefined
        ) {
            return errorEnvelope(
                'PAGINATION_MISSING_CURSOR_KEYS',
                `Last item on page is missing required non-nullish cursor key "${idField}"`,
                { idField, sortField },
                toolName
            );
        }

        const rawSortValue = Object.hasOwn(lastItem, sortField) ? lastItem[sortField] : null;
        const sortValue = normalizeCursorFieldValue(rawSortValue);
        const idValue = normalizeCursorFieldValue(lastItem[idField]);

        const encoded = encodeCursor(
            {
                sortValue,
                id: idValue,
                sortField,
                idField,
            },
            {
                secret,
                scope,
                ttlMs,
                maxCursorLength,
                nowFn,
                tool: toolName,
            }
        );

        if (!encoded.ok) {
            return encoded;
        }
        nextCursor = encoded.data.cursor;
    }

    return okEnvelope(toolName, 'Page constructed', {
        items,
        pageInfo: {
            limit: effectiveLimit,
            count: items.length,
            hasMore,
            nextCursor,
        },
    });
}

/**
 * Normalize a scalar value into a total-order comparable `(rank, val)` descriptor so
 * cross-type comparisons remain strictly transitive and 100% locale-independent.
 *
 * @param {unknown} raw - Field value
 * @returns {{ rank: number, val: boolean | number | string | null }}
 */
function normalizeComparableScalar(raw) {
    if (raw === null || raw === undefined) {
        return { rank: 0, val: null };
    }
    if (typeof raw === 'boolean') {
        return { rank: 1, val: raw ? 1 : 0 };
    }
    if (typeof raw === 'number') {
        if (Number.isNaN(raw)) {
            return { rank: 0, val: null };
        }
        return { rank: 2, val: Object.is(raw, -0) ? 0 : raw };
    }
    if (raw instanceof Date) {
        if (Number.isNaN(raw.getTime())) {
            return { rank: 0, val: null };
        }
        return { rank: 3, val: raw.toISOString() };
    }
    if (typeof raw === 'string') {
        return { rank: 3, val: raw };
    }
    return { rank: 4, val: String(raw) };
}

/**
 * Locale-independent strict-weak-order scalar comparator using UTF-16 codepoint order
 * for strings (`a < b ? -1 : a > b ? 1 : 0`).
 *
 * @param {unknown} rawA - Left scalar
 * @param {unknown} rawB - Right scalar
 * @returns {-1 | 0 | 1}
 */
function compareScalar(rawA, rawB) {
    const a = normalizeComparableScalar(rawA);
    const b = normalizeComparableScalar(rawB);
    if (a.rank !== b.rank) {
        return a.rank < b.rank ? -1 : 1;
    }
    if (a.rank === 0) {
        return 0;
    }
    if (a.val < b.val) return -1;
    if (a.val > b.val) return 1;
    return 0;
}

/**
 * Compare two `(sortValue, idValue)` pairs in ascending canonical order.
 *
 * @param {unknown} sortA - Left primary sort value
 * @param {unknown} idA - Left tie-breaker ID value
 * @param {unknown} sortB - Right primary sort value
 * @param {unknown} idB - Right tie-breaker ID value
 * @returns {-1 | 0 | 1}
 */
function compareKeysetPair(sortA, idA, sortB, idB) {
    const primary = compareScalar(sortA, sortB);
    if (primary !== 0) return primary;
    return compareScalar(idA, idB);
}

/**
 * Read an own property from a record safely without inheriting from `Object.prototype`.
 *
 * @param {Record<string, unknown>} item - Row object
 * @param {string} field - Own property name
 * @returns {unknown}
 */
function readOwnField(item, field) {
    return Object.hasOwn(item, field) ? item[field] : null;
}

/**
 * Deterministically sort and paginate an in-memory collection using keyset `(sortField, idField)`
 * seek semantics in `'asc'` or `'desc'` order without mutating `allItems`.
 *
 * @param {ReadonlyArray<Record<string, unknown>>} allItems - Full in-memory collection
 * @param {object} [options={}] - Keyset slice options
 * @param {string | null} [options.cursor=''] - Optional continuation cursor from a prior page
 * @param {unknown} [options.limit=25] - Requested page size
 * @param {number} [options.defaultLimit=25] - Fallback limit when `limit` is missing/invalid
 * @param {number} [options.maxLimit=100] - Maximum permitted page size
 * @param {string} [options.sortField='id'] - Primary sort property name
 * @param {string} [options.idField='id'] - Unique tie-breaker property name
 * @param {'asc' | 'desc' | string} [options.direction='asc'] - Sort direction (`'asc'` or `'desc'`)
 * @param {string} [options.secret=''] - Optional HMAC-SHA256 cursor signing secret
 * @param {boolean} [options.requireSignature] - Optional override requiring cursor signature
 * @param {string} [options.scope=''] - Optional cursor scope binding
 * @param {number} [options.ttlMs=0] - Optional cursor TTL in milliseconds
 * @param {number} [options.maxCursorLength=2048] - Maximum allowed cursor length
 * @param {() => number} [options.nowFn=Date.now] - Deterministic clock function
 * @param {string} [options.tool='pagination.slice'] - Originating tool identifier
 * @returns {{ ok: true, tool: string, summary: string, data: { items: Array<Record<string, unknown>>, pageInfo: { limit: number, count: number, hasMore: boolean, nextCursor: string | null } } } | { ok: false, tool: string, summary: string, error: { code: string, message: string, details?: unknown } }}
 */
export function paginateItems(allItems, options = {}) {
    if (options !== null && options !== undefined && (typeof options !== 'object' || Array.isArray(options))) {
        return errorEnvelope(
            'PAGINATION_INVALID_OPTIONS',
            'Pagination options must be a plain object',
            null,
            'pagination.slice'
        );
    }

    const opts = options ?? {};
    const toolName = resolveToolName(opts.tool, 'pagination.slice');

    if (!Array.isArray(allItems)) {
        return errorEnvelope(
            'PAGINATION_INVALID_ROWS',
            'Pagination allItems must be an array',
            null,
            toolName
        );
    }

    for (let i = 0; i < allItems.length; i += 1) {
        const entry = allItems[i];
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
            return errorEnvelope(
                'PAGINATION_INVALID_ROWS',
                `Item at index ${i} must be a non-null object`,
                { index: i },
                toolName
            );
        }
    }

    const rawDirection = opts.direction === undefined ? 'asc' : opts.direction;
    if (typeof rawDirection !== 'string') {
        return errorEnvelope(
            'PAGINATION_INVALID_DIRECTION',
            'Pagination direction must be "asc" or "desc"',
            { direction: rawDirection },
            toolName
        );
    }
    const normalizedDirection = rawDirection.trim().toLowerCase();
    if (normalizedDirection !== 'asc' && normalizedDirection !== 'desc') {
        return errorEnvelope(
            'PAGINATION_INVALID_DIRECTION',
            `Invalid pagination direction "${rawDirection}"; expected "asc" or "desc"`,
            { direction: rawDirection },
            toolName
        );
    }

    const sortField = opts.sortField === undefined ? 'id' : opts.sortField;
    const idField = opts.idField === undefined ? 'id' : opts.idField;
    const secret = opts.secret === undefined ? '' : opts.secret;
    const scope = opts.scope === undefined || opts.scope === null ? '' : opts.scope;
    const ttlMs = opts.ttlMs === undefined ? 0 : opts.ttlMs;
    const maxCursorLength =
        opts.maxCursorLength === undefined
            ? DEFAULT_PAGINATION_LIMITS.maxCursorLength
            : opts.maxCursorLength;
    const nowFn = opts.nowFn === undefined ? Date.now : opts.nowFn;

    if (
        typeof sortField !== 'string' ||
        sortField.trim().length === 0 ||
        FORBIDDEN_OBJECT_KEYS.has(sortField) ||
        typeof idField !== 'string' ||
        idField.trim().length === 0 ||
        FORBIDDEN_OBJECT_KEYS.has(idField)
    ) {
        return errorEnvelope(
            'PAGINATION_INVALID_OPTIONS',
            'sortField and idField must be non-empty safe property names',
            { sortField, idField },
            toolName
        );
    }

    const limitResult = resolveEffectivePageLimit(opts, toolName);
    if (!limitResult.ok) {
        return limitResult.envelope;
    }
    const { effectiveLimit } = limitResult;

    const rawCursor = opts.cursor;
    let decodedPayload = null;
    if (rawCursor !== undefined && rawCursor !== null && rawCursor !== '') {
        const decoded = decodeCursor(rawCursor, {
            secret,
            requireSignature:
                opts.requireSignature === undefined ? Boolean(secret) : Boolean(opts.requireSignature),
            expectedScope: scope,
            maxCursorLength,
            nowFn,
            tool: toolName,
        });
        if (!decoded.ok) {
            return decoded;
        }
        const { payload } = decoded.data;
        if (payload.sortField !== sortField || payload.idField !== idField) {
            return errorEnvelope(
                'CURSOR_SORT_MISMATCH',
                `Cursor sort configuration (${String(payload.sortField ?? '')}, ${String(payload.idField ?? '')}) does not match requested (${sortField}, ${idField})`,
                {
                    expectedSortField: sortField,
                    expectedIdField: idField,
                    cursorSortField: payload.sortField ?? null,
                    cursorIdField: payload.idField ?? null,
                },
                toolName
            );
        }
        if (
            !Object.hasOwn(payload, 'sortValue') ||
            !Object.hasOwn(payload, 'id') ||
            payload.id === null ||
            payload.id === undefined
        ) {
            return errorEnvelope(
                'CURSOR_MALFORMED',
                'Decoded keyset cursor payload is missing required "sortValue" or non-nullish "id" value',
                null,
                toolName
            );
        }
        decodedPayload = payload;
    }

    const sorted = allItems.slice().sort((a, b) => {
        const cmp = compareKeysetPair(
            readOwnField(a, sortField),
            readOwnField(a, idField),
            readOwnField(b, sortField),
            readOwnField(b, idField)
        );
        return normalizedDirection === 'asc' ? cmp : cmp === 0 ? 0 : -cmp;
    });

    let candidateRows;
    if (decodedPayload !== null) {
        const cursorSortVal = Object.hasOwn(decodedPayload, 'sortValue')
            ? decodedPayload.sortValue
            : null;
        const cursorIdVal = decodedPayload.id;
        candidateRows = [];
        for (let i = 0; i < sorted.length; i += 1) {
            const item = sorted[i];
            const cmp = compareKeysetPair(
                readOwnField(item, sortField),
                readOwnField(item, idField),
                cursorSortVal,
                cursorIdVal
            );
            const isStrictlyAfter = normalizedDirection === 'asc' ? cmp > 0 : cmp < 0;
            if (isStrictlyAfter) {
                candidateRows.push(item);
                if (candidateRows.length >= effectiveLimit + 1) {
                    break;
                }
            }
        }
    } else {
        candidateRows = sorted.slice(0, effectiveLimit + 1);
    }

    return buildKeysetPage(candidateRows, {
        limit: effectiveLimit,
        defaultLimit: effectiveLimit,
        maxLimit: Math.max(effectiveLimit, opts.maxLimit ?? DEFAULT_PAGINATION_LIMITS.maxLimit),
        sortField,
        idField,
        secret,
        scope,
        ttlMs,
        maxCursorLength,
        nowFn,
        tool: toolName,
    });
}
