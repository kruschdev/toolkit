/**
 * @module schema
 * @description Zero-dependency composable schema builder (`s`), duck-typed `zod` adapter,
 * JSON Schema Draft-7/2020-12 compiler, prototype-pollution & cycle-guarded payload validator,
 * and HTTP request validation middleware (`INV-LEGO-01`, `INV-LEGO-17`).
 * Pure ECMAScript & Web Standards (zero host-specific imports; runs unmodified in modern
 * server runtimes, browsers, and Cloudflare Workers).
 */

const SCHEMA_BRAND = Symbol.for('krusch.toolkit.schema');
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const ALLOWED_FORMATS = new Set([
    'email',
    'uuid',
    'url',
    'iso-date',
    'iso-datetime',
    'ipv4',
    'slug',
]);
const ALLOWED_JSON_SCHEMA_TYPES = new Set([
    'object',
    'array',
    'string',
    'number',
    'integer',
    'boolean',
    'null',
]);
const ALLOWED_MIDDLEWARE_SOURCES = new Set(['body', 'query', 'params', 'headers']);
const MAX_FORMAT_INPUT_LENGTH = 2048;
const MAX_SCHEMA_RECURSION_DEPTH = 64;

const hasOwn =
    typeof Object.hasOwn === 'function'
        ? Object.hasOwn
        : (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/**
 * Build a deterministic `INV-LEGO-01` success envelope for schema operations.
 *
 * @param {string} tool - Originating tool identifier
 * @param {string} summary - Human-readable validation summary
 * @param {unknown} data - Validated output payload
 * @returns {{ ok: true, tool: string, summary: string, data: unknown }}
 */
function schemaOkEnvelope(tool, summary, data) {
    return {
        ok: true,
        tool: String(tool || 'schema.validate'),
        summary: String(summary || 'Schema validation passed'),
        data,
    };
}

/**
 * Build a deterministic `INV-LEGO-01` error envelope for schema operations.
 *
 * @param {string} code - Machine-readable error code
 * @param {string} message - Human-readable error message
 * @param {unknown} [details=null] - Optional structured diagnostic details
 * @param {string} [tool='schema.validate'] - Originating tool identifier
 * @returns {{ ok: false, tool: string, summary: string, error: { code: string, message: string, details?: unknown } }}
 */
function schemaErrorEnvelope(code, message, details = null, tool = 'schema.validate') {
    return {
        ok: false,
        tool: String(tool || 'schema.validate'),
        summary: String(message || code || 'Schema validation failed'),
        error: {
            code: String(code || 'VALIDATION_ERROR'),
            message: String(message || 'Schema validation failed'),
            ...(details !== null && details !== undefined ? { details } : {}),
        },
    };
}

/**
 * Define an enumerable data property without triggering `Object.prototype` setters.
 *
 * @param {Record<string, unknown>} target - Destination plain object
 * @param {string} key - Property key
 * @param {unknown} value - Property value
 */
function defineSafeProperty(target, key, value) {
    if (FORBIDDEN_KEYS.has(key)) return;
    Object.defineProperty(target, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
    });
}

/**
 * Check whether a value is a plain JSON-style object (`Object.prototype` or `null` prototype).
 *
 * @param {unknown} val - Value to inspect
 * @returns {boolean}
 */
function isPlainObject(val) {
    if (val === null || typeof val !== 'object' || Array.isArray(val)) {
        return false;
    }
    const proto = Object.getPrototypeOf(val);
    return proto === null || proto === Object.prototype;
}

/**
 * Check whether an object's enumerable own properties should be traversed by `inspectPayloadGraph`
 * to catch circular references and excessive nesting even on custom class instances.
 *
 * @param {unknown} val - Value to inspect
 * @returns {boolean}
 */
function isTraversableObject(val) {
    if (val === null || typeof val !== 'object' || Array.isArray(val)) {
        return false;
    }
    if (
        val instanceof Date ||
        val instanceof RegExp ||
        val instanceof Map ||
        val instanceof Set ||
        val instanceof WeakMap ||
        val instanceof WeakSet ||
        val instanceof Promise ||
        val instanceof Error ||
        val instanceof ArrayBuffer ||
        ArrayBuffer.isView(val)
    ) {
        return false;
    }
    return true;
}

/**
 * Check whether a value is an `@krusch/toolkit/schema` builder node.
 *
 * @param {unknown} candidate - Value to inspect
 * @returns {boolean}
 */
function isKruschSchema(candidate) {
    return Boolean(
        candidate &&
            typeof candidate === 'object' &&
            candidate[SCHEMA_BRAND] === true &&
            candidate._kruschSchema &&
            typeof candidate._kruschSchema === 'object'
    );
}

/**
 * Deep-clone plain JSON-compatible structures while stripping forbidden prototype keys.
 *
 * @param {unknown} value - Value to clone safely
 * @param {WeakSet<object>} [ancestors] - Active ancestor tracker
 * @returns {unknown}
 */
function cloneSafeValue(value, ancestors = new WeakSet()) {
    if (value === null || typeof value !== 'object') {
        return value;
    }
    if (value instanceof Date) {
        return new Date(value.getTime());
    }
    if (value instanceof RegExp) {
        return new RegExp(value.source, value.flags);
    }
    if (value instanceof ArrayBuffer) {
        return value.slice(0);
    }
    if (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer) {
        return value.slice(0);
    }
    if (ArrayBuffer.isView(value)) {
        if (
            typeof Buffer !== 'undefined' &&
            typeof Buffer.isBuffer === 'function' &&
            Buffer.isBuffer(value)
        ) {
            return Buffer.from(value);
        }
        const slicedBuf = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
        if (value instanceof DataView) {
            return new DataView(slicedBuf);
        }
        const TypedCtor = Object.getPrototypeOf(value)?.constructor;
        if (typeof TypedCtor === 'function') {
            try {
                const clonedView = new TypedCtor(slicedBuf);
                if (ArrayBuffer.isView(clonedView) && clonedView.byteLength === value.byteLength) {
                    return clonedView;
                }
            } catch {
                // Fall back to clean Uint8Array view over cloned ArrayBuffer
            }
        }
        return new Uint8Array(slicedBuf);
    }
    if (ancestors.has(value)) {
        throw new TypeError('Circular reference encountered while cloning value');
    }
    ancestors.add(value);
    try {
        if (Array.isArray(value)) {
            const copy = [];
            for (let i = 0; i < value.length; i += 1) {
                copy.push(cloneSafeValue(value[i], ancestors));
            }
            return copy;
        }
        if (value instanceof Map) {
            const copy = new Map();
            for (const [k, v] of value.entries()) {
                copy.set(cloneSafeValue(k, ancestors), cloneSafeValue(v, ancestors));
            }
            return copy;
        }
        if (value instanceof Set) {
            const copy = new Set();
            for (const item of value.values()) {
                copy.add(cloneSafeValue(item, ancestors));
            }
            return copy;
        }
        if (isPlainObject(value)) {
            const copy = {};
            for (const key of Object.keys(value)) {
                if (FORBIDDEN_KEYS.has(key)) continue;
                defineSafeProperty(copy, key, cloneSafeValue(value[key], ancestors));
            }
            return copy;
        }
        return value;
    } finally {
        ancestors.delete(value);
    }
}

/**
 * Clone a schema-declared `default` value, tagging cyclic-default errors as `INVALID_SCHEMA`.
 *
 * @param {unknown} defaultValue - Schema default value
 * @returns {unknown}
 */
function cloneSchemaDefault(defaultValue) {
    try {
        return cloneSafeValue(defaultValue);
    } catch (err) {
        const schemaErr = new TypeError(
            err instanceof Error ? err.message : 'Invalid schema default value'
        );
        schemaErr.code = 'INVALID_SCHEMA';
        throw schemaErr;
    }
}

/**
 * Format an array of property/index segments (such as `zod` issue paths) into canonical dot/bracket notation.
 *
 * @param {ReadonlyArray<PropertyKey>} segments - Path segments
 * @returns {string}
 */
function formatPathSegments(segments) {
    let out = '';
    for (const seg of segments) {
        if (typeof seg === 'number') {
            out += `[${seg}]`;
        } else {
            const str = String(seg);
            out = out ? `${out}.${str}` : str;
        }
    }
    return out;
}

/**
 * Deterministic canonical serializer used for `uniqueItems` structural equality checks.
 *
 * @param {unknown} val - Validated element value
 * @returns {string}
 */
function canonicalSerialize(val) {
    if (val === null) return 'null';
    const t = typeof val;
    if (t === 'undefined') return 'undef';
    if (t === 'boolean') return `b:${val}`;
    if (t === 'number') {
        if (Number.isNaN(val)) return 'n:NaN';
        if (Object.is(val, -0)) return 'n:0';
        return `n:${val}`;
    }
    if (t === 'string') return `s:${JSON.stringify(val)}`;
    if (Array.isArray(val)) {
        return `a:[${val.map((item) => canonicalSerialize(item)).join(',')}]`;
    }
    if (isPlainObject(val)) {
        const sortedKeys = Object.keys(val)
            .filter((k) => !FORBIDDEN_KEYS.has(k))
            .sort();
        const entries = sortedKeys.map(
            (k) => `${JSON.stringify(k)}:${canonicalSerialize(val[k])}`
        );
        return `o:{${entries.join(',')}}`;
    }
    return `x:${String(val)}`;
}

// ============================================================================
// Deterministic ReDoS-Safe Format Validators
// ============================================================================

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATETIME_RE =
    /^(\d{4}-\d{2}-\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/;
const IPV4_RE = /^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Check whether an ASCII codepoint is permitted inside an unquoted email local-part atom.
 *
 * @param {number} code - UTF-16 code unit
 * @returns {boolean}
 */
function isEmailLocalChar(code) {
    if (
        (code >= 0x30 && code <= 0x39) || // 0-9
        (code >= 0x41 && code <= 0x5a) || // A-Z
        (code >= 0x61 && code <= 0x7a) // a-z
    ) {
        return true;
    }
    // Printable RFC 5322 atom specials: ! # $ % & ' * + - / = ? ^ _ ` { | } ~ .
    switch (code) {
        case 0x21:
        case 0x23:
        case 0x24:
        case 0x25:
        case 0x26:
        case 0x27:
        case 0x2a:
        case 0x2b:
        case 0x2d:
        case 0x2e:
        case 0x2f:
        case 0x3d:
        case 0x3f:
        case 0x5e:
        case 0x5f:
        case 0x60:
        case 0x7b:
        case 0x7c:
        case 0x7d:
        case 0x7e:
            return true;
        default:
            return false;
    }
}

/**
 * Validate a domain label in linear time without backtracking.
 *
 * @param {string} label - Single DNS label
 * @returns {boolean}
 */
function isValidDomainLabel(label) {
    if (label.length < 1 || label.length > 63) return false;
    for (let i = 0; i < label.length; i += 1) {
        const c = label.charCodeAt(i);
        const isAlphaNum =
            (c >= 0x30 && c <= 0x39) ||
            (c >= 0x41 && c <= 0x5a) ||
            (c >= 0x61 && c <= 0x7a);
        if (i === 0 || i === label.length - 1) {
            if (!isAlphaNum) return false;
        } else if (!isAlphaNum && c !== 0x2d) {
            return false;
        }
    }
    return true;
}

/**
 * Linear-time email validator with zero regex backtracking.
 *
 * @param {string} val - Candidate email string
 * @returns {boolean}
 */
function isValidEmail(val) {
    if (val.length < 3 || val.length > 320) return false;
    for (let i = 0; i < val.length; i += 1) {
        const code = val.charCodeAt(i);
        if (code <= 0x20 || code >= 0x7f) return false;
    }
    const atIdx = val.indexOf('@');
    if (atIdx <= 0 || atIdx !== val.lastIndexOf('@')) return false;

    const local = val.slice(0, atIdx);
    const domain = val.slice(atIdx + 1);
    if (local.length < 1 || local.length > 64) return false;
    if (domain.length < 3 || domain.length > 255) return false;
    if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) {
        return false;
    }
    for (let i = 0; i < local.length; i += 1) {
        if (!isEmailLocalChar(local.charCodeAt(i))) return false;
    }

    const labels = domain.split('.');
    if (labels.length < 2) return false;
    for (const label of labels) {
        if (!isValidDomainLabel(label)) return false;
    }
    const tld = labels[labels.length - 1];
    if (tld.length < 2) return false;
    return true;
}

/**
 * Validate a `YYYY-MM-DD` calendar date including exact month lengths and leap years.
 *
 * @param {string} val - Candidate date string
 * @returns {boolean}
 */
function isValidIsoDate(val) {
    const match = ISO_DATE_RE.exec(val);
    if (!match) return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (month < 1 || month > 12 || day < 1) return false;

    let maxDays = 31;
    if (month === 4 || month === 6 || month === 9 || month === 11) {
        maxDays = 30;
    } else if (month === 2) {
        const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
        maxDays = isLeap ? 29 : 28;
    }
    return day <= maxDays;
}

