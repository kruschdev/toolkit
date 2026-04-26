/**
 * @module lib/client/floor-plan-viewer
 * Interactive 3D floor plan viewer using Three.js.
 * Vanilla JS — no React/Vue dependency. Works in any frontend.
 *
 * Usage:
 *   import { FloorPlanViewer } from '../../lib/client/floor-plan-viewer.js';
 *   const viewer = new FloorPlanViewer(document.getElementById('viewer-container'));
 *   viewer.loadSpatialData(analysis.spatial);
 *   viewer.setTradeOverlay('electrical', analysis.tradeOverlays.electrical);
 *
 * Requires Three.js loaded globally (window.THREE) or via import map.
 */

// ==========================================
// Room type → color mapping
// ==========================================

const ROOM_COLORS = {
  living:    0x4ade80,  // green
  bedroom:   0x60a5fa,  // blue
  bathroom:  0x38bdf8,  // sky
  kitchen:   0xfbbf24,  // amber
  garage:    0x9ca3af,  // gray
  dining:    0xf97316,  // orange
  hallway:   0xd4d4d8,  // zinc
  closet:    0xa1a1aa,  // zinc-dark
  laundry:   0xa78bfa,  // violet
  office:    0x34d399,  // emerald
  utility:   0x6b7280,  // gray-dark
  basement:  0x78716c,  // stone
  default:   0xd1d5db,  // gray-300
};

const WALL_COLORS = {
  exterior:     0x78716c,
  interior:     0xd6d3d1,
  load_bearing: 0xb45309,
  default:      0xa8a29e,
};

const TRADE_COLORS = {
  electrical: 0xfbbf24,  // yellow
  plumbing:   0x3b82f6,  // blue
  hvac:       0x10b981,  // green
  painting:   0xf97316,  // orange
  flooring:   0xa855f7,  // purple
  framing:    0xb45309,  // amber-dark
  roofing:    0xef4444,  // red
  masonry:    0x78716c,  // stone
  sitework:   0x84cc16,  // lime
  drywall:    0xe5e7eb,  // gray-200
};

const OPENING_COLORS = {
  door:        0x059669,  // emerald-600
  window:      0x0ea5e9,  // sky-500
  archway:     0xd97706,  // amber-600
  garage_door: 0x6b7280,  // gray-500
};

/**
 * Interactive 3D floor plan viewer.
 */
export class FloorPlanViewer {
  /**
   * @param {HTMLElement} container - DOM element to render into
   * @param {object} [options]
   * @param {string} [options.backgroundColor='#1a1a2e'] - Scene background
   * @param {boolean} [options.showGrid=true] - Show ground grid
   * @param {boolean} [options.showAxes=false] - Show XYZ axes helper
   * @param {number} [options.wallOpacity=0.85] - Wall material opacity
   * @param {number} [options.floorOpacity=0.6] - Floor material opacity
   */
  constructor(container, options = {}) {
    this.container = container;
    this.options = {
      backgroundColor: options.backgroundColor || '#1a1a2e',
      showGrid: options.showGrid !== false,
      showAxes: options.showAxes || false,
      wallOpacity: options.wallOpacity ?? 0.85,
      floorOpacity: options.floorOpacity ?? 0.6,
    };

    // Three.js reference — must be loaded
    this.THREE = window.THREE;
    if (!this.THREE) throw new Error('Three.js must be loaded before FloorPlanViewer');

    // State
    this.spatialData = null;
    this.tradeOverlays = {};
    this.overlayGroups = {};
    this.elementMap = new Map();  // mesh → element data
    this.selectedElement = null;
    this._clickCallbacks = [];
    this._disposed = false;

    // Init
    this._initScene();
    this._initControls();
    this._initRaycaster();
    this._initTooltip();
    this._animate();
  }

  // ==========================================
  // Public API
  // ==========================================

  /**
   * Load spatial data and render the 3D floor plan.
   * @param {object} spatialData - The `spatial` object from blueprint analysis
   */
  loadSpatialData(spatialData) {
    this.spatialData = spatialData;
    this._clearScene();

    if (!spatialData) return;

    // Render layers
    this._renderFloors(spatialData.rooms || []);
    this._renderWalls(spatialData.walls || [], spatialData.openings || []);
    this._renderOpenings(spatialData.openings || [], spatialData.walls || []);
    this._renderStairs(spatialData.stairs || []);

    // Frame camera to fit the model
    this._fitCameraToScene();
  }

