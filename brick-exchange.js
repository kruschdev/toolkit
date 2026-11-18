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
 * - Built-in HTTP Hub + Reuse & Grants Web Console + 10-tool MCP server (`hub-and-mcp.js`)
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
import {
    ONTOLOGY_STACKS,
    ONTOLOGY_DATA_PORTS,
    ONTOLOGY_CHANNELS,
    ONTOLOGY_MOE_PROFILES,
    CROSS_STACK_BRICK_EQUIVALENTS,
    CANONICAL_SHARED_TYPES,
    resolveCrossStackCatalogEquivalents,
    isWebStandardPureSource,
    parsePortReference,
    arePortsCompatible,
    normalizeBrickOntologyMetadata,
    checkOntologyCompatibility,
    surrogateOntologyVertexId,
    compileBrickOntologyGraph,
    syncBrickOntologyToHydra,
    traverseBrickOntology,
    applyFieldMapToSample,
    synthesizeBrickBinding
} from './brick-exchange/ontology.js';

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
    verifyTwoHopBlastRadius,
    ONTOLOGY_STACKS,
    ONTOLOGY_DATA_PORTS,
    ONTOLOGY_CHANNELS,
    ONTOLOGY_MOE_PROFILES,
    CROSS_STACK_BRICK_EQUIVALENTS,
    CANONICAL_SHARED_TYPES,
    resolveCrossStackCatalogEquivalents,
    isWebStandardPureSource,
    parsePortReference,
    arePortsCompatible,
    normalizeBrickOntologyMetadata,
    checkOntologyCompatibility,
    surrogateOntologyVertexId,
    compileBrickOntologyGraph,
    syncBrickOntologyToHydra,
    traverseBrickOntology,
    applyFieldMapToSample,
    synthesizeBrickBinding
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
        ontology = null,
        createdAt = new Date().toISOString(),
        customRunner = null,
        timeoutMs = DEFAULT_SANDBOX_TIMEOUT_MS,
        maxMemoryMb = DEFAULT_SANDBOX_MAX_MEMORY_MB
    } = options;

    let effectiveBlueprint = blueprint;
    if (ontology && typeof ontology === 'object' && blueprint && typeof blueprint === 'object') {
        const normRes = normalizeBrickOntologyMetadata(ontology, { source, blueprint });
        if (!normRes.ok) {
            return normRes;
        }
        effectiveBlueprint = {
            ...blueprint,
            ontology: normRes.data.ontology
        };
    }

    const verifyRes = await runBrickVerificationGates({
        blueprint: effectiveBlueprint,
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
        blueprint: effectiveBlueprint,
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

/**
 * Bridge `@krusch/toolkit/lego-scout` Rule-of-3 findings directly into the Validated Brick Exchange.
 * Converts qualifying `CANDIDATE_MEETS_RULE_OF_3` clusters into structured `krusch-lego seal` spec drafts,
 * and when `implementations[clusterId]` is provided, runs all 4 verification & Ed25519 sealing gates,
 * optionally publishing into `store` and computing permission-gated recipient inbox suggestions.
 *
 * @param {object} scoutReport - Output envelope or `.data` payload from `scoutHomelabLegoCandidates`
 * @param {object} [options={}]
 */
export async function stageScoutCandidateSpecs(scoutReport, options = {}) {
    const tool = 'brick-exchange.scout-bridge';
    const rawData =
        scoutReport && typeof scoutReport === 'object' && Array.isArray(scoutReport.candidateClusters)
            ? scoutReport
            : scoutReport?.data && Array.isArray(scoutReport.data.candidateClusters)
              ? scoutReport.data
              : null;

    if (!rawData) {
        return errorEnvelope(
            'INVALID_SCOUT_REPORT',
            'Expected scoutReport from scoutHomelabLegoCandidates with candidateClusters array',
            null,
            tool
        );
    }

    const {
        includeCovered = false,
        implementations = {},
        authorId = 'jean-sre',
        orgId = 'local-team',
        privateKeyPem = '',
        store = null
    } = options;

    const eligibleClusters = rawData.candidateClusters.filter(
        (c) =>
            c &&
            (c.status === 'CANDIDATE_MEETS_RULE_OF_3' ||
                (includeCovered === true && c.meetsRuleOfThree === true))
    );

    const specDrafts = [];
    const sealedBundles = [];
    const sealFailures = [];

    for (const cluster of eligibleClusters) {
        const cleanSlug = String(cluster.id || '')
            .toLowerCase()
            .replace(/[^a-z0-9-_]/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 63);
        if (!cleanSlug) continue;

        const capabilities = [
            cluster.category || 'infrastructure',
            cleanSlug,
            ...(Array.isArray(cluster.projects) ? cluster.projects.slice(0, 3) : [])
        ]
            .map((s) => String(s).trim())
            .filter(Boolean);

        const hoursSaved = Math.max(4, Number(cluster.projectCount || 3) * 3);
        const draftBlueprint = {
            id: cleanSlug,
            name: cluster.title || cleanSlug,
            summary: cluster.antiBloatNote || `Shared Rule-of-3 brick extracted from ${cluster.projectCount} repositories.`,
            exportName: 'default',
            inputSchema: { type: 'object' },
            outputSchema: { type: 'object' }
        };

        const draft = {
            clusterId: cluster.id,
            brickId: cleanSlug,
            projectCount: cluster.projectCount,
            matchedProjects: Array.isArray(cluster.projects) ? [...cluster.projects] : [],
            sampleEvidence: Array.isArray(cluster.sampleEvidence) ? [...cluster.sampleEvidence] : [],
            proposedBrickImport: cluster.proposedBrickImport || `@krusch/toolkit/${cleanSlug}`,
            capabilities,
            replacesBoilerplate: cluster.antiBloatNote || cluster.title || cleanSlug,
            estimatedHoursSaved: hoursSaved,
            blueprint: draftBlueprint,
            cliHint: `krusch-lego seal ./${cleanSlug}.spec.json --out ./${cleanSlug}.brick.json`
        };
        specDrafts.push(draft);

        const impl = implementations && typeof implementations === 'object' ? implementations[cluster.id] || implementations[cleanSlug] : null;
        if (impl && typeof impl === 'object' && typeof impl.source === 'string') {
            const mergedBlueprint = {
                ...draftBlueprint,
                ...(impl.blueprint && typeof impl.blueprint === 'object' ? impl.blueprint : {})
            };
            const sealRes = await sealBrick({
                blueprint: mergedBlueprint,
                source: impl.source,
                positiveChecks: Array.isArray(impl.positiveChecks) ? impl.positiveChecks : [],
                faultChecks: Array.isArray(impl.faultChecks) ? impl.faultChecks : [],
                authorId,
                orgId,
                brickClass: cluster.category || 'general',
                capabilities,
                replacesBoilerplate: draft.replacesBoilerplate,
                estimatedHoursSaved: hoursSaved,
                privateKeyPem
            });

            if (!sealRes.ok) {
                sealFailures.push({
                    clusterId: cluster.id,
                    brickId: cleanSlug,
                    error: sealRes.error
                });
                continue;
            }

            const bundle = sealRes.data.bundle;
            let published = null;
            let suggestions = [];

            if (store && typeof store.publishSealedBrick === 'function') {
                const pubRes = store.publishSealedBrick(bundle, { actorId: authorId });
                published = pubRes;
                if (pubRes.ok && typeof store.suggestRecipients === 'function') {
                    const sugRes = await store.suggestRecipients({
                        actorId: authorId,
                        brickId: bundle.brickId,
                        sourceHash: bundle.lineage.sourceHash
                    });
                    if (sugRes.ok && Array.isArray(sugRes.data?.suggestions)) {
                        suggestions = sugRes.data.suggestions;
                    }
                }
            }

            sealedBundles.push({
                clusterId: cluster.id,
                brickId: bundle.brickId,
                sourceHash: bundle.lineage.sourceHash,
                bundle,
                published,
                suggestions
            });
        }
    }

    return okEnvelope(
        tool,
        `Staged ${specDrafts.length} Rule-of-3 scout candidate(s) (${sealedBundles.length} sealed, ${sealFailures.length} failed gates)`,
        {
            qualifyingClusterCount: specDrafts.length,
            specDrafts,
            sealedBundles,
            sealFailures
        }
    );
}
