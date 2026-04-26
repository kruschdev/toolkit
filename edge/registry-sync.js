#!/usr/bin/env node

import { exec } from 'node:child_process';
import util from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'url';

const execAsync = util.promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const EDGE_NODES = [
  { name: 'kruschdev_worker', type: 'docker', container: 'edge-worker' },
  { name: 'kruschdev_director', type: 'docker', container: 'edge-director' },
  { name: 'kruschgame', type: 'ssh' },
  { name: 'krmac13', type: 'ssh' },
  { name: 'kr1yoga', type: 'ssh' }
];

/**
 * Syncs the local SQLite registry cache to edge nodes.
 * This guarantees edge nodes can continue to route persona instructions 
 * if the Postgres connection goes offline or the orchestrator detaches.
 */
export async function syncRegistryToEdge() {
  const dbPath = path.join(__dirname, 'registry-cache.db');
  console.log(`[Registry-Sync] Pushing federated db snapshot: ${dbPath}`);

  const results = [];
  for (const node of EDGE_NODES) {
    try {
      if (node.type === 'docker') {
          // Push to local container path
          await execAsync(`docker exec ${node.container} mkdir -p /home/kruschdev/homelab/lib/edge`).catch(() => {});
          await execAsync(`docker cp ${dbPath} ${node.container}:/home/kruschdev/homelab/lib/edge/registry-cache.db`);
          console.log(`   ✅ Synced to Docker container ${node.container} (${node.name})`);
      } else if (node.type === 'ssh') {
          // Push to remote node via SHH/SCP
          await execAsync(`ssh -o ConnectTimeout=2 -o StrictHostKeyChecking=no ${node.name} "mkdir -p /home/kruschdev/homelab/lib/edge"`);
          await execAsync(`scp -o ConnectTimeout=2 -o StrictHostKeyChecking=no ${dbPath} ${node.name}:/home/kruschdev/homelab/lib/edge/registry-cache.db`);
          console.log(`   ✅ Synced to SSH node ${node.name}`);
      }
      results.push({ node: node.name, status: 'success' });
    } catch (err) {
      console.warn(`   ❌ Failed to sync to ${node.name}: ${err.message}`);
      results.push({ node: node.name, status: 'error', error: err.message });
    }
  }
  return results;
}

// Allow CLI execution
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  syncRegistryToEdge().catch(e => {
    console.error('[Registry-Sync] Fatal error:', e);
    process.exit(1);
  });
}
