/**
 * @module react
 * @description React utilities, hooks, AbortController-safe data/SSE Legos, and zero-JSX UI shell components for Krusch Homelab frontends.
 */

import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

let _React = null;
try {
    const mod = await import('react');
    _React = mod?.default && !mod.useState ? mod.default : mod;
} catch {
    _React = null;
}

/**
 * Inject or override the active React runtime (e.g., for headless Node tests or custom React instances).
 *
 * @param {object|null} runtime React runtime object exposing createElement, hooks, and/or Component.
 */
export function setReactRuntime(runtime) {
    _React = runtime;
}

/**
 * Get the currently resolved React runtime, or null when running headless without React installed.
 *
 * @returns {object|null} Active React runtime or null.
 */
export function getReactRuntime() {
    return _React;
}

function requireReact() {
    if (!_React) {
        throw new Error('@krusch/toolkit/react requires "react" (>=18) in the host app or setReactRuntime() in headless tests.');
    }
    return _React;
}

/**
 * Conflict-free Tailwind class merger.
 * Combines clsx and tailwind-merge to dynamically resolve Tailwind class overlaps.
 * 
 * @param {...any} inputs Array of tailwind classes or conditions.
 * @returns {string} Concatentated, conflict-free class string.
 * @example
 * cn("px-4 py-2 bg-zinc-900 border", active && "bg-white text-black", className)
 */
export function cn(...inputs) {
    return twMerge(clsx(inputs));
}

/**
 * Standardized High-Prestige Style Tokens for Krusch Fleet Frontends.
 * Use these tokens in layout headers, cards, and buttons to guarantee uniform aesthetics.
 */
export const STYLES = {
    // Glassmorphism overlays
    glass: {
        dark: "bg-black/40 border border-white/5 backdrop-blur-lg",
        light: "bg-white/10 border border-white/10 backdrop-blur-md",
        premium: "bg-gradient-to-br from-white/10 to-white/0 border border-white/10 backdrop-blur-xl shadow-2xl"
    },
    // Sub-glow container highlights
    glow: {
        cyan: "shadow-[0_0_15px_rgba(6,182,212,0.15)] border-cyan-500/20",
        purple: "shadow-[0_0_15px_rgba(168,85,247,0.15)] border-purple-500/20",
        emerald: "shadow-[0_0_15px_rgba(16,185,129,0.15)] border-emerald-500/20"
    },
    // Rich gradient standards
    gradients: {
        text: "bg-clip-text text-transparent bg-gradient-to-r from-white via-white/90 to-white/60",
        textCosmic: "bg-clip-text text-transparent bg-gradient-to-r from-cyan-400 via-fuchsia-500 to-indigo-500",
        bgDark: "bg-radial-at-t from-zinc-900 via-black to-black"
    }
};

const AESTHETIC_THEMES = Object.freeze({
    cyber: Object.freeze({
        variant: 'cyber',
        bg: 'min-h-screen bg-zinc-950 text-zinc-100 selection:bg-cyan-500/30',
        surface: cn(STYLES.glass.dark, 'border-cyan-500/20'),
        card: cn(STYLES.glass.dark, STYLES.glow.cyan, 'rounded-xl p-5'),
        glow: STYLES.glow.cyan,
        headingText: STYLES.gradients.textCosmic,
        mutedText: 'text-zinc-400',
        badge: 'inline-flex items-center gap-1.5 rounded-full border border-cyan-500/30 bg-cyan-500/10 px-2.5 py-0.5 text-xs font-medium text-cyan-300',
        buttonPrimary: 'inline-flex items-center justify-center rounded-lg bg-cyan-500 px-4 py-2 text-sm font-semibold text-zinc-950 shadow-[0_0_15px_rgba(6,182,212,0.3)] transition hover:bg-cyan-400 disabled:opacity-50',
        buttonGhost: 'inline-flex items-center justify-center rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm font-medium text-zinc-200 transition hover:bg-white/10 disabled:opacity-50',
        input: 'w-full rounded-lg border border-white/10 bg-zinc-900/80 px-3.5 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-cyan-500/50 focus:outline-none focus:ring-1 focus:ring-cyan-500/40'
    }),
    glass: Object.freeze({
        variant: 'glass',
        bg: 'min-h-screen bg-neutral-950 text-white selection:bg-purple-500/30',
        surface: STYLES.glass.premium,
        card: cn(STYLES.glass.light, STYLES.glow.purple, 'rounded-xl p-5'),
        glow: STYLES.glow.purple,
        headingText: STYLES.gradients.text,
        mutedText: 'text-neutral-400',
        badge: 'inline-flex items-center gap-1.5 rounded-full border border-purple-400/30 bg-purple-500/10 px-2.5 py-0.5 text-xs font-medium text-purple-200',
        buttonPrimary: 'inline-flex items-center justify-center rounded-lg bg-white px-4 py-2 text-sm font-semibold text-black shadow-lg transition hover:bg-neutral-200 disabled:opacity-50',
        buttonGhost: 'inline-flex items-center justify-center rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm font-medium text-white transition hover:bg-white/15 disabled:opacity-50',
        input: 'w-full rounded-lg border border-white/15 bg-white/5 px-3.5 py-2 text-sm text-white placeholder:text-neutral-400 backdrop-blur-md focus:border-purple-400/60 focus:outline-none focus:ring-1 focus:ring-purple-400/40'
    }),
    emerald: Object.freeze({
        variant: 'emerald',
        bg: 'min-h-screen bg-zinc-950 text-zinc-100 selection:bg-emerald-500/30',
        surface: cn(STYLES.glass.dark, 'border-emerald-500/20'),
        card: cn(STYLES.glass.dark, STYLES.glow.emerald, 'rounded-xl p-5'),
        glow: STYLES.glow.emerald,
        headingText: 'bg-clip-text text-transparent bg-gradient-to-r from-emerald-300 via-teal-200 to-cyan-300',
        mutedText: 'text-zinc-400',
        badge: 'inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-0.5 text-xs font-medium text-emerald-300',
        buttonPrimary: 'inline-flex items-center justify-center rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-zinc-950 shadow-[0_0_15px_rgba(16,185,129,0.3)] transition hover:bg-emerald-400 disabled:opacity-50',
        buttonGhost: 'inline-flex items-center justify-center rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-sm font-medium text-emerald-100 transition hover:bg-emerald-500/15 disabled:opacity-50',
        input: 'w-full rounded-lg border border-emerald-500/20 bg-zinc-900/80 px-3.5 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500/60 focus:outline-none focus:ring-1 focus:ring-emerald-500/40'
    })
});

