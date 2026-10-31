/**
 * PhysCaP: Grounding Code-as-Policy Agent with Physics-Informed Exploration
 * 
 * Implements arXiv: 2608.21031 (PhysCaP)
 * Provides physics-informed spatial grounding and code-as-policy generation
 * for physical AI agents interacting with real-world infrastructure and construction environments.
 */

export const PHYSICAL_CODES_AND_LIMITS = {
  // Plumbing DWV (Drain-Waste-Vent)
  MIN_DRAIN_SLOPE_INCHES_PER_FT: 0.25, // 1/4" per foot minimum slope for <= 2" pipes (UPC / IPC)
  MIN_CLEANOUT_CLEARANCE_INCHES: 18.0,

  // Structural Framing (IRC R502.8 / IBC)
  MAX_JOIST_NOTCH_RATIO: 1 / 6, // Notch depth cannot exceed 1/6 of joist depth
  MAX_JOIST_BORE_RATIO: 1 / 3,  // Hole diameter cannot exceed 1/3 of joist depth
  MIN_BORE_EDGE_DISTANCE_INCHES: 2.0, // Hole must be at least 2 inches from top/bottom edge

  // Electrical (NEC)
  MAX_CONDUIT_FILL_PERCENT: 40, // Max 40% fill for 3+ conductors
  WIRE_AMPACITY: {
    14: 15, // 14 AWG -> 15 Amps
    12: 20, // 12 AWG -> 20 Amps
    10: 30, // 10 AWG -> 30 Amps
    8: 40,
    6: 55
  }
};

export class PhysicsConstraintEvaluator {
  /**
   * Evaluate a proposed pipe routing for hydraulic compliance
   * @param {object} pipeRoute - { runLengthFt, verticalDropInches, pipeDiameterInches }
   * @returns {{ compliant: boolean, actualSlope: number, minRequiredSlope: number, violation: string|null }}
   */
  static evaluateDrainSlope({ runLengthFt, verticalDropInches, pipeDiameterInches = 2 }) {
    if (!runLengthFt || runLengthFt <= 0) {
      return { compliant: false, actualSlope: 0, minRequiredSlope: 0.25, violation: "Run length must be greater than 0" };
    }

    const actualSlope = verticalDropInches / runLengthFt;
    const minRequiredSlope = pipeDiameterInches >= 3 ? 0.125 : PHYSICAL_CODES_AND_LIMITS.MIN_DRAIN_SLOPE_INCHES_PER_FT;
    const compliant = actualSlope >= minRequiredSlope;

    return {
      compliant,
      actualSlope: parseFloat(actualSlope.toFixed(3)),
      minRequiredSlope,
      violation: compliant ? null : `Insufficient drainage slope: ${actualSlope.toFixed(3)} in/ft is below required ${minRequiredSlope} in/ft (standing water risk).`
    };
  }

  /**
   * Evaluate a proposed joist/stud boring penetration
   * @param {object} penetration - { joistDepthInches, holeDiameterInches, edgeDistanceInches }
   * @returns {{ compliant: boolean, maxAllowedHole: number, violation: string|null }}
   */
  static evaluateStructuralPenetration({ joistDepthInches, holeDiameterInches, edgeDistanceInches }) {
    const maxAllowedHole = joistDepthInches * PHYSICAL_CODES_AND_LIMITS.MAX_JOIST_BORE_RATIO;
    const minAllowedEdge = PHYSICAL_CODES_AND_LIMITS.MIN_BORE_EDGE_DISTANCE_INCHES;

    const holeCompliant = holeDiameterInches <= maxAllowedHole;
    const edgeCompliant = edgeDistanceInches >= minAllowedEdge;
    const compliant = holeCompliant && edgeCompliant;

    let violation = null;
    if (!holeCompliant) {
      violation = `Hole diameter ${holeDiameterInches}" exceeds structural limit of ${maxAllowedHole.toFixed(2)}" (1/3 of ${joistDepthInches}" joist).`;
    } else if (!edgeCompliant) {
      violation = `Hole is too close to edge (${edgeDistanceInches}" < ${minAllowedEdge}" minimum clearance).`;
    }

    return {
      compliant,
      maxAllowedHole: parseFloat(maxAllowedHole.toFixed(2)),
      minAllowedEdge,
      violation
    };
  }

