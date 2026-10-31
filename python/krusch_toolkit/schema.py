"""
Schema & Payload Validation Lego Bricks (`INV-LEGO-01`, `INV-LEGO-20`).

Zero external dependencies: imports cleanly in bare Python 3.11+ stdlib while supporting
both JSON Schema Draft-7/2020-12 dicts and duck-typed Pydantic v2 (`model_validate`) /
Pydantic v1 (`parse_obj`) models. Never raises on untrusted payloads.
"""

from __future__ import annotations

import copy
import datetime
import inspect
import ipaddress
import math
import uuid
from collections.abc import Mapping, Sequence
from typing import Any
from urllib.parse import urlsplit

from krusch_toolkit.fastapi_app import error_envelope, ok_envelope

__all__ = [
    "validate_json_schema",
    "validate_payload",
]

_FORBIDDEN_OBJECT_KEYS = frozenset({"__proto__", "constructor", "prototype"})
_VALID_JSON_TYPES = frozenset({"object", "array", "string", "number", "integer", "boolean", "null"})
_EMAIL_LOCAL_ALLOWED = frozenset(
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.!#$%&'*+/=?^_`{|}~-"
)
_SLUG_ALLOWED = frozenset("abcdefghijklmnopqrstuvwxyz0123456789")
_HEX_DIGITS = frozenset("0123456789abcdefABCDEF")


