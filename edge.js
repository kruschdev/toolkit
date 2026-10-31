/**
 * @module edge
 * @description Pure Web-Standards edge runtime bricks (`INV-LEGO-01`, `INV-LEGO-08`) for
 * Cloudflare Workers, Pages Functions, Deno, Bun, and modern Web `fetch(request, env, ctx)` runtimes.
 * Uses strictly standard Web globals (`Request`, `Response`, `Headers`, `URL`, `ReadableStream`,
 * `TextEncoder`, `TextDecoder`, `AbortController`, `crypto`, `performance`) with zero host-specific imports.
 */

const DEFAULT_EDGE_MAX_BYTES = 1_048_576;
const ALLOW_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
const ALLOW_HEADERS = 'Content-Type, Authorization, X-Request-ID';
const FORBIDDEN_PARAM_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Check whether a string contains CR or LF characters.
 *
 * @param {string} value - Input string to inspect
 * @returns {boolean}
 */
function hasCrLf(value) {
    return /[\r\n]/.test(value);
}

/**
 * Strip CR/LF characters and trim surrounding whitespace for safe header emission.
 *
 * @param {unknown} rawValue - Candidate header value
 * @returns {string}
 */
function sanitizeSingleLineHeader(rawValue) {
    return String(rawValue ?? '').replace(/[\r\n]+/g, '').trim();
}

/**
 * Normalize a `Headers` instance or plain header record into a plain object without prototype hazards.
 *
 * @param {Headers|Record<string, string>|null|undefined} input - Header collection
 * @returns {Record<string, string>}
 */
function normalizeHeadersRecord(input) {
    if (!input || typeof input !== 'object') return {};
    if (typeof Headers !== 'undefined' && input instanceof Headers) {
        return Object.fromEntries(input.entries());
    }
    const out = {};
    for (const [key, value] of Object.entries(input)) {
        if (value !== undefined && value !== null && !FORBIDDEN_PARAM_KEYS.has(key)) {
            out[key] = String(value);
        }
    }
    return out;
}

/**
 * Generate a correlation ID using standard Web Crypto `randomUUID` with a deterministic-shape fallback.
 *
 * @returns {string}
 */
function generateRequestId() {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
        return globalThis.crypto.randomUUID();
    }
    return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Read a monotonic millisecond timestamp across edge and standard Web runtimes.
 *
 * @returns {number}
 */
function nowMs() {
    return typeof globalThis.performance?.now === 'function'
        ? globalThis.performance.now()
        : Date.now();
}

/**
 * Build a deterministic `INV-LEGO-01` success envelope for edge handlers.
 *
 * @param {string} tool - Originating service or tool identifier
 * @param {string} summary - Concise human-readable status summary
 * @param {object} [data={}] - Response payload object
 * @returns {{ ok: true, tool: string, summary: string, data: object }}
 */
export function edgeOkEnvelope(tool, summary, data = {}) {
    return {
        ok: true,
        tool: String(tool || 'edge'),
        summary: String(summary || 'OK'),
        data: data ?? {},
    };
}

/**
 * Build a deterministic `INV-LEGO-01` error envelope for edge handlers.
 *
 * @param {string} code - Machine-readable error code
 * @param {string} message - Human-readable error message
 * @param {unknown} [details=null] - Optional structured diagnostic details
 * @param {string} [tool='edge'] - Originating service or tool identifier
 * @returns {{ ok: false, tool: string, summary: string, error: { code: string, message: string, details?: unknown } }}
 */
export function edgeErrorEnvelope(code, message, details = null, tool = 'edge') {
    return {
        ok: false,
        tool: String(tool || 'edge'),
        summary: String(message || code || 'Request failed'),
        error: {
            code: String(code || 'EDGE_ERROR'),
            message: String(message || 'Request failed'),
            ...(details !== null && details !== undefined ? { details } : {}),
        },
    };
}

/**
 * Normalize an origin string, returning `''` when blank, CR/LF-tainted, `'null'`, or `'false'`.
 *
 * @param {unknown} candidate - Raw origin string
 * @returns {string}
 */
function normalizeSafeOrigin(candidate) {
    if (typeof candidate !== 'string' || hasCrLf(candidate)) return '';
    const trimmed = candidate.trim();
    if (!trimmed) return '';
    const lowered = trimmed.toLowerCase();
    if (lowered === 'null' || lowered === 'false') return '';
    return trimmed;
}

/**
 * Compute Web-Standards CORS response headers while rejecting `Origin: null`, `Origin: false`, and CR/LF (`INV-LEGO-08`).
 *
 * @param {Request|string|null|undefined} requestOrOrigin - Incoming `Request` or raw `Origin` header string
 * @param {string[]} [allowedOrigins=['*']] - Allowed origin list or `['*']`
 * @returns {Record<string, string>}
 */
