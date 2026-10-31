/**
 * @module http
 * @description Canonical HTTP server, Express middleware, bounded JSON body reader,
 * deterministic envelopes (`INV-LEGO-01`), and graceful shutdown bricks for `@krusch/toolkit`.
 */

import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { setupLogging } from './log.js';

const DEFAULT_MAX_BODY_BYTES = 1048576; // 1 MiB

function createDefaultHttpLogger(serviceName) {
    return setupLogging(serviceName, {
        logDir: process.env.KRUSCH_LOG_DIR || path.join(os.tmpdir(), 'krusch-logs'),
        console: false,
    });
}

/**
 * Sanitize header values to prevent CRLF header splitting.
 *
 * @param {unknown} rawValue - Candidate header value
 * @returns {string}
 */
function sanitizeHeaderValue(rawValue) {
    return String(rawValue ?? '').replace(/[\r\n]+/g, '').trim();
}

/**
 * Write a deterministic JSON HTTP response safely across native `http.ServerResponse` and mocks.
 *
 * @param {import('node:http').ServerResponse} res - HTTP response object
 * @param {number} statusCode - HTTP status code
 * @param {object} payload - Serializable JSON body
 * @param {Record<string, string>} [extraHeaders={}] - Additional headers to apply
 */
function sendJsonResponse(res, statusCode, payload, extraHeaders = {}) {
    if (!res || res.writableEnded || res.destroyed || res.headersSent) return;
    const serialized = JSON.stringify(payload);

    const headers = {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': String(Buffer.byteLength(serialized, 'utf8')),
        ...extraHeaders,
    };
    if (typeof res.setHeader === 'function') {
        res.statusCode = statusCode;
        for (const [key, value] of Object.entries(headers)) {
            if (value !== undefined) res.setHeader(key, value);
        }
    } else if (typeof res.writeHead === 'function') {
        res.writeHead(statusCode, headers);
    }

    if (typeof res.end === 'function') {
        res.end(serialized);
    }
}

/**
 * Build a deterministic `INV-LEGO-01` success envelope.
 *
 * @param {string} tool - Originating service or tool name
 * @param {string} summary - Concise human-readable status summary
 * @param {object} [data={}] - Response data payload
 * @returns {{ ok: true, tool: string, summary: string, data: object }}
 */
export function okEnvelope(tool, summary, data = {}) {
    return {
        ok: true,
        tool: String(tool || 'http'),
        summary: String(summary || 'OK'),
        data: data ?? {},
    };
}

/**
 * Build a deterministic `INV-LEGO-01` error envelope.
 *
 * @param {string} code - Machine-readable error code
 * @param {string} message - Human-readable error message
 * @param {unknown} [details=null] - Optional diagnostic metadata
 * @param {string} [tool='http'] - Originating service or tool name
 * @returns {{ ok: false, tool: string, summary: string, error: { code: string, message: string, details?: unknown } }}
 */
export function errorEnvelope(code, message, details = null, tool = 'http') {
    return {
        ok: false,
        tool: String(tool || 'http'),
        summary: String(message || code || 'Request failed'),
        error: {
            code: String(code || 'INTERNAL_ERROR'),
            message: String(message || 'Request failed'),
            ...(details !== null && details !== undefined ? { details } : {}),
        },
    };
}

/**
 * Wrap an async Express route/middleware handler so rejected promises and sync throws forward to `next(err)`.
 *
 * @param {Function} fn - `(req, res, next) => Promise<unknown>`
 * @returns {Function}
 */
export function asyncHandler(fn) {
    return (req, res, next) => {
        try {
            return Promise.resolve(fn(req, res, next)).catch(next);
        } catch (err) {
            if (typeof next === 'function') return next(err);
            throw err;
        }
    };
}

/**
 * Construct CORS and baseline security headers (`nosniff`) for a request origin.
 *
 * @param {string|undefined} origin - Incoming `Origin` request header
 * @param {string[]} [allowedOrigins=['*']] - Allowed origin allowlist or `['*']`
 * @returns {Record<string, string>}
 */
