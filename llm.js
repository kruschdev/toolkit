/**
 * @module llm
 * Unified LLM client — wraps Gemini, Grok/xAI, and Ollama behind one API.
 * Switch providers via config, same `chat()` interface everywhere.
 *
 * Enhanced with FTF patterns: Gemini REST API, analysis model support,
 * per-call maxTokens, and proper system instruction handling.
 */

import { parseAIJson } from './json-parse.js';
import { Agent, setGlobalDispatcher } from 'undici';

// Overcome the 5-minute Undici headersTimeout for heavily-queued local Ollama requests
setGlobalDispatcher(new Agent({
    headersTimeout: 12000000,
    bodyTimeout: 12000000,
    connectTimeout: 12000000
}));

/**
 * @typedef {object} LLMConfig
 * @property {'gemini'|'xai'|'ollama'} provider - Which LLM provider to use
 * @property {string} apiKey - API key (not needed for Ollama)
 * @property {string} model - Model name (fast model for chat)
 * @property {string} [analysisModel] - Heavy-duty model for deep analysis
 * @property {string} [apiUrl] - Custom API URL (required for xAI; optional Gemini override)
 * @property {number} [temperature=0.7] - Temperature
 * @property {number} [maxTokens=2000] - Max tokens
 */

/**
 * Send a chat message to any supported LLM provider.
 *
 * @param {string} systemPrompt - System/role prompt
 * @param {string} userMessage - User message
 * @param {LLMConfig} config - Provider configuration
 * @param {object} [options] - Per-call overrides
 * @param {boolean} [options.useAnalysisModel] - Use the analysis model instead of fast model
 * @param {number} [options.maxTokens] - Override maxTokens for this call
 * @param {number} [options.temperature] - Override temperature for this call
 * @returns {Promise<string>} Raw text response
 */
export async function chat(systemPrompt, userMessage, config, options = {}) {
    const { provider } = config;

    // Resolve model: analysis model override or default
    const resolvedConfig = {
        ...config,
        model: options.useAnalysisModel && config.analysisModel
            ? config.analysisModel
            : config.model,
        maxTokens: options.maxTokens ?? config.maxTokens ?? 2000,
        temperature: options.temperature ?? config.temperature ?? 0.7,
        messages: options.messages
    };

    let responseText;

    switch (provider) {
        case 'gemini':
            responseText = await chatGemini(systemPrompt, userMessage, resolvedConfig, options);
            break;
        case 'openai':
            responseText = await chatOpenAICompat(systemPrompt, userMessage, {
                ...resolvedConfig,
                apiUrl: resolvedConfig.apiUrl || 'https://api.openai.com/v1/chat/completions',
            }, options);
            break;
        case 'xai':
        case 'grok':
            responseText = await chatOpenAICompat(systemPrompt, userMessage, resolvedConfig, options);
            break;
        case 'ollama':
            responseText = await chatOpenAICompat(systemPrompt, userMessage, {
                ...resolvedConfig,
                apiUrl: resolvedConfig.apiUrl || 'http://localhost:11434/v1/chat/completions',
            }, options);
            break;
        default:
            throw new Error(`Unknown LLM provider: ${provider}. Supported: gemini, openai, xai, ollama`);
    }


    return responseText;
}

/**
 * Chat and parse the response as JSON.
 * Combines chat() + parseAIJson() in one call.
 *
 * @param {string} systemPrompt - System prompt (should instruct JSON output)
 * @param {string} userMessage - User message
 * @param {LLMConfig} config - Provider configuration
 * @param {object} [options] - Per-call overrides (same as chat())
 * @returns {Promise<object>} Parsed JSON response
 */
export async function chatJson(systemPrompt, userMessage, config, options = {}) {
    const text = await chat(systemPrompt, userMessage, {
        ...config,
        format: 'json'
    }, options);
    return parseAIJson(text, { allowPartial: true });
}

/**
 * Chat directly returning the raw completion response object, meant for Tool-calling ReAct loops.
 */
