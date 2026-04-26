import { query } from '../edge/db-pg.js';
import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { hiveMind } from './hive_mind.js';

function writeToProjectDb(domain, persona, type, memoryString) {
    const dbPath = join('/home/kruschdev/homelab/projects', domain, '.agent', 'memory.db');
    mkdirSync(dirname(dbPath), { recursive: true });

    const db = new Database(dbPath, { timeout: 5000 });
    try {
        db.pragma('journal_mode = WAL');
        
        db.exec(`
            CREATE TABLE IF NOT EXISTS project_memories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                persona_name TEXT NOT NULL,
                tier TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        db.prepare('INSERT INTO project_memories (persona_name, tier, content) VALUES (?, ?, ?)').run(persona, type, memoryString);
        
        const limits = { short_term: 10, medium_term: 20, outcome: 30, decision: 50, tape: 5 };
        if (limits[type]) {
            db.prepare(`
                DELETE FROM project_memories 
                WHERE id IN (
                    SELECT id FROM project_memories 
                    WHERE persona_name=? AND tier=? 
                    ORDER BY created_at DESC LIMIT -1 OFFSET ?
                )
            `).run(persona, type, limits[type]);
        }
    } finally {
        db.close();
    }
}

/**
 * Loads the structured memory arrays from Postgres for all personas.
 * @returns {Promise<Object>} An object containing short, medium, and long term memories keyed by persona.
 */
export async function loadPersonaMemory() {
    try {
        const res = await query('SELECT persona_name, tier, content FROM memories ORDER BY created_at ASC');
        const memoryMap = {};

        for (const row of res.rows) {
            const p = row.persona_name.toLowerCase();
            const t = row.tier;
            
            if (!memoryMap[p]) {
                memoryMap[p] = { short_term: [], medium_term: [], long_term: [], scratchpad: [], outcome: [], decision: [], tape: [] };
            }
            if (!memoryMap[p][t]) {
                memoryMap[p][t] = [];
            }
            
            memoryMap[p][t].push(row.content);
        }
        return memoryMap;
    } catch (err) {
        console.error(`Failed to load persona memory from PG: ${err.message}`);
        return {};
    }
}

/**
 * Specifically loads the shared Project Hive Mind scratchpad and successful DAG execution tapes.
 */
export async function getProjectScratchpad(domain) {
    try {
        const res = await query(
            'SELECT tier, content FROM memories WHERE persona_name = $1 AND (tier = $2 OR tier = $3) ORDER BY created_at ASC',
            ['project_hive', 'scratchpad', 'tape']
        );
        return res.rows.map(r => r.content);
    } catch(err) {
        return [];
    }
}

/**
 * Injects a new memory string into a persona's tier in Postgres.
 * Maintains archival caps dynamically.
 * @param {string} persona The target persona (e.g., 'auditor', 'python-expert').
 * @param {string} type The memory tier ('short_term', 'medium_term', 'long_term', 'scratchpad').
 * @param {string} memoryString The insight/memory content to learn.
 */
export async function addMemory(persona, type, memoryString, domainOverride = null) {
    // Backend compatibility alias
    if (type === 'episodic') type = 'short_term';
    if (type === 'semantic') type = 'long_term';

    if (!['short_term', 'medium_term', 'long_term', 'scratchpad', 'outcome', 'decision', 'tape'].includes(type)) {
        throw new Error("Memory type must be 'short_term', 'medium_term', 'long_term', 'scratchpad', 'outcome', 'decision', or 'tape'");
    }
    const cleanPersona = persona.toLowerCase();

    try {
        // [Hive Mind] Send context to the 970 VRAM instantly (non-blocking)
        hiveMind.addContext(cleanPersona, `Tier: ${type} | ${memoryString}`).catch(e => console.error(e));

        // Ensure the persona exists in the foreign table 'personas' so the cascade holds.
        // We'll lazily insert a generic synthetic persona if it doesn't exist yet so memory insertion doesn't fail.
        await query(`
            INSERT INTO personas (name, project_domain, is_synthetic, skill, base_model, node) 
            VALUES ($1, 'global', true, 'Synthetic memory holder', 'qwen2.5-coder:1.5b', 'kruschgame') 
            ON CONFLICT (name) DO NOTHING
        `, [cleanPersona]);

        await query(
            'INSERT INTO memories (persona_name, tier, content) VALUES ($1, $2, $3)',
            [cleanPersona, type, memoryString]
        );

        let domain = domainOverride;
        if (!domain) {
            // Fetch the active project domain for dual-path SQLite sync
            const personaRes = await query('SELECT project_domain FROM personas WHERE name = $1', [cleanPersona]);
            domain = personaRes.rows[0]?.project_domain || 'global';
        }

        if (domain !== 'global' && domain !== 'toolkit' && domain !== 'governance') {
            try {
                writeToProjectDb(domain, persona, type, memoryString);
            } catch(e) {
                console.warn(`[Dual-Path Sync] Failed to write to project DB for ${domain}:`, e.message);
            }
        }

        // Enforce per-tier row caps to prevent context bloat
        const CAP_LIMITS = { short_term: 10, medium_term: 20, outcome: 30, decision: 50, tape: 5 };
        const cap = CAP_LIMITS[type];
        if (cap) {
            await query(`
                DELETE FROM memories 
                WHERE id IN (
                    SELECT id FROM memories WHERE persona_name=$1 AND tier=$2 
                    ORDER BY created_at DESC OFFSET $3
                )
            `, [cleanPersona, type, cap]);
        }

        return true;
    } catch (err) {
        console.error(`❌ Failed to add ${type} memory to ${persona}:`, err.message);
        throw err;
    }
}

/**
 * [TLF] Immutable Topic Ledger Fusion
 * Writes the final resolved consensus and its entire debate chain of thought into the execution_logs.
 * 
 * @param {string} domainEvent - The overarching problem trigger
 * @param {string} resolvedState - The winning thesis
 * @param {Array<object>} causalHistory - Full Shapley scoring matrix and tool invocations
 */
export async function addDebateLedger(domainEvent, resolvedState, causalHistory) {
    try {
        const memoryString = JSON.stringify({
           event: domainEvent,
           resolution: resolvedState,
           history: causalHistory
        });
        
        await query(
            'INSERT INTO execution_logs (session_id, persona_name, action, result, execution_time_ms) VALUES ($1, $2, $3, $4, $5)',
            ['TLF-COLLISION', 'SYSTEM_LEDGER', 'Immutable Decision Fusion', memoryString, 0]
        );
        return true;
    } catch (e) {
        console.error(`❌ [TLF] Failed to fuse immutable ledger:`, e.message);
        throw e;
    }
}

/**
 * Directly queries the 970 GPU Hive Mind for fast VRAM semantic retrieval,
 * bypassing PostgreSQL entirely for warm state.
 */
export async function askHiveMind(question, contextHints = "") {
    return await hiveMind.queryContext(question, contextHints);
}
