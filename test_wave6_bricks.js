import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('INV-LEGO-23: @krusch/toolkit/yaml zero-node:* isomorphic purity, root re-exports, and SHA-256 parity', async () => {
    const yamlSrc = fs.readFileSync(path.join(__dirname, 'yaml.js'), 'utf8');
    assert.equal(
        /\bnode:[a-z_]+/i.test(yamlSrc),
        false,
        'lib/yaml.js must contain zero node:* specifiers (including comments)'
    );

    const yamlMod = await import('./yaml.js');
    const rootMod = await import('./index.js');

    for (const sym of [
        'DEFAULT_YAML_LIMITS',
        'parseSafeYaml',
        'stringifySafeYaml',
        'validateYamlConfig',
        'loadSafeYamlPack'
    ]) {
        assert.equal(typeof yamlMod[sym], sym === 'DEFAULT_YAML_LIMITS' ? 'object' : 'function');
        assert.equal(rootMod[sym], yamlMod[sym], `Expected ${sym} re-exported from lib/index.js`);
    }

    assert.equal(Object.isFrozen(yamlMod.DEFAULT_YAML_LIMITS), true);
    assert.deepEqual(yamlMod.DEFAULT_YAML_LIMITS, {
        maxBytes: 1_048_576,
        maxDepth: 32,
        maxNodes: 10_000,
        maxAliases: 64,
        maxAliasExpansionNodes: 1_000
    });

    // Verify pure-JS FIPS 180-4 SHA-256 matches node:crypto byte-for-byte across ASCII, UTF-8 multibyte, BOM, and >64-byte blocks
    const vectors = [
        '{}',
        'pack_id: "ca-1950-5"\njurisdiction: "CA"\nnotes: "§ 1950.5 — 🛡️⚖️ 東京"\n',
        '\uFEFFpack_id: bom-pack\nitems:\n' + Array.from({ length: 40 }, (_, i) => `  - item_${i}`).join('\n') + '\n'
    ];
    for (const raw of vectors) {
        const expectedSha = crypto.createHash('sha256').update(Buffer.from(raw, 'utf8')).digest('hex');
        const packRes = yamlMod.loadSafeYamlPack(raw);
        assert.equal(packRes.ok, true, `Expected pack load ok for vector: ${JSON.stringify(packRes)}`);
        assert.equal(packRes.data.sha256, expectedSha);
    }
});

