/**
 * @krusch/toolkit — Root Barrel TypeScript Declarations (`INV-LEGO-11`)
 *
 * Re-exports every symbol exported by `lib/index.js` plus the Wave-2
 * `edge`, `webhooks`, and `cli` runtime bricks, with `.js` relative specifiers
 * for strict `moduleResolution: "NodeNext"` compatibility.
 */

// Shared Envelopes (INV-LEGO-01)
export type {
    OkEnvelope,
    ErrorDetail,
    ErrorEnvelope,
    LegoEnvelope
} from './envelopes.js';

// LLM Client
export {
    chat,
    chatJson,
    resolveModelConfig,
    isGemini4Model,
    normalizeThinkingLevel,
    resolveMaxOutputTokens,
    resolveGeminiToolConfig,
    buildGeminiPayload,
    extractGeminiTextParts
} from './llm.js';
export type {
    LLMProvider,
    ThinkingLevel,
    LLMChatMessage,
    LLMConfig,
    LlmConfig,
    ChatOptions,
    LlmChatOptions,
    ChatFullResponse,
    ResolvedModelConfig
} from './llm.js';

// JSON Parsing
export { parseAIJson, safeParseJson } from './json-parse.js';

// Configuration
export {
    loadJsonConfig,
    createConfig,
    loadProjectConfig,
    envOr,
    envInt,
    envBool,
    validateRequired
} from './config.js';
export type { CreateConfigOptions } from './config.js';

// SQLite Database (Singleton WAL + Crash Recovery)
export {
    initDb,
    getDb,
    run,
    query,
    queryOne,
    exec,
    transaction,
    prepare,
    closeDb
} from './db.js';
export type {
    SqliteRunResult,
    SqliteStatement,
    SqliteDatabaseInstance,
    InitDbOptions
} from './db.js';

// Image Generation
export { createImageGenerator } from './imagen.js';

// Scheduling
export { createScheduler } from './scheduler.js';

// Authentication
export { createAuth } from './auth.js';
export type { AuthConfig, AuthUser, AuthHelper } from './auth.js';

// SkillOpt-Lite Text-Space Optimization
export { applySkillPatch, proposeSkillEdits, runValidationGate } from './skillopt.js';

// Browser Automation & Chrome + Gemini 4 Argon Visual Audit Bridge
export {
    scrapeHtml,
    captureScreenshot,
    runInteractiveSession,
    launchBrowser,
    DEFAULT_RESPONSIVE_BREAKPOINTS,
    captureResponsiveBreakpoints,
    auditPageWithArgon
} from './browser.js';
export type { ResponsiveBreakpoint } from './browser.js';

// Multimodal Vision (Gemini 4 Argon ready)
export { callGeminiMedia, callGeminiMediaJson } from './vision.js';

// DBOS Swarm & Queue client
export { createDbosClient, DbosClient } from './dbos.js';
export type { DbosJobParams } from './dbos.js';

// Structured JSON Logger
export { setupLogging } from './log.js';
export type { SetupLoggingOptions, Logger } from './log.js';

// Scaffolder templates
export { scaffoldProject } from './scaffold.js';
export type { ScaffoldProjectOptions, ScaffoldProjectResultData } from './scaffold.js';

// Calculation Utilities
export {
    applyWaste,
    round2,
    contractorCost,
    customerPrice,
    calcDualPricing,
    findCatalogPrice,
    confidenceEnvelope
} from './calculator.js';
export type {
    DualPricingResult,
    ConfidenceFactorRange,
    ConfidenceEnvelopeResult
} from './calculator.js';

// Stage-Aware Context Pruning & Knowledge Boundary Routing
export {
    prunePreRetrieval,
    prunePostRetrieval,
    prunePreSynthesis,
    createContextPruner,
    shouldActivateMemory,
    createKnowledgeBoundaryRouter
} from './prune.js';

// Specification-First Convergence & Test-Driven Reasoning Engine
export {
    checkConvergence,
    runAuditPass,
    runRefereeAuditPass,
    evaluateRefereeConsensus,
    createSpecAuditRunner,
    DEFAULT_THREE_FAMILY_REFEREE_POOL,
    runThreeFamilyRefereeAudit,
    synthesizeExecutableContract,
    evaluateDualTrackRefinement
} from './spec-verifier.js';

