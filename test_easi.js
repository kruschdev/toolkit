import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
    DEFAULT_CHROME_OMNIBOX_MIN_Y,
    DEFAULT_EDITOR_TAIL_SELECTOR,
    callEasiMcpTool,
    captureCompactUiState,
    createEasiClient,
    detectResumableChunkIndex,
    executeValidatedUiDecision,
    extractSafeWebElements,
    readEditorTailDom,
    resolveBodyEditorClickPoint,
    resolveEasiChromeWindow,
    stepSmallModelNavigator,
    streamContentEditableChunks,
    uploadFileViaChooser
} from './easi.js';

function createMockStdioChild(onRpcRequest) {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.kill = () => {
        child.killed = true;
        queueMicrotask(() => child.emit('close', 0));
    };

    let inBuf = '';
    child.stdin.on('data', (chunk) => {
        inBuf += chunk.toString('utf8');
        let idx;
        while ((idx = inBuf.indexOf('\n')) !== -1) {
            const line = inBuf.slice(0, idx).trim();
            inBuf = inBuf.slice(idx + 1);
            if (!line) continue;
            const req = JSON.parse(line);
            if (req.id === undefined) continue; // notification
            const reply = onRpcRequest(req);
            if (reply) {
                queueMicrotask(() => {
                    child.stdout.write(JSON.stringify(reply) + '\n');
                });
            }
        }
    });
    return child;
}

