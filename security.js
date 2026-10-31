/**
 * @module security
 * @description DNS-rebinding-safe SSRF outbound URL validator & `safeFetch` client plus
 * bounded-memory fixed-window HTTP/Edge rate limiter (`INV-LEGO-13`, `INV-LEGO-01`, `INV-LEGO-03`).
 */

import net from 'node:net';
import dns from 'node:dns';
import { okEnvelope, errorEnvelope } from './http.js';
import { edgeErrorResponse } from './edge.js';

let UndiciAgent = null;
let undiciFetch = null;
try {
    const undiciMod = await import('undici');
    UndiciAgent = undiciMod.Agent ?? null;
    undiciFetch = undiciMod.fetch ?? null;
} catch {
    UndiciAgent = null;
    undiciFetch = null;
}

const NATIVE_GLOBAL_FETCH = globalThis.fetch;

const CANONICAL_IPV4_RE =
    /^(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2})$/;
const HEX_GROUP_RE = /^[0-9a-fA-F]{1,4}$/;
const PURE_DIGITS_RE = /^\d+$/;
const PURE_HEX_RE = /^0x[0-9a-f]+$/i;

const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);
const FORBIDDEN_HEADER_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const CROSS_ORIGIN_SENSITIVE_HEADERS = new Set([
    'authorization',
    'cookie',
    'cookie2',
    'proxy-authorization',
]);
const BODY_SPECIFIC_HEADERS = new Set([
    'content-encoding',
    'content-language',
    'content-length',
    'content-location',
    'content-type',
    'transfer-encoding',
]);

/** @type {Map<string, any>} */
const CACHED_SSRF_AGENTS = new Map();

/**
 * Parse a strict canonical dotted-decimal IPv4 string into four `0..255` octets, or `null` if non-canonical.
 *
 * @param {string} candidate - Candidate IPv4 string
 * @returns {[number, number, number, number] | null}
 */
function parseCanonicalIpv4(candidate) {
    if (!CANONICAL_IPV4_RE.test(candidate)) return null;
    const parts = candidate.split('.');
    const a = Number(parts[0]);
    const b = Number(parts[1]);
    const c = Number(parts[2]);
    const d = Number(parts[3]);
    if (a > 255 || b > 255 || c > 255 || d > 255) return null;
    return [a, b, c, d];
}

/**
 * Expand a valid IPv6 string (already verified via `net.isIP(addr) === 6`) into 8 16-bit hextets.
 * Returns `null` on any malformed representation so callers fail closed.
 *
 * @param {string} ipv6 - Raw IPv6 address without brackets or `%zone`
 * @returns {number[] | null}
 */
function parseIpv6Hextets(ipv6) {
    let normalized = ipv6;
    if (normalized.includes('.')) {
        const lastColon = normalized.lastIndexOf(':');
        if (lastColon === -1) return null;
        const ipv4Octets = parseCanonicalIpv4(normalized.slice(lastColon + 1));
        if (!ipv4Octets) return null;
        const hiHex = ((ipv4Octets[0] << 8) | ipv4Octets[1]).toString(16);
        const loHex = ((ipv4Octets[2] << 8) | ipv4Octets[3]).toString(16);
        normalized = `${normalized.slice(0, lastColon + 1)}${hiHex}:${loHex}`;
    }

    const doubleColonParts = normalized.split('::');
    if (doubleColonParts.length > 2) return null;

    let groups;
    if (doubleColonParts.length === 2) {
        const left = doubleColonParts[0] ? doubleColonParts[0].split(':') : [];
        const right = doubleColonParts[1] ? doubleColonParts[1].split(':') : [];
        const missing = 8 - (left.length + right.length);
        if (missing < 1) return null;
        groups = [...left, ...new Array(missing).fill('0'), ...right];
    } else {
        groups = normalized.split(':');
        if (groups.length !== 8) return null;
    }

    if (groups.length !== 8) return null;
    const hextets = new Array(8);
    for (let i = 0; i < 8; i += 1) {
        const group = groups[i];
        if (!HEX_GROUP_RE.test(group)) return null;
        const parsed = Number.parseInt(group, 16);
        if (!Number.isInteger(parsed) || parsed < 0 || parsed > 0xffff) return null;
        hextets[i] = parsed;
    }
    return hextets;
}

/**
 * Fail-closed classifier for private, loopback, link-local, cloud metadata, CGNAT/Tailscale,
 * multicast, documentation, benchmarking, IPv4-mapped/compatible/6to4/Teredo/NAT64 IPv6, and
 * non-canonical IP literals (`INV-LEGO-13`).
 *
 * @param {string} [ipString=''] - Candidate IPv4 or IPv6 literal
 * @param {object} [options={}] - Policy overrides
 * @param {boolean} [options.allowPrivateLan=false] - Allow RFC1918 (`10/8`, `172.16/12`, `192.168/16`) and IPv6 ULA (`fc00::/7`)
 * @param {boolean} [options.allowTailscale=false] - Allow Tailscale CGNAT (`100.64.0.0/10`)
 * @returns {boolean} `true` if private, reserved, or malformed (blocked); `false` if globally routable/permitted
 */
