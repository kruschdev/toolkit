import type { OkEnvelope, ErrorDetail, ErrorEnvelope, LegoEnvelope } from './envelopes.js';

export type { OkEnvelope, ErrorDetail, ErrorEnvelope, LegoEnvelope };

export interface EncodeWavPcm16Options {
    sampleRate?: number;
    channels?: 1 | 2 | number;
}

export interface WavHeaderData {
    audioFormat: number;
    channels: number;
    sampleRate: number;
    bitsPerSample: number;
    byteRate: number;
    blockAlign: number;
    dataOffset: number;
    dataBytes: number;
    durationSeconds: number;
}

export interface ParseWavHeaderOptions {
    tool?: string;
}

export type WhisperSegment = Record<string, unknown>;

export interface WhisperTranscriptionData {
    text: string;
    language: string | null;
    duration: number | null;
    segments: WhisperSegment[];
}

export interface TranscribeWhisperAudioOptions {
    endpointUrl?: string;
    filename?: string;
    mimeType?: string;
    model?: string;
    language?: string;
    prompt?: string;
    apiKey?: string;
    maxAudioBytes?: number;
    timeoutMs?: number;
    signal?: AbortSignal | null;
    fetchImpl?: typeof fetch;
    tool?: string;
}

export type TtsResponseFormat = 'wav' | 'mp3' | 'opus' | 'aac' | 'flac' | 'pcm';

export interface SynthesizeSpeechData {
    audioBytes: Uint8Array;
    mimeType: string;
    byteLength: number;
}

export interface SynthesizeSpeechAudioOptions {
    endpointUrl?: string;
    voice?: string;
    model?: string;
    responseFormat?: TtsResponseFormat | (string & {});
    speed?: number;
    apiKey?: string;
    maxTextChars?: number;
    maxResponseBytes?: number;
    timeoutMs?: number;
    signal?: AbortSignal | null;
    fetchImpl?: typeof fetch;
    tool?: string;
}

export function encodeWavPcm16(
    samples: Int16Array | Float32Array | number[],
    options?: EncodeWavPcm16Options
): Uint8Array;

export function parseWavHeader(
    wavBytes: Uint8Array | ArrayBuffer,
    options?: ParseWavHeaderOptions
): LegoEnvelope<WavHeaderData>;

export function transcribeWhisperAudio(
    audioBytes: Uint8Array | ArrayBuffer | Blob,
    options?: TranscribeWhisperAudioOptions
): Promise<LegoEnvelope<WhisperTranscriptionData>>;

export function synthesizeSpeechAudio(
    text: string,
    options?: SynthesizeSpeechAudioOptions
): Promise<LegoEnvelope<SynthesizeSpeechData>>;
