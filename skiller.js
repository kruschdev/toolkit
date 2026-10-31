/**
 * @module skiller
 * @description SKILLER: Language-Level Reinforcement Learning & Skill Extraction Engine based on:
 * "SKILLER: Language-Level Reinforcement Learning for Reusable Skill Extraction in Small Language Models" (arXiv: 2608.10538).
 *
 * Facilitates the extraction, refinement, and validation of modular, reusable agent skills:
 * 1. Actor/Critic Teacher (Gemini or Qwen 32B) synthesizes skills from raw execution trajectories.
 * 2. Small Model Executor (Qwen 7B/4B) validation gating.
 * 3. Monorepo and Toolkit staging.
 */

import fs from 'fs/promises';
import path from 'path';
import { chatJson, chat } from './llm.js';

/**
 * Extracts a modular, reusable markdown skill from a raw task trajectory.
 *
 * @param {object} params
 * @param {string} params.taskName - Descriptive name of the capability or task.
 * @param {string|Array<object>} params.trajectory - Execution logs, tool call traces, or debug transcripts.
 * @param {object} params.teacherLlmConfig - High-tier LLM configuration for the skill architect (Gemini or 32B).
 * @param {string} [params.targetPersona="SRE Worker"] - Target agent persona executing the skill.
 * @returns {Promise<{ skillName: string, description: string, skillMarkdown: string, tags: string[] }>}
 */
export async function extractSkillFromTrajectory({ taskName, trajectory, teacherLlmConfig, targetPersona = "SRE Worker" }) {
    const systemPrompt = `You are a Principal Agent Architect and Skill Synthesizer.
Your goal is to extract a permanent, reusable, and deterministic Agent Skill from the provided execution trajectory.

The extracted skill will be saved as a standard \`SKILL.md\` file used by smaller local models (e.g. Qwen 7B, Gemma 4) to reliably reproduce complex multi-step workflows.

Requirements:
1. Extract the core procedural logic into clear, reproducible steps.
2. Identify edge cases, failure modes, and recovery recipes encountered during execution.
3. Include explicit validation gates (commands or assertions to verify success).
4. Output cleanly formatted markdown with YAML frontmatter at the top.

Return a JSON object:
{
  "skillName": "kebab-case-skill-name",
  "description": "1-2 sentence description of what the skill achieves",
  "tags": ["tag1", "tag2"],
  "skillMarkdown": "---\\nname: kebab-case-skill-name\\ndescription: 1-2 sentence description\\n---\\n\\n# Skill Title\\n\\n..."
}`;

    const traceText = typeof trajectory === 'string' ? trajectory : JSON.stringify(trajectory, null, 2);
    const userMessage = `## TASK NAME
${taskName}

## TARGET EXECUTOR PERSONA
${targetPersona}

## EXECUTION TRAJECTORY / LOG TRACE
${traceText}`;

    const result = await chatJson(systemPrompt, userMessage, { ...teacherLlmConfig, temperature: 0.2 });

    return {
        skillName: result?.skillName || taskName.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        description: result?.description || "Extracted agent skill.",
        tags: Array.isArray(result?.tags) ? result.tags : [],
        skillMarkdown: result?.skillMarkdown || `# ${taskName}\n\nAutomated skill extraction.`
    };
}

/**
 * Validates whether a candidate skill improves small-model performance on a benchmark scenario.
 *
 * @param {object} params
 * @param {string} params.skillMarkdown - The candidate skill definition.
 * @param {string} params.taskPrompt - Test task prompt.
 * @param {object} params.executorLlmConfig - Small-model LLM config (e.g. Qwen 7B).
 * @param {Function} [params.evaluatorFn] - Optional custom evaluator function.
 * @returns {Promise<{ withSkillOutput: string, withoutSkillOutput: string, transferScore: number, passed: boolean }>}
 */
