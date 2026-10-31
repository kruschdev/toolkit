export declare const RAW_RAG_DEFAULTS: {
    readonly windowTokens: number;
    readonly overlapTokens: number;
    readonly strideTokens: number;
    readonly denseCandidateK: number;
    readonly finalRerankK: number;
    readonly maxEvidenceTokens: number;
    readonly turnExpansion: boolean;
    readonly deduplicateTurns: boolean;
    readonly chronologicalOrder: boolean;
    readonly llmIngestionCalls: 0;
};

export declare const RAG_BASELINE_CONSTRAINTS: {
    readonly minChunkTokens: number;
    readonly recommendedChunkRange: readonly [number, number];
    readonly maxRecommendedChunkTokens: number;
    readonly minRecommendedTopK: number;
    readonly optimalTopKRange: readonly [number, number];
    readonly maxDistractorSafeTopK: number;
    readonly recommendedDenseCandidateK: number;
    readonly requiresCrossEncoderRerank: boolean;
    readonly allowDestructiveOverwrite: boolean;
};

export declare const QWEN_RERANKER_TEMPLATE: {
    readonly system: string;
    readonly instruction: string;
};

export declare const LEGAL_BOILERPLATE_STOPWORDS: ReadonlySet<string>;

export interface TokenWithOffset {
    token: string;
    start: number;
    end: number;
}

export interface ConversationTurnInput {
    turnId?: string;
    id?: string | number;
    date?: string | number | null;
    sessionDate?: string | null;
    createdAt?: string | null;
    speaker?: string;
    role?: string;
    content?: string;
    text?: string;
    imageCaptions?: string[];
    imageCaption?: string;
    phase?: number | null;
    timestamp?: number | null;
    [key: string]: unknown;
}

export interface SerializedConversationTurn {
    turnIndex: number;
    turnId: string;
    date: string;
    speaker: string;
    content: string;
    imageCaptions: string[];
    phase: number | null;
    timestamp: number | null;
    serialized: string;
}

export interface ConversationWindow {
    windowId: string;
    windowIndex: number;
    text: string;
    contentHash: string;
    startToken: number;
    endToken: number;
    tokenCount: number;
    turnIndices: number[];
    turnIds: string[];
    minPhase: number | null;
    maxPhase: number | null;
    minTimestamp: number | null;
    maxTimestamp: number | null;
}

export interface RagBaselineFinding {
    code: string;
    severity: 'error' | 'warning';
    message: string;
}

export interface RagBaselineAuditResult {
    valid: boolean;
    status: 'STRONG_RAW_RAG' | 'SUBOPTIMAL' | 'WEAKENED_BASELINE';
    findings: RagBaselineFinding[];
    recommendedConfig: typeof RAW_RAG_DEFAULTS;
}

export interface NormalizedAppendOnlyWriteOp {
    action: 'ADD' | 'NONE' | 'COMPLIANCE_TOMBSTONE';
    originalAction: string;
    effectiveWrite: boolean;
    supersedesId: string | null;
    targetId: string | null;
    text: string;
    reason: string;
}

export interface MutationStreamAuditResult {
    totalDecisions: number;
    rawCounts: Record<string, number>;
    normalizedCounts: Record<string, number>;
    effectiveAddCount: number;
    effectiveMutationCount: number;
    effectiveMutationRate: number;
    noopOrMalformedMutationCount: number;
    normalizedDecisions: NormalizedAppendOnlyWriteOp[];
}

export interface RerankedWindow extends Partial<ConversationWindow> {
    windowId: string;
    text: string;
    denseScore: number;
    rerankScore: number;
    rerankMode: 'custom_fn' | 'logprobs' | 'token' | 'deterministic_cross_encoder' | (string & {});
    [key: string]: unknown;
}

export interface ReaderEvidenceEntry {
    entryId: string;
    sourceType: 'expanded_turn' | 'expanded_window_turns' | 'raw_window';
    windowId?: string;
    turnIndices: number[];
    orderKey: number;
    text: string;
    tokenCount: number;
}

export interface AssembledReaderEvidence {
    contextText: string;
    entries: ReaderEvidenceEntry[];
    tokenCount: number;
    selectedWindowCount: number;
    retainedEntryCount: number;
    turnExpansionApplied: boolean;
    budgetPolicyTriggered: 'NONE' | 'DISABLED_TURN_EXPANSION' | 'PREFIX_COMPLETE_WINDOWS';
}

export interface RawRagRetrieveResult extends AssembledReaderEvidence {
    query: string;
    selectedWindows: RerankedWindow[];
    denseCandidateCount: number;
    llmIngestionCalls: 0;
}

export interface RawRagIndexOptions {
    windowTokens?: number;
    overlapTokens?: number;
    denseCandidateK?: number;
    finalRerankK?: number;
    maxEvidenceTokens?: number;
    turnExpansion?: boolean;
    deduplicateTurns?: boolean;
    chronologicalOrder?: boolean;
    model?: string;
    dimensions?: number;
    host?: string;
    domain?: string;
    offline?: boolean;
    mock?: boolean;
    isolatePhases?: boolean;
    idPrefix?: string;
    rerankerFn?: (query: string, candidate: any) => Promise<any> | any;
    endpoint?: string;
    rerankerModel?: string;
    fetchImpl?: typeof fetch;
}

