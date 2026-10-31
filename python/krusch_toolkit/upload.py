"""
Bounded File Upload, Filename Sanitizer & Magic-Byte MIME Guard Lego Bricks (`INV-LEGO-01`, `INV-LEGO-18`, `INV-LEGO-20`).

Imports cleanly in bare Python 3.11+ stdlib without FastAPI or Starlette installed while supporting
async `UploadFile`, sync file-like streams, async byte iterables, and raw `bytes`/`bytearray`.
"""

from __future__ import annotations

import inspect
import re
from collections.abc import AsyncIterable, Sequence
from typing import Any

from krusch_toolkit.fastapi_app import error_envelope, ok_envelope

__all__ = [
    "sanitize_upload_filename",
    "sniff_mime_magic",
    "verify_upload_mime",
    "read_bounded_upload",
]

_DEFAULT_FALLBACK_FILENAME = "upload.bin"
_DEFAULT_MAX_FILENAME_LENGTH = 128
_DEFAULT_MAX_UPLOAD_BYTES = 5_242_880  # 5 MiB
_DEFAULT_CHUNK_SIZE = 65_536  # 64 KiB

_WINDOWS_RESERVED_STEMS = frozenset(
    {
        "CON",
        "PRN",
        "AUX",
        "NUL",
        *(f"COM{idx}" for idx in range(1, 10)),
        *(f"LPT{idx}" for idx in range(1, 10)),
    }
)

# Strip NUL, C0/C1 control chars, and Unicode bidirectional override/isolate/mark characters
_CONTROL_AND_BIDI_RE = re.compile(
    r"[\x00-\x1f\x7f-\x9f\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]+"
)
_UNSAFE_FS_CHARS_RE = re.compile(r'[<>:"|?*]+')
_PATH_SPLIT_RE = re.compile(r"[/\\]")

_CANONICAL_MIME_ALIASES: dict[str, str] = {
    "image/jpg": "image/jpeg",
    "image/pjpeg": "image/jpeg",
    "image/x-png": "image/png",
    "audio/x-wav": "audio/wav",
    "audio/wave": "audio/wav",
    "audio/vnd.wave": "audio/wav",
    "audio/mp3": "audio/mpeg",
    "audio/x-mp3": "audio/mpeg",
    "audio/mpeg3": "audio/mpeg",
    "application/ogg": "audio/ogg",
    "audio/vorbis": "audio/ogg",
    "application/x-zip-compressed": "application/zip",
    "multipart/x-zip": "application/zip",
}

_MAGIC_VERIFIABLE_MIMES = frozenset(
    {
        "application/pdf",
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/webp",
        "audio/wav",
        "audio/mpeg",
        "audio/ogg",
        "audio/webm",
        "video/webm",
        "application/zip",
    }
)

_MAGIC_VERIFIABLE_FAMILIES = frozenset({"image", "audio", "video"})


def _normalize_mime_token(raw_mime: str | None) -> str:
    if not isinstance(raw_mime, str):
        return ""
    base = raw_mime.split(";", 1)[0].strip().lower()
    return _CANONICAL_MIME_ALIASES.get(base, base)


def _are_mimes_equivalent(declared: str, detected: str) -> bool:
    if not declared or not detected:
        return False
    canon_declared = _normalize_mime_token(declared)
    canon_detected = _normalize_mime_token(detected)
    if canon_declared == canon_detected:
        return True
    return (canon_declared == "audio/webm" and canon_detected == "video/webm") or (
        canon_declared == "video/webm" and canon_detected == "audio/webm"
    )


_WHITESPACE_RUN_RE = re.compile(r"\s+")


def _is_windows_reserved_stem(candidate: str) -> bool:
    trimmed = candidate.rstrip(". \t")
    if not trimmed:
        return False
    first_dot_seg = trimmed.split(".", 1)[0].rstrip(". \t")
    return trimmed.upper() in _WINDOWS_RESERVED_STEMS or first_dot_seg.upper() in _WINDOWS_RESERVED_STEMS


def _neutralize_windows_reserved(candidate: str) -> str:
    if _is_windows_reserved_stem(candidate):
        return f"_{candidate}"
    return candidate


