/**
 * @module @krusch/toolkit/decide
 * Sovereign System 1 Decision Primitive (Single-Token Logit / Logprob Router).
 *
 * Implements non-autoregressive, zero-CoT single-token classification ("State + Question -> Choice")
 * over local Ollama / vLLM endpoints with logprob softmax calibration and sub-millisecond
 * deterministic fallback for air-gapped CI environments.
 */

import crypto from 'node:crypto';
import { envOr } from './config.js';

/**
 * Numerically stable softmax over log-probabilities for a fixed set of choices.
 * Matches raw tokens (e.g., " yes", "Yes", "1", "A") to canonical choice labels by normalized prefix.
 *
 * @param {Array<{token: string, logprob: number}>} topLogprobs - Raw top token logprobs from vLLM/Ollama
 * @param {string[]} choices - Canonical choice labels (e.g., ['YES', 'NO'])
 * @returns {{ choice: string, confidence: number, probabilities: Record<string, number>, matchedLogprobs: boolean }}
 */
export function calibrateChoiceLogprobs(topLogprobs = [], choices = ['YES', 'NO']) {
    const validChoices = Array.isArray(choices) && choices.length >= 2 ? choices.map(String) : ['YES', 'NO'];
    const logprobMap = new Map();

    if (Array.isArray(topLogprobs)) {
        for (const entry of topLogprobs) {
            if (!entry || typeof entry.token !== 'string' || typeof entry.logprob !== 'number') continue;
            const cleanToken = entry.token.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
            if (!cleanToken) continue;

            for (const c of validChoices) {
                const normChoice = c.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
                if (
                    cleanToken === normChoice ||
                    (cleanToken.length >= 1 && normChoice.startsWith(cleanToken)) ||
                    cleanToken.startsWith(normChoice)
                ) {
                    const prev = logprobMap.get(c);
                    if (prev === undefined) {
                        logprobMap.set(c, entry.logprob);
                    } else {
                        // Log-sum-exp to marginalize over casing/whitespace token variants ("YES", "Yes", " YES")
                        const m = Math.max(prev, entry.logprob);
                        logprobMap.set(c, m + Math.log(Math.exp(prev - m) + Math.exp(entry.logprob - m)));
                    }
                }
            }
        }
    }

    if (logprobMap.size === 0) {
        const uniform = Number((1 / validChoices.length).toFixed(4));
        const probabilities = Object.fromEntries(validChoices.map(c => [c, uniform]));
        return {
            choice: validChoices[0],
            confidence: 0,
            probabilities,
            matchedLogprobs: false
        };
    }

    // Assign floor logprob (-12.0) to any unmatched choice so softmax remains well-defined
    const rawLogits = validChoices.map(c => logprobMap.has(c) ? logprobMap.get(c) : -12.0);
    const maxLogit = Math.max(...rawLogits);
    const exps = rawLogits.map(l => Math.exp(l - maxLogit));
    const sumExp = exps.reduce((a, b) => a + b, 0) || 1;

    const probabilities = {};
    let bestIdx = 0;
    let bestProb = -1;

    for (let i = 0; i < validChoices.length; i++) {
        const p = exps[i] / sumExp;
        probabilities[validChoices[i]] = Number(p.toFixed(4));
        if (p > bestProb) {
            bestProb = p;
            bestIdx = i;
        }
    }

    return {
        choice: validChoices[bestIdx],
        confidence: Number(bestProb.toFixed(4)),
        probabilities,
        matchedLogprobs: true
    };
}

/**
 * Deterministic sub-millisecond lexical/rule fallback when LLM is offline or CI=true / MOCK_LLM=1.
 *
 * @param {string|object} state
 * @param {string} question
 * @param {string[]} choices
 * @returns {{ choice: string, confidence: number, probabilities: Record<string, number> }}
 */
