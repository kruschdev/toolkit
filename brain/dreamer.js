import { query } from '../edge/db-pg.js';
import { chat } from '../llm.js';
import { addMemory } from './memory_controller.js';

/**
 * Runs the background consolidation loop to translate short_term tape into medium/long_term.
 */
export async function runConsolidationLoop() {
    console.log("💤 Dreamer initiated: Consolidating short_term queues via Postgres...");
    
    let res;
    try {
        res = await query("SELECT id, persona_name, content FROM memories WHERE tier='short_term' ORDER BY created_at ASC");
    } catch (e) {
        console.log("💤 Dreamer aborted: Failed to query Postgres memories:", e.message);
        return;
    }

    if (!res || !res.rows || res.rows.length === 0) {
        console.log("💤 No short_term memories to dream about.");
        return;
    }
    
    // Group by persona to maintain strict segregation boundaries
    const personaGroups = {};
    for (const row of res.rows) {
        if (!personaGroups[row.persona_name]) {
            personaGroups[row.persona_name] = { ids: [], logs: [] };
        }
        personaGroups[row.persona_name].ids.push(row.id);
        personaGroups[row.persona_name].logs.push(row.content);
    }

    const config = { 
        provider: 'ollama', 
        apiUrl: 'http://10.0.0.144:11435/v1/chat/completions', 
        model: 'gemma4:e4b',
        format: 'json',
        maxTokens: 8192, 
        temperature: 0.6
    };

    console.log("🧠 Triggering Gemma 4 (E4B) Pipeline for Segregated distillation...");

    for (const [personaName, group] of Object.entries(personaGroups)) {
        console.log(`\n[\u25B6] Processing ${group.logs.length} logs for persona: ${personaName}`);
        
        const chunkContext = group.logs.map((log, i) => `[Mem-${i+1}] ${log}`).join("\n");
        const prompt = `You are a memory consolidation engine evaluating the short-term task logs of the '${personaName}' computing persona.
Extract and distill them into exactly TWO valid JSON arrays:
1. "medium_term" array: Strings for tactical context, bugs, or specific active state. (Max 3 items)
2. "long_term" array: Strings for abstract, universal guiding rules or constraints learned. (Max 2 items)

CRITICAL RULES:
1. Immediately output STRICTLY a JSON object.
2. NO markdown formatting, NO conversational text, NO markdown code blocks.

OUTPUT SCHEMA:
{
  "medium_term": ["...", "..."],
  "long_term": ["..."]
}`;


        try {
            console.log(`   [Distill] Querying Gemma for ${personaName}...`);
            let result = await chat(prompt, chunkContext, config);
            
            const match = result.match(/\{[\s\S]*\}/);
            
            if (match) {
                const parsed = JSON.parse(match[0]);
                
                // Write back to DB dynamically
                if (parsed.medium_term && Array.isArray(parsed.medium_term)) {
                    for (const mem of parsed.medium_term) {
                        if (mem.trim().length > 5) {
                            console.log(`   [medium_term] ${mem}`);
                            await addMemory(personaName, 'medium_term', mem);
                        }
                    }
                }
                
                if (parsed.long_term && Array.isArray(parsed.long_term)) {
                    for (const mem of parsed.long_term) {
                        if (mem.trim().length > 5) {
                            console.log(`   [long_term] ${mem}`);
                            await addMemory(personaName, 'long_term', mem);
                        }
                    }
                }
                
                // Securely flush the queue based on the specific IDs we just processed
                if (group.ids.length > 0) {
                    await query("DELETE FROM memories WHERE id = ANY($1::int[])", [group.ids]);
                    console.log(`   [Flush] Deleted ${group.ids.length} short_term logs for ${personaName}.`);
                }
            } else {
                console.warn(`   [Warning] Failed to extract valid JSON block for ${personaName}. Queue retained.`);
            }
        } catch (e) {
            console.error(`   [Error] Failed processing ${personaName}:`, e.message);
        }
    }

    console.log("\n💤 Dreamer pipeline finished.");
}

// Support direct CLI execution
if (process.argv[1] && process.argv[1].endsWith('dreamer.js')) {
    runConsolidationLoop().catch(console.error);
}
