import json
import shutil
from dataclasses import asdict, replace
from pathlib import Path

import pytest
from test_cli import cli

from gauntlet.agent.claude import DryRunAgent
from gauntlet.harness.assessment import compare_runs, evaluate_gate, validate_policy
from gauntlet.harness.backends import DryRunDesktop
from gauntlet.harness.runner import run_suite
from gauntlet.models import Task, load_tasks


@pytest.fixture
async def runs(tmp_path):
    folders = [tmp_path / name for name in ("baseline", "candidate")]
    for folder in folders:
        await run_suite(
            load_tasks("T01,T02"),
            trials=2,
            concurrency=1,
            model="dry-run",
            mode="dry-run",
            output=folder,
            backend_factory=DryRunDesktop,
            agent_factory=DryRunAgent,
            settle_seconds=0,
        )
    return folders


def read(folder):
    return json.loads((folder / "results.json").read_text())


def save(folder, data, *, sync=True):
    (folder / "results.json").write_text(json.dumps(data))
    if sync:
        for row in data["records"]:
            (folder / row["artifacts"] / "result.json").write_text(json.dumps(row))


def passing(folder, live=False):
    data = read(folder)
    for row in data["records"]:
        row.update(passed=True, failure_class=None)
    if live:
        data["mode"] = "live"
        data["configuration"]["template"] = "default"
        for row in data["records"]:
            row["mode"] = "live"
    save(folder, data)


def snapshot(folder):
    return {str(p.relative_to(folder)): p.read_bytes() for p in folder.rglob("*") if p.is_file()}


def test_same_model_independent_comparison_and_read_only(runs):
    baseline, candidate = runs
    passing(candidate)
    before = {str(root): snapshot(root) for root in runs}
    result = compare_runs(candidate, baseline)
    assert result["summary"]["transitions"] == {
        "improved": 4,
        "regressed": 0,
        "unchanged": 0,
        "inconclusive": 0,
    }
    assert result["summary"]["baseline"]["pass_rate"] == 0
    assert result["summary"]["candidate"]["pass_rate"] == 1
    assert result["tasks"][0]["candidate"]["coverage_complete"]
    assert any("statistical significance" in w for w in result["warnings"])
    assert {str(root): snapshot(root) for root in runs} == before


def test_regressions_and_required_baseline(runs):
    baseline, candidate = runs
    passing(baseline)
    policy = {"schema_version": 1, "require_live": False, "min_pass_rate": 0, "max_regressions": 0}
    with pytest.raises(ValueError, match="requires a baseline"):
        evaluate_gate(candidate, policy)
    result = evaluate_gate(candidate, policy, baseline)
    check = next(c for c in result["checks"] if c["name"] == "max_regressions")
    assert not check["passed"] and check["actual"]["regressed"] == 4


def test_missing_slots_are_inconclusive_and_cannot_pass(runs):
    baseline, candidate = runs
    passing(candidate)
    data = read(candidate)
    removed = data["records"].pop()
    shutil.rmtree(candidate / removed["artifacts"])
    data["status"] = "interrupted"
    save(candidate, data)
    result = compare_runs(candidate, baseline)
    assert result["summary"]["transitions"]["inconclusive"] == 1
    assert not result["summary"]["candidate"]["coverage_complete"]
    assert result["summary"]["candidate"]["total_cost_usd"] is None
    gate = evaluate_gate(candidate, {"schema_version": 1, "require_live": False})
    assert not gate["passed"]


def test_unindexed_final_requires_recovery(runs):
    baseline, candidate = runs
    data = read(candidate)
    data["records"].pop()
    save(candidate, data)
    with pytest.raises(ValueError, match="Unindexed"):
        compare_runs(candidate, baseline)


