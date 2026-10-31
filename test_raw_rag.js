import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    RAW_RAG_DEFAULTS,
    RAG_BASELINE_CONSTRAINTS,
    QWEN_RERANKER_TEMPLATE,
    LEGAL_BOILERPLATE_STOPWORDS,
    estimateTokenCount,
    serializeConversationTurn,
    chunkConversationWindows,
    auditRagBaselineConfig,
    normalizeAppendOnlyWriteOp,
    auditMutationStream,
    buildQwenRerankerPrompt,
    scoreDeterministicCrossEncoder,
    shouldNarrowCandidateSubSpan,
    rerankCandidateWindows,
    assembleReaderEvidence,
    evaluateCoverageAndUtilization,
    evaluateConditionalPathRetention,
    createRawRagIndex
} from './index.js';

describe('@krusch/toolkit/raw-rag (arXiv:2610.30755)', () => {
    it('exports frozen Raw-RAG defaults and baseline constraints', () => {
        assert.equal(Object.isFrozen(RAW_RAG_DEFAULTS), true);
        assert.equal(Object.isFrozen(RAG_BASELINE_CONSTRAINTS), true);
        assert.equal(Object.isFrozen(QWEN_RERANKER_TEMPLATE), true);
        assert.equal(RAW_RAG_DEFAULTS.windowTokens, 256);
        assert.equal(RAW_RAG_DEFAULTS.overlapTokens, 32);
        assert.equal(RAW_RAG_DEFAULTS.strideTokens, 224);
        assert.equal(RAW_RAG_DEFAULTS.denseCandidateK, 128);
        assert.equal(RAW_RAG_DEFAULTS.finalRerankK, 15);
        assert.equal(RAW_RAG_DEFAULTS.maxEvidenceTokens, 5000);
        assert.equal(RAW_RAG_DEFAULTS.llmIngestionCalls, 0);
    });

    it('serializes turns with default "unknown" date and inline image captions without LLM mutation', () => {
        const plain = serializeConversationTurn({ speaker: 'Alice', content: 'Switched port to 5435.' }, 0);
        assert.equal(plain.date, 'unknown');
        assert.equal(plain.serialized, '[Date: unknown] Alice: Switched port to 5435.');

        const multimodal = serializeConversationTurn({
            turnId: 't_7',
            date: '2026-10-20',
            speaker: 'Bob',
            content: 'Uploaded rack photo.',
            imageCaptions: ['Dual RTX 3060 cards installed in server chassis']
        }, 7);
        assert.equal(multimodal.turnId, 't_7');
        assert.match(multimodal.serialized, /\[Date: 2026-10-20\] Bob: Uploaded rack photo\./);
        assert.match(multimodal.serialized, /\[Image Caption\]: Dual RTX 3060 cards installed in server chassis/);
    });

    it('partitions conversation history into 256-token windows with exact 32-token overlap and turn back-pointers', () => {
        const turns = Array.from({ length: 18 }, (_, i) => ({
            turnId: `msg_${i}`,
            date: `2026-10-${String((i % 28) + 1).padStart(2, '0')}`,
            speaker: i % 2 === 0 ? 'User' : 'Assistant',
            phase: Math.floor(i / 6) + 1,
            content: `Turnmarker_${i} discusses database migration batch_${i} with latency_${i * 10}ms and replica verification across node_${i % 4} in production cluster.`
        }));

        const { windows, serializedTurns, totalTokens } = chunkConversationWindows(turns, {
            windowTokens: 256,
            overlapTokens: 32
        });

        assert.equal(serializedTurns.length, 18);
        assert.ok(totalTokens > 256, 'expected multi-window stream');
        assert.ok(windows.length >= 2);
        assert.equal(windows[0].tokenCount, 256);
        assert.equal(windows[1].startToken, 224);
        assert.equal(windows[0].endToken - windows[1].startToken, 32, 'exact 32-token overlap');

        for (const win of windows) {
            assert.ok(win.turnIndices.length >= 1, 'each window links to >=1 source turn');
            assert.equal(win.turnIds.length, win.turnIndices.length);
            assert.equal(estimateTokenCount(win.text), win.tokenCount);
        }
    });

    it('audits RAG configurations against Appendix E Table 34 baseline flaws', () => {
        const strong = auditRagBaselineConfig(RAW_RAG_DEFAULTS);
        assert.equal(strong.valid, true);
        assert.equal(strong.status, 'STRONG_RAW_RAG');
        assert.equal(strong.findings.length, 0);

        // Nemori / Mem0 / k=120 / no-reranker anti-patterns
        const weakened = auditRagBaselineConfig({
            chunkTokens: 4096,
            finalTopK: 2,
            rerankerEnabled: false,
            allowDestructiveOverwrite: true,
            llmIngestionTransform: true
        });
        assert.equal(weakened.valid, false);
        assert.equal(weakened.status, 'WEAKENED_BASELINE');
        const codes = new Set(weakened.findings.map((f) => f.code));
        assert.ok(codes.has('CHUNK_TOO_LARGE'));
        assert.ok(codes.has('TOP_K_TOO_LOW'));
        assert.ok(codes.has('MISSING_RERANKER'));
        assert.ok(codes.has('DESTRUCTIVE_MUTATION_ENABLED'));
        assert.ok(codes.has('LLM_INGESTION_BOTTLENECK'));

        // Distractor overflow (k=120 drops -14.57 pp on MAB)
        const overflow = auditRagBaselineConfig({ finalTopK: 120 });
        assert.equal(overflow.valid, false);
        assert.ok(overflow.findings.some((f) => f.code === 'TOP_K_DISTRACTOR_OVERFLOW'));

        // BEAM k=5 borderline band
        const borderline = auditRagBaselineConfig({ finalTopK: 5 });
        assert.equal(borderline.valid, true);
        assert.equal(borderline.status, 'SUBOPTIMAL');
        assert.ok(borderline.findings.some((f) => f.code === 'TOP_K_SUBOPTIMAL_BAND'));
    });

    it('normalizes UPDATE/DELETE proposals to append-only ADD/NONE and audits effective mutation rate', () => {
        const existing = [
            { id: 'm1', text: 'Primary Postgres runs on port 5432' },
            { id: 'm2', text: 'Embeddings use snowflake-arctic-embed2' }
        ];

        // Identical text UPDATE -> NOOP NONE (15.5%-39.2% failure mode in Mem0)
        const noopUpdate = normalizeAppendOnlyWriteOp(
            { action: 'UPDATE', targetId: 'm1', text: '  primary postgres runs on port 5432 ' },
            existing
        );
        assert.equal(noopUpdate.action, 'NONE');
        assert.equal(noopUpdate.effectiveWrite, false);
        assert.equal(noopUpdate.reason, 'NOOP_IDENTICAL_TEXT');

        // Real state transition UPDATE -> non-destructive ADD with supersedesId
        const supersedeAdd = normalizeAppendOnlyWriteOp(
            { action: 'UPDATE', targetId: 'm1', text: 'Primary Postgres migrated to port 5434' },
            existing
        );
        assert.equal(supersedeAdd.action, 'ADD');
        assert.equal(supersedeAdd.effectiveWrite, true);
        assert.equal(supersedeAdd.supersedesId, 'm1');
        assert.equal(supersedeAdd.reason, 'APPEND_ONLY_SUPERSEDE');

        // Missing target UPDATE -> safe ADD without throwing
        const missingTarget = normalizeAppendOnlyWriteOp(
            { action: 'UPDATE', targetId: 'ghost_999', text: 'Redis cache added on port 6379' },
            existing
        );
        assert.equal(missingTarget.action, 'ADD');
        assert.equal(missingTarget.supersedesId, null);
        assert.equal(missingTarget.reason, 'UPDATE_MISSING_TARGET_CONVERTED_TO_ADD');

        // Standard DELETE -> blocked (NONE); explicit compliance DELETE -> COMPLIANCE_TOMBSTONE
        const blockedDelete = normalizeAppendOnlyWriteOp({ action: 'DELETE', targetId: 'm2' }, existing);
        assert.equal(blockedDelete.action, 'NONE');
        assert.equal(blockedDelete.reason, 'DESTRUCTIVE_DELETE_BLOCKED');

        const complianceDelete = normalizeAppendOnlyWriteOp(
            { action: 'DELETE', targetId: 'm2' },
            existing,
            { explicitComplianceErase: true }
        );
        assert.equal(complianceDelete.action, 'COMPLIANCE_TOMBSTONE');
        assert.equal(complianceDelete.effectiveWrite, true);

        // Stream audit
        const audit = auditMutationStream([
            { action: 'ADD', id: 'a1', text: 'User lives in Seattle' },
            { action: 'UPDATE', targetId: 'a1', text: 'User lives in Seattle' }, // noop
            { action: 'UPDATE', targetId: 'bad_id', text: 'User likes espresso' }, // malformed target
            { action: 'UPDATE', targetId: 'a1', text: 'User moved to Austin' }, // 1 effective mutation
            { action: 'NONE', text: '' }
        ]);
        assert.equal(audit.totalDecisions, 5);
        assert.equal(audit.effectiveMutationCount, 1);
        assert.equal(audit.noopOrMalformedMutationCount, 2);
        assert.equal(audit.effectiveMutationRate, 0.2);
    });

    it('builds Appendix G.1 Qwen3-Reranker prompts and calibrates YES/NO logprobs in rerankCandidateWindows', async () => {
        const prompt = buildQwenRerankerPrompt('Which port hosts KruschLaw?', 'KruschLaw API listens on 8085.');
        assert.match(prompt.system, /answer can only be "yes" or "no"/);
        assert.match(prompt.user, /<Instruct>:/);
        assert.match(prompt.user, /<Query>: Which port hosts KruschLaw\?/);
        assert.match(prompt.user, /<Document>: KruschLaw API listens on 8085\./);

        const candidates = [
            { windowId: 'w0', windowIndex: 0, text: 'Unrelated groceries list with apples and milk.', denseScore: 0.72 },
            { windowId: 'w1', windowIndex: 1, text: 'KruschLaw FastAPI server binds to port 8085.', denseScore: 0.51 }
        ];

        const reranked = await rerankCandidateWindows('Which port hosts KruschLaw?', candidates, {
            topK: 2,
            rerankerFn: async (_q, cand) => ({
                topLogprobs: cand.windowId === 'w1'
                    ? [{ token: 'yes', logprob: -0.05 }, { token: 'no', logprob: -3.2 }]
                    : [{ token: 'no', logprob: -0.08 }, { token: 'yes', logprob: -2.8 }]
            })
        });

        assert.equal(reranked[0].windowId, 'w1');
        assert.equal(reranked[0].rerankMode, 'logprobs');
        assert.ok(reranked[0].rerankScore > 0.9);
        assert.ok(reranked[1].rerankScore < 0.15);
    });

    it('disables turn expansion first when expanded turns exceed 5,000-token budget, preserving all 15 selected chunks', () => {
        // 15 long source turns (~390 tokens each -> ~5,850 expanded tokens > 5,000),
        // while 15 raw windows are 14 tokens each (210 tokens <= 5,000).
        const longTurns = Array.from({ length: 15 }, (_, i) => {
            const filler = Array.from({ length: 380 }, (__, w) => `word_${i}_${w}`).join(' ');
            return {
                turnId: `long_turn_${i}`,
                date: '2026-10-25',
                speaker: 'Engineer',
                content: `EvidenceAnchor_${i} ${filler}`
            };
        });

        const selectedWindows = longTurns.map((t, i) => ({
            windowId: `sel_win_${i}`,
            windowIndex: i,
            turnIndices: [i],
            text: `[Date: 2026-10-25] Engineer: EvidenceAnchor_${i} compact_window_summary_${i}`,
            tokenCount: 14
        }));

        const assembled = assembleReaderEvidence(selectedWindows, longTurns, {
            maxEvidenceTokens: 5000,
            turnExpansion: true
        });

        assert.equal(assembled.turnExpansionApplied, false);
        assert.equal(assembled.budgetPolicyTriggered, 'DISABLED_TURN_EXPANSION');
        assert.equal(assembled.selectedWindowCount, 15);
        assert.equal(assembled.retainedEntryCount, 15, 'all 15 reranked windows preserved without dropping');
        assert.ok(assembled.tokenCount <= 5000);
        for (let i = 0; i < 15; i++) {
            assert.match(assembled.contextText, new RegExp(`EvidenceAnchor_${i}\\b`));
        }

        // If even unexpanded windows exceed a tight budget (e.g. 100 tokens for 15x14=210), pack complete windows
        const tight = assembleReaderEvidence(selectedWindows, longTurns, {
            maxEvidenceTokens: 100,
            turnExpansion: true
        });
        assert.equal(tight.budgetPolicyTriggered, 'PREFIX_COMPLETE_WINDOWS');
        assert.equal(tight.retainedEntryCount, 7); // 7 * 14 = 98 <= 100
        assert.ok(tight.tokenCount <= 100);
    });

    it('expands windows to full source turns when within token budget', () => {
        const turns = [
            { turnId: 't0', date: '2026-10-01', speaker: 'Alice', content: 'Ticket INC-404 opened for NVLink.' },
            { turnId: 't1', date: '2026-10-02', speaker: 'Bob', content: 'Resolved INC-404 by reseating bridge.' }
        ];
        const selected = [
            { windowId: 'w_a', windowIndex: 0, turnIndices: [1], text: 'Resolved INC-404', tokenCount: 3 }
        ];
        const assembled = assembleReaderEvidence(selected, turns, { maxEvidenceTokens: 5000, turnExpansion: true });
        assert.equal(assembled.turnExpansionApplied, true);
        assert.equal(assembled.budgetPolicyTriggered, 'NONE');
        assert.match(assembled.contextText, /\[Date: 2026-10-02\] Bob: Resolved INC-404 by reseating bridge\./);
    });

    it('computes exact Coverage, Utilization, Uncovered Residual (Eq. 3) and Conditional Path Retention P(path|result)', () => {
        const qaRecords = [
            { covered: true, accurate: 1 },
            { covered: true, accurate: 1 },
            { covered: true, accurate: 0 },
            { covered: false, accurate: 1 },
            { covered: false, accurate: 0 }
        ];
        const metrics = evaluateCoverageAndUtilization(qaRecords);
        assert.equal(metrics.totalQuestions, 5);
        assert.equal(metrics.coverage, 0.6); // 3/5
        assert.equal(metrics.utilization, 0.666667); // 2/3
        assert.equal(metrics.coveredContribution, 0.4); // 2/5
        assert.equal(metrics.uncoveredResidual, 0.2); // 1/5
        assert.equal(metrics.overallAccuracy, 0.6); // 3/5
        assert.equal(metrics.decompositionError, 0);

        const pathRecords = [
            { hasResult: true, hasPath: true },
            { hasResult: true, hasPath: true },
            { hasResult: true, hasPath: false },
            { hasResult: false, hasPath: false }
        ];
        const pathMetrics = evaluateConditionalPathRetention(pathRecords);
        assert.equal(pathMetrics.resultCoverage, 0.75); // 3/4
        assert.equal(pathMetrics.pathCoverage, 0.5); // 2/4
        assert.equal(pathMetrics.conditionalPathGivenResult, 0.666667); // 2/3
    });

    it('supports incremental zero-LLM indexing, causal phase cutoffs, and multi-hop retrieval in createRawRagIndex', async () => {
        const index = createRawRagIndex({
            offline: true,
            windowTokens: 96,
            overlapTokens: 16,
            denseCandidateK: 32,
            finalRerankK: 5,
            maxEvidenceTokens: 2000
        });

        await index.addTurns([
            { turnId: 'p1_a', date: '2026-09-01', speaker: 'User', phase: 1, content: 'Project Aurora uses codename Zephyr-91 and runs on port 4890.' },
            { turnId: 'p1_b', date: '2026-09-02', speaker: 'Assistant', phase: 1, content: 'Acknowledged Zephyr-91 deployment on krusch.' }
        ]);
        const statsAfterPhase1 = index.getStats();
        assert.equal(statsAfterPhase1.llmIngestionCalls, 0);
        assert.equal(statsAfterPhase1.turnCount, 2);

        // Add Phase 2 state update incrementally
        await index.addTurns([
            { turnId: 'p2_a', date: '2026-10-15', speaker: 'User', phase: 2, content: 'We migrated Zephyr-91 from port 4890 to port 5446 during maintenance.' }
        ]);

        // Query restricted to Phase 1 must NOT leak Phase 2 port 5446
        const phase1View = await index.retrieve('What port does Zephyr-91 run on?', { maxPhase: 1 });
        assert.match(phase1View.contextText, /4890/);
        assert.doesNotMatch(phase1View.contextText, /5446/);

        // Full retrieval sees both Phase 1 origin and Phase 2 transition trajectory
        const fullView = await index.retrieve('What port did Zephyr-91 migrate to from 4890?');
        assert.match(fullView.contextText, /4890/);
        assert.match(fullView.contextText, /5446/);
        assert.equal(fullView.llmIngestionCalls, 0);

        // Apply non-destructive write proposal (UPDATE converted to append-only ADD)
        const writeRes = await index.applyWriteProposal({
            action: 'ADD',
            id: 'note_1',
            text: 'Zephyr-91 backup target is /srv/backups'
        });
        assert.equal(writeRes.action, 'ADD');

        const supersedeRes = await index.applyWriteProposal({
            action: 'UPDATE',
            targetId: 'note_1',
            text: 'Zephyr-91 backup target rotated to /srv/backups/zephyr'
        });
        assert.equal(supersedeRes.action, 'ADD');
        assert.equal(supersedeRes.supersedesId, 'note_1');

        const backupQuery = await index.retrieve('Where is the Zephyr-91 backup target?');
        assert.match(backupQuery.contextText, /\/srv\/backups\/zephyr/);
    });

    it('prioritizes calibrated dense semantics over boilerplate lexical overlap and disables sub-span narrowing under domain="law"', async () => {
        assert.equal(LEGAL_BOILERPLATE_STOPWORDS.has('agreement'), true);
        assert.equal(LEGAL_BOILERPLATE_STOPWORDS.has('hereof'), true);
        assert.equal(shouldNarrowCandidateSubSpan(), true);
        assert.equal(shouldNarrowCandidateSubSpan({ domain: 'memory' }), true);
        assert.equal(shouldNarrowCandidateSubSpan({ domain: 'law' }), false);
        assert.equal(shouldNarrowCandidateSubSpan({ domain: 'legal' }), false);
        assert.equal(shouldNarrowCandidateSubSpan({ domain: 'law', allowSubSpanNarrowing: true }), true);

        const legalQuery = 'Does the agreement permit a party or the company to terminate under applicable section terms upon insolvency?';
        // Boilerplate distractor matches every generic legal word ('agreement', 'party', 'company', 'section', 'terms', 'applicable') but has weak dense similarity
        const boilerplatePassage = 'This Agreement sets forth applicable terms between each Party and the Company under Section 1 hereof.';
        // True semantic insolvency clause uses synonymous phrasing ('bankruptcy', 'dissolution', 'rescind') with strong dense cosine
        const semanticClausePassage = 'Either signatory may immediately rescind all obligations upon bankruptcy, receivership, or voluntary dissolution; provided, however, cure periods apply.';

        const defaultBoiler = scoreDeterministicCrossEncoder(legalQuery, boilerplatePassage, 0.22);
        const defaultSemantic = scoreDeterministicCrossEncoder(legalQuery, semanticClausePassage, 0.88);
        assert.ok(defaultBoiler > defaultSemantic, 'conversational default overweights boilerplate word overlap');

        const lawBoiler = scoreDeterministicCrossEncoder(legalQuery, boilerplatePassage, 0.22, { domain: 'law' });
        const lawSemantic = scoreDeterministicCrossEncoder(legalQuery, semanticClausePassage, 0.88, { domain: 'law' });
        assert.ok(lawSemantic > lawBoiler, 'domain="law" ranks true semantic clause ahead of boilerplate distractor');

        const reranked = await rerankCandidateWindows(
            legalQuery,
            [
                { windowId: 'boiler_0', windowIndex: 0, text: boilerplatePassage, denseScore: 0.22 },
                { windowId: 'clause_1', windowIndex: 1, text: semanticClausePassage, denseScore: 0.88 }
            ],
            { topK: 2, offline: true, domain: 'law' }
        );
        assert.equal(reranked[0].windowId, 'clause_1');
    });
});
