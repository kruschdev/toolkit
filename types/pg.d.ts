import type { OkEnvelope } from './envelopes.js';
import type { HttpLoggerLike } from './http.js';

export interface PgConnectionConfig {
    url?: string | null;
    connectionString?: string | null;
    host?: string;
    port?: number | string;
    user?: string;
    password?: string;
    database?: string;
    ssl?: boolean | Record<string, unknown>;
}

export interface PgQueryResult<TRow = Record<string, any>> {
    rows: TRow[];
    rowCount?: number | null;
    [key: string]: unknown;
}

export interface PgQueryableClient {
    query: <TRow = Record<string, any>>(sql: string, params?: unknown[]) => Promise<PgQueryResult<TRow>>;
    release?: (err?: Error | boolean) => void;
}

export interface PgPoolOptions {
    serviceName?: string;
    max?: number;
    idleTimeoutMillis?: number;
    connectionTimeoutMillis?: number;
    PoolClass?: (new (config: Record<string, unknown>) => any) | null;
    logger?: HttpLoggerLike | null;
    logDir?: string | null;
    ssl?: boolean | Record<string, unknown>;
}

export interface PgPoolWrapper {
    pool: any;
    query: <TRow = Record<string, any>>(sql: string, params?: unknown[]) => Promise<PgQueryResult<TRow>>;
    queryOne: <TRow = Record<string, any>>(sql: string, params?: unknown[]) => Promise<TRow | null>;
    withTransaction: <TResult>(
        fn: (client: PgQueryableClient) => Promise<TResult> | TResult
    ) => Promise<TResult>;
    healthCheck: () => Promise<{ ok: true; latencyMs: number }>;
    close: () => Promise<void>;
}

export interface SqlMigration {
    id: string;
    sql: string;
}

export interface PgVectorSearchOptions {
    table: string;
    embeddingColumn?: string;
    vector: number[] | Float32Array | Float64Array;
    selectColumns?: string[];
    whereSql?: string;
    params?: unknown[];
    limit?: number;
    expectedDims?: number;
}

export declare function assertSafePgIdentifier(name: string, label?: string): string;

export declare function assertSafeWhereClause(
    whereSql: string,
    options?: { maxParamIndex?: number | null }
): string;

export declare function buildPgConnectionString(dbConfig?: PgConnectionConfig | string): string;

export declare function createPgPool(
    dbConfig?: PgConnectionConfig | string,
    options?: PgPoolOptions
): PgPoolWrapper;

export declare function runSqlMigrations(
    pgWrapper: {
        query: (sql: string, params?: unknown[]) => Promise<any>;
        withTransaction?: <TResult>(fn: (client: any) => Promise<TResult> | TResult) => Promise<TResult>;
        connect?: () => Promise<PgQueryableClient>;
    },
    migrations?: readonly SqlMigration[] | SqlMigration[],
    options?: { tableName?: string }
): Promise<OkEnvelope<{ applied: string[]; skipped: string[] }> & { tool: 'pg.migrate' }>;

export declare function pgVectorSearch<TRow = Record<string, any> & { similarity: number }>(
    pgWrapper: { query: (sql: string, params?: unknown[]) => Promise<any> },
    options: PgVectorSearchOptions
): Promise<OkEnvelope<{ rows: TRow[] }> & { tool: 'pg.vectorSearch' }>;
