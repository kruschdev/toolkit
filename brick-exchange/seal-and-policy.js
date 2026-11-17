/**
 * @module @krusch/toolkit/brick-exchange/seal-and-policy
 * @description Gate 4 Ed25519 cryptographic brick sealing, tamper-evident lineage verification,
 * and fail-closed multi-organization RBAC + scoped federated grant policy evaluation (`INV-LEGO-35`).
 *
 * Attribution & License Notice:
 * Multi-company permission evaluation, mutual peer allowlisting, sender muting, exporter revocation
 * enforcement, and scoped non-reshareable federated grant lineage concepts are adapted from
 * `0xANUSHKA/common-ground-8090` (`MIT License`, Copyright (c) 2026 Anushka Jogalekar and
 * Common Ground contributors).
 *
 * Zero external npm packages; depends only on `node:crypto` and sibling `@krusch/toolkit` bricks
 * (`../http.js`, `../audit-log.js`, `../rbac.js`).
 */

import crypto from 'node:crypto';
import { okEnvelope, errorEnvelope } from '../http.js';
import { canonicalizeAuditPayload } from '../audit-log.js';
import { createRbacPolicy, evaluateAccess } from '../rbac.js';
import { toJsonSchema } from '../schema.js';

const SEAL_DOMAIN_PREFIX = 'krusch-brick-seal-v1:';
const SEAL_ATTESTATION_DOMAIN = 'krusch-brick-seal-v1';
const SEALED_BUNDLE_FORMAT = 'krusch-sealed-brick/v1';
const LINEAGE_STANDARD = 'krusch-brick-exchange-v1';

const BRICK_ID_RE = /^[a-z0-9][a-z0-9-_]{1,63}$/;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const HEX128_RE = /^[0-9a-f]{128}$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Immutable RBAC policy enforcing role-gated team and federated brick exchange actions.
 */
const BRICK_EXCHANGE_RBAC_POLICY = createRbacPolicy({
    roles: {
        member: {
            allow: ['brick:receive:team'],
            description: 'Workspace member eligible for same-org team commons bricks',
        },
        federated_receiver: {
            inherits: ['member'],
            allow: ['brick:receive:federated'],
            allowCrossTenant: true,
            description: 'Workspace member opted into federated cross-org brick grants',
        },
        publisher: {
            inherits: ['member'],
            allow: ['brick:publish:team'],
            description: 'Authorized workspace brick publisher',
        },
        exporter: {
            inherits: ['publisher'],
            allow: ['brick:publish:federated'],
            description: 'Authorized cross-organization federated brick exporter',
        },
    },
});

function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

function isSafeIdentifier(value) {
    if (typeof value !== 'string') {
        return false;
    }
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed !== value) {
        return false;
    }
    if (FORBIDDEN_KEYS.has(trimmed) || trimmed.includes('..')) {
        return false;
    }
    return SAFE_ID_RE.test(trimmed);
}

function constantTimeHexEqual(actual, expectedHex) {
    if (typeof expectedHex !== 'string' || expectedHex.length === 0) {
        return false;
    }
    const expectedBuf = Buffer.from(expectedHex, 'utf8');
    if (typeof actual !== 'string') {
        crypto.timingSafeEqual(expectedBuf, expectedBuf);
        return false;
    }
    const actualBuf = Buffer.from(actual, 'utf8');
    if (actualBuf.length !== expectedBuf.length) {
        crypto.timingSafeEqual(expectedBuf, expectedBuf);
        return false;
    }
    return crypto.timingSafeEqual(actualBuf, expectedBuf);
}

function constantTimeStringEqual(actual, expected) {
    if (typeof actual !== 'string' || typeof expected !== 'string') {
        return false;
    }
    const aBuf = Buffer.from(actual, 'utf8');
    const bBuf = Buffer.from(expected, 'utf8');
    if (aBuf.length !== bBuf.length) {
        if (bBuf.length > 0) {
            crypto.timingSafeEqual(bBuf, bBuf);
        }
        return false;
    }
    if (bBuf.length === 0) {
        return true;
    }
    return crypto.timingSafeEqual(aBuf, bBuf);
}

function fallbackDeterministicStringify(value, seen = new WeakSet()) {
    if (value === null || value === undefined) {
        return 'null';
    }
    const type = typeof value;
    if (type === 'boolean') {
        return value ? 'true' : 'false';
    }
    if (type === 'number') {
        if (!Number.isFinite(value)) {
            return JSON.stringify(String(value));
        }
        return Object.is(value, -0) ? '0' : JSON.stringify(value);
    }
    if (type === 'string') {
        return JSON.stringify(value);
    }
    if (type === 'bigint' || type === 'symbol' || type === 'function') {
        return JSON.stringify(String(value));
    }
    if (value instanceof Date) {
        const ms = value.getTime();
        return Number.isFinite(ms) ? JSON.stringify(value.toISOString()) : 'null';
    }
    if (typeof value === 'object') {
        if (seen.has(value)) {
            return '"[Circular]"';
        }
        seen.add(value);
        try {
            if (Array.isArray(value)) {
                const items = value.map((item) =>
                    item === undefined ? 'null' : fallbackDeterministicStringify(item, seen)
                );
                return `[${items.join(',')}]`;
            }
            const keys = Object.keys(value).sort();
            const entries = [];
            for (let i = 0; i < keys.length; i += 1) {
                const key = keys[i];
                if (FORBIDDEN_KEYS.has(key) || value[key] === undefined) {
                    continue;
                }
                entries.push(
                    `${JSON.stringify(key)}:${fallbackDeterministicStringify(value[key], seen)}`
                );
            }
            return `{${entries.join(',')}}`;
        } finally {
            seen.delete(value);
        }
    }
    return 'null';
}

