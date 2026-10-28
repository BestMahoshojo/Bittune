import { createTlsFixture } from "./cloud/tls-fixture.ts";
/**
 * Runtime/Bridge vertical tests: recommendation and upload flows through
 * CloudBridge with a stub Core (protocol) and a local HTTPS Cloud stub.
 * cloud-tools confirmation gates are exercised directly on the tool
 * definitions.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createHttpsServer } from "node:https";
import { after, test } from "node:test";
import type { SettingsManager } from "../packages/bittune-runtime/src/core/settings-manager.ts";
import { CloudBridge } from "../packages/bittune-runtime/src/harness/cloud-bridge.ts";
import { CloudAuthError } from "../packages/bittune-runtime/src/harness/cloud-auth.ts";
import { createCloudTools } from "../packages/bittune-runtime/src/harness/cloud-tools.ts";
import { CoreError, type CoreClient } from "../packages/bittune-runtime/src/harness/core-client.ts";

const certsDir = createTlsFixture();

/** Minimal settings facade for the bridge; cloud semantics are global-only
 *  and every value the bridge reads has a functional counterpart here. */
function stubSettings(overrides: { profile?: string; mode?: string; baseUrl?: string } = {}): SettingsManager {
	return {
		getCloudProfile: () => overrides.profile ?? "official",
		getCloudBaseUrl: () => overrides.baseUrl,
		getCloudDevCaPath: () => join(certsDir, "ca.crt"),
		getCloudMode: () => (overrides.mode === "local_only" ? "local_only" : "cloud_preferred"),
		setCloudMode: () => {},
	} as unknown as SettingsManager;
}

const PROFILE = {
	name: "official",
	api_base_url: "https://127.0.0.1:1",
	oidc_issuer: "https://login.example.com/realms/bittune",
	oidc_client_id: "bittune-local",
	oidc_audience: "bittune-cloud-api",
	scopes: ["openid", "offline_access", "recommendations:read", "experiences:write"],
};

	interface StubCoreOptions {
		prepare?: unknown;
		claim?: unknown;
		recordFails?: boolean;
		outcomeFails?: boolean;
	}

	const PREPARE = {
		data: {
			envelope: { schema_version: "recommendation-v2", request_id: "req-1c3a4b5c6d7e8f9a0b1c2d3e4f5a6b" },
			request_hash: "sha256:" + "a".repeat(64),
			environment_hash: "sha256:" + "b".repeat(64),
			target_hash: "sha256:" + "c".repeat(64),
			constraints_hash: "sha256:" + "d".repeat(64),
		},
	};

	function stubCore(options: StubCoreOptions = {}): { client: CoreClient; calls: Array<{ tool: string; params: Record<string, unknown> }> } {
		const calls: Array<{ tool: string; params: Record<string, unknown> }> = [];
		const client = {
			async request(tool: string, params: Record<string, unknown>, _options?: unknown) {
				calls.push({ tool, params });
				switch (tool) {
					case "cloud_prepare_recommendation":
						return options.prepare ?? PREPARE;
					case "cloud_outbox_claim":
						return { data: { ...(options.claim ?? {}), payload: { outcome: "success" } } };
					case "record_cloud_recommendation":
						if (options.recordFails) throw Object.assign(new Error("poison body"), { code: "unsupported_contract" });
						return { data: { artifact_id: "artifact-" + "a".repeat(32) } };
					case "record_cloud_recommendation_outcome":
						if (options.outcomeFails) throw Object.assign(new Error("outcome write failed"), { code: "internal" });
						return { summary: "ok" };
					case "cloud_outbox_complete":
					case "cloud_outbox_fail":
					case "cloud_outbox_mark_retracted":
						return { summary: "ok" };
					case "cloud_outbox_list":
						return { data: { outbox: [{ status: "pending" }, { status: "failed" }] } };
					default:
						return { summary: "ok" };
				}
			},
		} as unknown as CoreClient;
		return { client, calls };
	}

	const RECOMMEND_INPUT = {
		intent: "fit_model",
		target: { model_id: "Qwen/Qwen2.5-7B-Instruct" },
		workload: { input_tokens: 512, output_tokens: 256, concurrency: 2 },
		constraints: { must_be_offline: true, max_memory_percent: 90 },
	};

