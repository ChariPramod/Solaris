import asyncio
import json
from dataclasses import replace

import pytest

from gauntlet.agent.claude import DryRunAgent
from gauntlet.harness.backends import DryRunDesktop, InvalidAction
from gauntlet.harness.pricing import Pricing
from gauntlet.harness.runner import run_suite, run_trial
from gauntlet.models import Action, Decision, load_tasks


class Desktop(DryRunDesktop):
    def __init__(self, failure=None):
        super().__init__()
        self.failure = failure
        self.destroyed = False
        self.calls = []

    async def setup(self, task):
        await super().setup(task)
        if self.failure == "setup":
            raise RuntimeError("Setup failed")

    async def screenshot(self):
        return b"static image bytes"

    async def execute(self, action):
        self.calls.append(action)
        if action.kind == "write":
            (self.root / "out/note.txt").write_text(action.params["text"])
        elif action.kind == "invalid":
            raise InvalidAction("Out of bounds")

    async def destroy(self):
        await asyncio.sleep(0.01)
        self.destroyed = True
        await super().destroy()
        if self.failure == "cleanup":
            raise RuntimeError("Destroy failed")


class SequenceAgent(DryRunAgent):
    def __init__(self, *actions):
        self.actions = iter(actions)
        self.errors = []

    async def next_action(self, screenshot_jpeg, task_prompt, last_error=None):
        self.errors.append(last_error)
        action = next(self.actions, Action("done"))
        return Decision(action, {"action": action.kind}, tokens_in=10, tokens_out=2)


@pytest.mark.parametrize(
    "ending,status,expected",
    [
        ("done", "estimated", 0.00006),
        ("invalid_response", "estimated", 0.00006),
        ("missing_usage", "missing_usage", None),
        ("transport_error", "unreported_request", None),
        ("timeout", "unreported_request", None),
    ],
)
async def test_costs_include_all_responses_and_unknown_requests(tmp_path, ending, status, expected):
    class PaidAgent(DryRunAgent):
        step = 0

        async def next_action(self, *args):
            self.step += 1
            if self.step == 2 and ending == "transport_error":
                raise RuntimeError("Lost API response")
            if self.step == 2 and ending == "timeout":
                await asyncio.sleep(30)
            action = Action(
                "screenshot"
                if self.step == 1
                else ("invalid_response" if ending == "invalid_response" else "done")
            )
            usage = (
                None
                if ending == "missing_usage" and self.step == 1
                else {
                    "input": 10,
                    "output": 2,
                }
            )
            return Decision(action, {"recorded": True}, 10, 2, usage)

    desktop = Desktop()
    task = replace(load_tasks("T02")[0], max_seconds=1)
    rates = Pricing("openai", "fake", "Synthetic rates", {"input": 1, "output": 10}, 1000)
    result = await run_trial(
        task,
        1,
        "fake",
        "test",
        tmp_path / "cost",
        lambda: desktop,
        PaidAgent,
        settle_seconds=0,
        pricing=rates,
    )
    assert result.cost_status == status
    assert result.cost_usd == expected
    assert desktop.destroyed
    events = [
        json.loads(line) for line in (tmp_path / "cost/actions.jsonl").read_text().splitlines()
    ]
    assert events[0]["cost_usd"] == (None if ending == "missing_usage" else 0.00003)
    assert result.usage["output"] == (4 if ending in {"done", "invalid_response"} else 2)


async def test_suite_preserves_exact_pricing_assumptions(tmp_path):
    rates = Pricing("openai", "fake", "Synthetic rates", {"input": 1, "output": 10}, 1000)
    run = await run_suite(
        load_tasks("T02"),
        trials=1,
        concurrency=1,
        model="fake",
        mode="test",
        output=tmp_path / "suite",
        backend_factory=Desktop,
        agent_factory=DryRunAgent,
        settle_seconds=0,
        pricing=rates,
    )
    assert run["configuration"]["pricing"]["usd_per_million"] == rates.usd_per_million
    assert run["configuration"]["pricing"]["source"] == "Synthetic rates"
    assert run["records"][0]["cost_status"] == "missing_usage"


async def trial(tmp_path, desktop, agent=None, task=None):
    return await run_trial(
        task or load_tasks("T02")[0],
        1,
        "fake",
        "test",
        tmp_path / "trial",
        lambda: desktop,
        lambda: agent or DryRunAgent(),
        settle_seconds=0,
    )


async def test_agent_claim_cannot_pass_verifier(tmp_path):
    desktop = Desktop()
    result = await trial(tmp_path, desktop)
    assert result.failure_class == "premature_done"
    assert not result.passed
    assert desktop.destroyed


async def test_success_requires_actual_file_and_logs_usage(tmp_path):
    agent = SequenceAgent(Action("write", {"text": "Solari eval run 1"}), Action("done"))
    desktop = Desktop()
    result = await trial(tmp_path, desktop, agent)
    assert result.passed
    assert result.tokens_in == 20
    assert result.tokens_out == 4
    assert result.failure_class is None
    events = [
        json.loads(line) for line in (tmp_path / "trial/actions.jsonl").read_text().splitlines()
    ]
    assert events[0]["response"] == {"action": "write"}
    assert (tmp_path / "trial/001.jpg").exists()
    assert desktop.destroyed


async def test_setup_failure_still_destroys_and_records(tmp_path):
    desktop = Desktop("setup")
    result = await trial(tmp_path, desktop)
    assert result.failure_class == "infra_error"
    assert desktop.destroyed
    assert (tmp_path / "trial/result.json").exists()


async def test_cleanup_failure_is_visible_without_changing_verdict(tmp_path):
    result = await trial(tmp_path, Desktop("cleanup"))
    assert "Destroy failed" in result.cleanup_error
    assert result.failure_class == "premature_done"


