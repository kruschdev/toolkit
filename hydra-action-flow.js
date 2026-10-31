/**
 * Hydra-0: Action Flow for Generalist World Modeling and Control
 * 
 * Implements arXiv: 2608.18077 (Hydra-0)
 * Represents physical robot/agent actions as pixel displacement vectors ('Action Flow')
 * enabling shared visual interfaces across embodiments, tasks, and environments.
 * 
 * Includes:
 * 1. Forward Mode: State + Action Flow -> Predicted Future State
 * 2. Emergent Inverse Mode: Human Demonstration Flow -> Robotic Action Flow
 */

export class ActionFlowVector {
  /**
   * @param {object} params
   * @param {number} params.x - Start X position (normalized 0-1000 or px)
   * @param {number} params.y - Start Y position (normalized 0-1000 or px)
   * @param {number} params.dx - Pixel displacement vector in X
   * @param {number} params.dy - Pixel displacement vector in Y
   * @param {number} [params.dz=0] - Depth / Z displacement
   * @param {number} [params.t=0] - Temporal timestep or frame index
   * @param {string} [params.actionType='manipulate'] - 'route_pipe' | 'fasten_stud' | 'pull_wire' | 'inspect' | 'manipulate'
   * @param {number} [params.confidence=1.0] - Confidence score
   */
  constructor({ x, y, dx, dy, dz = 0, t = 0, actionType = 'manipulate', confidence = 1.0 }) {
    this.x = x;
    this.y = y;
    this.dx = dx;
    this.dy = dy;
    this.dz = dz;
    this.t = t;
    this.actionType = actionType;
    this.confidence = confidence;
  }

  get magnitude() {
    return Math.sqrt(this.dx * this.dx + this.dy * this.dy + this.dz * this.dz);
  }

  get endPoint() {
    return {
      x: this.x + this.dx,
      y: this.y + this.dy,
      z: (this.z || 0) + this.dz
    };
  }
}

export class ActionFlowSequence {
  constructor(sequenceId = `flow-${Date.now()}`) {
    this.sequenceId = sequenceId;
    this.vectors = []; // Array<ActionFlowVector>
    this.metadata = {};
  }

  addVector(vec) {
    const v = vec instanceof ActionFlowVector ? vec : new ActionFlowVector(vec);
    this.vectors.push(v);
    return v;
  }

  addVectors(vecs) {
    if (Array.isArray(vecs)) {
      for (const v of vecs) this.addVector(v);
    }
    return this.vectors;
  }

  /**
   * Get total motion displacement
   */
  getTotalDisplacement() {
    let totalDx = 0;
    let totalDy = 0;
    let totalDz = 0;
    for (const v of this.vectors) {
      totalDx += v.dx;
      totalDy += v.dy;
      totalDz += v.dz;
    }
    return { totalDx, totalDy, totalDz, vectorCount: this.vectors.length };
  }

  /**
   * Filter vectors by timestep
   */
  getVectorsAtTime(t) {
    return this.vectors.filter(v => v.t === t);
  }
}

export class HydraWorldModelEngine {
  constructor(options = {}) {
    this.embodiment = options.embodiment || 'generalist-robot';
    this.resolution = options.resolution || { width: 1000, height: 1000 };
  }

  /**
   * Forward Mode: Predicts future scene state given initial state and action flow sequence
   * @param {object} initialState - Initial spatial/visual entity state { entities: [{ id, x, y, z }] }
   * @param {ActionFlowSequence} actionFlow - Planned action flow vectors
   * @returns {object} Predicted future scene state
   */
  predictForward(initialState, actionFlow) {
    if (!initialState || !Array.isArray(initialState.entities)) {
      throw new Error("Hydra predictForward: initialState must contain entities array");
    }

    const predictedEntities = initialState.entities.map(e => ({ ...e }));
    const vectors = actionFlow instanceof ActionFlowSequence ? actionFlow.vectors : actionFlow;

    // Apply action flow displacements to nearest target entities
    for (const vec of vectors) {
      // Find matching entity nearest to vector origin
      let nearest = null;
      let minDistance = Infinity;

      for (const entity of predictedEntities) {
        const dist = Math.hypot(entity.x - vec.x, entity.y - vec.y);
        if (dist < minDistance) {
          minDistance = dist;
          nearest = entity;
        }
      }

      // If within interaction radius, displace entity according to action flow
      if (nearest && minDistance < 200) {
        nearest.x += vec.dx;
        nearest.y += vec.dy;
        nearest.z = (nearest.z || 0) + vec.dz;
        nearest.lastAction = vec.actionType;
      }
    }

    return {
      timestep: (initialState.timestep || 0) + 1,
      entities: predictedEntities,
      appliedFlows: vectors.length
    };
  }

  /**
   * Emergent Inverse Mode (Demonstration-to-Policy):
   * Given an observed human demonstration sequence or goal displacement,
   * extracts the compatible robotic action flow without task-specific expert training data.
   * 
   * @param {object} demonstration - { startFrameState: { entities: [] }, targetFrameState: { entities: [] }, demoClip: string }
   * @returns {ActionFlowSequence} Extracted robotic action flow sequence
   */
  extractInverseActionFlow(demonstration) {
    const { startFrameState, targetFrameState, demoClip = 'human_demo.mp4' } = demonstration;
    const flowSeq = new ActionFlowSequence(`inverse-flow-${Date.now()}`);
    flowSeq.metadata = { demoClip, extractedAt: new Date().toISOString() };

    if (!startFrameState?.entities || !targetFrameState?.entities) {
      return flowSeq;
    }

    const startMap = new Map(startFrameState.entities.map(e => [e.id, e]));

    for (const targetEnt of targetFrameState.entities) {
      const startEnt = startMap.get(targetEnt.id);
      if (startEnt) {
        const dx = targetEnt.x - startEnt.x;
        const dy = targetEnt.y - startEnt.y;
        const dz = (targetEnt.z || 0) - (startEnt.z || 0);

        // If significant motion occurred, create an action flow vector
        if (Math.hypot(dx, dy, dz) > 1.0) {
          flowSeq.addVector(new ActionFlowVector({
            x: startEnt.x,
            y: startEnt.y,
            dx,
            dy,
            dz,
            t: 0,
            actionType: targetEnt.actionType || startEnt.type || 'manipulate',
            confidence: 0.95
          }));
        }
      }
    }

    return flowSeq;
  }
}

/**
 * Factory helper
 */
export function createHydraEngine(options = {}) {
  return new HydraWorldModelEngine(options);
}