interface CloudStub {
	baseUrl: string;
	requests: Array<{ path: string; hasToken: boolean; hasInstallationHeader: boolean; idempotencyKey?: string }>;
	nextStatus: number;
	close(): void;
	handler: (path: string) => { status?: number; body: unknown };
}

async function startCloudStub(handler?: CloudStub["handler"]): Promise<CloudStub> {
	const requests: CloudStub["requests"] = [];
	const stub = { requests, nextStatus: 200, handler: handler ?? (() => ({ body: { candidates: [] } })) } as unknown as CloudStub;
	const gateway = (path: string) => {
		const response = stub.handler(path) as { status?: number; body: unknown };
		return { status: response?.status ?? stub.nextStatus, body: response?.body ?? { candidates: [] } };
	};
	const server = createHttpsServer(
		{
			key: readFileSync(join(certsDir, "server.key")),
			cert: readFileSync(join(certsDir, "ca.crt")),
		},
		(req, res) => {
			requests.push({
				path: req.url ?? "/",
				hasToken: req.headers.authorization?.startsWith("Bearer ") ?? false,
				hasInstallationHeader: /^sha256:[a-f0-9]{64}$/.test(String(req.headers["x-bittune-installation-hash"] ?? "")),
				idempotencyKey: req.headers["idempotency-key"] as string | undefined,
			});
			const outcome = gateway(req.url ?? "/");
			res.writeHead(outcome.status, { "content-type": "application/json" });
			res.end(JSON.stringify(outcome.body));
		},
	);
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const address = server.address() as { port: number };
	stub.baseUrl = `https://127.0.0.1:${address.port}`;
	stub.close = () => void server.close();
	return stub;
}

/** Bridge over a fake token provider: tokens are stubbed in the profile. */
const scratchDirs: string[] = [];

