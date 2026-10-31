import type { LlmConfig, LlmChatOptions } from './llm.js';

// ============================================================================
// 1. ast.js — AST Symbol & Import Extraction
// ============================================================================
export interface ExtractedSymbolsResult {
    symbols: Array<Record<string, any>>;
    imports: Array<Record<string, any>>;
    [key: string]: any;
}

export declare function extractSymbolsAndImports(
    content: string,
    filePath?: string
): ExtractedSymbolsResult;

// ============================================================================
// 2. browser.js — Stealth Puppeteer & Gemini 4 Argon Visual Audit Bridge
// ============================================================================
export interface ResponsiveBreakpoint {
    name: string;
    width: number;
    height: number;
}

export declare const DEFAULT_RESPONSIVE_BREAKPOINTS: readonly ResponsiveBreakpoint[];

export declare function launchBrowser(options?: Record<string, any>): Promise<any>;

export declare function scrapeHtml(
    url: string,
    options?: Record<string, any>
): Promise<string>;

export declare function captureScreenshot(
    url: string,
    outputPath: string,
    options?: Record<string, any>
): Promise<string>;

export declare function runInteractiveSession(
    url: string,
    steps: ReadonlyArray<Record<string, any>>,
    options?: Record<string, any>
): Promise<Record<string, any>>;

export declare function captureResponsiveBreakpoints(
    url: string,
    outputDir?: string,
    options?: Record<string, any>
): Promise<Record<string, any>>;

export declare function auditPageWithArgon(
    url: string,
    options?: Record<string, any>
): Promise<Record<string, any>>;

// ============================================================================
// 3. calculator.js — Deterministic Trade & Margin Calculation Primitives
// ============================================================================
export interface DualPricingResult {
    contractorCost: number;
    customerPrice: number;
    profit: number;
    marginPct: number;
}

export interface ConfidenceFactorRange {
    low: number;
    mid: number;
    high: number;
}

export interface ConfidenceEnvelopeResult<TResult = number> {
    low: TResult;
    mid: TResult;
    high: TResult;
}

export declare function applyWaste(baseQty: number, wastePct: number): number;
export declare function round2(val: number): number;
export declare function contractorCost(materialCost: number, laborCost: number): number;
export declare function customerPrice(cost: number, markupPct: number): number;
export declare function calcDualPricing(contractorCostVal: number, markupPct: number): DualPricingResult;
export declare function findCatalogPrice(
    catalog: ReadonlyArray<Record<string, any>>,
    itemType: string,
    descSubstring?: string | null
): Record<string, any> | null;
export declare function confidenceEnvelope<TResult = number>(
    calcFn: (factors: Record<string, number>) => TResult,
    factors: Record<string, ConfidenceFactorRange | number>
): ConfidenceEnvelopeResult<TResult>;

// ============================================================================
// 4. dbos.js — DBOS Swarm & Queue Client
// ============================================================================
export interface DbosJobParams {
    task: string;
    instructions?: string;
    jobType?: string;
    targetNode?: string;
    timeoutMs?: number;
    meta?: Record<string, any>;
}

export declare class DbosClient {
    constructor(pool: any);
    close(): Promise<void>;
    enqueueJob(params: DbosJobParams): Promise<any>;
    dispatchJob(params: DbosJobParams): Promise<any>;
    getJobStatus(jobId: string | number): Promise<any>;
    healQueue(options?: { appTimeoutMs?: number }): Promise<any>;
    healSystemWorkflows(sysConnectionString: string): Promise<any>;
}

export declare function createDbosClient(connectionString: string): DbosClient;

// ============================================================================
// 5. decide.js — Sovereign System 1 Decision Primitive (Single-Token Logprob Router)
// ============================================================================
export interface DecideOptions {
    state?: unknown;
    question: string;
    choices?: readonly string[];
    provider?: string;
    model?: string;
    host?: string;
    confidenceThreshold?: number;
    escalateFn?: ((ctx: Record<string, any>) => Promise<any> | any) | null;
    deterministicFallback?: boolean;
    timeoutMs?: number;
    [key: string]: any;
}

