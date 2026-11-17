/**
 * @module browser
 * Shared browser automation utility library.
 * Provides stealth-configured headless Chromium integration via Puppeteer,
 * CDP attach bridge for remote/sandboxed browsers (e.g. easi.run),
 * human-in-the-loop takeover lease & bounded input redaction,
 * and Gemini 4 Argon multimodal visual/telemetry page auditing.
 *
 * Usage:
 *   import {
 *     scrapeHtml,
 *     captureScreenshot,
 *     captureResponsiveBreakpoints,
 *     auditPageWithArgon,
 *     connectBrowserOverCdp,
 *     createBrowserControlLease,
 *     createInputRedactor
 *   } from '@krusch/toolkit/browser';
 */

import fs from 'fs';
import path from 'path';
import puppeteer from 'puppeteer';
import { callGeminiMedia, callGeminiMediaJson } from './vision.js';

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export const DEFAULT_RESPONSIVE_BREAKPOINTS = [
    { name: 'mobile', width: 375, height: 812 },
    { name: 'tablet', width: 768, height: 1024 },
    { name: 'desktop', width: 1440, height: 900 }
];

export const DEFAULT_REDACTION_MARKER = '[redacted]';
export const DEFAULT_REDACTION_MIN_LENGTH = 4;
export const DEFAULT_REDACTION_MAX_BYTES = 384 * 1024;

const DEFAULT_ARGS = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-web-security',
    '--disable-features=IsolateOrigins,site-per-process',
    '--disable-blink-features=AutomationControlled',
    '--blink-settings=imagesEnabled=true'
];

const SYSTEM_CHROME_CANDIDATES = [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
];

function resolveBrowserExecutable(explicitPath) {
    if (explicitPath) return { executablePath: explicitPath, isSystemChrome: true };
    if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
        return { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH, isSystemChrome: true };
    }
    try {
        const bundled = puppeteer.executablePath();
        if (bundled && fs.existsSync(bundled)) {
            return { executablePath: undefined, isSystemChrome: false };
        }
    } catch {
        // Fall through to system Chrome discovery when Puppeteer browser cache was skipped
    }
    for (const candidate of SYSTEM_CHROME_CANDIDATES) {
        if (fs.existsSync(candidate)) {
            return { executablePath: candidate, isSystemChrome: true };
        }
    }
    return { executablePath: undefined, isSystemChrome: false };
}

/**
 * Launch a stealth-configured Puppeteer browser.
 *
 * @param {object} [options={}] - Custom puppeteer launch options
 * @param {boolean|string} [options.headless=true] - Headless mode
 * @param {string[]} [options.args] - Overriding CLI args
 * @returns {Promise<import('puppeteer').Browser>} Puppeteer Browser instance
 */
export async function launchBrowser(options = {}) {
    const launchArgs = options.args || DEFAULT_ARGS;
    const { executablePath, isSystemChrome } = resolveBrowserExecutable(options.executablePath);
    const defaultHeadless = options.headless !== false ? (isSystemChrome ? true : 'shell') : false;

    return puppeteer.launch({
        headless: defaultHeadless,
        ...(executablePath ? { executablePath } : {}),
        args: launchArgs,
        defaultViewport: options.viewport || { width: 1280, height: 800 },
        ...options
    });
}

/**
 * Connect Puppeteer to an existing Chrome DevTools Protocol (CDP) endpoint
 * (for example, an SSH-forwarded easi.run session at `http://127.0.0.1:9222`).
 *
 * By default, restricts loopback HTTP/WebSocket targets unless `allowRemote=true`
 * is explicitly passed so CDP control sockets are not exposed over unencrypted LAN.
 *
 * @param {string|object} [endpointOrOptions='http://127.0.0.1:9222'] - CDP URL (`http://...` or `ws://...`) or options object
 * @param {object} [extraOptions={}] - Additional connection options
 * @param {string} [extraOptions.browserURL] - HTTP CDP origin (e.g. `http://127.0.0.1:9222`)
 * @param {string} [extraOptions.browserWSEndpoint] - Direct WebSocket CDP endpoint
 * @param {boolean} [extraOptions.allowRemote=false] - Allow non-loopback CDP endpoints
 * @param {{ width: number, height: number } | null} [extraOptions.defaultViewport=null] - Viewport override (`null` preserves live window dimensions)
 * @param {Function} [extraOptions.connectFn] - Optional injectable connector for deterministic unit tests
 * @returns {Promise<import('puppeteer').Browser>} Connected Puppeteer Browser instance (`disconnect()` detaches without closing the remote Chrome)
 */