class _SchemaBailoutError(Exception):
    """Internal control-flow signal for structural bailouts (cycles, depth, malformed schema)."""

    def __init__(self, code: str, message: str, path: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.path = path


def _is_valid_json_int(val: Any) -> bool:
    """Strictly distinguish Python `int` from `bool` (`isinstance(True, int)` is True in Python)."""
    return isinstance(val, int) and not isinstance(val, bool)


def _is_valid_json_number(val: Any) -> bool:
    """Reject `bool`, `NaN`, and `±Infinity` while handling arbitrary-precision `int` safely."""
    if isinstance(val, bool):
        return False
    if isinstance(val, int):
        return True
    if isinstance(val, float):
        return not (math.isnan(val) or math.isinf(val))
    return False


def _json_equals(left: Any, right: Any) -> bool:
    """Compare two JSON values without conflating `True == 1` or `False == 0`."""
    if isinstance(left, bool) != isinstance(right, bool):
        return False
    if left is None or right is None:
        return left is right
    if _is_valid_json_number(left) and _is_valid_json_number(right):
        return left == right
    if isinstance(left, list) and isinstance(right, list):
        return len(left) == len(right) and all(_json_equals(a, b) for a, b in zip(left, right, strict=True))
    if isinstance(left, Mapping) and isinstance(right, Mapping):
        if set(left.keys()) != set(right.keys()):
            return False
        return all(_json_equals(left[k], right[k]) for k in left)
    return type(left) is type(right) and left == right


def _check_format(fmt: str, value: str) -> bool:
    """Deterministic, zero-backtracking ReDoS-safe format validators."""
    if fmt == "email":
        if len(value) < 3 or len(value) > 254:
            return False
        if any(ord(ch) <= 32 or ord(ch) == 127 for ch in value):
            return False
        if value.count("@") != 1:
            return False
        local, domain = value.split("@")
        if not (1 <= len(local) <= 64) or local.startswith(".") or local.endswith(".") or ".." in local:
            return False
        if not all(ch in _EMAIL_LOCAL_ALLOWED for ch in local):
            return False
        if not (3 <= len(domain) <= 253) or "." not in domain:
            return False
        labels = domain.split(".")
        for label in labels:
            if not (1 <= len(label) <= 63) or label.startswith("-") or label.endswith("-"):
                return False
            if not all(ch.isalnum() or ch == "-" for ch in label):
                return False
        return len(labels[-1]) >= 2 and labels[-1].isalpha()

    if fmt == "uuid":
        if len(value) != 36:
            return False
        for idx, ch in enumerate(value):
            if idx in {8, 13, 18, 23}:
                if ch != "-":
                    return False
            elif ch not in _HEX_DIGITS:
                return False
        try:
            uuid.UUID(value)
            return True
        except ValueError:
            return False

    if fmt == "url":
        if not value or len(value) > 4096 or any(ord(ch) <= 32 or ord(ch) == 127 for ch in value):
            return False
        try:
            parts = urlsplit(value)
        except ValueError:
            return False
        return parts.scheme.lower() in {"http", "https"} and bool(parts.netloc) and bool(parts.hostname)

    if fmt == "iso-date":
        # Enforce strict YYYY-MM-DD shape before calendar check via date.fromisoformat
        if len(value) != 10 or value[4] != "-" or value[7] != "-":
            return False
        if not (value[0:4].isdigit() and value[5:7].isdigit() and value[8:10].isdigit()):
            return False
        try:
            datetime.date.fromisoformat(value)
            return True
        except ValueError:
            return False

    if fmt == "iso-datetime":
        if not (20 <= len(value) <= 64):
            return False
        if (
            value[4] != "-"
            or value[7] != "-"
            or value[10] not in ("T", "t")
            or value[13] != ":"
            or value[16] != ":"
        ):
            return False
        if not (
            value[0:4].isdigit()
            and value[5:7].isdigit()
            and value[8:10].isdigit()
            and value[11:13].isdigit()
            and value[14:16].isdigit()
            and value[17:19].isdigit()
        ):
            return False
        rest = value[19:]
        if rest.startswith("."):
            frac_end = 1
            while frac_end < len(rest) and rest[frac_end].isdigit():
                frac_end += 1
            if frac_end == 1 or (frac_end - 1) > 9:
                return False
            tz_part = rest[frac_end:]
        else:
            tz_part = rest
        if tz_part in ("Z", "z"):
            normalized = f"{value[:-1]}+00:00"
        elif (
            len(tz_part) == 6
            and tz_part[0] in ("+", "-")
            and tz_part[1:3].isdigit()
            and tz_part[3] == ":"
            and tz_part[4:6].isdigit()
        ):
            tz_hh = int(tz_part[1:3])
            tz_mm = int(tz_part[4:6])
            if tz_hh > 23 or tz_mm > 59:
                return False
            normalized = f"{value[:10]}T{value[11:]}"
        else:
            return False
        try:
            datetime.datetime.fromisoformat(f"{normalized[:10]}T{normalized[11:]}")
            return True
        except ValueError:
            return False

    if fmt == "ipv4":
        try:
            addr = ipaddress.IPv4Address(value)
            return str(addr) == value
        except ValueError:
            return False

    if fmt == "slug":
        if not (1 <= len(value) <= 256):
            return False
        segments = value.split("-")
        return all(seg and all(ch in _SLUG_ALLOWED for ch in seg) for seg in segments)

    # Unrecognized custom format names pass without throwing (JSON Schema standard annotation behavior)
    return True


def _matches_single_type(expected_type: str, val: Any) -> bool:
    if expected_type == "null":
        return val is None
    if expected_type == "boolean":
        return isinstance(val, bool)
    if expected_type == "integer":
        return _is_valid_json_int(val)
    if expected_type == "number":
        return _is_valid_json_number(val)
    if expected_type == "string":
        return isinstance(val, str)
    if expected_type == "array":
        return isinstance(val, list)
    if expected_type == "object":
        return isinstance(val, Mapping)
    return False


def _try_coerce_value(expected_types: Sequence[str], val: Any) -> Any:
    """Attempt deterministic scalar/tuple coercion only when `coerce=True`."""
    for target in expected_types:
        if target == "integer" and isinstance(val, str):
            stripped = val.strip()
            if stripped and (stripped.isdigit() or (stripped[0] in "+-" and stripped[1:].isdigit())):
                try:
                    return int(stripped)
                except ValueError:
                    pass
        elif target == "number" and isinstance(val, str):
            stripped = val.strip()
            if stripped:
                try:
                    parsed = float(stripped)
                    if not (math.isnan(parsed) or math.isinf(parsed)):
                        return parsed
                except ValueError:
                    pass
        elif target == "boolean" and isinstance(val, str):
            lowered = val.strip().lower()
            if lowered == "true":
                return True
            if lowered == "false":
                return False
        elif target == "string" and _is_valid_json_number(val):
            return str(val)
        elif target == "array" and isinstance(val, tuple):
            return list(val)
    return val


def _sanitize_untyped_value(
    val: Any,
    path: str,
    depth: int,
    max_depth: int,
    active_payload_ids: set[int],
) -> Any:
    """Enforce cycle detection, `max_depth`, finiteness, and prototype-key stripping on unschematized subtrees."""
    if depth > max_depth:
        raise _SchemaBailoutError(
            "SCHEMA_MAX_DEPTH",
            f"Maximum schema validation depth ({max_depth}) exceeded at {path}",
            path,
        )

    if isinstance(val, float) and (math.isnan(val) or math.isinf(val)):
        raise _SchemaBailoutError(
            "VALIDATION_ERROR",
            f"Number must be finite (not NaN or Infinity) at {path}",
            path,
        )

    if isinstance(val, Mapping):
        obj_id = id(val)
        if obj_id in active_payload_ids:
            raise _SchemaBailoutError(
                "SCHEMA_CIRCULAR_REF",
                f"Circular reference detected in payload at {path}",
                path,
            )
        active_payload_ids.add(obj_id)
        try:
            out: dict[str, Any] = {}
            for raw_key, item in val.items():
                if raw_key in _FORBIDDEN_OBJECT_KEYS:
                    continue
                key_str = raw_key if isinstance(raw_key, str) else str(raw_key)
                if key_str in _FORBIDDEN_OBJECT_KEYS:
                    continue
                out[key_str] = _sanitize_untyped_value(
                    item,
                    f"{path}.{key_str}",
                    depth + 1,
                    max_depth,
                    active_payload_ids,
                )
            return out
        finally:
            active_payload_ids.discard(obj_id)

    if isinstance(val, (list, tuple, set, frozenset)):
        obj_id = id(val)
        if obj_id in active_payload_ids:
            raise _SchemaBailoutError(
                "SCHEMA_CIRCULAR_REF",
                f"Circular reference detected in payload at {path}",
                path,
            )
        active_payload_ids.add(obj_id)
        try:
            cleaned = [
                _sanitize_untyped_value(item, f"{path}[{idx}]", depth + 1, max_depth, active_payload_ids)
                for idx, item in enumerate(val)
            ]
            if isinstance(val, list):
                return cleaned
            if isinstance(val, tuple):
                if type(val) is tuple:
                    return tuple(cleaned)
                make_fn = getattr(type(val), "_make", None)
                if hasattr(val, "_fields") and callable(make_fn):
                    try:
                        return make_fn(cleaned)
                    except Exception:
                        return tuple(cleaned)
                try:
                    return type(val)(cleaned)
                except Exception:
                    return tuple(cleaned)
            try:
                return set(cleaned) if isinstance(val, set) else frozenset(cleaned)
            except TypeError as exc:
                raise _SchemaBailoutError("VALIDATION_ERROR", str(exc), path) from exc
        finally:
            active_payload_ids.discard(obj_id)

    return val


def _validate_node(
    schema: Mapping[str, Any],
    val: Any,
    *,
    path: str,
    depth: int,
    max_depth: int,
    coerce: bool,
    strip_unknown: bool,
    active_payload_ids: set[int],
    active_schema_ids: set[int],
    issues: list[dict[str, Any]],
) -> Any:
    if depth > max_depth:
        raise _SchemaBailoutError(
            "SCHEMA_MAX_DEPTH",
            f"Maximum schema validation depth ({max_depth}) exceeded at {path}",
            path,
        )

    schema_id = id(schema)
    if schema_id in active_schema_ids:
        raise _SchemaBailoutError(
            "SCHEMA_CIRCULAR_REF",
            f"Circular reference detected in schema definition at {path}",
            path,
        )

    is_container = isinstance(val, (Mapping, list, tuple, set, frozenset))
    payload_id = id(val) if is_container else None
    if payload_id is not None and payload_id in active_payload_ids:
        raise _SchemaBailoutError(
            "SCHEMA_CIRCULAR_REF",
            f"Circular reference detected in payload at {path}",
            path,
        )

    active_schema_ids.add(schema_id)
    if payload_id is not None:
        active_payload_ids.add(payload_id)

    try:
        current = val

        # 1. `anyOf` branch evaluation
        if "anyOf" in schema:
            any_of_branches = schema["anyOf"]
            if (
                not isinstance(any_of_branches, Sequence)
                or isinstance(any_of_branches, (str, bytes))
                or len(any_of_branches) == 0
                or not all(isinstance(branch, Mapping) for branch in any_of_branches)
            ):
                raise _SchemaBailoutError(
                    "INVALID_SCHEMA",
                    f"anyOf at {path} must be a non-empty list of schema mappings",
                    path,
                )

            matched_any = False
            branch_failures: list[list[dict[str, Any]]] = []
            # Temporarily release current container from active_payload_ids while re-validating same node
            if payload_id is not None:
                active_payload_ids.discard(payload_id)
            try:
                for branch in any_of_branches:
                    candidate_issues: list[dict[str, Any]] = []
                    candidate_val = _validate_node(
                        branch,
                        current,
                        path=path,
                        depth=depth,
                        max_depth=max_depth,
                        coerce=coerce,
                        strip_unknown=strip_unknown,
                        active_payload_ids=active_payload_ids,
                        active_schema_ids=active_schema_ids,
                        issues=candidate_issues,
                    )
                    if not candidate_issues:
                        current = candidate_val
                        matched_any = True
                        break
                    branch_failures.append(candidate_issues)
            finally:
                if payload_id is not None:
                    active_payload_ids.add(payload_id)

            if not matched_any:
                issues.append(
                    {
                        "path": path,
                        "code": "ANY_OF_MISMATCH",
                        "message": f"Value at {path} did not match any branch in anyOf",
                        "branches": branch_failures,
                    }
                )
                return current

        if "oneOf" in schema:
            one_of_branches = schema["oneOf"]
            if (
                not isinstance(one_of_branches, Sequence)
                or isinstance(one_of_branches, (str, bytes, bytearray))
                or len(one_of_branches) == 0
                or not all(isinstance(branch, Mapping) for branch in one_of_branches)
            ):
                raise _SchemaBailoutError(
                    "INVALID_SCHEMA",
                    f"oneOf at {path} must be a non-empty list of schema mappings",
                    path,
                )

            match_count = 0
            matched_one_val: Any = current
            one_of_failures: list[list[dict[str, Any]]] = []
            if payload_id is not None:
                active_payload_ids.discard(payload_id)
            try:
                for branch in one_of_branches:
                    candidate_issues = []
                    candidate_val = _validate_node(
                        branch,
                        current,
                        path=path,
                        depth=depth,
                        max_depth=max_depth,
                        coerce=coerce,
                        strip_unknown=strip_unknown,
                        active_payload_ids=active_payload_ids,
                        active_schema_ids=active_schema_ids,
                        issues=candidate_issues,
                    )
                    if not candidate_issues:
                        match_count += 1
                        if match_count == 1:
                            matched_one_val = candidate_val
                    else:
                        one_of_failures.append(candidate_issues)
            finally:
                if payload_id is not None:
                    active_payload_ids.add(payload_id)

            if match_count == 0:
                issues.append(
                    {
                        "path": path,
                        "code": "ONE_OF_MISMATCH",
                        "message": f"Value at {path} did not match any branch in oneOf",
                        "branches": one_of_failures,
                    }
                )
                return current
            if match_count > 1:
                issues.append(
                    {
                        "path": path,
                        "code": "ONE_OF_MULTIPLE_MATCHES",
                        "message": f"Value at {path} matched {match_count} branches in oneOf (expected 1)",
                    }
                )
                return current
            current = matched_one_val

        # 2. `type` validation (single string or list of type strings)
        if "type" in schema:
            raw_type = schema["type"]
            if isinstance(raw_type, str):
                expected_types = [raw_type]
            elif (
                isinstance(raw_type, Sequence)
                and not isinstance(raw_type, (str, bytes))
                and len(raw_type) > 0
                and all(isinstance(t, str) for t in raw_type)
            ):
                expected_types = list(raw_type)
            else:
                raise _SchemaBailoutError(
                    "INVALID_SCHEMA",
                    f"Invalid 'type' specification at {path}",
                    path,
                )

            for expected in expected_types:
                if expected not in _VALID_JSON_TYPES:
                    raise _SchemaBailoutError(
                        "INVALID_SCHEMA",
                        f"Unsupported JSON Schema type '{expected}' at {path}",
                        path,
                    )

            if not any(_matches_single_type(t, current) for t in expected_types) and coerce:
                current = _try_coerce_value(expected_types, current)

            if not any(_matches_single_type(t, current) for t in expected_types):
                expected_label = expected_types[0] if len(expected_types) == 1 else " | ".join(expected_types)
                actual_label = "boolean" if isinstance(current, bool) else type(current).__name__
                if isinstance(current, float) and (math.isnan(current) or math.isinf(current)):
                    actual_label = "non-finite float (NaN/Infinity)"
                issues.append(
                    {
                        "path": path,
                        "code": "INVALID_TYPE",
                        "message": f"Expected {expected_label} at {path}, got {actual_label}",
                    }
                )
                return current

        # 3. `const` & `enum` constraints (bool-safe equality)
        if "const" in schema and not _json_equals(current, schema["const"]):
            issues.append(
                {
                    "path": path,
                    "code": "CONST_MISMATCH",
                    "message": f"Value at {path} must equal constant {schema['const']!r}",
                }
            )

        if "enum" in schema:
            enum_values = schema["enum"]
            if not isinstance(enum_values, Sequence) or isinstance(enum_values, (str, bytes)):
                raise _SchemaBailoutError("INVALID_SCHEMA", f"enum at {path} must be a list", path)
            if not any(_json_equals(current, allowed) for allowed in enum_values):
                issues.append(
                    {
                        "path": path,
                        "code": "ENUM_MISMATCH",
                        "message": f"Value at {path} is not one of allowed enum values",
                    }
                )

        # 4. String constraints
        if isinstance(current, str):
            min_len = schema.get("minLength")
            if _is_valid_json_int(min_len) and len(current) < min_len:
                issues.append(
                    {
                        "path": path,
                        "code": "MIN_LENGTH",
                        "message": f"String at {path} length ({len(current)}) is less than minLength ({min_len})",
                    }
                )
            max_len = schema.get("maxLength")
            if _is_valid_json_int(max_len) and len(current) > max_len:
                issues.append(
                    {
                        "path": path,
                        "code": "MAX_LENGTH",
                        "message": f"String at {path} length ({len(current)}) exceeds maxLength ({max_len})",
                    }
                )
            fmt = schema.get("format")
            if isinstance(fmt, str) and fmt and not _check_format(fmt, current):
                issues.append(
                    {
                        "path": path,
                        "code": "INVALID_FORMAT",
                        "message": f"String at {path} failed '{fmt}' format validation",
                    }
                )

        # 5. Numeric constraints
        if _is_valid_json_number(current):
            minimum = schema.get("minimum")
            if _is_valid_json_number(minimum) and current < minimum:
                issues.append(
                    {
                        "path": path,
                        "code": "MINIMUM",
                        "message": f"Number at {path} ({current}) is less than minimum ({minimum})",
                    }
                )
            maximum = schema.get("maximum")
            if _is_valid_json_number(maximum) and current > maximum:
                issues.append(
                    {
                        "path": path,
                        "code": "MAXIMUM",
                        "message": f"Number at {path} ({current}) exceeds maximum ({maximum})",
                    }
                )
            excl_min = schema.get("exclusiveMinimum")
            if _is_valid_json_number(excl_min) and current <= excl_min:
                issues.append(
                    {
                        "path": path,
                        "code": "EXCLUSIVE_MINIMUM",
                        "message": f"Number at {path} ({current}) must be greater than {excl_min}",
                    }
                )
            excl_max = schema.get("exclusiveMaximum")
            if _is_valid_json_number(excl_max) and current >= excl_max:
                issues.append(
                    {
                        "path": path,
                        "code": "EXCLUSIVE_MAXIMUM",
                        "message": f"Number at {path} ({current}) must be less than {excl_max}",
                    }
                )

        # 6. Array constraints
        if isinstance(current, list):
            min_items = schema.get("minItems")
            if _is_valid_json_int(min_items) and len(current) < min_items:
                issues.append(
                    {
                        "path": path,
                        "code": "MIN_ITEMS",
                        "message": f"Array at {path} length ({len(current)}) is less than minItems ({min_items})",
                    }
                )
            max_items = schema.get("maxItems")
            if _is_valid_json_int(max_items) and len(current) > max_items:
                issues.append(
                    {
                        "path": path,
                        "code": "MAX_ITEMS",
                        "message": f"Array at {path} length ({len(current)}) exceeds maxItems ({max_items})",
                    }
                )

            item_schema = schema.get("items")
            out_items: list[Any] = []
            if isinstance(item_schema, Mapping):
                for idx, item in enumerate(current):
                    out_items.append(
                        _validate_node(
                            item_schema,
                            item,
                            path=f"{path}[{idx}]",
                            depth=depth + 1,
                            max_depth=max_depth,
                            coerce=coerce,
                            strip_unknown=strip_unknown,
                            active_payload_ids=active_payload_ids,
                            active_schema_ids=active_schema_ids,
                            issues=issues,
                        )
                    )
            else:
                for idx, item in enumerate(current):
                    out_items.append(
                        _sanitize_untyped_value(
                            item,
                            f"{path}[{idx}]",
                            depth + 1,
                            max_depth,
                            active_payload_ids,
                        )
                    )

            if schema.get("uniqueItems") is True:
                seen_items: list[Any] = []
                for idx, item in enumerate(out_items):
                    if any(_json_equals(item, prev) for prev in seen_items):
                        issues.append(
                            {
                                "path": f"{path}[{idx}]",
                                "code": "UNIQUE_ITEMS",
                                "message": f"Duplicate array item at {path}[{idx}] violates uniqueItems",
                            }
                        )
                        break
                    seen_items.append(item)

            return out_items

        # 7. Object constraints & prototype-key sanitization
        if isinstance(current, Mapping):
            clean_in: dict[str, Any] = {}
            for raw_k, raw_v in current.items():
                if not isinstance(raw_k, str):
                    if coerce:
                        key_str = str(raw_k)
                    else:
                        issues.append(
                            {
                                "path": path,
                                "code": "INVALID_KEY",
                                "message": f"Object key {raw_k!r} at {path} must be a string",
                            }
                        )
                        continue
                else:
                    key_str = raw_k

                if key_str in _FORBIDDEN_OBJECT_KEYS:
                    continue
                clean_in[key_str] = raw_v

            min_props = schema.get("minProperties")
            if _is_valid_json_int(min_props) and len(clean_in) < min_props:
                issues.append(
                    {
                        "path": path,
                        "code": "MIN_PROPERTIES",
                        "message": f"Object at {path} property count ({len(clean_in)}) is less than minProperties ({min_props})",
                    }
                )
            max_props = schema.get("maxProperties")
            if _is_valid_json_int(max_props) and len(clean_in) > max_props:
                issues.append(
                    {
                        "path": path,
                        "code": "MAX_PROPERTIES",
                        "message": f"Object at {path} property count ({len(clean_in)}) exceeds maxProperties ({max_props})",
                    }
                )

            has_properties = isinstance(schema.get("properties"), Mapping)
            properties: Mapping[str, Any] = schema["properties"] if has_properties else {}

            # Populate missing property defaults before checking `required`
            for prop_name, prop_schema in properties.items():
                if prop_name in _FORBIDDEN_OBJECT_KEYS:
                    continue
                if prop_name not in clean_in and isinstance(prop_schema, Mapping) and "default" in prop_schema:
                    clean_in[prop_name] = copy.deepcopy(prop_schema["default"])

            required_keys = schema.get("required")
            if isinstance(required_keys, Sequence) and not isinstance(required_keys, (str, bytes)):
                for req_key in required_keys:
                    if isinstance(req_key, str) and req_key not in clean_in:
                        issues.append(
                            {
                                "path": f"{path}.{req_key}",
                                "code": "REQUIRED",
                                "message": f"Missing required property '{req_key}' at {path}",
                            }
                        )

            additional_props = schema.get("additionalProperties")
            out_obj: dict[str, Any] = {}

            for key, item_val in clean_in.items():
                prop_path = f"{path}.{key}"
                if key in properties:
                    prop_schema = properties[key]
                    if not isinstance(prop_schema, Mapping):
                        raise _SchemaBailoutError(
                            "INVALID_SCHEMA",
                            f"Property schema for '{key}' at {path} must be a dict",
                            prop_path,
                        )
                    out_obj[key] = _validate_node(
                        prop_schema,
                        item_val,
                        path=prop_path,
                        depth=depth + 1,
                        max_depth=max_depth,
                        coerce=coerce,
                        strip_unknown=strip_unknown,
                        active_payload_ids=active_payload_ids,
                        active_schema_ids=active_schema_ids,
                        issues=issues,
                    )
                elif additional_props is False:
                    issues.append(
                        {
                            "path": prop_path,
                            "code": "UNKNOWN_KEY",
                            "message": f"Unknown property '{key}' is not allowed at {path}",
                        }
                    )
                elif isinstance(additional_props, Mapping):
                    out_obj[key] = _validate_node(
                        additional_props,
                        item_val,
                        path=prop_path,
                        depth=depth + 1,
                        max_depth=max_depth,
                        coerce=coerce,
                        strip_unknown=strip_unknown,
                        active_payload_ids=active_payload_ids,
                        active_schema_ids=active_schema_ids,
                        issues=issues,
                    )
                elif additional_props is True or not (has_properties and strip_unknown):
                    out_obj[key] = _sanitize_untyped_value(
                        item_val,
                        prop_path,
                        depth + 1,
                        max_depth,
                        active_payload_ids,
                    )
                # Else (`has_properties and strip_unknown and additional_props is None`): strip undeclared key

            return out_obj

        if isinstance(current, float) and (math.isnan(current) or math.isinf(current)):
            issues.append(
                {
                    "path": path,
                    "code": "INVALID_TYPE",
                    "message": f"Number at {path} must be finite (not NaN or Infinity)",
                }
            )
            return current

        if isinstance(current, (tuple, set, frozenset)):
            if payload_id is not None:
                active_payload_ids.discard(payload_id)
                payload_id = None
            return _sanitize_untyped_value(
                current,
                path,
                depth,
                max_depth,
                active_payload_ids,
            )

        return current
    finally:
        active_schema_ids.discard(schema_id)
        if payload_id is not None:
            active_payload_ids.discard(payload_id)


_NON_NEG_INT_SCHEMA_KEYWORDS: frozenset[str] = frozenset(
    {"minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties"}
)
_FINITE_NUM_SCHEMA_KEYWORDS: frozenset[str] = frozenset(
    {"minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"}
)


def _validate_schema_keywords_recursive(
    schema: Any,
    *,
    path: str,
    active_schema_ids: set[int],
    depth: int,
    max_depth: int,
) -> None:
    if depth > max(64, max_depth):
        raise _SchemaBailoutError(
            "SCHEMA_MAX_DEPTH",
            f"Schema definition exceeded maximum recursion depth at {path}",
            path,
        )

    if not isinstance(schema, Mapping):
        raise _SchemaBailoutError(
            "INVALID_SCHEMA",
            f"Schema at {path} must be a JSON Schema dictionary",
            path,
        )

    schema_id = id(schema)
    if schema_id in active_schema_ids:
        raise _SchemaBailoutError(
            "SCHEMA_CIRCULAR_REF",
            f"Circular reference detected in schema definition at {path}",
            path,
        )

    active_schema_ids.add(schema_id)
    try:
        for own_key, own_val in schema.items():
            if not isinstance(own_key, str):
                raise _SchemaBailoutError(
                    "INVALID_SCHEMA",
                    f"Schema keyword at {path} must be a string",
                    path,
                )
            if own_key in _FORBIDDEN_OBJECT_KEYS:
                continue
            if callable(own_val) or (
                own_val is not None
                and not isinstance(own_val, (str, bytes, int, float, bool, Mapping, Sequence))
                and (
                    callable(getattr(own_val, "model_validate", None))
                    or callable(getattr(own_val, "parse_obj", None))
                )
            ):
                raise _SchemaBailoutError(
                    "INVALID_SCHEMA",
                    f"Schema property '{own_key}' at {path} contains uncompiled callable/model object",
                    f"{path}.{own_key}",
                )

        if "type" in schema:
            raw_type = schema["type"]
            if isinstance(raw_type, str):
                type_list = [raw_type]
            elif (
                isinstance(raw_type, Sequence)
                and not isinstance(raw_type, (str, bytes, bytearray))
                and len(raw_type) > 0
                and all(isinstance(t, str) for t in raw_type)
            ):
                type_list = list(raw_type)
            else:
                raise _SchemaBailoutError(
                    "INVALID_SCHEMA",
                    f"Invalid 'type' specification at {path}",
                    path,
                )
            for expected in type_list:
                if expected not in _VALID_JSON_TYPES:
                    raise _SchemaBailoutError(
                        "INVALID_SCHEMA",
                        f"Unsupported JSON Schema type '{expected}' at {path}",
                        path,
                    )

        for combinator in ("anyOf", "oneOf"):
            if combinator in schema:
                branches = schema[combinator]
                if (
                    not isinstance(branches, Sequence)
                    or isinstance(branches, (str, bytes, bytearray))
                    or len(branches) == 0
                ):
                    raise _SchemaBailoutError(
                        "INVALID_SCHEMA",
                        f"{combinator} at {path} must be a non-empty list of schema mappings",
                        path,
                    )
                for idx, branch in enumerate(branches):
                    _validate_schema_keywords_recursive(
                        branch,
                        path=f"{path}.{combinator}[{idx}]",
                        active_schema_ids=active_schema_ids,
                        depth=depth + 1,
                        max_depth=max_depth,
                    )

        if "enum" in schema:
            enum_values = schema["enum"]
            if not isinstance(enum_values, Sequence) or isinstance(enum_values, (str, bytes, bytearray)):
                raise _SchemaBailoutError("INVALID_SCHEMA", f"enum at {path} must be a list", path)

        if "properties" in schema:
            props = schema["properties"]
            if not isinstance(props, Mapping):
                raise _SchemaBailoutError(
                    "INVALID_SCHEMA",
                    f"properties at {path} must be a dictionary",
                    path,
                )
            for prop_key, prop_schema in props.items():
                if not isinstance(prop_key, str):
                    raise _SchemaBailoutError(
                        "INVALID_SCHEMA",
                        f"Property name at {path} must be a string",
                        path,
                    )
                if prop_key in _FORBIDDEN_OBJECT_KEYS:
                    continue
                _validate_schema_keywords_recursive(
                    prop_schema,
                    path=f"{path}.{prop_key}",
                    active_schema_ids=active_schema_ids,
                    depth=depth + 1,
                    max_depth=max_depth,
                )

        if "required" in schema:
            req = schema["required"]
            if (
                not isinstance(req, Sequence)
                or isinstance(req, (str, bytes, bytearray))
                or not all(isinstance(k, str) for k in req)
            ):
                raise _SchemaBailoutError(
                    "INVALID_SCHEMA",
                    f"required at {path} must be a list of property name strings",
                    path,
                )

        if "items" in schema:
            items_schema = schema["items"]
            if not isinstance(items_schema, Mapping):
                raise _SchemaBailoutError(
                    "INVALID_SCHEMA",
                    f"items at {path} must be a schema dictionary",
                    path,
                )
            _validate_schema_keywords_recursive(
                items_schema,
                path=f"{path}.items",
                active_schema_ids=active_schema_ids,
                depth=depth + 1,
                max_depth=max_depth,
            )

        if "additionalProperties" in schema:
            add_props = schema["additionalProperties"]
            if not isinstance(add_props, bool):
                if not isinstance(add_props, Mapping):
                    raise _SchemaBailoutError(
                        "INVALID_SCHEMA",
                        f"additionalProperties at {path} must be a boolean or schema dictionary",
                        path,
                    )
                _validate_schema_keywords_recursive(
                    add_props,
                    path=f"{path}.additionalProperties",
                    active_schema_ids=active_schema_ids,
                    depth=depth + 1,
                    max_depth=max_depth,
                )

        for num_kw in _FINITE_NUM_SCHEMA_KEYWORDS:
            if num_kw in schema and not _is_valid_json_number(schema[num_kw]):
                raise _SchemaBailoutError(
                    "INVALID_SCHEMA",
                    f"{num_kw} at {path} must be a finite number",
                    path,
                )

        for int_kw in _NON_NEG_INT_SCHEMA_KEYWORDS:
            if int_kw in schema and (not _is_valid_json_int(schema[int_kw]) or schema[int_kw] < 0):
                raise _SchemaBailoutError(
                    "INVALID_SCHEMA",
                    f"{int_kw} at {path} must be a non-negative integer",
                    path,
                )

        if "uniqueItems" in schema and not isinstance(schema["uniqueItems"], bool):
            raise _SchemaBailoutError(
                "INVALID_SCHEMA",
                f"uniqueItems at {path} must be a boolean",
                path,
            )

        if "format" in schema and not isinstance(schema["format"], str):
            raise _SchemaBailoutError(
                "INVALID_SCHEMA",
                f"format at {path} must be a string",
                path,
            )
    finally:
        active_schema_ids.discard(schema_id)


def validate_json_schema(
    schema: dict[str, Any],
    payload: Any,
    *,
    coerce: bool = False,
    strip_unknown: bool = True,
    max_depth: int = 16,
    tool: str = "schema.validate",
) -> dict[str, Any]:
    """
    Validate an untrusted payload against a JSON Schema dict (`INV-LEGO-01`, `INV-LEGO-20`).

    Never raises on untrusted payloads. Rejects `bool` for `integer`/`number` and `NaN`/`Infinity`,
    guards against circular references (`SCHEMA_CIRCULAR_REF`) and excessive nesting (`SCHEMA_MAX_DEPTH`),
    and strips prototype-pollution keys (`__proto__`, `constructor`, `prototype`).
    """
    safe_tool = tool.strip() if isinstance(tool, str) and tool.strip() else "schema.validate"

    if not isinstance(schema, Mapping):
        return error_envelope(
            "INVALID_SCHEMA",
            "Schema must be a JSON Schema dictionary",
            {"issues": [{"path": "$", "code": "INVALID_SCHEMA", "message": "Schema must be a dict"}]},
            safe_tool,
        )

    if not _is_valid_json_int(max_depth) or max_depth < 1:
        return error_envelope(
            "INVALID_SCHEMA",
            "max_depth must be an integer >= 1",
            {"issues": [{"path": "$", "code": "INVALID_SCHEMA", "message": "max_depth must be >= 1"}]},
            safe_tool,
        )

    issues: list[dict[str, Any]] = []
    try:
        _validate_schema_keywords_recursive(
            schema,
            path="$",
            active_schema_ids=set(),
            depth=0,
            max_depth=max_depth,
        )
        validated = _validate_node(
            schema,
            payload,
            path="$",
            depth=0,
            max_depth=max_depth,
            coerce=bool(coerce),
            strip_unknown=bool(strip_unknown),
            active_payload_ids=set(),
            active_schema_ids=set(),
            issues=issues,
        )
    except _SchemaBailoutError as bail:
        return error_envelope(
            bail.code,
            bail.message,
            {"issues": [{"path": bail.path, "code": bail.code, "message": bail.message}]},
            safe_tool,
        )
    except Exception as exc:  # pragma: no cover - defensive fail-closed guard
        return error_envelope(
            "VALIDATION_ERROR",
            str(exc) or "Schema validation failed",
            {"issues": [{"path": "$", "code": "VALIDATION_ERROR", "message": str(exc)}]},
            safe_tool,
        )

    if issues:
        first_msg = issues[0].get("message") or "Schema validation failed"
        summary = first_msg if len(issues) == 1 else f"{first_msg} (+{len(issues) - 1} more issues)"
        return error_envelope("VALIDATION_ERROR", summary, {"issues": issues}, safe_tool)

    return ok_envelope(safe_tool, "Schema validation passed", validated)


def _extract_model_issues(exc: BaseException) -> list[dict[str, Any]]:
    errors_fn = getattr(exc, "errors", None)
    if callable(errors_fn):
        try:
            raw_errors = errors_fn()
            if isinstance(raw_errors, Sequence):
                formatted: list[dict[str, Any]] = []
                for item in raw_errors:
                    if isinstance(item, Mapping):
                        loc = item.get("loc", ())
                        loc_parts = [str(part) for part in loc] if isinstance(loc, Sequence) else [str(loc)]
                        path = "$." + ".".join(loc_parts) if loc_parts else "$"
                        formatted.append(
                            {
                                "path": path,
                                "code": str(item.get("type") or "MODEL_ERROR"),
                                "message": str(item.get("msg") or exc),
                            }
                        )
                if formatted:
                    return formatted
        except Exception:
            pass
    return [{"path": "$", "code": "MODEL_VALIDATION_ERROR", "message": str(exc) or "Model validation failed"}]


def _dump_model_instance(instance: Any, max_depth: int) -> Any:
    model_dump_fn = getattr(instance, "model_dump", None)
    if callable(model_dump_fn):
        dumped = model_dump_fn()
    else:
        dict_fn = getattr(instance, "dict", None)
        dumped = dict_fn() if callable(dict_fn) else instance
    return _sanitize_untyped_value(dumped, "$", 0, max_depth, set())


def _resolve_local_json_ref(
    node: Mapping[str, Any],
    root_schema: Mapping[str, Any],
    seen_refs: set[str],
) -> Mapping[str, Any]:
    ref = node.get("$ref")
    while isinstance(ref, str) and ref.startswith("#/"):
        if ref in seen_refs:
            break
        seen_refs.add(ref)
        parts = ref[2:].split("/")
        cur: Any = root_schema
        for part in parts:
            if isinstance(cur, Mapping) and part in cur:
                cur = cur[part]
            else:
                cur = None
                break
        if not isinstance(cur, Mapping):
            break
        node = cur
        ref = node.get("$ref")
    return node


def _schema_node_allows_boolean(
    node: Mapping[str, Any],
    root_schema: Mapping[str, Any],
    seen_refs: set[str] | None = None,
) -> bool:
    resolved = _resolve_local_json_ref(node, root_schema, set(seen_refs or ()))
    raw_type = resolved.get("type")
    if raw_type == "boolean":
        return True
    if isinstance(raw_type, Sequence) and not isinstance(raw_type, str) and "boolean" in raw_type:
        return True
    for union_key in ("anyOf", "oneOf"):
        branches = resolved.get(union_key)
        if isinstance(branches, Sequence) and not isinstance(branches, (str, bytes)):
            for branch in branches:
                if isinstance(branch, Mapping) and _schema_node_allows_boolean(
                    branch, root_schema, set(seen_refs or ())
                ):
                    return True
    return False


def _schema_node_expects_numeric(
    node: Mapping[str, Any],
    root_schema: Mapping[str, Any],
    seen_refs: set[str] | None = None,
) -> bool:
    resolved = _resolve_local_json_ref(node, root_schema, set(seen_refs or ()))
    raw_type = resolved.get("type")
    if raw_type in ("integer", "number"):
        return True
    if (
        isinstance(raw_type, Sequence)
        and not isinstance(raw_type, str)
        and any(t in ("integer", "number") for t in raw_type)
    ):
        return True
    for union_key in ("anyOf", "oneOf"):
        branches = resolved.get(union_key)
        if isinstance(branches, Sequence) and not isinstance(branches, (str, bytes)):
            for branch in branches:
                if isinstance(branch, Mapping) and _schema_node_expects_numeric(
                    branch, root_schema, set(seen_refs or ())
                ):
                    return True
    return False


def _walk_model_bool_numeric_guard(
    node: Mapping[str, Any],
    val: Any,
    root_schema: Mapping[str, Any],
    path: str,
    depth: int,
    max_depth: int,
) -> None:
    if depth > max_depth:
        return
    resolved = _resolve_local_json_ref(node, root_schema, set())

    if isinstance(val, bool):
        if not _schema_node_allows_boolean(resolved, root_schema) and _schema_node_expects_numeric(
            resolved, root_schema
        ):
            raise _SchemaBailoutError(
                "VALIDATION_ERROR",
                f"Boolean is not valid for numeric field at {path}",
                path,
            )
        return

    if isinstance(val, Mapping):
        props = resolved.get("properties")
        addl = resolved.get("additionalProperties")
        if isinstance(props, Mapping):
            for key, item in val.items():
                if key in props and isinstance(props[key], Mapping):
                    _walk_model_bool_numeric_guard(
                        props[key], item, root_schema, f"{path}.{key}", depth + 1, max_depth
                    )
                elif isinstance(addl, Mapping):
                    _walk_model_bool_numeric_guard(
                        addl, item, root_schema, f"{path}.{key}", depth + 1, max_depth
                    )
        elif isinstance(addl, Mapping):
            for key, item in val.items():
                _walk_model_bool_numeric_guard(
                    addl, item, root_schema, f"{path}.{key}", depth + 1, max_depth
                )
        for union_key in ("anyOf", "oneOf"):
            branches = resolved.get(union_key)
            if isinstance(branches, Sequence) and not isinstance(branches, (str, bytes)):
                obj_branches = [
                    _resolve_local_json_ref(b, root_schema, set())
                    for b in branches
                    if isinstance(b, Mapping)
                ]
                obj_branches = [
                    b
                    for b in obj_branches
                    if isinstance(b.get("properties"), Mapping)
                    or isinstance(b.get("additionalProperties"), Mapping)
                ]
                if len(obj_branches) == 1:
                    _walk_model_bool_numeric_guard(
                        obj_branches[0], val, root_schema, path, depth + 1, max_depth
                    )
        return

    if isinstance(val, (list, tuple)):
        prefix_items = resolved.get("prefixItems")
        items_schema = resolved.get("items")
        if isinstance(prefix_items, Sequence) and not isinstance(prefix_items, (str, bytes)):
            for idx, item in enumerate(val):
                if idx < len(prefix_items) and isinstance(prefix_items[idx], Mapping):
                    _walk_model_bool_numeric_guard(
                        prefix_items[idx], item, root_schema, f"{path}[{idx}]", depth + 1, max_depth
                    )
                elif isinstance(items_schema, Mapping):
                    _walk_model_bool_numeric_guard(
                        items_schema, item, root_schema, f"{path}[{idx}]", depth + 1, max_depth
                    )
        elif isinstance(items_schema, Mapping):
            for idx, item in enumerate(val):
                _walk_model_bool_numeric_guard(
                    items_schema, item, root_schema, f"{path}[{idx}]", depth + 1, max_depth
                )
        for union_key in ("anyOf", "oneOf"):
            branches = resolved.get(union_key)
            if isinstance(branches, Sequence) and not isinstance(branches, (str, bytes)):
                arr_branches = [
                    _resolve_local_json_ref(b, root_schema, set())
                    for b in branches
                    if isinstance(b, Mapping)
                ]
                arr_branches = [
                    b
                    for b in arr_branches
                    if isinstance(b.get("items"), Mapping)
                    or isinstance(b.get("prefixItems"), Sequence)
                ]
                if len(arr_branches) == 1:
                    _walk_model_bool_numeric_guard(
                        arr_branches[0], val, root_schema, path, depth + 1, max_depth
                    )


def _is_non_string_sequence(val: Any) -> bool:
    return isinstance(val, Sequence) and not isinstance(val, (str, bytes, bytearray))


def _iter_matching_alias_inputs(
    raw_map: Mapping[str, Any],
    candidate: Any,
    base_path: str,
) -> list[tuple[Any, str]]:
    """Resolve matching `(raw_subvalue, sub_path)` entries for a string alias, `AliasPath`, or `AliasChoices`."""
    if candidate is None:
        return []
    if isinstance(candidate, str):
        if candidate in raw_map:
            return [(raw_map[candidate], f"{base_path}.{candidate}")]
        return []
    steps = getattr(candidate, "path", None)
    if _is_non_string_sequence(steps) and len(steps) > 0:
        cur: Any = raw_map
        cur_path = base_path
        for step in steps:
            if isinstance(step, str) and isinstance(cur, Mapping) and step in cur:
                cur = cur[step]
                cur_path = f"{cur_path}.{step}"
            elif (
                not isinstance(step, bool)
                and isinstance(step, int)
                and _is_non_string_sequence(cur)
                and 0 <= step < len(cur)
            ):
                cur = cur[step]
                cur_path = f"{cur_path}[{step}]"
            else:
                return []
        return [(cur, cur_path)]
    choices = getattr(candidate, "choices", None)
    if _is_non_string_sequence(choices):
        matches: list[tuple[Any, str]] = []
        for choice in choices:
            matches.extend(_iter_matching_alias_inputs(raw_map, choice, base_path))
        return matches
    return []


def _reject_coerced_booleans(
    raw_val: Any,
    target_val: Any,
    path: str = "$",
    depth: int = 0,
    max_depth: int = 16,
) -> None:
    """Reject any input `bool` that was coerced into a non-bool numeric value across models, aliases, or containers."""
    if depth > max_depth:
        return

    # Unwrap Pydantic v2 RootModel / v1 __root__ wrappers when raw_val is the unwrapped root payload
    target_cls = type(target_val)
    v2_fields = getattr(target_cls, "model_fields", None)
    if (
        isinstance(v2_fields, Mapping)
        and set(v2_fields.keys()) == {"root"}
        and hasattr(target_val, "root")
        and not (isinstance(raw_val, Mapping) and "root" in raw_val)
    ):
        target_val = target_val.root
        target_cls = type(target_val)
        v2_fields = getattr(target_cls, "model_fields", None)

    if isinstance(raw_val, bool):
        if not isinstance(target_val, bool) and (
            isinstance(target_val, (int, float)) or type(target_val).__name__ == "Decimal"
        ):
            raise _SchemaBailoutError(
                "VALIDATION_ERROR",
                f"Boolean is not valid for numeric field at {path}",
                path,
            )
        return

    # Inspect live Pydantic v2 (`model_fields`) or v1 (`__fields__`) model instances including aliases
    model_fields = v2_fields if isinstance(v2_fields, Mapping) else getattr(target_cls, "__fields__", None)
    if isinstance(raw_val, Mapping) and isinstance(model_fields, Mapping) and not isinstance(target_val, Mapping):
        for field_name, field_info in model_fields.items():
            if not hasattr(target_val, field_name):
                continue
            field_val = getattr(target_val, field_name)
            seen_paths: set[str] = set()
            for candidate in (
                getattr(field_info, "validation_alias", None),
                getattr(field_info, "alias", None),
                field_name,
            ):
                for matched_raw, matched_path in _iter_matching_alias_inputs(raw_val, candidate, path):
                    if matched_path in seen_paths:
                        continue
                    seen_paths.add(matched_path)
                    _reject_coerced_booleans(
                        matched_raw,
                        field_val,
                        matched_path,
                        depth + 1,
                        max_depth,
                    )
        model_extra = getattr(target_val, "model_extra", None)
        if isinstance(model_extra, Mapping):
            for extra_key, extra_val in model_extra.items():
                if extra_key in raw_val:
                    _reject_coerced_booleans(
                        raw_val[extra_key],
                        extra_val,
                        f"{path}.{extra_key}",
                        depth + 1,
                        max_depth,
                    )
        return

    if isinstance(raw_val, Mapping) and isinstance(target_val, Mapping):
        for key, raw_item in raw_val.items():
            if key in target_val:
                _reject_coerced_booleans(
                    raw_item, target_val[key], f"{path}.{key}", depth + 1, max_depth
                )
        return

    raw_is_set = isinstance(raw_val, (set, frozenset))
    target_is_set = isinstance(target_val, (set, frozenset))
    raw_is_seq = _is_non_string_sequence(raw_val)
    target_is_seq = _is_non_string_sequence(target_val)

    if (raw_is_set and (target_is_set or target_is_seq)) or (
        target_is_set and (raw_is_set or raw_is_seq)
    ):
        raw_bool_count = sum(1 for x in raw_val if isinstance(x, bool))
        if raw_bool_count > 0:
            out_bool_count = sum(1 for y in target_val if isinstance(y, bool))
            out_num_count = sum(
                1
                for y in target_val
                if not isinstance(y, bool)
                and (isinstance(y, (int, float)) or type(y).__name__ == "Decimal")
            )
            if out_bool_count < raw_bool_count and out_num_count > 0:
                raise _SchemaBailoutError(
                    "VALIDATION_ERROR",
                    f"Boolean is not valid for numeric element at {path}",
                    path,
                )
        return

    if raw_is_seq and target_is_seq:
        for idx in range(min(len(raw_val), len(target_val))):
            _reject_coerced_booleans(
                raw_val[idx], target_val[idx], f"{path}[{idx}]", depth + 1, max_depth
            )
        return


def _guard_model_bool_numeric_coercion(
    schema_or_model: Any,
    sanitized_input: Any,
    max_depth: int,
) -> None:
    schema_fn = getattr(schema_or_model, "model_json_schema", None) or getattr(
        schema_or_model, "schema", None
    )
    if not callable(schema_fn):
        return
    try:
        model_schema = schema_fn()
    except Exception:
        return
    if isinstance(model_schema, Mapping):
        _walk_model_bool_numeric_guard(
            model_schema, sanitized_input, model_schema, "$", 0, max_depth
        )


def _invoke_model_validator(
    model_validate_fn: Any,
    parse_obj_fn: Any,
    sanitized_input: Any,
    *,
    coerce: bool,
) -> Any:
    if callable(model_validate_fn):
        if not coerce:
            supports_strict = False
            try:
                sig = inspect.signature(model_validate_fn)
                params = sig.parameters
                supports_strict = "strict" in params or any(
                    p.kind == inspect.Parameter.VAR_KEYWORD for p in params.values()
                )
            except (TypeError, ValueError):
                supports_strict = False
            if supports_strict:
                return model_validate_fn(sanitized_input, strict=True)
        return model_validate_fn(sanitized_input)
    return parse_obj_fn(sanitized_input)


def validate_payload(
    schema_or_model: Any,
    payload: Any,
    *,
    coerce: bool = False,
    strip_unknown: bool = True,
    max_depth: int = 16,
    tool: str = "schema.validate",
) -> dict[str, Any]:
    """
    Validate a payload against a JSON Schema dict, Pydantic v2 model (`model_validate`),
    or Pydantic v1 model (`parse_obj`), returning an `INV-LEGO-01` envelope without raising.
    """
    safe_tool = tool.strip() if isinstance(tool, str) and tool.strip() else "schema.validate"

    if isinstance(schema_or_model, Mapping):
        try:
            schema_dict = dict(schema_or_model)
        except Exception as exc:
            msg = str(exc) or "Invalid JSON Schema mapping"
            return error_envelope(
                "INVALID_SCHEMA",
                msg,
                {"issues": [{"path": "$", "code": "INVALID_SCHEMA", "message": msg}]},
                safe_tool,
            )
        return validate_json_schema(
            schema_dict,
            payload,
            coerce=coerce,
            strip_unknown=strip_unknown,
            max_depth=max_depth,
            tool=safe_tool,
        )

    if not _is_valid_json_int(max_depth) or max_depth < 1:
        return error_envelope(
            "INVALID_SCHEMA",
            "max_depth must be an integer >= 1",
            {"issues": [{"path": "$", "code": "INVALID_SCHEMA", "message": "max_depth must be >= 1"}]},
            safe_tool,
        )

    try:
        model_validate_fn = getattr(schema_or_model, "model_validate", None)
        parse_obj_fn = getattr(schema_or_model, "parse_obj", None)
    except Exception as exc:
        msg = str(exc) or "Unsupported schema_or_model"
        return error_envelope(
            "INVALID_SCHEMA",
            msg,
            {"issues": [{"path": "$", "code": "INVALID_SCHEMA", "message": msg}]},
            safe_tool,
        )

    if not callable(model_validate_fn) and not callable(parse_obj_fn):
        return error_envelope(
            "INVALID_SCHEMA",
            "Expected JSON Schema dict or model exposing model_validate / parse_obj",
            {"issues": [{"path": "$", "code": "INVALID_SCHEMA", "message": "Unsupported schema_or_model"}]},
            safe_tool,
        )

    try:
        sanitized_input = _sanitize_untyped_value(payload, "$", 0, max_depth, set())
        _guard_model_bool_numeric_coercion(schema_or_model, sanitized_input, max_depth)
    except _SchemaBailoutError as bail:
        return error_envelope(
            bail.code,
            bail.message,
            {"issues": [{"path": bail.path, "code": bail.code, "message": bail.message}]},
            safe_tool,
        )
    except Exception as exc:
        msg = str(exc) or "Payload validation failed"
        return error_envelope(
            "VALIDATION_ERROR",
            msg,
            {"issues": [{"path": "$", "code": "VALIDATION_ERROR", "message": msg}]},
            safe_tool,
        )

    try:
        instance = _invoke_model_validator(
            model_validate_fn,
            parse_obj_fn,
            sanitized_input,
            coerce=bool(coerce),
        )
        _reject_coerced_booleans(sanitized_input, instance, "$", 0, max_depth)
        dumped = _dump_model_instance(instance, max_depth)
        _reject_coerced_booleans(sanitized_input, dumped, "$", 0, max_depth)
        return ok_envelope(safe_tool, "Schema validation passed", dumped)
    except _SchemaBailoutError as bail:
        return error_envelope(
            bail.code,
            bail.message,
            {"issues": [{"path": bail.path, "code": bail.code, "message": bail.message}]},
            safe_tool,
        )
    except Exception as exc:
        issues = _extract_model_issues(exc)
        return error_envelope(
            "VALIDATION_ERROR",
            issues[0]["message"],
            {"issues": issues},
            safe_tool,
        )
