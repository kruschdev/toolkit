"""
Security & Webhook Lego Bricks — constant-time comparison, HMAC-SHA256 webhook verification,
length-hiding SHA-256 Bearer verification, and DNS-rebinding-aware SSRF URL/IP validation.

Imports cleanly in bare Python 3.11+ using stdlib only and emits INV-LEGO-01 envelopes without throwing.
"""

from __future__ import annotations

import hashlib
import hmac
import ipaddress
import re
import socket
from collections.abc import Callable, Sequence
from typing import Any
from urllib.parse import urlsplit

from krusch_toolkit.fastapi_app import error_envelope, ok_envelope

__all__ = [
    "constant_time_equal",
    "verify_webhook_hmac",
    "verify_bearer_token",
    "is_private_or_reserved_ip",
    "validate_outbound_url",
]

_MAX_HEADER_LENGTH = 4096
_MAX_URL_LENGTH = 8192
_HEX_SHA256_RE = re.compile(r"[0-9a-fA-F]{64}")
_BEARER_HEADER_RE = re.compile(r"Bearer\s+(\S+)", re.IGNORECASE)
_NUMERIC_OR_HEX_LABEL_RE = re.compile(r"(?:0x[0-9a-f]+|\d+)", re.IGNORECASE)

_RFC1918_NETWORKS = (
    ipaddress.IPv4Network("10.0.0.0/8"),
    ipaddress.IPv4Network("172.16.0.0/12"),
    ipaddress.IPv4Network("192.168.0.0/16"),
)
_CGNAT_NETWORK = ipaddress.IPv4Network("100.64.0.0/10")
_IPV4_ALWAYS_BLOCKED_NETWORKS = (
    ipaddress.IPv4Network("0.0.0.0/8"),
    ipaddress.IPv4Network("127.0.0.0/8"),
    ipaddress.IPv4Network("169.254.0.0/16"),
    ipaddress.IPv4Network("192.0.0.0/24"),
    ipaddress.IPv4Network("192.0.2.0/24"),
    ipaddress.IPv4Network("198.18.0.0/15"),
    ipaddress.IPv4Network("198.51.100.0/24"),
    ipaddress.IPv4Network("203.0.113.0/24"),
    ipaddress.IPv4Network("224.0.0.0/4"),
    ipaddress.IPv4Network("240.0.0.0/4"),
)

_ULA_NETWORK = ipaddress.IPv6Network("fc00::/7")
_AWS_IPV6_METADATA = ipaddress.IPv6Address("fd00:ec2::254")
_IPV6_ALWAYS_BLOCKED_NETWORKS = (
    ipaddress.IPv6Network("::/96"),
    ipaddress.IPv6Network("::ffff:0:0/96"),
    ipaddress.IPv6Network("::ffff:0:0:0/96"),
    ipaddress.IPv6Network("64:ff9b::/96"),
    ipaddress.IPv6Network("64:ff9b:1::/48"),
    ipaddress.IPv6Network("100::/64"),
    ipaddress.IPv6Network("2001::/32"),
    ipaddress.IPv6Network("2001:2::/48"),
    ipaddress.IPv6Network("2001:10::/28"),
    ipaddress.IPv6Network("2001:20::/28"),
    ipaddress.IPv6Network("2001:db8::/32"),
    ipaddress.IPv6Network("2002::/16"),
    ipaddress.IPv6Network("fe80::/10"),
    ipaddress.IPv6Network("fec0::/10"),
    ipaddress.IPv6Network("ff00::/8"),
)

_ALWAYS_BLOCKED_HOSTS = frozenset(
    {
        "localhost",
        "localhost.localdomain",
        "ip6-localhost",
        "ip6-loopback",
        "metadata",
        "metadata.google.internal",
        "metadata.goog",
        "instance-data",
        "169.254.169.254",
    }
)


def _to_bytes(val: Any) -> bytes | None:
    if isinstance(val, bytes):
        return val
    if isinstance(val, str):
        return val.encode("utf-8")
    return None


