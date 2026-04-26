/**
 * @module video-walkthrough
 * Shared BuildOS video walkthrough factory — creates trade-parameterized
 * video walkthrough agents that analyze both video frames and audio narration.
 *
 * Extracted from Spark's agents/video-walkthrough.js and generalized for all trades.
 *
 * Usage:
 *   import { createVideoWalkthroughAgent } from '@krusch/toolkit/video-walkthrough';
 *
 *   const { processVideoWalkthrough, getWalkthroughModes } = createVideoWalkthroughAgent({
 *     tradeName: 'electrician',
 *     tradeDescription: 'expert AI electrician\'s assistant',
 *     callMedia: myCallGeminiMedia,  // with API key pre-injected
 *   });
 */

import { readFile, unlink } from 'fs/promises';
import { parseAgentJson } from './agents.js';

/**
 * Default walkthrough modes — universal across all trades.
 */
const DEFAULT_MODES = {
  materials: {
    label: 'Materials Estimate',
    icon: '📦',
    description: 'Walk through the job scope — get a full bill of materials',
  },
  troubleshoot: {
    label: 'Troubleshoot',
    icon: '🔧',
    description: 'Show and describe the problem — get diagnostic steps',
  },
  survey: {
    label: 'Site Survey',
    icon: '📷',
    description: 'Walk through the area — get a measurement-aware survey report',
  },
};

/**
 * Default response schemas per mode.
 * Trades can override these to add trade-specific fields.
 */
const DEFAULT_SCHEMAS = {
  materials: `{
  "projectType": "Closest match project type for this trade",
  "scopeSummary": "2-3 sentence summary of the described work",
  "extractedData": {
    "roomType": "Type of space or null",
    "existingConditions": ["List of existing conditions observed or described"],
    "measurements": [
      { "item": "What was measured", "value": "Dimension or distance", "source": "verbal | visual" }
    ],
    "componentsList": ["List of components, materials, or items mentioned"],
    "materialEstimates": [
      { "item": "Description of material needed", "estimatedQuantity": 0, "unit": "standard unit" }
    ]
  },
  "codeConsiderations": ["Relevant code/standard references that apply to this scope"],
  "questionsForContractor": ["Any clarifying questions that would improve the estimate"]
}`,

  troubleshoot: `{
  "symptomSummary": "Brief description of the reported problem",
  "visualObservations": ["What was observed in the video frames"],
  "possibleCauses": [
    {
      "cause": "Description of possible cause",
      "likelihood": "high | medium | low",
      "codeRef": "Relevant code/standard reference or null",
      "diagnosticStep": "How to confirm or rule this out"
    }
  ],
  "safetyWarnings": ["Any immediate safety concerns"],
  "recommendedActions": ["Ordered list of next steps"],
  "toolsNeeded": ["Tools or equipment needed for diagnosis"]
}`,

  survey: `{
  "surveyType": "Type of survey conducted",
  "locationSummary": "Brief description of the surveyed area",
  "inventoryItems": [
    { "item": "What was found", "details": "Brand, size, condition, rating", "location": "Where in the space" }
  ],
  "measurements": [
    { "item": "What was measured", "value": "Dimension", "confidence": "high | medium | low", "source": "verbal | visual | reference_object" }
  ],
  "codeConcerns": [
    { "concern": "Description", "reference": "Code/standard reference", "severity": "critical | warning | info" }
  ],
  "overallCondition": "good | fair | poor | hazardous",
  "recommendations": ["List of recommended actions or upgrades"]
}`,
};

/**
 * Build default prompts per mode, injecting trade identity.
 */
function buildDefaultPrompts(tradeName, tradeDescription, schemas) {
  return {
    materials: (contextSection) => `You are ${tradeDescription}. The ${tradeName} is recording a video walkthrough of a job site while describing the scope of work.

## Your Task
Analyze BOTH the video frames AND the audio narration to extract everything needed for a materials estimate:

1. **Listen carefully** to the ${tradeName}'s description — they're telling you what they need
2. **Watch the video** for visual context — room type, existing conditions, access points, dimensions
3. **Extract measurements** — any distances, quantities, or dimensions mentioned verbally or visible
4. **Identify the project type** — match to the closest standard project type for this trade

## Important Rules
- The ${tradeName}'s verbal description is your PRIMARY data source — trust what they say
- Video frames are the VERIFICATION layer — use them to catch things not mentioned
- Add 10-20% waste factor for material estimates
- Round quantities up to standard purchase units
- Always include commonly forgotten items and consumables
${contextSection}

Respond with ONLY a valid JSON object:
${schemas.materials}`,

    troubleshoot: (contextSection) => `You are ${tradeDescription}. The ${tradeName} is recording a video showing a problem while describing the symptoms.

## Your Task
Analyze BOTH the video frames AND the audio narration to diagnose the issue:

1. **Listen to the symptoms** — what's happening, when it started, what they've tried
2. **Watch for visual clues** — improper installations, damage, wear, wrong materials
3. **Cross-reference standards** — identify any code violations that could be causing the issue
4. **Rank possible causes** from most to least likely
${contextSection}

Respond with ONLY a valid JSON object:
${schemas.troubleshoot}`,

    survey: (contextSection) => `You are ${tradeDescription}. The ${tradeName} is recording a video walkthrough of a site for a survey/assessment.

## Your Task
Analyze BOTH the video frames AND the audio narration to create a comprehensive site survey:

1. **Catalog everything visible** — equipment, materials, installations, fixtures
2. **Note measurements** — both stated verbally and estimated from reference objects
3. **Flag code concerns** — spacing, clearance, protection, quality issues
4. **Assess overall condition** — age, quality of installation, upgrade needs
${contextSection}

Respond with ONLY a valid JSON object:
${schemas.survey}`,
  };
}

