import fs from 'fs';
import path from 'path';
import { chat } from '../llm.js';
import { addMemory } from './memory_controller.js';

export async function runOpenclawDistillation() {
    console.log("🧐 OpenClaw Distiller initiated: Parsing raw research logs...");
    
    // Read the OpenClaw research log
    const logPath = '/home/kruschdev/homelab/nodes/kruschgame/openclaw/state/research_log.md';
    let fileContent = '';
    try {
        fileContent = fs.readFileSync(logPath, 'utf-8');
    } catch (e) {
        console.error("❌ Failed to read OpenClaw research log:", e.message);
        return;
    }

    if (!fileContent || fileContent.trim().length === 0) {
        console.log("💤 Research log is empty.");
        return;
    }

    // Grab the last 20k characters to avoid blowing out context window
    const contextChunk = fileContent.length > 20000 
        ? fileContent.slice(-20000) 
        : fileContent;

    const config = { 
        provider: 'ollama', 
        apiUrl: 'http://10.0.0.144:11435/v1/chat/completions', 
        model: 'yi-coder:9b',
        format: 'json',
        maxTokens: 4096, 
        temperature: 0.3 // Low temp for extraction and distillation
    };

    console.log("🧠 Triggering Yi-Coder (9B) Pipeline for Research distillation...");

    const prompt = `You are a memory consolidation engine evaluating the extensive raw research log of the 'openclaw' autonomous agent.
Extract and distill the finalized architectural patterns, findings, or critical roadblocks into exactly TWO valid JSON arrays:
1. "medium_term" array: Strings defining the direct tactical instructions, proposed architectures (like DTG), or active problems. (Max 3 items)
2. "long_term" array: Strings defining the abstract, universal guiding rules, limits, or missing tools identified. (Max 2 items)

CRITICAL RULES:
1. Immediately output STRICTLY a JSON object.
2. NO markdown formatting, NO conversational text, NO markdown code blocks.

OUTPUT SCHEMA:
{
  "medium_term": ["...", "..."],
  "long_term": ["..."]
}`;

    try {
        console.log(`   [Distill] Querying Yi-Coder...`);
        let result = await chat(prompt, contextChunk, config);
        
        const match = result.match(/\{[\s\S]*\}/);
        
        if (match) {
            const parsed = JSON.parse(match[0]);
            
            // Write back to DB dynamically under 'openclaw'
            if (parsed.medium_term && Array.isArray(parsed.medium_term)) {
                for (const mem of parsed.medium_term) {
                    if (mem.trim().length > 5) {
                        console.log(`   [medium_term] ${mem}`);
                        await addMemory('openclaw', 'medium_term', mem);
                    }
                }
            }
            
            if (parsed.long_term && Array.isArray(parsed.long_term)) {
                for (const mem of parsed.long_term) {
                    if (mem.trim().length > 5) {
                        console.log(`   [long_term] ${mem}`);
                        await addMemory('openclaw', 'long_term', mem);
                    }
                }
            }
            
            console.log(`   [Success] Distilled OpenClaw research to Postgres.`);
        } else {
            console.warn(`   [Warning] Failed to extract valid JSON block from Yi-Coder.`);
            console.log('Model raw output:', result);
        }
    } catch (e) {
        console.error(`   [Error] Failed processing OpenClaw logs:`, e.message);
    }

    console.log("\n💤 OpenClaw Distiller pipeline finished.");
}

// Support direct CLI execution
if (process.argv[1] && process.argv[1].endsWith('openclaw_distiller.js')) {
    runOpenclawDistillation().catch(console.error);
}
