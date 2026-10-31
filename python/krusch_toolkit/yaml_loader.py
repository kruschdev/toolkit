"""
Safe YAML 1.2 Core Config & Authority-Pack Loader Lego Bricks (`INV-LEGO-01`, `INV-LEGO-23`).

Imports cleanly in bare Python 3.11+ stdlib without PyYAML installed. `yaml` is imported lazily
on demand (or injected via `yaml_module`), returning `YAML_UNAVAILABLE` when absent.

Security & Determinism Guarantees:
- Enforces YAML 1.2 Core Schema resolution (Norway-safe `NO`/`on`/`off` stay `str`; ISO dates
  `2026-01-01` stay `str`; sexagesimal `12:30` stays `str`).
- Forbids all explicit/arbitrary YAML tags (`!tag`, `!!python/...`, `!!binary`, `%TAG` directives)
  with `YAML_FORBIDDEN_TAG`.
- Rejects `.nan`/`.inf` non-finite floats (`YAML_NONFINITE_NUMBER`), prototype-pollution keys
  `__proto__`/`constructor`/`prototype` (`YAML_FORBIDDEN_KEY`), non-string keys (`YAML_INVALID_KEY`),
  and duplicate explicit mapping keys (`YAML_DUPLICATE_KEY`).
- Bounds payload bytes (`YAML_TOO_LARGE`), container nesting depth (`YAML_MAX_DEPTH`), AST node
  count (`YAML_MAX_NODES`), and alias count / cumulative expanded alias nodes (`YAML_ALIAS_BOMB`)
  BEFORE object graph construction, deep-cloning alias subtrees to prevent cross-branch mutation.
- Enforces `realpath` directory containment (`YAML_PATH_TRAVERSAL`), `O_NOFOLLOW` + `fstat` regular
  file checks (`S_ISREG`), bounded streaming reads, and SHA-256 provenance for YAML authority packs.
"""

from __future__ import annotations

import errno
import hashlib
import math
import os
import re
import stat
import types
import weakref
from collections.abc import Mapping, Sequence
from typing import Any

from krusch_toolkit.fastapi_app import error_envelope, ok_envelope
from krusch_toolkit.schema import validate_payload

__all__ = [
    "DEFAULT_YAML_LIMITS",
    "parse_safe_yaml",
    "dump_safe_yaml",
    "validate_yaml_config",
    "load_safe_yaml_pack",
]

DEFAULT_YAML_LIMITS: types.MappingProxyType[str, int] = types.MappingProxyType(
    {
        "max_bytes": 1_048_576,
        "max_depth": 32,
        "max_nodes": 10_000,
        "max_aliases": 64,
        "max_alias_expansion_nodes": 1_000,
    }
)

_FORBIDDEN_KEYS: frozenset[str] = frozenset({"__proto__", "constructor", "prototype"})
_DISALLOWED_RAW_CONTROLS_RE: re.Pattern[str] = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")

# YAML 1.2 Core Schema implicit scalar patterns (+ `<<` merge key)
_NULL_CORE_RE: re.Pattern[str] = re.compile(r"^(?:~|null|Null|NULL|)$")
_BOOL_CORE_RE: re.Pattern[str] = re.compile(r"^(?:true|True|TRUE|false|False|FALSE)$")
_INT_CORE_RE: re.Pattern[str] = re.compile(r"^(?:[-+]?[0-9]+|[-+]?0o[0-7]+|[-+]?0x[0-9a-fA-F]+)$")
_FLOAT_CORE_RE: re.Pattern[str] = re.compile(
    r"^(?:[-+]?(?:(?:\.[0-9]+|[0-9]+\.[0-9]*)(?:[eE][-+]?[0-9]+)?|[0-9]+[eE][-+]?[0-9]+)"
    r"|[-+]?\.(?:inf|Inf|INF)|[-+]?\.(?:nan|NaN|NAN))$"
)
_MERGE_KEY_RE: re.Pattern[str] = re.compile(r"^(?:<<)$")

_LOADER_CACHE: weakref.WeakKeyDictionary[types.ModuleType, type[Any]] = weakref.WeakKeyDictionary()
_READ_CHUNK_BYTES = 65_536