// Knowledge Invalidation & Artifact-Anchored Verification EA-Graph
export {
    MemoryInvalidationEngine,
    filterActiveMemories,
    supersedeMemoryRecord,
    buildMemoryLineage,
    ArtifactVerificationGraph,
    anchorVerificationClaim,
    checkArtifactDrift,
    computeArtifactHash
} from './memory-invalidation.js';

// SKILLER & Executable Code Knowledge
export {
    extractSkillFromTrajectory,
    evaluateSkillTransfer,
    stageSkillForMonorepo,
    createExecutableSkillContract,
    routeDiverseSkills
} from './skiller.js';

// Trajectory Guard, Multi-Agent Mind Virus Shield & PIG Engine
export {
    createTrajectoryGuard,
    scoreTrajectoryProgress,
    evaluateFutileReasoning,
    sanitizeAgentMessage,
    checkGoalDrift,
    calculateIntelligenceEntropy,
    createPigEngine,
    evaluateMultiAgentResilience
} from './trajectory-guard.js';

// Hierarchical Spatial Knowledge Graph
export { SpatialKnowledgeGraph, SpatialNode, InfrastructureEdge } from './spatial-kg.js';

// Evidence-Backed Video Question Answering
export { EvidenceGroundingEngine, VideoEvidenceSegment } from './evqa-grounding.js';

// Polygres Unified Relational, Graph & Vector Client
export { PolygresClient, createPolygresClient } from './polygres.js';

// Hydra-0: Action Flow for Generalist World Modeling & Control
export {
    HydraWorldModelEngine,
    ActionFlowVector,
    ActionFlowSequence,
    createHydraEngine
} from './hydra-action-flow.js';

// SparsePR: Training-Free Block-Sparse Video Attention & Partitioning
export {
    SparsePROptimizer,
    VideoTokenBlock,
    createSparsePROptimizer
} from './sparse-pr.js';

// PhysCaP: Physics-Informed Spatial Grounding & Code-as-Policy
export {
    PhysicsConstraintEvaluator,
    PhysCaPPolicyGenerator,
    PHYSICAL_CODES_AND_LIMITS,
    createPhysCaPGenerator
} from './physcap-policy.js';

// Matterport Spatial Importer & Digital Twin Fusion Engine
export {
    MatterportImporter,
    MatterportSweepStation,
    MatterportMeshMetadata,
    createMatterportImporter
} from './matterport-importer.js';

// SKILL.state: Scalable Long-Horizon Agent Skills & Bounded State Manager
export { createSkillStateManager, calculateSkillStateSavings } from './skill-state.js';
export type { SkillStateSavingsResult } from './skill-state.js';

// Second Thought: Parallel Auxiliary Reasoning during Tool Execution
export { createSecondThoughtEngine } from './second-thought.js';

// Persistent Q4 KV Cache Manager & Policy-Driven Runtime Layer
export {
    createKvCacheManager,
    calculateKvCacheMetrics,
    calculateGvaFootprint,
    createGvaAllocator
} from './kv-cache-manager.js';

// Diverse Hypothesis Deliberation (DHD) & Trajectory Value Engine
export { extractTrajectoryValue, evaluateDHDConsensus } from './dhd-deliberation.js';

// ModularRSI: Modular and Generalizable Recursive Harness Self-Improvement
export {
    createModularRsiHarness,
    RSI_MODULES,
    DEFAULT_HARNESS_SPECS
} from './modular-rsi.js';

// Sovereign System 1 Decision Primitive (Single-Token Logit / Logprob Router)
export {
    decide,
    decideBatch,
    calibrateChoiceLogprobs,
    evaluateDeterministicDecision,
    createSystem1Decider
} from './decide.js';
export type { DecideOptions, DecideResult } from './decide.js';

// Beyond Parameters: Virtual Logical Depth (VLD) Scaling Laws & Fixed-Point Engine
export {
    VLD_PATTERNS,
    compileVldSchedule,
    calculateKnowledgeCapacityEntropy,
    verifyVldCapacityInvariance,
    estimateReasoningDepth,
    detectVldFixedPoint,
    createVldScalingEngine
} from './vld-scaling.js';

