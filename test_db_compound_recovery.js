import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    SQLiteDatabase,
    atomicWriteFileSync,
    closeDb,
    exec,
    fsyncDirectory,
    getDb,
    initDb,
    isSqliteCorruptionError,
    prepare,
    query,
    queryOne,
    run,
    transaction,
} from './db.js';

/**
 * Create an error with attached code / SQLite errcode properties.
 */
function makeFaultError(message, code, extra = {}) {
    const err = new Error(message);
    if (code !== undefined) {
        err.code = code;
    }
    Object.assign(err, extra);
    return err;
}

/**
 * Wrap real `node:fs` with deterministic fault injection and open-fd leak tracking.
 */
function createFaultInjectingFs(hooks = {}) {
    const openFds = new Map();
    const events = [];

    return {
        openFds,
        events,
        mkdirSync(dirPath, options) {
            events.push({ op: 'mkdirSync', dirPath });
            if (hooks.onMkdirSync) hooks.onMkdirSync(dirPath, options);
            return fs.mkdirSync(dirPath, options);
        },
        openSync(targetPath, flags, mode) {
            events.push({ op: 'openSync', targetPath, flags });
            if (hooks.onOpenSync) {
                const overrideFd = hooks.onOpenSync(targetPath, flags, mode);
                if (overrideFd !== undefined) {
                    openFds.set(overrideFd, { targetPath, flags, synthetic: true });
                    return overrideFd;
                }
            }
            const fd = fs.openSync(targetPath, flags, mode);
            openFds.set(fd, { targetPath, flags, synthetic: false });
            return fd;
        },
        writeSync(fd, buffer, offset, length) {
            const meta = openFds.get(fd);
            events.push({ op: 'writeSync', fd, targetPath: meta?.targetPath, offset, length });
            if (hooks.onWriteSync) {
                const customResult = hooks.onWriteSync({
                    fd,
                    buffer,
                    offset,
                    length,
                    meta,
                    realWriteSync: fs.writeSync,
                });
                if (customResult !== undefined) {
                    return customResult;
                }
            }
            return fs.writeSync(fd, buffer, offset, length);
        },
        fsyncSync(fd) {
            const meta = openFds.get(fd);
            events.push({ op: 'fsyncSync', fd, targetPath: meta?.targetPath, flags: meta?.flags });
            if (hooks.onFsyncSync) {
                hooks.onFsyncSync({ fd, meta });
            }
            if (meta?.synthetic) return;
            fs.fsyncSync(fd);
        },
        closeSync(fd) {
            const meta = openFds.get(fd);
            events.push({ op: 'closeSync', fd, targetPath: meta?.targetPath });
            openFds.delete(fd);
            if (!meta?.synthetic) {
                fs.closeSync(fd);
            }
            if (hooks.onCloseSync) {
                hooks.onCloseSync({ fd, meta });
            }
        },
        renameSync(oldPath, newPath) {
            events.push({ op: 'renameSync', oldPath, newPath });
            if (hooks.onRenameSync) {
                hooks.onRenameSync(oldPath, newPath);
            }
            fs.renameSync(oldPath, newPath);
        },
        unlinkSync(targetPath) {
            events.push({ op: 'unlinkSync', targetPath });
            if (hooks.onUnlinkSync) {
                hooks.onUnlinkSync(targetPath);
            }
            fs.unlinkSync(targetPath);
        },
    };
}

