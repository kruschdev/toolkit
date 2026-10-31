/**
 * @module db
 * SQLite database helpers using better-sqlite3.
 * Provides a lightweight wrapper for common CRUD patterns.
 *
 * Usage:
 *   import { initDb, query, queryOne, run } from '@krusch/toolkit/db';
 *   const db = initDb('./data/app.db');
 */

import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { basename, dirname, join } from 'node:path';

export { Database as SQLiteDatabase };

/** @type {Database.Database|null} */
let _db = null;

const VALID_SYNCHRONOUS_MODES = new Set(['OFF', 'NORMAL', 'FULL', 'EXTRA', '0', '1', '2', '3']);

const TRANSIENT_ERROR_CODES = new Set([
    'SQLITE_BUSY',
    'SQLITE_LOCKED',
    'SQLITE_NOMEM',
    'SQLITE_IOERR',
    'SQLITE_FULL',
    'SQLITE_CANTOPEN',
    'SQLITE_PERM',
    'SQLITE_READONLY',
    'ENOSPC',
    'ENOMEM',
    'EIO',
    'EACCES',
    'EPERM',
    'EBUSY',
    'EMFILE',
    'ENFILE',
    'EROFS',
]);

const TRANSIENT_SQLITE_ERRCODES = new Set([3, 5, 6, 7, 8, 10, 13, 14]);

const TRANSIENT_MESSAGE_PATTERN =
    /\b(out of memory|not enough memory|database is locked|database table is locked|disk i\/o error|database or disk is full|no space left on device|permission denied|too many open files|unable to open database file)\b/i;

const CORRUPTION_MESSAGE_PATTERN =
    /file is not a database|database disk image is malformed|sqlite quick_check failed/i;

const NON_FSYNCABLE_DIR_CODES = new Set([
    'EINVAL',
    'EBADF',
    'EISDIR',
    'ENOTSUP',
    'EOPNOTSUPP',
    'EPERM',
]);

function resolveSynchronousMode(value, fallback) {
    if (value === undefined || value === null || value === '') {
        return fallback;
    }
    const normalized = String(value).trim().toUpperCase();
    if (!VALID_SYNCHRONOUS_MODES.has(normalized)) {
        throw new RangeError(`Invalid SQLite synchronous mode: "${value}"`);
    }
    return normalized;
}

function configureConnectionPragmas(instance, options) {
    const busyTimeout =
        Number.isFinite(options.busyTimeout) && options.busyTimeout >= 0
            ? Math.trunc(options.busyTimeout)
            : 5000;
    instance.pragma(`busy_timeout = ${busyTimeout}`);

    if (options.wal !== false) {
        const syncMode = resolveSynchronousMode(options.synchronous, 'NORMAL');
        const walAutocheckpoint =
            Number.isFinite(options.walAutocheckpoint) && options.walAutocheckpoint >= 0
                ? Math.trunc(options.walAutocheckpoint)
                : 1000;
        instance.pragma('journal_mode = WAL');
        instance.pragma(`synchronous = ${syncMode}`);
        instance.pragma(`wal_autocheckpoint = ${walAutocheckpoint}`);
    } else {
        const syncMode = resolveSynchronousMode(options.synchronous, 'FULL');
        instance.pragma(`synchronous = ${syncMode}`);
    }

    instance.pragma('foreign_keys = ON');
}

/**
 * Initialize (or retrieve) the database connection with crash-safe durability pragmas.
 * If pragma setup fails (e.g. SQLITE_BUSY, SQLITE_NOMEM, SQLITE_IOERR), closes the handle
 * and leaves the module singleton null so a subsequent retry can recover cleanly.
 *
 * @param {string} dbPath - Path to the SQLite database file (or ':memory:')
 * @param {object} [options] - Connection & durability options
 * @param {boolean} [options.wal=true] - Enable WAL mode for concurrent reads
 * @param {number} [options.busyTimeout=5000] - Busy timeout in milliseconds
 * @param {string|number} [options.synchronous] - Synchronous level ('NORMAL' for WAL, 'FULL' otherwise)
 * @param {number} [options.walAutocheckpoint=1000] - WAL autocheckpoint page threshold
 * @param {Function} [options._DatabaseClass] - Optional Database constructor override for fault-injection tests
 * @returns {Database.Database} Database instance
 */
export function initDb(dbPath, options = {}) {
    if (_db && _db.open !== false) return _db;
    _db = null;

    if (dbPath && dbPath !== ':memory:') {
        fs.mkdirSync(dirname(dbPath), { recursive: true });
    }

    const DatabaseClass = options._DatabaseClass || Database;
    const instance = new DatabaseClass(dbPath);

    try {
        configureConnectionPragmas(instance, options);
        _db = instance;
        return _db;
    } catch (err) {
        try {
            instance.close();
        } catch (closeErr) {
            if (err && typeof err === 'object' && Object.isExtensible(err)) {
                err.cleanupErrors = [closeErr];
            }
        }
        _db = null;
        throw err;
    }
}

