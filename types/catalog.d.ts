import type { OkEnvelope } from './envelopes.js';

export type LegoRuntime = 'node' | 'python' | 'react' | 'edge' | (string & {});

export interface LegoBrick {
    readonly id: string;
    readonly runtime: LegoRuntime;
    readonly importPath: string;
    readonly exports: readonly string[];
    readonly summary: string;
    readonly snippet: string;
    readonly antiPatternDescription: string;
    readonly replacesBoilerplate: string;
}

export interface ProjectArchetypeRenderOptions {
    projectName?: string;
    port?: number;
}

export interface ProjectArchetype {
    readonly id: string;
    readonly title: string;
    readonly runtime: LegoRuntime;
    readonly description: string;
    readonly bricks: readonly string[];
    readonly bricksUsed?: readonly string[];
    readonly renderFiles: (options?: ProjectArchetypeRenderOptions) => Record<string, string>;
}

export interface BoilerplateFinding {
    ruleId: string;
    brickId: string;
    importPath: string;
    severity: 'warn' | 'error' | (string & {});
    message: string;
}

export interface BoilerplateAuditData {
    filePath: string;
    clean: boolean;
    findings: BoilerplateFinding[];
}

export declare const RUNTIME_BRICKS: readonly LegoBrick[];

export declare const PROJECT_ARCHETYPES: Readonly<Record<string, ProjectArchetype>>;

export declare function listLegoBricks(options?: { runtime?: string }): LegoBrick[];

export declare function getLegoBrick(id: string): LegoBrick | null;

export declare function listArchetypes(options?: { runtime?: string }): ProjectArchetype[];

export declare function getArchetype(id: string): ProjectArchetype | null;

export declare function auditBoilerplateText(
    code?: string,
    filePath?: string
): OkEnvelope<BoilerplateAuditData>;

export interface LegoCoverageFileEntry {
    filePath?: string;
    path?: string;
    code?: string;
    content?: string;
}

export interface ScoreLegoBrickCoverageOptions {
    tokensPerSealedBrick?: number;
}

export interface BoilerplateFileFinding extends BoilerplateFinding {
    filePath: string;
}

export interface LegoBrickCoverageData {
    scannedFiles: number;
    cleanFiles: number;
    flaggedFiles: number;
    sealedFiles: number;
    sealedBrickIds: string[];
    sealedTouchpoints: number;
    slopFindingCount: number;
    recommendedBrickIds: string[];
    sealedCoverageRatio: number;
    breakerTripped: boolean;
    estimatedAuditTokensSaved: number;
    findings: BoilerplateFileFinding[];
}

export declare function scoreLegoBrickCoverage(
    files?: LegoCoverageFileEntry[] | Record<string, string>,
    options?: ScoreLegoBrickCoverageOptions
): OkEnvelope<LegoBrickCoverageData>;

