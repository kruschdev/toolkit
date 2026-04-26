/**
 * @module vision
 * Shared BuildOS vision module — Gemini Vision API caller + construction
 * dimension reference database for spatial inference across all trades.
 *
 * Usage:
 *   import { callGeminiMedia, VISION_MODELS, CONSTRUCTION_DIMENSIONS, buildDimensionPrompt } from '@krusch/toolkit/vision';
 */

// ==========================================
// Model Registry — single place to upgrade
// ==========================================

/**
 * Centralized model registry for all BuildOS vision calls.
 * Change the model strings here and every package picks it up.
 *
 * Tiers:
 *  - QUICK:     Fast, cheap — equipment ID, basic OCR, quick scans
 *  - STANDARD:  Default — structured extraction, photo analysis, video walkthrough
 *  - PRECISION: Highest quality — spatial reasoning, dimension inference, detailed BOM
 */
export const VISION_MODELS = {
  QUICK:     'gemini-3-flash-lite',
  STANDARD:  'gemini-3-flash',
  PRECISION: 'gemini-3-pro',

  /** Default tier used when no model is specified */
  DEFAULT_TIER: 'STANDARD',
};

/**
 * Resolve a model identifier — accepts a tier name (QUICK, STANDARD, PRECISION)
 * or an explicit model string (e.g. 'gemini-3-flash'). Returns the API model name.
 *
 * @param {string} [modelOrTier] - Tier name or explicit model string
 * @returns {string} Resolved model name for the API
 */
export function resolveModel(modelOrTier) {
  if (!modelOrTier) return VISION_MODELS[VISION_MODELS.DEFAULT_TIER];
  // If it's a known tier key, resolve it
  if (VISION_MODELS[modelOrTier]) return VISION_MODELS[modelOrTier];
  // Otherwise treat it as an explicit model string
  return modelOrTier;
}

// ==========================================
// Construction Dimension Reference Database
// ==========================================

/**
 * Standard construction object dimensions used as reference points
 * for spatial inference from job site photos. Gemini uses these known
 * sizes to estimate room areas, material runs, and equipment spacing.
 *
 * All dimensions in inches unless noted otherwise.
 */
