/**
 * @module lib/job-context
 * Shared job context enrichment engine for all BuildOS trades.
 *
 * Evaluates trade-specific best practice rules against the current job context
 * and builds an enriched prompt section with both field values and triggered alerts.
 *
 * Usage:
 *   import { buildEnrichedJobContext } from '../../lib/job-context.js';
 *   const section = buildEnrichedJobContext('spark', jobContext, SPARK_CONTEXT_FIELDS);
 */
import { buildContextSection } from '@krusch/toolkit/agents';

// ── Lazy rule loader ─────────────────────────────────────
// Trade knowledge modules are loaded once and cached.
const ruleCache = new Map();

/**
 * Load trade-specific best practice rules.
 * @param {string} trade - Trade identifier (e.g. 'spark', 'drainflux')
 * @returns {Promise<Array>} Array of rule objects
 */
async function loadRules(trade) {
  if (ruleCache.has(trade)) return ruleCache.get(trade);

  try {
    // Dynamic import from the trade-knowledge directory
    const mod = await import(`./trade-knowledge/${trade}.js`);
    const rules = mod.default || [];
    ruleCache.set(trade, rules);
    return rules;
  } catch (err) {
    console.warn(`⚠️  No trade knowledge rules found for "${trade}":`, err.message);
    ruleCache.set(trade, []);
    return [];
  }
}

// ── Category labels & order ──────────────────────────────
const CATEGORY_LABELS = {
  safety:   '🛑 Safety Alerts',
  code:     '📋 Code Requirements',
  practice: '💡 Best Practices',
  warning:  '⚠️ Warnings',
};
const CATEGORY_ORDER = ['safety', 'code', 'warning', 'practice'];

/**
 * Build an enriched job context section for LLM prompts.
 *
 * Combines the basic field-value listing (existing behavior) with
 * condition-triggered best practice rules from the trade knowledge files.
 *
 * @param {string} trade - Trade identifier
 * @param {object|null} jobContext - Raw job context JSONB from the jobs table
 * @param {object} contextFields - Field mapping { fieldKey: 'Label' | { label, format } }
 * @returns {Promise<string>} Formatted prompt section (empty string if no context)
 */
export async function buildEnrichedJobContext(trade, jobContext, contextFields) {
  // No context → no section
  if (!jobContext || typeof jobContext !== 'object' || Object.keys(jobContext).length === 0) {
    return '';
  }

  // 1. Build the basic field-value section (existing behavior)
  const fieldSection = buildContextSection(jobContext, contextFields);

  // 2. Evaluate trade-specific rules
  const rules = await loadRules(trade);
  const triggered = [];

  for (const rule of rules) {
    try {
      if (rule.condition(jobContext)) {
        triggered.push(rule);
      }
    } catch {
      // Condition evaluation failed — skip silently
    }
  }

  // 3. If no rules triggered, return just the field section
  if (triggered.length === 0) return fieldSection;

  // 4. Group triggered rules by category
  const grouped = {};
  for (const rule of triggered) {
    const cat = rule.category || 'practice';
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(rule);
  }

  // 5. Build the enrichment section
  const parts = [];
  for (const cat of CATEGORY_ORDER) {
    if (!grouped[cat]) continue;
    const label = CATEGORY_LABELS[cat] || cat;
    parts.push(`### ${label}`);
    for (const rule of grouped[cat]) {
      parts.push(`**${rule.title}**\n${rule.content}`);
    }
  }

  const enrichmentBlock = parts.join('\n\n');
  const ruleCount = triggered.length;
  const cats = [...new Set(triggered.map(r => r.category))].join(', ');

  return `${fieldSection}

## Industry Best Practices (${ruleCount} rules triggered: ${cats})
${enrichmentBlock}`;
}
