/**
 * @module lib/trade-routes
 * Shared Express route factories for trade-package boilerplate.
 *
 * All trade packages duplicate these routes with only the trade name
 * string changed. This module parameterizes them into factory functions.
 *
 * Usage (in a trade server.js):
 *   import { createJobsRouter, createSettingsRouter, createCtppRouter, createVideoRouter, createPhotosRouter } from '../../lib/trade-routes.js';
 *   const jobsRouter = createJobsRouter('boardwise', db);
 *   const settingsRouter = createSettingsRouter('boardwise', db, config);
 */

import { Router } from 'express';
import multer from 'multer';
import { mkdirSync, unlinkSync } from 'fs';
import { extname } from 'path';
import { randomUUID } from 'crypto';
import { validate, schemas } from './validate.js';

// ─────────────────────────────────────────────────────────
// Jobs CRUD — list, get, create, update, delete
// ─────────────────────────────────────────────────────────
/**
 * @param {string} tradeName
 * @param {{ query: Function, queryOne: Function, run: Function }} db
 * @returns {Router}
 */
export function createJobsRouter(tradeName, db) {
  const router = Router();

  router.get('/', async (req, res) => {
    const jobs = await db.query(`
      SELECT j.id, j.trade, j.title, j.address, j.client_name, j.client_phone,
             j.status, j.source_app, j.notes, j.created_at, j.updated_at,
             COUNT(e.id) as estimate_count
      FROM jobs j
      LEFT JOIN estimates e ON e.job_id = j.id
      WHERE j.trade = $1
      GROUP BY j.id
      ORDER BY j.updated_at DESC
    `, [tradeName]);
    res.json(jobs);
  });

  router.get('/:id', async (req, res) => {
    const job = await db.queryOne(
      `SELECT id, trade, title, address, client_name, client_phone, client_email,
              status, context, project_id, source_app, source_job_id, source_project_id,
              notes, created_at, updated_at
       FROM jobs WHERE id = $1 AND trade = $2`, [req.params.id, tradeName]);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const photos = await db.query(
      'SELECT id, filename, path, mime_type, photo_type, uploaded_at FROM photos WHERE job_id = $1 ORDER BY uploaded_at DESC', [job.id]);
    const estimates = await db.query(
      'SELECT id, label, status, created_at, updated_at FROM estimates WHERE job_id = $1 ORDER BY created_at DESC', [job.id]);
    res.json({ ...job, photos, estimates });
  });

  router.post('/', validate(schemas.createJob), async (req, res) => {
    const { name, address, client_name, client_phone, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'Job name is required' });
    const rows = await db.query(
      `INSERT INTO jobs (trade, title, address, client_name, client_phone, notes)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [tradeName, name, address || null, client_name || null, client_phone || null, notes || null]
    );
    res.status(201).json(rows[0]);
  });

  router.put('/:id', validate(schemas.updateJob), async (req, res) => {
    const job = await db.queryOne(
      'SELECT id, title, trade, address, client_name, client_phone, notes FROM jobs WHERE id = $1 AND trade = $2', [req.params.id, tradeName]);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const { name, address, client_name, client_phone, notes } = req.body;
    const rows = await db.query(
      `UPDATE jobs SET title = $1, address = $2, client_name = $3, client_phone = $4, notes = $5, updated_at = NOW()
       WHERE id = $6 RETURNING *`,
      [name || job.title, address ?? job.address, client_name ?? job.client_name, client_phone ?? job.client_phone, notes ?? job.notes, job.id]
    );
    res.json(rows[0]);
  });

  router.delete('/:id', async (req, res) => {
    const job = await db.queryOne('SELECT id FROM jobs WHERE id = $1 AND trade = $2', [req.params.id, tradeName]);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    await db.run('DELETE FROM jobs WHERE id = $1', [job.id]);
    res.json({ deleted: true });
  });

  return router;
}

// ─────────────────────────────────────────────────────────
// Settings — get + update trade-scoped settings
// ─────────────────────────────────────────────────────────
/**
 * @param {string} tradeName
 * @param {{ query: Function, run: Function }} db
 * @param {object} config - Trade config (for defaults)
 * @returns {Router}
 */
export function createSettingsRouter(tradeName, db, config) {
  const router = Router();

  function buildSettingsResponse(rows) {
    const settings = {};
    rows.forEach(r => { settings[r.key] = r.value; });
    return {
      defaultLaborRate: parseFloat(settings.defaultLaborRate || config.settings.defaultLaborRate),
      defaultMarkupPct: parseFloat(settings.defaultMarkupPct || config.settings.defaultMarkupPct),
    };
  }

  router.get('/settings', async (req, res) => {
    const rows = await db.query('SELECT key, value FROM settings WHERE trade = $1', [tradeName]);
    res.json(buildSettingsResponse(rows));
  });

  router.put('/settings', async (req, res) => {
    const { defaultLaborRate, defaultMarkupPct } = req.body;
    if (defaultLaborRate !== undefined) {
      await db.run(
        `INSERT INTO settings (trade, key, value) VALUES ($1, $2, $3)
         ON CONFLICT (trade, key) DO UPDATE SET value = EXCLUDED.value`,
        [tradeName, 'defaultLaborRate', String(defaultLaborRate)]
      );
    }
    if (defaultMarkupPct !== undefined) {
      await db.run(
        `INSERT INTO settings (trade, key, value) VALUES ($1, $2, $3)
         ON CONFLICT (trade, key) DO UPDATE SET value = EXCLUDED.value`,
        [tradeName, 'defaultMarkupPct', String(defaultMarkupPct)]
      );
    }
    const rows = await db.query('SELECT key, value FROM settings WHERE trade = $1', [tradeName]);
    res.json(buildSettingsResponse(rows));
  });

  return router;
}

// ─────────────────────────────────────────────────────────
// CTPP — Cross-Trade Project Package import / export
// ─────────────────────────────────────────────────────────
/**
 * @param {string} tradeName
 * @param {{ query: Function, queryOne: Function }} db
 * @returns {Router}
 */
export function createCtppRouter(tradeName, db) {
  const router = Router();

  router.post('/import', async (req, res) => {
    const pkg = req.body;
    if (!pkg || pkg.ctpp_version !== '1.0') {
      return res.status(400).json({ error: 'Invalid CTPP package — requires ctpp_version: "1.0"' });
    }
    const rows = await db.query(
      `INSERT INTO jobs (trade, title, address, client_name, client_phone, source_app, source_job_id, source_project_id, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [tradeName, pkg.scope_notes || pkg.property?.address || 'Imported Job',
       pkg.property?.address || null, pkg.client?.name || null, pkg.client?.phone || null,
       pkg.source_app || null, pkg.source_job_id || null, pkg.source_project_id || null,
       pkg.scope_notes || null]
    );
    res.status(201).json({ imported: true, job: rows[0] });
  });

  router.get('/:id/export', async (req, res) => {
    const job = await db.queryOne(
      `SELECT id, title, address, client_name, client_phone, source_project_id, notes
       FROM jobs WHERE id = $1`, [req.params.id]);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const estimates = await db.query(
      'SELECT id, label, status FROM estimates WHERE job_id = $1 ORDER BY created_at DESC LIMIT 1', [job.id]);
    const photos = await db.query(
      'SELECT filename, uploaded_at FROM photos WHERE job_id = $1 ORDER BY uploaded_at DESC', [job.id]);
    const ctpp = {
      ctpp_version: '1.0',
      source_app: tradeName,
      source_job_id: String(job.id),
      source_project_id: job.source_project_id || null,
      client: { name: job.client_name, phone: job.client_phone },
      property: { address: job.address },
      photos: photos.map(p => ({ filename: p.filename, type: 'site', uploaded_at: p.uploaded_at })),
      scope_notes: job.notes,
      estimate_summary: estimates[0] ? { id: estimates[0].id, label: estimates[0].label, status: estimates[0].status } : null,
    };
    res.json(ctpp);
  });

  return router;
}

