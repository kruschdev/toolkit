/**
 * @module audio
 * @description Isomorphic Web-Standards WAV/PCM16, Whisper STT, and OpenAI/Kokoro TTS audio bricks
 * (`INV-LEGO-01`, `INV-LEGO-20`). Zero host-specific built-in module imports; executes unmodified
 * across modern ECMAScript server runtimes, React/Vite browsers, and Cloudflare Workers.
 */

const MIN_WAV_SAMPLE_RATE = 8_000;
const MAX_WAV_SAMPLE_RATE = 96_000;
const WAV_HEADER_BYTES = 44;
const DEFAULT_MAX_AUDIO_BYTES = 26_214_400; // 25 MiB
const DEFAULT_AUDIO_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TTS_CHARS = 4_096;

const ALLOWED_TTS_FORMATS = Object.freeze({
    wav: 'audio/wav',
    mp3: 'audio/mpeg',
    opus: 'audio/opus',
    aac: 'audio/aac',
    flac: 'audio/flac',
    pcm: 'audio/pcm',
});

/**
 * Build a deterministic `INV-LEGO-01` success envelope without host-specific imports.
 *
 * @param {string} tool - Originating tool identifier
 * @param {string} summary - Concise human-readable summary
 * @param {object} [data={}] - Structured payload object
 * @returns {{ ok: true, tool: string, summary: string, data: object }}
 */
function okEnvelope(tool, summary, data = {}) {
    return {
        ok: true,
        tool: String(tool || 'audio'),
        summary: String(summary || 'OK'),
        data: data ?? {},
    };
}

/**
 * Build a deterministic `INV-LEGO-01` error envelope without host-specific imports.
 *
 * @param {string} code - Machine-readable error code
 * @param {string} message - Human-readable diagnostic message
 * @param {unknown} [details=null] - Optional structured diagnostic metadata
 * @param {string} [tool='audio'] - Originating tool identifier
 * @returns {{ ok: false, tool: string, summary: string, error: { code: string, message: string, details?: unknown } }}
 */
function errorEnvelope(code, message, details = null, tool = 'audio') {
    return {
        ok: false,
        tool: String(tool || 'audio'),
        summary: String(message || code || 'Audio operation failed'),
        error: {
            code: String(code || 'AUDIO_ERROR'),
            message: String(message || 'Audio operation failed'),
            ...(details !== null && details !== undefined ? { details } : {}),
        },
    };
}

/**
 * Concatenate collected `Uint8Array` chunks into a single contiguous `Uint8Array`.
 *
 * @param {Uint8Array[]} chunks - Collected byte chunks
 * @param {number} totalBytes - Total byte length across chunks
 * @returns {Uint8Array}
 */
function concatUint8Chunks(chunks, totalBytes) {
    if (totalBytes === 0 || chunks.length === 0) {
        return new Uint8Array(0);
    }
    if (chunks.length === 1) {
        const single = chunks[0];
        return single.byteOffset === 0 && single.byteLength === single.buffer.byteLength
            ? single
            : single.slice();
    }
    const out = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return out;
}

/**
 * Create a combined `AbortController` wired to an optional caller `AbortSignal` and bounded timeout,
 * guaranteeing timer and event-listener cleanup in `finally`.
 *
 * @param {AbortSignal|null|undefined} callerSignal - Optional external abort signal
 * @param {number} timeoutMs - Timeout in milliseconds (`<= 0` disables timer)
 * @returns {{ signal: AbortSignal, didTimeout: () => boolean, cleanup: () => void }}
 */
function createCombinedAbortScope(callerSignal, timeoutMs) {
    const controller = new AbortController();
    let timedOut = false;
    let timerId = null;

    const makeAbortReason = (message, name) => {
        if (typeof DOMException === 'function') {
            return new DOMException(message, name);
        }
        const err = new Error(message);
        err.name = name;
        return err;
    };

    const onCallerAbort = () => {
        controller.abort(callerSignal?.reason ?? makeAbortReason('Audio operation aborted', 'AbortError'));
    };

    if (callerSignal && typeof callerSignal.addEventListener === 'function') {
        if (callerSignal.aborted) {
            onCallerAbort();
        } else {
            callerSignal.addEventListener('abort', onCallerAbort, { once: true });
        }
    }

    const effectiveTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : 0;
    if (effectiveTimeout > 0 && !controller.signal.aborted) {
        timerId = setTimeout(() => {
            timedOut = true;
            controller.abort(makeAbortReason(`Audio request timed out after ${effectiveTimeout}ms`, 'TimeoutError'));
        }, effectiveTimeout);
    }

    const cleanup = () => {
        if (timerId !== null) {
            clearTimeout(timerId);
            timerId = null;
        }
        if (callerSignal && typeof callerSignal.removeEventListener === 'function') {
            try {
                callerSignal.removeEventListener('abort', onCallerAbort);
            } catch {
                // Ignore listener cleanup errors on non-standard signal shims
            }
        }
    };

    return {
        signal: controller.signal,
        didTimeout: () => timedOut,
        cleanup,
    };
}

