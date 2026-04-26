/**
 * @module dispatch
 * Multi-Node Physical Hardware Task Router.
 * Orchestrates the dispatch of specific autonomous payload blocks to exactly mapped IP endpoints.
 * Handles fast-failure detection and robustly intercepts API hallucination wrappers.
 */

import { validateCommand, validateRemoteCommand, getAllowlistDescription, getTimeout } from './allowlist.js';
import { chatWithTools } from '../llm.js';
import { parseAIJson } from '../json-parse.js';
import { findResolution, recordResolution, extractSignature } from './error_memory.js';
import { loadTools } from './tools/index.js';
import { resolveToolsets } from './tools/skills.js';
import fs from 'node:fs/promises';
import { getProjectScratchpad } from '../brain/memory_controller.js';
import { OLLAMA_HOSTS, HARDWARE_MODELS } from './hardware.js';

/** TTL-based tool cache — refreshes MCP handshakes after staleness window */
const TOOL_CACHE_TTL_MS = 5 * 60_000; // 5 minutes
let _cachedTools = null;
let _cachedToolsAt = 0;

async function getCachedTools() {
    const now = Date.now();
    if (!_cachedTools || (now - _cachedToolsAt > TOOL_CACHE_TTL_MS)) {
        if (_cachedTools) console.log('[Tool Cache] TTL expired, refreshing tools + MCP handshakes...');
        _cachedTools = await loadTools();
        _cachedToolsAt = now;
    }
    return _cachedTools;
}

/**
 * Resets the TTL-based tool cache, forcing a refresh of MCP handshakes
 * and tool schemas on the next dispatch cycle.
 */
export function refreshTools() {
    _cachedTools = null;
    _cachedToolsAt = 0;
}

const TOOL_TIMEOUT_MS = 30_000;
const CB_FILE = '/tmp/chrysalis_circuit_breaker.json';
const CB_THRESHOLD = 3;
const CB_COOLDOWN_MS = 60_000;

async function getCircuitBreaker() {
    try { return JSON.parse(await fs.readFile(CB_FILE, 'utf-8')); } catch { return {}; }
}
async function saveCircuitBreaker(state) {
    try { await fs.writeFile(CB_FILE, JSON.stringify(state)); } catch {}
}
async function isCircuitOpen(nodeKey) {
    const cbState = await getCircuitBreaker();
    const cb = cbState[nodeKey];
    if (!cb || cb.failures < CB_THRESHOLD) return false;
    if (Date.now() - cb.openedAt > CB_COOLDOWN_MS) {
        delete cbState[nodeKey]; await saveCircuitBreaker(cbState);
        console.log(`[CircuitBreaker] ${nodeKey} reset after cooldown.`);
        return false;
    }
    return true;
}
async function recordFailure(nodeKey) {
    const cbState = await getCircuitBreaker();
    const cb = cbState[nodeKey] || { failures: 0, openedAt: 0 };
    cb.failures++;
    if (cb.failures >= CB_THRESHOLD && cb.openedAt === 0) {
        cb.openedAt = Date.now();
        console.warn(`[CircuitBreaker] ${nodeKey} OPEN — ${CB_THRESHOLD} consecutive failures. Cooldown ${CB_COOLDOWN_MS / 1000}s.`);
    }
    cbState[nodeKey] = cb; await saveCircuitBreaker(cbState);
}
async function recordSuccess(nodeKey) {
    const cbState = await getCircuitBreaker();
    if (cbState[nodeKey]) { delete cbState[nodeKey]; await saveCircuitBreaker(cbState); }
}


/* --- Node Routing & Tool Scoping --- */
async function resolveNodeConfig(conf) {
    let nodeKey = conf.node;
    
    // If scheduler didn't assign a specific sub-node, deduce by regex
    if (!nodeKey || nodeKey === 'kruschdev') {
        const name = conf.name ? conf.name.toLowerCase() : '';
        nodeKey = name.match(/chrysalis|sandbox|memory/) ? 'kruschdev_worker' : 
            (name.match(/manager|director|officer|auditor/) ? 'kruschgame' : 'kruschdev_director');
    }

    let hostUrl = OLLAMA_HOSTS[nodeKey];
    if (!hostUrl) throw new Error(`Unknown node key ${nodeKey}`);

    if (await isCircuitOpen(nodeKey)) {
        console.warn(`[CircuitBreaker] ${nodeKey} is OPEN. Falling back to Director Node.`);
        hostUrl = OLLAMA_HOSTS.kruschdev_director || 'http://127.0.0.1:11434';
        conf.base = HARDWARE_MODELS.EDGE_FAST;
    }
    return { nodeKey, hostUrl, conf };
}

