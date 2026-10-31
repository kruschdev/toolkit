/**
 * @module log
 * @description Structured JSON Logging — Node.js parity with the Python krusch_toolkit log layer.
 * Sets up rotating file handlers with zero external dependencies. Every log entry is a parseable JSON object.
 */

import fs from 'fs';
import path from 'path';

/**
 * Custom rotating file writer to log structured records without pulling in heavy packages.
 */
class RotatingFileWriter {
    /**
     * @param {string} filepath Target output file path.
     * @param {number} maxBytes Maximum file size before rotation (default 10MB).
     * @param {number} backupCount Number of rotated backups to keep (default 5).
     */
    constructor(filepath, maxBytes = 10 * 1024 * 1024, backupCount = 5) {
        this.filepath = path.resolve(filepath);
        this.maxBytes = maxBytes;
        this.backupCount = backupCount;
        this.writeQueue = [];
        this.isWriting = false;

        // Ensure directories exist
        fs.mkdirSync(path.dirname(this.filepath), { recursive: true });
    }

    /**
     * Append a line asynchronously.
     * @param {string} line 
     */
    write(line) {
        this.writeQueue.push(line + '\n');
        this.processQueue();
    }

    async processQueue() {
        if (this.isWriting || this.writeQueue.length === 0) return;
        this.isWriting = true;

        const chunk = this.writeQueue.shift();
        try {
            await this.ensureRotation();
            await fs.promises.appendFile(this.filepath, chunk, 'utf-8');
        } catch (err) {
            process.stderr.write(`[Log Rotation Error] Failed to write log: ${err.message}\n`);
        } finally {
            this.isWriting = false;
            this.processQueue();
        }
    }

    async ensureRotation() {
        try {
            const stats = await fs.promises.stat(this.filepath);
            if (stats.size >= this.maxBytes) {
                await this.rotate();
            }
        } catch (err) {
            // File doesn't exist yet, which is fine
            if (err.code !== 'ENOENT') throw err;
        }
    }

    async rotate() {
        // Shift backups (e.g. log.4 -> log.5)
        for (let i = this.backupCount - 1; i >= 1; i--) {
            const src = `${this.filepath}.${i}`;
            const dest = `${this.filepath}.${i + 1}`;
            try {
                await fs.promises.rename(src, dest);
            } catch (err) {
                if (err.code !== 'ENOENT') {
                    process.stderr.write(`[Log Rotation Error] Shift rename failed: ${err.message}\n`);
                }
            }
        }

        // Rename active file to log.1
        try {
            await fs.promises.rename(this.filepath, `${this.filepath}.1`);
        } catch (err) {
            if (err.code !== 'ENOENT') {
                process.stderr.write(`[Log Rotation Error] Active rename failed: ${err.message}\n`);
            }
        }
    }
}

class Logger {
    /**
     * @param {string} appName Name of the application/logger.
     * @param {Object} options
     * @param {string} options.logDir Directory for log files.
     * @param {number} options.maxBytes Max size before rotation.
     * @param {number} options.backupCount Backups to keep.
     * @param {boolean} options.console Also stream output to stderr/stdout.
     */
    constructor(appName, { logDir = 'logs', maxBytes = 10 * 1024 * 1024, backupCount = 5, console = true } = {}) {
        this.appName = appName;
        this.console = console;

        const appLogPath = path.join(logDir, 'app.log');
        const errorLogPath = path.join(logDir, 'error.log');

        this.appWriter = new RotatingFileWriter(appLogPath, maxBytes, backupCount);
        this.errorWriter = new RotatingFileWriter(errorLogPath, maxBytes, backupCount);

        this.info(`Structured logger initialized for [${appName}] (dir=${logDir})`);
    }

    /**
     * Core payload formatting logic.
     * @param {string} level INFO | WARN | ERROR | DEBUG
     * @param {string} message 
     * @param {Object} [meta] Additional contextual data or error instances.
     */
    format(level, message, meta = {}) {
        const payload = {
            timestamp: new Date().toISOString(),
            level,
            logger: this.appName,
            message: message || '',
        };

        // If error instance is passed, extract message and stack
        if (meta instanceof Error) {
            payload.exception = `${meta.name}: ${meta.message}\nStack:\n${meta.stack}`;
        } else if (meta && typeof meta === 'object') {
            const { requestId, jobId, exception, error, ...rest } = meta;
            
            if (requestId) payload.request_id = requestId;
            if (jobId) payload.job_id = jobId;
            
            // Map common error indicators
            const errObj = error || exception;
            if (errObj instanceof Error) {
                payload.exception = `${errObj.name}: ${errObj.message}\nStack:\n${errObj.stack}`;
            } else if (errObj) {
                payload.exception = String(errObj);
            }

            if (Object.keys(rest).length > 0) {
                payload.meta = rest;
            }
        }

        return JSON.stringify(payload);
    }

    info(message, meta = {}) {
        const line = this.format('INFO', message, meta);
        this.appWriter.write(line);
        if (this.console) {
            console.log(`${new Date().toLocaleTimeString()} [${this.appName}] INFO: ${message}`);
        }
    }

    warn(message, meta = {}) {
        const line = this.format('WARN', message, meta);
        this.appWriter.write(line);
        if (this.console) {
            console.warn(`${new Date().toLocaleTimeString()} [${this.appName}] WARN: ${message}`);
        }
    }

    error(message, errorInstanceOrMeta = {}) {
        const line = this.format('ERROR', message, errorInstanceOrMeta);
        this.appWriter.write(line);
        this.errorWriter.write(line);
        if (this.console) {
            const errString = errorInstanceOrMeta instanceof Error ? ` - ${errorInstanceOrMeta.message}` : '';
            console.error(`${new Date().toLocaleTimeString()} [${this.appName}] ERROR: ${message}${errString}`);
        }
    }

    debug(message, meta = {}) {
        const line = this.format('DEBUG', message, meta);
        this.appWriter.write(line);
        if (this.console) {
            console.debug(`${new Date().toLocaleTimeString()} [${this.appName}] DEBUG: ${message}`);
        }
    }
}

/**
 * Configure structured JSON logging with rotating file handlers.
 * Matches python krusch_toolkit structured log formats exactly.
 * 
 * @param {string} appName Name of the application (logger domain).
 * @param {Object} [options] Custom rotation configurations.
 * @param {string} [options.logDir='logs'] Directory where logs are created.
 * @param {number} [options.maxBytes=10485760] Maximum log size in bytes before shifting.
 * @param {number} [options.backupCount=5] Number of backup files to retain.
 * @param {boolean} [options.console=true] Set to false to disable standard stdout/stderr logs.
 * @returns {Logger} Configured Logger instance.
 */
export function setupLogging(appName, options = {}) {
    return new Logger(appName, options);
}