describe('@krusch/toolkit/db — Compound Recovery & Durability Suite', () => {
    let tempDir = null;

    beforeEach(() => {
        closeDb();
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krusch-db-recovery-'));
    });

    afterEach(() => {
        closeDb();
        if (tempDir && fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
        tempDir = null;
    });

    describe('1. Durability Pragma Configuration & Backward-Compatible Exports (INV-REC-04)', () => {
        it('preserves all existing exports alongside new compound-recovery helpers', () => {
            assert.equal(typeof SQLiteDatabase, 'function');
            assert.equal(typeof initDb, 'function');
            assert.equal(typeof getDb, 'function');
            assert.equal(typeof run, 'function');
            assert.equal(typeof query, 'function');
            assert.equal(typeof queryOne, 'function');
            assert.equal(typeof exec, 'function');
            assert.equal(typeof transaction, 'function');
            assert.equal(typeof prepare, 'function');
            assert.equal(typeof closeDb, 'function');
            assert.equal(typeof isSqliteCorruptionError, 'function');
            assert.equal(typeof fsyncDirectory, 'function');
            assert.equal(typeof atomicWriteFileSync, 'function');
        });

        it('configures busy_timeout=5000, journal_mode=wal, synchronous=1 (NORMAL), wal_autocheckpoint=1000, foreign_keys=1', () => {
            const dbPath = path.join(tempDir, 'nested', 'app.db');
            const db = initDb(dbPath);

            assert.equal(db, getDb());
            assert.equal(initDb(dbPath), db, 'subsequent initDb returns open singleton');

            assert.equal(db.pragma('busy_timeout', { simple: true }), 5000);
            assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
            assert.equal(db.pragma('synchronous', { simple: true }), 1);
            assert.equal(db.pragma('wal_autocheckpoint', { simple: true }), 1000);
            assert.equal(db.pragma('foreign_keys', { simple: true }), 1);

            exec('CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);');
            const ins = run('INSERT INTO items (name) VALUES (?)', ['alpha']);
            assert.equal(ins.lastInsertRowid, 1);
            assert.equal(ins.changes, 1);

            transaction(() => {
                const stmt = prepare('INSERT INTO items (name) VALUES (?)');
                stmt.run('beta');
            });

            const rows = query('SELECT id, name FROM items ORDER BY id ASC');
            assert.deepEqual(rows, [
                { id: 1, name: 'alpha' },
                { id: 2, name: 'beta' },
            ]);
            assert.deepEqual(queryOne('SELECT name FROM items WHERE id = ?', [2]), { name: 'beta' });
        });

        it('sets busy_timeout FIRST before journal_mode=WAL and honors non-WAL synchronous=FULL defaults', () => {
            const pragmaOrder = [];
            class TracingDatabase extends SQLiteDatabase {
                pragma(str, options) {
                    pragmaOrder.push(str);
                    return super.pragma(str, options);
                }
            }

            const walDbPath = path.join(tempDir, 'order-check.db');
            initDb(walDbPath, { _DatabaseClass: TracingDatabase });
            assert.deepEqual(pragmaOrder, [
                'busy_timeout = 5000',
                'journal_mode = WAL',
                'synchronous = NORMAL',
                'wal_autocheckpoint = 1000',
                'foreign_keys = ON',
            ]);

            closeDb();
            const rollbackDbPath = path.join(tempDir, 'rollback-mode.db');
            const nonWalDb = initDb(rollbackDbPath, {
                wal: false,
                busyTimeout: 7500,
            });
            assert.equal(nonWalDb.pragma('busy_timeout', { simple: true }), 7500);
            assert.equal(nonWalDb.pragma('synchronous', { simple: true }), 2); // FULL = 2
            assert.equal(nonWalDb.pragma('foreign_keys', { simple: true }), 1);
        });
    });

    describe('2. Singleton Initialization Fault Recovery (INV-REC-04)', () => {
        it('closes broken handle, leaves _db === null on SQLITE_NOMEM during pragma setup, and succeeds on retry', () => {
            const dbPath = path.join(tempDir, 'nomem-retry.db');
            let closedBrokenHandle = 0;
            const seenPragmas = [];

            class FaultyNomemDatabase {
                constructor(targetPath) {
                    this.inner = new SQLiteDatabase(targetPath);
                    this.open = true;
                }
                pragma(statement) {
                    seenPragmas.push(statement);
                    if (statement.startsWith('journal_mode')) {
                        throw makeFaultError('out of memory', 'SQLITE_NOMEM', { errcode: 7 });
                    }
                    return this.inner.pragma(statement);
                }
                close() {
                    closedBrokenHandle += 1;
                    this.open = false;
                    this.inner.close();
                }
            }

            assert.throws(
                () => initDb(dbPath, { _DatabaseClass: FaultyNomemDatabase }),
                (err) => err.code === 'SQLITE_NOMEM' && err.errcode === 7
            );

            assert.deepEqual(seenPragmas, ['busy_timeout = 5000', 'journal_mode = WAL']);
            assert.equal(closedBrokenHandle, 1, 'broken Database instance must be closed');
            assert.throws(() => getDb(), /Database not initialized/);

            const recoveredDb = initDb(dbPath);
            assert.equal(recoveredDb.open, true);
            assert.equal(recoveredDb.pragma('journal_mode', { simple: true }), 'wal');
            exec('CREATE TABLE recovered (k TEXT PRIMARY KEY);');
            run('INSERT INTO recovered (k) VALUES (?)', ['ok']);
            assert.deepEqual(queryOne('SELECT k FROM recovered'), { k: 'ok' });
        });

        it('Recovers cleanly after SQLITE_BUSY / SQLITE_IOERR even if secondary close() also throws', () => {
            const dbPath = path.join(tempDir, 'busy-secondary-close.db');
            let closeAttempts = 0;

            class BusyWithFailingCloseDatabase {
                constructor(targetPath) {
                    this.inner = new SQLiteDatabase(targetPath);
                }
                pragma(statement) {
                    if (statement.startsWith('wal_autocheckpoint')) {
                        throw makeFaultError('database is locked', 'SQLITE_BUSY', { errcode: 5 });
                    }
                    return this.inner.pragma(statement);
                }
                close() {
                    closeAttempts += 1;
                    this.inner.close();
                    throw makeFaultError('secondary close failure', 'SQLITE_IOERR', { errcode: 10 });
                }
            }

            assert.throws(
                () => initDb(dbPath, { _DatabaseClass: BusyWithFailingCloseDatabase }),
                (err) => err.code === 'SQLITE_BUSY' && /database is locked/i.test(err.message)
            );
            assert.equal(closeAttempts, 1);
            assert.throws(() => getDb(), /Database not initialized/);

            const healthyDb = initDb(dbPath);
            assert.equal(healthyDb.pragma('busy_timeout', { simple: true }), 5000);
            assert.equal(healthyDb.pragma('foreign_keys', { simple: true }), 1);
        });

        it('rejects unsafe synchronous mode strings without wedging _db singleton', () => {
            const dbPath = path.join(tempDir, 'bad-sync.db');
            assert.throws(
                () => initDb(dbPath, { synchronous: 'NORMAL; DROP TABLE x' }),
                RangeError
            );
            assert.throws(() => getDb(), /Database not initialized/);

            const healthyDb = initDb(dbPath, { synchronous: 'FULL' });
            assert.equal(healthyDb.pragma('synchronous', { simple: true }), 2);
        });
    });

    describe('3. isSqliteCorruptionError Strict Disambiguation (INV-REC-01)', () => {
        it('returns true strictly for genuine structural SQLite corruption', () => {
            assert.equal(
                isSqliteCorruptionError(
                    makeFaultError('database disk image is malformed', 'SQLITE_CORRUPT')
                ),
                true
            );
            assert.equal(
                isSqliteCorruptionError(
                    makeFaultError('file is not a database', 'SQLITE_NOTADB')
                ),
                true
            );
            assert.equal(
                isSqliteCorruptionError(
                    makeFaultError('vtable corrupt', 'SQLITE_CORRUPT_VTAB', { errcode: 267 })
                ),
                true
            );
            assert.equal(
                isSqliteCorruptionError(
                    makeFaultError('malformed page', 'ERR_SQLITE_ERROR', { errcode: 11 })
                ),
                true
            );
            assert.equal(
                isSqliteCorruptionError(
                    makeFaultError('bad header', 'ERR_SQLITE_ERROR', { errcode: 26 })
                ),
                true
            );
            assert.equal(
                isSqliteCorruptionError(new Error('SQLite quick_check failed: row 9 missing from index')),
                true
            );
            assert.equal(
                isSqliteCorruptionError(new Error('Database disk image is malformed')),
                true
            );

            // Real better-sqlite3 corruption error on invalid file bytes
            const bogusDbPath = path.join(tempDir, 'corrupt-header.db');
            fs.writeFileSync(bogusDbPath, 'NOT_A_SQLITE_3_HEADER_PAYLOAD_XXXX_0000');
            let caughtRealSqliteErr = null;
            let rawDb = null;
            try {
                rawDb = new SQLiteDatabase(bogusDbPath);
                rawDb.prepare('SELECT * FROM sqlite_master').all();
            } catch (err) {
                caughtRealSqliteErr = err;
            } finally {
                if (rawDb && rawDb.open) rawDb.close();
            }
            assert.notEqual(caughtRealSqliteErr, null);
            assert.equal(isSqliteCorruptionError(caughtRealSqliteErr), true);
        });

        it('returns strictly false for SQLITE_NOMEM, SQLITE_BUSY, SQLITE_FULL/ENOSPC, SQLITE_IOERR, and empty inputs', () => {
            const transientErrors = [
                makeFaultError('out of memory', 'SQLITE_NOMEM', { errcode: 7 }),
                makeFaultError('database is locked', 'SQLITE_BUSY', { errcode: 5 }),
                makeFaultError('database is locked (recovery)', 'SQLITE_BUSY_RECOVERY', { errcode: 261 }),
                makeFaultError('database table is locked', 'SQLITE_LOCKED', { errcode: 6 }),
                makeFaultError('disk I/O error', 'SQLITE_IOERR', { errcode: 10 }),
                makeFaultError('disk I/O error on fsync', 'SQLITE_IOERR_FSYNC', { errcode: 1034 }),
                makeFaultError('database or disk is full', 'SQLITE_FULL', { errcode: 13 }),
                makeFaultError('ENOSPC: no space left on device, write', 'ENOSPC'),
                makeFaultError('ENOMEM: not enough memory', 'ENOMEM'),
                makeFaultError('EIO: i/o error, fsync', 'EIO'),
                makeFaultError('EACCES: permission denied', 'EACCES'),
                // Compound error: quick_check wrapper triggered by OOM or I/O fault must NOT quarantine DB
                new Error('SQLite quick_check failed: out of memory'),
                new Error('SQLite quick_check failed: database is locked'),
                new Error('SQLite quick_check failed', {
                    cause: makeFaultError('disk I/O error', 'SQLITE_IOERR', { errcode: 10 }),
                }),
                new Error('near "SELEC": syntax error'),
            ];

            for (const err of transientErrors) {
                assert.equal(
                    isSqliteCorruptionError(err),
                    false,
                    `Expected transient/non-corrupt error to classify as false: ${err.code || ''} ${err.message}`
                );
            }

            for (const emptyInput of [null, undefined, '', '   ', {}, 0, false, NaN]) {
                assert.equal(isSqliteCorruptionError(emptyInput), false);
            }
        });
    });

    describe('4. atomicWriteFileSync & fsyncDirectory Fault-Injecting VFS Tests (INV-REC-03)', () => {
        it('atomically writes sibling temp file, fsyncs file + parent directory, and leaves zero temp artifacts or open fds', () => {
            const targetPath = path.join(tempDir, 'sub', 'config.json');
            const vfs = createFaultInjectingFs();

            atomicWriteFileSync(targetPath, '{"ok":true}\n', vfs);

            assert.equal(fs.readFileSync(targetPath, 'utf8'), '{"ok":true}\n');
            assert.equal(vfs.openFds.size, 0, 'all file descriptors must be closed');

            const dirEntries = fs.readdirSync(path.dirname(targetPath));
            assert.deepEqual(dirEntries, ['config.json']);

            const ops = vfs.events.map((e) => e.op);
            const renameIdx = ops.indexOf('renameSync');
            const fsyncIndices = ops
                .map((op, idx) => (op === 'fsyncSync' ? idx : -1))
                .filter((idx) => idx >= 0);
            assert.equal(fsyncIndices.length, 2, 'must fsync both temp file and parent directory');
            assert.equal(fsyncIndices[0] < renameIdx, true, 'temp file fsync must precede renameSync');
            assert.equal(fsyncIndices[1] > renameIdx, true, 'parent directory fsync must follow renameSync');
        });

        it('ENOSPC mid-writeSync closes fd (0 fd leak), unlinks .krusch-tmp-*, and preserves existing target file byte-for-byte', () => {
            const targetDir = path.join(tempDir, 'enospc-case');
            fs.mkdirSync(targetDir, { recursive: true });
            const targetPath = path.join(targetDir, 'state.json');
            const originalBytes = Buffer.from('{"version":1,"intact":"byte-for-byte"}\n', 'utf8');
            fs.writeFileSync(targetPath, originalBytes);

            let writeCalls = 0;
            const vfs = createFaultInjectingFs({
                onWriteSync({ fd, buffer, offset, realWriteSync }) {
                    writeCalls += 1;
                    if (writeCalls === 1) {
                        // Simulate partial write of first 10 bytes before disk fills up
                        return realWriteSync(fd, buffer, offset, 10);
                    }
                    throw makeFaultError('ENOSPC: no space left on device, write', 'ENOSPC');
                },
            });

            assert.throws(
                () => atomicWriteFileSync(targetPath, '{"version":2,"corrupted":"never-committed"}\n', vfs),
                (err) => err.code === 'ENOSPC'
            );

            assert.equal(writeCalls, 2);
            assert.equal(vfs.openFds.size, 0, 'zero open fds leaked after mid-write ENOSPC');
            const remainingFiles = fs.readdirSync(targetDir);
            assert.equal(
                remainingFiles.some((name) => name.includes('.krusch-tmp-')),
                false,
                'partial .krusch-tmp-* sibling must be unlinked'
            );
            assert.deepEqual(fs.readFileSync(targetPath), originalBytes);
        });

        it('EIO on file fsyncSync closes fd, unlinks .krusch-tmp-*, and leaves target file intact', () => {
            const targetDir = path.join(tempDir, 'eio-fsync-case');
            fs.mkdirSync(targetDir, { recursive: true });
            const targetPath = path.join(targetDir, 'journal.json');
            const originalBytes = Buffer.from('{"committed":42}\n', 'utf8');
            fs.writeFileSync(targetPath, originalBytes);

            const vfs = createFaultInjectingFs({
                onFsyncSync({ meta }) {
                    if (meta?.flags === 'w') {
                        throw makeFaultError('EIO: i/o error, fsync', 'EIO');
                    }
                },
            });

            assert.throws(
                () => atomicWriteFileSync(targetPath, '{"committed":999}\n', vfs),
                (err) => err.code === 'EIO'
            );

            assert.equal(vfs.openFds.size, 0, 'zero open fds leaked after fsyncSync EIO');
            const remainingFiles = fs.readdirSync(targetDir);
            assert.deepEqual(remainingFiles, ['journal.json']);
            assert.deepEqual(fs.readFileSync(targetPath), originalBytes);
        });

        it('preserves primary write error even if secondary closeSync and unlinkSync also fail during cleanup', () => {
            const targetDir = path.join(tempDir, 'compound-cleanup');
            fs.mkdirSync(targetDir, { recursive: true });
            const targetPath = path.join(targetDir, 'data.txt');
            fs.writeFileSync(targetPath, 'baseline');

            const vfs = createFaultInjectingFs({
                onWriteSync() {
                    throw makeFaultError('ENOSPC: disk full', 'ENOSPC');
                },
                onCloseSync() {
                    throw makeFaultError('EIO: secondary close error', 'EIO');
                },
                onUnlinkSync(unlinkPath) {
                    // Clean up real temp file first so tempDir stays tidy, then throw secondary fault
                    if (fs.existsSync(unlinkPath)) fs.unlinkSync(unlinkPath);
                    throw makeFaultError('EIO: secondary unlink error', 'EIO');
                },
            });

            assert.throws(
                () => atomicWriteFileSync(targetPath, 'mutated', vfs),
                (err) => err.code === 'ENOSPC'
            );
            assert.equal(vfs.openFds.size, 0);
            assert.equal(fs.readFileSync(targetPath, 'utf8'), 'baseline');
        });

        it('fsyncDirectory propagates EIO/ENOSPC/ENOMEM while tolerating EINVAL/EBADF/EISDIR/ENOTSUP/EPERM (including fd=0)', () => {
            for (const toleratedCode of ['EINVAL', 'EBADF', 'EISDIR', 'ENOTSUP', 'EPERM']) {
                const vfs = createFaultInjectingFs({
                    onOpenSync() {
                        return 0; // Verify fd === 0 is still properly closed in finally!
                    },
                    onFsyncSync() {
                        throw makeFaultError(`${toleratedCode}: dir fsync unsupported`, toleratedCode);
                    },
                });

                assert.doesNotThrow(() => fsyncDirectory(tempDir, vfs));
                assert.equal(vfs.openFds.size, 0, `fd=0 must be closed when ${toleratedCode} is tolerated`);
            }

            for (const fatalCode of ['EIO', 'ENOSPC', 'ENOMEM']) {
                const vfs = createFaultInjectingFs({
                    onOpenSync() {
                        return 0;
                    },
                    onFsyncSync() {
                        throw makeFaultError(`${fatalCode}: storage hardware fault`, fatalCode);
                    },
                });

                assert.throws(
                    () => fsyncDirectory(tempDir, vfs),
                    (err) => err.code === fatalCode
                );
                assert.equal(vfs.openFds.size, 0, `fd=0 must be closed when ${fatalCode} propagates`);
            }

            // Verify EIO on parent directory fsync inside atomicWriteFileSync also propagates
            const dirFaultTarget = path.join(tempDir, 'dir-eio.txt');
            const dirEioVfs = createFaultInjectingFs({
                onFsyncSync({ meta }) {
                    if (meta?.flags === 'r') {
                        throw makeFaultError('EIO: directory metadata flush failed', 'EIO');
                    }
                },
            });

            assert.throws(
                () => atomicWriteFileSync(dirFaultTarget, 'payload', dirEioVfs),
                (err) => err.code === 'EIO'
            );
            assert.equal(dirEioVfs.openFds.size, 0);
        });
    });
});
