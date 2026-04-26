import { execSync } from 'node:child_process';
import { loadProjectConfig } from '../config.js';
import { chatJson } from '../llm.js';
import { envOr } from '../config.js';
import fs from 'node:fs';
import path from 'node:path';

/**
 * @module pulse
 * The Agentic OS "Brainstem".
 * A continuous background loop pinned to kr1yoga that perceives homelab state
 * and autonomously proposes actions via Google Chat routing.
 */

const HOME_DIR = process.cwd();
const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Gather the current sensory state of the homelab.
 */
function perceiveState() {
    console.log('[Pulse] Gathering sensory data...');
    const state = {
        timestamp: new Date().toISOString(),
        docker_crashes: [],
        inflight_projects: []
    };

    // 1. Check Docker state
    try {
        const dockerSsh = `ssh kruschserv 'docker ps -a --format "{{.Names}}: {{.Status}}" | grep -i "exited\\|restarting"'`;
        // We use try/catch since grep returns non-zero if no lines matched
        const crashed = execSync(dockerSsh, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
        if (crashed) {
            state.docker_crashes = crashed.split('\n').filter(Boolean);
        }
    } catch (e) {
        if (e.stdout) {
             state.docker_crashes = e.stdout.trim().split('\n').filter(Boolean);
        }
    }

    // 2. Check for active INFLIGHT work
    try {
        const findInflight = `find ${HOME_DIR}/projects -maxdepth 2 -name 'INFLIGHT.md'`;
        const files = execSync(findInflight, { encoding: 'utf-8' }).trim().split('\n').filter(Boolean);
        state.inflight_projects = files.map(f => {
            return {
                path: f,
                summary: fs.readFileSync(f, 'utf8').substring(0, 300) + '...'
            };
        });
    } catch (e) {
        // ignore
    }

    return state;
}

/**
 * Push an interactive card to Google Chat for user approval
 */
async function pushGoogleChatProposal(thoughtTrace, proposedTask) {
    const webhookUrl = envOr('GC_PULSE_WEBHOOK_URL', null, '');
    if (!webhookUrl) {
        console.warn('[Pulse] No GC_PULSE_WEBHOOK_URL defined. Falling back to local log.');
        console.log(`[PROPOSAL]\nReasoning: ${thoughtTrace}\nTask: ${proposedTask}`);
        
        // Write to decisions as fallback
        const decisionLog = path.join(HOME_DIR, '.agent/decisions.md');
        const entry = `\n## [PULSE] ${new Date().toISOString()}\n**Reasoning:** ${thoughtTrace}\n**Task:** ${proposedTask}\n`;
        try { fs.appendFileSync(decisionLog, entry); } catch(e){}
        return;
    }

    // Encode task into the action parameter for the webhook callback
    const safeTask = encodeURIComponent(proposedTask);
    const callbackEndpoint = envOr('PULSE_APPROVE_ENDPOINT', null, 'http://100.92.219.61:11437/api/pulse/approve');

    const cardPayload = {
        cardsV2: [{
            cardId: 'pulse_proposal',
            card: {
                header: {
                    title: 'Homelab Pulse: Action Proposed',
                    subtitle: 'Agentic OS Brainstem'
                },
                sections: [{
                    widgets: [
                        {
                            textParagraph: { text: `<b>Reasoning:</b><br>${thoughtTrace}` }
                        },
                        {
                            textParagraph: { text: `<b>Proposed Task:</b><br>${proposedTask}` }
                        },
                        {
                            buttonList: {
                                buttons: [
                                    {
                                        text: 'Approve & Execute',
                                        color: { red: 0, green: 0.5, blue: 0 },
                                        onClick: {
                                            openLink: {
                                                // Quick hack: Using a GET link to approve, or could use a Chat App action.
                                                // Assuming daemon.js exposes a GET for simplicity via web browser, 
                                                // but for Chat API Native Action it would use `action` payload.
                                                url: `${callbackEndpoint}?task=${safeTask}`
                                            }
                                        }
                                    }
                                ]
                            }
                        }
                    ]
                }]
            }
        }]
    };

    try {
        await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(cardPayload)
        });
        console.log('[Pulse] ✅ Proposal pushed to Google Chat.');
    } catch (e) {
        console.error('[Pulse] ❌ Failed to push Google Chat card:', e.message);
    }
}

/**
 * The infinite autonomous loop
 */
async function pulseLoop() {
    console.log(`\n================================`);
    console.log(`[Pulse] Waking up...`);
    
    await loadProjectConfig(HOME_DIR);
    const state = perceiveState();

    // If completely idle and healthy, skip inference to save tokens
    if (state.docker_crashes.length === 0 && state.inflight_projects.length === 0) {
        console.log('[Pulse] Ecosystem is healthy and idle. Sleeping.\n');
        setTimeout(pulseLoop, POLL_INTERVAL_MS);
        return;
    }

    console.log('[Pulse] Cognition layer activated. Formulating thought...');

    const systemPrompt = `You are the Homelab Pulse, a continuous autonomous orchestrator daemon running on kr1yoga.
Your role is to monitor the homelab state and propose EXACT actionable tasks if an anomaly or pending work is detected.

CURRENT STATE:
${JSON.stringify(state, null, 2)}

Respond in strict JSON with exactly three keys:
- "has_action" (boolean) - true only if there is a problem needed fixing or an INFLIGHT project needing immediate continuation.
- "thought_trace" (string) - your internal reasoning.
- "proposed_task" (string) - the raw text task request you would pass to the Chrysalis Swarm to execute (e.g., "Fix the crashing redis container" or "Continue the caren project implementation steps").`;

    try {
        const schema = {
            type: "object",
            properties: {
                has_action: { type: "boolean" },
                thought_trace: { type: "string" },
                proposed_task: { type: "string" }
            },
            required: ["has_action", "thought_trace", "proposed_task"]
        };

        // Pin inference exactly to kr1yoga's local qwen 0.5b model (prevents VRAM crash on small GPUs)
        // We use the full chatJson signature: systemPrompt, userMessage, config, options
        const llmConfig = {
            provider: 'ollama',
            model: 'qwen2.5-coder:0.5b',
            apiUrl: 'http://127.0.0.1:11434/v1/chat/completions',
            responseSchema: schema
        };

        const responseJson = await chatJson(
            systemPrompt, 
            'Evaluate the current state.', 
            llmConfig
        );

        const proposal = responseJson;
        
        if (proposal.has_action) {
            console.log(`[Pulse] Needs Action! Sending proposal...`);
            await pushGoogleChatProposal(proposal.thought_trace, proposal.proposed_task);
        } else {
            console.log(`[Pulse] Evaluated state, no action needed. Sleeping.`);
        }

    } catch (e) {
        console.error('[Pulse] ❌ Cognition Error:', e.message);
    }

    console.log(`[Pulse] Cycle complete.\n================================\n`);
    setTimeout(pulseLoop, POLL_INTERVAL_MS);
}

// Start loop
console.log('[Pulse] Starting Agentic OS Brainstem Loop on kr1yoga...');
pulseLoop();
