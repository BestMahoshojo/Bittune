"""predicted_claims: values come from a named candidate, never handwriting."""

import sys
from pathlib import Path
import unittest

SRC_ROOT = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC_ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from bittune_core.cloud import record_cloud_recommendation, record_cloud_recommendation_outcome  # noqa: E402
from bittune_core.contracts import ContractError  # noqa: E402
from bittune_core.reports import write_report  # noqa: E402
from test_cloud import CloudFixture, RECORD_HASHES, load_fixture, record_params  # noqa: E402


class PredictedClaimsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.fixture = CloudFixture()

    def tearDown(self) -> None:
        self.fixture.close()

    def record_search(self, response=None) -> str:
        recorded = record_cloud_recommendation(record_params(response or load_fixture("v2-response-search.json")), self.fixture.context)
        return recorded["data"]["artifact_id"]

    def write(self, artifact_id: str, claims: list[dict], metric_claims: list[dict] | None = None) -> dict:
        params = {
            "title": "预测对照",
            "narrative": "对照 Cloud 模拟均值与本机实测。",
            "conclusion": "仅引用指定 candidate_id。",
            "references": {"artifact_ids": [artifact_id]},
            "predicted_claims": claims,
        }
        if metric_claims is not None:
            params["metric_claims"] = metric_claims
        return write_report(params, self.fixture.context)

    def test_named_search_candidate_renders_simulated_mean(self) -> None:
        artifact_id = self.record_search()
        result = self.write(
            artifact_id,
            [{"artifact_id": artifact_id, "candidate_id": "qwen25-72b-awq-vllm__pred_search__0", "metric": "mean_ttft_ms"}],
        )
        markdown = self.fixture.store.read_artifact_excerpt(result["data"]["report"]["artifact_ids"][0], max_bytes=65536)["text"]
        self.assertIn("| 指标 | 预测 | 实测 |", markdown)
        self.assertIn("120 ms（模拟均值）", markdown)
        self.assertIn("—", markdown)
        claim = result["data"]["report"]["predicted_claims"][0]
        self.assertEqual(claim["candidate_id"], "qwen25-72b-awq-vllm__pred_search__0")
        self.assertEqual(claim["value"], 120)
        self.assertFalse(claim["invalid"])

    def test_missing_candidate_id_fails(self) -> None:
        artifact_id = self.record_search()
        with self.assertRaises(ContractError) as caught:
            self.write(artifact_id, [{"artifact_id": artifact_id, "metric": "mean_ttft_ms"}])
        self.assertEqual(caught.exception.code, "invalid_predicted_claim")

    def test_top_level_prediction_is_ignored(self) -> None:
        response = load_fixture("v2-response-shortlist.json")
        response["prediction"] = {
            "metrics": {"mean_ttft_ms": 1, "output_throughput_tok_s": 9, "mean_tpot_ms": 2, "completed_request_ratio": 0.99},
            "engine_version": "aisimulate-0.1.0",
            "measurement_basis": "simulated",
        }
        artifact_id = self.record_search(response)
        with self.assertRaises(ContractError) as caught:
            self.write(
                artifact_id,
                [{"artifact_id": artifact_id, "candidate_id": "qwen25-72b-awq-vllm__catalog__0", "metric": "mean_ttft_ms"}],
            )
        self.assertEqual(caught.exception.code, "invalid_predicted_claim")

    def test_missing_candidate_and_catalog_kind_fail(self) -> None:
        artifact_id = self.record_search()
        with self.assertRaises(ContractError) as caught:
            self.write(artifact_id, [{"artifact_id": artifact_id, "candidate_id": "does-not-exist", "metric": "mean_ttft_ms"}])
        self.assertEqual(caught.exception.code, "invalid_predicted_claim")

        catalog_id = record_cloud_recommendation(record_params(load_fixture("v2-response-shortlist.json")), self.fixture.context)["data"]["artifact_id"]
        with self.assertRaises(ContractError) as caught:
            self.write(
                catalog_id,
                [{"artifact_id": catalog_id, "candidate_id": "qwen25-72b-awq-vllm__catalog__0", "metric": "mean_ttft_ms"}],
            )
        self.assertEqual(caught.exception.code, "invalid_predicted_claim")

    def test_handwritten_values_fail(self) -> None:
        artifact_id = self.record_search()
        with self.assertRaises(ContractError) as caught:
            self.write(
                artifact_id,
                [{"artifact_id": artifact_id, "candidate_id": "qwen25-72b-awq-vllm__pred_search__0", "metric": "mean_ttft_ms", "value": 120}],
            )
        self.assertEqual(caught.exception.code, "invalid_predicted_claim")

    def test_attempt_artifact_fails(self) -> None:
        outcome = record_cloud_recommendation_outcome(
            {"request_hash": "sha256:" + "a" * 64, **RECORD_HASHES, "outcome": "http_error"},
            self.fixture.context,
        )
        artifact_id = outcome["data"]["artifact_id"]
        with self.assertRaises(ContractError) as caught:
            self.write(
                artifact_id,
                [{"artifact_id": artifact_id, "candidate_id": "qwen25-72b-awq-vllm__pred_search__0", "metric": "mean_ttft_ms"}],
            )
        self.assertEqual(caught.exception.code, "invalid_predicted_claim")

    def test_itl_as_tpot_fails(self) -> None:
        artifact_id = self.record_search()
        with self.assertRaises(ContractError) as caught:
            self.write(
                artifact_id,
                [{"artifact_id": artifact_id, "candidate_id": "qwen25-72b-awq-vllm__pred_search__0", "metric": "mean_itl_ms"}],
            )
        self.assertEqual(caught.exception.code, "invalid_predicted_claim")

    def test_low_completed_request_ratio_invalidates_only_that_candidate(self) -> None:
        response = load_fixture("v2-response-search.json")
        response["candidates"][0]["prediction"]["metrics"]["completed_request_ratio"] = 0.5
        artifact_id = self.record_search(response)
        result = self.write(
            artifact_id,
            [
                {"artifact_id": artifact_id, "candidate_id": "qwen25-72b-awq-vllm__pred_search__0", "metric": "mean_ttft_ms"},
                {"artifact_id": artifact_id, "candidate_id": "qwen25-72b-awq-vllm__pred_search__1", "metric": "mean_ttft_ms"},
            ],
        )
        claims = result["data"]["report"]["predicted_claims"]
        self.assertTrue(claims[0]["invalid"])
        self.assertFalse(claims[1]["invalid"])
        markdown = self.fixture.store.read_artifact_excerpt(result["data"]["report"]["artifact_ids"][0], max_bytes=65536)["text"]
        self.assertIn("预测完成率过低，本行不可比", markdown)
        self.assertIn("90 ms（模拟均值）", markdown)

    def test_oversized_recommendation_artifact_still_resolves_named_candidate(self) -> None:
        response = load_fixture("v2-response-search.json")
        response["candidates"][0]["prediction"]["engine_version"] = "x" * 70_000
        artifact_id = self.record_search(response)
        excerpt = self.fixture.store.read_artifact_excerpt(artifact_id, max_bytes=65536)
        self.assertTrue(excerpt["truncated"])
        result = self.write(
            artifact_id,
            [{"artifact_id": artifact_id, "candidate_id": "qwen25-72b-awq-vllm__pred_search__0", "metric": "mean_ttft_ms"}],
        )
        self.assertEqual(result["data"]["report"]["predicted_claims"][0]["value"], 120)

    def test_search_layout_claim_must_name_one_candidate(self) -> None:
        artifact_id = self.record_search()
        named = self.write(
            artifact_id,
            [{"artifact_id": artifact_id, "candidate_id": "qwen25-72b-awq-vllm__pred_search__1", "metric": "output_tokens_per_second"}],
        )
        self.assertEqual(named["data"]["report"]["predicted_claims"][0]["value"], 3100)
        markdown = self.fixture.store.read_artifact_excerpt(named["data"]["report"]["artifact_ids"][0], max_bytes=65536)["text"]
        self.assertIn("3100 tok/s（模拟均值）", markdown)
        self.assertNotIn("2400 tok/s", markdown)


if __name__ == "__main__":
    unittest.main()
