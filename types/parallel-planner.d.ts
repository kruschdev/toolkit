import type { LegoEnvelope, OkEnvelope } from './envelopes.js';

export declare const DEFAULT_CHOKE_POINT_FILES: readonly string[];

export interface ParallelTaskInput {
    id?: string;
    workOrderId?: string;
    title?: string;
    targetFiles?: readonly string[];
    files?: readonly string[];
}

export interface DependencyEdgeInput {
    from?: string;
    to?: string;
    source?: string;
    target?: string;
    sourcePath?: string;
    targetPath?: string;
}

export interface PlanDisjointTaskWavesOptions {
    tasks?: readonly ParallelTaskInput[];
    edges?: readonly DependencyEdgeInput[];
    chokePoints?: Iterable<string>;
    maxBlastHops?: number;
    tool?: string;
}

export interface TaskFileLease {
    taskId: string;
    title: string;
    targetFiles: string[];
    hop1Dependents: string[];
    hop2Dependents: string[];
    leaseCone: string[];
    reservedChokePoints: string[];
    wave: number;
}

export interface ExecutionWave {
    wave: number;
    taskIds: string[];
    parallelizable: boolean;
    leasedFileCount: number;
}

export interface TaskConeCollision {
    tasks: [string, string];
    sharedFiles: string[];
}

export interface DisjointWavePlanData {
    taskCount: number;
    waveCount: number;
    fullyParallelSingleWave: boolean;
    waves: ExecutionWave[];
    leases: TaskFileLease[];
    collisions: TaskConeCollision[];
    reservedOrchestratorFiles: string[];
}

export interface NodePermissionSandboxOptions {
    workspaceDir: string;
    script?: string;
    entryFile?: string;
    args?: readonly string[];
    extraReadPaths?: readonly string[];
    allowWritePaths?: readonly string[];
    allowedEnv?: Readonly<Record<string, string>>;
    timeoutMs?: number;
    tool?: string;
}

export interface NodePermissionSandboxData<TResult = unknown> {
    passed: boolean;
    exitCode: number;
    timedOut: boolean;
    permissionDenied: boolean;
    sandboxType: 'node_permission';
    durationMs: number;
    stdout: string;
    stderr: string;
    result?: TResult;
}

export declare function normalizeRelativeCodePath(rawPath: unknown): string;

export declare function planDisjointTaskWaves(
    params?: PlanDisjointTaskWavesOptions
): OkEnvelope<DisjointWavePlanData>;

export declare function runNodePermissionSandbox<TResult = unknown>(
    params: NodePermissionSandboxOptions
): Promise<LegoEnvelope<NodePermissionSandboxData<TResult>, null>>;