export const CONSTRUCTION_DIMENSIONS = {
  // Doors
  doors: {
    interior_standard: { width: 32, height: 80, label: 'Standard interior door (32"×80")' },
    interior_wide: { width: 36, height: 80, label: 'Wide interior door (36"×80")' },
    exterior_entry: { width: 36, height: 80, label: 'Standard entry door (36"×80")' },
    double_entry: { width: 72, height: 80, label: 'Double entry door (72"×80")' },
    sliding_glass: { width: 72, height: 80, label: 'Sliding glass door (6\' wide)' },
    garage_single: { width: 108, height: 84, label: 'Single garage door (9\'×7\')' },
    garage_double: { width: 192, height: 84, label: 'Double garage door (16\'×7\')' },
  },

  // Windows
  windows: {
    standard_double_hung: { width: 36, height: 48, label: 'Standard double-hung window (36"×48")' },
    egress: { width: 24, height: 36, label: 'Egress window minimum (24"×36")' },
    picture_large: { width: 60, height: 48, label: 'Large picture window (60"×48")' },
    casement: { width: 24, height: 48, label: 'Casement window (24"×48")' },
    basement: { width: 32, height: 18, label: 'Basement hopper window (32"×18")' },
  },

  // Framing
  framing: {
    stud_spacing_standard: { oc: 16, label: 'Standard stud spacing (16" OC)' },
    stud_spacing_wide: { oc: 24, label: 'Wide stud spacing (24" OC)' },
    stud_2x4: { width: 3.5, depth: 1.5, label: '2×4 lumber (actual 1.5"×3.5")' },
    stud_2x6: { width: 5.5, depth: 1.5, label: '2×6 lumber (actual 1.5"×5.5")' },
    sheet_goods: { width: 48, height: 96, label: '4\'×8\' sheet (plywood, drywall, OSB)' },
  },

  // Ceiling heights
  ceilings: {
    standard_8: { height: 96, label: 'Standard 8\' ceiling' },
    standard_9: { height: 108, label: '9\' ceiling' },
    standard_10: { height: 120, label: '10\' ceiling' },
  },

  // Electrical reference points
  electrical: {
    outlet_height: { from_floor: 14, label: 'Standard outlet height (12-16" center)' },
    switch_height: { from_floor: 48, label: 'Standard switch height (48" center)' },
    panel_height: { from_floor: 60, width: 14.5, height: 32, label: 'Typical residential panel (centered ~60")' },
    outlet_cover: { width: 2.75, height: 4.5, label: 'Standard outlet cover plate' },
    switch_cover: { width: 2.75, height: 4.5, label: 'Standard switch cover plate' },
  },

  // HVAC reference points
  hvac: {
    supply_register_6x10: { width: 10, height: 6, label: 'Supply register (6"×10")' },
    supply_register_10x10: { width: 10, height: 10, label: 'Supply register (10"×10")' },
    supply_register_14x6: { width: 14, height: 6, label: 'Supply register (14"×6")' },
    return_grille_20x20: { width: 20, height: 20, label: 'Return air grille (20"×20")' },
    return_grille_20x25: { width: 25, height: 20, label: 'Return air grille (20"×25")' },
    return_grille_20x30: { width: 30, height: 20, label: 'Return air grille (20"×30")' },
    condenser_small: { width: 24, depth: 24, height: 28, label: '1.5-2 ton condenser (~24"×24"×28")' },
    condenser_medium: { width: 29, depth: 29, height: 32, label: '2.5-3 ton condenser (~29"×29"×32")' },
    condenser_large: { width: 34, depth: 34, height: 38, label: '4-5 ton condenser (~34"×34"×38")' },
    furnace_upflow: { width: 21, depth: 28, height: 40, label: 'Standard upflow furnace (~21"×28"×40")' },
    thermostat: { width: 3.5, height: 5, label: 'Standard thermostat (~3.5"×5")' },
    round_duct_6: { diameter: 6, label: '6" round duct' },
    round_duct_8: { diameter: 8, label: '8" round duct' },
    round_duct_10: { diameter: 10, label: '10" round duct' },
    round_duct_12: { diameter: 12, label: '12" round duct' },
    flex_duct_6: { diameter: 6, label: '6" flex duct (insulated OD ~8")' },
  },

  // Plumbing reference points
  plumbing: {
    toilet_rough_in: { from_wall: 12, label: 'Standard toilet rough-in (12" from wall)' },
    toilet_footprint: { width: 15, depth: 28, label: 'Toilet footprint (~15"×28")' },
    sink_standard: { width: 22, depth: 17, label: 'Standard bathroom sink (22"×17")' },
    vanity_36: { width: 36, height: 34, label: '36" bathroom vanity' },
    water_heater_40gal: { diameter: 20, height: 50, label: '40-gallon water heater (~20"×50")' },
    water_heater_50gal: { diameter: 22, height: 54, label: '50-gallon water heater (~22"×54")' },
  },

  // General construction
  general: {
    cinder_block: { width: 16, height: 8, depth: 8, label: 'Standard CMU block (16"×8"×8")' },
    brick_standard: { width: 8, height: 2.25, depth: 3.625, label: 'Standard brick (8"×2.25"×3.625")' },
    step_riser: { height: 7.5, label: 'Standard stair riser (~7.5")' },
    step_tread: { depth: 10, label: 'Standard stair tread (~10")' },
    baseboard: { height: 3.25, label: 'Standard baseboard trim (~3.25")' },
  },
};

/**
 * Build the dimension-inference prompt section that instructs Gemini
 * to use known object sizes as reference points for spatial estimation.
 *
 * @param {string[]} [categories] - Which categories to include (default: all)
 * @returns {string} Prompt section for dimension inference
 */
