"""Phase 8 section 8. One script, no GPU, no new framework.

Structural sentences read the files. Behavioral sentences run the existing
cases. A failure names the sentence.
"""

import io
import re
import subprocess
import sys
import unittest
from pathlib import Path

TESTS_ROOT = Path(__file__).resolve().parent
REPO = TESTS_ROOT.parents[2]
sys.path.insert(0, str(TESTS_ROOT.parent / "src"))
sys.path.insert(0, str(TESTS_ROOT))

PAYLOAD_KEYS = (
    "intent",
    "environment",
    "target",
    "models",
    "scenario",
    "workload",
    "workload_buckets",
    "sla",
    "layout",
    "constraints",
)


def _text(path: str) -> str:
    return (REPO / path).read_text(encoding="utf-8")


def _string_list(source: str, const: str) -> list[str]:
    match = re.search(rf"export const {const} = \[([\s\S]*?)\] as const;", source)
    if not match:
        raise AssertionError(const)
    return re.findall(r'"([^"]+)"', match.group(1))


def _payload_keys(source: str) -> list[str]:
    start = source.index("    RecommendationQueryPayloadV2:\n")
    rest = source[start:]
    end = rest.index("\n    ServingSearchIntent:")
    block = rest[:end]
    body = block[block.index("      properties:\n"):]
    return re.findall(r"\n        ([A-Za-z_]+):\n", body)


def _run(names: list[str]) -> None:
    suite = unittest.TestSuite(unittest.TestLoader().loadTestsFromName(name) for name in names)
    stream = io.StringIO()
    result = unittest.TextTestRunner(stream=stream, verbosity=1).run(suite)
    if result.wasSuccessful():
        return
    details = [f"{test.id()}\n{trace}" for test, trace in result.failures + result.errors]
    raise AssertionError("\n".join(details))


def _node(pattern: str, files: list[str], minimum: int) -> None:
    completed = subprocess.run(
        [
            "node",
            "--disable-warning=ExperimentalWarning",
            "--import",
            "tsx",
            "--test",
            "--test-reporter=tap",
            "--test-name-pattern",
            pattern,
            *files,
        ],
        cwd=REPO,
        capture_output=True,
        text=True,
        check=False,
        timeout=120,
    )
    output = completed.stdout + completed.stderr
    if completed.returncode != 0:
        raise AssertionError(output)
    passed = re.search(r"# pass (\d+)", output)
    if not passed or int(passed.group(1)) < minimum:
        raise AssertionError(output)


