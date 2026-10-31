/**
 * @module prune
 * @description Stage-Aware Context Pruning Middleware based on:
 * "Not Worth Another Token: Marginal Value Estimation for Efficient Deep Research Agents" (arXiv: 2608.08389).
 * 
 * Provides lightweight, stage-aware context pruning at:
 * 1. Pre-Retrieval (query deduplication, history budgeting, filler elimination)
 * 2. Post-Retrieval (marginal value estimation, redundancy gating, token budget enforcement)
 * 3. Pre-Synthesis (salience extraction, boilerplate removal, context condensation)
 */

/**
 * Pre-Retrieval Pruning: Cleans queries and history before hitting search/memory indices.
 *
 * @param {string} query - Raw search query or user intent.
 * @param {Array<{role: string, content: string}>} [history=[]] - Conversation history.
 * @param {object} [options={}] - Options.
 * @param {number} [options.maxHistoryTurns=5] - Maximum recent conversation turns to retain.
 * @param {boolean} [options.stripPoliteness=true] - Remove conversational filler and politeness phrases.
 * @returns {{ query: string, history: Array<{role: string, content: string}>, tokensSavedEst: number }}
 */
export function prunePreRetrieval(query, history = [], options = {}) {
    const { maxHistoryTurns = 5, stripPoliteness = true } = options;
    let prunedQuery = query || "";
    let originalLen = prunedQuery.length;

    if (stripPoliteness) {
        // Strip common conversational fillers and preamble (iteratively)
        let changed = true;
        while (changed) {
            const before = prunedQuery;
            prunedQuery = prunedQuery
                .replace(/^(?:hey|hello|hi|greetings|dear|please)[,.\s]+/i, '')
                .replace(/^(?:could you please|can you please|would you kindly|would you please|i want you to|i need you to|tell me|show me)[,.\s]+/i, '')
                .replace(/\b(?:as we discussed earlier|like i mentioned before|as you know)\b/gi, '')
                .replace(/\b(?:thanks in advance|thank you very much|thank you|thanks|let me know what you think)[.!?\s]*$/gi, '')
                .trim();
            changed = before !== prunedQuery;
        }
    }

    // Deduplicate consecutive whitespace and punctuation
    prunedQuery = prunedQuery.replace(/\s+/g, ' ').replace(/([?!.,;])\1+/g, '$1').trim();

    // Budget history turns
    const prunedHistory = history.slice(-maxHistoryTurns);
    const historyOriginalTokens = history.reduce((sum, h) => sum + (h.content?.length || 0) / 4, 0);
    const historyPrunedTokens = prunedHistory.reduce((sum, h) => sum + (h.content?.length || 0) / 4, 0);

    const queryTokensSaved = Math.max(0, Math.round((originalLen - prunedQuery.length) / 4));
    const historyTokensSaved = Math.max(0, Math.round(historyOriginalTokens - historyPrunedTokens));

    return {
        query: prunedQuery,
        history: prunedHistory,
        tokensSavedEst: queryTokensSaved + historyTokensSaved
    };
}

/**
 * Helper: Computes token-level Jaccard similarity between two text strings.
 * @private
 */
function computeJaccardSimilarity(textA, textB) {
    if (!textA || !textB) return 0;
    const tokensA = new Set(textA.toLowerCase().split(/\W+/).filter(w => w.length > 2));
    const tokensB = new Set(textB.toLowerCase().split(/\W+/).filter(w => w.length > 2));
    
    if (tokensA.size === 0 || tokensB.size === 0) return 0;

    let intersectionCount = 0;
    for (const token of tokensA) {
        if (tokensB.has(token)) intersectionCount++;
    }

    const unionCount = tokensA.size + tokensB.size - intersectionCount;
    return unionCount === 0 ? 0 : intersectionCount / unionCount;
}

