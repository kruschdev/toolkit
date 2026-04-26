import { chat } from '../llm.js';
import { query } from '../edge/db-pg.js';

/**
 * [TLF] Quantum Retrodiction Module (Bayesian History Scanner)
 * Scans the Immutable Topic Ledger (execution_logs) to find historically failed swarm executions.
 * If the current Domain Event strongly aligns with a past failure's initial conditions, it returns 
 * a proactive warning before compute power is squandered.
 * 
 * @param {string} domainEvent - The current triggers or tasks being evaluated by the Swarm
 * @returns {Promise<string|null>} - A stark warning string to the human orchestrator, or null if safe.
 */
export async function runRetrodictionCheck(domainEvent) {
    console.log(`\n[TLF:Retrodiction] Scanning permanent ledger for historical Bayesian failure patterns...`);
    
    try {
        // Fetch known failure loops or deeply stalled events from the ledger
        // We look for 'Immutable Decision Fusion' that contained errors or naive tie-breaks
        const res = await query(`
            SELECT id, result, created_at 
            FROM execution_logs 
            WHERE persona_name = 'SYSTEM_LEDGER' 
            AND action = 'Immutable Decision Fusion'
            AND result::text ILIKE '%error%'
            ORDER BY created_at DESC 
            LIMIT 5
        `);

        if (res.rowCount === 0) {
            console.log(`[TLF:Retrodiction] No historical failure patterns detected. Safe to compute.`);
            return null; // Safe to proceed
        }

        const failureContexts = res.rows.map(r => `Ledger ID ${r.id}: ${r.result.substring(0, 1000)}`).join('\n\n');

        const systemPrompt = `You are the TLF Retrodiction Scanner. 
Your goal is to perform Bayesian pattern matching between the current "Domain Event" and the historical failure contexts provided.
If the current Domain Event is highly likely to reproduce the same failure (due to missing data, locked API, cyclic logic), return a SHORT, stark warning explaining exactly what is doomed to repeat.
If there is no direct correlation to past failures, return EXACTLY the string: SAFE`;

        const config = {
            provider: 'gemini',
            model: 'gemini-2.5-flash-lite',
            apiKey: process.env.GEMINI_API_KEY,
            maxTokens: 250,
            temperature: 0.2
        };

        const promptPayload = `Current Domain Event to Process: "${domainEvent}"\n\n=== Historical Failed Ledgers ===\n${failureContexts}`;
        const assessment = await chat(systemPrompt, promptPayload, config);

        if (assessment.trim().toUpperCase() === 'SAFE') {
            console.log(`[TLF:Retrodiction] Assessment: SAFE`);
            return null;
        }

        console.warn(`\n[TLF:Retrodiction] ⚠️ PROACTIVE WARNING TRIGGERED ⚠️\n${assessment}\n`);
        return assessment;

    } catch (e) {
        console.error(`❌ [TLF:Retrodiction] Failed to perform scan: ${e.message}`);
        return null; // Fail open to not block execution
    }
}
