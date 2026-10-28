import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

/** Each test process owns its ephemeral localhost identity; no checked-in key. */
export function createTlsFixture(): string {
	const directory = mkdtempSync(join(tmpdir(), "bittune-test-tls-"));
	try {
		execFileSync("openssl", [
			"req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
			"-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
			"-keyout", join(directory, "server.key"), "-out", join(directory, "ca.crt"),
		], { stdio: "pipe" });
	} catch (error) {
		rmSync(directory, { recursive: true, force: true });
		throw error;
	}
	after(() => rmSync(directory, { recursive: true, force: true }));
	return directory;
}
