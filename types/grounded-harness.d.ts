import type { OkEnvelope } from './envelopes.js';

export type ScaleTier = 'SMALL_MODEL' | 'MID_MODEL' | 'FRONTIER_REASONING';

export declare const SCALE_TIERS: {
    readonly SMALL_MODEL: 'SMALL_MODEL';
    readonly MID_MODEL: 'MID_MODEL';
    readonly FRONTIER_REASONING: 'FRONTIER_REASONING';
};

export interface ModelScaleHints {
    activeParamsB?: number | null;
    totalParamsB?: number | null;
    isMoe?: boolean;
    isNativeReasoningModel?: boolean;
    thinkingEnabled?: boolean;
    thinkingLevel?: string;
    reasoningEffort?: string;
}

export interface InferredModelScaleMetadata {
    normalizedModel: string;
    activeParamsB: number | null;
    totalParamsB: number | null;
    isMoe: boolean;
    isNativeReasoningModel: boolean;
    thinkingEnabled: boolean;
}

export interface ResolveScaleProfileOptions extends ModelScaleHints {
    model?: string;
    explicitTier?: ScaleTier | string;
    preferThinkingStepForSmallActive?: boolean;
}

export interface ScaleProfile {
    readonly tier: ScaleTier;
    readonly model: string;
    readonly inferredActiveParamsB: number | null;
    readonly inferredTotalParamsB: number | null;
    readonly isMoe: boolean;
    readonly thinkingEnabled: boolean;
    readonly injectPlanBindStep: boolean;
    readonly rescueSerializedToolCalls: boolean;
    readonly softHoldPlaceholdersAndDates: boolean;
    readonly maxMechanicalVerifyNudges: number;
    readonly enforceZeroMutationImperativeNudge: false;
    readonly enforceTwoPhaseAnalyticalNudge: false;
    readonly maxReadStreak: 0;
    readonly rationale: string;
}

export interface ToolAnnotationsLike {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
}

export interface ToolDefinitionLike {
    name?: string;
    title?: string;
    component?: string;
    category?: string;
    description?: string;
    annotations?: ToolAnnotationsLike;
    inputSchema?: Record<string, unknown>;
    parameters?: Record<string, unknown>;
    function?: {
        name?: string;
        description?: string;
        parameters?: Record<string, unknown>;
    };
    handler?: (args: Record<string, unknown>) => unknown | Promise<unknown>;
    execute?: (args: Record<string, unknown>) => unknown | Promise<unknown>;
    [key: string]: unknown;
}

export interface ToolSchemaSavings {
    rawToolCount: number;
    exposedToolCount: number;
    rawSchemaTokens: number;
    exposedSchemaTokens: number;
    savedSchemaTokens: number;
    reductionPct: number;
}

export type ToolDispatcherFn = (
    toolName: string,
    args: Record<string, unknown>
) => unknown | Promise<unknown>;

export interface DeferredToolBridgeInstance {
    shouldDefer: boolean;
    getExposedTools: () => ToolDefinitionLike[];
    search: (query: string, limit?: number) => Record<string, unknown>;
    describe: (toolName: string) => Record<string, unknown>;
    call: (toolName: string, args?: Record<string, unknown>) => Promise<Record<string, unknown>>;
    estimateSchemaSavings: () => {
        fullBytes: number;
        exposedBytes: number;
        reductionRatio: number;
    };
}

export interface ToolBudgetGateOptions {
    tools?: ReadonlyArray<ToolDefinitionLike>;
    pinnedToolNames?: ReadonlyArray<string>;
    deferThreshold?: number;
    forceDefer?: boolean;
    searchTopK?: number;
    dispatcher?: ToolDispatcherFn;
}

export interface ToolBudgetGate {
    deferred: boolean;
    exposedTools: ToolDefinitionLike[];
    savings: ToolSchemaSavings;
    bridge: DeferredToolBridgeInstance | null;
    invokeMetaTool: (
        name: string,
        args?: Record<string, unknown>,
        overrideDispatcher?: ToolDispatcherFn
    ) => Promise<Record<string, unknown>>;
}

export interface DeltaContextTrackerOptions {
    initialChunkIds?: ReadonlyArray<string>;
    initialFileDigests?: Record<string, string>;
}

