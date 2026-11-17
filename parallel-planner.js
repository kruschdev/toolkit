/**
 * @module parallel-planner
 * @description Deterministic Disjoint Parallel Subagent File-Lease & Execution-Wave Solver
 * (`AGENTS.md` Rule #4 / `/parallel-build`) plus Out-of-Process Node 22 `--permission`
 * Sandboxed Script Evaluator (`INV-LEGO-01`, `INV-LEGO-13`).
 */

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { okEnvelope, errorEnvelope } from './http.js';

const execFileAsync = promisify(execFile);

export const DEFAULT_CHOKE_POINT_FILES = Object.freeze([
    'server.js',
    'src/server.js',
    'app.js',
    'src/app.js',
    'index.js',
    'src/index.js',
    'main.js',
    'src/main.js',
    'tools.js',
    'src/tools.js',
    'App.jsx',
    'src/App.jsx',
    'client/src/App.jsx',
    'App.tsx',
    'src/App.tsx',
    'client/src/App.tsx',
    'package.json',
]);

/**
 * Normalize a workspace-relative file path to POSIX forward-slash form without leading `./` or `/`.
 *
 * @param {unknown} rawPath
 * @returns {string}
 */
export function normalizeRelativeCodePath(rawPath) {
    const clean = String(rawPath ?? '')
        .replace(/\\/g, '/')
        .replace(/^(?:\.\/+|\/+)+/, '')
        .trim();
    if (!clean || clean === '.' || clean.includes('\0')) return '';
    const normalized = path.posix.normalize(clean);
    if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
        return '';
    }
    return normalized;
}

/**
 * Check whether a normalized relative path matches a known orchestrator choke point.
 *
 * @param {string} relPath
 * @param {ReadonlySet<string>} chokeSet
 * @returns {boolean}
 */
function isChokePointPath(relPath, chokeSet) {
    if (!relPath) return false;
    if (chokeSet.has(relPath)) return true;
    const base = path.posix.basename(relPath);
    return (
        base === 'package.json' ||
        base === 'App.jsx' ||
        base === 'App.tsx'
    ) && chokeSet.has(base);
}

/**
 * Compute 2-hop AST/import blast-radius cones, detect orchestrator choke points, issue disjoint
 * subagent file leases, and partition candidate Work Orders / subagent tasks into conflict-free
 * parallel execution waves.
 *
 * `edges` represent directed dependency imports `{ from: importerFile, to: importedTargetFile }`
 * (so mutating `to` impacts inbound caller `from`).
 *
 * @param {object} [params={}]
 * @param {Array<{ id?: string, workOrderId?: string, title?: string, targetFiles?: string[], files?: string[] }>} [params.tasks=[]]
 * @param {Array<{ from: string, to: string }>} [params.edges=[]]
 * @param {Iterable<string>} [params.chokePoints=DEFAULT_CHOKE_POINT_FILES]
 * @param {number} [params.maxBlastHops=2]
 * @param {string} [params.tool='planner.waves']
 */
