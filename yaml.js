/**
 * @module yaml
 * @description Cross-runtime safe YAML 1.2 Core configuration & authority-pack loader
 * (`INV-LEGO-01`, `INV-LEGO-23`). Zero external dependencies and zero host-specific imports;
 * runs unmodified in modern server runtimes, Cloudflare Workers, and browsers.
 *
 * Security invariants enforced:
 * 1. Pre-parse UTF-8 byte ceiling (`YAML_TOO_LARGE`) & strict fatal UTF-8 / control-char checks.
 * 2. Zero arbitrary tag execution (`!tag`, `!!python/...`, `!!js/...`, `%TAG` -> `YAML_FORBIDDEN_TAG`).
 * 3. YAML 1.2 Core types only (`NO`/`yes`/`on`/`off` stay strings; ISO dates stay strings;
 *    `.nan`/`.inf` & unsafe integer overflows fail closed with `YAML_NONFINITE_NUMBER`).
 * 4. Prototype pollution (`__proto__`, `constructor`, `prototype` -> `YAML_FORBIDDEN_KEY`),
 *    non-string mapping keys (`YAML_INVALID_KEY`), and duplicate keys (`YAML_DUPLICATE_KEY`).
 * 5. Bounded deep-cloned anchors, aliases, and `<<` merge keys (`YAML_ALIAS_BOMB`,
 *    `YAML_UNKNOWN_ALIAS`, `YAML_MAX_DEPTH`, `YAML_MAX_NODES`).
 */

import { validateSchema } from './schema.js';

/**
 * Default resource ceilings for safe YAML parsing and alias expansion (`INV-LEGO-23`).
 */
export const DEFAULT_YAML_LIMITS = Object.freeze({
    maxBytes: 1_048_576,
    maxDepth: 32,
    maxNodes: 10_000,
    maxAliases: 64,
    maxAliasExpansionNodes: 1_000,
});

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const TEXT_ENCODER = new TextEncoder();
const FATAL_UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

