"""Read-only reconciliation of a run's local recovery artifacts.

An outstanding allocation is a cleanup candidate, never proof of a live VM.
The audit deliberately does not contact providers or modify evaluation scores.
"""

import json
import re
from datetime import datetime
from pathlib import Path
from uuid import UUID

_TASK_ID = re.compile(r"T\d{2,3}\Z", re.ASCII)
_MAX_BYTES = 16 * 1024 * 1024
_MAX_SLOTS = 10_000
_MAX_EVENTS = 50_000


def audit_run(folder: Path) -> dict:
    """Reconcile only validated planned trial paths and return JSON-safe findings."""
    report = {
        "healthy": True,
        "scope": "local artifacts only; no provider status verified",
        "status": "unknown",
        "counts": {"planned": 0, "recorded": 0, "finalized": 0, "unstarted": 0, "incomplete": 0},
        "findings": [],
        "cleanup_candidates": [],
        "unindexed_results": [],
    }

    def finding(severity, code, message, task_id=None, trial=None):
        item = {"severity": severity, "code": code, "message": message}
        if task_id is not None:
            item.update(task_id=task_id, trial=trial)
        report["findings"].append(item)

    def finish():
        report["healthy"] = not any(
            item["severity"] in {"warning", "error"} for item in report["findings"]
        )
        return report

    def read(path):
        resolved = path.resolve()
        if not resolved.is_relative_to(root):
            raise ValueError("Artifact resolves outside the run directory")
        if not resolved.exists():
            return None
        # Do not open special files (including FIFOs) or unbounded artifacts.
        if not resolved.is_file():
            raise ValueError("Artifact is not a regular file")
        if resolved.stat().st_size > _MAX_BYTES:
            raise ValueError("Artifact exceeds the 16 MiB audit limit")
        with resolved.open("rb") as stream:
            data = stream.read(_MAX_BYTES + 1)
        if len(data) > _MAX_BYTES:
            raise ValueError("Artifact exceeds the 16 MiB audit limit")
        return data.decode("utf-8")

    try:
        root = Path(folder).resolve()
        manifest_text = read(root / "results.json")
        manifest = json.loads(manifest_text) if manifest_text is not None else None
        if not isinstance(manifest, dict):
            raise ValueError("Run manifest is missing or not a JSON object")
        task_ids = manifest.get("task_ids")
        trials = manifest.get("trials_per_task")
        if (
            not isinstance(task_ids, list)
            or not task_ids
            or any(not isinstance(item, str) or not _TASK_ID.fullmatch(item) for item in task_ids)
            or len(set(task_ids)) != len(task_ids)
            or type(trials) is not int
            or trials < 1
            or len(task_ids) * trials > _MAX_SLOTS
        ):
            raise ValueError("Manifest must name distinct Txx tasks and 1–10,000 planned trials")
        records = manifest.get("records")
        if not isinstance(records, list) or len(records) > _MAX_SLOTS:
            raise ValueError("Manifest records must be a bounded list")
        run_id = manifest.get("run_id")
        if run_id is not None:
            if not isinstance(run_id, str):
                raise ValueError("Invalid manifest run_id")
            UUID(run_id)
    except (OSError, ValueError, RuntimeError) as exc:
        finding("error", "invalid_manifest", str(exc))
        return finish()

    status = manifest.get("status", "unknown")
    report["status"] = status if isinstance(status, str) else "unknown"
    expected = {(task_id, trial) for task_id in task_ids for trial in range(1, trials + 1)}
    report["counts"]["planned"] = len(expected)
    if manifest.get("planned_trials", len(expected)) != len(expected):
        finding(
            "error", "planned_count_mismatch", "Manifest planned_trials differs from its task plan"
        )
    if status == "running":
        finding(
            "info",
            "running_snapshot",
            "This is a snapshot of a running manifest; files may change during the audit. "
            "No process liveness or stale-run conclusion is made.",
        )

    def identity(record):
        if not isinstance(record, dict):
            return None
        task_id, trial = record.get("task_id"), record.get("trial")
        if not isinstance(task_id, str) or type(trial) is not int:
            return None
        return task_id, trial

    def validate_final(record, key):
        if (
            identity(record) != key
            or not isinstance(record.get("model"), str)
            or not isinstance(record.get("mode"), str)
            or type(record.get("passed")) is not bool
            or type(record.get("steps")) is not int
            or record["steps"] < 0
            or record.get("termination")
            not in {"agent_done", "max_steps", "max_seconds", "error", "invalid_response"}
            or not isinstance(record.get("evidence"), dict)
            or record.get("artifacts") != f"{key[0]}/{key[1]}"
            or any(
                field not in record
                or (record[field] is not None and not isinstance(record[field], str))
                for field in ("failure_class", "cleanup_error", "error", "desktop_id")
            )
        ):
            raise ValueError("Final result has missing or invalid completion fields")

    indexed = {}
    for record in records:
        key = identity(record)
        if key not in expected:
            finding(
                "error", "unexpected_record", "Manifest record is invalid or outside the task plan"
            )
            continue
        if key in indexed:
            finding("error", "duplicate_record", "Manifest repeats this trial", *key)
            continue
        indexed[key] = record
        try:
            validate_final(record, key)
        except (TypeError, ValueError) as exc:
            finding("error", "invalid_record", str(exc), *key)
        for field in ("model", "mode"):
            if field in manifest and record.get(field) != manifest[field]:
                finding(
                    "error",
                    "record_identity_mismatch",
                    f"Manifest record has a different {field}",
                    *key,
                )
    report["counts"]["recorded"] = len(indexed)

    for task_id, trial in sorted(expected):
        key = task_id, trial
        path = root / task_id / str(trial)
        record = indexed.get(key)
        try:
            if not path.resolve().is_relative_to(root):
                raise ValueError("Trial directory resolves outside the run directory")
            started = path.exists()
        except (OSError, ValueError, RuntimeError) as exc:
            finding("error", "unsafe_trial_path", str(exc), *key)
            report["counts"]["incomplete"] += 1
            continue
        result = None
        try:
            result_text = read(path / "result.json")
            if result_text is not None:
                result = json.loads(result_text)
                if identity(result) != key:
                    raise ValueError("Result identity does not match its planned trial")
                validate_final(result, key)
                if any(
                    field in manifest and result.get(field) != manifest[field]
                    for field in ("model", "mode")
                ):
                    raise ValueError("Result model or mode does not match the manifest")
        except (OSError, TypeError, ValueError, RuntimeError) as exc:
            result = None
            finding("error", "invalid_result", str(exc), *key)
        if result is not None:
            report["counts"]["finalized"] += 1
            if record is None:
                report["unindexed_results"].append(
                    {"task_id": task_id, "trial": trial, "path": f"{task_id}/{trial}/result.json"}
                )
                finding(
                    "warning", "unindexed_result", "Final result is absent from the manifest", *key
                )
            elif result != record:
                finding(
                    "error", "result_mismatch", "Result file differs from its manifest record", *key
                )
        elif started or record is not None:
            report["counts"]["incomplete"] += 1
            finding(
                "warning",
                "incomplete_trial",
                "Started or indexed trial has no valid final result",
                *key,
            )
        else:
            report["counts"]["unstarted"] += 1
        if record is not None and result is None:
            finding(
                "error", "missing_result", "Manifest record has no matching final result file", *key
            )

        events = []
        journal_present = False
        try:
            journal_text = read(path / "lifecycle.jsonl")
            journal_present = journal_text is not None
            if journal_present:
                lines = journal_text.splitlines()
                malformed = 0
                if len(lines) > _MAX_EVENTS:
                    raise ValueError("Lifecycle journal exceeds 50,000 events")
                for line in lines:
                    try:
                        event = json.loads(line)
                        if (
                            not isinstance(event, dict)
                            or type(event.get("schema_version")) is not int
                            or event["schema_version"] != 1
                            or identity(event) != key
                            or event.get("run_id") != run_id
                            or not isinstance(event.get("event"), str)
                            or not event["event"]
                            or not isinstance(event.get("time"), str)
                            or datetime.fromisoformat(event["time"]).tzinfo is None
                            or (
                                event.get("desktop_id") is not None
                                and (
                                    not isinstance(event["desktop_id"], str)
                                    or not event["desktop_id"]
                                )
                            )
                        ):
                            raise ValueError("Invalid event")
                        events.append(event)
                    except (TypeError, ValueError):
                        malformed += 1
                if malformed or (journal_text and not journal_text.endswith("\n")):
                    finding(
                        "warning",
                        "partial_journal",
                        f"Journal has {malformed} invalid lines or an unterminated final line; "
                        "valid events were preserved for this audit",
                        *key,
                    )
        except (OSError, ValueError, RuntimeError) as exc:
            finding("error", "invalid_journal", str(exc), *key)
        if run_id and started and not journal_present:
            finding(
                "warning", "missing_journal", "Trial has no lifecycle journal for this run", *key
            )

        outstanding = set()
        pending_creates = []
        cleanup_failed = False
        for event in events:
            name, desktop_id = event["event"], event.get("desktop_id")
            if name == "create_requested":
                pending_creates.append(event.get("attempt"))
            elif name == "create_rejected":
                attempt = event.get("attempt")
                if attempt in pending_creates:
                    pending_creates.remove(attempt)
            elif name == "allocated":
                if desktop_id:
                    outstanding.add(desktop_id)
                    if pending_creates:
                        pending_creates.pop()
                else:
                    finding(
                        "warning",
                        "allocation_without_id",
                        "Allocation event has no desktop ID",
                        *key,
                    )
            elif name == "desktop_destroyed":
                outstanding.discard(desktop_id)
                cleanup_failed = False
            elif name == "cleanup_failed":
                cleanup_failed = True

        # Older runs had no journal; only a saved cleanup failure identifies a
        # cleanup candidate. A successful legacy final result is not suspicious.
        saved = result if result is not None else record
        if (
            saved
            and isinstance(saved.get("evidence"), dict)
            and saved["evidence"].get("lifecycle_error")
        ):
            finding(
                "warning",
                "lifecycle_error",
                "Trial recorded a lifecycle logging failure; recovery evidence may be incomplete",
                *key,
            )
        fallback_id = saved.get("desktop_id") if saved else None
        if saved and saved.get("cleanup_error"):
            cleanup_failed = True
            if isinstance(fallback_id, str) and fallback_id:
                outstanding.add(fallback_id)
        if (journal_present or run_id) and isinstance(fallback_id, str) and fallback_id:
            if not any(
                event["event"] == "desktop_destroyed" and event.get("desktop_id") == fallback_id
                for event in events
            ):
                outstanding.add(fallback_id)
        for desktop_id in sorted(outstanding):
            reason = "Allocation has no matching durable desktop_destroyed event"
            report["cleanup_candidates"].append(
                {"task_id": task_id, "trial": trial, "desktop_id": desktop_id, "reason": reason}
            )
            finding(
                "warning",
                "cleanup_unconfirmed",
                f"{reason}: {desktop_id}; provider status unknown",
                *key,
            )
        if pending_creates:
            finding(
                "warning",
                "unknown_allocation",
                "Creation was requested but no allocation ID or definitive rejection was recorded; "
                "a lost allocation response is possible. Provider status is unknown.",
                *key,
            )
        if cleanup_failed and not outstanding:
            finding(
                "warning",
                "cleanup_failed",
                "Cleanup failure recorded without a known outstanding desktop ID",
                *key,
            )

    if status != "running" and (report["counts"]["incomplete"] or report["counts"]["unstarted"]):
        finding("warning", "unfinished_plan", "Run has planned trials without final results")
    return finish()