test('INV-LEGO-23: parseSafeYaml enforces YAML 1.2 Core types, tag blocks, alias-bomb caps, key guards, and block/flow features', async () => {
    const { parseSafeYaml } = await import('./yaml.js');

    // 1. Input & option validation
    assert.equal(parseSafeYaml(null).error.code, 'YAML_INVALID_INPUT');
    assert.equal(parseSafeYaml(42).error.code, 'YAML_INVALID_INPUT');
    assert.equal(parseSafeYaml('a: 1', { maxBytes: true }).error.code, 'YAML_INVALID_OPTIONS');
    assert.equal(parseSafeYaml('a: 1', { maxDepth: 0 }).error.code, 'YAML_INVALID_OPTIONS');
    assert.equal(parseSafeYaml('a: 1', { maxAliases: -1 }).error.code, 'YAML_INVALID_OPTIONS');
    assert.equal(parseSafeYaml('key: "hello world"', { maxBytes: 8 }).error.code, 'YAML_TOO_LARGE');
    assert.equal(parseSafeYaml(new Uint8Array([0xff, 0xfe, 0xfd])).error.code, 'YAML_PARSE_ERROR');
    assert.equal(parseSafeYaml('a: "bad\x00nul"').error.code, 'YAML_PARSE_ERROR');

    // Uint8Array & ArrayBuffer inputs
    const encoded = new TextEncoder().encode('ok_key: 123\n');
    assert.deepEqual(parseSafeYaml(encoded).data.value, { ok_key: 123 });
    assert.deepEqual(parseSafeYaml(encoded.buffer).data.value, { ok_key: 123 });

    // 2. Arbitrary / explicit tag rejection
    for (const tagged of [
        'cmd: !!python/object/apply:os.system ["id"]',
        'fn: !!js/function "function(){return 1}"',
        'inc: !include /etc/passwd',
        'bin: !!binary SGVsbG8=',
        'ts: !!timestamp 2026-01-01',
        'explicit: !<tag:yaml.org,2002:str> hello',
        '%TAG ! !evil!\n---\na: 1'
    ]) {
        const res = parseSafeYaml(tagged);
        assert.equal(res.ok, false, `Expected tag rejection for: ${tagged}`);
        assert.equal(res.error.code, 'YAML_FORBIDDEN_TAG');
    }

    // 3. Norway-safe booleans, ISO dates as strings, and non-finite rejection
    const coreRes = parseSafeYaml(`
country_no: NO
lower_no: no
word_yes: yes
switch_on: on
switch_off: off
bool_true: true
bool_True: True
bool_FALSE: FALSE
null_tilde: ~
null_empty:
effective_date: 2026-01-01
iso_ts: 2026-10-31T12:00:00Z
hex_val: 0x1a
oct_val: 0o17
float_val: -12.5e2
`);
    assert.equal(coreRes.ok, true, JSON.stringify(coreRes));
    assert.deepEqual(coreRes.data.value, {
        country_no: 'NO',
        lower_no: 'no',
        word_yes: 'yes',
        switch_on: 'on',
        switch_off: 'off',
        bool_true: true,
        bool_True: true,
        bool_FALSE: false,
        null_tilde: null,
        null_empty: null,
        effective_date: '2026-01-01',
        iso_ts: '2026-10-31T12:00:00Z',
        hex_val: 26,
        oct_val: 15,
        float_val: -1250
    });

    for (const nonFinite of ['x: .nan', 'x: .NaN', 'x: .inf', 'x: -.inf', 'x: +.INF', 'x: 999999999999999999999']) {
        const nf = parseSafeYaml(nonFinite);
        assert.equal(nf.ok, false);
        assert.equal(nf.error.code, 'YAML_NONFINITE_NUMBER');
    }

    // 4. Prototype keys, non-string keys, and duplicate keys
    for (const protoYaml of [
        '__proto__:\n  polluted: true',
        'constructor:\n  prototype: {}',
        'prototype: 1',
        'base: &b\n  __proto__: 1\nout:\n  <<: *b'
    ]) {
        const pr = parseSafeYaml(protoYaml);
        assert.equal(pr.ok, false);
        assert.equal(pr.error.code, 'YAML_FORBIDDEN_KEY');
    }
    assert.equal(({}).polluted, undefined);

    assert.equal(parseSafeYaml('123: numeric_key').error.code, 'YAML_INVALID_KEY');
    assert.equal(parseSafeYaml('true: bool_key').error.code, 'YAML_INVALID_KEY');
    assert.equal(parseSafeYaml('dup: 1\ndup: 2').error.code, 'YAML_DUPLICATE_KEY');

    // 5. Billion-Laughs alias bomb, depth, node caps, merge precedence & deep-clone isolation
    const lolBomb = [
        'a0: &a0 [1, 2, 3, 4]',
        'a1: &a1 [*a0, *a0, *a0, *a0]',
        'a2: &a2 [*a1, *a1, *a1, *a1]',
        'a3: &a3 [*a2, *a2, *a2, *a2]',
        'a4: &a4 [*a3, *a3, *a3, *a3]',
        'a5: [*a4, *a4, *a4, *a4]'
    ].join('\n');
    assert.equal(parseSafeYaml(lolBomb, { maxAliasExpansionNodes: 200 }).error.code, 'YAML_ALIAS_BOMB');
    assert.equal(parseSafeYaml('a: &a [1]\nb: [*a, *a, *a]', { maxAliases: 2 }).error.code, 'YAML_ALIAS_BOMB');
    assert.equal(parseSafeYaml('ref: *missing').error.code, 'YAML_UNKNOWN_ALIAS');
    assert.equal(parseSafeYaml('a:\n  b:\n    c:\n      d: 1', { maxDepth: 3 }).error.code, 'YAML_MAX_DEPTH');
    assert.equal(parseSafeYaml('items: [1, 2, 3, 4, 5, 6]', { maxNodes: 4 }).error.code, 'YAML_MAX_NODES');

    const mergeRes = parseSafeYaml(`
p1: &p1
  shared: from_p1
  only_p1: 10
  nested:
    arr: [1, 2]
p2: &p2
  shared: from_p2
  only_p2: 20
  override_me: old
child:
  <<: [*p1, *p2]
  override_me: explicit_wins
`);
    assert.equal(mergeRes.ok, true, JSON.stringify(mergeRes));
    assert.equal(mergeRes.data.value.child.shared, 'from_p1');
    assert.equal(mergeRes.data.value.child.only_p1, 10);
    assert.equal(mergeRes.data.value.child.only_p2, 20);
    assert.equal(mergeRes.data.value.child.override_me, 'explicit_wins');
    mergeRes.data.value.child.nested.arr.push(99);
    assert.deepEqual(mergeRes.data.value.p1.nested.arr, [1, 2], 'Alias dereference must deep-clone subtrees');

    // 6. Block scalars, compact sequences, quotes, and multi-document flag
    const complexRes = parseSafeYaml(`---
literal_clip: |
  line one
  line two

literal_strip: |-
  no trailing newline

literal_keep: |+
  keep two newlines

folded_strip: >-
  folded paragraph
  same line

  second paragraph
rules:
  - id: R-01
    quotes: 'single ''escaped'''
    unicode: "snowman \\u2603 rocket \\U0001F680"
  - - nested_seq_a
    - nested_seq_b
flow: { k1: [1, 2,], k2: "colon: inside" }
...`);
    assert.equal(complexRes.ok, true, JSON.stringify(complexRes));
    assert.equal(complexRes.data.value.literal_clip, 'line one\nline two\n');
    assert.equal(complexRes.data.value.literal_strip, 'no trailing newline');
    assert.equal(complexRes.data.value.literal_keep, 'keep two newlines\n\n');
    assert.equal(complexRes.data.value.folded_strip, 'folded paragraph same line\nsecond paragraph');
    assert.equal(complexRes.data.value.rules[0].quotes, "single 'escaped'");
    assert.equal(complexRes.data.value.rules[0].unicode, 'snowman \u2603 rocket \u{1F680}');
    assert.deepEqual(complexRes.data.value.rules[1], ['nested_seq_a', 'nested_seq_b']);

    assert.equal(parseSafeYaml('---\na: 1\n---\nb: 2').error.code, 'YAML_MULTIPLE_DOCUMENTS');
    const multiRes = parseSafeYaml('---\na: 1\n---\nb: 2', { allowMultipleDocuments: true });
    assert.equal(multiRes.ok, true);
    assert.deepEqual(multiRes.data.value, [{ a: 1 }, { b: 2 }]);
});