export function evaluateDeterministicDecision(state, question, choices = ['YES', 'NO']) {
    const validChoices = Array.isArray(choices) && choices.length >= 2 ? choices.map(String) : ['YES', 'NO'];
    const stateStr = typeof state === 'string' ? state : JSON.stringify(state || {});
    const combined = `${stateStr}\n${question || ''}`.toLowerCase();

    // Score each choice by lexical token overlap with state + question
    const scores = validChoices.map((choice) => {
        const lowerChoice = choice.toLowerCase();
        if (lowerChoice === 'yes' || lowerChoice === 'true') {
            const qTokens = String(question || '')
                .toLowerCase()
                .replace(/[^a-z0-9\s]/g, ' ')
                .split(/\s+/)
                .filter(t => t.length > 3 && !['does', 'this', 'that', 'with', 'from', 'have', 'what', 'when', 'where', 'should'].includes(t));
            if (qTokens.length === 0) return 0.5;
            const lowerState = stateStr.toLowerCase();
            const hits = qTokens.filter(t => lowerState.includes(t)).length;
            const hasNegation = /\b(not|never|prohibited|void|invalid|missing|false)\b/.test(lowerState) &&
                !/\b(not|never|prohibited|void|invalid)\b/.test(String(question || '').toLowerCase());
            const ratio = hits / qTokens.length;
            return hasNegation ? Math.max(0.1, ratio - 0.45) : ratio;
        }
        if (lowerChoice === 'no' || lowerChoice === 'false') {
            return 0.45;
        }
        const tokens = lowerChoice.split(/[^a-z0-9]+/).filter(Boolean);
        let matchScore = 0.1;
        for (const t of tokens) {
            if (t.length >= 2 && combined.includes(t)) matchScore += 0.6;
        }
        return matchScore;
    });

    const maxScore = Math.max(...scores);
    const exps = scores.map(s => Math.exp((s - maxScore) * 3.0));
    const sumExp = exps.reduce((a, b) => a + b, 0) || 1;
    const probabilities = {};
    let bestIdx = 0;
    let bestProb = -1;
    for (let i = 0; i < validChoices.length; i++) {
        const p = exps[i] / sumExp;
        probabilities[validChoices[i]] = Number(p.toFixed(4));
        if (p > bestProb) {
            bestProb = p;
            bestIdx = i;
        }
    }

    return {
        choice: validChoices[bestIdx],
        confidence: Number(bestProb.toFixed(4)),
        probabilities
    };
}

/**
 * Executes a single-token System 1 decision against an OpenAI-compatible vLLM or Ollama endpoint.
 *
 * @param {object} params
 * @param {string|object} params.state - Context or structured state object
 * @param {string} params.question - Decision question to evaluate
 * @param {string[]} [params.choices=['YES', 'NO']] - Allowed single-token / label choices
 * @param {string} [params.model] - Target model (defaults to OLLAMA_FAST_MODEL or qwen2.5-coder:7b)
 * @param {string} [params.endpoint] - Base URL (defaults to OLLAMA_URL or http://127.0.0.1:11434)
 * @param {number} [params.timeoutMs=2500] - Request timeout in milliseconds
 * @param {Function} [params.fetchImpl] - Optional custom fetch implementation for testing
 * @returns {Promise<{ choice: string, confidence: number, probabilities: Record<string, number>, latencyMs: number, mode: string }>}
 */
