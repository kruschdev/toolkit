import { query } from '../edge/db-pg.js';
import { chat, chatJson } from '../llm.js';
import { addMemory } from './memory_controller.js';

const OPENCLAW_CONFIG = { 
    provider: 'ollama', 
    apiUrl: process.env.OPENCLAW_URL || 'http://10.0.0.144:11435/v1/chat/completions', 
    model: 'yi-coder:9b',
    maxTokens: 4096, 
    temperature: 0.5 
};

const HERMES_CONFIG = {
    provider: 'ollama',
    apiUrl: process.env.HERMES_URL || 'http://10.0.0.144:11435/v1/chat/completions',
    model: process.env.HERMES_MODEL || 'llama3.1:8b',
    maxTokens: 4096,
    temperature: 0.7 
};

async function fetchRecentMemories() {
    console.log("📥 Fetching recent shared memories from Postgres...");
    try {
        const res = await query(`
            SELECT category as tier, content, created_at 
            FROM ide_agent_memory 
            WHERE category IN ('priorities', 'bugs', 'outcomes', 'lessons', 'activity')
            ORDER BY created_at DESC 
            LIMIT 60
        `);
        
        let memoryString = "--- RECENT HOMELAB MEMORY STATE ---\n";
        res.rows.forEach(row => {
            memoryString += `[${row.tier.toUpperCase()}] ${row.content}\n`;
        });
        return memoryString;
    } catch (e) {
        console.error("❌ Failed to query homelab-memory:", e.message);
        return "";
    }
}

export async function runMemoryOptimizationDebate() {
    console.log("🚀 Initializing Multi-Agent Memory Optimization Workflow...");
    
    const context = await fetchRecentMemories();
    if (!context || context.trim().length === 0) {
        console.log("💤 No memories found to optimize.");
        return;
    }

    console.log("\n💬 Starting Debate between OpenClaw and Hermes...");

    // 1. OPENCLAW Analysis (Architectural & Rules Focus)
    const openclawPrompt = `You are the OpenClaw Agent, a specialized architectural reasoning engine.
Analyze the provided episodic system memory (from our PostgreSQL knowledge graph), which contains software bugs, architectural priorities, and project outcomes from the homelab software stack. DO NOT refer to hardware RAM.
Identify exactly ONE major systemic software bottleneck, codebase inefficiency, or architectural flaw that needs optimization.
Provide a clear, tactical solution. Be concise and technical.`;

    let openclawArgument = "";
    try {
        console.log("   [OpenClaw] Analyzing architectural inefficiencies...");
        openclawArgument = await chat(openclawPrompt, `MEMORY STATE:\n${context}\n\nReview this state and provide your architectural analysis.`, OPENCLAW_CONFIG);
        console.log(`\n🦀 OPENCLAW PROPOSAL:\n${openclawArgument}\n`);
    } catch (e) {
        console.error("   [OpenClaw] Error:", e.message);
        openclawArgument = "[OpenClaw Offline]";
    }

    // 2. HERMES Analysis (Execution & Synthesis Focus)
    const hermesPrompt = `You are the Hermes Agent, an execution-focused reasoning engine.
Analyze the episodic system memory, ALONG WITH the proposal from the OpenClaw agent.
Your job is to bounce ideas off OpenClaw's proposal. Do you agree? What did OpenClaw miss?
Synthesize a concrete, unified optimization plan that combines both of your insights.

Provide a highly opinionated, direct response outlining the best path forward to optimize the system.`;

    let hermesArgument = "";
    try {
        console.log("   [Hermes] Bouncing ideas and synthesizing optimization plan...");
        hermesArgument = await chat(hermesPrompt, `MEMORY STATE:\n${context}\n\nOPENCLAW'S PROPOSAL:\n${openclawArgument}\n\nSynthesize and debate.`, HERMES_CONFIG);
        console.log(`\n🦅 HERMES SYNTHESIS:\n${hermesArgument}\n`);
    } catch (e) {
        console.error("   [Hermes] Error:", e.message);
        hermesArgument = "[Hermes Offline]";
    }

    // 3. Save the synthesis back to the Memory DB
    console.log("\n💾 Distilling final optimizations back to Postgres...");
    
    const distillPrompt = `Extract the core actionable optimization steps from the Hermes synthesis into a valid JSON array of strings. Maximum 3 steps.
HERMES SYNTHESIS:
${hermesArgument}

OUTPUT SCHEMA:
{
  "optimizations": ["step 1", "step 2"]
}`;

    try {
        const distillResult = await chat(distillPrompt, "Extract JSON.", OPENCLAW_CONFIG);
        const match = distillResult.match(/\{[\s\S]*\}/);
        if (match) {
            const parsed = JSON.parse(match[0]);
            if (parsed.optimizations && Array.isArray(parsed.optimizations)) {
                for (const opt of parsed.optimizations) {
                    console.log(`   + Writing insight: ${opt}`);
                    await addMemory('hivemind', 'lessons', `[Debate Optimization] ${opt}`);
                }
            }
            console.log("✅ Optimizations successfully committed to homelab-memory.");
        } else {
            console.warn("⚠️ Failed to parse final JSON extraction for memory storage.");
        }
    } catch (e) {
        console.error("❌ Failed to write optimizations back to DB:", e.message);
    }
}

// Support direct CLI execution
if (process.argv[1] && process.argv[1].endsWith('memory_optimizer.js')) {
    runMemoryOptimizationDebate().catch(console.error);
}