export async function connectBrowserOverCdp(endpointOrOptions = 'http://127.0.0.1:9222', extraOptions = {}) {
    const rawOpts = typeof endpointOrOptions === 'string'
        ? { endpoint: endpointOrOptions, ...extraOptions }
        : { ...(endpointOrOptions || {}), ...extraOptions };

    const candidate = String(
        rawOpts.browserWSEndpoint || rawOpts.browserURL || rawOpts.endpoint || 'http://127.0.0.1:9222'
    ).trim();

    let parsed;
    try {
        parsed = new URL(candidate);
    } catch {
        throw new Error(`Invalid CDP endpoint URL: ${candidate}`);
    }

    const allowedSchemes = new Set(['http:', 'https:', 'ws:', 'wss:']);
    if (!allowedSchemes.has(parsed.protocol)) {
        throw new Error(`Unsupported CDP protocol "${parsed.protocol}" in ${candidate}`);
    }

    const host = parsed.hostname.toLowerCase();
    const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
    if (!isLoopback && rawOpts.allowRemote !== true) {
        throw new Error(
            `Refusing non-loopback CDP endpoint "${parsed.hostname}" without allowRemote=true (use an SSH local port forward such as 127.0.0.1:9222)`
        );
    }

    const isWs = parsed.protocol === 'ws:' || parsed.protocol === 'wss:';
    const connectPayload = {
        ...(isWs ? { browserWSEndpoint: candidate } : { browserURL: candidate.replace(/\/+$/, '') }),
        defaultViewport: rawOpts.defaultViewport !== undefined ? rawOpts.defaultViewport : null
    };

    const connector = typeof rawOpts.connectFn === 'function'
        ? rawOpts.connectFn
        : (opts) => puppeteer.connect(opts);

    return connector(connectPayload);
}

/**
 * Resolve a browser handle for a single operation: reuse `options.browser`,
 * attach via CDP when `options.cdpEndpoint` / `options.browserURL` / `options.browserWSEndpoint` is provided,
 * or launch a fresh headless browser.
 *
 * When attached over CDP, cleanup detaches (`browser.disconnect()`) instead of terminating the remote session.
 *
 * @param {object} [options={}]
 * @returns {Promise<{ browser: import('puppeteer').Browser, release: () => Promise<void>, attachedOverCdp: boolean }>}
 */
async function acquireBrowserHandle(options = {}) {
    if (options.browser) {
        return {
            browser: options.browser,
            attachedOverCdp: false,
            release: async () => {}
        };
    }

    const cdpTarget = options.cdpEndpoint || options.browserWSEndpoint || options.browserURL;
    if (cdpTarget) {
        const browser = await connectBrowserOverCdp(cdpTarget, options);
        return {
            browser,
            attachedOverCdp: true,
            release: async () => {
                if (typeof browser.disconnect === 'function') {
                    await browser.disconnect();
                }
            }
        };
    }

    const browser = await launchBrowser(options);
    return {
        browser,
        attachedOverCdp: false,
        release: async () => {
            await browser.close();
        }
    };
}

/**
 * Create a bounded, fail-closed human-input redactor for agent browser observations.
 *
 * Tracks sensitive strings typed or pasted during human takeover (default `minLength = 4`,
 * `maxBytes = 384 KiB`). Once human takeover occurs (`markHumanTakeover()`), `screenshotsAllowed()`
 * becomes permanently `false` for that session, and any recorded string (plus optional sliding
 * `minLength` substrings when `includeSubstrings=true`) is scrubbed from text and structured JSON
 * observations as `[redacted]`. If recorded byte capacity is exceeded, the redactor fails closed
 * (`saturated = true`), withholding all subsequent observations.
 *
 * @param {object} [options={}]
 * @param {number} [options.minLength=4] - Minimum character length to redact
 * @param {number} [options.maxBytes=393216] - Maximum UTF-8 byte budget before fail-closed saturation
 * @param {string} [options.marker='[redacted]'] - Replacement token
 * @returns {object} Stateful input redactor instance
 */
