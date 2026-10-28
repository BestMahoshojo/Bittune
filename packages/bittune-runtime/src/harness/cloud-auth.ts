/**
 * Local Cloud identity: RFC 8628 device authorization, token refresh,
 * connection state and disconnect. CLI `bittune cloud connect` and the
 * `cloud_device` agent tool share exactly this routine — there is no second
 * polling or state implementation.
 *
 * State never pretends: the five observable states are disconnected,
 * device_pending, connected, credential_expired and disabled. Tokens live in
 * the credential backend (OS keychain first once a backend exists, an 0600
 * file fallback here) and never in settings, sessions or reports.
 */
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fetch as undiciFetch } from "undici";

type FetchResponse = Awaited<ReturnType<typeof undiciFetch>>;

export interface CloudProfile {
	name: string;
	api_base_url: string;
	oidc_issuer: string;
	oidc_client_id: string;
	oidc_audience: string;
	scopes: string[];
	dev_ca_path?: string;
}

export type CloudDeviceState = "disconnected" | "device_pending" | "connected" | "credential_expired" | "disabled";

export interface CloudConnectionInfo {
	installationId: string;
	deviceId?: string;
	accountSubjectHash?: string;
	connectedAt?: string;
	disabledAt?: string;
	credentialBackend: string;
	state: CloudDeviceState;
}

export interface DeviceCodeInfo {
	verificationUri: string;
	verificationUriComplete?: string;
	userCode: string;
	expiresInSec: number;
	intervalSec: number;
}

/** The Cloud API surface cloud-auth needs; CloudClient implements it. */
export interface CloudApiPort {
	claim(
		body: { installation_id_hash: string; client_version: string },
		token: string,
		signal?: AbortSignal,
	): Promise<{ device_id: string; status: "connected" | "disabled"; account_subject_hash: string; bound_at: string }>;
	disconnectDevice(token: string, installationHash: string, signal?: AbortSignal): Promise<void>;
}

export class CloudAuthError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "CloudAuthError";
		this.code = code;
	}
}

interface TokenSet {
	access: string;
	refresh?: string;
	expiresAtEpochMs: number;
	scope: string;
}

interface ConnectionFile {
	installation_id: string;
	device_id?: string;
	account_subject_hash?: string;
	connected_at?: string;
	disabled_at?: string;
	credential_backend: string;
}

export interface CloudAuthDeps {
	/** The Python Core home; credentials live under <core>/cloud/. */
	coreDir: string;
	api: CloudApiPort;
	clientVersion: string;
	/** Resolves the profile backing the current credentials (refresh path). */
	profileResolver?: () => CloudProfile;
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	now?: () => number;
}

const POLL_TOTAL_CAP_SEC = 600;
const MIN_POLL_INTERVAL_SEC = 5;
const SLOW_DOWN_BUMP_SEC = 5;
const DISCONNECT_BEST_EFFORT_MS = 5_000;
const OIDC_REQUEST_TIMEOUT_MS = 15_000;

// Built-in release profiles. The official values ship with the package; the
// phase 6 runbook publishes the real endpoint, issuer and client id.
export const BUILTIN_PROFILES: Record<string, CloudProfile> = {
	official: {
		name: "official",
		api_base_url: "https://cloud.example.com",
		oidc_issuer: "https://login.example.com/realms/bittune",
		oidc_client_id: "bittune-local",
		oidc_audience: "bittune-cloud-api",
		scopes: ["openid", "offline_access", "recommendations:read", "experiences:write"],
	},
};

/** Cloud credentials: keychain-first abstraction with the 0600 file fallback
 *  implemented here. No OS keychain backend ships with Node today; the
 *  interface keeps the door open without changing any caller. */
export interface CloudCredentialStorage {
	readonly backend: string;
	load(): TokenSet | undefined;
	save(tokens: TokenSet): void;
	clear(): void;
}

export class CloudAuth {
	private readonly coreDir: string;
	private readonly api: CloudApiPort;
	private readonly clientVersion: string;
	private readonly profileResolver?: () => CloudProfile;
	private readonly sleepFn: (ms: number, signal?: AbortSignal) => Promise<void>;
	private readonly nowFn: () => number;
	private readonly storage: CloudCredentialStorage;

