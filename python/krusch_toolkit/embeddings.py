"""
krusch_toolkit.embeddings — Unified Sovereign Embedding Client (Python 3.12 Stdlib Only).

Mirrors `@krusch/toolkit/embeddings` with zero mandatory third-party dependencies so any
Python RAG, code-search, or agent service can import it immediately across local Ollama
endpoints and offline deterministic CI environments without optional third-party packages
installed.

Core Invariants:
- INV-01: Uses Ollama `POST /api/embed` (`input` batching, `truncate: True`, `keep_alive: -1`,
  and MRL `dimensions` when supported) with automatic HTTP 404 fallback to `/api/embeddings`.
- INV-03: Context-window-aware chunking (`1,100` chars / `150` overlap for 512-token `bge-large*`;
  `6,000` chars / `300` overlap for >=8,192-token `qwen3-embedding*` and `snowflake-arctic-embed2*`).
- INV-04: Asymmetric query vs. document instruction formatting across BGE, Snowflake Arctic,
  and Qwen3-Embedding (`general`, `code`, `law`, `biz`, `memory` domains).
- INV-05: Strict vector-space isolation in LRU cache keys `(expected_dim, backend_key, model,
  mode, domain, text)`, L2 normalization, and finite dimension validation.
"""

from collections import OrderedDict
import hashlib
import json
import math
import os
import re
from typing import Any
import urllib.error
import urllib.request

DEFAULT_EMBED_HOST = "http://127.0.0.1:11434"
DEFAULT_EMBED_MODEL = "snowflake-arctic-embed2"
DEFAULT_EMBED_DIMS = 1024

MODEL_PROFILES: dict[str, dict[str, Any]] = {
    "bge-large": {
        "family": "bge",
        "native_dimensions": 1024,
        "default_dimensions": 1024,
        "mrl_dimensions": False,
        "context_tokens": 512,
        "max_chars": 1100,
        "overlap_chars": 150,
    },
    "qwen3-embedding:0.6b": {
        "family": "qwen3",
        "native_dimensions": 1024,
        "default_dimensions": 1024,
        "mrl_dimensions": True,
        "context_tokens": 32768,
        "max_chars": 6000,
        "overlap_chars": 300,
    },
    "qwen3-embedding:4b": {
        "family": "qwen3",
        "native_dimensions": 2560,
        "default_dimensions": 1024,
        "mrl_dimensions": True,
        "context_tokens": 32768,
        "max_chars": 6000,
        "overlap_chars": 300,
    },
    "snowflake-arctic-embed2": {
        "family": "arctic",
        "native_dimensions": 1024,
        "default_dimensions": 1024,
        "mrl_dimensions": False,
        "context_tokens": 8192,
        "max_chars": 6000,
        "overlap_chars": 300,
    },
    "nomic-embed-text": {
        "family": "nomic",
        "native_dimensions": 768,
        "default_dimensions": 768,
        "mrl_dimensions": True,
        "context_tokens": 8192,
        "max_chars": 6000,
        "overlap_chars": 300,
    },
}

QWEN3_DOMAIN_TASKS: dict[str, str] = {
    "general": "Given a web search query, retrieve relevant passages that answer the query",
    "code": "Given a code search query, retrieve relevant code snippets, symbols, or technical documentation that match the query",
    "law": "Given a legal research query, retrieve controlling statutes, case law, and regulatory provisions that govern the query",
    "biz": "Given a business or contract query, retrieve relevant agreements, clauses, and corporate records that address the query",
    "memory": "Given an agent context query, retrieve relevant prior decisions, invariants, lessons, and session memories",
}

_BGE_QUERY_PREFIX = "Represent this sentence for searching relevant passages: "
_ARCTIC_QUERY_PREFIX = "query: "
_NOMIC_QUERY_PREFIX = "search_query: "
_TOKEN_RE = re.compile(r"[a-z0-9_]{2,}")

_EMBED_CACHE_MAX = 512
_EMBED_CACHE: OrderedDict[tuple[int, str, str, str, str, str], list[float]] = OrderedDict()

