import asyncio
import hashlib
import json
import os
import time
from collections.abc import Callable
from dataclasses import asdict
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from uuid import uuid4

from gauntlet.harness.backends import InvalidAction
from gauntlet.harness.lifecycle import LifecycleLog
from gauntlet.harness.pricing import Pricing
from gauntlet.harness.provenance import provenance
from gauntlet.harness.scoring import classify, summarize
from gauntlet.models import Task, TrialResult, validate_task


def atomic_json(path: Path, data: dict) -> None:
    temporary = path.with_suffix(".tmp")
    with temporary.open("w", encoding="utf-8") as stream:
        stream.write(json.dumps(data, indent=2) + "\n")
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)


async def finish_despite_cancellation(finalization) -> None:
    """Own finalization until it finishes, then propagate any caller cancellation.

    Shielding alone leaves cleanup running in the background when the caller
    exits. Retain and await the task even if cancellation is requested again.
    Finalization retains its own timeouts so an unresponsive backend is bounded.
    """
    task = asyncio.create_task(finalization)
    interrupted = False
    while not task.done():
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError:
            interrupted = True
    task.result()
    if interrupted:
        raise asyncio.CancelledError


async def run_trial(
    task: Task,
    trial: int,
    model: str,
    mode: str,
    folder: Path,
    backend_factory: Callable,
    agent_factory: Callable,
    settle_seconds: float = 0.5,
    setup_seconds: float = 240,
    cleanup_seconds: float = 90,
    pricing: Pricing | None = None,
    run_id: str | None = None,
) -> TrialResult:
    folder.mkdir(parents=True)
    atomic_json(folder / "task.json", {"definition": asdict(task), "sha256": task.fingerprint})
    result = TrialResult(task.id, task.tier, trial, model, mode, artifacts=f"{task.id}/{trial}")
    backend = agent = None
    before = None
    stuck = False
    fingerprints = []
    cost = Decimal(0)
    result.cost_status = "estimated" if pricing else "missing_pricing"
    request_pending = False
    lifecycle = LifecycleLog(folder, run_id=run_id, task_id=task.id, trial=trial)
    started = time.monotonic()
    stage = "desktop_start"
    try:
        lifecycle.record("trial_started", mode=mode, model=model)
        backend = backend_factory()
        if hasattr(backend, "track_lifecycle"):
            backend.track_lifecycle(lifecycle.record, run_id=run_id, trial=trial)
        async with asyncio.timeout(setup_seconds):
            lifecycle.record("stage_started", stage=stage)
            boot_started = time.monotonic()
            await backend.start(task)
            result.vm_boot_ms = (time.monotonic() - boot_started) * 1000
            stage = "setup"
            lifecycle.record("stage_started", stage=stage)
            await backend.setup(task)
            stage = "baseline"
            lifecycle.record("stage_started", stage=stage)
            before = await backend.baseline()
            atomic_json(folder / "baseline.json", before)
            lifecycle.record("prepared")
        stage = "model"
        agent = agent_factory()
        last_error = None
        try:
            async with asyncio.timeout(task.max_seconds) as task_deadline:
                result.termination = "max_steps"
                for step in range(1, task.max_steps + 1):
                    stage = "screenshot"
                    screenshot_started = time.monotonic()
                    screen = await backend.screenshot()
                    result.screenshot_ms.append((time.monotonic() - screenshot_started) * 1000)
                    filename = f"{step:03}.jpg"
                    (folder / filename).write_bytes(screen)
                    stage = "model"
                    request_pending = True
                    decision = await agent.next_action(screen, task.prompt, last_error)
                    request_pending = False
                    last_error = None
                    result.steps = step
                    result.tokens_in += decision.tokens_in
                    result.tokens_out += decision.tokens_out
                    for category, tokens in (decision.usage or {}).items():
                        result.usage[category] = result.usage.get(category, 0) + tokens
                    step_cost, cost_status = (
                        pricing.estimate(decision.usage) if pricing else (None, "missing_pricing")
                    )
                    if mode == "dry-run":
                        step_cost, cost_status = Decimal(0), "dry_run"
                    if step_cost is None:
                        result.cost_status = cost_status
                    else:
                        cost += step_cost
                    action = decision.action
                    result.actions[action.kind] = result.actions.get(action.kind, 0) + 1
                    event = {
                        "step": step,
                        "screenshot": filename,
                        "action": asdict(action),
                        "response": decision.raw,
                        "tokens_in": decision.tokens_in,
                        "tokens_out": decision.tokens_out,
                        "usage": decision.usage,
                        "cost_usd": float(step_cost) if step_cost is not None else None,
                        "cost_status": cost_status,
                    }
                    # Flush before execution so timed-out actions remain reviewable.
                    with (folder / "actions.jsonl").open("a") as log:
                        log.write(json.dumps(event) + "\n")
                    if action.kind == "done":
                        result.termination = "agent_done"
                        break
                    if action.kind == "invalid_response":
                        result.termination = "invalid_response"
                        result.failure_stage = stage
                        result.error = action.params.get("error", "Unusable model response")
                        break
                    fingerprint = (
                        hashlib.sha256(screen).hexdigest(),
                        json.dumps(asdict(action), sort_keys=True),
                    )
                    fingerprints.append(fingerprint)
                    stuck = stuck or (len(fingerprints) >= 3 and len(set(fingerprints[-3:])) == 1)
                    try:
                        stage = "action"
                        await backend.execute(action)
                    except InvalidAction as exc:
                        last_error = str(exc)
                        with (folder / "actions.jsonl").open("a") as log:
                            log.write(json.dumps({"step": step, "action_error": last_error}) + "\n")
                    stage = "settle"
                    await asyncio.sleep(settle_seconds)
        except TimeoutError:
            # A provider or desktop may time out before the benchmark deadline.
            # Those failures belong to infrastructure and must not count as a
            # model exhausting its allotted task time.
            if not task_deadline.expired():
                raise
            result.termination = "max_seconds"
            result.failure_stage = stage
        stage = "verification"
        lifecycle.record("stage_started", stage=stage)
        async with asyncio.timeout(30):
            result.evidence = await backend.inspect(task, before)
            result.destructive_actions = len(result.evidence["changed_protected_files"])
            result.passed = bool(result.evidence["passed"])
        # Screenshot failures must not erase a completed state verification.
        try:
            stage = "screenshot"
            async with asyncio.timeout(10):
                (folder / "final.jpg").write_bytes(await backend.screenshot())
        except Exception as exc:
            result.evidence["final_screenshot_error"] = f"{type(exc).__name__}: {exc}"
    except asyncio.CancelledError:
        result.termination = "error"
        result.failure_stage = stage
        result.error = "CancelledError: run interrupted"
        raise
    except Exception as exc:
        result.termination = "error"
        result.failure_stage = stage
        result.error = f"{type(exc).__name__}: {exc}"
    finally:

        async def finalize():
            result.desktop_id = getattr(getattr(backend, "desktop", None), "id", None)

            def note(event, **details):
                # Logging must never prevent destruction or result persistence.
                try:
                    lifecycle.record(event, desktop_id=result.desktop_id, **details)
                except OSError as exc:
                    result.evidence["lifecycle_error"] = f"{type(exc).__name__}: {exc}"

            # Model errors and cancellation can happen after harmful actions. Still
            # collect machine evidence when setup produced a valid baseline.
            if backend is not None and before is not None and not result.evidence:
                note("stage_started", stage="verification")
                try:
                    async with asyncio.timeout(15):
                        result.evidence.update(await backend.inspect(task, before))
                        result.destructive_actions = len(result.evidence["changed_protected_files"])
                except Exception as exc:
                    result.evidence["inspection_error"] = f"{type(exc).__name__}: {exc}"
            if backend is not None:
                note("cleanup_started")
                try:
                    async with asyncio.timeout(cleanup_seconds):
                        await backend.destroy()
                    note("desktop_destroyed")
                except Exception as exc:
                    result.cleanup_error = (
                        f"{type(exc).__name__}: {exc}; desktop_id={result.desktop_id}"
                    )
                    note("cleanup_failed")
            if agent is not None:
                try:
                    async with asyncio.timeout(10):
                        await agent.close()
                except Exception as exc:
                    result.evidence["agent_close_error"] = f"{type(exc).__name__}: {exc}"
            result.wall_seconds = round(time.monotonic() - started, 3)
            result.failure_class = classify(
                passed=result.passed,
                termination=result.termination,
                task_id=task.id,
                destructive_actions=result.destructive_actions,
                stuck=stuck,
            )
            if request_pending:
                result.cost_status = "unreported_request"
            if result.cost_status == "estimated":
                result.cost_usd = float(cost)
            if mode == "dry-run":
                result.cost_usd = 0
                result.cost_status = "dry_run"
            atomic_json(folder / "result.json", asdict(result))

        await finish_despite_cancellation(finalize())
    return result


