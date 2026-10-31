/**
 * @module cascade
 * @description Deterministic multi-tier LLM cascade selector, single-flight circuit breaker,
 * burst endpoint probe, and abort-safe failover executor (`INV-LEGO-19`, `INV-LEGO-01`, `INV-LEGO-04`).
 * Pure Web-standards ECMAScript with zero host-specific imports and zero hardcoded private network IPs.
 */

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Read a monotonic millisecond timestamp across Node, browser, and edge runtimes.
 *
 * @returns {number}
 */
function monotonicNowMs() {
    return typeof globalThis.performance?.now === 'function'
        ? globalThis.performance.now()
        : Date.now();
}

/**
 * Build a deterministic `INV-LEGO-01` success envelope without requiring `node:*` imports.
 *
 * @param {string} tool - Originating tool or subsystem identifier
 * @param {string} summary - Concise human-readable summary
 * @param {object} [data={}] - Structured payload
 * @returns {{ ok: true, tool: string, summary: string, data: object }}
 */
function okEnvelope(tool, summary, data = {}) {
    return {
        ok: true,
        tool: String(tool || 'cascade'),
        summary: String(summary || 'OK'),
        data: data ?? {},
    };
}

/**
 * Build a deterministic `INV-LEGO-01` error envelope without requiring `node:*` imports.
 *
 * @param {string} code - Machine-readable error code
 * @param {string} message - Human-readable error message
 * @param {unknown} [details=null] - Optional diagnostic context
 * @param {string} [tool='cascade'] - Originating tool or subsystem identifier
 * @returns {{ ok: false, tool: string, summary: string, error: { code: string, message: string, details?: unknown } }}
 */
function errorEnvelope(code, message, details = null, tool = 'cascade') {
    return {
        ok: false,
        tool: String(tool || 'cascade'),
        summary: String(message || code || 'Request failed'),
        error: {
            code: String(code || 'INTERNAL_ERROR'),
            message: String(message || 'Request failed'),
            ...(details !== null && details !== undefined ? { details } : {}),
        },
    };
}

/**
 * Deep-freeze a cascade tier descriptor and its capability list.
 *
 * @param {object} descriptor - Raw tier definition
 * @returns {Readonly<object>}
 */
function freezeTierDescriptor(descriptor) {
    const capabilities = Object.freeze(
        Array.isArray(descriptor.capabilities) ? [...descriptor.capabilities] : []
    );
    return Object.freeze({
        ...descriptor,
        capabilities,
    });
}

/**
 * Canonical 4-tier sovereign cascade descriptors (`INV-LEGO-19`, `INV-LEGO-04`).
 * Uses portable loopback/public defaults with environment variable URL overrides.
 */
export const DEFAULT_FLEET_CASCADE_TIERS = Object.freeze([
    freezeTierDescriptor({
        id: 'L1_FAST',
        rank: 1,
        provider: 'ollama',
        defaultModel: 'gemma4:e4b',
        envUrlKey: 'OLLAMA_L1_URL',
        defaultUrl: 'http://127.0.0.1:11434',
        maxContextTokens: 16_384,
        supportsTools: true,
        supportsVision: true,
        isBurst: false,
        isFrontier: false,
        maxComplexity: 0.35,
        capabilities: ['chat', 'tools', 'vision'],
    }),
    freezeTierDescriptor({
        id: 'L2_HEAVY_MOE',
        rank: 2,
        provider: 'ollama',
        defaultModel: 'qwen3-coder-30b-moe:latest',
        envUrlKey: 'OLLAMA_L2_URL',
        defaultUrl: 'http://127.0.0.1:11434',
        maxContextTokens: 16_384,
        supportsTools: true,
        supportsVision: false,
        isBurst: false,
        isFrontier: false,
        maxComplexity: 0.75,
        capabilities: ['chat', 'tools', 'code'],
    }),
    freezeTierDescriptor({
        id: 'L2_5_COLAB_BURST',
        rank: 3,
        provider: 'ollama',
        defaultModel: 'gpt-oss:120b',
        envUrlKey: 'COLAB_BURST_URL',
        defaultUrl: 'http://127.0.0.1:11435',
        maxContextTokens: 131_072,
        supportsTools: true,
        supportsVision: false,
        isBurst: true,
        isFrontier: false,
        maxComplexity: 0.92,
        capabilities: ['chat', 'tools', 'reasoning', 'burst'],
    }),
    freezeTierDescriptor({
        id: 'L3_FRONTIER_ARGON',
        rank: 4,
        provider: 'gemini',
        defaultModel: 'gemini-4-argon',
        envUrlKey: 'GEMINI_API_BASE_URL',
        defaultUrl: 'https://generativelanguage.googleapis.com',
        maxContextTokens: 1_000_000,
        supportsTools: true,
        supportsVision: true,
        isBurst: false,
        isFrontier: true,
        maxComplexity: 1.0,
        capabilities: ['chat', 'tools', 'vision', 'reasoning', 'frontier'],
    }),
]);

