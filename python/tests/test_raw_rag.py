import unittest

from krusch_toolkit import (
    LEGAL_BOILERPLATE_STOPWORDS,
    QWEN_RERANKER_TEMPLATE,
    RAG_BASELINE_CONSTRAINTS,
    RAW_RAG_DEFAULTS,
    RawRagIndex,
    assemble_reader_evidence,
    audit_mutation_stream,
    audit_rag_baseline_config,
    build_qwen_reranker_prompt,
    chunk_conversation_windows,
    create_raw_rag_index,
    estimate_token_count,
    evaluate_conditional_path_retention,
    evaluate_coverage_and_utilization,
    normalize_append_only_write_op,
    rerank_candidate_windows,
    score_deterministic_cross_encoder,
    serialize_conversation_turn,
    should_narrow_candidate_sub_span,
)


class TestKruschToolkitRawRag(unittest.TestCase):
    def test_immutable_defaults_and_constraints(self) -> None:
        self.assertEqual(RAW_RAG_DEFAULTS["window_tokens"], 256)
        self.assertEqual(RAW_RAG_DEFAULTS["overlap_tokens"], 32)
        self.assertEqual(RAW_RAG_DEFAULTS["stride_tokens"], 224)
        self.assertEqual(RAW_RAG_DEFAULTS["dense_candidate_k"], 128)
        self.assertEqual(RAW_RAG_DEFAULTS["final_rerank_k"], 15)
        self.assertEqual(RAW_RAG_DEFAULTS["max_evidence_tokens"], 5000)
        self.assertEqual(RAW_RAG_DEFAULTS["llm_ingestion_calls"], 0)
        with self.assertRaises(TypeError):
            RAW_RAG_DEFAULTS["window_tokens"] = 512  # type: ignore[index]
        with self.assertRaises(TypeError):
            RAG_BASELINE_CONSTRAINTS["min_chunk_tokens"] = 10  # type: ignore[index]
        self.assertIn("yes", QWEN_RERANKER_TEMPLATE["system"])

    def test_turn_serialization_and_image_captions(self) -> None:
        plain = serialize_conversation_turn({"speaker": "Alice", "content": "Switched port to 5435."}, 0)
        self.assertEqual(plain["date"], "unknown")
        self.assertEqual(plain["serialized"], "[Date: unknown] Alice: Switched port to 5435.")

        mm = serialize_conversation_turn(
            {
                "turn_id": "t_7",
                "date": "2026-10-20",
                "speaker": "Bob",
                "content": "Uploaded rack photo.",
                "image_captions": ["Dual RTX 3060 cards installed in server chassis"],
            },
            7,
        )
        self.assertEqual(mm["turn_id"], "t_7")
        self.assertIn("[Date: 2026-10-20] Bob: Uploaded rack photo.", mm["serialized"])
        self.assertIn("[Image Caption]: Dual RTX 3060 cards installed in server chassis", mm["serialized"])

    def test_window_chunking_256_tokens_with_32_overlap(self) -> None:
        turns = [
            {
                "turn_id": f"msg_{i}",
                "date": f"2026-10-{(i % 28) + 1:02d}",
                "speaker": "User" if i % 2 == 0 else "Assistant",
                "content": (
                    f"Turnmarker_{i} discusses database migration batch_{i} with latency_{i * 10}ms "
                    f"and replica verification across node_{i % 4} in production cluster."
                ),
            }
            for i in range(18)
        ]
        res = chunk_conversation_windows(turns, window_tokens=256, overlap_tokens=32)
        windows = res["windows"]
        self.assertGreaterEqual(len(windows), 2)
        self.assertEqual(windows[0]["token_count"], 256)
        self.assertEqual(windows[1]["start_token"], 224)
        self.assertEqual(windows[0]["end_token"] - windows[1]["start_token"], 32)
        for win in windows:
            self.assertGreaterEqual(len(win["turn_indices"]), 1)
            self.assertEqual(estimate_token_count(win["text"]), win["token_count"])

    def test_audit_rag_baseline_config_table_34(self) -> None:
        strong = audit_rag_baseline_config(RAW_RAG_DEFAULTS)
        self.assertTrue(strong["valid"])
        self.assertEqual(strong["status"], "STRONG_RAW_RAG")

        weakened = audit_rag_baseline_config(
            {
                "chunk_tokens": 4096,
                "final_top_k": 2,
                "reranker_enabled": False,
                "allow_destructive_overwrite": True,
                "llm_ingestion_transform": True,
            }
        )
        self.assertFalse(weakened["valid"])
        self.assertEqual(weakened["status"], "WEAKENED_BASELINE")
        codes = {f["code"] for f in weakened["findings"]}
        self.assertTrue(
            {
                "CHUNK_TOO_LARGE",
                "TOP_K_TOO_LOW",
                "MISSING_RERANKER",
                "DESTRUCTIVE_MUTATION_ENABLED",
                "LLM_INGESTION_BOTTLENECK",
            }.issubset(codes)
        )

        overflow = audit_rag_baseline_config({"final_top_k": 120})
        self.assertFalse(overflow["valid"])
        self.assertIn("TOP_K_DISTRACTOR_OVERFLOW", {f["code"] for f in overflow["findings"]})

    def test_append_only_write_normalization_and_stream_audit(self) -> None:
        existing = [
            {"id": "m1", "text": "Primary Postgres runs on port 5432"},
            {"id": "m2", "text": "Embeddings use snowflake-arctic-embed2"},
        ]

        noop_upd = normalize_append_only_write_op(
            {"action": "UPDATE", "target_id": "m1", "text": "  primary postgres runs on port 5432 "},
            existing,
        )
        self.assertEqual(noop_upd["action"], "NONE")
        self.assertEqual(noop_upd["reason"], "NOOP_IDENTICAL_TEXT")

        sup_add = normalize_append_only_write_op(
            {"action": "UPDATE", "target_id": "m1", "text": "Primary Postgres migrated to port 5434"},
            existing,
        )
        self.assertEqual(sup_add["action"], "ADD")
        self.assertEqual(sup_add["supersedes_id"], "m1")

        blocked_del = normalize_append_only_write_op({"action": "DELETE", "target_id": "m2"}, existing)
        self.assertEqual(blocked_del["action"], "NONE")
        self.assertEqual(blocked_del["reason"], "DESTRUCTIVE_DELETE_BLOCKED")

        comp_del = normalize_append_only_write_op(
            {"action": "DELETE", "target_id": "m2"},
            existing,
            explicit_compliance_erase=True,
        )
        self.assertEqual(comp_del["action"], "COMPLIANCE_TOMBSTONE")

        audit = audit_mutation_stream(
            [
                {"action": "ADD", "id": "a1", "text": "User lives in Seattle"},
                {"action": "UPDATE", "target_id": "a1", "text": "User lives in Seattle"},
                {"action": "UPDATE", "target_id": "bad_id", "text": "User likes espresso"},
                {"action": "UPDATE", "target_id": "a1", "text": "User moved to Austin"},
                {"action": "NONE", "text": ""},
            ]
        )
        self.assertEqual(audit["total_decisions"], 5)
        self.assertEqual(audit["effective_mutation_count"], 1)
        self.assertEqual(audit["noop_or_malformed_mutation_count"], 2)
        self.assertEqual(audit["effective_mutation_rate"], 0.2)

    def test_qwen_reranker_prompt_and_logprob_calibration(self) -> None:
        prompt = build_qwen_reranker_prompt("Which port hosts KruschLaw?", "KruschLaw API listens on 8085.")
        self.assertIn("<Query>: Which port hosts KruschLaw?", prompt["user"])
        self.assertIn("<Document>: KruschLaw API listens on 8085.", prompt["user"])

        candidates = [
            {"window_id": "w0", "window_index": 0, "text": "Apples and milk grocery list.", "dense_score": 0.72},
            {"window_id": "w1", "window_index": 1, "text": "KruschLaw listens on port 8085.", "dense_score": 0.51},
        ]

        def mock_rerank(_q: str, cand: dict) -> dict:
            if cand["window_id"] == "w1":
                return {"top_logprobs": [{"token": "yes", "logprob": -0.05}, {"token": "no", "logprob": -3.2}]}
            return {"top_logprobs": [{"token": "no", "logprob": -0.08}, {"token": "yes", "logprob": -2.8}]}

        reranked = rerank_candidate_windows(
            "Which port hosts KruschLaw?",
            candidates,
            top_k=2,
            reranker_fn=mock_rerank,
        )
        self.assertEqual(reranked[0]["window_id"], "w1")
        self.assertEqual(reranked[0]["rerank_mode"], "logprobs")
        self.assertGreater(reranked[0]["rerank_score"], 0.9)

    def test_graceful_5000_token_budget_disables_turn_expansion_first(self) -> None:
        long_turns = [
            {
                "turn_id": f"long_{i}",
                "date": "2026-10-25",
                "speaker": "Engineer",
                "content": f"EvidenceAnchor_{i} " + " ".join(f"word_{i}_{w}" for w in range(380)),
            }
            for i in range(15)
        ]
        selected_windows = [
            {
                "window_id": f"sel_{i}",
                "window_index": i,
                "turn_indices": [i],
                "text": f"[Date: 2026-10-25] Engineer: EvidenceAnchor_{i} compact_window_{i}",
                "token_count": 14,
            }
            for i in range(15)
        ]
        assembled = assemble_reader_evidence(
            selected_windows,
            long_turns,
            max_evidence_tokens=5000,
            turn_expansion=True,
        )
        self.assertFalse(assembled["turn_expansion_applied"])
        self.assertEqual(assembled["budget_policy_triggered"], "DISABLED_TURN_EXPANSION")
        self.assertEqual(assembled["retained_entry_count"], 15)
        for i in range(15):
            self.assertIn(f"EvidenceAnchor_{i}", assembled["context_text"])

        tight = assemble_reader_evidence(
            selected_windows,
            long_turns,
            max_evidence_tokens=100,
            turn_expansion=True,
        )
        self.assertEqual(tight["budget_policy_triggered"], "PREFIX_COMPLETE_WINDOWS")
        self.assertEqual(tight["retained_entry_count"], 7)

    def test_coverage_utilization_and_path_retention_metrics(self) -> None:
        metrics = evaluate_coverage_and_utilization(
            [
                {"covered": True, "accurate": 1},
                {"covered": True, "accurate": 1},
                {"covered": True, "accurate": 0},
                {"covered": False, "accurate": 1},
                {"covered": False, "accurate": 0},
            ]
        )
        self.assertEqual(metrics["coverage"], 0.6)
        self.assertEqual(metrics["utilization"], 0.666667)
        self.assertEqual(metrics["covered_contribution"], 0.4)
        self.assertEqual(metrics["uncovered_residual"], 0.2)
        self.assertEqual(metrics["overall_accuracy"], 0.6)
        self.assertEqual(metrics["decomposition_error"], 0.0)

        path_metrics = evaluate_conditional_path_retention(
            [
                {"has_result": True, "has_path": True},
                {"has_result": True, "has_path": True},
                {"has_result": True, "has_path": False},
                {"has_result": False, "has_path": False},
            ]
        )
        self.assertEqual(path_metrics["result_coverage"], 0.75)
        self.assertEqual(path_metrics["path_coverage"], 0.5)
        self.assertEqual(path_metrics["conditional_path_given_result"], 0.666667)

    def test_stateful_raw_rag_index_phase_isolation_and_retrieval(self) -> None:
        index = create_raw_rag_index(
            offline=True,
            window_tokens=96,
            overlap_tokens=16,
            dense_candidate_k=32,
            final_rerank_k=5,
            max_evidence_tokens=2000,
        )
        self.assertIsInstance(index, RawRagIndex)

        index.add_turns(
            [
                {
                    "turn_id": "p1_a",
                    "date": "2026-09-01",
                    "speaker": "User",
                    "phase": 1,
                    "content": "Project Aurora uses codename Zephyr_91 and runs on port 4890.",
                },
                {
                    "turn_id": "p1_b",
                    "date": "2026-09-02",
                    "speaker": "Assistant",
                    "phase": 1,
                    "content": "Acknowledged Zephyr_91 deployment on krusch.",
                },
            ]
        )
        index.add_turns(
            [
                {
                    "turn_id": "p2_a",
                    "date": "2026-10-15",
                    "speaker": "User",
                    "phase": 2,
                    "content": "We migrated Zephyr_91 from port 4890 to port 5446 during maintenance.",
                }
            ]
        )

        phase1 = index.retrieve("What port does Zephyr_91 run on?", max_phase=1)
        self.assertIn("4890", phase1["context_text"])
        self.assertNotIn("5446", phase1["context_text"])

        full = index.retrieve("What port did Zephyr_91 migrate to from 4890?")
        self.assertIn("4890", full["context_text"])
        self.assertIn("5446", full["context_text"])
        self.assertEqual(full["llm_ingestion_calls"], 0)

        index.apply_write_proposal({"action": "ADD", "id": "n1", "text": "Zephyr_91 backup is /srv/backups"})
        sup = index.apply_write_proposal(
            {"action": "UPDATE", "target_id": "n1", "text": "Zephyr_91 backup rotated to /srv/backups/zephyr"}
        )
        self.assertEqual(sup["action"], "ADD")
        self.assertEqual(sup["supersedes_id"], "n1")
        backup_res = index.retrieve("Where is Zephyr_91 backup?")
        self.assertIn("/srv/backups/zephyr", backup_res["context_text"])

    def test_legal_domain_dense_primary_and_sub_span_guard(self) -> None:
        self.assertIn("agreement", LEGAL_BOILERPLATE_STOPWORDS)
        self.assertTrue(should_narrow_candidate_sub_span())
        self.assertTrue(should_narrow_candidate_sub_span(domain="memory"))
        self.assertFalse(should_narrow_candidate_sub_span(domain="law"))
        self.assertFalse(should_narrow_candidate_sub_span(domain="legal"))
        self.assertTrue(should_narrow_candidate_sub_span(domain="law", allow_sub_span_narrowing=True))

        legal_q = "Does the agreement permit a party or the company to terminate under applicable section terms upon insolvency?"
        boiler = "This Agreement sets forth applicable terms between each Party and the Company under Section 1 hereof."
        clause = "Either signatory may immediately rescind all obligations upon bankruptcy, receivership, or voluntary dissolution; provided, however, cure periods apply."

        self.assertGreater(
            score_deterministic_cross_encoder(legal_q, boiler, 0.22),
            score_deterministic_cross_encoder(legal_q, clause, 0.88),
        )
        self.assertGreater(
            score_deterministic_cross_encoder(legal_q, clause, 0.88, domain="law"),
            score_deterministic_cross_encoder(legal_q, boiler, 0.22, domain="law"),
        )
        reranked = rerank_candidate_windows(
            legal_q,
            [
                {"window_id": "boiler_0", "window_index": 0, "text": boiler, "dense_score": 0.22},
                {"window_id": "clause_1", "window_index": 1, "text": clause, "dense_score": 0.88},
            ],
            top_k=2,
            domain="law",
            offline=True,
        )
        self.assertEqual(reranked[0]["window_id"], "clause_1")


if __name__ == "__main__":
    unittest.main()