/**
 * Validate an ISO-8601 timestamp (`YYYY-MM-DDTHH:mm:ss(.sss)?(Z|[+-]HH:mm)`).
 *
 * @param {string} val - Candidate datetime string
 * @returns {boolean}
 */
function isValidIsoDateTime(val) {
    const match = ISO_DATETIME_RE.exec(val);
    if (!match) return false;
    if (!isValidIsoDate(match[1])) return false;

    const hour = Number(match[2]);
    const minute = Number(match[3]);
    const second = Number(match[4]);
    if (hour > 23 || minute > 59 || second > 59) return false;

    if (match[6]) {
        const tzHour = Number(match[7]);
        const tzMinute = Number(match[8]);
        if (tzHour > 23 || tzMinute > 59) return false;
    }
    return Number.isFinite(Date.parse(val));
}

/**
 * Validate a canonical dotted-quad IPv4 literal (`0..255` per octet, rejecting leading zeros).
 *
 * @param {string} val - Candidate IPv4 string
 * @returns {boolean}
 */
function isValidIpv4(val) {
    if (!IPV4_RE.test(val)) return false;
    const parts = val.split('.');
    if (parts.length !== 4) return false;
    for (const part of parts) {
        const octet = Number(part);
        if (!Number.isInteger(octet) || octet < 0 || octet > 255) return false;
    }
    return true;
}

/**
 * Validate an `http:` or `https:` URL with non-empty hostname and zero raw whitespace.
 *
 * @param {string} val - Candidate URL string
 * @returns {boolean}
 */
function isValidHttpUrl(val) {
    if (/\s/.test(val)) return false;
    try {
        const parsed = new URL(val);
        return (
            (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
            parsed.hostname.length > 0
        );
    } catch {
        return false;
    }
}

/**
 * Evaluate a string against a named deterministic format validator.
 * Enforces `<= 2048` byte/char bound BEFORE evaluating any format rule.
 *
 * @param {string} format - Format identifier
 * @param {string} val - Input string
 * @returns {boolean}
 */
function isValidStringFormat(format, val) {
    if (typeof val !== 'string' || val.length === 0 || val.length > MAX_FORMAT_INPUT_LENGTH) {
        return false;
    }
    switch (format) {
        case 'email':
            return isValidEmail(val);
        case 'uuid':
            return UUID_RE.test(val);
        case 'url':
            return isValidHttpUrl(val);
        case 'iso-date':
            return isValidIsoDate(val);
        case 'iso-datetime':
            return isValidIsoDateTime(val);
        case 'ipv4':
            return isValidIpv4(val);
        case 'slug':
            return SLUG_RE.test(val);
        default:
            return true;
    }
}

// ============================================================================
// Payload Cycle & Nesting Depth Pre-Validator
// ============================================================================

/**
 * Traverse a payload graph iteratively/recursively using an active-ancestor `WeakSet`
 * to detect circular references (`SCHEMA_CIRCULAR_REF`) and excessive nesting (`SCHEMA_MAX_DEPTH`)
 * without falsely flagging shared non-circular DAG references.
 *
 * @param {unknown} payload - Root untrusted payload
 * @param {number} safeMaxDepth - Maximum allowed container nesting depth (`>= 1`)
 * @returns {{ code: 'SCHEMA_CIRCULAR_REF' | 'SCHEMA_MAX_DEPTH', path: string } | null}
 */
function isContainerGraphNode(val) {
    return (
        Array.isArray(val) ||
        val instanceof Map ||
        val instanceof Set ||
        isTraversableObject(val)
    );
}

function getInspectableOwnKeys(obj) {
    if (ArrayBuffer.isView(obj) && !(obj instanceof DataView)) {
        const len = typeof obj.length === 'number' ? obj.length : 0;
        if (len > 65536) {
            return [];
        }
        return Object.keys(obj).filter((k) => {
            const idx = Number(k);
            return !(Number.isInteger(idx) && idx >= 0 && idx < len && String(idx) === k);
        });
    }
    return Object.keys(obj);
}

function inspectPayloadGraph(payload, safeMaxDepth) {
    if (payload === null || typeof payload !== 'object') {
        return null;
    }
    if (!isContainerGraphNode(payload) && getInspectableOwnKeys(payload).length === 0) {
        return null;
    }

    const ancestors = new WeakSet();
    /**
     * Explicit DFS stack frames:
     * `{ node, path, depth, exiting }`
     */
    const stack = [{ node: payload, path: '', depth: 1, exiting: false }];

    while (stack.length > 0) {
        const frame = stack.pop();
        if (frame.exiting) {
            ancestors.delete(frame.node);
            continue;
        }

        if (ancestors.has(frame.node)) {
            return { code: 'SCHEMA_CIRCULAR_REF', path: frame.path };
        }
        if (frame.depth > safeMaxDepth) {
            return { code: 'SCHEMA_MAX_DEPTH', path: frame.path };
        }

        ancestors.add(frame.node);
        stack.push({ node: frame.node, path: frame.path, depth: frame.depth, exiting: true });

        const pushChild = (child, childPath) => {
            if (child === null || typeof child !== 'object') {
                return null;
            }
            if (ancestors.has(child)) {
                return { code: 'SCHEMA_CIRCULAR_REF', path: childPath };
            }
            if (isContainerGraphNode(child) || getInspectableOwnKeys(child).length > 0) {
                stack.push({
                    node: child,
                    path: childPath,
                    depth: frame.depth + 1,
                    exiting: false,
                });
            }
            return null;
        };

        if (Array.isArray(frame.node)) {
            const allKeys = Object.keys(frame.node);
            if (allKeys.length > frame.node.length) {
                for (let i = allKeys.length - 1; i >= 0; i -= 1) {
                    const key = allKeys[i];
                    const idx = Number(key);
                    if (
                        Number.isInteger(idx) &&
                        idx >= 0 &&
                        idx < frame.node.length &&
                        String(idx) === key
                    ) {
                        continue;
                    }
                    const child = FORBIDDEN_KEYS.has(key)
                        ? Object.getOwnPropertyDescriptor(frame.node, key)?.value
                        : frame.node[key];
                    const childPath = frame.path ? `${frame.path}.${key}` : key;
                    const err = pushChild(child, childPath);
                    if (err) return err;
                }
            }
            for (let i = frame.node.length - 1; i >= 0; i -= 1) {
                const err = pushChild(frame.node[i], `${frame.path}[${i}]`);
                if (err) return err;
            }
        } else {
            const keys = getInspectableOwnKeys(frame.node);
            for (let i = keys.length - 1; i >= 0; i -= 1) {
                const key = keys[i];
                const child = FORBIDDEN_KEYS.has(key)
                    ? Object.getOwnPropertyDescriptor(frame.node, key)?.value
                    : frame.node[key];
                const childPath = frame.path ? `${frame.path}.${key}` : key;
                const err = pushChild(child, childPath);
                if (err) return err;
            }
            if (frame.node instanceof Map) {
                const entries = [...frame.node.entries()];
                for (let i = entries.length - 1; i >= 0; i -= 1) {
                    const [entryKey, entryVal] = entries[i];
                    const valErr = pushChild(entryVal, `${frame.path}.$mapValue[${i}]`);
                    if (valErr) return valErr;
                    const keyErr = pushChild(entryKey, `${frame.path}.$mapKey[${i}]`);
                    if (keyErr) return keyErr;
                }
            } else if (frame.node instanceof Set) {
                const values = [...frame.node.values()];
                for (let i = values.length - 1; i >= 0; i -= 1) {
                    const itemErr = pushChild(values[i], `${frame.path}[${i}]`);
                    if (itemErr) return itemErr;
                }
            }
        }
    }

    return null;
}

/**
 * Normalize `maxDepth` option into a safe positive integer (`>= 1`, default `16`).
 *
 * @param {unknown} maxDepth - Caller-supplied depth option
 * @returns {number}
 */
function normalizeMaxDepth(maxDepth) {
    const raw = maxDepth === undefined || maxDepth === null ? 16 : Number(maxDepth);
    return Number.isFinite(raw) ? Math.max(1, Math.trunc(raw)) : 16;
}

// ============================================================================
// Composable Schema Node Factory (`s.*`)
// ============================================================================

/**
 * Determine whether a schema node allows omission from parent `s.object` `required` list.
 *
 * @param {unknown} node - Schema node
 * @param {number} [depth=0] - Recursion guard
 * @returns {boolean}
 */
function isOptionalSchemaNode(node, depth = 0) {
    if (depth > 32 || !node || typeof node !== 'object') return false;
    if (isKruschSchema(node)) {
        const meta = node._kruschSchema;
        if (meta.kind === 'optional' || meta.hasDefault) return true;
        if (meta.kind === 'nullable') return isOptionalSchemaNode(meta.inner, depth + 1);
        if (meta.kind === 'union' && Array.isArray(meta.branches)) {
            return meta.branches.some((b) => isOptionalSchemaNode(b, depth + 1));
        }
        return false;
    }
    if (typeof node.safeParse === 'function') {
        const def = node._def || node.def;
        if (def && typeof def === 'object') {
            const typeName = def.typeName || def.type;
            if (
                typeName === 'ZodOptional' ||
                typeName === 'ZodDefault' ||
                typeName === 'optional' ||
                typeName === 'default'
            ) {
                return true;
            }
            if (
                (typeName === 'ZodNullable' || typeName === 'nullable') &&
                def.innerType
            ) {
                return isOptionalSchemaNode(def.innerType, depth + 1);
            }
        }
        if (typeof node.isOptional === 'function') {
            try {
                return Boolean(node.isOptional());
            } catch {
                return false;
            }
        }
        return false;
    }
    if (
        isPlainObject(node) &&
        hasOwn(node, 'default') &&
        node.default !== undefined &&
        typeof node.default !== 'function'
    ) {
        return true;
    }
    return false;
}

/**
 * Validate that a definition-time argument is a usable schema descriptor.
 *
 * @param {unknown} candidate - Schema argument
 * @param {string} callerName - Builder function name for diagnostics
 */
function assertValidSchemaInput(candidate, callerName) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
        throw new TypeError(`${callerName} requires a valid schema object`);
    }
    if (
        !isKruschSchema(candidate) &&
        typeof candidate.safeParse !== 'function' &&
        !isValidRawJsonSchemaObject(candidate)
    ) {
        throw new TypeError(
            `${callerName} requires an s.* node, safeParse schema, or valid plain JSON Schema`
        );
    }
}

/**
 * Construct a frozen composable schema node with `.optional()`, `.nullable()`, `.safeParse()`, and `.toJsonSchema()`.
 *
 * @param {object} descriptor - Internal node metadata
 * @param {(val: unknown, path: string, ctx: object, issues: Array<object>) => { valid: boolean, value: unknown }} evaluateFn
 * @param {() => Record<string, unknown>} jsonSchemaFn
 * @returns {Readonly<object>}
 */
function createSchemaNode(descriptor, evaluateFn, jsonSchemaFn) {
    const frozenDescriptor = Object.freeze({ ...descriptor });

    const node = {
        [SCHEMA_BRAND]: true,
        _kruschSchema: frozenDescriptor,
        optional() {
            return createOptionalNode(node);
        },
        nullable() {
            return createNullableNode(node);
        },
        toJsonSchema() {
            return jsonSchemaFn();
        },
        safeParse(input, options = {}) {
            const safeOpts = options && typeof options === 'object' ? options : {};
            const safeMaxDepth = normalizeMaxDepth(safeOpts.maxDepth);
            let graphErr = null;
            try {
                graphErr = inspectPayloadGraph(input, safeMaxDepth);
            } catch (err) {
                const msg = err instanceof Error ? err.message : 'Payload inspection failed';
                return {
                    success: false,
                    error: {
                        message: msg,
                        issues: [{ path: '', code: 'VALIDATION_ERROR', message: msg }],
                    },
                };
            }
            if (graphErr) {
                const isCycle = graphErr.code === 'SCHEMA_CIRCULAR_REF';
                const issueMessage = isCycle
                    ? 'Circular reference detected'
                    : `Maximum depth ${safeMaxDepth} exceeded`;
                const topMessage = isCycle
                    ? 'Payload contains circular reference'
                    : `Payload exceeds maximum nesting depth of ${safeMaxDepth}`;
                return {
                    success: false,
                    error: {
                        message: topMessage,
                        issues: [
                            {
                                path: graphErr.path,
                                code: graphErr.code,
                                message: issueMessage,
                            },
                        ],
                    },
                };
            }

            const ctx = {
                coerce: Boolean(safeOpts.coerce),
                stripUnknown: safeOpts.stripUnknown !== undefined ? Boolean(safeOpts.stripUnknown) : true,
                maxDepth: safeMaxDepth,
            };
            const issues = [];
            let res;
            try {
                res = evaluateFn(input, '', ctx, issues);
            } catch (err) {
                const isSchemaErr = Boolean(err && typeof err === 'object' && err.code === 'INVALID_SCHEMA');
                const code = isSchemaErr ? 'INVALID_SCHEMA' : 'VALIDATION_ERROR';
                const msg = err instanceof Error ? err.message : 'Schema validation failed';
                return {
                    success: false,
                    error: {
                        message: msg,
                        issues: [{ path: '', code, message: msg }],
                    },
                };
            }
            if (!res.valid || issues.length > 0) {
                const fallbackIssues =
                    issues.length > 0
                        ? issues
                        : [{ path: '', code: 'VALIDATION_ERROR', message: 'Schema validation failed' }];
                return {
                    success: false,
                    error: {
                        message: fallbackIssues[0].message,
                        issues: fallbackIssues,
                    },
                };
            }
            return {
                success: true,
                data: res.value,
            };
        },
    };

    Object.defineProperty(node, '_evaluate', {
        value: evaluateFn,
        enumerable: false,
        writable: false,
        configurable: false,
    });

    return Object.freeze(node);
}

