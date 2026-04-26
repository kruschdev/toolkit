/**
 * @module lib/blueprint
 * Shared blueprint analysis factory for all BuildOS trades.
 *
 * Uses Gemini Vision to extract:
 *  1. Spatial geometry (walls, rooms, openings) for 3D rendering
 *  2. Trade-agnostic scope (rooms, areas, dimensions)
 *  3. Trade-specific overlays (electrical, plumbing, etc.) via configurable prompts
 *
 * Usage:
 *   import { createBlueprintAnalyzer } from '../../lib/blueprint.js';
 *   const { analyzeBlueprint, mergeBlueprintScope } = createBlueprintAnalyzer(config, 'spark', db);
 */

import { buildSpatialPrompt, buildDimensionPrompt } from './vision.js';

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * Trade-specific overlay extraction prompts.
 * Each trade adds instructions for extracting their domain-specific elements.
 */
const TRADE_OVERLAY_PROMPTS = {
  spark: `Extract ELECTRICAL elements and include in "tradeOverlays.electrical":
{
  "outlets": [{ "id": "el1", "roomId": "r1", "type": "standard|gfci|dedicated|exterior", "position": [x, y], "confidence": 0.8 }],
  "switches": [{ "id": "sw1", "roomId": "r1", "type": "single|three_way|four_way|dimmer", "position": [x, y], "confidence": 0.8 }],
  "panels": [{ "id": "p1", "label": "Main Panel", "position": [x, y], "amperage": 200, "spaces": 40, "confidence": 0.85 }],
  "lighting": [{ "id": "lt1", "roomId": "r1", "type": "recessed|surface|exterior|specialty", "position": [x, y], "confidence": 0.8 }],
  "wireRuns": [{ "id": "wr1", "from": [x1, y1], "to": [x2, y2], "gauge": "12/2", "type": "NM-B", "confidence": 0.7 }],
  "circuits": [{ "label": "Kitchen 20A", "amperage": 20, "type": "general|dedicated|lighting", "wireGauge": "12" }]
}`,

  drainflux: `Extract PLUMBING elements and include in "tradeOverlays.plumbing":
{
  "fixtures": [{ "id": "pf1", "roomId": "r1", "type": "toilet|sink|shower|tub|laundry|hose_bib", "position": [x, y], "confidence": 0.8 }],
  "pipeRuns": [{ "id": "pr1", "from": [x1, y1], "to": [x2, y2], "type": "supply|waste|vent", "diameter": 2, "material": "PVC|copper|PEX", "confidence": 0.7 }],
  "waterHeater": { "position": [x, y], "type": "tank|tankless", "capacity": "50gal", "confidence": 0.8 },
  "cleanouts": [{ "id": "co1", "position": [x, y], "confidence": 0.7 }]
}`,

  climacore: `Extract HVAC elements and include in "tradeOverlays.hvac":
{
  "registers": [{ "id": "hv1", "roomId": "r1", "type": "supply|return", "size": "6x10", "position": [x, y], "confidence": 0.8 }],
  "ductRuns": [{ "id": "dr1", "from": [x1, y1], "to": [x2, y2], "type": "supply|return|exhaust", "size": 8, "shape": "round|rectangular", "confidence": 0.7 }],
  "equipment": [{ "id": "eq1", "type": "furnace|condenser|air_handler|thermostat", "position": [x, y], "capacity": "3 ton", "confidence": 0.8 }]
}`,

  brushwise: `Extract PAINTABLE SURFACES and include in "tradeOverlays.painting":
{
  "surfaces": [{ "id": "ps1", "roomId": "r1", "type": "wall|ceiling|trim|door|cabinet", "areaSqFt": 120, "condition": "new|repaint|damaged", "confidence": 0.8 }],
  "finishes": [{ "roomId": "r1", "finish": "flat|eggshell|satin|semi-gloss|gloss", "color_note": "", "confidence": 0.7 }]
}`,

  floorwise: `Extract FLOORING AREAS and include in "tradeOverlays.flooring":
{
  "areas": [{ "id": "fl1", "roomId": "r1", "material": "hardwood|LVP|tile|carpet|concrete", "areaSqFt": 300, "subfloor": "plywood|concrete|OSB", "confidence": 0.8 }],
  "transitions": [{ "from": "r1", "to": "r2", "type": "T-molding|reducer|threshold", "position": [x, y], "confidence": 0.7 }]
}`,

  frameup: `Extract FRAMING ELEMENTS and include in "tradeOverlays.framing":
{
  "headers": [{ "id": "fr1", "wallId": "w1", "span_ft": 6, "type": "window|door|garage", "confidence": 0.8 }],
  "loadBearingWalls": ["w1", "w3"],
  "studSpacing": 16,
  "exteriorSheathing": "OSB|plywood"
}`,

  ridgeline: `Extract ROOFING ELEMENTS and include in "tradeOverlays.roofing":
{
  "roofPlanes": [{ "id": "rp1", "areaSqFt": 800, "pitch": "6/12", "type": "gable|hip|shed|flat", "confidence": 0.8 }],
  "ridges": [{ "from": [x1, y1], "to": [x2, y2], "type": "ridge|hip|valley", "lengthFt": 30 }],
  "penetrations": [{ "type": "vent|chimney|skylight", "position": [x, y], "confidence": 0.7 }]
}`,

  stoneset: `Extract MASONRY SURFACES and include in "tradeOverlays.masonry":
{
  "surfaces": [{ "id": "ms1", "type": "wall|veneer|chimney|retaining|patio", "areaSqFt": 200, "material": "brick|block|stone|stucco", "confidence": 0.8 }]
}`,

  groundwork: `Extract SITE/HARDSCAPE elements and include in "tradeOverlays.sitework":
{
  "hardscape": [{ "id": "hw1", "type": "patio|walkway|driveway|retaining_wall", "areaSqFt": 400, "material": "concrete|pavers|gravel", "confidence": 0.8 }],
  "grading": { "slopeDirection": "north", "estimatedGrade": "2%", "confidence": 0.6 }
}`,

  boardwise: `Extract DRYWALL/FINISH surfaces and include in "tradeOverlays.drywall":
{
  "surfaces": [{ "id": "dw1", "roomId": "r1", "type": "wall|ceiling", "areaSqFt": 320, "finishLevel": "0|1|2|3|4|5", "confidence": 0.8 }],
  "features": [{ "type": "archway|niche|soffit|tray_ceiling", "roomId": "r1", "confidence": 0.7 }]
}`,
};