	constructor(deps: CloudAuthDeps) {
		this.coreDir = deps.coreDir;
		this.api = deps.api;
		this.clientVersion = deps.clientVersion;
		this.profileResolver = deps.profileResolver;
		this.sleepFn = deps.sleep ?? defaultSleep;
		this.nowFn = deps.now ?? Date.now;
		this.storage = new FileCloudCredentialStorage(join(this.coreDir, "cloud", "cloud-tokens.json"));
	}

	private get connectionPath(): string {
		return join(this.coreDir, "cloud", "cloud-connection.json");
	}

	/** The installation identity, created once per machine and rotated only
	 *  by an explicit disconnect. Returns the raw id and its wire hash. */
	ensureInstallation(): { installationId: string; installationHash: string } {
		const existing = this.readConnection();
		if (existing?.installation_id) {
			return {
				installationId: existing.installation_id,
				installationHash: hashOf(existing.installation_id),
			};
		}
		const installationId = randomUUID();
		this.writeConnection({ installation_id: installationId, credential_backend: this.storage.backend });
		return { installationId, installationHash: hashOf(installationId) };
	}

	/** Reads persisted state without touching the network or the IdP. */
	async connection(): Promise<CloudConnectionInfo> {
		const file = this.readConnection();
		const installation = this.ensureInstallation();
		const info: CloudConnectionInfo = {
			installationId: installation.installationId,
			credentialBackend: file?.credential_backend ?? this.storage.backend,
			state: "disconnected",
		};
		if (file?.device_id) {
			info.deviceId = file.device_id;
			info.accountSubjectHash = file.account_subject_hash;
			info.connectedAt = file.connected_at;
			info.disabledAt = file.disabled_at;
		}
		const tokens = this.storage.load();
		const expired = tokens !== undefined && tokens.expiresAtEpochMs <= this.nowFn();
		if (file?.disabled_at) {
			info.state = "disabled";
		} else if (file?.device_id && tokens) {
			// Expired access credentials with a refresh token stay usable
			// (the next request refreshes); without one the state honestly
			// reports credential_expired while keeping the local binding.
			info.state = expired && !tokens.refresh ? "credential_expired" : "connected";
		} else if (tokens && !file?.device_id) {
			info.state = expired && !tokens.refresh ? "credential_expired" : "device_pending";
		} else if (file?.device_id && !tokens) {
			info.state = "credential_expired";
			info.accountSubjectHash = undefined; // a hash of a previous account, not a live identity
		}
		return info;
	}

