/**
 * @module @krusch/toolkit/brick-exchange/blast-radius
 * @description Deadbolt 2-Hop AST Blast-Radius Graph, Multi-Agent / Multi-Engineer Disjoint Fan-Out
 * Wave Planner, Policy-Floor Workaround Blocker (`INV-DB-05`), and Out-of-Process 2-Hop Downstream
 * Invariant Gate (`INV-LEGO-35`).
 *
 * Bridges Common Ground's 0-hop isolated brick verification with DEADBOLT's 2-hop repository
 * governance:
 *   1. Maps exact 1-hop and 2-hop AST dependency chains (`hop0 -> hop1 -> hop2`, e.g.,
 *      `bricks/fee-engine/index.js -> src/settlement-service.js -> src/sox-reconciler.js`).
 *   2. Plans conflict-free parallel execution waves (`planAgentFanOut`) for multiple engineers or
 *      subagents, catching 2-hop blast-radius cone collisions even when `targetFiles` look disjoint,
 *      while reserving orchestrator choke points (`server.js`, `index.js`, `package.json`, `App.jsx`).
 *   3. Verifies candidate code changes / brick upgrades (`verifyTwoHopBlastRadius`) against:
 *      - Subagent lease boundaries (`LEASE_BOUNDARY_VIOLATION`)
 *      - Protected 2-hop verifier / policy-floor files (`WORKAROUND_REJECTED`)
 *      - Static AST exported symbol compatibility across 1-hop callers (`BROKEN_AST_EXPORT`)
 *      - Hermetic Node 22 `--permission` 2-hop downstream reconciliation scripts (`TWO_HOP_INVARIANT_BROKEN`).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { okEnvelope, errorEnvelope } from '../http.js';
import {
    DEFAULT_CHOKE_POINT_FILES,
    normalizeRelativeCodePath,
    planDisjointTaskWaves,
    runNodePermissionSandbox
} from '../parallel-planner.js';
import {
    isTreeSitterReady,
    analyzeFileWithTreeSitter
} from '../treesitter.js';

const SCANNABLE_CODE_EXTENSIONS = new Set([
    '.js',
    '.mjs',
    '.cjs',
    '.jsx',
    '.ts',
    '.tsx',
    '.py'
]);

const RESOLVE_CANDIDATE_SUFFIXES = [
    '',
    '.js',
    '.mjs',
    '.cjs',
    '.ts',
    '.tsx',
    '.jsx',
    '/index.js',
    '/index.mjs',
    '/index.ts',
    '/index.tsx'
];

const SKIP_SCAN_DIRECTORIES = new Set([
    '.git',
    'node_modules',
    'vendor',
    'dist',
    'build',
    'out',
    '.next',
    'coverage',
    '.venv',
    'venv',
    '__pycache__',
    '.cache'
]);

const SENSITIVE_SYSTEM_PREFIXES = [
    '/etc',
    '/private/etc',
    '/root',
    '/proc',
    '/sys',
    '/dev',
    '/boot',
    '/var/run'
];

function isSensitiveHostDirectory(absPath) {
    const normalized = path.resolve(absPath).replace(/\\/g, '/');
    return SENSITIVE_SYSTEM_PREFIXES.some(
        (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`)
    );
}

/**
 * Strip JS/TS comments while preserving string and template literals so commented-out
 * `import` or `export` tokens never create phantom AST edges.
 *
 * @param {string} source
 * @returns {string}
 */
function stripCommentsPreservingStrings(source) {
    let out = '';
    let i = 0;
    const len = source.length;
    while (i < len) {
        const ch = source[i];
        const next = source[i + 1];
        if (ch === "'" || ch === '"' || ch === '`') {
            const quote = ch;
            out += ch;
            i += 1;
            while (i < len) {
                const c = source[i];
                out += c;
                if (c === '\\' && i + 1 < len) {
                    out += source[i + 1];
                    i += 2;
                    continue;
                }
                i += 1;
                if (c === quote) break;
            }
            continue;
        }
        if (ch === '/' && next === '/') {
            while (i < len && source[i] !== '\n') {
                i += 1;
            }
            continue;
        }
        if (ch === '/' && next === '*') {
            i += 2;
            while (i < len && !(source[i] === '*' && source[i + 1] === '/')) {
                if (source[i] === '\n') out += '\n';
                i += 1;
            }
            i += 2;
            continue;
        }
        out += ch;
        i += 1;
    }
    return out;
}

