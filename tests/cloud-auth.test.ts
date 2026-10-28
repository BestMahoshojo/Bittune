/**
 * CloudAuth tests against a fake OIDC provider and a fake Cloud API port:
 * RFC 8628 polling, cancellation, slow_down, expiry caps, refresh,
 * credential persistence and the disconnect local-first guarantee.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { test } from "node:test";
import {
	CloudAuth,
	CloudAuthError,
	loadProfileFile,
	validateProfile,
	type CloudApiPort,
	type CloudProfile,
} from "../packages/bittune-runtime/src/harness/cloud-auth.ts";

const DEVICE_ID = "dev-6f9619ff8b86d011c42f7d3b0a";

type OidcBehavior = {
	pendingFirst?: number;
	slowDownFirst?: boolean;
	expired?: boolean;
	denied?: boolean;
	refreshDenied?: boolean;
	accessTokenSuffix?: string;
	accessExpiresIn?: number;
	expiresIn?: number;
	issuerOverride?: string;
};

class FakeOidc {
	url!: string;
	issuer!: string;
	readonly tokenRequests: URLSearchParams[] = [];
	private pendingRemaining!: number;
	private behavior!: OidcBehavior;
	private server: ReturnType<typeof createServer> | undefined;

	private constructor() {}

	static async create(behavior: OidcBehavior = {}): Promise<FakeOidc> {
		const oidc = new FakeOidc();
		await oidc.init(behavior);
		return oidc;
	}

	private async init(behavior: OidcBehavior) {
		this.behavior = behavior;
		this.pendingRemaining = behavior.pendingFirst ?? 0;
		this.server = createServer((req, res) => {
			let body = "";
			req.on("data", (chunk) => (body += chunk));
			req.on("end", () => void this.route(req.url ?? "/", new URLSearchParams(body), res));
		});
		await new Promise<void>((done) => this.server!.listen(0, "127.0.0.1", done));
		const address = this.server!.address() as { port: number };
		this.url = `http://127.0.0.1:${address.port}`;
		this.issuer = `${this.url}/realms/bittune`;
	}

	close(): void {
		this.server?.close();
	}

	private route(path: string, params: URLSearchParams, res: import("node:http").ServerResponse): void {
		res.setHeader("content-type", "application/json");
		if (path.endsWith("/.well-known/openid-configuration")) {
			res.end(
				JSON.stringify({
					issuer: this.behavior.issuerOverride ?? this.issuer,
					device_authorization_endpoint: `${this.url}/device`,
					token_endpoint: `${this.url}/token`,
				}),
			);
			return;
		}
		if (path.endsWith("/token")) {
			this.tokenRequests.push(params);
			if (params.get("grant_type") === "refresh_token") {
				if (this.behavior.refreshDenied) res.end(JSON.stringify({ error: "invalid_grant" }));
				else
					res.end(
						JSON.stringify({
							access_token: `access-refreshed-${this.behavior.accessTokenSuffix ?? "token"}`,
							refresh_token: "refresh-next",
							expires_in: 300,
						}),
					);
				return;
			}
			if (this.behavior.expired) res.end(JSON.stringify({ error: "expired_token" }));
			else if (this.behavior.denied) res.end(JSON.stringify({ error: "access_denied" }));
			else if (this.behavior.slowDownFirst && this.tokenRequests.length === 1) res.end(JSON.stringify({ error: "slow_down" }));
			else if (this.pendingRemaining > 0) {
				this.pendingRemaining -= 1;
				res.end(JSON.stringify({ error: "authorization_pending" }));
			} else {
				res.end(
					JSON.stringify({
						access_token: `access-${this.behavior.accessTokenSuffix ?? "fresh"}`,
						refresh_token: "refresh-1",
						expires_in: this.behavior.accessExpiresIn ?? 300,
						scope: "openid offline_access recommendations:read experiences:write",
					}),
				);
			}
			return;
		}
		if (path.endsWith("/device")) {
			res.end(
				JSON.stringify({
					device_code: "dc-test-1",
					user_code: "TEST-CODE",
					verification_uri: `${this.url}/device-page`,
					verification_uri_complete: `${this.url}/device-page?user_code=TEST-CODE`,
					expires_in: this.behavior.expiresIn ?? 600,
					interval: 4, // below the 5s floor on purpose
				}),
			);
			return;
		}
		res.statusCode = 404;
		res.end("{}");
	}
}

class FakeApi implements CloudApiPort {
	readonly claims: Array<{ body: { installation_id_hash: string; client_version: string }; token: string }> = [];
	readonly disconnects: Array<{ token: string; hash: string }> = [];
	status: "connected" | "disabled" = "connected";
	failClaim = false;
	failDisconnect = false;

	async claim(body: { installation_id_hash: string; client_version: string }, token: string) {
		this.claims.push({ body, token });
		if (this.failClaim) throw new Error("claim endpoint down");
		return {
			device_id: DEVICE_ID,
			status: this.status,
			account_subject_hash: `sha256:${"b".repeat(64)}`,
			bound_at: "2026-09-01T08:00:00Z",
		};
	}

	async disconnectDevice(token: string, installationHash: string) {
		this.disconnects.push({ token, hash: installationHash });
		if (this.failDisconnect) throw new Error("disconnect endpoint down");
	}
}

interface Harness {
	oidc: FakeOidc;
	api: FakeApi;
	auth: CloudAuth;
	coreDir: string;
	clock: { now: number; sleep: (ms: number) => Promise<void> };
}

/** Builds a harness with a fake clock; the fake clock advances inside sleep,
 *  so authorization timeouts are instant while intervals stay real-shaped. */