export function createCorsHeaders(origin, allowedOrigins = ['*']) {
    const origins = !allowedOrigins
        ? []
        : Array.isArray(allowedOrigins)
          ? allowedOrigins
                .filter((o) => typeof o === 'string')
                .map((o) => sanitizeHeaderValue(o))
                .filter((o) => o.length > 0 && o !== 'null')
          : typeof allowedOrigins === 'string'
            ? [sanitizeHeaderValue(allowedOrigins)].filter((o) => o.length > 0 && o !== 'null')
            : [];
    const safeOrigin = typeof origin === 'string' ? sanitizeHeaderValue(origin) : '';
    const headers = {
        'X-Content-Type-Options': 'nosniff',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Request-Id',
    };

    if (origins.includes('*')) {
        headers['Access-Control-Allow-Origin'] = '*';
    } else if (safeOrigin && safeOrigin !== 'null' && origins.includes(safeOrigin)) {
        headers['Access-Control-Allow-Origin'] = safeOrigin;
        headers['Vary'] = 'Origin';
    } else if (origins.length > 0) {
        headers['Vary'] = 'Origin';
    }

    return headers;
}

/**
 * Accumulate UTF-8 bytes from an incoming request up to `maxBytes`, draining excess bytes safely
 * without calling `req.destroy()` so clients never experience TCP `ECONNRESET` before reading `413`.
 *
 * @param {import('node:http').IncomingMessage} req - Incoming HTTP request
 * @param {number} maxBytes - Byte limit
 * @returns {Promise<{ tooLarge: boolean, totalBytes: number, raw: string }>}
 */
function drainAndReadUtf8Body(req, maxBytes) {
    const maxDrainBytes = maxBytes + Math.max(maxBytes, 65536);

    return new Promise((resolve, reject) => {
        let totalBytes = 0;
        let tooLarge = false;
        let settled = false;
        const chunks = [];

        const cleanup = () => {
            req.off?.('data', onData);
            req.off?.('end', onEnd);
            req.off?.('error', onError);
            req.off?.('aborted', onAborted);
            req.off?.('close', onClose);
        };

        const settleAborted = () => {
            if (settled) return;
            settled = true;
            chunks.length = 0;
            cleanup();
            resolve({ aborted: true, tooLarge: false, forceClose: false, totalBytes, raw: '' });
        };

        const onData = (chunk) => {
            if (settled) return;
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
            totalBytes += buf.byteLength;
            if (totalBytes > maxBytes) {
                if (!tooLarge) {
                    tooLarge = true;
                    chunks.length = 0;
                }
                if (totalBytes > maxDrainBytes) {
                    settled = true;
                    cleanup();
                    req.pause?.();
                    resolve({ aborted: false, tooLarge: true, forceClose: true, totalBytes, raw: '' });
                }
                return;
            }
            chunks.push(buf);
        };

        const onEnd = () => {
            if (settled) return;
            settled = true;
            cleanup();
            const raw = tooLarge ? '' : Buffer.concat(chunks).toString('utf8');
            chunks.length = 0;
            resolve({ aborted: false, tooLarge, forceClose: false, totalBytes, raw });
        };

        const onAborted = () => {
            settleAborted();
        };

        const onClose = () => {
            settleAborted();
        };

        const onError = (err) => {
            if (settled) return;
            if (req.aborted || req.destroyed || err?.code === 'ECONNRESET') {
                settleAborted();
                return;
            }
            settled = true;
            chunks.length = 0;
            cleanup();
            reject(err);
        };

        req.on('data', onData);
        req.on('end', onEnd);
        req.on('error', onError);
        req.on('aborted', onAborted);
        req.on('close', onClose);
    });
}

