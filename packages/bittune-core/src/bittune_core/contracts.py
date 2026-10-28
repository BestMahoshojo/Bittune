"""Stable data contracts for the Core: statuses, identifiers and hashing.

Everything the Core persists is verifiable independently of how it was
created: evidence and fact payloads are redacted, serialized deterministically
(`canonical_json`) and content-hashed; every read re-verifies the hash.
"""

import hashlib
import json
import re
from typing import Any

RUN_STATUSES = ("running", "completed", "failed", "cancelled", "interrupted")

GENERIC_TOOL_NAMES = ("bash", "read", "edit", "write")

#: Provenance labels allowed in `provenance-v1`. New labels (e.g. `modeled`)
#: require an explicit published bump of the fact schema version.
PROVENANCE_VALUES = ("declared", "detected", "measured", "derived", "estimated")

#: Who named the object. Missing on an old row means `bound`. This is not a
#: sixth provenance word: a declared endpoint can still be `measured`.
BINDING_VALUES = ("bound", "declared")

RUN_ID = re.compile(r"^run-[a-f0-9-]{36}$")
ARTIFACT_ID = re.compile(r"^artifact-[a-f0-9-]{36}$")

# ---------------------------------------------------------------------------
# Cloud contract freeze (phase 2, stage 0). These names, versions, buckets,
# ranges and statuses mirror contracts/cloud/openapi.yaml and its fixtures;
# changing any of them requires a new schema/rule version and updated
# fixtures on all three ends, never a silent edit.
# ---------------------------------------------------------------------------

#: The three Cloud agent tools; the harness exposes exactly 15 tools total.
CLOUD_TOOL_NAMES = ("cloud_device", "cloud_recommend", "cloud_experience")

RECOMMENDATION_SCHEMA_VERSION_V2 = "recommendation-v2"
SERVING_SEARCH_VERSION = "serving_search-v1"
EXPERIENCE_SCHEMA_VERSION = "experience-export-v2"

SERVING_SEARCH_INTENTS = (
    "fit_model",
    "search_layout",
    "score_layout",
    "shortlist_models",
    "compare_models",
    "coverage",
)

CANDIDATE_SOURCE_KINDS_V2 = (
    "account_success",
    "catalog",
    "predicted_search",
    "predicted_score",
    "coverage",
)

SERVING_RISK_CODES = (
    "history_sparse",
    "prediction_unavailable",
    "strict_sla_is_mean",
    "completed_request_ratio_low",
    "unsupported_hardware",
    "layout_not_deployable",
    "not_in_catalog",
    "account_success_stripped",
)

MEASUREMENT_BASIS_V2 = ("account_history", "catalog", "simulated")

CLOUD_RECOMMENDATION_OUTCOMES = ("http_error", "auth_error", "unsupported_contract", "transport_error")

SCENARIOS = ("chat", "rag", "batch", "coding")

SCENARIO_DEFAULT_WORKLOADS = {
    "chat": {"input_tokens": 1024, "output_tokens": 256, "concurrency": 4},
    "rag": {"input_tokens": 16384, "output_tokens": 512, "concurrency": 2},
    "batch": {"input_tokens": 2048, "output_tokens": 4096, "concurrency": 32},
    "coding": {"input_tokens": 2048, "output_tokens": 1024, "concurrency": 2},
}

BUCKET_REPRESENTATIVE_TOKENS = {
    "0-2048": 1024,
    "2049-8192": 4096,
    "8193-32768": 16384,
    "32769+": 32769,
}

BUCKET_REPRESENTATIVE_LOAD = {
    "1": 1,
    "2-8": 4,
    "9-32": 16,
    "33+": 33,
}

PREDICTED_CLAIM_METRIC_MAP = {
    "mean_ttft_ms": "mean_ttft_ms",
    "output_tokens_per_second": "output_throughput_tok_s",
    "mean_tpot_ms": "mean_tpot_ms",
    "completed_request_ratio": "completed_request_ratio",
}