__all__ = [
    "DEFAULT_EMBED_HOST",
    "DEFAULT_EMBED_MODEL",
    "DEFAULT_EMBED_DIMS",
    "MODEL_PROFILES",
    "resolve_embedding_profile",
    "format_embedding_input",
    "l2_normalize",
    "is_zero_vector",
    "cosine_similarity",
    "calibrate_query_similarity",
    "calculate_centroid",
    "validate_vector_dimension",
    "deterministic_token_vector",
    "chunk_text_for_embedding",
    "clear_embedding_cache",
    "embed_batch",
    "embed_text",
    "embed_chunked_centroid",
]


def resolve_embedding_profile(model: str = DEFAULT_EMBED_MODEL) -> dict[str, Any]:
    """Resolve model metadata (dimensions, MRL support, context window, family) for a model tag."""
    raw = (model or DEFAULT_EMBED_MODEL).strip() or DEFAULT_EMBED_MODEL
    lower = raw.lower()

    if lower in MODEL_PROFILES:
        return {**MODEL_PROFILES[lower], "model": raw}

    base = lower[:-7] if lower.endswith(":latest") else lower
    if base in MODEL_PROFILES:
        return {**MODEL_PROFILES[base], "model": raw}

    if lower.startswith("bge-large") or "bge-large" in lower:
        return {**MODEL_PROFILES["bge-large"], "model": raw}
    if lower.startswith("qwen3-embedding:4b") or "qwen3-embedding-4b" in lower:
        return {**MODEL_PROFILES["qwen3-embedding:4b"], "model": raw}
    if lower.startswith("qwen3-embedding:0.6b") or "qwen3-embedding-0.6b" in lower:
        return {**MODEL_PROFILES["qwen3-embedding:0.6b"], "model": raw}
    if lower.startswith("qwen3-embedding:8b") or "qwen3-embedding-8b" in lower:
        return {
            "model": raw,
            "family": "qwen3",
            "native_dimensions": 4096,
            "default_dimensions": 1024,
            "mrl_dimensions": True,
            "context_tokens": 32768,
            "max_chars": 6000,
            "overlap_chars": 300,
        }
    if lower.startswith("qwen3-embedding") or "qwen3-embedding" in lower:
        return {**MODEL_PROFILES["qwen3-embedding:0.6b"], "model": raw}
    if lower.startswith("snowflake-arctic-embed2") or "arctic-embed2" in lower:
        return {**MODEL_PROFILES["snowflake-arctic-embed2"], "model": raw}
    if lower.startswith("nomic-embed-text") or "nomic-embed-text" in lower:
        return {**MODEL_PROFILES["nomic-embed-text"], "model": raw}

    return {
        "model": raw,
        "family": "generic",
        "native_dimensions": DEFAULT_EMBED_DIMS,
        "default_dimensions": DEFAULT_EMBED_DIMS,
        "mrl_dimensions": False,
        "context_tokens": 512,
        "max_chars": 1100,
        "overlap_chars": 150,
    }


def format_embedding_input(
    text: str,
    model: str = DEFAULT_EMBED_MODEL,
    mode: str = "document",
    domain: str = "general",
    instruction: str | None = None,
) -> str:
    """
    Format text for asymmetric retrieval (`INV-04`).
    - `mode == "document"`: returns `text` unchanged.
    - `mode == "query"`: applies model-specific instruction/query prefix.
    """
    if not isinstance(text, str):
        text = str(text or "")
    if not text:
        return ""

    norm_mode = (mode or "document").strip().lower()
    if norm_mode != "query":
        return text

    profile = resolve_embedding_profile(model)
    family = profile.get("family", "generic")
    custom_inst = instruction.strip() if isinstance(instruction, str) and instruction.strip() else None

    if family == "qwen3":
        norm_domain = (domain or "general").strip().lower()
        task = custom_inst or QWEN3_DOMAIN_TASKS.get(norm_domain, QWEN3_DOMAIN_TASKS["general"])
        return f"Instruct: {task}\nQuery:{text}"

    if custom_inst is not None:
        sep = "" if custom_inst.endswith((" ", "\n", ":")) else " "
        return f"{custom_inst}{sep}{text}"

    if family == "bge":
        return f"{_BGE_QUERY_PREFIX}{text}"
    if family == "arctic":
        return f"{_ARCTIC_QUERY_PREFIX}{text}"
    if family == "nomic":
        return f"{_NOMIC_QUERY_PREFIX}{text}"

    return text


