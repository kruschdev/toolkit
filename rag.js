/**
 * @module lib/rag
 * Shared RAG (Retrieval-Augmented Generation) chat factory for all BuildOS trades.
 *
 * Usage:
 *   import { createRag } from '../../lib/rag.js';
 *   const rag = createRag(config, 'brushwise', buildSystemPrompt, embeddings, db);
 *   const { answer, sources } = await rag.queryWithContext(question, sessionId, jobContext);
 */
import { chat } from '@krusch/toolkit/llm';
import { streamChat } from '@krusch/toolkit/streaming';

/**
 * Create a RAG module bound to a specific trade.
 *
 * @param {object} config - Project config (ai settings)
 * @param {string} tradeName - Trade identifier (e.g. 'spark', 'brushwise')
 * @param {function} buildSystemPrompt - Trade-specific function: (chunks, jobContext?) => systemPromptString
 * @param {{ similaritySearch: Function }} embeddings - Embeddings module (from createEmbeddings)
 * @param {{ query: Function, run: Function }} db - Database query functions
 * @returns {object} RAG module with queryWithContext, streamQueryWithContext, saveMessage, createSession, getSessionMessages, listSessions, deleteSession
 */
export function createRag(config, tradeName, buildSystemPrompt, embeddings, db) {
  /** LLM config for RAG chat */
  const llmConfig = {
    provider: config.ai.provider,
    apiKey: config.ai.apiKey,
    model: config.ai.fastModel || config.ai.model,
    temperature: 0.4,
    maxTokens: 2000,
  };

  /** Human-readable trade label for conversation context */
  const tradeLabel = tradeName.charAt(0).toUpperCase() + tradeName.slice(1);

  /**
   * Process a user query with RAG: retrieve context, build prompt, chat with LLM.
   * @param {string} question
   * @param {number} [sessionId]
   * @param {object} [jobContext=null]
   * @returns {Promise<{answer: string, sources: Array}>}
   */
  async function queryWithContext(question, sessionId, jobContext = null) {
    // 1. Retrieve relevant chunks via semantic search
    console.log(`🔍 [${tradeName}] Searching knowledge base for: "${question.substring(0, 60)}..."`);
    const chunks = await embeddings.similaritySearch(question);
    console.log(`  📚 Found ${chunks.length} relevant chunks`);

    // 2. Build conversation context from previous messages
    let conversationContext = '';
    if (sessionId) {
      const recentMessages = await db.query(
        `SELECT role, content FROM messages
         WHERE session_id = $1
         ORDER BY created_at DESC
         LIMIT 6`,
        [sessionId]
      );

      if (recentMessages.length > 0) {
        const truncLen = config.ai.contextTruncateLength || 500;
        conversationContext = '\n\n## Recent Conversation\n' +
          recentMessages.reverse().map((m) =>
            `${m.role === 'user' ? 'User' : tradeLabel}: ${m.content.substring(0, truncLen)}`
          ).join('\n');
      }
    }

    // 3. Build system prompt with context and job personalization
    const systemPrompt = await buildSystemPrompt(chunks, jobContext);
    const userMessage = conversationContext
      ? `${conversationContext}\n\nNew question: ${question}`
      : question;

    // 4. Call LLM
    console.log(`🧠 [${tradeName}] Querying ${config.ai.provider}/${llmConfig.model}...`);
    if (jobContext) console.log(`  📋 Job context active (${Object.keys(jobContext).length} fields)`);
    const answer = await chat(systemPrompt, userMessage, llmConfig);

    // 5. Format sources
    const sources = chunks.map((c) => ({
      id: c.id,
      documentTitle: c.documentTitle,
      sourceType: c.sourceType,
      sourceRef: c.sourceRef,
      similarity: c.similarity,
      excerpt: c.content.substring(0, 200) + (c.content.length > 200 ? '...' : ''),
    }));

    return { answer, sources };
  }

  /**
   * Streaming version of queryWithContext — retrieves context, then streams LLM tokens.
   * @param {string} question
   * @param {number} [sessionId]
   * @param {function} onChunk - Callback for each text chunk
   * @param {object} [jobContext=null]
   * @returns {Promise<{answer: string, sources: Array}>}
   */
  async function streamQueryWithContext(question, sessionId, onChunk, jobContext = null) {
    // 1. Retrieve relevant chunks
    console.log(`🔍 [${tradeName}] Searching knowledge base for: "${question.substring(0, 60)}..."`);
    const chunks = await embeddings.similaritySearch(question);
    console.log(`  📚 Found ${chunks.length} relevant chunks`);

    // 2. Build conversation context from previous messages
    let conversationContext = '';
    if (sessionId) {
      const recentMessages = await db.query(
        `SELECT role, content FROM messages
         WHERE session_id = $1
         ORDER BY created_at DESC
         LIMIT 6`,
        [sessionId]
      );

      if (recentMessages.length > 0) {
        const truncLen = config.ai.contextTruncateLength || 500;
        conversationContext = '\n\n## Recent Conversation\n' +
          recentMessages.reverse().map((m) =>
            `${m.role === 'user' ? 'User' : tradeLabel}: ${m.content.substring(0, truncLen)}`
          ).join('\n');
      }
    }

    // 3. Build system prompt with context and job personalization
    const systemPrompt = await buildSystemPrompt(chunks, jobContext);
    const userMessage = conversationContext
      ? `${conversationContext}\n\nNew question: ${question}`
      : question;

    // 4. Format sources (returned immediately so frontend can display while streaming)
    const sources = chunks.map((c) => ({
      id: c.id,
      documentTitle: c.documentTitle,
      sourceType: c.sourceType,
      sourceRef: c.sourceRef,
      similarity: c.similarity,
      excerpt: c.content.substring(0, 200) + (c.content.length > 200 ? '...' : ''),
    }));

    // 5. Stream LLM response
    console.log(`🧠 [${tradeName}] Streaming ${config.ai.provider}/${llmConfig.model}...`);
    if (jobContext) console.log(`  📋 Job context active (${Object.keys(jobContext).length} fields)`);
    const answer = await streamChat(systemPrompt, userMessage, llmConfig, onChunk);

    return { answer, sources };
  }

  /**
   * Save a message to a session.
   * @param {number} sessionId
   * @param {string} role
   * @param {string} content
   * @param {Array} [sources=[]]
   * @returns {Promise<{id: number}>}
   */
  async function saveMessage(sessionId, role, content, sources = []) {
    const result = await db.query(
      `INSERT INTO messages (session_id, role, content, sources)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [sessionId, role, content, JSON.stringify(sources)]
    );
    await db.run('UPDATE sessions SET updated_at = NOW() WHERE id = $1', [sessionId]);
    return result[0];
  }

  /**
   * Create a new chat session.
   * @param {string} [title='New Conversation']
   * @returns {Promise<{id: number, title: string}>}
   */
  async function createSession(title = 'New Conversation') {
    const result = await db.query(
      'INSERT INTO sessions (title) VALUES ($1) RETURNING id, title, created_at',
      [title]
    );
    return result[0];
  }

  /**
   * Get all messages in a session.
   * @param {number} sessionId
   * @returns {Promise<Array>}
   */
  async function getSessionMessages(sessionId) {
    return db.query(
      `SELECT id, role, content, sources, created_at
       FROM messages WHERE session_id = $1
       ORDER BY created_at ASC`,
      [sessionId]
    );
  }

  /**
   * List all sessions.
   * @returns {Promise<Array>}
   */
  async function listSessions() {
    return db.query(
      `SELECT s.id, s.title, s.created_at, s.updated_at,
         COUNT(m.id) AS message_count
       FROM sessions s
       LEFT JOIN messages m ON m.session_id = s.id
       GROUP BY s.id
       ORDER BY s.updated_at DESC`
    );
  }

  /**
   * Delete a session and all its messages.
   * @param {number} sessionId
   * @returns {Promise<boolean>}
   */
  async function deleteSession(sessionId) {
    const { rowCount } = await db.run('DELETE FROM sessions WHERE id = $1', [sessionId]);
    return rowCount > 0;
  }

  return { queryWithContext, streamQueryWithContext, saveMessage, createSession, getSessionMessages, listSessions, deleteSession };
}