export interface DecideResult {
    choice: string;
    confidence: number;
    probabilities: Record<string, number>;
    escalated?: boolean;
    margin?: number;
    source?: string;
    [key: string]: any;
}

export declare function calibrateChoiceLogprobs(
    topLogprobs?: ReadonlyArray<Record<string, any>>,
    choices?: readonly string[]
): {
    choice: string | null;
    confidence: number;
    probabilities: Record<string, number>;
    margin: number;
    rawLogprobs: Record<string, number>;
    [key: string]: any;
};

export declare function evaluateDeterministicDecision(
    state: unknown,
    question: string,
    choices?: readonly string[]
): DecideResult;

export declare function decide(options: DecideOptions): Promise<DecideResult>;

export declare function decideBatch(options?: {
    state?: unknown;
    questions?: ReadonlyArray<string | Record<string, any>>;
    [key: string]: any;
}): Promise<DecideResult[]>;

export declare function createSystem1Decider(defaultConfig?: Record<string, any>): {
    decide: (options: DecideOptions) => Promise<DecideResult>;
    decideBatch: (options?: Record<string, any>) => Promise<DecideResult[]>;
    calibrateChoiceLogprobs: typeof calibrateChoiceLogprobs;
    evaluateDeterministicDecision: typeof evaluateDeterministicDecision;
    [key: string]: any;
};

// ============================================================================
// 6. dhd-deliberation.js — Diverse Hypothesis Deliberation & Trajectory Value
// ============================================================================
export declare function extractTrajectoryValue(
    candidates?: ReadonlyArray<Record<string, any>>
): Record<string, any>;

export declare function evaluateDHDConsensus(
    candidates?: ReadonlyArray<Record<string, any>>,
    options?: Record<string, any>
): Promise<Record<string, any>>;

// ============================================================================
// 7. evaluator.js — Plausibility, Pairwise & Direct LLM-as-a-Judge Evaluators
// ============================================================================
export declare function evaluatePlausibility(
    sourceContext: string,
    generatedOutput: string,
    config?: LlmConfig,
    options?: LlmChatOptions
): Promise<Record<string, any>>;

export declare function evaluatePairwise(
    prompt: string,
    responseA: string,
    responseB: string,
    criteria: string,
    config?: LlmConfig,
    options?: LlmChatOptions
): Promise<Record<string, any>>;

export declare function evaluateDirect(
    prompt: string,
    response: string,
    criterion: string,
    maxScore: number,
    config?: LlmConfig,
    options?: LlmChatOptions
): Promise<Record<string, any>>;

// ============================================================================
// 8. evqa-grounding.js — Evidence-Backed Video Question Answering
// ============================================================================
export declare class VideoEvidenceSegment {
    constructor(params: Record<string, any>);
    [key: string]: any;
}

export declare class EvidenceGroundingEngine {
    constructor(propertyId?: string);
    indexEvidence(segment: VideoEvidenceSegment | Record<string, any>): VideoEvidenceSegment;
    bulkIndex(segments: ReadonlyArray<VideoEvidenceSegment | Record<string, any>>): number;
    findEvidence(filter?: {
        entities?: string[];
        queryText?: string;
        sourceClip?: string | null;
    }): VideoEvidenceSegment[];
    formatGroundedAnswer(
        answerText: string,
        evidenceList?: ReadonlyArray<VideoEvidenceSegment | Record<string, any>>
    ): Record<string, any>;
    toJSON(): Record<string, any>;
    static fromJSON(json: string | Record<string, any>): EvidenceGroundingEngine;
}

// ============================================================================
// 9. harness-engineering.js — 7-Subsystem Coding-Agent Harness Primitives
// ============================================================================
export declare const HARNESS_SUBSYSTEMS: ReadonlyArray<Record<string, any>>;
export declare const HARDLINE_POLICY_RULES: ReadonlyArray<Record<string, any>>;

