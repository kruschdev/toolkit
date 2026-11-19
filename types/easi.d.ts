export declare const DEFAULT_EASI_WATCH_BASE: string;
export declare const DEFAULT_CHROME_OMNIBOX_MIN_Y: number;
export declare const DEFAULT_EDITOR_TAIL_SELECTOR: string;
export declare const MUTATING_EASI_TOOLS: ReadonlySet<string>;

export interface EasiLocalNavigatorTier {
    readonly name: string;
    readonly model: string;
    readonly apiUrl: string;
}

export declare const DEFAULT_LOCAL_NAVIGATOR_TIERS: readonly EasiLocalNavigatorTier[];

export declare function nextEasiCallId(prefix?: string): string;
export declare function normalizeEditorWhitespace(text: string): string;

export interface EasiMcpToolResult {
    ok: boolean;
    simulated?: boolean;
    isError?: boolean;
    structured?: Record<string, any> | null;
    text?: string;
    raw?: Record<string, any>;
    error?: string;
    code?: number | string;
    stderr?: string;
}

export type EasiMcpCallerFn = (
    toolName: string,
    toolArgs?: Record<string, any>,
    options?: Record<string, any>
) => Promise<EasiMcpToolResult>;

export interface EasiCallOptions {
    caller?: EasiMcpCallerFn;
    easiMcpCaller?: EasiMcpCallerFn;
    command?: string;
    tunnelScriptPath?: string;
    args?: string[];
    mcpUrl?: string;
    bearerToken?: string;
    watchBase?: string;
    timeoutMs?: number;
    mock?: boolean;
    autoMock?: boolean;
    allowStopSession?: boolean;
    allowNavigate?: boolean;
    throwOnError?: boolean;
    clientName?: string;
    clientVersion?: string;
    spawnFn?: (...args: any[]) => any;
    fetchImpl?: typeof fetch;
    sleepFn?: (ms: number) => Promise<void>;
}

export interface EasiClientOptions extends EasiCallOptions {
    autoCallId?: boolean;
    callIdPrefix?: string;
    persistent?: boolean;
    unrefProcess?: boolean;
    unrefTimers?: boolean;
}

export interface EasiClient {
    readonly watchBase: string;
    call(
        toolName: string,
        toolArgs?: Record<string, any>,
        callOptions?: EasiCallOptions
    ): Promise<EasiMcpToolResult>;
    close(): Promise<void>;
    setMojoKeyDrain(active: boolean): boolean;
    isMojoKeyDrainActive(): boolean;
}

export declare function buildSimulatedEasiResponse(
    toolName: string,
    toolArgs?: Record<string, any>,
    options?: { watchBase?: string }
): EasiMcpToolResult;

export declare function callEasiMcpTool(
    toolName: string,
    toolArgs?: Record<string, any>,
    options?: EasiCallOptions
): Promise<EasiMcpToolResult>;

export declare function createEasiClient(options?: EasiClientOptions): EasiClient;

