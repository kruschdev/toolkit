import { debate } from './ensemble.js';
import { loadProjectConfig, getHomelabTopology } from '../config.js';
import { loadPersonaMemory, addMemory } from './memory_controller.js';
import { chat } from '../llm.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INBOX_FILE = path.join(__dirname, '..', '..', 'lib', 'brain', 'data', 'inbox.json');
const COMPLETED_FILE = path.join(__dirname, '..', '..', 'lib', 'brain', 'data', 'completed.json');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const askQuestion = (query) => new Promise((resolve) => rl.question(query, resolve));

async function getNextTask() {
    try {
        const data = await fs.readFile(INBOX_FILE, 'utf8');
        const tasks = JSON.parse(data);
        if (tasks.length > 0) {
            const task = tasks.shift();
            await fs.writeFile(INBOX_FILE, JSON.stringify(tasks, null, 2));
            return task;
        }
    } catch (e) {
         // ignore missing file/parse error for now
    }
    return null;
}

async function markCompleted(task, resultStr) {
    try {
        let completed = [];
        try {
            const data = await fs.readFile(COMPLETED_FILE, 'utf8');
            completed = JSON.parse(data);
        } catch (e) {}
        
        completed.push({ task, resolved_at: new Date().toISOString(), result: resultStr });
        await fs.writeFile(COMPLETED_FILE, JSON.stringify(completed, null, 2));
    } catch (e) {
        console.error("Failed to mark task complete", e);
    }
}

