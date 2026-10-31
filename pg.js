/**
 * @module @krusch/toolkit/pg
 * Standardized PostgreSQL connection pool, transactional helper, idempotent SQL migration runner,
 * and SQL-injection-guarded pgvector cosine similarity search brick.
 */

import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { setupLogging } from './log.js';
import { validateVectorDimension } from './embeddings.js';

const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Validate a PostgreSQL table or column identifier against SQL injection.
 *
 * @param {string} name
 * @param {string} [label='identifier']
 * @returns {string}
 */
export function assertSafePgIdentifier(name, label = 'identifier') {
  if (typeof name !== 'string' || !IDENT_RE.test(name)) {
    throw new Error(`[pg] Unsafe SQL ${label}: "${String(name)}". Must match ${IDENT_RE}.`);
  }
  return name;
}

/**
 * Resolve a PostgreSQL connection string from explicit URL, `DATABASE_URL`, or URI-encoded components.
 *
 * @param {object | string} [dbConfig={}]
 * @returns {string}
 */
export function buildPgConnectionString(dbConfig = {}) {
  if (typeof dbConfig === 'string' && dbConfig.trim().length > 0) {
    return dbConfig.trim();
  }

  const cfg = dbConfig && typeof dbConfig === 'object' ? dbConfig : {};
  const directUrl = cfg.url || cfg.connectionString;
  if (typeof directUrl === 'string' && directUrl.trim().length > 0) {
    return directUrl.trim();
  }

  const hasExplicitComponents =
    cfg.host !== undefined ||
    cfg.port !== undefined ||
    cfg.user !== undefined ||
    cfg.password !== undefined ||
    cfg.database !== undefined;

  if (
    !hasExplicitComponents &&
    typeof process.env.DATABASE_URL === 'string' &&
    process.env.DATABASE_URL.trim().length > 0
  ) {
    return process.env.DATABASE_URL.trim();
  }

  const rawHost = String(cfg.host ?? '127.0.0.1').trim() || '127.0.0.1';
  const host = rawHost.includes(':') && !rawHost.startsWith('[') ? `[${rawHost}]` : rawHost;
  const parsedPort = Number(cfg.port ?? 5432);
  const port = Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535 ? parsedPort : 5432;
  const user = String(cfg.user ?? 'postgres');
  const password = String(cfg.password ?? '');
  const database = String(cfg.database ?? 'postgres');

  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}`;
}

function resolvePgLogger(serviceName, logger, logDir) {
  if (logger) return logger;
  try {
    return setupLogging(serviceName, {
      logDir: logDir || path.join(os.tmpdir(), 'krusch-logs'),
      console: false,
    });
  } catch {
    return {
      info() {},
      debug() {},
      warn() {},
      error(msg, err) {
        console.error(`[${serviceName}] ${msg}`, err?.message || err || '');
      },
    };
  }
}

/**
 * Create a standardized `pg.Pool` wrapper with idle error guarding, timed query logging,
 * safe transactions, health checks, and idempotent shutdown.
 *
 * @param {object | string} [dbConfig={}]
 * @param {object} [options={}]
 * @returns {{ pool: object, query: Function, queryOne: Function, withTransaction: Function, healthCheck: Function, close: Function }}
 */
export function createPgPool(
  dbConfig = {},
  {
    serviceName = 'krusch-pg',
    max = 15,
    idleTimeoutMillis = 30000,
    connectionTimeoutMillis = 3000,
    PoolClass = null,
    logger = null,
    logDir = null,
    ssl = undefined,
  } = {}
) {
  const connectionString = buildPgConnectionString(dbConfig);
  const PoolImpl = PoolClass || pg.Pool;
  const log = resolvePgLogger(serviceName, logger, logDir);
  const effectiveSsl = ssl !== undefined ? ssl : dbConfig?.ssl;

  const pool = new PoolImpl({
    connectionString,
    max,
    idleTimeoutMillis,
    connectionTimeoutMillis,
    ...(effectiveSsl !== undefined ? { ssl: effectiveSsl } : {}),
  });

  pool.on?.('error', (err) => {
    log.error?.('Unexpected error on idle PostgreSQL client', err);
  });

  async function query(sql, params = []) {
    const start = Date.now();
    try {
      const res = await pool.query(sql, params);
      const durationMs = Date.now() - start;
      log.debug?.('Executed PostgreSQL query', {
        durationMs,
        rowCount: res?.rowCount ?? res?.rows?.length ?? 0,
      });
      return res;
    } catch (err) {
      const durationMs = Date.now() - start;
      const snippet = String(sql || '').replace(/\s+/g, ' ').trim().slice(0, 160);
      log.error?.('PostgreSQL query failed', {
        error: err,
        durationMs,
        sql: snippet,
      });
      const wrapped = new Error(
        `[${serviceName}] PostgreSQL query failed (${durationMs}ms): ${err?.message || String(err)} [sql="${snippet}"]`,
        { cause: err }
      );
      if (err?.code) wrapped.code = err.code;
      if (err?.detail) wrapped.detail = err.detail;
      throw wrapped;
    }
  }

  async function queryOne(sql, params = []) {
    const res = await query(sql, params);
    return res?.rows?.[0] ?? null;
  }

  async function withTransaction(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        log.error?.('PostgreSQL transaction rollback failed', rollbackErr);
      }
      throw err;
    } finally {
      client.release?.();
    }
  }

  async function healthCheck() {
    const start = Date.now();
    await pool.query('SELECT 1 AS ok');
    const latencyMs = Date.now() - start;
    return { ok: true, latencyMs };
  }

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    if (typeof pool.end === 'function') {
      await pool.end();
    }
  }

  return {
    pool,
    query,
    queryOne,
    withTransaction,
    healthCheck,
    close,
  };
}

function isSinglePgClient(pgWrapper) {
  if (!pgWrapper || typeof pgWrapper !== 'object') return false;
  if (typeof pg.Pool === 'function' && pgWrapper instanceof pg.Pool) return false;
  if (typeof pg.Client === 'function' && pgWrapper instanceof pg.Client) return true;
  if (typeof pgWrapper.release === 'function') return true;
  if (pgWrapper._connected === true || pgWrapper._connecting === true) return true;
  return false;
}

async function runInClientTransaction(pgWrapper, fn) {
  if (typeof pgWrapper?.withTransaction === 'function') {
    return await pgWrapper.withTransaction(fn);
  }
  if (!isSinglePgClient(pgWrapper) && typeof pgWrapper?.connect === 'function') {
    const client = await pgWrapper.connect();
    try {
      await client.query('BEGIN');
      const res = await fn(client);
      await client.query('COMMIT');
      return res;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve primary error
      }
      throw err;
    } finally {
      client.release?.();
    }
  }
  await pgWrapper.query('BEGIN');
  try {
    const res = await fn(pgWrapper);
    await pgWrapper.query('COMMIT');
    return res;
  } catch (err) {
    try {
      await pgWrapper.query('ROLLBACK');
    } catch {
      // Preserve primary error
    }
    throw err;
  }
}

/**
 * Run idempotent `{ id, sql }` schema migrations inside transactions and return an INV-LEGO-01 envelope.
 *
 * @param {{ query: Function, withTransaction?: Function, connect?: Function }} pgWrapper
 * @param {Array<{ id: string, sql: string }>} [migrations=[]]
 * @param {{ tableName?: string }} [options={}]
 * @returns {Promise<{ ok: true, tool: 'pg.migrate', summary: string, data: { applied: string[], skipped: string[] } }>}
 */
export async function runSqlMigrations(
  pgWrapper,
  migrations = [],
  { tableName = 'schema_migrations' } = {}
) {
  assertSafePgIdentifier(tableName, 'tableName');
  if (!pgWrapper || typeof pgWrapper.query !== 'function') {
    throw new Error('[pg.migrate] Valid pgWrapper with .query() is required.');
  }

  await pgWrapper.query(
    `CREATE TABLE IF NOT EXISTS ${tableName} (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`
  );

  const existingRes = await pgWrapper.query(`SELECT id FROM ${tableName}`);
  const appliedSet = new Set((existingRes?.rows || []).map((row) => String(row.id)));

  const applied = [];
  const skipped = [];

  for (const migration of migrations) {
    const migId = typeof migration?.id === 'string' ? migration.id.trim() : '';
    if (!migId) {
      throw new Error('[pg.migrate] Each migration must define a non-empty string "id".');
    }
    if (typeof migration?.sql !== 'string' || migration.sql.trim().length === 0) {
      throw new Error(`[pg.migrate] Migration "${migId}" must define a non-empty "sql" string.`);
    }

    if (appliedSet.has(migId)) {
      skipped.push(migId);
      continue;
    }

    await runInClientTransaction(pgWrapper, async (tx) => {
      await tx.query(migration.sql);
      await tx.query(`INSERT INTO ${tableName} (id) VALUES ($1)`, [migId]);
    });

    appliedSet.add(migId);
    applied.push(migId);
  }

  return {
    ok: true,
    tool: 'pg.migrate',
    summary: `Applied ${applied.length} migration(s), skipped ${skipped.length}`,
    data: { applied, skipped },
  };
}

/**
 * Validate a SQL WHERE predicate fragment against stacked queries, SQL comments, UNION/INTO,
 * dollar-quoting, and unbalanced-parenthesis breakout (`INV-LEGO-04` / SQLi defense).
 *
 * @param {string} whereSql
 * @returns {string}
 */
const DISALLOWED_WHERE_KEYWORDS_RE =
  /(?<![a-zA-Z0-9_$\u0080-\uffff])(?:SELECT|TABLE|VALUES|WITH(?!\s+TIME\s+ZONE(?![a-zA-Z0-9_$\u0080-\uffff]))|UNION|INTERSECT|EXCEPT|INTO|COPY|INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|EXECUTE|PREPARE|DEALLOCATE|CALL|DO|SET|SHOW|RESET|DISCARD|FETCH|MOVE|DECLARE|CLOSE|LOCK|LISTEN|UNLISTEN|NOTIFY|LOAD|VACUUM|ANALYZE|EXPLAIN|CLUSTER|REINDEX|REFRESH|CHECKPOINT|COMMENT|SECURITY|PG_NOTIFY|SET_CONFIG|CURRENT_SETTING|CURRENT_USER|SESSION_USER|SYSTEM_USER|USER|CURRENT_ROLE|CURRENT_DATABASE|CURRENT_SCHEMA|CURRENT_CATALOG|REGCLASS|REGPROC|REGPROCEDURE|REGOPER|REGOPERATOR|REGTYPE|REGROLE|REGNAMESPACE|REGCONFIG|REGDICTIONARY|PG_SLEEP|PG_READ_FILE|PG_READ_BINARY_FILE|PG_LS_DIR|PG_STAT_FILE|PG_TERMINATE_BACKEND|PG_CANCEL_BACKEND|PG_RELOAD_CONF|PG_ROTATE_LOGFILE|PG_ADVISORY_LOCK|PG_ADVISORY_XACT_LOCK|LO_IMPORT|LO_EXPORT|DBLINK|QUERY_TO_XML|QUERY_TO_XMLSCHEMA|QUERY_TO_XML_AND_XMLSCHEMA|TABLE_TO_XML|TABLE_TO_XMLSCHEMA|TABLE_TO_XML_AND_XMLSCHEMA|CURSOR_TO_XML|CURSOR_TO_XMLSCHEMA|SCHEMA_TO_XML|SCHEMA_TO_XMLSCHEMA|SCHEMA_TO_XML_AND_XMLSCHEMA|DATABASE_TO_XML|DATABASE_TO_XMLSCHEMA|DATABASE_TO_XML_AND_XMLSCHEMA|XMLTABLE|JSON_TABLE|XPATH|XPATH_EXISTS|XMLPARSE)(?![a-zA-Z0-9_$\u0080-\uffff])/i;

const SAFE_WHERE_CALLABLES = new Set([
  'AND', 'OR', 'NOT', 'IN', 'ANY', 'SOME', 'ALL', 'SIMILAR', 'SYMMETRIC', 'ASYMMETRIC',
  'BETWEEN', 'IS', 'DISTINCT', 'CASE', 'WHEN', 'THEN', 'ELSE',
  'COALESCE', 'NULLIF', 'GREATEST', 'LEAST', 'CAST', 'ROW',
  'LOWER', 'UPPER', 'TRIM', 'BTRIM', 'LTRIM', 'RTRIM',
  'LENGTH', 'CHAR_LENGTH', 'CHARACTER_LENGTH', 'OCTET_LENGTH',
  'SUBSTRING', 'SUBSTR', 'LEFT', 'RIGHT', 'LPAD', 'RPAD', 'REPLACE', 'SPLIT_PART', 'STARTS_WITH',
  'POSITION', 'STRPOS', 'CONCAT', 'CONCAT_WS',
  'ABS', 'MOD', 'ROUND', 'TRUNC', 'CEIL', 'CEILING', 'FLOOR', 'SIGN', 'SQRT', 'POWER',
  'NOW', 'DATE_TRUNC', 'DATE_PART', 'EXTRACT', 'AGE', 'TO_CHAR', 'TO_DATE', 'TO_TIMESTAMP', 'TO_NUMBER',
  'ARRAY_LENGTH', 'ARRAY_POSITION', 'CARDINALITY',
  'JSONB_EXTRACT_PATH_TEXT', 'JSON_EXTRACT_PATH_TEXT', 'JSONB_TYPEOF', 'JSON_TYPEOF',
  'JSONB_ARRAY_LENGTH', 'JSON_ARRAY_LENGTH',
  'VARCHAR', 'CHAR', 'CHARACTER', 'VARYING', 'NUMERIC', 'DECIMAL', 'BIT', 'VARBIT',
  'TIMESTAMP', 'TIMESTAMPTZ', 'TIME', 'TIMETZ', 'INTERVAL', 'VECTOR', 'SPARSEVEC'
]);

export function assertSafeWhereClause(whereSql, { maxParamIndex = null } = {}) {
  if (typeof whereSql !== 'string') {
    throw new Error('[pg.vectorSearch] "whereSql" must be a string.');
  }
  if (whereSql.includes('\x00')) {
    throw new Error('[pg.vectorSearch] Null byte disallowed in whereSql.');
  }
  const trimmed = whereSql.trim().replace(/^WHERE\s+/i, '');
  if (!trimmed) return '';

  let inSingleQuote = false;
  let inDoubleQuote = false;
  let parenDepth = 0;
  let stripped = '';

  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    const next = trimmed[i + 1] || '';

    if (inSingleQuote) {
      if (ch === '\\') {
        throw new Error(`[pg.vectorSearch] Backslash escapes inside string literals are disallowed in whereSql (use $N parameters): "${trimmed}".`);
      }
      if (ch === "'" && next === "'") {
        i += 1;
        continue;
      }
      if (ch === "'") {
        inSingleQuote = false;
      }
      continue;
    }

    if (inDoubleQuote) {
      if (ch === '"' && next === '"') {
        i += 1;
        continue;
      }
      if (ch === '"') {
        inDoubleQuote = false;
        let look = i + 1;
        while (look < trimmed.length && /\s/.test(trimmed[look])) {
          look += 1;
        }
        if (trimmed[look] === '(') {
          throw new Error(`[pg.vectorSearch] Disallowed double-quoted function call in whereSql: "${trimmed}".`);
        }
      }
      continue;
    }

    if (ch === '$') {
      const prev = i > 0 ? trimmed[i - 1] : '';
      if (prev && /[a-zA-Z0-9_$\u0080-\uffff]/.test(prev)) {
        throw new Error(`[pg.vectorSearch] Disallowed dollar-quoted or dollar-identifier token in whereSql: "${trimmed}".`);
      }
      const paramMatch = trimmed.slice(i).match(/^\$(\d+)(?![a-zA-Z0-9_$\u0080-\uffff])/);
      if (!paramMatch) {
        throw new Error(`[pg.vectorSearch] Invalid SQL parameter or dollar-quoting in whereSql: "${trimmed}".`);
      }
      const digits = paramMatch[1];
      const idx = Number(digits);
      if (!Number.isSafeInteger(idx) || idx < 1 || digits.startsWith('0')) {
        throw new Error(`[pg.vectorSearch] Invalid SQL parameter index $${digits} in whereSql (must be >= $1).`);
      }
      if (maxParamIndex !== null && idx > maxParamIndex) {
        throw new Error(
          `[pg.vectorSearch] Out-of-range SQL parameter $${idx} in whereSql (only ${maxParamIndex} param(s) supplied).`
        );
      }
      stripped += ` $${idx} `;
      i += digits.length;
      continue;
    }

    if (ch === "'") {
      const prev = i > 0 ? trimmed[i - 1] : '';
      if (prev && /[a-zA-Z0-9_&\u0080-\uffff]/.test(prev)) {
        throw new Error(`[pg.vectorSearch] Prefixed PostgreSQL string literals are disallowed in whereSql (use $N parameters): "${trimmed}".`);
      }
      inSingleQuote = true;
      stripped += ' ';
      continue;
    }

    if (ch === '"') {
      const prev = i > 0 ? trimmed[i - 1] : '';
      if (prev && /[a-zA-Z0-9_&\u0080-\uffff]/.test(prev)) {
        throw new Error(`[pg.vectorSearch] Prefixed or Unicode-escaped identifiers are disallowed in whereSql: "${trimmed}".`);
      }
      inDoubleQuote = true;
      stripped += ' _ident_ ';
      continue;
    }

    if (ch === ';' || ch === '\\' || (ch === '-' && next === '-') || (ch === '/' && next === '*') || (ch === '*' && next === '/')) {
      throw new Error(`[pg.vectorSearch] Unsafe SQL token in whereSql: "${trimmed}".`);
    }

    if (ch === '(') {
      parenDepth += 1;
    } else if (ch === ')') {
      parenDepth -= 1;
      if (parenDepth < 0) {
        throw new Error(`[pg.vectorSearch] Unbalanced parentheses in whereSql: "${trimmed}".`);
      }
    }

    stripped += ch;
  }

  if (inSingleQuote || inDoubleQuote || parenDepth !== 0) {
    throw new Error(`[pg.vectorSearch] Unclosed quote or parentheses in whereSql: "${trimmed}".`);
  }

  if (DISALLOWED_WHERE_KEYWORDS_RE.test(stripped)) {
    throw new Error(`[pg.vectorSearch] Disallowed SQL keyword in whereSql: "${trimmed}".`);
  }

  if (/(?<![a-zA-Z0-9_$\u0080-\uffff])[a-zA-Z_\u0080-\uffff][a-zA-Z0-9_$\u0080-\uffff]*\s*\.\s*(?:[a-zA-Z_\u0080-\uffff][a-zA-Z0-9_$\u0080-\uffff]*|_ident_)\s*\(/.test(stripped)) {
    throw new Error(`[pg.vectorSearch] Disallowed schema-qualified function call in whereSql: "${trimmed}".`);
  }

  for (const callMatch of stripped.matchAll(/(?<![a-zA-Z0-9_$\u0080-\uffff])([a-zA-Z_\u0080-\uffff][a-zA-Z0-9_$\u0080-\uffff]*)\s*\(/g)) {
    const fnName = callMatch[1].toUpperCase();
    if (fnName === '_IDENT_') {
      throw new Error(`[pg.vectorSearch] Disallowed double-quoted function call in whereSql: "${trimmed}".`);
    }
    if (!SAFE_WHERE_CALLABLES.has(fnName)) {
      throw new Error(`[pg.vectorSearch] Disallowed SQL function "${callMatch[1]}" in whereSql: "${trimmed}".`);
    }
  }

  return trimmed;
}

/**
 * Execute a parameterized pgvector cosine similarity search (`<=>`) with strict SQL identifier
 * and vector dimensionality validation.
 *
 * @param {{ query: Function }} pgWrapper
 * @param {object} options
 * @returns {Promise<{ ok: true, tool: 'pg.vectorSearch', summary: string, data: { rows: object[] } }>}
 */
export async function pgVectorSearch(
  pgWrapper,
  {
    table,
    embeddingColumn = 'embedding',
    vector,
    selectColumns = ['id'],
    whereSql = '',
    params = [],
    limit = 10,
    expectedDims = 1024,
  } = {}
) {
  if (!pgWrapper || typeof pgWrapper.query !== 'function') {
    throw new Error('[pg.vectorSearch] Valid pgWrapper with .query() is required.');
  }

  assertSafePgIdentifier(table, 'table');
  assertSafePgIdentifier(embeddingColumn, 'embeddingColumn');

  if (!Array.isArray(selectColumns) || selectColumns.length === 0) {
    throw new Error('[pg.vectorSearch] "selectColumns" must be a non-empty array of column identifiers.');
  }
  const safeColumns = selectColumns.map((col) => assertSafePgIdentifier(col, 'selectColumn'));

  const vecArray =
    ArrayBuffer.isView(vector) && !(vector instanceof DataView) ? Array.from(vector) : vector;
  const validatedVec = validateVectorDimension(vecArray, expectedDims, 'pgVectorSearch');
  if (!validatedVec || !validatedVec.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    throw new Error(
      `[pg.vectorSearch] "vector" must be a finite numeric array of length ${expectedDims}.`
    );
  }

  const parsedLimit = Number(limit);
  if (!Number.isInteger(parsedLimit) || parsedLimit <= 0) {
    throw new Error(`[pg.vectorSearch] "limit" must be a positive integer, received: ${String(limit)}`);
  }

  const vectorLiteral = `[${validatedVec.map(Number).join(',')}]`;
  const baseParams = Array.isArray(params) ? [...params] : [];
  const vecIdx = baseParams.length + 1;
  const limitIdx = baseParams.length + 2;

  const cleanedWhere =
    whereSql === undefined || whereSql === null
      ? ''
      : assertSafeWhereClause(whereSql, { maxParamIndex: baseParams.length });
  const whereClause = cleanedWhere
    ? `WHERE ${embeddingColumn} IS NOT NULL AND (${cleanedWhere})`
    : `WHERE ${embeddingColumn} IS NOT NULL`;

  const sql = `SELECT ${safeColumns.join(', ')}, 1 - (${embeddingColumn} <=> $${vecIdx}::vector) AS similarity FROM ${table} ${whereClause} ORDER BY ${embeddingColumn} <=> $${vecIdx}::vector ASC LIMIT $${limitIdx}`;
  const boundParams = [...baseParams, vectorLiteral, parsedLimit];

  const res = await pgWrapper.query(sql, boundParams);
  const rows = Array.isArray(res?.rows) ? res.rows : [];

  return {
    ok: true,
    tool: 'pg.vectorSearch',
    summary: `Found ${rows.length} vector match(es)`,
    data: { rows },
  };
}
