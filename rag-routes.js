/**
 * @module lib/rag-routes
 * Shared Express router factory for RAG chat + knowledge management endpoints.
 * Every BuildOS trade mounts this with its own RAG + ingestion modules.
 *
 * Usage:
 *   import { createRagRouter } from '../../lib/rag-routes.js';
 *   app.use('/api', createRagRouter(rag, ingestion, { db }));
 */
import { Router } from 'express';
import { sseResponse } from '@krusch/toolkit/streaming';

/**
 * Create an Express router with RAG chat, streaming, and knowledge management endpoints.
 *
 * @param {object} rag - RAG module from createRag (queryWithContext, streamQueryWithContext, saveMessage, createSession, etc.)
 * @param {object} ingestion - Ingestion module from createIngestion (ingestDocument, deleteDocument, listDocuments)
 * @param {object} [options={}]
 * @param {object} [options.db] - Database module with query/queryOne (for job context loading)
 * @returns {Router}
 */
export function createRagRouter(rag, ingestion, options = {}) {
  const router = Router();
  const db = options.db || null;

  // ── Helper: load job context from DB ──────────────────────────────

  async function loadJobContext(jobId) {
    if (!jobId || !db?.queryOne) return null;
    const job = await db.queryOne('SELECT context FROM jobs WHERE id = $1', [jobId]);
    return job?.context || null;
  }

  async function linkSessionToJob(sessionId, jobId) {
    if (!jobId || !db?.query) return;
    await db.query('UPDATE sessions SET job_id = $1 WHERE id = $2', [jobId, sessionId]);
  }

  // ── Chat ──────────────────────────────────────────────────────────

  /** POST /api/chat — RAG query (with auto-session creation + job context) */
  router.post('/chat', async (req, res, next) => {
    try {
      const { message, sessionId, jobId, jobContext: explicitJobContext } = req.body;
      if (!message?.trim()) return res.status(400).json({ error: 'message is required' });

      // Auto-create session if none provided
      let activeSessionId = sessionId;
      if (!activeSessionId) {
        const session = await rag.createSession(message.substring(0, 60));
        activeSessionId = session.id;
        await linkSessionToJob(activeSessionId, jobId);
      }

      // Load job context: explicit > from DB > null
      const jobContext = explicitJobContext || await loadJobContext(jobId);

      // Save user message
      await rag.saveMessage(activeSessionId, 'user', message);

      // Get RAG response
      const { answer, sources } = await rag.queryWithContext(message, activeSessionId, jobContext);

      // Save assistant message
      await rag.saveMessage(activeSessionId, 'assistant', answer, sources);

      res.json({ sessionId: activeSessionId, answer, sources });
    } catch (err) {
      next(err);
    }
  });

  /** POST /api/chat/stream — Streaming SSE RAG response */
  router.post('/chat/stream', async (req, res, next) => {
    try {
      const { message, sessionId, jobId, jobContext: explicitJobContext } = req.body;
      if (!message?.trim()) return res.status(400).json({ error: 'message is required' });

      // Auto-create session if none provided
      let activeSessionId = sessionId;
      if (!activeSessionId) {
        const session = await rag.createSession(message.substring(0, 60));
        activeSessionId = session.id;
        await linkSessionToJob(activeSessionId, jobId);
      }

      // Load job context
      const jobContext = explicitJobContext || await loadJobContext(jobId);

      // Save user message
      await rag.saveMessage(activeSessionId, 'user', message);

      // Set up SSE response
      const sse = sseResponse(res);
      sse.send(JSON.stringify({ sessionId: activeSessionId }), 'session');

      try {
        // Stream RAG response — onChunk pushes each token to SSE
        const { answer, sources } = await rag.streamQueryWithContext(
          message, activeSessionId,
          (chunk) => sse.send(chunk),
          jobContext
        );

        // Send sources after streaming completes
        sse.send(JSON.stringify(sources), 'sources');

        // Save assistant message
        await rag.saveMessage(activeSessionId, 'assistant', answer, sources);

        sse.end();
      } catch (err) {
        console.error('❌ Stream error:', err.message);
        sse.error(err.message);
        sse.end();
      }
    } catch (err) {
      next(err);
    }
  });

  // ── Sessions ──────────────────────────────────────────────────────

  /** GET /api/sessions — list all chat sessions */
  router.get('/sessions', async (req, res, next) => {
    try {
      const sessions = await rag.listSessions();
      res.json(sessions);
    } catch (err) {
      next(err);
    }
  });

  /** POST /api/sessions — create a new session */
  router.post('/sessions', async (req, res, next) => {
    try {
      const { title } = req.body;
      const session = await rag.createSession(title);
      res.status(201).json(session);
    } catch (err) {
      next(err);
    }
  });

  /** GET /api/sessions/:id/messages — get all messages in a session */
  router.get('/sessions/:id/messages', async (req, res, next) => {
    try {
      const messages = await rag.getSessionMessages(parseInt(req.params.id));
      res.json(messages);
    } catch (err) {
      next(err);
    }
  });

  /** DELETE /api/sessions/:id — delete a session */
  router.delete('/sessions/:id', async (req, res, next) => {
    try {
      const deleted = await rag.deleteSession(parseInt(req.params.id));
      if (!deleted) return res.status(404).json({ error: 'Session not found' });
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  });

  // ── Knowledge Management ──────────────────────────────────────────

  /** GET /api/knowledge — list all ingested documents */
  router.get('/knowledge', async (req, res, next) => {
    try {
      const docs = await ingestion.listDocuments();
      res.json(docs);
    } catch (err) {
      next(err);
    }
  });

  /** POST /api/knowledge — ingest a new document */
  router.post('/knowledge', async (req, res, next) => {
    try {
      const { title, content, sourceType, sourceRef, metadata } = req.body;
      if (!title || !content) return res.status(400).json({ error: 'title and content are required' });

      const result = await ingestion.ingestDocument({ title, content, sourceType, sourceRef, metadata });
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  });

  /** DELETE /api/knowledge/:id — delete a document and its chunks */
  router.delete('/knowledge/:id', async (req, res, next) => {
    try {
      const deleted = await ingestion.deleteDocument(parseInt(req.params.id));
      if (!deleted) return res.status(404).json({ error: 'Document not found' });
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
