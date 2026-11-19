export type RsiModuleName =
    | 'AgentLoop'
    | 'ToolUse'
    | 'ObservationManagement'
    | 'ContextManagement'
    | 'TaskCompletionDetection';

export type SimTransferMode =
    | 'cold_start'
    | 'harness_transfer'
    | 'problem_only'
    | 'full_sim';

export declare const RSI_MODULES: {
    readonly AGENT_LOOP: 'AgentLoop';
    readonly TOOL_USE: 'ToolUse';
    readonly OBSERVATION_MGMT: 'ObservationManagement';
    readonly CONTEXT_MGMT: 'ContextManagement';
    readonly TASK_COMPLETION: 'TaskCompletionDetection';
};

export declare const DEFAULT_HARNESS_SPECS: Readonly<Record<string, any>>;

export declare const SIM_TRANSFER_MODES: {
    readonly COLD_START: 'cold_start';
    readonly HARNESS_TRANSFER: 'harness_transfer';
    readonly PROBLEM_ONLY: 'problem_only';
    readonly FULL_SIM: 'full_sim';
};

export declare const SIM_GUIDANCE_RULES: ReadonlyArray<string>;

export interface SimAttemptRecord {
    round: number;
    sample: number;
    accepted: boolean;
    backfilled: boolean;
    what: string;
    rationale: string;
    files: string[];
    predicted: string[];
    fixed: string[];
    missed: string[];
    passed: number;
    total: number;
    domain: string;
    benchmark: string | null;
    policyModel: string | null;
    moduleName: string | null;
    timestamp: string;
}

export interface SimProblemEntry {
    id: string;
    name: string;
    opened_round: number;
    attempts: SimAttemptRecord[];
}

export interface SimJsonRecord {
    next_id: number;
    carried_from: Record<string, any> | null;
    aliases: Record<string, string>;
    problems: SimProblemEntry[];
}

export interface SelfImprovementMemory {
    resolveProblemId(idOrAlias: string): string | null;
    recordAttempt(attemptInput: Record<string, any>): {
        updated: boolean;
        problemId: string | null;
        createdNewProblem: boolean;
        attempt: SimAttemptRecord | null;
    };
    mergeProblems(sourceId: string, targetId: string): {
        merged: boolean;
        targetId: string;
        aliases: Record<string, string>;
    };
    getProblem(idOrName: string): SimProblemEntry | null;
    transferTo(options?: {
        arm?: string;
        domain?: string;
        into?: string;
        mode?: SimTransferMode | string;
    }): SelfImprovementMemory;
    getSummary(): {
        problemCount: number;
        totalAttempts: number;
        aliasCount: number;
        unresolvedPredictionsCount: number;
        carriedFrom: Record<string, any> | null;
        domains: string[];
        benchmarks: string[];
        policyModels: string[];
    };
    compileOptimizerPrompt(targetContext?: {
        targetDomain?: string | null;
        targetBenchmark?: string | null;
        targetPolicyModel?: string | null;
    }): {
        prompt: string;
        benchmarkShift: boolean;
        modelShift: boolean;
        summary: Record<string, any>;
    };
    toJSON(): SimJsonRecord;
}

export declare function createSelfImprovementMemory(
    initialState?: Partial<SimJsonRecord> | Record<string, any>
): SelfImprovementMemory;

export declare function createModularRsiHarness(
    initialSpecs?: Record<string, any>,
    options?: {
        sim?: SelfImprovementMemory | Record<string, any>;
        domain?: string;
        benchmark?: string | null;
        policyModel?: string | null;
    }
): Record<string, any>;