COMPLETED_REQUEST_RATIO_MIN = 0.90

PREDICTED_SOURCE_KINDS = ("predicted_search", "predicted_score")

#: Global cloud modes; mode_override applies per task and never persists.
CLOUD_MODES = ("cloud_preferred", "local_only")

#: Local connection states (cloud-connection.json projection).
CLOUD_DEVICE_STATES = ("disconnected", "device_pending", "connected", "credential_expired", "disabled")

#: Local outbox statuses; Core is the only queue holder.
CLOUD_OUTBOX_STATUSES = ("pending", "sending", "sent", "failed", "cancelled", "retracted")

CLOUD_EXPERIENCE_OUTCOMES = ("success", "no_gain", "failure", "cancelled")

#: Stable error codes mirroring the OpenAPI ErrorCode enum.
CLOUD_ERROR_CODES = (
    "unsupported_contract",
    "invalid_request",
    "validation_failed",
    "unauthorized",
    "token_expired",
    "insufficient_scope",
    "admin_required",
    "device_not_bound",
    "device_disabled",
    "account_conflict",
    "not_found",
    "conflict",
    "payload_too_large",
    "too_many_requests",
    "internal_error",
)

#: Bucket ids Core computes from raw snapshots and targets. v2 workload
#: projection and suite scene projection both read these; Cloud compares ids.
VRAM_BUCKETS = ("lt8GiB", "8-16GiB", "16-24GiB", "24-48GiB", "48-80GiB", "gte80GiB")
TOKEN_BUCKETS = ("0-2048", "2049-8192", "8193-32768", "32769+")
LOAD_BUCKETS = ("1", "2-8", "9-32", "33+")

#: cloud_recommend local tool input ranges (validated by Core, stage 4).
RECOMMEND_INPUT_RANGES = {
    "input_tokens": (1, 1048576),
    "output_tokens": (1, 1048576),
    "concurrency": (1, 1024),
    "max_memory_percent": (1, 100),
    "model_id": (1, 256),
}

# ---------------------------------------------------------------------------
# Suite contract freeze (phase 7). Row states, claim metrics and workbook
# columns live here once. Reports, XLSX and scripts/check-suite-contract.mjs
# read this tuple set; they do not keep a second copy.
# ---------------------------------------------------------------------------

SUITE_SCHEMA_VERSION = 1
SUITE_PROFILE_ID = "bittune-default-v1"
EARLY_STOP_FORMULA_VERSION = "early-stop-v1"
SUITE_COMPARISON_METHOD = "suite-points-v1"
SLO_JUDGEMENT_VERSION = "slo-judgement-v1"

SUITE_INTENTS = ("performance_sweep", "correctness", "cache_pair", "pd_planning")
DELIVERABLE_INTENTS = ("result_workbook", "evidence_pack")
SUITE_PACKAGES = ("short", "full")

SUITE_ROW_STATES = (
    "healthy",
    "measured",
    "not_run_budget",
    "invalid_measurement",
    "unsupported_context_length",
    "not_run_early_stop",
    "not_run_context_limit",
    "not_run_safety_stop",
    "not_applicable",
    "not_selected",
    "evidence_insufficient",
    "skipped_prior_failure",
    "environment_blocked",
)

#: Metrics a suite_claim may name. Values are read from the row, never typed.
SUITE_CLAIM_METRICS = (
    "requests_per_second",
    "output_tokens_per_second",
    "p50_ttft_ms",
    "p99_ttft_ms",
    "p99_e2e_latency_ms",
    "success_rate",
    "goodput_req_per_s",
)

from bittune_core.measurement import METRIC_NAMES as MEASUREMENT_METRICS, CONTRACT as MEASUREMENT_CONTRACT
WORKBOOK_DETAIL_COLUMNS_V2 = tuple(MEASUREMENT_CONTRACT["row_columns"])
SUITE_CLAIM_METRICS = tuple(dict.fromkeys((*SUITE_CLAIM_METRICS, *MEASUREMENT_METRICS)))

