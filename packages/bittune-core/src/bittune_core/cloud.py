"""Cloud projections: recommendation inputs, experience exports and the
Outbox.

The Core still never touches the network. The Runtime's Cloud Bridge drives
these narrow actions:

* `cloud_prepare_recommendation` turns the Agent's intent plus the latest
  HardwareSnapshot into the frozen `recommendation-v2` envelope;
* `record_cloud_recommendation` persists a redacted recommendation Run and
  response Artifact (`recommendation-v2` only) for traceability;
* `record_cloud_recommendation_outcome` records HTTP/auth/transport/poison
  failures so the create gate is not locked;
* `cloud_session_recommend_status` is the exact-SQL gate lookup;
* `cloud_experience_preview`/`cloud_experience_enqueue` build the fixed
  `experience-export-v2` whitelist projection from an existing Report;
* `cloud_outbox_*` implement the pending/sending/sent/failed/cancelled/
  retracted queue with hash-verified reads and atomic transitions.
"""

import math
import re
import uuid
from typing import Any

from bittune_core.contracts import (
    BINDING_VALUES,
    BUCKET_REPRESENTATIVE_LOAD,
    BUCKET_REPRESENTATIVE_TOKENS,
    CANDIDATE_SOURCE_KINDS_V2,
    CLOUD_EXPERIENCE_OUTCOMES,
    CLOUD_EXPORT_METRIC_NAMES,
    CLOUD_RECOMMENDATION_OUTCOMES,
    EXPERIENCE_SCHEMA_VERSION,
    EXPORT_ID,
    FORBIDDEN_CLOUD_FIELD_NAMES,
    GPU_ARCH_BY_CAPABILITY,
    LOAD_BUCKETS,
    MEASUREMENT_BASIS_V2,
    PREDICTED_SOURCE_KINDS,
    RECOMMENDATION_SCHEMA_VERSION_V2,
    RECOMMEND_INPUT_RANGES,
    REQUEST_ID,
    SCENARIO_DEFAULT_WORKLOADS,
    SCENARIOS,
    SERVING_SEARCH_INTENTS,
    SERVING_SEARCH_VERSION,
    TOKEN_BUCKETS,
    VRAM_BUCKETS,
    ContractError,
    canonical_json,
    claimable,
    cloud_canonical_hash,
    sha256_canonical,
)
from bittune_core.gpu_product import gpu_product, gpu_product_exact_keys
from bittune_core.adapters import require_adapter
from bittune_core.runs import ManagedRun
from bittune_core.store import CoreStore, utc_now

_MODEL_ID = re.compile(r"^[A-Za-z0-9._/-]{1,256}$")
_RUNTIME_MAJOR = re.compile(r"^[0-9]{1,16}$")
_HASH = re.compile(r"^sha256:[a-f0-9]{64}$")
_MAJOR_VERSION = re.compile(r"^[0-9]+(\.[0-9]+)?$")
_GPU_PRODUCT_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$")
_DECLARED_ARCHES = ("Turing", "Ampere", "Ada", "Hopper", "Blackwell")

# Frozen metric unit mapping; anything else exports as a plain count.
_METRIC_UNITS = {
    "requests_per_second": "requests/s",
    "output_tokens_per_second": "tokens/s",
    "input_tokens_per_second": "tokens/s",
    "tokens_per_second": "tokens/s",
    "success_rate": "%",
    "ttft": "ms",
    "time_to_first_token": "ms",
    "mean_e2e_latency_ms": "ms",
    "mean_ttft_ms": "ms",
    "mean_tpot_ms": "ms",
    "mean_itl_ms": "ms",
}

_VERDICT_TO_OUTCOME = {"higher": "success", "within_1pct": "no_gain", "lower": "no_gain"}


def _vram_bucket(memory_bytes: int) -> str:
    gib = memory_bytes / (1024**3)
    if gib < 8:
        return "lt8GiB"
    if gib < 16:
        return "8-16GiB"
    if gib < 24:
        return "16-24GiB"
    if gib < 48:
        return "24-48GiB"
    if gib < 80:
        return "48-80GiB"
    return "gte80GiB"


def _token_bucket(tokens: int) -> str:
    if tokens <= 2048:
        return "0-2048"
    if tokens <= 8192:
        return "2049-8192"
    if tokens <= 32768:
        return "8193-32768"
    return "32769+"


def _load_bucket(concurrency: int) -> str:
    if concurrency == 1:
        return "1"
    if concurrency <= 8:
        return "2-8"
    if concurrency <= 32:
        return "9-32"
    return "33+"