// Unified Sovereign Embedding Client (@krusch/toolkit/embeddings)
export {
    DEFAULT_EMBED_HOST,
    DEFAULT_EMBED_MODEL,
    DEFAULT_EMBED_DIMS,
    MODEL_PROFILES,
    resolveEmbeddingProfile,
    formatEmbeddingInput,
    l2Normalize,
    isZeroVector,
    cosineSimilarity,
    calibrateQuerySimilarity,
    calculateCentroid,
    validateVectorDimension,
    generateDeterministicVector,
    chunkTextForEmbedding,
    clearToolkitEmbeddingCache,
    embed,
    embedBatch,
    embedChunkedCentroid,
    createEmbeddings
} from './embeddings.js';
export type {
    EmbeddingModelProfile,
    EmbeddingMode,
    EmbeddingDomain,
    FormatEmbeddingInputOptions,
    EmbedOptions,
    ChunkTextOptions,
    ScopedEmbeddingsClient
} from './embeddings.js';

// Canonical Coding-Agent Harness Engineering Primitives
export {
    HARNESS_SUBSYSTEMS,
    HARDLINE_POLICY_RULES,
    deobfuscateShellCommand,
    validatePolicyRuleExamples,
    createFrozenPolicyFloor,
    delimitUntrustedContent,
    evaluateTruncationPoisoningGuard,
    evaluateVerifyOnStopGuard,
    normalizePromptCachePrefix,
    createDeferredToolBridge
} from './harness-engineering.js';

// Source-Preserving Episodic Retrieval & Append-Only Memory Primitives
export {
    RAW_RAG_DEFAULTS,
    RAG_BASELINE_CONSTRAINTS,
    QWEN_RERANKER_TEMPLATE,
    LEGAL_BOILERPLATE_STOPWORDS,
    tokenizeWithOffsets,
    estimateTokenCount,
    serializeConversationTurn,
    chunkConversationWindows,
    auditRagBaselineConfig,
    normalizeAppendOnlyWriteOp,
    auditMutationStream,
    buildQwenRerankerPrompt,
    scoreDeterministicCrossEncoder,
    shouldNarrowCandidateSubSpan,
    rerankCandidateWindows,
    assembleReaderEvidence,
    evaluateCoverageAndUtilization,
    evaluateConditionalPathRetention,
    createRawRagIndex
} from './raw-rag.js';
export type {
    TokenWithOffset,
    ConversationTurnInput,
    SerializedConversationTurn,
    ConversationWindow,
    RagBaselineFinding,
    RagBaselineAuditResult,
    NormalizedAppendOnlyWriteOp,
    MutationStreamAuditResult,
    RerankedWindow,
    ReaderEvidenceEntry,
    AssembledReaderEvidence,
    RawRagRetrieveResult,
    RawRagIndexOptions,
    RawRagIndex
} from './raw-rag.js';

// Lego Backend HTTP, Bounded Body & Graceful Shutdown Bricks (@krusch/toolkit/http)
export {
    okEnvelope,
    errorEnvelope,
    asyncHandler,
    createCorsHeaders,
    readBoundedJsonBody,
    createExpressBricks,
    createApiServer,
    attachGracefulShutdown
} from './http.js';
export type {
    NextFunction,
    HttpLoggerLike,
    BoundedJsonBodyOptions,
    HealthCheckResult,
    HealthCheckFn,
    ExpressBricksOptions,
    ExpressBricks,
    ApiRouteContext,
    ApiRouteHandler,
    CreateApiServerOptions,
    CleanupFn,
    GracefulShutdownOptions,
    GracefulShutdownHandle,
    ClosableServerLike
} from './http.js';

// Lego Server-Sent Events (SSE) & AbortController Streaming Bricks (@krusch/toolkit/streaming)
export { sseResponse, streamChat } from './streaming.js';
export type {
    SseResponseOptions,
    SseStreamHandle,
    CustomStreamChatFn,
    StreamChatOptions,
    StreamChatResult
} from './streaming.js';

// Lego MCP Server & 4-Boolean Annotation Bricks (@krusch/toolkit/mcp)
export {
    defineMcpTool,
    okMcpResult,
    errorMcpResult,
    validateToolArgs,
    registerMcpHandlers,
    createMcpServer
} from './mcp-server.js';
export type {
    McpToolAnnotations,
    McpInputSchema,
    McpToolInput,
    McpToolDefinition,
    McpTextContent,
    McpToolResult,
    ToolArgsValidationResult,
    McpToolHandler,
    RegisterMcpHandlersOptions,
    CreateMcpServerOptions,
    DisconnectedMcpServerHandle
} from './mcp-server.js';

