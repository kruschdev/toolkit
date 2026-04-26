/**
 * @module streaming
 * SSE streaming helpers — extracted from the Pocket Lawyer pattern.
 * Provides utilities for Server-Sent Events with dual-path fallback.
 *
 * Usage:
 *   import { sseResponse, streamChat } from '@krusch/toolkit/streaming';
 *
 *   app.get('/api/chat/stream', (req, res) => {
 *     const sse = sseResponse(res);
 *     await streamChat(systemPrompt, userMsg, config, (chunk) => sse.send(chunk));
 *     sse.end();
 *   });
 */

/**
 * Set up an Express response for Server-Sent Events.
 * Includes headers to bypass Cloudflare/Nginx buffering.
 *
 * @param {object} res - Express response object
 * @returns {object} SSE helpers: send(data), error(msg), end()
 */
export function sseResponse(res) {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',           // bypass Nginx buffering
        'Transfer-Encoding': 'chunked',       // bypass Cloudflare buffering
    });

    return {
        /**
         * Send a data event to the client.
         * @param {string|object} data - Data to send (objects are JSON-stringified)
         * @param {string} [event] - Optional event name
         */
        send(data, event = null) {
            const payload = typeof data === 'object' ? JSON.stringify(data) : data;
            if (event) res.write(`event: ${event}\n`);
            res.write(`data: ${payload}\n\n`);
        },

        /**
         * Send an error event.
         * @param {string} message - Error message
         */
        error(message) {
            res.write(`event: error\ndata: ${JSON.stringify({ error: message })}\n\n`);
        },

        /**
         * Signal stream completion and end the response.
         */
        end() {
            res.write('event: done\ndata: [DONE]\n\n');
            res.end();
        },
    };
}

/**
 * Stream a chat response chunk-by-chunk using Gemini's streaming API.
 * Falls back to a single response if streaming is not supported.
 *
 * @param {string} systemPrompt - System prompt
 * @param {string} userMessage - User message
 * @param {import('./llm.js').LLMConfig} config - LLM config
 * @param {function} onChunk - Callback for each text chunk
 * @returns {Promise<string>} Full response text
 */
export async function streamChat(systemPrompt, userMessage, config, onChunk) {
    const { provider, apiKey, model, temperature = 0.7, maxTokens = 2000 } = config;

    // Gemini streaming via REST API
    if (provider === 'gemini') {
        return streamGemini(systemPrompt, userMessage, {
            apiKey, model, temperature, maxTokens,
            apiUrl: config.apiUrl,
        }, onChunk);
    }

    // OpenAI-compatible streaming (xAI, Ollama)
    if (provider === 'xai' || provider === 'grok' || provider === 'ollama') {
        return streamOpenAICompat(systemPrompt, userMessage, config, onChunk);
    }

    // Fallback: non-streaming chat
    const { chat } = await import('./llm.js');
    const text = await chat(systemPrompt, userMessage, config);
    onChunk(text);
    return text;
}

// ── Gemini Streaming ────────────────────────────────────────────────────────

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

async function streamGemini(systemPrompt, userMessage, config, onChunk) {
    const baseUrl = config.apiUrl || GEMINI_BASE_URL;
    const url = `${baseUrl}/models/${config.model}:streamGenerateContent?key=${config.apiKey}&alt=sse`;

    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            system_instruction: { parts: [{ text: systemPrompt }] },
            contents: [{ role: 'user', parts: [{ text: userMessage }] }],
            generationConfig: {
                temperature: config.temperature,
                maxOutputTokens: config.maxTokens,
            },
        }),
    });

    if (!res.ok) {
        const err = await res.text();
        throw new Error(`Gemini streaming ${res.status}: ${err}`);
    }

    let fullText = '';
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep incomplete line

        for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const json = line.slice(6).trim();
            if (json === '[DONE]') continue;

            try {
                const parsed = JSON.parse(json);
                const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text || '';
                if (text) {
                    fullText += text;
                    onChunk(text);
                }
            } catch {
                // Skip malformed chunks
            }
        }
    }

    return fullText;
}

// ── OpenAI-Compatible Streaming ─────────────────────────────────────────────

async function streamOpenAICompat(systemPrompt, userMessage, config, onChunk) {
    const url = config.apiUrl || (config.provider === 'ollama'
        ? 'http://localhost:11434/v1/chat/completions'
        : null);

    if (!url) throw new Error(`${config.provider}: apiUrl is required for streaming`);

    const headers = { 'Content-Type': 'application/json' };
    if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`;

    const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            model: config.model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userMessage },
            ],
            stream: true,
            temperature: config.temperature ?? 0.7,
            max_tokens: config.maxTokens ?? 2000,
        }),
    });

    if (!res.ok) {
        const err = await res.text();
        throw new Error(`${config.provider} streaming ${res.status}: ${err}`);
    }

    let fullText = '';
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const json = line.slice(6).trim();
            if (json === '[DONE]') continue;

            try {
                const parsed = JSON.parse(json);
                const text = parsed.choices?.[0]?.delta?.content || '';
                if (text) {
                    fullText += text;
                    onChunk(text);
                }
            } catch {
                // Skip malformed chunks
            }
        }
    }

    return fullText;
}