export function createInputRedactor(options = {}) {
    const minLength = Math.max(2, Number(options.minLength ?? DEFAULT_REDACTION_MIN_LENGTH));
    const maxBytes = Math.max(64, Number(options.maxBytes ?? DEFAULT_REDACTION_MAX_BYTES));
    const marker = String(options.marker || DEFAULT_REDACTION_MARKER);

    const entries = new Set();
    let usedBytes = 0;
    let saturated = false;
    let screenshotsBlocked = false;
    let compiledRegex = null;

    function escapeRegExp(str) {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function addCandidate(raw) {
        if (saturated || typeof raw !== 'string') return;
        const trimmed = raw.replace(/^[\r\n]+|[\r\n]+$/g, '');
        if ([...trimmed].length < minLength) return;
        if (entries.has(trimmed)) return;

        const byteLen = Buffer.byteLength(trimmed, 'utf8');
        if (usedBytes + byteLen > maxBytes) {
            saturated = true;
            compiledRegex = null;
            return;
        }
        entries.add(trimmed);
        usedBytes += byteLen;
        compiledRegex = null;
    }

    function recordInput(text, recordOpts = {}) {
        if (typeof text !== 'string' || !text) return stateSnapshot();
        const variants = [text];
        const singleLine = text.replace(/[\r\n]+/g, '');
        if (singleLine.length < text.length) {
            variants.push(singleLine);
        }

        for (const variant of variants) {
            addCandidate(variant);
            if (recordOpts.includeSubstrings === true && !saturated) {
                const chars = [...variant.replace(/^[\r\n]+|[\r\n]+$/g, '')];
                for (let i = 0; i + minLength <= chars.length; i += 1) {
                    addCandidate(chars.slice(i, i + minLength).join(''));
                    if (saturated) break;
                }
            }
        }
        return stateSnapshot();
    }

    function getMatcher() {
        if (saturated || entries.size === 0) return null;
        if (!compiledRegex) {
            const ordered = [...entries].sort((a, b) => b.length - a.length);
            compiledRegex = new RegExp(ordered.map(escapeRegExp).join('|'), 'g');
        }
        return compiledRegex;
    }

    function scrubText(input) {
        if (typeof input !== 'string') return input;
        if (saturated) return marker;
        const matcher = getMatcher();
        if (!matcher) return input;
        return input.replace(matcher, marker);
    }

    function isPasswordFieldNode(node) {
        if (!node || typeof node !== 'object') return false;
        const role = String(node.role || node.type || node.inputType || '').toLowerCase();
        return role === 'password' || role === 'passwordtext' || node.isPassword === true;
    }

    function scrubValue(value) {
        if (saturated) {
            return { ok: false, saturated: true, redacted: true, data: null, summary: 'Observation withheld: input redactor byte budget saturated.' };
        }

        function walk(node) {
            if (typeof node === 'string') return scrubText(node);
            if (Array.isArray(node)) return node.map(walk);
            if (node && typeof node === 'object') {
                const maskPasswordValue = isPasswordFieldNode(node);
                const out = {};
                for (const [k, v] of Object.entries(node)) {
                    if (maskPasswordValue && (k === 'value' || k === 'textValue' || k === 'defaultValue') && typeof v === 'string' && v.length > 0) {
                        out[k] = marker;
                    } else {
                        out[k] = walk(v);
                    }
                }
                return out;
            }
            return node;
        }

        return {
            ok: true,
            saturated: false,
            screenshotsAllowed: !screenshotsBlocked,
            data: walk(value)
        };
    }

    function markHumanTakeover() {
        screenshotsBlocked = true;
        return stateSnapshot();
    }

    function stateSnapshot() {
        return {
            entryCount: entries.size,
            usedBytes,
            maxBytes,
            minLength,
            saturated,
            screenshotsBlocked,
            screenshotsAllowed: !screenshotsBlocked && !saturated
        };
    }

    return {
        recordInput,
        markHumanTakeover,
        scrubText,
        scrubValue,
        screenshotsAllowed: () => !screenshotsBlocked && !saturated,
        getState: stateSnapshot
    };
}

/**
 * Create a cooperative Human-in-the-Loop (HITL) browser control lease.
 *
 * Coordinates exclusive control between an autonomous agent and a human operator
 * (for 2FA, CAPTCHAs, OAuth consent, or credential entry):
 * - `assertAgentCanAct()` throws a structured `HUMAN_CONTROL_ACTIVE` error while a person holds the lease.
 * - `requestHuman(reason, meta)` transitions the session to `needs_human`, notifies `onNeedsHuman`, and pauses agent actions.
 * - `takeover(actor)` grants exclusive control to the human and permanently disables raw agent screenshots on the attached `redactor`.
 * - `releaseToAgent(resolution)` hands control back (`resumed` or `skipped`) and resolves all pending `waitForAgentControl()` callers.
 *
 * @param {object} [options={}]
 * @param {string} [options.sessionId='default'] - Browser session identifier
 * @param {ReturnType<typeof createInputRedactor>} [options.redactor] - Optional attached input redactor
 * @param {(event: object) => void|Promise<void>} [options.onNeedsHuman] - Optional webhook/notification callback when agent requests help
 * @returns {object} Control lease coordinator
 */
export function createBrowserControlLease(options = {}) {
    const sessionId = String(options.sessionId || 'default');
    const redactor = options.redactor || createInputRedactor(options.redactorOptions);
    const onNeedsHuman = typeof options.onNeedsHuman === 'function' ? options.onNeedsHuman : null;

    let holder = 'agent'; // 'agent' | 'human'
    let status = 'agent_active'; // 'agent_active' | 'needs_human' | 'human_active'
    let pendingReason = null;
    let requestedAt = null;
    let lastResolution = null;
    const waiters = new Set();

    function getStatus() {
        return {
            sessionId,
            holder,
            status,
            pendingReason,
            requestedAt,
            lastResolution,
            redaction: redactor.getState()
        };
    }

    function assertAgentCanAct(actionName = 'browser_action') {
        if (holder !== 'agent' || status !== 'agent_active') {
            const err = new Error(
                `Agent cannot run "${actionName}" on session "${sessionId}" while status is "${status}" (holder: ${holder}). Call waitForAgentControl() first.`
            );
            err.code = 'HUMAN_CONTROL_ACTIVE';
            err.sessionStatus = getStatus();
            throw err;
        }
        return true;
    }

    function assertScreenshotAllowed() {
        assertAgentCanAct('screenshot');
        if (!redactor.screenshotsAllowed()) {
            const err = new Error(
                `Screenshots are permanently disabled for session "${sessionId}" after human takeover to protect entered credentials.`
            );
            err.code = 'SCREENSHOTS_BLOCKED_AFTER_TAKEOVER';
            err.sessionStatus = getStatus();
            throw err;
        }
        return true;
    }

    async function requestHuman(reason, meta = {}) {
        const cleanReason = String(reason || 'Human verification required').trim();
        status = 'needs_human';
        pendingReason = cleanReason;
        requestedAt = new Date().toISOString();

        const payload = {
            sessionId,
            status,
            reason: cleanReason,
            requestedAt,
            meta
        };

        if (onNeedsHuman) {
            await onNeedsHuman(payload);
        }
        return payload;
    }

    function takeover(actor = 'human') {
        holder = 'human';
        status = 'human_active';
        redactor.markHumanTakeover();
        return {
            ...getStatus(),
            actor
        };
    }

    function recordHumanInput(text, recordOpts = {}) {
        redactor.markHumanTakeover();
        return redactor.recordInput(text, recordOpts);
    }

    function releaseToAgent(resolution = 'resumed') {
        const normalized = resolution === 'skipped' ? 'skipped' : 'resumed';
        holder = 'agent';
        status = 'agent_active';
        lastResolution = {
            outcome: normalized,
            reason: pendingReason,
            resolvedAt: new Date().toISOString()
        };
        pendingReason = null;
        requestedAt = null;

        for (const waiter of [...waiters]) {
            waiters.delete(waiter);
            waiter.resolve(lastResolution);
        }
        return getStatus();
    }

    function waitForAgentControl({ timeoutMs = 300000, signal } = {}) {
        if (holder === 'agent' && status === 'agent_active') {
            return Promise.resolve(
                lastResolution || { outcome: 'resumed', reason: null, resolvedAt: new Date().toISOString() }
            );
        }

        return new Promise((resolve, reject) => {
            const entry = {
                resolve: (val) => {
                    cleanup();
                    resolve(val);
                },
                reject: (err) => {
                    cleanup();
                    reject(err);
                }
            };

            const timer = timeoutMs > 0
                ? setTimeout(() => {
                    waiters.delete(entry);
                    const err = new Error(`Timed out after ${timeoutMs}ms waiting for human control handoff on session "${sessionId}"`);
                    err.code = 'HUMAN_HANDOFF_TIMEOUT';
                    entry.reject(err);
                }, timeoutMs)
                : null;

            const onAbort = () => {
                waiters.delete(entry);
                const err = new Error(`Aborted while waiting for human control handoff on session "${sessionId}"`);
                err.code = 'ABORT_ERR';
                entry.reject(err);
            };

            function cleanup() {
                if (timer) clearTimeout(timer);
                if (signal) signal.removeEventListener('abort', onAbort);
            }

            if (signal) {
                if (signal.aborted) {
                    onAbort();
                    return;
                }
                signal.addEventListener('abort', onAbort, { once: true });
            }

            waiters.add(entry);
        });
    }

    async function runGuardedStep(actionName, fn) {
        assertAgentCanAct(actionName);
        const raw = await fn();
        return redactor.scrubValue(raw);
    }

    return {
        redactor,
        getStatus,
        assertAgentCanAct,
        assertScreenshotAllowed,
        requestHuman,
        takeover,
        recordHumanInput,
        releaseToAgent,
        waitForAgentControl,
        runGuardedStep
    };
}

/**
 * Setup default headers, viewport, and stealth patches on a page.
 *
 * @param {import('puppeteer').Page} page - Puppeteer page instance
 * @param {object} [options={}] - Customization options
 */
async function setupPageStealth(page, options = {}) {
    if (options.skipStealthOverrides === true) return;
    const userAgent = options.userAgent || DEFAULT_USER_AGENT;
    await page.setUserAgent(userAgent);
    await page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        ...options.headers
    });
}

