/**
 * @module edge/error_memory
 * Self-Healing Error Pattern Memory
 * 
 * Stores error→resolution pairs from successful recoveries and
 * injects resolution hints when the same error signature recurs.
 * This eliminates blind "Oops Loop" retries by giving the swarm
 * institutional memory of past fixes.
 */

import { query } from './db-pg.js';

/**
 * Extract a stable signature from an error message.
 * Strips dynamic values (ports, PIDs, timestamps, paths) to match
 * semantically equivalent errors across different runs.
 * 
 * @param {string} errorMsg - Raw error message
 * @returns {string} Normalized signature
 */
export function extractSignature(errorMsg) {
    if (!errorMsg || typeof errorMsg !== 'string') return '';
    return errorMsg
        .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[.\dZ]*/g, '<TIMESTAMP>')
        .replace(/\b\d{1,5}\b(?=\s*(ms|s|seconds|port|pid))/gi, '<NUM>')
        .replace(/\/[\w\-/.]+\.\w+/g, '<PATH>')
        .replace(/[0-9a-f]{8,}/gi, '<HEX>')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 200);
}

/**
 * Look up a known resolution for an error signature.
 * 
 * @param {string} errorMsg - The raw error message
 * @param {string} [personaName] - Optional persona for scoped matching
 * @returns {Promise<{hint: string, timesApplied: number} | null>}
 */
export async function findResolution(errorMsg, personaName) {
    const sig = extractSignature(errorMsg);
    if (!sig) return null;

    try {
        // Try persona-specific match first, then global
        const result = await query(`
            SELECT resolution, times_applied FROM error_patterns
            WHERE error_signature = $1
            AND (persona_name = $2 OR persona_name IS NULL)
            ORDER BY persona_name IS NULL ASC, times_applied DESC
            LIMIT 1
        `, [sig, personaName || null]);
        
        if (result.rows.length > 0) {
            const { resolution, times_applied } = result.rows[0];

            // Dynamic slicing to prevent exhausting 3B worker VRAM context
            let safeHint = resolution;
            if (Array.isArray(safeHint)) {
                safeHint = safeHint.length > 3 ? safeHint.slice(0, 3).concat(['... (truncated)']) : safeHint;
            } else if (typeof safeHint === 'string' && safeHint.length > 250) {
                safeHint = safeHint.slice(0, 250) + '... (truncated)';
            } else if (typeof safeHint === 'object' && safeHint !== null) {
                safeHint = JSON.stringify(safeHint).slice(0, 250) + '...';
            }

            // Update last_seen and increment counter
            await query(`
                UPDATE error_patterns SET last_seen_at = CURRENT_TIMESTAMP, times_applied = times_applied + 1
                WHERE error_signature = $1 AND (persona_name = $2 OR persona_name IS NULL)
            `, [sig, personaName || null]);
            
            return { hint: safeHint, timesApplied: parseInt(times_applied) + 1 };
        }
    } catch (err) {
        console.warn(`[ErrorMemory] Lookup failed (non-fatal): ${err.message}`);
    }
    return null;
}

/**
 * Record a successful error→resolution pair.
 * Called after the swarm successfully recovers from an error.
 * 
 * @param {string} errorMsg - The original error message
 * @param {string} resolution - What fixed it (action taken)
 * @param {string} [personaName] - Persona that fixed it
 */