/**
 * Safely read and parse a bounded UTF-8 JSON request body (`INV-LEGO-03`).
 * Responds HTTP `413` (`PAYLOAD_TOO_LARGE`) or `400` (`INVALID_JSON`) and returns `null` on failure.
 *
 * @param {import('node:http').IncomingMessage & { body?: unknown }} req - Incoming request
 * @param {import('node:http').ServerResponse} res - Outgoing response
 * @param {object} [options={}] - Reader options
 * @param {number} [options.maxBytes=1048576] - Maximum allowed request body size in bytes
 * @param {string} [options.tool='http'] - Tool identifier for error envelopes
 * @returns {Promise<object|null>} Parsed JSON body or `null` when an error response has been written
 */
export async function readBoundedJsonBody(req, res, { maxBytes = DEFAULT_MAX_BODY_BYTES, tool = 'http' } = {}) {
    if (req?.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
        return req.body;
    }
    if (!req || req.readableEnded) {
        return {};
    }
    if (req.aborted || req.destroyed) {
        return null;
    }

    const { aborted, tooLarge, forceClose, totalBytes, raw } = await drainAndReadUtf8Body(req, maxBytes);
    if (aborted || req.aborted || res?.destroyed) {
        return null;
    }
    if (tooLarge) {
        const payload = errorEnvelope(
            'PAYLOAD_TOO_LARGE',
            `Request body exceeds maximum size of ${maxBytes} bytes`,
            { maxBytes, receivedBytes: totalBytes },
            tool
        );
        sendJsonResponse(res, 413, payload, forceClose ? { Connection: 'close' } : {});
        if (forceClose) {
            if (typeof res?.once === 'function' && !res.writableFinished && !res.destroyed) {
                const fallback = setTimeout(() => req.destroy?.(), 250);
                fallback.unref?.();
                res.once('finish', () => {
                    clearTimeout(fallback);
                    req.destroy?.();
                });
            } else {
                setImmediate(() => req.destroy?.());
            }
        }
        return null;
    }

    if (raw.trim() === '') {
        req.body = {};
        return {};
    }

    try {
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object') {
            sendJsonResponse(res, 400, errorEnvelope('INVALID_JSON', 'Malformed JSON request body', null, tool));
            return null;
        }
        req.body = parsed;
        return parsed;
    } catch {
        sendJsonResponse(res, 400, errorEnvelope('INVALID_JSON', 'Malformed JSON request body', null, tool));
        return null;
    }
}

/**
 * Execute an optional health check callback and send a `200` or `503` JSON envelope.
 *
 * @param {import('node:http').ServerResponse} res - Outgoing response
 * @param {object} cfg - Service configuration
 */
async function respondHealthCheck(res, { serviceName, version, healthCheck }) {
    let extra = {};
    if (typeof healthCheck === 'function') {
        try {
            const checkResult = await healthCheck();
            if (checkResult === false || (checkResult && typeof checkResult === 'object' && checkResult.ok === false)) {
                const msg = checkResult?.message || checkResult?.summary || checkResult?.error?.message || 'Service unhealthy';
                const details = checkResult?.details ?? null;
                sendJsonResponse(res, 503, errorEnvelope('UNHEALTHY', msg, details, serviceName));
                return;
            }
            if (checkResult && typeof checkResult === 'object') {
                extra = checkResult;
            }
        } catch (err) {
            sendJsonResponse(res, 503, errorEnvelope('UNHEALTHY', err?.message || 'Health check failed', null, serviceName));
            return;
        }
    }

    const data = {
        service: serviceName,
        version,
        uptimeSec: Math.round(process.uptime()),
        ...extra,
    };
    sendJsonResponse(res, 200, okEnvelope(serviceName, 'Service healthy', data));
}

/**
 * Create reusable Express/Connect-compatible HTTP middleware and standard operational handlers.
 *
 * @param {object} [options={}] - Brick configuration
 * @param {string} [options.serviceName='krusch-service'] - Service identifier
 * @param {string} [options.version='1.0.0'] - Semantic version string
 * @param {string[]} [options.corsOrigins=['*']] - Allowed CORS origins
 * @param {Function|null} [options.healthCheck=null] - Optional async health check probe
 * @param {object|null} [options.logger=null] - Structured logger instance (defaults to `setupLogging(serviceName)`)
 * @returns {object} Middleware & route handler collection
 */
