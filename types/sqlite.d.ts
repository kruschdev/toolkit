import type { ErrorDetail, ErrorEnvelope, LegoEnvelope, OkEnvelope } from './envelopes.js';

export type { ErrorDetail, ErrorEnvelope, LegoEnvelope, OkEnvelope };

export interface NodeSqliteRunResult {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
}

export interface NodeSqliteStatementLike<TRow = Record<string, any>> {
    run: (...params: unknown[]) => NodeSqliteRunResult;
    get: (...params: unknown[]) => TRow | undefined;
    all: (...params: unknown[]) => TRow[];
    iterate?: (...params: unknown[]) => IterableIterator<TRow>;
    readonly expandedSQL?: string;
    readonly sourceSQL?: string;
}

export interface NodeSqliteOpenOptions {
    open?: boolean;
    readOnly?: boolean;
    enableForeignKeyConstraints?: boolean;
    enableDoubleQuotedStringLiterals?: boolean;
    allowExtension?: boolean;
    [key: string]: unknown;
}

export interface NodeSqliteDatabaseLike {
    exec: (sql: string) => void;
    prepare: <TRow = Record<string, any>>(sql: string) => NodeSqliteStatementLike<TRow>;
    close: () => void;
    open?: () => void;
    readonly isOpen?: boolean;
}

export type SqliteSynchronousMode =
    | 'OFF'
    | 'NORMAL'
    | 'FULL'
    | 'EXTRA'
    | '0'
    | '1'
    | '2'
    | '3'
    | 0
    | 1
    | 2
    | 3;

export interface OpenSqliteDbOptions {
    wal?: boolean;
    busyTimeout?: number;
    synchronous?: SqliteSynchronousMode | string | number;
    walAutocheckpoint?: number;
    readOnly?: boolean;
    DatabaseClass?:
        | (new (dbPath: string, options?: NodeSqliteOpenOptions) => NodeSqliteDatabaseLike)
        | null;
}

export interface SqliteRunOutcome {
    changes: number;
    lastInsertRowid: number;
}

export interface SqliteHealthOkData {
    dbPath: string;
    ok: true;
}

export interface SqliteHealthErrorDetails {
    dbPath: string;
    isCorruption?: boolean;
}

export interface SqliteDbHandle {
    readonly db: NodeSqliteDatabaseLike;
    readonly dbPath: string;
    isOpen: () => boolean;
    exec: (sql: string) => void;
    run: (
        sql: string,
        params?: readonly unknown[] | unknown[] | Record<string, unknown> | unknown
    ) => SqliteRunOutcome;
    query: <TRow = Record<string, any>>(
        sql: string,
        params?: readonly unknown[] | unknown[] | Record<string, unknown> | unknown
    ) => TRow[];
    queryOne: <TRow = Record<string, any>>(
        sql: string,
        params?: readonly unknown[] | unknown[] | Record<string, unknown> | unknown
    ) => TRow | null;
    transaction: <TResult>(fn: () => TResult) => TResult;
    healthCheck: () => LegoEnvelope<SqliteHealthOkData, SqliteHealthErrorDetails>;
    close: () => void;
}

export interface EscapeFts5QueryOptions {
    operator?: 'AND' | 'OR' | 'and' | 'or' | string;
    prefixLastToken?: boolean;
    maxTokens?: number;
}

export interface FuseRrfOptions {
    k?: number;
    idKey?: string;
    limit?: number;
    weights?: readonly number[];
}

export type RrfScoredItem<TItem = Record<string, unknown>> = TItem & {
    rrfScore: number;
};

export declare const DatabaseSync: new (
    location?: string,
    options?: NodeSqliteOpenOptions
) => NodeSqliteDatabaseLike;

export declare function isSqliteCorruptionError(err: unknown): boolean;

export declare function openSqliteDb(
    dbPath?: string,
    options?: OpenSqliteDbOptions
): SqliteDbHandle;

export declare function escapeFts5Query(
    rawQuery?: string,
    options?: EscapeFts5QueryOptions
): string;

export declare function fuseRrfResults<
    TItem extends Record<string, any> = Record<string, unknown>
>(
    rankedLists?: ReadonlyArray<ReadonlyArray<TItem>>,
    options?: FuseRrfOptions
): Array<RrfScoredItem<TItem>>;