/**
 * Extract exported symbol names and relative import specifiers (+ imported named bindings)
 * from a JS/TS/Python file, enriching via portable WASM Tree-sitter when initialized.
 *
 * @param {string} source
 * @param {string} relPath
 * @returns {{ exports: string[], hasDefaultExport: boolean, imports: Array<{ specifier: string, importedNames: string[] }> }}
 */
function parseFileSymbolsAndImports(source, relPath) {
    const ext = path.posix.extname(relPath).toLowerCase();
    const exportsSet = new Set();
    let hasDefaultExport = false;
    /** @type {Array<{ specifier: string, importedNames: string[] }>} */
    const imports = [];

    if (ext === '.py') {
        const lines = source.split('\n');
        for (const rawLine of lines) {
            const line = rawLine.replace(/#.*$/, '').trim();
            if (!line) continue;
            const defMatch = /^(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(line);
            if (defMatch && !defMatch[1].startsWith('_')) exportsSet.add(defMatch[1]);
            const clsMatch = /^class\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line);
            if (clsMatch && !clsMatch[1].startsWith('_')) exportsSet.add(clsMatch[1]);
            const fromMatch = /^from\s+(\.+[A-Za-z0-9_.]*)\s+import\s+(.+)$/.exec(line);
            if (fromMatch) {
                const names = fromMatch[2]
                    .split(',')
                    .map((t) => t.trim().split(/\s+as\s+/)[0].trim())
                    .filter((t) => t && t !== '*');
                imports.push({ specifier: fromMatch[1], importedNames: names });
            }
        }
        return { exports: [...exportsSet].sort(), hasDefaultExport: false, imports };
    }

    const cleaned = stripCommentsPreservingStrings(source);

    // Optional Tree-sitter CST symbol enrichment when runtime is warm
    if (isTreeSitterReady()) {
        const tsRes = analyzeFileWithTreeSitter(source, relPath);
        if (tsRes.ok && Array.isArray(tsRes.data?.symbols)) {
            for (const sym of tsRes.data.symbols) {
                if (sym?.exported && typeof sym.name === 'string' && sym.name.trim()) {
                    exportsSet.add(sym.name.trim());
                }
            }
        }
    }

    // Exported functions, classes, variables, and types
    for (const m of cleaned.matchAll(
        /\bexport\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g
    )) {
        exportsSet.add(m[1]);
    }

    if (/\bexport\s+default\b/.test(cleaned) || /\bmodule\.exports\s*=/.test(cleaned)) {
        hasDefaultExport = true;
        exportsSet.add('default');
    }

    // Named export lists: `export { a, b as c }` or `export { a } from './x.js'`
    for (const m of cleaned.matchAll(
        /\bexport\s*\{([^}]+)\}(?:\s*from\s*['"]([^'"]+)['"])?/g
    )) {
        const rawList = m[1];
        const reExportSpec = m[2] || '';
        const importedFromReExport = [];
        for (const part of rawList.split(',')) {
            const trimmed = part.replace(/^\s*type\s+/, '').trim();
            if (!trimmed) continue;
            const segments = trimmed.split(/\s+as\s+/);
            const localName = segments[0].trim();
            const exportedAs = (segments[1] || segments[0]).trim();
            if (exportedAs === 'default') hasDefaultExport = true;
            if (exportedAs) exportsSet.add(exportedAs);
            if (reExportSpec && localName) importedFromReExport.push(localName);
        }
        if (reExportSpec) {
            imports.push({ specifier: reExportSpec, importedNames: importedFromReExport });
        }
    }

    // `export * from './x.js'`
    for (const m of cleaned.matchAll(/\bexport\s*\*\s*(?:as\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+)?from\s*['"]([^'"]+)['"]/g)) {
        if (m[1]) exportsSet.add(m[1]);
        imports.push({ specifier: m[2], importedNames: [] });
    }

    // CommonJS `exports.foo = ...` / `module.exports.foo = ...`
    for (const m of cleaned.matchAll(/\b(?:module\.)?exports\.([A-Za-z_$][A-Za-z0-9_$]*)\s*=/g)) {
        exportsSet.add(m[1]);
    }

    // ESM static imports: `import def, { a, b as c } from './mod.js'`
    for (const m of cleaned.matchAll(
        /\bimport\s+(?!type\b)([\s\S]*?)\s+from\s*['"]([^'"]+)['"]/g
    )) {
        const clause = m[1].trim();
        const specifier = m[2].trim();
        const names = [];
        const braceMatch = /\{([^}]+)\}/.exec(clause);
        if (braceMatch) {
            for (const item of braceMatch[1].split(',')) {
                const token = item.trim();
                if (!token || /^type\s+/.test(token)) continue;
                const origName = token.split(/\s+as\s+/)[0].trim();
                if (origName) names.push(origName);
            }
        }
        const beforeBrace = clause.replace(/\{[^}]*\}/, '').replace(/,/g, '').trim();
        if (beforeBrace && !beforeBrace.startsWith('*')) {
            names.push('default');
        }
        imports.push({ specifier, importedNames: names });
    }

    // Side-effect `import './mod.js'`, dynamic `import('./mod.js')`, and CJS `require('./mod.js')`
    for (const m of cleaned.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) {
        imports.push({ specifier: m[1].trim(), importedNames: [] });
    }
    for (const m of cleaned.matchAll(/\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        imports.push({ specifier: m[1].trim(), importedNames: [] });
    }

    return {
        exports: [...exportsSet].sort(),
        hasDefaultExport,
        imports
    };
}

