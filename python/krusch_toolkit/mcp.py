"""
MCP Lego Bricks — deterministic tool normalization (INV-STACK-03), universal envelopes (INV-LEGO-01),
required-argument validation, and async/sync tool dispatch.

Imports cleanly in bare Python 3.11+ with zero external runtime dependencies.
"""

from __future__ import annotations

import inspect
import json
from collections.abc import Callable, Sequence
from typing import Any

from krusch_toolkit.fastapi_app import error_envelope, ok_envelope

__all__ = [
    "define_mcp_tool",
    "ok_mcp_result",
    "error_mcp_result",
    "validate_tool_args",
    "dispatch_mcp_tool",
]


def _coalesce_bool(primary: Any, secondary: Any, default: bool) -> bool:
    if primary is not None:
        return bool(primary)
    if secondary is not None:
        return bool(secondary)
    return bool(default)


def define_mcp_tool(
    *,
    name: str,
    title: str | None = None,
    description: str = "",
    input_schema: dict[str, Any] | None = None,
    read_only_hint: bool | None = None,
    destructive_hint: bool | None = None,
    idempotent_hint: bool | None = None,
    open_world_hint: bool | None = None,
    annotations: dict[str, Any] | None = None,
    **extra: Any,
) -> dict[str, Any]:
    """Normalize an MCP tool definition and enforce INV-STACK-03 4-boolean annotations + title."""
    if not isinstance(name, str) or not name.strip():
        raise ValueError('[define_mcp_tool] Tool "name" must be a non-empty string.')

    clean_name = name.strip()
    extra_copy = dict(extra)

    camel_schema = extra_copy.pop("inputSchema", None)
    raw_schema = input_schema if input_schema is not None else camel_schema

    camel_ro = extra_copy.pop("readOnlyHint", None)
    camel_dest = extra_copy.pop("destructiveHint", None)
    camel_idem = extra_copy.pop("idempotentHint", None)
    camel_ow = extra_copy.pop("openWorldHint", None)

    ro_val = read_only_hint if read_only_hint is not None else camel_ro
    dest_val = destructive_hint if destructive_hint is not None else camel_dest
    idem_val = idempotent_hint if idempotent_hint is not None else camel_idem
    ow_val = open_world_hint if open_world_hint is not None else camel_ow

    if isinstance(raw_schema, dict):
        raw_props = raw_schema.get("properties")
        normalized_schema: dict[str, Any] = {
            **raw_schema,
            "type": str(raw_schema.get("type") or "object"),
            "properties": dict(raw_props) if isinstance(raw_props, dict) else {},
        }
    else:
        normalized_schema = {"type": "object", "properties": {}}

    raw_annotations = dict(annotations) if isinstance(annotations, dict) else {}
    if title is not None and str(title).strip():
        resolved_title = str(title).strip()
    elif raw_annotations.get("title") is not None and str(raw_annotations.get("title")).strip():
        resolved_title = str(raw_annotations["title"]).strip()
    else:
        resolved_title = clean_name

    return {
        **extra_copy,
        "name": clean_name,
        "description": "" if description is None else str(description),
        "inputSchema": normalized_schema,
        "annotations": {
            **raw_annotations,
            "title": resolved_title,
            "readOnlyHint": _coalesce_bool(ro_val, raw_annotations.get("readOnlyHint"), True),
            "destructiveHint": _coalesce_bool(dest_val, raw_annotations.get("destructiveHint"), False),
            "idempotentHint": _coalesce_bool(idem_val, raw_annotations.get("idempotentHint"), True),
            "openWorldHint": _coalesce_bool(ow_val, raw_annotations.get("openWorldHint"), False),
        },
    }


def ok_mcp_result(tool: str, summary: str, data: dict[str, Any] | None = None) -> dict[str, Any]:
    """Wrap an INV-LEGO-01 success envelope in a standard MCP text content result."""
    envelope = ok_envelope(tool or "mcp", summary, data)
    return {
        "content": [
            {
                "type": "text",
                "text": json.dumps(envelope, default=str),
            }
        ]
    }


