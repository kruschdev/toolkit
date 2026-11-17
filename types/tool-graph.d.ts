import type { ErrorDetail, ErrorEnvelope, LegoEnvelope, OkEnvelope } from './envelopes.js';

export type { ErrorDetail, ErrorEnvelope, LegoEnvelope, OkEnvelope };

export declare const CANONICAL_SHARED_TYPES: readonly [
    'email_address',
    'repo_path',
    'file_path',
    'url',
    'uuid',
    'commit_sha',
    'channel_name',
    'symbol',
    'task_id',
    'memory_id',
    'page_number',
    'sql_query'
];

export interface ToolGraphDefaultOptions {
    readonly budget: number;
    readonly minBudget: number;
    readonly maxBudget: number;
    readonly maxDepth: number;
    readonly maxIntents: number;
    readonly maxEdgesPerNode: number;
    readonly minWeight: number;
    readonly maxWeight: number;
    readonly successBoost: number;
    readonly nextBoost: number;
    readonly gapBoost: number;
    readonly failurePenalty: number;
    readonly learnedNextThreshold: number;
    readonly maxLearnedNextSlots: number;
    readonly primaryCutoffRatio: number;
    readonly bm25K1: number;
    readonly bm25B: number;
    readonly exposeOutcomeTool: boolean;
}

export declare const DEFAULT_TOOL_GRAPH_OPTIONS: ToolGraphDefaultOptions;

export interface MaskedTaskEntities {
    maskedText: string;
    intentSignature: string;
    tokens: string[];
}

export declare function maskTaskEntities(taskText: string): MaskedTaskEntities;

export interface ExtractedGivenTypes {
    givenTypes: string[];
    detections: Record<string, string[]>;
}

export declare function extractGivenTypesFromTask(
    taskText: string,
    extraGiven?: string[]
): ExtractedGivenTypes;

export interface ToolGraphCustomContract {
    consumes?: string[];
    produces?: string[];
    capabilities?: string[];
}

export interface ToolGraphToolInput {
    name: string;
    component?: string;
    server?: string;
    namespace?: string;
    title?: string;
    description?: string;
    consumes?: string[];
    produces?: string[];
    capabilities?: string[];
    annotations?: {
        title?: string;
        readOnlyHint?: boolean;
        destructiveHint?: boolean;
        idempotentHint?: boolean;
        openWorldHint?: boolean;
    };
    inputSchema?: {
        type?: string;
        properties?: Record<string, Record<string, unknown>>;
        required?: string[];
        [key: string]: unknown;
    };
    outputSchema?: {
        type?: string;
        properties?: Record<string, Record<string, unknown>>;
        [key: string]: unknown;
    };
    [key: string]: unknown;
}

export interface ToolGraphCompiledNode {
    name: string;
    component: string;
    title: string;
    description: string;
    paramNames: string[];
    requiredParams: string[];
    consumes: string[];
    produces: string[];
    capabilities: string[];
    schemaBytes: number;
    estimatedTokens: number;
    rawTool: ToolGraphToolInput;
}

export interface InferToolGraphSchemaOptions {
    customContracts?: Record<string, ToolGraphCustomContract>;
}

export interface InferredToolGraphSchema {
    nodes: ToolGraphCompiledNode[];
    nodeByName: Map<string, ToolGraphCompiledNode>;
    producersByType: Map<string, string[]>;
    consumersByType: Map<string, string[]>;
}

export declare function inferToolGraphSchema(
    tools?: ToolGraphToolInput[],
    options?: InferToolGraphSchemaOptions
): InferredToolGraphSchema;

export type ToolSelectionReason =
    | {
          role: 'match';
          score: number;
          matchedTerms: string[];
          intentBoost: number;
          clauseAnchor: boolean;
      }
    | {
          role: 'prerequisite';
          produces: string;
          for: string;
          depth: number;
      }
    | {
          role: 'learned_next';
          after: string;
          weight: number;
      };

export interface SelectedToolDescriptor {
    name: string;
    component: string;
    title?: string;
    description: string;
    requiredParams: string[];
    consumes: string[];
    produces: string[];
    why: ToolSelectionReason;
    inputSchema: Record<string, unknown>;
}

export interface FindToolsParams {
    task: string;
    given?: string[];
    budget?: number;
    component?: string;
}

