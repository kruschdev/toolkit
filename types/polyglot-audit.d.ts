import type { LegoEnvelope } from './envelopes.js';

export interface NormalizedGitHubRepoInput {
    isRemoteCandidate: boolean;
    candidateUrl: string;
    repoSlug: string | null;
    cleanHttpsUrl: string | null;
    displayTarget: string;
    hintedFile: string;
    invalidGitHubPath: boolean;
}

export interface PolyglotHazardFinding {
    filePath: string;
    ruleId: string;
    brickId: string;
    importPath: string;
    severity: 'error' | 'warning';
    message: string;
}

export interface AuditPolyglotRepositoryOptions {
    maxFiles?: number;
    tool?: string;
}

export interface PolyglotRepositoryAuditData {
    scannedFiles: number;
    cleanFiles: number;
    flaggedFiles: number;
    sealedTouchpoints: number;
    slopFindingCount: number;
    sealedCoverageRatio: number;
    breakerTripped: boolean;
    recommendedBrickIds: string[];
    findings: PolyglotHazardFinding[];
}

export declare function normalizeGitHubRepoInput(rawInput: unknown): NormalizedGitHubRepoInput;

export declare function auditPolyglotSource(
    source?: string,
    filePath?: string
): PolyglotHazardFinding[];

export declare function auditPolyglotRepository(
    targetDir: string,
    options?: AuditPolyglotRepositoryOptions
): LegoEnvelope<PolyglotRepositoryAuditData, null>;
