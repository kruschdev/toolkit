import type { LegoEnvelope } from './envelopes.js';

export type TreeSitterGrammarName =
    | 'javascript'
    | 'typescript'
    | 'tsx'
    | 'python'
    | 'php'
    | 'java'
    | 'c_sharp'
    | 'go'
    | 'ruby'
    | 'rust'
    | 'kotlin';

export declare const TREE_SITTER_GRAMMAR_BY_EXTENSION: Readonly<Record<string, TreeSitterGrammarName>>;
export declare const SUPPORTED_TREESITTER_EXTENSIONS: readonly string[];

export interface InitTreeSitterOptions {
    wasmDir?: string;
    searchRoots?: readonly string[];
    tool?: string;
}

export interface TreeSitterInitData {
    ready: boolean;
    astEngine: 'web-tree-sitter-wasm';
    wasmDir: string;
    grammars: string[];
}

export interface TreeSitterSyntaxError {
    line: number;
    column: number;
    snippet: string;
}

export interface TreeSitterSymbol {
    symbol_name: string;
    symbol_type: string;
    start_line: number;
    end_line: number;
    signature: string;
}

export interface TreeSitterImport {
    specifier: string;
    kind: string;
    importedNames: string[];
}

export interface TreeSitterAnalysisData {
    supported: boolean;
    astEngine: 'web-tree-sitter-wasm';
    language: TreeSitterGrammarName | null;
    hasSyntaxError: boolean;
    syntaxErrors: TreeSitterSyntaxError[];
    packageName: string;
    namespaces: string[];
    symbols: TreeSitterSymbol[];
    imports: TreeSitterImport[];
    calls: string[];
    identifiers: string[];
}

export interface AnalyzeTreeSitterOptions {
    tool?: string;
}

export interface ChunkedTreeSitterSymbol {
    name: string;
    type: string;
    symbol_type: string;
    startLine: number;
    line_start: number;
    endLine: number;
    line_end: number;
    signature: string;
    content: string;
}

export interface ChunkedTreeSitterImport {
    sourcePath: string;
    targetPath: string;
    module: string;
    relation: 'imports' | 'requires';
    symbols: string[];
}

export interface ExtractedTreeSitterChunkResult {
    symbols: ChunkedTreeSitterSymbol[];
    imports: ChunkedTreeSitterImport[];
    astEngine: 'web-tree-sitter-wasm';
    hasSyntaxError: boolean;
}

export declare function initTreeSitterRuntime(
    options?: InitTreeSitterOptions
): Promise<LegoEnvelope<TreeSitterInitData, null>>;

export declare function isTreeSitterReady(): boolean;

export declare function resolveTreeSitterLanguage(filePath?: string): TreeSitterGrammarName | null;

export declare function analyzeFileWithTreeSitter(
    sourceText?: string,
    filePath?: string,
    options?: AnalyzeTreeSitterOptions
): LegoEnvelope<TreeSitterAnalysisData, { language: string; filePath: string } | null>;

export declare function extractTreeSitterSymbolsAndImports(
    sourceText?: string,
    filePath?: string
): ExtractedTreeSitterChunkResult | null;
