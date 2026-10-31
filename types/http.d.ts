import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { ErrorDetail, ErrorEnvelope, LegoEnvelope, OkEnvelope } from './envelopes.js';

export type { ErrorDetail, ErrorEnvelope, LegoEnvelope, OkEnvelope };

export type NextFunction = (err?: unknown) => void;

export interface HttpLoggerLike {
    info?: (message: string, meta?: unknown) => void;
    warn?: (message: string, meta?: unknown) => void;
    error?: (message: string, meta?: unknown) => void;
    debug?: (message: string, meta?: unknown) => void;
}

export interface BoundedJsonBodyOptions {
    maxBytes?: number;
    tool?: string;
}

export type HealthCheckResult = boolean | Record<string, unknown> | void | null;
export type HealthCheckFn = () => HealthCheckResult | Promise<HealthCheckResult>;

export interface ExpressBricksOptions {
    serviceName?: string;
    version?: string;
    corsOrigins?: string[];
    healthCheck?: HealthCheckFn | null;
    logger?: HttpLoggerLike | null;
}

export interface ExpressBricks {
    requestContextMiddleware: (req: any, res: any, next?: NextFunction) => void;
    corsMiddleware: (req: any, res: any, next?: NextFunction) => void;
    healthHandler: (req: any, res: any, next?: NextFunction) => Promise<void>;
    doctorHandler: (req: any, res: any, next?: NextFunction) => Promise<void>;
    notFoundHandler: (req: any, res: any, next?: NextFunction) => void;
    errorHandler: (err: any, req: any, res: any, next?: NextFunction | null) => void;
}

export interface ApiRouteContext<TBody = Record<string, unknown>> {
    req: IncomingMessage & { requestId?: string; body?: TBody };
    res: ServerResponse;
    url: URL;
    pathname: string;
    query: Record<string, string>;
    body: TBody;
    requestId: string;
    sendJson: (statusCode: number, payload: unknown) => void;
}

export type ApiRouteHandler<TBody = Record<string, unknown>> = (
    ctx: ApiRouteContext<TBody>
) => unknown | Promise<unknown>;

export interface CreateApiServerOptions {
    serviceName?: string;
    version?: string;
    corsOrigins?: string[];
    maxBodyBytes?: number;
    healthCheck?: HealthCheckFn | null;
    routes?: Record<string, ApiRouteHandler<any>>;
    logger?: HttpLoggerLike | null;
}

export type CleanupFn = () => unknown | Promise<unknown>;

export interface GracefulShutdownOptions {
    timeoutMs?: number;
    logger?: HttpLoggerLike | null;
    signals?: NodeJS.Signals[] | string[];
}

export interface GracefulShutdownHandle {
    shutdown: (reason?: string) => Promise<void>;
    detach: () => void;
}

export interface ClosableServerLike {
    close?: (cb?: (err?: Error & { code?: string }) => void) => void;
    listening?: boolean;
    closeIdleConnections?: () => void;
}

export declare function okEnvelope<TData = Record<string, unknown>>(
    tool: string,
    summary: string,
    data?: TData
): OkEnvelope<TData>;

export declare function errorEnvelope(
    code: string,
    message: string,
    details?: unknown,
    tool?: string
): ErrorEnvelope;

export declare function asyncHandler<
    TReq = IncomingMessage & Record<string, any>,
    TRes = ServerResponse & Record<string, any>
>(
    fn: (req: TReq, res: TRes, next: NextFunction) => unknown | Promise<unknown>
): (req: TReq, res: TRes, next?: NextFunction) => Promise<unknown>;

export declare function createCorsHeaders(
    origin?: string | null,
    allowedOrigins?: string[] | string | null | false
): Record<string, string>;

export declare function readBoundedJsonBody<TBody = Record<string, unknown>>(
    req: (IncomingMessage & { body?: unknown }) | Record<string, any>,
    res: ServerResponse | Record<string, any>,
    options?: BoundedJsonBodyOptions
): Promise<TBody | null>;

export declare function createExpressBricks(options?: ExpressBricksOptions): ExpressBricks;

export declare function createApiServer(options?: CreateApiServerOptions): Server;

export declare function attachGracefulShutdown(
    server: Server | ClosableServerLike | null,
    cleanupFns?: CleanupFn[] | CleanupFn,
    options?: GracefulShutdownOptions
): GracefulShutdownHandle;