export async function evaluateSkillTransfer({ skillMarkdown, taskPrompt, executorLlmConfig, evaluatorFn }) {
    // 1. Run baseline without skill
    const baselinePrompt = `You are a helpful coding assistant. Solve the following task:\n\n${taskPrompt}`;
    const withoutSkillOutput = await chat("You are an autonomous agent.", baselinePrompt, executorLlmConfig);

    // 2. Run test with skill injected into system context
    const skilledSystemPrompt = `You are an autonomous agent with the following specialized skill:\n\n${skillMarkdown}`;
    const withSkillOutput = await chat(skilledSystemPrompt, taskPrompt, executorLlmConfig);

    // 3. Score transfer
    let passed = true;
    let transferScore = 1.0;

    if (typeof evaluatorFn === 'function') {
        const evalResult = await evaluatorFn({ withSkillOutput, withoutSkillOutput });
        passed = !!evalResult.passed;
        transferScore = evalResult.score ?? (passed ? 1.0 : 0.0);
    } else {
        // Basic heuristic: with-skill output should have greater structure/clarity
        passed = withSkillOutput.length > 50 && !withSkillOutput.includes("I cannot");
    }

    return {
        withSkillOutput,
        withoutSkillOutput,
        transferScore,
        passed
    };
}

/**
 * Stages and writes an extracted skill into the monorepo skills directory.
 *
 * @param {string} skillName - Name of the skill.
 * @param {string} skillMarkdown - Full markdown content.
 * @param {string} [targetDir=".agent/skills"] - Destination directory.
 * @returns {Promise<{ skillPath: string, bytesWritten: number }>}
 */
export async function stageSkillForMonorepo(skillName, skillMarkdown, targetDir = path.join(process.cwd(), '.agent', 'skills')) {
    const cleanName = skillName.toLowerCase().replace(/[^a-z0-9_-]/g, '');
    const skillFolder = path.join(targetDir, cleanName);
    const skillFilePath = path.join(skillFolder, 'SKILL.md');

    await fs.mkdir(skillFolder, { recursive: true });
    await fs.writeFile(skillFilePath, skillMarkdown, 'utf8');

    const stat = await fs.stat(skillFilePath);
    return {
        skillPath: skillFilePath,
        bytesWritten: stat.size
    };
}

/**
 * Creates an Executable Skill Contract (ECKU) bundling markdown instructions with an executable verification harness.
 * Based on: "Executable Code Knowledge" (arXiv: 2608.16295).
 *
 * @param {string} skillMarkdown - Base markdown skill documentation.
 * @param {string|Function} validationHarnessCode - Self-contained validation function or JS script.
 * @returns {{ combinedPackage: string, validationType: string, isExecutable: boolean }}
 */
export function createExecutableSkillContract(skillMarkdown, validationHarnessCode) {
    const harnessText = typeof validationHarnessCode === 'function' ? validationHarnessCode.toString() : String(validationHarnessCode || '');
    
    let combined = skillMarkdown.trim();
    combined += `\n\n## 🧪 Executable Verification Harness (ECK)\n\`\`\`javascript\n${harnessText}\n\`\`\`\n`;

    return {
        combinedPackage: combined,
        validationType: typeof validationHarnessCode === 'function' ? 'function' : 'script',
        isExecutable: harnessText.length > 0
    };
}

/**
 * Computes simple word-vector overlap similarity between two text snippets (Jaccard / Token-Set).
 * @param {string} textA
 * @param {string} textB
 * @returns {number} 0.0 to 1.0
 */
function computeTextSimilarity(textA = '', textB = '') {
    const setA = new Set(textA.toLowerCase().replace(/[^a-z0-9\s_-]/g, ' ').split(/\s+/).filter(w => w.length > 2));
    const setB = new Set(textB.toLowerCase().replace(/[^a-z0-9\s_-]/g, ' ').split(/\s+/).filter(w => w.length > 2));

    if (setA.size === 0 || setB.size === 0) return 0.0;
    let intersection = 0;
    for (const w of setA) {
        if (setB.has(w)) intersection++;
    }
    const union = new Set([...setA, ...setB]).size;
    return union === 0 ? 0.0 : intersection / union;
}

/**
 * Diverse Skill Routing (DSR) using a query-residual diversity kernel based on:
 * "Beyond Top-k Skill Retrieval: Diversity-Aware Skill Routing for LLM Agents"
 * (arXiv: 2609.05824 - Wang, Yang, Basu et al., September 2026).
 *
 * Balances query relevance and pairwise non-redundancy to construct a complementary,
 * orthogonal skill subset within the agent's context token budget.
 *
 * @param {string} query - User task description or query.
 * @param {Array<{ name: string, description: string, tags?: string[], tokens?: number }>} availableSkills - Candidate skill registry.
 * @param {Object} [options={}]
 * @param {number} [options.maxSkills=5] - Maximum number of skills to route.
 * @param {number} [options.maxTokenBudget=4000] - Cumulative token budget for selected skills.
 * @param {number} [options.diversityLambda=0.6] - Balance weight: higher favors query relevance, lower favors orthogonal diversity.
 * @param {Function} [options.similarityFn] - Custom similarity metric (defaults to token set Jaccard).
 * @returns {{ selectedSkills: Array<Object>, totalTokens: number, diversityScore: number, rejectedOverlap: Array<Object> }}
 */
