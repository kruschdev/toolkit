export interface SetupLoggingOptions {
    logDir?: string;
    maxBytes?: number;
    backupCount?: number;
    console?: boolean;
}

export interface Logger {
    appName: string;
    console: boolean;
    format: (level: string, message: string, meta?: Error | Record<string, unknown> | unknown) => string;
    info: (message: string, meta?: Record<string, unknown> | unknown) => void;
    warn: (message: string, meta?: Record<string, unknown> | unknown) => void;
    error: (message: string, errorInstanceOrMeta?: Error | Record<string, unknown> | unknown) => void;
    debug: (message: string, meta?: Record<string, unknown> | unknown) => void;
}

export declare function setupLogging(appName: string, options?: SetupLoggingOptions): Logger;
