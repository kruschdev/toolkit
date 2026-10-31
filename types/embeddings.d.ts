export declare const DEFAULT_EMBED_HOST: string;
export declare const DEFAULT_EMBED_MODEL: string;
export declare const DEFAULT_EMBED_DIMS: number;

export interface EmbeddingModelProfile {
    readonly provider: 'ollama' | 'gemini' | (string & {});
    readonly ctxTokens: number;
    readonly nativeDimensions: number;
    readonly defaultDimensions: number;
    readonly mrlDimensions: boolean;
    readonly maxChunkChars: number;
    readonly overlapChars: number;
    readonly queryStyle: 'bge' | 'qwen3' | 'arctic' | 'nomic' | 'none' | (string & {});
}

export declare const MODEL_PROFILES: Readonly<Record<string, EmbeddingModelProfile>>;

export type EmbeddingMode = 'document' | 'query';
export type EmbeddingDomain = 'general' | 'code' | 'law' | 'biz' | 'memory' | (string & {});

export interface FormatEmbeddingInputOptions {
    model?: string;
    mode?: EmbeddingMode;
    domain?: EmbeddingDomain;
    instruction?: string;
    prefixDocuments?: boolean;
}

export interface EmbedOptions extends FormatEmbeddingInputOptions {
    dimensions?: number;
    host?: string;
    apiKey?: string;
    mock?: boolean;
    keepAlive?: number | string;
    timeoutMs?: number;
    batchSize?: number;
    fetchImpl?: typeof fetch;
    allowProviderFallback?: boolean;
    maxChars?: number;
    overlapChars?: number;
    maxChunks?: number;
}

export interface ChunkTextOptions {
    model?: string;
    maxChars?: number;
    overlapChars?: number;
    maxChunks?: number;
}

export interface ScopedEmbeddingsClient {
    embedText: (text: string, opts?: EmbedOptions) => Promise<number[] | null>;
    embedBatch: (texts: string[], opts?: EmbedOptions) => Promise<number[][]>;
    similaritySearch: (
        queryText: string,
        searchOpts?: number | ({ limit?: number; threshold?: number } & EmbedOptions),
        legacyThreshold?: number
    ) => Promise<Array<Record<string, any>>>;
}

export declare function resolveEmbeddingProfile(model?: string): EmbeddingModelProfile;

export declare function formatEmbeddingInput(
    text: string,
    options?: FormatEmbeddingInputOptions
): string;

export declare function l2Normalize(vector: number[] | ArrayLike<number>): number[];

export declare function isZeroVector(vector: number[] | null | undefined): boolean;

export declare function cosineSimilarity(vecA: number[], vecB: number[]): number;

export declare function calibrateQuerySimilarity(
    rawCosine: number,
    options?: { model?: string; queryVec?: ArrayLike<number> | null }
): number;

export declare function calculateCentroid(vectors: number[][]): number[] | null;

export declare function validateVectorDimension(
    vector: number[] | null | undefined,
    expectedDim?: number,
    context?: string
): number[] | null;

export declare function generateDeterministicVector(text: string, dim?: number): number[];

export declare function chunkTextForEmbedding(text: string, options?: ChunkTextOptions): string[];

export declare function clearToolkitEmbeddingCache(): void;

export declare function embedBatch(texts: string[], options?: EmbedOptions): Promise<number[][]>;

export declare function embed(text: string, options?: EmbedOptions): Promise<number[] | null>;

export declare function embedChunkedCentroid(
    text: string,
    options?: EmbedOptions
): Promise<number[] | null>;

export declare function createEmbeddings(
    config?: Record<string, any>,
    namespace?: string,
    db?: { query: (sql: string, params?: unknown[]) => Promise<any> } | null
): ScopedEmbeddingsClient;
