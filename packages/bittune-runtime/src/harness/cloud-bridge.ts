/**
 * The single orchestration point between Runtime intentions, the Core and
 * the Cloud API. Nothing else reads SQLite (the Core owns it) and nothing
 * else builds Cloud HTTP calls (cloud-client owns them).
 *
 * Phase 3 surface: connect/status/disconnect/set_mode shared by the
 * `bittune cloud` CLI and the `cloud_device` tool; recommendation and
 * experience flows attach in phases 4-5.
 */
import type { SettingsManager } from "../core/settings-manager.ts";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { BUILTIN_PROFILES, CloudAuth, CloudAuthError, loadProfileFile, hashOf } from "./cloud-auth.ts";
import { CloudApiError, CloudClient } from "./cloud-client.ts";
import { CoreError, type CoreClient } from "./core-client.ts";
import type { CloudProfile, CloudConnectionInfo, DeviceCodeInfo, CloudApiPort } from "./cloud-auth.ts";

export interface CloudBridgeDeps {
	/** Python Core home (credentials live under <core>/cloud/). */
	coreDir: string;
	clientVersion: string;
	settings: SettingsManager;
	/** Session-scoped Core client; undefined while the Core is down. */
	coreClient(): CoreClient | undefined;
}

/** A Cloud API port that reads the current settings profile on every call,
 *  so a later `cloud configure` takes effect without rebuilding the bridge. */
class SettingsCloudApi implements CloudApiPort {
	private cached?: { baseUrl: string; client: CloudClient };

	constructor(private readonly bridge: CloudBridge) {}

	private client(): CloudClient {
		const profile = this.bridge.currentProfile();
		const devCaPath = this.bridge.deps.settings.getCloudDevCaPath();
		const baseUrl = profile.api_base_url;
		if (this.cached && this.cached.baseUrl === baseUrl) return this.cached.client;
		const client = new CloudClient({
			baseUrl,
			devCaPath,
			clientVersion: this.bridge.deps.clientVersion,
		});
		this.cached = { baseUrl, client };
		return client;
	}

	async claim(body: { installation_id_hash: string; client_version: string }, token: string, signal?: AbortSignal) {
		return this.client().request<{
			device_id: string;
			status: "connected" | "disabled";
			account_subject_hash: string;
			bound_at: string;
		}>("/v1/device/claim", { method: "POST", body, token, signal });
	}

	async disconnectDevice(token: string, installationHash: string, signal?: AbortSignal) {
		await this.client().request<undefined>("/v1/device/disconnect", {
			method: "POST",
			token,
			headers: { "X-Bittune-Installation-Hash": installationHash },
			signal,
		});
	}

		async queryRecommendations(envelope: unknown, token: string, installationHash: string, signal?: AbortSignal) {
			return this.client().request<unknown>("/v1/recommendations/query", {
				method: "POST",
				body: envelope,
				token,
				headers: { "X-Bittune-Installation-Hash": installationHash },
				signal,
				timeoutMs: 30_000,
				maxRetries: 0,
			});
		}

	async putExperienceExport(exportID: string, payload: unknown, token: string, installationHash: string, signal?: AbortSignal) {
		return this.client().request<unknown>(`/v1/experience-exports/${exportID}`, {
			method: "PUT",
			body: payload,
			token,
			idempotencyKey: exportID,
			headers: { "X-Bittune-Installation-Hash": installationHash },
			signal,
		});
	}

	async retractExperienceExport(exportID: string, token: string, installationHash: string, signal?: AbortSignal) {
		return this.client().request<unknown>(`/v1/experience-exports/${exportID}/retract`, {
			method: "POST",
			body: {},
			token,
			headers: { "X-Bittune-Installation-Hash": installationHash },
			signal,
		});
	}
}

export class CloudBridge {
	readonly deps: CloudBridgeDeps;
	readonly auth: CloudAuth;
	private readonly api: SettingsCloudApi;

	constructor(deps: CloudBridgeDeps) {
		this.deps = deps;
		this.api = new SettingsCloudApi(this);
		this.auth = new CloudAuth({
			coreDir: deps.coreDir,
			api: this.api,
			clientVersion: deps.clientVersion,
			profileResolver: () => this.currentProfile(),
		});
	}

