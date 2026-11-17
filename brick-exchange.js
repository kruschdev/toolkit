/**
 * @module @krusch/toolkit/brick-exchange
 * @description Cryptographically attested multi-programmer Validated Brick Exchange (`INV-LEGO-35`).
 *
 * Adapts and generalizes multi-company contract verification, permission-first discovery,
 * and byte-exact lineage sealing concepts from `0xANUSHKA/common-ground-8090`
 * (EVOLVE 8090 Hackathon, MIT License, Copyright (c) 2026 Anushka Jogalekar and Common Ground contributors)
 * onto `@krusch/toolkit` zero-dependency runtime bricks.
 *
 * Key capabilities:
 * - Zero-ambient-I/O & Zero-Leak safety scanner + Node 22 `--permission` & `vm` sandbox (`sandbox.js`)
 * - 4-gate verification with mandatory adversarial fault-injection challenges (`runBrickVerificationGates`)
 * - Ed25519 lineage signatures + Tiered RBAC (`team` commons + Common Ground scoped cross-org `Grant`s)
 * - SQLite WAL + hash-chained `audit-log` store, explainable brief/boilerplate matcher, & optional HydraDB v2 boost
 * - Vendored immutable bricks (`bricks/<id>/`) + editable local `binding` + `.brick-lock.json` drift gate
 * - Built-in HTTP Hub + Reuse & Grants Web Console + 8-tool MCP server (`hub-and-mcp.js`)
 */

import { okEnvelope, errorEnvelope } from './http.js';
import {
    DEFAULT_SANDBOX_TIMEOUT_MS,
    DEFAULT_SANDBOX_MAX_MEMORY_MB,
    MAX_BRICK_SOURCE_BYTES,
    canonicalBrickHash,
    scanBrickSourceSafety,
    transpileBrickSourceToCjs,
    executeInBrickSandbox,
    runBrickVerificationGates
} from './brick-exchange/sandbox.js';
import {
    computeCanonicalHash,
    derivePublicKeyId,
    generateBrickSigningKeyPair,
    sealVerifiedBrick,
    verifyBrickBundle,
    canPublishBrick,
    canReceiveBrick
} from './brick-exchange/seal-and-policy.js';
import {
    createBrickExchangeStore,
    tryBrickLocally,
    adoptBrickIntoRepo,
    auditRepoBrickLocks
} from './brick-exchange/store-and-matcher.js';
import {
    renderBrickExchangeConsoleHtml,
    createBrickExchangeServer,
    BRICK_EXCHANGE_MCP_TOOLS,
    createBrickExchangeMcpServer
} from './brick-exchange/hub-and-mcp.js';
import {
    extractRepoAstGraph,
    analyzeBrickBlastRadius,
    planAgentFanOut,
    verifyTwoHopBlastRadius
} from './brick-exchange/blast-radius.js';

export {
    DEFAULT_SANDBOX_TIMEOUT_MS,
    DEFAULT_SANDBOX_MAX_MEMORY_MB,
    MAX_BRICK_SOURCE_BYTES,
    canonicalBrickHash,
    computeCanonicalHash,
    scanBrickSourceSafety,
    transpileBrickSourceToCjs,
    executeInBrickSandbox,
    runBrickVerificationGates,
    derivePublicKeyId,
    generateBrickSigningKeyPair,
    sealVerifiedBrick,
    verifyBrickBundle,
    canPublishBrick,
    canReceiveBrick,
    createBrickExchangeStore,
    tryBrickLocally,
    adoptBrickIntoRepo,
    auditRepoBrickLocks,
    renderBrickExchangeConsoleHtml,
    createBrickExchangeServer,
    BRICK_EXCHANGE_MCP_TOOLS,
    createBrickExchangeMcpServer,
    extractRepoAstGraph,
    analyzeBrickBlastRadius,
    planAgentFanOut,
    verifyTwoHopBlastRadius
};

/**
 * End-to-end 4-gate verification and Ed25519 sealing helper (`$0` deterministic).
 * Runs Gate 1 (Zero-Ambient-I/O & Zero-Leak), Gate 2 (Schema Contract),
 * Gate 3 (Positive + Adversarial Fault-Injection Checks), and Gate 4 (Ed25519 Lineage Seal).
 *
 * @param {object} options
 * @returns {Promise<import('./types/envelopes.js').LegoEnvelope<{ bundle: object, verification: object, keyPairGenerated: boolean }>>}
 */