export function edgeCorsHeaders(requestOrOrigin, allowedOrigins = ['*']) {
    const rawOrigin = typeof requestOrOrigin === 'string'
        ? requestOrOrigin
        : requestOrOrigin?.headers?.get?.('origin') || '';

    const rawList = Array.isArray(allowedOrigins)
        ? allowedOrigins
        : typeof allowedOrigins === 'string'
          ? [allowedOrigins]
          : [];
    const normalizedAllowed = rawList.map(normalizeSafeOrigin).filter(Boolean);

    if (normalizedAllowed.includes('*')) {
        return {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': ALLOW_METHODS,
            'Access-Control-Allow-Headers': ALLOW_HEADERS,
        };
    }

    const cleanOrigin = normalizeSafeOrigin(rawOrigin);
    if (cleanOrigin && normalizedAllowed.includes(cleanOrigin)) {
        return {
            Vary: 'Origin',
            'Access-Control-Allow-Origin': cleanOrigin,
            'Access-Control-Allow-Credentials': 'true',
            'Access-Control-Allow-Methods': ALLOW_METHODS,
            'Access-Control-Allow-Headers': ALLOW_HEADERS,
        };
    }

    return {
        Vary: 'Origin',
    };
}

/**
 * Create a JSON `Response` with `nosniff`, optional CORS headers, and caller header overrides.
 *
 * @param {unknown} payload - JSON-serializable response payload
 * @param {object} [options={}] - Response options
 * @param {number} [options.status=200] - HTTP status code
 * @param {Headers|Record<string, string>} [options.headers={}] - Explicit response headers
 * @param {Headers|Record<string, string>} [options.corsHeaders={}] - Computed CORS headers
 * @returns {Response}
 */
export function edgeJsonResponse(payload, { status = 200, headers = {}, corsHeaders = {} } = {}) {
    return new Response(JSON.stringify(payload ?? null), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'X-Content-Type-Options': 'nosniff',
            ...normalizeHeadersRecord(corsHeaders),
            ...normalizeHeadersRecord(headers),
        },
    });
}

/**
 * Wrap an `INV-LEGO-01` success envelope in a Web `Response`.
 *
 * @param {string} tool - Originating service or tool name
 * @param {string} summary - Human-readable summary
 * @param {object} [data={}] - Response payload data
 * @param {object} [options={}] - HTTP status and header options
 * @returns {Response}
 */
export function edgeOkResponse(tool, summary, data = {}, options = {}) {
    const opts = options || {};
    return edgeJsonResponse(edgeOkEnvelope(tool, summary, data), {
        status: opts.status ?? 200,
        headers: opts.headers,
        corsHeaders: opts.corsHeaders,
    });
}

/**
 * Wrap an `INV-LEGO-01` error envelope in a Web `Response`.
 *
 * @param {string} code - Machine-readable error code
 * @param {string} message - Human-readable error message
 * @param {object} [options={}] - Error response options
 * @param {number} [options.status=400] - HTTP status code
 * @param {unknown} [options.details=null] - Structured diagnostic metadata
 * @param {string} [options.tool='edge'] - Originating service or tool name
 * @param {Headers|Record<string, string>} [options.headers={}] - Additional headers
 * @param {Headers|Record<string, string>} [options.corsHeaders={}] - Computed CORS headers
 * @returns {Response}
 */
export function edgeErrorResponse(
    code,
    message,
    { status = 400, details = null, tool = 'edge', headers = {}, corsHeaders = {} } = {}
) {
    return edgeJsonResponse(edgeErrorEnvelope(code, message, details, tool), {
        status,
        headers,
        corsHeaders,
    });
}

/**
 * Convert an incoming stream chunk into a `Uint8Array` view without copying when already typed.
 *
 * @param {unknown} value - Stream chunk value
 * @param {TextEncoder} encoder - Shared UTF-8 encoder fallback
 * @returns {Uint8Array}
 */