/**
 * Recursively inspect a validated value (and optional raw input for external `safeParse` schemas)
 * to fail closed on `NaN` / `±Infinity` numbers and `boolean -> number` coercions (`INV-LEGO-17`).
 *
 * @param {unknown} rawVal - Original caller input at the corresponding path
 * @param {unknown} outVal - Parsed/cloned candidate output value
 * @param {string} [basePath=''] - Current dot/bracket path
 * @param {boolean} [checkBoolCoercion=false] - Reject `typeof rawVal === 'boolean'` coerced to `number`
 * @param {WeakSet<object>} [seen] - Visited output object guard
 * @returns {Array<{ path: string, code: string, message: string }>}
 */
function collectNumericAndCoercionIssues(
    rawVal,
    outVal,
    basePath = '',
    checkBoolCoercion = false,
    seen = new WeakSet()
) {
    const found = [];

    function walk(rawNode, outNode, curPath) {
        if (typeof outNode === 'number') {
            if (!Number.isFinite(outNode)) {
                found.push({
                    path: curPath,
                    code: 'INVALID_TYPE',
                    message: 'Expected finite number (not NaN or Infinity)',
                });
                return;
            }
            if (checkBoolCoercion && typeof rawNode === 'boolean') {
                found.push({
                    path: curPath,
                    code: 'INVALID_TYPE',
                    message: 'Boolean cannot be coerced to number',
                });
            }
            return;
        }

        if (outNode === null || typeof outNode !== 'object') {
            return;
        }
        if (
            outNode instanceof ArrayBuffer ||
            (typeof SharedArrayBuffer !== 'undefined' && outNode instanceof SharedArrayBuffer) ||
            ArrayBuffer.isView(outNode) ||
            outNode instanceof Date ||
            outNode instanceof RegExp
        ) {
            return;
        }
        if (seen.has(outNode)) {
            return;
        }
        seen.add(outNode);

        if (Array.isArray(outNode)) {
            const rawArr = Array.isArray(rawNode) ? rawNode : null;
            for (let i = 0; i < outNode.length; i += 1) {
                walk(rawArr ? rawArr[i] : undefined, outNode[i], `${curPath}[${i}]`);
            }
            return;
        }

        if (outNode instanceof Set) {
            const rawSeq = Array.isArray(rawNode)
                ? rawNode
                : rawNode instanceof Set
                  ? Array.from(rawNode)
                  : null;
            if (checkBoolCoercion && rawSeq) {
                const coercedTrue = rawSeq.includes(true) && !outNode.has(true) && outNode.has(1);
                const coercedFalse = rawSeq.includes(false) && !outNode.has(false) && outNode.has(0);
                if (coercedTrue || coercedFalse) {
                    found.push({
                        path: curPath,
                        code: 'INVALID_TYPE',
                        message: 'Boolean cannot be coerced to number',
                    });
                }
            }
            let idx = 0;
            for (const entry of outNode) {
                walk(undefined, entry, `${curPath}[${idx}]`);
                idx += 1;
            }
            return;
        }

        if (outNode instanceof Map) {
            const rawMap = rawNode instanceof Map ? rawNode : null;
            let idx = 0;
            for (const [k, v] of outNode.entries()) {
                walk(undefined, k, `${curPath}[key:${idx}]`);
                walk(rawMap && rawMap.has(k) ? rawMap.get(k) : undefined, v, `${curPath}[${String(k)}]`);
                idx += 1;
            }
            return;
        }

        const rawObj =
            rawNode !== null && typeof rawNode === 'object' && !Array.isArray(rawNode)
                ? rawNode
                : null;
        for (const key of Object.keys(outNode)) {
            if (FORBIDDEN_KEYS.has(key)) continue;
            const childPath = curPath ? `${curPath}.${key}` : key;
            const rawChild = rawObj && hasOwn(rawObj, key) ? rawObj[key] : undefined;
            walk(rawChild, outNode[key], childPath);
        }
    }

    walk(rawVal, outVal, basePath);
    return found;
}

/**
 * Evaluate any nested child schema (`s.*`, duck-typed `safeParse`, or plain JSON Schema) within a shared validation context.
 *
 * @param {object} childSchema - Child schema node
 * @param {unknown} val - Candidate value
 * @param {string} path - Dot/bracket path
 * @param {object} ctx - Validation options context
 * @param {Array<object>} issues - Mutable issue accumulator
 * @param {number} [schemaDepth=0] - Schema graph recursion counter
 * @returns {{ valid: boolean, value: unknown }}
 */
function evaluateAnySchema(childSchema, val, path, ctx, issues, schemaDepth = 0) {
    if (isKruschSchema(childSchema)) {
        return childSchema._evaluate(val, path, ctx, issues);
    }
    if (childSchema && typeof childSchema.safeParse === 'function') {
        try {
            const parsed = childSchema.safeParse(val);
            if (parsed && parsed.success === true) {
                const clonedOut = cloneSafeValue(parsed.data);
                const numericIssues = collectNumericAndCoercionIssues(val, clonedOut, path, true);
                if (numericIssues.length > 0) {
                    issues.push(...numericIssues);
                    return { valid: false, value: undefined };
                }
                return { valid: true, value: clonedOut };
            }
            const rawIssues = Array.isArray(parsed?.error?.issues)
                ? parsed.error.issues
                : Array.isArray(parsed?.error?.errors)
                  ? parsed.error.errors
                  : [];
            if (rawIssues.length > 0) {
                for (const iss of rawIssues) {
                    const subPath = Array.isArray(iss?.path)
                        ? formatPathSegments(iss.path)
                        : String(iss?.path ?? '');
                    const fullPath = path && subPath
                        ? subPath.startsWith('[')
                            ? `${path}${subPath}`
                            : `${path}.${subPath}`
                        : path || subPath;
                    issues.push({
                        path: fullPath,
                        code: String(iss?.code || 'VALIDATION_ERROR'),
                        message: String(iss?.message || 'Validation failed'),
                    });
                }
            } else {
                issues.push({
                    path,
                    code: 'VALIDATION_ERROR',
                    message: String(parsed?.error?.message || 'Validation failed'),
                });
            }
            return { valid: false, value: undefined };
        } catch (err) {
            issues.push({
                path,
                code: 'SAFE_PARSE_THROW',
                message: err instanceof Error ? err.message : String(err),
            });
            return { valid: false, value: undefined };
        }
    }
    return evaluateRawJsonSchema(childSchema, val, path, ctx, issues, schemaDepth + 1);
}

/**
 * Create a frozen optional wrapper schema node.
 *
 * @param {object} innerSchema - Inner schema node
 * @returns {Readonly<object>}
 */
function createOptionalNode(innerSchema) {
    assertValidSchemaInput(innerSchema, 's.optional');
    return createSchemaNode(
        { kind: 'optional', inner: innerSchema, hasDefault: Boolean(innerSchema?._kruschSchema?.hasDefault) },
        (val, path, ctx, issues) => {
            if (val === undefined) {
                if (innerSchema?._kruschSchema?.hasDefault) {
                    return evaluateAnySchema(innerSchema, undefined, path, ctx, issues);
                }
                return { valid: true, value: undefined };
            }
            return evaluateAnySchema(innerSchema, val, path, ctx, issues);
        },
        () => toJsonSchema(innerSchema)
    );
}

/**
 * Create a frozen nullable wrapper schema node.
 *
 * @param {object} innerSchema - Inner schema node
 * @returns {Readonly<object>}
 */
function createNullableNode(innerSchema) {
    assertValidSchemaInput(innerSchema, 's.nullable');
    return createSchemaNode(
        { kind: 'nullable', inner: innerSchema, hasDefault: Boolean(innerSchema?._kruschSchema?.hasDefault) },
        (val, path, ctx, issues) => {
            if (val === null) {
                return { valid: true, value: null };
            }
            return evaluateAnySchema(innerSchema, val, path, ctx, issues);
        },
        () => {
            const innerJson = toJsonSchema(innerSchema);
            if (typeof innerJson.type === 'string') {
                const nextType = innerJson.type === 'null' ? 'null' : [innerJson.type, 'null'];
                const out = { ...innerJson, type: nextType };
                if (Array.isArray(out.enum) && !out.enum.includes(null)) {
                    out.enum = [...out.enum, null];
                }
                return out;
            }
            if (Array.isArray(innerJson.type)) {
                return {
                    ...innerJson,
                    type: innerJson.type.includes('null') ? [...innerJson.type] : [...innerJson.type, 'null'],
                };
            }
            if (Array.isArray(innerJson.anyOf)) {
                return {
                    ...innerJson,
                    anyOf: [...innerJson.anyOf, { type: 'null' }],
                };
            }
            if (Object.keys(innerJson).length === 0 || (Object.keys(innerJson).length === 1 && innerJson.description)) {
                return { ...innerJson };
            }
            return { anyOf: [innerJson, { type: 'null' }] };
        }
    );
}

/**
 * Create a numeric (`number` or `integer`) schema node.
 *
 * @param {object} [opts={}] - Numeric constraints
 * @param {boolean} [forceInteger=false] - Force integer mode
 * @returns {Readonly<object>}
 */
function createNumberNode(opts = {}, forceInteger = false) {
    const safeOpts = opts && typeof opts === 'object' ? opts : {};
    const { min, max, description } = safeOpts;
    const isInt = Boolean(forceInteger || safeOpts.integer);
    const hasDefault = hasOwn(safeOpts, 'default') && safeOpts.default !== undefined;
    const defaultValue = hasDefault ? safeOpts.default : undefined;

    if (min !== undefined && (typeof min !== 'number' || !Number.isFinite(min))) {
        throw new TypeError('s.number "min" must be a finite number');
    }
    if (max !== undefined && (typeof max !== 'number' || !Number.isFinite(max))) {
        throw new TypeError('s.number "max" must be a finite number');
    }
    if (min !== undefined && max !== undefined && min > max) {
        throw new RangeError('s.number "min" cannot exceed "max"');
    }

    return createSchemaNode(
        { kind: isInt ? 'integer' : 'number', hasDefault },
        (rawVal, path, ctx, issues) => {
            let val = rawVal === undefined && hasDefault ? defaultValue : rawVal;

            if (ctx.coerce && typeof val === 'string') {
                const trimmed = val.trim();
                if (trimmed.length > 0) {
                    const parsed = Number(trimmed);
                    if (Number.isFinite(parsed)) {
                        val = parsed;
                    }
                }
            }

            if (typeof val !== 'number' || !Number.isFinite(val)) {
                issues.push({
                    path,
                    code: 'INVALID_TYPE',
                    message: isInt ? 'Expected finite integer' : 'Expected finite number',
                });
                return { valid: false, value: undefined };
            }

            let valid = true;
            if (isInt && !Number.isInteger(val)) {
                issues.push({
                    path,
                    code: 'INVALID_INTEGER',
                    message: 'Expected integer value',
                });
                valid = false;
            }
            if (min !== undefined && val < min) {
                issues.push({
                    path,
                    code: 'NUMBER_TOO_SMALL',
                    message: `Number must be >= ${min}`,
                });
                valid = false;
            }
            if (max !== undefined && val > max) {
                issues.push({
                    path,
                    code: 'NUMBER_TOO_LARGE',
                    message: `Number must be <= ${max}`,
                });
                valid = false;
            }

            const normalizedVal = Object.is(val, -0) ? 0 : val;
            return { valid, value: valid ? normalizedVal : undefined };
        },
        () => ({
            type: isInt ? 'integer' : 'number',
            ...(min !== undefined ? { minimum: min } : {}),
            ...(max !== undefined ? { maximum: max } : {}),
            ...(hasDefault ? { default: defaultValue } : {}),
            ...(description !== undefined ? { description: String(description) } : {}),
        })
    );
}

/**
 * Frozen composable schema builder namespace (`s`).
 */
