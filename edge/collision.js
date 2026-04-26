import { calculateShapleyValue } from './shapley.js';
import { COMPANY_FACTIONS, buildCompanyPrompt } from './factions.js';
import { chat } from '../llm.js';
import { loadTools } from './tools/index.js';

/** Lazy singleton — tools loaded once per process, reused across all grounding calls */
let _cachedTools = null;
async function getCachedTools() {
    if (!_cachedTools) _cachedTools = await loadTools();
    return _cachedTools;
}

/**
 * Maps faction IDs to their natural grounding tool and argument generator.
 * Each faction gets ONE tool call to verify its thesis with real data.
 * Marketing intentionally absent — penalized in Shapley for unverifiable claims.
 * @type {Record<string, { tool: string, buildArgs: (domainEvent: string) => object }>}
 */
const FACTION_TOOLS = {
    BACKEND: {
        tool: 'run_safe',
        buildArgs: () => ({ command: 'docker ps --format "{{.Names}} {{.Status}}"' })
    },
    LEGAL: {
        tool: 'search_rules',
        buildArgs: (domainEvent) => ({ query: domainEvent.slice(0, 200) })
    },
    FRONTEND: {
        tool: 'read_file',
        buildArgs: () => ({ path: '/home/kruschdev/homelab/.agent/priorities.md' })
    }
    // MARKETING: deliberately absent — no tools, Shapley penalizes ungrounded claims
};

/**
 * Executes a faction's natural tool to ground its thesis with real data.
 * Returns the tool execution result in Shapley-compatible format.
 * 
 * @param {string} factionKey - BACKEND, FRONTEND, LEGAL, or MARKETING
 * @param {string} domainEvent - The domain event driving the debate
 * @returns {Promise<Array<{tool: string, success: boolean, contextLength: number}>>}
 */
async function groundFactionThesis(factionKey, domainEvent) {
    const toolDef = FACTION_TOOLS[factionKey];
    if (!toolDef) return []; // No grounding tools (e.g. Marketing)

    const { executors } = await getCachedTools();
    const executor = executors.get(toolDef.tool);
    if (!executor) {
        console.warn(`[TLF:Ground] Tool '${toolDef.tool}' not found in registry — scoring as failed.`);
        return [{ tool: toolDef.tool, success: false, contextLength: 0 }];
    }

    const args = toolDef.buildArgs(domainEvent);
    const startTime = Date.now();

    try {
        const result = await Promise.race([
            executor(args, { isRemote: false, node: 'kruschdev' }),
            new Promise((_, rej) => setTimeout(() => rej(new Error('Grounding timeout')), 15_000))
        ]);

        const output = result.stdout || result.output || result.content || JSON.stringify(result);
        const contextLength = typeof output === 'string' ? output.length : 0;
        const elapsed = Date.now() - startTime;

        console.log(`[TLF:Ground] ${factionKey} → ${toolDef.tool} ✅ (${contextLength} bytes, ${elapsed}ms)`);
        return [{ tool: toolDef.tool, success: true, contextLength }];

    } catch (err) {
        console.warn(`[TLF:Ground] ${factionKey} → ${toolDef.tool} ❌ ${err.message}`);
        return [{ tool: toolDef.tool, success: false, contextLength: 0 }];
    }
}

/**
 * Executes a dialectical collision (debate) between specialized personas in a bounded context container.
 * Resolves autonomously when the mathematical Shapley consensus is met through an all-or-nothing phase transition.
 * 
 * @param {string} domainEvent - The overarching problem trigger
 * @param {Array<object>} agents - Participating Swarm nodes: [{ name: 'Creative', thesis: '...', tools: [...] }, ...]
 * @returns {Promise<object>} - The immutable ledger resolution
 */