/**
 * Resolve a relative import specifier from `importerRelPath` against `repoFileSet`.
 *
 * @param {string} importerRelPath
 * @param {string} specifier
 * @param {ReadonlySet<string>} repoFileSet
 * @returns {string | null}
 */
function resolveRelativeImportTarget(importerRelPath, specifier, repoFileSet) {
    if (!specifier) return null;

    // Python relative dot imports (`from .settlement import ...`)
    if (importerRelPath.endsWith('.py') && specifier.startsWith('.')) {
        const dotsMatch = /^(\.+)(.*)$/.exec(specifier);
        if (!dotsMatch) return null;
        const dotCount = dotsMatch[1].length;
        const modRest = dotsMatch[2].replace(/\./g, '/');
        let baseDir = path.posix.dirname(importerRelPath);
        for (let d = 1; d < dotCount; d += 1) {
            baseDir = path.posix.dirname(baseDir);
        }
        const candidateBase = normalizeRelativeCodePath(path.posix.join(baseDir, modRest));
        for (const cand of [`${candidateBase}.py`, `${candidateBase}/__init__.py`]) {
            if (repoFileSet.has(cand)) return cand;
        }
        return null;
    }

    if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
        return null;
    }

    const importerDir = path.posix.dirname(importerRelPath);
    const rawJoined = normalizeRelativeCodePath(path.posix.join(importerDir, specifier));
    if (!rawJoined) return null;

    if (repoFileSet.has(rawJoined)) {
        return rawJoined;
    }

    // TypeScript ESM convention: `import './foo.js'` resolving to `foo.ts` / `foo.tsx`
    if (rawJoined.endsWith('.js')) {
        const stem = rawJoined.slice(0, -3);
        for (const tsExt of ['.ts', '.tsx', '.mjs', '.jsx']) {
            if (repoFileSet.has(`${stem}${tsExt}`)) {
                return `${stem}${tsExt}`;
            }
        }
    }

    for (const suffix of RESOLVE_CANDIDATE_SUFFIXES) {
        const candidate = `${rawJoined}${suffix}`;
        if (repoFileSet.has(candidate)) {
            return candidate;
        }
    }

    return null;
}

/**
 * Walk `realRepoDir` safely (enforcing symlink containment) and extract the repository
 * AST symbol and directed dependency graph (`from: importer -> to: imported`).
 *
 * @param {string} realRepoDir
 * @param {{ overlayEdits?: Record<string, string>, maxFiles?: number }} [options={}]
 */