def error_mcp_result(tool: str, code: str, message: str, details: Any = None) -> dict[str, Any]:
    """Wrap an INV-LEGO-01 error envelope in a standard MCP error content result."""
    envelope = error_envelope(code or "TOOL_ERROR", message, details, tool or "mcp")
    return {
        "isError": True,
        "content": [
            {
                "type": "text",
                "text": json.dumps(envelope, default=str),
            }
        ],
    }


def validate_tool_args(tool_def: dict[str, Any], args: dict[str, Any] | None = None) -> dict[str, Any]:
    """
    Validate required fields declared in `tool_def["inputSchema"]["required"]`.
    Rejects missing keys and `None` values while preserving `0`, `False`, and `""`.
    """
    if not isinstance(tool_def, dict):
        return {"valid": True, "missing": []}

    schema = tool_def.get("inputSchema")
    if not isinstance(schema, dict):
        schema = tool_def.get("input_schema")
    required_raw = schema.get("required") if isinstance(schema, dict) else None
    if not isinstance(required_raw, (list, tuple)) or len(required_raw) == 0:
        return {"valid": True, "missing": []}

    required_fields = [str(field) for field in required_raw]
    if args is None:
        return {"valid": False, "missing": required_fields}
    if not isinstance(args, dict):
        return {"valid": False, "missing": required_fields}

    missing = [key for key in required_fields if key not in args or args[key] is None]
    return {
        "valid": len(missing) == 0,
        "missing": missing,
    }


def _normalize_tool_entry(tool: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(tool, dict):
        raise ValueError("[dispatch_mcp_tool] Every tool definition must be a dict.")
    raw_copy = dict(tool)
    raw_name = raw_copy.pop("name", "")
    return define_mcp_tool(name=raw_name, **raw_copy)


async def dispatch_mcp_tool(
    tools: Sequence[dict[str, Any]],
    handler: Callable[[str, dict[str, Any]], Any],
    name: str,
    args: dict[str, Any] | None = None,
    *,
    validate_args: bool = True,
) -> dict[str, Any]:
    """
    Normalize tools, validate required arguments, invoke sync or async `handler(name, safe_args)`,
    and guarantee an MCP content envelope without leaking unhandled exceptions.
    """
    clean_name = name.strip() if isinstance(name, str) else ""
    tool_map: dict[str, dict[str, Any]] = {}
    for entry in tools:
        normalized = _normalize_tool_entry(entry)
        tool_map[normalized["name"]] = normalized

    if not clean_name or clean_name not in tool_map:
        return error_mcp_result(
            clean_name or "mcp",
            "UNKNOWN_TOOL",
            f"Unknown tool: {clean_name or '<empty>'}",
        )

    tool_def = tool_map[clean_name]
    if validate_args:
        validation = validate_tool_args(tool_def, args)
        if not validation["valid"]:
            missing_list = validation["missing"]
            return error_mcp_result(
                clean_name,
                "INVALID_ARGUMENTS",
                f"Missing required argument(s) for {clean_name}: {', '.join(missing_list)}",
                {"missing": missing_list},
            )

    safe_args: dict[str, Any] = dict(args) if isinstance(args, dict) else {}

    try:
        result = handler(clean_name, safe_args)
        if inspect.isawaitable(result):
            result = await result
    except Exception as exc:
        return error_mcp_result(
            clean_name,
            "TOOL_EXECUTION_ERROR",
            str(exc) or type(exc).__name__,
        )

    if isinstance(result, dict) and isinstance(result.get("content"), list):
        return result

    if isinstance(result, dict) and isinstance(result.get("ok"), bool):
        return {
            "content": [{"type": "text", "text": json.dumps(result, default=str)}],
            **({"isError": True} if result["ok"] is False else {}),
        }

    if isinstance(result, dict):
        return ok_mcp_result(clean_name, "Completed", result)

    return ok_mcp_result(clean_name, "Completed", {"result": result})
