/**
 * Rough-In Trade App Factory
 *
 * Configures and starts a fully-wired Express trade app.
 * Eliminates ~90 lines of duplicated boilerplate per package.
 *
 * NOTE: This module lives in the shared `lib/` symlink which has no
 * node_modules. All npm dependencies (express, cors, multer) must be
 * provided by the calling package — see `deps` parameter.
 *
 * Usage (with auto-wiring):
 *   import { createTradeApp } from '../../lib/trade-app-factory.js';
 *   import express from 'express';
 *   import cors from 'cors';
 *   import multer from 'multer';
 *
 *   createTradeApp({
 *     tradeName: 'boardwise',
 *     packageDir: import.meta.url,
 *     config, db, deps: { express, cors, multer },
 *     routes: [{ path: '/api', router: estimatesRouter }],
 *     emoji: '📐',
 *   });
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync } from 'fs';
import { createRagRouter } from './rag-routes.js';
import { createBlueprintRouter } from './blueprint-routes.js';
import { createTradeAuthMiddleware } from './trade-auth.js';
import {
  createJobsRouter, createSettingsRouter, createCtppRouter,
  createVideoRouter, createPhotosRouter,
} from './trade-routes.js';

/**
 * Creates and starts a fully configured Express trade app.
 *
 * @param {Object} options
 * @param {string} [options.tradeName] — trade identifier (e.g. 'boardwise'). When set, auto-wires
 *   standard route factories (jobs, settings, ctpp, photos, video) so the caller only needs
 *   to pass trade-specific routes (estimates).
 * @param {string} options.packageDir — import.meta.url of the calling server.js
 * @param {Object} options.config — resolved config object
 * @param {Object} options.db — { query, queryOne, closePool }
 * @param {Object} options.deps — { express, cors, multer } from the caller's node_modules
 * @param {Array<{path: string, router: import('express').Router}>} [options.routes] — route mounts
 * @param {Object} [options.rag] — { rag, ingestion } modules for RAG chat
 * @param {Object} [options.blueprint] — { analyzeBlueprint, mergeBlueprintScope }
 * @param {Function} [options.analyzePhoto] — vision analysis function for photo uploads
 * @param {Object} [options.videoProcessor] — { processVideoWalkthrough, getWalkthroughModes }
 * @param {string} [options.emoji='📦'] — startup log emoji
 * @param {string} [options.staticDir='public'] — relative path to static assets
 * @param {string|number} [options.jsonLimit] — express.json body limit
 * @returns {{ app: import('express').Express, server: import('http').Server }}
 */