  /**
   * Add a trade-specific overlay (MEP runs, fixtures, etc.)
   * @param {string} trade - Trade name (e.g. 'electrical', 'plumbing')
   * @param {object} data - Trade overlay data from analysis
   */
  setTradeOverlay(trade, data) {
    // Remove existing overlay for this trade
    if (this.overlayGroups[trade]) {
      this.scene.remove(this.overlayGroups[trade]);
      this.overlayGroups[trade] = null;
    }

    if (!data) return;

    this.tradeOverlays[trade] = data;
    const group = new this.THREE.Group();
    group.name = `overlay-${trade}`;

    const color = TRADE_COLORS[trade] || 0xffffff;

    // Generic fixture/point renderer
    const renderPoints = (items, label) => {
      if (!items?.length) return;
      for (const item of items) {
        if (!item.position) continue;
        const [x, y] = item.position;
        const geo = new this.THREE.SphereGeometry(0.3, 8, 8);
        const mat = new this.THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.3 });
        const mesh = new this.THREE.Mesh(geo, mat);
        mesh.position.set(x, 2, y);
        group.add(mesh);
        this.elementMap.set(mesh, { trade, type: label, ...item });
      }
    };

    // Generic line/run renderer
    const renderRuns = (items, label, yHeight = 4) => {
      if (!items?.length) return;
      for (const run of items) {
        if (!run.from || !run.to) continue;
        const points = [
          new this.THREE.Vector3(run.from[0], yHeight, run.from[1]),
          new this.THREE.Vector3(run.to[0], yHeight, run.to[1]),
        ];
        const geo = new this.THREE.BufferGeometry().setFromPoints(points);
        const mat = new this.THREE.LineBasicMaterial({ color, linewidth: 2 });
        const line = new this.THREE.Line(geo, mat);
        group.add(line);
        this.elementMap.set(line, { trade, type: label, ...run });
      }
    };

    // Render trade-specific elements
    switch (trade) {
      case 'electrical':
        renderPoints(data.outlets, 'outlet');
        renderPoints(data.switches, 'switch');
        renderPoints(data.panels, 'panel');
        renderPoints(data.lighting, 'light');
        renderRuns(data.wireRuns, 'wire_run', 7);
        break;
      case 'plumbing':
        renderPoints(data.fixtures, 'fixture');
        renderRuns(data.pipeRuns, 'pipe_run', 1);
        if (data.waterHeater?.position) renderPoints([data.waterHeater], 'water_heater');
        renderPoints(data.cleanouts, 'cleanout');
        break;
      case 'hvac':
        renderPoints(data.registers, 'register');
        renderRuns(data.ductRuns, 'duct_run', 6.5);
        renderPoints(data.equipment, 'equipment');
        break;
      default:
        // Generic: render any arrays with position fields
        for (const [key, val] of Object.entries(data)) {
          if (Array.isArray(val)) renderPoints(val, key);
        }
    }

    this.overlayGroups[trade] = group;
    this.scene.add(group);
  }

  /**
   * Toggle visibility of a trade overlay.
   * @param {string} trade
   * @param {boolean} visible
   */
  toggleOverlay(trade, visible) {
    if (this.overlayGroups[trade]) {
      this.overlayGroups[trade].visible = visible;
    }
  }

  /**
   * Register a callback for element click events.
   * @param {Function} callback - Called with (elementData, mesh)
   */
  onElementClick(callback) {
    this._clickCallbacks.push(callback);
  }

  /**
   * Clean up Three.js resources.
   */
  dispose() {
    this._disposed = true;
    if (this._animFrame) cancelAnimationFrame(this._animFrame);
    if (this.controls) this.controls.dispose();
    if (this.renderer) {
      this.renderer.dispose();
      this.container.removeChild(this.renderer.domElement);
    }
    if (this._tooltip) this._tooltip.remove();
    this.container.removeEventListener('click', this._onClick);
    this.container.removeEventListener('mousemove', this._onMouseMove);
    window.removeEventListener('resize', this._onResize);
  }

  // ==========================================
  // Scene Setup
  // ==========================================

  _initScene() {
    const T = this.THREE;
    const w = this.container.clientWidth;
    const h = this.container.clientHeight || 500;

    // Scene
    this.scene = new T.Scene();
    this.scene.background = new T.Color(this.options.backgroundColor);

    // Camera
    this.camera = new T.PerspectiveCamera(50, w / h, 0.1, 1000);
    this.camera.position.set(30, 40, 30);
    this.camera.lookAt(0, 0, 0);

    // Renderer
    this.renderer = new T.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = T.PCFSoftShadowMap;
    this.container.appendChild(this.renderer.domElement);

    // Lighting
    const ambient = new T.AmbientLight(0xffffff, 0.6);
    this.scene.add(ambient);

    const directional = new T.DirectionalLight(0xffffff, 0.8);
    directional.position.set(30, 50, 20);
    directional.castShadow = true;
    directional.shadow.mapSize.width = 2048;
    directional.shadow.mapSize.height = 2048;
    this.scene.add(directional);

    const fill = new T.DirectionalLight(0x8888ff, 0.3);
    fill.position.set(-20, 30, -10);
    this.scene.add(fill);

    // Grid
    if (this.options.showGrid) {
      const grid = new T.GridHelper(100, 100, 0x444466, 0x333355);
      grid.position.y = -0.01;
      this.scene.add(grid);
    }

    if (this.options.showAxes) {
      this.scene.add(new T.AxesHelper(10));
    }

    // Resize handler
    this._onResize = () => {
      const w = this.container.clientWidth;
      const h = this.container.clientHeight || 500;
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h);
    };
    window.addEventListener('resize', this._onResize);
  }

  _initControls() {
    // OrbitControls must be available via THREE.OrbitControls or imported
    const OrbitControls = this.THREE.OrbitControls || window.OrbitControls;
    if (OrbitControls) {
      this.controls = new OrbitControls(this.camera, this.renderer.domElement);
      this.controls.enableDamping = true;
      this.controls.dampingFactor = 0.08;
      this.controls.minDistance = 5;
      this.controls.maxDistance = 200;
      this.controls.maxPolarAngle = Math.PI / 2.05;  // Prevent going underground
    }
  }

  _initRaycaster() {
    const T = this.THREE;
    this.raycaster = new T.Raycaster();
    this.mouse = new T.Vector2();
    this._hoveredMesh = null;

    this._onClick = (event) => {
      const rect = this.renderer.domElement.getBoundingClientRect();
      this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

      this.raycaster.setFromCamera(this.mouse, this.camera);
      const intersects = this.raycaster.intersectObjects(this.scene.children, true);

      // Find first clickable element
      for (const hit of intersects) {
        const data = this.elementMap.get(hit.object);
        if (data) {
          this._selectElement(hit.object, data);
          return;
        }
      }
      this._deselectElement();
    };

    this._onMouseMove = (event) => {
      const rect = this.renderer.domElement.getBoundingClientRect();
      this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

      this.raycaster.setFromCamera(this.mouse, this.camera);
      const intersects = this.raycaster.intersectObjects(this.scene.children, true);

      let found = null;
      for (const hit of intersects) {
        if (this.elementMap.has(hit.object)) {
          found = hit.object;
          break;
        }
      }

      if (found !== this._hoveredMesh) {
        this.renderer.domElement.style.cursor = found ? 'pointer' : 'default';
        this._hoveredMesh = found;
      }
    };

    this.container.addEventListener('click', this._onClick);
    this.container.addEventListener('mousemove', this._onMouseMove);
  }

  _initTooltip() {
    this._tooltip = document.createElement('div');
    this._tooltip.className = 'fpv-tooltip';
    this._tooltip.style.display = 'none';
    this.container.style.position = 'relative';
    this.container.appendChild(this._tooltip);
  }

  // ==========================================
  // Rendering
  // ==========================================

  _renderFloors(rooms) {
    const T = this.THREE;
    for (const room of rooms) {
      if (!room.polygon?.length || room.polygon.length < 3) continue;

      const shape = new T.Shape();
      shape.moveTo(room.polygon[0][0], room.polygon[0][1]);
      for (let i = 1; i < room.polygon.length; i++) {
        shape.lineTo(room.polygon[i][0], room.polygon[i][1]);
      }
      shape.closePath();

      const color = ROOM_COLORS[room.type] || ROOM_COLORS.default;
      const geo = new T.ShapeGeometry(shape);
      const mat = new T.MeshStandardMaterial({
        color,
        transparent: true,
        opacity: this.options.floorOpacity,
        side: T.DoubleSide,
      });

      const mesh = new T.Mesh(geo, mat);
      mesh.rotation.x = -Math.PI / 2;  // Lay flat on XZ plane
      mesh.position.y = 0.01;
      mesh.receiveShadow = true;
      this.scene.add(mesh);

      this.elementMap.set(mesh, {
        type: 'room',
        id: room.id,
        name: room.name,
        roomType: room.type,
        areaSqFt: room.areaSqFt,
        ceilingHeight: room.ceilingHeight,
        confidence: room.confidence,
      });

      // Room label (floating text)
      if (room.name) {
        const center = this._polygonCenter(room.polygon);
        const labelSprite = this._createLabel(
          room.name,
          new T.Vector3(center[0], 0.5, center[1]),
          color
        );
        this.scene.add(labelSprite);
      }
    }
  }

  _renderWalls(walls, openings) {
    const T = this.THREE;

    for (const wall of walls) {
      if (!wall.start || !wall.end) continue;

      const [x1, z1] = wall.start;
      const [x2, z2] = wall.end;
      const height = wall.height || 8;
      const thickness = wall.thickness || 0.5;

      // Calculate wall length, direction, and angle
      const dx = x2 - x1;
      const dz = z2 - z1;
      const length = Math.sqrt(dx * dx + dz * dz);
      const angle = Math.atan2(dz, dx);

      if (length < 0.1) continue;

      // Get openings for this wall
      const wallOpenings = openings.filter((o) => o.wallId === wall.id);

      // Create wall shape with opening holes
      const shape = new T.Shape();
      shape.moveTo(0, 0);
      shape.lineTo(length, 0);
      shape.lineTo(length, height);
      shape.lineTo(0, height);
      shape.closePath();

      // Cut holes for openings
      for (const opening of wallOpenings) {
        const pos = opening.position - opening.width / 2;
        const sill = opening.sillHeight || (opening.type === 'window' ? 2.5 : 0);
        const oHeight = opening.height || (opening.type === 'window' ? 4 : 6.8);

        const hole = new T.Path();
        hole.moveTo(pos, sill);
        hole.lineTo(pos + opening.width, sill);
        hole.lineTo(pos + opening.width, sill + oHeight);
        hole.lineTo(pos, sill + oHeight);
        hole.closePath();
        shape.holes.push(hole);
      }

      const extrudeSettings = { depth: thickness, bevelEnabled: false };
      const geo = new T.ExtrudeGeometry(shape, extrudeSettings);

      const wallColor = WALL_COLORS[wall.type] || WALL_COLORS.default;
      const mat = new T.MeshStandardMaterial({
        color: wallColor,
        transparent: true,
        opacity: this.options.wallOpacity,
        side: T.DoubleSide,
      });

      const mesh = new T.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;

      // Position: rotate around origin then translate
      mesh.position.set(x1, 0, z1);
      mesh.rotation.y = -angle;
      // Rotate the extruded face to be vertical
      mesh.rotation.x = -Math.PI / 2;
      // Adjust: the extrude goes along Z in local space, we need it along Y
      // Actually ExtrudeGeometry extrudes along Z, so we need to orient properly
      mesh.rotation.set(0, 0, 0);

      // Better approach: transform the geometry directly
      mesh.geometry.dispose();
      const wallMesh = this._createWallMesh(x1, z1, x2, z2, height, thickness, shape, wallColor);
      this.scene.add(wallMesh);
      this.elementMap.set(wallMesh, {
        type: 'wall',
        id: wall.id,
        wallType: wall.type,
        length: length.toFixed(1),
        height,
        thickness,
        confidence: wall.confidence,
      });

      mesh.geometry.dispose();
      mat.dispose();
    }
  }

  _createWallMesh(x1, z1, x2, z2, height, thickness, shape, color) {
    const T = this.THREE;

    const dx = x2 - x1;
    const dz = z2 - z1;
    const angle = Math.atan2(dz, dx);

    const extrudeSettings = { depth: thickness, bevelEnabled: false };
    const geo = new T.ExtrudeGeometry(shape, extrudeSettings);

    const mat = new T.MeshStandardMaterial({
      color,
      transparent: true,
      opacity: this.options.wallOpacity,
      side: T.DoubleSide,
    });

    const mesh = new T.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    // The shape is in 2D (x = along wall, y = height)
    // ExtrudeGeometry extrudes along +Z (depth = thickness)
    // We need to: rotate so the wall face is vertical, then position + rotate to match wall direction

    // Step 1: Rotate so the wall is vertical (shape XY plane → world XY plane, extrude along Z → world depth)
    // Default: shape face on XY plane, extrude along Z — this gives us a horizontal slab
    // We want: shape face vertical, looking out along the wall's perpendicular

    mesh.rotation.x = -Math.PI / 2;  // Stand it up vertically
    mesh.rotation.z = angle;  // Rotate to match wall direction (in the now-rotated space)

    // Step 2: Position at wall start, offset by half thickness along perpendicular
    const perpX = -Math.sin(angle) * thickness / 2;
    const perpZ = Math.cos(angle) * thickness / 2;
    mesh.position.set(x1 + perpX, 0, z1 + perpZ);

    return mesh;
  }

  _renderOpenings(openings, walls) {
    const T = this.THREE;

    for (const opening of openings) {
      const wall = walls.find((w) => w.id === opening.wallId);
      if (!wall) continue;

      const [x1, z1] = wall.start;
      const [x2, z2] = wall.end;
      const dx = x2 - x1;
      const dz = z2 - z1;
      const length = Math.sqrt(dx * dx + dz * dz);
      const angle = Math.atan2(dz, dx);

      if (length < 0.1) continue;

      // Position along the wall
      const t = opening.position / length;
      const ox = x1 + dx * t;
      const oz = z1 + dz * t;

      const sill = opening.sillHeight || (opening.type === 'window' ? 2.5 : 0);
      const oHeight = opening.height || (opening.type === 'window' ? 4 : 6.8);

      // Visual marker for the opening
      const color = OPENING_COLORS[opening.type] || 0x22c55e;
      const geo = new T.BoxGeometry(opening.width, oHeight, 0.15);
      const mat = new T.MeshStandardMaterial({
        color,
        transparent: true,
        opacity: 0.5,
        emissive: color,
        emissiveIntensity: 0.2,
      });

      const mesh = new T.Mesh(geo, mat);
      mesh.position.set(ox, sill + oHeight / 2, oz);
      mesh.rotation.y = -angle + Math.PI / 2;
      this.scene.add(mesh);

      this.elementMap.set(mesh, {
        type: 'opening',
        id: opening.id,
        openingType: opening.type,
        subtype: opening.subtype,
        width: opening.width,
        height: oHeight,
        confidence: opening.confidence,
      });
    }
  }

  _renderStairs(stairs) {
    const T = this.THREE;

    for (const stair of stairs) {
      if (!stair.position) continue;
      const [x, z] = stair.position;
      const width = stair.width || 3;

      // Simple stair visualization as stepped boxes
      const steps = 12;
      const riserHeight = 7.5 / 12;  // ~7.5" per step in feet
      const treadDepth = 10 / 12;    // ~10" per step in feet

      for (let i = 0; i < steps; i++) {
        const geo = new T.BoxGeometry(width, riserHeight, treadDepth);
        const mat = new T.MeshStandardMaterial({ color: 0xb8860b, transparent: true, opacity: 0.7 });
        const mesh = new T.Mesh(geo, mat);
        mesh.position.set(x, riserHeight * i + riserHeight / 2, z + treadDepth * i);
        mesh.castShadow = true;
        this.scene.add(mesh);
      }
    }
  }

  // ==========================================
  // Helpers
  // ==========================================

  _clearScene() {
    // Remove all children except lights and grid
    const keep = new Set();
    this.scene.children.forEach((child) => {
      if (child.isLight || child.isGridHelper || child.isAxesHelper) keep.add(child);
    });
    const toRemove = this.scene.children.filter((c) => !keep.has(c));
    for (const obj of toRemove) {
      this.scene.remove(obj);
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
        else obj.material.dispose();
      }
    }
    this.elementMap.clear();
    this.overlayGroups = {};
  }

  _fitCameraToScene() {
    const T = this.THREE;
    const box = new T.Box3().setFromObject(this.scene);
    if (box.isEmpty()) return;

    const center = box.getCenter(new T.Vector3());
    const size = box.getSize(new T.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const distance = maxDim * 1.5;

    this.camera.position.set(center.x + distance * 0.6, distance * 0.8, center.z + distance * 0.6);
    this.camera.lookAt(center);

    if (this.controls) {
      this.controls.target.copy(center);
      this.controls.update();
    }
  }

  _polygonCenter(polygon) {
    let cx = 0, cy = 0;
    for (const [x, y] of polygon) { cx += x; cy += y; }
    return [cx / polygon.length, cy / polygon.length];
  }

  _createLabel(text, position, color) {
    const T = this.THREE;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    canvas.width = 256;
    canvas.height = 64;

    ctx.fillStyle = 'transparent';
    ctx.fillRect(0, 0, 256, 64);

    ctx.font = 'bold 24px Inter, system-ui, sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0,0,0,0.7)';
    ctx.shadowBlur = 4;
    ctx.fillText(text, 128, 32);

    const texture = new T.CanvasTexture(canvas);
    const mat = new T.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
    const sprite = new T.Sprite(mat);
    sprite.position.copy(position);
    sprite.scale.set(4, 1, 1);

    return sprite;
  }

  _selectElement(mesh, data) {
    this._deselectElement();
    this.selectedElement = { mesh, data };

    // Highlight
    if (mesh.material) {
      mesh._origEmissive = mesh.material.emissive?.getHex?.();
      mesh._origEmissiveIntensity = mesh.material.emissiveIntensity;
      if (mesh.material.emissive) {
        mesh.material.emissive.setHex(0x00ff88);
        mesh.material.emissiveIntensity = 0.5;
      }
    }

    // Show tooltip
    this._showTooltip(data);

    // Fire callbacks
    for (const cb of this._clickCallbacks) cb(data, mesh);
  }

  _deselectElement() {
    if (this.selectedElement) {
      const { mesh } = this.selectedElement;
      if (mesh.material?.emissive) {
        mesh.material.emissive.setHex(mesh._origEmissive || 0x000000);
        mesh.material.emissiveIntensity = mesh._origEmissiveIntensity || 0;
      }
      this.selectedElement = null;
    }
    this._hideTooltip();
  }

  _showTooltip(data) {
    if (!this._tooltip) return;

    const lines = [];
    if (data.name) lines.push(`<strong>${data.name}</strong>`);
    lines.push(`<span class="fpv-tooltip-type">${data.type}${data.roomType ? ` (${data.roomType})` : ''}${data.wallType ? ` (${data.wallType})` : ''}${data.openingType ? ` (${data.openingType})` : ''}</span>`);

    if (data.areaSqFt) lines.push(`Area: ${data.areaSqFt} sq ft`);
    if (data.length) lines.push(`Length: ${data.length} ft`);
    if (data.height) lines.push(`Height: ${data.height} ft`);
    if (data.width) lines.push(`Width: ${data.width} ft`);
    if (data.trade) lines.push(`Trade: ${data.trade}`);

    if (data.confidence != null) {
      const pct = Math.round(data.confidence * 100);
      const level = pct >= 80 ? 'high' : pct >= 50 ? 'medium' : 'low';
      lines.push(`<span class="fpv-tooltip-confidence fpv-confidence-${level}">Confidence: ${pct}%</span>`);
    }

    this._tooltip.innerHTML = lines.join('<br>');
    this._tooltip.style.display = 'block';
  }

  _hideTooltip() {
    if (this._tooltip) this._tooltip.style.display = 'none';
  }

  // ==========================================
  // Animation Loop
  // ==========================================

  _animate() {
    if (this._disposed) return;
    this._animFrame = requestAnimationFrame(() => this._animate());
    if (this.controls) this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}

export default FloorPlanViewer;