export declare function deobfuscateShellCommand(command: string): Record<string, any>;
export declare function validatePolicyRuleExamples(
    rules?: ReadonlyArray<Record<string, any>>
): Record<string, any>;
export declare function createFrozenPolicyFloor(options?: Record<string, any>): Record<string, any>;
export declare function delimitUntrustedContent(
    content: string,
    options?: Record<string, any>
): Record<string, any>;
export declare function evaluateTruncationPoisoningGuard(
    turnResponse?: Record<string, any>
): Record<string, any>;
export declare function evaluateVerifyOnStopGuard(
    turnState?: Record<string, any>
): Record<string, any>;
export declare function normalizePromptCachePrefix(
    messages?: ReadonlyArray<Record<string, any>>,
    options?: Record<string, any>
): Record<string, any>;
export declare function createDeferredToolBridge(
    tools?: ReadonlyArray<Record<string, any>>,
    options?: Record<string, any>
): Record<string, any>;

// ============================================================================
// 10. hydra-action-flow.js — Hydra-0 Action Flow World Modeling
// ============================================================================
export declare class ActionFlowVector {
    constructor(params: {
        x: number;
        y: number;
        dx: number;
        dy: number;
        dz?: number;
        t?: number;
        actionType?: string;
        confidence?: number;
    });
    [key: string]: any;
}

export declare class ActionFlowSequence {
    constructor(sequenceId?: string);
    addVector(vec: ActionFlowVector | Record<string, any>): ActionFlowVector;
    addVectors(vecs: ReadonlyArray<ActionFlowVector | Record<string, any>>): number;
    getTotalDisplacement(): Record<string, number>;
    getVectorsAtTime(t: number): ActionFlowVector[];
    [key: string]: any;
}

export declare class HydraWorldModelEngine {
    constructor(options?: Record<string, any>);
    predictForward(
        initialState: Record<string, any>,
        actionFlow: ActionFlowSequence | Record<string, any>
    ): Record<string, any>;
    extractInverseActionFlow(demonstration: Record<string, any>): ActionFlowSequence;
    [key: string]: any;
}

export declare function createHydraEngine(options?: Record<string, any>): HydraWorldModelEngine;

// ============================================================================
// 11. imagen.js — Image Generation Client
// ============================================================================
export declare function createImageGenerator(config?: Record<string, any>): Record<string, any>;

// ============================================================================
// 12. json-parse.js — Resilient AI JSON Extraction & Safe Parsing
// ============================================================================
export declare function parseAIJson<TResult = any>(
    text: string,
    options?: Record<string, any>
): TResult;

export declare function safeParseJson<TResult = any>(
    text: string,
    fallback?: TResult
): TResult;

// ============================================================================
// 13. kv-cache-manager.js — Persistent Q4 KV Cache & GVA Footprint Manager
// ============================================================================
export declare function calculateKvCacheMetrics(
    contextTokens: number,
    layers?: number,
    heads?: number,
    headDim?: number
): Record<string, any>;

export declare function calculateGvaFootprint(
    contextTokens: number,
    layers?: number,
    heads?: number,
    headDim?: number,
    kvHeads?: number
): Record<string, any>;

export declare function createGvaAllocator(options?: Record<string, any>): Record<string, any>;
export declare function createKvCacheManager(options?: Record<string, any>): Record<string, any>;

// ============================================================================
// 14. matterport-importer.js — Matterport Spatial Importer & Digital Twin Fusion
// ============================================================================
export declare class MatterportSweepStation {
    constructor(params: {
        sweepId: string;
        label: string;
        position: number[] | Record<string, number>;
        rotation?: number[];
        panoramaUrl?: string | null;
        room?: string;
    });
    [key: string]: any;
}

export declare class MatterportMeshMetadata {
    constructor(params: {
        modelId: string;
        address?: string;
        vertexCount?: number;
        faceCount?: number;
        unit?: string;
    });
    addSweep(sweep: MatterportSweepStation | Record<string, any>): void;
    [key: string]: any;
}

export declare class MatterportImporter {
    constructor(options?: Record<string, any>);
    parseSweepGraph(sweepData: Record<string, any>): MatterportMeshMetadata;
    fuseWithSpatialGraph(
        matterportMeta: MatterportMeshMetadata,
        spatialGraph: SpatialKnowledgeGraph
    ): Record<string, any>;
    createPassportBundle(params: {
        modelId: string;
        propertyAddress?: string;
        sweeps?: ReadonlyArray<Record<string, any>>;
        actionFlows?: Record<string, any>;
    }): Record<string, any>;
    [key: string]: any;
}

