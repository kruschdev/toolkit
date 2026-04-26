/**
 * BuildOS — Shared Factor Override Module
 *
 * DOE Rule D4: Human always outranks AI.
 * Overridden factors get confidence = 1.0 instantly, no confirmation dialogs.
 *
 * Used by all trade packages to manage factor overrides at the estimate level.
 *
 * Usage (in any trade package):
 *   import { createOverrideClient } from '../../../lib/overrides.js';
 *   import { query, queryOne, run } from '../db.js';
 *   const overrides = createOverrideClient({ query, queryOne, run });
 */

/**
 * Create an override client bound to the given DB functions.
 * This pattern avoids import path issues across symlinked workspaces.
 *
 * @param {{ query: Function, queryOne: Function, run: Function }} db
 * @returns {Object} Override client with getOverrides, applyOverride, removeOverride, mergeFactorsWithOverrides
 */
export function createOverrideClient({ query, queryOne, run }) {

  /**
   * Get all overrides for an estimate.
   * @param {string} estimateId
   * @returns {Promise<Array>}
   */
  async function getOverrides(estimateId) {
    return query(
      'SELECT * FROM factor_overrides WHERE estimate_id = $1 ORDER BY factor_key',
      [estimateId]
    );
  }

  /**
   * Apply (upsert) a single factor override.
   * @param {string} estimateId
   * @param {string} trade
   * @param {string} factorKey
   * @param {number|null} originalValue
   * @param {number|null} originalConfidence
   * @param {number} overrideValue
   * @returns {Promise<{action: string, override: object}>}
   */
  async function applyOverride(estimateId, trade, factorKey, originalValue, originalConfidence, overrideValue) {
    const existing = await queryOne(
      'SELECT * FROM factor_overrides WHERE estimate_id = $1 AND factor_key = $2',
      [estimateId, factorKey]
    );

    if (existing) {
      await run(
        'UPDATE factor_overrides SET override_value = $1, created_at = NOW() WHERE id = $2',
        [overrideValue, existing.id]
      );
      return { action: 'updated', override: { ...existing, override_value: overrideValue } };
    }

    const result = await run(
      `INSERT INTO factor_overrides (estimate_id, trade, factor_key, original_value, original_confidence, override_value)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [estimateId, trade, factorKey, originalValue, originalConfidence, overrideValue]
    );
    return { action: 'created', override: result.rows[0] };
  }

  /**
   * Remove an override, restoring the AI-detected value.
   * @param {string} estimateId
   * @param {string} factorKey
   * @returns {Promise<boolean>}
   */
  async function removeOverride(estimateId, factorKey) {
    const result = await run(
      'DELETE FROM factor_overrides WHERE estimate_id = $1 AND factor_key = $2',
      [estimateId, factorKey]
    );
    return result.rowCount > 0;
  }

  return { getOverrides, applyOverride, removeOverride };
}

/**
 * Merge factor confidence data with overrides.
 * Overridden factors get confidence = 1.0 (DOE Rule D4).
 *
 * @param {object} lineItemData - The raw line item data (factor values)
 * @param {object} confidence - Per-factor confidence from AI analysis
 *   e.g. { sq_ft: 0.85, prep_hours: 0.7, paint_hours: 0.6 }
 * @param {Array} overrides - Override records from factor_overrides table
 * @returns {{ factors: object, confidence: object, overridden: string[] }}
 */
export function mergeFactorsWithOverrides(lineItemData, confidence, overrides) {
  const merged = { ...lineItemData };
  const mergedConfidence = { ...confidence };
  const overriddenKeys = [];

  const overrideMap = {};
  for (const o of overrides) {
    overrideMap[o.factor_key] = o;
  }

  for (const [key, override] of Object.entries(overrideMap)) {
    if (key in merged) {
      merged[key] = parseFloat(override.override_value);
      mergedConfidence[key] = 1.0;
      overriddenKeys.push(key);
    }
  }

  return {
    factors: merged,
    confidence: mergedConfidence,
    overridden: overriddenKeys,
  };
}
