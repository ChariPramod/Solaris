"""Durable local evidence of desktop ownership, not a remote resource inventory."""

import json
import os
from datetime import UTC, datetime
from pathlib import Path


class LifecycleLog:
    def __init__(self, folder: Path, *, run_id: str | None, task_id: str, trial: int):
        self.path = folder / "lifecycle.jsonl"
        self.identity = {"run_id": run_id, "task_id": task_id, "trial": trial}

    def record(self, event: str, **details) -> None:
        entry = {
            **details,
            **self.identity,
            "schema_version": 1,
            "time": datetime.now(UTC).isoformat(),
            "event": event,
        }
        payload = json.dumps(entry, allow_nan=False) + "\n"
        with self.path.open("a", encoding="utf-8") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
