export interface CreateConfigOptions<TDefaults = Record<string, any>> {
    defaults?: TDefaults;
    configPath?: string | null;
    envFile?: string | null;
}

export declare function loadJsonConfig<TConfig = Record<string, any>>(filePath: string): TConfig;

export declare function createConfig<TDefaults = Record<string, any>>(
    options: CreateConfigOptions<TDefaults>
): Promise<TDefaults & Record<string, any>>;

export declare function envOr<TDefault = string | undefined>(
    envKey: string,
    fileValue?: TDefault | null,
    defaultValue?: TDefault
): string | TDefault;

export declare function envInt(
    envKey: string,
    fileValue?: number | string | null,
    defaultValue?: number
): number;

export declare function envBool(
    envKey: string,
    fileValue?: boolean | string | null,
    defaultValue?: boolean
): boolean;

export declare function validateRequired(
    config: Record<string, any>,
    requiredKeys: string[],
    options?: { throwOnMissing?: boolean }
): boolean;

export declare function loadProjectConfig<TDefaults = Record<string, any>>(
    projectRoot?: string,
    defaults?: TDefaults
): Promise<TDefaults & Record<string, any>>;

export declare function getHomelabTopology(): string;

export declare function getHomelabContext(): string;