export const s = Object.freeze({
    /**
     * String schema builder with optional trimming, length bounds, regex pattern, and ReDoS-safe formats.
     */
    string(opts = {}) {
        const safeOpts = opts && typeof opts === 'object' ? opts : {};
        const { minLength, maxLength, pattern, format, trim = false, description } = safeOpts;
        const hasDefault = hasOwn(safeOpts, 'default') && safeOpts.default !== undefined;
        const defaultValue = hasDefault ? safeOpts.default : undefined;

        if (minLength !== undefined && (typeof minLength !== 'number' || !Number.isFinite(minLength) || minLength < 0)) {
            throw new TypeError('s.string "minLength" must be a non-negative finite number');
        }
        if (maxLength !== undefined && (typeof maxLength !== 'number' || !Number.isFinite(maxLength) || maxLength < 0)) {
            throw new TypeError('s.string "maxLength" must be a non-negative finite number');
        }
        if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) {
            throw new RangeError('s.string "minLength" cannot exceed "maxLength"');
        }
        if (format !== undefined && !ALLOWED_FORMATS.has(format)) {
            throw new TypeError(
                `Unsupported s.string format "${String(format)}"; expected email, uuid, url, iso-date, iso-datetime, ipv4, or slug`
            );
        }

        let compiledPattern = null;
        let patternSource = undefined;
        if (pattern !== undefined) {
            if (pattern instanceof RegExp) {
                const statelessFlags = pattern.flags.replace(/[gy]/g, '');
                compiledPattern = new RegExp(pattern.source, statelessFlags);
                patternSource = pattern.source;
            } else if (typeof pattern === 'string') {
                compiledPattern = new RegExp(pattern);
                patternSource = pattern;
            } else {
                throw new TypeError('s.string "pattern" must be a RegExp or string');
            }
        }

        return createSchemaNode(
            { kind: 'string', hasDefault },
            (rawVal, path, ctx, issues) => {
                let val = rawVal === undefined && hasDefault ? defaultValue : rawVal;

                if (typeof val !== 'string' && ctx.coerce) {
                    if ((typeof val === 'number' && Number.isFinite(val)) || typeof val === 'boolean') {
                        val = String(val);
                    }
                }

                if (typeof val !== 'string') {
                    issues.push({
                        path,
                        code: 'INVALID_TYPE',
                        message: 'Expected string',
                    });
                    return { valid: false, value: undefined };
                }

                if (trim) {
                    val = val.trim();
                }

                let valid = true;
                if (minLength !== undefined && val.length < minLength) {
                    issues.push({
                        path,
                        code: 'STRING_TOO_SHORT',
                        message: `String length must be at least ${minLength}`,
                    });
                    valid = false;
                }
                if (maxLength !== undefined && val.length > maxLength) {
                    issues.push({
                        path,
                        code: 'STRING_TOO_LONG',
                        message: `String length must be at most ${maxLength}`,
                    });
                    valid = false;
                }
                if (compiledPattern && !compiledPattern.test(val)) {
                    issues.push({
                        path,
                        code: 'INVALID_PATTERN',
                        message: 'String does not match required pattern',
                    });
                    valid = false;
                }
                if (format !== undefined && !isValidStringFormat(format, val)) {
                    issues.push({
                        path,
                        code: 'INVALID_FORMAT',
                        message: `Invalid ${format} format`,
                    });
                    valid = false;
                }

                return { valid, value: valid ? val : undefined };
            },
            () => ({
                type: 'string',
                ...(minLength !== undefined ? { minLength } : {}),
                ...(maxLength !== undefined ? { maxLength } : {}),
                ...(patternSource !== undefined ? { pattern: patternSource } : {}),
                ...(format !== undefined ? { format } : {}),
                ...(hasDefault ? { default: defaultValue } : {}),
                ...(description !== undefined ? { description: String(description) } : {}),
            })
        );
    },

    /**
     * Finite number schema builder (rejecting `boolean`, `NaN`, and `+/-Infinity`).
     */
    number(opts = {}) {
        return createNumberNode(opts, false);
    },

    /**
     * Finite integer schema builder emitting `{ type: 'integer' }` in JSON Schema.
     */
    integer(opts = {}) {
        return createNumberNode(opts, true);
    },

    /**
     * Boolean schema builder.
     */
    boolean(opts = {}) {
        const safeOpts = opts && typeof opts === 'object' ? opts : {};
        const { description } = safeOpts;
        const hasDefault = hasOwn(safeOpts, 'default') && safeOpts.default !== undefined;
        const defaultValue = hasDefault ? safeOpts.default : undefined;

        return createSchemaNode(
            { kind: 'boolean', hasDefault },
            (rawVal, path, ctx, issues) => {
                let val = rawVal === undefined && hasDefault ? defaultValue : rawVal;

                if (ctx.coerce && typeof val === 'string') {
                    const norm = val.trim().toLowerCase();
                    if (norm === 'true' || norm === '1') {
                        val = true;
                    } else if (norm === 'false' || norm === '0') {
                        val = false;
                    }
                }

                if (typeof val !== 'boolean') {
                    issues.push({
                        path,
                        code: 'INVALID_TYPE',
                        message: 'Expected boolean',
                    });
                    return { valid: false, value: undefined };
                }

                return { valid: true, value: val };
            },
            () => ({
                type: 'boolean',
                ...(hasDefault ? { default: defaultValue } : {}),
                ...(description !== undefined ? { description: String(description) } : {}),
            })
        );
    },

    /**
     * Exact value schema builder (`Object.is`) emitting `{ const: expectedValue }`.
     */
    literal(expectedValue, opts = {}) {
        const safeOpts = opts && typeof opts === 'object' ? opts : {};
        const { description } = safeOpts;

        return createSchemaNode(
            { kind: 'literal', hasDefault: false },
            (val, path, _ctx, issues) => {
                if (!Object.is(val, expectedValue)) {
                    issues.push({
                        path,
                        code: 'INVALID_LITERAL',
                        message: `Expected literal ${JSON.stringify(expectedValue)}`,
                    });
                    return { valid: false, value: undefined };
                }
                return { valid: true, value: val };
            },
            () => ({
                const: expectedValue,
                ...(description !== undefined ? { description: String(description) } : {}),
            })
        );
    },

    /**
     * Closed primitive enum schema builder (`string | number | boolean`).
     */
    enum(values, opts = {}) {
        if (!Array.isArray(values) || values.length === 0) {
            throw new TypeError('s.enum requires a non-empty array of primitive values');
        }
        for (const item of values) {
            const isValidPrimitive =
                typeof item === 'string' ||
                (typeof item === 'number' && Number.isFinite(item)) ||
                typeof item === 'boolean';
            if (!isValidPrimitive) {
                throw new TypeError(
                    's.enum values must be primitive string, finite number, or boolean literals'
                );
            }
        }

        const safeOpts = opts && typeof opts === 'object' ? opts : {};
        const { description } = safeOpts;
        const hasDefault = hasOwn(safeOpts, 'default') && safeOpts.default !== undefined;
        const defaultValue = hasDefault ? safeOpts.default : undefined;
        const frozenValues = Object.freeze([...values]);
        const valueSet = new Set(frozenValues);

        return createSchemaNode(
            { kind: 'enum', hasDefault },
            (rawVal, path, _ctx, issues) => {
                const val = rawVal === undefined && hasDefault ? defaultValue : rawVal;
                if (!valueSet.has(val)) {
                    issues.push({
                        path,
                        code: 'INVALID_ENUM',
                        message: `Expected one of: ${frozenValues.map((v) => JSON.stringify(v)).join(', ')}`,
                    });
                    return { valid: false, value: undefined };
                }
                return { valid: true, value: val };
            },
            () => ({
                enum: [...frozenValues],
                ...(hasDefault ? { default: defaultValue } : {}),
                ...(description !== undefined ? { description: String(description) } : {}),
            })
        );
    },

    /**
     * Homogeneous array schema builder with bounds and structural `uniqueItems` checks.
     */
    array(itemSchema, opts = {}) {
        assertValidSchemaInput(itemSchema, 's.array');
        const safeOpts = opts && typeof opts === 'object' ? opts : {};
        const { minItems, maxItems, uniqueItems = false, description } = safeOpts;
        const hasDefault = hasOwn(safeOpts, 'default') && safeOpts.default !== undefined;
        const defaultValue = hasDefault ? safeOpts.default : undefined;

        if (minItems !== undefined && (typeof minItems !== 'number' || !Number.isFinite(minItems) || minItems < 0)) {
            throw new TypeError('s.array "minItems" must be a non-negative finite number');
        }
        if (maxItems !== undefined && (typeof maxItems !== 'number' || !Number.isFinite(maxItems) || maxItems < 0)) {
            throw new TypeError('s.array "maxItems" must be a non-negative finite number');
        }
        if (minItems !== undefined && maxItems !== undefined && minItems > maxItems) {
            throw new RangeError('s.array "minItems" cannot exceed "maxItems"');
        }

        return createSchemaNode(
            { kind: 'array', hasDefault },
            (rawVal, path, ctx, issues) => {
                const val = rawVal === undefined && hasDefault ? cloneSchemaDefault(defaultValue) : rawVal;

                if (!Array.isArray(val)) {
                    issues.push({
                        path,
                        code: 'INVALID_TYPE',
                        message: 'Expected array',
                    });
                    return { valid: false, value: undefined };
                }

                let valid = true;
                if (minItems !== undefined && val.length < minItems) {
                    issues.push({
                        path,
                        code: 'ARRAY_TOO_SHORT',
                        message: `Array must contain at least ${minItems} item(s)`,
                    });
                    valid = false;
                }
                if (maxItems !== undefined && val.length > maxItems) {
                    issues.push({
                        path,
                        code: 'ARRAY_TOO_LONG',
                        message: `Array must contain at most ${maxItems} item(s)`,
                    });
                    valid = false;
                }

                const out = [];
                const seenHashes = uniqueItems ? new Set() : null;

                for (let i = 0; i < val.length; i += 1) {
                    const itemPath = `${path}[${i}]`;
                    const itemRes = evaluateAnySchema(itemSchema, val[i], itemPath, ctx, issues);
                    if (!itemRes.valid) {
                        valid = false;
                    } else {
                        out.push(itemRes.value);
                        if (seenHashes) {
                            const key = canonicalSerialize(itemRes.value);
                            if (seenHashes.has(key)) {
                                issues.push({
                                    path: itemPath,
                                    code: 'DUPLICATE_ARRAY_ITEM',
                                    message: 'Array items must be unique',
                                });
                                valid = false;
                            } else {
                                seenHashes.add(key);
                            }
                        }
                    }
                }

                return { valid, value: valid ? out : undefined };
            },
            () => ({
                type: 'array',
                items: toJsonSchema(itemSchema),
                ...(minItems !== undefined ? { minItems } : {}),
                ...(maxItems !== undefined ? { maxItems } : {}),
                ...(uniqueItems ? { uniqueItems: true } : {}),
                ...(hasDefault ? { default: cloneSafeValue(defaultValue) } : {}),
                ...(description !== undefined ? { description: String(description) } : {}),
            })
        );
    },

    /**
     * Prototype-pollution-safe structured object schema builder.
     */
    object(shape = {}, opts = {}) {
        if (!isPlainObject(shape)) {
            throw new TypeError('s.object "shape" must be a plain object mapping field names to schemas');
        }
        const safeOpts = opts && typeof opts === 'object' ? opts : {};
        const { strict = false, stripUnknown, description } = safeOpts;
        const hasDefault = hasOwn(safeOpts, 'default') && safeOpts.default !== undefined;
        const defaultValue = hasDefault ? safeOpts.default : undefined;

        const shapeEntries = [];
        const shapeKeySet = new Set();
        for (const key of Object.keys(shape)) {
            if (FORBIDDEN_KEYS.has(key)) continue;
            const fieldSchema = shape[key];
            assertValidSchemaInput(fieldSchema, `s.object field "${key}"`);
            shapeEntries.push([key, fieldSchema]);
            shapeKeySet.add(key);
        }

        return createSchemaNode(
            { kind: 'object', hasDefault },
            (rawVal, path, ctx, issues) => {
                const val = rawVal === undefined && hasDefault ? cloneSchemaDefault(defaultValue) : rawVal;

                if (!isPlainObject(val)) {
                    issues.push({
                        path,
                        code: 'INVALID_TYPE',
                        message: 'Expected plain object',
                    });
                    return { valid: false, value: undefined };
                }

                let valid = true;
                const out = {};

                for (const [key, fieldSchema] of shapeEntries) {
                    const propPresent = hasOwn(val, key);
                    const rawPropVal = propPresent ? val[key] : undefined;
                    const fieldPath = path ? `${path}.${key}` : key;

                    if (rawPropVal === undefined) {
                        if (isOptionalSchemaNode(fieldSchema) || (!isKruschSchema(fieldSchema) && typeof fieldSchema?.safeParse === 'function')) {
                            const optRes = evaluateAnySchema(fieldSchema, undefined, fieldPath, ctx, issues);
                            if (!optRes.valid) {
                                valid = false;
                            } else if (optRes.value !== undefined) {
                                defineSafeProperty(out, key, optRes.value);
                            }
                        } else {
                            issues.push({
                                path: fieldPath,
                                code: 'REQUIRED',
                                message: `Missing required field "${key}"`,
                            });
                            valid = false;
                        }
                    } else {
                        const fieldRes = evaluateAnySchema(fieldSchema, rawPropVal, fieldPath, ctx, issues);
                        if (!fieldRes.valid) {
                            valid = false;
                        } else if (fieldRes.value !== undefined) {
                            defineSafeProperty(out, key, fieldRes.value);
                        }
                    }
                }

                const effectiveStripUnknown =
                    stripUnknown !== undefined ? Boolean(stripUnknown) : Boolean(ctx.stripUnknown);

                for (const key of Object.keys(val)) {
                    if (shapeKeySet.has(key)) continue;
                    const unknownPath = path ? `${path}.${key}` : key;

                    if (FORBIDDEN_KEYS.has(key)) {
                        if (strict) {
                            issues.push({
                                path: unknownPath,
                                code: 'UNKNOWN_KEY',
                                message: `Unknown or forbidden field "${key}"`,
                            });
                            valid = false;
                        }
                        continue;
                    }

                    if (strict) {
                        issues.push({
                            path: unknownPath,
                            code: 'UNKNOWN_KEY',
                            message: `Unknown field "${key}"`,
                        });
                        valid = false;
                    } else if (!effectiveStripUnknown) {
                        const clonedExtra = cloneSafeValue(val[key]);
                        const extraIssues = collectNumericAndCoercionIssues(
                            val[key],
                            clonedExtra,
                            unknownPath,
                            false
                        );
                        if (extraIssues.length > 0) {
                            issues.push(...extraIssues);
                            valid = false;
                        } else {
                            defineSafeProperty(out, key, clonedExtra);
                        }
                    }
                }

                return { valid, value: valid ? out : undefined };
            },
            () => {
                const properties = {};
                const required = [];
                for (const [key, fieldSchema] of shapeEntries) {
                    defineSafeProperty(properties, key, toJsonSchema(fieldSchema));
                    if (!isOptionalSchemaNode(fieldSchema)) {
                        required.push(key);
                    }
                }
                return {
                    type: 'object',
                    properties,
                    required,
                    additionalProperties: !strict,
                    ...(hasDefault ? { default: cloneSafeValue(defaultValue) } : {}),
                    ...(description !== undefined ? { description: String(description) } : {}),
                };
            }
        );
    },

    /**
     * Bounded dictionary record schema (`Record<string, V>`) rejecting `__proto__`, `constructor`, and `prototype`.
     */
    record(valueSchema, opts = {}) {
        assertValidSchemaInput(valueSchema, 's.record');
        const safeOpts = opts && typeof opts === 'object' ? opts : {};
        const { maxKeys = 256, description } = safeOpts;

        if (typeof maxKeys !== 'number' || !Number.isFinite(maxKeys) || maxKeys < 1) {
            throw new TypeError('s.record "maxKeys" must be a positive integer');
        }
        const safeMaxKeys = Math.trunc(maxKeys);

        return createSchemaNode(
            { kind: 'record', hasDefault: false },
            (val, path, ctx, issues) => {
                if (!isPlainObject(val)) {
                    issues.push({
                        path,
                        code: 'INVALID_TYPE',
                        message: 'Expected plain object record',
                    });
                    return { valid: false, value: undefined };
                }

                const ownNames = Object.getOwnPropertyNames(val);
                const keys = Object.keys(val);
                for (const name of ownNames) {
                    if (FORBIDDEN_KEYS.has(name) && !keys.includes(name)) {
                        keys.push(name);
                    }
                }

                if (keys.length > safeMaxKeys) {
                    issues.push({
                        path,
                        code: 'TOO_MANY_KEYS',
                        message: `Record exceeds maximum key count of ${safeMaxKeys}`,
                    });
                    return { valid: false, value: undefined };
                }

                let valid = true;
                const out = {};
                for (const key of keys) {
                    const entryPath = path ? `${path}.${key}` : key;
                    if (FORBIDDEN_KEYS.has(key)) {
                        issues.push({
                            path: entryPath,
                            code: 'FORBIDDEN_KEY',
                            message: `Forbidden record key "${key}"`,
                        });
                        valid = false;
                        continue;
                    }
                    const itemRes = evaluateAnySchema(valueSchema, val[key], entryPath, ctx, issues);
                    if (!itemRes.valid) {
                        valid = false;
                    } else {
                        defineSafeProperty(out, key, itemRes.value);
                    }
                }

                return { valid, value: valid ? out : undefined };
            },
            () => ({
                type: 'object',
                additionalProperties: toJsonSchema(valueSchema),
                maxProperties: safeMaxKeys,
                ...(description !== undefined ? { description: String(description) } : {}),
            })
        );
    },

    /**
     * Union schema builder (`anyOf`) evaluating branches deterministically in declaration order.
     */
    union(schemas, opts = {}) {
        if (!Array.isArray(schemas) || schemas.length === 0) {
            throw new TypeError('s.union requires a non-empty array of schemas');
        }
        for (const branch of schemas) {
            assertValidSchemaInput(branch, 's.union');
        }
        const frozenBranches = Object.freeze([...schemas]);
        const safeOpts = opts && typeof opts === 'object' ? opts : {};
        const { description } = safeOpts;

        return createSchemaNode(
            { kind: 'union', hasDefault: false, branches: frozenBranches },
            (val, path, ctx, issues) => {
                // When coerce is enabled, attempt exact non-coerced match first so native types bind to their exact branch.
                if (ctx.coerce) {
                    const strictCtx = { ...ctx, coerce: false };
                    for (const branch of frozenBranches) {
                        const branchIssues = [];
                        const res = evaluateAnySchema(branch, val, path, strictCtx, branchIssues);
                        if (res.valid && branchIssues.length === 0) {
                            return { valid: true, value: res.value };
                        }
                    }
                }

                for (const branch of frozenBranches) {
                    const branchIssues = [];
                    const res = evaluateAnySchema(branch, val, path, ctx, branchIssues);
                    if (res.valid && branchIssues.length === 0) {
                        return { valid: true, value: res.value };
                    }
                }

                issues.push({
                    path,
                    code: 'UNION_MISMATCH',
                    message: 'Value did not match any union schema branch',
                });
                return { valid: false, value: undefined };
            },
            () => ({
                anyOf: frozenBranches.map((branch) => toJsonSchema(branch)),
                ...(description !== undefined ? { description: String(description) } : {}),
            })
        );
    },

    /**
     * Optional schema wrapper (`T | undefined`).
     */
    optional(innerSchema) {
        return createOptionalNode(innerSchema);
    },

    /**
     * Nullable schema wrapper (`T | null`).
     */
    nullable(innerSchema) {
        return createNullableNode(innerSchema);
    },

    /**
     * Pass-through schema node accepting any non-circular, depth-bounded value while sanitizing forbidden own keys.
     */
    any(opts = {}) {
        const safeOpts = opts && typeof opts === 'object' ? opts : {};
        const { description } = safeOpts;

        return createSchemaNode(
            { kind: 'any', hasDefault: false },
            (val, path, _ctx, issues) => {
                const cloned = cloneSafeValue(val);
                const numericIssues = collectNumericAndCoercionIssues(val, cloned, path, false);
                if (numericIssues.length > 0) {
                    issues.push(...numericIssues);
                    return { valid: false, value: undefined };
                }
                return {
                    valid: true,
                    value: cloned,
                };
            },
            () => (description !== undefined ? { description: String(description) } : {})
        );
    },
});

