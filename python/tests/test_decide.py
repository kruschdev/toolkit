import unittest
from krusch_toolkit.decide import (
    decide,
    decide_batch,
    calibrate_choice_logprobs,
    System1Decider,
)


class TestSystem1Decide(unittest.TestCase):
    def test_calibrate_choice_logprobs_logsumexp(self):
        top_logprobs = [
            {"token": "YES", "logprob": -0.08},
            {"token": "NO", "logprob": -2.60},
            {"token": "Yes", "logprob": -8.30},
            {"token": " YES", "logprob": -8.80},
        ]
        res = calibrate_choice_logprobs(top_logprobs, ["YES", "NO"])
        self.assertTrue(res["matched_logprobs"])
        self.assertEqual(res["choice"], "YES")
        self.assertGreater(res["confidence"], 0.92)
        self.assertAlmostEqual(res["probabilities"]["YES"] + res["probabilities"]["NO"], 1.0, places=3)

    def test_decide_parses_openai_top_logprobs(self):
        def mock_post(url, payload, timeout_s):
            return {
                "choices": [{
                    "message": {"content": "LOCAL_PACK"},
                    "logprobs": {
                        "content": [{
                            "token": "LOCAL_PACK",
                            "logprob": -0.05,
                            "top_logprobs": [
                                {"token": "LOCAL_PACK", "logprob": -0.05},
                                {"token": "STATEWIDE_STATUTE", "logprob": -3.10},
                                {"token": "ABSTAIN", "logprob": -5.00},
                            ],
                        }]
                    },
                }]
            }

        res = decide(
            state={"jurisdiction": "CA-BERKELEY", "pack": "ca_berkeley.yaml"},
            question="Which authority controls a Berkeley OMI eviction notice?",
            choices=["LOCAL_PACK", "STATEWIDE_STATUTE", "ABSTAIN"],
            http_post=mock_post,
        )
        self.assertEqual(res["mode"], "logprobs")
        self.assertEqual(res["choice"], "LOCAL_PACK")
        self.assertGreater(res["confidence"], 0.94)

    def test_decide_deterministic_fallback_when_offline(self):
        def failing_post(url, payload, timeout_s):
            raise ConnectionError("Offline")

        res = decide(
            state="Berkeley BMC 13.76 requires 50.0% ownership floor and 36-month continuous occupancy.",
            question="Does Berkeley BMC 13.76 require 36-month continuous occupancy?",
            choices=["YES", "NO"],
            http_post=failing_post,
        )
        self.assertEqual(res["mode"], "deterministic_fallback")
        self.assertEqual(res["choice"], "YES")

        res_explicit = decide(
            state="Berkeley BMC 13.76 requires 50.0% ownership floor and 36-month continuous occupancy.",
            question="Does Berkeley BMC 13.76 require 36-month continuous occupancy?",
            choices=["YES", "NO"],
            fallback=True,
        )
        self.assertEqual(res_explicit["mode"], "deterministic_fallback")
        self.assertEqual(res_explicit["choice"], "YES")


    def test_system1_decider_lru_cache_and_batch(self):
        calls = {"count": 0}

        def mock_post(url, payload, timeout_s):
            calls["count"] += 1
            return {
                "choices": [{
                    "message": {"content": "YES"},
                    "logprobs": {
                        "content": [{
                            "top_logprobs": [
                                {"token": "YES", "logprob": -0.02},
                                {"token": "NO", "logprob": -4.00},
                            ]
                        }]
                    },
                }]
            }

        decider = System1Decider(max_cache_size=8, http_post=mock_post)
        r1 = decider.decide("Civ. Code 1950.5", "Is deposit return window 21 calendar days?")
        self.assertFalse(r1["cached"])
        self.assertEqual(r1["choice"], "YES")
        self.assertEqual(calls["count"], 1)

        r2 = decider.decide("Civ. Code 1950.5", "Is deposit return window 21 calendar days?")
        self.assertTrue(r2["cached"])
        self.assertEqual(r2["latency_ms"], 0.0)
        self.assertEqual(calls["count"], 1)

        batch = decide_batch(
            state="Civ. Code 1950.5",
            questions=["Is deposit return window 21 calendar days?", {"question": "Select tier", "choices": ["FLOOR", "CEILING"]}],
            http_post=mock_post,
        )
        self.assertEqual(len(batch), 2)
        self.assertEqual(batch[0]["choice"], "YES")

    def test_decide_logprobs_with_mock_llm_env_and_non_first_top_token(self):
        import os
        from unittest.mock import patch

        with patch.dict(os.environ, {"MOCK_LLM": "1"}):
            def mock_post(url, payload, timeout_s):
                return {
                    "choices": [{
                        "message": {"content": "YES"},
                        "logprobs": {
                            "content": [{
                                "top_logprobs": [
                                    {"token": "NO", "logprob": -3.50},
                                    {"token": "YES", "logprob": -0.04},
                                ]
                            }]
                        },
                    }]
                }

            res = decide(
                state="Test context",
                question="Should highest logprob win even if second in array?",
                choices=["YES", "NO"],
                http_post=mock_post,
                fallback=False,
            )
            self.assertEqual(res["mode"], "logprobs")
            self.assertEqual(res["choice"], "YES")

    def test_decide_validates_state_and_choices(self):
        with self.assertRaises(ValueError):
            decide(state=12345, question="Valid question?")  # type: ignore[arg-type]
        with self.assertRaises(ValueError):
            decide(state="ok", question="Valid question?", choices=[])
        with self.assertRaises(ValueError):
            decide(state="ok", question="Valid question?", choices=["ONLY_ONE"])
        with self.assertRaises(ValueError):
            decide(state="ok", question="Valid question?", choices=["YES", ""])


if __name__ == "__main__":
    unittest.main()