// Lego PostgreSQL + pgvector Pool, Migrations & Cosine Search Bricks (@krusch/toolkit/pg)
export {
    assertSafePgIdentifier,
    buildPgConnectionString,
    createPgPool,
    runSqlMigrations,
    pgVectorSearch
} from './pg.js';
export type {
    PgConnectionConfig,
    PgQueryResult,
    PgQueryableClient,
    PgPoolOptions,
    PgPoolWrapper,
    SqlMigration,
    PgVectorSearchOptions
} from './pg.js';

// Lego Runtime Catalog, Zero-LLM Archetype Blueprints & Boilerplate Auditor (@krusch/toolkit/catalog)
export {
    RUNTIME_BRICKS,
    PROJECT_ARCHETYPES,
    listLegoBricks,
    getLegoBrick,
    listArchetypes,
    getArchetype,
    auditBoilerplateText,
    scoreLegoBrickCoverage
} from './catalog.js';
export type {
    LegoRuntime,
    LegoBrick,
    ProjectArchetypeRenderOptions,
    ProjectArchetype,
    BoilerplateFinding,
    BoilerplateAuditData,
    LegoCoverageFileEntry,
    ScoreLegoBrickCoverageOptions,
    BoilerplateFileFinding,
    LegoBrickCoverageData
} from './catalog.js';

// Lego Web-Standards Edge Router, SSE & KV Store Bricks (@krusch/toolkit/edge)
export {
    edgeOkEnvelope,
    edgeErrorEnvelope,
    edgeCorsHeaders,
    edgeJsonResponse,
    edgeOkResponse,
    edgeErrorResponse,
    readBoundedEdgeJson,
    edgeSseResponse,
    createEdgeKvJsonStore,
    createEdgeRouter
} from './edge.js';
export type {
    EdgeHeadersInput,
    EdgeJsonResponseOptions,
    EdgeErrorResponseOptions,
    ReadBoundedEdgeJsonOptions,
    ReadBoundedEdgeJsonResult,
    EdgeSseDoneObject,
    EdgeSseErrorObject,
    EdgeSseHandle,
    EdgeSseOptions,
    EdgeKvListKey,
    EdgeKvListResult,
    EdgeKvNamespaceLike,
    CreateEdgeKvJsonStoreOptions,
    EdgeKvPutOptions,
    EdgeKvListOptions,
    EdgeKvJsonStore,
    EdgeHealthCheckContext,
    EdgeHealthCheckFn,
    EdgeRouteContext,
    EdgeRouteHandler,
    EdgeRouteSpec,
    EdgeRouteEntry,
    CreateEdgeRouterOptions,
    EdgeRouter
} from './edge.js';

// Lego Constant-Time Webhook HMAC & Bearer Verification Bricks (@krusch/toolkit/webhooks)
export {
    constantTimeEqual,
    signWebhookHmac,
    verifySlackSignature,
    verifyGithubSignature,
    verifyStripeSignature,
    verifyBearerToken
} from './webhooks.js';
export type {
    WebhookRawBytes,
    SignWebhookHmacOptions,
    VerifySlackSignatureOptions,
    SlackVerifiedData,
    VerifyGithubSignatureOptions,
    GithubVerifiedData,
    VerifyStripeSignatureOptions,
    StripeVerifiedData,
    VerifyBearerTokenOptions,
    BearerVerifiedData
} from './webhooks.js';

// Lego Single-Instance Lockfile, Daemon Signal & CLI Envelope Bricks (@krusch/toolkit/cli)
export {
    withSingleInstanceLock,
    attachDaemonSignals,
    appendJsonlRecord,
    defineCli
} from './cli.js';
export type {
    SingleInstanceLockContext,
    SingleInstanceLockOptions,
    SingleInstanceLockData,
    SingleInstanceLockHeldDetails,
    AttachDaemonSignalsOptions,
    DaemonSignalsHandle,
    AppendJsonlResult,
    CliOptionSpec,
    CliIoStreams,
    CliCommandContext,
    CliCommandHandler,
    CliCommandSpec,
    CliCommandEntry,
    DefineCliConfig,
    CliRunResult,
    CliRunner
} from './cli.js';