function toUint8Chunk(value, encoder) {
    if (value instanceof Uint8Array) return value;
    if (ArrayBuffer.isView(value)) {
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    return encoder.encode(String(value));
}

/**
 * Concatenate multiple `Uint8Array` chunks into a single contiguous buffer.
 *
 * @param {Uint8Array[]} chunks - Collected byte chunks
 * @param {number} totalBytes - Total byte count across chunks
 * @returns {Uint8Array}
 */
function concatUint8Chunks(chunks, totalBytes) {
    if (chunks.length === 1) return chunks[0];
    const combined = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return combined;
}

/**
 * Read and parse a bounded JSON body from a Web `Request`, enforcing `maxBytes` on both
 * `Content-Length` and chunked `ReadableStream` payloads (`INV-LEGO-08`).
 *
 * @param {Request} request - Incoming Web `Request`
 * @param {object} [options={}] - Reader options
 * @param {number} [options.maxBytes=1048576] - Maximum allowed payload size in bytes
 * @param {string} [options.tool='edge'] - Tool identifier for error envelopes
 * @param {Record<string, string>} [options.corsHeaders={}] - CORS headers to preserve on `400`/`413` responses
 * @returns {Promise<{ ok: true, data: any } | { ok: false, response: Response }>}
 */
export async function readBoundedEdgeJson(
    request,
    { maxBytes = DEFAULT_EDGE_MAX_BYTES, tool = 'edge', corsHeaders = {} } = {}
) {
    const rawLength = request?.headers?.get?.('content-length');
    if (rawLength !== null && rawLength !== undefined && rawLength.trim() !== '') {
        const declaredBytes = Number(rawLength);
        if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
            try {
                await request.body?.cancel?.();
            } catch {
                // Ignore stream cancel errors on rejected oversized request
            }
            return {
                ok: false,
                response: edgeErrorResponse(
                    'PAYLOAD_TOO_LARGE',
                    `Request body exceeds ${maxBytes} bytes`,
                    { status: 413, tool, corsHeaders }
                ),
            };
        }
    }

    if (!request?.body) {
        return { ok: true, data: {} };
    }

    const reader = request.body.getReader();
    const encoder = new TextEncoder();
    const chunks = [];
    let totalBytes = 0;

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value === undefined || value === null) continue;

            const bytes = toUint8Chunk(value, encoder);
            totalBytes += bytes.byteLength;
            if (totalBytes > maxBytes) {
                chunks.length = 0;
                try {
                    await reader.cancel();
                } catch {
                    // Ignore reader cancel errors
                }
                return {
                    ok: false,
                    response: edgeErrorResponse(
                        'PAYLOAD_TOO_LARGE',
                        `Request body exceeds ${maxBytes} bytes`,
                        { status: 413, tool, corsHeaders }
                    ),
                };
            }
            if (bytes.byteLength > 0) {
                chunks.push(bytes);
            }
        }
    } finally {
        try {
            reader.releaseLock?.();
        } catch {
            // Lock may already be released after cancel
        }
    }

    if (totalBytes === 0) {
        return { ok: true, data: {} };
    }

    const decoder = new TextDecoder('utf-8', { fatal: false });
    const rawText = decoder.decode(concatUint8Chunks(chunks, totalBytes));
    if (rawText.trim() === '') {
        return { ok: true, data: {} };
    }

    try {
        const parsed = JSON.parse(rawText);
        return { ok: true, data: parsed };
    } catch {
        return {
            ok: false,
            response: edgeErrorResponse('INVALID_JSON', 'Malformed JSON request body', {
                status: 400,
                tool,
                corsHeaders,
            }),
        };
    }
}

/**
 * Format a Server-Sent Events frame safely across single-line JSON and multi-line strings.
 *
 * @param {string} event - SSE event name
 * @param {unknown} data - Event payload
 * @returns {string}
 */
function formatEdgeSseFrame(event, data) {
    const safeEvent = String(event || 'message').replace(/[\r\n]+/g, ' ').trim() || 'message';
    const dataBlock = typeof data === 'string'
        ? data
              .replace(/\r\n/g, '\n')
              .replace(/\r/g, '\n')
              .split('\n')
              .map((line) => `data: ${line}`)
              .join('\n')
        : `data: ${JSON.stringify(data ?? null)}`;
    return `event: ${safeEvent}\n${dataBlock}\n\n`;
}

/**
 * Stream Server-Sent Events over a Web `ReadableStream` with automatic `AbortController`
 * propagation on `request.signal` abort and `ReadableStream.cancel()` (`INV-LEGO-08`).
 *
 * @param {(sse: {
 *   signal: AbortSignal,
 *   send: (event: string, data: unknown) => boolean,
 *   sendToken: (delta: string) => boolean,
 *   done: (summary?: string, data?: object) => void,
 *   error: (code: string, message?: string, details?: unknown) => void
 * }) => Promise<void>|void} producer - Async SSE producer callback
 * @param {object} [options={}] - SSE stream configuration
 * @param {Request|null} [options.request=null] - Incoming request for `signal` linkage
 * @param {string} [options.tool='edge.sse'] - Tool identifier for terminal envelopes
 * @param {Record<string, string>} [options.corsHeaders={}] - CORS headers to attach
 * @param {number} [options.retryMs=3000] - Client reconnection `retry:` hint in milliseconds
 * @returns {Response}
 */
