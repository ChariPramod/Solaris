import hashlib
import json
import os
import shutil
import subprocess
import sys

import pytest

from gauntlet.agent.claude import DryRunAgent
from gauntlet.harness import recovery
from gauntlet.harness.backends import DryRunDesktop
from gauntlet.harness.runner import run_suite
from gauntlet.models import load_tasks
from gauntlet.report import build_report


@pytest.fixture
async def source(tmp_path):
    root = tmp_path / "source"
    await run_suite(
        load_tasks("T01,T02"),
        trials=2,
        concurrency=1,
        model="dry-run",
        mode="dry-run",
        output=root,
        backend_factory=DryRunDesktop,
        agent_factory=DryRunAgent,
        settle_seconds=0,
    )
    return root


def manifest(root):
    return json.loads((root / "results.json").read_text())


def save(root, run):
    (root / "results.json").write_text(json.dumps(run))


def files(root):
    return {
        str(path.relative_to(root)): path.read_bytes() for path in root.rglob("*") if path.is_file()
    }


def test_reconciles_unindexed_results_without_mutating_any_source_bytes(source, tmp_path):
    run = manifest(source)
    omitted = run["records"].pop()
    run["status"] = "running"
    save(source, run)
    before = files(source)
    output = tmp_path / "recovered"
    result = recovery.recover_run(source, output)
    assert files(source) == before
    recovered = manifest(output)
    assert recovered["status"] == "recovered"
    assert recovered["run_id"] == run["run_id"]
    assert recovered["provenance"] == run["provenance"]
    assert recovered["tasks"] == run["tasks"]
    assert recovered["records"] == [*run["records"], omitted]
    assert result["audit"]["healthy"]
    assert result["recovery"]["source_status"] == "running"
    assert len(result["recovery"]["added_records"]) == 1
    assert (output / "recovery/source-results.json").read_bytes() == before["results.json"]
    hashes = json.loads((output / "recovery/artifact-hashes.json").read_text())
    for relative, digest in hashes.items():
        assert hashlib.sha256(before[relative]).hexdigest() == digest
        if relative != "results.json":
            assert (output / relative).read_bytes() == before[relative]
    assert "Recovered local snapshot" in (output / "html/index.html").read_text()
    assert "RECOVERED LOCAL SNAPSHOT" in (output / "report.md").read_text()


def test_preserves_empty_started_slots_and_unstarted_slots(source, tmp_path):
    run = manifest(source)
    run["records"] = run["records"][:1]
    run["status"] = "interrupted"
    save(source, run)
    shutil.rmtree(source / "T01/2")
    (source / "T01/2").mkdir()
    shutil.rmtree(source / "T02")
    output = tmp_path / "recovered"
    result = recovery.recover_run(source, output)
    assert result["audit"]["counts"] == {
        "planned": 4,
        "recorded": 1,
        "finalized": 1,
        "unstarted": 2,
        "incomplete": 1,
    }
    assert (output / "T01/2").is_dir()
    assert not (output / "T02").exists()
    metrics = manifest(output)["summary"]["dry-run/dry-run"]
    assert not metrics["cost_coverage"]["complete"]
    assert metrics["cost_per_success_usd"] is None
    page = (output / "html/index.html").read_text()
    assert "Partial run" in page and "cost per success is unavailable" in page


def test_cleanup_uncertainty_and_partial_journal_survive_export(source, tmp_path):
    run = manifest(source)
    run["records"] = run["records"][1:]
    save(source, run)
    (source / "T01/1/result.json").unlink()
    journal = source / "T01/1/lifecycle.jsonl"
    event = {
        "schema_version": 1,
        "run_id": run["run_id"],
        "task_id": "T01",
        "trial": 1,
        "time": "2026-09-20T12:00:00+00:00",
    }
    journal.write_text(
        json.dumps({**event, "event": "create_requested", "attempt": 1})
        + "\n"
        + json.dumps({**event, "event": "allocated", "desktop_id": "review-me"})
        + '\n{"partial'
    )
    output = tmp_path / "recovered"
    result = recovery.recover_run(source, output)
    assert (output / "T01/1/lifecycle.jsonl").read_bytes() == journal.read_bytes()
    assert result["audit"]["cleanup_candidates"][0]["desktop_id"] == "review-me"
    assert "partial_journal" in {item["code"] for item in result["audit"]["findings"]}


@pytest.mark.parametrize("kind", ["conflict", "duplicate", "cost", "task", "trial_task"])
def test_conflicting_or_invalid_evidence_is_not_recovered(source, tmp_path, kind):
    run = manifest(source)
    if kind == "conflict":
        run["records"][0]["steps"] += 1
    elif kind == "duplicate":
        run["records"].append(run["records"][0])
    elif kind == "task":
        run["tasks"]["T01"]["sha256"] = "wrong"
    elif kind == "trial_task":
        (source / "T01/1/task.json").write_text("{}")
    else:
        run["records"][0]["cost_usd"] = float("nan")
        (source / "T01/1/result.json").write_text(json.dumps(run["records"][0]))
    save(source, run)
    output = tmp_path / "recovered"
    with pytest.raises(ValueError):
        recovery.recover_run(source, output)
    assert not output.exists()
    assert not list(tmp_path.glob(".gauntlet-recovery-*"))


