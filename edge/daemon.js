import express from 'express';
import crypto from 'node:crypto';
import { loadProjectConfig } from '../config.js';
import { chat, chatJson } from '../llm.js';
import { buildRegistry, streamMacroArchitecture, planMicroSteps, createPersona, synthesizePersonaBlueprint, checkHitLGate, auditStepResult, auditIntegrationArchitecture, identifySwarmPhases } from './index.js';
import { logExecution, query as pgQuery, embedText, findProjectLocation } from './db-pg.js';
import { addMemory, loadPersonaMemory, askHiveMind, getProjectScratchpad } from '../brain/memory_controller.js';
import { debate } from '../brain/ensemble.js';
import { scheduleNode } from './node_scheduler.js';
import { dispatchTask } from './dispatch.js';
import { recordIntervention } from './error_memory.js';
import { envOr } from '../config.js';
import { exec } from 'node:child_process';
import util from 'node:util';

const execAsync = util.promisify(exec);

/**
 * @module daemon
 * Central Pipelined Execution Engine for the Chrysalis Swarm.
 * Orchestrates the multi-node concurrent edge execution loop, handles Phase logic pipelines,
 * and maintains the Zero-Latency VRAM capacity thresholds.
 */

/**
 * Calculates the semantic cosine similarity between two vector embeddings.
 * Used for Hive Mind SQLite cache blueprint matching.
 * 
 * @private
 * @param {number[]} A - Generated vector embedding
 * @param {number[]} B - Target cache vector embedding
 * @returns {number} Score between 0.0 and 1.0 (1.0 = exact match)
 */