export function planDisjointTaskWaves(params = {}) {
    const opts = params && typeof params === 'object' ? params : {};
    const safeTool =
        typeof opts.tool === 'string' && opts.tool.trim()
            ? opts.tool.trim()
            : 'planner.waves';
    const rawTasks = Array.isArray(opts.tasks) ? opts.tasks : [];
    const rawEdges = Array.isArray(opts.edges) ? opts.edges : [];
    const maxBlastHops = Math.max(0, Math.min(Number.isInteger(opts.maxBlastHops) ? opts.maxBlastHops : 2, 4));

    const chokeSet = new Set();
    for (const item of opts.chokePoints ?? DEFAULT_CHOKE_POINT_FILES) {
        const norm = normalizeRelativeCodePath(item);
        if (norm) chokeSet.add(norm);
    }

    /** @type {Map<string, Set<string>>} targetFile -> Set<importerCallerFile> */
    const inboundCallers = new Map();
    for (const edge of rawEdges) {
        if (!edge || typeof edge !== 'object') continue;
        const importer = normalizeRelativeCodePath(edge.from ?? edge.source ?? edge.sourcePath);
        const imported = normalizeRelativeCodePath(edge.to ?? edge.target ?? edge.targetPath);
        if (!importer || !imported || importer === imported) continue;
        if (!inboundCallers.has(imported)) {
            inboundCallers.set(imported, new Set());
        }
        inboundCallers.get(imported).add(importer);
    }

    const reservedOrchestratorFiles = new Set();
    const leases = rawTasks.map((task, idx) => {
        const taskId = String(task?.id ?? task?.workOrderId ?? `TASK-${idx + 1}`).trim() || `TASK-${idx + 1}`;
        const title = String(task?.title ?? taskId).trim() || taskId;
        const rawTargets = Array.isArray(task?.targetFiles)
            ? task.targetFiles
            : Array.isArray(task?.files)
              ? task.files
              : [];

        const targetFiles = [];
        const seenTarget = new Set();
        for (const rawFile of rawTargets) {
            const norm = normalizeRelativeCodePath(rawFile);
            if (norm && !seenTarget.has(norm)) {
                seenTarget.add(norm);
                targetFiles.push(norm);
            }
        }

        const coneSet = new Set(targetFiles);
        const hop1Dependents = new Set();
        const hop2Dependents = new Set();
        const touchedChokePoints = new Set();

        for (const tf of targetFiles) {
            if (isChokePointPath(tf, chokeSet)) {
                touchedChokePoints.add(tf);
                reservedOrchestratorFiles.add(tf);
            }
            if (maxBlastHops < 1) continue;

            const callers1 = inboundCallers.get(tf) || new Set();
            for (const c1 of callers1) {
                if (isChokePointPath(c1, chokeSet)) {
                    touchedChokePoints.add(c1);
                    reservedOrchestratorFiles.add(c1);
                    continue;
                }
                coneSet.add(c1);
                if (!seenTarget.has(c1)) {
                    hop1Dependents.add(c1);
                }

                if (maxBlastHops >= 2) {
                    const callers2 = inboundCallers.get(c1) || new Set();
                    for (const c2 of callers2) {
                        if (isChokePointPath(c2, chokeSet)) {
                            touchedChokePoints.add(c2);
                            reservedOrchestratorFiles.add(c2);
                        } else if (c2 !== tf && !seenTarget.has(c2) && !hop1Dependents.has(c2)) {
                            hop2Dependents.add(c2);
                            coneSet.add(c2);
                        }
                    }
                }
            }
        }

        // Shared orchestrator choke points remain reserved for orchestrator-only wiring unless explicitly targeted
        for (const cp of touchedChokePoints) {
            if (!seenTarget.has(cp)) {
                coneSet.delete(cp);
            }
        }

        return {
            taskId,
            title,
            targetFiles,
            hop1Dependents: [...hop1Dependents].sort(),
            hop2Dependents: [...hop2Dependents].sort(),
            leaseCone: [...coneSet].sort(),
            reservedChokePoints: [...touchedChokePoints].sort(),
            wave: 1,
        };
    });

    /** @type {Array<{ wave: number, taskIds: string[], files: Set<string> }>} */
    const waveBuckets = [];
    for (const lease of leases) {
        let assignedIdx = -1;
        for (let w = 0; w < waveBuckets.length; w += 1) {
            const bucket = waveBuckets[w];
            const overlaps = lease.leaseCone.some((f) => bucket.files.has(f));
            if (!overlaps) {
                assignedIdx = w;
                break;
            }
        }
        if (assignedIdx === -1) {
            assignedIdx = waveBuckets.length;
            waveBuckets.push({ wave: assignedIdx + 1, taskIds: [], files: new Set() });
        }
        lease.wave = assignedIdx + 1;
        waveBuckets[assignedIdx].taskIds.push(lease.taskId);
        for (const f of lease.leaseCone) {
            waveBuckets[assignedIdx].files.add(f);
        }
    }

    const collisions = [];
    for (let i = 0; i < leases.length; i += 1) {
        const setA = new Set(leases[i].leaseCone);
        for (let j = i + 1; j < leases.length; j += 1) {
            const sharedFiles = leases[j].leaseCone.filter((f) => setA.has(f));
            if (sharedFiles.length > 0) {
                collisions.push({
                    tasks: [leases[i].taskId, leases[j].taskId],
                    sharedFiles,
                });
            }
        }
    }

    const waves = waveBuckets.map((b) => ({
        wave: b.wave,
        taskIds: b.taskIds,
        parallelizable: b.taskIds.length > 1,
        leasedFileCount: b.files.size,
    }));

    return okEnvelope(
        safeTool,
        `Planned ${leases.length} task(s) across ${waves.length} disjoint execution wave(s) (${collisions.length} cone collision(s)).`,
        {
            taskCount: leases.length,
            waveCount: waves.length,
            fullyParallelSingleWave: waves.length <= 1 && collisions.length === 0,
            waves,
            leases,
            collisions,
            reservedOrchestratorFiles: [...reservedOrchestratorFiles].sort(),
        }
    );
}

const SANDBOX_JSON_MARKER_PREFIX = '__KRUSCH_PERM_SANDBOX_JSON__:';

