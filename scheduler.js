/**
 * @module scheduler
 * Cron-based task scheduler with error handling and logging.
 *
 * Usage:
 *   import { createScheduler } from '@krusch/toolkit/scheduler';
 *   const scheduler = createScheduler();
 *   scheduler.add('daily-report', '0 9 * * *', async () => { ... });
 *   scheduler.start();
 */

import cron from 'node-cron';

/**
 * Create a scheduler instance that manages multiple cron jobs.
 *
 * @returns {object} Scheduler with add(), start(), stop(), runOnce() methods
 */
export function createScheduler() {
    const jobs = new Map();

    /**
     * Register a scheduled job.
     *
     * @param {string} name - Job name for logging
     * @param {string} schedule - Cron expression
     * @param {Function} handler - Async function to execute
     * @param {object} [options]
     * @param {boolean} [options.runImmediately=false] - Run once on start
     */
    function add(name, schedule, handler, options = {}) {
        if (!cron.validate(schedule)) {
            throw new Error(`Invalid cron expression for "${name}": ${schedule}`);
        }
        jobs.set(name, { name, schedule, handler, options, job: null });
    }

    /**
     * Start all registered jobs.
     */
    function start() {
        console.log(`⏰ Starting scheduler with ${jobs.size} jobs...`);

        for (const [name, entry] of jobs) {
            console.log(`   📌 ${name}: ${entry.schedule}`);

            entry.job = cron.schedule(entry.schedule, async () => {
                console.log(`\n🔄 [${new Date().toISOString()}] Running: ${name}`);
                try {
                    await entry.handler();
                    console.log(`✅ ${name} completed`);
                } catch (err) {
                    console.error(`❌ ${name} failed: ${err.message}`);
                }
            });

            if (entry.options.runImmediately) {
                console.log(`   ▶️  Running ${name} immediately...`);
                entry.handler().catch(err => console.error(`❌ ${name} immediate run failed: ${err.message}`));
            }
        }

        console.log('✅ Scheduler running.');
    }

    /**
     * Stop all scheduled jobs.
     */
    function stop() {
        for (const [name, entry] of jobs) {
            if (entry.job) {
                entry.job.stop();
                entry.job = null;
            }
        }
        console.log('⏹️  Scheduler stopped.');
    }

    /**
     * Run a specific job immediately (manual trigger).
     *
     * @param {string} name - Job name
     * @returns {Promise<*>} Result of the handler
     */
    async function runOnce(name) {
        const entry = jobs.get(name);
        if (!entry) throw new Error(`Unknown job: ${name}`);
        console.log(`🔄 Manual run: ${name}`);
        return entry.handler();
    }

    /**
     * List all registered jobs and their schedules.
     *
     * @returns {Array<{name: string, schedule: string, running: boolean}>}
     */
    function list() {
        return Array.from(jobs.values()).map(e => ({
            name: e.name,
            schedule: e.schedule,
            running: !!e.job,
        }));
    }

    return { add, start, stop, runOnce, list };
}
