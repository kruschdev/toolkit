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
import { mkdirSync } from 'fs';
import { dirname } from 'path';

/** @type {Database.Database|null} */
let _db = null;

/**
 * Initialize (or retrieve) the database connection.
 *
 * @param {string} dbPath - Absolute path to the SQLite database file
 * @param {object} [options] - better-sqlite3 options
 * @param {boolean} [options.wal=true] - Enable WAL mode for better concurrent reads
 * @returns {Database.Database} Database instance
 */
export function initDb(dbPath, options = {}) {
    if (_db) return _db;

    // Ensure directory exists
    mkdirSync(dirname(dbPath), { recursive: true });

    _db = new Database(dbPath);

    if (options.wal !== false) {
        _db.pragma('journal_mode = WAL');
    }
    _db.pragma('foreign_keys = ON');

    return _db;
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
 * Close the database connection.
 */
export function closeDb() {
    if (_db) {
        _db.close();
        _db = null;
    }
}
