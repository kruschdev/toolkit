/**
 * @krusch/toolkit/hydradb — HydraDB v2 Runtime API Client & Context Connector
 *
 * Wraps the HydraDB v2 REST API (https://api.hydradb.com, API-Version: 2)
 * for multi-tenant database provisioning, multipart/JSON context ingestion
 * (memories & app_knowledge with explicit graph relations.ids), hybrid + graph
 * context retrieval (/query), ontology/subgraph inspection, non-throwing
 * agent feedback (/feedback), and constant-time HMAC-SHA256 webhook verification.
 */

import crypto from 'node:crypto';
import { okEnvelope, errorEnvelope } from './http.js';

export const DEFAULT_HYDRADB_BASE_URL = 'https://api.hydradb.com';
export const HYDRADB_API_VERSION = '2';
export const RETRYABLE_HYDRADB_STATUS_CODES = Object.freeze([429, 500, 502, 503]);

/**
 * Constant-time HMAC-SHA256 verification for HydraDB webhook notifications.
 * Header format: X-HydraDB-Signature: sha256=<lowercase hex digest>
 *
 * @param {string | Buffer | Uint8Array} rawBody
 * @param {string} signatureHeader
 * @param {string} signingSecret
 * @param {{ tool?: string }} [options]
 */
export function verifyHydraWebhookSignature(
  rawBody,
  signatureHeader,
  signingSecret,
  { tool = 'hydradb.webhook' } = {}
) {
  if (typeof signingSecret !== 'string' || signingSecret.trim().length === 0) {
    return errorEnvelope(
      'HYDRADB_WEBHOOK_SECRET_MISSING',
      'HydraDB webhook signing secret is required.',
      null,
      tool
    );
  }
  if (typeof signatureHeader !== 'string' || signatureHeader.trim().length === 0) {
    return errorEnvelope(
      'HYDRADB_WEBHOOK_SIGNATURE_MISSING',
      'Missing X-HydraDB-Signature header.',
      null,
      tool
    );
  }
  if (
    typeof rawBody !== 'string' &&
    !Buffer.isBuffer(rawBody) &&
    !(rawBody instanceof Uint8Array)
  ) {
    return errorEnvelope(
      'HYDRADB_WEBHOOK_BODY_INVALID',
      'Raw webhook body must be a string, Buffer, or Uint8Array.',
      null,
      tool
    );
  }

  const trimmedHeader = signatureHeader.trim();
  const match = /^sha256=([0-9a-f]{64})$/i.exec(trimmedHeader);
  if (!match) {
    return errorEnvelope(
      'HYDRADB_WEBHOOK_SIGNATURE_MALFORMED',
      'X-HydraDB-Signature must match sha256=<64-char hex digest>.',
      null,
      tool
    );
  }

  const providedHex = match[1].toLowerCase();
  const bodyBuffer =
    typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : Buffer.from(rawBody);
  const expectedHex = crypto
    .createHmac('sha256', signingSecret)
    .update(bodyBuffer)
    .digest('hex');

  const providedBuf = Buffer.from(providedHex, 'hex');
  const expectedBuf = Buffer.from(expectedHex, 'hex');
  if (
    providedBuf.length !== expectedBuf.length ||
    !crypto.timingSafeEqual(providedBuf, expectedBuf)
  ) {
    return errorEnvelope(
      'HYDRADB_WEBHOOK_SIGNATURE_MISMATCH',
      'HydraDB webhook HMAC-SHA256 signature verification failed.',
      null,
      tool
    );
  }

  return okEnvelope(tool, 'HydraDB webhook signature verified.', {
    verified: true,
    algorithm: 'hmac-sha256',
  });
}

/**
 * Formats a HydraDB /query result payload into a compact grounding string
 * with chunk citations, multi-hop graph paths, and additional context.
 * Mirrors the official HydraDB SDK's buildString(result) helper.
 *
 * @param {object} queryResult
 * @param {{ includeGraphPaths?: boolean, includeAdditionalContext?: boolean, maxChunks?: number }} [options]
 * @returns {string}
 */