test('INV-LEGO-23: stringifySafeYaml, validateYamlConfig, loadSafeYamlPack & krusch-authority-packs parity', async () => {
    const { parseSafeYaml, stringifySafeYaml, validateYamlConfig, loadSafeYamlPack } = await import('./yaml.js');
    const { s } = await import('./schema.js');

    const trickyValue = {
        ambiguous: ['NO', 'true', 'false', 'null', '~', '2026-01-01', '42', '', 'a: b', 'val # hash', '- item'],
        multiline: 'alpha\nbeta\ngamma\n',
        numbers: [0, -42, 3.14159],
        flags: [true, false, null]
    };
    const dumped = stringifySafeYaml(trickyValue);
    assert.equal(dumped.ok, true, JSON.stringify(dumped));
    const reparsed = parseSafeYaml(dumped.data.yaml);
    assert.equal(reparsed.ok, true, JSON.stringify(reparsed));
    assert.deepEqual(reparsed.data.value, trickyValue);

    const cyclic = { a: 1 };
    cyclic.self = cyclic;
    assert.equal(stringifySafeYaml(cyclic).error.code, 'YAML_STRINGIFY_ERROR');
    assert.equal(stringifySafeYaml(Number.NaN).error.code, 'YAML_STRINGIFY_ERROR');
    assert.equal(stringifySafeYaml(10n).error.code, 'YAML_STRINGIFY_ERROR');
    assert.equal(stringifySafeYaml(undefined).error.code, 'YAML_STRINGIFY_ERROR');
    assert.equal(stringifySafeYaml({ constructor: 'bad' }).error.code, 'YAML_FORBIDDEN_KEY');

    const cfgSchema = s.object({
        host: s.string(),
        port: s.number({ int: true, min: 1, max: 65535 })
    });
    const validCfg = validateYamlConfig('host: 127.0.0.1\nport: 8085\n', cfgSchema);
    assert.equal(validCfg.ok, true);
    assert.deepEqual(validCfg.data.value, { host: '127.0.0.1', port: 8085 });
    assert.equal(validateYamlConfig('host: 127.0.0.1\nport: "not-an-int"\n', cfgSchema).ok, false);

    assert.equal(loadSafeYamlPack('- list_root').error.code, 'YAML_INVALID_PACK');
    assert.equal(
        loadSafeYamlPack('pack_id: p1\n', { requiredKeys: ['pack_id', 'jurisdiction'] }).error.code,
        'YAML_MISSING_REQUIRED_KEYS'
    );

    // Real statutory packs in projects/krusch-authority-packs
    const packsRoot = path.resolve(__dirname, '../projects/krusch-authority-packs');
    if (fs.existsSync(packsRoot)) {
        const yamlFiles = [];
        const walk = (dir) => {
            for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
                if (ent.name.startsWith('.') || ent.name === 'node_modules' || ent.name === '.venv') continue;
                const full = path.join(dir, ent.name);
                if (ent.isDirectory()) walk(full);
                else if (/\.ya?ml$/i.test(ent.name)) yamlFiles.push(full);
            }
        };
        walk(packsRoot);
        assert.ok(yamlFiles.length >= 10, `Expected >=10 YAML files in krusch-authority-packs, found ${yamlFiles.length}`);
        for (const fp of yamlFiles) {
            const rawBytes = fs.readFileSync(fp);
            const expectedSha = crypto.createHash('sha256').update(rawBytes).digest('hex');
            const res = loadSafeYamlPack(new Uint8Array(rawBytes));
            assert.equal(res.ok, true, `Failed to load authority pack ${fp}: ${JSON.stringify(res)}`);
            assert.equal(res.data.sha256, expectedSha);
        }
    }
});

