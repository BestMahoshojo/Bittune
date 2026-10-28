/**
 * Phase 2 stage 0 contract freeze tests: the Runtime loads the same frozen
 * fixtures as the Go Cloud tests and the Python Core tests, and the shape of
 * every fixture must satisfy the generated openapi-typescript types.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import type { components, operations } from "../packages/bittune-runtime/src/harness/cloud-contracts.ts";
import {
	CLOUD_DEVICE_ACTIONS,
	CLOUD_EXPERIENCE_ACTIONS,
	CLOUD_TOOL_NAMES,
	MISSING_GPU_COMPARE_RANK_NOTE,
	experiencePreviewLines,
} from "../packages/bittune-runtime/src/harness/cloud-tools.ts";
import { MANAGED_TOOL_NAMES } from "../packages/bittune-runtime/src/harness/managed-tools.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mirror = join(repoRoot, "contracts", "cloud");

function readFixture<T>(rel: string): T {
	return JSON.parse(readFileSync(join(mirror, "fixtures", rel), "utf8")) as T;
}

function sha256(content: Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

test("the phase 2 tool surface is exactly 4 generic + 10 managed + 3 cloud", () => {
	const generic = ["read", "bash", "edit", "write"];
	const all = [...generic, ...MANAGED_TOOL_NAMES, ...CLOUD_TOOL_NAMES];
	assert.equal(all.length, 17, "the seventeen-tool surface is frozen");
	assert.equal(new Set(all).size, 17, "tool names must be unique");
	assert.deepEqual(CLOUD_TOOL_NAMES, ["cloud_device", "cloud_recommend", "cloud_experience"]);
	assert.deepEqual(CLOUD_DEVICE_ACTIONS, ["connect", "status", "disconnect", "set_mode"]);
	assert.deepEqual(CLOUD_EXPERIENCE_ACTIONS, ["preview", "enqueue", "list", "cancel", "send", "retract"]);
});

test("experience preview text shows compare/rank eligibility from display.compare_rank_note", () => {
	const missing = experiencePreviewLines({
		content_hash: "sha256:00",
		display: { compare_rank_note: MISSING_GPU_COMPARE_RANK_NOTE },
	}).join("\n");
	assert.match(missing, /对比和榜：/);
	assert.match(missing, /不能进入选型对比和官方榜/);
	const mapped = experiencePreviewLines({
		content_hash: "sha256:00",
		display: { compare_rank_note: "有 GPU 产品名后，公开审核通过的记录才可能进入选型对比；官方榜另需时延提升。" },
	}).join("\n");
	assert.match(mapped, /有 GPU 产品名后/);
	assert.doesNotMatch(mapped, /不能进入选型对比和官方榜/);
});

test("recommendation fixtures satisfy the announced contract types", () => {
	const query = readFixture<components["schemas"]["RecommendationQueryEnvelopeV2"]>("recommendation/query-request.json");
	assert.equal(query.schema_version, "recommendation-v2");
	assert.equal(query.payload.intent, "fit_model");
	assert.equal(query.payload.environment.vram_bucket, "24-48GiB");
	assert.equal(query.payload.workload_buckets?.load_bucket, "2-8");
	assert.equal(query.payload.constraints.must_be_offline, true);

	const response = readFixture<components["schemas"]["RecommendationQueryResponseV2"]>("recommendation/v2-response-search.json");
	assert.equal(response.rules_version, "serving_search-v1");
	assert.deepEqual(response.measurement_basis, ["catalog", "simulated"]);
	assert.equal(response.candidates.length, 2);
	assert.notEqual(response.candidates[0].candidate_id, response.candidates[0].source.entry_id);
});

test("experience fixtures satisfy the announced contract types", () => {
	const exportPayload = readFixture<components["schemas"]["ExperienceExportPayload"]>("experience/export-request.json");
		assert.equal(exportPayload.schema_version, "experience-export-v2");
	assert.equal(exportPayload.consent_confirmed, true);
	assert.equal(exportPayload.outcome, "success");
	assert.ok(exportPayload.delta, "comparable reports must carry a delta");

	const receipt = readFixture<components["schemas"]["ExperienceReceipt"]>("experience/export-receipt.json");
	assert.equal(receipt.status, "received");
	const retracted = readFixture<components["schemas"]["ExperienceReceipt"]>("experience/export-receipt-retracted.json");
	assert.equal(retracted.status, "retracted");
});

test("device fixtures satisfy the announced contract types", () => {
	const claimRequest = readFixture<components["schemas"]["DeviceClaimRequest"]>("device/claim-request.json");
	assert.ok(claimRequest.installation_id_hash.startsWith("sha256:"));
	const claimResponse = readFixture<components["schemas"]["DeviceClaimResponse"]>("device/claim-response.json");
	assert.equal(claimResponse.status, "connected");
	const disabled = readFixture<components["schemas"]["DeviceStatus"]>("device/device-status-disabled.json");
	assert.equal(disabled.status, "disabled");
});

test("error fixtures use the frozen error codes", () => {
	const names = [
		"unsupported_contract",
		"unauthorized",
		"insufficient_scope",
		"validation_failed",
		"conflict",
		"device_disabled",
		"not_found",
		"too_many_requests",
	];
	const codes = names.map((name) => {
		const envelope = readFixture<components["schemas"]["ErrorEnvelope"]>(`errors/${name}.json`);
		assert.ok(envelope.error.message, `${name} must carry a message`);
		return envelope.error.code;
	});
	assert.deepEqual(codes.sort(), [...names].sort());
});

test("the mirrored openapi spec declares the frozen endpoint set", () => {
	const spec = parseYaml(readFileSync(join(mirror, "openapi.yaml"), "utf8")) as { paths: Record<string, unknown> };
		assert.deepEqual(new Set(Object.keys(spec.paths)), new Set([
			"/healthz",
			"/v1/admin/catalog/{entry_id}/activate",
			"/v1/admin/catalog/{entry_id}/retract",
			"/v1/admin/catalog/import",
			"/v1/admin/activity",
			"/v1/admin/devices/{device_id}/disable",
			"/v1/admin/experience-exports",
			"/v1/admin/experience-exports/{export_id}/feature",
			"/v1/admin/experience-exports/{export_id}/moderate",
			"/v1/compare/hardware",
			"/v1/compare/model",
			"/v1/device",
			"/v1/device/claim",
			"/v1/device/disconnect",
			"/v1/discovery/cases",
			"/v1/discovery/cases/{case_id}",
			"/v1/discovery/cases/{case_id}/appeal",
			"/v1/discovery/cases/{case_id}/report",
			"/v1/discovery/cases/{case_id}/reproduction-intent",
			"/v1/discovery/facets",
			"/v1/experience-exports/{export_id}",
			"/v1/experience-exports/{export_id}/delete",
			"/v1/experience-exports/{export_id}/publication",
			"/v1/experience-exports/{export_id}/retract",
			"/v1/me",
			"/v1/me/activity",
			"/v1/me/data-delete",
			"/v1/me/data-export",
			"/v1/me/devices",
			"/v1/me/experience-exports",
			"/v1/me/experience-exports/{export_id}",
			"/v1/profiles/{handle}",
			"/v1/rankings",
			"/v1/rankings/cohorts",
			"/v1/recommendations/query",
		]));
});

test("phase 3 fixtures satisfy the announced contract types", () => {
	const me = readFixture<components["schemas"]["ProfileV1"]>("account/me-profile.json");
	assert.equal(me.visibility, "private");
	assert.equal(me.locale, "zh-CN");

	const publicProfile = readFixture<components["schemas"]["PublicProfileV1"]>("account/public-profile.json");
	assert.equal(publicProfile.handle, "tune-owner-01");

	const activity = readFixture<components["schemas"]["ActivityPageV1"]>("account/activity-page.json");
	assert.equal(activity.items.length, 1);

	const devices = readFixture<components["schemas"]["DeviceSummaryPageV1"]>("account/devices-page.json");
	assert.equal(devices.total, 1);
	assert.ok(!("installation_id_hash" in devices.items[0]), "device summary must not leak installation hashes");

	const exports = readFixture<components["schemas"]["ExperienceExportPageV1"]>("account/experience-export-page.json");
	assert.equal(exports.items[0].publication_status, "pending_review");
	assert.equal(exports.items[0].transport_status, "received");

	const deleteRequest = readFixture<components["schemas"]["DataDeleteRequestV1"]>("account/data-delete-request.json");
	assert.equal(deleteRequest.scope, "cloud_data");
	assert.equal(deleteRequest.confirmed, true);

	const bundle = readFixture<components["schemas"]["DataExportBundleV1"]>("account/data-export-bundle.json");
	assert.equal(bundle.profile.handle, "tune-owner-01");
	assert.equal(bundle.experience_exports.length, 1);

	const publication = readFixture<components["schemas"]["PublicationRequestV1"]>("publication/publication-request.json");
	assert.equal(publication.visibility_scope, "public");
	assert.equal(publication.consent_version, "publication-v1");
	assert.ok(publication.consent_fields.length >= 6, "public publication needs the six fixed summaries");

	const publicationState = readFixture<components["schemas"]["ExperienceExportStateV1"]>("publication/publication-state.json");
	assert.equal(publicationState.publication_status, "pending_review");

		const theCase = readFixture<components["schemas"]["DiscoveryCaseV2"]>("discovery/case.json");
	assert.equal(theCase.evidence_level, "local_measured");
	assert.equal(theCase.author.author_display, "nickname");

	const intent = readFixture<components["schemas"]["ReproductionIntentV1"]>("discovery/reproduction-intent.json");
	assert.equal(intent.schema_version, "reproduction-intent-v1");
	assert.ok(intent.expires_at > intent.issued_at, "intent must expire after it is issued");
	assert.ok(intent.source_url, "intent must carry the canonical case URL");
});

test("SHA256SUMS manifest matches every mirrored fixture byte", () => {
	const lines = readFileSync(join(mirror, "SHA256SUMS"), "utf8").trim().split("\n").filter(Boolean);
	const seen = new Set<string>();
	for (const line of lines) {
		const sep = line.indexOf("  ");
		assert.ok(sep > 0, `malformed SHA256SUMS line: ${line}`);
		const [want, rel] = [line.slice(0, sep), line.slice(sep + 2)];
		const file = join(mirror, rel);
		assert.ok(existsSync(file), `SHA256SUMS entry missing file: ${rel}`);
		assert.equal(sha256(readFileSync(file)), want, `hash mismatch for ${rel}`);
		seen.add(rel);
	}
for (const path of walk(join(mirror, "fixtures"))) {
		const rel = relative(mirror, path).split(sep).join("/");
		assert.ok(seen.has(rel), `fixture missing from SHA256SUMS: ${rel}`);
	}
});

	function walk(dir: string): string[] {
		const entries: string[] = [];
		for (const name of readdirSync(dir).sort()) {
			const path = join(dir, name);
			if (statSync(path).isDirectory()) entries.push(...walk(path));
			else entries.push(path);
		}
		return entries;
	}

	type QueryRecommendationsBody = NonNullable<
		operations["queryRecommendations"]["requestBody"]
	>["content"]["application/json"];

		test("path-level query types are the v2 envelope", () => {
			const spec = parseYaml(readFileSync(join(mirror, "openapi.yaml"), "utf8")) as {
				paths: Record<string, any>;
				components: { schemas: Record<string, any> };
			};
			const requestSchema = spec.paths["/v1/recommendations/query"].post.requestBody.content["application/json"].schema;
			const responseSchema = spec.paths["/v1/recommendations/query"].post.responses["200"].content["application/json"].schema;
			assert.equal(requestSchema.$ref, "#/components/schemas/RecommendationQueryEnvelopeV2");
			assert.equal(responseSchema.$ref, "#/components/schemas/RecommendationQueryResponseV2");
			assert.equal(spec.components.schemas.RecommendationQueryEnvelopeV2.additionalProperties, false);
			assert.equal(spec.components.schemas.RecommendationQueryResponseV2.additionalProperties, false);
			assert.deepEqual(spec.components.schemas.RecommendationQueryEnvelopeV2.properties.schema_version.enum, ["recommendation-v2"]);
			assert.equal(spec.components.schemas.RecommendationQueryWire, undefined);
			assert.equal(spec.components.schemas.RecommendationQueryEnvelope, undefined);
		assert.equal(spec.components.schemas.CatalogEntryDraft.additionalProperties, false);
		for (const field of ["min_vram_gib", "gpu_products", "aisim_hardware", "coverage", "knowledge_pack_id"]) {
			assert.ok(spec.components.schemas.CatalogEntryDraft.properties[field], `CatalogEntryDraft missing ${field}`);
		}

		const shortlist = readFixture<QueryRecommendationsBody>("recommendation/v2-query-shortlist.json");
		assert.equal(shortlist.schema_version, "recommendation-v2");
		const search = readFixture<components["schemas"]["RecommendationQueryResponseV2"]>("recommendation/v2-response-search.json");
		assert.deepEqual(search.measurement_basis, ["catalog", "simulated"]);
		assert.equal(search.candidates.length, 2);
		assert.notEqual(search.candidates[0].candidate_id, search.candidates[0].source.entry_id);
		assert.notEqual(search.candidates[1].candidate_id, search.candidates[1].source.entry_id);
		assert.notEqual(search.candidates[0].candidate_id, search.candidates[1].candidate_id);
		const coverage = readFixture<components["schemas"]["RecommendationQueryResponseV2"]>("recommendation/v2-response-coverage.json");
		assert.equal(coverage.candidates[0].source.kind, "coverage");
		assert.equal(coverage.candidates[0].serving_config, undefined);
		const draft = readFixture<components["schemas"]["CatalogEntryDraft"]>("catalog/entry-draft-min-vram.json");
		assert.equal(draft.min_vram_gib, 40);
		assert.equal(draft.coverage, "silicon");
	});