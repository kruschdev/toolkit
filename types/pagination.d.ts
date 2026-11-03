import type { ErrorDetail, ErrorEnvelope, LegoEnvelope, OkEnvelope } from './envelopes.js';

export type { ErrorDetail, ErrorEnvelope, LegoEnvelope, OkEnvelope };

export type PaginationDirection = 'asc' | 'desc';

export interface PaginationLimits {
    readonly defaultLimit: number;
    readonly minLimit: number;
    readonly maxLimit: number;
    readonly maxCursorLength: number;
}

export interface ClampPageLimitOptions {
    defaultLimit?: number;
    minLimit?: number;
    maxLimit?: number;
}

export interface EncodeCursorOptions {
    secret?: string;
    scope?: string;
    ttlMs?: number;
    maxCursorLength?: number;
    nowFn?: () => number;
    tool?: string;
}

export interface EncodedCursorData {
    cursor: string;
    signed: boolean;
    expiresAt: number | null;
}

export interface DecodeCursorOptions {
    secret?: string;
    requireSignature?: boolean;
    expectedScope?: string;
    maxCursorLength?: number;
    nowFn?: () => number;
    tool?: string;
}

export interface DecodedCursorData<
    TPayload extends object = Record<string, unknown>
> {
    payload: TPayload;
    scope: string;
    expiresAt: number | null;
    signed: boolean;
}

export interface KeysetCursorPayload<TSortValue = unknown, TId = string | number> {
    sortValue: TSortValue;
    id: TId;
    sortField: string;
    idField: string;
}

export interface BuildKeysetPageOptions {
    limit?: unknown;
    defaultLimit?: number;
    maxLimit?: number;
    sortField?: string;
    idField?: string;
    secret?: string;
    scope?: string;
    ttlMs?: number;
    maxCursorLength?: number;
    nowFn?: () => number;
    tool?: string;
}

export interface KeysetPageInfo {
    limit: number;
    count: number;
    hasMore: boolean;
    nextCursor: string | null;
}

export interface KeysetPageData<TItem extends object = Record<string, unknown>> {
    items: TItem[];
    pageInfo: KeysetPageInfo;
}

export interface PaginateItemsOptions extends BuildKeysetPageOptions {
    cursor?: string | null;
    direction?: PaginationDirection | string;
    requireSignature?: boolean;
}

export declare const DEFAULT_PAGINATION_LIMITS: Readonly<PaginationLimits>;

export declare function clampPageLimit(
    rawLimit: unknown,
    options?: ClampPageLimitOptions
): number;

export declare function encodeCursor(
    cursorPayload: object,
    options?: EncodeCursorOptions
): LegoEnvelope<EncodedCursorData>;

export declare function decodeCursor<
    TPayload extends object = Record<string, unknown>
>(
    rawCursor: unknown,
    options?: DecodeCursorOptions
): LegoEnvelope<DecodedCursorData<TPayload>>;

export declare function buildKeysetPage<
    TItem extends object = Record<string, unknown>
>(
    rows: ReadonlyArray<TItem>,
    options?: BuildKeysetPageOptions
): LegoEnvelope<KeysetPageData<TItem>>;

export declare function paginateItems<
    TItem extends object = Record<string, unknown>
>(
    allItems: ReadonlyArray<TItem>,
    options?: PaginateItemsOptions
): LegoEnvelope<KeysetPageData<TItem>>;