/**
 * Create a trade-specific video walkthrough agent.
 *
 * @param {object} config
 * @param {string} config.tradeName - Trade role name (e.g., "electrician", "painter")
 * @param {string} config.tradeDescription - Full persona (e.g., "Spark, an expert AI electrician's assistant")
 * @param {object} [config.modes] - Override or extend default modes. Merged with defaults.
 * @param {function} config.callMedia - Gemini media caller with API key pre-injected:
 *   (prompt, base64Data, mimeType, options) => Promise<string>
 * @param {function} [config.parseJson] - JSON parser. Defaults to shared parseAgentJson.
 * @param {function} [config.buildContextSection] - Context section builder. Defaults to () => ''.
 * @param {object} [config.responseSchemas] - Per-mode JSON response schemas (override defaults).
 * @param {object} [config.promptBuilders] - Per-mode prompt builder functions (override defaults).
 *   Each: (contextSection: string) => string
 * @param {function} [config.postProcess] - Optional post-processor called after extraction,
 *   before returning. Receives (mode, extraction) and can enrich the result.
 * @returns {{ processVideoWalkthrough: function, extractFromVideo: function, getWalkthroughModes: function }}
 */
export function createVideoWalkthroughAgent(config) {
  const {
    tradeName,
    tradeDescription,
    callMedia,
    parseJson = parseAgentJson,
    buildContextSection = () => '',
    postProcess = null,
  } = config;

  // Merge modes: defaults + overrides
  const modes = { ...DEFAULT_MODES, ...(config.modes || {}) };

  // Merge schemas: defaults + overrides
  const schemas = { ...DEFAULT_SCHEMAS, ...(config.responseSchemas || {}) };

  // Build prompts: default generators + overrides
  const defaultPrompts = buildDefaultPrompts(tradeName, tradeDescription, schemas);
  const promptBuilders = { ...defaultPrompts, ...(config.promptBuilders || {}) };

  /**
   * Extract structured data from a video walkthrough using Gemini.
   * @param {string} base64Video - Base64-encoded video data
   * @param {string} mimeType - Video MIME type
   * @param {string} mode - One of the supported mode keys
   * @param {object} [jobContext={}] - Existing job context
   * @returns {Promise<object>} Structured extraction result
   */
  async function extractFromVideo(base64Video, mimeType, mode, jobContext = {}) {
    const contextSection = buildContextSection(jobContext);
    const modeConfig = modes[mode];
    const promptBuilder = promptBuilders[mode];

    if (!promptBuilder) {
      throw new Error(`No prompt builder for walkthrough mode: "${mode}"`);
    }

    const prompt = promptBuilder(contextSection);

    console.log(`📹 Video walkthrough: ${modeConfig.label} — processing video + audio...`);

    const text = await callMedia(prompt, base64Video, mimeType, {
      temperature: 0.15,
      maxOutputTokens: 6000,
      timeoutMs: 120000,
    });

    return parseJson(text, {
      scopeSummary: text.substring(0, 300),
      extractedData: {},
      rawResponse: text,
    }, `VideoWalkthrough-${mode}`);
  }

  /**
   * Process a video walkthrough end-to-end.
   * @param {object} params
   * @param {string} params.filePath - Path to the uploaded video file
   * @param {string} params.mimeType - Video MIME type
   * @param {string} params.mode - Walkthrough mode
   * @param {object} [params.jobContext={}] - Existing job context
   * @returns {Promise<object>} Final structured result
   */
  async function processVideoWalkthrough({ filePath, mimeType, mode, jobContext = {} }) {
    // Validate mode
    if (!modes[mode]) {
      throw new Error(`Unsupported walkthrough mode: "${mode}". Supported: ${Object.keys(modes).join(', ')}`);
    }

    // Read and encode video
    const videoBuffer = await readFile(filePath);
    const base64Video = videoBuffer.toString('base64');
    const sizeMB = (videoBuffer.length / (1024 * 1024)).toFixed(1);
    console.log(`  📼 Video loaded: ${sizeMB}MB, ${mimeType}`);

    // Extract structured data from video
    const extraction = await extractFromVideo(base64Video, mimeType, mode, jobContext);

    // Clean up temp file
    await unlink(filePath).catch(() => {});

    // Build result
    const result = {
      mode,
      label: modes[mode]?.label || mode,
      videoExtraction: extraction,
    };

    // Let the trade do post-processing (e.g., route to estimator, enrich with RAG)
    if (postProcess) {
      const enriched = await postProcess(mode, extraction, jobContext);
      if (enriched) return { ...result, ...enriched };
    }

    return result;
  }

  /**
   * Get supported walkthrough modes.
   * @returns {Array<{key: string, label: string, icon: string, description: string}>}
   */
  function getWalkthroughModes() {
    return Object.entries(modes).map(([key, val]) => ({
      key,
      label: val.label,
      icon: val.icon,
      description: val.description,
    }));
  }

  return {
    processVideoWalkthrough,
    extractFromVideo,
    getWalkthroughModes,
  };
}