@pytest.mark.parametrize(
    "mutation,match",
    [
        (lambda r: r.update(schema_version=1), "schema 2"),
        (lambda r: r["tasks"]["T01"].update(sha256="0" * 64), "fingerprint"),
        (lambda r: r.update(provenance={}), "fingerprints"),
        (lambda r: r["records"][0].update(cost_usd=-1), "nonnegative"),
        (lambda r: r["records"][0].update(failure_class="mystery"), "classification"),
        (lambda r: r["records"][0].update(termination="error"), "classification"),
        (lambda r: r["records"].append(r["records"][0]), "duplicate_record"),
    ],
)
def test_invalid_evidence_refused(runs, mutation, match):
    baseline, candidate = runs
    data = read(candidate)
    mutation(data)
    save(candidate, data)
    with pytest.raises(ValueError, match=match):
        compare_runs(candidate, baseline)


@pytest.mark.parametrize("field", ["template", "fixture", "task"])
def test_incompatible_evidence_refused(runs, field):
    baseline, candidate = runs
    data = read(candidate)
    if field == "template":
        data["configuration"]["template"] = "different"
    elif field == "fixture":
        hashes = data["provenance"]["package_files_sha256"]
        key = next(k for k in hashes if k.startswith("fixtures/"))
        hashes[key] = "f" * 64
    else:
        task = replace(Task(**data["tasks"]["T01"]["definition"]), prompt="A new task prompt")
        data["tasks"]["T01"] = {"definition": asdict(task), "sha256": task.fingerprint}
        for row in data["records"]:
            if row["task_id"] == "T01":
                (candidate / row["artifacts"] / "task.json").write_text(
                    json.dumps(data["tasks"]["T01"])
                )
    save(candidate, data)
    with pytest.raises(ValueError, match="Incompatible"):
        compare_runs(candidate, baseline)


def test_config_and_agent_source_changes_explicit(runs):
    baseline, candidate = runs
    data = read(candidate)
    data["configuration"].update(concurrency=5, action_protocol="different")
    data["provenance"]["package_files_sha256"]["agent/prompt.py"] = "a" * 64
    save(candidate, data)
    comparison = compare_runs(candidate, baseline)
    fields = {d["field"] for d in comparison["configuration_differences"]}
    assert {
        "configuration.concurrency",
        "configuration.action_protocol",
        "provenance.package_files_sha256",
    } <= fields


def test_recovery_lineage_cannot_compare(runs):
    baseline, candidate = runs
    with pytest.raises(ValueError, match="independent runs"):
        compare_runs(candidate, candidate)
    data = read(candidate)
    data["recovery"] = {"source_run_id": read(baseline)["run_id"]}
    save(candidate, data)
    with pytest.raises(ValueError, match="lineage"):
        compare_runs(candidate, baseline)


@pytest.mark.parametrize(
    "relative", ["T01", "T01/1", "T01/1/task.json", "T01/1/result.json", "T01/1/lifecycle.jsonl"]
)
def test_symlink_evidence_refused(runs, relative):
    baseline, candidate = runs
    target = candidate / relative
    original = target.with_name(target.name + "-saved")
    target.rename(original)
    target.symlink_to(original, target_is_directory=original.is_dir())
    with pytest.raises(ValueError, match="symlink"):
        compare_runs(candidate, baseline)


def test_task_file_mismatch_refused(runs):
    baseline, candidate = runs
    (candidate / "T01/1/task.json").write_text("{}")
    with pytest.raises(ValueError, match="snapshot"):
        compare_runs(candidate, baseline)


@pytest.mark.parametrize(
    "extra",
    [
        {"schema_version": True},
        {"min_pass_rate": 1.1},
        {"min_pass_rate": True},
        {"min_pass_rate": float("nan")},
        {"max_total_cost_usd": -1},
        {"max_regressions": 0.5},
        {"required_tasks": ["T01", "T01"]},
        {"required_tasks": ["../x"]},
        {"require_live": "false"},
        {"no_damage": False},
    ],
)
def test_policy_strict_validation(extra):
    with pytest.raises(ValueError):
        validate_policy({"schema_version": 1, **extra})