export function extractRepoAstGraph(realRepoDir, options = {}) {
    const overlayEdits = options.overlayEdits && typeof options.overlayEdits === 'object' ? options.overlayEdits : {};
    const maxFiles = Number.isInteger(options.maxFiles) && options.maxFiles > 0 ? options.maxFiles : 500;

    /** @type {Map<string, string>} */
    const fileContents = new Map();

    const walk = (currentDir) => {
        if (fileContents.size >= maxFiles) return;
        const entries = fs
            .readdirSync(currentDir, { withFileTypes: true })
            .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

        for (const entry of entries) {
            if (fileContents.size >= maxFiles) break;
            if (SKIP_SCAN_DIRECTORIES.has(entry.name)) continue;

            const candidateAbs = path.join(currentDir, entry.name);
            let realCandidate;
            try {
                realCandidate = fs.realpathSync(candidateAbs);
            } catch {
                continue;
            }
            if (realCandidate !== realRepoDir && !realCandidate.startsWith(`${realRepoDir}${path.sep}`)) {
                continue;
            }

            let st;
            try {
                st = fs.statSync(realCandidate);
            } catch {
                continue;
            }

            if (st.isDirectory()) {
                walk(realCandidate);
            } else if (st.isFile() && st.size <= 524_288) {
                const ext = path.extname(entry.name).toLowerCase();
                if (!SCANNABLE_CODE_EXTENSIONS.has(ext)) continue;
                const relPath = normalizeRelativeCodePath(path.relative(realRepoDir, realCandidate));
                if (!relPath) continue;
                fileContents.set(relPath, fs.readFileSync(realCandidate, 'utf8'));
            }
        }
    };

    walk(realRepoDir);

    // Apply in-memory candidate edits overlay (supports new files as well as modified files)
    for (const [rawEditPath, newContent] of Object.entries(overlayEdits)) {
        const norm = normalizeRelativeCodePath(rawEditPath);
        if (norm && typeof newContent === 'string') {
            fileContents.set(norm, newContent);
        }
    }

    const repoFileSet = new Set(fileContents.keys());
    /** @type {Record<string, { exports: string[], hasDefaultExport: boolean }>} */
    const symbolsByFile = {};
    /** @type {Array<{ from: string, to: string, importedNames: string[] }>} */
    const edges = [];
    const seenEdgeKey = new Set();

    for (const [relPath, content] of fileContents.entries()) {
        const parsed = parseFileSymbolsAndImports(content, relPath);
        symbolsByFile[relPath] = {
            exports: parsed.exports,
            hasDefaultExport: parsed.hasDefaultExport
        };

        for (const imp of parsed.imports) {
            const target = resolveRelativeImportTarget(relPath, imp.specifier, repoFileSet);
            if (!target || target === relPath) continue;
            const key = `${relPath}=>${target}`;
            if (seenEdgeKey.has(key)) {
                const existing = edges.find((e) => e.from === relPath && e.to === target);
                if (existing) {
                    existing.importedNames = [...new Set([...existing.importedNames, ...imp.importedNames])].sort();
                }
                continue;
            }
            seenEdgeKey.add(key);
            edges.push({
                from: relPath,
                to: target,
                importedNames: [...new Set(imp.importedNames)].sort()
            });
        }
    }

    edges.sort((a, b) => (a.from !== b.from ? a.from.localeCompare(b.from) : a.to.localeCompare(b.to)));

    return {
        files: [...repoFileSet].sort(),
        symbolsByFile,
        edges
    };
}

/**
 * Reconstruct exact 1-hop and 2-hop inbound caller chains (`hop0 -> hop1 -> hop2`)
 * for a set of `changedFiles` over directed import `edges` (`from: caller -> to: target`).
 *
 * @param {string[]} changedFiles
 * @param {Array<{ from: string, to: string }>} edges
 * @param {Set<string>} chokeSet
 */