async def run_suite(
    tasks: list[Task],
    *,
    trials: int,
    concurrency: int,
    model: str,
    mode: str,
    output: Path,
    backend_factory: Callable,
    agent_factory: Callable,
    on_result: Callable | None = None,
    settle_seconds: float = 0.5,
    configuration: dict | None = None,
    setup_seconds: float = 240,
    pricing: Pricing | None = None,
    max_infra_failures: int | None = None,
) -> dict:
    if max_infra_failures is not None and (
        type(max_infra_failures) is not int or max_infra_failures < 1
    ):
        raise ValueError("Maximum infrastructure failures must be a positive integer")
    if trials < 1 or concurrency < 1:
        raise ValueError("Trials and concurrency must be positive")
    if setup_seconds <= 0:
        raise ValueError("Preparation timeout must be positive")
    if not tasks or len({task.id for task in tasks}) != len(tasks):
        raise ValueError("A run requires a nonempty set of distinct tasks")
    if pricing and pricing.model != model:
        raise ValueError("Pricing model must match the run model")
    for task in tasks:
        validate_task(task)
    output.mkdir(parents=True, exist_ok=False)
    semaphore = asyncio.Semaphore(concurrency)
    records = []
    infrastructure_failures = 0
    manifest = {
        "schema_version": 2,
        "run_id": str(uuid4()),
        "created_at": datetime.now(UTC).isoformat(),
        "mode": mode,
        "model": model,
        "trials_per_task": trials,
        "task_ids": [t.id for t in tasks],
        "planned_trials": len(tasks) * trials,
        "status": "running",
        "records": records,
        "tasks": {
            task.id: {"definition": asdict(task), "sha256": task.fingerprint} for task in tasks
        },
        "provenance": provenance(),
        "configuration": {
            **(configuration or {}),
            "concurrency": concurrency,
            "settle_seconds": settle_seconds,
            "setup_seconds": setup_seconds,
            "max_infra_failures": max_infra_failures,
            "pricing": asdict(pricing) if pricing else None,
            "cost_scope": "Estimated model API token charges; excludes Solari and other fees",
        },
    }

    def persist():
        manifest["summary"] = summarize(records, trials, manifest["task_ids"])
        atomic_json(output / "results.json", manifest)

    async def worker(task, trial):
        nonlocal infrastructure_failures
        async with semaphore:
            # Check after acquiring capacity: jobs already running finish and
            # clean up normally, while queued jobs never allocate a desktop.
            if "stop_reason" in manifest:
                return
            folder = output / task.id / str(trial)
            try:
                result = await run_trial(
                    task,
                    trial,
                    model,
                    mode,
                    folder,
                    backend_factory,
                    agent_factory,
                    settle_seconds,
                    setup_seconds=setup_seconds,
                    pricing=pricing,
                    run_id=manifest["run_id"],
                )
            finally:
                # A cancelled trial still has its result written by run_trial's finally.
                if (folder / "result.json").exists():
                    record = json.loads((folder / "result.json").read_text())
                    records.append(record)
                    records.sort(key=lambda r: (r["task_id"], r["trial"]))
                    # One finalized trial counts once even if execution and
                    # cleanup both failed. This is cumulative across the run.
                    if record["failure_class"] == "infra_error" or record.get("cleanup_error"):
                        infrastructure_failures += 1
                        if (
                            max_infra_failures is not None
                            and infrastructure_failures >= max_infra_failures
                            and "stop_reason" not in manifest
                        ):
                            manifest["stop_reason"] = {
                                "kind": "max_infra_failures",
                                "limit": max_infra_failures,
                                "observed_failures": infrastructure_failures,
                                "task_id": task.id,
                                "trial": trial,
                            }
                    persist()
            if on_result:
                on_result(result)

    persist()
    jobs = [
        asyncio.create_task(worker(task, trial)) for task in tasks for trial in range(1, trials + 1)
    ]
    try:
        # Unlike gather, wait does not cancel children when this coroutine is
        # interrupted. Cancel each worker once below, allowing cleanup to finish.
        done, _ = await asyncio.wait(jobs, return_when=asyncio.FIRST_EXCEPTION)
        for job in done:
            job.result()
        manifest["status"] = "stopped" if "stop_reason" in manifest else "complete"
    finally:

        async def finalize_suite():
            if manifest["status"] not in {"complete", "stopped"}:
                manifest["status"] = "interrupted"
                for job in jobs:
                    job.cancel()
                await asyncio.gather(*jobs, return_exceptions=True)
            persist()

        await finish_despite_cancellation(finalize_suite())
    return manifest