@pytest.mark.parametrize("kind", ["symlink", "fifo", "directory"])
def test_unsupported_artifacts_never_copied(source, tmp_path, kind):
    artifact = source / "T01/1/unexpected"
    if kind == "symlink":
        artifact.symlink_to(source / "T02/1/001.jpg")
    elif kind == "fifo":
        os.mkfifo(artifact)
    else:
        artifact.mkdir()
    with pytest.raises(ValueError):
        recovery.recover_run(source, tmp_path / "recovered")


@pytest.mark.parametrize("mutation", ["change", "add", "remove"])
def test_source_mutation_aborts_publication(source, tmp_path, monkeypatch, mutation):
    original = recovery.build_report

    def mutate(stage):
        result = original(stage)
        artifact = source / "T01/1/001.jpg"
        if mutation == "change":
            artifact.write_bytes(b"changed")
        elif mutation == "remove":
            artifact.unlink()
        else:
            (source / "T01/1/new.txt").write_text("new")
        return result

    monkeypatch.setattr(recovery, "build_report", mutate)
    output = tmp_path / "recovered"
    with pytest.raises(ValueError, match="changed"):
        recovery.recover_run(source, output)
    assert not output.exists()


def test_existing_and_nested_destinations_are_rejected(source, tmp_path):
    existing = tmp_path / "existing"
    existing.mkdir()
    for output in (source, source / "nested", existing):
        with pytest.raises(ValueError):
            recovery.recover_run(source, output)
    alias = tmp_path / "alias"
    alias.symlink_to(source, target_is_directory=True)
    with pytest.raises(ValueError):
        recovery.recover_run(source, alias / "nested")


def test_zero_finalized_results_export_without_inventing_outcomes(source, tmp_path):
    run = manifest(source)
    run["records"] = []
    save(source, run)
    for path in source.glob("T*/[0-9]*/result.json"):
        path.unlink()
    output = tmp_path / "recovered"
    result = recovery.recover_run(source, output)
    assert result["audit"]["counts"]["incomplete"] == 4
    assert manifest(output)["records"] == []
    assert manifest(output)["summary"] == {}
    assert "No trial results" in (output / "html/index.html").read_text()


def test_incomplete_trial_with_conflicting_task_is_rejected(source, tmp_path):
    run = manifest(source)
    run["records"] = run["records"][1:]
    save(source, run)
    (source / "T01/1/result.json").unlink()
    (source / "T01/1/task.json").write_text("{}")
    with pytest.raises(ValueError, match="saved task snapshot"):
        recovery.recover_run(source, tmp_path / "recovered")


def test_destination_created_during_export_is_preserved(source, tmp_path, monkeypatch):
    output = tmp_path / "recovered"
    original = recovery.build_report

    def race(stage):
        original(stage)
        output.mkdir()
        (output / "user.txt").write_text("keep this")

    monkeypatch.setattr(recovery, "build_report", race)
    with pytest.raises(FileExistsError):
        recovery.recover_run(source, output)
    assert (output / "user.txt").read_text() == "keep this"
    assert len(list(output.iterdir())) == 1


def test_recovery_respects_total_size_limit(source, tmp_path, monkeypatch):
    monkeypatch.setattr(recovery, "MAX_TOTAL_BYTES", 10)
    with pytest.raises(ValueError, match="limits exceeded"):
        recovery.recover_run(source, tmp_path / "recovered")


def test_cli_exit_codes_distinguish_export_with_remaining_findings(source, tmp_path):
    run = manifest(source)
    run["records"].pop()
    save(source, run)
    (source / "T02/2/result.json").unlink()
    output = tmp_path / "recovered"
    completed = subprocess.run(
        [sys.executable, "-m", "gauntlet", "recover", str(source), "--out", str(output), "--json"],
        capture_output=True,
        text=True,
    )
    assert completed.returncode == 1, completed.stderr
    assert json.loads(completed.stdout)["audit"]["counts"]["incomplete"] == 1
    assert (output / "html/index.html").exists()
    with pytest.raises(ValueError, match="original schema 2"):
        recovery.recover_run(output, tmp_path / "again")


def test_comparison_labels_recovery_even_when_second_source(source, tmp_path):
    recovered = tmp_path / "recovered"
    recovery.recover_run(source, recovered)
    other = tmp_path / "other"
    shutil.copytree(source, other)
    run = manifest(other)
    run["model"] = "another-static-agent"
    for record in run["records"]:
        record["model"] = run["model"]
    save(other, run)
    build_report(other, comparisons=[recovered])
    page = (other / "html/index.html").read_text()
    assert "Includes recovered local snapshots" in page
    assert manifest(recovered)["recovery"]["source_manifest_sha256"] in page
