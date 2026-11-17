import type { Server } from 'node:http';
import type { LegoEnvelope } from './envelopes.js';
import type { SchemaInput } from './schema.js';
import type { HydraDbClient } from './hydradb.js';
import type { McpToolDefinition, DisconnectedMcpServerHandle } from './mcp-server.js';

export const DEFAULT_SANDBOX_TIMEOUT_MS: 800;
export const DEFAULT_SANDBOX_MAX_MEMORY_MB: 32;
export const MAX_BRICK_SOURCE_BYTES: 65536;

export interface BrickSafetyFinding {
    ruleId: string;
    message: string;
}

export interface BrickSafetyData {
    clean: boolean;
    findings: BrickSafetyFinding[];
    byteLength?: number;
}

export interface BrickBlueprint {
    id: string;
    name?: string;
    summary?: string;
    exportName?: string;
    language?: 'js' | 'ts';
    inputSchema: SchemaInput<any>;
    outputSchema: SchemaInput<any>;
    bindingSchema?: SchemaInput<any>;
    notes?: string[];
}

export interface BrickPositiveCheck {
    name: string;
    input: unknown;
    binding?: Record<string, unknown>;
    expectedOutput?: unknown;
    expectedSubset?: Record<string, unknown>;
    assertFn?: (output: any) => boolean | Promise<boolean>;
    skipInputSchema?: boolean;
}

export interface BrickFaultCheck {
    name: string;
    input: unknown;
    binding?: Record<string, unknown>;
    expectThrow?: boolean;
    expectedErrorSubstring?: string;
    expectedOutput?: unknown;
    expectedSubset?: Record<string, unknown>;
    assertFn?: (output: any) => boolean | Promise<boolean>;
}

export interface BrickCheckOutcome {
    name: string;
    kind: 'positive' | 'fault';
    passed: boolean;
    durationMs?: number;
    detail?: string;
    actualOutput?: unknown;
}

export interface BrickRepairHint {
    gate: string;
    checkName?: string;
    message: string;
    counterexample?: unknown;
}

export interface BrickVerificationData {
    gates: Record<string, boolean>;
    checks: BrickCheckOutcome[];
    passedCount: number;
    totalCount: number;
    faultChallengeCount: number;
    blueprintHash: string;
    contractHash: string;
    sourceHash: string;
    checksHash: string;
    repairHints: BrickRepairHint[];
}

export interface BrickLineage {
    standard: 'krusch-brick-exchange-v1';
    brickId: string;
    requirementId: string | null;
    blueprintHash: string;
    contractHash: string;
    sourceHash: string;
    checksHash: string;
    faultChallengeCount: number;
    provenance: string;
    authorId: string;
    orgId: string;
    sealedAt: string;
}

export interface BrickAttestation {
    algorithm: 'ed25519';
    domain: 'krusch-brick-seal-v1';
    keyId: string;
    publicKeyPem: string;
    signature: string;
}

export interface SealedBrickBundle {
    format: 'krusch-sealed-brick/v1';
    brickId: string;
    name: string;
    summary: string;
    brickClass: string;
    authorId: string;
    orgId: string;
    capabilities: string[];
    replacesBoilerplate: string;
    estimatedHoursSaved: number;
    blueprint: BrickBlueprint;
    source: string;
    checks: Array<{ name: string; kind: 'positive' | 'fault'; passed: boolean }>;
    lineage: BrickLineage;
    attestation: BrickAttestation;
    createdAt: string;
}

export type BrickGrantScope = 'team' | 'federated';
export type BrickReceiveMode = 'off' | 'team' | 'federated';

export interface BrickOrg {
    id: string;
    name: string;
    participating?: boolean;
    peers?: string[];
    publishers?: string[];
    exporters?: string[];
    receivers?: string[];
    allowedClasses?: string[];
}

export interface BrickMember {
    id: string;
    name: string;
    orgId: string;
    publisher?: boolean;
    exporter?: boolean;
    eligible?: boolean;
    capabilities?: string[];
    receiveMode?: BrickReceiveMode;
    mutedSenders?: string[];
}

export interface BrickGrant {
    id: string;
    brickId: string;
    sourceHash: string;
    issuerId: string;
    scope: BrickGrantScope;
    recipients: string[];
    expiresAt: string;
    revoked: boolean;
    reshare: false;
    createdAt?: string;
}

