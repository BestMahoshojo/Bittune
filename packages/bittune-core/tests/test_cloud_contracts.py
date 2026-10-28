"""Cloud contract freeze tests (phase 2, stage 0).

The Core loads the same frozen JSON fixtures as the Cloud Go tests and the
Runtime TypeScript tests, and validates them against the constants in
contracts.py. Any contract change must touch source, mirror, generated types
and fixtures together — these tests fail on drift.
"""

import hashlib
import json
import sys
import unittest
from pathlib import Path

SRC_ROOT = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC_ROOT))

from bittune_core.adapters import sglang as sglang_adapter  # noqa: E402
from bittune_core.adapters import vllm as vllm_adapter  # noqa: E402
from bittune_core.contracts import (  # noqa: E402
    BINDING_VALUES,
    CANDIDATE_SOURCE_KINDS_V2,
    CLOUD_ERROR_CODES,
    CLOUD_EXPERIENCE_OUTCOMES,
    CLOUD_EXPORT_ALLOWED_FIELDS,
    CLOUD_MODES,
    CLOUD_PROFILE_FIELDS,
    EXPERIENCE_SCHEMA_VERSION,
    FORBIDDEN_CLOUD_FIELD_NAMES,
    LOAD_BUCKETS,
    MEASUREMENT_BASIS_V2,
    PROVENANCE_VALUES,
    RECOMMENDATION_SCHEMA_VERSION_V2,
    RECOMMEND_INPUT_RANGES,
    SERVING_RISK_CODES,
    SERVING_SEARCH_INTENTS,
    SERVING_SEARCH_VERSION,
    TOKEN_BUCKETS,
    VRAM_BUCKETS,
    claimable,
)

REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURES = REPO_ROOT / "contracts" / "cloud" / "fixtures"
MIRROR = REPO_ROOT / "contracts" / "cloud"


def load(relative: str):
    return json.loads((FIXTURES / relative).read_text(encoding="utf-8"))


def keys_of(value, found=None):
    """Recursive exact key names; hash projections keep their `_hash` suffix."""
    if found is None:
        found = set()
    if isinstance(value, dict):
        for key, child in value.items():
            found.add(key)
            keys_of(child, found)
    elif isinstance(value, list):
        for child in value:
            keys_of(child, found)
    return found


class RecommendationQueryFixtureTest(unittest.TestCase):
    def test_envelope_and_projection_are_frozen(self):
        envelope = load("recommendation/query-request.json")
        self.assertEqual(envelope["schema_version"], RECOMMENDATION_SCHEMA_VERSION_V2)
        self.assertEqual(envelope["payload"]["intent"], "fit_model")
        self.assertEqual(
            set(envelope["payload"]), {"intent", "environment", "target", "workload_buckets", "constraints"}
        )
        environment = envelope["payload"]["environment"]
        self.assertEqual(set(environment), {"gpu_arch", "gpu_count", "vram_bucket", "driver_major", "cuda_major"})
        self.assertIn(environment["vram_bucket"], VRAM_BUCKETS)
        buckets = envelope["payload"]["workload_buckets"]
        self.assertIn(buckets["input_bucket"], TOKEN_BUCKETS)
        self.assertIn(buckets["output_bucket"], TOKEN_BUCKETS)
        self.assertIn(buckets["load_bucket"], LOAD_BUCKETS)
        constraints = envelope["payload"]["constraints"]
        self.assertEqual(set(constraints), {"must_be_offline", "max_memory_percent"})
        self.assertTrue(
            RECOMMEND_INPUT_RANGES["max_memory_percent"][0]
            <= constraints["max_memory_percent"]
            <= RECOMMEND_INPUT_RANGES["max_memory_percent"][1]
        )

    def test_forbidden_fields_never_appear(self):
        fixtures = [
            load("recommendation/query-request.json"),
            load("experience/export-request.json"),
            load("local/cloud-recommend-input.json"),
            load("local/cloud-recommend-input-local-only.json"),
        ]
        for value in fixtures:
            offending = keys_of(value) & set(FORBIDDEN_CLOUD_FIELD_NAMES)
            self.assertFalse(offending, f"forbidden field names present: {sorted(offending)}")