export interface DeltaChunkCandidate {
    chunkId?: string;
    windowId?: string;
    entryId?: string;
    id?: string | number;
    contentHash?: string;
    text?: string;
    content?: string;
    [key: string]: unknown;
}

export interface DeltaFilterResult<TChunk = DeltaChunkCandidate | string> {
    deltaChunks: TChunk[];
    suppressedCount: number;
    acceptedCount: number;
    totalCandidates: number;
    turn0DuplicatesSuppressed: number;
}

export interface ReadMemoCheckResult {
    hit: boolean;
    callSignature: string;
    preview: string | null;
    result: unknown;
    hits: number;
    recordedAtMs: number | null;
}

export interface ReadMemoStoredEntry {
    callSignature: string;
    preview: string;
    result: unknown;
    hits: number;
    recordedAtMs: number;
}

export interface DeltaContextMetrics {
    seenChunkCount: number;
    seenFileDigestCount: number;
    memoizedSignatureCount: number;
    turn0SeededChunks: number;
    turn0DuplicatesSuppressed: number;
    deltaChunksAccepted: number;
    digestShortCircuits: number;
    memoizedReadHits: number;
}

export interface DeltaContextTracker {
    seedTurnZero: (seed?: {
        chunkIds?: ReadonlyArray<string>;
        fileDigests?: Record<string, string>;
    }) => {
        seededChunkCount: number;
        seededFileCount: number;
    };
    filterDeltaChunks: <TChunk = DeltaChunkCandidate | string>(
        chunks?: ReadonlyArray<TChunk>,
        options?: { recordSeen?: boolean }
    ) => DeltaFilterResult<TChunk>;
    hasSeenFileDigest: (relPath: string, digest?: string | null) => boolean;
    recordFileDigest: (relPath: string, digest: string | null) => boolean;
    checkReadMemo: (callSignature: string) => ReadMemoCheckResult;
    recordReadMemo: (
        callSignature: string,
        entry?: string | { preview?: string; result?: unknown }
    ) => ReadMemoStoredEntry | null;
    getMetrics: () => DeltaContextMetrics;
}

export interface GroundedDocObject {
    relPath?: string;
    path?: string;
    title?: string;
    id?: string;
    text?: string;
    content?: string;
    sha256?: string;
    [key: string]: unknown;
}

export type GroundedDocInput = string | GroundedDocObject;

export interface PolicyFloorRuleInput {
    id: string;
    category?: string;
    description: string;
    targetTools?: ReadonlyArray<string>;
    pattern: RegExp | string;
    match: ReadonlyArray<string>;
    not_match: ReadonlyArray<string>;
}

export interface GeminiFunctionCallingConfig {
    mode: 'NONE' | 'AUTO' | 'ANY' | string;
    allowedFunctionNames?: string[];
    [key: string]: unknown;
}

export interface GeminiToolConfig {
    functionCallingConfig?: GeminiFunctionCallingConfig;
    [key: string]: unknown;
}

export interface BuildSafeGeminiToolConfigOptions {
    tools?: ReadonlyArray<ToolDefinitionLike> | Record<string, unknown> | null;
    toolConfig?: GeminiToolConfig | null;
    disableAutoToolConfigNone?: boolean;
}

export type OutputDefectCode =
    | 'TRUNCATED_OUTPUT'
    | 'SERIALIZED_TOOL_CALL_IN_TEXT'
    | 'EMPTY_OR_NULL_BAILOUT'
    | 'RAW_DATAFRAME_OR_NUMPY_REPR';

export interface OutputDefect {
    code: OutputDefectCode;
    message: string;
}

export interface InspectOutputDefectsInput {
    candidateAnswer?: unknown;
    hasFinalAnswer?: boolean;
    assistantText?: string;
    content?: string;
    text?: string;
    finalText?: string;
    finishReason?: string | null;
    stopReason?: string | null;
    finish_reason?: string | null;
    stop_reason?: string | null;
    truncatedToolCalls?: boolean;
    toolCalls?: ReadonlyArray<Record<string, unknown>>;
    tool_calls?: ReadonlyArray<Record<string, unknown>>;
    expectNonEmptyAnswer?: boolean;
    enableOutputDefectGate?: boolean;
    enable_output_defect_gate?: boolean;
}

export interface InspectOutputDefectsResult {
    hasDefect: boolean;
    defects: OutputDefect[];
    primaryDefect: OutputDefect | null;
    correctivePrompt: string | null;
    rescuedToolCalls: RescuedToolCall[];
}

