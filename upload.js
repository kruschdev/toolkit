/**
 * @module upload
 * @description Byte-bounded `multipart/form-data` parser, path-traversal/bidi/device-safe
 * filename sanitizer, and magic-byte MIME verifier (`INV-LEGO-01`, `INV-LEGO-18`) for `@krusch/toolkit`.
 * Zero third-party dependencies; linear O(N) `Buffer.indexOf` framing scan.
 */

import { okEnvelope, errorEnvelope } from './http.js';

const DEFAULT_FALLBACK_FILENAME = 'upload.bin';
const DEFAULT_MAX_FILENAME_LENGTH = 128;
const MIN_FILENAME_LENGTH = 1;
const MAX_PRESERVED_EXT_LENGTH = 16;

const DEFAULT_MAX_TOTAL_BYTES = 10_485_760; // 10 MiB
const DEFAULT_MAX_FILE_BYTES = 5_242_880; // 5 MiB
const DEFAULT_MAX_FILES = 5;
const DEFAULT_MAX_FIELDS = 32;
const DEFAULT_MAX_FIELD_BYTES = 65_536; // 64 KiB
const MAX_PART_HEADER_BYTES = 16_384; // 16 KiB

const CRLF_BYTES = Buffer.from('\r\n', 'ascii');
const DOUBLE_CRLF_BYTES = Buffer.from('\r\n\r\n', 'ascii');

const UNSAFE_FILENAME_CHARS_RE = /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069\ufeff<>:"|?*]+/g;
const LEADING_UNSAFE_RE = /^[.\s-]+/;
const TRAILING_UNSAFE_RE = /[.\s]+$/;
const WINDOWS_RESERVED_STEM_RE = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
const VALID_BOUNDARY_CHARS_RE = /^[A-Za-z0-9'()+_,\-./:=?!#$%&*^`{|}~ ]+$/;

const FORBIDDEN_FIELD_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

const MIME_ALIASES = new Map([
    ['image/jpg', 'image/jpeg'],
    ['image/pjpeg', 'image/jpeg'],
    ['audio/wave', 'audio/wav'],
    ['audio/x-wav', 'audio/wav'],
    ['audio/vnd.wave', 'audio/wav'],
    ['audio/mp3', 'audio/mpeg'],
    ['audio/x-mp3', 'audio/mpeg'],
    ['audio/mpeg3', 'audio/mpeg'],
    ['audio/x-mpeg-3', 'audio/mpeg'],
    ['audio/x-ogg', 'audio/ogg'],
    ['application/ogg', 'audio/ogg'],
    ['application/x-zip-compressed', 'application/zip'],
    ['application/x-pdf', 'application/pdf'],
]);

const MAGIC_REQUIRED_MIMES = new Set([
    'application/pdf',
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'audio/wav',
    'audio/mpeg',
    'audio/ogg',
    'audio/webm',
    'video/webm',
    'application/zip',
]);

/**
 * Convert a `Uint8Array`, `Buffer`, or `ArrayBuffer` into a `Uint8Array` view, or `null` otherwise.
 *
 * @param {unknown} bytes - Candidate binary input
 * @returns {Uint8Array|null}
 */
function toByteView(bytes) {
    if (bytes instanceof Uint8Array) {
        return bytes;
    }
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(bytes)) {
        return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }
    if (
        bytes instanceof ArrayBuffer ||
        Object.prototype.toString.call(bytes) === '[object ArrayBuffer]'
    ) {
        return new Uint8Array(bytes);
    }
    return null;
}

/**
 * Normalize a raw MIME string by stripping parameters and mapping common aliases to canonical types.
 *
 * @param {unknown} rawMime - Declared or pattern MIME string
 * @returns {string}
 */
function canonicalizeMime(rawMime) {
    const base = String(rawMime ?? '')
        .split(';')[0]
        .trim()
        .toLowerCase();
    if (!base) return '';
    return MIME_ALIASES.get(base) || base;
}

/**
 * Determine whether a declared MIME type and magic-sniffed MIME type represent compatible formats.
 *
 * @param {string} declared - Lowercased base declared MIME
 * @param {string} detected - Magic-sniffed canonical MIME
 * @returns {boolean}
 */
function areMimesEquivalent(declared, detected) {
    if (!declared || !detected) return false;
    const canonDeclared = canonicalizeMime(declared);
    const canonDetected = canonicalizeMime(detected);
    if (canonDeclared === canonDetected) return true;
    if (
        (canonDeclared === 'audio/webm' && canonDetected === 'video/webm') ||
        (canonDeclared === 'video/webm' && canonDetected === 'audio/webm')
    ) {
        return true;
    }
    return false;
}

/**
 * Determine whether a filename or stem resolves to a Windows reserved DOS device name
 * (`CON`, `PRN`, `AUX`, `NUL`, `COM1..9`, `LPT1..9`), including multi-dot stems (`CON.a`)
 * and trailing spaces/dots.
 *
 * @param {string} name - Candidate stem or filename
 * @returns {boolean}
 */
function isWindowsReservedFilenameStem(name) {
    if (!name) return false;
    const trimmed = name.replace(TRAILING_UNSAFE_RE, '');
    if (!trimmed) return false;
    const firstDotSegment = trimmed.split('.')[0].replace(TRAILING_UNSAFE_RE, '');
    return WINDOWS_RESERVED_STEM_RE.test(trimmed) || WINDOWS_RESERVED_STEM_RE.test(firstDotSegment);
}

/**
 * Core single-pass filename sanitizer without fallback recursion.
 *
 * @param {string} candidate - Candidate raw filename
 * @param {number} safeMaxLen - Clamped maximum length (`>= 8`)
 * @returns {string} Sanitized filename or `''` if empty/invalid
 */
function sanitizeFilenameCore(candidate, safeMaxLen) {
    if (typeof candidate !== 'string' || candidate.length === 0) return '';

    const slashNormalized = candidate.replace(/\\/g, '/');
    const lastSlash = slashNormalized.lastIndexOf('/');
    const baseSegment = lastSlash >= 0 ? slashNormalized.slice(lastSlash + 1) : slashNormalized;
    if (!baseSegment) return '';

    let cleaned = baseSegment
        .replace(UNSAFE_FILENAME_CHARS_RE, '')
        .replace(LEADING_UNSAFE_RE, '')
        .replace(TRAILING_UNSAFE_RE, '')
        .replace(/\s+/g, '_')
        .replace(LEADING_UNSAFE_RE, '')
        .replace(TRAILING_UNSAFE_RE, '');

    if (!cleaned) return '';

    const lastDot = cleaned.lastIndexOf('.');
    let stem = lastDot > 0 ? cleaned.slice(0, lastDot) : cleaned;
    const ext = lastDot > 0 ? cleaned.slice(lastDot) : '';

    if (!stem) return '';

    if (isWindowsReservedFilenameStem(stem)) {
        stem = `_${stem}`;
    }

    const reassembled = `${stem}${ext}`;
    if (reassembled.length <= safeMaxLen) {
        return reassembled;
    }

    if (
        ext.length > 1 &&
        ext.length <= MAX_PRESERVED_EXT_LENGTH &&
        safeMaxLen - ext.length >= 1
    ) {
        const stemBudget = safeMaxLen - ext.length;
        let truncatedStem = stem.slice(0, stemBudget).replace(TRAILING_UNSAFE_RE, '');
        if (!truncatedStem) return '';
        if (isWindowsReservedFilenameStem(truncatedStem)) {
            if (stemBudget <= 1) return '';
            const shorterStem = stem.slice(0, stemBudget - 1).replace(TRAILING_UNSAFE_RE, '');
            if (!shorterStem) return '';
            truncatedStem = `_${shorterStem}`;
        }
        return `${truncatedStem}${ext}`;
    }

    let truncated = reassembled.slice(0, safeMaxLen).replace(TRAILING_UNSAFE_RE, '');
    if (!truncated) return '';
    if (isWindowsReservedFilenameStem(truncated)) {
        if (safeMaxLen < 2) return '';
        const shorter = reassembled.slice(0, safeMaxLen - 1).replace(TRAILING_UNSAFE_RE, '');
        if (!shorter) return '';
        truncated = `_${shorter}`;
    }
    return truncated;
}