async def test_invalid_action_feedback_reaches_agent(tmp_path):
    agent = SequenceAgent(Action("invalid"), Action("done"))
    await trial(tmp_path, Desktop(), agent)
    assert agent.errors == [None, "Out of bounds"]


async def test_step_limit_and_repetition_detection(tmp_path):
    task = replace(load_tasks("T02")[0], max_steps=3)
    agent = SequenceAgent(*[Action("wait")] * 10)
    result = await trial(tmp_path, Desktop(), agent, task)
    assert result.termination == "max_steps"
    assert result.failure_class == "stuck_loop"
    assert result.steps == 3


async def test_wall_limit_interrupts_model_and_destroys(tmp_path):
    class SlowAgent(DryRunAgent):
        async def next_action(self, *args):
            await asyncio.sleep(60)

    task = replace(load_tasks("T02")[0], max_seconds=0.02)
    desktop = Desktop()
    result = await trial(tmp_path, desktop, SlowAgent(), task)
    assert result.termination == "max_seconds"
    assert result.failure_class == "timeout"
    assert desktop.destroyed


async def test_concurrency_is_bounded_and_results_incremental(tmp_path):
    active = peak = 0
    output = tmp_path / "run"

    class CountedDesktop(Desktop):
        async def start(self, task):
            nonlocal active, peak
            active += 1
            peak = max(peak, active)
            await asyncio.sleep(0.01)
            await super().start(task)

        async def destroy(self):
            nonlocal active
            await super().destroy()
            active -= 1

    observed = []

    def on_result(result):
        observed.append(len(json.loads((output / "results.json").read_text())["records"]))

    manifest = await run_suite(
        load_tasks("T01,T02"),
        trials=3,
        concurrency=2,
        model="fake",
        mode="test",
        output=output,
        backend_factory=CountedDesktop,
        agent_factory=DryRunAgent,
        on_result=on_result,
        settle_seconds=0,
    )
    assert peak == 2
    assert active == 0
    assert observed == [1, 2, 3, 4, 5, 6]
    assert len(manifest["records"]) == 6
    assert manifest["status"] == "complete"


async def test_cancelling_suite_preserves_trial_and_waits_for_cleanup(tmp_path):
    entered = asyncio.Event()
    desktop = Desktop()

    class WaitingAgent(DryRunAgent):
        async def next_action(self, *args):
            entered.set()
            await asyncio.sleep(60)

    output = tmp_path / "cancelled"
    suite = asyncio.create_task(
        run_suite(
            load_tasks("T02"),
            trials=2,
            concurrency=1,
            model="fake",
            mode="test",
            output=output,
            backend_factory=lambda: desktop,
            agent_factory=WaitingAgent,
            settle_seconds=0,
        )
    )
    await asyncio.wait_for(entered.wait(), timeout=2)
    suite.cancel()
    with pytest.raises(asyncio.CancelledError):
        await suite
    assert desktop.destroyed
    manifest = json.loads((output / "results.json").read_text())
    assert manifest["status"] == "interrupted"
    assert len(manifest["records"]) == 1
    assert "CancelledError" in manifest["records"][0]["error"]


async def test_model_crash_still_records_protected_file_damage(tmp_path):
    desktop = Desktop()

    class DamagingAgent(DryRunAgent):
        async def next_action(self, *args):
            (desktop.root / "docs/contacts.txt").unlink()
            raise RuntimeError("API disconnected")

    result = await trial(tmp_path, desktop, DamagingAgent())
    assert result.failure_class == "infra_error"
    assert result.destructive_actions == 1
    assert desktop.destroyed


async def test_manifest_preserves_task_definitions_and_provenance(tmp_path):
    task = load_tasks("T02")[0]
    output = tmp_path / "recorded"
    manifest = await run_suite(
        [task],
        trials=1,
        concurrency=1,
        model="fake",
        mode="test",
        output=output,
        backend_factory=Desktop,
        agent_factory=DryRunAgent,
        configuration={"template": "office"},
        settle_seconds=0,
    )
    assert manifest["schema_version"] == 2
    recorded = manifest["tasks"][task.id]
    assert recorded["sha256"] == task.fingerprint
    assert recorded["definition"]["prompt"] == task.prompt
    assert manifest["configuration"]["template"] == "office"
    assert "fixtures/assets/invoice.pdf" in manifest["provenance"]["package_files_sha256"]
    assert json.loads((output / "T02/1/task.json").read_text()) == recorded
    assert "contacts.txt" in json.loads((output / "T02/1/baseline.json").read_text())


async def test_invalid_suite_is_rejected_before_any_output_or_vm(tmp_path):
    def never_allocate():
        raise AssertionError("Must not allocate a desktop")

    for tasks in ([], [replace(load_tasks("T02")[0], id="../outside")]):
        with pytest.raises(ValueError):
            await run_suite(
                tasks,
                trials=1,
                concurrency=1,
                model="fake",
                mode="test",
                output=tmp_path / "invalid",
                backend_factory=never_allocate,
                agent_factory=DryRunAgent,
            )
        assert not (tmp_path / "invalid").exists()


async def test_unusable_model_output_is_logged_and_not_excluded_as_infrastructure(tmp_path):
    desktop = Desktop()
    agent = SequenceAgent(Action("invalid_response", {"error": "Missing action field"}))
    result = await trial(tmp_path, desktop, agent)
    assert result.termination == "invalid_response"
    assert result.failure_class == "invalid_response"
    assert result.tokens_in == 10
    assert result.steps == 1
    assert desktop.calls == []
    log = json.loads((tmp_path / "trial/actions.jsonl").read_text())
    assert log["response"] == {"action": "invalid_response"}
    assert desktop.destroyed
