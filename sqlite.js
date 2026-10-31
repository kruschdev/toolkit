/**
 * @module sqlite
 * @description Zero-native-addon SQLite wrapper (`node:sqlite` `DatabaseSync`),
 * injection-safe FTS5 query tokenizer/escaper, and prototype-safe Reciprocal Rank
 * Fusion (`fuseRrfResults`) Lego bricks (`INV-LEGO-12`, `INV-REC-01..05`).
 */

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { dirname } from 'node:path';
import { okEnvelope, errorEnvelope } from './http.js';
import { isSqliteCorruptionError } from './db.js';

export { DatabaseSync, isSqliteCorruptionError };

const VALID_SYNCHRONOUS_MODES = new Set(['OFF', 'NORMAL', 'FULL', 'EXTRA', '0', '1', '2', '3']);
const MAX_FTS5_RAW_QUERY_CHARS = 2048;
const FTS5_TOKEN_PATTERN = /[\p{L}\p{N}_]+/gu;

function resolveSynchronousMode(value, fallback) {
    if (value === undefined || value === null || value === '') {
        return fallback;
    }
    if (typeof value !== 'string' && typeof value !== 'number') {
        throw new RangeError(`Invalid SQLite synchronous mode: "${String(value)}"`);
    }
    const normalized = String(value).trim().toUpperCase();
    if (!VALID_SYNCHRONOUS_MODES.has(normalized)) {
        throw new RangeError(`Invalid SQLite synchronous mode: "${value}"`);
    }
    return normalized;
}

function configurePragmas(db, { wal, busyTimeout, synchronous, walAutocheckpoint, readOnly }) {
    const defaultSync = wal !== false ? 'NORMAL' : 'FULL';
    const syncMode = resolveSynchronousMode(synchronous, defaultSync);
    const safeBusyTimeout =
        Number.isFinite(busyTimeout) && busyTimeout >= 0 ? Math.trunc(busyTimeout) : 5000;

    db.exec(`PRAGMA busy_timeout = ${safeBusyTimeout};`);

    if (!readOnly) {
        if (wal !== false) {
            const safeAutocheckpoint =
                Number.isFinite(walAutocheckpoint) && walAutocheckpoint >= 0
                    ? Math.trunc(walAutocheckpoint)
                    : 1000;
            db.exec('PRAGMA journal_mode = WAL;');
            db.exec(`PRAGMA synchronous = ${syncMode};`);
            db.exec(`PRAGMA wal_autocheckpoint = ${safeAutocheckpoint};`);
        } else {
            db.exec(`PRAGMA synchronous = ${syncMode};`);
        }
    }

    db.exec('PRAGMA foreign_keys = ON;');
}

function normalizeParams(params) {
    if (params === undefined) return [];
    return Array.isArray(params) ? params : [params];
}

function normalizeRow(row) {
    return row && typeof row === 'object' ? { ...row } : row;
}

function silenceUnhandledRejection(thenable) {
    void (async () => {
        try {
            await thenable;
        } catch {
            // Ignored: synchronous TypeError is thrown immediately by transaction().
        }
    })();
}

function rollbackTransaction(db, depth, primaryErr) {
    try {
        if (depth === 0) {
            db.exec('ROLLBACK');
        } else {
            db.exec(`ROLLBACK TO SAVEPOINT sp_${depth}; RELEASE SAVEPOINT sp_${depth}`);
        }
    } catch (rbErr) {
        if (primaryErr && typeof primaryErr === 'object' && Object.isExtensible(primaryErr)) {
            primaryErr.rollbackError = rbErr;
        }
    }
}

