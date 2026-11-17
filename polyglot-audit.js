/**
 * @module polyglot-audit
 * @description Sub-millisecond polyglot brownfield security & modernization hazard scanner
 * across 10 languages / 14 extensions (PHP, Java, C#, Go, Ruby, Rust, Kotlin, JS/TS, Python)
 * plus SSRF-safe GitHub repository input normalizer (`INV-LEGO-01`, `INV-LEGO-13`).
 *
 * Complements `@krusch/toolkit/catalog` (`scoreLegoBrickCoverage` = 16 JS/TS/Py Slop-Breaker rules)
 * with 12 polyglot enterprise & PHP-to-Next.js hazard detectors (28 combined rules) mapping
 * legacy patterns directly to sealed `@krusch/toolkit` bricks.
 */

import fs from 'node:fs';
import path from 'node:path';
import { okEnvelope, errorEnvelope } from './http.js';
import { scoreLegoBrickCoverage } from './catalog.js';

const POLYGLOT_ONLY_EXTS = new Set(['.java', '.cs', '.go', '.rb', '.rs', '.kt']);
const ALL_SCANNABLE_EXTS = new Set([
    '.js',
    '.mjs',
    '.cjs',
    '.ts',
    '.jsx',
    '.tsx',
    '.py',
    '.php',
    '.java',
    '.cs',
    '.go',
    '.rb',
    '.rs',
    '.kt',
]);

const SKIPPED_DIRS = new Set([
    '.git',
    'node_modules',
    'vendor',
    'dist',
    'build',
    'target',
    'bin',
    'obj',
    'coverage',
    '.next',
    '.cache',
    '.gradle',
    '.mvn',
    '.venv',
    'venv',
    '__pycache__',
    '.krusch-stack',
]);

const SENSITIVE_LOCAL_PREFIXES = [
    '/etc',
    '/private/etc',
    '/root',
    '/proc',
    '/sys',
    '/dev',
    '/boot',
    '/var/run',
    '/private/var/run',
    '/run',
];

const SENSITIVE_SEGMENT_NAMES = new Set(['.ssh', '.gnupg', '.aws', '.kube', '.docker']);

const GITHUB_OWNER_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/;
const GITHUB_SEGMENT_RE = /^[A-Za-z0-9_.-]+$/;
const RESERVED_GITHUB_ROOTS = new Set([
    'about',
    'codespaces',
    'collections',
    'customer-stories',
    'enterprise',
    'events',
    'explore',
    'features',
    'issues',
    'login',
    'marketplace',
    'new',
    'notifications',
    'organizations',
    'orgs',
    'pricing',
    'pulls',
    'search',
    'security',
    'session',
    'settings',
    'signup',
    'sponsors',
    'team',
    'topics',
    'trending',
]);

/**
 * Strip `//`, `#`, and `/* ... * /` comments while preserving line numbers.
 *
 * @param {string} source
 * @returns {string}
 */
