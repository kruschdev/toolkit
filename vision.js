/**
 * @module vision
 * Shared Gemini Vision client for multi-modal payloads (Gemini 4 Argon ready).
 */

import { parseAIJson } from './json-parse.js';
import {
    isGemini4Model,
    normalizeThinkingLevel,
    resolveMaxOutputTokens,
    extractGeminiTextParts
} from './llm.js';

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * Send a prompt with one or more media files (image/video/pdf) to the Gemini model.
 *
 * @param {string} prompt - Instruction or prompt
 * @param {string|null} [base64Data] - Primary Base64 encoded media data (optional when config.mediaItems is used)
 * @param {string} [mimeType='image/png'] - MIME type of the primary media (e.g. image/png, image/jpeg, video/mp4)
 * @param {object} [config={}] - Configuration
 * @param {string} [config.apiKey] - Gemini API key (defaults to process.env.GEMINI_API_KEY)
 * @param {string} [config.model='gemini-4-argon'] - Model name (defaults to gemini-4-argon; supports 'ARGON' and 'PRECISION' aliases)
 * @param {Array<{base64Data: string, mimeType?: string, label?: string}>} [config.mediaItems] - Additional or multi-viewport media items
 * @param {string} [config.mediaResolution] - e.g. 'high' or 'low'
 * @param {number} [config.maxOutputTokens] - maximum output tokens
 * @param {'low'|'medium'|'high'} [config.thinkingLevel] - thinking level for Gemini 4 models
 * @param {boolean} [config.automaticContinuation=true] - Follow Gemini 4 continuationToken hops automatically
 * @param {string} [config.continuationToken] - Initial continuation token to resume a long decode
 * @param {number} [config.maxContinuationHops=8] - Maximum multi-hop continuation requests
 * @param {object} [config.responseSchema] - Optional structured JSON schema
 * @param {boolean} [config.returnFullResponse=false] - Return metadata, hops, and token usage alongside text
 * @param {number} [config.timeoutMs] - request timeout in ms
 * @returns {Promise<string|object>} text response (or full response object when config.returnFullResponse is true)
 */
export async function callGeminiMedia(prompt, base64Data, mimeType = 'image/png', config = {}) {
    const apiKey = config.apiKey || process.env.GEMINI_API_KEY;
    if (!apiKey) {
        throw new Error('Gemini Vision: apiKey is required');
    }

    const modelName = config.model || 'gemini-4-argon';
    // Support using "PRECISION", "ARGON", or other custom model aliases
    const resolvedModel = modelName === 'PRECISION'
        ? 'gemini-2.5-pro'
        : (modelName === 'ARGON' ? 'gemini-4-argon' : modelName);

    const gemini4 = isGemini4Model(resolvedModel);
    const timeoutMs = config.timeoutMs || (gemini4 ? 1200000 : 120000);

    const baseUrl = config.apiUrl || GEMINI_BASE_URL;
    const url = `${baseUrl}/models/${resolvedModel}:generateContent?key=${apiKey}`;

    const inputParts = [{ text: prompt }];
    if (base64Data) {
        inputParts.push({
            inlineData: {
                mimeType: mimeType || 'image/png',
                data: base64Data
            }
        });
    }

    if (Array.isArray(config.mediaItems)) {
        for (const item of config.mediaItems) {
            if (!item || !item.base64Data) continue;
            if (item.label) {
                inputParts.push({ text: `[Viewport: ${item.label}]` });
            }
            inputParts.push({
                inlineData: {
                    mimeType: item.mimeType || 'image/png',
                    data: item.base64Data
                }
            });
        }
    }

    const thinkingLevel = normalizeThinkingLevel(config.thinkingLevel, resolvedModel);
    const maxOutputTokens = config.maxOutputTokens ?? resolveMaxOutputTokens(resolvedModel, {
        ...config,
        maxTokens: config.maxOutputTokens ?? config.maxTokens
    });

    const generationConfig = {
        ...(!gemini4 && config.temperature != null ? { temperature: config.temperature } : {}),
        ...(maxOutputTokens ? { maxOutputTokens } : {}),
        ...(thinkingLevel ? { thinkingConfig: { thinkingLevel } } : {}),
        ...(config.responseSchema ? {
            responseMimeType: 'application/json',
            responseSchema: config.responseSchema
        } : {})
    };

    const automaticContinuation = config.automaticContinuation !== false;
    const maxHops = config.maxContinuationHops ?? 8;
    let token = config.continuationToken || undefined;

    const allParts = [];
    let initialPromptTokens = undefined;
    let inputTokens = 0;
    let cachedTokens = 0;
    let outputTokens = 0;
    let thoughtTokens = 0;
    let totalTokens = 0;
    let finishReason = null;
    let hops = 0;

    while (hops < maxHops) {
        hops += 1;
        const payload = {
            ...(config.systemInstruction ? {
                system_instruction: { parts: [{ text: config.systemInstruction }] }
            } : {}),
            contents: [
                {
                    parts: inputParts
                }
            ],
            ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
            ...(token ? { continuationToken: token } : {})
        };

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': apiKey
            },
            signal: AbortSignal.timeout(timeoutMs),
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errorBody = await response.text();
            throw new Error(`Gemini Vision API ${response.status}: ${errorBody}`);
        }

        const data = await response.json();
        const candidate = data.candidates?.[0];
        if (candidate?.content?.parts) {
            allParts.push(...candidate.content.parts);
        }

        const usageMeta = data.usageMetadata || {};
        if (hops === 1 && usageMeta.promptTokenCount != null) {
            initialPromptTokens = usageMeta.promptTokenCount;
        }
        inputTokens += usageMeta.promptTokenCount || 0;
        cachedTokens += usageMeta.cachedContentTokenCount || 0;
        outputTokens += usageMeta.candidatesTokenCount || 0;
        thoughtTokens += usageMeta.thoughtsTokenCount || 0;
        totalTokens += usageMeta.totalTokenCount || 0;

        token = candidate?.continuationToken;
        finishReason = candidate?.finishReason || null;

        if (!automaticContinuation || finishReason !== 'CONTINUATION' || !token) {
            break;
        }
    }

    const text = extractGeminiTextParts(allParts).trim();

    if (config.returnFullResponse) {
        return {
            text,
            finishReason,
            continuationToken: token || null,
            hops,
            model: resolvedModel,
            usage: {
                initialPromptTokens: initialPromptTokens ?? inputTokens,
                inputTokens,
                cachedTokens,
                outputTokens,
                thoughtTokens,
                totalTokens: totalTokens || (inputTokens + outputTokens + thoughtTokens)
            }
        };
    }

    return text;
}

/**
 * Send a prompt with media to Gemini Vision and parse the response as JSON.
 *
 * @param {string} prompt - Instruction or prompt requesting JSON output
 * @param {string|null} [base64Data] - Primary Base64 encoded media data
 * @param {string} [mimeType='image/png'] - MIME type of the media
 * @param {object} [config={}] - Configuration passed to callGeminiMedia
 * @returns {Promise<object|Array>} Parsed JSON object
 */
export async function callGeminiMediaJson(prompt, base64Data, mimeType = 'image/png', config = {}) {
    const text = await callGeminiMedia(prompt, base64Data, mimeType, {
        ...config,
        returnFullResponse: false
    });
    return parseAIJson(text, { allowPartial: true });
}