// ============================================================================
// Raw JSON Schema Draft-7 / 2020-12 Compiler & Evaluator
// ============================================================================

/**
 * Normalize a JSON Schema compiled from an external Zod v3/v4 schema by stripping `$schema`
 * and ensuring structured `{ type: 'object' }` schemas expose `properties`, `required`, and `additionalProperties`.
 *
 * @param {Record<string, any>} node - Cloned JSON Schema object
 * @param {WeakSet<object>} [seen] - Cycle guard
 * @returns {Record<string, any>}
 */
function normalizeZodCompiledJsonSchema(node, seen = new WeakSet()) {
    if (!isPlainObject(node) || seen.has(node)) return node;
    seen.add(node);

    const out = {};
    for (const key of Object.keys(node)) {
        if (key === '$schema' || FORBIDDEN_KEYS.has(key)) continue;
        const val = node[key];
        if (key === 'properties' && isPlainObject(val)) {
            const props = {};
            for (const propKey of Object.keys(val)) {
                if (FORBIDDEN_KEYS.has(propKey)) continue;
                defineSafeProperty(
                    props,
                    propKey,
                    isPlainObject(val[propKey])
                        ? normalizeZodCompiledJsonSchema(val[propKey], seen)
                        : val[propKey]
                );
            }
            defineSafeProperty(out, 'properties', props);
        } else if (key === 'items' && isPlainObject(val)) {
            defineSafeProperty(out, 'items', normalizeZodCompiledJsonSchema(val, seen));
        } else if (key === 'additionalProperties' && isPlainObject(val)) {
            defineSafeProperty(
                out,
                'additionalProperties',
                normalizeZodCompiledJsonSchema(val, seen)
            );
        } else if ((key === 'anyOf' || key === 'oneOf' || key === 'allOf') && Array.isArray(val)) {
            defineSafeProperty(
                out,
                key,
                val.map((b) => (isPlainObject(b) ? normalizeZodCompiledJsonSchema(b, seen) : b))
            );
        } else {
            defineSafeProperty(out, key, val);
        }
    }

    if (out.type === 'object' && !isPlainObject(out.additionalProperties)) {
        if (!isPlainObject(out.properties)) {
            defineSafeProperty(out, 'properties', {});
        }
        const rawRequired = Array.isArray(out.required) ? out.required : [];
        defineSafeProperty(
            out,
            'required',
            rawRequired.filter(
                (reqKey) =>
                    !(
                        isPlainObject(out.properties[reqKey]) &&
                        hasOwn(out.properties[reqKey], 'default') &&
                        out.properties[reqKey].default !== undefined
                    )
            )
        );
        if (typeof out.additionalProperties !== 'boolean') {
            defineSafeProperty(out, 'additionalProperties', true);
        }
    }

    seen.delete(node);
    return out;
}

/**
 * Compile an external `ZodLikeSchema` (Zod v4 `.toJSONSchema()`, Zod v3/v4 `_def`/`def` AST,
 * or minimal duck-typed `{ safeParse }` object) into a prototype-safe JSON Schema object.
 *
 * @param {Record<string, any>} schema - External schema object
 * @param {WeakSet<object>} [seen] - Cycle guard
 * @param {number} [depth=0] - Recursion depth guard
 * @returns {Record<string, unknown>}
 */
