/**
 * @module lib/blueprint-routes
 * Shared Express router factory for blueprint analysis endpoints.
 * Follows the same pattern as lib/rag-routes.js.
 *
 * Usage:
 *   import { createBlueprintRouter } from '../../lib/blueprint-routes.js';
 *   const blueprintRouter = createBlueprintRouter(blueprintAnalyzer, db, uploadMiddleware);
 *   app.use('/api', blueprintRouter);
 */

import { Router } from 'express';
import { readFile } from 'fs/promises';

/**
 * Create an Express router for blueprint analysis endpoints.
 *
 * @param {{ analyzeBlueprint: Function, mergeBlueprintScope: Function }} analyzer - Blueprint analyzer from createBlueprintAnalyzer
 * @param {{ query: Function, queryOne: Function }} db - Database query functions
 * @param {Function} uploadMiddleware - multer upload.single('blueprint') middleware
 * @returns {Router} Express router
 */
export function createBlueprintRouter(analyzer, db, uploadMiddleware) {
  const router = Router();

  // ==========================================
  // Blueprint Analysis
  // ==========================================

  /** Analyze a blueprint image (standalone, no job) */
  router.post('/blueprint/analyze', uploadMiddleware, asyncHandler(async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'No blueprint image uploaded (use field name "blueprint")' });
    }

    console.log(`📐 Standalone blueprint analysis: ${req.file.originalname}`);

    const imageBuffer = await readFile(req.file.path);
    const base64Image = imageBuffer.toString('base64');
    const analysis = await analyzer.analyzeBlueprint(base64Image, req.file.mimetype);

    res.json({
      filename: req.file.originalname,
      analysis,
      hasSpatial: !!analysis.spatial,
      wallCount: analysis.spatial?.walls?.length || 0,
      roomCount: analysis.spatial?.rooms?.length || 0,
      analyzedAt: new Date().toISOString(),
    });
  }));

  /** Upload and analyze a blueprint for a specific job */
  router.post('/jobs/:id/blueprint', uploadMiddleware, asyncHandler(async (req, res) => {
    const jobId = parseInt(req.params.id);
    const job = await db.queryOne('SELECT * FROM jobs WHERE id = $1', [jobId]);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    if (!req.file) {
      return res.status(400).json({ error: 'No blueprint image uploaded (use field name "blueprint")' });
    }

    console.log(`📐 Blueprint analysis for job #${jobId}: ${req.file.originalname}`);

    const imageBuffer = await readFile(req.file.path);
    const base64Image = imageBuffer.toString('base64');
    const analysis = await analyzer.analyzeBlueprint(base64Image, req.file.mimetype);

    // Save blueprint analysis record
    const record = await db.queryOne(
      `INSERT INTO blueprint_analyses (job_id, original_filename, mime_type, analysis)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [jobId, req.file.originalname, req.file.mimetype, JSON.stringify(analysis)]
    );

    // Merge scope into job context
    const existingContext = typeof job.context === 'string' ? JSON.parse(job.context) : (job.context || {});
    const mergedContext = analyzer.mergeBlueprintScope(existingContext, analysis);
    await db.query(
      'UPDATE jobs SET context = $1, updated_at = NOW() WHERE id = $2',
      [JSON.stringify(mergedContext), jobId]
    );
    console.log(`  📋 Blueprint scope merged into job #${jobId} context`);

    res.json({
      blueprint: record,
      analysis,
      hasSpatial: !!analysis.spatial,
      updatedContext: mergedContext,
    });
  }));

  /** List blueprint analyses for a job */
  router.get('/jobs/:id/blueprints', asyncHandler(async (req, res) => {
    const blueprints = await db.query(
      `SELECT id, job_id, original_filename, mime_type, analysis, created_at
       FROM blueprint_analyses WHERE job_id = $1 ORDER BY created_at DESC`,
      [parseInt(req.params.id)]
    );
    res.json(blueprints);
  }));

  /** Delete a blueprint analysis */
  router.delete('/blueprints/:id', asyncHandler(async (req, res) => {
    const bp = await db.queryOne('SELECT id FROM blueprint_analyses WHERE id = $1', [parseInt(req.params.id)]);
    if (!bp) return res.status(404).json({ error: 'Blueprint analysis not found' });
    await db.query('DELETE FROM blueprint_analyses WHERE id = $1', [bp.id]);
    res.json({ deleted: true });
  }));

  return router;
}

/**
 * Async route handler wrapper for Express.
 * @param {Function} fn - Async route handler
 * @returns {Function} Express middleware
 */
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