class Phase8Section8Test(unittest.TestCase):
    def test_01_tool_names_match_phase7(self) -> None:
        managed = "packages/bittune-runtime/src/harness/managed-tools.ts"
        cloud = "packages/bittune-runtime/src/harness/cloud-tools.ts"
        self.assertEqual(_string_list(_text(managed), "MANAGED_TOOL_NAMES"), ["inspect_environment", "inspect_service", "plan_deployment", "deploy_service", "benchmark_service", "benchmark_suite", "export_deliverable", "compare_results", "write_report", "inspect_records"])
        self.assertEqual(_string_list(_text(cloud), "CLOUD_TOOL_NAMES"), ["cloud_device", "cloud_recommend", "cloud_experience"])

    def test_02_openapi_payload_has_no_new_field(self) -> None:
        path = "contracts/cloud/openapi.yaml"
        self.assertEqual(_payload_keys(_text(path)), list(PAYLOAD_KEYS))

    def test_03_named_environment_is_not_the_local_snapshot(self) -> None:
        _run(["test_cloud.PrepareRecommendationTests.test_prepare_declared_hopper_does_not_read_snapshot"])

    def test_04_lookup_key_vram_floor_and_family_name(self) -> None:
        _run([
            "test_cloud.PrepareRecommendationTests.test_prepare_bound_lookup_key_and_vram_floor",
            "test_cloud.PrepareRecommendationTests.test_prepare_declared_product_is_lookup_key_or_omitted",
        ])

    def test_05_empty_and_local_only_are_not_a_deploy_step(self) -> None:
        source = _text("packages/bittune-runtime/src/harness/cloud-tools.ts")
        for sentence in (
            "本地模式，未发起 Cloud 请求（local_only 不调用 Cloud Bridge、不生成推荐查询）。",
            "Cloud 返回空候选（${reason}）。已按送出的环境查询目录，没有候选。${assumptionText}",
        ):
            self.assertIn(sentence, source)
            self.assertNotRegex(sentence, r"plan_deployment|转入本地方案|创建部署计划")
        copy = _text("packages/bittune-runtime/src/harness/tui/copy.ts")
        self.assertIn("这两次不能比较，没有百分比。", copy)
        self.assertNotRegex("这两次不能比较，没有百分比。", r"plan_deployment|转入本地方案|创建部署计划")
        _node(
            "local_only mode returns the explicit local result|empty candidates stay a catalog miss",
            ["tests/cloud-bridge.test.ts"],
            2,
        )

    def test_06_loopback_is_stored_unclaimable_and_non_loopback_cannot_run(self) -> None:
        _run([
            "test_declared_measure.DeclaredMeasureTests.test_declared_benchmark_omits_service_and_is_not_claimable",
            "test_declared_measure.DeclaredMeasureTests.test_bad_subject_creates_no_service",
            "test_declared_measure.DeclaredMeasureTests.test_old_database_accepts_null_service_id",
        ])

    def test_07_report_and_experience_export_reject_declared(self) -> None:
        _run(["test_declared_measure.DeclaredMeasureTests.test_claims_reject_declared_benchmark"])

    def test_08_same_fingerprint_different_snapshot_rows_can_be_signed(self) -> None:
        _run(["test_fingerprint_compare.FingerprintCompareTest.test_same_card_different_snapshot_row_is_claimable"])

    def test_09_different_fingerprints_have_no_percentage(self) -> None:
        _run(["test_fingerprint_compare.FingerprintCompareTest.test_any_fingerprint_field_blocks_a_percentage"])

    def test_10_named_model_can_plan_without_cloud_and_a_cloud_claim_needs_a_record(self) -> None:
        _run([
            "test_plans.PlanContractTest.test_user_specified_create_needs_no_recommendation",
            "test_plans.PlanContractTest.test_cloud_prior_requires_a_recorded_attempt",
            "test_plans.PlanContractTest.test_based_on_plan_copies_into_a_new_draft",
        ])
        _node(
            "create does not ask whether this session recommended",
            ["tests/managed-tools-gate.test.ts"],
            1,
        )

    def test_11_chat_text_cannot_open_the_reproduction_prior(self) -> None:
        _run(["test_plans.PlanContractTest.test_reproduction_prior_requires_the_runtime_flag"])
        _node(
            "ordinary session initialMessage containing",
            ["tests/managed-tools-gate.test.ts"],
            1,
        )

    def test_12_untracked_container_does_not_enter_the_service_table(self) -> None:
        _run([
            "test_services_fake_docker.FakeDockerServiceLifecycleTest.test_list_untracked_does_not_insert_a_service",
            "test_services_fake_docker.FakeDockerServiceLifecycleTest.test_stop_untracked_container_id_does_not_stop_it",
        ])

    def test_13_prompt_tools_and_skill_no_longer_prescribe_the_deleted_flow(self) -> None:
        prompt = _text("packages/bittune-runtime/src/harness/system-prompt.ts")
        self.assertIn("<!-- bittune-system-prompt:v12 -->", prompt)
        for gone in (
            "ask Cloud for a shortlist or layout before creating",
            "Sweep numbers appear only through report references",
            "continue with a local plan",
        ):
            self.assertNotIn(gone, prompt)
        skill = _text("packages/bittune-runtime/skills/benchmark-suite/SKILL.md")
        self.assertTrue(skill.startswith("---\nname: benchmark-suite\ndescription: 验收受管服务或本机回环端点\n---\n"))
        for gone in ("验收已部署的本机推理服务", "回到部署", "不要给用户一个地址", "数字只通过报告引用出现", "不接受地址"):
            self.assertNotIn(gone, skill)
        tools = _text("packages/bittune-runtime/src/harness/managed-tools.ts")
        self.assertIn("回环结果不能称为 BitTune 实测", tools)
        self.assertNotIn("不接受地址", tools)
        _node("不再把缺口写成下一步", ["tests/harness-runtime.test.ts"], 1)

    def test_14_readme_and_operations_match_the_behavior(self) -> None:
        readme = _text("README.md")
        self.assertIn("10 个受管工具", readme)
        self.assertNotIn("8 个受管工具", readme)
        guide = _text("guide/README.md")
        self.assertIn("新建一份部署草稿", guide)
        self.assertIn("bound", guide)
        self.assertIn("指纹", guide)
        self.assertNotIn("参数调优", guide)
        operations = _text("guide/operations.md")
        self.assertIn("未跟踪", operations)
        self.assertNotIn("ownership=observed", operations)
        self.assertIn("不写入服务事实", operations)

    def test_15_public_roadmap_keeps_real_gpu_regression_in_progress(self) -> None:
        roadmap = _text("ROADMAP.md")
        active = roadmap.split("## 🚧 进行中", 1)[1].split("## 📋 P1", 1)[0]
        self.assertIn("真实 GPU 环境", active)
        self.assertIn("回归验证", active)
