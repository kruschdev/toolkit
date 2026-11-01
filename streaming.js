/**
 * @module streaming
 * @description Server-Sent Events (SSE) & LLM token streaming bricks (`INV-LEGO-01`, `INV-LEGO-03`)
 * with automatic `AbortController` teardown on client disconnect and unref'd keep-alive heartbeats.
 */

import { chat } from './llm.js';
import { okEnvelope, errorEnvelope } from './http.js';

/**
 * Format an SSE event frame while safely splitting multi-line string payloads across `data:` lines.
 *
 * @param {string} event - SSE event type
 * @param {unknown} data - String or JSON-serializable payload
 * @returns {string}
 */
function formatSseFrame(event, data) {
    const safeEvent = String(event || 'message').replace(/[\r\n]+/g, ' ').trim() || 'message';
    const dataBlock = typeof data === 'string'
        ? data.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').map((line) => `data: ${line}`).join('\n')
        : `data: ${JSON.stringify(data ?? null)}`;
    return `event: ${safeEvent}\n${dataBlock}\n\n`;
}

/**
 * Apply HTTP 200 Server-Sent Event headers across native `http.ServerResponse` and test doubles.
 *
 * @param {import('node:http').ServerResponse} res - Outgoing response
 * @param {string} corsOrigin - `Access-Control-Allow-Origin` value
 */
function writeSseHeaders(res, corsOrigin) {
    if (res.headersSent) return;
    const hasMiddlewareDecision = typeof res.getHeader === 'function' && (
        res.getHeader('Access-Control-Allow-Origin') !== undefined ||
        res.getHeader('Vary') !== undefined ||
        res.getHeader('X-Content-Type-Options') !== undefined
    );

    let effectiveCorsOrigin = '';
    if (corsOrigin === undefined) {
        effectiveCorsOrigin = hasMiddlewareDecision ? '' : '*';
    } else if (corsOrigin) {
        effectiveCorsOrigin = String(corsOrigin).replace(/[\r\n]+/g, '').trim();
    } else if (typeof res.removeHeader === 'function') {
        res.removeHeader('Access-Control-Allow-Origin');
    }

    const headers = {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        ...(effectiveCorsOrigin ? { 'Access-Control-Allow-Origin': effectiveCorsOrigin } : {}),
    };

    if (typeof res.setHeader === 'function') {
        res.statusCode = 200;
        for (const [key, value] of Object.entries(headers)) {
            res.setHeader(key, value);
        }
    } else if (typeof res.writeHead === 'function') {
        res.writeHead(200, headers);
    }

    res.socket?.setNoDelay?.(true);
    res.flushHeaders?.();
}

/**
 * Open an SSE stream on an HTTP response with keep-alive heartbeats and `AbortController` cancellation
 * wired to client disconnect (`INV-LEGO-03`).
 *
 * @param {import('node:http').ServerResponse} res - Outgoing HTTP response
 * @param {import('node:http').IncomingMessage|null} [req=null] - Optional incoming HTTP request
 * @param {object} [options={}] - SSE options
 * @param {number} [options.heartbeatMs=15000] - Heartbeat ping interval in milliseconds
 * @param {string|false|null} [options.corsOrigin] - Explicit `Access-Control-Allow-Origin` override (preserves middleware CORS if omitted, or defaults standalone responses to `'*'`)
 * @param {number} [options.retryMs=3000] - Client reconnection `retry:` hint in milliseconds
 * @param {string} [options.tool='sse'] - Default `INV-LEGO-01` tool identifier for terminal `done`/`error` events
 * @param {boolean} [options.deferHeaders=false] - Defer `writeHead`/`flushHeaders` so downstream transports (e.g. MCP `SSEServerTransport`) can emit status/headers without `ERR_HTTP_HEADERS_SENT`
 * @returns {{
 *   signal: AbortSignal,
 *   isClosed: () => boolean,
 *   send: (event: string, data: unknown) => boolean,
 *   sendToken: (delta: string, meta?: object) => boolean,
 *   done: (payload?: string|object) => void,
 *   error: (err: unknown) => void,
 *   close: () => void
 * }}
 */
