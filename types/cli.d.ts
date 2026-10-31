import type { OkEnvelope, ErrorDetail, ErrorEnvelope, LegoEnvelope } from './envelopes.js';
import type { HttpLoggerLike } from './http.js';

export type { OkEnvelope, ErrorDetail, ErrorEnvelope, LegoEnvelope };

export interface SingleInstanceLockContext {
    lockFilePath: string;
    pid: number;
    nonce: string;
}

export interface SingleInstanceLockOptions {
    staleMs?: number;
    tool?: string;
    rethrow?: boolean;
}

export interface SingleInstanceLockData<TResult = unknown> {
    lockFilePath: string;
    result: TResult;
}

export interface SingleInstanceLockHeldDetails {
    pid: number | null;
    lockFilePath: string;
}

export interface AttachDaemonSignalsOptions {
    signals?: string[];
    timeoutMs?: number;
    exitProcess?: boolean;
    logger?: HttpLoggerLike | null;
}

export interface DaemonSignalsHandle {
    readonly signal: AbortSignal;
    shutdown: (reason?: string) => Promise<void>;
    detach: () => void;
}

export interface AppendJsonlResult {
    ok: true;
    bytesWritten: number;
    filePath: string;
}

export interface CliOptionSpec {
    type: 'string' | 'boolean';
    short?: string;
    multiple?: boolean;
    default?: string | boolean | string[] | boolean[];
    description?: string;
}

export interface CliIoStreams {
    stdout: (line: string) => void;
    stderr: (line: string) => void;
}

export interface CliCommandContext<TValues extends Record<string, any> = Record<string, any>> {
    values: TValues;
    positionals: string[];
    rawArgv: string[];
    io: CliIoStreams;
}

export type CliCommandHandler<TResult = any, TValues extends Record<string, any> = Record<string, any>> = (
    ctx: CliCommandContext<TValues>
) => Promise<TResult> | TResult;

export interface CliCommandSpec<TResult = any, TValues extends Record<string, any> = Record<string, any>> {
    description?: string;
    summary?: string;
    options?: Record<string, CliOptionSpec>;
    run?: CliCommandHandler<TResult, TValues>;
    handler?: CliCommandHandler<TResult, TValues>;
}

export type CliCommandEntry<TResult = any> = CliCommandHandler<TResult> | CliCommandSpec<TResult>;

export interface DefineCliConfig {
    name?: string;
    version?: string;
    description?: string;
    options?: Record<string, CliOptionSpec>;
    commands?: Record<string, CliCommandEntry>;
}

export interface CliRunResult<TResult = any> {
    exitCode: number;
    result: TResult;
    error?: unknown;
}

export interface CliRunner {
    readonly name: string;
    readonly version: string;
    formatHelp: () => string;
    run: (argv?: string[], io?: Partial<CliIoStreams>) => Promise<CliRunResult>;
}

export declare function withSingleInstanceLock<TResult = unknown>(
    lockFilePath: string,
    fn: (ctx: SingleInstanceLockContext) => Promise<TResult> | TResult,
    options?: SingleInstanceLockOptions
): Promise<LegoEnvelope<SingleInstanceLockData<TResult>, SingleInstanceLockHeldDetails>>;

export declare function attachDaemonSignals(
    cleanupFn?: ((reason: string) => Promise<unknown> | unknown) | null,
    options?: AttachDaemonSignalsOptions
): DaemonSignalsHandle;

export declare function appendJsonlRecord(
    filePath: string,
    record: unknown
): AppendJsonlResult;

export declare function defineCli(config?: DefineCliConfig): CliRunner;
