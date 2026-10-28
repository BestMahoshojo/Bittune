// Verifies the Local contract mirror (contracts/cloud/) against the Cloud
// repository's source (../bittune-cloud/openapi/):
//   1. the source directory must exist (check out the sibling repo first);
//   2. every mirrored file must be byte-identical to its source counterpart,
//      with no extra or missing files;
//   3. every fixture listed in SHA256SUMS must match its recorded digest.
//
// Exit code 1 on any drift. Usage: node scripts/check-cloud-contract-sync.mjs
// Optionally override the source dir: BITTUNE_CLOUD_SOURCE_DIR=path ...
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mirrorRoot = join(repoRoot, "contracts", "cloud");
const sourceRoot = process.env.BITTUNE_CLOUD_SOURCE_DIR
	? resolve(process.env.BITTUNE_CLOUD_SOURCE_DIR)
	: join(dirname(repoRoot), "bittune-cloud", "openapi");

const failures = [];

if (!existsSync(sourceRoot)) {
	fail(`cloud contract source not found at ${sourceRoot}; check out the bittune-cloud sibling repository`);
} else if (!existsSync(mirrorRoot)) {
	fail(`mirror directory missing: ${mirrorRoot}`);
} else {
	const sourceFiles = walk(sourceRoot);
	const mirrorFiles = walk(mirrorRoot);
	const byRel = new Map(mirrorFiles.map((path) => [relative(mirrorRoot, path), path]));

	for (const path of sourceFiles) {
		const rel = relative(sourceRoot, path);
		const mirrorPath = byRel.get(rel);
		if (!mirrorPath) {
			fail(`mirror is missing file ${rel}`);
			continue;
		}
		byRel.delete(rel);
		const sourceBytes = readFileSync(path);
		const mirrorBytes = readFileSync(mirrorPath);
		if (!sourceBytes.equals(mirrorBytes)) {
			fail(`mirror drift in ${rel}: bytes differ from ${path}`);
		}
	}
	for (const rel of byRel.keys()) {
		fail(`mirror has extra file ${rel} not present in the source`);
	}
}

// SHA256SUMS internal consistency, independent of the sibling repo.
const sumsPath = join(mirrorRoot, "SHA256SUMS");
if (existsSync(sumsPath)) {
	const lines = readFileSync(sumsPath, "utf8").trim().split("\n").filter(Boolean);
	const seen = new Set();
	for (const line of lines) {
		const space = line.indexOf("  ");
		if (space < 0 || !/^[a-f0-9]{64}$/.test(line.slice(0, space))) {
			fail(`malformed SHA256SUMS line: ${line}`);
			continue;
		}
		const [want, rel] = [line.slice(0, space), line.slice(space + 2)];
		const file = join(mirrorRoot, rel);
		if (!existsSync(file)) {
			fail(`SHA256SUMS entry missing file: ${rel}`);
			continue;
		}
		const got = createHash("sha256").update(readFileSync(file)).digest("hex");
		if (got !== want) fail(`SHA256SUMS mismatch for ${rel}: ${got} != ${want}`);
		seen.add(rel);
	}
	for (const path of walk(join(mirrorRoot, "fixtures"))) {
		const rel = relative(mirrorRoot, path).split(sep).join("/");
		if (!seen.has(rel)) fail(`fixture not listed in SHA256SUMS: ${rel}`);
	}
} else {
	fail("mirror is missing SHA256SUMS");
}

if (failures.length > 0) {
	console.error("check:cloud-contract FAILED");
	for (const message of failures) console.error(`  - ${message}`);
	process.exit(1);
}
console.log(`check:cloud-contract OK (${mirrorRoot} matches ${sourceRoot})`);

function walk(dir) {
	const entries = [];
	for (const name of readdirSync(dir).sort()) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) entries.push(...walk(path));
		else entries.push(path);
	}
	return entries;
}

function fail(message) {
	failures.push(message);
}