export function sseResponse(res, req = null, { heartbeatMs = 15000, corsOrigin = undefined, retryMs = 3000, tool = 'sse', deferHeaders = false } = {}) {
    const defaultTool = String(tool || 'sse');
    const controller = new AbortController();
    let closed = Boolean(
        res.writableEnded ||
        res.destroyed ||
        res.closed ||
        res.socket?.destroyed ||
        req?.aborted ||
        req?.socket?.destroyed ||
        (req?.destroyed && req?.complete !== true)
    );
    let heartbeatTimer = null;

    if (closed) {
        controller.abort();
    } else if (deferHeaders) {
        if (!res.headersSent && typeof res.setHeader === 'function') {
            res.setHeader('X-Accel-Buffering', 'no');
        }
        res.socket?.setNoDelay?.(true);
    } else {
        writeSseHeaders(res, corsOrigin);
        if (retryMs > 0) {
            try {
                res.write(`retry: ${Math.floor(retryMs)}\n\n`);
            } catch {
                closed = true;
                controller.abort();
            }
        }
    }

    const clearHeartbeat = () => {
        if (heartbeatTimer !== null) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
        }
    };

    const detachListeners = () => {
        req?.off?.('close', onReqClose);
        req?.off?.('aborted', onAbortDisconnect);
        res?.off?.('close', onAbortDisconnect);
    };

    const onAbortDisconnect = () => {
        if (closed) return;
        closed = true;
        clearHeartbeat();
        detachListeners();
        if (!controller.signal.aborted) {
            controller.abort();
        }
    };

    const onReqClose = () => {
        if (req?.complete === true && res?.socket && !res.socket.destroyed && !res.destroyed && !res.closed) {
            return;
        }
        onAbortDisconnect();
    };

    if (!closed) {
        req?.on?.('close', onReqClose);
        req?.on?.('aborted', onAbortDisconnect);
        res?.on?.('close', onAbortDisconnect);

        if (heartbeatMs > 0) {
            heartbeatTimer = setInterval(() => {
                if (closed || res.writableEnded || res.destroyed || res.closed || res.socket?.destroyed) {
                    clearHeartbeat();
                    return;
                }
                if (deferHeaders && !res.headersSent) {
                    return;
                }
                try {
                    res.write(': ping\n\n');
                } catch {
                    onAbortDisconnect();
                }
            }, heartbeatMs);
            heartbeatTimer.unref?.();
        }
    }

    const send = (event, data) => {
        if (closed || res.writableEnded || res.destroyed || res.closed || res.socket?.destroyed) {
            onAbortDisconnect();
            return false;
        }
        try {
            if (deferHeaders && !res.headersSent) {
                writeSseHeaders(res, corsOrigin);
            }
            res.write(formatSseFrame(event, data));
            return true;
        } catch {
            onAbortDisconnect();
            return false;
        }
    };

    const sendToken = (delta, meta = {}) => send('token', {
        delta: String(delta ?? ''),
        ...(meta && typeof meta === 'object' ? meta : {}),
    });

    const close = () => {
        if (!closed) {
            closed = true;
            clearHeartbeat();
            detachListeners();
        }
        if (!res.writableEnded && !res.destroyed && !res.closed && !res.socket?.destroyed) {
            res.end?.();
        }
    };

    const done = (payload = {}) => {
        let body;
        if (typeof payload === 'string') {
            body = okEnvelope(defaultTool, payload || 'Stream complete', {});
        } else if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
            const resolvedTool = String(payload.tool || defaultTool);
            const resolvedSummary = String(payload.summary || 'Stream complete');
            if (payload.data !== null && typeof payload.data === 'object' && !Array.isArray(payload.data)) {
                body = {
                    ...payload,
                    ok: true,
                    tool: resolvedTool,
                    summary: resolvedSummary,
                    data: payload.data,
                };
            } else {
                const { ok: _ok, tool: _t, summary: _s, data: rawData, ...rest } = payload;
                body = okEnvelope(
                    resolvedTool,
                    resolvedSummary,
                    rawData !== undefined && rawData !== null ? { value: rawData, ...rest } : rest
                );
            }
        } else {
            body = okEnvelope(defaultTool, 'Stream complete', payload === undefined || payload === null ? {} : { value: payload });
        }
        send('done', body);
        close();
    };

    const error = (err) => {
        const code = String(err?.code || 'STREAM_ERROR');
        const message = String(err?.message || err || 'Stream failed');
        const details = err?.details !== undefined ? err.details : null;
        const resolvedTool = String(err?.tool || defaultTool);
        send('error', errorEnvelope(code, message, details, resolvedTool));
        close();
    };

    return {
        signal: controller.signal,
        isClosed: () => closed,
        send,
        sendToken,
        done,
        error,
        close,
    };
}