const UNSAFE_FILENAME_CHAR_SINGLE_RE = /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069\ufeff<>:"|?*]/;

/**
 * Validate and normalize a caller-supplied fallback filename, returning `''` if empty or unsafe.
 *
 * @param {unknown} rawFallback - Caller fallback option
 * @param {number} safeMaxLen - Clamped maximum length
 * @returns {string}
 */
function resolveSafeFallback(rawFallback, safeMaxLen) {
    if (typeof rawFallback !== 'string' || rawFallback.length === 0) return '';
    if (/[\/\\]/.test(rawFallback)) return '';
    if (UNSAFE_FILENAME_CHAR_SINGLE_RE.test(rawFallback)) return '';
    if (LEADING_UNSAFE_RE.test(rawFallback)) return '';
    const trimmed = rawFallback.replace(TRAILING_UNSAFE_RE, '');
    if (!trimmed) return '';
    if (isWindowsReservedFilenameStem(trimmed)) return '';
    return sanitizeFilenameCore(rawFallback, safeMaxLen);
}

/**
 * Sanitize an untrusted upload filename against directory traversal, NUL/control/bidi characters,
 * dotfiles, Windows reserved device names, and excessive lengths (`INV-LEGO-18`).
 *
 * @param {string} [rawFilename=''] - Raw untrusted filename
 * @param {object} [options={}] - Sanitizer options
 * @param {string} [options.fallback='upload.bin'] - Fallback filename when input is empty or unsafe
 * @param {number} [options.maxLength=128] - Maximum output length (`>= 1`)
 * @returns {string}
 */
export function sanitizeUploadFilename(
    rawFilename = '',
    options = {}
) {
    const opts = options && typeof options === 'object' ? options : {};
    const safeMaxLen =
        typeof opts.maxLength === 'number' &&
        Number.isFinite(opts.maxLength) &&
        Math.trunc(opts.maxLength) >= MIN_FILENAME_LENGTH
            ? Math.trunc(opts.maxLength)
            : DEFAULT_MAX_FILENAME_LENGTH;

    const rawFallback = opts.fallback === undefined ? DEFAULT_FALLBACK_FILENAME : opts.fallback;
    const safeFallback =
        resolveSafeFallback(rawFallback, safeMaxLen) ||
        sanitizeFilenameCore(DEFAULT_FALLBACK_FILENAME, safeMaxLen) ||
        'u'.slice(0, safeMaxLen);

    const sanitized = sanitizeFilenameCore(rawFilename, safeMaxLen);
    return sanitized || safeFallback;
}

/**
 * Inspect leading magic bytes of a binary buffer to identify canonical file MIME types (`INV-LEGO-18`).
 *
 * @param {Uint8Array|Buffer|ArrayBuffer} bytes - Input byte buffer
 * @returns {'application/pdf'|'image/png'|'image/jpeg'|'image/gif'|'image/webp'|'audio/wav'|'audio/mpeg'|'audio/ogg'|'video/webm'|'application/zip'|null}
 */
export function sniffMimeMagic(bytes) {
    const b = toByteView(bytes);
    if (!b || b.length < 2) return null;
    const len = b.length;

    // %PDF- (0x25 0x50 0x44 0x46 0x2d)
    if (
        len >= 5 &&
        b[0] === 0x25 &&
        b[1] === 0x50 &&
        b[2] === 0x44 &&
        b[3] === 0x46 &&
        b[4] === 0x2d
    ) {
        return 'application/pdf';
    }

    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (
        len >= 8 &&
        b[0] === 0x89 &&
        b[1] === 0x50 &&
        b[2] === 0x4e &&
        b[3] === 0x47 &&
        b[4] === 0x0d &&
        b[5] === 0x0a &&
        b[6] === 0x1a &&
        b[7] === 0x0a
    ) {
        return 'image/png';
    }

    // JPEG: FF D8 FF
    if (len >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
        return 'image/jpeg';
    }

    // GIF87a / GIF89a
    if (
        len >= 6 &&
        b[0] === 0x47 &&
        b[1] === 0x49 &&
        b[2] === 0x46 &&
        b[3] === 0x38 &&
        (b[4] === 0x37 || b[4] === 0x39) &&
        b[5] === 0x61
    ) {
        return 'image/gif';
    }

    // RIFF....WEBP or RIFF....WAVE
    if (
        len >= 12 &&
        b[0] === 0x52 &&
        b[1] === 0x49 &&
        b[2] === 0x46 &&
        b[3] === 0x46
    ) {
        if (b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
            return 'image/webp';
        }
        if (b[8] === 0x57 && b[9] === 0x41 && b[10] === 0x56 && b[11] === 0x45) {
            return 'audio/wav';
        }
    }

    // MP3: ID3 tag (49 44 33) or valid MPEG audio frame sync
    if (len >= 3 && b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) {
        return 'audio/mpeg';
    }
    if (
        len >= 2 &&
        b[0] === 0xff &&
        (b[1] & 0xe0) === 0xe0 &&
        (b[1] & 0x18) !== 0x08 &&
        (b[1] & 0x06) !== 0x00
    ) {
        return 'audio/mpeg';
    }

    // OggS (4F 67 67 53)
    if (len >= 4 && b[0] === 0x4f && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53) {
        return 'audio/ogg';
    }

    // EBML / WebM / Matroska (1A 45 DF A3)
    if (len >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
        return 'video/webm';
    }

    // ZIP: PK\x03\x04 (50 4B 03 04)
    if (len >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) {
        return 'application/zip';
    }

    return null;
}

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: false });

/**
 * Check whether an allowlist pattern strictly requires magic-verifiable binary bytes.
 *
 * @param {string} rawPattern - Allowlist entry
 * @returns {boolean}
 */