export interface RawRagIndex {
    addTurns: (newTurns?: Array<ConversationTurnInput | string>) => Promise<{
        addedTurns: number;
        totalTurns: number;
        totalWindows: number;
        llmIngestionCalls: 0;
    }>;
    applyWriteProposal: (
        proposal?: Record<string, any>,
        writeOptions?: { explicitComplianceErase?: boolean }
    ) => Promise<NormalizedAppendOnlyWriteOp>;
    retrieve: (
        query: string,
        retrieveOptions?: {
            maxPhase?: number | null;
            maxTimestamp?: number | null;
            denseCandidateK?: number;
            finalRerankK?: number;
            topK?: number;
            domain?: string;
            offline?: boolean;
            maxEvidenceTokens?: number;
            turnExpansion?: boolean;
            deduplicateTurns?: boolean;
            chronologicalOrder?: boolean;
            rerankerFn?: (query: string, candidate: any) => Promise<any> | any;
            endpoint?: string;
            rerankerModel?: string;
            fetchImpl?: typeof fetch;
        }
    ) => Promise<RawRagRetrieveResult>;
    getStats: () => {
        turnCount: number;
        windowCount: number;
        cachedVectors: number;
        sidecarRecordCount: number;
        mutationProposalCount: number;
        llmIngestionCalls: 0;
        config: Record<string, unknown>;
    };
    exportSnapshot: () => {
        serializedTurns: SerializedConversationTurn[];
        windows: ConversationWindow[];
        sidecarRecords: Array<Record<string, unknown>>;
        mutationLog: NormalizedAppendOnlyWriteOp[];
    };
}

export declare function tokenizeWithOffsets(text: string): TokenWithOffset[];

export declare function estimateTokenCount(text: string): number;

export declare function serializeConversationTurn(
    turn: ConversationTurnInput | string,
    index?: number
): SerializedConversationTurn;

export declare function chunkConversationWindows(
    turns?: Array<ConversationTurnInput | string>,
    options?: {
        windowTokens?: number;
        overlapTokens?: number;
        idPrefix?: string;
        isolatePhases?: boolean;
    }
): {
    serializedTurns: SerializedConversationTurn[];
    windows: ConversationWindow[];
    totalTokens: number;
};

export declare function auditRagBaselineConfig(config?: Record<string, unknown>): RagBaselineAuditResult;

export declare function normalizeAppendOnlyWriteOp(
    proposal?: Record<string, any>,
    existingRecords?: Array<{ id?: string; text?: string; content?: string; deleted?: boolean }>,
    options?: { explicitComplianceErase?: boolean }
): NormalizedAppendOnlyWriteOp;

export declare function auditMutationStream(
    decisions?: Array<Record<string, any>>,
    options?: { explicitComplianceErase?: boolean }
): MutationStreamAuditResult;

export declare function buildQwenRerankerPrompt(
    query: string,
    passage: string,
    options?: { instruction?: string; system?: string }
): { system: string; user: string };

export declare function shouldNarrowCandidateSubSpan(options?: {
    allowSubSpanNarrowing?: boolean;
    domain?: string;
}): boolean;

export declare function scoreDeterministicCrossEncoder(
    query: string,
    passage: string,
    denseScore?: number,
    options?: { domain?: string }
): number;

export declare function rerankCandidateWindows(
    query: string,
    candidates?: Array<{ windowId: string; text: string; denseScore?: number; [key: string]: any }>,
    options?: {
        topK?: number;
        domain?: string;
        offline?: boolean;
        rerankerFn?: (query: string, candidate: any) => Promise<any> | any;
        endpoint?: string;
        rerankerModel?: string;
        timeoutMs?: number;
        fetchImpl?: typeof fetch;
    }
): Promise<RerankedWindow[]>;

export declare function assembleReaderEvidence(
    selectedWindows?: Array<Record<string, any>>,
    turns?: Array<ConversationTurnInput | SerializedConversationTurn | string>,
    options?: {
        maxEvidenceTokens?: number;
        turnExpansion?: boolean;
        deduplicateTurns?: boolean;
        chronologicalOrder?: boolean;
    }
): AssembledReaderEvidence;

export declare function evaluateCoverageAndUtilization(
    records?: Array<{ covered: boolean; accurate: number | boolean }>
): {
    totalQuestions: number;
    coveredCount: number;
    coverage: number;
    utilization: number;
    coveredContribution: number;
    uncoveredResidual: number;
    overallAccuracy: number;
    decompositionError: number;
};

export declare function evaluateConditionalPathRetention(
    records?: Array<{ hasResult: boolean; hasPath: boolean }>
): {
    totalQuestions: number;
    resultCount: number;
    jointPathAndResultCount: number;
    resultCoverage: number;
    pathCoverage: number;
    conditionalPathGivenResult: number;
};

export declare function createRawRagIndex(options?: RawRagIndexOptions): RawRagIndex;
