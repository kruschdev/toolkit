/**
 * @module llm-queue
 * Priority queue for Ollama inference requests.
 * Prevents local or multi-node endpoints from being overwhelmed by batch tasks while prioritizing real-time agents.
 */

import { envOr } from './config.js';

export const PRIORITY = {
    CRITICAL: 0, // Real-time UI / active IDE session
    HIGH: 1,     // Interactive agent
    MEDIUM: 2,   // Background agent processing
    LOW: 3       // Bulk embeddings / offline tasks
};

export class AsyncLock {
    constructor() {
        this._chains = new Map();
    }

    async acquire(key, fn) {
        const prev = this._chains.get(key) || Promise.resolve();
        let release;
        const next = new Promise((resolve) => {
            release = resolve;
        });
        const current = prev.then(() => next);
        this._chains.set(key, current);
        await prev;
        try {
            return await fn();
        } finally {
            release();
            if (this._chains.get(key) === current) {
                this._chains.delete(key);
            }
        }
    }
}

export const DEFAULT_FLEET_OLLAMA_NODES = Object.freeze([
    'http://127.0.0.1:11434'
]);

export class PriorityQueue {
    constructor(concurrency = 3) {
        this.concurrency = Number.isInteger(concurrency) && concurrency > 0 ? concurrency : 3;
        this.active = 0;
        this.queue = [];
        this.endpoints = this.initEndpoints();
        this.rrIndex = 0;
        this._lock = new AsyncLock();
    }

    initEndpoints() {
        const confUrl = envOr('OLLAMA_URL');
        const nodes = envOr('OLLAMA_NODES');
        if (nodes) {
            const parsed = String(nodes)
                .split(',')
                .map((n) => n.trim())
                .filter(Boolean);
            if (parsed.length > 0) return parsed;
        }
        if (confUrl) {
            const trimmedUrl = String(confUrl).trim();
            if (trimmedUrl) {
                return [trimmedUrl, ...DEFAULT_FLEET_OLLAMA_NODES.filter((n) => n !== trimmedUrl)];
            }
        }
        return [...DEFAULT_FLEET_OLLAMA_NODES];
    }

    getNextEndpoint() {
        const ep = this.endpoints[this.rrIndex];
        this.rrIndex = (this.rrIndex + 1) % this.endpoints.length;
        return ep;
    }

    /**
     * Enqueue a task to run against an Ollama endpoint.
     * @param {function(string): Promise<unknown>} taskFn - The async function to run, receives endpoint URL.
     * @param {number} priority - Lower number = higher priority.
     */
    enqueue(taskFn, priority = PRIORITY.MEDIUM) {
        return new Promise((resolve, reject) => {
            this._lock.acquire('pq', () => {
                this.queue.push({ taskFn, priority, resolve, reject });
                // Re-sort queue so lowest priority number is first
                this.queue.sort((a, b) => a.priority - b.priority);
            }).then(() => {
                void this.process();
            }).catch(reject);
        });
    }

    async process() {
        const item = await this._lock.acquire('pq', () => {
            if (this.active >= this.concurrency || this.queue.length === 0) return null;
            this.active++;
            return this.queue.shift();
        });
        if (!item) return;

        let outcome = null;
        try {
            if (typeof item.taskFn !== 'function') {
                outcome = { ok: false, error: new TypeError('[OllamaQueue] taskFn must be a function') };
            } else if (!Array.isArray(this.endpoints) || this.endpoints.length === 0) {
                outcome = { ok: false, error: new Error('[OllamaQueue] No Ollama endpoints configured') };
            } else {
                let attempts = 0;
                const maxAttempts = this.endpoints.length;
                let lastErr = null;

                while (attempts < maxAttempts && !outcome) {
                    const endpoint = await this._lock.acquire('pq', () => this.getNextEndpoint());
                    try {
                        const result = await item.taskFn(endpoint);
                        outcome = { ok: true, value: result };
                    } catch (err) {
                        const errMsg = err instanceof Error ? err.message : String(err);
                        console.warn(`[OllamaQueue] Endpoint ${endpoint} failed: ${errMsg}. Retrying...`);
                        lastErr = err;
                        attempts++;
                    }
                }

                if (!outcome) {
                    const lastMsg = lastErr instanceof Error ? lastErr.message : String(lastErr);
                    outcome = {
                        ok: false,
                        error: new Error(`[OllamaQueue] All fleet nodes failed. Last error: ${lastMsg}`)
                    };
                }
            }
        } catch (unexpectedErr) {
            outcome = {
                ok: false,
                error: unexpectedErr instanceof Error ? unexpectedErr : new Error(String(unexpectedErr))
            };
        } finally {
            await this._lock.acquire('pq', () => {
                this.active = Math.max(0, this.active - 1);
            });
            // Automatically process the next queued task before resuming caller continuations
            void this.process();
            if (outcome?.ok) {
                item.resolve(outcome.value);
            } else {
                item.reject(outcome?.error ?? new Error('[OllamaQueue] Queue task failed'));
            }
        }
    }
}

// Default concurrency allows 3 parallel requests across configured endpoints
export const ollamaQueue = new PriorityQueue(
    process.env.OLLAMA_MAX_CONCURRENCY ? parseInt(process.env.OLLAMA_MAX_CONCURRENCY, 10) : 3
);
export const globalQueue = ollamaQueue;

