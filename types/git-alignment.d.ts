export interface CoChangeRule {
    id: string;
    severity?: 'CRITICAL' | 'WARNING' | string;
    whenGlobs?: ReadonlyArray<string>;
    when?: ReadonlyArray<string> | string;
    requireGlobs?: ReadonlyArray<string>;
    require?: ReadonlyArray<string> | string;
    description?: string;
}

export interface CoChangeViolation {
    id: string;
    severity: string;
    description: string;
    triggeredBy: string[];
    missingAnyOf: string[];
}

export interface CompiledSafeGlob {
    valid: boolean;
    pattern: string;
    regex: RegExp | null;
    error: string | null;
}

export declare const DEFAULT_COCHANGE_RULES: ReadonlyArray<CoChangeRule>;

export declare function normalizeDiffRelativePath(rawPath: string): string | null;
export declare function extractDiffTouchedFiles(diffText: string): string[];
export declare function parseDiffOldHunks(
    diffText: string,
    options?: { maxHunkLines?: number }
): Record<string, Array<[number, number]>>;
export declare function compileSafeCoChangeGlob(pattern: string): CompiledSafeGlob;
export declare function evaluateCoChangeRules(params?: {
    diff?: string;
    changedFiles?: string[];
    rules?: ReadonlyArray<CoChangeRule>;
    matchSubpaths?: boolean;
}): {
    ok: boolean;
    tool: string;
    summary: string;
    data: {
        passed: boolean;
        touchedFiles: string[];
        evaluatedCount: number;
        violations: CoChangeViolation[];
        invalidRules: Array<{ id: string; error: string }>;
    };
};
export declare function extractCommitCausalRationale(
    title: string,
    body: string | null | undefined,
    options?: { maxSentences?: number; maxCharsPerSentence?: number }
): string | null;
