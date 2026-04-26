/**
 * @module director
 * Tier 2 "Macro-Architect" and "Micro-Planner" Logic Pipeline.
 * Synthesizes the execution DAG utilizing the 14B or 32B model, and explicitly enforces 
 * architectural guidelines by aggressively auditing all 1.5B edge worker node outputs.
 */

import { chatJson, streamJsonArray } from '../llm.js';
import { envOr } from '../config.js';
import { findDecomposition } from './error_memory.js';
import fs from 'node:fs/promises';
import crypto from 'crypto';
import path from 'path';
import { HARDWARE_MODELS, OLLAMA_HOSTS } from './hardware.js';

/**
 * Plan the swarm execution by synthesizing an appropriate Director or Joint Council,
 * then generating a Directed Acyclic Graph (DAG) of tasks mapped to specialized personas.
 *
 * @param {string} domain - The project or domain context (e.g. "homelab").
 * @param {string} intent - The intent or goal.
 * @param {string} taskString - The raw user task/request.
 * @param {Map} contextMap - Map of available personas/tools.
 * @param {Array} [history=[]] - Execution history.
 * @returns {Promise<Object>} The resolved plan (steps or done state).
 */
export async function identifySwarmPhases(taskString) {
  console.log('[Meta-Routing] Identifying optimal Domain-Director phases...');
  const apiKey = envOr('GEMINI_API_KEY', null, process.env.GEMINI_API_KEY);
  const apiConfig = {
      provider: 'gemini',
      model: envOr('GEMINI_FAST_MODEL', null, 'gemini-2.5-flash-lite'),
      apiKey: apiKey,
      maxTokens: 2000,
      temperature: 0.2
  };

  const FAST_DOMAINS = {
      deploy:  { persona: 'builder-manager',   skill: 'Infrastructure deployment and container orchestration.' },
      health:  { persona: 'guardian-manager',   skill: 'Fleet stability, node monitoring, and hardware safety.' },
      debug:   { persona: 'forensic-manager',   skill: 'Deep system visibility, log analysis, and root cause identification.' },
      backup:  { persona: 'builder-manager',    skill: 'Database backup/restore and data lifecycle management.' },
      audit:   { persona: 'forensic-manager',   skill: 'Code quality audits, security scanning, and standards enforcement.' },
      thermal: { persona: 'guardian-manager',   skill: 'Thermal monitoring and emergency workload shedding.' },
      disk:    { persona: 'guardian-manager',   skill: 'Disk usage analysis and storage reclamation.' },
      update:  { persona: 'builder-manager',    skill: 'Container image updates and rolling restarts.' }
  };

  const taskLower = taskString.toLowerCase();
  const userRequestMatch = taskLower.match(/\[user request\]\s*(.*)/s);
  const matchTarget = userRequestMatch ? userRequestMatch[1] : taskLower;
  const fastMatch = Object.entries(FAST_DOMAINS).find(([keyword]) => new RegExp(`\\b${keyword}\\b`).test(matchTarget));
  
  if (fastMatch) {
      const [keyword, { persona, skill }] = fastMatch;
      console.log(`[Meta-Routing] Fast-path: "${keyword}" → ${persona} (skipping Flash-Lite)`);
      return [{ layerIndex: 0, persona, skill }];
  }

  if (apiConfig.apiKey) {
      try {
          const metaSystem = `You are the Swarm Meta-Router. Analyze the user's task and identify the required discrete phases of execution.
If a project spans layout design and behavioral logic (e.g., standard web/game apps), you MUST separate them into Phase 0 (Structure & Layout) and Phase 1 (Wiring & Logic).

CRITICAL CONSTRAINTS:
1. Output STRICTLY JSON and absolutely nothing else.
2. No conversational filler like "Here are the phases:" or markdown codeblock wrappers outside the JSON syntax.
3. If the user request contains a [HIVE MIND CONTEXT] block, you MUST honor any architectural directions or roles specified within it.

OUTPUT FORMAT (Strict JSON):
{
  "phases": [
    { "layerIndex": 0, "persona": "html-design-architect", "skill": "Builds strict HTML/CSS DOM structures without implementing logical scripting." },
    { "layerIndex": 1, "persona": "js-logic-director", "skill": "Implements JS logic and wires it." }
  ]
}`;
          const metaResponse = await chatJson(metaSystem, `TASK:\n${taskString}`, apiConfig);
          if (metaResponse.phases && Array.isArray(metaResponse.phases) && metaResponse.phases.length > 0) {
              console.log(`[Meta-Routing] Synthesized ${metaResponse.phases.length} sequential execution phases.`);
              return metaResponse.phases.sort((a,b) => a.layerIndex - b.layerIndex);
          }
      } catch (e) {
          console.warn(`[Meta-Routing] Flash-Lite unavailable or failed, falling back to generic Director. (${e.message})`);
      }
  }

  console.log(`[Meta-Routing] Using generic single-phase fallback Director.`);
  return [{ layerIndex: 0, persona: 'Engineering Director', skill: 'General engineering orchestration and task decomposition' }];
}