/**
 * Sanitize a multipart filename for Web `FormData` upload headers.
 *
 * @param {unknown} rawFilename - Candidate filename
 * @returns {string}
 */
function sanitizeFormFilename(rawFilename) {
    const cleaned = String(rawFilename || 'audio.wav')
        .replace(/[\r\n"\\/]+/g, '_')
        .replace(/[\x00-\x1f\x7f]/g, '')
        .trim();
    return cleaned || 'audio.wav';
}

/**
 * Validate HTTP/HTTPS endpoint URL strings without throwing.
 *
 * @param {unknown} rawUrl - Candidate endpoint URL
 * @returns {URL|null}
 */
function parseHttpEndpoint(rawUrl) {
    if (typeof rawUrl !== 'string' || rawUrl.trim() === '' || /[\r\n]/.test(rawUrl)) {
        return null;
    }
    try {
        const parsed = new URL(rawUrl.trim());
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return null;
        }
        return parsed;
    } catch {
        return null;
    }
}

/**
 * Encode PCM16 integer or normalized float (`[-1, 1]`) audio samples into a canonical
 * 44-byte RIFF/WAVE little-endian `Uint8Array` (`INV-LEGO-20`).
 *
 * @param {Int16Array|Float32Array|number[]} samples - Mono or interleaved stereo audio samples
 * @param {object} [options={}] - Encoding options
 * @param {number} [options.sampleRate=16000] - Integer sample rate in Hz (`[8000, 96000]`)
 * @param {number} [options.channels=1] - Channel count (`1` mono or `2` stereo)
 * @returns {Uint8Array}
 */
export function encodeWavPcm16(samples, options = {}) {
    const safeOpts = options && typeof options === 'object' ? options : {};
    const { sampleRate = 16_000, channels = 1 } = safeOpts;
    const isInt16 = samples instanceof Int16Array;
    const isFloat32 = samples instanceof Float32Array;
    const isArray = Array.isArray(samples);
    if (!isInt16 && !isFloat32 && !isArray) {
        throw new TypeError('encodeWavPcm16 expects samples to be an Int16Array, Float32Array, or Array');
    }

    if (!Number.isInteger(sampleRate) || sampleRate < MIN_WAV_SAMPLE_RATE || sampleRate > MAX_WAV_SAMPLE_RATE) {
        throw new RangeError(
            `encodeWavPcm16 expects integer sampleRate in [${MIN_WAV_SAMPLE_RATE}, ${MAX_WAV_SAMPLE_RATE}]`
        );
    }

    if (!Number.isInteger(channels) || (channels !== 1 && channels !== 2)) {
        throw new RangeError('encodeWavPcm16 expects integer channels in [1, 2]');
    }

    if (samples.length % channels !== 0) {
        throw new RangeError(
            `encodeWavPcm16 interleaved sample count (${samples.length}) must be divisible by channels (${channels})`
        );
    }

    const dataByteLength = samples.length * 2;
    if (36 + dataByteLength > 0xffffffff) {
        throw new RangeError('WAV payload exceeds 32-bit RIFF container limit');
    }

    const out = new Uint8Array(WAV_HEADER_BYTES + dataByteLength);
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength);

    // 'RIFF' chunk descriptor
    out[0] = 0x52;
    out[1] = 0x49;
    out[2] = 0x46;
    out[3] = 0x46;
    view.setUint32(4, 36 + dataByteLength, true);

    // 'WAVE' format identifier
    out[8] = 0x57;
    out[9] = 0x41;
    out[10] = 0x56;
    out[11] = 0x45;

    // 'fmt ' subchunk (16-byte PCM)
    out[12] = 0x66;
    out[13] = 0x6d;
    out[14] = 0x74;
    out[15] = 0x20;
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM = 1
    view.setUint16(22, channels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * channels * 2, true); // byteRate
    view.setUint16(32, channels * 2, true); // blockAlign
    view.setUint16(34, 16, true); // bitsPerSample

    // 'data' subchunk
    out[36] = 0x64;
    out[37] = 0x61;
    out[38] = 0x74;
    out[39] = 0x61;
    view.setUint32(40, dataByteLength, true);

    if (isInt16) {
        for (let i = 0; i < samples.length; i += 1) {
            const clamped = Math.max(-32768, Math.min(32767, samples[i]));
            view.setInt16(WAV_HEADER_BYTES + i * 2, clamped, true);
        }
    } else {
        for (let i = 0; i < samples.length; i += 1) {
            const raw = Number(samples[i]);
            const s = Number.isNaN(raw) ? 0 : Math.max(-1, Math.min(1, raw));
            const pcm = s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
            view.setInt16(WAV_HEADER_BYTES + i * 2, pcm, true);
        }
    }

    return out;
}

