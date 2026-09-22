"""Export a reconciled local snapshot without rerunning or changing source evidence."""

import hashlib
import json
import math
import os
import tempfile
from datetime import UTC, datetime
from importlib.metadata import version
from pathlib import Path
from uuid import uuid4

from gauntlet.harness.audit import audit_run
from gauntlet.harness.runner import atomic_json
from gauntlet.harness.scoring import summarize
from gauntlet.models import Task, validate_task
from gauntlet.report import build_report

MAX_FILE_BYTES = 32 * 1024 * 1024
MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024
MAX_FILES = 30_000


def read_artifact(path: Path) -> bytes:
    if path.is_symlink() or not path.is_file():
        raise ValueError(f"Recovery requires regular files without symlinks: {path.name}")
    if path.stat().st_size > MAX_FILE_BYTES:
        raise ValueError(f"Artifact exceeds the 32 MiB recovery limit: {path.name}")
    with path.open("rb") as stream:
        data = stream.read(MAX_FILE_BYTES + 1)
    if len(data) > MAX_FILE_BYTES:
        raise ValueError("Artifact grew beyond the recovery limit")
    return data


def validate_record(record: dict, task: Task) -> None:
    """Audit checks identity; also require fields consumed by scoring and reports."""
    if type(record.get("tier")) is not int or record["tier"] != task.tier:
        raise ValueError("Result tier differs from its saved task")
    for field in ("steps", "tokens_in", "tokens_out", "destructive_actions"):
        value = record.get(field)
        if type(value) is not int or value < 0:
            raise ValueError(f"Result {field} must be a nonnegative integer")
    for field in ("wall_seconds", "cost_usd", "vm_boot_ms"):
        value = record.get(field)
        if field not in record or (value is None and field == "wall_seconds"):
            raise ValueError(f"Result is missing {field}")
        if value is not None and (
            type(value) not in (int, float) or not math.isfinite(value) or value < 0
        ):
            raise ValueError(f"Result {field} must be finite and nonnegative")
    times = record.get("screenshot_ms")
    if not isinstance(times, list) or any(
        type(n) not in (int, float) or not math.isfinite(n) or n < 0 for n in times
    ):
        raise ValueError("Invalid screenshot timings")


def inventory(root: Path, task_ids: list[str], trials: int) -> tuple[list[str], list[str]]:
    """Only direct files in planned trial directories; never generated reports."""
    directories, files = [], ["results.json"]
    size = 0
    for task_id in task_ids:
        parent = root / task_id
        if parent.is_symlink() or (parent.exists() and not parent.is_dir()):
            raise ValueError(f"Unsafe task directory: {task_id}")
        for trial in range(1, trials + 1):
            relative = f"{task_id}/{trial}"
            directory = root / relative
            if directory.is_symlink() or (directory.exists() and not directory.is_dir()):
                raise ValueError(f"Unsafe trial directory: {relative}")
            if not directory.exists():
                continue
            directories.append(relative)
            for artifact in sorted(directory.iterdir()):
                if artifact.is_symlink() or not artifact.is_file():
                    raise ValueError(f"Unsupported trial artifact: {relative}/{artifact.name}")
                length = artifact.stat().st_size
                size += length
                files.append(f"{relative}/{artifact.name}")
                if length > MAX_FILE_BYTES or size > MAX_TOTAL_BYTES or len(files) > MAX_FILES:
                    raise ValueError("Recovery artifact limits exceeded (32 MiB/file, 2 GiB total)")
    return directories, sorted(files)


def require_no_errors(audit: dict) -> None:
    errors = [item for item in audit["findings"] if item["severity"] == "error"]
    if errors:
        codes = ", ".join(sorted({item["code"] for item in errors}))
        raise ValueError(f"Recovery refused conflicting or invalid evidence: {codes}; run audit")


