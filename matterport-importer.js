/**
 * Matterport Spatial Importer & Digital Twin Fusion Engine
 * 
 * Ingests Matterport 3D model exports (MatterPak, OBJ/PLY meshes, E57 point clouds,
 * and Sweep Node JSON graphs) and fuses them with the Homelab Spatial Knowledge Graph,
 * Hydra-0 Action Flows, and PhysCaP compliance telematics.
 */

import { existsSync, readFileSync } from 'fs';
import { SpatialKnowledgeGraph, SpatialNode, InfrastructureEdge } from './spatial-kg.js';

export class MatterportSweepStation {
  /**
   * @param {object} params
   * @param {string} params.sweepId - Unique sweep node ID (e.g. 'sweep_01_kitchen')
   * @param {string} params.label - Human label (e.g. 'Kitchen Island Station')
   * @param {Array<number>} params.position - [x, y, z] metric 3D position
   * @param {Array<number>} [params.rotation] - [yaw, pitch, roll] in degrees
   * @param {string} [params.panoramaUrl] - URL or path to 360 equirectangular image
   * @param {string} [params.room] - Room / Zone name
   */
  constructor({ sweepId, label, position, rotation = [0, 0, 0], panoramaUrl = null, room = 'general' }) {
    this.sweepId = sweepId;
    this.label = label || sweepId;
    this.position = position; // [x, y, z]
    this.rotation = rotation;
    this.panoramaUrl = panoramaUrl;
    this.room = room;
  }
}

export class MatterportMeshMetadata {
  constructor({ modelId, address = '', vertexCount = 0, faceCount = 0, unit = 'meters' }) {
    this.modelId = modelId;
    this.address = address;
    this.vertexCount = vertexCount;
    this.faceCount = faceCount;
    this.unit = unit;
    this.sweepStations = []; // Array<MatterportSweepStation>
    this.floors = [];
    this.rooms = [];
  }

  addSweep(sweep) {
    const s = sweep instanceof MatterportSweepStation ? sweep : new MatterportSweepStation(sweep);
    this.sweepStations.push(s);
    return s;
  }
}

export class MatterportImporter {
  constructor(options = {}) {
    this.scaleFactor = options.scaleFactor || 1.0; // 1.0 = meters
  }

  /**
   * Parse a Matterport Sweep Graph JSON file
   * @param {string|object} sweepData - Raw JSON string or parsed object
   * @returns {MatterportSweepStation[]}
   */
  parseSweepGraph(sweepData) {
    const raw = typeof sweepData === 'string' ? JSON.parse(sweepData) : sweepData;
    const stations = [];

    const sweeps = raw.sweeps || raw.nodes || (Array.isArray(raw) ? raw : []);
    for (const [idx, s] of sweeps.entries()) {
      const pos = s.position || s.pose?.translation || [s.x || 0, s.y || 0, s.z || 0];
      const rot = s.rotation || s.pose?.rotation || [0, 0, 0];
      const sweepId = s.id || s.uuid || `sweep_${idx + 1}`;
      const label = s.label || s.name || `Station ${idx + 1} (${s.room || 'Interior'})`;

      stations.push(new MatterportSweepStation({
        sweepId,
        label,
        position: pos,
        rotation: rot,
        panoramaUrl: s.pano_url || s.image_url || null,
        room: s.room || 'first_floor'
      }));
    }

    return stations;
  }

  /**
   * Fuse a Matterport architectural mesh & sweep graph with an existing Spatial Knowledge Graph
   * @param {MatterportMeshMetadata|object} matterportMeta 
   * @param {SpatialKnowledgeGraph} spatialGraph 
   * @returns {{ fusedGraph: SpatialKnowledgeGraph, integratedStations: number }}
   */
  fuseWithSpatialGraph(matterportMeta, spatialGraph) {
    const graph = spatialGraph || new SpatialKnowledgeGraph(matterportMeta.modelId || 'matterport-fused');
    const sweeps = matterportMeta.sweepStations || [];

    for (const sweep of sweeps) {
      // Add or update spatial station node
      graph.addNode(new SpatialNode({
        id: `station-${sweep.sweepId}`,
        name: sweep.label,
        type: 'zone',
        zone: sweep.room,
        location: {
          x: sweep.position[0],
          y: sweep.position[1],
          z: sweep.position[2]
        },
        specs: {
          matterportSweepId: sweep.sweepId,
          panoramaUrl: sweep.panoramaUrl
        }
      }));
    }

    return {
      fusedGraph: graph,
      integratedStations: sweeps.length,
      nodeCount: graph.nodes.size,
      edgeCount: graph.edges.size
    };
  }

  /**
   * Generate an automated Matterport-to-Home-Passport ingestion bundle
   * @param {object} params
   * @param {string} params.modelId - Matterport Model ID (e.g. 'm-abc123xyz')
   * @param {string} params.propertyAddress - Property street address
   * @param {Array<object>} params.sweeps - Sweep station coordinates
   * @param {object} [params.actionFlows] - Hydra-0 trade flows
   * @returns {object} Standardized Home Passport property record
   */
  createPassportBundle({ modelId, propertyAddress, sweeps = [], actionFlows = {} }) {
    const meta = new MatterportMeshMetadata({ modelId, address: propertyAddress });
    const stations = this.parseSweepGraph(sweeps);
    for (const s of stations) meta.addSweep(s);

    const kg = new SpatialKnowledgeGraph(modelId);
    const fusion = this.fuseWithSpatialGraph(meta, kg);

    return {
      source: 'MATTERPORT_3D_INGEST',
      modelId,
      address: propertyAddress,
      ingestedAt: new Date().toISOString(),
      architecturalEnvelope: {
        sweepStations: meta.sweepStations,
        meshUnit: meta.unit
      },
      spatialKnowledgeGraph: fusion.fusedGraph.toJSON(),
      actionFlows
    };
  }
}

/**
 * Factory helper
 */
export function createMatterportImporter(options = {}) {
  return new MatterportImporter(options);
}