test('INV-LEGO-23..24 & Rule 10: catalog registers 35 bricks, enforces unsafe-yaml-load, and workspace achieves 100% Rule-of-3 coverage', async () => {
    const { getLegoBrick, auditBoilerplateText } = await import('./catalog.js');
    const { scoutHomelabLegoCandidates } = await import('./lego-scout.js');

    for (const [id, runtime, importPath] of [
        ['yaml', 'node', '@krusch/toolkit/yaml'],
        ['python_yaml', 'python', 'krusch_toolkit.yaml_loader'],
        ['python_db_async', 'python', 'krusch_toolkit.db_async']
    ]) {
        const brick = getLegoBrick(id);
        assert.ok(brick, `Missing brick ${id}`);
        assert.equal(brick.runtime, runtime);
        assert.equal(brick.importPath, importPath);

        const cliOut = execFileSync(
            process.execPath,
            [path.join(__dirname, 'bin/krusch-lego.js'), 'inspect', id, '--json'],
            { encoding: 'utf8' }
        );
        const parsed = JSON.parse(cliOut);
        assert.equal(parsed.ok, true);
        assert.equal(parsed.data.brick.id, id);
    }

    // Rule 10 positive cases (must trigger unsafe-yaml-load)
    for (const [code, fp, expectedBrick] of [
        ['import yaml\ncfg = yaml.load(raw_text)\n', 'service/config.py', 'python_yaml'],
        ['import yaml\ncfg = yaml.unsafe_load(raw_text)\n', 'service/config.py', 'python_yaml'],
        ['import yaml\ncfg = yaml.full_load(raw_text)\n', 'service/config.py', 'python_yaml'],
        ['import yaml\ncfg = yaml.load("SafeLoader: spoofed")\n', 'service/config.py', 'python_yaml'],
        ['import yaml\ncfg = yaml.load(raw_text)\n', '', 'python_yaml'],
        ["import yaml from 'js-yaml';\nexport const cfg = yaml.load(raw);\n", 'src/cfg.js', 'yaml'],
        ["const y = require('js-yaml');\nmodule.exports = y.loadAll(raw);\n", 'src/cfg.cjs', 'yaml'],
        ["const cfg = require('js-yaml').load(raw);\n", 'src/cfg.js', 'yaml'],
        ["import { load as parseY } from 'js-yaml';\nexport const c = parseY(raw);\n", 'src/cfg.ts', 'yaml']
    ]) {
        const audit = auditBoilerplateText(code, fp);
        const hit = audit.data.findings.find((f) => f.ruleId === 'unsafe-yaml-load');
        assert.ok(hit, `Expected unsafe-yaml-load for ${fp || 'inline-py'}: ${code}`);
        assert.equal(hit.brickId, expectedBrick);
    }

    // Rule 10 negative cases (must NOT false-positive)
    for (const [code, fp] of [
        ['import yaml\ncfg = yaml.safe_load(raw_text)\n', 'service/safe.py'],
        ['import yaml\ncfg = yaml.load(\n    raw_text,\n    Loader=yaml.SafeLoader,\n)\n', 'service/safe_ml.py'],
        ['import yaml\ncfg = yaml.load(raw_text, yaml.CSafeLoader)\n', 'service/csafe.py'],
        ['"""Never call yaml.load(raw) or yaml.unsafe_load(x)."""\nx = 1\n', 'service/doc.py'],
        ['from krusch_toolkit.yaml_loader import parse_safe_yaml\nimport yaml\ncfg = parse_safe_yaml(raw)\n', 'service/adopted.py'],
        ["import yaml from 'js-yaml';\nexport const out = yaml.dump({ a: 1 });\nwindow.load();\n", 'src/dump.js'],
        ['const prompt = `Never do import yaml from \'js-yaml\'; yaml.load(x)`;\n', 'src/prompts.js'],
        ["import { parseSafeYaml } from '@krusch/toolkit/yaml';\nexport const c = parseSafeYaml(raw);\n", 'src/adopted.js']
    ]) {
        const audit = auditBoilerplateText(code, fp);
        assert.equal(
            audit.data.findings.some((f) => f.ruleId === 'unsafe-yaml-load'),
            false,
            `Unexpected unsafe-yaml-load false positive on ${fp}: ${JSON.stringify(audit.data.findings)}`
        );
    }

    // Hermetic scout check: adopted Wave-6 bricks exempted + FastAPI file with unsafe yaml.load still caught!
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lego-scout-w6-'));
    try {
        const adoptedDir = path.join(tmpRoot, 'adopted-svc');
        fs.mkdirSync(adoptedDir, { recursive: true });
        fs.writeFileSync(
            path.join(adoptedDir, 'app.py'),
            'from krusch_toolkit import create_managed_async_engine, load_safe_yaml_pack\n',
            'utf8'
        );
        fs.writeFileSync(
            path.join(adoptedDir, 'pack.js'),
            "import { loadSafeYamlPack } from '@krusch/toolkit/yaml';\nexport const p = loadSafeYamlPack('a: 1');\n",
            'utf8'
        );

        const unsafeFastapiDir = path.join(tmpRoot, 'unsafe-fastapi-svc');
        fs.mkdirSync(unsafeFastapiDir, { recursive: true });
        fs.writeFileSync(
            path.join(unsafeFastapiDir, 'main.py'),
            'from krusch_toolkit.fastapi_app import create_fastapi_app\nimport yaml\ncfg = yaml.load("a: 1")\n',
            'utf8'
        );

        const hermeticScout = scoutHomelabLegoCandidates(tmpRoot, { minProjects: 3, portablePaths: true });
        assert.equal(hermeticScout.ok, true);
        assert.equal(
            hermeticScout.data.candidateClusters.some((c) => c.projects.includes('adopted-svc')),
            false,
            'Adopted Wave-6 bricks must not trigger raw source detectors'
        );
        const adoptHit = hermeticScout.data.adoptionFindings.find((f) => f.project === 'unsafe-fastapi-svc');
        assert.ok(adoptHit, 'Expected unsafe yaml.load inside FastAPI toolkit file to be caught');
        assert.ok(adoptHit.rulesTriggered.includes('unsafe-yaml-load'));
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }

    // Live workspace check: 0 uncovered CANDIDATE_MEETS_RULE_OF_3 clusters across all homelab projects!
    const liveProjectsDir = path.resolve(__dirname, '../projects');
    if (fs.existsSync(liveProjectsDir)) {
        const liveScout = scoutHomelabLegoCandidates(liveProjectsDir, { minProjects: 3, portablePaths: true });
        assert.equal(liveScout.ok, true);
        const uncovered = liveScout.data.candidateClusters.filter((c) => c.status === 'CANDIDATE_MEETS_RULE_OF_3');
        assert.deepEqual(
            uncovered,
            [],
            `Expected 0 remaining CANDIDATE_MEETS_RULE_OF_3 clusters across workspace, got: ${JSON.stringify(uncovered)}`
        );
    }
});