export function edgeSseResponse(
    producer,
    { request = null, tool = 'edge.sse', corsHeaders = {}, retryMs = 3000 } = {}
) {
    const resolvedTool = String(tool || 'edge.sse');
    const controller = new AbortController();
    const encoder = new TextEncoder();
    let streamController = null;
    let streamClosed = false;
    let terminalSent = false;

    const onRequestAbort = () => {
        if (!controller.signal.aborted) {
            controller.abort(request?.signal?.reason);
        }
    };

    if (request?.signal) {
        if (request.signal.aborted) {
            controller.abort(request.signal.reason);
        } else {
            request.signal.addEventListener('abort', onRequestAbort, { once: true });
        }
    }

    const cleanupSignalListener = () => {
        if (request?.signal) {
            request.signal.removeEventListener('abort', onRequestAbort);
        }
    };

    const enqueueRaw = (frameText) => {
        if (streamClosed || !streamController) return false;
        try {
            streamController.enqueue(encoder.encode(frameText));
            return true;
        } catch {
            streamClosed = true;
            if (!controller.signal.aborted) {
                controller.abort();
            }
            return false;
        }
    };

    const closeStream = () => {
        cleanupSignalListener();
        if (streamClosed) return;
        streamClosed = true;
        try {
            streamController?.close();
        } catch {
            // Stream controller already closed
        }
    };

    const sse = {
        signal: controller.signal,
        send(event, data) {
            return enqueueRaw(formatEdgeSseFrame(event, data));
        },
        sendToken(delta) {
            return sse.send('token', { delta: String(delta ?? '') });
        },
        done(summary = 'Stream complete', data = {}) {
            if (terminalSent) return;
            terminalSent = true;
            if (summary && typeof summary === 'object' && !Array.isArray(summary)) {
                const envTool = String(summary.tool || resolvedTool);
                const envSummary = String(summary.summary || 'Stream complete');
                const envData = summary.data !== undefined ? summary.data : summary;
                sse.send('done', edgeOkEnvelope(envTool, envSummary, envData));
            } else {
                sse.send('done', edgeOkEnvelope(resolvedTool, summary || 'Stream complete', data ?? {}));
            }
            closeStream();
        },
        error(code, message, details = null) {
            if (terminalSent) return;
            terminalSent = true;
            if (code && typeof code === 'object') {
                const errCode = String(code.code || 'STREAM_ERROR');
                const errMsg = String(code.message || 'Stream failed');
                const errDetails = code.details !== undefined ? code.details : null;
                sse.send('error', edgeErrorEnvelope(errCode, errMsg, errDetails, resolvedTool));
            } else {
                const errCode = String(code || 'STREAM_ERROR');
                const errMsg = String(message || code || 'Stream failed');
                sse.send('error', edgeErrorEnvelope(errCode, errMsg, details, resolvedTool));
            }
            closeStream();
        },
    };

    const stream = new ReadableStream({
        start(ctrl) {
            streamController = ctrl;
            if (controller.signal.aborted) {
                streamClosed = true;
                cleanupSignalListener();
                ctrl.close();
                return;
            }
            if (Number.isFinite(retryMs) && retryMs > 0) {
                enqueueRaw(`retry: ${Math.floor(retryMs)}\n\n`);
            }
            (async () => {
                try {
                    if (typeof producer === 'function') {
                        await producer(sse);
                    }
                    if (!terminalSent && !controller.signal.aborted && !streamClosed) {
                        sse.done('Stream complete', {});
                    }
                } catch (err) {
                    if (
                        !terminalSent &&
                        !controller.signal.aborted &&
                        !streamClosed &&
                        err?.name !== 'AbortError'
                    ) {
                        sse.error(
                            err?.code || 'STREAM_ERROR',
                            err?.message || String(err || 'Stream failed'),
                            err?.details ?? null
                        );
                    }
                } finally {
                    closeStream();
                }
            })();
        },
        cancel(reason) {
            streamClosed = true;
            cleanupSignalListener();
            if (!controller.signal.aborted) {
                controller.abort(reason);
            }
        },
    });

    return new Response(stream, {
        status: 200,
        headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            'X-Accel-Buffering': 'no',
            'X-Content-Type-Options': 'nosniff',
            ...normalizeHeadersRecord(corsHeaders),
        },
    });
}