// Lego Zero-Native-Addon node:sqlite, FTS5 Escaping & Hybrid RRF Bricks (@krusch/toolkit/sqlite)
export {
    DatabaseSync,
    isSqliteCorruptionError,
    openSqliteDb,
    escapeFts5Query,
    fuseRrfResults
} from './sqlite.js';
export type {
    NodeSqliteRunResult,
    NodeSqliteStatementLike,
    NodeSqliteOpenOptions,
    NodeSqliteDatabaseLike,
    SqliteSynchronousMode,
    OpenSqliteDbOptions,
    SqliteRunOutcome,
    SqliteHealthOkData,
    SqliteHealthErrorDetails,
    SqliteDbHandle,
    EscapeFts5QueryOptions,
    FuseRrfOptions,
    RrfScoredItem
} from './sqlite.js';

// Lego DNS-Rebinding-Safe SSRF safeFetch & Bounded Rate Limiter Bricks (@krusch/toolkit/security)
export {
    isPrivateOrReservedIp,
    validateOutboundUrl,
    safeFetch,
    createRateLimiter
} from './security.js';
export type {
    IpClassificationOptions,
    DnsLookupEntry,
    DnsLookupResult,
    DnsLookupFn,
    ValidateOutboundUrlOptions,
    ValidatedOutboundUrlData,
    SsrfErrorDetails,
    SafeFetchOptions,
    SafeFetchData,
    CreateRateLimiterOptions,
    RateLimitAllowedData,
    RateLimitErrorDetails,
    RateLimitHeaders,
    RateLimitConsumeResult,
    RateLimitNextFn,
    RateLimitMiddlewareOptions,
    RateLimitMiddleware,
    RateLimitEdgeCheckOptions,
    RateLimitEdgeAllowedResult,
    RateLimitEdgeBlockedResult,
    RateLimitEdgeCheckResult,
    RateLimiter
} from './security.js';

// Lego Cross-Repo Rule-of-3 Scout Engine (@krusch/toolkit/lego-scout)
export {
    CANDIDATE_PATTERN_SIGNATURES,
    formatPortableProjectPath,
    scoutHomelabLegoCandidates
} from './lego-scout.js';
export type {
    CandidatePatternRuntime,
    CandidatePatternCategory,
    CandidateClusterStatus,
    CandidatePatternSignature,
    ScoutHomelabOptions,
    AdoptionFindingSummary,
    CandidateClusterSummary,
    LegoScoutData
} from './lego-scout.js';

// Wave 4 Schema Contract Validation & MCP JSON Schema Compiler (@krusch/toolkit/schema)
export {
    s,
    toJsonSchema,
    validateSchema,
    validatePayload,
    createSchemaMiddleware
} from './schema.js';
export type {
    SchemaStringFormat,
    SchemaPrimitive,
    SchemaIssue,
    SchemaValidationErrorDetails,
    SafeParseSuccess,
    SafeParseFailure,
    SafeParseResult,
    JsonSchemaObject,
    SchemaParseOptions,
    SchemaNode,
    ZodLikeIssue,
    ZodLikeSchema,
    SchemaInput,
    InferSchema,
    InferObjectShape,
    StringSchemaOptions,
    NumberSchemaOptions,
    IntegerSchemaOptions,
    BooleanSchemaOptions,
    LiteralSchemaOptions,
    EnumSchemaOptions,
    ArraySchemaOptions,
    ObjectSchemaOptions,
    RecordSchemaOptions,
    UnionSchemaOptions,
    AnySchemaOptions,
    SchemaBuilderNamespace,
    ValidateSchemaOptions,
    SchemaMiddlewareSource,
    SchemaMiddlewareOptions,
    SchemaMiddlewareNext,
    SchemaMiddlewareHandler
} from './schema.js';

// Wave 4 Byte-Bounded Multipart Upload & Magic-Byte MIME Guard (@krusch/toolkit/upload)
export {
    sanitizeUploadFilename,
    sniffMimeMagic,
    verifyUploadMime,
    parseBoundedMultipart
} from './upload.js';
export type {
    SniffedMimeType,
    SanitizeFilenameOptions,
    VerifyUploadMimeOptions,
    VerifiedUploadMimeData,
    UploadErrorDetails,
    ParsedUploadFile,
    ParsedMultipartData,
    MultipartBufferInput,
    MultipartInput,
    ParseBoundedMultipartOptions
} from './upload.js';

