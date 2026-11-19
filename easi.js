/**
 * @module @krusch/toolkit/easi
 * Clean-room MCP client & small-model browser Policy Floor for `easi.run` sandboxed Chrome sessions.
 *
 * Provides:
 * - Persistent or one-shot JSON-RPC 2.0 stdio & HTTP `/mcp` transport (`createEasiClient`, `callEasiMcpTool`)
 * - Automatic `call_id` idempotency keys on state-changing desktop calls
 * - Session & Mojo Policy Floor (`allowStopSession`, `allowNavigate`, `mojoKeyDrainActive` AT-SPI lockout)
 * - Toolbar/omnibox filter (`y >= 82`) & `<2K`-token dual DOM + AT-SPI state builder for 4B-30B local models
 * - Validated 5-verb small-model UI navigation controller (`stepSmallModelNavigator`, `executeValidatedUiDecision`)
 * - Crash-resumable Blink `contenteditable` chunk streamer for Draft.js / ProseMirror / Quill (`streamContentEditableChunks`)
 * - Zero-shell sandboxed file-chooser uploader (`uploadFileViaChooser`)
 */

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chatJson } from './llm.js';

export const DEFAULT_EASI_WATCH_BASE = 'https://localhost:9443';
export const DEFAULT_CHROME_OMNIBOX_MIN_Y = 82;

export const DEFAULT_EDITOR_TAIL_SELECTOR =
    "[data-contents='true'] > div:nth-last-child(-n+8), .ProseMirror > *:nth-last-child(-n+8), .ProseMirror ul > li:nth-last-child(-n+8), .ProseMirror ol > li:nth-last-child(-n+8), .ql-editor > *:nth-last-child(-n+8), [contenteditable='true'] > *:nth-last-child(-n+8), [contenteditable='true']";

const VALID_NAVIGATOR_ACTIONS = Object.freeze(
    new Set(['click_token', 'click_xy', 'goal_reached', 'wait', 'blocked'])
);

export const MUTATING_EASI_TOOLS = Object.freeze(
    new Set([
        'click',
        'double_click',
        'right_click',
        'set_value',
        'type_text',
        'press_key',
        'hotkey',
        'scroll',
        'drag',
        'move_cursor',
        'run_steps'
    ])
);

export const DEFAULT_LOCAL_NAVIGATOR_TIERS = Object.freeze([
    Object.freeze({
        name: 'L2_local_30b_moe',
        model: 'qwen3-coder-30b-moe:latest',
        apiUrl: 'http://127.0.0.1:11434/v1/chat/completions'
    }),
    Object.freeze({
        name: 'L1_local_7b_coder',
        model: 'qwen2.5-coder:7b',
        apiUrl: 'http://127.0.0.1:11434/v1/chat/completions'
    }),
    Object.freeze({
        name: 'L1_local_gemma4_e4b',
        model: 'gemma4:e4b',
        apiUrl: 'http://127.0.0.1:11434/v1/chat/completions'
    })
]);

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let globalCallSeq = 0;

/**
 * Generate a monotonic `easi.run`-compliant `call_id` (`1..64` `[A-Za-z0-9_-]` chars).
 *
 * @param {string} [prefix='easi']
 * @returns {string}
 */
export function nextEasiCallId(prefix = 'easi') {
    globalCallSeq += 1;
    const cleanPrefix = String(prefix || 'easi').replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 24) || 'easi';
    return `${cleanPrefix}_${Date.now().toString(36)}_${globalCallSeq}`.slice(0, 64);
}

/**
 * Normalize whitespace for DOM tail comparison in Blink `contenteditable` editors.
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeEditorWhitespace(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
}

function isLoopbackHost(hostname) {
    const h = String(hostname || '').toLowerCase().replace(/^\[+|\]+$/g, '');
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0:0:0:0:0:0:0:1';
}

function parseMcpToolCallResult(rpcReply, watchBase = DEFAULT_EASI_WATCH_BASE) {
    if (!rpcReply || typeof rpcReply !== 'object') {
        return {
            ok: false,
            error: `No JSON-RPC response from easi.run MCP bridge (ensure admin password is enrolled at ${watchBase}).`
        };
    }

    if (rpcReply.error) {
        return {
            ok: false,
            error: rpcReply.error.message || JSON.stringify(rpcReply.error),
            code: rpcReply.error.code
        };
    }

    const result = rpcReply.result || {};
    const textBlocks = Array.isArray(result.content)
        ? result.content.filter((c) => c && c.type === 'text').map((c) => String(c.text || ''))
        : [];
    const joinedText = textBlocks.join('\n').trim();

    let structured = result.structuredContent || null;
    if (!structured && joinedText.startsWith('{')) {
        try {
            structured = JSON.parse(joinedText);
        } catch {
            structured = null;
        }
    }

    return {
        ok: result.isError !== true,
        isError: Boolean(result.isError),
        structured,
        text: joinedText,
        raw: result,
        ...(result.isError === true ? { error: joinedText || 'easi.run tool returned isError=true' } : {})
    };
}

/**
 * Build a deterministic hermetic mock response for CI / `MOCK_LLM=1` runs.
 *
 * @param {string} toolName
 * @param {Record<string, any>} [toolArgs={}]
 * @param {{ watchBase?: string }} [options={}]
 * @returns {Record<string, any>}
 */
export function buildSimulatedEasiResponse(toolName, toolArgs = {}, options = {}) {
    const watchBase = String(options.watchBase || DEFAULT_EASI_WATCH_BASE).replace(/\/+$/, '');
    const mockSessionId = String(toolArgs.session || 'easi-sess-demo-01');

    if (toolName === 'start_session') {
        return {
            ok: true,
            simulated: true,
            structured: {
                session: mockSessionId,
                watch_url: `${watchBase}/#/session/${mockSessionId}`,
                url: toolArgs.url || 'https://example.com',
                resumed: Boolean(toolArgs.resume)
            },
            text: `Started sandboxed Chrome session ${mockSessionId}`
        };
    }
    if (toolName === 'list_sessions') {
        return {
            ok: true,
            simulated: true,
            structured: { sessions: [] },
            text: '0 active easi.run browser sessions.'
        };
    }
    if (toolName === 'list_saved_sessions') {
        return {
            ok: true,
            simulated: true,
            structured: { saved_sessions: [] },
            text: '0 saved encrypted browser vaults.'
        };
    }
    if (toolName === 'list_windows') {
        return {
            ok: true,
            simulated: true,
            structured: { windows: [{ pid: 4200, window_id: 1, title: 'Chrome' }] },
            text: 'window_id=1 pid=4200 title="Chrome"'
        };
    }
    if (toolName === 'request_person') {
        const reason = toolArgs.arguments?.reason || 'login';
        return {
            ok: true,
            simulated: true,
            structured: {
                session: mockSessionId,
                status: 'needs_human',
                reason,
                watch_url: `${watchBase}/#/session/${mockSessionId}`
            },
            text: `Requested human takeover (${reason}) on ${mockSessionId}.`
        };
    }
    if (toolName === 'wait_for_control') {
        return {
            ok: true,
            simulated: true,
            structured: { session: mockSessionId, outcome: 'resumed' },
            text: `Human released control back to agent on ${mockSessionId}.`
        };
    }
    if (toolName === 'inspect_page') {
        return {
            ok: true,
            simulated: true,
            structured: {
                session: mockSessionId,
                url: 'https://example.com',
                title: 'Sandboxed Chrome Page',
                selector: toolArgs.arguments?.selector || 'body',
                elements: [{ tag: 'body', text: 'Sandboxed Chrome DOM snapshot', shown: true }]
            },
            text: 'Inspected 1 element in sandboxed Chrome.'
        };
    }
    if (toolName === 'get_window_state') {
        return {
            ok: true,
            simulated: true,
            structured: {
                snapshot_id: 'snap-demo-01',
                elements: []
            },
            text: 'Captured 0 accessibility elements.'
        };
    }
    return {
        ok: true,
        simulated: true,
        structured: { session: mockSessionId, tool: toolName },
        text: `Executed ${toolName} on ${mockSessionId}.`
    };
}

