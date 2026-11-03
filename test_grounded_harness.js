import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCALE_TIERS,
  inferModelScaleMetadata,
  resolveScaleProfile,
  buildScaleAwareDirective,
  measureToolSchemaSavings,
  createToolBudgetGate,
  createDeltaContextTracker,
  buildSafeGeminiToolConfig,
  normalizeCodeSnippetForHash,
  inspectOutputDefects,
  detectDatasetSchemaHazards,
  formatTimeoutWithPartialStdout,
  runAsyncWithPartialStdout,
  createGroundedHarnessLoop
} from './grounded-harness.js';
import * as rootBarrel from './index.js';

describe('@krusch/toolkit/grounded-harness — Scale-Aware & Low-Tool-Call Harness Brick (v0.2)', () => {
  test('root barrel re-exports all 14 grounded-harness primitives plus resolveGeminiToolConfig', () => {
    assert.equal(rootBarrel.SCALE_TIERS, SCALE_TIERS);
    assert.equal(rootBarrel.inferModelScaleMetadata, inferModelScaleMetadata);
    assert.equal(rootBarrel.resolveScaleProfile, resolveScaleProfile);
    assert.equal(rootBarrel.buildScaleAwareDirective, buildScaleAwareDirective);
    assert.equal(rootBarrel.measureToolSchemaSavings, measureToolSchemaSavings);
    assert.equal(rootBarrel.createToolBudgetGate, createToolBudgetGate);
    assert.equal(rootBarrel.createDeltaContextTracker, createDeltaContextTracker);
    assert.equal(rootBarrel.buildSafeGeminiToolConfig, buildSafeGeminiToolConfig);
    assert.equal(rootBarrel.normalizeCodeSnippetForHash, normalizeCodeSnippetForHash);
    assert.equal(rootBarrel.inspectOutputDefects, inspectOutputDefects);
    assert.equal(rootBarrel.detectDatasetSchemaHazards, detectDatasetSchemaHazards);
    assert.equal(rootBarrel.formatTimeoutWithPartialStdout, formatTimeoutWithPartialStdout);
    assert.equal(rootBarrel.runAsyncWithPartialStdout, runAsyncWithPartialStdout);
    assert.equal(rootBarrel.createGroundedHarnessLoop, createGroundedHarnessLoop);
    assert.equal(typeof rootBarrel.resolveGeminiToolConfig, 'function');
  });

  test('resolveScaleProfile enforces diminishing-return curve across model sizes and reasoning modes', () => {
    const small = resolveScaleProfile({ model: 'qwen2.5-coder:7b' });
    assert.equal(small.tier, SCALE_TIERS.SMALL_MODEL);
    assert.equal(small.injectPlanBindStep, true);
    assert.equal(small.softHoldPlaceholdersAndDates, true);
    assert.equal(small.maxMechanicalVerifyNudges, 1);
    assert.match(buildScaleAwareDirective(small), /PLAN -> BIND -> ACT/);

    const mid = resolveScaleProfile({ model: 'gemma4:31b' });
    assert.equal(mid.tier, SCALE_TIERS.MID_MODEL);
    assert.equal(mid.injectPlanBindStep, false);
    assert.equal(mid.softHoldPlaceholdersAndDates, false);
    assert.equal(mid.maxMechanicalVerifyNudges, 0);
    assert.equal(buildScaleAwareDirective(mid), '');

    const frontier = resolveScaleProfile({ model: 'gemini-4-argon' });
    assert.equal(frontier.tier, SCALE_TIERS.FRONTIER_REASONING);
    assert.equal(frontier.injectPlanBindStep, false);
    assert.equal(frontier.rescueSerializedToolCalls, false);
    assert.equal(frontier.maxMechanicalVerifyNudges, 0);

    for (const p of [small, mid, frontier]) {
      assert.equal(p.enforceZeroMutationImperativeNudge, false);
      assert.equal(p.enforceTwoPhaseAnalyticalNudge, false);
      assert.equal(p.maxReadStreak, 0);
    }
  });

  test('createGroundedHarnessLoop compiles zero-LLM KV-cache-stable prompts, memoizes reads, and scopes FORCE_VERIFY to real diffs', async () => {
    const tools = Array.from({ length: 20 }, (_, idx) => ({
      name: idx === 0 ? 'run_sql' : `aux_tool_${idx}`,
      title: `Auxiliary Enterprise Tool ${idx}`,
      description: `Enterprise auxiliary connector tool #${idx} with realistic multi-field schema metadata for ERP/CRM sync.`,
      inputSchema: {
        type: 'object',
        properties: {
          q: { type: 'string', description: 'Filter query string.' },
          limit: { type: 'integer', description: 'Row limit.' },
          includeArchived: { type: 'boolean', description: 'Include archived records.' }
        }
      }
    }));

    const loop = createGroundedHarnessLoop({
      model: 'gemma4:31b',
      standingInvariants: ['All financial totals must be reported in EUR.'],
      schemaSummaryText: 'TABLE settlements (id TEXT, amount_eur REAL, disputed INT)',
      docs: [
        {
          id: 'fee_policy',
          title: 'Settlement Rules',
          text: 'Disputed rows with disputed=1 add a flat 15.00 EUR chargeback handling fee.'
        }
      ],
      fileDigests: { 'settlements.sqlite': 'sha256_v1' },
      tools,
      pinnedToolNames: ['run_sql'],
      deferThreshold: 12
    });

    const p1 = await loop.compilePrompt('Calculate disputed chargeback handling fees.');
    const p2 = await loop.compilePrompt('Count total rows in settlements.');
    assert.equal(p1.ok, true);
    assert.equal(p1.data.llmIngestionCalls, 0);
    assert.equal(p1.data.prefixHash, p2.data.prefixHash);
    assert.equal(p1.data.geminiToolConfig, null);
    assert.ok(p1.data.toolSavings.reductionPct > 50);

    // First read allowed, identical repeat read memoized in 0 external round-trips
    const r1 = loop.interceptToolCall('run_sql', { sql: 'SELECT SUM(amount_eur) FROM settlements -- step 1' }, { isMutating: false });
    assert.equal(r1.data.allowed, true);
    loop.recordToolOutcome(r1.data.callSignature, {
      ok: true,
      preview: '420.50 EUR',
      isMutating: false
    });

    // Re-commented identical SQL matches exact signature and returns MEMOIZED_PRIOR_READ first, then BLOCK_SPIN_LOOP on stubborn 3rd repeat
    const r2 = loop.interceptToolCall('run_sql', { sql: 'SELECT SUM(amount_eur) FROM settlements -- retry comment' }, { isMutating: false });
    assert.equal(r2.data.decision, 'MEMOIZED_PRIOR_READ');
    assert.equal(r2.data.cachedPreview, '420.50 EUR');

    const r3 = loop.interceptToolCall('run_sql', { sql: 'SELECT SUM(amount_eur) FROM settlements' }, { isMutating: false });
    assert.equal(r3.data.decision, 'BLOCK_SPIN_LOOP');
    assert.equal(loop.getStats().spinLoopsBlocked, 1);

    // Clean analytical stop allowed with 0 nudges when pendingDiffsCount === 0
    const cleanStop = loop.verifyStop({
      stopRequested: true,
      assistantText: '435.50 EUR'
    });
    assert.equal(cleanStop.data.allowStop, true);
    assert.equal(cleanStop.data.action, 'ALLOW_STOP');

    // Unverified staged diff triggers FORCE_VERIFY
    const mut = loop.interceptToolCall('write_file', { path: 'src/calc.js', content: 'export const X = 1;\n' }, { isMutating: true });
    assert.equal(mut.data.allowed, true);
    loop.recordToolOutcome(mut.data.callSignature, {
      ok: true,
      isMutating: true,
      pendingDiffsDelta: 1
    });

    const blockedStop = loop.verifyStop({
      stopRequested: true,
      assistantText: 'Updated calc.js.'
    });
    assert.equal(blockedStop.data.allowStop, false);
    assert.equal(blockedStop.data.action, 'FORCE_VERIFY');
  });

  test('v0.2 Empirical Trace Patterns (#1-#6): Gemini NONE guard, Defect-Only Output Gate, Python // hash safety, Schema Hazards & Timeout Partial Stdout', async () => {
    // Pattern 1: Tool-less loop sets geminiToolConfig mode NONE
    const toolLessLoop = createGroundedHarnessLoop({ model: 'gemini-4-argon', tools: [] });
    const compiled = await toolLessLoop.compilePrompt('Compute merchant fee ratio.');
    assert.deepEqual(compiled.data.geminiToolConfig, { functionCallingConfig: { mode: 'NONE' } });
    assert.equal(buildSafeGeminiToolConfig({ tools: [{ name: 'run_py' }] }), null);

    // Pattern 2: Zero-Turn Defect-Only Output Gate
    assert.equal(inspectOutputDefects({ candidateAnswer: 'Not Applicable', expectNonEmptyAnswer: true }).hasDefect, false);
    assert.equal(inspectOutputDefects({ candidateAnswer: '0', expectNonEmptyAnswer: true }).hasDefect, false);
    assert.equal(inspectOutputDefects({ candidateAnswer: false, expectNonEmptyAnswer: true }).hasDefect, false);
    assert.equal(inspectOutputDefects({ candidateAnswer: 'NaN', expectNonEmptyAnswer: true }).primaryDefect?.code, 'EMPTY_OR_NULL_BAILOUT');
    assert.equal(inspectOutputDefects({ candidateAnswer: [], expectNonEmptyAnswer: true }).primaryDefect?.code, 'EMPTY_OR_NULL_BAILOUT');
    assert.equal(inspectOutputDefects({ assistantText: 'partial', finishReason: 'MAX_TOKENS' }).primaryDefect?.code, 'TRUNCATED_OUTPUT');
    assert.equal(inspectOutputDefects({ assistantText: 'call:python_interpreter{code:"1+1"}' }).primaryDefect?.code, 'SERIALIZED_TOOL_CALL_IN_TEXT');
    assert.equal(inspectOutputDefects({ candidateAnswer: 'np.float64(0.0912)' }).primaryDefect?.code, 'RAW_DATAFRAME_OR_NUMPY_REPR');
    // Code-spanned explanation in prose does NOT false-positive
    assert.equal(inspectOutputDefects({ assistantText: 'Converted `np.float64(0.09)` to `0.09`.' }).hasDefect, false);

    // Pattern 3: Quote-aware & Python floor-division-safe normalization + failed spin block
    const py1 = normalizeCodeSnippetForHash('q = 15 // 4  # integer floor division\nurl = "https://api.example/v1#frag"\nprint(q)', 'code');
    const py2 = normalizeCodeSnippetForHash('q = 15 // 4  # different comment\n\nurl = "https://api.example/v1#frag"   \nprint(q)', 'code');
    const pyFloat = normalizeCodeSnippetForHash('q = 15 / 4\nurl = "https://api.example/v1#frag"\nprint(q)', 'code');
    assert.equal(py1, py2);
    assert.notEqual(py1, pyFloat);
    assert.match(py1, /15 \/\/ 4/);
    assert.match(py1, /#frag/);

    const failCall1 = toolLessLoop.interceptToolCall('exec_py', { code: 'x = 1 / 0  # try 1' }, { isMutating: false });
    assert.equal(failCall1.data.allowed, true);
    toolLessLoop.recordToolOutcome(failCall1.data.callSignature, { ok: false, preview: 'ZeroDivisionError' });
    const failCall2 = toolLessLoop.interceptToolCall('exec_py', { code: 'x = 1 / 0  # try 2' }, { isMutating: false });
    assert.equal(failCall2.data.decision, 'BLOCK_SPIN_LOOP');

    // Pattern 4: CSV "NA" string literal & JSON null/[] wildcard hazard detection
    const hazards = detectDatasetSchemaHazards({
      headers: ['tx_id', 'region'],
      csvRows: [['1', 'EU'], ['2', 'NA'], ['3', 'US']],
      jsonRecords: [
        { rule_id: 'r1', account_type: [], capture_delay: null },
        { rule_id: 'r2', account_type: ['H'], capture_delay: 'immediate' }
      ]
    });
    assert.equal(hazards.hasLiteralNaHazard, true);
    assert.deepEqual(hazards.naHazardColumns, ['region']);
    assert.ok(hazards.emptyArrayFields.includes('account_type'));
    assert.ok(hazards.nullFields.includes('capture_delay'));
    assert.ok(hazards.wildcardCandidateFields.includes('account_type'));

    // Pattern 6: Partial stdout preservation on async timeout
    const timedOut = await runAsyncWithPartialStdout(
      async ({ signal, onStdout }) => {
        onStdout('step_1_rows=4812\n');
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, 500);
          signal.addEventListener('abort', () => {
            clearTimeout(t);
            reject(new Error('Aborted'));
          }, { once: true });
        });
        return { ok: true };
      },
      { timeoutMs: 40, label: 'Python analytics step' }
    );
    assert.equal(timedOut.timedOut, true);
    assert.equal(timedOut.ok, false);
    assert.equal(timedOut.hasFinalAnswer, false);
    assert.equal(timedOut.finalAnswer, null);
    assert.match(timedOut.stdout, /step_1_rows=4812/);
    assert.match(timedOut.formattedObservation, /PARTIAL STDOUT BEFORE TIMEOUT/);
  });
});
