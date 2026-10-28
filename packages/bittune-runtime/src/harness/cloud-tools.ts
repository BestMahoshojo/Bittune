import { Type, type Static } from "typebox";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext, ToolDefinition } from "../core/extensions/types.ts";
import { CloudAuthError } from "./cloud-auth.ts";
import { CloudApiError } from "./cloud-client.ts";
import { CloudBridge } from "./cloud-bridge.ts";
import { CoreError, type CoreClient } from "./core-client.ts";
import { COPY, humanizeUserText, toolLabel } from "./tui/copy.ts";

/**
 * The three Cloud agent tools of the frozen fifteen-tool surface. Schemas
 * pin the interaction exactly: no free HTTP, profile edits, SQLite access or
 * hand-built experience JSON can ever reach the Cloud. The Bridge is the
 * only path, the Core owns every projection and the Outbox.
 */

export const CLOUD_TOOL_NAMES = ["cloud_device", "cloud_recommend", "cloud_experience"] as const;

export type CloudToolName = (typeof CLOUD_TOOL_NAMES)[number];

/** Frozen cloud_device actions: identity and mode only, never profile edits. */
export const CLOUD_DEVICE_ACTIONS = ["connect", "status", "disconnect", "set_mode"] as const;

/** Frozen cloud_experience actions: preview/enqueue/list are read paths,
 *  cancel/send/retract mutate the outbox or the Cloud export. */
export const CLOUD_EXPERIENCE_ACTIONS = ["preview", "enqueue", "list", "cancel", "send", "retract"] as const;

export const MISSING_GPU_COMPARE_RANK_NOTE = "无 GPU 产品名时仍可上传，但不能进入选型对比和官方榜。";

export function experiencePreviewLines(data: {
	preview?: unknown;
	content_hash?: string;
	display?: Record<string, unknown>;
} | undefined): string[] {
	const display = data?.display;
	const defaults = (display?.defaults ?? {}) as Record<string, string>;
	const never = Array.isArray(display?.never_uploaded) ? (display.never_uploaded as string[]).join("、") : "";
	const compareRankNote =
		typeof display?.compare_rank_note === "string" ? display.compare_rank_note : MISSING_GPU_COMPARE_RANK_NOTE;
	return [
		"上传预览（Reports 事实的可追溯脱敏摘要）。",
		`- 可见范围：默认仅账号可见（${defaults.visibility_scope ?? "private"}）；作者显示默认匿名（${defaults.author_display ?? "anonymous"}），公开需另行授权审核。`,
		`- 不会上传：${never || "原始日志、Prompt、响应、权重、数据集、Secret、IP、主机名和完整路径"}。`,
		`- 对比和榜：${compareRankNote}`,
		`- 撤回：${typeof display?.retraction_note === "string" ? display.retraction_note : "发送后仍可在 Cloud 撤回；本地报告不受影响。"}`,
		"完整字段清单见展开的诊断详情。",
	];
}

export function isCloudTool(name: string): name is CloudToolName {
	return (CLOUD_TOOL_NAMES as readonly string[]).includes(name);
}

type AnyToolDefinition = ToolDefinition<any, any, any>;

function optionalString(description: string) {
	return Type.Optional(Type.String({ description }));
}