/**
 * Create a JSON key-value store backed by a Cloudflare Workers `KVNamespace` or an in-memory `Map`
 * fallback with deterministic TTL expiration and prototype-safe key handling (`INV-LEGO-08`).
 *
 * @param {object|null} [kvNamespace=null] - Optional Workers KV binding (`get`, `put`, `delete`, `list`)
 * @param {object} [options={}] - Store configuration
 * @param {string} [options.prefix=''] - Optional key namespace prefix
 * @param {number|null} [options.defaultTtlSeconds=null] - Optional default TTL in seconds
 * @returns {{
 *   get: (key: string) => Promise<any>,
 *   put: (key: string, value: unknown, options?: { ttlSeconds?: number|null, expirationTtl?: number|null }) => Promise<boolean>,
 *   del: (key: string) => Promise<boolean>,
 *   list: (options?: { limit?: number, cursor?: string }) => Promise<{ keys: Array<{ name: string, expiration?: number }>, list_complete: boolean, cursor?: string }>
 * }}
 */
export function createEdgeKvJsonStore(kvNamespace = null, { prefix = '', defaultTtlSeconds = null } = {}) {
    const keyPrefix = String(prefix ?? '');
    const hasExternalKv = Boolean(
        kvNamespace &&
            typeof kvNamespace === 'object' &&
            typeof kvNamespace.get === 'function' &&
            typeof kvNamespace.put === 'function'
    );
    const memoryMap = new Map();

    const toFullKey = (key) => `${keyPrefix}${String(key ?? '')}`;
    const stripPrefix = (fullKey) =>
        keyPrefix && fullKey.startsWith(keyPrefix) ? fullKey.slice(keyPrefix.length) : fullKey;

    const purgeExpiredMemoryKeys = () => {
        const now = Date.now();
        for (const [k, entry] of memoryMap.entries()) {
            if (entry.expiresAt !== null && now >= entry.expiresAt) {
                memoryMap.delete(k);
            }
        }
    };

    return {
        async get(key) {
            const fullKey = toFullKey(key);
            if (hasExternalKv) {
                const raw = await kvNamespace.get(fullKey);
                if (raw === null || raw === undefined) return null;
                if (typeof raw !== 'string') return raw;
                try {
                    return JSON.parse(raw);
                } catch {
                    return null;
                }
            }
            const entry = memoryMap.get(fullKey);
            if (!entry) return null;
            if (entry.expiresAt !== null && Date.now() >= entry.expiresAt) {
                memoryMap.delete(fullKey);
                return null;
            }
            try {
                return JSON.parse(entry.serialized);
            } catch {
                return null;
            }
        },

        async put(key, value, putOptions = {}) {
            const opts = putOptions || {};
            const rawTtl = Object.prototype.hasOwnProperty.call(opts, 'ttlSeconds')
                ? opts.ttlSeconds
                : Object.prototype.hasOwnProperty.call(opts, 'expirationTtl')
                  ? opts.expirationTtl
                  : defaultTtlSeconds;
            const fullKey = toFullKey(key);
            const serialized = JSON.stringify(value ?? null);

            if (hasExternalKv) {
                const numericTtl = rawTtl !== null && rawTtl !== undefined ? Number(rawTtl) : NaN;
                if (Number.isFinite(numericTtl) && numericTtl > 0) {
                    await kvNamespace.put(fullKey, serialized, { expirationTtl: numericTtl });
                } else {
                    await kvNamespace.put(fullKey, serialized);
                }
                return true;
            }

            let expiresAt = null;
            if (rawTtl !== null && rawTtl !== undefined) {
                const numericTtl = Number(rawTtl);
                if (Number.isFinite(numericTtl) && numericTtl > 0) {
                    expiresAt = Date.now() + numericTtl * 1000;
                }
            }
            memoryMap.set(fullKey, { serialized, expiresAt });
            return true;
        },

        async del(key) {
            const fullKey = toFullKey(key);
            if (hasExternalKv) {
                if (typeof kvNamespace.delete === 'function') {
                    await kvNamespace.delete(fullKey);
                    return true;
                }
                return false;
            }
            return memoryMap.delete(fullKey);
        },

        async list({ limit = 100, cursor = undefined } = {}) {
            const pageLimit = Math.max(1, Math.floor(Number(limit) || 100));
            if (hasExternalKv && typeof kvNamespace.list === 'function') {
                const rawList = await kvNamespace.list({
                    ...(keyPrefix ? { prefix: keyPrefix } : {}),
                    limit: pageLimit,
                    ...(cursor !== undefined ? { cursor } : {}),
                });
                const keys = Array.isArray(rawList?.keys)
                    ? rawList.keys.map((item) => ({
                          ...item,
                          name: stripPrefix(String(item?.name ?? '')),
                      }))
                    : [];
                return {
                    keys,
                    list_complete: Boolean(rawList?.list_complete ?? true),
                    ...(rawList?.cursor ? { cursor: rawList.cursor } : {}),
                };
            }

            purgeExpiredMemoryKeys();
            const matching = [];
            for (const [fullKey, entry] of memoryMap.entries()) {
                if (!keyPrefix || fullKey.startsWith(keyPrefix)) {
                    matching.push([fullKey, entry]);
                }
            }
            const startIndex = cursor !== undefined
                ? Math.max(0, Number.parseInt(String(cursor), 10) || 0)
                : 0;
            const page = matching.slice(startIndex, startIndex + pageLimit);
            const nextIndex = startIndex + page.length;
            const listComplete = nextIndex >= matching.length;

            return {
                keys: page.map(([fullKey, entry]) => ({
                    name: stripPrefix(fullKey),
                    ...(entry.expiresAt !== null
                        ? { expiration: Math.ceil(entry.expiresAt / 1000) }
                        : {}),
                })),
                list_complete: listComplete,
                ...(listComplete ? {} : { cursor: String(nextIndex) }),
            };
        },
    };
}

