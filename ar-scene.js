/**
 * @module ar-scene
 * Shared AR scene data structures and utilities for BuildOS.
 *
 * Usage:
 *   import { ARScene, ARLayer, ARSegment, ARFixture, ARMarker, generateMarkerKit } from '@krusch/toolkit/ar-scene';
 */

// ==========================================
// Trade Layer Definitions
// ==========================================

/** Standard trade color palette for AR layers */
export const TRADE_COLORS = {
  electrical: { color: '#f59e0b', emoji: '⚡', label: 'Electrical' },
  plumbing:   { color: '#3b82f6', emoji: '🔧', label: 'Plumbing' },
  hvac:       { color: '#06b6d4', emoji: '❄️', label: 'HVAC' },
  framing:    { color: '#a16207', emoji: '🏗️', label: 'Framing' },
  drywall:    { color: '#6b7280', emoji: '🪵', label: 'Drywall' },
  roofing:    { color: '#16a34a', emoji: '🏠', label: 'Roofing' },
  masonry:    { color: '#d97706', emoji: '🧱', label: 'Masonry' },
  painting:   { color: '#8b5cf6', emoji: '🖌️', label: 'Painting' },
  landscaping:{ color: '#22c55e', emoji: '🌿', label: 'Landscaping' },
  flooring:   { color: '#ec4899', emoji: '🪵', label: 'Flooring' },
};

/** AR.js pattern marker IDs — we ship 6 built-in patterns */
export const MARKER_PATTERNS = ['hiro', 'kanji', 'letterA', 'letterB', 'letterC', 'letterD'];

// ==========================================
// Data Structures
// ==========================================

/**
 * A 3D path segment — represents a pipe, wire, duct, or structural member.
 * @param {object} opts
 */
export function createSegment({
  id, type = 'pipe', material = '', diameter = 1,
  start = { x: 0, y: 0, z: 0 },
  end = { x: 0, y: 0, z: 0 },
  color = null, codeRef = null, label = null,
} = {}) {
  return { id, type, material, diameter, start, end, color, codeRef, label };
}

/**
 * A positioned 3D fixture — panel, outlet, register, fixture, etc.
 * @param {object} opts
 */
export function createFixture({
  id, type = 'generic', label = '',
  position = { x: 0, y: 0, z: 0 },
  size = { w: 4, h: 4, d: 4 },
  color = null, codeRef = null, details = null,
} = {}) {
  return { id, type, label, position, size, color, codeRef, details };
}

/**
 * An AR marker anchor point — placed physically on the jobsite.
 * @param {object} opts
 */
export function createMarker({
  id, label = '', pattern = 'hiro',
  position = { x: 0, y: 0, z: 0 },
  physicalSizeInches = 8,
} = {}) {
  return { id, label, pattern, position, physicalSizeInches };
}

/**
 * A trade-specific AR layer with segments and fixtures.
 * @param {object} opts
 */
export function createLayer({
  trade, segments = [], fixtures = [], visible = true,
} = {}) {
  const meta = TRADE_COLORS[trade] || { color: '#9ca3af', emoji: '🔧', label: trade };
  return {
    trade,
    color: meta.color,
    emoji: meta.emoji,
    label: meta.label,
    visible,
    segments,
    fixtures,
  };
}

/**
 * A complete AR scene for a project.
 * @param {object} opts
 */
export function createScene({
  projectId, projectName = '', markers = [], layers = [],
} = {}) {
  return {
    version: '1.0',
    projectId,
    projectName,
    generatedAt: new Date().toISOString(),
    coordinateSystem: {
      origin: markers[0]?.id || 'marker-1',
      unit: 'inches',
      axes: { x: 'east', y: 'up', z: 'south' },
    },
    markers,
    layers,
    conflicts: [],
  };
}

// ==========================================
// Marker Kit Generator
// ==========================================

/**
 * Generate marker positions from a blueprint analysis.
 * Identifies optimal anchor points (room corners, equipment locations)
 * and assigns pattern markers to each.
 *
 * @param {object} blueprintAnalysis - Parsed blueprint analysis JSON
 * @param {string} projectId - Project UUID
 * @returns {ARMarker[]} List of marker definitions with positions
 */
