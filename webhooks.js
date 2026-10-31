/**
 * @module webhooks
 * @description Constant-time cryptographic webhook HMAC-SHA256 (`Slack`, `GitHub`, `Stripe`)
 * and `Bearer` token verification bricks (`INV-LEGO-09`) emitting deterministic
 * `INV-LEGO-01` envelopes without throwing on untrusted request headers.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { okEnvelope, errorEnvelope } from './http.js';

const SLACK_TOOL = 'webhooks.slack';
const GITHUB_TOOL = 'webhooks.github';
const STRIPE_TOOL = 'webhooks.stripe';
const BEARER_TOOL = 'webhooks.bearer';

const MAX_HEADER_LENGTH = 4096;
const MAX_STRIPE_V1_CANDIDATES = 16;
const TIMESTAMP_PATTERN = /^\d{1,12}$/;
const SLACK_SIG_PATTERN = /^v0=([0-9a-f]{64})$/i;
const GITHUB_SIG_PATTERN = /^sha256=([0-9a-f]{64})$/i;
const HEX_SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const BEARER_HEADER_PATTERN = /^Bearer\s+(\S+)$/i;

/**
 * Convert a `string`, `Buffer`, or `Uint8Array` into a Node `Buffer` without copying `Buffer` inputs.
 * Returns `null` for objects, arrays, primitives, `null`, or `undefined`.
 *
 * @param {unknown} value - Candidate byte payload
 * @returns {Buffer|null}
 */
function toRawBytes(value) {
    if (typeof value === 'string') {
        return Buffer.from(value, 'utf8');
    }
    if (Buffer.isBuffer(value)) {
        return value;
    }
    if (value instanceof Uint8Array || Object.prototype.toString.call(value) === '[object Uint8Array]') {
        return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    }
    return null;
}

/**
 * Validate a decimal Unix timestamp string/integer and enforce replay tolerance bounds.
 *
 * @param {unknown} timestampHeader - Raw timestamp header value
 * @param {number} nowSeconds - Current Unix epoch seconds
 * @param {number} toleranceSeconds - Maximum allowed clock skew / replay age in seconds
 * @returns {number|null} Parsed integer timestamp or `null` if invalid/expired
 */
function parseValidTimestamp(timestampHeader, nowSeconds, toleranceSeconds) {
    const rawTs =
        typeof timestampHeader === 'number' && Number.isInteger(timestampHeader)
            ? String(timestampHeader)
            : timestampHeader;
    if (typeof rawTs !== 'string' || !TIMESTAMP_PATTERN.test(rawTs)) {
        return null;
    }
    const ts = Number.parseInt(rawTs, 10);
    if (
        !Number.isFinite(ts) ||
        !Number.isFinite(nowSeconds) ||
        !Number.isFinite(toleranceSeconds) ||
        toleranceSeconds < 0 ||
        Math.abs(nowSeconds - ts) > toleranceSeconds
    ) {
        return null;
    }
    return ts;
}

/**
 * Parse a `Stripe-Signature` header into a single timestamp string and up to 16 `v1` digest buffers.
 *
 * @param {string} signatureHeader - Raw `Stripe-Signature` header
 * @returns {{ timestampRaw: string, candidates: Buffer[] } | null}
 */
function parseStripeSignatureHeader(signatureHeader) {
    if (
        typeof signatureHeader !== 'string' ||
        signatureHeader.length === 0 ||
        signatureHeader.length > MAX_HEADER_LENGTH ||
        /[\r\n]/.test(signatureHeader)
    ) {
        return null;
    }

    let timestampRaw = null;
    const candidates = [];
    for (const segment of signatureHeader.split(',')) {
        const part = segment.trim();
        const eqIdx = part.indexOf('=');
        if (eqIdx <= 0) return null;

        const key = part.slice(0, eqIdx);
        const value = part.slice(eqIdx + 1);
        if (key === 't') {
            if (timestampRaw !== null || !TIMESTAMP_PATTERN.test(value)) return null;
            timestampRaw = value;
        } else if (key === 'v1') {
            if (!HEX_SHA256_PATTERN.test(value)) return null;
            if (candidates.length < MAX_STRIPE_V1_CANDIDATES) {
                candidates.push(Buffer.from(value.toLowerCase(), 'hex'));
            }
        }
    }

    if (timestampRaw === null || candidates.length === 0) return null;
    return { timestampRaw, candidates };
}