/**
 * Split a pathname into non-empty raw segments without decoding percent escapes.
 *
 * @param {string} pathname - URL pathname
 * @returns {string[]}
 */
function splitRawPathSegments(pathname) {
    if (!pathname || pathname === '/') return [];
    return pathname.split('/').filter((seg) => seg.length > 0);
}

/**
 * Decode raw URL path segments using `decodeURIComponent`, returning `{ ok: false }` on malformed `%ZZ`.
 *
 * @param {string} pathname - Raw URL pathname
 * @returns {{ ok: true, segments: string[] } | { ok: false }}
 */
function decodeUrlPathSegments(pathname) {
    const rawSegments = splitRawPathSegments(pathname);
    const decoded = [];
    for (const rawSeg of rawSegments) {
        try {
            decoded.push(decodeURIComponent(rawSeg));
        } catch {
            return { ok: false };
        }
    }
    return { ok: true, segments: decoded };
}

/**
 * Compile route map entries (`"GET /api/items"`, `"POST /api/items/:id"`, `"ALL /api/*"`) safely.
 *
 * @param {Record<string, Function|object>} routes - Raw route table
 * @returns {Array<{ method: string, patternSegments: string[], handler: Function, rawBody: boolean, parseJson: boolean, maxBodyBytes?: number }>}
 */
function compileEdgeRoutes(routes) {
    if (!routes || typeof routes !== 'object') return [];
    const compiled = [];
    for (const [routeKey, routeSpec] of Object.entries(routes)) {
        if (FORBIDDEN_PARAM_KEYS.has(routeKey)) continue;
        const handler = typeof routeSpec === 'function' ? routeSpec : routeSpec?.handler;
        if (typeof handler !== 'function') continue;

        const trimmedKey = String(routeKey).trim();
        const spaceIdx = trimmedKey.indexOf(' ');
        const rawMethod = spaceIdx === -1 ? 'ALL' : trimmedKey.slice(0, spaceIdx).trim().toUpperCase();
        const rawPattern = spaceIdx === -1 ? trimmedKey : trimmedKey.slice(spaceIdx + 1).trim();
        const method = rawMethod === '*' || !rawMethod ? 'ALL' : rawMethod;

        compiled.push({
            method,
            rawPattern: rawPattern || '/',
            patternSegments: splitRawPathSegments(rawPattern || '/'),
            handler,
            rawBody: Boolean(routeSpec?.rawBody || handler?.rawBody),
            parseJson: routeSpec?.parseJson !== false && handler?.parseJson !== false,
            maxBodyBytes: routeSpec?.maxBodyBytes ?? handler?.maxBodyBytes,
        });
    }
    return compiled;
}

/**
 * Match a request method and decoded path segments against compiled routes.
 *
 * @param {ReturnType<typeof compileEdgeRoutes>} compiledRoutes - Compiled route list
 * @param {string} method - Uppercase HTTP method
 * @param {string[]} decodedSegments - Decoded path segments
 * @returns {{ route: object, params: Record<string, string> } | null}
 */
