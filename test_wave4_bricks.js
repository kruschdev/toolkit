import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('INV-LEGO-17: @krusch/toolkit/schema builder, JSON Schema compiler, Zod adapter, prototype/DAG/depth guards, and Express middleware', async () => {
    const schemaSource = fs.readFileSync(path.join(__dirname, 'schema.js'), 'utf8');
    assert.equal(/\bnode:[a-z_]+/i.test(schemaSource), false, 'schema.js must remain pure Web-Standards with zero node:* references');

    const { s, toJsonSchema, validateSchema, validatePayload, createSchemaMiddleware } = await import('./schema.js');

    const CreateAgentSchema = s.object({
        email: s.string({ format: 'email', trim: true }),
        slug: s.string({ format: 'slug' }),
        bornOn: s.string({ format: 'iso-date' }),
        retries: s.integer({ min: 0, max: 5, default: 2 }),
        role: s.enum(['auditor', 'worker']),
        tags: s.array(s.string({ minLength: 1 }), { minItems: 1, uniqueItems: true }),
        metadata: s.record(s.union([s.string(), s.number(), s.boolean()])).optional()
    });

    const jsonSchema = toJsonSchema(CreateAgentSchema);
    assert.equal(jsonSchema.type, 'object');
    assert.ok(jsonSchema.required.includes('email'));
    assert.equal(jsonSchema.required.includes('metadata'), false);
    assert.equal(jsonSchema.additionalProperties, true);
    assert.equal(toJsonSchema(s.object({ id: s.string() }, { strict: true })).additionalProperties, false);

    // Valid payload + shared DAG branch reuse + __proto__ stripping
    const sharedMeta = { env: 'prod', active: true };
    const rawPayload = JSON.parse(
        JSON.stringify({
            email: '  ops@example.com  ',
            slug: 'jean-sre-v4',
            bornOn: '2026-10-30',
            role: 'auditor',
            tags: ['lego', 'sre'],
            metadata: sharedMeta,
            extraSecret: 'stripped'
        })
    );
    Object.defineProperty(rawPayload, '__proto__', {
        value: { polluted: true },
        enumerable: true,
        configurable: true
    });

    const validRes = validateSchema(CreateAgentSchema, rawPayload);
    assert.equal(validRes.ok, true);
    assert.equal(validRes.data.email, 'ops@example.com');
    assert.equal(validRes.data.retries, 2);
    assert.equal('extraSecret' in validRes.data, false);
    assert.equal(({}).polluted, undefined);

    // Reject impossible calendar date & boolean-as-number
    const badDate = validatePayload(CreateAgentSchema, {
        ...rawPayload,
        bornOn: '2026-02-30'
    });
    assert.equal(badDate.ok, false);
    assert.equal(badDate.error.code, 'VALIDATION_ERROR');

    const badBoolNum = validateSchema(s.number(), true);
    assert.equal(badBoolNum.ok, false);
    assert.equal(badBoolNum.error.code, 'VALIDATION_ERROR');

    // Shared DAG reference allowed; true cycle rejected with SCHEMA_CIRCULAR_REF
    const dagBranch = { label: 'ok' };
    const dagSchema = s.object({ left: s.object({ label: s.string() }), right: s.object({ label: s.string() }) });
    const dagOk = validateSchema(dagSchema, { left: dagBranch, right: dagBranch });
    assert.equal(dagOk.ok, true);

    const cyclic = { name: 'loop' };
    cyclic.self = cyclic;
    const cycRes = validateSchema(s.any(), cyclic);
    assert.equal(cycRes.ok, false);
    assert.equal(cycRes.error.code, 'SCHEMA_CIRCULAR_REF');

    // maxDepth guard
    let deepObj = { leaf: 'v' };
    for (let i = 0; i < 10; i += 1) deepObj = { child: deepObj };
    const depthRes = validateSchema(s.any(), deepObj, { maxDepth: 5 });
    assert.equal(depthRes.ok, false);
    assert.equal(depthRes.error.code, 'SCHEMA_MAX_DEPTH');

    // Duck-typed Zod adapter
    const fakeZod = {
        safeParse(input) {
            if (input && typeof input.count === 'number') return { success: true, data: { count: input.count } };
            return { success: false, error: { issues: [{ path: ['count'], code: 'invalid_type', message: 'Expected number' }] } };
        }
    };
    assert.equal(validateSchema(fakeZod, { count: 7 }).ok, true);
    assert.equal(validateSchema(fakeZod, { count: 'nope' }).ok, false);

    // Express middleware 200 vs 400
    const mw = createSchemaMiddleware(s.object({ token: s.string({ minLength: 3 }) }));
    let nextCalled = false;
    const okReq = { body: { token: 'abc' } };
    mw(okReq, {}, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.deepEqual(okReq.validated, { token: 'abc' });

    let statusSent = 0;
    let bodySent = null;
    mw(
        { body: { token: 'x' } },
        {
            status(code) { statusSent = code; return this; },
            json(payload) { bodySent = payload; return this; }
        },
        () => { throw new Error('Should not call next on invalid body'); }
    );
    assert.equal(statusSent, 400);
    assert.equal(bodySent.ok, false);
    assert.equal(bodySent.error.code, 'VALIDATION_ERROR');

    // Nested plain JSON Schema default inside s.object + non-throwing cyclic schema default guard
    const hybridDefaultSchema = s.object({ count: { type: 'integer', default: 5 } });
    assert.deepEqual(hybridDefaultSchema.toJsonSchema().required, []);
    const hybridParsed = validateSchema(hybridDefaultSchema, {});
    assert.equal(hybridParsed.ok, true);
    assert.deepEqual(hybridParsed.data, { count: 5 });

    const cyclicDefault = {};
    cyclicDefault.self = cyclicDefault;
    const cyclicSchemaRes = validateSchema({ type: 'object', default: cyclicDefault }, undefined);
    assert.equal(cyclicSchemaRes.ok, false);
    assert.equal(cyclicSchemaRes.error.code, 'INVALID_SCHEMA');
});

test('INV-LEGO-18: @krusch/toolkit/upload filename sanitizer, magic-byte MIME guard, SVG XSS block, and stream-draining multipart parser', async () => {
    const os = await import('node:os');
    const {
        sanitizeUploadFilename,
        sniffMimeMagic,
        verifyUploadMime,
        parseBoundedMultipart
    } = await import('./upload.js');
    const { auditBoilerplateText } = await import('./catalog.js');
    const { scoutHomelabLegoCandidates } = await import('./lego-scout.js');

    assert.equal(sanitizeUploadFilename('../../etc/passwd'), 'passwd');
    assert.equal(sanitizeUploadFilename('..\\..\\CON.txt'), '_CON.txt');
    assert.equal(sanitizeUploadFilename('../../..'), 'upload.bin');
    assert.equal(sanitizeUploadFilename('.env'), 'env');
    assert.equal(sanitizeUploadFilename('report\u202Egpj.exe'), 'reportgpj.exe');

    const pngHeader = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
    assert.equal(sniffMimeMagic(pngHeader), 'image/png');

    // Spoofed SVG/script claiming image/png, image/*, audio/*, video/*, or default options MUST fail closed with UPLOAD_MIME_MISMATCH
    const svgBytes = new TextEncoder().encode('<svg onload="alert(1)"></svg>');
    const spoofedPng = verifyUploadMime(svgBytes, 'image/png', { allowedMimeTypes: ['image/*'] });
    assert.equal(spoofedPng.ok, false);
    assert.equal(spoofedPng.error.code, 'UPLOAD_MIME_MISMATCH');

    const svgWildcard = verifyUploadMime(svgBytes, 'image/svg+xml', { allowedMimeTypes: ['image/*'] });
    assert.equal(svgWildcard.ok, false);
    assert.equal(svgWildcard.error.code, 'UPLOAD_MIME_MISMATCH');

    const svgDefault = verifyUploadMime(svgBytes, 'image/svg+xml');
    assert.equal(svgDefault.ok, false);
    assert.equal(svgDefault.error.code, 'UPLOAD_MIME_MISMATCH');

    const spoofedAudio = verifyUploadMime(svgBytes, 'audio/flac', { allowedMimeTypes: ['audio/*'] });
    assert.equal(spoofedAudio.ok, false);
    assert.equal(spoofedAudio.error.code, 'UPLOAD_MIME_MISMATCH');

    const spoofedVideo = verifyUploadMime(svgBytes, 'video/mp4', { allowedMimeTypes: ['video/*'] });
    assert.equal(spoofedVideo.ok, false);
    assert.equal(spoofedVideo.error.code, 'UPLOAD_MIME_MISMATCH');

    const missingBinaryMagic = verifyUploadMime(new TextEncoder().encode('plain text'), '', {
        allowedMimeTypes: ['application/pdf']
    });
    assert.equal(missingBinaryMagic.ok, false);
    assert.equal(missingBinaryMagic.error.code, 'UPLOAD_MIME_MISMATCH');

    // Fail-closed rejection of prototype-polluting multipart field names (__proto__ / constructor / prototype)
    const boundary = '----KruschBoundary7MA4YWxkTrZu0gW';
    const protoBody = `--${boundary}\r\nContent-Disposition: form-data; name="__proto__"\r\n\r\nhacked\r\n--${boundary}--\r\n`;
    const protoParsed = await parseBoundedMultipart(
        new Request('http://127.0.0.1/upload', {
            method: 'POST',
            headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
            body: protoBody
        })
    );
    assert.equal(protoParsed.ok, false);
    assert.equal(protoParsed.error.code, 'UPLOAD_MALFORMED_PART');
    assert.equal(({}).hacked, undefined);

    // Valid multipart Request with text field + path-traversal filename + PNG magic check
    const partHead2 = `--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\nQuarterly Audit\r\n`;
    const partHead3 = `--${boundary}\r\nContent-Disposition: form-data; name="avatar"; filename="../badge.png"\r\nContent-Type: image/png\r\n\r\n`;
    const partTail = `\r\n--${boundary}--\r\n`;

    const enc = new TextEncoder();
    const b1 = enc.encode(partHead2 + partHead3);
    const b3 = enc.encode(partTail);
    const fullBody = new Uint8Array(b1.length + pngHeader.length + b3.length);
    fullBody.set(b1, 0);
    fullBody.set(pngHeader, b1.length);
    fullBody.set(b3, b1.length + pngHeader.length);

    const webReq = new Request('http://127.0.0.1/upload', {
        method: 'POST',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        body: fullBody
    });

    const parsed = await parseBoundedMultipart(webReq, {
        allowedMimeTypes: ['image/*'],
        maxTotalBytes: 10_000
    });
    assert.equal(parsed.ok, true);
    assert.equal(parsed.data.fields.title, 'Quarterly Audit');
    assert.equal(parsed.data.files.length, 1);
    assert.equal(parsed.data.files[0].filename, 'badge.png');
    assert.equal(parsed.data.files[0].detectedMime, 'image/png');

    // Node Readable stream exceeding maxTotalBytes drains cleanly without buffering or hanging
    let drainedChunks = 0;
    const oversizedNodeStream = Readable.from(
        (async function* () {
            for (let i = 0; i < 8; i += 1) {
                drainedChunks += 1;
                yield Buffer.alloc(1024, 0x41);
            }
        })()
    );
    oversizedNodeStream.headers = { 'content-type': `multipart/form-data; boundary=${boundary}` };

    const tooLarge = await parseBoundedMultipart(oversizedNodeStream, { maxTotalBytes: 2048 });
    assert.equal(tooLarge.ok, false);
    assert.equal(tooLarge.error.code, 'UPLOAD_TOO_LARGE');
    assert.ok(drainedChunks >= 3, 'Expected stream to drain cleanly');

    // Catalog Rule 9 + Lego Scout DFA prefilter parity (multer + source-only httpx/streamlit)
    const multerDirty = auditBoilerplateText(
        "import multer from 'multer';\nconst upload = multer({ dest: '/tmp' });\n",
        'src/routes/upload.js'
    );
    assert.equal(multerDirty.data.clean, false);
    assert.ok(multerDirty.data.findings.some((f) => f.ruleId === 'raw-multer-upload'));

    const uploadClean = auditBoilerplateText(
        "import { parseBoundedMultipart } from '@krusch/toolkit/upload';\nexport const h = (req) => parseBoundedMultipart(req);\n",
        'src/routes/upload.js'
    );
    assert.equal(uploadClean.data.clean, true);

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'w4-scout-'));
    try {
        fs.mkdirSync(path.join(tmpRoot, 'proj-multer', 'src'), { recursive: true });
        fs.writeFileSync(
            path.join(tmpRoot, 'proj-multer', 'src', 'upload.js'),
            "import multer from 'multer';\nexport const up = multer({ dest: '/tmp' });\n"
        );
        fs.mkdirSync(path.join(tmpRoot, 'proj-py'), { recursive: true });
        fs.writeFileSync(
            path.join(tmpRoot, 'proj-py', 'app.py'),
            "import streamlit as st\nasync def call():\n    async with httpx.AsyncClient() as c:\n        return c\n"
        );
        const scoutRes = scoutHomelabLegoCandidates(tmpRoot, { portablePaths: true });
        assert.equal(scoutRes.ok, true);
        const multerAdoption = scoutRes.data.adoptionFindings.find((f) => f.project === 'proj-multer');
        assert.ok(multerAdoption && multerAdoption.rulesTriggered.includes('raw-multer-upload'));
        const httpxCluster = scoutRes.data.candidateClusters.find((c) => c.id === 'python-httpx-resilience');
        const stCluster = scoutRes.data.candidateClusters.find((c) => c.id === 'streamlit-rag-shell');
        assert.ok(httpxCluster.projects.includes('proj-py'));
        assert.ok(stCluster.projects.includes('proj-py'));
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('INV-LEGO-19: @krusch/toolkit/cascade <25us tier selector, single-flight HALF_OPEN circuit breaker, burst probe, and fallback executor', async () => {
    const cascadeSource = fs.readFileSync(path.join(__dirname, 'cascade.js'), 'utf8');
    assert.equal(/\bnode:[a-z_]+/i.test(cascadeSource), false, 'cascade.js must have zero node:* references');
    assert.equal(/(?:192\.168\.|10\.10\.10\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(cascadeSource), false, 'Zero private/Tailscale IPs allowed in cascade.js');

    const {
        DEFAULT_FLEET_CASCADE_TIERS,
        createTierCircuitBreaker,
        selectCascadeTier,
        probeBurstEndpoint,
        executeWithCascadeFallback
    } = await import('./cascade.js');

    assert.equal(DEFAULT_FLEET_CASCADE_TIERS.length, 4);

    let nowMs = 1_000_000;
    const breaker = createTierCircuitBreaker({
        failureThreshold: 2,
        cooldownMs: 5_000,
        nowFn: () => nowMs
    });

    breaker.recordFailure('L1_FAST', 'timeout');
    assert.equal(breaker.getState('L1_FAST').state, 'CLOSED');
    breaker.recordFailure('L1_FAST', 'timeout');
    assert.equal(breaker.getState('L1_FAST').state, 'OPEN');
    assert.equal(breaker.canAttempt('L1_FAST').allowed, false);

    // Advance past cooldown -> single-flight HALF_OPEN probe guard (both canAttempt & selectCascadeTier)
    nowMs += 5_100;
    const preProbeSel = selectCascadeTier({ complexityScore: 0.1, breaker });
    assert.equal(preProbeSel.data.selectedTier.id, 'L1_FAST');
    const probe1 = breaker.canAttempt('L1_FAST');
    const probe2 = breaker.canAttempt('L1_FAST');
    assert.equal(probe1.allowed, true);
    assert.equal(probe1.probe, true);
    assert.equal(probe2.allowed, false, 'Concurrent caller must not stampede HALF_OPEN tier');
    const inFlightSel = selectCascadeTier({ complexityScore: 0.1, breaker });
    assert.notEqual(inFlightSel.data.selectedTier.id, 'L1_FAST', 'selectCascadeTier must skip HALF_OPEN tier with active probe');

    breaker.recordSuccess('L1_FAST');
    assert.equal(breaker.getState('L1_FAST').state, 'CLOSED');

    // Deterministic tier selection & <50us micro-benchmark check
    const sel = selectCascadeTier({ complexityScore: 0.65, requiresTools: true, allowBurst: false, breaker });
    assert.equal(sel.ok, true);
    assert.equal(sel.data.selectedTier.id, 'L2_HEAVY_MOE');

    const t0 = performance.now();
    for (let i = 0; i < 1000; i += 1) {
        selectCascadeTier({ complexityScore: (i % 10) / 10, requiresTools: true, breaker });
    }
    const avgUs = ((performance.now() - t0) * 1000) / 1000;
    assert.ok(avgUs < 50, `Expected <50us per selectCascadeTier call, got ${avgUs.toFixed(2)}us`);

    // Burst endpoint probe
    const probeOk = await probeBurstEndpoint('http://127.0.0.1:11435', {
        expectedModel: 'gpt-oss:120b',
        fetchImpl: async () => new Response(JSON.stringify({ models: [{ name: 'gpt-oss:120b' }] }), { status: 200 })
    });
    assert.equal(probeOk.ok, true);
    assert.equal(probeOk.data.modelReady, true);

    // Fallback execution: L1 fails -> L2 succeeds
    const execRes = await executeWithCascadeFallback(
        sel.data.candidateChain,
        async (tier) => {
            if (tier.id === 'L2_HEAVY_MOE') throw new Error('VRAM busy');
            return { answer: 'healed', servedBy: tier.id };
        },
        { breaker }
    );
    assert.equal(execRes.ok, true);
    assert.equal(execRes.data.tierId, 'L3_FRONTIER_ARGON');
    assert.equal(execRes.data.attemptCount, 2);
});

test('INV-LEGO-20: @krusch/toolkit/audio isomorphic WAV PCM16 framing, JUNK chunk tolerance, Whisper STT, and bounded streaming TTS', async () => {
    const audioSource = fs.readFileSync(path.join(__dirname, 'audio.js'), 'utf8');
    assert.equal(/\bnode:[a-z_]+/i.test(audioSource), false, 'audio.js must remain pure Web-Standards with zero node:* references');

    const {
        encodeWavPcm16,
        parseWavHeader,
        transcribeWhisperAudio,
        synthesizeSpeechAudio
    } = await import('./audio.js');

    const samples = new Float32Array([0, 0.5, -0.5, 1.5, -1.5, Number.NaN]);
    const wav = encodeWavPcm16(samples, { sampleRate: 16_000, channels: 1 });
    assert.equal(wav.byteLength, 44 + samples.length * 2);

    const headerRes = parseWavHeader(wav);
    assert.equal(headerRes.ok, true);
    assert.equal(headerRes.data.sampleRate, 16_000);
    assert.equal(headerRes.data.channels, 1);
    assert.equal(headerRes.data.bitsPerSample, 16);
    assert.equal(headerRes.data.dataBytes, samples.length * 2);

    // Whisper STT mock roundtrip
    const sttRes = await transcribeWhisperAudio(wav, {
        language: 'en',
        fetchImpl: async (_url, init) => {
            assert.equal(init.method, 'POST');
            assert.ok(init.body instanceof FormData);
            return new Response(JSON.stringify({ text: 'All systems nominal', language: 'en', duration: 0.4, segments: [] }), {
                status: 200,
                headers: { 'content-type': 'application/json' }
            });
        }
    });
    assert.equal(sttRes.ok, true);
    assert.equal(sttRes.data.text, 'All systems nominal');

    // Streaming TTS enforcing maxResponseBytes cap
    const ttsTooBig = await synthesizeSpeechAudio('Hello homelab', {
        maxResponseBytes: 16,
        fetchImpl: async () => new Response(new Uint8Array(64), { status: 200, headers: { 'content-type': 'audio/wav' } })
    });
    assert.equal(ttsTooBig.ok, false);
    assert.equal(ttsTooBig.error.code, 'AUDIO_RESPONSE_TOO_LARGE');

    const ttsOk = await synthesizeSpeechAudio('Hello homelab', {
        maxResponseBytes: 1024,
        fetchImpl: async () => new Response(wav, { status: 200, headers: { 'content-type': 'audio/wav' } })
    });
    assert.equal(ttsOk.ok, true);
    assert.equal(ttsOk.data.byteLength, wav.byteLength);

    // Whisper STT fail-closed on malformed JSON (when application/json declared) and HTML gateway responses
    const sttTruncatedJson = await transcribeWhisperAudio(wav, {
        fetchImpl: async () =>
            new Response('{"text": "cut-off', {
                status: 200,
                headers: { 'content-type': 'application/json' }
            })
    });
    assert.equal(sttTruncatedJson.ok, false);
    assert.equal(sttTruncatedJson.error.code, 'AUDIO_UPSTREAM_ERROR');

    const sttJsonArray = await transcribeWhisperAudio(wav, {
        fetchImpl: async () =>
            new Response('["unexpected-array"]', {
                status: 200,
                headers: { 'content-type': 'application/json; charset=utf-8' }
            })
    });
    assert.equal(sttJsonArray.ok, false);
    assert.equal(sttJsonArray.error.code, 'AUDIO_UPSTREAM_ERROR');

    const sttHtmlGateway = await transcribeWhisperAudio(wav, {
        fetchImpl: async () =>
            new Response('<!DOCTYPE html><html><body>502 Bad Gateway</body></html>', {
                status: 200,
                headers: { 'content-type': 'text/html' }
            })
    });
    assert.equal(sttHtmlGateway.ok, false);
    assert.equal(sttHtmlGateway.error.code, 'AUDIO_UPSTREAM_ERROR');
});

test('Referee Pass 3 & 4 Regressions: post-truncation DOS stems, overflow stream error safety, and INVALID_SCHEMA issues details', async () => {
    const { PassThrough } = await import('node:stream');
    const { sanitizeUploadFilename, parseBoundedMultipart } = await import('./upload.js');
    const { validateSchema } = await import('./schema.js');

    // Post-truncation Windows reserved device stems must remain neutralized
    assert.equal(sanitizeUploadFilename('CONFERENCE.jpeg', { maxLength: 8 }), '_CO.jpeg');
    assert.equal(sanitizeUploadFilename('COM1_extra.png', { maxLength: 8 }), '_COM.png');
    const noExtReserved = sanitizeUploadFilename('CONFERENCE_LONG_STEM', { maxLength: 8 });
    assert.ok(noExtReserved.length <= 8);
    assert.notEqual(noExtReserved.split('.')[0].toUpperCase(), 'CON');

    // Overflowing Node stream emitting asynchronous 'error' after rejection must NOT throw ERR_UNHANDLED_ERROR or leak listeners
    const pt = new PassThrough();
    pt.headers = { 'content-type': 'multipart/form-data; boundary=----TestBound123' };
    const parsePromise = parseBoundedMultipart(pt, { maxTotalBytes: 64 });
    pt.write(Buffer.alloc(128, 0x42));
    const overflowRes = await parsePromise;
    assert.equal(overflowRes.ok, false);
    assert.equal(overflowRes.error.code, 'UPLOAD_TOO_LARGE');

    assert.doesNotThrow(() => {
        pt.emit('error', new Error('ECONNRESET_AFTER_OVERFLOW'));
        pt.emit('close');
    });
    assert.equal(pt.listenerCount('error'), 0);
    assert.equal(pt.listenerCount('data'), 0);
    assert.equal(pt.listenerCount('close'), 0);

    // Early INVALID_SCHEMA returns in validateSchema must always populate error.details.issues
    for (const badSchema of [
        null,
        [],
        new Date(),
        { type: 'not-a-json-type' },
        { safeParse: () => null }
    ]) {
        const badRes = validateSchema(badSchema, { ok: 1 });
        assert.equal(badRes.ok, false);
        assert.equal(badRes.error.code, 'INVALID_SCHEMA');
        assert.equal(Array.isArray(badRes.error.details?.issues), true);
        assert.equal(badRes.error.details.issues.length, 1);
    }
});

test('Referee Pass 5 & 6 Regressions: Zod v3/v4 toJsonSchema, non-plain class instances, hostile getters/Proxies, and MultipartBufferInput Headers', async () => {
    const { z } = await import('zod');
    const { s, toJsonSchema, validateSchema } = await import('./schema.js');
    const { parseBoundedMultipart } = await import('./upload.js');

    // REF5-01: Direct toJsonSchema(z.object(...)), transform fallback, and nested Zod inside s.object
    const zodDirect = toJsonSchema(
        z.object({
            name: z.string(),
            count: z.number().optional(),
            active: z.boolean().default(true)
        })
    );
    assert.equal(zodDirect.type, 'object');
    assert.equal('$schema' in zodDirect, false);
    assert.equal(zodDirect.properties.name.type, 'string');
    assert.deepEqual(zodDirect.required, ['name']);

    const zodTransformFallback = toJsonSchema(
        z.object({
            slug: z.string().transform((v) => v.trim())
        })
    );
    assert.equal(zodTransformFallback.type, 'object');
    assert.equal(zodTransformFallback.properties.slug.type, 'string');
    assert.deepEqual(zodTransformFallback.required, ['slug']);

    const mixedBuilder = s.object({
        reqZod: z.string(),
        optZod: z.number().optional(),
        defZod: z.boolean().default(false)
    });
    const mixedJson = mixedBuilder.toJsonSchema();
    assert.deepEqual(mixedJson.required, ['reqZod']);
    assert.equal(mixedJson.properties.reqZod.type, 'string');
    assert.equal(mixedJson.properties.optZod.type, 'number');
    assert.equal(mixedJson.properties.defZod.type, 'boolean');

    // REF5-02: Non-plain class instances (URL, custom class) must NOT pass as plain objects
    class CustomPayload {
        constructor() {
            this.href = 'https://krusch.dev';
        }
    }
    for (const nonPlain of [new URL('https://krusch.dev'), new CustomPayload()]) {
        const bRes = validateSchema(s.object({ href: s.string().optional() }), nonPlain);
        assert.equal(bRes.ok, false);
        assert.equal(bRes.error.code, 'VALIDATION_ERROR');

        const rawRes = validateSchema({ type: 'object' }, nonPlain);
        assert.equal(rawRes.ok, false);
        assert.equal(rawRes.error.code, 'VALIDATION_ERROR');

        const recRes = s.record(s.string()).safeParse(nonPlain);
        assert.equal(recRes.success, false);
    }

    // REF6-03: Hostile throwing getters and Proxies must never throw and must return VALIDATION_ERROR (not INVALID_SCHEMA)
    const hostileGetterObj = {};
    Object.defineProperty(hostileGetterObj, 'trap', {
        enumerable: true,
        get() {
            throw new Error('hostile_getter_boom');
        }
    });
    const hostileProxy = new Proxy(
        {},
        {
            ownKeys() {
                throw new Error('hostile_proxy_boom');
            }
        }
    );
    for (const hostile of [hostileGetterObj, hostileProxy]) {
        const res1 = validateSchema(s.object({ trap: s.string().optional() }), hostile);
        assert.equal(res1.ok, false);
        assert.equal(res1.error.code, 'VALIDATION_ERROR');

        const res2 = validateSchema({ type: 'object', properties: { trap: { type: 'string' } } }, hostile);
        assert.equal(res2.ok, false);
        assert.equal(res2.error.code, 'VALIDATION_ERROR');

        const sp = s.object({ trap: s.string().optional() }).safeParse(hostile);
        assert.equal(sp.success, false);
        assert.equal(sp.error.issues[0].code, 'VALIDATION_ERROR');
    }

    // REF6-01: MultipartBufferInput with Web Headers instance + arrayBuffer()-only Web Request mock
    const boundary = '----Wave4BufHeadersBoundary';
    const rawMultipart = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="note"\r\n\r\nhello-headers\r\n--${boundary}--\r\n`,
        'utf8'
    );
    const bufHeadersRes = await parseBoundedMultipart({
        body: rawMultipart,
        headers: new Headers({ 'content-type': `multipart/form-data; boundary=${boundary}` })
    });
    assert.equal(bufHeadersRes.ok, true);
    assert.equal(bufHeadersRes.data.fields.note, 'hello-headers');

    const arrayBufferOnlyReq = {
        headers: new Headers({ 'content-type': `multipart/form-data; boundary=${boundary}` }),
        body: null,
        async arrayBuffer() {
            return rawMultipart.buffer.slice(
                rawMultipart.byteOffset,
                rawMultipart.byteOffset + rawMultipart.byteLength
            );
        }
    };
    const abReqRes = await parseBoundedMultipart(arrayBufferOnlyReq);
    assert.equal(abReqRes.ok, true);
    assert.equal(abReqRes.data.fields.note, 'hello-headers');
});

test('Referee Pass 7 & 8 Regressions: Map/Set/expando cycles, hostile schema Proxies, WAV blockAlign=0, STT missing text, and TTS non-audio/0-byte fail-closed', async () => {
    const { s, toJsonSchema, validateSchema } = await import('./schema.js');
    const {
        encodeWavPcm16,
        parseWavHeader,
        transcribeWhisperAudio,
        synthesizeSpeechAudio
    } = await import('./audio.js');

    // REF8-03: Cycles via Map/Set entries or expando properties on Map/Date/Array must fail closed with SCHEMA_CIRCULAR_REF
    const cycMapProp = new Map();
    cycMapProp.self = cycMapProp;
    assert.equal(validateSchema(s.any(), cycMapProp).error?.code, 'SCHEMA_CIRCULAR_REF');

    const cycMapEntry = new Map();
    cycMapEntry.set('loop', cycMapEntry);
    assert.equal(validateSchema(s.any(), cycMapEntry).error?.code, 'SCHEMA_CIRCULAR_REF');

    const cycSet = new Set();
    cycSet.add(cycSet);
    assert.equal(validateSchema(s.any(), cycSet).error?.code, 'SCHEMA_CIRCULAR_REF');

    const cycDate = new Date();
    cycDate.self = cycDate;
    assert.equal(validateSchema(s.any(), cycDate).error?.code, 'SCHEMA_CIRCULAR_REF');

    const cycArrProp = [];
    cycArrProp.self = cycArrProp;
    assert.equal(validateSchema(s.any(), cycArrProp).error?.code, 'SCHEMA_CIRCULAR_REF');

    // REF8-04: Hostile Proxy passed as schema must return INVALID_SCHEMA in validateSchema and throw TypeError in toJsonSchema
    const hostileSchemaProxy = new Proxy(
        {},
        {
            get() {
                throw new Error('schema_proxy_boom');
            }
        }
    );
    const badSchemaEnv = validateSchema(hostileSchemaProxy, { a: 1 });
    assert.equal(badSchemaEnv.ok, false);
    assert.equal(badSchemaEnv.error.code, 'INVALID_SCHEMA');
    assert.throws(() => toJsonSchema(hostileSchemaProxy), TypeError);

    // REF8-05: WAV blockAlign === 0, STT JSON missing string text, and TTS JSON/HTML/0-byte responses
    const validWav = encodeWavPcm16(new Int16Array([0, 1000, -1000]), { sampleRate: 16000, channels: 1 });
    const zeroBlockAlignWav = new Uint8Array(validWav);
    new DataView(zeroBlockAlignWav.buffer).setUint16(32, 0, true);
    const badWav = parseWavHeader(zeroBlockAlignWav);
    assert.equal(badWav.ok, false);
    assert.equal(badWav.error.code, 'WAV_INVALID_HEADER');

    for (const badSttJson of [
        JSON.stringify({ error: { message: 'model overloaded' } }),
        JSON.stringify({ text: { nested: 1 } })
    ]) {
        const sttErr = await transcribeWhisperAudio(validWav, {
            fetchImpl: async () =>
                new Response(badSttJson, {
                    status: 200,
                    headers: { 'content-type': 'application/json' }
                })
        });
        assert.equal(sttErr.ok, false);
        assert.equal(sttErr.error.code, 'AUDIO_UPSTREAM_ERROR');
    }

    for (const [body, ct] of [
        [JSON.stringify({ error: 'voice missing' }), 'application/json'],
        ['<html><body>502 Bad Gateway</body></html>', 'text/html; charset=utf-8'],
        [new Uint8Array(0), 'audio/wav']
    ]) {
        const ttsErr = await synthesizeSpeechAudio('System check', {
            fetchImpl: async () =>
                new Response(body, {
                    status: 200,
                    headers: { 'content-type': ct }
                })
        });
        assert.equal(ttsErr.ok, false);
        assert.equal(ttsErr.error.code, 'AUDIO_UPSTREAM_ERROR');
    }
});

test('Wave 4 Pass 10 Regressions: upload byte/empty parity, TypedArray expando isolation, and null options safety', async () => {
    const { s, validateSchema, createSchemaMiddleware } = await import('./schema.js');
    const { sanitizeUploadFilename, verifyUploadMime, parseBoundedMultipart } = await import('./upload.js');
    const {
        createTierCircuitBreaker,
        selectCascadeTier,
        probeBurstEndpoint,
        executeWithCascadeFallback
    } = await import('./cascade.js');
    const {
        encodeWavPcm16,
        parseWavHeader,
        transcribeWhisperAudio,
        synthesizeSpeechAudio
    } = await import('./audio.js');

    // REF10-02: verifyUploadMime rejects non-byte inputs (UPLOAD_INVALID_DATA) and 0-byte inputs (UPLOAD_EMPTY)
    const nonByteMime = verifyUploadMime(null, 'application/octet-stream', { requireMagicMatch: false });
    assert.equal(nonByteMime.ok, false);
    assert.equal(nonByteMime.error.code, 'UPLOAD_INVALID_DATA');

    const emptyMime = verifyUploadMime(new Uint8Array(0), 'application/octet-stream', {
        requireMagicMatch: false
    });
    assert.equal(emptyMime.ok, false);
    assert.equal(emptyMime.error.code, 'UPLOAD_EMPTY');

    const boundary = '----KruschPass10Boundary';
    const emptyFileMultipart = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="empty.bin"\r\nContent-Type: application/octet-stream\r\n\r\n\r\n--${boundary}--\r\n`;
    const emptyPartRes = await parseBoundedMultipart(
        new Request('http://127.0.0.1/upload', {
            method: 'POST',
            headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
            body: emptyFileMultipart
        }),
        { requireMagicMatch: false }
    );
    assert.equal(emptyPartRes.ok, false);
    assert.equal(emptyPartRes.error.code, 'UPLOAD_EMPTY');

    // REF10-04: Circular expando property on 2000-byte Uint8Array caught by inspectPayloadGraph,
    // and expando properties on >64KB TypedArray/Buffer stripped cleanly by cloneSafeValue
    const mediumU8 = new Uint8Array(2000);
    mediumU8.self = mediumU8;
    const cycTyped = validateSchema(s.any(), mediumU8);
    assert.equal(cycTyped.ok, false);
    assert.equal(cycTyped.error.code, 'SCHEMA_CIRCULAR_REF');

    const largeU8 = new Uint8Array(70_000);
    largeU8[0] = 42;
    largeU8.self = largeU8;
    const clonedLarge = validateSchema(s.any(), largeU8);
    assert.equal(clonedLarge.ok, true);
    assert.ok(clonedLarge.data instanceof Uint8Array);
    assert.notStrictEqual(clonedLarge.data, largeU8);
    assert.equal(clonedLarge.data.self, undefined);
    assert.equal(clonedLarge.data[0], 42);

    // REF10-04 & REF10-05: Passing null options never throws across schema, upload, cascade, or audio helpers
    const nullSchemaRes = validateSchema(s.object({ ok: s.boolean() }), { ok: true }, null);
    assert.equal(nullSchemaRes.ok, true);
    const mw = createSchemaMiddleware(s.object({ ok: s.boolean() }), null);
    assert.equal(typeof mw, 'function');

    assert.equal(sanitizeUploadFilename('report.pdf', null), 'report.pdf');
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
    assert.equal(verifyUploadMime(pngBytes, 'image/png', null).ok, true);

    const breaker = createTierCircuitBreaker(null);
    assert.equal(breaker.canAttempt('L1_FAST').allowed, true);

    const sel = selectCascadeTier(null);
    assert.equal(sel.ok, true);

    const probeFail = await probeBurstEndpoint('not-a-valid-url', null);
    assert.equal(probeFail.ok, false);
    assert.equal(probeFail.error.code, 'BURST_UNREACHABLE');

    const execOk = await executeWithCascadeFallback(
        [{ id: 'L1_FAST' }],
        async () => ({ ok: true, data: 'done' }),
        null
    );
    assert.equal(execOk.ok, true);

    const wavNullOpts = encodeWavPcm16(new Int16Array([0, 256]), null);
    assert.equal(parseWavHeader(wavNullOpts, null).ok, true);
    assert.equal((await transcribeWhisperAudio(null, null)).ok, false);
    assert.equal((await synthesizeSpeechAudio('', null)).ok, false);
});

test('Wave 4 Pass 11 Regressions: typeless JSON Schema NaN/Infinity, Zod safeParse Infinity/bool-coercion, and maxLength < 8 filename parity', async () => {
    const { z } = await import('zod');
    const { s, validateSchema } = await import('./schema.js');
    const { sanitizeUploadFilename } = await import('./upload.js');

    // REF11-01 (1): Typeless raw JSON Schema and s.any() reject NaN, Infinity, and -Infinity everywhere
    for (const rawSchema of [
        { minimum: 0 },
        { maximum: 10 },
        {},
        s.any()
    ]) {
        for (const badNum of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
            const topRes = validateSchema(rawSchema, badNum);
            assert.equal(topRes.ok, false);
            assert.equal(topRes.error.code, 'VALIDATION_ERROR');

            const nestedRes = validateSchema(rawSchema, { score: badNum });
            assert.equal(nestedRes.ok, false);
            assert.equal(nestedRes.error.code, 'VALIDATION_ERROR');
        }
    }

    // REF11-01 (2): Zod / { safeParse } rejects NaN, Infinity, and z.coerce.number() boolean coercion (true -> 1, false -> 0)
    const zodCoerceObj = z.object({ n: z.coerce.number() });
    assert.equal(validateSchema(zodCoerceObj, { n: '42' }).ok, true);
    assert.equal(validateSchema(zodCoerceObj, { n: '42' }).data.n, 42);

    const zodBoolTrue = validateSchema(zodCoerceObj, { n: true });
    assert.equal(zodBoolTrue.ok, false);
    assert.equal(zodBoolTrue.error.code, 'VALIDATION_ERROR');

    const zodBoolFalse = validateSchema(zodCoerceObj, { n: false });
    assert.equal(zodBoolFalse.ok, false);
    assert.equal(zodBoolFalse.error.code, 'VALIDATION_ERROR');

    const nestedZodInS = s.object({ inner: zodCoerceObj });
    assert.equal(validateSchema(nestedZodInS, { inner: { n: true } }).ok, false);

    if (typeof z.nan === 'function') {
        const zodNanRes = validateSchema(z.nan(), Number.NaN);
        assert.equal(zodNanRes.ok, false);
        assert.equal(zodNanRes.error.code, 'VALIDATION_ERROR');
    }

    const fakeZodInf = {
        safeParse: (val) => ({ success: true, data: val })
    };
    assert.equal(validateSchema(fakeZodInf, { n: Number.POSITIVE_INFINITY }).ok, false);
    assert.equal(validateSchema(fakeZodInf, { n: Number.NEGATIVE_INFINITY }).ok, false);

    const zodCoerceSet = z.object({ nums: z.preprocess((v) => new Set(Array.isArray(v) ? v.map(Number) : []), z.set(z.number())) });
    assert.equal(validateSchema(zodCoerceSet, { nums: ['3', 4] }).ok, true);
    assert.equal(validateSchema(zodCoerceSet, { nums: [true, 1] }).ok, false);

    // REF11-02: sanitizeUploadFilename honors explicit maxLength < 8 (matching Python upload.py 1:1)
    assert.equal(sanitizeUploadFilename('abcdefghij.txt', { maxLength: 5 }), 'a.txt');
    assert.equal(sanitizeUploadFilename('abcdefghij.txt', { maxLength: 5 }).length, 5);
    assert.equal(sanitizeUploadFilename('abcdefghij.txt', { maxLength: 3 }), 'abc');
    assert.equal(sanitizeUploadFilename('../../..', { maxLength: 3 }).length, 3);
    assert.equal(sanitizeUploadFilename('report.txt', { maxLength: 0 }), 'report.txt');
    assert.equal(sanitizeUploadFilename('report.txt', { maxLength: -5 }), 'report.txt');
});

test('Wave 4 Pass 14 Regressions: unwrapped s.* shapes and malformed raw JSON Schema keywords fail closed with INVALID_SCHEMA', async () => {
    const { z } = await import('zod');
    const { s, toJsonSchema, validateSchema } = await import('./schema.js');

    // REF14-01 (1): Unwrapped s.* / Zod shape objects (missing s.object(...)) must NOT silently validate as typeless JSON Schema
    const unwrappedShape = { id: s.string(), role: s.enum(['admin']) };
    const unwrappedRes = validateSchema(unwrappedShape, { id: 123, role: 'hacker' });
    assert.equal(unwrappedRes.ok, false);
    assert.equal(unwrappedRes.error.code, 'INVALID_SCHEMA');
    assert.throws(() => toJsonSchema(unwrappedShape), TypeError);
    assert.throws(() => s.array(unwrappedShape), TypeError);

    const unwrappedZodShape = { id: z.string() };
    const unwrappedZodRes = validateSchema(unwrappedZodShape, { id: 999 });
    assert.equal(unwrappedZodRes.ok, false);
    assert.equal(unwrappedZodRes.error.code, 'INVALID_SCHEMA');

    // REF14-01 (2): Raw JSON Schema containing uncompiled s.* or Zod nodes inside properties/items must fail closed
    const hybridPropsSchema = { type: 'object', properties: { id: s.string() } };
    const hybridPropsRes = validateSchema(hybridPropsSchema, { id: 123 });
    assert.equal(hybridPropsRes.ok, false);
    assert.equal(hybridPropsRes.error.code, 'INVALID_SCHEMA');
    assert.throws(() => toJsonSchema(hybridPropsSchema), TypeError);

    // REF14-01 (3): Malformed raw JSON Schema keywords (items, additionalProperties, enum, anyOf, oneOf, required, numeric/integer bounds)
    for (const malformedSchema of [
        { type: 'array', items: 'string' },
        { type: 'array', items: [s.string()] },
        { type: 'object', additionalProperties: 'false' },
        { type: 'object', required: 'id' },
        { type: 'object', required: [123] },
        { enum: 'admin' },
        { anyOf: 'string' },
        { anyOf: [] },
        { oneOf: 'number' },
        { oneOf: [] },
        { type: 'number', minimum: '10' },
        { type: 'number', maximum: Number.NaN },
        { type: 'string', minLength: -1 },
        { type: 'string', maxLength: '5' },
        { type: 'array', uniqueItems: 'true' },
        { type: 'string', format: 123 },
        { type: 'string', pattern: 123 },
    ]) {
        const res = validateSchema(malformedSchema, 'anything');
        assert.equal(res.ok, false);
        assert.equal(res.error.code, 'INVALID_SCHEMA');
        assert.throws(() => toJsonSchema(malformedSchema), TypeError);
    }
});