/**
 * Bounds-checked RIFF/WAVE header parser tolerant of intermediate `JUNK`/`LIST` metadata chunks
 * (`INV-LEGO-01`, `INV-LEGO-20`). Never throws on malformed or truncated inputs.
 *
 * @param {Uint8Array|ArrayBuffer} wavBytes - Raw WAV file bytes
 * @param {object} [options={}] - Parser options
 * @param {string} [options.tool='audio.wav'] - Originating tool identifier
 * @returns {{ ok: true, tool: string, summary: string, data: { audioFormat: number, channels: number, sampleRate: number, bitsPerSample: number, byteRate: number, blockAlign: number, dataOffset: number, dataBytes: number, durationSeconds: number } } | { ok: false, tool: string, summary: string, error: { code: string, message: string, details?: unknown } }}
 */
export function parseWavHeader(wavBytes, options = {}) {
    const resolvedOptions = options && typeof options === 'object' ? options : {};
    const tool = String(resolvedOptions.tool || 'audio.wav');

    try {
        let bytes;
        if (wavBytes instanceof Uint8Array) {
            bytes = wavBytes;
        } else if (wavBytes instanceof ArrayBuffer) {
            bytes = new Uint8Array(wavBytes);
        } else {
            return errorEnvelope(
                'WAV_INVALID_HEADER',
                'WAV input must be a Uint8Array or ArrayBuffer',
                null,
                tool
            );
        }

        if (bytes.byteLength < WAV_HEADER_BYTES) {
            return errorEnvelope(
                'WAV_INVALID_HEADER',
                `WAV buffer too short (${bytes.byteLength} bytes; minimum ${WAV_HEADER_BYTES})`,
                { byteLength: bytes.byteLength },
                tool
            );
        }

        const isRiff =
            bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46;
        const isWave =
            bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 && bytes[11] === 0x45;
        if (!isRiff || !isWave) {
            return errorEnvelope('WAV_INVALID_HEADER', 'Missing RIFF/WAVE header signature', null, tool);
        }

        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        let offset = 12;
        let fmtChunk = null;
        let dataChunk = null;

        while (offset + 8 <= bytes.byteLength) {
            const chunkId = String.fromCharCode(
                bytes[offset],
                bytes[offset + 1],
                bytes[offset + 2],
                bytes[offset + 3]
            );
            const chunkSize = view.getUint32(offset + 4, true);
            const bodyOffset = offset + 8;

            if (chunkId === 'fmt ') {
                if (chunkSize < 16 || bodyOffset + 16 > bytes.byteLength || bodyOffset + chunkSize > bytes.byteLength) {
                    return errorEnvelope(
                        'WAV_INVALID_HEADER',
                        'Truncated or invalid fmt subchunk in WAV header',
                        { chunkSize, offset },
                        tool
                    );
                }
                const audioFormat = view.getUint16(bodyOffset, true);
                const channels = view.getUint16(bodyOffset + 2, true);
                const sampleRate = view.getUint32(bodyOffset + 4, true);
                const byteRate = view.getUint32(bodyOffset + 8, true);
                const blockAlign = view.getUint16(bodyOffset + 12, true);
                const bitsPerSample = view.getUint16(bodyOffset + 14, true);

                if (
                    channels < 1 ||
                    sampleRate < 1 ||
                    bitsPerSample < 8 ||
                    byteRate <= 0 ||
                    blockAlign < 1
                ) {
                    return errorEnvelope(
                        'WAV_INVALID_HEADER',
                        'Invalid WAV fmt subchunk audio parameters',
                        { audioFormat, channels, sampleRate, bitsPerSample, byteRate, blockAlign },
                        tool
                    );
                }
                fmtChunk = { audioFormat, channels, sampleRate, bitsPerSample, byteRate, blockAlign };
            } else if (chunkId === 'data') {
                const dataOffset = bodyOffset;
                const dataBytes = Math.max(0, Math.min(chunkSize, bytes.byteLength - dataOffset));
                dataChunk = { dataOffset, dataBytes };
                if (fmtChunk !== null) {
                    break;
                }
            } else if (bodyOffset + chunkSize > bytes.byteLength) {
                // Non-data intermediate subchunk extends beyond buffer bounds
                break;
            }

            if (fmtChunk !== null && dataChunk !== null) {
                break;
            }

            const padByte = chunkSize % 2;
            const nextOffset = bodyOffset + chunkSize + padByte;
            if (!Number.isSafeInteger(nextOffset) || nextOffset <= offset) {
                break;
            }
            offset = nextOffset;
        }

        if (!fmtChunk || !dataChunk) {
            return errorEnvelope(
                'WAV_INVALID_HEADER',
                'WAV container missing required fmt or data subchunk',
                { hasFmt: Boolean(fmtChunk), hasData: Boolean(dataChunk) },
                tool
            );
        }

        const bytesPerFrame = fmtChunk.channels * (fmtChunk.bitsPerSample / 8);
        const durationSeconds =
            bytesPerFrame > 0
                ? Number((dataChunk.dataBytes / (fmtChunk.sampleRate * bytesPerFrame)).toFixed(6))
                : 0;

        return okEnvelope(tool, 'WAV header parsed', {
            audioFormat: fmtChunk.audioFormat,
            channels: fmtChunk.channels,
            sampleRate: fmtChunk.sampleRate,
            bitsPerSample: fmtChunk.bitsPerSample,
            byteRate: fmtChunk.byteRate,
            blockAlign: fmtChunk.blockAlign,
            dataOffset: dataChunk.dataOffset,
            dataBytes: dataChunk.dataBytes,
            durationSeconds,
        });
    } catch (err) {
        return errorEnvelope(
            'WAV_INVALID_HEADER',
            err instanceof Error ? err.message : 'Failed to parse WAV header',
            null,
            tool
        );
    }
}