function matchCompiledRoute(compiledRoutes, method, decodedSegments) {
    for (const route of compiledRoutes) {
        const methodMatches =
            route.method === 'ALL' ||
            route.method === method ||
            (method === 'HEAD' && route.method === 'GET');
        if (!methodMatches) continue;

        const pat = route.patternSegments;
        const params = {};
        let matched = true;
        let hasWildcard = false;

        for (let i = 0; i < pat.length; i += 1) {
            const token = pat[i];
            if (token === '*') {
                hasWildcard = true;
                params['*'] = decodedSegments.slice(i).join('/');
                break;
            }
            if (i >= decodedSegments.length) {
                matched = false;
                break;
            }
            if (token.startsWith(':') && token.length > 1) {
                const paramName = token.slice(1);
                if (!FORBIDDEN_PARAM_KEYS.has(paramName)) {
                    params[paramName] = decodedSegments[i];
                }
                continue;
            }
            if (token !== decodedSegments[i]) {
                matched = false;
                break;
            }
        }

        if (matched && (hasWildcard || pat.length === decodedSegments.length)) {
            return { route, params };
        }
    }
    return null;
}

/**
 * Attach `X-Request-ID`, `X-Response-Time-Ms`, `X-Content-Type-Options: nosniff`, and `corsHeaders`
 * safely even when an upstream `Response` carries immutable headers.
 *
 * @param {Response} response - Outgoing Web `Response`
 * @param {object} meta - Request correlation and timing metadata
 * @returns {Response}
 */
function finalizeEdgeResponse(response, { requestId, startMs, corsHeaders }) {
    const elapsedMs = Math.max(0, nowMs() - startMs).toFixed(2);
    const merged = new Headers(response.headers);
    for (const [key, value] of Object.entries(corsHeaders)) {
        if (!merged.has(key)) {
            merged.set(key, value);
        }
    }
    if (!merged.has('X-Content-Type-Options')) {
        merged.set('X-Content-Type-Options', 'nosniff');
    }
    merged.set('X-Request-ID', requestId);
    merged.set('X-Response-Time-Ms', elapsedMs);

    try {
        for (const [key, value] of merged.entries()) {
            response.headers.set(key, value);
        }
        return response;
    } catch {
        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: merged,
        });
    }
}

/**
 * Execute the built-in `/health` and `/doctor` edge probe and return a `200` or `503` `Response`.
 *
 * @param {object} cfg - Health check parameters
 * @returns {Promise<Response>}
 */
async function evaluateEdgeHealth({ serviceName, version, healthCheck, request, env, ctx, corsHeaders }) {
    let extra = null;
    if (typeof healthCheck === 'function') {
        try {
            const result = await healthCheck({ request, env, ctx });
            if (result === false || (result && typeof result === 'object' && result.ok === false)) {
                const msg =
                    result?.message ||
                    result?.summary ||
                    result?.error?.message ||
                    'Service unhealthy';
                const details = result?.details ?? result?.error?.details ?? null;
                return edgeErrorResponse('UNHEALTHY', msg, {
                    status: 503,
                    details,
                    tool: serviceName,
                    corsHeaders,
                });
            }
            if (result && typeof result === 'object' && !Array.isArray(result)) {
                extra = result;
            }
        } catch (err) {
            return edgeErrorResponse('UNHEALTHY', err?.message || 'Health check failed', {
                status: 503,
                tool: serviceName,
                corsHeaders,
            });
        }
    }

    return edgeOkResponse(
        serviceName,
        'Service healthy',
        {
            service: serviceName,
            version,
            ...(extra && typeof extra === 'object' ? extra : {}),
        },
        { corsHeaders }
    );
}

/**
 * Create a pure Web-Standards edge router returning `{ async fetch(request, env, ctx) }`
 * for Cloudflare Workers, Pages Functions, Deno, Bun, and modern Fetch runtimes (`INV-LEGO-08`).
 *
 * @param {object} [options={}] - Router configuration
 * @param {string} [options.serviceName='krusch-edge'] - Service/tool identifier in envelopes
 * @param {string} [options.version='1.0.0'] - Semantic version reported on `/health` and `/doctor`
 * @param {string[]} [options.corsOrigins=['*']] - Allowed CORS origins
 * @param {number} [options.maxBodyBytes=1048576] - Maximum JSON request body size in bytes
 * @param {Function|null} [options.healthCheck=null] - Optional async health check `({ request, env, ctx })`
 * @param {Record<string, Function|object>} [options.routes={}] - Route table keyed by `"METHOD /path"`
 * @param {string|null} [options.assetsBinding='ASSETS'] - Optional `env[assetsBinding]` static fetcher binding
 * @returns {{ fetch: (request: Request, env?: Record<string, any>, ctx?: any) => Promise<Response> }}
 */