export function buildHydraContextString(
  queryResult,
  {
    includeGraphPaths = true,
    includeAdditionalContext = true,
    maxChunks = 10,
  } = {}
) {
  if (!queryResult || typeof queryResult !== 'object') {
    return '';
  }

  const data =
    queryResult.data && typeof queryResult.data === 'object' && !Array.isArray(queryResult.data)
      ? queryResult.data
      : queryResult;

  const chunks = Array.isArray(data.chunks) ? data.chunks : [];
  const sources = Array.isArray(data.sources) ? data.sources : [];
  const sourceById = new Map();
  for (const src of sources) {
    if (src && typeof src === 'object' && src.id) {
      sourceById.set(String(src.id), src);
    }
  }

  const sections = [];
  const boundedMax = Number.isInteger(maxChunks) && maxChunks > 0 ? maxChunks : 10;
  const slice = chunks.slice(0, boundedMax);

  if (slice.length > 0) {
    const chunkLines = slice.map((chunk, idx) => {
      const sourceId = chunk?.source_id || chunk?.sourceId || chunk?.id || `chunk-${idx + 1}`;
      const srcMeta = sourceById.get(String(sourceId));
      const title =
        chunk?.title ||
        srcMeta?.title ||
        chunk?.metadata?.title ||
        sourceId;
      const score =
        typeof chunk?.score === 'number' && Number.isFinite(chunk.score)
          ? ` (score=${chunk.score.toFixed(3)})`
          : '';
      const text = String(chunk?.text ?? chunk?.content ?? '').trim();
      return `[${idx + 1}] ${title} [source=${sourceId}]${score}\n${text}`;
    });
    sections.push(`### Retrieved Chunks (${slice.length})\n${chunkLines.join('\n\n')}`);
  }

  if (includeGraphPaths && data.graph_context && typeof data.graph_context === 'object') {
    const queryPaths = Array.isArray(data.graph_context.query_paths)
      ? data.graph_context.query_paths
      : [];
    const chunkRelations = Array.isArray(data.graph_context.chunk_relations)
      ? data.graph_context.chunk_relations
      : [];
    const graphLines = [];
    for (const p of queryPaths) {
      if (typeof p === 'string' && p.trim()) {
        graphLines.push(`- ${p.trim()}`);
      } else if (p && typeof p === 'object') {
        const formatted = p.path || p.summary || JSON.stringify(p);
        graphLines.push(`- ${formatted}`);
      }
    }
    for (const rel of chunkRelations) {
      if (rel && typeof rel === 'object') {
        const from = rel.source || rel.from || rel.subject || '';
        const edge = rel.relation || rel.type || rel.predicate || 'RELATED_TO';
        const to = rel.target || rel.to || rel.object || '';
        if (from || to) {
          graphLines.push(`- ${from} --[${edge}]--> ${to}`);
        }
      }
    }
    if (graphLines.length > 0) {
      sections.push(`### Knowledge Graph Context\n${graphLines.join('\n')}`);
    }
  }

  if (
    includeAdditionalContext &&
    data.additional_context &&
    typeof data.additional_context === 'object' &&
    Object.keys(data.additional_context).length > 0
  ) {
    sections.push(
      `### Additional Context\n${JSON.stringify(data.additional_context, null, 2)}`
    );
  }

  return sections.join('\n\n');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class HydraDbClient {
  /**
   * @param {object} [options]
   * @param {string} [options.apiKey]
   * @param {string} [options.baseUrl]
   * @param {string} [options.database]
   * @param {string} [options.collection]
   * @param {number} [options.timeoutMs]
   * @param {number} [options.maxRetries]
   * @param {number} [options.retryDelayMs]
   * @param {typeof fetch} [options.fetchImpl]
   */
  constructor(options = {}) {
    this.apiKey = options.apiKey || process.env.HYDRADB_API_KEY || '';
    this.baseUrl = (
      options.baseUrl ||
      process.env.HYDRADB_BASE_URL ||
      DEFAULT_HYDRADB_BASE_URL
    ).replace(/\/+$/, '');
    this.database =
      options.database || process.env.HYDRADB_DATABASE || 'krusch_context';
    this.collection =
      options.collection || process.env.HYDRADB_COLLECTION || 'default';
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 250;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
  }

  /**
   * @returns {boolean}
   */
  isConfigured() {
    return Boolean(this.apiKey && this.baseUrl);
  }

  /**
   * Internal v2 HTTP request helper with API-Version: 2, Bearer auth,
   * bounded retry on transient status codes (429, 500, 502, 503), and
   * standard HydraDB v2 envelope unwrapping.
   */
  async _request(
    endpoint,
    {
      method = 'GET',
      body = undefined,
      formData = undefined,
      queryParams = undefined,
      headers = {},
      rawResponseEnvelope = false,
    } = {}
  ) {
    if (!this.apiKey) {
      throw new Error(
        'HydraDBClient: missing apiKey (pass options.apiKey or set HYDRADB_API_KEY)'
      );
    }

    const urlObj = new URL(`${this.baseUrl}${endpoint}`);
    if (queryParams && typeof queryParams === 'object') {
      for (const [key, val] of Object.entries(queryParams)) {
        if (val !== undefined && val !== null && val !== '') {
          urlObj.searchParams.set(key, String(val));
        }
      }
    }

    let attempt = 0;
    while (true) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const reqHeaders = {
          Authorization: `Bearer ${this.apiKey}`,
          'API-Version': HYDRADB_API_VERSION,
          Accept: 'application/json',
          ...headers,
        };

        let requestBody;
        if (formData !== undefined) {
          requestBody = formData;
        } else if (body !== undefined) {
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

        const headerRequestId =
          res.headers?.get?.('x-request-id') ||
          res.headers?.get?.('X-Request-ID') ||
          null;
        const metaRequestId = parsed?.meta?.request_id || headerRequestId;

        if (!res.ok || (parsed && parsed.success === false)) {
          const canRetry =
            attempt < this.maxRetries &&
            RETRYABLE_HYDRADB_STATUS_CODES.includes(res.status);
          if (canRetry) {
            attempt += 1;
            await sleep(this.retryDelayMs * 2 ** (attempt - 1));
            continue;
          }

          const errCode =
            parsed?.error?.code ||
            parsed?.error_code ||
            parsed?.code ||
            `HTTP_${res.status}`;
          const errMsg =
            parsed?.error?.message ||
            parsed?.message ||
            (typeof parsed?.error === 'string' ? parsed.error : null) ||
            res.statusText ||
            'HydraDB request failed';

          const err = new Error(
            `HydraDB API Error (${res.status} ${errCode}): ${errMsg}`
          );
          err.status = res.status;
          err.code = errCode;
          err.requestId = metaRequestId;
          err.details = parsed;
          throw err;
        }

        if (rawResponseEnvelope) {
          return parsed;
        }

        if (
          parsed &&
          typeof parsed === 'object' &&
          Object.hasOwn(parsed, 'success') &&
          Object.hasOwn(parsed, 'data')
        ) {
          if (
            parsed.data &&
            typeof parsed.data === 'object' &&
            !Array.isArray(parsed.data) &&
            parsed.meta
          ) {
            return {
              ...parsed.data,
              _meta: parsed.meta,
            };
          }
          return parsed.data;
        }

        return parsed;
      } finally {
        clearTimeout(timer);
      }
    }
  }

  /**
   * Create a new tenant database with optional metadata schema.
   * POST /databases
   */
  async createDatabase({ database = this.database, metadataSchema = undefined } = {}) {
    if (!database || typeof database !== 'string') {
      throw new Error('HydraDbClient.createDatabase: database name is required');
    }
    const payload = { database };
    if (metadataSchema && typeof metadataSchema === 'object') {
      payload.database_metadata_schema = metadataSchema;
    }
    return this._request('/databases', {
      method: 'POST',
      body: payload,
    });
  }

  /**
   * Get tenant database provisioning status.
   * GET /databases/status?database=...
   */
  async getDatabaseStatus({ database = this.database } = {}) {
    if (!database || typeof database !== 'string') {
      throw new Error('HydraDbClient.getDatabaseStatus: database name is required');
    }
    return this._request('/databases/status', {
      method: 'GET',
      queryParams: { database },
    });
  }

  /**
   * Poll GET /databases/status until infra.ready_for_ingestion === true.
   */
  async waitForDatabaseReady({
    database = this.database,
    pollIntervalMs = 500,
    timeoutMs = 30_000,
  } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      const status = await this.getDatabaseStatus({ database });
      const ready =
        status?.infra?.ready_for_ingestion === true ||
        status?.infra?.readyForIngestion === true ||
        status?.ready_for_ingestion === true ||
        status?.readyForIngestion === true;
      if (ready) {
        return status;
      }
      if (Date.now() + pollIntervalMs > deadline) {
        break;
      }
      await sleep(pollIntervalMs);
    }
    const err = new Error(
      `HydraDbClient.waitForDatabaseReady: database "${database}" not ready within ${timeoutMs}ms`
    );
    err.code = 'TENANT_INFRA_NOT_READY';
    throw err;
  }

  /**
   * List databases in the tenant account.
   * GET /databases
   */
  async listDatabases() {
    return this._request('/databases', { method: 'GET' });
  }

  /**
   * List collections inside a database.
   * GET /databases/collections?database=...
   */
  async listCollections({ database = this.database } = {}) {
    return this._request('/databases/collections', {
      method: 'GET',
      queryParams: { database },
    });
  }

  /**
   * Get storage and graph statistics for a database.
   * GET /databases/stats?database=...
   */
  async getDatabaseStats({ database = this.database } = {}) {
    return this._request('/databases/stats', {
      method: 'GET',
      queryParams: { database },
    });
  }

  /**
   * Delete a database.
   * DELETE /databases?database=...
   */
  async deleteDatabase({ database } = {}) {
    if (!database || typeof database !== 'string') {
      throw new Error('HydraDbClient.deleteDatabase: explicit database name is required');
    }
    return this._request('/databases', {
      method: 'DELETE',
      queryParams: { database },
    });
  }

  /**
   * Ingest structured memories into HydraDB using multipart FormData.
   * POST /context/ingest (type = "memory")
   *
   * @param {Array<object>} memories
   * @param {{ database?: string, collection?: string, upsert?: boolean }} [options]
   */
  async ingestMemories(
    memories,
    {
      database = this.database,
      collection = this.collection,
      upsert = true,
    } = {}
  ) {
    if (!Array.isArray(memories) || memories.length === 0) {
      throw new Error('HydraDbClient.ingestMemories: memories must be a non-empty array');
    }

    const normalized = memories.map((item, idx) => {
      if (!item || typeof item !== 'object') {
        throw new Error(`HydraDbClient.ingestMemories: item at index ${idx} must be an object`);
      }
      const text = String(item.text ?? item.content ?? '').trim();
      if (!text) {
        throw new Error(`HydraDbClient.ingestMemories: item at index ${idx} is missing text`);
      }
      return {
        ...(item.id ? { id: String(item.id) } : {}),
        ...(item.title ? { title: String(item.title) } : {}),
        text,
        is_markdown: item.is_markdown ?? item.isMarkdown ?? true,
        infer: item.infer ?? true,
        ...(item.custom_instructions || item.customInstructions
          ? { custom_instructions: String(item.custom_instructions || item.customInstructions) }
          : {}),
        ...(item.user_name || item.userName
          ? { user_name: String(item.user_name || item.userName) }
          : {}),
        ...(item.metadata && typeof item.metadata === 'object'
          ? { metadata: item.metadata }
          : {}),
        ...(item.additional_metadata && typeof item.additional_metadata === 'object'
          ? { additional_metadata: item.additional_metadata }
          : {}),
      };
    });

    const form = new FormData();
    form.set('type', 'memory');
    form.set('database', database);
    if (collection) {
      form.set('collection', collection);
    }
    form.set('upsert', upsert ? 'true' : 'false');
    form.set('memories', JSON.stringify(normalized));

    return this._request('/context/ingest', {
      method: 'POST',
      formData: form,
    });
  }

  /**
   * Ingest structured app_knowledge records (with explicit relations.ids graph edges)
   * into HydraDB using multipart FormData.
   * POST /context/ingest (type = "knowledge")
   *
   * @param {Array<object>} items
   * @param {{ database?: string, collection?: string, upsert?: boolean }} [options]
   */
  async ingestAppKnowledge(
    items,
    {
      database = this.database,
      collection = this.collection,
      upsert = true,
    } = {}
  ) {
    if (!Array.isArray(items) || items.length === 0) {
      throw new Error('HydraDbClient.ingestAppKnowledge: items must be a non-empty array');
    }

    const normalized = items.map((item, idx) => {
      if (!item || typeof item !== 'object') {
        throw new Error(`HydraDbClient.ingestAppKnowledge: item at index ${idx} must be an object`);
      }
      const text = String(
        item.content?.text ?? item.text ?? item.content ?? ''
      ).trim();
      if (!text) {
        throw new Error(`HydraDbClient.ingestAppKnowledge: item at index ${idx} is missing text`);
      }

      const relationIds = Array.isArray(item.relations?.ids)
        ? item.relations.ids.map(String).filter(Boolean)
        : Array.isArray(item.relationIds)
          ? item.relationIds.map(String).filter(Boolean)
          : [];

      const record = {
        ...(item.id ? { id: String(item.id) } : {}),
        database: item.database || database,
        collection: item.collection || collection,
        title: String(item.title || item.id || `knowledge-${idx + 1}`),
        type: String(item.type || 'document'),
        ...(item.url ? { url: String(item.url) } : {}),
        timestamp: item.timestamp || new Date().toISOString(),
        content: { text },
        ...(item.tenant_metadata && typeof item.tenant_metadata === 'object'
          ? { tenant_metadata: item.tenant_metadata }
          : {}),
        ...(item.additional_metadata && typeof item.additional_metadata === 'object'
          ? { additional_metadata: item.additional_metadata }
          : {}),
      };

      if (relationIds.length > 0 || (item.relations && typeof item.relations === 'object')) {
        record.relations = {
          ids: relationIds,
          ...(item.relations?.properties && typeof item.relations.properties === 'object'
            ? { properties: item.relations.properties }
            : {}),
        };
      }

      return record;
    });

    const form = new FormData();
    form.set('type', 'knowledge');
    form.set('database', database);
    if (collection) {
      form.set('collection', collection);
    }
    form.set('upsert', upsert ? 'true' : 'false');
    form.set('app_knowledge', JSON.stringify(normalized));

    return this._request('/context/ingest', {
      method: 'POST',
      formData: form,
    });
  }

  /**
   * Check indexing status for ingested context IDs.
   * GET /context/status?database=...&collection=...&ids=...
   * Flags FILE_NOT_FOUND scope misses per HydraDB v2 operational rules.
   */
  async getContextStatus({
    ids,
    database = this.database,
    collection = this.collection,
  } = {}) {
    const idList = Array.isArray(ids)
      ? ids.map(String).filter(Boolean)
      : typeof ids === 'string' && ids.trim()
        ? ids.split(',').map((s) => s.trim()).filter(Boolean)
        : [];
    if (idList.length === 0) {
      throw new Error('HydraDbClient.getContextStatus: ids must be a non-empty array or string');
    }

    const data = await this._request('/context/status', {
      method: 'GET',
      queryParams: {
        database,
        ...(collection ? { collection } : {}),
        ids: idList.join(','),
      },
    });

    const items = Array.isArray(data?.items)
      ? data.items
      : Array.isArray(data?.statuses)
        ? data.statuses
        : Array.isArray(data)
          ? data
          : [];

    const scopeMissIds = [];
    for (const entry of items) {
      if (
        entry &&
        typeof entry === 'object' &&
        (entry.error_code === 'FILE_NOT_FOUND' || entry.errorCode === 'FILE_NOT_FOUND')
      ) {
        scopeMissIds.push(entry.id || entry.source_id || 'unknown');
      }
    }

    if (data && typeof data === 'object' && !Array.isArray(data)) {
      return {
        ...data,
        scopeMissDetected: scopeMissIds.length > 0,
        scopeMissIds,
      };
    }

    return {
      items,
      scopeMissDetected: scopeMissIds.length > 0,
      scopeMissIds,
    };
  }

  /**
   * Poll GET /context/status until all requested IDs reach a searchable state
   * ('graph_creation' or 'completed') or throw on terminal error / scope miss.
   */
  async waitForIndexing({
    ids,
    database = this.database,
    collection = this.collection,
    pollIntervalMs = 500,
    timeoutMs = 30_000,
    requireCompleted = false,
  } = {}) {
    const searchableStates = requireCompleted
      ? new Set(['completed'])
      : new Set(['graph_creation', 'completed']);
    const terminalErrorStates = new Set(['errored', 'failed']);

    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      const statusReport = await this.getContextStatus({ ids, database, collection });
      if (statusReport.scopeMissDetected) {
        const err = new Error(
          `HydraDbClient.waitForIndexing: FILE_NOT_FOUND scope mismatch for IDs [${statusReport.scopeMissIds.join(', ')}] in database="${database}" collection="${collection}"`
        );
        err.code = 'FILE_NOT_FOUND';
        err.scopeMissIds = statusReport.scopeMissIds;
        throw err;
      }

      const items = Array.isArray(statusReport.items) ? statusReport.items : [];
      const failed = items.filter((item) =>
        terminalErrorStates.has(String(item?.status || '').toLowerCase())
      );
      if (failed.length > 0) {
        const err = new Error(
          `HydraDbClient.waitForIndexing: indexing failed for ${failed.map((f) => f.id || 'unknown').join(', ')}`
        );
        err.code = 'HYDRADB_INDEXING_FAILED';
        err.failedItems = failed;
        throw err;
      }

      if (
        items.length > 0 &&
        items.every((item) =>
          searchableStates.has(String(item?.status || '').toLowerCase())
        )
      ) {
        return statusReport;
      }

      if (Date.now() + pollIntervalMs > deadline) {
        break;
      }
      await sleep(pollIntervalMs);
    }

    const err = new Error(
      `HydraDbClient.waitForIndexing: timed out after ${timeoutMs}ms waiting for indexing`
    );
    err.code = 'HYDRADB_INDEXING_TIMEOUT';
    throw err;
  }

  /**
   * Execute a hybrid + knowledge-graph retrieval query against HydraDB.
   * POST /query
   */
  async queryContext({
    query,
    database = this.database,
    collection = this.collection,
    collections = undefined,
    type = 'all',
    queryBy = 'hybrid',
    operator = undefined,
    mode = 'thinking',
    maxResults = 10,
    alpha = undefined,
    recencyBias = undefined,
    graphContext = true,
    queryForcefulRelations = true,
    additionalContext = undefined,
    metadataFilters = undefined,
    queryApps = undefined,
    acl = undefined,
  } = {}) {
    if (!query || typeof query !== 'string' || !query.trim()) {
      throw new Error('HydraDbClient.queryContext: non-empty query string is required');
    }

    const payload = {
      database,
      query: query.trim(),
      type,
      query_by: queryBy,
      mode,
      max_results: maxResults,
      graph_context: Boolean(graphContext),
      query_forceful_relations: Boolean(queryForcefulRelations),
    };

    if (Array.isArray(collections) && collections.length > 0) {
      payload.collections = collections;
    } else if (collection) {
      payload.collection = collection;
    }
    if (operator) payload.operator = operator;
    if (typeof alpha === 'number') payload.alpha = alpha;
    if (typeof recencyBias === 'number') payload.recency_bias = recencyBias;
    if (additionalContext && typeof additionalContext === 'object') {
      payload.additional_context = additionalContext;
    }
    if (metadataFilters && typeof metadataFilters === 'object') {
      payload.metadata_filters = metadataFilters;
    }
    if (Array.isArray(queryApps)) payload.query_apps = queryApps;
    if (acl && typeof acl === 'object') payload.acl = acl;

    const result = await this._request('/query', {
      method: 'POST',
      body: payload,
    });

    return {
      ...result,
      contextString: buildHydraContextString(result),
    };
  }

  /**
   * List ingested context sources.
   * POST /context/list
   */
  async listContext({
    database = this.database,
    collection = this.collection,
    type = 'all',
    limit = 50,
    cursor = undefined,
    metadataFilters = undefined,
  } = {}) {
    return this._request('/context/list', {
      method: 'POST',
      body: {
        database,
        ...(collection ? { collection } : {}),
        type,
        limit,
        ...(cursor ? { cursor } : {}),
        ...(metadataFilters ? { metadata_filters: metadataFilters } : {}),
      },
    });
  }

  /**
   * Inspect a specific context source and its chunks.
   * GET /context/inspect
   */
  async inspectContext({
    id,
    database = this.database,
    collection = this.collection,
    type = 'knowledge',
  } = {}) {
    if (!id || typeof id !== 'string') {
      throw new Error('HydraDbClient.inspectContext: id is required');
    }
    return this._request('/context/inspect', {
      method: 'GET',
      queryParams: {
        database,
        ...(collection ? { collection } : {}),
        id,
        type,
      },
    });
  }

  /**
   * Patch metadata on an existing context source.
   * PATCH /context/{id}/metadata
   */
  async updateSourceMetadata(
    id,
    {
      database = this.database,
      collection = this.collection,
      metadata = {},
      additionalMetadata = undefined,
    } = {}
  ) {
    if (!id || typeof id !== 'string') {
      throw new Error('HydraDbClient.updateSourceMetadata: id is required');
    }
    return this._request(`/context/${encodeURIComponent(id)}/metadata`, {
      method: 'PATCH',
      body: {
        database,
        ...(collection ? { collection } : {}),
        metadata,
        ...(additionalMetadata ? { additional_metadata: additionalMetadata } : {}),
      },
    });
  }

  /**
   * Retrieve explicit and inferred relations for a context source.
   * GET /context/relations
   */
  async getRelations({
    id,
    database = this.database,
    collection = this.collection,
    type = 'knowledge',
    limit = 500,
    cursor = undefined,
  } = {}) {
    if (!id || typeof id !== 'string') {
      throw new Error('HydraDbClient.getRelations: id is required');
    }
    return this._request('/context/relations', {
      method: 'GET',
      queryParams: {
        database,
        ...(collection ? { collection } : {}),
        id,
        type,
        limit,
        ...(cursor ? { cursor } : {}),
      },
    });
  }

  /**
   * Retrieve the local entity/chunk subgraph for a context source.
   * GET /context/{id}/subgraph
   */
  async getSubgraph(
    id,
    {
      database = this.database,
      collection = this.collection,
    } = {}
  ) {
    if (!id || typeof id !== 'string') {
      throw new Error('HydraDbClient.getSubgraph: id is required');
    }
    return this._request(`/context/${encodeURIComponent(id)}/subgraph`, {
      method: 'GET',
      queryParams: {
        database,
        ...(collection ? { collection } : {}),
      },
    });
  }

  /**
   * Delete context records by ID.
   * DELETE /context
   */
  async deleteContext({
    ids,
    type = 'knowledge',
    database = this.database,
    collection = this.collection,
  } = {}) {
    const idList = Array.isArray(ids) ? ids.map(String).filter(Boolean) : [];
    if (idList.length === 0) {
      throw new Error('HydraDbClient.deleteContext: ids must be a non-empty array');
    }
    return this._request('/context', {
      method: 'DELETE',
      body: {
        database,
        ...(collection ? { collection } : {}),
        type,
        ids: idList,
      },
    });
  }

  /**
   * Submit retrieval quality feedback (POST /feedback).
   * Per HydraDB v2 Agent Integration Rules, feedback submission is strictly
   * non-throwing (fire-and-forget safe) so telemetry never breaks agent turns.
   */
  async submitFeedback({
    requestId,
    feedback = '',
    rating = 'neutral',
    source = 'agent',
    database = this.database,
    collection = this.collection,
    groundTruth = undefined,
    metadata = undefined,
  } = {}) {
    try {
      if (!requestId || typeof requestId !== 'string') {
        return {
          submitted: false,
          error: 'Missing requestId for HydraDB feedback',
        };
      }
      const payload = {
        request_id: requestId,
        rating,
        source,
        database,
        ...(collection ? { collection } : {}),
        ...(feedback ? { feedback } : {}),
        ...(groundTruth && typeof groundTruth === 'object'
          ? { ground_truth: groundTruth }
          : {}),
        ...(metadata && typeof metadata === 'object' ? { metadata } : {}),
      };
      const data = await this._request('/feedback', {
        method: 'POST',
        body: payload,
      });
      return {
        submitted: true,
        data,
      };
    } catch (err) {
      return {
        submitted: false,
        error: err.message,
      };
    }
  }
}

/**
 * Factory helper for HydraDbClient.
 * @param {ConstructorParameters<typeof HydraDbClient>[0]} [options]
 * @returns {HydraDbClient}
 */
export function createHydraDbClient(options = {}) {
  return new HydraDbClient(options);
}