const hasOwn =
    typeof Object.hasOwn === 'function'
        ? Object.hasOwn
        : (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

// ============================================================================
// Pure-JS Synchronous FIPS 180-4 SHA-256
// ============================================================================

const SHA256_INIT = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const SHA256_K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/**
 * Compute a lowercase 64-character hexadecimal FIPS 180-4 SHA-256 digest over raw bytes.
 *
 * @param {Uint8Array} bytes - Raw input byte array
 * @returns {string}
 */
function sha256HexBytes(bytes) {
    const byteLen = bytes.byteLength;
    const rem = (byteLen + 9) % 64;
    const paddedLen = rem === 0 ? byteLen + 9 : byteLen + 9 + (64 - rem);
    const padded = new Uint8Array(paddedLen);
    padded.set(bytes, 0);
    padded[byteLen] = 0x80;

    const view = new DataView(padded.buffer, padded.byteOffset, padded.byteLength);
    const bitLenHi = Math.floor(byteLen / 0x20000000);
    const bitLenLo = (byteLen * 8) >>> 0;
    view.setUint32(paddedLen - 8, bitLenHi, false);
    view.setUint32(paddedLen - 4, bitLenLo, false);

    let h0 = SHA256_INIT[0];
    let h1 = SHA256_INIT[1];
    let h2 = SHA256_INIT[2];
    let h3 = SHA256_INIT[3];
    let h4 = SHA256_INIT[4];
    let h5 = SHA256_INIT[5];
    let h6 = SHA256_INIT[6];
    let h7 = SHA256_INIT[7];
    const schedule = new Uint32Array(64);

    for (let offset = 0; offset < paddedLen; offset += 64) {
        for (let i = 0; i < 16; i += 1) {
            schedule[i] = view.getUint32(offset + i * 4, false);
        }
        for (let i = 16; i < 64; i += 1) {
            const w15 = schedule[i - 15];
            const w2 = schedule[i - 2];
            const s0 = (((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3)) >>> 0;
            const s1 = (((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10)) >>> 0;
            schedule[i] = (schedule[i - 16] + s0 + schedule[i - 7] + s1) >>> 0;
        }

        let a = h0;
        let b = h1;
        let c = h2;
        let d = h3;
        let e = h4;
        let f = h5;
        let g = h6;
        let h = h7;

        for (let i = 0; i < 64; i += 1) {
            const sum1 = (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) >>> 0;
            const ch = ((e & f) ^ (~e & g)) >>> 0;
            const temp1 = (h + sum1 + ch + SHA256_K[i] + schedule[i]) >>> 0;
            const sum0 = (((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) >>> 0;
            const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
            const temp2 = (sum0 + maj) >>> 0;

            h = g;
            g = f;
            f = e;
            e = (d + temp1) >>> 0;
            d = c;
            c = b;
            b = a;
            a = (temp1 + temp2) >>> 0;
        }

        h0 = (h0 + a) >>> 0;
        h1 = (h1 + b) >>> 0;
        h2 = (h2 + c) >>> 0;
        h3 = (h3 + d) >>> 0;
        h4 = (h4 + e) >>> 0;
        h5 = (h5 + f) >>> 0;
        h6 = (h6 + g) >>> 0;
        h7 = (h7 + h) >>> 0;
    }

    return (
        h0.toString(16).padStart(8, '0') +
        h1.toString(16).padStart(8, '0') +
        h2.toString(16).padStart(8, '0') +
        h3.toString(16).padStart(8, '0') +
        h4.toString(16).padStart(8, '0') +
        h5.toString(16).padStart(8, '0') +
        h6.toString(16).padStart(8, '0') +
        h7.toString(16).padStart(8, '0')
    );
}

// ============================================================================
// Envelope & Object Safety Helpers
// ============================================================================

/**
 * Internal structured parser/serializer signal converted into `INV-LEGO-01` error envelopes.
 */
class YamlSignalError extends Error {
    /**
     * @param {string} code - Machine-readable error code
     * @param {string} message - Human-readable diagnostic
     * @param {Record<string, unknown>|null} [details=null] - Structured metadata
     */
    constructor(code, message, details = null) {
        super(message);
        this.name = 'YamlSignalError';
        this.code = code;
        this.details = details;
    }
}

/**
 * Build a deterministic `INV-LEGO-01` success envelope.
 *
 * @param {string} tool - Originating tool identifier
 * @param {string} summary - Human-readable summary
 * @param {unknown} data - Structured result payload
 * @returns {{ ok: true, tool: string, summary: string, data: any }}
 */
function yamlOkEnvelope(tool, summary, data) {
    return {
        ok: true,
        tool: String(tool || 'yaml.parse'),
        summary: String(summary || 'YAML operation succeeded'),
        data,
    };
}

/**
 * Build a deterministic `INV-LEGO-01` error envelope.
 *
 * @param {string} code - Machine-readable error code
 * @param {string} message - Human-readable error message
 * @param {unknown} [details=null] - Optional diagnostic metadata
 * @param {string} [tool='yaml.parse'] - Originating tool identifier
 * @returns {{ ok: false, tool: string, summary: string, error: { code: string, message: string, details?: any } }}
 */
function yamlErrorEnvelope(code, message, details = null, tool = 'yaml.parse') {
    return {
        ok: false,
        tool: String(tool || 'yaml.parse'),
        summary: String(message || code || 'YAML operation failed'),
        error: {
            code: String(code || 'YAML_PARSE_ERROR'),
            message: String(message || 'YAML operation failed'),
            ...(details !== null && details !== undefined ? { details } : {}),
        },
    };
}

/**
 * Check whether a value is a plain JSON-style object (`Object.prototype` or `null` prototype).
 *
 * @param {unknown} val - Candidate value
 * @returns {boolean}
 */
function isPlainObject(val) {
    if (val === null || typeof val !== 'object') {
        return false;
    }
    try {
        if (Array.isArray(val)) {
            return false;
        }
        const proto = Object.getPrototypeOf(val);
        return proto === null || proto === Object.prototype;
    } catch {
        return false;
    }
}

/**
 * Define an enumerable property without triggering prototype setters.
 *
 * @param {Record<string, unknown>} target - Destination plain object
 * @param {string} key - Property key
 * @param {unknown} value - Property value
 */
function defineSafeProperty(target, key, value) {
    if (FORBIDDEN_KEYS.has(key)) {
        throw new YamlSignalError('YAML_FORBIDDEN_KEY', `Forbidden YAML mapping key "${key}"`, { key });
    }
    Object.defineProperty(target, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
    });
}

/**
 * Check whether a numeric option is a finite integer `>= min`.
 *
 * @param {unknown} val - Candidate option value
 * @param {number} min - Inclusive lower bound
 * @returns {boolean}
 */
function isBoundedInteger(val, min) {
    return typeof val === 'number' && Number.isInteger(val) && val >= min;
}

/**
 * Extract a safe `tool` label from caller options before full option validation.
 *
 * @param {unknown} options - Caller options
 * @param {string} fallback - Default tool name
 * @returns {string}
 */
function peekToolName(options, fallback) {
    try {
        if (isPlainObject(options) && typeof options.tool === 'string' && options.tool.trim().length > 0) {
            return options.tool;
        }
    } catch {
        return fallback;
    }
    return fallback;
}

/**
 * Validate and normalize `parseSafeYaml` options.
 *
 * @param {unknown} options - Caller options
 * @param {string} defaultTool - Default tool identifier
 * @returns {{ ok: true, config: { maxBytes: number, maxDepth: number, maxNodes: number, maxAliases: number, maxAliasExpansionNodes: number, allowMultipleDocuments: boolean, tool: string } } | { ok: false, envelope: any }}
 */
function normalizeParseOptions(options, defaultTool) {
    const fallbackTool = peekToolName(options, defaultTool);
    try {
        if (options !== undefined && !isPlainObject(options)) {
            return {
                ok: false,
                envelope: yamlErrorEnvelope(
                    'YAML_INVALID_OPTIONS',
                    'YAML options must be a plain object',
                    null,
                    fallbackTool
                ),
            };
        }
        const opts = options || {};
        const rawTool = opts.tool;
        if (rawTool !== undefined && (typeof rawTool !== 'string' || rawTool.trim().length === 0)) {
            return {
                ok: false,
                envelope: yamlErrorEnvelope(
                    'YAML_INVALID_OPTIONS',
                    'Option "tool" must be a non-empty string',
                    null,
                    defaultTool
                ),
            };
        }
        const tool = rawTool || defaultTool;
        const maxBytes = opts.maxBytes !== undefined ? opts.maxBytes : DEFAULT_YAML_LIMITS.maxBytes;
        const maxDepth = opts.maxDepth !== undefined ? opts.maxDepth : DEFAULT_YAML_LIMITS.maxDepth;
        const maxNodes = opts.maxNodes !== undefined ? opts.maxNodes : DEFAULT_YAML_LIMITS.maxNodes;
        const maxAliases = opts.maxAliases !== undefined ? opts.maxAliases : DEFAULT_YAML_LIMITS.maxAliases;
        const maxAliasExpansionNodes =
            opts.maxAliasExpansionNodes !== undefined
                ? opts.maxAliasExpansionNodes
                : DEFAULT_YAML_LIMITS.maxAliasExpansionNodes;
        const allowMultipleDocuments =
            opts.allowMultipleDocuments !== undefined ? opts.allowMultipleDocuments : false;

        if (!isBoundedInteger(maxBytes, 1)) {
            return {
                ok: false,
                envelope: yamlErrorEnvelope(
                    'YAML_INVALID_OPTIONS',
                    'Option "maxBytes" must be a positive integer',
                    { option: 'maxBytes', value: maxBytes },
                    tool
                ),
            };
        }
        if (!isBoundedInteger(maxDepth, 1)) {
            return {
                ok: false,
                envelope: yamlErrorEnvelope(
                    'YAML_INVALID_OPTIONS',
                    'Option "maxDepth" must be a positive integer',
                    { option: 'maxDepth', value: maxDepth },
                    tool
                ),
            };
        }
        if (!isBoundedInteger(maxNodes, 1)) {
            return {
                ok: false,
                envelope: yamlErrorEnvelope(
                    'YAML_INVALID_OPTIONS',
                    'Option "maxNodes" must be a positive integer',
                    { option: 'maxNodes', value: maxNodes },
                    tool
                ),
            };
        }
        if (!isBoundedInteger(maxAliases, 0)) {
            return {
                ok: false,
                envelope: yamlErrorEnvelope(
                    'YAML_INVALID_OPTIONS',
                    'Option "maxAliases" must be a non-negative integer',
                    { option: 'maxAliases', value: maxAliases },
                    tool
                ),
            };
        }
        if (!isBoundedInteger(maxAliasExpansionNodes, 0)) {
            return {
                ok: false,
                envelope: yamlErrorEnvelope(
                    'YAML_INVALID_OPTIONS',
                    'Option "maxAliasExpansionNodes" must be a non-negative integer',
                    { option: 'maxAliasExpansionNodes', value: maxAliasExpansionNodes },
                    tool
                ),
            };
        }
        if (typeof allowMultipleDocuments !== 'boolean') {
            return {
                ok: false,
                envelope: yamlErrorEnvelope(
                    'YAML_INVALID_OPTIONS',
                    'Option "allowMultipleDocuments" must be a boolean',
                    { option: 'allowMultipleDocuments', value: allowMultipleDocuments },
                    tool
                ),
            };
        }

        return {
            ok: true,
            config: {
                maxBytes,
                maxDepth,
                maxNodes,
                maxAliases,
                maxAliasExpansionNodes,
                allowMultipleDocuments,
                tool,
            },
        };
    } catch (err) {
        return {
            ok: false,
            envelope: yamlErrorEnvelope(
                'YAML_INVALID_OPTIONS',
                err instanceof Error ? err.message : 'Invalid YAML options',
                null,
                fallbackTool
            ),
        };
    }
}

/**
 * Normalize `string | Uint8Array | ArrayBuffer` into validated UTF-8 bytes and decoded text.
 *
 * @param {unknown} input - Caller YAML input
 * @param {number} maxBytes - Byte limit ceiling
 * @param {string} tool - Tool identifier
 * @returns {{ ok: true, rawBytes: Uint8Array, text: string } | { ok: false, envelope: any }}
 */
function decodeYamlInput(input, maxBytes, tool) {
    try {
        let objTag = '';
        if (input !== null && typeof input === 'object') {
            objTag = Object.prototype.toString.call(input);
        }
        let rawBytes;
        let text;

        if (typeof input === 'string') {
            for (let i = 0; i < input.length; i += 1) {
                const code = input.charCodeAt(i);
                if (code >= 0xd800 && code <= 0xdbff) {
                    const next = i + 1 < input.length ? input.charCodeAt(i + 1) : 0;
                    if (next >= 0xdc00 && next <= 0xdfff) {
                        i += 1;
                        continue;
                    }
                    return {
                        ok: false,
                        envelope: yamlErrorEnvelope(
                            'YAML_PARSE_ERROR',
                            'YAML string input contains unpaired UTF-16 surrogate',
                            null,
                            tool
                        ),
                    };
                }
                if (code >= 0xdc00 && code <= 0xdfff) {
                    return {
                        ok: false,
                        envelope: yamlErrorEnvelope(
                            'YAML_PARSE_ERROR',
                            'YAML string input contains unpaired UTF-16 surrogate',
                            null,
                            tool
                        ),
                    };
                }
            }
            if (input.length > maxBytes) {
                const measuredBytes =
                    input.length <= 4_194_304 ? TEXT_ENCODER.encode(input).byteLength : input.length;
                return {
                    ok: false,
                    envelope: yamlErrorEnvelope(
                        'YAML_TOO_LARGE',
                        `YAML input exceeds maximum size of ${maxBytes} bytes`,
                        { byteLength: measuredBytes, maxBytes },
                        tool
                    ),
                };
            }
            rawBytes = TEXT_ENCODER.encode(input);
            if (rawBytes.byteLength > maxBytes) {
                return {
                    ok: false,
                    envelope: yamlErrorEnvelope(
                        'YAML_TOO_LARGE',
                        `YAML input exceeds maximum size of ${maxBytes} bytes`,
                        { byteLength: rawBytes.byteLength, maxBytes },
                        tool
                    ),
                };
            }
            text = input;
        } else if (input instanceof Uint8Array || (ArrayBuffer.isView(input) && objTag === '[object Uint8Array]')) {
            if (typeof input.buffer?.detached === 'boolean' && input.buffer.detached) {
                return {
                    ok: false,
                    envelope: yamlErrorEnvelope(
                        'YAML_INVALID_INPUT',
                        'YAML input Uint8Array is backed by a detached ArrayBuffer',
                        null,
                        tool
                    ),
                };
            }
            if (input.byteLength > maxBytes) {
                return {
                    ok: false,
                    envelope: yamlErrorEnvelope(
                        'YAML_TOO_LARGE',
                        `YAML input exceeds maximum size of ${maxBytes} bytes`,
                        { byteLength: input.byteLength, maxBytes },
                        tool
                    ),
                };
            }
            rawBytes = input;
            try {
                text = FATAL_UTF8_DECODER.decode(rawBytes);
            } catch {
                return {
                    ok: false,
                    envelope: yamlErrorEnvelope(
                        'YAML_PARSE_ERROR',
                        'Invalid UTF-8 byte sequence in YAML input',
                        null,
                        tool
                    ),
                };
            }
        } else if (input instanceof ArrayBuffer || objTag === '[object ArrayBuffer]') {
            if (typeof input.detached === 'boolean' && input.detached) {
                return {
                    ok: false,
                    envelope: yamlErrorEnvelope(
                        'YAML_INVALID_INPUT',
                        'YAML input ArrayBuffer is detached',
                        null,
                        tool
                    ),
                };
            }
            if (input.byteLength > maxBytes) {
                return {
                    ok: false,
                    envelope: yamlErrorEnvelope(
                        'YAML_TOO_LARGE',
                        `YAML input exceeds maximum size of ${maxBytes} bytes`,
                        { byteLength: input.byteLength, maxBytes },
                        tool
                    ),
                };
            }
            try {
                rawBytes = new Uint8Array(input);
            } catch {
                return {
                    ok: false,
                    envelope: yamlErrorEnvelope(
                        'YAML_INVALID_INPUT',
                        'YAML input ArrayBuffer is detached or invalid',
                        null,
                        tool
                    ),
                };
            }
            try {
                text = FATAL_UTF8_DECODER.decode(rawBytes);
            } catch {
                return {
                    ok: false,
                    envelope: yamlErrorEnvelope(
                        'YAML_PARSE_ERROR',
                        'Invalid UTF-8 byte sequence in YAML input',
                        null,
                        tool
                    ),
                };
            }
        } else {
            return {
                ok: false,
                envelope: yamlErrorEnvelope(
                    'YAML_INVALID_INPUT',
                    'YAML input must be a string, Uint8Array, or ArrayBuffer',
                    { receivedType: input === null ? 'null' : Array.isArray(input) ? 'array' : typeof input },
                    tool
                ),
            };
        }

        for (let i = 0; i < rawBytes.byteLength; i += 1) {
            if (rawBytes[i] === 0) {
                return {
                    ok: false,
                    envelope: yamlErrorEnvelope(
                        'YAML_PARSE_ERROR',
                        'YAML input contains forbidden NUL byte',
                        { offset: i },
                        tool
                    ),
                };
            }
        }

        if (text.length > 0 && text.charCodeAt(0) === 0xfeff) {
            text = text.slice(1);
        }

        for (let i = 0; i < text.length; i += 1) {
            const code = text.charCodeAt(i);
            if (
                (code >= 0x00 && code <= 0x08) ||
                code === 0x0b ||
                code === 0x0c ||
                (code >= 0x0e && code <= 0x1f) ||
                code === 0x7f
            ) {
                return {
                    ok: false,
                    envelope: yamlErrorEnvelope(
                        'YAML_PARSE_ERROR',
                        `YAML input contains disallowed control character (0x${code.toString(16).padStart(2, '0')})`,
                        { offset: i },
                        tool
                    ),
                };
            }
        }

        const normalizedText = text.indexOf('\r') !== -1 ? text.replace(/\r\n?/g, '\n') : text;
        return { ok: true, rawBytes, text: normalizedText };
    } catch (err) {
        return {
            ok: false,
            envelope: yamlErrorEnvelope(
                'YAML_INVALID_INPUT',
                err instanceof Error ? err.message : 'Invalid YAML input',
                null,
                tool
            ),
        };
    }
}

// ============================================================================
// YAML 1.2 Core Scalar Resolution
// ============================================================================

const BASE10_INT_RE = /^[+-]?[0-9]+$/;
const HEX_INT_RE = /^[+-]?0x[0-9a-fA-F]+$/;
const OCT_INT_RE = /^[+-]?0o[0-7]+$/;
const FLOAT_RE = /^[+-]?(?:(?:[0-9]+\.[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?|[0-9]+[eE][+-]?[0-9]+)$/;
const NONFINITE_RE = /^[+-]?\.(?:inf|nan)$/i;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);

/**
 * Parse a BigInt literal with explicit sign support (`+0x10`, `-0o77`, `123`).
 *
 * @param {string} raw - Validated integer string
 * @returns {bigint}
 */
function parseSignedBigInt(raw) {
    if (raw.startsWith('+')) {
        return BigInt(raw.slice(1));
    }
    if (raw.startsWith('-0x') || raw.startsWith('-0X') || raw.startsWith('-0o') || raw.startsWith('-0O')) {
        return -BigInt(raw.slice(1));
    }
    return BigInt(raw);
}

/**
 * Resolve an unquoted YAML 1.2 Core Schema plain scalar.
 *
 * @param {string} raw - Trimmed plain scalar token
 * @returns {string | number | boolean | null}
 */
function resolvePlainScalar(raw) {
    if (raw === '' || raw === '~' || raw === 'null' || raw === 'Null' || raw === 'NULL') {
        return null;
    }
    if (raw === 'true' || raw === 'True' || raw === 'TRUE') {
        return true;
    }
    if (raw === 'false' || raw === 'False' || raw === 'FALSE') {
        return false;
    }
    if (NONFINITE_RE.test(raw)) {
        throw new YamlSignalError(
            'YAML_NONFINITE_NUMBER',
            `Non-finite YAML number "${raw}" is forbidden in JSON-safe mode`,
            { token: raw }
        );
    }
    if (BASE10_INT_RE.test(raw) || HEX_INT_RE.test(raw) || OCT_INT_RE.test(raw)) {
        const big = parseSignedBigInt(raw);
        if (big > MAX_SAFE_BIGINT || big < MIN_SAFE_BIGINT) {
            throw new YamlSignalError(
                'YAML_NONFINITE_NUMBER',
                `YAML integer "${raw}" exceeds safe IEEE-754 integer precision`,
                { token: raw }
            );
        }
        const num = Number(big);
        return Object.is(num, -0) ? 0 : num;
    }
    if (FLOAT_RE.test(raw)) {
        const num = Number(raw);
        if (!Number.isFinite(num)) {
            throw new YamlSignalError(
                'YAML_NONFINITE_NUMBER',
                `YAML float "${raw}" overflows finite IEEE-754 range`,
                { token: raw }
            );
        }
        return Object.is(num, -0) ? 0 : num;
    }
    return raw;
}

/**
 * Fold multiline quoted scalar continuations per YAML 1.2 flow-folding rules.
 *
 * @param {string[]} lines - Raw lines inside single-quoted scalar
 * @returns {string}
 */
function foldFlowLines(lines) {
    if (lines.length <= 1) {
        return lines[0] || '';
    }
    let out = lines[0].replace(/[ \t]+$/, '');
    let emptyRun = 0;
    for (let i = 1; i < lines.length; i += 1) {
        const trimmedLead = lines[i].replace(/^[ \t]+/, '');
        const trimmed = i < lines.length - 1 ? trimmedLead.replace(/[ \t]+$/, '') : trimmedLead;
        if (trimmed === '' && i < lines.length - 1) {
            emptyRun += 1;
        } else {
            if (emptyRun > 0) {
                out += '\n'.repeat(emptyRun) + trimmed;
                emptyRun = 0;
            } else {
                out += (out.endsWith('\n') ? '' : ' ') + trimmed;
            }
        }
    }
    return out;
}

/**
 * Fold YAML 1.2 block scalar `>` content lines while preserving more-indented blocks.
 *
 * @param {string[]} contentLines - Stripped block scalar lines
 * @returns {string}
 */
function foldBlockScalarLines(contentLines) {
    if (contentLines.length === 0) return '';
    let out = '';
    let pendingBreaks = 0;
    let prevType = 'none'; // 'normal' | 'indented' | 'none'

    for (let i = 0; i < contentLines.length; i += 1) {
        const line = contentLines[i];
        if (line === '') {
            pendingBreaks += 1;
            continue;
        }
        const isMoreIndented = line[0] === ' ' || line[0] === '\t';
        const currType = isMoreIndented ? 'indented' : 'normal';
        if (prevType === 'none') {
            if (pendingBreaks > 0) {
                out += '\n'.repeat(pendingBreaks);
                pendingBreaks = 0;
            }
            out += line;
        } else if (prevType === 'normal' && currType === 'normal') {
            out += pendingBreaks === 0 ? ' ' : '\n'.repeat(pendingBreaks);
            pendingBreaks = 0;
            out += line;
        } else {
            out += '\n'.repeat(pendingBreaks + 1);
            pendingBreaks = 0;
            out += line;
        }
        prevType = currType;
    }

    if (pendingBreaks > 0) {
        out += '\n'.repeat(pendingBreaks);
    }
    return out;
}

// ============================================================================
// Deterministic YAML 1.2 Core Parser
// ============================================================================

/**
 * Check if character is whitespace (`' '` or `'\t'`).
 *
 * @param {string | undefined} ch - Single character
 * @returns {boolean}
 */
function isInlineWs(ch) {
    return ch === ' ' || ch === '\t';
}

/**
 * Check if character ends a line or stream (`undefined` or `'\n'`).
 *
 * @param {string | undefined} ch - Single character
 * @returns {boolean}
 */
function isBreakOrEof(ch) {
    return ch === undefined || ch === '\n';
}

/**
 * Check if character is whitespace, newline, or EOF.
 *
 * @param {string | undefined} ch - Single character
 * @returns {boolean}
 */
function isWhiteOrEnd(ch) {
    return ch === undefined || ch === ' ' || ch === '\t' || ch === '\n';
}

/**
 * Check if character is a flow indicator (`,`, `[`, `]`, `{`, `}`).
 *
 * @param {string | undefined} ch - Single character
 * @returns {boolean}
 */
function isFlowIndicator(ch) {
    return ch === ',' || ch === '[' || ch === ']' || ch === '{' || ch === '}';
}

/**
 * Check whether an anchor/alias character is permitted by YAML 1.2 `ns-anchor-char`.
 *
 * @param {string | undefined} ch - Candidate character
 * @returns {boolean}
 */
function isAnchorChar(ch) {
    return ch !== undefined && !isWhiteOrEnd(ch) && !isFlowIndicator(ch);
}

class YamlCoreParser {
    /**
     * @param {string} source - Normalized LF YAML text
     * @param {{ maxDepth: number, maxNodes: number, maxAliases: number, maxAliasExpansionNodes: number, allowMultipleDocuments: boolean }} config - Resource limits
     */
    constructor(source, config) {
        this.src = source;
        this.len = source.length;
        this.pos = 0;
        this.line = 1;
        this.col = 0;
        this.atLineStart = true;

        this.maxDepth = config.maxDepth;
        this.maxNodes = config.maxNodes;
        this.maxAliases = config.maxAliases;
        this.maxAliasExpansionNodes = config.maxAliasExpansionNodes;
        this.allowMultipleDocuments = config.allowMultipleDocuments;

        this.nodeCount = 0;
        this.aliasCount = 0;
        this.aliasExpansionNodes = 0;
        this.anchors = new Map();
        this.activeAnchors = new Set();
        this.lastPlainStoppedAtComment = false;
    }

    /**
     * Format a parse error with current line and column coordinates.
     *
     * @param {string} code - Error code
     * @param {string} message - Diagnostic message
     * @param {Record<string, unknown>} [extra={}] - Extra details
     * @returns {YamlSignalError}
     */
    fail(code, message, extra = {}) {
        return new YamlSignalError(code, `${message} (line ${this.line}, col ${this.col + 1})`, {
            line: this.line,
            column: this.col + 1,
            ...extra,
        });
    }

    /**
     * Advance cursor by `count` characters while updating line/column state.
     *
     * @param {number} [count=1] - Character count
     */
    advance(count = 1) {
        for (let i = 0; i < count && this.pos < this.len; i += 1) {
            const ch = this.src[this.pos];
            this.pos += 1;
            if (ch === '\n') {
                this.line += 1;
                this.col = 0;
                this.atLineStart = true;
            } else {
                this.col += 1;
                if (ch !== ' ') {
                    this.atLineStart = false;
                }
            }
        }
    }

    /**
     * Record a newly constructed scalar/array/object node against `maxNodes`.
     */
    countNode() {
        this.nodeCount += 1;
        if (this.nodeCount > this.maxNodes) {
            throw this.fail(
                'YAML_MAX_NODES',
                `YAML document exceeds maximum node count of ${this.maxNodes}`,
                { maxNodes: this.maxNodes }
            );
        }
    }

    /**
     * Verify container depth against `maxDepth`.
     *
     * @param {number} depth - Container nesting depth (`1` for root container)
     */
    checkDepth(depth) {
        if (depth > this.maxDepth) {
            throw this.fail(
                'YAML_MAX_DEPTH',
                `YAML nesting depth exceeds maximum of ${this.maxDepth}`,
                { maxDepth: this.maxDepth }
            );
        }
    }

    /**
     * Deep-clone an anchored value while enforcing `maxAliasExpansionNodes`, `maxNodes`, and `maxDepth`.
     *
     * @param {unknown} target - Anchored target value
     * @param {number} depth - Current container depth at dereference site
     * @returns {unknown}
     */
    cloneAliasedValue(target, depth) {
        this.aliasExpansionNodes += 1;
        if (this.aliasExpansionNodes > this.maxAliasExpansionNodes) {
            throw this.fail(
                'YAML_ALIAS_BOMB',
                `YAML alias expansion exceeds maximum of ${this.maxAliasExpansionNodes} cloned nodes`,
                { maxAliasExpansionNodes: this.maxAliasExpansionNodes }
            );
        }
        this.countNode();

        if (target === null || typeof target !== 'object') {
            return target;
        }
        const nextDepth = depth + 1;
        this.checkDepth(nextDepth);

        if (Array.isArray(target)) {
            const outArr = [];
            for (let i = 0; i < target.length; i += 1) {
                outArr.push(this.cloneAliasedValue(target[i], nextDepth));
            }
            return outArr;
        }

        const outObj = {};
        const keys = Object.keys(target);
        for (let i = 0; i < keys.length; i += 1) {
            const key = keys[i];
            defineSafeProperty(outObj, key, this.cloneAliasedValue(target[key], nextDepth));
        }
        return outObj;
    }

    /**
     * Resolve `*alias` reference with bounded deep cloning.
     *
     * @param {string} name - Alias identifier
     * @param {number} depth - Current container depth
     * @returns {unknown}
     */
    resolveAlias(name, depth) {
        if (this.activeAnchors.has(name)) {
            throw this.fail('YAML_ALIAS_BOMB', `Cyclic YAML alias "*${name}" is forbidden`, {
                alias: name,
            });
        }
        if (!this.anchors.has(name)) {
            throw this.fail('YAML_UNKNOWN_ALIAS', `Unknown YAML alias "*${name}"`, {
                alias: name,
            });
        }
        this.aliasCount += 1;
        if (this.aliasCount > this.maxAliases) {
            throw this.fail(
                'YAML_ALIAS_BOMB',
                `YAML alias count exceeds maximum of ${this.maxAliases}`,
                { maxAliases: this.maxAliases }
            );
        }
        return this.cloneAliasedValue(this.anchors.get(name), depth);
    }

    /**
     * Skip inline spaces/tabs and optional trailing `# comment` on the current line, stopping at `\n` or EOF.
     */
    skipInlineSpacesAndComment() {
        while (this.pos < this.len) {
            const ch = this.src[this.pos];
            if (ch === ' ') {
                this.advance(1);
                continue;
            }
            if (ch === '\t') {
                if (this.atLineStart) {
                    let look = this.pos;
                    while (look < this.len && (this.src[look] === ' ' || this.src[look] === '\t')) {
                        look += 1;
                    }
                    const nextCh = this.src[look];
                    if (nextCh !== undefined && nextCh !== '\n' && nextCh !== '#') {
                        throw this.fail('YAML_PARSE_ERROR', 'Tabs are not permitted for YAML block indentation');
                    }
                }
                this.advance(1);
                continue;
            }
            if (ch === '#') {
                while (this.pos < this.len && this.src[this.pos] !== '\n') {
                    this.advance(1);
                }
            }
            break;
        }
    }

    /**
     * Advance across blank/comment-only lines to the start of the next block token, enforcing space-only indentation.
     */
    skipToNextBlockToken() {
        while (this.pos < this.len) {
            if (this.atLineStart) {
                while (this.pos < this.len && this.src[this.pos] === ' ') {
                    this.advance(1);
                }
                if (this.pos >= this.len) break;
                const ch = this.src[this.pos];
                if (ch === '\t') {
                    let look = this.pos;
                    while (look < this.len && (this.src[look] === ' ' || this.src[look] === '\t')) {
                        look += 1;
                    }
                    const afterWs = this.src[look];
                    if (afterWs === undefined || afterWs === '\n') {
                        while (this.pos < look) this.advance(1);
                        if (this.pos < this.len && this.src[this.pos] === '\n') this.advance(1);
                        continue;
                    }
                    if (afterWs === '#') {
                        while (this.pos < this.len && this.src[this.pos] !== '\n') this.advance(1);
                        if (this.pos < this.len && this.src[this.pos] === '\n') this.advance(1);
                        continue;
                    }
                    throw this.fail('YAML_PARSE_ERROR', 'Tabs are not permitted for YAML block indentation');
                }
                if (ch === '\n') {
                    this.advance(1);
                    continue;
                }
                if (ch === '#') {
                    while (this.pos < this.len && this.src[this.pos] !== '\n') {
                        this.advance(1);
                    }
                    if (this.pos < this.len && this.src[this.pos] === '\n') {
                        this.advance(1);
                    }
                    continue;
                }
                break;
            } else {
                this.skipInlineSpacesAndComment();
                if (this.pos < this.len && this.src[this.pos] === '\n') {
                    this.advance(1);
                    continue;
                }
                break;
            }
        }
    }

    /**
     * Check whether cursor sits at a column-0 document marker (`---` or `...`).
     *
     * @param {'---' | '...'} marker - Marker string
     * @returns {boolean}
     */
    isAtDocumentMarker(marker) {
        if (this.col !== 0) return false;
        if (this.src.slice(this.pos, this.pos + 3) !== marker) return false;
        return isWhiteOrEnd(this.src[this.pos + 3]);
    }

    /**
     * Check whether cursor sits at any column-0 document marker (`---` or `...`).
     *
     * @returns {boolean}
     */
    isAtAnyDocumentMarker() {
        return this.isAtDocumentMarker('---') || this.isAtDocumentMarker('...');
    }

    /**
     * Check whether cursor sits at a block sequence `-` indicator.
     *
     * @returns {boolean}
     */
    isAtBlockSeqIndicator() {
        if (this.src[this.pos] !== '-') return false;
        if (this.isAtDocumentMarker('---')) return false;
        const next = this.src[this.pos + 1];
        if (next === '\t') {
            throw this.fail('YAML_PARSE_ERROR', 'Tabs are not permitted after "-" block sequence indicator');
        }
        return next === undefined || next === ' ' || next === '\n';
    }

    /**
     * Parse the complete YAML stream (single document by default, or multi-document array).
     *
     * @returns {unknown}
     */
    parseStream() {
        const docs = [];
        let allowImplicitFirstDoc = true;

        while (true) {
            this.skipToNextBlockToken();
            if (this.pos >= this.len) {
                break;
            }

            if (docs.length > 0 && !this.allowMultipleDocuments) {
                throw this.fail(
                    'YAML_MULTIPLE_DOCUMENTS',
                    'Multiple YAML documents are forbidden unless allowMultipleDocuments is true'
                );
            }

            this.anchors = new Map();
            this.activeAnchors = new Set();

            let sawDirective = false;
            while (this.pos < this.len && this.col === 0 && this.src[this.pos] === '%') {
                if (!allowImplicitFirstDoc && docs.length > 0) {
                    // Directives are valid before `---` at start of next document if preceded by `...` or at stream start
                }
                sawDirective = true;
                const lineEnd = this.src.indexOf('\n', this.pos);
                const rawLine = lineEnd === -1 ? this.src.slice(this.pos) : this.src.slice(this.pos, lineEnd);
                if (/^%TAG(?:\s|$)/.test(rawLine)) {
                    throw this.fail('YAML_FORBIDDEN_TAG', 'YAML %TAG directives are forbidden');
                }
                if (!/^%YAML[ \t]+1\.[12](?:[ \t]+#.*|[ \t]*)$/.test(rawLine)) {
                    throw this.fail('YAML_PARSE_ERROR', `Unsupported YAML directive "${rawLine.trim()}"`);
                }
                this.advance(rawLine.length);
                if (this.pos < this.len && this.src[this.pos] === '\n') {
                    this.advance(1);
                }
                this.skipToNextBlockToken();
            }

            let sawDocStart = false;
            if (this.isAtDocumentMarker('---')) {
                sawDocStart = true;
                this.advance(3);
            } else if (sawDirective) {
                throw this.fail('YAML_PARSE_ERROR', 'YAML directives must be followed by "---" document marker');
            } else if (!allowImplicitFirstDoc) {
                throw this.fail(
                    'YAML_PARSE_ERROR',
                    'Subsequent YAML document must begin with "---" marker'
                );
            }

            this.skipToNextBlockToken();

            let docValue;
            if (this.pos >= this.len || this.isAtAnyDocumentMarker()) {
                this.countNode();
                docValue = null;
            } else {
                docValue = this.parseBlockNode(-1, 0, true);
            }

            docs.push(docValue);

            this.skipToNextBlockToken();
            if (this.isAtDocumentMarker('...')) {
                this.advance(3);
                this.skipInlineSpacesAndComment();
                if (this.pos < this.len && this.src[this.pos] !== '\n') {
                    throw this.fail('YAML_PARSE_ERROR', 'Unexpected trailing content after "..." marker');
                }
                if (this.pos < this.len && this.src[this.pos] === '\n') {
                    this.advance(1);
                }
                allowImplicitFirstDoc = true;
            } else {
                allowImplicitFirstDoc = false;
                if (this.pos < this.len && !this.isAtDocumentMarker('---')) {
                    throw this.fail('YAML_PARSE_ERROR', 'Unexpected trailing content after YAML document');
                }
            }

            if (sawDocStart && !this.allowMultipleDocuments) {
                this.skipToNextBlockToken();
                if (this.pos < this.len) {
                    throw this.fail(
                        'YAML_MULTIPLE_DOCUMENTS',
                        'Multiple YAML documents are forbidden unless allowMultipleDocuments is true'
                    );
                }
            }
        }

        if (this.allowMultipleDocuments) {
            return docs;
        }
        if (docs.length === 0) {
            this.countNode();
            return null;
        }
        return docs[0];
    }

    /**
     * Read `&anchor` or `*alias` identifier after consuming the leading sigil.
     *
     * @param {'&' | '*'} sigil - Leading character
     * @returns {string}
     */
    readAnchorOrAliasName(sigil) {
        this.advance(1);
        const start = this.pos;
        while (this.pos < this.len && isAnchorChar(this.src[this.pos])) {
            this.advance(1);
        }
        const name = this.src.slice(start, this.pos);
        if (name.length === 0) {
            throw this.fail('YAML_PARSE_ERROR', `Expected identifier after "${sigil}"`);
        }
        return name;
    }

    /**
     * Parse a block-context YAML node whose indentation must exceed `parentIndent`.
     *
     * @param {number} parentIndent - Enclosing block indentation (`-1` at root)
     * @param {number} depth - Current container depth
     * @param {boolean} [allowIndentlessSeq=false] - Whether `- ` at `parentIndent` is allowed (mapping values)
     * @param {boolean} [allowCompactBlock=false] - Whether an inline compact block collection is allowed (`- ` items)
     * @returns {unknown}
     */
    parseBlockNode(parentIndent, depth, allowIndentlessSeq = false, allowCompactBlock = false) {
        this.skipToNextBlockToken();
        if (this.pos >= this.len || this.isAtAnyDocumentMarker()) {
            this.countNode();
            return null;
        }

        const startLine = this.line;
        const startCol = this.col;

        // Check leading tag or anchor properties on the node itself (unless `&a` belongs to a mapping key on this line!)
        let anchorName = null;
        if (this.src[this.pos] === '!') {
            throw this.fail('YAML_FORBIDDEN_TAG', 'Explicit YAML tags ("!") are forbidden');
        }
        if (
            this.src[this.pos] === '&' &&
            !((this.atLineStart || allowCompactBlock) && this.hasMappingColonAfterLeadingProperty())
        ) {
            anchorName = this.readAnchorOrAliasName('&');
            this.skipInlineSpacesAndComment();
            if (this.src[this.pos] === '!') {
                throw this.fail('YAML_FORBIDDEN_TAG', 'Explicit YAML tags ("!") are forbidden');
            }
            if (this.src[this.pos] === '&') {
                throw this.fail('YAML_PARSE_ERROR', 'Multiple anchors on a single YAML node are forbidden');
            }
            if (isBreakOrEof(this.src[this.pos])) {
                this.skipToNextBlockToken();
                const canBeIndentless =
                    allowIndentlessSeq &&
                    this.pos < this.len &&
                    !this.isAtAnyDocumentMarker() &&
                    this.col === parentIndent &&
                    this.isAtBlockSeqIndicator();
                if (
                    this.pos >= this.len ||
                    this.isAtAnyDocumentMarker() ||
                    (this.col <= parentIndent && !canBeIndentless)
                ) {
                    this.countNode();
                    this.anchors.set(anchorName, null);
                    return null;
                }
            }
        }

        if (anchorName !== null) {
            this.activeAnchors.add(anchorName);
        }

        const effectiveCompactBlock = allowCompactBlock && anchorName === null;

        try {
            const result = this.parseBlockNodeBody(
                parentIndent,
                depth,
                allowIndentlessSeq,
                startLine,
                startCol,
                effectiveCompactBlock
            );
            if (anchorName !== null) {
                this.anchors.set(anchorName, result);
            }
            return result;
        } finally {
            if (anchorName !== null) {
                this.activeAnchors.delete(anchorName);
            }
        }
    }

    /**
     * Look ahead on the current line to detect if `&anchor key: val` attaches `&anchor` to a mapping key
     * rather than to the mapping node itself.
     *
     * @returns {boolean}
     */
    hasMappingColonAfterLeadingProperty() {
        let p = this.pos;
        if (this.src[p] !== '&') return false;
        p += 1;
        while (p < this.len && isAnchorChar(this.src[p])) p += 1;
        while (p < this.len && isInlineWs(this.src[p])) p += 1;
        if (p >= this.len || this.src[p] === '\n' || this.src[p] === '#' || this.src[p] === '|' || this.src[p] === '>') {
            return false;
        }
        if (this.src[p] === '[' || this.src[p] === '{' || this.src[p] === '-') {
            return false;
        }
        return this.peekLineHasBlockMappingColonFrom(p);
    }

    /**
     * Non-mutating single-line lookahead checking whether offset `startPos` begins a block mapping key (`key: ...`).
     *
     * @param {number} startPos - Starting character index on current line
     * @returns {boolean}
     */
    peekLineHasBlockMappingColonFrom(startPos) {
        let p = startPos;
        let first = this.src[p];
        if (first === '&') {
            p += 1;
            if (p >= this.len || !isAnchorChar(this.src[p])) {
                return false;
            }
            while (p < this.len && isAnchorChar(this.src[p])) p += 1;
            while (p < this.len && isInlineWs(this.src[p])) p += 1;
            first = this.src[p];
        }
        if (
            p >= this.len ||
            first === '\n' ||
            first === '#' ||
            first === '|' ||
            first === '>' ||
            first === '!' ||
            (first === '-' && isWhiteOrEnd(this.src[p + 1]))
        ) {
            return false;
        }
        if (first === '?' && isWhiteOrEnd(this.src[p + 1])) {
            return true;
        }
        if (first === '"' || first === "'") {
            const quote = first;
            p += 1;
            while (p < this.len && this.src[p] !== '\n') {
                if (quote === '"' && this.src[p] === '\\') {
                    p += 2;
                    continue;
                }
                if (quote === "'" && this.src[p] === "'" && this.src[p + 1] === "'") {
                    p += 2;
                    continue;
                }
                if (this.src[p] === quote) {
                    p += 1;
                    while (p < this.len && isInlineWs(this.src[p])) p += 1;
                    return this.src[p] === ':' && isWhiteOrEnd(this.src[p + 1]);
                }
                p += 1;
            }
            return false;
        }
        if (first === '[' || first === '{') {
            const close = first === '[' ? ']' : '}';
            let depth = 1;
            p += 1;
            while (p < this.len && this.src[p] !== '\n' && depth > 0) {
                const ch = this.src[p];
                if (ch === '"' || ch === "'") {
                    const q = ch;
                    p += 1;
                    while (p < this.len && this.src[p] !== '\n') {
                        if (q === '"' && this.src[p] === '\\') {
                            p += 2;
                            continue;
                        }
                        if (q === "'" && this.src[p] === "'" && this.src[p + 1] === "'") {
                            p += 2;
                            continue;
                        }
                        if (this.src[p] === q) {
                            p += 1;
                            break;
                        }
                        p += 1;
                    }
                    continue;
                }
                if (ch === first) depth += 1;
                else if (ch === close) depth -= 1;
                p += 1;
            }
            if (depth !== 0) return false;
            while (p < this.len && isInlineWs(this.src[p])) p += 1;
            return this.src[p] === ':' && isWhiteOrEnd(this.src[p + 1]);
        }

        const scanStart = p;
        while (p < this.len && this.src[p] !== '\n') {
            const ch = this.src[p];
            if (ch === '#' && p > scanStart && isInlineWs(this.src[p - 1])) {
                return false;
            }
            if (ch === ':' && isWhiteOrEnd(this.src[p + 1])) {
                return true;
            }
            p += 1;
        }
        return false;
    }

    /**
     * Parse the core body of a block node after node-level properties have been extracted.
     *
     * @param {number} parentIndent - Enclosing block indentation
     * @param {number} depth - Current container depth
     * @param {boolean} allowIndentlessSeq - Allow sequence at `parentIndent`
     * @param {number} _propLine - Property start line
     * @param {number} propCol - Property start column
     * @param {boolean} [allowCompactBlock=false] - Whether inline compact block collections are permitted
     * @returns {unknown}
     */
    parseBlockNodeBody(parentIndent, depth, allowIndentlessSeq, _propLine, propCol, allowCompactBlock = false) {
        const ch = this.src[this.pos];
        if (ch === '!') {
            throw this.fail('YAML_FORBIDDEN_TAG', 'Explicit YAML tags ("!") are forbidden');
        }
        if (ch === '|' || ch === '>') {
            return this.parseBlockScalar(parentIndent);
        }
        if (this.isAtBlockSeqIndicator()) {
            if (!this.atLineStart && !allowCompactBlock) {
                throw this.fail('YAML_PARSE_ERROR', 'Inline block sequence is not allowed in this YAML context');
            }
            const seqIndent = this.col;
            if (seqIndent < parentIndent || (seqIndent === parentIndent && !allowIndentlessSeq)) {
                throw this.fail('YAML_PARSE_ERROR', 'Insufficient indentation for YAML block sequence');
            }
            return this.parseBlockSequence(seqIndent, depth + 1);
        }
        if (this.peekLineHasBlockMappingColonFrom(this.pos)) {
            if (!this.atLineStart && !allowCompactBlock) {
                throw this.fail(
                    'YAML_PARSE_ERROR',
                    'Unquoted colon followed by whitespace or inline block mapping is forbidden here'
                );
            }
            const mapIndent = this.atLineStart ? this.col : propCol;
            if (mapIndent <= parentIndent) {
                throw this.fail('YAML_PARSE_ERROR', 'Insufficient indentation for YAML block mapping');
            }
            return this.parseBlockMapping(mapIndent, depth + 1);
        }
        if (ch === '[') {
            const seq = this.parseFlowSequence(depth + 1);
            this.ensureEndOfInlineValue();
            return seq;
        }
        if (ch === '{') {
            const map = this.parseFlowMapping(depth + 1);
            this.ensureEndOfInlineValue();
            return map;
        }
        if (ch === '*') {
            const aliasName = this.readAnchorOrAliasName('*');
            this.ensureEndOfInlineValue();
            return this.resolveAlias(aliasName, depth);
        }
        if (ch === '"') {
            const str = this.parseDoubleQuotedScalar(parentIndent);
            this.ensureEndOfInlineValue();
            this.countNode();
            return str;
        }
        if (ch === "'") {
            const str = this.parseSingleQuotedScalar(parentIndent);
            this.ensureEndOfInlineValue();
            this.countNode();
            return str;
        }
        return this.parseBlockPlainScalar(parentIndent);
    }

    /**
     * Ensure nothing except inline spaces/tabs and `# comment` trails a closed inline value on the current line.
     */
    ensureEndOfInlineValue() {
        this.skipInlineSpacesAndComment();
        if (this.pos < this.len && this.src[this.pos] !== '\n') {
            throw this.fail('YAML_PARSE_ERROR', `Unexpected trailing token "${this.src[this.pos]}"`);
        }
    }

    /**
     * Parse a literal (`|`) or folded (`>`) YAML 1.2 block scalar.
     *
     * @param {number} parentIndent - Enclosing block indentation (`-1` at root)
     * @returns {string}
     */
    parseBlockScalar(parentIndent) {
        const style = this.src[this.pos];
        this.advance(1);

        let chomp = 'clip';
        let explicitIndent = 0;

        for (let i = 0; i < 2 && this.pos < this.len; i += 1) {
            const ch = this.src[this.pos];
            if ((ch === '-' || ch === '+') && chomp === 'clip') {
                chomp = ch === '-' ? 'strip' : 'keep';
                this.advance(1);
            } else if (ch >= '1' && ch <= '9' && explicitIndent === 0) {
                explicitIndent = ch.charCodeAt(0) - 48;
                this.advance(1);
            } else {
                break;
            }
        }

        if (this.pos < this.len && !isWhiteOrEnd(this.src[this.pos])) {
            throw this.fail('YAML_PARSE_ERROR', 'Invalid YAML block scalar header');
        }
        this.skipInlineSpacesAndComment();
        if (this.pos < this.len && this.src[this.pos] !== '\n') {
            throw this.fail('YAML_PARSE_ERROR', 'Invalid trailing characters in YAML block scalar header');
        }
        if (this.pos < this.len && this.src[this.pos] === '\n') {
            this.advance(1);
        }

        const minAllowedIndent = parentIndent < 0 ? 0 : parentIndent + 1;
        const baseIndent = parentIndent < 0 ? 0 : parentIndent;
        let contentIndent = explicitIndent > 0 ? baseIndent + explicitIndent : -1;

        const rawLines = [];
        let maxLeadingEmptySpaces = 0;

        while (this.pos < this.len) {
            const lineStart = this.pos;
            let spaces = 0;
            while (this.pos < this.len && this.src[this.pos] === ' ') {
                spaces += 1;
                this.advance(1);
            }

            const chAtAfterSpaces = this.src[this.pos];
            const isAllSpaceLine = isBreakOrEof(chAtAfterSpaces);

            if (isAllSpaceLine) {
                rawLines.push({ spaces, rest: '', isEmpty: true });
                if (contentIndent === -1 && spaces > maxLeadingEmptySpaces) {
                    maxLeadingEmptySpaces = spaces;
                }
                if (this.pos < this.len && this.src[this.pos] === '\n') {
                    this.advance(1);
                }
                continue;
            }

            if (
                spaces === 0 &&
                (this.src.slice(lineStart, lineStart + 3) === '---' ||
                    this.src.slice(lineStart, lineStart + 3) === '...') &&
                isWhiteOrEnd(this.src[lineStart + 3])
            ) {
                this.pos = lineStart;
                this.col = 0;
                this.atLineStart = true;
                break;
            }

            if (contentIndent === -1) {
                if (spaces < minAllowedIndent) {
                    if (chAtAfterSpaces === '\t') {
                        throw this.fail('YAML_PARSE_ERROR', 'Tabs are not permitted for YAML block scalar indentation');
                    }
                    this.pos = lineStart;
                    this.col = 0;
                    this.atLineStart = true;
                    break;
                }
                if (maxLeadingEmptySpaces > spaces) {
                    throw this.fail(
                        'YAML_PARSE_ERROR',
                        'Leading blank line in block scalar exceeds detected content indentation'
                    );
                }
                contentIndent = spaces;
            } else if (spaces < contentIndent) {
                if (chAtAfterSpaces === '\t') {
                    throw this.fail('YAML_PARSE_ERROR', 'Tabs are not permitted for YAML block scalar indentation');
                }
                this.pos = lineStart;
                this.col = 0;
                this.atLineStart = true;
                break;
            }

            const lineEnd = this.src.indexOf('\n', lineStart);
            const fullLine = lineEnd === -1 ? this.src.slice(lineStart) : this.src.slice(lineStart, lineEnd);
            rawLines.push({
                spaces,
                rest: fullLine.slice(contentIndent),
                isEmpty: false,
            });

            this.pos = lineStart;
            this.col = 0;
            this.atLineStart = true;
            this.advance(fullLine.length);
            if (this.pos < this.len && this.src[this.pos] === '\n') {
                this.advance(1);
            }
        }

        let lastNonEmptyIdx = -1;
        for (let i = rawLines.length - 1; i >= 0; i -= 1) {
            if (!rawLines[i].isEmpty) {
                lastNonEmptyIdx = i;
                break;
            }
        }

        this.countNode();

        if (lastNonEmptyIdx === -1) {
            if (chomp === 'keep') {
                return '\n'.repeat(rawLines.length);
            }
            return '';
        }

        const effectiveIndent = contentIndent === -1 ? minAllowedIndent : contentIndent;
        const bodyLines = [];
        for (let i = 0; i <= lastNonEmptyIdx; i += 1) {
            const entry = rawLines[i];
            if (entry.isEmpty) {
                bodyLines.push(entry.spaces > effectiveIndent ? ' '.repeat(entry.spaces - effectiveIndent) : '');
            } else {
                bodyLines.push(entry.rest);
            }
        }

        const trailingEmptyCount = rawLines.length - 1 - lastNonEmptyIdx;
        const coreText = style === '|' ? bodyLines.join('\n') : foldBlockScalarLines(bodyLines);

        if (chomp === 'strip') {
            return coreText;
        }
        if (chomp === 'keep') {
            return `${coreText}\n${'\n'.repeat(trailingEmptyCount)}`;
        }
        return `${coreText}\n`;
    }

    /**
     * Parse a single-quoted YAML scalar (`'...'`, escaping `''` -> `'`).
     *
     * @param {number} minIndent - Minimum indentation required on continuation lines (`-1` inside flow)
     * @returns {string}
     */
    parseSingleQuotedScalar(minIndent) {
        this.advance(1); // skip opening '
        const lines = [];
        let current = '';

        while (this.pos < this.len) {
            const ch = this.src[this.pos];
            if (ch === "'") {
                if (this.src[this.pos + 1] === "'") {
                    current += "'";
                    this.advance(2);
                    continue;
                }
                this.advance(1);
                lines.push(current);
                return foldFlowLines(lines);
            }
            if (ch === '\n') {
                lines.push(current);
                current = '';
                this.advance(1);
                if (this.isAtAnyDocumentMarker()) {
                    throw this.fail('YAML_PARSE_ERROR', 'Unterminated single-quoted YAML string before document marker');
                }
                if (minIndent >= 0) {
                    let sp = 0;
                    while (this.pos + sp < this.len && this.src[this.pos + sp] === ' ') sp += 1;
                    const nextAfterSp = this.src[this.pos + sp];
                    if (nextAfterSp === '\t') {
                        throw this.fail('YAML_PARSE_ERROR', 'Tabs are not permitted for YAML block indentation');
                    }
                    if (!isBreakOrEof(nextAfterSp) && sp <= minIndent) {
                        throw this.fail('YAML_PARSE_ERROR', 'Insufficient indentation in multiline single-quoted string');
                    }
                }
                continue;
            }
            current += ch;
            this.advance(1);
        }

        throw this.fail('YAML_PARSE_ERROR', 'Unterminated single-quoted YAML string');
    }

    /**
     * Parse a double-quoted YAML 1.2 scalar (`"..."`).
     *
     * @param {number} minIndent - Minimum indentation required on continuation lines (`-1` inside flow)
     * @returns {string}
     */
    parseDoubleQuotedScalar(minIndent) {
        this.advance(1); // skip opening "
        let out = '';
        let escapedFloor = 0;

        while (this.pos < this.len) {
            const ch = this.src[this.pos];
            if (ch === '"') {
                this.advance(1);
                return out;
            }
            if (ch === '\\') {
                this.advance(1);
                if (this.pos >= this.len) {
                    throw this.fail('YAML_PARSE_ERROR', 'Unterminated escape sequence in double-quoted string');
                }
                const esc = this.src[this.pos];
                if (esc === '\n') {
                    this.advance(1);
                    while (this.pos < this.len && isInlineWs(this.src[this.pos])) {
                        this.advance(1);
                    }
                    escapedFloor = out.length;
                    continue;
                }
                this.advance(1);
                switch (esc) {
                    case '"':
                        out += '"';
                        break;
                    case '\\':
                        out += '\\';
                        break;
                    case '/':
                        out += '/';
                        break;
                    case '0':
                        out += '\0';
                        break;
                    case 'a':
                        out += '\x07';
                        break;
                    case 'b':
                        out += '\b';
                        break;
                    case 't':
                    case '\t':
                        out += '\t';
                        break;
                    case 'n':
                        out += '\n';
                        break;
                    case 'v':
                        out += '\v';
                        break;
                    case 'f':
                        out += '\f';
                        break;
                    case 'r':
                        out += '\r';
                        break;
                    case 'e':
                        out += '\x1b';
                        break;
                    case ' ':
                        out += ' ';
                        break;
                    case 'N':
                        out += '\u0085';
                        break;
                    case '_':
                        out += '\u00a0';
                        break;
                    case 'L':
                        out += '\u2028';
                        break;
                    case 'P':
                        out += '\u2029';
                        break;
                    case 'x': {
                        const hex = this.readHexDigits(2);
                        out += String.fromCharCode(hex);
                        break;
                    }
                    case 'u': {
                        const code = this.readHexDigits(4);
                        if (code >= 0xd800 && code <= 0xdbff) {
                            if (this.src[this.pos] === '\\' && this.src[this.pos + 1] === 'u') {
                                this.advance(2);
                                const low = this.readHexDigits(4);
                                if (low < 0xdc00 || low > 0xdfff) {
                                    throw this.fail('YAML_PARSE_ERROR', 'Invalid UTF-16 surrogate pair escape');
                                }
                                out += String.fromCharCode(code, low);
                            } else {
                                throw this.fail('YAML_PARSE_ERROR', 'Unpaired high surrogate escape in YAML string');
                            }
                        } else if (code >= 0xdc00 && code <= 0xdfff) {
                            throw this.fail('YAML_PARSE_ERROR', 'Unpaired low surrogate escape in YAML string');
                        } else {
                            out += String.fromCharCode(code);
                        }
                        break;
                    }
                    case 'U': {
                        const cp = this.readHexDigits(8);
                        if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
                            throw this.fail('YAML_PARSE_ERROR', 'Invalid Unicode codepoint in \\U escape');
                        }
                        out += String.fromCodePoint(cp);
                        break;
                    }
                    default:
                        throw this.fail('YAML_PARSE_ERROR', `Unknown escape sequence "\\${esc}" in YAML string`);
                }
                escapedFloor = out.length;
                continue;
            }
            if (ch === '\n') {
                out = out.slice(0, escapedFloor) + out.slice(escapedFloor).replace(/[ \t]+$/, '');
                let emptyBreaks = 0;
                this.advance(1);
                while (this.pos < this.len) {
                    if (this.isAtAnyDocumentMarker()) {
                        throw this.fail('YAML_PARSE_ERROR', 'Unterminated double-quoted YAML string before document marker');
                    }
                    let sp = 0;
                    while (this.pos + sp < this.len && this.src[this.pos + sp] === ' ') sp += 1;
                    if (minIndent >= 0 && this.src[this.pos + sp] === '\t') {
                        throw this.fail('YAML_PARSE_ERROR', 'Tabs are not permitted for YAML block indentation');
                    }
                    while (this.pos < this.len && isInlineWs(this.src[this.pos])) {
                        this.advance(1);
                    }
                    if (this.pos < this.len && this.src[this.pos] === '\n') {
                        emptyBreaks += 1;
                        this.advance(1);
                        continue;
                    }
                    if (minIndent >= 0 && sp <= minIndent && this.src[this.pos] !== '"') {
                        throw this.fail('YAML_PARSE_ERROR', 'Insufficient indentation in multiline double-quoted string');
                    }
                    break;
                }
                out += emptyBreaks > 0 ? '\n'.repeat(emptyBreaks) : ' ';
                escapedFloor = out.length;
                continue;
            }
            out += ch;
            this.advance(1);
        }

        throw this.fail('YAML_PARSE_ERROR', 'Unterminated double-quoted YAML string');
    }

    /**
     * Read an exact count of hexadecimal digits for `\xXX`, `\uXXXX`, or `\UXXXXXXXX`.
     *
     * @param {number} digits - Required digit count
     * @returns {number}
     */
    readHexDigits(digits) {
        const slice = this.src.slice(this.pos, this.pos + digits);
        if (slice.length !== digits || !/^[0-9a-fA-F]+$/.test(slice)) {
            throw this.fail('YAML_PARSE_ERROR', `Expected ${digits} hexadecimal digits in escape sequence`);
        }
        this.advance(digits);
        return Number.parseInt(slice, 16);
    }

    /**
     * Parse an unquoted plain scalar in block context (supporting multiline folded continuation).
     *
     * @param {number} parentIndent - Minimum parent indentation (`-1` at root)
     * @returns {string | number | boolean | null}
     */
    parseBlockPlainScalar(parentIndent) {
        const firstCh = this.src[this.pos];
        if (
            firstCh === '@' ||
            firstCh === '`' ||
            firstCh === '%' ||
            firstCh === ',' ||
            firstCh === ']' ||
            firstCh === '}'
        ) {
            throw this.fail('YAML_PARSE_ERROR', `Reserved YAML indicator "${firstCh}" cannot start a plain scalar`);
        }

        const lines = [this.readPlainScalarLine(false)];
        const minContinuationIndent = parentIndent < 0 ? 1 : parentIndent + 1;

        while (!this.lastPlainStoppedAtComment && this.pos < this.len && this.src[this.pos] === '\n') {
            const savedPos = this.pos;
            const savedLine = this.line;
            const savedCol = this.col;
            const savedAtStart = this.atLineStart;

            this.advance(1);
            let blankLines = 0;
            let stoppedByComment = false;

            while (this.pos < this.len) {
                while (this.pos < this.len && this.src[this.pos] === ' ') {
                    this.advance(1);
                }
                if (this.pos >= this.len) break;
                const ch = this.src[this.pos];
                if (ch === '\n') {
                    blankLines += 1;
                    this.advance(1);
                    continue;
                }
                if (ch === '#') {
                    stoppedByComment = true;
                }
                break;
            }

            if (
                stoppedByComment ||
                this.pos >= this.len ||
                this.col < minContinuationIndent ||
                this.isAtAnyDocumentMarker() ||
                this.isAtBlockSeqIndicator() ||
                this.peekLineHasBlockMappingColonFrom(this.pos)
            ) {
                this.pos = savedPos;
                this.line = savedLine;
                this.col = savedCol;
                this.atLineStart = savedAtStart;
                break;
            }

            if (this.src[this.pos] === '\t') {
                throw this.fail('YAML_PARSE_ERROR', 'Tabs are not permitted for YAML block indentation');
            }

            for (let b = 0; b < blankLines; b += 1) {
                lines.push('');
            }
            lines.push(this.readPlainScalarLine(false));
        }

        const combined = foldFlowLines(lines);
        this.countNode();
        return resolvePlainScalar(combined);
    }

    /**
     * Read a single line (or flow segment) of an unquoted plain scalar.
     *
     * @param {boolean} inFlow - Whether inside `[...]` or `{...}`
     * @returns {string}
     */
    readPlainScalarLine(inFlow) {
        this.lastPlainStoppedAtComment = false;
        const start = this.pos;
        let lastNonWsEnd = this.pos;

        while (this.pos < this.len) {
            const ch = this.src[this.pos];
            if (ch === '\n') break;
            if (inFlow && isFlowIndicator(ch)) break;
            if (ch === '#' && this.pos > start && isInlineWs(this.src[this.pos - 1])) {
                break;
            }
            if (ch === ':') {
                const next = this.src[this.pos + 1];
                if (isWhiteOrEnd(next) || (inFlow && isFlowIndicator(next))) {
                    if (inFlow) {
                        break;
                    }
                    throw this.fail(
                        'YAML_PARSE_ERROR',
                        'Unquoted colon followed by whitespace is ambiguous inside an inline scalar'
                    );
                }
            }
            this.advance(1);
            if (!isInlineWs(ch)) {
                lastNonWsEnd = this.pos;
            }
        }

        const raw = this.src.slice(start, lastNonWsEnd);
        if (this.pos < this.len && this.src[this.pos] === '#') {
            this.lastPlainStoppedAtComment = true;
            while (this.pos < this.len && this.src[this.pos] !== '\n') {
                this.advance(1);
            }
        }
        return raw;
    }

    /**
     * Parse a block sequence (`- item`) anchored at exact column `seqIndent`.
     *
     * @param {number} seqIndent - Column of `-` indicators
     * @param {number} depth - Sequence container depth
     * @returns {unknown[]}
     */
    parseBlockSequence(seqIndent, depth) {
        this.checkDepth(depth);
        this.countNode();
        const items = [];

        while (true) {
            this.skipToNextBlockToken();
            if (this.pos >= this.len || this.isAtAnyDocumentMarker()) {
                break;
            }
            if (this.col < seqIndent) {
                break;
            }
            if (this.col > seqIndent) {
                throw this.fail('YAML_PARSE_ERROR', 'Unexpected over-indented line inside YAML block sequence');
            }
            if (!this.isAtBlockSeqIndicator()) {
                break;
            }

            this.advance(1); // consume '-'
            this.skipInlineSpacesAndComment();

            if (isBreakOrEof(this.src[this.pos])) {
                if (this.pos < this.len && this.src[this.pos] === '\n') {
                    this.advance(1);
                }
                this.skipToNextBlockToken();
                if (
                    this.pos >= this.len ||
                    this.isAtAnyDocumentMarker() ||
                    this.col <= seqIndent
                ) {
                    this.countNode();
                    items.push(null);
                    continue;
                }
                items.push(this.parseBlockNode(seqIndent, depth, false));
            } else {
                // Inline item on same line as `- ` (including compact `- key: val` and `- - nested`)
                const itemCol = this.col;
                if (this.peekLineHasBlockMappingColonFrom(this.pos)) {
                    items.push(this.parseBlockMapping(itemCol, depth + 1));
                } else {
                    items.push(this.parseBlockNode(seqIndent, depth, false, true));
                }
            }
        }

        return items;
    }

    /**
     * Parse a block mapping (`key: value`) anchored at exact column `mapIndent`.
     *
     * @param {number} mapIndent - Column of mapping keys
     * @param {number} depth - Mapping container depth
     * @returns {Record<string, unknown>}
     */
    parseBlockMapping(mapIndent, depth) {
        this.checkDepth(depth);
        this.countNode();

        const explicitEntries = [];
        const explicitKeys = new Set();
        let sawMergeKey = false;
        let firstInlineEntry = !this.atLineStart && this.col === mapIndent;

        while (true) {
            if (!firstInlineEntry) {
                this.skipToNextBlockToken();
                if (this.pos >= this.len || this.isAtAnyDocumentMarker()) {
                    break;
                }
                if (this.col < mapIndent) {
                    break;
                }
                if (this.col > mapIndent) {
                    throw this.fail('YAML_PARSE_ERROR', 'Invalid block mapping indentation');
                }
                if (!this.peekLineHasBlockMappingColonFrom(this.pos)) {
                    if (this.isAtBlockSeqIndicator()) {
                        break;
                    }
                    throw this.fail('YAML_PARSE_ERROR', 'Expected mapping "key: value" entry');
                }
            }
            firstInlineEntry = false;

            const keyInfo = this.readBlockMappingKey(mapIndent, depth);
            this.skipInlineSpacesAndComment();

            let val;
            if (isBreakOrEof(this.src[this.pos])) {
                if (this.pos < this.len && this.src[this.pos] === '\n') {
                    this.advance(1);
                }
                this.skipToNextBlockToken();
                const isIndentlessSeq =
                    this.pos < this.len &&
                    !this.isAtAnyDocumentMarker() &&
                    this.col === mapIndent &&
                    this.isAtBlockSeqIndicator();
                if (
                    this.pos >= this.len ||
                    this.isAtAnyDocumentMarker() ||
                    (this.col <= mapIndent && !isIndentlessSeq)
                ) {
                    this.countNode();
                    val = null;
                } else {
                    val = this.parseBlockNode(mapIndent, depth, true, false);
                }
            } else {
                val = this.parseBlockNode(mapIndent, depth, true, false);
            }

            if (keyInfo.isMerge) {
                if (sawMergeKey) {
                    throw this.fail('YAML_DUPLICATE_KEY', 'Duplicate YAML merge key "<<" in mapping', {
                        key: '<<',
                    });
                }
                sawMergeKey = true;
                explicitEntries.push({ isMerge: true, key: '<<', value: val });
            } else {
                const { key } = keyInfo;
                if (FORBIDDEN_KEYS.has(key)) {
                    throw this.fail('YAML_FORBIDDEN_KEY', `Forbidden YAML mapping key "${key}"`, { key });
                }
                if (explicitKeys.has(key)) {
                    throw this.fail('YAML_DUPLICATE_KEY', `Duplicate YAML mapping key "${key}"`, { key });
                }
                explicitKeys.add(key);
                explicitEntries.push({ isMerge: false, key, value: val });
            }
        }

        return this.assembleMappingObject(explicitEntries, explicitKeys);
    }

    /**
     * Read and validate a block mapping key up to and including its `:` separator.
     *
     * @param {number} mapIndent - Current mapping indentation
     * @param {number} depth - Current container depth
     * @returns {{ key: string, isMerge: boolean }}
     */
    readBlockMappingKey(mapIndent, depth) {
        if (this.src[this.pos] === '!') {
            throw this.fail('YAML_FORBIDDEN_TAG', 'Explicit YAML tags ("!") are forbidden on mapping keys');
        }

        const keyStartLine = this.line;
        let keyAnchor = null;
        if (this.src[this.pos] === '&') {
            keyAnchor = this.readAnchorOrAliasName('&');
            this.skipInlineSpacesAndComment();
            if (this.src[this.pos] === '!') {
                throw this.fail('YAML_FORBIDDEN_TAG', 'Explicit YAML tags ("!") are forbidden on mapping keys');
            }
        }

        if (this.src[this.pos] === '?' && isWhiteOrEnd(this.src[this.pos + 1])) {
            this.advance(1);
            this.skipInlineSpacesAndComment();
            const complexKey = this.parseBlockNode(mapIndent, depth, false);
            this.skipToNextBlockToken();
            if (this.src[this.pos] !== ':' || !isWhiteOrEnd(this.src[this.pos + 1])) {
                throw this.fail('YAML_PARSE_ERROR', 'Expected ":" value indicator after explicit "?" mapping key');
            }
            this.advance(1);
            if (typeof complexKey !== 'string') {
                throw this.fail('YAML_INVALID_KEY', 'YAML mapping keys must be strings');
            }
            if (keyAnchor !== null) {
                this.anchors.set(keyAnchor, complexKey);
            }
            return { key: complexKey, isMerge: false };
        }

        const ch = this.src[this.pos];
        if (ch === '[' || ch === '{') {
            throw this.fail('YAML_INVALID_KEY', 'Non-string collection keys are forbidden in safe YAML');
        }

        let key;
        let isMerge = false;

        if (ch === '"') {
            key = this.parseDoubleQuotedScalar(-1);
        } else if (ch === "'") {
            key = this.parseSingleQuotedScalar(-1);
        } else if (ch === '*') {
            const aliasName = this.readAnchorOrAliasName('*');
            const resolved = this.resolveAlias(aliasName, depth);
            if (typeof resolved !== 'string') {
                throw this.fail('YAML_INVALID_KEY', 'Aliased YAML mapping key must resolve to a string');
            }
            key = resolved;
        } else {
            const start = this.pos;
            let colonPos = -1;
            while (this.pos < this.len && this.src[this.pos] !== '\n') {
                const curr = this.src[this.pos];
                if (curr === '#' && this.pos > start && isInlineWs(this.src[this.pos - 1])) {
                    break;
                }
                if (curr === ':' && isWhiteOrEnd(this.src[this.pos + 1])) {
                    colonPos = this.pos;
                    break;
                }
                this.advance(1);
            }
            if (colonPos === -1) {
                throw this.fail('YAML_PARSE_ERROR', 'Expected ":" after mapping key');
            }
            const rawKey = this.src.slice(start, colonPos).replace(/[ \t]+$/, '');
            if (rawKey === '') {
                throw this.fail('YAML_INVALID_KEY', 'Empty/null YAML mapping keys are forbidden');
            }
            if (rawKey === '<<') {
                isMerge = true;
                key = '<<';
            } else {
                const resolvedKey = resolvePlainScalar(rawKey);
                if (typeof resolvedKey !== 'string') {
                    throw this.fail(
                        'YAML_INVALID_KEY',
                        `Unquoted non-string YAML mapping key "${rawKey}" must be quoted`,
                        { key: rawKey }
                    );
                }
                key = resolvedKey;
            }
        }

        this.skipInlineSpacesAndComment();
        if (this.line !== keyStartLine || this.src[this.pos] !== ':' || !isWhiteOrEnd(this.src[this.pos + 1])) {
            throw this.fail('YAML_PARSE_ERROR', 'Expected ":" followed by whitespace on the same line after mapping key');
        }
        this.advance(1); // consume ':'

        if (keyAnchor !== null && !isMerge) {
            this.anchors.set(keyAnchor, key);
        }

        return { key, isMerge };
    }

    /**
     * Assemble a plain JS object from explicit entries and optional `<<` merge entries.
     *
     * @param {Array<{ isMerge: boolean, key: string, value: unknown }>} entries - Parsed mapping entries
     * @param {Set<string>} explicitKeys - Explicit keys declared on this mapping
     * @returns {Record<string, unknown>}
     */
    assembleMappingObject(entries, explicitKeys) {
        const out = {};
        const assignedKeys = new Set();

        for (let i = 0; i < entries.length; i += 1) {
            const entry = entries[i];
            if (!entry.isMerge) {
                defineSafeProperty(out, entry.key, entry.value);
                assignedKeys.add(entry.key);
                continue;
            }

            const mergeSources = [];
            if (isPlainObject(entry.value)) {
                mergeSources.push(entry.value);
            } else if (Array.isArray(entry.value)) {
                for (let j = 0; j < entry.value.length; j += 1) {
                    if (!isPlainObject(entry.value[j])) {
                        throw this.fail(
                            'YAML_PARSE_ERROR',
                            'YAML merge key "<<" sequence items must all be mapping objects'
                        );
                    }
                    mergeSources.push(entry.value[j]);
                }
            } else {
                throw this.fail(
                    'YAML_PARSE_ERROR',
                    'YAML merge key "<<" value must be a mapping or sequence of mappings'
                );
            }

            for (let m = 0; m < mergeSources.length; m += 1) {
                const srcObj = mergeSources[m];
                const srcKeys = Object.keys(srcObj);
                for (let k = 0; k < srcKeys.length; k += 1) {
                    const mk = srcKeys[k];
                    if (FORBIDDEN_KEYS.has(mk)) {
                        throw this.fail('YAML_FORBIDDEN_KEY', `Forbidden YAML mapping key "${mk}"`, {
                            key: mk,
                        });
                    }
                    if (!explicitKeys.has(mk) && !assignedKeys.has(mk)) {
                        defineSafeProperty(out, mk, srcObj[mk]);
                        assignedKeys.add(mk);
                    }
                }
            }
        }

        return out;
    }

    /**
     * Skip whitespace, newlines, and `#` comments inside flow collections (`[...]` / `{...}`).
     */
    skipFlowWhitespaceAndComments() {
        while (this.pos < this.len) {
            const ch = this.src[this.pos];
            if (ch === ' ' || ch === '\t') {
                this.advance(1);
                continue;
            }
            if (ch === '\n') {
                this.advance(1);
                if (this.isAtAnyDocumentMarker()) {
                    throw this.fail('YAML_PARSE_ERROR', 'Unterminated flow collection before document marker');
                }
                continue;
            }
            if (ch === '#') {
                while (this.pos < this.len && this.src[this.pos] !== '\n') {
                    this.advance(1);
                }
                continue;
            }
            break;
        }
    }

    /**
     * Parse a flow sequence (`[a, b, ...]`).
     *
     * @param {number} depth - Sequence container depth
     * @returns {unknown[]}
     */
    parseFlowSequence(depth) {
        this.checkDepth(depth);
        this.countNode();
        this.advance(1); // consume '['

        const items = [];
        this.skipFlowWhitespaceAndComments();
        if (this.src[this.pos] === ']') {
            this.advance(1);
            return items;
        }

        while (this.pos < this.len) {
            this.skipFlowWhitespaceAndComments();
            if (this.src[this.pos] === ']') {
                this.advance(1);
                return items;
            }
            if (this.src[this.pos] === ',') {
                throw this.fail('YAML_PARSE_ERROR', 'Empty flow sequence entry before "," is invalid YAML');
            }
            items.push(this.parseFlowNode(depth));
            this.skipFlowWhitespaceAndComments();
            const sep = this.src[this.pos];
            if (sep === ',') {
                this.advance(1);
                continue;
            }
            if (sep === ']') {
                this.advance(1);
                return items;
            }
            throw this.fail('YAML_PARSE_ERROR', 'Expected "," or "]" in YAML flow sequence');
        }

        throw this.fail('YAML_PARSE_ERROR', 'Unterminated YAML flow sequence "["');
    }

    /**
     * Parse a flow mapping (`{ a: 1, "b": 2 }`).
     *
     * @param {number} depth - Mapping container depth
     * @returns {Record<string, unknown>}
     */
    parseFlowMapping(depth) {
        this.checkDepth(depth);
        this.countNode();
        this.advance(1); // consume '{'

        const explicitEntries = [];
        const explicitKeys = new Set();
        let sawMergeKey = false;

        this.skipFlowWhitespaceAndComments();
        if (this.src[this.pos] === '}') {
            this.advance(1);
            return {};
        }

        while (this.pos < this.len) {
            this.skipFlowWhitespaceAndComments();
            if (this.src[this.pos] === '}') {
                this.advance(1);
                return this.assembleMappingObject(explicitEntries, explicitKeys);
            }
            if (this.src[this.pos] === ',') {
                throw this.fail('YAML_PARSE_ERROR', 'Empty flow mapping entry before "," is invalid YAML');
            }

            const keyInfo = this.readFlowMappingKey(depth);
            this.skipFlowWhitespaceAndComments();

            let val;
            if (this.src[this.pos] === ',' || this.src[this.pos] === '}') {
                this.countNode();
                val = null;
            } else {
                val = this.parseFlowNode(depth);
            }

            if (keyInfo.isMerge) {
                if (sawMergeKey) {
                    throw this.fail('YAML_DUPLICATE_KEY', 'Duplicate YAML merge key "<<" in mapping', {
                        key: '<<',
                    });
                }
                sawMergeKey = true;
                explicitEntries.push({ isMerge: true, key: '<<', value: val });
            } else {
                const { key } = keyInfo;
                if (FORBIDDEN_KEYS.has(key)) {
                    throw this.fail('YAML_FORBIDDEN_KEY', `Forbidden YAML mapping key "${key}"`, { key });
                }
                if (explicitKeys.has(key)) {
                    throw this.fail('YAML_DUPLICATE_KEY', `Duplicate YAML mapping key "${key}"`, { key });
                }
                explicitKeys.add(key);
                explicitEntries.push({ isMerge: false, key, value: val });
            }

            this.skipFlowWhitespaceAndComments();
            const sep = this.src[this.pos];
            if (sep === ',') {
                this.advance(1);
                continue;
            }
            if (sep === '}') {
                this.advance(1);
                return this.assembleMappingObject(explicitEntries, explicitKeys);
            }
            throw this.fail('YAML_PARSE_ERROR', 'Expected "," or "}" in YAML flow mapping');
        }

        throw this.fail('YAML_PARSE_ERROR', 'Unterminated YAML flow mapping "{"');
    }

    /**
     * Read and validate a mapping key inside `{ ... }`, supporting JSON-compatible `"key":value`.
     *
     * @param {number} depth - Current container depth
     * @returns {{ key: string, isMerge: boolean }}
     */
    readFlowMappingKey(depth) {
        if (
            this.src[this.pos] === '?' &&
            (isWhiteOrEnd(this.src[this.pos + 1]) || isFlowIndicator(this.src[this.pos + 1]))
        ) {
            this.advance(1); // consume '?'
            this.skipFlowWhitespaceAndComments();
            if (this.src[this.pos] === ':' || this.src[this.pos] === ',' || this.src[this.pos] === '}') {
                throw this.fail('YAML_INVALID_KEY', 'Empty/null YAML mapping keys are forbidden');
            }
            const complexKey = this.parseFlowNode(depth);
            if (typeof complexKey !== 'string') {
                throw this.fail('YAML_INVALID_KEY', 'Explicit "?" flow mapping key must resolve to a string');
            }
            this.skipFlowWhitespaceAndComments();
            if (this.src[this.pos] === ':') {
                const afterExplicitColon = this.src[this.pos + 1];
                if (!isWhiteOrEnd(afterExplicitColon) && !isFlowIndicator(afterExplicitColon)) {
                    throw this.fail(
                        'YAML_PARSE_ERROR',
                        'Flow mapping ":" must be followed by whitespace or delimiter'
                    );
                }
                this.advance(1); // consume ':'
            } else if (this.src[this.pos] !== ',' && this.src[this.pos] !== '}') {
                throw this.fail('YAML_PARSE_ERROR', 'Expected ":" after explicit "?" flow mapping key');
            }
            return { key: complexKey, isMerge: false };
        }

        if (this.src[this.pos] === '!') {
            throw this.fail('YAML_FORBIDDEN_TAG', 'Explicit YAML tags ("!") are forbidden on mapping keys');
        }

        const keyStartLine = this.line;
        let keyAnchor = null;
        if (this.src[this.pos] === '&') {
            keyAnchor = this.readAnchorOrAliasName('&');
            this.skipFlowWhitespaceAndComments();
            if (this.src[this.pos] === '!') {
                throw this.fail('YAML_FORBIDDEN_TAG', 'Explicit YAML tags ("!") are forbidden on mapping keys');
            }
        }

        const ch = this.src[this.pos];
        if (ch === '[' || ch === '{') {
            throw this.fail('YAML_INVALID_KEY', 'Non-string collection keys are forbidden in safe YAML');
        }
        if ((ch === '-' || ch === '?') && (isWhiteOrEnd(this.src[this.pos + 1]) || isFlowIndicator(this.src[this.pos + 1]))) {
            throw this.fail(
                'YAML_PARSE_ERROR',
                `YAML indicator "${ch}" followed by whitespace or flow delimiter cannot start a plain flow key`
            );
        }

        let key;
        let isMerge = false;
        let jsonStyleAdjacentAllowed = false;

        if (ch === '"') {
            key = this.parseDoubleQuotedScalar(-1);
            jsonStyleAdjacentAllowed = true;
        } else if (ch === "'") {
            key = this.parseSingleQuotedScalar(-1);
            jsonStyleAdjacentAllowed = true;
        } else if (ch === '*') {
            const aliasName = this.readAnchorOrAliasName('*');
            const resolved = this.resolveAlias(aliasName, depth);
            if (typeof resolved !== 'string') {
                throw this.fail('YAML_INVALID_KEY', 'Aliased YAML mapping key must resolve to a string');
            }
            key = resolved;
        } else {
            const rawKey = this.readPlainScalarLine(true).trim();
            if (rawKey === '') {
                throw this.fail('YAML_INVALID_KEY', 'Empty/null YAML mapping keys are forbidden');
            }
            if (rawKey === '<<') {
                isMerge = true;
                key = '<<';
            } else {
                const resolvedKey = resolvePlainScalar(rawKey);
                if (typeof resolvedKey !== 'string') {
                    throw this.fail(
                        'YAML_INVALID_KEY',
                        `Unquoted non-string YAML mapping key "${rawKey}" must be quoted`,
                        { key: rawKey }
                    );
                }
                key = resolvedKey;
            }
        }

        this.skipFlowWhitespaceAndComments();
        if (this.line !== keyStartLine || this.src[this.pos] !== ':') {
            throw this.fail('YAML_PARSE_ERROR', 'Expected ":" on the same line after implicit flow mapping key');
        }
        const afterColon = this.src[this.pos + 1];
        if (!jsonStyleAdjacentAllowed && !isWhiteOrEnd(afterColon) && !isFlowIndicator(afterColon)) {
            throw this.fail('YAML_PARSE_ERROR', 'Unquoted flow mapping ":" must be followed by whitespace or delimiter');
        }
        this.advance(1); // consume ':'

        if (keyAnchor !== null && !isMerge) {
            this.anchors.set(keyAnchor, key);
        }

        return { key, isMerge };
    }

    /**
     * Parse a value node inside a flow collection (`[...]` or `{...}`).
     *
     * @param {number} depth - Enclosing flow container depth
     * @returns {unknown}
     */
    parseFlowNode(depth) {
        this.skipFlowWhitespaceAndComments();
        if (this.src[this.pos] === '!') {
            throw this.fail('YAML_FORBIDDEN_TAG', 'Explicit YAML tags ("!") are forbidden');
        }

        let anchorName = null;
        if (this.src[this.pos] === '&') {
            anchorName = this.readAnchorOrAliasName('&');
            this.skipFlowWhitespaceAndComments();
            if (this.src[this.pos] === '!') {
                throw this.fail('YAML_FORBIDDEN_TAG', 'Explicit YAML tags ("!") are forbidden');
            }
            if (this.src[this.pos] === '&') {
                throw this.fail('YAML_PARSE_ERROR', 'Multiple anchors on a single YAML node are forbidden');
            }
        }

        if (anchorName !== null) {
            this.activeAnchors.add(anchorName);
        }

        try {
            let result;
            const ch = this.src[this.pos];
            if (ch === '[') {
                result = this.parseFlowSequence(depth + 1);
            } else if (ch === '{') {
                result = this.parseFlowMapping(depth + 1);
            } else if (ch === '"') {
                result = this.parseDoubleQuotedScalar(-1);
                this.countNode();
            } else if (ch === "'") {
                result = this.parseSingleQuotedScalar(-1);
                this.countNode();
            } else if (ch === '*') {
                const aliasName = this.readAnchorOrAliasName('*');
                result = this.resolveAlias(aliasName, depth);
            } else if (ch === '|' || ch === '>') {
                throw this.fail('YAML_PARSE_ERROR', 'Block scalars ("|" / ">") are not permitted inside flow collections');
            } else {
                const firstCh = this.src[this.pos];
                if (firstCh === '@' || firstCh === '`' || firstCh === '%') {
                    throw this.fail('YAML_PARSE_ERROR', `Reserved YAML indicator "${firstCh}" cannot start a plain scalar`);
                }
                if (
                    (firstCh === '-' || firstCh === '?' || firstCh === ':') &&
                    (isWhiteOrEnd(this.src[this.pos + 1]) || isFlowIndicator(this.src[this.pos + 1]))
                ) {
                    throw this.fail(
                        'YAML_PARSE_ERROR',
                        `YAML indicator "${firstCh}" followed by whitespace or flow delimiter cannot start a plain flow scalar`
                    );
                }
                const lines = [this.readPlainScalarLine(true)];
                while (!this.lastPlainStoppedAtComment && this.pos < this.len && this.src[this.pos] === '\n') {
                    this.advance(1);
                    if (this.isAtAnyDocumentMarker()) {
                        throw this.fail('YAML_PARSE_ERROR', 'Unterminated flow scalar before document marker');
                    }
                    let blankCount = 0;
                    while (this.pos < this.len) {
                        while (this.pos < this.len && isInlineWs(this.src[this.pos])) {
                            this.advance(1);
                        }
                        if (this.src[this.pos] === '\n') {
                            blankCount += 1;
                            this.advance(1);
                            continue;
                        }
                        break;
                    }
                    if (
                        this.pos >= this.len ||
                        isFlowIndicator(this.src[this.pos]) ||
                        this.src[this.pos] === '#' ||
                        (this.src[this.pos] === ':' &&
                            (isWhiteOrEnd(this.src[this.pos + 1]) || isFlowIndicator(this.src[this.pos + 1])))
                    ) {
                        break;
                    }
                    if (
                        (this.src[this.pos] === '-' || this.src[this.pos] === '?') &&
                        (isWhiteOrEnd(this.src[this.pos + 1]) || isFlowIndicator(this.src[this.pos + 1]))
                    ) {
                        throw this.fail(
                            'YAML_PARSE_ERROR',
                            `YAML indicator "${this.src[this.pos]}" cannot continue a plain flow scalar`
                        );
                    }
                    for (let b = 0; b < blankCount; b += 1) {
                        lines.push('');
                    }
                    lines.push(this.readPlainScalarLine(true));
                }
                const raw = foldFlowLines(lines).trim();
                this.countNode();
                result = resolvePlainScalar(raw);
            }

            if (anchorName !== null) {
                this.anchors.set(anchorName, result);
            }
            return result;
        } finally {
            if (anchorName !== null) {
                this.activeAnchors.delete(anchorName);
            }
        }
    }
}

// ============================================================================
// Safe YAML 1.2 Serializer
// ============================================================================

const AMBIGUOUS_SCALAR_KEYWORDS = new Set([
    'null',
    '~',
    'true',
    'false',
    'y',
    'n',
    'yes',
    'no',
    'on',
    'off',
    '.nan',
    '+.nan',
    '-.nan',
    '.inf',
    '+.inf',
    '-.inf',
]);

const LEADING_YAML_INDICATORS = new Set([
    '-',
    '?',
    ':',
    ',',
    '[',
    ']',
    '{',
    '}',
    '#',
    '&',
    '*',
    '!',
    '|',
    '>',
    "'",
    '"',
    '%',
    '@',
    '`',
    '~',
]);

/**
 * Encode a JavaScript string as a YAML 1.2 double-quoted literal.
 *
 * @param {string} str - Input string
 * @returns {string}
 */
function encodeDoubleQuotedYaml(str) {
    let out = '"';
    for (let i = 0; i < str.length; i += 1) {
        const code = str.charCodeAt(i);
        switch (code) {
            case 0x22:
                out += '\\"';
                break;
            case 0x5c:
                out += '\\\\';
                break;
            case 0x00:
                out += '\\0';
                break;
            case 0x08:
                out += '\\b';
                break;
            case 0x09:
                out += '\\t';
                break;
            case 0x0a:
                out += '\\n';
                break;
            case 0x0b:
                out += '\\v';
                break;
            case 0x0c:
                out += '\\f';
                break;
            case 0x0d:
                out += '\\r';
                break;
            default: {
                if (code >= 0xd800 && code <= 0xdbff) {
                    const next = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
                    if (next >= 0xdc00 && next <= 0xdfff) {
                        out += str.slice(i, i + 2);
                        i += 1;
                    } else {
                        throw new YamlSignalError(
                            'YAML_STRINGIFY_ERROR',
                            'String containing lone UTF-16 surrogates cannot be serialized to safe YAML'
                        );
                    }
                } else if (code >= 0xdc00 && code <= 0xdfff) {
                    throw new YamlSignalError(
                        'YAML_STRINGIFY_ERROR',
                        'String containing lone UTF-16 surrogates cannot be serialized to safe YAML'
                    );
                } else if (
                    code < 0x20 ||
                    (code >= 0x7f && code <= 0x9f) ||
                    code === 0xa0 ||
                    code === 0x2028 ||
                    code === 0x2029 ||
                    code === 0xfeff ||
                    code === 0xfffe ||
                    code === 0xffff
                ) {
                    out += `\\u${code.toString(16).padStart(4, '0')}`;
                } else {
                    out += str[i];
                }
            }
        }
    }
    return `${out}"`;
}

/**
 * Determine whether `str` can be emitted safely as an unquoted YAML 1.2 plain scalar.
 *
 * @param {string} str - Candidate string
 * @param {boolean} isKey - Whether formatting a mapping key
 * @returns {boolean}
 */
function canEmitUnquotedYamlString(str, isKey) {
    const maxLen = isKey ? 256 : 512;
    if (str.length === 0 || str.length > maxLen) return false;
    if (str[0] === ' ' || str[str.length - 1] === ' ') return false;
    if (LEADING_YAML_INDICATORS.has(str[0])) return false;
    if (str.startsWith('---') || str.startsWith('...') || str === '<<') return false;
    if (AMBIGUOUS_SCALAR_KEYWORDS.has(str.toLowerCase())) return false;
    if (/^[+-]?(?:\d|\.\d)/.test(str)) return false;
    if (str.endsWith(':')) return false;

    for (let i = 0; i < str.length; i += 1) {
        const code = str.charCodeAt(i);
        if (
            code < 0x20 ||
            (code >= 0x7f && code <= 0x9f) ||
            code === 0xa0 ||
            code === 0x2028 ||
            code === 0x2029 ||
            code === 0xfeff ||
            code === 0xfffe ||
            code === 0xffff ||
            (code >= 0xd800 && code <= 0xdfff)
        ) {
            return false;
        }
        const ch = str[i];
        if (ch === ',' || ch === '[' || ch === ']' || ch === '{' || ch === '}' || ch === '"' || ch === "'") {
            return false;
        }
        if (isKey && ch === ':') {
            return false;
        }
        if (ch === ':' && str[i + 1] === ' ') {
            return false;
        }
        if (ch === '#' && i > 0 && str[i - 1] === ' ') {
            return false;
        }
    }
    return true;
}

/**
 * Format a scalar JSON/YAML primitive (`null`, `boolean`, `number`, `string`).
 *
 * @param {unknown} val - Scalar value
 * @returns {string}
 */
function formatYamlScalarValue(val) {
    if (val === null) return 'null';
    const valType = typeof val;
    if (valType === 'boolean') return val ? 'true' : 'false';
    if (valType === 'number') {
        if (!Number.isFinite(val)) {
            throw new YamlSignalError(
                'YAML_STRINGIFY_ERROR',
                `Cannot serialize non-finite number "${String(val)}" to safe YAML`
            );
        }
        if (Object.is(val, -0)) return '0';
        if (Number.isInteger(val) && !Number.isSafeInteger(val)) {
            return val.toExponential();
        }
        return String(val);
    }
    if (valType === 'string') {
        return canEmitUnquotedYamlString(val, false) ? val : encodeDoubleQuotedYaml(val);
    }
    throw new YamlSignalError(
        'YAML_STRINGIFY_ERROR',
        `Unsupported JavaScript type "${valType}" in safe YAML serializer`
    );
}

/**
 * Recursively serialize a validated JavaScript value into YAML 1.2 block lines.
 *
 * @param {unknown} val - Value to serialize
 * @param {number} depth - Current container depth
 * @param {number} indentSpaces - Current indentation column
 * @param {{ indent: number, sortKeys: boolean, maxDepth: number }} cfg - Serializer options
 * @param {Set<object>} ancestors - Active ancestor reference set for cycle detection
 * @returns {string}
 */
function serializeYamlNode(val, depth, indentSpaces, cfg, ancestors) {
    if (val === null || typeof val !== 'object') {
        return `${' '.repeat(indentSpaces)}${formatYamlScalarValue(val)}`;
    }

    if (Object.getOwnPropertySymbols(val).some((sym) => Object.prototype.propertyIsEnumerable.call(val, sym))) {
        throw new YamlSignalError('YAML_STRINGIFY_ERROR', 'Symbol-keyed properties cannot be serialized to YAML');
    }

    if (!Array.isArray(val) && !isPlainObject(val)) {
        throw new YamlSignalError(
            'YAML_STRINGIFY_ERROR',
            `Unsupported object instance "${Object.prototype.toString.call(val)}" in safe YAML serializer`
        );
    }

    if (ancestors.has(val)) {
        throw new YamlSignalError('YAML_STRINGIFY_ERROR', 'Circular reference detected while serializing YAML');
    }

    const nextDepth = depth + 1;
    if (nextDepth > cfg.maxDepth) {
        throw new YamlSignalError(
            'YAML_STRINGIFY_ERROR',
            `YAML serialization exceeds maximum depth of ${cfg.maxDepth}`,
            { maxDepth: cfg.maxDepth }
        );
    }

    const pad = ' '.repeat(indentSpaces);

    if (Array.isArray(val)) {
        if (val.length === 0) {
            return `${pad}[]`;
        }
        ancestors.add(val);
        try {
            const lines = [];
            for (let i = 0; i < val.length; i += 1) {
                const item = val[i];
                if (item === undefined) {
                    throw new YamlSignalError(
                        'YAML_STRINGIFY_ERROR',
                        `Cannot serialize "undefined" array element at index ${i}`
                    );
                }
                if (item === null || typeof item !== 'object') {
                    lines.push(`${pad}- ${formatYamlScalarValue(item)}`);
                } else if (Array.isArray(item) && item.length === 0) {
                    lines.push(`${pad}- []`);
                } else if (isPlainObject(item) && getDefinedObjectKeys(item, cfg.sortKeys).length === 0) {
                    lines.push(`${pad}- {}`);
                } else {
                    const nested = serializeYamlNode(item, nextDepth, indentSpaces + cfg.indent, cfg, ancestors);
                    lines.push(`${pad}-\n${nested}`);
                }
            }
            return lines.join('\n');
        } finally {
            ancestors.delete(val);
        }
    }

    const keys = getDefinedObjectKeys(val, cfg.sortKeys);
    if (keys.length === 0) {
        return `${pad}{}`;
    }

    ancestors.add(val);
    try {
        const lines = [];
        for (let i = 0; i < keys.length; i += 1) {
            const key = keys[i];
            const propVal = val[key];
            const formattedKey = canEmitUnquotedYamlString(key, true) ? key : encodeDoubleQuotedYaml(key);

            if (propVal === null || typeof propVal !== 'object') {
                lines.push(`${pad}${formattedKey}: ${formatYamlScalarValue(propVal)}`);
            } else if (Array.isArray(propVal) && propVal.length === 0) {
                lines.push(`${pad}${formattedKey}: []`);
            } else if (isPlainObject(propVal) && getDefinedObjectKeys(propVal, cfg.sortKeys).length === 0) {
                lines.push(`${pad}${formattedKey}: {}`);
            } else {
                const nested = serializeYamlNode(propVal, nextDepth, indentSpaces + cfg.indent, cfg, ancestors);
                lines.push(`${pad}${formattedKey}:\n${nested}`);
            }
        }
        return lines.join('\n');
    } finally {
        ancestors.delete(val);
    }
}

/**
 * Collect own enumerable string keys whose values are not `undefined`, rejecting forbidden prototype keys.
 *
 * @param {Record<string, unknown>} obj - Plain object
 * @param {boolean} sortKeys - Whether to sort keys lexicographically
 * @returns {string[]}
 */
function getDefinedObjectKeys(obj, sortKeys) {
    const rawKeys = Object.keys(obj);
    const filtered = [];
    for (let i = 0; i < rawKeys.length; i += 1) {
        const key = rawKeys[i];
        if (FORBIDDEN_KEYS.has(key)) {
            throw new YamlSignalError('YAML_FORBIDDEN_KEY', `Forbidden YAML mapping key "${key}"`, { key });
        }
        if (obj[key] !== undefined) {
            filtered.push(key);
        }
    }
    if (sortKeys) {
        filtered.sort();
    }
    return filtered;
}

// ============================================================================
// Internal Parse Core & Exported API (`INV-LEGO-23`)
// ============================================================================

/**
 * Shared internal parser returning raw UTF-8 bytes alongside parsed YAML value and telemetry.
 *
 * @param {unknown} input - Caller input
 * @param {unknown} options - Caller options
 * @param {string} defaultTool - Default tool name
 * @returns {{ ok: true, tool: string, value: unknown, rawBytes: Uint8Array, byteLength: number, nodeCount: number, aliasCount: number } | { ok: false, envelope: any }}
 */
function parseSafeYamlInternal(input, options, defaultTool) {
    const optRes = normalizeParseOptions(options, defaultTool);
    if (!optRes.ok) {
        return optRes;
    }
    const cfg = optRes.config;

    const decoded = decodeYamlInput(input, cfg.maxBytes, cfg.tool);
    if (!decoded.ok) {
        return decoded;
    }

    const parser = new YamlCoreParser(decoded.text, cfg);
    try {
        const value = parser.parseStream();
        return {
            ok: true,
            tool: cfg.tool,
            value,
            rawBytes: decoded.rawBytes,
            byteLength: decoded.rawBytes.byteLength,
            nodeCount: parser.nodeCount,
            aliasCount: parser.aliasCount,
        };
    } catch (err) {
        if (err instanceof YamlSignalError) {
            return {
                ok: false,
                envelope: yamlErrorEnvelope(err.code, err.message, err.details, cfg.tool),
            };
        }
        const message = err instanceof Error ? err.message : 'Failed to parse YAML payload';
        return {
            ok: false,
            envelope: yamlErrorEnvelope('YAML_PARSE_ERROR', message, null, cfg.tool),
        };
    }
}

/**
 * Parse untrusted YAML 1.2 Core text or UTF-8 bytes with strict security & resource ceilings.
 *
 * @param {string | Uint8Array | ArrayBuffer} input - Raw YAML text or UTF-8 byte buffer
 * @param {object} [options={}] - Parser ceilings and stream options
 * @param {number} [options.maxBytes=1048576] - Maximum input UTF-8 byte length
 * @param {number} [options.maxDepth=32] - Maximum container nesting depth
 * @param {number} [options.maxNodes=10000] - Maximum constructed node count
 * @param {number} [options.maxAliases=64] - Maximum alias dereferences
 * @param {number} [options.maxAliasExpansionNodes=1000] - Maximum cumulative cloned alias nodes
 * @param {boolean} [options.allowMultipleDocuments=false] - Allow multi-document YAML streams
 * @param {string} [options.tool='yaml.parse'] - `INV-LEGO-01` tool identifier
 * @returns {{ ok: true, tool: string, summary: string, data: { value: any, byteLength: number, nodeCount: number, aliasCount: number } } | { ok: false, tool: string, summary: string, error: { code: string, message: string, details?: any } }}
 */
export function parseSafeYaml(input, options = {}) {
    try {
        const res = parseSafeYamlInternal(input, options, 'yaml.parse');
        if (!res.ok) {
            return res.envelope;
        }
        return yamlOkEnvelope(res.tool, 'Parsed safe YAML payload', {
            value: res.value,
            byteLength: res.byteLength,
            nodeCount: res.nodeCount,
            aliasCount: res.aliasCount,
        });
    } catch (err) {
        const fallbackTool = peekToolName(options, 'yaml.parse');
        if (err instanceof YamlSignalError) {
            return yamlErrorEnvelope(err.code, err.message, err.details, fallbackTool);
        }
        const message = err instanceof Error ? err.message : 'Failed to parse YAML payload';
        return yamlErrorEnvelope('YAML_PARSE_ERROR', message, null, fallbackTool);
    }
}

/**
 * Serialize a plain JSON-compatible JavaScript value into deterministic YAML 1.2 text.
 *
 * @param {unknown} value - Plain value to serialize
 * @param {object} [options={}] - Serializer options
 * @param {number} [options.indent=2] - Indentation width (`1..8` spaces)
 * @param {boolean} [options.sortKeys=true] - Sort object keys lexicographically
 * @param {number} [options.maxDepth=32] - Maximum container nesting depth
 * @param {string} [options.tool='yaml.stringify'] - `INV-LEGO-01` tool identifier
 * @returns {{ ok: true, tool: string, summary: string, data: { yaml: string } } | { ok: false, tool: string, summary: string, error: { code: string, message: string, details?: any } }}
 */
export function stringifySafeYaml(value, options = {}) {
    const fallbackTool = peekToolName(options, 'yaml.stringify');
    let tool = fallbackTool;
    let indent;
    let sortKeys;
    let maxDepth;

    try {
        if (options !== undefined && !isPlainObject(options)) {
            return yamlErrorEnvelope(
                'YAML_INVALID_OPTIONS',
                'YAML stringify options must be a plain object',
                null,
                fallbackTool
            );
        }
        const opts = options || {};
        const rawTool = opts.tool;
        if (rawTool !== undefined && (typeof rawTool !== 'string' || rawTool.trim().length === 0)) {
            return yamlErrorEnvelope(
                'YAML_INVALID_OPTIONS',
                'Option "tool" must be a non-empty string',
                null,
                'yaml.stringify'
            );
        }
        tool = rawTool || 'yaml.stringify';
        const rawIndent = opts.indent;
        const rawSortKeys = opts.sortKeys;
        const rawMaxDepth = opts.maxDepth;
        indent = rawIndent !== undefined ? rawIndent : 2;
        sortKeys = rawSortKeys !== undefined ? rawSortKeys : true;
        maxDepth = rawMaxDepth !== undefined ? rawMaxDepth : DEFAULT_YAML_LIMITS.maxDepth;
    } catch (err) {
        return yamlErrorEnvelope(
            'YAML_INVALID_OPTIONS',
            err instanceof Error ? err.message : 'Invalid YAML stringify options',
            null,
            fallbackTool
        );
    }

    if (!isBoundedInteger(indent, 1) || indent > 8) {
        return yamlErrorEnvelope(
            'YAML_INVALID_OPTIONS',
            'Option "indent" must be an integer between 1 and 8',
            { option: 'indent', value: indent },
            tool
        );
    }
    if (typeof sortKeys !== 'boolean') {
        return yamlErrorEnvelope(
            'YAML_INVALID_OPTIONS',
            'Option "sortKeys" must be a boolean',
            { option: 'sortKeys', value: sortKeys },
            tool
        );
    }
    if (!isBoundedInteger(maxDepth, 1)) {
        return yamlErrorEnvelope(
            'YAML_INVALID_OPTIONS',
            'Option "maxDepth" must be a positive integer',
            { option: 'maxDepth', value: maxDepth },
            tool
        );
    }
    if (value === undefined) {
        return yamlErrorEnvelope(
            'YAML_STRINGIFY_ERROR',
            'Cannot serialize root "undefined" value to YAML',
            null,
            tool
        );
    }

    try {
        const ancestors = new Set();
        const body = serializeYamlNode(value, 0, 0, { indent, sortKeys, maxDepth }, ancestors);
        return yamlOkEnvelope(tool, 'Serialized safe YAML payload', {
            yaml: `${body}\n`,
        });
    } catch (err) {
        if (err instanceof YamlSignalError) {
            return yamlErrorEnvelope(err.code, err.message, err.details, tool);
        }
        const message = err instanceof Error ? err.message : 'Failed to serialize YAML payload';
        return yamlErrorEnvelope('YAML_STRINGIFY_ERROR', message, null, tool);
    }
}

/**
 * Parse untrusted YAML and validate the resulting data structure against a schema.
 *
 * @param {string | Uint8Array | ArrayBuffer} input - Raw YAML text or UTF-8 bytes
 * @param {object} schema - `@krusch/toolkit/schema` node, Zod-like schema, or JSON Schema object
 * @param {object} [options={}] - Combined parser and schema validation options
 * @returns {{ ok: true, tool: string, summary: string, data: { value: any, byteLength: number, nodeCount: number } } | { ok: false, tool: string, summary: string, error: { code: string, message: string, details?: any } }}
 */
export function validateYamlConfig(input, schema, options = {}) {
    const fallbackTool = peekToolName(options, 'yaml.validate');
    try {
        const res = parseSafeYamlInternal(input, options, 'yaml.validate');
        if (!res.ok) {
            return res.envelope;
        }

        const opts = options || {};
        let coerceOpt;
        let stripUnknownOpt;
        let maxDepthOpt;
        try {
            coerceOpt = opts.coerce;
            stripUnknownOpt = opts.stripUnknown;
            maxDepthOpt = opts.maxDepth;
        } catch (err) {
            return yamlErrorEnvelope(
                'YAML_INVALID_OPTIONS',
                err instanceof Error ? err.message : 'Invalid YAML validation options',
                null,
                res.tool
            );
        }

        const validated = validateSchema(schema, res.value, {
            ...(coerceOpt !== undefined ? { coerce: coerceOpt } : {}),
            ...(stripUnknownOpt !== undefined ? { stripUnknown: stripUnknownOpt } : {}),
            maxDepth: maxDepthOpt !== undefined ? maxDepthOpt : DEFAULT_YAML_LIMITS.maxDepth,
            tool: res.tool,
        });
        if (!validated.ok) {
            return validated;
        }

        return yamlOkEnvelope(res.tool, 'Validated safe YAML configuration', {
            value: validated.data,
            byteLength: res.byteLength,
            nodeCount: res.nodeCount,
        });
    } catch (err) {
        if (err instanceof YamlSignalError) {
            return yamlErrorEnvelope(err.code, err.message, err.details, fallbackTool);
        }
        const message = err instanceof Error ? err.message : 'Failed to validate YAML configuration';
        return yamlErrorEnvelope('YAML_VALIDATION_ERROR', message, null, fallbackTool);
    }
}

/**
 * Load a plain-object YAML authority pack with required-key verification, optional schema validation,
 * and synchronous SHA-256 content addressing over raw UTF-8 input bytes.
 *
 * @param {string | Uint8Array | ArrayBuffer} input - Raw YAML pack text or UTF-8 bytes
 * @param {object} [options={}] - Authority-pack loader options
 * @param {string[]} [options.requiredKeys] - Required top-level keys
 * @param {object|null} [options.schema] - Optional validation schema
 * @returns {{ ok: true, tool: string, summary: string, data: { pack: Record<string, any>, sha256: string, byteLength: number, nodeCount: number } } | { ok: false, tool: string, summary: string, error: { code: string, message: string, details?: any } }}
 */
export function loadSafeYamlPack(input, options = {}) {
    const fallbackTool = peekToolName(options, 'yaml.pack');
    let tool = fallbackTool;
    try {
        if (options !== undefined && !isPlainObject(options)) {
            return yamlErrorEnvelope(
                'YAML_INVALID_OPTIONS',
                'YAML pack options must be a plain object',
                null,
                fallbackTool
            );
        }
        const opts = options || {};
        let rawTool;
        let requiredKeysOpt;
        let schemaOpt;
        let coerceOpt;
        let stripUnknownOpt;
        let parseOpts;
        try {
            rawTool = opts.tool;
            if (rawTool !== undefined && (typeof rawTool !== 'string' || rawTool.trim().length === 0)) {
                return yamlErrorEnvelope(
                    'YAML_INVALID_OPTIONS',
                    'Option "tool" must be a non-empty string',
                    null,
                    'yaml.pack'
                );
            }
            tool = rawTool || 'yaml.pack';
            requiredKeysOpt = opts.requiredKeys;
            schemaOpt = opts.schema;
            coerceOpt = opts.coerce;
            stripUnknownOpt = opts.stripUnknown;
            parseOpts = {
                maxBytes: opts.maxBytes,
                maxDepth: opts.maxDepth,
                maxNodes: opts.maxNodes,
                maxAliases: opts.maxAliases,
                maxAliasExpansionNodes: opts.maxAliasExpansionNodes,
                allowMultipleDocuments: opts.allowMultipleDocuments,
                tool,
            };
        } catch (err) {
            return yamlErrorEnvelope(
                'YAML_INVALID_OPTIONS',
                err instanceof Error ? err.message : 'Invalid YAML pack options',
                null,
                tool
            );
        }

        if (requiredKeysOpt !== undefined) {
            if (
                !Array.isArray(requiredKeysOpt) ||
                !requiredKeysOpt.every((key) => typeof key === 'string' && key.length > 0)
            ) {
                return yamlErrorEnvelope(
                    'YAML_INVALID_OPTIONS',
                    'Option "requiredKeys" must be an array of non-empty strings',
                    { option: 'requiredKeys' },
                    tool
                );
            }
        }

        const parsed = parseSafeYamlInternal(input, parseOpts, 'yaml.pack');
        if (!parsed.ok) {
            return parsed.envelope;
        }

        if (!isPlainObject(parsed.value)) {
            return yamlErrorEnvelope(
                'YAML_INVALID_PACK',
                'YAML pack root must be a mapping object',
                {
                    receivedType:
                        parsed.value === null
                            ? 'null'
                            : Array.isArray(parsed.value)
                              ? 'array'
                              : typeof parsed.value,
                },
                tool
            );
        }

        let pack = parsed.value;

        if (requiredKeysOpt && requiredKeysOpt.length > 0) {
            const missingKeys = requiredKeysOpt.filter((key) => !hasOwn(pack, key) || pack[key] === undefined);
            if (missingKeys.length > 0) {
                return yamlErrorEnvelope(
                    'YAML_MISSING_REQUIRED_KEYS',
                    `YAML pack is missing required keys: ${missingKeys.join(', ')}`,
                    { missingKeys },
                    tool
                );
            }
        }

        if (schemaOpt !== undefined && schemaOpt !== null) {
            const validated = validateSchema(schemaOpt, pack, {
                ...(coerceOpt !== undefined ? { coerce: coerceOpt } : {}),
                ...(stripUnknownOpt !== undefined ? { stripUnknown: stripUnknownOpt } : {}),
                maxDepth: parseOpts.maxDepth !== undefined ? parseOpts.maxDepth : DEFAULT_YAML_LIMITS.maxDepth,
                tool,
            });
            if (!validated.ok) {
                return validated;
            }
            if (!isPlainObject(validated.data)) {
                return yamlErrorEnvelope(
                    'YAML_INVALID_PACK',
                    'Validated YAML pack must remain a mapping object',
                    null,
                    tool
                );
            }
            pack = validated.data;
        }

        const sha256 = sha256HexBytes(parsed.rawBytes);
        return yamlOkEnvelope(tool, 'Loaded safe YAML pack', {
            pack,
            sha256,
            byteLength: parsed.byteLength,
            nodeCount: parsed.nodeCount,
        });
    } catch (err) {
        if (err instanceof YamlSignalError) {
            return yamlErrorEnvelope(err.code, err.message, err.details, tool);
        }
        const message = err instanceof Error ? err.message : 'Failed to load YAML pack';
        return yamlErrorEnvelope('YAML_INVALID_PACK', message, null, tool);
    }
}
