export interface SqliteRunResult {
    changes: number;
    lastInsertRowid: number | bigint;
}

export interface SqliteStatement<TRow = Record<string, any>> {
    run: (...params: unknown[]) => SqliteRunResult;
    get: (...params: unknown[]) => TRow | undefined;
    all: (...params: unknown[]) => TRow[];
    iterate: (...params: unknown[]) => IterableIterator<TRow>;
    pluck: (toggleState?: boolean) => this;
    raw: (toggleState?: boolean) => this;
    readonly source: string;
}

export interface SqliteDatabaseInstance {
    open: boolean;
    readonly name: string;
    readonly memory: boolean;
    readonly readonly: boolean;
    readonly inTransaction: boolean;
    prepare: <TRow = Record<string, any>>(sql: string) => SqliteStatement<TRow>;
    exec: (sql: string) => this;
    pragma: (source: string, options?: { simple?: boolean }) => unknown;
    transaction: <TFn extends (...args: any[]) => any>(fn: TFn) => TFn;
    close: () => this;
}

export interface InitDbOptions {
    wal?: boolean;
    busyTimeout?: number;
    synchronous?: 'OFF' | 'NORMAL' | 'FULL' | 'EXTRA' | '0' | '1' | '2' | '3' | number | string;
    walAutocheckpoint?: number;
    _DatabaseClass?: new (filename: string, options?: Record<string, unknown>) => SqliteDatabaseInstance;
}

export declare const SQLiteDatabase: new (
    filename?: string,
    options?: Record<string, unknown>
) => SqliteDatabaseInstance;

export declare function initDb(dbPath: string, options?: InitDbOptions): SqliteDatabaseInstance;

export declare function getDb(): SqliteDatabaseInstance;

export declare function run(
    sql: string,
    params?: unknown[]
): { lastInsertRowid: number; changes: number };

export declare function query<TRow = Record<string, any>>(sql: string, params?: unknown[]): TRow[];

export declare function queryOne<TRow = Record<string, any>>(
    sql: string,
    params?: unknown[]
): TRow | undefined;

export declare function exec(sql: string): void;

export declare function transaction<TResult>(fn: () => TResult): TResult;

export declare function prepare<TRow = Record<string, any>>(sql: string): SqliteStatement<TRow>;

export declare function closeDb(): void;

export declare function isSqliteCorruptionError(err: unknown): boolean;

export declare function fsyncDirectory(dirPath: string, fsImpl?: Record<string, any>): void;

export declare function atomicWriteFileSync(
    targetPath: string,
    content: string | Buffer | Uint8Array,
    fsImpl?: Record<string, any>
): void;
