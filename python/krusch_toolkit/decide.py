"""
krusch_toolkit.decide — Sovereign System 1 Decision Primitive (Python Parity).

Provides zero-dependency, non-autoregressive single-token classification ("Context + Question -> Choice")
over local Ollama / vLLM endpoints with log-sum-exp variant marginalization, softmax calibration,
bounded LRU caching, and sub-millisecond deterministic fallback for offline CI environments (krusch-law,
krusch-authority-packs, krusch-biz).
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import time
import urllib.request
from collections import OrderedDict
from typing import Any, Callable, Dict, List, Optional, Sequence, Union

_STOPWORDS = frozenset({
    "does", "this", "that", "with", "from", "have", "what", "when", "where", "should", "which", "under"
})
_NEGATION_RE = re.compile(r"\b(not|never|prohibited|void|invalid|missing|false)\b", re.IGNORECASE)


def calibrate_choice_logprobs(
    top_logprobs: Optional[Sequence[Dict[str, Any]]] = None,
    choices: Sequence[str] = ("YES", "NO"),
) -> Dict[str, Any]:
    """
    Numerically stable softmax over log-probabilities for a fixed set of choices.
    Marginalizes across casing/whitespace surface token variants ("YES", "Yes", " YES") via log-sum-exp.
    """
    valid_choices = [str(c) for c in choices] if choices and len(choices) >= 2 else ["YES", "NO"]
    logprob_map: Dict[str, float] = {}

    if top_logprobs:
        for entry in top_logprobs:
            if not isinstance(entry, dict):
                continue
            token = entry.get("token")
            logprob = entry.get("logprob")
            if not isinstance(token, str) or not isinstance(logprob, (int, float)):
                continue
            clean_token = re.sub(r"[^A-Z0-9_-]", "", token.strip().upper())
            if not clean_token:
                continue

            for c in valid_choices:
                norm_choice = re.sub(r"[^A-Z0-9_-]", "", c.strip().upper())
                if (
                    clean_token == norm_choice
                    or norm_choice.startswith(clean_token)
                    or clean_token.startswith(norm_choice)
                ):
                    prev = logprob_map.get(c)
                    if prev is None:
                        logprob_map[c] = float(logprob)
                    else:
                        m = max(prev, float(logprob))
                        logprob_map[c] = m + math.log(math.exp(prev - m) + math.exp(float(logprob) - m))

    if not logprob_map:
        uniform = round(1.0 / len(valid_choices), 4)
        return {
            "choice": valid_choices[0],
            "confidence": 0.0,
            "probabilities": {c: uniform for c in valid_choices},
            "matched_logprobs": False,
        }

    raw_logits = [logprob_map.get(c, -12.0) for c in valid_choices]
    max_logit = max(raw_logits)
    exps = [math.exp(l - max_logit) for l in raw_logits]
    sum_exp = sum(exps) or 1.0

    probabilities: Dict[str, float] = {}
    best_idx = 0
    best_prob = -1.0
    for i, c in enumerate(valid_choices):
        p = exps[i] / sum_exp
        probabilities[c] = round(p, 4)
        if p > best_prob:
            best_prob = p
            best_idx = i

    return {
        "choice": valid_choices[best_idx],
        "confidence": round(best_prob, 4),
        "probabilities": probabilities,
        "matched_logprobs": True,
    }


def evaluate_deterministic_decision(
    state: Union[str, Dict[str, Any], None],
    question: str,
    choices: Sequence[str] = ("YES", "NO"),
) -> Dict[str, Any]:
    """
    Sub-millisecond deterministic lexical/negation fallback when LLM is unreachable or CI=true / MOCK_LLM=1.
    """
    valid_choices = [str(c) for c in choices] if choices and len(choices) >= 2 else ["YES", "NO"]
    state_str = state if isinstance(state, str) else json.dumps(state or {}, sort_keys=True)
    combined = f"{state_str}\n{question or ''}".lower()

    scores: List[float] = []
    for choice in valid_choices:
        lower_choice = choice.lower()
        if lower_choice in ("yes", "true"):
            q_tokens = [
                t for t in re.sub(r"[^a-z0-9\s]", " ", (question or "").lower()).split()
                if len(t) > 3 and t not in _STOPWORDS
            ]
            if not q_tokens:
                scores.append(0.5)
                continue
            lower_state = state_str.lower()
            hits = sum(1 for t in q_tokens if t in lower_state)
            has_negation = bool(_NEGATION_RE.search(lower_state)) and not bool(_NEGATION_RE.search(question or ""))
            ratio = hits / len(q_tokens)
            scores.append(max(0.1, ratio - 0.45) if has_negation else ratio)
        elif lower_choice in ("no", "false"):
            scores.append(0.45)
        else:
            tokens = [t for t in re.split(r"[^a-z0-9]+", lower_choice) if len(t) >= 2]
            match_score = 0.1 + sum(0.6 for t in tokens if t in combined)
            scores.append(match_score)

    max_score = max(scores)
    exps = [math.exp((s - max_score) * 3.0) for s in scores]
    sum_exp = sum(exps) or 1.0

    probabilities: Dict[str, float] = {}
    best_idx = 0
    best_prob = -1.0
    for i, c in enumerate(valid_choices):
        p = exps[i] / sum_exp
        probabilities[c] = round(p, 4)
        if p > best_prob:
            best_prob = p
            best_idx = i

    return {
        "choice": valid_choices[best_idx],
        "confidence": round(best_prob, 4),
        "probabilities": probabilities,
    }


def decide(
    state: Union[str, Dict[str, Any], None],
    question: str,
    choices: Sequence[str] = ("YES", "NO"),
    model: Optional[str] = None,
    endpoint: Optional[str] = None,
    timeout_s: float = 2.5,
    http_post: Optional[Callable[[str, Dict[str, Any], float], Dict[str, Any]]] = None,
    fallback: bool = False,
) -> Dict[str, Any]:
    """
    Executes a single-token System 1 decision against an OpenAI-compatible vLLM or Ollama endpoint.

    Raises:
        ValueError: If `question` is not a non-empty string, `state` is not None/str/dict,
            or `choices` is not a sequence of at least two non-empty strings.
    """
    t0 = time.perf_counter()
    if not question or not isinstance(question, str):
        raise ValueError("decide() requires a non-empty question string")
    if state is not None and not isinstance(state, (str, dict)):
        raise ValueError("state must be None, a string, or a dict")
    if not choices or not isinstance(choices, (list, tuple)) or len(choices) < 2:
        raise ValueError("choices must be a non-empty sequence")
    if any(not isinstance(c, str) or not c.strip() for c in choices):
        raise ValueError("each choice must be a non-empty string")

    valid_choices = [str(c) for c in choices]
    target_model = model or os.environ.get("OLLAMA_FAST_MODEL", "qwen2.5-coder:7b")
    target_endpoint = endpoint or os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434")

    # CI-only deterministic override flag (MOCK_LLM_FORCE_DETERMINISTIC=1) or explicit fallback=True
    if fallback or os.environ.get("MOCK_LLM_FORCE_DETERMINISTIC") == "1":
        det = evaluate_deterministic_decision(state, question, valid_choices)
        return {
            **det,
            "latency_ms": round((time.perf_counter() - t0) * 1000, 2),
            "mode": "deterministic_fallback",
        }

    state_text = state if isinstance(state, str) else json.dumps(state or {}, sort_keys=True)
    system_prompt = f"Respond with ONLY one word from the allowed choices: {', '.join(valid_choices)}."
    user_prompt = f"Context: {state_text}\nQuestion: {question}\nChoices: {', '.join(valid_choices)}\nAnswer:"

    base_url = target_endpoint.split(",")[0].strip().rstrip("/")
    url = base_url if base_url.endswith("/v1/chat/completions") else f"{base_url}/v1/chat/completions"

    payload = {
        "model": target_model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "max_tokens": 1,
        "temperature": 0,
        "logprobs": True,
        "top_logprobs": min(10, max(5, len(valid_choices) * 2)),
        "keep_alive": -1,
    }

    try:
        if http_post is not None:
            data = http_post(url, payload, timeout_s)
        elif os.environ.get("MOCK_LLM") == "1":
            raise ConnectionError("MOCK_LLM=1 without http_post")
        else:
            req = urllib.request.Request(
                url,
                data=json.dumps(payload).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=timeout_s) as resp:
                data = json.loads(resp.read().decode("utf-8"))

        first_choice = (data.get("choices") or [{}])[0]
        logprobs_obj = first_choice.get("logprobs") or {}
        content_items = logprobs_obj.get("content") or []
        top_logprobs = (
            content_items[0].get("top_logprobs")
            if content_items and isinstance(content_items[0], dict)
            else (logprobs_obj.get("top_logprobs") or [None])[0]
        )

        if isinstance(top_logprobs, list) and top_logprobs:
            calibrated = calibrate_choice_logprobs(top_logprobs, valid_choices)
            if calibrated["matched_logprobs"]:
                return {
                    "choice": calibrated["choice"],
                    "confidence": calibrated["confidence"],
                    "probabilities": calibrated["probabilities"],
                    "latency_ms": round((time.perf_counter() - t0) * 1000, 2),
                    "mode": "logprobs",
                }

        raw_text = str((first_choice.get("message") or {}).get("content") or first_choice.get("text") or "").strip().upper()
        matched = next((c for c in valid_choices if raw_text == c.upper() or raw_text.startswith(c.upper())), None)
        if matched is not None:
            rem = round(0.1 / max(1, len(valid_choices) - 1), 4)
            probabilities = {c: (0.9 if c == matched else rem) for c in valid_choices}
            return {
                "choice": matched,
                "confidence": 0.9,
                "probabilities": probabilities,
                "latency_ms": round((time.perf_counter() - t0) * 1000, 2),
                "mode": "token",
            }
    except Exception:
        pass

    det = evaluate_deterministic_decision(state, question, valid_choices)
    return {
        **det,
        "latency_ms": round((time.perf_counter() - t0) * 1000, 2),
        "mode": "deterministic_fallback",
    }


def decide_batch(
    state: Union[str, Dict[str, Any], None],
    questions: Sequence[Union[str, Dict[str, Any]]],
    **kwargs: Any,
) -> List[Dict[str, Any]]:
    """
    Evaluates a sequence of System 1 questions against a shared state context.
    """
    results: List[Dict[str, Any]] = []
    for q in questions:
        if isinstance(q, str):
            res = decide(state=state, question=q, **kwargs)
            results.append({"question": q, **res})
        elif isinstance(q, dict):
            q_text = q["question"]
            q_choices = q.get("choices") or kwargs.get("choices", ("YES", "NO"))
            call_kwargs = {k: v for k, v in kwargs.items() if k != "choices"}
            res = decide(state=state, question=q_text, choices=q_choices, **call_kwargs)
            results.append({"question": q_text, **res})
    return results


class System1Decider:
    """
    Stateful System 1 decider with bounded SHA-256 LRU caching for O(1) sub-millisecond repeat checks.
    """

    def __init__(self, max_cache_size: int = 256, **default_kwargs: Any) -> None:
        self.max_cache_size = max_cache_size
        self.default_kwargs = default_kwargs
        self._cache: OrderedDict[str, Dict[str, Any]] = OrderedDict()

    def _make_key(self, state: Any, question: str, choices: Sequence[str]) -> str:
        raw = json.dumps(
            {"state": state, "question": question, "choices": list(choices)},
            sort_keys=True,
            default=str,
        )
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()

    def decide(
        self,
        state: Union[str, Dict[str, Any], None],
        question: str,
        choices: Optional[Sequence[str]] = None,
        **kwargs: Any,
    ) -> Dict[str, Any]:
        merged = {**self.default_kwargs, **kwargs}
        resolved_choices = choices or merged.pop("choices", ("YES", "NO"))
        key = self._make_key(state, question, resolved_choices)
        if key in self._cache:
            self._cache.move_to_end(key)
            hit = dict(self._cache[key])
            hit["cached"] = True
            hit["latency_ms"] = 0.0
            return hit

        res = decide(state=state, question=question, choices=resolved_choices, **merged)
        if len(self._cache) >= self.max_cache_size:
            self._cache.popitem(last=False)
        self._cache[key] = dict(res)
        out = dict(res)
        out["cached"] = False
        return out

    def clear_cache(self) -> None:
        self._cache.clear()