export async function decide({
    state,
    question,
    choices = ['YES', 'NO'],
    model = envOr('OLLAMA_FAST_MODEL', null, 'qwen2.5-coder:7b'),
    endpoint = envOr('OLLAMA_URL', null, 'http://127.0.0.1:11434'),
    timeoutMs = 2500,
    fetchImpl = globalThis.fetch
} = {}) {
    const t0 = performance.now();
    const validChoices = Array.isArray(choices) && choices.length >= 2 ? choices.map(String) : ['YES', 'NO'];

    if (!question || typeof question !== 'string') {
        throw new Error('decide() requires a non-empty question string');
    }

    const hasCustomFetch = typeof fetchImpl === 'function' && fetchImpl !== globalThis.fetch;

    // Fast path for offline CI / mock mode when no explicit mock fetchImpl is provided
    if ((!hasCustomFetch && (process.env.MOCK_LLM === '1' || process.env.CI === 'true')) || !fetchImpl) {
        const det = evaluateDeterministicDecision(state, question, validChoices);
        return {
            ...det,
            latencyMs: Number((performance.now() - t0).toFixed(2)),
            mode: 'deterministic_fallback'
        };
    }

    const stateText = typeof state === 'string' ? state : JSON.stringify(state || {});
    const systemPrompt = `Respond with ONLY one word from the allowed choices: ${validChoices.join(', ')}.`;
    const userPrompt = `Context: ${stateText}\nQuestion: ${question}\nChoices: ${validChoices.join(', ')}\nAnswer:`;

    const baseUrl = String(endpoint).split(',')[0].trim().replace(/\/+$/, '');
    const url = baseUrl.endsWith('/v1/chat/completions')
        ? baseUrl
        : `${baseUrl}/v1/chat/completions`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const res = await fetchImpl(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                max_tokens: 1,
                temperature: 0,
                logprobs: true,
                top_logprobs: Math.min(10, Math.max(5, validChoices.length * 2)),
                keep_alive: -1
            }),
            signal: controller.signal
        });

        clearTimeout(timer);
        if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
        }

        const data = await res.json();
        const firstChoice = data?.choices?.[0];
        const topLogprobs =
            firstChoice?.logprobs?.content?.[0]?.top_logprobs ||
            firstChoice?.logprobs?.top_logprobs?.[0] ||
            null;

        if (Array.isArray(topLogprobs) && topLogprobs.length > 0) {
            const calibrated = calibrateChoiceLogprobs(topLogprobs, validChoices);
            if (calibrated.matchedLogprobs) {
                return {
                    choice: calibrated.choice,
                    confidence: calibrated.confidence,
                    probabilities: calibrated.probabilities,
                    latencyMs: Number((performance.now() - t0).toFixed(2)),
                    mode: 'logprobs'
                };
            }
        }

        // Fallback to matching the emitted single token when endpoint omits logprobs
        const rawText = String(firstChoice?.message?.content || firstChoice?.text || '').trim().toUpperCase();
        const matched = validChoices.find(c => rawText === c.toUpperCase() || rawText.startsWith(c.toUpperCase()));
        if (matched) {
            const probabilities = Object.fromEntries(
                validChoices.map(c => [c, c === matched ? 0.9 : Number((0.1 / (validChoices.length - 1)).toFixed(4))])
            );
            return {
                choice: matched,
                confidence: 0.9,
                probabilities,
                latencyMs: Number((performance.now() - t0).toFixed(2)),
                mode: 'token'
            };
        }
    } catch {
        clearTimeout(timer);
    }

    const det = evaluateDeterministicDecision(state, question, validChoices);
    return {
        ...det,
        latencyMs: Number((performance.now() - t0).toFixed(2)),
        mode: 'deterministic_fallback'
    };
}

/**
 * Evaluates a batch of System 1 questions against a shared state concurrently.
 *
 * @param {object} params
 * @param {string|object} params.state - Shared state context
 * @param {Array<string|{question: string, choices?: string[]}>} params.questions - Questions to evaluate
 * @param {object} [params.options] - Shared options forwarded to decide()
 * @returns {Promise<Array<{ question: string, choice: string, confidence: number, probabilities: Record<string, number>, latencyMs: number, mode: string }>>}
 */
export async function decideBatch({ state, questions = [], ...options } = {}) {
    if (!Array.isArray(questions) || questions.length === 0) return [];
    return Promise.all(
        questions.map(async (q) => {
            const questionText = typeof q === 'string' ? q : q.question;
            const choices = (typeof q === 'object' && Array.isArray(q.choices)) ? q.choices : options.choices;
            const res = await decide({ ...options, state, question: questionText, choices });
            return { question: questionText, ...res };
        })
    );
}

/**
 * Creates a stateful System 1 decider with bounded LRU caching for O(1) sub-millisecond repeat checks.
 *
 * @param {object} [defaultConfig]
 * @param {number} [defaultConfig.maxCacheSize=256]
 */
export function createSystem1Decider(defaultConfig = {}) {
    const maxCacheSize = defaultConfig.maxCacheSize ?? 256;
    const cache = new Map();

    function makeKey(state, question, choices) {
        const raw = JSON.stringify({ state, question, choices: choices || defaultConfig.choices || ['YES', 'NO'] });
        return crypto.createHash('sha256').update(raw).digest('hex');
    }

    return {
        async decide(params = {}) {
            const merged = { ...defaultConfig, ...params };
            const key = makeKey(merged.state, merged.question, merged.choices);
            if (cache.has(key)) {
                const hit = cache.get(key);
                cache.delete(key);
                cache.set(key, hit);
                return { ...hit, cached: true, latencyMs: 0 };
            }
            const res = await decide(merged);
            if (cache.size >= maxCacheSize) {
                const oldestKey = cache.keys().next().value;
                cache.delete(oldestKey);
            }
            cache.set(key, res);
            return { ...res, cached: false };
        },
        async decideBatch({ state, questions = [], ...opts } = {}) {
            return Promise.all(
                questions.map(q => {
                    const question = typeof q === 'string' ? q : q.question;
                    const choices = (typeof q === 'object' && Array.isArray(q.choices)) ? q.choices : opts.choices;
                    return this.decide({ ...opts, state, question, choices });
                })
            );
        },
        clearCache() {
            cache.clear();
        },
        getCacheSize() {
            return cache.size;
        }
    };
}