	/**
	 * Runs the full device authorization flow: discovery, device code,
	 * browser handoff (via onDeviceCode), polling capped at
	 * min(expires_in, 600s), claim, then credential + connection persistence.
	 * A failure restores the previous credentials and binding untouched.
	 */
	async connect(
		profile: CloudProfile,
		hooks: { onDeviceCode: (info: DeviceCodeInfo) => void; signal?: AbortSignal },
	): Promise<CloudConnectionInfo> {
		validateProfile(profile);
		const previousTokens = this.storage.load();
		const previousConnection = this.readConnection();

		let discovery: Awaited<ReturnType<CloudAuth["fetchDiscovery"]>>;
		try {
			discovery = await this.fetchDiscovery(profile);
		} catch (error) {
			if (hooks.signal?.aborted) throw new CloudAuthError("authorization_cancelled", "device authorization was cancelled");
			throw error;
		}
		let authResponse: FetchResponse;
		try {
			authResponse = await this.oidcPost(
			discovery.device_authorization_endpoint,
			new URLSearchParams({ client_id: profile.oidc_client_id, scope: profile.scopes.join(" ") }),
			hooks.signal,
		);
		} catch (error) {
			if (hooks.signal?.aborted) throw new CloudAuthError("authorization_cancelled", "device authorization was cancelled");
			throw error;
		}
		const authBody = await readOidcBody(authResponse);
		if (authBody.error) throw new CloudAuthError(`authorization_${authBody.error}`, `device authorization failed: ${authBody.error}`);
		if (!authBody.device_code || !authBody.verification_uri || !authBody.user_code) {
			throw new CloudAuthError("discovery_failed", "device authorization response is incomplete");
		}
		const intervalSec = Math.max(Number(authBody.interval) || MIN_POLL_INTERVAL_SEC, MIN_POLL_INTERVAL_SEC);
		// RFC 8628 wait budget: min(expires_in, 600s) drives polling AND the
		// UI countdown alike, so the poll never outlives the device code.
		const pollCapSec = Math.min(Number(authBody.expires_in) || POLL_TOTAL_CAP_SEC, POLL_TOTAL_CAP_SEC);

		hooks.onDeviceCode({
			verificationUri: authBody.verification_uri,
			verificationUriComplete: authBody.verification_uri_complete,
			userCode: authBody.user_code,
			expiresInSec: pollCapSec,
			intervalSec,
		});

		let tokens: TokenSet;
		try {
			tokens = await this.pollForTokens(discovery.token_endpoint, profile, authBody.device_code, intervalSec, pollCapSec, hooks.signal);
		} catch (error) {
			// Nothing was persisted yet; the previous connection stands.
			throw error;
		}
		this.storage.save(tokens);

		const installation = this.ensureInstallation();
		try {
			const claim = await this.api.claim(
				{ installation_id_hash: installation.installationHash, client_version: this.clientVersion },
				tokens.access,
				hooks.signal,
			);
			if (claim.status === "disabled") {
				this.storage.clear();
				this.writeConnection({
					installation_id: installation.installationId,
					device_id: claim.device_id,
					account_subject_hash: claim.account_subject_hash,
					disabled_at: claim.bound_at,
					credential_backend: this.storage.backend,
				});
				return this.connection();
			}
			this.writeConnection({
				installation_id: installation.installationId,
				device_id: claim.device_id,
				account_subject_hash: claim.account_subject_hash,
				connected_at: claim.bound_at,
				credential_backend: this.storage.backend,
			});
			return this.connection();
		} catch (error) {
			// Claim failed: roll back to the previous binding and credentials.
			if (previousTokens) this.storage.save(previousTokens);
			else this.storage.clear();
			this.restoreConnection(previousConnection);
			throw new CloudAuthError("claim_failed", `device claim failed: ${msg(error)}`);
		}
	}