export interface BrickRecipientSuggestion {
    memberId: string;
    memberName: string;
    orgId: string;
    orgName: string;
    deliveryChannel: 'team-commons' | 'requires-grant';
    score: number;
    matchedCapabilities: string[];
    matchedKeywords: string[];
    matchedBoilerplate: string[];
    hydraScore?: number;
    hydraRequestId?: string | null;
    reason: string;
}

export interface BrickExchangeStore {
    upsertOrg: (org: BrickOrg) => LegoEnvelope<Record<string, unknown>>;
    getOrg: (orgId: string) => BrickOrg | null;
    listOrgs: () => BrickOrg[];
    upsertMember: (member: BrickMember) => LegoEnvelope<Record<string, unknown>>;
    getMember: (memberId: string) => BrickMember | null;
    listMembers: (options?: { orgId?: string | null }) => BrickMember[];
    setWorkflowBrief: (options: {
        orgId: string;
        brief?: string;
        capabilities?: string[];
        boilerplateSignals?: string[];
    }) => Promise<LegoEnvelope<Record<string, unknown>>>;
    getWorkflowBrief: (orgId: string) => Record<string, unknown> | null;
    publishSealedBrick: (
        bundle: SealedBrickBundle,
        options?: { actorId?: string | null; trustedPublicKeyPem?: string | null }
    ) => LegoEnvelope<{ brickId: string; sourceHash: string; keyId: string }>;
    issueGrant: (options: {
        issuerId: string;
        brickId: string;
        sourceHash: string;
        scope?: BrickGrantScope;
        recipients: string[];
        expiresAt: string;
    }) => LegoEnvelope<{ grant: BrickGrant }>;
    revokeGrant: (options: { actorId: string; grantId: string }) => LegoEnvelope<{ grant: BrickGrant }>;
    listGrants: (options?: { brickId?: string | null; recipientId?: string | null }) => BrickGrant[];
    getVisibleBrick: (options: {
        viewerId: string;
        brickId: string;
        sourceHash?: string | null;
        nowMs?: number;
    }) => LegoEnvelope<{ bundle: SealedBrickBundle; accessMode: string }>;
    listVisibleBricks: (options: {
        viewerId: string;
        query?: string;
        nowMs?: number;
    }) => LegoEnvelope<{ bricks: Array<Record<string, unknown>> }>;
    suggestRecipients: (options: {
        actorId: string;
        brickId: string;
        sourceHash?: string | null;
        repoSignalsByOrg?: Record<string, string[]>;
        repoRoot?: string | null;
        nowMs?: number;
    }) => Promise<LegoEnvelope<{ suggestions: BrickRecipientSuggestion[] }>>;
    recordAdoption: (options: {
        userId: string;
        brickId: string;
        sourceHash: string;
        grantId?: string | null;
        bindingHash?: string;
        localChecksPassed?: boolean;
        hydraRequestId?: string | null;
        nowMs?: number;
    }) => Promise<LegoEnvelope<{ adoption: Record<string, unknown> }>>;
    listAdoptions: (options?: { brickId?: string | null; orgId?: string | null }) => Array<Record<string, unknown>>;
    getPortfolioStats: () => LegoEnvelope<Record<string, unknown>>;
    verifyLedger: () => LegoEnvelope<Record<string, unknown>>;
    close: () => void;
}

