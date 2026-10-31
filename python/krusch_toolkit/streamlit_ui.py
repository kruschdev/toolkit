"""
Air-Gapped, XSS-Hardened Streamlit Sovereign RAG Shell Lego Bricks (`INV-LEGO-01`, `INV-LEGO-22`).

Imports cleanly in bare Python 3.11+ stdlib without `streamlit` installed. Callers may inject
`st_module` for deterministic headless testing; `streamlit` is resolved lazily via `importlib`
only when `st_module` is omitted.
"""

from __future__ import annotations

import copy
import html
import importlib
import math
import re
import types
from collections.abc import Mapping, MutableMapping, Sequence
from typing import Any
from urllib.parse import urlsplit

from krusch_toolkit.fastapi_app import error_envelope, ok_envelope

__all__ = [
    "AIRGAPPED_THEME_PRESETS",
    "build_airgapped_theme_css",
    "build_rag_auth_headers",
    "format_citation_badges_html",
    "render_citation_badges",
    "init_rag_session_state",
    "append_rag_turn",
    "render_sovereign_rag_shell",
]

AIRGAPPED_THEME_PRESETS: types.MappingProxyType[str, types.MappingProxyType[str, str]] = (
    types.MappingProxyType(
        {
            "sky": types.MappingProxyType(
                {
                    "primary": "#38bdf8",
                    "secondary": "#60a5fa",
                    "border": "rgba(56, 189, 248, 0.35)",
                    "glow": "rgba(14, 165, 233, 0.14)",
                }
            ),
            "gold": types.MappingProxyType(
                {
                    "primary": "#fbbf24",
                    "secondary": "#f59e0b",
                    "border": "rgba(251, 191, 36, 0.35)",
                    "glow": "rgba(245, 158, 11, 0.14)",
                }
            ),
            "emerald": types.MappingProxyType(
                {
                    "primary": "#34d399",
                    "secondary": "#10b981",
                    "border": "rgba(52, 211, 153, 0.35)",
                    "glow": "rgba(16, 185, 129, 0.14)",
                }
            ),
        }
    )
)

_HEX_COLOR_RE = re.compile(r"#[0-9a-fA-F]{6}")
_WHITESPACE_RE = re.compile(r"\s+")
_FORBIDDEN_KEYS = frozenset({"__proto__", "constructor", "prototype"})
_VALID_ROLES = frozenset({"user", "assistant", "system"})
_VALID_HEALTH_STATES = frozenset({"healthy", "degraded", "offline"})
_IGNORABLE_PAGE_CONFIG_EXCEPTIONS = frozenset(
    {
        "StreamlitAPIException",
        "StreamlitSetPageConfigMustBeFirstCommandError",
    }
)
_MAX_HEADER_CHARS = 4096
_MAX_URL_CHARS = 2048
_MAX_DEEPCOPY_DEPTH = 64


def _resolve_tool(tool: Any, default: str) -> str:
    if isinstance(tool, str) and tool.strip():
        return tool.strip()
    return default


def _resolve_st(st_module: Any = None) -> Any:
    """Resolve an injected Streamlit module or lazily import `streamlit` without raising."""
    if st_module is not None:
        return st_module
    try:
        return importlib.import_module("streamlit")
    except ImportError:
        return None


def _is_mutable_state_mapping(obj: Any) -> bool:
    """Verify `obj` is a dict-like mutable mapping (excluding sequences, bytes, and read-only proxies)."""
    if obj is None or isinstance(
        obj, (str, bytes, bytearray, memoryview, list, tuple, set, frozenset)
    ):
        return False
    if isinstance(obj, MutableMapping):
        return True
    if isinstance(obj, Sequence):
        return False
    return (
        callable(getattr(obj, "__contains__", None))
        and callable(getattr(obj, "__getitem__", None))
        and callable(getattr(obj, "__setitem__", None))
    )