/**
 * Navigate a page to a URL and wait for specified conditions.
 *
 * @param {import('puppeteer').Page} page - Puppeteer page
 * @param {string} url - Target URL
 * @param {object} [options={}] - Navigation options
 */
async function navigateAndReady(page, url, options = {}) {
    const timeout = options.timeout || 30000;
    const waitUntil = options.waitUntil || 'networkidle2';
    
    await page.goto(url, { waitUntil, timeout });

    if (options.waitForSelector) {
        await page.waitForSelector(options.waitForSelector, { timeout });
    }
}

/**
 * Scrape the fully rendered HTML of a webpage.
 *
 * @param {string} url - Target URL
 * @param {object} [options={}] - Custom scraping options
 * @param {string} [options.waitForSelector] - Optional selector to wait for before extracting HTML
 * @returns {Promise<string>} Fully rendered HTML source
 */
export async function scrapeHtml(url, options = {}) {
    if (options.lease) {
        options.lease.assertAgentCanAct('scrapeHtml');
    }
    const { browser, release, attachedOverCdp } = await acquireBrowserHandle(options);
    const page = await browser.newPage();

    try {
        if (!attachedOverCdp || options.userAgent || options.headers) {
            await setupPageStealth(page, options);
        }
        await navigateAndReady(page, url, options);
        const rawHtml = await page.content();
        if (options.lease) {
            return options.lease.redactor.scrubText(rawHtml);
        }
        if (options.redactor) {
            return options.redactor.scrubText(rawHtml);
        }
        return rawHtml;
    } finally {
        await page.close();
        await release();
    }
}