/**
 * Execute a single stateless JSON-RPC 2.0 tool call against an `easi.run` stdio MCP command
 * (or an injected `easiMcpCaller` / `caller` in hermetic tests).
 *
 * @param {string} toolName
 * @param {Record<string, any>} [toolArgs={}]
 * @param {Record<string, any>} [options={}]
 * @returns {Promise<Record<string, any>>}
 */
export async function callEasiMcpTool(toolName, toolArgs = {}, options = {}) {
    const customCaller = options.caller || options.easiMcpCaller;
    if (typeof customCaller === 'function') {
        return customCaller(toolName, toolArgs, options);
    }

    const watchBase = String(options.watchBase || DEFAULT_EASI_WATCH_BASE).replace(/\/+$/, '');
    const isMockOrCi =
        options.mock === true ||
        (options.autoMock !== false && (process.env.MOCK_LLM === '1' || process.env.CI === 'true'));
    const command = String(options.command || options.tunnelScriptPath || process.env.EASI_TUNNEL_SCRIPT || '').trim();
    const commandArgs = Array.isArray(options.args) ? options.args : ['mcp'];

    if (isMockOrCi || !command || (command.includes('/') && !fs.existsSync(command))) {
        return buildSimulatedEasiResponse(toolName, toolArgs, { watchBase });
    }

    const timeoutMs = Math.max(2000, Number(options.timeoutMs || 25000));
    const clientName = String(options.clientName || 'krusch-toolkit-easi');
    const clientVersion = String(options.clientVersion || '1.8.1');

    const rpcLines =
        [
            JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: {
                    protocolVersion: '2025-06-18',
                    capabilities: {},
                    clientInfo: { name: clientName, version: clientVersion }
                }
            }),
            JSON.stringify({
                jsonrpc: '2.0',
                id: 2,
                method: 'tools/call',
                params: {
                    name: toolName,
                    arguments: toolArgs
                }
            })
        ].join('\n') + '\n';

    const spawnFn = typeof options.spawnFn === 'function' ? options.spawnFn : spawn;

    return new Promise((resolve) => {
        const child = spawnFn(command, commandArgs, {
            stdio: ['pipe', 'pipe', 'pipe']
        });

        let stdout = '';
        let stderr = '';
        let settled = false;

        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            child.kill('SIGTERM');
            resolve({
                ok: false,
                error: `Timed out after ${timeoutMs}ms calling easi.run MCP tool "${toolName}".`,
                stderr: stderr.trim()
            });
        }, timeoutMs);

        child.stdout.on('data', (chunk) => {
            stdout += chunk.toString('utf8');
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString('utf8');
        });
        child.on('error', (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ ok: false, error: err.message });
        });
        child.on('close', () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);

            const lines = stdout
                .split('\n')
                .map((l) => l.trim())
                .filter(Boolean);

            let rpcReply = null;
            for (const line of lines) {
                try {
                    const parsed = JSON.parse(line);
                    if (parsed.id === 2) {
                        rpcReply = parsed;
                        break;
                    }
                } catch {
                    // ignore non-JSON banner lines
                }
            }

            if (!rpcReply) {
                return resolve({
                    ok: false,
                    error:
                        stderr.trim() ||
                        `No JSON-RPC response from easi.run MCP bridge (ensure admin password is enrolled at ${watchBase}).`
                });
            }

            resolve(parseMcpToolCallResult(rpcReply, watchBase));
        });

        child.stdin.write(rpcLines);
        child.stdin.end();
    });
}

function createPolicyError(message, details = {}) {
    const err = new Error(message);
    err.code = 'POLICY_FLOOR_BLOCK';
    Object.assign(err, details);
    return err;
}

/**
 * Create a reusable `easi.run` MCP client with persistent stdio or HTTP `/mcp` transport,
 * automatic `call_id` idempotency keys, and deterministic small-model Policy Floor guards.
 *
 * @param {Record<string, any>} [options={}]
 * @returns {Record<string, any>}
 */