const Schemas = {
	cloud_device: Type.Object(
		{
			action: Type.Union(
				[Type.Literal("connect"), Type.Literal("status"), Type.Literal("disconnect"), Type.Literal("set_mode")],
				{ description: "connect：浏览器登录绑定当前安装；status：只读状态；disconnect：本地优先断开并切换账号；set_mode：修改全局 Cloud 模式" },
			),
			mode: Type.Optional(Type.Union([Type.Literal("cloud_preferred"), Type.Literal("local_only")], { description: "set_mode 的目标模式（全局持久化）" })),
		},
		{ additionalProperties: false },
	),
		cloud_recommend: Type.Object(
			{
				intent: Type.Union(
					[
						Type.Literal("fit_model"),
						Type.Literal("search_layout"),
						Type.Literal("score_layout"),
						Type.Literal("shortlist_models"),
						Type.Literal("compare_models"),
						Type.Literal("coverage"),
					],
					{ description: "serving_search 意图；缺省由 TypeBox 拒绝" },
				),
				target: Type.Optional(
					Type.Object(
						{
							model_id: Type.String({ minLength: 1, maxLength: 256, description: "目标模型 ID" }),
							revision: optionalString("固定 revision；省略由 Cloud 目录选择"),
							quantization: optionalString("量化方式；省略由 Cloud 目录选择"),
							runtime_kind: Type.Optional(Type.Union([Type.Literal("vllm"), Type.Literal("sglang")], { description: "Runtime 类型；省略由 Cloud 目录选择" })),
							runtime_major: Type.Optional(Type.String({ pattern: "^[0-9]{1,16}$", description: "固定 Runtime 主版本" })),
						},
						{ additionalProperties: false },
					),
				),
				models: Type.Optional(
					Type.Array(
						Type.Object(
							{
								model_id: Type.String({ minLength: 1, maxLength: 256 }),
								revision: optionalString("固定 revision"),
								quantization: optionalString("量化方式"),
							},
							{ additionalProperties: false },
						),
						{ description: "compare_models 至少两项；shortlist 可选收窄" },
					),
				),
				scenario: Type.Optional(Type.Union([Type.Literal("chat"), Type.Literal("rag"), Type.Literal("batch"), Type.Literal("coding")], { description: "场景；prepare 在缺 workload 时填默认原值" })),
				workload: Type.Optional(
					Type.Object(
						{
							input_tokens: Type.Integer({ minimum: 1, maximum: 1048576, description: "单请求输入 token 数" }),
							output_tokens: Type.Integer({ minimum: 1, maximum: 1048576, description: "单请求输出 token 数" }),
							concurrency: Type.Integer({ minimum: 1, maximum: 1024, description: "并发数" }),
						},
						{ additionalProperties: false },
					),
				),
				sla: Type.Optional(
					Type.Object(
						{
							ttft_ms: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: "首 token 时延上限（毫秒）" })),
							throughput_tokens_per_second: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: "输出吞吐下限" })),
						},
						{ additionalProperties: false },
					),
				),
				layout: Type.Optional(
					Type.Object(
						{
							runtime_kind: Type.Union([Type.Literal("vllm"), Type.Literal("sglang")]),
							serving_config: Type.Record(Type.String(), Type.Unknown(), { description: "标量 serving 配置；键必须 ⊆ 适配器白名单" }),
						},
						{ additionalProperties: false },
					),
				),
				constraints: Type.Object(
					{
						must_be_offline: Type.Boolean({ description: "部署阶段是否必须离线（不隐式联网）" }),
						max_memory_percent: Type.Integer({ minimum: 1, maximum: 100, description: "GPU 显存占用上限（百分比）" }),
						runtime_kind: Type.Optional(Type.Union([Type.Literal("vllm"), Type.Literal("sglang")])),
						quantization: optionalString("钉死量化"),
						max_candidate_gpus: Type.Optional(Type.Integer({ minimum: 1, description: "候选 GPU 预算，不是 SLA" })),
					},
					{ additionalProperties: false },
				),
				environment: Type.Optional(
					Type.Object(
						{
							gpu_arch: Type.Union(
								[Type.Literal("Turing"), Type.Literal("Ampere"), Type.Literal("Ada"), Type.Literal("Hopper"), Type.Literal("Blackwell")],
								{ description: "点名架构。只接受 Turing、Ampere、Ada、Hopper、Blackwell。" },
							),
							gpu_count: Type.Integer({ minimum: 1, maximum: 256, description: "GPU 数量" }),
							vram_bucket: Type.Union(
								[
									Type.Literal("lt8GiB"),
									Type.Literal("8-16GiB"),
									Type.Literal("16-24GiB"),
									Type.Literal("24-48GiB"),
									Type.Literal("48-80GiB"),
									Type.Literal("gte80GiB"),
								],
								{ description: "显存桶" },
							),
							driver_major: Type.String({ pattern: "^[0-9]+(\\.[0-9]+)?$", maxLength: 16, description: "调用方假设的驱动主版本，例如 550。不是本机检测结果。" }),
							cuda_major: Type.String({ pattern: "^[0-9]+(\\.[0-9]+)?$", maxLength: 16, description: "调用方假设的 CUDA 主版本，例如 12。不是本机检测结果。" }),
							gpu_product: Type.Optional(Type.String({ minLength: 1, maxLength: 64, description: "nvidia-smi 全称查找键，例如 NVIDIA H100 80GB HBM3。家族名 H100 不是查找键，不知道就省略。" })),
							vram_gib: Type.Optional(Type.Integer({ minimum: 1, maximum: 2048, description: "显存 GiB 下限" })),
						},
						{ additionalProperties: false, description: "点名环境。出现时不再读取本机快照。" },
					),
				),
				mode_override: Type.Optional(Type.Union([Type.Literal("cloud_preferred"), Type.Literal("local_only")], { description: "仅本次任务的模式覆盖，不回写全局设置" })),
			},
			{ additionalProperties: false },
		),
	cloud_experience: Type.Object(
		{
			action: Type.Union(
				[
					Type.Literal("preview"),
					Type.Literal("enqueue"),
					Type.Literal("list"),
					Type.Literal("cancel"),
					Type.Literal("send"),
					Type.Literal("retract"),
				],
				{ description: "preview：预览上传内容；enqueue：确认后加入待发送；list：查看队列；cancel：发送前取消；send：现在发送；retract：撤回已送达的经验" },
			),
			report_id: optionalString("preview/enqueue 的 Report ID"),
			export_id: optionalString("cancel/send/retract 的 export ID"),
		},
		{ additionalProperties: false },
	),
} satisfies Record<CloudToolName, ReturnType<typeof Type.Object>>;