/**
 * Stream NDJSON chat chunks directly from an Ollama `/api/chat` endpoint into an active `sse` session.
 *
 * @param {ReturnType<typeof sseResponse>} sse - Active SSE session
 * @param {object} params - Ollama request parameters
 * @returns {Promise<string>} Accumulated full response text
 */
async function streamOllamaChat(sse, { systemPrompt, userMessage, config, fetchImpl }) {
    const baseUrl = String(config.apiUrl || config.host || 'http://127.0.0.1:11434')
        .replace(/\/(?:v1\/chat\/completions|api\/chat)\/?$/, '')
        .replace(/\/+$/, '');
    const messages = [
        ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
        { role: 'user', content: userMessage },
    ];

    const response = await fetchImpl(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: sse.signal,
        body: JSON.stringify({
            model: config.model,
            stream: true,
            messages,
        }),
    });

    if (!response.ok) {
        const errText = typeof response.text === 'function' ? await response.text() : '';
        const httpErr = new Error(`Ollama stream HTTP ${response.status}: ${errText}`);
        httpErr.code = `HTTP_${response.status}`;
        throw httpErr;
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';

    const emitLine = (rawLine) => {
        const line = rawLine.trim();
        if (!line) return;
        const parsed = JSON.parse(line);
        if (parsed?.error) {
            const streamErr = new Error(String(parsed.error));
            streamErr.code = 'OLLAMA_STREAM_ERROR';
            throw streamErr;
        }
        const chunkText = parsed?.message?.content ?? parsed?.response ?? '';
        if (chunkText && !sse.isClosed()) {
            fullText += chunkText;
            sse.sendToken(chunkText);
        }
    };

    if (response.body && typeof response.body.getReader === 'function') {
        const reader = response.body.getReader();
        let streamCompleted = false;
        try {
            while (!sse.isClosed() && !sse.signal.aborted) {
                const { done, value } = await reader.read();
                if (done) {
                    streamCompleted = true;
                    break;
                }
                buffer += typeof value === 'string' ? value : decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() ?? '';
                for (const line of lines) emitLine(line);
            }
            if (streamCompleted) {
                buffer += decoder.decode();
                if (buffer.trim() && !sse.isClosed() && !sse.signal.aborted) emitLine(buffer);
            }
        } finally {
            if (!streamCompleted) {
                await Promise.resolve(reader.cancel()).catch(() => {});
            } else {
                reader.releaseLock?.();
            }
        }
    } else if (response.body && Symbol.asyncIterator in response.body) {
        for await (const chunk of response.body) {
            if (sse.isClosed() || sse.signal.aborted) break;
            buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) emitLine(line);
        }
        buffer += decoder.decode();
        if (buffer.trim() && !sse.isClosed() && !sse.signal.aborted) emitLine(buffer);
    }

    return fullText;
}

