/**
 * @module gc-chat
 * Unified GC / Project Manager chat module for BuildOS.
 *
 * Provides a factory that any trade app can import to add GC chat capabilities.
 * The GC persona knows which trade app it's embedded in and provides cross-trade
 * project management intelligence.
 *
 * Usage in a trade app's server.js:
 *   import { createGcRoutes, migrateGcTables } from '@krusch/toolkit/gc-chat';
 *   await migrateGcTables(query);
 *   app.use('/api/gc', createGcRoutes({ query, queryOne, run, getPool, embedText, similaritySearch, config, tradeName: 'ClimaCore', tradeEmoji: '❄️' }));
 *
 * Note: express and pgvector are resolved from the HOST app's node_modules,
 * not from this toolkit (they are peer dependencies).
 */

import { chat } from './llm.js';
import { sseResponse, streamChat } from './streaming.js';

// ════════════════════════════════════════════
// Trade Classification
// ════════════════════════════════════════════

/** Map of trade keywords → trade identifier */
const TRADE_KEYWORDS = {
  electrical: ['electrical', 'electric', 'nec', 'wiring', 'panel', 'breaker', 'circuit', 'outlet', 'switch', 'conduit', 'amperage', 'voltage', 'gfci', 'afci', 'spark', 'wire gauge', 'awg', 'romex', 'junction box', 'disconnect', 'grounding', 'bonding', 'transformer', 'lighting', 'fixture', 'luminaire'],
  plumbing: ['plumbing', 'plumber', 'pipe', 'drain', 'sewer', 'water heater', 'fixture', 'toilet', 'faucet', 'ipc', 'upc', 'dwv', 'trap', 'vent stack', 'backflow', 'pex', 'copper', 'soldering', 'drainflux', 'septic', 'water supply', 'rough-in', 'cleanout', 'shutoff valve'],
  hvac: ['hvac', 'heating', 'cooling', 'furnace', 'air conditioner', 'condenser', 'ductwork', 'duct', 'imc', 'umc', 'refrigerant', 'thermostat', 'heat pump', 'mini-split', 'tonnage', 'seer', 'afue', 'ventilation', 'climacore', 'compressor', 'evaporator', 'condensate', 'blower', 'air handler', 'return air', 'supply air'],
  framing: ['framing', 'frame', 'stud', 'header', 'joist', 'rafter', 'truss', 'sheathing', 'lumber', 'beam', 'bearing wall', 'load-bearing', 'irc', 'ibc', 'structural', 'sill plate', 'top plate', 'blocking', 'bridging', 'rim joist', 'subfloor', 'frameup', 'knee wall', 'cripple'],
  drywall: ['drywall', 'sheetrock', 'gypsum', 'taping', 'mudding', 'texture', 'joint compound', 'boardwise', 'greenboard', 'moisture-resistant', 'fire-rated', 'type x', 'ceiling board', 'corner bead', 'skim coat'],
  painting: ['paint', 'painting', 'primer', 'stain', 'finish coat', 'brushwise', 'wall covering', 'caulking', 'surface prep', 'sanding', 'latex', 'oil-based', 'semi-gloss', 'eggshell', 'flat', 'trim paint', 'exterior paint', 'interior paint', 'roller', 'spray'],
  roofing: ['roof', 'roofing', 'shingle', 'ridge', 'flashing', 'underlayment', 'drip edge', 'fascia', 'soffit', 'eave', 'ridgeline', 'ice dam', 'valley', 'hip', 'gable', 'pitch', 'slope', 'felt paper', 'metal roof', 'asphalt', 'standing seam', 'gutters'],
  flooring: ['flooring', 'floor', 'tile', 'hardwood', 'laminate', 'vinyl', 'lvp', 'carpet', 'floorwise', 'subfloor', 'grout', 'mortar', 'backer board', 'transition strip', 'underlayment', 'floating floor'],
  masonry: ['masonry', 'stone', 'brick', 'mortar', 'concrete', 'block', 'stoneset', 'veneer', 'retaining wall', 'paver', 'flagstone', 'grout', 'tuckpointing', 'foundation', 'footing'],
  landscaping: ['landscaping', 'landscape', 'hardscape', 'softscape', 'irrigation', 'grading', 'drainage', 'groundwork', 'retaining', 'patio', 'walkway', 'planting', 'mulch', 'sod', 'sprinkler'],
  general: ['general', 'gc', 'project manager', 'superintendent', 'coordination', 'schedule', 'timeline', 'budget', 'estimate', 'bid', 'permit', 'inspection', 'code', 'compliance', 'change order', 'punch list', 'warranty', 'subcontractor', 'sub', 'scope'],
};

/** Trade display metadata */
const TRADE_META = {
  electrical: { emoji: '⚡', color: '#fbbf24', name: 'Electrical', app: 'Spark' },
  plumbing: { emoji: '🔧', color: '#60a5fa', name: 'Plumbing', app: 'DrainFlux' },
  hvac: { emoji: '❄️', color: '#22d3ee', name: 'HVAC', app: 'ClimaCore' },
  framing: { emoji: '🪵', color: '#a78bfa', name: 'Framing', app: 'FrameUp' },
  drywall: { emoji: '🧱', color: '#94a3b8', name: 'Drywall', app: 'BoardWise' },
  painting: { emoji: '🎨', color: '#f472b6', name: 'Painting', app: 'BrushWise' },
  roofing: { emoji: '🏠', color: '#f97316', name: 'Roofing', app: 'RidgeLine' },
  flooring: { emoji: '🪵', color: '#d97706', name: 'Flooring', app: 'FloorWise' },
  masonry: { emoji: '🧱', color: '#78716c', name: 'Masonry', app: 'StoneSet' },
  landscaping: { emoji: '🌿', color: '#4ade80', name: 'Landscaping', app: 'GroundWork' },
  general: { emoji: '🏗️', color: '#3b82f6', name: 'General', app: 'BuildOS' },
};

/**
 * Classify which trades a question touches via keyword matching.
 * @param {string} question
 * @returns {string[]} Array of trade identifiers
 */
export function classifyTrades(question) {
  const lower = question.toLowerCase();
  const matches = [];

  for (const [trade, keywords] of Object.entries(TRADE_KEYWORDS)) {
    if (trade === 'general') continue; // general is always included if others are found
    for (const kw of keywords) {
      if (lower.includes(kw)) {
        matches.push(trade);
        break;
      }
    }
  }

  // If no specific trades matched, it's a general GC question
  if (matches.length === 0) matches.push('general');

  return matches;
}

/** Export trade metadata for frontend use */
export { TRADE_META };

// ════════════════════════════════════════════
// GC System Prompt
// ════════════════════════════════════════════