export function generateMarkerKit(blueprintAnalysis, projectId) {
  const markers = [];
  let markerIndex = 0;

  // Always create an origin marker
  markers.push(createMarker({
    id: `marker-${++markerIndex}`,
    label: '📍 Origin (Front-Left Corner)',
    pattern: MARKER_PATTERNS[0],
    position: { x: 0, y: 0, z: 0 },
    physicalSizeInches: 8,
  }));

  if (!blueprintAnalysis) return markers;

  // Extract rooms from analysis
  const rooms = blueprintAnalysis.rooms
    || blueprintAnalysis.dimensions?.rooms
    || [];

  // Create markers at room corner positions
  let xOffset = 0;
  for (const room of rooms) {
    const widthIn = (room.widthFt || room.width || 10) * 12;
    const lengthIn = (room.lengthFt || room.length || 10) * 12;

    if (markerIndex < MARKER_PATTERNS.length) {
      markers.push(createMarker({
        id: `marker-${++markerIndex}`,
        label: `📍 ${room.name || `Room ${markerIndex}`}`,
        pattern: MARKER_PATTERNS[markerIndex - 1] || 'hiro',
        position: { x: xOffset + widthIn / 2, y: 0, z: lengthIn / 2 },
        physicalSizeInches: 8,
      }));
    }
    xOffset += widthIn;
  }

  // If analysis has equipment locations, create markers for those
  const equipment = blueprintAnalysis.equipment
    || blueprintAnalysis.mep_elements
    || [];

  for (const equip of equipment) {
    if (markerIndex >= MARKER_PATTERNS.length) break;
    const pos = equip.position || { x: xOffset, y: 0, z: 0 };
    markers.push(createMarker({
      id: `marker-${++markerIndex}`,
      label: `⚡ ${equip.name || equip.type || 'Equipment'}`,
      pattern: MARKER_PATTERNS[markerIndex - 1] || 'hiro',
      position: { x: pos.x || 0, y: pos.y || 0, z: pos.z || 0 },
      physicalSizeInches: 8,
    }));
  }

  return markers;
}

// ==========================================
// Serialization
// ==========================================

/** Serialize a scene to JSON string */
export function sceneToJSON(scene) {
  return JSON.stringify(scene, null, 2);
}

/** Deserialize a scene from JSON string */
export function sceneFromJSON(jsonStr) {
  const obj = typeof jsonStr === 'string' ? JSON.parse(jsonStr) : jsonStr;
  return obj;
}

// ==========================================
// Demo Scene Generator (Phase 1 testing)
// ==========================================

/**
 * Generate a demo AR scene with hardcoded routing data.
 * Used for Phase 1 testing before the AI routing engine (Phase 2) is built.
 *
 * @param {string} projectId
 * @returns {object} Demo scene
 */