def _sanitize_filename_candidate(raw_candidate: str, effective_max: int) -> str:
    if not isinstance(raw_candidate, str) or not raw_candidate:
        return ""
    basename = _PATH_SPLIT_RE.split(raw_candidate)[-1]
    cleaned = _CONTROL_AND_BIDI_RE.sub("", basename)
    cleaned = _UNSAFE_FS_CHARS_RE.sub("_", cleaned)
    cleaned = cleaned.lstrip(". \t-").rstrip(". \t")
    cleaned = _WHITESPACE_RUN_RE.sub("_", cleaned)
    cleaned = cleaned.lstrip(". \t-").rstrip(". \t")
    if not cleaned:
        return ""

    cleaned = _neutralize_windows_reserved(cleaned)

    if len(cleaned) > effective_max:
        dot_idx = cleaned.rfind(".")
        if 0 < dot_idx < len(cleaned) - 1:
            ext = cleaned[dot_idx:]
            if len(ext) < effective_max:
                stem_budget = effective_max - len(ext)
                stem = cleaned[:stem_budget].rstrip(". \t")
                if stem:
                    if _is_windows_reserved_stem(stem):
                        if stem_budget <= 1:
                            return ""
                        shorter = cleaned[: stem_budget - 1].rstrip(". \t")
                        if not shorter:
                            return ""
                        cleaned = f"_{shorter}{ext}"
                    else:
                        cleaned = f"{stem}{ext}"
                else:
                    cleaned = cleaned[:effective_max].rstrip(". \t")
            else:
                cleaned = cleaned[:effective_max].rstrip(". \t")
        else:
            cleaned = cleaned[:effective_max].rstrip(". \t")

    cleaned = cleaned.lstrip(". \t").rstrip(". \t")
    if not cleaned:
        return ""

    if _is_windows_reserved_stem(cleaned):
        if effective_max < 2:
            return ""
        trimmed_slice = cleaned[: effective_max - 1].rstrip(". \t")
        prefixed = f"_{trimmed_slice}"
        return prefixed if len(prefixed) > 1 and len(prefixed) <= effective_max else ""

    return cleaned


def sanitize_upload_filename(
    raw_filename: str = "",
    *,
    fallback: str = _DEFAULT_FALLBACK_FILENAME,
    max_length: int = _DEFAULT_MAX_FILENAME_LENGTH,
) -> str:
    """
    Sanitize an untrusted upload filename (`INV-LEGO-18`, `INV-LEGO-20`).

    Strips POSIX/Windows directory traversal prefixes (`/` and `\\`), NUL/control/bidi characters,
    leading dots (`.env`, `..`), trailing dots/spaces, and Windows reserved device names
    (`CON`, `PRN`, `AUX`, `NUL`, `COM1..9`, `LPT1..9`), truncating cleanly while preserving extensions.
    """
    effective_max = (
        max_length
        if isinstance(max_length, int) and not isinstance(max_length, bool) and max_length >= 1
        else _DEFAULT_MAX_FILENAME_LENGTH
    )

    raw_fb = fallback if isinstance(fallback, str) and fallback.strip() else _DEFAULT_FALLBACK_FILENAME
    safe_fallback = (
        _sanitize_filename_candidate(raw_fb, effective_max)
        or _sanitize_filename_candidate(_DEFAULT_FALLBACK_FILENAME, effective_max)
        or "u"[:effective_max]
    )

    if not isinstance(raw_filename, str) or not raw_filename:
        return safe_fallback

    cleaned = _sanitize_filename_candidate(raw_filename, effective_max)
    return cleaned or safe_fallback