function stripCommentsPreservingLines(source = '') {
    return String(source || '')
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\r\n]/g, ' '))
        .replace(/(?:\/\/|#).*$/gm, '');
}

/**
 * Normalize browser-copied GitHub URLs (`/tree/<ref>/...`, `/blob/<ref>/<file>`,
 * `github.com/owner/repo`, `owner/repo`, `git@github.com:owner/repo.git`) while rejecting
 * traversal segments (`..`, `%2e%2e`), reserved GitHub routes, and malformed encodings.
 *
 * @param {unknown} rawInput
 */
export function normalizeGitHubRepoInput(rawInput) {
    const raw = String(rawInput ?? '').trim();
    if (!raw) {
        return {
            isRemoteCandidate: false,
            candidateUrl: '',
            repoSlug: null,
            cleanHttpsUrl: null,
            displayTarget: '',
            hintedFile: '',
            invalidGitHubPath: false,
        };
    }

    let candidateUrl = raw;
    let isRemoteCandidate = false;
    const strippedRaw = raw.length > 1 ? raw.replace(/\/+$/, '') : raw;
    const httpGitHubMatch = /^http:\/\/((?:www\.)?github\.com)(?=[/?#]|$)(.*)$/i.exec(strippedRaw);
    const scpMatch = /^git@([A-Za-z0-9.-]+):(.+)$/i.exec(strippedRaw);

    if (scpMatch) {
        isRemoteCandidate = true;
        candidateUrl = `https://${scpMatch[1].toLowerCase()}/${scpMatch[2].replace(/^\/+|\/+$/g, '')}`;
    } else if (/^ssh:\/\/(?:[^@/]+@)?([A-Za-z0-9.-]+)\/(.+)$/i.test(strippedRaw)) {
        const m = /^ssh:\/\/(?:[^@/]+@)?([A-Za-z0-9.-]+)\/(.+)$/i.exec(strippedRaw);
        isRemoteCandidate = true;
        candidateUrl = `https://${m[1].toLowerCase()}/${m[2].replace(/\/+$/g, '')}`;
    } else if (httpGitHubMatch) {
        isRemoteCandidate = true;
        candidateUrl = `https://${httpGitHubMatch[1].toLowerCase()}${httpGitHubMatch[2]}`;
    } else if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) {
        isRemoteCandidate = true;
        candidateUrl = strippedRaw;
    } else if (
        /^(?:www\.)?github\.com(?:\/.*)?$/i.test(strippedRaw) &&
        !fs.existsSync(path.resolve(raw))
    ) {
        isRemoteCandidate = true;
        candidateUrl = `https://${strippedRaw}`;
    } else if (
        !strippedRaw.startsWith('.') &&
        !strippedRaw.startsWith('/') &&
        !strippedRaw.includes('\\') &&
        GITHUB_OWNER_REPO_RE.test(strippedRaw) &&
        !fs.existsSync(path.resolve(raw))
    ) {
        const [segA, segB] = strippedRaw.split('/');
        const cleanSegB = segB.replace(/\.git$/i, '');
        if (segA !== '.' && segA !== '..' && segA !== '.git' && cleanSegB && cleanSegB !== '.' && cleanSegB !== '..') {
            isRemoteCandidate = true;
            candidateUrl = `https://github.com/${segA}/${cleanSegB}`;
        }
    }

    if (!isRemoteCandidate) {
        return {
            isRemoteCandidate: false,
            candidateUrl: raw,
            repoSlug: null,
            cleanHttpsUrl: null,
            displayTarget: raw,
            hintedFile: '',
            invalidGitHubPath: false,
        };
    }

    let parsed;
    try {
        parsed = new URL(candidateUrl);
    } catch {
        return {
            isRemoteCandidate: true,
            candidateUrl,
            repoSlug: null,
            cleanHttpsUrl: null,
            displayTarget: raw,
            hintedFile: '',
            invalidGitHubPath: true,
        };
    }

    const hostLower = parsed.hostname.toLowerCase();
    if (parsed.protocol !== 'https:' || (hostLower !== 'github.com' && hostLower !== 'www.github.com')) {
        return {
            isRemoteCandidate: true,
            candidateUrl,
            repoSlug: null,
            cleanHttpsUrl: null,
            displayTarget: raw,
            hintedFile: '',
            invalidGitHubPath: false,
        };
    }

    const rawPathPortion = raw.split(/[?#]/)[0];
    const hasDotTraversal = /(?:^|[/:\\])\.\.(?:[/\\]|$)|%2e%2e/i.test(rawPathPortion);
    const cleanPathname = parsed.pathname.replace(/\/+$/, '');
    let hasMalformedEncoding = false;
    const rawSegments = cleanPathname
        .replace(/^\/+/, '')
        .split('/')
        .filter(Boolean)
        .map((seg) => {
            try {
                return decodeURIComponent(seg);
            } catch {
                hasMalformedEncoding = true;
                return seg;
            }
        });

    const hasDecodedTraversal = rawSegments.some((seg) => {
        const subs = seg.split(/[/\\]/).filter(Boolean);
        return subs.length === 0 || subs.some((s) => s === '.' || s === '..' || s.includes('\0'));
    });

    if (
        hasDotTraversal ||
        hasMalformedEncoding ||
        hasDecodedTraversal ||
        rawSegments.length < 2 ||
        rawSegments.some((seg) => seg === '.' || seg === '..' || seg.includes('\\') || seg.includes('\0'))
    ) {
        return {
            isRemoteCandidate: true,
            candidateUrl: `https://${hostLower}${cleanPathname}`,
            repoSlug: null,
            cleanHttpsUrl: null,
            displayTarget: raw,
            hintedFile: '',
            invalidGitHubPath: true,
        };
    }

    const owner = rawSegments[0];
    const repo = rawSegments[1].replace(/\.git$/i, '');
    if (
        !owner ||
        !repo ||
        !GITHUB_SEGMENT_RE.test(owner) ||
        !GITHUB_SEGMENT_RE.test(repo) ||
        owner === '.git' ||
        repo === '.git' ||
        repo === '.' ||
        repo === '..' ||
        RESERVED_GITHUB_ROOTS.has(owner.toLowerCase())
    ) {
        return {
            isRemoteCandidate: true,
            candidateUrl: `https://${hostLower}${cleanPathname}`,
            repoSlug: null,
            cleanHttpsUrl: null,
            displayTarget: raw,
            hintedFile: '',
            invalidGitHubPath: true,
        };
    }

    let hintedFile = '';
    if (rawSegments[2] === 'blob' && rawSegments.length >= 5) {
        hintedFile = rawSegments
            .slice(4)
            .join('/')
            .replace(/\/+/g, '/')
            .replace(/^\/+|\/+$/g, '');
    }

    const repoSlug = `${owner}/${repo}`;
    return {
        isRemoteCandidate: true,
        candidateUrl: `https://github.com/${repoSlug}`,
        repoSlug,
        cleanHttpsUrl: `https://github.com/${repoSlug}.git`,
        displayTarget: `https://github.com/${repoSlug}`,
        hintedFile,
        invalidGitHubPath: false,
    };
}

/**
 * Audit a single PHP or polyglot enterprise source file (Java, C#, Go, Ruby, Rust, Kotlin)
 * for legacy security, SQLi, float-currency, SSRF, weak-crypto, and unbounded-query hazards,
 * mapping each finding to its canonical `@krusch/toolkit` replacement brick.
 *
 * @param {string} source
 * @param {string} filePath
 */
export function auditPolyglotSource(source = '', filePath = '') {
    const ext = path.extname(String(filePath || '')).toLowerCase();
    const cleaned = stripCommentsPreservingLines(source);
    const findings = [];

    const pushFinding = (ruleId, brickId, importPath, message) => {
        findings.push({
            filePath: String(filePath || ''),
            ruleId,
            brickId,
            importPath,
            severity: 'error',
            message,
        });
    };

    if (ext === '.php') {
        if (
            /\b(?:round|number_format)\s*\([^;\n]*\$(?:this->)?[A-Za-z0-9_]*(?:price|amount|vat|tax|discount|fee|total|subtotal|cash|pos|tendered|balance)[A-Za-z0-9_]*/i.test(
                cleaned
            ) ||
            /\$(?:this->)?[A-Za-z0-9_]*(?:price|amount|vat|tax|discount|fee|total|subtotal)[A-Za-z0-9_]*\s*=\s*round\s*\(/i.test(
                cleaned
            )
        ) {
            pushFinding(
                'php-float-currency-math',
                'audit-log',
                '@krusch/toolkit/audit-log',
                'Floating-point PHP currency rounding risks sub-cent batch drift; port to integer-cent largest-remainder allocation with @krusch/toolkit/audit-log.'
            );
        }
        if (
            /["']\s*(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b[^"'\n]*\$[A-Za-z_]/i.test(cleaned) ||
            /\bmysqli_query\s*\([^;\n]*\$_(?:GET|POST|REQUEST)/i.test(cleaned)
        ) {
            pushFinding(
                'php-raw-sql-interpolation',
                'sqlite',
                '@krusch/toolkit/sqlite',
                'Interpolated PHP variable inside SQL statement risks SQL injection; port to parameterized @krusch/toolkit/sqlite or @krusch/toolkit/pg queries.'
            );
        }
        if (
            /\bnew\s+PDO\s*\(/.test(cleaned) ||
            /\bmysqli_connect\s*\(/.test(cleaned) ||
            /\becho\b[^;\n]*->getMessage\s*\(\s*\)/.test(cleaned)
        ) {
            pushFinding(
                'php-per-request-pdo-or-sql-leak',
                'sqlite',
                '@krusch/toolkit/sqlite',
                'Per-request PHP DB connection or raw PDOException HTML echo detected; centralize pooled DB access with @krusch/toolkit/sqlite or @krusch/toolkit/pg and @krusch/toolkit/http.'
            );
        }
        if (/\$_(?:POST|GET|REQUEST)\s*\[/.test(cleaned)) {
            pushFinding(
                'php-unvalidated-superglobal-input',
                'schema',
                '@krusch/toolkit/schema',
                'Untyped PHP $_POST/$_GET superglobal intake; validate payloads with @krusch/toolkit/schema (s, validateSchema).'
            );
        }
        if (
            /\bsession_start\s*\(/.test(cleaned) ||
            /\bmcrypt_create_iv\s*\(/.test(cleaned) ||
            /\b(?:md5|sha1)\s*\(/.test(cleaned)
        ) {
            pushFinding(
                'php-legacy-session-or-weak-crypto',
                'auth',
                '@krusch/toolkit/auth',
                'Stateful PHP session_start() or weak/deprecated crypto (mcrypt/md5/sha1) detected; port to stateless httpOnly JWT sessions via @krusch/toolkit/auth.'
            );
        }
        if (
            /\$(?:password|passwd|db_pass|dbpass)\s*=\s*['"][^'"]+['"]/i.test(cleaned) ||
            /\bdefine\s*\(\s*['"]DB_PASS(?:WORD)?['"]\s*,\s*['"][^'"]+['"]\s*\)/i.test(cleaned)
        ) {
            pushFinding(
                'php-hardcoded-db-credentials',
                'config',
                '@krusch/toolkit/config',
                'Hardcoded PHP database credentials in source; externalize configuration via @krusch/toolkit/config (loadProjectConfig, envOr).'
            );
        }
        if (
            /\bSELECT\s+\*\s+FROM\s+[A-Za-z0-9_`]+(?:\s*;|\s*["'])/i.test(cleaned) &&
            !/\bLIMIT\b/i.test(cleaned)
        ) {
            pushFinding(
                'php-unbounded-table-scan',
                'pagination',
                '@krusch/toolkit/pagination',
                'Unbounded SELECT * table scan without cursor limit; port list routes to @krusch/toolkit/pagination (encodeCursor, paginateItems).'
            );
        }
        return findings;
    }

    if (POLYGLOT_ONLY_EXTS.has(ext)) {
        if (
            /\b(?:double|float)\s+[A-Za-z0-9_]*(?:price|amount|fee|tax|vat|total|subtotal|balance|discount|rate)[A-Za-z0-9_]*\b/i.test(
                cleaned
            ) ||
            /\b[A-Za-z0-9_]*(?:price|amount|fee|tax|vat|total|subtotal|balance)[A-Za-z0-9_]*\s*\.\s*round\s*\(\s*2\s*\)/i.test(
                cleaned
            )
        ) {
            pushFinding(
                'polyglot-float-currency-math',
                'audit-log',
                '@krusch/toolkit/audit-log',
                'IEEE-754 float/double currency arithmetic risks sub-cent batch drift; port to integer-cent largest-remainder allocation with @krusch/toolkit/audit-log.'
            );
        }
        if (
            /"\s*(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b[^"\n]*"\s*\+/i.test(cleaned) ||
            /'\s*(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b[^'\n]*'\s*\+/i.test(cleaned) ||
            /\b(?:fmt\.Sprintf|String\.format)\s*\(\s*["'`]\s*(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/i.test(
                cleaned
            ) ||
            /\$"\s*(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b[^"\n]*\{/i.test(cleaned) ||
            /"\s*(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b[^"\n]*#\{/i.test(cleaned)
        ) {
            pushFinding(
                'polyglot-raw-sql-concat',
                'pg',
                '@krusch/toolkit/pg',
                'Interpolated or concatenated SQL query string detected; port to parameterized @krusch/toolkit/pg or @krusch/toolkit/sqlite queries.'
            );
        }
        if (
            /\b(?:http\.(?:Get|Post|NewRequest)|new\s+HttpClient\s*\(|RestTemplate\b|WebClient\.create|Net::HTTP\.|URI\.open\s*\(|reqwest::get\s*\()/.test(
                cleaned
            )
        ) {
            pushFinding(
                'polyglot-unguarded-outbound-http',
                'security',
                '@krusch/toolkit/security',
                'Direct outbound HTTP client call without DNS-pinned SSRF protection; port outbound calls to @krusch/toolkit/security (safeFetch, validateOutboundUrl).'
            );
        }
        if (
            /\bMessageDigest\.getInstance\s*\(\s*["'](?:MD5|SHA-?1)["']\s*\)/i.test(cleaned) ||
            /\b(?:MD5|SHA1)\.Create\s*\(/i.test(cleaned) ||
            /\b(?:md5|sha1)\.(?:New|Sum)\s*\(/.test(cleaned) ||
            /\bDigest::(?:MD5|SHA1)\b/.test(cleaned)
        ) {
            pushFinding(
                'polyglot-weak-crypto-digest',
                'auth',
                '@krusch/toolkit/auth',
                'Legacy MD5/SHA-1 cryptographic digest detected; port authentication and token signing to @krusch/toolkit/auth or SHA-256 HMAC.'
            );
        }
        if (
            /\bSELECT\s+\*\s+FROM\s+[A-Za-z0-9_.`"]+/i.test(cleaned) &&
            !/\b(?:LIMIT|TOP|FETCH\s+FIRST|Pageable)\b/i.test(cleaned)
        ) {
            pushFinding(
                'polyglot-unbounded-select-all',
                'pagination',
                '@krusch/toolkit/pagination',
                'Unbounded SELECT * query without cursor/limit pagination; port list endpoints to @krusch/toolkit/pagination.'
            );
        }
    }

    return findings;
}

function isSensitiveLocalDir(candidatePath) {
    const normalized = path.resolve(candidatePath).replace(/\\/g, '/');
    for (const prefix of SENSITIVE_LOCAL_PREFIXES) {
        if (normalized === prefix || normalized.startsWith(`${prefix}/`)) {
            return true;
        }
    }
    for (const seg of normalized.split('/').filter(Boolean)) {
        if (SENSITIVE_SEGMENT_NAMES.has(seg.toLowerCase())) {
            return true;
        }
    }
    return false;
}

/**
 * Scan a local directory across all 10 languages / 14 extensions, combining the 16 JS/TS/Python
 * `@krusch/toolkit/catalog` Slop-Breaker rules with the 12 PHP & polyglot enterprise hazard rules.
 *
 * @param {string} targetDir
 * @param {{ maxFiles?: number, tool?: string }} [options={}]
 */
export function auditPolyglotRepository(targetDir, options = {}) {
    const safeTool =
        typeof options?.tool === 'string' && options.tool.trim()
            ? options.tool.trim()
            : 'polyglot.audit';
    if (!targetDir || typeof targetDir !== 'string' || !targetDir.trim()) {
        return errorEnvelope('INVALID_TARGET_DIR', 'targetDir must be a non-empty directory path.', null, safeTool);
    }

    const candidateRoot = path.resolve(targetDir.trim());
    if (isSensitiveLocalDir(candidateRoot)) {
        return errorEnvelope('PATH_BLOCKED', 'Scanning sensitive system or credential directories is forbidden.', null, safeTool);
    }

    let realRoot;
    try {
        const lstat = fs.lstatSync(candidateRoot);
        if (lstat.isSymbolicLink()) {
            return errorEnvelope('SYMLINK_ROOT_BLOCKED', 'Symbolic link root directories are rejected.', null, safeTool);
        }
        realRoot = fs.realpathSync(candidateRoot);
        if (!fs.statSync(realRoot).isDirectory()) {
            return errorEnvelope('NOT_A_DIRECTORY', 'targetDir must resolve to a directory.', null, safeTool);
        }
    } catch {
        return errorEnvelope('DIRECTORY_NOT_FOUND', 'Target directory does not exist.', null, safeTool);
    }

    if (isSensitiveLocalDir(realRoot)) {
        return errorEnvelope('PATH_BLOCKED', 'Resolved path targets a sensitive directory.', null, safeTool);
    }

    const maxFiles = Math.max(1, Math.min(Number(options?.maxFiles) || 200, 2000));
    const discovered = [];

    const walk = (curDir) => {
        if (discovered.length >= maxFiles) return;
        let entries;
        try {
            entries = fs.readdirSync(curDir, { withFileTypes: true });
        } catch {
            return;
        }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
            if (discovered.length >= maxFiles) break;
            if (entry.name.startsWith('.') || SKIPPED_DIRS.has(entry.name) || entry.isSymbolicLink()) continue;
            const full = path.join(curDir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            } else if (entry.isFile()) {
                const ext = path.extname(entry.name).toLowerCase();
                if (!ALL_SCANNABLE_EXTS.has(ext)) continue;
                try {
                    const st = fs.statSync(full);
                    if (st.size <= 0 || st.size > 262_144) continue;
                    const buf = fs.readFileSync(full);
                    if (buf.subarray(0, 4096).includes(0)) continue;
                    discovered.push({
                        filePath: path.relative(realRoot, full).replace(/\\/g, '/'),
                        ext,
                        content: buf.toString('utf8'),
                    });
                } catch {
                    // Ignore unreadable file
                }
            }
        }
    };

    walk(realRoot);

    const jsPyFiles = [];
    const polyFindings = [];

    for (const item of discovered) {
        if (item.ext === '.php' || POLYGLOT_ONLY_EXTS.has(item.ext)) {
            polyFindings.push(...auditPolyglotSource(item.content, item.filePath));
        } else {
            jsPyFiles.push({ filePath: item.filePath, content: item.content });
        }
    }

    const baseCoverage = scoreLegoBrickCoverage(jsPyFiles);
    const baseData = baseCoverage.data;
    const allFindings = [...(baseData.findings || []), ...polyFindings];
    const flaggedFiles = new Set(allFindings.map((f) => f.filePath));
    const recommendedBricks = new Set(baseData.recommendedBrickIds || []);
    for (const f of polyFindings) {
        if (f.brickId) recommendedBricks.add(f.brickId);
    }

    const totalTouchpoints = baseData.sealedTouchpoints + allFindings.length;
    const sealedCoverageRatio =
        totalTouchpoints === 0
            ? 1
            : Number((baseData.sealedTouchpoints / totalTouchpoints).toFixed(4));

    return okEnvelope(
        safeTool,
        `Scanned ${discovered.length} file(s) across polyglot workspace: ${allFindings.length} hazard/slop finding(s).`,
        {
            scannedFiles: discovered.length,
            cleanFiles: Math.max(0, discovered.length - flaggedFiles.size),
            flaggedFiles: flaggedFiles.size,
            sealedTouchpoints: baseData.sealedTouchpoints,
            slopFindingCount: allFindings.length,
            sealedCoverageRatio,
            breakerTripped: allFindings.length > 0,
            recommendedBrickIds: [...recommendedBricks].sort(),
            findings: allFindings,
        }
    );
}