	/** The profile backing the current settings: builtin "official", or the
	 *  operator-provided profile stored at configure time. */
	currentProfile(): CloudProfile {
		const settings = this.deps.settings;
		const name = settings.getCloudProfile() ?? "official";
		const devCaPath = settings.getCloudDevCaPath();
		const baseUrlOverride = settings.getCloudBaseUrl();
		const profile = (BUILTIN_PROFILES[name] ?? (name === "official" ? BUILTIN_PROFILES.official : loadProfileFile(profileStorePath(this.deps.coreDir))));
		return {
			...profile,
			// The configured Cloud base URL (operator/dev override) wins over
			// the shipped profile default; the CLI stores it at configure.
			...(baseUrlOverride ? { api_base_url: baseUrlOverride } : {}),
			...(devCaPath ? { dev_ca_path: devCaPath } : {}),
		};
	}

	connect(hooks: { onDeviceCode: (info: DeviceCodeInfo) => void; signal?: AbortSignal }): Promise<CloudConnectionInfo> {
		return this.auth.connect(this.currentProfile(), hooks);
	}

	status(): Promise<CloudConnectionInfo> {
		return this.auth.connection();
	}

	disconnect(signal?: AbortSignal): Promise<void> {
		return this.auth.disconnect(signal);
	}

	getMode(): "cloud_preferred" | "local_only" {
		return this.deps.settings.getCloudMode();
	}

	setMode(mode: "cloud_preferred" | "local_only"): void {
		this.deps.settings.setCloudMode(mode);
	}

	/**
	 * cloud_recommend flow: Core builds the frozen environment/target
	 * projection, Cloud ranks candidates, Core records the redacted
	 * response. Cloud data stays prior knowledge — Local always re-checks.
	 */
		async recommend(input: Record<string, unknown>, sessionId: string, signal?: AbortSignal): Promise<unknown> {
			const client = this.deps.coreClient();
			if (!client) throw new CloudAuthError("core_unavailable", "Bittune Core 未运行。");
			const token = await this.auth.getAccessToken(signal);
			if (!token) throw new CloudAuthError("not_connected", "尚未连接 Cloud 账号；先执行 cloud_device(connect) 或改为 local_only。");
			const prepared = await client.request<{
				data?: {
					envelope: { request_id?: string; payload?: { environment?: Record<string, unknown> } } & Record<string, unknown>;
					request_hash: string;
					environment_hash: string;
					target_hash: string;
					constraints_hash: string;
					binding?: string;
					environment_source?: string;
					environment?: Record<string, unknown>;
					assumptions?: string[];
					gpu_product_note?: string;
				};
			}>("cloud_prepare_recommendation", input, { sessionId, ...(signal ? { signal } : {}) });
			const projection = prepared.data;
			if (!projection?.envelope || !projection.request_hash) throw new CloudAuthError("core_unavailable", "Core 未返回推荐投影。");
			const hashes = {
				request_hash: projection.request_hash,
				expected_request_id: projection.envelope.request_id,
				environment_hash: projection.environment_hash,
				target_hash: projection.target_hash,
				constraints_hash: projection.constraints_hash,
				};
			const binding = projection.binding === "declared" ? "declared" : "bound";
			const environmentSource = projection.environment_source === "declared" ? "declared" : "snapshot";
			const environment = projection.envelope.payload?.environment ?? projection.environment ?? {};
			const note = typeof projection.gpu_product_note === "string" && projection.gpu_product_note ? projection.gpu_product_note : undefined;
			const installation = this.auth.ensureInstallation();
			let response: unknown;
			try {
				response = await this.api.queryRecommendations(projection.envelope, token, installation.installationHash, signal);
			} catch (error) {
				this.reflectCloudFailure(error);
				await this.recordRecommendationOutcome(client, sessionId, hashes, classifyRecommendFailure(error));
				throw error;
			}
			let artifactId: string | undefined;
			try {
				const recorded = await client.request<{ data?: { artifact_id?: unknown } }>(
					"record_cloud_recommendation",
					{ response, ...hashes, binding, environment_source: environmentSource, ...(note ? { gpu_product_note: note } : {}) },
					{ sessionId },
				);
				artifactId = typeof recorded.data?.artifact_id === "string" ? recorded.data.artifact_id : undefined;
			} catch (error) {
				await this.recordRecommendationOutcome(client, sessionId, hashes, {
					outcome: "unsupported_contract",
					error_code: error instanceof Error && "code" in error ? String((error as { code?: unknown }).code ?? "unsupported_contract") : "unsupported_contract",
					error_message: errorMessage(error),
				});
				throw error;
			}
			return {
				response,
				binding,
				environment,
				...(artifactId ? { artifact_id: artifactId } : {}),
				...(Array.isArray(projection.assumptions) ? { assumptions: projection.assumptions } : {}),
				...(note ? { gpu_product_note: note } : {}),
			};
		}