export interface EasiPixelFrame {
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface EasiSafeWebElement {
    token?: string;
    index: number;
    parent_index: number | null;
    role: string;
    label: string;
    value: string;
    enabled: boolean;
    actions: string[];
    frame: EasiPixelFrame | null;
}

export declare function extractSafeWebElements(
    structuredSnapshot?: Record<string, any> | null,
    options?: { limit?: number; minWebY?: number }
): {
    allElements: Array<Record<string, any>>;
    safeElements: EasiSafeWebElement[];
};

export declare function resolveEasiChromeWindow(
    client: Pick<EasiClient, 'call'>,
    session: string
): Promise<{ pid: number; windowId: number }>;

export interface EasiDomElementDigest {
    tag: string;
    text: string;
    ariaLabel?: string;
    className?: string;
    testid?: string;
    href?: string;
    role?: string;
    contenteditable?: string;
    placeholder?: string;
}

export interface EasiCompactUiState {
    url: string;
    pageTitle: string;
    snapshotId: string | null;
    allElements: Array<Record<string, any>>;
    safeElements: EasiSafeWebElement[];
    domElements: EasiDomElementDigest[];
}

export declare function captureCompactUiState(
    client: Pick<EasiClient, 'call'>,
    session: string,
    pid: number,
    windowId: number,
    options?: {
        axQuery?: string;
        domSelector?: string;
        maxElements?: number;
        safeLimit?: number;
        domLimit?: number;
        minWebY?: number;
        axTimeoutMs?: number;
    }
): Promise<EasiCompactUiState>;

export interface EasiNavigatorDecision {
    action: 'click_token' | 'click_xy' | 'goal_reached' | 'wait' | 'blocked';
    element_token: string | null;
    x: number | null;
    y: number | null;
    reason: string;
}

export interface StepSmallModelNavigatorOptions {
    stage?: string;
    goal: string;
    observation: Partial<EasiCompactUiState>;
    llmConfig?: Record<string, any>;
    tiers?: readonly EasiLocalNavigatorTier[];
    startTierIndex?: number;
    minWebY?: number;
    extraRules?: string[];
    systemIntro?: string;
    chatJsonFn?: (...args: any[]) => Promise<any>;
    decisionLog?: Array<Record<string, any>> | null;
    onTierFallback?: (event: {
        tier: EasiLocalNavigatorTier;
        error: unknown;
        nextTier: EasiLocalNavigatorTier | null;
    }) => void;
}

export declare function stepSmallModelNavigator(
    options: StepSmallModelNavigatorOptions
): Promise<{
    decision: EasiNavigatorDecision;
    model: string;
    elapsedMs: number;
    tierIndex: number;
}>;

export declare function executeValidatedUiDecision(
    client: Pick<EasiClient, 'call'>,
    params: {
        session: string;
        pid: number;
        windowId: number;
        decision: EasiNavigatorDecision | Record<string, any>;
        observation?: Partial<EasiCompactUiState>;
        minWebY?: number;
    }
): Promise<EasiMcpToolResult>;

export interface EasiEditorTailSnapshot {
    busy: boolean;
    text: string;
    url: string;
    blockCount?: number;
}

export declare function readEditorTailDom(
    client: Pick<EasiClient, 'call'>,
    session: string,
    options?: { selector?: string; limit?: number; timeoutMs?: number }
): Promise<EasiEditorTailSnapshot>;

export declare function detectResumableChunkIndex(
    tailText: string,
    chunks?: string[],
    options?: { probeLength?: number }
): number;

export declare function resolveBodyEditorClickPoint(
    client: Pick<EasiClient, 'call'>,
    options: {
        session: string;
        pid: number;
        windowId: number;
        labelPattern?: RegExp;
        minEditorX?: number;
        minEditorY?: number;
        minWebY?: number;
        fallbackNavigator?: (safeElements: EasiSafeWebElement[]) => Promise<Partial<EasiNavigatorDecision>>;
    }
): Promise<{
    x: number;
    y: number;
    frame?: EasiPixelFrame;
    role?: string;
    token?: string;
    source: string;
}>;

export declare function streamContentEditableChunks(
    client: Pick<EasiClient, 'call' | 'setMojoKeyDrain'>,
    options: {
        session: string;
        pid: number;
        windowId: number;
        chunks: string[];
        startChunkIndex?: number;
        selector?: string;
        probeLength?: number;
        initialWaitMs?: number;
        pollIntervalMs?: number;
        maxPolls?: number;
        chunkTimeoutMs?: number;
        sleepFn?: (ms: number) => Promise<void>;
        onProgress?: (event: Record<string, any>) => void;
    }
): Promise<{
    chunksTyped: number;
    totalChunks: number;
    finalTail: EasiEditorTailSnapshot;
}>;

export declare function uploadFileViaChooser(
    client: Pick<EasiClient, 'call'>,
    options: {
        session: string;
        filePath?: string;
        fileBytes?: Uint8Array | null;
        fileName?: string;
        triggerChooserFn?: (meta: { fileId: number; bytes: number; fileName: string }) => Promise<void>;
        putFn?: (putUrl: string, buffer: Uint8Array, timeoutMs?: number) => Promise<string | Record<string, any>>;
        pollAttempts?: number;
        pollIntervalMs?: number;
        sendTimeoutMs?: number;
        putTimeoutMs?: number;
        sleepFn?: (ms: number) => Promise<void>;
        onTransferAsk?: (meta: { session: string; fileName: string; bytes: number }) => void;
    }
): Promise<{
    uploaded: boolean;
    fileId?: number;
    bytes?: number;
    reason?: string;
    chooserRequest?: string;
}>;