/**
 * Tier 0.5 Pre-Execution DAG Audit (Actor-Critic Auto-correction phase)
 * Evaluates a chunk of micro-steps belonging to a specific component. Uses the 32B cluster to critique redundant or missing logic.
 * @param {Array} originalSteps Array of task definitions 
 * @param {string} hiveMindContext Hive Mind constraints to enforce
 * @returns {Promise<{approved: boolean, critique?: string}>} The Audit critique response
 */
export async function auditDAGArchitecture(originalSteps, componentId, hiveMindContext = '') {
    if (!originalSteps || originalSteps.length === 0) return { approved: true };
    
    console.log(`\n[Tier 0.5 Architect Audit] Initiating verification of ${originalSteps.length} tasks for '${componentId}' across unified CPU orchestration...`);
    
    const lbUrl = envOr('CHRYSALIS_32B_URL', null, 'http://127.0.0.1:11435/v1/chat/completions');

    const localConfig = {
        provider: 'ollama',
        apiUrl: lbUrl,
        model: envOr('CHRYSALIS_32B_MODEL', null, HARDWARE_MODELS.WORKER),
        maxTokens: 2000,
        temperature: 0.1,
        responseSchema: {
            type: "object",
            properties: {
                approved: { type: "boolean" },
                critique: { type: "string" }
            },
            required: ["approved"]
        },
        timeout: 600000
    };

    const compressedSteps = originalSteps.map(step => ({
        id: step.id,
        persona: step.persona,
        action_preview: step.action ? step.action.substring(0, 100) + '... (truncated for brevity)' : ''
    }));

    const auditPrompt = `You are a Principal Software Architect.
Review this proposed execution plan (DAG) which generates files specifically for the functional component: '${componentId}'.

PROPOSED PLAN (JSON ARRAY):
${JSON.stringify(compressedSteps, null, 2)}

YOUR TASK (THE CRITIQUE):
1. Ensure there are no overlapping logic files generating the exact same code blocks within this component cluster.
2. Remove any tasks that create empty, unnecessary wrappers if another file inside the cluster already handles the functionality.
3. Call out any massive structural missing files that are absolutely required for this component to work.
4. Verify Strict Integration Physics: If HTML, CSS, and JS files are generated collaboratively, they MUST reference identical IDs, classes, and file paths. Reject the plan if HTML expects id="btn" but JS queries id="button", or if a CSS step hallucinated a class name as a filepath (like .timer-container) instead of a valid file.

CRITICAL JSON RULES:
1. Output STRICTLY JSON without markdown codeblock wrappers or conversational prefixes.
2. If the plan is logically flawless and strictly adheres to constraints, set "approved" to true and omit the critique.
3. If it fails, set "approved" to false, and put your explicit structural fixes inside the "critique" string field.

Example format:
{ "approved": false, "critique": "You created 'game_loop.js' and 'game_engine.js' which overlap. Consolidate them. You also forgot to generate an input listener file." }`;

    const auditUserMessage = `PROJECT CONTEXT & CONSTRAINTS:\n${hiveMindContext}\n\nPROPOSED TASKS PAYLOAD:\n${JSON.stringify(compressedSteps, null, 2)}`;

    try {
        const audit = await chatJson(auditPrompt, auditUserMessage, localConfig);
        if (audit && typeof audit.approved === 'boolean') {
            console.log(`[Tier 0.5 Architect Audit] '${componentId}' evaluation finished. Approved: ${audit.approved}. Critique: ${audit.critique || 'None'}`);
            return audit;
        }
        console.warn(`[Tier 0.5 Architect Audit] 32B returned an invalid JSON object format for '${componentId}'. Yielding true as fallback to bypass timeout limit...`);
        return { approved: true };
    } catch (e) {
        console.error(`[Tier 0.5 Architect Audit] Fatal Error for '${componentId}': ${e.message}. Bypassing audit and executing original DAG...`);
        return { approved: true };
    }
}

