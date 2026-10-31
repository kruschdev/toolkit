import type { OkEnvelope, ErrorDetail, ErrorEnvelope, LegoEnvelope } from './envelopes.js';

export type { OkEnvelope, ErrorDetail, ErrorEnvelope, LegoEnvelope };

export type WebhookRawBytes = string | Buffer | Uint8Array;

export interface SignWebhookHmacOptions {
    algorithm?: string;
    prefix?: string;
}

export interface VerifySlackSignatureOptions {
    rawBody: WebhookRawBytes;
    timestampHeader: string | number;
    signatureHeader: string;
    signingSecret: string;
    toleranceSeconds?: number;
    nowSeconds?: number;
}

export interface SlackVerifiedData {
    verified: true;
    provider: 'slack';
    timestamp: number;
}

export interface VerifyGithubSignatureOptions {
    rawBody: WebhookRawBytes;
    signatureHeader: string;
    webhookSecret: string;
}

export interface GithubVerifiedData {
    verified: true;
    provider: 'github';
}

export interface VerifyStripeSignatureOptions {
    rawBody: WebhookRawBytes;
    signatureHeader: string;
    endpointSecret: string;
    toleranceSeconds?: number;
    nowSeconds?: number;
}

export interface StripeVerifiedData {
    verified: true;
    provider: 'stripe';
    timestamp: number;
}

export interface VerifyBearerTokenOptions {
    tool?: string;
}

export interface BearerVerifiedData {
    verified: true;
    provider: 'bearer';
}

export declare function constantTimeEqual(a: WebhookRawBytes, b: WebhookRawBytes): boolean;

export declare function signWebhookHmac(
    rawBody: WebhookRawBytes,
    secret: string,
    options?: SignWebhookHmacOptions
): string;

export declare function verifySlackSignature(
    options?: VerifySlackSignatureOptions
): LegoEnvelope<SlackVerifiedData>;

export declare function verifyGithubSignature(
    options?: VerifyGithubSignatureOptions
): LegoEnvelope<GithubVerifiedData>;

export declare function verifyStripeSignature(
    options?: VerifyStripeSignatureOptions
): LegoEnvelope<StripeVerifiedData>;

export declare function verifyBearerToken(
    authHeader: string,
    expectedSecret: string,
    options?: VerifyBearerTokenOptions
): LegoEnvelope<BearerVerifiedData>;
