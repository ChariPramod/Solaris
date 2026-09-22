"""Read-only evidence comparisons and conservative regression gates.

Every score is recomputed from validated final records. Slot transitions describe
observations, not paired experimental controls or statistical significance.
"""

import json
import math
import re
from pathlib import Path
from statistics import mean
from uuid import UUID

from gauntlet.harness.audit import audit_run
from gauntlet.harness.recovery import read_artifact, validate_record
from gauntlet.harness.scoring import classify
from gauntlet.models import Task, validate_task


def _inventory(root, run):
    """Bound all audited evidence and detect ordinary writes during assessment."""
    task_ids, trials = run.get("task_ids"), run.get("trials_per_task")
    if (
        not isinstance(task_ids, list)
        or not task_ids
        or any(
            not isinstance(t, str) or not re.fullmatch(r"T\d{2,3}", t, re.ASCII) for t in task_ids
        )
        or len(set(task_ids)) != len(task_ids)
        or type(trials) is not int
        or trials < 1
        or len(task_ids) * trials > 10_000
    ):
        raise ValueError("Assessment requires distinct tasks and 1–10,000 planned slots")
    paths = [root / "results.json"]
    for task_id in task_ids:
        parent = root / task_id
        if parent.is_symlink():
            raise ValueError("Task directories must not be symlinks")
        for trial in range(1, trials + 1):
            directory = parent / str(trial)
            if directory.is_symlink():
                raise ValueError("Trial directories must not be symlinks")
            paths.extend(
                directory / name for name in ("task.json", "result.json", "lifecycle.jsonl")
            )
    inventory, total = {}, 0
    for path in paths:
        if path.is_symlink():
            raise ValueError("Assessment evidence must not be symlinked")
        if not path.exists():
            continue
        if not path.is_file():
            raise ValueError("Assessment evidence must be regular files")
        stat = path.stat()
        total += stat.st_size
        if stat.st_size > 16 * 1024 * 1024 or total > 128 * 1024 * 1024:
            raise ValueError("Assessment evidence exceeds 16 MiB/file or 128 MiB total")
        inventory[str(path)] = (stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)
    return inventory


def _json(path: Path):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError(f"Duplicate JSON key: {key}")
            result[key] = value
        return result

    def invalid(value):
        raise ValueError(f"Non-finite JSON number: {value}")

    def number(value):
        parsed = float(value)
        if not math.isfinite(parsed):
            invalid(value)
        return parsed

    try:
        return json.loads(
            read_artifact(path), object_pairs_hook=pairs, parse_constant=invalid, parse_float=number
        )
    except RecursionError as exc:
        raise ValueError("Evidence JSON nesting exceeds supported depth") from exc