function patternRequiresMagic(rawPattern) {
    const pat = canonicalizeMime(rawPattern);
    if (!pat) return false;
    if (MAGIC_REQUIRED_MIMES.has(pat)) return true;
    return pat === 'image/*' || pat === 'audio/*' || pat === 'video/*';
}

/**
 * Inspect leading 4 KiB of bytes for active SVG/script/HTML markup.
 *
 * @param {Uint8Array|Buffer|ArrayBuffer} bytes - Input bytes
 * @returns {boolean}
 */
function containsActiveMarkup(bytes) {
    const view = toByteView(bytes);
    if (!view || view.length === 0) return false;
    const headLen = Math.min(view.length, 4096);
    const probe = UTF8_DECODER.decode(view.subarray(0, headLen)).trimStart().toLowerCase();
    return (
        probe.includes('<svg') ||
        probe.includes('<script') ||
        probe.startsWith('<!doctype html') ||
        probe.startsWith('<html')
    );
}

/**
 * Check whether an effective MIME matches at least one pattern in `allowedMimeTypes`.
 * Enforces that `'image/*'`, `'audio/*'`, and `'video/*'` with `requireMagicMatch: true`
 * require magic-verified binary bytes so `<svg><script>` or spoofed text cannot bypass wildcards.
 *
 * @param {string} effectiveMime - Resolved canonical MIME type
 * @param {string|null} detectedMime - Magic-sniffed MIME type or `null`
 * @param {string[]} allowList - Normalized allowed MIME patterns
 * @param {boolean} requireMagicMatch - Whether magic verification is active
 * @returns {boolean}
 */
function matchesAllowedMimeList(effectiveMime, detectedMime, allowList, requireMagicMatch) {
    for (const pattern of allowList) {
        if (!pattern) continue;

        if (pattern === '*/*' || pattern === '*') {
            return true;
        }

        if (pattern.endsWith('/*')) {
            const prefix = pattern.slice(0, -1); // e.g. 'image/', 'audio/', 'video/'
            if (
                requireMagicMatch &&
                (prefix === 'image/' || prefix === 'audio/' || prefix === 'video/')
            ) {
                if (!detectedMime) continue;
                if (detectedMime.startsWith(prefix)) {
                    return true;
                }
                if (
                    prefix === 'audio/' &&
                    effectiveMime === 'audio/webm' &&
                    detectedMime === 'video/webm'
                ) {
                    return true;
                }
                continue;
            }
            if (effectiveMime.startsWith(prefix)) {
                return true;
            }
            continue;
        }

        if (effectiveMime === pattern || canonicalizeMime(effectiveMime) === pattern) {
            return true;
        }
        if (
            detectedMime === 'video/webm' &&
            ((effectiveMime === 'video/webm' && pattern === 'audio/webm') ||
                (effectiveMime === 'audio/webm' && pattern === 'video/webm'))
        ) {
            return true;
        }
    }
    return false;
}

/**
 * Non-throwing MIME validator comparing declared `Content-Type` against `sniffMimeMagic(bytes)`
 * and an optional `allowedMimeTypes` allowlist (`INV-LEGO-01`, `INV-LEGO-18`).
 *
 * @param {Uint8Array|Buffer|ArrayBuffer} bytes - Uploaded file bytes
 * @param {string} [declaredMime=''] - Caller-declared `Content-Type`
 * @param {object} [options={}] - Verification options
 * @param {Iterable<string>|string[]|Set<string>|null} [options.allowedMimeTypes=null] - Permitted MIME types or wildcards
 * @param {boolean} [options.requireMagicMatch=true] - Require magic signature consistency
 * @param {string} [options.tool='upload.mime'] - Envelope tool identifier
 * @returns {{ ok: true, tool: string, summary: string, data: { mimeType: string, declaredMime: string|null, detectedMime: string|null } } | { ok: false, tool: string, summary: string, error: { code: string, message: string, details?: unknown } }}
 */
export function verifyUploadMime(bytes, declaredMime = '', options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    const allowedMimeTypes = opts.allowedMimeTypes ?? null;
    const requireMagicMatch = opts.requireMagicMatch !== false;
    const tool = String(opts.tool || 'upload.mime');

    const view = toByteView(bytes);
    if (!view) {
        return errorEnvelope(
            'UPLOAD_INVALID_DATA',
            'Upload data must be a Uint8Array, Buffer, or ArrayBuffer',
            null,
            tool
        );
    }
    if (view.byteLength === 0) {
        return errorEnvelope(
            'UPLOAD_EMPTY',
            'Upload data cannot be empty (0 bytes)',
            { size: 0 },
            tool
        );
    }

    const cleanDeclared =
        typeof declaredMime === 'string'
            ? declaredMime.split(';')[0].trim().toLowerCase()
            : '';
    const canonDeclared = canonicalizeMime(cleanDeclared);
    const detectedMime = sniffMimeMagic(view);

    let allowList = null;
    if (allowedMimeTypes !== null && allowedMimeTypes !== undefined) {
        if (typeof allowedMimeTypes === 'string') {
            const single = canonicalizeMime(allowedMimeTypes);
            allowList = single ? [single] : [];
        } else if (
            Array.isArray(allowedMimeTypes) ||
            allowedMimeTypes instanceof Set ||
            typeof allowedMimeTypes?.[Symbol.iterator] === 'function'
        ) {
            allowList = [];
            for (const entry of allowedMimeTypes) {
                if (typeof entry !== 'string') continue;
                const norm = canonicalizeMime(entry);
                if (norm) allowList.push(norm);
            }
        } else {
            allowList = [];
        }

        if (allowList.length === 0) {
            return errorEnvelope(
                'UPLOAD_UNSUPPORTED_MIME',
                'No MIME types are permitted by allowlist',
                { declaredMime: cleanDeclared || null, detectedMime },
                tool
            );
        }
    }

    const effectiveMime =
        canonDeclared === 'audio/webm' && detectedMime === 'video/webm'
            ? 'audio/webm'
            : detectedMime || canonDeclared || 'application/octet-stream';

    if (requireMagicMatch) {
        const allowlistImageOnly =
            allowList !== null &&
            allowList.length > 0 &&
            allowList.every((pat) => pat.startsWith('image/'));

        if (
            cleanDeclared === 'image/svg+xml' ||
            canonDeclared === 'image/svg+xml' ||
            ((effectiveMime.startsWith('image/') || allowlistImageOnly) &&
                containsActiveMarkup(bytes))
        ) {
            return errorEnvelope(
                'UPLOAD_MIME_MISMATCH',
                'SVG or active script markup is blocked under magic-verified image uploads',
                { declaredMime: cleanDeclared || null, detectedMime },
                tool
            );
        }

        if (
            detectedMime &&
            cleanDeclared &&
            cleanDeclared !== 'application/octet-stream' &&
            !areMimesEquivalent(cleanDeclared, detectedMime)
        ) {
            return errorEnvelope(
                'UPLOAD_MIME_MISMATCH',
                `Declared MIME "${cleanDeclared}" does not match detected magic "${detectedMime}"`,
                { declaredMime: cleanDeclared, detectedMime },
                tool
            );
        }

        if (!detectedMime) {
            const declaredNeedsMagic =
                Boolean(canonDeclared) &&
                (MAGIC_REQUIRED_MIMES.has(canonDeclared) ||
                    canonDeclared.startsWith('image/') ||
                    canonDeclared.startsWith('audio/') ||
                    canonDeclared.startsWith('video/'));

            const allowlistStrictlyBinary =
                allowList !== null &&
                allowList.length > 0 &&
                allowList.every((pat) => patternRequiresMagic(pat));

            if (
                declaredNeedsMagic ||
                (allowlistStrictlyBinary &&
                    (!canonDeclared || canonDeclared === 'application/octet-stream'))
            ) {
                return errorEnvelope(
                    'UPLOAD_MIME_MISMATCH',
                    `Missing expected binary magic signature for "${cleanDeclared || 'binary allowlist'}"`,
                    { declaredMime: cleanDeclared || null, detectedMime: null },
                    tool
                );
            }
        }
    }

    if (allowList !== null) {
        const permitted = matchesAllowedMimeList(
            effectiveMime,
            detectedMime,
            allowList,
            requireMagicMatch
        );

        if (!permitted) {
            return errorEnvelope(
                'UPLOAD_UNSUPPORTED_MIME',
                `MIME type "${effectiveMime}" is not permitted`,
                { mimeType: effectiveMime, declaredMime: cleanDeclared, detectedMime },
                tool
            );
        }
    }

    return okEnvelope(tool, 'Upload MIME verified', {
        mimeType: effectiveMime,
        declaredMime: cleanDeclared || null,
        detectedMime,
    });
}

