import asyncio
import json

import pytest

from gauntlet.harness.runner import run_suite
from gauntlet.models import Action, Decision, load_tasks


class Desktop:
    def __init__(self, *, fail=False, cleanup_fail=False, passed=False, entered=None, gate=None):
        self.fail = fail
        self.cleanup_fail = cleanup_fail
        self.passed = passed
        self.entered = entered
        self.gate = gate
        self.destroyed = False

    async def start(self, task):
        if self.entered:
            self.entered.set()
        if self.gate:
            await self.gate.wait()
        if self.fail:
            raise RuntimeError("desktop allocation failed")

    async def setup(self, task):
        pass

    async def baseline(self):
        return {}

    async def screenshot(self):
        return b"local test screenshot"

    async def inspect(self, task, before):
        return {"passed": self.passed, "changed_protected_files": []}

    async def destroy(self):
        self.destroyed = True
        if self.cleanup_fail:
            raise RuntimeError("desktop destruction failed")


class Agent:
    async def next_action(self, *args):
        return Decision(Action("done"), {"response": "done"})

    async def close(self):
        pass


async def suite(tmp_path, desktops, **kwargs):
    instances = iter(desktops)
    return await run_suite(
        load_tasks("T02"),
        trials=kwargs.pop("trials", len(desktops)),
        concurrency=kwargs.pop("concurrency", 1),
        model="fake",
        mode="test",
        output=tmp_path / "run",
        backend_factory=lambda: next(instances),
        agent_factory=Agent,
        settle_seconds=0,
        **kwargs,
    )


@pytest.mark.parametrize("limit", [0, -1, True, False, 1.0, "1", float("nan")])
async def test_invalid_limit_rejected_before_output_or_allocation(tmp_path, limit):
    with pytest.raises(ValueError, match="positive integer"):
        await suite(tmp_path, [], trials=1, max_infra_failures=limit)
    assert not (tmp_path / "run").exists()


async def test_serial_stop_retains_full_plan_without_creating_skipped_trials(tmp_path):
    desktops = [Desktop(fail=True) for _ in range(4)]
    run = await suite(tmp_path, desktops, max_infra_failures=1)
    assert run["status"] == "stopped"
    assert run["configuration"]["max_infra_failures"] == 1
    assert run["stop_reason"] == {
        "kind": "max_infra_failures",
        "limit": 1,
        "observed_failures": 1,
        "task_id": "T02",
        "trial": 1,
    }
    assert run["planned_trials"] == run["trials_per_task"] == 4
    assert len(run["records"]) == 1
    assert [desktop.destroyed for desktop in desktops] == [True, False, False, False]
    assert {path.name for path in (tmp_path / "run/T02").iterdir()} == {"1"}
    assert json.loads((tmp_path / "run/results.json").read_text()) == run
    assert run["summary"]["test/fake"]["cost_coverage"]["complete"] is False


async def test_limit_counts_failures_cumulatively_and_double_failure_once(tmp_path):
    desktops = [
        Desktop(fail=True, cleanup_fail=True),
        Desktop(passed=True),
        Desktop(),  # An ordinary failed task must not advance the counter.
        Desktop(cleanup_fail=True, passed=True),
        Desktop(),
    ]
    run = await suite(tmp_path, desktops, max_infra_failures=2)
    assert run["status"] == "stopped"
    assert [record["trial"] for record in run["records"]] == [1, 2, 3, 4]
    assert run["stop_reason"]["trial"] == 4
    assert run["stop_reason"]["observed_failures"] == 2
    assert run["records"][0]["failure_class"] == "infra_error"
    assert run["records"][0]["cleanup_error"]
    assert run["records"][3]["passed"] is True
    assert not desktops[4].destroyed


async def test_default_runs_all_trials_despite_infrastructure_and_cleanup_failures(tmp_path):
    desktops = [Desktop(fail=True), Desktop(cleanup_fail=True), Desktop(fail=True)]
    run = await suite(tmp_path, desktops)
    assert run["status"] == "complete"
    assert run["configuration"]["max_infra_failures"] is None
    assert "stop_reason" not in run
    assert len(run["records"]) == 3
    assert all(desktop.destroyed for desktop in desktops)


async def test_ordinary_task_failures_do_not_stop_run(tmp_path):
    run = await suite(tmp_path, [Desktop() for _ in range(3)], max_infra_failures=1)
    assert run["status"] == "complete"
    assert "stop_reason" not in run
    assert len(run["records"]) == 3
    assert all(record["failure_class"] == "premature_done" for record in run["records"])


async def test_threshold_on_last_trial_still_records_policy_stop(tmp_path):
    run = await suite(tmp_path, [Desktop(passed=True), Desktop(fail=True)], max_infra_failures=1)
    assert run["status"] == "stopped"
    assert len(run["records"]) == run["planned_trials"] == 2
    assert run["stop_reason"]["trial"] == 2


async def test_concurrent_stop_finishes_active_trials_and_keeps_first_trigger(tmp_path):
    second_entered = asyncio.Event()
    release_second = asyncio.Event()
    desktops = [
        Desktop(fail=True, gate=second_entered),
        Desktop(fail=True, entered=second_entered, gate=release_second),
        Desktop(),
        Desktop(),
    ]
    reported = []

    def on_result(result):
        reported.append(result.trial)
        if result.trial == 1:
            snapshot = json.loads((tmp_path / "run/results.json").read_text())
            assert snapshot["stop_reason"]["trial"] == 1
            assert not desktops[1].destroyed
            release_second.set()

    async with asyncio.timeout(5):
        run = await suite(
            tmp_path, desktops, concurrency=2, max_infra_failures=1, on_result=on_result
        )
    assert run["status"] == "stopped"
    assert reported == [1, 2]
    assert [record["failure_class"] for record in run["records"]] == ["infra_error"] * 2
    assert run["stop_reason"]["trial"] == run["stop_reason"]["observed_failures"] == 1
    assert [desktop.destroyed for desktop in desktops] == [True, True, False, False]
    assert not (tmp_path / "run/T02/3").exists()


async def test_cancellation_after_threshold_remains_interrupted_and_finishes_cleanup(tmp_path):
    second_entered = asyncio.Event()
    threshold_reached = asyncio.Event()
    desktops = [
        Desktop(fail=True, gate=second_entered),
        Desktop(entered=second_entered, gate=asyncio.Event()),
        Desktop(),
    ]
    async with asyncio.timeout(5):
        job = asyncio.create_task(
            suite(
                tmp_path,
                desktops,
                concurrency=2,
                max_infra_failures=1,
                on_result=lambda result: threshold_reached.set(),
            )
        )
        await threshold_reached.wait()
        job.cancel()
        with pytest.raises(asyncio.CancelledError):
            await job
    saved = json.loads((tmp_path / "run/results.json").read_text())
    assert saved["status"] == "interrupted"
    assert saved["stop_reason"]["trial"] == 1
    assert len(saved["records"]) == 2
    assert "CancelledError" in saved["records"][1]["error"]
    assert [desktop.destroyed for desktop in desktops] == [True, True, False]