/**
 * Capture a visual screenshot of a webpage.
 *
 * @param {string} url - Target URL
 * @param {string} outputPath - Local filepath to write screenshot to
 * @param {object} [options={}] - Screenshot options
 * @param {boolean} [options.fullPage=true] - Whether to capture the entire scrollable height
 * @returns {Promise<string>} Absolute path to the saved screenshot
 */
export async function captureScreenshot(url, outputPath, options = {}) {
    if (options.lease) {
        options.lease.assertScreenshotAllowed();
    } else if (options.redactor && !options.redactor.screenshotsAllowed()) {
        const err = new Error('Screenshots are blocked after human takeover to protect entered credentials.');
        err.code = 'SCREENSHOTS_BLOCKED_AFTER_TAKEOVER';
        throw err;
    }

    const { browser, release, attachedOverCdp } = await acquireBrowserHandle(options);
    const page = await browser.newPage();

    try {
        if (!attachedOverCdp || options.userAgent || options.headers) {
            await setupPageStealth(page, options);
        }
        await navigateAndReady(page, url, options);
        
        await page.screenshot({
            path: outputPath,
            fullPage: options.fullPage !== false
        });
        
        return outputPath;
    } finally {
        await page.close();
        await release();
    }
}

/**
 * Execute a single interactive step on a page.
 *
 * @param {import('puppeteer').Page} page - Puppeteer page
 * @param {object} step - The action payload
 * @param {string} step.action - 'click', 'type', or 'wait'
 * @param {string} [step.selector] - Target selector
 * @param {string} [step.text] - Text to type
 * @param {number|string} [step.value] - Milliseconds or selector to wait for
 */