export async function createTradeApp(options) {
  const {
    tradeName,
    packageDir,
    config,
    db,
    deps,
    routes = [],
    rag,
    blueprint,
    analyzePhoto,
    videoProcessor,
    emoji = '📦',
    staticDir = 'public',
    jsonLimit,
  } = options;

  const { express, cors, multer } = deps;
  const __filename = fileURLToPath(packageDir);
  const __dirname = dirname(__filename);

  // Ensure uploads directory exists
  mkdirSync(config.uploads.dir, { recursive: true });

  const app = express();

  // ── Security Middleware ────────────────────────────────
  try {
    const { default: helmet } = await import('helmet');
    app.use(helmet({ contentSecurityPolicy: false })); // CSP off for SPA compatibility
  } catch {
    console.warn('⚠️  helmet not installed — skipping security headers (npm i helmet)');
  }

  // ── Rate Limiting ─────────────────────────────────────
  try {
    const { default: rateLimit } = await import('express-rate-limit');
    app.use('/api', rateLimit({ windowMs: 60_000, limit: 100, standardHeaders: 'draft-8', legacyHeaders: false }));
  } catch {
    console.warn('⚠️  express-rate-limit not installed — skipping rate limiting');
  }

  // ── Middleware ─────────────────────────────────────────
  app.use(cors());
  app.use(express.json(jsonLimit ? { limit: jsonLimit } : undefined));
  app.use(express.static(join(__dirname, staticDir)));

  // Serve uploaded files
  app.use('/uploads', express.static(config.uploads.dir));

  // ── API Key Authentication ────────────────────────────
  app.use('/api', createTradeAuthMiddleware({
    apiKey: config.auth?.tradeApiKey,
  }));

  // ── Health Check ──────────────────────────────────────
  app.get('/api/health', async (req, res) => {
    try {
      await db.queryOne('SELECT 1');
      res.json({ status: 'ok', name: config.app.name, timestamp: new Date().toISOString() });
    } catch (err) {
      console.error('❌ Health check DB ping failed:', err.message);
      res.status(503).json({ status: 'degraded', name: config.app.name, error: 'Database unreachable' });
    }
  });

  // ── Blueprint Upload Middleware ────────────────────────
  const blueprintUpload = multer({
    dest: config.uploads.dir,
    limits: { fileSize: config.uploads.maxFileSize },
    fileFilter: (req, file, cb) => {
      const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'];
      cb(null, allowed.includes(file.mimetype));
    },
  });

  // ── Auto-wired Standard Routes ────────────────────────
  if (tradeName) {
    const jobsRouter = createJobsRouter(tradeName, db);
    const settingsRouter = createSettingsRouter(tradeName, db, config);
    const ctppRouter = createCtppRouter(tradeName, db);
    const photosRouter = createPhotosRouter(tradeName, db, config, analyzePhoto);

    app.use('/api/jobs', jobsRouter);
    app.use('/api/jobs', ctppRouter);
    app.use('/api', photosRouter);
    app.use('/api', settingsRouter);

    if (videoProcessor) {
      app.use('/api', createVideoRouter(tradeName, db, config, videoProcessor));
    }
  }

  // ── Route Mounts ──────────────────────────────────────
  for (const { path, router } of routes) {
    app.use(path, router);
  }

  // RAG chat + knowledge
  if (rag) {
    app.use('/api', createRagRouter(rag.rag, rag.ingestion, { db: { query: db.query, queryOne: db.queryOne } }));
  }

  // Blueprint analysis
  if (blueprint) {
    app.use('/api', createBlueprintRouter(
      { analyzeBlueprint: blueprint.analyzeBlueprint, mergeBlueprintScope: blueprint.mergeBlueprintScope },
      { query: db.query, queryOne: db.queryOne },
      blueprintUpload.single('blueprint'),
    ));
  }

  // ── API 404 Handler ───────────────────────────────────
  app.all('/api/{*path}', (req, res) => {
    res.status(404).json({ error: `Not found: ${req.method} ${req.path}` });
  });

  // ── SPA Fallback ──────────────────────────────────────
  app.get('{*path}', (req, res) => {
    res.sendFile(join(__dirname, staticDir, 'index.html'));
  });

  // ── Error Handler ─────────────────────────────────────
  app.use((err, req, res, _next) => {
    const status = err.status || (err.message?.includes('required') || err.message?.includes('Unsupported') ? 400 : 500);
    const e = status >= 500 ? '❌' : '⚠️';
    console.error(`${e} ${req.method} ${req.path}:`, err.message || err);
    res.status(status).json({ error: err.message || 'Internal server error' });
  });

  // ── Start Server ──────────────────────────────────────
  const server = app.listen(config.app.port, () => {
    console.log(`${emoji} ${config.app.name} running on http://localhost:${config.app.port}`);
    console.log(`   💾 DB: ${config.database.host}:${config.database.port}/${config.database.name}`);
    console.log(`   AI: ${config.ai.apiKey ? '✅ Gemini configured' : '⚠️  No API key — vision disabled'}`);
  });

  // ── Graceful Shutdown ─────────────────────────────────
  function shutdown(signal) {
    console.log(`\n🛑 Received ${signal} — shutting down gracefully...`);
    server.close(async () => {
      await db.closePool();
      console.log(`✅ ${config.app.name} stopped`);
      process.exit(0);
    });
    setTimeout(() => {
      console.error('❌ Forced exit after shutdown timeout');
      process.exit(1);
    }, 10000);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return { app, server };
}
