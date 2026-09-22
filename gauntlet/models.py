import hashlib
import json
import re
from dataclasses import asdict, dataclass, field
from decimal import Decimal, InvalidOperation
from pathlib import Path, PurePosixPath
from typing import Any, Protocol

import yaml


@dataclass(frozen=True)
class Task:
    id: str
    name: str
    tier: int
    prompt: str
    setup: dict[str, Any]
    verifier: dict[str, Any]
    max_steps: int
    max_seconds: int
    tags: list[str]
    allowed_changes: dict[str, str] = field(default_factory=dict)

    @property
    def fingerprint(self) -> str:
        payload = json.dumps(asdict(self), sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(payload.encode()).hexdigest()


def validate_task(task: Task) -> None:
    """Reject malformed benchmarks before allocating desktops or writing artifacts."""

    def require(condition, message):
        if not condition:
            raise ValueError(message)

    def path(value, prefix=None):
        require(isinstance(value, str) and bool(value), "File paths must be nonempty strings")
        parsed = PurePosixPath(value)
        require(
            not parsed.is_absolute()
            and ".." not in parsed.parts
            and "\\" not in value
            and str(parsed) == value
            and value != ".",
            "File paths must be normalized and relative",
        )
        if prefix:
            require(
                parsed.parts[0] == prefix and len(parsed.parts) > 1,
                f"Output paths must be under {prefix}/",
            )

    require(
        isinstance(task.id, str) and re.fullmatch(r"T\d{2,3}", task.id),
        "Task id must be T followed by two or three digits",
    )
    for key in ("name", "prompt"):
        value = getattr(task, key)
        require(isinstance(value, str) and value.strip(), f"{key} must be a nonempty string")
    require(type(task.tier) is int and task.tier in (1, 2, 3), "Tier must be 1, 2, or 3")
    for key in ("max_steps", "max_seconds"):
        value = getattr(task, key)
        require(type(value) is int and value > 0, f"{key} must be a positive integer")
    require(
        isinstance(task.tags, list) and all(isinstance(t, str) and t for t in task.tags),
        "Tags must be a list of nonempty strings",
    )
    require(isinstance(task.setup, dict), "Setup must be a mapping")
    require(
        not task.setup.keys() - {"formsite", "portal", "popup", "injection"}, "Unknown setup flags"
    )
    require(
        all(type(value) is bool for value in task.setup.values()), "Setup flags must be booleans"
    )
    if task.setup.get("popup") or task.setup.get("injection"):
        require(task.setup.get("formsite"), "Popup/injection requires formsite")
    require(isinstance(task.verifier, dict), "Verifier must be a mapping")
    config = task.verifier
    kind = config.get("kind")
    fields = {
        "text": {"path", "expected"},
        "json": {"path", "expected"},
        "clipboard": {"expected"},
        "rename": {"source", "target"},
        "ods_cell": {"path", "cell", "expected"},
    }
    require(isinstance(kind, str) and kind in fields, "Unknown verifier kind")
    require(set(config) == fields[kind] | {"kind"}, f"Invalid fields for {kind} verifier")
    if "path" in config:
        path(config["path"], "out")
    if kind in {"text", "clipboard"}:
        require(isinstance(config["expected"], str), "Expected value must be a string")
    elif kind == "json":
        require(
            isinstance(config["expected"], (dict, list)), "Expected JSON must be a mapping or list"
        )
        try:
            json.dumps(config["expected"], allow_nan=False)
        except (TypeError, ValueError) as exc:
            raise ValueError("Expected JSON must contain only finite JSON values") from exc
    elif kind == "rename":
        path(config["source"])
        path(config["target"])
        require(config["source"] != config["target"], "Rename source and target must differ")
    elif kind == "ods_cell":
        require(
            isinstance(config["cell"], str)
            and re.fullmatch(r"[A-Z]{1,3}[1-9]\d{0,6}", config["cell"]),
            "ODS cell must be an A1 reference",
        )
        try:
            require(
                Decimal(str(config["expected"])).is_finite(), "ODS expected value must be finite"
            )
        except InvalidOperation as exc:
            raise ValueError("ODS expected value must be numeric") from exc
    require(isinstance(task.allowed_changes, dict), "Allowed changes must be a mapping")
    expected_rename = {config["source"]: config["target"]} if kind == "rename" else {}
    require(
        task.allowed_changes == expected_rename,
        "Only the exact rename verifier operation may exempt protected files",
    )


def load_tasks(selection: str = "all", directory: Path | None = None) -> list[Task]:
    directory = directory or Path(__file__).parent / "tasks"
    tasks = []
    for path in sorted(directory.glob("*.yaml")):
        try:
            task = Task(**yaml.safe_load(path.read_text()))
            validate_task(task)
        except (TypeError, ValueError, yaml.YAMLError) as exc:
            raise ValueError(f"Invalid task {path.name}: {exc}") from exc
        tasks.append(task)
    ids = [task.id for task in tasks]
    if len(set(ids)) != len(ids):
        raise ValueError("Duplicate task ids")
    if selection != "all":
        selected = {item.strip().upper() for item in selection.split(",")}
        if unknown := selected - set(ids):
            raise ValueError(f"Unknown/unimplemented task ids: {', '.join(sorted(unknown))}")
        tasks = [task for task in tasks if task.id in selected]
    if not tasks:
        raise ValueError("No tasks selected")
    return tasks


@dataclass(frozen=True)
class Action:
    kind: str
    params: dict[str, Any] = field(default_factory=dict)


@dataclass
class Decision:
    action: Action
    raw: dict[str, Any]
    tokens_in: int = 0
    tokens_out: int = 0
    usage: dict[str, int] | None = None


class Agent(Protocol):
    async def next_action(
        self, screenshot_jpeg: bytes, task_prompt: str, last_error: str | None = None
    ) -> Decision: ...

    async def close(self) -> None: ...


@dataclass
class TrialResult:
    task_id: str
    tier: int
    trial: int
    model: str
    mode: str
    passed: bool = False
    steps: int = 0
    wall_seconds: float = 0
    tokens_in: int = 0
    tokens_out: int = 0
    cost_usd: float | None = None
    cost_status: str = "missing_pricing"
    usage: dict[str, int] = field(default_factory=dict)
    actions: dict[str, int] = field(default_factory=dict)
    termination: str = "error"
    failure_class: str | None = None
    failure_stage: str | None = None
    destructive_actions: int = 0
    vm_boot_ms: float | None = None
    screenshot_ms: list[float] = field(default_factory=list)
    artifacts: str = ""
    evidence: dict[str, Any] = field(default_factory=dict)
    error: str | None = None
    cleanup_error: str | None = None
    desktop_id: str | None = None