async function buildSystemPromptMessages(conf, taskString, contextPayload = null) {
    const proj = conf.project || 'chrysalis';
    const workingDir = conf.working_dir || '/mnt/data2/chrysalis/projects/chrysalis';
     
    let sysPrompt = `You are ${conf.name}, a strict translation typist and hyper-specialized "one-shot" code writer.

YOUR ONLY SKILL / PURPOSE:
${conf.skill}

ONE-SHOT OBJECTIVE:
You have EXACTLY ONE atomic task. You are NOT an architect. Read the literal code snippet provided by the User, and write it to disk.

RULES:
1. NEVER hallucinate additional code not provided in the user prompt. Follow your one-shot objective exactly.
2. NO conversational filler.
3. CRITICAL: NEVER use 'sudo' in shell commands. You have full write permissions.
4. CRITICAL: ALL FILES ARE RELATIVE TO: ${workingDir}. ALWAYS use absolute paths starting with ${workingDir}.
5. THINKER-TYPIST PIPELINE: If you are generating new code or modifying files, you MUST output RAW MARKDOWN code blocks with the '// filepath:' header format. A downstream Typist will convert your markdown to JSON.
6. INTERFACE CONTRACT: You must wrap your reasoning and explicit filename tracking in <think>...</think> tags. NEVER output actual code blocks inside the think tags.
7. STRICT API: DO NOT output conversational text. Only use JSON tool calls if you are reading, listing files, or searching code. Output raw markdown if writing code.
8. DECENTRALIZED TASK GRAPH (DTG): If you fulfill your specialized task and determine that another specialized persona must take over the next logical sequence (e.g. structure is done, someone needs to write logic or style it), output the exact string \`[HANDOFF: persona-name]\` in your response to trigger peer-to-peer routing.`;

    if (contextPayload && contextPayload.TransferProtocol === 'CONTEXTUAL') {
        sysPrompt += `\n\n[TRANSFER PROTOCOL: CONTEXTUAL]\n${JSON.stringify(contextPayload.data, null, 2)}\n`;
    }

    return [
      { role: 'system', content: sysPrompt },
      { role: 'user', content: taskString }
    ];
}

function resolveAllowedTools(conf, allTools) {
    let allowed;
    const name = conf.name.toLowerCase();

    if (Array.isArray(conf.toolsets) && conf.toolsets.length > 0) {
        allowed = new Set(resolveToolsets(conf.toolsets));
        console.log(`[Swarm] ${conf.name}: explicit toolsets [${conf.toolsets.join(', ')}] -> tools [${Array.from(allowed).join(', ')}]`);
    } else if (Array.isArray(conf.tools) && conf.tools.length > 0) {
        allowed = new Set(['search_rules', 'write_shared_memory']);
        conf.tools.forEach(t => allowed.add(t));
        if (allowed.has('write_file')) allowed.add('make_dir');
        console.log(`[Swarm] ${conf.name}: explicit tools [${Array.from(allowed).join(', ')}]`);
    } else if (allTools.some(t => t.function.name === name)) {
        allowed = new Set(['search_rules', 'write_shared_memory']);
        allowed.add(name);
    } else {
        allowed = new Set(['search_rules', 'write_shared_memory', 'read_file', 'write_file', 'inject_code', 'list_dir', 'make_dir']);
        if (name.match(/sys|expert|officer|manager/)) allowed.add('run_safe');
        if (name.match(/researcher|expert|auditor|analyst|manager/)) allowed.add('analyze_code');
        if (name.includes('importer')) { allowed.add('sandbox_import'); allowed.add('sandbox_start'); }
        else if (name.includes('chrysalis')) allowed.add('sandbox_exec');
        else if (name.includes('exporter')) { allowed.add('sandbox_export'); allowed.add('sandbox_stop'); }
    }
    return allTools.filter(t => allowed.has(t.function.name));
}