export async function streamMacroArchitecture(domain, intent, taskString, contextMap, history = [], jointPersona, jointSkill) {
  const apiKey = envOr('GEMINI_API_KEY', null, process.env.GEMINI_API_KEY);
  const isCouncil = false;


  // --- STAGE 1.5: MEMORY CONSULTATION ---
  let learnedPatternHint = '';
  try {
      const learned = await findDecomposition(taskString);
      if (learned) {
          learnedPatternHint = `\n\nLEARNED PATTERN (from a previous successful execution of a similar task — reused ${learned.timesReused}x):\n${JSON.stringify(learned.decomposition, null, 2)}\nUse this pattern as a starting template. Adapt file paths and specifics to the current task.`;
          console.log(`[Director] Found learned decomposition pattern (reused ${learned.timesReused}x)`);
      }
  } catch (e) {
      console.warn(`[Director] Memory consultation failed (non-fatal): ${e.message}`);
  }

  // --- STAGE 2: MACRO-PLANNING (RTX 3060 - 12GB) ---
  // --- STAGE 1.5: VISIONARY ARCHITECT (Gemma 4) ---
  const header = isCouncil 
      ? `You represent a ${jointPersona} for ${domain}.\nYour combined deep domain expertise includes: ${jointSkill}`
      : `You are the ${jointPersona} for ${domain}.\nYour deep domain expertise is: ${jointSkill}`;

  const visionSystem = `${header}
You are the Principal Visionary Architect. Your entire job is to read the user task, along with any project context, and reason deeply about the absolute best way to build this.
Spend time thinking about architecture, tradeoffs, files, and flow. 
EXTREMELY IMPORTANT: You are STRICTLY confined to your assigned Persona Domain.
1. Ignore parts of the user request that fall outside your domain expertise.
2. Produce a dense, structural master plan formatted cleanly so Component Engineers can chunk it later.
3. Do NOT include redundant conversational wrappers (e.g. "Sure, I can help" or "Here is what I recommend"). Output purely your final architectural approach.`;

  const visionUserMessage = `TASK:\n"${taskString}"\n${learnedPatternHint}\nEXECUTION HISTORY:\n${JSON.stringify(history, null, 2)}`;

  let visionText = '';
  try {
      console.log("[Visionary] Gemma 4 (E4B) generating broad architecture on RTX 3060...");
      const visionConfig = {
          provider: 'gemini',
          model: envOr('CHRYSALIS_VISION_MODEL', null, 'gemini-2.5-pro'),
          apiKey: apiKey,
          maxTokens: 3000,
          temperature: 0.6
      };
      // For now, if Gemma is missing we will gracefully fallback to Qwen inside chatJson if it errors
      visionText = await chatJson(visionSystem, visionUserMessage, visionConfig);
      // Clean up <think> blocks for the downstream context so they don't get bloated context, or maybe keep them? 
      // Actually keep them, they are valuable context.
      if (typeof visionText === 'object') visionText = JSON.stringify(visionText);
  } catch(e) {
      console.warn(`[Visionary] Gemma 4 failed (${e.message}). Falling back to local model...`);
      visionText = await chatJson(visionSystem, visionUserMessage, {
          provider: 'ollama',
          apiUrl: envOr('CHRYSALIS_DIRECTOR_URL', null, 'http://localhost:11434/v1/chat/completions'),
          model: envOr('CHRYSALIS_DIRECTOR_MODEL', null, HARDWARE_MODELS.DIRECTOR),
          maxTokens: 2000,
          temperature: 0.6
      });
  }

  // --- STAGE 2: MACRO-PLANNING (Qwen 14B - STREAMING) ---
  const macroSystem = `${header}
You are the Macro-Planner (Component Engineer). Distill the Principal Architect's vision into High-Level Macro Components.

OUTPUT FORMAT (Strict Text Protocol):
1. Do NOT wrap output in markdown codeblocks. 
2. Do NOT add ANY conversational text before or after the component definitions.

Use EXACTLY the following structure for each component:
[COMPONENT] name-of-component
Description of what this component is responsible for.

Example:
[COMPONENT] frontend-ui
Responsible for index.html and style.css design.
[COMPONENT] backend-server
Responsible for server.js API endpoints.`;

  const macroUserMessage = `VISION MASTER PLAN:\n${visionText}\n\nExtract the components using the specified format.`;

  const localConfig = {
      provider: 'gemini',
      model: envOr('CHRYSALIS_MACRO_MODEL', null, 'gemini-2.5-pro'),
      apiKey: apiKey,
      maxTokens: 2000,
      temperature: 0.1
  };

  const coreIntentMatch = taskString.match(/\[USER REQUEST\]\s*(.*)/is);
  const coreIntent = coreIntentMatch ? coreIntentMatch[1] : taskString.slice(0, 1000);

  return { 
      status: 'MACRO_STREAMING', 
      jointPersona,
      jointSkill,
      coreIntent,
      visionText,
      activeTaskString: taskString,
      componentsStream: (async function* () {
          let retries = 0;
          while (retries < 3) {
              try {
                  console.log("[Macro-Planner] Qwen-2.5 (14B) streaming [COMPONENT] blocks on RTX 3060...");
                  // Import the new streamProtocolBlocks here
                  const { streamProtocolBlocks } = await import('../llm.js');
                  const stream = streamProtocolBlocks(macroSystem, macroUserMessage, localConfig, { timeout: 900000 });
                  
                  let yieldedAny = false;
                  for await (const chunk of stream) {
                      if (chunk.type === 'COMPONENT') {
                          yieldedAny = true;
                          
                          // Format to match old component object for compatibility
                          const parts = chunk.content.split('\n');
                          const id = parts[0];
                          const desc = parts.slice(1).join('\n').trim();
                          if (id) {
                              yield { id, description: desc };
                          }
                      }
                  }
                  
                  if (!yieldedAny) {
                      throw new Error("Missing or empty [COMPONENT] blocks in stream.");
                  }
                  return; // Successfully finished stream
                  
              } catch (e) {
                  retries++;
                  if (retries >= 3) {
                      if (apiConfig.apiKey) {
                          console.log(`[Macro-Planner] Local models failed 3x. Escalating to Gemini Flash Stream...`);
                          const { streamProtocolBlocks } = await import('../llm.js');
                          const flashStream = streamProtocolBlocks(macroSystem, macroUserMessage, apiConfig);
                          for await (const chunk of flashStream) {
                              if (chunk.type === 'COMPONENT') {
                                  const parts = chunk.content.split('\n');
                                  yield { id: parts[0], description: parts.slice(1).join('\n').trim() };
                              }
                          }
                          return;
                      }
                      throw new Error(`Director macro-streaming failed after 3 attempts: ${e.message}`);
                  }
                  console.warn(`[Macro-Planner Retry ${retries}/3] Validation failed: ${e.message}`);
              }
          }
      })()
  };
}

