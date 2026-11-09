export const DEFAULT_KRUSCH_GIT_URL: 'http://127.0.0.1:4890';

export interface KruschGitClientOptions {
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface KruschGitSearchCodeOptions {
  query: string;
  repo?: string | number;
  type?: 'hybrid' | 'semantic' | 'keyword';
  limit?: number;
}

export interface KruschGitSearchSymbolsOptions {
  query: string;
  repo?: string | number;
  symbolType?: 'function' | 'class' | 'method' | 'route' | 'section' | string;
  limit?: number;
}

export interface KruschGitDependencyGraphOptions {
  repo?: string | number;
  file?: string;
  symbol?: string;
}

export interface KruschGitSymbolGraphResult {
  filePath: string;
  repositoryId: number | string | null;
  symbols: Array<Record<string, unknown>>;
  imports: Array<{
    target_path: string;
    relation: string;
    symbols?: string | string[];
  }>;
  dependents: Array<{
    source_path: string;
    relation: string;
    symbols?: string | string[];
  }>;
  [key: string]: unknown;
}

export class KruschGitClient {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  fetchImpl: typeof fetch;

  constructor(options?: KruschGitClientOptions);
  isConfigured(): boolean;
  health(): Promise<Record<string, unknown>>;
  listRepos(): Promise<Array<Record<string, unknown>>>;
  createRepo(options: {
    name: string;
    description?: string;
  }): Promise<Record<string, unknown>>;
  getTree(options: {
    repoId: string | number;
    treeId?: string;
  }): Promise<Array<Record<string, unknown>>>;
  getBlob(blobId: string): Promise<Record<string, unknown>>;
  getBlobSymbols(blobId: string): Promise<Array<Record<string, unknown>>>;
  searchCode(
    options: KruschGitSearchCodeOptions
  ): Promise<Array<Record<string, unknown>>>;
  searchSymbols(
    options: KruschGitSearchSymbolsOptions
  ): Promise<Array<Record<string, unknown>>>;
  getDependencyGraph(
    options: KruschGitDependencyGraphOptions
  ): Promise<KruschGitSymbolGraphResult>;
}

export function createKruschGitClient(
  options?: KruschGitClientOptions
): KruschGitClient;
