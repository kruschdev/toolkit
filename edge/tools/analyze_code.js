import fs from 'node:fs/promises';
import { exec } from 'node:child_process';
import util from 'node:util';
import { chat } from '../../llm.js';

const execAsync = util.promisify(exec);

export const schema = {
    name: "analyze_code",
    description: "Use Gemini 2.5 Flash Lite to deeply analyze and semantically compress a file's code. Use this instead of read_file for large or complex files when you need to answer specific architectural or logic questions.",
    parameters: {
        type: "object",
        properties: {
            path: { type: "string", description: "Absolute file path to analyze" },
            query: { type: "string", description: "Specific question or analysis goal (e.g., 'Extract the authentication logic pattern' or 'Explain how routing works in this file')" }
        },
        required: ["path", "query"]
    }
};

export async function execute(args, { isRemote, remoteCmd }) {
    if (!args.path || !args.query) {
        return { error: 'Missing required arguments: path, query' };
    }

    let content;
    try {
        if (isRemote) {
            const { stdout } = await execAsync(remoteCmd(`cat ${args.path}`), { shell: '/bin/bash' });
            content = stdout;
        } else {
            content = await fs.readFile(args.path, 'utf8');
        }
    } catch (e) {
        return { error: `Failed to read file: ${e.message}` };
    }

    // Safety truncate to ~500k chars for massive files
    if (content.length > 500_000) {
        content = content.slice(0, 500_000) + "\n...[TRUNCATED_DUE_TO_SIZE]";
    }

    const systemPrompt = `You are an expert Code Analyst for the kruschDev homelab.
Analyze the following codebase file perfectly based on the user's querying intent and return a dense, highly factual summary.
Avoid conversational boilerplate. Do not simply regurgitate the code. Instead, distill its architectural meaning, function signatures, dependencies, and precisely answer the query.`;
    
    if (!process.env.GEMINI_API_KEY) {
        return { error: "GEMINI_API_KEY is not defined in the environment. Cannot use analyze_code." };
    }

    const config = {
        provider: 'gemini',
        model: 'gemini-2.5-flash-lite',
        apiKey: process.env.GEMINI_API_KEY,
        maxTokens: 2500,
        temperature: 0.1
    };

    try {
        const response = await chat(
            systemPrompt, 
            `File: ${args.path}\n\n=== Content ===\n${content}\n=== End Content ===\n\nQuery: ${args.query}`, 
            config
        );
        return { result: response };
    } catch (e) {
        return { error: `Gemini Flash Lite Analysis failed: ${e.message}` };
    }
}