/**
 * Post-Retrieval Pruning: Marginal value estimation to eliminate redundant retrieved context chunks.
 *
 * @param {Array<string|{text: string, id?: any, score?: number}>} chunks - Array of retrieved chunks.
 * @param {string} [query=""] - Original query for relevance estimation.
 * @param {object} [options={}] - Pruning options.
 * @param {number} [options.redundancyThreshold=0.55] - Max Jaccard overlap allowed with previously selected chunks.
 * @param {number} [options.maxTokens=3000] - Hard cap on total tokens in pruned output.
 * @param {number} [options.minScore=0.0] - Minimum relevance score threshold (if score property exists).
 * @returns {{ chunks: Array<any>, originalCount: number, prunedCount: number, tokensSavedEst: number }}
 */
export function prunePostRetrieval(chunks = [], query = "", options = {}) {
    const {
        redundancyThreshold = 0.55,
        maxTokens = 3000,
        minScore = 0.0
    } = options;

    if (!Array.isArray(chunks) || chunks.length === 0) {
        return { chunks: [], originalCount: 0, prunedCount: 0, tokensSavedEst: 0 };
    }

    const originalCount = chunks.length;
    let totalOriginalChars = 0;

    const normalizedChunks = chunks.map(chunk => {
        if (typeof chunk === 'string') {
            totalOriginalChars += chunk.length;
            return { text: chunk, raw: chunk };
        }
        const text = chunk.text || chunk.content || JSON.stringify(chunk);
        totalOriginalChars += text.length;
        return { ...chunk, text, raw: chunk };
    });

    // Filter by min score if available
    const scoreFiltered = normalizedChunks.filter(c => c.score === undefined || c.score >= minScore);

    const selected = [];
    let accumulatedTokens = 0;

    for (const candidate of scoreFiltered) {
        const candidateText = candidate.text;
        const candidateTokensEst = Math.ceil(candidateText.length / 4);

        if (accumulatedTokens + candidateTokensEst > maxTokens && selected.length > 0) {
            continue; // Exceeds budget
        }

        // Marginal Value Estimation: Check redundancy against all already-selected chunks
        let isRedundant = false;
        for (const existing of selected) {
            const overlap = computeJaccardSimilarity(candidateText, existing.text);
            if (overlap > redundancyThreshold) {
                isRedundant = true;
                break;
            }
        }

        if (!isRedundant) {
            selected.push(candidate);
            accumulatedTokens += candidateTokensEst;
        }
    }

    const prunedChars = selected.reduce((sum, c) => sum + c.text.length, 0);
    const tokensSavedEst = Math.max(0, Math.round((totalOriginalChars - prunedChars) / 4));

    return {
        chunks: selected.map(s => s.raw),
        originalCount,
        prunedCount: selected.length,
        tokensSavedEst
    };
}

/**
 * Pre-Synthesis Pruning: Strips boilerplate and extracts high-salience text prior to final LLM synthesis.
 *
 * @param {string|Array<string>} documents - Document string or array of document strings.
 * @param {object} [options={}] - Options.
 * @param {number} [options.maxSentencesPerDoc=20] - Max salient sentences per document.
 * @param {boolean} [options.stripBoilerplate=true] - Remove headers/footers/copyright/cookie text.
 * @returns {{ text: string, tokensSavedEst: number }}
 */
export function prunePreSynthesis(documents, options = {}) {
    const { maxSentencesPerDoc = 20, stripBoilerplate = true } = options;
    const docArray = Array.isArray(documents) ? documents : [documents];
    let totalOriginalLength = 0;
    const processedDocs = [];

    const boilerplateRegexes = [
        /Copyright\s+(?:\(c\)|©)?\s*\d{4}.*$/gim,
        /All\s+rights\s+reserved\.?/gim,
        /Terms\s+of\s+(?:Service|Use)|Privacy\s+Policy/gim,
        /Cookie\s+(?:Settings|Preferences|Notice)/gim,
        /^#{1,6}\s*(?:Navigation|Footer|Menu|Header)\s*$/gim,
        /<!--[\s\S]*?-->/g
    ];

    for (let doc of docArray) {
        if (!doc || typeof doc !== 'string') continue;
        totalOriginalLength += doc.length;

        let cleaned = doc;
        if (stripBoilerplate) {
            for (const rx of boilerplateRegexes) {
                cleaned = cleaned.replace(rx, '');
            }
        }

        // Split into sentences and deduplicate
        const sentences = cleaned
            .split(/(?<=[.?!])\s+/)
            .map(s => s.trim())
            .filter(s => s.length > 15); // Discard trivial fragments

        const uniqueSentences = [];
        const seenNgrams = new Set();

        for (const sent of sentences) {
            const prefix = sent.slice(0, 40).toLowerCase();
            if (!seenNgrams.has(prefix)) {
                seenNgrams.add(prefix);
                uniqueSentences.push(sent);
            }
            if (uniqueSentences.length >= maxSentencesPerDoc) break;
        }

        processedDocs.push(uniqueSentences.join(' '));
    }

    const finalText = processedDocs.join('\n\n');
    const tokensSavedEst = Math.max(0, Math.round((totalOriginalLength - finalText.length) / 4));

    return {
        text: finalText,
        tokensSavedEst
    };
}