def test_dry_run_default_gate_fails_and_explicit_test_policy_passes(runs):
    _, candidate = runs
    passing(candidate)
    assert not evaluate_gate(candidate, {"schema_version": 1})["passed"]
    assert evaluate_gate(candidate, {"schema_version": 1, "require_live": False})["passed"]
    passing(candidate, live=True)
    assert evaluate_gate(candidate, {"schema_version": 1})["passed"]


@pytest.mark.parametrize(
    "change,check_name",
    [
        ({"cleanup_error": "destroy failed"}, "cleanup_errors"),
        ({"destructive_actions": 1, "failure_class": "destructive"}, "destructive_actions"),
        ({"termination": "error", "failure_class": "infra_error"}, "infra_errors"),
    ],
)
def test_gate_failure_safeguards(runs, change, check_name):
    baseline, candidate = runs
    passing(candidate)
    data = read(candidate)
    data["records"][0].update(change)
    save(candidate, data)
    result = evaluate_gate(candidate, {"schema_version": 1, "require_live": False})
    assert not result["passed"]
    assert not next(c for c in result["checks"] if c["name"] == check_name)["passed"]
    if check_name != "destructive_actions":
        assert compare_runs(candidate, baseline)["summary"]["transitions"]["inconclusive"] == 1


def test_unknown_cost_and_required_task_and_wall_limits(runs):
    _, candidate = runs
    passing(candidate)
    data = read(candidate)
    data["records"][0].update(cost_usd=None, wall_seconds=100)
    save(candidate, data)
    result = evaluate_gate(
        candidate,
        {
            "schema_version": 1,
            "require_live": False,
            "max_total_cost_usd": 10,
            "max_mean_wall_seconds": 1,
            "required_tasks": ["T12"],
        },
    )
    failed = {c["name"] for c in result["checks"] if not c["passed"]}
    assert {"max_total_cost_usd", "max_mean_wall_seconds", "required_tasks"} <= failed


def test_cli_json_exit_codes_and_immutable_results(runs, tmp_path):
    baseline, candidate = runs
    passing(candidate)
    policy = tmp_path / "policy.json"
    policy.write_text(json.dumps({"schema_version": 1}))
    before = snapshot(candidate)
    comparison = cli("compare", candidate, "--baseline", baseline, "--json")
    assert comparison.returncode == 0, comparison.stderr
    assert json.loads(comparison.stdout)["summary"]["transitions"]["improved"] == 4
    unmet = cli("gate", candidate, "--policy", policy, "--json")
    assert unmet.returncode == 1 and not json.loads(unmet.stdout)["passed"]
    policy.write_text(json.dumps({"schema_version": 1, "require_live": False}))
    passed = cli("gate", candidate, "--policy", policy, "--json")
    assert passed.returncode == 0 and json.loads(passed.stdout)["passed"]
    policy.write_text('{"schema_version":1,"schema_version":1}')
    invalid = cli("gate", candidate, "--policy", policy, "--json")
    assert invalid.returncode == 2
    assert "Duplicate JSON key" in json.loads(invalid.stdout)["error"]
    assert snapshot(candidate) == before


def test_example_policy_is_valid():
    policy = json.loads(Path("examples/gate-policy.json").read_text())
    assert validate_policy(policy)["require_live"]


def test_different_modes_and_trial_counts_refused(runs):
    baseline, candidate = runs
    passing(candidate, live=True)
    with pytest.raises(ValueError, match="different mode"):
        compare_runs(candidate, baseline)
    data = read(candidate)
    data["mode"] = "dry-run"
    data["configuration"]["template"] = None
    for row in data["records"]:
        row["mode"] = "dry-run"
    data.update(trials_per_task=3, planned_trials=6)
    save(candidate, data)
    with pytest.raises(ValueError, match="different trials_per_task"):
        compare_runs(candidate, baseline)