export async function recordResolution(errorMsg, resolution, personaName) {
    const sig = extractSignature(errorMsg);
    if (!sig || !resolution) return;

    let safeResolution = resolution;
    if (typeof safeResolution !== 'string') {
        if (Array.isArray(safeResolution) && safeResolution.length > 20) {
            safeResolution = safeResolution.slice(0, 20).concat([{ type: 'truncated_by_memory' }]);
        }
        safeResolution = JSON.stringify(safeResolution);
        if (safeResolution.length > 2500) safeResolution = safeResolution.slice(0, 2500) + '...';
    } else {
        safeResolution = safeResolution.slice(0, 2500);
    }
    
    try {
        await query(`
            INSERT INTO error_patterns (error_signature, persona_name, resolution)
            VALUES ($1, $2, $3)
            ON CONFLICT (error_signature, persona_name) DO UPDATE SET
                resolution = EXCLUDED.resolution,
                times_applied = error_patterns.times_applied + 1,
                last_seen_at = CURRENT_TIMESTAMP
        `, [sig, personaName || null, safeResolution]);
        
        console.log(`[ErrorMemory] Recorded resolution for: "${sig.slice(0, 60)}…"`);
    } catch (err) {
        console.warn(`[ErrorMemory] Record failed (non-fatal): ${err.message}`);
    }
}

/**
 * Extract a task-level signature for decomposition pattern matching.
 * Similar to extractSignature but focused on task descriptions rather
 * than error messages — strips file paths and numbers, keeps intent.
 * 
 * @param {string} taskDesc - Raw task description
 * @returns {string} Normalized task signature
 */
function extractTaskSignature(taskDesc) {
    if (!taskDesc || typeof taskDesc !== 'string') return '';
    return taskDesc
        .replace(/\/[\w\-/.]+/g, '<PATH>')
        .replace(/\b\d+\b/g, '<N>')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 300);
}

/**
 * Record a Flash-Lite intervention so the swarm learns the correct
 * decomposition pattern for future similar tasks.
 * 
 * @param {string} originalTask - The task description that failed locally
 * @param {Array} failedSteps - The DAG steps that the 3B workers couldn't handle
 * @param {string} flashResult - What Flash-Lite produced successfully
 * @param {Array} [learnedDecomp] - Optional corrected decomposition for future use
 */
export async function recordIntervention(originalTask, failedSteps, flashResult, learnedDecomp = null) {
    const sig = extractTaskSignature(originalTask);
    if (!sig) return;

    try {
        await query(`
            INSERT INTO intervention_patterns 
                (task_signature, failed_decomposition, successful_result, learned_decomposition)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT DO NOTHING
        `, [
            sig,
            JSON.stringify(failedSteps),
            typeof flashResult === 'string' ? flashResult.slice(0, 5000) : JSON.stringify(flashResult).slice(0, 5000),
            learnedDecomp ? JSON.stringify(learnedDecomp) : null
        ]);
        console.log(`[ErrorMemory] 🧠 Intervention recorded: "${sig.slice(0, 60)}…"`);
    } catch (err) {
        console.warn(`[ErrorMemory] Intervention record failed (non-fatal): ${err.message}`);
    }
}

/**
 * Search for a learned decomposition pattern matching the current task.
 * Returns a proven decomposition template if one exists from a prior
 * Flash-Lite intervention.
 * 
 * @param {string} taskDesc - Current task description
 * @returns {Promise<{decomposition: Array, timesReused: number} | null>}
 */
export async function findDecomposition(taskDesc) {
    const sig = extractTaskSignature(taskDesc);
    if (!sig) return null;

    try {
        const result = await query(`
            SELECT learned_decomposition, failed_decomposition, times_reused
            FROM intervention_patterns
            WHERE task_signature = $1
            AND (learned_decomposition IS NOT NULL OR failed_decomposition IS NOT NULL)
            ORDER BY times_reused DESC
            LIMIT 1
        `, [sig]);

        if (result.rows.length > 0) {
            const row = result.rows[0];
            const decomp = row.learned_decomposition || row.failed_decomposition;

            // Increment reuse counter
            await query(`
                UPDATE intervention_patterns SET times_reused = times_reused + 1
                WHERE task_signature = $1
            `, [sig]);

            console.log(`[ErrorMemory] 🧠 Found learned pattern for: "${sig.slice(0, 60)}…" (reused ${row.times_reused}x)`);
            return { decomposition: decomp, timesReused: parseInt(row.times_reused) + 1 };
        }
    } catch (err) {
        console.warn(`[ErrorMemory] Decomposition lookup failed (non-fatal): ${err.message}`);
    }
    return null;
}
