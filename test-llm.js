import { chat } from './llm.js';

async function run() {
    if (!process.env.GEMINI_API_KEY) {
        console.log("⚠️  Skipping Gemini smoke test – GEMINI_API_KEY not set");
        return;
    }
    const config = {
        provider: 'gemini',
        model: 'gemini-2.5-flash',
        apiKey: process.env.GEMINI_API_KEY
    };

    console.log("Testing simple prompt (should cascade to edge)...");
    try {
        const text = await chat(
            "You are a helpful assistant.",
            "What color is the sky?",
            config,
            { timeout: 5000 } // adding a short timeout to test AbortSignal mapping
        );
        console.log("Result:", text);
    } catch(err) {
        console.error("Error:", err.message);
    }
}

run();
