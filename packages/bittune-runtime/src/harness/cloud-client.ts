/**
 * The only HTTPS JSON path from the Runtime to the Cloud API.
 *
 * Security boundaries are fixed here and nowhere else:
 *   - http:// URLs are refused outright;
 *   - TLS verification (chain + hostname) is always on; a development CA is
 *     accepted only for localhost/127.0.0.1 endpoints and only when the
 *     operator explicitly supplies one;
 *   - tokens never appear in URLs, query strings or error messages.
 *
 * Retry classification follows the implementation plan: timeouts, 408, 429
 * and 5xx retry (bounded); 401/403/404/409/422 and schema failures do not.
 */
import { Agent, fetch as undiciFetch } from "undici";
import { readFileSync } from "node:fs";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 2;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export interface CloudClientOptions {
	/** Cloud HTTPS API base URL, e.g. https://cloud.example.com */
	baseUrl: string;
	/** Development CA path; only honored for localhost/127.0.0.1 bases. */
	devCaPath?: string;
	/** Per-request timeout in milliseconds. */
	timeoutMs?: number;
	/** Maximum retries after the first attempt. */
	maxRetries?: number;
	/** Local version string for the User-Agent header. */
	clientVersion?: string;
}

	export interface CloudRequestOptions {
		method?: "GET" | "POST" | "PUT";
		body?: unknown;
		/** Idempotency-Key header value for experience uploads. */
		idempotencyKey?: string;
		/** Bearer access token; omitted when unauthenticated. */
		token?: string;
		/** Additional fixed headers (e.g. X-Bittune-Installation-Hash). */
		headers?: Record<string, string>;
		signal?: AbortSignal;
		/** Per-call timeout; omitted uses the constructor default. */
		timeoutMs?: number;
		/** Per-call retries after the first attempt; omitted uses the constructor default. */
		maxRetries?: number;
	}

export class CloudApiError extends Error {
	readonly status: number;
	readonly code: string;
	readonly details?: unknown;
	/** True when the failure class is safe to retry. */
	readonly retryable: boolean;

	constructor(status: number, code: string, message: string, details?: unknown, retryable = false) {
		super(message);
		this.name = "CloudApiError";
		this.status = status;
		this.code = code;
		this.details = details;
		this.retryable = retryable;
	}
}

interface ErrorEnvelopeShape {
	error?: { code?: string; message?: string; details?: unknown };
}

export class CloudClient {
	private readonly baseUrl: URL;
	private readonly dispatcher: Agent;
	private readonly timeoutMs: number;
	private readonly maxRetries: number;
	private readonly clientVersion?: string;

	constructor(options: CloudClientOptions) {
		const parsed = new URL(options.baseUrl);
		if (parsed.protocol !== "https:") {
			throw new Error("cloud base URL must use https");
		}
		this.baseUrl = parsed;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
		this.clientVersion = options.clientVersion;

		let ca: string | undefined;
		if (options.devCaPath) {
			if (!isLocalDevHost(parsed.hostname)) {
				throw new Error("cloud dev CA is only allowed for localhost/127.0.0.1 endpoints");
			}
			ca = readFileSync(options.devCaPath, "utf8");
		}
		if (ca !== undefined && !ca.includes("BEGIN CERTIFICATE")) {
			throw new Error(`cloud dev CA at ${options.devCaPath} is not a PEM certificate`);
		}
		// An unconditional Agent keeps Cloud traffic off the global proxy
		// dispatcher and pins rejection of unauthorized certificates.
		this.dispatcher = new Agent({
			connect: { ca, rejectUnauthorized: true },
		});
	}