export interface DetectDatasetSchemaHazardsInput {
    headers?: ReadonlyArray<string>;
    csvRows?: ReadonlyArray<ReadonlyArray<unknown> | Record<string, unknown>>;
    jsonRecords?: ReadonlyArray<Record<string, unknown>>;
}

export interface DatasetSchemaHazardsResult {
    hasLiteralNaHazard: boolean;
    naHazardColumns: string[];
    nullFields: string[];
    emptyArrayFields: string[];
    wildcardCandidateFields: string[];
    hazardWarnings: string[];
}

export interface FormatTimeoutOptions {
    timeoutMs?: number;
    timeoutSeconds?: number;
    stdout?: string;
    stderr?: string;
    maxStdoutChars?: number;
    label?: string;
}

export interface TimeoutWithPartialStdoutResult {
    ok: false;
    timedOut: true;
    stdout: string;
    stderr: string;
    hasFinalAnswer: false;
    finalAnswer: null;
    error: string;
    formattedObservation: string;
}

export interface AsyncPartialStdoutContext {
    signal: AbortSignal;
    onStdout: (chunk: string) => void;
    onStderr: (chunk: string) => void;
}

export interface RunAsyncWithPartialStdoutOptions {
    timeoutMs?: number;
    maxStdoutChars?: number;
    label?: string;
}

export interface RunAsyncWithPartialStdoutSuccess {
    ok: boolean;
    timedOut: false;
    stdout: string;
    stderr: string;
    [key: string]: unknown;
}

export interface GroundedHarnessLoopOptions extends ResolveScaleProfileOptions {
    maxDuplicateWrites?: number;
    verificationCommand?: string | null;
    maxVerifyRetries?: number;
    maxDefectRetries?: number;
    enableOutputDefectGate?: boolean;
    toolConfig?: GeminiToolConfig | null;
    disableAutoToolConfigNone?: boolean;
    baseSystemPrompt?: string;
    standingInvariants?: ReadonlyArray<string>;
    schemaSummaryText?: string;
    docs?: ReadonlyArray<GroundedDocInput>;
    fileDigests?: Record<string, string>;
    tools?: ReadonlyArray<ToolDefinitionLike>;
    pinnedToolNames?: ReadonlyArray<string>;
    deferThreshold?: number;
    forceDefer?: boolean;
    searchTopK?: number;
    dispatcher?: ToolDispatcherFn;
    protectedPaths?: ReadonlyArray<string>;
    extraFloorRules?: ReadonlyArray<PolicyFloorRuleInput>;
    maxDocEvidenceTokens?: number;
    topKChunks?: number;
}

export interface CompilePromptOptions {
    topKChunks?: number;
    maxDocEvidenceTokens?: number;
    extraContext?: string;
    history?: ReadonlyArray<Record<string, unknown>>;
    toolConfig?: GeminiToolConfig | null;
    disableAutoToolConfigNone?: boolean;
}

export interface RetrievedGroundedChunk {
    chunkId: string;
    windowId: string;
    text: string;
    tokenCount: number;
}

export interface CompilePromptTokenStats {
    systemPrefixTokens: number;
    docEvidenceTokens: number;
    goalTokens: number;
    totalPromptTokens: number;
    exposedToolSchemaTokens: number;
    savedToolSchemaTokens: number;
}

export interface CompilePromptData {
    goal: string;
    scaleProfile: ScaleProfile;
    scaleDirective: string;
    prefixHash: string;
    geminiToolConfig: GeminiToolConfig | null;
    compiledSystemPrompt: string;
    compiledContextBlock: string;
    messages: Array<Record<string, unknown>>;
    exposedTools: ToolDefinitionLike[];
    toolSavings: ToolSchemaSavings;
    retrievedChunks: RetrievedGroundedChunk[];
    seenChunkIds: string[];
    tokenStats: CompilePromptTokenStats;
    cachedIndexReused: boolean;
    llmIngestionCalls: 0;
}

export interface RescuedToolCall {
    name: string;
    args: Record<string, unknown>;
}

export interface TruncationGuardVerdict {
    poisoned: boolean;
    safeToExecuteTools: boolean;
    reason: string | null;
    truncatedCallIds: string[];
    recoveryPrompt: string | null;
}

