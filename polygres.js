/**
 * Polygres Client Adapter (@krusch/toolkit/polygres)
 * 
 * Unifies Relational Data, Graph Traversals (pgGraph), and Vector Search (pgContext/pgvector)
 * for AI Agents in a single PostgreSQL backend.
 * 
 * Supports:
 * 1. Cloud Polygres (polygres.com) via standard Postgres wire protocol.
 * 2. Self-hosted PostgreSQL with pgvector and graph tables.
 */

import pg from 'pg';
import { SpatialKnowledgeGraph, SpatialNode, InfrastructureEdge } from './spatial-kg.js';
import { EvidenceGroundingEngine, VideoEvidenceSegment } from './evqa-grounding.js';

export class PolygresClient {
  /**
   * @param {object} options
   * @param {string} [options.connectionString] - Postgres / Polygres connection URI
   * @param {string} [options.apiKey] - Optional Polygres Cloud API key
   * @param {string} [options.runtimeUrl] - Optional Polygres Cloud Runtime API URL (e.g. https://<project>.api.db.polygres.com/v1)
   * @param {string} [options.projectId] - Optional Polygres project ID
   * @param {number} [options.maxConnections=10] - Pool size
   */
  constructor(options = {}) {
    this.connectionString = options.connectionString || process.env.POLYGRESS_URL || process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/appdb';
    this.apiKey = options.apiKey || process.env.POLYGRESS_API_KEY || process.env.POLYGRES_API_KEY || null;
    this.runtimeUrl = options.runtimeUrl || process.env.POLYGRES_RUNTIME_URL || null;
    this.projectId = options.projectId || process.env.POLYGRES_PROJECT_ID || null;
    this.pool = new pg.Pool({
      connectionString: this.connectionString,
      max: options.maxConnections || 10,
      ssl: this.connectionString.includes('polygres.com') ? { rejectUnauthorized: false } : false
    });
  }

  /**
   * Execute raw SQL query with parameters
   * @param {string} sql 
   * @param {Array<any>} [params] 
   * @returns {Promise<pg.QueryResult>}
   */
  async query(sql, params = []) {
    return this.pool.query(sql, params);
  }

