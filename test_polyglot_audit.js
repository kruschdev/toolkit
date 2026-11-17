import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    normalizeGitHubRepoInput,
    auditPolyglotSource,
    auditPolyglotRepository,
} from './polyglot-audit.js';

test('INV-LEGO-PA-01: normalizeGitHubRepoInput normalizes SSH/HTTPS/blob URLs and blocks traversal or reserved GitHub routes', () => {
    const blob = normalizeGitHubRepoInput(
        'https://github.com/expressjs/cors/blob/master/lib/index.js'
    );
    assert.equal(blob.isRemoteCandidate, true);
    assert.equal(blob.repoSlug, 'expressjs/cors');
    assert.equal(blob.cleanHttpsUrl, 'https://github.com/expressjs/cors.git');
    assert.equal(blob.hintedFile, 'lib/index.js');
    assert.equal(blob.invalidGitHubPath, false);

    const scp = normalizeGitHubRepoInput('git@github.com:taniarascia/pdo.git');
    assert.equal(scp.repoSlug, 'taniarascia/pdo');
    assert.equal(scp.invalidGitHubPath, false);

    const reserved = normalizeGitHubRepoInput('https://github.com/settings/tokens');
    assert.equal(reserved.invalidGitHubPath, true);
    assert.equal(reserved.repoSlug, null);

    const traversal = normalizeGitHubRepoInput('https://github.com/owner/repo/../../etc/passwd');
    assert.equal(traversal.invalidGitHubPath, true);
});

test('INV-LEGO-PA-02: auditPolyglotSource & auditPolyglotRepository catch PHP, Java, C#, Go, and JS hazards while blocking sensitive OS paths', () => {
    const phpFindings = auditPolyglotSource(
        `<?php
        session_start();
        $db = new PDO('mysql:host=127.0.0.1;dbname=pos', 'root', '');
        $id = $_GET['id'];
        $total = round($price * 1.0825, 2);
        $rows = $db->query("SELECT * FROM invoices WHERE user_id = $id");
        `,
        'public/checkout.php'
    );
    const phpRules = new Set(phpFindings.map((f) => f.ruleId));
    assert.ok(phpRules.has('php-legacy-session-or-weak-crypto'));
    assert.ok(phpRules.has('php-per-request-pdo-or-sql-leak'));
    assert.ok(phpRules.has('php-unvalidated-superglobal-input'));
    assert.ok(phpRules.has('php-float-currency-math'));
    assert.ok(phpRules.has('php-raw-sql-interpolation'));

    const javaFindings = auditPolyglotSource(
        `public class BillingDao {
           double totalBalance = 19.99;
           public void run(String tenant) throws Exception {
             var md = MessageDigest.getInstance("SHA-1");
             String sql = "SELECT * FROM settlements WHERE tenant = '" + tenant + "'";
           }
         }`,
        'src/main/java/BillingDao.java'
    );
    const javaRules = new Set(javaFindings.map((f) => f.ruleId));
    assert.ok(javaRules.has('polyglot-float-currency-math'));
    assert.ok(javaRules.has('polyglot-weak-crypto-digest'));
    assert.ok(javaRules.has('polyglot-raw-sql-concat'));
    assert.ok(javaRules.has('polyglot-unbounded-select-all'));

    // Sensitive local path blocked fail-closed
    const blockedEtc = auditPolyglotRepository('/etc');
    assert.equal(blockedEtc.ok, false);
    assert.equal(blockedEtc.error.code, 'PATH_BLOCKED');

    // Combined JS + Go brownfield scan
    const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'polyglot-repo-scan-'));
    try {
        fs.mkdirSync(path.join(tmpRepo, 'src'), { recursive: true });
        fs.writeFileSync(
            path.join(tmpRepo, 'src', 'clean.js'),
            "import { okEnvelope } from '@krusch/toolkit/http';\nexport const ping = () => okEnvelope('ping', 'ok', {});\n",
            'utf8'
        );
        fs.writeFileSync(
            path.join(tmpRepo, 'src', 'worker.go'),
            'package worker\nimport "net/http"\nfunc Fetch(u string) { http.Get(u) }\n',
            'utf8'
        );
        const scan = auditPolyglotRepository(tmpRepo);
        assert.equal(scan.ok, true);
        assert.equal(scan.data.scannedFiles, 2);
        assert.equal(scan.data.sealedTouchpoints, 1);
        assert.equal(scan.data.slopFindingCount, 1);
        assert.equal(scan.data.findings[0].ruleId, 'polyglot-unguarded-outbound-http');
        assert.ok(scan.data.recommendedBrickIds.includes('security'));
    } finally {
        fs.rmSync(tmpRepo, { recursive: true, force: true });
    }
});