/**
 * Send bounded multipart audio to a Whisper-compatible `/v1/audio/transcriptions` endpoint
 * (`INV-LEGO-01`, `INV-LEGO-20`). Never throws on invalid inputs, timeouts, or upstream failures.
 *
 * @param {Uint8Array|ArrayBuffer|Blob} audioBytes - Audio payload bytes or Blob
 * @param {object} [options={}] - Transcription options
 * @param {string} [options.endpointUrl='http://127.0.0.1:9000/v1/audio/transcriptions'] - STT endpoint URL
 * @param {string} [options.filename='audio.wav'] - Multipart upload filename
 * @param {string} [options.mimeType='audio/wav'] - Declared audio MIME type
 * @param {string} [options.model='whisper-1'] - Model identifier
 * @param {string} [options.language=''] - Optional ISO-639-1 language hint
 * @param {string} [options.prompt=''] - Optional decoding prompt hint
 * @param {string} [options.apiKey=''] - Optional Bearer API key
 * @param {number} [options.maxAudioBytes=26214400] - Maximum allowed upload bytes (default 25 MiB)
 * @param {number} [options.timeoutMs=30000] - Request timeout in milliseconds
 * @param {AbortSignal|null} [options.signal=null] - Optional caller `AbortSignal`
 * @param {typeof fetch} [options.fetchImpl=globalThis.fetch] - Web `fetch` implementation
 * @param {string} [options.tool='audio.stt'] - Originating tool identifier
 * @returns {Promise<{ ok: true, tool: string, summary: string, data: { text: string, language: string | null, duration: number | null, segments: unknown[] } } | { ok: false, tool: string, summary: string, error: { code: string, message: string, details?: unknown } }>}
 */
