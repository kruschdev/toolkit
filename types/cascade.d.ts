import type { ErrorDetail, ErrorEnvelope, LegoEnvelope, OkEnvelope } from './envelopes.js';

export type { ErrorDetail, ErrorEnvelope, LegoEnvelope, OkEnvelope };

export type CascadeProvider = 'ollama' | 'gemini' | 'openai' | 'xai' | (string & {});

export type CascadeTierId =
    | 'L1_FAST'
    | 'L2_HEAVY_MOE'
    | 'L2_5_COLAB_BURST'
    | 'L3_FRONTIER_ARGON'
    | (string & {});

export interface CascadeTierDescriptor {
    readonly id: CascadeTierId;
    readonly rank: number;
    readonly provider: CascadeProvider;
    readonly defaultModel: string;
    readonly envUrlKey?: string;
    readonly defaultUrl: string;
    readonly maxContextTokens: number;
    readonly supportsTools: boolean;
    readonly supportsVision: boolean;
    readonly isBurst: boolean;
    readonly isFrontier: boolean;
    readonly maxComplexity: number;
    readonly capabilities?: readonly string[];
    readonly endpointUrl?: string;
    readonly model?: string;
}

export interface ResolvedCascadeTier extends CascadeTierDescriptor {
    readonly endpointUrl: string;
    readonly model: string;
}

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CreateTierCircuitBreakerOptions {
    failureThreshold?: number;
    cooldownMs?: number;
    maxTiers?: number;
    nowFn?: () => number;
}

export interface CircuitBreakerGateResult {
    allowed: boolean;
    state: CircuitState;
    probe: boolean;
    reason?: string;
    retryAfterMs?: number;
}

export interface CircuitBreakerTierState {
    state: CircuitState;
    failures: number;
    openedAt: number | null;
    lastError: string | null;
    halfOpenInFlight: boolean;
    retryAfterMs: number;
}

export interface TierCircuitBreaker {
    canAttempt(tierId: string): CircuitBreakerGateResult;
    recordSuccess(tierId: string): CircuitBreakerTierState;
    recordFailure(tierId: string, reason?: string): CircuitBreakerTierState;
    releaseProbe(tierId: string): boolean;
    getState(tierId: string): CircuitBreakerTierState;
    snapshot(): Record<string, CircuitBreakerTierState>;
    reset(tierId: string): boolean;
    clear(): void;
    size(): number;
}

export interface SelectCascadeTierOptions {
    complexityScore?: number;
    estimatedTokens?: number;
    requiresTools?: boolean;
    requiresVision?: boolean;
    allowBurst?: boolean;
    allowFrontier?: boolean;
    tiers?: readonly CascadeTierDescriptor[];
    breaker?: Pick<TierCircuitBreaker, 'getState'> | null;
    env?: Record<string, string | undefined>;
    tool?: string;
}

export type CascadeSelectionReason = 'complexity_match' | 'max_available_tier_fallback' | (string & {});

export interface SelectCascadeTierData {
    selectedTier: ResolvedCascadeTier;
    candidateChain: readonly ResolvedCascadeTier[];
    reason: CascadeSelectionReason;
}

export interface SelectCascadeTierErrorDetails {
    complexityScore: number;
    estimatedTokens: number;
    requiresTools: boolean;
    requiresVision: boolean;
    allowBurst: boolean;
    allowFrontier: boolean;
}

export interface ProbeBurstEndpointOptions {
    timeoutMs?: number;
    expectedModel?: string;
    fetchImpl?: typeof globalThis.fetch;
    signal?: AbortSignal | null;
    tool?: string;
}

export interface ProbeBurstEndpointData {
    reachable: true;
    endpointUrl: string;
    models: string[];
    modelReady: boolean;
    latencyMs: number;
}

export interface ProbeBurstErrorDetails {
    reachable?: boolean;
    endpointUrl: string;
    expectedModel?: string;
    models?: string[];
    modelReady?: boolean;
    status?: number;
    timedOut?: boolean;
    aborted?: boolean;
    latencyMs: number;
}

export interface CascadeAttemptContext {
    signal: AbortSignal;
    attemptIndex: number;
}

export type CascadeExecutorFn<TResult = unknown, TTier = ResolvedCascadeTier> = (
    tier: TTier,
    context: CascadeAttemptContext
) => Promise<TResult> | TResult;

export interface CascadeSkippedAttempt {
    tierId: string;
    skipped: true;
    state: CircuitState;
    reason: string;
    retryAfterMs?: number;
}

export interface CascadeExecutedAttempt {
    tierId: string;
    skipped?: false;
    ok: boolean;
    durationMs: number;
    timedOut?: boolean;
    error?: string;
}

export type CascadeAttemptRecord = CascadeSkippedAttempt | CascadeExecutedAttempt;

export interface ExecuteWithCascadeOptions {
    breaker?: Pick<TierCircuitBreaker, 'canAttempt' | 'recordSuccess' | 'recordFailure' | 'releaseProbe'> | null;
    perAttemptTimeoutMs?: number;
    signal?: AbortSignal | null;
    tool?: string;
}

export interface ExecuteWithCascadeData<TResult = unknown> {
    tierId: string;
    attemptCount: number;
    attempts: CascadeAttemptRecord[];
    result: TResult;
}

export interface ExecuteWithCascadeErrorDetails {
    attempts: CascadeAttemptRecord[];
}

export declare const DEFAULT_FLEET_CASCADE_TIERS: readonly CascadeTierDescriptor[];

export declare function createTierCircuitBreaker(
    options?: CreateTierCircuitBreakerOptions
): TierCircuitBreaker;

export declare function selectCascadeTier(
    options?: SelectCascadeTierOptions
): LegoEnvelope<SelectCascadeTierData, SelectCascadeTierErrorDetails>;

export declare function probeBurstEndpoint(
    endpointUrl?: string,
    options?: ProbeBurstEndpointOptions
): Promise<LegoEnvelope<ProbeBurstEndpointData, ProbeBurstErrorDetails>>;

export declare function executeWithCascadeFallback<
    TResult = unknown,
    TTier extends CascadeTierDescriptor | string = ResolvedCascadeTier
>(
    candidateChain: readonly TTier[],
    executorFn: CascadeExecutorFn<TResult, TTier>,
    options?: ExecuteWithCascadeOptions
): Promise<LegoEnvelope<ExecuteWithCascadeData<TResult>, ExecuteWithCascadeErrorDetails>>;
