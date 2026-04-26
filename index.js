/**
 * @krusch/toolkit — Shared utilities for homelab projects
 *
 * Barrel export for all modules.
 *
 * Usage:
 *   import { chat, chatJson, parseAIJson, initDb, query } from '@krusch/toolkit';
 *
 * Or import specific modules:
 *   import { chat } from '@krusch/toolkit/llm';
 *   import { initDb } from '@krusch/toolkit/db';
 *   import { createAuth } from '@krusch/toolkit/auth';
 *   import { sseResponse, streamChat } from '@krusch/toolkit/streaming';
 */

// LLM Client
export { chat, chatJson } from './llm.js';

// JSON Parsing
export { parseAIJson, safeParseJson } from './json-parse.js';

// Configuration
export { loadJsonConfig, createConfig, loadProjectConfig, envOr, envInt, envBool, validateRequired } from './config.js';

// Database
export { initDb, getDb, run, query, queryOne, exec, transaction, prepare, closeDb } from './db.js';

// Image Generation
export { createImageGenerator } from './imagen.js';

// Scheduling
export { createScheduler } from './scheduler.js';

// Authentication
export { createAuth } from './auth.js';

// Streaming (SSE)
export { sseResponse, streamChat } from './streaming.js';

// Vision (Gemini Vision + Construction Dimensions)
export { callGeminiMedia, parseVisionJson, buildDimensionPrompt, CONSTRUCTION_DIMENSIONS, VISION_MODELS, resolveModel } from './vision.js';

// GC Chat (Unified GC/PM chat for BuildOS)
export { createGcRoutes, migrateGcTables, classifyTrades, seedGcKnowledge, GC_SEED_DOCUMENTS, TRADE_META } from './gc-chat.js';

// Agents (Shared agent utilities for all BuildOS trades)
export { createLlmConfig, buildRagContextBlock, buildContextSection, parseAgentJson, formatSources } from './agents.js';

// Video Walkthrough (Trade-parameterized video walkthrough factory)
export { createVideoWalkthroughAgent } from './video-walkthrough.js';

// System (Hardware monitoring and thermal safety)
export { getLiquidTemp, checkThermalSafety } from './system.js';

// Calculator (Shared pure-math utilities for DOE estimation)
export { applyWaste, contractorCost, customerPrice, calcDualPricing, confidenceEnvelope, round2, findCatalogPrice } from './calculator.js';

// AR Scene (Augmented reality scene data structures and marker kit generation)
export { createScene, createLayer, createSegment, createFixture, createMarker, generateMarkerKit, generateDemoScene, sceneToJSON, sceneFromJSON, TRADE_COLORS, MARKER_PATTERNS } from './ar-scene.js';

// AR Routing (AI-powered trade routing engine + conflict detection)
export { buildRoutingPrompt, parseRoutingResponse, detectConflicts, generateTradeRoutes, generateAllTradeRoutes, validatePlumbingSlope, validateElectricalClearance, ROUTING_PROMPTS } from './ar-routing.js';