export const CLOUD_TOOL_DESCRIPTIONS: Record<CloudToolName, string> = {
	cloud_device: "BitTune Cloud 账号链接：connect（浏览器设备授权）、status、disconnect（本地优先、可换账号）、set_mode（cloud_preferred/local_only 全局持久化）。",
	cloud_recommend: "按 intent 请求 Cloud serving 先验（短名单或布局）；结果只是账号历史、目录或模拟先验，必须经本机重新校验、确认和压测后才算本机事实。短名单按架构和显存桶认为放得下，不是某张卡的保证。",
	cloud_experience: "经验摘要上传：preview 生成脱敏预览、enqueue 需用户明确确认后写入待发送队列、list/cancel/send 管理队列、retract 撤回已送达经验。无 Report 事实不得上传。",
};

export interface CloudToolDependencies {
	bridge: CloudBridge;
	/** Session-scoped Core client; undefined while the Core is down. */
	client(): CoreClient | undefined;
	}

		function errorResult(error: Error): AgentToolResult<unknown> {
			const code = (error as { code?: string }).code;
			const message =
				code === "core_busy"
					? COPY.errors.coreBusy
					: code === "core_unavailable"
						? COPY.errors.coreUnavailable
						: humanizeUserText(error.message);
			return { content: [{ type: "text", text: message }], details: { code: code ?? "cloud_error", message: error.message } };
		}

	function coreRequest(client: CoreClient | undefined, tool: string, params: Record<string, unknown>, sessionId: string, signal?: AbortSignal) {
		if (!client) throw new CloudAuthError("core_unavailable", COPY.errors.coreUnavailable);
		return client.request(tool, params, { sessionId, ...(signal ? { signal } : {}) });
	}