function deepFreezeClone(value) {
    if (value === null || value === undefined) {
        return value;
    }
    if (typeof value === 'number') {
        return Object.is(value, -0) ? 0 : value;
    }
    if (typeof value !== 'object') {
        return value;
    }
    if (value instanceof Date) {
        const ms = value.getTime();
        return Number.isFinite(ms) ? value.toISOString() : null;
    }
    if (Array.isArray(value)) {
        const clonedArr = value.map((item) => (item === undefined ? null : deepFreezeClone(item)));
        return Object.freeze(clonedArr);
    }
    const clonedObj = {};
    const keys = Object.keys(value).sort();
    for (let i = 0; i < keys.length; i += 1) {
        const key = keys[i];
        if (!FORBIDDEN_KEYS.has(key) && value[key] !== undefined) {
            clonedObj[key] = deepFreezeClone(value[key]);
        }
    }
    return Object.freeze(clonedObj);
}

function normalizeSchemaField(candidate) {
    if (!candidate || typeof candidate !== 'object') {
        return candidate;
    }
    if (typeof candidate.toJsonSchema === 'function' || typeof candidate.safeParse === 'function') {
        try {
            return toJsonSchema(candidate);
        } catch {
            return candidate;
        }
    }
    return candidate;
}

function normalizeBlueprintForSeal(blueprint) {
    if (!isPlainObject(blueprint)) {
        return blueprint;
    }
    const normalized = { ...blueprint };
    if (normalized.inputSchema !== undefined) {
        normalized.inputSchema = normalizeSchemaField(normalized.inputSchema);
    }
    if (normalized.outputSchema !== undefined) {
        normalized.outputSchema = normalizeSchemaField(normalized.outputSchema);
    }
    if (normalized.bindingSchema !== undefined) {
        normalized.bindingSchema = normalizeSchemaField(normalized.bindingSchema);
    }
    return normalized;
}

function extractContractShape(blueprint) {
    return {
        inputSchema: normalizeSchemaField(blueprint?.inputSchema) ?? {},
        outputSchema: normalizeSchemaField(blueprint?.outputSchema) ?? {},
        bindingSchema: normalizeSchemaField(blueprint?.bindingSchema) ?? {},
    };
}

/**
 * Compute a deterministic 64-character lowercase SHA-256 hex digest.
 * Hashes raw UTF-8 bytes directly when `value` is a string; otherwise canonicalizes via
 * `canonicalizeAuditPayload` from `@krusch/toolkit/audit-log` (matching `canonicalBrickHash`).
 *
 * @param {unknown} value - Input string or JSON-compatible value
 * @returns {string} 64-character lowercase SHA-256 hex digest
 */
export function computeCanonicalHash(value) {
    if (typeof value === 'string') {
        return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
    }
    const canon = canonicalizeAuditPayload(value, { tool: 'brick-exchange.hash' });
    const serialized = canon.ok ? canon.data.canonicalJson : fallbackDeterministicStringify(value);
    return crypto.createHash('sha256').update(serialized, 'utf8').digest('hex');
}

/**
 * Derive a deterministic key identifier (`key_<16hex>`) from an SPKI PEM public key.
 *
 * @param {string} publicKeyPem - Ed25519 SPKI PEM public key
 * @returns {string} Key identifier prefixed with `key_`
 */
export function derivePublicKeyId(publicKeyPem) {
    const pem = String(publicKeyPem || '').trim();
    const pubKey = crypto.createPublicKey(pem);
    const spkiDer = pubKey.export({ type: 'spki', format: 'der' });
    const digest = crypto.createHash('sha256').update(spkiDer).digest('hex');
    return `key_${digest.slice(0, 16)}`;
}

/**
 * Generate a fresh Ed25519 signing keypair for sealing verified bricks.
 *
 * @returns {{ ok: true, tool: string, summary: string, data: { keyId: string, publicKeyPem: string, privateKeyPem: string, algorithm: 'ed25519' } }}
 */
export function generateBrickSigningKeyPair() {
    const { publicKey: publicKeyPem, privateKey: privateKeyPem } = crypto.generateKeyPairSync(
        'ed25519',
        {
            publicKeyEncoding: { type: 'spki', format: 'pem' },
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        }
    );
    const keyId = derivePublicKeyId(publicKeyPem);
    return okEnvelope('brick-exchange.keygen', 'Generated Ed25519 brick signing keypair', {
        keyId,
        publicKeyPem,
        privateKeyPem,
        algorithm: 'ed25519',
    });
}

/**
 * Gate 4 cryptographic brick sealing. Verifies sandbox qualification invariants, computes
 * canonical source/blueprint/contract/checks digests, signs the domain-separated lineage with
 * Ed25519, and returns a deep-frozen sealed brick bundle.
 *
 * @param {object} [options={}]
 * @returns {ReturnType<typeof okEnvelope> | ReturnType<typeof errorEnvelope>}
 */