def l2_normalize(vec: list[float]) -> list[float]:
    """L2-normalize a float vector; returns a zero vector of equal length if norm is zero."""
    if not vec:
        return []
    floats = [float(x) for x in vec]
    sq_sum = sum(x * x for x in floats)
    norm = math.sqrt(sq_sum)
    if norm == 0.0 or not math.isfinite(norm):
        return [0.0 for _ in floats]
    return [x / norm for x in floats]


def is_zero_vector(vec: list[float]) -> bool:
    """Return True if `vec` is empty or every component has magnitude <= 1e-12."""
    if not vec:
        return True
    return all(abs(float(x)) <= 1e-12 for x in vec)


def cosine_similarity(v1: list[float], v2: list[float]) -> float:
    """Compute cosine similarity in [-1.0, 1.0] between two equal-length float vectors."""
    if not v1 or not v2 or len(v1) != len(v2):
        return 0.0
    dot = 0.0
    n1 = 0.0
    n2 = 0.0
    for a, b in zip(v1, v2):
        fa = float(a)
        fb = float(b)
        dot += fa * fb
        n1 += fa * fa
        n2 += fb * fb
    if n1 == 0.0 or n2 == 0.0:
        return 0.0
    denom = math.sqrt(n1) * math.sqrt(n2)
    if denom == 0.0 or not math.isfinite(denom):
        return 0.0
    return max(-1.0, min(1.0, dot / denom))


def _is_sparse_synthetic_vector(vec: list[float] | None) -> bool:
    if not vec:
        return False
    check_len = min(len(vec), 64)
    non_zero = sum(1 for x in vec[:check_len] if abs(float(x)) > 1e-7)
    return non_zero < min(12, check_len)


def calibrate_query_similarity(
    raw_cosine: float,
    model: str = DEFAULT_EMBED_MODEL,
    query_vec: list[float] | None = None,
) -> float:
    """
    Calibrate raw query-to-document cosine similarity across embedding model geometries.
    Isotropic contrastive encoders (`snowflake-arctic-embed2`, `qwen3-embedding`) center
    unrelated pairs near ~0.00 and paraphrases around 0.36-0.55.
    """
    if not math.isfinite(raw_cosine) or raw_cosine <= 0.0:
        return 0.0
    if raw_cosine >= 1.0:
        return 1.0
    if query_vec is not None and _is_sparse_synthetic_vector(query_vec):
        return float(raw_cosine)
    profile = resolve_embedding_profile(model)
    if profile.get("family") in ("arctic", "qwen3"):
        if raw_cosine <= 0.12:
            return raw_cosine * 3.0
        if raw_cosine <= 0.38:
            return 0.36 + ((raw_cosine - 0.12) / 0.26) * 0.32
        if raw_cosine <= 0.60:
            return 0.68 + ((raw_cosine - 0.38) / 0.22) * 0.16
        return 0.84 + ((raw_cosine - 0.60) / 0.40) * 0.16
    return float(raw_cosine)


def calculate_centroid(vectors: list[list[float]]) -> list[float] | None:
    """Compute the L2-normalized centroid of one or more equal-dimension non-zero vectors."""
    if not vectors:
        return None
    valid = [v for v in vectors if isinstance(v, list) and len(v) > 0 and not is_zero_vector(v)]
    if not valid:
        return None

    dim = len(valid[0])
    summed = [0.0] * dim
    for vec in valid:
        if len(vec) != dim:
            raise ValueError(f"Centroid dimension mismatch: expected {dim}, got {len(vec)}")
        for idx, val in enumerate(vec):
            summed[idx] += float(val)

    centroid = l2_normalize(summed)
    return None if is_zero_vector(centroid) else centroid


