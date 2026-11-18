/**
 * @module git-alignment
 * @description Zero-LLM Deterministic Git Diff, Co-Change Companion Gate, and
 * Causal Commit Rationale Extraction Primitives (`@krusch/toolkit/git-alignment`).
 *
 * Pure Web-Standard ESM (zero `node:*` imports; Cloudflare Workers & Node 22+ compatible).
 * Leaves benchmark-pinned `lib/harness-engineering.js` (`INV-HE-01..06`) 100% untouched.
 */

function deepFreeze(value, seen = new WeakSet()) {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
        return value;
    }
    if (seen.has(value)) return value;
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) {
        const prop = value[key];
        if (prop !== null && (typeof prop === 'object' || typeof prop === 'function')) {
            deepFreeze(prop, seen);
        }
    }
    return Object.freeze(value);
}

/**
 * Default deterministic co-change companion-file invariants (`INV-ALIGN-COCHANGE`).
 */
export const DEFAULT_COCHANGE_RULES = deepFreeze([
    {
        id: 'COCHANGE-OPENAPI-DOCS',
        severity: 'CRITICAL',
        whenGlobs: ['openapi/**'],
        requireGlobs: ['docs/changelog.md', 'CHANGELOG.md'],
        description: 'Every OpenAPI contract update must include a changelog entry in the same change.'
    },
    {
        id: 'COCHANGE-DB-MIGRATION-SCHEMA',
        severity: 'CRITICAL',
        whenGlobs: ['db/migrations/**'],
        requireGlobs: ['db/schema.sql', 'src/db/schema.sql'],
        description: 'Database migrations must stay synchronized with the canonical schema snapshot.'
    }
]);

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: false });

function unquoteGitDiffPath(raw) {
    const trimmed = String(raw || '').trim();
    if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
        const inner = trimmed.slice(1, -1);
        const bytes = [];
        for (let i = 0; i < inner.length; i++) {
            const ch = inner[i];
            if (ch === '\\' && i + 1 < inner.length) {
                const next = inner[i + 1];
                if (/[0-7]{3}/.test(inner.slice(i + 1, i + 4))) {
                    bytes.push(parseInt(inner.slice(i + 1, i + 4), 8));
                    i += 3;
                    continue;
                }
                const escMap = { n: 10, t: 9, r: 13, '\\': 92, '"': 34 };
                if (Object.hasOwn(escMap, next)) {
                    bytes.push(escMap[next]);
                    i += 1;
                    continue;
                }
            }
            const encoded = textEncoder.encode(ch);
            for (const b of encoded) bytes.push(b);
        }
        return textDecoder.decode(new Uint8Array(bytes));
    }
    if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
        return trimmed.slice(1, -1);
    }
    return trimmed;
}

function splitDiffGitHeaderPair(rest) {
    const s = String(rest || '').trim();
    if (!s) return null;
    if (s.startsWith('"')) {
        let i = 1;
        while (i < s.length) {
            if (s[i] === '\\') { i += 2; continue; }
            if (s[i] === '"') break;
            i += 1;
        }
        if (i >= s.length) return null;
        const first = s.slice(0, i + 1);
        const second = s.slice(i + 1).trim();
        return second ? [first, second] : null;
    }
    const bIdx = s.indexOf(' b/');
    if (bIdx !== -1) return [s.slice(0, bIdx), s.slice(bIdx + 1)];
    const qIdx = s.indexOf(' "b/');
    if (qIdx !== -1) return [s.slice(0, qIdx), s.slice(qIdx + 1)];
    const ws = /^(\S+)\s+(\S+)$/.exec(s);
    return ws ? [ws[1], ws[2]] : null;
}

/**
 * Normalizes a repository-relative path from diff headers (`a/foo`, `"b/my file.js"`, `./foo`),
 * returning `null` on `/dev/null`, control chars, or `..` path traversal.
 *
 * @param {string} rawPath
 * @returns {string|null}
 */
export function normalizeDiffRelativePath(rawPath) {
    if (!rawPath || typeof rawPath !== 'string') return null;
    let cleaned = unquoteGitDiffPath(rawPath);
    if (!cleaned || cleaned === '/dev/null' || cleaned.includes('\0')) return null;
    cleaned = cleaned.replace(/\\/g, '/');
    if (cleaned === 'a/dev/null' || cleaned === 'b/dev/null' || cleaned === '/dev/null') return null;
    if (/^[ab]\//.test(cleaned)) {
        cleaned = cleaned.slice(2);
    }
    cleaned = cleaned.replace(/^(?:\.\/)+/, '').replace(/^\/+/, '');
    if (!cleaned) return null;
    const parts = cleaned.split('/');
    if (parts.some((p) => !p || p === '.' || p === '..')) return null;
    return cleaned;
}

