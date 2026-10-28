"""Phase 2 stage 4 tests: cloud projections, experience exports and outbox.

The facts are fabricated through the real CoreStore write paths, so the
hash/whitelist/状态机 rules under test are exactly the production ones.
"""

import json
import sqlite3
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from typing import Any

SRC_ROOT = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC_ROOT))

from bittune_core.cloud import (  # noqa: E402
    _build_export,
    _load_bucket,
    _scan_forbidden,
    _token_bucket,
    _vram_bucket,
    cloud_experience_enqueue,
    cloud_experience_preview,
    cloud_outbox_cancel,
    cloud_outbox_claim,
    cloud_outbox_complete,
    cloud_outbox_fail,
    cloud_outbox_list,
    cloud_outbox_mark_retracted,
    cloud_prepare_recommendation,
    cloud_session_recommend_status,
    record_cloud_recommendation,
    record_cloud_recommendation_outcome,
)
from bittune_core.contracts import ContractError, cloud_canonical_hash  # noqa: E402
from bittune_core.store import CoreStore, utc_now  # noqa: E402

CONSTRAINTS = {"must_be_offline": True, "max_memory_percent": 90}
FIXTURES = Path(__file__).resolve().parents[3] / "contracts" / "cloud" / "fixtures" / "recommendation"
RECORD_HASHES = {
    "environment_hash": "sha256:" + "f" * 64,
    "target_hash": "sha256:" + "f" * 64,
    "constraints_hash": "sha256:" + "f" * 64,
}


def load_fixture(name: str) -> dict[str, Any]:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def record_params(response: dict[str, Any]) -> dict[str, Any]:
    return {"response": response, "request_hash": response["request_hash"], **RECORD_HASHES}


def minutes_ago(minutes: int) -> str:
    from datetime import datetime, timedelta, timezone

    return (datetime.now(timezone.utc) - timedelta(minutes=minutes)).isoformat().replace("+00:00", "Z")


