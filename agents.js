/**
 * @module agents
 * Shared BuildOS agent utilities — LLM config, RAG context formatting,
 * JSON parsing with fallback, source formatting, and context section builders.
 *
 * Extracted from Spark's agents/shared.js and generalized for all trades.
 *
 * Usage:
 *   import { parseAgentJson, buildRagContextBlock, createLlmConfig } from '@krusch/toolkit/agents';
 */

import { exec } from 'node:child_process';
import util from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import pkg from 'pg';
const { Client } = pkg;
const execAsync = util.promisify(exec);

/**
 * Create a standardized LLM config object for agent calls.
 * Merges project-level AI config with agent-specific overrides.
 * @param {object} baseConfig - Project AI config (must have provider, apiKey, and at least one model key)
 * @param {object} [overrides={}] - Agent-specific overrides (model, temperature, maxTokens)
 * @returns {object} LLM config compatible with @krusch/toolkit/llm
 */
export function createLlmConfig(baseConfig, overrides = {}) {
  return {
    provider: baseConfig.provider,
    apiKey: baseConfig.apiKey,
    model: overrides.model || baseConfig.fastModel || baseConfig.model,
    temperature: overrides.temperature ?? 0.2,
    maxTokens: overrides.maxTokens ?? 4000,
  };
}

/**
 * Build an XML-formatted context block from RAG-retrieved chunks.
 * @param {Array} chunks - Retrieved context chunks from similaritySearch
 * @param {string} [emptyMessage] - Message to show when no chunks found
 * @returns {string} Formatted context block for LLM prompts
 */
export function buildRagContextBlock(chunks, emptyMessage) {
  if (!chunks?.length) {
    return `<no_sources>${emptyMessage || 'No specific content found in knowledge base. Use general professional knowledge.'}</no_sources>`;
  }

  return chunks.map((c) =>
    `<source id="${c.id}" title="${c.documentTitle}" ref="${c.sourceRef || ''}" similarity="${c.similarity}">
${c.content}
</source>`
  ).join('\n\n');
}

/**
 * Build a context section string for LLM prompts from arbitrary key-value data.
 * Generalized version of Spark's buildJobContextSection — any trade can use this
 * by passing their own field mapping.
 *
 * @param {object} [context=null] - Context data object (e.g., job context JSONB)
 * @param {object} [fieldMap=null] - Map of { fieldName: label } for simple fields,
 *   or { fieldName: { label, format } } for custom formatting.
 *   If null, auto-formats all non-empty fields using the key name.
 * @returns {string} Formatted context section (empty string if no context)
 *
 * @example
 * // Spark (electrical):
 * buildContextSection(ctx, {
 *   panelInfo: 'Panel',
 *   serviceSize: 'Service',
 *   voltageSystem: 'Voltage System',
 *   wireTypes: 'Wire types observed',
 *   equipmentNoted: 'Equipment',
 * });
 *
 * // BrushWise (painting):
 * buildContextSection(ctx, {
 *   surfaceType: 'Surface Type',
 *   coatCount: 'Coat Count',
 *   existingColor: 'Existing Color',
 * });
 */
export function buildContextSection(context, fieldMap) {
  if (!context || Object.keys(context).length === 0) return '';

  const parts = [];

  if (fieldMap) {
    for (const [field, config] of Object.entries(fieldMap)) {
      const value = context[field];
      if (value == null || value === '') continue;

      const label = typeof config === 'string' ? config : config.label;
      const format = typeof config === 'object' ? config.format : null;

      if (format) {
        const formatted = format(value);
        if (formatted) parts.push(formatted);
      } else if (Array.isArray(value)) {
        if (value.length) parts.push(`${label}: ${value.join(', ')}`);
      } else if (typeof value === 'object') {
        parts.push(`${label}: ${JSON.stringify(value)}`);
      } else {
        parts.push(`${label}: ${value}`);
      }
    }
  } else {
    // Auto-format: humanize keys and display all non-empty values
    for (const [key, value] of Object.entries(context)) {
      if (value == null || value === '') continue;
      const label = key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()).trim();
      if (Array.isArray(value)) {
        if (value.length) parts.push(`${label}: ${value.join(', ')}`);
      } else if (typeof value === 'object') {
        parts.push(`${label}: ${JSON.stringify(value)}`);
      } else {
        parts.push(`${label}: ${value}`);
      }
    }
  }

  if (parts.length === 0) return '';
  return `\n\nJob-specific context (use to tailor your response):\n${parts.join('\n')}`;
}

/**
 * Parse a JSON response from an LLM, handling markdown fences and extraction fallbacks.
 * @param {string} response - Raw LLM response text
 * @param {object} fallback - Fallback object to return if all parsing fails
 * @param {string} [label='Agent'] - Label for warning logs
 * @returns {object} Parsed JSON object or fallback
 */
export function parseAgentJson(response, fallback, label = 'Agent') {
  // Strip markdown code fences
  const cleaned = response.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

  // Attempt direct parse
  try {
    return JSON.parse(cleaned);
  } catch {
    // Attempt extraction of JSON object
    console.warn(`⚠️ ${label} response was not valid JSON, attempting extraction...`);
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch {
        // Fall through
      }
    }
  }

  // Return fallback with raw response attached
  console.warn(`⚠️ ${label} JSON extraction failed, using fallback`);
  return { ...fallback, rawResponse: response.substring(0, 2000) };
}