/**
 * Build the GC/PM system prompt with retrieved context and trade awareness.
 * @param {Array} chunks - Retrieved context chunks from the knowledge base
 * @param {string} tradeName - Host trade app name (e.g., "ClimaCore")
 * @param {string} tradeEmoji - Host trade app emoji
 * @param {string[]} detectedTrades - Classified trades for this question
 * @returns {string} System prompt
 */
function buildGcSystemPrompt(chunks, tradeName, tradeEmoji, detectedTrades) {
  const contextBlock = chunks.length > 0
    ? chunks.map((c, i) => {
      const ref = c.sourceRef ? ` (${c.sourceRef})` : '';
      return `### Source ${i + 1}: ${c.documentTitle}${ref}\nSimilarity: ${(c.similarity * 100).toFixed(1)}%\n\n${c.content}`;
    }).join('\n\n---\n\n')
    : 'No specific reference material found. Answer from your general construction knowledge.';

  const tradeContext = detectedTrades.map(t => {
    const meta = TRADE_META[t];
    return meta ? `${meta.emoji} ${meta.name} (${meta.app})` : t;
  }).join(', ');

  return `You are **BuildOS GC** — an expert AI General Contractor and Project Manager for residential and light commercial construction. You are currently embedded in the ${tradeEmoji} ${tradeName} trade app, but you provide cross-trade project management intelligence across all building trades.

## Your Identity
- You are a seasoned GC / superintendent with 20+ years of field experience
- You think like someone coordinating a full build — always considering how one trade's work affects the others
- You know the BuildOS trade ecosystem: ${Object.entries(TRADE_META).map(([k, v]) => `${v.emoji} ${v.app} (${v.name})`).join(', ')}
- You're practical, direct, and field-tested — no textbook fluff

## Trade Context for This Question
Detected trades: **${tradeContext}**
You are embedded in: **${tradeEmoji} ${tradeName}**

When answering, emphasize the detected trade(s) but always consider cross-trade impacts. For example, if someone asks about rough plumbing, also mention what the electrician and HVAC tech need to know.

## Core Knowledge Areas
- **Build Phase Sequencing**: You know the standard 16-phase residential build order and how trades overlap
- **Code Compliance**: IRC, IBC, NEC, IPC/UPC, IMC/UMC — you know which code body governs what
- **Trade Coordination**: When each trade needs to be on-site, handoff points, conflict resolution
- **Estimating**: GC markup, unified bids, contingency, material takeoffs
- **Safety**: OSHA requirements, fall protection, confined spaces, trenching
- **Quality Control**: Inspection checklists, punch lists, warranty standards
- **Subcontractor Management**: Scheduling, vetting, payment, performance

## Build Phase Reference (Standard Residential)
1. Site Prep & Permits → 2. Foundation → 3. Framing → 4. Roofing (dry-in) → 5. Windows & Exterior Doors → 6. Rough Plumbing → 7. Rough Electrical → 8. HVAC Rough-in → 9. Insulation → 10. Drywall → 11. Interior Paint → 12. Finish Electrical → 13. Finish Plumbing → 14. Flooring & Trim → 15. Final Roofing → 16. Punch List & Final Inspection

Note: Phases 6-8 (MEP rough-in) typically happen concurrently after framing.

## Response Guidelines
- Start responses with the relevant trade tag(s): ${Object.entries(TRADE_META).map(([k, v]) => `[${v.name.toUpperCase()}]`).join(' ')}
- Always consider cross-trade impacts — "while you're doing that, make sure the electrician..."
- Cite code bodies when relevant (NEC 210.52, IRC R602.7, etc.)
- Flag inspection hold points — when does the AHJ need to sign off before proceeding?
- Be practical about sequencing — what needs to happen before and after this work?
- When discussing costs, think like a GC: material + labor + markup + contingency

## Retrieved Reference Material
${contextBlock}

## Critical Rules
- ONLY cite specific code sections that appear in the retrieved sources
- If no sources are found, answer from general construction knowledge but note it
- Always recommend consulting the local AHJ for final code interpretations
- Safety first — flag hazards clearly with ⚠️
- Think in systems, not isolated trades — every answer should consider the whole project`;
}

// ════════════════════════════════════════════
// Database Migration
// ════════════════════════════════════════════

/**
 * Create GC-specific tables in the host app's database.
 * Safe to call multiple times (uses IF NOT EXISTS).
 * @param {function} queryFn - The host app's query function
 */