async function makeHarness(behavior: OidcBehavior = {}): Promise<Harness> {
	const oidc = await FakeOidc.create(behavior);
	const api = new FakeApi();
	const coreDir = mkdtempSync(join(tmpdir(), "bittune-cloud-auth-"));
	const clock = {
		now: 1_000_000_000_000,
		async sleep(ms: number) {
			clock.now += ms;
		},
	};
	const current = { ...testProfile(), oidc_issuer: oidc.issuer };
	const auth = new CloudAuth({
		coreDir,
		api,
		clientVersion: "bittune-local/test",
		profileResolver: () => current,
		sleep: clock.sleep,
		now: () => clock.now,
	});
	return { oidc, api, auth, coreDir, clock };
}

function testProfile(): CloudProfile {
	return {
		name: "test",
		api_base_url: "https://cloud.example.com",
		oidc_issuer: "https://login.example.com/realms/bittune",
		oidc_client_id: "bittune-local",
		oidc_audience: "bittune-cloud-api",
		scopes: ["openid", "offline_access", "recommendations:read", "experiences:write"],
	};
}

function readConnection(coreDir: string): Record<string, unknown> {
	return JSON.parse(readFileSync(join(coreDir, "cloud", "cloud-connection.json"), "utf8")) as Record<string, unknown>;
}

function readTokens(coreDir: string): Record<string, unknown> {
	return JSON.parse(readFileSync(join(coreDir, "cloud", "cloud-tokens.json"), "utf8")) as Record<string, unknown>;
}

test("connect completes the device flow and persists binding + tokens", async () => {
	const harness = await makeHarness({ pendingFirst: 2 });
	const info = await harness.auth.connect({ ...testProfile(), oidc_issuer: harness.oidc.issuer }, { onDeviceCode: () => {} });
	assert.equal(info.state, "connected");
	assert.equal(info.deviceId, DEVICE_ID);
	assert.equal(info.credentialBackend, "file");
	assert.equal(harness.api.claims.length, 1);
	assert.match(harness.api.claims[0]?.body.installation_id_hash ?? "", /^sha256:[a-f0-9]{64}$/);
	assert.ok(harness.api.claims[0]?.token.startsWith("access-"));
	assert.equal(readConnection(harness.coreDir).device_id, DEVICE_ID);
	assert.ok(readTokens(harness.coreDir).refresh);
	harness.oidc.close();
});

test("an already-aborted signal cancels the flow without persisting tokens", async () => {
	const harness = await makeHarness({});
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		harness.auth.connect({ ...testProfile(), oidc_issuer: harness.oidc.issuer }, { onDeviceCode: () => {}, signal: controller.signal }),
		(error: unknown) => error instanceof CloudAuthError && error.code === "authorization_cancelled",
	);
	assert.equal(existsSync(join(harness.coreDir, "cloud", "cloud-tokens.json")), false);
	harness.oidc.close();
});

test("polling stops at the 600s cap with authorization_timeout", async () => {
	const harness = await makeHarness({ pendingFirst: 100_000 });
	let presented: { expiresInSec: number } | undefined;
	await assert.rejects(
		harness.auth.connect(
			{ ...testProfile(), oidc_issuer: harness.oidc.issuer },
			{ onDeviceCode: (info) => (presented = info) },
		),
		(error: unknown) => error instanceof CloudAuthError && error.code === "authorization_timeout",
	);
	assert.equal(presented?.expiresInSec, 600);
	harness.oidc.close();
});