async function executeInteractiveStep(page, step) {
    const timeout = 10000;
    
    switch (step.action) {
        case 'click':
            await page.waitForSelector(step.selector, { timeout });
            await page.click(step.selector);
            break;
        case 'type':
            await page.waitForSelector(step.selector, { timeout });
            await page.type(step.selector, step.text);
            break;
        case 'wait':
            if (typeof step.value === 'number') {
                await new Promise(resolve => setTimeout(resolve, step.value));
            } else {
                await page.waitForSelector(step.value, { timeout });
            }
            break;
        default:
            throw new Error(`Unsupported interactive action: ${step.action}`);
    }
}

/**
 * Perform a list of sequential interactions on a webpage before returning the final HTML.
 *
 * @param {string} url - Target URL
 * @param {object[]} steps - Array of interactive step payloads
 * @param {object} [options={}] - Custom options
 * @param {string} [options.screenshotPath] - Optional path to save a screenshot after interactions
 * @returns {Promise<{ html: string, screenshotPath?: string }>} The HTML (and optional screenshot)
 */
export async function runInteractiveSession(url, steps, options = {}) {
    if (options.lease) {
        options.lease.assertAgentCanAct('runInteractiveSession');
    }
    const { browser, release, attachedOverCdp } = await acquireBrowserHandle(options);
    const page = await browser.newPage();
    const result = {};

    try {
        if (!attachedOverCdp || options.userAgent || options.headers) {
            await setupPageStealth(page, options);
        }
        await navigateAndReady(page, url, options);

        for (const step of steps) {
            if (options.lease) {
                options.lease.assertAgentCanAct(`step:${step.action}`);
            }
            await executeInteractiveStep(page, step);
        }

        const rawHtml = await page.content();
        const activeRedactor = options.lease?.redactor || options.redactor || null;
        result.html = activeRedactor ? activeRedactor.scrubText(rawHtml) : rawHtml;

        if (options.screenshotPath) {
            if (options.lease) {
                options.lease.assertScreenshotAllowed();
            } else if (activeRedactor && !activeRedactor.screenshotsAllowed()) {
                const err = new Error('Screenshots are blocked after human takeover to protect entered credentials.');
                err.code = 'SCREENSHOTS_BLOCKED_AFTER_TAKEOVER';
                throw err;
            }
            await page.screenshot({
                path: options.screenshotPath,
                fullPage: options.fullPage !== false
            });
            result.screenshotPath = options.screenshotPath;
        }

        return result;
    } finally {
        await page.close();
        await release();
    }
}

/**
 * Capture screenshots across responsive Chrome viewports (mobile, tablet, desktop)
 * while recording console errors, uncaught page exceptions, and failed network requests.
 *
 * @param {string} url - Target URL to inspect
 * @param {string} [outputDir='/tmp/krusch-browser-audit'] - Directory to write viewport PNGs
 * @param {object} [options={}] - Capture options
 * @param {Array<{name: string, width: number, height: number}>} [options.breakpoints] - Custom responsive breakpoints
 * @param {Function} [options.captureFn] - Optional hermetic capture implementation for unit tests
 * @returns {Promise<{url: string, title: string, screenshots: Array<{name: string, width: number, height: number, path: string, mimeType: string, base64Data: string}>, consoleErrors: string[], pageErrors: string[], failedRequests: string[]}>}
 */