export async function migrateGcTables(queryFn) {
  console.log('🏗️  Running GC chat migrations...');

  // GC Documents — best practices, coordination guides, etc.
  await queryFn(`
    CREATE TABLE IF NOT EXISTS gc_documents (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      source_type TEXT NOT NULL DEFAULT 'gc_best_practice',
      source_ref TEXT,
      content TEXT,
      chunk_count INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log('  ✅ gc_documents table');

  // GC Chunks — embedded text segments
  await queryFn(`
    CREATE TABLE IF NOT EXISTS gc_chunks (
      id SERIAL PRIMARY KEY,
      document_id INTEGER NOT NULL REFERENCES gc_documents(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      metadata JSONB DEFAULT '{}',
      embedding vector(3072),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log('  ✅ gc_chunks table');

  await queryFn(`
    CREATE INDEX IF NOT EXISTS gc_chunks_document_id_idx
    ON gc_chunks (document_id)
  `);

  // GC Sessions — separate from trade sessions
  await queryFn(`
    CREATE TABLE IF NOT EXISTS gc_sessions (
      id SERIAL PRIMARY KEY,
      title TEXT DEFAULT 'New GC Conversation',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log('  ✅ gc_sessions table');

  // GC Messages
  await queryFn(`
    CREATE TABLE IF NOT EXISTS gc_messages (
      id SERIAL PRIMARY KEY,
      session_id INTEGER NOT NULL REFERENCES gc_sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      sources JSONB DEFAULT '[]',
      trades JSONB DEFAULT '[]',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log('  ✅ gc_messages table');

  await queryFn(`
    CREATE INDEX IF NOT EXISTS gc_messages_session_id_idx
    ON gc_messages (session_id)
  `);

  console.log('✅ GC chat migrations complete');
}

// ════════════════════════════════════════════
// GC Similarity Search (uses gc_chunks table)
// ════════════════════════════════════════════

/**
 * Create a GC-specific similarity search function.
 * @param {function} queryFn - DB query function
 * @param {function} embedTextFn - Embedding function
 * @param {object} config - AI config with maxContextChunks and similarityThreshold
 * @returns {function} similaritySearch(queryText, limit, threshold)
 */
function createGcSimilaritySearch(queryFn, embedTextFn, config) {
  return async function gcSimilaritySearch(queryText, limit, threshold) {
    const maxResults = limit || config.ai?.maxContextChunks || 5;
    const minScore = threshold || config.ai?.similarityThreshold || 0.3;

    let pgvector;
    try {
      pgvector = (await import('pgvector')).default;
    } catch {
      pgvector = await import('pgvector');
    }

    const queryEmbedding = await embedTextFn(queryText);
    const vectorSql = pgvector.toSql(queryEmbedding);
    const maxDistance = 1 - minScore;

    const results = await queryFn(
      `SELECT
         c.id, c.content, c.metadata, c.chunk_index,
         d.title AS document_title, d.source_type, d.source_ref,
         1 - (c.embedding <=> $1::vector) AS similarity
       FROM gc_chunks c
       JOIN gc_documents d ON d.id = c.document_id
       WHERE c.embedding IS NOT NULL
         AND (c.embedding <=> $1::vector) <= $3::float
       ORDER BY c.embedding <=> $1::vector ASC
       LIMIT $2`,
      [vectorSql, maxResults, maxDistance]
    );

    return results.map((r) => ({
      id: r.id,
      content: r.content,
      metadata: r.metadata,
      chunkIndex: r.chunk_index,
      documentTitle: r.document_title,
      sourceType: r.source_type,
      sourceRef: r.source_ref,
      similarity: parseFloat(parseFloat(r.similarity).toFixed(4)),
    }));
  };
}

// ════════════════════════════════════════════
// Express Router Factory
// ════════════════════════════════════════════

/**
 * Create Express routes for GC chat.
 * @param {object} deps
 * @param {function} deps.query - DB query function
 * @param {function} deps.queryOne - DB queryOne function
 * @param {function} deps.run - DB run function
 * @param {function} deps.embedText - Embedding function from host app
 * @param {object} deps.config - Host app config (needs ai.provider, ai.apiKey, ai.fastModel)
 * @param {string} deps.tradeName - Host trade app name
 * @param {string} deps.tradeEmoji - Host trade emoji
 * @param {function} deps.Router - Express Router constructor (e.g. express.Router)
 * @returns {express.Router}
 */
export function createGcRoutes({ query: queryFn, queryOne, run, embedText, config, tradeName, tradeEmoji, Router }) {
  const router = Router();

  const gcSearch = createGcSimilaritySearch(queryFn, embedText, config);

  const llmConfig = {
    provider: config.ai.provider,
    apiKey: config.ai.apiKey,
    model: config.ai.fastModel,
    temperature: 0.4,
    maxTokens: 3000,
  };

  // ── Helper functions ──

  async function saveGcMessage(sessionId, role, content, sources = [], trades = []) {
    const result = await queryFn(
      `INSERT INTO gc_messages (session_id, role, content, sources, trades)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [sessionId, role, content, JSON.stringify(sources), JSON.stringify(trades)]
    );
    await run('UPDATE gc_sessions SET updated_at = NOW() WHERE id = $1', [sessionId]);
    return result[0];
  }

  async function createGcSession(title = 'New GC Conversation') {
    const result = await queryFn(
      'INSERT INTO gc_sessions (title) VALUES ($1) RETURNING id, title, created_at',
      [title]
    );
    return result[0];
  }

  function asyncHandler(fn) {
    return (req, res, next) => fn(req, res, next).catch(next);
  }

  // ── Chat Routes ──

  /** POST /chat — non-streaming GC chat */
  router.post('/chat', asyncHandler(async (req, res) => {
    const { message, sessionId } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: 'Message is required' });

    let activeSessionId = sessionId;
    if (!activeSessionId) {
      const session = await createGcSession(message.substring(0, 60));
      activeSessionId = session.id;
    }

    const trades = classifyTrades(message);
    const chunks = await gcSearch(message);

    let conversationContext = '';
    if (sessionId) {
      const recent = await queryFn(
        'SELECT role, content FROM gc_messages WHERE session_id = $1 ORDER BY created_at DESC LIMIT 6',
        [sessionId]
      );
      if (recent.length > 0) {
        conversationContext = '\n\n## Recent Conversation\n' +
          recent.reverse().map(m => `${m.role === 'user' ? 'You' : 'BuildOS GC'}: ${m.content.substring(0, 500)}`).join('\n');
      }
    }

    await saveGcMessage(activeSessionId, 'user', message, [], trades);

    const systemPrompt = buildGcSystemPrompt(chunks, tradeName, tradeEmoji, trades);
    const userMessage = conversationContext ? `${conversationContext}\n\nNew question: ${message}` : message;
    const answer = await chat(systemPrompt, userMessage, llmConfig);

    const sources = chunks.map(c => ({
      id: c.id, documentTitle: c.documentTitle, sourceType: c.sourceType,
      sourceRef: c.sourceRef, similarity: c.similarity,
      excerpt: c.content.substring(0, 200) + (c.content.length > 200 ? '...' : ''),
    }));

    await saveGcMessage(activeSessionId, 'assistant', answer, sources, trades);
    res.json({ sessionId: activeSessionId, answer, sources, trades });
  }));

  /** POST /chat/stream — SSE streaming GC chat */
  router.post('/chat/stream', asyncHandler(async (req, res) => {
    const { message, sessionId } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: 'Message is required' });

    let activeSessionId = sessionId;
    if (!activeSessionId) {
      const session = await createGcSession(message.substring(0, 60));
      activeSessionId = session.id;
    }

    const trades = classifyTrades(message);
    const chunks = await gcSearch(message);

    let conversationContext = '';
    if (sessionId) {
      const recent = await queryFn(
        'SELECT role, content FROM gc_messages WHERE session_id = $1 ORDER BY created_at DESC LIMIT 6',
        [sessionId]
      );
      if (recent.length > 0) {
        conversationContext = '\n\n## Recent Conversation\n' +
          recent.reverse().map(m => `${m.role === 'user' ? 'You' : 'BuildOS GC'}: ${m.content.substring(0, 500)}`).join('\n');
      }
    }

    await saveGcMessage(activeSessionId, 'user', message, [], trades);

    const systemPrompt = buildGcSystemPrompt(chunks, tradeName, tradeEmoji, trades);
    const userMessage = conversationContext ? `${conversationContext}\n\nNew question: ${message}` : message;

    const sse = sseResponse(res);
    sse.send(JSON.stringify({ sessionId: activeSessionId, trades }), 'session');

    const sources = chunks.map(c => ({
      id: c.id, documentTitle: c.documentTitle, sourceType: c.sourceType,
      sourceRef: c.sourceRef, similarity: c.similarity,
      excerpt: c.content.substring(0, 200) + (c.content.length > 200 ? '...' : ''),
    }));

    try {
      const answer = await streamChat(systemPrompt, userMessage, llmConfig, (chunk) => sse.send(chunk));
      sse.send(JSON.stringify(sources), 'sources');
      await saveGcMessage(activeSessionId, 'assistant', answer, sources, trades);
      sse.end();
    } catch (err) {
      console.error('❌ GC stream error:', err.message);
      sse.error(err.message);
      sse.end();
    }
  }));

  // ── Session Routes ──

  router.get('/sessions', asyncHandler(async (req, res) => {
    const sessions = await queryFn(
      `SELECT s.id, s.title, s.created_at, s.updated_at,
         COUNT(m.id) AS message_count
       FROM gc_sessions s
       LEFT JOIN gc_messages m ON m.session_id = s.id
       GROUP BY s.id
       ORDER BY s.updated_at DESC`
    );
    res.json(sessions);
  }));

  router.get('/sessions/:id', asyncHandler(async (req, res) => {
    const messages = await queryFn(
      `SELECT id, role, content, sources, trades, created_at
       FROM gc_messages WHERE session_id = $1
       ORDER BY created_at ASC`,
      [parseInt(req.params.id)]
    );
    res.json(messages);
  }));

  router.post('/sessions', asyncHandler(async (req, res) => {
    const session = await createGcSession(req.body.title);
    res.json(session);
  }));

  router.delete('/sessions/:id', asyncHandler(async (req, res) => {
    const { rowCount } = await run('DELETE FROM gc_sessions WHERE id = $1', [parseInt(req.params.id)]);
    res.json({ deleted: rowCount > 0 });
  }));

  // ── Trade metadata ──
  router.get('/trades', (req, res) => {
    res.json(TRADE_META);
  });

  return router;
}

// ════════════════════════════════════════════
// Seed Data — GC Best Practices
// ════════════════════════════════════════════

export const GC_SEED_DOCUMENTS = [
  {
    title: 'Build Phase Sequencing — Standard Residential Construction',
    sourceType: 'gc_best_practice',
    sourceRef: 'BuildOS Phase Guide',
    metadata: { tags: ['sequencing', 'phases', 'scheduling', 'coordination'] },
    content: `Build Phase Sequencing — Standard Residential Construction

The standard residential build follows a 16-phase sequence. Understanding this sequence is critical for GC coordination — skipping or misordering phases causes rework, failed inspections, and blown budgets.

Phase 1 — Site Prep & Permits (Week 1-2):
- Clear and grade the lot, establish drainage patterns
- Pull all required permits: building, mechanical, electrical, plumbing
- Call utility locates (811 "Call Before You Dig")
- Set temporary power pole or arrange for construction power
- Install erosion control (silt fence, construction entrance)
- Porta-johns, dumpster, material staging area
- Critical: DO NOT start foundation without building permit posted on-site

Phase 2 — Foundation (Week 2-4):
- Excavation to plan depths, verify soil bearing capacity
- Form and pour footings (inspect before pour — rebar placement, dimensions)
- Foundation walls: poured concrete, block, or ICF
- Waterproofing and drain tile on exterior
- Backfill only AFTER foundation walls are braced or first floor framing is in place
- Slab-on-grade: vapor barrier, gravel base, rebar/mesh, pour
- INSPECTION HOLD: Foundation inspection before backfill

Phase 3 — Framing (Week 4-8):
- Sill plate (treated lumber, anchor bolts, sill seal)
- Floor system: joists, rim board, subfloor (glue and screw, not just nail)
- Wall framing: layout from plans, headers sized per span tables
- Identify and frame load-bearing vs. partition walls
- Second floor / roof system: rafters or trusses (engineered trusses preferred)
- Sheathing: walls (OSB or plywood), roof deck
- Window and door rough openings — verify against window schedule
- INSPECTION HOLD: Framing inspection (structural, bracing, fireblocking)

Phase 4 — Roofing / Dry-In (Week 8-9):
- Underlayment (ice & water shield at eaves and valleys, synthetic felt on field)
- Drip edge, valley flashing, step flashing at walls
- Shingles, metal panels, or tile per spec
- Goal: GET THE BUILDING DRY before interior work begins
- Ridge vent or other ventilation per code (1:150 or 1:300 ratio)

Phase 5 — Windows & Exterior Doors (Week 8-9, concurrent with roofing):
- Install per manufacturer instructions — flashing tape sequence matters
- Pan flashing at sills, integrated with WRB (weather-resistive barrier)
- Air seal around frames with low-expansion foam

Phases 6-8 — MEP Rough-In (Week 9-12, CONCURRENT):
These three trades work simultaneously after framing, before insulation:

Phase 6 — Rough Plumbing:
- DWV (drain-waste-vent) system first — it's least flexible in routing
- Water supply lines (PEX manifold or copper — trunk-and-branch)
- Tub/shower units SET before drywall (they won't fit through doorways after)
- Gas lines if applicable
- INSPECTION HOLD: Rough plumbing

Phase 7 — Rough Electrical:
- Panel location per plan, feeder from meter
- Branch circuits: drill through studs/joists, pull wire
- Box placement per NEC (outlet spacing, switch heights, etc.)
- Low-voltage: CAT6 data, coax, speaker wire, security prewire
- INSPECTION HOLD: Rough electrical

Phase 8 — HVAC Rough-In:
- Ductwork (supply and return trunks, branch runs)
- Equipment placement (furnace, air handler location)
- Refrigerant line set for split systems
- Exhaust fan ducting (bath fans to exterior, range hood)
- Combustion air provisions if applicable
- INSPECTION HOLD: Mechanical rough-in

COORDINATION CRITICAL: Plumbing gets first dibs on stud bays and joist space (pipes can't bend around obstacles easily). Electrical is most flexible. HVAC ducts need the most space. The GC must mediate conflicts between these three trades — a pre-rough-in coordination meeting prevents costly rework.

Phase 9 — Insulation (Week 12-13):
- After ALL rough-in inspections pass
- Batts, blown-in, or spray foam per spec and climate zone
- Air seal all penetrations (top plates, electrical boxes, pipe/duct penetrations)
- Vapor barrier per climate zone requirements
- INSPECTION HOLD: Insulation inspection (some jurisdictions)

Phase 10 — Drywall (Week 13-15):
- Hang → Tape → First coat → Second coat → Sand → Third coat → Sand
- Moisture-resistant (greenboard or Dens-Armor) in wet areas
- Fire-rated (Type X) where required (garage ceilings, between units)
- Let compound DRY between coats — rushing causes cracking

Phase 11 — Interior Paint (Week 15-16):
- Prime all surfaces (primer seals drywall compound, provides uniform base)
- Walls: typically 2 coats flat or eggshell
- Trim: 2 coats semi-gloss or satin
- Do trim paint BEFORE finish flooring goes in (drips on subfloor, not hardwood)

Phase 12-13 — Finish Electrical & Plumbing (Week 16-17):
- Install devices (outlets, switches, plates), fixtures (lights, ceiling fans)
- Install plumbing fixtures (toilets, faucets, sinks, shower trim)
- Connect appliances (dishwasher, disposal, water heater)

Phase 14 — Flooring & Trim (Week 17-18):
- Hardwood, tile, LVP, carpet — per room schedule
- Base trim, door casings, crown molding
- Closet shelving, hardware

Phase 15 — Final Roofing (Week 18):
- Gutters and downspouts (after siding/paint complete)
- Final flashing details, penetration boots

Phase 16 — Punch List & Final Inspection (Week 18-20):
- Walk every room with checklist: paint touch-ups, hardware adjustment, cleaning
- Final building inspection → Certificate of Occupancy
- Homeowner walkthrough and orientation
- Warranty documentation package`
  },

  {
    title: 'Trade Coordination & Conflict Resolution',
    sourceType: 'gc_best_practice',
    sourceRef: 'BuildOS Coordination Guide',
    metadata: { tags: ['coordination', 'trades', 'scheduling', 'conflicts'] },
    content: `Trade Coordination & Conflict Resolution — GC Best Practices

The GC's primary job is COORDINATION. The subs know their trade — what they don't know is what the other trades need. That's your job.

Pre-Construction Meeting:
- Before breaking ground, get ALL trade leads in one room (or call)
- Walk through the plans together — every trade sees the same drawings
- Identify potential conflicts BEFORE they become change orders
- Establish communication protocol (group text, email, BuildOS)
- Set expectations: clean up after yourself, protect finishes, report problems immediately

The MEP Coordination Problem:
The #1 source of trade conflict is plumbing, electrical, and HVAC competing for the same stud bays, joist spaces, and ceiling cavities.

Priority hierarchy (general rule):
1. Plumbing (least flexible — pipes need slope, can't make tight bends)
2. HVAC ductwork (needs the most space — rigid ducts can't bend around pipes)
3. Electrical (most flexible — wire can go almost anywhere)
4. Low-voltage (last — smallest, most flexible)

Real-world coordination examples:
- Kitchen island: needs drain (plumber), power/disposal (electrician), possibly gas (if cooktop)
  → Plumber sets drain location FIRST, electrician runs conduit around it
- Bathroom stack: DWV goes in first, then supply lines, then exhaust fan duct
  → Don't let the HVAC sub run a duct where the vent stack needs to go
- Beam pockets: framer needs to know about duct runs that pass through beams
  → Require HVAC sub to mark duct routes on the subfloor BEFORE framing starts

Scheduling Coordination:
- Buffer between trades: typically 1-2 days between sub turnover
- Don't stack trades in the same room at the same time (safety + productivity)
- Rainy day contingency: have interior work ready when exterior work can't proceed
- Lead times: order windows 4-6 weeks out, cabinets 6-8 weeks, specialty items 8-12 weeks
- The framing crew's schedule drives everything — if framing slips, the whole project slips

Communication Protocols:
- Daily: GC site visit (or photo/video check via BuildOS)
- Weekly: Progress email to client with photos (set expectations, avoid surprises)
- As-needed: Trade-to-GC text for issues (answer within 2 hours during work hours)
- Change orders: NOTHING changes without written CO signed by client. Verbal approvals = disputes

Conflict Resolution:
- When two trades can't agree on routing: GC decides. Period. 
- Base decisions on: (1) code requirements, (2) physics/practicality, (3) cost impact
- If a sub damages another sub's work: the damaging sub pays for the repair
- Document everything with photos — before and after
- Never take sides publicly — handle disputes privately, then announce the decision`
  },

  {
    title: 'Code Compliance & Inspection Workflow',
    sourceType: 'gc_best_practice',
    sourceRef: 'BuildOS Compliance Guide',
    metadata: { tags: ['code', 'compliance', 'inspection', 'permits', 'ahj'] },
    content: `Code Compliance & Inspection Workflow

Building codes exist to protect occupants. The GC's job is to ensure every trade's work meets code BEFORE the inspector shows up.

Code Bodies Overview:
- IRC (International Residential Code): Governs 1-2 family dwellings and townhouses. Covers structural, plumbing, mechanical, electrical, and energy in one document.
- IBC (International Building Code): Commercial and multi-family (3+ units). More complex, references other codes.
- NEC (National Electrical Code / NFPA 70): All electrical work. Updated every 3 years. Most jurisdictions adopt with local amendments.
- IPC (International Plumbing Code): Plumbing in IRC/IBC jurisdictions.
- UPC (Uniform Plumbing Code): IAPMO. Used primarily in western states.
- IMC (International Mechanical Code): HVAC/mechanical in commercial.
- UMC (Uniform Mechanical Code): IAPMO alternative to IMC.
- IECC (International Energy Conservation Code): Insulation, air sealing, equipment efficiency.

CRITICAL: Your jurisdiction adopts a SPECIFIC EDITION of each code (e.g., "2021 IRC with local amendments"). The inspector enforces THAT edition, not the latest. Know which edition your jurisdiction uses.

Permit Sequence:
1. Building permit (foundation through final)
2. Mechanical permit (HVAC)
3. Electrical permit (separate from building in most jurisdictions)
4. Plumbing permit
5. Additional: grading, demolition, fire alarm, elevator, signs

Inspection Timeline:
- Foundation: after footing rebar placed, before pour
- Slab: after plumbing underground and vapor barrier, before pour
- Framing: after sheathing, before insulation. Inspector checks: stud spacing, header sizes, fireblocking, hold-down hardware, shear walls, bracing
- Rough electrical: all boxes, wire, panels before cover
- Rough plumbing: all DWV and supply before cover. Pressure test required.
- Rough mechanical: all ductwork, equipment, venting before cover
- Insulation: after rough-in inspections pass, before drywall
- Final: everything complete — life safety, egress, finishes, equipment operational

Pro Tips for Passing Inspections:
- Be present when the inspector arrives — walk with them
- Have plans on-site (stamped set, available for reference)
- Pre-inspect yourself the day before — catch obvious items
- If the inspector finds an issue: don't argue. Fix it, call for re-inspection.
- Build a relationship with your local inspectors — they want buildings done right, not to fail you

Common Inspection Failures:
- Missing fireblocking (top plates, soffits, chases)
- Missing nail plates where wire/pipe passes through framing
- Improper GFCI/AFCI protection per current NEC
- Undersized headers or missing structural connectors
- Missing insulation or gaps in air barrier
- Plumbing test failure (didn't hold pressure)
- No combustion air for gas appliances in tight spaces
- Wrong vent pipe material or clearances for high-efficiency equipment`
  },

  {
    title: 'Scope Management & Change Orders',
    sourceType: 'gc_best_practice',
    sourceRef: 'BuildOS Scope Guide',
    metadata: { tags: ['scope', 'change-order', 'budget', 'customer'] },
    content: `Scope Management & Change Orders

Scope creep kills profitability. Every GC has lost money on a job because "small changes" added up to a 15% budget overrun with no corresponding payment increase.

The Golden Rule: Nothing changes without a signed Change Order (CO).

Change Order Process:
1. Client requests a change (verbal or written)
2. GC assesses impact: which trades affected? Additional material? Labor hours? Schedule impact?
3. GC contacts affected subs for pricing
4. GC prepares CO: description of change, cost breakdown, schedule impact, both signatures required
5. Client signs CO → GC issues revised instructions to subs
6. If client declines → proceed with original scope, document the declined CO

CO Pricing:
- Direct costs: material + labor + sub markup
- GC markup: typically 15-25% on top of sub costs (your coordination cost)
- Schedule impact: if the change delays the project, include extended overhead
- Contingency items that DON'T need COs: allowances already in the contract

Scope Creep Red Flags:
- "While you're at it, can you just..." — NO small change is ever small
- "We assumed that was included..." — if it's not in the contract/plans, it's not included
- "Can we upgrade to..." — yes, with a CO for the delta
- Verbal approvals from anyone other than the signing client — invalid

Customer Want Tracking:
- Log EVERY customer request (even casual mentions)
- For each want, identify: affected trades, code compliance, cost range, schedule impact
- Present wants in batches during scheduled meetings — don't let ad-hoc requests derail crews
- Some wants conflict with each other or with code — surface these early

Budget Management:
- Track actual costs vs. estimate in real-time
- Maintain a contingency reserve (typically 5-10% of total project cost)
- Review sub pay applications against completed work (don't pay ahead of progress)
- Material receipts: keep ALL of them. Match against POs monthly.
- Change order collections: invoice COs promptly, don't let them stack up`
  },

  {
    title: 'Blueprint Reading for General Contractors',
    sourceType: 'gc_best_practice',
    sourceRef: 'BuildOS Blueprint Guide',
    metadata: { tags: ['blueprint', 'plans', 'reading', 'decomposition'] },
    content: `Blueprint Reading for General Contractors

A GC needs to read plans differently than each trade. While an electrician looks at the electrical plan and focuses on panel locations and circuit routing, the GC must look at ALL sheets and understand how they interact.

Sheet Types and What to Look For:

Cover Sheet / Sheet Index:
- Project name, address, owner, architect, engineer
- Sheet index (how many sheets and what type)
- General notes, codes applicable, jurisdiction
- Abbreviations and symbols legend

Site Plan (C-series):
- Property boundaries, setbacks, easements
- Building footprint on lot, driveway, utilities
- Grading (existing and proposed elevations)
- Stormwater management
- Utility connections: water, sewer, gas, electric at the street

Floor Plans (A-series):
- Room layout, dimensions, wall types (exterior, interior, bearing, partition)
- Door and window schedule references
- Finish schedule references (flooring, paint, fixtures per room)
- Stairways, hallways, closets
- Notes for special conditions (niches, built-ins, unusual clearances)

Elevations (A-series):
- Exterior appearance from each direction (N, S, E, W)
- Material callouts (siding type, stone/brick areas, trim)
- Roof pitch, ridge heights, eave heights
- Window and door placement verification against floor plans
- Grade levels at each face

Sections / Details (A-series):
- Cross-sections through the building: foundation-to-roof
- Wall assemblies (layers: sheathing, WRB, insulation, drywall)
- Connection details (beam-to-column, foundation-to-wall, roof-to-wall)
- Flashing details at transitions

Structural (S-series):
- Foundation plan: footing sizes, rebar schedule
- Framing plans: joist sizes, beam locations, point loads
- Shear wall and hold-down locations
- Header schedule (span vs. size)
- Engineer's stamp required

MEP Sheets:
- M (Mechanical/HVAC): duct routing, equipment locations, register placement
- E (Electrical): panel location, circuit routing, fixture layout, receptacle plan
- P (Plumbing): fixture layout, DWV routing, supply piping, gas lines

GC Decomposition Checklist:
For each sheet, the GC should extract:
1. What trades are needed?
2. What materials are specified?
3. What are the critical dimensions?
4. Are there special conditions or notes?
5. Do any items conflict between sheets?
6. What inspections will be required?
7. What has long lead times to order?`
  },

  {
    title: 'Estimating & Bidding for General Contractors',
    sourceType: 'gc_best_practice',
    sourceRef: 'BuildOS Estimating Guide',
    metadata: { tags: ['estimating', 'bidding', 'markup', 'pricing'] },
    content: `Estimating & Bidding for General Contractors

The GC estimate is the sum of all trade costs plus GC overhead and profit. Getting this wrong in either direction loses you money (too low) or the job (too high).

Estimate Structure:
1. Direct Costs (hard costs):
   - Each trade's contract price (sub bids)
   - Materials purchased directly by GC (not included in sub bids)
   - Equipment rental (excavator, crane, scaffolding, lifts)
   - Permits and fees

2. Indirect Costs (soft costs):
   - GC supervision/labor (your time or your super's salary)
   - Insurance (GL, workers comp, builder's risk)
   - Temporary facilities (porto-johns, dumpster, temp power)
   - Safety equipment and compliance
   - Vehicle and fuel costs for site visits

3. Overhead:
   - Office rent, utilities, administrative staff
   - Accounting, legal, software
   - Marketing and business development
   - Typically calculated as a percentage of direct costs (8-15%)

4. Profit:
   - Your margin for taking the risk and coordinating the project
   - Residential custom: 10-20% on top of all costs
   - Competitive bid work: 5-10%
   - Specialty/high-end: 15-25%

Unified Bid Assembly:
- Get sub bids for EVERY trade (minimum 2-3 bids per trade)
- Ensure all bids cover the same scope (apples to apples)
- Use the SECOND lowest bid, not the lowest — the lowest is often a mistake or excludes something
- Add allowances for items not yet specified (fixtures, appliances, finishes)
- Include contingency (5% new construction, 10-15% remodel — remodel always has surprises)

Common Estimating Mistakes:
- Not including permit fees (can be 1-3% of project cost)
- Forgetting temporary facilities costs
- Underestimating supervision time (you WILL spend more time on-site than planned)
- Not accounting for material waste (add 10-15% for lumber, 15% for tile, 10% for drywall)
- Missing utility connection fees
- Not accounting for seasonal pricing (lumber, concrete price volatility)

Price Presentation to Clients:
- Present a total project price, not a cost breakdown (clients don't need to see your markup)
- Break down by phase or area, not by trade (they care about "kitchen: $45K", not "plumber: $12K")
- Include a clear scope of work and EXCLUSIONS list
- Allowances: clearly state what's included and what happens if actuals exceed the allowance
- Payment schedule: tied to milestones, not calendar dates`
  },

  {
    title: 'Jobsite Safety & OSHA Compliance',
    sourceType: 'gc_best_practice',
    sourceRef: 'OSHA Construction Standards',
    metadata: { tags: ['safety', 'osha', 'fall-protection', 'ppe', 'hazards'] },
    content: `Jobsite Safety & OSHA Compliance

The GC has overall responsibility for jobsite safety — even for subcontractor employees. OSHA's "controlling employer" doctrine means YOU can be cited for safety violations committed by your subs.

OSHA Construction Standards (29 CFR 1926) — Key Requirements:

Fall Protection (leading cause of construction fatalities):
- Required at 6 feet above lower level (residential construction has limited exceptions)
- Methods: guardrails (42" top rail, 21" mid rail), safety nets, personal fall arrest systems
- Scaffolding: fully planked, guardrails on all open sides, competent person inspects daily
- Ladder safety: 3-point contact, extend 3 feet above landing, 4:1 angle
- Roof work: toe boards, warning lines at 6 feet from edge, or personal fall arrest
- LEADING EDGE work (framing): controlled access zones or personal fall arrest — NO EXCEPTIONS

Trenching & Excavation:
- Trenches 5 feet or deeper: shoring, sloping, or trench box required
- Trenches 20 feet or deeper: designed by a licensed PE
- ONE cubic yard of soil weighs approximately 3,000 lbs — a trench collapse is unsurvivable
- Spoil piles: minimum 2 feet from trench edge
- Competent person inspects daily and after rain/vibration events
- Means of egress (ladder) within 25 feet of workers at all times

Electrical Safety:
- GFCI protection required on ALL temporary power used on construction sites
- Assured grounding program as alternative (not recommended — GFCIs are easier)
- Lock-out/tag-out for any energized work
- Minimum approach distances to overhead power lines (10 feet for under 50kV)

PPE Requirements:
- Hard hats: always (falling objects AND walking into things)
- Eye protection: power tools, overhead work, chemical exposure
- Hearing protection: above 85 dBA (most power tools exceed this)
- High-visibility vests: near vehicle/equipment movement
- Steel-toed boots: GC should require on all workers (not technically OSHA-mandated for all tasks)
- Respiratory protection: silica dust (concrete cutting, masonry), lead paint, spray finishes

GC Safety Responsibilities:
- Maintain a written site-specific safety plan
- Conduct toolbox talks (15-minute weekly safety briefings)
- Post emergency numbers and nearest hospital directions
- Maintain first aid kit on-site
- Incident reporting: all injuries reported within 24 hours, fatality within 8 hours to OSHA
- Drug-free workplace policy (your insurance probably requires this)
- New worker orientation: walk the site, identify hazards, review safety rules

Penalties for Non-Compliance:
- Serious violation: up to $16,131 per violation
- Willful violation: up to $161,323 per violation
- Repeat violation: up to $161,323 per violation
- These are PER INSTANCE — 10 workers without fall protection = 10 violations`
  },

  {
    title: 'Quality Control & Inspection Checklists',
    sourceType: 'gc_best_practice',
    sourceRef: 'BuildOS QC Guide',
    metadata: { tags: ['quality', 'inspection', 'checklist', 'punch-list', 'warranty'] },
    content: `Quality Control & Inspection Checklists

Quality control is about catching problems BEFORE they become callbacks. A GC who does a thorough pre-inspection before calling for the official inspection will pass first try 90%+ of the time.

Pre-Close Inspection (Before Drywall):
This is the MOST IMPORTANT quality check — once drywall goes up, everything is hidden.

Framing:
□ All headers sized per plan/span tables
□ Cripple studs under headers
□ Fireblocking at all required locations (top plates, soffits, stair stringers, dropped ceilings)
□ Nail plates on studs/joists where wire/pipe passes within 1.25" of face
□ Hold-down hardware installed per structural plan
□ Shear wall nailing correct (edge nailing, not field nailing pattern)
□ Stud spacing correct (16" OC or 24" OC per plan)
□ All window/door rough openings match schedule (verify size AND height)

Rough Plumbing:
□ All fixtures in correct locations per plan
□ DWV slopes correct (1/4" per foot minimum for most drains)
□ Vent stack extends through roof (or connects to existing stack)
□ Water test or air test passed (no leaks under pressure)
□ Cleanouts accessible
□ Tub/shower units installed (can't install after drywall)
□ Water heater T&P discharge piped to approved location

Rough Electrical:
□ Panel location per plan, properly mounted
□ All boxes at correct heights (outlets 12-18", switches 48", etc.)
□ GFCI locations per NEC (kitchens, bathrooms, garages, outdoors, unfinished basement, laundry)
□ AFCI protection per current NEC requirements
□ Smoke/CO detector locations per code (every bedroom, outside sleeping areas, every floor)
□ Recessed light cans: IC-rated where in insulation contact
□ Wire secured properly (stapled within 12" of box, every 4.5 feet)

Rough HVAC:
□ Equipment location per plan, clearances met
□ Duct sizes match Manual D calculations
□ Return air sized adequately (common to undersize)
□ All duct connections sealed with mastic or approved tape
□ Exhaust fans ducted to exterior (not into attic)
□ Combustion air provisions if needed
□ Condensate drain with trap (if applicable)

Punch List Management:
The final punch list should be SMALL if you've been doing quality checks throughout:
- Walk every room systematically (start at front door, work clockwise)
- Blue tape for paint touch-ups, drywall imperfections
- Check every drawer, door, and window for operation
- Test every switch, outlet, fixture
- Run all faucets — check for leaks under sinks
- Flush all toilets
- Test all appliances
- Exterior: grade slopes away from foundation, gutters discharge away from building
- Compile punch items by trade for efficient corrections

Warranty Standards:
- Most residential GCs provide 1-year builder warranty
- Structural: typically 10-year warranty (check your state's statute of repose)
- Manufacturer warranties: pass through to homeowner (roofing, HVAC equipment, windows, appliances)
- Create a warranty packet: all manuals, warranties, paint colors, material specs, sub contact info
- 30-day and 11-month warranty walkthroughs with homeowner`
  },

  {
    title: 'Subcontractor Management',
    sourceType: 'gc_best_practice',
    sourceRef: 'BuildOS Sub Management Guide',
    metadata: { tags: ['subcontractor', 'management', 'vetting', 'payment', 'scheduling'] },
    content: `Subcontractor Management

Your subs make or break the job. Good subs are worth their weight in gold — invest in those relationships.

Vetting New Subcontractors:
- License: verify current and valid for the work scope (state license board website)
- Insurance: require certificate of insurance (COI) with YOUR company as additional insured
  → General liability: minimum $1M per occurrence, $2M aggregate
  → Workers comp: required if they have ANY employees (even 1)
  → Auto: if they drive to your site
- References: call their last 3 GCs. Ask about quality, schedule reliability, and punch list responsiveness
- Look at their work: visit a current job site. Is it clean and organized? That tells you everything.
- Financial stability: are they paying their material suppliers? (Mechanic's liens from unpaid material bills land on YOUR project)

Subcontract Agreements — Must Include:
- Scope of work (SPECIFIC — reference plan sheets and specifications)
- Contract price (lump sum or unit price — avoid cost-plus with subs)
- Payment terms: tied to completion milestones, not invoicing dates
- Retainage: hold 5-10% until punch list is complete and signed off
- Schedule: start date, duration, completion date
- Change order process: written only, must be approved before work starts
- Insurance requirements (attach COI)
- Cleanup: each sub cleans up their own mess daily
- Warranty: minimum 1-year workmanship warranty
- Indemnification: sub holds GC harmless for their work and their employees

Payment Best Practices:
- Pay within terms (typically Net 30 from approved invoice)
- NEVER pay ahead of completed work — always verify work is done before cutting checks
- Retainage: release only after final punch list sign-off
- If there's a dispute: pay the undisputed amount, negotiate the rest separately
- Happy subs show up on time. Slow-paying GCs get put at the bottom of the sub's priority list.

Scheduling:
- Give subs a minimum 1-week notice before their start date
- If the job isn't ready for them: CALL the day before, don't let them show up to nothing
- Buffer days between trades (minimum 1 day for cleanup and prep)
- Have backup subs for critical path trades (framing, drywall, paint)
- Weather contingency: have a Plan B for rain days

Performance Tracking:
- Track for each sub: on-time percentage, inspection pass rate, punch list items, callback frequency
- "A" subs: always available, pass inspections first try, minimal punch items → give them your best projects
- "B" subs: reliable but need more follow-up → develop them, give feedback
- "C" subs: consistently late, fail inspections, lots of callbacks → one more chance with a stern conversation, then replace
- Never burn bridges — the construction community is small. Part professionally.`
  },

  {
    title: 'Material Coordination & Procurement',
    sourceType: 'gc_best_practice',
    sourceRef: 'BuildOS Material Guide',
    metadata: { tags: ['materials', 'procurement', 'lead-times', 'ordering', 'staging'] },
    content: `Material Coordination & Procurement

Getting the right materials to the right place at the right time is a logistics challenge that directly impacts schedule. Running out of 2x6 lumber when the framing crew is on-site costs you a full day of labor waiting for delivery.

Lead Time Awareness:
ORDER EARLY. These items have significant lead times:
- Windows: 4-6 weeks (custom sizes/colors: 8-12 weeks)
- Exterior doors: 4-6 weeks
- Cabinets: 6-8 weeks (custom: 10-14 weeks)
- Countertops (natural stone, quartz): 3-4 weeks after template
- Appliances: 2-4 weeks (some models 6-8 weeks)
- Trusses: 2-4 weeks
- Special-order tile or flooring: 3-6 weeks
- Steel beams/columns: 4-6 weeks
- Electrical panels and specialty breakers: 1-3 weeks (some discontinued breakers: indefinite)

Lumber and Common Materials:
- Framing lumber: typically available same-day or next-day from local yard
- Sheet goods (plywood, OSB): usually in stock
- Drywall: same-day delivery from most suppliers, but schedule delivery for the morning of hang day
- Concrete: schedule pour minimum 3 days in advance with batch plant
- Insulation: typically in stock, but blown-in requires scheduling the installer

Ordering Best Practices:
- Create a master material schedule at project start — what needs to be ordered when
- Order 10-15% overage for framing lumber (cuts, culls, warped boards)
- Order 15% overage for tile (cuts, breakage, future repairs)
- Order 10% overage for drywall (cutting waste, damage)
- Get quotes from minimum 2 suppliers — prices vary significantly
- Negotiate project pricing if spending $10K+ at one supplier (5-15% discount is typical)
- Use one primary supplier per trade — simplifies delivery and returns

Delivery Coordination:
- Stage materials WHERE they'll be used (don't stack everything in the garage)
- Lumber: deliver to the floor where it's being installed if possible
- Drywall: deliver directly to each floor/room (a drywall delivery truck with a boom arm can stock upper floors through windows)
- Protect materials from weather — cover with tarps or store inside
- Don't accept damaged deliveries — note damage on the delivery ticket and refuse damaged items

Material Storage & Protection:
- Lumber: stack flat on stickers (spacers), cover top, elevate off ground
- Drywall: store flat on a clean, dry surface. Leaned drywall warps.
- Windows: store upright, protected from impact
- Cabinets: DO NOT deliver until the house is dried in, painted, and climate-controlled. Moisture warps cabinets.
- Flooring: acclimate on-site for 48-72 hours before installation in a climate-controlled building

Waste Management:
- Dumpster sizes: 20-yard for most residential (30-yard for demos/large projects)
- Separate clean wood waste if your hauler offers reduced rates for sorted materials
- Recycle metal, cardboard, clean concrete
- Budget $1,500-$3,000 for dumpster rental on a typical residential project
- Haul-away schedule: don't let the dumpster overflow. Schedule pickup/swap when 80% full.`
  },
];

/**
 * Seed GC best practices into the database using the host app's ingest pipeline.
 * @param {function} ingestFn - The host app's ingestDocument function, modified to use gc_documents/gc_chunks tables
 * @returns {Promise<void>}
 */
export async function seedGcKnowledge(ingestFn) {
  console.log(`🏗️ Seeding GC knowledge with ${GC_SEED_DOCUMENTS.length} best practice documents...\n`);

  for (const doc of GC_SEED_DOCUMENTS) {
    try {
      const result = await ingestFn(doc);
      console.log(`  ✅ ${doc.title} → ${result.chunkCount} chunks\n`);
    } catch (err) {
      console.error(`  ❌ Failed to ingest "${doc.title}":`, err.message);
    }
  }

  console.log('\n🏗️ GC seed complete');
}
