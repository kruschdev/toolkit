import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ErrorDetail, ErrorEnvelope, LegoEnvelope, OkEnvelope } from './envelopes.js';

export type { ErrorDetail, ErrorEnvelope, LegoEnvelope, OkEnvelope };

export interface DefaultIdempotencyOptions {
    readonly ttlMs: 86400000;
    readonly maxEntries: 10000;
    readonly inFlightTimeoutMs: 60000;
    readonly maxKeyLength: 255;
    readonly headerName: 'idempotency-key';
}

export interface IdempotencyErrorDetails {
    key?: string;
    statusCode?: number;
    length?: number;
    maxKeyLength?: number;
    maxDepth?: number;
    maxEntries?: number;
    maxNodes?: number;
    header?: string;
    [key: string]: unknown;
}

export interface NormalizeIdempotencyKeyOptions {
    maxKeyLength?: number;
    tool?: string;
}

export interface NormalizedIdempotencyKeyData {
    key: string;
}

export interface ComputePayloadFingerprintOptions {
    method?: string;
    path?: string;
    maxDepth?: number;
    tool?: string;
}

export interface PayloadFingerprintData {
    fingerprint: string;
}

export interface CreateIdempotencyStoreOptions {
    ttlMs?: number;
    maxEntries?: number;
    inFlightTimeoutMs?: number;
    maxKeyLength?: number;
    nowFn?: () => number;
}

export interface IdempotencyStoreBeginOptions {
    tool?: string;
}

export interface IdempotencyAcquiredData {
    outcome: 'ACQUIRED';
    key: string;
    fingerprint: string;
    lockToken: string;
}

export interface IdempotencyReplayData<TBody = unknown> {
    outcome: 'REPLAY';
    key: string;
    fingerprint: string;
    statusCode: number;
    body: TBody;
    headers: Record<string, string>;
    storedAt: number;
}

export type IdempotencyBeginData<TBody = unknown> =
    | IdempotencyAcquiredData
    | IdempotencyReplayData<TBody>;

export interface IdempotencyStoreCommitOptions<TBody = unknown> {
    statusCode?: number;
    body?: TBody;
    headers?: Record<string, string>;
    tool?: string;
}

export interface IdempotencyCommitData {
    key: string;
    fingerprint: string;
    statusCode: number;
    storedAt: number;
    expiresAt: number;
}

export interface IdempotencyStoreReleaseOptions {
    tool?: string;
}

export interface IdempotencyReleaseData {
    key: string;
    released: boolean;
}

export interface IdempotencyInFlightRecord {
    readonly state: 'IN_FLIGHT';
    readonly key: string;
    readonly fingerprint: string;
    readonly startedAt: number;
    readonly expiresAt: number;
}

export interface IdempotencyCompletedRecord<TBody = unknown> {
    readonly state: 'COMPLETED';
    readonly key: string;
    readonly fingerprint: string;
    readonly statusCode: number;
    readonly body: TBody;
    readonly headers: Record<string, string>;
    readonly storedAt: number;
    readonly expiresAt: number;
}

export type IdempotencyRecordSnapshot<TBody = unknown> =
    | IdempotencyInFlightRecord
    | IdempotencyCompletedRecord<TBody>;

export interface IdempotencyStore {
    begin<TBody = unknown>(
        key: string,
        fingerprint: string,
        options?: IdempotencyStoreBeginOptions
    ): LegoEnvelope<IdempotencyBeginData<TBody>, IdempotencyErrorDetails>;
    commit<TBody = unknown>(
        key: string,
        lockToken: string,
        options?: IdempotencyStoreCommitOptions<TBody>
    ): LegoEnvelope<IdempotencyCommitData, IdempotencyErrorDetails>;
    release(
        key: string,
        lockToken: string,
        options?: IdempotencyStoreReleaseOptions
    ): LegoEnvelope<IdempotencyReleaseData, IdempotencyErrorDetails>;
    get<TBody = unknown>(key: string): IdempotencyRecordSnapshot<TBody> | null;
    delete(key: string): boolean;
    clear(): void;
    size(): number;
}

export interface WithIdempotencyOptions {
    key: string;
    payload?: unknown;
    method?: string;
    path?: string;
    cacheErrors?: boolean;
    tool?: string;
}

export interface IdempotencyHandlerContext {
    key: string;
    fingerprint: string;
}

export type IdempotencyHandlerFn<TResult = unknown> = (
    ctx: IdempotencyHandlerContext
) => TResult | Promise<TResult>;

export interface WithIdempotencyData<TResult = unknown> {
    replayed: boolean;
    key: string;
    statusCode: number;
    result: TResult;
}

export type IdempotencyNextFn = (err?: unknown) => unknown;

export interface IdempotencyRequestContext {
    key: string;
    scopedKey: string;
    fingerprint: string;
    lockToken: string;
    replayed: boolean;
}

export interface CreateIdempotencyMiddlewareOptions<
    TReq = IncomingMessage & Record<string, any>
> {
    headerName?: string;
    methods?: readonly string[];
    requireHeader?: boolean;
    scopeKeyFn?: ((req: TReq) => string) | null;
    tool?: string;
}

export type IdempotencyMiddleware<
    TReq = IncomingMessage & Record<string, any>,
    TRes = ServerResponse & Record<string, any>
> = (req: TReq, res: TRes, next?: IdempotencyNextFn) => unknown;

export declare const DEFAULT_IDEMPOTENCY_OPTIONS: DefaultIdempotencyOptions;

export declare function normalizeIdempotencyKey(
    rawKey: unknown,
    options?: NormalizeIdempotencyKeyOptions
): LegoEnvelope<NormalizedIdempotencyKeyData, IdempotencyErrorDetails>;

export declare function computePayloadFingerprint(
    payload: unknown,
    options?: ComputePayloadFingerprintOptions
): LegoEnvelope<PayloadFingerprintData, IdempotencyErrorDetails>;

export declare function createIdempotencyStore(
    options?: CreateIdempotencyStoreOptions
): IdempotencyStore;

export declare function withIdempotency<TResult = unknown>(
    store: IdempotencyStore,
    options: WithIdempotencyOptions,
    handlerFn: IdempotencyHandlerFn<TResult>
): Promise<LegoEnvelope<WithIdempotencyData<TResult>, IdempotencyErrorDetails>>;

export declare function createIdempotencyMiddleware<
    TReq = IncomingMessage & Record<string, any>,
    TRes = ServerResponse & Record<string, any>
>(
    store?: IdempotencyStore,
    options?: CreateIdempotencyMiddlewareOptions<TReq>
): IdempotencyMiddleware<TReq, TRes>;