def _load(folder: Path) -> dict:
    """Reject ambiguous evidence; retain incomplete slots as explicitly missing."""
    try:
        if folder.is_symlink():
            raise ValueError("Run directory must not be a symlink")
        root = folder.resolve(strict=True)
        original = read_artifact(root / "results.json")
        run = _json(root / "results.json")
        if not isinstance(run, dict) or type(run.get("schema_version")) is not int:
            raise ValueError("Assessment requires a schema 2 run")
        if run["schema_version"] != 2:
            raise ValueError("Assessment requires a schema 2 run")
        inventory = _inventory(root, run)
        audit = audit_run(root)
        errors = [item["code"] for item in audit["findings"] if item["severity"] == "error"]
        if errors:
            raise ValueError("Invalid evidence: " + ", ".join(sorted(set(errors))))
        if audit["unindexed_results"]:
            raise ValueError("Unindexed results require a recovery export before assessment")
        UUID(run["run_id"])
        if run.get("mode") not in {"live", "dry-run"} or not isinstance(run.get("model"), str):
            raise ValueError("Run must record a valid mode and model")
        if not run["model"].strip():
            raise ValueError("Run model must not be empty")
        if not isinstance(run.get("configuration"), dict):
            raise ValueError("Run configuration is required")
        if run["mode"] == "live" and not run["configuration"].get("template"):
            raise ValueError("Live runs require a recorded desktop template")
        if not isinstance(run.get("tasks"), dict) or set(run["tasks"]) != set(run["task_ids"]):
            raise ValueError("Exact saved task snapshots are required")
        tasks = {}
        for task_id, snapshot in run["tasks"].items():
            task = Task(**snapshot["definition"])
            validate_task(task)
            if task.id != task_id or task.fingerprint != snapshot["sha256"]:
                raise ValueError("Saved task fingerprint or identity does not match")
            tasks[task_id] = task
        provenance = run.get("provenance")
        if not isinstance(provenance, dict):
            raise ValueError("Recorded provenance is required")
        hashes = provenance.get("package_files_sha256")
        if not isinstance(hashes, dict) or any(
            not isinstance(key, str)
            or not isinstance(value, str)
            or re.fullmatch(r"[0-9a-f]{64}", value) is None
            for key, value in hashes.items()
        ):
            raise ValueError("Invalid source fingerprints")
        benchmark = {k: v for k, v in hashes.items() if k.startswith(("fixtures/", "verifiers/"))}
        if not any(k.startswith("fixtures/") for k in benchmark) or not any(
            k.startswith("verifiers/") for k in benchmark
        ):
            raise ValueError("Fixture and verifier fingerprints are required")
        for task_id in run["task_ids"]:
            parent = root / task_id
            if parent.is_symlink():
                raise ValueError("Task directories must not be symlinks")
            for trial in range(1, run["trials_per_task"] + 1):
                directory = parent / str(trial)
                if directory.is_symlink():
                    raise ValueError("Trial directories must not be symlinks")
                for name in ("task.json", "result.json", "lifecycle.jsonl"):
                    if (directory / name).is_symlink():
                        raise ValueError("Assessment evidence must not be symlinked")
                if (directory / "task.json").exists():
                    if _json(directory / "task.json") != run["tasks"][task_id]:
                        raise ValueError("Trial task snapshot differs from manifest")
        for record in run["records"]:
            validate_record(record, tasks[record["task_id"]])
            directory = root / record["task_id"] / str(record["trial"])
            if _json(directory / "task.json") != run["tasks"][record["task_id"]]:
                raise ValueError("Final record requires its exact saved task snapshot")
            if _json(directory / "result.json") != record:
                raise ValueError("Final record changed during assessment")
            if record["failure_class"] not in {
                None,
                "infra_error",
                "injection_followed",
                "destructive",
                "invalid_response",
                "stuck_loop",
                "timeout",
                "premature_done",
                "wrong_target",
            }:
                raise ValueError("Unknown failure classification")
            if (record["termination"] == "error") != (record["failure_class"] == "infra_error"):
                raise ValueError("Infrastructure classification conflicts with termination")
            expected_class = classify(
                passed=record["passed"],
                termination=record["termination"],
                task_id=record["task_id"],
                destructive_actions=record["destructive_actions"],
                stuck=record["failure_class"] == "stuck_loop",
            )
            if record["failure_class"] != expected_class:
                raise ValueError("Failure classification contradicts recorded outcome or damage")
        lineage = {run["run_id"]}
        if run.get("recovery"):
            source_id = run["recovery"]["source_run_id"]
            UUID(source_id)
            lineage.add(source_id)
        if read_artifact(root / "results.json") != original or _inventory(root, run) != inventory:
            raise ValueError("Evidence changed during assessment; retry after the run stops")
        return {
            "run": run,
            "audit": audit,
            "benchmark": benchmark,
            "lineage": lineage,
            "folder": str(root),
        }
    except (KeyError, TypeError, AttributeError, RuntimeError, OverflowError) as exc:
        raise ValueError(f"Invalid assessment evidence: {exc}") from exc


def _descriptor(loaded):
    run = loaded["run"]
    return {
        "folder": loaded["folder"],
        **{k: run.get(k) for k in ("run_id", "model", "mode", "status")},
    }


def _metrics(records, planned):
    eligible = [r for r in records if r["failure_class"] != "infra_error"]
    costs = [r["cost_usd"] for r in records]
    complete = len(records) == planned
    total_cost = sum(costs) if complete and all(c is not None for c in costs) else None
    if total_cost is not None:
        try:
            if not math.isfinite(total_cost):
                raise ValueError("Aggregate model cost exceeds supported finite range")
        except OverflowError as exc:
            raise ValueError("Aggregate model cost exceeds supported finite range") from exc
    return {
        "planned_trials": planned,
        "recorded_trials": len(records),
        "eligible_trials": len(eligible),
        "passed_trials": sum(r["passed"] for r in eligible),
        "pass_rate": mean(r["passed"] for r in eligible) if eligible else None,
        "coverage_complete": complete,
        "infra_errors": len(records) - len(eligible),
        "cleanup_errors": sum(bool(r["cleanup_error"]) for r in records),
        "destructive_actions": sum(r["destructive_actions"] for r in records),
        "total_cost_usd": total_cost,
        "known_cost_trials": sum(c is not None for c in costs),
        "mean_wall_seconds": mean(r["wall_seconds"] for r in records) if records else None,
    }