export function createEasiClient(options = {}) {
    const watchBase = String(options.watchBase || DEFAULT_EASI_WATCH_BASE).replace(/\/+$/, '');
    const allowStopSessionDefault = Boolean(options.allowStopSession);
    const allowNavigateDefault = options.allowNavigate !== undefined ? Boolean(options.allowNavigate) : true;
    const autoCallId = options.autoCallId !== false;
    const callIdPrefix = String(options.callIdPrefix || 'easi');
    const persistent = options.persistent !== false;
    const throwOnError = Boolean(options.throwOnError);
    const defaultTimeoutMs = Math.max(2000, Number(options.timeoutMs || 35000));
    const clientName = String(options.clientName || 'krusch-toolkit-easi');
    const clientVersion = String(options.clientVersion || '1.8.1');
    const mcpUrl = options.mcpUrl ? String(options.mcpUrl).trim() : '';
    const bearerToken = options.bearerToken ? String(options.bearerToken).trim() : '';
    const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : fetch;
    const spawnFn = typeof options.spawnFn === 'function' ? options.spawnFn : spawn;

    let mojoKeyDrainActive = false;
    let rpcIdCounter = 1;
    let stdioProc = null;
    let stdioReadyPromise = null;
    let stdoutRemainder = '';
    let stderrRing = '';
    let mcpHttpSessionId = null;
    const pendingStdio = new Map();

    function syncStdioRefState(proc = stdioProc) {
        if (!proc || options.unrefProcess === false) return;
        const toggle = pendingStdio.size > 0 ? 'ref' : 'unref';
        if (typeof proc[toggle] === 'function') proc[toggle]();
        if (proc.stdout && typeof proc.stdout[toggle] === 'function') proc.stdout[toggle]();
        if (proc.stderr && typeof proc.stderr[toggle] === 'function') proc.stderr[toggle]();
        if (proc.stdin && typeof proc.stdin[toggle] === 'function') proc.stdin[toggle]();
    }

    function rejectAllPendingStdio(reason) {
        for (const [id, entry] of pendingStdio.entries()) {
            pendingStdio.delete(id);
            clearTimeout(entry.timer);
            entry.resolve({
                ok: false,
                error: reason || stderrRing.trim() || 'easi.run stdio MCP stream closed unexpectedly.'
            });
        }
        syncStdioRefState();
    }

    function teardownStdio() {
        const proc = stdioProc;
        stdioProc = null;
        stdioReadyPromise = null;
        stdoutRemainder = '';
        if (proc) {
            try {
                proc.stdin.end();
            } catch {
                // ignore
            }
            try {
                proc.kill('SIGTERM');
            } catch {
                // ignore
            }
        }
    }

    function sendStdioRpcRaw(proc, method, params, timeoutMs) {
        const reqId = ++rpcIdCounter;
        const line = JSON.stringify({ jsonrpc: '2.0', id: reqId, method, params }) + '\n';

        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                if (!pendingStdio.has(reqId)) return;
                pendingStdio.delete(reqId);
                syncStdioRefState(proc);
                resolve({
                    ok: false,
                    timedOut: true,
                    error: `Timed out after ${timeoutMs}ms waiting for easi.run MCP ${method}.`
                });
            }, timeoutMs);
            if (options.unrefTimers === true && typeof timer.unref === 'function') {
                timer.unref();
            }

            pendingStdio.set(reqId, {
                timer,
                resolve: (rawReply) => resolve(rawReply)
            });
            syncStdioRefState(proc);

            try {
                proc.stdin.write(line);
            } catch (err) {
                pendingStdio.delete(reqId);
                clearTimeout(timer);
                syncStdioRefState(proc);
                resolve({ ok: false, error: err.message });
            }
        });
    }

    async function ensurePersistentStdio(command, commandArgs, timeoutMs) {
        if (stdioProc && stdioReadyPromise) {
            return stdioReadyPromise;
        }

        stdioReadyPromise = (async () => {
            const child = spawnFn(command, commandArgs, {
                stdio: ['pipe', 'pipe', 'pipe']
            });
            syncStdioRefState(child);
            stdioProc = child;
            stdoutRemainder = '';
            stderrRing = '';

            child.stdout.on('data', (chunk) => {
                stdoutRemainder += chunk.toString('utf8');
                let idx;
                while ((idx = stdoutRemainder.indexOf('\n')) !== -1) {
                    const line = stdoutRemainder.slice(0, idx).trim();
                    stdoutRemainder = stdoutRemainder.slice(idx + 1);
                    if (!line) continue;
                    try {
                        const parsed = JSON.parse(line);
                        if (parsed && parsed.id !== undefined && pendingStdio.has(parsed.id)) {
                            const entry = pendingStdio.get(parsed.id);
                            pendingStdio.delete(parsed.id);
                            clearTimeout(entry.timer);
                            syncStdioRefState(child);
                            entry.resolve({ ok: true, rpc: parsed });
                        }
                    } catch {
                        // ignore non-JSON diagnostic lines
                    }
                }
            });

            child.stderr.on('data', (chunk) => {
                stderrRing = (stderrRing + chunk.toString('utf8')).slice(-4096);
            });

            child.on('error', (err) => {
                if (stdioProc === child) {
                    stdioProc = null;
                    stdioReadyPromise = null;
                }
                rejectAllPendingStdio(err.message);
            });

            child.on('close', () => {
                if (stdioProc === child) {
                    stdioProc = null;
                    stdioReadyPromise = null;
                }
                rejectAllPendingStdio(
                    stderrRing.trim() || `easi.run MCP bridge closed (check ${watchBase}).`
                );
            });

            const initOut = await sendStdioRpcRaw(
                child,
                'initialize',
                {
                    protocolVersion: '2025-06-18',
                    capabilities: {},
                    clientInfo: { name: clientName, version: clientVersion }
                },
                timeoutMs
            );
            if (!initOut.ok || initOut.rpc?.error) {
                teardownStdio();
                throw new Error(
                    initOut.error || initOut.rpc?.error?.message || 'Failed to initialize easi.run stdio MCP session.'
                );
            }

            try {
                child.stdin.write(
                    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n'
                );
            } catch {
                // non-fatal
            }

            return child;
        })();

        try {
            return await stdioReadyPromise;
        } catch (err) {
            stdioReadyPromise = null;
            throw err;
        }
    }

    async function callOverHttpMcp(toolName, toolArgs, timeoutMs) {
        const headers = {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream'
        };
        if (bearerToken) {
            headers.Authorization = `Bearer ${bearerToken}`;
        }
        if (mcpHttpSessionId) {
            headers['Mcp-Session-Id'] = mcpHttpSessionId;
        }

        async function postRpc(bodyObj) {
            const res = await fetchImpl(mcpUrl, {
                method: 'POST',
                headers: {
                    ...headers,
                    ...(mcpHttpSessionId ? { 'Mcp-Session-Id': mcpHttpSessionId } : {})
                },
                body: JSON.stringify(bodyObj),
                signal: AbortSignal.timeout(timeoutMs)
            });

            const sid = res.headers?.get?.('mcp-session-id') || res.headers?.get?.('Mcp-Session-Id');
            if (sid) mcpHttpSessionId = sid;

            const rawText = await res.text();
            if (!res.ok) {
                throw new Error(`HTTP ${res.status} calling easi.run /mcp: ${rawText.slice(0, 240)}`);
            }
            const ctype = String(res.headers?.get?.('content-type') || '').toLowerCase();
            if (ctype.includes('text/event-stream')) {
                const dataLines = rawText
                    .split('\n')
                    .filter((l) => l.startsWith('data:'))
                    .map((l) => l.slice(5).trim())
                    .filter(Boolean);
                for (let i = dataLines.length - 1; i >= 0; i -= 1) {
                    try {
                        const parsed = JSON.parse(dataLines[i]);
                        if (parsed.id === bodyObj.id) return parsed;
                    } catch {
                        // continue
                    }
                }
                return null;
            }
            return rawText ? JSON.parse(rawText) : null;
        }

        if (!mcpHttpSessionId) {
            await postRpc({
                jsonrpc: '2.0',
                id: ++rpcIdCounter,
                method: 'initialize',
                params: {
                    protocolVersion: '2025-06-18',
                    capabilities: {},
                    clientInfo: { name: clientName, version: clientVersion }
                }
            });
        }

        const callId = ++rpcIdCounter;
        const rpcReply = await postRpc({
            jsonrpc: '2.0',
            id: callId,
            method: 'tools/call',
            params: { name: toolName, arguments: toolArgs }
        });
        return parseMcpToolCallResult(rpcReply, watchBase);
    }

    function enforcePolicyFloor(toolName, toolArgs, callOptions = {}) {
        const allowStop =
            callOptions.allowStopSession !== undefined ? Boolean(callOptions.allowStopSession) : allowStopSessionDefault;
        const allowNav =
            callOptions.allowNavigate !== undefined ? Boolean(callOptions.allowNavigate) : allowNavigateDefault;

        if (toolName === 'stop_session' && !allowStop) {
            throw createPolicyError('POLICY_FLOOR_BLOCK: stop_session is forbidden on persistent sessions', {
                toolName
            });
        }
        if (toolName === 'navigate' && !allowNav) {
            throw createPolicyError('POLICY_FLOOR_BLOCK: direct navigate is forbidden by client policy', {
                toolName
            });
        }
        if (mojoKeyDrainActive) {
            if (toolName === 'get_window_state') {
                throw createPolicyError(
                    'POLICY_FLOOR_BLOCK: get_window_state is forbidden while keys are draining in Chrome Mojo queue (returns stale pre-drain AT-SPI state; poll inspect_page instead)',
                    { toolName }
                );
            }
            if (toolName === 'run_steps' && toolArgs?.arguments?.observe !== undefined) {
                throw createPolicyError(
                    'POLICY_FLOOR_BLOCK: run_steps observe (get_window_state) is forbidden while keys are draining in Chrome Mojo queue',
                    { toolName }
                );
            }
            if (toolName === 'type_text' && toolArgs?.arguments?.element_token) {
                throw createPolicyError(
                    'POLICY_FLOOR_BLOCK: type_text element_token is forbidden during contenteditable Mojo key drain (non-entry section/paragraph tokens fail AT-SPI GrabFocus)',
                    { toolName }
                );
            }
        }
    }

    async function call(toolName, rawArgs = {}, callOptions = {}) {
        enforcePolicyFloor(toolName, rawArgs, callOptions);

        const toolArgs = { ...(rawArgs || {}) };
        if (autoCallId && toolArgs.session && !toolArgs.call_id && MUTATING_EASI_TOOLS.has(toolName)) {
            toolArgs.call_id = nextEasiCallId(`${callIdPrefix}_${toolName}`);
        }

        const timeoutMs = Math.max(2000, Number(callOptions.timeoutMs || defaultTimeoutMs));
        const customCaller = callOptions.caller || callOptions.easiMcpCaller || options.caller || options.easiMcpCaller;

        let out;
        if (typeof customCaller === 'function') {
            out = await customCaller(toolName, toolArgs, { ...options, ...callOptions, timeoutMs });
        } else {
            const isMockOrCi =
                options.mock === true ||
                callOptions.mock === true ||
                (options.autoMock !== false && (process.env.MOCK_LLM === '1' || process.env.CI === 'true'));
            const command = String(
                callOptions.command ||
                    options.command ||
                    options.tunnelScriptPath ||
                    process.env.EASI_TUNNEL_SCRIPT ||
                    ''
            ).trim();
            const commandArgs = Array.isArray(options.args) ? options.args : ['mcp'];

            if (isMockOrCi) {
                out = buildSimulatedEasiResponse(toolName, toolArgs, { watchBase });
            } else if (mcpUrl) {
                try {
                    out = await callOverHttpMcp(toolName, toolArgs, timeoutMs);
                } catch (err) {
                    out = { ok: false, error: err.message };
                }
            } else if (!command || (command.includes('/') && !fs.existsSync(command))) {
                out = buildSimulatedEasiResponse(toolName, toolArgs, { watchBase });
            } else if (!persistent) {
                out = await callEasiMcpTool(toolName, toolArgs, {
                    ...options,
                    ...callOptions,
                    command,
                    args: commandArgs,
                    timeoutMs,
                    watchBase,
                    spawnFn
                });
            } else {
                try {
                    const proc = await ensurePersistentStdio(command, commandArgs, timeoutMs);
                    const rawOut = await sendStdioRpcRaw(
                        proc,
                        'tools/call',
                        { name: toolName, arguments: toolArgs },
                        timeoutMs
                    );
                    if (!rawOut.ok) {
                        if (rawOut.timedOut) {
                            teardownStdio();
                        }
                        out = { ok: false, error: rawOut.error };
                    } else {
                        out = parseMcpToolCallResult(rawOut.rpc, watchBase);
                    }
                } catch (err) {
                    out = { ok: false, error: err.message };
                }
            }
        }

        if (
            (!out || !out.ok) &&
            !callOptions._retriedWaylandGeometry &&
            toolName !== 'list_windows' &&
            toolArgs.session &&
            /No Wayland geometry/i.test(String(out?.error || out?.text || ''))
        ) {
            const sleepFn = typeof callOptions.sleepFn === 'function'
                ? callOptions.sleepFn
                : typeof options.sleepFn === 'function'
                    ? options.sleepFn
                    : defaultSleep;
            await call(
                'list_windows',
                { session: toolArgs.session, call_id: nextEasiCallId('lwretry'), arguments: { app: 'chrome' } },
                { ...callOptions, throwOnError: false, _retriedWaylandGeometry: true }
            );
            await sleepFn(250);
            return call(
                toolName,
                { ...rawArgs, call_id: nextEasiCallId('retry') },
                { ...callOptions, _retriedWaylandGeometry: true }
            );
        }

        const shouldThrow = callOptions.throwOnError !== undefined ? Boolean(callOptions.throwOnError) : throwOnError;
        if (shouldThrow && (!out || !out.ok)) {
            const err = new Error(`easi.${toolName} failed: ${out?.error || out?.text || 'unknown error'}`);
            err.code = out?.code || 'EASI_CALL_FAILED';
            err.response = out;
            throw err;
        }
        return out;
    }

    async function close() {
        teardownStdio();
        rejectAllPendingStdio('easi.run client closed');
    }

    return {
        watchBase,
        call,
        close,
        setMojoKeyDrain(active) {
            mojoKeyDrainActive = Boolean(active);
            return mojoKeyDrainActive;
        },
        isMojoKeyDrainActive() {
            return mojoKeyDrainActive;
        }
    };
}

