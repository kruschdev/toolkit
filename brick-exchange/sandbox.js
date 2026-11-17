/**
 * @module @krusch/toolkit/brick-exchange/sandbox
 * @description Hermetic Zero-Trust Verification Sandbox and 3-Gate Pre-Seal Runner (`INV-LEGO-35`).
 *
 * Provides:
 * - Deterministic SHA-256 canonical hashing (`canonicalBrickHash`)
 * - Static zero-ambient-I/O and zero-leak source scanner (`scanBrickSourceSafety`)
 * - TypeScript-stripping ESM-to-CommonJS transpiler (`transpileBrickSourceToCjs`)
 * - Node 22 `--permission` subprocess and locked `vm` capability-port sandbox (`executeInBrickSandbox`)
 * - 3-gate pre-seal contract + positive + adversarial fault-injection verifier (`runBrickVerificationGates`)
 */

import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import * as nodeModule from 'node:module';
import vm from 'node:vm';
import { okEnvelope, errorEnvelope } from '../http.js';
import { validateSchema, toJsonSchema } from '../schema.js';
import { canonicalizeAuditPayload } from '../audit-log.js';
import { scrubSensitiveText, DEFAULT_SCRUB_MARKERS } from '../security.js';

export const DEFAULT_SANDBOX_TIMEOUT_MS = 800;
export const DEFAULT_SANDBOX_MAX_MEMORY_MB = 32;
export const MAX_BRICK_SOURCE_BYTES = 65536;

