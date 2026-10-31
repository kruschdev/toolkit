import type { OkEnvelope, ErrorDetail, ErrorEnvelope, LegoEnvelope } from './envelopes.js';

export type { OkEnvelope, ErrorDetail, ErrorEnvelope, LegoEnvelope };

export type CandidatePatternRuntime = 'node' | 'python' | 'cross-runtime';

export type CandidatePatternCategory =
    | 'security'
    | 'storage'
    | 'routing'
    | 'ingestion'
    | 'modality'
    | 'schema';

export type CandidateClusterStatus =
    | 'ALREADY_COVERED_IN_TOOLKIT'
    | 'CANDIDATE_MEETS_RULE_OF_3'
    | 'BELOW_THRESHOLD_DO_NOT_EXTRACT';

export interface CandidatePatternSignature {
    readonly id: string;
    readonly title: string;
    readonly runtime: CandidatePatternRuntime;
    readonly category: CandidatePatternCategory;
    readonly statusWhenCovered: string | null;
    readonly proposedBrickImport: string;
    readonly antiBloatNote: string;
    readonly detectPackage?: (deps: Set<string>) => boolean;
    readonly detectSource?: (cleanedCode: string, ext: string) => boolean;
}

export interface ScoutHomelabOptions {
    minProjects?: number;
    maxFilesPerProject?: number;
    maxFileBytes?: number;
    portablePaths?: boolean;
}

export interface AdoptionFindingSummary {
    project: string;
    findingCount: number;
    rulesTriggered: string[];
    recommendedBricks: string[];
    sampleFiles: string[];
}

export interface CandidateClusterSummary {
    id: string;
    title: string;
    runtime: CandidatePatternRuntime;
    category: CandidatePatternCategory;
    projectCount: number;
    meetsRuleOfThree: boolean;
    status: CandidateClusterStatus;
    proposedBrickImport: string;
    antiBloatNote: string;
    projects: string[];
    sampleEvidence: string[];
}

export interface LegoScoutData {
    projectsRoot: string;
    scannedProjects: number;
    scannedFilesTotal: number;
    ruleOfThreeThreshold: number;
    adoptionFindings: AdoptionFindingSummary[];
    candidateClusters: CandidateClusterSummary[];
}

export declare const CANDIDATE_PATTERN_SIGNATURES: readonly CandidatePatternSignature[];

export declare function formatPortableProjectPath(absPath: string, projectsRoot: string): string;

export declare function scoutHomelabLegoCandidates(
    projectsRoot: string,
    options?: ScoutHomelabOptions
): LegoEnvelope<LegoScoutData>;
