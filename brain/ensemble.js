/**
 * @module ensemble
 * Sociocognitive Ensemble — manages "Internal Monologue" between specialized AI identities.
 * Brain3 CONSENSUS LAYER — returns debate results only. Execution flows through DOE.
 */

import { chat, chatJson } from '../llm.js';
import { loadProjectConfig } from '../config.js';
import { addMemory } from './memory_controller.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const PERSONALITIES = {
    AUDITOR: {
        name: 'The Auditor (Type 1)',
        role: 'Focuses on perfection, standards, and rule adherence. Prevents technical debt.',
        focus: 'code style, linting, rules, security'
    },
    INVESTIGATOR: {
        name: 'The Investigator (Type 5)',
        role: 'Focuses on deep technical understanding, documentation, and edge cases.',
        focus: 'docs, rare bugs, complex logic, dependencies'
    },
    CHALLENGER: {
        name: 'The Challenger (Type 8)',
        role: 'Focuses on decisive action, efficiency, and project velocity. Prevents over-engineering.',
        focus: 'deployment, performance, simplification, ROI'
    }
};

export const LOCAL_LOBES = {
    AUDITOR: {
        provider: 'ollama',
        apiUrl: process.env.OLLAMA_AUDITOR_URL || 'http://10.0.0.183:11434/v1/chat/completions',
        model: 'qwen2.5-coder:14b'
    },
    CHALLENGER: {
        provider: 'ollama',
        apiUrl: process.env.OLLAMA_CHALLENGER_URL || 'http://10.0.0.19:11434/v1/chat/completions',
        model: 'qwen2.5-coder:3b'
    },
    INVESTIGATOR: {
        provider: 'ollama',
        apiUrl: process.env.OLLAMA_INVESTIGATOR_URL || 'http://10.0.0.228:11434/v1/chat/completions',
        model: 'qwen2.5-coder:14b' 
    }
};

