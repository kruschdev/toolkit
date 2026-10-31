"""
krusch_toolkit.raw_rag — Source-Preserving Episodic Retrieval & Append-Only Memory (Python 3.12 Stdlib).

Mirrors `@krusch/toolkit/raw-rag` (`arXiv:2610.30755`, "Is Complex Agentic Memory Always Needed?
Naive RAG Is Stronger Than We Thought", Bao et al., 2026) with zero mandatory third-party
dependencies so all Python homelab services (`krusch-law`, `krusch-biz`, `krusch-bizlaw`,
`krusch-nexus`, `krusch-fs`, `krusch-agentic-proxy`) can import it directly.

Core Invariants:
- Zero-LLM ingestion (`llm_ingestion_calls == 0`): preserves verbatim dialogue, dates, IDs, and
  multi-hop state transitions without lossy summarization or atomic extraction.
- Source-preserving 256-token sliding windows with 32-token overlap (`stride = 224`), turn
  back-pointers, and causal phase-boundary isolation (`isolate_phases`).
- Two-stage retrieval: wide dense candidate pool (`Top-128`) + cross-encoder / System-1 `YES`/`NO`
  logprob reranking (`Top-15`).
- Graceful 5,000-token context budget fallback: disables turn expansion first (`DISABLED_TURN_EXPANSION`)
  before dropping or prefix-clipping any of the selected top-k evidence windows.
- Append-only write normalization (`ADD` / `NONE`): converts destructive `UPDATE` proposals into
  non-destructive `ADD` records with `supersedes_id` lineage and blocks non-compliance `DELETE`.
- Coverage / Utilization (`C_hat`, `U_hat`) and Conditional Path Retention (`P(path|result)`)
  diagnostic evaluators, plus Appendix E (`Table 34`) RAG baseline configuration auditing.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import urllib.request
from collections.abc import Callable, Mapping, Sequence
from datetime import datetime
from types import MappingProxyType
from typing import Any

from krusch_toolkit.decide import calibrate_choice_logprobs
from krusch_toolkit.embeddings import (
    DEFAULT_EMBED_DIMS,
    DEFAULT_EMBED_MODEL,
    calibrate_query_similarity,
    cosine_similarity,
    deterministic_token_vector,
    embed_batch,
    embed_text,
)

RAW_RAG_DEFAULTS: Mapping[str, Any] = MappingProxyType(
    {
        "window_tokens": 256,
        "overlap_tokens": 32,
        "stride_tokens": 224,
        "dense_candidate_k": 128,
        "final_rerank_k": 15,
        "max_evidence_tokens": 5000,
        "turn_expansion": True,
        "deduplicate_turns": False,
        "chronological_order": True,
        "llm_ingestion_calls": 0,
    }
)

RAG_BASELINE_CONSTRAINTS: Mapping[str, Any] = MappingProxyType(
    {
        "min_chunk_tokens": 64,
        "recommended_chunk_range": (128, 1024),
        "max_recommended_chunk_tokens": 1024,
        "min_recommended_top_k": 5,
        "optimal_top_k_range": (10, 30),
        "max_distractor_safe_top_k": 60,
        "recommended_dense_candidate_k": 128,
        "requires_cross_encoder_rerank": True,
        "allow_destructive_overwrite": False,
    }
)

QWEN_RERANKER_TEMPLATE: Mapping[str, str] = MappingProxyType(
    {
        "system": (
            'Judge whether the Document meets the requirements based on the Query and the Instruct provided. '
            'Note that the answer can only be "yes" or "no".'
        ),
        "instruction": (
            "Given a question and a passage, determine if the passage contains information relevant to answering "
            "the question."
        ),
    }
)

_TOKEN_OFFSET_RE = re.compile(r"[A-Za-z0-9_]+|[^\sA-Za-z0-9_]")
_ALNUM_RE = re.compile(r"[a-z0-9_]+")
_STOPWORDS = frozenset(
    {
        "the", "and", "for", "that", "this", "with", "from", "have", "has", "had",
        "what", "when", "where", "which", "who", "whom", "whose", "why", "how",
        "was", "were", "are", "been", "being", "into", "onto", "upon", "about",
        "does", "did", "doing", "would", "could", "should", "will", "shall", "may",
        "might", "must", "can", "their", "there", "they", "them", "then", "than",
        "your", "yours", "our", "ours", "his", "her", "hers", "its",
    }
)

LEGAL_BOILERPLATE_STOPWORDS = frozenset(
    {
        "agreement", "agreements", "party", "parties", "company", "contract", "contracts",
        "section", "sections", "article", "articles", "clause", "clauses", "pursuant",
        "hereof", "thereof", "herein", "therein", "hereunder", "including", "applicable",
        "provision", "provisions", "terms",
    }
)

__all__ = [
    "RAW_RAG_DEFAULTS",
    "RAG_BASELINE_CONSTRAINTS",
    "QWEN_RERANKER_TEMPLATE",
    "LEGAL_BOILERPLATE_STOPWORDS",
    "tokenize_with_offsets",
    "estimate_token_count",
    "serialize_conversation_turn",
    "chunk_conversation_windows",
    "audit_rag_baseline_config",
    "normalize_append_only_write_op",
    "audit_mutation_stream",
    "build_qwen_reranker_prompt",
    "should_narrow_candidate_sub_span",
    "score_deterministic_cross_encoder",
    "rerank_candidate_windows",
    "assemble_reader_evidence",
    "evaluate_coverage_and_utilization",
    "evaluate_conditional_path_retention",
    "RawRagIndex",
    "create_raw_rag_index",
]


def tokenize_with_offsets(text: str) -> list[dict[str, Any]]:
    """Tokenize text while preserving exact `[start, end)` character spans."""
    if not isinstance(text, str) or not text:
        return []
    return [
        {"token": m.group(0), "start": m.start(), "end": m.end()}
        for m in _TOKEN_OFFSET_RE.finditer(text)
    ]


def estimate_token_count(text: str) -> int:
    """Deterministic token count matching `tokenize_with_offsets`."""
    return len(tokenize_with_offsets(text))


def _parse_iso_timestamp_ms(date_str: str) -> float | None:
    if not date_str or date_str == "unknown":
        return None
    cleaned = date_str.strip()
    if cleaned.endswith("Z"):
        cleaned = f"{cleaned[:-1]}+00:00"
    try:
        dt = datetime.fromisoformat(cleaned)
        return dt.timestamp() * 1000.0
    except ValueError:
        return None


def serialize_conversation_turn(turn: dict[str, Any] | str, index: int = 0) -> dict[str, Any]:
    """
    Serialize a single dialogue turn preserving date (`"unknown"` when missing), speaker,
    verbatim content, and optional inline image captions without LLM transformation.
    """
    if isinstance(turn, str):
        content = turn.strip()
        serialized = f"[Date: unknown] Turn {index + 1}: {content}"
        return {
            "turn_index": index,
            "turn_id": f"turn_{index}",
            "date": "unknown",
            "speaker": f"Turn {index + 1}",
            "content": content,
            "image_captions": [],
            "phase": None,
            "timestamp": None,
            "serialized": serialized,
        }

    safe_turn = turn if isinstance(turn, Mapping) else {}
    raw_id = safe_turn.get("turn_id") or safe_turn.get("turnId") or safe_turn.get("id")
    turn_id = str(raw_id) if raw_id is not None else f"turn_{index}"

    raw_date = safe_turn.get("date")
    if raw_date is None:
        raw_date = safe_turn.get("session_date") or safe_turn.get("sessionDate") or safe_turn.get("created_at") or safe_turn.get("createdAt")
    date = str(raw_date).strip() if raw_date is not None and str(raw_date).strip() else "unknown"

    raw_speaker = safe_turn.get("speaker") or safe_turn.get("role") or f"Speaker_{index + 1}"
    speaker = str(raw_speaker).strip() or f"Speaker_{index + 1}"

    raw_content = safe_turn.get("content") if safe_turn.get("content") is not None else safe_turn.get("text", "")
    content = str(raw_content).strip()

    raw_captions = safe_turn.get("image_captions") or safe_turn.get("imageCaptions")
    if isinstance(raw_captions, (list, tuple)):
        image_captions = [str(c).strip() for c in raw_captions if str(c).strip()]
    else:
        single_cap = safe_turn.get("image_caption") or safe_turn.get("imageCaption")
        image_captions = [str(single_cap).strip()] if isinstance(single_cap, str) and single_cap.strip() else []

    raw_phase = safe_turn.get("phase")
    phase: int | None = None
    if isinstance(raw_phase, (int, float)) and not isinstance(raw_phase, bool) and math.isfinite(float(raw_phase)):
        phase = int(raw_phase)

    raw_ts = safe_turn.get("timestamp")
    timestamp: float | None = None
    if isinstance(raw_ts, (int, float)) and not isinstance(raw_ts, bool) and math.isfinite(float(raw_ts)):
        timestamp = float(raw_ts)
    elif date != "unknown":
        timestamp = _parse_iso_timestamp_ms(date)

    caption_suffix = (
        "\n" + "\n".join(f"[Image Caption]: {cap}" for cap in image_captions)
        if image_captions
        else ""
    )
    serialized = f"[Date: {date}] {speaker}: {content}{caption_suffix}"

    return {
        "turn_index": index,
        "turn_id": turn_id,
        "date": date,
        "speaker": speaker,
        "content": content,
        "image_captions": image_captions,
        "phase": phase,
        "timestamp": timestamp,
        "serialized": serialized,
    }


def chunk_conversation_windows(
    turns: Sequence[dict[str, Any] | str],
    *,
    window_tokens: int = 256,
    overlap_tokens: int = 32,
    isolate_phases: bool = False,
    id_prefix: str = "win",
) -> dict[str, Any]:
    """
    Partition a conversation history `H = (m_1, ..., m_T)` into overlapping 256-token
    windows (`overlap = 32`, `stride = 224`) while retaining exact source turn indices
    for display-time turn expansion and causal phase filtering.
    """
    if not turns:
        return {"serialized_turns": [], "windows": [], "total_tokens": 0}

    win_tokens = max(16, int(window_tokens) if window_tokens and window_tokens > 0 else 256)
    ov_tokens = min(max(0, int(overlap_tokens)), win_tokens // 2)
    stride = max(1, win_tokens - ov_tokens)

    serialized_turns = [serialize_conversation_turn(t, idx) for idx, t in enumerate(turns)]

    segments: list[list[dict[str, Any]]] = []
    if not isolate_phases:
        segments.append(serialized_turns)
    else:
        current_seg: list[dict[str, Any]] = []
        for s_turn in serialized_turns:
            if (
                current_seg
                and s_turn["phase"] != current_seg[-1]["phase"]
                and (s_turn["phase"] is not None or current_seg[-1]["phase"] is not None)
            ):
                segments.append(current_seg)
                current_seg = [s_turn]
            else:
                current_seg.append(s_turn)
        if current_seg:
            segments.append(current_seg)

    windows: list[dict[str, Any]] = []
    window_index = 0
    global_token_offset = 0

    for seg_turns in segments:
        pieces: list[str] = []
        turn_char_spans: list[tuple[int, int, int]] = []
        cursor = 0

        for idx, s_turn in enumerate(seg_turns):
            if idx > 0:
                pieces.append("\n")
                cursor += 1
            seg_text = s_turn["serialized"]
            start_char = cursor
            end_char = cursor + len(seg_text)
            pieces.append(seg_text)
            turn_char_spans.append((s_turn["turn_index"], start_char, end_char))
            cursor = end_char

        seg_stream = "".join(pieces)
        seg_tokens = tokenize_with_offsets(seg_stream)
        if not seg_tokens:
            continue

        start_tok = 0
        while start_tok < len(seg_tokens):
            end_tok = min(start_tok + win_tokens, len(seg_tokens))
            start_char = seg_tokens[start_tok]["start"]
            end_char = seg_tokens[end_tok - 1]["end"]
            text = seg_stream[start_char:end_char]
            content_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()

            turn_indices = [
                t_idx
                for (t_idx, span_start, span_end) in turn_char_spans
                if span_end > start_char and span_start < end_char
            ]
            turn_ids = [serialized_turns[i]["turn_id"] for i in turn_indices]
            phases = [serialized_turns[i]["phase"] for i in turn_indices if serialized_turns[i]["phase"] is not None]
            timestamps = [
                serialized_turns[i]["timestamp"]
                for i in turn_indices
                if serialized_turns[i]["timestamp"] is not None
            ]

            windows.append(
                {
                    "window_id": f"{id_prefix}_{window_index}",
                    "window_index": window_index,
                    "text": text,
                    "content_hash": content_hash,
                    "start_token": global_token_offset + start_tok,
                    "end_token": global_token_offset + end_tok,
                    "token_count": end_tok - start_tok,
                    "turn_indices": turn_indices,
                    "turn_ids": turn_ids,
                    "min_phase": min(phases) if phases else None,
                    "max_phase": max(phases) if phases else None,
                    "min_timestamp": min(timestamps) if timestamps else None,
                    "max_timestamp": max(timestamps) if timestamps else None,
                }
            )
            window_index += 1
            if end_tok >= len(seg_tokens):
                break
            start_tok += stride

        global_token_offset += len(seg_tokens)

    return {
        "serialized_turns": serialized_turns,
        "windows": windows,
        "total_tokens": global_token_offset,
    }


def audit_rag_baseline_config(config: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """
    Audit a RAG or agentic memory retrieval configuration against Appendix E (`Table 34`)
    and Section 5.4 (`Table 5`) baseline failure modes.
    """
    cfg = config or {}
    chunk_tokens = int(
        cfg.get("chunk_tokens")
        or cfg.get("window_tokens")
        or cfg.get("chunkTokens")
        or RAW_RAG_DEFAULTS["window_tokens"]
    )
    final_top_k = int(
        cfg.get("final_top_k")
        if cfg.get("final_top_k") is not None
        else (
            cfg.get("top_k")
            if cfg.get("top_k") is not None
            else (
                cfg.get("finalTopK")
                if cfg.get("finalTopK") is not None
                else RAW_RAG_DEFAULTS["final_rerank_k"]
            )
        )
    )
    dense_candidate_k = int(
        cfg.get("dense_candidate_k")
        or cfg.get("denseCandidateK")
        or RAW_RAG_DEFAULTS["dense_candidate_k"]
    )

    if "reranker_enabled" in cfg:
        reranker_enabled = bool(cfg["reranker_enabled"])
    elif "rerankerEnabled" in cfg:
        reranker_enabled = bool(cfg["rerankerEnabled"])
    elif "reranker" in cfg:
        reranker_enabled = bool(cfg["reranker"])
    else:
        reranker_enabled = True

    allow_destructive = bool(
        cfg.get("allow_destructive_overwrite")
        or cfg.get("allowDestructiveOverwrite")
        or cfg.get("allow_delete")
        or cfg.get("allowDelete")
    )
    llm_ingestion_transform = bool(
        cfg.get("llm_ingestion_transform") or cfg.get("llmIngestionTransform")
    )

    findings: list[dict[str, str]] = []

    if chunk_tokens > RAG_BASELINE_CONSTRAINTS["max_recommended_chunk_tokens"]:
        findings.append(
            {
                "code": "CHUNK_TOO_LARGE",
                "severity": "error",
                "message": (
                    f"chunk_tokens={chunk_tokens} exceeds 1024 tokens "
                    "(Appendix E Table 34 anti-pattern: dilutes dense embeddings and wastes reader budget)."
                ),
            }
        )
    elif chunk_tokens < RAG_BASELINE_CONSTRAINTS["min_chunk_tokens"]:
        findings.append(
            {
                "code": "CHUNK_TOO_SMALL",
                "severity": "warning",
                "message": f"chunk_tokens={chunk_tokens} is below 64 tokens and risks severing local coreference.",
            }
        )

    if final_top_k < RAG_BASELINE_CONSTRAINTS["min_recommended_top_k"]:
        findings.append(
            {
                "code": "TOP_K_TOO_LOW",
                "severity": "error",
                "message": f"final_top_k={final_top_k} is < 5 (starves multi-session coverage; k=1 loses -11.73 pp).",
            }
        )
    elif final_top_k > RAG_BASELINE_CONSTRAINTS["max_distractor_safe_top_k"]:
        findings.append(
            {
                "code": "TOP_K_DISTRACTOR_OVERFLOW",
                "severity": "error",
                "message": f"final_top_k={final_top_k} exceeds 60 (floods reader with distractors; k=120 loses -14.57 pp).",
            }
        )
    elif not (
        RAG_BASELINE_CONSTRAINTS["optimal_top_k_range"][0]
        <= final_top_k
        <= RAG_BASELINE_CONSTRAINTS["optimal_top_k_range"][1]
    ):
        findings.append(
            {
                "code": "TOP_K_SUBOPTIMAL_BAND",
                "severity": "warning",
                "message": f"final_top_k={final_top_k} is outside the peak [10, 30] operating band (default Top-15).",
            }
        )

    if not reranker_enabled:
        findings.append(
            {
                "code": "MISSING_RERANKER",
                "severity": "error",
                "message": "Cross-encoder reranking is disabled (-3.92 pp degradation, p_Holm=0.0012 on MemoryAgentBench).",
            }
        )
    elif dense_candidate_k < max(final_top_k * 2, 30):
        findings.append(
            {
                "code": "DENSE_POOL_TOO_NARROW",
                "severity": "warning",
                "message": f"dense_candidate_k={dense_candidate_k} narrows pre-rerank recall; Top-128 pool is recommended.",
            }
        )

    if allow_destructive:
        findings.append(
            {
                "code": "DESTRUCTIVE_MUTATION_ENABLED",
                "severity": "error",
                "message": "In-place UPDATE/DELETE mutations enabled (<2% effective write rate; ADD/NONE gains +2.06 pp).",
            }
        )

    if llm_ingestion_transform:
        findings.append(
            {
                "code": "LLM_INGESTION_BOTTLENECK",
                "severity": "warning",
                "message": "LLM ingestion extraction enabled on episodic dialogue (risks -5.78 to -19.62 pp accuracy loss).",
            }
        )

    error_count = sum(1 for f in findings if f["severity"] == "error")
    warning_count = sum(1 for f in findings if f["severity"] == "warning")
    status = (
        "WEAKENED_BASELINE"
        if error_count > 0
        else ("SUBOPTIMAL" if warning_count > 0 else "STRONG_RAW_RAG")
    )

    return {
        "valid": error_count == 0,
        "status": status,
        "findings": findings,
        "recommended_config": dict(RAW_RAG_DEFAULTS),
    }


def _normalize_comparable_text(text: Any) -> str:
    return re.sub(r"\s+", " ", str(text or "").strip().lower())


def normalize_append_only_write_op(
    proposal: Mapping[str, Any] | None = None,
    existing_records: Sequence[Mapping[str, Any]] | None = None,
    *,
    explicit_compliance_erase: bool = False,
) -> dict[str, Any]:
    """
    Enforce the `ADD` / `NONE` append-only memory write contract (Section 1, Figure 2, Table 1).
    Converts destructive `UPDATE` proposals into non-destructive `ADD` records carrying
    `supersedes_id` provenance, suppresses duplicate/no-op writes, and blocks non-compliance `DELETE`.
    """
    prop = proposal or {}
    raw_action = str(prop.get("action") or "NONE").strip().upper()
    raw_text = prop.get("text") if prop.get("text") is not None else prop.get("content", "")
    text = str(raw_text).strip()

    raw_target = prop.get("target_id") if prop.get("target_id") is not None else prop.get("targetId")
    if raw_target is None and raw_action != "ADD" and prop.get("id") is not None:
        raw_target = prop.get("id")
    target_id = str(raw_target) if raw_target is not None else None

    active_records = [
        rec for rec in (existing_records or []) if isinstance(rec, Mapping) and not rec.get("deleted")
    ]

    if raw_action == "DELETE":
        matched = next((r for r in active_records if str(r.get("id")) == target_id), None) if target_id else None
        if matched is None:
            return {
                "action": "NONE",
                "original_action": "DELETE",
                "effective_write": False,
                "supersedes_id": None,
                "target_id": target_id,
                "text": "",
                "reason": "MALFORMED_TARGET_ID",
            }
        if explicit_compliance_erase:
            return {
                "action": "COMPLIANCE_TOMBSTONE",
                "original_action": "DELETE",
                "effective_write": True,
                "supersedes_id": None,
                "target_id": target_id,
                "text": "",
                "reason": "EXPLICIT_COMPLIANCE_ERASE",
            }
        return {
            "action": "NONE",
            "original_action": "DELETE",
            "effective_write": False,
            "supersedes_id": None,
            "target_id": target_id,
            "text": "",
            "reason": "DESTRUCTIVE_DELETE_BLOCKED",
        }

    if raw_action == "NONE":
        return {
            "action": "NONE",
            "original_action": "NONE",
            "effective_write": False,
            "supersedes_id": None,
            "target_id": target_id,
            "text": text,
            "reason": "EXPLICIT_NOOP",
        }

    if not text:
        return {
            "action": "NONE",
            "original_action": raw_action,
            "effective_write": False,
            "supersedes_id": None,
            "target_id": target_id,
            "text": "",
            "reason": "EMPTY_CONTENT",
        }

    norm_cand = _normalize_comparable_text(text)
    duplicate = next(
        (
            r
            for r in active_records
            if _normalize_comparable_text(r.get("text") if r.get("text") is not None else r.get("content")) == norm_cand
        ),
        None,
    )
    if duplicate is not None:
        dup_id = duplicate.get("id")
        return {
            "action": "NONE",
            "original_action": raw_action,
            "effective_write": False,
            "supersedes_id": None,
            "target_id": str(dup_id if dup_id is not None else (target_id or "")),
            "text": text,
            "reason": "NOOP_IDENTICAL_TEXT",
        }

    if raw_action == "UPDATE":
        matched = next((r for r in active_records if str(r.get("id")) == target_id), None) if target_id else None
        if matched is None:
            return {
                "action": "ADD",
                "original_action": "UPDATE",
                "effective_write": True,
                "supersedes_id": None,
                "target_id": target_id,
                "text": text,
                "reason": "UPDATE_MISSING_TARGET_CONVERTED_TO_ADD",
            }
        matched_id = str(matched.get("id"))
        return {
            "action": "ADD",
            "original_action": "UPDATE",
            "effective_write": True,
            "supersedes_id": matched_id,
            "target_id": matched_id,
            "text": text,
            "reason": "APPEND_ONLY_SUPERSEDE",
        }

    sup_raw = prop.get("supersedes_id") or prop.get("supersedesId")
    return {
        "action": "ADD",
        "original_action": raw_action,
        "effective_write": True,
        "supersedes_id": str(sup_raw) if sup_raw is not None else None,
        "target_id": None,
        "text": text,
        "reason": "APPEND_ONLY_ADD",
    }


def audit_mutation_stream(
    decisions: Sequence[Mapping[str, Any]] | None = None,
    *,
    explicit_compliance_erase: bool = False,
) -> dict[str, Any]:
    """Audit a stream of controller write proposals to measure effective vs. no-op mutation rates."""
    items = list(decisions or [])
    store: list[dict[str, Any]] = []
    raw_counts: dict[str, int] = {"ADD": 0, "UPDATE": 0, "DELETE": 0, "NONE": 0}
    normalized_counts: dict[str, int] = {"ADD": 0, "NONE": 0, "COMPLIANCE_TOMBSTONE": 0}
    normalized_decisions: list[dict[str, Any]] = []

    effective_mutation_count = 0
    noop_or_malformed_count = 0
    next_id = 1

    for item in items:
        raw_action = str((item or {}).get("action") or "NONE").strip().upper()
        raw_counts[raw_action] = raw_counts.get(raw_action, 0) + 1

        norm = normalize_append_only_write_op(
            item,
            store,
            explicit_compliance_erase=explicit_compliance_erase,
        )
        normalized_decisions.append(norm)
        normalized_counts[norm["action"]] = normalized_counts.get(norm["action"], 0) + 1

        if raw_action in ("UPDATE", "DELETE"):
            had_valid_target = norm["reason"] in (
                "APPEND_ONLY_SUPERSEDE",
                "DESTRUCTIVE_DELETE_BLOCKED",
                "EXPLICIT_COMPLIANCE_ERASE",
            )
            if had_valid_target and (norm["reason"] == "APPEND_ONLY_SUPERSEDE" or raw_action == "DELETE"):
                effective_mutation_count += 1
            else:
                noop_or_malformed_count += 1

        if norm["action"] == "ADD":
            new_id = item.get("new_id") or item.get("newId")
            if new_id is None:
                if raw_action == "ADD" and item.get("id") is not None:
                    new_id = item.get("id")
                else:
                    new_id = f"mem_{next_id}"
                    next_id += 1
            store.append(
                {
                    "id": str(new_id),
                    "text": norm["text"],
                    "supersedes_id": norm["supersedes_id"],
                }
            )
        elif norm["action"] == "COMPLIANCE_TOMBSTONE" and norm["target_id"]:
            for rec in store:
                if rec["id"] == norm["target_id"]:
                    rec["deleted"] = True

    total = len(items)
    return {
        "total_decisions": total,
        "raw_counts": raw_counts,
        "normalized_counts": normalized_counts,
        "effective_add_count": normalized_counts["ADD"],
        "effective_mutation_count": effective_mutation_count,
        "effective_mutation_rate": round(effective_mutation_count / total, 6) if total > 0 else 0.0,
        "noop_or_malformed_mutation_count": noop_or_malformed_count,
        "normalized_decisions": normalized_decisions,
    }


def build_qwen_reranker_prompt(
    query: str,
    passage: str,
    *,
    instruction: str | None = None,
    system: str | None = None,
) -> dict[str, str]:
    """Format the Appendix G.1 Qwen3-Reranker binary relevance prompt (`"yes"` / `"no"`)."""
    inst = instruction or QWEN_RERANKER_TEMPLATE["instruction"]
    sys_msg = system or QWEN_RERANKER_TEMPLATE["system"]
    user_msg = f"<Instruct>: {inst}\n<Query>: {(query or '').strip()}\n<Document>: {(passage or '').strip()}"
    return {"system": sys_msg, "user": user_msg}


def should_narrow_candidate_sub_span(
    *,
    domain: str | None = None,
    allow_sub_span_narrowing: bool | None = None,
) -> bool:
    """
    Determine whether post-rerank sub-span sentence narrowing is safe for the target domain.
    Legal/contractual corpora (`domain in ('law', 'legal')`) preserve full clause windows by default.
    """
    if isinstance(allow_sub_span_narrowing, bool):
        return allow_sub_span_narrowing
    norm = (domain or "").strip().lower()
    return norm not in ("law", "legal")


def score_deterministic_cross_encoder(
    query: str,
    passage: str,
    dense_score: float = 0.0,
    *,
    domain: str | None = None,
) -> float:
    """
    Deterministic cross-encoder relevance scorer combining weighted content-word recall,
    ordered bigram overlap, identifier/number exact grounding, and dense cosine similarity.
    """
    is_legal = (domain or "").strip().lower() in ("law", "legal")
    base_q_tokens = [
        t for t in _ALNUM_RE.findall((query or "").lower()) if len(t) >= 2 and t not in _STOPWORDS
    ]
    if is_legal:
        non_boiler = [t for t in base_q_tokens if t not in LEGAL_BOILERPLATE_STOPWORDS]
        q_tokens = non_boiler if non_boiler else base_q_tokens
    else:
        q_tokens = base_q_tokens

    p_tokens = _ALNUM_RE.findall((passage or "").lower())
    p_set = set(p_tokens)

    clamped_dense = max(0.0, min(1.0, float(dense_score or 0.0)))
    if not q_tokens:
        return round(clamped_dense, 6)

    weighted_hits = 0.0
    total_weight = 0.0
    for tok in q_tokens:
        is_id_or_num = any(ch.isdigit() or ch == "_" for ch in tok) or len(tok) >= 7
        weight = 1.8 if is_id_or_num else 1.0
        total_weight += weight
        if tok in p_set:
            weighted_hits += weight
    lexical_recall = weighted_hits / total_weight if total_weight > 0 else 0.0

    total_bigrams = max(0, len(q_tokens) - 1)
    bigram_score = 0.0
    if total_bigrams > 0:
        p_bigrams = {
            f"{p_tokens[i]}_{p_tokens[i + 1]}"
            for i in range(len(p_tokens) - 1)
            if p_tokens[i] not in _STOPWORDS
            and p_tokens[i + 1] not in _STOPWORDS
            and (not is_legal or (p_tokens[i] not in LEGAL_BOILERPLATE_STOPWORDS and p_tokens[i + 1] not in LEGAL_BOILERPLATE_STOPWORDS))
        }
        hits = sum(
            1 for i in range(total_bigrams) if f"{q_tokens[i]}_{q_tokens[i + 1]}" in p_bigrams
        )
        bigram_score = hits / total_bigrams

    combined = (
        0.72 * clamped_dense + 0.20 * lexical_recall + 0.08 * bigram_score
        if is_legal
        else 0.52 * lexical_recall + 0.23 * bigram_score + 0.25 * clamped_dense
    )
    return round(max(0.0, min(1.0, combined)), 6)


def _score_via_logprob_endpoint(
    query: str,
    passage: str,
    *,
    endpoint: str,
    reranker_model: str,
    timeout_s: float = 4.0,
) -> tuple[float, str] | None:
    prompt = build_qwen_reranker_prompt(query, passage)
    base_url = endpoint.split(",")[0].strip().rstrip("/")
    url = base_url if base_url.endswith("/v1/chat/completions") else f"{base_url}/v1/chat/completions"
    payload = {
        "model": reranker_model,
        "messages": [
            {"role": "system", "content": prompt["system"]},
            {"role": "user", "content": prompt["user"]},
        ],
        "max_tokens": 1,
        "temperature": 0,
        "logprobs": True,
        "top_logprobs": 6,
        "keep_alive": -1,
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=max(0.25, timeout_s)) as resp:
        data = json.loads(resp.read().decode("utf-8"))

    first_choice = (data.get("choices") or [{}])[0]
    logprobs_obj = first_choice.get("logprobs") or {}
    content_lp = logprobs_obj.get("content")
    top_logprobs = None
    if isinstance(content_lp, list) and content_lp:
        top_logprobs = content_lp[0].get("top_logprobs")
    elif isinstance(logprobs_obj.get("top_logprobs"), list) and logprobs_obj["top_logprobs"]:
        top_logprobs = logprobs_obj["top_logprobs"][0]

    if isinstance(top_logprobs, list) and top_logprobs:
        calibrated = calibrate_choice_logprobs(top_logprobs, ("YES", "NO"))
        if calibrated["matched_logprobs"]:
            return (float(calibrated["probabilities"]["YES"]), "logprobs")

    raw_tok = str((first_choice.get("message") or {}).get("content") or first_choice.get("text") or "").strip().upper()
    if raw_tok.startswith("YES"):
        return (0.9, "token")
    if raw_tok.startswith("NO"):
        return (0.1, "token")
    return None


def rerank_candidate_windows(
    query: str,
    candidates: Sequence[Mapping[str, Any]],
    *,
    top_k: int = 15,
    domain: str | None = None,
    offline: bool = False,
    reranker_fn: Callable[[str, Mapping[str, Any]], Any] | None = None,
    endpoint: str | None = None,
    reranker_model: str | None = None,
    timeout_s: float = 4.0,
) -> list[dict[str, Any]]:
    """
    Rerank dense candidate windows (`D_q`, default 128) down to `S_q` (`Top-15`, Eq. 2).
    Supports custom `reranker_fn` (float score or `{"top_logprobs": [...]}`), live System-1
    `YES`/`NO` logprob scoring, and hermetic deterministic cross-encoder scoring.
    """
    if not candidates:
        return []

    limit_k = max(1, int(top_k) if top_k and top_k > 0 else 15)
    use_live = bool(
        reranker_fn is None
        and not offline
        and endpoint
        and os.environ.get("CI") != "true"
        and os.environ.get("MOCK_LLM") != "1"
    )
    resolved_model = reranker_model or os.environ.get("OLLAMA_FAST_MODEL") or "qwen2.5-coder:7b"

    scored: list[dict[str, Any]] = []
    for cand in candidates:
        item = dict(cand)
        dense_score = float(item.get("dense_score", item.get("denseScore", item.get("score", 0.0))) or 0.0)
        item["dense_score"] = dense_score

        if reranker_fn is not None:
            raw_out = reranker_fn(query, item)
            if isinstance(raw_out, (int, float)) and not isinstance(raw_out, bool):
                item["rerank_score"] = round(float(raw_out) + dense_score * 1e-4, 6)
                item["rerank_mode"] = "custom_fn"
                scored.append(item)
                continue
            if isinstance(raw_out, Mapping):
                top_lp = raw_out.get("top_logprobs") or raw_out.get("topLogprobs")
                if isinstance(top_lp, list):
                    calibrated = calibrate_choice_logprobs(top_lp, ("YES", "NO"))
                    prob_yes = float(calibrated["probabilities"]["YES"]) if calibrated["matched_logprobs"] else 0.5
                    item["rerank_score"] = round(prob_yes + dense_score * 1e-4, 6)
                    item["rerank_mode"] = "logprobs"
                    scored.append(item)
                    continue
                if isinstance(raw_out.get("score"), (int, float)):
                    item["rerank_score"] = round(float(raw_out["score"]) + dense_score * 1e-4, 6)
                    item["rerank_mode"] = "custom_fn"
                    scored.append(item)
                    continue

        if use_live and endpoint:
            try:
                live = _score_via_logprob_endpoint(
                    query,
                    str(item.get("text") or ""),
                    endpoint=endpoint,
                    reranker_model=resolved_model,
                    timeout_s=timeout_s,
                )
                if live is not None:
                    score_val, mode = live
                    item["rerank_score"] = round(score_val + dense_score * 1e-4, 6)
                    item["rerank_mode"] = mode
                    scored.append(item)
                    continue
            except Exception:
                pass

        det = score_deterministic_cross_encoder(
            query,
            str(item.get("text") or ""),
            dense_score,
            domain=domain,
        )
        item["rerank_score"] = det
        item["rerank_mode"] = "deterministic_cross_encoder"
        scored.append(item)

    scored.sort(
        key=lambda x: (
            -float(x.get("rerank_score", 0.0)),
            -float(x.get("dense_score", 0.0)),
            int(x.get("window_index", x.get("windowIndex", 0)) or 0),
        )
    )
    return scored[:limit_k]


def _build_expanded_entries(
    selected_windows: Sequence[Mapping[str, Any]],
    serialized_turns: Sequence[Mapping[str, Any]],
    deduplicate_turns: bool,
    chronological_order: bool,
) -> list[dict[str, Any]]:
    ordered_windows = (
        sorted(selected_windows, key=lambda w: int(w.get("window_index", w.get("windowIndex", 0)) or 0))
        if chronological_order
        else list(selected_windows)
    )

    if deduplicate_turns:
        seen: set[int] = set()
        collected: list[int] = []
        for win in ordered_windows:
            t_indices = win.get("turn_indices") if win.get("turn_indices") is not None else win.get("turnIndices", [])
            for t_idx in t_indices:
                if 0 <= t_idx < len(serialized_turns) and t_idx not in seen:
                    seen.add(t_idx)
                    collected.append(t_idx)
        if chronological_order:
            collected.sort()
        entries: list[dict[str, Any]] = []
        for t_idx in collected:
            turn = serialized_turns[t_idx]
            text = str(turn.get("serialized") or serialize_conversation_turn(dict(turn), t_idx)["serialized"])
            entries.append(
                {
                    "entry_id": str(turn.get("turn_id") or f"turn_{t_idx}"),
                    "source_type": "expanded_turn",
                    "turn_indices": [t_idx],
                    "order_key": t_idx,
                    "text": text,
                    "token_count": estimate_token_count(text),
                }
            )
        return entries

    entries = []
    for idx, win in enumerate(ordered_windows):
        raw_indices = win.get("turn_indices") if win.get("turn_indices") is not None else win.get("turnIndices", [])
        valid_indices = [t_idx for t_idx in raw_indices if 0 <= t_idx < len(serialized_turns)]
        if valid_indices:
            text = "\n".join(
                str(
                    serialized_turns[t_idx].get("serialized")
                    or serialize_conversation_turn(dict(serialized_turns[t_idx]), t_idx)["serialized"]
                )
                for t_idx in valid_indices
            )
            source_type = "expanded_window_turns"
        else:
            text = str(win.get("text") or "")
            source_type = "raw_window"

        win_id = str(win.get("window_id") or win.get("windowId") or f"win_{idx}")
        order_key = int(win.get("window_index", win.get("windowIndex", idx)) or idx)
        entries.append(
            {
                "entry_id": win_id,
                "source_type": source_type,
                "window_id": win_id,
                "turn_indices": valid_indices,
                "order_key": order_key,
                "text": text,
                "token_count": estimate_token_count(text),
            }
        )
    return entries


def _build_unexpanded_entries(
    selected_windows: Sequence[Mapping[str, Any]],
    chronological_order: bool,
) -> list[dict[str, Any]]:
    ordered_windows = (
        sorted(selected_windows, key=lambda w: int(w.get("window_index", w.get("windowIndex", 0)) or 0))
        if chronological_order
        else list(selected_windows)
    )
    entries: list[dict[str, Any]] = []
    for idx, win in enumerate(ordered_windows):
        text = str(win.get("text") or "")
        tok_count = win.get("token_count") if win.get("token_count") is not None else win.get("tokenCount")
        win_id = str(win.get("window_id") or win.get("windowId") or f"win_{idx}")
        t_indices = win.get("turn_indices") if win.get("turn_indices") is not None else win.get("turnIndices", [])
        order_key = int(win.get("window_index", win.get("windowIndex", idx)) or idx)
        entries.append(
            {
                "entry_id": win_id,
                "source_type": "raw_window",
                "window_id": win_id,
                "turn_indices": list(t_indices),
                "order_key": order_key,
                "text": text,
                "token_count": int(tok_count) if isinstance(tok_count, int) and tok_count > 0 else estimate_token_count(text),
            }
        )
    return entries


def assemble_reader_evidence(
    selected_windows: Sequence[Mapping[str, Any]],
    turns: Sequence[Mapping[str, Any] | str] | None = None,
    *,
    max_evidence_tokens: int = 5000,
    turn_expansion: bool = True,
    deduplicate_turns: bool = False,
    chronological_order: bool = True,
) -> dict[str, Any]:
    """
    Assemble reader context with Appendix A.4.4 graceful 5,000-token budget degradation:
    disables turn expansion first (`DISABLED_TURN_EXPANSION`) so all selected windows remain
    intact before falling back to complete-window prefix packing (`PREFIX_COMPLETE_WINDOWS`).
    """
    if not selected_windows:
        return {
            "context_text": "",
            "entries": [],
            "token_count": 0,
            "selected_window_count": 0,
            "retained_entry_count": 0,
            "turn_expansion_applied": False,
            "budget_policy_triggered": "NONE",
        }

    budget = max(32, int(max_evidence_tokens) if max_evidence_tokens and max_evidence_tokens > 0 else 5000)
    normalized_turns = [
        t if (isinstance(t, Mapping) and isinstance(t.get("serialized"), str)) else serialize_conversation_turn(t, idx)
        for idx, t in enumerate(turns or [])
    ]

    if turn_expansion and normalized_turns:
        expanded = _build_expanded_entries(
            selected_windows,
            normalized_turns,
            deduplicate_turns,
            chronological_order,
        )
        expanded_tokens = sum(e["token_count"] for e in expanded)
        if expanded_tokens <= budget:
            return {
                "context_text": "\n\n".join(e["text"] for e in expanded),
                "entries": expanded,
                "token_count": expanded_tokens,
                "selected_window_count": len(selected_windows),
                "retained_entry_count": len(expanded),
                "turn_expansion_applied": True,
                "budget_policy_triggered": "NONE",
            }

    unexpanded_by_rank = _build_unexpanded_entries(selected_windows, False)
    unexpanded_tokens = sum(e["token_count"] for e in unexpanded_by_rank)
    disabled_expansion = bool(turn_expansion and normalized_turns)

    if unexpanded_tokens <= budget:
        ordered = (
            _build_unexpanded_entries(selected_windows, True)
            if chronological_order
            else unexpanded_by_rank
        )
        return {
            "context_text": "\n\n".join(e["text"] for e in ordered),
            "entries": ordered,
            "token_count": unexpanded_tokens,
            "selected_window_count": len(selected_windows),
            "retained_entry_count": len(ordered),
            "turn_expansion_applied": False,
            "budget_policy_triggered": "DISABLED_TURN_EXPANSION" if disabled_expansion else "NONE",
        }

    packed_by_rank: list[dict[str, Any]] = []
    running_tokens = 0
    for entry in unexpanded_by_rank:
        if packed_by_rank and running_tokens + entry["token_count"] > budget:
            break
        packed_by_rank.append(entry)
        running_tokens += entry["token_count"]
        if running_tokens >= budget:
            break

    final_entries = (
        sorted(packed_by_rank, key=lambda e: int(e["order_key"]))
        if chronological_order
        else packed_by_rank
    )
    return {
        "context_text": "\n\n".join(e["text"] for e in final_entries),
        "entries": final_entries,
        "token_count": running_tokens,
        "selected_window_count": len(selected_windows),
        "retained_entry_count": len(final_entries),
        "turn_expansion_applied": False,
        "budget_policy_triggered": "PREFIX_COMPLETE_WINDOWS",
    }


def evaluate_coverage_and_utilization(records: Sequence[Mapping[str, Any]] | None = None) -> dict[str, Any]:
    """Compute Coverage (`C_hat`), Utilization (`U_hat`), and Uncovered Residual (Section 5.1 Eq. 3)."""
    items = list(records or [])
    if not items:
        return {
            "total_questions": 0,
            "covered_count": 0,
            "coverage": 0.0,
            "utilization": 0.0,
            "covered_contribution": 0.0,
            "uncovered_residual": 0.0,
            "overall_accuracy": 0.0,
            "decomposition_error": 0.0,
        }

    n = len(items)
    covered_count = 0
    covered_acc_sum = 0.0
    uncovered_acc_sum = 0.0
    total_acc_sum = 0.0

    for rec in items:
        covered = bool(rec.get("covered"))
        raw_acc = rec.get("accurate")
        y = (1.0 if raw_acc else 0.0) if isinstance(raw_acc, bool) else max(0.0, min(1.0, float(raw_acc or 0.0)))
        total_acc_sum += y
        if covered:
            covered_count += 1
            covered_acc_sum += y
        else:
            uncovered_acc_sum += y

    coverage = covered_count / n
    utilization = covered_acc_sum / covered_count if covered_count > 0 else 0.0
    covered_contribution = covered_acc_sum / n
    uncovered_residual = uncovered_acc_sum / n
    overall_accuracy = total_acc_sum / n
    decomp_error = abs(overall_accuracy - (coverage * utilization + uncovered_residual))

    return {
        "total_questions": n,
        "covered_count": covered_count,
        "coverage": round(coverage, 6),
        "utilization": round(utilization, 6),
        "covered_contribution": round(covered_contribution, 6),
        "uncovered_residual": round(uncovered_residual, 6),
        "overall_accuracy": round(overall_accuracy, 6),
        "decomposition_error": round(decomp_error, 12),
    }


def evaluate_conditional_path_retention(records: Sequence[Mapping[str, Any]] | None = None) -> dict[str, Any]:
    """Compute Result Coverage, Path Coverage, and `P(path | result)` (Section 5.3 Table 9)."""
    items = list(records or [])
    if not items:
        return {
            "total_questions": 0,
            "result_count": 0,
            "joint_path_and_result_count": 0,
            "result_coverage": 0.0,
            "path_coverage": 0.0,
            "conditional_path_given_result": 0.0,
        }

    n = len(items)
    result_count = 0
    path_count = 0
    joint_count = 0

    for rec in items:
        has_result = bool(rec.get("has_result") if "has_result" in rec else rec.get("hasResult"))
        has_path = bool(rec.get("has_path") if "has_path" in rec else rec.get("hasPath"))
        if has_result:
            result_count += 1
        if has_path:
            path_count += 1
        if has_result and has_path:
            joint_count += 1

    return {
        "total_questions": n,
        "result_count": result_count,
        "joint_path_and_result_count": joint_count,
        "result_coverage": round(result_count / n, 6),
        "path_coverage": round(path_count / n, 6),
        "conditional_path_given_result": round(joint_count / result_count, 6) if result_count > 0 else 0.0,
    }


class RawRagIndex:
    """
    Stateful source-preserving `Raw-RAG` index (`0` LLM ingestion calls) with incremental
    256/32-token hash-cached embeddings, causal phase cutoffs, `Top-128` dense recall,
    `Top-15` cross-encoder reranking, and `5,000`-token reader assembly.
    """

    def __init__(
        self,
        *,
        window_tokens: int = 256,
        overlap_tokens: int = 32,
        dense_candidate_k: int = 128,
        final_rerank_k: int = 15,
        max_evidence_tokens: int = 5000,
        turn_expansion: bool = True,
        deduplicate_turns: bool = False,
        chronological_order: bool = True,
        model: str = DEFAULT_EMBED_MODEL,
        dimensions: int = DEFAULT_EMBED_DIMS,
        ollama_url: str | None = None,
        domain: str = "memory",
        offline: bool = False,
        isolate_phases: bool = True,
        id_prefix: str = "raw_win",
        reranker_fn: Callable[[str, Mapping[str, Any]], Any] | None = None,
        reranker_endpoint: str | None = None,
        reranker_model: str | None = None,
    ) -> None:
        self.window_tokens = window_tokens
        self.overlap_tokens = overlap_tokens
        self.dense_candidate_k = dense_candidate_k
        self.final_rerank_k = final_rerank_k
        self.max_evidence_tokens = max_evidence_tokens
        self.turn_expansion = turn_expansion
        self.deduplicate_turns = deduplicate_turns
        self.chronological_order = chronological_order
        self.model = model
        self.dimensions = dimensions
        self.ollama_url = ollama_url
        self.domain = domain or "memory"
        self.offline = bool(offline or os.environ.get("MOCK_EMBEDDINGS") == "1")
        self.isolate_phases = isolate_phases
        self.id_prefix = id_prefix
        self.reranker_fn = reranker_fn
        self.reranker_endpoint = reranker_endpoint
        self.reranker_model = reranker_model

        self._raw_turns: list[dict[str, Any] | str] = []
        self._serialized_turns: list[dict[str, Any]] = []
        self._windows: list[dict[str, Any]] = []
        self._vector_by_hash: dict[str, list[float]] = {}
        self._sidecar_records: list[dict[str, Any]] = []
        self._mutation_log: list[dict[str, Any]] = []

    def _embed_missing_windows(self) -> None:
        missing = [w for w in self._windows if w["content_hash"] not in self._vector_by_hash]
        if not missing:
            return
        if self.offline:
            for win in missing:
                self._vector_by_hash[win["content_hash"]] = deterministic_token_vector(
                    win["text"], dim=self.dimensions
                )
            return

        vectors = embed_batch(
            [w["text"] for w in missing],
            model=self.model,
            ollama_url=self.ollama_url,
            dimensions=self.dimensions,
            mode="document",
            domain=self.domain,
        )
        for win, vec in zip(missing, vectors, strict=True):
            self._vector_by_hash[win["content_hash"]] = vec

    def _compute_query_vector(self, query_text: str) -> list[float] | None:
        if self.offline:
            return deterministic_token_vector(query_text, dim=self.dimensions)
        return embed_text(
            query_text,
            model=self.model,
            ollama_url=self.ollama_url,
            dimensions=self.dimensions,
            mode="query",
            domain=self.domain,
        )

    def add_turns(self, new_turns: Sequence[dict[str, Any] | str]) -> dict[str, Any]:
        """Append verbatim turns and incrementally embed only newly formed windows (`0` LLM calls)."""
        if not new_turns:
            return {
                "added_turns": 0,
                "total_turns": len(self._raw_turns),
                "total_windows": len(self._windows),
                "llm_ingestion_calls": 0,
            }
        self._raw_turns.extend(new_turns)
        chunked = chunk_conversation_windows(
            self._raw_turns,
            window_tokens=self.window_tokens,
            overlap_tokens=self.overlap_tokens,
            isolate_phases=self.isolate_phases,
            id_prefix=self.id_prefix,
        )
        self._serialized_turns = chunked["serialized_turns"]
        self._windows = chunked["windows"]
        self._embed_missing_windows()
        return {
            "added_turns": len(new_turns),
            "total_turns": len(self._raw_turns),
            "total_windows": len(self._windows),
            "llm_ingestion_calls": 0,
        }

    def apply_write_proposal(
        self,
        proposal: Mapping[str, Any],
        *,
        explicit_compliance_erase: bool = False,
    ) -> dict[str, Any]:
        """Apply a memory write proposal under the `ADD` / `NONE` non-destructive policy."""
        norm = normalize_append_only_write_op(
            proposal,
            self._sidecar_records,
            explicit_compliance_erase=explicit_compliance_erase,
        )
        self._mutation_log.append(norm)

        if norm["action"] == "ADD":
            raw_id = proposal.get("new_id") or proposal.get("newId")
            if raw_id is None:
                raw_id = (
                    proposal.get("id")
                    if str(proposal.get("action") or "").upper() == "ADD" and proposal.get("id") is not None
                    else f"rec_{len(self._sidecar_records) + 1}"
                )
            record_id = str(raw_id)
            entry = {
                "id": record_id,
                "text": norm["text"],
                "supersedes_id": norm["supersedes_id"],
                "date": proposal.get("date") or "unknown",
                "speaker": proposal.get("speaker") or "MemoryNote",
                "phase": proposal.get("phase"),
            }
            self._sidecar_records.append(entry)
            content = (
                f"[Supersedes {norm['supersedes_id']}] {entry['text']}"
                if norm["supersedes_id"]
                else entry["text"]
            )
            self.add_turns(
                [
                    {
                        "turn_id": record_id,
                        "date": entry["date"],
                        "speaker": entry["speaker"],
                        "content": content,
                        "phase": entry["phase"],
                    }
                ]
            )
        elif norm["action"] == "COMPLIANCE_TOMBSTONE" and norm["target_id"]:
            for rec in self._sidecar_records:
                if rec["id"] == norm["target_id"]:
                    rec["deleted"] = True

        return norm

    def retrieve(
        self,
        query: str,
        *,
        max_phase: int | None = None,
        max_timestamp: float | None = None,
        dense_candidate_k: int | None = None,
        final_rerank_k: int | None = None,
        max_evidence_tokens: int | None = None,
        turn_expansion: bool | None = None,
        deduplicate_turns: bool | None = None,
        chronological_order: bool | None = None,
        reranker_fn: Callable[[str, Mapping[str, Any]], Any] | None = None,
    ) -> dict[str, Any]:
        """Execute `Top-128` dense + `Top-15` rerank + `5,000`-token budget-safe turn assembly."""
        clean_query = (query or "").strip()
        if not clean_query or not self._windows:
            return {
                "query": clean_query,
                "context_text": "",
                "entries": [],
                "selected_windows": [],
                "dense_candidate_count": 0,
                "token_count": 0,
                "turn_expansion_applied": False,
                "budget_policy_triggered": "NONE",
                "llm_ingestion_calls": 0,
            }

        visible = [
            win
            for win in self._windows
            if (max_phase is None or win["max_phase"] is None or win["max_phase"] <= max_phase)
            and (max_timestamp is None or win["max_timestamp"] is None or win["max_timestamp"] <= max_timestamp)
        ]
        if not visible:
            return {
                "query": clean_query,
                "context_text": "",
                "entries": [],
                "selected_windows": [],
                "dense_candidate_count": 0,
                "token_count": 0,
                "turn_expansion_applied": False,
                "budget_policy_triggered": "NONE",
                "llm_ingestion_calls": 0,
            }

        q_vec = self._compute_query_vector(clean_query) or [0.0] * self.dimensions
        cand_k = max(1, int(dense_candidate_k or self.dense_candidate_k))
        rerank_k = max(1, int(final_rerank_k or self.final_rerank_k))

        dense_scored: list[dict[str, Any]] = []
        for win in visible:
            doc_vec = self._vector_by_hash.get(win["content_hash"], [])
            raw_cos = cosine_similarity(q_vec, doc_vec) if doc_vec else 0.0
            calibrated = (
                max(0.0, raw_cos)
                if self.offline
                else calibrate_query_similarity(raw_cos, model=self.model, query_vec=q_vec)
            )
            dense_scored.append(
                {
                    **win,
                    "raw_cosine": round(raw_cos, 6),
                    "dense_score": round(calibrated, 6),
                }
            )

        dense_scored.sort(key=lambda w: (-w["dense_score"], w["window_index"]))
        dense_pool = dense_scored[:cand_k]

        selected = rerank_candidate_windows(
            clean_query,
            dense_pool,
            top_k=rerank_k,
            domain=self.domain,
            offline=self.offline,
            reranker_fn=reranker_fn or self.reranker_fn,
            endpoint=self.reranker_endpoint,
            reranker_model=self.reranker_model,
        )
        assembled = assemble_reader_evidence(
            selected,
            self._serialized_turns,
            max_evidence_tokens=max_evidence_tokens if max_evidence_tokens is not None else self.max_evidence_tokens,
            turn_expansion=self.turn_expansion if turn_expansion is None else turn_expansion,
            deduplicate_turns=self.deduplicate_turns if deduplicate_turns is None else deduplicate_turns,
            chronological_order=self.chronological_order if chronological_order is None else chronological_order,
        )
        return {
            "query": clean_query,
            **assembled,
            "selected_windows": selected,
            "dense_candidate_count": len(dense_pool),
            "llm_ingestion_calls": 0,
        }

    def get_stats(self) -> dict[str, Any]:
        return {
            "turn_count": len(self._raw_turns),
            "window_count": len(self._windows),
            "cached_vectors": len(self._vector_by_hash),
            "sidecar_record_count": sum(1 for r in self._sidecar_records if not r.get("deleted")),
            "mutation_proposal_count": len(self._mutation_log),
            "llm_ingestion_calls": 0,
        }


def create_raw_rag_index(**kwargs: Any) -> RawRagIndex:
    """Factory helper mirroring `@krusch/toolkit/raw-rag` `createRawRagIndex`."""
    return RawRagIndex(**kwargs)