PD_CLAIM_METRICS = (
    "p_cap_req_per_s",
    "d_cap_tok_per_s",
    "ratio_p_to_d",
)

SUITE_ROW_REQUIRED_FIELDS = (
    "scenario_id",
    "projection",
    "concurrency",
    "state",
    "reason_code",
    "reason_detail",
)

WORKBOOK_DETAIL_COLUMNS = (
    "scenario_id",
    "projection",
    "concurrency",
    "state",
    "reason_code",
    "requests_per_second",
    "output_tokens_per_second",
    "p50_ttft_ms",
    "p99_ttft_ms",
    "p99_e2e_latency_ms",
    "success_rate",
    "goodput_req_per_s",
)

WORKBOOK_BEST_COLUMNS = (
    "scenario_id",
    "concurrency",
    "goodput_req_per_s",
    "output_tokens_per_second",
    "state",
)

WORKBOOK_PD_COLUMNS = (
    "p_cap_req_per_s",
    "d_cap_tok_per_s",
    "ratio_p_to_d",
    "provenance",
    "evidence_boundary",
    "formula",
)

#: Allowed top-level experience export fields (experience-export-v2).
CLOUD_EXPORT_ALLOWED_FIELDS = (
    "schema_version",
    "source_report_hash",
    "consent_confirmed",
    "consent_at",
    "evidence_level",
    "environment",
    "model",
    "runtime",
    "workload",
    "config",
    "outcome",
    "metrics",
    "baseline",
    "candidate",
    "delta",
)

#: Canonical summary metrics exported in experience-export-v1. Raw
#: EvalScope keys and per-distribution statistics stay local: the export is
#: a bounded summary (maxItems: 16 on the wire), never a full dump.
CLOUD_EXPORT_METRIC_NAMES = (
    "requests_per_second",
    "output_tokens_per_second",
    "input_tokens_per_second",
    "tokens_per_second",
    "success_rate",
    "mean_e2e_latency_ms",
    "mean_ttft_ms",
    "mean_tpot_ms",
    "mean_itl_ms",
)

#: Property names that must never appear in a Cloud-bound payload. Hash
#: projections (`*_hash`) are allowed; raw values with these names are not.
FORBIDDEN_CLOUD_FIELD_NAMES = (
    "prompt",
    "response",
    "responses",
    "output",
    "shell",
    "command",
    "cmd",
    "path",
    "file_path",
    "secret",
    "token",
    "password",
    "api_key",
    "ip",
    "ip_address",
    "hostname",
    "host",
    "argv",
    "args",
    "url",
    "uri",
    "account_id",
    "account_subject",
    "user_id",
    "username",
    "email",
    "uuid",
    "serial",
    "installation_hash",
)

#: Minimal Cloud profile fields; the official release profile is distributed
#: with the package, self-hosted profiles come from the Cloud operator.
CLOUD_PROFILE_FIELDS = (
    "name",
    "api_base_url",
    "oidc_issuer",
    "oidc_client_id",
    "oidc_audience",
    "scopes",
)

#: Cloud outbox / export identity shapes and size limits.
EXPORT_ID = re.compile(r"^exp-[a-z0-9-]{26,64}$")
REQUEST_ID = re.compile(r"^req-[a-z0-9-]{26,64}$")
#: Upper bound for an export payload + outbox payload row.
MAX_EXPORT_PAYLOAD_BYTES = 256 * 1024

#: Frozen GPU architecture names by CUDA compute capability major.minor.
GPU_ARCH_BY_CAPABILITY = {
    "7.5": "Turing",
    "8.0": "Ampere",
    "8.6": "Ampere",
    "8.9": "Ada",
    "9.0": "Hopper",
    "10.0": "Blackwell",
    "12.0": "Blackwell",
}


