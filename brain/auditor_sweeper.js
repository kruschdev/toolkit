import { query } from '../edge/db-pg.js';
import { chatJson } from '../llm.js';
import { envOr } from '../config.js';

/**
 * Overnight CPU Hive Mind Auditor
 * Scans the Postgres memories table for all tier='tape' DAG executions.
 * Evaluates them using the 32B CPU Model.
 * Deletes hallucinated or structurally incoherent tapes to prevent memory poisoning.
 */
export async function runAuditorSweep() {
    console.log("🛡️ Hive Mind Auditor initiated: Scanning for bad DAG execution tapes...");
    
    let res;
    try {
        res = await query("SELECT id, persona_name, content FROM memories WHERE tier='tape' ORDER BY created_at ASC");
    } catch (e) {
        console.log("🛡️ Hive Mind Auditor aborted: Failed to query Postgres tapes:", e.message);
        return;
    }

    if (!res || !res.rows || res.rows.length === 0) {
        console.log("🛡️ No DAG tapes to audit.");
        return;
    }
    
    // Load balancer for 32B CPU inference (defaulting to kruschdev and kruschgame Tailscale/Local)
    const cpuPlanners = 'http://127.0.0.1:11436/v1/chat/completions,http://10.0.0.19:11434/v1/chat/completions';
    const urls = cpuPlanners.split(',');
    
    console.log(`🛡️ Found ${res.rows.length} execution tapes. Beginning CPU analysis...`);

    let rejectedCount = 0;
    
    for (const row of res.rows) {
        const lbUrl = urls[Math.floor(Math.random() * urls.length)].trim();
        const is14bNode = lbUrl.includes('10.0.0.19') || lbUrl.includes('10.0.0.228') || lbUrl.includes('10.0.0.183');
        const defaultModel = is14bNode ? 'qwen2.5-coder:14b' : 'qwen2.5-coder:32b';
        
        const config = { 
            provider: 'ollama', 
            apiUrl: lbUrl, 
            model: envOr('CHRYSALIS_AUDITOR_MODEL', null, defaultModel),
            format: 'json',
            maxTokens: 500, // Small response since we just need the JSON decision
            temperature: 0.1
        };

        const prompt = `You are the Hive Mind Immune System (Auditor Persona).
Read the stringified JSON payload below containing a cached Directed Acyclic Graph (DAG) of code execution steps.
Determine if the execution tape is hallucinated, fundamentally broken (e.g. inventing random files or circular dependencies without writing them), or if it is logically sound and safe to keep in memory.

CRITICAL RULES:
1. Output STRICTLY JSON. NO markdown blocks or conversational text.
2. Ensure you ONLY use this schema:
{
  "status": "KEEP" or "DELETE",
  "reason": "1-sentence tactical explanation of why it is kept or purged."
}`;

        console.log(`\n  [\xA0] Auditing tape ID ${row.id} for ${row.persona_name} (Using ${lbUrl})...`);
        
        try {
            const resultJSON = await chatJson(prompt, `TAPE CONTENT:\n${row.content}`, config);
            
            if (resultJSON.status === 'DELETE') {
                console.log(`  ❌ REJECTED: ${resultJSON.reason}`);
                await query("DELETE FROM memories WHERE id = $1", [row.id]);
                console.log(`     [Flush] Deleted hallucinated tape ID ${row.id} from Postgres.`);
                rejectedCount++;
            } else {
                console.log(`  ✅ APPROVED: ${resultJSON.reason || 'Logically sound.'}`);
            }
        } catch (e) {
            console.error(`  ⚠️ [Error] Failed to audit tape ID ${row.id}:`, e.message);
        }
    }

    console.log(`\n🛡️ Hive Mind Auditor finished. Purged ${rejectedCount} bad DAG tapes.`);
}

/**
 * 72-Hour Garbage Collection for Synthetic Personas
 * Connects to edge nodes to un-register Ollama models and clear PG vector state.
 */
export async function runPersonaGarbageCollection() {
    console.log("\n🧹 Persona Garbage Collector initiated: Sweeping unused synthetic personas (72h)...");
    
    const queryStr = `
        SELECT p.name, p.node 
        FROM personas p
        LEFT JOIN execution_logs e ON p.name = e.persona_name
        WHERE p.is_synthetic = true 
        GROUP BY p.name, p.node
        HAVING MAX(e.created_at) < NOW() - INTERVAL '3 days' OR MAX(e.created_at) IS NULL
    `;
    
    let res;
    try {
        res = await query(queryStr);
    } catch (e) {
        console.log("🧹 Persona GC aborted: Failed to query Postgres:", e.message);
        return;
    }

    if (!res || !res.rows || res.rows.length === 0) {
        console.log("🧹 No dormant synthetic personas to delete.");
        return;
    }

    console.log(`🧹 Found ${res.rows.length} dormant synthetic personas. Un-registering...`);

    let purgedCount = 0;
    for (const row of res.rows) {
        const nodeMap = {
            'kruschgame': '10.0.0.19',
            'kruschdev_worker': '127.0.0.1',
            'krmac13': '10.0.0.228',
            'kr1yoga': '10.0.0.183'
        };
        const targetIp = nodeMap[row.node] || '127.0.0.1';
        const port = row.node === 'kruschdev_director' ? 11435 : 11434;

        try {
            console.log(`  [🗑️] Deleting persona model '${row.name}' from ${row.node} (${targetIp}:${port})...`);
            // Node 18+ native fetch
            const delRes = await fetch(`http://${targetIp}:${port}/api/delete`, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: row.name })
            });

            if (delRes.ok || delRes.status === 404) {
                await query("DELETE FROM personas WHERE name = $1", [row.name]);
                console.log(`     [Flush] Purged record for '${row.name}' from registry.`);
                purgedCount++;
            } else {
                console.warn(`     [Error] Ollama daemon returned ${delRes.status}: ${await delRes.text()}`);
            }
        } catch (e) {
            console.error(`  ⚠️ [Error] Network failure un-registering '${row.name}':`, e.message);
        }
    }

    console.log(`\n🧹 Persona GC finished. Purged ${purgedCount} dormant personas.`);
}

// Support direct CLI execution
if (process.argv[1] && process.argv[1].endsWith('auditor_sweeper.js')) {
    (async () => {
        await runAuditorSweep().catch(console.error);
        await runPersonaGarbageCollection().catch(console.error);
    })();
}