export function sealVerifiedBrick({
    blueprint,
    source,
    verificationReport,
    authorId,
    orgId,
    brickClass = 'general',
    capabilities = [],
    replacesBoilerplate = '',
    estimatedHoursSaved = 4,
    privateKeyPem,
    publicKeyPem = '',
    requirementId = null,
    provenance = 'agent-verified',
    createdAt = new Date().toISOString(),
} = {}) {
    const tool = 'brick-exchange.seal';

    if (typeof source !== 'string' || source.trim().length === 0) {
        return errorEnvelope(
            'BRICK_NOT_QUALIFIED',
            'Brick source must be a non-empty string',
            { field: 'source' },
            tool
        );
    }

    if (
        !isPlainObject(blueprint) ||
        typeof blueprint.id !== 'string' ||
        !BRICK_ID_RE.test(blueprint.id)
    ) {
        return errorEnvelope(
            'BRICK_NOT_QUALIFIED',
            'Blueprint must provide a valid lowercase slug id matching /^[a-z0-9][a-z0-9-_]{1,63}$/',
            { field: 'blueprint.id' },
            tool
        );
    }

    if (!isSafeIdentifier(authorId) || !isSafeIdentifier(orgId)) {
        return errorEnvelope(
            'BRICK_NOT_QUALIFIED',
            'authorId and orgId must be non-empty safe identifiers',
            { field: !isSafeIdentifier(authorId) ? 'authorId' : 'orgId' },
            tool
        );
    }

    const normalizedClass = typeof brickClass === 'string' ? brickClass.trim() : '';
    if (!isSafeIdentifier(normalizedClass)) {
        return errorEnvelope(
            'BRICK_NOT_QUALIFIED',
            'brickClass must be a non-empty safe identifier',
            { field: 'brickClass' },
            tool
        );
    }

    const normalizedProvenance = typeof provenance === 'string' ? provenance.trim() : '';
    if (normalizedProvenance.length === 0) {
        return errorEnvelope(
            'BRICK_NOT_QUALIFIED',
            'provenance must be a non-empty string',
            { field: 'provenance' },
            tool
        );
    }

    if (typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt))) {
        return errorEnvelope(
            'BRICK_NOT_QUALIFIED',
            'createdAt must be a valid ISO-8601 timestamp string',
            { field: 'createdAt' },
            tool
        );
    }

    if (
        requirementId !== null &&
        requirementId !== undefined &&
        requirementId !== '' &&
        !isSafeIdentifier(String(requirementId))
    ) {
        return errorEnvelope(
            'BRICK_NOT_QUALIFIED',
            'requirementId must be null or a safe identifier',
            { field: 'requirementId' },
            tool
        );
    }

    if (typeof privateKeyPem !== 'string' || privateKeyPem.trim().length === 0) {
        return errorEnvelope(
            'BRICK_NOT_QUALIFIED',
            'An Ed25519 privateKeyPem is required to seal a brick',
            { field: 'privateKeyPem' },
            tool
        );
    }

    let privKey;
    let derivedPubPem;
    let keyId;
    try {
        privKey = crypto.createPrivateKey(privateKeyPem.trim());
        if (privKey.asymmetricKeyType !== 'ed25519') {
            return errorEnvelope(
                'BRICK_NOT_QUALIFIED',
                'Signing key must be an ed25519 private key',
                { algorithm: privKey.asymmetricKeyType || 'unknown' },
                tool
            );
        }
        const exportedPub = crypto.createPublicKey(privKey).export({ type: 'spki', format: 'pem' });
        derivedPubPem = typeof exportedPub === 'string' ? exportedPub : exportedPub.toString('utf8');
        keyId = derivePublicKeyId(derivedPubPem);
    } catch (err) {
        return errorEnvelope(
            'BRICK_NOT_QUALIFIED',
            `Invalid Ed25519 private key PEM: ${err instanceof Error ? err.message : 'parse failed'}`,
            { field: 'privateKeyPem' },
            tool
        );
    }

    if (typeof publicKeyPem === 'string' && publicKeyPem.trim().length > 0) {
        try {
            const providedPubKey = crypto.createPublicKey(publicKeyPem.trim());
            if (providedPubKey.asymmetricKeyType !== 'ed25519') {
                return errorEnvelope(
                    'BRICK_NOT_QUALIFIED',
                    'Provided publicKeyPem must be an ed25519 public key',
                    { field: 'publicKeyPem' },
                    tool
                );
            }
            const providedKeyId = derivePublicKeyId(publicKeyPem);
            if (!constantTimeStringEqual(providedKeyId, keyId)) {
                return errorEnvelope(
                    'BRICK_NOT_QUALIFIED',
                    'Provided publicKeyPem does not match privateKeyPem',
                    { expectedKeyId: keyId, providedKeyId },
                    tool
                );
            }
        } catch (err) {
            return errorEnvelope(
                'BRICK_NOT_QUALIFIED',
                `Invalid publicKeyPem: ${err instanceof Error ? err.message : 'parse failed'}`,
                { field: 'publicKeyPem' },
                tool
            );
        }
    }

    if (!isPlainObject(verificationReport)) {
        return errorEnvelope(
            'BRICK_NOT_QUALIFIED',
            'verificationReport is required to seal a brick',
            { field: 'verificationReport' },
            tool
        );
    }

    let reportData = verificationReport;
    if (typeof verificationReport.ok === 'boolean') {
        if (verificationReport.ok !== true || !isPlainObject(verificationReport.data)) {
            return errorEnvelope(
                'BRICK_NOT_QUALIFIED',
                'Verification gate envelope did not pass',
                { field: 'verificationReport' },
                tool
            );
        }
        reportData = verificationReport.data;
    }

    if (reportData.passed === false || reportData.qualified === false) {
        return errorEnvelope(
            'BRICK_NOT_QUALIFIED',
            'Verification report explicitly marked brick as unqualified',
            { field: 'verificationReport' },
            tool
        );
    }

    const rawChecks = reportData.checks;
    if (!Array.isArray(rawChecks) || rawChecks.length < 2) {
        return errorEnvelope(
            'BRICK_NOT_QUALIFIED',
            'Verification report must contain at least 2 passed checks',
            { checkCount: Array.isArray(rawChecks) ? rawChecks.length : 0 },
            tool
        );
    }

    for (let i = 0; i < rawChecks.length; i += 1) {
        const check = rawChecks[i];
        if (
            !isPlainObject(check) ||
            typeof check.name !== 'string' ||
            check.name.trim().length === 0 ||
            typeof check.kind !== 'string' ||
            check.kind.trim().length === 0 ||
            check.passed !== true
        ) {
            return errorEnvelope(
                'BRICK_NOT_QUALIFIED',
                `Verification check at index ${i} failed or is malformed`,
                { index: i },
                tool
            );
        }
    }

    const faultChallengeCount = rawChecks.filter((c) => c.kind === 'fault').length;
    if (faultChallengeCount < 1) {
        return errorEnvelope(
            'BRICK_NOT_QUALIFIED',
            'Verification report must include at least 1 passed fault-injection challenge',
            { faultChallengeCount: 0 },
            tool
        );
    }

    const sourceHash = computeCanonicalHash(source);
    if (
        typeof reportData.sourceHash !== 'string' ||
        !HEX64_RE.test(reportData.sourceHash) ||
        !constantTimeHexEqual(sourceHash, reportData.sourceHash)
    ) {
        return errorEnvelope(
            'BRICK_NOT_QUALIFIED',
            'Source digest does not match verificationReport.sourceHash',
            { field: 'verificationReport.sourceHash' },
            tool
        );
    }

    const normalizedBlueprint = normalizeBlueprintForSeal(blueprint);
    const blueprintCanonCheck = canonicalizeAuditPayload(normalizedBlueprint, { tool });
    if (!blueprintCanonCheck.ok) {
        return errorEnvelope(
            'BRICK_NOT_QUALIFIED',
            `Blueprint cannot be deterministically canonicalized: ${blueprintCanonCheck.error.message}`,
            { field: 'blueprint' },
            tool
        );
    }

    const frozenBlueprint = deepFreezeClone(normalizedBlueprint);
    const blueprintHash = computeCanonicalHash(frozenBlueprint);
    const contractHash = computeCanonicalHash(extractContractShape(frozenBlueprint));
    const checksSummary = Object.freeze(
        rawChecks.map((c) =>
            Object.freeze({
                name: String(c.name),
                kind: String(c.kind),
                passed: Boolean(c.passed),
            })
        )
    );
    const checksHash = computeCanonicalHash(checksSummary);

    const lineage = Object.freeze({
        standard: LINEAGE_STANDARD,
        brickId: frozenBlueprint.id,
        requirementId: requirementId ? String(requirementId) : null,
        blueprintHash,
        contractHash,
        sourceHash,
        checksHash,
        faultChallengeCount,
        provenance: normalizedProvenance,
        authorId,
        orgId,
        sealedAt: createdAt,
    });

    const lineageCanon = canonicalizeAuditPayload(lineage, { tool });
    if (!lineageCanon.ok) {
        return errorEnvelope(
            'BRICK_NOT_QUALIFIED',
            `Failed to canonicalize brick lineage: ${lineageCanon.error.message}`,
            null,
            tool
        );
    }

    const payloadBuf = Buffer.from(`${SEAL_DOMAIN_PREFIX}${lineageCanon.data.canonicalJson}`, 'utf8');
    const signature = crypto.sign(null, payloadBuf, privKey).toString('hex');

    const parsedHours = Number(estimatedHoursSaved);
    const safeHoursSaved = Number.isFinite(parsedHours) ? Math.max(0, parsedHours) : 0;
    const normalizedCapabilities = Array.isArray(capabilities)
        ? Object.freeze([...new Set(capabilities.map(String))])
        : Object.freeze([]);

    const bundle = Object.freeze({
        format: SEALED_BUNDLE_FORMAT,
        brickId: frozenBlueprint.id,
        name:
            typeof frozenBlueprint.name === 'string' && frozenBlueprint.name.trim().length > 0
                ? frozenBlueprint.name
                : frozenBlueprint.id,
        summary: typeof frozenBlueprint.summary === 'string' ? frozenBlueprint.summary : '',
        brickClass: normalizedClass,
        authorId,
        orgId,
        capabilities: normalizedCapabilities,
        replacesBoilerplate: String(replacesBoilerplate || ''),
        estimatedHoursSaved: safeHoursSaved,
        blueprint: frozenBlueprint,
        source,
        checks: checksSummary,
        lineage,
        attestation: Object.freeze({
            algorithm: 'ed25519',
            domain: SEAL_ATTESTATION_DOMAIN,
            keyId,
            publicKeyPem: derivedPubPem,
            signature,
        }),
        createdAt,
    });

    return okEnvelope(
        tool,
        `Sealed brick "${frozenBlueprint.id}"@${sourceHash.slice(0, 8)}`,
        { bundle }
    );
}