const MAX_STDIN_PAYLOAD_BYTES = 2 * 1024 * 1024;
const MAX_CHILD_STREAM_BYTES = 2 * 1024 * 1024;
const FORBIDDEN_PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const BANNED_HOST_MODULES = new Set([
    'fs',
    'fs/promises',
    'net',
    'tls',
    'http',
    'https',
    'http2',
    'dgram',
    'dns',
    'dns/promises',
    'child_process',
    'worker_threads',
    'cluster',
    'os',
    'v8',
    'vm',
    'inspector',
    'inspector/promises',
    'module',
    'process',
    'readline',
    'repl',
    'tty',
    'wasi',
    'sqlite',
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

// Constructed dynamically so repository-wide Zero-Leak scanners never match pattern definitions.
const SECRET_PREFIX_LEAK_RE = new RegExp(
    `(?:AIzaSy[A-Za-z0-9_-]{4,}|\\bsk-[A-Za-z0-9_-]{6,}|\\bgh[pousr]_[A-Za-z0-9]{6,}|\\bgithub_pat_[A-Za-z0-9_]{6,}|\\bxox[baprs]-[A-Za-z0-9-]{6,}|-----${'BEGIN'}\\s+(?:[A-Z0-9 ]+\\s+)?PRIVATE\\s+KEY)`
);
const LOCAL_FS_DIR_LEAK_RE = new RegExp(
    `(?<![A-Za-z0-9._-])\\/(?:${'ho' + 'me'}|${'Us' + 'ers'}|${'m' + 'nt'})\\/(?:[A-Za-z0-9._-]+)?`
);
const PRIVATE_IPV4_LEAK_RE = new RegExp(
    `\\b(?:192\\.168\\.\\d{1,3}\\.\\d{1,3}|10\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}|172\\.(?:1[6-9]|2\\d|3[01])\\.\\d{1,3}\\.\\d{1,3}|100\\.(?:6[4-9]|[7-9]\\d|1[01]\\d|12[0-7])\\.\\d{1,3}\\.\\d{1,3})\\b`
);

/**
 * Bootstrap script executed inside the hermetic `node --permission` child process.
 * Reads `{ cjsCode, exportName, input, hasUndefinedInput, bindingData, vmTimeoutMs }` from stdin,
 * evaluates inside a locked `vm.createContext` with `codeGeneration: { strings: false, wasm: false }`,
 * and writes a single JSON result object to stdout.
 */
const WORKER_BOOTSTRAP_CODE = `
'use strict';
const vm = require('node:vm');
const realSetTimeout = setTimeout;
const realClearTimeout = clearTimeout;
const realStdoutWrite = process.stdout.write.bind(process.stdout);
const realExit = process.exit.bind(process);

try { delete globalThis.fetch; } catch {}
try { delete globalThis.WebSocket; } catch {}

function writeResultAndExit(payload) {
    let serialized;
    try {
        serialized = JSON.stringify(payload);
    } catch (err) {
        serialized = JSON.stringify({
            ok: false,
            code: 'SANDBOX_EXECUTION_ERROR',
            message: 'Brick output is not JSON-serializable: ' + (err && err.message ? err.message : String(err))
        });
    }
    realStdoutWrite(serialized + '\\n', () => realExit(0));
}

let chunks = [];
let totalBytes = 0;
const maxBytes = ${MAX_STDIN_PAYLOAD_BYTES};

process.stdin.on('data', (chunk) => {
    totalBytes += chunk.length;
    if (totalBytes > maxBytes) {
        writeResultAndExit({
            ok: false,
            code: 'SANDBOX_EXECUTION_ERROR',
            message: 'Sandbox stdin payload exceeded limit'
        });
        return;
    }
    chunks.push(chunk);
});

process.stdin.on('end', async () => {
    let req;
    try {
        req = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        chunks = null;
    } catch (err) {
        writeResultAndExit({
            ok: false,
            code: 'SANDBOX_EXECUTION_ERROR',
            message: 'Malformed sandbox request payload'
        });
        return;
    }

    const vmTimeoutMs = Math.max(5, Number(req.vmTimeoutMs) || ${DEFAULT_SANDBOX_TIMEOUT_MS});
    const exportName = String(req.exportName || 'default');
    const cjsCode = String(req.cjsCode || '');

    const sandboxGlobals = {
        TextEncoder,
        TextDecoder,
        URL,
        URLSearchParams,
        structuredClone,
        fetch: undefined,
        process: undefined,
        require: undefined,
        WebSocket: undefined,
        setTimeout: undefined,
        setInterval: undefined,
        clearTimeout: undefined,
        clearInterval: undefined,
        setImmediate: undefined,
        clearImmediate: undefined,
        __rawInputJson: JSON.stringify(req.hasUndefinedInput ? null : req.input),
        __hasUndefinedInput: Boolean(req.hasUndefinedInput),
        __rawBindingJson: JSON.stringify(req.bindingData ?? {}),
        __exportName: exportName,
    };

    const ctx = vm.createContext(sandboxGlobals, {
        codeGeneration: { strings: false, wasm: false },
    });

    const runnerSource =
        '(function () {\\n' +
        '  const module = { exports: {} };\\n' +
        '  const exports = module.exports;\\n' +
        '  const __input = __hasUndefinedInput ? undefined : JSON.parse(__rawInputJson);\\n' +
        '  const __binding = JSON.parse(__rawBindingJson);\\n' +
        cjsCode + '\\n;\\n' +
        '  const __modOut = module.exports;\\n' +
        '  let __fn = undefined;\\n' +
        '  if (__exportName === "default") {\\n' +
        '    if (typeof __modOut === "function") { __fn = __modOut; }\\n' +
        '    else if (__modOut && (typeof __modOut === "object" || typeof __modOut === "function") && typeof __modOut.default === "function") { __fn = __modOut.default; }\\n' +
        '  } else if (__modOut && (typeof __modOut === "object" || typeof __modOut === "function") && typeof __modOut[__exportName] === "function") {\\n' +
        '    __fn = __modOut[__exportName];\\n' +
        '  }\\n' +
        '  if (typeof __fn !== "function") {\\n' +
        '    throw new TypeError("Export " + __exportName + " is not a function on brick module");\\n' +
        '  }\\n' +
        '  return __fn(__input, __binding);\\n' +
        '})()';

    let timer = null;
    try {
        const script = new vm.Script(runnerSource, { filename: 'brick.sandbox.cjs' });
        const rawOut = script.runInContext(ctx, { timeout: vmTimeoutMs });

        if (rawOut !== null && (typeof rawOut === 'object' || typeof rawOut === 'function') && typeof rawOut.then === 'function') {
            const timeoutPromise = new Promise((_, reject) => {
                timer = realSetTimeout(() => {
                    const err = new Error('Async brick execution timed out after ' + vmTimeoutMs + 'ms');
                    err.code = 'ERR_SCRIPT_EXECUTION_TIMEOUT';
                    reject(err);
                }, vmTimeoutMs);
            });
            const awaited = await Promise.race([rawOut, timeoutPromise]);
            if (timer) realClearTimeout(timer);
            writeResultAndExit({
                ok: true,
                hasUndefined: awaited === undefined,
                output: awaited === undefined ? null : awaited,
            });
            return;
        }

        writeResultAndExit({
            ok: true,
            hasUndefined: rawOut === undefined,
            output: rawOut === undefined ? null : rawOut,
        });
    } catch (err) {
        if (timer) realClearTimeout(timer);
        const msg = err && err.message ? String(err.message) : String(err);
        const code = err && err.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' || /Script execution timed out/i.test(msg)
            ? 'SANDBOX_TIMEOUT'
            : 'SANDBOX_EXECUTION_ERROR';
        writeResultAndExit({ ok: false, code, message: msg });
    }
});
`;

function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

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

/**
 * Deterministic fallback serializer when a value contains functions, symbols, or deep structures
 * outside strict RFC-8785 audit payload constraints.
 *
 * @param {unknown} value
 * @param {WeakSet<object>} [seen]
 * @returns {string}
 */
function fallbackCanonicalJson(value, seen = new WeakSet()) {
    if (value === null || value === undefined) {
        return 'null';
    }
    const t = typeof value;
    if (t === 'boolean') return value ? 'true' : 'false';
    if (t === 'number') {
        if (!Number.isFinite(value)) return JSON.stringify(String(value));
        return Object.is(value, -0) ? '0' : JSON.stringify(value);
    }
    if (t === 'string') return JSON.stringify(value);
    if (t === 'bigint') return JSON.stringify(`${value.toString()}n`);
    if (t === 'symbol' || t === 'function') return JSON.stringify(`[${t}:${String(value)}]`);

    if (value instanceof Date) {
        const ms = value.getTime();
        return Number.isFinite(ms) ? JSON.stringify(value.toISOString()) : 'null';
    }

    if (seen.has(value)) {
        return '"[Circular]"';
    }
    seen.add(value);
    try {
        if (Array.isArray(value)) {
            const parts = value.map((item) => (item === undefined ? 'null' : fallbackCanonicalJson(item, seen)));
            return `[${parts.join(',')}]`;
        }
        const keys = Object.keys(value)
            .filter((k) => !FORBIDDEN_PROTO_KEYS.has(k) && value[k] !== undefined)
            .sort();
        const entries = keys.map((k) => `${JSON.stringify(k)}:${fallbackCanonicalJson(value[k], seen)}`);
        return `{${entries.join(',')}}`;
    } finally {
        seen.delete(value);
    }
}

/**
 * Compute a deterministic 64-character lowercase SHA-256 hex digest for strings or structured values.
 *
 * @param {unknown} value - Raw source string or JSON-compatible object
 * @returns {string}
 */
export function canonicalBrickHash(value) {
    if (typeof value === 'string') {
        return crypto.createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex');
    }
    const canon = canonicalizeAuditPayload(value, { maxDepth: 64, tool: 'brick-exchange.hash' });
    if (canon.ok && typeof canon.data?.canonicalJson === 'string') {
        return crypto
            .createHash('sha256')
            .update(Buffer.from(canon.data.canonicalJson, 'utf8'))
            .digest('hex');
    }
    const fallback = fallbackCanonicalJson(value);
    return crypto.createHash('sha256').update(Buffer.from(fallback, 'utf8')).digest('hex');
}

/**
 * Strip single-line (`//`) and multi-line (`/* ... * /`) JS/TS comments while preserving
 * single-quoted, double-quoted, template, and regex literals as well as line offsets.
 *
 * @param {string} source
 * @returns {string}
 */
function stripJsCommentsPreservingLiterals(source) {
    const len = source.length;
    const out = [];
    let i = 0;
    let canStartRegex = true;
    let braceDepth = 0;
    const templateBraceStack = [];

    while (i < len) {
        const ch = source[i];
        const next = i + 1 < len ? source[i + 1] : '';

        // Single-line comment
        if (ch === '/' && next === '/') {
            out.push(' ', ' ');
            i += 2;
            while (i < len && source[i] !== '\n') {
                out.push(source[i] === '\r' ? '\r' : ' ');
                i += 1;
            }
            continue;
        }

        // Multi-line comment
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

        // Single or double quoted string literal
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

        // Template literal start
        if (ch === '`') {
            out.push(ch);
            i += 1;
            i = consumeTemplateBody(source, i, out, templateBraceStack, braceDepth);
            if (templateBraceStack.length === 0) {
                canStartRegex = false;
            } else {
                canStartRegex = true;
            }
            continue;
        }

        // Closing `}` of a `${ ... }` template expression resumes the enclosing template literal
        if (ch === '}' && templateBraceStack.length > 0 && braceDepth === templateBraceStack[templateBraceStack.length - 1]) {
            templateBraceStack.pop();
            out.push(ch);
            i += 1;
            i = consumeTemplateBody(source, i, out, templateBraceStack, braceDepth);
            if (templateBraceStack.length === 0) {
                canStartRegex = false;
            } else {
                canStartRegex = true;
            }
            continue;
        }

        // Regex literal
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
                if (c === '[') {
                    inCharClass = true;
                } else if (c === ']') {
                    inCharClass = false;
                } else if (c === '/' && !inCharClass) {
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

        // Identifiers / keywords
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

        // Numbers
        if (ch >= '0' && ch <= '9') {
            while (i < len && (isIdentPart(source.charCodeAt(i)) || source[i] === '.')) {
                out.push(source[i]);
                i += 1;
            }
            canStartRegex = false;
            continue;
        }

        // Whitespace
        if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v') {
            out.push(ch);
            i += 1;
            continue;
        }

        // Braces and punctuation
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

/**
 * Remove TypeScript `import type ...` and `export type ...` declarations prior to ambient import checks.
 *
 * @param {string} commentStrippedSource
 * @returns {string}
 */
function stripTypeOnlyDeclarationsForScan(commentStrippedSource) {
    if (typeof nodeModule.stripTypeScriptTypes === 'function') {
        try {
            return nodeModule.stripTypeScriptTypes(commentStrippedSource, { mode: 'strip' });
        } catch {
            // Fall back to explicit regex stripping if source contains syntax errors
        }
    }
    return commentStrippedSource
        .replace(/\bimport\s+type\s+(?:[\s\S]*?\s+from\s+)?['"][^'"]+['"]\s*;?/g, ' ')
        .replace(/\bexport\s+type\s+\{[\s\S]*?\}(?:\s+from\s+['"][^'"]+['"])?\s*;?/g, ' ')
        .replace(/\bexport\s+type\s+[A-Za-z_$][A-Za-z0-9_$]*[\s\S]*?;/g, ' ');
}

function normalizeSpecifierModuleName(specifier) {
    const trimmed = String(specifier || '').trim();
    if (trimmed.startsWith('node:')) {
        return trimmed.slice(5);
    }
    return trimmed;
}

function isPureRelativeSpecifier(specifier) {
    const trimmed = String(specifier || '').trim();
    if (!(trimmed.startsWith('./') || trimmed.startsWith('../'))) {
        return false;
    }
    const bare = normalizeSpecifierModuleName(trimmed);
    return !BANNED_HOST_MODULES.has(bare);
}

/**
 * Collect runtime `import` and `require` findings after comments and TypeScript `import type`
 * declarations have been stripped.
 *
 * @param {string} runtimeCode
 * @param {boolean} allowPureRelativeImports
 * @returns {Array<{ ruleId: string, message: string }>}
 */
function scanAmbientImports(runtimeCode, allowPureRelativeImports) {
    const findings = [];
    const seenMessages = new Set();

    const pushFinding = (message) => {
        if (seenMessages.has(message)) return;
        seenMessages.add(message);
        findings.push({ ruleId: 'AMBIENT_IMPORT_FORBIDDEN', message });
    };

    const checkSpecifier = (specifier, syntaxKind) => {
        const clean = String(specifier || '').trim();
        const bare = normalizeSpecifierModuleName(clean);
        if (clean.startsWith('node:') || BANNED_HOST_MODULES.has(bare)) {
            pushFinding(`Forbidden host capability ${syntaxKind} of "${clean}"; inject ports via binding instead`);
            return;
        }
        if (!allowPureRelativeImports || !isPureRelativeSpecifier(clean)) {
            pushFinding(`External runtime ${syntaxKind} of "${clean}" is forbidden in sealed bricks`);
        }
    };

    // Static `import ... from '...'`
    const staticFromRe = /\bimport\s+(?!type\b)[\s\S]*?\bfrom\s*(['"`])([^'"`]+)\1/g;
    let m;
    while ((m = staticFromRe.exec(runtimeCode)) !== null) {
        checkSpecifier(m[2], 'import');
    }

    // Bare side-effect `import '...'`
    const sideEffectImportRe = /\bimport\s*(['"`])([^'"`]+)\1/g;
    while ((m = sideEffectImportRe.exec(runtimeCode)) !== null) {
        checkSpecifier(m[2], 'import');
    }

    // Re-exports `export ... from '...'`
    const reExportRe = /\bexport\s+(?!type\b)(?:\*(?:\s+as\s+[A-Za-z_$][A-Za-z0-9_$]*)?|\{[\s\S]*?\})\s*from\s*(['"`])([^'"`]+)\1/g;
    while ((m = reExportRe.exec(runtimeCode)) !== null) {
        checkSpecifier(m[2], 're-export');
    }

    // Dynamic `import(...)`
    const dynamicImportRe = /(?<!(?:\.\s*|\?\.\s*|function\s+))\bimport\s*\(\s*(?:(['"`])([^'"`]*)\1)?/g;
    while ((m = dynamicImportRe.exec(runtimeCode)) !== null) {
        if (m[2] !== undefined) {
            checkSpecifier(m[2], 'dynamic import()');
        } else {
            pushFinding('Computed dynamic import() expression is forbidden in sealed bricks');
        }
    }

    // CommonJS `require(...)`
    const requireCallRe = /(?<!(?:\.\s*|\?\.\s*|function\s+))\brequire\s*\(\s*(?:(['"`])([^'"`]*)\1)?/g;
    while ((m = requireCallRe.exec(runtimeCode)) !== null) {
        if (m[2] !== undefined) {
            checkSpecifier(m[2], 'require()');
        } else {
            pushFinding('Dynamic require() call is forbidden in sealed bricks');
        }
    }

    return findings;
}

/**
 * Scan brick source code for zero-ambient-I/O safety and Zero-Leak compliance (`INV-LEGO-35`, `INV-LEGO-26`).
 *
 * @param {string} source - Candidate JS/TS brick source text
 * @param {{ maxBytes?: number, allowPureRelativeImports?: boolean }} [options={}]
 * @returns {{ ok: boolean, tool: string, summary: string, data?: { clean: true, findings: [], byteLength: number }, error?: { code: string, message: string, details: { clean: false, findings: Array<{ ruleId: string, message: string }> } } }}
 */
export function scanBrickSourceSafety(source, options = {}) {
    const tool = 'brick-exchange.safety';
    const opts = options && typeof options === 'object' ? options : {};
    const maxBytes =
        Number.isFinite(Number(opts.maxBytes)) && Number(opts.maxBytes) > 0
            ? Math.trunc(Number(opts.maxBytes))
            : MAX_BRICK_SOURCE_BYTES;
    const allowPureRelativeImports = opts.allowPureRelativeImports === true;

    if (typeof source !== 'string' || source.trim().length === 0) {
        const findings = [
            {
                ruleId: 'INVALID_BRICK_SOURCE',
                message: 'Brick source must be a non-empty UTF-8 string',
            },
        ];
        return errorEnvelope(
            'BRICK_SAFETY_FAILED',
            findings[0].message,
            { clean: false, findings },
            tool
        );
    }

    const byteLength = Buffer.byteLength(source, 'utf8');
    if (byteLength > maxBytes) {
        const findings = [
            {
                ruleId: 'SOURCE_TOO_LARGE',
                message: `Brick source (${byteLength} bytes) exceeds maximum size (${maxBytes} bytes)`,
            },
        ];
        return errorEnvelope(
            'BRICK_SAFETY_FAILED',
            findings[0].message,
            { clean: false, findings },
            tool
        );
    }

    const findings = [];
    const pushFinding = (ruleId, message) => {
        if (!findings.some((f) => f.ruleId === ruleId && f.message === message)) {
            findings.push({ ruleId, message });
        }
    };

    const commentStripped = stripJsCommentsPreservingLiterals(source);
    const runtimeCode = stripTypeOnlyDeclarationsForScan(commentStripped);

    for (const impFinding of scanAmbientImports(runtimeCode, allowPureRelativeImports)) {
        pushFinding(impFinding.ruleId, impFinding.message);
    }

    // Direct `process.*` and `globalThis.process` host escape vectors
    if (
        /\bprocess\s*\.\s*(?:env|exit|binding|dlopen|kill|mainModule|chdir|umask|cwd)\b/.test(runtimeCode) ||
        /\bprocess\s*\[\s*['"`](?:env|exit|binding|dlopen|kill|mainModule)['"`]\s*\]/.test(runtimeCode) ||
        /\b(?:globalThis|global)\s*(?:\.\s*process\b|\[\s*['"`]process['"`]\s*\])/.test(runtimeCode)
    ) {
        pushFinding(
            'AMBIENT_PROCESS_FORBIDDEN',
            'Direct process access (process.env, process.exit, process.binding, process.dlopen) is forbidden; inject configuration via binding'
        );
    }

    // Ambient network globals (`globalThis.fetch`, bare `fetch(`, `XMLHttpRequest`, `WebSocket`)
    if (
        /\b(?:globalThis|global|window|self)\s*(?:\.\s*fetch\b|\[\s*['"`]fetch['"`]\s*\])/.test(runtimeCode) ||
        /(?<!(?:\.\s*|\?\.\s*|function\s+))\bfetch\s*\(/.test(runtimeCode) ||
        /\bXMLHttpRequest\b/.test(runtimeCode) ||
        /\b(?:globalThis|global|window|self)\s*\.\s*WebSocket\b/.test(runtimeCode) ||
        /(?<!(?:\.\s*|\?\.\s*|function\s+|class\s+))\bWebSocket\b/.test(runtimeCode)
    ) {
        pushFinding(
            'AMBIENT_NETWORK_FORBIDDEN',
            'Ambient network I/O (fetch, XMLHttpRequest, WebSocket) is forbidden; inject network capability ports via binding'
        );
    }

    // Dynamic code generation (`eval(`, `new Function(`, `Function(`, `.constructor.constructor`)
    if (
        /(?<!(?:\.\s*|\?\.\s*|function\s+))\beval\s*\(/.test(runtimeCode) ||
        /\b(?:globalThis|global|window|self)\s*\.\s*eval\b/.test(runtimeCode) ||
        /\(\s*0\s*,\s*eval\s*\)/.test(runtimeCode) ||
        /\bnew\s+Function\s*\(/.test(runtimeCode) ||
        /(?<!(?:\.\s*|\?\.\s*|function\s+))\bFunction\s*\(/.test(runtimeCode) ||
        /\.\s*constructor\s*\.\s*constructor\b/.test(runtimeCode)
    ) {
        pushFinding(
            'DYNAMIC_CODE_FORBIDDEN',
            'Dynamic code evaluation (eval, Function constructor) is forbidden inside sealed bricks'
        );
    }

    // Zero-Leak check on full raw `source` (including comments and string literals)
    const scrubbed = scrubSensitiveText(source, {
        redactEmails: false,
        redactPaths: true,
        redactPrivateNetwork: true,
    });
    if (scrubbed !== source) {
        if (
            scrubbed.includes(DEFAULT_SCRUB_MARKERS.secret) ||
            scrubbed.includes(DEFAULT_SCRUB_MARKERS.token) ||
            scrubbed.includes(DEFAULT_SCRUB_MARKERS.credentials)
        ) {
            pushFinding(
                'ZERO_LEAK_VIOLATION',
                'Source contains embedded secret key, token, or credential material'
            );
        }
        if (scrubbed.includes(DEFAULT_SCRUB_MARKERS.localPath)) {
            pushFinding(
                'ZERO_LEAK_VIOLATION',
                'Source contains hardcoded host user or mount filesystem path'
            );
        }
        if (
            scrubbed.includes(DEFAULT_SCRUB_MARKERS.privateUrl) ||
            scrubbed.includes(DEFAULT_SCRUB_MARKERS.privateHost)
        ) {
            pushFinding(
                'ZERO_LEAK_VIOLATION',
                'Source contains hardcoded private, loopback, or internal network host/IP'
            );
        }
        if (!findings.some((f) => f.ruleId === 'ZERO_LEAK_VIOLATION')) {
            pushFinding('ZERO_LEAK_VIOLATION', 'Source failed Zero-Leak sensitive text scan');
        }
    }

    if (SECRET_PREFIX_LEAK_RE.test(source)) {
        pushFinding(
            'ZERO_LEAK_VIOLATION',
            'Source contains secret API key prefix or private key header'
        );
    }
    if (LOCAL_FS_DIR_LEAK_RE.test(source)) {
        pushFinding(
            'ZERO_LEAK_VIOLATION',
            'Source contains hardcoded host user or mount filesystem path'
        );
    }
    if (PRIVATE_IPV4_LEAK_RE.test(source)) {
        pushFinding(
            'ZERO_LEAK_VIOLATION',
            'Source contains hardcoded RFC1918 or CGNAT private IPv4 literal'
        );
    }

    if (findings.length > 0) {
        return errorEnvelope(
            'BRICK_SAFETY_FAILED',
            `Brick source failed safety scan (${findings.length} finding(s)): ${findings[0].message}`,
            { clean: false, findings },
            tool
        );
    }

    return okEnvelope(
        tool,
        'Brick source passed zero-ambient-I/O and zero-leak safety scan',
        { clean: true, findings: [], byteLength }
    );
}

/**
 * Advance past whitespace and JS comments starting at `startIdx`.
 *
 * @param {string} code
 * @param {number} startIdx
 * @returns {number}
 */
function skipWhitespaceAndComments(code, startIdx) {
    const len = code.length;
    let i = startIdx;
    while (i < len) {
        const ch = code[i];
        if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v') {
            i += 1;
            continue;
        }
        if (ch === '/' && code[i + 1] === '/') {
            i += 2;
            while (i < len && code[i] !== '\n') i += 1;
            continue;
        }
        if (ch === '/' && code[i + 1] === '*') {
            i += 2;
            while (i < len && !(code[i] === '*' && code[i + 1] === '/')) i += 1;
            i = Math.min(len, i + 2);
            continue;
        }
        break;
    }
    return i;
}

function readIdentifierAt(code, idx) {
    if (idx >= code.length || !isIdentStart(code.charCodeAt(idx))) {
        return null;
    }
    let end = idx + 1;
    while (end < code.length && isIdentPart(code.charCodeAt(end))) {
        end += 1;
    }
    return { name: code.slice(idx, end), end };
}

/**
 * Extract bound variable names from a `const` / `let` / `var` declaration list starting right after
 * the declaration keyword (`const`, `let`, `var`).
 *
 * @param {string} code
 * @param {number} startIdx
 * @returns {string[]}
 */
function extractDeclaredBindingNames(code, startIdx) {
    const names = [];
    const len = code.length;
    let i = skipWhitespaceAndComments(code, startIdx);

    const skipBalancedOrLiteral = (idx) => {
        const ch = code[idx];
        if (ch === "'" || ch === '"') {
            let p = idx + 1;
            while (p < len) {
                if (code[p] === '\\') {
                    p += 2;
                    continue;
                }
                if (code[p] === ch) return p + 1;
                p += 1;
            }
            return len;
        }
        if (ch === '`') {
            let p = idx + 1;
            let depth = 0;
            while (p < len) {
                if (code[p] === '\\') {
                    p += 2;
                    continue;
                }
                if (code[p] === '`' && depth === 0) return p + 1;
                if (code[p] === '$' && code[p + 1] === '{') {
                    depth += 1;
                    p += 2;
                    continue;
                }
                if (code[p] === '{' && depth > 0) depth += 1;
                else if (code[p] === '}' && depth > 0) depth -= 1;
                p += 1;
            }
            return len;
        }
        return idx + 1;
    };

    const collectPatternIds = (fromIdx) => {
        let p = skipWhitespaceAndComments(code, fromIdx);
        if (p >= len) return p;
        if (code[p] === '{') {
            p += 1;
            while (p < len) {
                p = skipWhitespaceAndComments(code, p);
                if (code[p] === '}') return p + 1;
                if (code.slice(p, p + 3) === '...') {
                    p = collectPatternIds(p + 3);
                    continue;
                }
                const keyIdent = readIdentifierAt(code, p);
                if (!keyIdent) {
                    p = skipBalancedOrLiteral(p);
                    continue;
                }
                p = skipWhitespaceAndComments(code, keyIdent.end);
                if (code[p] === ':') {
                    p = collectPatternIds(p + 1);
                } else {
                    names.push(keyIdent.name);
                }
                p = skipWhitespaceAndComments(code, p);
                if (code[p] === '=') {
                    p = skipInitializerExpression(p + 1, true);
                }
                p = skipWhitespaceAndComments(code, p);
                if (code[p] === ',') p += 1;
            }
            return p;
        }
        if (code[p] === '[') {
            p += 1;
            while (p < len) {
                p = skipWhitespaceAndComments(code, p);
                if (code[p] === ']') return p + 1;
                if (code[p] === ',') {
                    p += 1;
                    continue;
                }
                if (code.slice(p, p + 3) === '...') {
                    p = collectPatternIds(p + 3);
                    continue;
                }
                p = collectPatternIds(p);
                p = skipWhitespaceAndComments(code, p);
                if (code[p] === '=') {
                    p = skipInitializerExpression(p + 1, true);
                }
                p = skipWhitespaceAndComments(code, p);
                if (code[p] === ',') p += 1;
            }
            return p;
        }
        const id = readIdentifierAt(code, p);
        if (id) {
            names.push(id.name);
            return id.end;
        }
        return p;
    };

    const skipInitializerExpression = (fromIdx, insidePattern) => {
        let p = fromIdx;
        let depth = 0;
        while (p < len) {
            p = skipWhitespaceAndComments(code, p);
            if (p >= len) break;
            const ch = code[p];
            if (ch === "'" || ch === '"' || ch === '`') {
                p = skipBalancedOrLiteral(p);
                continue;
            }
            if (ch === '(' || ch === '{' || ch === '[') {
                depth += 1;
                p += 1;
                continue;
            }
            if (ch === ')' || ch === '}' || ch === ']') {
                if (depth === 0) return p;
                depth -= 1;
                p += 1;
                continue;
            }
            if (depth === 0 && (ch === ',' || (!insidePattern && ch === ';'))) {
                return p;
            }
            if (depth === 0 && !insidePattern && ch === '\n') {
                const nextTok = skipWhitespaceAndComments(code, p + 1);
                const nextWord = readIdentifierAt(code, nextTok);
                if (
                    nextWord &&
                    (nextWord.name === 'export' ||
                        nextWord.name === 'const' ||
                        nextWord.name === 'let' ||
                        nextWord.name === 'var' ||
                        nextWord.name === 'function' ||
                        nextWord.name === 'async' ||
                        nextWord.name === 'class' ||
                        nextWord.name === 'return')
                ) {
                    return p;
                }
            }
            p += 1;
        }
        return p;
    };

    while (i < len) {
        i = collectPatternIds(i);
        i = skipWhitespaceAndComments(code, i);
        if (code[i] === '=') {
            i = skipInitializerExpression(i + 1, false);
        }
        i = skipWhitespaceAndComments(code, i);
        if (code[i] === ',') {
            i += 1;
            i = skipWhitespaceAndComments(code, i);
            continue;
        }
        break;
    }

    return names;
}

/**
 * Strip TypeScript types (`node:module` `stripTypeScriptTypes`) and convert ESM `export` declarations
 * into CommonJS `module.exports` / `exports` assignments so brick code runs inside a hermetic `vm.Script`.
 *
 * @param {string} source - JS or TS brick source text
 * @returns {string} CommonJS source code
 */
export function transpileBrickSourceToCjs(source) {
    let code = String(source ?? '');
    if (typeof nodeModule.stripTypeScriptTypes === 'function') {
        code = nodeModule.stripTypeScriptTypes(code, { mode: 'strip' });
    }

    const len = code.length;
    const edits = [];
    const exportedBindings = [];

    let i = 0;
    let canStartRegex = true;
    let braceDepth = 0;
    let parenDepth = 0;
    let bracketDepth = 0;
    const templateBraceStack = [];

    while (i < len) {
        const ch = code[i];
        const next = i + 1 < len ? code[i + 1] : '';

        if (ch === '/' && next === '/') {
            i += 2;
            while (i < len && code[i] !== '\n') i += 1;
            continue;
        }
        if (ch === '/' && next === '*') {
            i += 2;
            while (i < len && !(code[i] === '*' && code[i + 1] === '/')) i += 1;
            i = Math.min(len, i + 2);
            continue;
        }
        if (ch === "'" || ch === '"') {
            const q = ch;
            i += 1;
            while (i < len) {
                if (code[i] === '\\') {
                    i += 2;
                    continue;
                }
                if (code[i] === q) {
                    i += 1;
                    break;
                }
                i += 1;
            }
            canStartRegex = false;
            continue;
        }
        if (ch === '`') {
            const dummy = [];
            i = consumeTemplateBody(code, i + 1, dummy, templateBraceStack, braceDepth);
            canStartRegex = templateBraceStack.length > 0;
            continue;
        }
        if (ch === '}' && templateBraceStack.length > 0 && braceDepth === templateBraceStack[templateBraceStack.length - 1]) {
            templateBraceStack.pop();
            const dummy = [];
            i = consumeTemplateBody(code, i + 1, dummy, templateBraceStack, braceDepth);
            canStartRegex = templateBraceStack.length > 0;
            continue;
        }
        if (ch === '/' && canStartRegex && next !== '/' && next !== '*') {
            i += 1;
            let inCharClass = false;
            while (i < len) {
                const c = code[i];
                i += 1;
                if (c === '\\') {
                    i += 1;
                    continue;
                }
                if (c === '[') inCharClass = true;
                else if (c === ']') inCharClass = false;
                else if (c === '/' && !inCharClass) {
                    while (i < len && isIdentPart(code.charCodeAt(i))) i += 1;
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
            while (i < len && isIdentPart(code.charCodeAt(i))) i += 1;
            const word = code.slice(start, i);

            // Transform top-level `export` statements
            const prevChar = start > 0 ? code[start - 1] : '';
            if (
                word === 'export' &&
                braceDepth === 0 &&
                parenDepth === 0 &&
                bracketDepth === 0 &&
                templateBraceStack.length === 0 &&
                prevChar !== '.'
            ) {
                const afterExport = skipWhitespaceAndComments(code, i);
                if (code[afterExport] === '{') {
                    let closeBrace = afterExport + 1;
                    while (closeBrace < len && code[closeBrace] !== '}') closeBrace += 1;
                    if (closeBrace < len) {
                        const rawSpecifiers = stripJsCommentsPreservingLiterals(
                            code.slice(afterExport + 1, closeBrace)
                        );
                        for (const rawPart of rawSpecifiers.split(',')) {
                            const part = rawPart.trim();
                            if (!part || part.startsWith('type ')) continue;
                            const specMatch = /^([A-Za-z_$][A-Za-z0-9_$]*)(?:\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*|default))?$/.exec(part);
                            if (specMatch) {
                                exportedBindings.push({
                                    local: specMatch[1],
                                    exported: specMatch[2] || specMatch[1],
                                });
                            }
                        }
                        let stmtEnd = skipWhitespaceAndComments(code, closeBrace + 1);
                        if (code[stmtEnd] === ';') stmtEnd += 1;
                        edits.push({ start, end: stmtEnd, replacement: '' });
                        i = stmtEnd;
                        canStartRegex = true;
                        continue;
                    }
                } else {
                    const kw = readIdentifierAt(code, afterExport);
                    if (kw?.name === 'default') {
                        const afterDefault = skipWhitespaceAndComments(code, kw.end);
                        const nextId = readIdentifierAt(code, afterDefault);
                        let namedDecl = null;

                        if (nextId?.name === 'async') {
                            const afterAsync = skipWhitespaceAndComments(code, nextId.end);
                            const fnKw = readIdentifierAt(code, afterAsync);
                            if (fnKw?.name === 'function') {
                                let afterFn = skipWhitespaceAndComments(code, fnKw.end);
                                if (code[afterFn] === '*') afterFn = skipWhitespaceAndComments(code, afterFn + 1);
                                const fnName = readIdentifierAt(code, afterFn);
                                if (fnName) namedDecl = fnName.name;
                            }
                        } else if (nextId?.name === 'function') {
                            let afterFn = skipWhitespaceAndComments(code, nextId.end);
                            if (code[afterFn] === '*') afterFn = skipWhitespaceAndComments(code, afterFn + 1);
                            const fnName = readIdentifierAt(code, afterFn);
                            if (fnName) namedDecl = fnName.name;
                        } else if (nextId?.name === 'class') {
                            const afterClass = skipWhitespaceAndComments(code, nextId.end);
                            const clsName = readIdentifierAt(code, afterClass);
                            if (clsName && clsName.name !== 'extends') namedDecl = clsName.name;
                        }

                        if (namedDecl) {
                            edits.push({ start, end: afterDefault, replacement: '' });
                            exportedBindings.push({ local: namedDecl, exported: 'default' });
                        } else {
                            edits.push({
                                start,
                                end: kw.end,
                                replacement: '__brickCjsTarget.default =',
                            });
                        }
                        i = kw.end;
                        canStartRegex = true;
                        continue;
                    }

                    if (kw?.name === 'async') {
                        const afterAsync = skipWhitespaceAndComments(code, kw.end);
                        const fnKw = readIdentifierAt(code, afterAsync);
                        if (fnKw?.name === 'function') {
                            let afterFn = skipWhitespaceAndComments(code, fnKw.end);
                            if (code[afterFn] === '*') afterFn = skipWhitespaceAndComments(code, afterFn + 1);
                            const fnName = readIdentifierAt(code, afterFn);
                            if (fnName) {
                                edits.push({ start, end: afterExport, replacement: '' });
                                exportedBindings.push({ local: fnName.name, exported: fnName.name });
                            }
                        }
                    } else if (kw?.name === 'function') {
                        let afterFn = skipWhitespaceAndComments(code, kw.end);
                        if (code[afterFn] === '*') afterFn = skipWhitespaceAndComments(code, afterFn + 1);
                        const fnName = readIdentifierAt(code, afterFn);
                        if (fnName) {
                            edits.push({ start, end: afterExport, replacement: '' });
                            exportedBindings.push({ local: fnName.name, exported: fnName.name });
                        }
                    } else if (kw?.name === 'class') {
                        const afterClass = skipWhitespaceAndComments(code, kw.end);
                        const clsName = readIdentifierAt(code, afterClass);
                        if (clsName) {
                            edits.push({ start, end: afterExport, replacement: '' });
                            exportedBindings.push({ local: clsName.name, exported: clsName.name });
                        }
                    } else if (kw?.name === 'const' || kw?.name === 'let' || kw?.name === 'var') {
                        const boundNames = extractDeclaredBindingNames(code, kw.end);
                        edits.push({ start, end: afterExport, replacement: '' });
                        for (const bName of boundNames) {
                            exportedBindings.push({ local: bName, exported: bName });
                        }
                    }
                }
            }

            canStartRegex = REGEX_PRECEDING_KEYWORDS.has(word);
            continue;
        }

        if (ch >= '0' && ch <= '9') {
            while (i < len && (isIdentPart(code.charCodeAt(i)) || code[i] === '.')) i += 1;
            canStartRegex = false;
            continue;
        }

        if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v') {
            i += 1;
            continue;
        }

        if (ch === '{') {
            braceDepth += 1;
            canStartRegex = true;
        } else if (ch === '}') {
            braceDepth = Math.max(0, braceDepth - 1);
            canStartRegex = false;
        } else if (ch === '(') {
            parenDepth += 1;
            canStartRegex = true;
        } else if (ch === ')') {
            parenDepth = Math.max(0, parenDepth - 1);
            canStartRegex = false;
        } else if (ch === '[') {
            bracketDepth += 1;
            canStartRegex = true;
        } else if (ch === ']') {
            bracketDepth = Math.max(0, bracketDepth - 1);
            canStartRegex = false;
        } else if ((ch === '+' && next === '+') || (ch === '-' && next === '-')) {
            i += 2;
            canStartRegex = false;
            continue;
        } else {
            canStartRegex = true;
        }

        i += 1;
    }

    if (edits.length === 0 && exportedBindings.length === 0) {
        return code;
    }

    let cursor = 0;
    const chunks = [
        'const __brickCjsTarget = typeof module !== "undefined" && module && typeof module.exports === "object" ? module.exports : exports;\n',
    ];
    for (const edit of edits) {
        if (edit.start >= cursor) {
            chunks.push(code.slice(cursor, edit.start));
            chunks.push(edit.replacement);
            cursor = edit.end;
        }
    }
    chunks.push(code.slice(cursor));
    chunks.push('\n');
    for (const item of exportedBindings) {
        chunks.push(`__brickCjsTarget[${JSON.stringify(item.exported)}] = ${item.local};\n`);
    }

    return chunks.join('');
}

function hasFunctionValues(value, seen = new WeakSet()) {
    if (typeof value === 'function') return true;
    if (value === null || typeof value !== 'object') return false;
    if (seen.has(value)) return false;
    seen.add(value);
    if (Array.isArray(value)) {
        return value.some((item) => hasFunctionValues(item, seen));
    }
    for (const key of Object.keys(value)) {
        if (FORBIDDEN_PROTO_KEYS.has(key)) continue;
        if (hasFunctionValues(value[key], seen)) return true;
    }
    return false;
}

function isMemoryExhaustionSignal(stderrText, exitCode, signal) {
    if (
        /heap out of memory|Fatal process out of memory|Allocation failed|zone out of memory|ArrayBuffer allocation failed/i.test(
            stderrText
        )
    ) {
        return true;
    }
    if (signal === 'SIGABRT' || exitCode === 134) {
        return true;
    }
    return false;
}

function executeInPermissionSubprocess({
    cjsCode,
    exportName,
    input,
    binding,
    safeTimeoutMs,
    safeMaxMemoryMb,
    startNs,
}) {
    const tool = 'brick-exchange.sandbox';
    const isolationMode = 'subprocess-permission';

    let stdinPayload;
    try {
        stdinPayload = JSON.stringify({
            cjsCode,
            exportName,
            hasUndefinedInput: input === undefined,
            input: input === undefined ? null : input,
            bindingData: binding ?? {},
            vmTimeoutMs: safeTimeoutMs,
        });
    } catch (err) {
        return Promise.resolve(
            errorEnvelope(
                'SANDBOX_EXECUTION_ERROR',
                `Sandbox input/binding must be JSON-serializable: ${err instanceof Error ? err.message : String(err)}`,
                { isolationMode },
                tool
            )
        );
    }

    const payloadBytes = Buffer.byteLength(stdinPayload, 'utf8');
    if (payloadBytes > MAX_STDIN_PAYLOAD_BYTES) {
        return Promise.resolve(
            errorEnvelope(
                'SANDBOX_EXECUTION_ERROR',
                `Sandbox stdin payload (${payloadBytes} bytes) exceeds ${MAX_STDIN_PAYLOAD_BYTES} byte limit`,
                { byteLength: payloadBytes, maxBytes: MAX_STDIN_PAYLOAD_BYTES, isolationMode },
                tool
            )
        );
    }

    return new Promise((resolve) => {
        let settled = false;
        let killedByWallClock = false;
        let streamOverflow = false;
        const stdoutChunks = [];
        const stderrChunks = [];
        let stdoutBytes = 0;
        let stderrBytes = 0;

        const child = spawn(
            process.execPath,
            [
                '--no-warnings',
                '--permission',
                '--disallow-code-generation-from-strings',
                `--max-old-space-size=${safeMaxMemoryMb}`,
                '-e',
                WORKER_BOOTSTRAP_CODE,
            ],
            {
                stdio: ['pipe', 'pipe', 'pipe'],
                env: { PATH: '' },
            }
        );

        const wallClockLimitMs = safeTimeoutMs + 250;
        const killTimer = setTimeout(() => {
            killedByWallClock = true;
            try {
                child.kill('SIGKILL');
            } catch {
                // Ignore if already exited
            }
        }, wallClockLimitMs);
        killTimer.unref?.();

        const finish = (envelope) => {
            if (settled) return;
            settled = true;
            clearTimeout(killTimer);
            resolve(envelope);
        };

        child.stdout.on('data', (chunk) => {
            stdoutBytes += chunk.length;
            if (stdoutBytes > MAX_CHILD_STREAM_BYTES) {
                streamOverflow = true;
                try {
                    child.kill('SIGKILL');
                } catch {
                    // Ignore
                }
                return;
            }
            stdoutChunks.push(chunk);
        });

        child.stderr.on('data', (chunk) => {
            stderrBytes += chunk.length;
            if (stderrBytes <= MAX_CHILD_STREAM_BYTES) {
                stderrChunks.push(chunk);
            }
        });

        child.on('error', (err) => {
            const durationMs = Number((Number(process.hrtime.bigint() - startNs) / 1e6).toFixed(2));
            finish(
                errorEnvelope(
                    'SANDBOX_EXECUTION_ERROR',
                    `Failed to spawn permission sandbox: ${err?.message || String(err)}`,
                    { durationMs, isolationMode },
                    tool
                )
            );
        });

        child.on('close', (exitCode, signal) => {
            const durationMs = Number((Number(process.hrtime.bigint() - startNs) / 1e6).toFixed(2));
            const stderrText = Buffer.concat(stderrChunks).toString('utf8').trim();
            const stdoutText = Buffer.concat(stdoutChunks).toString('utf8').trim();

            if (streamOverflow) {
                finish(
                    errorEnvelope(
                        'SANDBOX_MEMORY_LIMIT',
                        `Sandbox output exceeded ${MAX_CHILD_STREAM_BYTES} byte limit`,
                        { durationMs, isolationMode },
                        tool
                    )
                );
                return;
            }

            if (isMemoryExhaustionSignal(stderrText, exitCode, signal)) {
                finish(
                    errorEnvelope(
                        'SANDBOX_MEMORY_LIMIT',
                        `Brick execution exceeded memory limit (${safeMaxMemoryMb}MB)`,
                        { maxMemoryMb: safeMaxMemoryMb, durationMs, isolationMode },
                        tool
                    )
                );
                return;
            }

            if (killedByWallClock) {
                finish(
                    errorEnvelope(
                        'SANDBOX_TIMEOUT',
                        `Brick execution exceeded sandbox wall-clock timeout (${safeTimeoutMs}ms)`,
                        { timeoutMs: safeTimeoutMs, durationMs, isolationMode },
                        tool
                    )
                );
                return;
            }

            if (stdoutText.length > 0) {
                const lines = stdoutText.split('\n');
                const lastLine = lines[lines.length - 1];
                try {
                    const parsed = JSON.parse(lastLine);
                    if (parsed && parsed.ok === true) {
                        const output = parsed.hasUndefined ? undefined : parsed.output;
                        finish(
                            okEnvelope(tool, 'Executed brick in isolated sandbox', {
                                output,
                                durationMs,
                                isolationMode,
                            })
                        );
                        return;
                    }
                    if (parsed && parsed.ok === false) {
                        const errCode =
                            parsed.code === 'SANDBOX_TIMEOUT'
                                ? 'SANDBOX_TIMEOUT'
                                : parsed.code === 'SANDBOX_MEMORY_LIMIT'
                                  ? 'SANDBOX_MEMORY_LIMIT'
                                  : 'SANDBOX_EXECUTION_ERROR';
                        finish(
                            errorEnvelope(
                                errCode,
                                String(parsed.message || 'Brick execution failed'),
                                { durationMs, isolationMode },
                                tool
                            )
                        );
                        return;
                    }
                } catch {
                    // Fall through to generic crash error below
                }
            }

            finish(
                errorEnvelope(
                    'SANDBOX_EXECUTION_ERROR',
                    stderrText || `Sandbox process exited unexpectedly (code=${String(exitCode)}, signal=${String(signal)})`,
                    { exitCode, signal, durationMs, isolationMode },
                    tool
                )
            );
        });

        child.stdin.on('error', () => {
            // Child may exit early on syntax error before consuming full stdin
        });
        child.stdin.end(stdinPayload);
    });
}

function normalizeVmOutputToHostRealm(value, seen = new WeakSet()) {
    if (value === null || value === undefined || typeof value !== 'object') {
        return value;
    }
    if (seen.has(value)) {
        return null;
    }
    seen.add(value);
    try {
        if (Array.isArray(value)) {
            const outArr = [];
            for (let idx = 0; idx < value.length; idx += 1) {
                outArr.push(normalizeVmOutputToHostRealm(value[idx], seen));
            }
            return outArr;
        }
        const tag = Object.prototype.toString.call(value);
        if (tag === '[object Date]') {
            return new Date(Number(value));
        }
        if (tag === '[object RegExp]') {
            return new RegExp(value.source, value.flags);
        }
        if (ArrayBuffer.isView(value)) {
            return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
        }
        if (tag === '[object Map]') {
            const outMap = new Map();
            for (const [k, v] of value.entries()) {
                outMap.set(
                    normalizeVmOutputToHostRealm(k, seen),
                    normalizeVmOutputToHostRealm(v, seen)
                );
            }
            return outMap;
        }
        if (tag === '[object Set]') {
            const outSet = new Set();
            for (const item of value.values()) {
                outSet.add(normalizeVmOutputToHostRealm(item, seen));
            }
            return outSet;
        }
        const outObj = {};
        for (const key of Object.keys(value)) {
            if (FORBIDDEN_PROTO_KEYS.has(key)) continue;
            outObj[key] = normalizeVmOutputToHostRealm(value[key], seen);
        }
        return outObj;
    } finally {
        seen.delete(value);
    }
}

async function executeInVmPortBridge({
    cjsCode,
    exportName,
    input,
    binding,
    safeTimeoutMs,
    startNs,
}) {
    const tool = 'brick-exchange.sandbox';
    const isolationMode = 'vm-port-bridge';

    const sandboxGlobals = {
        TextEncoder,
        TextDecoder,
        URL,
        URLSearchParams,
        structuredClone,
        fetch: undefined,
        process: undefined,
        require: undefined,
        WebSocket: undefined,
        setTimeout: undefined,
        setInterval: undefined,
        clearTimeout: undefined,
        clearInterval: undefined,
        setImmediate: undefined,
        clearImmediate: undefined,
        __injectedInput: input,
        __injectedBinding: binding ?? {},
        __exportName: exportName,
    };

    const ctx = vm.createContext(sandboxGlobals, {
        codeGeneration: { strings: false, wasm: false },
    });

    const runnerSource =
        '(function () {\n' +
        '  const module = { exports: {} };\n' +
        '  const exports = module.exports;\n' +
        cjsCode + '\n;\n' +
        '  const __modOut = module.exports;\n' +
        '  let __fn = undefined;\n' +
        '  if (__exportName === "default") {\n' +
        '    if (typeof __modOut === "function") { __fn = __modOut; }\n' +
        '    else if (__modOut && (typeof __modOut === "object" || typeof __modOut === "function") && typeof __modOut.default === "function") { __fn = __modOut.default; }\n' +
        '  } else if (__modOut && (typeof __modOut === "object" || typeof __modOut === "function") && typeof __modOut[__exportName] === "function") {\n' +
        '    __fn = __modOut[__exportName];\n' +
        '  }\n' +
        '  if (typeof __fn !== "function") {\n' +
        '    throw new TypeError("Export " + __exportName + " is not a function on brick module");\n' +
        '  }\n' +
        '  return __fn(__injectedInput, __injectedBinding);\n' +
        '})()';

    let timer = null;
    try {
        const script = new vm.Script(runnerSource, { filename: 'brick.port-bridge.cjs' });
        const rawOut = script.runInContext(ctx, { timeout: safeTimeoutMs });

        let output = rawOut;
        if (
            rawOut !== null &&
            (typeof rawOut === 'object' || typeof rawOut === 'function') &&
            typeof rawOut.then === 'function'
        ) {
            const timeoutGuard = new Promise((_, reject) => {
                timer = setTimeout(() => {
                    const err = new Error(`Async brick execution timed out after ${safeTimeoutMs}ms`);
                    err.code = 'ERR_SCRIPT_EXECUTION_TIMEOUT';
                    reject(err);
                }, safeTimeoutMs);
                timer.unref?.();
            });
            output = await Promise.race([rawOut, timeoutGuard]);
        }

        const hostOutput = normalizeVmOutputToHostRealm(output);
        const durationMs = Number((Number(process.hrtime.bigint() - startNs) / 1e6).toFixed(2));
        return okEnvelope(tool, 'Executed brick in isolated sandbox', {
            output: hostOutput,
            durationMs,
            isolationMode,
        });
    } catch (err) {
        const durationMs = Number((Number(process.hrtime.bigint() - startNs) / 1e6).toFixed(2));
        const msg = err && err.message ? String(err.message) : String(err);
        const isTimeout =
            (err && err.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') ||
            /Script execution timed out/i.test(msg);
        return errorEnvelope(
            isTimeout ? 'SANDBOX_TIMEOUT' : 'SANDBOX_EXECUTION_ERROR',
            msg,
            { durationMs, isolationMode },
            tool
        );
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/**
 * Execute a TypeScript or JavaScript brick inside a zero-ambient-I/O sandbox (`INV-LEGO-35`).
 *
 * Uses a Node 22 `--permission` subprocess (`subprocess-permission`) with zero filesystem,
 * child-process, worker, or native-addon capabilities for JSON data bindings, and falls back
 * to a locked `vm.createContext` (`vm-port-bridge`) when capability-port functions are injected.
 *
 * @param {{
 *   source: string,
 *   exportName?: string,
 *   input?: unknown,
 *   binding?: Record<string, unknown>,
 *   timeoutMs?: number,
 *   maxMemoryMb?: number,
 *   customRunner?: Function | null,
 *   useSubprocess?: boolean
 * }} [options={}]
 */
export async function executeInBrickSandbox({
    source,
    exportName = 'default',
    input,
    binding = {},
    timeoutMs = DEFAULT_SANDBOX_TIMEOUT_MS,
    maxMemoryMb = DEFAULT_SANDBOX_MAX_MEMORY_MB,
    customRunner = null,
    useSubprocess = true,
} = {}) {
    const tool = 'brick-exchange.sandbox';
    const startNs = process.hrtime.bigint();

    const safety = scanBrickSourceSafety(source);
    if (!safety.ok) {
        return errorEnvelope(
            'BRICK_UNSAFE_SOURCE',
            safety.error.message,
            safety.error.details,
            tool
        );
    }

    const rawTimeout = Number(timeoutMs);
    const safeTimeoutMs =
        Number.isFinite(rawTimeout) && rawTimeout > 0
            ? Math.max(5, Math.min(30_000, Math.trunc(rawTimeout)))
            : DEFAULT_SANDBOX_TIMEOUT_MS;

    const rawMem = Number(maxMemoryMb);
    const safeMaxMemoryMb =
        Number.isFinite(rawMem) && rawMem > 0
            ? Math.max(16, Math.min(512, Math.trunc(rawMem)))
            : DEFAULT_SANDBOX_MAX_MEMORY_MB;

    const safeExportName =
        typeof exportName === 'string' && exportName.trim().length > 0
            ? exportName.trim()
            : 'default';

    if (typeof customRunner === 'function') {
        let timer = null;
        try {
            const timeoutGuard = new Promise((_, reject) => {
                timer = setTimeout(() => {
                    const err = new Error(`Custom sandbox runner timed out after ${safeTimeoutMs}ms`);
                    err.code = 'SANDBOX_TIMEOUT';
                    reject(err);
                }, safeTimeoutMs);
                timer.unref?.();
            });
            const runnerOut = await Promise.race([
                Promise.resolve(
                    customRunner({
                        source,
                        exportName: safeExportName,
                        input,
                        binding,
                        timeoutMs: safeTimeoutMs,
                        maxMemoryMb: safeMaxMemoryMb,
                    })
                ),
                timeoutGuard,
            ]);
            const durationMs = Number((Number(process.hrtime.bigint() - startNs) / 1e6).toFixed(2));

            if (
                runnerOut &&
                typeof runnerOut === 'object' &&
                typeof runnerOut.ok === 'boolean' &&
                runnerOut.tool === tool
            ) {
                return runnerOut;
            }
            if (
                runnerOut &&
                typeof runnerOut === 'object' &&
                runnerOut.ok === false &&
                runnerOut.error &&
                typeof runnerOut.error === 'object'
            ) {
                return errorEnvelope(
                    runnerOut.error.code || 'SANDBOX_EXECUTION_ERROR',
                    runnerOut.error.message || runnerOut.summary || 'Custom sandbox runner failed',
                    runnerOut.error.details ?? { durationMs, isolationMode: 'custom-runner' },
                    tool
                );
            }

            return okEnvelope(tool, 'Executed brick in isolated sandbox', {
                output: runnerOut,
                durationMs,
                isolationMode: 'custom-runner',
            });
        } catch (err) {
            const durationMs = Number((Number(process.hrtime.bigint() - startNs) / 1e6).toFixed(2));
            const code = err?.code === 'SANDBOX_TIMEOUT' ? 'SANDBOX_TIMEOUT' : 'SANDBOX_EXECUTION_ERROR';
            return errorEnvelope(
                code,
                err instanceof Error ? err.message : String(err),
                { durationMs, isolationMode: 'custom-runner' },
                tool
            );
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    let cjsCode;
    try {
        cjsCode = transpileBrickSourceToCjs(source);
    } catch (err) {
        const durationMs = Number((Number(process.hrtime.bigint() - startNs) / 1e6).toFixed(2));
        return errorEnvelope(
            'SANDBOX_EXECUTION_ERROR',
            `Failed to transpile brick source: ${err instanceof Error ? err.message : String(err)}`,
            { phase: 'transpile', durationMs },
            tool
        );
    }

    if (useSubprocess !== false && !hasFunctionValues(binding)) {
        return executeInPermissionSubprocess({
            cjsCode,
            exportName: safeExportName,
            input,
            binding,
            safeTimeoutMs,
            safeMaxMemoryMb,
            startNs,
        });
    }

    return executeInVmPortBridge({
        cjsCode,
        exportName: safeExportName,
        input,
        binding,
        safeTimeoutMs,
        startNs,
    });
}

function matchesExpectedSubset(actual, subset) {
    if (!isPlainObject(subset)) return true;
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) {
        return false;
    }
    const keys = Object.keys(subset);
    if (keys.length === 0) {
        return isPlainObject(actual) && Object.keys(actual).length === 0;
    }
    for (const key of keys) {
        if (!(key in actual)) return false;
        const expectedVal = subset[key];
        const actualVal = actual[key];
        if (isPlainObject(expectedVal) && Object.keys(expectedVal).length > 0) {
            if (!matchesExpectedSubset(actualVal, expectedVal)) return false;
        } else if (canonicalBrickHash(actualVal) !== canonicalBrickHash(expectedVal)) {
            return false;
        }
    }
    return true;
}

function compileUsableSchema(schemaCandidate, label, issues) {
    if (!schemaCandidate || typeof schemaCandidate !== 'object' || Array.isArray(schemaCandidate)) {
        issues.push(`Blueprint ${label} must be a valid schema object or s.* builder`);
        return null;
    }
    try {
        const compiledJsonSchema = toJsonSchema(schemaCandidate);
        const probe = validateSchema(schemaCandidate, undefined, { tool: 'brick-exchange.verify' });
        if (!probe.ok && probe.error?.code === 'INVALID_SCHEMA') {
            issues.push(`Blueprint ${label} failed schema validation check: ${probe.error.message}`);
            return null;
        }
        return compiledJsonSchema;
    } catch (err) {
        issues.push(
            `Blueprint ${label} is not a valid schema: ${err instanceof Error ? err.message : String(err)}`
        );
        return null;
    }
}

/**
 * Execute the 3 pre-seal Common Ground verification gates (`safety`, `contract`, `checks_and_fault_challenges`)
 * before a candidate brick can be sealed for peer exchange (`INV-LEGO-35`).
 *
 * @param {{
 *   blueprint: {
 *     id: string,
 *     name?: string,
 *     summary?: string,
 *     exportName?: string,
 *     inputSchema: object,
 *     outputSchema: object,
 *     bindingSchema?: object
 *   },
 *   source: string,
 *   positiveChecks?: Array<object>,
 *   faultChecks?: Array<object>,
 *   customRunner?: Function | null,
 *   timeoutMs?: number,
 *   maxMemoryMb?: number
 * }} [options={}]
 */
export async function runBrickVerificationGates({
    blueprint,
    source,
    positiveChecks = [],
    faultChecks = [],
    customRunner = null,
    timeoutMs = DEFAULT_SANDBOX_TIMEOUT_MS,
    maxMemoryMb = DEFAULT_SANDBOX_MAX_MEMORY_MB,
} = {}) {
    const tool = 'brick-exchange.verify';

    // Gate 1: Safety (Zero-Ambient-I/O + Zero-Leak)
    const safetyRes = scanBrickSourceSafety(source);
    if (!safetyRes.ok) {
        const findings = safetyRes.error.details?.findings || [];
        const repairHints = findings.map((f) => ({
            gate: 'safety',
            checkName: f.ruleId,
            message: f.message,
            counterexample: null,
        }));
        const gates = {
            safety: { passed: false, findings },
            contract: { passed: false, skipped: true },
            checks_and_fault_challenges: { passed: false, skipped: true },
        };
        return errorEnvelope(
            'BRICK_VERIFICATION_FAILED',
            safetyRes.error.message,
            { gates, checks: [], passedCount: 0, totalCount: 0, repairHints },
            tool
        );
    }

    // Gate 2: Contract (Blueprint + Schemas + Positive Check Presence)
    const contractIssues = [];
    if (!isPlainObject(blueprint)) {
        contractIssues.push('blueprint must be a plain object');
    }

    const blueprintId = isPlainObject(blueprint) && typeof blueprint.id === 'string' ? blueprint.id.trim() : '';
    const blueprintName =
        isPlainObject(blueprint) && typeof blueprint.name === 'string' && blueprint.name.trim()
            ? blueprint.name.trim()
            : blueprintId;
    const blueprintSummary =
        isPlainObject(blueprint) && typeof blueprint.summary === 'string'
            ? blueprint.summary.trim()
            : '';
    const exportName =
        isPlainObject(blueprint) && typeof blueprint.exportName === 'string' && blueprint.exportName.trim()
            ? blueprint.exportName.trim()
            : 'default';

    if (!blueprintId) {
        contractIssues.push('Blueprint requires a non-empty string id');
    }
    if (isPlainObject(blueprint) && blueprint.name !== undefined && typeof blueprint.name !== 'string') {
        contractIssues.push('Blueprint name must be a string when provided');
    }
    if (isPlainObject(blueprint) && blueprint.summary !== undefined && typeof blueprint.summary !== 'string') {
        contractIssues.push('Blueprint summary must be a string when provided');
    }

    const inputJsonSchema = isPlainObject(blueprint)
        ? compileUsableSchema(blueprint.inputSchema, 'inputSchema', contractIssues)
        : null;
    const outputJsonSchema = isPlainObject(blueprint)
        ? compileUsableSchema(blueprint.outputSchema, 'outputSchema', contractIssues)
        : null;
    const bindingJsonSchema =
        isPlainObject(blueprint) && blueprint.bindingSchema !== undefined && blueprint.bindingSchema !== null
            ? compileUsableSchema(blueprint.bindingSchema, 'bindingSchema', contractIssues)
            : null;

    if (!Array.isArray(positiveChecks) || positiveChecks.length < 1) {
        contractIssues.push('At least one positive verification check (positiveChecks) is required');
    }

    if (contractIssues.length > 0) {
        const repairHints = contractIssues.map((msg) => ({
            gate: 'contract',
            checkName: 'blueprint',
            message: msg,
            counterexample: null,
        }));
        const gates = {
            safety: { passed: true, byteLength: safetyRes.data.byteLength, findings: [] },
            contract: { passed: false, issues: contractIssues },
            checks_and_fault_challenges: { passed: false, skipped: true },
        };
        return errorEnvelope(
            'BRICK_VERIFICATION_FAILED',
            contractIssues[0],
            { gates, checks: [], passedCount: 0, totalCount: 0, repairHints },
            tool
        );
    }

    // Gate 3: Positive Checks + Adversarial Fault-Injection Challenges
    if (!Array.isArray(faultChecks) || faultChecks.length < 1) {
        const faultMsg =
            'At least one adversarial fault-injection check (faultChecks) is required to seal a brick';
        const repairHints = [
            {
                gate: 'checks_and_fault_challenges',
                checkName: 'faultChecks',
                message: `${faultMsg}; add corrupted, duplicate, missing-field, or boundary fault inputs.`,
                counterexample: { faultChecksCount: Array.isArray(faultChecks) ? faultChecks.length : 0 },
            },
        ];
        const gates = {
            safety: { passed: true, byteLength: safetyRes.data.byteLength, findings: [] },
            contract: { passed: true, issues: [] },
            checks_and_fault_challenges: {
                passed: false,
                code: 'MISSING_FAULT_CHALLENGE',
                message: faultMsg,
            },
        };
        return errorEnvelope(
            'MISSING_FAULT_CHALLENGE',
            faultMsg,
            {
                gates,
                checks: [],
                passedCount: 0,
                totalCount: positiveChecks.length,
                faultChallengeCount: 0,
                repairHints,
            },
            tool
        );
    }

    const checks = [];
    const repairHints = [];

    // Execute Positive Checks
    for (let idx = 0; idx < positiveChecks.length; idx += 1) {
        const check = positiveChecks[idx] && typeof positiveChecks[idx] === 'object' ? positiveChecks[idx] : {};
        const checkName =
            typeof check.name === 'string' && check.name.trim()
                ? check.name.trim()
                : `positive_${idx + 1}`;

        if (!check.skipInputSchema) {
            const inCheck = validateSchema(blueprint.inputSchema, check.input, {
                stripUnknown: false,
                tool,
            });
            if (!inCheck.ok) {
                const detail = `Check input failed blueprint.inputSchema: ${inCheck.error.message}`;
                checks.push({
                    name: checkName,
                    kind: 'positive',
                    passed: false,
                    durationMs: 0,
                    detail,
                });
                repairHints.push({
                    gate: 'checks_and_fault_challenges',
                    checkName,
                    message: detail,
                    counterexample: {
                        input: check.input,
                        schemaIssues: inCheck.error.details?.issues || [],
                    },
                });
                continue;
            }
        }

        const execRes = await executeInBrickSandbox({
            source,
            exportName,
            input: check.input,
            binding: check.binding ?? {},
            timeoutMs: check.timeoutMs ?? timeoutMs,
            maxMemoryMb,
            customRunner,
        });

        if (!execRes.ok) {
            const durationMs = execRes.error?.details?.durationMs ?? 0;
            const detail = `Execution failed (${execRes.error.code}): ${execRes.error.message}`;
            checks.push({
                name: checkName,
                kind: 'positive',
                passed: false,
                durationMs,
                detail,
            });
            repairHints.push({
                gate: 'checks_and_fault_challenges',
                checkName,
                message: detail,
                counterexample: {
                    input: check.input,
                    errorCode: execRes.error.code,
                    errorMessage: execRes.error.message,
                },
            });
            continue;
        }

        const { output: actualOutput, durationMs } = execRes.data;
        const targetOutputSchema = check.outputSchemaOverride || blueprint.outputSchema;
        const outCheck = validateSchema(targetOutputSchema, actualOutput, {
            stripUnknown: false,
            tool,
        });
        if (!outCheck.ok) {
            const detail = `Output failed outputSchema validation: ${outCheck.error.message}`;
            checks.push({
                name: checkName,
                kind: 'positive',
                passed: false,
                durationMs,
                detail,
                actualOutput,
            });
            repairHints.push({
                gate: 'checks_and_fault_challenges',
                checkName,
                message: detail,
                counterexample: {
                    input: check.input,
                    actualOutput,
                    schemaIssues: outCheck.error.details?.issues || [],
                },
            });
            continue;
        }

        if (
            check.expectedOutput !== undefined &&
            canonicalBrickHash(actualOutput) !== canonicalBrickHash(check.expectedOutput)
        ) {
            const detail = 'Output did not match expectedOutput';
            checks.push({
                name: checkName,
                kind: 'positive',
                passed: false,
                durationMs,
                detail,
                actualOutput,
            });
            repairHints.push({
                gate: 'checks_and_fault_challenges',
                checkName,
                message: detail,
                counterexample: {
                    input: check.input,
                    expectedOutput: check.expectedOutput,
                    actualOutput,
                },
            });
            continue;
        }

        if (isPlainObject(check.expectedSubset) && !matchesExpectedSubset(actualOutput, check.expectedSubset)) {
            const detail = 'Output did not match expectedSubset';
            checks.push({
                name: checkName,
                kind: 'positive',
                passed: false,
                durationMs,
                detail,
                actualOutput,
            });
            repairHints.push({
                gate: 'checks_and_fault_challenges',
                checkName,
                message: detail,
                counterexample: {
                    input: check.input,
                    expectedSubset: check.expectedSubset,
                    actualOutput,
                },
            });
            continue;
        }

        if (typeof check.assertFn === 'function') {
            let passedAssert = false;
            let assertErrMsg = '';
            try {
                passedAssert = Boolean(await check.assertFn(actualOutput));
            } catch (err) {
                assertErrMsg = err instanceof Error ? err.message : String(err);
            }
            if (!passedAssert) {
                const detail = assertErrMsg
                    ? `Custom assertFn threw: ${assertErrMsg}`
                    : 'Custom assertFn returned false';
                checks.push({
                    name: checkName,
                    kind: 'positive',
                    passed: false,
                    durationMs,
                    detail,
                    actualOutput,
                });
                repairHints.push({
                    gate: 'checks_and_fault_challenges',
                    checkName,
                    message: detail,
                    counterexample: { input: check.input, actualOutput },
                });
                continue;
            }
        }

        checks.push({
            name: checkName,
            kind: 'positive',
            passed: true,
            durationMs,
            actualOutput,
        });
    }

    // Execute Adversarial Fault-Injection Checks
    for (let idx = 0; idx < faultChecks.length; idx += 1) {
        const fault = faultChecks[idx] && typeof faultChecks[idx] === 'object' ? faultChecks[idx] : {};
        const checkName =
            typeof fault.name === 'string' && fault.name.trim()
                ? fault.name.trim()
                : `fault_${idx + 1}`;

        const expectThrow =
            fault.expectThrow === true ||
            (typeof fault.expectedErrorSubstring === 'string' &&
                fault.expectedErrorSubstring.length > 0 &&
                fault.expectedOutput === undefined &&
                !isPlainObject(fault.expectedSubset) &&
                typeof fault.assertFn !== 'function');

        const hasStructuredExpectation =
            fault.expectedOutput !== undefined ||
            isPlainObject(fault.expectedSubset) ||
            typeof fault.assertFn === 'function';

        if (!expectThrow && !hasStructuredExpectation) {
            const detail =
                'Fault check must specify expectThrow: true or expectedOutput / expectedSubset / assertFn';
            checks.push({
                name: checkName,
                kind: 'fault',
                passed: false,
                durationMs: 0,
                detail,
            });
            repairHints.push({
                gate: 'checks_and_fault_challenges',
                checkName,
                message: detail,
                counterexample: { input: fault.input },
            });
            continue;
        }

        const execRes = await executeInBrickSandbox({
            source,
            exportName,
            input: fault.input,
            binding: fault.binding ?? {},
            timeoutMs: fault.timeoutMs ?? timeoutMs,
            maxMemoryMb,
            customRunner,
        });

        if (expectThrow) {
            const durationMs = execRes.ok
                ? execRes.data.durationMs
                : execRes.error?.details?.durationMs ?? 0;

            if (execRes.ok) {
                const detail =
                    'Fault challenge expected brick to reject/throw on corrupted input, but execution succeeded silently';
                checks.push({
                    name: checkName,
                    kind: 'fault',
                    passed: false,
                    durationMs,
                    detail,
                    actualOutput: execRes.data.output,
                });
                repairHints.push({
                    gate: 'checks_and_fault_challenges',
                    checkName,
                    message: detail,
                    counterexample: {
                        input: fault.input,
                        actualOutput: execRes.data.output,
                        expectedThrow: true,
                    },
                });
                continue;
            }

            if (
                execRes.error.code === 'SANDBOX_TIMEOUT' ||
                execRes.error.code === 'SANDBOX_MEMORY_LIMIT'
            ) {
                const detail = `Fault challenge triggered ${execRes.error.code} instead of cleanly rejecting corrupted input: ${execRes.error.message}`;
                checks.push({
                    name: checkName,
                    kind: 'fault',
                    passed: false,
                    durationMs,
                    detail,
                });
                repairHints.push({
                    gate: 'checks_and_fault_challenges',
                    checkName,
                    message: detail,
                    counterexample: {
                        input: fault.input,
                        errorCode: execRes.error.code,
                    },
                });
                continue;
            }

            if (
                typeof fault.expectedErrorSubstring === 'string' &&
                fault.expectedErrorSubstring.length > 0 &&
                !String(execRes.error.message || '')
                    .toLowerCase()
                    .includes(fault.expectedErrorSubstring.toLowerCase())
            ) {
                const detail = `Thrown error "${execRes.error.message}" did not include expected substring "${fault.expectedErrorSubstring}"`;
                checks.push({
                    name: checkName,
                    kind: 'fault',
                    passed: false,
                    durationMs,
                    detail,
                });
                repairHints.push({
                    gate: 'checks_and_fault_challenges',
                    checkName,
                    message: detail,
                    counterexample: {
                        input: fault.input,
                        expectedErrorSubstring: fault.expectedErrorSubstring,
                        actualErrorMessage: execRes.error.message,
                    },
                });
                continue;
            }

            checks.push({
                name: checkName,
                kind: 'fault',
                passed: true,
                durationMs,
                detail: `Cleanly rejected corrupted input: ${execRes.error.message}`,
            });
            continue;
        }

        // Fault-reporting branch: brick must succeed, conform to outputSchema, and report faults accurately
        if (!execRes.ok) {
            const durationMs = execRes.error?.details?.durationMs ?? 0;
            const detail = `Fault challenge threw unexpectedly (${execRes.error.code}): ${execRes.error.message}`;
            checks.push({
                name: checkName,
                kind: 'fault',
                passed: false,
                durationMs,
                detail,
            });
            repairHints.push({
                gate: 'checks_and_fault_challenges',
                checkName,
                message: detail,
                counterexample: {
                    input: fault.input,
                    errorCode: execRes.error.code,
                    errorMessage: execRes.error.message,
                },
            });
            continue;
        }

        const { output: actualOutput, durationMs } = execRes.data;
        const targetOutputSchema = fault.outputSchemaOverride || blueprint.outputSchema;
        const outCheck = validateSchema(targetOutputSchema, actualOutput, {
            stripUnknown: false,
            tool,
        });
        if (!outCheck.ok) {
            const detail = `Fault challenge output violated outputSchema: ${outCheck.error.message}`;
            checks.push({
                name: checkName,
                kind: 'fault',
                passed: false,
                durationMs,
                detail,
                actualOutput,
            });
            repairHints.push({
                gate: 'checks_and_fault_challenges',
                checkName,
                message: detail,
                counterexample: {
                    input: fault.input,
                    actualOutput,
                    schemaIssues: outCheck.error.details?.issues || [],
                },
            });
            continue;
        }

        if (
            fault.expectedOutput !== undefined &&
            canonicalBrickHash(actualOutput) !== canonicalBrickHash(fault.expectedOutput)
        ) {
            const detail = 'Fault challenge output did not match expectedOutput';
            checks.push({
                name: checkName,
                kind: 'fault',
                passed: false,
                durationMs,
                detail,
                actualOutput,
            });
            repairHints.push({
                gate: 'checks_and_fault_challenges',
                checkName,
                message: detail,
                counterexample: {
                    input: fault.input,
                    expectedOutput: fault.expectedOutput,
                    actualOutput,
                },
            });
            continue;
        }

        if (isPlainObject(fault.expectedSubset) && !matchesExpectedSubset(actualOutput, fault.expectedSubset)) {
            const detail = 'Fault challenge output did not match expectedSubset';
            checks.push({
                name: checkName,
                kind: 'fault',
                passed: false,
                durationMs,
                detail,
                actualOutput,
            });
            repairHints.push({
                gate: 'checks_and_fault_challenges',
                checkName,
                message: detail,
                counterexample: {
                    input: fault.input,
                    expectedSubset: fault.expectedSubset,
                    actualOutput,
                },
            });
            continue;
        }

        if (typeof fault.assertFn === 'function') {
            let passedAssert = false;
            let assertErrMsg = '';
            try {
                passedAssert = Boolean(await fault.assertFn(actualOutput));
            } catch (err) {
                assertErrMsg = err instanceof Error ? err.message : String(err);
            }
            if (!passedAssert) {
                const detail = assertErrMsg
                    ? `Fault check assertFn threw: ${assertErrMsg}`
                    : 'Fault check assertFn returned false';
                checks.push({
                    name: checkName,
                    kind: 'fault',
                    passed: false,
                    durationMs,
                    detail,
                    actualOutput,
                });
                repairHints.push({
                    gate: 'checks_and_fault_challenges',
                    checkName,
                    message: detail,
                    counterexample: { input: fault.input, actualOutput },
                });
                continue;
            }
        }

        checks.push({
            name: checkName,
            kind: 'fault',
            passed: true,
            durationMs,
            actualOutput,
        });
    }

    const passedCount = checks.filter((c) => c.passed).length;
    const allPassed = passedCount === checks.length && repairHints.length === 0;

    const gates = {
        safety: { passed: true, byteLength: safetyRes.data.byteLength, findings: [] },
        contract: { passed: true, issues: [] },
        checks_and_fault_challenges: {
            passed: allPassed,
            passedCount,
            totalCount: checks.length,
            positiveCount: positiveChecks.length,
            faultChallengeCount: faultChecks.length,
        },
    };

    if (!allPassed) {
        return errorEnvelope(
            'BRICK_VERIFICATION_FAILED',
            `${passedCount} of ${checks.length} check(s) passed`,
            {
                gates,
                checks,
                passedCount,
                totalCount: checks.length,
                faultChallengeCount: faultChecks.length,
                repairHints,
            },
            tool
        );
    }

    const sourceHash = canonicalBrickHash(source);
    const contractHash = canonicalBrickHash({
        inputSchema: inputJsonSchema ?? {},
        outputSchema: outputJsonSchema ?? {},
        bindingSchema: bindingJsonSchema ?? {},
    });
    const rawBlueprintCanon = canonicalizeAuditPayload(blueprint, { tool: 'brick-exchange.hash' });
    const blueprintHash = rawBlueprintCanon.ok
        ? canonicalBrickHash(blueprint)
        : canonicalBrickHash({
              ...blueprint,
              id: blueprintId,
              name: blueprintName,
              summary: blueprintSummary,
              exportName,
              inputSchema: inputJsonSchema ?? {},
              outputSchema: outputJsonSchema ?? {},
              ...(bindingJsonSchema ? { bindingSchema: bindingJsonSchema } : {}),
          });
    const checksHash = canonicalBrickHash(
        checks.map((c) => ({
            name: String(c.name),
            kind: String(c.kind),
            passed: Boolean(c.passed),
        }))
    );

    return okEnvelope(
        tool,
        `All ${checks.length} verification check(s) passed across 3 pre-seal gates`,
        {
            gates,
            checks,
            passedCount: checks.length,
            totalCount: checks.length,
            faultChallengeCount: faultChecks.length,
            blueprintHash,
            contractHash,
            sourceHash,
            checksHash,
            repairHints: [],
        }
    );
}
