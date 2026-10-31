/**
 * Hierarchical Spatial Knowledge Graph (AVA-Encoder Pattern)
 * 
 * Implements arXiv: 2608.12313 (AVA-Encoder) for physical property modeling.
 * Transforms video walkthrough observations into a structured, queryable knowledge
 * graph of rooms, fixtures, pipe/wire runs, structural members, and isolation points.
 */

export class SpatialNode {
  /**
   * @param {object} params
   * @param {string} params.id - Unique node identifier (e.g. 'node-kitchen-sink-dwv')
   * @param {string} params.name - Human-readable label (e.g. 'Kitchen Sink DWV Line')
   * @param {string} params.type - 'zone' | 'room' | 'fixture' | 'component' | 'structural' | 'inventory'
   * @param {string} [params.zone] - Zone or level (e.g. 'crawl_space', 'attic', 'first_floor')
   * @param {object} [params.specs] - Technical specifications (material, diameter, gauge, voltage, etc.)
   * @param {object} [params.location] - 3D/2D location { x, y, z, floor }
   * @param {object} [params.visualEvidence] - Video grounding { sourceClip, timestampRange: [start, end], framePath, bbox }
   */
  constructor({ id, name, type, zone = null, specs = {}, location = {}, visualEvidence = null }) {
    this.id = id || `node-${type}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    this.name = name;
    this.type = type;
    this.zone = zone;
    this.specs = specs;
    this.location = location;
    this.visualEvidence = visualEvidence;
    this.metadata = {};
  }
}

export class InfrastructureEdge {
  /**
   * @param {object} params
   * @param {string} params.sourceId - Source Node ID
   * @param {string} params.targetId - Target Node ID
   * @param {string} params.relation - Relation type (e.g. 'supplies_water', 'drains_waste', 'powers_circuit', 'penetrates', 'isolated_by')
   * @param {object} [params.properties] - Edge attributes (material, length_ft, diameter_in, slope_in_per_ft, wire_gauge)
   * @param {object} [params.visualEvidence] - Video grounding proof
   */
  constructor({ sourceId, targetId, relation, properties = {}, visualEvidence = null }) {
    this.id = `edge-${sourceId}-${relation}-${targetId}`;
    this.sourceId = sourceId;
    this.targetId = targetId;
    this.relation = relation;
    this.properties = properties;
    this.visualEvidence = visualEvidence;
  }
}

export class SpatialKnowledgeGraph {
  constructor(propertyId = 'property-default') {
    this.propertyId = propertyId;
    this.nodes = new Map(); // id -> SpatialNode
    this.edges = new Map(); // id -> InfrastructureEdge
    this.adjacency = new Map(); // sourceId -> Array<{ edgeId, targetId, relation }>
    this.reverseAdjacency = new Map(); // targetId -> Array<{ edgeId, sourceId, relation }>
  }

  /**
   * Add a spatial node to the graph
   * @param {SpatialNode|object} nodeData 
   * @returns {SpatialNode}
   */
  addNode(nodeData) {
    const node = nodeData instanceof SpatialNode ? nodeData : new SpatialNode(nodeData);
    this.nodes.set(node.id, node);
    if (!this.adjacency.has(node.id)) this.adjacency.set(node.id, []);
    if (!this.reverseAdjacency.has(node.id)) this.reverseAdjacency.set(node.id, []);
    return node;
  }

  /**
   * Get a node by ID
   * @param {string} id 
   * @returns {SpatialNode|null}
   */
  getNode(id) {
    return this.nodes.get(id) || null;
  }

  /**
   * Add a directed infrastructure edge
   * @param {InfrastructureEdge|object} edgeData 
   * @returns {InfrastructureEdge}
   */
  addEdge(edgeData) {
    const edge = edgeData instanceof InfrastructureEdge ? edgeData : new InfrastructureEdge(edgeData);
    
    // Ensure nodes exist or create placeholders
    if (!this.nodes.has(edge.sourceId)) {
      this.addNode({ id: edge.sourceId, name: edge.sourceId, type: 'component' });
    }
    if (!this.nodes.has(edge.targetId)) {
      this.addNode({ id: edge.targetId, name: edge.targetId, type: 'component' });
    }

    this.edges.set(edge.id, edge);

    // Update forward adjacency
    const outEdges = this.adjacency.get(edge.sourceId) || [];
    outEdges.push({ edgeId: edge.id, targetId: edge.targetId, relation: edge.relation });
    this.adjacency.set(edge.sourceId, outEdges);

    // Update reverse adjacency
    const inEdges = this.reverseAdjacency.get(edge.targetId) || [];
    inEdges.push({ edgeId: edge.id, sourceId: edge.sourceId, relation: edge.relation });
    this.reverseAdjacency.set(edge.targetId, inEdges);

    return edge;
  }

  /**
   * Find upstream supply path (e.g. from kitchen sink hot valve backwards to water heater / main)
   * @param {string} targetNodeId 
   * @param {string} [relationType='supplies_water'] 
   * @returns {Array<{ node: SpatialNode, edge: InfrastructureEdge|null }>}
   */
  traceUpstream(targetNodeId, relationType = null) {
    const path = [];
    const visited = new Set();
    let currentId = targetNodeId;

    while (currentId && !visited.has(currentId)) {
      visited.add(currentId);
      const node = this.getNode(currentId);
      if (!node) break;

      const inEdges = this.reverseAdjacency.get(currentId) || [];
      const matchingEdge = relationType 
        ? inEdges.find(e => e.relation === relationType)
        : inEdges[0];

      if (matchingEdge) {
        const edgeObj = this.edges.get(matchingEdge.edgeId);
        path.push({ node, edge: edgeObj });
        currentId = matchingEdge.sourceId;
      } else {
        path.push({ node, edge: null });
        break;
      }
    }

    return path.reverse();
  }

  /**
   * Find downstream drainage path (e.g. from fixture drain downstream to sewer main)
   * @param {string} startNodeId 
   * @param {string} [relationType='drains_waste'] 
   * @returns {Array<{ node: SpatialNode, edge: InfrastructureEdge|null }>}
   */
  traceDownstream(startNodeId, relationType = 'drains_waste') {
    const path = [];
    const visited = new Set();
    let currentId = startNodeId;

    while (currentId && !visited.has(currentId)) {
      visited.add(currentId);
      const node = this.getNode(currentId);
      if (!node) break;

      const outEdges = this.adjacency.get(currentId) || [];
      const matchingEdge = relationType 
        ? outEdges.find(e => e.relation === relationType)
        : outEdges[0];

      if (matchingEdge) {
        const edgeObj = this.edges.get(matchingEdge.edgeId);
        path.push({ node, edge: edgeObj });
        currentId = matchingEdge.targetId;
      } else {
        path.push({ node, edge: null });
        break;
      }
    }

    return path;
  }

  /**
   * Find all nodes in a specific physical zone (e.g. 'crawl_space', 'attic')
   * @param {string} zone 
   * @returns {SpatialNode[]}
   */
  findNodesByZone(zone) {
    const zoneLower = (zone || '').toLowerCase().trim();
    return Array.from(this.nodes.values()).filter(n => 
      n.zone && n.zone.toLowerCase().includes(zoneLower)
    );
  }

  /**
   * Find nodes by material or specification (e.g. 'PEX', 'BX', 'galvanized', 'copper')
   * @param {string} material 
   * @returns {SpatialNode[]}
   */
  findNodesByMaterial(material) {
    const matLower = (material || '').toLowerCase().trim();
    return Array.from(this.nodes.values()).filter(n => {
      const specMat = n.specs && n.specs.material ? String(n.specs.material).toLowerCase() : '';
      return specMat.includes(matLower) || n.name.toLowerCase().includes(matLower);
    });
  }

  /**
   * Convert graph into structured textual triplets for vector indexing / LLM context
   * @returns {string[]}
   */
  toTriplets() {
    const triplets = [];
    for (const edge of this.edges.values()) {
      const source = this.getNode(edge.sourceId);
      const target = this.getNode(edge.targetId);
      if (source && target) {
        let tripletText = `(${source.name} [${source.type} in ${source.zone || 'general'}]) --[${edge.relation}]--> (${target.name} [${target.type} in ${target.zone || 'general'}])`;
        if (edge.properties && Object.keys(edge.properties).length > 0) {
          tripletText += ` {${JSON.stringify(edge.properties)}}`;
        }
        triplets.push(tripletText);
      }
    }
    return triplets;
  }

  /**
   * Export graph to serializable JSON object
   * @returns {object}
   */
  toJSON() {
    return {
      propertyId: this.propertyId,
      nodes: Array.from(this.nodes.values()),
      edges: Array.from(this.edges.values())
    };
  }

  /**
   * Hydrate graph from JSON object
   * @param {object} json 
   * @returns {SpatialKnowledgeGraph}
   */
  static fromJSON(json) {
    const graph = new SpatialKnowledgeGraph(json.propertyId || 'property-imported');
    if (Array.isArray(json.nodes)) {
      for (const n of json.nodes) graph.addNode(n);
    }
    if (Array.isArray(json.edges)) {
      for (const e of json.edges) graph.addEdge(e);
    }
    return graph;
  }
}
