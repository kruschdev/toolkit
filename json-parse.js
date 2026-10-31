/**
 * @module json-parse
 * Parse JSON from AI/LLM responses. Handles markdown code fences,
 * partial JSON, and common AI response quirks.
 */

/**
 * Parse JSON from an AI response string.
 * Strips markdown code fences, finds JSON objects/arrays, and parses them.
 *
 * @param {string} text - Raw AI response text
 * @param {object} [options] - Parsing options
 * @param {boolean} [options.allowPartial=false] - If true, try to extract first JSON object even from mixed text
 * @returns {object|array} Parsed JSON
 * @throws {Error} If no valid JSON can be extracted
 */
export function parseAIJson(text, options = {}) {
    if (!text || typeof text !== 'string') {
        throw new Error('parseAIJson: input must be a non-empty string');
    }

    // Strategy 1: Strip <think> blocks, markdown code fences, and try direct parse
    const stripped = text
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/```(?:json|javascript|js)?\n?/gi, '')
        .replace(/```\n?/g, '')
        .trim();

    try {
        return JSON.parse(stripped);
    } catch {
        // Continue to next strategy
    }

    // Strategy 2: Find the first { ... } or [ ... ] block
    const jsonMatch = stripped.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (jsonMatch) {
        try {
            return JSON.parse(jsonMatch[1]);
        } catch {
            // Continue to next strategy
        }
    }

    // Strategy 3: Try to find JSON in the original text (before stripping)
    const rawMatch = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (rawMatch) {
        try {
            return JSON.parse(rawMatch[1]);
        } catch {
            // Fall through
        }
    }

    // Nothing worked — return raw with error flag
    if (options.allowPartial) {
        return { raw: text, parseError: true };
    }

    throw new Error(`parseAIJson: could not extract valid JSON from response (${text.substring(0, 100)}...)`);
}

/**
 * Safely parse JSON with a fallback value.
 * Never throws — returns fallback on failure.
 *
 * @param {string} text - Raw text to parse
 * @param {*} [fallback=null] - Value to return if parsing fails
 * @returns {*} Parsed JSON or fallback
 */
export function safeParseJson(text, fallback = null) {
    try {
        return parseAIJson(text);
    } catch {
        return fallback;
    }
}
