#!/usr/bin/env node
/**
 * @module krusch-lego
 * Zero-LLM CLI for discovering `@krusch/toolkit` & `krusch_toolkit` Lego bricks,
 * stamping frozen project archetypes, and auditing hand-rolled boilerplate.
 *
 * Commands:
 *   krusch-lego list [--runtime <node|python|react|edge>] [--json]
 *   krusch-lego inspect <brickOrArchetypeId> [--json]
 *   krusch-lego stamp <archetype> [targetDir] [--name <projectName>] [--port <port>] [--force] [--dry-run] [--json]
 *   krusch-lego audit <fileOrDir> [--json]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    listLegoBricks,
    getLegoBrick,
    listArchetypes,
    getArchetype,
    auditBoilerplateText,
    scoreLegoBrickCoverage
} from '../catalog.js';
import { attachGracefulShutdown } from '../http.js';
import { scaffoldProject } from '../scaffold.js';
import { scoutHomelabLegoCandidates } from '../lego-scout.js';
import {
    generateBrickSigningKeyPair,
    sealBrick,
    verifyBrickBundle,
    createBrickExchangeStore,
    tryBrickLocally,
    adoptBrickIntoRepo,
    auditRepoBrickLocks,
    createBrickExchangeServer,
    createBrickExchangeMcpServer,
    analyzeBrickBlastRadius,
    planAgentFanOut,
    ONTOLOGY_STACKS,
    ONTOLOGY_DATA_PORTS,
    ONTOLOGY_CHANNELS,
    ONTOLOGY_MOE_PROFILES,
    CROSS_STACK_BRICK_EQUIVALENTS,
    resolveCrossStackCatalogEquivalents,
    checkOntologyCompatibility,
    synthesizeBrickBinding
} from '../brick-exchange.js';

const TOOL_NAME = 'krusch-lego';
const VALID_RUNTIMES = new Set(['node', 'python', 'react', 'edge']);
const SCAN_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.ts', '.tsx', '.py']);
const SKIP_DIRECTORIES = new Set([
    'node_modules',
    '.git',
    '.venv',
    'venv',
    'env',
    'site-packages',
    '__pycache__',
    'dist',
    'build',
    '.next',
    'coverage',
    'out',
    'tests',
    'test',
    '__tests__',
    'benchmarks',
    'benchmark',
    'vendor',
    'third_party',
    'archive',
    '_archive',
    'archive_scratch',
    'scratch'
]);
const EXEMPT_TEST_FILE_RE = /(?:\.(?:test|spec)\.[cm]?[jt]sx?$|^test[_-])/i;

function resolveRealPath(targetPath) {
    try {
        return fs.realpathSync(targetPath);
    } catch {
        return path.resolve(targetPath);
    }
}

const TOOLKIT_JS_ROOT = resolveRealPath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const TOOLKIT_PY_STANDALONE_ROOT = resolveRealPath(path.resolve(TOOLKIT_JS_ROOT, 'python'));
const TOOLKIT_PY_ROOT = resolveRealPath(path.resolve(TOOLKIT_JS_ROOT, '..', 'lib-py'));
const KRUSCH_STACK_ROOT = resolveRealPath(path.resolve(TOOLKIT_JS_ROOT, '..', 'projects', 'krusch-stack'));
const DEFAULT_PROJECTS_ROOT = path.resolve(TOOLKIT_JS_ROOT, '..', 'projects');
const EXEMPT_AUDIT_ROOTS = [TOOLKIT_JS_ROOT, TOOLKIT_PY_STANDALONE_ROOT, TOOLKIT_PY_ROOT, KRUSCH_STACK_ROOT];

function isPathInsideRoot(candidateAbs, rootAbs) {
    return candidateAbs === rootAbs || candidateAbs.startsWith(`${rootAbs}${path.sep}`);
}

function isExemptAuditPath(targetPath, { isDirectory = false } = {}) {
    const resolved = resolveRealPath(targetPath);
    if (EXEMPT_AUDIT_ROOTS.some((root) => isPathInsideRoot(resolved, root))) {
        return true;
    }
    const segments = resolved.split(path.sep).filter(Boolean);
    if (segments.some((seg) => SKIP_DIRECTORIES.has(seg))) {
        return true;
    }
    let cursorDir = isDirectory ? resolved : path.dirname(resolved);
    for (let depth = 0; depth < 8; depth++) {
        if (fs.existsSync(path.join(cursorDir, 'pyvenv.cfg'))) {
            return true;
        }
        const parent = path.dirname(cursorDir);
        if (parent === cursorDir) break;
        cursorDir = parent;
    }
    if (!isDirectory && EXEMPT_TEST_FILE_RE.test(path.basename(resolved))) {
        return true;
    }
    return false;
}

function okOut(summary, data = {}) {
    return {
        ok: true,
        tool: TOOL_NAME,
        summary,
        data
    };
}

function errOut(code, message, details = null) {
    return {
        ok: false,
        tool: TOOL_NAME,
        summary: message,
        error: {
            code,
            message,
            ...(details !== null ? { details } : {})
        }
    };
}

function parseCliArgs(argv = []) {
    const positionals = [];
    const flags = {
        json: false,
        force: false,
        dryRun: false,
        help: false,
        portable: false,
        runtime: '',
        name: '',
        port: undefined,
        minProjects: undefined,
        out: '',
        key: '',
        pubKey: '',
        input: '',
        binding: '',
        grant: '',
        by: '',
        db: '',
        actor: '',
        issuer: '',
        to: '',
        hash: '',
        expiresDays: undefined,
        viewer: '',
        query: '',
        repo: '',
        repoRoot: '',
        stack: '',
        channel: '',
        ports: '',
        asOf: '',
        sample: '',
        authTokens: [],
        corsOrigins: []
    };

    const stringFlagMap = {
        '--out': 'out',
        '--key': 'key',
        '--pub-key': 'pubKey',
        '--input': 'input',
        '--binding': 'binding',
        '--grant': 'grant',
        '--by': 'by',
        '--db': 'db',
        '--actor': 'actor',
        '--issuer': 'issuer',
        '--to': 'to',
        '--hash': 'hash',
        '--viewer': 'viewer',
        '--query': 'query',
        '--repo': 'repo',
        '--repo-root': 'repoRoot',
        '--stack': 'stack',
        '--channel': 'channel',
        '--ports': 'ports',
        '--as-of': 'asOf',
        '--sample': 'sample'
    };

    for (let i = 0; i < argv.length; i++) {
        const token = String(argv[i] ?? '');
        if (!token.startsWith('-')) {
            positionals.push(token);
            continue;
        }

        if (token === '--json') {
            flags.json = true;
        } else if (token === '--force' || token === '-f') {
            flags.force = true;
        } else if (token === '--dry-run') {
            flags.dryRun = true;
        } else if (token === '--portable') {
            flags.portable = true;
        } else if (token === '--help' || token === '-h') {
            flags.help = true;
        } else if (token === '--runtime') {
            flags.runtime = String(argv[++i] ?? '').trim();
        } else if (token.startsWith('--runtime=')) {
            flags.runtime = token.slice('--runtime='.length).trim();
        } else if (token === '--name') {
            flags.name = String(argv[++i] ?? '').trim();
        } else if (token.startsWith('--name=')) {
            flags.name = token.slice('--name='.length).trim();
        } else if (token === '--port') {
            flags.port = Number(argv[++i]);
        } else if (token.startsWith('--port=')) {
            flags.port = Number(token.slice('--port='.length));
        } else if (token === '--min-projects') {
            flags.minProjects = Number(argv[++i]);
        } else if (token.startsWith('--min-projects=')) {
            flags.minProjects = Number(token.slice('--min-projects='.length));
        } else if (token === '--expires-days') {
            flags.expiresDays = Number(argv[++i]);
        } else if (token.startsWith('--expires-days=')) {
            flags.expiresDays = Number(token.slice('--expires-days='.length));
        } else if (token === '--auth-token') {
            const tok = String(argv[++i] ?? '').trim();
            if (tok) flags.authTokens.push(tok);
        } else if (token.startsWith('--auth-token=')) {
            const tok = token.slice('--auth-token='.length).trim();
            if (tok) flags.authTokens.push(tok);
        } else if (token === '--cors-origin') {
            const orig = String(argv[++i] ?? '').trim();
            if (orig) flags.corsOrigins.push(orig);
        } else if (token.startsWith('--cors-origin=')) {
            const orig = token.slice('--cors-origin='.length).trim();
            if (orig) flags.corsOrigins.push(orig);
        } else if (Object.hasOwn(stringFlagMap, token)) {
            flags[stringFlagMap[token]] = String(argv[++i] ?? '').trim();
        } else {
            const eqIdx = token.indexOf('=');
            if (eqIdx > 0) {
                const prefix = token.slice(0, eqIdx);
                if (Object.hasOwn(stringFlagMap, prefix)) {
                    flags[stringFlagMap[prefix]] = token.slice(eqIdx + 1).trim();
                }
            }
        }
    }

    return { positionals, flags };
}

function collectAuditFiles(targetPath) {
    const stat = fs.statSync(targetPath);
    if (stat.isFile()) {
        if (isExemptAuditPath(targetPath, { isDirectory: false })) {
            return [];
        }
        return [targetPath];
    }
    if (!stat.isDirectory()) {
        return [];
    }
    if (isExemptAuditPath(targetPath, { isDirectory: true })) {
        return [];
    }

    const discovered = [];
    const walk = (dirPath) => {
        const entries = fs
            .readdirSync(dirPath, { withFileTypes: true })
            .sort((a, b) => a.name.localeCompare(b.name));
        if (entries.some((d) => d.name === 'pyvenv.cfg')) {
            return;
        }

        for (const entry of entries) {
            if (entry.isDirectory()) {
                const childAbs = path.resolve(dirPath, entry.name);
                if (SKIP_DIRECTORIES.has(entry.name) || isExemptAuditPath(childAbs, { isDirectory: true })) {
                    continue;
                }
                walk(childAbs);
                continue;
            }
            if (entry.isFile()) {
                const ext = path.extname(entry.name).toLowerCase();
                const fileAbs = path.join(dirPath, entry.name);
                if (SCAN_EXTENSIONS.has(ext) && !isExemptAuditPath(fileAbs, { isDirectory: false })) {
                    discovered.push(fileAbs);
                }
            }
        }
    };

    walk(targetPath);
    return discovered;
}

function serializeArchetype(arch) {
    const files = Object.keys(arch.renderFiles({ projectName: 'sample-app', port: 3000 }));
    return {
        id: arch.id,
        title: arch.title,
        runtime: arch.runtime,
        description: arch.description,
        bricks: [...arch.bricks],
        files
    };
}

function emitResponse(payload, jsonMode, humanLines = [], writeOut = console.log, writeErr = console.error) {
    if (jsonMode) {
        writeOut(JSON.stringify(payload, null, 2));
        return payload;
    }

    if (!payload.ok) {
        writeErr(`Error [${payload.error.code}]: ${payload.error.message}`);
        return payload;
    }

    for (const line of humanLines) {
        writeOut(line);
    }
    return payload;
}

/**
 * Execute the `krusch-lego` CLI against `argv`.
 *
 * @param {string[]} [argv=process.argv.slice(2)]
 * @param {{ stdout?: Function, stderr?: Function }} [io={}]
 * @returns {Promise<{ exitCode: number, payload: object }>}
 */