export declare function canonicalBrickHash(value: unknown): string;
export declare function computeCanonicalHash(value: unknown): string;
export declare function scanBrickSourceSafety(
    source: string,
    options?: { maxBytes?: number; allowPureRelativeImports?: boolean }
): LegoEnvelope<BrickSafetyData>;
export declare function transpileBrickSourceToCjs(source: string): string;
export declare function executeInBrickSandbox(options: {
    source: string;
    exportName?: string;
    input?: unknown;
    binding?: Record<string, unknown>;
    timeoutMs?: number;
    maxMemoryMb?: number;
    customRunner?: ((ctx: Record<string, unknown>) => unknown | Promise<unknown>) | null;
}): Promise<LegoEnvelope<{ output: unknown; durationMs: number; isolationMode: string }>>;
export declare function runBrickVerificationGates(options: {
    blueprint: BrickBlueprint;
    source: string;
    positiveChecks: BrickPositiveCheck[];
    faultChecks: BrickFaultCheck[];
    customRunner?: ((ctx: Record<string, unknown>) => unknown | Promise<unknown>) | null;
    timeoutMs?: number;
    maxMemoryMb?: number;
}): Promise<LegoEnvelope<BrickVerificationData>>;
export declare function derivePublicKeyId(publicKeyPem: string): string;
export declare function generateBrickSigningKeyPair(): LegoEnvelope<{
    keyId: string;
    publicKeyPem: string;
    privateKeyPem: string;
    algorithm: 'ed25519';
}>;
export declare function sealVerifiedBrick(options: {
    blueprint: BrickBlueprint;
    source: string;
    verificationReport: BrickVerificationData | LegoEnvelope<BrickVerificationData>;
    authorId: string;
    orgId: string;
    brickClass?: string;
    capabilities?: string[];
    replacesBoilerplate?: string;
    estimatedHoursSaved?: number;
    privateKeyPem: string;
    publicKeyPem?: string;
    requirementId?: string | null;
    provenance?: string;
    createdAt?: string;
}): LegoEnvelope<{ bundle: SealedBrickBundle }>;
export declare function verifyBrickBundle(
    bundle: SealedBrickBundle,
    options?: { trustedPublicKeyPem?: string | null }
): LegoEnvelope<{
    valid: true;
    brickId: string;
    sourceHash: string;
    blueprintHash: string;
    keyId: string;
    lineage: BrickLineage;
}>;
export declare function canPublishBrick(options: {
    actor: BrickMember;
    org: BrickOrg;
    bundle: SealedBrickBundle;
    scope?: BrickGrantScope;
}): LegoEnvelope<{ allowed: true; scope: BrickGrantScope }>;
export declare function canReceiveBrick(options: {
    recipient: BrickMember;
    recipientOrg: BrickOrg;
    sourceOrg: BrickOrg;
    preference?: { mode?: BrickReceiveMode; mutedSenders?: string[] } | null;
    issuer?: BrickMember | null;
    bundle: SealedBrickBundle;
    grant?: BrickGrant | null;
    nowMs?: number;
}): LegoEnvelope<{ allowed: true; mode: 'team-commons' | 'scoped-grant'; reason: string; grantId?: string }>;
export declare function createBrickExchangeStore(options?: {
    dbPath?: string;
    auditHmacSecret?: string;
    hydraClient?: HydraDbClient | null;
    hydraDatabase?: string;
    nowFn?: () => number;
}): BrickExchangeStore;
export declare function tryBrickLocally(options: {
    bundle: SealedBrickBundle;
    binding?: Record<string, unknown>;
    sampleInput: unknown;
    customRunner?: ((ctx: Record<string, unknown>) => unknown | Promise<unknown>) | null;
    timeoutMs?: number;
    maxMemoryMb?: number;
}): Promise<LegoEnvelope<{
    brickId: string;
    sourceHash: string;
    bindingHash: string;
    output: unknown;
    durationMs: number;
}>>;
export declare function adoptBrickIntoRepo(options: {
    bundle: SealedBrickBundle;
    targetRepoDir: string;
    bindingSource?: string | null;
    grantId?: string | null;
    adoptedBy?: string;
    sampleInput?: unknown;
    binding?: Record<string, unknown>;
    customRunner?: ((ctx: Record<string, unknown>) => unknown | Promise<unknown>) | null;
}): Promise<LegoEnvelope<{
    brickId: string;
    sourceHash: string;
    entryPath: string;
    bindingPath: string;
    lockfilePath: string;
}>>;
export declare function auditRepoBrickLocks(targetRepoDir: string): LegoEnvelope<{
    lockfilePresent: boolean;
    lockedBrickCount: number;
    clean: boolean;
    findings: Array<Record<string, unknown>>;
}>;
export declare function renderBrickExchangeConsoleHtml(options?: { title?: string }): string;
export declare function createBrickExchangeServer(options: {
    store: BrickExchangeStore;
    serviceName?: string;
    version?: string;
    authTokens?: Record<string, string> | Map<string, string> | string[] | null;
    corsOrigins?: string[];
    logger?: Record<string, any> | null;
}): Server;
export declare const BRICK_EXCHANGE_MCP_TOOLS: McpToolDefinition[];
export declare function createBrickExchangeMcpServer(options?: {
    store?: BrickExchangeStore | null;
    name?: string;
    version?: string;
    connect?: boolean;
}): Promise<DisconnectedMcpServerHandle | any>;
export declare function extractRepoAstGraph(
    realRepoDir: string,
    options?: { overlayEdits?: Record<string, string>; maxFiles?: number }
): {
    files: string[];
    symbolsByFile: Record<string, { exports: string[]; hasDefaultExport: boolean }>;
    edges: Array<{ from: string; to: string; importedNames: string[] }>;
};
export declare function analyzeBrickBlastRadius(options: {
    repoDir: string;
    changedFiles?: string[] | string;
    tasks?: Array<{ id?: string; title?: string; targetFiles?: string[]; files?: string[] }>;
    chokePoints?: Iterable<string>;
    protectedFiles?: string[];
    maxBlastHops?: number;
}): LegoEnvelope<Record<string, any>>;
export declare function planAgentFanOut(options: {
    repoDir: string;
    tasks: Array<{ id?: string; title?: string; targetFiles?: string[]; files?: string[] }>;
    chokePoints?: Iterable<string>;
    protectedFiles?: string[];
    maxBlastHops?: number;
}): LegoEnvelope<Record<string, any>>;
export declare function verifyTwoHopBlastRadius(options: {
    repoDir: string;
    candidateEdits: Record<string, string>;
    lease?: { taskId?: string; targetFiles?: string[] } | null;
    protectedFiles?: string[];
    chokePoints?: Iterable<string>;
    invariantScript?: string;
    invariantEntryFile?: string;
    timeoutMs?: number;
}): Promise<LegoEnvelope<Record<string, any>>>;
export declare function sealBrick(options: {
    blueprint: BrickBlueprint;
    source: string;
    positiveChecks: BrickPositiveCheck[];
    faultChecks: BrickFaultCheck[];
    authorId?: string;
    orgId?: string;
    brickClass?: string;
    capabilities?: string[];
    replacesBoilerplate?: string;
    estimatedHoursSaved?: number;
    privateKeyPem?: string;
    publicKeyPem?: string;
    requirementId?: string | null;
    provenance?: string;
    createdAt?: string;
    customRunner?: ((ctx: Record<string, unknown>) => unknown | Promise<unknown>) | null;
    timeoutMs?: number;
    maxMemoryMb?: number;
}): Promise<LegoEnvelope<{
    bundle: SealedBrickBundle;
    verification: BrickVerificationData;
    keyPairGenerated: boolean;
}>>;
export declare function runBrickRepairLoop(options: {
    blueprint: BrickBlueprint;
    source: string;
    positiveChecks: BrickPositiveCheck[];
    faultChecks: BrickFaultCheck[];
    repairFn?: (ctx: {
        attempt: number;
        maxAttempts: number;
        source: string;
        blueprint: BrickBlueprint;
        repairHints: BrickRepairHint[];
        error: unknown;
    }) => string | Promise<string>;
    maxAttempts?: number;
    authorId?: string;
    orgId?: string;
    brickClass?: string;
    capabilities?: string[];
    replacesBoilerplate?: string;
    estimatedHoursSaved?: number;
    privateKeyPem?: string;
    publicKeyPem?: string;
}): Promise<LegoEnvelope<{
    bundle: SealedBrickBundle;
    verification: BrickVerificationData;
    attempts: number;
    history: Array<Record<string, unknown>>;
}>>;
export declare function stageScoutCandidateSpecs(
    scoutReport: Record<string, any>,
    options?: {
        includeCovered?: boolean;
        implementations?: Record<
            string,
            {
                source: string;
                blueprint?: Partial<BrickBlueprint>;
                positiveChecks: BrickPositiveCheck[];
                faultChecks: BrickFaultCheck[];
            }
        >;
        authorId?: string;
        orgId?: string;
        privateKeyPem?: string;
        store?: BrickExchangeStore | null;
    }
): Promise<LegoEnvelope<{
    qualifyingClusterCount: number;
    specDrafts: Array<Record<string, any>>;
    sealedBundles: Array<Record<string, any>>;
    sealFailures: Array<Record<string, any>>;
}>>;