function compileExternalSchemaToJsonSchema(schema, seen = new WeakSet(), depth = 0) {
    if (!schema || typeof schema !== 'object' || depth > MAX_SCHEMA_RECURSION_DEPTH || seen.has(schema)) {
        return {};
    }

    if (typeof schema.toJsonSchema === 'function') {
        const compiled = schema.toJsonSchema();
        if (!isPlainObject(compiled)) {
            throw new TypeError('Invalid schema passed to toJsonSchema');
        }
        return cloneSafeValue(compiled);
    }

    if (typeof schema.toJSONSchema === 'function') {
        try {
            const compiled = schema.toJSONSchema({ io: 'input' });
            if (isPlainObject(compiled)) {
                return normalizeZodCompiledJsonSchema(cloneSafeValue(compiled));
            }
        } catch {
            try {
                const compiledFallback = schema.toJSONSchema();
                if (isPlainObject(compiledFallback)) {
                    return normalizeZodCompiledJsonSchema(cloneSafeValue(compiledFallback));
                }
            } catch {
                // Fall through to _def / def structural introspection (e.g. Zod transforms/effects)
            }
        }
    }

    const def = schema._def || schema.def;
    const description =
        typeof schema.description === 'string'
            ? schema.description
            : def && typeof def === 'object' && typeof def.description === 'string'
              ? def.description
              : undefined;

    if (!def || typeof def !== 'object') {
        return description !== undefined ? { description } : {};
    }

    seen.add(schema);
    try {
        const typeName = String(def.typeName || def.type || '');
        const descProp = description !== undefined ? { description } : {};

        if (typeName === 'ZodString' || typeName === 'string') {
            const out = { type: 'string', ...descProp };
            if (Array.isArray(def.checks)) {
                for (const chk of def.checks) {
                    const kind = chk?.kind || chk?._zod?.def?.check;
                    if (kind === 'min' && typeof chk.value === 'number') out.minLength = chk.value;
                    else if (kind === 'max' && typeof chk.value === 'number') out.maxLength = chk.value;
                    else if (kind === 'email') out.format = 'email';
                    else if (kind === 'uuid') out.format = 'uuid';
                    else if (kind === 'url') out.format = 'url';
                }
            }
            return out;
        }

        if (typeName === 'ZodNumber' || typeName === 'number' || typeName === 'int') {
            let isInt = typeName === 'int' || Boolean(def.isInt);
            let minimum;
            let maximum;
            if (Array.isArray(def.checks)) {
                for (const chk of def.checks) {
                    if (chk?.kind === 'int' || chk?.isInt) isInt = true;
                    else if (chk?.kind === 'min' && typeof chk.value === 'number' && chk.inclusive !== false) {
                        minimum = chk.value;
                    } else if (chk?.kind === 'max' && typeof chk.value === 'number' && chk.inclusive !== false) {
                        maximum = chk.value;
                    }
                }
            }
            return {
                type: isInt ? 'integer' : 'number',
                ...(minimum !== undefined ? { minimum } : {}),
                ...(maximum !== undefined ? { maximum } : {}),
                ...descProp,
            };
        }

        if (typeName === 'ZodBoolean' || typeName === 'boolean') {
            return { type: 'boolean', ...descProp };
        }

        if (typeName === 'ZodNull' || typeName === 'null') {
            return { type: 'null', ...descProp };
        }

        if (typeName === 'ZodLiteral' || typeName === 'literal') {
            const vals = Array.isArray(def.values) ? def.values : [def.value];
            if (vals.length === 1) {
                return { const: cloneSafeValue(vals[0]), ...descProp };
            }
            return { enum: vals.map((v) => cloneSafeValue(v)), ...descProp };
        }

        if (typeName === 'ZodEnum' || typeName === 'ZodNativeEnum' || typeName === 'enum') {
            const rawVals = Array.isArray(def.values)
                ? def.values
                : isPlainObject(def.entries)
                  ? Object.values(def.entries)
                  : isPlainObject(def.values)
                    ? Object.values(def.values)
                    : [];
            return { enum: rawVals.map((v) => cloneSafeValue(v)), ...descProp };
        }

        if (typeName === 'ZodArray' || typeName === 'array') {
            const inner = def.type || def.element;
            return {
                type: 'array',
                items: inner ? compileExternalSchemaToJsonSchema(inner, seen, depth + 1) : {},
                ...(typeof def.minLength?.value === 'number' ? { minItems: def.minLength.value } : {}),
                ...(typeof def.maxLength?.value === 'number' ? { maxItems: def.maxLength.value } : {}),
                ...descProp,
            };
        }

        if (typeName === 'ZodObject' || typeName === 'object') {
            const rawShape = typeof def.shape === 'function' ? def.shape() : def.shape;
            const properties = {};
            const required = [];
            if (rawShape && typeof rawShape === 'object') {
                for (const key of Object.keys(rawShape)) {
                    if (FORBIDDEN_KEYS.has(key)) continue;
                    const fieldSchema = rawShape[key];
                    defineSafeProperty(
                        properties,
                        key,
                        compileExternalSchemaToJsonSchema(fieldSchema, seen, depth + 1)
                    );
                    if (!isOptionalSchemaNode(fieldSchema)) {
                        required.push(key);
                    }
                }
            }
            const isStrict =
                def.unknownKeys === 'strict' ||
                def.catchall?._def?.typeName === 'ZodNever' ||
                def.catchall?.def?.type === 'never';
            return {
                type: 'object',
                properties,
                required,
                additionalProperties: !isStrict,
                ...descProp,
            };
        }

        if (typeName === 'ZodRecord' || typeName === 'record') {
            const valType = def.valueType || def.values;
            return {
                type: 'object',
                additionalProperties: valType
                    ? compileExternalSchemaToJsonSchema(valType, seen, depth + 1)
                    : {},
                ...descProp,
            };
        }

        if (
            typeName === 'ZodUnion' ||
            typeName === 'ZodDiscriminatedUnion' ||
            typeName === 'union'
        ) {
            const rawOptions = Array.isArray(def.options)
                ? def.options
                : def.options instanceof Map
                  ? [...def.options.values()]
                  : [];
            return {
                anyOf: rawOptions.map((opt) =>
                    compileExternalSchemaToJsonSchema(opt, seen, depth + 1)
                ),
                ...descProp,
            };
        }

        if (typeName === 'ZodOptional' || typeName === 'optional') {
            const innerJson = def.innerType
                ? compileExternalSchemaToJsonSchema(def.innerType, seen, depth + 1)
                : {};
            return { ...innerJson, ...descProp };
        }

        if (typeName === 'ZodDefault' || typeName === 'default') {
            const innerJson = def.innerType
                ? compileExternalSchemaToJsonSchema(def.innerType, seen, depth + 1)
                : {};
            let defaultVal;
            try {
                defaultVal =
                    typeof def.defaultValue === 'function' ? def.defaultValue() : def.defaultValue;
            } catch {
                defaultVal = undefined;
            }
            return {
                ...innerJson,
                ...(defaultVal !== undefined ? { default: cloneSafeValue(defaultVal) } : {}),
                ...descProp,
            };
        }

        if (typeName === 'ZodNullable' || typeName === 'nullable') {
            const innerJson = def.innerType
                ? compileExternalSchemaToJsonSchema(def.innerType, seen, depth + 1)
                : {};
            if (typeof innerJson.type === 'string') {
                const nextType = innerJson.type === 'null' ? 'null' : [innerJson.type, 'null'];
                return { ...innerJson, type: nextType, ...descProp };
            }
            if (Array.isArray(innerJson.type)) {
                return {
                    ...innerJson,
                    type: innerJson.type.includes('null')
                        ? [...innerJson.type]
                        : [...innerJson.type, 'null'],
                    ...descProp,
                };
            }
            return { anyOf: [innerJson, { type: 'null' }], ...descProp };
        }

        const unwrapped = def.schema || def.in || def.innerType || def.out;
        if (unwrapped && typeof unwrapped === 'object') {
            const innerJson = compileExternalSchemaToJsonSchema(unwrapped, seen, depth + 1);
            return { ...innerJson, ...descProp };
        }

        return { ...descProp };
    } finally {
        seen.delete(schema);
    }
}

/**
 * Compile any `s.*` builder node, `ZodLikeSchema` (Zod v3/v4 or `{ safeParse }`), or plain JSON Schema
 * object into a clean, prototype-safe JSON Schema Draft-7/2020-12 plain object suitable for MCP `inputSchema`.
 *
 * @param {object} schema - `s.*` builder node, Zod schema, or plain JSON Schema object
 * @returns {Record<string, unknown>}
 */
export function toJsonSchema(schema) {
    if (!schema || typeof schema !== 'object') {
        throw new TypeError('Invalid schema passed to toJsonSchema');
    }
    try {
        if (Array.isArray(schema)) {
            throw new TypeError('Invalid schema passed to toJsonSchema');
        }
        if (typeof schema.toJsonSchema === 'function') {
            const compiled = schema.toJsonSchema();
            if (!isPlainObject(compiled)) {
                throw new TypeError('Invalid schema passed to toJsonSchema');
            }
            return cloneSafeValue(compiled);
        }
        if (typeof schema.safeParse === 'function' || typeof schema.toJSONSchema === 'function') {
            return compileExternalSchemaToJsonSchema(schema, new WeakSet(), 0);
        }
        if (isPlainObject(schema) && isValidRawJsonSchemaObject(schema)) {
            return cloneSafeValue(schema);
        }
    } catch (err) {
        if (err instanceof TypeError) {
            throw err;
        }
        throw new TypeError('Invalid schema passed to toJsonSchema');
    }
    throw new TypeError('Invalid schema passed to toJsonSchema');
}

const RAW_JSON_SCHEMA_FINITE_NUM_KEYWORDS = [
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'exclusiveMaximum',
];
const RAW_JSON_SCHEMA_NON_NEG_INT_KEYWORDS = [
    'minLength',
    'maxLength',
    'minItems',
    'maxItems',
    'minProperties',
    'maxProperties',
];

/**
 * Check structural validity of a raw JSON Schema object before evaluation.
 *
 * @param {unknown} schema - Candidate raw JSON Schema
 * @param {WeakSet<object>} [seen] - Cycle guard for schema graph
 * @param {number} [depth=0] - Recursion depth
 * @returns {boolean}
 */
function isValidRawJsonSchemaObject(schema, seen = new WeakSet(), depth = 0) {
    if (depth > MAX_SCHEMA_RECURSION_DEPTH) return false;
    if (!isPlainObject(schema)) return false;
    if (
        isKruschSchema(schema) ||
        typeof schema.safeParse === 'function' ||
        typeof schema.toJsonSchema === 'function' ||
        typeof schema.toJSONSchema === 'function'
    ) {
        return false;
    }
    if (seen.has(schema)) return false;

    for (const ownKey of Object.keys(schema)) {
        if (FORBIDDEN_KEYS.has(ownKey)) continue;
        const ownVal = schema[ownKey];
        if (typeof ownVal === 'function') return false;
        if (
            ownVal &&
            typeof ownVal === 'object' &&
            (isKruschSchema(ownVal) ||
                typeof ownVal.safeParse === 'function' ||
                typeof ownVal.toJsonSchema === 'function' ||
                typeof ownVal.toJSONSchema === 'function')
        ) {
            return false;
        }
    }

    if (schema.type !== undefined) {
        if (typeof schema.type === 'string') {
            if (!ALLOWED_JSON_SCHEMA_TYPES.has(schema.type)) return false;
        } else if (Array.isArray(schema.type)) {
            if (schema.type.length === 0) return false;
            for (const t of schema.type) {
                if (typeof t !== 'string' || !ALLOWED_JSON_SCHEMA_TYPES.has(t)) return false;
            }
        } else {
            return false;
        }
    }

    if (schema.properties !== undefined && !isPlainObject(schema.properties)) {
        return false;
    }
    if (
        schema.required !== undefined &&
        (!Array.isArray(schema.required) || !schema.required.every((k) => typeof k === 'string'))
    ) {
        return false;
    }
    if (schema.items !== undefined && !isPlainObject(schema.items)) {
        return false;
    }
    if (
        schema.additionalProperties !== undefined &&
        typeof schema.additionalProperties !== 'boolean' &&
        !isPlainObject(schema.additionalProperties)
    ) {
        return false;
    }
    if (schema.enum !== undefined && !Array.isArray(schema.enum)) {
        return false;
    }
    if (schema.anyOf !== undefined && (!Array.isArray(schema.anyOf) || schema.anyOf.length === 0)) {
        return false;
    }
    if (schema.oneOf !== undefined && (!Array.isArray(schema.oneOf) || schema.oneOf.length === 0)) {
        return false;
    }

    for (const numKw of RAW_JSON_SCHEMA_FINITE_NUM_KEYWORDS) {
        if (
            schema[numKw] !== undefined &&
            (typeof schema[numKw] !== 'number' || !Number.isFinite(schema[numKw]))
        ) {
            return false;
        }
    }
    for (const intKw of RAW_JSON_SCHEMA_NON_NEG_INT_KEYWORDS) {
        if (
            schema[intKw] !== undefined &&
            (typeof schema[intKw] !== 'number' ||
                !Number.isInteger(schema[intKw]) ||
                schema[intKw] < 0)
        ) {
            return false;
        }
    }
    if (schema.uniqueItems !== undefined && typeof schema.uniqueItems !== 'boolean') {
        return false;
    }
    if (schema.format !== undefined && typeof schema.format !== 'string') {
        return false;
    }
    if (schema.pattern !== undefined && typeof schema.pattern !== 'string') {
        return false;
    }

    seen.add(schema);
    try {
        if (schema.properties) {
            for (const key of Object.keys(schema.properties)) {
                if (FORBIDDEN_KEYS.has(key)) continue;
                if (!isValidRawJsonSchemaObject(schema.properties[key], seen, depth + 1)) {
                    return false;
                }
            }
        }
        if (schema.items && !isValidRawJsonSchemaObject(schema.items, seen, depth + 1)) {
            return false;
        }
        if (
            isPlainObject(schema.additionalProperties) &&
            !isValidRawJsonSchemaObject(schema.additionalProperties, seen, depth + 1)
        ) {
            return false;
        }
        if (schema.anyOf) {
            for (const branch of schema.anyOf) {
                if (!isValidRawJsonSchemaObject(branch, seen, depth + 1)) return false;
            }
        }
        if (schema.oneOf) {
            for (const branch of schema.oneOf) {
                if (!isValidRawJsonSchemaObject(branch, seen, depth + 1)) return false;
            }
        }
        return true;
    } finally {
        seen.delete(schema);
    }
}

/**
 * Check whether `val` matches a single JSON Schema primitive/structural `type` token (with optional coercion).
 *
 * @param {string} expectedType - JSON Schema `type` name
 * @param {unknown} rawVal - Input value
 * @param {boolean} coerce - Whether conservative scalar coercion is enabled
 * @returns {{ matched: boolean, coercedValue: unknown }}
 */
