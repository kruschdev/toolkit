export type LLMProvider = 'gemini' | 'openai' | 'openrouter' | 'xai' | 'grok' | 'ollama' | (string & {});
export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';

export interface LLMChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool' | (string & {});
    content: string;
    tool_calls?: Array<{
        id?: string;
        type?: string;
        function?: { name: string; arguments: string | Record<string, unknown> };
    }>;
    [key: string]: unknown;
}

export interface LLMConfig {
    provider: LLMProvider;
    apiKey?: string;
    model: string;
    analysisModel?: string;
    fastModel?: string;
    apiUrl?: string;
    temperature?: number;
    maxTokens?: number;
    strictMaxTokens?: boolean;
    thinkingLevel?: ThinkingLevel;
    automaticContinuation?: boolean;
    continuationToken?: string;
    maxContinuationHops?: number;
    timeout?: number;
    format?: 'json' | string;
    responseSchema?: Record<string, unknown>;
    tools?: unknown[];
    toolConfig?: Record<string, unknown>;
    disableAutoToolConfigNone?: boolean;
    messages?: LLMChatMessage[];
    [key: string]: unknown;
}

export interface ChatOptions {
    useAnalysisModel?: boolean;
    bypassCascade?: boolean;
    maxTokens?: number;
    strictMaxTokens?: boolean;
    temperature?: number;
    thinkingLevel?: ThinkingLevel;
    automaticContinuation?: boolean;
    continuationToken?: string;
    maxContinuationHops?: number;
    timeout?: number;
    signal?: AbortSignal;
    traceContext?: unknown;
    tools?: unknown[];
    toolConfig?: Record<string, unknown>;
    disableAutoToolConfigNone?: boolean;
    messages?: LLMChatMessage[];
    returnFullResponse?: boolean;
    [key: string]: unknown;
}

export type LlmConfig = Partial<LLMConfig> & Record<string, any>;
export type LlmChatOptions = ChatOptions;

export interface ChatFullResponse {
    text: string;
    finishReason?: string | null;
    continuationToken?: string | null;
    hops?: number;
    tool_calls?: unknown[];
    groundingMetadata?: Record<string, unknown> | null;
    usage?: {
        initialPromptTokens?: number;
        inputTokens?: number;
        cachedTokens?: number;
        outputTokens?: number;
        thoughtTokens?: number;
        totalTokens?: number;
        hops?: number;
        estimatedCostUsd?: number;
    };
}

export interface ResolvedModelConfig {
    provider: LLMProvider;
    model: string;
    apiUrl: string;
    maxTokens: number;
    temperature: number;
    thinkingLevel?: ThinkingLevel;
    analysisModel: string;
}

export declare function isGemini4Model(modelName?: string): boolean;

export declare function normalizeThinkingLevel(
    level?: string,
    modelName?: string
): ThinkingLevel | undefined;

export declare function resolveMaxOutputTokens(
    modelName: string,
    config?: Record<string, unknown>,
    options?: Record<string, unknown>
): number;

export declare function chat(
    systemPrompt: string,
    userMessage: string,
    config: LLMConfig,
    options: ChatOptions & { returnFullResponse: true }
): Promise<ChatFullResponse>;

export declare function chat(
    systemPrompt: string,
    userMessage: string,
    config: LLMConfig,
    options?: ChatOptions
): Promise<string>;

export declare function chatJson<TResult = Record<string, any>>(
    systemPrompt: string,
    userMessage: string,
    config: LLMConfig,
    options?: ChatOptions
): Promise<TResult>;

export declare function resolveGeminiToolConfig(
    config?: Partial<LLMConfig> & Record<string, unknown>,
    options?: ChatOptions
): Record<string, unknown> | undefined;

export declare function buildGeminiPayload(
    systemPrompt: string,
    userMessage: string,
    config: Partial<LLMConfig> & Record<string, unknown>,
    options?: ChatOptions,
    continuationToken?: string
): Record<string, unknown>;

export declare function extractGeminiTextParts(
    parts?: Array<{ text?: string; thought?: boolean; [key: string]: unknown }>
): string;

export declare function resolveModelConfig(
    taskName: string,
    config?: Record<string, any>
): ResolvedModelConfig;
