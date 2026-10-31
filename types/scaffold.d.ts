import type { OkEnvelope } from './envelopes.js';

export interface ScaffoldProjectOptions {
    archetype?: string;
    projectName?: string;
    port?: number;
    force?: boolean;
    dryRun?: boolean;
    quiet?: boolean;
}

export interface ScaffoldProjectResultData {
    archetype: string;
    projectName: string;
    port: number;
    targetDir: string;
    createdFiles: string[];
    skippedFiles: string[];
}

export declare function scaffoldProject(
    targetDir?: string,
    options?: ScaffoldProjectOptions
): Promise<OkEnvelope<ScaffoldProjectResultData> & { tool: 'scaffoldProject' }>;
