/**
 * @module lego-scout
 * @description Deterministic Cross-Repo Rule-of-3 Lego Scout Engine (`INV-LEGO-15`).
 * Scans a multi-project workspace to surface:
 *   1. Existing `@krusch/toolkit` / `krusch_toolkit` adoption opportunities (`LEGO-ADOPT`)
 *   2. Recurring cross-repository infrastructure clusters gated by the Rule-of-3 anti-bloat threshold
 *
 * Enforces symlink containment (`realpathSync` inside `projectsRoot`), pre-read byte caps,
 * and portable `<HOMELAB_ROOT>/projects/...` path scrubbing (`INV-STACK-04`).
 */

import fs from 'node:fs';
import path from 'node:path';
import { okEnvelope, errorEnvelope } from './http.js';
import { auditBoilerplateText } from './catalog.js';

const TOOL_NAME = 'lego.scout';
const PORTABLE_PROJECTS_ROOT = '<HOMELAB_ROOT>/projects';

const NODE_SOURCE_EXTS = new Set(['.js', '.mjs', '.jsx', '.ts', '.tsx']);
const SCAN_SOURCE_EXTS = new Set(['.js', '.mjs', '.jsx', '.ts', '.tsx', '.py']);

const SKIP_TOP_PROJECTS = new Set(['krusch-stack', 'archive', 'reference', 'vllm', 'lib', 'lib-py', 'scratch']);

const SKIP_SUBDIRECTORIES = new Set([
    'node_modules',
    '.git',
    '.venv',
    'venv',
    'env',
    '__pycache__',
    'site-packages',
    'dist',
    'build',
    '.next',
    'coverage',
    'out',
    'tests',
    'test',
    '__tests__',
    'e2e',
    'cypress',
    'playwright-report',
    'test-results',
    'benchmarks',
    'benchmark',
    'docs',
    'examples',
    'assets',
    'storybook-static',
    'data',
    'models',
    'vendor',
    'third_party',
    'archive',
    '_archive',
    'archive_scratch',
    'scratch',
    'reference',
]);

const SKIP_TEST_FILE_RE = /(?:\.(?:test|spec|min)\.[^.]+$|^test[_-]|-[A-Za-z0-9_]{8}\.m?js$)/i;

const MAX_SAMPLES_PER_PROJECT = 3;
const MAX_CLUSTER_EVIDENCE = 12;

/**
 * Deterministic ASCII/code-unit comparator independent of host OS locale settings.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareStrings(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Check whether `ext` belongs to a JavaScript or TypeScript source file.
 *
 * @param {string} ext
 * @returns {boolean}
 */
function isNodeSourceExt(ext) {
    return NODE_SOURCE_EXTS.has(ext);
}

/**
 * Frozen registry of cross-repository infrastructure pattern detectors (`INV-LEGO-15`).
 */