/**
 * Micro-Planning: Breaks a specific Macro Component down into File-level Atomic Steps.
 * Streamed directly from the 12GB Director node using the Qwen 14B model!
 */
export async function* planMicroSteps(domain, jointPersona, jointSkill, coreIntent, component, visionText = '', previousCritique = null, hiveMindContext = '') {
  const header = jointPersona.includes('Council') 
      ? `You represent a ${jointPersona} for ${domain}.\nYour combined deep domain expertise includes: ${jointSkill}`
      : `You are the ${jointPersona} for ${domain}.\nYour deep domain expertise is: ${jointSkill}`;

  const apiKey = envOr('GEMINI_API_KEY', null, process.env.GEMINI_API_KEY);
  const localDirector = 'http://127.0.0.1:11434/v1/chat/completions';
  const lbUrl = envOr('CHRYSALIS_PLANNER_URL', null, localDirector);

  const localConfig = {
      provider: 'ollama',
      apiUrl: lbUrl,
      model: HARDWARE_MODELS.DIRECTOR,
      maxTokens: 4000,
      temperature: 0.1
  };
  
  const apiConfig = {
      provider: 'gemini',
      model: envOr('GEMINI_FAST_MODEL', null, 'gemini-2.5-flash-lite'),
      apiKey: apiKey,
      maxTokens: 2000,
      temperature: 0.2
  };

  const microSystem = `${header}
You are the Micro-Planner (Step Engineer). The Principal Architect has designed the following Master Vision:
${visionText || '(No vision provided)'}

You have been assigned the following Macro Component:
[COMPONENT] ${component.id}
${component.description || ''}

Your job is to break this component down into granular, atomic execution steps targeting appropriate worker personas.

CRITICAL RULES:
1. You MUST heavily distill exact code snippets directly into the 'Action' payload for the downstream worker.
2. The downstream 3B models are weak translation typists suffering from context overload. NEVER give them open-ended instructions like "build the game logic". Write the ACTUAL literal code chunks (5-15 lines max) inside the Action!
3. Each step MUST produce exactly ONE atomic chunk of code.
4. ABSOLUTELY NO PLACEHOLDER PATHS. Do NOT invent subdirectories. Provide exact strict absolute filenames. DO NOT MENTION the big picture (e.g., "Build a Snake Game"), ONLY provide the literal snippet to write.
5. You MUST '<think>' out loud and deeply analyze the codebase structure and layout before streaming the [STEP] blocks. Wrap your rationalization in <think>...</think> tags.
6. INSIDE your 'Action', DO NOT wrap your code in JSON or \`write_file {}\` syntax! Simply state: "Write the following exact code to [absolute full file path]:" followed by the raw code block. NEVER use CSS selectors like .timer-container or generic logic strings as your absolute path.
7. ENFORCE INTERFACE CONTRACT: Before streaming your atomic steps, you MUST use your <think> block to definitively register exactly which filenames you will output and explicitly list the shared IDs/Classes/Functions they must share. You must strictly use the exact filenames and bindings you just registered in your steps. Never generate orphan variations (e.g., creating both style.css and styles.css).
8. HIVE MIND COMPLIANCE: Adhere strictly to the rules, patterns, and established architecture specified in the project context.
9. NO CONVERSATIONAL TAILS: When you are finished formatting your last [STEP] block, STOP IMMEDIATELY. Do NOT append helpful concluding statements like "This will build your game."
10. HYBRID GRAPH (PATTERN 1): If a step is purely mechanical (e.g. running an exact shell command, compiling, or executing a safe script without any code generation), you MUST set Persona to: 'deterministic-executor'. The Action MUST be EXACTLY the bash command string to run without markdown wrappers.

OUTPUT FORMAT (Strict Text Protocol):
You must format EACH individual step using EXACTLY these 4 lines and IN THIS EXACT ORDER. Do NOT add conversational text between steps! Do NOT put instructions on the same line as the [STEP] header. Use a strict snake_case ID for the step name.

[STEP] unique_step_id_without_spaces
Persona: exact-persona-name
DependsOn: prev_step_id
Action: Write the following exact code to /path/to/file:
\`\`\`file_extension
raw code here
\`\`\`

Example:
[STEP] ${component.id}_create_html
Persona: html-developer
DependsOn: 
Action: Create index.html focusing strictly on writing exactly:
\`\`\`html
<!DOCTYPE html><html><body><canvas id="gameCanvas"></canvas></body></html>
\`\`\``;

  let userMessage = `PROJECT CONTEXT & CONSTRAINTS:\n${hiveMindContext}\n\nCORE TASK: ${coreIntent}\n\nCRITICAL INSTRUCTION: Read the HIVE MIND CONTEXT, but DO NOT output your action plan as a JSON object, and DO NOT copy the DAG_BLUEPRINT arrays you see in memory. You MUST format the output using ONLY the exact [STEP] ... Persona: ... DependsOn: ... Action: ... format provided in your system instructions. Break the macro component into atomic atomic text blocks now.`;
  
  if (previousCritique) {
      userMessage += `\n\n[CRITIQUE FROM ARCHITECT]:\nYour previous execution plan for this component was REJECTED by the Principal Architect. You MUST completely regenerate the steps for this component, ensuring you address the following feedback strictly:\n${previousCritique}`;
  }

  let retries = 0;
  while (retries < 3) {
      try {
          console.log(`[Micro-Planner] RTX 3060 Director streaming [STEP] blocks for ${component.id}...`);
          const { streamProtocolBlocks } = await import('../llm.js');
          const stream = streamProtocolBlocks(microSystem, userMessage, localConfig, { timeout: 900000 });
          
          let yieldedAny = false;
          for await (const chunk of stream) {
              if (chunk.type === 'STEP') {
                  const parts = chunk.content.trim().split('\n');
                  let id = `step_${Math.random().toString(36).substring(7)}`; 
                  let persona = 'engineering-worker';
                  let depends_on = [];
                  let action = '';

                  for (let i = 0; i < parts.length; i++) {
                      const line = parts[i].trim();
                      if (!line) continue;
                      if (!line.includes(':') && i === 0 && !line.startsWith('`')) id = line; // Catch typical id placement
                      else if (line.startsWith('Persona:')) persona = line.substring(8).trim();
                      else if (line.startsWith('DependsOn:')) {
                           const deps = line.substring(10).trim();
                           if (deps && deps !== 'none' && deps !== 'null') depends_on = deps.split(',').map(d => d.trim());
                      }
                      else if (line.startsWith('Action:')) action = line.substring(7).trim();
                      else if (action) action += '\n' + line;
                  }
                  
                  if (id && action) {
                      yieldedAny = true;
                      yield { id, persona, action, depends_on };
                  }
              }
          }
          
          if (!yieldedAny) {
              throw new Error("Missing or empty [STEP] blocks in stream.");
          }
          return; // Successfully finished stream
          
      } catch (e) {
          retries++;
          if (retries >= 3) {
              if (apiConfig.apiKey) {
                  console.log(`[Micro-Planner] Local models failed 3x. Escalating to Gemini Flash Stream...`);
                  const { streamProtocolBlocks } = await import('../llm.js');
                  const flashStream = streamProtocolBlocks(microSystem, userMessage, apiConfig);
                  for await (const chunk of flashStream) {
                      if (chunk.type === 'STEP') {
                          const parts = chunk.content.split('\n');
                          const id = parts[0].trim();
                          let persona = 'engineering-worker';
                          let depends_on = [];
                          let action = '';

                          for (let i = 1; i < parts.length; i++) {
                              const line = parts[i].trim();
                              if (line.startsWith('Persona:')) persona = line.substring(8).trim();
                              else if (line.startsWith('DependsOn:')) {
                                   const deps = line.substring(10).trim();
                                   if (deps && deps !== 'none' && deps !== 'null') depends_on = deps.split(',').map(d => d.trim());
                              }
                              else if (line.startsWith('Action:')) action = line.substring(7).trim();
                              else if (action) action += '\n' + line;
                          }
                          yield { id, persona, action, depends_on };
                      }
                  }
                  return;
              }
              console.error(`[Micro-Planner] Failed to plan component ${component.id} after 3 retries: ${e.message}`);
              return; // Skip gracefully instead of crashing
          }
          console.warn(`[Micro-Planner Retry ${retries}/3] Validation failed: ${e.message}`);
      }
  }

}