/* --- JSON Recovery via Typist Nodes --- */
async function chunkAndFormatViaTypist(assistantMsg, personaName, availableTools) {
    if (!assistantMsg.tool_calls) assistantMsg.tool_calls = [];
    if (!assistantMsg.content) return assistantMsg;

    // Fast-path: robustly strip <think> bounds even if the closing tag is hallucinated/missing.
    let text = assistantMsg.content || '';
    if (text.includes('<think>')) {
        // Strip out closed think blocks
        text = text.replace(/<think>[\s\S]*?<\/think>/g, '');
        // If there's STILL an unclosed <think> tag, strip up to the first code block, or end of string
        if (text.includes('<think>')) {
            const codeBlockIndex = text.indexOf('```');
            if (codeBlockIndex !== -1 && codeBlockIndex > text.indexOf('<think>')) {
                 text = text.replace(/<think>[\s\S]*?(?=```)/, '');
            } else {
                 text = text.replace(/<think>[\s\S]*/, '');
            }
        }
    }
    text = text.trim();
    const interceptorRegex = /```[\w-]*\n(?:\/\/|#|<!--|\/\*)\s*filepath:\s*(\/.*?)\s*(?:-->|\*\/)?\n(?:(?:\/\/|#|<!--|\/\*)\s*action:\s*(append)\s*(?:-->|\*\/)?\n)?([\s\S]*?)(?:```|$)/gi;
    let match;
    const chunkPromises = [];

    while ((match = interceptorRegex.exec(text)) !== null) {
        const filePath = match[1].trim();
        const doAppend = match[2] === 'append';
        let codeContent = match[3];

        const typistPrompt = `You are an inert terminal Typist parser. You do not reason. You do not answer questions.
You accept [RAW CODE] blocks and strictly output a valid JSON \`write_file\` tool call payload.
DO NOT output conversational filler. Format this input into the perfect strict JSON action payload.`;

        const typistInput = `// filepath: ${filePath}\n// action: ${doAppend ? 'append' : 'write'}\n${codeContent}`;

        const typistConfig = {
            provider: 'ollama',
            // Defaulting Typist to the designated Kruschdev Worker Node matching the user's mapping
            apiUrl: 'http://127.0.0.1:11435/v1/chat/completions',
            model: HARDWARE_MODELS.EDGE_FAST,
            tools: availableTools.filter(t => t.function.name === 'write_file' || t.function.name === 'inject_code'),
            maxTokens: 8000,
            temperature: 0.1
        };

        chunkPromises.push(async () => {
            try {
                console.log(`[Typist Swarm] Dispatching chunk for ${filePath} to Typist Edge Node (1.5B)...`);
                const typistRes = await chatWithTools(typistConfig, [
                    { role: 'system', content: typistPrompt },
                    { role: 'user', content: typistInput }
                ], typistConfig.tools);

                if (typistRes.tool_calls && typistRes.tool_calls.length > 0) {
                     return typistRes.tool_calls[0];
                } else if (typistRes.content) {
                     let raw = typistRes.content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
                     const first = raw.indexOf('{');
                     const last = raw.lastIndexOf('}');
                     if (first !== -1 && last > first) {
                         raw = raw.substring(first, last + 1);
                         const parsed = parseAIJson(raw, { allowPartial: true });
                         if (parsed.name && (parsed.arguments || parsed.args)) {
                             return {
                                 id: 'call_' + Math.random().toString(36).substring(2, 9),
                                 type: 'function',
                                 function: { name: parsed.name, arguments: JSON.stringify(parsed.arguments || parsed.args || {}) }
                             };
                         }
                     }
                }
            } catch (e) {
                console.error(`[Typist Swarm] Typist JSON Formatting failed for ${filePath}: ${e.message}`);
            }
            // Algorithmic Fallback ensures we never lose complex generation if the 1.5b LLM choked on a formatting comma
            return {
                id: 'call_' + Math.random().toString(36).substring(2, 9),
                type: 'function',
                function: { name: 'write_file', arguments: JSON.stringify({ path: filePath, content: codeContent, append: doAppend }) }
            };
        });
    }

    // Process sequentially to protect 4GB VRAM nodes from OOM parallel thrashing
    for (const typistTask of chunkPromises) {
        const tc = await typistTask();
        if (tc) assistantMsg.tool_calls.push(tc);
    }

    text = text.replace(interceptorRegex, '').trim();
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    
    // Direct legacy parsing logic for non-filepath JSON envelopes (commands, analysis tools)
    const firstObj = text.indexOf('{');
    const firstArr = text.indexOf('[');
    const first = Math.min(firstObj !== -1 ? firstObj : Infinity, firstArr !== -1 ? firstArr : Infinity);
    const last = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
    
    if (first !== Infinity && last > first) {
        text = text.substring(first, last + 1);
    }
    if (text.includes('{"name"') || (text.includes('{') && (text.includes('arguments') || text.includes('args')))) {
        try {
            let parsed = parseAIJson(text, { allowPartial: true });
            if (parsed.raw && parsed.parseError) throw new Error("Partial parse error");
            if (!Array.isArray(parsed)) parsed = [parsed];
            if (parsed.length > 0 && parsed[0].name && (parsed[0].arguments || parsed[0].args)) {
                assistantMsg.tool_calls.push(...parsed.map(p => ({
                    id: 'call_' + Math.random().toString(36).substring(2, 9), type: 'function',
                    function: {  name: p.name, arguments: JSON.stringify(p.arguments || p.args || {}) }
                })));
                assistantMsg.content = null;
            }
        } catch (e) {
            console.warn(`[Swarm] JSON fallback recovery failed for ${personaName} (${e.message})`);
        }
    }
    return assistantMsg;
}

/* --- Execution Engine --- */
async function executeToolCalls(assistantMsg, conf, executors, messages) {
    let lastResultStr = null;
    const isRemote = conf.node && !conf.node.startsWith('kruschdev');
    const remoteCmd = (c) => `ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=no ${conf.node} "${c.replace(/"/g, '\\"')}"`;  

    for (const call of assistantMsg.tool_calls) {
        let name = call.function.name;
        if (name === 'execute_safe' || name === 'exec_run_safe') name = 'run_safe';
        if (name === 'read_file_content' || name.includes('read_file')) name = 'read_file';
        if (name === 'write_to_file' || name.includes('write_file') || name === 'create_file') name = 'write_file';
        if (name === 'mkdir' || name === 'create_dir') name = 'make_dir';

        let args = call.function.arguments || {};
        if (typeof args === 'string') try { args = JSON.parse(args); } catch(e) { args = {}; }
        for (const [k, v] of Object.entries(args)) {
            if (typeof v === 'string') {
                let val = v.includes('$output') ? v.replaceAll('$output', () => lastResultStr || '') : v;
                if (k === 'command' && val.trim().startsWith('sudo ')) {
                    val = val.trim().substring(5).trim();
                    console.log(`[Swarm Security] Stripped hallucinated 'sudo' from command`);
                }
                args[k] = val;
            }
        }

        console.log(`[Swarm] ${conf.name} → ${name}(${JSON.stringify(args).slice(0, 80)})`);
        if (!executors.has(name)) {
            console.error(`❌ [Swarm Error] Schema tool mismatch: ${name}`);
            messages.push({ role: 'tool', name, content: JSON.stringify({ error: `Tool ${name} not found` }) }); continue; 
        }

        let hb, start = Date.now();
        try {
            hb = setInterval(() => console.log(`  ⏳ [${name}] still running... ${((Date.now() - start)/1000).toFixed(1)}s`), 5000);
            const res = await Promise.race([
                executors.get(name)(args, { isRemote, node: conf.node, remoteCmd, _cpu_core: conf._cpu_core }),
                new Promise((_, rej) => setTimeout(() => rej(new Error(`Tool timeout after ${TOOL_TIMEOUT_MS}ms`)), TOOL_TIMEOUT_MS))
            ]);
            clearInterval(hb);
            lastResultStr = res.stdout || res.output || res.content || JSON.stringify(res);
            for (const k of Object.keys(res)) if (typeof res[k] === 'string' && res[k] === '') res[k] = '[Empty]';
            console.log(`  ✅ [${name}] completed in ${Date.now() - start}ms (${lastResultStr.length} chars)`);
            messages.push({ role: 'tool', tool_call_id: call.id, name, content: JSON.stringify(res) });
        } catch (err) {
            if (hb) clearInterval(hb);
            console.error(`❌ [Swarm Error] ${name}: ${err.message}`);
            const resolution = await findResolution(err.message, conf.name);
            let errBlock = { error: err.message };
            if (resolution) {
                console.log(`  🧠 [ErrorMemory] Known fix (applied ${resolution.timesApplied}x): ${resolution.hint.slice(0, 80)}`);
                errBlock = { error: err.message, known_fix: resolution.hint, _self_heal: `Applied ${resolution.timesApplied}x` };
            }
            messages.push({ role: 'tool', tool_call_id: call.id, name, content: JSON.stringify(errBlock) });
        }
    }
}

/* --- Dispatch Task Entrypoint --- */
/**
 * Main entry point for the Edge Swarm to dispatch a task to a specialized persona.
 * Handles node routing, tool scoping, LLM invocation, schema recovery, and execution limits.
 *
 * @param {Object} personaConfig - The persona's configuration and skill payload.
 * @param {string} taskString - The specific task instructions.
 * @param {Object} [contextPayload=null] - The ADK 2.0 structured TransferProtocol.CONTEXTUAL context payload.
 * @returns {Promise<string>} The final execution completion result.
 */
export async function dispatchTask(personaConfig, taskString, contextPayload = null) {
    const { nodeKey, hostUrl, conf } = await resolveNodeConfig(personaConfig);
    const messages = await buildSystemPromptMessages(conf, taskString, contextPayload);
    const { allTools, executors } = await getCachedTools();
    const tools = resolveAllowedTools(conf, allTools);
    
    let retries = 0, steps = 0, currentHost = hostUrl;

    while (steps < 30) {
        steps++;
        
        // Strict Model-to-Node Routing to prevent "model not found" crashes
        const isOllama = !conf.base || !conf.base.startsWith('gemini');
        let effectiveModel = conf.base || `${HARDWARE_MODELS.EDGE_FAST}-base`;
        
        if (isOllama && currentHost) {
            if (currentHost.includes('11434')) {
                // Director node on 3060 (12GB VRAM)
                effectiveModel = HARDWARE_MODELS.DIRECTOR;
            } else if (currentHost.includes('11435')) {
                // kruschdev_worker on RX 5500 (8GB VRAM)
                effectiveModel = HARDWARE_MODELS.WORKER;
            } else if (currentHost.includes('10.0.0.19') || currentHost.includes('10.0.0.85')) {
                // 4GB VRAM nodes
                effectiveModel = conf.base || (conf.name.match(/manager|auditor|expert/i) ? HARDWARE_MODELS.EDGE_EXPERT : HARDWARE_MODELS.EDGE_FAST);
            } else if (['10.0.0.183', '10.0.0.228'].some(ip => currentHost.includes(ip))) {
                // Supreme Auditor Escalation Nodes
                effectiveModel = conf.base || (conf.name.match(/manager|auditor|expert/i) ? HARDWARE_MODELS.CPU_ONLY : HARDWARE_MODELS.EDGE_FAST);
                if (currentHost.includes('10.0.0.228')) effectiveModel = effectiveModel.includes('14b') ? HARDWARE_MODELS.CPU_ONLY : effectiveModel;
            }
        }
        
        // Fully Sovereign Architecture: Local-Only Thinker Execution using appropriate Node Model
        const config = {
            provider: isOllama ? 'ollama' : 'gemini',
            apiUrl: isOllama ? currentHost + '/v1/chat/completions' : undefined,
            model: effectiveModel,
            tools: tools.length > 0 ? tools : undefined,
            maxTokens: 8192, temperature: 0.1
        };

        // Fast 60-second timeout for Tier 1 VRAM-only Edge Nodes (kruschgame), 120s for core
        const timeoutMs = currentHost && currentHost.includes('10.0.0.19') ? 60000 : 120000;

        console.log(`[Swarm] Dispatching task to ${conf.name} (Timeout: ${timeoutMs}ms)...`);
        let assistantMsg;
        try {
            const result = await chatWithTools(config, messages, config.tools, { timeout: timeoutMs });
            await recordSuccess(nodeKey);
            assistantMsg = { role: 'assistant', content: result.content, tool_calls: result.tool_calls || result.toolCalls };
        } catch (llmError) {
            if (llmError.message.includes('fetch failed') || llmError.name === 'TimeoutError') {
               await recordFailure(nodeKey);
               console.warn(`[Swarm] Fetch failed to ${currentHost}, falling back to kruschdev_director (11434)`);
               currentHost = 'http://127.0.0.1:11434';
               if (++retries > 3) throw new Error(`${conf.name} failed generating response.`);
               continue;
            } else throw llmError;
        }

        if (!assistantMsg.tool_calls && !assistantMsg.content) {
            if (++retries > 3) throw new Error(`${conf.name} failed to generate valid response.`);
            messages.push({ role: 'system', content: `CRITICAL GUIDANCE:\nOutput collapsed. Please provide valid JSON tool calls.` });
            continue;
        }

        messages.push(assistantMsg);
        if (assistantMsg.content && !assistantMsg.tool_calls) assistantMsg = await chunkAndFormatViaTypist(assistantMsg, conf.name, tools);

        if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
            await executeToolCalls(assistantMsg, conf, executors, messages);
        } else {
            return assistantMsg.content || JSON.stringify(assistantMsg.tool_calls);
        }
    }
    
    return `Execution failed: hard limit of 30 tool steps reached.`;
}