/**
 * Read a case-insensitive header value from a `Headers` instance or Node/plain header map.
 *
 * @param {unknown} headers - Header container
 * @param {string} lowerName - Lowercase header name
 * @returns {string}
 */
function readHeaderValue(headers, lowerName) {
    if (!headers || typeof headers !== 'object') return '';
    if (typeof headers.get === 'function') {
        const val = headers.get(lowerName);
        return typeof val === 'string' ? val : '';
    }
    if (Object.hasOwn(headers, lowerName)) {
        const direct = headers[lowerName];
        if (Array.isArray(direct)) return String(direct[0] ?? '');
        if (direct !== undefined && direct !== null) return String(direct);
    }
    for (const [k, v] of Object.entries(headers)) {
        if (k.toLowerCase() === lowerName && v !== undefined && v !== null) {
            return Array.isArray(v) ? String(v[0] ?? '') : String(v);
        }
    }
    return '';
}

/**
 * Split semicolon-delimited HTTP header parameters without regex backtracking, preserving quoted semicolons.
 *
 * @param {string} raw - Parameter tail after initial `;`
 * @returns {string[]}
 */
function splitHeaderParams(raw) {
    const parts = [];
    let start = 0;
    let inQuotes = false;
    let escaped = false;

    for (let i = 0; i < raw.length; i += 1) {
        const ch = raw[i];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (inQuotes && ch === '\\') {
            escaped = true;
            continue;
        }
        if (ch === '"') {
            inQuotes = !inQuotes;
            continue;
        }
        if (!inQuotes && ch === ';') {
            parts.push(raw.slice(start, i));
            start = i + 1;
        }
    }
    if (inQuotes || escaped) {
        return [];
    }
    parts.push(raw.slice(start));
    return parts;
}

/**
 * Extract and validate the RFC 2046 / RFC 7578 `boundary` parameter from `Content-Type`.
 *
 * @param {string} rawContentType - Incoming `Content-Type` header
 * @returns {string|null}
 */
function parseMultipartBoundary(rawContentType) {
    if (typeof rawContentType !== 'string' || /[\r\n\x00]/.test(rawContentType)) {
        return null;
    }
    const semiIdx = rawContentType.indexOf(';');
    if (semiIdx < 0) return null;

    const mediaType = rawContentType.slice(0, semiIdx).trim().toLowerCase();
    if (mediaType !== 'multipart/form-data') return null;

    const params = splitHeaderParams(rawContentType.slice(semiIdx + 1));
    if (params.length === 0) return null;

    for (const rawParam of params) {
        const eqIdx = rawParam.indexOf('=');
        if (eqIdx <= 0) continue;
        const name = rawParam.slice(0, eqIdx).trim().toLowerCase();
        if (name !== 'boundary') continue;

        const rawVal = rawParam.slice(eqIdx + 1).trim();
        if (!rawVal) return null;

        let boundary = '';
        if (rawVal.startsWith('"')) {
            if (rawVal.length < 2 || !rawVal.endsWith('"')) return null;
            const inner = rawVal.slice(1, -1);
            if (inner.includes('"') || inner.includes('\\')) return null;
            boundary = inner;
        } else {
            if (/\s/.test(rawVal) || rawVal.includes('"')) return null;
            boundary = rawVal;
        }

        if (
            boundary.length < 1 ||
            boundary.length > 70 ||
            boundary.endsWith(' ') ||
            !VALID_BOUNDARY_CHARS_RE.test(boundary)
        ) {
            return null;
        }
        return boundary;
    }

    return null;
}

const MAX_POST_REJECTION_DRAIN_BYTES = 1_048_576; // 1 MiB post-rejection drain cap

/**
 * Drain a rejected Node `Readable` / `IncomingMessage` up to `maxDrainBytes` while keeping a
 * self-cleaning `'error'` guard attached until `'close'` so asynchronous stream resets never throw
 * `ERR_UNHANDLED_ERROR` (`INV-LEGO-03`, `INV-LEGO-18`).
 *
 * @param {import('node:stream').Readable & { aborted?: boolean }} stream - Node readable stream
 * @param {number} [maxDrainBytes=MAX_POST_REJECTION_DRAIN_BYTES] - Maximum post-rejection bytes to drain
 */
function drainNodeStreamSafely(stream, maxDrainBytes = MAX_POST_REJECTION_DRAIN_BYTES) {
    if (!stream || typeof stream.on !== 'function' || stream.destroyed) return;

    const remove = (event, fn) => {
        if (typeof stream.off === 'function') {
            stream.off(event, fn);
        } else if (typeof stream.removeListener === 'function') {
            stream.removeListener(event, fn);
        }
    };

    let drainedBytes = 0;

    const detachDataListeners = () => {
        remove('data', onDrainData);
        remove('end', onDrainEnd);
    };

    const detachAllListeners = () => {
        detachDataListeners();
        remove('error', onDrainError);
        remove('close', onDrainClose);
    };

    const onDrainError = () => {
        detachDataListeners();
    };

    const onDrainEnd = () => {
        detachDataListeners();
    };

    const onDrainClose = () => {
        detachAllListeners();
    };

    const onDrainData = (chunk) => {
        const len = Buffer.isBuffer(chunk)
            ? chunk.byteLength
            : chunk instanceof Uint8Array
              ? chunk.byteLength
              : Buffer.byteLength(String(chunk), 'utf8');
        drainedBytes += len;
        if (drainedBytes > maxDrainBytes) {
            detachDataListeners();
            stream.pause?.();
        }
    };

    stream.on('error', onDrainError);
    stream.on('close', onDrainClose);

    if (!stream.readableEnded) {
        stream.on('data', onDrainData);
        stream.on('end', onDrainEnd);
        stream.resume?.();
    }
}

