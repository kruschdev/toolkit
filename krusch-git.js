/**
 * @krusch/toolkit/krusch-git — KruschGit HTTP & AST Dependency Graph Client
 *
 * Wraps the KruschGit REST API (default http://127.0.0.1:4890) for
 * repository listing, Git tree/blob inspection, hybrid BM25 + dense vector
 * semantic search, AST symbol search, and inbound/outbound dependency graphs.
 */

export const DEFAULT_KRUSCH_GIT_URL = 'http://127.0.0.1:4890';

export class KruschGitClient {
  /**
   * @param {object} [options]
   * @param {string} [options.baseUrl]
   * @param {string} [options.apiKey]
   * @param {number} [options.timeoutMs]
   * @param {typeof fetch} [options.fetchImpl]
   */
  constructor(options = {}) {
    this.baseUrl = (
      options.baseUrl ||
      process.env.KRUSCH_GIT_URL ||
      DEFAULT_KRUSCH_GIT_URL
    ).replace(/\/+$/, '');
    this.apiKey =
      options.apiKey ||
      process.env.KRUSCH_GIT_API_KEY ||
      process.env.API_KEY ||
      '';
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
  }

  /**
   * @returns {boolean}
   */
  isConfigured() {
    return Boolean(this.baseUrl);
  }

  /**
   * Internal HTTP helper with AbortController timeout and optional API key header.
   */
  async _request(
    endpoint,
    { method = 'GET', queryParams = undefined, body = undefined, headers = {} } = {}
  ) {
    const urlObj = new URL(`${this.baseUrl}${endpoint}`);
    if (queryParams && typeof queryParams === 'object') {
      for (const [key, val] of Object.entries(queryParams)) {
        if (val !== undefined && val !== null && val !== '') {
          urlObj.searchParams.set(key, String(val));
        }
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const reqHeaders = {
        Accept: 'application/json',
        ...headers,
      };
      if (this.apiKey) {
        reqHeaders['x-api-key'] = this.apiKey;
      }

      let requestBody;
      if (body !== undefined) {
        reqHeaders['Content-Type'] = 'application/json';
        requestBody = JSON.stringify(body);
      }

      const res = await this.fetchImpl(urlObj.toString(), {
        method,
        headers: reqHeaders,
        body: requestBody,
        signal: controller.signal,
      });

      const text = await res.text();
      let parsed = null;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = { raw: text };
        }
      }

      if (!res.ok) {
        const msg =
          parsed?.error ||
          parsed?.message ||
          res.statusText ||
          'KruschGit API request failed';
        const err = new Error(`KruschGit API Error (${res.status}): ${msg}`);
        err.status = res.status;
        err.details = parsed;
        throw err;
      }

      return parsed;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * GET /api/health
   */
  async health() {
    return this._request('/api/health', { method: 'GET' });
  }

  /**
   * GET /api/repos
   */
  async listRepos() {
    return this._request('/api/repos', { method: 'GET' });
  }

  /**
   * POST /api/repos
   */
  async createRepo({ name, description = '' } = {}) {
    if (!name || typeof name !== 'string') {
      throw new Error('KruschGitClient.createRepo: name is required');
    }
    return this._request('/api/repos', {
      method: 'POST',
      body: { name: name.trim(), description },
    });
  }

  /**
   * GET /api/repos/:id/tree or /api/repos/:id/tree/:treeId
   */
  async getTree({ repoId, treeId = undefined } = {}) {
    if (repoId === undefined || repoId === null || repoId === '') {
      throw new Error('KruschGitClient.getTree: repoId is required');
    }
    const safeRepo = encodeURIComponent(String(repoId));
    const pathSuffix = treeId ? `/${encodeURIComponent(String(treeId))}` : '';
    return this._request(`/api/repos/${safeRepo}/tree${pathSuffix}`, {
      method: 'GET',
    });
  }

  /**
   * GET /api/blobs/:id
   */
  async getBlob(blobId) {
    if (!blobId || typeof blobId !== 'string') {
      throw new Error('KruschGitClient.getBlob: blobId is required');
    }
    return this._request(`/api/blobs/${encodeURIComponent(blobId.trim())}`, {
      method: 'GET',
    });
  }

  /**
   * GET /api/blobs/:id/symbols
   */
  async getBlobSymbols(blobId) {
    if (!blobId || typeof blobId !== 'string') {
      throw new Error('KruschGitClient.getBlobSymbols: blobId is required');
    }
    return this._request(
      `/api/blobs/${encodeURIComponent(blobId.trim())}/symbols`,
      { method: 'GET' }
    );
  }

  /**
   * GET /api/search?q=...&repo=...&type=...&limit=...
   */
  async searchCode({
    query,
    repo = undefined,
    type = 'hybrid',
    limit = 10,
  } = {}) {
    if (!query || typeof query !== 'string' || !query.trim()) {
      throw new Error('KruschGitClient.searchCode: non-empty query is required');
    }
    return this._request('/api/search', {
      method: 'GET',
      queryParams: {
        q: query.trim(),
        ...(repo !== undefined && repo !== null ? { repo } : {}),
        type,
        limit,
      },
    });
  }

  /**
   * GET /api/symbols?q=...&repo=...&type=...&limit=...
   */
  async searchSymbols({
    query,
    repo = undefined,
    symbolType = undefined,
    limit = 10,
  } = {}) {
    if (!query || typeof query !== 'string' || !query.trim()) {
      throw new Error(
        'KruschGitClient.searchSymbols: non-empty query is required'
      );
    }
    return this._request('/api/symbols', {
      method: 'GET',
      queryParams: {
        q: query.trim(),
        ...(repo !== undefined && repo !== null ? { repo } : {}),
        ...(symbolType ? { type: symbolType } : {}),
        limit,
      },
    });
  }

  /**
   * GET /api/graph?repo=...&file=...&symbol=...
   */
  async getDependencyGraph({
    repo = undefined,
    file = undefined,
    symbol = undefined,
  } = {}) {
    if (!file && !symbol) {
      throw new Error(
        'KruschGitClient.getDependencyGraph: either file or symbol is required'
      );
    }
    return this._request('/api/graph', {
      method: 'GET',
      queryParams: {
        ...(repo !== undefined && repo !== null ? { repo } : {}),
        ...(file ? { file } : {}),
        ...(symbol ? { symbol } : {}),
      },
    });
  }
}

/**
 * Factory helper for KruschGitClient.
 * @param {ConstructorParameters<typeof KruschGitClient>[0]} [options]
 * @returns {KruschGitClient}
 */
export function createKruschGitClient(options = {}) {
  return new KruschGitClient(options);
}
