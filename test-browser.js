/**
 * Test validation script for @krusch/toolkit/browser
 * Tests core capabilities: HTML scraping, screenshot capture, and interaction sessions.
 */

import { scrapeHtml, captureScreenshot, runInteractiveSession } from './browser.js';
import fs from 'fs';
import path from 'path';

const ARTIFACT_DIR = process.env.ARTIFACT_DIR || path.join(process.cwd(), 'artifacts');

function skipIfBrowserUnavailable(err) {
    const msg = String(err?.message || err);
    if (
        msg.includes('Could not find Chrome') ||
        msg.includes('Failed to launch') ||
        msg.includes('No usable sandbox') ||
        msg.includes("executable doesn't exist") ||
        msg.includes('no executable was found') ||
        msg.includes('Tried to find the browser')
    ) {
        console.log('   ⚠️  Skipping browser verification tests – Chrome/Chromium binary not available in this environment.');
        process.exit(0);
    }
}

async function runTests() {
    console.log('🧪 Starting Browser Automation module verification tests...');
    
    // Ensure artifacts directory exists
    if (!fs.existsSync(ARTIFACT_DIR)) {
        fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
    }
    
    const testUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(
        '<!doctype html><html><body><h1>Example Domain</h1><a href="javascript:void(0)" onclick="document.body.insertAdjacentHTML(\'beforeend\', \'<p>IANA-managed Reserved Domains</p>\')">More info</a></body></html>'
    );

    // Test 1: scrapeHtml
    console.log('\n1️⃣  Testing HTML scraping...');
    try {
        const html = await scrapeHtml(testUrl, {
            waitForSelector: 'h1'
        });
        
        if (html.includes('Example Domain') && html.includes('<h1>')) {
            console.log('   ✅ Success: Extracted HTML matches expected markers.');
        } else {
            console.error('   ❌ Failure: HTML extracted does not match expected content.');
            process.exit(1);
        }
    } catch (err) {
        skipIfBrowserUnavailable(err);
        console.error('   ❌ Failure during scrapeHtml:', err);
        process.exit(1);
    }

    // Test 2: captureScreenshot
    console.log('\n2️⃣  Testing visual screenshot capture...');
    try {
        const screenshotPath = path.join(ARTIFACT_DIR, 'browser_test_screenshot.png');
        await captureScreenshot(testUrl, screenshotPath, {
            fullPage: true
        });
        
        if (fs.existsSync(screenshotPath)) {
            const stats = fs.statSync(screenshotPath);
            console.log(`   ✅ Success: Saved screenshot to ${screenshotPath} (${stats.size} bytes).`);
        } else {
            console.error('   ❌ Failure: Screenshot file was not created.');
            process.exit(1);
        }
    } catch (err) {
        skipIfBrowserUnavailable(err);
        console.error('   ❌ Failure during captureScreenshot:', err);
        process.exit(1);
    }

    // Test 3: runInteractiveSession
    console.log('\n3️⃣  Testing interactive step sessions...');
    try {
        const interactiveUrl = testUrl;
        const interactiveScreenshot = path.join(ARTIFACT_DIR, 'browser_test_interactive.png');
        
        const steps = [
            { action: 'wait', value: 'a' },
            { action: 'click', selector: 'a' },
            { action: 'wait', value: 100 }
        ];

        const session = await runInteractiveSession(interactiveUrl, steps, {
            screenshotPath: interactiveScreenshot,
            fullPage: false
        });

        if (session.html.includes('IANA-managed Reserved Domains') || session.html.includes('iana.org')) {
            console.log('   ✅ Success: Navigation & interactive click succeeded.');
            console.log(`   ✅ Success: Saved session screenshot to ${session.screenshotPath}`);
        } else {
            console.error('   ❌ Failure: Interactive session final HTML did not match expected clicked page.');
            process.exit(1);
        }
    } catch (err) {
        skipIfBrowserUnavailable(err);
        console.error('   ❌ Failure during runInteractiveSession:', err);
        process.exit(1);
    }

    console.log('\n💯 All verification tests passed successfully!');
}

runTests().catch(err => {
    skipIfBrowserUnavailable(err);
    console.error('💥 Unexpected test runner exception:', err);
    process.exit(1);
});