export function buildDimensionPrompt(categories) {
  const cats = categories || Object.keys(CONSTRUCTION_DIMENSIONS);

  const items = [];
  for (const cat of cats) {
    const group = CONSTRUCTION_DIMENSIONS[cat];
    if (!group) continue;
    for (const key of Object.keys(group)) {
      items.push(`- ${group[key].label}`);
    }
  }

  return `## Spatial Estimation — Dimension Inference

### Blueprint / Floor Plan Detection
If this image is a **blueprint, floor plan, architectural drawing, or construction document**:
1. **Read the scale bar** or scale notation (e.g., "1/4" = 1'-0"") and use it for ALL measurements
2. **Read dimension lines** — extract exact measurements from any dimension callouts
3. **Read room labels** — extract room names, areas (if noted), and ceiling heights
4. **Read material callouts** — extract any specifications for materials, equipment, or finishes
5. **Calculate areas** — compute square footage for each room from the extracted dimensions
6. **Sum totals** — provide total conditioned area, total duct run estimates, and material quantities
7. **Confidence: HIGH** — blueprint dimensions are authoritative

### Field Photo Detection
If this image is a **job site photo** of actual construction/equipment:
Use standard construction object dimensions as reference to estimate spatial measurements:
- Room dimensions (width × length in feet)
- Wall lengths and ceiling heights
- Duct run lengths and equipment spacing
- Total area (square feet) of visible spaces

Known reference objects and their standard dimensions:
${items.join('\n')}

When estimating from field photos:
1. **Identify reference objects** — find at least one object with a known size
2. **Establish scale** — use the reference object's pixel size vs. known real size
3. **Estimate target dimensions** — apply the scale to estimate room/run/area measurements
4. **State confidence** — "high" (multiple references), "medium" (one clear reference), or "low" (distant/angled)
5. **Show reasoning** — e.g., "The door is ~36" wide (standard entry). The wall spans ~4 door-widths → ~12 feet."

### Output
Include a "dimensions" object in your response with:
- imageType: "blueprint" | "field_photo" | "equipment_closeup" | "other"
- rooms: [{ name, widthFt, lengthFt, areaSqFt, ceilingHeightFt, confidence }]
- measurements: [{ item, value, unit, confidence, reasoning }]
- totalAreaSqFt: number or null
- scaleReference: description of what you used for scale`;
}

/**
 * Build the spatial-geometry extraction prompt that instructs Gemini
 * to return wall coordinates, room polygons, and openings as structured
 * JSON suitable for 3D rendering with Three.js.
 *
 * @param {string} [tradeContext] - Optional trade-specific extraction instructions
 * @returns {string} Prompt section for spatial geometry extraction
 */
export function buildSpatialPrompt(tradeContext) {
  const tradeSection = tradeContext
    ? `\n### Trade-Specific Overlay\n${tradeContext}`
    : '';

  return `## Spatial Geometry Extraction

You MUST extract spatial geometry from this blueprint/floor plan for 3D model rendering.
Use a consistent coordinate system with the origin (0,0) at the bottom-left corner.
All measurements in FEET. Walls are defined by start/end coordinates (x,y pairs on the floor plane).

### Required Output Schema

Include a "spatial" object in your response:

{
  "spatial": {
    "scale": {
      "unit": "ft",
      "source": "dimension_lines | scale_bar | inferred",
      "confidence": 0.9
    },
    "bounds": {
      "width": 60,
      "depth": 40,
      "description": "Overall building footprint"
    },
    "walls": [
      {
        "id": "w1",
        "start": [0, 0],
        "end": [40, 0],
        "height": 8,
        "thickness": 0.5,
        "type": "exterior | interior | load_bearing",
        "confidence": 0.88
      }
    ],
    "openings": [
      {
        "id": "o1",
        "wallId": "w1",
        "position": 8.5,
        "width": 3,
        "height": 6.8,
        "sillHeight": 0,
        "type": "door | window | archway | garage_door",
        "subtype": "entry | interior | sliding | double_hung | casement",
        "confidence": 0.85
      }
    ],
    "rooms": [
      {
        "id": "r1",
        "name": "Living Room",
        "type": "living | bedroom | bathroom | kitchen | garage | dining | hallway | closet | laundry | office | utility | basement",
        "polygon": [[0, 0], [20, 0], [20, 15], [0, 15]],
        "areaSqFt": 300,
        "ceilingHeight": 8,
        "confidence": 0.92
      }
    ],
    "stairs": [
      {
        "id": "s1",
        "position": [10, 5],
        "width": 3,
        "direction": "up | down",
        "type": "straight | L | U | spiral"
      }
    ]
  }
}

### Geometry Rules
1. **Wall connectivity**: Walls should connect — the "end" of one wall should match the "start" of an adjacent wall (within 0.5 ft tolerance)
2. **Room closure**: Room polygons must be closed (first point = last point implied)
3. **Opening positions**: "position" is the distance along the parent wall (from wall start) to the center of the opening
4. **Consistent units**: ALL coordinates and dimensions in FEET
5. **Confidence scoring**: Rate each element 0.0–1.0 based on how clearly it's visible in the blueprint
6. **ID format**: Use short IDs like "w1", "w2", "r1", "o1" for cross-referencing
${tradeSection}`;
}

