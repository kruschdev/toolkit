export interface McpToolAnnotations {
    title: string;
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
    [key: string]: unknown;
}

export interface McpInputSchema {
    type?: string;
    properties?: Record<string, unknown>;
    required?: readonly string[] | string[];
    additionalProperties?: boolean | Record<string, unknown>;
    [key: string]: unknown;
}

export interface McpToolInput {
    name: string;
    title?: string;
    description?: string;
    inputSchema?: McpInputSchema;
    annotations?: Partial<McpToolAnnotations>;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
    [key: string]: unknown;
}

export interface McpToolDefinition {
    name: string;
    description: string;
    inputSchema: McpInputSchema & {
        type: string;
        properties: Record<string, unknown>;
    };
    annotations: McpToolAnnotations;
    [key: string]: unknown;
}

export interface McpTextContent {
    type: 'text';
    text: string;
}

export interface McpToolResult {
    content: McpTextContent[];
    isError?: boolean;
    [key: string]: unknown;
}

export interface ToolArgsValidationResult {
    valid: boolean;
    missing: string[];
}

export type McpToolHandler = (
    name: string,
    args: Record<string, any>
) => unknown | Promise<unknown>;

export interface CreateMcpServerOptions {
    connect?: boolean;
    validateArgs?: boolean;
    strictTools?: boolean;
    strictUnknownTool?: boolean;
    server?: any;
    transport?: any;
}

export interface DisconnectedMcpServerHandle {
    server: any;
    normalizedTools: McpToolDefinition[];
    listTools: () => Promise<{ tools: McpToolDefinition[] }>;
    callTool: (request: {
        params?: { name?: string; arguments?: Record<string, unknown> };
    }) => Promise<McpToolResult>;
}

export declare function defineMcpTool(toolDef: McpToolInput): McpToolDefinition;

export declare function okMcpResult<TData = Record<string, unknown>>(
    tool: string,
    summary: string,
    data?: TData
): { content: McpTextContent[] };

export declare function errorMcpResult(
    tool: string,
    code: string,
    message: string,
    details?: unknown
): { isError: true; content: McpTextContent[] };

export declare function validateToolArgs(
    toolDef: { inputSchema?: { required?: readonly string[] | string[] } } | null | undefined,
    args?: Record<string, unknown>
): ToolArgsValidationResult;

export declare function createMcpServer(
    name: string,
    version: string,
    tools: McpToolInput[] | undefined,
    toolHandler: McpToolHandler,
    options: CreateMcpServerOptions & { connect: false }
): Promise<DisconnectedMcpServerHandle>;

export declare function createMcpServer(
    name: string,
    version: string,
    tools?: McpToolInput[],
    toolHandler?: McpToolHandler,
    options?: CreateMcpServerOptions
): Promise<any>;