function makeExecute(toolName: CloudToolName, deps: CloudToolDependencies) {
	return async (
		_toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: ((update: { content: { type: "text"; text: string }[]; details: unknown }) => void) | undefined,
		ctx: ExtensionContext,
	): Promise<AgentToolResult<unknown>> => {
		try {
			const sessionId = ctx.sessionManager.getSessionId() ?? "external";

			if (toolName === "cloud_device") {
				const action = String(params.action ?? "");
				if (action === "set_mode") {
					const mode = params.mode;
					if (mode !== "cloud_preferred" && mode !== "local_only") {
						throw new CloudAuthError("invalid_input", "set_mode 需要 mode=cloud_preferred 或 local_only。");
					}
					deps.bridge.setMode(mode);
					return { content: [{ type: "text", text: `Cloud 模式已设置为 ${mode}（全局设置；cloud_recommend 的 mode_override 只影响当前任务）。` }], details: { mode } };
				}
				if (action === "status") {
					const info = await deps.bridge.status();
					// accountSubjectHash is correlation-only and never shown to
					// the Agent; the installation id is likewise plumbing.
					const visible = {
						state: info.state,
						deviceId: info.deviceId,
						connectedAt: info.connectedAt,
						credentialBackend: info.credentialBackend,
						mode: deps.bridge.getMode(),
					};
					const stateText = {
						connected: "已连接",
						device_pending: "等待设备绑定（需连接完成 claim）",
						credential_expired: "凭证已过期（可重新连接）",
						disabled: "设备已被管理员停用",
						disconnected: "未连接",
					}[visible.state] ?? String(visible.state);
					return {
						content: [{ type: "text", text: `Cloud 状态：${stateText}；模式 ${visible.mode === "local_only" ? "仅本地" : "Cloud 优先（失败自动回退本地）"}${visible.deviceId ? `；设备 ID ${visible.deviceId}（内部标识）` : ""}。` }],
						details: visible,
					};
				}
				if (action === "disconnect") {
					await deps.bridge.disconnect(signal);
					return { content: [{ type: "text", text: "已断开：本地凭据与绑定先被清除、installation id 已轮换，Cloud 尽力通知；可以直接连接新账号。" }], details: {} };
				}
				if (action === "connect") {
					let countdownInterval: ReturnType<typeof setInterval> | undefined;
					try {
						const info = await deps.bridge.connect({
							signal,
							onDeviceCode: (code) => {
								const started = Date.now();
								onUpdate?.({ content: [{ type: "text", text: `请在浏览器打开 ${code.verificationUri} 并输入代码 ${code.userCode}（${code.expiresInSec}s 内有效，最长等待 ${Math.min(code.expiresInSec, 600)}s）` }], details: { deviceCode: code } });
								countdownInterval = setInterval(() => {
									const remaining = Math.max(0, code.expiresInSec - Math.floor((Date.now() - started) / 1000));
									onUpdate?.({ content: [{ type: "text", text: `等待浏览器授权中…剩余约 ${remaining}s` }], details: {} });
								}, 5_000);
								countdownInterval.unref?.();
							},
						});
						return {
							content: [{ type: "text", text: `Cloud 已连接：state=${info.state} device=${info.deviceId ?? "(none)"} backend=${info.credentialBackend}` }],
							details: { info },
						};
					} finally {
						// Failures must not leak a phantom countdown into the
						// session display.
						if (countdownInterval) clearInterval(countdownInterval);
					}
				}
				throw new CloudAuthError("invalid_input", `未知 cloud_device 动作 ${action}。`);
			}

			if (toolName === "cloud_recommend") {
				const mode = deps.bridge.getMode();
				const override = params.mode_override;
				if (override === "local_only" || mode === "local_only") {
					return {
						content: [{ type: "text", text: "本地模式，未发起 Cloud 请求（local_only 不调用 Cloud Bridge、不生成推荐查询）。" }],
						details: { ok: true, sent: false, mode: "local_only" },
					};
				}
				// Cloud troubles never break the local loop: every expected
				// failure maps to a structured fallback_local result instead
				// of a bare error. Invalid user input still errors normally.
				try {
					const { mode_override: _modeOverride, ...prepareParams } = params;
					const prepared = (await deps.bridge.recommend(prepareParams, sessionId, signal)) as {
						response?: { candidates?: unknown; coverage?: unknown; empty_reason?: string };
						binding?: string;
						environment?: Record<string, unknown>;
						assumptions?: string[];
						artifact_id?: string;
					};
					const response = prepared.response;
					const candidates = response?.candidates;
					if (!Array.isArray(candidates) || candidates.length === 0) {
						const reason = response?.empty_reason ?? "空候选";
						const binding = prepared.binding === "declared" ? "declared" : "bound";
						const environment = prepared.environment ?? {};
						const coverage = response && Object.prototype.hasOwnProperty.call(response, "coverage") ? response.coverage : "没有模拟";
						const assumptionText = Array.isArray(prepared.assumptions) && prepared.assumptions.length > 0 ? " driver_major 与 cuda_major 是调用方假设，不是检测结果。" : "";
						const artifactText = prepared.artifact_id ? ` 推荐记录 ${prepared.artifact_id}。` : "";
						return {
							content: [{ type: "text", text: `Cloud 返回空候选（${reason}）。已按送出的环境查询目录，没有候选。${assumptionText}${artifactText}` }],
							details: { ok: true, binding, candidate_count: 0, environment, coverage, ...(prepared.artifact_id ? { artifact_id: prepared.artifact_id } : {}) },
						};
					}
					const lines = candidates.slice(0, 5).map((candidate) => {
						const item = candidate as Record<string, unknown>;
						const model = (item.model_ref ?? {}) as Record<string, unknown>;
						const runtime = (item.runtime_spec ?? {}) as Record<string, unknown>;
						const source = (item.source ?? {}) as Record<string, unknown>;
						return `- ${String(model.model_id ?? item.candidate_id ?? "候选")}（${String(model.revision ?? "")} / ${String(runtime.runtime_kind ?? "")}）：${candidateByline(source.kind)}`;
					});
					const artifactText = prepared.artifact_id ? `\n推荐记录 ${prepared.artifact_id}。` : "";
					return {
						content: [{ type: "text", text: `Cloud 推荐返回 ${candidates.length} 个候选（历史先验，不保证本机结果；必须本机重新校验、确认、部署并实测）：\n${lines.join("\n")}${artifactText}` }],
						details: { response, ...(prepared.artifact_id ? { artifact_id: prepared.artifact_id } : {}) },
					};
				} catch (error) {
					if (isFallbackWorthy(error)) {
						const reason = messageOf(error);
						const advice = cloudFailureAdvice(error) ?? `Cloud 请求失败（${reason}）。`;
						return fallbackLocalResult(advice, { error: reason });
					}
					throw error;
				}
			}

			// cloud_experience
			const action = String(params.action ?? "");
			if (action === "list") {
				const listed = await coreRequest(deps.client(), "cloud_outbox_list", {}, sessionId, signal);
				const items = (listed as { data?: { outbox?: unknown } }).data?.outbox;
				if (Array.isArray(items)) {
					const counts = new Map<string, number>();
					for (const item of items) {
						const status = String((item as Record<string, unknown>).status ?? "unknown");
						counts.set(status, (counts.get(status) ?? 0) + 1);
					}
					const summary = [...counts.entries()].map(([status, count]) => `${status} ${count} 条`).join("，");
					return {
						content: [{ type: "text", text: `待发送队列：${items.length === 0 ? "为空" : `共 ${items.length} 条（${summary}）`}。` }],
						details: listed,
					};
				}
				return { content: [{ type: "text", text: "待发送队列为空。" }], details: listed };
			}
				if (action === "preview") {
					const reportId = requireString(params.report_id, "report_id");
					const result = await coreRequest(deps.client(), "cloud_experience_preview", { report_id: reportId }, sessionId, signal);
					const data = (result as { data?: { preview?: unknown; content_hash?: string; display?: Record<string, unknown> } }).data;
					return {
						content: [{ type: "text", text: experiencePreviewLines(data).join("\n") }],
						details: data,
					};
				}
			if (action === "enqueue") {
				const reportId = requireString(params.report_id, "report_id");
				const confirmed = ctx.hasUI
					? await ctx.ui.confirm(
							"上传经验摘要",
							`将把 Report ${reportId} 的脱敏摘要上传到当前 Cloud 账号（仅账号可见，作为后续推荐的历史先验）。\n不会上传：原始日志、Prompt、响应、模型权重、数据集、Secret、IP、主机名、完整路径。\nno_gain/failure 会进入账号历史并影响后续风险提示。确认上传？`,
						)
					: false;
				if (!confirmed) {
					return { content: [{ type: "text", text: "未确认上传：没有写入待发送队列（Outbox）。" }], details: { code: "user_declined" } };
				}
				const result = await coreRequest(deps.client(), "cloud_experience_enqueue", { report_id: reportId }, sessionId, signal);
				const data = (result as { data?: { export_id?: string; status?: string; content_hash?: string } }).data;
				return {
						content: [{
							type: "text",
							text: "已加入待发送队列。请让用户明确选择现在发送，或保持待发送稍后发送（发送前可取消）。",
						}],
					details: data,
				};
			}
			if (action === "cancel") {
				const exportId = requireString(params.export_id, "export_id");
				const result = await coreRequest(deps.client(), "cloud_outbox_cancel", { export_id: exportId }, sessionId, signal);
				return { content: [{ type: "text", text: `已取消 ${exportId}（未发送任何内容到 Cloud）。` }], details: result };
			}
			if (action === "send") {
				const exportId = requireString(params.export_id, "export_id");
				const receipt = sanitizeReceipt(await deps.bridge.sendExport(exportId, sessionId, signal));
				return {
					content: [{ type: "text", text: `经验摘要已送达 Cloud：${JSON.stringify(receipt)}` }],
					details: { receipt },
				};
			}
			if (action === "retract") {
				const exportId = requireString(params.export_id, "export_id");
				const receipt = sanitizeReceipt(await deps.bridge.retractExport(exportId, sessionId, signal));
				return {
					content: [{ type: "text", text: `已在 Cloud 撤回收据：${JSON.stringify(receipt)}。本地 Report 与推荐记录保持不变。` }],
					details: { receipt },
				};
			}
			throw new CloudAuthError("invalid_input", `未知 cloud_experience 动作 ${action}。`);
		} catch (error) {
			return errorResult(error instanceof Error ? error : new Error(String(error)));
		}
	};
}

