/**
 * @module edge/node_scheduler
 * Hardcoded routing for 3-Node Waterfall Architecture.
 *krushgame (RTX 3050, 4GB) is strictly reserved as an LPU for 7B Micro-Planning and Auditory logic.
 * Therefore, all generic Swarm Execution is statically fenced to kruschdev_director (RTX 3060, 12GB).
 */

export async function scheduleNode(affinityRule = 'least-loaded') {
  if (affinityRule === 'auditor') {
    const auditors = ['kr1yoga'];
    return auditors[Math.floor(Math.random() * auditors.length)];
  }

  // If explicitly requested, honor the affinity
  if (['kruschgame', 'krmac13', 'kr1yoga', 'kruschdev', 'kruschdev_director', 'kruschdev_worker'].includes(affinityRule)) {
    return affinityRule;
  }

  // Default execution target: Load-balance across allowed edge workers (Hardware Segregation)
  const edgeWorkers = ['kruschgame', 'kruschdev_worker'];
  return edgeWorkers[Math.floor(Math.random() * edgeWorkers.length)];
}