	/** Returns a live access token, refreshing when near expiry. Throws
	 *  CloudAuthError("credential_expired") when credentials cannot be used. */
	async getAccessToken(signal?: AbortSignal): Promise<string | null> {
		const tokens = this.storage.load();
		if (!tokens) return null;
		if (tokens.expiresAtEpochMs - this.nowFn() > 30_000) return tokens.access;
		if (!tokens.refresh) throw new CloudAuthError("credential_expired", "no refresh token; reconnect the device");
		if (!this.profileResolver) throw new CloudAuthError("credential_expired", "no profile configured for refresh; reconnect the device");
		const profile = this.profileResolver();
		const discovery = await this.fetchDiscovery(profile);
		const response = await this.oidcPost(
			discovery.token_endpoint,
			new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh, client_id: profile.oidc_client_id }),
			signal,
		);
		const body = await readOidcBody(response);
		if (!body.access_token) {
			// A permanently rejected refresh is a real result: persist it so
			// connection() reports credential_expired instead of pretending
			// the credentials are still live.
			this.storage.save({ ...tokens, refresh: undefined, expiresAtEpochMs: this.nowFn() - 1 });
			throw new CloudAuthError("credential_expired", "token refresh was rejected; reconnect the device");
		}
		const refreshed: TokenSet = {
			access: body.access_token,
			refresh: body.refresh_token ?? tokens.refresh,
			expiresAtEpochMs: this.nowFn() + (Number(body.expires_in) || 300) * 1000,
			scope: body.scope ?? tokens.scope,
		};
		this.storage.save(refreshed);
		return refreshed.access;
	}

	/** Unconditional local cleanup first (tokens + binding + installation
	 *  rotation), then a best-effort Cloud disconnect call. An expired token
	 *  or a dead Cloud can never block switching accounts. */
	async disconnect(signal?: AbortSignal): Promise<void> {
		const previous = this.readConnection();
		const tokens = this.storage.load();
		this.storage.clear();
		const installationId = randomUUID();
		this.writeConnection({ installation_id: installationId, credential_backend: this.storage.backend });
		if (previous?.installation_id && tokens) {
			const timeout = AbortSignal.timeout(DISCONNECT_BEST_EFFORT_MS);
			const merged = AbortSignal.any([...(signal ? [signal] : []), timeout]);
			try {
				await this.api.disconnectDevice(tokens.access, hashOf(previous.installation_id), merged);
			} catch {
				// Local cleanup already happened; the stale Cloud binding is
				// unreachable once the installation id rotated.
			}
		}
	}

	/** Persist a Cloud-side stop: the device has been disabled by an
	 *  administrator. Tokens are dropped (they are useless), the binding
	 *  stays so the user sees exactly why every call now fails. */
	async markDeviceDisabled(): Promise<void> {
		const file = this.readConnection();
		this.storage.clear();
		this.writeConnection({
			installation_id: file?.installation_id ?? randomUUID(),
			device_id: file?.device_id,
			account_subject_hash: file?.account_subject_hash,
			connected_at: file?.connected_at,
			disabled_at: new Date(this.nowFn()).toISOString(),
			credential_backend: this.storage.backend,
		});
	}

	/** Persist an expired-credential stop: the IdP rejected the refresh. */
	markCredentialExpired(): void {
		const tokens = this.storage.load();
		if (!tokens) return;
		this.storage.save({ ...tokens, refresh: undefined, expiresAtEpochMs: this.nowFn() - 1 });
	}

	private async pollForTokens(
		tokenEndpoint: string,
		profile: CloudProfile,
		deviceCode: string,
		initialIntervalSec: number,
		totalCapSec: number,
		signal?: AbortSignal,
	): Promise<TokenSet> {
		const started = this.nowFn();
		const totalCapMs = totalCapSec * 1000;
		let intervalSec = initialIntervalSec;
		for (;;) {
			if (signal?.aborted) throw new CloudAuthError("authorization_cancelled", "device authorization was cancelled");
			if (this.nowFn() - started > totalCapMs) {
				throw new CloudAuthError("authorization_timeout", `device authorization timed out after ${totalCapSec}s`);
			}
			const response = await this.oidcPost(
				tokenEndpoint,
				new URLSearchParams({
					grant_type: "urn:ietf:params:oauth:grant-type:device_code",
					device_code: deviceCode,
					client_id: profile.oidc_client_id,
				}),
				signal,
			);
			const body = await readOidcBody(response);
			switch (body.error) {
				case undefined:
					if (!body.access_token) throw new CloudAuthError("discovery_failed", "token endpoint returned no access token");
					return {
						access: body.access_token,
						refresh: body.refresh_token,
						expiresAtEpochMs: this.nowFn() + (Number(body.expires_in) || 300) * 1000,
						scope: body.scope ?? profile.scopes.join(" "),
					};
				case "authorization_pending":
					break;
				case "slow_down":
					intervalSec += SLOW_DOWN_BUMP_SEC;
					break;
				case "expired_token":
					throw new CloudAuthError("authorization_expired", "the device code expired before authorization");
				case "access_denied":
					throw new CloudAuthError("authorization_denied", "the user denied the authorization request");
				default:
					throw new CloudAuthError("authorization_failed", `token polling failed: ${body.error}`);
			}
			await this.sleepFn(intervalSec * 1000, signal);
		}
	}

	private async fetchDiscovery(profile: CloudProfile): Promise<{ device_authorization_endpoint: string; token_endpoint: string }> {
		const issuerUrl = new URL(profile.oidc_issuer);
		if (issuerUrl.protocol !== "https:" && !isLoopback(issuerUrl.hostname)) {
			throw new CloudAuthError("invalid_profile", "profile issuer must use https (http only for loopback development)");
		}
		const documentURL = `${issuerUrl.toString().replace(/\/$/, "")}/.well-known/openid-configuration`;
		let response: FetchResponse;
		try {
			response = await undiciFetch(documentURL, {
				headers: { accept: "application/json" },
				signal: AbortSignal.timeout(OIDC_REQUEST_TIMEOUT_MS),
			});
		} catch (error) {
			throw new CloudAuthError("discovery_failed", `oidc discovery fetch failed: ${msg(error)}`);
		}
		if (!response.ok) throw new CloudAuthError("discovery_failed", `oidc discovery returned ${response.status}`);
		const document = (await response.json()) as {
			issuer?: string;
			device_authorization_endpoint?: string;
			token_endpoint?: string;
		};
		if (!document.issuer || document.issuer !== profile.oidc_issuer) {
			throw new CloudAuthError("issuer_mismatch", `discovery issuer ${document.issuer ?? "(missing)"} does not match the configured issuer`);
		}
		if (!document.device_authorization_endpoint || !document.token_endpoint) {
			throw new CloudAuthError("discovery_failed", "discovery document is missing device authorization or token endpoints");
		}
		return { device_authorization_endpoint: document.device_authorization_endpoint, token_endpoint: document.token_endpoint };
	}

	private async oidcPost(endpoint: string, body: URLSearchParams, signal?: AbortSignal): Promise<FetchResponse> {
		return undiciFetch(endpoint, {
			method: "POST",
			headers: {
				accept: "application/json",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: body.toString(),
			signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(OIDC_REQUEST_TIMEOUT_MS)]),
		});
	}

	private readConnection(): ConnectionFile | undefined {
		try {
			if (!existsSync(this.connectionPath)) return undefined;
			return JSON.parse(readFileSync(this.connectionPath, "utf8")) as ConnectionFile;
		} catch {
			return undefined;
		}
	}

	private restoreConnection(previous: ConnectionFile | undefined): void {
		if (previous) this.writeConnection(previous);
		else if (existsSync(this.connectionPath)) rmSync(this.connectionPath);
	}

	private writeConnection(file: ConnectionFile): void {
		atomicWriteJson(this.connectionPath, file);
	}
}

