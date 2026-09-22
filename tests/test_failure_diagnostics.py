import asyncio
import json
from dataclasses import replace

import pytest

from gauntlet.harness.lifecycle import LifecycleLog
from gauntlet.harness.runner import run_trial
from gauntlet.models import Action, Decision, load_tasks


class DiagnosticDesktop:
    def __init__(self, stage=None, *, hang=False, cleanup_error=False):
        self.stage = stage
        self.hang = hang
        self.cleanup_error = cleanup_error
        self.destroyed = False
        self.inspections = 0

    async def enter(self, stage):
        if self.stage != stage:
            return
        # Fail once so subsequent evidence collection and cleanup can proceed.
        self.stage = None
        if self.hang:
            await asyncio.sleep(60)
        raise TimeoutError(f"{stage} transport timed out")

    async def start(self, task):
        await self.enter("desktop_start")

    async def setup(self, task):
        await self.enter("setup")

    async def baseline(self):
        await self.enter("baseline")
        return {}

    async def screenshot(self):
        await self.enter("screenshot")
        return b"test screenshot"

    async def execute(self, action):
        await self.enter("action")

    async def inspect(self, task, before):
        self.inspections += 1
        await self.enter("verification")
        return {"passed": False, "changed_protected_files": []}

    async def destroy(self):
        self.destroyed = True
        if self.cleanup_error:
            raise RuntimeError("destroy failed")


class DiagnosticAgent:
    def __init__(self, *, fail=False, hang=False, action="done"):
        self.fail = fail
        self.hang = hang
        self.action = action
        self.closed = False

    async def next_action(self, *args):
        if self.hang:
            await asyncio.sleep(60)
        if self.fail:
            raise TimeoutError("model transport timed out")
        return Decision(Action(self.action), {"response": self.action})

    async def close(self):
        self.closed = True


async def trial(tmp_path, desktop, agent=None, **kwargs):
    task = replace(load_tasks("T02")[0], max_steps=1, max_seconds=kwargs.pop("seconds", 10))
    return await run_trial(
        task,
        1,
        "fake",
        "test",
        tmp_path / "trial",
        lambda: desktop,
        lambda: agent or DiagnosticAgent(),
        settle_seconds=kwargs.pop("settle_seconds", 0),
        **kwargs,
    )


@pytest.mark.parametrize("stage", ["screenshot", "model", "action"])
async def test_early_transport_timeout_is_infrastructure_failure(tmp_path, stage):
    desktop = DiagnosticDesktop(stage)
    agent = DiagnosticAgent(fail=stage == "model", action="screenshot")
    result = await trial(tmp_path, desktop, agent)
    assert result.termination == "error"
    assert result.failure_class == "infra_error"
    assert result.failure_stage == stage
    assert result.error == f"TimeoutError: {stage} transport timed out"
    assert desktop.inspections == 1
    assert desktop.destroyed and agent.closed
    saved = json.loads((tmp_path / "trial/result.json").read_text())
    assert saved["failure_stage"] == stage


@pytest.mark.parametrize("stage", ["screenshot", "model", "action", "settle"])
async def test_task_deadline_retains_stage_and_timeout_verdict(tmp_path, stage):
    desktop = DiagnosticDesktop(stage, hang=True)
    agent = DiagnosticAgent(hang=stage == "model", action="screenshot")
    result = await trial(
        tmp_path,
        desktop,
        agent,
        seconds=0.02,
        settle_seconds=60 if stage == "settle" else 0,
    )
    assert result.termination == "max_seconds"
    assert result.failure_class == "timeout"
    assert result.failure_stage == stage
    assert result.error is None
    assert desktop.inspections == 1
    assert desktop.destroyed and agent.closed


@pytest.mark.parametrize(
    "stage,hang",
    [(stage, hang) for stage in ("desktop_start", "setup", "baseline") for hang in (False, True)]
    + [("verification", False)],
)
async def test_preparation_and_verification_failure_stages(tmp_path, stage, hang):
    desktop = DiagnosticDesktop(stage, hang=hang)
    result = await trial(tmp_path, desktop, setup_seconds=0.02 if hang else 10)
    assert result.termination == "error"
    assert result.failure_class == "infra_error"
    assert result.failure_stage == stage
    assert desktop.destroyed
    events = [
        json.loads(line) for line in (tmp_path / "trial/lifecycle.jsonl").read_text().splitlines()
    ]
    stages = [event["stage"] for event in events if event["event"] == "stage_started"]
    assert stages[-1] == stage
    assert "cleanup_started" in [event["event"] for event in events]


async def test_cleanup_and_fallback_inspection_preserve_primary_failure(tmp_path):
    desktop = DiagnosticDesktop("action", cleanup_error=True)
    result = await trial(tmp_path, desktop, DiagnosticAgent(action="screenshot"))
    assert result.failure_stage == "action"
    assert result.failure_class == "infra_error"
    assert "action transport timed out" in result.error
    assert "destroy failed" in result.cleanup_error
    assert desktop.inspections == 1


async def test_fallback_inspection_preserves_lifecycle_write_error(tmp_path, monkeypatch):
    original_record = LifecycleLog.record

    def record(self, event, **details):
        if event == "stage_started" and details.get("stage") == "verification":
            raise OSError("journal unavailable")
        return original_record(self, event, **details)

    monkeypatch.setattr(LifecycleLog, "record", record)
    desktop = DiagnosticDesktop("action")
    result = await trial(tmp_path, desktop, DiagnosticAgent(action="screenshot"))
    assert result.failure_stage == "action"
    assert result.evidence["lifecycle_error"] == "OSError: journal unavailable"
    assert result.evidence["changed_protected_files"] == []
    assert desktop.destroyed


async def test_invalid_response_has_model_failure_stage(tmp_path):
    result = await trial(tmp_path, DiagnosticDesktop(), DiagnosticAgent(action="invalid_response"))
    assert result.failure_stage == "model"
    assert result.failure_class == "invalid_response"


async def test_normal_completion_has_no_failure_stage_or_per_step_lifecycle_writes(tmp_path):
    result = await trial(tmp_path, DiagnosticDesktop(), DiagnosticAgent(action="screenshot"))
    assert result.failure_stage is None
    events = [
        json.loads(line) for line in (tmp_path / "trial/lifecycle.jsonl").read_text().splitlines()
    ]
    assert [event["stage"] for event in events if event["event"] == "stage_started"] == [
        "desktop_start",
        "setup",
        "baseline",
        "verification",
    ]


async def test_cancellation_retains_interrupted_model_stage(tmp_path):
    entered = asyncio.Event()

    class InterruptedAgent(DiagnosticAgent):
        async def next_action(self, *args):
            entered.set()
            await asyncio.sleep(60)

    desktop = DiagnosticDesktop()
    agent = InterruptedAgent()
    running = asyncio.create_task(trial(tmp_path, desktop, agent))
    await asyncio.wait_for(entered.wait(), timeout=2)
    running.cancel()
    with pytest.raises(asyncio.CancelledError):
        await running
    saved = json.loads((tmp_path / "trial/result.json").read_text())
    assert saved["failure_stage"] == "model"
    assert saved["failure_class"] == "infra_error"
    assert desktop.destroyed and agent.closed