def _resolve_accent_palette(accent: Any) -> tuple[str, Mapping[str, str]]:
    """Resolve preset name or strict `#RRGGBB` hex into a CSS-injection-safe color palette."""
    if isinstance(accent, str):
        candidate = accent.strip()
        lowered = candidate.lower()
        if lowered in AIRGAPPED_THEME_PRESETS:
            return lowered, AIRGAPPED_THEME_PRESETS[lowered]
        if _HEX_COLOR_RE.fullmatch(candidate):
            hex_norm = lowered
            red = int(hex_norm[1:3], 16)
            green = int(hex_norm[3:5], 16)
            blue = int(hex_norm[5:7], 16)
            return hex_norm, {
                "primary": hex_norm,
                "secondary": hex_norm,
                "border": f"rgba({red}, {green}, {blue}, 0.35)",
                "glow": f"rgba({red}, {green}, {blue}, 0.14)",
            }
    return "sky", AIRGAPPED_THEME_PRESETS["sky"]


def build_airgapped_theme_css(accent: str = "sky") -> str:
    """Build air-gapped Sovereign Dark Glassmorphism `<style>` CSS with zero external font/network URLs."""
    _, palette = _resolve_accent_palette(accent)
    primary = palette["primary"]
    secondary = palette["secondary"]
    border = palette["border"]
    glow = palette["glow"]

    return (
        "<style>\n"
        ":root {\n"
        f"  --krusch-accent-primary: {primary};\n"
        f"  --krusch-accent-secondary: {secondary};\n"
        f"  --krusch-accent-border: {border};\n"
        f"  --krusch-accent-glow: {glow};\n"
        "}\n"
        ".stApp {\n"
        f"  background: radial-gradient(circle at 12% 8%, {glow}, transparent 42%), #090d16;\n"
        "  color: #e2e8f0;\n"
        '  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;\n'
        "}\n"
        ".krusch-rag-header {\n"
        "  background: rgba(15, 23, 42, 0.78);\n"
        "  backdrop-filter: blur(12px);\n"
        "  -webkit-backdrop-filter: blur(12px);\n"
        f"  border: 1px solid {border};\n"
        f"  box-shadow: 0 8px 32px {glow};\n"
        "  border-radius: 14px;\n"
        "  padding: 1.1rem 1.35rem;\n"
        "  margin-bottom: 1rem;\n"
        "}\n"
        ".krusch-rag-header-row {\n"
        "  display: flex;\n"
        "  align-items: center;\n"
        "  justify-content: space-between;\n"
        "  gap: 0.75rem;\n"
        "  flex-wrap: wrap;\n"
        "}\n"
        ".krusch-rag-title {\n"
        "  margin: 0;\n"
        "  font-size: 1.45rem;\n"
        "  font-weight: 700;\n"
        "  letter-spacing: -0.015em;\n"
        "  color: #f8fafc;\n"
        "}\n"
        ".krusch-rag-subtitle {\n"
        "  margin: 0.35rem 0 0 0;\n"
        "  font-size: 0.92rem;\n"
        "  color: #94a3b8;\n"
        "}\n"
        ".krusch-rag-pills {\n"
        "  display: inline-flex;\n"
        "  align-items: center;\n"
        "  gap: 0.45rem;\n"
        "  flex-wrap: wrap;\n"
        "}\n"
        ".krusch-rag-pill {\n"
        "  display: inline-flex;\n"
        "  align-items: center;\n"
        "  padding: 0.2rem 0.65rem;\n"
        "  border-radius: 999px;\n"
        "  font-size: 0.72rem;\n"
        "  font-weight: 600;\n"
        "  letter-spacing: 0.06em;\n"
        "  text-transform: uppercase;\n"
        f"  color: {primary};\n"
        f"  border: 1px solid {border};\n"
        "  background: rgba(15, 23, 42, 0.88);\n"
        "}\n"
        ".krusch-rag-pill--healthy {\n"
        "  color: #34d399;\n"
        "  border-color: rgba(52, 211, 153, 0.4);\n"
        "}\n"
        ".krusch-rag-pill--degraded {\n"
        "  color: #fbbf24;\n"
        "  border-color: rgba(251, 191, 36, 0.45);\n"
        "}\n"
        ".krusch-rag-pill--offline {\n"
        "  color: #f87171;\n"
        "  border-color: rgba(248, 113, 113, 0.45);\n"
        "}\n"
        ".krusch-rag-disclaimer {\n"
        "  background: rgba(15, 23, 42, 0.66);\n"
        f"  border-left: 3px solid {primary};\n"
        "  border-radius: 8px;\n"
        "  padding: 0.55rem 0.9rem;\n"
        "  margin-bottom: 0.9rem;\n"
        "  font-size: 0.82rem;\n"
        "  color: #cbd5e1;\n"
        "}\n"
        ".krusch-citation-strip {\n"
        "  display: flex;\n"
        "  flex-wrap: wrap;\n"
        "  gap: 0.5rem;\n"
        "  margin-top: 0.6rem;\n"
        "  align-items: center;\n"
        "}\n"
        ".krusch-citation-badge {\n"
        "  display: inline-flex;\n"
        "  align-items: center;\n"
        "  gap: 0.4rem;\n"
        "  max-width: 100%;\n"
        "  padding: 0.25rem 0.65rem;\n"
        "  border-radius: 8px;\n"
        "  font-size: 0.78rem;\n"
        "  line-height: 1.35;\n"
        "  color: #e2e8f0;\n"
        "  background: rgba(15, 23, 42, 0.84);\n"
        f"  border: 1px solid {border};\n"
        "  text-decoration: none;\n"
        "}\n"
        "a.krusch-citation-badge:hover {\n"
        f"  border-color: {secondary};\n"
        f"  box-shadow: 0 0 12px {glow};\n"
        "  color: #ffffff;\n"
        "}\n"
        ".krusch-citation-source {\n"
        f"  color: {primary};\n"
        "  font-weight: 600;\n"
        "}\n"
        ".krusch-citation-section {\n"
        "  color: #cbd5e1;\n"
        "}\n"
        ".krusch-citation-score {\n"
        f"  color: {secondary};\n"
        "  font-weight: 600;\n"
        "}\n"
        ".krusch-citation-span {\n"
        "  color: #94a3b8;\n"
        "  font-style: italic;\n"
        "}\n"
        "</style>"
    )