/**
 * Open a Node 22 `node:sqlite` (`DatabaseSync`) connection configured with crash-safe
 * WAL durability pragmas (`INV-REC-01..05`) and automatic descriptor cleanup on init failure.
 *
 * @param {string} [dbPath=':memory:'] - SQLite database file path or `':memory:'`
 * @param {object} [options={}] - Connection & durability options
 * @param {boolean} [options.wal=true] - Enable WAL journal mode when writable
 * @param {number} [options.busyTimeout=5000] - Busy lock timeout in milliseconds
 * @param {string|number} [options.synchronous] - Synchronous level (`'NORMAL'` for WAL, `'FULL'` otherwise)
 * @param {number} [options.walAutocheckpoint=1000] - WAL autocheckpoint threshold in pages
 * @param {boolean} [options.readOnly=false] - Open database in read-only mode
 * @param {Function|null} [options.DatabaseClass=null] - Constructor override for fault-injection testing
 * @returns {{
 *   db: DatabaseSync,
 *   dbPath: string,
 *   isOpen: () => boolean,
 *   exec: (sql: string) => void,
 *   run: (sql: string, params?: unknown) => { changes: number, lastInsertRowid: number },
 *   query: (sql: string, params?: unknown) => Array<Record<string, unknown>>,
 *   queryOne: (sql: string, params?: unknown) => Record<string, unknown> | null,
 *   transaction: <T>(fn: () => T) => T,
 *   healthCheck: () => object,
 *   close: () => void
 * }}
 */
export function openSqliteDb(dbPath = ':memory:', options = {}) {
    if (typeof dbPath !== 'string' || dbPath.trim().length === 0) {
        throw new TypeError('openSqliteDb requires a non-empty string dbPath');
    }

    const {
        wal = true,
        busyTimeout = 5000,
        synchronous,
        walAutocheckpoint = 1000,
        readOnly = false,
        DatabaseClass = null,
    } = options && typeof options === 'object' ? options : {};

    if (dbPath !== ':memory:' && !dbPath.startsWith('file:') && !readOnly) {
        fs.mkdirSync(dirname(dbPath), { recursive: true });
    }

    const DbCtor = DatabaseClass || DatabaseSync;
    const db = readOnly ? new DbCtor(dbPath, { readOnly: true }) : new DbCtor(dbPath);

    try {
        configurePragmas(db, { wal, busyTimeout, synchronous, walAutocheckpoint, readOnly });
    } catch (err) {
        try {
            db.close();
        } catch (closeErr) {
            if (err && typeof err === 'object' && Object.isExtensible(err)) {
                err.cleanupErrors = [closeErr];
            }
        }
        throw err;
    }

    let closed = false;
    let txDepth = 0;

    function assertOpen() {
        if (closed) {
            const closedErr = new Error('SQLite connection is closed');
            closedErr.code = 'SQLITE_CLOSED';
            throw closedErr;
        }
    }

    function exec(sql) {
        assertOpen();
        db.exec(sql);
    }

    function run(sql, params = []) {
        assertOpen();
        const stmt = db.prepare(sql);
        const res = stmt.run(...normalizeParams(params));
        return {
            changes: Number(res?.changes ?? 0),
            lastInsertRowid: Number(res?.lastInsertRowid ?? 0),
        };
    }

    function query(sql, params = []) {
        assertOpen();
        const rows = db.prepare(sql).all(...normalizeParams(params));
        return Array.isArray(rows) ? rows.map(normalizeRow) : [];
    }

    function queryOne(sql, params = []) {
        assertOpen();
        const row = db.prepare(sql).get(...normalizeParams(params));
        return row && typeof row === 'object' ? { ...row } : null;
    }

    function transaction(fn) {
        if (typeof fn !== 'function') {
            throw new TypeError('SQLite transaction requires a synchronous callback function');
        }
        assertOpen();

        const depth = txDepth;
        if (depth === 0) {
            db.exec('BEGIN IMMEDIATE');
        } else {
            db.exec(`SAVEPOINT sp_${depth}`);
        }
        txDepth = depth + 1;

        try {
            const out = fn();
            if (
                (typeof out === 'object' || typeof out === 'function') &&
                out !== null &&
                typeof out.then === 'function'
            ) {
                silenceUnhandledRejection(out);
                throw new TypeError('SQLite transaction callback must be synchronous');
            }
            if (depth === 0) {
                db.exec('COMMIT');
            } else {
                db.exec(`RELEASE SAVEPOINT sp_${depth}`);
            }
            return out;
        } catch (err) {
            rollbackTransaction(db, depth, err);
            throw err;
        } finally {
            txDepth = depth;
        }
    }

    function healthCheck() {
        if (closed) {
            return errorEnvelope(
                'SQLITE_CLOSED',
                'SQLite connection is closed',
                { dbPath },
                'sqlite.health'
            );
        }
        try {
            const row = queryOne('SELECT 1 AS ok');
            if (!row || Number(row.ok) !== 1) {
                return errorEnvelope(
                    'SQLITE_UNHEALTHY',
                    'Unexpected SQLite health probe response',
                    { dbPath, isCorruption: false },
                    'sqlite.health'
                );
            }
            return okEnvelope('sqlite.health', 'SQLite connection healthy', {
                dbPath,
                ok: true,
            });
        } catch (err) {
            const message =
                err && typeof err === 'object' && typeof err.message === 'string' && err.message
                    ? err.message
                    : String(err);
            return errorEnvelope(
                'SQLITE_UNHEALTHY',
                message,
                { dbPath, isCorruption: isSqliteCorruptionError(err) },
                'sqlite.health'
            );
        }
    }

    function close() {
        if (closed) return;
        closed = true;
        db.close();
    }

    return {
        db,
        dbPath,
        isOpen: () => !closed,
        exec,
        run,
        query,
        queryOne,
        transaction,
        healthCheck,
        close,
    };
}