export declare function createMatterportImporter(options?: Record<string, any>): MatterportImporter;

// ============================================================================
// 15. memory-invalidation.js — Memory Lineage & SHA-256 Artifact Drift Graph
// ============================================================================
export declare function filterActiveMemories(
    memories?: ReadonlyArray<Record<string, any>>,
    options?: Record<string, any>
): Array<Record<string, any>>;

export declare function supersedeMemoryRecord(
    oldRecord: Record<string, any>,
    newRecordData: Record<string, any>,
    reason?: string
): { supersededOld: Record<string, any>; activeNew: Record<string, any>; [key: string]: any };

export declare function buildMemoryLineage(
    memories: ReadonlyArray<Record<string, any>> | undefined,
    memoryId: string
): Array<Record<string, any>>;

export declare class MemoryInvalidationEngine {
    constructor(initialMemories?: ReadonlyArray<Record<string, any>>);
    addMemory(memory: Record<string, any>): Record<string, any>;
    invalidateMemory(memoryId: string, reason?: string): boolean;
    getActiveMemories(filter?: Record<string, any>): Array<Record<string, any>>;
    getLineage(memoryId: string): Array<Record<string, any>>;
    detectContradictions(newFactText: string, llmConfig?: LlmConfig): Promise<Record<string, any>>;
}

export declare function computeArtifactHash(content?: string): string;

export declare class ArtifactVerificationGraph {
    constructor();
    anchorClaim(claim: Record<string, any>): Record<string, any>;
    checkArtifactDrift(currentFiles?: ReadonlyArray<Record<string, any>>): Record<string, any>;
    invalidateDriftedClaims(currentFiles?: ReadonlyArray<Record<string, any>>): Record<string, any>;
    getValidClaims(): Array<Record<string, any>>;
}

export declare function anchorVerificationClaim(
    graph: ArtifactVerificationGraph,
    claim: Record<string, any>
): Record<string, any>;

export declare function checkArtifactDrift(
    claims?: ReadonlyArray<Record<string, any>>,
    currentFiles?: ReadonlyArray<Record<string, any>>
): Record<string, any>;

// ============================================================================
// 16. modular-rsi.js — Modular Recursive Harness Self-Improvement
// ============================================================================
export declare const RSI_MODULES: Readonly<Record<string, string>>;
export declare const DEFAULT_HARNESS_SPECS: Readonly<Record<string, any>>;

export declare function createModularRsiHarness(
    initialSpecs?: Record<string, any>
): Record<string, any>;

// ============================================================================
// 17. physcap-policy.js — Physics-Informed Spatial Grounding & Code-as-Policy
// ============================================================================
export declare const PHYSICAL_CODES_AND_LIMITS: Readonly<Record<string, any>>;

export declare class PhysicsConstraintEvaluator {
    static evaluateDrainSlope(pipeRoute: {
        runLengthFt: number;
        verticalDropInches: number;
        pipeDiameterInches?: number;
    }): {
        compliant: boolean;
        actualSlope: number;
        minRequiredSlope: number;
        violation: string | null;
    };
    static evaluateStructuralPenetration(penetration: {
        joistDepthInches: number;
        holeDiameterInches: number;
        edgeDistanceInches: number;
    }): {
        compliant: boolean;
        maxAllowedHole: number;
        minAllowedEdge: number;
        violation: string | null;
    };
    static evaluateCircuitWireGauge(circuit: {
        wireGauge: string | number;
        breakerAmps: number;
    }): {
        compliant: boolean;
        maxAmps: number;
        violation: string | null;
    };
}

export declare class PhysCaPPolicyGenerator {
    robotId: string;
    enforceStrictPhysics: boolean;
    constructor(options?: { robotId?: string; enforceStrictPhysics?: boolean });
    generatePolicy(
        taskIntent: string,
        spatialContext: Record<string, any>
    ): {
        taskIntent: string;
        policyScript: string;
        validations: Array<Record<string, any>>;
        isSafeToExecute: boolean;
        violations: Array<string | null>;
    };
}

export declare function createPhysCaPGenerator(options?: {
    robotId?: string;
    enforceStrictPhysics?: boolean;
}): PhysCaPPolicyGenerator;