/**
 * Extracts all repository-relative file paths touched by a unified diff,
 * including C-quoted paths with spaces and both old and new paths across `git mv` / `git cp`.
 *
 * @param {string} diffText
 * @returns {string[]}
 */
export function extractDiffTouchedFiles(diffText) {
    if (!diffText || typeof diffText !== 'string') return [];
    const seen = new Set();
    for (const line of diffText.split(/\r?\n/)) {
        if (line.startsWith('diff --git ')) {
            const pair = splitDiffGitHeaderPair(line.slice(11));
            if (pair) {
                const left = normalizeDiffRelativePath(pair[0]);
                const right = normalizeDiffRelativePath(pair[1]);
                if (left) seen.add(left);
                if (right) seen.add(right);
            }
            continue;
        }
        const renameOrCopy = /^(?:rename|copy) (?:from|to)\s+(.+)$/.exec(line);
        if (renameOrCopy) {
            const p = normalizeDiffRelativePath(renameOrCopy[1]);
            if (p) seen.add(p);
            continue;
        }
        const hdr = /^(?:---|\+\+\+)\s+([^\t\r\n]+)/.exec(line);
        if (hdr) {
            const p = normalizeDiffRelativePath(hdr[1]);
            if (p) seen.add(p);
        }
    }
    return Array.from(seen);
}

/**
 * Parses old-side hunk line ranges (`@@ -start[,count] +... @@`) per file from a unified diff.
 * Pure additions (`count === 0` or `--- /dev/null`) emit no old-side ranges.
 *
 * @param {string} diffText
 * @param {{ maxHunkLines?: number }} [options]
 * @returns {Record<string, Array<[number, number]>>}
 */
export function parseDiffOldHunks(diffText, options = {}) {
    const maxHunkLines = Number.isFinite(options?.maxHunkLines) && options.maxHunkLines > 0
        ? Math.floor(options.maxHunkLines)
        : 200;
    const out = {};
    if (!diffText || typeof diffText !== 'string') return out;

    let currentOldFile = null;
    for (const line of diffText.split(/\r?\n/)) {
        if (line.startsWith('diff --git ')) {
            currentOldFile = null;
            continue;
        }
        const fromMatch = /^---\s+([^\t\r\n]+)/.exec(line);
        if (fromMatch) {
            const raw = fromMatch[1].trim();
            currentOldFile = raw === '/dev/null' ? null : normalizeDiffRelativePath(raw);
            continue;
        }
        const hunkMatch = /^@@\s+-(\d+)(?:,(\d+))?\s+\+\d+(?:,\d+)?\s+@@/.exec(line);
        if (hunkMatch && currentOldFile) {
            const start = Number(hunkMatch[1]);
            const count = hunkMatch[2] === undefined ? 1 : Number(hunkMatch[2]);
            if (Number.isInteger(start) && start >= 1 && count > 0) {
                if (!Object.hasOwn(out, currentOldFile)) out[currentOldFile] = [];
                out[currentOldFile].push([start, start + Math.min(count, maxHunkLines) - 1]);
            }
        }
    }
    return out;
}

/**
 * Compiles a bounded glob supporting `*`, `**`, and `?` only.
 * Explicitly rejects unsupported `{a,b}`, `[abc]`, `!`, and `\` syntax so rules never fail silently.
 *
 * @param {string} pattern
 * @returns {{ valid: boolean, pattern: string, regex: RegExp|null, error: string|null }}
 */
export function compileSafeCoChangeGlob(pattern) {
    const raw = typeof pattern === 'string' ? pattern.trim() : '';
    if (!raw) {
        return { valid: false, pattern: raw, regex: null, error: 'Glob pattern must be a non-empty string.' };
    }
    if (/[{}\[\]!\\]/.test(raw)) {
        return {
            valid: false,
            pattern: raw,
            regex: null,
            error: `Unsupported glob syntax in "${raw}": only *, **, and ? are permitted.`
        };
    }
    const normalized = raw.replace(/^(?:\.\/)+/, '').replace(/^\/+/, '');
    if (!normalized || normalized.split('/').includes('..')) {
        return { valid: false, pattern: raw, regex: null, error: `Invalid relative glob "${raw}".` };
    }

    let rx = '^';
    let i = 0;
    while (i < normalized.length) {
        const ch = normalized[i];
        if (ch === '*' && normalized[i + 1] === '*') {
            const prevBoundary = i === 0 || normalized[i - 1] === '/';
            if (prevBoundary && normalized[i + 2] === '/') {
                rx += '(?:[^/]+/)*';
                i += 3;
                continue;
            }
            rx += '.*';
            i += 2;
            continue;
        }
        if (ch === '*') {
            rx += '[^/]*';
            i += 1;
            continue;
        }
        if (ch === '?') {
            rx += '[^/]';
            i += 1;
            continue;
        }
        rx += /[.+^$()|]/.test(ch) ? `\\${ch}` : ch;
        i += 1;
    }
    rx += '$';
    return { valid: true, pattern: normalized, regex: new RegExp(rx), error: null };
}

