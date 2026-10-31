import io
import json
import math
import os
import unittest
from unittest.mock import patch
import urllib.error

from krusch_toolkit.embeddings import (
    DEFAULT_EMBED_DIMS,
    DEFAULT_EMBED_HOST,
    DEFAULT_EMBED_MODEL,
    MODEL_PROFILES,
    calculate_centroid,
    calibrate_query_similarity,
    chunk_text_for_embedding,
    clear_embedding_cache,
    cosine_similarity,
    deterministic_token_vector,
    embed_batch,
    embed_chunked_centroid,
    embed_text,
    format_embedding_input,
    is_zero_vector,
    l2_normalize,
    resolve_embedding_profile,
    validate_vector_dimension,
)


class _MockHTTPResponse:
    def __init__(self, payload: dict, status: int = 200) -> None:
        self._raw = json.dumps(payload).encode("utf-8")
        self.status = status

    def read(self) -> bytes:
        return self._raw

    def __enter__(self) -> "_MockHTTPResponse":
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> bool:
        return False


def _basis_vec(dim: int, index: int, scale: float = 3.0) -> list[float]:
    vec = [0.0] * dim
    vec[index % dim] = scale
    return vec


class TestKruschToolkitEmbeddings(unittest.TestCase):
    def setUp(self) -> None:
        clear_embedding_cache()
        self._env_backup = dict(os.environ)
        for key in (
            "MOCK_EMBEDDINGS",
            "EMBED_MODEL",
            "EMBEDDING_MODEL",
            "OLLAMA_EMBED_HOST",
            "OLLAMA_URL",
            "EMBED_DIMS",
        ):
            os.environ.pop(key, None)

    def tearDown(self) -> None:
        clear_embedding_cache()
        os.environ.clear()
        os.environ.update(self._env_backup)

    def test_constants_and_model_profiles(self) -> None:
        self.assertEqual(DEFAULT_EMBED_HOST, "http://127.0.0.1:11434")
        self.assertEqual(DEFAULT_EMBED_MODEL, "snowflake-arctic-embed2")
        self.assertEqual(DEFAULT_EMBED_DIMS, 1024)

        for required in (
            "bge-large",
            "qwen3-embedding:0.6b",
            "qwen3-embedding:4b",
            "snowflake-arctic-embed2",
            "nomic-embed-text",
        ):
            self.assertIn(required, MODEL_PROFILES)

        qwen4b = resolve_embedding_profile("qwen3-embedding:4b")
        self.assertTrue(qwen4b["mrl_dimensions"])
        self.assertEqual(qwen4b["native_dimensions"], 2560)
        self.assertEqual(qwen4b["default_dimensions"], 1024)
        self.assertGreaterEqual(qwen4b["max_chars"], 6000)

        bge = resolve_embedding_profile("bge-large:latest")
        self.assertFalse(bge["mrl_dimensions"])
        self.assertEqual(bge["default_dimensions"], 1024)
        self.assertLessEqual(bge["max_chars"], 1100)

    def test_asymmetric_query_vs_document_formatting(self) -> None:
        raw = "California Civil Code section 1950.5 security deposit"

        # Document mode NEVER prefixes across any model family (INV-04)
        for mdl in ("bge-large", "qwen3-embedding:4b", "snowflake-arctic-embed2", "nomic-embed-text"):
            self.assertEqual(format_embedding_input(raw, model=mdl, mode="document"), raw)

        # BGE query prefix
        bge_q = format_embedding_input(raw, model="bge-large:latest", mode="query")
        self.assertEqual(bge_q, f"Represent this sentence for searching relevant passages: {raw}")

        # Snowflake Arctic query prefix
        arctic_q = format_embedding_input(raw, model="snowflake-arctic-embed2", mode="query")
        self.assertEqual(arctic_q, f"query: {raw}")

        # Qwen3 domain-aware query instructions
        seen_tasks = set()
        for dom in ("general", "code", "law", "biz", "memory"):
            qwen_q = format_embedding_input(raw, model="qwen3-embedding:4b", mode="query", domain=dom)
            self.assertTrue(qwen_q.startswith("Instruct: "))
            self.assertTrue(qwen_q.endswith(f"\nQuery:{raw}"))
            seen_tasks.add(qwen_q)
        self.assertEqual(len(seen_tasks), 5)

        # Custom instruction override
        custom_q = format_embedding_input(
            raw,
            model="qwen3-embedding:0.6b",
            mode="query",
            instruction="Retrieve exact statutory deadlines",
        )
        self.assertEqual(custom_q, f"Instruct: Retrieve exact statutory deadlines\nQuery:{raw}")

    def test_vector_math_and_dimension_validation(self) -> None:
        normed = l2_normalize([3.0, 4.0])
        self.assertAlmostEqual(normed[0], 0.6, places=6)
        self.assertAlmostEqual(normed[1], 0.8, places=6)

        self.assertEqual(l2_normalize([0.0, 0.0, 0.0]), [0.0, 0.0, 0.0])
        self.assertTrue(is_zero_vector([0.0, 0.0]))
        self.assertTrue(is_zero_vector([]))
        self.assertFalse(is_zero_vector([0.0, 1e-4]))

        self.assertAlmostEqual(cosine_similarity([1.0, 0.0], [1.0, 0.0]), 1.0, places=6)
        self.assertAlmostEqual(cosine_similarity([1.0, 0.0], [0.0, 1.0]), 0.0, places=6)
        self.assertAlmostEqual(cosine_similarity([1.0, 0.0], [-1.0, 0.0]), -1.0, places=6)
        self.assertEqual(cosine_similarity([1.0, 0.0], [1.0, 0.0, 0.0]), 0.0)

        centroid = calculate_centroid([[2.0, 0.0], [0.0, 2.0], [0.0, 0.0]])
        self.assertIsNotNone(centroid)
        assert centroid is not None
        self.assertAlmostEqual(math.sqrt(sum(x * x for x in centroid)), 1.0, places=6)
        self.assertIsNone(calculate_centroid([]))
        self.assertIsNone(calculate_centroid([[0.0, 0.0]]))

        self.assertIsNone(validate_vector_dimension(None, expected_dim=4))
        self.assertEqual(validate_vector_dimension([1, 2, 3, 4], expected_dim=4), [1.0, 2.0, 3.0, 4.0])

        with self.assertRaises(ValueError):
            validate_vector_dimension([0.1, 0.2], expected_dim=1024, context="UnitTest")
        with self.assertRaises(ValueError):
            validate_vector_dimension([float("nan")] * 4, expected_dim=4)
        with self.assertRaises(ValueError):
            validate_vector_dimension([True, False, True, False], expected_dim=4)  # type: ignore[list-item]

    def test_deterministic_token_vector_and_mock_env(self) -> None:
        v_a = deterministic_token_vector("postgres pgvector cosine index", dim=1024)
        v_a2 = deterministic_token_vector("postgres pgvector cosine index", dim=1024)
        v_b = deterministic_token_vector("postgres pgvector hnsw cosine query", dim=1024)
        v_c = deterministic_token_vector("medieval sourdough baking recipe", dim=1024)

        self.assertEqual(v_a, v_a2)
        self.assertEqual(len(v_a), 1024)
        self.assertAlmostEqual(math.sqrt(sum(x * x for x in v_a)), 1.0, places=6)
        self.assertGreater(cosine_similarity(v_a, v_b), cosine_similarity(v_a, v_c))

        with patch("urllib.request.urlopen") as mock_urlopen:
            batch = embed_batch(["alpha beta", "gamma delta"], backend="deterministic", dimensions=256)
            self.assertEqual(len(batch), 2)
            self.assertEqual(len(batch[0]), 256)
            mock_urlopen.assert_not_called()

            with patch.dict(os.environ, {"MOCK_EMBEDDINGS": "1"}):
                single = embed_text("offline ci deterministic vector")
                self.assertIsNotNone(single)
                assert single is not None
                self.assertEqual(len(single), 1024)
                mock_urlopen.assert_not_called()

    def test_embed_batch_uses_api_embed_and_normalizes(self) -> None:
        captured_requests: list[tuple[str, dict]] = []

        def fake_urlopen(req, timeout=None):
            body = json.loads(req.data.decode("utf-8"))
            captured_requests.append((req.full_url, body))
            vecs = [_basis_vec(1024, idx, scale=5.0) for idx in range(len(body["input"]))]
            return _MockHTTPResponse({"embeddings": vecs})

        with patch("urllib.request.urlopen", side_effect=fake_urlopen):
            out = embed_batch(
                ["doc one", "doc two", "doc three"],
                model="bge-large",
                batch_size=2,
            )

        self.assertEqual(len(out), 3)
        self.assertEqual(len(captured_requests), 2)
        url_0, body_0 = captured_requests[0]
        self.assertEqual(url_0, f"{DEFAULT_EMBED_HOST}/api/embed")
        self.assertEqual(body_0["model"], "bge-large")
        self.assertEqual(body_0["input"], ["doc one", "doc two"])
        self.assertTrue(body_0["truncate"])
        self.assertEqual(body_0["keep_alive"], -1)
        self.assertNotIn("dimensions", body_0)

        for vec in out:
            self.assertEqual(len(vec), 1024)
            self.assertAlmostEqual(math.sqrt(sum(x * x for x in vec)), 1.0, places=6)

    def test_qwen3_4b_mrl_dimensions_and_dimension_mismatch_error(self) -> None:
        captured_bodies: list[dict] = []

        def fake_urlopen(req, timeout=None):
            body = json.loads(req.data.decode("utf-8"))
            captured_bodies.append(body)
            dim = body.get("dimensions", 2560)
            return _MockHTTPResponse({"embeddings": [_basis_vec(dim, 7, scale=2.0)]})

        with patch("urllib.request.urlopen", side_effect=fake_urlopen):
            vec = embed_text(
                "find authentication middleware",
                model="qwen3-embedding:4b",
                mode="query",
                domain="code",
            )

        self.assertIsNotNone(vec)
        assert vec is not None
        self.assertEqual(len(vec), 1024)
        self.assertEqual(len(captured_bodies), 1)
        self.assertEqual(captured_bodies[0]["dimensions"], 1024)
        self.assertTrue(captured_bodies[0]["input"][0].startswith("Instruct: "))
        self.assertTrue(captured_bodies[0]["input"][0].endswith("\nQuery:find authentication middleware"))

        # Verify ValueError is raised when server returns wrong vector length (e.g. unprojected 2560-d)
        def bad_dim_urlopen(req, timeout=None):
            return _MockHTTPResponse({"embeddings": [_basis_vec(2560, 0, scale=1.0)]})

        with patch("urllib.request.urlopen", side_effect=bad_dim_urlopen):
            with self.assertRaises(ValueError):
                embed_batch(["mismatch trigger"], model="qwen3-embedding:4b", dimensions=1024)

    def test_http_404_fallback_to_legacy_api_embeddings(self) -> None:
        calls: list[tuple[str, dict]] = []

        def fake_urlopen(req, timeout=None):
            body = json.loads(req.data.decode("utf-8"))
            calls.append((req.full_url, body))
            if req.full_url.endswith("/api/embed"):
                raise urllib.error.HTTPError(
                    req.full_url,
                    404,
                    "Not Found",
                    hdrs=None,  # type: ignore[arg-type]
                    fp=io.BytesIO(b"404 page not found"),
                )
            idx = len(calls)
            return _MockHTTPResponse({"embedding": _basis_vec(1024, idx, scale=4.0)})

        with patch("urllib.request.urlopen", side_effect=fake_urlopen):
            vecs = embed_batch(
                ["first query", "second query"],
                model="bge-large",
                ollama_url="http://embed-node.example.test:11434",
                mode="query",
            )

        self.assertEqual(len(vecs), 2)
        self.assertEqual(calls[0][0], "http://embed-node.example.test:11434/api/embed")
        self.assertEqual(calls[1][0], "http://embed-node.example.test:11434/api/embeddings")
        self.assertEqual(calls[2][0], "http://embed-node.example.test:11434/api/embeddings")
        self.assertEqual(
            calls[1][1],
            {
                "model": "bge-large",
                "prompt": "Represent this sentence for searching relevant passages: first query",
                "truncate": True,
                "keep_alive": -1,
            },
        )

        # Non-404 HTTP errors must propagate without silent fallback
        def error_500_urlopen(req, timeout=None):
            raise urllib.error.HTTPError(
                req.full_url,
                500,
                "Internal Server Error",
                hdrs=None,  # type: ignore[arg-type]
                fp=io.BytesIO(b"context length exceeded"),
            )

        with patch("urllib.request.urlopen", side_effect=error_500_urlopen):
            with self.assertRaises(urllib.error.HTTPError):
                embed_batch(["boom"], model="bge-large")

    def test_embed_text_lru_cache_space_isolation_and_empty_guard(self) -> None:
        call_count = 0

        def fake_urlopen(req, timeout=None):
            nonlocal call_count
            call_count += 1
            return _MockHTTPResponse({"embeddings": [_basis_vec(1024, call_count, scale=2.0)]})

        with patch("urllib.request.urlopen", side_effect=fake_urlopen):
            self.assertIsNone(embed_text(""))
            self.assertIsNone(embed_text("   \n\t  "))
            self.assertEqual(call_count, 0)

            v1 = embed_text("shared phrase", model="bge-large", mode="document")
            v2 = embed_text("shared phrase", model="bge-large", mode="document")
            self.assertEqual(call_count, 1)
            self.assertEqual(v1, v2)

            # Mutating caller copy must not poison LRU cache
            assert v1 is not None
            v1[0] = 999.0
            v3 = embed_text("shared phrase", model="bge-large", mode="document")
            assert v3 is not None
            self.assertNotEqual(v3[0], 999.0)
            self.assertEqual(call_count, 1)

            # Query mode vs document mode must not share cache entries (INV-05)
            v_query = embed_text("shared phrase", model="bge-large", mode="query")
            self.assertEqual(call_count, 2)
            self.assertNotEqual(v3, v_query)

            # Different model must not share cache entries (INV-05)
            _ = embed_text("shared phrase", model="snowflake-arctic-embed2", mode="document")
            self.assertEqual(call_count, 3)

    def test_chunk_text_and_embed_chunked_centroid(self) -> None:
        long_code = "\n".join(
            f"def handler_{i}(request: dict) -> dict: return {{'idx': {i}, 'ok': True}}"
            for i in range(60)
        )
        self.assertGreater(len(long_code), 3000)

        bge_chunks = chunk_text_for_embedding(long_code, model="bge-large")
        self.assertGreater(len(bge_chunks), 3)
        for ch in bge_chunks:
            self.assertLessEqual(len(ch), 1100)

        # Qwen3 8K+ window keeps 3k+ char snippet in a single pass
        qwen_chunks = chunk_text_for_embedding(long_code, model="qwen3-embedding:4b")
        self.assertEqual(len(qwen_chunks), 1)

        http_calls: list[dict] = []

        def fake_urlopen(req, timeout=None):
            body = json.loads(req.data.decode("utf-8"))
            http_calls.append(body)
            vecs = [_basis_vec(1024, idx, scale=1.0) for idx in range(len(body["input"]))]
            return _MockHTTPResponse({"embeddings": vecs})

        with patch("urllib.request.urlopen", side_effect=fake_urlopen):
            centroid = embed_chunked_centroid(long_code, model="bge-large")

        self.assertIsNotNone(centroid)
        assert centroid is not None
        self.assertEqual(len(centroid), 1024)
        self.assertAlmostEqual(math.sqrt(sum(x * x for x in centroid)), 1.0, places=6)
        # All chunks embedded in a single batched /api/embed request!
        self.assertEqual(len(http_calls), 1)
        self.assertEqual(len(http_calls[0]["input"]), len(bge_chunks))

    def test_env_precedence_url_normalization_and_lru_bounds(self) -> None:
        self.assertEqual(embed_batch([]), [])
        self.assertIsNone(embed_chunked_centroid("   "))

        # Dense minified string with zero whitespace obeys max_chars and max_chunks
        dense = "x" * 20000
        dense_chunks = chunk_text_for_embedding(dense, model="bge-large", max_chunks=5)
        self.assertEqual(len(dense_chunks), 5)
        self.assertTrue(all(len(c) == 1100 for c in dense_chunks))

        captured: list[tuple[str, dict]] = []

        def fake_urlopen(req, timeout=None):
            body = json.loads(req.data.decode("utf-8"))
            captured.append((req.full_url, body))
            dim = body.get("dimensions", 768)
            return _MockHTTPResponse({"embedding": _basis_vec(dim, 1, scale=2.0)})

        with patch.dict(
            os.environ,
            {
                "EMBEDDING_MODEL": "bge-large",
                "EMBED_MODEL": "nomic-embed-text",
                "OLLAMA_URL": "http://127.0.0.1:11434",
                "OLLAMA_EMBED_HOST": "http://embed-node.example.test:11434/api/embeddings/",
                "EMBED_DIMS": "512",
            },
        ):
            with patch("urllib.request.urlopen", side_effect=fake_urlopen):
                vec = embed_text("env precedence check")

        self.assertIsNotNone(vec)
        assert vec is not None
        self.assertEqual(len(vec), 512)
        self.assertEqual(captured[0][0], "http://embed-node.example.test:11434/api/embed")
        self.assertEqual(captured[0][1]["model"], "nomic-embed-text")
        self.assertEqual(captured[0][1]["dimensions"], 512)

        # Verify bounded LRU eviction in deterministic mode (>512 items)
        for idx in range(530):
            res = embed_text(f"bounded cache entry {idx}", backend="deterministic", dimensions=64)
            self.assertIsNotNone(res)
        from krusch_toolkit import embeddings as emb_mod

        self.assertLessEqual(len(emb_mod._EMBED_CACHE), 512)

    def test_calibrate_query_similarity_isotropic_vs_anisotropic(self) -> None:
        # Unrelated isotropic noise (~0.05) stays well below retrieval thresholds
        self.assertAlmostEqual(
            calibrate_query_similarity(0.05, model="snowflake-arctic-embed2:latest"),
            0.15,
            places=6,
        )
        # Paraphrase / topical isotropic match (~0.45) maps into ~0.731 calibrated band
        self.assertGreater(
            calibrate_query_similarity(0.45, model="snowflake-arctic-embed2:latest"),
            0.70,
        )
        self.assertGreater(
            calibrate_query_similarity(0.45, model="qwen3-embedding:4b"),
            0.70,
        )
        # Anisotropic bge-large passes raw cosine unchanged
        self.assertAlmostEqual(
            calibrate_query_similarity(0.45, model="bge-large"),
            0.45,
            places=6,
        )
        # Sparse synthetic unit-test vector bypasses calibration
        sparse_vec = _basis_vec(64, 0, scale=1.0)
        self.assertAlmostEqual(
            calibrate_query_similarity(0.45, model="snowflake-arctic-embed2", query_vec=sparse_vec),
            0.45,
            places=6,
        )
        # Bounds clamping
        self.assertEqual(calibrate_query_similarity(-0.15), 0.0)
        self.assertEqual(calibrate_query_similarity(1.05), 1.0)


if __name__ == "__main__":
    unittest.main()
