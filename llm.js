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
import { startSpan, endSpan } from './tracing.js';
import {
    THREE_CHAIR_BANDIT_TIERS,
    createTierCircuitBreaker,
    selectCascadeTier,
    executeWithCascadeFallback,
} from './cascade.js';

let cachedCascadeRouterClass;
let cachedCascadeModule;
const sharedThreeChairBreaker = createTierCircuitBreaker({
    failureThreshold: 3,
    cooldownMs: 30_000,
});

async function loadCascadeRouterModule() {
    if (cachedCascadeModule === undefined) {
        try {
            cachedCascadeModule = await import('krusch-cascade-router');
        } catch {
            cachedCascadeModule = null;
        }
    }
    return cachedCascadeModule;
}

/**
 * Lazily load optional `krusch-cascade-router` so `@krusch/toolkit/llm` imports cleanly without it.
 *
 * @returns {Promise<Function>}
 */
async function loadCascadeRouterClass() {
    if (cachedCascadeRouterClass === undefined) {
        const mod = await loadCascadeRouterModule();
        cachedCascadeRouterClass = mod?.CascadeRouter ?? mod?.default ?? null;
    }
    if (!cachedCascadeRouterClass) {
        throw new Error('Optional dependency krusch-cascade-router is not installed');
    }
    return cachedCascadeRouterClass;
}

/**
 * Compute normalized task difficulty `[0, 1]` using `krusch-cascade-router`'s `<25µs` L0
 * `classifyPreRoute` / `evaluateComplexityScore` when installed, with a deterministic
 * heuristic fallback when running standalone.
 *
 * @param {string} promptText
 * @param {object} [hints={}]
 * @returns {Promise<{ complexityScore: number, role: string }>}
 */
export async function scoreThreeChairDifficulty(promptText = '', hints = {}) {
    if (typeof hints.complexityScore === 'number' && Number.isFinite(hints.complexityScore)) {
        return {
            complexityScore: Math.min(1, Math.max(0, hints.complexityScore)),
            role: String(hints.role || 'explicit'),
        };
    }
    const text = String(promptText || '');
    const mod = await loadCascadeRouterModule();
    if (mod && typeof mod.classifyPreRoute === 'function') {
        const pre = mod.classifyPreRoute(text);
        let score = Number.isFinite(pre?.complexityScore) ? pre.complexityScore : 0.25;
        const role = String(pre?.role || 'general_fast');
        if (role === 'reasoning_deep' || role === 'comprehension_rc') {
            score = Math.max(score, 0.76);
        } else if (role === 'code' || role === 'reasoning_fast') {
            score = Math.max(score, 0.45);
        }
        if (
            /\b(?:compose\s+(?:3|three|multiple)|multi-file|root\s*cause|architectur(?:e|al)|pipeline|blast\s*radius|invariant\s*audit|swe-bench)\b/i.test(
                text
            ) ||
            text.length > 6000
        ) {
            score = Math.max(score, 0.78);
        }
        return { complexityScore: Math.min(1, Math.max(0, score)), role };
    }

    let score = 0.2;
    if (/\b(?:function|class|adapter|binding|implement|refactor|schema|sql|typescript|python)\b/i.test(text)) {
        score = Math.max(score, 0.5);
    }
    if (
        /\b(?:compose|multi-file|root\s*cause|architectur(?:e|al)|pipeline|blast\s*radius|audit|deadlock|race\s*condition)\b/i.test(
            text
        ) ||
        text.length > 6000
    ) {
        score = Math.max(score, 0.8);
    }
    return { complexityScore: score, role: score > 0.68 ? 'reasoning_deep' : score > 0.35 ? 'code' : 'general_fast' };
}

/**
 * Create a stateless 3-Chair Sovereign Cascade Router binding:
 *   - Layer 1 / 3rd Chair (`OLLAMA_THIRD_CHAIR_URL`): `gemma4:e2b` (`<= 0.35`)
 *   - Layer 2 / 2nd Chair (`LLAMA_SECOND_CHAIR_URL`): `qwen3-coder-30b-moe:latest` (`0.35 - 0.68`)
 *   - Layer 3 / 1st Chair (`LLAMA_FIRST_CHAIR_URL`): `inkling-2-mini:ud-iq4_xs-dspark` (`> 0.68`)
 *
 * Designed for Database-First State Inversion: callers hydrate Common Ground / Golden Brick
 * truth up front, lease the lowest sufficient stateless GPU chair, and automatically escalate
 * up the 3 chairs on runtime error, timeout, or custom `verifyResult` failure.
 *
 * @param {object} [routerOptions={}]
 */