/**
 * Evaluates deterministic co-change companion-file rules (`--when` -> `--require`)
 * against a unified diff and/or changed-file list with zero LLM calls.
 *
 * @param {object} [params={}]
 * @returns {{ ok: boolean, tool: string, summary: string, data: object }}
 */
export function evaluateCoChangeRules(params = {}) {
    const diff = typeof params?.diff === 'string' ? params.diff : '';
    const extraFiles = Array.isArray(params?.changedFiles) ? params.changedFiles : [];
    const rules = Array.isArray(params?.rules) ? params.rules : DEFAULT_COCHANGE_RULES;
    const matchSubpaths = Boolean(params?.matchSubpaths);

    const matchesGlob = (file, compiled) => {
        if (compiled.regex.test(file)) return true;
        if (!matchSubpaths) return false;
        let idx = file.indexOf('/');
        while (idx !== -1) {
            const sub = file.slice(idx + 1);
            if (sub && compiled.regex.test(sub)) return true;
            idx = file.indexOf('/', idx + 1);
        }
        return false;
    };

    const touchedSet = new Set(extractDiffTouchedFiles(diff));
    for (const f of extraFiles) {
        const norm = normalizeDiffRelativePath(f);
        if (norm) touchedSet.add(norm);
    }
    const touchedFiles = Array.from(touchedSet);
    const violations = [];
    const invalidRules = [];

    for (const rule of rules) {
        if (!rule || typeof rule !== 'object') continue;
        const id = String(rule.id || 'COCHANGE-RULE');
        const rawWhen = Array.isArray(rule.whenGlobs || rule.when)
            ? (rule.whenGlobs || rule.when)
            : (rule.when ? [rule.when] : []);
        const rawReq = Array.isArray(rule.requireGlobs || rule.require)
            ? (rule.requireGlobs || rule.require)
            : (rule.require ? [rule.require] : []);

        if (rawWhen.length === 0 || rawReq.length === 0) {
            invalidRules.push({ id, error: 'Rule requires non-empty whenGlobs and requireGlobs arrays.' });
            continue;
        }

        const compiledWhen = rawWhen.map((g) => compileSafeCoChangeGlob(g));
        const compiledReq = rawReq.map((g) => compileSafeCoChangeGlob(g));
        const invalid = [...compiledWhen, ...compiledReq].find((c) => !c.valid);
        if (invalid) {
            invalidRules.push({ id, error: invalid.error });
            continue;
        }

        if (touchedFiles.length === 0) continue;

        const triggeredBy = touchedFiles.filter((file) => compiledWhen.some((c) => matchesGlob(file, c)));
        if (triggeredBy.length === 0) continue;

        const satisfied = touchedFiles.some((file) => compiledReq.some((c) => matchesGlob(file, c)));
        if (!satisfied) {
            const missingAnyOf = compiledReq.map((c) => c.pattern);
            violations.push({
                id,
                severity: rule.severity || 'CRITICAL',
                description: String(
                    rule.description ||
                    `Changes matching ${compiledWhen.map((c) => c.pattern).join(', ')} must also update ${missingAnyOf.join(' or ')}.`
                ),
                triggeredBy,
                missingAnyOf
            });
        }
    }

    const ok = violations.length === 0 && invalidRules.length === 0;
    const summary = ok
        ? `Co-change check passed across ${touchedFiles.length} touched file(s) and ${rules.length} rule(s).`
        : `Co-change check flagged ${violations.length} violation(s) and ${invalidRules.length} invalid rule(s).`;

    return {
        ok,
        tool: 'cochange_guard',
        summary,
        data: {
            passed: ok,
            touchedFiles,
            evaluatedCount: rules.length,
            violations,
            invalidRules
        }
    };
}

// ============================================================================
// Deterministic Commit / PR Causal Rationale Extractor (Zero-LLM)
// ============================================================================