function buildCausalHopChains(changedFiles, edges, chokeSet) {
    /** @type {Map<string, Set<string>>} imported -> Set<importerCaller> */
    const inbound = new Map();
    for (const edge of edges) {
        if (!inbound.has(edge.to)) inbound.set(edge.to, new Set());
        inbound.get(edge.to).add(edge.from);
    }

    const hop0Set = new Set(changedFiles.map(normalizeRelativeCodePath).filter(Boolean));
    const hop1Set = new Set();
    const hop2Set = new Set();
    const hopPaths = [];

    for (const h0 of hop0Set) {
        const callers1 = [...(inbound.get(h0) || [])].sort();
        for (const h1 of callers1) {
            if (hop0Set.has(h1)) continue;
            hop1Set.add(h1);
            const callers2 = [...(inbound.get(h1) || [])].sort();
            let pushedTwoHop = false;
            if (!chokeSet.has(h1)) {
                for (const h2 of callers2) {
                    if (hop0Set.has(h2) || hop1Set.has(h2)) continue;
                    hop2Set.add(h2);
                    hopPaths.push(`${h0} -> ${h1} -> ${h2}`);
                    pushedTwoHop = true;
                }
            }
            if (!pushedTwoHop) {
                hopPaths.push(`${h0} -> ${h1}`);
            }
        }
    }

    return {
        hop0Files: [...hop0Set].sort(),
        hop1Dependents: [...hop1Set].sort(),
        hop2Dependents: [...hop2Set].sort(),
        hopPaths: [...new Set(hopPaths)]
    };
}

/**
 * Deadbolt 2-Hop AST Blast-Radius Analyzer for code edits and shared brick upgrades.
 * Maps `hop0 -> hop1 -> hop2` dependency chains (e.g. `bricks/fee-engine/index.js ->
 * src/settlement-service.js -> src/sox-reconciler.js`) and computes disjoint multi-agent waves.
 *
 * @param {object} [options={}]
 */
export function analyzeBrickBlastRadius(options = {}) {
    const tool = 'brick-exchange.blast-radius';
    const {
        repoDir,
        changedFiles = [],
        tasks = [],
        chokePoints = DEFAULT_CHOKE_POINT_FILES,
        protectedFiles = [],
        maxBlastHops = 2
    } = options;

    if (!repoDir || typeof repoDir !== 'string') {
        return errorEnvelope('INVALID_REPO_DIR', 'repoDir is required to analyze AST blast radius', null, tool);
    }

    const resolvedDir = path.resolve(repoDir);
    if (isSensitiveHostDirectory(resolvedDir)) {
        return errorEnvelope('PATH_BLOCKED', 'Scanning sensitive host directories is forbidden', null, tool);
    }
    if (!fs.existsSync(resolvedDir)) {
        return errorEnvelope('ENOENT', `Repository directory does not exist: ${resolvedDir}`, null, tool);
    }

    const realRepoDir = fs.realpathSync(resolvedDir);
    if (isSensitiveHostDirectory(realRepoDir) || !fs.statSync(realRepoDir).isDirectory()) {
        return errorEnvelope('INVALID_REPO_DIR', 'Target repoDir must be a valid non-sensitive directory', null, tool);
    }

    const normalizedChanged = (Array.isArray(changedFiles) ? changedFiles : [changedFiles])
        .map(normalizeRelativeCodePath)
        .filter(Boolean);

    const chokeSet = new Set([...chokePoints].map(normalizeRelativeCodePath).filter(Boolean));
    const protectedSet = new Set((Array.isArray(protectedFiles) ? protectedFiles : []).map(normalizeRelativeCodePath).filter(Boolean));

    const graph = extractRepoAstGraph(realRepoDir);
    const chains = buildCausalHopChains(normalizedChanged, graph.edges, chokeSet);

    const effectiveTasks =
        Array.isArray(tasks) && tasks.length > 0
            ? tasks
            : normalizedChanged.length > 0
              ? [{ id: 'CHANGE-1', title: 'Candidate change', targetFiles: normalizedChanged }]
              : [];

    const wavePlan = planDisjointTaskWaves({
        tasks: effectiveTasks,
        edges: graph.edges,
        chokePoints: chokeSet,
        maxBlastHops,
        tool
    });

    const impactedProtectedFiles = [...chains.hop1Dependents, ...chains.hop2Dependents].filter((f) =>
        protectedSet.has(f)
    );
    const directlyMutatedProtectedFiles = normalizedChanged.filter((f) => protectedSet.has(f));

    return okEnvelope(
        tool,
        `Mapped 2-hop AST blast radius across ${graph.files.length} file(s): ${chains.hop1Dependents.length} hop-1, ${chains.hop2Dependents.length} hop-2 dependent(s)`,
        {
            scannedFileCount: graph.files.length,
            edgeCount: graph.edges.length,
            hop0Files: chains.hop0Files,
            hop1Dependents: chains.hop1Dependents,
            hop2Dependents: chains.hop2Dependents,
            hopPaths: chains.hopPaths,
            impactedProtectedFiles,
            directlyMutatedProtectedFiles,
            edges: graph.edges,
            symbolsByFile: graph.symbolsByFile,
            wavePlan: wavePlan.data
        }
    );
}

