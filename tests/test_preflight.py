import importlib
import json

import pytest

preflight_module = importlib.import_module("gauntlet.harness.preflight")
preflight = preflight_module.preflight


@pytest.fixture(autouse=True)
def isolate_environment(monkeypatch):
    for name in (
        "SOLARI_API_KEY",
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "GAUNTLET_CLAUDE_MODEL",
        "GAUNTLET_OPENAI_MODEL",
    ):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(preflight_module.importlib.util, "find_spec", lambda name: object())


def checks(report):
    return {check["name"]: check for check in report["checks"]}


def test_dry_preflight_is_credential_free_and_never_creates_output(tmp_path):
    output = tmp_path / "new" / "run"
    report = preflight(dry_run=True, provider="openai", tasks="T01,T02", output=output)
    assert report["ready"]
    assert report["model"] == report["adapter"] == "dry-run"
    assert report["task_ids"] == ["T01", "T02"]
    assert report["planned_trials"] == 6
    assert report["scope"] == "local-only"
    assert not any(name.startswith("credential:") for name in checks(report))
    assert not list(tmp_path.iterdir())
    json.dumps(report)


def test_live_preflight_collects_all_missing_credentials_without_exposing_values(monkeypatch):
    monkeypatch.setenv("SOLARI_API_KEY", "   ")
    report = preflight()
    assert not report["ready"]
    assert checks(report)["credential:SOLARI_API_KEY"]["status"] == "fail"
    assert checks(report)["credential:ANTHROPIC_API_KEY"]["status"] == "fail"
    assert report["model"] == "claude-sonnet-4-6"
    for name in ("SOLARI_API_KEY", "ANTHROPIC_API_KEY"):
        monkeypatch.setenv(name, "very-secret-" + name)
    report = preflight()
    assert report["ready"]
    assert "very-secret" not in json.dumps(report)
    assert checks(report)["pricing"]["status"] == "warning"


def test_provider_selection_resolves_only_relevant_model_and_credentials(monkeypatch):
    monkeypatch.setenv("GAUNTLET_OPENAI_MODEL", "env-model")
    monkeypatch.setenv("SOLARI_API_KEY", "secret")
    monkeypatch.setenv("OPENAI_API_KEY", "secret")
    report = preflight(provider="openai")
    assert report["ready"]
    assert report["model"] == "env-model"
    assert "credential:ANTHROPIC_API_KEY" not in checks(report)
    assert "dependency:anthropic" not in checks(report)
    assert preflight(provider="openai", model="explicit-model")["model"] == "explicit-model"


@pytest.mark.parametrize(
    ("arguments", "failed_check"),
    [
        ({"provider": "unknown"}, "provider"),
        ({"provider": "openai"}, "model"),
        ({"model": "  "}, "model"),
        ({"trials": 0}, "trials"),
        ({"trials": True}, "trials"),
        ({"concurrency": -1}, "concurrency"),
        ({"concurrency": 1.5}, "concurrency"),
        ({"template": " "}, "template"),
        ({"tasks": "T99"}, "tasks"),
    ],
)
def test_invalid_configuration_reports_blocker(arguments, failed_check):
    report = preflight(**arguments)
    assert not report["ready"]
    assert checks(report)[failed_check]["status"] == "fail"


def test_missing_live_dependency_is_a_blocker_but_dry_run_does_not_require_it(monkeypatch):
    monkeypatch.setattr(
        preflight_module.importlib.util,
        "find_spec",
        lambda name: None if name == "solari_desktop" else object(),
    )
    assert checks(preflight())["dependency:solari_desktop"]["status"] == "fail"
    assert preflight(dry_run=True)["ready"]


def test_pricing_validation_uses_exact_model_and_disallows_dry_run(tmp_path, monkeypatch):
    monkeypatch.setenv("SOLARI_API_KEY", "secret")
    monkeypatch.setenv("OPENAI_API_KEY", "secret")
    pricing = tmp_path / "pricing.json"
    pricing.write_text(
        json.dumps(
            {
                "provider": "openai",
                "model": "test-model",
                "source": "Synthetic test rates",
                "max_input_tokens": 1000,
                "usd_per_million": {"input": 1, "output": 2},
            }
        )
    )
    assert preflight(provider="openai", model="test-model", pricing_path=pricing)["ready"]
    report = preflight(provider="openai", model="different", pricing_path=pricing)
    assert checks(report)["pricing"]["status"] == "fail"
    assert checks(preflight(dry_run=True, pricing_path=pricing))["pricing"]["status"] == "fail"
    pricing.write_text("{")
    assert checks(preflight(pricing_path=pricing))["pricing"]["status"] == "fail"


def test_existing_output_and_file_ancestors_are_rejected(tmp_path):
    sentinel = tmp_path / "sentinel.txt"
    sentinel.write_text("unchanged")
    for output in (tmp_path, sentinel, sentinel / "nested"):
        report = preflight(dry_run=True, output=output)
        assert checks(report)["output"]["status"] == "fail"
    assert sentinel.read_text() == "unchanged"


def test_dangling_symlink_output_is_rejected(tmp_path):
    output = tmp_path / "link"
    output.symlink_to(tmp_path / "missing")
    assert checks(preflight(dry_run=True, output=output))["output"]["status"] == "fail"


def test_unwritable_ancestor_is_rejected_without_test_writes(tmp_path, monkeypatch):
    monkeypatch.setattr(preflight_module.os, "access", lambda path, mode: False)
    report = preflight(dry_run=True, output=tmp_path / "new")
    assert checks(report)["output"]["status"] == "fail"
    assert not list(tmp_path.iterdir())


def test_default_output_can_use_existing_results_parent(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "results").mkdir()
    assert preflight(dry_run=True)["ready"]
    assert not list((tmp_path / "results").iterdir())


def test_missing_packaged_fixtures_are_actionable(tmp_path, monkeypatch):
    monkeypatch.setattr(preflight_module, "PACKAGE_ROOT", tmp_path)
    report = preflight(dry_run=True, tasks="T11")
    assert checks(report)["package_files"]["status"] == "fail"
    assert "fixtures/assets/invoice.pdf" in checks(report)["package_files"]["message"]


def test_malformed_task_yaml_is_reported_without_aborting_other_checks(monkeypatch):
    def malformed_tasks(selection):
        raise preflight_module.YAMLError("Malformed task definition")

    monkeypatch.setattr(preflight_module, "load_tasks", malformed_tasks)
    report = preflight(dry_run=True)
    assert checks(report)["tasks"]["status"] == "fail"
    assert "output" in checks(report)