// --- Credential backend ----------------------------------------------------

class FileCloudCredentialStorage implements CloudCredentialStorage {
	readonly backend = "file";

	constructor(private readonly path: string) {}

	load(): TokenSet | undefined {
		try {
			if (!existsSync(this.path)) return undefined;
			return JSON.parse(readFileSync(this.path, "utf8")) as TokenSet;
		} catch {
			return undefined;
		}
	}

	save(tokens: TokenSet): void {
		atomicWriteJson(this.path, tokens);
	}

	clear(): void {
		try {
			if (existsSync(this.path)) rmSync(this.path);
		} catch {
			// best effort; absence also counts as cleared
		}
	}
}

// --- Helpers -----------------------------------------------------------------

export function hashOf(value: string): string {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function loadProfileFile(path: string): CloudProfile {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		throw new CloudAuthError("invalid_profile", `cannot read profile file: ${msg(error)}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new CloudAuthError("invalid_profile", "profile file is not valid JSON");
	}
	if (typeof parsed !== "object" || parsed === null) {
		throw new CloudAuthError("invalid_profile", "profile file must contain a JSON object");
	}
	const profile = parsed as Partial<CloudProfile>;
	const required = ["name", "api_base_url", "oidc_issuer", "oidc_client_id", "oidc_audience", "scopes"] as const;
	const missing = required.filter((key) => !profile[key]);
	if (missing.length > 0) {
		throw new CloudAuthError("invalid_profile", `profile file is missing: ${missing.join(", ")}`);
	}
	validateProfile(profile as CloudProfile);
	return profile as CloudProfile;
}

export function validateProfile(profile: CloudProfile): void {
	// Production profiles must be plain HTTPS; loopback hosts may use http
	// for local development with the fake IdP/Cloud (the CloudClient still
	// enforces strict TLS + explicit dev CA for the API base URL).
	const api = new URL(profile.api_base_url);
	if (api.protocol !== "https:" && !isLoopback(api.hostname)) {
		throw new CloudAuthError("invalid_profile", "api_base_url must use https");
	}
	const issuer = new URL(profile.oidc_issuer);
	if (issuer.protocol !== "https:" && !isLoopback(issuer.hostname)) {
		throw new CloudAuthError("invalid_profile", "oidc_issuer must use https");
	}
	if (!profile.scopes.includes("openid")) {
		throw new CloudAuthError("invalid_profile", "scopes must include openid");
	}
}

function atomicWriteJson(path: string, value: object): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temp = `${path}.tmp-${randomUUID()}`;
	writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	renameSync(temp, path);
	chmodSync(path, 0o600);
}

async function readOidcBody(response: FetchResponse): Promise<Record<string, string | undefined>> {
	try {
		return (await response.json()) as Record<string, string | undefined>;
	} catch {
		return {};
	}
}

function isLoopback(hostname: string): boolean {
	return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function msg(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}