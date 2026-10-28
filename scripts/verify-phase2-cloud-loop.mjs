// Phase 2 closed-loop acceptance driver for a Linux NVIDIA Docker host.
//
// This script does NOT run the loop itself - the loop is driven by the user
// inside the Bittune TUI. It verifies the surrounding prerequisites, records
// deployment identifiers and writes a reproducible acceptance record. It must
// ONLY be run on the real GPU host (never a Windows dev machine; that cannot
// substitute for the acceptance).
//
//   node scripts/verify-phase2-cloud-loop.mjs \
//     --cloud-url https://cloud.example.com \
//     --cloud-api-version v1 \
//     --local-commit <local git commit> \
//     --cloud-commit <bittune-cloud git commit> \
//     --model-revision <pinned revision> \
//     --image-digest <runtime image digest> \
//     --workload-hash <benchmark workload hash>
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const required = ["--cloud-url", "--cloud-api-version", "--local-commit", "--cloud-commit", "--model-revision", "--image-digest", "--workload-hash"];
const args = process.argv.slice(2);
const values = new Map();
for (let index = 0; index < args.length; index += 2) {
	const flag = args[index];
	if (!flag?.startsWith("--")) {
		console.error(`unexpected argument ${flag}`);
		process.exit(2);
	}
	values.set(flag, args[index + 1] ?? "");
}
for (const flag of required) {
	if (!values.get(flag)) {
		console.error(`missing ${flag}`);
		process.exit(2);
	}
}

const failures = [];
function check(name, command, argsList) {
	try {
		execFileSync(command, argsList, { stdio: "pipe", timeout: 30_000 });
		console.log(`[ok]   ${name}`);
	} catch (error) {
		failures.push(name);
		console.log(`[fail] ${name}: ${error?.message ?? error}`);
	}
}
check("nvidia-smi", "nvidia-smi", ["--query-gpu=name,count", "--format=csv,noheader"]);
check("docker daemon", "docker", ["info", "--format", "{{.ServerVersion}}"]);
check("docker nvidia runtime", "docker", ["info", "--format", "{{json .Runtimes}}"]);

const record = {
	accepted_at: new Date().toISOString(),
	platform: process.platform,
	cloud_url: values.get("--cloud-url"),
	cloud_api_version: values.get("--cloud-api-version"),
	local_commit: values.get("--local-commit"),
	cloud_commit: values.get("--cloud-commit"),
	model_revision: values.get("--model-revision"),
	image_digest: values.get("--image-digest"),
	workload_hash: values.get("--workload-hash"),
	closed_loop_checks: [
		"cloud_device(connect) 通过内置 profile 完成设备授权与 claim",
		"cloud_recommend 返回候选并进入 plan_deployment(validate/freeze)",
		"候选缺失依赖时经用户确认 + Policy Bash 准备，Core 复验 revision/digest",
		"deploy -> benchmark -> compare -> write_report 本地闭环完成",
		"cloud_experience(preview/enqueue) 需一次明确确认，send 送达后 Cloud 收到幂等收据",
		"同 ID 同内容重放幂等；撤回后 Cloud 推荐立即排除；Local 报告保留",
		"Cloud 断网时可回退本地方案；local_only 零网络请求；恢复后 pending 可继续发送",
		"重新 recommend 命中本次 success 经验",
	],
};

let localGitStatus = "unavailable";
if (existsSync(".git")) {
	try {
		localGitStatus = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim() || "clean";
	} catch {
		localGitStatus = "unavailable";
	}
}

const outDir = resolve(process.cwd(), "artifacts");
mkdirSync(outDir, { recursive: true });
const fileName = `phase2-acceptance-${Date.now()}.json`;
const outPath = join(outDir, fileName);
record.artifacts = `artifacts/${fileName}`;
record.local_git_status = localGitStatus;
writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`);

console.log("\n请在 TUI 中逐项执行闭环并在下方记录文件里勾选结果：");
console.log(`  ${outPath}\n`);
if (failures.length > 0) {
	console.error(`前置失败：${failures.join(", ")} — 先修复再验收。`);
	process.exit(1);
}
console.log("前置检查通过。执行闭环后把 closed_loop_checks 各项的实际结果与证据路径补进记录文件并提交归档。");