function requireString(value: unknown, name: string): string {
	if (typeof value !== "string" || !value) throw new CloudAuthError("invalid_input", `${name} 是必填的。`);
	return value;
}

/** Cloud failed. The text is the failure itself; it does not start a local plan. */
function fallbackLocalResult(text: string, details: Record<string, unknown>): AgentToolResult<unknown> {
	return {
		content: [{ type: "text", text }],
		details: { code: "fallback_local", ...details },
	};
}

export function candidateByline(kind: unknown): string {
	switch (kind) {
		case "account_success":
			return "你的历史成功经验";
		case "predicted_search":
		case "predicted_score":
			return "模拟预测（均值，须本机实测）";
		case "coverage":
			return "覆盖说明";
		default:
			return "官方目录";
	}
}

/** Expected Cloud failures warrant the structured fallback; Core input or
 *  availability errors surface as-is so the Agent fixes the invocation. */
function isFallbackWorthy(error: unknown): boolean {
	if (error instanceof CloudApiError) return true;
	if (error instanceof CloudAuthError) {
		// A dead Core cannot be routed around with plan_deployment; only
		// credential/connection problems warrant the local fallback.
		return error.code !== "core_unavailable";
	}
	if (error instanceof CoreError) {
		// Cloud contract mismatches (rules/schema versions) fall back;
		// invalid input and a missing Core do not.
		return error.code === "unsupported_contract";
	}
	return false;
}