export function createThreeChairCascadeRouter(routerOptions = {}) {
    const tiers = routerOptions.tiers || THREE_CHAIR_BANDIT_TIERS;
    const breaker = routerOptions.breaker !== undefined ? routerOptions.breaker : sharedThreeChairBreaker;
    const allowBurst = Boolean(routerOptions.allowBurst);
    const allowFrontier = Boolean(routerOptions.allowFrontier);
    const perAttemptTimeoutMs = routerOptions.perAttemptTimeoutMs ?? 180_000;
    const env = routerOptions.env || process.env;

    return {
        tiers,
        breaker,
        async routeAndExecute(systemPrompt, userMessage, config = {}, options = {}) {
            const messages = options.messages || config.messages;
            const joinedUser = Array.isArray(messages)
                ? messages
                      .filter((m) => m && m.role === 'user')
                      .map((m) => String(m.content || ''))
                      .join('\n')
                : String(userMessage || '');
            const { complexityScore, role } = await scoreThreeChairDifficulty(joinedUser, {
                complexityScore: options.complexityScore ?? config.complexityScore,
                role: options.specialistRole ?? config.specialistRole,
            });
            const estimatedTokens = Math.ceil(
                (String(systemPrompt || '').length + joinedUser.length) / 3.8
            );
            const hasTools = Array.isArray(options.tools ?? config.tools) && (options.tools ?? config.tools).length > 0;

            const plan = selectCascadeTier({
                complexityScore: options.useAnalysisModel ? Math.max(complexityScore, 0.8) : complexityScore,
                estimatedTokens,
                requiresTools: hasTools,
                allowBurst: options.allowBurst ?? config.allowBurst ?? allowBurst,
                allowFrontier: options.allowFrontier ?? config.allowFrontier ?? allowFrontier,
                tiers,
                breaker,
                env,
                tool: 'llm.three_chair.select',
            });
            if (!plan.ok) {
                throw new Error(plan.error?.message || 'No healthy 3-Chair cascade tier available');
            }

            const verifyResult = options.verifyResult || config.verifyResult || null;
            const execEnv = await executeWithCascadeFallback(
                plan.data.candidateChain,
                async (tier, { signal, attemptIndex }) => {
                    const baseEndpoint = String(tier.endpointUrl || tier.defaultUrl || '').replace(/\/+$/, '');
                    const apiUrl = baseEndpoint.endsWith('/v1/chat/completions')
                        ? baseEndpoint
                        : `${baseEndpoint}/v1/chat/completions`;
                    const tierModel = tier.model || tier.defaultModel;
                    const isInkling = /^inkling/i.test(tierModel);
                    const defaultTierMax = isInkling ? 6144 : 4096;
                    const callMaxTokens =
                        options.maxTokens ??
                        config.maxTokens ??
                        defaultTierMax;

                    if (tier.provider === 'gemini') {
                        return chatGemini(
                            systemPrompt,
                            userMessage,
                            {
                                ...config,
                                provider: 'gemini',
                                model: tierModel,
                                apiKey: config.apiKey || env?.GEMINI_API_KEY || env?.GOOGLE_API_KEY,
                                maxTokens: resolveMaxOutputTokens(tierModel, config, options),
                            },
                            { ...options, signal }
                        );
                    }

                    const res = await chatOpenAICompat(
                        systemPrompt,
                        userMessage,
                        {
                            ...config,
                            provider: 'ollama',
                            model: tierModel,
                            apiUrl,
                            temperature: options.temperature ?? config.temperature ?? (isInkling ? 0.2 : 0.2),
                            maxTokens: isInkling && callMaxTokens < 4096 && !options.strictMaxTokens ? 6144 : callMaxTokens,
                            tools: options.tools ?? config.tools,
                        },
                        { ...options, signal }
                    );

                    if (typeof verifyResult === 'function') {
                        const gate = await verifyResult(res, { tier, attemptIndex, complexityScore, role });
                        if (gate && gate.ok === false) {
                            throw new Error(gate.reason || `Verification gate rejected output on ${tier.id}`);
                        }
                    }
                    return {
                        ...res,
                        routedTierId: tier.id,
                        routedModel: tierModel,
                        routedEndpoint: baseEndpoint,
                        complexityScore,
                        specialistRole: role,
                    };
                },
                {
                    breaker,
                    perAttemptTimeoutMs: options.timeout || config.timeout || perAttemptTimeoutMs,
                    signal: options.signal || null,
                    tool: 'llm.three_chair.execute',
                }
            );

            if (!execEnv.ok) {
                throw new Error(execEnv.error?.message || '3-Chair cascade exhausted');
            }
            return {
                ...execEnv.data.result,
                attemptCount: execEnv.data.attemptCount,
                attempts: execEnv.data.attempts,
            };
        },
    };
}

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
 * @property {number} [maxTokens=2000] - Max tokens (defaults to 65536 for Gemini 4 models)
 * @property {'low'|'medium'|'high'} [thinkingLevel] - Thinking level for Gemini reasoning models
 * @property {boolean} [automaticContinuation=true] - Automatically follow Gemini 4 continuationToken hops
 */

