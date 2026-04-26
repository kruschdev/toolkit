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

