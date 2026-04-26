/**
 * @module ar-routing
 * AI-powered routing engine for BuildOS AR.
 * Calls Gemini to generate optimal 3D routing paths per trade
 * from blueprint analysis + calculator results.
 *
 * Usage:
 *   import { generateTradeRoutes, generateAllTradeRoutes, detectConflicts, ROUTING_PROMPTS } from '@krusch/toolkit/ar-routing';
 */

import { createSegment, createFixture, createLayer } from './ar-scene.js';
import { chatJson } from './llm.js';

// ==========================================
// Trade-Specific Routing Prompt Templates
// ==========================================

export const ROUTING_PROMPTS = {
  electrical: `You are an expert electrician planning wire routing for a residential project.
Given the room layout and fixture positions, generate optimal wire routing paths.

Rules:
- Route 14/2 NM-B for 15A circuits, 12/2 NM-B for 20A (kitchen, bath, laundry)
- Follow stud bays — vertical runs in stud cavities, horizontal runs through bored holes
- Maintain 1.25" from face of stud per NEC 300.4
- Junction boxes at every direction change
- Home runs terminate at the main panel
- GFCI protection for kitchen, bath, garage, outdoor, laundry per NEC 210.8

Respond with ONLY valid JSON.`,

  plumbing: `You are an expert plumber planning DWV and supply routing for a residential project.
Given the room layout and fixture positions, generate optimal pipe routing paths.

Rules:
- DWV: maintain 1/4" per foot slope on all horizontal drain runs
- Size drain pipes per DFU loading (IPC Table 710.1)
- Vent through roof — each fixture needs a vent within allowable distance
- Supply: 3/4" trunk, 1/2" branches to individual fixtures
- Keep hot and cold parallel, 6" apart minimum
- Cleanout access every 50ft on horizontal runs

Respond with ONLY valid JSON.`,

  hvac: `You are an expert HVAC technician planning ductwork routing for a residential project.
Given the room layout, load calculations, and register positions, generate optimal duct routing.

Rules:
- Trunk-and-branch layout from air handler
- Size per CFM requirements (Manual D)
- Maintain 1" clearance from framing members
- Flex duct max 25ft per run, minimal bends
- Supply registers near exterior walls/windows
- Return air: minimum one per floor, sized for full system CFM
- Seal all joints with mastic

Respond with ONLY valid JSON.`,

  framing: `You are an expert framer mapping the structural skeleton for a residential project.
Given the room layout, generate the wall framing positions for AR visualization.

Rules:
- 2x4 interior walls at 16" OC, 2x6 exterior at 16" OC
- Double top plate, single bottom plate
- King studs + trimmer studs flanking all openings
- Headers per span table (4" wall = 2x4, 6" wall = 2x6, etc.)
- Load-bearing walls get doubled studs at intersections

Respond with ONLY valid JSON.`,
};

/**
 * Build the full routing prompt for Gemini.
 * Combines the trade-specific template with blueprint/calculator data.
 *
 * @param {string} trade - Trade name (electrical, plumbing, hvac, framing)
 * @param {object} blueprintAnalysis - Parsed blueprint analysis
 * @param {object} calculatorResults - Calculator output (pipe sizes, wire gauges, etc.)
 * @returns {string} Full prompt for Gemini
 */
export function buildRoutingPrompt(trade, blueprintAnalysis, calculatorResults) {
  const tradePrompt = ROUTING_PROMPTS[trade] || ROUTING_PROMPTS.electrical;

  return `${tradePrompt}

## Room Layout (from blueprint analysis)
${JSON.stringify(blueprintAnalysis.rooms || blueprintAnalysis.dimensions?.rooms || [], null, 2)}

## Walls & Openings
${JSON.stringify(blueprintAnalysis.walls || blueprintAnalysis.structural_elements || [], null, 2)}

## Fixtures & Equipment (from trade scope)
${JSON.stringify(blueprintAnalysis.mep_elements || blueprintAnalysis.fixtures || [], null, 2)}

## Calculator Results (material sizing)
${JSON.stringify(calculatorResults || {}, null, 2)}

## Required Output Format
Return a JSON object with:
{
  "segments": [
    {
      "id": "seg-001",
      "type": "wire|drain|supply|duct|stud",
      "material": "description",
      "diameter": <inches>,
      "start": { "x": <inches from origin>, "y": <inches from floor>, "z": <inches from origin> },
      "end": { "x": ..., "y": ..., "z": ... },
      "codeRef": "code section reference"
    }
  ],
  "fixtures": [
    {
      "id": "fix-001",
      "type": "panel|outlet|sink|register|stud",
      "label": "description",
      "position": { "x": ..., "y": ..., "z": ... },
      "size": { "w": <inches>, "h": <inches>, "d": <inches> }
    }
  ]
}

All coordinates in INCHES from the front-left corner of the building (origin).
X = east, Y = up from floor, Z = south.`;
}

