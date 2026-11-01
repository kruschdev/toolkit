import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ChatOptions, LLMConfig } from './llm.js';

export interface SseResponseOptions {
    heartbeatMs?: number;
    corsOrigin?: string | false | null;
    retryMs?: number;
    tool?: string;
    deferHeaders?: boolean;
}

export interface SseStreamHandle {
    readonly signal: AbortSignal;
    isClosed: () => boolean;
    send: (event: string, data: unknown) => boolean;
    sendToken: (delta: string, meta?: Record<string, unknown>) => boolean;
    done: (payload?: string | Record<string, unknown> | null) => void;
    error: (err: unknown) => void;
    close: () => void;
}

export type CustomStreamChatFn = (
    systemPrompt: string,
    userMessage: string,
    config: Partial<LLMConfig> & Record<string, unknown>,
    options: ChatOptions & { signal: AbortSignal }
) => Promise<string | { text?: string }> | string | { text?: string };

export interface StreamChatOptions {
    systemPrompt?: string;
    userMessage?: string;
    config?: Partial<LLMConfig> & Record<string, unknown>;
    options?: ChatOptions & Record<string, unknown>;
    chatFn?: CustomStreamChatFn | null;
    fetchImpl?: typeof fetch;
    tool?: string;
    heartbeatMs?: number;
    corsOrigin?: string | false | null;
    retryMs?: number;
}

export interface StreamChatResult {
    ok: boolean;
    aborted: boolean;
}

export declare function sseResponse(
    res: ServerResponse | Record<string, any>,
    req?: IncomingMessage | Record<string, any> | null,
    options?: SseResponseOptions
): SseStreamHandle;

export declare function streamChat(
    res: ServerResponse | Record<string, any>,
    req?: IncomingMessage | Record<string, any> | null,
    params?: StreamChatOptions
): Promise<StreamChatResult>;