export function createExpressBricks({
    serviceName = 'krusch-service',
    version = '1.0.0',
    corsOrigins = ['*'],
    healthCheck = null,
    logger = null,
} = {}) {
    const activeLogger = logger || createDefaultHttpLogger(serviceName);

    const requestContextMiddleware = (req, res, next) => {
        const rawHeader = Array.isArray(req.headers?.['x-request-id'])
            ? req.headers['x-request-id'][0]
            : req.headers?.['x-request-id'];
        const requestId = sanitizeHeaderValue(rawHeader) || crypto.randomUUID();
        req.requestId = requestId;
        res.setHeader?.('X-Request-Id', requestId);

        const startNs = process.hrtime.bigint();
        res.on?.('finish', () => {
            const durationMs = Number((Number(process.hrtime.bigint() - startNs) / 1e6).toFixed(2));
            const msg = `${req.method || 'GET'} ${req.url || '/'} ${res.statusCode || 200} (${durationMs}ms)`;
            if (typeof activeLogger?.info === 'function') {
                activeLogger.info(msg, { requestId, statusCode: res.statusCode, durationMs });
            } else if (typeof activeLogger?.debug === 'function') {
                activeLogger.debug(msg, { requestId, statusCode: res.statusCode, durationMs });
            }
        });

        if (typeof next === 'function') next();
    };

    const corsMiddleware = (req, res, next) => {
        const headers = createCorsHeaders(req.headers?.origin, corsOrigins);
        if (typeof res.setHeader === 'function') {
            for (const [key, value] of Object.entries(headers)) {
                res.setHeader(key, value);
            }
        }
        if ((req.method || '').toUpperCase() === 'OPTIONS') {
            if (typeof res.setHeader === 'function') {
                res.statusCode = 204;
            } else if (typeof res.writeHead === 'function') {
                res.writeHead(204, headers);
            }
            res.end?.();
            return;
        }
        if (typeof next === 'function') next();
    };

    const healthHandler = async (_req, res, next) => {
        try {
            await respondHealthCheck(res, { serviceName, version, healthCheck });
        } catch (err) {
            if (typeof next === 'function') next(err);
        }
    };

    const doctorHandler = async (_req, res, next) => {
        try {
            await respondHealthCheck(res, { serviceName, version, healthCheck });
        } catch (err) {
            if (typeof next === 'function') next(err);
        }
    };

    const notFoundHandler = (req, res, _next) => {
        const target = `${req.method || 'GET'} ${req.originalUrl || req.url || '/'}`;
        sendJsonResponse(res, 404, errorEnvelope('NOT_FOUND', `Route not found: ${target}`, null, serviceName));
    };

    const errorHandler = (err, req, res, _next) => {
        const rawStatus = Number(err?.status || err?.statusCode) || 500;
        const statusCode = rawStatus >= 400 && rawStatus <= 599 ? rawStatus : 500;
        activeLogger?.error?.(err?.message || 'Internal server error', {
            requestId: req?.requestId,
            error: err,
        });
        if (res.headersSent) {
            if (typeof _next === 'function') return _next(err);
            res.end?.();
            return;
        }
        const envelope = errorEnvelope(
            err?.code || 'INTERNAL_ERROR',
            err?.message || 'Internal server error',
            err?.details ?? null,
            serviceName
        );
        sendJsonResponse(res, statusCode, envelope);
    };

    return {
        requestContextMiddleware,
        corsMiddleware,
        healthHandler,
        doctorHandler,
        notFoundHandler,
        errorHandler,
    };
}