def _lookup_session_value(session_state: Any, key: str) -> Any:
    if isinstance(session_state, Mapping):
        return session_state.get(key)
    if _is_mutable_state_mapping(session_state):
        getter = getattr(session_state, "get", None)
        if callable(getter):
            return getter(key)
        try:
            return session_state[key]
        except KeyError:
            return None
    return None


def _validate_header_token(field_name: str, raw_value: Any, safe_tool: str) -> tuple[str | None, dict[str, Any] | None]:
    if raw_value is None:
        return "", None
    if not isinstance(raw_value, str):
        return None, error_envelope(
            "STREAMLIT_INVALID_HEADER",
            f"{field_name} must be a string",
            {"field": field_name},
            tool=safe_tool,
        )
    if len(raw_value) > _MAX_HEADER_CHARS:
        return None, error_envelope(
            "STREAMLIT_INVALID_HEADER",
            f"{field_name} exceeds maximum length ({_MAX_HEADER_CHARS})",
            {"field": field_name, "max_length": _MAX_HEADER_CHARS},
            tool=safe_tool,
        )
    if any((ord(ch) < 0x20 and ch != "\t") or ord(ch) >= 0x7F for ch in raw_value):
        return None, error_envelope(
            "STREAMLIT_INVALID_HEADER",
            f"{field_name} contains forbidden control or non-ASCII characters",
            {"field": field_name},
            tool=safe_tool,
        )
    return raw_value.strip(), None