/**
 * Knowledge Boundary-Aware Router: Evaluates whether external episodic/semantic memory is needed for a query.
 * Based on: "Memory Is Not Always Needed: Characterizing Conditional Memory in Scientific Reasoning" (arXiv: 2608.23982).
 *
 * Prevents cognitive distraction and token bloat on self-contained tasks (e.g. math, syntax, pure code formatting).
 *
 * @param {string} query - Raw search query or user intent.
 * @param {object} [options={}] - Router options.
 * @param {Array<string>} [options.memoryTriggerKeywords] - Custom keywords that force memory activation.
 * @param {Array<string>} [options.selfContainedPatterns] - Regex patterns that bypass memory retrieval.
 * @returns {{ shouldActivate: boolean, activationStrength: 'NONE'|'LOW'|'MEDIUM'|'HIGH', rationale: string, domainCategory: string|null, tokensSavedEst: number }}
 */
export function shouldActivateMemory(query = "", options = {}) {
    const text = (query || "").trim().toLowerCase();
    if (!text) {
        return {
            shouldActivate: false,
            activationStrength: 'NONE',
            rationale: "Empty query does not require memory activation.",
            domainCategory: null,
            tokensSavedEst: 500
        };
    }

    // 1. Check for explicit Platform / Infrastructure memory triggers
    const domainKeywords = {
        infra_ops: ['postgres', 'postgresql', 'docker', 'cluster', 'tailscale', 'port', 'ssh', 'backup', 'hardware', 'server', 'node', 'vram', 'gpu', 'database'],
        user_identity: ['billing', 'retainer', 'rate', 'hourly', 'profile', 'address', 'account', 'client', 'preference'],
        domain_rules: ['spec', 'invariant', 'policy', 'refactor', 'toolkit', 'doctrine', 'rule', 'governance', 'crdt', 'agentroom', 'mind virus'],
        episodic_history: ['session', 'yesterday', 'earlier', 'previous', 'remember', 'recall', 'last time', 'history', 'decision', 'why did we']
    };

    if (Array.isArray(options.memoryTriggerKeywords)) {
        domainKeywords.custom = options.memoryTriggerKeywords.map(k => k.toLowerCase());
    }

    for (const [category, keywords] of Object.entries(domainKeywords)) {
        for (const kw of keywords) {
            if (text.includes(kw)) {
                return {
                    shouldActivate: true,
                    activationStrength: 'HIGH',
                    rationale: `Matched domain memory anchor "${kw}" in category [${category}].`,
                    domainCategory: category,
                    tokensSavedEst: 0
                };
            }
        }
    }

    // 2. Identify self-contained tasks where memory causes interference (arXiv: 2608.23982)
    const selfContainedRegexes = [
        // Pure arithmetic or calculation
        /^(?:calculate|compute|what is|\d+[\s+\-*/^%]+\d+)/i,
        // Pure syntax or regex transforms
        /^(?:regex to|write a regex|format this json|lint|fix indentation|convert to camelcase|convert to snake_case)/i,
        // Standalone algorithms without project dependencies
        /^(?:write a quicksort|binary search in|implement fibonacci|hello world in|bubble sort)/i,
        // Simple string manipulation or dictionary lookups
        /^(?:reverse this string|uppercase this|count words in|sort these numbers)/i
    ];

    if (Array.isArray(options.selfContainedPatterns)) {
        for (const pat of options.selfContainedPatterns) {
            selfContainedRegexes.push(typeof pat === 'string' ? new RegExp(pat, 'i') : pat);
        }
    }

    for (const rx of selfContainedRegexes) {
        if (rx.test(text)) {
            return {
                shouldActivate: false,
                activationStrength: 'NONE',
                rationale: "Task is mathematically or syntactically self-contained; memory retrieval bypassed to avoid cognitive interference.",
                domainCategory: null,
                tokensSavedEst: 800 // Estimated tokens saved by skipping irrelevant episodic retrieval
            };
        }
    }

    // 3. Questions asking for general world knowledge vs workspace state
    const isGeneralInquiry = /^(?:explain how|what is the concept of|define|how does|what is)\s+[a-z0-9\s_-]+$/i.test(text);
    if (isGeneralInquiry && !text.includes('workspace') && !text.includes('our') && !text.includes('we')) {
        return {
            shouldActivate: false,
            activationStrength: 'LOW',
            rationale: "General conceptual inquiry; external workspace memory unlikely to add value.",
            domainCategory: null,
            tokensSavedEst: 500
        };
    }

    // Default: Moderate activation for conversational context
    return {
        shouldActivate: true,
        activationStrength: 'MEDIUM',
        rationale: "Query contains potential multi-turn or project references; memory activated with standard pruning.",
        domainCategory: 'general',
        tokensSavedEst: 0
    };
}

