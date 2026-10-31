import type { OkEnvelope, ErrorDetail, ErrorEnvelope, LegoEnvelope } from './envelopes.js';

export type { OkEnvelope, ErrorDetail, ErrorEnvelope, LegoEnvelope };

export type EdgeHeadersInput = Headers | Record<string, string> | null | undefined;

export interface EdgeJsonResponseOptions {
    status?: number;
    headers?: EdgeHeadersInput;
    corsHeaders?: EdgeHeadersInput;
}

export interface EdgeErrorResponseOptions extends EdgeJsonResponseOptions {
    details?: unknown;
    tool?: string;
}

export interface ReadBoundedEdgeJsonOptions {
    maxBytes?: number;
    tool?: string;
    corsHeaders?: Record<string, string>;
}

export type ReadBoundedEdgeJsonResult<TData = any> =
    | { ok: true; data: TData }
    | { ok: false; response: Response };

export interface EdgeSseDoneObject {
    tool?: string;
    summary?: string;
    data?: Record<string, any>;
    [key: string]: unknown;
}

export interface EdgeSseErrorObject {
    code?: string;
    message?: string;
    details?: unknown;
}

export interface EdgeSseHandle {
    readonly signal: AbortSignal;
    send(event: string, data: unknown): boolean;
    sendToken(delta: string): boolean;
    done(summary?: string | EdgeSseDoneObject, data?: Record<string, any>): void;
    error(code: string | EdgeSseErrorObject, message?: string, details?: unknown): void;
}

export interface EdgeSseOptions {
    request?: Request | null;
    tool?: string;
    corsHeaders?: EdgeHeadersInput;
    retryMs?: number;
}

export interface EdgeKvListKey {
    name: string;
    expiration?: number;
    [key: string]: unknown;
}

export interface EdgeKvListResult {
    keys: EdgeKvListKey[];
    list_complete: boolean;
    cursor?: string;
}

export interface EdgeKvNamespaceLike {
    get(key: string): Promise<string | unknown | null>;
    put(key: string, value: string, options?: { expirationTtl?: number }): Promise<unknown>;
    delete?(key: string): Promise<unknown>;
    list?(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<{
        keys?: Array<{ name: string; expiration?: number; [key: string]: unknown }>;
        list_complete?: boolean;
        cursor?: string;
    }>;
}

export interface CreateEdgeKvJsonStoreOptions {
    prefix?: string;
    defaultTtlSeconds?: number | null;
}

export interface EdgeKvPutOptions {
    ttlSeconds?: number | null;
    expirationTtl?: number | null;
}

export interface EdgeKvListOptions {
    limit?: number;
    cursor?: string;
}

export interface EdgeKvJsonStore {
    get<TValue = any>(key: string): Promise<TValue | null>;
    put(key: string, value: unknown, options?: EdgeKvPutOptions): Promise<boolean>;
    del(key: string): Promise<boolean>;
    list(options?: EdgeKvListOptions): Promise<EdgeKvListResult>;
}

export interface EdgeHealthCheckContext<TEnv = Record<string, any>, TExecutionContext = any> {
    request: Request;
    env: TEnv;
    ctx: TExecutionContext;
}

export type EdgeHealthCheckFn<TEnv = Record<string, any>, TExecutionContext = any> = (
    context: EdgeHealthCheckContext<TEnv, TExecutionContext>
) => Promise<Record<string, unknown> | boolean | null | undefined> | Record<string, unknown> | boolean | null | undefined;

export interface EdgeRouteContext<TBody = any, TEnv = Record<string, any>, TExecutionContext = any> {
    request: Request;
    env: TEnv;
    ctx: TExecutionContext;
    url: URL;
    params: Record<string, string>;
    query: Record<string, string>;
    body: TBody;
    requestId: string;
    corsHeaders: Record<string, string>;
    json: (payload: unknown, options?: EdgeJsonResponseOptions) => Response;
    ok: <TData = Record<string, any>>(
        summary: string,
        data?: TData,
        options?: EdgeJsonResponseOptions
    ) => Response;
    fail: (code: string, message: string, options?: EdgeErrorResponseOptions) => Response;
}

export type EdgeRouteHandler<TBody = any, TEnv = Record<string, any>, TExecutionContext = any> = ((
    ctx: EdgeRouteContext<TBody, TEnv, TExecutionContext>
) => Promise<Response | Record<string, any> | void | null | undefined> | Response | Record<string, any> | void | null | undefined) & {
    rawBody?: boolean;
    parseJson?: boolean;
    maxBodyBytes?: number;
};

export interface EdgeRouteSpec<TBody = any, TEnv = Record<string, any>, TExecutionContext = any> {
    handler: EdgeRouteHandler<TBody, TEnv, TExecutionContext>;
    rawBody?: boolean;
    parseJson?: boolean;
    maxBodyBytes?: number;
}

export type EdgeRouteEntry<TBody = any, TEnv = Record<string, any>, TExecutionContext = any> =
    | EdgeRouteHandler<TBody, TEnv, TExecutionContext>
    | EdgeRouteSpec<TBody, TEnv, TExecutionContext>;

export interface CreateEdgeRouterOptions<TEnv = Record<string, any>, TExecutionContext = any> {
    serviceName?: string;
    version?: string;
    corsOrigins?: readonly string[] | string;
    maxBodyBytes?: number;
    healthCheck?: EdgeHealthCheckFn<TEnv, TExecutionContext> | null;
    routes?: Record<string, EdgeRouteEntry<any, TEnv, TExecutionContext>>;
    assetsBinding?: string | null;
}

export interface EdgeRouter<TEnv = Record<string, any>, TExecutionContext = any> {
    fetch(request: Request, env?: TEnv, ctx?: TExecutionContext): Promise<Response>;
}

export declare function edgeOkEnvelope<TData = Record<string, any>>(
    tool: string,
    summary: string,
    data?: TData
): OkEnvelope<TData>;

export declare function edgeErrorEnvelope<TDetails = unknown>(
    code: string,
    message: string,
    details?: TDetails,
    tool?: string
): ErrorEnvelope<TDetails>;

export declare function edgeCorsHeaders(
    requestOrOrigin?: Request | { headers?: { get?: (name: string) => string | null | undefined } } | string | null,
    allowedOrigins?: readonly string[] | string
): Record<string, string>;

export declare function edgeJsonResponse(
    payload: unknown,
    options?: EdgeJsonResponseOptions
): Response;

export declare function edgeOkResponse<TData = Record<string, any>>(
    tool: string,
    summary: string,
    data?: TData,
    options?: EdgeJsonResponseOptions
): Response;

export declare function edgeErrorResponse(
    code: string,
    message: string,
    options?: EdgeErrorResponseOptions
): Response;

export declare function readBoundedEdgeJson<TData = any>(
    request: Request,
    options?: ReadBoundedEdgeJsonOptions
): Promise<ReadBoundedEdgeJsonResult<TData>>;

export declare function edgeSseResponse(
    producer: (sse: EdgeSseHandle) => Promise<void> | void,
    options?: EdgeSseOptions
): Response;

export declare function createEdgeKvJsonStore(
    kvNamespace?: EdgeKvNamespaceLike | null,
    options?: CreateEdgeKvJsonStoreOptions
): EdgeKvJsonStore;

export declare function createEdgeRouter<TEnv = Record<string, any>, TExecutionContext = any>(
    options?: CreateEdgeRouterOptions<TEnv, TExecutionContext>
): EdgeRouter<TEnv, TExecutionContext>;