/**
 * Director audits a completed worker's output for quality.
 * Uses the 14b model on RTX 3060 to evaluate whether the 3B worker's
 * output is complete, correct, and matches the requested action.
 * 
 * If the audit fails, returns re-decomposed sub-steps for retry.
 *
 * @param {Object} step - The DAG step that was executed
 * @param {string} result - The worker's output
 * @param {Array} allSteps - Full DAG for cross-reference context
 * @param {string} hiveMindContext - Hive Mind context parameters
 * @returns {Promise<{pass: boolean, reason?: string, subSteps?: Array}>}
 */
export async function auditStepResult(step, result, allSteps, hiveMindContext = '') {
    // Fast-path: obvious failures
    if (!result || (typeof result === 'string' && result.trim().length < 10)) {
        return {
            pass: false,
            reason: 'Empty or near-empty output',
            subSteps: [{ ...step, id: `${step.id}_retry`, action: `${(step.action || '').split('\n\nPREVIOUS ATTEMPT FAILED:')[0]}\n\nPREVIOUS ATTEMPT FAILED: Output was empty. Try again with complete implementation.` }]
        };
    }

    // Fast-path: Conversational hallucination filter
    const lowerResult = typeof result === 'string' ? result.toLowerCase() : JSON.stringify(result).toLowerCase();
    const conversationalTriggers = [
        /^great!/i, /^sure\b/i, /^here is/i, /^i can help/i, /^certainly/i, /^please provide/i, /feel free to/i, /let me know if/i
    ];
    
    if (conversationalTriggers.some(regex => regex.test(lowerResult))) {
        return {
            pass: false,
            reason: 'Conversational hallucination detected',
            subSteps: [{ ...step, id: `${step.id}_retry`, action: `${(step.action || '').split('\n\nPREVIOUS ATTEMPT FAILED:')[0]}\n\nPREVIOUS ATTEMPT FAILED: Your output contained conversational filler or invalid formatting. You are an API. Output STRICTLY syntax, code, or exact JSON. NO conversational text allowed.` }]
        };
    }

    // Attempt to pull LIVE file context if a file was modified
    let liveFileContext = '';
    try {
        // Look for any absolute Unix path in the original action or the tools JSON output
        const combinedText = String(step.action) + ' ' + String(typeof result === 'string' ? result : JSON.stringify(result));
        const pathMatch = combinedText.match(/(\/(?:mnt|home|var|usr|opt|etc|tmp)[\/\w\.-]+(?![\w.-]))/);
        
        if (pathMatch && pathMatch[1]) {
            const filePath = pathMatch[1];
            // Read up to 8k chars to prevent blowing out 32B context window on massive files
            const fullStr = await fs.readFile(filePath, 'utf8');
            liveFileContext = `\n\n=== LIVE TARGET FILE STATE (${filePath}) ===\n${fullStr.length > 8000 ? '[TRUNCATED] ...' + fullStr.substring(fullStr.length - 8000) : fullStr}\n=====================================\n`;
        }
    } catch (e) {
        liveFileContext = `\n\n[Note: Could not pull live file context: ${e.message}]`;
    }

    const defaultAuditors = OLLAMA_HOSTS.kruschgame + '/v1/chat/completions'; // Fast GPU 3B Validator (kruschgame)
    const auditorUrls = envOr('CHRYSALIS_AUDITOR_URLS', null, defaultAuditors).split(',');
    const lbUrl = auditorUrls[Math.floor(Math.random() * auditorUrls.length)].trim();

    let chosenModel = envOr('CHRYSALIS_AUDITOR_MODEL', null, HARDWARE_MODELS.WORKER);
    if (lbUrl.includes('10.0.0.228')) {
        chosenModel = chosenModel.includes('14b') ? 'qwen2.5-coder:14b-cpu' : chosenModel; // Force CPU model to prevent iGPU shader panics on kr1yoga
    }

    // Use Fast Node (3B) for intermediate syntax verification
    const localConfig = {
        provider: 'ollama',
        apiUrl: lbUrl,
        model: chosenModel,
        maxTokens: 1500,
        temperature: 0.1,
        responseSchema: {
            type: "object",
            properties: {
                pass: { type: "boolean" },
                reason: { type: "string" },
                sub_tasks: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            id: { type: "string" },
                            action: { type: "string" },
                            task: { type: "string" }
                        },
                        required: ["id"]
                    }
                }
            },
            required: ["pass"]
        },
        timeout: 600000
    };

    const auditPrompt = `You are a Strict Code Output Verifier (3B). Evaluate the 1.5B/3B edge worker's file modification.

ORIGINAL TASK: ${step.action}

WORKER LOGS:
${typeof result === 'string' ? result.slice(0, 1000) : JSON.stringify(result).slice(0, 1000)}${liveFileContext}

MISSION (CHECK FOR HALLUCINATIONS):
1. Did the worker completely mangle the file or fail to output the requested code?
2. Are there syntax errors or "insert code here" placeholders instead of actual logic?

CRITICAL JSON RULES:
1. STRICT JSON ONLY. NO MARKDOWN \`\`\` wrappers. NO conversational text.
2. PASS schema: {"pass": true}
3. FAIL schema: {"pass": false, "reason": "Detailed failure context", "sub_tasks": [{"id": "unique_id", "action": "Specific instructions for the retry"}]}

CRITICAL RULE FOR FAILURES: If the worker mangled the file, your sub_tasks MUST order the retry to ONLY use the \`inject_code\` tool. Provide exact 1-3 line \`target_anchor\` strings from the LIVE FILE State.`;

    try {
        const auditUserMsg = `PROJECT CONTEXT & CONSTRAINTS:\n${hiveMindContext}\n\nValidate the live state output.`;
        const audit = await chatJson(auditPrompt, auditUserMsg, localConfig);
        if (audit.pass) return { pass: true };

        const subSteps = (audit.sub_tasks || []).map((st, i) => ({
            id: `${step.id}_sub${i}`,
            persona: step.persona,
            action: st.action || st.task,
            depends_on: i > 0 ? [`${step.id}_sub${i - 1}`] : [],
            node_affinity: step.node_affinity
        }));

        return {
            pass: false,
            reason: audit.reason || 'Audit failed',
            subSteps: subSteps.length > 0 ? subSteps : [{
                ...step,
                id: `${step.id}_retry`,
                action: `${(step.action || '').split('\n\nPREVIOUS ATTEMPT FAILED:')[0]}\n\nPREVIOUS ATTEMPT FAILED: ${audit.reason}. Fix the issues and produce complete output.`
            }]
        };
    } catch (e) {
        console.warn(`[Audit] Director audit failed (${e.message}), passing by default`);
        return JSON.parse(responseText);
  }
}