		private async recordRecommendationOutcome(
			client: CoreClient,
			sessionId: string,
			hashes: {
				request_hash: string;
				expected_request_id?: string;
				environment_hash: string;
				target_hash: string;
				constraints_hash: string;
			},
			failure: { outcome: "http_error" | "auth_error" | "unsupported_contract" | "transport_error"; http_status?: number; error_code?: string; error_message?: string },
		): Promise<void> {
			const payload = {
				request_hash: hashes.request_hash,
				environment_hash: hashes.environment_hash,
				target_hash: hashes.target_hash,
				constraints_hash: hashes.constraints_hash,
				outcome: failure.outcome,
				...(hashes.expected_request_id ? { expected_request_id: hashes.expected_request_id } : {}),
				...(failure.http_status !== undefined ? { http_status: failure.http_status } : {}),
				...(failure.error_code ? { error_code: failure.error_code } : {}),
				...(failure.error_message ? { error_message: failure.error_message } : {}),
			};
			const write = () => client.request("record_cloud_recommendation_outcome", payload, { sessionId });
			try {
				await write();
			} catch {
				try {
					await write();
				} catch (error) {
					throw new CoreError(
						"recommend_outcome_failed",
						`Cloud 失败已发生，但未能写入本机推荐结果记录（${errorMessage(error)}）。请再次执行 cloud_recommend；不要用 plan_deployment(create) 绕过。`,
					);
				}
			}
		}

	/**
	 * cloud_experience send: claim -> PUT -> complete, or claim -> fail on
	 * any transport/API error so the item stays retryable later. Tokens are
	 * resolved before the claim so a missing credential never consumes an
	 * attempt.
	 */
	async sendExport(exportID: string, sessionId: string, signal?: AbortSignal): Promise<unknown> {
		const client = this.deps.coreClient();
		if (!client) throw new CloudAuthError("core_unavailable", "Bittune Core 未运行。");
		const token = await this.auth.getAccessToken(signal);
		if (!token) throw new CloudAuthError("not_connected", "凭证不可用；先 cloud_device(connect)，本条摘要保持待发送。");
		const installation = this.auth.ensureInstallation();
		const claimed = await client.request<{ data?: { payload?: unknown } }>(
			"cloud_outbox_claim",
			{ export_id: exportID },
			{ sessionId, ...(signal ? { signal } : {}) },
		);
		const payload = claimed.data?.payload;
		if (!payload) throw new CloudAuthError("core_unavailable", "Core 未返回待发送 payload。");
		try {
			const receipt = await this.api.putExperienceExport(exportID, payload, token, installation.installationHash, signal).catch((error: unknown) => {
				this.reflectCloudFailure(error);
				throw error;
			});
			await client.request("cloud_outbox_complete", { export_id: exportID, cloud_response: receipt }, { sessionId });
			return receipt;
		} catch (error) {
			const message = error instanceof CloudApiError ? `${error.code}: ${error.message}` : errorMessage(error);
			await client.request("cloud_outbox_fail", { export_id: exportID, last_error: message }, { sessionId }).catch(() => undefined);
			throw error;
		}
	}

