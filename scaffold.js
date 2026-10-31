/**
 * @module @krusch/toolkit/scaffold
 * Deterministic zero-LLM project scaffolder powered by the Lego Archetype Catalog (`./catalog.js`).
 *
 * Enforces INV-LEGO-01 & INV-LEGO-04:
 * - Renders standardized Node 22 ESM, MCP stdio, React/Vite, and Python 3.12 FastAPI blueprints
 * - Supports `dryRun: true` file planning without touching disk
 * - Returns `{ ok: true, tool: 'scaffoldProject', summary, data }` envelopes
 */

import fs from 'node:fs';
import path from 'node:path';
import { getArchetype, listArchetypes } from './catalog.js';

/**
 * Stamp a canonical project layout inside `targetDir` using a frozen archetype blueprint.
 *
 * @param {string} [targetDir=process.cwd()] - Target directory to scaffold.
 * @param {object} [options={}] - Scaffolding options.
 * @param {string} [options.archetype='node-api-sqlite'] - Archetype identifier from `PROJECT_ARCHETYPES`.
 * @param {string} [options.projectName=''] - Override project name (defaults to basename of `targetDir`).
 * @param {number} [options.port=3000] - Service HTTP port to bind in generated configs.
 * @param {boolean} [options.force=false] - Overwrite existing files if true.
 * @param {boolean} [options.dryRun=false] - Compute created/skipped manifests without writing to disk.
 * @param {boolean} [options.quiet=false] - Suppress console progress output.
 * @returns {Promise<{
 *   ok: boolean,
 *   tool: string,
 *   summary: string,
 *   data: {
 *     archetype: string,
 *     projectName: string,
 *     port: number,
 *     targetDir: string,
 *     createdFiles: string[],
 *     skippedFiles: string[]
 *   }
 * }>}
 */
export async function scaffoldProject(
    targetDir = process.cwd(),
    {
        archetype = 'node-api-sqlite',
        projectName = '',
        port = 3000,
        force = false,
        dryRun = false,
        quiet = false
    } = {}
) {
    const blueprint = getArchetype(archetype);
    if (!blueprint) {
        const validIds = listArchetypes()
            .map((entry) => entry.id)
            .join(', ');
        throw new Error(
            `Unknown project archetype "${archetype}". Valid archetype IDs: ${validIds}`
        );
    }

    const resolvedDir = path.resolve(targetDir);
    const resolvedProjectName =
        (typeof projectName === 'string' && projectName.trim()) || path.basename(resolvedDir);
    const parsedPort = Number(port);
    const resolvedPort =
        Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535 ? parsedPort : 3000;

    if (!quiet) {
        const modePrefix = dryRun ? '[DRY-RUN] Planning' : 'Scaffolding';
        console.log(
            `${modePrefix} [${blueprint.id}] project "${resolvedProjectName}" in ${resolvedDir} (port=${resolvedPort})...`
        );
    }

    const renderedFiles = blueprint.renderFiles({
        projectName: resolvedProjectName,
        port: resolvedPort
    });

    const createdFiles = [];
    const skippedFiles = [];

    for (const [subpath, rawContent] of Object.entries(renderedFiles)) {
        const normalizedSubpath = subpath.replace(/\\/g, '/').replace(/^\/+/, '');
        const fullPath = path.resolve(resolvedDir, normalizedSubpath);
        if (fullPath !== resolvedDir && !fullPath.startsWith(resolvedDir + path.sep)) {
            throw new Error(`Unsafe template subpath outside target directory: "${subpath}"`);
        }

        const alreadyExists = fs.existsSync(fullPath);
        if (alreadyExists && !force) {
            skippedFiles.push(normalizedSubpath);
            if (!quiet) {
                console.log(`   Skipping existing file: ${normalizedSubpath}`);
            }
            continue;
        }

        if (!dryRun) {
            fs.mkdirSync(path.dirname(fullPath), { recursive: true });
            const text = String(rawContent ?? '');
            const formatted = text.endsWith('\n') ? text : `${text}\n`;
            fs.writeFileSync(fullPath, formatted, 'utf-8');
            if (normalizedSubpath === 'src/index.js' && formatted.startsWith('#!')) {
                fs.chmodSync(fullPath, 0o755);
            }
        }

        createdFiles.push(normalizedSubpath);
        if (!quiet) {
            console.log(`   ${dryRun ? 'Would create' : 'Created'}: ${normalizedSubpath}`);
        }
    }

    const actionVerb = dryRun ? 'Dry-run planned' : 'Scaffolded';
    const summary = `${actionVerb} ${blueprint.id} project "${resolvedProjectName}" (${createdFiles.length} created, ${skippedFiles.length} skipped)`;

    if (!quiet) {
        console.log(`${summary}`);
    }

    return {
        ok: true,
        tool: 'scaffoldProject',
        summary,
        data: {
            archetype: blueprint.id,
            projectName: resolvedProjectName,
            port: resolvedPort,
            targetDir: resolvedDir,
            createdFiles,
            skippedFiles
        }
    };
}
