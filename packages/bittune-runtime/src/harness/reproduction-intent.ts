/**
 * Parse and validate the `reproduction-intent-v1` file downloaded from Cloud
 * ("bittune reproduce --file <path>"). The validator only reads the fixed
 * goal-and-constraints schema: it never executes commands, never touches the
 * network, and rejects anything an intent must not carry (commands, paths,
 * credentials, unknown fields, expired files). Validation happens before any
 * Runtime session is created; a valid intent only seeds a bounded initial
 * message and the normal local inspect -> plan -> confirm -> deploy ->
 * benchmark loop decides everything else.
 */

export interface ReproductionIntentModel {
	model_id: string;
	revision: string;
	quantization: string;
}

export interface ReproductionIntentRuntime {
	runtime_kind: "vllm" | "sglang";
	runtime_major: string;
}

export interface ReproductionIntentWorkload {
	input_bucket: string;
	output_bucket: string;
	load_bucket: string;
	workload_hash: string;
}

export interface ReproductionIntentConstraints {
	max_memory_percent: number;
	must_be_offline: boolean;
}

export interface ReproductionIntent {
	schema_version: "reproduction-intent-v1";
	case_id: string;
	issued_at: string;
	expires_at: string;
	model: ReproductionIntentModel;
	runtime: ReproductionIntentRuntime;
	workload: ReproductionIntentWorkload;
	constraints: ReproductionIntentConstraints;
	source_url: string;
}

/** Field names an intent must never carry, recursively. `url` is special:
 * only the top-level source_url (set by Cloud) is allowed. The list is the
 * union of the local list and the frozen three-end forbidden field names
 * (Go contracts.ForbiddenFieldNames / Core FORBIDDEN_CLOUD_FIELD_NAMES).
 */
const FORBIDDEN_FIELD_NAMES = new Set([
	"command", "cmd", "shell", "argv", "args", "path", "file_path",
	"secret", "token", "password", "api_key", "credential", "key",
	"hostname", "host", "ip", "ip_address", "port", "url", "uri",
	"image", "image_url", "mount", "volume", "env", "stream",
	"prompt", "response", "responses", "output", "dataset",
	"account_id", "account_subject", "user_id", "username", "email",
]);

const TOKEN_BUCKETS = new Set(["0-2048", "2049-8192", "8193-32768", "32769+"]);
const LOAD_BUCKETS = new Set(["1", "2-8", "9-32", "33+"]);
const MODEL_ID_PATTERN = /^[A-Za-z0-9._/-]{1,256}$/;
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const CASE_ID_PATTERN = /^case-[a-z0-9-]{26,64}$/;
// Strict RFC3339 UTC only: Date.parse alone would accept "9999-12-31" and
// similar non-contract forms, letting hand-crafted files bypass the expiry
// semantic the schema promises.
const RFC3339_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

// Nested objects are closed sets: an unknown key inside model/runtime/
// workload/constraints is rejected exactly like an unknown top-level field.
const MODEL_KEYS = new Set(["model_id", "revision", "quantization"]);
const RUNTIME_KEYS = new Set(["runtime_kind", "runtime_major"]);
const WORKLOAD_KEYS = new Set(["input_bucket", "output_bucket", "load_bucket", "workload_hash"]);
const CONSTRAINTS_KEYS = new Set(["max_memory_percent", "must_be_offline"]);

const MAX_INTENT_BYTES = 256 * 1024;

export type ReproductionIntentResult =
	| { ok: true; intent: ReproductionIntent }
	| { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scanForbiddenFields(value: unknown, location: string): string | undefined {
	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index += 1) {
			const hit = scanForbiddenFields(value[index], `${location}[${index}]`);
			if (hit) return hit;
		}
		return undefined;
	}
	if (!isRecord(value)) return undefined;
	for (const key of Object.keys(value)) {
		const lower = key.toLowerCase();
		if (FORBIDDEN_FIELD_NAMES.has(lower)) {
			// The Cloud-issued source_url is the single sanctioned URL.
			if (lower === "url" && location === "intent" && key === "source_url") {
				continue;
			}
			return `${location}.${key}`;
		}
		const hit = scanForbiddenFields(value[key], `${location}.${key}`);
		if (hit) return hit;
	}
	return undefined;
}