export async function transcribeWhisperAudio(audioBytes, options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    const {
        endpointUrl = 'http://127.0.0.1:9000/v1/audio/transcriptions',
        filename = 'audio.wav',
        mimeType = 'audio/wav',
        model = 'whisper-1',
        language = '',
        prompt = '',
        apiKey = '',
        maxAudioBytes = DEFAULT_MAX_AUDIO_BYTES,
        timeoutMs = DEFAULT_AUDIO_TIMEOUT_MS,
        signal = null,
        fetchImpl = globalThis.fetch,
        tool: rawTool = 'audio.stt',
    } = opts;
    const tool = String(rawTool || 'audio.stt');

    const cleanMime = String(mimeType || 'audio/wav')
        .split(';')[0]
        .trim()
        .toLowerCase();
    if (!/^audio\/[a-z0-9.+-]+$/.test(cleanMime) && cleanMime !== 'video/webm') {
        return errorEnvelope(
            'AUDIO_UNSUPPORTED_MIME',
            `Unsupported audio MIME type: ${cleanMime || '(empty)'}`,
            { mimeType: cleanMime },
            tool
        );
    }

    const capBytes =
        Number.isFinite(maxAudioBytes) && maxAudioBytes > 0
            ? Math.floor(maxAudioBytes)
            : DEFAULT_MAX_AUDIO_BYTES;

    let byteLength = -1;
    let uploadBlob = null;
    if (audioBytes instanceof Uint8Array) {
        byteLength = audioBytes.byteLength;
        if (byteLength > 0 && byteLength <= capBytes) {
            const safeSlice =
                audioBytes.buffer instanceof ArrayBuffer
                    ? new Uint8Array(audioBytes.buffer, audioBytes.byteOffset, audioBytes.byteLength)
                    : new Uint8Array(audioBytes);
            uploadBlob = new Blob([safeSlice], { type: cleanMime });
        }
    } else if (audioBytes instanceof ArrayBuffer) {
        byteLength = audioBytes.byteLength;
        if (byteLength > 0 && byteLength <= capBytes) {
            uploadBlob = new Blob([audioBytes], { type: cleanMime });
        }
    } else if (typeof Blob !== 'undefined' && audioBytes instanceof Blob) {
        byteLength = audioBytes.size;
        if (byteLength > 0 && byteLength <= capBytes) {
            uploadBlob =
                audioBytes.type === cleanMime ? audioBytes : new Blob([audioBytes], { type: cleanMime });
        }
    } else {
        return errorEnvelope(
            'AUDIO_INVALID_INPUT',
            'audioBytes must be a Uint8Array, ArrayBuffer, or Blob',
            null,
            tool
        );
    }

    if (byteLength === 0) {
        return errorEnvelope('AUDIO_EMPTY', 'Audio input cannot be empty (0 bytes)', { byteLength: 0 }, tool);
    }

    if (byteLength > capBytes) {
        return errorEnvelope(
            'AUDIO_TOO_LARGE',
            `Audio payload (${byteLength} bytes) exceeds maximum (${capBytes} bytes)`,
            { byteLength, maxAudioBytes: capBytes },
            tool
        );
    }

    const parsedEndpoint = parseHttpEndpoint(endpointUrl);
    if (!parsedEndpoint) {
        return errorEnvelope(
            'AUDIO_INVALID_ENDPOINT',
            'Transcription endpointUrl must be a valid http: or https: URL',
            { endpointUrl },
            tool
        );
    }

    if (typeof fetchImpl !== 'function') {
        return errorEnvelope('AUDIO_FETCH_UNAVAILABLE', 'No fetch implementation available', null, tool);
    }

    if (signal?.aborted) {
        return errorEnvelope('AUDIO_ABORTED', 'Audio transcription aborted by caller signal', null, tool);
    }

    const form = new FormData();
    form.append('file', uploadBlob, sanitizeFormFilename(filename));
    form.append('model', String(model || 'whisper-1'));
    if (language && String(language).trim() !== '') {
        form.append('language', String(language).trim());
    }
    if (prompt && String(prompt).trim() !== '') {
        form.append('prompt', String(prompt).trim());
    }

    const headers = { Accept: 'application/json' };
    if (typeof apiKey === 'string' && apiKey.trim().length > 0 && !/[\r\n]/.test(apiKey)) {
        headers.Authorization = `Bearer ${apiKey.trim()}`;
    }

    const scope = createCombinedAbortScope(signal, timeoutMs);
    try {
        const res = await fetchImpl(parsedEndpoint.toString(), {
            method: 'POST',
            headers,
            body: form,
            signal: scope.signal,
        });

        if (!res || typeof res.ok !== 'boolean') {
            return errorEnvelope('AUDIO_UPSTREAM_ERROR', 'Invalid response from transcription upstream', null, tool);
        }

        if (!res.ok) {
            let errorPreview = '';
            try {
                errorPreview = (await res.text()).slice(0, 512);
            } catch {
                errorPreview = '';
            }
            return errorEnvelope(
                'AUDIO_UPSTREAM_ERROR',
                `Transcription upstream failed with HTTP ${res.status}`,
                { status: res.status, ...(errorPreview ? { body: errorPreview } : {}) },
                tool
            );
        }

        const rawBody = await res.text();
        const trimmedBody = String(rawBody || '').trim();
        const contentType = String(res.headers?.get?.('content-type') || '').toLowerCase();
        const lowerPreview = trimmedBody.slice(0, 64).toLowerCase();

        if (
            contentType.includes('text/html') ||
            contentType.includes('application/xhtml+xml') ||
            lowerPreview.startsWith('<!doctype html') ||
            lowerPreview.startsWith('<html')
        ) {
            return errorEnvelope(
                'AUDIO_UPSTREAM_ERROR',
                'Unexpected HTML response from transcription upstream',
                { status: res.status, body: trimmedBody.slice(0, 256) },
                tool
            );
        }

        const declaresJson =
            contentType.includes('application/json') || contentType.includes('+json');
        let parsed = null;
        if (declaresJson || trimmedBody.startsWith('{')) {
            try {
                parsed = JSON.parse(rawBody);
            } catch {
                if (declaresJson) {
                    return errorEnvelope(
                        'AUDIO_UPSTREAM_ERROR',
                        'Invalid JSON payload from transcription upstream',
                        { status: res.status, body: trimmedBody.slice(0, 256) },
                        tool
                    );
                }
                parsed = null;
            }
            if (declaresJson && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))) {
                return errorEnvelope(
                    'AUDIO_UPSTREAM_ERROR',
                    'Expected JSON object payload from transcription upstream',
                    { status: res.status },
                    tool
                );
            }
        }

        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            if (typeof parsed.text !== 'string') {
                return errorEnvelope(
                    'AUDIO_UPSTREAM_ERROR',
                    'Missing or invalid text string in transcription JSON payload',
                    { status: res.status },
                    tool
                );
            }
            const textOut = parsed.text.trim();
            const languageOut =
                typeof parsed.language === 'string' && parsed.language.trim() !== ''
                    ? parsed.language.trim()
                    : null;
            const durationCandidate =
                typeof parsed.duration === 'number'
                    ? parsed.duration
                    : typeof parsed.duration === 'string' && parsed.duration.trim() !== ''
                      ? Number(parsed.duration)
                      : NaN;
            const durationOut = Number.isFinite(durationCandidate) ? durationCandidate : null;
            const segmentsOut = Array.isArray(parsed.segments) ? parsed.segments : [];

            return okEnvelope(tool, 'Audio transcription complete', {
                text: textOut,
                language: languageOut,
                duration: durationOut,
                segments: segmentsOut,
            });
        }

        return okEnvelope(tool, 'Audio transcription complete', {
            text: trimmedBody,
            language: null,
            duration: null,
            segments: [],
        });
    } catch (err) {
        if (scope.didTimeout()) {
            return errorEnvelope(
                'AUDIO_TIMEOUT',
                `Audio transcription timed out after ${timeoutMs}ms`,
                null,
                tool
            );
        }
        if (signal?.aborted || scope.signal.aborted) {
            return errorEnvelope('AUDIO_ABORTED', 'Audio transcription aborted', null, tool);
        }
        return errorEnvelope(
            'AUDIO_UPSTREAM_ERROR',
            err instanceof Error ? err.message : 'Audio transcription request failed',
            null,
            tool
        );
    } finally {
        scope.cleanup();
    }
}