/**
 * Compare two `string | Buffer | Uint8Array` values in constant time.
 * Guards `crypto.timingSafeEqual` against empty buffers, unequal byte lengths, and non-byte inputs.
 *
 * @param {string|Buffer|Uint8Array} a - First candidate value
 * @param {string|Buffer|Uint8Array} b - Second candidate value
 * @returns {boolean}
 */
export function constantTimeEqual(a, b) {
    try {
        const bufA = toRawBytes(a);
        const bufB = toRawBytes(b);
        if (!bufA || !bufB) return false;
        if (bufA.length === 0 || bufA.length !== bufB.length) return false;
        return timingSafeEqual(bufA, bufB);
    } catch {
        return false;
    }
}

/**
 * Compute a hex-encoded HMAC signature over a raw request body with an optional scheme prefix.
 * Throws if `secret` is blank or if `rawBody` is a parsed JSON object instead of raw bytes/string.
 *
 * @param {string|Buffer|Uint8Array} rawBody - Raw unparsed payload (`''` allowed)
 * @param {string} secret - Non-empty HMAC signing secret
 * @param {object} [options={}] - Signing options
 * @param {string} [options.algorithm='sha256'] - OpenSSL digest algorithm
 * @param {string} [options.prefix=''] - Optional header prefix (e.g. `'sha256='` or `'v0='`)
 * @returns {string}
 */
export function signWebhookHmac(rawBody, secret, options = {}) {
    if (typeof secret !== 'string' || secret.trim().length === 0) {
        throw new Error('Webhook signing secret must be a non-empty string');
    }
    const bodyBuf = toRawBytes(rawBody);
    if (!bodyBuf) {
        throw new TypeError('Webhook rawBody must be a string, Buffer, or Uint8Array');
    }
    const { algorithm = 'sha256', prefix = '' } = options && typeof options === 'object' ? options : {};
    if (typeof algorithm !== 'string' || algorithm.trim().length === 0) {
        throw new TypeError('HMAC algorithm must be a non-empty string');
    }
    const safePrefix = typeof prefix === 'string' ? prefix : String(prefix ?? '');
    return `${safePrefix}${createHmac(algorithm, secret).update(bodyBuf).digest('hex')}`;
}

/**
 * Verify a Slack `X-Slack-Signature` (`v0=<hex>`) and `X-Slack-Request-Timestamp` header pair.
 * Never throws on untrusted inputs; always returns an `INV-LEGO-01` envelope.
 *
 * @param {object} [options={}] - Verification parameters
 * @param {string|Buffer|Uint8Array} options.rawBody - Raw unparsed request body
 * @param {string|number} options.timestampHeader - `X-Slack-Request-Timestamp` header
 * @param {string} options.signatureHeader - `X-Slack-Signature` header (`v0=...`)
 * @param {string} options.signingSecret - Configured Slack signing secret
 * @param {number} [options.toleranceSeconds=300] - Replay tolerance window in seconds
 * @param {number} [options.nowSeconds] - Current epoch seconds override for deterministic testing
 * @returns {{ ok: boolean, tool: string, summary: string, data?: object, error?: object }}
 */
export function verifySlackSignature(options = {}) {
    try {
        const {
            rawBody,
            timestampHeader,
            signatureHeader,
            signingSecret,
            toleranceSeconds = 300,
            nowSeconds = Math.floor(Date.now() / 1000),
        } = options && typeof options === 'object' ? options : {};

        if (typeof signingSecret !== 'string' || signingSecret.trim().length === 0) {
            return errorEnvelope('SLACK_MISSING_SECRET', 'Slack signing secret is not configured', null, SLACK_TOOL);
        }
        const rawBodyBuffer = toRawBytes(rawBody);
        if (!rawBodyBuffer) {
            return errorEnvelope('SLACK_INVALID_BODY', 'Raw request body string or Buffer is required', null, SLACK_TOOL);
        }
        const ts = parseValidTimestamp(timestampHeader, nowSeconds, toleranceSeconds);
        if (ts === null) {
            return errorEnvelope(
                'SLACK_REPLAY_EXPIRED',
                'Slack request timestamp is missing or outside replay tolerance window',
                null,
                SLACK_TOOL
            );
        }
        const sigMatch = typeof signatureHeader === 'string' ? SLACK_SIG_PATTERN.exec(signatureHeader) : null;
        if (!sigMatch) {
            return errorEnvelope('SLACK_INVALID_SIGNATURE', 'Malformed Slack signature header', null, SLACK_TOOL);
        }

        const receivedDigest = Buffer.from(sigMatch[1].toLowerCase(), 'hex');
        const basePayload = Buffer.concat([Buffer.from(`v0:${ts}:`, 'utf8'), rawBodyBuffer]);
        const expectedDigest = createHmac('sha256', signingSecret).update(basePayload).digest();
        if (receivedDigest.length !== expectedDigest.length || !timingSafeEqual(receivedDigest, expectedDigest)) {
            return errorEnvelope('SLACK_INVALID_SIGNATURE', 'Slack HMAC signature verification failed', null, SLACK_TOOL);
        }
        return okEnvelope(SLACK_TOOL, 'Slack webhook signature verified', {
            verified: true,
            provider: 'slack',
            timestamp: ts,
        });
    } catch {
        return errorEnvelope('SLACK_INVALID_SIGNATURE', 'Slack HMAC signature verification failed', null, SLACK_TOOL);
    }
}