after(() => {
	for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

function makeBridge(baseUrl: string, coreClient: CoreClient, settings = stubSettings({ baseUrl })): { bridge: CloudBridge; tokens: Record<string, unknown> } {
	const coreDir = mkdtempSync(join(tmpdir(), "bittune-bridge-"));
	scratchDirs.push(coreDir);
	const bridge = new CloudBridge({
		coreDir,
		clientVersion: "bittune-local/test",
		settings,
		coreClient: () => coreClient,
	});
	// A connected installation without an IdP round trip.
	const tokensFile = { access: "access-token", refresh: "refresh-token", expiresAtEpochMs: Date.now() + 600_000, scope: "openid recommendations:read experiences:write" };
	(bridge.auth as unknown as { storage: { save: (value: unknown) => void } }).storage.save(tokensFile);
	return { bridge, tokens: tokensFile };
}

test("local_only mode returns the explicit local result without any Cloud request", async () => {
	const cloud = await startCloudStub();
	const { client, calls } = stubCore();
	const settings = stubSettings({ mode: "local_only", baseUrl: cloud.baseUrl });
	const { bridge } = makeBridge(cloud.baseUrl, client, settings);
	const tools = createCloudTools({ bridge, client: () => client });
	const recommend = tools.find((tool) => tool.name === "cloud_recommend")!;
	const sessionManager = { getSessionId: () => "s-1" } as never;
		const result = await recommend.execute(
			"call-1",
			RECOMMEND_INPUT,
			undefined,
			undefined,
			{ sessionManager, hasUI: false, ui: {} } as never,
		);
		const text = String((result.content[0] as { text: string }).text);
		const details = result.details as { sent?: boolean; mode?: string; code?: string; candidate_count?: number };
		assert.match(text, /本地模式，未发起 Cloud 请求/);
		assert.doesNotMatch(text, /plan_deployment|转入本地方案/);
		assert.equal(details.sent, false);
		assert.equal(details.mode, "local_only");
		assert.equal(details.candidate_count, undefined);
		assert.notEqual(details.code, "fallback_local");
		assert.equal(cloud.requests.length, 0, "local_only must not touch the network");
		assert.equal(calls.length, 0, "local_only must not call the Core projection either");
	cloud.close();
});

test("cloud_preferred recommend chains prepare -> query -> record", async () => {
	const queryBody = { schema_version: "recommendation-v2", rules_version: "serving_search-v1", candidates: [] };
	const cloud = await startCloudStub(() => ({ body: queryBody }));
	const { client, calls } = stubCore();
	const settings = stubSettings({ profile: "official", baseUrl: cloud.baseUrl });
	const { bridge } = makeBridge(cloud.baseUrl, client, settings);
		const response = await bridge.recommend(RECOMMEND_INPUT, "s-1");
		assert.deepEqual(response, { response: queryBody, binding: "bound", environment: {}, artifact_id: "artifact-" + "a".repeat(32) });
		assert.deepEqual(calls.map((call) => call.tool), ["cloud_prepare_recommendation", "record_cloud_recommendation"]);
		const recorded = calls.find((call) => call.tool === "record_cloud_recommendation");
		assert.equal(recorded?.params.binding, "bound");
		assert.equal(recorded?.params.environment_source, "snapshot");
		assert.equal(recorded?.params.gpu_product_note, undefined);
	assert.equal(cloud.requests.length, 1);
	assert.equal(cloud.requests[0]?.path, "/v1/recommendations/query");
	assert.equal(cloud.requests[0]?.hasToken, true);
	assert.equal(cloud.requests[0]?.hasInstallationHeader, true);
	cloud.close();
});

test("recommend without credentials reports not_connected without a query", async () => {
	const cloud = await startCloudStub();
	const { client } = stubCore();
	const settings = stubSettings({ profile: "official", baseUrl: cloud.baseUrl });
	const bridgeCoreDir = mkdtempSync(join(tmpdir(), "bittune-bridge-"));
	scratchDirs.push(bridgeCoreDir);
	const bridge = new CloudBridge({ coreDir: bridgeCoreDir, clientVersion: "bittune-local/test", settings, coreClient: () => client });
	await assert.rejects(
			bridge.recommend(RECOMMEND_INPUT, "s-1"),
		/尚未连接|not_connected/,
	);
	assert.equal(cloud.requests.length, 0);
	cloud.close();
});

test("sendExport claims, PUTs with Idempotency-Key and completes", async () => {
	const receipt = { export_id: "exp-test", status: "received" };
	const cloud = await startCloudStub(() => ({ body: receipt }));
	const exportId = "exp-0123456789abcdef0123456789ab";
	const { client, calls } = stubCore({ claim: { export_id: exportId, status: "sending", payload: { outcome: "success" } } });
	const { bridge } = makeBridge(cloud.baseUrl, client, stubSettings({ profile: "official", baseUrl: cloud.baseUrl }));
	const result = await bridge.sendExport(exportId, "s-1");
	assert.deepEqual(result, receipt);
	assert.deepEqual(calls.map((call) => call.tool), ["cloud_outbox_claim", "cloud_outbox_complete"]);
	assert.equal(cloud.requests[0]?.path, `/v1/experience-exports/${exportId}`);
	assert.equal(cloud.requests[0]?.idempotencyKey, exportId);
	assert.equal(cloud.requests[0]?.hasInstallationHeader, true);
	cloud.close();
});

test("sendExport failures record outbox_fail and rethrow", async () => {
	const cloud = await startCloudStub(() => ({ status: 500, body: { error: { code: "internal_error", message: "boom" } } }));
	const exportId = "exp-0123456789abcdef0123456789ab";
	const { client, calls } = stubCore({ claim: { export_id: exportId, payload: { outcome: "success" } } });
	const { bridge } = makeBridge(cloud.baseUrl, client, stubSettings({ profile: "official", baseUrl: cloud.baseUrl }));
	await assert.rejects(bridge.sendExport(exportId, "s-1"), /boom|internal_error/);
	const failCalls = calls.filter((call) => call.tool === "cloud_outbox_fail");
	assert.equal(failCalls.length, 1);
	assert.match(String(failCalls[0]?.params.last_error ?? ""), /internal_error/);
	cloud.close();
});

test("retractExport posts retract then marks the local outbox", async () => {
	const cloud = await startCloudStub(() => ({ body: { status: "retracted" } }));
	const exportId = "exp-0123456789abcdef0123456789ab";
	const { client, calls } = stubCore();
	const { bridge } = makeBridge(cloud.baseUrl, client, stubSettings({ profile: "official", baseUrl: cloud.baseUrl }));
	await bridge.retractExport(exportId, "s-1");
	assert.equal(cloud.requests[0]?.path, `/v1/experience-exports/${exportId}/retract`);
	assert.ok(calls.some((call) => call.tool === "cloud_outbox_mark_retracted"));
	cloud.close();
});

test("pendingCount surfaces only pending queue items", async () => {
	const cloud = await startCloudStub();
	const { client } = stubCore();
	const { bridge } = makeBridge(cloud.baseUrl, client, stubSettings({ profile: "official", baseUrl: cloud.baseUrl }));
	assert.equal(await bridge.pendingCount("s-1"), 1);
	cloud.close();
});

test("cloud_experience enqueue gate: declined confirmation never enqueues", async () => {
	const cloud = await startCloudStub();
	const { client, calls } = stubCore();
	const { bridge } = makeBridge(cloud.baseUrl, client, stubSettings({ profile: "official", baseUrl: cloud.baseUrl }));
	const tools = createCloudTools({ bridge, client: () => client });
	const experience = tools.find((tool) => tool.name === "cloud_experience")!;
	const ctx = {
		sessionManager: { getSessionId: () => "s-1" },
		hasUI: true,
		ui: { confirm: async () => false },
	} as never;
	const result = await experience.execute("call-1", { action: "enqueue", report_id: "report-1" }, undefined, undefined, ctx);
	assert.match(String((result.content[0] as { text: string }).text), /未确认上传/);
	assert.equal(calls.some((call) => call.tool === "cloud_experience_enqueue"), false, "declined enqueue must not reach the Core");
	cloud.close();
});

test("cloud_experience enqueue gate: explicit confirmation enqueues once", async () => {
	const cloud = await startCloudStub();
	const { client, calls } = stubCore();
	// A Core stub that also answers the enqueue projection.
	const enqueueClient = {
		async request(tool: string, params: Record<string, unknown>, _options?: unknown) {
			if (tool === "cloud_experience_enqueue") {
				calls.push({ tool, params });
				return { data: { export_id: "exp-0123456789abcdef0123456789ab", status: "pending", content_hash: "sha256:" + "b".repeat(64) } };
			}
			return client.request(tool, params, { sessionId: "s-1" });
		},
	} as unknown as CoreClient;
	const { bridge } = makeBridge(cloud.baseUrl, enqueueClient, stubSettings({ profile: "official", baseUrl: cloud.baseUrl }));
	const tools = createCloudTools({ bridge, client: () => enqueueClient });
	const experience = tools.find((tool) => tool.name === "cloud_experience")!;
	const ctx = {
		sessionManager: { getSessionId: () => "s-1" },
		hasUI: true,
		ui: { confirm: async () => true },
	} as never;
	const result = await experience.execute("call-1", { action: "enqueue", report_id: "report-1" }, undefined, undefined, ctx);
	assert.match(String((result.content[0] as { text: string }).text), /已加入待发送队列/);
	assert.equal(calls.filter((call) => call.tool === "cloud_experience_enqueue").length, 1);
	cloud.close();
});
test("cloud_recommend maps Cloud failures to a structured fallback_local result", async () => {
	const cloud = await startCloudStub(() => ({ status: 500, body: { error: { code: "internal_error", message: "boom" } } }));
	const { client } = stubCore();
	const { bridge } = makeBridge(cloud.baseUrl, client, stubSettings({ baseUrl: cloud.baseUrl }));
	const tools = createCloudTools({ bridge, client: () => client });
	const recommend = tools.find((tool) => tool.name === "cloud_recommend")!;
	const ctx = { sessionManager: { getSessionId: () => "s-1" }, hasUI: false, ui: {} } as never;
		const result = await recommend.execute("call-1", RECOMMEND_INPUT, undefined, undefined, ctx);
	const details = result.details as { code?: string };
	assert.equal(details.code, "fallback_local");
	const text = String((result.content[0] as { text: string }).text);
	assert.match(text, /Cloud 请求失败/);
	assert.doesNotMatch(text, /plan_deployment|转入本地方案/);
	cloud.close();
});

	test("cloud_recommend empty candidates stay a catalog miss, not a local plan", async () => {
		const cloud = await startCloudStub(() => ({ body: { schema_version: "recommendation-v2", rules_version: "serving_search-v1", candidates: [], notes: ["nothing active"] } }));
		const { client } = stubCore();
		const { bridge } = makeBridge(cloud.baseUrl, client, stubSettings({ baseUrl: cloud.baseUrl }));
		const tools = createCloudTools({ bridge, client: () => client });
		const recommend = tools.find((tool) => tool.name === "cloud_recommend")!;
		const ctx = { sessionManager: { getSessionId: () => "s-1" }, hasUI: false, ui: {} } as never;
		const result = await recommend.execute("call-1", RECOMMEND_INPUT, undefined, undefined, ctx);
		const text = String((result.content[0] as { text: string }).text);
		const details = result.details as { ok?: boolean; binding?: string; candidate_count?: number; environment?: unknown; coverage?: unknown; artifact_id?: string; code?: string; sent?: boolean };
		assert.match(text, /空候选/);
		assert.match(text, /没有候选/);
		assert.match(text, /推荐记录 artifact-a{32}/);
		assert.doesNotMatch(text, /fallback_local|plan_deployment|转入本地方案/);
		assert.equal(details.ok, true);
		assert.equal(details.binding, "bound");
		assert.equal(details.candidate_count, 0);
		assert.deepEqual(details.environment, {});
		assert.equal(details.coverage, "没有模拟");
		assert.equal(details.artifact_id, "artifact-" + "a".repeat(32));
		assert.equal(details.code, undefined);
		assert.equal(details.sent, undefined);
		cloud.close();
	});

	test("cloud_recommend candidate list names the recorded artifact", async () => {
		const cloud = await startCloudStub(() => ({
			body: {
				schema_version: "recommendation-v2",
				rules_version: "serving_search-v1",
				candidates: [{ candidate_id: "cand-1", model_ref: { model_id: "Qwen/Qwen3-32B", revision: "rev-1" }, runtime_spec: { runtime_kind: "vllm" }, source: { kind: "coverage" } }],
			},
		}));
		const { client } = stubCore();
		const { bridge } = makeBridge(cloud.baseUrl, client, stubSettings({ baseUrl: cloud.baseUrl }));
		const tools = createCloudTools({ bridge, client: () => client });
		const recommend = tools.find((tool) => tool.name === "cloud_recommend")!;
		const ctx = { sessionManager: { getSessionId: () => "s-1" }, hasUI: false, ui: {} } as never;
		const result = await recommend.execute("call-1", RECOMMEND_INPUT, undefined, undefined, ctx);
		const text = String((result.content[0] as { text: string }).text);
		const details = result.details as { artifact_id?: string };
		assert.match(text, /1 个候选/);
		assert.match(text, /推荐记录 artifact-a{32}/);
		assert.equal(details.artifact_id, "artifact-" + "a".repeat(32));
		cloud.close();
	});

	test("cloud_recommend empty declared candidates echo the sent environment", async () => {
		const environment = { gpu_arch: "Hopper", gpu_count: 1, vram_bucket: "gte80GiB", driver_major: "550", cuda_major: "12", vram_gib: 80 };
		const cloud = await startCloudStub(() => ({ body: { schema_version: "recommendation-v2", rules_version: "serving_search-v1", candidates: [], coverage: "simulated" } }));
		const { client } = stubCore({
			prepare: {
				data: {
					...PREPARE.data,
					envelope: { ...PREPARE.data.envelope, payload: { environment } },
					binding: "declared",
					environment_source: "declared",
					assumptions: ["driver_major", "cuda_major"],
				},
			},
		});
		const { bridge } = makeBridge(cloud.baseUrl, client, stubSettings({ baseUrl: cloud.baseUrl }));
		const tools = createCloudTools({ bridge, client: () => client });
		const recommend = tools.find((tool) => tool.name === "cloud_recommend")!;
		const ctx = { sessionManager: { getSessionId: () => "s-1" }, hasUI: false, ui: {} } as never;
		const result = await recommend.execute("call-1", RECOMMEND_INPUT, undefined, undefined, ctx);
		const text = String((result.content[0] as { text: string }).text);
		const details = result.details as { ok?: boolean; binding?: string; candidate_count?: number; environment?: unknown; coverage?: unknown; sent?: boolean };
		assert.match(text, /调用方假设/);
		assert.equal(details.ok, true);
		assert.equal(details.binding, "declared");
		assert.equal(details.candidate_count, 0);
		assert.deepEqual(details.environment, environment);
		assert.equal(details.coverage, "simulated");
		assert.equal(details.sent, undefined);
		cloud.close();
	});

test("retract surfaces a local write-back failure instead of swallowing it", async () => {
	const cloud = await startCloudStub(() => ({ body: { status: "retracted" } }));
	const exportId = "exp-0123456789abcdef0123456789ab";
	const base = stubCore();
	const failingClient = {
		async request(tool: string, params: Record<string, unknown>, _options?: unknown) {
			if (tool === "cloud_outbox_mark_retracted") throw new Error("core write failed");
			return base.client.request(tool, params, { sessionId: "s-1" });
		},
	} as unknown as CoreClient;
	const { bridge } = makeBridge(cloud.baseUrl, failingClient, stubSettings({ baseUrl: cloud.baseUrl }));
	await assert.rejects(bridge.retractExport(exportId, "s-1"), (error: unknown) => {
		assert.ok(error instanceof CloudAuthError);
		assert.equal((error as CloudAuthError).code, "retract_local_sync_pending");
		return true;
	});
		assert.equal(cloud.requests[0]?.path, `/v1/experience-exports/${exportId}/retract`);
		cloud.close();
	});

	test("HTTP recommend failure records an outcome then throws", async () => {
		const cloud = await startCloudStub(() => ({ status: 500, body: { error: { code: "internal_error", message: "boom" } } }));
		const { client, calls } = stubCore();
		const { bridge } = makeBridge(cloud.baseUrl, client, stubSettings({ baseUrl: cloud.baseUrl }));
		await assert.rejects(bridge.recommend(RECOMMEND_INPUT, "s-1"));
		assert.deepEqual(
			calls.map((call) => call.tool),
			["cloud_prepare_recommendation", "record_cloud_recommendation_outcome"],
		);
		assert.equal(calls[1]?.params.outcome, "http_error");
		assert.equal(calls[1]?.params.http_status, 500);
		cloud.close();
	});

	test("HTTP 200 poison body records unsupported_contract without a recommendation artifact", async () => {
		const cloud = await startCloudStub(() => ({ body: { schema_version: "recommendation-v9", candidates: [] } }));
		const { client, calls } = stubCore({ recordFails: true });
		const { bridge } = makeBridge(cloud.baseUrl, client, stubSettings({ baseUrl: cloud.baseUrl }));
		await assert.rejects(bridge.recommend(RECOMMEND_INPUT, "s-1"));
		assert.deepEqual(
			calls.map((call) => call.tool),
			["cloud_prepare_recommendation", "record_cloud_recommendation", "record_cloud_recommendation_outcome"],
		);
		assert.equal(calls[2]?.params.outcome, "unsupported_contract");
		cloud.close();
	});

	test("HTTP recommend failure retries outcome write then throws recommend_outcome_failed", async () => {
		const cloud = await startCloudStub(() => ({ status: 500, body: { error: { code: "internal_error", message: "boom" } } }));
		const { client, calls } = stubCore({ outcomeFails: true });
		const { bridge } = makeBridge(cloud.baseUrl, client, stubSettings({ baseUrl: cloud.baseUrl }));
		await assert.rejects(bridge.recommend(RECOMMEND_INPUT, "s-1"), (error: unknown) => {
			assert.ok(error instanceof CoreError);
			assert.equal(error.code, "recommend_outcome_failed");
			assert.match(error.message, /请再次执行 cloud_recommend/);
			assert.match(error.message, /不要用 plan_deployment\(create\) 绕过/);
			return true;
		});
		assert.equal(calls.filter((call) => call.tool === "record_cloud_recommendation_outcome").length, 2);
		cloud.close();
	});

	test("cloud_recommend outcome write failure is not fallback_local", async () => {
		const cloud = await startCloudStub(() => ({ status: 500, body: { error: { code: "internal_error", message: "boom" } } }));
		const { client } = stubCore({ outcomeFails: true });
		const { bridge } = makeBridge(cloud.baseUrl, client, stubSettings({ baseUrl: cloud.baseUrl }));
		const tools = createCloudTools({ bridge, client: () => client });
		const recommend = tools.find((tool) => tool.name === "cloud_recommend")!;
		const ctx = { sessionManager: { getSessionId: () => "s-1" }, hasUI: false, ui: {} } as never;
		const result = await recommend.execute("call-1", RECOMMEND_INPUT, undefined, undefined, ctx);
		const details = result.details as { code?: string; message?: string };
		assert.equal(details.code, "recommend_outcome_failed");
		assert.notEqual(details.code, "fallback_local");
		assert.match(String((result.content[0] as { text: string }).text), /请再次执行/);
		assert.match(String((result.content[0] as { text: string }).text), /查询 Cloud 经验/);
		assert.doesNotMatch(String((result.content[0] as { text: string }).text), /请用 提出部署方案\(create\)/);
		cloud.close();
	});
