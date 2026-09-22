import json
import subprocess
import sys


def cli(*args):
    return subprocess.run(
        [sys.executable, "-m", "gauntlet", *map(str, args)],
        capture_output=True,
        text=True,
        timeout=20,
    )


def test_preflight_json_has_no_side_effects_and_aggregates_blockers(tmp_path, monkeypatch):
    monkeypatch.delenv("SOLARI_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("GAUNTLET_OPENAI_MODEL", raising=False)
    output = tmp_path / "never-created"
    check = cli("preflight", "--model", "openai", "--tasks", "T02", "--out", output, "--json")
    assert check.returncode == 1, check.stderr
    report = json.loads(check.stdout)
    failed = {row["name"] for row in report["checks"] if row["status"] == "fail"}
    assert {"model", "credential:OPENAI_API_KEY", "credential:SOLARI_API_KEY"} <= failed
    assert not output.exists()


def test_dry_run_preflight_and_audit_machine_readable(tmp_path):
    output = tmp_path / "run"
    checked = cli(
        "preflight", "--dry-run", "--tasks", "T02", "--trials", "1", "--out", output, "--json"
    )
    assert checked.returncode == 0, checked.stderr
    assert json.loads(checked.stdout)["planned_trials"] == 1
    assert not output.exists()
    completed = cli("run", "--dry-run", "--tasks", "T02", "--trials", "1", "--out", output)
    assert completed.returncode == 0, completed.stderr
    before = {str(p): p.read_bytes() for p in output.rglob("*") if p.is_file()}
    checked = cli("audit", output, "--json")
    assert checked.returncode == 0, checked.stdout + checked.stderr
    report = json.loads(checked.stdout)
    assert report["healthy"]
    assert report["counts"]["finalized"] == 1
    assert not report["cleanup_candidates"]
    assert before == {str(p): p.read_bytes() for p in output.rglob("*") if p.is_file()}


def test_audit_detects_result_saved_before_manifest_update(tmp_path):
    output = tmp_path / "run"
    assert (
        cli("run", "--dry-run", "--tasks", "T02", "--trials", "1", "--out", output).returncode == 0
    )
    path = output / "results.json"
    manifest = json.loads(path.read_text())
    manifest.update(records=[], status="interrupted")
    path.write_text(json.dumps(manifest))
    checked = cli("audit", output, "--json")
    assert checked.returncode == 1
    report = json.loads(checked.stdout)
    assert report["counts"]["finalized"] == 1
    assert report["unindexed_results"][0]["task_id"] == "T02"
    assert json.loads(path.read_text())["records"] == []


def test_audit_symlink_loop_returns_findings_instead_of_traceback(tmp_path):
    loop = tmp_path / "loop"
    loop.symlink_to(loop)
    checked = cli("audit", loop, "--json")
    assert checked.returncode == 1
    report = json.loads(checked.stdout)
    assert report["healthy"] is False
    assert report["findings"][0]["code"] == "invalid_manifest"
    assert "Traceback" not in checked.stderr