/**
 * Cancel or drain an unread request body safely so rejected uploads neither leak listeners nor trigger `ECONNRESET`.
 *
 * @param {unknown} input - Request, Node stream, or buffer container
 */
async function drainRejectedInput(input) {
    if (!input || typeof input !== 'object') return;
    if (typeof input.body?.cancel === 'function') {
        try {
            await input.body.cancel();
        } catch {
            // Ignore Web ReadableStream cancel errors on rejected input
        }
        return;
    }
    if (typeof input.on === 'function' && !input.destroyed) {
        drainNodeStreamSafely(input);
    }
}

/**
 * Read a Node `IncomingMessage` / `Readable` into a single `Buffer` up to `safeMaxTotal` bytes,
 * detaching active accumulation listeners and draining safely on overflow (`INV-LEGO-03`, `INV-LEGO-18`).
 *
 * @param {import('node:stream').Readable & { aborted?: boolean }} stream - Node readable stream
 * @param {number} safeMaxTotal - Byte limit
 * @param {string} tool - Envelope tool identifier
 * @returns {Promise<{ ok: true, buffer: Buffer } | { ok: false, envelope: object }>}
 */
function readBoundedNodeStream(stream, safeMaxTotal, tool) {
    if (stream.aborted || stream.destroyed) {
        return Promise.resolve({
            ok: false,
            envelope: errorEnvelope('UPLOAD_STREAM_ABORTED', 'Upload stream was aborted', null, tool),
        });
    }
    if (stream.readableEnded) {
        return Promise.resolve({ ok: true, buffer: Buffer.alloc(0) });
    }

    return new Promise((resolve) => {
        let totalBytes = 0;
        let settled = false;
        const chunks = [];

        const remove = (event, fn) => {
            if (typeof stream.off === 'function') {
                stream.off(event, fn);
            } else if (typeof stream.removeListener === 'function') {
                stream.removeListener(event, fn);
            }
        };

        const cleanup = () => {
            remove('data', onData);
            remove('end', onEnd);
            remove('error', onError);
            remove('aborted', onAborted);
            remove('close', onClose);
        };

        const onData = (chunk) => {
            if (settled) return;
            const buf = Buffer.isBuffer(chunk)
                ? chunk
                : chunk instanceof Uint8Array
                  ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
                  : Buffer.from(String(chunk), 'utf8');

            totalBytes += buf.byteLength;
            if (totalBytes > safeMaxTotal) {
                settled = true;
                chunks.length = 0;
                cleanup();
                drainNodeStreamSafely(stream, Math.max(safeMaxTotal, MAX_POST_REJECTION_DRAIN_BYTES));
                resolve({
                    ok: false,
                    envelope: errorEnvelope(
                        'UPLOAD_TOO_LARGE',
                        `Multipart body exceeds ${safeMaxTotal} bytes`,
                        { maxTotalBytes: safeMaxTotal, receivedBytes: totalBytes },
                        tool
                    ),
                });
                return;
            }
            chunks.push(buf);
        };

        const onEnd = () => {
            if (settled) return;
            settled = true;
            cleanup();
            const combined = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, totalBytes);
            chunks.length = 0;
            resolve({ ok: true, buffer: combined });
        };

        const onAborted = () => {
            if (settled) return;
            settled = true;
            chunks.length = 0;
            cleanup();
            resolve({
                ok: false,
                envelope: errorEnvelope('UPLOAD_STREAM_ABORTED', 'Upload stream was aborted', null, tool),
            });
        };

        const onClose = () => {
            if (settled) return;
            settled = true;
            chunks.length = 0;
            cleanup();
            resolve({
                ok: false,
                envelope: errorEnvelope('UPLOAD_STREAM_ABORTED', 'Upload stream closed prematurely', null, tool),
            });
        };

        const onError = (err) => {
            if (settled) return;
            settled = true;
            chunks.length = 0;
            cleanup();
            resolve({
                ok: false,
                envelope: errorEnvelope(
                    'UPLOAD_STREAM_ERROR',
                    err?.message || 'Upload stream error',
                    null,
                    tool
                ),
            });
        };

        stream.on('data', onData);
        stream.on('end', onEnd);
        stream.on('error', onError);
        stream.on('aborted', onAborted);
        stream.on('close', onClose);
    });
}

/**
 * Read a Web `Request` body `ReadableStream` up to `safeMaxTotal` bytes, canceling immediately on overflow.
 *
 * @param {Request} request - Web `Request`
 * @param {number} safeMaxTotal - Byte limit
 * @param {string} tool - Envelope tool identifier
 * @returns {Promise<{ ok: true, buffer: Buffer } | { ok: false, envelope: object }>}
 */
async function readBoundedWebRequest(request, safeMaxTotal, tool) {
    if (!request.body || typeof request.body.getReader !== 'function') {
        if (typeof request.arrayBuffer === 'function') {
            try {
                const ab = await request.arrayBuffer();
                if (ab.byteLength > safeMaxTotal) {
                    return {
                        ok: false,
                        envelope: errorEnvelope(
                            'UPLOAD_TOO_LARGE',
                            `Multipart body exceeds ${safeMaxTotal} bytes`,
                            { maxTotalBytes: safeMaxTotal, receivedBytes: ab.byteLength },
                            tool
                        ),
                    };
                }
                return { ok: true, buffer: Buffer.from(ab) };
            } catch (err) {
                return {
                    ok: false,
                    envelope: errorEnvelope(
                        'UPLOAD_STREAM_ERROR',
                        err?.message || 'Unable to read request body',
                        null,
                        tool
                    ),
                };
            }
        }
        return { ok: true, buffer: Buffer.alloc(0) };
    }

    let reader;
    try {
        reader = request.body.getReader();
    } catch (err) {
        return {
            ok: false,
            envelope: errorEnvelope(
                'UPLOAD_STREAM_ERROR',
                err?.message || 'Unable to acquire request body reader',
                null,
                tool
            ),
        };
    }

    const chunks = [];
    let totalBytes = 0;

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;

            const buf =
                value instanceof Uint8Array
                    ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
                    : ArrayBuffer.isView(value)
                      ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
                      : value instanceof ArrayBuffer
                        ? Buffer.from(value)
                        : Buffer.from(String(value), 'utf8');

            totalBytes += buf.byteLength;
            if (totalBytes > safeMaxTotal) {
                chunks.length = 0;
                try {
                    await reader.cancel();
                } catch {
                    // Ignore reader cancel errors on overflow
                }
                return {
                    ok: false,
                    envelope: errorEnvelope(
                        'UPLOAD_TOO_LARGE',
                        `Multipart body exceeds ${safeMaxTotal} bytes`,
                        { maxTotalBytes: safeMaxTotal, receivedBytes: totalBytes },
                        tool
                    ),
                };
            }
            chunks.push(buf);
        }
    } catch (err) {
        chunks.length = 0;
        return {
            ok: false,
            envelope: errorEnvelope(
                'UPLOAD_STREAM_ERROR',
                err?.message || 'Failed while reading multipart request stream',
                null,
                tool
            ),
        };
    } finally {
        try {
            reader.releaseLock();
        } catch {
            // Ignore lock release errors
        }
    }

    const combined = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, totalBytes);
    chunks.length = 0;
    return { ok: true, buffer: combined };
}