def build_rag_auth_headers(
    session_state: Mapping[str, Any] | None = None,
    *,
    api_key: str | None = None,
    tenant_id: str | None = None,
    bearer_token: str | None = None,
    default_api_key: str = "",
    default_tenant_id: str = "",
    tool: str = "streamlit.auth",
) -> dict[str, Any]:
    """Construct CRLF/NUL-guarded RAG authentication headers from explicit args or `session_state`."""
    safe_tool = _resolve_tool(tool, "streamlit.auth")

    raw_api_key: Any = api_key if api_key is not None else _lookup_session_value(session_state, "api_key")
    if raw_api_key is None:
        raw_api_key = default_api_key

    raw_tenant_id: Any = tenant_id if tenant_id is not None else _lookup_session_value(session_state, "tenant_id")
    if raw_tenant_id is None:
        raw_tenant_id = default_tenant_id

    raw_bearer: Any = (
        bearer_token if bearer_token is not None else _lookup_session_value(session_state, "bearer_token")
    )
    if raw_bearer is None:
        raw_bearer = ""

    clean_api_key, err = _validate_header_token("api_key", raw_api_key, safe_tool)
    if err is not None:
        return err

    clean_tenant_id, err = _validate_header_token("tenant_id", raw_tenant_id, safe_tool)
    if err is not None:
        return err

    clean_bearer, err = _validate_header_token("bearer_token", raw_bearer, safe_tool)
    if err is not None:
        return err

    headers: dict[str, str] = {}
    if clean_api_key:
        headers["X-API-Key"] = clean_api_key
    if clean_tenant_id:
        headers["X-Tenant-ID"] = clean_tenant_id
    if clean_bearer:
        headers["Authorization"] = f"Bearer {clean_bearer}"

    return ok_envelope(safe_tool, "Constructed RAG authentication headers", {"headers": headers})


