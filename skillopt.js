/**
 * @module skillopt
 * @description SkillOpt-Lite core text-space skill optimization engine.
 * Provides safe patch application, structured trajectory-driven reflection,
 * and held-out validation gating.
 */

import fs from 'fs/promises';
import { chatJson } from './llm.js';

/**
 * Safely applies an array of structured edits to a skill file,
 * protecting slow-update regions bounded by markdown HTML comments.
 *
 * @param {string} filePath - Absolute path to target markdown file.
 * @param {Array<Object>} edits - Array of edits: { op: 'append'|'insert_after'|'replace'|'delete', target: string, content: string }
 * @returns {Promise<string>} The updated file content.
 */
export async function applySkillPatch(filePath, edits) {
    let content = await fs.readFile(filePath, 'utf8');
    
    // Protect slow-update block
    const slowUpdateRegex = /(<!--\s*SLOW_UPDATE_START\s*-->[\s\S]*?<!--\s*SLOW_UPDATE_END\s*-->)/;
    const slowUpdateMatch = content.match(slowUpdateRegex);
    const slowUpdatePlaceholder = "___SLOW_UPDATE_PROTECTED_BLOCK___";
    let slowUpdateBlock = "";

    if (slowUpdateMatch) {
        slowUpdateBlock = slowUpdateMatch[1];
        content = content.replace(slowUpdateBlock, slowUpdatePlaceholder);
    }

    // Apply each edit operation sequentially with graceful error isolation
    let appliedCount = 0;
    let lastErr = null;
    for (const edit of edits) {
        try {
            content = executeEditOp(content, edit);
            appliedCount++;
        } catch (opErr) {
            lastErr = opErr;
            console.warn(`[SkillOpt] Warning: Could not apply ${edit.op} edit: ${opErr.message}. Skipping this edit.`);
        }
    }
    if (edits.length > 0 && appliedCount === 0 && lastErr) {
        throw lastErr;
    }

    // Restore slow-update block
    if (slowUpdateMatch) {
        content = content.replace(slowUpdatePlaceholder, slowUpdateBlock);
    }

    await fs.writeFile(filePath, content, 'utf8');
    return content;
}

/**
 * Internal helper to dispatch edit operations.
 * @private
 */
function executeEditOp(content, edit) {
    const { op, target, content: newContent } = edit;
    
    switch (op) {
        case 'append':
            return content.trim() + "\n\n" + newContent + "\n";
            
        case 'insert_after': {
            const index = content.indexOf(target);
            if (index !== -1) {
                const insertPos = index + target.length;
                return content.slice(0, insertPos) + "\n" + newContent + content.slice(insertPos);
            }
            // Fallback to fuzzy regex match
            const escapedTarget = target.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const targetRegex = new RegExp(escapedTarget.replace(/\s+/g, '\\s+'));
            const match = targetRegex.exec(content);
            if (!match) throw new Error(`Target not found for insert_after: "${target}"`);
            const insertPos = match.index + match[0].length;
            return content.slice(0, insertPos) + "\n" + newContent + content.slice(insertPos);
        }
        case 'replace': {
            if (content.includes(target)) {
                return content.replace(target, newContent);
            }
            // Fallback to fuzzy regex match
            const escapedTarget = target.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const targetRegex = new RegExp(escapedTarget.replace(/\s+/g, '\\s+'));
            if (!targetRegex.test(content)) throw new Error(`Target not found for replace: "${target}"`);
            return content.replace(targetRegex, newContent);
        }
        case 'delete': {
            if (content.includes(target)) {
                return content.replace(target, '');
            }
            // Fallback to fuzzy regex match
            const escapedTarget = target.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const targetRegex = new RegExp(escapedTarget.replace(/\s+/g, '\\s+'));
            if (!targetRegex.test(content)) throw new Error(`Target not found for delete: "${target}"`);
            return content.replace(targetRegex, '');
        }
        default:
            throw new Error(`Unsupported SkillOpt edit operator: "${op}"`);
    }
}