/**
 * Filter AT-SPI accessibility elements to safe web-content candidates,
 * stripping Chrome omnibox, tab strip, and toolbar controls (`y < minWebY`).
 *
 * @param {Record<string, any> | null | undefined} structuredSnapshot
 * @param {{ limit?: number, minWebY?: number }} [options={}]
 * @returns {{ allElements: Array<Record<string, any>>, safeElements: Array<Record<string, any>> }}
 */
export function extractSafeWebElements(structuredSnapshot, options = {}) {
    const limit = Math.max(1, Number(options.limit ?? 85));
    const minWebY = Number.isFinite(Number(options.minWebY))
        ? Number(options.minWebY)
        : DEFAULT_CHROME_OMNIBOX_MIN_Y;

    const elements = Array.isArray(structuredSnapshot?.elements) ? structuredSnapshot.elements : [];
    const byIndex = new Map();
    for (const el of elements) {
        const idx = el.index ?? Number(String(el.element_token || '').split(':')[1]);
        if (Number.isInteger(idx)) byIndex.set(idx, el);
    }

    function hasToolbarAncestor(el) {
        let cur = el;
        let hops = 0;
        while (cur && hops < 15) {
            const role = String(cur.role || '').toLowerCase();
            const label = String(cur.label || '').toLowerCase();
            if (
                role === 'tool bar' ||
                role === 'toolbar' ||
                label.includes('address and search bar') ||
                label.includes('tab strip')
            ) {
                return true;
            }
            if (cur.parent_index == null) break;
            cur = byIndex.get(cur.parent_index);
            hops += 1;
        }
        return false;
    }

    const safe = [];
    for (const el of elements) {
        if (hasToolbarAncestor(el)) continue;
        const frame = el.screenshot_frame || el.frame || null;
        if (frame && typeof frame.y === 'number' && frame.y < minWebY && frame.h < 60) {
            continue;
        }
        const role = String(el.role || '');
        const label = String(el.label || '').replace(/\uFFFC/g, '').trim();
        const description = String(el.description || '').replace(/\uFFFC/g, '').trim();
        const value = String(el.value || '').replace(/\uFFFC/g, '').trim();
        const interestingRole =
            /button|link|menu|entry|text|heading|paragraph|document|dialog|check|radio|tab|combo|list/i.test(role);
        if (!interestingRole && !label && !description && !value) continue;

        safe.push({
            token: el.element_token,
            index: el.index ?? Number(String(el.element_token || '').split(':')[1]),
            parent_index: el.parent_index ?? null,
            role,
            label: (label || description).slice(0, 120),
            value: value.slice(0, 120),
            enabled: el.enabled !== false,
            actions: el.actions || [],
            frame: frame
                ? {
                      x: Math.round(frame.x),
                      y: Math.round(frame.y),
                      w: Math.round(frame.w),
                      h: Math.round(frame.h)
                  }
                : null
        });
        if (safe.length >= limit) break;
    }

    return { allElements: elements, safeElements: safe };
}