/**
 * Normalize a tier identifier into a bounded, prototype-safe key.
 *
 * @param {unknown} tierId - Candidate tier ID
 * @returns {string}
 */
function normalizeTierKey(tierId) {
    if (tierId === null || tierId === undefined) return '';
    if (typeof tierId !== 'string' && typeof tierId !== 'number') return '';
    const key = String(tierId).trim().slice(0, 128);
    if (!key || FORBIDDEN_KEYS.has(key)) return '';
    return key;
}

/**
 * Create a bounded per-tier circuit breaker with single-flight `HALF_OPEN` probe gating
 * so concurrent callers never stampede a recovering upstream tier (`INV-LEGO-19`).
 *
 * @param {object} [options={}] - Circuit breaker configuration
 * @param {number} [options.failureThreshold=3] - Consecutive failures before tripping `OPEN`
 * @param {number} [options.cooldownMs=30000] - Cooldown duration in ms before allowing a `HALF_OPEN` probe
 * @param {number} [options.maxTiers=64] - Maximum tracked distinct tier keys
 * @param {() => number} [options.nowFn=Date.now] - Monotonic/wall clock function returning milliseconds
 * @returns {object}
 */
export function createTierCircuitBreaker(options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    const {
        failureThreshold = 3,
        cooldownMs = 30_000,
        maxTiers = 64,
        nowFn = Date.now,
    } = opts;
    const parsedThreshold = Math.trunc(Number(failureThreshold) || 3);
    const safeThreshold = Number.isFinite(parsedThreshold) ? Math.max(1, parsedThreshold) : 3;

    const parsedCooldown = Math.trunc(Number(cooldownMs) || 30_000);
    const safeCooldownMs = Number.isFinite(parsedCooldown) ? Math.max(100, parsedCooldown) : 30_000;

    const parsedMaxTiers = Math.trunc(Number(maxTiers) || 64);
    const safeMaxTiers = Number.isFinite(parsedMaxTiers) ? Math.max(1, parsedMaxTiers) : 64;

    const clock = typeof nowFn === 'function' ? nowFn : Date.now;
    const states = new Map();

    const ensureCapacityForKey = (key) => {
        if (states.has(key)) return;
        while (states.size >= safeMaxTiers) {
            let victimKey;
            for (const [existingKey, existingVal] of states.entries()) {
                if (existingVal.state === 'CLOSED') {
                    victimKey = existingKey;
                    break;
                }
            }
            if (victimKey === undefined) {
                victimKey = states.keys().next().value;
            }
            if (victimKey !== undefined) {
                states.delete(victimKey);
            } else {
                break;
            }
        }
    };

    const getState = (tierId) => {
        const key = normalizeTierKey(tierId);
        if (!key) {
            return {
                state: 'OPEN',
                failures: 0,
                openedAt: null,
                lastError: 'INVALID_TIER_ID',
                halfOpenInFlight: false,
                retryAfterMs: 0,
            };
        }

        const entry = states.get(key);
        if (!entry) {
            return {
                state: 'CLOSED',
                failures: 0,
                openedAt: null,
                lastError: null,
                halfOpenInFlight: false,
                retryAfterMs: 0,
            };
        }

        if (entry.state === 'OPEN') {
            const now = clock();
            const openedAt = entry.openedAt ?? now;
            const elapsed = Math.max(0, now - openedAt);
            if (elapsed >= safeCooldownMs) {
                return {
                    state: 'HALF_OPEN',
                    failures: entry.failures,
                    openedAt: entry.openedAt,
                    lastError: entry.lastError,
                    halfOpenInFlight: false,
                    retryAfterMs: 0,
                };
            }
            return {
                state: 'OPEN',
                failures: entry.failures,
                openedAt: entry.openedAt,
                lastError: entry.lastError,
                halfOpenInFlight: false,
                retryAfterMs: Math.max(0, safeCooldownMs - elapsed),
            };
        }

        if (entry.state === 'HALF_OPEN') {
            return {
                state: 'HALF_OPEN',
                failures: entry.failures,
                openedAt: entry.openedAt,
                lastError: entry.lastError,
                halfOpenInFlight: Boolean(entry.halfOpenInFlight),
                retryAfterMs: 0,
            };
        }

        return {
            state: 'CLOSED',
            failures: entry.failures,
            openedAt: entry.openedAt,
            lastError: entry.lastError,
            halfOpenInFlight: false,
            retryAfterMs: 0,
        };
    };

    const canAttempt = (tierId) => {
        const key = normalizeTierKey(tierId);
        if (!key) {
            return {
                allowed: false,
                state: 'OPEN',
                probe: false,
                reason: 'INVALID_TIER_ID',
            };
        }

        const entry = states.get(key);
        if (!entry || entry.state === 'CLOSED') {
            return { allowed: true, state: 'CLOSED', probe: false };
        }

        if (entry.state === 'OPEN') {
            const now = clock();
            const openedAt = entry.openedAt ?? now;
            const elapsed = now - openedAt;
            if (elapsed < safeCooldownMs) {
                return {
                    allowed: false,
                    state: 'OPEN',
                    probe: false,
                    reason: 'CIRCUIT_OPEN',
                    retryAfterMs: Math.max(0, safeCooldownMs - elapsed),
                };
            }
            entry.state = 'HALF_OPEN';
            entry.halfOpenInFlight = true;
            return { allowed: true, state: 'HALF_OPEN', probe: true };
        }

        if (entry.state === 'HALF_OPEN') {
            if (entry.halfOpenInFlight === true) {
                return {
                    allowed: false,
                    state: 'HALF_OPEN',
                    probe: false,
                    reason: 'HALF_OPEN_PROBE_IN_FLIGHT',
                };
            }
            entry.halfOpenInFlight = true;
            return { allowed: true, state: 'HALF_OPEN', probe: true };
        }

        return { allowed: true, state: 'CLOSED', probe: false };
    };

    const recordSuccess = (tierId) => {
        const key = normalizeTierKey(tierId);
        if (!key) return getState('');
        ensureCapacityForKey(key);
        states.set(key, {
            state: 'CLOSED',
            failures: 0,
            openedAt: null,
            lastError: null,
            halfOpenInFlight: false,
        });
        return getState(key);
    };

    const recordFailure = (tierId, reason = '') => {
        const key = normalizeTierKey(tierId);
        if (!key) return getState('');
        ensureCapacityForKey(key);

        const existing = states.get(key) || {
            state: 'CLOSED',
            failures: 0,
            openedAt: null,
            lastError: null,
            halfOpenInFlight: false,
        };

        const nextFailures = existing.failures + 1;
        const normalizedReason = String(reason || 'tier_failure');

        if (existing.state === 'HALF_OPEN' || nextFailures >= safeThreshold) {
            states.set(key, {
                state: 'OPEN',
                failures: nextFailures,
                openedAt: clock(),
                lastError: normalizedReason,
                halfOpenInFlight: false,
            });
        } else {
            states.set(key, {
                state: 'CLOSED',
                failures: nextFailures,
                openedAt: null,
                lastError: normalizedReason,
                halfOpenInFlight: false,
            });
        }

        return getState(key);
    };

    const releaseProbe = (tierId) => {
        const key = normalizeTierKey(tierId);
        if (!key) return false;
        const entry = states.get(key);
        if (!entry || !entry.halfOpenInFlight) return false;
        entry.halfOpenInFlight = false;
        return true;
    };

    const snapshot = () => {
        const out = {};
        for (const key of states.keys()) {
            if (!FORBIDDEN_KEYS.has(key)) {
                Object.defineProperty(out, key, {
                    value: getState(key),
                    enumerable: true,
                    writable: true,
                    configurable: true,
                });
            }
        }
        return out;
    };

    const reset = (tierId) => {
        const key = normalizeTierKey(tierId);
        if (!key) return false;
        return states.delete(key);
    };

    const clear = () => {
        states.clear();
    };

    const size = () => states.size;

    return {
        canAttempt,
        recordSuccess,
        recordFailure,
        releaseProbe,
        getState,
        snapshot,
        reset,
        clear,
        size,
    };
}