/**
 * Create a lightweight, zero-Express native `node:http.Server` with built-in `/health`, `/doctor`,
 * CORS preflight, bounded JSON body parsing, request correlation IDs, and deterministic envelopes.
 *
 * @param {object} [options={}] - Server options
 * @param {string} [options.serviceName='krusch-service'] - Service identifier
 * @param {string} [options.version='1.0.0'] - Service version
 * @param {string[]} [options.corsOrigins=['*']] - Allowed CORS origins
 * @param {number} [options.maxBodyBytes=1048576] - Max JSON payload bytes for `POST`/`PUT`/`PATCH`
 * @param {Function|null} [options.healthCheck=null] - Optional async health check probe
 * @param {Record<string, Function>} [options.routes={}] - Route table keyed by `"METHOD /path"` or `"/path"`
 * @param {object|null} [options.logger=null] - Structured logger override
 * @returns {import('node:http').Server}
 */
function parseSafeRequestUrl(rawUrl) {
    const str = typeof rawUrl === 'string' && rawUrl.length > 0 ? rawUrl.trim() : '/';
    let target = str;
    if (/^https?:\/\//i.test(str)) {
        try {
            const abs = new URL(str);
            target = `${abs.pathname || '/'}${abs.search || ''}`;
        } catch {
            return new URL('/', 'http://127.0.0.1');
        }
    }
    const stripped = target.replace(/[\x00-\x1f]+/g, '').replace(/^[\/\\]+/, '');
    const safeTarget = `/${stripped}`;
    try {
        const parsed = new URL(safeTarget, 'http://127.0.0.1');
        if (parsed.origin !== 'http://127.0.0.1') {
            return new URL('/', 'http://127.0.0.1');
        }
        return parsed;
    } catch {
        return new URL('/', 'http://127.0.0.1');
    }
}

export function createApiServer({
    serviceName = 'krusch-service',
    version = '1.0.0',
    corsOrigins = ['*'],
    maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
    healthCheck = null,
    routes = {},
    logger = null,
} = {}) {
    const activeLogger = logger || createDefaultHttpLogger(serviceName);
    const bricks = createExpressBricks({
        serviceName,
        version,
        corsOrigins,
        healthCheck,
        logger: activeLogger,
    });

    return http.createServer(async (req, res) => {
        try {
            bricks.requestContextMiddleware(req, res);
            bricks.corsMiddleware(req, res);
            if (res.writableEnded) return;

            const method = (req.method || 'GET').toUpperCase();
            const parsedUrl = parseSafeRequestUrl(req.url);
            const { pathname } = parsedUrl;
            const query = Object.fromEntries(parsedUrl.searchParams);

            let body = {};
            if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
                const parsedBody = await readBoundedJsonBody(req, res, {
                    maxBytes: maxBodyBytes,
                    tool: serviceName,
                });
                if (parsedBody === null) return;
                body = parsedBody;
            }

            const methodKey = `${method} ${pathname}`;
            const routeHandler =
                routes && typeof routes === 'object'
                    ? Object.hasOwn(routes, methodKey)
                        ? routes[methodKey]
                        : Object.hasOwn(routes, pathname)
                          ? routes[pathname]
                          : undefined
                    : undefined;
            if (!routeHandler) {
                if (method === 'GET' && pathname === '/health') {
                    await bricks.healthHandler(req, res);
                    return;
                }
                if (method === 'GET' && pathname === '/doctor') {
                    await bricks.doctorHandler(req, res);
                    return;
                }
                bricks.notFoundHandler(req, res);
                return;
            }

            const ctx = {
                req,
                res,
                url: parsedUrl,
                pathname,
                query,
                body,
                requestId: req.requestId,
                sendJson: (status, payload) => sendJsonResponse(res, status, payload),
            };

            const result = await routeHandler(ctx);
            if (
                result !== undefined &&
                result !== null &&
                typeof result === 'object' &&
                !res.writableEnded &&
                !res.headersSent &&
                !res.destroyed
            ) {
                const envelope = typeof result.ok === 'boolean'
                    ? result
                    : okEnvelope(serviceName, 'OK', result);
                sendJsonResponse(res, 200, envelope);
            }
        } catch (err) {
            if (req.aborted || res.destroyed || err?.code === 'ECONNRESET') {
                if (!res.writableEnded && !res.destroyed) res.end?.();
                return;
            }
            bricks.errorHandler(err, req, res, null);
        }
    });
}