/**
 * Parse Gemini's routing response into ARLayer objects.
 *
 * @param {string} trade - Trade name
 * @param {object} routingResponse - Parsed JSON from Gemini
 * @returns {object} ARLayer
 */
export function parseRoutingResponse(trade, routingResponse) {
  const segments = (routingResponse.segments || []).map(s => createSegment(s));
  const fixtures = (routingResponse.fixtures || []).map(f => createFixture(f));
  return createLayer({ trade, segments, fixtures });
}

// ==========================================
// AI Route Generation (Phase 2)
// ==========================================

/**
 * Generate 3D routing paths for a single trade via Gemini.
 *
 * @param {string} trade - Trade name (electrical, plumbing, hvac, framing)
 * @param {object} blueprintAnalysis - Parsed blueprint analysis
 * @param {object} calculatorResults - Calculator output (pipe sizes, wire gauges, etc.)
 * @param {object} aiConfig - LLM config: { provider, apiKey, model, ... }
 * @returns {Promise<object>} ARLayer with AI-generated segments and fixtures
 */
export async function generateTradeRoutes(trade, blueprintAnalysis, calculatorResults, aiConfig) {
  const prompt = buildRoutingPrompt(trade, blueprintAnalysis, calculatorResults);

  const systemPrompt = `You are a BuildOS AR routing engine. Generate precise 3D routing paths for the ${trade} trade. Respond with ONLY valid JSON matching the required output format. No markdown fences, no explanation.`;

  const response = await chatJson(systemPrompt, prompt, aiConfig, {
    useAnalysisModel: true,
    maxTokens: 8000,
    temperature: 0.3,
  });

  const layer = parseRoutingResponse(trade, response);

  // Run trade-specific validation
  layer.validationWarnings = validateRouting(trade, layer);

  return layer;
}

/**
 * Generate 3D routing paths for ALL available trades.
 * Runs each trade sequentially to avoid rate limits.
 *
 * @param {object} blueprintAnalysis - Combined blueprint analysis
 * @param {object} aiConfig - LLM config
 * @param {string[]} [trades] - Trade list override (default: all 4 core trades)
 * @returns {Promise<object[]>} Array of ARLayers
 */
export async function generateAllTradeRoutes(blueprintAnalysis, aiConfig, trades = null) {
  const tradeList = trades || Object.keys(ROUTING_PROMPTS);
  const layers = [];

  for (const trade of tradeList) {
    try {
      console.log(`  🔮 Generating ${trade} routes...`);
      const layer = await generateTradeRoutes(trade, blueprintAnalysis, {}, aiConfig);
      layers.push(layer);
      console.log(`  ✅ ${trade}: ${layer.segments.length} segments, ${layer.fixtures.length} fixtures`);
    } catch (err) {
      console.error(`  ⚠️  ${trade} routing failed:`, err.message);
      // Push empty layer so the trade still appears in the UI
      layers.push(createLayer({ trade, segments: [], fixtures: [] }));
    }
  }

  return layers;
}

// ==========================================
// Routing Validation Helpers
// ==========================================

/** Minimum drain slope per IPC: 1/4" per foot */
const MIN_DRAIN_SLOPE_PER_FOOT = 0.25;

/** NEC 300.4 — min distance from face of stud */
const MIN_WIRE_STUD_CLEARANCE = 1.25;

/**
 * Validate plumbing drain slope on horizontal segments.
 * Returns warnings for segments that don't maintain 1/4" per foot.
 */
export function validatePlumbingSlope(segments) {
  const warnings = [];
  for (const seg of segments) {
    if (seg.type !== 'drain') continue;
    const dx = Math.abs(seg.end.x - seg.start.x);
    const dz = Math.abs(seg.end.z - seg.start.z);
    const horizontalRun = Math.sqrt(dx * dx + dz * dz); // inches
    if (horizontalRun < 1) continue; // vertical run, skip
    const dy = seg.start.y - seg.end.y; // positive = downhill
    const runFeet = horizontalRun / 12;
    const requiredDrop = runFeet * MIN_DRAIN_SLOPE_PER_FOOT;
    if (dy < requiredDrop) {
      warnings.push({
        segmentId: seg.id,
        issue: 'insufficient_slope',
        message: `Drain ${seg.id} (${seg.material}) has ${(dy / runFeet).toFixed(3)}"/ft slope — minimum is ${MIN_DRAIN_SLOPE_PER_FOOT}"/ft (IPC Table 710.1)`,
        actual: dy / runFeet,
        required: MIN_DRAIN_SLOPE_PER_FOOT,
      });
    }
  }
  return warnings;
}

