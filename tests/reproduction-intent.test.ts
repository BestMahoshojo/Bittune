/**
 * Phase 3 stage 4 regression tests: reproduction-intent validation must
 * accept only the fixed goal schema, reject execution surfaces, expired and
 * unknown fields, and never execute anything. The CLI parser treats
 * `reproduce --file` like the other declared subcommands.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseBittuneCliArguments } from "../packages/bittune-runtime/src/cli/bittune-args.ts";
import { parseReproductionIntent, reproductionInitialMessage } from "../packages/bittune-runtime/src/harness/reproduction-intent.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = JSON.parse(
	readFileSync(join(repoRoot, "contracts", "cloud", "fixtures", "discovery", "reproduction-intent.json"), "utf8"),
) as Record<string, unknown>;

/** A valid intent with a future expiry window, derived from the frozen
 * three-end fixture so both stay in sync structurally. */
function validIntent(): Record<string, unknown> {
	const issued = new Date();
	const expires = new Date(issued.getTime() + 12 * 3_600_000);
	return {
		...structuredClone(fixture),
		issued_at: issued.toISOString(),
		expires_at: expires.toISOString(),
	};
}

test("reproduction: 冻结夹具构造的意图可以通过校验", () => {
	const result = parseReproductionIntent(validIntent());
	assert.equal(result.ok, true);
	if (result.ok) {
		assert.equal(result.intent.schema_version, "reproduction-intent-v1");
		assert.equal(result.intent.case_id, "case-2a3c4d5e6f708192a3b4c5d6e0");
		assert.match(result.intent.source_url, /^https:\/\//);
	}
});

test("reproduction: 未知字段、禁止字段和嵌套执行面被拒绝", () => {
	const cases: Array<[string, (value: Record<string, unknown>) => void]> = [
		["未知顶层字段", (value) => { (value as Record<string, unknown>).run_now = true; }],
		["顶层命令字段", (value) => { (value as Record<string, unknown>).command = "echo hi"; }],
		["嵌套路径字段", (value) => { ((value.model as Record<string, unknown>).path = "/models/x"); }],
		["嵌套凭证字段", (value) => { ((value.model as Record<string, unknown>).token = "secret"); }],
		["argv", (value) => { ((value.runtime as Record<string, unknown>).argv = ["--x"]); }],
	];
	for (const [label, mutate] of cases) {
		const value = validIntent();
		mutate(value);
		const result = parseReproductionIntent(value);
		assert.equal(result.ok, false, `expected rejection for: ${label}`);
	}
});

test("reproduction: 过期、时间乱序和非法 URL 被拒绝", () => {
	const expired = validIntent();
	expired.issued_at = new Date(Date.now() - 48 * 3_600_000).toISOString();
	expired.expires_at = new Date(Date.now() - 24 * 3_600_000).toISOString();
	assert.equal(parseReproductionIntent(expired).ok, false);

	const reversed = validIntent();
	const stamps = {
		issued: new Date(),
		expires: new Date(Date.now() + 12 * 3_600_000),
	};
	reversed.issued_at = stamps.expires.toISOString();
	reversed.expires_at = stamps.issued.toISOString();
	assert.equal(parseReproductionIntent(reversed).ok, false);

	const http = validIntent();
	http.source_url = "http://cloud.example.com/v1/discovery/cases/case-1";
	assert.equal(parseReproductionIntent(http).ok, false);

	const queried = validIntent();
	queried.source_url = `https://cloud.example.com/v1/discovery/cases/case-1?token=x`;
	assert.equal(parseReproductionIntent(queried).ok, false);
});

test("reproduction: 非对象、错误 schema 与非法枚举被拒绝", () => {
	assert.equal(parseReproductionIntent(null).ok, false);
	assert.equal(parseReproductionIntent([1, 2, 3]).ok, false);
	const wrongSchema = validIntent();
	wrongSchema.schema_version = "reproduction-intent-v2";
	assert.equal(parseReproductionIntent(wrongSchema).ok, false);
	const badRuntime = validIntent();
	(badRuntime.runtime as Record<string, unknown>).runtime_kind = "llama.cpp";
	assert.equal(parseReproductionIntent(badRuntime).ok, false);
	const badBucket = validIntent();
	(badBucket.workload as Record<string, unknown>).input_bucket = "huge";
	assert.equal(parseReproductionIntent(badBucket).ok, false);
	const badCase = validIntent();
	badCase.case_id = "exp-2a3c4d5e6f708192a3b4c5d6e";
	assert.equal(parseReproductionIntent(badCase).ok, false);
});

test("reproduction: 初始任务消息只携带目标摘要与约束", () => {
	const result = parseReproductionIntent(validIntent());
	assert.ok(result.ok);
	if (!result.ok) return;
	const message = reproductionInitialMessage(result.intent);
	assert.ok(message.includes(result.intent.case_id));
	assert.ok(message.includes(result.intent.source_url));
	assert.ok(message.includes("Qwen/Qwen3-8B"));
	assert.ok(!message.includes("command"));
	assert.ok(!message.includes("sudo"));
	assert.ok(message.includes("本机以重新检查"));
});

test("runtime cli: reproduce 是声明式子命令，未知参数仍报 usage error", () => {
	const invocation = parseBittuneCliArguments(["reproduce", "--file", "intent.json"]);
	assert.ok(invocation.kind === "reproduce");
	if (invocation.kind === "reproduce") assert.equal(invocation.file, "intent.json");

	assert.throws(() => parseBittuneCliArguments(["reproduce"]), /requires --file/);
	assert.throws(() => parseBittuneCliArguments(["reproduce", "--file"]), /requires a value/);
	assert.throws(() => parseBittuneCliArguments(["reproduce", "--run", "x"]), /Unknown option/);
	assert.throws(() => parseBittuneCliArguments(["reproduce", "--file", "a.json", "--file", "b.json"]), /only be specified once/);
});

test("reproduction: 非 RFC3339 时间、嵌套未知键与冻结名单字段被拒绝", () => {
	const nonRFC3339 = validIntent();
	nonRFC3339.issued_at = "2030-12-31"; // Date.parse 可解释，但契约只接受 RFC3339 UTC
	assert.equal(parseReproductionIntent(nonRFC3339).ok, false);

	const zoned = validIntent();
	zoned.expires_at = new Date(Date.now() + 3600_000).toISOString().replace("Z", "+08:00");
	assert.equal(parseReproductionIntent(zoned).ok, false);

	const nestedUnknown = validIntent();
	(nestedUnknown.model as Record<string, unknown>).notes = "extra key";
	assert.equal(parseReproductionIntent(nestedUnknown).ok, false);

	const workloadUnknown = validIntent();
	(workloadUnknown.workload as Record<string, unknown>).download = "x";
	assert.equal(parseReproductionIntent(workloadUnknown).ok, false);

	const constraintsUnknown = validIntent();
	(constraintsUnknown.constraints as Record<string, unknown>).offline = true;
	assert.equal(parseReproductionIntent(constraintsUnknown).ok, false);

	// 冻结三端名单并集里的字段（即使不在执行面）也必须被拒绝。
	const promptField = validIntent();
	(promptField.model as Record<string, unknown>).prompt = "hello";
	assert.equal(parseReproductionIntent(promptField).ok, false);

	const responseField = validIntent();
	(responseField.workload as Record<string, unknown>).response = "x";
	assert.equal(parseReproductionIntent(responseField).ok, false);

	const datasetField = validIntent();
	(datasetField.runtime as Record<string, unknown>).dataset = "ds";
	assert.equal(parseReproductionIntent(datasetField).ok, false);
});