/**
 * Detect whether a model identifier belongs to the Gemini 4 family (e.g. `gemini-4-argon`).
 *
 * @param {string} [modelName=''] - Model identifier
 * @returns {boolean}
 */
export function isGemini4Model(modelName = '') {
    return typeof modelName === 'string' && /^gemini-4/i.test(modelName.trim());
}

/**
 * Normalize thinking_level for Gemini models.
 * Gemini 4 Argon supports 'low', 'medium' (default), and 'high', and rejects 'minimal' with HTTP 400.
 *
 * @param {string} [level] - Requested thinking level
 * @param {string} [modelName=''] - Model identifier
 * @returns {'low'|'medium'|'high'|undefined}
 */
export function normalizeThinkingLevel(level, modelName = '') {
    const gemini4 = isGemini4Model(modelName);
    if (!level) {
        return gemini4 ? 'medium' : undefined;
    }
    const normalized = String(level).trim().toLowerCase();
    if (normalized === 'minimal') {
        return gemini4 ? 'low' : 'minimal';
    }
    if (normalized === 'low' || normalized === 'medium' || normalized === 'high') {
        return normalized;
    }
    return gemini4 ? 'medium' : undefined;
}

/**
 * Resolve safe maxOutputTokens for the target model.
 * Gemini 4 Argon shares maxOutputTokens across internal thinking + output tokens;
 * a legacy 2000-token cap truncates responses during thinking.
 *
 * @param {string} modelName - Resolved model name
 * @param {object} config - Provider configuration
 * @param {object} options - Per-call options
 * @returns {number}
 */
export function resolveMaxOutputTokens(modelName, config = {}, options = {}) {
    const gemini4 = isGemini4Model(modelName);
    const strict = Boolean(options.strictMaxTokens || config.strictMaxTokens);
    const rawMax = options.maxTokens ?? config.maxTokens;

    if (rawMax != null) {
        if (gemini4 && !strict && rawMax <= 2000) {
            return 65536;
        }
        return rawMax;
    }
    return gemini4 ? 65536 : 2000;
}

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
 * @param {'low'|'medium'|'high'} [options.thinkingLevel] - Override thinking level for Gemini models
 * @param {boolean} [options.automaticContinuation] - Enable/disable multi-hop long decode continuation
 * @param {string} [options.continuationToken] - Initial continuation token to resume a long decode
 * @param {object} [options.traceContext] - Optional parent span context for HALO traces
 * @returns {Promise<string>} Raw text response
 */
