import test from 'node:test';
import assert from 'node:assert/strict';
import {
    connectBrowserOverCdp,
    createInputRedactor,
    createBrowserControlLease,
    scrapeHtml,
    captureScreenshot,
    DEFAULT_REDACTION_MARKER
} from './browser.js';

test('connectBrowserOverCdp validates loopback safety and normalizes HTTP & WS CDP endpoints', async () => {
    let capturedPayload = null;
    const fakeBrowser = { disconnect: async () => {} };

    const resHttp = await connectBrowserOverCdp('http://127.0.0.1:9222/', {
        connectFn: async (opts) => {
            capturedPayload = opts;
            return fakeBrowser;
        }
    });
    assert.equal(resHttp, fakeBrowser);
    assert.deepEqual(capturedPayload, {
        browserURL: 'http://127.0.0.1:9222',
        defaultViewport: null
    });

    await connectBrowserOverCdp('ws://localhost:9222/devtools/browser/abc-123', {
        defaultViewport: { width: 1440, height: 900 },
        connectFn: async (opts) => {
            capturedPayload = opts;
            return fakeBrowser;
        }
    });
    assert.deepEqual(capturedPayload, {
        browserWSEndpoint: 'ws://localhost:9222/devtools/browser/abc-123',
        defaultViewport: { width: 1440, height: 900 }
    });

    await assert.rejects(
        () => connectBrowserOverCdp('http://198.51.100.10:9222', { connectFn: async () => fakeBrowser }),
        /Refusing non-loopback CDP endpoint/
    );

    await connectBrowserOverCdp('http://198.51.100.10:9222', {
        allowRemote: true,
        connectFn: async (opts) => {
            capturedPayload = opts;
            return fakeBrowser;
        }
    });
    assert.equal(capturedPayload.browserURL, 'http://198.51.100.10:9222');
});

test('createInputRedactor scrubs typed/pasted secrets (>=4 chars), masks password nodes, blocks screenshots, and fails closed on saturation', () => {
    const redactor = createInputRedactor({ minLength: 4, maxBytes: 128 });
    assert.equal(redactor.screenshotsAllowed(), true);

    redactor.recordInput('ab'); // shorter than minLength=4 -> ignored
    redactor.recordInput('Sup3rV4ult#99', { includeSubstrings: true });
    redactor.markHumanTakeover();

    assert.equal(redactor.screenshotsAllowed(), false);
    assert.equal(
        redactor.scrubText('Token echoed: Sup3rV4ult#99 and partial V4ul inside DOM'),
        `Token echoed: ${DEFAULT_REDACTION_MARKER} and partial ${DEFAULT_REDACTION_MARKER} inside DOM`
    );

    const scrubbedTree = redactor.scrubValue({
        title: 'Sign in',
        fields: [
            { role: 'textbox', name: 'username', value: 'operator' },
            { role: 'password', name: 'secret', value: 'xy' } // even 2-char password field value is masked structurally
        ]
    });
    assert.equal(scrubbedTree.ok, true);
    assert.equal(scrubbedTree.screenshotsAllowed, false);
    assert.equal(scrubbedTree.data.fields[0].value, 'operator');
    assert.equal(scrubbedTree.data.fields[1].value, DEFAULT_REDACTION_MARKER);

    // Overflow maxBytes=128 -> fail-closed saturation
    redactor.recordInput('X'.repeat(200));
    assert.equal(redactor.getState().saturated, true);
    const saturatedOut = redactor.scrubValue({ html: 'anything' });
    assert.equal(saturatedOut.ok, false);
    assert.equal(saturatedOut.saturated, true);
    assert.equal(saturatedOut.data, null);
});

test('createBrowserControlLease enforces exclusive HITL takeover, waitForAgentControl handoff, and post-takeover screenshot blocking', async () => {
    const events = [];
    const lease = createBrowserControlLease({
        sessionId: 'sess-hitl-1',
        onNeedsHuman: (ev) => events.push(ev)
    });

    assert.equal(lease.assertAgentCanAct('click'), true);
    assert.equal(lease.assertScreenshotAllowed(), true);

    await lease.requestHuman('2FA TOTP required', { url: 'https://example.com/2fa' });
    assert.equal(events.length, 1);
    assert.equal(events[0].reason, '2FA TOTP required');
    assert.equal(lease.getStatus().status, 'needs_human');

    // Agent is blocked while waiting for human
    assert.throws(() => lease.assertAgentCanAct('click'), (err) => err.code === 'HUMAN_CONTROL_ACTIVE');

    const waitPromise = lease.waitForAgentControl({ timeoutMs: 5000 });
    lease.takeover('operator');
    lease.recordHumanInput('849201');
    assert.equal(lease.getStatus().holder, 'human');

    lease.releaseToAgent('resumed');
    const handoff = await waitPromise;
    assert.equal(handoff.outcome, 'resumed');
    assert.equal(lease.assertAgentCanAct('click'), true);

    // Screenshots remain permanently blocked after human credential takeover
    assert.throws(
        () => lease.assertScreenshotAllowed(),
        (err) => err.code === 'SCREENSHOTS_BLOCKED_AFTER_TAKEOVER'
    );

    const guarded = await lease.runGuardedStep('read_dom', async () => ({
        banner: 'Entered code 849201 successfully'
    }));
    assert.equal(guarded.ok, true);
    assert.equal(guarded.data.banner, `Entered code ${DEFAULT_REDACTION_MARKER} successfully`);
});

test('scrapeHtml and captureScreenshot detach cleanly over CDP without closing remote Chrome and honor HITL lease', async () => {
    let disconnected = false;
    let closedBrowser = false;
    let closedPage = false;

    const mockPage = {
        setUserAgent: async () => {},
        setExtraHTTPHeaders: async () => {},
        goto: async () => {},
        content: async () => '<html><body>Code: 739182</body></html>',
        close: async () => { closedPage = true; }
    };
    const mockCdpBrowser = {
        newPage: async () => mockPage,
        disconnect: async () => { disconnected = true; },
        close: async () => { closedBrowser = true; }
    };

    const lease = createBrowserControlLease({ sessionId: 'cdp-1' });
    lease.takeover('operator');
    lease.recordHumanInput('739182');
    lease.releaseToAgent('resumed');

    const html = await scrapeHtml('https://example.com/dashboard', {
        cdpEndpoint: 'http://127.0.0.1:9222',
        lease,
        connectFn: async () => mockCdpBrowser
    });

    assert.equal(html, `<html><body>Code: ${DEFAULT_REDACTION_MARKER}</body></html>`);
    assert.equal(closedPage, true);
    assert.equal(disconnected, true);
    assert.equal(closedBrowser, false);

    await assert.rejects(
        () => captureScreenshot('https://example.com/dashboard', '/tmp/blocked.png', {
            cdpEndpoint: 'http://127.0.0.1:9222',
            lease,
            connectFn: async () => mockCdpBrowser
        }),
        (err) => err.code === 'SCREENSHOTS_BLOCKED_AFTER_TAKEOVER'
    );
});