// ============================================================================
// 18. polygres.js — Polygres Unified Relational, Graph & Vector Client
// ============================================================================
export declare class PolygresClient {
    constructor(options?: Record<string, any>);
    query(sql: string, params?: unknown[]): Promise<any>;
    initializeSchema(): Promise<any>;
    syncSpatialGraph(
        graph: SpatialKnowledgeGraph,
        projectMetadata?: Record<string, any>
    ): Promise<any>;
    syncEvidenceIndex(evqa: EvidenceGroundingEngine): Promise<any>;
    loadSpatialGraph(projectId: string): Promise<SpatialKnowledgeGraph>;
    loadEvidenceEngine(projectId: string): Promise<EvidenceGroundingEngine>;
    getUsage(): Promise<any>;
    getEmbeddingModels(): Promise<any>;
    getCapabilities(): Promise<any>;
    listEmbeddingConfigs(): Promise<any>;
    createEmbeddingConfig(config: Record<string, any>, idempotencyKey?: string | null): Promise<any>;
    contextSearch(collectionName: string, options?: Record<string, any>): Promise<any>;
    graphExpand(nodeId: string, options?: Record<string, any>): Promise<any>;
    close(): Promise<void>;
}

export declare function createPolygresClient(options?: Record<string, any>): PolygresClient;

// ============================================================================
// 19. prune.js — Stage-Aware Context Pruning & Knowledge Boundary Routing
// ============================================================================
export declare function prunePreRetrieval(
    query: string,
    history?: ReadonlyArray<Record<string, any>>,
    options?: Record<string, any>
): Record<string, any>;

export declare function prunePostRetrieval(
    chunks?: ReadonlyArray<Record<string, any> | string>,
    query?: string,
    options?: Record<string, any>
): Record<string, any>;

export declare function prunePreSynthesis(
    documents: ReadonlyArray<Record<string, any> | string>,
    options?: Record<string, any>
): Record<string, any>;

export declare function shouldActivateMemory(
    query?: string,
    options?: Record<string, any>
): { activate: boolean; reason: string; confidence?: number; [key: string]: any };

export declare function createKnowledgeBoundaryRouter(
    config?: Record<string, any>
): Record<string, any>;

export declare function createContextPruner(config?: Record<string, any>): Record<string, any>;

// ============================================================================
// 20. scheduler.js — In-Process Task Scheduler
// ============================================================================
export declare function createScheduler(): Record<string, any>;

// ============================================================================
// 21. second-thought.js — Parallel Auxiliary Reasoning During Tool Execution
// ============================================================================
export declare function createSecondThoughtEngine(
    options?: Record<string, any>
): Record<string, any>;

// ============================================================================
// 22. skill-state.js — SKILL.state Bounded Long-Horizon Execution State Manager
// ============================================================================
export interface SkillStateSavingsResult {
    appendOnlyTokens: number;
    skillStateTokens: number;
    tokensSaved: number;
    savingsRatio: number;
}

export declare function calculateSkillStateSavings(
    stepCount: number,
    avgReasoningTokens?: number,
    avgObservationTokens?: number,
    stateSizeTokens?: number,
    skillSpecTokens?: number
): SkillStateSavingsResult;

export declare function createSkillStateManager(options?: {
    skillSpec: string;
    initialState?: Record<string, any>;
    stateValidator?: ((state: Record<string, any>) => boolean | Record<string, any>) | null;
    maxSnapshots?: number;
}): Record<string, any>;

// ============================================================================
// 23. skiller.js — SKILLER Trajectory Extraction & Skill Routing
// ============================================================================
export declare function extractSkillFromTrajectory(params: {
    taskName: string;
    trajectory: ReadonlyArray<Record<string, any>> | string;
    teacherLlmConfig?: LlmConfig;
    targetPersona?: string;
}): Promise<Record<string, any>>;

export declare function evaluateSkillTransfer(params: {
    skillMarkdown: string;
    taskPrompt: string;
    executorLlmConfig?: LlmConfig;
    evaluatorFn?: (output: any) => Promise<any> | any;
}): Promise<Record<string, any>>;