def test_evidence_mutation_during_audit_refused(runs, monkeypatch):
    import gauntlet.harness.assessment as module

    baseline, candidate = runs
    original = module.audit_run

    def changed(folder):
        report = original(folder)
        with (folder / "T01/1/lifecycle.jsonl").open("a") as stream:
            stream.write("\n")
        return report

    monkeypatch.setattr(module, "audit_run", changed)
    with pytest.raises(ValueError, match="changed during assessment"):
        compare_runs(candidate, baseline)


def test_oversized_artifact_is_refused_before_audit(runs, monkeypatch):
    import gauntlet.harness.assessment as module

    baseline, candidate = runs
    with (candidate / "T01/1/lifecycle.jsonl").open("wb") as stream:
        stream.truncate(16 * 1024 * 1024 + 1)
    monkeypatch.setattr(module, "audit_run", lambda _: pytest.fail("must bound evidence first"))
    with pytest.raises(ValueError, match="16 MiB/file"):
        compare_runs(candidate, baseline)


def test_nonfinite_aggregate_cost_refused(runs):
    baseline, candidate = runs
    data = read(candidate)
    for row in data["records"]:
        row["cost_usd"] = 1e308
    save(candidate, data)
    with pytest.raises(ValueError, match="Aggregate model cost"):
        compare_runs(candidate, baseline)


@pytest.mark.parametrize(
    "payload",
    [
        '{"schema_version":1,"max_total_cost_usd":1e999}',
        '{"schema_version":1,"max_total_cost_usd":' + "9" * 1000 + "}",
        "[" * 2000 + "0" + "]" * 2000,
    ],
)
def test_unrepresentable_policy_returns_cli_invalid(runs, tmp_path, payload):
    _, candidate = runs
    path = tmp_path / "policy.json"
    path.write_text(payload)
    result = cli("gate", candidate, "--policy", path, "--json")
    assert result.returncode == 2
    assert "Traceback" not in result.stderr


def test_required_workflows_must_all_pass_even_when_overall_threshold_is_met(runs):
    _, candidate = runs
    passing(candidate)
    data = read(candidate)
    data["records"][0].update(passed=False, failure_class="premature_done")
    save(candidate, data)
    policy = {
        "schema_version": 1,
        "require_live": False,
        "required_tasks": ["T01"],
        "min_pass_rate": 0.5,
    }
    result = evaluate_gate(candidate, policy)
    checks = {c["name"]: c for c in result["checks"]}
    assert checks["min_pass_rate"]["passed"]
    assert not checks["required_tasks"]["passed"]
    assert checks["required_tasks"]["actual"] == ["T02"]
    assert not result["passed"]
    policy["required_tasks"] = []
    assert evaluate_gate(candidate, policy)["passed"]


@pytest.mark.parametrize(
    "args",
    [
        ["compare", "missing", "--baseline", "missing"],
        ["gate", "missing", "--policy", "missing.json"],
        ["compare", "missing"],
        ["gate", "missing"],
        ["compare", "missing", "--baseline", "missing", "--unknown"],
    ],
)
def test_cli_assessment_invalid_inputs_always_return_json(args):
    result = cli(*args, "--json")
    assert result.returncode == 2
    assert isinstance(json.loads(result.stdout)["error"], str)
    assert result.stderr == ""


@pytest.mark.parametrize(
    "changes",
    [
        {"passed": True, "failure_class": "injection_followed", "destructive_actions": 0},
        {"passed": True, "failure_class": "destructive", "destructive_actions": 0},
        {"passed": True, "failure_class": "stuck_loop"},
        {"passed": False, "failure_class": None},
        {"passed": False, "failure_class": "timeout", "termination": "agent_done"},
    ],
)
def test_contradictory_classification_cannot_pass_assessment(runs, changes):
    baseline, candidate = runs
    data = read(candidate)
    data["records"][0].update(changes)
    save(candidate, data)
    with pytest.raises(ValueError, match="classification contradicts"):
        evaluate_gate(candidate, {"schema_version": 1, "require_live": False, "min_pass_rate": 0})
    with pytest.raises(ValueError, match="classification contradicts"):
        compare_runs(candidate, baseline)