/**
 * Multi-Agent / Multi-Engineer Disjoint Fan-Out Planner (`AGENTS.md` Rule #4 + Deadbolt Stage 2).
 * Scans the live repository AST graph, computes 2-hop blast-radius cones for every subagent or
 * engineer task, detects hidden 2-hop collisions even when `targetFiles` appear disjoint, reserves
 * orchestrator choke points, and issues strict per-agent file leases partitioned into parallel waves.
 *
 * @param {object} [options={}]
 */
export function planAgentFanOut(options = {}) {
    const tool = 'brick-exchange.fanout-plan';
    const {
        repoDir,
        tasks = [],
        chokePoints = DEFAULT_CHOKE_POINT_FILES,
        protectedFiles = [],
        maxBlastHops = 2
    } = options;

    if (!Array.isArray(tasks) || tasks.length === 0) {
        return errorEnvelope('EMPTY_TASKS', 'At least one subagent or engineer task is required', null, tool);
    }

    const blastRes = analyzeBrickBlastRadius({
        repoDir,
        changedFiles: tasks.flatMap((t) => t?.targetFiles || t?.files || []),
        tasks,
        chokePoints,
        protectedFiles,
        maxBlastHops
    });

    if (!blastRes.ok) {
        return errorEnvelope(blastRes.error.code, blastRes.error.message, blastRes.error.details, tool);
    }

    const protectedSet = new Set(
        (Array.isArray(protectedFiles) ? protectedFiles : []).map(normalizeRelativeCodePath).filter(Boolean)
    );
    const wavePlan = blastRes.data.wavePlan;

    // Flag any task that tries to directly target a protected Policy-Floor verifier
    const policyViolations = [];
    for (const lease of wavePlan.leases) {
        for (const tf of lease.targetFiles) {
            if (protectedSet.has(tf)) {
                policyViolations.push({
                    taskId: lease.taskId,
                    file: tf,
                    reason: 'Target file is protected by the Deadbolt Policy Floor and cannot be mutated by worker agents'
                });
            }
        }
    }

    if (policyViolations.length > 0) {
        return errorEnvelope(
            'WORKAROUND_REJECTED',
            `Fan-out blocked: ${policyViolations.length} task(s) target Policy-Floor protected file(s)`,
            { policyViolations, wavePlan },
            tool
        );
    }

    const agentLeases = wavePlan.leases.map((lease) => {
        const subChains = buildCausalHopChains(
            lease.targetFiles,
            blastRes.data.edges,
            new Set(wavePlan.reservedOrchestratorFiles)
        );
        return {
            ...lease,
            hopPaths: subChains.hopPaths,
            forbiddenFiles: [...new Set([...wavePlan.reservedOrchestratorFiles, ...protectedSet])]
                .filter((f) => !lease.targetFiles.includes(f))
                .sort()
        };
    });

    return okEnvelope(
        tool,
        `Planned ${agentLeases.length} agent task(s) into ${wavePlan.waveCount} conflict-free wave(s) (${wavePlan.collisions.length} 2-hop cone collision(s) sequenced)`,
        {
            taskCount: wavePlan.taskCount,
            waveCount: wavePlan.waveCount,
            fullyParallelSingleWave: wavePlan.fullyParallelSingleWave,
            waves: wavePlan.waves,
            agentLeases,
            collisions: wavePlan.collisions,
            reservedOrchestratorFiles: wavePlan.reservedOrchestratorFiles,
            protectedFiles: [...protectedSet].sort()
        }
    );
}