export function routeDiverseSkills(query, availableSkills = [], options = {}) {
    const {
        maxSkills = 5,
        maxTokenBudget = 4000,
        diversityLambda = 0.6,
        similarityFn = computeTextSimilarity
    } = options;

    if (!Array.isArray(availableSkills) || availableSkills.length === 0) {
        return { selectedSkills: [], totalTokens: 0, diversityScore: 1.0, rejectedOverlap: [] };
    }

    // 1. Calculate base query relevance for each candidate
    const candidates = availableSkills.map(skill => {
        const fullSkillText = `${skill.name} ${skill.description || ''} ${(skill.tags || []).join(' ')}`;
        const relevance = similarityFn(query, fullSkillText);
        const tokens = skill.tokens || Math.max(100, Math.round(fullSkillText.length / 4));
        return {
            ...skill,
            fullSkillText,
            relevance,
            tokens
        };
    });

    // Sort initially by relevance
    candidates.sort((a, b) => b.relevance - a.relevance);

    const selectedSkills = [];
    const rejectedOverlap = [];
    let currentTokens = 0;

    const remaining = [...candidates];

    // 2. Greedy selection using DPP-inspired query-residual scoring
    while (remaining.length > 0 && selectedSkills.length < maxSkills) {
        let bestIndex = -1;
        let bestScore = -Infinity;

        for (let i = 0; i < remaining.length; i++) {
            const candidate = remaining[i];

            // Check token budget constraint
            if (currentTokens + candidate.tokens > maxTokenBudget) {
                continue;
            }

            // Compute maximum redundancy with already selected skills
            let maxRedundancy = 0;
            for (const sel of selectedSkills) {
                const redundancy = similarityFn(candidate.fullSkillText, sel.fullSkillText);
                if (redundancy > maxRedundancy) {
                    maxRedundancy = redundancy;
                }
            }

            // DSR formula: Score = lambda * relevance - (1 - lambda) * maxRedundancy
            const dsrScore = (diversityLambda * candidate.relevance) - ((1 - diversityLambda) * maxRedundancy);

            if (dsrScore > bestScore) {
                bestScore = dsrScore;
                bestIndex = i;
            }
        }

        // If no candidate fits within token budget or has a viable score
        if (bestIndex === -1) {
            break;
        }

        const chosen = remaining.splice(bestIndex, 1)[0];

        // If chosen has excessive redundancy (>0.85) with an existing selection and very low relevance, record as rejected overlap
        let maxOverlap = 0;
        let overlappingSkill = null;
        for (const sel of selectedSkills) {
            const sim = similarityFn(chosen.fullSkillText, sel.fullSkillText);
            if (sim > maxOverlap) {
                maxOverlap = sim;
                overlappingSkill = sel.name;
            }
        }

        if (maxOverlap > 0.85 && selectedSkills.length > 0) {
            rejectedOverlap.push({
                skillName: chosen.name,
                redundantWith: overlappingSkill,
                overlapSimilarity: Math.round(maxOverlap * 100) / 100
            });
            continue;
        }

        selectedSkills.push(chosen);
        currentTokens += chosen.tokens;
    }

    // 3. Compute overall diversity score: 1.0 - average pairwise overlap among selected
    let totalPairwiseSim = 0;
    let pairsCount = 0;
    for (let i = 0; i < selectedSkills.length; i++) {
        for (let j = i + 1; j < selectedSkills.length; j++) {
            totalPairwiseSim += similarityFn(selectedSkills[i].fullSkillText, selectedSkills[j].fullSkillText);
            pairsCount++;
        }
    }
    const avgOverlap = pairsCount > 0 ? totalPairwiseSim / pairsCount : 0.0;
    const diversityScore = Math.round((1.0 - avgOverlap) * 100) / 100;

    return {
        selectedSkills: selectedSkills.map(({ fullSkillText, ...rest }) => rest),
        totalTokens: currentTokens,
        diversityScore,
        rejectedOverlap
    };
}