class ExperienceExportFixtureTest(unittest.TestCase):
    def test_whitelist_and_outcome(self):
        export = load("experience/export-request.json")
        self.assertEqual(export["schema_version"], EXPERIENCE_SCHEMA_VERSION)
        self.assertTrue(export["consent_confirmed"])
        self.assertEqual(export["outcome"], "success")
        self.assertIn("consent_at", export)
        for key in export:
            self.assertIn(key, CLOUD_EXPORT_ALLOWED_FIELDS, f"unexpected export field: {key}")

    def test_all_outcomes_decode(self):
        # The shared fixture freezes the success shape; the outcome enum is
        # the contract for the other three values Core can export.
        self.assertEqual(set(CLOUD_EXPERIENCE_OUTCOMES), {"success", "no_gain", "failure", "cancelled"})


class ErrorFixtureTest(unittest.TestCase):
    def test_stable_codes(self):
        expected = {
            "unsupported_contract",
            "unauthorized",
            "insufficient_scope",
            "validation_failed",
            "conflict",
            "device_disabled",
            "not_found",
            "too_many_requests",
        }
        codes = set()
        for name in expected:
            envelope = load(f"errors/{name}.json")
            codes.add(envelope["error"]["code"])
            self.assertTrue(envelope["error"]["message"], f"{name} message must not be empty")
        self.assertEqual(codes, expected)
        self.assertTrue(codes <= set(CLOUD_ERROR_CODES))


class LocalInputFixtureTest(unittest.TestCase):
    def test_ranges_and_modes(self):
        value = load("local/cloud-recommend-input.json")
        target = value["target"]
        self.assertTrue(1 <= len(target["model_id"]) <= RECOMMEND_INPUT_RANGES["model_id"][1])
        for field in ("input_tokens", "output_tokens", "concurrency"):
            low, high = RECOMMEND_INPUT_RANGES[field]
            self.assertTrue(low <= target[field] <= high, f"{field} out of range")
        constraints = value["constraints"]
        self.assertEqual(set(constraints), {"must_be_offline", "max_memory_percent"})

        local_only = load("local/cloud-recommend-input-local-only.json")
        self.assertEqual(local_only["mode_override"], "local_only")
        self.assertIn(local_only["mode_override"], CLOUD_MODES)

    def test_profile_fields(self):
        profile = load("local/profile-official.json")
        self.assertEqual(set(profile), set(CLOUD_PROFILE_FIELDS))
        self.assertTrue(profile["api_base_url"].startswith("https://"))
        self.assertTrue(profile["oidc_issuer"].startswith("https://"))
        self.assertEqual(set(profile["scopes"]), {"openid", "offline_access", "recommendations:read", "experiences:write"})


class ManifestTest(unittest.TestCase):
    def test_sha256sums_match_fixture_bytes(self):
        lines = (MIRROR / "SHA256SUMS").read_text(encoding="utf-8").strip().splitlines()
        seen = set()
        for line in lines:
            want, relative = line.split("  ", 1)
            content = (MIRROR / relative).read_bytes()
            got = hashlib.sha256(content).hexdigest()
            self.assertEqual(got, want, f"hash mismatch for {relative}")
            seen.add(relative)
        for path in sorted((FIXTURES).rglob("*")):
            if not path.is_file():
                continue
            relative = path.relative_to(MIRROR).as_posix()
            self.assertIn(relative, seen, f"fixture missing from SHA256SUMS: {relative}")
        self.assertEqual(len(seen), len(lines))


if __name__ == "__main__":
    unittest.main()