/**
 * Verify a sealed brick bundle's schema invariants, canonical SHA-256 content digests,
 * optional trusted signing key pin, and Ed25519 lineage signature.
 *
 * @param {unknown} bundle - Candidate sealed brick bundle
 * @param {{ trustedPublicKeyPem?: string | null }} [options={}]
 * @returns {ReturnType<typeof okEnvelope> | ReturnType<typeof errorEnvelope>}
 */
export function verifyBrickBundle(bundle, { trustedPublicKeyPem = null } = {}) {
    const tool = 'brick-exchange.verify-seal';

    if (!isPlainObject(bundle) || bundle.format !== SEALED_BUNDLE_FORMAT) {
        return errorEnvelope(
            'INVALID_BRICK_BUNDLE',
            'Bundle must be an object with format "krusch-sealed-brick/v1"',
            null,
            tool
        );
    }

    if (typeof bundle.brickId !== 'string' || !BRICK_ID_RE.test(bundle.brickId)) {
        return errorEnvelope(
            'INVALID_BRICK_BUNDLE',
            'Bundle brickId is missing or invalid',
            { field: 'brickId' },
            tool
        );
    }

    if (!isSafeIdentifier(bundle.authorId) || !isSafeIdentifier(bundle.orgId)) {
        return errorEnvelope(
            'INVALID_BRICK_BUNDLE',
            'Bundle authorId and orgId must be valid identifiers',
            null,
            tool
        );
    }

    if (typeof bundle.brickClass !== 'string' || !isSafeIdentifier(bundle.brickClass)) {
        return errorEnvelope(
            'INVALID_BRICK_BUNDLE',
            'Bundle brickClass is missing or invalid',
            { field: 'brickClass' },
            tool
        );
    }

    if (typeof bundle.source !== 'string' || bundle.source.trim().length === 0) {
        return errorEnvelope(
            'INVALID_BRICK_BUNDLE',
            'Bundle source must be a non-empty string',
            { field: 'source' },
            tool
        );
    }

    if (!isPlainObject(bundle.blueprint) || bundle.blueprint.id !== bundle.brickId) {
        return errorEnvelope(
            'INVALID_BRICK_BUNDLE',
            'Bundle blueprint is missing or blueprint.id does not match brickId',
            { field: 'blueprint' },
            tool
        );
    }

    if (
        !Array.isArray(bundle.checks) ||
        bundle.checks.length < 2 ||
        !bundle.checks.every(
            (c) =>
                isPlainObject(c) &&
                typeof c.name === 'string' &&
                c.name.trim().length > 0 &&
                typeof c.kind === 'string' &&
                c.kind.trim().length > 0 &&
                c.passed === true
        ) ||
        !bundle.checks.some((c) => c.kind === 'fault')
    ) {
        return errorEnvelope(
            'INVALID_BRICK_BUNDLE',
            'Bundle checks must include >= 2 passed checks including at least 1 fault challenge',
            { field: 'checks' },
            tool
        );
    }

    const { lineage, attestation } = bundle;
    if (
        !isPlainObject(lineage) ||
        lineage.standard !== LINEAGE_STANDARD ||
        lineage.brickId !== bundle.brickId ||
        lineage.authorId !== bundle.authorId ||
        lineage.orgId !== bundle.orgId ||
        !HEX64_RE.test(String(lineage.sourceHash || '')) ||
        !HEX64_RE.test(String(lineage.blueprintHash || '')) ||
        !HEX64_RE.test(String(lineage.contractHash || '')) ||
        !HEX64_RE.test(String(lineage.checksHash || ''))
    ) {
        return errorEnvelope(
            'INVALID_BRICK_BUNDLE',
            'Bundle lineage metadata is missing, inconsistent, or malformed',
            { field: 'lineage' },
            tool
        );
    }

    if (
        !isPlainObject(attestation) ||
        attestation.algorithm !== 'ed25519' ||
        attestation.domain !== SEAL_ATTESTATION_DOMAIN ||
        typeof attestation.publicKeyPem !== 'string' ||
        attestation.publicKeyPem.trim().length === 0 ||
        typeof attestation.keyId !== 'string' ||
        attestation.keyId.trim().length === 0
    ) {
        return errorEnvelope(
            'INVALID_BRICK_BUNDLE',
            'Bundle attestation metadata is missing or unsupported',
            { field: 'attestation' },
            tool
        );
    }

    const actualSourceHash = computeCanonicalHash(bundle.source);
    if (!constantTimeHexEqual(actualSourceHash, lineage.sourceHash)) {
        return errorEnvelope(
            'BRICK_HASH_MISMATCH',
            'Brick source hash mismatch; bundle source was modified after sealing',
            { field: 'sourceHash' },
            tool
        );
    }

    const actualBlueprintHash = computeCanonicalHash(bundle.blueprint);
    if (!constantTimeHexEqual(actualBlueprintHash, lineage.blueprintHash)) {
        return errorEnvelope(
            'BRICK_HASH_MISMATCH',
            'Brick blueprint hash mismatch; blueprint was modified after sealing',
            { field: 'blueprintHash' },
            tool
        );
    }

    const actualContractHash = computeCanonicalHash(extractContractShape(bundle.blueprint));
    if (!constantTimeHexEqual(actualContractHash, lineage.contractHash)) {
        return errorEnvelope(
            'BRICK_HASH_MISMATCH',
            'Brick contract schema hash mismatch',
            { field: 'contractHash' },
            tool
        );
    }

    const actualChecksHash = computeCanonicalHash(bundle.checks);
    if (!constantTimeHexEqual(actualChecksHash, lineage.checksHash)) {
        return errorEnvelope(
            'BRICK_HASH_MISMATCH',
            'Brick verification checks hash mismatch',
            { field: 'checksHash' },
            tool
        );
    }

    const actualFaultCount = bundle.checks.filter((c) => c.kind === 'fault').length;
    if (lineage.faultChallengeCount !== actualFaultCount) {
        return errorEnvelope(
            'BRICK_HASH_MISMATCH',
            'Lineage faultChallengeCount does not match bundle checks',
            { field: 'faultChallengeCount' },
            tool
        );
    }

    let pubKey;
    let derivedBundleKeyId;
    try {
        pubKey = crypto.createPublicKey(attestation.publicKeyPem.trim());
        if (pubKey.asymmetricKeyType !== 'ed25519') {
            return errorEnvelope(
                'BRICK_SIGNATURE_INVALID',
                'Attestation public key is not an Ed25519 key',
                null,
                tool
            );
        }
        derivedBundleKeyId = derivePublicKeyId(attestation.publicKeyPem);
    } catch {
        return errorEnvelope(
            'BRICK_SIGNATURE_INVALID',
            'Attestation publicKeyPem could not be parsed',
            null,
            tool
        );
    }

    if (!constantTimeStringEqual(attestation.keyId, derivedBundleKeyId)) {
        return errorEnvelope(
            'BRICK_SIGNATURE_INVALID',
            'Attestation keyId does not match attestation publicKeyPem',
            { expectedKeyId: derivedBundleKeyId, actualKeyId: attestation.keyId },
            tool
        );
    }

    if (
        trustedPublicKeyPem !== null &&
        trustedPublicKeyPem !== undefined &&
        trustedPublicKeyPem !== ''
    ) {
        let trustedKeyId;
        try {
            if (typeof trustedPublicKeyPem !== 'string') {
                throw new TypeError('trustedPublicKeyPem must be a PEM string');
            }
            const trustedKeyObj = crypto.createPublicKey(trustedPublicKeyPem.trim());
            if (trustedKeyObj.asymmetricKeyType !== 'ed25519') {
                throw new TypeError('trustedPublicKeyPem must be an Ed25519 key');
            }
            trustedKeyId = derivePublicKeyId(trustedPublicKeyPem);
        } catch {
            return errorEnvelope(
                'UNTRUSTED_SIGNING_KEY',
                'Provided trustedPublicKeyPem is invalid or unsupported',
                null,
                tool
            );
        }

        if (!constantTimeStringEqual(trustedKeyId, derivedBundleKeyId)) {
            return errorEnvelope(
                'UNTRUSTED_SIGNING_KEY',
                'Bundle signing key does not match trusted public key',
                { expectedKeyId: trustedKeyId, actualKeyId: derivedBundleKeyId },
                tool
            );
        }
    }

    if (typeof attestation.signature !== 'string' || !HEX128_RE.test(attestation.signature)) {
        return errorEnvelope(
            'BRICK_SIGNATURE_INVALID',
            'Attestation signature must be a 128-character lowercase hex Ed25519 signature',
            null,
            tool
        );
    }

    const lineageCanon = canonicalizeAuditPayload(lineage, { tool });
    if (!lineageCanon.ok) {
        return errorEnvelope(
            'INVALID_BRICK_BUNDLE',
            'Bundle lineage failed canonical serialization',
            null,
            tool
        );
    }

    const payloadBuf = Buffer.from(`${SEAL_DOMAIN_PREFIX}${lineageCanon.data.canonicalJson}`, 'utf8');
    const signatureBuf = Buffer.from(attestation.signature, 'hex');

    let signatureValid = false;
    try {
        signatureValid = crypto.verify(null, payloadBuf, pubKey, signatureBuf);
    } catch {
        signatureValid = false;
    }

    if (!signatureValid) {
        return errorEnvelope(
            'BRICK_SIGNATURE_INVALID',
            'Ed25519 attestation signature verification failed',
            { brickId: bundle.brickId, keyId: derivedBundleKeyId },
            tool
        );
    }

    return okEnvelope(
        tool,
        `Verified Ed25519 seal for "${bundle.brickId}"@${lineage.sourceHash.slice(0, 8)}`,
        {
            valid: true,
            brickId: bundle.brickId,
            sourceHash: lineage.sourceHash,
            blueprintHash: lineage.blueprintHash,
            keyId: attestation.keyId,
            lineage,
        }
    );
}