function hasActiveReactDispatcher(runtime) {
    if (!runtime || typeof runtime.useMemo !== 'function') {
        return false;
    }
    const react18Internals = runtime.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
    if (react18Internals?.ReactCurrentDispatcher) {
        return Boolean(react18Internals.ReactCurrentDispatcher.current);
    }
    const react19Internals = runtime.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
    if (react19Internals && 'H' in react19Internals) {
        return Boolean(react19Internals.H);
    }
    return true;
}

/**
 * Resolve design token class bundles for Krusch Homelab themes ('cyber', 'glass', 'emerald').
 * Memoizes on [variant] when an active React hook runtime is present, and works directly in headless/SSR contexts.
 *
 * @param {'cyber'|'glass'|'emerald'} [variant='cyber'] Aesthetic theme variant.
 * @returns {{ variant: string, bg: string, surface: string, card: string, glow: string, headingText: string, mutedText: string, badge: string, buttonPrimary: string, buttonGhost: string, input: string }}
 */
export function useAesthetics(variant = 'cyber') {
    const resolveTokens = () =>
        Object.hasOwn(AESTHETIC_THEMES, variant) ? AESTHETIC_THEMES[variant] : AESTHETIC_THEMES.cyber;
    if (hasActiveReactDispatcher(_React)) {
        try {
            return _React.useMemo(resolveTokens, [variant]);
        } catch {
            return resolveTokens();
        }
    }
    return resolveTokens();
}

/**
 * Hook to check if the component is mounted on the client side.
 * Prevents hydration mismatches in Next.js/SSR environments.
 * 
 * @returns {boolean} Whether the component has mounted on the client.
 * @example
 * const isMounted = useMounted();
 * if (!isMounted) return <Skeleton />;
 */
export function useMounted() {
    const React = requireReact();
    const [mounted, setMounted] = React.useState(false);

    React.useEffect(() => {
        setMounted(true);
    }, []);

    return mounted;
}

/**
 * Hook to reactively track a CSS media query.
 * 
 * @param {string} query The media query to check (e.g. '(min-width: 768px)')
 * @returns {boolean} Whether the query currently matches.
 * @example
 * const isDesktop = useMediaQuery('(min-width: 1024px)');
 */
export function useMediaQuery(query) {
    const React = requireReact();
    const [value, setValue] = React.useState(false);

    React.useEffect(() => {
        function onChange(event) {
            setValue(event.matches);
        }

        if (typeof window === 'undefined') return undefined;

        const result = window.matchMedia(query);
        result.addEventListener('change', onChange);
        setValue(result.matches);

        return () => result.removeEventListener('change', onChange);
    }, [query]);

    return value;
}

/**
 * Hook to trigger a handler callback when a user clicks outside a referenced element.
 * Useful for menus, drawers, and modal dismissals.
 * 
 * @param {Object} ref React ref pointing to the container element.
 * @param {(event: Event) => void} handler The callback function to fire when clicking outside.
 * @example
 * const ref = useRef(null);
 * useClickOutside(ref, () => setIsOpen(false));
 */
export function useClickOutside(ref, handler) {
    const React = requireReact();
    React.useEffect(() => {
        if (typeof document === 'undefined') return undefined;

        const listener = (event) => {
            const el = ref?.current;
            if (!el || el.contains(event?.target || null)) {
                return;
            }
            handler(event);
        };

        document.addEventListener('mousedown', listener);
        document.addEventListener('touchstart', listener);

        return () => {
            document.removeEventListener('mousedown', listener);
            document.removeEventListener('touchstart', listener);
        };
    }, [ref, handler]);
}

/**
 * Hook to copy text to the clipboard with status tracking.
 * 
 * @param {Object} [options]
 * @param {number} [options.timeout=2000] Milliseconds to display the "copied" success status before reverting. Set to 0 to disable reset.
 * @param {() => void} [options.onCopy] Callback fired immediately after a successful copy.
 * @returns {{ isCopied: boolean, copyToClipboard: (value: string) => Promise<void> }}
 * @example
 * const { isCopied, copyToClipboard } = useCopyToClipboard();
 * <button onClick={() => copyToClipboard('Hello World')}>
 *   {isCopied ? 'Copied!' : 'Copy Code'}
 * </button>
 */