export interface EvaluateTurnInput {
    finishReason?: string | null;
    stopReason?: string | null;
    finish_reason?: string | null;
    stop_reason?: string | null;
    truncatedToolCalls?: boolean;
    toolCalls?: ReadonlyArray<Record<string, unknown>>;
    tool_calls?: ReadonlyArray<Record<string, unknown>>;
    content?: string;
    assistantText?: string;
    text?: string;
    [key: string]: unknown;
}

export interface EvaluateTurnData<TChunk = DeltaChunkCandidate | string> {
    poisoned: boolean;
    safeToExecuteTools: boolean;
    truncation: TruncationGuardVerdict;
    deltaChunks: TChunk[];
    suppressedChunkCount: number;
    acceptedChunkCount: number;
    serializedToolCallsDetected: boolean;
    rescuedToolCalls: RescuedToolCall[];
    deltaMetrics: DeltaContextMetrics;
}

export type InterceptDecision =
    | 'ALLOW'
    | 'BLOCK_POLICY_FLOOR'
    | 'SECRET_LEAK_BLOCKED'
    | 'BLOCK_DUPLICATE_WRITE'
    | 'SOFT_HOLD_PLACEHOLDER_OR_DATE'
    | 'BLOCK_SPIN_LOOP'
    | 'MEMOIZED_PRIOR_READ'
    | 'TURN0_DIGEST_SHORT_CIRCUIT';

export interface InterceptIssue {
    code: string;
    field?: string | null;
    message: string;
}

export interface InterceptToolOptions {
    isMutating?: boolean;
    maxDuplicateWrites?: number;
    blockSpinLoop?: boolean;
    allowPlaceholders?: boolean;
    allowSecretScanBypass?: boolean;
    currentDigest?: string;
    fileDigest?: string;
    digest?: string;
}

export interface InterceptToolCallData {
    allowed: boolean;
    decision: InterceptDecision;
    code: string;
    ruleId: string | null;
    reason: string;
    callSignature: string;
    toolName: string;
    isMutating: boolean;
    maxReadStreak: 0;
    issues: InterceptIssue[];
    cachedPreview?: string | null;
    cachedResult?: unknown;
    targetPath?: string;
}

export interface RecordToolOutcomeOptions {
    ok?: boolean;
    preview?: string;
    result?: unknown;
    isMutating?: boolean;
    pendingDiffsDelta?: number;
    verificationPassed?: boolean;
    timedOut?: boolean;
    partialStdout?: string;
    stdout?: string;
    stderr?: string;
    timeoutMs?: number;
    timeoutSeconds?: number;
    maxStdoutChars?: number;
    label?: string;
}

export interface RecordToolOutcomeData {
    callSignature: string;
    ok: boolean;
    isMutating: boolean;
    timedOut?: boolean;
    hasFinalAnswer?: false;
    finalAnswer?: null;
    preservedStdout?: string;
    formattedObservation?: string;
    error?: string;
    committedReads: number;
    committedMutations: number;
    pendingDiffsCount: number;
    latestVerificationPassed: boolean;
}

export type VerifyStopAction =
    | 'ALLOW_STOP'
    | 'CONTINUE_NORMAL'
    | 'FORCE_VERIFY'
    | 'ABORT_UNVERIFIED'
    | 'RESCUE_SERIALIZED_TOOL_CALL'
    | 'REJECT_OUTPUT_DEFECT'
    | 'RESCUE_UNCOMMITTED_DRAFT';

export interface VerifyStopTurnState {
    stopRequested?: boolean;
    toolCalls?: ReadonlyArray<Record<string, unknown>>;
    tool_calls?: ReadonlyArray<Record<string, unknown>>;
    candidateAnswer?: unknown;
    hasFinalAnswer?: boolean;
    assistantText?: string;
    content?: string;
    text?: string;
    finalText?: string;
    finishReason?: string | null;
    stopReason?: string | null;
    finish_reason?: string | null;
    stop_reason?: string | null;
    truncatedToolCalls?: boolean;
    expectNonEmptyAnswer?: boolean;
    enableOutputDefectGate?: boolean;
    maxDefectRetries?: number;
    pendingDiffsCount?: number;
    latestVerificationPassed?: boolean;
    verificationCommand?: string | null;
    maxVerifyRetries?: number;
    isPolicyAbstention?: boolean;
    policyAbstention?: boolean;
    hasUncommittedDraft?: boolean;
    committedMutations?: number;
}