// Wave 4 Multi-Tier LLM Cascade, Single-Flight Circuit Breaker & Burst Probe (@krusch/toolkit/cascade)
export {
    DEFAULT_FLEET_CASCADE_TIERS,
    createTierCircuitBreaker,
    selectCascadeTier,
    probeBurstEndpoint,
    executeWithCascadeFallback
} from './cascade.js';
export type {
    CascadeProvider,
    CascadeTierId,
    CascadeTierDescriptor,
    ResolvedCascadeTier,
    CircuitState,
    CreateTierCircuitBreakerOptions,
    CircuitBreakerGateResult,
    CircuitBreakerTierState,
    TierCircuitBreaker,
    SelectCascadeTierOptions,
    CascadeSelectionReason,
    SelectCascadeTierData,
    SelectCascadeTierErrorDetails,
    ProbeBurstEndpointOptions,
    ProbeBurstEndpointData,
    ProbeBurstErrorDetails,
    CascadeAttemptContext,
    CascadeExecutorFn,
    CascadeSkippedAttempt,
    CascadeExecutedAttempt,
    CascadeAttemptRecord,
    ExecuteWithCascadeOptions,
    ExecuteWithCascadeData,
    ExecuteWithCascadeErrorDetails
} from './cascade.js';

// Wave 4 Isomorphic WAV, Whisper STT & Speech Synthesis Modality (@krusch/toolkit/audio)
export {
    encodeWavPcm16,
    parseWavHeader,
    transcribeWhisperAudio,
    synthesizeSpeechAudio
} from './audio.js';
export type {
    EncodeWavPcm16Options,
    WavHeaderData,
    ParseWavHeaderOptions,
    WhisperSegment,
    WhisperTranscriptionData,
    TranscribeWhisperAudioOptions,
    TtsResponseFormat,
    SynthesizeSpeechData,
    SynthesizeSpeechAudioOptions
} from './audio.js';

// Wave 6 Isomorphic Safe YAML 1.2 Core & Authority-Pack Loader (@krusch/toolkit/yaml)
export {
    DEFAULT_YAML_LIMITS,
    parseSafeYaml,
    stringifySafeYaml,
    validateYamlConfig,
    loadSafeYamlPack
} from './yaml.js';
export type {
    YamlByteInput,
    YamlLimits,
    ParseSafeYamlOptions,
    ParsedSafeYamlData,
    StringifySafeYamlOptions,
    StringifySafeYamlData,
    ValidateYamlConfigOptions,
    ValidateYamlConfigData,
    LoadSafeYamlPackOptions,
    LoadedSafeYamlPackData
} from './yaml.js';

// Turn-0 Grounded, Scale-Aware, Low-Tool-Call Harness Bricks (@krusch/toolkit/grounded-harness)
export {
    SCALE_TIERS,
    inferModelScaleMetadata,
    resolveScaleProfile,
    buildScaleAwareDirective,
    measureToolSchemaSavings,
    createToolBudgetGate,
    createDeltaContextTracker,
    buildSafeGeminiToolConfig,
    normalizeCodeSnippetForHash,
    inspectOutputDefects,
    detectDatasetSchemaHazards,
    formatTimeoutWithPartialStdout,
    runAsyncWithPartialStdout,
    createGroundedHarnessLoop
} from './grounded-harness.js';
export type {
    ScaleTier,
    ModelScaleHints,
    InferredModelScaleMetadata,
    ResolveScaleProfileOptions,
    ScaleProfile,
    ToolSchemaSavings,
    ToolBudgetGateOptions,
    ToolBudgetGate,
    DeltaContextTrackerOptions,
    DeltaChunkCandidate,
    DeltaFilterResult,
    DeltaContextMetrics,
    DeltaContextTracker,
    GeminiFunctionCallingConfig,
    GeminiToolConfig,
    BuildSafeGeminiToolConfigOptions,
    OutputDefectCode,
    OutputDefect,
    InspectOutputDefectsInput,
    InspectOutputDefectsResult,
    DetectDatasetSchemaHazardsInput,
    DatasetSchemaHazardsResult,
    FormatTimeoutOptions,
    TimeoutWithPartialStdoutResult,
    AsyncPartialStdoutContext,
    RunAsyncWithPartialStdoutOptions,
    RunAsyncWithPartialStdoutSuccess,
    GroundedHarnessLoopOptions,
    CompilePromptOptions,
    CompilePromptData,
    EvaluateTurnInput,
    EvaluateTurnData,
    InterceptDecision,
    InterceptToolOptions,
    InterceptToolCallData,
    RecordToolOutcomeOptions,
    RecordToolOutcomeData,
    VerifyStopAction,
    VerifyStopTurnState,
    VerifyStopData,
    GroundedHarnessStats,
    GroundedHarnessLoop
} from './grounded-harness.js';