export async function chatWithTools(config, messages, tools, options = {}) {
    const { provider } = config;
    
    const timeoutMs = options.timeout || config.timeout || 120000;
    
    let processedMessages = [...messages];
    if (options.injectHermesTraces) {
        const { buildReasoningTraces } = await import('./agents.js');
        const traces = await buildReasoningTraces();
        const systemIndex = processedMessages.findIndex(m => m.role === 'system');
        if (systemIndex !== -1) {
            processedMessages.splice(systemIndex + 1, 0, ...traces);
        } else {
            processedMessages.unshift(...traces);
        }
    }

    if (provider === 'gemini') {
        const apiKey = config.apiKey || process.env.GEMINI_API_KEY;
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent?key=${apiKey}`;
        
        // Map tools to Gemini schema
        const geminiTools = tools ? [{ functionDeclarations: tools.map(t => ({
             name: t.function.name,
             description: t.function.description,
             parameters: t.function.parameters
        })) }] : undefined;

        const geminiMessages = processedMessages.map(m => {
            if (m.role === 'tool') {
                let parsedResponse;
                try {
                    parsedResponse = JSON.parse(m.content);
                    if (typeof parsedResponse !== 'object' || parsedResponse === null) {
                        parsedResponse = { result: parsedResponse };
                    }
                } catch (e) {
                    parsedResponse = { result: m.content };
                }
                return { role: 'function', parts: [{ functionResponse: { name: m.name, response: parsedResponse } }] };
            }
            if (m.tool_calls) {
                return { role: 'model', parts: m.tool_calls.map(tc => ({ functionCall: { name: tc.function.name, args: JSON.parse(tc.function.arguments) } })) };
            }
            return { role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content || '' }] };
        });

        const res = await fetch(url, {
            method: 'POST',
            signal: AbortSignal.timeout(timeoutMs),
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: geminiMessages,
                tools: geminiTools
            }) // Simplified options
        });

        if (!res.ok) throw new Error(`Gemini Error: ${await res.text()}`);
        const data = await res.json();
        const parts = data.candidates?.[0]?.content?.parts || [];
        
        // Map function call parts back to OpenAI-compatible format
        const fnCalls = parts.filter(p => p.functionCall).map(p => ({
           function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args) }
        }));
        
        if (fnCalls.length > 0) {
           return { content: '', tool_calls: fnCalls };
        }
        return { content: parts[0]?.text || '' };
    }
    
    // Default to OpenAI / Ollama compatible
    const url = config.apiUrl || 'http://localhost:11434/v1/chat/completions';
    const res = await fetch(url, {
        method: 'POST',
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
            'Content-Type': 'application/json',
            ...(config.apiKey && { 'Authorization': `Bearer ${config.apiKey}` })
        },
        body: JSON.stringify({
            model: config.model,
            messages: processedMessages,
            tools,
            stream: false
        })
    });
    
    if (!res.ok) throw new Error(`LLM Error: ${await res.text()}`);
    const data = await res.json();
    return data.choices?.[0]?.message || data.message;
}

// ── Gemini (REST API — proper system instruction support) ───────────────────

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

async function chatGemini(systemPrompt, userMessage, config, options = {}) {
    const apiKey = config.apiKey;
    const timeoutMs = options.timeout || config.timeout || 120000;
    if (!apiKey) throw new Error('Gemini: apiKey is required');

    const baseUrl = config.apiUrl || GEMINI_BASE_URL;
    const url = `${baseUrl}/models/${config.model}:generateContent?key=${apiKey}`;

    const res = await fetch(url, {
        method: 'POST',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            system_instruction: config.messages 
                ? { parts: [{ text: config.messages.find(m => m.role === 'system')?.content || systemPrompt || '' }] }
                : { parts: [{ text: systemPrompt }] },
            contents: config.messages
                ? config.messages.filter(m => m.role !== 'system').map(m => ({
                    role: m.role === 'assistant' ? 'model' : 'user',
                    parts: [{ text: m.content }]
                }))
                : [{ role: 'user', parts: [{ text: userMessage }] }],
            generationConfig: {
                temperature: config.temperature,
                maxOutputTokens: config.maxTokens,
                ...(config.responseSchema && {
                    responseMimeType: 'application/json',
                    responseSchema: config.responseSchema
                }),
            },
        }),
    });

    if (!res.ok) {
        const err = await res.text();
        throw new Error(`Gemini API ${res.status}: ${err}`);
    }

    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!text) {
        console.error(`\n[LLM DEBUG] Gemini returned empty response. Raw payload:`, JSON.stringify(data, null, 2));
    }
    return text.trim();
}

// ── OpenAI-Compatible (xAI/Grok, Ollama, etc.) ─────────────────────────────

async function chatOpenAICompat(systemPrompt, userMessage, config, options = {}) {
    const url = config.apiUrl;
    const timeoutMs = options.timeout || config.timeout || 1200000;
    if (!url) {
        throw new Error(`${config.provider}: apiUrl is required`);
    }

    const headers = { 'Content-Type': 'application/json' };
    if (config.apiKey) {
        headers['Authorization'] = `Bearer ${config.apiKey}`;
    }

    const baseMessages = config.messages || [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
    ];
    
    // Auto-wrap tool_calls.function.arguments tracking Go struct json panics in Ollama/BitNet
    const processedMessages = baseMessages.map(m => {
        if (m.tool_calls) {
            return {
                ...m,
                tool_calls: m.tool_calls.map(tc => {
                    if (tc.function && typeof tc.function.arguments === 'object') {
                        return {
                            ...tc,
                            function: {
                                ...tc.function,
                                arguments: JSON.stringify(tc.function.arguments)
                            }
                        };
                    }
                    return tc;
                })
            };
        }
        return m;
    });

    const res = await fetch(url, {
        method: 'POST',
        signal: AbortSignal.timeout(timeoutMs),
        headers,
        body: JSON.stringify({
            model: config.model,
            messages: processedMessages,
            stream: false,
            temperature: config.temperature,
            max_tokens: config.maxTokens,
            response_format: config.responseSchema
                ? { type: 'json_schema', json_schema: { name: 'output', strict: true, schema: config.responseSchema } }
                : (config.format === 'json' ? { type: 'json_object' } : undefined)
        }),
    });

    if (!res.ok) {
        const err = await res.text();
        throw new Error(`${config.provider} API ${res.status}: ${err}`);
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content || data.message?.content || '';
}

/**
 * Streams parsed JSON objects from an LLM response array incrementally.
 * Uses an SSE stream from an OpenAI-compatible endpoint and a depth-aware string parser.
 * 
 * @param {string} systemPrompt 
 * @param {string} userMessage 
 * @param {object} config 
 * @param {object} options 
 * @yields {object} Parsed JSON objects
 */
export async function* streamJsonArray(systemPrompt, userMessage, config, options = {}) {
    const { provider, apiUrl, model, maxTokens, temperature } = config;
    const targetKey = options.targetKey || 'components';
    const timeoutMs = options.timeout || config.timeout || 300000;
    
    if (provider === 'gemini') {
        const text = await chatGemini(systemPrompt, userMessage, config, options);
        const { parseAIJson } = await import('./json-parse.js');
        let parsed = parseAIJson(text, { allowPartial: true });
        const array = parsed[targetKey] || (Array.isArray(parsed) ? parsed : []);
        for (const item of array) yield item;
        return;
    }

    const url = apiUrl || 'http://localhost:11434/v1/chat/completions';
    const headers = { 'Content-Type': 'application/json' };
    if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`;

    const res = await fetch(url, {
        method: 'POST',
        signal: AbortSignal.timeout(timeoutMs),
        headers,
        body: JSON.stringify({
            model: model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userMessage },
            ],
            stream: true,
            temperature: temperature || 0.1,
            max_tokens: maxTokens,
        }),
    });

    if (!res.ok) throw new Error(`${provider} Stream API ${res.status}: ${await res.text()}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    
    let buffer = '';
    let bufferPos = 0;
    let insideTargetArray = false;
    let objectDepth = 0;
    let objectBuffer = '';
    let inString = false;
    let escapeNext = false;

    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        
        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n');

        for (const line of lines) {
            if (!line.trim() || !line.startsWith('data: ')) continue;
            const dataStr = line.substring(6);
            if (dataStr === '[DONE]') continue;
            
            try {
                const data = JSON.parse(dataStr);
                const token = data.choices?.[0]?.delta?.content || '';
                if (!token) continue;
                
                process.stdout.write(token);
                buffer += token;
                
                while (bufferPos < buffer.length) {
                    const char = buffer[bufferPos];
                    
                    if (!insideTargetArray) {
                        const keyIdx = buffer.indexOf(`"${targetKey}"`);
                        if (keyIdx !== -1) {
                            const bracketIdx = buffer.indexOf('[', keyIdx);
                            if (bracketIdx !== -1) {
                                if (bufferPos <= bracketIdx) {
                                    bufferPos = bracketIdx + 1;
                                    insideTargetArray = true;
                                    continue;
                                }
                            }
                        }
                        bufferPos++;
                        continue;
                    }

                    if (!inString && char === '"') inString = true;
                    else if (inString && char === '"' && !escapeNext) inString = false;
                    
                    if (inString && char === '\\' && !escapeNext) escapeNext = true;
                    else escapeNext = false;

                    if (!inString) {
                        if (char === '{') {
                            if (objectDepth === 0) objectBuffer = ''; 
                            objectDepth++;
                        }
                    }
                    
                    if (objectDepth > 0 || (char === '}' && !inString)) {
                        objectBuffer += char;
                    }

                    if (!inString) {
                        if (char === '}') {
                            objectDepth--;
                            if (objectDepth === 0 && objectBuffer.trim().startsWith('{')) {
                                try {
                                    yield JSON.parse(objectBuffer);
                                } catch (e) {
                                    console.warn(`[StreamParser] Failed to parse snippet: ${e.message}`);
                                }
                                objectBuffer = '';
                            }
                        }
                        if (objectDepth === 0 && char === ']') {
                            insideTargetArray = false;
                        }
                    }
                    
                    bufferPos++;
                }
            } catch (e) {}
        }
    }
}

/**
 * Streams parsed protocol blocks from an LLM text response.
 * Yields objects of the form { type: 'COMPONENT' | 'STEP', content: '...' }
 * as soon as they are fully buffered (detected by the start of the next block).
 */
export async function* streamProtocolBlocks(systemPrompt, userMessage, config, options = {}) {
    const { provider, apiUrl, model, maxTokens, temperature } = config;
    const timeoutMs = options.timeout || config.timeout || 300000;
    
    if (provider === 'gemini') {
        const text = await chatGemini(systemPrompt, userMessage, config, options);
        // Fallback: Just parse the full text at once
        const blocks = [];
        const regex = /\[(COMPONENT|STEP)[^\]]*\]\s*([\s\S]*?)(?=\[(?:COMPONENT|STEP)[^\]]*\]|$)/g;
        let match;
        while ((match = regex.exec(text)) !== null) {
            blocks.push({ type: match[1], content: match[2].trim() });
        }
        for (const block of blocks) yield block;
        return;
    }

    const url = apiUrl || 'http://localhost:11434/v1/chat/completions';
    const headers = { 'Content-Type': 'application/json' };
    if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`;

    const res = await fetch(url, {
        method: 'POST',
        signal: AbortSignal.timeout(timeoutMs),
        headers,
        body: JSON.stringify({
            model: model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userMessage },
            ],
            stream: true,
            temperature: temperature || 0.1,
            max_tokens: maxTokens,
        }),
    });

    if (!res.ok) throw new Error(`${provider} Stream API ${res.status}: ${await res.text()}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    
    let buffer = '';
    let currentType = null;
    let currentContent = '';

    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        
        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n');

        for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const dataStr = line.slice(6);
            if (dataStr === '[DONE]') break;
            
            try {
                const parsed = JSON.parse(dataStr);
                const token = parsed.choices?.[0]?.delta?.content || '';
                if (!token) continue;
                
                process.stdout.write(token);
                buffer += token;

                // Check for block delimiters in the buffer
                const match = buffer.match(/\[(COMPONENT|STEP)[^\]]*\]/);
                if (match) {
                    const idx = match.index;
                    
                    // If we were tracking a previous block, yield it now!
                    if (currentType) {
                        currentContent += buffer.slice(0, idx);
                        yield { type: currentType, content: currentContent.trim() };
                    }
                    
                    // Start tracking the new block
                    currentType = match[1];
                    currentContent = '';
                    
                    // Keep the remainder of the buffer after the delimiter
                    buffer = buffer.slice(idx + match[0].length);
                }
            } catch (e) {}
        }
        
        // Push safe parts of the buffer into currentContent to keep memory low
        if (currentType && buffer.length > 50) {
            currentContent += buffer.slice(0, -20); // Keep last 20 chars in case partial delimiter `[COMPO`
            buffer = buffer.slice(-20);
        }
    }
    
    if (currentType) {
        currentContent += buffer;
        yield { type: currentType, content: currentContent.trim() };
    }
}