function matchJsonSchemaType(expectedType, rawVal, coerce) {
    let val = rawVal;
    switch (expectedType) {
        case 'null':
            return { matched: val === null, coercedValue: null };
        case 'boolean':
            if (coerce && typeof val === 'string') {
                const norm = val.trim().toLowerCase();
                if (norm === 'true' || norm === '1') val = true;
                else if (norm === 'false' || norm === '0') val = false;
            }
            return { matched: typeof val === 'boolean', coercedValue: val };
        case 'integer':
            if (coerce && typeof val === 'string') {
                const trimmed = val.trim();
                if (trimmed.length > 0) {
                    const parsed = Number(trimmed);
                    if (Number.isFinite(parsed) && Number.isInteger(parsed)) val = parsed;
                }
            }
            return {
                matched: typeof val === 'number' && Number.isFinite(val) && Number.isInteger(val),
                coercedValue: Object.is(val, -0) ? 0 : val,
            };
        case 'number':
            if (coerce && typeof val === 'string') {
                const trimmed = val.trim();
                if (trimmed.length > 0) {
                    const parsed = Number(trimmed);
                    if (Number.isFinite(parsed)) val = parsed;
                }
            }
            return {
                matched: typeof val === 'number' && Number.isFinite(val),
                coercedValue: Object.is(val, -0) ? 0 : val,
            };
        case 'string':
            if (typeof val !== 'string' && coerce) {
                if ((typeof val === 'number' && Number.isFinite(val)) || typeof val === 'boolean') {
                    val = String(val);
                }
            }
            return { matched: typeof val === 'string', coercedValue: val };
        case 'array':
            return { matched: Array.isArray(val), coercedValue: val };
        case 'object':
            return { matched: isPlainObject(val), coercedValue: val };
        default:
            return { matched: false, coercedValue: val };
    }
}

/**
 * Evaluate a raw JSON Schema Draft-7/2020-12 object against `rawVal`.
 *
 * @param {Record<string, any>} schema - Raw JSON Schema object
 * @param {unknown} rawVal - Input value
 * @param {string} path - Dot/bracket path
 * @param {object} ctx - Validation context
 * @param {Array<object>} issues - Mutable issue accumulator
 * @param {number} [schemaDepth=0] - Schema recursion depth guard
 * @returns {{ valid: boolean, value: unknown }}
 */
function evaluateRawJsonSchema(schema, rawVal, path, ctx, issues, schemaDepth = 0) {
    if (schemaDepth > MAX_SCHEMA_RECURSION_DEPTH) {
        issues.push({
            path,
            code: 'SCHEMA_MAX_DEPTH',
            message: 'Schema definition exceeded maximum recursion depth',
        });
        return { valid: false, value: undefined };
    }

    let val =
        rawVal === undefined &&
        hasOwn(schema, 'default') &&
        schema.default !== undefined &&
        typeof schema.default !== 'function'
            ? cloneSchemaDefault(schema.default)
            : rawVal;

    // 1. Combinators (`anyOf` / `oneOf`)
    if (Array.isArray(schema.anyOf)) {
        let matched = false;
        let matchedValue = undefined;
        for (const branch of schema.anyOf) {
            const subIssues = [];
            const subRes = evaluateRawJsonSchema(branch, val, path, ctx, subIssues, schemaDepth + 1);
            if (subRes.valid && subIssues.length === 0) {
                matched = true;
                matchedValue = subRes.value;
                break;
            }
        }
        if (!matched) {
            issues.push({
                path,
                code: 'UNION_MISMATCH',
                message: 'Value did not match any schema in anyOf',
            });
            return { valid: false, value: undefined };
        }
        val = matchedValue;
    }

    if (Array.isArray(schema.oneOf)) {
        let matchCount = 0;
        let matchedValue = undefined;
        for (const branch of schema.oneOf) {
            const subIssues = [];
            const subRes = evaluateRawJsonSchema(branch, val, path, ctx, subIssues, schemaDepth + 1);
            if (subRes.valid && subIssues.length === 0) {
                matchCount += 1;
                if (matchCount === 1) {
                    matchedValue = subRes.value;
                }
            }
        }
        if (matchCount === 0) {
            issues.push({
                path,
                code: 'UNION_MISMATCH',
                message: 'Value did not match any schema in oneOf',
            });
            return { valid: false, value: undefined };
        }
        if (matchCount > 1) {
            issues.push({
                path,
                code: 'ONEOF_MULTIPLE_MATCHES',
                message: 'Value matched multiple schemas in oneOf',
            });
            return { valid: false, value: undefined };
        }
        val = matchedValue;
    }

    // 2. `const` and `enum`
    if (hasOwn(schema, 'const') && !Object.is(val, schema.const)) {
        issues.push({
            path,
            code: 'INVALID_LITERAL',
            message: `Expected constant ${JSON.stringify(schema.const)}`,
        });
        return { valid: false, value: undefined };
    }

    if (Array.isArray(schema.enum)) {
        const matchedEnum = schema.enum.some((entry) => Object.is(val, entry));
        if (!matchedEnum) {
            issues.push({
                path,
                code: 'INVALID_ENUM',
                message: `Expected one of: ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}`,
            });
            return { valid: false, value: undefined };
        }
    }

    // 3. `type` check
    if (schema.type !== undefined) {
        const allowedTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
        let typeMatched = false;
        if (ctx.coerce && allowedTypes.length > 1) {
            for (const t of allowedTypes) {
                const strictTry = matchJsonSchemaType(t, val, false);
                if (strictTry.matched) {
                    val = strictTry.coercedValue;
                    typeMatched = true;
                    break;
                }
            }
        }
        if (!typeMatched) {
            for (const t of allowedTypes) {
                const attempt = matchJsonSchemaType(t, val, ctx.coerce);
                if (attempt.matched) {
                    val = attempt.coercedValue;
                    typeMatched = true;
                    break;
                }
            }
        }
        if (!typeMatched) {
            issues.push({
                path,
                code: 'INVALID_TYPE',
                message: `Expected type ${allowedTypes.join(' | ')}`,
            });
            return { valid: false, value: undefined };
        }
    }

    let valid = true;

    // 4. String constraints
    if (typeof val === 'string') {
        if (typeof schema.minLength === 'number' && val.length < schema.minLength) {
            issues.push({
                path,
                code: 'STRING_TOO_SHORT',
                message: `String length must be at least ${schema.minLength}`,
            });
            valid = false;
        }
        if (typeof schema.maxLength === 'number' && val.length > schema.maxLength) {
            issues.push({
                path,
                code: 'STRING_TOO_LONG',
                message: `String length must be at most ${schema.maxLength}`,
            });
            valid = false;
        }
        if (typeof schema.pattern === 'string') {
            try {
                const rx = new RegExp(schema.pattern);
                if (!rx.test(val)) {
                    issues.push({
                        path,
                        code: 'INVALID_PATTERN',
                        message: 'String does not match required pattern',
                    });
                    valid = false;
                }
            } catch {
                issues.push({
                    path,
                    code: 'INVALID_PATTERN',
                    message: 'Schema pattern is not a valid regular expression',
                });
                valid = false;
            }
        }
        if (typeof schema.format === 'string' && ALLOWED_FORMATS.has(schema.format)) {
            if (!isValidStringFormat(schema.format, val)) {
                issues.push({
                    path,
                    code: 'INVALID_FORMAT',
                    message: `Invalid ${schema.format} format`,
                });
                valid = false;
            }
        }
        return { valid, value: valid ? val : undefined };
    }

    // 5. Numeric constraints
    if (typeof val === 'number') {
        if (!Number.isFinite(val)) {
            issues.push({
                path,
                code: 'INVALID_TYPE',
                message: 'Expected finite number (not NaN or Infinity)',
            });
            return { valid: false, value: undefined };
        }
        if (typeof schema.minimum === 'number' && val < schema.minimum) {
            issues.push({
                path,
                code: 'NUMBER_TOO_SMALL',
                message: `Number must be >= ${schema.minimum}`,
            });
            valid = false;
        }
        if (typeof schema.maximum === 'number' && val > schema.maximum) {
            issues.push({
                path,
                code: 'NUMBER_TOO_LARGE',
                message: `Number must be <= ${schema.maximum}`,
            });
            valid = false;
        }
        if (typeof schema.exclusiveMinimum === 'number' && val <= schema.exclusiveMinimum) {
            issues.push({
                path,
                code: 'NUMBER_TOO_SMALL',
                message: `Number must be > ${schema.exclusiveMinimum}`,
            });
            valid = false;
        }
        if (typeof schema.exclusiveMaximum === 'number' && val >= schema.exclusiveMaximum) {
            issues.push({
                path,
                code: 'NUMBER_TOO_LARGE',
                message: `Number must be < ${schema.exclusiveMaximum}`,
            });
            valid = false;
        }
        return { valid, value: valid ? val : undefined };
    }

    // 6. Array constraints
    if (Array.isArray(val)) {
        if (typeof schema.minItems === 'number' && val.length < schema.minItems) {
            issues.push({
                path,
                code: 'ARRAY_TOO_SHORT',
                message: `Array must contain at least ${schema.minItems} item(s)`,
            });
            valid = false;
        }
        if (typeof schema.maxItems === 'number' && val.length > schema.maxItems) {
            issues.push({
                path,
                code: 'ARRAY_TOO_LONG',
                message: `Array must contain at most ${schema.maxItems} item(s)`,
            });
            valid = false;
        }

        const out = [];
        const seen = schema.uniqueItems ? new Set() : null;
        for (let i = 0; i < val.length; i += 1) {
            const itemPath = `${path}[${i}]`;
            const subSchema = isPlainObject(schema.items) ? schema.items : {};
            const subRes = evaluateRawJsonSchema(
                subSchema,
                val[i],
                itemPath,
                ctx,
                issues,
                schemaDepth + 1
            );
            if (!subRes.valid) {
                valid = false;
                continue;
            }
            const itemValue = subRes.value;
            out.push(itemValue);
            if (seen) {
                const hash = canonicalSerialize(itemValue);
                if (seen.has(hash)) {
                    issues.push({
                        path: itemPath,
                        code: 'DUPLICATE_ARRAY_ITEM',
                        message: 'Array items must be unique',
                    });
                    valid = false;
                } else {
                    seen.add(hash);
                }
            }
        }
        return { valid, value: valid ? out : undefined };
    }

    // 7. Object constraints
    if (isPlainObject(val)) {
        const props = isPlainObject(schema.properties) ? schema.properties : null;
        const propKeys = props ? new Set(Object.keys(props).filter((k) => !FORBIDDEN_KEYS.has(k))) : new Set();
        const requiredSet = new Set(
            Array.isArray(schema.required) ? schema.required.filter((k) => typeof k === 'string') : []
        );

        const ownKeys = Object.keys(val);
        if (typeof schema.maxProperties === 'number' && ownKeys.length > schema.maxProperties) {
            issues.push({
                path,
                code: 'TOO_MANY_KEYS',
                message: `Object exceeds maximum property count of ${schema.maxProperties}`,
            });
            return { valid: false, value: undefined };
        }
        if (typeof schema.minProperties === 'number' && ownKeys.length < schema.minProperties) {
            issues.push({
                path,
                code: 'TOO_FEW_KEYS',
                message: `Object must contain at least ${schema.minProperties} property(ies)`,
            });
            valid = false;
        }

        const out = {};

        // Check declared `required` keys first
        for (const reqKey of requiredSet) {
            if (FORBIDDEN_KEYS.has(reqKey)) continue;
            const hasProp = hasOwn(val, reqKey) && val[reqKey] !== undefined;
            const propSchema = props && hasOwn(props, reqKey) ? props[reqKey] : null;
            const hasPropDefault = Boolean(
                propSchema && isPlainObject(propSchema) && hasOwn(propSchema, 'default') && propSchema.default !== undefined
            );
            if (!hasProp && !hasPropDefault) {
                const reqPath = path ? `${path}.${reqKey}` : reqKey;
                issues.push({
                    path: reqPath,
                    code: 'REQUIRED',
                    message: `Missing required field "${reqKey}"`,
                });
                valid = false;
            }
        }

        // Validate declared `properties`
        if (props) {
            for (const key of propKeys) {
                const propSchema = props[key];
                const present = hasOwn(val, key) && val[key] !== undefined;
                const hasPropDefault =
                    isPlainObject(propSchema) &&
                    hasOwn(propSchema, 'default') &&
                    propSchema.default !== undefined;

                if (!present && !hasPropDefault) {
                    continue;
                }
                const fieldPath = path ? `${path}.${key}` : key;
                const subRes = evaluateRawJsonSchema(
                    propSchema,
                    present ? val[key] : undefined,
                    fieldPath,
                    ctx,
                    issues,
                    schemaDepth + 1
                );
                if (!subRes.valid) {
                    valid = false;
                } else if (subRes.value !== undefined) {
                    defineSafeProperty(out, key, subRes.value);
                }
            }
        }

        // Handle unknown / additional properties safely
        for (const key of ownKeys) {
            if (propKeys.has(key)) continue;
            const fieldPath = path ? `${path}.${key}` : key;

            if (FORBIDDEN_KEYS.has(key)) {
                if (schema.additionalProperties === false) {
                    issues.push({
                        path: fieldPath,
                        code: 'UNKNOWN_KEY',
                        message: `Unknown or forbidden field "${key}"`,
                    });
                    valid = false;
                } else if (isPlainObject(schema.additionalProperties)) {
                    issues.push({
                        path: fieldPath,
                        code: 'FORBIDDEN_KEY',
                        message: `Forbidden record key "${key}"`,
                    });
                    valid = false;
                }
                continue;
            }

            if (schema.additionalProperties === false) {
                issues.push({
                    path: fieldPath,
                    code: 'UNKNOWN_KEY',
                    message: `Unknown field "${key}"`,
                });
                valid = false;
            } else if (isPlainObject(schema.additionalProperties)) {
                const subRes = evaluateRawJsonSchema(
                    schema.additionalProperties,
                    val[key],
                    fieldPath,
                    ctx,
                    issues,
                    schemaDepth + 1
                );
                if (!subRes.valid) {
                    valid = false;
                } else {
                    defineSafeProperty(out, key, subRes.value);
                }
            } else if (!props || !ctx.stripUnknown) {
                const subRes = evaluateRawJsonSchema(
                    {},
                    val[key],
                    fieldPath,
                    ctx,
                    issues,
                    schemaDepth + 1
                );
                if (!subRes.valid) {
                    valid = false;
                } else {
                    defineSafeProperty(out, key, subRes.value);
                }
            }
        }

        return { valid, value: valid ? out : undefined };
    }

    const clonedFallback = valid ? cloneSafeValue(val) : undefined;
    if (valid) {
        const numericIssues = collectNumericAndCoercionIssues(val, clonedFallback, path, false);
        if (numericIssues.length > 0) {
            issues.push(...numericIssues);
            return { valid: false, value: undefined };
        }
    }
    return { valid, value: clonedFallback };
}

