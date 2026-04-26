/**
 * @module edge/allowlist
 * Curated command allowlist for the Chrysalis Edge Swarm.
 * 
 * Only pre-approved, read-only shell commands pass validation.
 * This is the middle path between "no shell" and "arbitrary bash" —
 * the swarm can observe infrastructure without mutating it.
 * 
 * SECURITY: No pipes, redirects, semicolons, backticks, or $() allowed.
 * Commands are matched against explicit regex patterns.
 */

/** Nodes the swarm is allowed to SSH into */
const ALLOWED_SSH_NODES = ['kruschserv', 'kruschgame', 'kruschdev'];

/**
 * @typedef {object} AllowlistRule
 * @property {string} name - Human-readable rule identifier
 * @property {RegExp} pattern - Regex the raw command must match (full match)
 * @property {number} timeout - Max execution time in ms
 * @property {string} description - For LLM tool schema context
 */

/** @type {AllowlistRule[]} */
const ALLOWLIST = [
  // ── Scripts ───────────────────────────────────────────────────────────────
  {
    name: '/home/kruschdev/homelab/scripts/health_check.sh',
    pattern: /^\/home\/kruschdev\/homelab\/scripts\/health_check\.sh$/,
    timeout: 30_000,
    description: 'Execute the global homelab health dashboard script'
  },

  // ── Docker Inspection ─────────────────────────────────────────────────────
  {
    name: 'docker-ps',
    pattern: /^docker ps(?:\s+--format\s+"[^"]{1,80}")?(?:\s+--filter\s+"[^"]{1,80}")*(?:\s+-a)?$/,
    timeout: 10_000,
    description: 'List running containers with optional format/filter flags'
  },
  {
    name: 'docker-logs',
    pattern: /^docker logs\s+--tail\s+\d{1,4}\s+[a-zA-Z0-9_-]{1,80}$/,
    timeout: 15_000,
    description: 'View recent container logs (must specify --tail N and container name)'
  },
  {
    name: 'docker-inspect',
    pattern: /^docker inspect\s+[a-zA-Z0-9_-]{1,80}$/,
    timeout: 10_000,
    description: 'Inspect a container by name'
  },
  {
    name: 'docker-stats-snapshot',
    pattern: /^docker stats\s+--no-stream(?:\s+[a-zA-Z0-9_-]{1,80})*$/,
    timeout: 10_000,
    description: 'One-shot container resource usage snapshot'
  },

  // ── Git Status ────────────────────────────────────────────────────────────
  {
    name: 'git-status',
    pattern: /^git\s+(?:-C\s+[/a-zA-Z0-9._-]{1,120}\s+)?status(?:\s+--short)?$/,
    timeout: 10_000,
    description: 'Show working tree status'
  },
  {
    name: 'git-log',
    pattern: /^git\s+(?:-C\s+[/a-zA-Z0-9._-]{1,120}\s+)?log\s+-n\s+\d{1,2}(?:\s+--oneline)?$/,
    timeout: 10_000,
    description: 'Show recent git commits (must specify -n N, max 99)'
  },
  {
    name: 'git-diff-stat',
    pattern: /^git\s+(?:-C\s+[/a-zA-Z0-9._-]{1,120}\s+)?diff\s+--stat$/,
    timeout: 10_000,
    description: 'Show changed files summary (stat only, no content)'
  },

  // ── System Monitoring ─────────────────────────────────────────────────────
  {
    name: 'uptime',
    pattern: /^uptime$/,
    timeout: 5_000,
    description: 'Show system uptime and load averages'
  },
  {
    name: 'free',
    pattern: /^free\s+-h$/,
    timeout: 5_000,
    description: 'Show memory usage in human-readable format'
  },
  {
    name: 'df',
    pattern: /^df\s+-h(?:\s+[/a-zA-Z0-9._-]{1,120})?$/,
    timeout: 5_000,
    description: 'Show disk usage in human-readable format'
  },
  {
    name: 'nvidia-smi',
    pattern: /^nvidia-smi(?:\s+--query-gpu=[a-zA-Z0-9_.,]+\s+--format=csv(?:,noheader)?)?$/,
    timeout: 10_000,
    description: 'Show NVIDIA GPU status and utilization'
  },

  // ── Network Health ────────────────────────────────────────────────────────
  {
    name: 'curl-health',
    pattern: /^curl\s+-s(?:\s+-o\s+\/dev\/null\s+-w\s+"%\{http_code\}")?\s+http:\/\/localhost:\d{1,5}\/[a-zA-Z0-9/_-]{0,60}$/,
    timeout: 10_000,
    description: 'Check a localhost HTTP endpoint (health checks only)'
  },
  {
    name: 'tailscale-status',
    pattern: /^tailscale\s+status$/,
    timeout: 10_000,
    description: 'Show Tailscale mesh VPN peer status'
  }
];

/** Characters that are NEVER allowed in any command (injection prevention) */
const FORBIDDEN_CHARS = /[;|&`$(){}\\><\n\r]/;

/**
 * Validate a command against the allowlist.
 * Returns the matching rule if allowed, null if rejected.
 * 
 * @param {string} command - Raw command string to validate
 * @returns {AllowlistRule|null} Matching rule or null
 */
export function validateCommand(command) {
  if (!command || typeof command !== 'string') return null;
  
  const trimmed = command.trim();
  
  // Hard reject any injection characters before even checking patterns
  if (FORBIDDEN_CHARS.test(trimmed)) return null;
  
  // Hard reject empty or suspiciously long commands
  if (trimmed.length === 0 || trimmed.length > 300) return null;
  
  for (const rule of ALLOWLIST) {
    if (rule.pattern.test(trimmed)) return rule;
  }
  
  return null;
}

/**
 * Validate a command intended for SSH bridging.
 * The inner command must pass the same allowlist, and the target node must be allowed.
 * 
 * @param {string} node - Target SSH node
 * @param {string} innerCommand - Command to run on the remote node
 * @returns {AllowlistRule|null} Matching rule or null
 */
export function validateRemoteCommand(node, innerCommand) {
  if (!ALLOWED_SSH_NODES.includes(node)) return null;
  return validateCommand(innerCommand);
}

/**
 * Get all rules formatted for LLM tool schema description.
 * @returns {string} Human-readable command list
 */
export function getAllowlistDescription() {
  return ALLOWLIST.map(r => `• '${r.name.replace(/-/g, ' ')}' : ${r.description}`).join('\n') + '\n\nIMPORTANT: Use the exact command text shown in quotes above, DO NOT hyphenate the name.';
}

/**
 * Get timeout for a validated command.
 * @param {AllowlistRule} rule - Validated rule from validateCommand
 * @returns {number} Timeout in milliseconds
 */
export function getTimeout(rule) {
  return rule?.timeout || 15_000;
}

export { ALLOWLIST, ALLOWED_SSH_NODES };
