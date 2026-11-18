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
    ontology?: BrickOntologyMetadata;
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
    ontology?: BrickOntologyMetadata;
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
    planCrossStackComposition: (options: {
        viewerId: string;
        targetStack?: BrickStackSlug | string | null;
        targetChannel?: string | null;
        requiredPorts?: string[];
        availableInputPorts?: string[];
        orgProfiles?: Array<Record<string, unknown>>;
        asOf?: string | null;
        maxHops?: number;
        namespace?: string;
        hydraOpenCypherClient?: Record<string, any> | null;
        nowMs?: number;
    }) => Promise<LegoEnvelope<Record<string, any>>>;
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
    ontology?: BrickOntologyMetadata | Record<string, unknown> | null;
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
    localSample?: unknown;
    targetStack?: BrickStackSlug | string | null;
    fieldMap?: Record<string, string> | null;
    binding?: Record<string, unknown>;
    customRunner?: ((ctx: Record<string, unknown>) => unknown | Promise<unknown>) | null;
}): Promise<LegoEnvelope<{
    brickId: string;
    sourceHash: string;
    entryPath: string;
    bindingPath: string;
    bundlePath?: string;
    lockfilePath: string;
    synthesizedBinding?: Record<string, any>;
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
    ontology?: BrickOntologyMetadata | Record<string, unknown> | null;
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

export type BrickStackSlug =
    | 'node-esm'
    | 'typescript-node'
    | 'python-fastapi'
    | 'react-vite'
    | 'cloudflare-edge';

export interface BrickTimeSeriesContract {
    cadenceMs?: number | null;
    requireMonotonicTimestamps?: boolean;
    preserveNegativeValues?: boolean;
    nanInfPolicy?: 'reject' | 'impute_null';
}

export interface BrickOntologyMetadata {
    stacks?: BrickStackSlug[] | string[];
    consumesPorts?: string[];
    producesPorts?: string[];
    channels?: string[];
    moeProfile?: string | null;
    supersedes?: string[];
    validFrom?: string | null;
    retiredAt?: string | null;
    timeSeriesContract?: BrickTimeSeriesContract | null;
}

export declare const ONTOLOGY_STACKS: Readonly<Record<string, Readonly<Record<string, any>>>>;
export declare const ONTOLOGY_DATA_PORTS: Readonly<Record<string, Readonly<Record<string, any>>>>;
export declare const ONTOLOGY_CHANNELS: Readonly<Record<string, Readonly<Record<string, any>>>>;
export declare const ONTOLOGY_MOE_PROFILES: Readonly<Record<string, Readonly<Record<string, any>>>>;
export declare const CROSS_STACK_BRICK_EQUIVALENTS: Readonly<Record<string, Readonly<Record<string, any>>>>;
export declare const CANONICAL_SHARED_TYPES: readonly string[];

export declare function resolveCrossStackCatalogEquivalents(
    brickIdOrRuntime?: string
): LegoEnvelope<Record<string, any>>;
export declare function isWebStandardPureSource(source: string): {
    pure: boolean;
    violations: string[];
};
export declare function parsePortReference(rawPort: string): {
    id: string;
    namespace: string;
    bareName: string;
    shared: boolean;
} | null;
export declare function arePortsCompatible(producedPort: string, consumedPort: string): boolean;
export declare function normalizeBrickOntologyMetadata(
    rawOntology?: BrickOntologyMetadata | Record<string, unknown>,
    options?: { source?: string; blueprint?: Partial<BrickBlueprint> | Record<string, unknown> }
): LegoEnvelope<{
    ontology: Required<BrickOntologyMetadata>;
    webStandardPurity: { pure: boolean; violations: string[] };
}>;
export declare function checkOntologyCompatibility(options: {
    bundle: SealedBrickBundle | Record<string, any>;
    targetStack?: BrickStackSlug | string;
    targetChannel?: string | null;
    providedSecurityBricks?: string[];
    enforceChannelGuards?: boolean;
    upstreamProducedPorts?: string[];
    sampleData?: unknown;
}): LegoEnvelope<Record<string, any>>;
export declare function surrogateOntologyVertexId(namespace: string, logicalId?: string): number;
export declare function compileBrickOntologyGraph(options?: {
    bricks?: Array<SealedBrickBundle | Record<string, any>>;
    orgProfiles?: Array<Record<string, any>>;
    namespace?: string;
}): LegoEnvelope<{
    namespace: string;
    nodes: Array<Record<string, any>>;
    edges: Array<{ from: string; to: string; type: string }>;
    stats: Record<string, number>;
}>;
export declare function syncBrickOntologyToHydra(
    graphInput: Record<string, any>,
    options?: {
        hydraOpenCypherClient?: Record<string, any> | null;
        hydraClient?: Record<string, any> | null;
        graphId?: string;
    }
): Promise<LegoEnvelope<Record<string, any>>>;
export declare function traverseBrickOntology(
    graphInput: Record<string, any>,
    options?: {
        targetStack?: BrickStackSlug | string | null;
        targetChannel?: string | null;
        requiredPorts?: string[];
        availableInputPorts?: string[];
        asOf?: string | null;
        maxHops?: number;
        hydraOpenCypherClient?: Record<string, any> | null;
    }
): LegoEnvelope<Record<string, any>> | Promise<LegoEnvelope<Record<string, any>>>;
export declare function applyFieldMapToSample(
    sample: unknown,
    fieldMap?: Record<string, string>,
    options?: Record<string, any>
): unknown;
export declare function synthesizeBrickBinding(options: {
    bundle: SealedBrickBundle;
    targetStack?: BrickStackSlug | string;
    localSample?: unknown;
    fieldMap?: Record<string, string>;
    bindingOverrides?: Record<string, unknown>;
    repairFn?: ((ctx: Record<string, any>) => Record<string, any> | Promise<Record<string, any>>) | null;
    maxRepairAttempts?: number;
    timeoutMs?: number;
    maxMemoryMb?: number;
}): Promise<LegoEnvelope<{
    brickId: string;
    sourceHash: string;
    targetStack: string;
    bridgeMode: string;
    adapterFileName: string;
    adapterSource: string;
    pythonAdapterSource: string | null;
    resolvedFieldMap: Record<string, string>;
    binding: Record<string, unknown>;
    localVerification: Record<string, any> | null;
    cascadeTierUsed: string;
}>>;