/**
 * Verify a GitHub `X-Hub-Signature-256` (`sha256=<hex>`) webhook header in constant time.
 * Never throws on untrusted inputs; always returns an `INV-LEGO-01` envelope.
 *
 * @param {object} [options={}] - Verification parameters
 * @param {string|Buffer|Uint8Array} options.rawBody - Raw unparsed request body
 * @param {string} options.signatureHeader - `X-Hub-Signature-256` header (`sha256=...`)
 * @param {string} options.webhookSecret - Configured GitHub webhook secret
 * @returns {{ ok: boolean, tool: string, summary: string, data?: object, error?: object }}
 */
export function verifyGithubSignature(options = {}) {
    try {
        const { rawBody, signatureHeader, webhookSecret } =
            options && typeof options === 'object' ? options : {};

        if (typeof webhookSecret !== 'string' || webhookSecret.trim().length === 0) {
            return errorEnvelope('GITHUB_MISSING_SECRET', 'GitHub webhook secret is not configured', null, GITHUB_TOOL);
        }
        const rawBodyBuffer = toRawBytes(rawBody);
        if (!rawBodyBuffer) {
            return errorEnvelope('GITHUB_INVALID_BODY', 'Raw request body string or Buffer is required', null, GITHUB_TOOL);
        }
        const sigMatch = typeof signatureHeader === 'string' ? GITHUB_SIG_PATTERN.exec(signatureHeader) : null;
        if (!sigMatch) {
            return errorEnvelope('GITHUB_INVALID_SIGNATURE', 'Malformed GitHub signature header', null, GITHUB_TOOL);
        }

        const receivedDigest = Buffer.from(sigMatch[1].toLowerCase(), 'hex');
        const expectedDigest = createHmac('sha256', webhookSecret).update(rawBodyBuffer).digest();
        if (receivedDigest.length !== expectedDigest.length || !timingSafeEqual(receivedDigest, expectedDigest)) {
            return errorEnvelope('GITHUB_INVALID_SIGNATURE', 'GitHub HMAC signature verification failed', null, GITHUB_TOOL);
        }
        return okEnvelope(GITHUB_TOOL, 'GitHub webhook signature verified', {
            verified: true,
            provider: 'github',
        });
    } catch {
        return errorEnvelope('GITHUB_INVALID_SIGNATURE', 'GitHub HMAC signature verification failed', null, GITHUB_TOOL);
    }
}

/**
 * Verify a Stripe `Stripe-Signature` (`t=<ts>,v1=<hex>[,v1=<hex>]`) header with replay protection
 * and non-short-circuiting multi-`v1` secret-rotation evaluation (capped at 16 candidates).
 *
 * @param {object} [options={}] - Verification parameters
 * @param {string|Buffer|Uint8Array} options.rawBody - Raw unparsed request body
 * @param {string} options.signatureHeader - `Stripe-Signature` header
 * @param {string} options.endpointSecret - Configured Stripe endpoint signing secret (`whsec_...`)
 * @param {number} [options.toleranceSeconds=300] - Replay tolerance window in seconds
 * @param {number} [options.nowSeconds] - Current epoch seconds override for deterministic testing
 * @returns {{ ok: boolean, tool: string, summary: string, data?: object, error?: object }}
 */