/**
 * Parse `{ pid, windowId }` for the active Chrome window in an `easi.run` session.
 *
 * @param {{ call: Function }} client
 * @param {string} session
 * @returns {Promise<{ pid: number, windowId: number }>}
 */
export async function resolveEasiChromeWindow(client, session) {
    const winRes = await client.call(
        'list_windows',
        {
            session,
            call_id: nextEasiCallId('lw'),
            arguments: { app: 'chrome' }
        },
        { throwOnError: true }
    );
    if (Array.isArray(winRes.structured?.windows) && winRes.structured.windows.length > 0) {
        const w = winRes.structured.windows[0];
        return { pid: Number(w.pid), windowId: Number(w.window_id) };
    }
    const match = String(winRes.text || '').match(/window_id=(\d+)\s+pid=(\d+)/);
    if (!match) {
        throw new Error(`Unable to parse window_id/pid from list_windows: ${winRes.text}`);
    }
    return { windowId: Number(match[1]), pid: Number(match[2]) };
}

/**
 * Capture a `<2,000`-token combined DOM (`inspect_page`) and filtered AT-SPI (`get_window_state`)
 * observation sized for 4B-30B local models.
 *
 * @param {{ call: Function }} client
 * @param {string} session
 * @param {number} pid
 * @param {number} windowId
 * @param {Record<string, any>} [options={}]
 * @returns {Promise<Record<string, any>>}
 */
export async function captureCompactUiState(client, session, pid, windowId, options = {}) {
    const {
        axQuery,
        domSelector,
        maxElements = 900,
        safeLimit = 85,
        domLimit = 45,
        minWebY = DEFAULT_CHROME_OMNIBOX_MIN_Y
    } = options;

    const domRes = await client.call(
        'inspect_page',
        {
            session,
            arguments: {
                selector:
                    domSelector ||
                    "a, button, [role='button'], [role='menuitem'], [contenteditable='true'], input, textarea, [data-testid]",
                limit: Math.max(domLimit, 60)
            }
        },
        { throwOnError: true }
    );

    const axArgs = {
        pid,
        window_id: windowId,
        tree_format: 'elements',
        include_screenshot: false,
        timeout_ms: Number(options.axTimeoutMs || 8000),
        max_elements: maxElements
    };
    if (axQuery) axArgs.query = axQuery;

    const axRes = await client.call(
        'get_window_state',
        {
            session,
            call_id: nextEasiCallId('gws'),
            arguments: axArgs
        },
        { throwOnError: true }
    );

    const { allElements, safeElements } = extractSafeWebElements(axRes.structured, {
        limit: safeLimit,
        minWebY
    });

    const domElements = (domRes.structured?.elements || [])
        .filter((e) => e.shown !== false)
        .slice(0, domLimit)
        .map((e) => {
            const rawHref = String(e.attributes?.href || '').trim();
            const safeHref =
                rawHref && !/^(?:data|javascript|blob):/i.test(rawHref)
                    ? rawHref.slice(0, 160)
                    : undefined;
            const rawAria = String(e.attributes?.['aria-label'] || '').trim();
            const rawPlaceholder = String(
                e.attributes?.placeholder || e.attributes?.['data-placeholder'] || ''
            ).trim();
            return {
                tag: e.tag,
                text: String(e.text || '').trim().slice(0, 100),
                ariaLabel: rawAria ? rawAria.slice(0, 120) : undefined,
                className: String(e.attributes?.class || '').slice(0, 80) || undefined,
                testid: e.attributes?.['data-testid'] || undefined,
                href: safeHref,
                role: e.attributes?.role || undefined,
                contenteditable: e.attributes?.contenteditable || undefined,
                placeholder: rawPlaceholder ? rawPlaceholder.slice(0, 80) : undefined
            };
        });

    return {
        url: domRes.structured?.url || '',
        pageTitle: domRes.structured?.title || '',
        snapshotId: axRes.structured?.snapshot_id || null,
        allElements,
        safeElements,
        domElements
    };
}

/**
 * Ask a local small/mid-size Ollama model (with multi-tier cascade fallback) to select the next
 * web-content UI action from a compact `captureCompactUiState` observation.
 *
 * @param {Record<string, any>} options
 * @returns {Promise<{ decision: Record<string, any>, model: string, elapsedMs: number, tierIndex: number }>}
 */
