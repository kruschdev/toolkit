"""
SSRF-Guarded, Bounded, Single-Flight Circuit-Broken HTTP Client Lego Bricks (`INV-LEGO-21`, `INV-LEGO-01`).

Imports cleanly in bare Python 3.11+ stdlib without `httpx` installed. `httpx` is imported lazily
only when executing default network transport (`client is None` and `send_fn is None`).
"""

from __future__ import annotations

import asyncio
import inspect
import ipaddress
import json
import math
import random
import re
import socket
import threading
import time
import uuid
from collections import OrderedDict
from collections.abc import AsyncIterable, Callable, Iterable, Mapping, Sequence
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from typing import Any
from urllib.parse import urljoin, urlsplit, urlunsplit

from krusch_toolkit.fastapi_app import error_envelope, ok_envelope
from krusch_toolkit.security import is_private_or_reserved_ip, validate_outbound_url

__all__ = [
    "HttpCircuitBreaker",
    "create_http_circuit_breaker",
    "compute_retry_delay",
    "build_resilient_headers",
    "request_json",
    "async_request_json",
]

_UNSET: Any = object()

_MAX_HEADER_LENGTH = 4096
_MAX_URL_LENGTH = 8192
_STREAM_CHUNK_BYTES = 65_536
_ERROR_PREVIEW_CHARS = 1024

_HEADER_NAME_RE = re.compile(r"^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")
_NUMERIC_OR_HEX_LABEL_RE = re.compile(r"(?:0x[0-9a-f]+|\d+)", re.IGNORECASE)

_ALLOWED_HTTP_METHODS = frozenset({"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"})
_IDEMPOTENT_METHODS = frozenset({"GET", "HEAD", "OPTIONS", "PUT", "DELETE"})
_REDIRECT_STATUSES = frozenset({301, 302, 303, 307, 308})
_RETRYABLE_STATUSES = frozenset({408, 429, 502, 503, 504})
_CROSS_ORIGIN_SENSITIVE_HEADERS = frozenset(
    {"authorization", "cookie", "x-api-key", "proxy-authorization", "host"}
)
_BODY_HEADERS_TO_STRIP = frozenset({"content-type", "content-length", "transfer-encoding"})

_LOOPBACK_IPV4_NETWORK = ipaddress.IPv4Network("127.0.0.0/8")
_LOOPBACK_IPV6_ADDRESS = ipaddress.IPv6Address("::1")

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

_TIMEOUT_CLASS_NAMES = frozenset(
    {
        "TimeoutException",
        "ConnectTimeout",
        "ReadTimeout",
        "WriteTimeout",
        "PoolTimeout",
    }
)


def _safe_tool_name(tool: Any, default: str) -> str:
    return tool.strip() if isinstance(tool, str) and tool.strip() else default


def _is_valid_int(val: Any) -> bool:
    return isinstance(val, int) and not isinstance(val, bool)


def _is_finite_number(val: Any) -> bool:
    if not isinstance(val, (int, float)) or isinstance(val, bool):
        return False
    try:
        return math.isfinite(float(val))
    except (OverflowError, TypeError, ValueError):
        return False


def _has_forbidden_header_chars(val: str) -> bool:
    return any((ord(ch) < 0x20 and ch != "\t") or ord(ch) >= 0x7F for ch in val)


def _normalize_breaker_key(key: Any) -> str:
    if key is None or isinstance(key, bool):
        return "default"
    cleaned = str(key).strip().lower()
    return cleaned[:256] if cleaned else "default"


def _reject_nonfinite_json_constant(token: str) -> Any:
    raise ValueError(f"Non-finite JSON constant '{token}' is forbidden")


