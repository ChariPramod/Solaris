import json
from uuid import uuid4

import pytest

from gauntlet.harness.audit import audit_run


def make_run(tmp_path, *, modern=True, status="complete", trials=1):
    manifest = {
        "schema_version": 2,
        "task_ids": ["T01"],
        "trials_per_task": trials,
        "planned_trials": trials,
        "model": "fake",
        "mode": "dry-run",
        "status": status,
        "records": [],
    }
    if modern:
        manifest["run_id"] = str(uuid4())
    save_manifest(tmp_path, manifest)
    return manifest


def save_manifest(root, manifest):
    (root / "results.json").write_text(json.dumps(manifest))


def save_result(root, manifest, *, indexed=True, trial=1, **extra):
    result = {
        "task_id": "T01",
        "trial": trial,
        "model": "fake",
        "mode": "dry-run",
        "passed": False,
        "steps": 0,
        "termination": "agent_done",
        "failure_class": None,
        "cleanup_error": None,
        "error": None,
        "desktop_id": None,
        "evidence": {},
        "artifacts": f"T01/{trial}",
        **extra,
    }
    path = root / "T01" / str(trial)
    path.mkdir(parents=True, exist_ok=True)
    (path / "result.json").write_text(json.dumps(result))
    if indexed:
        manifest["records"].append(result)
        save_manifest(root, manifest)
    return result


def journal(root, manifest, *events):
    path = root / "T01" / "1"
    path.mkdir(parents=True, exist_ok=True)
    with (path / "lifecycle.jsonl").open("w") as stream:
        for event in events:
            stream.write(
                json.dumps(
                    {
                        "schema_version": 1,
                        "run_id": manifest.get("run_id"),
                        "task_id": "T01",
                        "trial": 1,
                        "time": "2026-09-20T10:00:00+00:00",
                        **event,
                    }
                )
                + "\n"
            )


def codes(report):
    return {item["code"] for item in report["findings"]}


@pytest.mark.parametrize("modern", [True, False])
def test_successful_run_is_healthy_and_read_only(tmp_path, modern):
    manifest = make_run(tmp_path, modern=modern)
    save_result(tmp_path, manifest, passed=False)
    if modern:
        journal(tmp_path, manifest, {"event": "trial_started"}, {"event": "desktop_destroyed"})
    before = {str(path): path.read_bytes() for path in tmp_path.rglob("*") if path.is_file()}
    report = audit_run(tmp_path)
    after = {str(path): path.read_bytes() for path in tmp_path.rglob("*") if path.is_file()}
    assert before == after
    assert report["healthy"]
    assert report["counts"] == {
        "planned": 1,
        "recorded": 1,
        "finalized": 1,
        "unstarted": 0,
        "incomplete": 0,
    }
    assert report["scope"] == "local artifacts only; no provider status verified"


def test_crash_after_allocation_without_result_preserves_candidate(tmp_path):
    manifest = make_run(tmp_path, status="interrupted", trials=3)
    journal(tmp_path, manifest, {"event": "allocated", "desktop_id": "vm-one"})
    report = audit_run(tmp_path)
    assert not report["healthy"]
    assert report["counts"] == {
        "planned": 3,
        "recorded": 0,
        "finalized": 0,
        "unstarted": 2,
        "incomplete": 1,
    }
    assert report["cleanup_candidates"][0]["desktop_id"] == "vm-one"
    assert "cleanup_unconfirmed" in codes(report)


def test_allocation_requires_matching_destroyed_id(tmp_path):
    manifest = make_run(tmp_path)
    save_result(tmp_path, manifest, desktop_id="vm-two")
    journal(
        tmp_path,
        manifest,
        {"event": "allocated", "desktop_id": "vm-one"},
        {"event": "desktop_destroyed", "desktop_id": "vm-one"},
        {"event": "allocated", "desktop_id": "vm-two"},
        {"event": "desktop_destroyed"},
    )
    assert [item["desktop_id"] for item in audit_run(tmp_path)["cleanup_candidates"]] == ["vm-two"]