export async function executeCollision(domainEvent, agents) {
    if (!agents || agents.length < 2) {
        throw new Error("Collision workspace requires at least 2 distinct agentic factions.");
    }

    console.log(`\n======================================================`);
    console.log(`[TLF] 💥 Collision Workspace Initialized`);
    console.log(`[TLF] Domain Event: ${domainEvent}`);
    console.log(`======================================================`);

    const scores = [];

    for (const agent of agents) {
        console.log(`\n[TLF] Assessing Factual Stake for: ${agent.name}...`);
        const score = await calculateShapleyValue(agent.name, agent.thesis, agent.tools);
        console.log(`[TLF] ${agent.name} Shapley Value: ${score}/100`);
        scores.push({ name: agent.name, thesis: agent.thesis, score, rawTools: agent.tools });
    }

    // Sort descending by Shapley Value
    scores.sort((a, b) => b.score - a.score);
    const champion = scores[0];
    const runnerUp = scores[1];

    let phaseTransition = false;
    // Phase transition threshold: Winner must have a 10-point lead or an overwhelmingly high absolute score
    if (champion.score - runnerUp.score > 10 || champion.score >= 75) {
        phaseTransition = true;
        console.log(`\n[TLF] ⚡ Phase Transition Triggered: Mathematical Consensus Met.`);
    } else {
         console.log(`\n[TLF] ⚠️ No distinct factual dominance. Falling back to Director tie-break.`);
         // In a full implementation, the Director 14B would be invoked here to mediate. We default to the highest score.
         phaseTransition = true;
    }

    if (phaseTransition) {
        console.log(`[TLF] 📜 Immutable Consensus Fused: ${champion.name} dominates the ledger.`);
    }

    return {
        resolvedState: champion.thesis,
        causalHistory: scores
    };
}

/**
 * Spawns a Company Team TLF debate container by generating parallel API theses
 * with real DOE tool grounding.
 * 
 * Each faction:
 * 1. Generates a thesis via Gemini Flash Lite (parallel API calls)
 * 2. Executes its natural grounding tool via DOE dispatch (parallel, real data)
 * 3. Feeds real tool results into Shapley scoring for mathematically meaningful consensus
 * 
 * @param {string} domainEvent 
 * @returns {Promise<object>} The mathematically resolved ledger
 */
export async function spawnCompanyDebate(domainEvent) {
    console.log(`\n[TLF] 🧬 Spawning Enterprise Flash-Lite Swarm Factions...`);
    
    // Rapid API configuration relying on Google's high-speed edge inferencing
    const debateConfig = {
        provider: 'gemini',
        model: 'gemini-2.5-flash-lite',
        apiKey: process.env.GEMINI_API_KEY,
        maxTokens: 300,
        temperature: 0.4 // Small drift to create varying hostile solutions
    };

    const factionKeys = Object.keys(COMPANY_FACTIONS);
    const agents = [];

    // Phase 1: Generate theses + ground with real tools (all parallel per faction)
    const generationPromises = factionKeys.map(async (key) => {
        const faction = COMPANY_FACTIONS[key];
        const prompt = buildCompanyPrompt(domainEvent, faction);
        
        try {
            // Parallel: generate thesis AND execute grounding tool simultaneously
            const [thesis, toolResults] = await Promise.all([
                (async () => {
                    console.log(`[TLF] 🧬 Querying API Worker: ${faction.name}...`);
                    return await chat(prompt, domainEvent, debateConfig);
                })(),
                groundFactionThesis(key, domainEvent)
            ]);
            
            // Allow specialists to automatically drop out if irrelevant ("ABSTAIN")
            if (thesis && thesis.includes('[ABSTAIN]')) {
                 console.log(`[TLF] 🚫 ${faction.name} abstained (Irrelevant domain).`);
                 return;
            }

            agents.push({
                name: faction.name,
                thesis: thesis,
                tools: toolResults
            });

        } catch (e) {
            console.error(`❌ [TLF] Failed to generate argument for ${faction.name}:`, e.message);
        }
    });

    await Promise.all(generationPromises);

    if (agents.length < 2) {
        throw new Error("Swarm failed to populate sufficient Boardroom factions for collision.");
    }

    return await executeCollision(domainEvent, agents);
}