/**
 * Evaluate whether `actor` in `org` is authorized to publish a verified `bundle`
 * at the requested scope (`'team'` or `'federated'`).
 *
 * @param {object} [options={}]
 * @returns {ReturnType<typeof okEnvelope> | ReturnType<typeof errorEnvelope>}
 */
export function canPublishBrick({ actor, org, bundle, scope = 'team' } = {}) {
    const tool = 'brick-exchange.policy';

    if (scope !== 'team' && scope !== 'federated') {
        return errorEnvelope(
            'PUBLISH_DENIED',
            'Publication scope must be "team" or "federated"',
            { reason: 'INVALID_SCOPE', scope },
            tool
        );
    }

    const sealCheck = verifyBrickBundle(bundle);
    if (!sealCheck.ok) {
        return errorEnvelope(
            'PUBLISH_DENIED',
            `Bundle failed cryptographic seal verification: ${sealCheck.error.message}`,
            { reason: sealCheck.error.code },
            tool
        );
    }

    if (
        !isPlainObject(actor) ||
        !isPlainObject(org) ||
        !isSafeIdentifier(actor.id) ||
        !isSafeIdentifier(org.id) ||
        actor.orgId !== org.id ||
        bundle.orgId !== org.id ||
        bundle.authorId !== actor.id
    ) {
        return errorEnvelope(
            'PUBLISH_DENIED',
            'Actor, organization, and sealed bundle authorship/orgId must match',
            { reason: 'IDENTITY_OR_ORG_MISMATCH' },
            tool
        );
    }

    if (org.participating === false) {
        return errorEnvelope(
            'PUBLISH_DENIED',
            'Organization is not participating in brick exchange',
            { reason: 'ORG_NOT_PARTICIPATING', orgId: org.id },
            tool
        );
    }

    const isPublisher =
        Boolean(actor.publisher) === true &&
        (!Array.isArray(org.publishers) || org.publishers.includes(actor.id));

    if (!isPublisher) {
        return errorEnvelope(
            'PUBLISH_DENIED',
            'Actor is not an authorized brick publisher for this organization',
            { reason: 'NOT_PUBLISHER', actorId: actor.id, orgId: org.id },
            tool
        );
    }

    const isExporter =
        isPublisher &&
        Boolean(actor.exporter) === true &&
        (!Array.isArray(org.exporters) || org.exporters.includes(actor.id));

    if (scope === 'federated' && !isExporter) {
        return errorEnvelope(
            'PUBLISH_DENIED',
            'Actor is not an authorized federated brick exporter for this organization',
            { reason: 'NOT_EXPORTER', actorId: actor.id, orgId: org.id },
            tool
        );
    }

    const effectiveRoles = [];
    if (isPublisher) {
        effectiveRoles.push('publisher');
    }
    if (isExporter) {
        effectiveRoles.push('exporter');
    }

    const requiredPermission =
        scope === 'federated' ? 'brick:publish:federated' : 'brick:publish:team';

    const rbacDecision = evaluateAccess(
        BRICK_EXCHANGE_RBAC_POLICY,
        {
            id: actor.id,
            tenantId: actor.orgId,
            roles: effectiveRoles,
            ...(Array.isArray(actor.denyPermissions)
                ? { denyPermissions: actor.denyPermissions }
                : {}),
        },
        requiredPermission,
        {
            resource: {
                tenantId: bundle.orgId,
                authorId: bundle.authorId,
            },
            requireTenantMatch: true,
            checkOwner: true,
            ownerField: 'authorId',
            tenantField: 'tenantId',
            tool,
        }
    );

    if (!rbacDecision.ok) {
        return errorEnvelope(
            'PUBLISH_DENIED',
            rbacDecision.error.message,
            { reason: rbacDecision.error.code, permission: requiredPermission },
            tool
        );
    }

    return okEnvelope(tool, `Authorized ${scope} publication for "${bundle.brickId}"`, {
        allowed: true,
        scope,
        actorId: actor.id,
        orgId: org.id,
        brickId: bundle.brickId,
        permission: requiredPermission,
    });
}