@pytest.mark.parametrize(
    "ending,unknown", [("create_rejected", False), ("desktop_destroyed", True)]
)
def test_lost_create_response_not_cleared_by_noop_destroy(tmp_path, ending, unknown):
    manifest = make_run(tmp_path)
    save_result(tmp_path, manifest)
    journal(
        tmp_path,
        manifest,
        {"event": "create_requested", "attempt": 1},
        {"event": ending, "attempt": 1},
    )
    assert ("unknown_allocation" in codes(audit_run(tmp_path))) == unknown


def test_rejected_retry_and_destroyed_allocation_are_healthy(tmp_path):
    manifest = make_run(tmp_path)
    save_result(tmp_path, manifest, desktop_id="vm")
    journal(
        tmp_path,
        manifest,
        {"event": "create_requested", "attempt": 1},
        {"event": "create_rejected", "attempt": 1},
        {"event": "create_requested", "attempt": 2},
        {"event": "allocated", "desktop_id": "vm"},
        {"event": "desktop_destroyed", "desktop_id": "vm"},
    )
    assert audit_run(tmp_path)["healthy"]


def test_partial_journal_salvages_allocation(tmp_path):
    manifest = make_run(tmp_path)
    journal(tmp_path, manifest, {"event": "allocated", "desktop_id": "vm"})
    with (tmp_path / "T01/1/lifecycle.jsonl").open("a") as stream:
        stream.write('{"event":"desktop_destroyed"')
    report = audit_run(tmp_path)
    assert "partial_journal" in codes(report)
    assert report["cleanup_candidates"][0]["desktop_id"] == "vm"


def test_wrong_journal_identity_does_not_confirm_cleanup(tmp_path):
    manifest = make_run(tmp_path)
    journal(
        tmp_path,
        manifest,
        {"event": "allocated", "desktop_id": "vm"},
        {"event": "desktop_destroyed", "desktop_id": "vm", "run_id": str(uuid4())},
    )
    report = audit_run(tmp_path)
    assert "partial_journal" in codes(report)
    assert report["cleanup_candidates"][0]["desktop_id"] == "vm"


def test_legacy_cleanup_failure_has_fallback_candidate(tmp_path):
    manifest = make_run(tmp_path, modern=False)
    save_result(tmp_path, manifest, desktop_id="legacy", cleanup_error="TimeoutError")
    report = audit_run(tmp_path)
    assert report["cleanup_candidates"][0]["desktop_id"] == "legacy"
    assert not report["healthy"]


def test_unindexed_results_recovered_only_from_planned_slots(tmp_path):
    manifest = make_run(tmp_path, modern=False)
    save_result(tmp_path, manifest, indexed=False)
    # An unrelated artifact is deliberately outside the plan and is never read.
    (tmp_path / "T99").mkdir()
    (tmp_path / "T99/result.json").write_text("bad json")
    report = audit_run(tmp_path)
    assert report["counts"]["finalized"] == 1
    assert report["counts"]["recorded"] == 0
    assert report["unindexed_results"] == [
        {"task_id": "T01", "trial": 1, "path": "T01/1/result.json"}
    ]
    assert codes(report) == {"unindexed_result"}


def test_duplicate_mismatched_and_missing_records(tmp_path):
    manifest = make_run(tmp_path, modern=False, trials=2)
    result = save_result(tmp_path, manifest)
    manifest["records"] += [result.copy(), {**result, "trial": 2}, {**result, "task_id": "T99"}]
    manifest["records"][0] = {**result, "passed": True}
    save_manifest(tmp_path, manifest)
    report = audit_run(tmp_path)
    assert {"duplicate_record", "result_mismatch", "missing_result", "unexpected_record"} <= codes(
        report
    )
    assert report["counts"]["recorded"] == 2


@pytest.mark.parametrize(
    "field,value",
    [
        ("task_ids", ["../outside"]),
        ("task_ids", ["T01", "T01"]),
        ("trials_per_task", True),
        ("trials_per_task", 10_001),
        ("records", {}),
    ],
)
def test_invalid_plan_not_enumerated(tmp_path, field, value):
    manifest = make_run(tmp_path)
    manifest[field] = value
    save_manifest(tmp_path, manifest)
    report = audit_run(tmp_path)
    assert codes(report) == {"invalid_manifest"}
    assert report["counts"]["planned"] == 0