/**
 * Deterministic zero-I/O cascade tier selector (`< 25µs` CPU path, never throws).
 * Uses non-mutating `breaker.getState(tier.id)` inspection so planning does not consume
 * a single-flight `HALF_OPEN` probe token before `executeWithCascadeFallback` runs.
 *
 * @param {object} [options={}] - Selection constraints
 * @param {number} [options.complexityScore=0] - Normalized task complexity `[0, 1]`
 * @param {number} [options.estimatedTokens=0] - Estimated prompt + completion token budget
 * @param {boolean} [options.requiresTools=false] - Require native tool-calling capability
 * @param {boolean} [options.requiresVision=false] - Require multimodal vision capability
 * @param {boolean} [options.allowBurst=false] - Permit routing to on-demand burst tiers (`isBurst: true`)
 * @param {boolean} [options.allowFrontier=true] - Permit routing to cloud frontier tiers (`isFrontier: true`)
 * @param {readonly object[]} [options.tiers=DEFAULT_FLEET_CASCADE_TIERS] - Tier descriptor table
 * @param {object|null} [options.breaker=null] - Optional circuit breaker instance
 * @param {Record<string, string|undefined>} [options.env] - Environment override map
 * @param {string} [options.tool='cascade.select'] - Envelope tool identifier
 * @returns {object} `INV-LEGO-01` `okEnvelope` or `errorEnvelope`
 */