// Wave 7 Atomic Request Idempotency Lock, Payload Fingerprinting & Replay Cache (@krusch/toolkit/idempotency)
export {
    DEFAULT_IDEMPOTENCY_OPTIONS,
    normalizeIdempotencyKey,
    computePayloadFingerprint,
    createIdempotencyStore,
    withIdempotency,
    createIdempotencyMiddleware
} from './idempotency.js';
export type {
    DefaultIdempotencyOptions,
    IdempotencyErrorDetails,
    NormalizeIdempotencyKeyOptions,
    NormalizedIdempotencyKeyData,
    ComputePayloadFingerprintOptions,
    PayloadFingerprintData,
    CreateIdempotencyStoreOptions,
    IdempotencyStoreBeginOptions,
    IdempotencyAcquiredData,
    IdempotencyReplayData,
    IdempotencyBeginData,
    IdempotencyStoreCommitOptions,
    IdempotencyCommitData,
    IdempotencyStoreReleaseOptions,
    IdempotencyReleaseData,
    IdempotencyInFlightRecord,
    IdempotencyCompletedRecord,
    IdempotencyRecordSnapshot,
    IdempotencyStore,
    WithIdempotencyOptions,
    IdempotencyHandlerContext,
    IdempotencyHandlerFn,
    WithIdempotencyData,
    IdempotencyNextFn,
    IdempotencyRequestContext,
    CreateIdempotencyMiddlewareOptions,
    IdempotencyMiddleware
} from './idempotency.js';

// Wave 7 Tamper-Evident SHA-256 Hash-Chained Compliance Ledger (@krusch/toolkit/audit-log)
export {
    GENESIS_AUDIT_HASH,
    canonicalizeAuditPayload,
    computeAuditEntryHash,
    verifyAuditChain,
    createAuditLog
} from './audit-log.js';
export type {
    AuditOutcome,
    AuditEntryInput,
    AuditAppendRecord,
    AuditEntry,
    CanonicalizeAuditPayloadOptions,
    CanonicalizeAuditPayloadData,
    ComputeAuditEntryHashOptions,
    ComputeAuditEntryHashData,
    VerifyAuditChainOptions,
    VerifyAuditChainData,
    AuditAppendOptions,
    AuditAppendData,
    AuditQueryFilters,
    AuditQueryData,
    AuditTailSnapshot,
    CreateAuditLogOptions,
    AuditLogHandle
} from './audit-log.js';

// Wave 7 Deny-by-Default RBAC Policy Evaluator & Multi-Tenant IDOR Guard (@krusch/toolkit/rbac)
export {
    matchPermissionPattern,
    createRbacPolicy,
    assertTenantOwnership,
    evaluateAccess,
    createRbacGuard
} from './rbac.js';
export type {
    RbacErrorCode,
    RbacRoleDefinition,
    RbacPolicyDefinition,
    CreateRbacPolicyOptions,
    CompiledRbacRolePermissions,
    RbacSubject,
    RbacErrorDetails,
    AssertTenantOwnershipOptions,
    TenantOwnershipData,
    EvaluateAccessOptions,
    AccessGrantData,
    RbacPolicy,
    RbacPermissionInput,
    RbacAuditEvent,
    CreateRbacGuardOptions,
    RbacGuardNext,
    RbacGuardMiddleware
} from './rbac.js';

// Wave 7 HMAC-Signed Keyset Cursor & Bounded Limit Pagination (@krusch/toolkit/pagination)
export {
    DEFAULT_PAGINATION_LIMITS,
    clampPageLimit,
    encodeCursor,
    decodeCursor,
    buildKeysetPage,
    paginateItems
} from './pagination.js';
export type {
    PaginationDirection,
    PaginationLimits,
    ClampPageLimitOptions,
    EncodeCursorOptions,
    EncodedCursorData,
    DecodeCursorOptions,
    DecodedCursorData,
    KeysetCursorPayload,
    BuildKeysetPageOptions,
    KeysetPageInfo,
    KeysetPageData,
    PaginateItemsOptions
} from './pagination.js';

