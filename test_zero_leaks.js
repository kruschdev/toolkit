import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { applyPublicReleaseTransform, scanTextForLeaks, verifyDirectoryZeroLeaks } from './scripts/verify-zero-leaks.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('INV-LEGO-26: scanTextForLeaks flags secrets, private host IPs, host paths, unlinked emails, and parent file deps', () => {
    const syntheticLeakSample = [
        `const key = "${'sk-' + 'proj-abcdefghijklmnopqrstuvwxyz123456'}";`,
        `const host = "http://${'192.168' + '.1.99'}:11434";`,
        `const tenGb = "http://${'10.10' + '.10.5'}:11434";`,
        `const tail = "${'100.105' + '.10.20'}";`,
        `const p1 = "${'/' + 'home/alice/secrets.json'}";`,
        `const p2 = "${'/' + 'mnt/storage/postgres'}";`,
        `const email = "${'dev@box' + '.local'}";`,
        `"dep": "${'file:' + '../sibling-pkg'}"`
    ].join('\n');

    const findings = scanTextForLeaks(syntheticLeakSample, 'package.json', { strictRelease: true });
    const rules = new Set(findings.map((f) => f.rule));

    assert.ok(rules.has('SECRET_TOKEN'));
    assert.ok(rules.has('PRIVATE_HOST_IP'));
    assert.ok(rules.has('HOST_HOME_PATH'));
    assert.ok(rules.has('HOST_MNT_PATH'));
    assert.ok(rules.has('UNLINKED_GIT_EMAIL'));
    assert.ok(rules.has('PARENT_FILE_DEPENDENCY'));
});

test('INV-LEGO-26: scanTextForLeaks allows RFC subnet CIDR masks, loopback, RFC test vectors, and GitHub noreply attribution', () => {
    const safeSample = [
        '// RFC 1918 Private LAN (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16) & CGNAT (100.64.0.0/10)',
        'const local = "http://127.0.0.1:11434";',
        'const rfcTest = ["10.1.2.3", "172.16.1.2", "100.64.1.2", "198.51.100.10"];',
        'const author = "kruschdev <kruschdev@users.noreply.github.com>";',
        'const repo = "https://github.com/kruschdev/toolkit";'
    ].join('\n');

    const findings = scanTextForLeaks(safeSample, 'security.js', { strictRelease: true });
    assert.deepEqual(findings, []);
});

test('INV-LEGO-26: entire @krusch/toolkit repository and public release transforms pass with 0 findings', () => {
    const res = verifyDirectoryZeroLeaks(__dirname, { strictRelease: false });
    assert.equal(res.ok, true, res.ok ? '' : JSON.stringify(res.error?.details?.findings, null, 2));
    assert.equal(res.data.findings.length, 0);

    for (const rel of ['embeddings.js', 'trajectory-guard.js']) {
        const raw = fs.readFileSync(path.join(__dirname, rel), 'utf8');
        const pub = applyPublicReleaseTransform(raw, rel);
        assert.deepEqual(scanTextForLeaks(pub, rel, { strictRelease: true }), []);
    }
});