export async function stepSmallModelNavigator(options = {}) {
    const {
        stage = 'ui_step',
        goal = '',
        observation = {},
        llmConfig = {},
        tiers = DEFAULT_LOCAL_NAVIGATOR_TIERS,
        startTierIndex = 0,
        minWebY = DEFAULT_CHROME_OMNIBOX_MIN_Y,
        extraRules = [],
        systemIntro = 'You are an autonomous browser UI navigation controller.',
        chatJsonFn = chatJson,
        decisionLog = null,
        onTierFallback = null
    } = options;

    const numberedExtra = Array.isArray(extraRules)
        ? extraRules.filter(Boolean).map((rule, idx) => `${idx + 6}. ${rule}`)
        : [];

    const systemPrompt = [
        systemPromptLine(systemIntro),
        'You receive the current page URL, visible DOM elements, and AT-SPI accessibility elements (with element_token and window-local pixel frames).',
        'HARD RULES:',
        `1. NEVER click Chrome toolbar, tabs, or address bar (y < ${minWebY}). Click ONLY web-content controls.`,
        '2. NEVER invent an element_token from a DOM class or placeholder. element_token MUST be an exact token string from axElements (formatted like "s00000001:42"), or use action="click_xy" with window-local pixel coordinates.',
        '3. Prefer action="click_token" with an exact element_token from axElements when available; use action="click_xy" with window-local x,y inside a valid axElement frame only when needed.',
        '4. If the goal state is ALREADY reached on screen, return action="goal_reached".',
        '5. Output STRICT JSON ONLY with keys: {"action":"click_token"|"click_xy"|"goal_reached"|"wait"|"blocked","element_token":string|null,"x":number|null,"y":number|null,"reason":string}.',
        ...numberedExtra
    ].join('\n');

    const compactAx = (observation.safeElements || []).map((el) => {
        const entry = { token: el.token, role: el.role };
        if (el.label) entry.label = el.label;
        if (el.value) entry.value = el.value;
        if (el.enabled === false) entry.enabled = false;
        if (el.frame) entry.frame = el.frame;
        return entry;
    });

    const userPrompt = JSON.stringify({
        stage,
        goal,
        url: observation.url || '',
        pageTitle: String(observation.pageTitle || '').slice(0, 140),
        domElements: observation.domElements || [],
        axElements: compactAx
    });

    const safeStart = Math.max(0, Math.min(Number(startTierIndex || 0), Math.max(0, tiers.length - 1)));
    const candidates = llmConfig.explicitOverride
        ? [{ name: 'explicit', model: llmConfig.model, apiUrl: llmConfig.apiUrl }]
        : tiers.slice(safeStart);

    let decision = null;
    let usedModel = llmConfig.model || candidates[0]?.model || 'qwen2.5-coder:7b';
    let elapsedMs = 0;
    let resolvedTierIndex = safeStart;
    let lastErr = null;

    for (let i = 0; i < candidates.length; i += 1) {
        const tier = candidates[i];
        const startedAt = Date.now();
        try {
            const candidateDecision = await chatJsonFn(
                systemPrompt,
                userPrompt,
                {
                    ...llmConfig,
                    provider: llmConfig.provider || 'ollama',
                    model: tier.model,
                    apiUrl: tier.apiUrl
                },
                {
                    temperature: llmConfig.temperature ?? 0.1,
                    maxTokens: llmConfig.maxTokens ?? 500
                }
            );
            if (
                !candidateDecision ||
                typeof candidateDecision !== 'object' ||
                !VALID_NAVIGATOR_ACTIONS.has(candidateDecision.action)
            ) {
                throw new Error(
                    `Invalid navigator decision action=${JSON.stringify(candidateDecision?.action)}: ${JSON.stringify(candidateDecision).slice(0, 140)}`
                );
            }
            if (candidateDecision.action === 'click_token' && !candidateDecision.element_token) {
                throw new Error('Navigator returned click_token without element_token');
            }
            if (
                candidateDecision.action === 'click_xy' &&
                (!Number.isFinite(candidateDecision.x) || !Number.isFinite(candidateDecision.y))
            ) {
                throw new Error('Navigator returned click_xy without numeric x,y');
            }
            decision = candidateDecision;
            elapsedMs = Date.now() - startedAt;
            usedModel = tier.model;
            if (!llmConfig.explicitOverride && i > 0) {
                resolvedTierIndex = safeStart + i;
            }
            break;
        } catch (err) {
            decision = null;
            lastErr = err;
            if (typeof onTierFallback === 'function') {
                onTierFallback({ tier, error: err, nextTier: candidates[i + 1] || null });
            }
        }
    }

    if (!decision) {
        throw lastErr || new Error('All local navigator LLM tiers failed');
    }

    if (Array.isArray(decisionLog)) {
        decisionLog.push({
            stage,
            model: usedModel,
            elapsedMs,
            url: observation.url || '',
            decision
        });
    }

    return {
        decision,
        model: usedModel,
        elapsedMs,
        tierIndex: resolvedTierIndex
    };
}

function systemPromptLine(text) {
    return String(text || 'You are an autonomous browser UI navigation controller.').trim();
}

/**
 * Validate a small-model UI decision against `safeElements` and the Chrome omnibox `minWebY`
 * Policy Floor before executing `click`.
 *
 * @param {{ call: Function }} client
 * @param {Record<string, any>} params
 * @returns {Promise<Record<string, any>>}
 */
export async function executeValidatedUiDecision(client, params = {}) {
    const {
        session,
        pid,
        windowId,
        decision,
        observation,
        minWebY = DEFAULT_CHROME_OMNIBOX_MIN_Y
    } = params;

    if (!decision || typeof decision !== 'object') {
        throw new Error('Missing UI decision object');
    }

    if (decision.action === 'click_token' && decision.element_token) {
        const safeList = Array.isArray(observation?.safeElements) ? observation.safeElements : [];
        const matched = safeList.find((e) => e.token === decision.element_token);
        if (!matched) {
            throw createPolicyError(
                `POLICY_FLOOR_BLOCK: Model selected unknown or toolbar-filtered token ${decision.element_token}`,
                { decision }
            );
        }
        if (matched.frame && matched.frame.y < minWebY && matched.frame.h < 60) {
            throw createPolicyError(
                `POLICY_FLOOR_BLOCK: Refusing click near Chrome omnibox (y=${matched.frame.y})`,
                { decision }
            );
        }
        return client.call(
            'click',
            {
                session,
                call_id: nextEasiCallId('clk'),
                arguments: {
                    pid,
                    window_id: windowId,
                    element_token: decision.element_token
                }
            },
            { throwOnError: true }
        );
    }

    if (decision.action === 'click_xy' && Number.isFinite(decision.x) && Number.isFinite(decision.y)) {
        if (decision.y < minWebY) {
            throw createPolicyError(
                `POLICY_FLOOR_BLOCK: Refusing pixel click in omnibox band (y=${decision.y})`,
                { decision }
            );
        }
        return client.call(
            'click',
            {
                session,
                call_id: nextEasiCallId('clkxy'),
                arguments: {
                    pid,
                    window_id: windowId,
                    x: Math.round(decision.x),
                    y: Math.round(decision.y)
                }
            },
            { throwOnError: true }
        );
    }

    throw new Error(`Unsupported click decision: ${JSON.stringify(decision)}`);
}

/**
 * Read the trailing blocks of a rich-text `contenteditable` editor (X Draft.js, LinkedIn
 * ProseMirror/Quill, or generic `[contenteditable='true']`) without reading stale mid-drain AT-SPI trees
 * and without hitting `inspect_page`'s 2,000-character single-element cap.
 *
 * Returns `{ busy: true }` while Chrome's Blink renderer is still busy draining Mojo keys.
 *
 * @param {{ call: Function }} client
 * @param {string} session
 * @param {{ selector?: string, limit?: number, timeoutMs?: number }} [options={}]
 * @returns {Promise<{ busy: boolean, text: string, url: string, blockCount?: number }>}
 */
export async function readEditorTailDom(client, session, options = {}) {
    const selector = options.selector || DEFAULT_EDITOR_TAIL_SELECTOR;
    const limit = Math.max(1, Number(options.limit || 12));
    const timeoutMs = Math.max(2000, Number(options.timeoutMs || 20000));

    const res = await client.call(
        'inspect_page',
        {
            session,
            arguments: { selector, limit }
        },
        { timeoutMs, throwOnError: false }
    );

    if (!res || !res.ok) {
        const errText = String(res?.error || res?.text || '');
        if (/did not answer|timed out/i.test(errText)) {
            return { busy: true, text: '', url: '' };
        }
        throw new Error(`easi.inspect_page failed: ${errText}`);
    }

    const elements = res.structured?.elements || [];
    const combined = normalizeEditorWhitespace(elements.map((e) => e.text || '').join(' '));
    return {
        busy: false,
        text: combined,
        url: res.structured?.url || '',
        blockCount: elements.length
    };
}