// ============================================================================
// Public Validation & Middleware Entrypoints
// ============================================================================

/**
 * Non-throwing universal schema validator accepting `@krusch/toolkit/schema` (`s.*`) builders,
 * duck-typed `zod` (`{ safeParse }`) schemas, and raw JSON Schema Draft-7/2020-12 objects.
 *
 * @param {object} schema - Schema builder, Zod schema, or JSON Schema object
 * @param {unknown} payload - Untrusted caller payload
 * @param {object} [options={}] - Validation options
 * @param {boolean} [options.coerce=false] - Enable conservative scalar coercion
 * @param {boolean} [options.stripUnknown=true] - Strip undeclared object properties
 * @param {number} [options.maxDepth=16] - Maximum allowed container nesting depth
 * @param {string} [options.tool='schema.validate'] - `INV-LEGO-01` tool identifier
 * @returns {{ ok: true, tool: string, summary: string, data: any } | { ok: false, tool: string, summary: string, error: { code: string, message: string, details?: any } }}
 */
export function validateSchema(schema, payload, options = {}) {
    const safeOptions = options && typeof options === 'object' ? options : {};
    const {
        coerce = false,
        stripUnknown = true,
        maxDepth = 16,
        tool = 'schema.validate',
    } = safeOptions;
    const invalidSchemaMsg =
        'Schema must be a valid schema builder, Zod schema, or JSON Schema object';
    if (!schema || typeof schema !== 'object') {
        return schemaErrorEnvelope(
            'INVALID_SCHEMA',
            invalidSchemaMsg,
            { issues: [{ path: '', code: 'INVALID_SCHEMA', message: invalidSchemaMsg }] },
            tool
        );
    }

    let isBuilder = false;
    let isZodLike = false;
    try {
        if (Array.isArray(schema)) {
            return schemaErrorEnvelope(
                'INVALID_SCHEMA',
                invalidSchemaMsg,
                { issues: [{ path: '', code: 'INVALID_SCHEMA', message: invalidSchemaMsg }] },
                tool
            );
        }
        isBuilder = isKruschSchema(schema);
        isZodLike = !isBuilder && typeof schema.safeParse === 'function';
        if (!isBuilder && !isZodLike && !isValidRawJsonSchemaObject(schema)) {
            return schemaErrorEnvelope(
                'INVALID_SCHEMA',
                invalidSchemaMsg,
                { issues: [{ path: '', code: 'INVALID_SCHEMA', message: invalidSchemaMsg }] },
                tool
            );
        }
    } catch {
        return schemaErrorEnvelope(
            'INVALID_SCHEMA',
            invalidSchemaMsg,
            { issues: [{ path: '', code: 'INVALID_SCHEMA', message: invalidSchemaMsg }] },
            tool
        );
    }

    const safeMaxDepth = normalizeMaxDepth(maxDepth);
    let graphErr = null;
    try {
        graphErr = inspectPayloadGraph(payload, safeMaxDepth);
    } catch (err) {
        const msg = err instanceof Error ? err.message : 'Payload inspection failed';
        return schemaErrorEnvelope(
            'VALIDATION_ERROR',
            msg,
            { issues: [{ path: '', code: 'VALIDATION_ERROR', message: msg }] },
            tool
        );
    }
    if (graphErr) {
        if (graphErr.code === 'SCHEMA_CIRCULAR_REF') {
            return schemaErrorEnvelope(
                'SCHEMA_CIRCULAR_REF',
                'Payload contains circular reference',
                {
                    issues: [
                        {
                            path: graphErr.path,
                            code: 'SCHEMA_CIRCULAR_REF',
                            message: 'Circular reference detected',
                        },
                    ],
                },
                tool
            );
        }
        return schemaErrorEnvelope(
            'SCHEMA_MAX_DEPTH',
            `Payload exceeds maximum nesting depth of ${safeMaxDepth}`,
            {
                issues: [
                    {
                        path: graphErr.path,
                        code: 'SCHEMA_MAX_DEPTH',
                        message: `Maximum depth ${safeMaxDepth} exceeded`,
                    },
                ],
            },
            tool
        );
    }

    if (isBuilder) {
        const parsed = schema.safeParse(payload, { coerce, stripUnknown, maxDepth: safeMaxDepth });
        if (parsed.success) {
            return schemaOkEnvelope(tool, 'Schema validation passed', parsed.data);
        }
        const topCode =
            parsed.error.issues?.[0]?.code === 'INVALID_SCHEMA'
                ? 'INVALID_SCHEMA'
                : 'VALIDATION_ERROR';
        return schemaErrorEnvelope(
            topCode,
            parsed.error.message || 'Schema validation failed',
            { issues: parsed.error.issues },
            tool
        );
    }

    if (isZodLike) {
        try {
            const parsed = schema.safeParse(payload);
            if (!parsed || typeof parsed !== 'object' || typeof parsed.success !== 'boolean') {
                const invalidSafeParseMsg =
                    'Custom safeParse schema returned an invalid result object';
                return schemaErrorEnvelope(
                    'INVALID_SCHEMA',
                    invalidSafeParseMsg,
                    {
                        issues: [
                            { path: '', code: 'INVALID_SCHEMA', message: invalidSafeParseMsg },
                        ],
                    },
                    tool
                );
            }
            if (parsed.success) {
                const clonedOut = cloneSafeValue(parsed.data);
                const numericIssues = collectNumericAndCoercionIssues(payload, clonedOut, '', true);
                if (numericIssues.length > 0) {
                    return schemaErrorEnvelope(
                        'VALIDATION_ERROR',
                        numericIssues[0].message,
                        { issues: numericIssues },
                        tool
                    );
                }
                return schemaOkEnvelope(
                    tool,
                    'Schema validation passed',
                    clonedOut
                );
            }
            const rawIssues = Array.isArray(parsed.error?.issues)
                ? parsed.error.issues
                : Array.isArray(parsed.error?.errors)
                  ? parsed.error.errors
                  : [];
            const issues =
                rawIssues.length > 0
                    ? rawIssues.map((iss) => ({
                          path: Array.isArray(iss?.path)
                              ? formatPathSegments(iss.path)
                              : String(iss?.path ?? ''),
                          code: String(iss?.code || 'VALIDATION_ERROR'),
                          message: String(iss?.message || 'Validation failed'),
                      }))
                    : [
                          {
                              path: '',
                              code: 'VALIDATION_ERROR',
                              message: String(parsed.error?.message || 'Schema validation failed'),
                          },
                      ];
            return schemaErrorEnvelope(
                'VALIDATION_ERROR',
                issues[0].message,
                { issues },
                tool
            );
        } catch (err) {
            const errMessage = err instanceof Error ? err.message : 'Schema validation failed';
            return schemaErrorEnvelope(
                'VALIDATION_ERROR',
                errMessage,
                {
                    issues: [
                        {
                            path: '',
                            code: 'SAFE_PARSE_THROW',
                            message: errMessage,
                        },
                    ],
                },
                tool
            );
        }
    }

    const ctx = {
        coerce: Boolean(coerce),
        stripUnknown: Boolean(stripUnknown),
        maxDepth: safeMaxDepth,
    };
    const issues = [];
    let evalRes;
    try {
        evalRes = evaluateRawJsonSchema(schema, payload, '', ctx, issues, 0);
    } catch (err) {
        const isSchemaErr = Boolean(err && typeof err === 'object' && err.code === 'INVALID_SCHEMA');
        const code = isSchemaErr ? 'INVALID_SCHEMA' : 'VALIDATION_ERROR';
        const msg = err instanceof Error ? err.message : 'Schema validation failed';
        return schemaErrorEnvelope(
            code,
            msg,
            { issues: [{ path: '', code, message: msg }] },
            tool
        );
    }
    if (!evalRes.valid || issues.length > 0) {
        const finalIssues =
            issues.length > 0
                ? issues
                : [{ path: '', code: 'VALIDATION_ERROR', message: 'Schema validation failed' }];
        return schemaErrorEnvelope(
            'VALIDATION_ERROR',
            finalIssues[0].message,
            { issues: finalIssues },
            tool
        );
    }

    return schemaOkEnvelope(tool, 'Schema validation passed', evalRes.value);
}

/**
 * Alias for `validateSchema` matching cross-language `krusch_toolkit.schema.validate_payload`.
 */
export const validatePayload = validateSchema;

/**
 * Create an Express / raw HTTP `(req, res, next)` request validation middleware.
 *
 * @param {object} schema - Schema builder, Zod schema, or JSON Schema object
 * @param {object} [options={}] - Middleware configuration
 * @param {'body'|'query'|'params'|'headers'} [options.source='body'] - Request property to validate
 * @param {boolean} [options.coerce=false] - Enable conservative scalar coercion
 * @param {boolean} [options.stripUnknown=true] - Strip undeclared object properties
 * @param {number} [options.maxDepth=16] - Maximum allowed container nesting depth
 * @param {string} [options.tool='schema.middleware'] - `INV-LEGO-01` tool identifier
 * @returns {(req: any, res: any, next?: (err?: unknown) => unknown) => unknown}
 */
export function createSchemaMiddleware(schema, options = {}) {
    const safeOptions = options && typeof options === 'object' ? options : {};
    const {
        source = 'body',
        coerce = false,
        stripUnknown = true,
        maxDepth = 16,
        tool = 'schema.middleware',
    } = safeOptions;
    if (typeof source !== 'string' || !ALLOWED_MIDDLEWARE_SOURCES.has(source)) {
        throw new TypeError(
            `Invalid schema middleware source "${String(source)}"; expected body, query, params, or headers`
        );
    }

    return function schemaValidationMiddleware(req, res, next) {
        const rawSourcePayload =
            req && typeof req === 'object' && !Array.isArray(req) ? req[source] : undefined;
        const result = validateSchema(schema, rawSourcePayload, {
            coerce,
            stripUnknown,
            maxDepth,
            tool,
        });

        if (result.ok) {
            if (req && typeof req === 'object') {
                try {
                    req.validated = result.data;
                } catch {
                    // Ignore frozen request wrapper
                }
                try {
                    const desc = Object.getOwnPropertyDescriptor(req, source);
                    if (!desc || desc.writable || typeof desc.set === 'function') {
                        req[source] = result.data;
                    }
                } catch {
                    // Ignore getter-only request properties (e.g. Express 5 req.query)
                }
            }
            if (typeof next === 'function') {
                return next();
            }
            return result;
        }

        if (res && typeof res === 'object') {
            if (typeof res.status === 'function' && typeof res.json === 'function') {
                try {
                    if (typeof res.setHeader === 'function' && !res.headersSent) {
                        res.setHeader('Content-Type', 'application/json; charset=utf-8');
                    }
                } catch {
                    // Ignore header mutation failure on mock response objects
                }
                const chained = res.status(400);
                if (chained && typeof chained.json === 'function') {
                    chained.json(result);
                } else {
                    res.json(result);
                }
                return result;
            }

            const payloadJson = JSON.stringify(result);
            if (typeof res.writeHead === 'function' && typeof res.end === 'function') {
                if (!res.headersSent) {
                    res.writeHead(400, {
                        'Content-Type': 'application/json; charset=utf-8',
                    });
                }
                res.end(payloadJson);
                return result;
            }

            if (typeof res.end === 'function') {
                res.statusCode = 400;
                if (typeof res.setHeader === 'function' && !res.headersSent) {
                    res.setHeader('Content-Type', 'application/json; charset=utf-8');
                }
                res.end(payloadJson);
                return result;
            }
        }

        return result;
    };
}