  /**
   * Evaluate electrical wire gauge vs circuit breaker rating
   * @param {object} circuit - { wireGauge, breakerAmps }
   * @returns {{ compliant: boolean, maxAmps: number, violation: string|null }}
   */
  static evaluateCircuitWireGauge({ wireGauge, breakerAmps }) {
    const key = String(wireGauge);
    const maxAmps = PHYSICAL_CODES_AND_LIMITS.WIRE_AMPACITY[key] || PHYSICAL_CODES_AND_LIMITS.WIRE_AMPACITY[Number(key)] || 0;
    const compliant = maxAmps >= breakerAmps;

    return {
      compliant,
      maxAmps,
      violation: compliant ? null : `Wire gauge ${wireGauge} AWG is rated for max ${maxAmps}A, but breaker is ${breakerAmps}A (fire hazard).`
    };
  }
}

export class PhysCaPPolicyGenerator {
  constructor(options = {}) {
    this.robotId = options.robotId || 'physcap-trade-bot';
    this.enforceStrictPhysics = options.enforceStrictPhysics !== false;
  }

  /**
   * Synthesize an executable Code-as-Policy script with embedded physics validations
   * @param {string} taskIntent - e.g. "Install 15ft PEX drainage run from kitchen sink"
   * @param {object} spatialContext - { runLengthFt, verticalDropInches, joistDepthInches, holeDiameterInches, edgeDistanceInches }
   * @returns {{ policyScript: string, verification: object, isSafeToExecute: boolean }}
   */
  generatePolicy(taskIntent, spatialContext) {
    const validations = [];

    // 1. Drain slope evaluation
    if (spatialContext.runLengthFt && spatialContext.verticalDropInches !== undefined) {
      const slopeEval = PhysicsConstraintEvaluator.evaluateDrainSlope(spatialContext);
      validations.push({ check: 'Drainage Slope (Hydraulics)', ...slopeEval });
    }

    // 2. Structural penetration evaluation
    if (spatialContext.joistDepthInches && spatialContext.holeDiameterInches) {
      const structEval = PhysicsConstraintEvaluator.evaluateStructuralPenetration(spatialContext);
      validations.push({ check: 'Structural Joist Penetration (IRC R502.8)', ...structEval });
    }

    // 3. Electrical gauge evaluation
    if (spatialContext.wireGauge && spatialContext.breakerAmps) {
      const elecEval = PhysicsConstraintEvaluator.evaluateCircuitWireGauge(spatialContext);
      validations.push({ check: 'Wire Ampacity & Gauge (NEC)', ...elecEval });
    }

    const isSafeToExecute = validations.every(v => v.compliant);
    const violations = validations.filter(v => !v.compliant).map(v => v.violation);

    // Formulate executable code-as-policy representation
    const policyScript = `
// 🤖 Auto-Generated PhysCaP Policy for: ${taskIntent}
// Generated At: ${new Date().toISOString()}

export async function executePhysicalAction(robot) {
  const isSafe = ${isSafeToExecute};
  if (!isSafe) {
    throw new Error("PhysCaP Safety Abort: Physical code constraints violated: ${violations.join('; ')}");
  }

  console.log("🚀 Executing grounded physical action: ${taskIntent}");
  // Policy actions:
  await robot.alignToolhead({ x: ${spatialContext.x || 0}, y: ${spatialContext.y || 0}, z: ${spatialContext.z || 0} });
  await robot.executeMotionTrajectory({
    runLengthFt: ${spatialContext.runLengthFt || 0},
    verticalDropInches: ${spatialContext.verticalDropInches || 0}
  });
  return { status: "SUCCESS", task: "${taskIntent}" };
}
`.trim();

    return {
      taskIntent,
      policyScript,
      validations,
      isSafeToExecute,
      violations
    };
  }
}

/**
 * Factory helper
 */
export function createPhysCaPGenerator(options = {}) {
  return new PhysCaPPolicyGenerator(options);
}
