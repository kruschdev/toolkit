/**
 * @module rbac
 * @description Deny-by-default Role-Based Access Control (RBAC) policy compiler,
 * deterministic ReDoS-free permission matcher, OWASP A01 multi-tenant IDOR guard,
 * and async-safe HTTP/Express authorization middleware (`INV-LEGO-33`, `INV-LEGO-01`).
 * Pure Web-standards ECMAScript with zero host-specific imports; runs unmodified across
 * Node 22, Cloudflare Workers, Deno, Bun, and modern browsers.
 */

const RBAC_POLICY_BRAND = Symbol.for('krusch.toolkit.rbac.policy');
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_PERMISSION_LENGTH = 512;
const MAX_ROLE_NAME_LENGTH = 128;
const MAX_ALLOWED_INHERITANCE_DEPTH = 256;

const hasOwn =
    typeof Object.hasOwn === 'function'
        ? Object.hasOwn
        : (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

const UTF8_ENCODER = new TextEncoder();

/**
 * Build a deterministic `INV-LEGO-01` success envelope without host-specific imports.
 *
 * @param {string} tool - Originating tool or subsystem identifier
 * @param {string} summary - Concise human-readable status summary
 * @param {object} [data={}] - Structured payload
 * @returns {{ ok: true, tool: string, summary: string, data: object }}
 */
function okEnvelope(tool, summary, data = {}) {
    return {
        ok: true,
        tool: String(tool || 'rbac'),
        summary: String(summary || 'OK'),
        data: data ?? {},
    };
}

/**
 * Build a deterministic `INV-LEGO-01` error envelope without host-specific imports.
 *
 * @param {string} code - Machine-readable error code
 * @param {string} message - Human-readable error message
 * @param {unknown} [details=null] - Optional diagnostic metadata
 * @param {string} [tool='rbac'] - Originating tool or subsystem identifier
 * @returns {{ ok: false, tool: string, summary: string, error: { code: string, message: string, details?: unknown } }}
 */
function errorEnvelope(code, message, details = null, tool = 'rbac') {
    return {
        ok: false,
        tool: String(tool || 'rbac'),
        summary: String(message || code || 'Access denied'),
        error: {
            code: String(code || 'RBAC_ERROR'),
            message: String(message || 'Access denied'),
            ...(details !== null && details !== undefined ? { details } : {}),
        },
    };
}

/**
 * Check whether a string contains ASCII control characters (`0x00..0x1F`, `0x7F`).
 *
 * @param {string} value - Candidate string
 * @returns {boolean}
 */
function hasAsciiControlChars(value) {
    for (let i = 0; i < value.length; i += 1) {
        const code = value.charCodeAt(i);
        if (code <= 0x1f || code === 0x7f) {
            return true;
        }
    }
    return false;
}

/**
 * Check whether a string contains any whitespace or ASCII control characters.
 *
 * @param {string} value - Candidate token
 * @returns {boolean}
 */
function hasControlOrWhitespace(value) {
    for (let i = 0; i < value.length; i += 1) {
        const code = value.charCodeAt(i);
        if (code <= 0x20 || code === 0x7f) {
            return true;
        }
    }
    return /\s/.test(value);
}

/**
 * Validate a concrete required permission identifier (`'billing:read'`, `'admin'`).
 * Rejects wildcards (`'*'`), empty segments (`'billing:'`, `':read'`), whitespace, and control chars.
 *
 * @param {unknown} permission - Candidate permission string
 * @returns {permission is string}
 */
function isValidPermissionName(permission) {
    if (
        typeof permission !== 'string' ||
        permission.length === 0 ||
        permission.length > MAX_PERMISSION_LENGTH
    ) {
        return false;
    }
    if (permission.includes('*') || hasControlOrWhitespace(permission)) {
        return false;
    }
    const segments = permission.split(':');
    for (let i = 0; i < segments.length; i += 1) {
        if (segments[i].length === 0) {
            return false;
        }
    }
    return true;
}

/**
 * Validate a granted/denied permission pattern (`'*'`, `'domain:**'`, `'billing:*'`, `'*:read'`, `'billing:read'`).
 * Rejects empty segments, intra-segment partial globs (`'bill*'`), standalone `'**'`, mid-path `'**'`,
 * whitespace, and ASCII control characters.
 *
 * @param {unknown} pattern - Candidate permission pattern
 * @returns {pattern is string}
 */
function isValidPermissionPattern(pattern) {
    if (
        typeof pattern !== 'string' ||
        pattern.length === 0 ||
        pattern.length > MAX_PERMISSION_LENGTH
    ) {
        return false;
    }
    if (hasControlOrWhitespace(pattern)) {
        return false;
    }
    if (pattern === '*') {
        return true;
    }
    const segments = pattern.split(':');
    for (let i = 0; i < segments.length; i += 1) {
        const seg = segments[i];
        if (seg.length === 0) {
            return false;
        }
        if (seg.includes('*')) {
            if (seg === '*') {
                continue;
            }
            if (seg === '**' && segments.length >= 2 && i === segments.length - 1) {
                continue;
            }
            return false;
        }
    }
    return true;
}

/**
 * Validate a non-empty plain object (rejecting `null` and arrays).
 *
 * @param {unknown} value - Candidate value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObjectLike(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Extract a clean own string tenant identifier using `Object.hasOwn`.
 *
 * @param {Record<string, unknown>} target - Subject or resource object
 * @param {string} field - Own property name
 * @returns {string | null}
 */
function extractOwnTenantId(target, field) {
    if (!hasOwn(target, field)) {
        return null;
    }
    const raw = target[field];
    if (typeof raw !== 'string' || hasAsciiControlChars(raw)) {
        return null;
    }
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
}

/**
 * Extract a clean own scalar owner identifier (`string` or finite `number`) using `Object.hasOwn`.
 * Rejects objects, booleans, `NaN`/`Infinity`, and prototype-inherited properties.
 *
 * @param {Record<string, unknown>} target - Subject or resource object
 * @param {string} field - Own property name
 * @returns {string | null}
 */
function extractOwnOwnerId(target, field) {
    if (!hasOwn(target, field)) {
        return null;
    }
    const raw = target[field];
    let str;
    if (typeof raw === 'string') {
        str = raw;
    } else if (typeof raw === 'number' && Number.isFinite(raw)) {
        str = String(raw);
    } else {
        return null;
    }
    if (hasAsciiControlChars(str)) {
        return null;
    }
    const trimmed = str.trim();
    return trimmed.length > 0 ? trimmed : null;
}

/**
 * Verify strict resource ownership (`subject.id` vs `resource[ownerField]`).
 *
 * @param {Record<string, unknown>} subject - Authenticated subject
 * @param {Record<string, unknown>} resource - Target resource
 * @param {string} ownerField - Resource owner field name
 * @param {string} tool - Envelope tool identifier
 * @returns {{ ok: true, ownerId: string } | { ok: false, envelope: ReturnType<typeof errorEnvelope> }}
 */
function checkStrictResourceOwner(subject, resource, ownerField, tool) {
    if (
        typeof ownerField !== 'string' ||
        ownerField.trim().length === 0 ||
        hasAsciiControlChars(ownerField) ||
        FORBIDDEN_KEYS.has(ownerField)
    ) {
        return {
            ok: false,
            envelope: errorEnvelope(
                'RBAC_INVALID_OPTIONS',
                'Invalid ownerField configuration',
                { statusCode: 400 },
                tool
            ),
        };
    }

    const subjectOwnerId = extractOwnOwnerId(subject, 'id');
    const resourceOwnerId = extractOwnOwnerId(resource, ownerField);

    if (subjectOwnerId === null || resourceOwnerId === null || subjectOwnerId !== resourceOwnerId) {
        return {
            ok: false,
            envelope: errorEnvelope(
                'RBAC_NOT_RESOURCE_OWNER',
                'Subject does not own target resource',
                { ownerField, statusCode: 403 },
                tool
            ),
        };
    }

    return { ok: true, ownerId: subjectOwnerId };
}

/**
 * Check whether an object is a valid `RbacPolicy` handle.
 *
 * @param {unknown} policy - Candidate policy handle
 * @returns {boolean}
 */
function isValidRbacPolicy(policy) {
    if (!isPlainObjectLike(policy)) {
        return false;
    }
    if (policy[RBAC_POLICY_BRAND] === true) {
        return true;
    }
    return (
        typeof policy.getRolePermissions === 'function' &&
        typeof policy.listRoles === 'function' &&
        typeof policy.evaluate === 'function'
    );
}

/**
 * Write a JSON response across Express (`res.status().json()`), raw `http.ServerResponse`, and mocks.
 *
 * @param {any} res - HTTP response object
 * @param {number} statusCode - HTTP status code
 * @param {object} payload - Serializable JSON envelope
 */
function sendGuardJsonResponse(res, statusCode, payload) {
    if (!res || typeof res !== 'object') {
        return;
    }
    if (res.writableEnded || res.destroyed) {
        return;
    }

    if (typeof res.status === 'function' && typeof res.json === 'function') {
        try {
            res.statusCode = statusCode;
        } catch {
            // Ignore read-only statusCode getter on custom mocks
        }
        try {
            if (typeof res.setHeader === 'function' && !res.headersSent) {
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
            }
        } catch {
            // Ignore header errors on lightweight mocks
        }
        const chained = res.status(statusCode);
        if (chained && typeof chained.json === 'function') {
            chained.json(payload);
        } else {
            res.json(payload);
        }
        return;
    }

    const serialized = JSON.stringify(payload);
    const byteLength = String(UTF8_ENCODER.encode(serialized).byteLength);

    if (typeof res.setHeader === 'function' && typeof res.end === 'function') {
        res.statusCode = statusCode;
        if (!res.headersSent) {
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.setHeader('Content-Length', byteLength);
        }
        res.end(serialized);
        return;
    }

    if (typeof res.writeHead === 'function' && typeof res.end === 'function') {
        if (!res.headersSent) {
            res.writeHead(statusCode, {
                'Content-Type': 'application/json; charset=utf-8',
                'Content-Length': byteLength,
            });
        }
        res.end(serialized);
        return;
    }

    try {
        res.statusCode = statusCode;
    } catch {
        // Ignore frozen mock object
    }
}

/**
 * Deterministic, linear-time ($O(N)$), ReDoS-free permission pattern matcher.
 *
 * Supports:
 * - Exact match (`'billing:read'` -> `'billing:read'`)
 * - Global wildcard (`'*'` -> any valid concrete permission)
 * - Subtree prefix wildcard (`'domain:**'` -> `'domain:read'`, `'domain:invoices:write'`)
 * - Equal-length segment wildcards (`'billing:*'`, `'*:read'`)
 *
 * @param {string} grantedPattern - Granted or denied permission pattern
 * @param {string} requiredPermission - Concrete permission identifier being requested
 * @returns {boolean}
 */
export function matchPermissionPattern(grantedPattern, requiredPermission) {
    if (!isValidPermissionPattern(grantedPattern) || !isValidPermissionName(requiredPermission)) {
        return false;
    }
    if (grantedPattern === '*') {
        return true;
    }
    if (grantedPattern === requiredPermission) {
        return true;
    }

    const grantSegments = grantedPattern.split(':');
    const reqSegments = requiredPermission.split(':');

    if (grantSegments[grantSegments.length - 1] === '**') {
        const prefixLength = grantSegments.length - 1;
        if (reqSegments.length <= prefixLength) {
            return false;
        }
        for (let i = 0; i < prefixLength; i += 1) {
            const grantSeg = grantSegments[i];
            if (grantSeg !== '*' && grantSeg !== reqSegments[i]) {
                return false;
            }
        }
        return true;
    }

    if (grantSegments.length !== reqSegments.length) {
        return false;
    }
    for (let i = 0; i < grantSegments.length; i += 1) {
        const grantSeg = grantSegments[i];
        if (grantSeg !== '*' && grantSeg !== reqSegments[i]) {
            return false;
        }
    }
    return true;
}

/**
 * Compile and validate an immutable, prototype-safe RBAC policy graph.
 *
 * Rejects `__proto__`/`constructor`/`prototype` keys, invalid permission patterns,
 * unknown `inherits` targets, role inheritance cycles, and inheritance depth overflow.
 *
 * @param {object} [policyDefinition={}] - Static RBAC policy specification (`{ roles }`)
 * @param {object} [options={}] - Compiler bounds
 * @param {number} [options.maxInheritanceDepth=16] - Maximum allowed role inheritance depth
 * @returns {{
 *   listRoles: () => string[],
 *   getRolePermissions: (roleName: string) => {
 *     allow: readonly string[],
 *     deny: readonly string[],
 *     allowCrossTenant: boolean,
 *     inherits: readonly string[],
 *     description: string
 *   } | null,
 *   evaluate: (subject: unknown, permission: string, options?: object) => ReturnType<typeof okEnvelope> | ReturnType<typeof errorEnvelope>
 * }}
 */
export function createRbacPolicy(policyDefinition = {}, options = {}) {
    if (!isPlainObjectLike(policyDefinition)) {
        throw new TypeError('policyDefinition must be a plain object');
    }
    if (!isPlainObjectLike(options)) {
        throw new TypeError('createRbacPolicy options must be a plain object');
    }

    const { maxInheritanceDepth = 16 } = options;
    if (
        !Number.isInteger(maxInheritanceDepth) ||
        maxInheritanceDepth < 0 ||
        maxInheritanceDepth > MAX_ALLOWED_INHERITANCE_DEPTH
    ) {
        throw new RangeError(
            `maxInheritanceDepth must be an integer between 0 and ${MAX_ALLOWED_INHERITANCE_DEPTH}`
        );
    }

    for (const topKey of Object.getOwnPropertyNames(policyDefinition)) {
        if (FORBIDDEN_KEYS.has(topKey)) {
            throw new RangeError(`Forbidden property "${topKey}" in policyDefinition`);
        }
    }

    const rawRoles =
        hasOwn(policyDefinition, 'roles') && policyDefinition.roles !== undefined
            ? policyDefinition.roles
            : {};
    if (!isPlainObjectLike(rawRoles)) {
        throw new TypeError('policyDefinition.roles must be a plain object');
    }

    /** @type {Map<string, { allow: string[], deny: string[], inherits: string[], allowCrossTenant: boolean, description: string }>} */
    const rawRoleMap = new Map();

    for (const roleName of Object.getOwnPropertyNames(rawRoles)) {
        if (FORBIDDEN_KEYS.has(roleName)) {
            throw new RangeError(`Forbidden role name "${roleName}"`);
        }
        if (
            roleName.length === 0 ||
            roleName.length > MAX_ROLE_NAME_LENGTH ||
            roleName !== roleName.trim() ||
            hasControlOrWhitespace(roleName)
        ) {
            throw new RangeError(`Invalid role name "${roleName}"`);
        }

        const roleDef = rawRoles[roleName];
        if (!isPlainObjectLike(roleDef)) {
            throw new TypeError(`Role definition for "${roleName}" must be a plain object`);
        }

        for (const propName of Object.getOwnPropertyNames(roleDef)) {
            if (FORBIDDEN_KEYS.has(propName)) {
                throw new RangeError(`Forbidden property "${propName}" in role "${roleName}"`);
            }
        }

        const rawAllow = hasOwn(roleDef, 'allow') && roleDef.allow !== undefined ? roleDef.allow : [];
        if (!Array.isArray(rawAllow)) {
            throw new TypeError(`Role "${roleName}".allow must be an array of permission patterns`);
        }
        const allow = [];
        for (let i = 0; i < rawAllow.length; i += 1) {
            const pattern = rawAllow[i];
            if (!isValidPermissionPattern(pattern)) {
                throw new RangeError(
                    `Invalid allow permission pattern "${String(pattern)}" in role "${roleName}"`
                );
            }
            allow.push(pattern);
        }

        const rawDeny = hasOwn(roleDef, 'deny') && roleDef.deny !== undefined ? roleDef.deny : [];
        if (!Array.isArray(rawDeny)) {
            throw new TypeError(`Role "${roleName}".deny must be an array of permission patterns`);
        }
        const deny = [];
        for (let i = 0; i < rawDeny.length; i += 1) {
            const pattern = rawDeny[i];
            if (!isValidPermissionPattern(pattern)) {
                throw new RangeError(
                    `Invalid deny permission pattern "${String(pattern)}" in role "${roleName}"`
                );
            }
            deny.push(pattern);
        }

        const rawInherits =
            hasOwn(roleDef, 'inherits') && roleDef.inherits !== undefined ? roleDef.inherits : [];
        if (!Array.isArray(rawInherits)) {
            throw new TypeError(`Role "${roleName}".inherits must be an array of role names`);
        }
        const inherits = [];
        const seenParents = new Set();
        for (let i = 0; i < rawInherits.length; i += 1) {
            const parentRole = rawInherits[i];
            if (typeof parentRole !== 'string' || parentRole.trim().length === 0) {
                throw new RangeError(
                    `Invalid parent role reference "${String(parentRole)}" in role "${roleName}"`
                );
            }
            if (FORBIDDEN_KEYS.has(parentRole)) {
                throw new RangeError(
                    `Forbidden parent role reference "${parentRole}" in role "${roleName}"`
                );
            }
            if (!seenParents.has(parentRole)) {
                seenParents.add(parentRole);
                inherits.push(parentRole);
            }
        }

        const rawCrossTenant =
            hasOwn(roleDef, 'allowCrossTenant') && roleDef.allowCrossTenant !== undefined
                ? roleDef.allowCrossTenant
                : false;
        if (typeof rawCrossTenant !== 'boolean') {
            throw new TypeError(`Role "${roleName}".allowCrossTenant must be a boolean`);
        }

        const rawDescription =
            hasOwn(roleDef, 'description') && roleDef.description !== undefined
                ? roleDef.description
                : '';
        if (typeof rawDescription !== 'string') {
            throw new TypeError(`Role "${roleName}".description must be a string`);
        }

        rawRoleMap.set(roleName, {
            allow,
            deny,
            inherits,
            allowCrossTenant: rawCrossTenant,
            description: rawDescription,
        });
    }

    for (const [roleName, roleSpec] of rawRoleMap.entries()) {
        for (let i = 0; i < roleSpec.inherits.length; i += 1) {
            const parentName = roleSpec.inherits[i];
            if (!rawRoleMap.has(parentName)) {
                throw new RangeError(
                    `Role "${roleName}" inherits from unknown role "${parentName}"`
                );
            }
        }
    }

    /** @type {Map<string, number>} 0 = unvisited, 1 = visiting, 2 = compiled */
    const visitState = new Map();
    /** @type {Map<string, number>} */
    const roleDepthMap = new Map();
    /** @type {Map<string, { allow: readonly string[], deny: readonly string[], allowCrossTenant: boolean, inherits: readonly string[], description: string }>} */
    const compiledRoles = new Map();

    function compileRole(roleName, trail) {
        const state = visitState.get(roleName) || 0;
        if (state === 2) {
            return compiledRoles.get(roleName);
        }
        if (state === 1) {
            throw new RangeError(
                `Role inheritance cycle detected: ${[...trail, roleName].join(' -> ')}`
            );
        }

        visitState.set(roleName, 1);
        const spec = rawRoleMap.get(roleName);
        const allowSet = new Set(spec.allow);
        const denySet = new Set(spec.deny);
        let allowCrossTenant = spec.allowCrossTenant;
        let maxParentDepth = 0;

        for (let i = 0; i < spec.inherits.length; i += 1) {
            const parentName = spec.inherits[i];
            const compiledParent = compileRole(parentName, [...trail, roleName]);
            const candidateDepth = (roleDepthMap.get(parentName) || 0) + 1;
            if (candidateDepth > maxInheritanceDepth) {
                throw new RangeError(
                    `Role inheritance depth for "${roleName}" (${candidateDepth}) exceeds maxInheritanceDepth (${maxInheritanceDepth})`
                );
            }
            if (candidateDepth > maxParentDepth) {
                maxParentDepth = candidateDepth;
            }
            for (let j = 0; j < compiledParent.allow.length; j += 1) {
                allowSet.add(compiledParent.allow[j]);
            }
            for (let j = 0; j < compiledParent.deny.length; j += 1) {
                denySet.add(compiledParent.deny[j]);
            }
            if (compiledParent.allowCrossTenant) {
                allowCrossTenant = true;
            }
        }

        roleDepthMap.set(roleName, maxParentDepth);
        const compiled = Object.freeze({
            allow: Object.freeze([...allowSet]),
            deny: Object.freeze([...denySet]),
            allowCrossTenant,
            inherits: Object.freeze([...spec.inherits]),
            description: spec.description,
        });
        compiledRoles.set(roleName, compiled);
        visitState.set(roleName, 2);
        return compiled;
    }

    for (const roleName of rawRoleMap.keys()) {
        compileRole(roleName, []);
    }

    const orderedRoleNames = Object.freeze([...compiledRoles.keys()]);

    const policy = {
        listRoles() {
            return [...orderedRoleNames];
        },
        getRolePermissions(roleName) {
            if (typeof roleName !== 'string' || FORBIDDEN_KEYS.has(roleName)) {
                return null;
            }
            return compiledRoles.get(roleName) ?? null;
        },
        evaluate(subject, permission, evalOptions = {}) {
            return evaluateAccess(policy, subject, permission, evalOptions);
        },
    };

    Object.defineProperty(policy, RBAC_POLICY_BRAND, {
        value: true,
        enumerable: false,
        writable: false,
        configurable: false,
    });

    return Object.freeze(policy);
}

/**
 * Non-throwing OWASP A01 / IDOR multi-tenant & resource ownership guard.
 *
 * Uses `Object.hasOwn` exclusively so prototype-polluted `Object.prototype.tenantId`
 * or `Object.prototype.ownerId` properties can never bypass isolation boundaries.
 *
 * @param {unknown} subject - Authenticated caller subject
 * @param {unknown} resource - Target domain resource
 * @param {object} [options={}] - Verification options
 * @param {boolean} [options.allowCrossTenant=false] - Policy-side half of dual-key cross-tenant bypass
 * @param {boolean} [options.checkOwner=false] - Require `subject.id` to match `resource[ownerField]`
 * @param {string} [options.ownerField='ownerId'] - Own property on `resource` storing owner ID
 * @param {string} [options.tenantField='tenantId'] - Own property on `resource` storing tenant ID
 * @param {string} [options.tool='rbac.tenant'] - `INV-LEGO-01` tool identifier
 * @returns {ReturnType<typeof okEnvelope> | ReturnType<typeof errorEnvelope>}
 */
export function assertTenantOwnership(subject, resource, options = {}) {
    const safeOptions = isPlainObjectLike(options) ? options : {};
    const {
        allowCrossTenant = false,
        checkOwner = false,
        ownerField = 'ownerId',
        tenantField = 'tenantId',
        tool = 'rbac.tenant',
    } = safeOptions;

    if (!isPlainObjectLike(subject)) {
        return errorEnvelope(
            'RBAC_UNAUTHENTICATED',
            'Authentication required',
            { statusCode: 401 },
            tool
        );
    }

    if (!isPlainObjectLike(resource)) {
        return errorEnvelope(
            'RBAC_INVALID_RESOURCE',
            'Target resource must be a non-null object',
            { statusCode: 400 },
            tool
        );
    }

    if (
        typeof tenantField !== 'string' ||
        tenantField.trim().length === 0 ||
        hasAsciiControlChars(tenantField) ||
        FORBIDDEN_KEYS.has(tenantField)
    ) {
        return errorEnvelope(
            'RBAC_INVALID_OPTIONS',
            'Invalid tenantField configuration',
            { statusCode: 400 },
            tool
        );
    }

    const crossTenantBypass =
        allowCrossTenant === true &&
        hasOwn(subject, 'allowCrossTenant') &&
        subject.allowCrossTenant === true;

    const subjectTenantId = extractOwnTenantId(subject, 'tenantId');
    const resourceTenantId = extractOwnTenantId(resource, tenantField);

    if (!crossTenantBypass) {
        if (subjectTenantId === null) {
            return errorEnvelope(
                'RBAC_MISSING_SUBJECT_TENANT',
                'Authenticated subject is missing a valid tenantId',
                { statusCode: 403 },
                tool
            );
        }
        if (resourceTenantId === null) {
            return errorEnvelope(
                'RBAC_MISSING_RESOURCE_TENANT',
                `Target resource is missing a valid ${tenantField}`,
                { tenantField, statusCode: 403 },
                tool
            );
        }
        if (subjectTenantId !== resourceTenantId) {
            return errorEnvelope(
                'RBAC_CROSS_TENANT_DENIED',
                'Cross-tenant resource access denied',
                { tenantField, statusCode: 403 },
                tool
            );
        }
    }

    let verifiedOwnerId = null;
    if (checkOwner === true) {
        const ownerCheck = checkStrictResourceOwner(subject, resource, ownerField, tool);
        if (!ownerCheck.ok) {
            return ownerCheck.envelope;
        }
        verifiedOwnerId = ownerCheck.ownerId;
    }

    return okEnvelope(tool, 'Tenant ownership verified', {
        allowed: true,
        tenantId: subjectTenantId,
        resourceTenantId,
        crossTenant: crossTenantBypass,
        ownerChecked: checkOwner === true,
        ...(checkOwner === true ? { ownerId: verifiedOwnerId } : {}),
    });
}

/**
 * Deny-by-default RBAC policy & multi-tenant resource access evaluator.
 *
 * Evaluation order:
 * 1. Validate `policy` (`500 RBAC_INVALID_POLICY`), `subject` (`401 RBAC_UNAUTHENTICATED`),
 *    and concrete `permission` (`400 RBAC_INVALID_PERMISSION`).
 * 2. Evaluate all explicit `deny` patterns across `subject.denyPermissions` and assigned roles
 *    (`403 RBAC_EXPLICIT_DENY` — explicit deny always overrides allow).
 * 3. Require at least one matching `allow` pattern across assigned roles or `subject.permissions`
 *    (`403 RBAC_FORBIDDEN`).
 * 4. Enforce `assertTenantOwnership` whenever `resource` is provided and `requireTenantMatch !== false`
 *    (plus strict `checkOwner` verification whenever `checkOwner === true`).
 *
 * @param {ReturnType<typeof createRbacPolicy>} policy - Compiled RBAC policy handle
 * @param {unknown} subject - Authenticated subject (`{ id?, tenantId?, role?, roles?, permissions?, denyPermissions?, allowCrossTenant? }`)
 * @param {string} permission - Required concrete permission identifier
 * @param {object} [options={}] - Resource & tenant check options
 * @param {unknown} [options.resource=null] - Optional target resource for IDOR/tenant verification
 * @param {boolean} [options.requireTenantMatch=true] - Enforce tenant isolation when `resource` is provided
 * @param {boolean} [options.checkOwner=false] - Enforce `subject.id === resource[ownerField]`
 * @param {string} [options.ownerField='ownerId'] - Resource owner property name
 * @param {string} [options.tenantField='tenantId'] - Resource tenant property name
 * @param {string} [options.tool='rbac.evaluate'] - `INV-LEGO-01` tool identifier
 * @returns {ReturnType<typeof okEnvelope> | ReturnType<typeof errorEnvelope>}
 */
export function evaluateAccess(policy, subject, permission, options = {}) {
    const safeOptions = isPlainObjectLike(options) ? options : {};
    const {
        resource = null,
        requireTenantMatch = true,
        checkOwner = false,
        ownerField = 'ownerId',
        tenantField = 'tenantId',
        tool = 'rbac.evaluate',
    } = safeOptions;

    if (!isValidRbacPolicy(policy)) {
        return errorEnvelope(
            'RBAC_INVALID_POLICY',
            'Invalid or uninitialized RBAC policy',
            { statusCode: 500 },
            tool
        );
    }

    if (!isPlainObjectLike(subject)) {
        return errorEnvelope(
            'RBAC_UNAUTHENTICATED',
            'Authentication required',
            { statusCode: 401 },
            tool
        );
    }

    if (!isValidPermissionName(permission)) {
        return errorEnvelope(
            'RBAC_INVALID_PERMISSION',
            'Invalid required permission identifier',
            { permission: typeof permission === 'string' ? permission : null, statusCode: 400 },
            tool
        );
    }

    const resolvedRoles = [];
    const seenRoleNames = new Set();

    const pushCandidateRole = (candidate) => {
        if (typeof candidate !== 'string' || candidate.length === 0 || FORBIDDEN_KEYS.has(candidate)) {
            return;
        }
        if (seenRoleNames.has(candidate)) {
            return;
        }
        seenRoleNames.add(candidate);
        const compiled = policy.getRolePermissions(candidate);
        if (compiled && isPlainObjectLike(compiled)) {
            resolvedRoles.push(compiled);
        }
    };

    if (hasOwn(subject, 'roles') && Array.isArray(subject.roles)) {
        for (let i = 0; i < subject.roles.length; i += 1) {
            pushCandidateRole(subject.roles[i]);
        }
    }
    if (hasOwn(subject, 'role') && typeof subject.role === 'string') {
        pushCandidateRole(subject.role);
    }

    const directAllow = [];
    if (hasOwn(subject, 'permissions') && Array.isArray(subject.permissions)) {
        for (let i = 0; i < subject.permissions.length; i += 1) {
            const pat = subject.permissions[i];
            if (isValidPermissionPattern(pat)) {
                directAllow.push(pat);
            }
        }
    }

    const directDeny = [];
    if (hasOwn(subject, 'denyPermissions') && Array.isArray(subject.denyPermissions)) {
        for (let i = 0; i < subject.denyPermissions.length; i += 1) {
            const pat = subject.denyPermissions[i];
            if (isValidPermissionPattern(pat)) {
                directDeny.push(pat);
            }
        }
    }

    // 1. Explicit deny rules ALWAYS override allow rules
    for (let i = 0; i < directDeny.length; i += 1) {
        if (matchPermissionPattern(directDeny[i], permission)) {
            return errorEnvelope(
                'RBAC_EXPLICIT_DENY',
                `Permission "${permission}" is explicitly denied`,
                { permission, matchedDeny: directDeny[i], statusCode: 403 },
                tool
            );
        }
    }

    for (let r = 0; r < resolvedRoles.length; r += 1) {
        const roleDeny = Array.isArray(resolvedRoles[r].deny) ? resolvedRoles[r].deny : [];
        for (let i = 0; i < roleDeny.length; i += 1) {
            if (matchPermissionPattern(roleDeny[i], permission)) {
                return errorEnvelope(
                    'RBAC_EXPLICIT_DENY',
                    `Permission "${permission}" is explicitly denied`,
                    { permission, matchedDeny: roleDeny[i], statusCode: 403 },
                    tool
                );
            }
        }
    }

    // 2. Require at least one matching allow rule; track cross-tenant privilege only from roles granting this permission
    let matchedGrant = null;
    let roleAllowsCrossTenant = false;

    for (let r = 0; r < resolvedRoles.length; r += 1) {
        const roleEntry = resolvedRoles[r];
        const roleAllow = Array.isArray(roleEntry.allow) ? roleEntry.allow : [];
        for (let i = 0; i < roleAllow.length; i += 1) {
            if (matchPermissionPattern(roleAllow[i], permission)) {
                if (matchedGrant === null) {
                    matchedGrant = roleAllow[i];
                }
                if (roleEntry.allowCrossTenant === true) {
                    roleAllowsCrossTenant = true;
                }
                break;
            }
        }
    }

    if (matchedGrant === null) {
        for (let i = 0; i < directAllow.length; i += 1) {
            if (matchPermissionPattern(directAllow[i], permission)) {
                matchedGrant = directAllow[i];
                break;
            }
        }
    }

    if (matchedGrant === null) {
        return errorEnvelope(
            'RBAC_FORBIDDEN',
            `Missing required permission "${permission}"`,
            { permission, statusCode: 403 },
            tool
        );
    }

    // 3. Enforce multi-tenant IDOR & resource ownership checks
    if (resource !== null && resource !== undefined && requireTenantMatch !== false) {
        const tenantCheck = assertTenantOwnership(subject, resource, {
            allowCrossTenant:
                roleAllowsCrossTenant &&
                hasOwn(subject, 'allowCrossTenant') &&
                subject.allowCrossTenant === true,
            checkOwner: checkOwner === true,
            ownerField,
            tenantField,
            tool,
        });
        if (!tenantCheck.ok) {
            return tenantCheck;
        }
    } else if (checkOwner === true) {
        if (!isPlainObjectLike(resource)) {
            return errorEnvelope(
                'RBAC_INVALID_RESOURCE',
                'Target resource must be a non-null object when checkOwner is enabled',
                { statusCode: 400 },
                tool
            );
        }
        const ownerCheck = checkStrictResourceOwner(subject, resource, ownerField, tool);
        if (!ownerCheck.ok) {
            return ownerCheck.envelope;
        }
    }

    return okEnvelope(tool, 'Access granted', {
        allowed: true,
        subjectId: hasOwn(subject, 'id') && subject.id !== undefined ? subject.id : null,
        tenantId:
            hasOwn(subject, 'tenantId') && subject.tenantId !== undefined
                ? subject.tenantId
                : null,
        permission,
        matchedGrant,
    });
}

/**
 * Create an async-safe HTTP / Express `(req, res, next)` authorization guard middleware.
 *
 * Catches synchronous throws and async rejections inside `resolveSubject`, dynamic `permission(req)`,
 * `resolveResource`, or `onAudit` into a clean HTTP `500` `RBAC_RESOLVER_ERROR` JSON envelope,
 * responds `401` / `403` JSON `errorEnvelope` on denial, or attaches `req.authz = decision.data`
 * and invokes `next()`.
 *
 * @param {ReturnType<typeof createRbacPolicy>} policy - Compiled RBAC policy handle
 * @param {string | ((req: any, subject?: any) => string | Promise<string>)} permission - Required permission or dynamic resolver
 * @param {object} [options={}] - Middleware configuration
 * @param {((req: any) => any | Promise<any>) | null} [options.resolveSubject] - Subject extractor (defaults to `req?.user ?? req?.auth ?? null`)
 * @param {((req: any, subject?: any) => any | Promise<any>) | null} [options.resolveResource=null] - Optional target resource loader
 * @param {boolean} [options.requireTenantMatch=true] - Enforce tenant isolation when `resolveResource` returns a resource
 * @param {boolean} [options.checkOwner=false] - Enforce resource ownership (`subject.id === resource[ownerField]`)
 * @param {string} [options.ownerField='ownerId'] - Resource owner property name
 * @param {string} [options.tenantField='tenantId'] - Resource tenant property name
 * @param {((event: object) => unknown | Promise<unknown>) | null} [options.onAudit=null] - Optional compliance audit callback
 * @param {string} [options.tool='rbac.guard'] - `INV-LEGO-01` tool identifier
 * @returns {(req: any, res: any, next?: (err?: unknown) => unknown) => Promise<unknown>}
 */
export function createRbacGuard(policy, permission, options = {}) {
    if (!isPlainObjectLike(options)) {
        throw new TypeError('createRbacGuard options must be a plain object');
    }

    const {
        resolveSubject = (req) => req?.user ?? req?.auth ?? null,
        resolveResource = null,
        requireTenantMatch = true,
        checkOwner = false,
        ownerField = 'ownerId',
        tenantField = 'tenantId',
        onAudit = null,
        tool = 'rbac.guard',
    } = options;

    if (resolveSubject !== null && typeof resolveSubject !== 'function') {
        throw new TypeError('resolveSubject must be a function or null');
    }
    if (resolveResource !== null && typeof resolveResource !== 'function') {
        throw new TypeError('resolveResource must be a function or null');
    }
    if (onAudit !== null && typeof onAudit !== 'function') {
        throw new TypeError('onAudit must be a function or null');
    }
    if (typeof permission !== 'string' && typeof permission !== 'function') {
        throw new TypeError('permission must be a permission string or resolver function');
    }

    const subjectResolver = resolveSubject ?? ((req) => req?.user ?? req?.auth ?? null);

    return async function rbacGuardMiddleware(req, res, next) {
        let subject;
        let resolvedPermission;
        let resource = null;
        let decision;

        try {
            subject = await subjectResolver(req);
            resolvedPermission =
                typeof permission === 'function' ? await permission(req, subject) : permission;
            if (typeof resolveResource === 'function') {
                resource = await resolveResource(req, subject);
            }

            decision = evaluateAccess(policy, subject, resolvedPermission, {
                resource,
                requireTenantMatch,
                checkOwner,
                ownerField,
                tenantField,
                tool,
            });

            if (typeof onAudit === 'function') {
                const safeSub = isPlainObjectLike(subject) ? subject : null;
                await onAudit({
                    allowed: decision.ok,
                    outcome: decision.ok ? 'ALLOW' : 'DENY',
                    code: decision.ok ? 'ACCESS_GRANTED' : decision.error.code,
                    subjectId:
                        safeSub && hasOwn(safeSub, 'id') && safeSub.id !== undefined
                            ? safeSub.id
                            : null,
                    tenantId:
                        safeSub && hasOwn(safeSub, 'tenantId') && safeSub.tenantId !== undefined
                            ? safeSub.tenantId
                            : null,
                    permission: typeof resolvedPermission === 'string' ? resolvedPermission : '',
                    subject: subject ?? null,
                    resource: resource ?? null,
                    decision,
                    req,
                });
            }
        } catch (err) {
            const message =
                err instanceof Error && err.message
                    ? err.message
                    : 'Authorization resolver or audit hook failed';
            const resolverError = errorEnvelope(
                'RBAC_RESOLVER_ERROR',
                message,
                { statusCode: 500 },
                tool
            );
            sendGuardJsonResponse(res, 500, resolverError);
            return resolverError;
        }

        if (!decision.ok) {
            const detailStatus = decision.error?.details?.statusCode;
            const statusCode =
                typeof detailStatus === 'number' && detailStatus >= 400 && detailStatus <= 599
                    ? detailStatus
                    : decision.error?.code === 'RBAC_UNAUTHENTICATED'
                      ? 401
                      : 403;
            sendGuardJsonResponse(res, statusCode, decision);
            return decision;
        }

        if (req && typeof req === 'object') {
            try {
                req.authz = decision.data;
            } catch {
                // Ignore frozen request wrapper
            }
        }

        if (typeof next === 'function') {
            return next();
        }
        return decision;
    };
}