export function createEdgeRouter({
    serviceName = 'krusch-edge',
    version = '1.0.0',
    corsOrigins = ['*'],
    maxBodyBytes = DEFAULT_EDGE_MAX_BYTES,
    healthCheck = null,
    routes = {},
    assetsBinding = 'ASSETS',
} = {}) {
    const compiledRoutes = compileEdgeRoutes(routes);

    return {
        async fetch(request, env = {}, ctx = {}) {
            const startMs = nowMs();
            const corsHeaders = edgeCorsHeaders(request, corsOrigins);
            const incomingId = sanitizeSingleLineHeader(request?.headers?.get?.('x-request-id'));
            const requestId = incomingId || generateRequestId();
            const meta = { requestId, startMs, corsHeaders };

            try {
                const method = String(request?.method || 'GET').toUpperCase();
                if (method === 'OPTIONS') {
                    return finalizeEdgeResponse(new Response(null, { status: 204, headers: corsHeaders }), meta);
                }

                let url;
                try {
                    url = new URL(request?.url || '/', 'http://localhost');
                } catch {
                    return finalizeEdgeResponse(
                        edgeErrorResponse('INVALID_PATH', 'Invalid request URL', {
                            status: 400,
                            tool: serviceName,
                            corsHeaders,
                        }),
                        meta
                    );
                }

                const decodedPath = decodeUrlPathSegments(url.pathname);
                if (!decodedPath.ok) {
                    return finalizeEdgeResponse(
                        edgeErrorResponse('INVALID_PATH', 'Malformed URL path encoding', {
                            status: 400,
                            tool: serviceName,
                            corsHeaders,
                        }),
                        meta
                    );
                }

                if (
                    (method === 'GET' || method === 'HEAD') &&
                    (url.pathname === '/health' || url.pathname === '/doctor')
                ) {
                    const healthRes = await evaluateEdgeHealth({
                        serviceName,
                        version,
                        healthCheck,
                        request,
                        env,
                        ctx,
                        corsHeaders,
                    });
                    return finalizeEdgeResponse(healthRes, meta);
                }

                const matched = matchCompiledRoute(compiledRoutes, method, decodedPath.segments);
                if (matched) {
                    const { route, params } = matched;
                    const contentType = String(request?.headers?.get?.('content-type') || '').toLowerCase();
                    let body = route.rawBody ? null : {};

                    if (
                        !route.rawBody &&
                        route.parseJson &&
                        (method === 'POST' || method === 'PUT' || method === 'PATCH') &&
                        contentType.includes('application/json')
                    ) {
                        const parsedBody = await readBoundedEdgeJson(request, {
                            maxBytes: route.maxBodyBytes ?? maxBodyBytes,
                            tool: serviceName,
                            corsHeaders,
                        });
                        if (!parsedBody.ok) {
                            return finalizeEdgeResponse(parsedBody.response, meta);
                        }
                        body = parsedBody.data;
                    }

                    const handlerResult = await route.handler({
                        request,
                        env,
                        ctx,
                        url,
                        params,
                        query: Object.fromEntries(url.searchParams),
                        body,
                        requestId,
                        corsHeaders,
                        json: (payload, opts = {}) =>
                            edgeJsonResponse(payload, { corsHeaders, ...opts }),
                        ok: (summary, data = {}, opts = {}) =>
                            edgeOkResponse(serviceName, summary, data, { corsHeaders, ...opts }),
                        fail: (code, message, opts = {}) =>
                            edgeErrorResponse(code, message, { tool: serviceName, corsHeaders, ...opts }),
                    });

                    if (handlerResult instanceof Response) {
                        return finalizeEdgeResponse(handlerResult, meta);
                    }
                    if (handlerResult !== undefined && handlerResult !== null && typeof handlerResult === 'object') {
                        return finalizeEdgeResponse(
                            edgeJsonResponse(handlerResult, { corsHeaders }),
                            meta
                        );
                    }
                    return finalizeEdgeResponse(new Response(null, { status: 204, headers: corsHeaders }), meta);
                }

                if (
                    (method === 'GET' || method === 'HEAD') &&
                    assetsBinding &&
                    typeof env?.[assetsBinding]?.fetch === 'function'
                ) {
                    const assetRes = await env[assetsBinding].fetch(request);
                    return finalizeEdgeResponse(assetRes, meta);
                }

                return finalizeEdgeResponse(
                    edgeErrorResponse('NOT_FOUND', `Route not found: ${method} ${url.pathname}`, {
                        status: 404,
                        tool: serviceName,
                        corsHeaders,
                    }),
                    meta
                );
            } catch (err) {
                const rawStatus = Number(err?.status || err?.statusCode);
                const status =
                    Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus <= 599 ? rawStatus : 500;
                return finalizeEdgeResponse(
                    edgeErrorResponse(
                        err?.code || 'INTERNAL_ERROR',
                        err?.message || 'Internal server error',
                        {
                            status,
                            details: err?.details ?? null,
                            tool: serviceName,
                            corsHeaders,
                        }
                    ),
                    meta
                );
            }
        },
    };
}
