/**
 * plan_deployment(create) no longer checks this session's Cloud record.
 * A reproduction session forces prior_source. Chat text does not.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { CloudBridge } from "../packages/bittune-runtime/src/harness/cloud-bridge.ts";
import type { CoreClient } from "../packages/bittune-runtime/src/harness/core-client.ts";
import { createManagedTools } from "../packages/bittune-runtime/src/harness/managed-tools.ts";
import { COPY } from "../packages/bittune-runtime/src/harness/tui/copy.ts";

function stubClient(status: { status: string }): { client: CoreClient; calls: Array<{ tool: string; params: Record<string, unknown> }> } {
	const calls: Array<{ tool: string; params: Record<string, unknown> }> = [];
	const client = {
		async request(tool: string, params: Record<string, unknown>) {
			calls.push({ tool, params });
			if (tool === "cloud_session_recommend_status") return status;
			if (tool === "plan_deployment") {
				return { summary: "ok", data: { plan: { plan_id: "plan-1", status: "draft" } } };
			}
			return { summary: "ok" };
		},
	} as unknown as CoreClient;
	return { client, calls };
}

function stubBridge(overrides: { mode?: "cloud_preferred" | "local_only"; state?: string } = {}): CloudBridge {
	return {
		getMode: () => overrides.mode ?? "cloud_preferred",
		status: async () => ({ state: overrides.state ?? "connected" }),
	} as unknown as CloudBridge;
}

const ctx = {
	sessionManager: { getSessionId: () => "s-1" },
	hasUI: false,
	ui: {},
} as never;

async function createPlan(
	deps: { client: CoreClient; bridge?: CloudBridge },
	params: Record<string, unknown> = { action: "create", goal: "serve" },
	runtimeOptions: { reproductionSession?: boolean } = {},
) {
	const tools = createManagedTools({ client: () => deps.client, ...(deps.bridge ? { bridge: deps.bridge } : {}) }, runtimeOptions);
	const tool = tools.find((item) => item.name === "plan_deployment")!;
	return tool.execute("call-1", params, undefined, undefined, ctx);
}

test("create does not ask whether this session recommended", async () => {
	const { client, calls } = stubClient({ status: "none" });
	const result = await createPlan({ client, bridge: stubBridge() }, { action: "create", prior_source: "none", goal: "serve" });
	assert.equal((result.details as { data?: { plan?: { plan_id?: string } } }).data?.plan?.plan_id, "plan-1");
	assert.equal(calls.some((call) => call.tool === "cloud_session_recommend_status"), false);
	assert.equal(calls[0]?.params.prior_source, "none");
	assert.equal("reproduction_authorized" in calls[0]!.params, false);
});

test("reproduction session forces prior_source and ignores the model value", async () => {
	const { client, calls } = stubClient({ status: "none" });
	await createPlan(
		{ client, bridge: stubBridge() },
		{ action: "create", prior_source: "user_specified", goal: "serve" },
		{ reproductionSession: true },
	);
	assert.equal(calls[0]?.params.prior_source, "reproduction");
	assert.equal(calls[0]?.params.reproduction_authorized, true);
	assert.equal(calls.some((call) => call.tool === "cloud_session_recommend_status"), false);
});

test("ordinary session initialMessage containing 按那个案例试试 is not a reproduction flag", async () => {
	const { client, calls } = stubClient({ status: "none" });
	const tools = createManagedTools({ client: () => client, bridge: stubBridge() });
	const tool = tools.find((item) => item.name === "plan_deployment")!;
	const ordinary = {
		sessionManager: { getSessionId: () => "s-1" },
		hasUI: false,
		ui: {},
		initialMessage: "按那个案例试试",
	} as never;
	await tool.execute("call-1", { action: "create", prior_source: "user_specified", goal: "serve" }, undefined, undefined, ordinary);
	assert.equal(calls[0]?.params.prior_source, "user_specified");
	assert.equal("reproduction_authorized" in calls[0]!.params, false);
	assert.equal(calls.some((call) => call.tool === "cloud_session_recommend_status"), false);
});

async function runSuite(
	params: Record<string, unknown>,
	askApproval: (title: string, message: string) => Promise<boolean>,
) {
	const { client, calls } = stubClient({ status: "none" });
	const tools = createManagedTools({ client: () => client }, { askApproval });
	const tool = tools.find((item) => item.name === "benchmark_suite")!;
	const result = await tool.execute("call-suite", params, undefined, undefined, ctx);
	return { result, calls };
}

test("destructive suite asks before Core and sends authorization only after yes", async () => {
	const declined = await runSuite(
		{ intent: "performance_sweep", service_instance_id: "service-1", destructive: true },
		async () => false,
	);
	assert.equal((declined.result.details as { code?: string }).code, "user_declined");
	assert.equal(declined.calls.length, 0);

	const approved = await runSuite(
		{ intent: "performance_sweep", service_instance_id: "service-1", destructive: true },
		async (_title, message) => {
			assert.equal(message, COPY.confirmBody.destructive);
			return true;
		},
	);
	assert.equal(approved.calls.length, 1);
	assert.equal(approved.calls[0]?.tool, "benchmark_suite");
		assert.equal(approved.calls[0]?.params.destructive_authorized, true);
	});

	test("destructive loopback suite asks once and sends authorization only after yes", async () => {
		const url = "http://127.0.0.1:8000";
		let asks = 0;
		const declined = await runSuite(
			{ intent: "performance_sweep", endpoint: { url, model_id: "Qwen/Qwen3-32B" }, destructive: true },
			async (_title, message) => {
				asks += 1;
				assert.match(message, /127\.0\.0\.1:8000/);
				assert.match(message, /不能成为实测/);
				assert.match(message, /极限压测/);
				return false;
			},
		);
		assert.equal(asks, 1);
		assert.equal((declined.result.details as { code?: string }).code, "user_declined");
		assert.equal(declined.calls.length, 0);

		asks = 0;
		const approved = await runSuite(
			{ intent: "performance_sweep", endpoint: { url, model_id: "Qwen/Qwen3-32B" }, destructive: true },
			async () => {
				asks += 1;
				return true;
			},
		);
		assert.equal(asks, 1);
		assert.equal(approved.calls.length, 1);
		assert.equal(approved.calls[0]?.params.destructive_authorized, true);
		assert.equal((approved.calls[0]?.params.endpoint as { url: string }).url, url);
	});

test("default suite does not ask, and a forged authorization is sent as false", async () => {
	const quiet = await runSuite(
		{ intent: "performance_sweep", service_instance_id: "service-1" },
		async () => {
			throw new Error("default sweep must not ask");
		},
	);
	assert.equal(quiet.calls.length, 1);
	assert.equal(quiet.calls[0]?.params.destructive_authorized, false);

	const forged = await runSuite(
		{ intent: "performance_sweep", service_instance_id: "service-1", destructive_authorized: true },
		async () => {
			throw new Error("forged authorization must not ask");
		},
	);
		assert.equal(forged.calls[0]?.params.destructive_authorized, false);
	});

	test("loopback benchmark shows the url and does not call Core when declined", async () => {
		const url = "http://127.0.0.1:8000";
		const { client, calls } = stubClient({ status: "none" });
		const tools = createManagedTools({ client: () => client }, {
			askApproval: async (_title, message) => {
				assert.match(message, /127\.0\.0\.1:8000/);
				assert.match(message, /不能成为实测/);
				return false;
			},
		});
		const benchmark = tools.find((item) => item.name === "benchmark_service")!;
		const declined = await benchmark.execute("call-bench", {
			endpoint: { url, model_id: "Qwen/Qwen3-32B" },
			workload: { schema_version: 1 },
		}, undefined, undefined, ctx);
		assert.equal((declined.details as { code?: string }).code, "user_declined");
		assert.equal(calls.length, 0);

		const approved = await runSuite(
			{ intent: "performance_sweep", endpoint: { url, model_id: "Qwen/Qwen3-32B" } },
			async () => true,
		);
		assert.equal(approved.calls.length, 1);
		assert.equal((approved.calls[0]?.params.endpoint as { url: string }).url, url);
		assert.equal("approved" in approved.calls[0]!.params, false);
	});