export interface VerifyStopData {
    allowStop: boolean;
    action: VerifyStopAction;
    defectCode?: OutputDefectCode | null;
    defects?: OutputDefect[];
    reason: string;
    correctivePrompt: string | null;
    rescuedToolCalls: RescuedToolCall[];
    isPolicyAbstention?: boolean;
    pendingDiffsCount: number;
    latestVerificationPassed: boolean;
    verifyNudgesUsed: number;
}

export interface GroundedHarnessStats {
    scaleTier: ScaleTier;
    model: string;
    schemaSavings: ToolSchemaSavings;
    deltaMetrics: DeltaContextMetrics;
    committedReads: number;
    committedMutations: number;
    spinLoopsBlocked: number;
    outputDefectsCaught: number;
    timeoutsWithPartialStdout: number;
    duplicateWritesBlocked: number;
    policyFloorBlocks: number;
    secretLeaksBlocked: number;
    softHoldsTriggered: number;
    truncationRecoveries: number;
    verifyNudgesUsed: number;
    pendingDiffsCount: number;
    latestVerificationPassed: boolean;
}

export interface GroundedHarnessLoop {
    readonly scaleProfile: ScaleProfile;
    readonly toolGate: ToolBudgetGate;
    readonly deltaTracker: DeltaContextTracker;
    compilePrompt: (
        goal?: string,
        compileOpts?: CompilePromptOptions
    ) => Promise<OkEnvelope<CompilePromptData>>;
    evaluateTurn: <TChunk = DeltaChunkCandidate | string>(
        turnResponse?: EvaluateTurnInput,
        candidateChunks?: ReadonlyArray<TChunk>
    ) => OkEnvelope<EvaluateTurnData<TChunk>>;
    interceptToolCall: (
        toolName: string,
        args?: Record<string, unknown>,
        opts?: InterceptToolOptions
    ) => OkEnvelope<InterceptToolCallData>;
    recordToolOutcome: (
        callSignature: string,
        outcome?: RecordToolOutcomeOptions
    ) => OkEnvelope<RecordToolOutcomeData>;
    verifyStop: (turnState?: VerifyStopTurnState) => OkEnvelope<VerifyStopData>;
    getStats: () => GroundedHarnessStats;
}

export declare function inferModelScaleMetadata(
    modelId?: string,
    hints?: ModelScaleHints
): InferredModelScaleMetadata;

export declare function resolveScaleProfile(
    options?: ResolveScaleProfileOptions
): ScaleProfile;

export declare function buildScaleAwareDirective(
    profile?: Partial<ScaleProfile> | null
): string;

export declare function measureToolSchemaSavings(
    allTools?: ReadonlyArray<ToolDefinitionLike>,
    exposedTools?: ReadonlyArray<ToolDefinitionLike>
): ToolSchemaSavings;

export declare function createToolBudgetGate(
    options?: ToolBudgetGateOptions
): ToolBudgetGate;

export declare function createDeltaContextTracker(
    options?: DeltaContextTrackerOptions
): DeltaContextTracker;

export declare function buildSafeGeminiToolConfig(
    options?: BuildSafeGeminiToolConfigOptions
): GeminiToolConfig | null;

export declare function normalizeCodeSnippetForHash(
    source?: string,
    keyHint?: string
): string;

export declare function inspectOutputDefects(
    input?: InspectOutputDefectsInput
): InspectOutputDefectsResult;

export declare function detectDatasetSchemaHazards(
    input?: DetectDatasetSchemaHazardsInput
): DatasetSchemaHazardsResult;

export declare function formatTimeoutWithPartialStdout(
    options?: FormatTimeoutOptions
): TimeoutWithPartialStdoutResult;

export declare function runAsyncWithPartialStdout<
    TResult extends Record<string, unknown> = Record<string, unknown>
>(
    runnerFn: (ctx: AsyncPartialStdoutContext) => TResult | Promise<TResult>,
    options?: RunAsyncWithPartialStdoutOptions
): Promise<TimeoutWithPartialStdoutResult | (RunAsyncWithPartialStdoutSuccess & Partial<TResult>)>;

export declare function createGroundedHarnessLoop(
    options?: GroundedHarnessLoopOptions
): GroundedHarnessLoop;
