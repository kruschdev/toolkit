import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { EventEmitter } from 'events';
import { sseResponse } from '../streaming.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const globalSwarmBus = new EventEmitter();
let isRunning = false;

/**
 * Initializes the Swarm telemetry dashboard server on port 3033.
 */
export function startDashboard() {
    if (isRunning) return;
    
    // We only spawn the UI if we're not inside a recursive child process to prevent port collisions
    if (process.env.CHILD_MODE) return;
    
    const app = express();
    const PORT = 3033;

    // Serve the sleek HTML dashboard
    app.use(express.static(path.join(__dirname, 'public')));

    // SSE Stream endpoint
    app.get('/api/stream', (req, res) => {
        const sse = sseResponse(res);
        
        // Listen to global Swarm Bus and pipe it!
        const listener = (msg) => {
            sse.send({ timestamp: new Date().toISOString(), message: msg });
        };
        globalSwarmBus.on('thought', listener);
        
        // Let it know we're connected
        sse.send({ timestamp: new Date().toISOString(), message: '--- Hive Telemetry Connected ---' });

        req.on('close', () => {
            globalSwarmBus.off('thought', listener);
            sse.end();
        });
    });

    // Internal IPC Publisher endpoint for cross-script telemetry
    app.use(express.json());
    app.post('/api/publish', (req, res) => {
        if (req.body.message) {
            globalSwarmBus.emit('thought', req.body.message);
        }
        res.status(200).send('OK');
    });

    app.listen(PORT, () => {
        console.log(`\n  🖥️  [Telemetry] Swarm Glassmorphism Dashboard live at http://localhost:${PORT}`);
    }).on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            // Port taken. We are a child process. Forward logs to the master.
            globalSwarmBus.on('thought', (msg) => {
                fetch(`http://localhost:${PORT}/api/publish`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ message: msg })
                }).catch(() => {});
            });
        }
    });
    
    isRunning = true;
}
