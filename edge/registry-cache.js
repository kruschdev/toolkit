/**
 * @module registry-cache
 * SQLite write-through cache for the persona registry.
 * Mirrors Postgres persona data to a local SQLite DB so the swarm
 * can still operate when Postgres is unreachable.
 */
import { initDb, query as sqliteQuery, run } from '../db.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'registry-cache.db');

let _initialized = false;

async function ensureDb() {
    if (_initialized) return;
    await initDb(DB_PATH);
    await run(`CREATE TABLE IF NOT EXISTS personas_cache (
        name TEXT PRIMARY KEY,
        base TEXT,
        node TEXT,
        skill TEXT,
        project TEXT,
        is_synthetic INTEGER DEFAULT 0,
        cached_at INTEGER DEFAULT (unixepoch())
    )`, [], DB_PATH);
    _initialized = true;
}

/**
 * Write-through: cache Postgres persona rows into local SQLite.
 * Called on every successful Postgres read.
 * @param {Array<object>} rows - Persona rows from Postgres
 */
export async function cachePersonas(rows) {
    try {
        await ensureDb();
        for (const row of rows) {
            await run(
                `INSERT OR REPLACE INTO personas_cache (name, base, node, skill, project, is_synthetic, cached_at)
                 VALUES (?, ?, ?, ?, ?, ?, unixepoch())`,
                [row.name, row.base, row.node, row.skill, row.project, row.is_synthetic ? 1 : 0],
                DB_PATH
            );
        }
        console.log(`[Registry Cache] Wrote ${rows.length} personas to SQLite.`);
    } catch (err) {
        console.warn(`[Registry Cache] Write-through failed: ${err.message}`);
    }
}

/**
 * Fallback read: load personas from SQLite when Postgres is unreachable.
 * No vector search — returns all cached personas.
 * @returns {Promise<Map<string, object>>} Persona registry map
 */
export async function loadCachedPersonas() {
    const registry = new Map();
    try {
        await ensureDb();
        const rows = await sqliteQuery(
            `SELECT name, base, node, skill, project, is_synthetic FROM personas_cache ORDER BY cached_at DESC`,
            [],
            DB_PATH
        );
        for (const row of rows) {
            registry.set(row.name, {
                name: row.name,
                base: row.base,
                node: row.node,
                skill: row.skill,
                project: row.project,
                is_synthetic: !!row.is_synthetic
            });
        }
        if (registry.size > 0) {
            console.log(`[Registry Cache] Loaded ${registry.size} personas from SQLite fallback.`);
        } else {
            console.warn(`[Registry Cache] SQLite cache is empty — no fallback data available.`);
        }
    } catch (err) {
        console.error(`[Registry Cache] SQLite read failed: ${err.message}`);
    }
    return registry;
}
