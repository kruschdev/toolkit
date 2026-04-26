/**
 * @krusch/toolkit — Shared utilities for homelab projects
 *
 * Barrel export for core modules used by heyjb and pocketlawyer.
 *
 * Usage:
 *   import { chat, chatJson, parseAIJson, initDb, query } from '@krusch/toolkit';
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