export declare function stageSkillForMonorepo(
    skillName: string,
    skillMarkdown: string,
    targetDir?: string
): Promise<Record<string, any>>;

export declare function createExecutableSkillContract(
    skillMarkdown: string,
    validationHarnessCode?: string
): Record<string, any>;

export declare function routeDiverseSkills(
    query: string,
    availableSkills?: ReadonlyArray<Record<string, any>>,
    options?: Record<string, any>
): Record<string, any>;

// ============================================================================
// 24. skillopt.js — SkillOpt-Lite Text-Space Skill Optimization
// ============================================================================
export declare function applySkillPatch(
    filePath: string,
    edits: ReadonlyArray<Record<string, any>>
): Promise<Record<string, any>>;

export declare function proposeSkillEdits(
    trajectories: ReadonlyArray<Record<string, any>>,
    currentSkill: string,
    budget: number,
    config?: LlmConfig,
    options?: LlmChatOptions
): Promise<Record<string, any>>;

export declare function runValidationGate(
    filePath: string,
    candidateSkillContent: string,
    selectionTasks: ReadonlyArray<Record<string, any>>,
    runTaskCallback: (task: any, skillContent: string) => Promise<any> | any
): Promise<Record<string, any>>;

// ============================================================================
// 25. sparse-pr.js — SparsePR Block-Sparse Video Attention & Partitioning
// ============================================================================
export declare class VideoTokenBlock {
    constructor(params: {
        blockId: string;
        frameIndex: number;
        spatialCoords: number[] | Record<string, number>;
        embedding: number[];
        salienceScore?: number;
        type?: string;
    });
    [key: string]: any;
}

export declare class SparsePROptimizer {
    constructor(options?: Record<string, any>);
    partitionSupport(
        blocks: ReadonlyArray<VideoTokenBlock>,
        queryVector: readonly number[]
    ): Record<string, any>;
    reconstructResidual(sparseResidual: Record<string, any>, embeddingDim?: number): any;
    executePipeline(
        tokenBlocks: ReadonlyArray<VideoTokenBlock>,
        queryEmbedding: readonly number[]
    ): Record<string, any>;
}

export declare function createSparsePROptimizer(options?: Record<string, any>): SparsePROptimizer;

// ============================================================================
// 26. spatial-kg.js — Hierarchical Spatial Knowledge Graph
// ============================================================================
export declare class SpatialNode {
    constructor(params: {
        id: string;
        name: string;
        type: string;
        zone?: string | null;
        specs?: Record<string, any>;
        location?: Record<string, any>;
        visualEvidence?: any;
    });
    [key: string]: any;
}

export declare class InfrastructureEdge {
    constructor(params: {
        sourceId: string;
        targetId: string;
        relation: string;
        properties?: Record<string, any>;
        visualEvidence?: any;
    });
    [key: string]: any;
}

export declare class SpatialKnowledgeGraph {
    constructor(propertyId?: string);
    addNode(nodeData: SpatialNode | Record<string, any>): SpatialNode;
    getNode(id: string): SpatialNode | undefined;
    addEdge(edgeData: InfrastructureEdge | Record<string, any>): InfrastructureEdge;
    traceUpstream(targetNodeId: string, relationType?: string | null): SpatialNode[];
    traceDownstream(startNodeId: string, relationType?: string): SpatialNode[];
    findNodesByZone(zone: string): SpatialNode[];
    findNodesByMaterial(material: string): SpatialNode[];
    toTriplets(): Array<Record<string, any>>;
    toJSON(): Record<string, any>;
}

// ============================================================================
// 27. spec-verifier.js — Spec-First Convergence & Referee Audit Engine
// ============================================================================
export declare function checkConvergence(
    auditHistory?: ReadonlyArray<Record<string, any>>,
    requiredZeroPasses?: number
): { converged: boolean; consecutiveZeroPasses: number; [key: string]: any };

export declare function evaluateRefereeConsensus(
    auditorFindings?: ReadonlyArray<Record<string, any>>,
    refereeFindings?: ReadonlyArray<Record<string, any>>
): Record<string, any>;

export declare function runAuditPass(params: {
    specText: string;
    files: ReadonlyArray<Record<string, any>> | Record<string, string>;
    llmConfig?: LlmConfig;
    passNumber?: number;
}): Promise<Record<string, any>>;

