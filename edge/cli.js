import { loadProjectConfig } from '../config.js';

async function runEdgeSwarm() {
  const rootDir = '/home/kruschdev/homelab';
  await loadProjectConfig(rootDir);
  const taskRequest = process.argv[2] || "deploy pocket lawyer";

  console.log(`\n[Input Task]: ${taskRequest}\n`);

  try {
    console.log('[System] Dispatching task to Daemon (port 18888)...');
    const res = await fetch('http://127.0.0.1:18888/api/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskRequest }),
    });

    if (!res.ok) {
        throw new Error(`Daemon responded with status ${res.status}: ${await res.text()}`);
    }

    const data = await res.json();
    console.log(`\n[System] Edge Swarm Execution Complete.`);
    console.log(JSON.stringify(data.history, null, 2));

    process.exit(0);
  } catch (err) {
    console.error(`\n[Fatal Error] Could not connect to daemon. Is it running? (${err.message})`);
    process.exit(1);
  }
}

runEdgeSwarm();
