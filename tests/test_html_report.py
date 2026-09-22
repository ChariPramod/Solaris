import json
import shutil
from dataclasses import asdict
from html.parser import HTMLParser

import pytest
from PIL import Image

from gauntlet.harness.provenance import provenance
from gauntlet.html_report import build_html_report
from gauntlet.models import TrialResult, load_tasks


class Links(HTMLParser):
    def __init__(self, html):
        super().__init__()
        self.references = []
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        for key, value in attrs:
            if (tag, key) in {("a", "href"), ("img", "src"), ("link", "href"), ("script", "src")}:
                self.references.append(value)


@pytest.fixture
def recorded_run(tmp_path):
    folder = tmp_path / "run"
    artifact = folder / "T02/1"
    artifact.mkdir(parents=True)
    task = load_tasks("T02")[0]
    Image.new("RGB", (1280, 720), "white").save(artifact / "001.jpg")
    Image.new("RGB", (1280, 720), "white").save(artifact / "final.jpg")
    event = {
        "step": 1,
        "screenshot": "001.jpg",
        "action": {"kind": "left_click", "params": {"coordinate": [100, 100]}},
        "response": {"content": "Observed a button"},
        "tokens_in": 40,
        "tokens_out": 5,
    }
    (artifact / "actions.jsonl").write_text(json.dumps(event) + "\n")
    record = asdict(
        TrialResult(
            "T02",
            1,
            1,
            "test-model",
            "live",
            passed=True,
            termination="agent_done",
            steps=1,
            artifacts="T02/1",
            evidence={"passed": True, "actual": "Solari eval run 1", "changed_protected_files": []},
        )
    )
    manifest = {
        "schema_version": 2,
        "status": "complete",
        "mode": "live",
        "model": "test-model",
        "created_at": "2026-09-14T00:00:00+00:00",
        "task_ids": ["T02"],
        "planned_trials": 1,
        "trials_per_task": 1,
        "records": [record],
        "tasks": {"T02": {"definition": asdict(task), "sha256": task.fingerprint}},
        "provenance": provenance(),
    }
    (folder / "results.json").write_text(json.dumps(manifest))
    return folder, manifest


def save(folder, manifest):
    (folder / "results.json").write_text(json.dumps(manifest))


def test_failure_stage_is_visible_without_changing_recorded_verdict(recorded_run):
    from gauntlet.report import build_report

    folder, manifest = recorded_run
    manifest["records"][0].update(
        passed=False,
        termination="error",
        failure_class="infra_error",
        failure_stage="desktop_start",
        error="TimeoutError: unavailable",
    )
    save(folder, manifest)
    markdown = build_report(folder).read_text()
    page = (folder / "html/trial-0001.html").read_text()
    assert "Failure stage:" in page
    assert "desktop start" in page
    assert "Cleanup status is recorded separately" in page
    assert "| desktop_start |" in markdown


def test_comparison_preserves_failure_limit_from_second_run(recorded_run, tmp_path):
    from gauntlet.report import build_report

    folder, manifest = recorded_run
    second = tmp_path / "second"
    shutil.copytree(folder, second)
    manifest["model"] = "second-model"
    manifest["records"][0]["model"] = "second-model"
    manifest["status"] = "stopped"
    manifest["stop_reason"] = {
        "kind": "max_infra_failures",
        "limit": 1,
        "observed_failures": 1,
        "task_id": "T02",
        "trial": 1,
    }
    save(second, manifest)
    markdown = build_report(folder, comparisons=[second]).read_text()
    html = (folder / "html/index.html").read_text()
    assert "Infrastructure failure limit reached in second" in markdown
    assert "Includes runs that reached an infrastructure failure limit" in html
    assert "second: limit 1" in html
    assert "Compare failure-limit settings" in html


def test_partial_cost_report_keeps_step_estimate_and_explains_unknown_total(recorded_run):
    folder, manifest = recorded_run
    manifest["records"][0].update(cost_usd=None, cost_status="unreported_request")
    manifest["configuration"] = {"pricing": {"source": "Synthetic test rates"}}
    save(folder, manifest)
    log = folder / "T02/1/actions.jsonl"
    event = json.loads(log.read_text())
    event.update(cost_usd=0.000125, cost_status="estimated", usage={"input": 40, "output": 5})
    log.write_text(json.dumps(event) + "\n")
    index = build_html_report(folder)
    page = (index.parent / "trial-0001.html").read_text()
    assert "$0.000125" in page
    assert "unreported request" in page
    assert "Billable token breakdown" in page
    assert "Excludes Solari" in page
    assert "Synthetic test rates" in index.read_text()


