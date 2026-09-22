import json
import sys

import pytest
from test_cli import cli

import gauntlet.cli as module
from gauntlet.models import TrialResult


def test_run_refuses_missing_packaged_files_before_allocating(monkeypatch, tmp_path):
    monkeypatch.setattr("gauntlet.harness.preflight.PACKAGE_ROOT", tmp_path / "missing")
    output = tmp_path / "run"
    monkeypatch.setattr(sys, "argv", ["gauntlet", "run", "--dry-run", "--out", str(output)])

    def never_allocate():
        pytest.fail("Must not allocate before readiness passes")

    monkeypatch.setattr(module, "DryRunDesktop", never_allocate)
    with pytest.raises(SystemExit) as exc:
        module.main()
    assert exc.value.code == 2
    assert not output.exists()


def test_strict_exit_preserves_results_reports_and_preflight(tmp_path):
    output = tmp_path / "run"
    result = cli(
        "run",
        "--dry-run",
        "--tasks",
        "T02",
        "--trials",
        "1",
        "--fail-on-task-failure",
        "--out",
        output,
    )
    assert result.returncode == 3, result.stderr
    run = json.loads((output / "results.json").read_text())
    assert run["configuration"]["fail_on_task_failure"] is True
    assert run["configuration"]["preflight"]["ready"] is True
    assert run["configuration"]["preflight"]["planned_trials"] == 1
    assert (output / "html/index.html").exists()
    assert (output / "report.md").exists()


@pytest.mark.parametrize(
    "passed,infra,cleanup,expected",
    [
        (True, False, None, 0),
        (False, False, None, 3),
        (False, True, None, 2),
        (True, False, "cleanup failed", 2),
    ],
)
def test_strict_exit_precedence(monkeypatch, tmp_path, passed, infra, cleanup, expected):
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "gauntlet",
            "run",
            "--dry-run",
            "--tasks",
            "T02",
            "--fail-on-task-failure",
            "--out",
            str(tmp_path / "run"),
        ],
    )
    built_reports = []

    async def suite(*args, **kwargs):
        return {
            "records": [
                {
                    "passed": passed,
                    "failure_class": "infra_error" if infra else None,
                    "cleanup_error": cleanup,
                }
            ]
        }

    monkeypatch.setattr(module, "run_suite", suite)
    monkeypatch.setattr(module, "build_report", lambda path: built_reports.append(path))
    if expected:
        with pytest.raises(SystemExit) as exc:
            module.main()
        assert exc.value.code == expected
    else:
        module.main()
    assert built_reports == [tmp_path / "run"]


def test_diagnostic_stage_is_shown_in_console_without_changing_outcome(
    monkeypatch, tmp_path, capsys
):
    monkeypatch.setattr(
        sys,
        "argv",
        ["gauntlet", "run", "--dry-run", "--tasks", "T02", "--out", str(tmp_path / "run")],
    )

    async def suite(*args, **kwargs):
        kwargs["on_result"](TrialResult("T02", 1, 1, "fake", "test", failure_stage="setup"))
        return {"records": []}

    monkeypatch.setattr(module, "run_suite", suite)
    monkeypatch.setattr(module, "build_report", lambda path: path / "report.md")
    module.main()
    assert "setup" in capsys.readouterr().out