def _try_parse_ip(host_norm: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address | None:
    try:
        return ipaddress.ip_address(host_norm)
    except ValueError:
        return None


def _looks_like_noncanonical_ip_literal(host_norm: str) -> bool:
    parts = host_norm.split(".")
    return bool(parts) and all(_NUMERIC_OR_HEX_LABEL_RE.fullmatch(part) is not None for part in parts)


def _normalize_allowed_host_entry(entry: Any) -> str | None:
    if not isinstance(entry, str) or not entry.strip():
        return None
    pattern = entry.strip().lower().rstrip(".")
    if pattern.startswith("[") and pattern.endswith("]"):
        pattern = pattern[1:-1]
    if not pattern:
        return None
    wildcard = False
    if pattern.startswith("*.") and len(pattern) > 2:
        wildcard = True
        pattern = pattern[2:]
    if _try_parse_ip(pattern) is not None:
        return f"*.{pattern}" if wildcard else pattern
    if not pattern.isascii():
        try:
            pattern = pattern.encode("idna").decode("ascii").strip().lower().rstrip(".")
        except UnicodeError:
            return None
    if not pattern:
        return None
    return f"*.{pattern}" if wildcard else pattern


def _normalize_allowed_hosts(allowed_hosts: Sequence[str] | None) -> tuple[str, ...] | None:
    if allowed_hosts is None:
        return None
    normalized: list[str] = []
    for entry in allowed_hosts:
        norm_entry = _normalize_allowed_host_entry(entry)
        if norm_entry is not None:
            normalized.append(norm_entry)
    return tuple(normalized)


def _is_host_allowed(host_norm: str, allowed_hosts: Sequence[str]) -> bool:
    for entry in allowed_hosts:
        pattern = _normalize_allowed_host_entry(entry)
        if pattern is None:
            continue
        if pattern.startswith("*.") and len(pattern) > 2:
            suffix = pattern[1:]
            if host_norm.endswith(suffix) and len(host_norm) > len(suffix):
                return True
        elif host_norm == pattern:
            return True
    return False


def _load_httpx() -> Any:
    import httpx

    if httpx is None:  # pragma: no cover - defensive guard for sys.modules['httpx'] = None
        raise ModuleNotFoundError("httpx module is disabled")
    return httpx


def _is_timeout_exception(exc: BaseException) -> bool:
    if isinstance(exc, TimeoutError):
        return True
    return any(cls.__name__ in _TIMEOUT_CLASS_NAMES for cls in type(exc).__mro__)


class HttpCircuitBreaker:
    """
    Thread-safe bounded per-host HTTP circuit breaker with single-flight `HALF_OPEN` probing (`INV-LEGO-21`).
    """

    def __init__(
        self,
        failure_threshold: int = 3,
        cooldown_seconds: float = 30.0,
        max_hosts: int = 64,
        clock_fn: Callable[[], float] = time.monotonic,
    ) -> None:
        if _is_finite_number(failure_threshold):
            self._failure_threshold = max(1, int(failure_threshold))
        else:
            self._failure_threshold = 3

        if _is_finite_number(cooldown_seconds) and float(cooldown_seconds) > 0.0:
            self._cooldown_seconds = float(cooldown_seconds)
        else:
            self._cooldown_seconds = 30.0

        if _is_finite_number(max_hosts):
            self._max_hosts = max(1, int(max_hosts))
        else:
            self._max_hosts = 64

        self._clock_fn: Callable[[], float] = clock_fn if callable(clock_fn) else time.monotonic
        self._lock = threading.Lock()
        self._hosts: OrderedDict[str, dict[str, Any]] = OrderedDict()

    @property
    def failure_threshold(self) -> int:
        return self._failure_threshold

    @property
    def cooldown_seconds(self) -> float:
        return self._cooldown_seconds

    @property
    def max_hosts(self) -> int:
        return self._max_hosts

    def _now(self) -> float:
        try:
            raw = self._clock_fn()
            if _is_finite_number(raw):
                return float(raw)
        except Exception:
            return time.monotonic()
        return time.monotonic()

    def _evict_overflow_unlocked(self) -> None:
        while len(self._hosts) > self._max_hosts:
            self._hosts.popitem(last=False)

    def _format_state_unlocked(self, norm_key: str) -> dict[str, Any]:
        entry = self._hosts.get(norm_key)
        if entry is None:
            return {
                "key": norm_key,
                "state": "CLOSED",
                "failures": 0,
                "opened_at": None,
                "last_error": None,
                "probe_in_flight": False,
                "retry_after_seconds": 0.0,
            }

        state = entry["state"]
        if state == "OPEN":
            now = self._now()
            opened_at = entry["opened_at"] if entry["opened_at"] is not None else now
            elapsed = max(0.0, now - opened_at)
            if elapsed >= self._cooldown_seconds:
                return {
                    "key": norm_key,
                    "state": "HALF_OPEN",
                    "failures": entry["failures"],
                    "opened_at": entry["opened_at"],
                    "last_error": entry["last_error"],
                    "probe_in_flight": False,
                    "retry_after_seconds": 0.0,
                }
            return {
                "key": norm_key,
                "state": "OPEN",
                "failures": entry["failures"],
                "opened_at": entry["opened_at"],
                "last_error": entry["last_error"],
                "probe_in_flight": False,
                "retry_after_seconds": round(max(0.0, self._cooldown_seconds - elapsed), 3),
            }

        if state == "HALF_OPEN":
            in_flight = bool(entry["probe_in_flight"])
            return {
                "key": norm_key,
                "state": "HALF_OPEN",
                "failures": entry["failures"],
                "opened_at": entry["opened_at"],
                "last_error": entry["last_error"],
                "probe_in_flight": in_flight,
                "retry_after_seconds": round(self._cooldown_seconds, 3) if in_flight else 0.0,
            }

        return {
            "key": norm_key,
            "state": "CLOSED",
            "failures": entry["failures"],
            "opened_at": entry["opened_at"],
            "last_error": entry["last_error"],
            "probe_in_flight": False,
            "retry_after_seconds": 0.0,
        }

    def can_attempt(self, key: str) -> dict[str, Any]:
        """Check whether `key` may be attempted, acquiring a single-flight probe if entering `HALF_OPEN`."""
        norm_key = _normalize_breaker_key(key)
        with self._lock:
            entry = self._hosts.get(norm_key)
            if entry is None or entry["state"] == "CLOSED":
                return {
                    "allowed": True,
                    "state": "CLOSED",
                    "probe": False,
                    "retry_after_seconds": 0.0,
                }

            now = self._now()
            if entry["state"] == "OPEN":
                opened_at = entry["opened_at"] if entry["opened_at"] is not None else now
                elapsed = now - opened_at
                if elapsed >= self._cooldown_seconds:
                    entry["state"] = "HALF_OPEN"
                    entry["probe_in_flight"] = True
                    return {
                        "allowed": True,
                        "state": "HALF_OPEN",
                        "probe": True,
                        "retry_after_seconds": 0.0,
                    }
                remaining = round(max(0.0, self._cooldown_seconds - elapsed), 3)
                return {
                    "allowed": False,
                    "state": "OPEN",
                    "probe": False,
                    "retry_after_seconds": remaining,
                }

            # HALF_OPEN
            if entry["probe_in_flight"]:
                return {
                    "allowed": False,
                    "state": "HALF_OPEN",
                    "probe": False,
                    "retry_after_seconds": round(self._cooldown_seconds, 3),
                }
            entry["probe_in_flight"] = True
            return {
                "allowed": True,
                "state": "HALF_OPEN",
                "probe": True,
                "retry_after_seconds": 0.0,
            }

    def record_success(self, key: str) -> dict[str, Any]:
        """Reset host state to `CLOSED` with zero consecutive failures."""
        norm_key = _normalize_breaker_key(key)
        with self._lock:
            self._hosts[norm_key] = {
                "state": "CLOSED",
                "failures": 0,
                "opened_at": None,
                "last_error": None,
                "probe_in_flight": False,
            }
            self._hosts.move_to_end(norm_key)
            self._evict_overflow_unlocked()
            return self._format_state_unlocked(norm_key)

    def record_failure(self, key: str, reason: str = "") -> dict[str, Any]:
        """Record an upstream failure and trip `OPEN` if threshold is reached or `HALF_OPEN` probe failed."""
        norm_key = _normalize_breaker_key(key)
        clean_reason = str(reason).strip() if reason is not None else ""
        last_error = clean_reason or "upstream_failure"
        with self._lock:
            existing = self._hosts.get(norm_key)
            prev_failures = existing["failures"] if existing is not None else 0
            prev_state = existing["state"] if existing is not None else "CLOSED"
            next_failures = prev_failures + 1

            if prev_state == "HALF_OPEN" or next_failures >= self._failure_threshold:
                self._hosts[norm_key] = {
                    "state": "OPEN",
                    "failures": next_failures,
                    "opened_at": self._now(),
                    "last_error": last_error,
                    "probe_in_flight": False,
                }
            else:
                self._hosts[norm_key] = {
                    "state": "CLOSED",
                    "failures": next_failures,
                    "opened_at": None,
                    "last_error": last_error,
                    "probe_in_flight": False,
                }
            self._hosts.move_to_end(norm_key)
            self._evict_overflow_unlocked()
            return self._format_state_unlocked(norm_key)

    def release_probe(self, key: str) -> None:
        """Release an in-flight `HALF_OPEN` probe without recording a failure (cancellation-safe)."""
        norm_key = _normalize_breaker_key(key)
        with self._lock:
            entry = self._hosts.get(norm_key)
            if entry is not None and entry["state"] == "HALF_OPEN" and entry["probe_in_flight"]:
                entry["probe_in_flight"] = False

    def get_state(self, key: str) -> dict[str, Any]:
        """Inspect host circuit state without mutating single-flight probe tokens."""
        norm_key = _normalize_breaker_key(key)
        with self._lock:
            return self._format_state_unlocked(norm_key)

    def snapshot(self) -> dict[str, dict[str, Any]]:
        """Return a shallow snapshot of all tracked host circuit states."""
        with self._lock:
            return {k: self._format_state_unlocked(k) for k in self._hosts}

    def reset(self, key: str) -> None:
        """Remove tracking state for `key`."""
        norm_key = _normalize_breaker_key(key)
        with self._lock:
            self._hosts.pop(norm_key, None)

    def clear(self) -> None:
        """Clear all tracked host circuit states."""
        with self._lock:
            self._hosts.clear()


def create_http_circuit_breaker(
    failure_threshold: int = 3,
    cooldown_seconds: float = 30.0,
    max_hosts: int = 64,
    clock_fn: Callable[[], float] = time.monotonic,
) -> HttpCircuitBreaker:
    """Factory helper returning a configured `HttpCircuitBreaker`."""
    return HttpCircuitBreaker(
        failure_threshold=failure_threshold,
        cooldown_seconds=cooldown_seconds,
        max_hosts=max_hosts,
        clock_fn=clock_fn,
    )


def _parse_retry_after_seconds(raw_header: str, safe_max_delay: float) -> float | None:
    text = raw_header.strip()
    if not text or len(text) > 256:
        return None

    try:
        numeric = float(text)
    except ValueError:
        numeric = None

    if numeric is not None:
        if math.isfinite(numeric) and numeric >= 0.0:
            return float(min(safe_max_delay, max(0.0, numeric)))
        return None

    try:
        parsed_dt = parsedate_to_datetime(text)
    except (TypeError, ValueError, OverflowError):
        return None

    if parsed_dt is None:
        return None
    if parsed_dt.tzinfo is None:
        parsed_dt = parsed_dt.replace(tzinfo=UTC)
    delta = (parsed_dt - datetime.now(UTC)).total_seconds()
    if not math.isfinite(delta):
        return None
    return float(min(safe_max_delay, max(0.0, delta)))


def compute_retry_delay(
    attempt: int,
    *,
    base_delay: float = 0.25,
    max_delay: float = 5.0,
    retry_after_header: str | None = None,
    jitter_ratio: float = 0.0,
    rng_fn: Callable[[], float] = random.random,
) -> float:
    """
    Compute bounded exponential backoff delay in seconds, honoring `Retry-After` headers when valid.
    Never raises; safely normalizes `bool`, `NaN`, and `Inf` inputs.
    """
    try:
        safe_max = max(0.0, float(max_delay)) if _is_finite_number(max_delay) else 5.0
        safe_base = max(0.0, float(base_delay)) if _is_finite_number(base_delay) else 0.25
        safe_attempt = max(1, int(attempt)) if _is_finite_number(attempt) else 1

        if isinstance(retry_after_header, str):
            parsed_ra = _parse_retry_after_seconds(retry_after_header, safe_max)
            if parsed_ra is not None:
                return parsed_ra

        exp = min(62, max(0, safe_attempt - 1))
        delay = min(safe_max, safe_base * float(1 << exp))

        safe_jitter = min(1.0, max(0.0, float(jitter_ratio))) if _is_finite_number(jitter_ratio) else 0.0
        if safe_jitter > 0.0 and callable(rng_fn):
            raw_rng = rng_fn()
            if _is_finite_number(raw_rng):
                clamped_rng = min(1.0, max(0.0, float(raw_rng)))
                delay = delay * (1.0 - safe_jitter + safe_jitter * clamped_rng)

        result = float(min(safe_max, max(0.0, delay)))
        return result if math.isfinite(result) else 0.0
    except Exception:
        return 0.0


def build_resilient_headers(
    headers: Mapping[str, str] | None = None,
    *,
    api_key: str | None = None,
    bearer_token: str | None = None,
    request_id: str | None = None,
    accept_json: bool = True,
    tool: str = "http_client.headers",
) -> dict[str, Any]:
    """
    Validate and assemble outbound HTTP headers with CR/LF/NUL injection guards (`INV-LEGO-21`, `INV-LEGO-01`).
    """
    safe_tool = _safe_tool_name(tool, "http_client.headers")

    out_headers: dict[str, str] = {}
    seen_lower: dict[str, str] = {}

    if headers is not None:
        if not isinstance(headers, Mapping):
            return error_envelope(
                "HTTP_INVALID_HEADER",
                "headers must be a mapping of string names to string values",
                tool=safe_tool,
            )
        for raw_name, raw_value in headers.items():
            if not isinstance(raw_name, str) or not isinstance(raw_value, str):
                return error_envelope(
                    "HTTP_INVALID_HEADER",
                    "All HTTP header names and values must be strings",
                    tool=safe_tool,
                )
            if (
                not raw_name
                or len(raw_name) > _MAX_HEADER_LENGTH
                or _has_forbidden_header_chars(raw_name)
                or not _HEADER_NAME_RE.fullmatch(raw_name)
            ):
                return error_envelope(
                    "HTTP_INVALID_HEADER",
                    f"Invalid HTTP header name: {raw_name!r}",
                    tool=safe_tool,
                )
            if len(raw_value) > _MAX_HEADER_LENGTH or _has_forbidden_header_chars(raw_value):
                return error_envelope(
                    "HTTP_INVALID_HEADER",
                    f"Invalid HTTP header value for '{raw_name}'",
                    tool=safe_tool,
                )
            lower_name = raw_name.lower()
            if lower_name in seen_lower:
                prev_key = seen_lower[lower_name]
                if prev_key != raw_name:
                    out_headers.pop(prev_key, None)
            out_headers[raw_name] = raw_value
            seen_lower[lower_name] = raw_name

    for label, candidate in (
        ("request_id", request_id),
        ("api_key", api_key),
        ("bearer_token", bearer_token),
    ):
        if candidate is not None and (
            not isinstance(candidate, str)
            or len(candidate) > _MAX_HEADER_LENGTH
            or _has_forbidden_header_chars(candidate)
        ):
            return error_envelope(
                "HTTP_INVALID_HEADER",
                f"Invalid {label} value for HTTP header",
                tool=safe_tool,
            )

    clean_req_id = request_id.strip() if isinstance(request_id, str) and request_id.strip() else ""
    if "x-request-id" in seen_lower:
        existing_key = seen_lower["x-request-id"]
        existing_val = out_headers[existing_key].strip()
        if existing_val:
            resolved_req_id = existing_val
        else:
            resolved_req_id = clean_req_id or str(uuid.uuid4())
            out_headers[existing_key] = resolved_req_id
    else:
        resolved_req_id = clean_req_id or str(uuid.uuid4())
        out_headers["X-Request-ID"] = resolved_req_id
        seen_lower["x-request-id"] = "X-Request-ID"

    if bool(accept_json) and "accept" not in seen_lower:
        out_headers["Accept"] = "application/json"
        seen_lower["accept"] = "Accept"

    if isinstance(api_key, str) and api_key.strip() and "x-api-key" not in seen_lower:
        out_headers["X-API-Key"] = api_key.strip()
        seen_lower["x-api-key"] = "X-API-Key"

    if isinstance(bearer_token, str) and bearer_token.strip() and "authorization" not in seen_lower:
        auth_val = f"Bearer {bearer_token.strip()}"
        if len(auth_val) > _MAX_HEADER_LENGTH:
            return error_envelope(
                "HTTP_INVALID_HEADER",
                "Bearer Authorization header exceeds maximum length",
                tool=safe_tool,
            )
        out_headers["Authorization"] = auth_val
        seen_lower["authorization"] = "Authorization"

    return ok_envelope(
        safe_tool,
        "Constructed resilient HTTP headers",
        {"headers": out_headers, "request_id": resolved_req_id},
    )


def _preparse_url_structure(raw_url: Any, safe_tool: str) -> dict[str, Any]:
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

    try:
        parsed = urlsplit(trimmed_url)
    except ValueError:
        return error_envelope("SSRF_INVALID_URL", "Invalid or malformed outbound URL", tool=safe_tool)
    scheme = parsed.scheme.lower().rstrip(":")
    if not scheme:
        return error_envelope("SSRF_INVALID_URL", "Outbound URL is missing a scheme", tool=safe_tool)
    if scheme not in {"http", "https"}:
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
    if not raw_hostname or "%" in raw_hostname or any(ch.isspace() for ch in raw_hostname):
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

    effective_port = explicit_port if explicit_port is not None else (443 if scheme == "https" else 80)

    if _try_parse_ip(host_norm) is None:
        if len(host_norm) > 253 or ".." in host_norm or host_norm.startswith("."):
            return error_envelope("SSRF_INVALID_URL", "Malformed outbound URL hostname", tool=safe_tool)
        try:
            idna_bytes = host_norm.encode("idna")
        except UnicodeError:
            return error_envelope("SSRF_INVALID_URL", "Malformed outbound URL hostname", tool=safe_tool)
        if not idna_bytes or len(idna_bytes) > 253:
            return error_envelope("SSRF_INVALID_URL", "Malformed outbound URL hostname", tool=safe_tool)
        host_ascii = idna_bytes.decode("ascii").strip().lower().rstrip(".")
        if (
            not host_ascii
            or len(host_ascii) > 253
            or ".." in host_ascii
            or host_ascii.startswith(".")
            or any(ord(ch) <= 0x20 or ord(ch) >= 0x7F or ch in "/\\?#@%[]" for ch in host_ascii)
        ):
            return error_envelope("SSRF_INVALID_URL", "Malformed outbound URL hostname", tool=safe_tool)

        if not host_norm.isascii() and (
            _try_parse_ip(host_ascii) is not None
            or _looks_like_noncanonical_ip_literal(host_ascii)
            or host_ascii in _ALWAYS_BLOCKED_HOSTS
            or host_ascii.endswith(".localhost")
            or host_ascii.endswith(".metadata.google.internal")
        ):
            return error_envelope(
                "SSRF_PRIVATE_IP",
                f"Blocked non-ASCII loopback, metadata, or IP literal host: {raw_hostname}",
                {"hostname": host_ascii},
                tool=safe_tool,
            )

        if host_norm != host_ascii:
            canonical_netloc = f"{host_ascii}:{explicit_port}" if explicit_port is not None else host_ascii
            trimmed_url = urlunsplit((scheme, canonical_netloc, parsed.path, parsed.query, parsed.fragment))
            host_norm = host_ascii

    return ok_envelope(
        safe_tool,
        "Parsed URL structure",
        {
            "trimmed_url": trimmed_url,
            "scheme": scheme,
            "raw_hostname": raw_hostname,
            "host_norm": host_norm,
            "explicit_port": explicit_port,
            "effective_port": effective_port,
        },
    )


def _is_canonical_loopback_ip(ip_str: str) -> str | None:
    if not isinstance(ip_str, str):
        return None
    clean = ip_str.strip()
    if not clean or "%" in clean or any(ch.isspace() for ch in clean):
        return None
    addr = _try_parse_ip(clean)
    if addr is None:
        return None
    if isinstance(addr, ipaddress.IPv4Address):
        if str(addr) == clean and addr in _LOOPBACK_IPV4_NETWORK:
            return str(addr)
        return None
    if addr == _LOOPBACK_IPV6_ADDRESS and addr.ipv4_mapped is None:
        return str(addr)
    return None


def _check_explicit_loopback_target(
    parsed_info: Mapping[str, Any],
    *,
    allowed_hosts: Sequence[str] | None,
    allow_private_lan: bool,
    allow_tailscale: bool,
    resolved_from_lookup: Sequence[str] | None,
    safe_tool: str,
) -> dict[str, Any] | None:
    host_norm: str = parsed_info["host_norm"]
    raw_hostname: str = parsed_info["raw_hostname"]
    trimmed_url: str = parsed_info["trimmed_url"]
    scheme: str = parsed_info["scheme"]
    explicit_port: int | None = parsed_info["explicit_port"]
    effective_port: int = parsed_info["effective_port"]

    canonical_loopback = _is_canonical_loopback_ip(host_norm)
    is_localhost_name = host_norm == "localhost"

    if not is_localhost_name and canonical_loopback is None:
        return None

    if allowed_hosts is not None and not _is_host_allowed(host_norm, allowed_hosts):
        return error_envelope(
            "SSRF_HOST_NOT_ALLOWED",
            f"Host '{raw_hostname}' is not in allowed_hosts",
            {"hostname": host_norm},
            tool=safe_tool,
        )

    if canonical_loopback is not None:
        return ok_envelope(
            safe_tool,
            f"Validated loopback URL for {host_norm}",
            {
                "url": trimmed_url,
                "scheme": scheme,
                "hostname": host_norm,
                "port": effective_port,
                "explicit_port": explicit_port,
                "resolved_addresses": [canonical_loopback],
            },
        )

    # host_norm == "localhost"
    if resolved_from_lookup is not None:
        deduped = list(
            dict.fromkeys(ip.strip() for ip in resolved_from_lookup if isinstance(ip, str) and ip.strip())
        )
        if not deduped:
            return error_envelope(
                "SSRF_DNS_FAILED",
                "DNS resolution returned no addresses for 'localhost'",
                {"hostname": host_norm},
                tool=safe_tool,
            )
        verified_ips: list[str] = []
        for candidate_ip in deduped:
            canon_lb = _is_canonical_loopback_ip(candidate_ip)
            if canon_lb is not None:
                verified_ips.append(canon_lb)
            elif not is_private_or_reserved_ip(
                candidate_ip,
                allow_private_lan=allow_private_lan,
                allow_tailscale=allow_tailscale,
            ):
                verified_ips.append(candidate_ip)
            else:
                return error_envelope(
                    "SSRF_PRIVATE_IP",
                    f"Host 'localhost' resolved to blocked address {candidate_ip}",
                    {"hostname": host_norm, "blocked_ip": candidate_ip},
                    tool=safe_tool,
                )
        resolved_addrs = verified_ips
    else:
        resolved_addrs = ["127.0.0.1"]

    return ok_envelope(
        safe_tool,
        f"Validated loopback URL for {host_norm}",
        {
            "url": trimmed_url,
            "scheme": scheme,
            "hostname": host_norm,
            "port": effective_port,
            "explicit_port": explicit_port,
            "resolved_addresses": resolved_addrs,
        },
    )


def _validate_hop_url_sync(
    raw_url: Any,
    *,
    allow_private_lan: bool,
    allow_tailscale: bool,
    allow_loopback: bool,
    allowed_hosts: Sequence[str] | None,
    lookup_fn: Callable[[str], Sequence[str]] | None,
    safe_tool: str,
) -> dict[str, Any]:
    pre = _preparse_url_structure(raw_url, safe_tool)
    if not pre["ok"]:
        return pre
    pinfo = pre["data"]

    norm_allowed_hosts = _normalize_allowed_hosts(allowed_hosts)

    if allow_loopback:
        lookup_records: Sequence[str] | None = None
        if pinfo["host_norm"] == "localhost" and lookup_fn is not None:
            try:
                raw_records = lookup_fn("localhost")
                if raw_records is None or isinstance(raw_records, (str, bytes)):
                    raise ValueError("lookup_fn must return a sequence of IP strings")
                lookup_records = list(raw_records)
            except Exception as exc:
                return error_envelope(
                    "SSRF_DNS_FAILED",
                    f"DNS resolution failed for 'localhost': {exc}",
                    {"hostname": "localhost"},
                    tool=safe_tool,
                )

        lb_res = _check_explicit_loopback_target(
            pinfo,
            allowed_hosts=norm_allowed_hosts,
            allow_private_lan=allow_private_lan,
            allow_tailscale=allow_tailscale,
            resolved_from_lookup=lookup_records,
            safe_tool=safe_tool,
        )
        if lb_res is not None:
            return lb_res

    res = validate_outbound_url(
        pinfo["trimmed_url"],
        allow_private_lan=allow_private_lan,
        allow_tailscale=allow_tailscale,
        allowed_hosts=norm_allowed_hosts,
        lookup_fn=lookup_fn,
        tool=safe_tool,
    )
    if res["ok"]:
        return ok_envelope(
            safe_tool,
            res["summary"],
            {**res["data"], "explicit_port": pinfo["explicit_port"]},
        )
    return res


def _needs_dns_lookup(host_norm: str, allowed_hosts: Sequence[str] | None) -> bool:
    if (
        host_norm in _ALWAYS_BLOCKED_HOSTS
        or host_norm.endswith(".localhost")
        or host_norm.endswith(".metadata.google.internal")
    ):
        return False
    if allowed_hosts is not None and not _is_host_allowed(host_norm, allowed_hosts):
        return False
    if _try_parse_ip(host_norm) is not None:
        return False
    return not _looks_like_noncanonical_ip_literal(host_norm)


async def _validate_hop_url_async(
    raw_url: Any,
    *,
    allow_private_lan: bool,
    allow_tailscale: bool,
    allow_loopback: bool,
    allowed_hosts: Sequence[str] | None,
    lookup_fn: Callable[[str], Any] | None,
    safe_tool: str,
) -> dict[str, Any]:
    pre = _preparse_url_structure(raw_url, safe_tool)
    if not pre["ok"]:
        return pre
    pinfo = pre["data"]
    host_norm: str = pinfo["host_norm"]
    effective_port: int = pinfo["effective_port"]
    norm_allowed_hosts = _normalize_allowed_hosts(allowed_hosts)

    if allow_loopback:
        lookup_records: Sequence[str] | None = None
        if host_norm == "localhost" and lookup_fn is not None:
            try:
                maybe_records = lookup_fn("localhost")
                raw_records = await maybe_records if inspect.isawaitable(maybe_records) else maybe_records
                if raw_records is None or isinstance(raw_records, (str, bytes)):
                    raise ValueError("lookup_fn must return a sequence of IP strings")
                lookup_records = list(raw_records)
            except Exception as exc:
                return error_envelope(
                    "SSRF_DNS_FAILED",
                    f"DNS resolution failed for 'localhost': {exc}",
                    {"hostname": "localhost"},
                    tool=safe_tool,
                )

        lb_res = _check_explicit_loopback_target(
            pinfo,
            allowed_hosts=norm_allowed_hosts,
            allow_private_lan=allow_private_lan,
            allow_tailscale=allow_tailscale,
            resolved_from_lookup=lookup_records,
            safe_tool=safe_tool,
        )
        if lb_res is not None:
            return lb_res

    sync_lookup: Callable[[str], Sequence[str]] | None = None
    if _needs_dns_lookup(host_norm, norm_allowed_hosts):
        if lookup_fn is not None:
            try:
                maybe_res = lookup_fn(host_norm)
                resolved_raw = await maybe_res if inspect.isawaitable(maybe_res) else maybe_res
                if resolved_raw is None or isinstance(resolved_raw, (str, bytes)):
                    raise ValueError("lookup_fn must return a sequence of IP strings")
                resolved_list = list(resolved_raw)

                def _custom_lookup(_h: str, _res: list[str] = resolved_list) -> Sequence[str]:
                    return _res

                sync_lookup = _custom_lookup
            except Exception as exc:

                def _fail_custom_lookup(_h: str, _err: Exception = exc) -> Sequence[str]:
                    raise _err

                sync_lookup = _fail_custom_lookup
        else:
            try:
                loop = asyncio.get_running_loop()
                addr_infos = await loop.getaddrinfo(
                    host_norm,
                    effective_port or 0,
                    type=socket.SOCK_STREAM,
                )
                resolved_ips = list(
                    dict.fromkeys(
                        str(info[4][0])
                        for info in addr_infos
                        if info and len(info) >= 5 and info[4]
                    )
                )

                def _async_dns_lookup(_h: str, _ips: list[str] = resolved_ips) -> Sequence[str]:
                    return _ips

                sync_lookup = _async_dns_lookup
            except Exception as exc:

                def _fail_async_dns(_h: str, _err: Exception = exc) -> Sequence[str]:
                    raise _err

                sync_lookup = _fail_async_dns

    res = validate_outbound_url(
        pinfo["trimmed_url"],
        allow_private_lan=allow_private_lan,
        allow_tailscale=allow_tailscale,
        allowed_hosts=norm_allowed_hosts,
        lookup_fn=sync_lookup,
        tool=safe_tool,
    )
    if res["ok"]:
        return ok_envelope(
            safe_tool,
            res["summary"],
            {**res["data"], "explicit_port": pinfo["explicit_port"]},
        )
    return res


def _build_hop_wire_target(
    validated_data: Mapping[str, Any],
    current_headers: Mapping[str, str],
    *,
    use_dns_pinning: bool,
) -> tuple[str, dict[str, str], dict[str, Any] | None]:
    clean_url: str = validated_data["url"]
    scheme: str = validated_data["scheme"]
    host_norm: str = validated_data["hostname"]
    effective_port: int = validated_data["port"]
    explicit_port: int | None = validated_data.get("explicit_port")
    resolved_addresses: Sequence[str] = validated_data.get("resolved_addresses") or ()

    wire_headers = dict(current_headers)
    if not use_dns_pinning or not resolved_addresses:
        return clean_url, wire_headers, None

    pinned_ip = resolved_addresses[0]
    ip_obj = _try_parse_ip(pinned_ip)
    if ip_obj is None:
        return clean_url, wire_headers, None

    ip_host = f"[{ip_obj}]" if isinstance(ip_obj, ipaddress.IPv6Address) else str(ip_obj)
    default_port = 443 if scheme == "https" else 80
    netloc = (
        ip_host
        if (explicit_port is None and effective_port == default_port)
        else f"{ip_host}:{effective_port}"
    )

    parsed = urlsplit(clean_url)
    connect_url = urlunsplit((scheme, netloc, parsed.path, parsed.query, ""))

    is_literal_ip = _try_parse_ip(host_norm) is not None
    ascii_host = host_norm
    if not is_literal_ip and not host_norm.isascii():
        try:
            ascii_host = host_norm.encode("idna").decode("ascii").strip().lower().rstrip(".")
        except UnicodeError:
            ascii_host = host_norm

    has_host_header = any(k.lower() == "host" for k in wire_headers)
    if not has_host_header:
        host_header_base = f"[{ascii_host}]" if ":" in ascii_host else ascii_host
        wire_headers["Host"] = (
            host_header_base
            if effective_port == default_port
            else f"{host_header_base}:{effective_port}"
        )

    extensions: dict[str, Any] | None = None
    if scheme == "https" and not is_literal_ip:
        extensions = {"sni_hostname": ascii_host}

    return connect_url, wire_headers, extensions


def _normalize_response_headers(raw_headers: Any) -> dict[str, str]:
    if raw_headers is None:
        return {}
    out: dict[str, str] = {}
    items_fn = getattr(raw_headers, "items", None)
    if callable(items_fn):
        for k, v in items_fn():
            lk = str(k).lower()
            sv = str(v)
            out[lk] = f"{out[lk]}, {sv}" if lk in out else sv
        return out
    if isinstance(raw_headers, Iterable) and not isinstance(raw_headers, (str, bytes)):
        for pair in raw_headers:
            if isinstance(pair, tuple) and len(pair) == 2:
                lk = str(pair[0]).lower()
                sv = str(pair[1])
                out[lk] = f"{out[lk]}, {sv}" if lk in out else sv
    return out


def _exceeds_declared_content_length(
    resp_headers: Mapping[str, str],
    max_response_bytes: int,
    method: str,
    status: int,
) -> int | None:
    if method == "HEAD" or status in {204, 304}:
        return None
    raw_cl = resp_headers.get("content-length")
    if not raw_cl:
        return None
    for part in raw_cl.split(","):
        token = part.strip()
        if not token:
            continue
        try:
            parsed_len = int(token, 10)
        except ValueError:
            continue
        if parsed_len > max_response_bytes:
            return parsed_len
    return None


class _ResponseTooLargeError(Exception):
    def __init__(self, observed_bytes: int, max_bytes: int) -> None:
        super().__init__(f"Response exceeded maximum size ({max_bytes} bytes)")
        self.observed_bytes = observed_bytes
        self.max_bytes = max_bytes


def _collect_sync_chunks(chunks: Iterable[Any], max_response_bytes: int) -> bytes:
    buf = bytearray()
    for chunk in chunks:
        if not chunk:
            continue
        chunk_bytes = chunk.encode("utf-8") if isinstance(chunk, str) else chunk
        if not isinstance(chunk_bytes, (bytes, bytearray, memoryview)):
            raise TypeError("Response stream yielded non-bytes chunk")
        next_len = len(buf) + len(chunk_bytes)
        if next_len > max_response_bytes:
            buf.clear()
            raise _ResponseTooLargeError(next_len, max_response_bytes)
        buf.extend(chunk_bytes)
    return bytes(buf)


async def _collect_async_chunks(chunks: AsyncIterable[Any], max_response_bytes: int) -> bytes:
    buf = bytearray()
    async for chunk in chunks:
        if not chunk:
            continue
        chunk_bytes = chunk.encode("utf-8") if isinstance(chunk, str) else chunk
        if not isinstance(chunk_bytes, (bytes, bytearray, memoryview)):
            raise TypeError("Async response stream yielded non-bytes chunk")
        next_len = len(buf) + len(chunk_bytes)
        if next_len > max_response_bytes:
            buf.clear()
            raise _ResponseTooLargeError(next_len, max_response_bytes)
        buf.extend(chunk_bytes)
    return bytes(buf)


def _extract_send_fn_sync_response(
    raw_resp: Any,
    method: str,
    max_response_bytes: int,
) -> tuple[int, dict[str, str], bytes]:
    if isinstance(raw_resp, Mapping):
        status = int(raw_resp.get("status", raw_resp.get("status_code", 200)))
        resp_headers = _normalize_response_headers(raw_resp.get("headers"))
        declared_over = _exceeds_declared_content_length(resp_headers, max_response_bytes, method, status)
        if declared_over is not None:
            raise _ResponseTooLargeError(declared_over, max_response_bytes)
        if status in _REDIRECT_STATUSES and resp_headers.get("location"):
            return status, resp_headers, b""

        body = raw_resp.get("body", b"")
        if body is None or method == "HEAD" or status == 204:
            return status, resp_headers, b""
        if isinstance(body, (bytes, bytearray, memoryview)):
            if len(body) > max_response_bytes:
                raise _ResponseTooLargeError(len(body), max_response_bytes)
            return status, resp_headers, bytes(body)
        if isinstance(body, str):
            encoded = body.encode("utf-8")
            if len(encoded) > max_response_bytes:
                raise _ResponseTooLargeError(len(encoded), max_response_bytes)
            return status, resp_headers, encoded
        if isinstance(body, Mapping):
            encoded_map = json.dumps(body, allow_nan=False).encode("utf-8")
            if len(encoded_map) > max_response_bytes:
                raise _ResponseTooLargeError(len(encoded_map), max_response_bytes)
            return status, resp_headers, encoded_map
        if isinstance(body, Iterable):
            return status, resp_headers, _collect_sync_chunks(body, max_response_bytes)
        raise TypeError("Unsupported send_fn response body type")

    close_fn = getattr(raw_resp, "close", None)
    try:
        status = int(raw_resp.status_code)
        resp_headers = _normalize_response_headers(getattr(raw_resp, "headers", None))
        declared_over = _exceeds_declared_content_length(resp_headers, max_response_bytes, method, status)
        if declared_over is not None:
            raise _ResponseTooLargeError(declared_over, max_response_bytes)
        if (status in _REDIRECT_STATUSES and resp_headers.get("location")) or method == "HEAD" or status == 204:
            return status, resp_headers, b""

        iter_bytes_fn = getattr(raw_resp, "iter_bytes", None)
        if callable(iter_bytes_fn):
            return status, resp_headers, _collect_sync_chunks(iter_bytes_fn(_STREAM_CHUNK_BYTES), max_response_bytes)

        raw_content = getattr(raw_resp, "content", b"")
        if isinstance(raw_content, (bytes, bytearray, memoryview)):
            if len(raw_content) > max_response_bytes:
                raise _ResponseTooLargeError(len(raw_content), max_response_bytes)
            return status, resp_headers, bytes(raw_content)
        raise TypeError("Unsupported send_fn response object")
    finally:
        if callable(close_fn):
            close_fn()


async def _extract_send_fn_async_response(
    raw_resp: Any,
    method: str,
    max_response_bytes: int,
) -> tuple[int, dict[str, str], bytes]:
    if isinstance(raw_resp, Mapping):
        status = int(raw_resp.get("status", raw_resp.get("status_code", 200)))
        resp_headers = _normalize_response_headers(raw_resp.get("headers"))
        declared_over = _exceeds_declared_content_length(resp_headers, max_response_bytes, method, status)
        if declared_over is not None:
            raise _ResponseTooLargeError(declared_over, max_response_bytes)
        if status in _REDIRECT_STATUSES and resp_headers.get("location"):
            return status, resp_headers, b""

        body = raw_resp.get("body", b"")
        if body is None or method == "HEAD" or status == 204:
            return status, resp_headers, b""
        if isinstance(body, (bytes, bytearray, memoryview)):
            if len(body) > max_response_bytes:
                raise _ResponseTooLargeError(len(body), max_response_bytes)
            return status, resp_headers, bytes(body)
        if isinstance(body, str):
            encoded = body.encode("utf-8")
            if len(encoded) > max_response_bytes:
                raise _ResponseTooLargeError(len(encoded), max_response_bytes)
            return status, resp_headers, encoded
        if isinstance(body, Mapping):
            encoded_map = json.dumps(body, allow_nan=False).encode("utf-8")
            if len(encoded_map) > max_response_bytes:
                raise _ResponseTooLargeError(len(encoded_map), max_response_bytes)
            return status, resp_headers, encoded_map
        if isinstance(body, AsyncIterable):
            return status, resp_headers, await _collect_async_chunks(body, max_response_bytes)
        if isinstance(body, Iterable):
            return status, resp_headers, _collect_sync_chunks(body, max_response_bytes)
        raise TypeError("Unsupported send_fn response body type")

    aclose_fn = getattr(raw_resp, "aclose", None)
    close_fn = getattr(raw_resp, "close", None)
    try:
        status = int(raw_resp.status_code)
        resp_headers = _normalize_response_headers(getattr(raw_resp, "headers", None))
        declared_over = _exceeds_declared_content_length(resp_headers, max_response_bytes, method, status)
        if declared_over is not None:
            raise _ResponseTooLargeError(declared_over, max_response_bytes)
        if (status in _REDIRECT_STATUSES and resp_headers.get("location")) or method == "HEAD" or status == 204:
            return status, resp_headers, b""

        aiter_bytes_fn = getattr(raw_resp, "aiter_bytes", None)
        if callable(aiter_bytes_fn):
            return (
                status,
                resp_headers,
                await _collect_async_chunks(aiter_bytes_fn(_STREAM_CHUNK_BYTES), max_response_bytes),
            )

        iter_bytes_fn = getattr(raw_resp, "iter_bytes", None)
        if callable(iter_bytes_fn):
            return status, resp_headers, _collect_sync_chunks(iter_bytes_fn(_STREAM_CHUNK_BYTES), max_response_bytes)

        raw_content = getattr(raw_resp, "content", b"")
        if isinstance(raw_content, (bytes, bytearray, memoryview)):
            if len(raw_content) > max_response_bytes:
                raise _ResponseTooLargeError(len(raw_content), max_response_bytes)
            return status, resp_headers, bytes(raw_content)
        raise TypeError("Unsupported send_fn response object")
    finally:
        if callable(aclose_fn):
            maybe_close = aclose_fn()
            if inspect.isawaitable(maybe_close):
                await maybe_close
        elif callable(close_fn):
            close_fn()


def _execute_client_stream_sync(
    active_client: Any,
    method: str,
    target_url: str,
    wire_headers: dict[str, str],
    body_bytes: bytes | None,
    timeout_seconds: float,
    max_response_bytes: int,
    extensions: dict[str, Any] | None,
) -> tuple[int, dict[str, str], bytes]:
    kwargs: dict[str, Any] = {
        "headers": wire_headers,
        "content": body_bytes,
        "timeout": timeout_seconds,
        "follow_redirects": False,
    }
    if extensions is not None:
        kwargs["extensions"] = extensions

    stream_fn = getattr(active_client, "stream", None)
    if callable(stream_fn):
        with stream_fn(method, target_url, **kwargs) as resp:
            status = int(resp.status_code)
            resp_headers = _normalize_response_headers(resp.headers)
            declared_over = _exceeds_declared_content_length(resp_headers, max_response_bytes, method, status)
            if declared_over is not None:
                raise _ResponseTooLargeError(declared_over, max_response_bytes)
            if (status in _REDIRECT_STATUSES and resp_headers.get("location")) or method == "HEAD" or status == 204:
                return status, resp_headers, b""
            data = _collect_sync_chunks(resp.iter_bytes(_STREAM_CHUNK_BYTES), max_response_bytes)
            return status, resp_headers, data

    req_fn = getattr(active_client, "request", None)
    if callable(req_fn):
        raw_resp = req_fn(method, target_url, **kwargs)
        return _extract_send_fn_sync_response(raw_resp, method, max_response_bytes)
    raise TypeError("client must expose a callable stream() or request() method")


async def _execute_client_stream_async(
    active_client: Any,
    method: str,
    target_url: str,
    wire_headers: dict[str, str],
    body_bytes: bytes | None,
    timeout_seconds: float,
    max_response_bytes: int,
    extensions: dict[str, Any] | None,
) -> tuple[int, dict[str, str], bytes]:
    kwargs: dict[str, Any] = {
        "headers": wire_headers,
        "content": body_bytes,
        "timeout": timeout_seconds,
        "follow_redirects": False,
    }
    if extensions is not None:
        kwargs["extensions"] = extensions

    stream_fn = getattr(active_client, "stream", None)
    if callable(stream_fn):
        async with stream_fn(method, target_url, **kwargs) as resp:
            status = int(resp.status_code)
            resp_headers = _normalize_response_headers(resp.headers)
            declared_over = _exceeds_declared_content_length(resp_headers, max_response_bytes, method, status)
            if declared_over is not None:
                raise _ResponseTooLargeError(declared_over, max_response_bytes)
            if (status in _REDIRECT_STATUSES and resp_headers.get("location")) or method == "HEAD" or status == 204:
                return status, resp_headers, b""
            data = await _collect_async_chunks(resp.aiter_bytes(_STREAM_CHUNK_BYTES), max_response_bytes)
            return status, resp_headers, data

    req_fn = getattr(active_client, "request", None)
    if callable(req_fn):
        maybe_resp = req_fn(method, target_url, **kwargs)
        raw_resp = await maybe_resp if inspect.isawaitable(maybe_resp) else maybe_resp
        return await _extract_send_fn_async_response(raw_resp, method, max_response_bytes)
    raise TypeError("client must expose a callable stream() or request() method")


def _validate_request_inputs(
    *,
    method: Any,
    headers: Mapping[str, str] | None,
    json_body: Any,
    timeout_seconds: Any,
    max_retries: Any,
    base_delay: Any,
    max_delay: Any,
    retry_on_post: Any,
    max_redirects: Any,
    max_response_bytes: Any,
    allow_private_lan: Any,
    allow_tailscale: Any,
    allow_loopback: Any,
    allowed_hosts: Any,
    lookup_fn: Any,
    breaker: Any,
    send_fn: Any,
    sleep_fn: Any,
    safe_tool: str,
) -> dict[str, Any]:
    if not _is_finite_number(timeout_seconds) or float(timeout_seconds) <= 0.0:
        return error_envelope("HTTP_INVALID_OPTIONS", "timeout_seconds must be a finite number > 0", tool=safe_tool)
    if not _is_valid_int(max_retries) or max_retries < 0:
        return error_envelope("HTTP_INVALID_OPTIONS", "max_retries must be an integer >= 0", tool=safe_tool)
    if not _is_finite_number(base_delay) or float(base_delay) < 0.0:
        return error_envelope("HTTP_INVALID_OPTIONS", "base_delay must be a finite number >= 0", tool=safe_tool)
    if not _is_finite_number(max_delay) or float(max_delay) < 0.0:
        return error_envelope("HTTP_INVALID_OPTIONS", "max_delay must be a finite number >= 0", tool=safe_tool)
    if not isinstance(retry_on_post, bool):
        return error_envelope("HTTP_INVALID_OPTIONS", "retry_on_post must be a boolean", tool=safe_tool)
    if not _is_valid_int(max_redirects) or max_redirects < 0:
        return error_envelope("HTTP_INVALID_OPTIONS", "max_redirects must be an integer >= 0", tool=safe_tool)
    if not _is_valid_int(max_response_bytes) or max_response_bytes <= 0:
        return error_envelope("HTTP_INVALID_OPTIONS", "max_response_bytes must be an integer > 0", tool=safe_tool)
    if (
        not isinstance(allow_private_lan, bool)
        or not isinstance(allow_tailscale, bool)
        or not isinstance(allow_loopback, bool)
    ):
        return error_envelope(
            "HTTP_INVALID_OPTIONS",
            "allow_private_lan, allow_tailscale, and allow_loopback must be booleans",
            tool=safe_tool,
        )
    if allowed_hosts is not None and (
        isinstance(allowed_hosts, (str, bytes)) or not isinstance(allowed_hosts, Sequence)
    ):
        return error_envelope("HTTP_INVALID_OPTIONS", "allowed_hosts must be a sequence of strings", tool=safe_tool)
    if lookup_fn is not None and not callable(lookup_fn):
        return error_envelope("HTTP_INVALID_OPTIONS", "lookup_fn must be callable", tool=safe_tool)
    if send_fn is not None and not callable(send_fn):
        return error_envelope("HTTP_INVALID_OPTIONS", "send_fn must be callable", tool=safe_tool)
    if sleep_fn is not None and not callable(sleep_fn):
        return error_envelope("HTTP_INVALID_OPTIONS", "sleep_fn must be callable", tool=safe_tool)
    if breaker is not None and not (
        callable(getattr(breaker, "can_attempt", None))
        and callable(getattr(breaker, "record_success", None))
        and callable(getattr(breaker, "record_failure", None))
        and callable(getattr(breaker, "release_probe", None))
    ):
        return error_envelope("HTTP_INVALID_OPTIONS", "Invalid circuit breaker instance", tool=safe_tool)

    if not isinstance(method, str) or method.strip().upper() not in _ALLOWED_HTTP_METHODS:
        return error_envelope("HTTP_INVALID_METHOD", f"Unsupported HTTP method: {method!r}", tool=safe_tool)
    norm_method = method.strip().upper()

    hdr_res = build_resilient_headers(headers, accept_json=True, tool=safe_tool)
    if not hdr_res["ok"]:
        return hdr_res
    prepared_headers: dict[str, str] = dict(hdr_res["data"]["headers"])

    body_bytes: bytes | None = None
    if json_body is not _UNSET:
        try:
            body_bytes = json.dumps(json_body, allow_nan=False).encode("utf-8")
        except (TypeError, ValueError, OverflowError, RecursionError) as exc:
            return error_envelope(
                "HTTP_INVALID_JSON_BODY",
                f"Failed to serialize json_body: {exc}",
                tool=safe_tool,
            )
        if not any(k.lower() == "content-type" for k in prepared_headers):
            prepared_headers["Content-Type"] = "application/json"

    return ok_envelope(
        safe_tool,
        "Validated request inputs",
        {
            "method": norm_method,
            "headers": prepared_headers,
            "body_bytes": body_bytes,
            "timeout_seconds": float(timeout_seconds),
            "base_delay": float(base_delay),
            "max_delay": float(max_delay),
        },
    )


def _decode_success_json_body(
    raw_bytes: bytes,
    *,
    status: int,
    method: str,
    url: str,
    attempts: int,
    safe_tool: str,
) -> tuple[bool, Any]:
    if status == 204 or method == "HEAD" or len(raw_bytes.strip()) == 0:
        return True, None
    try:
        text = raw_bytes.decode("utf-8")
    except UnicodeDecodeError as exc:
        return False, error_envelope(
            "HTTP_INVALID_JSON",
            f"Response body is not valid UTF-8: {exc}",
            details={"status": status, "url": url, "attempts": attempts},
            tool=safe_tool,
        )
    try:
        parsed = json.loads(text, parse_constant=_reject_nonfinite_json_constant)
    except (ValueError, RecursionError) as exc:
        return False, error_envelope(
            "HTTP_INVALID_JSON",
            f"Invalid JSON in HTTP {status} response: {exc}",
            details={"status": status, "url": url, "attempts": attempts},
            tool=safe_tool,
        )
    return True, parsed


def _decode_error_body_preview(raw_bytes: bytes) -> Any:
    if not raw_bytes:
        return None
    try:
        text = raw_bytes.decode("utf-8", errors="replace")
    except Exception:
        return None
    stripped = text.strip()
    if not stripped:
        return None
    try:
        return json.loads(stripped, parse_constant=_reject_nonfinite_json_constant)
    except (ValueError, RecursionError):
        return stripped[:_ERROR_PREVIEW_CHARS]


def _apply_redirect_transition(
    *,
    status: int,
    current_method: str,
    current_headers: dict[str, str],
    current_body_bytes: bytes | None,
    prev_origin: tuple[str, str, int],
    next_origin: tuple[str, str, int],
) -> tuple[str, dict[str, str], bytes | None]:
    next_headers = dict(current_headers)
    if prev_origin != next_origin:
        next_headers = {
            k: v for k, v in next_headers.items() if k.lower() not in _CROSS_ORIGIN_SENSITIVE_HEADERS
        }

    next_method = current_method
    next_body = current_body_bytes
    if status == 303 or (status in {301, 302} and current_method == "POST"):
        next_method = "GET"
        next_body = None
        next_headers = {k: v for k, v in next_headers.items() if k.lower() not in _BODY_HEADERS_TO_STRIP}

    return next_method, next_headers, next_body


def request_json(
    url: str,
    *,
    method: str = "GET",
    headers: Mapping[str, str] | None = None,
    json_body: Any = _UNSET,
    timeout_seconds: float = 15.0,
    max_retries: int = 2,
    base_delay: float = 0.25,
    max_delay: float = 5.0,
    retry_on_post: bool = False,
    max_redirects: int = 3,
    max_response_bytes: int = 5_242_880,
    allow_private_lan: bool = False,
    allow_tailscale: bool = False,
    allow_loopback: bool = False,
    allowed_hosts: Sequence[str] | None = None,
    lookup_fn: Callable[[str], Sequence[str]] | None = None,
    breaker: HttpCircuitBreaker | None = None,
    client: Any = None,
    send_fn: Callable[..., Any] | None = None,
    sleep_fn: Callable[..., Any] | None = None,
    tool: str = "http_client.request",
) -> dict[str, Any]:
    """
    Execute a synchronous SSRF-guarded, byte-bounded, circuit-broken JSON HTTP request (`INV-LEGO-21`).
    Never raises on untrusted inputs or transport errors; returns an `INV-LEGO-01` envelope.
    """
    safe_tool = _safe_tool_name(tool, "http_client.request")
    prep = _validate_request_inputs(
        method=method,
        headers=headers,
        json_body=json_body,
        timeout_seconds=timeout_seconds,
        max_retries=max_retries,
        base_delay=base_delay,
        max_delay=max_delay,
        retry_on_post=retry_on_post,
        max_redirects=max_redirects,
        max_response_bytes=max_response_bytes,
        allow_private_lan=allow_private_lan,
        allow_tailscale=allow_tailscale,
        allow_loopback=allow_loopback,
        allowed_hosts=allowed_hosts,
        lookup_fn=lookup_fn,
        breaker=breaker,
        send_fn=send_fn,
        sleep_fn=sleep_fn,
        safe_tool=safe_tool,
    )
    if not prep["ok"]:
        return prep

    pdata = prep["data"]
    current_method: str = pdata["method"]
    current_headers: dict[str, str] = pdata["headers"]
    current_body_bytes: bytes | None = pdata["body_bytes"]
    eff_timeout: float = pdata["timeout_seconds"]
    eff_base_delay: float = pdata["base_delay"]
    eff_max_delay: float = pdata["max_delay"]
    active_sleep = sleep_fn if sleep_fn is not None else time.sleep

    hop_val = _validate_hop_url_sync(
        url,
        allow_private_lan=allow_private_lan,
        allow_tailscale=allow_tailscale,
        allow_loopback=allow_loopback,
        allowed_hosts=allowed_hosts,
        lookup_fn=lookup_fn,
        safe_tool=safe_tool,
    )
    if not hop_val["ok"]:
        return hop_val

    validated = hop_val["data"]
    current_url: str = validated["url"]
    use_default_httpx = client is None and send_fn is None
    owned_client: Any = None

    try:
        redirect_count = 0
        total_attempts = 0

        while True:
            hop_scheme: str = validated["scheme"]
            hop_hostname: str = validated["hostname"]
            hop_port: int = validated["port"]
            breaker_key = f"{hop_scheme}://{hop_hostname}:{hop_port}"

            can_retry = current_method in _IDEMPOTENT_METHODS or (
                current_method == "POST" and retry_on_post is True
            )
            effective_max_retries = max_retries if can_retry else 0

            target_url, wire_headers, req_extensions = _build_hop_wire_target(
                validated,
                current_headers,
                use_dns_pinning=use_default_httpx,
            )

            hop_attempt = 0
            while True:
                probe_acquired = False
                probe_settled = False
                if breaker is not None:
                    gate = breaker.can_attempt(breaker_key)
                    if not gate.get("allowed", False):
                        return error_envelope(
                            "HTTP_CIRCUIT_OPEN",
                            f"Circuit breaker is {gate.get('state', 'OPEN')} for {breaker_key}",
                            details={"host": breaker_key, **gate},
                            tool=safe_tool,
                        )
                    probe_acquired = bool(gate.get("probe", False))

                if use_default_httpx and owned_client is None:
                    try:
                        httpx_mod = _load_httpx()
                        owned_client = httpx_mod.Client(
                            follow_redirects=False,
                            trust_env=False,
                            timeout=eff_timeout,
                        )
                    except ImportError:
                        if breaker is not None and probe_acquired:
                            breaker.release_probe(breaker_key)
                        return error_envelope(
                            "HTTP_CLIENT_UNAVAILABLE",
                            "httpx is not installed and no send_fn/client was provided",
                            tool=safe_tool,
                        )

                total_attempts += 1
                status = 0
                resp_headers: dict[str, str] = {}
                raw_bytes = b""
                transport_err: tuple[str, str, str] | None = None

                try:
                    if send_fn is not None:
                        raw_resp = send_fn(
                            current_method,
                            target_url,
                            wire_headers,
                            current_body_bytes,
                            eff_timeout,
                        )
                        status, resp_headers, raw_bytes = _extract_send_fn_sync_response(
                            raw_resp,
                            current_method,
                            max_response_bytes,
                        )
                    else:
                        active_client = owned_client if use_default_httpx else client
                        status, resp_headers, raw_bytes = _execute_client_stream_sync(
                            active_client,
                            current_method,
                            target_url,
                            wire_headers,
                            current_body_bytes,
                            eff_timeout,
                            max_response_bytes,
                            req_extensions,
                        )
                    if breaker is not None:
                        if status >= 500:
                            breaker.record_failure(breaker_key, f"http_{status}")
                        elif status < 400 or probe_acquired:
                            breaker.record_success(breaker_key)
                    probe_settled = True
                except _ResponseTooLargeError as too_large:
                    if breaker is not None and probe_acquired:
                        breaker.record_success(breaker_key)
                    probe_settled = True
                    return error_envelope(
                        "HTTP_RESPONSE_TOO_LARGE",
                        str(too_large),
                        details={
                            "url": current_url,
                            "observed_bytes": too_large.observed_bytes,
                            "max_response_bytes": too_large.max_bytes,
                            "attempts": total_attempts,
                        },
                        tool=safe_tool,
                    )
                except Exception as exc:
                    is_to = _is_timeout_exception(exc)
                    if breaker is not None:
                        breaker.record_failure(breaker_key, "timeout" if is_to else str(exc) or "network_error")
                    probe_settled = True
                    err_code = "HTTP_TIMEOUT" if is_to else "HTTP_NETWORK_ERROR"
                    err_msg = (
                        f"HTTP request timed out: {exc}"
                        if is_to
                        else f"HTTP transport error: {exc}"
                    )
                    transport_err = (err_code, err_msg, type(exc).__name__)
                finally:
                    if breaker is not None and probe_acquired and not probe_settled:
                        breaker.release_probe(breaker_key)

                if transport_err is not None:
                    err_code, err_msg, err_type = transport_err
                    if hop_attempt < effective_max_retries:
                        delay = compute_retry_delay(
                            hop_attempt + 1,
                            base_delay=eff_base_delay,
                            max_delay=eff_max_delay,
                        )
                        active_sleep(delay)
                        hop_attempt += 1
                        continue
                    return error_envelope(
                        err_code,
                        err_msg,
                        details={"url": current_url, "attempts": total_attempts, "error_type": err_type},
                        tool=safe_tool,
                    )

                # Check manual redirect before retry/error handling
                location = resp_headers.get("location")
                if status in _REDIRECT_STATUSES and location and location.strip():
                    if _has_forbidden_header_chars(location):
                        return error_envelope(
                            "SSRF_INVALID_URL",
                            "Redirect Location header contains control characters",
                            tool=safe_tool,
                        )
                    if redirect_count >= max_redirects:
                        return error_envelope(
                            "HTTP_TOO_MANY_REDIRECTS",
                            f"Exceeded maximum redirects ({max_redirects})",
                            details={
                                "url": current_url,
                                "max_redirects": max_redirects,
                                "redirects": redirect_count,
                            },
                            tool=safe_tool,
                        )
                    try:
                        resolved_next_url = urljoin(current_url, location.strip())
                    except ValueError:
                        return error_envelope(
                            "SSRF_INVALID_URL",
                            "Malformed redirect Location header URL",
                            tool=safe_tool,
                        )
                    next_val = _validate_hop_url_sync(
                        resolved_next_url,
                        allow_private_lan=allow_private_lan,
                        allow_tailscale=allow_tailscale,
                        allow_loopback=allow_loopback,
                        allowed_hosts=allowed_hosts,
                        lookup_fn=lookup_fn,
                        safe_tool=safe_tool,
                    )
                    if not next_val["ok"]:
                        return next_val

                    next_data = next_val["data"]
                    prev_origin = (hop_scheme, hop_hostname, hop_port)
                    next_origin = (next_data["scheme"], next_data["hostname"], next_data["port"])
                    if prev_origin != next_origin and owned_client is not None:
                        prev_client = owned_client
                        owned_client = None
                        prev_client.close()
                    current_method, current_headers, current_body_bytes = _apply_redirect_transition(
                        status=status,
                        current_method=current_method,
                        current_headers=current_headers,
                        current_body_bytes=current_body_bytes,
                        prev_origin=prev_origin,
                        next_origin=next_origin,
                    )
                    validated = next_data
                    current_url = next_data["url"]
                    redirect_count += 1
                    break  # Break inner retry loop to follow validated redirect hop

                if status in _RETRYABLE_STATUSES and hop_attempt < effective_max_retries:
                    delay = compute_retry_delay(
                        hop_attempt + 1,
                        base_delay=eff_base_delay,
                        max_delay=eff_max_delay,
                        retry_after_header=resp_headers.get("retry-after"),
                    )
                    active_sleep(delay)
                    hop_attempt += 1
                    continue

                if 200 <= status < 300:
                    ok_json, parsed_or_err = _decode_success_json_body(
                        raw_bytes,
                        status=status,
                        method=current_method,
                        url=current_url,
                        attempts=total_attempts,
                        safe_tool=safe_tool,
                    )
                    if not ok_json:
                        return parsed_or_err
                    return ok_envelope(
                        safe_tool,
                        f"HTTP {status} from {hop_hostname}",
                        {
                            "status": status,
                            "url": current_url,
                            "headers": resp_headers,
                            "body": parsed_or_err,
                            "attempts": total_attempts,
                            "redirected": redirect_count > 0,
                        },
                    )

                err_body = _decode_error_body_preview(raw_bytes)
                return error_envelope(
                    "HTTP_UPSTREAM_ERROR",
                    f"Upstream returned HTTP {status}",
                    details={
                        "status": status,
                        "url": current_url,
                        "headers": resp_headers,
                        "body": err_body,
                        "attempts": total_attempts,
                    },
                    tool=safe_tool,
                )
    finally:
        if owned_client is not None:
            owned_client.close()


async def async_request_json(
    url: str,
    *,
    method: str = "GET",
    headers: Mapping[str, str] | None = None,
    json_body: Any = _UNSET,
    timeout_seconds: float = 15.0,
    max_retries: int = 2,
    base_delay: float = 0.25,
    max_delay: float = 5.0,
    retry_on_post: bool = False,
    max_redirects: int = 3,
    max_response_bytes: int = 5_242_880,
    allow_private_lan: bool = False,
    allow_tailscale: bool = False,
    allow_loopback: bool = False,
    allowed_hosts: Sequence[str] | None = None,
    lookup_fn: Callable[[str], Sequence[str]] | None = None,
    breaker: HttpCircuitBreaker | None = None,
    client: Any = None,
    send_fn: Callable[..., Any] | None = None,
    sleep_fn: Callable[..., Any] | None = None,
    tool: str = "http_client.request",
) -> dict[str, Any]:
    """
    Execute an asynchronous SSRF-guarded, byte-bounded, circuit-broken JSON HTTP request (`INV-LEGO-21`).
    Resolves DNS asynchronously when `lookup_fn` is omitted, releases `HALF_OPEN` probes if cancelled
    by `asyncio.CancelledError` (re-raising `CancelledError`), and returns an `INV-LEGO-01` envelope.
    """
    safe_tool = _safe_tool_name(tool, "http_client.request")
    prep = _validate_request_inputs(
        method=method,
        headers=headers,
        json_body=json_body,
        timeout_seconds=timeout_seconds,
        max_retries=max_retries,
        base_delay=base_delay,
        max_delay=max_delay,
        retry_on_post=retry_on_post,
        max_redirects=max_redirects,
        max_response_bytes=max_response_bytes,
        allow_private_lan=allow_private_lan,
        allow_tailscale=allow_tailscale,
        allow_loopback=allow_loopback,
        allowed_hosts=allowed_hosts,
        lookup_fn=lookup_fn,
        breaker=breaker,
        send_fn=send_fn,
        sleep_fn=sleep_fn,
        safe_tool=safe_tool,
    )
    if not prep["ok"]:
        return prep

    pdata = prep["data"]
    current_method: str = pdata["method"]
    current_headers: dict[str, str] = pdata["headers"]
    current_body_bytes: bytes | None = pdata["body_bytes"]
    eff_timeout: float = pdata["timeout_seconds"]
    eff_base_delay: float = pdata["base_delay"]
    eff_max_delay: float = pdata["max_delay"]

    async def _sleep_async(delay_sec: float) -> None:
        if sleep_fn is not None:
            maybe_awaitable = sleep_fn(delay_sec)
            if inspect.isawaitable(maybe_awaitable):
                await maybe_awaitable
        else:
            await asyncio.sleep(delay_sec)

    hop_val = await _validate_hop_url_async(
        url,
        allow_private_lan=allow_private_lan,
        allow_tailscale=allow_tailscale,
        allow_loopback=allow_loopback,
        allowed_hosts=allowed_hosts,
        lookup_fn=lookup_fn,
        safe_tool=safe_tool,
    )
    if not hop_val["ok"]:
        return hop_val

    validated = hop_val["data"]
    current_url: str = validated["url"]
    use_default_httpx = client is None and send_fn is None
    owned_client: Any = None

    try:
        redirect_count = 0
        total_attempts = 0

        while True:
            hop_scheme: str = validated["scheme"]
            hop_hostname: str = validated["hostname"]
            hop_port: int = validated["port"]
            breaker_key = f"{hop_scheme}://{hop_hostname}:{hop_port}"

            can_retry = current_method in _IDEMPOTENT_METHODS or (
                current_method == "POST" and retry_on_post is True
            )
            effective_max_retries = max_retries if can_retry else 0

            target_url, wire_headers, req_extensions = _build_hop_wire_target(
                validated,
                current_headers,
                use_dns_pinning=use_default_httpx,
            )

            hop_attempt = 0
            while True:
                probe_acquired = False
                probe_settled = False
                if breaker is not None:
                    gate = breaker.can_attempt(breaker_key)
                    if not gate.get("allowed", False):
                        return error_envelope(
                            "HTTP_CIRCUIT_OPEN",
                            f"Circuit breaker is {gate.get('state', 'OPEN')} for {breaker_key}",
                            details={"host": breaker_key, **gate},
                            tool=safe_tool,
                        )
                    probe_acquired = bool(gate.get("probe", False))

                if use_default_httpx and owned_client is None:
                    try:
                        httpx_mod = _load_httpx()
                        owned_client = httpx_mod.AsyncClient(
                            follow_redirects=False,
                            trust_env=False,
                            timeout=eff_timeout,
                        )
                    except ImportError:
                        if breaker is not None and probe_acquired:
                            breaker.release_probe(breaker_key)
                        return error_envelope(
                            "HTTP_CLIENT_UNAVAILABLE",
                            "httpx is not installed and no send_fn/client was provided",
                            tool=safe_tool,
                        )

                total_attempts += 1
                status = 0
                resp_headers: dict[str, str] = {}
                raw_bytes = b""
                transport_err: tuple[str, str, str] | None = None

                try:
                    if send_fn is not None:
                        async with asyncio.timeout(eff_timeout):
                            maybe_resp = send_fn(
                                current_method,
                                target_url,
                                wire_headers,
                                current_body_bytes,
                                eff_timeout,
                            )
                            raw_resp = await maybe_resp if inspect.isawaitable(maybe_resp) else maybe_resp
                            status, resp_headers, raw_bytes = await _extract_send_fn_async_response(
                                raw_resp,
                                current_method,
                                max_response_bytes,
                            )
                    else:
                        active_client = owned_client if use_default_httpx else client
                        status, resp_headers, raw_bytes = await _execute_client_stream_async(
                            active_client,
                            current_method,
                            target_url,
                            wire_headers,
                            current_body_bytes,
                            eff_timeout,
                            max_response_bytes,
                            req_extensions,
                        )
                    if breaker is not None:
                        if status >= 500:
                            breaker.record_failure(breaker_key, f"http_{status}")
                        elif status < 400 or probe_acquired:
                            breaker.record_success(breaker_key)
                    probe_settled = True
                except _ResponseTooLargeError as too_large:
                    if breaker is not None and probe_acquired:
                        breaker.record_success(breaker_key)
                    probe_settled = True
                    return error_envelope(
                        "HTTP_RESPONSE_TOO_LARGE",
                        str(too_large),
                        details={
                            "url": current_url,
                            "observed_bytes": too_large.observed_bytes,
                            "max_response_bytes": too_large.max_bytes,
                            "attempts": total_attempts,
                        },
                        tool=safe_tool,
                    )
                except Exception as exc:
                    is_to = _is_timeout_exception(exc)
                    if breaker is not None:
                        breaker.record_failure(breaker_key, "timeout" if is_to else str(exc) or "network_error")
                    probe_settled = True
                    err_code = "HTTP_TIMEOUT" if is_to else "HTTP_NETWORK_ERROR"
                    err_msg = (
                        f"HTTP request timed out: {exc}"
                        if is_to
                        else f"HTTP transport error: {exc}"
                    )
                    transport_err = (err_code, err_msg, type(exc).__name__)
                finally:
                    if breaker is not None and probe_acquired and not probe_settled:
                        breaker.release_probe(breaker_key)

                if transport_err is not None:
                    err_code, err_msg, err_type = transport_err
                    if hop_attempt < effective_max_retries:
                        delay = compute_retry_delay(
                            hop_attempt + 1,
                            base_delay=eff_base_delay,
                            max_delay=eff_max_delay,
                        )
                        await _sleep_async(delay)
                        hop_attempt += 1
                        continue
                    return error_envelope(
                        err_code,
                        err_msg,
                        details={"url": current_url, "attempts": total_attempts, "error_type": err_type},
                        tool=safe_tool,
                    )

                location = resp_headers.get("location")
                if status in _REDIRECT_STATUSES and location and location.strip():
                    if _has_forbidden_header_chars(location):
                        return error_envelope(
                            "SSRF_INVALID_URL",
                            "Redirect Location header contains control characters",
                            tool=safe_tool,
                        )
                    if redirect_count >= max_redirects:
                        return error_envelope(
                            "HTTP_TOO_MANY_REDIRECTS",
                            f"Exceeded maximum redirects ({max_redirects})",
                            details={
                                "url": current_url,
                                "max_redirects": max_redirects,
                                "redirects": redirect_count,
                            },
                            tool=safe_tool,
                        )
                    try:
                        resolved_next_url = urljoin(current_url, location.strip())
                    except ValueError:
                        return error_envelope(
                            "SSRF_INVALID_URL",
                            "Malformed redirect Location header URL",
                            tool=safe_tool,
                        )
                    next_val = await _validate_hop_url_async(
                        resolved_next_url,
                        allow_private_lan=allow_private_lan,
                        allow_tailscale=allow_tailscale,
                        allow_loopback=allow_loopback,
                        allowed_hosts=allowed_hosts,
                        lookup_fn=lookup_fn,
                        safe_tool=safe_tool,
                    )
                    if not next_val["ok"]:
                        return next_val

                    next_data = next_val["data"]
                    prev_origin = (hop_scheme, hop_hostname, hop_port)
                    next_origin = (next_data["scheme"], next_data["hostname"], next_data["port"])
                    if prev_origin != next_origin and owned_client is not None:
                        prev_client = owned_client
                        owned_client = None
                        await prev_client.aclose()
                    current_method, current_headers, current_body_bytes = _apply_redirect_transition(
                        status=status,
                        current_method=current_method,
                        current_headers=current_headers,
                        current_body_bytes=current_body_bytes,
                        prev_origin=prev_origin,
                        next_origin=next_origin,
                    )
                    validated = next_data
                    current_url = next_data["url"]
                    redirect_count += 1
                    break

                if status in _RETRYABLE_STATUSES and hop_attempt < effective_max_retries:
                    delay = compute_retry_delay(
                        hop_attempt + 1,
                        base_delay=eff_base_delay,
                        max_delay=eff_max_delay,
                        retry_after_header=resp_headers.get("retry-after"),
                    )
                    await _sleep_async(delay)
                    hop_attempt += 1
                    continue

                if 200 <= status < 300:
                    ok_json, parsed_or_err = _decode_success_json_body(
                        raw_bytes,
                        status=status,
                        method=current_method,
                        url=current_url,
                        attempts=total_attempts,
                        safe_tool=safe_tool,
                    )
                    if not ok_json:
                        return parsed_or_err
                    return ok_envelope(
                        safe_tool,
                        f"HTTP {status} from {hop_hostname}",
                        {
                            "status": status,
                            "url": current_url,
                            "headers": resp_headers,
                            "body": parsed_or_err,
                            "attempts": total_attempts,
                            "redirected": redirect_count > 0,
                        },
                    )

                err_body = _decode_error_body_preview(raw_bytes)
                return error_envelope(
                    "HTTP_UPSTREAM_ERROR",
                    f"Upstream returned HTTP {status}",
                    details={
                        "status": status,
                        "url": current_url,
                        "headers": resp_headers,
                        "body": err_body,
                        "attempts": total_attempts,
                    },
                    tool=safe_tool,
                )
    finally:
        if owned_client is not None:
            await owned_client.aclose()
