"""Build a self-contained, offline HTML artifact from a recorded evaluation run."""

import hashlib
import json
import shutil
import tempfile
from collections import Counter, defaultdict
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from statistics import mean

from jinja2 import Environment, FileSystemLoader, StrictUndefined, select_autoescape
from PIL import Image, ImageDraw, UnidentifiedImageError

from gauntlet.harness.scoring import summarize
from gauntlet.models import Task, validate_task

TEMPLATES = Path(__file__).parent / "templates"
MARKER = ".gauntlet-report.json"


def safe_source(root: Path, relative: str) -> Path:
    """Artifact references may only resolve to files within their run directory."""
    if not isinstance(relative, str) or not relative:
        raise ValueError("Missing artifact path")
    path = PurePosixPath(relative)
    if path.is_absolute() or ".." in path.parts or "\\" in relative:
        raise ValueError("Artifact path must be relative to its run directory")
    result = (root / relative).resolve()
    if not result.is_relative_to(root.resolve()):
        raise ValueError("Artifact symlink resolves outside the run directory")
    return result


def read_log(path: Path) -> tuple[list[dict], list[str]]:
    if not path.exists():
        return [], ["No action log was recorded for this trial."]
    if path.stat().st_size > 16 * 1024 * 1024:
        return [], ["Action log exceeds the 16 MiB report limit."]
    events, warnings = [], []
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            event = json.loads(line)
            if not isinstance(event, dict):
                raise ValueError("Expected an object")
            events.append(event)
        except ValueError:
            warnings.append(f"Action log line {number} is incomplete or invalid; it was skipped.")
    return events, warnings


def verdict(record: dict) -> str:
    if record.get("failure_class") == "infra_error":
        return "infra"
    return "pass" if record["passed"] else "fail"


def number(value, digits=1):
    return "n/a" if value is None else f"{value:,.{digits}f}"


def check_destination(destination: Path) -> None:
    if not destination.exists():
        return
    if destination.is_symlink() or not (destination / MARKER).is_file():
        raise ValueError(f"Report destination is not a generated report: {destination}")
    try:
        expected = json.loads((destination / MARKER).read_text())
    except (ValueError, OSError) as exc:
        raise ValueError(
            "Report ownership metadata is invalid; choose a new --out directory"
        ) from exc
    if not isinstance(expected, dict) or not all(
        isinstance(key, str) and isinstance(value, str) for key, value in expected.items()
    ):
        raise ValueError("Report ownership metadata is invalid; choose a new --out directory")
    files = {
        str(path.relative_to(destination)): path
        for path in destination.rglob("*")
        if path.is_file() and path != destination / MARKER
    }
    if (
        set(files) != set(expected)
        or any(path.is_symlink() for path in destination.rglob("*"))
        or any(
            hashlib.sha256(path.read_bytes()).hexdigest() != expected[name]
            for name, path in files.items()
        )
    ):
        raise ValueError("Report contains added or edited files; choose a new --out directory")


def load_report_runs(
    folder: Path, comparisons: list[Path] | None = None
) -> tuple[dict, list[Path]]:
    folders = [folder.resolve(), *[path.resolve() for path in comparisons or []]]
    runs = [json.loads((path / "results.json").read_text()) for path in folders]
    for run in runs:
        if run.get("schema_version", 1) not in (1, 2):
            raise ValueError("Unsupported results schema version")
    if len(runs) == 1:
        return runs[0], [folders[0]] * len(runs[0]["records"])
    definitions = None
    benchmark_files = None
    template = runs[0].get("configuration", {}).get("template")
    observed_groups = set()
    for run in runs:
        if (
            set(run["task_ids"]) != set(runs[0]["task_ids"])
            or run["trials_per_task"] != runs[0]["trials_per_task"]
        ):
            raise ValueError("Compared runs must use identical task sets and trials per task")
        snapshots = run.get("tasks", {})
        if set(snapshots) != set(run["task_ids"]):
            raise ValueError("Comparison requires recorded task definitions (schema version 2)")
        current = {}
        for task_id, snapshot in snapshots.items():
            task = Task(**snapshot["definition"])
            validate_task(task)
            if task.id != task_id or task.fingerprint != snapshot["sha256"]:
                raise ValueError(
                    f"Recorded task fingerprint does not match its definition: {task_id}"
                )
            current[task_id] = task.fingerprint
        if definitions is not None and definitions != current:
            raise ValueError("Compared task definitions differ; scores would not be comparable")
        definitions = current
        current_files = {
            name: digest
            for name, digest in run.get("provenance", {}).get("package_files_sha256", {}).items()
            if name.startswith(("fixtures/", "verifiers/"))
        }
        if not current_files:
            raise ValueError("Comparison requires recorded fixture and verifier fingerprints")
        if benchmark_files is not None and benchmark_files != current_files:
            raise ValueError(
                "Compared fixtures or verifiers differ; scores would not be comparable"
            )
        benchmark_files = current_files
        if run.get("configuration", {}).get("template") != template:
            raise ValueError("Compared runs use different desktop templates")
        groups = {(r["mode"], r["model"]) for r in run["records"]}
        if observed_groups & groups:
            raise ValueError("Compared runs must have distinct model/mode groups")
        observed_groups.update(groups)
    combined = dict(runs[0])
    combined.pop("recovery", None)
    combined.pop("stop_reason", None)
    modes = {run["mode"] for run in runs}
    combined.update(
        schema_version=2,
        mode=next(iter(modes)) if len(modes) == 1 else "mixed",
        model="comparison",
        created_at=datetime.now(UTC).isoformat(),
        status="complete" if all(run["status"] == "complete" for run in runs) else "interrupted",
        planned_trials=sum(run["planned_trials"] for run in runs),
        records=[record for run in runs for record in run["records"]],
        configuration={"comparison_runs": [path.name for path in folders]},
        recovered_sources=[
            {"name": path.name, "recovery": run["recovery"]}
            for path, run in zip(folders, runs, strict=True)
            if run.get("recovery")
        ],
        stopped_sources=[
            {"name": path.name, "stop_reason": run["stop_reason"]}
            for path, run in zip(folders, runs, strict=True)
            if run.get("stop_reason")
        ],
        provenance={
            "compared_runs": [
                {
                    "name": path.name,
                    "created_at": run.get("created_at"),
                    "provenance": run.get("provenance", {}),
                    "configuration": run.get("configuration", {}),
                    "recovery": run.get("recovery"),
                    "stop_reason": run.get("stop_reason"),
                }
                for path, run in zip(folders, runs, strict=True)
            ]
        },
    )
    return combined, [path for path, run in zip(folders, runs, strict=True) for _ in run["records"]]


