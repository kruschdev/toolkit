import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * Initializes a connection to a standard MCP (Model Context Protocol) Server via stdio.
 * Transforms an external server into native Swarm-ready execution layers.
 * 
 * @param {string} name - Friendly alias for the server (e.g. 'github-mcp')
 * @param {string} command - Binary to execute (e.g. 'npx', 'python', 'docker')
 * @param {Array<string>} args - Command arguments
 * @param {Object} env - Environment variables specific to the server (like API keys)
 * @returns {Promise<Object>} The authenticated client and raw tool schemas
 */
export async function initMcpServer(name, command, args, env = process.env) {
    console.log(`[MCP Gateway] 🔌 Bootstrapping Server: ${name}...`);
    
    try {
        const transport = new StdioClientTransport({ command, args, env });
        const client = new Client(
            { name: "chrysalis-swarm-gateway", version: "1.0.0" }, 
            { capabilities: { tools: {} } }
        );
        
        await client.connect(transport);
        console.log(`[MCP Gateway] ✅ Authenticated with ${name}. Fetching resource schemas...`);
        
        const toolsResponse = await client.listTools();
        
        // Transform the MCP schema natively into the Swarm's expected OpenAI function-calling schema
        const mcpTools = toolsResponse.tools.map(tool => {
            return {
                type: 'function',
                function: {
                    name: tool.name,
                    description: `[MCP: ${name}] ` + tool.description,
                    parameters: tool.inputSchema
                }
            };
        });

        console.log(`[MCP Gateway] ⚡ Ingested ${mcpTools.length} total capabilities from ${name}.`);

        return { client, mcpTools, serverName: name };

    } catch (e) {
        console.error(`❌ [MCP Gateway] Failed handshake with ${name}: ${e.message}`);
        return null;
    }
}
