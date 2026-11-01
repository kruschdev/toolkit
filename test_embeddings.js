import test from 'node:test';
import assert from 'node:assert/strict';
import {
    DEFAULT_EMBED_HOST,
    DEFAULT_EMBED_MODEL,
    DEFAULT_EMBED_DIMS,
    MODEL_PROFILES,
    resolveEmbeddingProfile,
    formatEmbeddingInput,
    l2Normalize,
    isZeroVector,
    cosineSimilarity,
    calibrateQuerySimilarity,
    calculateCentroid,
    validateVectorDimension,
    generateDeterministicVector,
    chunkTextForEmbedding,
    clearToolkitEmbeddingCache,
    embed,
    embedBatch,
    embedChunkedCentroid,
    createEmbeddings
} from './embeddings.js';

function makeScaledVector(dim, seedIndex = 0, scale = 3.0) {
    const vec = new Array(dim).fill(0);
    vec[seedIndex % dim] = scale;
    vec[(seedIndex + 1) % dim] = scale * (4 / 3);
    return vec;
}

function vectorNorm(vec) {
    return Math.sqrt(vec.reduce((acc, v) => acc + v * v, 0));
}

test('@krusch/toolkit/embeddings — Unified Sovereign Embedding Suite (INV-01..INV-06)', async (t) => {
    await t.test('1. Constants, MODEL_PROFILES, and resolveEmbeddingProfile tag normalization', () => {
        assert.match(DEFAULT_EMBED_HOST, /^http:\/\/[\d.]+:11434$/);
        assert.equal(DEFAULT_EMBED_MODEL, 'snowflake-arctic-embed2');
        assert.equal(DEFAULT_EMBED_DIMS, 1024);

        assert.equal(MODEL_PROFILES['bge-large'].ctxTokens, 512);
        assert.equal(MODEL_PROFILES['bge-large'].maxChunkChars, 1100);
        assert.equal(MODEL_PROFILES['bge-large'].mrlDimensions, false);

        assert.equal(MODEL_PROFILES['qwen3-embedding:0.6b'].ctxTokens, 32768);
        assert.equal(MODEL_PROFILES['qwen3-embedding:0.6b'].mrlDimensions, true);

        assert.equal(MODEL_PROFILES['qwen3-embedding:4b'].nativeDimensions, 2560);
        assert.equal(MODEL_PROFILES['qwen3-embedding:4b'].defaultDimensions, 1024);
        assert.equal(MODEL_PROFILES['qwen3-embedding:4b'].mrlDimensions, true);

        assert.equal(MODEL_PROFILES['snowflake-arctic-embed2'].queryStyle, 'arctic');
        assert.equal(MODEL_PROFILES['nomic-embed-text'].defaultDimensions, 768);
        assert.equal(MODEL_PROFILES['gemini-embedding-001'].provider, 'gemini');
        assert.equal(MODEL_PROFILES['gemini-embedding-001'].nativeDimensions, 3072);
        assert.equal(MODEL_PROFILES['gemini-embedding-001'].defaultDimensions, 1024);

        const bgeLatest = resolveEmbeddingProfile('bge-large:latest');
        assert.equal(bgeLatest.queryStyle, 'bge');
        assert.equal(bgeLatest.maxChunkChars, 1100);

        const arcticLatest = resolveEmbeddingProfile('snowflake-arctic-embed2:latest');
        assert.equal(arcticLatest.queryStyle, 'arctic');
        assert.equal(arcticLatest.maxChunkChars, 6000);

        const geminiPrefixed = resolveEmbeddingProfile('models/gemini-embedding-001');
        assert.equal(geminiPrefixed.provider, 'gemini');

        const unknown = resolveEmbeddingProfile('custom-unknown-embed:v1');
        assert.equal(unknown.defaultDimensions, 1024);
        assert.equal(unknown.maxChunkChars, 1100);
    });

    await t.test('2. formatEmbeddingInput asymmetric query vs document formatting (INV-04)', () => {
        const sample = 'GFCI breaker trip in wet kitchen';

        // Document mode never prefixes BGE, Arctic, Qwen3, or Gemini
        assert.equal(formatEmbeddingInput(sample, { model: 'bge-large', mode: 'document' }), sample);
        assert.equal(formatEmbeddingInput(sample, { model: 'qwen3-embedding:4b', mode: 'document' }), sample);
        assert.equal(formatEmbeddingInput(sample, { model: 'snowflake-arctic-embed2', mode: 'document' }), sample);
        assert.equal(formatEmbeddingInput(sample, { model: 'nomic-embed-text', mode: 'document' }), sample);
        assert.equal(
            formatEmbeddingInput(sample, { model: 'nomic-embed-text', mode: 'document', prefixDocuments: true }),
            `search_document: ${sample}`
        );

        // Query mode applies model-specific instruction wrappers
        assert.equal(
            formatEmbeddingInput(sample, { model: 'bge-large:latest', mode: 'query' }),
            `Represent this sentence for searching relevant passages: ${sample}`
        );
        assert.equal(
            formatEmbeddingInput(sample, { model: 'snowflake-arctic-embed2', mode: 'query' }),
            `query: ${sample}`
        );
        assert.equal(
            formatEmbeddingInput(sample, { model: 'nomic-embed-text', mode: 'query' }),
            `search_query: ${sample}`
        );

        for (const domain of ['general', 'code', 'law', 'biz', 'memory']) {
            const formatted = formatEmbeddingInput(sample, {
                model: 'qwen3-embedding:4b',
                mode: 'query',
                domain
            });
            assert.match(formatted, /^Instruct: .+\nQuery:GFCI breaker trip in wet kitchen$/);
        }

        const customQwen = formatEmbeddingInput(sample, {
            model: 'qwen3-embedding:0.6b',
            mode: 'query',
            instruction: 'Retrieve NEC electrical code sections'
        });
        assert.equal(customQwen, `Instruct: Retrieve NEC electrical code sections\nQuery:${sample}`);
    });

    await t.test('3. Vector math, dimension guard, and deterministic unigram+bigram similarity', () => {
        const raw = [3, 4, 0];
        const norm = l2Normalize(raw);
        assert.deepEqual(raw, [3, 4, 0]);
        assert.ok(Math.abs(norm[0] - 0.6) < 1e-9);
        assert.ok(Math.abs(norm[1] - 0.8) < 1e-9);

        const zeroCopy = l2Normalize([0, 0, 0]);
        assert.deepEqual(zeroCopy, [0, 0, 0]);
        assert.equal(isZeroVector(null), true);
        assert.equal(isZeroVector([]), true);
        assert.equal(isZeroVector([0, 0, 0]), true);
        assert.equal(isZeroVector([0, 1e-7, 0]), false);

        assert.ok(Math.abs(cosineSimilarity([1, 0], [1, 0]) - 1) < 1e-9);
        assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
        assert.equal(cosineSimilarity([1, 2], [1, 2, 3]), 0);
        assert.equal(cosineSimilarity(null, [1, 0]), 0);
        assert.equal(cosineSimilarity([0, 0], [1, 0]), 0);

        assert.equal(calculateCentroid([]), null);
        const centroid = calculateCentroid([[2, 0], [0, 2]]);
        assert.ok(Math.abs(vectorNorm(centroid) - 1.0) < 1e-9);
        assert.ok(Math.abs(centroid[0] - Math.SQRT1_2) < 1e-9);

        assert.equal(validateVectorDimension(null, 1024), null);
        assert.equal(validateVectorDimension('invalid', 1024), null);
        assert.throws(
            () => validateVectorDimension(new Array(768).fill(0.1), 1024, 'UnitTest'),
            /UnitTest Dimension Mismatch.*Expected 1024 dimensions, received 768/
        );

        const v1 = generateDeterministicVector('install gfci circuit breaker in kitchen panel', 1024);
        const v2 = generateDeterministicVector('kitchen panel gfci circuit breaker installation', 1024);
        const v3 = generateDeterministicVector('medieval castle siege catapult masonry', 1024);
        assert.equal(v1.length, 1024);
        assert.ok(Math.abs(vectorNorm(v1) - 1.0) < 1e-6);
        assert.deepEqual(v1, generateDeterministicVector('install gfci circuit breaker in kitchen panel', 1024));
        assert.ok(cosineSimilarity(v1, v2) > 0.45, 'Overlapping vocabulary should yield strong cosine similarity');
        assert.ok(cosineSimilarity(v1, v2) > cosineSimilarity(v1, v3) + 0.3);
    });

    await t.test('4. chunkTextForEmbedding scales windows for 512-ctx BGE vs 32K-ctx Qwen3 (INV-03)', () => {
        const denseCode = Array.from({ length: 70 }, (_, idx) =>
            `export function handler_${idx}(req, res) { return res.json({ ok: true, index: ${idx} }); }`
        ).join('\n');
        assert.ok(denseCode.length > 3500 && denseCode.length < 5800);

        const bgeChunks = chunkTextForEmbedding(denseCode, { model: 'bge-large:latest' });
        assert.ok(bgeChunks.length >= 4, `Expected >=4 chunks for 512-ctx BGE, got ${bgeChunks.length}`);
        for (const chunk of bgeChunks) {
            assert.ok(chunk.length <= 1100, `BGE chunk exceeded 1100 chars: ${chunk.length}`);
        }
        // Verify overlap between consecutive chunks
        const tailOfFirst = bgeChunks[0].slice(-120);
        assert.ok(bgeChunks[1].includes(tailOfFirst), 'Consecutive chunks must preserve trailing overlap');

        const qwenChunksSingle = chunkTextForEmbedding(denseCode, { model: 'qwen3-embedding:4b' });
        assert.equal(qwenChunksSingle.length, 1, '32K-ctx model should keep 4.5K-char input in 1 chunk');

        const hugeDoc = denseCode.repeat(4); // ~18K chars
        const qwenChunksMulti = chunkTextForEmbedding(hugeDoc, { model: 'qwen3-embedding:4b' });
        assert.ok(qwenChunksMulti.length >= 3);
        for (const chunk of qwenChunksMulti) {
            assert.ok(chunk.length <= 6000, `Qwen3 chunk exceeded 6000 chars: ${chunk.length}`);
        }
    });

    await t.test('5. embedBatch calls Ollama /api/embed in sub-batches and sends MRL dimensions for qwen3-embedding:4b', async () => {
        clearToolkitEmbeddingCache();
        const calls = [];
        const mockFetch = async (url, init) => {
            const body = JSON.parse(init.body);
            calls.push({ url, body });
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    embeddings: body.input.map((_, idx) => makeScaledVector(1024, idx + calls.length))
                })
            };
        };

        const bgeVectors = await embedBatch(['doc-1', 'doc-2', 'doc-3', 'doc-4', 'doc-5'], {
            model: 'bge-large',
            host: 'http://127.0.0.1:11434',
            batchSize: 2,
            fetchImpl: mockFetch
        });

        assert.equal(bgeVectors.length, 5);
        assert.equal(calls.length, 3);
        assert.equal(calls[0].url, 'http://127.0.0.1:11434/api/embed');
        assert.deepEqual(calls[0].body.input, ['doc-1', 'doc-2']);
        assert.equal(calls[0].body.truncate, true);
        assert.equal(calls[0].body.keep_alive, -1);
        assert.equal('dimensions' in calls[0].body, false, 'Non-MRL bge-large must not pass dimensions');
        assert.ok(Math.abs(vectorNorm(bgeVectors[0]) - 1.0) < 1e-9);

        // Now test MRL qwen3-embedding:4b (2560 native -> 1024 MRL default) in query mode
        calls.length = 0;
        const qwenVectors = await embedBatch(['find socket leaks'], {
            model: 'qwen3-embedding:4b',
            host: 'http://embed-node.example.test:11434',
            mode: 'query',
            domain: 'code',
            fetchImpl: mockFetch
        });

        assert.equal(qwenVectors.length, 1);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, 'http://embed-node.example.test:11434/api/embed');
        assert.equal(calls[0].body.model, 'qwen3-embedding:4b');
        assert.equal(calls[0].body.dimensions, 1024);
        assert.match(calls[0].body.input[0], /^Instruct: .*code.*\nQuery:find socket leaks$/i);
    });

    await t.test('6. embedBatch falls back cleanly on HTTP 404 from /api/embed to sequential /api/embeddings (INV-01)', async () => {
        clearToolkitEmbeddingCache();
        const requests = [];
        const legacyFetch = async (url, init) => {
            const body = JSON.parse(init.body);
            requests.push({ url, body });
            if (url.endsWith('/api/embed')) {
                return { ok: false, status: 404, text: async () => '404 page not found' };
            }
            if (url.endsWith('/api/embeddings')) {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({ embedding: makeScaledVector(1024, requests.length) })
                };
            }
            throw new Error(`Unexpected URL: ${url}`);
        };

        const out = await embedBatch(['alpha', 'beta'], {
            model: 'snowflake-arctic-embed2',
            host: 'http://127.0.0.1:11434/',
            mode: 'query',
            fetchImpl: legacyFetch
        });

        assert.equal(out.length, 2);
        assert.equal(requests.length, 3); // 1x /api/embed (404) + 2x /api/embeddings
        assert.equal(requests[0].url, 'http://127.0.0.1:11434/api/embed');
        assert.equal(requests[1].url, 'http://127.0.0.1:11434/api/embeddings');
        assert.equal(requests[1].body.prompt, 'query: alpha');
        assert.equal(requests[1].body.truncate, true);
        assert.equal(requests[1].body.keep_alive, -1);
        assert.equal(requests[2].body.prompt, 'query: beta');
        assert.ok(Math.abs(vectorNorm(out[0]) - 1.0) < 1e-9);
    });

    await t.test('7. Dimension mismatch rejection and Gemini strict provider isolation (INV-05)', async () => {
        clearToolkitEmbeddingCache();
        const wrongDimFetch = async () => ({
            ok: true,
            status: 200,
            json: async () => ({ embeddings: [new Array(768).fill(0.5)] })
        });

        await assert.rejects(
            () => embedBatch(['mismatch'], { model: 'bge-large', dimensions: 1024, fetchImpl: wrongDimFetch }),
            /Dimension Mismatch.*Expected 1024 dimensions, received 768/
        );

        // Gemini batchEmbedContents with outputDimensionality: 1024
        const geminiCalls = [];
        const geminiFetch = async (url, init) => {
            const body = JSON.parse(init.body);
            geminiCalls.push({ url, body });
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    embeddings: body.requests.map((_, i) => ({ values: makeScaledVector(1024, i) }))
                })
            };
        };

        const gemVecs = await embedBatch(['clause one', 'clause two'], {
            model: 'gemini-embedding-001',
            apiKey: 'fake-gemini-key',
            dimensions: 1024,
            mode: 'document',
            fetchImpl: geminiFetch
        });
        assert.equal(gemVecs.length, 2);
        assert.equal(geminiCalls.length, 1);
        assert.match(geminiCalls[0].url, /:batchEmbedContents\?key=fake-gemini-key$/);
        assert.equal(geminiCalls[0].body.requests[0].outputDimensionality, 1024);

        // Gemini error must NOT silently fall back to Ollama unless allowProviderFallback === true
        const failingGeminiFetch = async (url) => {
            if (url.includes('generativelanguage.googleapis.com')) {
                return { ok: false, status: 503, text: async () => 'Service Unavailable' };
            }
            return {
                ok: true,
                status: 200,
                json: async () => ({ embeddings: [makeScaledVector(1024, 1)] })
            };
        };

        await assert.rejects(
            () => embedBatch(['strict'], {
                model: 'gemini-embedding-001',
                apiKey: 'fake-gemini-key',
                fetchImpl: failingGeminiFetch
            }),
            /Gemini embedContent HTTP 503/
        );

        const allowedFallback = await embedBatch(['explicit-fallback'], {
            model: 'gemini-embedding-001',
            apiKey: 'fake-gemini-key',
            allowProviderFallback: true,
            fetchImpl: failingGeminiFetch
        });
        assert.equal(allowedFallback.length, 1);
        assert.equal(allowedFallback[0].length, 1024);
    });

    await t.test('8. LRU cache isolation by mode/model/dimensions and embedChunkedCentroid', async () => {
        clearToolkitEmbeddingCache();
        let fetchCount = 0;
        const spyFetch = async (_url, init) => {
            fetchCount += 1;
            const body = JSON.parse(init.body);
            const count = Array.isArray(body.input) ? body.input.length : 1;
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    embeddings: Array.from({ length: count }, (_, idx) => makeScaledVector(1024, fetchCount + idx))
                })
            };
        };

        assert.equal(await embed('   ', { fetchImpl: spyFetch }), null);
        assert.equal(fetchCount, 0);

        const docVec1 = await embed('same input', { model: 'bge-large', mode: 'document', fetchImpl: spyFetch });
        docVec1[0] = 999; // Mutate caller copy; cache must stay pristine
        const docVec2 = await embed('same input', { model: 'bge-large', mode: 'document', fetchImpl: spyFetch });
        assert.equal(fetchCount, 1, 'Identical model+mode+text must hit LRU cache');
        assert.notEqual(docVec2[0], 999, 'Cached vector must be immutable against caller mutation');

        await embed('same input', { model: 'bge-large', mode: 'query', fetchImpl: spyFetch });
        assert.equal(fetchCount, 2, 'Query mode must not collide with document mode cache entry');

        await embed('same input', { model: 'snowflake-arctic-embed2', mode: 'document', fetchImpl: spyFetch });
        assert.equal(fetchCount, 3, 'Different model must not collide in LRU cache');

        const longDoc = 'const x = 42;\n'.repeat(250); // 3,500 chars -> 4 chunks on bge-large, 1 batched /api/embed call
        const centroid = await embedChunkedCentroid(longDoc, { model: 'bge-large', fetchImpl: spyFetch });
        assert.equal(fetchCount, 4, 'embedChunkedCentroid must batch all chunks into a single /api/embed request');
        assert.equal(centroid.length, 1024);
        assert.ok(Math.abs(vectorNorm(centroid) - 1.0) < 1e-9);
    });

    await t.test('9. createEmbeddings similaritySearch and Rough-In provider safety (INV-06)', async () => {
        clearToolkitEmbeddingCache();
        const capturedQueries = [];
        const capturedFetchBodies = [];

        const mockDb = {
            query: async (sql, params) => {
                capturedQueries.push({ sql, params });
                return {
                    rows: [
                        {
                            id: 11,
                            document_id: 3,
                            content: 'NEC 210.8(A) requires GFCI protection for dwelling unit kitchens.',
                            chunk_index: 0,
                            metadata: { article: '210.8(A)' },
                            title: 'NEC 2023 Handbook',
                            source_type: 'code',
                            source_ref: 'nec-2023',
                            similarity: 0.91
                        }
                    ]
                };
            }
        };

        const mockFetch = async (_url, init) => {
            const body = JSON.parse(init.body);
            capturedFetchBodies.push(body);
            return {
                ok: true,
                status: 200,
                json: async () => ({ embeddings: [makeScaledVector(1024, 5)] })
            };
        };

        // Provider='ollama' with legacy gemini-embedding-001 default + no apiKey + ollamaUrl -> heals to snowflake-arctic-embed2
        const sparkEmbeddings = createEmbeddings(
            {
                ai: {
                    provider: 'ollama',
                    embeddingModel: 'gemini-embedding-001',
                    apiKey: '',
                    ollamaUrl: 'http://127.0.0.1:11434',
                    maxContextChunks: 5,
                    similarityThreshold: 0.35
                }
            },
            'spark',
            mockDb
        );

        const rows = await sparkEmbeddings.similaritySearch('kitchen GFCI requirement', {
            limit: 4,
            threshold: 0.4,
            fetchImpl: mockFetch
        });

        assert.equal(rows.length, 1);
        assert.equal(rows[0].title, 'NEC 2023 Handbook');
        assert.equal(capturedFetchBodies[0].model, 'snowflake-arctic-embed2');
        assert.equal(
            capturedFetchBodies[0].input[0],
            'query: kitchen GFCI requirement'
        );

        assert.equal(capturedQueries.length, 1);
        assert.match(capturedQueries[0].sql, /FROM chunks c JOIN documents d ON d\.id = c\.document_id/);
        assert.match(capturedQueries[0].sql, /1 - \(c\.embedding <=> \$1::vector\) >= \$2/);
        assert.match(capturedQueries[0].params[0], /^\[[0-9.,eE+-]+\]$/);
        assert.equal(capturedQueries[0].params[1], 0.4);
        assert.equal(capturedQueries[0].params[2], 4);

        // Numeric second argument compatibility (spark/routes/agents.js pattern)
        await sparkEmbeddings.similaritySearch('kitchen GFCI requirement', 7);
        assert.equal(capturedQueries[1].params[1], 0.35);
        assert.equal(capturedQueries[1].params[2], 7);

        // Provider='gemini' without apiKey must NOT silently mix Ollama vectors into Gemini space
        const savedGeminiKey = process.env.GEMINI_API_KEY;
        try {
            delete process.env.GEMINI_API_KEY;
            const strictGemini = createEmbeddings(
                {
                    ai: {
                        provider: 'gemini',
                        embeddingModel: 'gemini-embedding-001',
                        apiKey: '',
                        ollamaUrl: 'http://127.0.0.1:11434'
                    }
                },
                'spark',
                mockDb
            );
            await assert.rejects(
                () => strictGemini.embedText('breaker sizing', { fetchImpl: mockFetch }),
                /requires apiKey or GEMINI_API_KEY/
            );
        } finally {
            if (savedGeminiKey !== undefined) process.env.GEMINI_API_KEY = savedGeminiKey;
        }
    });

    await t.test('10. Mock embeddings (options.mock & MOCK_EMBEDDINGS=1) and 512-entry LRU eviction', async () => {
        clearToolkitEmbeddingCache();
        let networkCalled = false;
        const neverFetch = async () => {
            networkCalled = true;
            throw new Error('Should not perform HTTP calls in mock mode');
        };

        const mockBatch = await embedBatch(['one', 'two'], {
            mock: true,
            dimensions: 512,
            fetchImpl: neverFetch
        });
        assert.equal(networkCalled, false);
        assert.equal(mockBatch.length, 2);
        assert.equal(mockBatch[0].length, 512);
        assert.ok(Math.abs(vectorNorm(mockBatch[0]) - 1.0) < 1e-6);

        const prevMockEnv = process.env.MOCK_EMBEDDINGS;
        try {
            process.env.MOCK_EMBEDDINGS = '1';
            const envMockVec = await embed('env-mock-item', { dimensions: 256, fetchImpl: neverFetch });
            assert.equal(envMockVec.length, 256);
        } finally {
            if (prevMockEnv === undefined) delete process.env.MOCK_EMBEDDINGS;
            else process.env.MOCK_EMBEDDINGS = prevMockEnv;
        }

        // Verify 512-entry true LRU eviction
        clearToolkitEmbeddingCache();
        let fetchHits = 0;
        const countingFetch = async () => {
            fetchHits += 1;
            return {
                ok: true,
                status: 200,
                json: async () => ({ embeddings: [makeScaledVector(1024, fetchHits)] })
            };
        };

        for (let i = 0; i < 512; i++) {
            await embed(`item-${i}`, { fetchImpl: countingFetch });
        }
        assert.equal(fetchHits, 512);

        // Refresh item-0 so item-1 becomes the oldest LRU key
        await embed('item-0', { fetchImpl: countingFetch });
        assert.equal(fetchHits, 512);

        // Insert 513th entry -> evicts item-1, retains item-0
        await embed('item-512', { fetchImpl: countingFetch });
        assert.equal(fetchHits, 513);

        await embed('item-0', { fetchImpl: countingFetch });
        assert.equal(fetchHits, 513, 'Refreshed item-0 must remain in LRU cache');

        await embed('item-1', { fetchImpl: countingFetch });
        assert.equal(fetchHits, 514, 'Oldest unrefreshed item-1 must have been evicted at capacity 512');
    });

    await t.test('12. calibrateQuerySimilarity isotropic InfoNCE calibration vs anisotropic pass-through', () => {
        const denseVec = Array.from({ length: 1024 }, (_, i) => (i % 2 === 0 ? 1 : -1) / 32);
        const sparseVec = [1, 0, 0, 0];

        assert.equal(calibrateQuerySimilarity(-0.04, { model: 'snowflake-arctic-embed2', queryVec: denseVec }), 0);
        assert.ok(calibrateQuerySimilarity(0.06, { model: 'snowflake-arctic-embed2', queryVec: denseVec }) < 0.25);
        assert.ok(calibrateQuerySimilarity(0.39, { model: 'snowflake-arctic-embed2:latest', queryVec: denseVec }) >= 0.68);
        assert.ok(calibrateQuerySimilarity(0.42, { model: 'qwen3-embedding:0.6b', queryVec: denseVec }) >= 0.70);
        assert.equal(calibrateQuerySimilarity(0.39, { model: 'bge-large:latest', queryVec: denseVec }), 0.39);
        assert.equal(calibrateQuerySimilarity(0.39, { model: 'snowflake-arctic-embed2', queryVec: sparseVec }), 0.39);
    });
});