/**
 * Validate electrical wire clearance from stud faces.
 * Checks that wire segments are at least 1.25" from edges per NEC 300.4.
 */
export function validateElectricalClearance(segments) {
  const warnings = [];
  for (const seg of segments) {
    if (seg.type !== 'wire') continue;
    // Check if diameter suggests wire is too close to stud surface
    // (heuristic: wire in a 2x4 wall must be 1.25" from face)
    if ((seg.diameter || 0) > 0 && seg.codeRef?.includes('300.4')) {
      // This is a simplified check — real validation would use wall geometry
      warnings.push({
        segmentId: seg.id,
        issue: 'verify_stud_clearance',
        message: `Wire ${seg.id} (${seg.material}) — verify 1.25" min clearance from stud face per NEC 300.4`,
        required: MIN_WIRE_STUD_CLEARANCE,
      });
    }
  }
  return warnings;
}

/**
 * Run trade-specific validation on a generated layer.
 * @param {string} trade
 * @param {object} layer - ARLayer
 * @returns {object[]} Validation warnings
 */
function validateRouting(trade, layer) {
  switch (trade) {
    case 'plumbing':
      return validatePlumbingSlope(layer.segments);
    case 'electrical':
      return validateElectricalClearance(layer.segments);
    default:
      return [];
  }
}

// ==========================================
// Conflict Detection (Phase 3)
// ==========================================

/** Trade pairs that are critical when crossing (structural implications) */
const CRITICAL_PAIRS = new Set([
  'electrical-plumbing', 'plumbing-electrical',
  'electrical-hvac', 'hvac-electrical',
]);

/** Minimum code-required clearances per trade pair (inches) */
const CODE_CLEARANCES = {
  'electrical-plumbing': 6,   // NEC 300.4 / IPC general
  'electrical-hvac': 3,       // NEC 300.4
  'plumbing-hvac': 4,         // IMC/IPC general
  'default': 2,
};

/**
 * Detect spatial conflicts between segments on different trade layers.
 * Enhanced with severity classification and resolution suggestions.
 *
 * @param {ARLayer[]} layers - All trade layers to check
 * @param {number} [clearanceInches=2] - Minimum clearance between different trades
 * @returns {object[]} List of conflict objects with severity and suggestions
 */
export function detectConflicts(layers, clearanceInches = 2) {
  const conflicts = [];

  for (let i = 0; i < layers.length; i++) {
    for (let j = i + 1; j < layers.length; j++) {
      const layerA = layers[i];
      const layerB = layers[j];
      const pairKey = `${layerA.trade}-${layerB.trade}`;
      const requiredClearance = CODE_CLEARANCES[pairKey]
        || CODE_CLEARANCES[`${layerB.trade}-${layerA.trade}`]
        || CODE_CLEARANCES.default;
      const effectiveClearance = Math.max(clearanceInches, requiredClearance);

      for (const segA of layerA.segments) {
        for (const segB of layerB.segments) {
          const intersection = findSegmentIntersection(segA, segB, effectiveClearance);
          if (intersection) {
            const proximity = computeProximity(segA, segB);
            const severity = classifySeverity(layerA.trade, layerB.trade, proximity, requiredClearance);
            const suggestion = generateResolution(layerA.trade, layerB.trade, segA, segB, proximity);

            conflicts.push({
              id: `conflict-${conflicts.length + 1}`,
              tradeA: layerA.trade,
              tradeB: layerB.trade,
              segmentA: segA.id,
              segmentB: segB.id,
              position: intersection,
              description: `${layerA.label} ${segA.material} crosses ${layerB.label} ${segB.material}`,
              severity,
              proximityInches: Math.round(proximity * 10) / 10,
              requiredClearanceInches: requiredClearance,
              suggestion,
            });
          }
        }
      }
    }
  }

  // Sort: critical first, then error, then warning
  const order = { critical: 0, error: 1, warning: 2 };
  conflicts.sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3));

  return conflicts;
}

/**
 * Classify conflict severity.
 * - critical: structural/code-violating crossing between MEP trades
 * - error: within code clearance but not directly crossing
 * - warning: close but might be acceptable
 */