export function isPrivateOrReservedIp(ipString = '', options = {}) {
    if (typeof ipString !== 'string') return true;
    const trimmed = ipString.trim();
    if (!trimmed || trimmed.includes('%')) return true;

    let clean = trimmed;
    if (clean.startsWith('[') || clean.endsWith(']')) {
        if (!clean.startsWith('[') || !clean.endsWith(']')) return true;
        clean = clean.slice(1, -1);
    }
    if (!clean || clean.includes('%')) return true;

    const opts = options && typeof options === 'object' ? options : {};
    const allowPrivateLan = opts.allowPrivateLan === true;
    const allowTailscale = opts.allowTailscale === true;

    const ipv4 = parseCanonicalIpv4(clean);
    if (ipv4 !== null) {
        const [a, b, c] = ipv4;

        // 0.0.0.0/8 ("This network") & 127.0.0.0/8 (Loopback)
        if (a === 0 || a === 127) return true;

        // 169.254.0.0/16 (Link-local & AWS/GCP/Azure Cloud Metadata 169.254.169.254 — ALWAYS blocked)
        if (a === 169 && b === 254) return true;

        // 100.64.0.0/10 (RFC 6598 Shared CGNAT / Tailscale)
        if (a === 100 && b >= 64 && b <= 127) {
            return !allowTailscale;
        }

        // RFC 1918 Private LAN (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)
        if (
            a === 10 ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 168)
        ) {
            return !allowPrivateLan;
        }

        // 192.0.0.0/24 (IETF Protocol Assignments) & 192.0.2.0/24 (TEST-NET-1)
        if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;

        // 198.18.0.0/15 (Benchmarking)
        if (a === 198 && (b === 18 || b === 19)) return true;

        // 198.51.100.0/24 (TEST-NET-2)
        if (a === 198 && b === 51 && c === 100) return true;

        // 203.0.113.0/24 (TEST-NET-3)
        if (a === 203 && b === 0 && c === 113) return true;

        // 224.0.0.0/4 (Multicast) + 240.0.0.0/4 (Reserved) + 255.255.255.255 (Broadcast)
        if (a >= 224) return true;

        return false;
    }

    if (net.isIP(clean) === 6) {
        const h = parseIpv6Hextets(clean);
        if (!h) return true;

        const zero0To4 = h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0;

        // Unspecified (::), Loopback (::1), and deprecated IPv4-compatible IPv6 (::/96) — ALWAYS blocked
        if (zero0To4 && h[5] === 0) {
            return true;
        }

        // IPv4-mapped IPv6 (::ffff:0:0/96) & SIIT IPv4-translated IPv6 (::ffff:0:0:0/96) — ALWAYS blocked
        if (
            (zero0To4 && h[5] === 0xffff) ||
            (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0xffff && h[5] === 0)
        ) {
            return true;
        }

        // NAT64 well-known (64:ff9b::/96) and local-use (64:ff9b:1::/48) — ALWAYS blocked
        if (
            h[0] === 0x0064 &&
            h[1] === 0xff9b &&
            ((h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0) || h[2] === 0x0001)
        ) {
            return true;
        }

        // Discard-Only Prefix (100::/64, RFC 6666) — ALWAYS blocked
        if (h[0] === 0x0100 && h[1] === 0 && h[2] === 0 && h[3] === 0) {
            return true;
        }

        // 6to4 (2002::/16) — ALWAYS blocked per INV-LEGO-13
        if (h[0] === 0x2002) {
            return true;
        }

        // IETF Protocol Assignments (2001::/23: Teredo 2001:0000::/32, Benchmarking 2001:2::/48, ORCHID/v2 2001:10::/28, 2001:20::/28) & Documentation (2001:db8::/32, 3fff::/20)
        if (h[0] === 0x2001 && (h[1] <= 0x01ff || h[1] === 0x0db8)) {
            return true;
        }
        if (h[0] === 0x3fff && (h[1] & 0xf000) === 0x0000) {
            return true;
        }

        // Link-local (fe80::/10), deprecated Site-local (fec0::/10), and Multicast (ff00::/8)
        if ((h[0] & 0xffc0) === 0xfe80 || (h[0] & 0xffc0) === 0xfec0 || (h[0] & 0xff00) === 0xff00) {
            return true;
        }

        // Unique Local Addresses (fc00::/7), unconditionally blocking AWS EC2 IPv6 IMDS (fd00:ec2::254)
        if ((h[0] & 0xfe00) === 0xfc00) {
            if (
                h[0] === 0xfd00 &&
                h[1] === 0x0ec2 &&
                h[2] === 0 &&
                h[3] === 0 &&
                h[4] === 0 &&
                h[5] === 0 &&
                h[6] === 0 &&
                h[7] === 0x0254
            ) {
                return true;
            }
            return !allowPrivateLan;
        }

        // Only IANA Global Unicast (2000::/3) is globally routable; all other IETF reserved prefixes fail closed
        return (h[0] & 0xe000) !== 0x2000;
    }

    // Any non-canonical IPv4 (octal, hex, shorthand, single-integer) or non-IP string fails closed
    return true;
}

/**
 * Extract the un-canonicalized host token from a raw URL string prior to WHATWG `new URL()` rewriting.
 *
 * @param {string} urlStr - Raw URL string
 * @returns {string}
 */