/**
 * Get the current database instance.
 *
 * @returns {Database.Database} Database instance
 * @throws {Error} If database hasn't been initialized
 */
export function getDb() {
    if (!_db) throw new Error('Database not initialized. Call initDb() first.');
    return _db;
}

/**
 * Run a SQL statement (INSERT, UPDATE, DELETE, CREATE).
 *
 * @param {string} sql - SQL statement
 * @param {Array} [params=[]] - Bound parameters
 * @returns {{ lastInsertRowid: number, changes: number }}
 */
export function run(sql, params = []) {
    const stmt = getDb().prepare(sql);
    const result = stmt.run(...params);
    return {
        lastInsertRowid: Number(result.lastInsertRowid),
        changes: result.changes,
    };
}

/**
 * Query multiple rows.
 *
 * @param {string} sql - SQL query
 * @param {Array} [params=[]] - Bound parameters
 * @returns {object[]} Array of row objects
 */
export function query(sql, params = []) {
    return getDb().prepare(sql).all(...params);
}

/**
 * Query a single row.
 *
 * @param {string} sql - SQL query
 * @param {Array} [params=[]] - Bound parameters
 * @returns {object|undefined} Row object or undefined
 */
export function queryOne(sql, params = []) {
    return getDb().prepare(sql).get(...params);
}

/**
 * Execute raw SQL (multiple statements, no parameters).
 * Use for schema definitions, migrations, etc.
 *
 * @param {string} sql - SQL statements
 */
export function exec(sql) {
    getDb().exec(sql);
}

/**
 * Run a function inside a transaction.
 *
 * @param {Function} fn - Function to run in transaction
 * @returns {*} Return value of fn
 */
export function transaction(fn) {
    return getDb().transaction(fn)();
}

/**
 * Create a prepared statement for repeated use.
 *
 * @param {string} sql - SQL statement
 * @returns {Database.Statement} Prepared statement
 */
export function prepare(sql) {
    return getDb().prepare(sql);
}

/**
 * Close the database connection and clear the singleton reference.
 */
export function closeDb() {
    if (_db) {
        try {
            _db.close();
        } finally {
            _db = null;
        }
    }
}

function isTransientFaultSignature(code, primaryErrcode, combinedText) {
    if (code) {
        if (TRANSIENT_ERROR_CODES.has(code)) return true;
        if (
            code.startsWith('SQLITE_BUSY_') ||
            code.startsWith('SQLITE_LOCKED_') ||
            code.startsWith('SQLITE_IOERR_') ||
            code.startsWith('SQLITE_CANTOPEN_') ||
            code.startsWith('SQLITE_READONLY_')
        ) {
            return true;
        }
    }
    if (primaryErrcode !== null && TRANSIENT_SQLITE_ERRCODES.has(primaryErrcode)) {
        return true;
    }
    return TRANSIENT_MESSAGE_PATTERN.test(combinedText);
}

function extractErrorFields(err) {
    const code =
        typeof err === 'object' && typeof err.code === 'string'
            ? err.code.trim().toUpperCase()
            : '';
    const rawErrcode =
        typeof err === 'object' && Number.isInteger(err.errcode) ? err.errcode : null;
    const primaryErrcode = rawErrcode !== null ? rawErrcode & 0xff : null;
    const errstr = typeof err === 'object' && typeof err.errstr === 'string' ? err.errstr : '';
    const message =
        typeof err === 'string' ? err : typeof err.message === 'string' ? err.message : '';
    return { code, rawErrcode, primaryErrcode, combinedText: `${message} ${errstr}`.trim() };
}

/**
 * Pure classifier distinguishing genuine structural SQLite file corruption
 * (SQLITE_CORRUPT=11, SQLITE_NOTADB=26, malformed disk image, failed quick_check)
 * from transient/compound resource, lock, or I/O faults (INV-REC-01).
 *
 * @param {unknown} err - Error object or value thrown during SQLite open/check
 * @returns {boolean} True strictly when err indicates structural database corruption
 */
export function isSqliteCorruptionError(err) {
    if (!err || (typeof err !== 'object' && typeof err !== 'string')) {
        return false;
    }

    if (typeof err === 'object' && err.cause) {
        const cause = extractErrorFields(err.cause);
        if (isTransientFaultSignature(cause.code, cause.primaryErrcode, cause.combinedText)) {
            return false;
        }
    }

    const { code, rawErrcode, primaryErrcode, combinedText } = extractErrorFields(err);
    if (isTransientFaultSignature(code, primaryErrcode, combinedText)) {
        return false;
    }

    if (code === 'SQLITE_CORRUPT' || code.startsWith('SQLITE_CORRUPT_') || code === 'SQLITE_NOTADB') {
        return true;
    }
    if (rawErrcode === 11 || rawErrcode === 26 || primaryErrcode === 11 || primaryErrcode === 26) {
        return true;
    }
    return CORRUPTION_MESSAGE_PATTERN.test(combinedText);
}

