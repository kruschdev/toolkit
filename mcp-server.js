import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";

/**
 * Normalize an MCP tool definition and enforce mandatory 4-boolean annotations + title (INV-STACK-03).
 *
 * @param {object} toolDef
 * @returns {object}
 */
export function defineMcpTool({
  name,
  title,
  description = '',
  inputSchema = { type: 'object', properties: {} },
  annotations = {},
  readOnlyHint,
  destructiveHint,
  idempotentHint,
  openWorldHint,
  ...rest
} = {}) {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new Error('[defineMcpTool] Tool "name" must be a non-empty string.');
  }
  const cleanName = name.trim();
  const rawAnnotations = annotations && typeof annotations === 'object' ? annotations : {};
  const normalizedSchema =
    inputSchema && typeof inputSchema === 'object' && !Array.isArray(inputSchema)
      ? {
          ...inputSchema,
          type: inputSchema.type || 'object',
          properties:
            inputSchema.properties && typeof inputSchema.properties === 'object'
              ? inputSchema.properties
              : {},
        }
      : { type: 'object', properties: {} };

  return {
    ...rest,
    name: cleanName,
    description: String(description ?? ''),
    inputSchema: normalizedSchema,
    annotations: {
      ...rawAnnotations,
      title: String(rawAnnotations.title || title || cleanName),
      readOnlyHint: Boolean(readOnlyHint ?? rawAnnotations.readOnlyHint ?? true),
      destructiveHint: Boolean(destructiveHint ?? rawAnnotations.destructiveHint ?? false),
      idempotentHint: Boolean(idempotentHint ?? rawAnnotations.idempotentHint ?? true),
      openWorldHint: Boolean(openWorldHint ?? rawAnnotations.openWorldHint ?? false),
    },
  };
}

/**
 * Build a deterministic MCP text result wrapping an INV-LEGO-01 success envelope.
 *
 * @param {string} tool
 * @param {string} summary
 * @param {object} [data={}]
 * @returns {{ content: Array<{ type: 'text', text: string }> }}
 */
export function okMcpResult(tool, summary, data = {}) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          ok: true,
          tool: String(tool),
          summary: String(summary),
          data: data ?? {},
        }),
      },
    ],
  };
}

/**
 * Build a deterministic MCP error result wrapping an INV-LEGO-01 error envelope.
 *
 * @param {string} tool
 * @param {string} code
 * @param {string} message
 * @param {*} [details=null]
 * @returns {{ isError: true, content: Array<{ type: 'text', text: string }> }}
 */
export function errorMcpResult(tool, code, message, details = null) {
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          ok: false,
          tool: String(tool),
          summary: String(message),
          error: {
            code: String(code || 'TOOL_ERROR'),
            message: String(message),
            ...(details !== null && details !== undefined ? { details } : {}),
          },
        }),
      },
    ],
  };
}

/**
 * Deterministic check for required fields declared on `toolDef.inputSchema.required`.
 *
 * @param {object} toolDef
 * @param {object} [args={}]
 * @returns {{ valid: boolean, missing: string[] }}
 */
export function validateToolArgs(toolDef, args = {}) {
  const required = Array.isArray(toolDef?.inputSchema?.required)
    ? toolDef.inputSchema.required
    : [];
  if (required.length === 0) {
    return { valid: true, missing: [] };
  }

  const safeArgs = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const missing = [];
  for (const field of required) {
    const key = String(field);
    if (!Object.hasOwn(safeArgs, key) || safeArgs[key] === undefined || safeArgs[key] === null) {
      missing.push(key);
    }
  }

  return {
    valid: missing.length === 0,
    missing,
  };
}

/**
 * Synchronously normalizes MCP tools and registers `ListToolsRequestSchema` and
 * `CallToolRequestSchema` handlers on an existing MCP `Server` instance.
 *
 * Supports brownfield synchronous server factories while enforcing `INV-STACK-03`
 * 4-boolean annotations and optional `rethrowMcpError` JSON-RPC protocol propagation.
 *
 * @param {object} server - MCP SDK `Server` instance
 * @param {Array} [tools=[]] - Array of tool definition objects
 * @param {Function} toolHandler - Async/sync function handling tool calls `(name, args, request)`
 * @param {object} [options={}]
 * @returns {{ server: object, normalizedTools: Array, listTools: Function, callTool: Function }}
 */