class CloudFixture:
    def __init__(self) -> None:
        self.home = Path(tempfile.mkdtemp(prefix="bittune-cloud-test-"))
        self.store = CoreStore(self.home)
        self.context = {"store": self.store, "session_id": "test-session", "emit_progress": None}
        self.benchmark_ids: list[str] = []
        self.run_ids: list[str] = []

    def close(self) -> None:
        self.store.close()

    def run(self, tool_name: str) -> str:
        run_id, _ = self.store.start_run(tool_name, "managed", {}, self.context["session_id"])
        self.store.finish_run(run_id, "completed", {"summary": "ok"})
        return run_id

    def snapshot(self, gpus: list[dict[str, Any]] | None = None, *, observed_at: str | None = None) -> dict[str, Any]:
        gpu = {
            "index": 0,
            "uuid": "GPU-uuid-0",
            "name": "NVIDIA L40S",
            "driver_version": "550.54.15",
            "compute_capability": "8.9",
            "memory_total_bytes": 48 * 1024**3,
            "memory_free_bytes": 45 * 1024**3,
            "utilization_percent": 3,
            "power_watts": 71,
        }
        snapshot: dict[str, Any] = {
            "schema_version": 1,
            "hardware_snapshot_id": f"snapshot-{uuid.uuid4()}",
            "observed_at": observed_at or minutes_ago(5),
            "host_id": "gpu-uuid-1",
            "provenance": "detected",
            "gpus": gpus if gpus is not None else [dict(gpu, index=0), dict(gpu, index=1, uuid="GPU-uuid-1")],
            "topology": {"gpu_count": 2, "gpu_uuids": ["GPU-uuid-0"]},
            "nvidia_available": True,
            "cuda_version": "12.4",
            "kernel": "Linux 6.8.0-40-generic x86_64",
            "memory": {"total_bytes": 128 * 1024**3, "available_bytes": 96 * 1024**3},
            "docker": {"daemon": True},
        }
        self.store.put_hardware_snapshot(snapshot, self.run("seed"))
        return snapshot

    def benchmark(
        self,
        snapshot_id: str,
        model_id: str = "Qwen/Qwen2.5-7B-Instruct",
        quantization: str | None = "awq",
        runtime_major: str | None = "0",
        serving_spec: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        import random

        benchmark_id = f"bench-{uuid.uuid4()}"
        self.benchmark_ids.append(benchmark_id)
        model_ref: dict[str, Any] = {"schema_version": 1, "model_id": model_id, "revision": "abc123"}
        if quantization is not None:
            model_ref["quantization"] = quantization
        runtime_spec: dict[str, Any] = {"schema_version": 1, "runtime_kind": "vllm", "image_repository": "registry.example.com/bittune/vllm", "image_digest": "sha256:" + "c" * 64}
        if runtime_major is not None:
            runtime_spec["runtime_major"] = runtime_major
        payload: dict[str, Any] = {
            "schema_version": 1,
            "benchmark_result_id": benchmark_id,
            "service_instance_id": f"svc-{uuid.uuid4()}",
            "plan_id": f"plan-{uuid.uuid4()}",
            "model_ref": model_ref,
            "runtime_spec": runtime_spec,
            "serving_spec": serving_spec if serving_spec is not None else {"tensor_parallel_size": 2, "max_model_len": 8192},
            "hardware_snapshot_id": snapshot_id,
            "workload": {
                "schema_version": 1,
                "mode": "closed_loop",
                "concurrency": 4,
                "request_count": 100,
                "input_tokens": 512,
                "output_tokens": 256,
            },
            "workload_hash": "sha256:" + "d" * 64,
            "metrics": {
                "requests_per_second": 54.2 + random.random(),
                "output_tokens_per_second": 4320.1,
                "ttft_p50": 210.4,
            },
            "metric_distributions": {},
            "metric_normalizer_version": "evalscope-normalizer-v2",
            "measured_at": minutes_ago(2),
            "provenance": "measured",
        }
        self.store.put_benchmark_result(payload, self.run("seed"))
        return payload

    def experiment(
        self,
        baseline_payload: dict[str, Any],
        candidate_payload: dict[str, Any],
        verdict: str = "higher",
        objective: str = "requests_per_second",
        delta_percent: float = 35.5,
        baseline_value: float = 40.0,
        measured_value: float = 54.2,
    ) -> dict[str, Any]:
        experiment = {
            "schema_version": 1,
            "experiment_id": f"exp-{uuid.uuid4()}",
            "objective": objective,
            "hypothesis": "",
            "baseline_benchmark_result_id": baseline_payload["benchmark_result_id"],
            "compared_benchmark_result_ids": [candidate_payload["benchmark_result_id"]],
            "comparison_method": "deterministic-v1",
            "conclusion": {
                "comparison_method": "deterministic-v1",
                "interpretation": "",
                "comparable": True,
                "baseline_benchmark_result_id": baseline_payload["benchmark_result_id"],
                "compared_benchmark_result_ids": [candidate_payload["benchmark_result_id"]],
                "objective": objective,
                "deltas": [
                    {
                        "benchmark_result_id": candidate_payload["benchmark_result_id"],
                        "objective_metric": objective,
                        "baseline_value": baseline_value,
                        "measured_value": measured_value,
                        "delta_percent": delta_percent,
                        "verdict": verdict,
                    }
                ],
                "summary": "higher",
            },
            "created_at": utc_now(),
            "provenance": "derived",
        }
        self.store.put_experiment(experiment, self.run("seed"))
        return experiment

    def report(self, benchmark_payload: dict[str, Any], experiment: dict[str, Any] | None = None, with_run: str | None = None) -> dict[str, Any]:
        references: dict[str, Any] = {
            "benchmark_result_ids": [{"id": benchmark_payload["benchmark_result_id"], "kind": "benchmark_result"}],
        }
        if experiment is not None:
            references["experiment_ids"] = [{"id": experiment["experiment_id"], "kind": "experiment"}]
        if with_run is not None:
            references["run_ids"] = [{"id": with_run, "kind": "run"}]
        report = {
            "schema_version": 1,
            "report_id": f"report-{uuid.uuid4()}",
            "title": "export fixture report",
            "scope": "",
            "narrative": "measured",
            "conclusion": "measured",
            "references": references,
            "metric_claims": [],
            "artifact_ids": [],
            "created_at": utc_now(),
            "provenance": "derived",
        }
        self.store.put_report(report, self.run("seed"))
        return report

    def failed_run(self) -> str:
        run_id, _ = self.store.start_run("benchmark_service", "managed", {}, self.context["session_id"])
        self.store.finish_run(run_id, "failed", {"summary": "boom"})
        self.run_ids.append(run_id)
        return run_id

    def cancelled_run(self) -> str:
        run_id, _ = self.store.start_run("benchmark_service", "managed", {}, self.context["session_id"])
        self.store.finish_run(run_id, "cancelled", {"summary": "cancelled by user"})
        self.run_ids.append(run_id)
        return run_id

    def happy_path_facts(self, verdict: str = "higher", cancelled_run: bool = False, failed_run: bool = False) -> dict[str, Any]:
        snapshot = self.snapshot()
        candidate = self.benchmark(snapshot["hardware_snapshot_id"])
        # a baseline with the same comparability dims but lower rps
        baseline_payload = dict(candidate)
        baseline_payload["benchmark_result_id"] = f"bench-{uuid.uuid4()}"
        baseline_payload["metrics"] = {"requests_per_second": 40.0, "output_tokens_per_second": 3200.0}
        self.store.put_benchmark_result(baseline_payload, self.run("seed"))
        self.benchmark_ids.append(baseline_payload["benchmark_result_id"])
        experiment = self.experiment(baseline_payload, candidate, verdict)
        run_ref: str | None = None
        if cancelled_run:
            run_ref = self.cancelled_run()
        elif failed_run:
            run_ref = self.failed_run()
        report = self.report(candidate, experiment=experiment, with_run=run_ref)
        return {"snapshot": snapshot, "report": report, "candidate": candidate}


class BucketTests(unittest.TestCase):
    def test_vram_buckets_boundaries(self) -> None:
        gib = 1024**3
        self.assertEqual(_vram_bucket(4 * gib), "lt8GiB")
        self.assertEqual(_vram_bucket(8 * gib), "8-16GiB")
        self.assertEqual(_vram_bucket(16 * gib), "16-24GiB")
        self.assertEqual(_vram_bucket(24 * gib), "24-48GiB")
        self.assertEqual(_vram_bucket(48 * gib), "48-80GiB")
        self.assertEqual(_vram_bucket(80 * gib), "gte80GiB")

    def test_token_buckets_boundaries(self) -> None:
        self.assertEqual(_token_bucket(1), "0-2048")
        self.assertEqual(_token_bucket(2048), "0-2048")
        self.assertEqual(_token_bucket(2049), "2049-8192")
        self.assertEqual(_token_bucket(32768), "8193-32768")
        self.assertEqual(_token_bucket(32769), "32769+")

    def test_load_buckets_boundaries(self) -> None:
        self.assertEqual(_load_bucket(1), "1")
        self.assertEqual(_load_bucket(8), "2-8")
        self.assertEqual(_load_bucket(32), "9-32")
        self.assertEqual(_load_bucket(33), "33+")


class PrepareRecommendationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.fixture = CloudFixture()

    def tearDown(self) -> None:
        self.fixture.close()

    def test_prepare_without_snapshot_rejects(self) -> None:
        with self.assertRaises(ContractError) as caught:
            cloud_prepare_recommendation(
                {
                    "intent": "fit_model",
                    "target": {"model_id": "Qwen/Qwen2.5-7B-Instruct"},
                    "workload": {"input_tokens": 512, "output_tokens": 256, "concurrency": 4},
                    "constraints": CONSTRAINTS,
                },
                self.fixture.context,
            )
        self.assertEqual(caught.exception.code, "not_found")

    def test_prepare_projects_environment_and_buckets(self) -> None:
        self.fixture.snapshot()
        result = cloud_prepare_recommendation(
            {
                "intent": "fit_model",
                "target": {"model_id": "Qwen/Qwen2.5-7B-Instruct"},
                "workload": {"input_tokens": 512, "output_tokens": 256, "concurrency": 4},
                "constraints": CONSTRAINTS,
            },
            self.fixture.context,
        )
        envelope = result["data"]["envelope"]
        payload = envelope["payload"]
        for key in ("request_hash", "environment_hash", "target_hash", "constraints_hash"):
            self.assertTrue(result["data"][key].startswith("sha256:"), key)
        self.assertEqual(envelope["schema_version"], "recommendation-v2")
        self.assertEqual(payload["intent"], "fit_model")
        self.assertEqual(payload["environment"]["gpu_arch"], "Ada")
        self.assertEqual(payload["environment"]["vram_bucket"], "48-80GiB")
        self.assertEqual(payload["environment"]["gpu_product"], "NVIDIA L40S")
        self.assertEqual(payload["environment"]["vram_gib"], 48)
        self.assertNotIn("driver_version", payload["environment"])
        self.assertEqual(result["data"]["binding"], "bound")
        self.assertEqual(result["data"]["environment_source"], "snapshot")
        self.assertNotIn("assumptions", result["data"])
        self.assertNotIn("binding", payload)
        self.assertEqual(payload["target"]["model_id"], "Qwen/Qwen2.5-7B-Instruct")
        self.assertNotIn("input_tokens", payload["target"])
        self.assertEqual(payload["workload"], {"input_tokens": 512, "output_tokens": 256, "concurrency": 4})
        self.assertEqual(payload["workload_buckets"], {"input_bucket": "0-2048", "output_bucket": "0-2048", "load_bucket": "2-8"})
        self.assertIn("request_id", envelope)

    def _named_gpu(self, name: str, capability: str, gib: int) -> dict[str, Any]:
        return {
            "index": 0,
            "uuid": "GPU-named",
            "name": name,
            "driver_version": "550.54.15",
            "compute_capability": capability,
            "memory_total_bytes": gib * 1024**3,
        }

    def _hopper(self, **extra: Any) -> dict[str, Any]:
        environment = {
            "gpu_arch": "Hopper",
            "gpu_count": 1,
            "vram_bucket": "gte80GiB",
            "driver_major": "550",
            "cuda_major": "12",
            "vram_gib": 80,
        }
        environment.update(extra)
        return {
            "intent": "fit_model",
            "target": {"model_id": "Qwen/Qwen2.5-7B-Instruct"},
            "constraints": CONSTRAINTS,
            "environment": environment,
        }

    def _block_snapshot_reads(self) -> None:
        original = self.fixture.store.list_facts

        def guarded(kind: str, limit: int = 20, **filters: Any) -> list[dict[str, Any]]:
            if kind == "hardware_snapshot":
                raise AssertionError("declared environment must not read a hardware snapshot")
            return original(kind, limit=limit, **filters)

        self.fixture.store.list_facts = guarded  # type: ignore[method-assign]

    def test_prepare_declared_hopper_does_not_read_snapshot(self) -> None:
        self.fixture.snapshot()
        self._block_snapshot_reads()
        result = cloud_prepare_recommendation(self._hopper(), self.fixture.context)
        payload = result["data"]["envelope"]["payload"]
        self.assertEqual(payload["environment"]["gpu_arch"], "Hopper")
        self.assertNotIn("gpu_product", payload["environment"])
        self.assertEqual(payload["environment"]["vram_gib"], 80)
        self.assertEqual(result["data"]["binding"], "declared")
        self.assertEqual(result["data"]["environment_source"], "declared")
        self.assertEqual(result["data"]["assumptions"], ["driver_major", "cuda_major"])
        self.assertIn("调用方假设", result["summary"])
        self.assertNotIn("检测结果", result["summary"].replace("不是检测结果", ""))
        for field in ("binding", "environment_source", "assumptions", "gpu_product_note"):
            self.assertNotIn(field, payload)
        observation = self.fixture.store.get_run(result["run_id"])["observation"]
        self.assertEqual(observation["binding"], "declared")
        self.assertEqual(observation["assumptions"], ["driver_major", "cuda_major"])

    def test_prepare_bound_lookup_key_and_vram_floor(self) -> None:
        self.fixture.snapshot([self._named_gpu("NVIDIA GeForce RTX 5090", "10.0", 32)])
        raw = cloud_prepare_recommendation(
            {"intent": "fit_model", "target": {"model_id": "Qwen/Qwen2.5-7B-Instruct"}, "constraints": CONSTRAINTS},
            self.fixture.context,
        )
        environment = raw["data"]["envelope"]["payload"]["environment"]
        self.assertEqual(environment["gpu_product"], "NVIDIA GeForce RTX 5090")
        self.assertNotEqual(environment["gpu_product"], "RTX 5090")
        self.assertEqual(environment["vram_gib"], 32)

        self.fixture.snapshot([self._named_gpu("Unknown Accelerator", "8.9", 48)], observed_at=minutes_ago(1))
        unmapped = cloud_prepare_recommendation(
            {"intent": "fit_model", "target": {"model_id": "Qwen/Qwen2.5-7B-Instruct"}, "constraints": CONSTRAINTS},
            self.fixture.context,
        )
        unmapped_env = unmapped["data"]["envelope"]["payload"]["environment"]
        self.assertNotIn("gpu_product", unmapped_env)
        self.assertEqual(unmapped_env["vram_gib"], 48)
        self.assertEqual(unmapped_env["gpu_arch"], "Ada")

    def test_prepare_declared_product_is_lookup_key_or_omitted(self) -> None:
        self.fixture.snapshot()
        self._block_snapshot_reads()
        family = cloud_prepare_recommendation(self._hopper(gpu_product="H100"), self.fixture.context)
        family_env = family["data"]["envelope"]["payload"]["environment"]
        self.assertNotIn("gpu_product", family_env)
        self.assertEqual(family_env["gpu_arch"], "Hopper")
        self.assertEqual(family_env["vram_gib"], 80)
        self.assertIn("H100", family["data"]["gpu_product_note"])
        self.assertIn("不是查找键", family["data"]["gpu_product_note"])
        self.assertTrue(family["data"]["request_hash"].startswith("sha256:"))
        observation = self.fixture.store.get_run(family["run_id"])["observation"]
        self.assertEqual(observation["gpu_product_note"], family["data"]["gpu_product_note"])

        exact = cloud_prepare_recommendation(self._hopper(gpu_product="NVIDIA H100 80GB HBM3"), self.fixture.context)
        self.assertEqual(exact["data"]["envelope"]["payload"]["environment"]["gpu_product"], "NVIDIA H100 80GB HBM3")
        self.assertNotIn("gpu_product_note", exact["data"])

        omitted = cloud_prepare_recommendation(self._hopper(), self.fixture.context)
        omitted_env = omitted["data"]["envelope"]["payload"]["environment"]
        self.assertNotIn("gpu_product", omitted_env)
        self.assertEqual(omitted_env["gpu_arch"], "Hopper")
        self.assertEqual(omitted_env["vram_gib"], 80)
        self.assertNotIn("gpu_product_note", omitted["data"])

        with self.assertRaises(ContractError) as caught:
            cloud_prepare_recommendation({**self._hopper(), "snapshot_id": "snapshot-1"}, self.fixture.context)
        self.assertEqual(caught.exception.code, "invalid_input")

    def test_prepare_shortlist_and_coverage_omit_model_id(self) -> None:
        self.fixture.snapshot()
        for intent in ("shortlist_models", "coverage"):
            result = cloud_prepare_recommendation({"intent": intent, "constraints": CONSTRAINTS, "scenario": "chat"}, self.fixture.context)
            payload = result["data"]["envelope"]["payload"]
            self.assertNotIn("target", payload)
            self.assertEqual(result["data"]["target_hash"], cloud_canonical_hash({}))
            self.assertEqual(payload["workload"], {"input_tokens": 1024, "output_tokens": 256, "concurrency": 4})
            self.assertEqual(payload["workload_buckets"]["output_bucket"], "0-2048")

    def test_prepare_scenario_defaults_not_representative_table(self) -> None:
        self.fixture.snapshot()
        result = cloud_prepare_recommendation(
            {"intent": "shortlist_models", "constraints": CONSTRAINTS, "scenario": "chat"},
            self.fixture.context,
        )
        workload = result["data"]["envelope"]["payload"]["workload"]
        self.assertEqual(workload["output_tokens"], 256)
        self.assertNotEqual(workload["output_tokens"], 1024)

    def test_prepare_buckets_only_uses_representative_raw(self) -> None:
        self.fixture.snapshot()
        result = cloud_prepare_recommendation(
            {
                "intent": "shortlist_models",
                "constraints": CONSTRAINTS,
                "workload_buckets": {"input_bucket": "8193-32768", "output_bucket": "0-2048", "load_bucket": "2-8"},
            },
            self.fixture.context,
        )
        payload = result["data"]["envelope"]["payload"]
        self.assertEqual(payload["workload"], {"input_tokens": 16384, "output_tokens": 1024, "concurrency": 4})
        self.assertEqual(payload["workload_buckets"]["input_bucket"], "8193-32768")

    def test_prepare_empty_workload_omits_both(self) -> None:
        self.fixture.snapshot()
        result = cloud_prepare_recommendation(
            {"intent": "fit_model", "target": {"model_id": "Qwen/Qwen2.5-7B-Instruct"}, "constraints": CONSTRAINTS},
            self.fixture.context,
        )
        payload = result["data"]["envelope"]["payload"]
        self.assertNotIn("workload", payload)
        self.assertNotIn("workload_buckets", payload)

    def test_prepare_intent_required_fields(self) -> None:
        self.fixture.snapshot()
        cases = [
            {"constraints": CONSTRAINTS},
            {"intent": "fit_model", "constraints": CONSTRAINTS},
            {"intent": "search_layout", "target": {"model_id": "Qwen/Qwen2.5-7B-Instruct"}, "constraints": CONSTRAINTS},
            {"intent": "score_layout", "target": {"model_id": "Qwen/Qwen2.5-7B-Instruct"}, "constraints": CONSTRAINTS},
            {"intent": "compare_models", "constraints": CONSTRAINTS},
        ]
        for params in cases:
            with self.assertRaises(ContractError, msg=str(params)):
                cloud_prepare_recommendation(params, self.fixture.context)

    def test_prepare_validates_frozen_ranges(self) -> None:
        self.fixture.snapshot()
        cases = [
            {"intent": "fit_model", "target": {"model_id": "bad model"}, "constraints": CONSTRAINTS},
            {"intent": "fit_model", "target": {"model_id": "m"}, "workload": {"input_tokens": 0, "output_tokens": 1, "concurrency": 1}, "constraints": CONSTRAINTS},
            {"intent": "fit_model", "target": {"model_id": "m", "extra": 1}, "constraints": CONSTRAINTS},
            {"intent": "fit_model", "target": {"model_id": "m", "runtime_kind": "tgi"}, "constraints": CONSTRAINTS},
            {"intent": "fit_model", "target": {"model_id": "m"}, "constraints": {"must_be_offline": True, "max_memory_percent": 101}},
        ]
        for params in cases:
            with self.assertRaises(ContractError, msg=str(params)):
                cloud_prepare_recommendation(params, self.fixture.context)

    def test_forbidden_fields_are_refused(self) -> None:
        with self.assertRaises(ContractError):
            _scan_forbidden({"ok": True, "token": "x"})
        with self.assertRaises(ContractError):
            _scan_forbidden({"nested": {"hostname": "x"}})

    def test_record_recommendation_rejects_v1_body(self) -> None:
        response = {
            "schema_version": "recommendation-v1",
            "rules_version": "matching_rules-v1",
            "request_id": "req-0123456789abcdef0123456789abcdef",
            "request_hash": "sha256:" + "e" * 64,
            "candidates": [],
        }
        hashes = {"request_hash": "sha256:" + "e" * 64, "environment_hash": "sha256:" + "f" * 64, "target_hash": "sha256:" + "f" * 64, "constraints_hash": "sha256:" + "f" * 64}
        with self.assertRaises(ContractError) as caught:
            record_cloud_recommendation({"response": response, **hashes}, self.fixture.context)
        self.assertEqual(caught.exception.code, "unsupported_contract")
        self.assertEqual(caught.exception.details.get("supported"), ["recommendation-v2"])
        missing = {"rules_version": "serving_search-v1", "candidates": []}
        with self.assertRaises(ContractError) as caught:
            record_cloud_recommendation({"response": missing, **hashes}, self.fixture.context)
        self.assertEqual(caught.exception.details.get("supported"), ["recommendation-v2"])

    def test_record_v2_fixtures(self) -> None:
        for name in (
            "v2-response-shortlist.json",
            "v2-response-search.json",
            "v2-response-coverage.json",
            "v2-response-fit-no-workload.json",
        ):
            result = record_cloud_recommendation(record_params(load_fixture(name)), self.fixture.context)
            self.assertGreaterEqual(result["data"]["candidate_count"], 0, name)
            self.assertTrue(result["data"]["artifact_id"].startswith("artifact-"), name)

    def test_record_v2_empty_candidates(self) -> None:
        response = load_fixture("v2-response-shortlist.json")
        response["candidates"] = []
        result = record_cloud_recommendation(record_params(response), self.fixture.context)
        self.assertEqual(result["data"]["candidate_count"], 0)
        self.assertEqual(result["data"]["binding"], "bound")
        self.assertEqual(result["data"]["environment_source"], "snapshot")

    def test_record_stores_declared_binding_outside_cloud_artifact(self) -> None:
        response = load_fixture("v2-response-shortlist.json")
        note = "提供的名字 H100 不是查找键。"
        result = record_cloud_recommendation(
            {**record_params(response), "binding": "declared", "environment_source": "declared", "gpu_product_note": note},
            self.fixture.context,
        )
        self.assertEqual(result["data"]["binding"], "declared")
        self.assertEqual(result["data"]["environment_source"], "declared")
        self.assertEqual(result["data"]["gpu_product_note"], note)
        observation = self.fixture.store.get_run(result["run_id"])["observation"]
        self.assertEqual(observation["binding"], "declared")
        self.assertEqual(observation["gpu_product_note"], note)
        artifact = json.loads(self.fixture.store.read_artifact_text(result["data"]["artifact_id"])["text"])
        self.assertNotIn("binding", artifact)
        self.assertNotIn("gpu_product_note", artifact)

    def test_record_v2_poison_duplicate_or_entry_id(self) -> None:
        duplicate = load_fixture("v2-response-search.json")
        duplicate["candidates"][1]["candidate_id"] = duplicate["candidates"][0]["candidate_id"]
        with self.assertRaises(ContractError) as caught:
            record_cloud_recommendation(record_params(duplicate), self.fixture.context)
        self.assertEqual(caught.exception.code, "unsupported_contract")

        equal_entry = load_fixture("v2-response-shortlist.json")
        equal_entry["candidates"][0]["candidate_id"] = equal_entry["candidates"][0]["source"]["entry_id"]
        with self.assertRaises(ContractError) as caught:
            record_cloud_recommendation(record_params(equal_entry), self.fixture.context)
        self.assertEqual(caught.exception.code, "unsupported_contract")

    def test_record_v2_poison_gpu_device_ids_and_missing_digest(self) -> None:
        devices = load_fixture("v2-response-shortlist.json")
        devices["candidates"][0]["serving_config"]["gpu_device_ids"] = [0, 1]
        with self.assertRaises(ContractError):
            record_cloud_recommendation(record_params(devices), self.fixture.context)

        missing_digest = load_fixture("v2-response-shortlist.json")
        del missing_digest["candidates"][0]["runtime_spec"]["image_digest"]
        with self.assertRaises(ContractError):
            record_cloud_recommendation(record_params(missing_digest), self.fixture.context)

        predicted_without = load_fixture("v2-response-search.json")
        del predicted_without["candidates"][0]["prediction"]
        with self.assertRaises(ContractError):
            record_cloud_recommendation(record_params(predicted_without), self.fixture.context)

        catalog_without_entry = load_fixture("v2-response-shortlist.json")
        del catalog_without_entry["candidates"][0]["source"]["entry_id"]
        with self.assertRaises(ContractError):
            record_cloud_recommendation(record_params(catalog_without_entry), self.fixture.context)

    def test_record_outcome_and_session_status(self) -> None:
        hashes = {"request_hash": "sha256:" + "a" * 64, **RECORD_HASHES}
        none = cloud_session_recommend_status({}, self.fixture.context)
        self.assertEqual(none["status"], "none")

        outcome = record_cloud_recommendation_outcome(
            {**hashes, "outcome": "http_error", "http_status": 500, "error_code": "internal_error"},
            self.fixture.context,
        )
        self.assertEqual(outcome["data"]["outcome"], "http_error")
        status = cloud_session_recommend_status({}, self.fixture.context)
        self.assertEqual(status["status"], "outcome")
        self.assertEqual(status["run_id"], outcome["run_id"])
        self.assertNotIn("artifact_id", status)
        excerpt = self.fixture.store.read_artifact_excerpt(outcome["data"]["artifact_id"], max_bytes=65536)
        self.assertEqual(excerpt["label"], "cloud-recommendation-attempt")

    def test_session_status_finds_recommendation_past_list_runs_window(self) -> None:
        recorded = record_cloud_recommendation(record_params(load_fixture("v2-response-shortlist.json")), self.fixture.context)
        for _ in range(101):
            self.fixture.run("inspect_environment")
        listed = self.fixture.store.list_runs(status="completed", limit=100)
        self.assertEqual(len(listed), 100)
        self.assertFalse(any(item["run_id"] == recorded["run_id"] for item in listed))
        status = cloud_session_recommend_status({}, self.fixture.context)
        self.assertEqual(status["status"], "recorded")
        self.assertEqual(status["run_id"], recorded["run_id"])
        self.assertEqual(status["artifact_id"], recorded["data"]["artifact_id"])

    def test_record_v2_rejects_unknown_prediction_metrics(self) -> None:
        extra = load_fixture("v2-response-search.json")
        extra["candidates"][0]["prediction"]["metrics"]["p99_ttft_ms"] = 200
        with self.assertRaises(ContractError) as caught:
            record_cloud_recommendation(record_params(extra), self.fixture.context)
        self.assertEqual(caught.exception.code, "unsupported_contract")

        itl = load_fixture("v2-response-search.json")
        itl["candidates"][0]["prediction"]["metrics"]["mean_itl_ms"] = 10
        with self.assertRaises(ContractError) as caught:
            record_cloud_recommendation(record_params(itl), self.fixture.context)
        self.assertEqual(caught.exception.code, "unsupported_contract")

    def test_record_v2_rejects_predicted_without_simulated_basis(self) -> None:
        missing_simulated = load_fixture("v2-response-search.json")
        missing_simulated["measurement_basis"] = ["catalog"]
        with self.assertRaises(ContractError) as caught:
            record_cloud_recommendation(record_params(missing_simulated), self.fixture.context)
        self.assertEqual(caught.exception.code, "unsupported_contract")
        self.assertIn("simulated", caught.exception.message)

        shortlist = load_fixture("v2-response-shortlist.json")
        result = record_cloud_recommendation(record_params(shortlist), self.fixture.context)
        self.assertGreaterEqual(result["data"]["candidate_count"], 1)


class ExperienceExportTests(unittest.TestCase):
    def setUp(self) -> None:
        self.fixture = CloudFixture()

    def tearDown(self) -> None:
        self.fixture.close()

    def test_preview_is_stable_and_whitelisted(self) -> None:
        facts = self.fixture.happy_path_facts(verdict="higher")
        first = cloud_experience_preview({"report_id": facts["report"]["report_id"]}, self.fixture.context)
        second = cloud_experience_preview({"report_id": facts["report"]["report_id"]}, self.fixture.context)
        self.assertEqual(first["data"]["content_hash"], second["data"]["content_hash"])
        preview = first["data"]["preview"]
        self.assertEqual(preview["schema_version"], "experience-export-v2")
        self.assertEqual(preview["outcome"], "success")
        self.assertEqual(preview["model"]["quantization"], "awq")
        self.assertIn("delta", preview)
        self.assertIn("baseline", preview)
        # Phase 3: the preview carries display-only guidance whose defaults
        # never touch the uploaded payload.
        display = first["data"]["display"]
        self.assertEqual(display["defaults"], {"visibility_scope": "private", "author_display": "anonymous"})
        self.assertEqual(len(display["publication_consent_fields"]), 8)
        self.assertTrue(display["retraction_note"])
        self.assertGreaterEqual(len(display["never_uploaded"]), 3)
        self.assertIn("compare_rank_note", display)
        preview_env = preview["environment"]
        self.assertEqual(preview_env["gpu_product"], "L40S")
        self.assertEqual(preview["evidence_level"], "local_measured")
        self.assertEqual(preview["workload"]["concurrency"], 4)
        self.assertEqual(preview["runtime"]["runtime_version"], "0")
        self.assertEqual(preview["delta"]["objective_metric"], "requests_per_second")
        self.assertGreater(preview["delta"]["value_pct"], 0)

    def test_export_maps_4090_and_omits_unmapped_product(self) -> None:
        gpu_4090 = {
            "index": 0,
            "uuid": "GPU-4090",
            "name": "NVIDIA GeForce RTX 4090",
            "driver_version": "550.54.15",
            "compute_capability": "8.9",
            "memory_total_bytes": 24 * 1024**3,
            "memory_free_bytes": 20 * 1024**3,
            "utilization_percent": 1,
            "power_watts": 40,
        }
        snapshot = self.fixture.snapshot(gpus=[gpu_4090])
        candidate = self.fixture.benchmark(snapshot["hardware_snapshot_id"])
        baseline = dict(candidate)
        baseline["benchmark_result_id"] = f"bench-{uuid.uuid4()}"
        baseline["metrics"] = {"requests_per_second": 40.0, "output_tokens_per_second": 3200.0, "mean_e2e_latency_ms": 600.0}
        self.fixture.store.put_benchmark_result(baseline, self.fixture.run("seed"))
        experiment = self.fixture.experiment(baseline, candidate)
        report = self.fixture.report(candidate, experiment)
        preview = cloud_experience_preview({"report_id": report["report_id"]}, self.fixture.context)["data"]["preview"]
        self.assertEqual(preview["environment"]["gpu_product"], "RTX 4090")
        self.assertEqual(preview["environment"]["vram_gib"], 24)
        self.assertIn(preview["environment"]["vram_bucket"], ("16-24GiB", "24-48GiB"))

        unknown = dict(gpu_4090, name="Unknown Accelerator")
        snapshot2 = self.fixture.snapshot(gpus=[unknown])
        candidate2 = self.fixture.benchmark(snapshot2["hardware_snapshot_id"])
        experiment2 = self.fixture.experiment(baseline, candidate2)
        report2 = self.fixture.report(candidate2, experiment2)
        preview2 = cloud_experience_preview({"report_id": report2["report_id"]}, self.fixture.context)["data"]["preview"]
        self.assertNotIn("gpu_product", preview2["environment"])
        self.assertIn("不能进入选型对比", cloud_experience_preview({"report_id": report2["report_id"]}, self.fixture.context)["data"]["display"]["compare_rank_note"])

    def test_mixed_gpus_omit_product_and_vram_gib(self) -> None:
        left = {
            "index": 0, "uuid": "GPU-a", "name": "NVIDIA GeForce RTX 4090", "driver_version": "550.54.15",
            "compute_capability": "8.9", "memory_total_bytes": 24 * 1024**3, "memory_free_bytes": 20 * 1024**3,
            "utilization_percent": 1, "power_watts": 40,
        }
        right = dict(left, index=1, uuid="GPU-b", name="NVIDIA L40S", memory_total_bytes=48 * 1024**3)
        snapshot = self.fixture.snapshot(gpus=[left, right])
        candidate = self.fixture.benchmark(snapshot["hardware_snapshot_id"])
        baseline = dict(candidate)
        baseline["benchmark_result_id"] = f"bench-{uuid.uuid4()}"
        baseline["metrics"] = {"requests_per_second": 40.0}
        self.fixture.store.put_benchmark_result(baseline, self.fixture.run("seed"))
        experiment = self.fixture.experiment(baseline, candidate)
        report = self.fixture.report(candidate, experiment)
        env = cloud_experience_preview({"report_id": report["report_id"]}, self.fixture.context)["data"]["preview"]["environment"]
        self.assertNotIn("gpu_product", env)
        self.assertNotIn("vram_gib", env)
        self.assertIn("vram_bucket", env)

    def test_latency_improvement_normalizes_to_positive_value_pct(self) -> None:
        snapshot = self.fixture.snapshot()
        candidate = self.fixture.benchmark(snapshot["hardware_snapshot_id"])
        candidate["metrics"] = {
            **candidate["metrics"],
            "mean_e2e_latency_ms": 480.0,
            "requests_per_second": 54.2,
        }
        candidate["benchmark_result_id"] = f"bench-{uuid.uuid4()}"
        self.fixture.store.put_benchmark_result(candidate, self.fixture.run("seed"))
        baseline = dict(candidate)
        baseline["benchmark_result_id"] = f"bench-{uuid.uuid4()}"
        baseline["metrics"] = {"requests_per_second": 40.0, "mean_e2e_latency_ms": 600.0}
        self.fixture.store.put_benchmark_result(baseline, self.fixture.run("seed"))
        experiment = self.fixture.experiment(
            baseline,
            candidate,
            objective="mean_e2e_latency_ms",
            delta_percent=-20.0,
            baseline_value=600.0,
            measured_value=480.0,
        )
        report = self.fixture.report(candidate, experiment)
        delta = cloud_experience_preview({"report_id": report["report_id"]}, self.fixture.context)["data"]["preview"]["delta"]
        self.assertEqual(delta["objective_metric"], "mean_e2e_latency_ms")
        self.assertEqual(delta["target"], "lower_better")
        self.assertEqual(delta["value_pct"], 20.0)

    def test_success_rate_is_higher_better(self) -> None:
        snapshot = self.fixture.snapshot()
        candidate = self.fixture.benchmark(snapshot["hardware_snapshot_id"])
        candidate["metrics"] = {**candidate["metrics"], "success_rate": 0.98}
        candidate["benchmark_result_id"] = f"bench-{uuid.uuid4()}"
        self.fixture.store.put_benchmark_result(candidate, self.fixture.run("seed"))
        baseline = dict(candidate)
        baseline["benchmark_result_id"] = f"bench-{uuid.uuid4()}"
        baseline["metrics"] = {"success_rate": 0.90}
        self.fixture.store.put_benchmark_result(baseline, self.fixture.run("seed"))
        experiment = self.fixture.experiment(
            baseline,
            candidate,
            objective="success_rate",
            delta_percent=8.89,
            baseline_value=0.90,
            measured_value=0.98,
        )
        report = self.fixture.report(candidate, experiment)
        delta = cloud_experience_preview({"report_id": report["report_id"]}, self.fixture.context)["data"]["preview"]["delta"]
        self.assertEqual(delta["objective_metric"], "success_rate")
        self.assertEqual(delta["target"], "higher_better")
        self.assertGreater(delta["value_pct"], 0)

    def test_metric_export_attaches_finite_stdev(self) -> None:
        snapshot = self.fixture.snapshot()
        candidate = self.fixture.benchmark(snapshot["hardware_snapshot_id"])
        candidate["metrics"] = {
            **candidate["metrics"],
            "mean_e2e_latency_ms": 480.0,
            "mean_e2e_latency_ms_standard_deviation": 12.5,
        }
        candidate["benchmark_result_id"] = f"bench-{uuid.uuid4()}"
        self.fixture.store.put_benchmark_result(candidate, self.fixture.run("seed"))
        baseline = dict(candidate)
        baseline["benchmark_result_id"] = f"bench-{uuid.uuid4()}"
        baseline["metrics"] = {"mean_e2e_latency_ms": 600.0}
        self.fixture.store.put_benchmark_result(baseline, self.fixture.run("seed"))
        experiment = self.fixture.experiment(
            baseline,
            candidate,
            objective="mean_e2e_latency_ms",
            delta_percent=-20.0,
            baseline_value=600.0,
            measured_value=480.0,
        )
        report = self.fixture.report(candidate, experiment)
        metrics = cloud_experience_preview({"report_id": report["report_id"]}, self.fixture.context)["data"]["preview"]["metrics"]
        latency = next(item for item in metrics if item["name"] == "mean_e2e_latency_ms")
        self.assertEqual(latency["stdev"], 12.5)

    def test_preview_needs_benchmark_reference(self) -> None:
        run_id = self.fixture.run("seed")
        report = {
            "schema_version": 1,
            "report_id": f"report-{uuid.uuid4()}",
            "title": "no refs",
            "references": {},
            "created_at": utc_now(),
            "provenance": "derived",
        }
        self.fixture.store.put_report(report, run_id)
        with self.assertRaises(ContractError):
            cloud_experience_preview({"report_id": report["report_id"]}, self.fixture.context)

    def test_export_requires_quantization_and_runtime_major(self) -> None:
        snapshot = self.fixture.snapshot()
        benchmark = self.fixture.benchmark(snapshot["hardware_snapshot_id"], quantization=None)
        report = self.fixture.report(benchmark)
        with self.assertRaises(ContractError) as caught:
            cloud_experience_preview({"report_id": report["report_id"]}, self.fixture.context)
        self.assertIn("quantization", str(caught.exception))

        benchmark2 = self.fixture.benchmark(snapshot["hardware_snapshot_id"], runtime_major=None)
        report2 = self.fixture.report(benchmark2)
        with self.assertRaises(ContractError):
            cloud_experience_preview({"report_id": report2["report_id"]}, self.fixture.context)

    def test_outcome_mapping_across_verdicts(self) -> None:
        for verdict, expected in (("higher", "success"), ("within_1pct", "no_gain"), ("lower", "no_gain")):
            fixture = CloudFixture()
            try:
                facts = fixture.happy_path_facts(verdict=verdict)
                preview = cloud_experience_preview({"report_id": facts["report"]["report_id"]}, fixture.context)
                self.assertEqual(preview["data"]["preview"]["outcome"], expected, verdict)
            finally:
                fixture.close()

    def test_failed_and_cancelled_runs_map_without_experiments(self) -> None:
        for kind, expected in (("failed", "failure"), ("cancelled", "cancelled")):
            fixture = CloudFixture()
            try:
                snapshot = fixture.snapshot()
                benchmark = fixture.benchmark(snapshot["hardware_snapshot_id"])
                run_ref = fixture.failed_run() if kind == "failed" else fixture.cancelled_run()
                report = fixture.report(benchmark, with_run=run_ref)
                preview = cloud_experience_preview({"report_id": report["report_id"]}, fixture.context)
                self.assertEqual(preview["data"]["preview"]["outcome"], expected, kind)
            finally:
                fixture.close()

    def test_report_without_experiment_or_terminal_run_rejects(self) -> None:
        snapshot = self.fixture.snapshot()
        benchmark = self.fixture.benchmark(snapshot["hardware_snapshot_id"])
        report = self.fixture.report(benchmark)
        with self.assertRaises(ContractError):
            cloud_experience_preview({"report_id": report["report_id"]}, self.fixture.context)


class OutboxTests(unittest.TestCase):
    def setUp(self) -> None:
        self.fixture = CloudFixture()
        facts = self.fixture.happy_path_facts(verdict="higher")
        self.report_id = facts["report"]["report_id"]

    def tearDown(self) -> None:
        self.fixture.close()

    def enqueue(self) -> dict[str, Any]:
        result = cloud_experience_enqueue({"report_id": self.report_id}, self.fixture.context)
        return result["data"]

    def test_enqueue_list_cancel_lifecycle(self) -> None:
        queued = self.enqueue()
        export_id = queued["export_id"]
        self.assertEqual(queued["status"], "pending")
        listing = cloud_outbox_list({}, self.fixture.context)["data"]["outbox"]
        self.assertEqual(len(listing), 1)
        cancelled = cloud_outbox_cancel({"export_id": export_id}, self.fixture.context)["data"]
        self.assertEqual(cancelled["status"], "cancelled")
        with self.assertRaises(ContractError):
            cloud_outbox_cancel({"export_id": export_id}, self.fixture.context)

    def test_claim_complete_and_conflicts(self) -> None:
        export_id = self.enqueue()["export_id"]
        claimed = cloud_outbox_claim({"export_id": export_id}, self.fixture.context)["data"]
        self.assertEqual(claimed["status"], "sending")
        self.assertEqual(claimed["attempts"], 1)
        with self.assertRaises(ContractError):
            cloud_outbox_claim({"export_id": export_id}, self.fixture.context)
        completed = cloud_outbox_complete({"export_id": export_id, "cloud_response": {"status": "received"}}, self.fixture.context)["data"]
        self.assertEqual(completed["status"], "sent")
        with self.assertRaises(ContractError):
            cloud_outbox_complete({"export_id": export_id}, self.fixture.context)

    def test_fail_then_retry_claim(self) -> None:
        export_id = self.enqueue()["export_id"]
        cloud_outbox_claim({"export_id": export_id}, self.fixture.context)
        failed = cloud_outbox_fail({"export_id": export_id, "last_error": "timeout"}, self.fixture.context)["data"]
        self.assertEqual(failed["status"], "failed")
        self.assertIn("timeout", failed["last_error"])
        reclaimed = cloud_outbox_claim({"export_id": export_id}, self.fixture.context)["data"]
        self.assertEqual(reclaimed["status"], "sending")
        self.assertEqual(reclaimed["attempts"], 2)

    def test_retract_after_sent(self) -> None:
        export_id = self.enqueue()["export_id"]
        cloud_outbox_claim({"export_id": export_id}, self.fixture.context)
        cloud_outbox_complete({"export_id": export_id}, self.fixture.context)
        retracted = cloud_outbox_mark_retracted({"export_id": export_id}, self.fixture.context)["data"]
        self.assertEqual(retracted["status"], "retracted")

    def test_stale_sending_recovers_on_reopen(self) -> None:
        export_id = self.enqueue()["export_id"]
        cloud_outbox_claim({"export_id": export_id}, self.fixture.context)
        # Simulate a dead session: a fresh store sees `sending` as stale.
        self.fixture.store.close()
        store2 = CoreStore(self.fixture.home)
        try:
            store2.outbox_recover()
            row = store2.outbox_get(export_id)
            self.assertEqual(row["status"], "failed")
        finally:
            store2.close()

    def test_hash_tampering_is_detected(self) -> None:
        export_id = self.enqueue()["export_id"]
        connection = sqlite3.connect(self.fixture.home / "bittune.db")
        connection.execute("UPDATE cloud_outbox SET payload_json = '{}' WHERE export_id = ?", (export_id,))
        connection.commit()
        connection.close()
        with self.assertRaises(ContractError) as caught:
            self.fixture.store.outbox_get(export_id)
        self.assertEqual(caught.exception.code, "state_conflict")

    def test_inspect_records_outbox_kind(self) -> None:
        from bittune_core.evidence import inspect_records

        self.enqueue()
        result = inspect_records({"kind": "cloud_outbox"}, self.fixture.context)
        self.assertEqual(len(result["outbox"]), 1)


class ExportSizeAndForbiddenTests(unittest.TestCase):
    def test_forbidden_serving_config_rejected(self) -> None:
        fixture = CloudFixture()
        try:
            snapshot = fixture.snapshot()
            benchmark = fixture.benchmark(snapshot["hardware_snapshot_id"], serving_spec={"api_key": "leak"})
            report = fixture.report(benchmark)
            with self.assertRaises(ContractError) as caught:
                cloud_experience_preview({"report_id": report["report_id"]}, fixture.context)
            self.assertEqual(caught.exception.code, "forbidden_field")
        finally:
            fixture.close()


if __name__ == "__main__":
    unittest.main()

class ProjectionTrustTests(unittest.TestCase):
    """Review follow-ups: cuda_major truthfulness, config whitelisting and
    recommendation response validation."""

    def setUp(self) -> None:
        self.fixture = CloudFixture()

    def tearDown(self) -> None:
        self.fixture.close()

    def test_environment_projection_rejects_missing_cuda_version(self) -> None:
        snapshot = self.fixture.snapshot()
        snapshot.pop("cuda_version", None)
        # New snapshot without cuda_version: recommendation projection must refuse.
        store = self.fixture.store
        import uuid as _uuid
        tampered = dict(snapshot)
        tampered["hardware_snapshot_id"] = f"snapshot-{_uuid.uuid4()}"
        tampered["observed_at"] = utc_now()
        store.put_hardware_snapshot(tampered, self.fixture.run("seed"))
        params = {
            "intent": "fit_model",
            "target": {"model_id": "Qwen/Qwen2.5-7B-Instruct"},
            "workload": {"input_tokens": 512, "output_tokens": 256, "concurrency": 4},
            "constraints": CONSTRAINTS,
        }
        with self.assertRaises(ContractError) as caught:
            cloud_prepare_recommendation(params, self.fixture.context)
        self.assertIn("cuda_version", str(caught.exception))

    def test_export_config_whitelist_and_scalars(self) -> None:
        snapshot = self.fixture.snapshot()
        benchmark = self.fixture.benchmark(snapshot["hardware_snapshot_id"], serving_spec={"not_a_runtime_param": 1, "max_model_len": 8192})
        report = self.fixture.report(benchmark)
        with self.assertRaises(ContractError) as caught:
            cloud_experience_preview({"report_id": report["report_id"]}, self.fixture.context)
        self.assertIn("允许字段", str(caught.exception))

        nested = self.fixture.benchmark(snapshot["hardware_snapshot_id"], serving_spec={"max_model_len": {"deep": 1}})
        nested_report = self.fixture.report(nested)
        with self.assertRaises(ContractError):
            cloud_experience_preview({"report_id": nested_report["report_id"]}, self.fixture.context)

    def test_record_recommendation_validates_response(self) -> None:
        good = {
            "schema_version": "recommendation-v2",
            "rules_version": "serving_search-v1",
            "request_id": "req-0123456789abcdef0123456789abcdef",
            "request_hash": "sha256:" + "a" * 64,
            "measurement_basis": ["catalog"],
            "candidates": [
                {
                    "candidate_id": "entry-1__catalog__0",
                    "catalog_version": 1,
                    "model_ref": {"model_id": "Qwen/Qwen2.5-7B-Instruct", "revision": "abc123", "quantization": "awq"},
                    "runtime_spec": {"runtime_kind": "vllm", "runtime_major": "0", "image_repository": "registry.example.com/x", "image_digest": "sha256:" + "c" * 64},
                    "environment_requirements": {"gpu_arch": "Ada", "min_gpu_count": 1, "vram_bucket": "24-48GiB"},
                    "serving_config": {"max_model_len": 8192},
                    "source": {"kind": "catalog", "entry_id": "entry-1"},
                }
            ],
        }
        result = record_cloud_recommendation({"response": good, "request_hash": "sha256:" + "a" * 64, "environment_hash": "sha256:" + "f" * 64, "target_hash": "sha256:" + "f" * 64, "constraints_hash": "sha256:" + "f" * 64}, self.fixture.context)
        self.assertEqual(result["data"]["candidate_count"], 1)

        wrong_hash = {**good, "request_hash": "sha256:" + "b" * 64}
        with self.assertRaises(ContractError):
            record_cloud_recommendation({"response": wrong_hash, "request_hash": "sha256:" + "a" * 64, "environment_hash": "sha256:" + "f" * 64, "target_hash": "sha256:" + "f" * 64, "constraints_hash": "sha256:" + "f" * 64}, self.fixture.context)

        poisoned = {**good, "candidates": [{**good["candidates"][0], "serving_config": {"api_key": "leak"}}]}
        with self.assertRaises(ContractError) as caught:
            record_cloud_recommendation({"response": poisoned, "request_hash": "sha256:" + "a" * 64, "environment_hash": "sha256:" + "f" * 64, "target_hash": "sha256:" + "f" * 64, "constraints_hash": "sha256:" + "f" * 64}, self.fixture.context)
        self.assertEqual(caught.exception.code, "forbidden_field")

        broken = {**good, "candidates": [{**good["candidates"][0], "runtime_spec": {**good["candidates"][0]["runtime_spec"], "runtime_major": "v0"}}]}
        with self.assertRaises(ContractError):
            record_cloud_recommendation({"response": broken, "request_hash": "sha256:" + "a" * 64, "environment_hash": "sha256:" + "f" * 64, "target_hash": "sha256:" + "f" * 64, "constraints_hash": "sha256:" + "f" * 64}, self.fixture.context)

    def test_delta_only_from_comparable_complete_experiments(self) -> None:
        # comparable=False must omit baseline/candidate/delta but keep outcome.
        snapshot = self.fixture.snapshot()
        baseline = self.fixture.benchmark(snapshot["hardware_snapshot_id"])
        candidate = self.fixture.benchmark(snapshot["hardware_snapshot_id"])
        objective = "requests_per_second"
        experiment = {
            "schema_version": 1,
            "experiment_id": f"exp-{uuid.uuid4()}",
            "objective": objective,
            "hypothesis": "",
            "baseline_benchmark_result_id": baseline["benchmark_result_id"],
            "compared_benchmark_result_ids": [candidate["benchmark_result_id"]],
            "comparison_method": "deterministic-v1",
            "conclusion": {
                "comparison_method": "deterministic-v1",
                "comparable": False,
                "baseline_benchmark_result_id": baseline["benchmark_result_id"],
                "compared_benchmark_result_ids": [candidate["benchmark_result_id"]],
                "objective": objective,
                "deltas": [{"benchmark_result_id": candidate["benchmark_result_id"], "objective_metric": objective, "delta_percent": 9.9, "verdict": "higher"}],
            },
            "created_at": utc_now(),
            "provenance": "derived",
        }
        self.fixture.store.put_experiment(experiment, self.fixture.run("seed"))
        report = self.fixture.report(candidate, experiment=experiment)
        preview = cloud_experience_preview({"report_id": report["report_id"]}, self.fixture.context)
        self.assertNotIn("delta", preview["data"]["preview"])
        self.assertNotIn("baseline", preview["data"]["preview"])

    def test_primary_benchmark_must_match_compared_candidate(self) -> None:
        snapshot = self.fixture.snapshot()
        baseline = self.fixture.benchmark(snapshot["hardware_snapshot_id"])
        candidate = self.fixture.benchmark(snapshot["hardware_snapshot_id"])
        experiment = self.fixture.experiment(baseline, candidate, "higher")
        # Report references only the baseline: compared candidate missing -> reject.
        report = self.fixture.report(baseline, experiment=experiment)
        with self.assertRaises(ContractError) as caught:
            cloud_experience_preview({"report_id": report["report_id"]}, self.fixture.context)
        self.assertIn("不一致", str(caught.exception))


    def test_export_metric_whitelist_and_guards(self) -> None:
        snapshot = self.fixture.snapshot()
        # Non-canonical raw keys must never travel; only whitelisted summary
        # names remain even when the normalizer kept raw EvalScope keys.
        benchmark = self.fixture.benchmark(snapshot["hardware_snapshot_id"])
        mutated = dict(benchmark)
        mutated["benchmark_result_id"] = f"bench-{uuid.uuid4()}"
        mutated["metrics"] = {**benchmark["metrics"], "request throughput (req/s)": 123.0}
        self.fixture.store.put_benchmark_result(mutated, self.fixture.run("seed"))
        report = self.fixture.report(mutated, with_run=self.fixture.failed_run())
        preview = cloud_experience_preview({"report_id": report["report_id"]}, self.fixture.context)
        names = [item["name"] for item in preview["data"]["preview"]["metrics"]]
        for name in names:
            self.assertIn(name, ("requests_per_second", "output_tokens_per_second", "input_tokens_per_second", "tokens_per_second", "success_rate", "mean_e2e_latency_ms", "mean_ttft_ms", "mean_tpot_ms", "mean_itl_ms"))
        self.assertNotIn("request throughput (req/s)", names)

        negative = self.fixture.benchmark(snapshot["hardware_snapshot_id"])
        negative["benchmark_result_id"] = f"bench-{uuid.uuid4()}"
        negative["metrics"] = {**negative["metrics"], "requests_per_second": -1.0}
        self.fixture.store.put_benchmark_result(negative, self.fixture.run("seed"))
        bad_report = self.fixture.report(negative)
        with self.assertRaises(ContractError):
            cloud_experience_preview({"report_id": bad_report["report_id"]}, self.fixture.context)

        missing_hash = self.fixture.benchmark(snapshot["hardware_snapshot_id"])
        missing_hash["benchmark_result_id"] = f"bench-{uuid.uuid4()}"
        missing_hash["workload_hash"] = ""
        self.fixture.store.put_benchmark_result(missing_hash, self.fixture.run("seed"))
        hash_report = self.fixture.report(missing_hash)
        with self.assertRaises(ContractError):
            cloud_experience_preview({"report_id": hash_report["report_id"]}, self.fixture.context)
