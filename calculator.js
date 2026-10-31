/**
 * Shared calculation utilities for estimation.
 */

export function applyWaste(baseQty, wastePct) {
  return Math.ceil(baseQty * (1 + (wastePct || 0) / 100));
}

export function round2(val) {
  if (val === undefined || val === null || isNaN(val)) return 0;
  return Math.round(val * 100) / 100;
}

export function contractorCost(materialCost, laborCost) {
  return round2((materialCost || 0) + (laborCost || 0));
}

export function customerPrice(cost, markupPct) {
  return round2((cost || 0) * (1 + (markupPct || 0) / 100));
}

export function calcDualPricing(contractorCostVal, markupPct) {
  const cCost = contractorCostVal || 0;
  const markup = markupPct || 0;
  const price = customerPrice(cCost, markup);
  return {
    contractorCost: cCost,
    customerPrice: price,
    markupPct: markup,
    profit: round2(price - cCost)
  };
}

export function findCatalogPrice(catalog, itemType, descSubstring = null) {
  if (!catalog || !Array.isArray(catalog)) return null;
  const matches = catalog.filter(item => item.item_type === itemType);
  if (matches.length === 0) return null;
  if (descSubstring) {
    const term = descSubstring.toLowerCase();
    const specific = matches.find(item => 
      (item.description || '').toLowerCase().includes(term)
    );
    return specific ? specific.price_per_unit : null;
  }
  return matches[0].price_per_unit;
}

export function confidenceEnvelope(calcFn, factors) {
  const bestFactors = {};
  const lowFactors = {}, highFactors = {};
  let totalConfidence = 0, factorCount = 0;
  for (const [key, val] of Object.entries(factors)) {
    if (val && typeof val === 'object' && val.value !== undefined) {
      const uncertainty = 1 - (val.confidence || 0.5);
      bestFactors[key] = val.value;
      lowFactors[key] = val.value * (1 - uncertainty * 0.2);
      highFactors[key] = val.value * (1 + uncertainty * 0.2);
      totalConfidence += val.confidence || 0.5;
      factorCount++;
    } else {
      bestFactors[key] = val;
      lowFactors[key] = val;
      highFactors[key] = val;
    }
  }
  return {
    best: calcFn(bestFactors),
    low: calcFn(lowFactors),
    high: calcFn(highFactors),
    confidence: factorCount > 0 ? Math.round((totalConfidence / factorCount) * 100) : 100,
  };
}