def _warnings(loaded):
    result = [f"{item['code']}: {item['message']}" for item in loaded["audit"]["findings"]]
    if loaded["run"]["mode"] == "dry-run":
        result.append("Dry-run evidence is a plumbing check, not a benchmark result.")
    return result


def _compare(candidate, baseline):
    after, before = candidate["run"], baseline["run"]
    if candidate["lineage"] & baseline["lineage"]:
        raise ValueError(
            "Comparison requires independent runs, not the same run or recovery lineage"
        )
    for field in ("mode", "trials_per_task", "tasks"):
        if after[field] != before[field]:
            raise ValueError(f"Incompatible runs: different {field}")
    if after["configuration"].get("template") != before["configuration"].get("template"):
        raise ValueError("Incompatible runs: different desktop templates")
    if candidate["benchmark"] != baseline["benchmark"]:
        raise ValueError("Incompatible runs: different fixture or verifier fingerprints")
    differences = []
    for section in ("configuration", "provenance"):
        for key in sorted(set(after[section]) | set(before[section])):
            a, b = after[section].get(key), before[section].get(key)
            if a != b:
                differences.append({"field": f"{section}.{key}", "baseline": b, "candidate": a})
    if after["model"] != before["model"]:
        differences.append(
            {"field": "model", "baseline": before["model"], "candidate": after["model"]}
        )
    warnings = [*(_warnings(baseline)), *(_warnings(candidate))]
    warnings += [f"Configuration differs: {item['field']}" for item in differences]
    warnings.append(
        "Slot transitions compare observed outcomes; they do not establish statistical "
        "significance or identical stochastic conditions."
    )
    indexes = [{(r["task_id"], r["trial"]): r for r in run["records"]} for run in (before, after)]

    def outcome(row):
        if row is None or row["failure_class"] == "infra_error" or row["cleanup_error"]:
            return "inconclusive"
        return "pass" if row["passed"] else "fail"

    slots = []
    for task_id in sorted(after["task_ids"]):
        for trial in range(1, after["trials_per_task"] + 1):
            old, new = [outcome(index.get((task_id, trial))) for index in indexes]
            transition = (
                "inconclusive"
                if "inconclusive" in (old, new)
                else "unchanged"
                if old == new
                else "improved"
                if new == "pass"
                else "regressed"
            )
            slots.append(
                {
                    "task_id": task_id,
                    "trial": trial,
                    "baseline": old,
                    "candidate": new,
                    "transition": transition,
                }
            )

    def group(task_id=None):
        selected = [s for s in slots if task_id is None or s["task_id"] == task_id]
        metrics = [
            _metrics(
                [r for r in run["records"] if task_id is None or r["task_id"] == task_id],
                len(selected),
            )
            for run in (before, after)
        ]
        return {
            "baseline": metrics[0],
            "candidate": metrics[1],
            "transitions": {
                name: sum(s["transition"] == name for s in selected)
                for name in ("improved", "regressed", "unchanged", "inconclusive")
            },
        }

    return {
        "schema_version": 1,
        "candidate": _descriptor(candidate),
        "baseline": _descriptor(baseline),
        "warnings": warnings,
        "configuration_differences": differences,
        "summary": group(),
        "tasks": [{"task_id": task_id, **group(task_id)} for task_id in sorted(after["task_ids"])],
        "slots": slots,
    }


def compare_runs(candidate: Path, baseline: Path) -> dict:
    """Compare independent compatible evidence without writing or contacting services."""
    return _compare(_load(candidate), _load(baseline))


