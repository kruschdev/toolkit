import test from 'node:test';
import assert from 'node:assert/strict';
import {
    decide,
    decideBatch,
    calibrateChoiceLogprobs,
    evaluateDeterministicDecision,
    createSystem1Decider
} from './decide.js';

test('@krusch/toolkit/decide — System 1 Single-Token Logit & Logprob Suite', async (t) => {
    await t.test('1. calibrateChoiceLogprobs computes softmax probabilities over candidate tokens', () => {
        const topLogprobs = [
            { token: ' YES', logprob: -0.05 },
            { token: ' NO', logprob: -3.05 },
            { token: ' Yes', logprob: -1.20 }
        ];
        const res = calibrateChoiceLogprobs(topLogprobs, ['YES', 'NO']);
        assert.equal(res.matchedLogprobs, true);
        assert.equal(res.choice, 'YES');
        assert.ok(res.confidence > 0.94, `Expected confidence > 0.94, got ${res.confidence}`);
        assert.ok(Math.abs(res.probabilities.YES + res.probabilities.NO - 1.0) < 0.001);
    });

    await t.test('2. decide() parses OpenAI/vLLM top_logprobs and returns calibrated System 1 choice', async () => {
        const mockFetch = async () => ({
            ok: true,
            status: 200,
            json: async () => ({
                choices: [{
                    message: { content: 'LOCAL_PACK' },
                    logprobs: {
                        content: [{
                            token: 'LOCAL_PACK',
                            logprob: -0.08,
                            top_logprobs: [
                                { token: 'LOCAL_PACK', logprob: -0.08 },
                                { token: 'STATEWIDE_STATUTE', logprob: -2.60 },
                                { token: 'ABSTAIN', logprob: -4.10 }
                            ]
                        }]
                    }
                }]
            })
        });

        const res = await decide({
            state: { jurisdiction: 'CA-OAKLAND', ordinance: 'OMC 8.22.360', tenantProtected: true },
            question: 'Which authority controls an Oakland OMI eviction notice?',
            choices: ['LOCAL_PACK', 'STATEWIDE_STATUTE', 'ABSTAIN'],
            fetchImpl: mockFetch
        });

        assert.equal(res.mode, 'logprobs');
        assert.equal(res.choice, 'LOCAL_PACK');
        assert.ok(res.confidence > 0.90);
        assert.ok(res.probabilities.LOCAL_PACK > res.probabilities.STATEWIDE_STATUTE);
    });

    await t.test('3. decide() falls back to token mode when endpoint returns single token without logprobs', async () => {
        const mockFetch = async () => ({
            ok: true,
            status: 200,
            json: async () => ({
                choices: [{
                    message: { content: 'NO' }
                }]
            })
        });

        const res = await decide({
            state: 'Single-family home built in 2004, exempt under Costa-Hawkins.',
            question: 'Does municipal rent cap apply?',
            choices: ['YES', 'NO'],
            fetchImpl: mockFetch
        });

        assert.equal(res.mode, 'token');
        assert.equal(res.choice, 'NO');
        assert.equal(res.confidence, 0.9);
    });

    await t.test('4. decide() degrades gracefully to deterministic_fallback when endpoint is unreachable', async () => {
        const failingFetch = async () => {
            throw new Error('ECONNREFUSED');
        };

        const res = await decide({
            state: 'Oakland municipal code OMC 8.22 requires 60-day relocation payment for no-fault eviction.',
            question: 'Does Oakland municipal code require relocation payment for no-fault eviction?',
            choices: ['YES', 'NO'],
            fetchImpl: failingFetch
        });

        assert.equal(res.mode, 'deterministic_fallback');
        assert.equal(res.choice, 'YES');
        assert.ok(res.confidence > 0.5);
    });

    await t.test('5. decideBatch() and createSystem1Decider() LRU cache operate in sub-millisecond time', async () => {
        let fetchCount = 0;
        const mockFetch = async () => {
            fetchCount++;
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    choices: [{
                        message: { content: 'YES' },
                        logprobs: {
                            content: [{
                                top_logprobs: [
                                    { token: 'YES', logprob: -0.02 },
                                    { token: 'NO', logprob: -4.00 }
                                ]
                            }]
                        }
                    }]
                })
            };
        };

        const decider = createSystem1Decider({ fetchImpl: mockFetch, maxCacheSize: 16 });
        const first = await decider.decide({
            state: { statute: 'Civ. Code 1950.5' },
            question: 'Is deposit return deadline 21 calendar days?'
        });
        assert.equal(first.cached, false);
        assert.equal(first.choice, 'YES');
        assert.equal(fetchCount, 1);

        const second = await decider.decide({
            state: { statute: 'Civ. Code 1950.5' },
            question: 'Is deposit return deadline 21 calendar days?'
        });
        assert.equal(second.cached, true);
        assert.equal(second.latencyMs, 0);
        assert.equal(fetchCount, 1, 'LRU cache must serve repeat System 1 query without network I/O');

        const batch = await decideBatch({
            state: { statute: 'Civ. Code 1950.5' },
            questions: [
                'Does AB 12 cap security deposits at 1 month rent?',
                { question: 'Select statutory tier', choices: ['FLOOR', 'CEILING'] }
            ],
            fetchImpl: mockFetch
        });
        assert.equal(batch.length, 2);
        assert.equal(batch[0].choice, 'YES');
    });

    await t.test('6. PriorityQueue enforces concurrency ceiling and round-robin endpoint selection under concurrent load (BUG-02)', async () => {
        const { PriorityQueue, PRIORITY } = await import('./llm-queue.js');
        const pq = new PriorityQueue(2);
        pq.endpoints = ['http://node-1:11434', 'http://node-2:11434', 'http://node-3:11434'];

        let currentInFlight = 0;
        let peakInFlight = 0;
        const seenEndpoints = [];

        const tasks = Array.from({ length: 6 }, (_, idx) =>
            pq.enqueue(async (ep) => {
                seenEndpoints.push(ep);
                currentInFlight++;
                peakInFlight = Math.max(peakInFlight, currentInFlight);
                await new Promise((r) => setTimeout(r, 10));
                currentInFlight--;
                return `${idx}:${ep}`;
            }, idx % 2 === 0 ? PRIORITY.HIGH : PRIORITY.LOW)
        );

        const results = await Promise.all(tasks);
        assert.equal(results.length, 6);
        assert.ok(peakInFlight <= 2, `Expected peakInFlight <= 2, got ${peakInFlight}`);
        assert.equal(pq.active, 0);
        assert.deepEqual(seenEndpoints, [
            'http://node-1:11434',
            'http://node-2:11434',
            'http://node-3:11434',
            'http://node-1:11434',
            'http://node-2:11434',
            'http://node-3:11434'
        ]);
    });
});

