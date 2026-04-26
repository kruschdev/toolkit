import { chat } from '../llm.js';

/**
 * Calculates the Factual Stake / Shapley Value of an agent's argument.
 * This actively strips power from loud/hallucinating models and rewards verifiability.
 * 
 * @param {string} agentName - Name of the debating agent
 * @param {string} argument - The textual thesis the agent is arguing
 * @param {Array} toolExecutions - List of verified tool actions the agent took { tool, success, contextLength }
 * @returns {Promise<number>} - The calculated factual weight (0 - 100)
 */
export async function calculateShapleyValue(agentName, argument, toolExecutions = []) {
    let deterministicScore = 0;
    let verifiedMcpDataBytes = 0;

    for (const exec of toolExecutions) {
        if (exec.success) {
            deterministicScore += 10;
            // Reward specifically for native Context extraction tools or Universal MCP tools
            if (['run_safe', 'analyze_code', 'search_rules', 'read_file'].includes(exec.tool)) {
                deterministicScore += 5; 
                verifiedMcpDataBytes += exec.contextLength || 0;
            }
            // Heavily reward the agent for successfully bridging out to an external enterprise MCP Server
            else if (exec.tool && !['run_safe', 'analyze_code', 'search_rules', 'read_file', 'write_file', 'list_dir'].includes(exec.tool)) {
                deterministicScore += 15; // Massive reward for dynamic out-of-band JSON-RPC tool utilization
            }
        } else {
            deterministicScore -= 5; // Harsh penalty for failed/hallucinated tool schemas
        }
    }

    // Cap deterministic tool score to 40% of the total weight
    if (deterministicScore > 40) deterministicScore = 40;
    if (deterministicScore < 0) deterministicScore = 0;

    // Use Flash Lite to judge the logical coherence and factual density for the remaining 60%
    const systemPrompt = `You are the Shapley Assessor for the Chrysalis Swarm Topic Ledger Framework.
Evaluate the factual density and logical coherence of the following argument.
Focus entirely on whether the argument relies on verifiable data vs hallucinated assumptions.
Score the argument out of 60. Respond ONLY with a valid JSON object matching exactly: {"score": <number>, "reason": "<short string>"}`;

    const config = {
        provider: 'gemini',
        model: 'gemini-2.5-flash-lite',
        apiKey: process.env.GEMINI_API_KEY,
        maxTokens: 150,
        temperature: 0.0, // Zero temperature for strict deterministic mathematical grading
        format: 'json'
    };

    let flashScore = 0;
    try {
        const textToEvaluate = `Agent: ${agentName}\nArgument: ${argument}\nVerified MCP Extracted Bytes: ${verifiedMcpDataBytes}`;
        const resText = await chat(systemPrompt, textToEvaluate, config);
        
        // Clean markdown backticks if returned
        const cleaned = resText.replace(/```json/g, '').replace(/```/g, '').trim();
        const llmResult = JSON.parse(cleaned);
        
        flashScore = typeof llmResult.score === 'number' ? llmResult.score : 0;
        if (flashScore > 60) flashScore = 60;
        if (flashScore < 0) flashScore = 0;
    } catch (e) {
        console.error(`❌ [Shapley Assessor] Failed to parse semantic score: ${e.message}`);
        // Fallback constraint
        flashScore = 20; 
    }

    return Math.floor(deterministicScore + flashScore);
}