/**
 * Close a `node:http.Server` safely, ignoring `ERR_SERVER_NOT_RUNNING` and releasing idle keep-alive sockets.
 *
 * @param {import('node:http').Server} server - Target HTTP server
 * @returns {Promise<void>}
 */
function closeHttpServer(server) {
    return new Promise((resolve, reject) => {
        if (!server || typeof server.close !== 'function' || server.listening === false) {
            resolve();
            return;
        }
        server.close((err) => {
            if (err && err.code !== 'ERR_SERVER_NOT_RUNNING') {
                reject(err);
                return;
            }
            resolve();
        });
        server.closeIdleConnections?.();
    });
}

/**
 * Attach deterministic signal-driven graceful shutdown to an HTTP server without leaking listeners.
 *
 * @param {import('node:http').Server} server - Target HTTP server
 * @param {Function[]} [cleanupFns=[]] - Sequential async cleanup callbacks (DB pools, queues, etc.)
 * @param {object} [options={}] - Shutdown configuration
 * @param {number} [options.timeoutMs=5000] - Maximum grace period in milliseconds
 * @param {object|null} [options.logger=null] - Optional logger instance
 * @param {string[]} [options.signals=['SIGTERM', 'SIGINT']] - OS signals to intercept
 * @returns {{ shutdown: (reason?: string) => Promise<void>, detach: () => void }}
 */
export function attachGracefulShutdown(
    server,
    cleanupFns = [],
    { timeoutMs = 5000, logger = null, signals = ['SIGTERM', 'SIGINT'] } = {}
) {
    const callbacks = Array.isArray(cleanupFns) ? cleanupFns : [cleanupFns].filter(Boolean);
    const listeners = [];
    let shutdownPromise = null;

    const detach = () => {
        while (listeners.length > 0) {
            const { sig, handler } = listeners.pop();
            process.off(sig, handler);
        }
    };

    const shutdown = (reason = 'manual') => {
        if (shutdownPromise) return shutdownPromise;
        detach();

        shutdownPromise = (async () => {
            logger?.info?.(`Initiating graceful shutdown (${reason})...`);
            let timer = null;
            const timeoutGuard = new Promise((_, reject) => {
                timer = setTimeout(() => {
                    const err = new Error(`Graceful shutdown timed out after ${timeoutMs}ms`);
                    err.code = 'SHUTDOWN_TIMEOUT';
                    reject(err);
                }, timeoutMs);
                timer.unref?.();
            });

            try {
                await Promise.race([
                    (async () => {
                        let firstError = null;
                        try {
                            await closeHttpServer(server);
                        } catch (err) {
                            firstError = err;
                            logger?.error?.(`HTTP server close error during shutdown: ${err?.message || err}`, err);
                        }
                        for (const fn of callbacks) {
                            if (typeof fn !== 'function') continue;
                            try {
                                await fn();
                            } catch (err) {
                                if (!firstError) firstError = err;
                                logger?.error?.(`Cleanup callback failed during shutdown: ${err?.message || err}`, err);
                            }
                        }
                        if (firstError) throw firstError;
                    })(),
                    timeoutGuard,
                ]);
                logger?.info?.('Graceful shutdown completed.');
            } finally {
                if (timer) clearTimeout(timer);
            }
        })();

        return shutdownPromise;
    };

    for (const sig of signals) {
        const handler = () => {
            shutdown(sig).catch((err) => {
                logger?.error?.(`Graceful shutdown error on ${sig}: ${err?.message || err}`, err);
            });
        };
        listeners.push({ sig, handler });
        process.on(sig, handler);
    }

    return { shutdown, detach };
}