function parseRFC3339(value: string): number | undefined {
	if (!RFC3339_UTC_PATTERN.test(value)) return undefined;
	const stamp = Date.parse(value);
	return Number.isFinite(stamp) ? stamp : undefined;
}

/** Returns the first unknown key of a nested object, or undefined when the
 * object only uses keys from the fixed set. */
function unknownKey(value: unknown, allowed: ReadonlySet<string>): string | undefined {
	if (!isRecord(value)) return undefined;
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) return key;
	}
	return undefined;
}

/** Builds the bounded initial message a validated intent seeds; no tool
 * calls, commands or network activity derive from this text. */
export function reproductionInitialMessage(intent: ReproductionIntent): string {
	const constraints = intent.constraints;
	return [
		`复现任务（来自公开案例 ${intent.case_id}，来源 ${intent.source_url}）：`,
		`- 模型：${intent.model.model_id}（revision ${intent.model.revision}，量化 ${intent.model.quantization}）`,
		`- Runtime：${intent.runtime.runtime_kind} 主版本 ${intent.runtime.runtime_major}`,
		`- 负载：input ${intent.workload.input_bucket}，output ${intent.workload.output_bucket}，并发桶 ${intent.workload.load_bucket}（workload hash ${intent.workload.workload_hash}）`,
		`- 约束：显存占用上限 ${constraints.max_memory_percent}%，部署保持离线=${constraints.must_be_offline ? "是" : "否"}`,
		`- 意图签发于 ${intent.issued_at}，${intent.expires_at} 过期；下载后 Cloud 可能已撤回，本机以重新检查、确认和实测为准。`,
		"请先检查本机硬件与依赖，再按需记录部署计划、确认、部署并压测，最后对照公开指标说明复现结果；任何 Cloud 数据都只是目标而不是事实。",
	].join("\n");
}

/**
 * Validates an uncontrolled JSON value against the frozen intent schema.
 * Rejections are stable user-facing errors; nothing is executed along the way.
 */