// ==========================================
// Gemini Vision API Caller
// ==========================================

/**
 * Call the Gemini API with a text prompt and media (image or video).
 * Centralizes URL construction, auth, timeout, and response parsing.
 *
 * @param {string} prompt - Text prompt for the model
 * @param {string} base64Data - Base64-encoded media data
 * @param {string} mimeType - Media MIME type (image/jpeg, video/mp4, etc.)
 * @param {object} [options={}]
 * @param {string} options.apiKey - Gemini API key (REQUIRED)
 * @param {string} [options.model] - Model name or tier (QUICK/STANDARD/PRECISION). Default: STANDARD tier
 * @param {string} [options.mediaResolution] - Media resolution hint: 'auto' | 'low' | 'high'. Default: auto (Gemini 3+)
 * @param {number} [options.temperature=0.2] - Sampling temperature
 * @param {number} [options.maxOutputTokens] - Max tokens (auto-scales for video)
 * @param {number} [options.timeoutMs] - Request timeout (auto-scales for video)
 * @returns {Promise<string>} Raw text response from the model
 */
export async function callGeminiMedia(prompt, base64Data, mimeType, options = {}) {
  const isVideo = mimeType.startsWith('video/');
  const model = resolveModel(options.model);
  const temperature = options.temperature ?? 0.2;
  const maxOutputTokens = options.maxOutputTokens ?? (isVideo ? 8000 : 4000);
  const timeoutMs = options.timeoutMs ?? (isVideo ? 120000 : 60000);
  const mediaResolution = options.mediaResolution ?? 'auto';

  if (!options.apiKey) {
    throw new Error('Vision: apiKey is required in options');
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  console.log(`🧠 Vision: ${model} | ${isVideo ? 'video' : 'image'} (${mimeType}) | res=${mediaResolution}`);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': options.apiKey,
    },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: prompt },
          {
            inline_data: {
              mime_type: mimeType,
              data: base64Data,
            },
          },
        ],
      }],
      generationConfig: {
        temperature,
        maxOutputTokens,
        mediaResolution,
      },
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`🧠 ${isVideo ? 'Video' : 'Vision'} API error (${response.status}): ${errorBody}`);
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!text) {
    throw new Error(`🧠 ${isVideo ? 'Video' : 'Vision'} API returned no content`);
  }

  return text;
}

/**
 * Parse a JSON response from Gemini Vision, handling markdown fences.
 * Returns fallback if parsing fails.
 *
 * @param {string} response - Raw Gemini response text
 * @param {object} fallback - Fallback object if parsing fails
 * @param {string} [label='Vision'] - Label for warning logs
 * @returns {object} Parsed JSON or fallback
 */
export function parseVisionJson(response, fallback, label = 'Vision') {
  const cleaned = response.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    // Try extracting JSON object
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch { /* fall through */ }
    }
  }

  console.warn(`⚠️ ${label} JSON extraction failed, using fallback`);
  return { ...fallback, rawResponse: response.substring(0, 2000) };
}
