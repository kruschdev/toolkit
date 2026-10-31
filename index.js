/**
 * @krusch/toolkit — Shared utilities for homelab projects
 *
 * Barrel export for core modules used by heyjb and pocketlawyer.
 *
 * Usage:
 *   import { chat, chatJson, parseAIJson, initDb, query } from '@krusch/toolkit';
 */

// LLM Client
export {
    chat,
    chatJson,
    resolveModelConfig,
    isGemini4Model,
    normalizeThinkingLevel,
    resolveMaxOutputTokens,
    buildGeminiPayload,
    extractGeminiTextParts
} from './llm.js';

// JSON Parsing
export { parseAIJson, safeParseJson } from './json-parse.js';

// Configuration
export { loadJsonConfig, createConfig, loadProjectConfig, envOr, envInt, envBool, validateRequired } from './config.js';

// Database
export { initDb, getDb, run, query, queryOne, exec, transaction, prepare, closeDb } from './db.js';

// Image Generation
export { createImageGenerator } from './imagen.js';

// Scheduling
export { createScheduler } from './scheduler.js';

// Authentication
export { createAuth } from './auth.js';

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

// Multimodal Vision (Gemini 4 Argon ready)
export { callGeminiMedia, callGeminiMediaJson } from './vision.js';

// DBOS Swarm & Queue client
export { createDbosClient, DbosClient } from './dbos.js';

// Structured JSON Logger
export { setupLogging } from './log.js';

// Scaffolder templates
export { scaffoldProject } from './scaffold.js';

// Calculation Utilities
export { applyWaste, round2, contractorCost, customerPrice, calcDualPricing, findCatalogPrice, confidenceEnvelope } from './calculator.js';

// Stage-Aware Context Pruning & Knowledge Boundary Routing (arXiv: 2608.08389 / arXiv: 2608.23982)
export { prunePreRetrieval, prunePostRetrieval, prunePreSynthesis, createContextPruner, shouldActivateMemory, createKnowledgeBoundaryRouter } from './prune.js';

// Specification-First Convergence & Test-Driven Reasoning Engine (arXiv: 2608.12440 / 2608.03744 / 2608.16742)
export { checkConvergence, runAuditPass, runRefereeAuditPass, evaluateRefereeConsensus, createSpecAuditRunner, synthesizeExecutableContract, evaluateDualTrackRefinement } from './spec-verifier.js';

// Knowledge Invalidation & Artifact-Anchored Verification EA-Graph (MobileMem 2608.13606 / EA-Graph 2608.04278)
export { MemoryInvalidationEngine, filterActiveMemories, supersedeMemoryRecord, buildMemoryLineage, ArtifactVerificationGraph, anchorVerificationClaim, checkArtifactDrift, computeArtifactHash } from './memory-invalidation.js';

// SKILLER & Executable Code Knowledge (arXiv: 2608.10538 / arXiv: 2608.16295 / arXiv: 2609.05824)
export { extractSkillFromTrajectory, evaluateSkillTransfer, stageSkillForMonorepo, createExecutableSkillContract, routeDiverseSkills } from './skiller.js';

// Trajectory Guard, Multi-Agent Mind Virus Shield & PIG Engine (Gambit 2608.08020 / CaRL 2607.29211 / Mind Viruses 2608.10218 / PIG Engine 2606.08162 / Emergence World 2609.17320)
export { createTrajectoryGuard, scoreTrajectoryProgress, evaluateFutileReasoning, sanitizeAgentMessage, checkGoalDrift, calculateIntelligenceEntropy, createPigEngine, evaluateMultiAgentResilience } from './trajectory-guard.js';

// Hierarchical Spatial Knowledge Graph (AVA-Encoder - arXiv: 2608.12313)
export { SpatialKnowledgeGraph, SpatialNode, InfrastructureEdge } from './spatial-kg.js';

// Evidence-Backed Video Question Answering (E-VQA Grounding - arXiv: 2607.11862)
export { EvidenceGroundingEngine, VideoEvidenceSegment } from './evqa-grounding.js';

// Polygres Unified Relational, Graph & Vector Client
export { PolygresClient, createPolygresClient } from './polygres.js';

// Hydra-0: Action Flow for Generalist World Modeling & Control (arXiv: 2608.18077)
export { HydraWorldModelEngine, ActionFlowVector, ActionFlowSequence, createHydraEngine } from './hydra-action-flow.js';

// SparsePR: Training-Free Block-Sparse Video Attention & Partitioning (arXiv: 2608.18484)
export { SparsePROptimizer, VideoTokenBlock, createSparsePROptimizer } from './sparse-pr.js';

// PhysCaP: Physics-Informed Spatial Grounding & Code-as-Policy (arXiv: 2608.21031)
export { PhysicsConstraintEvaluator, PhysCaPPolicyGenerator, PHYSICAL_CODES_AND_LIMITS, createPhysCaPGenerator } from './physcap-policy.js';

// Matterport Spatial Importer & Digital Twin Fusion Engine
export { MatterportImporter, MatterportSweepStation, MatterportMeshMetadata, createMatterportImporter } from './matterport-importer.js';

// SKILL.state: Scalable Long-Horizon Agent Skills & Bounded State Manager (arXiv: 2608.26263)
export { createSkillStateManager, calculateSkillStateSavings } from './skill-state.js';

// Second Thought: Parallel Auxiliary Reasoning during Tool Execution (arXiv: 2608.13667)
export { createSecondThoughtEngine } from './second-thought.js';