/**
 * Flush parent directory metadata to durable storage after rename/unlink (INV-REC-03).
 * Tolerates platforms/VFSes that disallow directory fsync (EINVAL, EBADF, EISDIR, ENOTSUP, EPERM)
 * while propagating genuine I/O and resource faults (EIO, ENOSPC, ENOMEM).
 *
 * @param {string} dirPath - Directory path to fsync
 * @param {typeof fs} [fsImpl=fs] - Filesystem implementation (injectable for VFS fault tests)
 */
export function fsyncDirectory(dirPath, fsImpl = fs) {
    let fd = null;
    let primaryError = null;

    try {
        fd = fsImpl.openSync(dirPath, 'r');
        fsImpl.fsyncSync(fd);
    } catch (err) {
        if (!err || !NON_FSYNCABLE_DIR_CODES.has(err.code)) {
            primaryError = err;
        }
    } finally {
        if (fd !== null) {
            try {
                fsImpl.closeSync(fd);
            } catch (closeErr) {
                if (!primaryError && (!closeErr || !NON_FSYNCABLE_DIR_CODES.has(closeErr.code))) {
                    primaryError = closeErr;
                }
            }
        }
    }

    if (primaryError) {
        throw primaryError;
    }
}

function writeAllSync(fd, content, tempPath, fsImpl) {
    const payload = Buffer.isBuffer(content)
        ? content
        : content instanceof Uint8Array
            ? Buffer.from(content)
            : Buffer.from(String(content ?? ''), 'utf8');

    if (payload.length === 0) {
        fsImpl.writeSync(fd, payload, 0, 0);
        return;
    }

    let offset = 0;
    while (offset < payload.length) {
        const written = fsImpl.writeSync(fd, payload, offset, payload.length - offset);
        if (typeof written !== 'number') {
            return;
        }
        if (written <= 0) {
            const shortWriteErr = new Error(`Short write (0 bytes) to temporary file: ${tempPath}`);
            shortWriteErr.code = 'EIO';
            throw shortWriteErr;
        }
        offset += written;
    }
}

function cleanupFailedTempWrite(fd, renamed, tempPath, fsImpl, primaryErr) {
    const cleanupErrors = [];
    if (fd !== null) {
        try {
            fsImpl.closeSync(fd);
        } catch (closeErr) {
            cleanupErrors.push(closeErr);
        }
    }
    if (!renamed) {
        try {
            fsImpl.unlinkSync(tempPath);
        } catch (unlinkErr) {
            if (!unlinkErr || unlinkErr.code !== 'ENOENT') {
                cleanupErrors.push(unlinkErr);
            }
        }
    }
    if (
        cleanupErrors.length > 0 &&
        primaryErr &&
        typeof primaryErr === 'object' &&
        Object.isExtensible(primaryErr)
    ) {
        primaryErr.cleanupErrors = cleanupErrors;
    }
}

/**
 * Crash-safe atomic file write via sibling temporary file, file fsync, atomic rename,
 * and parent-directory fsync (INV-REC-03). Guarantees zero leaked file descriptors and
 * unlinks partial temporary files if write, fsync, or rename fails.
 *
 * @param {string} targetPath - Destination file path
 * @param {string|Buffer|Uint8Array} content - File contents to write
 * @param {typeof fs} [fsImpl=fs] - Filesystem implementation (injectable for VFS fault tests)
 */
export function atomicWriteFileSync(targetPath, content, fsImpl = fs) {
    const targetDir = dirname(targetPath);
    const baseName = basename(targetPath);
    fsImpl.mkdirSync(targetDir, { recursive: true });

    const rand = randomBytes(6).toString('hex');
    const tempPath = join(targetDir, `.${baseName}.krusch-tmp-${process.pid}-${rand}`);

    let fd = null;
    let renamed = false;
    try {
        fd = fsImpl.openSync(tempPath, 'w');
        writeAllSync(fd, content, tempPath, fsImpl);
        fsImpl.fsyncSync(fd);

        const fdToClose = fd;
        fd = null;
        fsImpl.closeSync(fdToClose);

        fsImpl.renameSync(tempPath, targetPath);
        renamed = true;
    } catch (err) {
        cleanupFailedTempWrite(fd, renamed, tempPath, fsImpl, err);
        throw err;
    }

    fsyncDirectory(targetDir, fsImpl);
}