def build_html_report(
    folder: Path, destination: Path | None = None, comparisons: list[Path] | None = None
) -> Path:
    folder = folder.resolve()
    run, record_sources = load_report_runs(folder, comparisons)
    destination = destination or folder / "html"
    if destination.resolve() == folder or folder.is_relative_to(destination.resolve()):
        raise ValueError("Report destination cannot replace the run directory or its parents")
    check_destination(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=".gauntlet-report-", dir=destination.parent))
    try:
        render_report(run, folder, stage, record_sources)
        files = {
            str(path.relative_to(stage)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in stage.rglob("*")
            if path.is_file()
        }
        (stage / MARKER).write_text(json.dumps(files, indent=2))
        if destination.exists():
            # Recheck ownership immediately before replacing only generated files.
            check_destination(destination)
            backup = stage.with_name(stage.name + "-previous")
            destination.rename(backup)
            try:
                stage.rename(destination)
            except BaseException:
                backup.rename(destination)
                raise
            shutil.rmtree(backup)
        else:
            stage.rename(destination)
    finally:
        if stage.exists():
            shutil.rmtree(stage)
    return destination / "index.html"


def render_report(
    run: dict, source: Path, output: Path, record_sources: list[Path] | None = None
) -> None:
    environment = Environment(
        loader=FileSystemLoader(TEMPLATES),
        autoescape=select_autoescape(),
        undefined=StrictUndefined,
    )
    environment.filters["pretty"] = lambda value: json.dumps(value, indent=2, ensure_ascii=False)
    environment.filters["number"] = number
    environment.filters["percent"] = lambda value: "n/a" if value is None else f"{value:.1%}"
    for asset in ("report.css", "report.js"):
        shutil.copyfile(TEMPLATES / asset, output / asset)
    (output / "assets").mkdir()
    records = run["records"]
    summaries = summarize(records, run["trials_per_task"], run["task_ids"])
    trials = []
    groups = defaultdict(list)
    warnings = []

    def screenshot(path: Path, name: str, action: dict | None = None) -> dict:
        try:
            if (
                path.suffix.lower() not in {".jpg", ".jpeg", ".png"}
                or path.stat().st_size > 8_388_608
            ):
                raise ValueError("Unsupported screenshot format or size")
            with Image.open(path) as original:
                if original.width > 4096 or original.height > 4096:
                    raise ValueError("Screenshot dimensions exceed report limits")
                screen = original.convert("RGB")
            params = (action or {}).get("params", {})
            coordinate = params.get("coordinate")
            marked = False
            if (
                (action or {}).get("kind")
                in {
                    "left_click",
                    "right_click",
                    "middle_click",
                    "double_click",
                    "triple_click",
                    "left_click_drag",
                }
                and isinstance(coordinate, list)
                and len(coordinate) == 2
                and all(type(value) is int for value in coordinate)
                and 0 <= coordinate[0] < screen.width
                and 0 <= coordinate[1] < screen.height
            ):
                x, y = coordinate
                draw = ImageDraw.Draw(screen)
                draw.ellipse((x - 13, y - 13, x + 13, y + 13), outline="white", width=6)
                draw.ellipse((x - 13, y - 13, x + 13, y + 13), outline="#e03131", width=3)
                marked = True
            target = f"assets/{name}.jpg"
            screen.save(output / target, quality=88)
            return {"url": target, "marked": marked, "error": None}
        except (OSError, ValueError, UnidentifiedImageError, Image.DecompressionBombError) as exc:
            return {"url": None, "marked": False, "error": f"Screenshot unavailable: {exc}"}

    for index, record in enumerate(records, 1):
        href = f"trial-{index:04}.html"
        trial_warnings = []
        frames = []
        final = {"url": None, "marked": False, "error": None}
        definition = run.get("tasks", {}).get(record["task_id"], {})
        try:
            artifact = safe_source(
                record_sources[index - 1] if record_sources else source, record["artifacts"]
            )
            events, trial_warnings = read_log(safe_source(artifact, "actions.jsonl"))
            valid_events = []
            for event in events:
                if type(event.get("step")) is not int or event["step"] < 1:
                    trial_warnings.append("Skipped a log event with an invalid step number.")
                    continue
                if "action" in event and (
                    not isinstance(event["action"], dict)
                    or not isinstance(event["action"].get("kind"), str)
                    or not isinstance(event["action"].get("params", {}), dict)
                ):
                    trial_warnings.append(f"Skipped invalid action at step {event['step']}.")
                    continue
                valid_events.append(event)
            events = valid_events
            errors = {
                event.get("step"): event["action_error"]
                for event in events
                if "action_error" in event
            }
            for sequence, event in enumerate(events, 1):
                if "action" not in event:
                    continue
                try:
                    shot = screenshot(
                        safe_source(artifact, event.get("screenshot", "")),
                        f"trial-{index:04}-frame-{sequence:04}",
                        event["action"],
                    )
                except ValueError as exc:
                    shot = {"url": None, "marked": False, "error": str(exc)}
                frames.append(
                    {
                        "step": event.get("step", sequence),
                        "action": event["action"],
                        "response": event.get("response"),
                        "screenshot": shot,
                        "error": errors.get(event.get("step")),
                        "tokens_in": event.get("tokens_in"),
                        "tokens_out": event.get("tokens_out"),
                        "usage": event.get("usage"),
                        "cost_usd": event.get("cost_usd"),
                        "cost_status": event.get("cost_status", "unavailable"),
                    }
                )
            final = screenshot(safe_source(artifact, "final.jpg"), f"trial-{index:04}-final")
        except (OSError, ValueError) as exc:
            trial_warnings.append(f"Trial artifacts could not be read: {exc}")
        if trial_warnings:
            warnings.append(
                f"{record['task_id']} trial {record['trial']}: " + " ".join(trial_warnings)
            )
        trial = {"record": record, "href": href, "verdict": verdict(record)}
        trials.append(trial)
        groups[(record["mode"], record["model"], record["task_id"])].append(trial)
        page = environment.get_template("trial.html").render(
            run=run,
            trial=trial,
            definition=definition,
            frames=frames,
            final=final,
            warnings=trial_warnings,
            previous=f"trial-{index - 1:04}.html" if index > 1 else None,
            following=f"trial-{index + 1:04}.html" if index < len(records) else None,
        )
        (output / href).write_text(page, encoding="utf-8")

    model_groups = sorted({(r["mode"], r["model"]) for r in records})
    if not model_groups:
        model_groups = [(run["mode"], run.get("model", "unknown"))]
    tasks = []
    for mode, model in model_groups:
        task_ids = set(run["task_ids"]) | {
            r["task_id"] for r in records if r["mode"] == mode and r["model"] == model
        }
        for task_id in sorted(task_ids):
            rows = groups[(mode, model, task_id)]
            definition = run.get("tasks", {}).get(task_id, {}).get("definition", {})
            eligible = [t["record"] for t in rows if t["verdict"] != "infra"]
            by_trial = defaultdict(list)
            for trial in rows:
                by_trial[trial["record"]["trial"]].append(trial)
            dots = []
            for attempt in sorted(set(range(1, run["trials_per_task"] + 1)) | set(by_trial)):
                dots.extend(
                    by_trial[attempt]
                    or [{"record": {"trial": attempt}, "href": None, "verdict": "missing"}]
                )
            tasks.append(
                {
                    "id": task_id,
                    "name": definition.get("name", "").replace("-", " "),
                    "tier": definition.get("tier", rows[0]["record"]["tier"] if rows else None),
                    "mode": mode,
                    "model": model,
                    "trials": dots,
                    "mean_steps": mean(r["steps"] for r in eligible) if eligible else None,
                    "mean_cost": mean(r["cost_usd"] for r in eligible)
                    if eligible and all(r["cost_usd"] is not None for r in eligible)
                    else None,
                }
            )
    failures = Counter(r["failure_class"] for r in records if r["failure_class"])
    cleanup = [trial for trial in trials if trial["record"].get("cleanup_error")]
    page = environment.get_template("report.html").render(
        run=run,
        summaries=summaries,
        tasks=tasks,
        model_groups=model_groups,
        failures=failures,
        cleanup=cleanup,
        warnings=warnings,
        max_failure=max(failures.values(), default=1),
        mixed_modes=len({record["mode"] for record in records}) > 1,
    )
    (output / "index.html").write_text(page, encoding="utf-8")
