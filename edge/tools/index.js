import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { initMcpServer } from '../mcp_client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Dynamically loads all tool definitions from the current directory,
 * AND automatically binds external MCP Gateway Servers if defined in config.
 * 
 * Every `.js` file (except index.js) is expected to export:
 *  - `schema`: The OpenAPI function schema
 *  - `execute`: The async function handler
 */
export async function loadTools() {
    const files = await fs.readdir(__dirname);
    const tools = [];
    const executors = new Map();

    for (const file of files) {
        if (file === 'index.js' || !file.endsWith('.js')) continue;

        try {
            const modulePath = path.join(__dirname, file);
            // Dynamic import requires a path file:// or relative
            const mod = await import(`file://${modulePath}`).catch(e => {
                console.warn(`[Tool Registry] Skipping ${file}: ${e.message}`);
                return null;
            });

            if (mod && mod.schema && mod.execute) {
                tools.push({ type: 'function', function: mod.schema });
                executors.set(mod.schema.name, mod.execute);
            } else if (mod) {
                console.warn(`[Tool Registry] Skipping ${file}: Missing schema or execute export.`);
            }
        } catch (err) {
            console.error(`[Tool Registry] Fatal error loading tool ${file}:`, err);
        }
    }

    // --- UNIVERSAL MCP GATEWAY ---
    // Swarm now natively handshakes with any standard external Model Context Protocol resource containers
    // Expected env: MCP_SERVERS = '[{"name":"github","command":"npx","args":["-y","@modelcontextprotocol/server-github"]}]'
    const mcpServers = process.env.MCP_SERVERS ? JSON.parse(process.env.MCP_SERVERS) : [];
    
    for (const srv of mcpServers) {
        try {
            const mcp = await initMcpServer(srv.name, srv.command, srv.args, { ...process.env, ...srv.env });
            if (mcp && mcp.mcpTools) {
                for (const t of mcp.mcpTools) {
                    tools.push(t);
                    
                    // Bind the dynamic execution pointer back to the connected Stdio channel!
                    executors.set(t.function.name, async (args) => {
                        console.log(`[MCP Router] Sending native payload to ${srv.name}...`);
                        try {
                            const res = await mcp.client.callTool({ name: t.function.name, arguments: args });
                            
                            if (res.isError) return `[MCP Warning] API Fault: ${JSON.stringify(res.content)}`;
                            
                            // Transform multi-part JSON-RPC text packets into unified stream string for the Edge Swarm
                            if (res.content && Array.isArray(res.content)) {
                                return res.content.map(c => c.text).join('\n');
                            }
                            return typeof res === 'object' ? JSON.stringify(res) : res;

                        } catch(e) {
                            return `[MCP Execution Crash] Failed to route intent: ${e.message}`;
                        }
                    });
                }
            }
        } catch (mcpErr) {
             console.error(`[Tool Registry] MCP Gateway rejection for ${srv.name}: ${mcpErr.message}`);
        }
    }

    return { allTools: tools, executors };
}