export function verifyStripeSignature(options = {}) {
    try {
        const {
            rawBody,
            signatureHeader,
            endpointSecret,
            toleranceSeconds = 300,
            nowSeconds = Math.floor(Date.now() / 1000),
        } = options && typeof options === 'object' ? options : {};

        if (typeof endpointSecret !== 'string' || endpointSecret.trim().length === 0) {
            return errorEnvelope('STRIPE_MISSING_SECRET', 'Stripe endpoint secret is not configured', null, STRIPE_TOOL);
        }
        const rawBodyBuffer = toRawBytes(rawBody);
        if (!rawBodyBuffer) {
            return errorEnvelope('STRIPE_INVALID_BODY', 'Raw request body string or Buffer is required', null, STRIPE_TOOL);
        }
        const parsed = parseStripeSignatureHeader(signatureHeader);
        if (!parsed) {
            return errorEnvelope('STRIPE_INVALID_SIGNATURE', 'Malformed Stripe signature header', null, STRIPE_TOOL);
        }
        const ts = parseValidTimestamp(parsed.timestampRaw, nowSeconds, toleranceSeconds);
        if (ts === null) {
            return errorEnvelope(
                'STRIPE_REPLAY_EXPIRED',
                'Stripe webhook timestamp is outside replay tolerance window',
                null,
                STRIPE_TOOL
            );
        }

        const signedPayload = Buffer.concat([Buffer.from(`${ts}.`, 'utf8'), rawBodyBuffer]);
        const expectedDigest = createHmac('sha256', endpointSecret).update(signedPayload).digest();
        let matched = false;
        for (const candidateDigest of parsed.candidates) {
            if (candidateDigest.length === expectedDigest.length && timingSafeEqual(candidateDigest, expectedDigest)) {
                matched = true;
            }
        }
        if (!matched) {
            return errorEnvelope('STRIPE_INVALID_SIGNATURE', 'Stripe HMAC signature verification failed', null, STRIPE_TOOL);
        }
        return okEnvelope(STRIPE_TOOL, 'Stripe webhook signature verified', {
            verified: true,
            provider: 'stripe',
            timestamp: ts,
        });
    } catch {
        return errorEnvelope('STRIPE_INVALID_SIGNATURE', 'Stripe HMAC signature verification failed', null, STRIPE_TOOL);
    }
}

/**
 * Verify an HTTP `Authorization: Bearer <token>` header in constant time.
 * Hashes both candidate token and expected secret with SHA-256 prior to `timingSafeEqual`
 * so secret byte length is never leaked via timing side-channels.
 *
 * @param {string} authHeader - Raw `Authorization` request header
 * @param {string} expectedSecret - Expected bearer token secret
 * @param {object} [options={}] - Verification options
 * @param {string} [options.tool='webhooks.bearer'] - Tool identifier for returned envelopes
 * @returns {{ ok: boolean, tool: string, summary: string, data?: object, error?: object }}
 */
export function verifyBearerToken(authHeader, expectedSecret, options = {}) {
    const rawTool = options && typeof options === 'object' ? options.tool : undefined;
    const safeTool = typeof rawTool === 'string' && rawTool.trim().length > 0 ? rawTool : BEARER_TOOL;

    try {
        if (typeof expectedSecret !== 'string' || expectedSecret.trim().length === 0) {
            return errorEnvelope('AUTH_MISSING_SECRET', 'Bearer authentication secret is not configured', null, safeTool);
        }
        if (
            typeof authHeader !== 'string' ||
            authHeader.length === 0 ||
            authHeader.length > MAX_HEADER_LENGTH ||
            /[\r\n]/.test(authHeader)
        ) {
            return errorEnvelope('AUTH_INVALID_HEADER', 'Malformed Authorization Bearer header', null, safeTool);
        }
        const match = BEARER_HEADER_PATTERN.exec(authHeader);
        if (!match) {
            return errorEnvelope('AUTH_INVALID_HEADER', 'Malformed Authorization Bearer header', null, safeTool);
        }

        const tokenDigest = createHash('sha256').update(Buffer.from(match[1], 'utf8')).digest();
        const expectedDigest = createHash('sha256').update(Buffer.from(expectedSecret, 'utf8')).digest();
        if (tokenDigest.length !== expectedDigest.length || !timingSafeEqual(tokenDigest, expectedDigest)) {
            return errorEnvelope('AUTH_UNAUTHORIZED', 'Invalid bearer token', null, safeTool);
        }
        return okEnvelope(safeTool, 'Bearer token verified', {
            verified: true,
            provider: 'bearer',
        });
    } catch {
        return errorEnvelope('AUTH_INVALID_HEADER', 'Malformed Authorization Bearer header', null, safeTool);
    }
}