/**
 * Detect how many leading chunks are already intact inside an open `contenteditable` draft
 * so interrupted runs resume cleanly at `startChunkIndex` without duplicating text.
 *
 * @param {string} tailText
 * @param {string[]} chunks
 * @param {{ probeLength?: number }} [options={}]
 * @returns {number}
 */
export function detectResumableChunkIndex(tailText, chunks = [], options = {}) {
    const normalizedTail = normalizeEditorWhitespace(tailText);
    if (!normalizedTail || !Array.isArray(chunks) || chunks.length === 0) return 0;
    const probeLength = Math.max(16, Number(options.probeLength || 55));

    for (let idx = chunks.length - 1; idx >= 0; idx -= 1) {
        const tailProbe = normalizeEditorWhitespace(chunks[idx]).slice(-probeLength);
        if (tailProbe && normalizedTail.includes(tailProbe)) {
            return idx + 1;
        }
    }
    return 0;
}

/**
 * Resolve safe window-local coordinates `{ x, y }` inside the first child `section` or `paragraph`
 * of a rich-text body editor (`Start writing`, `Write here`, `Write your article`, etc.) so focus
 * is placed by coordinate click rather than `element_token` `GrabFocus`.
 *
 * @param {{ call: Function }} client
 * @param {Record<string, any>} options
 * @returns {Promise<{ x: number, y: number, frame?: Record<string, number>, role?: string, token?: string, source: string }>}
 */
export async function resolveBodyEditorClickPoint(client, options = {}) {
    const {
        session,
        pid,
        windowId,
        labelPattern = /start writing|write your article|write here|tell your story/i,
        minEditorX = 200,
        minEditorY = 120,
        minWebY = DEFAULT_CHROME_OMNIBOX_MIN_Y,
        fallbackNavigator = null
    } = options;

    const axRes = await client.call(
        'get_window_state',
        {
            session,
            call_id: nextEasiCallId('bodyax'),
            arguments: {
                pid,
                window_id: windowId,
                tree_format: 'elements',
                include_screenshot: false,
                timeout_ms: 9000,
                max_elements: 1800
            }
        },
        { throwOnError: true }
    );

    const elements = Array.isArray(axRes.structured?.elements) ? axRes.structured.elements : [];
    const withIdx = elements.map((el, pos) => ({
        ...el,
        _idx: el.index ?? Number(String(el.element_token || '').split(':')[1] || pos)
    }));

    const startWritingNode = withIdx.find((el) => labelPattern.test(`${el.label || ''} ${el.value || ''}`));

    let targetChild = null;
    if (startWritingNode) {
        targetChild =
            withIdx.find(
                (el) =>
                    el.parent_index === startWritingNode._idx &&
                    /section|paragraph/i.test(String(el.role || '')) &&
                    (el.screenshot_frame || el.frame)
            ) || startWritingNode;
    }

    if (!targetChild) {
        const editorEntries = withIdx
            .filter((el) => {
                const f = el.screenshot_frame || el.frame;
                return (
                    /entry|document/i.test(String(el.role || '')) &&
                    f &&
                    f.x >= minEditorX &&
                    f.y >= minEditorY &&
                    f.h > 18
                );
            })
            .sort((a, b) => (a.screenshot_frame || a.frame).y - (b.screenshot_frame || b.frame).y);
        if (editorEntries.length >= 2) {
            const bodyEntry = editorEntries[editorEntries.length - 1];
            targetChild =
                withIdx.find(
                    (el) =>
                        el.parent_index === bodyEntry._idx &&
                        /section|paragraph/i.test(String(el.role || '')) &&
                        (el.screenshot_frame || el.frame)
                ) || bodyEntry;
        }
    }

    if (!targetChild && typeof fallbackNavigator === 'function') {
        const { safeElements } = extractSafeWebElements(axRes.structured, { limit: 110, minWebY });
        const decision = await fallbackNavigator(safeElements);
        if (decision?.element_token) {
            targetChild = withIdx.find((e) => e.element_token === decision.element_token) || null;
        } else if (Number.isFinite(decision?.x) && Number.isFinite(decision?.y)) {
            if (decision.y < minWebY) {
                throw createPolicyError(`Computed body editor click y=${decision.y} is unsafe (< ${minWebY})`);
            }
            return { x: Math.round(decision.x), y: Math.round(decision.y), source: 'navigator_xy' };
        }
    }

    const frame = targetChild?.screenshot_frame || targetChild?.frame;
    if (!frame) {
        throw new Error('Could not resolve pixel frame for body editor first child section/paragraph');
    }

    const x = Math.round(frame.x + Math.min(250, Math.max(40, frame.w - 20)));
    const y = Math.round(frame.y + 12);
    if (y < minWebY) {
        throw createPolicyError(`Computed body editor click y=${y} is unsafe (< ${minWebY})`);
    }
    return {
        x,
        y,
        frame,
        role: targetChild.role,
        token: targetChild.element_token,
        source: startWritingNode ? 'body_placeholder_first_child' : 'editor_element_frame'
    };
}

/**
 * Stream pre-chunked text into a focused Blink `contenteditable` editor while enforcing the
 * Mojo key-drain Policy Floor (blocking `get_window_state` and `element_token` `type_text` calls)
 * and polling `readEditorTailDom` until each chunk's tail lands verbatim in DOM.
 *
 * @param {{ call: Function, setMojoKeyDrain: Function }} client
 * @param {Record<string, any>} options
 * @returns {Promise<{ chunksTyped: number, totalChunks: number, finalTail: { busy: boolean, text: string, url: string } }>}
 */