export interface FindToolsMetrics {
    fullCatalogSchemaBytes: number;
    selectedSchemaBytes: number;
    estimatedFullTokens: number;
    estimatedSelectedTokens: number;
    schemaReductionPct: number;
}

export interface FindToolsData {
    task: string;
    intentSignature: string;
    extractedGiven: string[];
    detections: Record<string, string[]>;
    budget: number;
    totalCatalogTools: number;
    selectedTools: string[];
    tools: SelectedToolDescriptor[];
    metrics: FindToolsMetrics;
}

export interface ReportOutcomeParams {
    task: string;
    tools?: string[];
    success: boolean;
    missingInput?: string | string[];
    given?: string[];
}

export interface GapProducerBoost {
    missingType: string;
    producer: string;
    weight: number;
}

export interface ReportOutcomeData {
    intentSignature: string;
    success: boolean;
    tools: string[];
    updatedIntentWeights: Record<string, number>;
    updatedNextWeights: Record<string, number>;
    gapProducersBoosted: GapProducerBoost[];
}

export interface DescribeToolData {
    name: string;
    component: string;
    title?: string;
    description: string;
    consumes: string[];
    produces: string[];
    capabilities: string[];
    learnedNext: Array<{ name: string; weight: number }>;
    inputSchema: Record<string, unknown>;
    annotations?: Record<string, unknown>;
}

export interface CallToolData<TResult = unknown> {
    toolName: string;
    result: TResult;
}

export interface ToolGraphStateSnapshot {
    version: number;
    intents: Array<{
        intentSignature: string;
        weights: Record<string, number>;
    }>;
    nextEdges: Record<string, Record<string, number>>;
    dynamicConsumes: Record<string, string[]>;
}

export interface ImportToolGraphStateData {
    importedIntents: number;
    importedNextEdges: number;
    dynamicConsumesCount: number;
}

export interface ToolGraphStats {
    totalCatalogTools: number;
    exposedToolCount: number;
    typedProducerTypes: number;
    typedConsumerTypes: number;
    learnedIntentCount: number;
    maxIntents: number;
    learnedNextEdgeCount: number;
    dynamicConsumesCount: number;
    fullCatalogSchemaBytes: number;
    exposedSchemaBytes: number;
    surfaceReductionPct: number;
    calls: {
        findTools: number;
        reportOutcome: number;
        describeTool: number;
        callTool: number;
    };
}

export type ToolGraphHandlerFn = (args: Record<string, unknown>) => unknown | Promise<unknown>;

export interface CreateToolGraphOptions {
    budget?: number;
    minBudget?: number;
    maxBudget?: number;
    maxDepth?: number;
    maxIntents?: number;
    maxEdgesPerNode?: number;
    minWeight?: number;
    maxWeight?: number;
    successBoost?: number;
    nextBoost?: number;
    gapBoost?: number;
    failurePenalty?: number;
    learnedNextThreshold?: number;
    maxLearnedNextSlots?: number;
    primaryCutoffRatio?: number;
    bm25K1?: number;
    bm25B?: number;
    exposeOutcomeTool?: boolean;
    alwaysLoaded?: string[];
    customContracts?: Record<string, ToolGraphCustomContract>;
    handlers?: Record<string, ToolGraphHandlerFn> | Map<string, ToolGraphHandlerFn>;
}

export interface ToolGraphInstance {
    findTools(params: FindToolsParams): LegoEnvelope<FindToolsData>;
    reportOutcome(params: ReportOutcomeParams): LegoEnvelope<ReportOutcomeData>;
    describeTool(toolName: string): LegoEnvelope<DescribeToolData>;
    callTool<TResult = unknown>(
        toolName: string,
        args?: Record<string, unknown>
    ): Promise<LegoEnvelope<CallToolData<TResult>>>;
    getExposedTools(): ToolGraphToolInput[];
    exportState(): OkEnvelope<ToolGraphStateSnapshot>;
    importState(
        snapshot: ToolGraphStateSnapshot | OkEnvelope<ToolGraphStateSnapshot>
    ): LegoEnvelope<ImportToolGraphStateData>;
    resetState(): OkEnvelope<{ cleared: boolean }>;
    getStats(): ToolGraphStats;
    schema: {
        nodes: ToolGraphCompiledNode[];
        producersByType: Record<string, string[]>;
        consumersByType: Record<string, string[]>;
    };
}

export declare function createToolGraph(
    tools?: ToolGraphToolInput[],
    options?: CreateToolGraphOptions
): ToolGraphInstance;
