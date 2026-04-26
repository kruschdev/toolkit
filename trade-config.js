/**
 * @module lib/trade-config
 * Shared config factory for trade packages.
 *
 * Every trade package's config.js was ~54 identical lines differing
 * only by app name, port, and default labor/markup rates.
 * This factory parameterizes those differences.
 *
 * Usage:
 *   import { createTradeConfig } from '../../lib/trade-config.js';
 *   export default await createTradeConfig(import.meta.url, {
 *     name: 'BoardWise', port: 3800, laborRate: 50, markupPct: 30,
 *   });
 */

import { loadProjectConfig, envOr, envInt } from '@krusch/toolkit/config';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

/**
 * Creates a fully-resolved trade config object.
 *
 * @param {string} callerUrl — import.meta.url of the calling config.js
 * @param {object} opts
 * @param {string} opts.name — display name (e.g. 'BoardWise')
 * @param {number} opts.port — default HTTP port
 * @param {number} [opts.laborRate=50] — default labor rate $/hr
 * @param {number} [opts.markupPct=30] — default customer markup %
 * @returns {Promise<object>} resolved config
 */
export async function createTradeConfig(callerUrl, { name, port, laborRate = 50, markupPct = 30 }) {
  const __dirname = dirname(fileURLToPath(callerUrl));
  const fileConfig = await loadProjectConfig(__dirname);

  return {
    app: {
      port: envInt('PORT', fileConfig.app?.port, port),
      env: envOr('NODE_ENV', fileConfig.app?.env, 'development'),
      name: fileConfig.app?.name || name,
    },
    database: {
      host: envOr('DB_HOST', fileConfig.database?.host, 'localhost'),
      port: envInt('DB_PORT', fileConfig.database?.port, 5435),
      name: envOr('DB_NAME', fileConfig.database?.name, 'roughin'),
      user: envOr('DB_USER', fileConfig.database?.user, 'roughin'),
      password: envOr('DB_PASSWORD', fileConfig.database?.password, 'roughin_dev'),
    },
    ai: {
      provider: envOr('AI_PROVIDER', fileConfig.ai?.provider, 'gemini'),
      apiKey: envOr('GEMINI_API_KEY', null, ''),
      fastModel: envOr('AI_FAST_MODEL', fileConfig.ai?.fastModel, 'gemini-2.5-flash'),
      model: envOr('AI_MODEL', fileConfig.ai?.model, 'gemini-2.5-flash'),
      analysisModel: envOr('AI_ANALYSIS_MODEL', fileConfig.ai?.analysisModel, 'gemini-2.5-flash'),
      embeddingModel: envOr('EMBEDDING_MODEL', fileConfig.ai?.embeddingModel, 'gemini-embedding-001'),
      maxContextChunks: envInt('MAX_CONTEXT_CHUNKS', fileConfig.ai?.maxContextChunks, 5),
      similarityThreshold: parseFloat(envOr('SIMILARITY_THRESHOLD', fileConfig.ai?.similarityThreshold, '0.3')),
      contextTruncateLength: envInt('CONTEXT_TRUNCATE_LENGTH', fileConfig.ai?.contextTruncateLength, 500),
    },
    ingestion: {
      chunkSize: envInt('CHUNK_SIZE', fileConfig.ingestion?.chunkSize, 1500),
      chunkOverlap: envInt('CHUNK_OVERLAP', fileConfig.ingestion?.chunkOverlap, 200),
      batchSize: envInt('BATCH_SIZE', fileConfig.ingestion?.batchSize, 20),
      batchDelayMs: envInt('BATCH_DELAY_MS', fileConfig.ingestion?.batchDelayMs, 500),
    },
    uploads: {
      dir: envOr('UPLOADS_DIR', fileConfig.uploads?.dir, join(__dirname, 'data', 'uploads')),
      maxFileSize: envInt('MAX_UPLOAD_SIZE', fileConfig.uploads?.maxFileSize, 10 * 1024 * 1024),
    },
    auth: {
      tradeApiKey: envOr('TRADE_API_KEY', fileConfig.auth?.tradeApiKey, ''),
    },
    settings: {
      defaultLaborRate: parseFloat(envOr('DEFAULT_LABOR_RATE', fileConfig.settings?.defaultLaborRate, String(laborRate))),
      defaultMarkupPct: parseFloat(envOr('DEFAULT_MARKUP_PCT', fileConfig.settings?.defaultMarkupPct, String(markupPct))),
    },
  };
}
