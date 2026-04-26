/**
 * Quick verification test for the job context enrichment engine.
 * Tests rule triggering logic without requiring database or LLM.
 *
 * Usage: node lib/trade-knowledge/test-enrichment.js
 */

// Test mock: bypass @krusch/toolkit/agents import
// We need to mock buildContextSection since it's not available outside the full app
const originalImport = global[Symbol.for('import')];

// Inline test since we can't easily mock ESM imports — test the rule files directly

const trades = [
  'spark', 'drainflux', 'climacore', 'brushwise', 'floorwise',
  'frameup', 'ridgeline', 'stoneset', 'boardwise', 'groundwork'
];

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${message}`);
  } else {
    failed++;
    console.error(`  ❌ ${message}`);
  }
}

async function testTrade(trade) {
  const mod = await import(`./${trade}.js`);
  const rules = mod.default;
  assert(Array.isArray(rules) && rules.length >= 5, `${trade}: has ${rules.length} rules (≥5)`);

  // Verify each rule has required fields
  for (const rule of rules) {
    assert(rule.id && rule.category && rule.condition && rule.title && rule.content,
      `${trade}.${rule.id}: has all required fields`);
  }
}

async function testConditionTriggering() {
  console.log('\n── Condition Triggering Tests ──');

  // Spark: pre-1978 building should trigger wiring hazards
  const spark = (await import('./spark.js')).default;
  const oldBuildingCtx = { buildingAge: '1965' };
  const triggered = spark.filter(r => { try { return r.condition(oldBuildingCtx); } catch { return false; } });
  assert(triggered.some(r => r.id === 'pre-1978-wiring'), 'Spark: 1965 building triggers pre-1978-wiring');

  // Spark: modern building should NOT trigger pre-1978
  const newBuildingCtx = { buildingAge: '2020' };
  const newTriggered = spark.filter(r => { try { return r.condition(newBuildingCtx); } catch { return false; } });
  assert(!newTriggered.some(r => r.id === 'pre-1978-wiring'), 'Spark: 2020 building does NOT trigger pre-1978-wiring');

  // BrushWise: pre-1978 triggers lead paint RRP
  const brushwise = (await import('./brushwise.js')).default;
  const leadCtx = { buildingAge: '1960' };
  const leadTriggered = brushwise.filter(r => { try { return r.condition(leadCtx); } catch { return false; } });
  assert(leadTriggered.some(r => r.id === 'lead-paint-rrp'), 'BrushWise: 1960 building triggers lead-paint-rrp');

  // FloorWise: old building triggers asbestos
  const floorwise = (await import('./floorwise.js')).default;
  const asbestosCtx = { buildingAge: '1975', existingFlooring: '9x9 vinyl tile' };
  const asbestosTriggered = floorwise.filter(r => { try { return r.condition(asbestosCtx); } catch { return false; } });
  assert(asbestosTriggered.some(r => r.id === 'asbestos-risk'), 'FloorWise: 9x9 tiles trigger asbestos-risk');

  // ClimaCore: R-22 system triggers phaseout warning
  const climacore = (await import('./climacore.js')).default;
  const r22Ctx = { refrigerantType: 'R-22', systemType: 'split AC' };
  const r22Triggered = climacore.filter(r => { try { return r.condition(r22Ctx); } catch { return false; } });
  assert(r22Triggered.some(r => r.id === 'r22-phaseout'), 'ClimaCore: R-22 triggers r22-phaseout');

  // DrainFlux: pre-1970 building triggers pipe hazards
  const drainflux = (await import('./drainflux.js')).default;
  const oldPipesCtx = { buildingAge: '1955' };
  const pipeTriggered = drainflux.filter(r => { try { return r.condition(oldPipesCtx); } catch { return false; } });
  assert(pipeTriggered.some(r => r.id === 'pre-1970-pipes'), 'DrainFlux: 1955 building triggers pre-1970-pipes');
}

async function main() {
  console.log('Job Context Enrichment — Verification Tests\n');

  console.log('── Rule File Structure Tests ──');
  for (const trade of trades) {
    await testTrade(trade);
  }

  await testConditionTriggering();

  console.log(`\n${'─'.repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