def assert_portable(report):
    for page in report.rglob("*.html"):
        for reference in Links(page.read_text()).references:
            if reference.startswith("#"):
                continue
            assert "://" not in reference, reference
            assert not reference.startswith("/"), reference
            assert (page.parent / reference).is_file(), (page, reference)


def test_portable_export_has_all_linked_pages_and_images(recorded_run, tmp_path):
    folder, _ = recorded_run
    index = build_html_report(folder, tmp_path / "export")
    assert_portable(index.parent)
    assert "100.0%" in index.read_text()
    assert "Full model response" in (index.parent / "trial-0001.html").read_text()
    moved = tmp_path / "moved"
    shutil.copytree(index.parent, moved)
    assert_portable(moved)


def test_click_overlay_is_added_without_modifying_original(recorded_run):
    folder, _ = recorded_run
    before = (folder / "T02/1/001.jpg").read_bytes()
    index = build_html_report(folder)
    with Image.open(index.parent / "assets/trial-0001-frame-0001.jpg") as image:
        red, green, _ = image.getpixel((100, 88))
        assert red > green + 50
    assert (folder / "T02/1/001.jpg").read_bytes() == before


def test_script_like_model_content_is_escaped(recorded_run):
    folder, manifest = recorded_run
    injection = '<script>alert("unsafe")</script>'
    manifest["records"][0]["evidence"]["actual"] = injection
    manifest["records"][0]["model"] = injection
    save(folder, manifest)
    index = build_html_report(folder)
    for page in (index, index.parent / "trial-0001.html"):
        assert "<script>alert(" not in page.read_text()
        assert "&lt;script&gt;" in page.read_text()


@pytest.mark.parametrize("reference", ["../secret", "/tmp/private", "..\\private"])
def test_traversal_artifacts_are_not_read(recorded_run, reference):
    folder, manifest = recorded_run
    manifest["records"][0]["artifacts"] = reference
    save(folder, manifest)
    index = build_html_report(folder)
    assert "Trial artifacts could not be read" in (index.parent / "trial-0001.html").read_text()
    assert not list((index.parent / "assets").iterdir())


def test_artifact_symlink_cannot_escape_run(recorded_run, tmp_path):
    folder, manifest = recorded_run
    secret = tmp_path / "secret"
    secret.mkdir()
    (secret / "actions.jsonl").write_text("SECRET_CONTENT")
    (folder / "outside").symlink_to(secret, target_is_directory=True)
    manifest["records"][0]["artifacts"] = "outside"
    save(folder, manifest)
    index = build_html_report(folder)
    page = (index.parent / "trial-0001.html").read_text()
    assert "SECRET_CONTENT" not in page
    assert "outside the run" in page


def test_partial_log_preserves_valid_frames_and_shows_warning(recorded_run):
    folder, _ = recorded_run
    log = folder / "T02/1/actions.jsonl"
    with log.open("a") as stream:
        stream.write('{"step": 1, "action_error": "Wrong target"}\n')
        stream.write('{"step": 2, "action": null}\n{"unfinished')
    index = build_html_report(folder)
    page = (index.parent / "trial-0001.html").read_text()
    assert "Wrong target" in page
    assert "incomplete or invalid" in page
    assert "Skipped invalid action" in page
    assert "frame-1" in page


def test_partial_run_has_missing_dots_and_no_false_reliability(recorded_run):
    folder, manifest = recorded_run
    manifest.update(status="interrupted", trials_per_task=3, planned_trials=3)
    save(folder, manifest)
    index = build_html_report(folder)
    page = index.read_text()
    assert "Partial run" in page
    assert "trial 2: missing" in page
    assert "trial 3: missing" in page
    assert "<strong>0/1</strong> complete task groups" in page


def test_empty_run_is_reviewable(recorded_run):
    folder, manifest = recorded_run
    manifest.update(status="interrupted", records=[])
    save(folder, manifest)
    index = build_html_report(folder)
    assert "No trial results have been recorded" in index.read_text()
    assert_portable(index.parent)