export async function captureResponsiveBreakpoints(url, outputDir = '/tmp/krusch-browser-audit', options = {}) {
    if (options.lease) {
        options.lease.assertScreenshotAllowed();
    }
    if (typeof options.captureFn === 'function') {
        return await options.captureFn(url, outputDir, options);
    }

    fs.mkdirSync(outputDir, { recursive: true });
    const { browser, release, attachedOverCdp } = await acquireBrowserHandle(options);
    const page = await browser.newPage();

    const consoleErrors = [];
    const pageErrors = [];
    const failedRequests = [];
    const screenshots = [];

    page.on('console', msg => {
        if (msg.type() === 'error') {
            consoleErrors.push(msg.text());
        }
    });
    page.on('pageerror', err => {
        pageErrors.push(err?.message || String(err));
    });
    page.on('requestfailed', req => {
        failedRequests.push(`${req.method()} ${req.url()} (${req.failure()?.errorText || 'failed'})`);
    });

    try {
        if (!attachedOverCdp || options.userAgent || options.headers) {
            await setupPageStealth(page, options);
        }
        await navigateAndReady(page, url, options);
        const title = await page.title();
        const breakpoints = options.breakpoints || DEFAULT_RESPONSIVE_BREAKPOINTS;

        for (const bp of breakpoints) {
            await page.setViewport({ width: bp.width, height: bp.height });
            const filePath = path.join(outputDir, `${bp.name}-${bp.width}x${bp.height}.png`);
            const shotResult = await page.screenshot({
                path: filePath,
                fullPage: options.fullPage !== false
            });

            let base64Data = '';
            if (fs.existsSync(filePath)) {
                base64Data = fs.readFileSync(filePath).toString('base64');
            } else if (Buffer.isBuffer(shotResult)) {
                base64Data = shotResult.toString('base64');
            } else if (typeof shotResult === 'string') {
                base64Data = shotResult;
            }

            screenshots.push({
                name: bp.name,
                width: bp.width,
                height: bp.height,
                path: filePath,
                mimeType: 'image/png',
                base64Data
            });
        }

        return {
            url,
            title,
            screenshots,
            consoleErrors,
            pageErrors,
            failedRequests
        };
    } finally {
        await page.close();
        await release();
    }
}

/**
 * Compute a deterministic telemetry-grounded visual audit fallback when offline or in MOCK_LLM mode.
 *
 * @param {object} captured - Output from captureResponsiveBreakpoints
 * @returns {{ passed: boolean, score: number, findings: Array<object>, summary: string }}
 */
function buildDeterministicAuditFallback(captured) {
    const consoleErrors = captured.consoleErrors || [];
    const pageErrors = captured.pageErrors || [];
    const failedRequests = captured.failedRequests || [];
    const screenshots = captured.screenshots || [];

    const findings = [];
    for (const err of pageErrors) {
        findings.push({
            severity: 'error',
            category: 'runtime-exception',
            breakpoint: 'all',
            description: err,
            recommendation: 'Fix uncaught runtime exception on page load.'
        });
    }
    for (const req of failedRequests) {
        findings.push({
            severity: 'error',
            category: 'network-failure',
            breakpoint: 'all',
            description: req,
            recommendation: 'Ensure static asset or API endpoint resolves cleanly.'
        });
    }
    for (const err of consoleErrors) {
        findings.push({
            severity: 'warning',
            category: 'console-error',
            breakpoint: 'all',
            description: err,
            recommendation: 'Resolve browser console error.'
        });
    }

    const score = Math.max(
        0,
        100 - (pageErrors.length * 25) - (failedRequests.length * 15) - (consoleErrors.length * 5)
    );
    const passed = pageErrors.length === 0 && failedRequests.length === 0 && screenshots.length > 0 && score >= 70;
    const summary = passed
        ? `Captured ${screenshots.length} responsive Chrome viewports cleanly with ${consoleErrors.length} console warnings.`
        : `Detected ${pageErrors.length} runtime exceptions, ${failedRequests.length} failed requests, and ${consoleErrors.length} console errors across ${screenshots.length} viewports.`;

    return { passed, score, findings, summary };
}

