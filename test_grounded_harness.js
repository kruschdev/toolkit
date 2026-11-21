import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCALE_TIERS,
  GEMINI_TOOL_RETRIEVAL_MODELS,
  inferModelScaleMetadata,
  resolveScaleProfile,
  buildScaleAwareDirective,
  measureToolSchemaSavings,
  isGeminiToolRetrievalSupported,
  resolveAutoPinnedToolNames,
  deriveToolShortDescription,
  buildGeminiInteractionsTools,
  validateGeminiStatelessToolHistory,
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
  test('root barrel re-exports all 20 grounded-harness primitives plus resolveGeminiToolConfig', () => {
    assert.equal(rootBarrel.SCALE_TIERS, SCALE_TIERS);
    assert.equal(rootBarrel.GEMINI_TOOL_RETRIEVAL_MODELS, GEMINI_TOOL_RETRIEVAL_MODELS);
    assert.equal(rootBarrel.inferModelScaleMetadata, inferModelScaleMetadata);
    assert.equal(rootBarrel.resolveScaleProfile, resolveScaleProfile);
    assert.equal(rootBarrel.buildScaleAwareDirective, buildScaleAwareDirective);
    assert.equal(rootBarrel.measureToolSchemaSavings, measureToolSchemaSavings);
    assert.equal(rootBarrel.isGeminiToolRetrievalSupported, isGeminiToolRetrievalSupported);
    assert.equal(rootBarrel.resolveAutoPinnedToolNames, resolveAutoPinnedToolNames);
    assert.equal(rootBarrel.deriveToolShortDescription, deriveToolShortDescription);
    assert.equal(rootBarrel.buildGeminiInteractionsTools, buildGeminiInteractionsTools);
    assert.equal(rootBarrel.validateGeminiStatelessToolHistory, validateGeminiStatelessToolHistory);
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

  test('Gemini v1beta/interactions Tool Retrieval: auto-pins prompt-named tools, compiles server/client modes without HTTP 400 traps, and validates stateless signatures', () => {
    assert.equal(isGeminiToolRetrievalSupported('gemini-4-argon'), true);
    assert.equal(isGeminiToolRetrievalSupported('gemini-4-hydrogen'), true);
    assert.equal(isGeminiToolRetrievalSupported('gemini-4-carbon'), true);
    assert.equal(isGeminiToolRetrievalSupported('models/gemini-3.8-flash'), true);
    assert.equal(isGeminiToolRetrievalSupported('gemini-3.6-flash'), true);
    assert.equal(isGeminiToolRetrievalSupported('gemini-2.5-pro'), false);
    assert.equal(isGeminiToolRetrievalSupported('qwen3-coder-30b-moe'), false);

    const catalog = Array.from({ length: 18 }, (_, idx) => {
      if (idx === 0) {
        return {
          name: 'context_retrieve',
          component: 'context',
          description: 'Hydrate active working memory and project invariants at session start.',
          inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
        };
      }
      if (idx === 4) {
        return {
          name: 'git_dependency_graph',
          component: 'git',
          description: 'Trace inbound callers and outbound callees before changing public interfaces. Supports multi-hop AST traversal.',
          inputSchema: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] }
        };
      }
      if (idx === 9) {
        return {
          name: 'billing_get_customer',
          component: 'billing',
          description: 'Retrieve customer ledger balance and invoice history from billing service with currency normalization.',
          inputSchema: { type: 'object', properties: { customerId: { type: 'string' } }, required: ['customerId'] }
        };
      }
      if (idx === 10) {
        return {
          name: 'crm_get_customer',
          component: 'crm',
          description: 'Retrieve customer contact profile and account owner from CRM service.',
          inputSchema: { type: 'object', properties: { customerId: { type: 'string' } }, required: ['customerId'] }
        };
      }
      return {
        name: `aux_tool_${idx}`,
        component: 'ops',
        description: `Auxiliary operational tool ${idx} with extended validation parameters. Secondary sentence details.`,
        inputSchema: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] }
      };
    });

    // Identifier-boundary auto-pinning: pins git_dependency_graph mentioned in systemPrompt, ignores partial aux_tool_1_v2
    const systemPrompt = 'Call context_retrieve on turn 1 and git_dependency_graph before changing signatures (never aux_tool_1_v2).';
    const pinCheck = resolveAutoPinnedToolNames(catalog, {
      pinnedToolNames: ['context_retrieve'],
      systemPrompt
    });
    assert.deepEqual(pinCheck.autoPinnedToolNames, ['git_dependency_graph']);
    assert.deepEqual(pinCheck.pinnedToolNames, ['context_retrieve', 'git_dependency_graph']);

    // 1. Server-side mode via createToolBudgetGate.toGeminiInteractionsTools()
    const gate = createToolBudgetGate({
      tools: catalog,
      pinnedToolNames: ['context_retrieve'],
      systemPrompt,
      deferThreshold: 12
    });
    assert.deepEqual(gate.autoPinnedToolNames, ['git_dependency_graph']);

    const serverCompiled = gate.toGeminiInteractionsTools({
      mode: 'server',
      model: 'gemini-4-argon',
      mcpServers: [{ name: 'remote_docs', url: 'https://example.com/mcp', deferLoading: true }]
    });
    assert.equal(serverCompiled.mode, 'server');
    assert.equal(serverCompiled.deferred, true);
    assert.deepEqual(serverCompiled.tools[0], { type: 'tool_search' });
    assert.equal('name' in serverCompiled.tools[0], false);

    const eagerGit = serverCompiled.tools.find((t) => t.name === 'git_dependency_graph');
    assert.equal(eagerGit.defer_loading, undefined);
    assert.equal(eagerGit.short_description, undefined);

    const deferredBilling = serverCompiled.tools.find((t) => t.name === 'billing_get_customer');
    assert.equal(deferredBilling.defer_loading, true);
    assert.match(deferredBilling.short_description, /^\[billing\] /);
    assert.deepEqual(deferredBilling.parameters.required, ['customerId']);

    const deferredMcp = serverCompiled.tools.find((t) => t.type === 'mcp_server');
    assert.equal(deferredMcp.defer_loading, true);
    assert.deepEqual(serverCompiled.deferredMcpServerNames, ['remote_docs']);

    // Unsupported model or small catalog falls back to static declarations (0 defer_loading / short_description)
    const unsupportedFallback = gate.toGeminiInteractionsTools({ mode: 'server', model: 'gemini-2.5-pro' });
    assert.equal(unsupportedFallback.mode, 'static');
    assert.equal(unsupportedFallback.deferred, false);
    assert.equal(unsupportedFallback.tools.some((t) => t.type === 'tool_search' || t.defer_loading), false);

    // 2. Client-side mode backed by local Okapi BM25 + namespace filtering (static mcpServers preserved without defer_loading)
    const clientCompiled = gate.toGeminiInteractionsTools({
      mode: 'client',
      model: 'gemini-4-argon',
      clientSearchName: 'search_tool_registry',
      mcpServers: [{ name: 'remote_docs', url: 'https://example.com/mcp', deferLoading: true }]
    });
    assert.equal(clientCompiled.mode, 'client');
    assert.equal(clientCompiled.tools[0].type, 'tool_search');
    assert.equal(clientCompiled.tools[0].execution, 'client');
    assert.equal(clientCompiled.tools[0].name, 'search_tool_registry');
    assert.match(clientCompiled.tools[0].description, /billing.*crm/);
    assert.equal(clientCompiled.tools.some((t) => t.defer_loading === true || 'short_description' in t), false);
    const clientMcp = clientCompiled.tools.find((t) => t.type === 'mcp_server');
    assert.deepEqual(clientMcp, { type: 'mcp_server', name: 'remote_docs', url: 'https://example.com/mcp' });
    assert.deepEqual(clientCompiled.deferredMcpServerNames, []);

    const hitStep = clientCompiled.resolveClientSearchResult({
      type: 'function_call',
      id: 'fc_search_99',
      name: 'search_tool_registry',
      arguments: { query: 'customer invoice balance', namespace: 'billing', limit: 3 }
    });
    assert.equal(hitStep.type, 'function_result');
    assert.equal(hitStep.call_id, 'fc_search_99');
    assert.equal(Array.isArray(hitStep.result), true);
    assert.equal(hitStep.result.length, 1);
    assert.equal(hitStep.result[0].type, 'function');
    assert.equal(hitStep.result[0].name, 'billing_get_customer');
    assert.equal(hitStep.result[0].defer_loading, undefined);

    const missStep = clientCompiled.resolveClientSearchResult({
      id: 'fc_search_miss',
      arguments: { query: 'quantum_teleportation_drive' }
    });
    assert.equal(missStep.result[0].type, 'text');
    assert.match(missStep.result[0].text, /Available namespaces:/);

    // 3. Stateless circulation & signature audit
    const validHistory = validateGeminiStatelessToolHistory(
      [
        { type: 'user_input', content: [{ type: 'text', text: 'Check customer c_42 balance.' }] },
        { type: 'thought', signature: 'sig_th_1', summary: 'Need billing tool.' },
        { type: 'tool_search_call', id: 'tsc_1', signature: 'sig_tsc_1', arguments: { function_names: ['billing_get_customer'] } },
        {
          type: 'tool_search_result',
          call_id: 'tsc_1',
          signature: 'sig_tsr_1',
          result: [{ type: 'function', name: 'billing_get_customer', parameters: { type: 'object' } }]
        },
        { type: 'function_call', id: 'fc_1', signature: 'sig_fc_1', name: 'billing_get_customer', arguments: { customerId: 'c_42' } },
        { type: 'function_result', call_id: 'fc_1', name: 'billing_get_customer', result: [{ type: 'text', text: '{"balance":0}' }] }
      ],
      { deferredToolNames: serverCompiled.deferredToolNames }
    );
    assert.equal(validHistory.valid, true);
    assert.deepEqual(validHistory.loadedToolNames, ['billing_get_customer']);

    const brokenHistory = validateGeminiStatelessToolHistory(
      [
        { type: 'thought', signature: 'sig_th_ok', summary: 'Thinking...' },
        { type: 'function_call', id: 'fc_missing_sig', name: 'context_retrieve', arguments: { query: '*' } },
        { type: 'tool_search_result', call_id: 'tsc_never_called', signature: 'sig_tsr_orphan', result: [] },
        { type: 'tool_search_call', id: 'tsc_orphan' },
        { type: 'mcp_server_tool_call', id: 'mcp_1', server_name: 'remote_docs', name: 'read_doc', arguments: {} },
        { type: 'function_result', call_id: 'fc_unsearched', name: 'crm_get_customer', result: [] }
      ],
      {
        deferredToolNames: serverCompiled.deferredToolNames,
        deferredMcpServerNames: ['remote_docs']
      }
    );
    assert.equal(brokenHistory.valid, false);
    const defectCodes = brokenHistory.defects.map((d) => d.code);
    assert.ok(defectCodes.includes('MISSING_THOUGHT_SIGNATURE'));
    assert.ok(brokenHistory.defects.some((d) => d.code === 'MISSING_THOUGHT_SIGNATURE' && d.toolName === 'context_retrieve'));
    assert.ok(defectCodes.includes('ORPHANED_TOOL_SEARCH_RESULT'));
    assert.ok(defectCodes.includes('MISSING_TOOL_SEARCH_RESULT'));
    assert.ok(brokenHistory.defects.some((d) => d.code === 'MISSING_CIRCULATED_TOOL_CONTEXT' && d.toolName === 'remote_docs:read_doc'));
    assert.ok(brokenHistory.defects.some((d) => d.code === 'MISSING_CIRCULATED_TOOL_CONTEXT' && d.toolName === 'crm_get_customer'));

    // 4. createGroundedHarnessLoop forwards baseSystemPrompt + standingInvariants into toolGate auto-pinning
    const loopWithNamedTools = createGroundedHarnessLoop({
      model: 'gemini-4-argon',
      baseSystemPrompt: 'Always call context_retrieve on turn 1.',
      standingInvariants: ['Run git_dependency_graph before modifying public exports.'],
      tools: catalog,
      pinnedToolNames: [],
      deferThreshold: 12
    });
    assert.deepEqual(loopWithNamedTools.toolGate.autoPinnedToolNames, ['context_retrieve', 'git_dependency_graph']);
    const loopGemini = loopWithNamedTools.toolGate.toGeminiInteractionsTools({ mode: 'server', model: 'gemini-4-argon' });
    assert.deepEqual(loopGemini.eagerToolNames, ['context_retrieve', 'git_dependency_graph']);

    // 5. Duplicate tool deduplication & schema non-mutation
    const dupCatalog = [...catalog, { ...catalog[9] }];
    const dedupCompiled = buildGeminiInteractionsTools(dupCatalog, { mode: 'server', model: 'gemini-4-argon' });
    assert.equal(
      dedupCompiled.tools.filter((t) => t.name === 'billing_get_customer').length,
      1
    );
    const compiledBilling = dedupCompiled.tools.find((t) => t.name === 'billing_get_customer');
    compiledBilling.parameters.required.push('mutated_field');
    assert.deepEqual(catalog[9].inputSchema.required, ['customerId']);
  });
});