/**
 * Execute a JavaScript module snippet or entry file inside an out-of-process Node.js 22+
 * `--permission` capability jail:
 * - Strips host `process.env` secrets (exposing only minimal `PATH`, `CI=true`, `NODE_NO_WARNINGS=1`, plus explicit `allowedEnv`)
 * - Restricts filesystem reads strictly to `workspaceDir` + `extraReadPaths` (`--allow-fs-read=...`)
 * - Denies all filesystem writes unless `allowWritePaths` are explicitly provided (`--allow-fs-write=...`)
 * - Denies child process spawning, worker threads, native addons, and network unless explicitly allowed
 * - Enforces hard `SIGKILL` timeout and structured JSON marker extraction when `script` calls `__emitResult(obj)`
 *
 * @param {object} params
 * @param {string} params.workspaceDir - Contained directory to grant `--allow-fs-read` and use as `cwd`
 * @param {string} [params.script] - Inline ESM script (receives global `__emitResult(value)` helper)
 * @param {string} [params.entryFile] - Workspace-relative or absolute `.js`/`.mjs` test/script file to run
 * @param {string[]} [params.args=[]] - CLI arguments when running `entryFile` (e.g. `['--test', 'tests/unit.test.js']`)
 * @param {string[]} [params.extraReadPaths=[]] - Additional read-only paths (e.g. shared `node_modules`)
 * @param {string[]} [params.allowWritePaths=[]] - Explicit writable paths (empty = zero FS write permission)
 * @param {Record<string, string>} [params.allowedEnv={}] - Explicit non-secret environment variables
 * @param {number} [params.timeoutMs=5000] - Hard wall-clock timeout before `SIGKILL`
 * @param {string} [params.tool='sandbox.node_permission']
 */