/**
 * Phase 2 Integration Audit (Macro-Auditor)
 * Evaluates the fully compiled codebase to verify cohesive physical logic between all output files.
 * Native binding to 32B for max context window and reasoning.
 * @param {string} workingDir The root directory containing the compiled files
 * @param {string} hiveMindContext Hive Mind context wrapper
 * @returns {Promise<{approved: boolean, critique?: string}>}
 */
export async function auditIntegrationArchitecture(workingDir, hiveMindContext = '') {
    if (!workingDir) return { approved: true, critique: 'No working directory provided.' };
    console.log(`\n[Phase 2 Integration Audit] Consolidating codebase payload from ${workingDir}...`);
    
    let consolidatedCode = '';
    try {
        const files = await fs.readdir(workingDir);
        for (const file of files) {
            const ext = path.extname(file).toLowerCase();
            if (['.html', '.css', '.js', '.json', '.md'].includes(ext)) {
               const content = await fs.readFile(path.join(workingDir, file), 'utf-8');
               consolidatedCode += `\n\n--- ${file} ---\n${content}`;
            }
        }
    } catch (e) {
        return { approved: false, critique: `Failed to read finalized working directory: ${e.message}` };
    }

    if (!consolidatedCode.trim()) return { approved: true, critique: 'No code files generated to audit.' };

    const prompt = `You are the Final Tier Integration Auditor for the Chrysalis Swarm.
Your task is to review the complete, fully-compiled codebase below and verify that the files logically integrate properly.
Look specifically for "Integration Physics" errors:
1. Do HTML IDs/classes match the exact strings used in CSS?
2. Does the JavaScript logic query the correct DOM elements as written in the HTML?
3. Are there any missing assets, malformed connections, or architectural regressions between the files?
4. Have the architectural constraints listed in the HIVE MIND CONTEXT been obeyed?

Codebase Payload:
${consolidatedCode}

If the files accurately connect into a functionally cohesive application and honor constraints, return {"approved": true}.
If there are mathematical integration failures (e.g. mismatched class names, orphaned logic) or constraint violations, return {"approved": false, "critique": "Explain exactly what failed cross-file integration"}.`;

    const lbUrl = envOr('CHRYSALIS_32B_URL', null, 'http://127.0.0.1:11435/v1/chat/completions');

    const config = {
        provider: 'ollama',
        apiUrl: lbUrl,
        model: envOr('CHRYSALIS_32B_MODEL', null, HARDWARE_MODELS.WORKER),
        maxTokens: 1000,
        temperature: 0.1,
        responseSchema: {
            type: "object",
            properties: {
                approved: { type: "boolean" },
                critique: { type: "string" }
            },
            required: ["approved"]
        },
        timeout: 900000
    };

    console.log(`[Phase 2 Integration Audit] Transmitting massively compiled codebase payload (~${Math.round(consolidatedCode.length / 4)} tokens) to Orchestrator Node...`);
    try {
        const userMsg = `PROJECT CONTEXT & CONSTRAINTS:\n${hiveMindContext}\n\n${prompt}`;
        const result = await chatJson(
            'You are the Phase 2 Integration Auditor. Output JSON only.',
            userMsg,
            config
        );
        return result;
    } catch (e) {
        return { approved: false, critique: `Phase 2 Audit Exception: ${e.message}` };
    }
}