export const CANDIDATE_PATTERN_SIGNATURES = Object.freeze(
    [
        {
            id: 'sqlite-fts5-rrf',
            title: 'Node 22 SQLite WAL, FTS5 Escaping & Hybrid RRF',
            runtime: 'node',
            category: 'storage',
            statusWhenCovered: 'COVERED_BY_TOOLKIT_V1_5',
            proposedBrickImport: '@krusch/toolkit/sqlite',
            antiBloatNote:
                'Zero-native-addon node:sqlite (DatabaseSync) WAL durability, FTS5 token escaping, and Reciprocal Rank Fusion recur across 3+ Node 22 services and belong in @krusch/toolkit/sqlite.',
            detectPackage: () => false,
            detectSource: (cleanedCode, ext) =>
                isNodeSourceExt(ext) &&
                (/\bnode:sqlite\b|\bDatabaseSync\b/.test(cleanedCode) ||
                    /\bfts5\b|\bbm25\s*\(/i.test(cleanedCode) ||
                    /\b(?:rrfScore|fuseRrf|fuseRrfResults|reciprocalRankFusion)\b/i.test(cleanedCode) ||
                    (/\brrf\b/i.test(cleanedCode) && /\b(?:rank|bm25|fts5|score)\b/i.test(cleanedCode))),
        },
        {
            id: 'ssrf-and-rate-limit',
            title: 'Outbound SSRF Guard & Bounded HTTP 429 Rate Limiter',
            runtime: 'cross-runtime',
            category: 'security',
            statusWhenCovered: 'COVERED_BY_TOOLKIT_V1_5',
            proposedBrickImport: '@krusch/toolkit/security',
            antiBloatNote:
                'DNS-rebinding-safe outbound URL validation (blocking RFC1918, loopback, and 169.254.169.254 metadata) and bounded HTTP 429 rate limiting recur across gateways and belong in @krusch/toolkit/security.',
            detectPackage: (deps) =>
                deps.has('express-rate-limit') ||
                deps.has('rate-limiter-flexible') ||
                deps.has('ssrf-req-filter'),
            detectSource: (cleanedCode) =>
                /169\.254\.169\.254|\bisPrivate(?:OrReserved)?Ip\b|\bvalidateOutboundUrl\b/.test(cleanedCode) ||
                /\b(?:createRateLimiter|rateLimit)\b|\bTOO_MANY_REQUESTS\b|\bRetry-After\b/i.test(cleanedCode),
        },
        {
            id: 'python-mcp-pgvector-parity',
            title: 'Python MCP Tool Envelopes & pgvector Cosine Search Parity',
            runtime: 'python',
            category: 'storage',
            statusWhenCovered: 'COVERED_BY_TOOLKIT_V1_3',
            proposedBrickImport: 'krusch_toolkit.mcp / krusch_toolkit.pg',
            antiBloatNote:
                'Python MCP servers and RAG services repeating FastMCP/mcp.server wiring and raw psycopg2 pgvector (<=>) cosine queries without shared envelopes belong in krusch_toolkit.mcp and krusch_toolkit.pg.',
            detectPackage: (deps) =>
                !deps.has('krusch-toolkit') &&
                !deps.has('krusch_toolkit') &&
                (deps.has('fastmcp') ||
                    deps.has('pgvector') ||
                    (deps.has('mcp') && (deps.has('psycopg2') || deps.has('psycopg2-binary')))),
            detectSource: (cleanedCode, ext) =>
                ext === '.py' &&
                !/\bkrusch_toolkit\.(?:mcp|pg)\b/.test(cleanedCode) &&
                !/\bfrom\s+krusch_toolkit\s+import\b[^\n]*\b(?:mcp|pg)\b/.test(cleanedCode) &&
                (/\bFastMCP\b|\bmcp\.server\b/.test(cleanedCode) ||
                    (/\bpsycopg2\b/.test(cleanedCode) && (/<=>/.test(cleanedCode) || /\bpgvector\b/.test(cleanedCode)))),
        },
        {
            id: 'cascade-swarm-routing',
            title: 'Multi-Tier LLM Cascade & Burst Swarm Routing',
            runtime: 'cross-runtime',
            category: 'routing',
            statusWhenCovered: 'COVERED_BY_TOOLKIT_V1_6',
            proposedBrickImport: '@krusch/toolkit/cascade',
            antiBloatNote:
                'Deterministic L1->L2->L2.5->L3 tier selection, single-flight HALF_OPEN circuit-breaking, and burst fallback contracts ship in @krusch/toolkit/cascade; keep domain-specific prompt rubrics project-local.',
            detectPackage: (deps) =>
                deps.has('krusch-cascade-router') || deps.has('@krusch/cascade-router'),
            detectSource: (cleanedCode) =>
                /\bkrusch-cascade-router\b|\bCascadeRouter\b|\bDEFAULT_COLAB_BURST_MODEL\b/.test(cleanedCode),
        },
        {
            id: 'schema-contract-validation',
            title: 'Runtime Payload & Tool Schema Validation (Zod / Ajv)',
            runtime: 'node',
            category: 'schema',
            statusWhenCovered: 'COVERED_BY_TOOLKIT_V1_6',
            proposedBrickImport: '@krusch/toolkit/schema',
            antiBloatNote:
                'Zero-dependency composable schema builders, Zod/JSON-Schema adapters, and MCP inputSchema compilers emitting INV-LEGO-01 VALIDATION_ERROR envelopes ship in @krusch/toolkit/schema and krusch_toolkit.schema.',
            detectPackage: (deps) => deps.has('zod') || deps.has('ajv'),
            detectSource: (cleanedCode, ext) =>
                isNodeSourceExt(ext) &&
                (/(?:from\s+['"]zod['"]|require\(\s*['"]zod['"]\s*\)|\bz\.object\s*\()/.test(cleanedCode) ||
                    /(?:from\s+['"]ajv['"]|require\(\s*['"]ajv['"]\s*\)|\bnew\s+Ajv\s*\()/.test(cleanedCode)),
        },
        {
            id: 'multipart-file-upload',
            title: 'Bounded Multipart File Upload & MIME Guard',
            runtime: 'cross-runtime',
            category: 'ingestion',
            statusWhenCovered: 'COVERED_BY_TOOLKIT_V1_6',
            proposedBrickImport: '@krusch/toolkit/upload',
            antiBloatNote:
                'Byte-bounded multipart/form-data parsing, filename sanitization, and magic-byte MIME verification ship in @krusch/toolkit/upload and krusch_toolkit.upload while PDF/OCR domain logic stays project-local.',
            detectPackage: (deps) =>
                deps.has('multer') ||
                deps.has('busboy') ||
                deps.has('formidable') ||
                deps.has('python-multipart'),
            detectSource: (cleanedCode) =>
                /\bmulter\s*\(|(?:from\s+['"]multer['"]|require\(\s*['"]multer['"]\s*\))|multipart\/form-data/i.test(
                    cleanedCode
                ),
        },
        {
            id: 'voice-whisper-audio',
            title: 'Whisper STT & Speech Synthesis Audio Modality Helpers',
            runtime: 'cross-runtime',
            category: 'modality',
            statusWhenCovered: 'COVERED_BY_TOOLKIT_V1_6',
            proposedBrickImport: '@krusch/toolkit/audio',
            antiBloatNote:
                'RIFF/WAVE PCM16 framing and AbortController-safe Whisper STT / streaming TTS helpers ship in @krusch/toolkit/audio while kiosk UI state stays project-local.',
            detectPackage: (deps) => deps.has('openai-whisper') || deps.has('faster-whisper'),
            detectSource: (cleanedCode) =>
                /:9000\b|\bwhisper\b|audio\/wav|\bMediaRecorder\b|\bspeechSynthesis\b/i.test(cleanedCode),
        },
        {
            id: 'python-httpx-resilience',
            title: 'Python Async httpx Retry, Timeout & Envelope Client',
            runtime: 'python',
            category: 'routing',
            statusWhenCovered: 'COVERED_BY_TOOLKIT_V1_5',
            proposedBrickImport: 'krusch_toolkit.http_client',
            antiBloatNote:
                'SSRF-guarded, DNS-pinned, byte-bounded JSON HTTP requests with single-flight HALF_OPEN circuit breaking and Retry-After backoff ship in krusch_toolkit.http_client; keep upstream domain schemas project-local.',
            detectPackage: (deps) => deps.has('httpx'),
            detectSource: (cleanedCode, ext) =>
                ext === '.py' &&
                !/\bkrusch_toolkit\.http_client\b/.test(cleanedCode) &&
                !/\bfrom\s+krusch_toolkit\s+import\b[^\n]*\b(?:async_)?request_json\b/.test(cleanedCode) &&
                /\bhttpx\.(?:AsyncClient|Client)\b/.test(cleanedCode),
        },
        {
            id: 'streamlit-rag-shell',
            title: 'Streamlit Sovereign RAG Citation & Chat Shell',
            runtime: 'python',
            category: 'modality',
            statusWhenCovered: 'COVERED_BY_TOOLKIT_V1_5',
            proposedBrickImport: 'krusch_toolkit.streamlit_ui',
            antiBloatNote:
                'Air-gapped glassmorphism CSS, XSS-escaped citation badges, and bounded session-state chat shells ship in krusch_toolkit.streamlit_ui; keep statutory/business domain views project-local.',
            detectPackage: (deps) => deps.has('streamlit'),
            detectSource: (cleanedCode, ext) =>
                ext === '.py' &&
                !/\bkrusch_toolkit\.streamlit_ui\b/.test(cleanedCode) &&
                !/\bfrom\s+krusch_toolkit\s+import\b[^\n]*\brender_sovereign_rag_shell\b/.test(cleanedCode) &&
                /\b(?:import\s+streamlit|from\s+streamlit)\b/.test(cleanedCode),
        },
        {
            id: 'python-sqlalchemy-wal-pool',
            title: 'Python SQLAlchemy Engine Pool, SQLite WAL & Session Lifecycle',
            runtime: 'python',
            category: 'storage',
            statusWhenCovered: 'COVERED_BY_TOOLKIT_V1_6',
            proposedBrickImport: 'krusch_toolkit.db_async',
            antiBloatNote:
                'Bounded SQLAlchemy sync/async engine pool sizing, SQLite WAL event pragmas, DSN credential scrubbing, and cancellation-safe session context managers ship in krusch_toolkit.db_async; keep ORM models project-local.',
            detectPackage: (deps) =>
                deps.has('sqlalchemy') || deps.has('aiosqlite') || deps.has('asyncpg'),
            detectSource: (cleanedCode, ext) =>
                ext === '.py' &&
                !/\bkrusch_toolkit\.(?:db|db_async)\b/.test(cleanedCode) &&
                !/\bfrom\s+krusch_toolkit\s+import\b[\s\S]{0,240}?\b(?:db_async|create_managed_engine|create_managed_async_engine|session_scope|async_session_scope)\b/.test(
                    cleanedCode
                ) &&
                /\b(?:create_engine|create_async_engine|sessionmaker|async_sessionmaker)\s*\(/.test(cleanedCode),
        },
        {
            id: 'yaml-safe-config-loader',
            title: 'Safe YAML Pack & Configuration Loader (PyYAML / js-yaml)',
            runtime: 'cross-runtime',
            category: 'ingestion',
            statusWhenCovered: 'COVERED_BY_TOOLKIT_V1_7',
            proposedBrickImport: '@krusch/toolkit/yaml',
            antiBloatNote:
                'Alias-bomb-bounded YAML 1.2 Core parsing, tag rejection, and SHA-256 schema-validated pack loaders ship in @krusch/toolkit/yaml and krusch_toolkit.yaml_loader; keep domain pack schemas project-local.',
            detectPackage: (deps) =>
                deps.has('pyyaml') || deps.has('js-yaml') || deps.has('yaml'),
            detectSource: (cleanedCode, ext) =>
                (ext === '.py' &&
                    !/\bkrusch_toolkit\.yaml_loader\b/.test(cleanedCode) &&
                    !/\bfrom\s+krusch_toolkit\s+import\b[\s\S]{0,240}?\b(?:yaml_loader|parse_safe_yaml|load_safe_yaml_pack|validate_yaml_config|dump_safe_yaml)\b/.test(
                        cleanedCode
                    ) &&
                    /\byaml\.(?:safe_load|load|CSafeLoader|SafeLoader)\b/.test(cleanedCode)) ||
                (isNodeSourceExt(ext) &&
                    !/@krusch\/toolkit\/yaml\b|\b(?:parseSafeYaml|loadSafeYamlPack|validateYamlConfig|stringifySafeYaml)\b/.test(
                        cleanedCode
                    ) &&
                    (/(?:from\s+['"](?:js-yaml|yaml)['"]|require\(\s*['"](?:js-yaml|yaml)['"]\s*\))/.test(
                        cleanedCode
                    ) ||
                        /\byaml\.(?:load|parse)\s*\(/.test(cleanedCode))),
        },
        {
            id: 'niche-xml-or-yaml',
            title: 'Single-Domain XML / Specialized Format Parser',
            runtime: 'node',
            category: 'ingestion',
            statusWhenCovered: null,
            proposedBrickImport: 'keep-project-local',
            antiBloatNote:
                'Rule-of-3 anti-bloat gate: single-domain XML or specialized format parsers used in fewer than 3 repositories MUST remain project-local rather than inflating @krusch/toolkit.',
            detectPackage: (deps) => deps.has('fast-xml-parser') || deps.has('xml2js'),
            detectSource: (cleanedCode, ext) =>
                isNodeSourceExt(ext) && /\bfast-xml-parser\b|\bXMLParser\b|\bxml2js\b/.test(cleanedCode),
        },
    ].map((sig) => Object.freeze(sig))
);

/**
 * Resolve `fs.realpathSync` when `targetPath` exists on disk, falling back to `path.resolve`.
 *
 * @param {string} targetPath
 * @returns {string}
 */
function resolveRealOrAbs(targetPath) {
    try {
        return fs.realpathSync(targetPath);
    } catch {
        return path.resolve(targetPath);
    }
}

/**
 * Scrub any residual POSIX or macOS user home directory segments (`INV-STACK-04`).
 *
 * @param {string} rawPath
 * @returns {string}
 */
function scrubHostHomeSegments(rawPath) {
    return String(rawPath || '')
        .replace(/\\/g, '/')
        .replace(/(?:[A-Za-z]:)?\/(?:home|Users)\/[^/\s]+/gi, '<HOMELAB_ROOT>');
}

/**
 * Compute a portable POSIX path (`<HOMELAB_ROOT>/projects/${relPosix}`) inside `projectsRoot`,
 * ensuring zero residual POSIX or macOS user home directory segments ever appear (`INV-STACK-04`).
 *
 * @param {string} absPath - File or project directory path
 * @param {string} projectsRoot - Workspace `projects` root directory
 * @returns {string}
 */
export function formatPortableProjectPath(absPath, projectsRoot) {
    const rawTarget = String(absPath ?? '').trim();
    if (!rawTarget) {
        return PORTABLE_PROJECTS_ROOT;
    }
    if (rawTarget === PORTABLE_PROJECTS_ROOT || rawTarget.startsWith(`${PORTABLE_PROJECTS_ROOT}/`)) {
        return scrubHostHomeSegments(rawTarget);
    }

    const rawRoot = String(projectsRoot ?? '').trim();
    if (!path.isAbsolute(rawTarget) && !/^[A-Za-z]:[\\/]/.test(rawTarget)) {
        const cleanedRel = scrubHostHomeSegments(rawTarget).replace(/^\.?\//, '').replace(/\/+$/, '');
        return cleanedRel ? `${PORTABLE_PROJECTS_ROOT}/${cleanedRel}` : PORTABLE_PROJECTS_ROOT;
    }

    if (rawRoot) {
        const lexicalRel = path.relative(path.resolve(rawRoot), path.resolve(rawTarget));
        if (lexicalRel === '') {
            return PORTABLE_PROJECTS_ROOT;
        }
        if (!lexicalRel.startsWith('..') && !path.isAbsolute(lexicalRel)) {
            const relPosix = lexicalRel.split(path.sep).join('/').replace(/\\/g, '/');
            return scrubHostHomeSegments(`${PORTABLE_PROJECTS_ROOT}/${relPosix}`);
        }

        // Fallback when one side traverses a symlink (e.g., symlinked projectsRoot vs real target).
        const resolvedRoot = resolveRealOrAbs(rawRoot);
        const resolvedTarget = resolveRealOrAbs(rawTarget);
        const rel = path.relative(resolvedRoot, resolvedTarget);
        if (rel === '') {
            return PORTABLE_PROJECTS_ROOT;
        }
        if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
            const relPosix = rel.split(path.sep).join('/').replace(/\\/g, '/');
            return scrubHostHomeSegments(`${PORTABLE_PROJECTS_ROOT}/${relPosix}`);
        }
    }

    const fallbackName = path.basename(rawTarget.replace(/[\\/]+$/, ''));
    return scrubHostHomeSegments(
        fallbackName ? `${PORTABLE_PROJECTS_ROOT}/${fallbackName}` : PORTABLE_PROJECTS_ROOT
    );
}

/**
 * Verify that `realTarget` stays strictly within `realProjectsRoot`.
 *
 * @param {string} realTarget
 * @param {string} realProjectsRoot
 * @returns {boolean}
 */
function isContainedInProjectsRoot(realTarget, realProjectsRoot) {
    return (
        realTarget === realProjectsRoot ||
        realTarget.startsWith(`${realProjectsRoot}${path.sep}`)
    );
}

/**
 * Safely read a UTF-8 file inside `realProjectsRoot` ONLY if:
 *   1. Symlinks resolve strictly inside `realProjectsRoot`
 *   2. Target is a regular file (never directory/FIFO/socket)
 *   3. `stat.size <= maxFileBytes` checked BEFORE `fs.readFileSync`
 *
 * @param {string} fileAbs
 * @param {string} realProjectsRoot
 * @param {number} maxFileBytes
 * @returns {{ content: string, realFile: string } | null}
 */
function readContainedFileBounded(fileAbs, realProjectsRoot, maxFileBytes) {
    try {
        const lst = fs.lstatSync(fileAbs);
        let targetAbs = fileAbs;
        let fileStat = lst;

        if (lst.isSymbolicLink()) {
            targetAbs = fs.realpathSync(fileAbs);
            if (!isContainedInProjectsRoot(targetAbs, realProjectsRoot)) {
                return null;
            }
            fileStat = fs.statSync(targetAbs);
        }

        if (!fileStat.isFile() || fileStat.size > maxFileBytes) {
            return null;
        }

        return {
            content: fs.readFileSync(targetAbs, 'utf8'),
            realFile: targetAbs,
        };
    } catch {
        return null;
    }
}

/**
 * Strip line and block comments in linear slice chunks while preserving string literals.
 *
 * @param {string} code
 * @param {string} ext
 * @returns {string}
 */
function stripSourceComments(code, ext) {
    const len = code.length;
    if (len === 0) return '';

    if (ext === '.py') {
        if (!code.includes('#')) return code;
        const chunks = [];
        let segStart = 0;
        let i = 0;

        while (i < len) {
            const c = code.charCodeAt(i);
            if (c === 35) {
                // '#'
                if (i > segStart) chunks.push(code.slice(segStart, i));
                i += 1;
                while (i < len && code.charCodeAt(i) !== 10) i += 1;
                segStart = i;
                continue;
            }
            if (c === 39 || c === 34) {
                // ''' / """ or ' / "
                if (code.charCodeAt(i + 1) === c && code.charCodeAt(i + 2) === c) {
                    i += 3;
                    while (i < len) {
                        if (code.charCodeAt(i) === 92 && i + 1 < len) {
                            i += 2;
                            continue;
                        }
                        if (
                            code.charCodeAt(i) === c &&
                            code.charCodeAt(i + 1) === c &&
                            code.charCodeAt(i + 2) === c
                        ) {
                            i += 3;
                            break;
                        }
                        i += 1;
                    }
                    continue;
                }
                i += 1;
                while (i < len) {
                    const qc = code.charCodeAt(i);
                    if (qc === 92 && i + 1 < len) {
                        i += 2;
                        continue;
                    }
                    if (qc === 10) break;
                    i += 1;
                    if (qc === c) break;
                }
                continue;
            }
            i += 1;
        }

        if (segStart === 0) return code;
        if (segStart < len) chunks.push(code.slice(segStart));
        return chunks.join('');
    }

    if (!code.includes('//') && !code.includes('/*')) {
        return code;
    }

    const chunks = [];
    const tplDepthStack = [];
    let segStart = 0;
    let i = 0;

    const advanceTemplateLiteral = () => {
        while (i < len) {
            const tc = code.charCodeAt(i);
            if (tc === 92 && i + 1 < len) {
                i += 2;
                continue;
            }
            if (tc === 36 && code.charCodeAt(i + 1) === 123) {
                tplDepthStack.push(0);
                i += 2;
                return;
            }
            i += 1;
            if (tc === 96) return;
        }
    };

    while (i < len) {
        const c = code.charCodeAt(i);
        const next = code.charCodeAt(i + 1);

        if (c === 47 && next === 47) {
            // '//'
            if (i > segStart) chunks.push(code.slice(segStart, i));
            i += 2;
            while (i < len && code.charCodeAt(i) !== 10) i += 1;
            segStart = i;
            continue;
        }

        if (c === 47 && next === 42) {
            // '/*'
            if (i > segStart) chunks.push(code.slice(segStart, i));
            i += 2;
            let hasNewline = false;
            while (i < len && !(code.charCodeAt(i) === 42 && code.charCodeAt(i + 1) === 47)) {
                if (code.charCodeAt(i) === 10) hasNewline = true;
                i += 1;
            }
            if (i < len) i += 2;
            chunks.push(hasNewline ? '\n' : ' ');
            segStart = i;
            continue;
        }

        if (c === 39 || c === 34) {
            i += 1;
            while (i < len) {
                const qc = code.charCodeAt(i);
                if (qc === 92 && i + 1 < len) {
                    i += 2;
                    continue;
                }
                if (qc === 10) break;
                i += 1;
                if (qc === c) break;
            }
            continue;
        }

        if (c === 96) {
            i += 1;
            advanceTemplateLiteral();
            continue;
        }

        if (tplDepthStack.length > 0) {
            if (c === 123) {
                tplDepthStack[tplDepthStack.length - 1] += 1;
                i += 1;
                continue;
            }
            if (c === 125) {
                if (tplDepthStack[tplDepthStack.length - 1] > 0) {
                    tplDepthStack[tplDepthStack.length - 1] -= 1;
                    i += 1;
                    continue;
                }
                tplDepthStack.pop();
                i += 1;
                advanceTemplateLiteral();
                continue;
            }
        }

        i += 1;
    }

    if (segStart === 0) return code;
    if (segStart < len) chunks.push(code.slice(segStart));
    return chunks.join('');
}

/**
 * Precompiled single-pass case-insensitive ASCII Aho-Corasick DFA over raw UTF-8 file bytes.
 * Scans every file in a single O(N) byte pass inside a reusable scratch buffer, emitting two
 * 30-bit SMI bitmasks (`lo`, `hi`) so non-matching files (~85% of workspace) skip UTF-8->UTF-16
 * string allocation, comment stripping, and regex execution entirely.
 */
const DFA_KEYWORDS = [
    // 0..9: Boilerplate prefilter tokens
    'stdioservertransport', // 0
    'text/event-stream', // 1
    'corsmiddleware', // 2
    '/health', // 3
    'pool', // 4
    'database', // 5
    'new', // 6
    'useeffect', // 7
    'fetch', // 8
    'createhmac', // 9
    // 10..15: sqlite-fts5-rrf
    'node:sqlite', // 10
    'databasesync', // 11
    'fts5', // 12
    'bm25', // 13
    'rrf', // 14
    'reciprocalrankfusion', // 15
    // 16..21: ssrf-and-rate-limit
    '169.254.169.254', // 16
    'isprivate', // 17
    'validateoutboundurl', // 18
    'ratelimit', // 19
    'too_many_requests', // 20
    'retry-after', // 21
    // 22..24: python-mcp-pgvector-parity
    'fastmcp', // 22
    'mcp.server', // 23
    'psycopg2', // 24
    // 25..27: cascade-swarm-routing
    'krusch-cascade-router', // 25
    'cascaderouter', // 26
    'default_colab_burst_model', // 27
    // 28..29 (lo) + 30..31 (hi 0..1): schema-contract-validation
    "'zod'", // 28
    '"zod"', // 29
    'z.object', // 30 (hi bit 0)
    'ajv', // 31 (hi bit 1)
    // 32..33 (hi 2..3): multipart-file-upload
    'multer', // 32 (hi bit 2)
    'multipart/form-data', // 33 (hi bit 3)
    // 34..38 (hi 4..8): voice-whisper-audio
    ':9000', // 34 (hi bit 4)
    'whisper', // 35 (hi bit 5)
    'audio/wav', // 36 (hi bit 6)
    'mediarecorder', // 37 (hi bit 7)
    'speechsynthesis', // 38 (hi bit 8)
    // 39..41 (hi 9..11): niche-xml-or-yaml
    'fast-xml-parser', // 39 (hi bit 9)
    'xmlparser', // 40 (hi bit 10)
    'xml2js', // 41 (hi bit 11)
    // 42..43 (hi 12..13): Wave-5 Python bricks (covered in krusch_toolkit v1.5)
    'httpx', // 42 (hi bit 12)
    'streamlit', // 43 (hi bit 13)
    // 44..51 (hi 14..21): Wave-6 horizon detectors
    'create_engine', // 44 (hi bit 14)
    'create_async_engine', // 45 (hi bit 15)
    'sessionmaker', // 46 (hi bit 16)
    'yaml.', // 47 (hi bit 17)
    'js-yaml', // 48 (hi bit 18)
    "'yaml'", // 49 (hi bit 19)
    '"yaml"', // 50 (hi bit 20)
    'safeloader', // 51 (hi bit 21)
];

const {
    dfaTable: AHO_DFA_TABLE,
    outMaskLo: AHO_MASK_LO,
    outMaskHi: AHO_MASK_HI,
    asciiLut: AHO_ASCII_LUT,
} = (() => {
    const ALPHA = 128;
    let numStates = 1;
    const rows = [new Int32Array(ALPHA)];
    const loList = [0];
    const hiList = [0];

    for (let k = 0; k < DFA_KEYWORDS.length; k += 1) {
        const kw = DFA_KEYWORDS[k];
        let state = 0;
        for (let i = 0; i < kw.length; i += 1) {
            const ch = kw.charCodeAt(i);
            let next = rows[state][ch];
            if (next === 0) {
                next = numStates;
                numStates += 1;
                rows.push(new Int32Array(ALPHA));
                loList.push(0);
                hiList.push(0);
                rows[state][ch] = next;
            }
            state = next;
        }
        if (k < 30) {
            loList[state] |= 1 << k;
        } else {
            hiList[state] |= 1 << (k - 30);
        }
    }

    const fail = new Int32Array(numStates);
    const queue = [];
    for (let c = 0; c < ALPHA; c += 1) {
        if (rows[0][c] !== 0) {
            queue.push(rows[0][c]);
        }
    }

    for (let qi = 0; qi < queue.length; qi += 1) {
        const r = queue[qi];
        const f = fail[r];
        loList[r] |= loList[f];
        hiList[r] |= hiList[f];
        const row = rows[r];
        const fRow = rows[f];
        for (let c = 0; c < ALPHA; c += 1) {
            const u = row[c];
            if (u !== 0) {
                fail[u] = fRow[c];
                queue.push(u);
            } else {
                row[c] = fRow[c];
            }
        }
    }

    const dfaTable = new Int32Array(numStates * ALPHA);
    const outMaskLo = new Int32Array(numStates);
    const outMaskHi = new Int32Array(numStates);
    for (let s = 0; s < numStates; s += 1) {
        dfaTable.set(rows[s], s * ALPHA);
        outMaskLo[s] = loList[s];
        outMaskHi[s] = hiList[s];
    }

    // Bytes 0..127 fold A-Z -> a-z; bytes 128..255 map to 0 (resetting automaton cleanly on UTF-8 multibyte bytes).
    const asciiLut = new Uint8Array(256);
    for (let b = 0; b < 128; b += 1) {
        asciiLut[b] = b >= 65 && b <= 90 ? b | 32 : b;
    }

    return { dfaTable, outMaskLo, outMaskHi, asciiLut };
})();

const PY_CORS_HEALTH_MASK = (1 << 2) | (1 << 3);
const JS_DIRECT_BOILERPLATE_MASK = (1 << 0) | (1 << 1) | (1 << 9);
const JS_POOL_OR_DB_MASK = (1 << 4) | (1 << 5);
const JS_EFFECT_FETCH_MASK = (1 << 7) | (1 << 8);
const JS_HI_MULTER_MASK = 1 << 2;

const SIG_LO_SQLITE = (1 << 10) | (1 << 11) | (1 << 12) | (1 << 13) | (1 << 14) | (1 << 15);
const SIG_LO_SSRF_RATE = (1 << 16) | (1 << 17) | (1 << 18) | (1 << 19) | (1 << 20) | (1 << 21);
const SIG_LO_PY_MCP_PG = (1 << 22) | (1 << 23) | (1 << 24);
const SIG_LO_CASCADE = (1 << 25) | (1 << 26) | (1 << 27);
const SIG_LO_SCHEMA = (1 << 28) | (1 << 29);

const SIG_HI_SCHEMA = (1 << 0) | (1 << 1);
const SIG_HI_UPLOAD = (1 << 2) | (1 << 3);
const SIG_HI_AUDIO = (1 << 4) | (1 << 5) | (1 << 6) | (1 << 7) | (1 << 8);
const SIG_HI_XML = (1 << 9) | (1 << 10) | (1 << 11);
const SIG_HI_PY_HTTPX = 1 << 12;
const SIG_HI_STREAMLIT = 1 << 13;
const SIG_HI_PY_SQLALCHEMY = (1 << 14) | (1 << 15) | (1 << 16);
const SIG_HI_YAML = (1 << 17) | (1 << 18) | (1 << 19) | (1 << 20) | (1 << 21);

const PY_HI_YAML_DOT_MASK = 1 << 17;
const JS_HI_JS_YAML_MASK = 1 << 18;

function mayMatchBoilerplateBits(lo, hi, isPython) {
    if (isPython) {
        return (
            (lo & (1 << 1)) !== 0 ||
            (lo & PY_CORS_HEALTH_MASK) === PY_CORS_HEALTH_MASK ||
            (hi & PY_HI_YAML_DOT_MASK) !== 0
        );
    }
    return (
        (lo & JS_DIRECT_BOILERPLATE_MASK) !== 0 ||
        (hi & (JS_HI_MULTER_MASK | JS_HI_JS_YAML_MASK)) !== 0 ||
        ((lo & (1 << 6)) !== 0 && (lo & JS_POOL_OR_DB_MASK) !== 0) ||
        (lo & JS_EFFECT_FETCH_MASK) === JS_EFFECT_FETCH_MASK
    );
}

function hasEventStreamToken(code) {
    return (
        (code.includes('stream') || code.includes('STREAM') || code.includes('Stream')) &&
        /text\/event-stream/i.test(code)
    );
}

function mayTriggerCatalogBoilerplate(cleanedCode, isPython) {
    if (isPython) {
        const usesFastapiToolkit =
            /\bkrusch_toolkit\.fastapi_app\b/.test(cleanedCode) ||
            /\bfrom\s+krusch_toolkit\s+import\b[^\n]*\bfastapi_app\b/.test(cleanedCode);
        const usesPyYamlToolkit =
            /\bkrusch_toolkit\.yaml_loader\b/.test(cleanedCode) ||
            /\bfrom\s+krusch_toolkit\s+import\b[\s\S]{0,240}?\b(?:yaml_loader|parse_safe_yaml|load_safe_yaml_pack|validate_yaml_config|dump_safe_yaml)\b/.test(
                cleanedCode
            );
        const mayMatchFastapi =
            !usesFastapiToolkit &&
            ((/\bCORSMiddleware\b/.test(cleanedCode) &&
                /@\w+\.get\(\s*['"]\/health['"]/.test(cleanedCode)) ||
                hasEventStreamToken(cleanedCode));
        const mayMatchUnsafeYaml =
            !usesPyYamlToolkit &&
            /\byaml\.(?:load|load_all|unsafe_load|full_load|unsafe_load_all|full_load_all)\s*\(/.test(
                cleanedCode
            );
        return mayMatchFastapi || mayMatchUnsafeYaml;
    }

    return (
        (/\bStdioServerTransport\b/.test(cleanedCode) &&
            /\bnew\s+Server\s*\(/.test(cleanedCode) &&
            !/@krusch\/toolkit\/mcp(?:-server)?\b/.test(cleanedCode)) ||
        ((/\bnew\s+pg\.Pool\s*\(/.test(cleanedCode) ||
            (/\bnew\s+Pool\s*\(/.test(cleanedCode) &&
                /(?:from\s+['"]pg['"]|require\(\s*['"]pg['"]\s*\))/.test(cleanedCode))) &&
            !/@krusch\/toolkit\/(?:pg|polygres)\b/.test(cleanedCode)) ||
        (/\bnew\s+Database\s*\(/.test(cleanedCode) &&
            !/@krusch\/toolkit\/db\b/.test(cleanedCode) &&
            (/better-sqlite3/.test(cleanedCode) ||
                /\.pragma\s*\(\s*['"]journal_mode/i.test(cleanedCode))) ||
        (/\bnew\s+DatabaseSync\s*\(/.test(cleanedCode) &&
            !/@krusch\/toolkit\/sqlite\b|\bopenSqliteDb\b/.test(cleanedCode)) ||
        (/\buseEffect\s*\(/.test(cleanedCode) &&
            /\bfetch\s*\(/.test(cleanedCode) &&
            !/\b(?:AbortController|signal|useApiQuery|useSSEStream|fetchApiJson)\b/.test(cleanedCode)) ||
        (/\bcreateHmac\s*\(/.test(cleanedCode) &&
            !contentIncludesWebhooktoolkit(cleanedCode) &&
            /\b(?:x-slack-signature|x-hub-signature-256|stripe-signature)\b/i.test(cleanedCode)) ||
        (/\bmulter\s*\(/.test(cleanedCode) &&
            !/@krusch\/toolkit\/upload\b|\bparseBoundedMultipart\b/.test(cleanedCode)) ||
        (cleanedCode.includes('js-yaml') &&
            /\bload(?:All)?\b/.test(cleanedCode) &&
            !/@krusch\/toolkit\/yaml\b|\b(?:parseSafeYaml|loadSafeYamlPack|validateYamlConfig|stringifySafeYaml)\b/.test(
                cleanedCode
            )) ||
        (hasEventStreamToken(cleanedCode) &&
            !/@krusch\/toolkit\/(?:streaming|edge)\b/.test(cleanedCode))
    );
}

function contentIncludesWebhooktoolkit(cleanedCode) {
    return /@krusch\/toolkit\/webhooks\b|\b(?:verifySlackSignature|verifyGithubSignature|verifyStripeSignature)\b/.test(
        cleanedCode
    );
}

const SIGNATURE_BIT_HINTS = new Map([
    ['sqlite-fts5-rrf', (lo, _hi, isPython) => !isPython && (lo & SIG_LO_SQLITE) !== 0],
    ['ssrf-and-rate-limit', (lo) => (lo & SIG_LO_SSRF_RATE) !== 0],
    ['python-mcp-pgvector-parity', (lo, _hi, isPython) => isPython && (lo & SIG_LO_PY_MCP_PG) !== 0],
    ['cascade-swarm-routing', (lo) => (lo & SIG_LO_CASCADE) !== 0],
    [
        'schema-contract-validation',
        (lo, hi, isPython) => !isPython && ((lo & SIG_LO_SCHEMA) !== 0 || (hi & SIG_HI_SCHEMA) !== 0),
    ],
    ['multipart-file-upload', (_lo, hi) => (hi & SIG_HI_UPLOAD) !== 0],
    ['voice-whisper-audio', (_lo, hi) => (hi & SIG_HI_AUDIO) !== 0],
    ['niche-xml-or-yaml', (_lo, hi, isPython) => !isPython && (hi & SIG_HI_XML) !== 0],
    ['python-httpx-resilience', (_lo, hi, isPython) => isPython && (hi & SIG_HI_PY_HTTPX) !== 0],
    ['streamlit-rag-shell', (_lo, hi, isPython) => isPython && (hi & SIG_HI_STREAMLIT) !== 0],
    ['python-sqlalchemy-wal-pool', (_lo, hi, isPython) => isPython && (hi & SIG_HI_PY_SQLALCHEMY) !== 0],
    ['yaml-safe-config-loader', (_lo, hi) => (hi & SIG_HI_YAML) !== 0],
]);

/**
 * Record normalized Python package names (both raw lowercase and PEP 503 hyphenated).
 *
 * @param {Set<string>} targetSet
 * @param {string} rawPkgName
 */
function addNormalizedPythonDep(targetSet, rawPkgName) {
    const clean = String(rawPkgName || '').trim().toLowerCase();
    if (!clean || clean === 'python') return;
    targetSet.add(clean);
    targetSet.add(clean.replace(/[_.]+/g, '-'));
    targetSet.add(clean.replace(/[-.]+/g, '_'));
}

/**
 * Safely parse Node (`package.json`) and Python (`requirements.txt`, `pyproject.toml`)
 * package dependencies inside `projectDir`.
 *
 * @param {string} projectDir
 * @param {string} realProjectsRoot
 * @param {number} maxFileBytes
 * @returns {{ allDeps: Set<string>, nodeDeps: Set<string>, pythonDeps: Set<string>, nodeManifest: string | null, pythonManifest: string | null }}
 */
function parseProjectDependencies(projectDir, realProjectsRoot, maxFileBytes) {
    const nodeDeps = new Set();
    const pythonDeps = new Set();
    let nodeManifest = null;
    let pythonManifest = null;

    const pkgCandidates = [
        path.join(projectDir, 'package.json'),
        path.join(projectDir, 'server', 'package.json'),
        path.join(projectDir, 'client', 'package.json'),
    ];

    for (const pkgPath of pkgCandidates) {
        const readRes = readContainedFileBounded(pkgPath, realProjectsRoot, maxFileBytes);
        if (!readRes) continue;
        try {
            const parsed = JSON.parse(readRes.content);
            if (!parsed || typeof parsed !== 'object') continue;
            if (!nodeManifest) nodeManifest = pkgPath;
            for (const section of [parsed.dependencies, parsed.devDependencies, parsed.peerDependencies]) {
                if (section && typeof section === 'object') {
                    for (const depName of Object.keys(section)) {
                        const normalized = String(depName || '').trim().toLowerCase();
                        if (normalized) nodeDeps.add(normalized);
                    }
                }
            }
        } catch {
            // Ignore malformed package.json
        }
    }

    const reqCandidates = [
        path.join(projectDir, 'requirements.txt'),
        path.join(projectDir, 'server', 'requirements.txt'),
        path.join(projectDir, 'backend', 'requirements.txt'),
    ];

    for (const reqPath of reqCandidates) {
        const readRes = readContainedFileBounded(reqPath, realProjectsRoot, maxFileBytes);
        if (!readRes) continue;
        try {
            if (!pythonManifest) pythonManifest = reqPath;
            for (const rawLine of readRes.content.split(/\r?\n/)) {
                const uncommented = rawLine.split('#')[0].trim();
                if (!uncommented) continue;
                if (uncommented.startsWith('-')) {
                    if (/krusch[-_]toolkit|lib-py/i.test(uncommented)) {
                        addNormalizedPythonDep(pythonDeps, 'krusch-toolkit');
                    }
                    continue;
                }
                const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(uncommented);
                if (match) {
                    addNormalizedPythonDep(pythonDeps, match[1]);
                }
            }
        } catch {
            // Ignore malformed requirements.txt
        }
    }

    const pyprojectPath = path.join(projectDir, 'pyproject.toml');
    const pyRes = readContainedFileBounded(pyprojectPath, realProjectsRoot, maxFileBytes);
    if (pyRes) {
        try {
            if (!pythonManifest) pythonManifest = pyprojectPath;
            const lines = pyRes.content.split(/\r?\n/);
            let inPoetryDeps = false;

            for (const rawLine of lines) {
                const line = rawLine.split('#')[0].trim();
                if (!line) continue;

                if (line.startsWith('[')) {
                    inPoetryDeps = /^\[tool\.poetry\.(?:group\.[^.]+\.)?dependencies\]$/i.test(line);
                    continue;
                }

                if (inPoetryDeps) {
                    const kvMatch = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*=/.exec(line);
                    if (kvMatch) addNormalizedPythonDep(pythonDeps, kvMatch[1]);
                }

                // PEP 621 / optional-dependencies quoted specifiers: "fastmcp>=0.4", 'psycopg2-binary'
                const specRe = /['"]([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?(?:\s*(?:[<>=!~;@].*)?)?['"]/g;
                let specMatch;
                while ((specMatch = specRe.exec(line)) !== null) {
                    const token = specMatch[1];
                    // Exclude obvious metadata keys/values like version strings ("0.1.0") or python_requires
                    if (!/^\d/.test(token) && !line.startsWith('name') && !line.startsWith('description')) {
                        addNormalizedPythonDep(pythonDeps, token);
                    }
                }
            }
        } catch {
            // Ignore malformed pyproject.toml
        }
    }

    const allDeps = new Set([...nodeDeps, ...pythonDeps]);
    return { allDeps, nodeDeps, pythonDeps, nodeManifest, pythonManifest };
}

/**
 * Deterministically scout a multi-project root directory for:
 *   1. Existing `@krusch/toolkit` / `krusch_toolkit` boilerplate adoption opportunities (`adoptionFindings`)
 *   2. Cross-repository recurring infrastructure patterns classified via the Rule-of-3 (`candidateClusters`)
 *
 * Never throws; returns an `INV-LEGO-01` envelope (`tool: 'lego.scout'`).
 *
 * @param {string} projectsRoot - Path to workspace `projects/` directory
 * @param {object} [options={}]
 * @param {number} [options.minProjects=3] - Rule-of-3 minimum project count (clamped `>= 2`)
 * @param {number} [options.maxFilesPerProject=400] - Bounded source file walk cap per project
 * @param {number} [options.maxFileBytes=262144] - Pre-read byte ceiling per file (default 256 KiB)
 * @param {boolean} [options.portablePaths=false] - Emit `<HOMELAB_ROOT>/projects/...` portable paths (`INV-STACK-04`)
 * @returns {{ ok: boolean, tool: string, summary: string, data?: object, error?: object }}
 */
export function scoutHomelabLegoCandidates(projectsRoot, options = {}) {
    try {
        const opts = options && typeof options === 'object' ? options : {};
        const {
            minProjects = 3,
            maxFilesPerProject = 400,
            maxFileBytes = 262_144,
            portablePaths = false,
        } = opts;

        if (typeof projectsRoot !== 'string' || !projectsRoot.trim()) {
            return errorEnvelope(
                'SCOUT_INVALID_ROOT',
                `Projects root directory not found: ${projectsRoot}`,
                null,
                TOOL_NAME
            );
        }

        let realProjectsRoot;
        try {
            const rootStat = fs.statSync(projectsRoot);
            if (!rootStat.isDirectory()) {
                return errorEnvelope(
                    'SCOUT_INVALID_ROOT',
                    `Projects root directory not found: ${projectsRoot}`,
                    null,
                    TOOL_NAME
                );
            }
            realProjectsRoot = fs.realpathSync(projectsRoot);
        } catch {
            return errorEnvelope(
                'SCOUT_INVALID_ROOT',
                `Projects root directory not found: ${projectsRoot}`,
                null,
                TOOL_NAME
            );
        }

        const threshold = Math.max(2, Math.trunc(Number(minProjects) || 3));
        const fileLimit =
            Number.isFinite(Number(maxFilesPerProject)) && Number(maxFilesPerProject) >= 0
                ? Math.trunc(Number(maxFilesPerProject))
                : 400;
        const byteLimit =
            Number.isFinite(Number(maxFileBytes)) && Number(maxFileBytes) > 0
                ? Math.trunc(Number(maxFileBytes))
                : 262_144;
        const usePortable = Boolean(portablePaths);

        const formatEvidencePath = (targetAbs) =>
            usePortable ? formatPortableProjectPath(targetAbs, realProjectsRoot) : targetAbs;

        const topEntries = fs
            .readdirSync(realProjectsRoot, { withFileTypes: true })
            .sort((a, b) => compareStrings(a.name, b.name));

        // Record canonical (non-symlink) project directories so symlink aliases inside projectsRoot
        // (e.g., legacy name -> canonical repo) never double-count toward Rule-of-3.
        const canonicalTopDirs = new Set();
        for (const entry of topEntries) {
            if (entry.name.startsWith('.') || SKIP_TOP_PROJECTS.has(entry.name)) continue;
            if (!entry.isSymbolicLink() && entry.isDirectory()) {
                canonicalTopDirs.add(path.join(realProjectsRoot, entry.name));
            }
        }

        const clusterState = new Map(
            CANDIDATE_PATTERN_SIGNATURES.map((sig) => [
                sig.id,
                {
                    sig,
                    projectSampleMap: new Map(), // projectName -> string[] (up to 3 sample paths)
                },
            ])
        );

        const adoptionFindings = [];
        const seenRealProjectDirs = new Set();
        let scannedProjects = 0;
        let scannedFilesTotal = 0;

        const OPEN_NOFOLLOW_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
        let scratchBuf = Buffer.allocUnsafe(Math.max(4096, Math.min(byteLimit, 524_288)));

        const readIntoScratchBounded = (targetAbs, openFlags) => {
            let fd;
            try {
                fd = fs.openSync(targetAbs, openFlags);
            } catch {
                return -1;
            }
            try {
                const st = fs.fstatSync(fd);
                if (!st.isFile() || st.size > byteLimit) {
                    return -1;
                }
                const total = st.size;
                if (total === 0) return 0;
                if (total > scratchBuf.length) {
                    scratchBuf = Buffer.allocUnsafe(total);
                }
                let offset = 0;
                while (offset < total) {
                    const n = fs.readSync(fd, scratchBuf, offset, total - offset, offset);
                    if (n <= 0) break;
                    offset += n;
                }
                return offset;
            } catch {
                return -1;
            } finally {
                try {
                    fs.closeSync(fd);
                } catch {
                    // Ignore close errors
                }
            }
        };

        for (const entry of topEntries) {
            const projectName = entry.name;
            if (projectName.startsWith('.') || SKIP_TOP_PROJECTS.has(projectName)) {
                continue;
            }

            const entryAbs = path.join(realProjectsRoot, projectName);
            let realProjectDir;
            try {
                const lst = fs.lstatSync(entryAbs);
                if (lst.isSymbolicLink()) {
                    realProjectDir = fs.realpathSync(entryAbs);
                    if (
                        !isContainedInProjectsRoot(realProjectDir, realProjectsRoot) ||
                        realProjectDir === realProjectsRoot
                    ) {
                        continue;
                    }
                    const targetStat = fs.statSync(realProjectDir);
                    if (!targetStat.isDirectory()) continue;
                    if (canonicalTopDirs.has(realProjectDir)) continue;
                } else if (lst.isDirectory()) {
                    realProjectDir = entryAbs;
                } else {
                    continue;
                }
            } catch {
                continue;
            }

            if (seenRealProjectDirs.has(realProjectDir)) {
                continue;
            }
            seenRealProjectDirs.add(realProjectDir);
            scannedProjects += 1;

            const recordClusterHit = (sigId, evidenceAbs) => {
                const bucket = clusterState.get(sigId);
                if (!bucket) return;
                let samples = bucket.projectSampleMap.get(projectName);
                if (!samples) {
                    samples = [];
                    bucket.projectSampleMap.set(projectName, samples);
                }
                if (evidenceAbs && samples.length < MAX_SAMPLES_PER_PROJECT) {
                    const formatted = formatEvidencePath(evidenceAbs);
                    if (!samples.includes(formatted)) {
                        samples.push(formatted);
                    }
                }
            };

            // 1. Evaluate package manifests safely
            const { allDeps, nodeDeps, pythonDeps, nodeManifest, pythonManifest } =
                parseProjectDependencies(realProjectDir, realProjectsRoot, byteLimit);

            if (allDeps.size > 0) {
                for (const sig of CANDIDATE_PATTERN_SIGNATURES) {
                    if (typeof sig.detectPackage !== 'function') continue;
                    try {
                        if (sig.detectPackage(allDeps)) {
                            let manifestAbs = nodeManifest || pythonManifest || realProjectDir;
                            if (sig.runtime === 'python' && pythonManifest) {
                                manifestAbs = pythonManifest;
                            } else if (
                                nodeManifest &&
                                nodeDeps.size > 0 &&
                                sig.detectPackage(nodeDeps)
                            ) {
                                manifestAbs = nodeManifest;
                            } else if (
                                pythonManifest &&
                                pythonDeps.size > 0 &&
                                sig.detectPackage(pythonDeps)
                            ) {
                                manifestAbs = pythonManifest;
                            }
                            recordClusterHit(sig.id, manifestAbs);
                        }
                    } catch {
                        // Fault-isolate individual package detectors
                    }
                }
            }

            // 2. Walk up to maxFilesPerProject bounded source files
            let projectFilesScanned = 0;
            let projectFindingCount = 0;
            const rulesTriggeredSet = new Set();
            const recommendedBricksSet = new Set();
            const adoptionSampleFiles = [];
            const visitedDirs = new Set([realProjectDir]);

            const walkProject = (currentRealDir, displayDirAbs) => {
                if (projectFilesScanned >= fileLimit) return;
                let dirEntries;
                try {
                    dirEntries = fs
                        .readdirSync(currentRealDir, { withFileTypes: true })
                        .sort((a, b) => compareStrings(a.name, b.name));
                } catch {
                    return;
                }

                // Skip custom-named Python virtual environments (e.g., bench_venv, mcp_env)
                if (dirEntries.some((d) => d.name === 'pyvenv.cfg')) {
                    return;
                }

                for (const child of dirEntries) {
                    if (projectFilesScanned >= fileLimit) return;
                    const childName = child.name;
                    if (
                        childName.startsWith('.') ||
                        SKIP_SUBDIRECTORIES.has(childName) ||
                        childName.endsWith('.egg-info')
                    ) {
                        continue;
                    }

                    const childRealJoin = path.join(currentRealDir, childName);
                    const childDisplayAbs = path.join(displayDirAbs, childName);

                    if (child.isSymbolicLink()) {
                        let resolvedChild;
                        let resolvedStat;
                        try {
                            resolvedChild = fs.realpathSync(childRealJoin);
                            if (!isContainedInProjectsRoot(resolvedChild, realProjectsRoot)) {
                                continue;
                            }
                            resolvedStat = fs.statSync(resolvedChild);
                        } catch {
                            continue;
                        }

                        if (resolvedStat.isDirectory()) {
                            if (visitedDirs.has(resolvedChild)) continue;
                            visitedDirs.add(resolvedChild);
                            walkProject(resolvedChild, childDisplayAbs);
                            continue;
                        }

                        if (!resolvedStat.isFile()) continue;
                        const ext = path.extname(childName).toLowerCase();
                        if (!SCAN_SOURCE_EXTS.has(ext) || SKIP_TEST_FILE_RE.test(childName)) {
                            continue;
                        }
                        if (resolvedStat.size > byteLimit) continue;

                        const bytesRead = readIntoScratchBounded(resolvedChild, fs.constants.O_RDONLY);
                        if (bytesRead < 0) continue;
                        inspectScratchBuffer(bytesRead, ext, childDisplayAbs);
                        continue;
                    }

                    if (child.isDirectory()) {
                        if (visitedDirs.has(childRealJoin)) continue;
                        visitedDirs.add(childRealJoin);
                        walkProject(childRealJoin, childDisplayAbs);
                        continue;
                    }

                    if (child.isFile()) {
                        const ext = path.extname(childName).toLowerCase();
                        if (!SCAN_SOURCE_EXTS.has(ext) || SKIP_TEST_FILE_RE.test(childName)) {
                            continue;
                        }

                        const bytesRead = readIntoScratchBounded(childRealJoin, OPEN_NOFOLLOW_FLAGS);
                        if (bytesRead < 0) continue;
                        inspectScratchBuffer(bytesRead, ext, childDisplayAbs);
                    }
                }
            };

            const inspectScratchBuffer = (bytesRead, ext, displayFileAbs) => {
                projectFilesScanned += 1;
                scannedFilesTotal += 1;
                if (bytesRead === 0) return;

                let state = 0;
                let lo = 0;
                let hi = 0;
                const dfa = AHO_DFA_TABLE;
                const maskLo = AHO_MASK_LO;
                const maskHi = AHO_MASK_HI;
                const lut = AHO_ASCII_LUT;
                const buf = scratchBuf;

                for (let i = 0; i < bytesRead; i += 1) {
                    state = dfa[(state << 7) + lut[buf[i]]];
                    lo |= maskLo[state];
                    hi |= maskHi[state];
                }

                if (lo === 0 && hi === 0) {
                    return;
                }

                const isPython = ext === '.py';
                let content = null;
                let cleanedCode = null;
                const getContent = () => {
                    if (content === null) {
                        content = scratchBuf.toString('utf8', 0, bytesRead);
                    }
                    return content;
                };
                const getCleaned = () => {
                    if (cleanedCode === null) {
                        cleanedCode = stripSourceComments(getContent(), ext);
                    }
                    return cleanedCode;
                };

                if (mayMatchBoilerplateBits(lo, hi, isPython)) {
                    const stripped = getCleaned();
                    if (mayTriggerCatalogBoilerplate(stripped, isPython)) {
                        const relToProject = path
                            .relative(entryAbs, displayFileAbs)
                            .split(path.sep)
                            .join('/');
                        const auditLabel = `projects/${projectName}/${relToProject}`;
                        const auditRes = auditBoilerplateText(getContent(), auditLabel);
                        const fileFindings = auditRes?.data?.findings;
                        if (Array.isArray(fileFindings) && fileFindings.length > 0) {
                            projectFindingCount += fileFindings.length;
                            for (const f of fileFindings) {
                                if (f.ruleId) rulesTriggeredSet.add(f.ruleId);
                                if (f.importPath || f.brickId) {
                                    recommendedBricksSet.add(f.importPath || f.brickId);
                                }
                            }
                            if (adoptionSampleFiles.length < MAX_SAMPLES_PER_PROJECT) {
                                adoptionSampleFiles.push(formatEvidencePath(displayFileAbs));
                            }
                        }
                    }
                }

                for (const sig of CANDIDATE_PATTERN_SIGNATURES) {
                    if (typeof sig.detectSource !== 'function') continue;
                    const existingSamples = clusterState.get(sig.id)?.projectSampleMap.get(projectName);
                    if (existingSamples && existingSamples.length >= MAX_SAMPLES_PER_PROJECT) {
                        continue;
                    }
                    const hintFn = SIGNATURE_BIT_HINTS.get(sig.id);
                    if (hintFn && !hintFn(lo, hi, isPython)) {
                        continue;
                    }
                    try {
                        if (sig.detectSource(getCleaned(), ext)) {
                            recordClusterHit(sig.id, displayFileAbs);
                        }
                    } catch {
                        // Fault-isolate individual source detectors
                    }
                }
            };

            walkProject(realProjectDir, entryAbs);

            if (projectFindingCount > 0) {
                adoptionFindings.push({
                    project: projectName,
                    findingCount: projectFindingCount,
                    rulesTriggered: [...rulesTriggeredSet].sort(compareStrings),
                    recommendedBricks: [...recommendedBricksSet].sort(compareStrings),
                    sampleFiles: adoptionSampleFiles,
                });
            }
        }

        adoptionFindings.sort(
            (a, b) => b.findingCount - a.findingCount || compareStrings(a.project, b.project)
        );

        const candidateClusters = [];
        for (const { sig, projectSampleMap } of clusterState.values()) {
            const projects = [...projectSampleMap.keys()].sort(compareStrings);
            const projectCount = projects.length;
            if (projectCount === 0) continue;

            const meetsRuleOfThree = projectCount >= threshold;
            let status;
            if (sig.statusWhenCovered) {
                status = 'ALREADY_COVERED_IN_TOOLKIT';
            } else if (meetsRuleOfThree) {
                status = 'CANDIDATE_MEETS_RULE_OF_3';
            } else {
                status = 'BELOW_THRESHOLD_DO_NOT_EXTRACT';
            }

            // Round-robin sample selection across matched projects so multi-project diversity is preserved first
            const sampleEvidence = [];
            for (let pass = 0; pass < MAX_SAMPLES_PER_PROJECT; pass += 1) {
                for (const proj of projects) {
                    if (sampleEvidence.length >= MAX_CLUSTER_EVIDENCE) break;
                    const projSamples = projectSampleMap.get(proj) || [];
                    if (pass < projSamples.length && !sampleEvidence.includes(projSamples[pass])) {
                        sampleEvidence.push(projSamples[pass]);
                    }
                }
                if (sampleEvidence.length >= MAX_CLUSTER_EVIDENCE) break;
            }

            candidateClusters.push({
                id: sig.id,
                title: sig.title,
                runtime: sig.runtime,
                category: sig.category,
                projectCount,
                meetsRuleOfThree,
                status,
                proposedBrickImport: sig.proposedBrickImport,
                antiBloatNote: sig.antiBloatNote,
                projects,
                sampleEvidence,
            });
        }

        candidateClusters.sort(
            (a, b) => b.projectCount - a.projectCount || compareStrings(a.id, b.id)
        );

        const qualifyingCount = candidateClusters.filter(
            (cluster) => cluster.status === 'CANDIDATE_MEETS_RULE_OF_3'
        ).length;

        const summary = `Scouted ${scannedProjects} project(s): ${adoptionFindings.length} project(s) with adoption opportunities, ${qualifyingCount} candidate cluster(s) meeting Rule-of-${threshold}`;

        return okEnvelope(TOOL_NAME, summary, {
            projectsRoot: usePortable ? PORTABLE_PROJECTS_ROOT : realProjectsRoot,
            scannedProjects,
            scannedFilesTotal,
            ruleOfThreeThreshold: threshold,
            adoptionFindings,
            candidateClusters,
        });
    } catch (err) {
        return errorEnvelope(
            'SCOUT_FAILED',
            err?.message || 'Unexpected error while scouting Lego candidates',
            null,
            TOOL_NAME
        );
    }
}
