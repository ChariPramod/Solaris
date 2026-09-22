import json
import sys

import pytest

import gauntlet.cli as cli_module
from gauntlet.harness.audit import audit_run
from gauntlet.harness.backends import DryRunDesktop
from gauntlet.harness.preflight import preflight
from gauntlet.harness.recovery import recover_run


@pytest.mark.parametrize("limit", [0, -1, True, 1.5, "2"])
def test_preflight_rejects_invalid_failure_limit(limit, tmp_path):
    result = preflight(dry_run=True, max_infra_failures=limit, output=tmp_path / "new")
    assert not result["ready"]
    assert (
        next(c for c in result["checks"] if c["name"] == "max_infra_failures")["status"] == "fail"
    )
    assert not list(tmp_path.iterdir())


def test_stopped_cli_preserves_plan_report_audit_and_recovery(monkeypatch, tmp_path, capsys):
    class FailingDesktop(DryRunDesktop):
        async def setup(self, task):
            await super().setup(task)
            raise RuntimeError("SIMULATED provisioning outage")

    output = tmp_path / "stopped"
    monkeypatch.setattr(cli_module, "DryRunDesktop", FailingDesktop)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "gauntlet",
            "run",
            "--dry-run",
            "--tasks",
            "T01,T02",
            "--trials",
            "2",
            "--concurrency",
            "1",
            "--max-infra-failures",
            "1",
            "--fail-on-task-failure",
            "--out",
            str(output),
        ],
    )
    with pytest.raises(SystemExit) as exc:
        cli_module.main()
    assert exc.value.code == 2
    assert "Infrastructure failure limit reached" in capsys.readouterr().out
    manifest = json.loads((output / "results.json").read_text())
    assert manifest["status"] == "stopped"
    assert manifest["planned_trials"] == 4
    assert len(manifest["records"]) == 1
    assert manifest["configuration"]["preflight"]["max_infra_failures"] == 1
    assert manifest["configuration"]["max_infra_failures"] == 1
    assert not (output / "T01/2").exists()
    assert not (output / "T02").exists()
    assert "Infrastructure failure limit reached" in (output / "report.md").read_text()
    assert "Infrastructure failure limit reached" in (output / "html/index.html").read_text()
    audit = audit_run(output)
    assert audit["counts"]["unstarted"] == 3
    assert audit["counts"]["incomplete"] == 0
    assert not audit["cleanup_candidates"]
    original = (output / "results.json").read_bytes()
    exported = tmp_path / "export"
    recovery = recover_run(output, exported)
    assert recovery["audit"]["counts"]["unstarted"] == 3
    assert recovery["recovery"]["source_status"] == "stopped"
    assert (output / "results.json").read_bytes() == original
    recovered = json.loads((exported / "results.json").read_text())
    assert recovered["stop_reason"] == manifest["stop_reason"]
    assert recovered["summary"] == manifest["summary"]
    assert "Infrastructure failure limit reached" in (exported / "html/index.html").read_text()
