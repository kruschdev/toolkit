import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadJsonConfig, envOr, envInt, envBool, validateRequired } from './config.js';

test('loadJsonConfig returns empty object for missing file and parses valid JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'krusch-lib-cfg-'));
    try {
        assert.deepEqual(loadJsonConfig(join(dir, 'nonexistent.json')), {});
        const validPath = join(dir, 'config.json');
        writeFileSync(validPath, JSON.stringify({ port: 4000, debug: true }), 'utf-8');
        assert.deepEqual(loadJsonConfig(validPath), { port: 4000, debug: true });
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('loadJsonConfig throws descriptive error on malformed JSON config file (BUG-01)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'krusch-lib-cfg-err-'));
    try {
        const badPath = join(dir, 'bad-config.json');
        writeFileSync(badPath, '{ invalid json ', 'utf-8');
        assert.throws(
            () => loadJsonConfig(badPath),
            /Failed to load config/
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('envOr, envInt, and envBool resolve fallback hierarchy', () => {
    assert.equal(envOr('__NONEXISTENT_KEY_XYZ__', 'file-val', 'default-val'), 'file-val');
    assert.equal(envInt('__NONEXISTENT_KEY_XYZ__', 42, 10), 42);
    assert.equal(envBool('__NONEXISTENT_KEY_XYZ__', true, false), true);
});

test('validateRequired returns true when required keys exist and throws Error when missing (Pass 4 BUG-01)', () => {
    assert.equal(
        validateRequired({ gemini: { apiKey: 'test-key' }, port: 3000 }, ['gemini.apiKey', 'port']),
        true
    );
    assert.throws(
        () => validateRequired({ gemini: {} }, ['gemini.apiKey', 'db.url']),
        /Missing required config: gemini\.apiKey, db\.url/
    );
    assert.equal(
        validateRequired({ gemini: {} }, ['gemini.apiKey'], { throwOnMissing: false }),
        false
    );
});

test('createMcpServer logs error, closes server, and rethrows when transport connection fails (Pass 5 BUG-01)', async () => {
    const { createMcpServer } = await import('./mcp-server.js');
    let closed = false;
    const mockServer = {
        setRequestHandler() {},
        async connect() {
            throw new Error('simulated transport failure');
        },
        async close() {
            closed = true;
        },
    };
    await assert.rejects(
        () => createMcpServer('test-mcp', '1.0.0', [], async () => ({}), { server: mockServer, transport: {} }),
        /simulated transport failure/
    );
    assert.equal(closed, true);
});