/**
 * Synthesize speech audio via an OpenAI/Kokoro-compatible `/v1/audio/speech` endpoint with
 * streamed `maxResponseBytes` enforcement (`INV-LEGO-01`, `INV-LEGO-20`). Never throws.
 *
 * @param {string} text - Input text to synthesize
 * @param {object} [options={}] - Speech synthesis options
 * @param {string} [options.endpointUrl='http://127.0.0.1:8880/v1/audio/speech'] - TTS endpoint URL
 * @param {string} [options.voice='af_heart'] - Voice identifier
 * @param {string} [options.model='tts-1'] - TTS model identifier
 * @param {'wav'|'mp3'|'opus'|'aac'|'flac'|'pcm'|string} [options.responseFormat='wav'] - Output audio format
 * @param {number} [options.speed=1.0] - Playback speed clamped to `[0.25, 4.0]`
 * @param {string} [options.apiKey=''] - Optional Bearer API key
 * @param {number} [options.maxTextChars=4096] - Maximum allowed input character length
 * @param {number} [options.maxResponseBytes=26214400] - Maximum allowed response audio bytes (default 25 MiB)
 * @param {number} [options.timeoutMs=30000] - Request timeout in milliseconds
 * @param {AbortSignal|null} [options.signal=null] - Optional caller `AbortSignal`
 * @param {typeof fetch} [options.fetchImpl=globalThis.fetch] - Web `fetch` implementation
 * @param {string} [options.tool='audio.tts'] - Originating tool identifier
 * @returns {Promise<{ ok: true, tool: string, summary: string, data: { audioBytes: Uint8Array, mimeType: string, byteLength: number } } | { ok: false, tool: string, summary: string, error: { code: string, message: string, details?: unknown } }>}
 */