// ─────────────────────────────────────────────────────────
// Video Walkthrough — upload, process, list, get
// ─────────────────────────────────────────────────────────
/**
 * @param {string} tradeName
 * @param {{ query: Function, queryOne: Function }} db
 * @param {object} config - Trade config (for upload dir/limits)
 * @param {{ processVideoWalkthrough: Function, getWalkthroughModes: Function }} videoProcessor
 * @returns {Router}
 */
export function createVideoRouter(tradeName, db, config, videoProcessor) {
  const { processVideoWalkthrough, getWalkthroughModes } = videoProcessor;

  const videoUpload = multer({
    dest: config.uploads.dir,
    limits: { fileSize: 30 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      const allowed = ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska'];
      cb(null, allowed.includes(file.mimetype));
    },
  });

  const router = Router();

  router.get('/video-walkthrough/modes', (req, res) => {
    res.json(getWalkthroughModes());
  });

  router.post('/video-walkthrough', videoUpload.single('video'), async (req, res) => {
    const { mode, jobId } = req.body;
    if (!req.file) return res.status(400).json({ error: 'No video uploaded or unsupported format.' });
    if (!mode) return res.status(400).json({ error: 'Missing "mode" field.' });

    let jobContext = {};
    if (jobId) {
      const job = await db.queryOne('SELECT id, notes FROM jobs WHERE id = $1', [jobId]);
      if (job?.notes) try { jobContext = JSON.parse(job.notes); } catch { jobContext = { notes: job.notes }; }
    }

    const result = await processVideoWalkthrough({ filePath: req.file.path, mimeType: req.file.mimetype, mode, jobContext });

    const rows = await db.query(
      `INSERT INTO video_walkthroughs (job_id, trade, mode, original_filename, file_size, extraction, result)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [jobId || null, tradeName, mode, req.file.originalname, req.file.size,
       JSON.stringify(result.videoExtraction || {}), JSON.stringify(result)]
    );

    res.json({ id: rows[0].id, createdAt: rows[0].created_at, ...result });
  });

  router.get('/video-walkthroughs', async (req, res) => {
    const { jobId } = req.query;
    let sql = `SELECT id, job_id, mode, original_filename, file_size, created_at FROM video_walkthroughs WHERE trade = $1`;
    const params = [tradeName];
    if (jobId) { sql += ' AND job_id = $2'; params.push(jobId); }
    sql += ' ORDER BY created_at DESC LIMIT 50';
    res.json(await db.query(sql, params));
  });

  router.get('/video-walkthroughs/:id', async (req, res) => {
    const row = await db.queryOne('SELECT * FROM video_walkthroughs WHERE id = $1', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Walkthrough not found' });
    if (row.extraction && typeof row.extraction === 'string') try { row.extraction = JSON.parse(row.extraction); } catch {}
    if (row.result && typeof row.result === 'string') try { row.result = JSON.parse(row.result); } catch {}
    res.json(row);
  });

  return router;
}

// ─────────────────────────────────────────────────────────
// Photos — upload with optional vision analysis, list, delete
// ─────────────────────────────────────────────────────────
/**
 * @param {string} tradeName
 * @param {{ query: Function, queryOne: Function, run: Function }} db
 * @param {object} config - Trade config (for upload dir/limits, ai.apiKey)
 * @param {Function} [analyzePhoto] - Optional vision analysis function(filePath, mimeType)
 * @returns {Router}
 */
export function createPhotosRouter(tradeName, db, config, analyzePhoto) {

  mkdirSync(config.uploads.dir, { recursive: true });

  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, config.uploads.dir),
    filename: (req, file, cb) => {
      const ext = extname(file.originalname) || '.jpg';
      cb(null, `${randomUUID()}${ext}`);
    },
  });

  const upload = multer({
    storage,
    limits: { fileSize: config.uploads.maxFileSize },
    fileFilter: (req, file, cb) => {
      const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'];
      cb(null, allowed.includes(file.mimetype));
    },
  });

  const router = Router();

  router.post('/:jobId/photos', upload.single('photo'), async (req, res) => {
    const job = await db.queryOne('SELECT id FROM jobs WHERE id = $1', [req.params.jobId]);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (!req.file) return res.status(400).json({ error: 'No photo uploaded' });

    let analysisJson = null;
    if (analyzePhoto && config.ai?.apiKey) {
      try {
        analysisJson = await analyzePhoto(req.file.path, req.file.mimetype);
      } catch (err) {
        console.error(`⚠️  Vision analysis failed:`, err.message);
      }
    }

    const rows = await db.query(
      `INSERT INTO photos (job_id, trade, filename, path, mime_type, analysis_json)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [job.id, tradeName, req.file.filename, req.file.path, req.file.mimetype, analysisJson ? JSON.stringify(analysisJson) : null]
    );

    await db.run('UPDATE jobs SET updated_at = NOW() WHERE id = $1', [job.id]);
    res.status(201).json(rows[0]);
  });

  router.get('/:jobId/photos', async (req, res) => {
    const photos = await db.query('SELECT id, filename, path, mime_type, photo_type, uploaded_at FROM photos WHERE job_id = $1 ORDER BY uploaded_at DESC', [req.params.jobId]);
    res.json(photos);
  });

  router.delete('/photos/:id', async (req, res) => {
    const photo = await db.queryOne('SELECT id, path FROM photos WHERE id = $1', [req.params.id]);
    if (!photo) return res.status(404).json({ error: 'Photo not found' });
    try { unlinkSync(photo.path); } catch {}
    await db.run('DELETE FROM photos WHERE id = $1', [photo.id]);
    res.json({ deleted: true });
  });

  return router;
}