export function useCopyToClipboard({ timeout = 2000, onCopy } = {}) {
    const React = requireReact();
    const [isCopied, setIsCopied] = React.useState(false);

    const copyToClipboard = async (value) => {
        if (typeof window === 'undefined' || !navigator.clipboard || !navigator.clipboard.writeText) {
            console.warn('⚠️ Clipboard API is not available in this environment');
            return;
        }

        if (!value) return;

        try {
            await navigator.clipboard.writeText(value);
            setIsCopied(true);

            if (onCopy) {
                onCopy();
            }

            if (timeout !== 0) {
                setTimeout(() => {
                    setIsCopied(false);
                }, timeout);
            }
        } catch (err) {
            console.error('❌ Failed to copy text:', err);
        }
    };

    return { isCopied, copyToClipboard };
}

function isPlainObject(value) {
    if (value === null || typeof value !== 'object') {
        return false;
    }
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

function normalizeHeadersObject(headers = {}) {
    if (headers && typeof headers.entries === 'function') {
        return Object.fromEntries(headers.entries());
    }
    return { ...headers };
}

function hasHeaderCaseInsensitive(headersObj, targetName) {
    const lower = targetName.toLowerCase();
    return Object.keys(headersObj).some((key) => key.toLowerCase() === lower);
}

function createAbortDomError(message = 'The operation was aborted.', name = 'AbortError', code = 'ABORT_ERR') {
    const err = new Error(message);
    err.name = name;
    err.code = code;
    return err;
}

function toAbortRejection(reason) {
    if (reason instanceof Error) {
        return reason;
    }
    const message = typeof reason === 'string' && reason.length > 0 ? reason : 'The operation was aborted.';
    return createAbortDomError(message, 'AbortError', 'ABORT_ERR');
}

function raceWithSignal(promise, signal) {
    if (!signal) {
        return promise;
    }
    if (signal.aborted) {
        Promise.resolve(promise).catch(() => {});
        return Promise.reject(toAbortRejection(signal.reason));
    }

    let onAbort = null;
    const abortPromise = new Promise((_, reject) => {
        onAbort = () => reject(toAbortRejection(signal.reason));
        signal.addEventListener('abort', onAbort, { once: true });
    });

    const guarded = Promise.resolve(promise);
    guarded.catch(() => {});

    return Promise.race([guarded, abortPromise]).finally(() => {
        if (onAbort) {
            signal.removeEventListener('abort', onAbort);
        }
    });
}

async function parseFetchJsonPayload(res, url, signal) {
    if (typeof res.text === 'function') {
        const rawText = await raceWithSignal(res.text(), signal);
        if (!rawText || rawText.trim().length === 0) {
            return null;
        }
        try {
            return JSON.parse(rawText);
        } catch {
            if (res.ok) {
                const parseErr = new Error(`Invalid JSON response from ${url}`);
                parseErr.status = res.status ?? 200;
                parseErr.code = 'INVALID_JSON';
                parseErr.details = rawText.slice(0, 500);
                throw parseErr;
            }
            return null;
        }
    }
    if (typeof res.json === 'function') {
        return raceWithSignal(res.json(), signal);
    }
    return null;
}

/**
 * AbortController-safe JSON API client supporting caller signal linking, timeout cancellation,
 * automatic plain-object JSON serialization, and Krusch envelope ({ ok, data, error }) unwrapping.
 *
 * @param {string} url Request URL.
 * @param {Object} [options]
 * @param {AbortSignal} [options.signal] Caller AbortSignal to link.
 * @param {number} [options.timeoutMs=15000] Request timeout in milliseconds (<= 0 disables timeout).
 * @param {Record<string, string>|Headers} [options.headers={}] HTTP request headers.
 * @param {typeof fetch} [options.fetchImpl=globalThis.fetch] Fetch implementation override for testing.
 * @param {boolean} [options.unwrapEnvelope=true] Unwrap { ok: true, data } responses automatically.
 * @returns {Promise<any>} Parsed response data or payload.
 */
export async function fetchApiJson(
    url,
    { signal, timeoutMs = 15000, headers = {}, fetchImpl = globalThis.fetch, unwrapEnvelope = true, ...init } = {}
) {
    if (typeof fetchImpl !== 'function') {
        throw new Error('fetchApiJson requires a valid fetch implementation.');
    }

    const controller = new AbortController();
    const onCallerAbort = () => {
        controller.abort(toAbortRejection(signal?.reason));
    };

    if (signal) {
        if (signal.aborted) {
            onCallerAbort();
        } else {
            signal.addEventListener('abort', onCallerAbort, { once: true });
        }
    }

    let timeoutId = null;
    if (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0 && !controller.signal.aborted) {
        timeoutId = setTimeout(() => {
            controller.abort(createAbortDomError(`Request timed out after ${timeoutMs}ms`, 'TimeoutError', 'TIMEOUT_ERROR'));
        }, timeoutMs);
    }

    const requestHeaders = normalizeHeadersObject(headers);
    if (!hasHeaderCaseInsensitive(requestHeaders, 'Accept')) {
        requestHeaders.Accept = 'application/json';
    }

    let requestBody = init.body;
    if (isPlainObject(requestBody)) {
        if (!hasHeaderCaseInsensitive(requestHeaders, 'Content-Type')) {
            requestHeaders['Content-Type'] = 'application/json';
        }
        requestBody = JSON.stringify(requestBody);
    }

    try {
        if (controller.signal.aborted) {
            throw toAbortRejection(controller.signal.reason);
        }

        const res = await raceWithSignal(
            fetchImpl(url, {
                ...init,
                headers: requestHeaders,
                ...(requestBody !== undefined ? { body: requestBody } : {}),
                signal: controller.signal
            }),
            controller.signal
        );

        const payload = await parseFetchJsonPayload(res, url, controller.signal);

        if (!res.ok || payload?.ok === false) {
            const message =
                payload?.error?.message ||
                payload?.summary ||
                payload?.message ||
                res.statusText ||
                `Request failed with status ${res.status ?? 'unknown'}`;
            const apiErr = new Error(message);
            apiErr.status = res.status ?? (payload?.ok === false ? 400 : 500);
            apiErr.code = payload?.error?.code || 'HTTP_ERROR';
            apiErr.details = payload?.error?.details;
            apiErr.payload = payload;
            throw apiErr;
        }

        if (unwrapEnvelope !== false && payload && typeof payload === 'object' && payload.ok === true && 'data' in payload) {
            return payload.data;
        }
        return payload;
    } finally {
        if (timeoutId !== null) {
            clearTimeout(timeoutId);
        }
        if (signal && typeof signal.removeEventListener === 'function') {
            signal.removeEventListener('abort', onCallerAbort);
        }
    }
}

/**
 * AbortController-safe declarative React query hook backed by fetchApiJson.
 * Automatically cancels in-flight requests on unmount or when url/deps change.
 *
 * @param {string} url Endpoint URL to fetch.
 * @param {Object} [options]
 * @param {boolean} [options.enabled=true] Whether the query should execute automatically.
 * @param {Array<any>} [options.deps=[]] Additional React effect dependencies.
 * @param {typeof fetch} [options.fetchImpl=globalThis.fetch] Fetch implementation override.
 * @param {Object} [options.requestOptions={}] Extra options forwarded to fetchApiJson.
 * @param {any} [options.initialData=null] Initial state value for data.
 * @returns {{ data: any, loading: boolean, error: Error|null, reload: () => void }}
 */
export function useApiQuery(
    url,
    { enabled = true, deps = [], fetchImpl = globalThis.fetch, requestOptions = {}, initialData = null } = {}
) {
    const React = requireReact();
    const [data, setData] = React.useState(initialData);
    const [loading, setLoading] = React.useState(Boolean(enabled && url));
    const [error, setError] = React.useState(null);
    const [reloadCount, setReloadCount] = React.useState(0);

    const optionsRef = typeof React.useRef === 'function' ? React.useRef(requestOptions) : { current: requestOptions };
    optionsRef.current = requestOptions;

    const reload = React.useCallback(() => {
        setReloadCount((prev) => prev + 1);
    }, []);

    React.useEffect(() => {
        if (!enabled || !url) {
            setLoading(false);
            return undefined;
        }

        const controller = new AbortController();
        setLoading(true);
        setError(null);

        const runQuery = async () => {
            try {
                const result = await fetchApiJson(url, {
                    ...optionsRef.current,
                    fetchImpl,
                    signal: controller.signal
                });
                if (!controller.signal.aborted) {
                    setData(result);
                    setLoading(false);
                }
            } catch (err) {
                if (controller.signal.aborted || err?.name === 'AbortError') {
                    return;
                }
                setError(err);
                setLoading(false);
            }
        };

        runQuery();

        return () => {
            controller.abort();
        };
    }, [url, enabled, fetchImpl, reloadCount, ...deps]);

    return { data, loading, error, reload };
}

function parseSseFrameBlock(rawBlock) {
    const lines = rawBlock.split(/\r?\n/);
    let eventName = 'message';
    let hasEventHeader = false;
    const dataLines = [];

    for (const line of lines) {
        if (!line || line.startsWith(':')) {
            continue;
        }
        if (line.startsWith('event:')) {
            eventName = line.slice(6).trim() || 'message';
            hasEventHeader = true;
        } else if (line.startsWith('data:')) {
            const value = line.slice(5);
            dataLines.push(value.startsWith(' ') ? value.slice(1) : value);
        }
    }

    if (!hasEventHeader && dataLines.length === 0) {
        return null;
    }

    const rawData = dataLines.join('\n');
    if (rawData === '[DONE]') {
        return { event: 'done', data: { done: true } };
    }

    let parsedData = rawData;
    if (rawData.length > 0) {
        try {
            parsedData = JSON.parse(rawData);
        } catch {
            parsedData = rawData;
        }
    }

    return { event: eventName, data: parsedData };
}

function extractTokenDelta(event, data) {
    if (event === 'done' || event === 'error') {
        return '';
    }
    if (event === 'token') {
        if (typeof data === 'string') return data;
        if (data && typeof data === 'object') {
            if (typeof data.delta === 'string') return data.delta;
            if (typeof data.token === 'string') return data.token;
            if (typeof data.text === 'string') return data.text;
        }
        return '';
    }
    if (data && typeof data === 'object' && typeof data.delta === 'string') {
        return data.delta;
    }
    return '';
}

/**
 * AbortController-safe Server-Sent Events (SSE) streaming React hook.
 * Automatically cancels active streams on unmount, stop(), or re-entrant start(body).
 *
 * @param {string} url Streaming SSE endpoint URL.
 * @param {Object} [options]
 * @param {typeof fetch} [options.fetchImpl=globalThis.fetch] Fetch implementation override.
 * @param {string} [options.method='POST'] HTTP method for stream initiation.
 * @param {Record<string, string>|Headers} [options.headers={}] Default HTTP headers.
 * @returns {{ text: string, events: Array<{ event: string, data: any }>, status: 'idle'|'streaming'|'done'|'error', error: Error|null, start: (body?: any) => Promise<void>, stop: () => void, reset: () => void }}
 */
export function useSSEStream(url, { fetchImpl = globalThis.fetch, method = 'POST', headers = {} } = {}) {
    const React = requireReact();
    const [text, setText] = React.useState('');
    const [events, setEvents] = React.useState([]);
    const [status, setStatus] = React.useState('idle');
    const [error, setError] = React.useState(null);

    const activeControllerRef = React.useRef(null);
    const headersRef = React.useRef(headers);
    headersRef.current = headers;

    const abortActive = React.useCallback(() => {
        if (activeControllerRef.current) {
            activeControllerRef.current.abort();
            activeControllerRef.current = null;
        }
    }, []);

    const stop = React.useCallback(() => {
        abortActive();
        setStatus((prev) => (prev === 'streaming' ? 'idle' : prev));
    }, [abortActive]);

    const reset = React.useCallback(() => {
        abortActive();
        setText('');
        setEvents([]);
        setError(null);
        setStatus('idle');
    }, [abortActive]);

    React.useEffect(() => {
        return () => {
            abortActive();
        };
    }, [abortActive]);

    const start = React.useCallback(
        async (body) => {
            abortActive();
            const controller = new AbortController();
            activeControllerRef.current = controller;

            setText('');
            setEvents([]);
            setError(null);
            setStatus('streaming');

            const reqHeaders = normalizeHeadersObject(headersRef.current);
            if (!hasHeaderCaseInsensitive(reqHeaders, 'Accept')) {
                reqHeaders.Accept = 'text/event-stream';
            }

            let reqBody = body;
            if (isPlainObject(reqBody) || Array.isArray(reqBody)) {
                if (!hasHeaderCaseInsensitive(reqHeaders, 'Content-Type')) {
                    reqHeaders['Content-Type'] = 'application/json';
                }
                reqBody = JSON.stringify(reqBody);
            }

            let reader = null;
            let terminalHandled = false;

            const handleParsedFrame = (frame) => {
                if (!frame) return;
                setEvents((prev) => [...prev, frame]);

                const delta = extractTokenDelta(frame.event, frame.data);
                if (delta) {
                    setText((prev) => prev + delta);
                }

                if (frame.event === 'done') {
                    terminalHandled = true;
                    setStatus('done');
                } else if (frame.event === 'error') {
                    terminalHandled = true;
                    const errMessage =
                        frame.data?.error?.message ||
                        frame.data?.message ||
                        (typeof frame.data === 'string' && frame.data ? frame.data : 'SSE stream error');
                    const streamErr = new Error(errMessage);
                    streamErr.code = frame.data?.error?.code || 'SSE_ERROR';
                    setError(streamErr);
                    setStatus('error');
                }
            };

            let streamCompleted = false;
            try {
                const res = await raceWithSignal(
                    fetchImpl(url, {
                        method,
                        headers: reqHeaders,
                        ...(reqBody !== undefined && method.toUpperCase() !== 'GET' ? { body: reqBody } : {}),
                        signal: controller.signal
                    }),
                    controller.signal
                );

                if (!res.ok || !res.body || typeof res.body.getReader !== 'function') {
                    Promise.resolve(res.body?.cancel?.()).catch(() => {});
                    const statusErr = new Error(`SSE request failed with status ${res.status ?? 'unknown'}`);
                    statusErr.status = res.status ?? 500;
                    statusErr.code = 'HTTP_ERROR';
                    throw statusErr;
                }

                reader = res.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';

                while (!controller.signal.aborted) {
                    const { value, done } = await raceWithSignal(reader.read(), controller.signal);
                    if (done) {
                        streamCompleted = true;
                        buffer += decoder.decode();
                        break;
                    }
                    buffer += decoder.decode(value, { stream: true });
                    const blocks = buffer.split(/\r?\n\r?\n/);
                    buffer = blocks.pop() ?? '';
                    for (const block of blocks) {
                        if (block.trim()) {
                            handleParsedFrame(parseSseFrameBlock(block));
                        }
                    }
                }

                if (streamCompleted && !controller.signal.aborted && buffer.trim()) {
                    handleParsedFrame(parseSseFrameBlock(buffer));
                }

                if (!controller.signal.aborted && !terminalHandled) {
                    setStatus('done');
                }
            } catch (err) {
                if (controller.signal.aborted || err?.name === 'AbortError') {
                    return;
                }
                setError(err);
                setStatus('error');
            } finally {
                if (reader) {
                    if (!streamCompleted) {
                        Promise.resolve(reader.cancel()).catch(() => {});
                    } else {
                        reader.releaseLock?.();
                    }
                }
                if (activeControllerRef.current === controller) {
                    activeControllerRef.current = null;
                }
            }
        },
        [url, fetchImpl, method, abortActive]
    );

    return { text, events, status, error, start, stop, reset };
}

const STATUS_PILL_MAP = Object.freeze({
    healthy: Object.freeze({
        label: 'Healthy',
        pill: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
        dot: 'bg-emerald-400'
    }),
    streaming: Object.freeze({
        label: 'Streaming',
        pill: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-300',
        dot: 'bg-cyan-400 animate-pulse'
    }),
    degraded: Object.freeze({
        label: 'Degraded',
        pill: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
        dot: 'bg-amber-400'
    }),
    offline: Object.freeze({
        label: 'Offline',
        pill: 'border-rose-500/30 bg-rose-500/10 text-rose-300',
        dot: 'bg-rose-400'
    })
});

/**
 * Pure createElement status indicator pill supporting 'healthy', 'streaming', 'degraded', and 'offline'.
 *
 * @param {Object} [props]
 * @param {'healthy'|'streaming'|'degraded'|'offline'} [props.status='healthy'] Operational state.
 * @param {string} [props.label] Optional display label override.
 * @param {string} [props.className] Optional Tailwind class overrides.
 * @returns {any} React element.
 */
export function StatusPill({ status = 'healthy', label, className } = {}) {
    const React = requireReact();
    const spec = Object.hasOwn(STATUS_PILL_MAP, status) ? STATUS_PILL_MAP[status] : STATUS_PILL_MAP.healthy;
    const textLabel = label ?? spec.label;

    return React.createElement(
        'span',
        {
            role: 'status',
            'data-status': status,
            className: cn(
                'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium',
                spec.pill,
                className
            )
        },
        React.createElement('span', {
            'aria-hidden': 'true',
            className: cn('h-2 w-2 rounded-full', spec.dot)
        }),
        textLabel
    );
}

/**
 * Pure createElement metric display card with title, prominent KPI value, subtitle, optional StatusPill, and children slot.
 *
 * @param {Object} [props]
 * @param {string} [props.title] Card metric label.
 * @param {string|number} [props.value] Primary KPI figure.
 * @param {string} [props.subtitle] Secondary description or delta text.
 * @param {'healthy'|'streaming'|'degraded'|'offline'} [props.status] Optional status pill state.
 * @param {string} [props.className] Optional Tailwind class overrides.
 * @param {any} [props.children] Optional supplemental content.
 * @returns {any} React element.
 */
export function MetricCard({ title, label, value, subtitle, status, className, children } = {}) {
    const React = requireReact();
    const theme = useAesthetics('cyber');
    const heading = title ?? label;

    return React.createElement(
        'section',
        { className: cn(theme.card, 'flex flex-col gap-2', className) },
        React.createElement(
            'div',
            { className: 'flex items-center justify-between gap-2' },
            heading
                ? React.createElement(
                      'h3',
                      { className: 'text-xs font-semibold uppercase tracking-wider text-zinc-400' },
                      heading
                  )
                : null,
            status ? React.createElement(StatusPill, { status }) : null
        ),
        value !== undefined && value !== null
            ? React.createElement('div', { className: 'text-2xl font-bold tracking-tight text-white' }, String(value))
            : null,
        subtitle ? React.createElement('p', { className: cn('text-xs', theme.mutedText) }, subtitle) : null,
        children ? React.createElement('div', { className: 'mt-1' }, children) : null
    );
}

/**
 * Pure createElement Krusch application shell with optional sidebar navigation, status header, and main content viewport.
 *
 * @param {Object} [props]
 * @param {string} [props.title='Krusch App'] Application header title.
 * @param {string} [props.subtitle] Optional header subtitle.
 * @param {'healthy'|'streaming'|'degraded'|'offline'|any} [props.status='healthy'] Fleet/service health pill status or custom status element.
 * @param {Array<string|{ id: string, label: string, badge?: string|number }>} [props.navItems=[]] Navigation items.
 * @param {string} [props.activeNav] Currently active nav item ID.
 * @param {(id: string, item: any) => void} [props.onSelectNav] Callback fired when a nav item is clicked.
 * @param {any} [props.headerActions] Optional right-aligned header action elements.
 * @param {any} [props.sidebarFooter] Optional footer inside the navigation sidebar.
 * @param {string} [props.className] Optional root container classes.
 * @param {any} [props.children] Main viewport content.
 * @returns {any} React element.
 */
export function AppShell({
    title = 'Krusch App',
    subtitle,
    status = 'healthy',
    navItems = [],
    activeNav,
    onSelectNav,
    headerActions,
    sidebarFooter,
    className,
    children
} = {}) {
    const React = requireReact();
    const theme = useAesthetics('cyber');
    const hasSidebar = Array.isArray(navItems) && navItems.length > 0 || Boolean(sidebarFooter);

    const sidebarNode = hasSidebar
        ? React.createElement(
              'aside',
              {
                  className: cn(
                      theme.surface,
                      'flex w-full shrink-0 flex-col justify-between border-b border-white/10 p-4 md:w-64 md:border-b-0 md:border-r'
                  )
              },
              React.createElement(
                  'nav',
                  { 'aria-label': 'Primary Navigation', className: 'flex flex-col gap-1' },
                  ...navItems.map((rawItem, idx) => {
                      const item = typeof rawItem === 'string' ? { id: rawItem, label: rawItem } : rawItem;
                      const itemId = item.id ?? item.label ?? String(idx);
                      const isActive = activeNav === itemId;
                      return React.createElement(
                          'button',
                          {
                              key: itemId,
                              type: 'button',
                              'aria-current': isActive ? 'page' : undefined,
                              onClick: onSelectNav ? () => onSelectNav(itemId, item) : undefined,
                              className: cn(
                                  'flex items-center justify-between rounded-lg px-3 py-2 text-left text-sm font-medium transition',
                                  isActive
                                      ? 'bg-cyan-500/15 text-cyan-300 border border-cyan-500/30'
                                      : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-100'
                              )
                          },
                          React.createElement('span', null, item.label ?? itemId),
                          item.badge !== undefined
                              ? React.createElement('span', { className: theme.badge }, String(item.badge))
                              : null
                      );
                  })
              ),
              sidebarFooter ? React.createElement('div', { className: 'mt-4 pt-4 border-t border-white/10' }, sidebarFooter) : null
          )
        : null;

    const statusNode = !status
        ? null
        : typeof status === 'string'
          ? React.createElement(StatusPill, { status })
          : status;

    const headerNode = React.createElement(
        'header',
        {
            className: cn(
                theme.surface,
                'flex flex-wrap items-center justify-between gap-4 border-b border-white/10 px-6 py-4'
            )
        },
        React.createElement(
            'div',
            { className: 'flex flex-col gap-0.5' },
            React.createElement('h1', { className: cn('text-lg font-bold tracking-tight', theme.headingText) }, title),
            subtitle ? React.createElement('p', { className: cn('text-xs', theme.mutedText) }, subtitle) : null
        ),
        React.createElement(
            'div',
            { className: 'flex items-center gap-3' },
            statusNode,
            headerActions || null
        )
    );

    return React.createElement(
        'div',
        { className: cn(theme.bg, 'flex min-h-screen flex-col md:flex-row', className) },
        sidebarNode,
        React.createElement(
            'div',
            { className: 'flex min-w-0 flex-1 flex-col' },
            headerNode,
            React.createElement('main', { className: 'flex-1 p-6' }, children)
        )
    );
}

/**
 * Pure createElement streaming chat panel supporting message history, live SSE token delta display, and stop/send controls.
 *
 * @param {Object} [props]
 * @param {string} [props.title='Assistant'] Panel header title.
 * @param {Array<{ id?: string|number, role: string, content?: string, text?: string }>} [props.messages=[]] Chat history messages.
 * @param {string} [props.streamingText=''] Live partial assistant text currently streaming.
 * @param {'idle'|'streaming'|'done'|'error'} [props.status='idle'] Current chat stream status.
 * @param {(message: string) => void} [props.onSend] Callback invoked when user submits a prompt.
 * @param {() => void} [props.onStop] Callback invoked to cancel an active stream.
 * @param {string} [props.placeholder='Ask anything...'] Input placeholder text.
 * @param {string} [props.className] Optional Tailwind container classes.
 * @returns {any} React element.
 */
export function StreamingChatPanel({
    title = 'Assistant',
    messages = [],
    streamingText = '',
    status = 'idle',
    onSend,
    onStop,
    placeholder = 'Ask anything...',
    className
} = {}) {
    const React = requireReact();
    const theme = useAesthetics('cyber');
    const [draft, setDraft] =
        typeof React.useState === 'function' && hasActiveReactDispatcher(React)
            ? React.useState('')
            : ['', () => {}];

    const isStreaming = status === 'streaming';
    const pillStatus = isStreaming ? 'streaming' : status === 'error' ? 'offline' : 'healthy';

    const handleSubmit = (event) => {
        if (event && typeof event.preventDefault === 'function') {
            event.preventDefault();
        }
        const fallbackInput = event?.currentTarget?.elements?.prompt?.value ?? '';
        const textToSend = (draft || fallbackInput).trim();
        if (!textToSend || isStreaming) {
            return;
        }
        if (typeof onSend === 'function') {
            onSend(textToSend);
        }
        setDraft('');
    };

    const messageNodes = messages.map((msg, idx) => {
        const isUser = msg?.role === 'user';
        const bodyText = msg?.content ?? msg?.text ?? '';
        return React.createElement(
            'div',
            {
                key: msg?.id ?? idx,
                className: cn(
                    'max-w-[85%] rounded-xl px-4 py-2.5 text-sm leading-relaxed',
                    isUser
                        ? 'ml-auto bg-cyan-500/20 border border-cyan-500/30 text-cyan-50'
                        : 'mr-auto bg-white/5 border border-white/10 text-zinc-200'
                )
            },
            bodyText
        );
    });

    const streamingNode = streamingText
        ? React.createElement(
              'div',
              {
                  key: '__streaming__',
                  className: 'mr-auto max-w-[85%] rounded-xl border border-cyan-500/30 bg-white/5 px-4 py-2.5 text-sm leading-relaxed text-zinc-100'
              },
              streamingText,
              React.createElement('span', {
                  'aria-hidden': 'true',
                  className: 'ml-1 inline-block h-3.5 w-1.5 animate-pulse bg-cyan-400 align-middle'
              })
          )
        : null;

    return React.createElement(
        'section',
        { className: cn(theme.card, 'flex flex-col gap-4', className) },
        React.createElement(
            'div',
            { className: 'flex items-center justify-between gap-2 border-b border-white/10 pb-3' },
            React.createElement('h2', { className: 'text-sm font-semibold text-white' }, title),
            React.createElement(
                'div',
                { className: 'flex items-center gap-2' },
                React.createElement(StatusPill, {
                    status: pillStatus,
                    label: isStreaming ? 'Streaming' : status === 'error' ? 'Error' : 'Ready'
                }),
                isStreaming && typeof onStop === 'function'
                    ? React.createElement(
                          'button',
                          { type: 'button', onClick: onStop, className: theme.buttonGhost },
                          'Stop'
                      )
                    : null
            )
        ),
        React.createElement(
            'div',
            {
                role: 'log',
                'aria-live': 'polite',
                className: 'flex min-h-[12rem] flex-col gap-3 overflow-y-auto'
            },
            messageNodes.length === 0 && !streamingNode
                ? React.createElement('p', { className: cn('text-xs', theme.mutedText) }, 'No messages yet.')
                : [...messageNodes, ...(streamingNode ? [streamingNode] : [])]
        ),
        React.createElement(
            'form',
            { onSubmit: handleSubmit, className: 'flex items-center gap-2 pt-2 border-t border-white/10' },
            React.createElement('input', {
                name: 'prompt',
                type: 'text',
                value: draft,
                onChange: (event) => setDraft(event?.target?.value ?? ''),
                placeholder,
                disabled: isStreaming,
                className: theme.input
            }),
            React.createElement(
                'button',
                { type: 'submit', disabled: isStreaming, className: theme.buttonPrimary },
                'Send'
            )
        )
    );
}

const _errorBoundaryCache = new WeakMap();

function getErrorBoundaryClass(React) {
    if (!React || typeof React.Component !== 'function') {
        return null;
    }
    const existing = _errorBoundaryCache.get(React);
    if (existing) {
        return existing;
    }

    class KruschRuntimeErrorBoundary extends React.Component {
        constructor(props) {
            super(props);
            this.state = { error: null };
            this.reset = this.reset.bind(this);
        }

        static getDerivedStateFromError(error) {
            return { error };
        }

        componentDidCatch(error, errorInfo) {
            if (typeof this.props?.onError === 'function') {
                this.props.onError(error, errorInfo);
            }
        }

        reset() {
            this.setState({ error: null });
        }

        render() {
            const { error } = this.state;
            if (error) {
                const renderer = this.props?.fallbackRender ?? this.props?.fallback;
                if (typeof renderer === 'function') {
                    return renderer({ error, reset: this.reset });
                }
                if (renderer !== undefined && renderer !== null) {
                    return renderer;
                }
                return React.createElement(
                    'div',
                    {
                        role: 'alert',
                        className: 'rounded-xl border border-rose-500/30 bg-rose-950/40 p-4 text-sm text-rose-200'
                    },
                    React.createElement('p', { className: 'font-semibold text-rose-300' }, 'Component Error'),
                    React.createElement('pre', { className: 'mt-2 overflow-x-auto text-xs' }, String(error?.message || error))
                );
            }
            return this.props?.children ?? null;
        }
    }

    _errorBoundaryCache.set(React, KruschRuntimeErrorBoundary);
    return KruschRuntimeErrorBoundary;
}

/**
 * Create a reusable ErrorBoundary component configured with a custom fallback renderer.
 * Uses a cached dynamic React.Component subclass when available, or renders children directly in headless mode.
 *
 * @param {((ctx: { error: Error, reset: () => void }) => any)|any} fallbackRender Fallback render function or element.
 * @returns {(props?: Object) => any} Configured ErrorBoundary component.
 */
export function createErrorBoundary(fallbackRender) {
    return function ConfiguredErrorBoundary(props = {}) {
        const BoundaryClass = getErrorBoundaryClass(_React);
        if (BoundaryClass && typeof _React?.createElement === 'function') {
            return _React.createElement(BoundaryClass, { fallbackRender, ...props }, props?.children);
        }
        return props?.children ?? null;
    };
}

/**
 * Default Lego ErrorBoundary component.
 * Uses a cached dynamic React.Component subclass when _React.Component is available; otherwise renders props.children.
 *
 * @param {Object} [props]
 * @param {((ctx: { error: Error, reset: () => void }) => any)|any} [props.fallback] Optional fallback UI or render function.
 * @param {((ctx: { error: Error, reset: () => void }) => any)} [props.fallbackRender] Alias for fallback render function.
 * @param {(error: Error, errorInfo: any) => void} [props.onError] Error observer callback.
 * @param {any} [props.children] Child subtree to guard.
 * @returns {any} React element or children.
 */
export function ErrorBoundary(props = {}) {
    const BoundaryClass = getErrorBoundaryClass(_React);
    if (BoundaryClass && typeof _React?.createElement === 'function') {
        return _React.createElement(BoundaryClass, props, props?.children);
    }
    return props?.children ?? null;
}

