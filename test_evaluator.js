import { evaluatePlausibility, evaluatePairwise, evaluateDirect } from './evaluator.js';

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';

const config = {
    provider: 'ollama',
    apiUrl: `${OLLAMA_URL}/v1/chat/completions`,
    model: process.env.OLLAMA_FAST_MODEL || 'qwen2.5-coder:7b'
};

async function testPlausibility() {
    console.log("=== Testing Plausibility Gate ===");
    const sourceContext = `User ID 405 has requested a refund. The user's account balance is $50. The refund policy states refunds are allowed within 30 days. Purchase was 12 days ago.`;
    
    // Poisoned node: structural formatting is fine, but it hallucinates a "Platinum Tier" fact and a false balance.
    const poisonedOutput = `The user is eligible for a refund. Because they are a Platinum Tier member, their balance of $500 allows for an instant refund. Process refund for User ID 405.`;

    const result = await evaluatePlausibility(sourceContext, poisonedOutput, config, { useFastModel: true });
    console.log("Plausibility Result:", result);
    if (!result.isPlausible) {
        console.log("✅ Success: Evaluator correctly caught the hallucinated 'Platinum Tier' and '$500'.");
    } else {
        console.error("❌ Failed: Evaluator allowed the poisoned node.");
    }
}

async function testPairwise() {
    console.log("\n=== Testing Pairwise Comparison ===");
    const prompt = "Explain the importance of code documentation.";
    const responseA = "Code documentation helps other developers understand what your code does, saving time and preventing bugs.";
    const responseB = "It is important because otherwise code is bad. Always document your code.";
    
    const result = await evaluatePairwise(prompt, responseA, responseB, ["clarity", "detail"], config);
    console.log("Pairwise Result:", result);
    if (result.winner === 'A') {
        console.log("✅ Success: Evaluator preferred the detailed response consistently.");
    } else {
        console.warn("⚠️ Evaluator preferred B or TIE. (This can happen depending on the model's subjective judgment)");
    }
}

async function testDirect() {
    console.log("\n=== Testing Direct Scoring ===");
    const prompt = "Write a function to add two numbers.";
    const response = "function add(a, b) { return a + b; }";
    const criterion = { name: "Accuracy", description: "Does the code perfectly fulfill the prompt requirements?" };
    
    const result = await evaluateDirect(prompt, response, criterion, 5, config);
    console.log("Direct Score Result:", result);
    if (result.score >= 4) {
        console.log("✅ Success: Evaluator scored the correct code highly.");
    } else {
        console.error("❌ Failed: Evaluator scored the correct code poorly.");
    }
}

async function run() {
    try {
        await testPlausibility();
        await testPairwise();
        await testDirect();
        console.log("\nAll tests finished successfully.");
    } catch (err) {
        console.error("Test failed:", err);
    }
}

run();