def constant_time_equal(a: str | bytes | None, b: str | bytes | None) -> bool:
    """
    Compare two `str` or `bytes` values in constant time.
    Returns `False` if either input is `None`, wrong type, empty `b""`, or mismatched byte length.
    """
    buf_a = _to_bytes(a)
    buf_b = _to_bytes(b)
    if buf_a is None or buf_b is None:
        return False
    if len(buf_a) == 0 or len(buf_a) != len(buf_b):
        return False
    return hmac.compare_digest(buf_a, buf_b)


def verify_webhook_hmac(
    raw_body: str | bytes,
    signature_header: str | None,
    secret: str | None,
    *,
    prefix: str = "sha256=",
    tool: str = "webhooks.hmac",
) -> dict[str, Any]:
    """
    Verify an HMAC-SHA256 webhook signature header fail-closed in constant time.
    Never raises on untrusted caller headers; always returns an INV-LEGO-01 envelope.
    """
    safe_tool = tool.strip() if isinstance(tool, str) and tool.strip() else "webhooks.hmac"
    try:
        if not isinstance(secret, str) or not secret.strip():
            return error_envelope(
                "WEBHOOK_MISSING_SECRET",
                "Webhook signing secret is not configured",
                tool=safe_tool,
            )

        body_bytes = _to_bytes(raw_body)
        if body_bytes is None:
            return error_envelope(
                "WEBHOOK_INVALID_BODY",
                "Raw request body str or bytes is required",
                tool=safe_tool,
            )

        if (
            not isinstance(signature_header, str)
            or len(signature_header) == 0
            or len(signature_header) > _MAX_HEADER_LENGTH
            or "\r" in signature_header
            or "\n" in signature_header
            or "\x00" in signature_header
        ):
            return error_envelope(
                "WEBHOOK_INVALID_SIGNATURE",
                "Malformed webhook signature header",
                tool=safe_tool,
            )

        safe_prefix = prefix if isinstance(prefix, str) else str(prefix or "")
        if safe_prefix:
            if signature_header[: len(safe_prefix)].lower() != safe_prefix.lower():
                return error_envelope(
                    "WEBHOOK_INVALID_SIGNATURE",
                    "Malformed webhook signature header",
                    tool=safe_tool,
                )
            hex_digest = signature_header[len(safe_prefix) :]
        else:
            hex_digest = signature_header

        if not _HEX_SHA256_RE.fullmatch(hex_digest):
            return error_envelope(
                "WEBHOOK_INVALID_SIGNATURE",
                "Malformed webhook signature header",
                tool=safe_tool,
            )

        received_digest = bytes.fromhex(hex_digest)
        expected_digest = hmac.new(secret.encode("utf-8"), body_bytes, hashlib.sha256).digest()
        if len(received_digest) != 32 or not hmac.compare_digest(received_digest, expected_digest):
            return error_envelope(
                "WEBHOOK_INVALID_SIGNATURE",
                "Webhook HMAC signature verification failed",
                tool=safe_tool,
            )

        return ok_envelope(
            safe_tool,
            "Webhook HMAC signature verified",
            {"verified": True, "algorithm": "sha256"},
        )
    except Exception:
        return error_envelope(
            "WEBHOOK_INVALID_SIGNATURE",
            "Webhook HMAC signature verification failed",
            tool=safe_tool,
        )


