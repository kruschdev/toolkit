import pg from 'pg';

const { Pool } = pg;

// Chrysalis Postgres instance running on kruschserv (:5434)
const pool = new Pool({
    host: 'kruschserv',
    port: 5434,
    user: 'openclaw',
    password: process.env.OPENCLAW_PG_PASSWORD || 'openclaw_password',
    database: 'kruschdb',
    max: 5,                  // Prevent pool exhaustion during parallel dispatch
    idleTimeoutMillis: 10000 // Release idle connections quickly
});

/** Initialize intervention_patterns table for the learning loop */
async function initSchema() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS intervention_patterns (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                task_signature TEXT NOT NULL,
                failed_decomposition JSONB,
                successful_result TEXT,
                learned_decomposition JSONB,
                times_reused INT DEFAULT 0,
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        await pool.query(`CREATE EXTENSION IF NOT EXISTS vector`);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS project_locations (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                project_name TEXT UNIQUE NOT NULL,
                absolute_path TEXT NOT NULL,
                context_description TEXT NOT NULL,
                embedding vector(768)
            );

            CREATE TABLE IF NOT EXISTS error_patterns (
                error_signature TEXT NOT NULL,
                persona_name TEXT,
                resolution TEXT NOT NULL,
                times_applied INT DEFAULT 1,
                last_seen_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            );

            -- Ensure unique constraint exists for the ON CONFLICT clause in error_memory.js
            -- Use 'NULLS NOT DISTINCT' if running PG15+, otherwise standard UNIQUE. 
            DO $$ BEGIN
                IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'idx_unique_err_persona') THEN
                    ALTER TABLE error_patterns ADD CONSTRAINT idx_unique_err_persona UNIQUE (error_signature, persona_name);
                END IF;
            END $$;

            CREATE TABLE IF NOT EXISTS execution_logs (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                session_id TEXT NOT NULL,
                persona_name TEXT NOT NULL,
                action TEXT,
                result TEXT,
                execution_time_ms INT DEFAULT 0,
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS ide_agent_memory (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                category TEXT NOT NULL,
                content TEXT NOT NULL,
                embedding vector(768),
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            );
        `);
    } catch (e) {
        // Non-fatal — table may already exist or PG may be down
        if (!e.message.includes('already exists')) {
            console.warn(`[DB] Schema init warning: ${e.message}`);
        }
    }
}
initSchema();

export async function query(text, params) {
    const client = await pool.connect();
    try {
        const res = await client.query(text, params);
        return res;
    } finally {
        client.release();
    }
}

/**
 * Log an execution interaction to the database for correlation tracking.
 */
export async function logExecution(sessionId, personaName, action, result, executionTimeMs = 0) {
    if (typeof result === 'object') {
        result = JSON.stringify(result);
    }
    const sql = `
        INSERT INTO execution_logs (session_id, persona_name, action, result, execution_time_ms)
        VALUES ($1, $2, $3, $4, $5)
    `;
    await query(sql, [sessionId, personaName, action, result, executionTimeMs]);
}

/**
 * Generate a 768-dimensional vector embedding for semantic search.
 * We default to Gemini text-embedding-004 if available, 
 * otherwise fallback to Ollama nomic-embed-text.
 */
export async function embedText(text) {
    if (process.env.GEMINI_API_KEY) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${process.env.GEMINI_API_KEY}`;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'models/gemini-embedding-001',
                outputDimensionality: 768,
                content: { parts: [{ text }] }
            })
        });
        if (!res.ok) throw new Error(`Gemini Embedding Error: ${await res.text()}`);
        const data = await res.json();
        return JSON.stringify(data.embedding.values);
    } else {
        // Fallback to local Ollama (assumes nomic-embed-text is pulled)
        // Dedicated to GTX 970 via edge-worker on kruschserv Port 11434
        const res = await fetch('http://kruschserv:11434/api/embeddings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'nomic-embed-text',
                prompt: text
            })
        });
        if (!res.ok) throw new Error(`Ollama Embedding Error: ${await res.text()}`);
        const data = await res.json();
        return JSON.stringify(data.embedding);
    }
}

/**
 * Lookup the closest project location by semantic vector similarity.
 */
export async function findProjectLocation(taskVector, threshold = 0.8) {
    if (!taskVector) return null;
    let vectorJson = taskVector;
    if (typeof taskVector === 'string') {
        try { vectorJson = JSON.parse(taskVector); } catch(e) {}
    }
    if (!Array.isArray(vectorJson)) return null;
    
    try {
        const sql = `
            SELECT project_name, absolute_path, context_description, 1 - (embedding <=> $1::vector) as similarity
            FROM project_locations
            ORDER BY embedding <=> $1::vector
            LIMIT 1
        `;
        const formattedVector = JSON.stringify(vectorJson);
        const res = await query(sql, [formattedVector]);
        if (res.rows.length > 0 && res.rows[0].similarity >= threshold) {
            return res.rows[0];
        }
    } catch (e) {
        // Suppress on missing table if not yet initialized
        if (!e.message.includes('relation "project_locations" does not exist')) {
            console.warn(`[Location RAG] Failed to query locations: ${e.message}`);
        }
    }
    return null;
}