function classifySeverity(tradeA, tradeB, proximityInches, requiredClearance) {
  const pair = `${tradeA}-${tradeB}`;
  if (proximityInches < 1 && CRITICAL_PAIRS.has(pair)) return 'critical';
  if (proximityInches < requiredClearance) return 'error';
  return 'warning';
}

/**
 * Generate a human-readable resolution suggestion.
 */
function generateResolution(tradeA, tradeB, segA, segB, proximity) {
  const offsetNeeded = Math.ceil(Math.max(4, proximity * 2));

  if (tradeA === 'electrical' && tradeB === 'plumbing') {
    return `Re-route ${segA.material} wire at least ${offsetNeeded}" from ${segB.material} pipe — use nail plates if within 1.25" of stud face (NEC 300.4)`;
  }
  if (tradeA === 'plumbing' && tradeB === 'electrical') {
    return `Re-route ${segA.material} pipe to clear ${segB.material} wire by ${offsetNeeded}" — consider dropping pipe below wire path`;
  }
  if (tradeA === 'hvac' || tradeB === 'hvac') {
    const duct = tradeA === 'hvac' ? segA : segB;
    const other = tradeA === 'hvac' ? segB : segA;
    return `Offset ${duct.material} duct ${offsetNeeded}" vertically to clear ${other.material} — use 45° elbows to maintain airflow`;
  }
  if (tradeA === 'framing' || tradeB === 'framing') {
    const mep = tradeA === 'framing' ? segB : segA;
    return `Bore through framing for ${mep.material} — max hole diameter 40% of stud width, centered (IRC R602.6)`;
  }
  return `Offset ${segA.material} or ${segB.material} by at least ${offsetNeeded}" to maintain required clearance`;
}

/**
 * Compute approximate closest-approach distance between two segments (inches).
 * Uses midpoint-to-midpoint distance as a practical approximation.
 */
function computeProximity(segA, segB) {
  const midA = {
    x: (segA.start.x + segA.end.x) / 2,
    y: (segA.start.y + segA.end.y) / 2,
    z: (segA.start.z + segA.end.z) / 2,
  };
  const midB = {
    x: (segB.start.x + segB.end.x) / 2,
    y: (segB.start.y + segB.end.y) / 2,
    z: (segB.start.z + segB.end.z) / 2,
  };
  const dx = midA.x - midB.x;
  const dy = midA.y - midB.y;
  const dz = midA.z - midB.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) - (segA.diameter || 1) / 2 - (segB.diameter || 1) / 2;
}

/**
 * Simple axis-aligned bounding box intersection check for two segments.
 * Returns the approximate intersection point, or null if no conflict.
 */
function findSegmentIntersection(segA, segB, clearance) {
  // Expand each segment's bounding box by its diameter + clearance
  const rA = (segA.diameter || 1) / 2 + clearance;
  const rB = (segB.diameter || 1) / 2 + clearance;

  const aMin = {
    x: Math.min(segA.start.x, segA.end.x) - rA,
    y: Math.min(segA.start.y, segA.end.y) - rA,
    z: Math.min(segA.start.z, segA.end.z) - rA,
  };
  const aMax = {
    x: Math.max(segA.start.x, segA.end.x) + rA,
    y: Math.max(segA.start.y, segA.end.y) + rA,
    z: Math.max(segA.start.z, segA.end.z) + rA,
  };
  const bMin = {
    x: Math.min(segB.start.x, segB.end.x) - rB,
    y: Math.min(segB.start.y, segB.end.y) - rB,
    z: Math.min(segB.start.z, segB.end.z) - rB,
  };
  const bMax = {
    x: Math.max(segB.start.x, segB.end.x) + rB,
    y: Math.max(segB.start.y, segB.end.y) + rB,
    z: Math.max(segB.start.z, segB.end.z) + rB,
  };

  // Check AABB overlap
  if (aMin.x > bMax.x || aMax.x < bMin.x) return null;
  if (aMin.y > bMax.y || aMax.y < bMin.y) return null;
  if (aMin.z > bMax.z || aMax.z < bMin.z) return null;

  // Return approximate intersection midpoint
  return {
    x: (Math.max(aMin.x, bMin.x) + Math.min(aMax.x, bMax.x)) / 2,
    y: (Math.max(aMin.y, bMin.y) + Math.min(aMax.y, bMax.y)) / 2,
    z: (Math.max(aMin.z, bMin.z) + Math.min(aMax.z, bMax.z)) / 2,
  };
}