def verify_bearer_token(
    auth_header: str | None,
    expected_secret: str | None,
    *,
    tool: str = "webhooks.bearer",
) -> dict[str, Any]:
    """
    Verify an HTTP `Authorization: Bearer <token>` header fail-closed.
    Pre-hashes both candidate token and expected secret with SHA-256 before `hmac.compare_digest`
    so secret length never leaks via timing side-channels.
    """
    safe_tool = tool.strip() if isinstance(tool, str) and tool.strip() else "webhooks.bearer"
    try:
        if not isinstance(expected_secret, str) or not expected_secret.strip():
            return error_envelope(
                "AUTH_MISSING_SECRET",
                "Bearer authentication secret is not configured",
                tool=safe_tool,
            )

        if (
            not isinstance(auth_header, str)
            or len(auth_header) == 0
            or len(auth_header) > _MAX_HEADER_LENGTH
            or "\r" in auth_header
            or "\n" in auth_header
            or "\x00" in auth_header
        ):
            return error_envelope(
                "AUTH_INVALID_HEADER",
                "Malformed Authorization Bearer header",
                tool=safe_tool,
            )

        match = _BEARER_HEADER_RE.fullmatch(auth_header)
        if not match:
            return error_envelope(
                "AUTH_INVALID_HEADER",
                "Malformed Authorization Bearer header",
                tool=safe_tool,
            )

        token_digest = hashlib.sha256(match.group(1).encode("utf-8")).digest()
        expected_digest = hashlib.sha256(expected_secret.encode("utf-8")).digest()
        if not hmac.compare_digest(token_digest, expected_digest):
            return error_envelope("AUTH_UNAUTHORIZED", "Invalid bearer token", tool=safe_tool)

        return ok_envelope(
            safe_tool,
            "Bearer token verified",
            {"verified": True, "provider": "bearer"},
        )
    except Exception:
        return error_envelope(
            "AUTH_INVALID_HEADER",
            "Malformed Authorization Bearer header",
            tool=safe_tool,
        )


def is_private_or_reserved_ip(
    ip_str: str,
    *,
    allow_private_lan: bool = False,
    allow_tailscale: bool = False,
) -> bool:
    """
    Fail-closed IPv4/IPv6 SSRF classifier.
    Blocks malformed/non-canonical literals, loopback, link-local / cloud metadata (`169.254.169.254`,
    `fd00:ec2::254`), multicast, unspecified, reserved, IPv4-mapped/6to4/Teredo transition prefixes,
    Tailscale CGNAT (`100.64.0.0/10` unless `allow_tailscale=True`), and RFC1918/ULA unless
    `allow_private_lan=True`.
    """
    if not isinstance(ip_str, str):
        return True
    clean = ip_str.strip()
    if not clean or "%" in clean or any(ch.isspace() for ch in clean):
        return True
    if clean.startswith("[") and clean.endswith("]"):
        clean = clean[1:-1]

    try:
        addr = ipaddress.ip_address(clean)
    except ValueError:
        return True

    if isinstance(addr, ipaddress.IPv4Address):
        if (
            addr.is_loopback
            or addr.is_link_local
            or addr.is_multicast
            or addr.is_unspecified
            or addr.is_reserved
            or any(addr in net for net in _IPV4_ALWAYS_BLOCKED_NETWORKS)
        ):
            return True
        if addr in _CGNAT_NETWORK:
            return not bool(allow_tailscale)
        if any(addr in net for net in _RFC1918_NETWORKS):
            return not bool(allow_private_lan)
        return not addr.is_global

    # IPv6Address
    if (
        addr == _AWS_IPV6_METADATA
        or addr.ipv4_mapped is not None
        or addr.sixtofour is not None
        or addr.teredo is not None
        or addr.is_loopback
        or addr.is_link_local
        or addr.is_site_local
        or addr.is_multicast
        or addr.is_unspecified
        or addr.is_reserved
        or any(addr in net for net in _IPV6_ALWAYS_BLOCKED_NETWORKS)
    ):
        return True

    if addr in _ULA_NETWORK:
        return not bool(allow_private_lan)

    return not addr.is_global


def _is_host_allowed(host_norm: str, allowed_hosts: Sequence[str]) -> bool:
    for entry in allowed_hosts:
        if not isinstance(entry, str) or not entry.strip():
            continue
        pattern = entry.strip().lower().rstrip(".")
        if pattern.startswith("*.") and len(pattern) > 2:
            suffix = pattern[1:]  # ".example.com"
            if host_norm.endswith(suffix) and len(host_norm) > len(suffix):
                return True
        elif host_norm == pattern:
            return True
    return False