	/** cloud_experience retract: Cloud first, then the local status. A local
	 *  write-back failure is never swallowed: the caller sees Cloud succeeded
	 *  and the local status needs a retry, which re-runs this same path (the
	 *  Core's mark_retracted is idempotent). */
	async retractExport(exportID: string, sessionId: string, signal?: AbortSignal): Promise<unknown> {
		const client = this.deps.coreClient();
		if (!client) throw new CloudAuthError("core_unavailable", "Bittune Core 未运行。");
		const token = await this.auth.getAccessToken(signal);
		if (!token) throw new CloudAuthError("not_connected", "凭证不可用；先 cloud_device(connect)。");
		const installation = this.auth.ensureInstallation();
		const receipt = await this.api.retractExperienceExport(exportID, token, installation.installationHash, signal).catch((error: unknown) => {
			this.reflectCloudFailure(error);
			throw error;
		});
		try {
			await client.request("cloud_outbox_mark_retracted", { export_id: exportID, cloud_response: receipt }, { sessionId });
		} catch (error) {
			throw new CloudAuthError(
				"retract_local_sync_pending",
				`Cloud 已撤回 ${exportID}，但本地 Outbox 状态回写失败（${errorMessage(error)}）：再次执行 retract 会补记本地状态。`,
			);
		}
		return receipt;
	}

	/** Cloud-side stops degrade the persisted connection state so the user
	 *  sees the real result instead of a permanently failing "connected". */
	private reflectCloudFailure(error: unknown): void {
		if (!(error instanceof CloudApiError)) return;
		switch (error.code) {
			case "device_disabled":
				void this.auth.markDeviceDisabled();
				break;
			case "unauthorized":
			case "token_expired":
				this.auth.markCredentialExpired();
				break;
		}
	}

	/** Pending uploads waiting for an explicit user decision to send. */
	async pendingCount(sessionId: string): Promise<number> {
		const client = this.deps.coreClient();
		if (!client) return 0;
		const listed = await client.request<{ data?: { outbox?: Array<{ status: string }> } }>(
			"cloud_outbox_list",
			{},
			{ sessionId },
		);
		return (listed.data?.outbox ?? []).filter((item) => item.status === "pending").length;
	}

	/** Configure selects a builtin profile or adopts an operator file,
	 *  persisting name + base URL + dev CA (global settings only) and a
	 *  validated copy of non-builtin profiles under the Core home. */
	configure(profile: CloudProfile): void {
		if (profile.name !== "official" && !BUILTIN_PROFILES[profile.name]) {
			storeProfileFile(this.deps.coreDir, profile);
		}
		this.deps.settings.setCloudProfile(profile.name);
		this.deps.settings.setCloudBaseUrl(profile.api_base_url);
		if (profile.dev_ca_path) this.deps.settings.setCloudDevCaPath(profile.dev_ca_path);
		else this.deps.settings.clearCloudDevCaPath();
	}
}

export function profileStorePath(coreDir: string): string {
	return `${coreDir}/cloud/profile.json`;
}

function storeProfileFile(coreDir: string, profile: CloudProfile): void {
	const path = profileStorePath(coreDir);
	mkdirSync(`${coreDir}/cloud`, { recursive: true, mode: 0o700 });
	writeFileSync(path, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
	chmodSync(path, 0o600);
}

export { CloudAuthError };

export function selectBuiltinProfile(name: string): CloudProfile | undefined {
	return BUILTIN_PROFILES[name];
}

export function resolveProfileFile(path: string): CloudProfile {
	return loadProfileFile(path);
}

	function errorMessage(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}

	function classifyRecommendFailure(error: unknown): {
		outcome: "http_error" | "auth_error" | "unsupported_contract" | "transport_error";
		http_status?: number;
		error_code?: string;
		error_message?: string;
	} {
		const message = errorMessage(error);
		if (error instanceof CloudApiError) {
			if (error.status === 401 || error.status === 403 || error.code === "unauthorized" || error.code === "token_expired" || error.code === "insufficient_scope") {
				return { outcome: "auth_error", http_status: error.status, error_code: error.code, error_message: message };
			}
			if (error.status === 0 || error.code === "network_error" || error.code === "tls_failure") {
				return { outcome: "transport_error", http_status: error.status, error_code: error.code, error_message: message };
			}
			return { outcome: "http_error", http_status: error.status, error_code: error.code, error_message: message };
		}
		return { outcome: "transport_error", error_message: message };
	}