  /**
   * Initialize Polygres relational, graph, and vector schemas for Rough-In
   */
  async initializeSchema() {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Enable pgvector if available
      try {
        await client.query('CREATE EXTENSION IF NOT EXISTS vector;');
      } catch (err) {
        console.warn('⚠️  pgvector extension not installed or allowed; falling back to JSON embeddings.');
      }

      // 1. Projects Table
      await client.query(`
        CREATE TABLE IF NOT EXISTS roughin_projects (
          id VARCHAR(64) PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          address VARCHAR(255),
          property_owner VARCHAR(255),
          entity VARCHAR(128),
          metadata JSONB DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);

      // 2. Spatial Nodes (Graph Entities: Zones, Fixtures, Components)
      await client.query(`
        CREATE TABLE IF NOT EXISTS roughin_spatial_nodes (
          id VARCHAR(128) PRIMARY KEY,
          project_id VARCHAR(64) REFERENCES roughin_projects(id) ON DELETE CASCADE,
          name VARCHAR(255) NOT NULL,
          node_type VARCHAR(64) NOT NULL, -- 'zone', 'room', 'fixture', 'component', 'inventory'
          zone VARCHAR(64),
          specs JSONB DEFAULT '{}'::jsonb,
          location JSONB DEFAULT '{}'::jsonb,
          visual_evidence JSONB DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_spatial_nodes_project ON roughin_spatial_nodes(project_id);
        CREATE INDEX IF NOT EXISTS idx_spatial_nodes_zone ON roughin_spatial_nodes(zone);
        CREATE INDEX IF NOT EXISTS idx_spatial_nodes_type ON roughin_spatial_nodes(node_type);
      `);

      // 3. Infrastructure Edges (Graph Relationships: supplies_water, drains_waste, powers_circuit)
      await client.query(`
        CREATE TABLE IF NOT EXISTS roughin_spatial_edges (
          id VARCHAR(255) PRIMARY KEY,
          project_id VARCHAR(64) REFERENCES roughin_projects(id) ON DELETE CASCADE,
          source_id VARCHAR(128) REFERENCES roughin_spatial_nodes(id) ON DELETE CASCADE,
          target_id VARCHAR(128) REFERENCES roughin_spatial_nodes(id) ON DELETE CASCADE,
          relation VARCHAR(64) NOT NULL,
          properties JSONB DEFAULT '{}'::jsonb,
          visual_evidence JSONB DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_spatial_edges_project ON roughin_spatial_edges(project_id);
        CREATE INDEX IF NOT EXISTS idx_spatial_edges_source ON roughin_spatial_edges(source_id);
        CREATE INDEX IF NOT EXISTS idx_spatial_edges_target ON roughin_spatial_edges(target_id);
        CREATE INDEX IF NOT EXISTS idx_spatial_edges_relation ON roughin_spatial_edges(relation);
      `);

      // 4. Video Evidence & Grounding (E-VQA)
      await client.query(`
        CREATE TABLE IF NOT EXISTS roughin_video_evidence (
          id VARCHAR(255) PRIMARY KEY,
          project_id VARCHAR(64) REFERENCES roughin_projects(id) ON DELETE CASCADE,
          source_clip VARCHAR(255) NOT NULL,
          start_sec NUMERIC(8,2) NOT NULL,
          end_sec NUMERIC(8,2) NOT NULL,
          description TEXT NOT NULL,
          keyframe_path VARCHAR(512),
          entities TEXT[] DEFAULT '{}',
          confidence NUMERIC(4,3) DEFAULT 1.0,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_video_evidence_project ON roughin_video_evidence(project_id);
        CREATE INDEX IF NOT EXISTS idx_video_evidence_clip ON roughin_video_evidence(source_clip);
      `);

      // 5. Estimates & Trade Takeoffs
      await client.query(`
        CREATE TABLE IF NOT EXISTS roughin_estimates (
          id VARCHAR(64) PRIMARY KEY,
          project_id VARCHAR(64) REFERENCES roughin_projects(id) ON DELETE CASCADE,
          trade VARCHAR(64) NOT NULL, -- 'roughin_general', 'drainflux', 'spark', 'climacore', 'frameup'
          contractor_cost NUMERIC(12,2) NOT NULL,
          customer_price NUMERIC(12,2) NOT NULL,
          gross_margin_pct NUMERIC(5,2),
          line_items JSONB DEFAULT '[]'::jsonb,
          verification_status VARCHAR(32) DEFAULT 'PENDING',
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_estimates_project ON roughin_estimates(project_id);
        CREATE INDEX IF NOT EXISTS idx_estimates_trade ON roughin_estimates(trade);
      `);

      await client.query('COMMIT');
      console.log('✅ Polygres: Initialized Relational, Graph & Vector Schemas successfully.');
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('❌ Polygres: Schema initialization failed:', err.message);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Sync an in-memory SpatialKnowledgeGraph instance to Polygres tables
   * @param {SpatialKnowledgeGraph} graph 
   * @param {object} [projectMetadata] 
   */
  async syncSpatialGraph(graph, projectMetadata = {}) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const projectId = graph.propertyId;

      // Upsert project
      await client.query(`
        INSERT INTO roughin_projects (id, name, address, property_owner, entity, metadata, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          address = EXCLUDED.address,
          property_owner = EXCLUDED.property_owner,
          entity = EXCLUDED.entity,
          metadata = EXCLUDED.metadata,
          updated_at = NOW();
      `, [
        projectId,
        projectMetadata.name || `Property ${projectId}`,
        projectMetadata.address || null,
        projectMetadata.owner || null,
        projectMetadata.entity || 'Default',
        JSON.stringify(projectMetadata)
      ]);

      // Upsert nodes
      for (const node of graph.nodes.values()) {
        await client.query(`
          INSERT INTO roughin_spatial_nodes (id, project_id, name, node_type, zone, specs, location, visual_evidence)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            node_type = EXCLUDED.node_type,
            zone = EXCLUDED.zone,
            specs = EXCLUDED.specs,
            location = EXCLUDED.location,
            visual_evidence = EXCLUDED.visual_evidence;
        `, [
          node.id,
          projectId,
          node.name,
          node.type,
          node.zone,
          JSON.stringify(node.specs || {}),
          JSON.stringify(node.location || {}),
          JSON.stringify(node.visualEvidence || {})
        ]);
      }

      // Upsert edges
      for (const edge of graph.edges.values()) {
        await client.query(`
          INSERT INTO roughin_spatial_edges (id, project_id, source_id, target_id, relation, properties, visual_evidence)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (id) DO UPDATE SET
            relation = EXCLUDED.relation,
            properties = EXCLUDED.properties,
            visual_evidence = EXCLUDED.visual_evidence;
        `, [
          edge.id,
          projectId,
          edge.sourceId,
          edge.targetId,
          edge.relation,
          JSON.stringify(edge.properties || {}),
          JSON.stringify(edge.visualEvidence || {})
        ]);
      }

      await client.query('COMMIT');
      console.log(`✅ Polygres: Synced ${graph.nodes.size} nodes and ${graph.edges.size} edges for project ${projectId}.`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`❌ Polygres: Failed to sync spatial graph:`, err.message);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Sync an in-memory EvidenceGroundingEngine instance to Polygres
   * @param {EvidenceGroundingEngine} evqa 
   */
  async syncEvidenceIndex(evqa) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const projectId = evqa.propertyId;

      for (const ev of evqa.evidenceIndex) {
        await client.query(`
          INSERT INTO roughin_video_evidence (id, project_id, source_clip, start_sec, end_sec, description, keyframe_path, entities, confidence)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (id) DO UPDATE SET
            description = EXCLUDED.description,
            keyframe_path = EXCLUDED.keyframe_path,
            entities = EXCLUDED.entities,
            confidence = EXCLUDED.confidence;
        `, [
          ev.id,
          projectId,
          ev.sourceClip,
          ev.startSec,
          ev.endSec,
          ev.description,
          ev.keyframePath,
          ev.entities || [],
          ev.confidence || 1.0
        ]);
      }

      await client.query('COMMIT');
      console.log(`✅ Polygres: Synced ${evqa.evidenceIndex.length} video evidence records for project ${projectId}.`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('❌ Polygres: Failed to sync video evidence:', err.message);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Hydrate a complete SpatialKnowledgeGraph from Polygres for a project
   * @param {string} projectId 
   * @returns {Promise<SpatialKnowledgeGraph>}
   */
  async loadSpatialGraph(projectId) {
    const graph = new SpatialKnowledgeGraph(projectId);

    const nodesRes = await this.query(
      'SELECT * FROM roughin_spatial_nodes WHERE project_id = $1',
      [projectId]
    );
    for (const row of nodesRes.rows) {
      graph.addNode({
        id: row.id,
        name: row.name,
        type: row.node_type,
        zone: row.zone,
        specs: row.specs,
        location: row.location,
        visualEvidence: row.visual_evidence
      });
    }

    const edgesRes = await this.query(
      'SELECT * FROM roughin_spatial_edges WHERE project_id = $1',
      [projectId]
    );
    for (const row of edgesRes.rows) {
      graph.addEdge({
        sourceId: row.source_id,
        targetId: row.target_id,
        relation: row.relation,
        properties: row.properties,
        visualEvidence: row.visual_evidence
      });
    }

    return graph;
  }

  /**
   * Hydrate EvidenceGroundingEngine from Polygres
   * @param {string} projectId 
   * @returns {Promise<EvidenceGroundingEngine>}
   */
  async loadEvidenceEngine(projectId) {
    const engine = new EvidenceGroundingEngine(projectId);
    const res = await this.query(
      'SELECT * FROM roughin_video_evidence WHERE project_id = $1 ORDER BY start_sec ASC',
      [projectId]
    );

    for (const row of res.rows) {
      engine.indexEvidence({
        sourceClip: row.source_clip,
        startSec: parseFloat(row.start_sec),
        endSec: parseFloat(row.end_sec),
        description: row.description,
        keyframePath: row.keyframe_path,
        entities: row.entities,
        confidence: parseFloat(row.confidence)
      });
    }

    return engine;
  }

  /**
   * Internal helper for Polygres 0.5.0 Runtime REST API requests
   * @param {string} endpoint 
   * @param {object} [options]
   * @returns {Promise<any>}
   */
  async _runtimeRequest(endpoint, { method = 'GET', body = null, headers = {} } = {}) {
    if (!this.runtimeUrl) {
      throw new Error('Polygres Runtime API requires runtimeUrl or POLYGRES_RUNTIME_URL to be set.');
    }
    const cleanUrl = this.runtimeUrl.replace(/\/+$/, '');
    const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
    const url = `${cleanUrl}${cleanEndpoint}`;

    const requestHeaders = {
      'Content-Type': 'application/json',
      ...headers
    };
    if (this.apiKey) {
      requestHeaders['Authorization'] = `Bearer ${this.apiKey}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    try {
      const res = await fetch(url, {
        method,
        headers: requestHeaders,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const errorMsg = data?.error?.message || data?.detail || `HTTP ${res.status}: ${res.statusText}`;
        const err = new Error(`[Polygres Runtime] ${errorMsg}`);
        err.status = res.status;
        err.data = data;
        throw err;
      }
      return data;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Fetch embedding microcredit quota and real-time usage (v0.5.0)
   * @returns {Promise<{generation: object, query: object, period_kind: string, remaining_microcredits: object}>}
   */
  async getUsage() {
    return this._runtimeRequest('/embeddings/usage');
  }

  /**
   * Discover in-database embedding models and dimensions (v0.5.0)
   * @returns {Promise<{models: Array<{id: string, name: string, provider: string, dimensions: number[], default_dimensions: number}>}>}
   */
  async getEmbeddingModels() {
    return this._runtimeRequest('/embeddings/models');
  }

  /**
   * Retrieve pgContext engine limits, HNSW parameters, and compatibility (v0.5.0)
   * @returns {Promise<object>}
   */
  async getCapabilities() {
    return this._runtimeRequest('/context/capabilities');
  }

  /**
   * List automated background embedding configurations for watched source tables
   * @returns {Promise<{configurations: Array<object>}>}
   */
  async listEmbeddingConfigs() {
    return this._runtimeRequest('/embeddings/configurations');
  }

  /**
   * Register an automated in-database embedding pipeline on a watched source table
   * @param {object} config
   * @param {string} [idempotencyKey]
   * @returns {Promise<object>}
   */
  async createEmbeddingConfig(config, idempotencyKey = null) {
    const headers = idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {};
    return this._runtimeRequest('/embeddings/configurations', {
      method: 'POST',
      body: config,
      headers
    });
  }

  /**
   * Execute semantic vector or text search over a pgContext collection (v0.5.0 zero-client-embedding)
   * @param {string} collectionName 
   * @param {object} [options]
   * @param {string} [options.text] - Raw query text to embed in-database
   * @param {number[]} [options.embedding] - Precomputed float vector
   * @param {object} [options.filters] - JSON metadata filter clauses
   * @param {number} [options.limit=10] - Number of ranked results
   * @param {string} [options.idempotencyKey]
   * @returns {Promise<object>}
   */
  async contextSearch(collectionName, options = {}) {
    const { text, embedding, filters = {}, limit = 10, idempotencyKey = null } = options;
    const body = {
      limit,
      filters
    };
    if (text) body.text = text;
    if (embedding) body.embedding = embedding;

    const headers = idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {};
    const endpoint = collectionName 
      ? `/context/collections/by-name/${encodeURIComponent(collectionName)}/search`
      : '/embeddings/search';

    return this._runtimeRequest(endpoint, {
      method: 'POST',
      body,
      headers
    });
  }

  /**
   * Traverse multi-hop graph relationships via Runtime API (v0.5.0)
   * @param {string} nodeId 
   * @param {object} [options]
   * @param {number} [options.maxHops=1]
   * @param {string[]} [options.edgeTypes=[]]
   * @returns {Promise<object>}
   */
  async graphExpand(nodeId, options = {}) {
    const { maxHops = 1, edgeTypes = [] } = options;
    return this._runtimeRequest('/graph/expand', {
      method: 'POST',
      body: {
        node_id: nodeId,
        max_hops: maxHops,
        edge_types: edgeTypes
      }
    });
  }

  /**
   * Close database connection pool
   */
  async close() {
    await this.pool.end();
  }
}

/**
 * Factory method to instantiate Polygres client
 * @param {object} [options] 
 * @returns {PolygresClient}
 */
export function createPolygresClient(options = {}) {
  return new PolygresClient(options);
}