/**
 * Sanitize untrusted free-text user input into a deterministic SQLite FTS5 `MATCH` expression
 * that cannot throw `fts5: syntax error` on boolean keywords, colons, operators, or unclosed quotes.
 *
 * @param {string} [rawQuery=''] - Raw user search query
 * @param {object} [options={}] - Escaping options
 * @param {'AND'|'OR'} [options.operator='AND'] - Boolean join operator (`'AND'` or `'OR'`)
 * @param {boolean} [options.prefixLastToken=false] - Append `*` to the final quoted token for autocomplete
 * @param {number} [options.maxTokens=32] - Maximum extracted tokens
 * @returns {string} Escaped FTS5 query string, or `''` when no alphanumeric tokens exist
 */
export function escapeFts5Query(rawQuery = '', options = {}) {
    const {
        operator = 'AND',
        prefixLastToken = false,
        maxTokens = 32,
    } = options && typeof options === 'object' ? options : {};
    const normalizedOp = typeof operator === 'string' ? operator.trim().toUpperCase() : '';
    if (normalizedOp !== 'AND' && normalizedOp !== 'OR') {
        throw new RangeError(
            `Invalid FTS5 operator "${String(operator)}": expected "AND" or "OR"`
        );
    }

    const boundedInput = String(rawQuery ?? '').slice(0, MAX_FTS5_RAW_QUERY_CHARS);
    const safeMaxTokens = Number.isFinite(maxTokens)
        ? Math.max(1, Math.trunc(maxTokens || 32))
        : 32;

    const matches = boundedInput.match(FTS5_TOKEN_PATTERN);
    if (!matches || matches.length === 0) {
        return '';
    }

    const tokens = matches.slice(0, safeMaxTokens);
    const quotedTokens = tokens.map((token, index) => {
        const quoted = `"${token.replace(/"/g, '""')}"`;
        if (prefixLastToken === true && index === tokens.length - 1) {
            return `${quoted}*`;
        }
        return quoted;
    });

    return quotedTokens.join(` ${normalizedOp} `);
}

function assignSafeProperty(target, key, value) {
    if (key === '__proto__') {
        Object.defineProperty(target, '__proto__', {
            value,
            enumerable: true,
            configurable: true,
            writable: true,
        });
    } else {
        target[key] = value;
    }
}

