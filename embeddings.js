/**
 * @module lib/embeddings
 * Shared embedding + similarity search factory for all BuildOS trades.
 *
 * Usage:
 *   import { createEmbeddings } from '../../lib/embeddings.js';
 *   const { embedText, embedBatch, similaritySearch } = createEmbeddings(config, 'brushwise', pool);
 */
import pgvector from 'pgvector';

const { toSql } = pgvector;

/** Status codes that warrant an automatic retry */
const RETRYABLE_STATUSES = new Set([429, 500, 503]);

/**
 * Fetch with exponential-backoff retry for transient API errors.
 * @param {string} url
 * @param {RequestInit} options
 * @param {number} [maxRetries=3]
 * @returns {Promise<Response>}
 */
async function fetchWithRetry(url, options, maxRetries = 3) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);
      if (response.ok || !RETRYABLE_STATUSES.has(response.status)) return response;

      lastError = new Error(`HTTP ${response.status}`);
      if (attempt < maxRetries) {
        const delayMs = 1000 * 2 ** attempt;
        console.warn(`⚠️ Embedding API ${response.status}, retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxRetries})...`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      } else {
        const errorBody = await response.text();
        throw new Error(`🧠 Embedding API error after ${maxRetries} retries (${response.status}): ${errorBody}`);
      }
    } catch (err) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') throw err;
      lastError = err;
      if (attempt >= maxRetries) throw err;
      const delayMs = 1000 * 2 ** attempt;
      console.warn(`⚠️ Embedding fetch error, retrying in ${delayMs}ms: ${err.message}`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

/**
 * Create an embeddings module bound to a specific trade and config.
 *
 * @param {object} config - Project config with ai.apiKey, ai.embeddingModel, ai.maxContextChunks, ai.similarityThreshold, ingestion.batchSize, ingestion.batchDelayMs
 * @param {string} tradeName - Trade identifier (e.g. 'spark', 'brushwise')
 * @param {{ query: Function, queryOne: Function }} db - Database query functions
 * @returns {{ embedText, embedBatch, similaritySearch }}
 */
export function createEmbeddings(config, tradeName, db) {

  /**
   * Generate an embedding vector for a text string using the Gemini API.
   * @param {string} text
   * @returns {Promise<number[]>}
   */
  async function embedText(text) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.ai.embeddingModel}:embedContent`;

    const response = await fetchWithRetry(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': config.ai.apiKey,
      },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        model: `models/${config.ai.embeddingModel}`,
        content: { parts: [{ text }] },
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`🧠 Embedding API error (${response.status}): ${errorBody}`);
    }

    const data = await response.json();
    return data.embedding.values;
  }

  /**
   * Embed an array of texts using the Gemini batchEmbedContents endpoint.
   * @param {string[]} texts
   * @returns {Promise<number[][]>}
   */
  async function embedBatch(texts) {
    const results = [];
    const batchSize = config.ingestion.batchSize;
    const batchDelay = config.ingestion.batchDelayMs || 500;

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.ai.embeddingModel}:batchEmbedContents`;

      const response = await fetchWithRetry(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': config.ai.apiKey,
        },
        signal: AbortSignal.timeout(60_000),
        body: JSON.stringify({
          requests: batch.map((text) => ({
            model: `models/${config.ai.embeddingModel}`,
            content: { parts: [{ text }] },
          })),
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`🧠 Batch Embedding API error (${response.status}): ${errorBody}`);
      }

      const data = await response.json();
      const embeddings = data.embeddings.map((e) => e.values);
      results.push(...embeddings);

      // Rate-limiting pause between batches
      if (i + batchSize < texts.length) {
        await new Promise((resolve) => setTimeout(resolve, batchDelay));
      }

      console.log(`🧠 Embedded ${Math.min(i + batchSize, texts.length)}/${texts.length} chunks`);
    }

    return results;
  }

  /**
   * Search for similar chunks using pgvector cosine distance, filtered by trade.
   * @param {string} queryText
   * @param {number} [limit]
   * @param {number} [threshold]
   * @returns {Promise<Array>}
   */
  async function similaritySearch(queryText, limit, threshold) {
    const maxResults = limit || config.ai.maxContextChunks || 5;
    const minScore = threshold || config.ai.similarityThreshold || 0.3;

    const queryEmbedding = await embedText(queryText);
    const vectorSql = toSql(queryEmbedding);

    const maxDistance = 1 - minScore;
    const results = await db.query(
      `SELECT
         c.id, c.content, c.metadata, c.chunk_index,
         d.title AS document_title, d.source_type, d.source_ref,
         1 - (c.embedding <=> $1::vector) AS similarity
       FROM chunks c
       JOIN documents d ON d.id = c.document_id
       WHERE c.embedding IS NOT NULL
         AND c.trade = $4
         AND (c.embedding <=> $1::vector) <= $3::float
       ORDER BY c.embedding <=> $1::vector ASC
       LIMIT $2`,
      [vectorSql, maxResults, maxDistance, tradeName]
    );

    return results.map((r) => ({
      id: r.id,
      content: r.content,
      metadata: r.metadata,
      chunkIndex: r.chunk_index,
      documentTitle: r.document_title,
      sourceType: r.source_type,
      sourceRef: r.source_ref,
      similarity: parseFloat(r.similarity.toFixed(4)),
    }));
  }

  return { embedText, embedBatch, similaritySearch };
}
