import asyncio
import json

import pytest

from gauntlet.harness.runner import run_suite, run_trial
from gauntlet.models import Action, Decision, load_tasks


class ControlledLifecycle:
    """Pause one real await boundary to exercise cancellation deterministically."""

    def __init__(self, pause):
        self.pause = pause
        self.entered = asyncio.Event()
        self.release = asyncio.Event()
        self.inspected = False
        self.destroyed = False
        self.closed = False

    async def checkpoint(self, stage):
        if stage == self.pause:
            self.entered.set()
            await self.release.wait()

    async def start(self, task):
        pass

    async def setup(self, task):
        pass

    async def baseline(self):
        return {}

    async def screenshot(self):
        return b"screen"

    async def next_action(self, *args):
        if self.pause == "fallback_inspection":
            raise RuntimeError("Model disconnected")
        await self.checkpoint("model")
        return Decision(Action("done"), {})

    async def inspect(self, task, before):
        await self.checkpoint("fallback_inspection")
        self.inspected = True
        return {"passed": True, "changed_protected_files": []}

    async def destroy(self):
        await self.checkpoint("destroy")
        self.destroyed = True

    async def close(self):
        await self.checkpoint("agent_close")
        self.closed = True


async def cancel_repeatedly_then_release(task, lifecycle):
    await asyncio.wait_for(lifecycle.entered.wait(), timeout=2)
    task.cancel()
    await asyncio.sleep(0)
    task.cancel()
    await asyncio.sleep(0)
    assert not task.done(), "Caller must await finalization before propagating cancellation"
    lifecycle.release.set()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(task, timeout=2)
    assert lifecycle.inspected
    assert lifecycle.destroyed
    assert lifecycle.closed


@pytest.mark.parametrize("pause", ["fallback_inspection", "destroy", "agent_close"])
async def test_trial_finalization_survives_repeated_cancellation(tmp_path, pause):
    lifecycle = ControlledLifecycle(pause)
    folder = tmp_path / "trial"
    task = asyncio.create_task(
        run_trial(
            load_tasks("T02")[0],
            1,
            "fake",
            "test",
            folder,
            lambda: lifecycle,
            lambda: lifecycle,
            settle_seconds=0,
        )
    )
    await cancel_repeatedly_then_release(task, lifecycle)
    result = json.loads((folder / "result.json").read_text())
    if pause == "fallback_inspection":
        assert result["failure_class"] == "infra_error"
        assert "Model disconnected" in result["error"]
    else:
        # Cleanup interruption cannot erase a verdict already verified on the VM.
        assert result["passed"] is True
        assert result["termination"] == "agent_done"
        assert result["failure_class"] is None


@pytest.mark.parametrize("pause", ["model", "destroy", "agent_close"])
async def test_suite_finalization_survives_repeated_cancellation(tmp_path, pause):
    lifecycle = ControlledLifecycle(pause)
    output = tmp_path / "suite"
    suite = asyncio.create_task(
        run_suite(
            load_tasks("T02"),
            trials=2,
            concurrency=1,
            model="fake",
            mode="test",
            output=output,
            backend_factory=lambda: lifecycle,
            agent_factory=lambda: lifecycle,
            settle_seconds=0,
        )
    )
    await cancel_repeatedly_then_release(suite, lifecycle)
    manifest = json.loads((output / "results.json").read_text())
    result = json.loads((output / "T02/1/result.json").read_text())
    assert manifest["status"] == "interrupted"
    assert manifest["records"] == [result]
    assert not (output / "T02/2").exists()
    if pause == "model":
        assert result["failure_class"] == "infra_error"
        assert "CancelledError" in result["error"]
    else:
        assert result["passed"] is True
        assert result["termination"] == "agent_done"