class _YamlSecurityError(Exception):
    """Internal control-flow exception carrying deterministic INV-LEGO-23 error codes."""

    def __init__(self, code: str, message: str, details: Any = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details


def _resolve_tool(tool: Any, default: str) -> str:
    if isinstance(tool, str) and tool.strip():
        return tool.strip()
    return default


def _is_strict_int(val: Any) -> bool:
    """Reject `bool` (`isinstance(True, int)` is True in Python) and non-integers."""
    return isinstance(val, int) and not isinstance(val, bool)


def _resolve_yaml_module(yaml_module: Any = None) -> Any:
    """Lazily import `yaml` (PyYAML), returning `None` cleanly when disabled or missing."""
    if yaml_module is False:
        return None
    if yaml_module is not None and yaml_module is not True:
        return yaml_module
    try:
        import yaml

        return yaml
    except ImportError:
        return None


def _validate_parse_limits(
    *,
    max_bytes: Any,
    max_depth: Any,
    max_nodes: Any,
    max_aliases: Any,
    max_alias_expansion_nodes: Any,
    tool: str,
) -> dict[str, Any] | None:
    if not _is_strict_int(max_bytes) or max_bytes < 1:
        return error_envelope("YAML_INVALID_OPTIONS", "max_bytes must be an integer >= 1", tool=tool)
    if not _is_strict_int(max_depth) or max_depth < 1:
        return error_envelope("YAML_INVALID_OPTIONS", "max_depth must be an integer >= 1", tool=tool)
    if not _is_strict_int(max_nodes) or max_nodes < 1:
        return error_envelope("YAML_INVALID_OPTIONS", "max_nodes must be an integer >= 1", tool=tool)
    if not _is_strict_int(max_aliases) or max_aliases < 0:
        return error_envelope("YAML_INVALID_OPTIONS", "max_aliases must be an integer >= 0", tool=tool)
    if not _is_strict_int(max_alias_expansion_nodes) or max_alias_expansion_nodes < 0:
        return error_envelope(
            "YAML_INVALID_OPTIONS",
            "max_alias_expansion_nodes must be an integer >= 0",
            tool=tool,
        )
    return None


def _coerce_source_bytes_and_text(
    source: Any,
    *,
    max_bytes: int,
    tool: str,
) -> tuple[bytes, str] | dict[str, Any]:
    """Validate source buffer/string, enforce `max_bytes` pre-parse, and decode strict UTF-8."""
    if isinstance(source, str):
        if len(source) > max_bytes:
            return error_envelope(
                "YAML_TOO_LARGE",
                f"YAML payload exceeds max_bytes ({max_bytes})",
                tool=tool,
            )
        try:
            raw_bytes = source.encode("utf-8")
        except UnicodeEncodeError:
            return error_envelope(
                "YAML_PARSE_ERROR",
                "YAML string contains invalid UTF-8 surrogates",
                tool=tool,
            )
        if len(raw_bytes) > max_bytes:
            return error_envelope(
                "YAML_TOO_LARGE",
                f"YAML payload exceeds max_bytes ({max_bytes})",
                tool=tool,
            )
        decoded_text = source
    elif isinstance(source, (bytes, bytearray, memoryview)):
        byte_len = source.nbytes if isinstance(source, memoryview) else len(source)
        if byte_len > max_bytes:
            return error_envelope(
                "YAML_TOO_LARGE",
                f"YAML payload exceeds max_bytes ({max_bytes})",
                tool=tool,
            )
        raw_bytes = source.tobytes() if isinstance(source, memoryview) else bytes(source)
        try:
            decoded_text = raw_bytes.decode("utf-8", errors="strict")
        except UnicodeDecodeError:
            return error_envelope(
                "YAML_PARSE_ERROR",
                "YAML payload is not valid UTF-8",
                tool=tool,
            )
    else:
        return error_envelope(
            "YAML_INVALID_INPUT",
            "YAML source must be str, bytes, bytearray, or memoryview",
            tool=tool,
        )

    if decoded_text.startswith("\ufeff"):
        decoded_text = decoded_text[1:]

    if _DISALLOWED_RAW_CONTROLS_RE.search(decoded_text):
        return error_envelope(
            "YAML_PARSE_ERROR",
            "YAML payload contains NUL byte or disallowed ASCII control characters",
            tool=tool,
        )

    return raw_bytes, decoded_text


def _build_core_implicit_resolvers() -> dict[str, list[tuple[str, re.Pattern[str]]]]:
    """Build fresh YAML 1.2 Core Schema implicit resolver lookup without mutating `SafeLoader`."""
    resolvers: dict[str, list[tuple[str, re.Pattern[str]]]] = {}

    def _register(tag: str, pattern: re.Pattern[str], first_chars: Sequence[str]) -> None:
        for ch in first_chars:
            resolvers.setdefault(ch, []).append((tag, pattern))

    _register("tag:yaml.org,2002:null", _NULL_CORE_RE, ["", "~", "n", "N"])
    _register("tag:yaml.org,2002:bool", _BOOL_CORE_RE, ["t", "T", "f", "F"])
    _register(
        "tag:yaml.org,2002:int",
        _INT_CORE_RE,
        ["-", "+", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9"],
    )
    _register(
        "tag:yaml.org,2002:float",
        _FLOAT_CORE_RE,
        ["-", "+", ".", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9"],
    )
    _register("tag:yaml.org,2002:merge", _MERGE_KEY_RE, ["<"])
    return resolvers


def _measure_node_tree(
    root_node: Any,
    yaml_mod: Any,
    node_cap: int,
) -> tuple[int, int]:
    """
    Iteratively measure `(subtree_node_count, subtree_container_height)` up to `node_cap + 1`.

    A scalar has `container_height = 0`; a flat sequence/mapping has `container_height = 1`;
    nested containers increment height by 1 per container level.
    """
    total_nodes = 0
    max_container_height = 0
    stack: list[tuple[Any, int]] = [(root_node, 0)]
    while stack:
        curr, parent_height = stack.pop()
        total_nodes += 1
        if isinstance(curr, yaml_mod.SequenceNode):
            curr_height = parent_height + 1
            if curr_height > max_container_height:
                max_container_height = curr_height
            if total_nodes > node_cap:
                return total_nodes, max_container_height
            for child in curr.value:
                stack.append((child, curr_height))
        elif isinstance(curr, yaml_mod.MappingNode):
            curr_height = parent_height + 1
            if curr_height > max_container_height:
                max_container_height = curr_height
            if total_nodes > node_cap:
                return total_nodes, max_container_height
            for k_node, v_node in curr.value:
                stack.append((k_node, curr_height))
                stack.append((v_node, curr_height))
        else:
            if total_nodes > node_cap:
                return total_nodes, max_container_height
    return total_nodes, max_container_height


def _clone_yaml_node(node: Any, yaml_mod: Any) -> Any:
    """Deep-clone an anchored `yaml.Node` subtree so aliases materialize independent copies."""
    if isinstance(node, yaml_mod.ScalarNode):
        return yaml_mod.ScalarNode(
            node.tag,
            node.value,
            node.start_mark,
            node.end_mark,
            style=node.style,
        )
    if isinstance(node, yaml_mod.SequenceNode):
        cloned_items = [_clone_yaml_node(item, yaml_mod) for item in node.value]
        return yaml_mod.SequenceNode(
            node.tag,
            cloned_items,
            node.start_mark,
            node.end_mark,
            flow_style=node.flow_style,
        )
    if isinstance(node, yaml_mod.MappingNode):
        cloned_pairs = [
            (_clone_yaml_node(k_node, yaml_mod), _clone_yaml_node(v_node, yaml_mod))
            for k_node, v_node in node.value
        ]
        return yaml_mod.MappingNode(
            node.tag,
            cloned_pairs,
            node.start_mark,
            node.end_mark,
            flow_style=node.flow_style,
        )
    raise _YamlSecurityError("YAML_PARSE_ERROR", f"Unsupported YAML AST node: {type(node).__name__}")


def _get_sovereign_loader_class(yaml_mod: Any) -> type[Any]:
    """Create (and cache per `yaml` module) the hardened `_SovereignSafeLoader` subclass."""
    is_module = isinstance(yaml_mod, types.ModuleType)
    if is_module and yaml_mod in _LOADER_CACHE:
        return _LOADER_CACHE[yaml_mod]

    base_safe_loader = yaml_mod.SafeLoader
    base_constructor = yaml_mod.constructor.BaseConstructor

    class _SovereignSafeLoader(base_safe_loader):  # type: ignore[misc, valid-type]
        yaml_implicit_resolvers = _build_core_implicit_resolvers()
        yaml_constructors: dict[Any, Any] = {}
        yaml_multi_constructors: dict[str, Any] = {}

        def __init__(
            self,
            stream: str,
            *,
            max_depth: int,
            max_nodes: int,
            max_aliases: int,
            max_alias_expansion_nodes: int,
        ) -> None:
            super().__init__(stream)
            self._max_depth = max_depth
            self._max_nodes = max_nodes
            self._max_aliases = max_aliases
            self._max_alias_expansion_nodes = max_alias_expansion_nodes
            self._container_depth = 0
            self._active_anchors: set[str] = set()
            self.node_count = 0
            self.alias_count = 0
            self.alias_expansion_nodes = 0

        def scan_directive(self) -> Any:
            start_mark = self.get_mark()
            self.forward()
            name = self.scan_directive_name(start_mark)
            if name == "TAG":
                raise _YamlSecurityError("YAML_FORBIDDEN_TAG", "YAML %TAG directives are forbidden")
            value = None
            if name == "YAML":
                value = self.scan_yaml_directive_value(start_mark)
                end_mark = self.get_mark()
            else:
                end_mark = self.get_mark()
                while self.peek() not in "\0\r\n\x85\u2028\u2029":
                    self.forward()
            self.scan_directive_ignored_line(start_mark)
            return yaml_mod.DirectiveToken(name, value, start_mark, end_mark)

        def compose_document(self) -> Any:
            doc_start = self.get_event()
            if getattr(doc_start, "tags", None):
                raise _YamlSecurityError("YAML_FORBIDDEN_TAG", "YAML %TAG directives are forbidden")
            self._container_depth = 0
            self._active_anchors.clear()
            node = self.compose_node(None, None)
            self.get_event()
            self.anchors = {}
            self._active_anchors.clear()
            return node

        def compose_node(self, parent: Any, index: Any) -> Any:
            if self.check_event(yaml_mod.AliasEvent):
                alias_event = self.get_event()
                anchor = alias_event.anchor
                self.alias_count += 1
                if self.alias_count > self._max_aliases:
                    raise _YamlSecurityError(
                        "YAML_ALIAS_BOMB",
                        f"YAML alias count exceeds max_aliases ({self._max_aliases})",
                    )
                if anchor in self._active_anchors:
                    raise _YamlSecurityError(
                        "YAML_ALIAS_BOMB",
                        f"Cyclic YAML alias is forbidden: *{anchor}",
                    )
                if anchor not in self.anchors:
                    raise _YamlSecurityError(
                        "YAML_PARSE_ERROR",
                        f"Undefined YAML alias: *{anchor}",
                    )
                target_node = self.anchors[anchor]
                remaining_expansion = self._max_alias_expansion_nodes - self.alias_expansion_nodes
                remaining_total = self._max_nodes - self.node_count
                cap = max(0, min(remaining_expansion, remaining_total))
                subtree_nodes, subtree_height = _measure_node_tree(target_node, yaml_mod, cap)
                if self.alias_expansion_nodes + subtree_nodes > self._max_alias_expansion_nodes:
                    raise _YamlSecurityError(
                        "YAML_ALIAS_BOMB",
                        "YAML alias expansion exceeds max_alias_expansion_nodes "
                        f"({self._max_alias_expansion_nodes})",
                    )
                if self.node_count + subtree_nodes > self._max_nodes:
                    raise _YamlSecurityError(
                        "YAML_ALIAS_BOMB",
                        f"YAML alias expansion exceeds max_nodes ({self._max_nodes})",
                    )
                if self._container_depth + subtree_height > self._max_depth:
                    raise _YamlSecurityError(
                        "YAML_MAX_DEPTH",
                        f"YAML nesting depth exceeds max_depth ({self._max_depth})",
                    )
                self.alias_expansion_nodes += subtree_nodes
                self.node_count += subtree_nodes
                return _clone_yaml_node(target_node, yaml_mod)

            peeked = self.peek_event()
            if getattr(peeked, "tag", None) is not None:
                raise _YamlSecurityError(
                    "YAML_FORBIDDEN_TAG",
                    f"Explicit YAML tag is forbidden: {peeked.tag}",
                )

            anchor = peeked.anchor
            if anchor is not None and anchor in self.anchors and anchor in self._active_anchors:
                # YAML 1.2 permits redefining closed anchors later in a document,
                # but redefining an active ancestor anchor creates a cycle.
                raise _YamlSecurityError(
                    "YAML_ALIAS_BOMB",
                    f"Cyclic YAML anchor redefinition is forbidden: &{anchor}",
                )

            self.node_count += 1
            if self.node_count > self._max_nodes:
                raise _YamlSecurityError(
                    "YAML_MAX_NODES",
                    f"YAML AST node count exceeds max_nodes ({self._max_nodes})",
                )

            self.descend_resolver(parent, index)
            try:
                if self.check_event(yaml_mod.ScalarEvent):
                    if self._container_depth > self._max_depth:
                        raise _YamlSecurityError(
                            "YAML_MAX_DEPTH",
                            f"YAML nesting depth exceeds max_depth ({self._max_depth})",
                        )
                    return self.compose_scalar_node(anchor)
                if self.check_event(yaml_mod.SequenceStartEvent):
                    return self.compose_sequence_node(anchor)
                if self.check_event(yaml_mod.MappingStartEvent):
                    return self.compose_mapping_node(anchor)
                raise _YamlSecurityError("YAML_PARSE_ERROR", "Unexpected YAML parser event")
            finally:
                self.ascend_resolver()

        def compose_scalar_node(self, anchor: str | None) -> Any:
            event = self.get_event()
            if event.tag is not None:
                raise _YamlSecurityError(
                    "YAML_FORBIDDEN_TAG",
                    f"Explicit YAML tag is forbidden: {event.tag}",
                )
            scalar_value = event.value
            if isinstance(scalar_value, str):
                try:
                    scalar_value = scalar_value.encode("utf-16-le", "surrogatepass").decode("utf-16-le")
                except UnicodeDecodeError as exc:
                    raise _YamlSecurityError(
                        "YAML_PARSE_ERROR",
                        "YAML string contains unpaired UTF-16 surrogate escape",
                    ) from exc
            tag = self.resolve(yaml_mod.ScalarNode, scalar_value, event.implicit)
            node = yaml_mod.ScalarNode(
                tag,
                scalar_value,
                event.start_mark,
                event.end_mark,
                style=event.style,
            )
            if anchor is not None:
                self.anchors[anchor] = node
            return node

        def compose_sequence_node(self, anchor: str | None) -> Any:
            start_event = self.get_event()
            if start_event.tag is not None:
                raise _YamlSecurityError(
                    "YAML_FORBIDDEN_TAG",
                    f"Explicit YAML tag is forbidden: {start_event.tag}",
                )
            self._container_depth += 1
            if self._container_depth > self._max_depth:
                self._container_depth -= 1
                raise _YamlSecurityError(
                    "YAML_MAX_DEPTH",
                    f"YAML nesting depth exceeds max_depth ({self._max_depth})",
                )
            tag = self.resolve(yaml_mod.SequenceNode, None, start_event.implicit)
            node = yaml_mod.SequenceNode(
                tag,
                [],
                start_event.start_mark,
                None,
                flow_style=start_event.flow_style,
            )
            if anchor is not None:
                self.anchors[anchor] = node
                self._active_anchors.add(anchor)
            try:
                index = 0
                while not self.check_event(yaml_mod.SequenceEndEvent):
                    node.value.append(self.compose_node(node, index))
                    index += 1
                end_event = self.get_event()
                node.end_mark = end_event.end_mark
                return node
            finally:
                if anchor is not None:
                    self._active_anchors.discard(anchor)
                self._container_depth -= 1

        def compose_mapping_node(self, anchor: str | None) -> Any:
            start_event = self.get_event()
            if start_event.tag is not None:
                raise _YamlSecurityError(
                    "YAML_FORBIDDEN_TAG",
                    f"Explicit YAML tag is forbidden: {start_event.tag}",
                )
            self._container_depth += 1
            if self._container_depth > self._max_depth:
                self._container_depth -= 1
                raise _YamlSecurityError(
                    "YAML_MAX_DEPTH",
                    f"YAML nesting depth exceeds max_depth ({self._max_depth})",
                )
            tag = self.resolve(yaml_mod.MappingNode, None, start_event.implicit)
            node = yaml_mod.MappingNode(
                tag,
                [],
                start_event.start_mark,
                None,
                flow_style=start_event.flow_style,
            )
            if anchor is not None:
                self.anchors[anchor] = node
                self._active_anchors.add(anchor)
            try:
                while not self.check_event(yaml_mod.MappingEndEvent):
                    item_key = self.compose_node(node, None)
                    item_value = self.compose_node(node, item_key)
                    node.value.append((item_key, item_value))
                end_event = self.get_event()
                node.end_mark = end_event.end_mark
                return node
            finally:
                if anchor is not None:
                    self._active_anchors.discard(anchor)
                self._container_depth -= 1

        def construct_yaml_bool(self, node: Any) -> bool:
            raw = str(self.construct_scalar(node))
            if raw in {"true", "True", "TRUE"}:
                return True
            if raw in {"false", "False", "FALSE"}:
                return False
            raise _YamlSecurityError("YAML_PARSE_ERROR", f"Invalid YAML boolean literal: {raw}")

        def construct_yaml_int(self, node: Any) -> int:
            raw = str(self.construct_scalar(node))
            sign = 1
            if raw.startswith("-"):
                sign = -1
                raw = raw[1:]
            elif raw.startswith("+"):
                raw = raw[1:]
            lower = raw.lower()
            try:
                if lower.startswith("0o"):
                    parsed = sign * int(lower[2:], 8)
                elif lower.startswith("0x"):
                    parsed = sign * int(lower[2:], 16)
                else:
                    parsed = sign * int(raw, 10)
                # Enforce CVE-2020-10735 digit ceiling on base-8 and base-16 ints too so
                # downstream json.dumps() / str() never raise an uncaught ValueError.
                _ = str(parsed)
                return parsed
            except ValueError as exc:
                raise _YamlSecurityError(
                    "YAML_PARSE_ERROR",
                    f"Invalid YAML integer literal: {exc}",
                ) from exc

        def construct_yaml_float(self, node: Any) -> float:
            raw = str(self.construct_scalar(node)).strip()
            lower = raw.lower()
            if lower in {".nan", "+.nan", "-.nan", ".inf", "+.inf", "-.inf"}:
                raise _YamlSecurityError(
                    "YAML_NONFINITE_NUMBER",
                    f"Non-finite YAML float literal is forbidden: {raw}",
                )
            try:
                parsed = float(raw)
            except (ValueError, OverflowError) as exc:
                raise _YamlSecurityError(
                    "YAML_PARSE_ERROR",
                    f"Invalid YAML float literal: {raw}",
                ) from exc
            if math.isnan(parsed) or math.isinf(parsed):
                raise _YamlSecurityError(
                    "YAML_NONFINITE_NUMBER",
                    f"Non-finite YAML float value is forbidden: {raw}",
                )
            return parsed

        def _validate_mapping_node_keys(self, mapping_node: Any) -> None:
            if getattr(mapping_node, "_krusch_validated", False):
                return
            explicit_keys: set[str] = set()
            saw_merge_key = False
            for key_node, value_node in mapping_node.value:
                if key_node.tag == "tag:yaml.org,2002:merge":
                    if saw_merge_key:
                        raise _YamlSecurityError(
                            "YAML_DUPLICATE_KEY",
                            "Duplicate YAML merge key '<<' in mapping",
                        )
                    saw_merge_key = True
                    if isinstance(value_node, yaml_mod.MappingNode):
                        self._validate_mapping_node_keys(value_node)
                    elif isinstance(value_node, yaml_mod.SequenceNode):
                        for subnode in value_node.value:
                            if not isinstance(subnode, yaml_mod.MappingNode):
                                raise _YamlSecurityError(
                                    "YAML_PARSE_ERROR",
                                    "YAML merge key '<<' sequence items must be mappings",
                                )
                            self._validate_mapping_node_keys(subnode)
                    else:
                        raise _YamlSecurityError(
                            "YAML_PARSE_ERROR",
                            "YAML merge key '<<' target must be a mapping or sequence of mappings",
                        )
                    continue

                if not isinstance(key_node, yaml_mod.ScalarNode):
                    raise _YamlSecurityError(
                        "YAML_INVALID_KEY",
                        "YAML mapping keys must be strings",
                    )
                constructed_key = self.construct_object(key_node, deep=True)
                if type(constructed_key) is not str:
                    raise _YamlSecurityError(
                        "YAML_INVALID_KEY",
                        f"YAML mapping keys must be strings, got {type(constructed_key).__name__}",
                    )
                if constructed_key in _FORBIDDEN_KEYS:
                    raise _YamlSecurityError(
                        "YAML_FORBIDDEN_KEY",
                        f"Forbidden YAML mapping key: {constructed_key!r}",
                    )
                if constructed_key in explicit_keys:
                    raise _YamlSecurityError(
                        "YAML_DUPLICATE_KEY",
                        f"Duplicate YAML mapping key: {constructed_key!r}",
                    )
                explicit_keys.add(constructed_key)

            mapping_node._krusch_validated = True

        def construct_mapping(self, node: Any, deep: bool = False) -> dict[str, Any]:
            if not isinstance(node, yaml_mod.MappingNode):
                raise _YamlSecurityError("YAML_PARSE_ERROR", "Expected a YAML mapping node")
            self._validate_mapping_node_keys(node)
            self.flatten_mapping(node)
            mapping = base_constructor.construct_mapping(self, node, deep=deep)
            for key in mapping:
                if type(key) is not str:
                    raise _YamlSecurityError(
                        "YAML_INVALID_KEY",
                        f"YAML mapping keys must be strings, got {type(key).__name__}",
                    )
                if key in _FORBIDDEN_KEYS:
                    raise _YamlSecurityError(
                        "YAML_FORBIDDEN_KEY",
                        f"Forbidden YAML mapping key: {key!r}",
                    )
            return mapping

        def _reject_forbidden_tag(self, node: Any) -> Any:
            tag = getattr(node, "tag", None)
            raise _YamlSecurityError(
                "YAML_FORBIDDEN_TAG",
                f"Explicit or unsupported YAML tag is forbidden: {tag}",
            )

        def _reject_forbidden_multi_tag(self, tag_suffix: str, node: Any) -> Any:
            tag = getattr(node, "tag", tag_suffix)
            raise _YamlSecurityError(
                "YAML_FORBIDDEN_TAG",
                f"Explicit or unsupported YAML tag is forbidden: {tag}",
            )

    _SovereignSafeLoader.yaml_constructors = {
        "tag:yaml.org,2002:null": base_safe_loader.construct_yaml_null,
        "tag:yaml.org,2002:bool": _SovereignSafeLoader.construct_yaml_bool,
        "tag:yaml.org,2002:int": _SovereignSafeLoader.construct_yaml_int,
        "tag:yaml.org,2002:float": _SovereignSafeLoader.construct_yaml_float,
        "tag:yaml.org,2002:str": base_safe_loader.construct_yaml_str,
        "tag:yaml.org,2002:seq": base_safe_loader.construct_yaml_seq,
        "tag:yaml.org,2002:map": base_safe_loader.construct_yaml_map,
        None: _SovereignSafeLoader._reject_forbidden_tag,
    }
    _SovereignSafeLoader.yaml_multi_constructors = {
        "": _SovereignSafeLoader._reject_forbidden_multi_tag,
    }

    if is_module:
        _LOADER_CACHE[yaml_mod] = _SovereignSafeLoader
    return _SovereignSafeLoader


def parse_safe_yaml(
    source: str | bytes | bytearray | memoryview,
    *,
    max_bytes: int = 1_048_576,
    max_depth: int = 32,
    max_nodes: int = 10_000,
    max_aliases: int = 64,
    max_alias_expansion_nodes: int = 1_000,
    allow_multiple_documents: bool = False,
    yaml_module: Any = None,
    tool: str = "yaml.parse",
) -> dict[str, Any]:
    """
    Parse untrusted YAML 1.2 Core text/bytes with fail-closed limits and tag/alias hardening.
    """
    safe_tool = _resolve_tool(tool, "yaml.parse")

    limit_err = _validate_parse_limits(
        max_bytes=max_bytes,
        max_depth=max_depth,
        max_nodes=max_nodes,
        max_aliases=max_aliases,
        max_alias_expansion_nodes=max_alias_expansion_nodes,
        tool=safe_tool,
    )
    if limit_err is not None:
        return limit_err
    if not isinstance(allow_multiple_documents, bool):
        return error_envelope(
            "YAML_INVALID_OPTIONS",
            "allow_multiple_documents must be a boolean",
            tool=safe_tool,
        )

    coerced = _coerce_source_bytes_and_text(source, max_bytes=max_bytes, tool=safe_tool)
    if isinstance(coerced, dict):
        return coerced
    raw_bytes, decoded_text = coerced

    yaml_mod = _resolve_yaml_module(yaml_module)
    if yaml_mod is None or not hasattr(yaml_mod, "SafeLoader") or not hasattr(yaml_mod, "YAMLError"):
        return error_envelope("YAML_UNAVAILABLE", "PyYAML is not installed", tool=safe_tool)

    loader_cls = _get_sovereign_loader_class(yaml_mod)
    loader = loader_cls(
        decoded_text,
        max_depth=max_depth,
        max_nodes=max_nodes,
        max_aliases=max_aliases,
        max_alias_expansion_nodes=max_alias_expansion_nodes,
    )
    try:
        if allow_multiple_documents:
            documents: list[Any] = []
            while loader.check_node():
                doc_node = loader.get_node()
                documents.append(loader.construct_document(doc_node))
            value: Any = documents
        else:
            if loader.check_node():
                first_node = loader.get_node()
                value = loader.construct_document(first_node)
                if loader.check_node():
                    return error_envelope(
                        "YAML_MULTIPLE_DOCUMENTS",
                        "Multiple YAML documents are forbidden unless allow_multiple_documents=True",
                        tool=safe_tool,
                    )
            else:
                value = None
    except _YamlSecurityError as sec_err:
        return error_envelope(sec_err.code, sec_err.message, details=sec_err.details, tool=safe_tool)
    except RecursionError:
        return error_envelope(
            "YAML_MAX_DEPTH",
            f"YAML nesting depth exceeds max_depth ({max_depth})",
            tool=safe_tool,
        )
    except yaml_mod.YAMLError as yaml_err:
        return error_envelope(
            "YAML_PARSE_ERROR",
            str(yaml_err) or "Invalid YAML syntax",
            tool=safe_tool,
        )
    except Exception as exc:  # pragma: no cover - defensive fail-closed guard
        return error_envelope(
            "YAML_PARSE_ERROR",
            str(exc) or "Failed to parse YAML payload",
            tool=safe_tool,
        )
    finally:
        loader.dispose()

    return ok_envelope(
        safe_tool,
        "Parsed safe YAML payload",
        {
            "value": value,
            "byte_length": len(raw_bytes),
            "node_count": loader.node_count,
            "alias_count": loader.alias_count,
        },
    )


def _validate_dumpable(
    value: Any,
    *,
    depth: int,
    max_depth: int,
    seen: set[int],
) -> Any:
    """Validate and normalize Python JSON-compatible values into plain containers before `safe_dump`."""
    if value is None:
        return None
    if isinstance(value, bool):
        return bool(value)
    if type(value) is int:
        try:
            _ = str(value)
        except ValueError as exc:
            raise _YamlSecurityError(
                "YAML_DUMP_ERROR",
                f"Integer exceeds safe serialization digit limit: {exc}",
            ) from exc
        return value
    if type(value) is float:
        if math.isnan(value) or math.isinf(value):
            raise _YamlSecurityError(
                "YAML_DUMP_ERROR",
                "Non-finite float (NaN or Infinity) cannot be serialized to safe YAML",
            )
        return value
    if type(value) is str:
        if "\x00" in value:
            raise _YamlSecurityError(
                "YAML_DUMP_ERROR",
                "String containing NUL byte cannot be serialized to safe YAML",
            )
        try:
            value.encode("utf-8")
        except UnicodeEncodeError as exc:
            raise _YamlSecurityError(
                "YAML_DUMP_ERROR",
                "String containing lone UTF-16 surrogates cannot be serialized to safe YAML",
            ) from exc
        return value

    if isinstance(value, (list, tuple)):
        next_depth = depth + 1
        if next_depth > max_depth:
            raise _YamlSecurityError(
                "YAML_DUMP_ERROR",
                f"Value nesting depth exceeds max_depth ({max_depth})",
            )
        obj_id = id(value)
        if obj_id in seen:
            raise _YamlSecurityError("YAML_DUMP_ERROR", "Cyclic reference cannot be serialized to safe YAML")
        seen.add(obj_id)
        try:
            return [
                _validate_dumpable(item, depth=next_depth, max_depth=max_depth, seen=seen)
                for item in value
            ]
        finally:
            seen.remove(obj_id)

    if isinstance(value, Mapping):
        next_depth = depth + 1
        if next_depth > max_depth:
            raise _YamlSecurityError(
                "YAML_DUMP_ERROR",
                f"Value nesting depth exceeds max_depth ({max_depth})",
            )
        obj_id = id(value)
        if obj_id in seen:
            raise _YamlSecurityError("YAML_DUMP_ERROR", "Cyclic reference cannot be serialized to safe YAML")
        seen.add(obj_id)
        try:
            sanitized_map: dict[str, Any] = {}
            for raw_key, raw_val in value.items():
                if type(raw_key) is not str:
                    raise _YamlSecurityError(
                        "YAML_DUMP_ERROR",
                        f"YAML mapping keys must be strings, got {type(raw_key).__name__}",
                    )
                if raw_key in _FORBIDDEN_KEYS:
                    raise _YamlSecurityError(
                        "YAML_FORBIDDEN_KEY",
                        f"Forbidden YAML mapping key: {raw_key!r}",
                    )
                validated_key = _validate_dumpable(
                    raw_key,
                    depth=next_depth,
                    max_depth=max_depth,
                    seen=seen,
                )
                sanitized_map[validated_key] = _validate_dumpable(
                    raw_val,
                    depth=next_depth,
                    max_depth=max_depth,
                    seen=seen,
                )
            return sanitized_map
        finally:
            seen.remove(obj_id)

    raise _YamlSecurityError(
        "YAML_DUMP_ERROR",
        f"Unsupported type for safe YAML serialization: {type(value).__name__}",
    )


_DUMPER_CACHE: weakref.WeakKeyDictionary[types.ModuleType, type[Any]] = weakref.WeakKeyDictionary()
_AMBIGUOUS_DUMP_STR_RE: re.Pattern[str] = re.compile(
    r"^(?:~|null|true|false|y|n|yes|no|on|off|[-+]?\.(?:inf|nan)|<<)$",
    re.IGNORECASE,
)


def _needs_double_quoted_dump(data: str) -> bool:
    if not data:
        return True
    if data[0].isspace() or data[-1].isspace():
        return True
    if data.startswith(("---", "...")) or "\n---" in data or "\n..." in data:
        return True
    if (
        _AMBIGUOUS_DUMP_STR_RE.match(data)
        or _NULL_CORE_RE.match(data)
        or _BOOL_CORE_RE.match(data)
        or _INT_CORE_RE.match(data)
        or _FLOAT_CORE_RE.match(data)
        or _MERGE_KEY_RE.match(data)
    ):
        return True
    for ch in data:
        code = ord(ch)
        if (
            (code < 0x20 and ch != "\n")
            or (0x7F <= code <= 0x9F)
            or code in (0xA0, 0x2028, 0x2029, 0xFEFF, 0xFFFE, 0xFFFF)
        ):
            return True
    return False


def _get_sovereign_safe_dumper(yaml_mod: Any) -> Any:
    base_dumper = getattr(yaml_mod, "SafeDumper", None)
    if base_dumper is None:
        return None
    if isinstance(yaml_mod, types.ModuleType):
        cached = _DUMPER_CACHE.get(yaml_mod)
        if cached is not None:
            return cached

    class _SovereignSafeDumper(base_dumper):  # type: ignore[valid-type, misc]
        pass

    # Copy yaml_representers dictionary so SafeDumper global state is never mutated.
    _SovereignSafeDumper.yaml_representers = dict(base_dumper.yaml_representers)

    def _represent_sovereign_str(dumper: Any, data: str) -> Any:
        if _needs_double_quoted_dump(data):
            return dumper.represent_scalar("tag:yaml.org,2002:str", data, style='"')
        style = "|" if "\n" in data else None
        return dumper.represent_scalar("tag:yaml.org,2002:str", data, style=style)

    _SovereignSafeDumper.add_representer(str, _represent_sovereign_str)

    if isinstance(yaml_mod, types.ModuleType):
        _DUMPER_CACHE[yaml_mod] = _SovereignSafeDumper
    return _SovereignSafeDumper


def dump_safe_yaml(
    value: Any,
    *,
    max_depth: int = 32,
    sort_keys: bool = True,
    yaml_module: Any = None,
    tool: str = "yaml.dump",
) -> dict[str, Any]:
    """
    Serialize JSON-compatible Python data into safe YAML without Python-specific tags or cycles.
    """
    safe_tool = _resolve_tool(tool, "yaml.dump")

    if not _is_strict_int(max_depth) or max_depth < 1:
        return error_envelope("YAML_INVALID_OPTIONS", "max_depth must be an integer >= 1", tool=safe_tool)
    if not isinstance(sort_keys, bool):
        return error_envelope("YAML_INVALID_OPTIONS", "sort_keys must be a boolean", tool=safe_tool)

    yaml_mod = _resolve_yaml_module(yaml_module)
    has_dump = callable(getattr(yaml_mod, "dump", None)) or callable(getattr(yaml_mod, "safe_dump", None))
    if yaml_mod is None or not has_dump:
        return error_envelope("YAML_UNAVAILABLE", "PyYAML is not installed", tool=safe_tool)

    try:
        sanitized = _validate_dumpable(value, depth=0, max_depth=max_depth, seen=set())
        dumper_cls = _get_sovereign_safe_dumper(yaml_mod)
        if dumper_cls is not None and callable(getattr(yaml_mod, "dump", None)):
            text = yaml_mod.dump(
                sanitized,
                Dumper=dumper_cls,
                sort_keys=sort_keys,
                allow_unicode=True,
                default_flow_style=False,
            )
        else:
            text = yaml_mod.safe_dump(
                sanitized,
                sort_keys=sort_keys,
                allow_unicode=True,
                default_flow_style=False,
            )
    except _YamlSecurityError as sec_err:
        return error_envelope(sec_err.code, sec_err.message, details=sec_err.details, tool=safe_tool)
    except RecursionError:
        return error_envelope(
            "YAML_DUMP_ERROR",
            f"Value nesting depth exceeds max_depth ({max_depth})",
            tool=safe_tool,
        )
    except Exception as exc:
        return error_envelope(
            "YAML_DUMP_ERROR",
            str(exc) or "Failed to serialize safe YAML payload",
            tool=safe_tool,
        )

    return ok_envelope(safe_tool, "Serialized safe YAML payload", {"yaml": text})


def validate_yaml_config(
    source: str | bytes | bytearray | memoryview,
    schema: Any,
    *,
    max_bytes: int = 1_048_576,
    max_depth: int = 32,
    max_nodes: int = 10_000,
    max_aliases: int = 64,
    max_alias_expansion_nodes: int = 1_000,
    yaml_module: Any = None,
    tool: str = "yaml.validate",
) -> dict[str, Any]:
    """
    Parse untrusted YAML safely and validate against a JSON Schema dict or Pydantic model.
    """
    safe_tool = _resolve_tool(tool, "yaml.validate")

    parsed = parse_safe_yaml(
        source,
        max_bytes=max_bytes,
        max_depth=max_depth,
        max_nodes=max_nodes,
        max_aliases=max_aliases,
        max_alias_expansion_nodes=max_alias_expansion_nodes,
        allow_multiple_documents=False,
        yaml_module=yaml_module,
        tool=safe_tool,
    )
    if not parsed["ok"]:
        return parsed

    validated = validate_payload(
        schema,
        parsed["data"]["value"],
        max_depth=max_depth,
        tool=safe_tool,
    )
    if not validated["ok"]:
        return validated

    return ok_envelope(
        safe_tool,
        "Validated safe YAML configuration",
        {
            "value": validated["data"],
            "byte_length": parsed["data"]["byte_length"],
            "node_count": parsed["data"]["node_count"],
        },
    )


def _is_symlink_at(name: str, dir_fd: int | None) -> bool:
    try:
        st_lnk = os.lstat(name, dir_fd=dir_fd) if dir_fd is not None else os.lstat(name)
        return stat.S_ISLNK(st_lnk.st_mode)
    except OSError:
        return False


def _open_confined_pack_fd(
    raw_path: str,
    raw_base: str,
    *,
    tool: str,
) -> tuple[int, str] | dict[str, Any]:
    """
    Open `raw_path` strictly inside `raw_base` by walking every relative component via
    `dir_fd` + `O_NOFOLLOW`, eliminating intermediate-directory symlink TOCTOU races.
    """
    resolved_base = os.path.realpath(raw_base)
    abs_base = os.path.abspath(raw_base)
    dir_flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    try:
        base_fd = os.open(resolved_base, dir_flags)
    except OSError:
        return error_envelope(
            "YAML_INVALID_OPTIONS",
            f"base_dir is not an existing directory: {raw_base}",
            tool=tool,
        )

    curr_fd: int | None = base_fd
    try:
        if not stat.S_ISDIR(os.fstat(base_fd).st_mode):
            return error_envelope(
                "YAML_INVALID_OPTIONS",
                f"base_dir is not an existing directory: {raw_base}",
                tool=tool,
            )

        if os.path.isabs(raw_path):
            if raw_path == abs_base or raw_path.startswith(abs_base + os.sep):
                candidate_abs = os.path.normpath(resolved_base + raw_path[len(abs_base) :])
            else:
                candidate_abs = os.path.normpath(raw_path)
        else:
            candidate_abs = os.path.normpath(os.path.join(resolved_base, raw_path))

        try:
            common = os.path.commonpath([resolved_base, candidate_abs])
        except ValueError:
            common = ""
        if common != resolved_base or candidate_abs == resolved_base:
            return error_envelope(
                "YAML_PATH_TRAVERSAL",
                "YAML pack path escapes base_dir",
                tool=tool,
            )

        rel_path = os.path.relpath(candidate_abs, resolved_base)
        parts = [seg for seg in rel_path.split(os.sep) if seg and seg != "."]
        if not parts or any(seg == ".." for seg in parts):
            return error_envelope(
                "YAML_PATH_TRAVERSAL",
                "YAML pack path escapes base_dir",
                tool=tool,
            )

        step_dir_flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
        for seg in parts[:-1]:
            try:
                next_fd = os.open(seg, step_dir_flags, dir_fd=curr_fd)
            except OSError as exc:
                if exc.errno == errno.ELOOP or _is_symlink_at(seg, curr_fd):
                    return error_envelope(
                        "YAML_PATH_TRAVERSAL",
                        "YAML pack symlink directory traversal is forbidden",
                        tool=tool,
                    )
                if exc.errno in (errno.ENOENT, errno.ENOTDIR):
                    return error_envelope(
                        "YAML_FILE_NOT_FOUND",
                        f"YAML pack file not found: {raw_path}",
                        tool=tool,
                    )
                return error_envelope(
                    "YAML_IO_ERROR",
                    f"Failed to traverse YAML pack directory: {exc.strerror or exc}",
                    tool=tool,
                )
            os.close(curr_fd)
            curr_fd = next_fd

        leaf = parts[-1]
        leaf_flags = os.O_RDONLY | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_NOFOLLOW", 0)
        try:
            leaf_fd = os.open(leaf, leaf_flags, dir_fd=curr_fd)
        except OSError as exc:
            if exc.errno == errno.ELOOP or _is_symlink_at(leaf, curr_fd):
                return error_envelope(
                    "YAML_PATH_TRAVERSAL",
                    "YAML pack symlink traversal is forbidden",
                    tool=tool,
                )
            if exc.errno == errno.EISDIR:
                return error_envelope(
                    "YAML_INVALID_INPUT",
                    "YAML pack path must reference a regular file, not a directory",
                    tool=tool,
                )
            if exc.errno in (errno.ENOENT, errno.ENOTDIR):
                return error_envelope(
                    "YAML_FILE_NOT_FOUND",
                    f"YAML pack file not found: {raw_path}",
                    tool=tool,
                )
            return error_envelope(
                "YAML_IO_ERROR",
                f"Failed to open YAML pack file: {exc.strerror or exc}",
                tool=tool,
            )

        resolved_target = os.path.join(resolved_base, *parts)
        return leaf_fd, resolved_target
    finally:
        if curr_fd is not None:
            with_close = curr_fd
            curr_fd = None
            os.close(with_close)


def _read_bounded_pack_file(
    path_or_text: Any,
    *,
    base_dir: str | os.PathLike[str] | None,
    max_bytes: int,
    tool: str,
) -> tuple[bytes, str] | dict[str, Any]:
    """Resolve regular file path with `base_dir` containment and bounded descriptor reads."""
    if not isinstance(path_or_text, (str, os.PathLike)):
        return error_envelope(
            "YAML_INVALID_INPUT",
            "YAML pack file path must be str or os.PathLike",
            tool=tool,
        )
    try:
        raw_path = os.fspath(path_or_text)
    except Exception:
        return error_envelope(
            "YAML_INVALID_INPUT",
            "YAML pack file path must be str or os.PathLike[str]",
            tool=tool,
        )
    if not isinstance(raw_path, str) or not raw_path.strip() or "\x00" in raw_path:
        return error_envelope(
            "YAML_INVALID_INPUT",
            "YAML pack file path must be a non-empty string without NUL bytes",
            tool=tool,
        )

    if base_dir is not None:
        if not isinstance(base_dir, (str, os.PathLike)):
            return error_envelope(
                "YAML_INVALID_OPTIONS",
                "base_dir must be str or os.PathLike",
                tool=tool,
            )
        try:
            raw_base = os.fspath(base_dir)
        except Exception:
            return error_envelope(
                "YAML_INVALID_OPTIONS",
                "base_dir must be str or os.PathLike[str]",
                tool=tool,
            )
        if not isinstance(raw_base, str) or not raw_base.strip() or "\x00" in raw_base:
            return error_envelope(
                "YAML_INVALID_OPTIONS",
                "base_dir must be a non-empty string without NUL bytes",
                tool=tool,
            )
        opened = _open_confined_pack_fd(raw_path, raw_base, tool=tool)
        if isinstance(opened, dict):
            return opened
        fd, resolved_target = opened
    else:
        resolved_target = os.path.realpath(raw_path)
        open_flags = os.O_RDONLY | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_NOFOLLOW", 0)
        try:
            fd = os.open(resolved_target, open_flags)
        except OSError as exc:
            if exc.errno in (errno.ENOENT, errno.ENOTDIR):
                return error_envelope(
                    "YAML_FILE_NOT_FOUND",
                    f"YAML pack file not found: {raw_path}",
                    tool=tool,
                )
            if exc.errno == errno.EISDIR:
                return error_envelope(
                    "YAML_INVALID_INPUT",
                    "YAML pack path must reference a regular file, not a directory",
                    tool=tool,
                )
            return error_envelope(
                "YAML_IO_ERROR",
                f"Failed to open YAML pack file: {exc.strerror or exc}",
                tool=tool,
            )

    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            return error_envelope(
                "YAML_INVALID_INPUT",
                "YAML pack path must reference a regular file",
                tool=tool,
            )
        if st.st_size > max_bytes:
            return error_envelope(
                "YAML_TOO_LARGE",
                f"YAML pack file exceeds max_bytes ({max_bytes})",
                tool=tool,
            )

        buf = bytearray()
        while True:
            remaining = (max_bytes + 1) - len(buf)
            chunk = os.read(fd, min(_READ_CHUNK_BYTES, remaining))
            if not chunk:
                break
            buf.extend(chunk)
            if len(buf) > max_bytes:
                return error_envelope(
                    "YAML_TOO_LARGE",
                    f"YAML pack file exceeds max_bytes ({max_bytes})",
                    tool=tool,
                )
        return bytes(buf), resolved_target
    except OSError as exc:
        return error_envelope(
            "YAML_IO_ERROR",
            f"Failed to read YAML pack file: {exc.strerror or exc}",
            tool=tool,
        )
    finally:
        os.close(fd)


def load_safe_yaml_pack(
    path_or_text: str | bytes | bytearray | memoryview | os.PathLike[str],
    *,
    base_dir: str | os.PathLike[str] | None = None,
    from_file: bool = False,
    required_keys: Sequence[str] | None = None,
    schema: Any = None,
    max_bytes: int = 1_048_576,
    max_depth: int = 32,
    max_nodes: int = 10_000,
    max_aliases: int = 64,
    max_alias_expansion_nodes: int = 1_000,
    yaml_module: Any = None,
    tool: str = "yaml.pack",
) -> dict[str, Any]:
    """
    Load, hash (SHA-256), and optionally schema-validate a sovereign YAML authority pack.
    """
    safe_tool = _resolve_tool(tool, "yaml.pack")

    limit_err = _validate_parse_limits(
        max_bytes=max_bytes,
        max_depth=max_depth,
        max_nodes=max_nodes,
        max_aliases=max_aliases,
        max_alias_expansion_nodes=max_alias_expansion_nodes,
        tool=safe_tool,
    )
    if limit_err is not None:
        return limit_err
    if not isinstance(from_file, bool):
        return error_envelope("YAML_INVALID_OPTIONS", "from_file must be a boolean", tool=safe_tool)

    if required_keys is not None:
        if not isinstance(required_keys, Sequence) or isinstance(
            required_keys, (str, bytes, bytearray, memoryview)
        ):
            return error_envelope(
                "YAML_INVALID_OPTIONS",
                "required_keys must be a sequence of non-empty strings",
                tool=safe_tool,
            )
        if any(not isinstance(k, str) or not k.strip() for k in required_keys):
            return error_envelope(
                "YAML_INVALID_OPTIONS",
                "required_keys must contain only non-empty strings",
                tool=safe_tool,
            )

    is_file_mode = from_file or isinstance(path_or_text, os.PathLike)
    source_path: str | None = None

    if is_file_mode:
        file_res = _read_bounded_pack_file(
            path_or_text,
            base_dir=base_dir,
            max_bytes=max_bytes,
            tool=safe_tool,
        )
        if isinstance(file_res, dict):
            return file_res
        raw_bytes, source_path = file_res
    else:
        coerced = _coerce_source_bytes_and_text(path_or_text, max_bytes=max_bytes, tool=safe_tool)
        if isinstance(coerced, dict):
            return coerced
        raw_bytes, _ = coerced

    sha256_hex = hashlib.sha256(raw_bytes).hexdigest()

    parsed = parse_safe_yaml(
        raw_bytes,
        max_bytes=max_bytes,
        max_depth=max_depth,
        max_nodes=max_nodes,
        max_aliases=max_aliases,
        max_alias_expansion_nodes=max_alias_expansion_nodes,
        allow_multiple_documents=False,
        yaml_module=yaml_module,
        tool=safe_tool,
    )
    if not parsed["ok"]:
        return parsed

    pack = parsed["data"]["value"]
    if not isinstance(pack, dict):
        return error_envelope(
            "YAML_INVALID_PACK",
            "YAML pack root must be a mapping object",
            tool=safe_tool,
        )

    if required_keys is not None:
        missing = [key for key in required_keys if key not in pack]
        if missing:
            return error_envelope(
                "YAML_MISSING_REQUIRED_KEYS",
                f"YAML pack is missing required keys: {', '.join(missing)}",
                details={"missing_keys": missing},
                tool=safe_tool,
            )

    if schema is not None:
        validated = validate_payload(
            schema,
            pack,
            max_depth=max_depth,
            tool=safe_tool,
        )
        if not validated["ok"]:
            return validated
        if not isinstance(validated["data"], dict):
            return error_envelope(
                "YAML_INVALID_PACK",
                "Validated YAML pack root must remain a mapping object",
                tool=safe_tool,
            )
        pack = validated["data"]

    return ok_envelope(
        safe_tool,
        "Loaded safe YAML pack",
        {
            "pack": pack,
            "sha256": sha256_hex,
            "byte_length": len(raw_bytes),
            "node_count": parsed["data"]["node_count"],
            "source_path": source_path,
        },
    )