export async function chat(systemPrompt, userMessage, config, options = {}) {
    const { provider } = config;
    const resolvedModel = options.useAnalysisModel && config.analysisModel
        ? config.analysisModel
        : config.model;

    // Resolve model: analysis model override or default
    const resolvedConfig = {
        ...config,
        model: resolvedModel,
        maxTokens: resolveMaxOutputTokens(resolvedModel, config, options),
        temperature: options.temperature ?? config.temperature ?? 0.7,
        thinkingLevel: options.thinkingLevel ?? config.thinkingLevel,
        automaticContinuation: options.automaticContinuation ?? config.automaticContinuation ?? true,
        continuationToken: options.continuationToken ?? config.continuationToken,
        messages: options.messages
    };

    const span = startSpan('generation', resolvedConfig.model, options.traceContext);
    
    let result;
    let routedPath = 'heavy';
    try {
        // Smart Router Cascade Intercept
        if ((provider === 'gemini' || provider === 'cascade' || config.cascade === true) && !options.useAnalysisModel && !options.bypassCascade) {
            try {
                const CascadeRouterClass = await loadCascadeRouterClass();
                const ollamaUrlEnv = process.env.OLLAMA_URL || 'http://localhost:11434';
                const ollamaUrlArray = ollamaUrlEnv.split(',').map(u => u.trim());
                const ollamaBaseUrl = ollamaUrlArray[Math.floor(Math.random() * ollamaUrlArray.length)];
                const ollamaUrl = ollamaBaseUrl.endsWith('/') ? `${ollamaBaseUrl}v1/chat/completions` : `${ollamaBaseUrl}/v1/chat/completions`;
                const fastModelName = process.env.OLLAMA_FAST_MODEL || config.fastModel || 'qwen2.5-coder:7b';
                const bgBaseUrl = process.env.OLLAMA_BG_URL || ollamaBaseUrl;
                const bgUrl = bgBaseUrl.endsWith('/') ? `${bgBaseUrl}v1/chat/completions` : `${bgBaseUrl}/v1/chat/completions`;

                const router = new CascadeRouterClass({
                    fastModel: { model: fastModelName, url: ollamaUrl },
                    backgroundModel: { model: process.env.OLLAMA_BG_MODEL || 'qwen3-coder-30b-moe:latest', url: bgUrl },
                    heavyModel: {
                        provider: 'gemini',
                        model: resolvedConfig.model,
                        apiKey: resolvedConfig.apiKey,
                        thinkingLevel: resolvedConfig.thinkingLevel,
                        maxOutputTokens: resolvedConfig.maxTokens,
                        automaticContinuation: resolvedConfig.automaticContinuation
                    },
                    prunePreRouting: true
                });

                const defaultTimeoutMs = isGemini4Model(resolvedConfig.model) ? 1200000 : 120000;
                const timeoutMs = options.timeout || config.timeout || defaultTimeoutMs;
                const cascadeSignal = buildRequestSignal(timeoutMs, options.signal);

                const messages = resolvedConfig.messages || [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userMessage }
                ];

                const cascadeResult = await router.chat(messages, undefined, {
                    signal: cascadeSignal,
                    prunePreRouting: true,
                    thinkingLevel: resolvedConfig.thinkingLevel,
                    maxOutputTokens: resolvedConfig.maxTokens,
                    continuationToken: resolvedConfig.continuationToken,
                    automaticContinuation: resolvedConfig.automaticContinuation
                });

                result = {
                    text: cascadeResult.text,
                    usage: {
                        inputTokens: cascadeResult.usage?.promptTokens || 0,
                        initialPromptTokens: cascadeResult.usage?.initialPromptTokens ?? cascadeResult.usage?.promptTokens ?? 0,
                        cachedTokens: cascadeResult.usage?.cachedTokens || 0,
                        outputTokens: cascadeResult.usage?.completionTokens || 0,
                        thoughtTokens: cascadeResult.usage?.thoughtTokens || 0,
                        hops: cascadeResult.usage?.hops || 1,
                        estimatedCostUsd: cascadeResult.usage?.estimatedCostUsd || 0
                    }
                };

                if (cascadeResult.routedTo === 'fast') routedPath = 'fast';
                else if (cascadeResult.aborted) routedPath = 'fallback';
                else routedPath = 'heavy';

            } catch (err) {
                if (options.signal?.aborted) {
                    throw err;
                }
                console.warn(`[SmartRouter] Cascade failed: ${err?.message ?? err}. Falling back to standard Gemini.`);
                routedPath = 'fallback';
            }
        }

        // If we didn't cascade, or if cascade aborted/failed
        if (!result) {
            switch (provider) {
                case 'three-chair': {
                    const threeChair = createThreeChairCascadeRouter({
                        tiers: resolvedConfig.tiers || options.tiers,
                        breaker: resolvedConfig.breaker ?? options.breaker,
                        allowBurst: Boolean(options.allowBurst ?? resolvedConfig.allowBurst),
                        allowFrontier: Boolean(options.allowFrontier ?? resolvedConfig.allowFrontier),
                        perAttemptTimeoutMs: options.timeout || resolvedConfig.timeout || 180_000,
                    });
                    result = await threeChair.routeAndExecute(systemPrompt, userMessage, resolvedConfig, options);
                    routedPath = result.routedTierId || 'three-chair';
                    resolvedConfig.model = result.routedModel || resolvedConfig.model || 'three-chair';
                    break;
                }
                case 'gemini':
                    result = await chatGemini(systemPrompt, userMessage, resolvedConfig, options);
                    break;
                case 'cascade':
                    if (resolvedConfig.apiKey) {
                        result = await chatGemini(systemPrompt, userMessage, resolvedConfig, options);
                    } else {
                        result = await chatOpenAICompat(systemPrompt, userMessage, {
                            ...resolvedConfig,
                            provider: 'ollama',
                            apiUrl: resolvedConfig.apiUrl || 'http://localhost:11434/v1/chat/completions',
                        }, options);
                    }
                    break;
            case 'openai':
                result = await chatOpenAICompat(systemPrompt, userMessage, {
                    ...resolvedConfig,
                    apiUrl: resolvedConfig.apiUrl || 'https://api.openai.com/v1/chat/completions',
                }, options);
                break;
            case 'openrouter':
                result = await chatOpenAICompat(systemPrompt, userMessage, {
                    ...resolvedConfig,
                    apiKey: resolvedConfig.apiKey || process.env.OPENROUTER_API_KEY,
                    apiUrl: resolvedConfig.apiUrl || 'https://openrouter.ai/api/v1/chat/completions',
                }, options);
                break;
            case 'xai':
            case 'grok':
                result = await chatOpenAICompat(systemPrompt, userMessage, resolvedConfig, options);
                break;
            case 'ollama':
                result = await chatOpenAICompat(systemPrompt, userMessage, {
                    ...resolvedConfig,
                    apiUrl: resolvedConfig.apiUrl || 'http://localhost:11434/v1/chat/completions',
                }, options);
                break;
            default:
                throw new Error(`Unknown LLM provider: ${provider}. Supported: gemini, cascade, openai, openrouter, xai, ollama`);
            }
        }

        const inputMsgs = resolvedConfig.messages || [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage }
        ];

        endSpan(span, {
            "llm.provider": provider,
            "llm.route": routedPath,
            "inference.llm.model_name": resolvedConfig.model,
            "inference.llm.input_tokens": result.usage?.inputTokens,
            "inference.llm.output_tokens": result.usage?.outputTokens,
            "llm.input_messages": JSON.stringify(inputMsgs),
            "llm.output_messages": JSON.stringify([{ role: 'assistant', content: result.text }])
        });

        if (options.returnFullResponse) {
            return result;
        }
        return result.text;
    } catch (err) {
        endSpan(span, {
            "llm.provider": provider,
            "inference.llm.model_name": resolvedConfig.model
        }, err);
        throw err;
    }
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