def validate_policy(policy: dict) -> dict:
    allowed = {
        "schema_version",
        "required_tasks",
        "min_pass_rate",
        "require_live",
        "max_regressions",
        "max_mean_wall_seconds",
        "max_total_cost_usd",
    }
    if not isinstance(policy, dict) or set(policy) - allowed:
        raise ValueError("Gate policy must be an object with only supported fields")
    if type(policy.get("schema_version")) is not int or policy["schema_version"] != 1:
        raise ValueError("Gate policy requires schema_version 1")
    result = {"required_tasks": [], "min_pass_rate": 1.0, "require_live": True, **policy}
    tasks = result["required_tasks"]
    if (
        not isinstance(tasks, list)
        or any(not isinstance(t, str) or not re.fullmatch(r"T\d{2,3}", t, re.ASCII) for t in tasks)
        or len(set(tasks)) != len(tasks)
    ):
        raise ValueError("required_tasks must contain distinct Txx task IDs")
    if type(result["require_live"]) is not bool:
        raise ValueError("require_live must be a boolean")
    for key in ("min_pass_rate", "max_mean_wall_seconds", "max_total_cost_usd", "max_regressions"):
        if key not in result:
            continue
        value = result[key]
        try:
            valid = type(value) in (float, int) and math.isfinite(value) and value >= 0
        except OverflowError:
            valid = False
        if not valid:
            raise ValueError(f"{key} must be finite and nonnegative")
        if key == "min_pass_rate" and value > 1:
            raise ValueError("min_pass_rate must be between zero and one")
        if key == "max_regressions" and type(value) is not int:
            raise ValueError("max_regressions must be an integer")
    return result


def evaluate_gate(folder: Path, policy: dict | Path, baseline: Path | None = None) -> dict:
    """Unknown, missing, unsafe or infrastructure-failed evidence cannot pass a gate."""
    policy = validate_policy(_json(policy) if isinstance(policy, Path) else policy)
    if "max_regressions" in policy and baseline is None:
        raise ValueError("max_regressions requires a baseline run")
    loaded = _load(folder)
    run = loaded["run"]
    metrics = _metrics(run["records"], len(run["task_ids"]) * run["trials_per_task"])
    checks = []

    def check(name, passed, actual, expected, message):
        checks.append(
            {
                "name": name,
                "passed": bool(passed),
                "actual": actual,
                "expected": expected,
                "message": message,
            }
        )

    check(
        "live_evidence",
        not policy["require_live"] or run["mode"] == "live",
        run["mode"],
        "live" if policy["require_live"] else "any",
        "Live evidence is required by default.",
    )
    check(
        "complete_coverage",
        metrics["coverage_complete"],
        metrics["recorded_trials"],
        metrics["planned_trials"],
        "Every planned slot must have a finalized result.",
    )
    successful_tasks = []
    for task_id in run["task_ids"]:
        rows = [r for r in run["records"] if r["task_id"] == task_id]
        if len(rows) == run["trials_per_task"] and all(
            r["passed"]
            and r["failure_class"] != "infra_error"
            and not r["cleanup_error"]
            and not r["destructive_actions"]
            for r in rows
        ):
            successful_tasks.append(task_id)
    check(
        "required_tasks",
        set(policy["required_tasks"]) <= set(successful_tasks),
        successful_tasks,
        policy["required_tasks"],
        "Every planned trial of each required workflow must pass without infrastructure, "
        "cleanup, or safety failures, independently of the overall pass-rate threshold.",
    )
    for field in ("infra_errors", "cleanup_errors", "destructive_actions"):
        check(
            field,
            metrics[field] == 0,
            metrics[field],
            0,
            "Must be zero across all recorded trials.",
        )
    check(
        "artifact_integrity",
        loaded["audit"]["healthy"],
        loaded["audit"]["healthy"],
        True,
        "Resolve audit findings before accepting evidence.",
    )
    rate = metrics["pass_rate"]
    check(
        "min_pass_rate",
        rate is not None and rate >= policy["min_pass_rate"],
        rate,
        policy["min_pass_rate"],
        "Eligible observed pass rate must meet the threshold.",
    )
    for field, metric in (
        ("max_mean_wall_seconds", "mean_wall_seconds"),
        ("max_total_cost_usd", "total_cost_usd"),
    ):
        if field in policy:
            value = metrics[metric]
            check(
                field,
                value is not None and value <= policy[field],
                value,
                policy[field],
                "Missing values fail; model token charges exclude desktop and other fees.",
            )
    comparison = _compare(loaded, _load(baseline)) if baseline is not None else None
    if comparison is not None and "max_regressions" in policy:
        transitions = comparison["summary"]["transitions"]
        check(
            "max_regressions",
            transitions["inconclusive"] == 0
            and transitions["regressed"] <= policy["max_regressions"],
            transitions,
            policy["max_regressions"],
            "Inconclusive comparisons cannot satisfy a regression limit.",
        )
    return {
        "schema_version": 1,
        "passed": all(c["passed"] for c in checks),
        "run": _descriptor(loaded),
        "policy": policy,
        "checks": checks,
        "warnings": _warnings(loaded),
        "comparison": comparison,
    }
