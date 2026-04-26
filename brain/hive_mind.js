import { chatWithTools } from '../llm.js';
import { query } from '../edge/db-pg.js';
import { randomUUID } from 'node:crypto';

/**
 * Hive Mind — VRAM Memory Workspace Manager
 * 
 * Target: kruschdev_worker (GTX 970 / Port 11436)
 * Model: qwen2.5-coder:1.5b (Fast, high-context)
 * 
 * Purpose: Maintains a persistent, sliding-window conversational context 
 * completely isolated inside the GPU KV-Cache. Bypasses SQLite/Postgres for "warm" semantic retrieval.
 * 
 * v2: Token-aware eviction policy with Postgres archival.
 */

/** Rough token estimator — 1 token ≈ 4 chars for English/code mix */
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

class HiveMind {
  constructor() {
    this.messages = [
      { 
        role: 'system', 
        content: `You are the Swarm Hive Mind (VRAM State Cache).
1. Listen to the execution loop and record state transitions silently.
2. NEVER converse. NEVER offer advice.
3. Output ONLY a hyper-condensed memory blob consisting of bulleted facts.
When you receive an [UPDATE], reply with "ACKNOWLEDGED."
When you receive a [QUERY], retrieve the necessary context from your memory and answer intelligently, concisely, and accurately.`
      }
    ];
    this.apiUrl = 'http://10.0.0.85:11434/v1/chat/completions'; // kruschserv GTX 970 endpoint
    this.model = 'qwen2.5-coder:1.5b'; // Use the 1.5b base model natively pulled on kruschserv


    // Eviction policy configuration
    this.maxContextTokens = 8192;           // Capped to strictly fit inside 4GB GTX 970 VRAM
    this.evictionThreshold = 0.80;          // Trigger compression at 80% capacity
    this.maxMessages = 30;                  // Hard cap on message array length
    this.minRetainedMessages = 6;           // Always keep at least this many recent messages
    this.compressBatchSize = 10;            // Number of oldest messages to compress per squeeze
  }

  get config() {
    return {
      provider: 'ollama',
      apiUrl: this.apiUrl,
      model: this.model,
      temperature: 0.1,
      options: {
        num_ctx: this.maxContextTokens,
        keep_alive: -1  // Permanent VRAM residency
      }
    };
  }
  get geminiFallbackConfig() {
    return {
      provider: 'gemini',
      model: 'gemini-2.5-flash-lite',
      temperature: 0.1,
      maxTokens: this.maxContextTokens
    };
  }

  /** Estimate total tokens across all messages */
  get totalTokens() {
    return this.messages.reduce((sum, msg) => sum + estimateTokens(msg.content || ''), 0);
  }

  /** Current utilization as a percentage (0-1) */
  get utilization() {
    return this.totalTokens / this.maxContextTokens;
  }

  /**
   * Pushes a new memory into the VRAM cache asynchronously.
   */
  async addContext(eventSource, content) {
    const memoryPacket = `[UPDATE] Source: ${eventSource}\nContent: ${content}`;
    this.messages.push({ role: 'user', content: memoryPacket });

    try {
      console.log(`[Hive Mind] Caching memory from ${eventSource}... (${this.messages.length} msgs, ${Math.round(this.utilization * 100)}% ctx)`);
      
      let response;
      try {
        response = await chatWithTools(this.config, this.messages);
      } catch (ollamaErr) {
        console.warn(`[Hive Mind] Ollama failed (${ollamaErr.message}), falling back to Gemini 2.5 Flashlite...`);
        response = await chatWithTools(this.geminiFallbackConfig, this.messages);
      }
      
      this.messages.push({ role: 'assistant', content: response.content || 'ACKNOWLEDGED' });
      
      await this._enforceEvictionPolicy();
    } catch (e) {
        console.error(`[Hive Mind] Failed to cache memory:`, e.message);
        // Remove the failed push so it doesn't pollute the context array
        this.messages.pop(); 
    }
  }

  /**
   * Queries the VRAM KV-cache for instant semantic retrieval.
   */
  async queryContext(question, contextHints = "") {
    const queryPacket = `[QUERY] ${question}\n${contextHints ? 'Hints: ' + contextHints : ''}`;
    
    // We append the query without modifying the long-term message array permanently (ephemeral query)
    const queryMessages = [...this.messages, { role: 'user', content: queryPacket }];

    try {
      let response;
      try {
        response = await chatWithTools(this.config, queryMessages);
      } catch (ollamaErr) {
        console.warn(`[Hive Mind Query] Ollama failed (${ollamaErr.message}), falling back to Gemini...`);
        response = await chatWithTools(this.geminiFallbackConfig, queryMessages);
      }
      return response.content || "No relevant context found in Hive Mind.";
    } catch (e) {
      console.error(`[Hive Mind Query] Failed:`, e.message);
      return "Hive Mind offline or inaccessible.";
    }
  }

