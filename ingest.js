/**
 * @module lib/ingest
 * Shared document ingestion factory for all BuildOS trades.
 *
 * Usage:
 *   import { createIngestion } from '../../lib/ingest.js';
 *   const { ingestDocument, deleteDocument, listDocuments, chunkText } = createIngestion(config, 'brushwise', embeddings, db);
 */

/**
 * Split text into chunks that respect section boundaries.
 * Tries to break at paragraph boundaries, falls back to sentence boundaries.
 * @param {string} text
 * @param {number} chunkSize
 * @param {number} chunkOverlap
 * @returns {string[]}
 */
export function chunkText(text, chunkSize = 1500, chunkOverlap = 200) {
  if (text.length <= chunkSize) return [text.trim()];

  const chunks = [];
  const paragraphs = text.split(/\n\n+/);
  let currentChunk = '';

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;

    if (currentChunk.length + trimmed.length + 2 > chunkSize && currentChunk.length > 0) {
      chunks.push(currentChunk.trim());

      if (chunkOverlap > 0 && currentChunk.length > chunkOverlap) {
        currentChunk = currentChunk.slice(-chunkOverlap) + '\n\n' + trimmed;
      } else {
        currentChunk = trimmed;
      }
    } else {
      currentChunk = currentChunk ? currentChunk + '\n\n' + trimmed : trimmed;
    }

    // Handle paragraphs larger than chunk size — split by sentences
    if (currentChunk.length > chunkSize) {
      const sentences = currentChunk.split(/(?<=[.!?])\s+/);
      currentChunk = '';

      for (const sentence of sentences) {
        if (currentChunk.length + sentence.length + 1 > chunkSize && currentChunk.length > 0) {
          chunks.push(currentChunk.trim());
          currentChunk = chunkOverlap > 0 ? currentChunk.slice(-chunkOverlap) + ' ' + sentence : sentence;
        } else {
          currentChunk = currentChunk ? currentChunk + ' ' + sentence : sentence;
        }
      }
    }
  }

  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

/**
 * Create an ingestion module bound to a specific trade.
 *
 * @param {object} config - Project config with ingestion settings
 * @param {string} tradeName - Trade identifier (e.g. 'spark', 'brushwise')
 * @param {{ embedBatch: Function }} embeddings - Embeddings module (from createEmbeddings)
 * @param {{ query: Function, queryOne: Function, run: Function, getPool: Function }} db - Database functions
 * @returns {{ ingestDocument, deleteDocument, listDocuments, chunkText: Function }}
 */
export function createIngestion(config, tradeName, embeddings, db) {
  const pgvectorImport = import('pgvector').then((m) => m.default || m);

  /**
   * Ingest a document: parse, chunk, embed, and store.
   * @param {object} params
   * @param {string} params.title
   * @param {string} params.content
   * @param {string} [params.sourceType='general']
   * @param {string} [params.sourceRef]
   * @param {object} [params.metadata={}]
   * @returns {Promise<{documentId: number, chunkCount: number}>}
   */
  async function ingestDocument({ title, content, sourceType = 'general', sourceRef = null, metadata = {} }) {
    const pgvector = await pgvectorImport;
    console.log(`📝 Ingesting document: "${title}" (${sourceType}) [${tradeName}]`);

    // 1. Insert document record
    const docResult = await db.query(
      `INSERT INTO documents (title, source_type, source_ref, content, trade)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [title, sourceType, sourceRef, content, tradeName]
    );
    const documentId = docResult[0].id;

    // 2. Chunk the content
    const chunkSize = config.ingestion?.chunkSize || 1500;
    const chunkOverlap = config.ingestion?.chunkOverlap || 200;
    const chunks = chunkText(content, chunkSize, chunkOverlap);
    console.log(`  🔍 Split into ${chunks.length} chunks`);

    // 3. Embed all chunks
    const embeddingVectors = await embeddings.embedBatch(chunks);

    // 4. Store chunks with embeddings (batched multi-row INSERT in a transaction)
    const pool = db.getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const chunkMeta = JSON.stringify({ ...metadata, sourceRef, sourceType });
      const valuesClauses = [];
      const params = [];
      let paramIdx = 1;

      for (let i = 0; i < chunks.length; i++) {
        valuesClauses.push(`($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++})`);
        params.push(documentId, chunks[i], i, chunkMeta, pgvector.toSql(embeddingVectors[i]), tradeName);
      }

      await client.query(
        `INSERT INTO chunks (document_id, content, chunk_index, metadata, embedding, trade)
         VALUES ${valuesClauses.join(', ')}`,
        params
      );

      await client.query(
        'UPDATE documents SET chunk_count = $1, updated_at = NOW() WHERE id = $2',
        [chunks.length, documentId]
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    console.log(`  ✅ Ingested ${chunks.length} chunks for "${title}" [${tradeName}]`);
    return { documentId, chunkCount: chunks.length };
  }

  /**
   * Delete a document and all its chunks/embeddings.
   * @param {number} documentId
   * @returns {Promise<boolean>}
   */
  async function deleteDocument(documentId) {
    const doc = await db.queryOne('SELECT title FROM documents WHERE id = $1 AND trade = $2', [documentId, tradeName]);
    if (!doc) return false;

    await db.run('DELETE FROM documents WHERE id = $1 AND trade = $2', [documentId, tradeName]);
    console.log(`  🗑️ Deleted document "${doc.title}" and all chunks [${tradeName}]`);
    return true;
  }

  /**
   * List all ingested documents for this trade.
   * @returns {Promise<Array>}
   */
  async function listDocuments() {
    return db.query(
      `SELECT id, title, source_type, source_ref, chunk_count, created_at, updated_at
       FROM documents
       WHERE trade = $1
       ORDER BY created_at DESC`,
      [tradeName]
    );
  }

  return { ingestDocument, deleteDocument, listDocuments, chunkText };
}