/**
 * Format retrieved chunks into a sources array for API responses.
 * @param {Array} chunks - Retrieved context chunks
 * @returns {Array} Formatted source objects
 */
export function formatSources(chunks) {
  return chunks.map((c) => ({
    id: c.id,
    documentTitle: c.documentTitle,
    sourceType: c.sourceType,
    sourceRef: c.sourceRef,
    similarity: c.similarity,
  }));
}

/**
 * Dispatches a formal macro-task to the Chrysalis Hybrid Swarm via the Python Hivemind Router.
 * Bridges the gap between Node.js execution environments and the async Python Cognitive Plane.
 * 
 * @param {string} prompt - The raw user prompt detailing the execution requirements.
 * @param {Object} dbConfig - Postgres credentials matching the target environment.
 * @param {string} [routerPath] - Override the path for the Python Hivemind Router.
 * @returns {Promise<{taskId: string, code: string, status: string}>}
 */
export async function dispatchSwarmTask(prompt, dbConfig, routerPath = '/home/kruschdev/homelab/projects/hivemind/router.py') {
  console.log(`[Swarm Orchestration] Proxying request to Python Hivemind Router...`);
  const escapedPrompt = prompt.replace(/"/g, '\\"');
  
  // 1. Invoke Python Cognitive Plane (Brain)
  const { stdout } = await execAsync(`python3 ${routerPath} --prompt "${escapedPrompt}"`);
  
  // Parse task_id from STDOUT: e.g. "[+] Formulated Blueprint hvm-4fb321: ..."
  const match = stdout.match(/Blueprint (hvm-[a-f0-9]+):/);
  if (!match) throw new Error('Failed to parse Blueprint ID from Hivemind Router stdout:\\n' + stdout);
  
  const taskId = match[1];
  console.log(`[Swarm Orchestration] Successfully queued task: ${taskId}. Awaiting CCG Factory Assembly via PostgreSQL IPC...`);
  
  // 2. Await Node.js Factory Plane (Hands)
  const client = new Client({
    host: dbConfig.host,
    port: dbConfig.port || 5432,
    user: dbConfig.user,
    password: dbConfig.password,
    database: dbConfig.name
  });
  await client.connect();
  
  let finalStatus = 'TIMEOUT';
  let payloadStr = '{}';
  
  // Poll DB for completion (Max ~2 minutes loop)
  for (let i = 0; i < 60; i++) {
    const res = await client.query(`SELECT status, payload FROM blueprints WHERE task_id = $1`, [taskId]);
    if (res.rows.length > 0) {
      const status = res.rows[0].status;
      if (status === 'DEPLOYED' || status === 'FAILED' || status === 'COMPLETED') {
        finalStatus = status;
        payloadStr = res.rows[0].payload;
        break;
      }
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  await client.end();
  
  if (finalStatus !== 'DEPLOYED' && finalStatus !== 'COMPLETED') {
    throw new Error(`Swarm Factory Daemon failed to synthesize task ${taskId}. Status: ${finalStatus}`);
  }
  
  // 3. Extract the physical artifact
  const payload = JSON.parse(payloadStr);
  let code = '';
  
  const homelabDir = '/home/kruschdev/homelab';
  const targetFile = (payload.components && payload.components[0] && payload.components[0].file_path) || 'solution.py';
  const sandboxPath = path.join(homelabDir, 'projects', 'chrysalis-v0', 'sandbox', taskId, targetFile);
  
  try {
    code = await fs.readFile(sandboxPath, 'utf-8');
    console.log(`[Swarm Orchestration] Task completed. Read compiled binary source from Sandbox.`);
  } catch (e) {
    if (payload.assembly_result && payload.assembly_result.code) {
      code = payload.assembly_result.code;
      console.log(`[Swarm Orchestration] Task completed. Extracted payload directly from IPC buffer.`);
    } else {
      console.warn(`[Swarm Orchestration] Could not read sandbox script or direct DB payload. Target evaluated: ${sandboxPath}`);
    }
  }

  return { taskId, code, status: finalStatus };
}

/**
 * Loads and formats few-shot reasoning traces for Swarm agent prompting.
 * @param {number} [traceLimit=3] - Maximum number of traces to load
 * @returns {Array} Array of message objects (role, content) for prompt injection
 */
export async function buildReasoningTraces(traceLimit = 3) {
  try {
    const tracesPath = path.resolve('/home/kruschdev/homelab/lib/trade-knowledge/hermes_traces.json');
    const data = await fs.readFile(tracesPath, 'utf8');
    const traces = JSON.parse(data);
    
    let messages = [];
    for (const trace of traces.slice(0, traceLimit)) {
      if (trace.messages && Array.isArray(trace.messages)) {
        messages.push(...trace.messages);
      }
    }
    return messages;
  } catch (e) {
    console.warn(`[Agents] Failed to load reasoning traces from fixture: ${e.message}`);
    return [];
  }
}

