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
    auditBoilerplateText
} from '../catalog.js';
import { scaffoldProject } from '../scaffold.js';
import { scoutHomelabLegoCandidates } from '../lego-scout.js';

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
        minProjects: undefined
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
            'krusch-lego — Sovereign Toolkit Brick & Archetype CLI',
            '',
            'Usage:',
            '  krusch-lego list [--runtime <node|python|react|edge>] [--json]',
            '  krusch-lego inspect <brickOrArchetypeId> [--json]',
            '  krusch-lego stamp <archetype> [targetDir] [--name <projectName>] [--port <port>] [--force] [--dry-run] [--json]',
            '  krusch-lego audit <fileOrDir> [--json]',
            '  krusch-lego scout [projectsDir] [--min-projects <n>] [--portable] [--json]'
        ];
        const payload = okOut('Displayed krusch-lego usage', {
            commands: ['list', 'inspect', 'stamp', 'audit', 'scout'],
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
        const findings = [];
        let flaggedFileCount = 0;

        for (const filePath of files) {
            const code = fs.readFileSync(filePath, 'utf-8');
            const report = auditBoilerplateText(code, filePath);
            if (!report.data.clean) {
                flaggedFileCount += 1;
                for (const item of report.data.findings) {
                    findings.push({
                        filePath,
                        ...item
                    });
                }
            }
        }

        const clean = findings.length === 0;
        const summary = clean
            ? `Audited ${files.length} file(s): zero hand-rolled boilerplate findings`
            : `Audited ${files.length} file(s): found ${findings.length} boilerplate anti-pattern(s) across ${flaggedFileCount} file(s)`;

        const payload = okOut(summary, {
            target: resolvedTarget,
            scannedFiles: files.length,
            flaggedFiles: flaggedFileCount,
            clean,
            findings
        });

        const lines = [
            summary,
            ...findings.map(
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

    const payload = errOut(
        'UNKNOWN_COMMAND',
        `Unknown command "${command}". Expected one of: list, inspect, stamp, audit, scout`
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