def test_dry_runs_and_multiple_models_stay_separate(recorded_run):
    folder, manifest = recorded_run
    second = dict(
        manifest["records"][0],
        model="other-model",
        mode="dry-run",
        passed=False,
        failure_class="premature_done",
    )
    manifest["records"].append(second)
    manifest["planned_trials"] = 2
    save(folder, manifest)
    index = build_html_report(folder)
    page = index.read_text()
    assert "Model comparison" in page
    assert "live/test-model" in page and "dry-run/other-model" in page
    assert "100.0%" in page and "0.0%" in page
    assert "Multiple execution modes" in page
    assert "Dry-run diagnostics" in (index.parent / "trial-0002.html").read_text()


def test_legacy_manifest_supported(recorded_run):
    folder, manifest = recorded_run
    manifest["schema_version"] = 1
    del manifest["tasks"]
    save(folder, manifest)
    assert_portable(build_html_report(folder).parent)


def test_owned_report_rebuilds_but_edited_file_is_preserved(recorded_run):
    folder, _ = recorded_run
    index = build_html_report(folder)
    assert build_html_report(folder) == index
    index.write_text("User's edit")
    with pytest.raises(ValueError, match="added or edited"):
        build_html_report(folder)
    assert index.read_text() == "User's edit"


def test_export_never_overwrites_unrelated_directory(recorded_run, tmp_path):
    folder, _ = recorded_run
    destination = tmp_path / "existing"
    destination.mkdir()
    sentinel = destination / "important.txt"
    sentinel.write_text("keep")
    with pytest.raises(ValueError, match="not a generated report"):
        build_html_report(folder, destination)
    assert sentinel.read_text() == "keep"


def test_export_cannot_replace_original_run(recorded_run):
    folder, _ = recorded_run
    with pytest.raises(ValueError, match="cannot replace"):
        build_html_report(folder, folder)
    assert (folder / "results.json").exists()


def second_run(folder, manifest, tmp_path):
    import copy

    other = tmp_path / "other"
    shutil.copytree(folder, other)
    data = copy.deepcopy(manifest)
    data["model"] = "second-model"
    data["records"][0]["model"] = "second-model"
    save(other, data)
    return other, data


def test_compare_separate_runs_copies_each_models_own_screenshot(recorded_run, tmp_path):
    folder, manifest = recorded_run
    other, _ = second_run(folder, manifest, tmp_path)
    Image.new("RGB", (1280, 720), "blue").save(other / "T02/1/001.jpg")
    index = build_html_report(folder, comparisons=[other])
    assert "Model comparison" in index.read_text()
    with Image.open(index.parent / "assets/trial-0002-frame-0001.jpg") as image:
        red, green, blue = image.getpixel((500, 500))
        assert blue > 200 and red < 20 and green < 20
    assert_portable(index.parent)


@pytest.mark.parametrize(
    "change, message",
    [
        ("trial_count", "identical task sets"),
        ("prompt", "task definitions differ"),
        ("fingerprint", "fingerprint does not match"),
        ("same_model", "distinct model/mode"),
        ("fixture", "fixtures or verifiers differ"),
        ("legacy", "recorded task definitions"),
    ],
)
def test_incompatible_comparisons_rejected(recorded_run, tmp_path, change, message):
    folder, manifest = recorded_run
    other, data = second_run(folder, manifest, tmp_path)
    if change == "trial_count":
        data["trials_per_task"] = 2
    elif change == "prompt":
        data["tasks"]["T02"]["definition"]["prompt"] = "Different task"
        from gauntlet.models import Task

        data["tasks"]["T02"]["sha256"] = Task(**data["tasks"]["T02"]["definition"]).fingerprint
    elif change == "fingerprint":
        data["tasks"]["T02"]["sha256"] = "incorrect"
    elif change == "same_model":
        data["records"][0]["model"] = "test-model"
    elif change == "fixture":
        data["provenance"]["package_files_sha256"]["fixtures/data.py"] = "changed"
    else:
        data.pop("tasks")
    save(other, data)
    with pytest.raises(ValueError, match=message):
        build_html_report(folder, comparisons=[other])
    assert not (folder / "html").exists()