/**
 * Create a blueprint analysis module bound to a specific trade and config.
 *
 * @param {object} config - Project config with ai.apiKey, ai.analysisModel, ai.provider
 * @param {string} tradeName - Trade identifier (e.g. 'spark', 'drainflux')
 * @param {{ query: Function, queryOne: Function }} db - Database query functions
 * @returns {{ analyzeBlueprint, mergeBlueprintScope }}
 */
export function createBlueprintAnalyzer(config, tradeName, db) {
  const tradeOverlayPrompt = TRADE_OVERLAY_PROMPTS[tradeName] || '';

  /**
   * Analyze a blueprint image to extract spatial geometry + trade scope.
   *
   * @param {string} base64Image - Base64-encoded image data
   * @param {string} mimeType - Image MIME type (e.g., 'image/png')
   * @returns {Promise<object>} Structured analysis with spatial + scope + tradeOverlays
   */
  async function analyzeBlueprint(base64Image, mimeType) {
    const spatialPrompt = buildSpatialPrompt(tradeOverlayPrompt);
    const dimensionPrompt = buildDimensionPrompt();

    const systemPrompt = `You are an expert construction blueprint reader and ${tradeName} trade estimator.
Analyze the provided blueprint/floor plan image and extract ALL available information.

${spatialPrompt}

${dimensionPrompt}

Also include a top-level "tradeOverlays" object with trade-specific data as described above.
If the image is not a construction document, set "isBlueprint": false and extract what you can.

Respond with ONLY a valid JSON object. Include these top-level fields:
- "isBlueprint": boolean
- "blueprintType": "floor_plan | electrical_plan | plumbing_plan | hvac_plan | site_plan | elevation | detail | unknown"
- "confidence": 0.0-1.0 (overall analysis confidence)
- "spatial": { ... } (as described above)
- "tradeOverlays": { "${tradeName === 'spark' ? 'electrical' : tradeName === 'drainflux' ? 'plumbing' : tradeName === 'climacore' ? 'hvac' : tradeName}": { ... } }
- "rooms": [{ "name", "type", "dimensions", "areaSqFt", "confidence" }]
- "summary": "One-paragraph summary of what this blueprint shows"`;

    const userPrompt = `Analyze this blueprint image. Extract spatial geometry for 3D rendering AND ${tradeName}-specific trade scope. Be thorough but realistic — only report what you can actually see or reasonably infer.`;

    const model = config.ai.analysisModel || config.ai.fastModel;
    const apiKey = config.ai.apiKey;
    console.log(`📐 [${tradeName}] Blueprint spatial analysis with gemini/${model}...`);

    if (!apiKey) {
      throw new Error(`Blueprint analysis requires GEMINI_API_KEY`);
    }

    // Direct Gemini REST call — toolkit chat() doesn't support multimodal (inline image)
    const url = `${GEMINI_BASE_URL}/models/${model}:generateContent?key=${apiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{
          role: 'user',
          parts: [
            { text: userPrompt },
            { inlineData: { mimeType, data: base64Image } },
          ],
        }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 12000,
        },
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini Vision API ${res.status}: ${errText}`);
    }

    const data = await res.json();
    const response = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

    // Parse the JSON response
    let analysis;
    try {
      const cleaned = response.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        analysis = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No JSON found in response');
      }
    } catch (err) {
      console.warn(`⚠️ [${tradeName}] Blueprint analysis JSON parse failed: ${err.message}`);
      analysis = {
        isBlueprint: false,
        confidence: 0,
        spatial: null,
        tradeOverlays: {},
        summary: response.slice(0, 500),
        rawResponse: response,
      };
    }

    // Validate spatial data
    if (analysis.spatial) {
      const s = analysis.spatial;
      const wallCount = s.walls?.length || 0;
      const roomCount = s.rooms?.length || 0;
      const openingCount = s.openings?.length || 0;
      console.log(`  📐 Spatial: ${wallCount} walls, ${roomCount} rooms, ${openingCount} openings`);
    } else {
      console.log(`  📐 No spatial geometry extracted (non-blueprint or low confidence)`);
    }

    console.log(`  📐 Summary: ${analysis.summary?.substring(0, 80) || 'Complete'}`);
    return analysis;
  }

  /**
   * Merge blueprint spatial + scope into existing job context.
   * Blueprint findings accumulate under context.blueprintScope.
   * Spatial data replaces previous (latest wins for geometry).
   *
   * @param {object} existingContext - Current job context
   * @param {object} blueprintAnalysis - Blueprint analysis result
   * @returns {object} Merged context
   */
  function mergeBlueprintScope(existingContext, blueprintAnalysis) {
    const merged = { ...existingContext };

    // Always store latest spatial data (geometry should be latest version)
    if (blueprintAnalysis.spatial) {
      merged.spatial = blueprintAnalysis.spatial;
    }

    // Store trade overlays
    if (blueprintAnalysis.tradeOverlays) {
      merged.tradeOverlays = {
        ...(merged.tradeOverlays || {}),
        ...blueprintAnalysis.tradeOverlays,
      };
    }

    // Accumulate rooms (deduplicate by name)
    if (blueprintAnalysis.rooms?.length) {
      if (!merged.rooms) merged.rooms = [];
      const existingNames = new Set(merged.rooms.map((r) => r.name));
      for (const r of blueprintAnalysis.rooms) {
        if (!existingNames.has(r.name)) {
          merged.rooms.push(r);
          existingNames.add(r.name);
        }
      }
    }

    merged.blueprintAnalyzedAt = new Date().toISOString();
    merged.isBlueprint = blueprintAnalysis.isBlueprint;
    merged.blueprintType = blueprintAnalysis.blueprintType;
    merged.blueprintConfidence = blueprintAnalysis.confidence;

    return merged;
  }

  return { analyzeBlueprint, mergeBlueprintScope };
}