// Persistent Q4 KV Cache Manager & Policy-Driven Runtime Layer (arXiv: 2603.04428 & CacheScout & GVA arXiv: 2609.13285)
export { createKvCacheManager, calculateKvCacheMetrics, calculateGvaFootprint, createGvaAllocator } from './kv-cache-manager.js';

// Diverse Hypothesis Deliberation (DHD) & Trajectory Value Engine (arXiv: 2608.14375 & arXiv: 2608.25937)
export { extractTrajectoryValue, evaluateDHDConsensus } from './dhd-deliberation.js';

// ModularRSI: Modular and Generalizable Recursive Harness Self-Improvement (arXiv: 2609.14857)
export { createModularRsiHarness, RSI_MODULES, DEFAULT_HARNESS_SPECS } from './modular-rsi.js';

// Sovereign System 1 Decision Primitive (Single-Token Logit / Logprob Router)
export { decide, decideBatch, calibrateChoiceLogprobs, evaluateDeterministicDecision, createSystem1Decider } from './decide.js';

// Beyond Parameters: Virtual Logical Depth (VLD) Scaling Laws & Fixed-Point Engine (arXiv: 2506.18233v3)
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

// Canonical Coding-Agent Harness Engineering Primitives (arXiv: 2609.00006)
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

// Source-Preserving Episodic Retrieval & Append-Only Memory Primitives (arXiv: 2610.30755)
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

// Lego Server-Sent Events (SSE) & AbortController Streaming Bricks (@krusch/toolkit/streaming)
export {
    sseResponse,
    streamChat
} from './streaming.js';

// Lego MCP Server & 4-Boolean Annotation Bricks (@krusch/toolkit/mcp)
export {
    defineMcpTool,
    okMcpResult,
    errorMcpResult,
    validateToolArgs,
    createMcpServer
} from './mcp-server.js';

// Lego PostgreSQL + pgvector Pool, Migrations & Cosine Search Bricks (@krusch/toolkit/pg)
export {
    assertSafePgIdentifier,
    buildPgConnectionString,
    createPgPool,
    runSqlMigrations,
    pgVectorSearch
} from './pg.js';

// Lego Runtime Catalog, Zero-LLM Archetype Blueprints & Boilerplate Auditor (@krusch/toolkit/catalog)
export {
    RUNTIME_BRICKS,
    PROJECT_ARCHETYPES,
    listLegoBricks,
    getLegoBrick,
    listArchetypes,
    getArchetype,
    auditBoilerplateText
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

// Lego Constant-Time Webhook HMAC & Bearer Verification Bricks (@krusch/toolkit/webhooks)
export {
    constantTimeEqual,
    signWebhookHmac,
    verifySlackSignature,
    verifyGithubSignature,
    verifyStripeSignature,
    verifyBearerToken
} from './webhooks.js';

// Lego Single-Instance Lockfile, Daemon Signal & CLI Envelope Bricks (@krusch/toolkit/cli)
export {
    withSingleInstanceLock,
    attachDaemonSignals,
    appendJsonlRecord,
    defineCli
} from './cli.js';

// Lego Zero-Native-Addon node:sqlite, FTS5 Escaping & Hybrid RRF Bricks (@krusch/toolkit/sqlite)
export {
    DatabaseSync,
    isSqliteCorruptionError,
    openSqliteDb,
    escapeFts5Query,
    fuseRrfResults
} from './sqlite.js';

// Lego DNS-Rebinding-Safe SSRF safeFetch & Bounded Rate Limiter Bricks (@krusch/toolkit/security)
export {
    isPrivateOrReservedIp,
    validateOutboundUrl,
    safeFetch,
    createRateLimiter
} from './security.js';

// Lego Cross-Repo Rule-of-3 Scout Engine (@krusch/toolkit/lego-scout)
export {
    CANDIDATE_PATTERN_SIGNATURES,
    formatPortableProjectPath,
    scoutHomelabLegoCandidates
} from './lego-scout.js';

// Lego Composable Schema Builder, Zod Adapter & MCP JSON Schema Compiler (@krusch/toolkit/schema)
export {
    s,
    toJsonSchema,
    validateSchema,
    validatePayload,
    createSchemaMiddleware
} from './schema.js';

// Lego Byte-Bounded Multipart Upload, Filename Sanitizer & Magic-Byte MIME Guard (@krusch/toolkit/upload)
export {
    sanitizeUploadFilename,
    sniffMimeMagic,
    verifyUploadMime,
    parseBoundedMultipart
} from './upload.js';

// Lego Multi-Tier LLM Cascade, Single-Flight Circuit Breaker & Burst Probe (@krusch/toolkit/cascade)
export {
    DEFAULT_FLEET_CASCADE_TIERS,
    createTierCircuitBreaker,
    selectCascadeTier,
    probeBurstEndpoint,
    executeWithCascadeFallback
} from './cascade.js';

// Lego Isomorphic WAV PCM16, Whisper STT & TTS Audio Modality Bricks (@krusch/toolkit/audio)
export {
    encodeWavPcm16,
    parseWavHeader,
    transcribeWhisperAudio,
    synthesizeSpeechAudio
} from './audio.js';

// Lego Zero-Dependency Isomorphic Safe YAML 1.2 Core & Authority-Pack Bricks (@krusch/toolkit/yaml)
export {
    DEFAULT_YAML_LIMITS,
    parseSafeYaml,
    stringifySafeYaml,
    validateYamlConfig,
    loadSafeYamlPack
} from './yaml.js';