def validate_vector_dimension(
    vec: list[float] | None,
    expected_dim: int = DEFAULT_EMBED_DIMS,
    context: str = "Embedding",
) -> list[float] | None:
    """Validate that `vec` matches `expected_dim` and contains finite numeric values."""
    if vec is None:
        return None
    if not isinstance(vec, list):
        raise ValueError(f"[{context}] Expected list of floats, got {type(vec).__name__}")
    if len(vec) != expected_dim:
        raise ValueError(f"[{context}] Dimension mismatch: expected {expected_dim}, got {len(vec)}")

    out: list[float] = []
    for x in vec:
        if isinstance(x, bool) or not isinstance(x, (int, float)):
            raise ValueError(f"[{context}] Vector contains non-numeric element: {type(x).__name__}")
        fx = float(x)
        if not math.isfinite(fx):
            raise ValueError(f"[{context}] Vector contains non-finite value: {fx}")
        out.append(fx)
    return out


def deterministic_token_vector(text: str, dim: int = DEFAULT_EMBED_DIMS) -> list[float]:
    """
    Compute a deterministic BLAKE2b signed feature-hashed unigram + bigram unit vector
    for offline CI and zero-daemon lexical/semantic similarity.
    """
    if dim <= 0:
        raise ValueError(f"dim must be positive, got {dim}")

    vec = [0.0] * dim
    tokens = _TOKEN_RE.findall((text or "").lower())
    if not tokens:
        raw = (text or "").strip()
        if not raw:
            vec[0] = 1.0
            return vec
        digest = hashlib.blake2b(raw.encode("utf-8"), digest_size=8).digest()
        idx = int.from_bytes(digest[:4], "little") % dim
        sign = 1.0 if (digest[4] & 1) == 0 else -1.0
        vec[idx] = sign
        return vec

    features = list(tokens)
    for i in range(len(tokens) - 1):
        features.append(f"{tokens[i]}_{tokens[i + 1]}")

    for feat in features:
        digest = hashlib.blake2b(feat.encode("utf-8"), digest_size=8).digest()
        idx = int.from_bytes(digest[:4], "little") % dim
        sign = 1.0 if (digest[4] & 1) == 0 else -1.0
        vec[idx] += sign

    norm = math.sqrt(sum(v * v for v in vec))
    if norm == 0.0:
        digest = hashlib.blake2b((text or "").encode("utf-8"), digest_size=4).digest()
        vec[int.from_bytes(digest, "little") % dim] = 1.0
        return vec
    return [v / norm for v in vec]