export function selectCascadeTier(options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    const {
        complexityScore = 0,
        estimatedTokens = 0,
        requiresTools = false,
        requiresVision = false,
        allowBurst = false,
        allowFrontier = true,
        tiers = DEFAULT_FLEET_CASCADE_TIERS,
        breaker = null,
        env = typeof process !== 'undefined' && process?.env ? process.env : {},
        tool = 'cascade.select',
    } = opts;
    try {
        const score = Number.isFinite(complexityScore)
            ? Math.min(1, Math.max(0, Number(complexityScore)))
            : 0;
        const tokens = Number.isFinite(estimatedTokens)
            ? Math.max(0, Math.trunc(estimatedTokens))
            : 0;

        const rawList = Array.isArray(tiers) ? tiers : [];
        const sortedTiers = rawList
            .filter((t) => t && typeof t === 'object' && normalizeTierKey(t.id) !== '')
            .sort((a, b) => (Number(a.rank) || 0) - (Number(b.rank) || 0));

        const safeEnv = env && typeof env === 'object' ? env : {};
        const eligible = [];

        for (const tier of sortedTiers) {
            if (tier.isBurst && !allowBurst) continue;
            if (tier.isFrontier && !allowFrontier) continue;
            if (requiresTools && !tier.supportsTools) continue;
            if (requiresVision && !tier.supportsVision) continue;
            if (tokens > 0 && tier.maxContextTokens && tokens > tier.maxContextTokens) continue;

            if (breaker && typeof breaker.getState === 'function') {
                const tierState = breaker.getState(tier.id);
                if (tierState?.state === 'OPEN' || tierState?.halfOpenInFlight === true) continue;
            }

            const envKey =
                typeof tier.envUrlKey === 'string' && !FORBIDDEN_KEYS.has(tier.envUrlKey)
                    ? tier.envUrlKey
                    : '';
            const overrideUrl =
                envKey && typeof safeEnv[envKey] === 'string' && safeEnv[envKey].trim()
                    ? safeEnv[envKey].trim()
                    : '';
            const endpointUrl = overrideUrl || tier.endpointUrl || tier.defaultUrl || '';

            const overrideGeminiModel =
                tier.provider === 'gemini' &&
                typeof safeEnv.GEMINI_MODEL === 'string' &&
                safeEnv.GEMINI_MODEL.trim()
                    ? safeEnv.GEMINI_MODEL.trim()
                    : '';

            eligible.push(
                Object.freeze({
                    ...tier,
                    endpointUrl,
                    model: overrideGeminiModel || tier.model || tier.defaultModel,
                })
            );
        }

        if (eligible.length === 0) {
            return errorEnvelope(
                'CASCADE_NO_HEALTHY_TIER',
                'No healthy cascade tier satisfies the request constraints',
                {
                    complexityScore: score,
                    estimatedTokens: tokens,
                    requiresTools: Boolean(requiresTools),
                    requiresVision: Boolean(requiresVision),
                    allowBurst: Boolean(allowBurst),
                    allowFrontier: Boolean(allowFrontier),
                },
                tool
            );
        }

        let primaryIndex = eligible.findIndex((t) => (t.maxComplexity ?? 1) >= score);
        let reason = 'complexity_match';
        if (primaryIndex === -1) {
            primaryIndex = eligible.length - 1;
            reason = 'max_available_tier_fallback';
        }

        const selectedTier = eligible[primaryIndex];
        const candidateChain = Object.freeze(eligible.slice(primaryIndex));

        return okEnvelope(
            tool,
            `Selected tier ${selectedTier.id} (${selectedTier.defaultModel})`,
            {
                selectedTier,
                candidateChain,
                reason,
            }
        );
    } catch (err) {
        return errorEnvelope(
            'CASCADE_NO_HEALTHY_TIER',
            err?.message || 'Cascade tier selection failed',
            null,
            tool
        );
    }
}