# ---------------------------------------------------------------------------
# Cloud canonical form: the same fixed numeric rule as the Cloud Go service,
# so the Local outbox content hash and the Cloud receipt content hash agree.
# Numbers render fixed-point with up to six fraction digits, trailing zeros
# and the dot trimmed (90.0 -> "90", 0.016600 -> "0.0166", 1e-06 -> "0.000001").
# ---------------------------------------------------------------------------

def cloud_canonical(value: Any) -> str:
    def number_text(number: Any) -> str:
        text = format(float(number), ".6f").rstrip("0").rstrip(".")
        return text or "0"

    if isinstance(value, dict):
        return "{" + ",".join(
            f"{json.dumps(str(key), ensure_ascii=False, separators=(',', ':'))}:{cloud_canonical(value[key])}"
            for key in sorted(value)
        ) + "}"
    if isinstance(value, list):
        return "[" + ",".join(cloud_canonical(item) for item in value) + "]"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return number_text(value)
    if value is None:
        return "null"
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    return json.dumps(value, ensure_ascii=False)


def cloud_canonical_hash(value: Any) -> str:
    return sha256_bytes(cloud_canonical(value).encode("utf-8"))

def sha256_bytes(value: bytes) -> str:
    return f"sha256:{hashlib.sha256(value).hexdigest()}"


def sha256_canonical(value: Any) -> str:
    return sha256_bytes(canonical_json(value).encode("utf-8"))


def canonical_json(value: Any) -> str:
    """Deterministic JSON: object keys sorted recursively, compact separators."""

    def normalize(item: Any) -> Any:
        if isinstance(item, dict):
            return {key: normalize(item[key]) for key in sorted(item)}
        if isinstance(item, list):
            return [normalize(child) for child in item]
        return item

    return json.dumps(normalize(value), separators=(",", ":"), ensure_ascii=False)


def _is_recommendation_artifact(payload: dict[str, Any]) -> bool:
    """A Cloud recommendation body or the local observation that points at one.

    Either shape must stay unclaimable even if a caller stamps measured/bound on it.
    """
    if payload.get("schema_version") == RECOMMENDATION_SCHEMA_VERSION_V2 and "candidates" in payload:
        return True
    return payload.get("rules_version") == SERVING_SEARCH_VERSION and "candidate_count" in payload


def _is_measure_fact(payload: dict[str, Any]) -> bool:
    """A benchmark result, or one suite row. Not the suite fact that wraps rows.

    A row's ``projection`` is a bucket object, so the check is key presence,
    not scalar types. The suite fact itself has ``suite_result_id`` and ``rows``
    and does not carry the row keys.
    """
    if isinstance(payload.get("benchmark_result_id"), str):
        return True
    return all(key in payload for key in SUITE_ROW_REQUIRED_FIELDS)


def claimable(payload: Any) -> bool:
    """Whether this fact may be called a BitTune measurement.

    True only when binding is missing or ``bound``, provenance is ``measured``,
    and the payload is a benchmark result or a suite row. Recommendation
    artifacts are never claimable. ``binding`` does not change provenance.
    """
    if not isinstance(payload, dict):
        return False
    if _is_recommendation_artifact(payload):
        return False
    binding = payload.get("binding", "bound")
    if binding != "bound":
        return False
    if payload.get("provenance") != "measured":
        return False
    return _is_measure_fact(payload)


class ContractError(Exception):
    """A stable, machine-readable validation failure.

    `code` and `message` cross the protocol boundary verbatim; the Core never
    sends a bare exception text back to the Runtime.
    """

    def __init__(self, code: str, message: str, details: dict[str, Any] | None = None, remediation: str | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.remediation = remediation
        self.details = details or {}

    def to_result(self) -> dict[str, Any]:
        error: dict[str, Any] = {"code": self.code, "message": self.message}
        if self.remediation:
            error["remediation"] = self.remediation
        if self.details:
            error["details"] = self.details
        return error