def sniff_mime_magic(data: bytes | bytearray | memoryview) -> str | None:
    """
    Inspect leading magic bytes of a buffer and return canonical MIME type or `None`.

    Detects: `application/pdf`, `image/png`, `image/jpeg`, `image/gif`, `image/webp`,
    `audio/wav`, `audio/mpeg`, `audio/ogg`, `video/webm`, `application/zip`.
    """
    if not isinstance(data, (bytes, bytearray, memoryview)) or len(data) == 0:
        return None

    head = bytes(data[:64])
    length = len(head)

    if length >= 5 and head.startswith(b"%PDF-"):
        return "application/pdf"

    if length >= 8 and head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"

    if length >= 3 and head.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"

    if length >= 6 and (head.startswith(b"GIF87a") or head.startswith(b"GIF89a")):
        return "image/gif"

    if length >= 12 and head[0:4] == b"RIFF":
        fourcc = head[8:12]
        if fourcc == b"WEBP":
            return "image/webp"
        if fourcc == b"WAVE":
            return "audio/wav"

    if length >= 4 and head.startswith(b"OggS"):
        return "audio/ogg"

    if length >= 4 and head.startswith(b"\x1a\x45\xdf\xa3"):
        return "video/webm"

    if length >= 4 and head[0:4] in {b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08"}:
        return "application/zip"

    if length >= 3 and head.startswith(b"ID3"):
        return "audio/mpeg"

    # MPEG Audio Frame Sync: 11 set sync bits (0xFF, 0xE0), valid version (!= 01), valid layer (!= 00),
    # and non-0xF bitrate nibble when 3rd byte is available (prevents matching raw 0xFF padding).
    if (
        length >= 2
        and head[0] == 0xFF
        and (head[1] & 0xE0) == 0xE0
        and (head[1] & 0x18) != 0x08
        and (head[1] & 0x06) != 0x00
        and (length < 3 or (head[2] & 0xF0) != 0xF0)
    ):
        return "audio/mpeg"

    return None


def _matches_mime_pattern(
    effective_mime: str,
    detected_mime: str | None,
    pattern: str,
    require_magic_match: bool,
) -> bool:
    norm_pattern = _normalize_mime_token(pattern)
    if not norm_pattern or not effective_mime:
        return False
    if norm_pattern in {"*/*", "*"}:
        return True
    if norm_pattern.endswith("/*"):
        family = norm_pattern[:-2]
        prefix = f"{family}/"
        if require_magic_match and family in _MAGIC_VERIFIABLE_FAMILIES:
            if detected_mime is None:
                return False
            if detected_mime.startswith(prefix):
                return True
            return family == "audio" and effective_mime == "audio/webm" and detected_mime == "video/webm"
        return effective_mime.startswith(prefix)
    if effective_mime == norm_pattern:
        return True
    return bool(
        detected_mime == "video/webm"
        and (
            (effective_mime == "video/webm" and norm_pattern == "audio/webm")
            or (effective_mime == "audio/webm" and norm_pattern == "video/webm")
        )
    )


def _pattern_requires_magic(pattern: str) -> bool:
    norm = _normalize_mime_token(pattern)
    if norm in _MAGIC_VERIFIABLE_MIMES:
        return True
    return norm.endswith("/*") and norm[:-2] in _MAGIC_VERIFIABLE_FAMILIES


def _contains_svg_or_active_markup(data: bytes | bytearray | memoryview) -> bool:
    probe = bytes(data[:4096]).lstrip().lower()
    return (
        b"<svg" in probe
        or b"<script" in probe
        or probe.startswith(b"<!doctype html")
        or probe.startswith(b"<html")
    )


def verify_upload_mime(
    data: bytes | bytearray | memoryview,
    declared_mime: str = "",
    *,
    allowed_mime_types: Sequence[str] | set[str] | None = None,
    require_magic_match: bool = True,
    tool: str = "upload.mime",
) -> dict[str, Any]:
    """
    Non-throwing MIME & magic-signature validator (`INV-LEGO-01`, `INV-LEGO-18`, `INV-LEGO-20`).

    Blocks spoofed binary headers and active XML/SVG (`<svg><script>`) payloads under `image/*`
    when `require_magic_match=True`.
    """
    safe_tool = tool.strip() if isinstance(tool, str) and tool.strip() else "upload.mime"

    if not isinstance(data, (bytes, bytearray, memoryview)):
        return error_envelope("UPLOAD_INVALID_DATA", "Upload data must be bytes-like", None, safe_tool)

    if len(data) == 0:
        return error_envelope("UPLOAD_EMPTY", "Upload data cannot be empty (0 bytes)", {"size": 0}, safe_tool)

    raw_declared = (
        declared_mime.split(";", 1)[0].strip().lower()
        if isinstance(declared_mime, str)
        else ""
    )
    canonical_declared = _normalize_mime_token(raw_declared)
    detected = sniff_mime_magic(data)

    allow_list: list[str] | None = None
    if allowed_mime_types is not None:
        if isinstance(allowed_mime_types, str):
            allow_list = [_normalize_mime_token(allowed_mime_types)]
        elif isinstance(allowed_mime_types, (bytes, bytearray, memoryview)):
            allow_list = []
        else:
            try:
                allow_list = [
                    _normalize_mime_token(item)
                    for item in allowed_mime_types
                    if isinstance(item, str) and item.strip()
                ]
            except Exception:
                allow_list = []
        allow_list = [item for item in allow_list if item]
        if not allow_list:
            return error_envelope(
                "UPLOAD_UNSUPPORTED_MIME",
                "No MIME types are permitted by allowlist",
                {"declared_mime": raw_declared or None, "detected_mime": detected},
                safe_tool,
            )

    effective_mime = (
        "audio/webm"
        if canonical_declared == "audio/webm" and detected == "video/webm"
        else (detected or canonical_declared or "application/octet-stream")
    )

    if require_magic_match:
        allowlist_image_only = allow_list is not None and all(
            pat.startswith("image/") for pat in allow_list
        )
        if (
            raw_declared == "image/svg+xml"
            or canonical_declared == "image/svg+xml"
            or (
                (effective_mime.startswith("image/") or allowlist_image_only)
                and _contains_svg_or_active_markup(data)
            )
        ):
            return error_envelope(
                "UPLOAD_MIME_MISMATCH",
                "SVG or active script markup is blocked under magic-verified image uploads",
                {"declared_mime": raw_declared or None, "detected_mime": detected},
                safe_tool,
            )

        if (
            detected is not None
            and canonical_declared
            and canonical_declared != "application/octet-stream"
            and not _are_mimes_equivalent(canonical_declared, detected)
        ):
            return error_envelope(
                "UPLOAD_MIME_MISMATCH",
                f"Declared MIME '{raw_declared}' does not match detected magic '{detected}'",
                {"declared_mime": raw_declared, "detected_mime": detected},
                safe_tool,
            )

        if detected is None:
            declared_needs_magic = bool(canonical_declared) and (
                canonical_declared in _MAGIC_VERIFIABLE_MIMES
                or canonical_declared.startswith(("image/", "audio/", "video/"))
            )
            allowlist_strictly_binary = allow_list is not None and all(
                _pattern_requires_magic(pat) for pat in allow_list
            )
            if declared_needs_magic or (
                allowlist_strictly_binary
                and (not canonical_declared or canonical_declared == "application/octet-stream")
            ):
                return error_envelope(
                    "UPLOAD_MIME_MISMATCH",
                    "Upload lacks valid binary magic signature for declared/allowed MIME type",
                    {"declared_mime": raw_declared or None, "detected_mime": None},
                    safe_tool,
                )

    if allow_list is not None and not any(
        _matches_mime_pattern(effective_mime, detected, pat, require_magic_match)
        for pat in allow_list
    ):
        return error_envelope(
            "UPLOAD_UNSUPPORTED_MIME",
            f"Unsupported upload MIME type: {effective_mime}",
            {
                "mime_type": effective_mime,
                "declared_mime": raw_declared or None,
                "detected_mime": detected,
                "allowed_mime_types": allow_list,
            },
            safe_tool,
        )

    return ok_envelope(
        safe_tool,
        "Upload MIME verified",
        {
            "mime_type": effective_mime,
            "declared_mime": raw_declared or None,
            "detected_mime": detected,
        },
    )


async def read_bounded_upload(
    upload_or_stream: Any,
    *,
    max_bytes: int = _DEFAULT_MAX_UPLOAD_BYTES,
    chunk_size: int = _DEFAULT_CHUNK_SIZE,
    filename: str | None = None,
    content_type: str | None = None,
    allowed_mime_types: Sequence[str] | set[str] | None = None,
    require_magic_match: bool = True,
    tool: str = "upload.read",
) -> dict[str, Any]:
    """
    Read an upload stream (`UploadFile`, file-like object, async byte iterable, or `bytes`)
    enforcing `max_bytes` chunk-by-chunk BEFORE buffering overflow (`INV-LEGO-18`, `INV-LEGO-20`).
    """
    safe_tool = tool.strip() if isinstance(tool, str) and tool.strip() else "upload.read"

    if isinstance(max_bytes, bool) or not isinstance(max_bytes, int) or max_bytes < 1:
        return error_envelope("UPLOAD_INVALID_CONFIG", "max_bytes must be an integer >= 1", None, safe_tool)

    if isinstance(chunk_size, bool) or not isinstance(chunk_size, int) or chunk_size < 1:
        return error_envelope("UPLOAD_INVALID_CONFIG", "chunk_size must be an integer >= 1", None, safe_tool)

    orig_name = filename if filename is not None else ""
    declared_ct = content_type if content_type is not None else ""
    buf = bytearray()

    read_fn = None
    if not isinstance(upload_or_stream, (bytes, bytearray, memoryview)):
        try:
            candidate_read = getattr(upload_or_stream, "read", None)
            if callable(candidate_read):
                read_fn = candidate_read
        except Exception as exc:
            return error_envelope(
                "UPLOAD_READ_ERROR",
                str(exc) or "Failed inspecting upload stream",
                None,
                safe_tool,
            )

    if isinstance(upload_or_stream, (bytes, bytearray, memoryview)):
        raw_len = len(upload_or_stream)
        if raw_len > max_bytes:
            return error_envelope(
                "UPLOAD_TOO_LARGE",
                f"Upload size ({raw_len} bytes) exceeds maximum ({max_bytes} bytes)",
                {"size": raw_len, "max_bytes": max_bytes},
                safe_tool,
            )
        buf.extend(upload_or_stream)
    elif read_fn is not None:
        if filename is None:
            try:
                attr_name = getattr(upload_or_stream, "filename", None) or getattr(upload_or_stream, "name", None)
            except Exception:
                attr_name = None
            if isinstance(attr_name, str):
                orig_name = attr_name
        if content_type is None:
            try:
                attr_ct = getattr(upload_or_stream, "content_type", None)
            except Exception:
                attr_ct = None
            if isinstance(attr_ct, str):
                declared_ct = attr_ct

        read_step = min(chunk_size, max_bytes + 1)
        try:
            while True:
                maybe_chunk = read_fn(read_step)
                chunk = await maybe_chunk if inspect.isawaitable(maybe_chunk) else maybe_chunk
                if not chunk:
                    break
                chunk_bytes = chunk.encode("utf-8") if isinstance(chunk, str) else chunk
                if not isinstance(chunk_bytes, (bytes, bytearray, memoryview)):
                    buf.clear()
                    return error_envelope(
                        "UPLOAD_INVALID_DATA",
                        "Stream read() returned non-bytes chunk",
                        None,
                        safe_tool,
                    )
                next_total = len(buf) + len(chunk_bytes)
                if next_total > max_bytes:
                    buf.clear()
                    return error_envelope(
                        "UPLOAD_TOO_LARGE",
                        f"Upload stream exceeded maximum size ({max_bytes} bytes)",
                        {"read_bytes": next_total, "max_bytes": max_bytes},
                        safe_tool,
                    )
                buf.extend(chunk_bytes)
        except Exception as exc:
            buf.clear()
            return error_envelope(
                "UPLOAD_READ_ERROR",
                str(exc) or "Failed reading upload stream",
                None,
                safe_tool,
            )
    elif isinstance(upload_or_stream, AsyncIterable):
        try:
            async for chunk in upload_or_stream:
                if not chunk:
                    continue
                chunk_bytes = chunk.encode("utf-8") if isinstance(chunk, str) else chunk
                if not isinstance(chunk_bytes, (bytes, bytearray, memoryview)):
                    buf.clear()
                    return error_envelope(
                        "UPLOAD_INVALID_DATA",
                        "Async stream yielded non-bytes chunk",
                        None,
                        safe_tool,
                    )
                next_total = len(buf) + len(chunk_bytes)
                if next_total > max_bytes:
                    buf.clear()
                    return error_envelope(
                        "UPLOAD_TOO_LARGE",
                        f"Upload stream exceeded maximum size ({max_bytes} bytes)",
                        {"read_bytes": next_total, "max_bytes": max_bytes},
                        safe_tool,
                    )
                buf.extend(chunk_bytes)
        except Exception as exc:
            buf.clear()
            return error_envelope(
                "UPLOAD_READ_ERROR",
                str(exc) or "Failed iterating async upload stream",
                None,
                safe_tool,
            )
    else:
        return error_envelope(
            "UPLOAD_INVALID_SOURCE",
            "Expected UploadFile, readable stream, async byte iterable, or bytes-like object",
            None,
            safe_tool,
        )

    if len(buf) == 0:
        return error_envelope("UPLOAD_EMPTY", "Uploaded payload cannot be empty (0 bytes)", {"size": 0}, safe_tool)

    safe_name = sanitize_upload_filename(str(orig_name or ""))
    detected = sniff_mime_magic(buf)

    if allowed_mime_types is not None or require_magic_match:
        mime_res = verify_upload_mime(
            buf,
            str(declared_ct or ""),
            allowed_mime_types=allowed_mime_types,
            require_magic_match=require_magic_match,
            tool=safe_tool,
        )
        if not mime_res["ok"]:
            buf.clear()
            return mime_res
        mime_out = mime_res["data"]["mime_type"]
    else:
        norm_ct = _normalize_mime_token(declared_ct)
        mime_out = norm_ct or detected or "application/octet-stream"

    final_bytes = bytes(buf)
    buf.clear()

    return ok_envelope(
        safe_tool,
        "Upload read and verified",
        {
            "filename": safe_name,
            "original_filename": str(orig_name or ""),
            "mime_type": mime_out,
            "detected_mime": detected,
            "size": len(final_bytes),
            "data": final_bytes,
        },
    )