test("slow_down bumps the poll interval by five seconds after the floor", async () => {
	const harness = await makeHarness({ slowDownFirst: true, pendingFirst: 1 });
	const delays: number[] = [];
	const auth = new CloudAuth({
		coreDir: harness.coreDir,
		api: harness.api,
		clientVersion: "bittune-local/test",
		sleep: async (ms) => void delays.push(ms),
		now: () => harness.clock.now,
	});
	await auth.connect({ ...testProfile(), oidc_issuer: harness.oidc.issuer }, { onDeviceCode: () => {} });
	// initial interval is floored to 5s; slow_down arrives on the first poll
	// and future polls wait 10s each.
	assert.deepEqual(delays, [10_000, 10_000]);
	harness.oidc.close();
});

test("expired device codes and denials surface distinct stable errors", async () => {
	const cases: Array<[{ expired?: boolean; denied?: boolean }, string]> = [
		[{ expired: true }, "authorization_expired"],
		[{ denied: true }, "authorization_denied"],
	];
	for (const [behavior, code] of cases) {
		const harness = await makeHarness(behavior);
		await assert.rejects(
			harness.auth.connect({ ...testProfile(), oidc_issuer: harness.oidc.issuer }, { onDeviceCode: () => {} }),
			(error: unknown) => error instanceof CloudAuthError && error.code === code,
		);
		harness.oidc.close();
	}
});

test("discovery issuer mismatch is refused", async () => {
	const harness = await makeHarness({ issuerOverride: "https://evil.example.com" });
	await assert.rejects(
		harness.auth.connect({ ...testProfile(), oidc_issuer: harness.oidc.issuer }, { onDeviceCode: () => {} }),
		(error: unknown) => error instanceof CloudAuthError && error.code === "issuer_mismatch",
	);
	harness.oidc.close();
});

test("tokens refresh through the token endpoint near expiry", async () => {
	const harness = await makeHarness({});
	await harness.auth.connect({ ...testProfile(), oidc_issuer: harness.oidc.issuer }, { onDeviceCode: () => {} });
	// 8 seconds in: still far from expiry, the stored access token is used.
	harness.clock.now += 8_000;
	const direct = await harness.auth.getAccessToken();
	assert.equal(direct, "access-fresh");
	// Cross the 30s refresh horizon: the refresh grant replaces the token.
	harness.clock.now += 290_000;
	const refreshed = await harness.auth.getAccessToken();
	assert.equal(refreshed, "access-refreshed-token");
	harness.oidc.close();
});

test("a rejected refresh reports credential_expired", async () => {
	const harness = await makeHarness({ refreshDenied: true });
	await harness.auth.connect({ ...testProfile(), oidc_issuer: harness.oidc.issuer }, { onDeviceCode: () => {} });
	harness.clock.now += 300_000;
	await assert.rejects(harness.auth.getAccessToken(), (error: unknown) => error instanceof CloudAuthError && error.code === "credential_expired");
	harness.oidc.close();
});

test("disconnect is local-first and rotates the installation id even when Cloud is down", async () => {
	const harness = await makeHarness({});
	await harness.auth.connect({ ...testProfile(), oidc_issuer: harness.oidc.issuer }, { onDeviceCode: () => {} });
	const before = readConnection(harness.coreDir).installation_id as string;
	harness.api.failDisconnect = true;
	await harness.auth.disconnect();
	const after = readConnection(harness.coreDir);
	assert.notEqual(after.installation_id, before, "installation id must rotate");
	assert.equal(after.device_id, undefined);
	assert.equal(existsSync(join(harness.coreDir, "cloud", "cloud-tokens.json")), false);
	const state = await harness.auth.connection();
	assert.equal(state.state, "disconnected");
	assert.equal(harness.api.disconnects.length, 1, "best-effort Cloud notify was attempted");
	harness.oidc.close();
});