	/** One JSON round trip with the fixed security and retry policy. */
		async request<T>(path: string, options: CloudRequestOptions = {}): Promise<T> {
			const url = this.resolveUrl(path);
			const headers = this.buildHeaders(options);
			const bodyText = options.body === undefined ? undefined : JSON.stringify(options.body);
			const timeoutMs = options.timeoutMs ?? this.timeoutMs;
			const maxRetries = options.maxRetries ?? this.maxRetries;
			const attempts = maxRetries + 1;

		let lastError: unknown;
		for (let attempt = 1; attempt <= attempts; attempt += 1) {
			try {
				const response = await undiciFetch(url, {
					method: options.method ?? "GET",
					headers,
					body: bodyText,
					dispatcher: this.dispatcher,
						signal: AbortSignal.any([
							...(options.signal ? [options.signal] : []),
							AbortSignal.timeout(timeoutMs),
						]),
				});
				if (response.status === 204) return undefined as T;
				const text = await response.text();
				let payload: unknown = undefined;
				if (text) {
					try {
						payload = JSON.parse(text);
					} catch {
						payload = text;
					}
				}
				if (response.status >= 200 && response.status < 300) return payload as T;
				const envelope = payload as ErrorEnvelopeShape | string | undefined;
				const error = this.toApiError(response.status, envelope, attempt < attempts);
				if (error.retryable) {
					lastError = error;
					await backoff(attempt, options.signal);
					continue;
				}
				throw error;
			} catch (error) {
				if (options.signal?.aborted) throw error; // the caller cancelled
				if (isTlsFailure(error)) {
					throw new CloudApiError(0, "tls_failure", `TLS verification failed: ${errorMessage(error)}`);
				}
				if (error instanceof CloudApiError) throw error;
				// Connect reset, DNS failure or our own request timeout:
				// transport-level failures retry up to the policy bound.
				lastError = new CloudApiError(0, "network_error", `Cloud request failed: ${errorMessage(error)}`, undefined, true);
				if (attempt < attempts) {
					await backoff(attempt, options.signal);
					continue;
				}
				throw lastError;
			}
		}
		throw lastError;
	}

	/** Releases the dispatcher's sockets; call at runtime shutdown or in tests. */
	close(): Promise<void> {
		return this.dispatcher.close();
	}

	private resolveUrl(path: string): string {
		if (!path.startsWith("/") || path.includes("..")) {
			throw new Error(`cloud request path must be an absolute API path: ${path}`);
		}
		return new URL(path, this.baseUrl.href).toString();
	}

	private buildHeaders(options: CloudRequestOptions): Record<string, string> {
		const headers: Record<string, string> = { ...(options.headers ?? {}) };
		if (options.body !== undefined) headers["Content-Type"] = "application/json";
		headers.Accept = "application/json";
		headers["User-Agent"] = this.clientVersion ?? "bittune-local";
		if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;
		if (options.token) headers.Authorization = `Bearer ${options.token}`;
		return headers;
	}

	private toApiError(status: number, envelope: ErrorEnvelopeShape | string | undefined, retryable: boolean): CloudApiError {
		const shouldRetry = retryable && RETRYABLE_STATUS.has(status);
		if (envelope && typeof envelope !== "string" && envelope.error) {
			return new CloudApiError(status, envelope.error.code ?? "unknown_error", envelope.error.message ?? "Cloud request failed", envelope.error.details, shouldRetry);
		}
		return new CloudApiError(status, defaultCodeForStatus(status), `Cloud request failed with status ${status}`, undefined, shouldRetry);
	}
}

function defaultCodeForStatus(status: number): string {
	switch (status) {
		case 401:
			return "unauthorized";
		case 403:
			return "insufficient_scope";
		case 404:
			return "not_found";
		case 409:
			return "conflict";
		case 422:
			return "validation_failed";
		case 429:
			return "too_many_requests";
		default:
			return "internal_error";
	}
}

function isLocalDevHost(hostname: string): boolean {
	return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

// TLS verification failures surface deep in undici's cause chain (e.g.
// TypeError("fetch failed") -> cause: SocketError -> cause with certificate
// details); walk the chain and nested AggregateErrors.
function isTlsFailure(error: unknown): boolean {
	const needle = /certificate|tls|ssl|unable to verify|self-signed|ERR_TLS|CERT_/i;
	const seen = new Set<unknown>();
	const visit = (candidate: unknown): boolean => {
		if (candidate === null || candidate === undefined || seen.has(candidate)) return false;
		seen.add(candidate);
		if (candidate instanceof Error && needle.test(candidate.message)) return true;
		if (candidate instanceof AggregateError) {
			for (const child of candidate.errors) {
				if (visit(child)) return true;
			}
		}
		if (candidate instanceof Error) return visit(candidate.cause);
		return false;
	};
	return visit(error);
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

async function backoff(attempt: number, signal?: AbortSignal): Promise<void> {
	const delayMs = 250 * attempt;
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, delayMs);
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}