def chunk_text_for_embedding(
    text: str,
    model: str = DEFAULT_EMBED_MODEL,
    max_chars: int | None = None,
    overlap_chars: int | None = None,
    max_chunks: int = 32,
) -> list[str]:
    """
    Split `text` into bounded overlapping windows calibrated to the model's token budget (`INV-03`).
    """
    if not isinstance(text, str) or not text.strip():
        return []

    profile = resolve_embedding_profile(model)
    resolved_max = int(max_chars) if max_chars is not None and max_chars > 0 else int(profile["max_chars"])
    raw_overlap = int(overlap_chars) if overlap_chars is not None and overlap_chars >= 0 else int(profile["overlap_chars"])
    resolved_overlap = min(raw_overlap, max(0, resolved_max // 2))
    resolved_max_chunks = max(1, int(max_chunks))

    if len(text) <= resolved_max:
        return [text]

    chunks: list[str] = []
    start = 0
    text_len = len(text)
    min_break_offset = max(1, int(resolved_max * 0.75))

    while start < text_len and len(chunks) < resolved_max_chunks:
        end = min(text_len, start + resolved_max)
        if end < text_len:
            search_from = start + min_break_offset
            nl_pos = text.rfind("\n", search_from, end)
            sp_pos = text.rfind(" ", search_from, end)
            split_at = nl_pos if nl_pos != -1 else sp_pos
            if split_at != -1 and split_at > start:
                end = split_at + 1

        piece = text[start:end].strip()
        if piece:
            chunks.append(piece)

        if end >= text_len:
            break
        start = max(start + 1, end - resolved_overlap)

    return chunks


def clear_embedding_cache() -> None:
    """Clear the bounded in-memory `embed_text` LRU cache."""
    _EMBED_CACHE.clear()


def _normalize_ollama_base_url(raw_url: str) -> str:
    base = raw_url.split(",")[0].strip().rstrip("/")
    for suffix in ("/api/embeddings", "/api/embed"):
        if base.endswith(suffix):
            base = base[: -len(suffix)].rstrip("/")
            break
    return base or DEFAULT_EMBED_HOST


def _resolve_runtime_options(
    model: str | None,
    ollama_url: str | None,
    dimensions: int | None,
    backend: str | None,
) -> tuple[str, dict[str, Any], str, int, bool]:
    resolved_model = (
        model
        or os.getenv("EMBED_MODEL")
        or os.getenv("EMBEDDING_MODEL")
        or DEFAULT_EMBED_MODEL
    ).strip()
    profile = resolve_embedding_profile(resolved_model)

    raw_url = (
        ollama_url
        or os.getenv("OLLAMA_EMBED_HOST")
        or os.getenv("OLLAMA_URL")
        or DEFAULT_EMBED_HOST
    )
    resolved_url = _normalize_ollama_base_url(raw_url)

    env_dims = os.getenv("EMBED_DIMS")
    if dimensions is not None:
        expected_dim = int(dimensions)
    elif env_dims and env_dims.strip():
        expected_dim = int(env_dims.strip())
    else:
        expected_dim = int(profile["default_dimensions"])

    if expected_dim <= 0:
        raise ValueError(f"Expected positive embedding dimensions, got {expected_dim}")

    is_deterministic = (
        (backend or "").strip().lower() == "deterministic"
        or os.getenv("MOCK_EMBEDDINGS") == "1"
    )
    return resolved_model, profile, resolved_url, expected_dim, is_deterministic


def _post_json(url: str, payload: dict[str, Any], timeout: float) -> dict[str, Any]:
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
        decoded = raw.decode("utf-8") if isinstance(raw, (bytes, bytearray)) else str(raw)
        data = json.loads(decoded)
        if not isinstance(data, dict):
            raise ValueError(f"Expected JSON object from {url}, got {type(data).__name__}")
        return data


def embed_batch(
    texts: list[str],
    model: str | None = None,
    ollama_url: str | None = None,
    dimensions: int | None = None,
    mode: str = "document",
    domain: str = "general",
    keep_alive: Any = -1,
    timeout: float = 30.0,
    batch_size: int = 32,
    backend: str | None = None,
) -> list[list[float]]:
    """
    Embed a batch of texts via Ollama `POST /api/embed` (`INV-01`) with HTTP 404 fallback
    to legacy `/api/embeddings`, MRL `dimensions` projection, L2 normalization, and
    strict dimension validation.
    """
    if not texts:
        return []

    resolved_model, profile, resolved_url, expected_dim, is_deterministic = _resolve_runtime_options(
        model=model,
        ollama_url=ollama_url,
        dimensions=dimensions,
        backend=backend,
    )

    if is_deterministic:
        return [deterministic_token_vector(t, dim=expected_dim) for t in texts]

    eff_batch_size = max(1, int(batch_size))
    results: list[list[float]] = []

    for start in range(0, len(texts), eff_batch_size):
        slice_texts = texts[start : start + eff_batch_size]
        formatted_batch = [
            format_embedding_input(t, model=resolved_model, mode=mode, domain=domain)
            for t in slice_texts
        ]

        payload: dict[str, Any] = {
            "model": resolved_model,
            "input": formatted_batch,
            "truncate": True,
            "keep_alive": keep_alive,
        }
        if profile.get("mrl_dimensions"):
            payload["dimensions"] = expected_dim

        raw_vectors: list[Any]
        try:
            data = _post_json(f"{resolved_url}/api/embed", payload, timeout=timeout)
            if isinstance(data.get("embeddings"), list):
                raw_vectors = data["embeddings"]
            elif len(formatted_batch) == 1 and isinstance(data.get("embedding"), list):
                raw_vectors = [data["embedding"]]
            else:
                raise ValueError(f"Invalid /api/embed response from {resolved_url}: missing 'embeddings'")
        except urllib.error.HTTPError as err:
            if err.code != 404:
                raise
            try:
                err.close()
            except Exception:
                pass
            raw_vectors = []
            for item in formatted_batch:
                legacy_payload: dict[str, Any] = {
                    "model": resolved_model,
                    "prompt": item,
                    "truncate": True,
                    "keep_alive": keep_alive,
                }
                legacy_data = _post_json(
                    f"{resolved_url}/api/embeddings",
                    legacy_payload,
                    timeout=timeout,
                )
                vec = legacy_data.get("embedding")
                if not isinstance(vec, list):
                    embeddings_list = legacy_data.get("embeddings")
                    vec = embeddings_list[0] if isinstance(embeddings_list, list) and embeddings_list else None
                if not isinstance(vec, list):
                    raise ValueError(
                        f"Invalid /api/embeddings response from {resolved_url}: missing 'embedding'"
                    )
                raw_vectors.append(vec)

        if len(raw_vectors) != len(formatted_batch):
            raise ValueError(
                f"[Ollama({resolved_model})] Batch length mismatch: expected {len(formatted_batch)}, got {len(raw_vectors)}"
            )

        for raw_vec in raw_vectors:
            validated = validate_vector_dimension(
                raw_vec,
                expected_dim=expected_dim,
                context=f"Ollama({resolved_model})",
            )
            assert validated is not None
            results.append(l2_normalize(validated))

    return results


def embed_text(
    text: str,
    model: str | None = None,
    ollama_url: str | None = None,
    dimensions: int | None = None,
    mode: str = "document",
    domain: str = "general",
    keep_alive: Any = -1,
    timeout: float = 15.0,
    backend: str | None = None,
) -> list[float] | None:
    """
    Embed a single text string with bounded LRU caching isolated by
    `(expected_dim, backend_key, model, mode, domain, text)` (`INV-05`).
    Returns `None` on empty or whitespace-only text.
    """
    if not isinstance(text, str) or not text.strip():
        return None

    resolved_model, _profile, resolved_url, expected_dim, is_deterministic = _resolve_runtime_options(
        model=model,
        ollama_url=ollama_url,
        dimensions=dimensions,
        backend=backend,
    )
    norm_mode = (mode or "document").strip().lower()
    norm_domain = (domain or "general").strip().lower()
    backend_key = "deterministic" if is_deterministic else f"ollama:{resolved_url}"

    cache_key = (expected_dim, backend_key, resolved_model, norm_mode, norm_domain, text)
    if cache_key in _EMBED_CACHE:
        _EMBED_CACHE.move_to_end(cache_key)
        return list(_EMBED_CACHE[cache_key])

    vecs = embed_batch(
        [text],
        model=resolved_model,
        ollama_url=resolved_url,
        dimensions=expected_dim,
        mode=norm_mode,
        domain=norm_domain,
        keep_alive=keep_alive,
        timeout=timeout,
        batch_size=1,
        backend="deterministic" if is_deterministic else backend,
    )
    if not vecs:
        return None

    vec = vecs[0]
    if len(_EMBED_CACHE) >= _EMBED_CACHE_MAX:
        _EMBED_CACHE.popitem(last=False)
    _EMBED_CACHE[cache_key] = list(vec)
    return vec


def embed_chunked_centroid(
    text: str,
    model: str | None = None,
    ollama_url: str | None = None,
    dimensions: int | None = None,
    domain: str = "general",
    keep_alive: Any = -1,
    timeout: float = 30.0,
    backend: str | None = None,
) -> list[float] | None:
    """
    Chunk long documents within the target model's safe token window (`INV-03`),
    embed all chunks via batched `/api/embed`, and return their L2-normalized centroid.
    """
    if not isinstance(text, str) or not text.strip():
        return None

    resolved_model, _profile, resolved_url, expected_dim, is_deterministic = _resolve_runtime_options(
        model=model,
        ollama_url=ollama_url,
        dimensions=dimensions,
        backend=backend,
    )

    chunks = chunk_text_for_embedding(text, model=resolved_model)
    if not chunks:
        return None

    if len(chunks) == 1:
        return embed_text(
            chunks[0],
            model=resolved_model,
            ollama_url=resolved_url,
            dimensions=expected_dim,
            mode="document",
            domain=domain,
            keep_alive=keep_alive,
            timeout=timeout,
            backend="deterministic" if is_deterministic else backend,
        )

    vectors = embed_batch(
        chunks,
        model=resolved_model,
        ollama_url=resolved_url,
        dimensions=expected_dim,
        mode="document",
        domain=domain,
        keep_alive=keep_alive,
        timeout=timeout,
        backend="deterministic" if is_deterministic else backend,
    )
    return calculate_centroid(vectors)