export async function synthesizeSpeechAudio(text, options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    const {
        endpointUrl = 'http://127.0.0.1:8880/v1/audio/speech',
        voice = 'af_heart',
        model = 'tts-1',
        responseFormat = 'wav',
        speed = 1.0,
        apiKey = '',
        maxTextChars = DEFAULT_MAX_TTS_CHARS,
        maxResponseBytes = DEFAULT_MAX_AUDIO_BYTES,
        timeoutMs = DEFAULT_AUDIO_TIMEOUT_MS,
        signal = null,
        fetchImpl = globalThis.fetch,
        tool: rawTool = 'audio.tts',
    } = opts;
    const tool = String(rawTool || 'audio.tts');

    if (
        text === null ||
        text === undefined ||
        typeof text === 'object' ||
        typeof text === 'function' ||
        typeof text === 'symbol'
    ) {
        return errorEnvelope('AUDIO_EMPTY_TEXT', 'Speech synthesis text must be a non-empty string', null, tool);
    }

    const rawText = String(text ?? '');
    if (rawText.trim().length === 0) {
        return errorEnvelope('AUDIO_EMPTY_TEXT', 'Speech synthesis text cannot be empty', null, tool);
    }

    const capChars =
        Number.isFinite(maxTextChars) && maxTextChars > 0 ? Math.floor(maxTextChars) : DEFAULT_MAX_TTS_CHARS;
    if (rawText.length > capChars) {
        return errorEnvelope(
            'AUDIO_TEXT_TOO_LONG',
            `Speech synthesis text length (${rawText.length}) exceeds maximum (${capChars})`,
            { length: rawText.length, maxTextChars: capChars },
            tool
        );
    }

    const fmt = String(responseFormat || 'wav').trim().toLowerCase();
    if (!Object.hasOwn(ALLOWED_TTS_FORMATS, fmt)) {
        return errorEnvelope(
            'AUDIO_UNSUPPORTED_FORMAT',
            `Unsupported TTS response format: ${fmt || '(empty)'}`,
            { responseFormat: fmt },
            tool
        );
    }

    const safeSpeed = Math.min(4.0, Math.max(0.25, Number.isFinite(speed) ? Number(speed) : 1.0));

    const parsedEndpoint = parseHttpEndpoint(endpointUrl);
    if (!parsedEndpoint) {
        return errorEnvelope(
            'AUDIO_INVALID_ENDPOINT',
            'Speech synthesis endpointUrl must be a valid http: or https: URL',
            { endpointUrl },
            tool
        );
    }

    if (typeof fetchImpl !== 'function') {
        return errorEnvelope('AUDIO_FETCH_UNAVAILABLE', 'No fetch implementation available', null, tool);
    }

    if (signal?.aborted) {
        return errorEnvelope('AUDIO_ABORTED', 'Speech synthesis aborted by caller signal', null, tool);
    }

    const headers = { 'Content-Type': 'application/json' };
    if (typeof apiKey === 'string' && apiKey.trim().length > 0 && !/[\r\n]/.test(apiKey)) {
        headers.Authorization = `Bearer ${apiKey.trim()}`;
    }

    const capBytes =
        Number.isFinite(maxResponseBytes) && maxResponseBytes > 0
            ? Math.floor(maxResponseBytes)
            : DEFAULT_MAX_AUDIO_BYTES;

    const scope = createCombinedAbortScope(signal, timeoutMs);
    try {
        const res = await fetchImpl(parsedEndpoint.toString(), {
            method: 'POST',
            headers,
            body: JSON.stringify({
                model: String(model || 'tts-1'),
                input: rawText,
                voice: String(voice || 'af_heart'),
                response_format: fmt,
                speed: safeSpeed,
            }),
            signal: scope.signal,
        });

        if (!res || typeof res.ok !== 'boolean') {
            return errorEnvelope('AUDIO_UPSTREAM_ERROR', 'Invalid response from TTS upstream', null, tool);
        }

        if (!res.ok) {
            let errorPreview = '';
            try {
                errorPreview = (await res.text()).slice(0, 512);
            } catch {
                errorPreview = '';
            }
            return errorEnvelope(
                'AUDIO_UPSTREAM_ERROR',
                `Speech synthesis upstream failed with HTTP ${res.status}`,
                { status: res.status, ...(errorPreview ? { body: errorPreview } : {}) },
                tool
            );
        }

        const rawRespMime = String(res.headers?.get?.('content-type') || '')
            .split(';')[0]
            .trim()
            .toLowerCase();
        if (
            rawRespMime &&
            (rawRespMime.startsWith('text/') ||
                rawRespMime.includes('json') ||
                rawRespMime.includes('html') ||
                rawRespMime.includes('xml'))
        ) {
            try {
                await res.body?.cancel?.();
            } catch {
                // Ignore cancellation errors on non-audio upstream response
            }
            return errorEnvelope(
                'AUDIO_UPSTREAM_ERROR',
                `Unexpected non-audio Content-Type "${rawRespMime}" from TTS upstream`,
                { status: res.status, contentType: rawRespMime },
                tool
            );
        }

        const rawContentLength = res.headers?.get?.('content-length');
        if (rawContentLength !== null && rawContentLength !== undefined && String(rawContentLength).trim() !== '') {
            const declaredBytes = Number(rawContentLength);
            if (Number.isFinite(declaredBytes) && declaredBytes > capBytes) {
                try {
                    await res.body?.cancel?.();
                } catch {
                    // Ignore cancellation errors on oversized upstream stream
                }
                return errorEnvelope(
                    'AUDIO_RESPONSE_TOO_LARGE',
                    `Synthesized audio Content-Length (${declaredBytes} bytes) exceeds maximum (${capBytes} bytes)`,
                    { contentLength: declaredBytes, maxResponseBytes: capBytes },
                    tool
                );
            }
        }

        const chunks = [];
        let totalBytes = 0;

        if (res.body && typeof res.body.getReader === 'function') {
            const reader = res.body.getReader();
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    if (value === undefined || value === null) continue;

                    const chunk =
                        value instanceof Uint8Array
                            ? value
                            : ArrayBuffer.isView(value)
                              ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
                              : value instanceof ArrayBuffer
                                ? new Uint8Array(value)
                                : new Uint8Array(0);

                    totalBytes += chunk.byteLength;
                    if (totalBytes > capBytes) {
                        chunks.length = 0;
                        try {
                            await reader.cancel();
                        } catch {
                            // Ignore reader cancel errors
                        }
                        return errorEnvelope(
                            'AUDIO_RESPONSE_TOO_LARGE',
                            `Synthesized audio stream exceeded maximum (${capBytes} bytes)`,
                            { readBytes: totalBytes, maxResponseBytes: capBytes },
                            tool
                        );
                    }
                    if (chunk.byteLength > 0) {
                        chunks.push(chunk);
                    }
                }
            } finally {
                try {
                    reader.releaseLock?.();
                } catch {
                    // Lock may already be released after cancel
                }
            }
        } else if (typeof res.arrayBuffer === 'function') {
            const buf = await res.arrayBuffer();
            const arr = new Uint8Array(buf);
            if (arr.byteLength > capBytes) {
                return errorEnvelope(
                    'AUDIO_RESPONSE_TOO_LARGE',
                    `Synthesized audio payload (${arr.byteLength} bytes) exceeds maximum (${capBytes} bytes)`,
                    { byteLength: arr.byteLength, maxResponseBytes: capBytes },
                    tool
                );
            }
            totalBytes = arr.byteLength;
            if (totalBytes > 0) {
                chunks.push(arr);
            }
        }

        const outBytes = concatUint8Chunks(chunks, totalBytes);
        if (outBytes.byteLength === 0) {
            return errorEnvelope(
                'AUDIO_UPSTREAM_ERROR',
                'TTS upstream returned an empty 0-byte audio body',
                { status: res.status },
                tool
            );
        }

        const respMime =
            rawRespMime && rawRespMime !== 'application/octet-stream'
                ? rawRespMime
                : ALLOWED_TTS_FORMATS[fmt];

        return okEnvelope(tool, 'Speech audio synthesized', {
            audioBytes: outBytes,
            mimeType: respMime,
            byteLength: outBytes.byteLength,
        });
    } catch (err) {
        if (scope.didTimeout()) {
            return errorEnvelope(
                'AUDIO_TIMEOUT',
                `Speech synthesis timed out after ${timeoutMs}ms`,
                null,
                tool
            );
        }
        if (signal?.aborted || scope.signal.aborted) {
            return errorEnvelope('AUDIO_ABORTED', 'Speech synthesis aborted', null, tool);
        }
        return errorEnvelope(
            'AUDIO_UPSTREAM_ERROR',
            err instanceof Error ? err.message : 'Speech synthesis request failed',
            null,
            tool
        );
    } finally {
        scope.cleanup();
    }
}