export function registerMcpHandlers(server, tools = [], toolHandler, options = {}) {
  const normalizedTools = Array.isArray(tools)
    ? tools.map((tool) => defineMcpTool(tool))
    : [];
  const toolMap = new Map(normalizedTools.map((tool) => [tool.name, tool]));
  const fallbackServerName = String(options.serverName || 'mcp-server');

  const listToolsHandler = async () => {
    return { tools: normalizedTools };
  };

  const callToolHandler = async (request) => {
    const toolName = String(request?.params?.name ?? '');
    const toolArgs = request?.params?.arguments ?? {};
    const toolDef = toolMap.get(toolName);

    try {
      if (
        !toolDef &&
        normalizedTools.length > 0 &&
        options.strictTools === true &&
        options.strictUnknownTool !== false
      ) {
        return errorMcpResult(toolName, 'UNKNOWN_TOOL', `Unknown tool: ${toolName}`);
      }

      if (toolDef && options.validateArgs !== false) {
        const validation = validateToolArgs(toolDef, toolArgs);
        if (!validation.valid) {
          return errorMcpResult(
            toolName,
            'INVALID_ARGUMENTS',
            `Missing required argument(s) for ${toolName}: ${validation.missing.join(', ')}`,
            { missing: validation.missing }
          );
        }
      }

      const result = await toolHandler(toolName, toolArgs, request);

      if (result && typeof result === 'object' && Array.isArray(result.content)) {
        return result;
      }

      if (result && typeof result === 'object') {
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          ...(result.ok === false ? { isError: true } : {}),
        };
      }

      return okMcpResult(toolName, 'Completed', { result: result ?? null });
    } catch (error) {
      if (
        options.rethrowMcpError === true &&
        error &&
        typeof error === 'object' &&
        (error instanceof McpError ||
          error.name === 'McpError' ||
          (typeof error.code === 'number' && error.code <= -32000))
      ) {
        throw error;
      }
      const code = error?.code ? String(error.code) : 'TOOL_ERROR';
      const msg = error instanceof Error ? error.message : String(error);
      return errorMcpResult(toolName || fallbackServerName, code, `Error executing tool: ${msg}`);
    }
  };

  server.setRequestHandler(ListToolsRequestSchema, listToolsHandler);
  server.setRequestHandler(CallToolRequestSchema, callToolHandler);

  return {
    server,
    normalizedTools,
    listTools: listToolsHandler,
    callTool: callToolHandler,
  };
}

/**
 * Creates and starts a standardized MCP Server over stdio (or returns `{ server, normalizedTools }`
 * when `options.connect === false` for unit testing).
 *
 * @param {string} name - Name of the MCP server
 * @param {string} version - Version of the server
 * @param {Array} tools - Array of tool definition objects
 * @param {Function} toolHandler - Async function handling tool calls (name, args, request)
 * @param {object} [options={}]
 */
export async function createMcpServer(name, version, tools = [], toolHandler, options = {}) {
  const server = options.server || new Server(
    { name, version },
    { capabilities: options.capabilities || { tools: {} } }
  );

  const handle = registerMcpHandlers(server, tools, toolHandler, {
    ...options,
    serverName: name,
  });

  if (options.connect === false) {
    return handle;
  }

  const transport = options.transport || new StdioServerTransport();
  try {
    await server.connect(transport);
  } catch (err) {
    console.error(`[${name}] MCP connect error:`, err);
    try {
      await server.close?.();
    } catch {
      // Ignore cleanup errors during failed startup
    }
    throw err;
  }

  // Log strictly to stderr to prevent breaking the stdio JSON protocol on stdout
  console.error(`[${name}] MCP Server started on stdio.`);

  return server;
}

