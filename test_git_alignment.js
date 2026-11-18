import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
    DEFAULT_COCHANGE_RULES,
    normalizeDiffRelativePath,
    extractDiffTouchedFiles,
    parseDiffOldHunks,
    compileSafeCoChangeGlob,
    evaluateCoChangeRules,
    extractCommitCausalRationale
} from './git-alignment.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('@krusch/toolkit/git-alignment — Zero-LLM Diff, Co-Change & Causal Commit Primitives', () => {
    it('maintains Web-Standard purity (zero node:* imports) and keeps lib/harness-engineering.js SHA-256 pin intact', () => {
        const src = fs.readFileSync(path.join(__dirname, 'git-alignment.js'), 'utf8');
        assert.equal(/\bfrom\s+['"]node:/.test(src), false, 'git-alignment.js must remain zero-node:* edge-compatible');

        const heBytes = fs.readFileSync(path.join(__dirname, 'harness-engineering.js'));
        const heSha = crypto.createHash('sha256').update(heBytes).digest('hex');
        assert.equal(
            heSha,
            '50cb250c43d5761a122576ab16241d15c751d20cabef586eac9f401d22535bc4',
            'lib/harness-engineering.js cryptographic benchmark pin must remain untouched'
        );
    });

    it('extracts touched files across standard diffs, C-quoted spaces, copies, and git mv renames while blocking traversal', () => {
        assert.equal(normalizeDiffRelativePath('a/../etc/passwd'), null);
        assert.equal(normalizeDiffRelativePath('/dev/null'), null);
        assert.equal(normalizeDiffRelativePath('"b/src/my file.js"'), 'src/my file.js');

        const diff = [
            'diff --git a/openapi/v1/users.yaml b/openapi/v1/users.yaml',
            '--- a/openapi/v1/users.yaml',
            '+++ b/openapi/v1/users.yaml',
            '@@ -10,3 +10,5 @@',
            'diff --git "a/src/legacy file.js" "b/src/modern file.js"',
            'similarity index 92%',
            'rename from "src/legacy file.js"',
            'rename to "src/modern file.js"',
            'diff --git a/src/template.js b/src/copied.js',
            'copy from src/template.js',
            'copy to src/copied.js',
            'diff --git a/dev/null b/src/new-helper.js',
            '--- /dev/null',
            '+++ b/src/new-helper.js',
            '@@ -0,0 +1,12 @@'
        ].join('\n');

        assert.deepEqual(extractDiffTouchedFiles(diff), [
            'openapi/v1/users.yaml',
            'src/legacy file.js',
            'src/modern file.js',
            'src/template.js',
            'src/copied.js',
            'src/new-helper.js'
        ]);
        assert.deepEqual(parseDiffOldHunks(diff), {
            'openapi/v1/users.yaml': [[10, 12]]
        });
    });

    it('enforces --when / --require companion rules, supports matchSubpaths, and rejects unsupported glob syntax', () => {
        assert.equal(compileSafeCoChangeGlob('{a,b}.js').valid, false);
        assert.equal(compileSafeCoChangeGlob('[abc].js').valid, false);
        assert.equal(compileSafeCoChangeGlob('!secret.js').valid, false);
        assert.equal(compileSafeCoChangeGlob('openapi/**').valid, true);
        assert.equal(Object.isFrozen(DEFAULT_COCHANGE_RULES), true);

        const missing = evaluateCoChangeRules({
            changedFiles: ['openapi/routes/billing.yaml', 'src/billing.js'],
            rules: DEFAULT_COCHANGE_RULES
        });
        assert.equal(missing.ok, false);
        assert.equal(missing.data.violations.length, 1);
        assert.equal(missing.data.violations[0].id, 'COCHANGE-OPENAPI-DOCS');

        const monorepoHit = evaluateCoChangeRules({
            changedFiles: ['projects/billing-api/openapi/routes/billing.yaml'],
            rules: DEFAULT_COCHANGE_RULES,
            matchSubpaths: true
        });
        assert.equal(monorepoHit.ok, false);

        const satisfied = evaluateCoChangeRules({
            changedFiles: ['openapi/routes/billing.yaml', 'CHANGELOG.md'],
            rules: DEFAULT_COCHANGE_RULES
        });
        assert.equal(satisfied.ok, true);
    });

    it('extracts stated causal commit rationales while rejecting Dependabot bumps, trailers, and bare summaries', () => {
        const rationale = extractCommitCausalRationale(
            'fix(http): clamp error status codes to 400-599',
            [
                'Updated lib/error-status.js.',
                '',
                'We clamp 1xx-3xx status codes to 500 because CDN reverse proxies cache 2xx error responses.',
                'Fixes #7089',
                'Signed-off-by: Dev <dev@users.noreply.github.com>'
            ].join('\n')
        );
        assert.equal(
            rationale,
            'We clamp 1xx-3xx status codes to 500 because CDN reverse proxies cache 2xx error responses.'
        );

        const labelled = extractCommitCausalRationale(
            'perf(sqlite): enable WAL synchronous NORMAL',
            'Why: FULL fsync stalls concurrent MCP readers on rotational disks.'
        );
        assert.equal(labelled, 'FULL fsync stalls concurrent MCP readers on rotational disks.');

        // Dependabot bump body -> null
        assert.equal(
            extractCommitCausalRationale(
                'chore(deps): bump ws from 8.17.0 to 8.18.0',
                'Bumps ws from 8.17.0 to 8.18.0 because of new release notes.'
            ),
            null
        );

        // Temporal "since v1.2" without causal clause -> null
        assert.equal(
            extractCommitCausalRationale(
                'refactor(api): clean up helpers',
                'This helper has existed in the codebase since v1.2.'
            ),
            null
        );
    });
});