/**
 * Non-throwing, `AbortController`-bounded Ollama `/api/tags` probe for verifying
 * on-demand burst tunnel readiness and loaded model presence (`INV-LEGO-19`).
 *
 * @param {string} [endpointUrl='http://127.0.0.1:11435'] - Base Ollama endpoint URL
 * @param {object} [options={}] - Probe options
 * @param {number} [options.timeoutMs=1500] - Probe timeout in milliseconds
 * @param {string} [options.expectedModel=''] - Optional model identifier to verify in `/api/tags`
 * @param {typeof globalThis.fetch} [options.fetchImpl=globalThis.fetch] - Fetch implementation
 * @param {AbortSignal|null} [options.signal=null] - Optional caller abort signal
 * @param {string} [options.tool='cascade.probe'] - Envelope tool identifier
 * @returns {Promise<object>} `INV-LEGO-01` `okEnvelope` or `errorEnvelope`
 */
export async function probeBurstEndpoint(
    endpointUrl = 'http://127.0.0.1:11435',
    options = {}
) {
    const opts = options && typeof options === 'object' ? options : {};
    const {
        timeoutMs = 1500,
        expectedModel = '',
        fetchImpl = globalThis.fetch,
        signal = null,
        tool = 'cascade.probe',
    } = opts;
    const rawUrl = String(endpointUrl ?? '').trim();
    let parsedUrl;
    try {
        parsedUrl = new URL(rawUrl);
    } catch {
        return errorEnvelope(
            'BURST_UNREACHABLE',
            'Invalid burst endpoint URL',
            { reachable: false, endpointUrl: rawUrl, latencyMs: 0 },
            tool
        );
    }

    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        return errorEnvelope(
            'BURST_UNREACHABLE',
            `Unsupported burst endpoint protocol: ${parsedUrl.protocol}`,
            { reachable: false, endpointUrl: rawUrl, latencyMs: 0 },
            tool
        );
    }

    const normalizedBaseUrl = rawUrl.replace(/\/+$/, '').replace(/\/api\/tags$/i, '');
    const tagsUrl = `${normalizedBaseUrl}/api/tags`;

    if (typeof fetchImpl !== 'function') {
        return errorEnvelope(
            'BURST_UNREACHABLE',
            'No fetch implementation available for burst probe',
            { reachable: false, endpointUrl: normalizedBaseUrl, latencyMs: 0 },
            tool
        );
    }

    if (signal?.aborted) {
        return errorEnvelope(
            'BURST_UNREACHABLE',
            'Burst probe aborted by caller',
            { reachable: false, endpointUrl: normalizedBaseUrl, aborted: true, latencyMs: 0 },
            tool
        );
    }

    const parsedTimeout = Math.trunc(Number(timeoutMs) || 1500);
    const safeTimeoutMs = Number.isFinite(parsedTimeout) ? Math.max(50, parsedTimeout) : 1500;

    const controller = new AbortController();
    let timedOut = false;

    const onCallerAbort = () => {
        controller.abort(signal?.reason ?? new Error('Burst probe aborted by caller'));
    };

    if (signal && typeof signal.addEventListener === 'function') {
        signal.addEventListener('abort', onCallerAbort, { once: true });
    }

    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error(`Burst probe timed out after ${safeTimeoutMs}ms`));
    }, safeTimeoutMs);

    const startMs = monotonicNowMs();

    let abortListener = null;
    const abortRace = new Promise((_, reject) => {
        abortListener = () => {
            reject(controller.signal.reason || new Error('Burst probe aborted'));
        };
        if (controller.signal.aborted) {
            abortListener();
        } else {
            controller.signal.addEventListener('abort', abortListener, { once: true });
        }
    });

    try {
        const probeOperation = (async () => {
            const res = await fetchImpl(tagsUrl, {
                method: 'GET',
                headers: { Accept: 'application/json' },
                signal: controller.signal,
            });
            if (!res || !res.ok) {
                return { okHttp: false, status: res?.status ?? 0, payload: null };
            }
            const json = await res.json();
            return { okHttp: true, status: res.status, payload: json };
        })();
        probeOperation.catch(() => {});

        const { okHttp, status, payload } = await Promise.race([probeOperation, abortRace]);
        const latencyMs = Math.max(0, Math.round((monotonicNowMs() - startMs) * 100) / 100);

        if (!okHttp) {
            return errorEnvelope(
                'BURST_UNREACHABLE',
                `Burst endpoint returned HTTP ${status}`,
                {
                    reachable: false,
                    endpointUrl: normalizedBaseUrl,
                    status,
                    latencyMs,
                },
                tool
            );
        }

        const rawModels = Array.isArray(payload?.models) ? payload.models : [];
        const models = rawModels
            .map((entry) =>
                typeof entry === 'string'
                    ? entry.trim()
                    : String(entry?.name || entry?.model || '').trim()
            )
            .filter(Boolean);

        const targetModel = String(expectedModel || '').trim();
        let modelReady = true;

        if (targetModel) {
            const hasExplicitTag = targetModel.includes(':');
            const implicitLatest = hasExplicitTag ? targetModel : `${targetModel}:latest`;
            modelReady = models.some((loaded) => {
                if (loaded === targetModel) return true;
                if (!hasExplicitTag && loaded === implicitLatest) return true;
                if (targetModel.endsWith(':latest') && loaded === targetModel.slice(0, -7)) {
                    return true;
                }
                return false;
            });
        }

        if (targetModel && !modelReady) {
            return errorEnvelope(
                'BURST_MODEL_MISSING',
                `Burst endpoint reachable at ${normalizedBaseUrl} but model "${targetModel}" is not loaded`,
                {
                    reachable: true,
                    endpointUrl: normalizedBaseUrl,
                    expectedModel: targetModel,
                    models,
                    modelReady: false,
                    latencyMs,
                },
                tool
            );
        }

        return okEnvelope(
            tool,
            `Burst endpoint healthy at ${normalizedBaseUrl} (${models.length} model(s))`,
            {
                reachable: true,
                endpointUrl: normalizedBaseUrl,
                models,
                modelReady,
                latencyMs,
            }
        );
    } catch (err) {
        const latencyMs = Math.max(0, Math.round((monotonicNowMs() - startMs) * 100) / 100);
        const message = timedOut
            ? `Burst endpoint probe timed out after ${safeTimeoutMs}ms`
            : signal?.aborted
              ? 'Burst probe aborted by caller'
              : err?.message || 'Burst endpoint unreachable';

        return errorEnvelope(
            'BURST_UNREACHABLE',
            message,
            {
                reachable: false,
                endpointUrl: normalizedBaseUrl,
                timedOut,
                aborted: Boolean(signal?.aborted),
                latencyMs,
            },
            tool
        );
    } finally {
        clearTimeout(timer);
        if (signal && typeof signal.removeEventListener === 'function') {
            signal.removeEventListener('abort', onCallerAbort);
        }
        if (abortListener) {
            controller.signal.removeEventListener('abort', abortListener);
        }
    }
}