test('INV-LEGO-23 Referee regressions: compact nested mappings, YAML 1.2 010/+.nan/flow strictness, hostile getters/detached buffers, and CJS js-yaml alias', async () => {
    const { parseSafeYaml, stringifySafeYaml, validateYamlConfig, loadSafeYamlPack } = await import('./yaml.js');
    const { auditBoilerplateText } = await import('./catalog.js');
    const { scoutHomelabLegoCandidates } = await import('./lego-scout.js');

    // 1. W6-R2-02: Compact sequence-of-mappings & anchored/quoted flow lookahead
    const nestedCompact = parseSafeYaml('- - key: val\n    key2: val2\n- &anch { k: 1, q: \'it\'\'s: ok\' }\n- *anch\n');
    assert.equal(nestedCompact.ok, true, JSON.stringify(nestedCompact));
    assert.deepEqual(nestedCompact.data.value, [
        [{ key: 'val', key2: 'val2' }],
        { k: 1, q: "it's: ok" },
        { k: 1, q: "it's: ok" }
    ]);

    // 2. W6-R2-03 & W6-REF1-05: YAML 1.2 base-10 leading-zero ints and signed .nan
    const leadZero = parseSafeYaml('oct_legacy: 010\nneg_zero_lead: -007\n');
    assert.equal(leadZero.ok, true);
    assert.deepEqual(leadZero.data.value, { oct_legacy: 10, neg_zero_lead: -7 });
    assert.equal(parseSafeYaml('x: +.nan').error.code, 'YAML_NONFINITE_NUMBER');
    assert.equal(parseSafeYaml('x: -.NaN').error.code, 'YAML_NONFINITE_NUMBER');

    // 3. Serializer round-trip for '... a', '--- a', '+.nan', '-.nan'
    const roundTripEdge = {
        doc_end_prefix: '... trailing',
        doc_start_prefix: '--- leading',
        plus_nan_str: '+.nan',
        minus_nan_str: '-.nan',
        leading_zero_str: '010'
    };
    const serializedEdge = stringifySafeYaml(roundTripEdge);
    assert.equal(serializedEdge.ok, true);
    const reparsedEdge = parseSafeYaml(serializedEdge.data.yaml);
    assert.equal(reparsedEdge.ok, true, JSON.stringify(reparsedEdge));
    assert.deepEqual(reparsedEdge.data.value, roundTripEdge);

    // 4. Flow collection strictness (empty comma entries, indicator-started scalars, explicit '?' keys)
    for (const badFlow of ['[,]', '[1, , 2]', '{,}', '{ a: 1, , b: 2 }', '[ - a ]', '[ ? a ]', '[ : ]']) {
        const res = parseSafeYaml(badFlow);
        assert.equal(res.ok, false, `Expected flow parse rejection for: ${badFlow}`);
        assert.equal(res.error.code, 'YAML_PARSE_ERROR');
    }
    assert.equal(parseSafeYaml('{ ? 123 : 1 }').error.code, 'YAML_INVALID_KEY');
    const explicitFlowKey = parseSafeYaml('{ ? alpha : 1, ? beta }');
    assert.equal(explicitFlowKey.ok, true, JSON.stringify(explicitFlowKey));
    assert.deepEqual(explicitFlowKey.data.value, { alpha: 1, beta: null });
    assert.deepEqual(parseSafeYaml('[-1, -3.14, -abc]').data.value, [-1, -3.14, '-abc']);

    // 5. W6-REF1-03: Detached ArrayBuffers & hostile throwing getters/Proxies never throw uncaught
    if (typeof ArrayBuffer.prototype.transfer === 'function') {
        const buf = new ArrayBuffer(8);
        const view = new Uint8Array(buf);
        buf.transfer();
        assert.equal(parseSafeYaml(buf).error.code, 'YAML_INVALID_INPUT');
        assert.equal(parseSafeYaml(view).error.code, 'YAML_INVALID_INPUT');
    }

    const hostileInput = {
        get [Symbol.toStringTag]() {
            throw new Error('hostile toStringTag boom');
        }
    };
    assert.equal(parseSafeYaml(hostileInput).ok, false);

    const makeHostileOptions = () =>
        Object.defineProperty({}, 'maxBytes', {
            enumerable: true,
            get() {
                throw new Error('hostile option getter');
            }
        });
    const makeHostileStringifyOptions = () =>
        Object.defineProperty({}, 'indent', {
            enumerable: true,
            get() {
                throw new Error('hostile indent getter');
            }
        });
    assert.equal(parseSafeYaml('a: 1', makeHostileOptions()).error.code, 'YAML_INVALID_OPTIONS');
    assert.equal(stringifySafeYaml({ a: 1 }, makeHostileStringifyOptions()).error.code, 'YAML_INVALID_OPTIONS');
    assert.equal(validateYamlConfig('a: 1', {}, makeHostileOptions()).error.code, 'YAML_INVALID_OPTIONS');
    assert.equal(loadSafeYamlPack('a: 1', makeHostileOptions()).error.code, 'YAML_INVALID_OPTIONS');

    // 6. W6-REF1-07: CommonJS destructured alias `const { load: parseYaml } = require('js-yaml')`
    const cjsAliased = "const { load: parseYaml } = require('js-yaml');\nmodule.exports = parseYaml(raw);\n";
    const cjsAudit = auditBoilerplateText(cjsAliased, 'src/cjs-loader.cjs');
    assert.equal(cjsAudit.data.findings.some((f) => f.ruleId === 'unsafe-yaml-load'), true);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lego-cjs-yaml-'));
    try {
        const svcDir = path.join(tmpDir, 'cjs-yaml-svc');
        fs.mkdirSync(svcDir, { recursive: true });
        fs.writeFileSync(path.join(svcDir, 'loader.js'), cjsAliased, 'utf8');
        const scoutRes = scoutHomelabLegoCandidates(tmpDir, { minProjects: 3, portablePaths: true });
        assert.equal(scoutRes.ok, true);
        const hit = scoutRes.data.adoptionFindings.find((f) => f.project === 'cjs-yaml-svc');
        assert.ok(hit, 'Expected scoutHomelabLegoCandidates prefilter to reach CJS aliased js-yaml load');
        assert.ok(hit.rulesTriggered.includes('unsafe-yaml-load'));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // 7. W6-REF4-01: Lone UTF-16 surrogates fail closed with YAML_STRINGIFY_ERROR while valid astral pairs round-trip
    for (const badPayload of [
        'foo\ud800bar',
        'foo\udc00bar',
        'trailing\udbff',
        { val: 'foo\ud800bar' },
        { val: 'foo\udfffbar' },
        { 'bad\ud800key': 1 },
        { 'bad\udc00key': 1 }
    ]) {
        const loneRes = stringifySafeYaml(badPayload);
        assert.equal(loneRes.ok, false, 'Expected lone surrogate to be rejected');
        assert.equal(loneRes.error.code, 'YAML_STRINGIFY_ERROR');
    }

    const validAstral = { emoji: '🛡️🚀', c1_and_nonchar: 'x\u0080\ufffey' };
    const astralOut = stringifySafeYaml(validAstral);
    assert.equal(astralOut.ok, true, JSON.stringify(astralOut));
    const astralParsed = parseSafeYaml(astralOut.data.yaml);
    assert.equal(astralParsed.ok, true, JSON.stringify(astralParsed));
    assert.deepEqual(astralParsed.data.value, validAstral);

    // 8. W6-REF5-01: Reject unquoted ': ' in inline mapping values & invalid same-line block collections; allow anchored indentless sequences
    for (const badInlineBlock of [
        'title: Warning: disk full\n',
        'a: - item\n',
        'a: &anch k: 1\n',
        'a: &anch - item\n',
        '--- a: 1\n',
        '--- - a\n',
        '--- &anch a: 1\n',
        '- &anch - a\n'
    ]) {
        const res = parseSafeYaml(badInlineBlock);
        assert.equal(res.ok, false, `Expected YAML_PARSE_ERROR for: ${JSON.stringify(badInlineBlock)}`);
        assert.equal(res.error.code, 'YAML_PARSE_ERROR');
    }

    const anchoredIndentless = parseSafeYaml('a: &anch\n- item\nb: *anch\n');
    assert.equal(anchoredIndentless.ok, true, JSON.stringify(anchoredIndentless));
    assert.deepEqual(anchoredIndentless.data.value, { a: ['item'], b: ['item'] });

    const docRootAnchored = parseSafeYaml('--- &root\na: 1\n');
    assert.equal(docRootAnchored.ok, true, JSON.stringify(docRootAnchored));
    assert.deepEqual(docRootAnchored.data.value, { a: 1 });

    // 9. SRE-W6-01: Inline '#' comments terminate plain scalars (never fold subsequent lines) & implicit keys stay single-line
    for (const badCommentFold of [
        'enabled: false # prod\n  note\n',
        'a:\n  one\n  two # comment\n  three\n',
        '[alpha # comment\n beta]',
        '{ a # comment\n : 1 }',
        '{ "a" # comment\n : 1 }',
        '{ &k\n a: 1 }',
        '"multi\nline": 1\n'
    ]) {
        const res = parseSafeYaml(badCommentFold);
        assert.equal(res.ok, false, `Expected YAML_PARSE_ERROR for: ${JSON.stringify(badCommentFold)}`);
        assert.equal(res.error.code, 'YAML_PARSE_ERROR');
    }

    assert.deepEqual(parseSafeYaml('enabled: false # prod\nb: 2\n').data.value, { enabled: false, b: 2 });
    assert.deepEqual(parseSafeYaml('[alpha # comment\n , beta]').data.value, ['alpha', 'beta']);
    assert.deepEqual(parseSafeYaml('{"a": "\\ud83d\\ude80"}').data.value, { a: '🚀' });
});