function cosineSimilarity(A, B) {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < A.length; i++) {
        dotProduct += A[i] * B[i];
        normA += A[i] * A[i];
        normB += B[i] * B[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

const app = express();
app.use(express.json());

const PORT = 18888;

/** Max resplit depth before escalating to Flash-Lite */
const MAX_RESPLIT_DEPTH = 2;


/**
 * Execute a single DAG step with the 3-tier escalation pattern:
 *  Tier 1: 3B worker (atomic execution)
 *  Tier 2: Director audit + resplit (max depth 2)
 *  Tier 3: Flash-Lite cloud intervention + learning
 *
 * @param {Object} step - DAG step to execute
 * @param {Object} spec - Persona specification
 * @param {string} enrichedAction - Action with dependency context injected
 * @param {Array} allSteps - Full DAG for audit context
 * @param {string} sessionId - Session UUID for logging
 * @param {number} depth - Current resplit depth (0 = first try)
 * @returns {Promise<string>} Execution result
 */
async function executeStepWithAudit(step, spec, enrichedAction, allSteps, sessionId, depth = 0, activeTaskString = '', contextPayload = null) {
    const optimalNode = await scheduleNode(step.node_affinity || 'least-loaded');
    console.log(`[DAG:${step.id}] Tier 1: Dispatching to ${spec.name} on ${optimalNode} (depth ${depth})`);

    const startTime = Date.now();
    let result;
    try {
        result = await dispatchTask({ ...spec, node: optimalNode }, enrichedAction, contextPayload);
    } catch (e) {
        result = `[Worker API Exception]: ${e.message}`;
    }
    const execTime = Date.now() - startTime;

    await logExecution(sessionId, step.persona, step.action, result, execTime).catch(() => {});

    // --- TIER 2: Director Audit ---
    console.log(`[DAG:${step.id}] Tier 2: Director auditing output...`);
    const audit = await auditStepResult(step, result, allSteps, activeTaskString);

    if (audit.pass) {
        console.log(`[DAG:${step.id}] ✅ Audit PASSED`);
        return result;
    }

    console.warn(`[DAG:${step.id}] ❌ Audit FAILED: ${audit.reason}`);

    // --- TIER 2: Resplit and retry ---
    if (depth < MAX_RESPLIT_DEPTH && audit.subSteps && audit.subSteps.length > 0) {
        console.log(`[DAG:${step.id}] Resplitting into ${audit.subSteps.length} sub-steps (depth ${depth + 1})`);
        let lastSubResult = '';
        for (const subStep of audit.subSteps) {
            let subSpec = JSON.parse(JSON.stringify(spec));
            // All retries: Escalate Worker Base Model to 14B Auditor Nodes
            console.log(`[DAG:${subStep.id}] 🚀 Escalating Context-Aware Worker to 14B limits for retry (depth ${depth})...`);
            subSpec.base = 'qwen2.5-coder:14b';
            subStep.node_affinity = 'auditor';

            // If the sub-step has a different persona, synthesize it
            if (subStep.persona !== step.persona) {
                const newBlueprint = await synthesizePersonaBlueprint(subStep.persona, 'homelab');
                subSpec = { ...newBlueprint, base: subSpec.base }; // Preserve escalated base
                await createPersona(await scheduleNode('auditor'), subSpec);
            }

            lastSubResult = await executeStepWithAudit(
                subStep, subSpec, subStep.action, audit.subSteps, sessionId, depth + 1, activeTaskString, contextPayload
            );
        }
        return lastSubResult;
    }

    // --- TIER 3: Max Retries Exhausted ---
    console.error(`[DAG:${step.id}] ❌ Local Validation completely exhausted (depth ${depth} >= max ${MAX_RESPLIT_DEPTH}). Sovereignty limit reached.`);

    // Record the explicit failure state for offline learning
    await recordIntervention(step.action, audit.subSteps || [step], `[Validation Failed]: ${audit.reason}`);

    return `[Local Stack Failure] Exhausted retries resolving component issue: ${audit.reason}`;
}

app.post('/api/plan', async (req, res) => {
    const { taskRequest } = req.body;
    if (!taskRequest) return res.status(400).json({ error: 'taskRequest is required' });

    console.log(`\n[Daemon] Received new task: ${taskRequest}\n`);

    try {
        const rootDir = '/home/kruschdev/homelab';
        await loadProjectConfig(rootDir);
        
        console.log('[System] Loading registry, Hive Mind, and scratchpad in parallel...');
        const [registry, hiveKnowledge, sharedState] = await Promise.all([
            buildRegistry(rootDir, taskRequest),
            askHiveMind(taskRequest, "Provide only facts relevant to solving this task based on recent swarm memories."),
            getProjectScratchpad('homelab')
        ]);
        console.log(`[System] Found ${registry.size} personas.`);

        const sharedStateString = sharedState.length > 0
            ? `\n[SHARED PROJECT HIVE MIND (READ-ONLY)]\n${sharedState.map(s => '- ' + s).join('\n')}\n`
            : '';
            
        let workingDir = null;
        let locationContext = '';
        try {
            // Check for explicit hard-path override first to bypass RAG drift
            const pathMatch = taskRequest.match(/(\/(?:mnt|home|var|usr|opt|etc|tmp)[\/\w\.-]+)/);
            
            if (pathMatch && pathMatch[1]) {
                workingDir = pathMatch[1];
                locationContext = `\n[EXPLICIT PATH OVERRIDE]\nTarget Directory: ${workingDir}\n`;
                console.log(`[Location RAG] 📍 Hard-path override detected: ${workingDir}`);
            } else {
                console.log(`[Location RAG] Embedding task request to find geographic bounding box...`);
                const vectorJsonRaw = await embedText(taskRequest);
                const tempVector = JSON.parse(vectorJsonRaw);
                
                // Restored threshold to 0.80 to prevent semantic drift across disjoint sandbox games
                const projMatch = await findProjectLocation(tempVector, 0.80); 
                
                console.log(`[Location RAG] findProjectLocation returned: ${JSON.stringify(projMatch)}`);
                if (projMatch) {
                    workingDir = projMatch.absolute_path;
                    locationContext = `\n[GEOGRAPHIC BOUNDARY]\nProject: ${projMatch.project_name}\nPath: ${workingDir}\nDescription: ${projMatch.context_description}\n`;
                    console.log(`[Location RAG] 📍 Semantically matched geographic workspace: ${workingDir}`);
                }
            }
        } catch (e) {
            console.warn(`[Location RAG] Failed lookup: ${e.message}`);
        }

        const activeTaskString = `[HIVE MIND CONTEXT (VRAM)]\n${hiveKnowledge}\n${sharedStateString}${locationContext}\n[USER REQUEST]\n${taskRequest}`;

        let history = [];

        console.log(`\n=== Identifying Domain Phases ===`);
        const phases = await identifySwarmPhases(activeTaskString);
        const sessionId = crypto.randomUUID();

        for (const phase of phases) {
            console.log(`\n======================================================`);
            console.log(`=== EXECUTING PHASE ${phase.layerIndex}: ${phase.persona} ===`);
            console.log(`======================================================`);

            // 1. Hive Mind DAG Caching
            let cachedDag = null;
            let requestVector = null;
            const similarityThreshold = parseFloat(envOr('HIVE_MIND_SIMILARITY_THRESHOLD', null, '0.98'));
            const phaseCacheKey = `[DAG_BLUEPRINT_${phase.layerIndex}_${phase.persona}]`;

            if (sharedState.length > 0 && !requestVector) {
                try {
                    requestVector = JSON.parse(await embedText(taskRequest));
                } catch(e) { console.error('[Hive Mind] Parsing issue context payload:', e.message); }
            }

            for (const memory of sharedState) {
                if (memory.startsWith(phaseCacheKey)) {
                    // cache logic
                    try {
                        const parsed = JSON.parse(memory.substring(phaseCacheKey.length));
                        if (!requestVector) break;

                        const cachedTaskVector = JSON.parse(await embedText(parsed.task));
                        const sim = cosineSimilarity(requestVector, cachedTaskVector);

                        if (sim >= similarityThreshold) {
                            console.log(`\n[Hive Mind Phase ${phase.layerIndex}] ⚡ CACHE HIT! (${(sim*100).toFixed(1)}% match)`);
                            cachedDag = parsed.dag;
                            break;
                        }
                    } catch (e) {
                         console.error(`[Hive Mind] Vector comparison failed:`, e.message);
                    }
                }
            }

            console.log(`\n=== Planning Macro Architecture for Phase ${phase.layerIndex} ===`);
            let macroPlan, isCacheHit = false;
            
            if (cachedDag) {
                console.log(`[Director] Bypassing inference pipeline — loading DAG from Project Memory.`);
                macroPlan = { status: 'MACRO_PLANNED', components: [], isCached: true };
                isCacheHit = true;
            } else {
                macroPlan = await streamMacroArchitecture(
                   'homelab', 
                   'execute', 
                   activeTaskString, 
                   registry,
                   history,
                   phase.persona,
                   phase.skill
                );
            }

            if (macroPlan.status === 'DONE') {
                console.log(`[Director Phase ${phase.layerIndex}] Task evaluated as complete.`);
                continue; // Move to next phase if one evaluates as done early
            }
            
            // Pass the active context forward
            const activePhaseContext = macroPlan.activeTaskString || activeTaskString;

            console.log(`\n[Daemon] Pipelined Execution Engine Starting for Phase ${phase.layerIndex}...`);
            const activeSteps = new Map();
            const completed = new Set();
            const results = new Map();
            let isPlanningDone = false;

            if (isCacheHit) {
                 for (const step of cachedDag.steps) {
                     step._isDispatching = false;
                     activeSteps.set(step.id, step);
                 }
                 isPlanningDone = true;
            }

            /**
             * Zero-Latency VRAM Hardware Constraint Matrix.
             * Mathematically throttles the `1.5B` worker concurrency to physically prevent PCIe thrashing.
             * 
             * @constant {function} limitExec
             * @note We strictly lock concurrency at '2' slots to guarantee the combined weight
             * (1x 9.5GB Director + 2x 1.5GB Edge Workers = 12.5GB) naturally fits within the 12GB RTX 3060
             * without violently triggering a 10-15s kernel Memory Eviction dump.
             */
            const limitExec = (() => {
                const queue = [];
                let active = 0;
                const next = () => {
                    active--;
                    if (queue.length > 0) queue.shift()();
                };
                return async (fn) => {
                    if (active >= 2) await new Promise(resolve => queue.push(resolve));
                    active++;
                    try { return await fn(); } finally { next(); }
                };
            })();

            const plannerThread = async () => {
                 if (isCacheHit) return;
                 const auditPromises = [];
                 try {
                     for await (const comp of macroPlan.componentsStream) {
                         console.log(`[Producer] Streaming parsed Component to Micro-Planner:`, comp.id || 'unknown');
                         
                         let retries = 0;
                         let isApproved = false;
                         let critiqueText = null;
                         let finalSteps = [];

                         while (retries < 2 && !isApproved) {
                             const stepStream = planMicroSteps('homelab', macroPlan.jointPersona, macroPlan.jointSkill, macroPlan.coreIntent, comp, macroPlan.visionText, critiqueText, activePhaseContext);
                             
                             const componentSteps = [];
                             for await (const step of stepStream) {
                                 componentSteps.push(step);
                             }

                             if (componentSteps.length === 0) {
                                 isApproved = true;
                                 break;
                             }

                             const { auditDAGArchitecture } = await import('./index.js');
                             const auditResult = await auditDAGArchitecture(componentSteps, comp.id || 'unknown', activePhaseContext);

                             if (auditResult.approved) {
                                 isApproved = true;
                                 finalSteps = componentSteps;
                             } else {
                                 retries++;
                                 critiqueText = auditResult.critique || 'Plan structurally flawed. Please restart your component structure from scratch and try again.';
                                 console.warn(`\n[Actor-Critic] '${comp.id}' REJECTED by 32B Architect.`);
                                 console.warn(`[Actor-Critic] Critique: ${critiqueText}`);
                                 console.warn(`[Actor-Critic] Triggering VRAM regeneration loop [${retries}/2]...`);
                             }
                         }

                         // Push finalized or mathematically forced steps to queue
                         if (finalSteps.length === 0 && !isApproved) {
                             console.warn(`[Actor-Critic] Max retries exhausted for '${comp.id}'. Yielding empty block...`);
                         }
                         for (const step of finalSteps) {
                             step._isDispatching = false;
                             activeSteps.set(step.id, step);
                         }
                     }
                 } catch (e) {
                     console.error(`[Producer] Fatal Streaming/Audit Error: ${e.message}`);
                 }
                 isPlanningDone = true;
                 console.log(`[PlannerThread] All Macro Components have been broken down and audited for Phase ${phase.layerIndex}.`);
            };

            const executionThread = async () => {
                 while (true) {
                     if (isPlanningDone && completed.size === activeSteps.size && activeSteps.size > 0) break;
                     if (isPlanningDone && activeSteps.size === 0) break;
                     const ready = Array.from(activeSteps.values()).filter(s =>
                          !completed.has(s.id) &&
                          !s._isDispatching &&
                          (s.depends_on || []).every(dep => completed.has(dep))
                     );
                     const activeExec = Array.from(activeSteps.values()).filter(s => s._isDispatching && !completed.has(s.id));
                     if (ready.length === 0) {
                          if (isPlanningDone && activeExec.length === 0 && completed.size < activeSteps.size) {
                              console.error(`[DAG Phase ${phase.layerIndex}] Deadlock detected.`);
                              break;
                          }
                          await new Promise(r => setTimeout(r, 1000));
                          continue;
                     }
                     for (const step of ready) {
                         step._isDispatching = true;
                         limitExec(async () => {
                            try {
                                let enrichedAction = step.action;
                                let contextPayload = null;
                                if (step.depends_on && step.depends_on.length > 0) {
                                    const contextData = {};
                                    step.depends_on.filter(depId => results.has(depId)).forEach(depId => {
                                         contextData[depId] = String(results.get(depId)).slice(0, 1000);
                                    });
                                    if (Object.keys(contextData).length > 0) {
                                         contextPayload = { TransferProtocol: 'CONTEXTUAL', data: contextData };
                                    }
                                }

                                if (step.persona === 'deterministic-executor') {
                                    console.log(`[Hybrid Graph] Bypassing LLM logic for deterministic execution: ${step.action}`);
                                    const startTime = Date.now();
                                    try {
                                        const { stdout, stderr } = await execAsync(step.action, { cwd: workingDir || '/home/kruschdev/homelab' });
                                        const result = `[Deterministic Execution Complete]\n${stdout}\n${stderr}`;
                                        const execTime = Date.now() - startTime;
                                        await logExecution(sessionId, step.persona, step.action, result, execTime).catch(() => {});
                                        results.set(step.id, result);
                                        completed.add(step.id);
                                        history.push({ phase: phase.layerIndex, step: `DAG:${step.id}`, persona: step.persona, action: step.action, result });
                                    } catch (e) {
                                        console.error(`[DAG:Error] Deterministic execution failed:`, e.message);
                                        const result = `[Deterministic Execution Failed]\n${e.message}`;
                                        const execTime = Date.now() - startTime;
                                        await logExecution(sessionId, step.persona, step.action, result, execTime).catch(() => {});
                                        results.set(step.id, result);
                                        completed.add(step.id);
                                    }
                                    return;
                                }

                                let spec = registry.get(step.persona);
                                if (!spec) {
                                    spec = await synthesizePersonaBlueprint(step.persona, 'homelab');
                                    await createPersona('kruschdev_worker', spec);
                                    registry.set(spec.name, spec);
                                }
                                if (workingDir) spec = { ...spec, working_dir: workingDir };
                                
                                const result = await executeStepWithAudit(
                                    step, spec, enrichedAction, Array.from(activeSteps.values()), sessionId, 0, activePhaseContext, contextPayload
                                );
                                results.set(step.id, result);
                                completed.add(step.id);
                                history.push({ phase: phase.layerIndex, step: `DAG:${step.id}`, persona: step.persona, action: step.action, result });
                                
                                // --- DECENTRALIZED TASK GRAPH (DTG) - Peer Handoff Injection ---
                                const handoffMatch = String(result).match(/\[HANDOFF:\s*([\w-]+)\]/i);
                                if (handoffMatch && handoffMatch[1]) {
                                    const nextPersona = handoffMatch[1];
                                    const newId = `dtg_${Math.random().toString(36).substring(7)}`;
                                    console.log(`[Swarm DTG] Peer hand-off triggered dynamically: ${step.persona} -> ${nextPersona}`);
                                    const dtgStep = {
                                        id: newId,
                                        persona: nextPersona,
                                        action: `[DECENTRALIZED HAND-OFF INSTRUCTION]\nYou have been autonomously invoked by a peer agent (${step.persona}).\nReview the context from their execution and continue the core intent building process.`,
                                        depends_on: [step.id],
                                        _isDispatching: false
                                    };
                                    activeSteps.set(newId, dtgStep);
                                }
                                
                            } catch (e) {
                                console.error(`[DAG:Error] Step ${step.id} failed:`, e.message);
                                completed.add(step.id);
                            }
                         });
                     }
                     await new Promise(r => setTimeout(r, 100));
                 }
            };

            await Promise.all([plannerThread(), executionThread()]);

            if (!isCacheHit && activeSteps.size > 0) {
                console.log(`[Hive Mind] Encoding successful DAG execution to Project Memory for Phase ${phase.layerIndex}.`);
                const cleanSteps = Array.from(activeSteps.values()).map(s => {
                    const copy = { ...s };
                    delete copy._isDispatching;
                    return copy;
                });
                const blueprintObj = { task: taskRequest, dag: { steps: cleanSteps } };
                await addMemory('project_hive', 'tape', `${phaseCacheKey}${JSON.stringify(blueprintObj)}`, 'homelab').catch(() => {});
            }
            
            // Re-read geographic boundary or state to inform the NEXT phase of changes made by THIS phase
            // Specifically, just passing 'history' array into down-stream streamMacroArchitecture is enough, because it traces everything.
            // But we can also add a brief pause.
            await new Promise(r => setTimeout(r, 2000));
        } // end of phases loop

        console.log(`\n[System] Phase 1 Generation Pipeline Complete.`);
        
        console.log(`\n======================================================\n=== EXECUTING PHASE 2: Integration Audit ===\n======================================================`);
        console.log(`[Integration Auditor] 32B Director spinning up to manually simulate code physics...`);
        const finalAudit = await auditIntegrationArchitecture(workingDir, activeTaskString);
        
        if (finalAudit && !finalAudit.approved) {
            console.log(`\n❌ [Phase 2: OVERALL INTEGRATION FAILED]`);
            console.log(`[Critique]: ${finalAudit.critique}`);
            history.push({ integration_audit: finalAudit });
        } else if (finalAudit && finalAudit.approved) {
            console.log(`\n✅ [Phase 2: INTEGRATION PASSED]`);
            console.log(`[Audit]: The generated codebase perfectly aligns and functions cohesively.`);
            history.push({ integration_audit: finalAudit });
        }

        console.log(`\n[System] Edge Swarm Execution Architecture Complete.`);
        res.json({ status: 'done', history });
    } catch (err) {
        console.error(`\n[Fatal Error]`, err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/pulse/approve', async (req, res) => {
    const { task } = req.query;
    if (!task) return res.status(400).send('Missing task parameter');
    
    console.log(`\n[Pulse Integration] User approved autonomous task via Google Chat: ${task}`);
    
    // We send an immediate success back to the browser / chat webhook
    res.send('<html><body><h2>Pulse Task Approved</h2><p>The Chrysalis Swarm is now executing the task in the background.</p></body></html>');
    
    // Trigger the internal plan dispatch asynchronously
    try {
        const response = await fetch(`http://127.0.0.1:${PORT}/api/plan`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ taskRequest: task })
        });
        console.log(`[Pulse Integration] Internal dispatch sent. Status: ${response.status}`);
    } catch(e) {
        console.error(`[Pulse Integration] Failed to trigger internal dispatch:`, e.message);
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Chrysalis Daemon] Listening on port ${PORT}`);
    console.log(`[System] Local Escalation: Workers → Director Audit → Local Component Isolation`);
});