export function parseReproductionIntent(input: unknown): ReproductionIntentResult {
	if (!isRecord(input)) return { ok: false, error: "复现意图不是 JSON 对象。" };
	if (input.schema_version !== "reproduction-intent-v1") {
		return { ok: false, error: "schema_version 必须为 reproduction-intent-v1。" };
	}
	const allowedKeys = new Set([
		"schema_version", "case_id", "issued_at", "expires_at",
		"model", "runtime", "workload", "constraints", "source_url",
	]);
	for (const key of Object.keys(input)) {
		if (!allowedKeys.has(key)) {
			return { ok: false, error: `未知字段 ${key}：意图只允许固定目标与约束字段。` };
		}
	}
	const hit = scanForbiddenFields(input, "intent");
	if (hit) {
		return { ok: false, error: `禁止字段 ${hit}：意图不得携带命令、路径、凭证或执行入口。` };
	}
	if (typeof input.case_id !== "string" || !CASE_ID_PATTERN.test(input.case_id)) {
		return { ok: false, error: "case_id 格式不合法。" };
	}

	const issuedAt = typeof input.issued_at === "string" ? parseRFC3339(input.issued_at) : undefined;
	const expiresAt = typeof input.expires_at === "string" ? parseRFC3339(input.expires_at) : undefined;
	if (issuedAt === undefined || expiresAt === undefined) {
		return { ok: false, error: "issued_at/expires_at 必须是 RFC3339 UTC 时间。" };
	}
	if (expiresAt <= issuedAt) {
		return { ok: false, error: "expires_at 必须晚于 issued_at。" };
	}
	if (expiresAt <= Date.now()) {
		return { ok: false, error: "意图已过期；请回到公开案例页重新下载。" };
	}

	const model = input.model;
	if (!isRecord(model)) {
		return { ok: false, error: "model 必须是对象。" };
	}
	const unknownModelKey = unknownKey(model, MODEL_KEYS);
	if (unknownModelKey) {
		return { ok: false, error: `未知字段 intent.model.${unknownModelKey}：嵌套对象只允许固定字段。` };
	}
	if (typeof model.model_id !== "string" || !MODEL_ID_PATTERN.test(model.model_id) ||
		typeof model.revision !== "string" || model.revision.length === 0 || model.revision.length > 200 ||
		typeof model.quantization !== "string" || model.quantization.length === 0 || model.quantization.length > 64) {
		return { ok: false, error: "model 必须携带固定 model_id/revision/quantization。" };
	}

	const runtime = input.runtime;
	if (!isRecord(runtime)) {
		return { ok: false, error: "runtime 必须是对象。" };
	}
	const unknownRuntimeKey = unknownKey(runtime, RUNTIME_KEYS);
	if (unknownRuntimeKey) {
		return { ok: false, error: `未知字段 intent.runtime.${unknownRuntimeKey}。` };
	}
	if ((runtime.runtime_kind !== "vllm" && runtime.runtime_kind !== "sglang") ||
		typeof runtime.runtime_major !== "string" || !/^[0-9]{1,16}$/.test(runtime.runtime_major)) {
		return { ok: false, error: "runtime 必须是 vllm/sglang + 主版本。" };
	}

	const workload = input.workload;
	if (!isRecord(workload)) {
		return { ok: false, error: "workload 必须是对象。" };
	}
	const unknownWorkloadKey = unknownKey(workload, WORKLOAD_KEYS);
	if (unknownWorkloadKey) {
		return { ok: false, error: `未知字段 intent.workload.${unknownWorkloadKey}。` };
	}
	if (typeof workload.input_bucket !== "string" || !TOKEN_BUCKETS.has(workload.input_bucket) ||
		typeof workload.output_bucket !== "string" || !TOKEN_BUCKETS.has(workload.output_bucket) ||
		typeof workload.load_bucket !== "string" || !LOAD_BUCKETS.has(workload.load_bucket) ||
		typeof workload.workload_hash !== "string" || !HASH_PATTERN.test(workload.workload_hash)) {
		return { ok: false, error: "workload 桶或 workload hash 不合法。" };
	}

	const constraints = input.constraints;
	if (!isRecord(constraints)) {
		return { ok: false, error: "constraints 必须是对象。" };
	}
	const unknownConstraintsKey = unknownKey(constraints, CONSTRAINTS_KEYS);
	if (unknownConstraintsKey) {
		return { ok: false, error: `未知字段 intent.constraints.${unknownConstraintsKey}。` };
	}
	if (typeof constraints.max_memory_percent !== "number" ||
		!Number.isInteger(constraints.max_memory_percent) ||
		constraints.max_memory_percent < 1 || constraints.max_memory_percent > 100 ||
		typeof constraints.must_be_offline !== "boolean") {
		return { ok: false, error: "constraints 必须在固定范围内。" };
	}

	const sourceUrl = input.source_url;
	if (typeof sourceUrl !== "string" || sourceUrl.length === 0 || sourceUrl.length > 2048) {
		return { ok: false, error: "source_url 缺失或超长。" };
	}
	let parsedUrl: URL;
	try {
		parsedUrl = new URL(sourceUrl);
	} catch {
		return { ok: false, error: "source_url 不是合法 URL。" };
	}
	if (parsedUrl.protocol !== "https:" || parsedUrl.search !== "" || parsedUrl.hash !== "") {
		return { ok: false, error: "source_url 必须是由 Cloud 生成的 https 规范案例地址。" };
	}

	return {
		ok: true,
		intent: {
			schema_version: "reproduction-intent-v1",
			case_id: input.case_id,
			issued_at: input.issued_at as string,
			expires_at: input.expires_at as string,
			model: { model_id: model.model_id, revision: model.revision, quantization: model.quantization },
			runtime: { runtime_kind: runtime.runtime_kind, runtime_major: runtime.runtime_major },
			workload: {
				input_bucket: workload.input_bucket,
				output_bucket: workload.output_bucket,
				load_bucket: workload.load_bucket,
				workload_hash: workload.workload_hash,
			},
			constraints: { max_memory_percent: constraints.max_memory_percent, must_be_offline: constraints.must_be_offline },
			source_url: sourceUrl,
		},
	};
}

export const MAX_REPRODUCTION_INTENT_BYTES = MAX_INTENT_BYTES;