/**
 * Deadbolt Stage 4 Two-Hop Blast-Radius & Policy-Floor Verifier.
 * Stages candidate edits in an ephemeral isolated directory and enforces in strict order:
 *   1. Subagent Lease Boundary (`LEASE_BOUNDARY_VIOLATION`)
 *   2. Import-Frozen Policy Floor (`WORKAROUND_REJECTED` if any protected 2-hop verifier is edited)
 *   3. Static 1-Hop / 2-Hop AST Symbol Contract Check (`BROKEN_AST_EXPORT` if an edited module removes
 *      an exported symbol still imported by downstream callers)
 *   4. Out-of-process Node 22 `--permission` 2-hop reconciliation (`TWO_HOP_INVARIANT_BROKEN`),
 *      surfacing the exact `hop0 -> hop1 -> hop2` causal graph path when a downstream check trips.
 *
 * @param {object} [options={}]
 */
export async function verifyTwoHopBlastRadius(options = {}) {
    const tool = 'brick-exchange.verify-blast-radius';
    const {
        repoDir,
        candidateEdits = {},
        lease = null,
        protectedFiles = [],
        chokePoints = DEFAULT_CHOKE_POINT_FILES,
        invariantScript = '',
        invariantEntryFile = '',
        timeoutMs = 5000
    } = options;

    if (!repoDir || typeof repoDir !== 'string' || !fs.existsSync(path.resolve(repoDir))) {
        return errorEnvelope('INVALID_REPO_DIR', 'Existing repoDir is required', null, tool);
    }
    if (!candidateEdits || typeof candidateEdits !== 'object' || Object.keys(candidateEdits).length === 0) {
        return errorEnvelope('EMPTY_EDITS', 'candidateEdits must contain at least one modified file', null, tool);
    }

    const realRepoDir = fs.realpathSync(path.resolve(repoDir));
    if (isSensitiveHostDirectory(realRepoDir)) {
        return errorEnvelope('PATH_BLOCKED', 'Sensitive host directory blocked', null, tool);
    }

    const normalizedEdits = {};
    for (const [rawPath, content] of Object.entries(candidateEdits)) {
        const norm = normalizeRelativeCodePath(rawPath);
        if (!norm || typeof content !== 'string') {
            return errorEnvelope('INVALID_EDIT_PATH', `Invalid candidate edit path: ${String(rawPath)}`, null, tool);
        }
        normalizedEdits[norm] = content;
    }

    const editedPaths = Object.keys(normalizedEdits).sort();
    const protectedSet = new Set(
        (Array.isArray(protectedFiles) ? protectedFiles : []).map(normalizeRelativeCodePath).filter(Boolean)
    );
    const chokeSet = new Set([...chokePoints].map(normalizeRelativeCodePath).filter(Boolean));

    // Gate A: Subagent Lease Boundary Check (for parallel subagent fan-outs)
    if (lease && typeof lease === 'object') {
        const allowedTargets = new Set(
            (Array.isArray(lease.targetFiles) ? lease.targetFiles : []).map(normalizeRelativeCodePath).filter(Boolean)
        );
        const unleasedEdits = editedPaths.filter((p) => !allowedTargets.has(p));
        if (unleasedEdits.length > 0) {
            return errorEnvelope(
                'LEASE_BOUNDARY_VIOLATION',
                `Subagent "${lease.taskId || 'worker'}" modified file(s) outside its assigned lease: ${unleasedEdits.join(', ')}`,
                {
                    taskId: lease.taskId || null,
                    allowedTargets: [...allowedTargets],
                    unleasedEdits
                },
                tool
            );
        }
    }

    // Gate B: Deadbolt Policy Floor (blocks mutating protected 2-hop reconcilers / verifiers)
    const touchedProtected = editedPaths.filter((p) => protectedSet.has(p));
    if (touchedProtected.length > 0) {
        return errorEnvelope(
            'WORKAROUND_REJECTED',
            `Policy floor violation: candidate edit attempted to modify protected verification file(s): ${touchedProtected.join(', ')}`,
            {
                touchedProtected,
                protectedFiles: [...protectedSet]
            },
            tool
        );
    }

    // Gate C: Static 2-Hop AST Graph & Export Contract Compatibility
    const beforeGraph = extractRepoAstGraph(realRepoDir);
    const afterGraph = extractRepoAstGraph(realRepoDir, { overlayEdits: normalizedEdits });
    const chains = buildCausalHopChains(editedPaths, beforeGraph.edges, chokeSet);

    const brokenExports = [];
    for (const edge of afterGraph.edges) {
        if (!editedPaths.includes(edge.to)) continue;
        const targetSymbols = new Set(afterGraph.symbolsByFile[edge.to]?.exports || []);
        for (const importedSym of edge.importedNames) {
            if (!targetSymbols.has(importedSym)) {
                brokenExports.push({
                    changedFile: edge.to,
                    callerFile: edge.from,
                    missingSymbol: importedSym,
                    hopPath: chains.hopPaths.find((p) => p.startsWith(`${edge.to} -> ${edge.from}`)) || `${edge.to} -> ${edge.from}`
                });
            }
        }
    }

    if (brokenExports.length > 0) {
        return errorEnvelope(
            'BROKEN_AST_EXPORT',
            `Candidate edit removed ${brokenExports.length} exported symbol(s) required by downstream AST caller(s)`,
            {
                brokenExports,
                hop1Dependents: chains.hop1Dependents,
                hop2Dependents: chains.hop2Dependents,
                hopPaths: chains.hopPaths
            },
            tool
        );
    }

    // Gate D: Out-of-Process Node 22 `--permission` 2-Hop Downstream Invariant Execution
    if (!invariantScript && !invariantEntryFile) {
        return okEnvelope(
            tool,
            `Verified static 2-hop AST blast radius (${chains.hop1Dependents.length} hop-1, ${chains.hop2Dependents.length} hop-2; 0 broken exports)`,
            {
                editedPaths,
                hop1Dependents: chains.hop1Dependents,
                hop2Dependents: chains.hop2Dependents,
                hopPaths: chains.hopPaths,
                dynamicCheckExecuted: false
            }
        );
    }

    const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krusch-blast-stage-'));
    try {
        // Materialize clean repository files + candidate edits into isolated staging dir
        for (const relFile of beforeGraph.files) {
            const srcAbs = path.join(realRepoDir, relFile);
            const destAbs = path.join(stageDir, relFile);
            fs.mkdirSync(path.dirname(destAbs), { recursive: true });
            fs.copyFileSync(srcAbs, destAbs);
        }
        const pkgJsonAbs = path.join(realRepoDir, 'package.json');
        if (fs.existsSync(pkgJsonAbs)) {
            fs.copyFileSync(pkgJsonAbs, path.join(stageDir, 'package.json'));
        }
        for (const [relEdit, content] of Object.entries(normalizedEdits)) {
            const destAbs = path.join(stageDir, relEdit);
            fs.mkdirSync(path.dirname(destAbs), { recursive: true });
            fs.writeFileSync(destAbs, content, 'utf8');
        }

        const sandboxRes = await runNodePermissionSandbox({
            workspaceDir: stageDir,
            ...(invariantScript ? { script: invariantScript } : { entryFile: invariantEntryFile }),
            timeoutMs,
            tool: 'brick-exchange.blast-sandbox'
        });

        const markerResult = sandboxRes.data?.result;
        const invariantFailed =
            !sandboxRes.ok ||
            (markerResult && typeof markerResult === 'object' && markerResult.passed === false);

        if (invariantFailed) {
            return errorEnvelope(
                'TWO_HOP_INVARIANT_BROKEN',
                `Downstream 2-hop verification failed across [${chains.hopPaths.join('; ') || editedPaths.join(', ')}]`,
                {
                    editedPaths,
                    hop1Dependents: chains.hop1Dependents,
                    hop2Dependents: chains.hop2Dependents,
                    hopPaths: chains.hopPaths,
                    sandboxOutcome: markerResult ?? sandboxRes.error ?? sandboxRes.data
                },
                tool
            );
        }

        return okEnvelope(
            tool,
            `Passed 2-hop AST blast-radius & downstream invariant verification (${chains.hopPaths.join('; ') || editedPaths.join(', ')})`,
            {
                editedPaths,
                hop1Dependents: chains.hop1Dependents,
                hop2Dependents: chains.hop2Dependents,
                hopPaths: chains.hopPaths,
                dynamicCheckExecuted: true,
                invariantResult: markerResult ?? { exitCode: 0 }
            }
        );
    } finally {
        fs.rmSync(stageDir, { recursive: true, force: true });
    }
}