export async function sealBrick(options = {}) {
    const {
        blueprint,
        source,
        positiveChecks = [],
        faultChecks = [],
        authorId = 'local-author',
        orgId = 'local-team',
        brickClass = 'general',
        capabilities = [],
        replacesBoilerplate = '',
        estimatedHoursSaved = 4,
        privateKeyPem = '',
        publicKeyPem = '',
        requirementId = null,
        provenance = 'agent-verified',
        createdAt = new Date().toISOString(),
        customRunner = null,
        timeoutMs = DEFAULT_SANDBOX_TIMEOUT_MS,
        maxMemoryMb = DEFAULT_SANDBOX_MAX_MEMORY_MB
    } = options;

    const verifyRes = await runBrickVerificationGates({
        blueprint,
        source,
        positiveChecks,
        faultChecks,
        customRunner,
        timeoutMs,
        maxMemoryMb
    });

    if (!verifyRes.ok) {
        return errorEnvelope(
            verifyRes.error?.code || 'BRICK_VERIFICATION_FAILED',
            verifyRes.error?.message || 'Brick failed pre-seal verification gates',
            verifyRes.error?.details ?? null,
            'brick-exchange.seal'
        );
    }

    let activePrivateKey = privateKeyPem;
    let activePublicKey = publicKeyPem;
    let keyPairGenerated = false;

    if (!activePrivateKey) {
        const keyRes = generateBrickSigningKeyPair();
        if (!keyRes.ok) {
            return keyRes;
        }
        activePrivateKey = keyRes.data.privateKeyPem;
        activePublicKey = keyRes.data.publicKeyPem;
        keyPairGenerated = true;
    }

    const sealRes = sealVerifiedBrick({
        blueprint,
        source,
        verificationReport: verifyRes.data,
        authorId,
        orgId,
        brickClass,
        capabilities,
        replacesBoilerplate,
        estimatedHoursSaved,
        privateKeyPem: activePrivateKey,
        publicKeyPem: activePublicKey,
        requirementId,
        provenance,
        createdAt
    });

    if (!sealRes.ok) {
        return sealRes;
    }

    return okEnvelope(
        'brick-exchange.seal',
        sealRes.summary,
        {
            bundle: sealRes.data.bundle,
            verification: verifyRes.data,
            keyPairGenerated
        }
    );
}

/**
 * Deterministic outer repair loop for coding agents (`$0` toolkit overhead).
 * Attempts `sealBrick`; when any gate fails, invokes `repairFn({ attempt, source, blueprint, repairHints, error })`
 * up to `maxAttempts` rounds until all 4 gates pass and the brick seals cleanly.
 *
 * @param {object} options
 * @returns {Promise<import('./types/envelopes.js').LegoEnvelope<{ bundle: object, attempts: number, history: Array<object> }>>}
 */
export async function runBrickRepairLoop(options = {}) {
    const {
        source: initialSource,
        repairFn,
        maxAttempts = 3,
        ...sealOptions
    } = options;

    const boundedMax = Number.isInteger(maxAttempts) && maxAttempts >= 1 ? Math.min(maxAttempts, 10) : 3;
    let candidateSource = String(initialSource ?? '');
    const history = [];

    for (let attempt = 1; attempt <= boundedMax; attempt += 1) {
        const res = await sealBrick({
            ...sealOptions,
            source: candidateSource
        });

        if (res.ok) {
            history.push({
                attempt,
                ok: true,
                sourceHash: res.data.bundle.lineage.sourceHash
            });
            return okEnvelope(
                'brick-exchange.repair-loop',
                `Sealed brick "${res.data.bundle.brickId}" on attempt ${attempt} of ${boundedMax}`,
                {
                    bundle: res.data.bundle,
                    verification: res.data.verification,
                    attempts: attempt,
                    history
                }
            );
        }

        const details = res.error?.details || {};
        const repairHints = Array.isArray(details.repairHints) ? details.repairHints : [];
        history.push({
            attempt,
            ok: false,
            code: res.error?.code || 'BRICK_VERIFICATION_FAILED',
            message: res.error?.message || 'Verification failed',
            repairHints
        });

        if (attempt >= boundedMax || typeof repairFn !== 'function') {
            return errorEnvelope(
                res.error?.code || 'BRICK_REPAIR_EXHAUSTED',
                `Brick failed to seal after ${attempt} attempt(s): ${res.error?.message || 'verification failed'}`,
                {
                    attempts: attempt,
                    maxAttempts: boundedMax,
                    lastSource: candidateSource,
                    repairHints,
                    history
                },
                'brick-exchange.repair-loop'
            );
        }

        const nextSource = await repairFn({
            attempt,
            maxAttempts: boundedMax,
            source: candidateSource,
            blueprint: sealOptions.blueprint,
            repairHints,
            error: res.error
        });

        if (typeof nextSource !== 'string' || nextSource.trim().length === 0) {
            return errorEnvelope(
                'REPAIR_FN_EMPTY_SOURCE',
                `repairFn returned an empty source string on attempt ${attempt}`,
                { attempts: attempt, history },
                'brick-exchange.repair-loop'
            );
        }

        candidateSource = nextSource;
    }

    return errorEnvelope(
        'BRICK_REPAIR_EXHAUSTED',
        'Brick repair loop exhausted',
        { attempts: boundedMax, history },
        'brick-exchange.repair-loop'
    );
}
