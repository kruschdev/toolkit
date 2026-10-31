/**
 * @module browser
 * Shared browser automation utility library.
 * Provides stealth-configured headless Chromium integration via Puppeteer
 * and Gemini 4 Argon multimodal visual/telemetry page auditing.
 *
 * Usage:
 *   import { scrapeHtml, captureScreenshot, captureResponsiveBreakpoints, auditPageWithArgon } from '@krusch/toolkit/browser';
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

const DEFAULT_ARGS = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-web-security',
    '--disable-features=IsolateOrigins,site-per-process',
    '--blink-settings=imagesEnabled=true'
];

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
    
    return puppeteer.launch({
        headless: options.headless !== false ? 'shell' : false,
        args: launchArgs,
        defaultViewport: options.viewport || { width: 1280, height: 800 },
        ...options
    });
}

/**
 * Setup default headers, viewport, and agent on a page.
 *
 * @param {import('puppeteer').Page} page - Puppeteer page instance
 * @param {object} [options={}] - Customization options
 */
async function setupPageStealth(page, options = {}) {
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
    const browser = options.browser || await launchBrowser(options);
    const page = await browser.newPage();

    try {
        await setupPageStealth(page, options);
        await navigateAndReady(page, url, options);
        return await page.content();
    } finally {
        await page.close();
        if (!options.browser) {
            await browser.close();
        }
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
    const browser = options.browser || await launchBrowser(options);
    const page = await browser.newPage();

    try {
        await setupPageStealth(page, options);
        await navigateAndReady(page, url, options);
        
        await page.screenshot({
            path: outputPath,
            fullPage: options.fullPage !== false
        });
        
        return outputPath;
    } finally {
        await page.close();
        if (!options.browser) {
            await browser.close();
        }
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
    const browser = options.browser || await launchBrowser(options);
    const page = await browser.newPage();
    const result = {};

    try {
        await setupPageStealth(page, options);
        await navigateAndReady(page, url, options);

        for (const step of steps) {
            await executeInteractiveStep(page, step);
        }

        result.html = await page.content();

        if (options.screenshotPath) {
            await page.screenshot({
                path: options.screenshotPath,
                fullPage: options.fullPage !== false
            });
            result.screenshotPath = options.screenshotPath;
        }

        return result;
    } finally {
        await page.close();
        if (!options.browser) {
            await browser.close();
        }
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
    if (typeof options.captureFn === 'function') {
        return await options.captureFn(url, outputDir, options);
    }

    fs.mkdirSync(outputDir, { recursive: true });
    const browser = options.browser || await launchBrowser(options);
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
        await setupPageStealth(page, options);
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
        if (!options.browser) {
            await browser.close();
        }
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