export async function debate(userRequest, context, config, personaMemories = {}, isAutonomous = false) {
    const projectHive = personaMemories['project_hive'] || {};
    
    const formatMemory = (mem) => {
        let str = '';
        if (projectHive.scratchpad && projectHive.scratchpad.length) {
            str += `\n   - SHARED PROJECT HIVE MIND: ${projectHive.scratchpad.join(' | ')}`;
        }
        if (!mem || (!mem.semantic && !mem.episodic && !mem.project_roadmap && !mem.inflight_scratchpad)) return str || 'None';
        if (mem.project_roadmap && mem.project_roadmap.length) str += `\n   - Project Roadmap: ${mem.project_roadmap.join(' | ')}`;
        if (mem.semantic && mem.semantic.length) str += `\n   - Semantic Rules: ${mem.semantic.join(' | ')}`;
        if (mem.episodic && mem.episodic.length) str += `\n   - Episodic Experiences: ${mem.episodic.join(' | ')}`;
        if (mem.inflight_scratchpad && mem.inflight_scratchpad.length) str += `\n   - Native Persona Scratchpad: ${mem.inflight_scratchpad.join(' | ')}`;
        return str || 'None';
    };

    let orchestrator_synthesis;
    const debateLog = {};
    let combinedArguments = '';
    const egoConfig = LOCAL_LOBES.AUDITOR; 
    
    if (!isAutonomous) {
        // --- ACTIVE USER MODE: HIERARCHICAL ROUTING ---
        const routerConfig = LOCAL_LOBES.INVESTIGATOR; 
        const routerPrompt = `You are the Context Router (The Receptionist).
Review the following user stimulus and classify it into exactly ONE of these three cognitive domains:
1. AUDITOR: Needs perfection, code linting, security review, or standard adherence.
2. INVESTIGATOR: Needs deep debugging, root-cause analysis, or documentation reading.
3. CHALLENGER: Needs rapid prototyping, MVP execution, removing feature creep, or deployment velocity.

Stimulus: "${userRequest}"

Respond with ONLY the exact name of the domain in all caps: AUDITOR, INVESTIGATOR, or CHALLENGER. No other words.`;

        let chosenPersona = 'AUDITOR'; 
        try {
            if (process.env.DEBUG || process.argv.includes('--test-ensemble')) {
                 console.log(`\n🚦 [Hierarchy] Pinging Router for Context Routing...`);
            }
            const routerResponse = await chat(routerPrompt, "Classify.", routerConfig);
            const match = routerResponse.match(/(AUDITOR|INVESTIGATOR|CHALLENGER)/i);
            if (match) {
                 chosenPersona = match[1].toUpperCase();
            }
        } catch(e) { console.warn(`   ⚠️ Router failed: ${e.message}`); }

        const memoryKey = chosenPersona.toLowerCase();
        const specificMemory = personaMemories[memoryKey];
        const persona = PERSONALITIES[chosenPersona] || PERSONALITIES.AUDITOR;
        
        let personaContext = '', partnershipContext = '';
        try {
            partnershipContext = await fs.readFile(path.join(__dirname, 'config', 'personas', 'partnership.md'), 'utf8');
            personaContext = await fs.readFile(path.join(__dirname, 'config', 'personas', `${memoryKey}.md`), 'utf8');
        } catch (e) {}

        const synthesisPrompt = `You are the Lead Engineer for the Brain3 local cluster.
You have been dynamically assigned the persona mask of: ${persona.name}
Role: ${persona.role}

${partnershipContext}
${personaContext}

YOUR PERSISTENT MEMORY/BIAS:
${formatMemory(specificMemory)}

Analyze the following request/state: "${userRequest}"
Context: ${JSON.stringify(context)}

CRITICAL CONSTRAINTS:
1. Synthesize a single, polished, high-confidence actionable plan breaking down the request into atomic micro-steps based ON YOUR SPECIFIC ASSIGNED PERSONA.
2. Enclose actionable execution steps in brackets, e.g. [ACTION: run_script(path)]
3. If there is a complete deadlock or subjective decision required that cannot be deduced from facts, output exactly "[HUMAN_ESCALATION_REQUIRED]" in your summary.

Respond ONLY with a valid JSON object in this exact schema:
{
  "objective_complete": boolean,
  "summary": "1-sentence synthesis.",
  "requires_human_override": boolean,
  "escalation_question": "If override required, ask the exact question",
  "final_actionable_plan": ["[ACTION: step_1]"],
  "next_step_stimulus": "If not complete, what exactly do we feed to the next loop iteration?"
}`;

        try {
            orchestrator_synthesis = await chatJson(synthesisPrompt, userRequest, egoConfig, { useAnalysisModel: false });
        } catch (err) {
            orchestrator_synthesis = { objective_complete: false, summary: "Ego Synthesizer JSON parsing failure.", requires_human_override: true, escalation_question: "Local GPU crashed.", final_actionable_plan: [], next_step_stimulus: null };
        }
        
    } else {
        // --- AUTONOMOUS MODE: PARALLEL DEBATE ---
        if (process.env.DEBUG || process.argv.includes('--test-ensemble')) {
            console.log(`\n🚦 [Debate] Initiating Parallel Consensus Debate across GPUs...`);
        }
        
        // Pre-read shared context files ONCE before parallel dispatch (Finding #13 fix)
        let partnershipContext = '';
        try {
            partnershipContext = await fs.readFile(path.join(__dirname, 'config', 'personas', 'partnership.md'), 'utf8');
        } catch (e) {}

        const pruneContext = (ctx, personaKey) => {
            if (!ctx) return "None";
            const pruned = {};
            if (personaKey === 'AUDITOR') {
                if (ctx.rules) pruned.rules = ctx.rules;
                if (ctx.anomalies) pruned.anomalies = ctx.anomalies;
                if (ctx.spec) pruned.spec = ctx.spec;
            } else if (personaKey === 'INVESTIGATOR') {
                if (ctx.bugs) pruned.bugs = ctx.bugs;
                if (ctx.logs) pruned.logs = ctx.logs;
                if (ctx.issues) pruned.issues = ctx.issues;
            } else if (personaKey === 'CHALLENGER') {
                if (ctx.inflight) pruned.inflight = ctx.inflight;
                if (ctx.priorities) pruned.priorities = ctx.priorities;
                if (ctx.roadmap) pruned.roadmap = ctx.roadmap;
            }
            if (Object.keys(pruned).length === 0) {
                const str = typeof ctx === 'string' ? ctx : JSON.stringify(ctx);
                return str.substring(0, 400) + "... [Pruned for Edge Node Attention Limits]";
            }
            return JSON.stringify(pruned);
        };

        const debaterPromises = Object.entries(PERSONALITIES).map(async ([key, persona]) => {
            const memoryKey = key.toLowerCase();
            const specificMemory = personaMemories[memoryKey];
            let personaContext = '';
            try {
                personaContext = await fs.readFile(path.join(__dirname, 'config', 'personas', `${memoryKey}.md`), 'utf8');
            } catch (e) {}
            
            if (!LOCAL_LOBES[key]) return { key, argument: "[Offline]" };
            
            const localLobeInstruction = `You are the core intelligence for the ${key} persona running natively in the Brain3 cluster.
${partnershipContext}
${personaContext}

YOUR PERSISTENT MEMORY/BIAS:
${formatMemory(specificMemory)}

Analyze the following request/state: "${userRequest}"
Context: ${pruneContext(context, key)}

CRITICAL CONSTRAINTS:
1. Provide a direct, highly-opinionated argument on the EXACT next granular step. Be sterile and concise.
2. How does the proposed step advance us toward the long-term spec/goal?
3. Enclose actionable commands in brackets, e.g. [ACTION: run_script(path)]`;

            try {
                const argument = await chat(localLobeInstruction, userRequest, LOCAL_LOBES[key]);
                return { key, argument };
            } catch (err) { return { key, argument: `[Failed: ${err.message}]` }; }
        });

        const debaterResults = await Promise.all(debaterPromises);
        
        for (const res of debaterResults) {
            const persona = PERSONALITIES[res.key];
            combinedArguments += `\n--- Argument from ${persona ? persona.name : res.key} ---\n${res.argument}\n`;
            if (res.key === 'AUDITOR') debateLog.type1_auditor = res.argument;
            else if (res.key === 'INVESTIGATOR') debateLog.type5_investigator = res.argument;
            else if (res.key === 'CHALLENGER') debateLog.type8_challenger = res.argument;
        }

        const synthesisPrompt = `You are the AI Orchestrator (The Ego) for the Brain3 local cluster.
You are moderating an autonomous debate between three specialized edge personas regarding this state:
"${userRequest}"

CONTEXT: ${JSON.stringify(context)}

CONFLICTING ARGUMENTS FROM NATIVE LOBES:
${combinedArguments}

Your job is strictly to resolve these contradictions natively and synthesize a single, polished, high-confidence actionable plan. Break down the consensus into atomic micro-steps. Formulate any execution steps using [ACTION: ...] syntax.
If there is a complete deadlock or subjective decision required that cannot be deduced from facts, you MUST output the exact string "[HUMAN_ESCALATION_REQUIRED]" rather than guessing wildly.

Respond ONLY with a valid JSON object in this exact schema:
{
  "objective_complete": boolean,
  "summary": "1-sentence synthesis.",
  "requires_human_override": boolean,
  "escalation_question": "If override required, ask the exact question",
  "final_actionable_plan": ["[ACTION: step_1]"],
  "next_step_stimulus": "If not complete, what exactly do we feed to the next loop iteration?"
}`;

        try {
            orchestrator_synthesis = await chatJson(synthesisPrompt, userRequest, egoConfig, { useAnalysisModel: false });
        } catch (err) {
            orchestrator_synthesis = { objective_complete: false, summary: "Ego Synthesizer JSON parsing failure.", requires_human_override: true, escalation_question: "Local GPU crashed.", final_actionable_plan: [], next_step_stimulus: null };
        }
    }

    if (orchestrator_synthesis.final_actionable_plan && orchestrator_synthesis.summary.includes('[HUMAN_ESCALATION_REQUIRED]')) {
         orchestrator_synthesis.requires_human_override = true;
    }

    // Brain3 returns CONSENSUS ONLY — execution flows through DOE
    return {
        debate: debateLog,
        orchestrator_synthesis,
        fast_track: false
    };
}