function mergePrototypeSafe(lowerPriority, higherPriority, idKey) {
    const merged = {};
    for (const source of [lowerPriority, higherPriority]) {
        for (const [key, value] of Object.entries(source)) {
            if (key === '__proto__' && idKey !== '__proto__') continue;
            assignSafeProperty(merged, key, value);
        }
    }
    return merged;
}

/**
 * Fuse multiple ranked retrieval lists (e.g., FTS5 BM25 + dense pgvector/cosine results)
 * using weighted Reciprocal Rank Fusion: `sum_i weight_i / (k + rank_i)` (`1`-indexed `rank`).
 *
 * @param {Array<Array<Record<string, unknown>>>} [rankedLists=[]] - Ordered arrays of candidate objects
 * @param {object} [options={}] - RRF fusion options
 * @param {number} [options.k=60] - Smoothing constant (`>= 1`)
 * @param {string} [options.idKey='id'] - Document identifier property name
 * @param {number} [options.limit=20] - Maximum fused items returned
 * @param {number[]} [options.weights=[]] - Optional positive per-list weights (defaults to `1` per list)
 * @returns {Array<Record<string, unknown> & { rrfScore: number }>} Sorted fused items
 */
export function fuseRrfResults(rankedLists = [], options = {}) {
    const {
        k = 60,
        idKey = 'id',
        limit = 20,
        weights = [],
    } = options && typeof options === 'object' ? options : {};
    const safeK = Number.isFinite(k) && k >= 1 ? k : 60;
    const safeLimit = Number.isFinite(limit) && limit >= 0 ? Math.trunc(limit) : 20;
    if (safeLimit === 0 || !Array.isArray(rankedLists) || rankedLists.length === 0) {
        return [];
    }

    const safeIdKey = typeof idKey === 'string' && idKey.length > 0 ? idKey : 'id';
    const fusedMap = new Map();

    for (let listIdx = 0; listIdx < rankedLists.length; listIdx += 1) {
        const list = rankedLists[listIdx];
        if (!Array.isArray(list)) continue;

        const rawWeight = weights?.[listIdx];
        const weight = Number.isFinite(rawWeight) && rawWeight > 0 ? Number(rawWeight) : 1;
        const seenInList = new Set();

        for (let itemIdx = 0; itemIdx < list.length; itemIdx += 1) {
            const item = list[itemIdx];
            if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
            if (!Object.hasOwn(item, safeIdKey)) continue;

            const rawId = item[safeIdKey];
            if (rawId === null || rawId === undefined) continue;
            const docId = String(rawId);
            if (docId.trim().length === 0) continue;

            if (seenInList.has(docId)) continue;
            seenInList.add(docId);

            const rank = itemIdx + 1;
            const contribution = weight / (safeK + rank);
            const existing = fusedMap.get(docId);

            if (!existing) {
                fusedMap.set(docId, {
                    score: contribution,
                    bestRank: rank,
                    merged: mergePrototypeSafe({}, item, safeIdKey),
                });
            } else {
                existing.score += contribution;
                if (rank < existing.bestRank) {
                    existing.merged = mergePrototypeSafe(existing.merged, item, safeIdKey);
                    existing.bestRank = rank;
                } else {
                    existing.merged = mergePrototypeSafe(item, existing.merged, safeIdKey);
                }
            }
        }
    }

    const fusedItems = [];
    for (const entry of fusedMap.values()) {
        const record = mergePrototypeSafe({}, entry.merged, safeIdKey);
        record.rrfScore = Number(entry.score.toFixed(10));
        fusedItems.push(record);
    }

    fusedItems.sort(
        (a, b) =>
            b.rrfScore - a.rrfScore ||
            String(a[safeIdKey]).localeCompare(String(b[safeIdKey]))
    );

    return fusedItems.slice(0, safeLimit);
}