class ClaimableTest(unittest.TestCase):
    def test_binding_values_are_not_a_new_provenance(self):
        self.assertEqual(BINDING_VALUES, ("bound", "declared"))
        self.assertEqual(PROVENANCE_VALUES, ("declared", "detected", "measured", "derived", "estimated"))
        self.assertNotIn("bound", PROVENANCE_VALUES)

    def test_old_measured_benchmark_without_binding_is_claimable(self):
        payload = {
            "benchmark_result_id": "bench-1",
            "provenance": "measured",
            "metrics": {"requests_per_second": 1.0},
        }
        self.assertTrue(claimable(payload))
        self.assertTrue(claimable({**payload, "binding": "bound"}))

    def test_declared_measured_benchmark_is_not_claimable(self):
        self.assertFalse(
            claimable(
                {
                    "benchmark_result_id": "bench-1",
                    "binding": "declared",
                    "provenance": "measured",
                }
            )
        )

    def test_recommendation_artifact_is_not_claimable(self):
        response = load("recommendation/v2-response-shortlist.json")
        self.assertFalse(claimable(response))
        stamped = {**response, "binding": "bound", "provenance": "measured", "benchmark_result_id": "bench-1"}
        self.assertFalse(claimable(stamped))
        observation = {
            "rules_version": SERVING_SEARCH_VERSION,
            "candidate_count": 1,
            "binding": "bound",
            "provenance": "measured",
            "benchmark_result_id": "bench-1",
        }
        self.assertFalse(claimable(observation))

    def test_suite_row_needs_measured_provenance_and_bound_binding(self):
        row = {
            "scenario_id": "chat",
            "projection": {"scenario": "chat", "input_bucket": "0-2048", "output_bucket": "0-2048", "load_bucket": "1"},
            "concurrency": 1,
            "state": "healthy",
            "reason_code": "ok",
            "reason_detail": "测量完整。",
            "provenance": "measured",
        }
        self.assertTrue(claimable(row))
        self.assertFalse(claimable({**row, "binding": "declared"}))
        self.assertFalse(claimable({key: row[key] for key in row if key != "provenance"}))

    def test_suite_fact_and_non_facts_are_not_claimable(self):
        suite = {
            "suite_result_id": "suite-1",
            "provenance": "derived",
            "binding": "bound",
            "rows": [{"scenario_id": "chat"}],
        }
        self.assertFalse(claimable(suite))
        self.assertFalse(claimable({"provenance": "measured", "binding": "bound"}))
        self.assertFalse(claimable(None))
        self.assertFalse(claimable({"benchmark_result_id": "bench-1", "provenance": "estimated"}))


class ForbiddenNamesFixtureTest(unittest.TestCase):
    def test_core_constant_matches_frozen_fixture(self):
        listed = load("local/forbidden-field-names-v1.json")
        self.assertEqual(set(listed), set(FORBIDDEN_CLOUD_FIELD_NAMES))


class CanonicalNumbersGoldenTest(unittest.TestCase):
    def test_go_python_shared_hash_constant(self):
        value = load("experience/canonical-numbers-v1.json")
        from bittune_core.contracts import cloud_canonical_hash
        self.assertEqual(
            cloud_canonical_hash(value),
            "sha256:ec2afbe89347db590834d56c7f2cf9b9bc26a286731336996c12d2268135109d",
        )


def _adapter_names(module) -> set[str]:
    return {item["name"] for item in module.PARAMETERS} - {"gpu_device_ids"}


class ServingWhitelistTest(unittest.TestCase):
    def test_matches_python_parameters(self):
        listed = load("serving-whitelist.json")
        self.assertEqual(set(listed["vllm"]), _adapter_names(vllm_adapter))
        # Cloud remains frozen; M4b's explicitly local additions are not an upstream contract update.
        local_only = {"attention_backend", "kv_cache_dtype"}
        self.assertEqual(set(listed["sglang"]) | local_only, _adapter_names(sglang_adapter))
        self.assertTrue(set(listed["sglang"]).isdisjoint(local_only))
        self.assertNotIn("pipeline_parallel_size", listed["sglang"])
        self.assertIn("gpu_device_ids", listed["never"])
        self.assertIn("replica", listed["never"])