/**
 * Stream an LLM chat completion over SSE (`INV-LEGO-01`, `INV-LEGO-03`).
 * Streams NDJSON tokens natively when `config.provider === 'ollama'` (unless `chatFn` is supplied),
 * or wraps `chatFn || chat` (`@krusch/toolkit/llm`) with `AbortController` propagation.
 *
 * @param {import('node:http').ServerResponse} res - Outgoing HTTP response
 * @param {import('node:http').IncomingMessage|null} req - Incoming HTTP request
 * @param {object} [params={}] - Stream parameters
 * @param {string} [params.systemPrompt=''] - System instruction
 * @param {string} [params.userMessage=''] - User prompt
 * @param {object} [params.config={}] - LLM provider configuration
 * @param {object} [params.options={}] - Per-call LLM overrides
 * @param {Function|null} [params.chatFn=null] - Optional custom `(systemPrompt, userMessage, config, options)` override
 * @param {Function} [params.fetchImpl=globalThis.fetch] - Fetch implementation for Ollama streaming
 * @param {string} [params.tool='streamChat'] - Tool identifier for the completion envelope
 * @param {number} [params.heartbeatMs=15000] - SSE heartbeat interval in milliseconds
 * @param {string|false|null} [params.corsOrigin] - Optional explicit CORS origin override
 * @param {number} [params.retryMs=3000] - Client reconnection `retry:` hint in milliseconds
 * @returns {Promise<{ ok: boolean, aborted: boolean }>}
 */
export async function streamChat(
    res,
    req,
    {
        systemPrompt = '',
        userMessage = '',
        config = {},
        options = {},
        chatFn = null,
        fetchImpl = globalThis.fetch,
        tool = 'streamChat',
        heartbeatMs = 15000,
        corsOrigin = undefined,
        retryMs = 3000,
    } = {}
) {
    const sse = sseResponse(res, req, { heartbeatMs, corsOrigin, retryMs, tool });
    if (sse.isClosed()) {
        return { ok: true, aborted: Boolean(sse.signal.aborted) };
    }

    try {
        if (!chatFn && config?.provider === 'ollama') {
            const fullText = await streamOllamaChat(sse, {
                systemPrompt,
                userMessage,
                config,
                fetchImpl,
            });
            if (!sse.isClosed() && !sse.signal.aborted) {
                sse.done({ ok: true, tool, summary: 'Stream complete', data: { text: fullText } });
            }
        } else {
            const fn = chatFn || chat;
            let onAbort = null;
            const abortPromise = new Promise((_, reject) => {
                if (sse.signal.aborted) {
                    const err = new Error('SSE client disconnected');
                    err.name = 'AbortError';
                    reject(err);
                    return;
                }
                onAbort = () => {
                    const err = new Error('SSE client disconnected');
                    err.name = 'AbortError';
                    reject(err);
                };
                sse.signal.addEventListener('abort', onAbort, { once: true });
            });

            let raw;
            try {
                raw = await Promise.race([
                    Promise.resolve().then(() =>
                        fn(systemPrompt, userMessage, config, {
                            ...options,
                            signal: sse.signal,
                        })
                    ),
                    abortPromise,
                ]);
            } finally {
                if (onAbort) {
                    sse.signal.removeEventListener('abort', onAbort);
                }
            }

            const text = typeof raw === 'string' ? raw : String(raw?.text ?? '');
            if (!sse.isClosed() && !sse.signal.aborted) {
                sse.sendToken(text);
                sse.done({ ok: true, tool, summary: 'Stream complete', data: { text } });
            }
        }
    } catch (err) {
        if (sse.signal.aborted || sse.isClosed() || err?.name === 'AbortError') {
            sse.close();
        } else {
            sse.error(err);
        }
    }

    return { ok: true, aborted: Boolean(sse.signal.aborted) };
}