  /**
   * Token-aware eviction policy with Postgres archival.
   * 
   * Trigger conditions (any of):
   *   1. Token utilization > 80% of context window
   *   2. Message count exceeds hard cap
   * 
   * Strategy:
   *   1. Archive evicted messages to Postgres (non-blocking)
   *   2. Compress oldest batch into a dense summary
   *   3. Replace batch with summary message pair
   */
  async _enforceEvictionPolicy() {
    const shouldEvict = (
      this.utilization > this.evictionThreshold ||
      this.messages.length > this.maxMessages
    );

    if (!shouldEvict) return;

    const reason = this.utilization > this.evictionThreshold
      ? `token utilization ${Math.round(this.utilization * 100)}% > ${Math.round(this.evictionThreshold * 100)}% threshold`
      : `message count ${this.messages.length} > ${this.maxMessages} cap`;

    console.log(`[Hive Mind] Eviction triggered: ${reason}`);

    // Determine how many messages to compress (keep system prompt + recent)
    let availableForCompression = this.messages.length - 1 - this.minRetainedMessages;
    
    // OVERRIDE: If we are breaching critical token limits within just a few giant messages,
    // abandon the minimum message retention lock to protect the GPU from an OOM crash.
    if (availableForCompression <= 0 && this.utilization > this.evictionThreshold) {
        // Leave the System Prompt (idx 0) and the very latest message (messages.length - 1)
        availableForCompression = this.messages.length - 2;
    }

    if (availableForCompression <= 0) {
      console.warn(`[Hive Mind] Cannot compress — only ${this.messages.length} messages, need ${this.minRetainedMessages + 1} minimum (or VRAM threshold breach).`);
      return;
    }

    const batchSize = Math.min(this.compressBatchSize, availableForCompression);
    const messagesToCompress = this.messages.slice(1, 1 + batchSize);

    // Step 1: Archive to Postgres (non-blocking, best-effort)
    this._archiveToPostgres(messagesToCompress).catch(e => 
      console.warn(`[Hive Mind] Postgres archival failed:`, e.message)
    );

    // Step 2: Compress via the 1.5b model
    const compressPrompt = [
      {
        role: 'system',
        content: 'You are an objective memory compressor for the Swarm Hivemind tape. You write highly dense factual summaries. You NEVER converse.'
      },
      ...messagesToCompress, 
      {
        role: 'user',
        content: `[QUERY] Summarize the key facts, decisions, and outcomes into 3-5 concise bullet points. 
- Log system state changes and file creations.
- Keep ONLY specific, critical error codes or fatal exceptions. Drop verbose stack traces.
- Omit conversational filler. Do NOT add trailing context.`
      }
    ];

    try {
      let response;
      try {
        response = await chatWithTools(this.config, compressPrompt);
      } catch (ollamaErr) {
        console.warn(`[Hive Mind Compress] Ollama failed (${ollamaErr.message}), falling back to Gemini...`);
        response = await chatWithTools(this.geminiFallbackConfig, compressPrompt);
      }
      const compressed = response.content;
      
      // Step 3: Replace batch with compressed summary
      this.messages.splice(1, batchSize, 
        { role: 'user', content: `[UPDATE] Source: Memory Squeeze (${batchSize} entries compressed)\nContent: ${compressed}` },
        { role: 'assistant', content: 'ACKNOWLEDGED' }
      );

      const newUtil = Math.round(this.utilization * 100);
      console.log(`[Hive Mind] Eviction complete: ${batchSize} messages → 1 summary. Now at ${newUtil}% utilization, ${this.messages.length} messages.`);
    } catch (e) {
      console.warn(`[Hive Mind] Compression failed, force-dropping oldest ${batchSize} messages.`);
      this.messages.splice(1, batchSize);
    }
  }

  /**
   * Archives evicted messages to Postgres for long-term retrieval.
   * Uses the execution_logs table for consistency with the rest of the swarm.
   */
  async _archiveToPostgres(messages) {
    const archiveContent = messages
      .filter(m => m.role === 'user')
      .map(m => m.content)
      .join('\n---\n');

    if (!archiveContent.trim()) return;

    try {
      await query(
        'INSERT INTO execution_logs (session_id, persona_name, action, result, execution_time_ms) VALUES ($1, $2, $3, $4, $5)',
        [randomUUID(), 'hive_mind', 'Context Eviction', archiveContent.slice(0, 10000), 0]
      );
      console.log(`[Hive Mind] Archived ${messages.length} evicted messages to Postgres.`);
    } catch (e) {
      // Non-critical — log and continue
      console.warn(`[Hive Mind Archive] Postgres write failed: ${e.message}`);
    }
  }

  /** Returns diagnostic info for debugging/monitoring */
  getStats() {
    return {
      messageCount: this.messages.length,
      estimatedTokens: this.totalTokens,
      utilization: `${Math.round(this.utilization * 100)}%`,
      maxTokens: this.maxContextTokens,
      evictionThreshold: `${Math.round(this.evictionThreshold * 100)}%`
    };
  }
}

// Singleton export
export const hiveMind = new HiveMind();