def _looks_like_noncanonical_ip_literal(host_norm: str) -> bool:
    parts = host_norm.split(".")
    return bool(parts) and all(_NUMERIC_OR_HEX_LABEL_RE.fullmatch(part) is not None for part in parts)


def validate_outbound_url(
    raw_url: str,
    *,
    allowed_protocols: Sequence[str] = ("https", "http"),
    allow_private_lan: bool = False,
    allow_tailscale: bool = False,
    allowed_hosts: Sequence[str] | None = None,
    lookup_fn: Callable[[str], Sequence[str]] | None = None,
    tool: str = "security.ssrf",
) -> dict[str, Any]:
    """
    Validate an outbound URL against SSRF, URL credential smuggling, cloud metadata endpoints,
    and multi-record DNS rebinding without raising exceptions.
    """
    safe_tool = tool.strip() if isinstance(tool, str) and tool.strip() else "security.ssrf"
    try:
        if not isinstance(raw_url, str):
            return error_envelope("SSRF_INVALID_URL", "Outbound URL must be a string", tool=safe_tool)

        trimmed_url = raw_url.strip()
        if (
            not trimmed_url
            or len(trimmed_url) > _MAX_URL_LENGTH
            or any(ord(ch) < 0x20 or ord(ch) == 0x7F for ch in trimmed_url)
        ):
            return error_envelope("SSRF_INVALID_URL", "Invalid or malformed outbound URL", tool=safe_tool)

        authority_part = trimmed_url.split("?", 1)[0].split("#", 1)[0]
        if "\\" in authority_part:
            return error_envelope(
                "SSRF_INVALID_URL",
                "Backslashes are forbidden in URL authority/path",
                tool=safe_tool,
            )

        parsed = urlsplit(trimmed_url)
        scheme = parsed.scheme.lower().rstrip(":")
        if not scheme:
            return error_envelope("SSRF_INVALID_URL", "Outbound URL is missing a scheme", tool=safe_tool)

        normalized_protocols = {
            str(proto).strip().lower().rstrip(":")
            for proto in allowed_protocols
            if isinstance(proto, str) and proto.strip()
        }
        if scheme not in normalized_protocols:
            return error_envelope(
                "SSRF_BLOCKED_PROTOCOL",
                f"Outbound URL protocol '{scheme}' is not permitted",
                tool=safe_tool,
            )

        if parsed.username is not None or parsed.password is not None or "@" in parsed.netloc:
            return error_envelope(
                "SSRF_CREDENTIALS_FORBIDDEN",
                "Embedded credentials in outbound URLs are forbidden",
                tool=safe_tool,
            )

        raw_hostname = parsed.hostname
        if not raw_hostname:
            return error_envelope("SSRF_INVALID_URL", "Outbound URL is missing a hostname", tool=safe_tool)

        if "%" in raw_hostname or any(ch.isspace() for ch in raw_hostname):
            return error_envelope("SSRF_INVALID_URL", "Malformed outbound URL hostname", tool=safe_tool)

        host_norm = raw_hostname.strip().lower().rstrip(".")
        if not host_norm:
            return error_envelope("SSRF_INVALID_URL", "Outbound URL is missing a hostname", tool=safe_tool)

        try:
            explicit_port = parsed.port
        except ValueError:
            return error_envelope("SSRF_INVALID_URL", "Invalid outbound URL port", tool=safe_tool)

        if explicit_port is not None and not (1 <= explicit_port <= 65535):
            return error_envelope("SSRF_INVALID_URL", "Outbound URL port out of range", tool=safe_tool)

        effective_port = (
            explicit_port
            if explicit_port is not None
            else (443 if scheme == "https" else 80 if scheme == "http" else None)
        )

        if (
            host_norm in _ALWAYS_BLOCKED_HOSTS
            or host_norm.endswith(".localhost")
            or host_norm.endswith(".metadata.google.internal")
        ):
            return error_envelope(
                "SSRF_PRIVATE_IP",
                f"Blocked loopback or cloud metadata host: {raw_hostname}",
                {"hostname": host_norm},
                tool=safe_tool,
            )

        if allowed_hosts is not None and not _is_host_allowed(host_norm, allowed_hosts):
            return error_envelope(
                "SSRF_HOST_NOT_ALLOWED",
                f"Host '{raw_hostname}' is not in allowed_hosts",
                {"hostname": host_norm},
                tool=safe_tool,
            )

        # Direct IP literal check before DNS lookup
        literal_ip: ipaddress.IPv4Address | ipaddress.IPv6Address | None = None
        try:
            literal_ip = ipaddress.ip_address(host_norm)
        except ValueError:
            if _looks_like_noncanonical_ip_literal(host_norm):
                return error_envelope(
                    "SSRF_PRIVATE_IP",
                    f"Blocked non-canonical IP literal: {raw_hostname}",
                    {"hostname": host_norm},
                    tool=safe_tool,
                )

        if literal_ip is not None:
            canonical_ip = str(literal_ip)
            if is_private_or_reserved_ip(
                canonical_ip,
                allow_private_lan=allow_private_lan,
                allow_tailscale=allow_tailscale,
            ):
                return error_envelope(
                    "SSRF_PRIVATE_IP",
                    f"Blocked private or reserved IP address: {canonical_ip}",
                    {"hostname": host_norm, "blocked_ip": canonical_ip},
                    tool=safe_tool,
                )
            return ok_envelope(
                safe_tool,
                f"Validated outbound URL for {host_norm}",
                {
                    "url": trimmed_url,
                    "scheme": scheme,
                    "hostname": host_norm,
                    "port": effective_port,
                    "resolved_addresses": [canonical_ip],
                },
            )

        # Resolve all DNS records and fail closed if ANY record is private/reserved
        try:
            if lookup_fn is not None:
                raw_records = lookup_fn(host_norm)
                if raw_records is None or isinstance(raw_records, (str, bytes)):
                    raise ValueError("lookup_fn must return a sequence of IP strings")
                resolved_addresses = list(
                    dict.fromkeys(
                        ip.strip()
                        for ip in raw_records
                        if isinstance(ip, str) and ip.strip()
                    )
                )
            else:
                addr_infos = socket.getaddrinfo(
                    host_norm,
                    effective_port or 0,
                    type=socket.SOCK_STREAM,
                )
                resolved_addresses = list(
                    dict.fromkeys(
                        str(info[4][0])
                        for info in addr_infos
                        if info and len(info) >= 5 and info[4]
                    )
                )
        except Exception as exc:
            return error_envelope(
                "SSRF_DNS_FAILED",
                f"DNS resolution failed for '{raw_hostname}': {exc}",
                {"hostname": host_norm},
                tool=safe_tool,
            )

        if not resolved_addresses:
            return error_envelope(
                "SSRF_DNS_FAILED",
                f"DNS resolution returned no addresses for '{raw_hostname}'",
                {"hostname": host_norm},
                tool=safe_tool,
            )

        for candidate_ip in resolved_addresses:
            if is_private_or_reserved_ip(
                candidate_ip,
                allow_private_lan=allow_private_lan,
                allow_tailscale=allow_tailscale,
            ):
                return error_envelope(
                    "SSRF_PRIVATE_IP",
                    f"Host '{raw_hostname}' resolved to blocked address {candidate_ip}",
                    {
                        "hostname": host_norm,
                        "blocked_ip": candidate_ip,
                        "resolved_addresses": resolved_addresses,
                    },
                    tool=safe_tool,
                )

        return ok_envelope(
            safe_tool,
            f"Validated outbound URL for {host_norm}",
            {
                "url": trimmed_url,
                "scheme": scheme,
                "hostname": host_norm,
                "port": effective_port,
                "resolved_addresses": resolved_addresses,
            },
        )
    except Exception:
        return error_envelope("SSRF_INVALID_URL", "Invalid or malformed outbound URL", tool=safe_tool)
