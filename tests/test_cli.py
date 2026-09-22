import json
import subprocess
import sys
from pathlib import Path

from gauntlet.fixtures.data import seed
from gauntlet.models import load_tasks
from gauntlet.verifiers.state import inventory


def cli(*args):
    return subprocess.run(
        [sys.executable, "-m", "gauntlet", *map(str, args)],
        capture_output=True,
        text=True,
        timeout=20,
    )


def test_dry_run_is_labeled_and_report_links_to_real_artifacts(tmp_path):
    folder = tmp_path / "run"
    completed = cli("run", "--dry-run", "--tasks", "T02", "--trials", "1", "--out", folder)
    assert completed.returncode == 0, completed.stderr
    manifest = json.loads((folder / "results.json").read_text())
    assert manifest["mode"] == "dry-run"
    assert manifest["records"][0]["model"] == "dry-run"
    assert manifest["records"][0]["cost_usd"] == 0
    assert manifest["records"][0]["failure_class"] == "premature_done"
    report = (folder / "report.md").read_text()
    assert "not benchmark results" in report
    assert (folder / manifest["records"][0]["artifacts"] / "result.json").is_file()


def test_existing_output_is_never_overwritten(tmp_path):
    sentinel = tmp_path / "sentinel.txt"
    sentinel.write_text("keep")
    completed = cli("run", "--dry-run", "--out", tmp_path)
    assert completed.returncode == 2
    assert sentinel.read_text() == "keep"


def test_unknown_task_and_bad_limits_fail_before_running():
    for args in [
        ("--tasks", "T99"),
        ("--trials", "0"),
        ("--concurrency", "-1"),
        ("--setup-seconds", "0"),
    ]:
        completed = cli("run", "--dry-run", *args)
        assert completed.returncode == 2


def test_missing_credentials_have_actionable_error(monkeypatch):
    monkeypatch.delenv("SOLARI_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    completed = cli("run", "--tasks", "T02", "--trials", "1")
    assert completed.returncode == 2
    assert "SOLARI_API_KEY" in completed.stderr
    assert "--dry-run" in completed.stderr


def test_openai_requires_explicit_model_and_only_its_provider_key(monkeypatch):
    monkeypatch.delenv("GAUNTLET_OPENAI_MODEL", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    completed = cli("run", "--model", "openai")
    assert completed.returncode == 2
    assert "--model-id" in completed.stderr
    completed = cli("run", "--model", "openai", "--model-id", "test-model")
    assert completed.returncode == 2
    assert "OPENAI_API_KEY" in completed.stderr
    assert "ANTHROPIC_API_KEY" not in completed.stderr


def test_openai_dry_run_remains_credential_free(tmp_path):
    completed = cli(
        "run",
        "--model",
        "openai",
        "--dry-run",
        "--tasks",
        "T02",
        "--trials",
        "1",
        "--out",
        tmp_path / "run",
    )
    assert completed.returncode == 0, completed.stderr
    run = json.loads((tmp_path / "run/results.json").read_text())
    assert run["configuration"]["adapter"] == "dry-run"
    assert run["configuration"]["pricing"] is None


def test_pricing_mismatch_fails_before_output_or_credentials(tmp_path):
    price = tmp_path / "price.json"
    price.write_text(
        json.dumps(
            {
                "provider": "openai",
                "model": "wrong",
                "source": "synthetic",
                "max_input_tokens": 1000,
                "usd_per_million": {"input": 1, "output": 2},
            }
        )
    )
    completed = cli(
        "run",
        "--model",
        "openai",
        "--model-id",
        "test",
        "--pricing",
        price,
        "--out",
        tmp_path / "run",
    )
    assert completed.returncode == 2
    assert "must match" in completed.stderr
    assert not (tmp_path / "run").exists()


def test_live_openai_selects_matching_factory_and_configuration(monkeypatch, tmp_path):
    import gauntlet.cli as module

    monkeypatch.setenv("SOLARI_API_KEY", "test-only")
    monkeypatch.setenv("OPENAI_API_KEY", "test-only")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setenv("GAUNTLET_OPENAI_MODEL", "selected-model")
    monkeypatch.setenv("GAUNTLET_CLAUDE_MODEL", "unrelated-model")
    monkeypatch.setattr(
        sys,
        "argv",
        ["gauntlet", "run", "--model", "openai", "--tasks", "T02", "--out", str(tmp_path / "run")],
    )
    selected = []
    monkeypatch.setattr(module, "OpenAIAgent", lambda model: selected.append(model))

    async def suite(tasks, **kwargs):
        assert kwargs["model"] == "selected-model"
        assert kwargs["mode"] == "live"
        assert kwargs["configuration"]["adapter"] == "openai"
        assert kwargs["configuration"]["action_protocol"] == "responses-json-v1"
        kwargs["agent_factory"]()
        return {"records": []}

    monkeypatch.setattr(module, "run_suite", suite)
    monkeypatch.setattr(module, "build_report", lambda folder: folder / "report.md")
    module.main()
    assert selected == ["selected-model"]


def test_remote_verifier_entrypoint_runs_with_stdlib_only(tmp_path):
    seed(tmp_path)
    before = inventory(tmp_path / "docs")
    task = load_tasks("T02")[0]
    (tmp_path / "out/note.txt").write_text("Solari eval run 1")
    request = {
        "root": str(tmp_path),
        "operation": "verify",
        "config": task.verifier,
        "before": before,
        "allowed": {},
        "clipboard": "",
    }
    source = Path("gauntlet/verifiers/state.py").read_text()
    completed = subprocess.run(
        [sys.executable, "-S", "-c", source, json.dumps(request)],
        capture_output=True,
        text=True,
        check=True,
    )
    assert json.loads(completed.stdout)["passed"]