export function generateDemoScene(projectId = 'demo') {
  const markers = [
    createMarker({ id: 'marker-1', label: '📍 Origin', pattern: 'hiro', position: { x: 0, y: 0, z: 0 } }),
    createMarker({ id: 'marker-2', label: '⚡ Panel', pattern: 'kanji', position: { x: 120, y: 0, z: 0 } }),
  ];

  const electricalLayer = createLayer({
    trade: 'electrical',
    segments: [
      createSegment({ id: 'e-seg-1', type: 'wire', material: '14/2 NM-B', diameter: 0.5,
        start: { x: 120, y: 48, z: 0 }, end: { x: 120, y: 48, z: 60 }, codeRef: 'NEC 334.15' }),
      createSegment({ id: 'e-seg-2', type: 'wire', material: '14/2 NM-B', diameter: 0.5,
        start: { x: 120, y: 48, z: 60 }, end: { x: 60, y: 48, z: 60 }, codeRef: 'NEC 334.15' }),
      createSegment({ id: 'e-seg-3', type: 'wire', material: '12/2 NM-B', diameter: 0.6,
        start: { x: 120, y: 48, z: 0 }, end: { x: 120, y: 48, z: 120 }, codeRef: 'NEC 334.15' }),
      createSegment({ id: 'e-seg-4', type: 'wire', material: '12/2 NM-B', diameter: 0.6,
        start: { x: 120, y: 48, z: 120 }, end: { x: 180, y: 14, z: 120 }, codeRef: 'NEC 334.15' }),
    ],
    fixtures: [
      createFixture({ id: 'e-fix-1', type: 'panel', label: '200A Main Panel',
        position: { x: 120, y: 60, z: 0 }, size: { w: 14.5, h: 32, d: 6 } }),
      createFixture({ id: 'e-fix-2', type: 'outlet', label: 'Kitchen GFCI',
        position: { x: 60, y: 42, z: 60 }, size: { w: 2.75, h: 4.5, d: 2 } }),
      createFixture({ id: 'e-fix-3', type: 'outlet', label: 'Living Room Outlet',
        position: { x: 180, y: 14, z: 120 }, size: { w: 2.75, h: 4.5, d: 2 } }),
    ],
  });

  const plumbingLayer = createLayer({
    trade: 'plumbing',
    visible: false,
    segments: [
      createSegment({ id: 'p-seg-1', type: 'drain', material: '3" PVC DWV', diameter: 3,
        start: { x: 60, y: 0, z: 80 }, end: { x: 60, y: 36, z: 80 }, codeRef: 'IPC 702.1' }),
      createSegment({ id: 'p-seg-2', type: 'drain', material: '2" PVC DWV', diameter: 2,
        start: { x: 60, y: 36, z: 80 }, end: { x: 60, y: 36, z: 140 }, codeRef: 'IPC 702.1' }),
      createSegment({ id: 'p-seg-3', type: 'supply', material: '1/2" PEX', diameter: 0.5,
        start: { x: 62, y: 36, z: 80 }, end: { x: 62, y: 36, z: 140 }, codeRef: 'IPC 605.3' }),
    ],
    fixtures: [
      createFixture({ id: 'p-fix-1', type: 'sink', label: 'Kitchen Sink',
        position: { x: 60, y: 36, z: 80 }, size: { w: 22, h: 10, d: 17 } }),
      createFixture({ id: 'p-fix-2', type: 'toilet', label: 'Bathroom Toilet',
        position: { x: 60, y: 0, z: 140 }, size: { w: 15, h: 20, d: 28 } }),
    ],
  });

  const hvacLayer = createLayer({
    trade: 'hvac',
    visible: false,
    segments: [
      createSegment({ id: 'h-seg-1', type: 'duct', material: '8" Round Duct', diameter: 8,
        start: { x: 90, y: 84, z: 30 }, end: { x: 90, y: 84, z: 90 }, codeRef: 'IMC 603.1' }),
      createSegment({ id: 'h-seg-2', type: 'duct', material: '6" Round Duct', diameter: 6,
        start: { x: 90, y: 84, z: 90 }, end: { x: 150, y: 84, z: 90 }, codeRef: 'IMC 603.1' }),
      createSegment({ id: 'h-seg-3', type: 'duct', material: '6" Flex Duct', diameter: 6,
        start: { x: 150, y: 84, z: 90 }, end: { x: 150, y: 84, z: 150 }, codeRef: 'IMC 603.1' }),
    ],
    fixtures: [
      createFixture({ id: 'h-fix-1', type: 'air_handler', label: 'Furnace / Air Handler',
        position: { x: 90, y: 0, z: 30 }, size: { w: 21, h: 40, d: 28 } }),
      createFixture({ id: 'h-fix-2', type: 'register', label: 'Supply Register 6×10',
        position: { x: 150, y: 84, z: 150 }, size: { w: 10, h: 2, d: 6 } }),
    ],
  });

  return createScene({
    projectId,
    projectName: 'Demo Project — AR Test',
    markers,
    layers: [electricalLayer, plumbingLayer, hvacLayer],
  });
}