test("a failed claim restores the previous binding and credentials", async () => {
	const harness = await makeHarness({});
	await harness.auth.connect({ ...testProfile(), oidc_issuer: harness.oidc.issuer }, { onDeviceCode: () => {} });
	const before = readConnection(harness.coreDir);
	const beforeTokens = readTokens(harness.coreDir);

	harness.api.failClaim = true;
	await assert.rejects(
		harness.auth.connect({ ...testProfile(), oidc_issuer: harness.oidc.issuer }, { onDeviceCode: () => {} }),
		(error: unknown) => error instanceof CloudAuthError && error.code === "claim_failed",
	);
	const after = readConnection(harness.coreDir);
	assert.equal(after.installation_id, before.installation_id);
	assert.equal(after.device_id, before.device_id);
	assert.deepEqual(readTokens(harness.coreDir), beforeTokens);
	harness.oidc.close();
});

test("a disabled claim stores the disabled state and clears tokens", async () => {
	const harness = await makeHarness({});
	harness.api.status = "disabled";
	const info = await harness.auth.connect({ ...testProfile(), oidc_issuer: harness.oidc.issuer }, { onDeviceCode: () => {} });
	assert.equal(info.state, "disabled");
	assert.equal(existsSync(join(harness.coreDir, "cloud", "cloud-tokens.json")), false);
	harness.oidc.close();
});

test("profile files are validated against the frozen field set", () => {
	const dir = mkdtempSync(join(tmpdir(), "bittune-profile-"));
	const path = join(dir, "p.json");
	writeFileSync(path, JSON.stringify({ name: "broken" }));
	assert.throws(() => loadProfileFile(path), (error: unknown) => error instanceof CloudAuthError && error.code === "invalid_profile");
	writeFileSync(path, JSON.stringify({ ...testProfile(), name: "ok" }));
	assert.equal(loadProfileFile(path).name, "ok");
	assert.throws(() => validateProfile({ ...testProfile(), api_base_url: "http://insecure" }), (error: unknown) => error instanceof CloudAuthError);
	rmSync(dir, { recursive: true, force: true });
});

test("credential files are stored with owner-only permissions", async () => {
	const harness = await makeHarness({});
	await harness.auth.connect({ ...testProfile(), oidc_issuer: harness.oidc.issuer }, { onDeviceCode: () => {} });
	if (process.platform !== "win32") {
		const mode = statSync(join(harness.coreDir, "cloud", "cloud-tokens.json")).mode & 0o777;
		assert.equal(mode, 0o600);
	}
	harness.oidc.close();
});
test("polling stops at min(expires_in, 600s)", async () => {
	const harness = await makeHarness({ expiresIn: 30, pendingFirst: 100_000 });
	let presented: { expiresInSec: number } | undefined;
	await assert.rejects(
		harness.auth.connect({ ...testProfile(), oidc_issuer: harness.oidc.issuer }, { onDeviceCode: (info) => (presented = info) }),
		(error: unknown) => error instanceof CloudAuthError && error.code === "authorization_timeout",
	);
	assert.equal(presented?.expiresInSec, 30, "the wait budget must honor expires_in");
	harness.oidc.close();
});

test("expired credentials without a refresh token report credential_expired", async () => {
	const harness = await makeHarness({});
	const cloudDir = join(harness.coreDir, "cloud");
	mkdirSync(cloudDir, { recursive: true });
	writeFileSync(
		join(cloudDir, "cloud-connection.json"),
		JSON.stringify({ installation_id: "install-1", device_id: DEVICE_ID, credential_backend: "file" }),
	);
	writeFileSync(
		join(cloudDir, "cloud-tokens.json"),
		JSON.stringify({ access: "access-old", expiresAtEpochMs: harness.clock.now - 1_000, scope: "openid recommendations:read" }),
	);
	const info = await harness.auth.connection();
	assert.equal(info.state, "credential_expired");
	assert.equal(info.deviceId, DEVICE_ID, "local binding must survive the expired state");
	harness.oidc.close();
});

test("cloud-side revocations degrade the persisted connection state", async () => {
	const harness = await makeHarness({});
	await harness.auth.connect({ ...testProfile(), oidc_issuer: harness.oidc.issuer }, { onDeviceCode: () => {} });
	await harness.auth.markDeviceDisabled();
	const disabled = await harness.auth.connection();
	assert.equal(disabled.state, "disabled");
	assert.equal(disabled.deviceId, DEVICE_ID, "the binding survives so the stop is explainable");

	const second = await makeHarness({});
	await second.auth.connect({ ...testProfile(), oidc_issuer: second.oidc.issuer }, { onDeviceCode: () => {} });
	second.auth.markCredentialExpired();
	const expired = await second.auth.connection();
	assert.equal(expired.state, "credential_expired");
	harness.oidc.close();
	second.oidc.close();
});