export declare function runRefereeAuditPass(params: {
    specText: string;
    files: ReadonlyArray<Record<string, any>> | Record<string, string>;
    llmConfig?: LlmConfig;
    passNumber?: number;
}): Promise<Record<string, any>>;

export declare function createSpecAuditRunner(options?: Record<string, any>): Record<string, any>;

export declare function synthesizeExecutableContract(params: {
    specText: string;
    targetModule: string;
    llmConfig?: LlmConfig;
    testFramework?: string;
}): Promise<Record<string, any>>;

export declare function evaluateDualTrackRefinement(params: {
    specText: string;
    testCode: string;
    implementationCode: string;
    executionLogs?: string;
    llmConfig?: LlmConfig;
}): Promise<Record<string, any>>;

// ============================================================================
// 28. tracing.js — Span Telemetry Primitives
// ============================================================================
export declare function startSpan(
    spanType: string,
    name: string,
    parentContext?: Record<string, any> | null
): Record<string, any>;

export declare function endSpan(
    span: Record<string, any>,
    attributes?: Record<string, any>,
    error?: Error | unknown | null
): Record<string, any>;

// ============================================================================
// 29. trajectory-guard.js — Trajectory Guard, Mind-Virus Shield & PIG Engine
// ============================================================================
export declare function createTrajectoryGuard(options?: Record<string, any>): Record<string, any>;

export declare function sanitizeAgentMessage(
    message: string,
    options?: Record<string, any>
): { cleanMessage: string; threatsDetected: string[]; blocked: boolean; [key: string]: any };

export declare function checkGoalDrift(
    originalGoal?: string,
    currentThoughtOrPlan?: string,
    options?: Record<string, any>
): Record<string, any>;

export declare function scoreTrajectoryProgress(
    history?: ReadonlyArray<Record<string, any>>,
    goal?: string
): Record<string, any>;

export declare function evaluateFutileReasoning(
    trajectory: ReadonlyArray<Record<string, any>>,
    llmConfig?: LlmConfig
): Promise<Record<string, any>>;

export declare function calculateIntelligenceEntropy(params?: {
    t?: number;
    s0?: number;
    alpha?: number;
}): Record<string, any>;

export declare function createPigEngine(options?: Record<string, any>): Record<string, any>;

export declare function evaluateMultiAgentResilience(
    handoffs?: ReadonlyArray<Record<string, any>>,
    options?: Record<string, any>
): Record<string, any>;

// ============================================================================
// 30. vision.js — Multimodal Gemini 4 Argon Media Client
// ============================================================================
export declare function callGeminiMedia(
    prompt: string,
    base64Data: string,
    mimeType?: string,
    config?: LlmConfig
): Promise<string>;

export declare function callGeminiMediaJson<TResult = any>(
    prompt: string,
    base64Data: string,
    mimeType?: string,
    config?: LlmConfig
): Promise<TResult>;

// ============================================================================
// 31. vld-scaling.js — Virtual Logical Depth (VLD) Scaling & Fixed-Point Engine
// ============================================================================
export declare const VLD_PATTERNS: Readonly<Record<string, string>>;
export declare const DEFAULT_VOCAB_SIZE: number;
export declare const THEORETICAL_BITS_PER_PARAM: number;
export declare const DEFAULT_ID_OP_CEILING: number;

export declare function compileVldSchedule(
    baseLayers: number,
    options?: Record<string, any>
): Record<string, any>;

export declare function calculateKnowledgeCapacityEntropy(
    params?: Record<string, any>
): Record<string, any>;

export declare function verifyVldCapacityInvariance(
    baselineAbsorbedBits: number,
    vldAbsorbedBitsList?: readonly number[],
    maxRelativeDrift?: number
): Record<string, any>;

export declare function estimateReasoningDepth(
    taskInput: string | Record<string, any>,
    options?: Record<string, any>
): Record<string, any>;

export declare function detectVldFixedPoint(
    depthHistory?: readonly number[],
    options?: Record<string, any>
): Record<string, any>;

export declare function createVldScalingEngine(
    config?: Record<string, any>
): Record<string, any>;