@pytest.mark.parametrize("artifact", ["result.json", "lifecycle.jsonl", "trial"])
def test_escaping_symlinks_are_not_read(tmp_path, artifact):
    root = tmp_path / "run"
    root.mkdir()
    manifest = make_run(root)
    outside = tmp_path / "outside"
    outside.mkdir()
    sentinel = outside / "secret.json"
    sentinel.write_text("sensitive sentinel")
    path = root / "T01" / "1"
    path.parent.mkdir()
    if artifact == "trial":
        path.symlink_to(outside, target_is_directory=True)
    else:
        path.mkdir()
        (path / artifact).symlink_to(sentinel)
    report = audit_run(root)
    assert not report["healthy"]
    assert "sensitive sentinel" not in json.dumps(report)
    assert {"unsafe_trial_path", "invalid_result", "invalid_journal"} & codes(report)
    assert manifest["records"] == []


def test_running_manifest_is_explicitly_only_a_snapshot(tmp_path):
    make_run(tmp_path, status="running")
    report = audit_run(tmp_path)
    assert report["healthy"]
    assert report["counts"]["unstarted"] == 1
    assert codes(report) == {"running_snapshot"}


def test_journal_regular_file_and_size_limits(tmp_path):
    manifest = make_run(tmp_path)
    journal(tmp_path, manifest)
    path = tmp_path / "T01/1/lifecycle.jsonl"
    with path.open("wb") as stream:
        stream.truncate(16 * 1024 * 1024 + 1)
    assert "invalid_journal" in codes(audit_run(tmp_path))
    path.unlink()
    path.mkdir()
    assert "invalid_journal" in codes(audit_run(tmp_path))


@pytest.mark.parametrize(
    "extra",
    [
        {"passed": None},
        {"steps": True},
        {"steps": -1},
        {"termination": {}},
        {"evidence": []},
        {"artifacts": "../../outside"},
        {"cleanup_error": []},
    ],
)
def test_incomplete_final_fields_are_not_finalized(tmp_path, extra):
    manifest = make_run(tmp_path, modern=False)
    save_result(tmp_path, manifest, **extra)
    report = audit_run(tmp_path)
    assert {"invalid_record", "invalid_result"} <= codes(report)
    assert report["counts"]["finalized"] == 0


def test_identity_only_result_is_not_final(tmp_path):
    manifest = make_run(tmp_path, modern=False)
    result = {"task_id": "T01", "trial": 1, "model": "fake", "mode": "dry-run"}
    path = tmp_path / "T01" / "1"
    path.mkdir(parents=True)
    (path / "result.json").write_text(json.dumps(result))
    manifest["records"].append(result)
    save_manifest(tmp_path, manifest)
    report = audit_run(tmp_path)
    assert {"invalid_record", "invalid_result"} <= codes(report)
    assert report["counts"]["finalized"] == 0


def test_lifecycle_write_error_is_visible_even_with_destroy_event(tmp_path):
    manifest = make_run(tmp_path)
    save_result(tmp_path, manifest, evidence={"lifecycle_error": "OSError: disk full"})
    journal(tmp_path, manifest, {"event": "desktop_destroyed"})
    assert "lifecycle_error" in codes(audit_run(tmp_path))


def test_missing_modern_journal_retains_known_id_as_candidate(tmp_path):
    manifest = make_run(tmp_path)
    save_result(tmp_path, manifest, desktop_id="vm")
    report = audit_run(tmp_path)
    assert "missing_journal" in codes(report)
    assert report["cleanup_candidates"][0]["desktop_id"] == "vm"


async def test_real_dry_suite_reconciles(tmp_path):
    from gauntlet.agent.claude import DryRunAgent
    from gauntlet.harness.backends import DryRunDesktop
    from gauntlet.harness.runner import run_suite
    from gauntlet.models import load_tasks

    root = tmp_path / "suite"
    await run_suite(
        load_tasks("T01"),
        trials=1,
        concurrency=1,
        model="dry-run",
        mode="dry-run",
        output=root,
        backend_factory=DryRunDesktop,
        agent_factory=DryRunAgent,
        settle_seconds=0,
    )
    report = audit_run(root)
    assert report["healthy"], report["findings"]
    assert report["counts"]["finalized"] == 1