def recover_run(source: Path, destination: Path) -> dict:
    """Publish a new reportable snapshot after reconciliation and mutation checks."""
    try:
        root = source.resolve(strict=True)
        output = destination.absolute()
        resolved_output = output.resolve()
        if resolved_output.is_relative_to(root) or root.is_relative_to(resolved_output):
            raise ValueError("Recovery output must be separate from the source run")
        if output.exists() or output.is_symlink():
            raise ValueError("Recovery output already exists; choose a new directory")
        original = read_artifact(root / "results.json")
        manifest = json.loads(original)
        source_audit = audit_run(root)
        require_no_errors(source_audit)
        if manifest.get("schema_version") != 2 or manifest.get("recovery"):
            raise ValueError("Recovery requires an original schema 2 run, not an earlier export")
        tasks = {}
        for task_id in manifest["task_ids"]:
            snapshot = manifest["tasks"][task_id]
            task = Task(**snapshot["definition"])
            validate_task(task)
            if task.id != task_id or task.fingerprint != snapshot["sha256"]:
                raise ValueError("Saved task fingerprint or identity does not match")
            tasks[task_id] = task
        if not isinstance(manifest.get("provenance"), dict):
            raise ValueError("Recovery requires recorded provenance")
        directories, files = inventory(root, manifest["task_ids"], manifest["trials_per_task"])
        output.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix=".gauntlet-recovery-", dir=output.parent) as temp:
            stage = Path(temp) / "snapshot"
            stage.mkdir()
            for relative in directories:
                (stage / relative).mkdir(parents=True)
            hashes = {}
            for relative in files:
                data = read_artifact(root / relative)
                if relative == "results.json" and data != original:
                    raise ValueError(
                        "Source manifest changed during recovery; retry after it stops"
                    )
                hashes[relative] = hashlib.sha256(data).hexdigest()
                (stage / relative).write_bytes(data)
            copied_audit = audit_run(stage)
            require_no_errors(copied_audit)
            if copied_audit != source_audit:
                raise ValueError("Source audit changed during recovery; retry after it stops")
            records = []
            for relative in directories:
                result = stage / relative / "result.json"
                task_id = relative.split("/")[0]
                task_file = stage / relative / "task.json"
                if (
                    task_file.exists()
                    and json.loads(task_file.read_bytes()) != manifest["tasks"][task_id]
                ):
                    raise ValueError(f"Trial {relative} does not match the saved task snapshot")
                if not result.exists():
                    continue
                record = json.loads(result.read_bytes())
                validate_record(record, tasks[task_id])
                if not task_file.is_file():
                    raise ValueError(f"Finalized trial {relative} is missing its task snapshot")
                records.append(record)
            records.sort(key=lambda item: (item["task_id"], item["trial"]))
            recovery = {
                "recovery_id": str(uuid4()),
                "created_at": datetime.now(UTC).isoformat(),
                "tool_version": version("solari-gauntlet"),
                "source_manifest_sha256": hashlib.sha256(original).hexdigest(),
                "source_status": manifest["status"],
                "source_run_id": manifest.get("run_id"),
                "added_records": copied_audit["unindexed_results"],
                "scope": "Local snapshot only; no trials rerun or remote cleanup performed",
                "source_findings": copied_audit["findings"],
            }
            bundle = stage / "recovery"
            bundle.mkdir()
            (bundle / "source-results.json").write_bytes(original)
            atomic_json(bundle / "source-audit.json", copied_audit)
            atomic_json(bundle / "artifact-hashes.json", hashes)
            manifest.update(status="recovered", records=records, recovery=recovery)
            manifest["summary"] = summarize(
                records, manifest["trials_per_task"], manifest["task_ids"]
            )
            atomic_json(stage / "results.json", manifest)
            recovered_audit = audit_run(stage)
            require_no_errors(recovered_audit)
            atomic_json(bundle / "recovered-audit.json", recovered_audit)
            build_report(stage)
            # Detect changed, added, or removed artifacts before publishing the export.
            if inventory(root, manifest["task_ids"], manifest["trials_per_task"]) != (
                directories,
                files,
            ):
                raise ValueError("Source artifact inventory changed during recovery")
            for relative, digest in hashes.items():
                if hashlib.sha256(read_artifact(root / relative)).hexdigest() != digest:
                    raise ValueError(
                        "Source artifact changed during recovery; retry after it stops"
                    )
            # Exclusive reservation refuses an output that appeared while copying.
            output.mkdir()
            try:
                os.replace(stage, output)
            except BaseException:
                # Remove only our still-empty reservation, never someone else's files.
                try:
                    output.rmdir()
                except OSError:
                    pass
                raise
        return {"output": str(output), "recovery": recovery, "audit": recovered_audit}
    except (KeyError, TypeError, RuntimeError) as exc:
        raise ValueError(f"Invalid recovery inputs: {exc}") from exc
