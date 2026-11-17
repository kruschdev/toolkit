import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ErrorDetail, ErrorEnvelope, LegoEnvelope, OkEnvelope } from './envelopes.js';
import type { EdgeHeadersInput } from './edge.js';

export type { ErrorDetail, ErrorEnvelope, LegoEnvelope, OkEnvelope };

export interface IpClassificationOptions {
    allowPrivateLan?: boolean;
    allowTailscale?: boolean;
}

export interface DnsLookupEntry {
    address: string;
    family?: number;
}

export type DnsLookupResult =
    | DnsLookupEntry[]
    | DnsLookupEntry
    | string[]
    | string;

export type DnsLookupFn = (hostname: string) => Promise<DnsLookupResult> | DnsLookupResult;

export interface ValidateOutboundUrlOptions extends IpClassificationOptions {
    allowedProtocols?: readonly string[];
    allowedHosts?: readonly string[] | ReadonlySet<string> | null;
    lookupFn?: DnsLookupFn | null;
    tool?: string;
}

export interface ValidatedOutboundUrlData {
    url: string;
    hostname: string;
    port: string;
    resolvedAddresses: string[];
}

export interface SsrfErrorDetails {
    url?: string;
    protocol?: string;
    hostname?: string;
    blockedAddress?: string;
    status?: number;
    location?: string;
    maxRedirects?: number;
    timedOut?: boolean;
    code?: string;
    [key: string]: unknown;
}

export interface SafeFetchOptions extends ValidateOutboundUrlOptions {
    maxRedirects?: number;
    timeoutMs?: number;
    fetchImpl?: typeof globalThis.fetch;
}

export interface SafeFetchData {
    status: number;
    url: string;
    redirected: boolean;
    redirects: number;
    headers: Record<string, string>;
    response: Response;
}

export interface CreateRateLimiterOptions {
    windowMs?: number;
    max?: number;
    maxKeys?: number;
    nowFn?: () => number;
    tool?: string;
}

export interface RateLimitAllowedData {
    key: string;
    remaining: number;
    limit: number;
}

export interface RateLimitErrorDetails {
    key: string;
    limit: number;
    retryAfterSeconds: number;
}

export type RateLimitHeaders = {
    'X-RateLimit-Limit': string;
    'X-RateLimit-Remaining': string;
    'X-RateLimit-Reset': string;
    'Retry-After'?: string;
};

export interface RateLimitConsumeResult {
    allowed: boolean;
    limit: number;
    remaining: number;
    resetMs: number;
    retryAfterSeconds: number;
    headers: RateLimitHeaders;
    envelope: LegoEnvelope<RateLimitAllowedData, RateLimitErrorDetails>;
}

export type RateLimitNextFn = (err?: unknown) => unknown;

export interface RateLimitMiddlewareOptions<TReq = IncomingMessage & Record<string, any>> {
    keyGenerator?: (req: TReq) => string;
    trustProxy?: boolean;
    cost?: number;
}

export type RateLimitMiddleware<
    TReq = IncomingMessage & Record<string, any>,
    TRes = ServerResponse & Record<string, any>
> = (req: TReq, res: TRes, next?: RateLimitNextFn) => unknown;

export interface RateLimitEdgeCheckOptions {
    keyGenerator?: (request: Request) => string;
    corsHeaders?: EdgeHeadersInput;
    cost?: number;
}

export interface RateLimitEdgeAllowedResult {
    allowed: true;
    headers: RateLimitHeaders;
    limit: number;
    remaining: number;
    resetMs: number;
    retryAfterSeconds: 0;
    envelope: OkEnvelope<RateLimitAllowedData>;
    response?: undefined;
}

export interface RateLimitEdgeBlockedResult {
    allowed: false;
    headers: RateLimitHeaders;
    limit: number;
    remaining: 0;
    resetMs: number;
    retryAfterSeconds: number;
    envelope: ErrorEnvelope<RateLimitErrorDetails>;
    response: Response;
}

export type RateLimitEdgeCheckResult =
    | RateLimitEdgeAllowedResult
    | RateLimitEdgeBlockedResult;

export interface RateLimiter {
    consume(rawKey?: string, cost?: number): RateLimitConsumeResult;
    reset(rawKey: string): boolean;
    clear(): void;
    size(): number;
    middleware<
        TReq = IncomingMessage & Record<string, any>,
        TRes = ServerResponse & Record<string, any>
    >(
        options?: RateLimitMiddlewareOptions<TReq>
    ): RateLimitMiddleware<TReq, TRes>;
    edgeCheck(request: Request, options?: RateLimitEdgeCheckOptions): RateLimitEdgeCheckResult;
}

export declare function isPrivateOrReservedIp(
    ipString?: string,
    options?: IpClassificationOptions
): boolean;

export declare function validateOutboundUrl(
    rawUrl: string | URL,
    options?: ValidateOutboundUrlOptions
): Promise<LegoEnvelope<ValidatedOutboundUrlData, SsrfErrorDetails>>;

export declare function safeFetch(
    rawUrl: string | URL,
    init?: RequestInit,
    options?: SafeFetchOptions
): Promise<LegoEnvelope<SafeFetchData, SsrfErrorDetails>>;

export declare function createRateLimiter(options?: CreateRateLimiterOptions): RateLimiter;

export interface ScrubMarkers {
    readonly token: string;
    readonly secret: string;
    readonly credentials: string;
    readonly privateUrl: string;
    readonly privateHost: string;
    readonly localPath: string;
    readonly email: string;
    readonly circular: string;
    readonly maxDepth: string;
}

export declare const DEFAULT_SCRUB_MARKERS: ScrubMarkers;

export interface ScrubTextOptions {
    redactEmails?: boolean;
    redactPaths?: boolean;
    redactPrivateNetwork?: boolean;
    markers?: Partial<ScrubMarkers>;
}

export interface ScrubDataOptions extends ScrubTextOptions {
    maxDepth?: number;
    redactSensitiveKeys?: boolean;
}

export type ReadableResponseInput =
    | Response
    | { data?: { response?: Response | null } | null; response?: Response | null };

export declare function scrubSensitiveText(raw: unknown, options?: ScrubTextOptions): string;

export declare function scrubSensitiveData(value: unknown, options?: ScrubDataOptions): unknown;

export declare function scrubPrivateNetworkStrings(
    value: unknown,
    options?: ScrubDataOptions
): unknown;

export declare function readTextWithTimeout(
    res: ReadableResponseInput,
    timeoutMs?: number
): Promise<string>;

export declare function readJsonWithTimeout<T = unknown>(
    res: ReadableResponseInput,
    timeoutMs?: number
): Promise<T>;
