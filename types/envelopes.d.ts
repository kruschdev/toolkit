/**
 * Universal `INV-LEGO-01` Envelope Contracts for `@krusch/toolkit`.
 * Web-standards & headless safe (zero `node:*` imports).
 */

export interface OkEnvelope<TData = Record<string, unknown>> {
    ok: true;
    tool: string;
    summary: string;
    data: TData;
}

export interface ErrorDetail<TDetails = unknown> {
    code: string;
    message: string;
    details?: TDetails;
}

export interface ErrorEnvelope<TDetails = unknown> {
    ok: false;
    tool: string;
    summary: string;
    error: ErrorDetail<TDetails>;
}

export type LegoEnvelope<TData = Record<string, unknown>, TDetails = unknown> =
    | OkEnvelope<TData>
    | ErrorEnvelope<TDetails>;