/**
 * Build the Gemini REST generateContent request payload.
 * Omits sampling parameters (`temperature`) for Gemini 4 models per developer guide
 * and attaches `thinkingConfig.thinkingLevel` when applicable.
 *
 * @param {string} systemPrompt - System instruction
 * @param {string} userMessage - User prompt
 * @param {object} config - Resolved configuration
 * @param {object} [options={}] - Per-call overrides
 * @param {string} [continuationToken] - Optional continuation token for multi-hop long decode
 * @returns {object}
 */
export function buildGeminiPayload(systemPrompt, userMessage, config, options = {}, continuationToken = undefined) {
    const gemini4 = isGemini4Model(config.model);
    const thinkingLevel = normalizeThinkingLevel(
        options.thinkingLevel ?? config.thinkingLevel,
        config.model
    );

    const generationConfig = {
        ...(!gemini4 && config.temperature != null ? { temperature: config.temperature } : {}),
        maxOutputTokens: resolveMaxOutputTokens(config.model, config, options),
        ...(thinkingLevel ? { thinkingConfig: { thinkingLevel } } : {}),
        ...(config.responseSchema
            ? {
                responseMimeType: 'application/json',
                responseSchema: config.responseSchema
            }
            : (config.format === 'json' ? { responseMimeType: 'application/json' } : {})),
    };

    const resolvedTools = options.tools !== undefined ? options.tools : config.tools;
    const hasDeclaredTools = hasNonEmptyGeminiTools(resolvedTools);
    const resolvedToolConfig = resolveGeminiToolConfig(config, options);

    return {
        system_instruction: config.messages
            ? { parts: [{ text: config.messages.find(m => m.role === 'system')?.content || systemPrompt || '' }] }
            : { parts: [{ text: systemPrompt }] },
        contents: config.messages
            ? config.messages.filter(m => m.role !== 'system').map(m => ({
                role: m.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: m.content }]
            }))
            : [{ role: 'user', parts: [{ text: userMessage }] }],
        generationConfig,
        ...(hasDeclaredTools ? { tools: resolvedTools } : {}),
        ...(resolvedToolConfig ? { toolConfig: resolvedToolConfig } : {}),
        ...(continuationToken ? { continuationToken } : {})
    };
}