function cloudFailureAdvice(error: unknown): string | undefined {
	if (error instanceof CloudApiError && error.code === "device_disabled") {
		return "该设备已被 Cloud 管理员停用：本机状态已同步为 disabled，所有 Cloud 请求会被拒绝。请告知用户联系管理员，或 cloud_device(disconnect) 后换账号重连；期间不影响本地闭环。";
	}
	if (error instanceof CloudApiError && (error.code === "unauthorized" || error.code === "token_expired")) {
		return "Cloud 凭证已失效：本机状态已同步为 credential_expired。请 cloud_device(disconnect) 后重新 cloud_device(connect)；期间可继续本地闭环。";
	}
	return undefined;
}

/** Only the frozen receipt fields may reach the Agent: raw HTTP response
 *  bodies stay out of the session context by contract. */
function sanitizeReceipt(value: unknown): Record<string, unknown> {
	const receipt = value as Record<string, unknown> | undefined;
	if (!receipt || typeof receipt !== "object") return {};
	const allowed = ["export_id", "status", "content_hash", "received_at", "retracted_at", "idempotent_replay"];
	const clean: Record<string, unknown> = {};
	for (const key of allowed) {
		if (key in receipt) clean[key] = receipt[key];
	}
	return clean;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function createCloudTools(deps: CloudToolDependencies): AnyToolDefinition[] {
		return CLOUD_TOOL_NAMES.map((toolName) => {
			const schema = Schemas[toolName];
			return {
				name: toolName,
				label: toolLabel(toolName),
				description: CLOUD_TOOL_DESCRIPTIONS[toolName],
				parameters: schema,
				execute: makeExecute(toolName, deps),
			};
		}) as AnyToolDefinition[];
}