export interface ReactRuntime {
    createElement?: (type: any, props?: Record<string, any> | null, ...children: any[]) => any;
    useState?: <T>(initial: T | (() => T)) => [T, (next: T | ((prev: T) => T)) => void];
    useEffect?: (effect: () => void | (() => void), deps?: readonly unknown[]) => void;
    useMemo?: <T>(factory: () => T, deps?: readonly unknown[]) => T;
    useCallback?: <TFn extends (...args: any[]) => any>(fn: TFn, deps?: readonly unknown[]) => TFn;
    useRef?: <T>(initial: T) => { current: T };
    Component?: new (props: any) => any;
    [key: string]: any;
}

export type AestheticVariant = 'cyber' | 'glass' | 'emerald';

export interface AestheticThemeTokens {
    readonly variant: string;
    readonly bg: string;
    readonly surface: string;
    readonly card: string;
    readonly glow: string;
    readonly headingText: string;
    readonly mutedText: string;
    readonly badge: string;
    readonly buttonPrimary: string;
    readonly buttonGhost: string;
    readonly input: string;
}

export type OperationalStatus = 'healthy' | 'streaming' | 'degraded' | 'offline';

export interface UseCopyToClipboardOptions {
    timeout?: number;
    onCopy?: () => void;
}

export interface FetchApiJsonOptions extends Omit<RequestInit, 'body' | 'headers'> {
    body?: BodyInit | Record<string, unknown> | unknown[] | null;
    headers?: Record<string, string> | Headers;
    signal?: AbortSignal;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
    unwrapEnvelope?: boolean;
}

export interface UseApiQueryOptions<TData = any> {
    enabled?: boolean;
    deps?: readonly unknown[] | unknown[];
    fetchImpl?: typeof fetch;
    requestOptions?: FetchApiJsonOptions;
    initialData?: TData | null;
}

export interface UseApiQueryResult<TData = any> {
    data: TData | null;
    loading: boolean;
    error: Error | null;
    reload: () => void;
}

export interface SseParsedFrame<TData = any> {
    event: string;
    data: TData;
}

export interface UseSSEStreamOptions {
    fetchImpl?: typeof fetch;
    method?: string;
    headers?: Record<string, string> | Headers;
}

export interface UseSSEStreamResult {
    text: string;
    events: SseParsedFrame[];
    status: 'idle' | 'streaming' | 'done' | 'error';
    error: Error | null;
    start: (body?: unknown) => Promise<void>;
    stop: () => void;
    reset: () => void;
}

export interface StatusPillProps {
    status?: OperationalStatus | (string & {});
    label?: string;
    className?: string;
}

export interface MetricCardProps {
    title?: string;
    label?: string;
    value?: string | number | null;
    subtitle?: string;
    status?: OperationalStatus | (string & {});
    className?: string;
    children?: any;
}

export interface AppShellNavItem {
    id?: string;
    label?: string;
    badge?: string | number;
    [key: string]: unknown;
}

export interface AppShellProps {
    title?: string;
    subtitle?: string;
    status?: OperationalStatus | (string & {}) | any;
    navItems?: Array<string | AppShellNavItem>;
    activeNav?: string;
    onSelectNav?: (id: string, item: AppShellNavItem) => void;
    headerActions?: any;
    sidebarFooter?: any;
    className?: string;
    children?: any;
}

export interface StreamingChatMessage {
    id?: string | number;
    role: string;
    content?: string;
    text?: string;
}

export interface StreamingChatPanelProps {
    title?: string;
    messages?: StreamingChatMessage[];
    streamingText?: string;
    status?: 'idle' | 'streaming' | 'done' | 'error';
    onSend?: (message: string) => void;
    onStop?: () => void;
    placeholder?: string;
    className?: string;
}

export interface ErrorBoundaryFallbackContext {
    error: Error;
    reset: () => void;
}

export interface ErrorBoundaryProps {
    fallback?: ((ctx: ErrorBoundaryFallbackContext) => any) | any;
    fallbackRender?: (ctx: ErrorBoundaryFallbackContext) => any;
    onError?: (error: Error, errorInfo: any) => void;
    children?: any;
}

export declare function setReactRuntime(runtime: ReactRuntime | null): void;

export declare function getReactRuntime(): ReactRuntime | null;

export declare function cn(...inputs: unknown[]): string;

export declare const STYLES: {
    readonly glass: {
        readonly dark: string;
        readonly light: string;
        readonly premium: string;
    };
    readonly glow: {
        readonly cyan: string;
        readonly purple: string;
        readonly emerald: string;
    };
    readonly gradients: {
        readonly text: string;
        readonly textCosmic: string;
        readonly bgDark: string;
    };
};

export declare function useAesthetics(variant?: AestheticVariant | (string & {})): AestheticThemeTokens;

export declare function useMounted(): boolean;

export declare function useMediaQuery(query: string): boolean;

export declare function useClickOutside<TElement extends { contains?: (target: any) => boolean } = any>(
    ref: { current: TElement | null },
    handler: (event: any) => void
): void;

export declare function useCopyToClipboard(options?: UseCopyToClipboardOptions): {
    isCopied: boolean;
    copyToClipboard: (value: string) => Promise<void>;
};

export declare function fetchApiJson<TData = any>(
    url: string,
    options?: FetchApiJsonOptions
): Promise<TData>;

export declare function useApiQuery<TData = any>(
    url: string,
    options?: UseApiQueryOptions<TData>
): UseApiQueryResult<TData>;

export declare function useSSEStream(url: string, options?: UseSSEStreamOptions): UseSSEStreamResult;

export declare function StatusPill(props?: StatusPillProps): any;

export declare function MetricCard(props?: MetricCardProps): any;

export declare function AppShell(props?: AppShellProps): any;

export declare function StreamingChatPanel(props?: StreamingChatPanelProps): any;

export declare function createErrorBoundary(
    fallbackRender?: ((ctx: ErrorBoundaryFallbackContext) => any) | any
): (props?: ErrorBoundaryProps) => any;

export declare function ErrorBoundary(props?: ErrorBoundaryProps): any;
