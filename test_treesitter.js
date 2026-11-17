import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    TREE_SITTER_GRAMMAR_BY_EXTENSION,
    SUPPORTED_TREESITTER_EXTENSIONS,
    initTreeSitterRuntime,
    isTreeSitterReady,
    resolveTreeSitterLanguage,
    analyzeFileWithTreeSitter,
    extractTreeSitterSymbolsAndImports,
} from './treesitter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEADBOLT_ROOT = path.resolve(__dirname, '..', 'projects', 'deadbolt');

test('INV-LEGO-TS-01: @krusch/toolkit/treesitter maps all 14 enterprise extensions across 11 WASM grammars and fails gracefully when uninitialized', () => {
    assert.equal(SUPPORTED_TREESITTER_EXTENSIONS.length, 14);
    assert.equal(resolveTreeSitterLanguage('src/billing/fee-engine.ts'), 'typescript');
    assert.equal(resolveTreeSitterLanguage('app/views/Checkout.tsx'), 'tsx');
    assert.equal(resolveTreeSitterLanguage('services/BillingService.cs'), 'c_sharp');
    assert.equal(resolveTreeSitterLanguage('app/models/invoice.rb'), 'ruby');
    assert.equal(resolveTreeSitterLanguage('src/main/kotlin/Ledger.kt'), 'kotlin');
    assert.equal(resolveTreeSitterLanguage('README.md'), null);
    assert.equal(Object.keys(TREE_SITTER_GRAMMAR_BY_EXTENSION).length, 14);

    // Unsupported extension always returns okEnvelope({ supported: false }) even before init
    const mdRes = analyzeFileWithTreeSitter('# Heading\n', 'docs/ADR-001.md');
    assert.equal(mdRes.ok, true);
    assert.equal(mdRes.data.supported, false);
});

test('INV-LEGO-TS-02: @krusch/toolkit/treesitter loads WASM grammars and parses JS/TS, Python, Go, Rust, Java, C#, PHP, Ruby, and Kotlin CSTs', async (t) => {
    if (!fs.existsSync(path.join(DEADBOLT_ROOT, 'node_modules', 'web-tree-sitter'))) {
        const graceful = await initTreeSitterRuntime({ searchRoots: [__dirname] });
        assert.equal(graceful.ok, false);
        assert.equal(graceful.error.code, 'TREESITTER_WASM_UNAVAILABLE');
        t.skip('Optional web-tree-sitter not installed in sibling workspace');
        return;
    }

    const initRes = await initTreeSitterRuntime({ searchRoots: [DEADBOLT_ROOT] });
    assert.equal(initRes.ok, true);
    assert.equal(isTreeSitterReady(), true);
    assert.equal(initRes.data.grammars.length, 11);

    // 1. TypeScript
    const tsRes = analyzeFileWithTreeSitter(
        "import { roundFee } from './math.js';\nexport interface FeeQuote { cents: number; }\nexport const computePartnerFee = (gross: number): FeeQuote => ({ cents: roundFee(gross) });\n",
        'src/fee-engine.ts'
    );
    assert.equal(tsRes.ok, true);
    assert.equal(tsRes.data.language, 'typescript');
    assert.deepEqual(
        tsRes.data.symbols.map((s) => `${s.symbol_type}:${s.symbol_name}`),
        ['interface:FeeQuote', 'function:computePartnerFee']
    );
    assert.equal(tsRes.data.imports[0].specifier, './math.js');
    assert.ok(tsRes.data.calls.includes('roundFee'));

    // 2. C#
    const csRes = analyzeFileWithTreeSitter(
        'using System.Linq;\nnamespace Billing.Ledger;\npublic record SettlementBatch(int TotalCents) {\n  public int Reconcile() => VerifyBatch(TotalCents);\n}\n',
        'SettlementBatch.cs'
    );
    assert.equal(csRes.ok, true);
    assert.deepEqual(csRes.data.namespaces, ['Billing.Ledger']);
    assert.ok(csRes.data.symbols.some((s) => s.symbol_name === 'SettlementBatch' && s.symbol_type === 'record'));
    assert.ok(csRes.data.symbols.some((s) => s.symbol_name === 'Reconcile'));
    assert.ok(csRes.data.calls.includes('VerifyBatch'));

    // 3. PHP + Ruby + Kotlin + Rust chunker adapter
    const phpChunk = extractTreeSitterSymbolsAndImports(
        "<?php\nnamespace App\\Billing;\nrequire_once 'ledger.php';\nclass InvoiceCalculator {\n  public function totalCents($items) { return sumItems($items); }\n}\n",
        'src/InvoiceCalculator.php'
    );
    assert.ok(phpChunk);
    assert.ok(phpChunk.symbols.some((s) => s.name === 'InvoiceCalculator' && s.type === 'class'));
    assert.ok(phpChunk.symbols.some((s) => s.name === 'totalCents' && s.type === 'method'));
    assert.equal(phpChunk.imports[0].targetPath, 'ledger.php');
    assert.equal(phpChunk.imports[0].relation, 'requires');

    const rbChunk = extractTreeSitterSymbolsAndImports(
        "require_relative 'tax_policy'\nmodule Billing\n  class Reconciler\n    def audit_batch(batch)\n      TaxPolicy.verify(batch)\n    end\n  end\nend\n",
        'lib/reconciler.rb'
    );
    assert.ok(rbChunk);
    assert.ok(rbChunk.symbols.some((s) => s.name === 'Reconciler' && s.type === 'class'));
    assert.ok(rbChunk.symbols.some((s) => s.name === 'audit_batch' && s.type === 'function'));
    assert.equal(rbChunk.imports[0].targetPath, 'tax_policy');

    const ktChunk = extractTreeSitterSymbolsAndImports(
        'package dev.krusch.ledger\nimport dev.krusch.core.Money\nclass LedgerGuard {\n  fun verifyZeroCent(delta: Int): Boolean = Money.check(delta)\n}\n',
        'src/main/kotlin/LedgerGuard.kt'
    );
    assert.ok(ktChunk);
    assert.ok(ktChunk.symbols.some((s) => s.name === 'LedgerGuard' && s.type === 'class'));
    assert.ok(ktChunk.symbols.some((s) => s.name === 'verifyZeroCent' && s.type === 'function'));
    assert.equal(ktChunk.imports[0].targetPath, 'dev.krusch.core.Money');
});
