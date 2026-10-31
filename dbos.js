/**
 * @module dbos
 * @description Standardized DBOS Client and Swarm Queue Utilities for Krusch Agentic Backends.
 * Encapsulates transactional state enqueuing, polling, queue healing, and distributed coordination.
 */

import pg from 'pg';
import { randomUUID } from 'crypto';

/**
 * Creates a DBOS integration client wrapper for standard agentic queues.
 * 
 * @param {string} connectionString PostgreSQL connection URI (e.g. postgres://postgres:postgres@localhost:5432/appdb)
 * @returns {DbosClient} Instantiated DBOS Queue Client
 */
export function createDbosClient(connectionString) {
    const pool = new pg.Pool({ connectionString });
    return new DbosClient(pool);
}

export class DbosClient {
    /**
     * @param {import('pg').Pool} pool 
     */
    constructor(pool) {
        this.pool = pool;
    }

    /**
     * Closes the underlying pg pool.
     */
    async close() {
        await this.pool.end();
    }

    /**
     * Fire-and-forget method to enqueue a task into the execution queue.
     * Useful for asynchronous pipelines or background worker dispatching.
     * 
     * @param {Object} params
     * @param {string} params.task Short name or task category.
     * @param {string} params.instructions Detailed execution instructions.
     * @param {string} [params.jobType='intent'] Category (e.g. 'intent', 'debate_proposal', 'rebuttal').
     * @param {string} [params.targetNode='any'] Explicit fleet node constraint (e.g. 'gpu-worker-1').
     * @param {Object} [params.meta] Additional metadata object merged into payload context.
     * @returns {Promise<{ jobId: string, threadId: string }>}
     */
    async enqueueJob({ task, instructions, jobType = 'intent', targetNode = 'any', meta = {} }) {
        const jobId = randomUUID();
        const threadId = randomUUID();

        const payload = {
            task,
            instructions,
            context: {
                dispatched_by: 'krusch_toolkit_dbos',
                target_node: targetNode,
                ...meta
            }
        };

        await this.pool.query(`
            INSERT INTO agent_execution_queue (job_id, thread_id, job_type, payload, status, started_at_ms)
            VALUES ($1, $2, $3, $4, 'pending', $5)
        `, [jobId, threadId, jobType, payload, Date.now()]);

        return { jobId, threadId };
    }

    /**
     * Enqueues a job and blocks until completion, supporting active await patterns for agent debates.
     * 
     * @param {Object} params
     * @param {string} params.task Short name or task category.
     * @param {string} params.instructions Detailed execution instructions.
     * @param {string} [params.jobType='intent'] Job classification.
     * @param {string} [params.targetNode='any'] Fleet target.
     * @param {number} [params.timeoutMs=120000] Timeout threshold before throwing a rejection error.
     * @param {Object} [params.meta] Extra metadata payload.
     * @returns {Promise<Object>} Completed job result.
     */
    async dispatchJob({ task, instructions, jobType = 'intent', targetNode = 'any', timeoutMs = 120000, meta = {} }) {
        const { jobId } = await this.enqueueJob({ task, instructions, jobType, targetNode, meta });
        const startMs = Date.now();

        while (Date.now() - startMs < timeoutMs) {
            const res = await this.pool.query(
                `SELECT status, result FROM agent_execution_queue WHERE job_id = $1`, 
                [jobId]
            );

            const row = res.rows[0];
            if (!row) {
                throw new Error(`Job ${jobId} was orphaned or deleted from the queue.`);
            }

            if (row.status === 'completed') {
                return row.result;
            }

            if (row.status === 'failed') {
                throw new Error(`DBOS Job failed: ${JSON.stringify(row.result)}`);
            }

            if (row.status === 'auto_rejected') {
                throw new Error(`DBOS Job rejected by safety filter: ${JSON.stringify(row.result)}`);
            }

            // Poll delay
            await new Promise(resolve => setTimeout(resolve, 2000));
        }

        throw new Error(`DBOS Dispatch timeout: job ${jobId} failed to complete in ${timeoutMs / 1000}s.`);
    }

    /**
     * Queries the status of a specific job.
     * 
     * @param {string} jobId 
     * @returns {Promise<{ status: string, result: any, picked_at_ms: number, completed_at_ms: number } | null>}
     */
    async getJobStatus(jobId) {
        const res = await this.pool.query(
            `SELECT status, result, picked_at_ms, completed_at_ms FROM agent_execution_queue WHERE job_id = $1`,
            [jobId]
        );
        return res.rows[0] || null;
    }

    /**
     * SRE Self-Healing Sweep: Automatically recovers hung application-level jobs.
     * Force-fails running jobs that exceeded the timeout threshold.
     * 
     * @param {Object} [options]
     * @param {number} [options.appTimeoutMs=300000] Timout limit (default 5 minutes).
     * @returns {Promise<{ triaged: number, failed: number }>}
     */
    async healQueue({ appTimeoutMs = 300000 } = {}) {
        const selectRes = await this.pool.query(
            `SELECT job_id, status, started_at_ms 
             FROM agent_execution_queue 
             WHERE status IN ('running', 'processing_heavy_inference')`
        );

        const now = Date.now();
        let failedCount = 0;

        for (const row of selectRes.rows) {
            const startedAt = parseInt(row.started_at_ms || "0");
            const ageMs = now - startedAt;

            if (ageMs > appTimeoutMs) {
                await this.pool.query(
                    `UPDATE agent_execution_queue 
                     SET status = 'failed', 
                         result = $2 
                     WHERE job_id = $1`,
                    [
                        row.job_id,
                        JSON.stringify({ 
                            error: `System Timeout: Execution hung for ${Math.round(ageMs / 1000)}s and was auto-recovered by SRE sweep.` 
                        })
                    ]
                );
                failedCount++;
            }
        }

        return { triaged: selectRes.rows.length, failed: failedCount };
    }

    /**
     * SRE DBOS Core Sweep: Forces hung DBOS workflows from PENDING -> SUCCESS.
     * Prevents recovery execution loops.
     * 
     * @param {string} sysConnectionString System database URI (e.g. postgres://postgres:postgres@localhost:5432/dbos_sys)
     * @returns {Promise<number>} Number of system workflows successfully recovered.
     */
    async healSystemWorkflows(sysConnectionString) {
        const sysPool = new pg.Pool({ connectionString: sysConnectionString });
        try {
            const res = await sysPool.query(
                `SELECT workflow_uuid, status 
                 FROM dbos.workflow_status 
                 WHERE status = 'PENDING'`
            );

            for (const row of res.rows) {
                await sysPool.query(
                    `UPDATE dbos.workflow_status 
                     SET status = 'SUCCESS' 
                     WHERE workflow_uuid = $1`,
                    [row.workflow_uuid]
                );
            }

            return res.rows.length;
        } finally {
            await sysPool.end();
        }
    }
}