/**
 * Fail-closed recipient authorization check (`INV-LEGO-35`).
 * Must always execute before brick names, counts, suggestions, previews, or source bytes
 * are disclosed to a caller. Error envelopes intentionally omit bundle names, summaries,
 * and source code to prevent cross-tenant metadata leakage on denial.
 *
 * @param {object} [options={}]
 * @returns {ReturnType<typeof okEnvelope> | ReturnType<typeof errorEnvelope>}
 */
export function canReceiveBrick({
    recipient,
    recipientOrg,
    sourceOrg,
    preference = null,
    issuer = null,
    bundle,
    grant = null,
    nowMs = Date.now(),
} = {}) {
    const tool = 'brick-exchange.policy';

    if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) {
        return errorEnvelope(
            'INVALID_POLICY_CLOCK',
            'nowMs must be a finite epoch timestamp in milliseconds',
            null,
            tool
        );
    }

    const sealCheck = verifyBrickBundle(bundle);
    if (!sealCheck.ok) {
        return errorEnvelope(
            sealCheck.error.code,
            'Brick bundle failed cryptographic seal verification',
            { reason: sealCheck.error.code },
            tool
        );
    }

    if (
        !isPlainObject(recipient) ||
        !isPlainObject(recipientOrg) ||
        !isPlainObject(sourceOrg) ||
        !isSafeIdentifier(recipient.id) ||
        !isSafeIdentifier(recipientOrg.id) ||
        !isSafeIdentifier(sourceOrg.id) ||
        recipient.orgId !== recipientOrg.id ||
        bundle.orgId !== sourceOrg.id
    ) {
        return errorEnvelope(
            'RECIPIENT_NOT_AUTHORIZED',
            'Recipient, recipientOrg, sourceOrg, and bundle organization bindings must match',
            null,
            tool
        );
    }

    if (sourceOrg.participating === false || recipientOrg.participating === false) {
        return errorEnvelope(
            'ORG_NOT_PARTICIPATING',
            'Source or recipient organization is not participating in brick exchange',
            null,
            tool
        );
    }

    if (recipient.eligible === false) {
        return errorEnvelope(
            'RECIPIENT_NOT_AUTHORIZED',
            'Recipient is not eligible for brick exchange reception',
            null,
            tool
        );
    }

    if (Array.isArray(recipientOrg.receivers) && !recipientOrg.receivers.includes(recipient.id)) {
        return errorEnvelope(
            'RECIPIENT_NOT_AUTHORIZED',
            'Recipient is not listed in recipientOrg.receivers',
            null,
            tool
        );
    }

    if (preference !== null && preference !== undefined && !isPlainObject(preference)) {
        return errorEnvelope(
            'INVALID_PREFERENCE',
            'Recipient preference must be a plain object or null',
            null,
            tool
        );
    }

    const mode = preference?.mode ?? recipient.receiveMode ?? 'team';
    if (mode === 'off') {
        return errorEnvelope(
            'RECEIVE_MODE_OFF',
            'Recipient receive mode is set to off',
            null,
            tool
        );
    }
    if (mode !== 'team' && mode !== 'federated') {
        return errorEnvelope(
            'INVALID_RECEIVE_MODE',
            'Recipient receive mode must be "off", "team", or "federated"',
            null,
            tool
        );
    }

    const rawMuted = preference?.mutedSenders ?? recipient.mutedSenders ?? [];
    if (!Array.isArray(rawMuted)) {
        return errorEnvelope(
            'INVALID_PREFERENCE',
            'mutedSenders must be an array of sender identifiers',
            null,
            tool
        );
    }
    if (
        rawMuted.includes(bundle.authorId) ||
        (isPlainObject(issuer) && typeof issuer.id === 'string' && rawMuted.includes(issuer.id)) ||
        (isPlainObject(grant) &&
            typeof grant.issuerId === 'string' &&
            rawMuted.includes(grant.issuerId))
    ) {
        return errorEnvelope(
            'SENDER_MUTED',
            'Sender or grant issuer is muted by recipient',
            null,
            tool
        );
    }

    if (
        Array.isArray(sourceOrg.allowedClasses) &&
        sourceOrg.allowedClasses.length > 0 &&
        !sourceOrg.allowedClasses.includes(bundle.brickClass)
    ) {
        return errorEnvelope(
            'BRICK_CLASS_NOT_ALLOWED',
            'Brick class is not permitted by source organization policy',
            null,
            tool
        );
    }

    if (
        Array.isArray(recipientOrg.allowedClasses) &&
        recipientOrg.allowedClasses.length > 0 &&
        !recipientOrg.allowedClasses.includes(bundle.brickClass)
    ) {
        return errorEnvelope(
            'BRICK_CLASS_NOT_ALLOWED',
            'Brick class is not permitted by recipient organization policy',
            null,
            tool
        );
    }

    // Tier 1: Same-Org Team Commons
    if (recipient.orgId === bundle.orgId) {
        if (grant !== null && grant !== undefined) {
            if (!isPlainObject(grant)) {
                return errorEnvelope(
                    'INVALID_GRANT',
                    'Provided grant must be a plain object',
                    null,
                    tool
                );
            }
            if (Boolean(grant.revoked) === true) {
                return errorEnvelope(
                    'GRANT_REVOKED',
                    'Grant has been revoked',
                    null,
                    tool
                );
            }
            if (grant.expiresAt !== undefined && grant.expiresAt !== null) {
                const grantExpMs = Date.parse(String(grant.expiresAt));
                if (!Number.isFinite(grantExpMs) || grantExpMs <= nowMs) {
                    return errorEnvelope(
                        'GRANT_EXPIRED',
                        'Grant has expired',
                        null,
                        tool
                    );
                }
            }
        }

        const teamRbac = evaluateAccess(
            BRICK_EXCHANGE_RBAC_POLICY,
            {
                id: recipient.id,
                tenantId: recipientOrg.id,
                roles: ['member'],
                ...(Array.isArray(recipient.denyPermissions)
                    ? { denyPermissions: recipient.denyPermissions }
                    : {}),
            },
            'brick:receive:team',
            {
                resource: { tenantId: sourceOrg.id },
                requireTenantMatch: true,
                tenantField: 'tenantId',
                tool,
            }
        );

        if (!teamRbac.ok) {
            return errorEnvelope(
                'RECIPIENT_NOT_AUTHORIZED',
                teamRbac.error.message,
                null,
                tool
            );
        }

        return okEnvelope(tool, 'Same-org access authorized via workspace commons', {
            allowed: true,
            mode: 'team-commons',
            reason: 'Same-team workspace commons',
        });
    }

    // Tier 2: Cross-Org / Federated Scoped Grant (Common Ground Model)
    if (mode !== 'federated') {
        return errorEnvelope(
            'RECIPIENT_FEDERATION_DISABLED',
            'Recipient must opt into "federated" mode for cross-org bricks',
            null,
            tool
        );
    }

    const mutualPeerAllowed =
        Array.isArray(sourceOrg.peers) &&
        sourceOrg.peers.includes(recipientOrg.id) &&
        Array.isArray(recipientOrg.peers) &&
        recipientOrg.peers.includes(sourceOrg.id);

    if (!mutualPeerAllowed) {
        return errorEnvelope(
            'ORG_PEER_NOT_ALLOWLISTED',
            'Mutual peer allowlisting between sourceOrg and recipientOrg is required',
            null,
            tool
        );
    }

    if (!isPlainObject(grant)) {
        return errorEnvelope(
            'MISSING_FEDERATED_GRANT',
            'Cross-org brick reception requires an explicit federated grant',
            null,
            tool
        );
    }

    if (grant.revoked === true || Boolean(grant.revoked) === true) {
        return errorEnvelope(
            'GRANT_REVOKED',
            'Federated grant has been revoked',
            null,
            tool
        );
    }

    const expiresMs =
        typeof grant.expiresAt === 'string' || typeof grant.expiresAt === 'number'
            ? Date.parse(String(grant.expiresAt))
            : Number.NaN;
    if (!Number.isFinite(expiresMs) || expiresMs <= nowMs) {
        return errorEnvelope(
            'GRANT_EXPIRED',
            'Federated grant has expired or lacks a valid expiresAt timestamp',
            null,
            tool
        );
    }

    if (grant.scope !== 'federated') {
        return errorEnvelope(
            'INVALID_GRANT_SCOPE',
            'Federated grant must specify scope === "federated"',
            null,
            tool
        );
    }

    if (grant.reshare !== false) {
        return errorEnvelope(
            'RESHARE_FORBIDDEN',
            'Federated grant must enforce reshare === false',
            null,
            tool
        );
    }

    if (
        grant.brickId !== bundle.brickId ||
        typeof grant.sourceHash !== 'string' ||
        !constantTimeHexEqual(grant.sourceHash, bundle.lineage.sourceHash)
    ) {
        return errorEnvelope(
            'GRANT_TARGET_MISMATCH',
            'Federated grant does not match sealed bundle brickId and sourceHash',
            null,
            tool
        );
    }

    if (
        grant.recipientOrgId !== undefined &&
        grant.recipientOrgId !== null &&
        grant.recipientOrgId !== recipientOrg.id
    ) {
        return errorEnvelope(
            'GRANT_RECIPIENT_MISMATCH',
            'Federated grant recipientOrgId does not match recipientOrg.id',
            null,
            tool
        );
    }

    if (!Array.isArray(grant.recipients) || !grant.recipients.includes(recipient.id)) {
        return errorEnvelope(
            'GRANT_RECIPIENT_MISMATCH',
            'Recipient is not explicitly authorized on grant.recipients',
            null,
            tool
        );
    }

    if (
        !isPlainObject(issuer) ||
        !isSafeIdentifier(issuer.id) ||
        typeof grant.issuerId !== 'string' ||
        grant.issuerId !== issuer.id
    ) {
        return errorEnvelope(
            'INVALID_GRANT_ISSUER',
            'Federated grant requires a valid issuer matching grant.issuerId',
            null,
            tool
        );
    }

    const issuerExportCheck = canPublishBrick({
        actor: issuer,
        org: sourceOrg,
        bundle,
        scope: 'federated',
    });
    if (!issuerExportCheck.ok) {
        return errorEnvelope(
            'ISSUER_EXPORT_REVOKED',
            'Grant issuer is no longer an active authorized federated exporter for sourceOrg',
            { reason: issuerExportCheck.error.code },
            tool
        );
    }

    const federatedRbac = evaluateAccess(
        BRICK_EXCHANGE_RBAC_POLICY,
        {
            id: recipient.id,
            tenantId: recipientOrg.id,
            roles: ['federated_receiver'],
            allowCrossTenant: true,
            ...(Array.isArray(recipient.denyPermissions)
                ? { denyPermissions: recipient.denyPermissions }
                : {}),
        },
        'brick:receive:federated',
        {
            resource: { tenantId: sourceOrg.id },
            requireTenantMatch: true,
            tenantField: 'tenantId',
            tool,
        }
    );

    if (!federatedRbac.ok) {
        return errorEnvelope(
            'RECIPIENT_NOT_AUTHORIZED',
            federatedRbac.error.message,
            null,
            tool
        );
    }

    return okEnvelope(tool, 'Cross-org access authorized by active grant', {
        allowed: true,
        mode: 'scoped-grant',
        grantId: grant.id ?? null,
        reason: 'Authorized federated grant',
    });
}
