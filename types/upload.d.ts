import type { IncomingMessage } from 'node:http';
import type { Readable } from 'node:stream';
import type { ErrorDetail, ErrorEnvelope, LegoEnvelope, OkEnvelope } from './envelopes.js';

export type { ErrorDetail, ErrorEnvelope, LegoEnvelope, OkEnvelope };

export type SniffedMimeType =
    | 'application/pdf'
    | 'image/png'
    | 'image/jpeg'
    | 'image/gif'
    | 'image/webp'
    | 'audio/wav'
    | 'audio/mpeg'
    | 'audio/ogg'
    | 'video/webm'
    | 'application/zip';

export interface SanitizeFilenameOptions {
    fallback?: string;
    maxLength?: number;
}

export interface VerifyUploadMimeOptions {
    allowedMimeTypes?: Iterable<string> | readonly string[] | ReadonlySet<string> | null;
    requireMagicMatch?: boolean;
    tool?: string;
}

export interface VerifiedUploadMimeData {
    mimeType: string;
    declaredMime: string | null;
    detectedMime: SniffedMimeType | null;
}

export interface UploadErrorDetails {
    declaredMime?: string | null;
    detectedMime?: SniffedMimeType | null;
    mimeType?: string;
    maxTotalBytes?: number;
    receivedBytes?: number;
    maxFiles?: number;
    maxFileBytes?: number;
    maxFields?: number;
    maxFieldBytes?: number;
    fieldName?: string;
    size?: number;
    [key: string]: unknown;
}

export interface ParsedUploadFile {
    fieldName: string;
    filename: string;
    originalFilename: string;
    mimeType: string;
    detectedMime: SniffedMimeType | null;
    size: number;
    data: Uint8Array;
}

export interface ParsedMultipartData {
    fields: Record<string, string | string[]>;
    files: ParsedUploadFile[];
    totalBytes: number;
}

export interface MultipartBufferInput {
    body: Uint8Array | Buffer | ArrayBuffer | string;
    contentType?: string;
    headers?: Headers | Record<string, string | string[] | undefined>;
}

export type MultipartInput =
    | Request
    | IncomingMessage
    | Readable
    | MultipartBufferInput
    | Uint8Array
    | Buffer
    | ArrayBuffer;

export interface ParseBoundedMultipartOptions {
    contentType?: string;
    maxTotalBytes?: number;
    maxFileBytes?: number;
    maxFiles?: number;
    maxFields?: number;
    maxFieldBytes?: number;
    allowedMimeTypes?: Iterable<string> | readonly string[] | ReadonlySet<string> | null;
    requireMagicMatch?: boolean;
    tool?: string;
}

export declare function sanitizeUploadFilename(
    rawFilename?: string,
    options?: SanitizeFilenameOptions
): string;

export declare function sniffMimeMagic(
    bytes: Uint8Array | Buffer | ArrayBuffer | null | undefined
): SniffedMimeType | null;

export declare function verifyUploadMime(
    bytes: Uint8Array | Buffer | ArrayBuffer | null | undefined,
    declaredMime?: string,
    options?: VerifyUploadMimeOptions
): LegoEnvelope<VerifiedUploadMimeData, UploadErrorDetails>;

export declare function parseBoundedMultipart(
    input: MultipartInput,
    options?: ParseBoundedMultipartOptions
): Promise<LegoEnvelope<ParsedMultipartData, UploadErrorDetails>>;