export async function runNodePermissionSandbox(params = {}) {
    const opts = params && typeof params === 'object' ? params : {};
    const safeTool =
        typeof opts.tool === 'string' && opts.tool.trim()
            ? opts.tool.trim()
            : 'sandbox.node_permission';

    if (!opts.workspaceDir || typeof opts.workspaceDir !== 'string' || !fs.existsSync(opts.workspaceDir)) {
        return errorEnvelope(
            'SANDBOX_INVALID_WORKSPACE',
            'A valid existing workspaceDir directory is required for Node permission sandboxing.',
            null,
            safeTool
        );
    }

    let realWorkspace;
    try {
        realWorkspace = fs.realpathSync(path.resolve(opts.workspaceDir));
        if (!fs.statSync(realWorkspace).isDirectory()) {
            return errorEnvelope(
                'SANDBOX_INVALID_WORKSPACE',
                'workspaceDir must resolve to a directory.',
                null,
                safeTool
            );
        }
    } catch (err) {
        return errorEnvelope(
            'SANDBOX_INVALID_WORKSPACE',
            err?.message || 'Failed to resolve workspaceDir.',
            null,
            safeTool
        );
    }

    const hasInlineScript = typeof opts.script === 'string' && opts.script.trim().length > 0;
    const hasEntryFile = typeof opts.entryFile === 'string' && opts.entryFile.trim().length > 0;
    if (!hasInlineScript && !hasEntryFile && (!Array.isArray(opts.args) || opts.args.length === 0)) {
        return errorEnvelope(
            'SANDBOX_MISSING_TARGET',
            'Provide either an inline ESM `script`, an `entryFile`, or Node runner `args`.',
            null,
            safeTool
        );
    }

    const timeoutMs = Math.max(50, Math.min(Number(opts.timeoutMs) || 5_000, 300_000));
    const readPaths = new Set([realWorkspace, path.dirname(process.execPath)]);
    if (Array.isArray(opts.extraReadPaths)) {
        for (const p of opts.extraReadPaths) {
            if (typeof p === 'string' && p.trim() && fs.existsSync(p.trim())) {
                try {
                    readPaths.add(fs.realpathSync(path.resolve(p.trim())));
                } catch {
                    // Skip unresolvable path
                }
            }
        }
    }

    const writePaths = new Set();
    if (Array.isArray(opts.allowWritePaths)) {
        for (const p of opts.allowWritePaths) {
            if (typeof p === 'string' && p.trim() && fs.existsSync(p.trim())) {
                try {
                    writePaths.add(fs.realpathSync(path.resolve(p.trim())));
                } catch {
                    // Skip unresolvable path
                }
            }
        }
    }

    const permFlag = process.allowedNodeEnvironmentFlags?.has('--permission')
        ? '--permission'
        : '--experimental-permission';
    const execArgs = [permFlag];
    for (const rp of readPaths) {
        execArgs.push(`--allow-fs-read=${rp}`);
    }
    for (const wp of writePaths) {
        execArgs.push(`--allow-fs-write=${wp}`);
    }

    const marker = `${SANDBOX_JSON_MARKER_PREFIX}${crypto.randomBytes(12).toString('hex')}:`;

    if (hasInlineScript) {
        const wrappedScript = [
            'const __rawStdoutWrite = process.stdout.write.bind(process.stdout);',
            `const __MARKER = ${JSON.stringify(marker)};`,
            'globalThis.__emitResult = (payload) => {',
            '  __rawStdoutWrite(`\\n${__MARKER}${JSON.stringify(payload ?? null)}\\n`);',
            '};',
            opts.script,
        ].join('\n');
        execArgs.push('--input-type=module', '-e', wrappedScript);
    } else if (hasEntryFile) {
        const candidateEntry = path.isAbsolute(opts.entryFile)
            ? path.resolve(opts.entryFile)
            : path.resolve(realWorkspace, opts.entryFile);
        if (!fs.existsSync(candidateEntry)) {
            return errorEnvelope(
                'SANDBOX_ENTRY_NOT_FOUND',
                `Sandbox entryFile does not exist: ${opts.entryFile}`,
                null,
                safeTool
            );
        }
        const realEntry = fs.realpathSync(candidateEntry);
        if (realEntry !== realWorkspace && !realEntry.startsWith(realWorkspace + path.sep)) {
            return errorEnvelope(
                'SANDBOX_PATH_OUTSIDE_WORKSPACE',
                'entryFile resolves outside workspaceDir.',
                null,
                safeTool
            );
        }
        execArgs.push(realEntry);
        if (Array.isArray(opts.args)) {
            execArgs.push(...opts.args.map(String));
        }
    } else if (Array.isArray(opts.args)) {
        execArgs.push(...opts.args.map(String));
    }

    const cleanEnv = {
        PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
        CI: 'true',
        FORCE_COLOR: '0',
        NODE_NO_WARNINGS: '1',
    };
    if (opts.allowedEnv && typeof opts.allowedEnv === 'object') {
        for (const [k, v] of Object.entries(opts.allowedEnv)) {
            if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && v !== undefined && v !== null) {
                cleanEnv[k] = String(v);
            }
        }
    }

    const startMs = Date.now();
    try {
        const { stdout = '', stderr = '' } = await execFileAsync(process.execPath, execArgs, {
            cwd: realWorkspace,
            timeout: timeoutMs,
            killSignal: 'SIGKILL',
            maxBuffer: 2 * 1024 * 1024,
            env: cleanEnv,
        });

        let resultPayload = undefined;
        let cleanStdout = String(stdout);
        const markerIdx = cleanStdout.lastIndexOf(marker);
        if (markerIdx !== -1) {
            const afterMarker = cleanStdout.slice(markerIdx + marker.length);
            const newlineIdx = afterMarker.indexOf('\n');
            const jsonLine = (newlineIdx === -1 ? afterMarker : afterMarker.slice(0, newlineIdx)).trim();
            try {
                resultPayload = JSON.parse(jsonLine);
            } catch {
                resultPayload = undefined;
            }
            cleanStdout = cleanStdout.slice(0, markerIdx).trim();
        } else {
            cleanStdout = cleanStdout.trim();
        }

        return okEnvelope(safeTool, 'Node --permission sandbox execution succeeded.', {
            passed: true,
            exitCode: 0,
            timedOut: false,
            permissionDenied: false,
            sandboxType: 'node_permission',
            durationMs: Date.now() - startMs,
            stdout: cleanStdout,
            stderr: String(stderr || '').trim(),
            ...(resultPayload !== undefined ? { result: resultPayload } : {}),
        });
    } catch (err) {
        const durationMs = Date.now() - startMs;
        const timedOut = Boolean(err?.killed || err?.code === 'ETIMEDOUT');
        const rawStderr = String(err?.stderr || err?.message || '').trim();
        const rawStdout = String(err?.stdout || '').trim();
        const permissionDenied = /ERR_ACCESS_DENIED|Access to this API has been restricted/i.test(
            `${rawStderr}\n${rawStdout}`
        );

        return okEnvelope(
            safeTool,
            timedOut
                ? `Node --permission sandbox timed out after ${timeoutMs}ms.`
                : permissionDenied
                  ? 'Node --permission sandbox blocked unauthorized capability access.'
                  : 'Node --permission sandbox execution exited non-zero.',
            {
                passed: false,
                exitCode: typeof err?.code === 'number' ? err.code : -1,
                timedOut,
                permissionDenied,
                sandboxType: 'node_permission',
                durationMs,
                stdout: rawStdout,
                stderr: timedOut
                    ? `${rawStderr}\nSandbox timeout after ${timeoutMs}ms.`.trim()
                    : rawStderr,
            }
        );
    }
}