export async function runCli(argv = process.argv.slice(2), io = {}) {
    const writeOut = io.stdout || ((line) => console.log(line));
    const writeErr = io.stderr || ((line) => console.error(line));
    const { positionals, flags } = parseCliArgs(argv);
    const command = positionals[0] || (flags.help ? 'help' : '');

    if (!command || command === 'help' || flags.help) {
        const helpLines = [
            'krusch-lego - Sovereign Toolkit Brick & Archetype CLI',
            '',
            'Usage:',
            '  krusch-lego list [--runtime <node|python|react|edge>] [--json]',
            '  krusch-lego inspect <brickOrArchetypeId> [--json]',
            '  krusch-lego stamp <archetype> [targetDir] [--name <projectName>] [--port <port>] [--force] [--dry-run] [--json]',
            '  krusch-lego audit <fileOrDir> [--json]',
            '  krusch-lego scout [projectsDir] [--min-projects <n>] [--portable] [--json]',
            '  krusch-lego keygen [--out <dir>] [--json]',
            '  krusch-lego seal <specJsonPath> [--out <bundlePath>] [--key <privateKeyPemPath>] [--db <sqlitePath>] [--json]',
            '  krusch-lego verify <bundlePath> [--pub-key <publicKeyPemPath>] [--json]',
            '  krusch-lego try <bundlePath> --input <jsonOrFile> [--binding <jsonFile>] [--json]',
            '  krusch-lego adopt <bundlePath> [targetRepoDir] [--binding <file>] [--stack <stackSlug>] [--sample <jsonFile>] [--grant <grantId>] [--by <memberId>] [--db <sqlitePath>] [--json]',
            '  krusch-lego suggest <brickId> --db <sqlitePath> --actor <memberId> [--repo-root <dir>] [--json]',
            '  krusch-lego share <brickId> --db <sqlitePath> --issuer <memberId> --to <csvRecipients> [--hash <sourceHash>] [--expires-days <n>] [--json]',
            '  krusch-lego revoke <grantId> --db <sqlitePath> --actor <memberId> [--json]',
            '  krusch-lego inbox --db <sqlitePath> --viewer <memberId> [--query <q>] [--json]',
            '  krusch-lego hub [--db <sqlitePath>] [--port <port>] [--repo <dir>] [--auth-token <token>] [--cors-origin <origin>] [--json]',
            '  krusch-lego mcp [--db <sqlitePath>]',
            '  krusch-lego blast-radius <changedFileCsv> [repoDir] [--json]',
            '  krusch-lego fanout <tasksJsonPath> [repoDir] [--json]',
            '  krusch-lego ontology <inspect|check|compose|bind> [args] [--stack <stackSlug>] [--channel <channelId>] [--ports <csvPorts>] [--sample <jsonPath>] [--json]'
        ];
        const payload = okOut('Displayed krusch-lego usage', {
            commands: [
                'list',
                'inspect',
                'stamp',
                'audit',
                'scout',
                'keygen',
                'seal',
                'verify',
                'try',
                'adopt',
                'suggest',
                'share',
                'revoke',
                'inbox',
                'hub',
                'mcp',
                'blast-radius',
                'fanout',
                'ontology'
            ],
            runtimes: [...VALID_RUNTIMES]
        });
        emitResponse(payload, flags.json, helpLines, writeOut, writeErr);
        return { exitCode: 0, payload };
    }

    if (command === 'list') {
        if (flags.runtime && !VALID_RUNTIMES.has(flags.runtime.toLowerCase())) {
            const payload = errOut(
                'INVALID_RUNTIME',
                `Invalid --runtime "${flags.runtime}". Valid runtimes: ${[...VALID_RUNTIMES].join(', ')}`
            );
            emitResponse(payload, flags.json, [], writeOut, writeErr);
            return { exitCode: 1, payload };
        }

        const bricks = listLegoBricks({ runtime: flags.runtime });
        const archetypes = listArchetypes({ runtime: flags.runtime }).map(serializeArchetype);
        const summary = `Listed ${bricks.length} Lego brick(s) and ${archetypes.length} project archetype(s)`;
        const payload = okOut(summary, {
            runtime: flags.runtime ? flags.runtime.toLowerCase() : null,
            bricks,
            archetypes
        });

        const lines = [
            `=== Runtime Bricks (${bricks.length}) ===`,
            ...bricks.map(
                (b) => `  - ${b.id.padEnd(15)} [${b.runtime.padEnd(6)}] ${b.importPath} :: ${b.summary}`
            ),
            '',
            `=== Project Archetypes (${archetypes.length}) ===`,
            ...archetypes.map(
                (a) => `  - ${a.id.padEnd(23)} [${a.runtime.padEnd(6)}] ${a.title} (${a.files.length} files)`
            )
        ];
        emitResponse(payload, flags.json, lines, writeOut, writeErr);
        return { exitCode: 0, payload };
    }

    if (command === 'inspect') {
        const targetId = positionals[1] || '';
        if (!targetId) {
            const payload = errOut('MISSING_ID', 'Usage: krusch-lego inspect <brickOrArchetypeId> [--json]');
            emitResponse(payload, flags.json, [], writeOut, writeErr);
            return { exitCode: 1, payload };
        }

        const brick = getLegoBrick(targetId);
        if (brick) {
            const payload = okOut(`Inspected Lego brick "${brick.id}"`, {
                kind: 'brick',
                brick
            });
            const lines = [
                `Brick:        ${brick.id} (${brick.runtime})`,
                `Import Path:  ${brick.importPath}`,
                `Exports:      ${brick.exports.join(', ')}`,
                `Summary:      ${brick.summary}`,
                `Replaces:     ${brick.antiPatternDescription}`,
                '',
                'Snippet:',
                brick.snippet
            ];
            emitResponse(payload, flags.json, lines, writeOut, writeErr);
            return { exitCode: 0, payload };
        }

        const archetype = getArchetype(targetId);
        if (archetype) {
            const serialized = serializeArchetype(archetype);
            const payload = okOut(`Inspected project archetype "${archetype.id}"`, {
                kind: 'archetype',
                archetype: serialized
            });
            const lines = [
                `Archetype:    ${serialized.id} (${serialized.runtime})`,
                `Title:        ${serialized.title}`,
                `Description:  ${serialized.description}`,
                `Bricks:       ${serialized.bricks.join(', ')}`,
                `Files (${serialized.files.length}):`,
                ...serialized.files.map((f) => `  - ${f}`)
            ];
            emitResponse(payload, flags.json, lines, writeOut, writeErr);
            return { exitCode: 0, payload };
        }

        const validBricks = listLegoBricks().map((b) => b.id);
        const validArchetypes = listArchetypes().map((a) => a.id);
        const payload = errOut(
            'NOT_FOUND',
            `Unknown brick or archetype "${targetId}". Bricks: [${validBricks.join(', ')}]; Archetypes: [${validArchetypes.join(', ')}]`,
            { validBricks, validArchetypes }
        );
        emitResponse(payload, flags.json, [], writeOut, writeErr);
        return { exitCode: 1, payload };
    }

    if (command === 'stamp') {
        const archetypeId = positionals[1] || '';
        const targetDir = positionals[2] || process.cwd();
        if (!archetypeId) {
            const payload = errOut(
                'MISSING_ARCHETYPE',
                'Usage: krusch-lego stamp <archetype> [targetDir] [--name <projectName>] [--port <port>] [--force] [--dry-run] [--json]'
            );
            emitResponse(payload, flags.json, [], writeOut, writeErr);
            return { exitCode: 1, payload };
        }

        try {
            const result = await scaffoldProject(targetDir, {
                archetype: archetypeId,
                projectName: flags.name,
                port: flags.port ?? 3000,
                force: flags.force,
                dryRun: flags.dryRun,
                quiet: true
            });
            const payload = okOut(result.summary, result.data);
            const lines = [
                result.summary,
                `Target: ${result.data.targetDir}`,
                ...(result.data.createdFiles.length > 0
                    ? [`Created (${result.data.createdFiles.length}): ${result.data.createdFiles.join(', ')}`]
                    : []),
                ...(result.data.skippedFiles.length > 0
                    ? [`Skipped (${result.data.skippedFiles.length}): ${result.data.skippedFiles.join(', ')}`]
                    : [])
            ];
            emitResponse(payload, flags.json, lines, writeOut, writeErr);
            return { exitCode: 0, payload };
        } catch (err) {
            const payload = errOut('STAMP_ERROR', err.message);
            emitResponse(payload, flags.json, [], writeOut, writeErr);
            return { exitCode: 1, payload };
        }
    }

    if (command === 'audit') {
        const rawTarget = positionals[1] || process.cwd();
        const resolvedTarget = path.resolve(rawTarget);
        if (!fs.existsSync(resolvedTarget)) {
            const payload = errOut('ENOENT', `Audit target does not exist: ${resolvedTarget}`);
            emitResponse(payload, flags.json, [], writeOut, writeErr);
            return { exitCode: 1, payload };
        }

        const files = collectAuditFiles(resolvedTarget);
        const fileEntries = files.map((filePath) => ({
            filePath,
            code: fs.readFileSync(filePath, 'utf-8').slice(0, 1_048_576)
        }));
        const coverage = scoreLegoBrickCoverage(fileEntries);
        const {
            flaggedFiles: flaggedFileCount,
            findings,
            sealedFiles,
            sealedBrickIds,
            sealedTouchpoints,
            recommendedBrickIds,
            sealedCoverageRatio,
            breakerTripped,
            estimatedAuditTokensSaved
        } = coverage.data;

        const lockAudit = fs.statSync(resolvedTarget).isDirectory()
            ? auditRepoBrickLocks(resolvedTarget)
            : { ok: true, data: { lockfilePresent: false, lockedBrickCount: 0, clean: true, findings: [] } };
        const brickLockFindings = Array.isArray(lockAudit.data?.findings)
            ? lockAudit.data.findings.map((lf) => ({
                  filePath: lf.filePath || path.join(resolvedTarget, lf.relativePath || '.brick-lock.json'),
                  ruleId: lf.ruleId || lf.code || 'BRICK_LOCK_DRIFT',
                  brickId: lf.brickId || 'brick-exchange',
                  importPath: '@krusch/toolkit/brick-exchange',
                  severity: 'error',
                  message: lf.message || 'Vendored sealed brick drifted from .brick-lock.json attestation'
              }))
            : [];

        const allFindings = [...findings, ...brickLockFindings];
        const clean = allFindings.length === 0;
        const summary = clean
            ? `Audited ${files.length} file(s): zero hand-rolled boilerplate findings`
            : `Audited ${files.length} file(s): found ${allFindings.length} finding(s) (${findings.length} boilerplate, ${brickLockFindings.length} brick-lock drift)`;

        const payload = okOut(summary, {
            target: resolvedTarget,
            scannedFiles: files.length,
            flaggedFiles: flaggedFileCount + brickLockFindings.length,
            clean,
            sealedFiles,
            sealedBrickIds,
            sealedTouchpoints,
            recommendedBrickIds,
            sealedCoverageRatio,
            breakerTripped: breakerTripped || brickLockFindings.length > 0,
            estimatedAuditTokensSaved,
            brickLockStatus: lockAudit.data,
            findings: allFindings
        });

        const lines = [
            summary,
            ...allFindings.map(
                (f) => `  - [${f.ruleId}] ${f.filePath} -> use ${f.importPath}: ${f.message}`
            )
        ];
        emitResponse(payload, flags.json, lines, writeOut, writeErr);
        return { exitCode: 0, payload };
    }

    if (command === 'scout') {
        const rawProjectsRoot = positionals[1] || DEFAULT_PROJECTS_ROOT;
        const resolvedProjectsRoot = path.resolve(rawProjectsRoot);
        if (flags.minProjects !== undefined && (!Number.isInteger(flags.minProjects) || flags.minProjects < 1)) {
            const payload = errOut(
                'INVALID_MIN_PROJECTS',
                `Invalid --min-projects "${flags.minProjects}". Expected a positive integer >= 1.`
            );
            emitResponse(payload, flags.json, [], writeOut, writeErr);
            return { exitCode: 1, payload };
        }

        const scoutRes = scoutHomelabLegoCandidates(resolvedProjectsRoot, {
            minProjects: flags.minProjects ?? 3,
            portablePaths: flags.portable
        });

        if (!scoutRes.ok) {
            const payload = errOut(
                scoutRes.error?.code || 'SCOUT_FAILED',
                scoutRes.error?.message || 'Failed to scout Lego candidates',
                scoutRes.error?.details ?? null
            );
            emitResponse(payload, flags.json, [], writeOut, writeErr);
            return { exitCode: 1, payload };
        }

        const payload = okOut(scoutRes.summary, scoutRes.data);
        const { adoptionFindings, candidateClusters, ruleOfThreeThreshold } = scoutRes.data;
        const lines = [
            scoutRes.summary,
            '',
            `=== Existing Lego Adoption Opportunities (${adoptionFindings.length} project(s)) ===`,
            ...adoptionFindings.slice(0, 15).map(
                (f) => `  - [LEGO-ADOPT] ${f.project} (${f.findingCount} hit(s)) -> ${f.recommendedBricks.join(', ')}`
            ),
            '',
            `=== Cross-Repo Candidate Clusters (Rule-of-${ruleOfThreeThreshold}) ===`,
            ...candidateClusters.map(
                (c) => `  - [${c.status}] ${c.id} (${c.projectCount} project(s): ${c.projects.slice(0, 5).join(', ')}${c.projects.length > 5 ? '...' : ''}) -> ${c.proposedBrickImport}`
            )
        ];
        emitResponse(payload, flags.json, lines, writeOut, writeErr);
        return { exitCode: 0, payload };
    }

    if (command === 'keygen') {
        const keyRes = generateBrickSigningKeyPair();
        if (!keyRes.ok) {
            emitResponse(keyRes, flags.json, [], writeOut, writeErr);
            return { exitCode: 1, payload: keyRes };
        }
        let savedPaths = null;
        if (flags.out) {
            const outDir = path.resolve(flags.out);
            fs.mkdirSync(outDir, { recursive: true });
            const privPath = path.join(outDir, 'brick-signing.key.pem');
            const pubPath = path.join(outDir, 'brick-signing.pub.pem');
            fs.writeFileSync(privPath, keyRes.data.privateKeyPem, { mode: 0o600 });
            fs.writeFileSync(pubPath, keyRes.data.publicKeyPem, 'utf8');
            savedPaths = { privateKeyPath: privPath, publicKeyPath: pubPath };
        }
        const payload = okOut(keyRes.summary, {
            ...keyRes.data,
            ...(savedPaths ? savedPaths : {})
        });
        const lines = [
            keyRes.summary,
            `Key ID: ${keyRes.data.keyId}`,
            ...(savedPaths ? [`Saved:  ${savedPaths.privateKeyPath}, ${savedPaths.publicKeyPath}`] : [])
        ];
        emitResponse(payload, flags.json, lines, writeOut, writeErr);
        return { exitCode: 0, payload };
    }

    if (command === 'seal') {
        const specPathRaw = positionals[1] || '';
        if (!specPathRaw) {
            const payload = errOut(
                'MISSING_SPEC',
                'Usage: krusch-lego seal <specJsonPath> [--out <bundlePath>] [--key <privateKeyPemPath>] [--db <sqlitePath>] [--json]'
            );
            emitResponse(payload, flags.json, [], writeOut, writeErr);
            return { exitCode: 1, payload };
        }
        const specAbs = path.resolve(specPathRaw);
        if (!fs.existsSync(specAbs)) {
            const payload = errOut('ENOENT', `Spec file not found: ${specAbs}`);
            emitResponse(payload, flags.json, [], writeOut, writeErr);
            return { exitCode: 1, payload };
        }
        let specObj;
        try {
            specObj = JSON.parse(fs.readFileSync(specAbs, 'utf8'));
        } catch (err) {
            const payload = errOut('INVALID_JSON', `Failed to parse spec JSON: ${err.message}`);
            emitResponse(payload, flags.json, [], writeOut, writeErr);
            return { exitCode: 1, payload };
        }
        const source =
            typeof specObj.source === 'string'
                ? specObj.source
                : specObj.sourceFile
                  ? fs.readFileSync(path.resolve(path.dirname(specAbs), specObj.sourceFile), 'utf8')
                  : '';
        const privateKeyPem = flags.key
            ? fs.readFileSync(path.resolve(flags.key), 'utf8')
            : specObj.privateKeyPem || '';
        const sealRes = await sealBrick({
            ...specObj,
            source,
            privateKeyPem
        });
        if (!sealRes.ok) {
            const payload = errOut(
                sealRes.error?.code || 'SEAL_FAILED',
                sealRes.error?.message || 'Brick failed verification gates',
                sealRes.error?.details ?? null
            );
            emitResponse(payload, flags.json, [], writeOut, writeErr);
            return { exitCode: 1, payload };
        }
        let outPath = null;
        if (flags.out) {
            outPath = path.resolve(flags.out);
            fs.mkdirSync(path.dirname(outPath), { recursive: true });
            fs.writeFileSync(outPath, JSON.stringify(sealRes.data.bundle, null, 2) + '\n', 'utf8');
        }
        let published = null;
        if (flags.db) {
            const store = createBrickExchangeStore({ dbPath: path.resolve(flags.db) });
            try {
                published = store.publishSealedBrick(sealRes.data.bundle, {
                    actorId: flags.actor || sealRes.data.bundle.authorId
                });
            } finally {
                store.close();
            }
        }
        const payload = okOut(sealRes.summary, {
            ...sealRes.data,
            ...(outPath ? { outPath } : {}),
            ...(published ? { published } : {})
        });
        const lines = [
            sealRes.summary,
            `Source Hash: ${sealRes.data.bundle.lineage.sourceHash}`,
            `Key ID:      ${sealRes.data.bundle.attestation.keyId}`,
            ...(outPath ? [`Bundle File: ${outPath}`] : [])
        ];
        emitResponse(payload, flags.json, lines, writeOut, writeErr);
        return { exitCode: 0, payload };
    }

    if (command === 'verify') {
        const bundlePathRaw = positionals[1] || '';
        if (!bundlePathRaw) {
            const payload = errOut(
                'MISSING_BUNDLE',
                'Usage: krusch-lego verify <bundlePath> [--pub-key <publicKeyPemPath>] [--json]'
            );
            emitResponse(payload, flags.json, [], writeOut, writeErr);
            return { exitCode: 1, payload };
        }
        const bundleAbs = path.resolve(bundlePathRaw);
        if (!fs.existsSync(bundleAbs)) {
            const payload = errOut('ENOENT', `Bundle file not found: ${bundleAbs}`);
            emitResponse(payload, flags.json, [], writeOut, writeErr);
            return { exitCode: 1, payload };
        }
        const bundle = JSON.parse(fs.readFileSync(bundleAbs, 'utf8'));
        const trustedPublicKeyPem = flags.pubKey ? fs.readFileSync(path.resolve(flags.pubKey), 'utf8') : null;
        const verifyRes = verifyBrickBundle(bundle, { trustedPublicKeyPem });
        if (!verifyRes.ok) {
            const payload = errOut(
                verifyRes.error?.code || 'VERIFY_FAILED',
                verifyRes.error?.message || 'Bundle verification failed',
                verifyRes.error?.details ?? null
            );
            emitResponse(payload, flags.json, [], writeOut, writeErr);
            return { exitCode: 1, payload };
        }
        const payload = okOut(verifyRes.summary, verifyRes.data);
        const lines = [
            verifyRes.summary,
            `Brick ID:    ${verifyRes.data.brickId}`,
            `Source Hash: ${verifyRes.data.sourceHash}`,
            `Key ID:      ${verifyRes.data.keyId}`
        ];
        emitResponse(payload, flags.json, lines, writeOut, writeErr);
        return { exitCode: 0, payload };
    }

    if (command === 'try') {
        const bundlePathRaw = positionals[1] || '';
        if (!bundlePathRaw || !flags.input) {
            const payload = errOut(
                'MISSING_ARGS',
                'Usage: krusch-lego try <bundlePath> --input <jsonOrFile> [--binding <jsonFile>] [--json]'
            );
            emitResponse(payload, flags.json, [], writeOut, writeErr);
            return { exitCode: 1, payload };
        }
        const bundle = JSON.parse(fs.readFileSync(path.resolve(bundlePathRaw), 'utf8'));
        const sampleInput = fs.existsSync(path.resolve(flags.input))
            ? JSON.parse(fs.readFileSync(path.resolve(flags.input), 'utf8'))
            : JSON.parse(flags.input);
        const binding = flags.binding
            ? fs.existsSync(path.resolve(flags.binding))
                ? JSON.parse(fs.readFileSync(path.resolve(flags.binding), 'utf8'))
                : JSON.parse(flags.binding)
            : {};
        const tryRes = await tryBrickLocally({ bundle, binding, sampleInput });
        if (!tryRes.ok) {
            const payload = errOut(
                tryRes.error?.code || 'TRY_FAILED',
                tryRes.error?.message || 'Local sandbox verification failed',
                tryRes.error?.details ?? null
            );
            emitResponse(payload, flags.json, [], writeOut, writeErr);
            return { exitCode: 1, payload };
        }
        const payload = okOut(tryRes.summary, tryRes.data);
        const lines = [
            tryRes.summary,
            `Duration: ${tryRes.data.durationMs} ms`,
            `Output:   ${JSON.stringify(tryRes.data.output)}`
        ];
        emitResponse(payload, flags.json, lines, writeOut, writeErr);
        return { exitCode: 0, payload };
    }

    if (command === 'adopt') {
        const bundlePathRaw = positionals[1] || '';
        const targetRepoDir = positionals[2] || process.cwd();
        if (!bundlePathRaw) {
            const payload = errOut(
                'MISSING_BUNDLE',
                'Usage: krusch-lego adopt <bundlePath> [targetRepoDir] [--binding <file>] [--stack <stackSlug>] [--sample <jsonFile>] [--grant <grantId>] [--by <memberId>] [--db <sqlitePath>] [--json]'
            );
            emitResponse(payload, flags.json, [], writeOut, writeErr);
            return { exitCode: 1, payload };
        }
        const bundle = JSON.parse(fs.readFileSync(path.resolve(bundlePathRaw), 'utf8'));
        const bindingSource =
            flags.binding && fs.existsSync(path.resolve(flags.binding))
                ? fs.readFileSync(path.resolve(flags.binding), 'utf8')
                : null;
        let localSample = undefined;
        if (flags.sample) {
            try {
                localSample = fs.existsSync(path.resolve(flags.sample))
                    ? JSON.parse(fs.readFileSync(path.resolve(flags.sample), 'utf8'))
                    : JSON.parse(flags.sample);
            } catch (err) {
                const payload = errOut('INVALID_SAMPLE_JSON', `Failed to parse --sample JSON: ${err.message}`);
                emitResponse(payload, flags.json, [], writeOut, writeErr);
                return { exitCode: 1, payload };
            }
        }
        const adoptRes = await adoptBrickIntoRepo({
            bundle,
            targetRepoDir: path.resolve(targetRepoDir),
            bindingSource,
            targetStack: flags.stack || null,
            ...(localSample !== undefined ? { localSample } : {}),
            grantId: flags.grant || null,
            adoptedBy: flags.by || 'cli-dev'
        });
        if (!adoptRes.ok) {
            const payload = errOut(
                adoptRes.error?.code || 'ADOPT_FAILED',
                adoptRes.error?.message || 'Failed to adopt brick into repository',
                adoptRes.error?.details ?? null
            );
            emitResponse(payload, flags.json, [], writeOut, writeErr);
            return { exitCode: 1, payload };
        }
        let ledgerRecord = null;
        if (flags.db && flags.by) {
            const store = createBrickExchangeStore({ dbPath: path.resolve(flags.db) });
            try {
                ledgerRecord = await store.recordAdoption({
                    userId: flags.by,
                    brickId: bundle.brickId,
                    sourceHash: bundle.lineage.sourceHash,
                    grantId: flags.grant || null,
                    localChecksPassed: true
                });
            } finally {
                store.close();
            }
        }
        const payload = okOut(adoptRes.summary, {
            ...adoptRes.data,
            ...(ledgerRecord ? { ledgerRecord } : {})
        });
        const lines = [
            adoptRes.summary,
            `Entry:    ${adoptRes.data.entryPath}`,
            `Binding:  ${adoptRes.data.bindingPath}`,
            `Lockfile: ${adoptRes.data.lockfilePath}`
        ];
        emitResponse(payload, flags.json, lines, writeOut, writeErr);
        return { exitCode: 0, payload };
    }

    if (command === 'suggest') {
        const brickId = positionals[1] || '';
        if (!brickId || !flags.db || !flags.actor) {
            const payload = errOut(
                'MISSING_ARGS',
                'Usage: krusch-lego suggest <brickId> --db <sqlitePath> --actor <memberId> [--repo-root <dir>] [--json]'
            );
            emitResponse(payload, flags.json, [], writeOut, writeErr);
            return { exitCode: 1, payload };
        }
        const store = createBrickExchangeStore({ dbPath: path.resolve(flags.db) });
        try {
            const res = await store.suggestRecipients({
                actorId: flags.actor,
                brickId,
                sourceHash: flags.hash || null,
                repoRoot: flags.repoRoot ? path.resolve(flags.repoRoot) : null
            });
            if (!res.ok) {
                const payload = errOut(res.error?.code || 'SUGGEST_FAILED', res.error?.message || 'Suggest failed');
                emitResponse(payload, flags.json, [], writeOut, writeErr);
                return { exitCode: 1, payload };
            }
            const payload = okOut(res.summary, res.data);
            const lines = [
                res.summary,
                ...res.data.suggestions.map(
                    (s) => `  - ${s.memberId} (${s.orgId}) [${s.deliveryChannel}] score=${s.score}: ${s.reason}`
                )
            ];
            emitResponse(payload, flags.json, lines, writeOut, writeErr);
            return { exitCode: 0, payload };
        } finally {
            store.close();
        }
    }

    if (command === 'share') {
        const brickId = positionals[1] || '';
        const recipients = flags.to
            ? flags.to
                  .split(',')
                  .map((x) => x.trim())
                  .filter(Boolean)
            : [];
        if (!brickId || !flags.db || !flags.issuer || recipients.length === 0) {
            const payload = errOut(
                'MISSING_ARGS',
                'Usage: krusch-lego share <brickId> --db <sqlitePath> --issuer <memberId> --to <csvRecipients> [--hash <sourceHash>] [--expires-days <n>] [--json]'
            );
            emitResponse(payload, flags.json, [], writeOut, writeErr);
            return { exitCode: 1, payload };
        }
        const store = createBrickExchangeStore({ dbPath: path.resolve(flags.db) });
        try {
            let sourceHash = flags.hash;
            if (!sourceHash) {
                const visible = store.getVisibleBrick({ viewerId: flags.issuer, brickId });
                if (visible.ok) {
                    sourceHash = visible.data.bundle.lineage.sourceHash;
                }
            }
            const days = Number.isFinite(flags.expiresDays) && flags.expiresDays > 0 ? flags.expiresDays : 30;
            const expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();
            const res = store.issueGrant({
                issuerId: flags.issuer,
                brickId,
                sourceHash,
                scope: 'federated',
                recipients,
                expiresAt
            });
            if (!res.ok) {
                const payload = errOut(res.error?.code || 'SHARE_FAILED', res.error?.message || 'Grant failed');
                emitResponse(payload, flags.json, [], writeOut, writeErr);
                return { exitCode: 1, payload };
            }
            const payload = okOut(res.summary, res.data);
            const lines = [
                res.summary,
                `Grant ID:   ${res.data.grant.id}`,
                `Recipients: ${res.data.grant.recipients.join(', ')}`,
                `Expires:    ${res.data.grant.expiresAt}`
            ];
            emitResponse(payload, flags.json, lines, writeOut, writeErr);
            return { exitCode: 0, payload };
        } finally {
            store.close();
        }
    }

    if (command === 'revoke') {
        const grantId = positionals[1] || '';
        if (!grantId || !flags.db || !flags.actor) {
            const payload = errOut(
                'MISSING_ARGS',
                'Usage: krusch-lego revoke <grantId> --db <sqlitePath> --actor <memberId> [--json]'
            );
            emitResponse(payload, flags.json, [], writeOut, writeErr);
            return { exitCode: 1, payload };
        }
        const store = createBrickExchangeStore({ dbPath: path.resolve(flags.db) });
        try {
            const res = store.revokeGrant({ actorId: flags.actor, grantId });
            if (!res.ok) {
                const payload = errOut(res.error?.code || 'REVOKE_FAILED', res.error?.message || 'Revoke failed');
                emitResponse(payload, flags.json, [], writeOut, writeErr);
                return { exitCode: 1, payload };
            }
            const payload = okOut(res.summary, res.data);
            emitResponse(payload, flags.json, [res.summary], writeOut, writeErr);
            return { exitCode: 0, payload };
        } finally {
            store.close();
        }
    }

    if (command === 'inbox') {
        if (!flags.db || !flags.viewer) {
            const payload = errOut(
                'MISSING_ARGS',
                'Usage: krusch-lego inbox --db <sqlitePath> --viewer <memberId> [--query <q>] [--json]'
            );
            emitResponse(payload, flags.json, [], writeOut, writeErr);
            return { exitCode: 1, payload };
        }
        const store = createBrickExchangeStore({ dbPath: path.resolve(flags.db) });
        try {
            const res = store.listVisibleBricks({ viewerId: flags.viewer, query: flags.query || '' });
            if (!res.ok) {
                const payload = errOut(res.error?.code || 'INBOX_FAILED', res.error?.message || 'Inbox failed');
                emitResponse(payload, flags.json, [], writeOut, writeErr);
                return { exitCode: 1, payload };
            }
            const payload = okOut(res.summary, res.data);
            const lines = [
                res.summary,
                ...res.data.bricks.map(
                    (b) =>
                        `  - ${b.brickId}@${String(b.lineage?.sourceHash || b.sourceHash || '').slice(0, 8)} (${b.orgId}) [${b.access?.mode || b.accessMode || 'authorized'}]`
                )
            ];
            emitResponse(payload, flags.json, lines, writeOut, writeErr);
            return { exitCode: 0, payload };
        } finally {
            store.close();
        }
    }

    if (command === 'hub') {
        const dbPath = flags.db ? path.resolve(flags.db) : ':memory:';
        const listenPort = Number.isInteger(flags.port) && flags.port >= 0 ? flags.port : 4318;
        const allowedWorkspaceRoot = path.resolve(flags.repo || flags.repoRoot || process.cwd());
        const corsOrigins = flags.corsOrigins.length > 0 ? flags.corsOrigins : [];
        const authTokens = flags.authTokens.length > 0 ? flags.authTokens : null;
        const store = createBrickExchangeStore({ dbPath });
        const server = createBrickExchangeServer({
            store,
            allowedWorkspaceRoot,
            corsOrigins,
            authTokens
        });
        attachGracefulShutdown(server, { onShutdown: () => store.close() });
        await new Promise((resolve) => server.listen(listenPort, '127.0.0.1', resolve));
        const addr = server.address();
        const actualPort = typeof addr === 'object' && addr ? addr.port : listenPort;
        const payload = okOut(`Brick Exchange Hub listening on http://127.0.0.1:${actualPort}`, {
            port: actualPort,
            dbPath,
            consoleUrl: `http://127.0.0.1:${actualPort}/`
        });
        emitResponse(payload, flags.json, [payload.summary], writeOut, writeErr);
        return { exitCode: 0, payload };
    }

    if (command === 'mcp') {
        const dbPath = flags.db ? path.resolve(flags.db) : ':memory:';
        const store = createBrickExchangeStore({ dbPath });
        await createBrickExchangeMcpServer({ store, connect: true });
        return { exitCode: 0, payload: okOut('Brick Exchange MCP server connected over stdio', { dbPath }) };
    }

    if (command === 'blast-radius') {
        const changedCsv = positionals[1] || '';
        const repoDir = positionals[2] || process.cwd();
        if (!changedCsv) {
            const payload = errOut(
                'MISSING_ARGS',
                'Usage: krusch-lego blast-radius <changedFileCsv> [repoDir] [--json]'
            );
            emitResponse(payload, flags.json, [], writeOut, writeErr);
            return { exitCode: 1, payload };
        }
        const changedFiles = changedCsv
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
        const res = analyzeBrickBlastRadius({ repoDir: path.resolve(repoDir), changedFiles });
        if (!res.ok) {
            const payload = errOut(res.error?.code || 'BLAST_RADIUS_FAILED', res.error?.message || 'Blast radius failed');
            emitResponse(payload, flags.json, [], writeOut, writeErr);
            return { exitCode: 1, payload };
        }
        const payload = okOut(res.summary, res.data);
        const lines = [
            res.summary,
            `Hop-1 Callers: ${res.data.hop1Dependents.join(', ') || '(none)'}`,
            `Hop-2 Callers: ${res.data.hop2Dependents.join(', ') || '(none)'}`,
            ...res.data.hopPaths.map((p) => `  Path: ${p}`)
        ];
        emitResponse(payload, flags.json, lines, writeOut, writeErr);
        return { exitCode: 0, payload };
    }

    if (command === 'fanout') {
        const tasksJsonPath = positionals[1] || '';
        const repoDir = positionals[2] || process.cwd();
        if (!tasksJsonPath || !fs.existsSync(path.resolve(tasksJsonPath))) {
            const payload = errOut(
                'MISSING_ARGS',
                'Usage: krusch-lego fanout <tasksJsonPath> [repoDir] [--json]'
            );
            emitResponse(payload, flags.json, [], writeOut, writeErr);
            return { exitCode: 1, payload };
        }
        const parsed = JSON.parse(fs.readFileSync(path.resolve(tasksJsonPath), 'utf8'));
        const tasks = Array.isArray(parsed) ? parsed : parsed.tasks || [];
        const protectedFiles = Array.isArray(parsed?.protectedFiles) ? parsed.protectedFiles : [];
        const res = planAgentFanOut({
            repoDir: path.resolve(repoDir),
            tasks,
            protectedFiles
        });
        if (!res.ok) {
            const payload = errOut(res.error?.code || 'FANOUT_FAILED', res.error?.message || 'Fan-out plan failed', res.error?.details ?? null);
            emitResponse(payload, flags.json, [], writeOut, writeErr);
            return { exitCode: 1, payload };
        }
        const payload = okOut(res.summary, res.data);
        const lines = [
            res.summary,
            ...res.data.waves.map(
                (w) => `  Wave ${w.wave} (${w.parallelizable ? 'parallel' : 'serial'}): ${w.taskIds.join(', ')}`
            )
        ];
        emitResponse(payload, flags.json, lines, writeOut, writeErr);
        return { exitCode: 0, payload };
    }

    if (command === 'ontology') {
        const sub = (positionals[1] || 'inspect').toLowerCase();
        if (sub === 'inspect') {
            const filter = positionals[2] || flags.runtime || flags.query || '';
            const eqRes = resolveCrossStackCatalogEquivalents(filter);
            const payload = okOut('Inspected 4-axis Brick Exchange ontology and cross-stack catalog', {
                stacks: ONTOLOGY_STACKS,
                ports: ONTOLOGY_DATA_PORTS,
                channels: ONTOLOGY_CHANNELS,
                moeProfiles: ONTOLOGY_MOE_PROFILES,
                crossStackEquivalents: CROSS_STACK_BRICK_EQUIVALENTS,
                catalogCoverage: eqRes.ok ? eqRes.data : null
            });
            const lines = [
                payload.summary,
                `Stacks (${Object.keys(ONTOLOGY_STACKS).length}): ${Object.keys(ONTOLOGY_STACKS).join(', ')}`,
                `Ports (${Object.keys(ONTOLOGY_DATA_PORTS).length}): ${Object.keys(ONTOLOGY_DATA_PORTS).join(', ')}`,
                `Channels (${Object.keys(ONTOLOGY_CHANNELS).length}): ${Object.keys(ONTOLOGY_CHANNELS).join(', ')}`,
                `MoE Profiles (${Object.keys(ONTOLOGY_MOE_PROFILES).length}): ${Object.keys(ONTOLOGY_MOE_PROFILES).join(', ')}`
            ];
            emitResponse(payload, flags.json, lines, writeOut, writeErr);
            return { exitCode: 0, payload };
        }

        if (sub === 'check') {
            const bundlePathRaw = positionals[2] || '';
            if (!bundlePathRaw || !fs.existsSync(path.resolve(bundlePathRaw))) {
                const payload = errOut(
                    'MISSING_BUNDLE',
                    'Usage: krusch-lego ontology check <bundlePath> [--stack <stackSlug>] [--channel <channelId>] [--sample <jsonPath>] [--json]'
                );
                emitResponse(payload, flags.json, [], writeOut, writeErr);
                return { exitCode: 1, payload };
            }
            const bundle = JSON.parse(fs.readFileSync(path.resolve(bundlePathRaw), 'utf8'));
            const sampleData =
                flags.sample && fs.existsSync(path.resolve(flags.sample))
                    ? JSON.parse(fs.readFileSync(path.resolve(flags.sample), 'utf8'))
                    : undefined;
            const res = checkOntologyCompatibility({
                bundle,
                targetStack: flags.stack || 'node-esm',
                targetChannel: flags.channel || null,
                sampleData
            });
            if (!res.ok) {
                const payload = errOut(res.error?.code || 'ONTOLOGY_CHECK_FAILED', res.error?.message || 'Check failed', res.error?.details ?? null);
                emitResponse(payload, flags.json, [], writeOut, writeErr);
                return { exitCode: 1, payload };
            }
            const payload = okOut(res.summary, res.data);
            emitResponse(payload, flags.json, [res.summary, `Bridge Mode: ${res.data.bridgeMode}`], writeOut, writeErr);
            return { exitCode: 0, payload };
        }

        if (sub === 'compose') {
            if (!flags.db || !flags.viewer) {
                const payload = errOut(
                    'MISSING_ARGS',
                    'Usage: krusch-lego ontology compose --db <sqlitePath> --viewer <memberId> [--stack <stackSlug>] [--channel <channelId>] [--ports <csvPorts>] [--as-of <YYYY-MM-DD>] [--json]'
                );
                emitResponse(payload, flags.json, [], writeOut, writeErr);
                return { exitCode: 1, payload };
            }
            const requiredPorts = flags.ports
                ? flags.ports.split(',').map((s) => s.trim()).filter(Boolean)
                : [];
            const store = createBrickExchangeStore({ dbPath: path.resolve(flags.db) });
            try {
                const res = await store.planCrossStackComposition({
                    viewerId: flags.viewer,
                    targetStack: flags.stack || null,
                    targetChannel: flags.channel || null,
                    requiredPorts,
                    asOf: flags.asOf || null
                });
                if (!res.ok) {
                    const payload = errOut(res.error?.code || 'ONTOLOGY_COMPOSE_FAILED', res.error?.message || 'Compose failed', res.error?.details ?? null);
                    emitResponse(payload, flags.json, [], writeOut, writeErr);
                    return { exitCode: 1, payload };
                }
                const payload = okOut(res.summary, res.data);
                const lines = [
                    res.summary,
                    `Direct Matches: ${res.data.directMatches.length}`,
                    `2-Hop Chains:   ${res.data.compositions.length}`,
                    `Retired (SUPERSEDES): ${res.data.retiredSupersededBricks.length}`
                ];
                emitResponse(payload, flags.json, lines, writeOut, writeErr);
                return { exitCode: 0, payload };
            } finally {
                store.close();
            }
        }

        if (sub === 'bind') {
            const bundlePathRaw = positionals[2] || '';
            if (!bundlePathRaw || !fs.existsSync(path.resolve(bundlePathRaw))) {
                const payload = errOut(
                    'MISSING_BUNDLE',
                    'Usage: krusch-lego ontology bind <bundlePath> [--stack <stackSlug>] [--sample <jsonPath>] [--out <adapterPath>] [--json]'
                );
                emitResponse(payload, flags.json, [], writeOut, writeErr);
                return { exitCode: 1, payload };
            }
            const bundle = JSON.parse(fs.readFileSync(path.resolve(bundlePathRaw), 'utf8'));
            const samplePath = flags.sample || flags.input || '';
            const localSample =
                samplePath && fs.existsSync(path.resolve(samplePath))
                    ? JSON.parse(fs.readFileSync(path.resolve(samplePath), 'utf8'))
                    : undefined;
            const res = await synthesizeBrickBinding({
                bundle,
                targetStack: flags.stack || 'node-esm',
                localSample
            });
            if (!res.ok) {
                const payload = errOut(res.error?.code || 'ONTOLOGY_BIND_FAILED', res.error?.message || 'Bind failed', res.error?.details ?? null);
                emitResponse(payload, flags.json, [], writeOut, writeErr);
                return { exitCode: 1, payload };
            }
            if (flags.out) {
                const outAbs = path.resolve(flags.out);
                fs.mkdirSync(path.dirname(outAbs), { recursive: true });
                fs.writeFileSync(outAbs, res.data.adapterSource, 'utf8');
            }
            const payload = okOut(res.summary, res.data);
            emitResponse(
                payload,
                flags.json,
                [res.summary, `Adapter: ${res.data.adapterFileName} (${res.data.cascadeTierUsed})`],
                writeOut,
                writeErr
            );
            return { exitCode: 0, payload };
        }

        const payload = errOut(
            'UNKNOWN_ONTOLOGY_SUBCOMMAND',
            `Unknown ontology subcommand "${sub}". Expected: inspect, check, compose, bind`
        );
        emitResponse(payload, flags.json, [], writeOut, writeErr);
        return { exitCode: 1, payload };
    }

    const payload = errOut(
        'UNKNOWN_COMMAND',
        `Unknown command "${command}". Expected one of: list, inspect, stamp, audit, scout, keygen, seal, verify, try, adopt, suggest, share, revoke, inbox, hub, mcp, blast-radius, fanout, ontology`
    );
    emitResponse(payload, flags.json, [], writeOut, writeErr);
    return { exitCode: 1, payload };
}

const isMain =
    Boolean(process.argv[1]) &&
    resolveRealPath(fileURLToPath(import.meta.url)) === resolveRealPath(process.argv[1]);
if (isMain) {
    const { exitCode } = await runCli(process.argv.slice(2));
    if (exitCode !== 0) {
        process.exitCode = exitCode;
    }
}