class RecommendationV2FixtureTest(unittest.TestCase):
    def test_shortlist_omits_model_id_and_carries_both_workloads(self):
        envelope = load("recommendation/v2-query-shortlist.json")
        self.assertEqual(envelope["schema_version"], RECOMMENDATION_SCHEMA_VERSION_V2)
        self.assertEqual(envelope["payload"]["intent"], "shortlist_models")
        self.assertIn(envelope["payload"]["intent"], SERVING_SEARCH_INTENTS)
        self.assertNotIn("target", envelope["payload"])
        self.assertIn("workload", envelope["payload"])
        self.assertIn("workload_buckets", envelope["payload"])

    def test_fit_empty_workload_omits_both_keys(self):
        envelope = load("recommendation/v2-query-fit-no-workload.json")
        self.assertEqual(envelope["payload"]["intent"], "fit_model")
        self.assertNotIn("workload", envelope["payload"])
        self.assertNotIn("workload_buckets", envelope["payload"])
        self.assertEqual(envelope["payload"]["target"]["model_id"], "Qwen/Qwen2.5-72B-Instruct")

    def test_search_predicted_candidate_ids_are_unique_and_not_entry_ids(self):
        response = load("recommendation/v2-response-search.json")
        self.assertEqual(response["schema_version"], RECOMMENDATION_SCHEMA_VERSION_V2)
        self.assertEqual(response["rules_version"], SERVING_SEARCH_VERSION)
        self.assertEqual(tuple(response["measurement_basis"]), ("catalog", "simulated"))
        self.assertTrue(set(response["measurement_basis"]) <= set(MEASUREMENT_BASIS_V2))
        ids = [item["candidate_id"] for item in response["candidates"]]
        self.assertEqual(len(ids), len(set(ids)))
        for item in response["candidates"]:
            self.assertNotEqual(item["candidate_id"], item["source"]["entry_id"])
            self.assertEqual(item["source"]["kind"], "predicted_search")
            self.assertIn(item["source"]["kind"], CANDIDATE_SOURCE_KINDS_V2)
            self.assertEqual(item["prediction"]["measurement_basis"], "simulated")
            self.assertIn("image_digest", item["runtime_spec"])

    def test_shortlist_candidate_is_complete(self):
        response = load("recommendation/v2-response-shortlist.json")
        candidate = response["candidates"][0]
        self.assertEqual(candidate["source"]["kind"], "catalog")
        self.assertNotEqual(candidate["candidate_id"], candidate["source"]["entry_id"])
        self.assertTrue(candidate["runtime_spec"]["image_digest"].startswith("sha256:"))
        self.assertIn("serving_config", candidate)

    def test_coverage_omits_serving_config(self):
        response = load("recommendation/v2-response-coverage.json")
        self.assertEqual(response["candidates"][0]["source"]["kind"], "coverage")
        self.assertNotIn("serving_config", response["candidates"][0])

    def test_score_sglang_pp_is_empty_200_shape(self):
        response = load("recommendation/v2-response-score-sglang-pp.json")
        self.assertEqual(response["candidates"], [])
        self.assertIn("layout_not_deployable", response["notes"])

    def test_fit_no_workload_notes_omitted(self):
        response = load("recommendation/v2-response-fit-no-workload.json")
        self.assertIn("workload_omitted", response["notes"])
        self.assertIn("prediction_unavailable", response["candidates"][0]["risks"])
        self.assertTrue(set(response["candidates"][0]["risks"]) <= set(SERVING_RISK_CODES))

    def test_intent_error_fixtures_are_validation_failed(self):
        search = load("recommendation/v2-error-search-no-sla.json")
        score = load("recommendation/v2-error-score-no-layout.json")
        self.assertEqual(search["error"]["code"], "validation_failed")
        self.assertEqual(score["error"]["code"], "validation_failed")

class OpenAPIStaticContractTest(unittest.TestCase):
    def test_path_query_schemas_and_catalog_draft(self):
        spec = (MIRROR / "openapi.yaml").read_text(encoding="utf-8")
        self.assertNotIn("oneOf:", spec)
        self.assertNotIn("RecommendationQueryWire:", spec)
        self.assertNotIn("recommendation-v1", spec)
        self.assertNotIn("matching_rules-v1", spec)
        self.assertIn("RecommendationQueryEnvelopeV2:", spec)
        v2 = spec.split("    RecommendationQueryEnvelopeV2:\n", 1)[1].split("\n    RecommendationQueryPayloadV2:\n", 1)[0]
        self.assertIn("additionalProperties: false", v2)
        self.assertIn("enum: [recommendation-v2]", v2)
        draft = spec.split("    CatalogEntryDraft:\n", 1)[1].split("\n    CatalogImportResponse:\n", 1)[0]
        for field in ("min_vram_gib", "gpu_products", "aisim_hardware", "coverage", "knowledge_pack_id"):
            self.assertIn(f"{field}:", draft)
        self.assertIn("additionalProperties: false", draft)