/**
 * Inspect bytes immediately following `--boundary` to classify valid RFC 2046 boundary line endings.
 *
 * @param {Buffer} buf - Full multipart buffer
 * @param {number} afterBoundaryIdx - Offset immediately after `--${boundary}`
 * @returns {{ kind: 'part' | 'close', nextOffset: number } | null}
 */
function inspectBoundarySuffix(buf, afterBoundaryIdx) {
    let idx = afterBoundaryIdx;

    // Closing marker: --boundary--
    if (idx + 2 <= buf.length && buf[idx] === 0x2d && buf[idx + 1] === 0x2d) {
        idx += 2;
        while (idx < buf.length && (buf[idx] === 0x20 || buf[idx] === 0x09)) {
            idx += 1;
        }
        if (idx === buf.length) {
            return { kind: 'close', nextOffset: idx };
        }
        if (idx + 2 <= buf.length && buf[idx] === 0x0d && buf[idx + 1] === 0x0a) {
            return { kind: 'close', nextOffset: idx + 2 };
        }
        if (buf[idx] === 0x0a) {
            return { kind: 'close', nextOffset: idx + 1 };
        }
        return null;
    }

    // Standard part marker: --boundary[ \t]*\r\n
    while (idx < buf.length && (buf[idx] === 0x20 || buf[idx] === 0x09)) {
        idx += 1;
    }
    if (idx + 2 <= buf.length && buf[idx] === 0x0d && buf[idx + 1] === 0x0a) {
        return { kind: 'part', nextOffset: idx + 2 };
    }
    return null;
}

/**
 * Unescape a quoted HTTP header parameter value (`\"` -> `"`, `\\` -> `\`).
 *
 * @param {string} rawVal - Trimmed parameter value
 * @returns {string|null}
 */
function decodeHeaderParamValue(rawVal) {
    if (rawVal.startsWith('"')) {
        if (rawVal.length < 2 || !rawVal.endsWith('"')) return null;
        const inner = rawVal.slice(1, -1);
        let out = '';
        for (let i = 0; i < inner.length; i += 1) {
            if (inner[i] === '\\' && i + 1 < inner.length) {
                i += 1;
                out += inner[i];
            } else if (inner[i] === '"') {
                return null;
            } else {
                out += inner[i];
            }
        }
        return out;
    }
    if (rawVal.includes('"')) return null;
    return rawVal;
}

/**
 * Parse a single multipart part's UTF-8 header block (`Content-Disposition` & `Content-Type`).
 *
 * @param {Buffer} headerBytes - Raw header slice before `\r\n\r\n`
 * @returns {{ ok: true, fieldName: string, hasFilename: boolean, filename: string, contentType: string } | { ok: false, reason: string, details?: object }}
 */
function parsePartHeaders(headerBytes) {
    const headerText = headerBytes.toString('utf8');
    if (headerText.includes('\x00')) {
        return { ok: false, reason: 'Multipart header contains NUL byte' };
    }

    const lines = headerText.split('\r\n');
    let hasFormDataDisposition = false;
    let fieldName = '';
    let hasFilename = false;
    let filename = '';
    let contentType = '';

    for (const line of lines) {
        if (!line) continue;
        const colonIdx = line.indexOf(':');
        if (colonIdx <= 0) {
            return { ok: false, reason: 'Malformed header line in multipart part' };
        }
        const headerName = line.slice(0, colonIdx).trim().toLowerCase();
        const headerValue = line.slice(colonIdx + 1).trim();

        if (headerName === 'content-disposition') {
            const semiIdx = headerValue.indexOf(';');
            const dispType = (semiIdx >= 0 ? headerValue.slice(0, semiIdx) : headerValue)
                .trim()
                .toLowerCase();
            if (dispType !== 'form-data' || semiIdx < 0) {
                return { ok: false, reason: 'Content-Disposition must be form-data with parameters' };
            }

            const params = splitHeaderParams(headerValue.slice(semiIdx + 1));
            if (params.length === 0) {
                return { ok: false, reason: 'Malformed Content-Disposition parameters' };
            }

            hasFormDataDisposition = true;
            for (const rawParam of params) {
                const trimmed = rawParam.trim();
                if (!trimmed) continue;
                const eqIdx = trimmed.indexOf('=');
                if (eqIdx <= 0) continue;
                const pName = trimmed.slice(0, eqIdx).trim().toLowerCase();
                const pRawVal = trimmed.slice(eqIdx + 1).trim();
                const decoded = decodeHeaderParamValue(pRawVal);
                if (decoded === null) {
                    return { ok: false, reason: `Malformed quoted value in Content-Disposition "${pName}"` };
                }

                if (pName === 'name') {
                    fieldName = decoded;
                } else if (pName === 'filename') {
                    hasFilename = true;
                    filename = decoded;
                } else if (pName === 'filename*' && !hasFilename) {
                    const tickIdx = decoded.indexOf("''");
                    const rawEncoded = tickIdx >= 0 ? decoded.slice(tickIdx + 2) : decoded;
                    hasFilename = true;
                    try {
                        filename = decodeURIComponent(rawEncoded);
                    } catch {
                        filename = rawEncoded;
                    }
                }
            }
        } else if (headerName === 'content-type') {
            contentType = headerValue;
        }
    }

    if (!hasFormDataDisposition || !fieldName) {
        return {
            ok: false,
            reason: 'Multipart part is missing a valid Content-Disposition form-data name',
        };
    }

    if (FORBIDDEN_FIELD_NAMES.has(fieldName)) {
        return {
            ok: false,
            reason: `Forbidden prototype-polluting multipart field name "${fieldName}"`,
            details: { fieldName },
        };
    }

    return { ok: true, fieldName, hasFilename, filename, contentType };
}