export async function streamContentEditableChunks(client, options = {}) {
    const {
        session,
        pid,
        windowId,
        chunks = [],
        startChunkIndex = 0,
        selector = DEFAULT_EDITOR_TAIL_SELECTOR,
        probeLength = 55,
        initialWaitMs = 10000,
        pollIntervalMs = 5000,
        maxPolls = 32,
        chunkTimeoutMs = 120000,
        sleepFn = defaultSleep,
        onProgress = null
    } = options;

    if (!Array.isArray(chunks)) {
        throw new Error('chunks must be an array of strings');
    }

    let chunksTyped = 0;
    client.setMojoKeyDrain(true);
    try {
        for (let i = Math.max(0, startChunkIndex); i < chunks.length; i += 1) {
            const chunk = chunks[i];
            const expectedTail = normalizeEditorWhitespace(chunk).slice(-probeLength);

            if (typeof onProgress === 'function') {
                onProgress({ phase: 'typing', chunkIndex: i, totalChunks: chunks.length, length: chunk.length, expectedTail });
            }

            await client.call(
                'type_text',
                {
                    session,
                    call_id: nextEasiCallId(`chunk${i + 1}`),
                    arguments: {
                        pid,
                        window_id: windowId,
                        text: chunk
                    }
                },
                { timeoutMs: chunkTimeoutMs, throwOnError: true }
            );

            if (initialWaitMs > 0) {
                await sleepFn(initialWaitMs);
            }

            let tailConfirmed = false;
            for (let poll = 1; poll <= maxPolls; poll += 1) {
                const tailSnapshot = await readEditorTailDom(client, session, { selector });
                if (!tailSnapshot.busy && (!expectedTail || tailSnapshot.text.includes(expectedTail))) {
                    tailConfirmed = true;
                    chunksTyped += 1;
                    if (typeof onProgress === 'function') {
                        onProgress({
                            phase: 'verified',
                            chunkIndex: i,
                            totalChunks: chunks.length,
                            poll,
                            tailLength: tailSnapshot.text.length
                        });
                    }
                    break;
                }
                if (typeof onProgress === 'function') {
                    onProgress({
                        phase: 'draining',
                        chunkIndex: i,
                        totalChunks: chunks.length,
                        poll,
                        maxPolls,
                        busy: tailSnapshot.busy,
                        tailLength: tailSnapshot.text.length
                    });
                }
                if (poll < maxPolls && pollIntervalMs > 0) {
                    await sleepFn(pollIntervalMs);
                }
            }

            if (!tailConfirmed) {
                throw new Error(
                    `Chunk ${i + 1}/${chunks.length} tail did not appear in contenteditable blocks after Mojo drain`
                );
            }
        }
    } finally {
        client.setMojoKeyDrain(false);
    }

    const finalTail = await readEditorTailDom(client, session, { selector });
    return {
        chunksTyped,
        totalChunks: chunks.length,
        finalTail
    };
}

/**
 * Default Node HTTP/HTTPS `PUT` uploader for `easi.run` `send_file` single-use URLs.
 * Allows self-signed TLS certificates ONLY on loopback (`localhost` / `127.0.0.1` / `::1`).
 *
 * @param {string} putUrl
 * @param {Buffer} buffer
 * @param {number} [timeoutMs=30000]
 * @returns {Promise<string>}
 */
function defaultPutBuffer(putUrl, buffer, timeoutMs = 30000) {
    const parsed = new URL(putUrl);
    const isHttps = parsed.protocol === 'https:';
    const transport = isHttps ? https : http;
    const allowSelfSigned = isHttps && isLoopbackHost(parsed.hostname);

    return new Promise((resolve, reject) => {
        const req = transport.request(
            parsed,
            {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/octet-stream',
                    'Content-Length': buffer.length
                },
                ...(isHttps ? { rejectUnauthorized: !allowSelfSigned } : {}),
                timeout: timeoutMs
            },
            (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    const body = Buffer.concat(chunks).toString('utf8');
                    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(body);
                    } else {
                        reject(new Error(`HTTP ${res.statusCode} uploading file to easi.run vault: ${body.slice(0, 200)}`));
                    }
                });
            }
        );
        req.on('timeout', () => {
            req.destroy(new Error(`Timed out after ${timeoutMs}ms uploading file to easi.run vault`));
        });
        req.on('error', reject);
        req.end(buffer);
    });
}

/**
 * Stage a file into an `easi.run` browser vault (`send_file` + HTTP `PUT`) and attach it
 * to the page's file chooser (`list_files` -> `choose_files`).
 *
 * @param {{ call: Function }} client
 * @param {Record<string, any>} options
 * @returns {Promise<{ uploaded: boolean, fileId?: number, bytes?: number, reason?: string, chooserRequest?: string }>}
 */
export async function uploadFileViaChooser(client, options = {}) {
    const {
        session,
        filePath = '',
        fileBytes = null,
        fileName: explicitFileName = '',
        triggerChooserFn,
        putFn = defaultPutBuffer,
        pollAttempts = 10,
        pollIntervalMs = 700,
        sendTimeoutMs = 130000,
        putTimeoutMs = 30000,
        sleepFn = defaultSleep,
        onTransferAsk = null
    } = options;

    let buffer =
        fileBytes instanceof Uint8Array
            ? Buffer.isBuffer(fileBytes)
                ? fileBytes
                : Buffer.from(fileBytes)
            : null;
    let fileName = String(explicitFileName || '').trim();

    if (!buffer) {
        if (!filePath || !fs.existsSync(filePath)) {
            return { uploaded: false, reason: 'missing_file' };
        }
        buffer = fs.readFileSync(filePath);
        if (!fileName) fileName = path.basename(filePath);
    }
    if (!fileName) fileName = 'upload.bin';

    const filesCheck = await client.call('list_files', { session, arguments: {} }, { throwOnError: true });
    const transferPerm = filesCheck.structured?.permissions?.transfers;
    if (transferPerm === 'deny') {
        return { uploaded: false, reason: 'transfers_denied' };
    }
    if (transferPerm === 'ask' && typeof onTransferAsk === 'function') {
        onTransferAsk({ session, fileName, bytes: buffer.length });
    }

    const sendRes = await client.call(
        'send_file',
        {
            session,
            arguments: { name: fileName, size: buffer.length }
        },
        { timeoutMs: sendTimeoutMs, throwOnError: true }
    );

    const putUrl = sendRes.structured?.url;
    if (!putUrl) {
        throw new Error(`send_file returned no PUT url: ${JSON.stringify(sendRes.structured)}`);
    }

    const putOut = await putFn(putUrl, buffer, putTimeoutMs);
    let fileId = null;
    if (typeof putOut === 'string' && putOut.trim().startsWith('{')) {
        try {
            const parsedPut = JSON.parse(putOut);
            if (Number.isInteger(parsedPut?.id)) fileId = parsedPut.id;
        } catch {
            // fallback to list_files lookup below
        }
    } else if (putOut && typeof putOut === 'object' && Number.isInteger(putOut.id)) {
        fileId = putOut.id;
    }

    if (!fileId) {
        if (pollIntervalMs > 0) await sleepFn(Math.min(600, pollIntervalMs));
        const afterPut = await client.call('list_files', { session, arguments: {} }, { throwOnError: true });
        const sentList = afterPut.structured?.files || [];
        const matched = sentList.find((f) => f.size === buffer.length) || sentList[sentList.length - 1];
        fileId = matched?.id ?? null;
    }
    if (!fileId) {
        throw new Error('File PUT succeeded, but no stored file id was reported by list_files');
    }

    if (typeof triggerChooserFn === 'function') {
        await triggerChooserFn({ fileId, bytes: buffer.length, fileName });
    }

    let chooserReq = null;
    for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
        if (pollIntervalMs > 0) await sleepFn(pollIntervalMs);
        const lf = await client.call('list_files', { session, arguments: {} }, { throwOnError: true });
        if (lf.structured?.chooser?.request) {
            chooserReq = lf.structured.chooser.request;
            break;
        }
    }
    if (!chooserReq) {
        throw new Error('Triggered upload control but file chooser did not open');
    }

    await client.call(
        'choose_files',
        {
            session,
            arguments: { request: chooserReq, files: [fileId] }
        },
        { throwOnError: true }
    );

    return {
        uploaded: true,
        fileId,
        bytes: buffer.length,
        chooserRequest: chooserReq
    };
}