function extractRawAuthorityHost(urlStr) {
    const match = /^[a-zA-Z][a-zA-Z0-9+.-]*:[\/\\]{2}([^\/\\?#]*)/.exec(urlStr);
    if (!match) return '';
    let authority = match[1];
    const atIdx = authority.lastIndexOf('@');
    if (atIdx !== -1) {
        authority = authority.slice(atIdx + 1);
    }
    if (authority.startsWith('[')) {
        const closeIdx = authority.indexOf(']');
        return closeIdx !== -1 ? authority.slice(1, closeIdx) : authority;
    }
    const colonIdx = authority.indexOf(':');
    const hostPart = colonIdx !== -1 ? authority.slice(0, colonIdx) : authority;
    try {
        return decodeURIComponent(hostPart);
    } catch {
        return hostPart;
    }
}

/**
 * Detect non-canonical numeric/hex/octal IP obfuscation hostnames (e.g. `2130706433`, `0x7f000001`,
 * `0177.0.0.1`, `127.1`) before DNS resolution.
 *
 * @param {string} candidate - Lowercased or raw non-IPv6 hostname
 * @returns {boolean}
 */
function isSuspiciousNumericHost(candidate) {
    if (!candidate || candidate.includes(':')) return false;
    const stripped = candidate.trim().toLowerCase().replace(/\.+$/, '');
    if (!stripped) return false;
    if (parseCanonicalIpv4(stripped) !== null) return false;
    if (PURE_DIGITS_RE.test(stripped) || PURE_HEX_RE.test(stripped)) return true;

    const segments = stripped.split('.');
    if (
        segments.length >= 2 &&
        segments.every((seg) => seg.length > 0 && (PURE_DIGITS_RE.test(seg) || PURE_HEX_RE.test(seg)))
    ) {
        return true;
    }
    return false;
}

/**
 * Normalize `dns.lookup` / custom `lookupFn` outputs into `{ address, family }[]`.
 *
 * @param {unknown} rawResult - Lookup output
 * @returns {Array<{ address: string, family: number }>}
 */
function normalizeLookupResult(rawResult) {
    if (rawResult === null || rawResult === undefined) return [];
    const list = Array.isArray(rawResult) ? rawResult : [rawResult];
    const entries = [];
    for (const item of list) {
        if (typeof item === 'string') {
            const addr = item.trim();
            entries.push({ address: addr, family: net.isIP(addr) || 4 });
        } else if (item && typeof item === 'object') {
            const addr = typeof item.address === 'string' ? item.address.trim() : '';
            const fam = Number.isInteger(item.family) ? item.family : net.isIP(addr) || 4;
            entries.push({ address: addr, family: fam });
        } else {
            entries.push({ address: '', family: 0 });
        }
    }
    return entries;
}

/**
 * Validate an outbound URL against SSRF protocol, credential, allowlist, reserved-hostname,
 * IP-obfuscation, and multi-record DNS rules (`INV-LEGO-13`, `INV-LEGO-01`).
 * Never throws; always resolves to an `okEnvelope` or `errorEnvelope`.
 *
 * @param {string|URL} rawUrl - Outbound target URL
 * @param {object} [options={}] - Validation options
 * @param {string[]} [options.allowedProtocols=['https:', 'http:']] - Allowed URL schemes
 * @param {boolean} [options.allowPrivateLan=false] - Allow RFC1918 / ULA / `.local` targets
 * @param {boolean} [options.allowTailscale=false] - Allow Tailscale `100.64.0.0/10` targets
 * @param {string[]|Set<string>|null} [options.allowedHosts=null] - Optional exact host allowlist
 * @param {Function|null} [options.lookupFn=null] - Optional async DNS resolver override `(hostname) => Promise<...>`
 * @param {string} [options.tool='security.ssrf'] - Originating tool identifier
 * @returns {Promise<{ ok: boolean, tool: string, summary: string, data?: { url: string, hostname: string, port: string, resolvedAddresses: string[] }, error?: { code: string, message: string, details?: unknown } }>}
 */
export async function validateOutboundUrl(rawUrl, options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    const safeTool =
        typeof opts.tool === 'string' && opts.tool.trim().length > 0
            ? opts.tool.trim()
            : 'security.ssrf';
    const allowedProtocols = opts.allowedProtocols ?? ['https:', 'http:'];
    const allowPrivateLan = opts.allowPrivateLan === true;
    const allowTailscale = opts.allowTailscale === true;
    const allowedHosts = opts.allowedHosts ?? null;
    const lookupFn = typeof opts.lookupFn === 'function' ? opts.lookupFn : null;

    try {
        if (typeof rawUrl !== 'string' && !(rawUrl instanceof URL)) {
            return errorEnvelope('SSRF_INVALID_URL', 'Outbound URL must be a non-empty string', null, safeTool);
        }

        const urlStr = String(rawUrl).trim();
        if (!urlStr || /[\r\n\0]/.test(urlStr)) {
            return errorEnvelope('SSRF_INVALID_URL', 'Malformed or empty outbound URL', null, safeTool);
        }

        let parsed;
        try {
            parsed = new URL(urlStr);
        } catch {
            return errorEnvelope('SSRF_INVALID_URL', 'Invalid URL syntax', { url: urlStr }, safeTool);
        }

        const normalizedProtocols = Array.isArray(allowedProtocols)
            ? allowedProtocols
                  .filter((p) => typeof p === 'string' && p.trim().length > 0)
                  .map((p) => {
                      const lower = p.trim().toLowerCase();
                      return lower.endsWith(':') ? lower : `${lower}:`;
                  })
            : [];

        if (!normalizedProtocols.includes(parsed.protocol.toLowerCase())) {
            return errorEnvelope(
                'SSRF_BLOCKED_PROTOCOL',
                `Outbound protocol "${parsed.protocol}" is not permitted`,
                { protocol: parsed.protocol },
                safeTool
            );
        }

        if (
            parsed.username ||
            parsed.password ||
            /^[a-zA-Z][a-zA-Z0-9+.-]*:[\/\\]{2}[^\/\\?#]*@/.test(urlStr)
        ) {
            return errorEnvelope(
                'SSRF_CREDENTIALS_FORBIDDEN',
                'Embedded URL credentials (username/password) are forbidden',
                null,
                safeTool
            );
        }

        const rawAuthorityHost = extractRawAuthorityHost(urlStr);
        const bracketStrippedHost = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
        const hostname = bracketStrippedHost.replace(/\.+$/, '');

        if (!hostname || hostname.startsWith('.') || hostname.includes('..')) {
            return errorEnvelope('SSRF_INVALID_URL', 'Outbound URL hostname is invalid', { hostname }, safeTool);
        }

        if (allowedHosts !== null && allowedHosts !== undefined) {
            if (!Array.isArray(allowedHosts) && !(allowedHosts instanceof Set)) {
                return errorEnvelope(
                    'SSRF_HOST_NOT_ALLOWED',
                    'Invalid allowedHosts allowlist configuration',
                    { hostname },
                    safeTool
                );
            }
            const allowedSet = new Set();
            for (const entry of allowedHosts) {
                if (typeof entry === 'string' && entry.trim().length > 0) {
                    allowedSet.add(entry.trim().replace(/^\[|\]$/g, '').toLowerCase().replace(/\.+$/, ''));
                }
            }
            if (!allowedSet.has(hostname)) {
                return errorEnvelope(
                    'SSRF_HOST_NOT_ALLOWED',
                    `Outbound host "${hostname}" is not in allowedHosts`,
                    { hostname },
                    safeTool
                );
            }
        }

        // Cloud metadata hostnames are ALWAYS forbidden, even when allowPrivateLan === true
        if (
            hostname === 'metadata.google.internal' ||
            hostname.endsWith('.metadata.google.internal') ||
            hostname === 'metadata.goog'
        ) {
            return errorEnvelope(
                'SSRF_PRIVATE_IP',
                `Outbound access to cloud metadata host "${hostname}" is forbidden`,
                { hostname },
                safeTool
            );
        }

        // Localhost / mDNS / generic metadata hostnames are blocked unless allowPrivateLan === true
        if (
            !allowPrivateLan &&
            (hostname === 'localhost' ||
                hostname.endsWith('.localhost') ||
                hostname.endsWith('.local') ||
                hostname === 'metadata' ||
                hostname === 'instance-data')
        ) {
            return errorEnvelope(
                'SSRF_PRIVATE_IP',
                `Outbound access to reserved host "${hostname}" is forbidden`,
                { hostname },
                safeTool
            );
        }

        // Reject octal, hex, shorthand, or single-integer IP obfuscation before DNS resolution
        if (isSuspiciousNumericHost(rawAuthorityHost) || isSuspiciousNumericHost(hostname)) {
            return errorEnvelope(
                'SSRF_PRIVATE_IP',
                `Non-canonical numeric/hex/octal IP hostname "${rawAuthorityHost || hostname}" is forbidden`,
                { hostname: rawAuthorityHost || hostname },
                safeTool
            );
        }

        if (bracketStrippedHost.includes('%') || rawAuthorityHost.includes('%')) {
            return errorEnvelope(
                'SSRF_PRIVATE_IP',
                'IPv6 zone indices are forbidden in outbound URLs',
                { hostname },
                safeTool
            );
        }

        const defaultPort =
            parsed.protocol === 'https:' ? '443' : parsed.protocol === 'http:' ? '80' : '';
        const port = parsed.port || defaultPort;
        const ipPolicy = { allowPrivateLan, allowTailscale };

        if (net.isIP(hostname) !== 0) {
            if (isPrivateOrReservedIp(hostname, ipPolicy)) {
                return errorEnvelope(
                    'SSRF_PRIVATE_IP',
                    `Outbound IP "${hostname}" is private or reserved`,
                    { hostname, blockedAddress: hostname },
                    safeTool
                );
            }
            return okEnvelope(safeTool, 'Outbound URL validated', {
                url: parsed.toString(),
                hostname,
                port,
                resolvedAddresses: [hostname],
            });
        }

        const resolveHost =
            lookupFn || ((host) => dns.promises.lookup(host, { all: true, verbatim: true }));

        let rawResolved;
        try {
            rawResolved = await resolveHost(hostname);
        } catch (err) {
            return errorEnvelope(
                'SSRF_DNS_FAILED',
                `DNS resolution failed for "${hostname}": ${err?.message || 'lookup error'}`,
                { hostname },
                safeTool
            );
        }

        const entries = normalizeLookupResult(rawResolved);
        if (entries.length === 0) {
            return errorEnvelope(
                'SSRF_DNS_FAILED',
                `DNS resolution returned zero addresses for "${hostname}"`,
                { hostname },
                safeTool
            );
        }

        const resolvedAddresses = [];
        for (const entry of entries) {
            if (isPrivateOrReservedIp(entry.address, ipPolicy)) {
                return errorEnvelope(
                    'SSRF_PRIVATE_IP',
                    `Host "${hostname}" resolved to private or reserved IP "${entry.address}"`,
                    { hostname, blockedAddress: entry.address },
                    safeTool
                );
            }
            resolvedAddresses.push(entry.address);
        }

        return okEnvelope(safeTool, 'Outbound URL validated', {
            url: parsed.toString(),
            hostname,
            port,
            resolvedAddresses,
        });
    } catch (err) {
        return errorEnvelope(
            'SSRF_INVALID_URL',
            err?.message || 'Failed to validate outbound URL',
            null,
            safeTool
        );
    }
}

/**
 * Build a socket-connect `lookup` callback enforcing `isPrivateOrReservedIp` right at TCP/TLS connect time
 * so TOCTOU DNS rebinding between `validateOutboundUrl` and `fetch` cannot reach internal IPs.
 *
 * @param {object} params - Lookup policy
 * @param {boolean} params.allowPrivateLan - Allow RFC1918/ULA
 * @param {boolean} params.allowTailscale - Allow Tailscale CGNAT
 * @param {Function|null} params.lookupFn - Optional injected async resolver
 * @returns {(hostname: string, opts: any, cb: Function) => void}
 */
function createSsrfConnectLookup({ allowPrivateLan, allowTailscale, lookupFn }) {
    const ipPolicy = { allowPrivateLan, allowTailscale };
    const resolveHost =
        lookupFn || ((host) => dns.promises.lookup(host, { all: true, verbatim: true }));

    return (rawHostname, lookupOpts, callback) => {
        const cb = typeof lookupOpts === 'function' ? lookupOpts : callback;
        const opts = typeof lookupOpts === 'object' && lookupOpts !== null ? lookupOpts : {};
        const cleanHost = String(rawHostname || '')
            .trim()
            .replace(/^\[|\]$/g, '')
            .toLowerCase()
            .replace(/\.+$/, '');

        const failSsrf = (blockedAddress, message) => {
            const err = new Error(message);
            err.code = 'SSRF_PRIVATE_IP';
            err.hostname = cleanHost;
            err.blockedAddress = blockedAddress;
            cb(err);
        };

        if (
            !cleanHost ||
            cleanHost === 'metadata.google.internal' ||
            cleanHost.endsWith('.metadata.google.internal') ||
            cleanHost === 'metadata.goog'
        ) {
            failSsrf(cleanHost, `Outbound connect to cloud metadata host "${cleanHost}" is forbidden`);
            return;
        }

        if (net.isIP(cleanHost) !== 0) {
            if (isPrivateOrReservedIp(cleanHost, ipPolicy)) {
                failSsrf(cleanHost, `Outbound connect to private or reserved IP "${cleanHost}" is forbidden`);
                return;
            }
            const family = net.isIP(cleanHost);
            if (opts.all) {
                cb(null, [{ address: cleanHost, family }]);
            } else {
                cb(null, cleanHost, family);
            }
            return;
        }

        Promise.resolve()
            .then(() => resolveHost(cleanHost))
            .then((rawResolved) => {
                const entries = normalizeLookupResult(rawResolved);
                if (entries.length === 0) {
                    const dnsErr = new Error(`DNS resolution returned zero addresses for "${cleanHost}"`);
                    dnsErr.code = 'SSRF_DNS_FAILED';
                    dnsErr.hostname = cleanHost;
                    cb(dnsErr);
                    return;
                }

                for (const entry of entries) {
                    if (isPrivateOrReservedIp(entry.address, ipPolicy)) {
                        failSsrf(
                            entry.address,
                            `DNS rebinding blocked: "${cleanHost}" resolved to "${entry.address}"`
                        );
                        return;
                    }
                }

                const requestedFamily = opts.family === 4 || opts.family === 6 ? opts.family : 0;
                const matching = requestedFamily
                    ? entries.filter((e) => e.family === requestedFamily)
                    : entries;
                const finalEntries = matching.length > 0 ? matching : entries;

                if (opts.all) {
                    cb(null, finalEntries);
                } else {
                    cb(null, finalEntries[0].address, finalEntries[0].family);
                }
            })
            .catch((err) => {
                const dnsErr = new Error(
                    `DNS resolution failed for "${cleanHost}": ${err?.message || 'lookup error'}`
                );
                dnsErr.code = err?.code === 'SSRF_PRIVATE_IP' ? 'SSRF_PRIVATE_IP' : 'SSRF_DNS_FAILED';
                dnsErr.hostname = cleanHost;
                cb(dnsErr);
            });
    };
}

/**
 * Retrieve a cached module-level `undici` `Agent` when `!lookupFn`, or create a short-keepalive
 * per-call `Agent` when a custom `lookupFn` is supplied (so response body streams stay readable
 * after `safeFetch` resolves without premature `agent.close()`).
 *
 * @param {object} params - Agent options
 * @param {boolean} params.allowPrivateLan - Allow RFC1918/ULA
 * @param {boolean} params.allowTailscale - Allow Tailscale CGNAT
 * @param {Function|null} params.lookupFn - Optional injected async resolver
 * @returns {any}
 */
function getSsrfDispatcher({ allowPrivateLan, allowTailscale, lookupFn }) {
    if (!UndiciAgent) return null;

    if (lookupFn) {
        return new UndiciAgent({
            keepAliveTimeout: 1,
            keepAliveMaxTimeout: 1,
            connect: {
                lookup: createSsrfConnectLookup({ allowPrivateLan, allowTailscale, lookupFn }),
            },
        });
    }

    const cacheKey = `${Boolean(allowPrivateLan)}:${Boolean(allowTailscale)}`;
    let cached = CACHED_SSRF_AGENTS.get(cacheKey);
    if (!cached) {
        cached = new UndiciAgent({
            keepAliveTimeout: 5_000,
            keepAliveMaxTimeout: 15_000,
            connect: {
                lookup: createSsrfConnectLookup({ allowPrivateLan, allowTailscale, lookupFn: null }),
            },
        });
        CACHED_SSRF_AGENTS.set(cacheKey, cached);
    }
    return cached;
}

/**
 * Clone arbitrary `RequestInit['headers']` (`Headers`, tuple array, or plain object) into a plain object.
 *
 * @param {Headers|Array<[string, string]>|Record<string, string>|undefined|null} rawHeaders - Input headers
 * @returns {Record<string, string>}
 */
function cloneRequestHeaders(rawHeaders) {
    const out = {};
    if (!rawHeaders) return out;
    if (typeof Headers !== 'undefined' && rawHeaders instanceof Headers) {
        for (const [k, v] of rawHeaders.entries()) {
            out[k] = v;
        }
        return out;
    }
    if (Array.isArray(rawHeaders)) {
        for (const entry of rawHeaders) {
            if (Array.isArray(entry) && entry.length >= 2 && entry[0] != null && entry[1] != null) {
                const key = String(entry[0]);
                if (!FORBIDDEN_HEADER_KEYS.has(key)) {
                    out[key] = String(entry[1]);
                }
            }
        }
        return out;
    }
    if (typeof rawHeaders === 'object') {
        for (const [k, v] of Object.entries(rawHeaders)) {
            if (v !== undefined && v !== null && !FORBIDDEN_HEADER_KEYS.has(k)) {
                out[k] = String(v);
            }
        }
    }
    return out;
}

/**
 * Remove headers matching a lowercase name set without mutating the source object.
 *
 * @param {Record<string, string>} headersObj - Cloned headers record
 * @param {Set<string>} lowerNamesToRemove - Lowercase header names to strip
 * @returns {Record<string, string>}
 */
function stripHeaderNames(headersObj, lowerNamesToRemove) {
    const next = {};
    for (const [k, v] of Object.entries(headersObj)) {
        if (!lowerNamesToRemove.has(k.toLowerCase())) {
            next[k] = v;
        }
    }
    return next;
}

/**
 * Read a single response header case-insensitively across `Headers`, `Map`, and plain object mocks.
 *
 * @param {any} headers - Response headers container
 * @param {string} name - Header name
 * @returns {string|null}
 */
function getResponseHeader(headers, name) {
    if (!headers || typeof headers !== 'object') return null;
    if (typeof headers.get === 'function') {
        const val = headers.get(name);
        if (val !== undefined && val !== null) return String(val);
        const lowerVal = headers.get(name.toLowerCase());
        return lowerVal !== undefined && lowerVal !== null ? String(lowerVal) : null;
    }
    const target = name.toLowerCase();
    for (const [k, v] of Object.entries(headers)) {
        if (k.toLowerCase() === target && v !== undefined && v !== null) {
            return String(v);
        }
    }
    return null;
}

/**
 * Convert response headers into a plain `Record<string, string>`.
 *
 * @param {any} headers - Response headers container
 * @returns {Record<string, string>}
 */
function serializeResponseHeaders(headers) {
    if (!headers || typeof headers !== 'object') return {};
    if (typeof headers.entries === 'function') {
        return Object.fromEntries(headers.entries());
    }
    const out = {};
    for (const [k, v] of Object.entries(headers)) {
        if (v !== undefined && v !== null && !FORBIDDEN_HEADER_KEYS.has(k)) {
            out[k.toLowerCase()] = String(v);
        }
    }
    return out;
}

/**
 * Perform a DNS-rebinding-safe, redirect-validated outbound HTTP fetch (`INV-LEGO-13`, `INV-LEGO-03`).
 * Never throws; returns a deterministic `INV-LEGO-01` `okEnvelope` or `errorEnvelope`.
 *
 * @param {string|URL} rawUrl - Outbound target URL
 * @param {RequestInit} [init={}] - Standard `fetch` request init
 * @param {object} [options={}] - Security & transport options
 * @param {number} [options.maxRedirects=3] - Maximum validated redirect hops (`0` disables redirects)
 * @param {number} [options.timeoutMs=15000] - Total request timeout across redirects in milliseconds
 * @param {string[]} [options.allowedProtocols=['https:', 'http:']] - Allowed URL schemes
 * @param {boolean} [options.allowPrivateLan=false] - Allow RFC1918 / ULA / `.local` targets
 * @param {boolean} [options.allowTailscale=false] - Allow Tailscale `100.64.0.0/10` targets
 * @param {string[]|Set<string>|null} [options.allowedHosts=null] - Optional exact host allowlist
 * @param {Function|null} [options.lookupFn=null] - Optional async DNS resolver override
 * @param {typeof fetch} [options.fetchImpl=globalThis.fetch] - Fetch implementation override for testing
 * @param {string} [options.tool='security.fetch'] - Originating tool identifier
 * @returns {Promise<{ ok: boolean, tool: string, summary: string, data?: { status: number, url: string, redirected: boolean, redirects: number, headers: Record<string, string>, response: Response }, error?: { code: string, message: string, details?: unknown } }>}
 */
export async function safeFetch(rawUrl, init = {}, options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    const safeTool =
        typeof opts.tool === 'string' && opts.tool.trim().length > 0
            ? opts.tool.trim()
            : 'security.fetch';
    const rawMaxRedirects = opts.maxRedirects !== undefined ? Number(opts.maxRedirects) : 3;
    const safeMaxRedirects = Number.isFinite(rawMaxRedirects)
        ? Math.max(0, Math.trunc(rawMaxRedirects))
        : 3;
    const rawTimeoutMs = opts.timeoutMs !== undefined ? Number(opts.timeoutMs) : 15_000;
    const safeTimeoutMs =
        Number.isFinite(rawTimeoutMs) && rawTimeoutMs > 0 ? Math.max(1, Math.trunc(rawTimeoutMs)) : 15_000;
    const allowedProtocols = opts.allowedProtocols ?? ['https:', 'http:'];
    const allowPrivateLan = opts.allowPrivateLan === true;
    const allowTailscale = opts.allowTailscale === true;
    const allowedHosts = opts.allowedHosts ?? null;
    const lookupFn = typeof opts.lookupFn === 'function' ? opts.lookupFn : null;
    const fetchImpl = opts.fetchImpl !== undefined ? opts.fetchImpl : globalThis.fetch;

    if (typeof fetchImpl !== 'function') {
        return errorEnvelope('FETCH_FAILED', 'fetchImpl must be a function', null, safeTool);
    }

    const baseInit = init && typeof init === 'object' ? init : {};
    const {
        signal: callerSignal,
        redirect: _ignoredRedirect,
        dispatcher: _ignoredDispatcher,
        headers: initialHeaders,
        ...restInit
    } = /** @type {Record<string, any>} */ (baseInit);

    const controller = new AbortController();
    let timedOut = false;

    const onCallerAbort = () => {
        if (!controller.signal.aborted) {
            controller.abort(
                callerSignal?.reason ?? new DOMException('The operation was aborted.', 'AbortError')
            );
        }
    };

    if (callerSignal) {
        if (callerSignal.aborted) {
            onCallerAbort();
        } else if (typeof callerSignal.addEventListener === 'function') {
            callerSignal.addEventListener('abort', onCallerAbort, { once: true });
        }
    }

    const timer = setTimeout(() => {
        timedOut = true;
        if (!controller.signal.aborted) {
            controller.abort(
                new DOMException(`Outbound fetch timed out after ${safeTimeoutMs}ms`, 'TimeoutError')
            );
        }
    }, safeTimeoutMs);
    timer.unref?.();

    const useNativeUndici =
        fetchImpl === globalThis.fetch &&
        fetchImpl === NATIVE_GLOBAL_FETCH &&
        typeof undiciFetch === 'function' &&
        Boolean(UndiciAgent);

    const dispatcher =
        fetchImpl === globalThis.fetch
            ? getSsrfDispatcher({ allowPrivateLan, allowTailscale, lookupFn })
            : null;
    const activeFetch = useNativeUndici ? undiciFetch : fetchImpl;

    let currentUrl = typeof rawUrl === 'string' || rawUrl instanceof URL ? String(rawUrl) : '';
    let currentHeaders = cloneRequestHeaders(initialHeaders);
    let currentInit = { ...restInit };
    let hops = 0;

    try {
        while (hops <= safeMaxRedirects) {
            if (controller.signal.aborted) {
                return errorEnvelope(
                    'FETCH_ABORTED',
                    timedOut
                        ? `Outbound fetch timed out after ${safeTimeoutMs}ms`
                        : 'Outbound fetch was aborted',
                    { url: currentUrl, timedOut },
                    safeTool
                );
            }

            const check = await validateOutboundUrl(currentUrl, {
                allowedProtocols,
                allowPrivateLan,
                allowTailscale,
                allowedHosts,
                lookupFn,
                tool: safeTool,
            });
            if (!check.ok) {
                return check;
            }
            currentUrl = check.data.url;

            const requestInit = {
                ...currentInit,
                ...(Object.keys(currentHeaders).length > 0 ? { headers: { ...currentHeaders } } : {}),
                redirect: 'manual',
                signal: controller.signal,
                ...(dispatcher ? { dispatcher } : {}),
            };

            const res = await activeFetch(currentUrl, requestInit);
            const status = Number(res?.status) || 0;

            if (REDIRECT_STATUS_CODES.has(status)) {
                res?.body?.cancel?.().catch(() => {});

                const location = getResponseHeader(res?.headers, 'location');
                if (!location || !location.trim() || /[\r\n]/.test(location)) {
                    return errorEnvelope(
                        'SSRF_INVALID_REDIRECT',
                        `Redirect response (${status}) is missing a valid Location header`,
                        { status, url: currentUrl },
                        safeTool
                    );
                }

                if (hops >= safeMaxRedirects) {
                    return errorEnvelope(
                        'SSRF_TOO_MANY_REDIRECTS',
                        `Exceeded maximum redirect hops (${safeMaxRedirects})`,
                        { maxRedirects: safeMaxRedirects, url: currentUrl, location },
                        safeTool
                    );
                }

                let nextParsed;
                let currentParsed;
                try {
                    currentParsed = new URL(currentUrl);
                    nextParsed = new URL(location, currentUrl);
                } catch {
                    return errorEnvelope(
                        'SSRF_INVALID_REDIRECT',
                        `Malformed redirect Location URL "${location}"`,
                        { status, url: currentUrl, location },
                        safeTool
                    );
                }

                if (nextParsed.origin !== currentParsed.origin) {
                    currentHeaders = stripHeaderNames(currentHeaders, CROSS_ORIGIN_SENSITIVE_HEADERS);
                }

                const currentMethod = String(currentInit.method || 'GET').toUpperCase();
                if (
                    (status === 303 && currentMethod !== 'GET' && currentMethod !== 'HEAD') ||
                    ((status === 301 || status === 302) && currentMethod === 'POST')
                ) {
                    currentInit = { ...currentInit, method: 'GET' };
                    delete currentInit.body;
                    currentHeaders = stripHeaderNames(currentHeaders, BODY_SPECIFIC_HEADERS);
                }

                currentUrl = nextParsed.toString();
                hops += 1;
                continue;
            }

            return okEnvelope(safeTool, `Fetched ${currentUrl} (${status})`, {
                status,
                url: currentUrl,
                redirected: hops > 0,
                redirects: hops,
                headers: serializeResponseHeaders(res?.headers),
                response: res,
            });
        }

        return errorEnvelope(
            'SSRF_TOO_MANY_REDIRECTS',
            `Exceeded maximum redirect hops (${safeMaxRedirects})`,
            { maxRedirects: safeMaxRedirects, url: currentUrl },
            safeTool
        );
    } catch (err) {
        const cause = err?.cause || err;
        if (
            timedOut ||
            controller.signal.aborted ||
            err?.name === 'AbortError' ||
            err?.name === 'TimeoutError' ||
            err?.code === 'ABORT_ERR' ||
            cause?.name === 'AbortError' ||
            cause?.name === 'TimeoutError'
        ) {
            return errorEnvelope(
                'FETCH_ABORTED',
                timedOut
                    ? `Outbound fetch timed out after ${safeTimeoutMs}ms`
                    : err?.message || 'Outbound fetch was aborted',
                { url: currentUrl, timedOut },
                safeTool
            );
        }

        if (cause?.code === 'SSRF_PRIVATE_IP') {
            return errorEnvelope(
                'SSRF_PRIVATE_IP',
                cause.message || 'DNS rebinding to private or reserved IP blocked at socket connect',
                {
                    url: currentUrl,
                    ...(cause.hostname ? { hostname: cause.hostname } : {}),
                    ...(cause.blockedAddress ? { blockedAddress: cause.blockedAddress } : {}),
                },
                safeTool
            );
        }

        if (cause?.code === 'SSRF_DNS_FAILED') {
            return errorEnvelope(
                'SSRF_DNS_FAILED',
                cause.message || 'DNS resolution failed at socket connect',
                {
                    url: currentUrl,
                    ...(cause.hostname ? { hostname: cause.hostname } : {}),
                },
                safeTool
            );
        }

        return errorEnvelope(
            'FETCH_FAILED',
            cause?.message || err?.message || 'Outbound HTTP fetch failed',
            {
                url: currentUrl,
                ...(cause?.code ? { code: cause.code } : {}),
            },
            safeTool
        );
    } finally {
        clearTimeout(timer);
        if (callerSignal && typeof callerSignal.removeEventListener === 'function') {
            callerSignal.removeEventListener('abort', onCallerAbort);
        }
    }
}

/**
 * Sanitize a positive integer option with a fallback and floor value.
 *
 * @param {unknown} rawValue - Candidate numeric option
 * @param {number} fallback - Default value when missing/non-positive/NaN
 * @param {number} minFloor - Minimum allowed integer
 * @returns {number}
 */
function sanitizePositiveInt(rawValue, fallback, minFloor) {
    const num = Number(rawValue);
    if (!Number.isFinite(num) || num <= 0) {
        return Math.max(minFloor, fallback);
    }
    return Math.max(minFloor, Math.trunc(num));
}

/**
 * Normalize a caller rate-limit bucket key to a bounded `<= 256` char string without CR/LF.
 *
 * @param {unknown} rawKey - Raw client identifier
 * @returns {string}
 */
function normalizeBucketKey(rawKey) {
    const str =
        rawKey === undefined || rawKey === null
            ? ''
            : String(rawKey).replace(/[\r\n]+/g, '').trim();
    return (str || 'anonymous').slice(0, 256);
}

/**
 * Extract client IP key from a Node `IncomingMessage` / Express `req`.
 *
 * @param {any} req - Node/Express request
 * @param {boolean} trustProxy - Whether to read `X-Forwarded-For`
 * @returns {string}
 */
function defaultNodeKeyFromRequest(req, trustProxy) {
    if (trustProxy) {
        const rawXff = Array.isArray(req?.headers?.['x-forwarded-for'])
            ? req.headers['x-forwarded-for'][0]
            : req?.headers?.['x-forwarded-for'];
        if (typeof rawXff === 'string' && rawXff.trim().length > 0) {
            const firstIp = rawXff.split(',')[0].trim();
            if (firstIp) return firstIp;
        }
    }
    return (
        req?.ip ||
        req?.socket?.remoteAddress ||
        req?.connection?.remoteAddress ||
        'anonymous'
    );
}

/**
 * Extract client IP key from a Web `Request` (Cloudflare Workers / Edge).
 *
 * @param {Request|any} request - Web `Request`
 * @returns {string}
 */
function defaultEdgeKeyFromRequest(request) {
    const cfIp = request?.headers?.get?.('cf-connecting-ip');
    if (typeof cfIp === 'string' && cfIp.trim().length > 0) {
        return cfIp.trim();
    }
    const xff = request?.headers?.get?.('x-forwarded-for');
    if (typeof xff === 'string' && xff.trim().length > 0) {
        const firstIp = xff.split(',')[0].trim();
        if (firstIp) return firstIp;
    }
    return 'anonymous';
}

/**
 * Write HTTP `429` JSON envelope across Express `res`, native `http.ServerResponse`, and test mocks.
 *
 * @param {any} res - Outgoing HTTP response
 * @param {object} envelope - `RATE_LIMITED` error envelope
 * @param {Record<string, string>} rateHeaders - Rate limit response headers
 */
function writeNodeRateLimitedResponse(res, envelope, rateHeaders) {
    if (!res || res.writableEnded || res.destroyed || res.headersSent) return;
    const serialized = JSON.stringify(envelope);
    const allHeaders = {
        ...rateHeaders,
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': String(Buffer.byteLength(serialized, 'utf8')),
    };

    if (typeof res.setHeader === 'function') {
        res.statusCode = 429;
        for (const [k, v] of Object.entries(allHeaders)) {
            res.setHeader(k, v);
        }
    } else if (typeof res.writeHead === 'function') {
        res.writeHead(429, allHeaders);
    }

    if (typeof res.end === 'function') {
        res.end(serialized);
    } else if (typeof res.status === 'function' && typeof res.json === 'function') {
        res.status(429).json(envelope);
    }
}

/**
 * Create a bounded-memory fixed-window rate limiter supporting direct `consume()`,
 * Express/Node HTTP `middleware()`, and Web-Standards Cloudflare Workers `edgeCheck()` (`INV-LEGO-13`).
 *
 * @param {object} [options={}] - Rate limiter configuration
 * @param {number} [options.windowMs=60000] - Fixed window duration in milliseconds (`>= 100`)
 * @param {number} [options.max=60] - Maximum allowed units per window (`>= 1`)
 * @param {number} [options.maxKeys=10000] - Maximum tracked keys before expired sweep + FIFO eviction (`>= 1`)
 * @param {() => number} [options.nowFn=Date.now] - Clock function returning epoch milliseconds
 * @param {string} [options.tool='security.rateLimit'] - Originating tool identifier for envelopes
 * @returns {{
 *   consume: (rawKey?: string, cost?: number) => {
 *     allowed: boolean,
 *     limit: number,
 *     remaining: number,
 *     resetMs: number,
 *     retryAfterSeconds: number,
 *     headers: Record<string, string>,
 *     envelope: { ok: boolean, tool: string, summary: string, data?: object, error?: object }
 *   },
 *   reset: (rawKey: string) => boolean,
 *   clear: () => void,
 *   size: () => number,
 *   middleware: (options?: { keyGenerator?: (req: any) => string, trustProxy?: boolean, cost?: number }) => (req: any, res: any, next?: Function) => any,
 *   edgeCheck: (request: Request, options?: { keyGenerator?: (request: Request) => string, corsHeaders?: Record<string, string>, cost?: number }) => {
 *     allowed: boolean,
 *     headers: Record<string, string>,
 *     limit: number,
 *     remaining: number,
 *     resetMs: number,
 *     retryAfterSeconds: number,
 *     envelope: object,
 *     response?: Response
 *   }
 * }}
 */
export function createRateLimiter(options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    const safeWindowMs = sanitizePositiveInt(opts.windowMs, 60_000, 100);
    const safeMax = sanitizePositiveInt(opts.max, 60, 1);
    const safeMaxKeys = sanitizePositiveInt(opts.maxKeys, 10_000, 1);
    const nowFn = typeof opts.nowFn === 'function' ? opts.nowFn : Date.now;
    const safeTool =
        typeof opts.tool === 'string' && opts.tool.trim().length > 0
            ? opts.tool.trim()
            : 'security.rateLimit';

    /** @type {Map<string, { count: number, resetAt: number }>} */
    const buckets = new Map();

    const sweepExpired = (now) => {
        for (const [k, entry] of buckets.entries()) {
            if (now >= entry.resetAt) {
                buckets.delete(k);
            }
        }
    };

    const consume = (rawKey = 'anonymous', cost = 1) => {
        const key = normalizeBucketKey(rawKey);
        const safeCost = sanitizePositiveInt(cost, 1, 1);
        const now = Number(nowFn());

        let entry = buckets.get(key);
        if (entry && now >= entry.resetAt) {
            buckets.delete(key);
            entry = undefined;
        }

        if (!entry) {
            if (buckets.size >= safeMaxKeys) {
                sweepExpired(now);
                while (buckets.size >= safeMaxKeys) {
                    const oldestKey = buckets.keys().next().value;
                    if (oldestKey === undefined) break;
                    buckets.delete(oldestKey);
                }
            }
            entry = {
                count: 0,
                resetAt: now + safeWindowMs,
            };
            buckets.set(key, entry);
        }

        const allowed = entry.count + safeCost <= safeMax;
        if (allowed) {
            entry.count += safeCost;
        }

        const remaining = allowed ? Math.max(0, safeMax - entry.count) : 0;
        const retryAfterSeconds = allowed
            ? 0
            : Math.max(1, Math.ceil((entry.resetAt - now) / 1000));

        const headers = {
            'X-RateLimit-Limit': String(safeMax),
            'X-RateLimit-Remaining': String(remaining),
            'X-RateLimit-Reset': String(Math.ceil(entry.resetAt / 1000)),
            ...(!allowed ? { 'Retry-After': String(retryAfterSeconds) } : {}),
        };

        const envelope = allowed
            ? okEnvelope(safeTool, 'Rate limit check passed', {
                  key,
                  remaining,
                  limit: safeMax,
              })
            : errorEnvelope(
                  'RATE_LIMITED',
                  `Rate limit exceeded; retry after ${retryAfterSeconds}s`,
                  { key, limit: safeMax, retryAfterSeconds },
                  safeTool
              );

        return {
            allowed,
            limit: safeMax,
            remaining,
            resetMs: entry.resetAt,
            retryAfterSeconds,
            headers,
            envelope,
        };
    };

    const reset = (rawKey) => buckets.delete(normalizeBucketKey(rawKey));

    const clear = () => {
        buckets.clear();
    };

    const size = () => buckets.size;

    const middleware = (mwOptions = {}) => {
        const mwOpts = mwOptions && typeof mwOptions === 'object' ? mwOptions : {};
        const keyGenerator = typeof mwOpts.keyGenerator === 'function' ? mwOpts.keyGenerator : null;
        const trustProxy = mwOpts.trustProxy === true;
        const cost = mwOpts.cost !== undefined ? mwOpts.cost : 1;

        return (req, res, next) => {
            const rawKey = keyGenerator
                ? keyGenerator(req)
                : defaultNodeKeyFromRequest(req, trustProxy);
            const result = consume(rawKey, cost);

            if (req && typeof req === 'object') {
                try {
                    req.rateLimit = result;
                } catch {
                    // Ignore frozen request mocks
                }
            }

            if (typeof res?.setHeader === 'function' && !res.headersSent) {
                for (const [k, v] of Object.entries(result.headers)) {
                    res.setHeader(k, v);
                }
            }

            if (!result.allowed) {
                writeNodeRateLimitedResponse(res, result.envelope, result.headers);
                return result;
            }

            if (typeof next === 'function') {
                return next();
            }
            return result;
        };
    };

    const edgeCheck = (request, edgeOptions = {}) => {
        const eOpts = edgeOptions && typeof edgeOptions === 'object' ? edgeOptions : {};
        const keyGenerator = typeof eOpts.keyGenerator === 'function' ? eOpts.keyGenerator : null;
        const corsHeaders =
            eOpts.corsHeaders && typeof eOpts.corsHeaders === 'object' ? eOpts.corsHeaders : {};
        const cost = eOpts.cost !== undefined ? eOpts.cost : 1;

        const rawKey = keyGenerator ? keyGenerator(request) : defaultEdgeKeyFromRequest(request);
        const normalizedKey = normalizeBucketKey(rawKey);
        const result = consume(normalizedKey, cost);

        if (result.allowed) {
            return {
                allowed: true,
                headers: result.headers,
                limit: result.limit,
                remaining: result.remaining,
                resetMs: result.resetMs,
                retryAfterSeconds: 0,
                envelope: result.envelope,
            };
        }

        return {
            allowed: false,
            headers: result.headers,
            limit: result.limit,
            remaining: 0,
            resetMs: result.resetMs,
            retryAfterSeconds: result.retryAfterSeconds,
            envelope: result.envelope,
            response: edgeErrorResponse(
                'RATE_LIMITED',
                `Rate limit exceeded; retry after ${result.retryAfterSeconds}s`,
                {
                    status: 429,
                    details: {
                        key: normalizedKey,
                        limit: result.limit,
                        retryAfterSeconds: result.retryAfterSeconds,
                    },
                    tool: safeTool,
                    headers: result.headers,
                    corsHeaders,
                }
            ),
        };
    };

    return {
        consume,
        reset,
        clear,
        size,
        middleware,
        edgeCheck,
    };
}
