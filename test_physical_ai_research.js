/**
 * @file test_physical_ai_research.js
 * @description Comprehensive automated test suite for today's physical AI research modules:
 * - Hydra-0: Action Flow World Modeling & Inverse Control (arXiv: 2608.18077)
 * - SparsePR: Block-Sparse Video Attention & Token Partitioning (arXiv: 2608.18484)
 * - PhysCaP: Physics-Informed Spatial Grounding & Code-as-Policy (arXiv: 2608.21031)
 */

import assert from 'node:assert';
import {
  HydraWorldModelEngine,
  ActionFlowVector,
  ActionFlowSequence,
  createHydraEngine,
  SparsePROptimizer,
  VideoTokenBlock,
  createSparsePROptimizer,
  PhysicsConstraintEvaluator,
  PhysCaPPolicyGenerator,
  createPhysCaPGenerator
} from './index.js';

async function runTests() {
  console.log("🚀 Starting Physical AI & Video Attention Test Suite...\n");

  // ==========================================
  // 1. Hydra-0: Action Flow World Modeling Tests
  // ==========================================
  console.log("--- 1. Testing Hydra-0 Action Flow Engine (arXiv: 2608.18077) ---");

  const hydra = createHydraEngine({ embodiment: 'pipe-routing-robot' });

  // 1.1 Action Flow Vector & Sequence
  const seq = new ActionFlowSequence('test-routing-flow');
  seq.addVector(new ActionFlowVector({ x: 100, y: 200, dx: 50, dy: 10, dz: -5, actionType: 'route_pipe' }));
  seq.addVector(new ActionFlowVector({ x: 150, y: 210, dx: 60, dy: 15, dz: -5, actionType: 'route_pipe' }));

  const disp = seq.getTotalDisplacement();
  assert.strictEqual(disp.totalDx, 110, "Total Dx should sum to 110");
  assert.strictEqual(disp.totalDy, 25, "Total Dy should sum to 25");
  assert.strictEqual(disp.vectorCount, 2);
  console.log(`✔ ActionFlowSequence: Created 2 flow vectors (Total Dx: ${disp.totalDx}px, Dy: ${disp.totalDy}px)`);

  // 1.2 Forward Prediction
  const initialState = {
    timestep: 0,
    entities: [
      { id: 'pex_pipe_section_1', x: 105, y: 202, z: 0, type: 'fixture' },
      { id: 'stud_wall_anchor', x: 800, y: 800, z: 0, type: 'structural' }
    ]
  };

  const forwardResult = hydra.predictForward(initialState, seq);
  assert.strictEqual(forwardResult.timestep, 1);
  const updatedPipe = forwardResult.entities.find(e => e.id === 'pex_pipe_section_1');
  assert.strictEqual(updatedPipe.x, 215, "Pipe X should displace cumulatively by +110px (105 + 50 + 60 = 215)");
  assert.strictEqual(updatedPipe.y, 227, "Pipe Y should displace cumulatively by +25px (202 + 10 + 15 = 227)");
  assert.strictEqual(updatedPipe.lastAction, 'route_pipe');
  console.log(`✔ Hydra Forward Mode: Predicted spatial state transition for pipe entity (New Pos: [${updatedPipe.x}, ${updatedPipe.y}])`);

  // 1.3 Emergent Inverse Mode (Human Demonstration -> Robot Action Flow)
  const humanDemonstration = {
    demoClip: 'master_plumber_roughin_demo.mp4',
    startFrameState: {
      entities: [
        { id: 'copper_stubout', x: 200, y: 300, z: 10, type: 'plumbing' },
        { id: 'p_trap_assembly', x: 400, y: 500, z: 20, type: 'drain' }
      ]
    },
    targetFrameState: {
      entities: [
        { id: 'copper_stubout', x: 200, y: 300, z: 10, type: 'plumbing' }, // stationary
        { id: 'p_trap_assembly', x: 450, y: 530, z: 15, actionType: 'fasten_ptrap' } // moved during demo
      ]
    }
  };

  const inverseFlow = hydra.extractInverseActionFlow(humanDemonstration);
  assert.strictEqual(inverseFlow.vectors.length, 1, "Only displaced entity should generate action flow");
  assert.strictEqual(inverseFlow.vectors[0].dx, 50);
  assert.strictEqual(inverseFlow.vectors[0].dy, 30);
  assert.strictEqual(inverseFlow.vectors[0].actionType, 'fasten_ptrap');
  console.log(`✔ Hydra Inverse Mode: Successfully derived robot action flow from human demo without expert training data`);


  // ==========================================
  // 2. SparsePR: Block-Sparse Video Attention Tests
  // ==========================================
  console.log("\n--- 2. Testing SparsePR Block-Sparse Video Attention (arXiv: 2608.18484) ---");

  const sparsePR = createSparsePROptimizer({ targetSparsity: 0.60, residualWeight: 0.85 });

  // Create mock video token blocks (mixture of high-salience fixture blocks and background drywall)
  const queryEmbed = [1.0, 0.5, 0.0, 0.0];
  const tokenBlocks = [
    new VideoTokenBlock({ blockId: 'b1_pipe_joint', frameIndex: 1, spatialCoords: [100, 100, 16, 16], embedding: [0.95, 0.48, 0.0, 0.0] }), // Highly salient
    new VideoTokenBlock({ blockId: 'b2_fitting', frameIndex: 1, spatialCoords: [120, 100, 16, 16], embedding: [0.90, 0.45, 0.01, 0.0] }),   // Highly salient
    new VideoTokenBlock({ blockId: 'b3_drywall_1', frameIndex: 1, spatialCoords: [0, 0, 16, 16], embedding: [0.05, 0.02, 0.90, 0.80] }),    // Background
    new VideoTokenBlock({ blockId: 'b4_drywall_2', frameIndex: 1, spatialCoords: [16, 0, 16, 16], embedding: [0.04, 0.01, 0.92, 0.81] }),   // Background
    new VideoTokenBlock({ blockId: 'b5_floor_slab', frameIndex: 1, spatialCoords: [0, 500, 16, 16], embedding: [0.10, 0.05, 0.85, 0.70] })   // Background
  ];

  const sparseResult = sparsePR.executePipeline(tokenBlocks, queryEmbed);
  assert.strictEqual(sparseResult.originalBlockCount, 5);
  assert.strictEqual(sparseResult.retainedBlockCount, 2, "Should retain top 2 dense anchor blocks (40% support)");
  assert.strictEqual(sparseResult.prunedBlockCount, 3, "Should prune 3 background blocks");
  assert.strictEqual(sparseResult.denseSupportBlocks[0].blockId, 'b1_pipe_joint');
  assert.ok(sparseResult.residualBiasVector.length === 4, "Residual probe bias vector must match embedding dim");
  assert.ok(sparseResult.reconstructedEnergy > 0, "Reconstructed energy must be positive");
  console.log(`✔ SparsePR: Pruned 5 -> ${sparseResult.retainedBlockCount} blocks (${sparseResult.effectiveSparsity}% sparsity, ${sparseResult.estimatedSpeedup} speedup)`);


  // ==========================================
  // 3. PhysCaP: Physics-Informed Code-as-Policy Tests
  // ==========================================
  console.log("\n--- 3. Testing PhysCaP Physics-Informed Spatial Grounding (arXiv: 2608.21031) ---");

  // 3.1 Hydraulic Drainage Slope Checks
  const goodSlope = PhysicsConstraintEvaluator.evaluateDrainSlope({ runLengthFt: 10, verticalDropInches: 2.5, pipeDiameterInches: 2 });
  assert.strictEqual(goodSlope.compliant, true, "10ft run with 2.5\" drop is 0.25 in/ft (1/4\" slope compliant)");
  assert.strictEqual(goodSlope.actualSlope, 0.25);

  const flatSlope = PhysicsConstraintEvaluator.evaluateDrainSlope({ runLengthFt: 10, verticalDropInches: 1.0, pipeDiameterInches: 2 });
  assert.strictEqual(flatSlope.compliant, false, "10ft run with only 1.0\" drop must fail 1/4\" slope code");
  assert.ok(flatSlope.violation.includes("Insufficient drainage slope"));
  console.log(`✔ PhysCaP Hydraulics: Verified minimum 1/4" per ft slope code constraint`);

  // 3.2 Structural Joist Penetration Checks (IRC R502.8)
  const safeHole = PhysicsConstraintEvaluator.evaluateStructuralPenetration({
    joistDepthInches: 9.25, // 2x10 joist
    holeDiameterInches: 2.0, // Max allowed is 9.25 / 3 = 3.08"
    edgeDistanceInches: 2.5  // Minimum allowed is 2.0"
  });
  assert.strictEqual(safeHole.compliant, true, "2\" hole with 2.5\" edge clearance in 2x10 is compliant");

  const oversizedHole = PhysicsConstraintEvaluator.evaluateStructuralPenetration({
    joistDepthInches: 9.25,
    holeDiameterInches: 4.5, // Exceeds 1/3 limit
    edgeDistanceInches: 2.5
  });
  assert.strictEqual(oversizedHole.compliant, false, "4.5\" hole in 2x10 joist must be rejected");
  assert.ok(oversizedHole.violation.includes("exceeds structural limit"));
  console.log(`✔ PhysCaP Structural: Enforced IRC R502.8 joist notch/bore limits (Rejected 4.5" oversized hole)`);

  // 3.3 Electrical Ampacity Checks (NEC)
  const safeCircuit = PhysicsConstraintEvaluator.evaluateCircuitWireGauge({ wireGauge: 12, breakerAmps: 20 });
  assert.strictEqual(safeCircuit.compliant, true, "12 AWG wire on 20A breaker is compliant");

  const hazardousCircuit = PhysicsConstraintEvaluator.evaluateCircuitWireGauge({ wireGauge: 14, breakerAmps: 20 });
  assert.strictEqual(hazardousCircuit.compliant, false, "14 AWG wire on 20A breaker must fail (fire hazard)");
  console.log(`✔ PhysCaP Electrical: Enforced NEC Table wire ampacity limits (Blocked 14 AWG on 20A circuit)`);

  // 3.4 Code-as-Policy Generation
  const physcap = createPhysCaPGenerator();
  const safePolicy = physcap.generatePolicy("Install 12ft PEX cold supply line", {
    runLengthFt: 12,
    verticalDropInches: 3.0,
    joistDepthInches: 9.25,
    holeDiameterInches: 1.25,
    edgeDistanceInches: 3.0,
    wireGauge: 12,
    breakerAmps: 20
  });

  assert.strictEqual(safePolicy.isSafeToExecute, true, "Safe context should produce executable policy");
  assert.ok(safePolicy.policyScript.includes("executePhysicalAction"), "Should generate executePhysicalAction function");

  const unsafePolicy = physcap.generatePolicy("Drill oversized sewer line penetration", {
    joistDepthInches: 7.25,
    holeDiameterInches: 4.0, // Illegal hole size
    edgeDistanceInches: 1.0  // Illegal edge clearance
  });
  assert.strictEqual(unsafePolicy.isSafeToExecute, false, "Unsafe context must block policy execution");
  assert.ok(unsafePolicy.violations.length >= 1, "Must capture violation details");
  console.log(`✔ PhysCaP Code-as-Policy: Generated executable policy and gated unsafe physical actions cleanly`);

  // ==========================================
  // 4. Matterport Spatial Importer & Fusion Tests
  // ==========================================
  console.log("\n--- 4. Testing Matterport Importer & Digital Twin Fusion ---");
  const { createMatterportImporter } = await import('./index.js');
  const mpImporter = createMatterportImporter();

  const mockSweeps = [
    { id: 'sweep_01', name: 'Kitchen Entry', position: [0.0, 1.5, 0.0], room: 'kitchen' },
    { id: 'sweep_02', name: 'Under Sink Alcove', position: [2.5, 1.2, 0.5], room: 'kitchen' },
    { id: 'sweep_03', name: 'Crawlspace Access', position: [4.0, 0.2, -1.0], room: 'crawl_space' }
  ];

  const bundle = mpImporter.createPassportBundle({
    modelId: 'mp-demo-suite-100',
    propertyAddress: '100 Example Way, Suite 200, Metropolis, CA 90001',
    sweeps: mockSweeps
  });

  assert.strictEqual(bundle.source, 'MATTERPORT_3D_INGEST');
  assert.strictEqual(bundle.architecturalEnvelope.sweepStations.length, 3);
  assert.strictEqual(bundle.spatialKnowledgeGraph.nodes.length, 3);
  assert.strictEqual(bundle.spatialKnowledgeGraph.nodes[0].id, 'station-sweep_01');
  console.log(`✔ Matterport Importer: Successfully ingested 3 sweep stations and fused into Spatial Knowledge Graph`);

  console.log("\n🎉 ALL PHYSICAL AI RESEARCH & MATTERPORT TESTS PASSED (100% SUCCESS)!\n");
}

runTests().catch(err => {
  console.error("❌ Physical AI test suite failed:", err);
  process.exit(1);
});