def _scan_forbidden(value: Any, path: str = "payload") -> None:
    """Forbidden names are refused anywhere in a Cloud-bound structure."""
    if isinstance(value, dict):
        for key, child in value.items():
            if key in FORBIDDEN_CLOUD_FIELD_NAMES:
                raise ContractError("forbidden_field", f"Cloud 投影禁止字段 {path}.{key}。", {"field": f"{path}.{key}"})
            _scan_forbidden(child, f"{path}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            _scan_forbidden(child, f"{path}[{index}]")


def _validated_input(params: dict[str, Any]) -> dict[str, Any]:
    target = params.get("target")
    if not isinstance(target, dict):
        raise ContractError("invalid_input", "target 必须是对象。", {}, remediation="cloud_recommend 输入见实施文档 §4.2。")
    allowed = {"model_id", "revision", "quantization", "runtime_kind", "runtime_major", "input_tokens", "output_tokens", "concurrency"}
    unknown = set(target) - allowed
    if unknown:
        raise ContractError("invalid_input", f"target 含未知字段：{sorted(unknown)}。", {"unknown": sorted(unknown)})
    model_id = target.get("model_id")
    if not isinstance(model_id, str) or not _MODEL_ID.match(model_id):
        raise ContractError("invalid_input", "model_id 必须是 1..256 个安全字符（[A-Za-z0-9._/-]）。", {})
    for field in ("revision", "quantization", "runtime_kind"):
        value = target.get(field)
        if value is not None and not isinstance(value, str):
            raise ContractError("invalid_input", f"target.{field} 必须是字符串或省略。", {})
        if value == "":
            raise ContractError("invalid_input", f"target.{field} 不能是空字符串；省略即可。", {})
    runtime_major = target.get("runtime_major")
    if runtime_major is not None and (not isinstance(runtime_major, str) or not _RUNTIME_MAJOR.match(runtime_major)):
        raise ContractError("invalid_input", "target.runtime_major 必须是纯数字主版本字符串。", {})
    if target.get("runtime_kind") not in (None, "vllm", "sglang"):
        raise ContractError("invalid_input", "target.runtime_kind 只能是 vllm 或 sglang。", {})
    for field in ("input_tokens", "output_tokens", "concurrency"):
        value = target.get(field)
        low, high = RECOMMEND_INPUT_RANGES[field]
        if not isinstance(value, int) or isinstance(value, bool) or not (low <= value <= high):
            raise ContractError("invalid_input", f"target.{field} 必须是 {low}..{high} 的整数。", {"field": field})
    constraints = params.get("constraints")
    if not isinstance(constraints, dict) or set(constraints) != {"must_be_offline", "max_memory_percent"}:
        raise ContractError("invalid_input", "constraints 只允许 must_be_offline 与 max_memory_percent。", {})
    if not isinstance(constraints.get("must_be_offline"), bool):
        raise ContractError("invalid_input", "constraints.must_be_offline 必须是布尔值。", {})
    percent = constraints.get("max_memory_percent")
    if not isinstance(percent, int) or isinstance(percent, bool) or not (1 <= percent <= 100):
        raise ContractError("invalid_input", "constraints.max_memory_percent 必须是 1..100。", {})
    return target


def _latest_snapshot(store: CoreStore) -> dict[str, Any]:
    snapshots = store.list_facts("hardware_snapshot", limit=1)
    if not snapshots:
        raise ContractError("not_found", "没有 HardwareSnapshot；先运行 inspect_environment。", {}, remediation="cloud_recommend 之前必须完成环境检测。")
    return snapshots[0]["payload"]


def _environment_projection(snapshot: dict[str, Any]) -> dict[str, Any]:
    gpus = snapshot.get("gpus") or []
    if not gpus:
        raise ContractError("invalid_input", "HardwareSnapshot 没有 GPU 数据，无法生成 Cloud 环境投影。", {})
    capability = str(gpus[0].get("compute_capability", ""))
    arch = GPU_ARCH_BY_CAPABILITY.get(capability)
    if arch is None:
        raise ContractError("invalid_input", f"不支持的 compute capability {capability}（缺少固定架构映射）。", {"capability": capability})
    driver_version = str(gpus[0].get("driver_version", ""))
    if not driver_version:
        raise ContractError("invalid_input", "HardwareSnapshot 缺少 driver_version。", {})
    # The real CUDA toolkit major comes from `nvidia-smi`'s header, never
    # from compute capability (which describes the microarchitecture).
    cuda_version = str(snapshot.get("cuda_version") or "")
    if not cuda_version:
        raise ContractError(
            "invalid_input",
            "HardwareSnapshot 缺少 cuda_version；无法生成可信的 CUDA 主版本投影。",
            {},
            remediation="重新运行 inspect_environment（需要 nvidia-smi 输出 CUDA Version）。",
        )
    memory_min = min(int(gpu.get("memory_total_bytes") or 0) for gpu in gpus)
    if memory_min <= 0:
        raise ContractError("invalid_input", "HardwareSnapshot GPU 显存数据缺失。", {})
    return {
        "gpu_arch": arch,
        "gpu_count": len(gpus),
        "vram_bucket": _vram_bucket(memory_min),
        "driver_major": driver_version.split(".")[0][:16],
        "cuda_major": cuda_version.split(".")[0][:16],
    }


def _gib_floor(memory_bytes: int) -> int:
    return max(1, int(memory_bytes // (1024**3)))


def _kernel_os(snapshot: dict[str, Any]) -> str | None:
    kernel = snapshot.get("kernel")
    if not isinstance(kernel, str) or not kernel.strip():
        return None
    parts = kernel.strip().split()
    version = next((part for part in parts if part[:1].isdigit()), "")
    major = version.split(".", 1)[0] if version else ""
    if major.isdigit():
        return f"Linux {major}"[:64]
    return "Linux"


def _host_memory_gib(snapshot: dict[str, Any]) -> int | None:
    memory = snapshot.get("memory") or {}
    total = memory.get("total_bytes") if isinstance(memory, dict) else None
    if not isinstance(total, int) or total <= 0:
        return None
    return _gib_floor(total)


def _export_environment(snapshot: dict[str, Any]) -> dict[str, Any]:
    buckets = _environment_projection(snapshot)
    gpus = snapshot.get("gpus") or []
    driver_version = str(gpus[0].get("driver_version", ""))
    cuda_version = str(snapshot.get("cuda_version") or "")
    capability = str(gpus[0].get("compute_capability", ""))
    environment = {
        **buckets,
        "driver_version": driver_version[:64],
        "cuda_version": cuda_version[:64],
        "compute_capability": capability,
    }
    os_label = _kernel_os(snapshot)
    if os_label:
        environment["os"] = os_label
    memory_gib = _host_memory_gib(snapshot)
    if memory_gib is not None:
        environment["memory_gib"] = memory_gib
    products = [gpu_product(str(gpu.get("name") or "")) for gpu in gpus]
    vrams = [_gib_floor(int(gpu.get("memory_total_bytes") or 0)) for gpu in gpus]
    if products and all(item is not None for item in products) and len(set(products)) == 1 and len(set(vrams)) == 1:
        environment["gpu_product"] = products[0]
        environment["vram_gib"] = vrams[0]
    return environment


def _environment_projection_v2(snapshot: dict[str, Any]) -> dict[str, Any]:
    """Five v1 environment fields plus optional gpu_product / vram_gib.

    Recommend coverage lookup is exact nvidia-smi names only. When every GPU
    shares one raw name, one family mapping, and one GiB floor, emit the raw
    name. Mapping failure or mixed names omit gpu_product. A single GiB floor
    is still emitted. Experience export still uses `_export_environment`
    family names.
    """
    environment = _environment_projection(snapshot)
    gpus = snapshot.get("gpus") or []
    raw_names = [str(gpu.get("name") or "").strip() for gpu in gpus]
    families = [gpu_product(name) for name in raw_names]
    vrams = [_gib_floor(int(gpu.get("memory_total_bytes") or 0)) for gpu in gpus]
    same_vram = bool(vrams) and len(set(vrams)) == 1 and 1 <= vrams[0] <= 2048
    mapped = (
        raw_names
        and all(name for name in raw_names)
        and len(set(raw_names)) == 1
        and all(item is not None for item in families)
        and len(set(families)) == 1
        and same_vram
    )
    if mapped:
        environment["gpu_product"] = raw_names[0]
        environment["vram_gib"] = vrams[0]
    elif same_vram:
        environment["vram_gib"] = vrams[0]
    return environment


def _serving_whitelist(runtime_kind: str) -> set[str]:
    adapter = require_adapter(runtime_kind)
    return {item["name"] for item in adapter.PARAMETERS} - {"gpu_device_ids"}


def _positive_int(value: Any, field: str, low: int, high: int) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or not (low <= value <= high):
        raise ContractError("invalid_input", f"{field} 必须是 {low}..{high} 的整数。", {"field": field})
    return value


def _validated_target_v2(target: dict[str, Any]) -> dict[str, Any]:
    allowed = {"model_id", "revision", "quantization", "runtime_kind", "runtime_major"}
    unknown = set(target) - allowed
    if unknown:
        raise ContractError("invalid_input", f"target 含未知字段：{sorted(unknown)}。", {"unknown": sorted(unknown)})
    model_id = target.get("model_id")
    if not isinstance(model_id, str) or not _MODEL_ID.match(model_id):
        raise ContractError("invalid_input", "target.model_id 必须是 1..256 个安全字符（[A-Za-z0-9._/-]）。", {"field": "target.model_id"})
    projected: dict[str, Any] = {"model_id": model_id}
    for field in ("revision", "quantization", "runtime_kind"):
        value = target.get(field)
        if value is not None and not isinstance(value, str):
            raise ContractError("invalid_input", f"target.{field} 必须是字符串或省略。", {"field": f"target.{field}"})
        if value == "":
            raise ContractError("invalid_input", f"target.{field} 不能是空字符串；省略即可。", {"field": f"target.{field}"})
        if value is not None:
            projected[field] = value
    runtime_major = target.get("runtime_major")
    if runtime_major is not None and (not isinstance(runtime_major, str) or not _RUNTIME_MAJOR.match(runtime_major)):
        raise ContractError("invalid_input", "target.runtime_major 必须是纯数字主版本字符串。", {"field": "target.runtime_major"})
    if projected.get("runtime_kind") not in (None, "vllm", "sglang"):
        raise ContractError("invalid_input", "target.runtime_kind 只能是 vllm 或 sglang。", {"field": "target.runtime_kind"})
    if runtime_major is not None:
        projected["runtime_major"] = runtime_major
    return projected


def _validated_constraints_v2(constraints: Any) -> dict[str, Any]:
    if not isinstance(constraints, dict):
        raise ContractError("invalid_input", "constraints 必须是对象。", {"field": "constraints"})
    required = {"must_be_offline", "max_memory_percent"}
    allowed = required | {"runtime_kind", "quantization", "max_candidate_gpus"}
    unknown = set(constraints) - allowed
    if unknown:
        raise ContractError("invalid_input", f"constraints 含未知字段：{sorted(unknown)}。", {"unknown": sorted(unknown)})
    missing = required - set(constraints)
    if missing:
        raise ContractError("invalid_input", "constraints 必须包含 must_be_offline 与 max_memory_percent。", {"missing": sorted(missing)})
    if not isinstance(constraints.get("must_be_offline"), bool):
        raise ContractError("invalid_input", "constraints.must_be_offline 必须是布尔值。", {"field": "constraints.must_be_offline"})
    percent = constraints.get("max_memory_percent")
    if not isinstance(percent, int) or isinstance(percent, bool) or not (1 <= percent <= 100):
        raise ContractError("invalid_input", "constraints.max_memory_percent 必须是 1..100。", {"field": "constraints.max_memory_percent"})
    projected: dict[str, Any] = {"must_be_offline": constraints["must_be_offline"], "max_memory_percent": percent}
    runtime_kind = constraints.get("runtime_kind")
    if runtime_kind is not None:
        if runtime_kind not in ("vllm", "sglang"):
            raise ContractError("invalid_input", "constraints.runtime_kind 只能是 vllm 或 sglang。", {"field": "constraints.runtime_kind"})
        projected["runtime_kind"] = runtime_kind
    quantization = constraints.get("quantization")
    if quantization is not None:
        if not isinstance(quantization, str) or not quantization:
            raise ContractError("invalid_input", "constraints.quantization 必须是非空字符串。", {"field": "constraints.quantization"})
        projected["quantization"] = quantization
    max_gpus = constraints.get("max_candidate_gpus")
    if max_gpus is not None:
        if not isinstance(max_gpus, int) or isinstance(max_gpus, bool) or max_gpus < 1:
            raise ContractError("invalid_input", "constraints.max_candidate_gpus 必须是 >=1 的整数。", {"field": "constraints.max_candidate_gpus"})
        projected["max_candidate_gpus"] = max_gpus
    return projected


def _validated_workload(raw: dict[str, Any]) -> dict[str, Any]:
    allowed = {"input_tokens", "output_tokens", "concurrency"}
    unknown = set(raw) - allowed
    if unknown:
        raise ContractError("invalid_input", f"workload 含未知字段：{sorted(unknown)}。", {"unknown": sorted(unknown)})
    missing = allowed - set(raw)
    if missing:
        raise ContractError("invalid_input", f"workload 缺少字段：{sorted(missing)}。", {"missing": sorted(missing)})
    return {
        "input_tokens": _positive_int(raw["input_tokens"], "workload.input_tokens", *RECOMMEND_INPUT_RANGES["input_tokens"]),
        "output_tokens": _positive_int(raw["output_tokens"], "workload.output_tokens", *RECOMMEND_INPUT_RANGES["output_tokens"]),
        "concurrency": _positive_int(raw["concurrency"], "workload.concurrency", *RECOMMEND_INPUT_RANGES["concurrency"]),
    }


def _validated_workload_buckets(raw: dict[str, Any]) -> dict[str, Any]:
    allowed = {"input_bucket", "output_bucket", "load_bucket"}
    if set(raw) != allowed:
        raise ContractError("invalid_input", "workload_buckets 必须恰好包含 input_bucket、output_bucket、load_bucket。", {"field": "workload_buckets"})
    if raw["input_bucket"] not in TOKEN_BUCKETS or raw["output_bucket"] not in TOKEN_BUCKETS:
        raise ContractError("invalid_input", "workload_buckets 的 token 桶不合法。", {"field": "workload_buckets"})
    if raw["load_bucket"] not in LOAD_BUCKETS:
        raise ContractError("invalid_input", "workload_buckets 的 load 桶不合法。", {"field": "workload_buckets"})
    return {"input_bucket": raw["input_bucket"], "output_bucket": raw["output_bucket"], "load_bucket": raw["load_bucket"]}


def _buckets_from_workload(workload: dict[str, Any]) -> dict[str, Any]:
    return {
        "input_bucket": _token_bucket(workload["input_tokens"]),
        "output_bucket": _token_bucket(workload["output_tokens"]),
        "load_bucket": _load_bucket(workload["concurrency"]),
    }


def _representative_workload(buckets: dict[str, Any]) -> dict[str, Any]:
    return {
        "input_tokens": BUCKET_REPRESENTATIVE_TOKENS[buckets["input_bucket"]],
        "output_tokens": BUCKET_REPRESENTATIVE_TOKENS[buckets["output_bucket"]],
        "concurrency": BUCKET_REPRESENTATIVE_LOAD[buckets["load_bucket"]],
    }


def _validated_sla(sla: Any) -> dict[str, Any]:
    if not isinstance(sla, dict):
        raise ContractError("invalid_input", "sla 必须是对象。", {"field": "sla"})
    allowed = {"ttft_ms", "throughput_tokens_per_second"}
    unknown = set(sla) - allowed
    if unknown:
        raise ContractError("invalid_input", f"sla 含未知字段：{sorted(unknown)}。", {"unknown": sorted(unknown)})
    projected: dict[str, Any] = {}
    for field in ("ttft_ms", "throughput_tokens_per_second"):
        value = sla.get(field)
        if value is None:
            continue
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)) or value <= 0:
            raise ContractError("invalid_input", f"sla.{field} 必须是正数。", {"field": f"sla.{field}"})
        projected[field] = value
    if not projected:
        raise ContractError("invalid_input", "sla 至少一个字段。", {"field": "sla"})
    return projected


def _validated_layout(layout: Any) -> dict[str, Any]:
    if not isinstance(layout, dict):
        raise ContractError("invalid_input", "layout 必须是对象。", {"field": "layout"})
    allowed = {"runtime_kind", "serving_config"}
    unknown = set(layout) - allowed
    if unknown:
        raise ContractError("invalid_input", f"layout 含未知字段：{sorted(unknown)}。", {"unknown": sorted(unknown)})
    runtime_kind = layout.get("runtime_kind")
    if runtime_kind not in ("vllm", "sglang"):
        raise ContractError("invalid_input", "layout.runtime_kind 只能是 vllm 或 sglang。", {"field": "layout.runtime_kind"})
    serving_config = layout.get("serving_config")
    if not isinstance(serving_config, dict):
        raise ContractError("invalid_input", "layout.serving_config 必须是对象。", {"field": "layout.serving_config"})
    whitelist = _serving_whitelist(runtime_kind)
    for key, value in serving_config.items():
        if key == "gpu_device_ids" or key not in whitelist:
            raise ContractError("invalid_input", f"layout.serving_config.{key} 不在适配器白名单内。", {"field": f"layout.serving_config.{key}"})
        if key in FORBIDDEN_CLOUD_FIELD_NAMES or not isinstance(value, CANONICAL_SCALARS):
            raise ContractError("invalid_input", f"layout.serving_config.{key} 禁止字段或非标量值。", {"field": f"layout.serving_config.{key}"})
    return {"runtime_kind": runtime_kind, "serving_config": serving_config}


def _validated_models(models: Any) -> list[dict[str, Any]]:
    if not isinstance(models, list):
        raise ContractError("invalid_input", "models 必须是数组。", {"field": "models"})
    projected: list[dict[str, Any]] = []
    for index, item in enumerate(models):
        if not isinstance(item, dict):
            raise ContractError("invalid_input", f"models[{index}] 必须是对象。", {"field": f"models[{index}]"})
        allowed = {"model_id", "revision", "quantization"}
        unknown = set(item) - allowed
        if unknown:
            raise ContractError("invalid_input", f"models[{index}] 含未知字段：{sorted(unknown)}。", {"unknown": sorted(unknown)})
        model_id = item.get("model_id")
        if not isinstance(model_id, str) or not _MODEL_ID.match(model_id):
            raise ContractError("invalid_input", f"models[{index}].model_id 不合法。", {"field": f"models[{index}].model_id"})
        entry: dict[str, Any] = {"model_id": model_id}
        for field in ("revision", "quantization"):
            value = item.get(field)
            if value is None:
                continue
            if not isinstance(value, str) or not value:
                raise ContractError("invalid_input", f"models[{index}].{field} 必须是非空字符串。", {"field": f"models[{index}].{field}"})
            entry[field] = value
        projected.append(entry)
    return projected


def _validated_query_v2(params: dict[str, Any]) -> dict[str, Any]:
    intent = params.get("intent")
    if intent not in SERVING_SEARCH_INTENTS:
        raise ContractError("invalid_input", "intent 必须是六种 serving_search 意图之一。", {"field": "intent"})
    constraints = _validated_constraints_v2(params.get("constraints"))
    target_raw = params.get("target")
    target: dict[str, Any] | None = None
    if target_raw is not None:
        if not isinstance(target_raw, dict):
            raise ContractError("invalid_input", "target 必须是对象。", {"field": "target"})
        target = _validated_target_v2(target_raw)

    models_raw = params.get("models")
    models: list[dict[str, Any]] | None = None
    if models_raw is not None:
        models = _validated_models(models_raw)

    scenario = params.get("scenario")
    if scenario is not None and scenario not in SCENARIOS:
        raise ContractError("invalid_input", "scenario 必须是 chat、rag、batch 或 coding。", {"field": "scenario"})

    workload_raw = params.get("workload")
    buckets_raw = params.get("workload_buckets")
    workload: dict[str, Any] | None = None
    buckets: dict[str, Any] | None = None
    if workload_raw is not None:
        if not isinstance(workload_raw, dict):
            raise ContractError("invalid_input", "workload 必须是对象。", {"field": "workload"})
        workload = _validated_workload(workload_raw)
        buckets = _buckets_from_workload(workload)
    elif scenario is not None:
        workload = dict(SCENARIO_DEFAULT_WORKLOADS[scenario])
        buckets = _buckets_from_workload(workload)
    elif buckets_raw is not None:
        if not isinstance(buckets_raw, dict):
            raise ContractError("invalid_input", "workload_buckets 必须是对象。", {"field": "workload_buckets"})
        buckets = _validated_workload_buckets(buckets_raw)
        workload = _representative_workload(buckets)

    sla_raw = params.get("sla")
    sla: dict[str, Any] | None = None
    if sla_raw is not None:
        sla = _validated_sla(sla_raw)

    layout_raw = params.get("layout")
    layout: dict[str, Any] | None = None
    if layout_raw is not None:
        layout = _validated_layout(layout_raw)

    if intent == "fit_model":
        if target is None:
            raise ContractError("invalid_input", "fit_model 需要 target.model_id。", {"intent": intent, "field": "target.model_id"})
    elif intent == "search_layout":
        if target is None:
            raise ContractError("invalid_input", "search_layout 需要 target.model_id。", {"intent": intent, "field": "target.model_id"})
        if sla is None:
            raise ContractError("invalid_input", "search_layout 需要 sla 至少一个字段。", {"intent": intent, "field": "sla"})
    elif intent == "score_layout":
        if target is None:
            raise ContractError("invalid_input", "score_layout 需要 target.model_id。", {"intent": intent, "field": "target.model_id"})
        if layout is None:
            raise ContractError("invalid_input", "score_layout 需要 layout。", {"intent": intent, "field": "layout"})
    elif intent == "compare_models":
        if models is None or len(models) < 2:
            raise ContractError("invalid_input", "compare_models 需要 models.length >= 2。", {"intent": intent, "field": "models"})

    query: dict[str, Any] = {"intent": intent, "constraints": constraints}
    if target is not None:
        query["target"] = target
    if models is not None:
        query["models"] = models
    if scenario is not None:
        query["scenario"] = scenario
    if workload is not None:
        query["workload"] = workload
    if buckets is not None:
        query["workload_buckets"] = buckets
    if sla is not None:
        query["sla"] = sla
    if layout is not None:
        query["layout"] = layout
    return query


def _validated_declared_environment(raw: Any) -> tuple[dict[str, Any], str | None]:
    if not isinstance(raw, dict):
        raise ContractError("invalid_input", "environment 必须是对象。", {"field": "environment"})
    required = {"gpu_arch", "gpu_count", "vram_bucket", "driver_major", "cuda_major"}
    allowed = required | {"gpu_product", "vram_gib"}
    unknown = set(raw) - allowed
    if unknown:
        raise ContractError("invalid_input", f"environment 含未知字段：{sorted(unknown)}。", {"unknown": sorted(unknown), "field": "environment"})
    missing = required - set(raw)
    if missing:
        raise ContractError("invalid_input", f"environment 缺少字段：{sorted(missing)}。", {"missing": sorted(missing), "field": "environment"})
    arch = raw["gpu_arch"]
    if arch not in _DECLARED_ARCHES:
        raise ContractError("invalid_input", "environment.gpu_arch 必须是 Turing、Ampere、Ada、Hopper 或 Blackwell。", {"field": "environment.gpu_arch"})
    gpu_count = raw["gpu_count"]
    if not isinstance(gpu_count, int) or isinstance(gpu_count, bool) or not (1 <= gpu_count <= 256):
        raise ContractError("invalid_input", "environment.gpu_count 必须是 1..256 的整数。", {"field": "environment.gpu_count"})
    bucket = raw["vram_bucket"]
    if bucket not in VRAM_BUCKETS:
        raise ContractError("invalid_input", "environment.vram_bucket 不在现有六档内。", {"field": "environment.vram_bucket"})
    for field in ("driver_major", "cuda_major"):
        value = raw[field]
        if not isinstance(value, str) or len(value) > 16 or not _MAJOR_VERSION.match(value):
            raise ContractError("invalid_input", f"environment.{field} 必须是不超过 16 字符的数字版本。", {"field": f"environment.{field}"})
    environment: dict[str, Any] = {
        "gpu_arch": arch,
        "gpu_count": gpu_count,
        "vram_bucket": bucket,
        "driver_major": raw["driver_major"],
        "cuda_major": raw["cuda_major"],
    }
    note: str | None = None
    if "gpu_product" in raw and raw["gpu_product"] is not None:
        product = raw["gpu_product"]
        if not isinstance(product, str) or not _GPU_PRODUCT_NAME.match(product):
            raise ContractError("invalid_input", "environment.gpu_product 格式不合法。", {"field": "environment.gpu_product"})
        if product in gpu_product_exact_keys():
            environment["gpu_product"] = product
        else:
            note = f"提供的名字 {product} 不是查找键。"
    if "vram_gib" in raw and raw["vram_gib"] is not None:
        vram = raw["vram_gib"]
        if not isinstance(vram, int) or isinstance(vram, bool) or not (1 <= vram <= 2048):
            raise ContractError("invalid_input", "environment.vram_gib 必须是 1..2048 的整数。", {"field": "environment.vram_gib"})
        environment["vram_gib"] = vram
    return environment, note


def cloud_prepare_recommendation(params: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:
    store: CoreStore = context["store"]
    with ManagedRun(store, "cloud_prepare_recommendation", params, context["session_id"], context) as run:
        if "environment" in params and ("hardware_snapshot_id" in params or "snapshot_id" in params):
            raise ContractError("invalid_input", "environment 与本机快照互斥。", {"field": "environment"})
        query = _validated_query_v2(params)
        _scan_forbidden(query)
        note: str | None = None
        assumptions: list[str] | None = None
        if "environment" in params:
            environment, note = _validated_declared_environment(params.get("environment"))
            _scan_forbidden(environment)
            binding = "declared"
            environment_source = "declared"
            assumptions = ["driver_major", "cuda_major"]
        else:
            snapshot = _latest_snapshot(store)
            environment = _environment_projection_v2(snapshot)
            binding = "bound"
            environment_source = "snapshot"
        payload: dict[str, Any] = {
            "intent": query["intent"],
            "environment": environment,
            "constraints": query["constraints"],
        }
        for field in ("target", "models", "scenario", "workload", "workload_buckets", "sla", "layout"):
            if field in query:
                payload[field] = query[field]
        envelope = {
            "schema_version": RECOMMENDATION_SCHEMA_VERSION_V2,
            "client_version": "bittune-core",
            "request_id": f"req-{uuid.uuid4().hex}",
            "payload": payload,
        }
        target_for_hash = query.get("target") or {}
        data: dict[str, Any] = {
            "envelope": envelope,
            "request_hash": cloud_canonical_hash(payload),
            "environment": environment,
            "environment_hash": cloud_canonical_hash(environment),
            "target_hash": cloud_canonical_hash(target_for_hash),
            "constraints_hash": cloud_canonical_hash(query["constraints"]),
            "binding": binding,
            "environment_source": environment_source,
        }
        if assumptions is not None:
            data["assumptions"] = assumptions
        if note is not None:
            data["gpu_product_note"] = note
        summary = f"已生成 recommendation-v2 环境/目标投影（rules={SERVING_SEARCH_VERSION}）。"
        if assumptions:
            summary += " driver_major 与 cuda_major 是调用方假设，不是检测结果。"
        if note:
            summary += " " + note
        stored = {"binding": binding, "environment_source": environment_source}
        if assumptions:
            stored["assumptions"] = assumptions
        if note:
            stored["gpu_product_note"] = note
        return run.success(summary, data, stored=stored)


def _record_hashes(params: dict[str, Any], response: dict[str, Any]) -> tuple[str, str]:
    request_hash = params.get("request_hash")
    if not isinstance(request_hash, str) or not request_hash.startswith("sha256:"):
        raise ContractError("invalid_input", "record 需要 cloud_prepare_recommendation 产出的 request_hash。", {})
    response_hash = response.get("request_hash")
    if response_hash != request_hash:
        raise ContractError(
            "invalid_input",
            f"Cloud 响应 request_hash 与本次请求不一致：{response_hash!r} != {request_hash!r}。",
            {"response_hash": response_hash, "request_hash": request_hash},
        )
    response_request_id = response.get("request_id")
    if not isinstance(response_request_id, str) or not REQUEST_ID.match(response_request_id):
        raise ContractError("invalid_input", "Cloud 响应 request_id 缺失或格式不合法。", {})
    expected_request_id = params.get("expected_request_id")
    if expected_request_id is not None and response_request_id != expected_request_id:
        raise ContractError(
            "invalid_input",
            f"Cloud 响应 request_id 与本次查询不一致：{response_request_id!r} != {expected_request_id!r}。",
            {},
        )
    for field in ("environment_hash", "target_hash", "constraints_hash"):
        value = params.get(field)
        if not isinstance(value, str) or not _HASH.match(value):
            raise ContractError("invalid_input", f"record 需要 prepare 产出的 {field}。", {})
    return request_hash, response_request_id


def _record_subject(params: dict[str, Any]) -> tuple[str, str, str | None]:
    binding = params.get("binding", "bound")
    if binding not in BINDING_VALUES:
        raise ContractError("invalid_input", "binding 必须是 bound 或 declared。", {"field": "binding"})
    source = params.get("environment_source", "snapshot")
    if source not in ("snapshot", "declared"):
        raise ContractError("invalid_input", "environment_source 必须是 snapshot 或 declared。", {"field": "environment_source"})
    note = params.get("gpu_product_note")
    if note is not None and (not isinstance(note, str) or not note):
        raise ContractError("invalid_input", "gpu_product_note 必须是非空字符串。", {"field": "gpu_product_note"})
    return binding, source, note


def _record_observation(
    run: ManagedRun,
    response: dict[str, Any],
    request_hash: str,
    params: dict[str, Any],
    response_request_id: str,
) -> dict[str, Any]:
    candidates = response.get("candidates") or []
    artifact_ref = run.artifact("cloud-recommendation", canonical_json(response), "application/json")
    source = {
        item.get("candidate_id"): (item.get("source") or {}).get("kind")
        for item in candidates
        if isinstance(item, dict)
    }
    binding, environment_source, note = _record_subject(params)
    observation = {
        "request_id": response_request_id,
        "rules_version": response.get("rules_version"),
        "request_hash": request_hash,
        "environment_hash": params["environment_hash"],
        "target_hash": params["target_hash"],
        "constraints_hash": params["constraints_hash"],
        "source": source,
        "candidate_count": len(candidates),
        "artifact_id": artifact_ref["artifact_id"],
        "recorded_at": utc_now(),
        "binding": binding,
        "environment_source": environment_source,
    }
    if note:
        observation["gpu_product_note"] = note
    return run.success(
        f"已记录 Cloud 推荐响应（{len(candidates)} 个候选）。",
        observation,
        stored={"binding": binding, "environment_source": environment_source, **({"gpu_product_note": note} if note else {})},
    )


def record_cloud_recommendation(params: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:
    store: CoreStore = context["store"]
    with ManagedRun(store, "record_cloud_recommendation", params, context["session_id"], context) as run:
        response = params.get("response")
        if not isinstance(response, dict):
            raise ContractError("unsupported_contract", "Cloud 响应必须是对象。", {})
        schema_version = response.get("schema_version")
        if schema_version != RECOMMENDATION_SCHEMA_VERSION_V2:
            raise ContractError(
                "unsupported_contract",
                f"Cloud 响应 schema_version {schema_version!r} 不受支持。",
                {"supported": [RECOMMENDATION_SCHEMA_VERSION_V2]},
            )
        if response.get("rules_version") != SERVING_SEARCH_VERSION:
            raise ContractError("unsupported_contract", f"Cloud 响应 rules_version 必须为 {SERVING_SEARCH_VERSION}。", {})
        candidates = response.get("candidates")
        if candidates is not None and (not isinstance(candidates, list) or len(candidates) > 100):
            raise ContractError("invalid_input", "Cloud 响应 candidates 规模超出上限。", {})
        request_hash, response_request_id = _record_hashes(params, response)
        _scan_forbidden(response)
        _validate_measurement_basis_v2(response.get("measurement_basis"), candidates or [])
        seen_ids: set[str] = set()
        for index, candidate in enumerate(candidates or []):
            if not isinstance(candidate, dict):
                raise ContractError("invalid_input", f"candidates[{index}] 必须是对象。", {})
            _validate_candidate_v2(candidate, index, seen_ids)
        return _record_observation(run, response, request_hash, params, response_request_id)


def record_cloud_recommendation_outcome(params: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:
    store: CoreStore = context["store"]
    with ManagedRun(store, "record_cloud_recommendation_outcome", params, context["session_id"], context) as run:
        for field in ("request_hash", "environment_hash", "target_hash", "constraints_hash"):
            value = params.get(field)
            if not isinstance(value, str) or not _HASH.match(value):
                raise ContractError("invalid_input", f"outcome 需要 prepare 产出的 {field}。", {"field": field})
        outcome = params.get("outcome")
        if outcome not in CLOUD_RECOMMENDATION_OUTCOMES:
            raise ContractError("invalid_input", "outcome 必须是 http_error、auth_error、unsupported_contract 或 transport_error。", {"field": "outcome"})
        expected_request_id = params.get("expected_request_id")
        if expected_request_id is not None and (not isinstance(expected_request_id, str) or not REQUEST_ID.match(expected_request_id)):
            raise ContractError("invalid_input", "expected_request_id 格式不合法。", {"field": "expected_request_id"})
        http_status = params.get("http_status")
        if http_status is not None and (not isinstance(http_status, int) or isinstance(http_status, bool) or http_status < 0):
            raise ContractError("invalid_input", "http_status 必须是非负整数。", {"field": "http_status"})
        error_code = params.get("error_code")
        if error_code is not None and (not isinstance(error_code, str) or not error_code):
            raise ContractError("invalid_input", "error_code 必须是非空字符串。", {"field": "error_code"})
        error_message = params.get("error_message")
        if error_message is not None and not isinstance(error_message, str):
            raise ContractError("invalid_input", "error_message 必须是字符串。", {"field": "error_message"})
        attempt: dict[str, Any] = {
            "outcome": outcome,
            "request_hash": params["request_hash"],
            "environment_hash": params["environment_hash"],
            "target_hash": params["target_hash"],
            "constraints_hash": params["constraints_hash"],
            "recorded_at": utc_now(),
        }
        if expected_request_id is not None:
            attempt["expected_request_id"] = expected_request_id
        if http_status is not None:
            attempt["http_status"] = http_status
        if error_code is not None:
            attempt["error_code"] = error_code
        if error_message is not None:
            attempt["error_message"] = error_message
        _scan_forbidden(attempt)
        artifact_ref = run.artifact("cloud-recommendation-attempt", canonical_json(attempt), "application/json")
        observation = {
            **attempt,
            "artifact_id": artifact_ref["artifact_id"],
        }
        return run.success(f"已记录 Cloud 推荐失败（{outcome}）。", observation)


def cloud_session_recommend_status(params: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:
    """Gate lookup: exact latest completed recommendation record. Not a ManagedRun."""
    del params
    store: CoreStore = context["store"]
    row = store.latest_session_cloud_recommendation(context["session_id"])
    if row is None:
        return {"status": "none"}
    tool_name = row["tool_name"]
    result: dict[str, Any] = {
        "status": "recorded" if tool_name == "record_cloud_recommendation" else "outcome",
        "run_id": row["run_id"],
    }
    if tool_name == "record_cloud_recommendation":
        artifacts = store.get_run(row["run_id"]).get("artifacts") or []
        for artifact in artifacts:
            if artifact.get("label") == "cloud-recommendation":
                result["artifact_id"] = artifact["artifact_id"]
                break
    return result


CANONICAL_SCALARS = (str, int, float, bool)


def _validate_measurement_basis_v2(basis: Any, candidates: list[Any] | None = None) -> None:
    if not isinstance(basis, list) or not basis:
        raise ContractError("unsupported_contract", "v2 响应 measurement_basis 必须是非空有序去重数组。", {"field": "measurement_basis"})
    allowed = set(MEASUREMENT_BASIS_V2)
    seen: set[str] = set()
    last_rank = -1
    ranks = {name: index for index, name in enumerate(MEASUREMENT_BASIS_V2)}
    for item in basis:
        if item not in allowed:
            raise ContractError("unsupported_contract", "v2 响应 measurement_basis 含非法来源。", {"field": "measurement_basis"})
        if item in seen:
            raise ContractError("unsupported_contract", "v2 响应 measurement_basis 必须去重。", {"field": "measurement_basis"})
        rank = ranks[item]
        if rank < last_rank:
            raise ContractError("unsupported_contract", "v2 响应 measurement_basis 顺序必须是 account_history → catalog → simulated。", {"field": "measurement_basis"})
        seen.add(item)
        last_rank = rank
    if "simulated" in seen:
        return
    for candidate in candidates or []:
        if not isinstance(candidate, dict):
            continue
        source = candidate.get("source")
        kind = source.get("kind") if isinstance(source, dict) else None
        if kind in PREDICTED_SOURCE_KINDS or candidate.get("prediction") is not None:
            raise ContractError(
                "unsupported_contract",
                "v2 响应含 predicted 候选时 measurement_basis 必须包含 simulated。",
                {"field": "measurement_basis"},
            )


def _validate_serving_config_v2(serving_config: dict[str, Any], runtime_kind: str, label: str) -> None:
    whitelist = _serving_whitelist(runtime_kind)
    for key, value in serving_config.items():
        if key == "gpu_device_ids":
            raise ContractError("unsupported_contract", f"{label}.serving_config.gpu_device_ids 禁止出现。", {"field": f"{label}.serving_config.gpu_device_ids"})
        if key not in whitelist:
            raise ContractError("unsupported_contract", f"{label}.serving_config.{key} 不在适配器白名单内。", {"field": f"{label}.serving_config.{key}"})
        if key in FORBIDDEN_CLOUD_FIELD_NAMES or not isinstance(value, CANONICAL_SCALARS):
            raise ContractError("invalid_input", f"{label}.serving_config.{key} 禁止字段或非标量值。", {"field": f"{label}.serving_config.{key}"})


_PREDICTION_METRIC_NAMES = {
    "mean_ttft_ms",
    "mean_tpot_ms",
    "output_throughput_tok_s",
    "completed_request_ratio",
}


def _validate_prediction_v2(prediction: Any, label: str) -> None:
    if not isinstance(prediction, dict):
        raise ContractError("invalid_input", f"{label}.prediction 必须是对象。", {"field": f"{label}.prediction"})
    metrics = prediction.get("metrics")
    if not isinstance(metrics, dict):
        raise ContractError("invalid_input", f"{label}.prediction.metrics 必须是对象。", {"field": f"{label}.prediction.metrics"})
    engine_version = prediction.get("engine_version")
    if not isinstance(engine_version, str) or not engine_version:
        raise ContractError("invalid_input", f"{label}.prediction.engine_version 必须是非空字符串。", {"field": f"{label}.prediction.engine_version"})
    if prediction.get("measurement_basis") != "simulated":
        raise ContractError("unsupported_contract", f"{label}.prediction.measurement_basis 必须是 simulated。", {"field": f"{label}.prediction.measurement_basis"})
    extra = set(metrics) - _PREDICTION_METRIC_NAMES
    if extra:
        raise ContractError("unsupported_contract", f"{label}.prediction.metrics 含未知或禁止指标：{sorted(extra)}。", {"field": f"{label}.prediction.metrics"})


def _validate_complete_blocks_v2(candidate: dict[str, Any], label: str, reject) -> str:
    catalog_version = candidate.get("catalog_version")
    if not isinstance(catalog_version, int) or isinstance(catalog_version, bool) or catalog_version < 1:
        raise reject("catalog_version", "必须是 >=1 的整数")
    model_ref = candidate.get("model_ref")
    if not isinstance(model_ref, dict):
        raise reject("model_ref", "必须是对象")
    if not isinstance(model_ref.get("model_id"), str) or not _MODEL_ID.match(model_ref["model_id"]):
        raise reject("model_ref.model_id", "模式不合法")
    if not isinstance(model_ref.get("revision"), str) or not model_ref["revision"] or len(model_ref["revision"]) > 200:
        raise reject("model_ref.revision", "必须是非空 revision")
    if not isinstance(model_ref.get("quantization"), str) or not model_ref["quantization"] or len(model_ref["quantization"]) > 64:
        raise reject("model_ref.quantization", "必须是非空量化名")
    runtime_spec = candidate.get("runtime_spec")
    if not isinstance(runtime_spec, dict):
        raise reject("runtime_spec", "必须是对象")
    runtime_kind = runtime_spec.get("runtime_kind")
    if runtime_kind not in ("vllm", "sglang"):
        raise reject("runtime_spec.runtime_kind", "枚举不合法")
    if not isinstance(runtime_spec.get("runtime_major"), str) or not _RUNTIME_MAJOR.match(runtime_spec["runtime_major"]):
        raise reject("runtime_spec.runtime_major", "必须是纯数字主版本")
    if not isinstance(runtime_spec.get("image_repository"), str) or not runtime_spec["image_repository"] or len(runtime_spec["image_repository"]) > 512:
        raise reject("runtime_spec.image_repository", "必须是非空仓库名")
    if not isinstance(runtime_spec.get("image_digest"), str) or not runtime_spec["image_digest"].startswith("sha256:"):
        raise reject("runtime_spec.image_digest", "必须是 sha256:<hex>")
    requirements = candidate.get("environment_requirements") or {}
    if not isinstance(requirements, dict):
        raise reject("environment_requirements", "必须是对象")
    gpu_arch = requirements.get("gpu_arch")
    if not isinstance(gpu_arch, str) or not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", gpu_arch):
        raise reject("environment_requirements.gpu_arch", "模式不合法")
    serving_config = candidate.get("serving_config")
    if not isinstance(serving_config, dict):
        raise reject("serving_config", "必须是对象")
    _validate_serving_config_v2(serving_config, runtime_kind, label)
    return runtime_kind


def _validate_candidate_v2(candidate: dict[str, Any], index: int, seen_ids: set[str]) -> None:
    """v2 candidate validator. Coverage may omit serving blocks; deployable kinds may not."""
    label = f"candidates[{index}]"

    def reject(field: str, message: str) -> ContractError:
        return ContractError("invalid_input", f"{label}.{field} 非法：{message}。", {"field": f"{label}.{field}"})

    candidate_id = candidate.get("candidate_id")
    if not isinstance(candidate_id, str) or not re.fullmatch(r"[A-Za-z0-9._-]{1,128}", candidate_id):
        raise reject("candidate_id", "模式不合法")
    if candidate_id in seen_ids:
        raise ContractError("unsupported_contract", f"{label}.candidate_id 在同一响应内重复。", {"field": f"{label}.candidate_id"})
    seen_ids.add(candidate_id)

    source = candidate.get("source")
    if not isinstance(source, dict) or source.get("kind") not in CANDIDATE_SOURCE_KINDS_V2:
        raise reject("source.kind", "枚举不合法")
    kind = source["kind"]
    entry_id = source.get("entry_id")
    if entry_id is not None:
        if not isinstance(entry_id, str) or not entry_id:
            raise reject("source.entry_id", "必须是非空字符串")
        if candidate_id == entry_id:
            raise ContractError("unsupported_contract", f"{label}.candidate_id 不得等于 source.entry_id。", {"field": f"{label}.candidate_id"})

    prediction = candidate.get("prediction")
    if kind == "coverage":
        model_ref = candidate.get("model_ref")
        if not isinstance(model_ref, dict):
            raise reject("model_ref", "必须是对象")
        if not isinstance(model_ref.get("model_id"), str) or not _MODEL_ID.match(model_ref["model_id"]):
            raise reject("model_ref.model_id", "模式不合法")
        if prediction is not None:
            raise ContractError("unsupported_contract", f"{label}.prediction 在 coverage 候选上禁止出现。", {"field": f"{label}.prediction"})
        serving_config = candidate.get("serving_config")
        if serving_config is not None:
            runtime_spec = candidate.get("runtime_spec") or {}
            runtime_kind = runtime_spec.get("runtime_kind") if isinstance(runtime_spec, dict) else None
            if runtime_kind not in ("vllm", "sglang"):
                raise reject("runtime_spec.runtime_kind", "覆盖 serving_config 时必须声明 runtime_kind")
            if not isinstance(serving_config, dict):
                raise reject("serving_config", "必须是纯标量对象")
            _validate_serving_config_v2(serving_config, runtime_kind, label)
        return

    _validate_complete_blocks_v2(candidate, label, reject)
    if kind in ("catalog", "account_success"):
        if not isinstance(entry_id, str) or not entry_id:
            raise ContractError("unsupported_contract", f"{label}.source.entry_id 来自目录的可部署候选必填。", {"field": f"{label}.source.entry_id"})
        if prediction is not None:
            raise ContractError("unsupported_contract", f"{label}.prediction 在 {kind} 候选上禁止出现。", {"field": f"{label}.prediction"})
        return
    if kind in PREDICTED_SOURCE_KINDS:
        if not isinstance(entry_id, str) or not entry_id:
            raise ContractError("unsupported_contract", f"{label}.source.entry_id 来自目录的可部署候选必填。", {"field": f"{label}.source.entry_id"})
        if prediction is None:
            raise ContractError("unsupported_contract", f"{label}.prediction 在 {kind} 候选上必填。", {"field": f"{label}.prediction"})
        _validate_prediction_v2(prediction, label)
        return
    raise reject("source.kind", "枚举不合法")


def _report_and_references(store: CoreStore, report_id: str) -> tuple[dict[str, Any], dict[str, Any]]:
    fact = store.get_fact("report", report_id)
    report = fact["payload"]
    references = report.get("references") or {}
    benchmark_ids = [item["id"] for item in references.get("benchmark_result_ids") or [] if isinstance(item, dict)]
    experiment_ids = [item["id"] for item in references.get("experiment_ids") or [] if isinstance(item, dict)]
    run_ids = [item["id"] for item in references.get("run_ids") or [] if isinstance(item, dict)]
    if not benchmark_ids:
        raise ContractError("invalid_input", "Report 没有引用 BenchmarkResult；经验导出以实测事实为唯一来源。", {}, remediation="先完成 benchmark_service 并把结果引用进 write_report。")
    for benchmark_id in benchmark_ids:
        if not claimable(store.get_fact("benchmark_result", benchmark_id)["payload"]):
            raise ContractError(
                "invalid_input",
                "该结果不是产品签字的实测。",
                {"benchmark_result_id": benchmark_id},
                remediation="该结果不是产品签字的实测。",
            )
    return report, {"benchmark_ids": benchmark_ids, "experiment_ids": experiment_ids, "run_ids": run_ids}


def _resolve_outcome(store: CoreStore, experiment_ids: list[str], run_ids: list[str]) -> str:
    """Outcome provenance: Experiment verdicts map directly (§4.4); failed /
    cancelled Runs cover deployment/benchmark failures; nothing else may
    produce a success claim."""
    if experiment_ids:
        verdicts: list[str] = []
        for experiment_id in experiment_ids:
            experiment = store.get_fact("experiment", experiment_id)["payload"]
            deltas = (experiment.get("conclusion") or {}).get("deltas") or []
            verdicts.extend(item.get("verdict") for item in deltas)
        mapped = [outcome for verdict in verdicts if (outcome := _VERDICT_TO_OUTCOME.get(verdict)) is not None]
        if not mapped:
            raise ContractError("invalid_input", "Experiment 没有可映射的 verdict。", {})
        if "success" in mapped:
            return "success"
        if all(outcome == "no_gain" for outcome in mapped):
            return "no_gain"
        return "failure"
    statuses = {store.get_run(run_id)["status"] for run_id in run_ids} if run_ids else set()
    if "failed" in statuses and "cancelled" not in statuses:
        return "failure"
    if "cancelled" in statuses and "failed" not in statuses:
        return "cancelled"
    raise ContractError(
        "invalid_input",
        "Report 没有可解释为 outcome 的 Experiment/Run 结论；先 compare_results(record=true) 或让部署/压测失败形成事实。",
        {},
        remediation="success/no_gain 只能由 Experiment 比较解释映射；failure/cancelled 由对应 Run 状态产生。",
    )


def _build_export(store: CoreStore, report_id: str, consent_at: str) -> dict[str, Any]:
    report, references = _report_and_references(store, report_id)
    # The primary benchmark carries the exported environment/model/config;
    # when the report's experiments name a compared candidate, that exact
    # BenchmarkResult is the primary fact - anything else would export a
    # mixed identity.
    experiments = [store.get_fact("experiment", experiment_id)["payload"] for experiment_id in references["experiment_ids"]]
    compared_candidate_id = None
    for experiment in experiments:
        deltas = (experiment.get("conclusion") or {}).get("deltas") or []
        if deltas and isinstance(deltas[0].get("benchmark_result_id"), str):
            compared_candidate_id = deltas[0]["benchmark_result_id"]
            break
    if compared_candidate_id and compared_candidate_id not in references["benchmark_ids"]:
        raise ContractError(
            "invalid_input",
            f"Experiment 的 compared 基准 {compared_candidate_id} 不在 Report 引用中，事实不一致，拒绝导出。",
            {"compared": compared_candidate_id, "referenced": references["benchmark_ids"]},
        )
    benchmark = store.get_fact("benchmark_result", references["benchmark_ids"][0])["payload"]
    for benchmark_id in references["benchmark_ids"][1:]:
        candidate = store.get_fact("benchmark_result", benchmark_id)["payload"]
        if (candidate.get("measured_at") or "") > (benchmark.get("measured_at") or ""):
            benchmark = candidate
    if compared_candidate_id is not None and benchmark.get("benchmark_result_id") != compared_candidate_id:
        benchmark = store.get_fact("benchmark_result", compared_candidate_id)["payload"]
    snapshot_id = benchmark.get("hardware_snapshot_id")
    if not isinstance(snapshot_id, str) or not snapshot_id:
        raise ContractError("invalid_input", "BenchmarkResult 缺少 hardware_snapshot_id，无法生成环境投影。", {})
    snapshot = store.get_fact("hardware_snapshot", snapshot_id)["payload"]
    model_ref = benchmark.get("model_ref") or {}
    runtime_spec = benchmark.get("runtime_spec") or {}
    serving_spec = benchmark.get("serving_spec") or {}
    # Refuse forbidden content before any outcome work so a poisoned config
    # can never ride along regardless of what other facts say.
    _scan_forbidden({"model_ref": model_ref, "runtime_spec": runtime_spec, "serving_spec": serving_spec})
    if not isinstance(model_ref.get("quantization"), str) or not model_ref["quantization"]:
        raise ContractError(
            "invalid_input",
            "计划未声明量化方式；经验导出需要固定 revision + quantization。",
            {},
            remediation="用带 model_ref.quantization 的计划重新部署并压测。",
        )
    if not isinstance(runtime_spec.get("runtime_major"), str) or not runtime_spec["runtime_major"]:
        raise ContractError(
            "invalid_input",
            "计划未声明 runtime 主版本；经验导出需要 runtime_kind + runtime_major。",
            {},
            remediation="用带 runtime_spec.runtime_major 的计划重新部署并压测。",
        )
    # The exported config is filtered through the runtime adapter's declared
    # parameter surface and limited to plain scalars: extra fields, nested
    # structures and forbidden names never leave the machine.
    adapter = require_adapter(runtime_spec["runtime_kind"])
    allowed_params = {item["name"] for item in adapter.PARAMETERS}
    config_fields: dict[str, Any] = {}
    for key, value in serving_spec.items():
        if not isinstance(key, str) or key not in allowed_params:
            raise ContractError(
                "invalid_input",
                f"serving_spec 参数 {key!r} 不是 {runtime_spec['runtime_kind']} 声明的允许字段。",
                {"field": key},
                remediation=f"移除该参数或改用 {runtime_spec['runtime_kind']} adapter 声明的参数。",
            )
        if isinstance(value, bool) or not isinstance(value, CANONICAL_SCALARS):
            raise ContractError("invalid_input", f"serving_spec.{key} 必须是普通 JSON 标量。", {"field": key})
        config_fields[key] = value

    workload = benchmark.get("workload") or {}
    metrics = benchmark.get("metrics") or {}
    # The export is a bounded, frozen summary: only the canonical whitelist
    # names travel, each validated against the wire pattern. Raw EvalScope
    # keys ("request throughput (req/s)") and hundreds of distribution
    # statistics never leave the machine and can never trip Cloud's 422.
    metric_summaries = []
    for name in CLOUD_EXPORT_METRIC_NAMES:
        value = metrics.get(name)
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            continue
        if value < 0:
            raise ContractError("invalid_input", f"指标 {name} 为负值，拒绝导出。", {"field": name})
        summary = {
            "name": name,
            "unit": _METRIC_UNITS.get(name, "raw"),
            "repetitions": max(1, int(workload.get("request_count") or 1)),
            "mean": float(round(value, 6)),
        }
        stdev_key = f"{name}_standard_deviation"
        stdev = metrics.get(stdev_key)
        if isinstance(stdev, (int, float)) and not isinstance(stdev, bool) and math.isfinite(float(stdev)) and stdev >= 0:
            summary["stdev"] = float(round(stdev, 6))
        metric_summaries.append(summary)
    if not metric_summaries:
        raise ContractError("invalid_input", "BenchmarkResult 没有可导出的规范数值指标。", {}, remediation="用标准 benchmark_service 压测后再导出。")
    if len(metric_summaries) > 16:
        raise ContractError("invalid_input", "导出指标超过契约上限 16。", {})
    workload_hash = benchmark.get("workload_hash")
    if not isinstance(workload_hash, str) or not _HASH.match(workload_hash):
        raise ContractError("invalid_input", "BenchmarkResult 缺少合法 workload_hash（sha256:<64 hex>）。", {})
    model_id = model_ref.get("model_id")
    if not isinstance(model_id, str) or not _MODEL_ID.match(model_id):
        raise ContractError("invalid_input", "model_ref.model_id 不合法，拒绝导出。", {})

    outcome = _resolve_outcome(store, references["experiment_ids"], references["run_ids"])
    input_tokens = int(workload.get("input_tokens") or 0)
    output_tokens = int(workload.get("output_tokens") or 0)
    concurrency = int(workload.get("concurrency") or 1)
    request_count = max(1, int(workload.get("request_count") or 1))
    runtime_major = str(runtime_spec["runtime_major"])
    runtime_version = runtime_spec.get("runtime_version")
    if not isinstance(runtime_version, str) or not runtime_version:
        runtime_version = runtime_major
    runtime = {
        "runtime_kind": runtime_spec["runtime_kind"],
        "runtime_major": runtime_major,
        "runtime_version": str(runtime_version)[:64],
    }
    image_digest = runtime_spec.get("image_digest")
    if isinstance(image_digest, str) and _HASH.match(image_digest):
        runtime["image_digest"] = image_digest
    payload: dict[str, Any] = {
        "schema_version": EXPERIENCE_SCHEMA_VERSION,
        "source_report_hash": sha256_canonical(report),
        "consent_confirmed": True,
        "consent_at": consent_at,
        "evidence_level": "local_measured",
        "environment": _export_environment(snapshot),
        "model": {
            "model_id": model_ref["model_id"],
            "revision": model_ref["revision"],
            "quantization": model_ref["quantization"],
        },
        "runtime": runtime,
        "workload": {
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "concurrency": concurrency,
            "request_count": request_count,
            "input_bucket": _token_bucket(input_tokens),
            "output_bucket": _token_bucket(output_tokens),
            "load_bucket": _load_bucket(concurrency),
            "workload_hash": benchmark.get("workload_hash") or "",
        },
       "config": {"config_hash": sha256_canonical(config_fields), "fields": config_fields},
        "outcome": outcome,
        "metrics": metric_summaries,
    }

    # baseline/candidate/delta come from the same Experiment and the same
    # BenchmarkResult pair; anything incomplete or uncomparable is omitted
    # rather than invented (design §4.4).
    experiments = [store.get_fact("experiment", experiment_id)["payload"] for experiment_id in references["experiment_ids"]]
    for experiment in experiments:
        conclusion = experiment.get("conclusion") or {}
        deltas = conclusion.get("deltas") or []
        if not deltas:
            continue
        if conclusion.get("comparable") is not True:
            continue
        objective = conclusion.get("objective") or deltas[0].get("objective_metric")
        if not isinstance(objective, str):
            continue
        baseline_id = conclusion.get("baseline_benchmark_result_id")
        candidate_id = deltas[0].get("benchmark_result_id")
        baseline_payload = store.get_fact("benchmark_result", baseline_id)["payload"] if isinstance(baseline_id, str) and baseline_id else None
        candidate_payload = store.get_fact("benchmark_result", candidate_id)["payload"] if isinstance(candidate_id, str) and candidate_id else None
        if baseline_payload is None or candidate_payload is None:
            continue
        base_mean = (baseline_payload.get("metrics") or {}).get(objective)
        cand_mean = (candidate_payload.get("metrics") or {}).get(objective)
        if not isinstance(base_mean, (int, float)) or isinstance(base_mean, bool) or not math.isfinite(float(base_mean)):
            continue
        if not isinstance(cand_mean, (int, float)) or isinstance(cand_mean, bool) or not math.isfinite(float(cand_mean)):
            continue
        base_model_id = (baseline_payload.get("model_ref") or {}).get("model_id", "")
        cand_model_id = (candidate_payload.get("model_ref") or {}).get("model_id", "")
        if not _MODEL_ID.match(str(base_model_id)) or not _MODEL_ID.match(str(cand_model_id)):
            # Pattern-invalid identity: omit the comparison block rather than
            # shipping a value Cloud would reject.
            continue
        percent = deltas[0].get("delta_percent", 0)
        if not isinstance(percent, (int, float)) or isinstance(percent, bool) or not math.isfinite(float(percent)):
            continue
        if objective not in CLOUD_EXPORT_METRIC_NAMES:
            continue
        target = (
            "lower_better"
            if any(token in objective.lower() for token in ("latency", "ttft", "tpot", "itl"))
            else "higher_better"
        )
        value_pct = float(percent) if target == "higher_better" else float(-percent)
        payload["baseline"] = {
            "model_id": base_model_id,
            "mean": float(base_mean),
            "unit": _METRIC_UNITS.get(objective, "raw"),
            "repetitions": max(1, int((baseline_payload.get("workload") or {}).get("request_count") or 1)),
        }
        payload["candidate"] = {
            "model_id": cand_model_id,
            "mean": float(cand_mean),
            "unit": _METRIC_UNITS.get(objective, "raw"),
            "repetitions": max(1, int((candidate_payload.get("workload") or {}).get("request_count") or 1)),
        }
        payload["delta"] = {
            "unit": _METRIC_UNITS.get(objective, "raw"),
            "value_pct": value_pct,
            "target": target,
            "objective_metric": objective,
        }
        break

    _scan_forbidden(payload)
    _validate_export_payload(payload)
    if len(canonical_json(payload).encode("utf-8")) > 256 * 1024:
        raise ContractError("payload_too_large", "导出 payload 超过 256 KiB 上限。", {})
    return payload


def cloud_experience_preview(params: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:
    store: CoreStore = context["store"]
    with ManagedRun(store, "cloud_experience_preview", params, context["session_id"], context) as run:
        report_id = params.get("report_id")
        if not isinstance(report_id, str) or not report_id:
            raise ContractError("invalid_input", "report_id 是必填的。", {})
        report_fact = store.get_fact("report", report_id)
        # The preview carries the Report's own timestamp as consent_at so the
        # preview hash is stable across repeated calls; the enqueue action
        # replaces it with the real consent time.
        payload = _build_export(store, report_id, str(report_fact["payload"].get("created_at") or utc_now()))
        warnings = [
            "no_gain/failure 会进入账号历史并影响后续风险提示，但不会支持首选参数；cancelled 不参与推荐排序。",
            "仅当前账号可见；原始日志、Prompt、响应、权重、数据集、Secret、IP、主机名和完整路径不会上传。",
        ]
        # Display-only guidance for the confirmation UI. It never changes the
        # uploaded experience-export-v2 payload: the upload stays exactly as
        # previewed, and Cloud derives the public projection itself.
        display = {
            "defaults": {
                "visibility_scope": "private",
                "author_display": "anonymous",
            },
            "publication_consent_fields": [
                "environment_summary", "model_summary", "runtime_summary",
                "workload_summary", "config_summary", "metrics_summary",
                "outcome", "comparison_summary",
            ],
            "never_uploaded": [
                "原始日志", "Prompt/响应", "模型权重", "数据集", "Secret/Token",
                "IP/主机名", "完整路径/命令",
            ],
            "retraction_note": "发送后若想停止公开，可在 Cloud Web 撤回；撤回不修改本地 Report/Artifact。",
            "compare_rank_note": (
                "无 GPU 产品名时仍可上传，但不能进入选型对比和官方榜。"
                if "gpu_product" not in payload.get("environment", {})
                else "有 GPU 产品名后，公开审核通过的记录才可能进入选型对比；官方榜另需时延提升。"
            ),
        }
        return run.success(
            "已生成经验导出预览（不写入 Outbox）。",
            {"preview": payload, "content_hash": cloud_canonical_hash(payload), "display": display},
            warnings,
        )


def cloud_experience_enqueue(params: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:
    store: CoreStore = context["store"]
    with ManagedRun(store, "cloud_experience_enqueue", params, context["session_id"], context) as run:
        report_id = params.get("report_id")
        if not isinstance(report_id, str) or not report_id:
            raise ContractError("invalid_input", "report_id 是必填的。", {})
        report_fact = store.get_fact("report", report_id)
        payload = _build_export(store, report_id, utc_now())
        export_id = f"exp-{uuid.uuid4().hex}"
        queued = store.outbox_put(payload, export_id, sha256_canonical(report_fact["payload"]), utc_now())
        return run.success(
            f"已加入待发送队列（export {export_id}）。发送前仍可取消；请用户选择现在发送或稍后发送。",
            {"export_id": export_id, "status": queued["status"], "content_hash": queued["content_hash"], "payload": payload},
        )


def cloud_outbox_list(params: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:
    store: CoreStore = context["store"]
    with ManagedRun(store, "cloud_outbox_list", params, context["session_id"], context) as run:
        status = params.get("status") if isinstance(params.get("status"), str) else None
        items = store.outbox_list(status)
        return run.success(f"待发送队列共 {len(items)} 项。", {"outbox": items})


def cloud_outbox_cancel(params: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:
    store: CoreStore = context["store"]
    with ManagedRun(store, "cloud_outbox_cancel", params, context["session_id"], context) as run:
        updated = store.outbox_cancel(_require_export_id(params))
        return run.success(f"export {updated['export_id']} 已取消。", updated)


def cloud_outbox_claim(params: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:
    store: CoreStore = context["store"]
    with ManagedRun(store, "cloud_outbox_claim", params, context["session_id"], context) as run:
        claimed = store.outbox_claim(_require_export_id(params))
        return run.success(f"export {claimed['export_id']} 已进入发送（带 payload）。", claimed)


def cloud_outbox_complete(params: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:
    store: CoreStore = context["store"]
    with ManagedRun(store, "cloud_outbox_complete", params, context["session_id"], context) as run:
        response = params.get("cloud_response") if isinstance(params.get("cloud_response"), dict) else {}
        updated = store.outbox_complete(_require_export_id(params), response)
        return run.success(f"export {updated['export_id']} 已送达 Cloud。", updated)


def cloud_outbox_fail(params: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:
    store: CoreStore = context["store"]
    with ManagedRun(store, "cloud_outbox_fail", params, context["session_id"], context) as run:
        error = params.get("last_error") if isinstance(params.get("last_error"), str) else "send failed"
        updated = store.outbox_fail(_require_export_id(params), error)
        return run.success(f"export {updated['export_id']} 发送失败（可稍后重试）。", updated)


def cloud_outbox_mark_retracted(params: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:
    store: CoreStore = context["store"]
    with ManagedRun(store, "cloud_outbox_mark_retracted", params, context["session_id"], context) as run:
        response = params.get("cloud_response") if isinstance(params.get("cloud_response"), dict) else {}
        updated = store.outbox_mark_retracted(_require_export_id(params), response)
        return run.success(f"export {updated['export_id']} 已在 Cloud 撤回（本地 Report 保留不变）。", updated)


def _require_export_id(params: dict[str, Any]) -> str:
    export_id = params.get("export_id")
    if not isinstance(export_id, str) or not EXPORT_ID.match(export_id):
        raise ContractError("invalid_input", "export_id 格式不合法。", {"export_id": export_id})
    return export_id


_METRIC_NAME = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
_ARCH = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
_NUMBER = re.compile(r"^[0-9]+(\.[0-9]+)?$")


_COMPUTE_CAP = re.compile(r"^[0-9]+\.[0-9]+$")
_GPU_PRODUCT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$")
_OBJECTIVE_METRICS = {
    "requests_per_second",
    "output_tokens_per_second",
    "input_tokens_per_second",
    "tokens_per_second",
    "success_rate",
    "mean_e2e_latency_ms",
    "mean_ttft_ms",
    "mean_tpot_ms",
    "mean_itl_ms",
}


def _validate_export_payload(payload: dict[str, Any]) -> None:
    """Self-validate the export against the frozen experience-export-v2
    contract BEFORE it is queued. Anything Cloud would reject with 422
    refuses here with a clear remediation — the upload loop never ships a
    doomed payload."""
    def reject(message: str, **details: Any) -> "ContractError":
        return ContractError("invalid_input", message, details)

    if payload.get("schema_version") != EXPERIENCE_SCHEMA_VERSION:
        raise reject("导出 schema_version 不合法。")
    if not _HASH.match(str(payload.get("source_report_hash", ""))):
        raise reject("source_report_hash 不合法。")
    if payload.get("consent_confirmed") is not True or not payload.get("consent_at"):
        raise reject("consent 字段缺失。")
    if "evidence_level" in payload and payload.get("evidence_level") != "local_measured":
        raise reject("evidence_level 必须是 local_measured。", field="evidence_level")
    environment = payload.get("environment") or {}
    if not _ARCH.match(str(environment.get("gpu_arch", ""))):
        raise reject("environment.gpu_arch 不合法。", field="environment.gpu_arch")
    if not isinstance(environment.get("gpu_count"), int) or not (1 <= environment["gpu_count"] <= 256):
        raise reject("environment.gpu_count 超出范围。", field="environment.gpu_count")
    if environment.get("vram_bucket") not in VRAM_BUCKETS:
        raise reject("environment.vram_bucket 枚举不合法。", field="environment.vram_bucket")
    if not _NUMBER.match(str(environment.get("driver_major", ""))) or not _NUMBER.match(str(environment.get("cuda_major", ""))):
        raise reject("environment 驱动/CUDA 主版本不合法。")
    if "driver_version" in environment and (not isinstance(environment.get("driver_version"), str) or not environment["driver_version"] or len(environment["driver_version"]) > 64):
        raise reject("environment.driver_version 不合法。", field="environment.driver_version")
    if "cuda_version" in environment and (not isinstance(environment.get("cuda_version"), str) or not environment["cuda_version"] or len(environment["cuda_version"]) > 64):
        raise reject("environment.cuda_version 不合法。", field="environment.cuda_version")
    if "compute_capability" in environment and not _COMPUTE_CAP.match(str(environment.get("compute_capability", ""))):
        raise reject("environment.compute_capability 不合法。", field="environment.compute_capability")
    if "gpu_product" in environment and (not isinstance(environment["gpu_product"], str) or not _GPU_PRODUCT.match(environment["gpu_product"])):
        raise reject("environment.gpu_product 不合法。", field="environment.gpu_product")
    if "vram_gib" in environment and (not isinstance(environment["vram_gib"], int) or not (1 <= environment["vram_gib"] <= 2048)):
        raise reject("environment.vram_gib 不合法。", field="environment.vram_gib")
    model = payload.get("model") or {}
    if not _MODEL_ID.match(str(model.get("model_id", ""))):
        raise reject("model.model_id 不合法。", field="model.model_id")
    if not isinstance(model.get("revision"), str) or not model["revision"] or len(model["revision"]) > 200:
        raise reject("model.revision 不合法。", field="model.revision")
    if not isinstance(model.get("quantization"), str) or not model["quantization"] or len(model["quantization"]) > 64:
        raise reject("model.quantization 不合法。", field="model.quantization")
    runtime = payload.get("runtime") or {}
    if runtime.get("runtime_kind") not in ("vllm", "sglang") or not isinstance(runtime.get("runtime_major"), str) or not _RUNTIME_MAJOR.match(runtime["runtime_major"]):
        raise reject("runtime 不合法。", field="runtime")
    if "runtime_version" in runtime and (not isinstance(runtime.get("runtime_version"), str) or not runtime["runtime_version"] or len(runtime["runtime_version"]) > 64):
        raise reject("runtime.runtime_version 不合法。", field="runtime.runtime_version")
    if runtime.get("image_digest") is not None and not _HASH.match(str(runtime.get("image_digest"))):
        raise reject("runtime.image_digest 不合法。", field="runtime.image_digest")
    workload = payload.get("workload") or {}
    for field, low, high in (("input_tokens", 0, 1048576), ("output_tokens", 0, 1048576), ("concurrency", 1, 1024), ("request_count", 1, 1000000)):
        if field not in workload:
            continue
        value = workload.get(field)
        if not isinstance(value, int) or isinstance(value, bool) or not (low <= value <= high):
            raise reject(f"workload.{field} 不合法。", field=f"workload.{field}")
    if workload.get("input_bucket") not in TOKEN_BUCKETS or workload.get("output_bucket") not in TOKEN_BUCKETS or workload.get("load_bucket") not in LOAD_BUCKETS:
        raise reject("workload 分桶枚举不合法。", field="workload")
    if not _HASH.match(str(workload.get("workload_hash", ""))):
        raise reject("workload.workload_hash 不合法。", field="workload.workload_hash")
    config = payload.get("config") or {}
    if not _HASH.match(str(config.get("config_hash", ""))):
        raise reject("config.config_hash 不合法。", field="config.config_hash")
    for key, value in (config.get("fields") or {}).items():
        if key in FORBIDDEN_CLOUD_FIELD_NAMES or isinstance(value, bool) or not isinstance(value, CANONICAL_SCALARS):
            raise reject("config.fields 含禁止字段或非标量值。", field=f"config.fields.{key}")
    if payload.get("outcome") not in CLOUD_EXPERIENCE_OUTCOMES:
        raise reject("outcome 枚举不合法。", field="outcome")
    metric_summaries = payload.get("metrics")
    if not isinstance(metric_summaries, list) or not (1 <= len(metric_summaries) <= 16):
        raise reject("metrics 数量必须在 1..16。", field="metrics")
    for item in metric_summaries:
        if not isinstance(item, dict) or not _METRIC_NAME.match(str(item.get("name", ""))):
            raise reject("metrics.name 不合法。", field="metrics")
        if len(str(item.get("unit", ""))) > 32 or not isinstance(item.get("repetitions"), int) or item["repetitions"] < 1:
            raise reject("metrics 字段越界。", field="metrics")
        if not isinstance(item.get("mean"), (int, float)) or isinstance(item["mean"], bool) or not math.isfinite(float(item["mean"])) or item["mean"] < 0:
            raise reject("metrics.mean 必须是非负有限数值。", field="metrics")
    for key in ("baseline", "candidate"):
        summary = payload.get(key)
        if summary is None:
            continue
        if not _MODEL_ID.match(str(summary.get("model_id", ""))):
            raise reject(f"{key}.model_id 不合法。", field=key)
        mean = summary.get("mean")
        if not isinstance(mean, (int, float)) or isinstance(mean, bool) or not math.isfinite(float(mean)) or mean < 0 or summary.get("repetitions", 0) < 1:
            raise reject(f"{key} 摘要越界。", field=key)
    delta = payload.get("delta")
    if delta is not None:
        if delta.get("target") not in ("higher_better", "lower_better"):
            raise reject("delta.target 枚举不合法。", field="delta")
        value_pct = delta.get("value_pct")
        if not isinstance(value_pct, (int, float)) or isinstance(value_pct, bool) or not math.isfinite(float(value_pct)):
            raise reject("delta.value_pct 必须是有限数值。", field="delta")
        if "objective_metric" in delta and delta.get("objective_metric") not in _OBJECTIVE_METRICS:
            raise reject("delta.objective_metric 枚举不合法。", field="delta")