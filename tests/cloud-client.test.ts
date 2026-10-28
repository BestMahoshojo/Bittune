import { createTlsFixture } from "./cloud/tls-fixture.ts";
/**
 * CloudClient behavior tests against a local HTTPS stub: strict TLS with an
 * explicit development CA, timeout handling, retry classification and error
 * envelope mapping.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createServer as createHttpsServer } from "node:https";
import { after, test } from "node:test";
import { CloudApiError, CloudClient } from "../packages/bittune-runtime/src/harness/cloud-client.ts";

const certsDir = createTlsFixture();
const serverKey = readFileSync(join(certsDir, "server.key"));
const serverCert = readFileSync(join(certsDir, "ca.crt"));

interface RecordedRequest {
	path: string;
	hasToken: boolean;
	idempotencyKey?: string;
	installationHash?: string;
}

type Handler = (record: RecordedRequest, index: number) => { status: number; body: string } | Promise<{ status: number; body: string }>;

interface Stub {
	baseUrl: string;
	requests: RecordedRequest[];
	close(): void;
}

async function startStub(handler: Handler): Promise<Stub> {
	const requests: RecordedRequest[] = [];
	const server = createHttpsServer({ key: serverKey, cert: serverCert }, (req, res) => {
		const record: RecordedRequest = {
			path: req.url ?? "/",
			hasToken: req.headers.authorization?.startsWith("Bearer ") ?? false,
			idempotencyKey: req.headers["idempotency-key"] as string | undefined,
			installationHash: req.headers["x-bittune-installation-hash"] as string | undefined,
		};
		requests.push(record);
		void Promise.resolve(handler(record, requests.length - 1)).then((outcome) => {
			res.writeHead(outcome.status, { "content-type": "application/json" });
			res.end(outcome.body);
		});
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const address = server.address();
	if (typeof address === "string" || address === null) throw new Error("no listen address");
	return {
		baseUrl: `https://127.0.0.1:${address.port}`,
		requests,
		close: () => void server.close(),
	};
}

const openClients: CloudClient[] = [];

after(async () => {
	await Promise.all(openClients.map((client) => client.close().catch(() => {})));
});

function clientFor(
	baseUrl: string,
	options: { devCa?: boolean; timeoutMs?: number; maxRetries?: number } = {},
): CloudClient {
	const created = new CloudClient({
		baseUrl,
		devCaPath: options.devCa === false ? undefined : join(certsDir, "ca.crt"),
		timeoutMs: options.timeoutMs ?? 5_000,
		maxRetries: options.maxRetries ?? 2,
		clientVersion: "bittune-local/test",
	});
	openClients.push(created);
	return created;
}

test("http base URLs are refused at construction", () => {
	assert.throws(() => new CloudClient({ baseUrl: "http://cloud.example.com" }), /https/);
});

test("a dev CA is refused for non-loopback endpoints", () => {
	assert.throws(
		() => new CloudClient({ baseUrl: "https://cloud.example.com", devCaPath: join(certsDir, "ca.crt") }),
		/localhost\/127\.0\.0\.1/,
	);
});

test("requests succeed against a trusted localhost server with the dev CA", async () => {
	const stub = await startStub(() => ({ status: 200, body: `{"status":"ok"}` }));
	const client = clientFor(stub.baseUrl);
	const body = await client.request<{ status: string }>("/v1/device", {
		method: "GET",
		token: "test-token",
		headers: { "X-Bittune-Installation-Hash": `sha256:${"a".repeat(64)}` },
	});
	assert.equal(body.status, "ok");
	assert.equal(stub.requests.length, 1);
	assert.equal(stub.requests[0]?.hasToken, true);
	assert.equal(stub.requests[0]?.installationHash, `sha256:${"a".repeat(64)}`);
	stub.close();
});

test("an untrusted certificate fails without any retry", async () => {
	const stub = await startStub(() => ({ status: 200, body: "{}" }));
	const client = clientFor(stub.baseUrl, { devCa: false });
	await assert.rejects(client.request("/v1/device"), (error: unknown) => {
		assert.ok(error instanceof CloudApiError);
		assert.equal(error.code, "tls_failure");
		assert.equal(error.retryable, false);
		return true;
	});
	assert.equal(stub.requests.length, 0);
	stub.close();
});

	test("per-call 30s timeout with no retries accepts a 16s response once", { timeout: 40_000 }, async () => {
		const stub = await startStub(async () => {
			await new Promise((done) => setTimeout(done, 16_000));
			return { status: 200, body: `{"ok":true}` };
		});
		const client = clientFor(stub.baseUrl, { timeoutMs: 15_000, maxRetries: 2 });
		const body = await client.request<{ ok: boolean }>("/v1/recommendations/query", {
			method: "POST",
			timeoutMs: 30_000,
			maxRetries: 0,
		});
		assert.equal(body.ok, true);
		assert.equal(stub.requests.length, 1);
		stub.close();
	});

		test("per-call 30s timeout with no retries fails a 31s hang once", { timeout: 45_000 }, async () => {
			const stub = await startStub(async () => {
				await new Promise((done) => setTimeout(done, 31_000));
				return { status: 200, body: `{"ok":true}` };
			});
			const client = clientFor(stub.baseUrl, { timeoutMs: 15_000, maxRetries: 2 });
			await assert.rejects(
				client.request("/v1/recommendations/query", {
					method: "POST",
					timeoutMs: 30_000,
					maxRetries: 0,
				}),
				(error: unknown) => {
					assert.ok(error instanceof CloudApiError);
					assert.equal(error.code, "network_error");
					return true;
				},
			);
			assert.equal(stub.requests.length, 1);
			stub.close();
		});

		test("timeouts retry up to maxRetries then fail as network errors", async () => {
	const stub = await startStub(async () => {
		await new Promise((done) => setTimeout(done, 300));
		return { status: 200, body: "{}" };
	});
	const client = clientFor(stub.baseUrl, { timeoutMs: 80, maxRetries: 2 });
	await assert.rejects(client.request("/v1/device"), (error: unknown) => {
		assert.ok(error instanceof CloudApiError);
		assert.equal(error.code, "network_error");
		assert.equal(error.retryable, true);
		return true;
	});
	assert.equal(stub.requests.length, 3, "one initial attempt plus two retries");
	stub.close();
});

test("408, 429 and 5xx retry with the envelope preserved on the final throw", async () => {
	for (const status of [408, 429, 500, 503]) {
		const stub = await startStub(() => ({ status, body: `{"error":{"code":"busy","message":"retry later"}}` }));
		const client = clientFor(stub.baseUrl);
		await assert.rejects(client.request("/v1/device"), (error: unknown) => {
			assert.ok(error instanceof CloudApiError);
			assert.equal(error.status, status);
			assert.equal(error.code, "busy");
			return true;
		});
		assert.equal(stub.requests.length, 3, `status ${status} must retry`);
		stub.close();
	}
});

test("401, 403, 404, 409 and 422 never retry and map to stable codes", async () => {
	const cases: Array<[number, string]> = [
		[401, "unauthorized"],
		[403, "insufficient_scope"],
		[404, "not_found"],
		[409, "conflict"],
		[422, "validation_failed"],
	];
	for (const [status, code] of cases) {
		const stub = await startStub(() => ({ status, body: `{"error":{"code":"${code}","message":"no"}}` }));
		const client = clientFor(stub.baseUrl);
		await assert.rejects(client.request("/v1/device"), (error: unknown) => {
			assert.ok(error instanceof CloudApiError);
			assert.equal(error.code, code);
			assert.equal(error.status, status);
			assert.equal(error.retryable, false);
			return true;
		});
		assert.equal(stub.requests.length, 1, `status ${status} must not retry`);
		stub.close();
	}
});

test("Idempotency-Key headers pass through on uploads", async () => {
	const stub = await startStub(() => ({ status: 200, body: `{"status":"received"}` }));
	const client = clientFor(stub.baseUrl);
	await client.request("/v1/experience-exports/exp-0123456789abcdef0123456789ab", {
		method: "PUT",
		body: { outcome: "success" },
		idempotencyKey: "ik-123",
	});
	assert.equal(stub.requests[0]?.idempotencyKey, "ik-123");
	stub.close();
});

test("missing envelopes fall back to status-derived codes", async () => {
	const stub = await startStub(() => ({ status: 401, body: "plain text" }));
	const client = clientFor(stub.baseUrl);
	await assert.rejects(client.request("/v1/device"), (error: unknown) => {
		assert.ok(error instanceof CloudApiError);
		assert.equal(error.status, 401);
		assert.equal(error.code, "unauthorized");
		return true;
	});
	stub.close();
});