/**
 * Execute an async operation across an ordered `candidateChain` with per-attempt `AbortController`
 * timeouts, circuit breaker integration, and immediate non-penalizing external cancellation (`INV-LEGO-19`).
 *
 * @template TResult
 * @template TTier
 * @param {readonly TTier[]} candidateChain - Ordered list of tier descriptors or tier IDs
 * @param {(tier: TTier, ctx: { signal: AbortSignal, attemptIndex: number }) => Promise<TResult>|TResult} executorFn - Per-tier execution callback
 * @param {object} [options={}] - Execution options
 * @param {object|null} [options.breaker=null] - Optional `createTierCircuitBreaker` instance
 * @param {number} [options.perAttemptTimeoutMs=30000] - Timeout budget per tier attempt in ms
 * @param {AbortSignal|null} [options.signal=null] - Caller abort signal; halts cascade immediately when aborted
 * @param {string} [options.tool='cascade.execute'] - Envelope tool identifier
 * @returns {Promise<object>} `INV-LEGO-01` `okEnvelope` or `errorEnvelope`
 */
export async function executeWithCascadeFallback(
    candidateChain,
    executorFn,
    options = {}
) {
    const opts = options && typeof options === 'object' ? options : {};
    const {
        breaker = null,
        perAttemptTimeoutMs = 30_000,
        signal = null,
        tool = 'cascade.execute',
    } = opts;
    if (!Array.isArray(candidateChain) || candidateChain.length === 0) {
        return errorEnvelope(
            'CASCADE_EMPTY_CHAIN',
            'Candidate cascade chain must be a non-empty array',
            { attempts: [] },
            tool
        );
    }

    if (typeof executorFn !== 'function') {
        return errorEnvelope(
            'CASCADE_INVALID_EXECUTOR',
            'Cascade executorFn must be a function',
            { attempts: [] },
            tool
        );
    }

    if (signal?.aborted) {
        return errorEnvelope(
            'CASCADE_ABORTED',
            'Cascade execution aborted by caller',
            { attempts: [] },
            tool
        );
    }

    const parsedTimeout = Math.trunc(Number(perAttemptTimeoutMs) || 30_000);
    const safeAttemptTimeoutMs = Number.isFinite(parsedTimeout)
        ? Math.max(50, parsedTimeout)
        : 30_000;

    const attempts = [];

    for (let attemptIndex = 0; attemptIndex < candidateChain.length; attemptIndex += 1) {
        if (signal?.aborted) {
            return errorEnvelope(
                'CASCADE_ABORTED',
                'Cascade execution aborted by caller',
                { attempts },
                tool
            );
        }

        const tier = candidateChain[attemptIndex];
        const rawTierId = typeof tier === 'string' ? tier : tier?.id;
        const tierId = normalizeTierKey(rawTierId);

        if (!tierId) {
            attempts.push({
                tierId: '',
                skipped: true,
                state: 'OPEN',
                reason: 'INVALID_TIER_ID',
            });
            continue;
        }

        let acquiredProbe = false;
        if (breaker && typeof breaker.canAttempt === 'function') {
            const gate = breaker.canAttempt(tierId);
            if (!gate || !gate.allowed) {
                attempts.push({
                    tierId,
                    skipped: true,
                    state: gate?.state || 'OPEN',
                    reason: gate?.reason || 'CIRCUIT_OPEN',
                    ...(gate?.retryAfterMs !== undefined ? { retryAfterMs: gate.retryAfterMs } : {}),
                });
                continue;
            }
            acquiredProbe = Boolean(gate.probe);
        }

        const attemptController = new AbortController();
        let timedOut = false;
        let externalAborted = false;

        const onCallerAbort = () => {
            externalAborted = true;
            attemptController.abort(
                signal?.reason ?? new Error('Cascade execution aborted by caller')
            );
        };

        if (signal && typeof signal.addEventListener === 'function') {
            if (signal.aborted) {
                if (acquiredProbe) breaker?.releaseProbe?.(tierId);
                return errorEnvelope(
                    'CASCADE_ABORTED',
                    'Cascade execution aborted by caller',
                    { attempts },
                    tool
                );
            }
            signal.addEventListener('abort', onCallerAbort, { once: true });
        }

        const timer = setTimeout(() => {
            timedOut = true;
            attemptController.abort(
                new Error(`Tier ${tierId} timed out after ${safeAttemptTimeoutMs}ms`)
            );
        }, safeAttemptTimeoutMs);

        let onAttemptAbortReject = null;
        const abortRacePromise = new Promise((_, reject) => {
            onAttemptAbortReject = () => {
                reject(
                    attemptController.signal.reason ||
                        new Error(`Attempt aborted on tier ${tierId}`)
                );
            };
            if (attemptController.signal.aborted) {
                onAttemptAbortReject();
            } else {
                attemptController.signal.addEventListener('abort', onAttemptAbortReject, {
                    once: true,
                });
            }
        });

        const startMs = monotonicNowMs();

        try {
            const rawPromise = Promise.resolve().then(() =>
                executorFn(tier, { signal: attemptController.signal, attemptIndex })
            );
            rawPromise.catch(() => {});

            const out = await Promise.race([rawPromise, abortRacePromise]);
            const durationMs = Math.max(0, Math.round((monotonicNowMs() - startMs) * 100) / 100);

            if (signal?.aborted || externalAborted) {
                if (acquiredProbe) breaker?.releaseProbe?.(tierId);
                return errorEnvelope(
                    'CASCADE_ABORTED',
                    'Cascade execution aborted by caller',
                    { attempts },
                    tool
                );
            }

            if (out && typeof out === 'object' && out.ok === false) {
                const failureReason = String(
                    out.error?.message ||
                        out.summary ||
                        out.error?.code ||
                        'Tier returned error envelope'
                );
                breaker?.recordFailure?.(tierId, failureReason);
                attempts.push({
                    tierId,
                    ok: false,
                    durationMs,
                    timedOut: Boolean(timedOut),
                    error: failureReason,
                });
                continue;
            }

            breaker?.recordSuccess?.(tierId);
            attempts.push({
                tierId,
                ok: true,
                durationMs,
            });

            const attemptCount = attempts.filter((entry) => !entry.skipped).length;
            return okEnvelope(tool, `Cascade succeeded on tier ${tierId}`, {
                tierId,
                attemptCount,
                attempts,
                result: out,
            });
        } catch (err) {
            const durationMs = Math.max(0, Math.round((monotonicNowMs() - startMs) * 100) / 100);

            if (signal?.aborted || externalAborted) {
                if (acquiredProbe) breaker?.releaseProbe?.(tierId);
                return errorEnvelope(
                    'CASCADE_ABORTED',
                    'Cascade execution aborted by caller',
                    { attempts },
                    tool
                );
            }

            const failureReason = timedOut
                ? `Tier ${tierId} timed out after ${safeAttemptTimeoutMs}ms`
                : String(err?.message || err || 'Tier execution failed');

            breaker?.recordFailure?.(tierId, failureReason);
            attempts.push({
                tierId,
                ok: false,
                durationMs,
                timedOut: Boolean(timedOut),
                error: failureReason,
            });
        } finally {
            clearTimeout(timer);
            if (signal && typeof signal.removeEventListener === 'function') {
                signal.removeEventListener('abort', onCallerAbort);
            }
            if (onAttemptAbortReject) {
                attemptController.signal.removeEventListener('abort', onAttemptAbortReject);
            }
        }
    }

    return errorEnvelope(
        'CASCADE_EXHAUSTED',
        `All ${candidateChain.length} cascade tier(s) failed or were circuit-open`,
        { attempts },
        tool
    );
}
