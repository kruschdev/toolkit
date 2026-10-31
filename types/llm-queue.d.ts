export declare const PRIORITY: {
    readonly CRITICAL: 0;
    readonly HIGH: 1;
    readonly MEDIUM: 2;
    readonly LOW: 3;
};

export type PriorityLevel = (typeof PRIORITY)[keyof typeof PRIORITY] | number;

export declare class AsyncLock {
    constructor();
    acquire<TResult>(key: string, fn: () => Promise<TResult> | TResult): Promise<TResult>;
}

export declare const DEFAULT_FLEET_OLLAMA_NODES: readonly string[];

export declare class PriorityQueue {
    concurrency: number;
    active: number;
    queue: Array<{
        taskFn: (endpoint: string) => Promise<unknown>;
        priority: number;
        resolve: (value: any) => void;
        reject: (reason?: unknown) => void;
    }>;
    endpoints: string[];
    rrIndex: number;
    constructor(concurrency?: number);
    initEndpoints(): string[];
    getNextEndpoint(): string;
    enqueue<TResult = unknown>(
        taskFn: (endpoint: string) => Promise<TResult> | TResult,
        priority?: PriorityLevel
    ): Promise<TResult>;
    process(): Promise<void>;
}

export declare const ollamaQueue: PriorityQueue;
export declare const globalQueue: PriorityQueue;
