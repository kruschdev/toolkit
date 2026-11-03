import type { ErrorDetail, ErrorEnvelope, LegoEnvelope, OkEnvelope } from './envelopes.js';
import type { NodeSqliteDatabaseLike } from './sqlite.js';

export type { ErrorDetail, ErrorEnvelope, LegoEnvelope, OkEnvelope };

export type AuditOutcome = 'SUCCESS' | 'DENIED' | 'FAILURE' | 'ERROR' | (string & {});

export interface AuditEntryInput {
    seq: number;
    timestamp: string;
    actor: string;
    action: string;
    resource?: string;
    tenantId?: string;
    outcome?: AuditOutcome;
    prevHash: string;
    metadata?: Readonly<Record<string, unknown>>;
}

export interface AuditAppendRecord {
    actor: string;
    action: string;
    resource?: string;
    tenantId?: string;
    outcome?: AuditOutcome;
    timestamp?: string;
    metadata?: Readonly<Record<string, unknown>>;
}

export interface AuditEntry {
    readonly seq: number;
    readonly timestamp: string;
    readonly tenantId: string;
    readonly actor: string;
    readonly action: string;
    readonly resource: string;
    readonly outcome: string;
    readonly metadata: Readonly<Record<string, unknown>>;
    readonly prevHash: string;
    readonly entryHash: string;
}

export interface CanonicalizeAuditPayloadOptions {
    maxDepth?: number;
    tool?: string;
}

export interface CanonicalizeAuditPayloadData {
    canonicalJson: string;
}

export interface ComputeAuditEntryHashOptions {
    hmacSecret?: string;
    tool?: string;
}

export interface ComputeAuditEntryHashData {
    entryHash: string;
    canonicalJson: string;
}

export interface VerifyAuditChainOptions {
    expectedGenesisHash?: string;
    expectedTailHash?: string;
    hmacSecret?: string;
    startSeq?: number;
    tool?: string;
}

export interface VerifyAuditChainData {
    valid: true;
    verifiedCount: number;
    headHash: string;
    tailHash: string;
}

export interface AuditAppendOptions {
    tool?: string;
}

export interface AuditAppendData {
    entry: AuditEntry;
    seq: number;
    prevHash: string;
    entryHash: string;
}

export interface AuditQueryFilters {
    tenantId?: string;
    actor?: string;
    action?: string;
    resource?: string;
    outcome?: string;
    fromSeq?: number;
    toSeq?: number;
    fromTimestamp?: string;
    toTimestamp?: string;
    order?: 'asc' | 'desc';
    limit?: number;
    offset?: number;
    tool?: string;
}

export interface AuditQueryData {
    entries: readonly AuditEntry[];
    count: number;
    total: number;
}

export interface AuditTailSnapshot {
    readonly seq: number;
    readonly tailHash: string;
    readonly entry: AuditEntry | null;
}

export interface CreateAuditLogOptions {
    sqlitePath?: string;
    db?: NodeSqliteDatabaseLike | { readonly db: NodeSqliteDatabaseLike } | null;
    tableName?: string;
    hmacSecret?: string;
    maxEntries?: number;
    nowFn?: () => string;
    tool?: string;
}

export interface AuditLogHandle {
    readonly append: (
        record: AuditAppendRecord,
        options?: AuditAppendOptions
    ) => LegoEnvelope<AuditAppendData>;
    readonly verify: (
        options?: VerifyAuditChainOptions
    ) => LegoEnvelope<VerifyAuditChainData>;
    readonly query: (
        filters?: AuditQueryFilters
    ) => LegoEnvelope<AuditQueryData>;
    readonly tail: () => AuditTailSnapshot;
    readonly close: () => void;
}

export declare const GENESIS_AUDIT_HASH: string;

export declare function canonicalizeAuditPayload(
    value: unknown,
    options?: CanonicalizeAuditPayloadOptions
): LegoEnvelope<CanonicalizeAuditPayloadData>;

export declare function computeAuditEntryHash(
    entryInput: AuditEntryInput,
    options?: ComputeAuditEntryHashOptions
): LegoEnvelope<ComputeAuditEntryHashData>;

export declare function verifyAuditChain(
    entries: ReadonlyArray<AuditEntry | Record<string, unknown>>,
    options?: VerifyAuditChainOptions
): LegoEnvelope<VerifyAuditChainData>;

export declare function createAuditLog(
    options?: CreateAuditLogOptions
): AuditLogHandle;