/**
 * Audit a web page across responsive Chrome breakpoints using Gemini 4 Argon (`gemini-4-argon`).
 * Combines headless Chrome multi-viewport screenshots + runtime telemetry with multimodal reasoning.
 *
 * @param {string} url - Target URL to audit
 * @param {object} [options={}] - Audit options
 * @param {string} [options.outputDir='/tmp/krusch-browser-audit'] - Directory for viewport screenshots
 * @param {object} [options.preCaptured] - Pre-captured responsive breakpoints payload
 * @param {string} [options.model='gemini-4-argon'] - Multimodal model identifier
 * @param {'low'|'medium'|'high'} [options.thinkingLevel='medium'] - Gemini 4 Argon thinking level
 * @param {string} [options.apiKey] - Gemini API key override
 * @param {boolean} [options.forceLive=false] - Force live Gemini API call even in CI/MOCK_LLM
 * @param {boolean} [options.fallbackOnError=true] - Fall back to deterministic telemetry audit on API failure
 * @returns {Promise<{ok: boolean, url: string, title: string, model: string, passed: boolean, score: number, breakpoints: Array<{name: string, width: number, height: number, path: string}>, telemetry: {consoleErrors: string[], pageErrors: string[], failedRequests: string[]}, findings: Array<object>, summary: string}>}
 */
export async function auditPageWithArgon(url, options = {}) {
    const captured = options.preCaptured || await captureResponsiveBreakpoints(
        url,
        options.outputDir || '/tmp/krusch-browser-audit',
        options
    );

    const model = options.model || 'gemini-4-argon';
    const thinkingLevel = options.thinkingLevel || 'medium';
    const screenshots = captured.screenshots || [];
    const mediaItems = screenshots.map(s => ({
        label: `${s.name} (${s.width}x${s.height})`,
        base64Data: s.base64Data,
        mimeType: s.mimeType || 'image/png'
    }));

    const apiKey = options.apiKey || process.env.GEMINI_API_KEY;
    const shouldCallLive = Boolean(apiKey) && (
        options.forceLive === true ||
        (process.env.MOCK_LLM !== '1' && process.env.CI !== 'true')
    );

    let parsed;
    if (shouldCallLive && mediaItems.length > 0) {
        const prompt = [
            `You are a Principal Frontend & Accessibility Auditor powered by Gemini 4 Argon.`,
            `Audit the attached Chrome responsive viewport screenshots (${screenshots.map(s => `${s.name}:${s.width}x${s.height}`).join(', ')}) for URL: ${url}`,
            `Page title: ${captured.title || '(untitled)'}`,
            `Browser telemetry:`,
            `- Console errors (${(captured.consoleErrors || []).length}): ${JSON.stringify(captured.consoleErrors || [])}`,
            `- Uncaught page errors (${(captured.pageErrors || []).length}): ${JSON.stringify(captured.pageErrors || [])}`,
            `- Failed network requests (${(captured.failedRequests || []).length}): ${JSON.stringify(captured.failedRequests || [])}`,
            `Evaluate responsive layout overflow, visual hierarchy, contrast/accessibility, and broken UI states across viewports.`,
            `Return strict JSON matching:`,
            `{"passed": boolean, "score": number, "findings": [{"severity": "error"|"warning"|"info", "category": string, "breakpoint": string, "description": string, "recommendation": string}], "summary": string}`
        ].join('\n');

        try {
            parsed = await callGeminiMediaJson(prompt, null, 'image/png', {
                apiKey,
                model,
                thinkingLevel,
                mediaItems,
                apiUrl: options.apiUrl,
                maxContinuationHops: options.maxContinuationHops
            });
        } catch (err) {
            if (options.fallbackOnError === false) {
                throw err;
            }
            parsed = buildDeterministicAuditFallback(captured);
        }
    } else {
        parsed = buildDeterministicAuditFallback(captured);
    }

    if (!parsed || typeof parsed !== 'object' || parsed.parseError) {
        parsed = buildDeterministicAuditFallback(captured);
    }

    return {
        ok: true,
        url,
        title: captured.title || '',
        model,
        passed: Boolean(parsed.passed),
        score: Number(parsed.score ?? 100),
        breakpoints: screenshots.map(({ name, width, height, path: p }) => ({
            name,
            width,
            height,
            path: p
        })),
        telemetry: {
            consoleErrors: captured.consoleErrors || [],
            pageErrors: captured.pageErrors || [],
            failedRequests: captured.failedRequests || []
        },
        findings: Array.isArray(parsed.findings) ? parsed.findings : [],
        summary: String(parsed.summary || '')
    };
}