function hasNonEmptyGeminiTools(tools) {
    if (Array.isArray(tools)) return tools.length > 0;
    if (tools !== null && typeof tools === 'object') return Object.keys(tools).length > 0;
    return false;
}

/**
 * Resolve Gemini `toolConfig`, automatically setting `{ functionCallingConfig: { mode: 'NONE' } }`
 * whenever no `tools` are declared so fenced markdown code blocks (e.g. ```py) are never
 * misparsed as `MALFORMED_FUNCTION_CALL` (`INV-GH-09`).
 *
 * @param {object} [config={}]
 * @param {object} [options={}]
 * @returns {object|undefined}
 */
export function resolveGeminiToolConfig(config = {}, options = {}) {
    const safeConfig = config && typeof config === 'object' ? config : {};
    const safeOptions = options && typeof options === 'object' ? options : {};
    const explicitToolConfig = safeOptions.toolConfig !== undefined
        ? safeOptions.toolConfig
        : safeConfig.toolConfig;
    if (explicitToolConfig && typeof explicitToolConfig === 'object' && !Array.isArray(explicitToolConfig)) {
        return explicitToolConfig;
    }
    if (safeOptions.disableAutoToolConfigNone === true || safeConfig.disableAutoToolConfigNone === true) {
        return undefined;
    }
    const resolvedTools = safeOptions.tools !== undefined ? safeOptions.tools : safeConfig.tools;
    if (!hasNonEmptyGeminiTools(resolvedTools)) {
        return { functionCallingConfig: { mode: 'NONE' } };
    }
    return undefined;
}

/**
 * Extract non-thought text from an array of Gemini content parts.
 *
 * @param {Array<object>} [parts=[]] - Candidate content parts
 * @returns {string}
 */
export function extractGeminiTextParts(parts = []) {
    if (!Array.isArray(parts)) return '';
    return parts
        .filter(p => p && typeof p.text === 'string' && !p.thought)
        .map(p => p.text)
        .join('');
}

function buildRequestSignal(timeoutMs, externalSignal) {
    if (externalSignal?.aborted) {
        return externalSignal;
    }
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    return externalSignal ? AbortSignal.any([timeoutSignal, externalSignal]) : timeoutSignal;
}