describe('@krusch/toolkit/easi — Sandboxed Chrome MCP & Small-Model Policy Floor', () => {
    it('reuses a single persistent stdio MCP process across multiple tool calls and attaches call_id', async () => {
        let spawnCount = 0;
        const seenTools = [];

        const client = createEasiClient({
            command: 'mock-easi-bridge',
            autoMock: false,
            spawnFn: () => {
                spawnCount += 1;
                return createMockStdioChild((req) => {
                    if (req.method === 'initialize') {
                        return { jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2025-06-18' } };
                    }
                    if (req.method === 'tools/call') {
                        seenTools.push(req.params);
                        return {
                            jsonrpc: '2.0',
                            id: req.id,
                            result: {
                                isError: false,
                                structuredContent: { ok: true, echoedTool: req.params.name },
                                content: [{ type: 'text', text: `ok:${req.params.name}` }]
                            }
                        };
                    }
                    return null;
                });
            }
        });

        const r1 = await client.call('list_sessions', {});
        const r2 = await client.call('click', {
            session: 'sess-01',
            arguments: { pid: 100, window_id: 1, x: 300, y: 240 }
        });

        assert.equal(spawnCount, 1, 'should spawn persistent stdio process only once');
        assert.equal(r1.ok, true);
        assert.equal(r2.ok, true);
        assert.equal(seenTools.length, 2);
        assert.ok(seenTools[1].arguments.call_id, 'mutating click call should receive automatic call_id');

        await client.close();
    });

    it('keeps event loop refd during in-flight top-level await stdio RPCs and unrefs when idle', () => {
        const __dirname = path.dirname(fileURLToPath(import.meta.url));
        const easiUrl = new URL('./easi.js', import.meta.url).href;
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'easi-ref-'));
        try {
            const bridgePath = path.join(tmpDir, 'mock-bridge.mjs');
            const callerPath = path.join(tmpDir, 'caller.mjs');
            fs.writeFileSync(
                bridgePath,
                [
                    "import readline from 'node:readline';",
                    "const rl = readline.createInterface({ input: process.stdin });",
                    "rl.on('line', (line) => {",
                    "  if (!line.trim()) return;",
                    "  const msg = JSON.parse(line);",
                    "  if (msg.id === undefined) return;",
                    "  setTimeout(() => {",
                    "    const res = msg.method === 'initialize'",
                    "      ? { protocolVersion: '2025-06-18' }",
                    "      : { isError: false, structuredContent: { sessions: [{ id: 'live-1' }] }, content: [] };",
                    "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: res }) + '\\n');",
                    "  }, 60);",
                    "});"
                ].join('\n')
            );
            fs.writeFileSync(
                callerPath,
                [
                    `import { createEasiClient } from ${JSON.stringify(easiUrl)};`,
                    "const client = createEasiClient({",
                    `  command: ${JSON.stringify(process.execPath)},`,
                    `  args: [${JSON.stringify(bridgePath)}],`,
                    "  autoMock: false",
                    "});",
                    "const res = await client.call('list_sessions', {});",
                    "if (!res.ok || res.structured?.sessions?.[0]?.id !== 'live-1') process.exit(2);",
                    "process.stdout.write(JSON.stringify(res.structured));"
                ].join('\n')
            );

            const out = execFileSync(process.execPath, [callerPath], {
                cwd: __dirname,
                encoding: 'utf8',
                timeout: 5000
            });
            assert.deepEqual(JSON.parse(out), { sessions: [{ id: 'live-1' }] });
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('supports HTTP /mcp JSON-RPC and SSE text/event-stream responses with Mcp-Session-Id', async () => {
        const requests = [];
        const client = createEasiClient({
            mcpUrl: 'https://localhost:9443/mcp',
            bearerToken: 'test-token-123',
            autoMock: false,
            fetchImpl: async (_url, init) => {
                const parsed = JSON.parse(init.body);
                requests.push({ headers: init.headers, body: parsed });
                if (parsed.method === 'initialize') {
                    return new Response(
                        JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { protocolVersion: '2025-06-18' } }),
                        {
                            status: 200,
                            headers: {
                                'content-type': 'application/json',
                                'mcp-session-id': 'http-sess-99'
                            }
                        }
                    );
                }
                const ssePayload = `event: message\ndata: ${JSON.stringify({
                    jsonrpc: '2.0',
                    id: parsed.id,
                    result: {
                        structuredContent: { sessions: [{ id: 's-1' }] },
                        content: [{ type: 'text', text: '1 session' }]
                    }
                })}\n\n`;
                return new Response(ssePayload, {
                    status: 200,
                    headers: { 'content-type': 'text/event-stream' }
                });
            }
        });

        const out = await client.call('list_sessions', {});
        assert.equal(out.ok, true);
        assert.equal(out.structured.sessions[0].id, 's-1');
        assert.equal(requests.length, 2);
        assert.equal(requests[0].headers.Authorization, 'Bearer test-token-123');
        assert.equal(requests[1].headers['Mcp-Session-Id'], 'http-sess-99');
    });

    it('enforces stop_session, navigate, and Mojo key-drain Policy Floor invariants', async () => {
        const client = createEasiClient({
            allowStopSession: false,
            allowNavigate: false,
            caller: async (toolName) => ({ ok: true, structured: { toolName }, text: 'ok' })
        });

        await assert.rejects(
            () => client.call('stop_session', { session: 's1' }),
            (err) => err.code === 'POLICY_FLOOR_BLOCK'
        );
        await assert.rejects(
            () => client.call('navigate', { session: 's1', arguments: { url: 'https://example.com' } }),
            (err) => err.code === 'POLICY_FLOOR_BLOCK'
        );

        const allowedStop = await client.call('stop_session', { session: 's1' }, { allowStopSession: true });
        assert.equal(allowedStop.ok, true);

        // Verify automatic list_windows geometry refresh & retry on "No Wayland geometry"
        const retrySeq = [];
        const waylandClient = createEasiClient({
            sleepFn: async () => {},
            caller: async (toolName) => {
                retrySeq.push(toolName);
                if (toolName === 'click' && retrySeq.filter((t) => t === 'click').length === 1) {
                    return { ok: false, error: 'No Wayland geometry for window 1' };
                }
                return { ok: true, structured: { toolName }, text: 'ok' };
            }
        });
        const recovered = await waylandClient.call('click', {
            session: 's1',
            arguments: { pid: 1, window_id: 1, x: 200, y: 200 }
        });
        assert.equal(recovered.ok, true);
        assert.deepEqual(retrySeq, ['click', 'list_windows', 'click']);

        client.setMojoKeyDrain(true);
        assert.equal(client.isMojoKeyDrainActive(), true);
        await assert.rejects(
            () => client.call('get_window_state', { session: 's1', arguments: { pid: 1, window_id: 1 } }),
            (err) => err.code === 'POLICY_FLOOR_BLOCK'
        );
        await assert.rejects(
            () =>
                client.call('type_text', {
                    session: 's1',
                    arguments: { pid: 1, window_id: 1, element_token: 'el:4', text: 'hi' }
                }),
            (err) => err.code === 'POLICY_FLOOR_BLOCK'
        );
        client.setMojoKeyDrain(false);
    });

    it('filters Chrome toolbar/omnibox elements and blocks omnibox clicks in executeValidatedUiDecision', async () => {
        const snapshot = {
            snapshot_id: 'snap-1',
            elements: [
                { index: 1, element_token: 'el:1', role: 'tool bar', label: 'Browser Toolbar', frame: { x: 0, y: 0, w: 1280, h: 80 } },
                { index: 2, parent_index: 1, element_token: 'el:2', role: 'entry', label: 'Address and search bar', frame: { x: 120, y: 42, w: 800, h: 32 } },
                { index: 3, element_token: 'el:3', role: 'button', label: 'Back', frame: { x: 16, y: 40, w: 28, h: 28 } },
                { index: 4, element_token: 'el:4', role: 'button', label: 'Write article', frame: { x: 420, y: 180, w: 140, h: 38 } }
            ]
        };

        const { safeElements } = extractSafeWebElements(snapshot);
        assert.equal(safeElements.length, 1);
        assert.equal(safeElements[0].token, 'el:4');
        assert.equal(safeElements[0].label, 'Write article');

        const clicked = [];
        const client = createEasiClient({
            caller: async (toolName, toolArgs) => {
                clicked.push({ toolName, toolArgs });
                return { ok: true, structured: { clicked: true }, text: 'clicked' };
            }
        });

        await assert.rejects(
            () =>
                executeValidatedUiDecision(client, {
                    session: 's1',
                    pid: 10,
                    windowId: 1,
                    decision: { action: 'click_token', element_token: 'el:2', x: null, y: null, reason: 'bad omnibox' },
                    observation: { safeElements }
                }),
            (err) => err.code === 'POLICY_FLOOR_BLOCK'
        );

        await assert.rejects(
            () =>
                executeValidatedUiDecision(client, {
                    session: 's1',
                    pid: 10,
                    windowId: 1,
                    decision: { action: 'click_xy', element_token: null, x: 300, y: DEFAULT_CHROME_OMNIBOX_MIN_Y - 5, reason: 'bad y' },
                    observation: { safeElements }
                }),
            (err) => err.code === 'POLICY_FLOOR_BLOCK'
        );

        await executeValidatedUiDecision(client, {
            session: 's1',
            pid: 10,
            windowId: 1,
            decision: { action: 'click_token', element_token: 'el:4', x: null, y: null, reason: 'open composer' },
            observation: { safeElements }
        });
        assert.equal(clicked.length, 1);
        assert.equal(clicked[0].toolArgs.arguments.element_token, 'el:4');
    });

    it('cascades small-model UI navigation across local tiers and logs compact observations', async () => {
        const client = createEasiClient({
            caller: async (toolName) => {
                if (toolName === 'list_windows') {
                    return { ok: true, text: 'window_id=7 pid=901 title="LinkedIn"' };
                }
                if (toolName === 'inspect_page') {
                    return {
                        ok: true,
                        structured: {
                            url: 'https://www.linkedin.com/feed/',
                            title: 'Feed | LinkedIn',
                            elements: [{ tag: 'button', text: 'Write article', shown: true, attributes: {} }]
                        }
                    };
                }
                if (toolName === 'get_window_state') {
                    return {
                        ok: true,
                        structured: {
                            snapshot_id: 'snap-li-1',
                            elements: [
                                { index: 10, element_token: 'el:10', role: 'button', label: 'Write article', frame: { x: 500, y: 210, w: 120, h: 36 } }
                            ]
                        }
                    };
                }
                return { ok: true, structured: {} };
            }
        });

        const win = await resolveEasiChromeWindow(client, 'sess-li');
        assert.deepEqual(win, { pid: 901, windowId: 7 });

        const obs = await captureCompactUiState(client, 'sess-li', win.pid, win.windowId);
        assert.equal(obs.safeElements.length, 1);
        assert.equal(obs.domElements[0].text, 'Write article');

        const decisionLog = [];
        let attempts = 0;
        const navOut = await stepSmallModelNavigator({
            stage: 'open_linkedin_article',
            goal: 'Click Write article on the LinkedIn feed.',
            observation: obs,
            decisionLog,
            chatJsonFn: async (_sys, usr, cfg) => {
                assert.equal(usr.includes('\n'), false, 'userPrompt must be single-line compact JSON');
                attempts += 1;
                if (attempts === 1) {
                    throw new Error(`tier 0 ${cfg.model} busy`);
                }
                if (attempts === 2) {
                    return { response: "I'm sorry, I cannot assist with that." };
                }
                return {
                    action: 'click_token',
                    element_token: 'el:10',
                    x: null,
                    y: null,
                    reason: 'Found Write article button'
                };
            }
        });

        assert.equal(attempts, 3);
        assert.equal(navOut.tierIndex, 2);
        assert.equal(navOut.model, 'gemma4:e4b');
        assert.equal(navOut.decision.element_token, 'el:10');
        assert.equal(decisionLog.length, 1);
    });

    it('streams contenteditable chunks with Mojo drain protection, ProseMirror/Draft.js tail polling, and crash resume', async () => {
        assert.ok(DEFAULT_EDITOR_TAIL_SELECTOR.includes('.ProseMirror'));
        assert.ok(DEFAULT_EDITOR_TAIL_SELECTOR.includes("[data-contents='true']"));

        const chunks = [
            'First paragraph of the technical article covering deterministic state machines and bounded memory.',
            'Second paragraph concluding the architectural walkthrough with reproducible verification gates.'
        ];

        assert.equal(
            detectResumableChunkIndex(
                'deterministic state machines and bounded memory.',
                chunks,
                { probeLength: 36 }
            ),
            1
        );

        let inspectCount = 0;
        const typedCalls = [];
        const client = createEasiClient({
            caller: async (toolName, toolArgs) => {
                if (toolName === 'get_window_state') {
                    return {
                        ok: true,
                        structured: {
                            elements: [
                                { index: 5, element_token: 'el:5', role: 'section', label: 'Write here', frame: { x: 300, y: 260, w: 640, h: 400 } },
                                { index: 6, parent_index: 5, element_token: 'el:6', role: 'paragraph', label: '', frame: { x: 300, y: 264, w: 620, h: 28 } }
                            ]
                        }
                    };
                }
                if (toolName === 'type_text') {
                    assert.equal(client.isMojoKeyDrainActive(), true, 'Mojo key-drain lock must be active during type_text');
                    assert.equal(toolArgs.arguments.element_token, undefined, 'must never pass element_token on type_text');
                    typedCalls.push(toolArgs.arguments.text);
                    return { ok: true, structured: {} };
                }
                if (toolName === 'inspect_page') {
                    inspectCount += 1;
                    if (inspectCount === 1) {
                        return { ok: false, error: 'the page did not answer' };
                    }
                    return {
                        ok: true,
                        structured: {
                            url: 'https://www.linkedin.com/pulse/edit/new/',
                            elements: [{ tag: 'p', text: chunks[1] }]
                        }
                    };
                }
                return { ok: true, structured: {} };
            }
        });

        const focusPt = await resolveBodyEditorClickPoint(client, {
            session: 'sess-art',
            pid: 50,
            windowId: 1
        });
        assert.equal(focusPt.source, 'body_placeholder_first_child');
        assert.ok(focusPt.y >= DEFAULT_CHROME_OMNIBOX_MIN_Y);

        const streamRes = await streamContentEditableChunks(client, {
            session: 'sess-art',
            pid: 50,
            windowId: 1,
            chunks,
            startChunkIndex: 1,
            initialWaitMs: 0,
            pollIntervalMs: 0,
            sleepFn: async () => {}
        });

        assert.equal(client.isMojoKeyDrainActive(), false, 'Mojo key-drain lock must reset after streaming');
        assert.equal(typedCalls.length, 1);
        assert.equal(streamRes.chunksTyped, 1);
        assert.ok(streamRes.finalTail.text.includes('reproducible verification gates.'));

        const directTail = await readEditorTailDom(client, 'sess-art');
        assert.equal(directTail.busy, false);
    });

    it('stages files and answers easi.run file chooser requests cleanly in uploadFileViaChooser', async () => {
        let chooserOpened = false;
        let chosenPayload = null;

        const client = createEasiClient({
            caller: async (toolName, toolArgs) => {
                if (toolName === 'list_files') {
                    return {
                        ok: true,
                        structured: {
                            permissions: { transfers: 'allow' },
                            files: [{ id: 77, size: 4 }],
                            chooser: chooserOpened ? { request: 'req-chooser-1' } : null
                        }
                    };
                }
                if (toolName === 'send_file') {
                    return {
                        ok: true,
                        structured: { url: 'https://localhost:9443/upload/ticket-1' }
                    };
                }
                if (toolName === 'choose_files') {
                    chosenPayload = toolArgs.arguments;
                    return { ok: true, structured: {} };
                }
                return { ok: true, structured: {} };
            }
        });

        const uploadRes = await uploadFileViaChooser(client, {
            session: 'sess-up',
            fileBytes: Buffer.from('test'),
            fileName: 'cover.png',
            pollIntervalMs: 0,
            sleepFn: async () => {},
            putFn: async () => JSON.stringify({ id: 77 }),
            triggerChooserFn: async () => {
                chooserOpened = true;
            }
        });

        assert.equal(uploadRes.uploaded, true);
        assert.equal(uploadRes.fileId, 77);
        assert.deepEqual(chosenPayload, { request: 'req-chooser-1', files: [77] });

        const mockDirect = await callEasiMcpTool('start_session', { url: 'https://example.com' }, { mock: true });
        assert.equal(mockDirect.ok, true);
        assert.equal(mockDirect.simulated, true);
    });

    it('compiles strict TypeScript consumers importing @krusch/toolkit/easi via tsc --noEmit --strict', () => {
        const __dirname = path.dirname(fileURLToPath(import.meta.url));
        const localTscBin = path.resolve(__dirname, 'node_modules/.bin/tsc');
        if (!fs.existsSync(localTscBin)) return;

        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'easi-tsc-'));
        try {
            fs.writeFileSync(
                path.join(tmpDir, 'tsconfig.json'),
                JSON.stringify(
                    {
                        compilerOptions: {
                            target: 'ES2022',
                            module: 'NodeNext',
                            moduleResolution: 'NodeNext',
                            strict: true,
                            noEmit: true,
                            skipLibCheck: false,
                            paths: {
                                '@krusch/toolkit/easi': [path.resolve(__dirname, 'types/easi.d.ts')]
                            }
                        },
                        include: ['consumer.ts']
                    },
                    null,
                    2
                )
            );
            fs.writeFileSync(
                path.join(tmpDir, 'consumer.ts'),
                [
                    "import { createEasiClient, stepSmallModelNavigator, streamContentEditableChunks, type EasiClient } from '@krusch/toolkit/easi';",
                    "const client: EasiClient = createEasiClient({ allowStopSession: false });",
                    "void stepSmallModelNavigator({ goal: 'Click Write', observation: { safeElements: [] } });",
                    "void streamContentEditableChunks(client, { session: 's1', pid: 1, windowId: 1, chunks: ['hello'] });"
                ].join('\n')
            );
            execFileSync(localTscBin, ['--project', path.join(tmpDir, 'tsconfig.json')], {
                stdio: 'pipe'
            });
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});