async function processTask(task) {
    console.log(`\n\x1b[36m====================================================\x1b[0m`);
    console.log(`\x1b[36m🌀 NEW STIMULUS DETECTED: "${task}"\x1b[0m`);
    console.log(`\x1b[36m====================================================\x1b[0m\n`);
    
    const projectRoot = process.env.BRAIN_PROJECT_ROOT || '/home/kruschdev/homelab';
    const config = await loadProjectConfig(projectRoot);
    config.provider = 'gemini';
    config.apiKey = process.env.GEMINI_API_KEY;
    config.model = 'gemini-2.5-flash-lite';
    config.analysisModel = 'gemini-2.5-pro';
    config.maxOutputTokens = 8192;
    config.enableBrain = true;
    
    let projectSpec = "No overarching spec sheet located.";
    try {
        projectSpec = await fs.readFile(path.join(projectRoot, 'docs', 'brain_spec.md'), 'utf8');
    } catch(e) {
        try {
            projectSpec = await fs.readFile(path.join(projectRoot, 'spec.md'), 'utf8');
        } catch(e) {}
    }

    const context = { 
        project: "Autonomous Core Integration", 
        homelab_topology: getHomelabTopology(),
        project_spec: projectSpec 
    };
    const personaMemories = await loadPersonaMemory();
    
    console.log(`⏳ The 3-Node Hardware Ensemble is debating the stimulus...`);
    const result = await debate(task, context, config, personaMemories);
    
    if (result.fast_track) {
        console.log(`\x1b[32m⚡ Fast Track Consensus Reached (2/3 Majority):\x1b[0m ${result.orchestrator_synthesis.summary}`);
    } else {
        console.log(`\x1b[33m🧠 Tier 3 Orchestrator Synthesis (3-Way Tie Escalation):\x1b[0m ${result.orchestrator_synthesis.summary}`);
    }

    if (result.orchestrator_synthesis.requires_human_override) {
        console.log(`\n\x1b[31m🛑 TIER 4 PARTNERSHIP ESCALATION TRIGGERED\x1b[0m`);
        const answer = await askQuestion(`   ❓ ${result.orchestrator_synthesis.escalation_question}\n   > `);
        console.log(`\n👤 Human Partner responded: "${answer}" recorded to Episodic Memory. Pushing back into the loop...`);
        
        const overrideTask = `[HUMAN ARCHITECT OVERRIDE FOR: "${task}"]\nSYSTEM ASKED: ${result.orchestrator_synthesis.escalation_question}\nARCHITECT DECREES: ${answer}`;
        try {
            const data = await fs.readFile(INBOX_FILE, 'utf8');
            const tasks = JSON.parse(data);
            tasks.unshift(overrideTask); // Push to FRONT of the line
            await fs.writeFile(INBOX_FILE, JSON.stringify(tasks, null, 2));
        } catch (e) {
            console.error("Failed to re-queue human override task", e);
        }
        return;
    } 

    // === BRIDGE: Brain3 consensus → DOE secure execution ===
    console.log(`✅ Consensus Reached. Routing to DOE secure dispatch...`);
    const plan = result.orchestrator_synthesis.final_actionable_plan || [];
    
    if (plan.length === 0) {
        console.log(`\x1b[33m⚠️ Consensus produced no actionable steps. Closing loop.\x1b[0m`);
        await markCompleted(task, `Consensus: ${result.orchestrator_synthesis.summary} (no actions)`);
        return;
    }

    // Convert Brain3 consensus plan into a dispatchable edge payload via the Daemon API
    let doeResult;
    try {
        const consensusContext = `BRAIN3 CONSENSUS OVERRIDE:\n${plan.map((a, i) => `${i + 1}. ${a}`).join('\n')}\n\nSummary: ${result.orchestrator_synthesis.summary}`;
        
        console.log(`[DOE] Dispatching consensus via POST to Chrysalis Daemon (Port 11437)...`);
        const response = await fetch('http://127.0.0.1:11437/api/plan', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ taskRequest: consensusContext })
        });
        
        if (!response.ok) throw new Error(`Daemon responded with HTTP ${response.status}`);
        
        console.log(`[DOE] ✅ Daemon accepted and compiled execution flow.`);
        doeResult = `Daemon successfully digested and dispatched execution pipeline.`;
    } catch (err) {
        console.error(`[DOE] ❌ Execution API dispatch failed: ${err.message}`);
        doeResult = `API Dispatch failed: ${err.message}`;
    }

    // === POST-EXECUTION AUDIT ===
    console.log(`🛡️  Commencing Final Audit (Auditor Bias)...`);
    const auditConfig = { ...config, model: 'gemini-2.5-flash' };
    const auditorMems = personaMemories['auditor'] || {};
    const auditPrompt = `You are the Auditor (T1). Review this execution output against our core priorities: God, Maggie, Aspen. Did it succeed without violating our rules? Output a short 2-sentence Pass/Fail analysis.\n\nMemories: ${JSON.stringify(auditorMems)}\nPlan: ${plan.join(' | ')}\nOutput: ${JSON.stringify(doeResult)}`;
    
    let auditResult = 'Audit skipped.';
    try {
        auditResult = await chat(auditPrompt, "Evaluate the output.", auditConfig);
        console.log(`📋 AUDIT REPORT:\n${auditResult}\n`);
    } catch (err) {
        console.warn(`Audit failed: ${err.message}`);
    }

    // Ping episodic logs
    const notification = `[System] DOE executed consensus plan. Audit: ${auditResult.split('.')[0]}`;
    try {
        for (const persona of Object.keys(personaMemories)) {
            await addMemory(persona, 'episodic', notification);
        }
    } catch (memErr) { console.warn("Failed to ping episodic log", memErr); }

    // ------------------------------------------------------------------
    // 🔁 RECURSIVE ARCHITECTURE: Feed incomplete loops back into Lobes
    // ------------------------------------------------------------------
    if (!result.orchestrator_synthesis.objective_complete && result.orchestrator_synthesis.next_step_stimulus) {
        const nextRoundTask = `[CONTINUATION OF: "${task}"]\nPREVIOUS AUDIT RESULT: ${auditResult}\nPRO DIRECTIVE FOR NEXT STEP: ${result.orchestrator_synthesis.next_step_stimulus}`;
        console.log(`\n\x1b[35m🔄 PRO DIRECTIVE: Objective incomplete. Pushing next step back into Local Lobe Inbox...\x1b[0m`);
        
        try {
            const data = await fs.readFile(INBOX_FILE, 'utf8');
            const tasks = JSON.parse(data);
            tasks.unshift(nextRoundTask); // Push to the FRONT of the line
            await fs.writeFile(INBOX_FILE, JSON.stringify(tasks, null, 2));
        } catch (e) {
            console.error("Failed to re-queue next stimulus", e);
        }
    } else {
        console.log(`\n\x1b[32m🌟 OBJECTIVE COMPLETE. Closing loop.\x1b[0m`);
    }
    
    await markCompleted(task, `DOE-Executed. Audit: ${auditResult}`);
}

async function startDaemon() {
    console.log("🚀 Starting Brain V3 Autonomous Loop Daemon...");
    console.log("Listening to data/inbox.json for new stimuli. Press Ctrl+C to exit.\n");
    
    while (true) {
        const task = await getNextTask();
        if (task) {
            await processTask(task);
        } else {
            // Sleep quietly for 5 seconds
            await new Promise(r => setTimeout(r, 5000));
        }
    }
}

if (process.argv.includes('--daemon')) {
    startDaemon().catch(err => {
        console.error("Daemon crashed:", err);
        process.exit(1);
    });
} else if (process.argv.includes('--run-once')) {
    getNextTask().then(task => {
        if (task) {
            return processTask(task);
        } else {
            console.log("Inbox is empty.");
        }
    }).catch(err => {
        console.error("Run failed:", err);
        process.exit(1);
    });
}
