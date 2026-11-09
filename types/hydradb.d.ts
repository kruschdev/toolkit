import type { LegoEnvelope } from './envelopes.js';

export const DEFAULT_HYDRADB_BASE_URL: 'https://api.hydradb.com';
export const HYDRADB_API_VERSION: '2';
export const RETRYABLE_HYDRADB_STATUS_CODES: readonly number[];

export interface HydraWebhookVerifyOptions {
  tool?: string;
}

export interface HydraWebhookVerifiedData {
  verified: true;
  algorithm: 'hmac-sha256';
}

export function verifyHydraWebhookSignature(
  rawBody: string | Buffer | Uint8Array,
  signatureHeader: string,
  signingSecret: string,
  options?: HydraWebhookVerifyOptions
): LegoEnvelope<HydraWebhookVerifiedData>;

export interface BuildHydraContextStringOptions {
  includeGraphPaths?: boolean;
  includeAdditionalContext?: boolean;
  maxChunks?: number;
}

export function buildHydraContextString(
  queryResult: Record<string, unknown>,
  options?: BuildHydraContextStringOptions
): string;

export interface HydraDbClientOptions {
  apiKey?: string;
  baseUrl?: string;
  database?: string;
  collection?: string;
  timeoutMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  fetchImpl?: typeof fetch;
}

export interface HydraMemoryInput {
  id?: string;
  title?: string;
  text?: string;
  content?: string;
  is_markdown?: boolean;
  isMarkdown?: boolean;
  infer?: boolean;
  custom_instructions?: string;
  customInstructions?: string;
  user_name?: string;
  userName?: string;
  metadata?: Record<string, unknown>;
  additional_metadata?: Record<string, unknown>;
}

export interface HydraAppKnowledgeInput {
  id?: string;
  database?: string;
  collection?: string;
  title?: string;
  type?: string;
  url?: string;
  timestamp?: string;
  text?: string;
  content?: string | { text: string };
  tenant_metadata?: Record<string, unknown>;
  additional_metadata?: Record<string, unknown>;
  relationIds?: string[];
  relations?: {
    ids?: string[];
    properties?: Record<string, unknown>;
  };
}

export interface HydraQueryOptions {
  query: string;
  database?: string;
  collection?: string;
  collections?: string[];
  type?: 'knowledge' | 'memory' | 'all';
  queryBy?: 'hybrid' | 'text';
  operator?: 'and' | 'or';
  mode?: 'fast' | 'thinking' | 'auto';
  maxResults?: number;
  alpha?: number;
  recencyBias?: number;
  graphContext?: boolean;
  queryForcefulRelations?: boolean;
  additionalContext?: Record<string, unknown>;
  metadataFilters?: Record<string, unknown>;
  queryApps?: string[];
  acl?: Record<string, unknown>;
}

export interface HydraFeedbackOptions {
  requestId: string;
  feedback?: string;
  rating?: 'positive' | 'negative' | 'neutral';
  source?: 'agent' | 'user' | 'eval';
  database?: string;
  collection?: string;
  groundTruth?: {
    answer?: string;
    source_ids?: string[];
  };
  metadata?: Record<string, unknown>;
}

export class HydraDbClient {
  apiKey: string;
  baseUrl: string;
  database: string;
  collection: string;
  timeoutMs: number;
  maxRetries: number;
  retryDelayMs: number;
  fetchImpl: typeof fetch;

  constructor(options?: HydraDbClientOptions);
  isConfigured(): boolean;
  createDatabase(options?: {
    database?: string;
    metadataSchema?: Record<string, unknown>;
  }): Promise<Record<string, unknown>>;
  getDatabaseStatus(options?: {
    database?: string;
  }): Promise<Record<string, unknown>>;
  waitForDatabaseReady(options?: {
    database?: string;
    pollIntervalMs?: number;
    timeoutMs?: number;
  }): Promise<Record<string, unknown>>;
  listDatabases(): Promise<unknown>;
  listCollections(options?: { database?: string }): Promise<unknown>;
  getDatabaseStats(options?: { database?: string }): Promise<Record<string, unknown>>;
  deleteDatabase(options: { database: string }): Promise<Record<string, unknown>>;
  ingestMemories(
    memories: HydraMemoryInput[],
    options?: { database?: string; collection?: string; upsert?: boolean }
  ): Promise<Record<string, unknown>>;
  ingestAppKnowledge(
    items: HydraAppKnowledgeInput[],
    options?: { database?: string; collection?: string; upsert?: boolean }
  ): Promise<Record<string, unknown>>;
  getContextStatus(options: {
    ids: string[] | string;
    database?: string;
    collection?: string;
  }): Promise<{
    items?: Array<Record<string, unknown>>;
    scopeMissDetected: boolean;
    scopeMissIds: string[];
    [key: string]: unknown;
  }>;
  waitForIndexing(options: {
    ids: string[] | string;
    database?: string;
    collection?: string;
    pollIntervalMs?: number;
    timeoutMs?: number;
    requireCompleted?: boolean;
  }): Promise<Record<string, unknown>>;
  queryContext(options: HydraQueryOptions): Promise<{
    chunks?: Array<Record<string, unknown>>;
    sources?: Array<Record<string, unknown>>;
    graph_context?: {
      query_paths?: unknown[];
      chunk_relations?: Array<Record<string, unknown>>;
      chunk_id_to_group_ids?: Record<string, string[]>;
    };
    additional_context?: Record<string, unknown>;
    contextString: string;
    _meta?: { request_id?: string; latency_ms?: number };
    [key: string]: unknown;
  }>;
  listContext(options?: {
    database?: string;
    collection?: string;
    type?: 'knowledge' | 'memory' | 'all';
    limit?: number;
    cursor?: string;
    metadataFilters?: Record<string, unknown>;
  }): Promise<Record<string, unknown>>;
  inspectContext(options: {
    id: string;
    database?: string;
    collection?: string;
    type?: 'knowledge' | 'memory';
  }): Promise<Record<string, unknown>>;
  updateSourceMetadata(
    id: string,
    options?: {
      database?: string;
      collection?: string;
      metadata?: Record<string, unknown>;
      additionalMetadata?: Record<string, unknown>;
    }
  ): Promise<Record<string, unknown>>;
  getRelations(options: {
    id: string;
    database?: string;
    collection?: string;
    type?: 'knowledge' | 'memory';
    limit?: number;
    cursor?: string;
  }): Promise<Record<string, unknown>>;
  getSubgraph(
    id: string,
    options?: { database?: string; collection?: string }
  ): Promise<Record<string, unknown>>;
  deleteContext(options: {
    ids: string[];
    type?: 'knowledge' | 'memory';
    database?: string;
    collection?: string;
  }): Promise<Record<string, unknown>>;
  submitFeedback(options: HydraFeedbackOptions): Promise<{
    submitted: boolean;
    data?: Record<string, unknown>;
    error?: string;
  }>;
}

export function createHydraDbClient(options?: HydraDbClientOptions): HydraDbClient;