/**
 * Parse a `multipart/form-data` payload from a Web `Request`, Node `IncomingMessage`/`Readable`,
 * or `{ body, contentType }` buffer with streaming `maxTotalBytes` enforcement, linear O(N)
 * `Buffer.indexOf` framing, filename sanitization, and magic-byte MIME verification (`INV-LEGO-18`).
 *
 * @param {Request | import('node:http').IncomingMessage | import('node:stream').Readable | { body: Uint8Array|Buffer|ArrayBuffer|string, contentType?: string, headers?: unknown } | Uint8Array | Buffer | ArrayBuffer} input - Multipart source
 * @param {object} [options={}] - Parser limits and MIME policy
 * @param {string} [options.contentType=''] - Explicit `Content-Type` override
 * @param {number} [options.maxTotalBytes=10485760] - Maximum total multipart payload bytes (10 MiB)
 * @param {number} [options.maxFileBytes=5242880] - Maximum bytes per uploaded file (5 MiB)
 * @param {number} [options.maxFiles=5] - Maximum number of file parts
 * @param {number} [options.maxFields=32] - Maximum number of text field parts
 * @param {number} [options.maxFieldBytes=65536] - Maximum UTF-8 bytes per text field (64 KiB)
 * @param {Iterable<string>|string[]|Set<string>|null} [options.allowedMimeTypes=null] - Permitted file MIME types
 * @param {boolean} [options.requireMagicMatch=true] - Require magic signature verification on file parts
 * @param {string} [options.tool='upload.multipart'] - Envelope tool identifier
 * @returns {Promise<{ ok: true, tool: string, summary: string, data: { fields: Record<string, string | string[]>, files: Array<{ fieldName: string, filename: string, originalFilename: string, mimeType: string, detectedMime: string|null, size: number, data: Uint8Array }>, totalBytes: number } } | { ok: false, tool: string, summary: string, error: { code: string, message: string, details?: unknown } }>}
 */