/**
 * Creates a Knowledge Boundary-Aware Router instance.
 *
 * @param {object} [config={}] - Global router configuration.
 * @returns {object} Router instance.
 */
export function createKnowledgeBoundaryRouter(config = {}) {
    return {
        evaluate: (query, opts) => shouldActivateMemory(query, { ...config, ...opts })
    };
}

/**
 * Creates an end-to-end Context Pruner pipeline.
 *
 * @param {object} [config={}] - Global pruner configuration.
 * @returns {object} Context pruner instance.
 */
export function createContextPruner(config = {}) {
    const router = createKnowledgeBoundaryRouter(config.router || {});

    return {
        preRetrieval: (query, history, opts) => prunePreRetrieval(query, history, { ...config, ...opts }),
        postRetrieval: (chunks, query, opts) => prunePostRetrieval(chunks, query, { ...config, ...opts }),
        preSynthesis: (docs, opts) => prunePreSynthesis(docs, { ...config, ...opts }),
        shouldActivateMemory: (query, opts) => router.evaluate(query, opts),
        
        /**
         * Runs a full 3-stage prune on a pipeline with Knowledge Boundary conditional memory gating.
         */
        executePipeline: async ({ query, history, fetchChunksFn, options = {} }) => {
            const pre = prunePreRetrieval(query, history, options.preRetrieval);
            
            // Knowledge Boundary Router Check (arXiv: 2608.23982)
            const memoryRouting = router.evaluate(pre.query, options.router);
            let rawChunks = [];
            let memoryBypassedTokens = 0;

            if (memoryRouting.shouldActivate && typeof fetchChunksFn === 'function') {
                rawChunks = await fetchChunksFn(pre.query);
            } else {
                memoryBypassedTokens = memoryRouting.tokensSavedEst;
            }

            const post = prunePostRetrieval(rawChunks, pre.query, options.postRetrieval);
            const synth = prunePreSynthesis(post.chunks.map(c => typeof c === 'string' ? c : (c.text || JSON.stringify(c))), options.preSynthesis);

            return {
                cleanQuery: pre.query,
                prunedHistory: pre.history,
                selectedChunks: post.chunks,
                synthesizedContext: synth.text,
                memoryRouting,
                totalTokensSaved: pre.tokensSavedEst + post.tokensSavedEst + synth.tokensSavedEst + memoryBypassedTokens,
                stats: {
                    rawChunkCount: post.originalCount,
                    prunedChunkCount: post.prunedCount,
                    memoryActivated: memoryRouting.shouldActivate
                }
            };
        }
    };
}