async function chatGemini(systemPrompt, userMessage, config, options = {}) {
    const apiKey = config.apiKey;
    const gemini4 = isGemini4Model(config.model);
    // Gemini 4 Argon developer guide recommends 20-minute (1,200,000ms) HTTP read timeouts per hop
    const timeoutMs = options.timeout || config.timeout || (gemini4 ? 1200000 : 120000);
    if (!apiKey) throw new Error('Gemini: apiKey is required');

    const baseUrl = config.apiUrl || GEMINI_BASE_URL;
    const url = `${baseUrl}/models/${config.model}:generateContent?key=${apiKey}`;

    const automaticContinuation = (options.automaticContinuation ?? config.automaticContinuation) !== false;
    const maxHops = options.maxContinuationHops ?? config.maxContinuationHops ?? 32;
    let token = options.continuationToken ?? config.continuationToken ?? undefined;

    const allParts = [];
    let initialPromptTokens = undefined;
    let totalInputTokens = 0;
    let totalCachedTokens = 0;
    let totalOutputTokens = 0;
    let totalThoughtTokens = 0;
    let totalTokens = 0;
    let lastCandidate = null;
    let lastData = null;
    let hops = 0;

    while (hops < maxHops) {
        hops += 1;
        const payload = buildGeminiPayload(systemPrompt, userMessage, config, options, token);

        const res = await fetch(url, {
            method: 'POST',
            signal: buildRequestSignal(timeoutMs, options.signal),
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': apiKey
            },
            body: JSON.stringify(payload),
        });

        if (!res.ok) {
            const err = await res.text();
            throw new Error(`Gemini API ${res.status}: ${err}`);
        }

        const data = await res.json();
        lastData = data;
        const candidate = data.candidates?.[0];
        lastCandidate = candidate;

        if (candidate?.content?.parts) {
            allParts.push(...candidate.content.parts);
        }

        const usageMeta = data.usageMetadata || {};
        if (hops === 1 && usageMeta.promptTokenCount != null) {
            initialPromptTokens = usageMeta.promptTokenCount;
        }
        totalInputTokens += usageMeta.promptTokenCount || 0;
        totalCachedTokens += usageMeta.cachedContentTokenCount || 0;
        totalOutputTokens += usageMeta.candidatesTokenCount || 0;
        totalThoughtTokens += usageMeta.thoughtsTokenCount || 0;
        totalTokens += usageMeta.totalTokenCount || 0;

        token = candidate?.continuationToken;
        const finishReason = candidate?.finishReason;

        if (!automaticContinuation || finishReason !== 'CONTINUATION' || !token) {
            break;
        }
    }

    const text = extractGeminiTextParts(allParts);
    if (!text && lastCandidate?.finishReason !== 'CONTINUATION') {
        console.error(`\n[LLM DEBUG] Gemini returned empty response. Raw payload:`, JSON.stringify(lastData, null, 2));
    }

    return {
        text: text.trim(),
        finishReason: lastCandidate?.finishReason || null,
        continuationToken: token || null,
        hops,
        usage: {
            initialPromptTokens: initialPromptTokens ?? totalInputTokens,
            inputTokens: totalInputTokens,
            cachedTokens: totalCachedTokens,
            outputTokens: totalOutputTokens,
            thoughtTokens: totalThoughtTokens,
            totalTokens: totalTokens || (totalInputTokens + totalOutputTokens + totalThoughtTokens)
        },
        groundingMetadata: lastCandidate?.groundingMetadata || null
    };
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
        signal: buildRequestSignal(timeoutMs, options.signal),
        headers,
        body: JSON.stringify({
            model: config.model,
            messages: processedMessages,
            stream: false,
            temperature: config.temperature,
            max_tokens: config.maxTokens,
            tools: config.tools,
            ...(config.provider === 'ollama' ? { keep_alive: -1 } : {}),
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
    const message = data.choices?.[0]?.message || data.message || {};
    const text = message.content || '';
    
    if (!text && !message.tool_calls) {
        console.log("[LLM DEBUG] Empty text and no tool_calls. Raw data:", JSON.stringify(data, null, 2));
    }

    return {
        text: text,
        tool_calls: message.tool_calls,
        usage: {
            inputTokens: data.usage?.prompt_tokens,
            outputTokens: data.usage?.completion_tokens
        }
    };
}

/**
 * Resolve model configuration for a specific task.
 *
 * @param {string} taskName - Name of the task or persona
 * @param {object} config - Configuration object (typically from config.json)
 * @returns {object} Resolved configuration with provider, model, and apiUrl
 */
export function resolveModelConfig(taskName, config = {}) {
    const taskConfig = config.tasks?.[taskName] || config[taskName] || {};
    const model = taskConfig.model || '';
    const defaultMaxTokens = isGemini4Model(model) ? 65536 : 2000;
    return {
        provider: taskConfig.provider || 'ollama',
        model,
        apiUrl: taskConfig.apiUrl || '',
        maxTokens: taskConfig.maxTokens || defaultMaxTokens,
        temperature: taskConfig.temperature ?? 0.7,
        thinkingLevel: taskConfig.thinkingLevel || (isGemini4Model(model) ? 'medium' : undefined),
        analysisModel: taskConfig.analysisModel || ''
    };
}