/**
 * Analyzes trajectories, merges success/failure insights, and proposes generalizable edits 
 * under a strict textual learning rate (budget) Lt.
 *
 * @param {Array<Object>} trajectories - Rollout execution trace tasks.
 * @param {string} currentSkill - Active skill document.
 * @param {number} budget - Maximum number of allowed edits (learning rate Lt).
 * @param {object} config - LLM config object.
 * @param {object} [options={}] - Optional parameters (e.g. useAnalysisModel).
 * @returns {Promise<Array<Object>>} The filtered and bounded array of edit operations.
 */
export async function proposeSkillEdits(trajectories, currentSkill, budget, config, options = {}) {
    const systemPrompt = `You are a high-prestige Skill Optimizer (Teacher model).
Your job is to analyze agent trajectories (both failures and successes) and generate a bounded list of edits for the current skill document.

Rules:
1. Identify the most critical common failures across tasks. Propose corrective edits.
2. Reinforce positive patterns that work.
3. Keep edits highly generalizable (e.g., procedural, do not hardcode task-specific names or values).
4. Budgets ($L_t$): You can propose AT MOST ${budget} edits. Do not exceed this limit under any circumstance.
5. Supported operators:
   - "append": content goes at end of the skill document.
   - "insert_after": target is the exact target text, content is inserted after it.
   - "replace": target is replaced by content.
   - "delete": target is deleted from document.
6. TARGET STRING PRECISION: The target string for "insert_after", "replace", or "delete" MUST exist EXACTLY in the document, including markdown symbols (like '>', '*', '-', '##'), numbers, blockquotes, and exact spacing. Otherwise, matching will fail.
7. PROTECTED SECTION: Under no circumstances may you edit, delete, or add text inside <!-- SLOW_UPDATE_START --> and <!-- SLOW_UPDATE_END -->.

Return a JSON object:
{
  "reasoning": "Justify why these specific edits fix failures and reinforce successes.",
  "edits": [
    { "op": "append"|"insert_after"|"replace"|"delete", "target": "exact target string", "content": "new markdown content" }
  ]
}`;

    const userMessage = `## Current Skill
${currentSkill}

## Trajectories Batch
${JSON.stringify(trajectories, null, 2)}`;

    const chatFn = options.mockChatJson || chatJson;
    const result = await chatFn(systemPrompt, userMessage, config, options);
    let edits = Array.isArray(result?.edits) ? result.edits : [];

    // Strictly enforce textual learning rate limit (budget Lt)
    if (edits.length > budget) {
        edits = edits.slice(0, budget);
    }

    return edits;
}

/**
 * Runs a validation gate sweep on a separate selection split, checking for strict average improvement.
 * If validation fails or ties, automatically rolls back file changes.
 *
 * @param {string} filePath - Absolute path to the skill file.
 * @param {string} candidateSkillContent - The new candidate skill content.
 * @param {Array<Object>} selectionTasks - Tasks in the selection split.
 * @param {Function} runTaskCallback - Async function: (task, skillContent) => Promise<number> (scalar score).
 * @returns {Promise<{ success: boolean, newScore: number, oldScore: number }>} Gate results.
 */
export async function runValidationGate(filePath, candidateSkillContent, selectionTasks, runTaskCallback) {
    const backupContent = await fs.readFile(filePath, 'utf8');
    
    // Evaluate current baseline score
    let baselineTotal = 0;
    for (const task of selectionTasks) {
        baselineTotal += await runTaskCallback(task, backupContent);
    }
    const oldScore = baselineTotal / selectionTasks.length;

    // Temporarily write candidate content
    await fs.writeFile(filePath, candidateSkillContent, 'utf8');

    // Evaluate candidate score
    let candidateTotal = 0;
    try {
        for (const task of selectionTasks) {
            candidateTotal += await runTaskCallback(task, candidateSkillContent);
        }
    } catch (err) {
        // Rollback on execution crashes
        await fs.writeFile(filePath, backupContent, 'utf8');
        throw err;
    }
    
    const newScore = candidateTotal / selectionTasks.length;

    // Gating check: Must be strictly greater than baseline (reject ties & drops)
    if (newScore > oldScore) {
        return { success: true, newScore, oldScore };
    } else {
        // Rollback
        await fs.writeFile(filePath, backupContent, 'utf8');
        return { success: false, newScore, oldScore };
    }
}
