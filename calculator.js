/**
 * @module calculator
 * Shared BuildOS calculation utilities — pure math, zero AI/LLM/async.
 *
 * Every trade calculator imports these shared functions.
 * Same inputs → same outputs, every time, guaranteed.
 *
 * Usage:
 *   import { applyWaste, round2, confidenceEnvelope } from '@krusch/toolkit/calculator';
 */

// ==========================================
// Core Math Utilities
// ==========================================

/**
 * Round to 2 decimal places (cents).
 * @param {number} n
 * @returns {number}
 */
export function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Apply waste factor to a base quantity.
 * @param {number} baseQty - Calculated quantity before waste
 * @param {number} wastePct - Waste percentage (e.g., 5 = 5%)
 * @returns {number} Adjusted quantity, always rounded up
 */
export function applyWaste(baseQty, wastePct) {
  return Math.ceil(baseQty * (1 + wastePct / 100));
}

// ==========================================
// Pricing Utilities
// ==========================================

/**
 * Calculate contractor cost from materials + labor.
 * @param {number} materialCost - Total material cost
 * @param {number} laborCost - Total labor cost
 * @returns {number} Contractor cost (rounded to cents)
 */
export function contractorCost(materialCost, laborCost) {
  return round2(materialCost + laborCost);
}

/**
 * Calculate customer price with markup.
 * @param {number} cost - Contractor cost
 * @param {number} markupPct - Markup percentage
 * @returns {number} Customer price (rounded to cents)
 */
export function customerPrice(cost, markupPct) {
  return round2(cost * (1 + markupPct / 100));
}

/**
 * Calculate dual pricing (contractor cost + customer price + profit).
 * @param {number} cost - Contractor cost (materials + labor)
 * @param {number} markupPct - Markup percentage (default 30)
 * @returns {{ contractorCost: number, customerPrice: number, profit: number }}
 */
export function calcDualPricing(cost, markupPct = 30) {
  const cc = round2(cost);
  const cp = customerPrice(cc, markupPct);
  return {
    contractorCost: cc,
    customerPrice: cp,
    profit: round2(cp - cc),
  };
}

// ==========================================
// Catalog Lookup
// ==========================================

/**
 * Find a price from a materials catalog by item type, with optional keyword matching.
 * Works with any catalog array that has { item_type, price_per_unit, description? } entries.
 *
 * @param {Array} catalog - Array of catalog entries
 * @param {string} itemType - Item type to match
 * @param {...string} keywords - Optional keywords to match in description/dimensions
 * @returns {number|null} Price or null if not found
 */
export function findCatalogPrice(catalog, itemType, ...keywords) {
  if (!catalog || !catalog.length) return null;
  const matches = catalog.filter(c => c.item_type === itemType);
  if (!matches.length) return null;

  if (keywords.length) {
    const keywordMatch = matches.find(c => {
      const searchField = (c.description || c.dimensions || '').toLowerCase();
      return keywords.every(kw => searchField.includes(String(kw).toLowerCase()));
    });
    if (keywordMatch) return keywordMatch.price_per_unit;
  }

  return matches[0].price_per_unit;
}

// ==========================================
// Confidence Envelope (DOE Bridge)
// ==========================================

/**
 * Generate confidence envelope from factor uncertainties.
 * Bridges the AI perception layer (uncertain measurements) with
 * deterministic calculation (repeatable math).
 *
 * Factors can be either:
 *  - Plain values: { key: 42 }           → treated as 100% confidence
 *  - Scored values: { key: { value: 42, confidence: 0.88 } }
 *
 * @param {Function} calcFn - Deterministic calculation function (factors → number)
 * @param {object} factors - Input factors, optionally with confidence scores
 * @returns {{ best: number, low: number, high: number, confidence: number }}
 */
export function confidenceEnvelope(calcFn, factors) {
  // Extract plain values for best estimate
  const plainFactors = {};
  const lowFactors = {};
  const highFactors = {};
  let totalConfidence = 0;
  let factorCount = 0;

  for (const [key, val] of Object.entries(factors)) {
    if (typeof val === 'object' && val !== null && val.value !== undefined) {
      // Factor with confidence score
      const uncertainty = 1 - (val.confidence || 0.5);
      plainFactors[key] = val.value;
      lowFactors[key] = val.value * (1 - uncertainty * 0.2);
      highFactors[key] = val.value * (1 + uncertainty * 0.2);
      totalConfidence += val.confidence || 0.5;
      factorCount++;
    } else {
      // Plain value — 100% confidence (manual entry or fixed constant)
      plainFactors[key] = val;
      lowFactors[key] = val;
      highFactors[key] = val;
    }
  }

  const best = calcFn(plainFactors);

  return {
    best,
    low: calcFn(lowFactors),
    high: calcFn(highFactors),
    confidence: factorCount > 0
      ? Math.round((totalConfidence / factorCount) * 100)
      : 100, // All manual entry = 100% confidence
  };
}