const TRAILER_LINE_RE = /^\s*(?:co-authored-by|signed-off-by|reviewed-by|reviewed-on|acked-by|tested-by|reported-by|suggested-by|helped-by|change-id|pr-url|cc|bug|ticket|tracker|issue)\s*:/i;
const FIXES_ONLY_RE = /^\s*(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?|refs?|see|related to|part of)\b:?\s*(?:#\d+|gh-\d+|[\w.-]+\/[\w.-]+#\d+|https?:\/\/\S+)(?:[\s,;&]+(?:and\s+)?(?:#\d+|gh-\d+|[\w.-]+\/[\w.-]+#\d+|https?:\/\/\S+))*\s*[.]?\s*$/i;
const BUMP_BODY_RE = /^\s*(?:bumps?|updates?|upgrades?)\s+(?:\[?`?[\w@/.-]+`?\]?(?:\([^)]*\))?\s+)?(?:from|to)\b|this pr contains the following updates|^\s*dependabot will resolve/im;
const DUMP_HEADING_RE = /^\s{0,3}(?:#{1,6}\s*)?(?:\*\*)?(?:what'?s changed|release notes?|changelog|full changelog|commits|sourced from)\b/im;
const EXPLICIT_WHY_LABEL_RE = /^(?:why|reason|rationale|motivation)\s*:\s*/i;
const EMPTY_LABEL_RE = /^(?:n\/?a|none|see\b|tbd|todo|-)\b/i;
const NEGATED_BECAUSE_RE = /(?:\bnot|\bnever|n't)\s+(?:just\s+|only\s+|simply\s+)?because\b/i;
const CONVENTIONAL_SUBJECT_RE = /^[a-z]+(?:\([^)]*\))?!?:\s+/i;

const STRONG_CAUSAL_MARKERS = [
    /\bbecause\b/i,
    /\bso that\b/i,
    /\bin order to\b/i,
    /\bto avoid\b/i,
    /\bto prevent\b/i,
    /\bdue to\b/i,
    /\bas a result\b/i,
    /\bwas causing\b/i,
    /\bcaused by\b/i,
    /\bsince\s+(?:(?:the|it|its|this|that|there|a|an|these|those|all|both|each|every|no|not|only)\b(?!\s+(?:last|first|previous|beginning|start|release|version|v?\d))|[\w.:/#-]+\s+(?:is|are|was|were|has|have|had|does|do|can|could|will|would|must|should|may|might|needs?|uses?|stores?|ignores?|supports?|reads?|runs?|returns?|calls?|requires?|handles?|caches?)\b)/i
];

const MEDIUM_CAUSAL_MARKERS = [
    /\binstead of\b/i,
    /\brather than\b/i,
    /\bpreviously\b/i,
    /\bno longer\b/i,
    /\botherwise\b/i,
    /\bto fix\b/i,
    /\bregression\b/i
];

const PROBLEM_NOUN_RE = /\b(?:break(?:s|ing)?|broke|broken|fail(?:s|ed|ing|ure)?|crash(?:es|ed|ing)?|leak(?:s|ed|ing)?|corrupt(?:s|ed|ion)?|deadlock(?:s|ed)?|race\b|timeout(?:s)?|hang(?:s|ing)?|bug(?:s)?|error(?:s)?|wrong(?:ly)?|incorrect(?:ly)?|vulnerab\w*|cache[sd]?)\b/i;

function stripInlineMarkup(text) {
    return String(text || '')
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/<\/?[a-z][a-z0-9]*\b[^>]*>/gi, ' ')
        .replace(/(\*\*|__)(.+?)\1/g, '$2')
        .replace(/`([^`]*)`/g, '$1')
        .replace(/\s+/g, ' ')
        .trim();
}

function contentWords(text) {
    return String(text || '')
        .toLowerCase()
        .match(/[a-z0-9]{3,}/g) || [];
}

function repeatsCommitTitle(sentence, titleWordSet) {
    if (titleWordSet.size < 3) return false;
    const words = contentWords(sentence);
    if (words.length === 0) return true;
    let overlap = 0;
    for (const w of words) {
        if (titleWordSet.has(w)) overlap += 1;
    }
    return overlap / words.length >= 0.8 && words.length <= titleWordSet.size + 3;
}

function capAtWordBoundary(sentence, maxChars) {
    if (sentence.length <= maxChars) return sentence;
    const cut = sentence.slice(0, maxChars - 3);
    const lastSpace = cut.lastIndexOf(' ');
    return (lastSpace > Math.floor(maxChars * 0.5) ? cut.slice(0, lastSpace) : cut).trimEnd() + '...';
}

/**
 * Deterministically extracts up to `maxSentences` stated causal sentences (`because`, `so that`,
 * `to prevent`, `Why:`, etc.) from a commit or PR body with zero LLM calls.
 * Returns `null` when no genuine causal rationale is stated (Dependabot bumps, trailers, or bare summaries).
 *
 * @param {string} title - Commit subject or PR title.
 * @param {string|null|undefined} body - Commit or PR body text.
 * @param {{ maxSentences?: number, maxCharsPerSentence?: number }} [options]
 * @returns {string|null}
 */
export function extractCommitCausalRationale(title, body, options = {}) {
    if (!body || typeof body !== 'string') return null;
    const maxSentences = Number.isFinite(options?.maxSentences) && options.maxSentences > 0
        ? Math.floor(options.maxSentences)
        : 2;
    const maxChars = Number.isFinite(options?.maxCharsPerSentence) && options.maxCharsPerSentence >= 40
        ? Math.floor(options.maxCharsPerSentence)
        : 180;

    let text = body.replace(/\r\n?/g, '\n').slice(0, 6000);
    if (BUMP_BODY_RE.test(text)) return null;

    const dumpMatch = DUMP_HEADING_RE.exec(text);
    if (dumpMatch) text = text.slice(0, dumpMatch.index);

    // Strip HTML comments and fenced code blocks
    text = text
        .replace(/<!--[\s\S]*?(?:-->|$)/g, '\n')
        .replace(/^\s*(```|~~~)[\s\S]*?(?:^\s*\1|$(?![\s\S]))/gm, '\n');

    const flatTitle = String(title || '').replace(/\s+/g, ' ').trim();
    const titleWords = new Set(contentWords(flatTitle.replace(CONVENTIONAL_SUBJECT_RE, '')));

    const paragraphs = [];
    let buf = [];
    for (const rawLine of text.split('\n')) {
        const trimmed = rawLine.trim();
        if (!trimmed) {
            if (buf.length > 0) { paragraphs.push(buf.join(' ')); buf = []; }
            continue;
        }
        if (TRAILER_LINE_RE.test(trimmed) || FIXES_ONLY_RE.test(trimmed) || /^\|.*\|$/.test(trimmed)) {
            if (buf.length > 0) { paragraphs.push(buf.join(' ')); buf = []; }
            continue;
        }
        if (/^(?:[-*+]|\d+[.)])\s+/.test(trimmed)) {
            if (buf.length > 0) { paragraphs.push(buf.join(' ')); buf = []; }
            paragraphs.push(trimmed.replace(/^(?:[-*+]|\d+[.)])\s+/, ''));
            continue;
        }
        buf.push(trimmed);
    }
    if (buf.length > 0) paragraphs.push(buf.join(' '));

    const candidates = [];
    let pos = 0;

    for (const para of paragraphs) {
        let cleaned = stripInlineMarkup(para);
        if (!cleaned || cleaned === flatTitle) continue;

        let labelled = false;
        const labelMatch = EXPLICIT_WHY_LABEL_RE.exec(cleaned);
        if (labelMatch) {
            labelled = true;
            cleaned = cleaned.slice(labelMatch[0].length).trim();
            if (!cleaned || EMPTY_LABEL_RE.test(cleaned)) continue;
        }

        const sentences = cleaned.split(/(?<=[.!?])\s+(?=[A-Z0-9"'(\[])/);
        for (let idx = 0; idx < sentences.length; idx++) {
            const s = sentences[idx].trim();
            pos += 1;
            const isLabelFirst = labelled && idx === 0;
            const words = s.split(/\s+/).filter(Boolean);
            if (words.length < 5 || /\?$/.test(s)) continue;
            if (!isLabelFirst && repeatsCommitTitle(s, titleWords)) continue;

            const unquoted = s.replace(/"[^"]*"/g, ' ');
            if (NEGATED_BECAUSE_RE.test(unquoted)) continue;

            let score = 0;
            if (isLabelFirst) {
                score = 4;
            } else if (STRONG_CAUSAL_MARKERS.some((rx) => rx.test(unquoted))) {
                score = 3;
            } else if (MEDIUM_CAUSAL_MARKERS.some((rx) => rx.test(unquoted)) && PROBLEM_NOUN_RE.test(unquoted)) {
                score = 2;
            }

            if (score >= 2) {
                candidates.push({ pos, score, text: capAtWordBoundary(s, maxChars) });
            }
        }
    }

    if (candidates.length === 0) return null;
    const top = [...candidates]
        .sort((a, b) => (b.score - a.score) || (a.pos - b.pos))
        .slice(0, maxSentences)
        .sort((a, b) => a.pos - b.pos);
    return top.map((c) => c.text).join(' ');
}