def _clamp_int_option(value: Any, *, default: int, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        return default
    return max(minimum, min(maximum, value))


def _extract_non_empty_text(item: Mapping[str, Any], keys: tuple[str, ...]) -> str:
    for key in keys:
        val = item.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
        if isinstance(val, int) and not isinstance(val, bool):
            return str(val)
    return ""


def _format_citation_score(item: Mapping[str, Any]) -> str:
    for key in ("score", "confidence"):
        val = item.get(key)
        if val is None or isinstance(val, bool) or not isinstance(val, (int, float)):
            continue
        if isinstance(val, float) and (math.isnan(val) or math.isinf(val)):
            continue
        if val < 0 or val > 100:
            continue
        fval = float(val)
        if 0.0 <= fval <= 1.0:
            return f"{round(fval * 100)}%"
        if 1.0 < fval <= 100.0:
            return f"{round(fval)}%"
    return ""


def _validate_safe_http_url(raw_url: Any) -> str | None:
    """Return raw URL iff it is a clean `http://` or `https://` URL with non-empty host and zero CTL/whitespace."""
    if not isinstance(raw_url, str) or not raw_url or len(raw_url) > _MAX_URL_CHARS:
        return None
    if any(ch.isspace() or ord(ch) <= 0x1F or 0x7F <= ord(ch) <= 0x9F for ch in raw_url):
        return None
    try:
        parsed = urlsplit(raw_url)
        _ = parsed.port
    except ValueError:
        return None
    if parsed.scheme.lower() not in {"http", "https"}:
        return None
    if not parsed.netloc or not parsed.hostname:
        return None
    return raw_url


def _build_citation_badges(
    citations: Sequence[Mapping[str, Any]] | None,
    *,
    max_badges: int = 12,
    max_span_chars: int = 140,
) -> tuple[str, int]:
    if (
        citations is None
        or isinstance(citations, (str, bytes, bytearray, memoryview))
        or not isinstance(citations, Sequence)
        or len(citations) == 0
    ):
        return "", 0

    safe_max_badges = _clamp_int_option(max_badges, default=12, minimum=1, maximum=50)
    safe_max_span = _clamp_int_option(max_span_chars, default=140, minimum=16, maximum=500)

    rendered_badges: list[str] = []
    for item in citations:
        if not isinstance(item, Mapping):
            continue

        label_raw = _extract_non_empty_text(item, ("source", "title", "citation", "doc_id")) or "Source"
        section_raw = _extract_non_empty_text(item, ("section",))
        span_raw = _extract_non_empty_text(item, ("span", "raw_span", "quote"))
        if span_raw:
            span_raw = _WHITESPACE_RE.sub(" ", span_raw).strip()
            if len(span_raw) > safe_max_span:
                span_raw = span_raw[: safe_max_span - 1].rstrip() + "…"

        score_raw = _format_citation_score(item)

        fragments: list[str] = [
            f'<span class="krusch-citation-source">{html.escape(label_raw, quote=True)}</span>'
        ]
        if section_raw:
            fragments.append(
                f'<span class="krusch-citation-section">{html.escape(section_raw, quote=True)}</span>'
            )
        if score_raw:
            fragments.append(
                f'<span class="krusch-citation-score">{html.escape(score_raw, quote=True)}</span>'
            )
        if span_raw:
            fragments.append(
                f'<span class="krusch-citation-span">{html.escape(span_raw, quote=True)}</span>'
            )

        inner_html = " ".join(fragments)
        url_candidate = item.get("url") if item.get("url") is not None else item.get("href")
        validated_url = _validate_safe_http_url(url_candidate)
        if validated_url is not None:
            escaped_url = html.escape(validated_url, quote=True)
            badge_el = (
                f'<a class="krusch-citation-badge" href="{escaped_url}" '
                f'target="_blank" rel="noopener noreferrer">{inner_html}</a>'
            )
        else:
            badge_el = f'<span class="krusch-citation-badge">{inner_html}</span>'

        rendered_badges.append(badge_el)
        if len(rendered_badges) >= safe_max_badges:
            break

    if not rendered_badges:
        return "", 0
    return f'<div class="krusch-citation-strip">{"".join(rendered_badges)}</div>', len(rendered_badges)


def format_citation_badges_html(
    citations: Sequence[Mapping[str, Any]] | None,
    *,
    max_badges: int = 12,
    max_span_chars: int = 140,
) -> str:
    """Format XSS-escaped RAG citation badges HTML, neutralizing non-http(s) URLs into `<span>` elements."""
    badge_html, _ = _build_citation_badges(
        citations,
        max_badges=max_badges,
        max_span_chars=max_span_chars,
    )
    return badge_html


def render_citation_badges(
    citations: Sequence[Mapping[str, Any]] | None,
    *,
    st_module: Any = None,
    max_badges: int = 12,
    max_span_chars: int = 140,
    tool: str = "streamlit.citations",
) -> dict[str, Any]:
    """Render XSS-escaped citation badges via `st.markdown` and return an `INV-LEGO-01` envelope."""
    safe_tool = _resolve_tool(tool, "streamlit.citations")
    st = _resolve_st(st_module)
    markdown_fn = getattr(st, "markdown", None) if st is not None else None
    if st is None or not callable(markdown_fn):
        return error_envelope("STREAMLIT_UNAVAILABLE", "Streamlit runtime is not available", tool=safe_tool)

    badge_html, rendered_count = _build_citation_badges(
        citations,
        max_badges=max_badges,
        max_span_chars=max_span_chars,
    )
    if rendered_count > 0:
        try:
            markdown_fn(badge_html, unsafe_allow_html=True)
        except Exception as exc:
            return error_envelope(
                "STREAMLIT_RENDER_ERROR",
                str(exc) or "Failed rendering citation badges",
                tool=safe_tool,
            )

    return ok_envelope(
        safe_tool,
        f"Rendered {rendered_count} citation badge(s)",
        {"html": badge_html, "rendered_count": rendered_count},
    )


def _check_acyclic_and_bounded(value: Any, active_ids: set[int], depth: int = 0) -> bool:
    if depth > _MAX_DEEPCOPY_DEPTH:
        return False
    if isinstance(value, (str, bytes, int, float, bool)) or value is None:
        return True

    obj_id = id(value)
    if obj_id in active_ids:
        return False

    if isinstance(value, Mapping):
        active_ids.add(obj_id)
        try:
            return all(
                _check_acyclic_and_bounded(k, active_ids, depth + 1)
                and _check_acyclic_and_bounded(v, active_ids, depth + 1)
                for k, v in value.items()
            )
        finally:
            active_ids.discard(obj_id)

    if isinstance(value, (list, tuple, set, frozenset)):
        active_ids.add(obj_id)
        try:
            return all(_check_acyclic_and_bounded(item, active_ids, depth + 1) for item in value)
        finally:
            active_ids.discard(obj_id)

    return True


def _safe_deepcopy(value: Any) -> tuple[Any, bool]:
    if not _check_acyclic_and_bounded(value, set()):
        return None, False
    try:
        return copy.deepcopy(value), True
    except (copy.Error, RecursionError, TypeError, ValueError):
        return None, False


def init_rag_session_state(
    session_state: MutableMapping[str, Any] | None = None,
    *,
    st_module: Any = None,
    defaults: Mapping[str, Any] | None = None,
    messages_key: str = "messages",
    max_turns: int = 100,
    tool: str = "streamlit.state",
) -> dict[str, Any]:
    """Initialize bounded RAG chat history and non-clobbering deep-copied defaults on `session_state`."""
    safe_tool = _resolve_tool(tool, "streamlit.state")

    if (
        not isinstance(messages_key, str)
        or not messages_key.strip()
        or messages_key in _FORBIDDEN_KEYS
        or messages_key.strip() in _FORBIDDEN_KEYS
    ):
        return error_envelope(
            "STREAMLIT_INVALID_OPTIONS",
            "messages_key must be a safe non-empty string",
            tool=safe_tool,
        )

    if isinstance(max_turns, bool) or not isinstance(max_turns, int) or max_turns < 1:
        return error_envelope(
            "STREAMLIT_INVALID_OPTIONS",
            "max_turns must be an integer >= 1",
            tool=safe_tool,
        )

    if defaults is not None and not isinstance(defaults, Mapping):
        return error_envelope(
            "STREAMLIT_INVALID_OPTIONS",
            "defaults must be a mapping when provided",
            tool=safe_tool,
        )

    state: Any = session_state
    if state is None:
        st = _resolve_st(st_module)
        state = getattr(st, "session_state", None) if st is not None else None

    if not _is_mutable_state_mapping(state):
        return error_envelope("STREAMLIT_UNAVAILABLE", "Streamlit runtime is not available", tool=safe_tool)

    staged_defaults: list[tuple[str, Any]] = []
    if defaults is not None:
        for key, raw_val in defaults.items():
            if not isinstance(key, str) or key in _FORBIDDEN_KEYS or key.strip() in _FORBIDDEN_KEYS:
                continue
            copied_val, ok_copy = _safe_deepcopy(raw_val)
            if not ok_copy:
                return error_envelope(
                    "STREAMLIT_INVALID_OPTIONS",
                    f"Failed deep-copying default key '{key}'",
                    {"key": key},
                    tool=safe_tool,
                )
            if key not in state:
                staged_defaults.append((key, copied_val))

    for key, copied_val in staged_defaults:
        state[key] = copied_val

    if messages_key not in state or not isinstance(state[messages_key], list):
        state[messages_key] = []
    else:
        existing_messages = state[messages_key]
        if len(existing_messages) > max_turns:
            trimmed = existing_messages[-max_turns:]
            existing_messages[:] = trimmed
            state[messages_key] = existing_messages

    return ok_envelope(
        safe_tool,
        "Initialized RAG session state",
        {"messages_key": messages_key, "turn_count": len(state[messages_key])},
    )


def _sanitize_stored_citations(
    citations: Sequence[Mapping[str, Any]] | None,
    safe_tool: str,
) -> tuple[list[dict[str, Any]] | None, dict[str, Any] | None]:
    if citations is None:
        return [], None
    if isinstance(citations, (str, bytes, bytearray, memoryview)) or not isinstance(citations, Sequence):
        return [], None

    sanitized: list[dict[str, Any]] = []
    for item in citations:
        if not isinstance(item, Mapping):
            continue
        clean_item: dict[str, Any] = {}
        for key, raw_val in item.items():
            if not isinstance(key, str) or key in _FORBIDDEN_KEYS or key.strip() in _FORBIDDEN_KEYS:
                continue
            if key in {"url", "href"} and raw_val is not None and _validate_safe_http_url(raw_val) is None:
                continue
            copied_val, ok_copy = _safe_deepcopy(raw_val)
            if not ok_copy:
                return None, error_envelope(
                    "STREAMLIT_INVALID_OPTIONS",
                    f"Citation field '{key}' could not be copied safely",
                    {"key": key},
                    tool=safe_tool,
                )
            clean_item[key] = copied_val
        sanitized.append(clean_item)
    return sanitized, None


def append_rag_turn(
    session_state: MutableMapping[str, Any] | None,
    role: str,
    content: str,
    *,
    citations: Sequence[Mapping[str, Any]] | None = None,
    st_module: Any = None,
    messages_key: str = "messages",
    max_turns: int = 100,
    tool: str = "streamlit.chat",
) -> dict[str, Any]:
    """Validate and append a bounded RAG conversation turn (`user`, `assistant`, or `system`)."""
    safe_tool = _resolve_tool(tool, "streamlit.chat")

    if not isinstance(role, str) or role.strip().lower() not in _VALID_ROLES:
        return error_envelope(
            "STREAMLIT_INVALID_ROLE",
            "Role must be one of 'user', 'assistant', or 'system'",
            tool=safe_tool,
        )
    norm_role = role.strip().lower()

    if not isinstance(content, str) or len(content.strip()) == 0:
        return error_envelope(
            "STREAMLIT_EMPTY_CONTENT",
            "Turn content must be a non-empty string",
            tool=safe_tool,
        )

    sanitized_citations, cite_err = _sanitize_stored_citations(citations, safe_tool)
    if cite_err is not None or sanitized_citations is None:
        return cite_err or error_envelope("STREAMLIT_INVALID_OPTIONS", "Invalid citations", tool=safe_tool)

    resolved_st = _resolve_st(st_module) if session_state is None else st_module
    init_res = init_rag_session_state(
        session_state,
        st_module=resolved_st,
        messages_key=messages_key,
        max_turns=max_turns,
        tool=safe_tool,
    )
    if not init_res["ok"]:
        return init_res

    state: Any = session_state if session_state is not None else getattr(resolved_st, "session_state", None)
    turn_obj: dict[str, Any] = {
        "role": norm_role,
        "content": content,
        "citations": sanitized_citations,
    }

    messages_list: list[dict[str, Any]] = state[messages_key]
    messages_list.append(turn_obj)
    if len(messages_list) > max_turns:
        trimmed = messages_list[-max_turns:]
        messages_list[:] = trimmed
    state[messages_key] = messages_list

    returned_turn, _ = _safe_deepcopy(turn_obj)
    return ok_envelope(
        safe_tool,
        f"Appended {norm_role} turn",
        {"turn": returned_turn, "turn_count": len(messages_list)},
    )


def _is_ignorable_page_config_error(exc: BaseException) -> bool:
    return any(cls.__name__ in _IGNORABLE_PAGE_CONFIG_EXCEPTIONS for cls in type(exc).__mro__)


def render_sovereign_rag_shell(
    *,
    title: str,
    subtitle: str = "",
    badge_text: str = "AIR-GAPPED",
    disclaimer: str = "",
    accent: str = "sky",
    page_icon: str = "🛡️",
    health_status: str | None = None,
    configure_page: bool = True,
    max_turns: int = 100,
    st_module: Any = None,
    tool: str = "streamlit.shell",
) -> dict[str, Any]:
    """Configure page, inject air-gapped Sovereign Dark Glassmorphism CSS, and render escaped RAG shell."""
    safe_tool = _resolve_tool(tool, "streamlit.shell")

    if not isinstance(title, str) or not title.strip():
        return error_envelope(
            "STREAMLIT_INVALID_OPTIONS",
            "title must be a non-empty string",
            tool=safe_tool,
        )
    if isinstance(max_turns, bool) or not isinstance(max_turns, int) or max_turns < 1:
        return error_envelope(
            "STREAMLIT_INVALID_OPTIONS",
            "max_turns must be an integer >= 1",
            tool=safe_tool,
        )
    if not isinstance(configure_page, bool):
        return error_envelope(
            "STREAMLIT_INVALID_OPTIONS",
            "configure_page must be a boolean",
            tool=safe_tool,
        )

    for opt_name, opt_val in (
        ("subtitle", subtitle),
        ("badge_text", badge_text),
        ("disclaimer", disclaimer),
        ("health_status", health_status),
    ):
        if opt_val is not None and not isinstance(opt_val, str):
            return error_envelope(
                "STREAMLIT_INVALID_OPTIONS",
                f"{opt_name} must be a string when provided",
                {"field": opt_name},
                tool=safe_tool,
            )

    st = _resolve_st(st_module)
    markdown_fn = getattr(st, "markdown", None) if st is not None else None
    if st is None or not callable(markdown_fn):
        return error_envelope("STREAMLIT_UNAVAILABLE", "Streamlit runtime is not available", tool=safe_tool)

    clean_title = title.strip()
    resolved_icon = page_icon if isinstance(page_icon, str) and page_icon.strip() else "🛡️"

    set_page_config_fn = getattr(st, "set_page_config", None)
    if configure_page is True and callable(set_page_config_fn):
        try:
            set_page_config_fn(
                page_title=clean_title,
                page_icon=resolved_icon,
                layout="wide",
                initial_sidebar_state="expanded",
            )
        except Exception as exc:
            if not _is_ignorable_page_config_error(exc):
                return error_envelope(
                    "STREAMLIT_RENDER_ERROR",
                    str(exc) or "Failed configuring Streamlit page",
                    tool=safe_tool,
                )

    resolved_accent_label, _ = _resolve_accent_palette(accent)
    theme_css = build_airgapped_theme_css(accent)

    pills_html: list[str] = []
    if badge_text and badge_text.strip():
        pills_html.append(f'<span class="krusch-rag-pill">{html.escape(badge_text.strip(), quote=True)}</span>')

    normalized_health: str | None = None
    if health_status is not None and health_status.strip():
        raw_health = health_status.strip()
        lowered_health = raw_health.lower()
        if lowered_health in _VALID_HEALTH_STATES:
            normalized_health = lowered_health
            pills_html.append(
                f'<span class="krusch-rag-pill krusch-rag-pill--{normalized_health}">'
                f"{html.escape(normalized_health.upper(), quote=True)}</span>"
            )
        else:
            normalized_health = "unknown"
            pills_html.append(
                f'<span class="krusch-rag-pill">{html.escape(raw_health.upper(), quote=True)}</span>'
            )

    escaped_title = html.escape(clean_title, quote=True)
    subtitle_block = (
        f'<p class="krusch-rag-subtitle">{html.escape(subtitle.strip(), quote=True)}</p>'
        if subtitle and subtitle.strip()
        else ""
    )
    pills_block = f'<div class="krusch-rag-pills">{"".join(pills_html)}</div>' if pills_html else ""
    disclaimer_block = (
        f'<div class="krusch-rag-disclaimer">{html.escape(disclaimer.strip(), quote=True)}</div>'
        if disclaimer and disclaimer.strip()
        else ""
    )

    shell_html = (
        '<div class="krusch-rag-header">'
        '<div class="krusch-rag-header-row">'
        f'<h1 class="krusch-rag-title">{escaped_title}</h1>'
        f"{pills_block}"
        "</div>"
        f"{subtitle_block}"
        "</div>"
        f"{disclaimer_block}"
    )
    rendered_html = f"{theme_css}\n{shell_html}"

    try:
        markdown_fn(rendered_html, unsafe_allow_html=True)
    except Exception as exc:
        return error_envelope(
            "STREAMLIT_RENDER_ERROR",
            str(exc) or "Failed rendering sovereign RAG shell",
            tool=safe_tool,
        )

    if getattr(st, "session_state", None) is not None:
        state_res = init_rag_session_state(st_module=st, max_turns=max_turns, tool=safe_tool)
        if not state_res["ok"]:
            return state_res

    return ok_envelope(
        safe_tool,
        f"Rendered sovereign RAG shell: {clean_title}",
        {
            "title": clean_title,
            "accent": resolved_accent_label,
            "health_status": normalized_health,
            "html": rendered_html,
        },
    )