export async function parseBoundedMultipart(input, options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    const tool = String(opts.tool || 'upload.multipart');

    const rawMaxTotal = Number(opts.maxTotalBytes || DEFAULT_MAX_TOTAL_BYTES);
    const safeMaxTotal = Math.max(
        1,
        Number.isFinite(rawMaxTotal) ? Math.trunc(rawMaxTotal) : DEFAULT_MAX_TOTAL_BYTES
    );

    const resolveNonNegLimit = (val, fallback) => {
        if (val === undefined || val === null) return fallback;
        const num = Number(val);
        return Number.isFinite(num) ? Math.max(0, Math.trunc(num)) : fallback;
    };

    const safeMaxFileBytes = resolveNonNegLimit(opts.maxFileBytes, DEFAULT_MAX_FILE_BYTES);
    const safeMaxFiles = resolveNonNegLimit(opts.maxFiles, DEFAULT_MAX_FILES);
    const safeMaxFields = resolveNonNegLimit(opts.maxFields, DEFAULT_MAX_FIELDS);
    const safeMaxFieldBytes = resolveNonNegLimit(opts.maxFieldBytes, DEFAULT_MAX_FIELD_BYTES);
    const allowedMimeTypes = opts.allowedMimeTypes ?? null;
    const requireMagicMatch = opts.requireMagicMatch !== false;

    const rawContentType =
        (typeof opts.contentType === 'string' && opts.contentType) ||
        (input && typeof input === 'object' && typeof input.contentType === 'string' && input.contentType) ||
        readHeaderValue(input?.headers, 'content-type') ||
        '';

    const boundary = parseMultipartBoundary(rawContentType);
    if (!boundary) {
        await drainRejectedInput(input);
        return errorEnvelope(
            'UPLOAD_INVALID_CONTENT_TYPE',
            'Expected multipart/form-data with a valid boundary',
            null,
            tool
        );
    }

    const rawContentLength = readHeaderValue(input?.headers, 'content-length').trim();
    if (rawContentLength !== '') {
        const declaredLength = Number(rawContentLength);
        if (Number.isFinite(declaredLength) && declaredLength > safeMaxTotal) {
            await drainRejectedInput(input);
            return errorEnvelope(
                'UPLOAD_TOO_LARGE',
                `Multipart body exceeds ${safeMaxTotal} bytes`,
                { maxTotalBytes: safeMaxTotal },
                tool
            );
        }
    }

    let rawBuffer = null;

    if (!input || typeof input !== 'object') {
        return errorEnvelope('UPLOAD_MALFORMED_PART', 'Missing multipart body input', null, tool);
    }

    const directBytes = toByteView(input);
    if (directBytes) {
        if (directBytes.byteLength > safeMaxTotal) {
            return errorEnvelope(
                'UPLOAD_TOO_LARGE',
                `Multipart body exceeds ${safeMaxTotal} bytes`,
                { maxTotalBytes: safeMaxTotal, receivedBytes: directBytes.byteLength },
                tool
            );
        }
        rawBuffer = Buffer.from(directBytes.buffer, directBytes.byteOffset, directBytes.byteLength);
    } else if (typeof input.on === 'function') {
        const streamRes = await readBoundedNodeStream(input, safeMaxTotal, tool);
        if (!streamRes.ok) return streamRes.envelope;
        rawBuffer = streamRes.buffer;
    } else if (
        typeof input.headers?.get === 'function' &&
        (typeof input.body?.getReader === 'function' ||
            (typeof input.arrayBuffer === 'function' &&
                (!('body' in input) || input.body === null || input.body === undefined)))
    ) {
        const webRes = await readBoundedWebRequest(input, safeMaxTotal, tool);
        if (!webRes.ok) return webRes.envelope;
        rawBuffer = webRes.buffer;
    } else if ('body' in input) {
        const candidateBody = input.body;
        const bodyView = toByteView(candidateBody);
        if (bodyView) {
            if (bodyView.byteLength > safeMaxTotal) {
                return errorEnvelope(
                    'UPLOAD_TOO_LARGE',
                    `Multipart body exceeds ${safeMaxTotal} bytes`,
                    { maxTotalBytes: safeMaxTotal, receivedBytes: bodyView.byteLength },
                    tool
                );
            }
            rawBuffer = Buffer.from(bodyView.buffer, bodyView.byteOffset, bodyView.byteLength);
        } else if (typeof candidateBody === 'string') {
            const byteLen = Buffer.byteLength(candidateBody, 'utf8');
            if (byteLen > safeMaxTotal) {
                return errorEnvelope(
                    'UPLOAD_TOO_LARGE',
                    `Multipart body exceeds ${safeMaxTotal} bytes`,
                    { maxTotalBytes: safeMaxTotal, receivedBytes: byteLen },
                    tool
                );
            }
            rawBuffer = Buffer.from(candidateBody, 'utf8');
        } else {
            return errorEnvelope('UPLOAD_MALFORMED_PART', 'Unsupported multipart body container', null, tool);
        }
    } else {
        return errorEnvelope('UPLOAD_MALFORMED_PART', 'Unsupported multipart input source', null, tool);
    }

    const totalBytes = rawBuffer.byteLength;
    const dashBoundary = Buffer.from(`--${boundary}`, 'utf8');
    const crlfDashBoundary = Buffer.concat([CRLF_BYTES, dashBoundary]);

    if (totalBytes < dashBoundary.length + 2) {
        return errorEnvelope('UPLOAD_MALFORMED_PART', 'Multipart payload is truncated or empty', null, tool);
    }

    // Locate opening --boundary (either at offset 0 or after an RFC 2046 preamble + CRLF)
    let partStart = -1;
    let sawClosingBoundary = false;

    if (rawBuffer.subarray(0, dashBoundary.length).equals(dashBoundary)) {
        const firstSuffix = inspectBoundarySuffix(rawBuffer, dashBoundary.length);
        if (firstSuffix) {
            if (firstSuffix.kind === 'close') {
                return okEnvelope(tool, 'Parsed 0 file(s) and 0 field(s)', {
                    fields: {},
                    files: [],
                    totalBytes,
                });
            }
            partStart = firstSuffix.nextOffset;
        }
    }

    if (partStart < 0) {
        let searchFrom = 0;
        while (searchFrom <= totalBytes - crlfDashBoundary.length) {
            const idx = rawBuffer.indexOf(crlfDashBoundary, searchFrom);
            if (idx < 0) break;
            const suffix = inspectBoundarySuffix(rawBuffer, idx + crlfDashBoundary.length);
            if (suffix) {
                if (suffix.kind === 'close') {
                    return okEnvelope(tool, 'Parsed 0 file(s) and 0 field(s)', {
                        fields: {},
                        files: [],
                        totalBytes,
                    });
                }
                partStart = suffix.nextOffset;
                break;
            }
            searchFrom = idx + 2;
        }
    }

    if (partStart < 0) {
        return errorEnvelope('UPLOAD_MALFORMED_PART', 'Missing opening multipart boundary', null, tool);
    }

    const fields = {};
    const files = [];
    let fieldCount = 0;
    let fileCount = 0;

    let cursor = partStart;
    while (cursor <= totalBytes) {
        // Search from cursor - 2 so an empty malformed part (`--b\r\n--b--`) still matches `\r\n--b`
        let searchPos = Math.max(0, cursor - 2);
        let delimIdx = -1;
        let suffix = null;

        while (searchPos <= totalBytes - crlfDashBoundary.length) {
            const candidateIdx = rawBuffer.indexOf(crlfDashBoundary, searchPos);
            if (candidateIdx < 0) break;
            const candidateSuffix = inspectBoundarySuffix(
                rawBuffer,
                candidateIdx + crlfDashBoundary.length
            );
            if (candidateSuffix) {
                delimIdx = candidateIdx;
                suffix = candidateSuffix;
                break;
            }
            searchPos = candidateIdx + 2;
        }

        if (delimIdx < 0 || !suffix) {
            return errorEnvelope('UPLOAD_MALFORMED_PART', 'Missing closing multipart boundary', null, tool);
        }

        if (delimIdx < cursor) {
            return errorEnvelope('UPLOAD_MALFORMED_PART', 'Multipart part is missing headers', null, tool);
        }

        const partSlice = rawBuffer.subarray(cursor, delimIdx);
        const headerScanSlice = partSlice.subarray(
            0,
            Math.min(partSlice.byteLength, MAX_PART_HEADER_BYTES + DOUBLE_CRLF_BYTES.length)
        );
        const headerEndIdx = headerScanSlice.indexOf(DOUBLE_CRLF_BYTES);
        if (headerEndIdx < 0 || headerEndIdx > MAX_PART_HEADER_BYTES) {
            return errorEnvelope(
                'UPLOAD_MALFORMED_PART',
                'Multipart part is missing header separator or exceeds 16 KiB header limit',
                null,
                tool
            );
        }

        const headerBytes = partSlice.subarray(0, headerEndIdx);
        const partBody = partSlice.subarray(headerEndIdx + DOUBLE_CRLF_BYTES.length);

        const parsedHeaders = parsePartHeaders(headerBytes);
        if (!parsedHeaders.ok) {
            return errorEnvelope(
                'UPLOAD_MALFORMED_PART',
                parsedHeaders.reason,
                parsedHeaders.details ?? null,
                tool
            );
        }

        const { fieldName, hasFilename, filename: rawFilename, contentType: partContentType } = parsedHeaders;

        if (hasFilename) {
            fileCount += 1;
            if (fileCount > safeMaxFiles) {
                return errorEnvelope(
                    'UPLOAD_TOO_MANY_FILES',
                    `Multipart upload exceeds maximum of ${safeMaxFiles} file(s)`,
                    { maxFiles: safeMaxFiles },
                    tool
                );
            }

            if (partBody.byteLength > safeMaxFileBytes) {
                return errorEnvelope(
                    'UPLOAD_FILE_TOO_LARGE',
                    `Uploaded file exceeds maximum of ${safeMaxFileBytes} bytes`,
                    { fieldName, maxFileBytes: safeMaxFileBytes, size: partBody.byteLength },
                    tool
                );
            }

            const safeFilename = sanitizeUploadFilename(rawFilename);
            const mimeCheck = verifyUploadMime(partBody, partContentType, {
                allowedMimeTypes,
                requireMagicMatch,
                tool,
            });
            if (!mimeCheck.ok) {
                return mimeCheck;
            }

            const standaloneData = new Uint8Array(partBody.byteLength);
            standaloneData.set(partBody);

            files.push({
                fieldName,
                filename: safeFilename,
                originalFilename: rawFilename,
                mimeType: mimeCheck.data.mimeType,
                detectedMime: mimeCheck.data.detectedMime,
                size: partBody.byteLength,
                data: standaloneData,
            });
        } else {
            fieldCount += 1;
            if (fieldCount > safeMaxFields) {
                return errorEnvelope(
                    'UPLOAD_TOO_MANY_FIELDS',
                    `Multipart form exceeds maximum of ${safeMaxFields} field(s)`,
                    { maxFields: safeMaxFields },
                    tool
                );
            }

            if (partBody.byteLength > safeMaxFieldBytes) {
                return errorEnvelope(
                    'UPLOAD_FIELD_TOO_LARGE',
                    `Multipart field "${fieldName}" exceeds maximum of ${safeMaxFieldBytes} bytes`,
                    { fieldName, maxFieldBytes: safeMaxFieldBytes, size: partBody.byteLength },
                    tool
                );
            }

            const fieldValue = partBody.toString('utf8');
            if (Object.hasOwn(fields, fieldName)) {
                const existing = fields[fieldName];
                if (Array.isArray(existing)) {
                    existing.push(fieldValue);
                } else {
                    fields[fieldName] = [existing, fieldValue];
                }
            } else {
                Object.defineProperty(fields, fieldName, {
                    value: fieldValue,
                    writable: true,
                    enumerable: true,
                    configurable: true,
                });
            }
        }

        if (suffix.kind === 'close') {
            sawClosingBoundary = true;
            break;
        }
        cursor = suffix.nextOffset;
    }

    if (!sawClosingBoundary) {
        return errorEnvelope('UPLOAD_MALFORMED_PART', 'Missing closing multipart boundary', null, tool);
    }

    return okEnvelope(
        tool,
        `Parsed ${files.length} file(s) and ${fieldCount} field(s)`,
        {
            fields,
            files,
            totalBytes,
        }
    );
}
