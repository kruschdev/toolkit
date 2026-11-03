import test from 'node:test';
import assert from 'node:assert/strict';
import {
    chat,
    isGemini4Model,
    normalizeThinkingLevel,
    resolveMaxOutputTokens,
    buildGeminiPayload,
    extractGeminiTextParts,
    resolveModelConfig,
    callGeminiMedia,
    callGeminiMediaJson,
    DEFAULT_RESPONSIVE_BREAKPOINTS,
    captureResponsiveBreakpoints,
    auditPageWithArgon
} from './index.js';

test('@krusch/toolkit/llm — Gemini 4 Argon Developer Guide Compliance Suite', async (t) => {
    await t.test('1. isGemini4Model & normalizeThinkingLevel enforce Gemini 4 Argon rules', () => {
        assert.equal(isGemini4Model('gemini-4-argon'), true);
        assert.equal(isGemini4Model('GEMINI-4-ARGON'), true);
        assert.equal(isGemini4Model('gemini-3.8-flash'), false);
        assert.equal(isGemini4Model('gemini-2.5-pro'), false);

        // Default thinking level for Gemini 4 Argon is 'medium'
        assert.equal(normalizeThinkingLevel(undefined, 'gemini-4-argon'), 'medium');
        assert.equal(normalizeThinkingLevel('HIGH', 'gemini-4-argon'), 'high');
        assert.equal(normalizeThinkingLevel('low', 'gemini-4-argon'), 'low');
        // 'minimal' is rejected by Gemini 4 Argon with HTTP 400; normalized to 'low'
        assert.equal(normalizeThinkingLevel('minimal', 'gemini-4-argon'), 'low');
        assert.equal(normalizeThinkingLevel('MINIMAL', 'gemini-4-argon'), 'low');
    });

    await t.test('2. resolveMaxOutputTokens upgrades legacy 2000 default to 65536 for Gemini 4 Argon', () => {
        assert.equal(resolveMaxOutputTokens('gemini-4-argon', {}, {}), 65536);
        assert.equal(resolveMaxOutputTokens('gemini-4-argon', { maxTokens: 2000 }, {}), 65536);
        assert.equal(resolveMaxOutputTokens('gemini-4-argon', { maxTokens: 2000, strictMaxTokens: true }, {}), 2000);
        assert.equal(resolveMaxOutputTokens('gemini-4-argon', { maxTokens: 262144 }, {}), 262144);
        assert.equal(resolveMaxOutputTokens('gemini-2.5-flash', {}, {}), 2000);
    });

    await t.test('3. buildGeminiPayload omits temperature on Gemini 4 Argon and sets thinkingConfig', () => {
        const argonPayload = buildGeminiPayload(
            'You are a principal systems architect.',
            'Prove lock-free ring buffer linearizability.',
            {
                model: 'gemini-4-argon',
                temperature: 0.7,
                maxTokens: 262144,
                thinkingLevel: 'high'
            },
            {},
            'tok_hop_1'
        );

        assert.equal('temperature' in argonPayload.generationConfig, false);
        assert.equal(argonPayload.generationConfig.maxOutputTokens, 262144);
        assert.deepEqual(argonPayload.generationConfig.thinkingConfig, { thinkingLevel: 'high' });
        assert.equal(argonPayload.continuationToken, 'tok_hop_1');

        const legacyPayload = buildGeminiPayload(
            'System prompt',
            'User prompt',
            {
                model: 'gemini-2.5-flash',
                temperature: 0.4,
                maxTokens: 4096
            }
        );

        assert.equal(legacyPayload.generationConfig.temperature, 0.4);
        assert.equal(legacyPayload.generationConfig.maxOutputTokens, 4096);
        assert.equal('thinkingConfig' in legacyPayload.generationConfig, false);
        assert.equal('continuationToken' in legacyPayload, false);

        // INV-GH-09: Auto-set functionCallingConfig.mode = "NONE" when tools are omitted or empty []
        assert.deepEqual(argonPayload.toolConfig, { functionCallingConfig: { mode: 'NONE' } });
        assert.deepEqual(legacyPayload.toolConfig, { functionCallingConfig: { mode: 'NONE' } });

        const emptyToolsPayload = buildGeminiPayload(
            'System prompt',
            'Emit a ```py block.',
            { model: 'gemini-3.5-flash-lite', tools: [] }
        );
        assert.equal('tools' in emptyToolsPayload, false);
        assert.deepEqual(emptyToolsPayload.toolConfig, { functionCallingConfig: { mode: 'NONE' } });

        const withToolsPayload = buildGeminiPayload(
            'System prompt',
            'Call query_db.',
            {
                model: 'gemini-4-argon',
                tools: [{ functionDeclarations: [{ name: 'query_db', description: 'Run SQL' }] }]
            }
        );
        assert.equal(Array.isArray(withToolsPayload.tools), true);
        assert.equal('toolConfig' in withToolsPayload, false);
    });

    await t.test('4. extractGeminiTextParts filters out internal thought parts', () => {
        const parts = [
            { text: 'Internal chain of thought...', thought: true },
            { text: 'Step 1: Verified invariant.\n' },
            { text: 'Step 2: Completed proof.' }
        ];
        assert.equal(
            extractGeminiTextParts(parts),
            'Step 1: Verified invariant.\nStep 2: Completed proof.'
        );
    });

    await t.test('5. chat() executes multi-hop continuationToken loop and tracks initialPromptTokens', async () => {
        const originalFetch = globalThis.fetch;
        const capturedBodies = [];

        globalThis.fetch = async (_url, init) => {
            const body = JSON.parse(init.body);
            capturedBodies.push(body);

            if (capturedBodies.length === 1) {
                // Hop 1: spent entirely on thinking, returns CONTINUATION
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        candidates: [{
                            content: {
                                role: 'model',
                                parts: [
                                    { text: 'Exploring lemma 1...', thought: true },
                                    { text: '' }
                                ]
                            },
                            finishReason: 'CONTINUATION',
                            continuationToken: 'CiQ4ZmQ3_hop1'
                        }],
                        usageMetadata: {
                            promptTokenCount: 1000,
                            candidatesTokenCount: 0,
                            thoughtsTokenCount: 32768,
                            totalTokenCount: 33768
                        }
                    })
                };
            }

            // Hop 2: continues from token and finishes with STOP
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    candidates: [{
                        content: {
                            role: 'model',
                            parts: [
                                { text: 'Q.E.D. Complete proof.' }
                            ]
                        },
                        finishReason: 'STOP'
                    }],
                    usageMetadata: {
                        promptTokenCount: 33768,
                        cachedContentTokenCount: 32000,
                        candidatesTokenCount: 1200,
                        thoughtsTokenCount: 4000,
                        totalTokenCount: 38968
                    }
                })
            };
        };

        try {
            const result = await chat(
                'Rigorous math prover',
                'Prove the prime number theorem.',
                {
                    provider: 'gemini',
                    model: 'gemini-4-argon',
                    apiKey: 'test-gemini-key',
                    thinkingLevel: 'high',
                    maxTokens: 262144
                },
                {
                    bypassCascade: true,
                    returnFullResponse: true
                }
            );

            assert.equal(capturedBodies.length, 2);
            assert.equal(capturedBodies[0].continuationToken, undefined);
            assert.equal(capturedBodies[1].continuationToken, 'CiQ4ZmQ3_hop1');
            // Original contents must remain identical across hops per long-decode guide
            assert.deepEqual(capturedBodies[0].contents, capturedBodies[1].contents);

            assert.equal(result.text, 'Q.E.D. Complete proof.');
            assert.equal(result.hops, 2);
            assert.equal(result.finishReason, 'STOP');
            assert.equal(result.usage.initialPromptTokens, 1000);
            assert.equal(result.usage.inputTokens, 34768);
            assert.equal(result.usage.cachedTokens, 32000);
            assert.equal(result.usage.outputTokens, 1200);
            assert.equal(result.usage.thoughtTokens, 36768);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    await t.test('6. resolveModelConfig sets 65536 maxTokens and medium thinkingLevel for gemini-4-argon', () => {
        const resolved = resolveModelConfig('architect', {
            tasks: {
                architect: {
                    provider: 'gemini',
                    model: 'gemini-4-argon'
                }
            }
        });
        assert.equal(resolved.maxTokens, 65536);
        assert.equal(resolved.thinkingLevel, 'medium');
    });

    await t.test('7. callGeminiMedia & callGeminiMediaJson default to gemini-4-argon with multi-viewport mediaItems & CONTINUATION', async () => {
        const originalFetch = globalThis.fetch;
        const capturedRequests = [];

        globalThis.fetch = async (url, init) => {
            capturedRequests.push({ url, body: JSON.parse(init.body) });
            if (capturedRequests.length === 1) {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        candidates: [{
                            content: {
                                role: 'model',
                                parts: [{ text: 'Analyzing 375px and 1440px Chrome viewports...', thought: true }]
                            },
                            finishReason: 'CONTINUATION',
                            continuationToken: 'tok_vision_hop1'
                        }],
                        usageMetadata: { promptTokenCount: 2400, thoughtsTokenCount: 8000, totalTokenCount: 10400 }
                    })
                };
            }
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    candidates: [{
                        content: {
                            role: 'model',
                            parts: [{ text: '{"passed":true,"score":96,"findings":[],"summary":"Responsive layout verified across viewports."}' }]
                        },
                        finishReason: 'STOP'
                    }],
                    usageMetadata: { promptTokenCount: 10400, cachedContentTokenCount: 9800, candidatesTokenCount: 45, totalTokenCount: 10445 }
                })
            };
        };

        try {
            const parsed = await callGeminiMediaJson(
                'Audit Chrome viewports',
                null,
                'image/png',
                {
                    apiKey: 'test-key',
                    thinkingLevel: 'high',
                    mediaItems: [
                        { label: 'mobile (375x812)', base64Data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', mimeType: 'image/png' },
                        { label: 'desktop (1440x900)', base64Data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', mimeType: 'image/png' }
                    ]
                }
            );

            assert.equal(capturedRequests.length, 2);
            assert.ok(capturedRequests[0].url.includes('/models/gemini-4-argon:generateContent'));
            assert.equal(capturedRequests[0].body.generationConfig.maxOutputTokens, 65536);
            assert.deepEqual(capturedRequests[0].body.generationConfig.thinkingConfig, { thinkingLevel: 'high' });
            assert.equal(capturedRequests[1].body.continuationToken, 'tok_vision_hop1');
            assert.equal(parsed.passed, true);
            assert.equal(parsed.score, 96);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    await t.test('8. auditPageWithArgon bridges Chrome responsive breakpoints + telemetry to Gemini 4 Argon and supports deterministic fallback', async () => {
        assert.equal(DEFAULT_RESPONSIVE_BREAKPOINTS.length, 3);
        assert.deepEqual(DEFAULT_RESPONSIVE_BREAKPOINTS.map(b => b.name), ['mobile', 'tablet', 'desktop']);

        const mockCaptured = await captureResponsiveBreakpoints('http://localhost:3004', '/tmp/test-audit', {
            captureFn: async (url) => ({
                url,
                title: 'Krusch Companion Dashboard',
                screenshots: DEFAULT_RESPONSIVE_BREAKPOINTS.map(bp => ({
                    name: bp.name,
                    width: bp.width,
                    height: bp.height,
                    path: `/tmp/test-audit/${bp.name}-${bp.width}x${bp.height}.png`,
                    mimeType: 'image/png',
                    base64Data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
                })),
                consoleErrors: [],
                pageErrors: [],
                failedRequests: []
            })
        });

        // Deterministic offline fallback
        const fallbackAudit = await auditPageWithArgon('http://localhost:3004', {
            preCaptured: mockCaptured,
            apiKey: ''
        });
        assert.equal(fallbackAudit.ok, true);
        assert.equal(fallbackAudit.passed, true);
        assert.equal(fallbackAudit.score, 100);
        assert.equal(fallbackAudit.breakpoints.length, 3);

        // Live Gemini 4 Argon path
        const originalFetch = globalThis.fetch;
        globalThis.fetch = async () => ({
            ok: true,
            status: 200,
            json: async () => ({
                candidates: [{
                    content: {
                        role: 'model',
                        parts: [{
                            text: JSON.stringify({
                                passed: true,
                                score: 98,
                                findings: [{
                                    severity: 'minor',
                                    category: 'spacing',
                                    breakpoint: 'mobile',
                                    description: 'Compact header padding at 375px',
                                    recommendation: 'Use --space-3 token on mobile header'
                                }],
                                summary: 'Clean responsive Chrome layout across 375/768/1440px.'
                            })
                        }]
                    },
                    finishReason: 'STOP'
                }],
                usageMetadata: { promptTokenCount: 3000, candidatesTokenCount: 80, totalTokenCount: 3080 }
            })
        });

        try {
            const liveAudit = await auditPageWithArgon('http://localhost:3004', {
                preCaptured: mockCaptured,
                apiKey: 'test-argon-key',
                thinkingLevel: 'high',
                forceLive: true
            });
            assert.equal(liveAudit.ok, true);
            assert.equal(liveAudit.model, 'gemini-4-argon');
            assert.equal(liveAudit.passed, true);
            assert.equal(liveAudit.score, 98);
            assert.equal(liveAudit.findings.length, 1);
            assert.equal(liveAudit.findings[0].breakpoint, 'mobile');
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});

