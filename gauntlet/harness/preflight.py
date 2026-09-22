"""Read-only local readiness checks; never authenticate or allocate resources."""

import importlib.util
import os
from pathlib import Path

from yaml import YAMLError

from gauntlet.harness.pricing import load_pricing
from gauntlet.models import load_tasks

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
LOCAL_SCOPE = (
    "Local checks only: credentials are not authenticated, no network requests are made, "
    "and desktop provisioning and model compatibility remain unverified."
)


def preflight(
    *,
    provider="claude",
    model=None,
    tasks="all",
    trials=3,
    concurrency=2,
    template="default",
    pricing_path=None,
    dry_run=False,
    output=None,
    setup_seconds=240,
    max_infra_failures=None,
) -> dict:
    """Return all local blockers together, without writing files or exposing secrets."""
    checks = []

    def add(name, status, message):
        checks.append({"name": name, "status": status, "message": message})

    valid_provider = provider in ("claude", "openai")
    add(
        "provider",
        "pass" if valid_provider else "fail",
        "Supported adapter selected." if valid_provider else "Choose claude or openai.",
    )
    resolved_model = model
    if valid_provider and not resolved_model:
        resolved_model = os.getenv(f"GAUNTLET_{provider.upper()}_MODEL")
        if not resolved_model and provider == "claude":
            resolved_model = "claude-sonnet-4-6"
    valid_model = isinstance(resolved_model, str) and bool(resolved_model.strip())
    add(
        "model",
        "pass" if dry_run or valid_model else "fail",
        "Dry run uses the static agent."
        if dry_run
        else (
            "Model ID configured; compatibility is not verified."
            if valid_model
            else "Set --model-id or the selected provider's GAUNTLET_*_MODEL variable."
        ),
    )
    for name, value in (
        ("trials", trials),
        ("concurrency", concurrency),
        ("setup_seconds", setup_seconds),
    ):
        valid = type(value) is int and value > 0
        add(
            name,
            "pass" if valid else "fail",
            f"{name}: {value}." if valid else f"{name} must be a positive integer.",
        )
    valid_limit = max_infra_failures is None or (
        type(max_infra_failures) is int and max_infra_failures > 0
    )
    add(
        "max_infra_failures",
        "pass" if valid_limit else "fail",
        "Infrastructure failure limit disabled."
        if max_infra_failures is None
        else f"Stop queued trials after {max_infra_failures} infrastructure/cleanup failures."
        if valid_limit
        else "max_infra_failures must be a positive integer or omitted.",
    )
    valid_template = isinstance(template, str) and bool(template.strip())
    add(
        "template",
        "pass" if dry_run or valid_template else "fail",
        "Template is unused in dry runs."
        if dry_run
        else "A nonempty desktop template is required; availability is not verified.",
    )
    selected = []
    try:
        selected = load_tasks(tasks)
        add("tasks", "pass", f"Validated {len(selected)} task definitions.")
    except (ValueError, OSError, TypeError, AttributeError, YAMLError) as exc:
        add("tasks", "fail", f"Task selection is invalid: {exc}")

    dependencies = ["yaml", "flask", "PIL", "rich", "jinja2"]
    if not dry_run:
        dependencies.append("solari_desktop")
        if valid_provider:
            dependencies.append("anthropic" if provider == "claude" else "openai")
    for dependency in dependencies:
        try:
            available = importlib.util.find_spec(dependency) is not None
        except (ImportError, ValueError):
            available = False
        add(
            f"dependency:{dependency}",
            "pass" if available else "fail",
            f"{dependency} is available."
            if available
            else f"{dependency} is missing; install the package with pip install -e '.[live]'.",
        )
    if not dry_run:
        keys = ["SOLARI_API_KEY"]
        if valid_provider:
            keys.append("ANTHROPIC_API_KEY" if provider == "claude" else "OPENAI_API_KEY")
        for name in keys:
            present = bool(os.getenv(name, "").strip())
            add(
                f"credential:{name}",
                "pass" if present else "fail",
                f"{name} is set (not authenticated)." if present else f"Set {name}.",
            )
    if pricing_path is not None:
        if dry_run:
            add("pricing", "fail", "--pricing applies to live calls; dry-run API cost is zero.")
        elif not valid_provider or not valid_model:
            add("pricing", "fail", "Select a valid adapter and model before validating pricing.")
        else:
            try:
                load_pricing(Path(pricing_path), provider, resolved_model)
                add("pricing", "pass", "Pricing matches the adapter and model ID.")
            except (ValueError, OSError, TypeError) as exc:
                add("pricing", "fail", f"Invalid pricing: {exc}")
    else:
        add(
            "pricing",
            "pass" if dry_run else "warning",
            "Dry-run API cost is zero."
            if dry_run
            else "No pricing supplied; API cost estimates will be unknown.",
        )

    required = [
        "fixtures/data.py",
        "fixtures/apps.py",
        "verifiers/state.py",
        "templates/base.html",
        "templates/report.html",
        "templates/trial.html",
        "templates/report.css",
        "templates/report.js",
    ]
    if not dry_run:
        required.append("fixtures/provision.sh")
    if any(task.id == "T11" or task.setup.get("portal") for task in selected):
        required.append("fixtures/assets/invoice.pdf")
    missing = [name for name in required if not (PACKAGE_ROOT / name).is_file()]
    add(
        "package_files",
        "fail" if missing else "pass",
        "Missing packaged files: " + ", ".join(missing)
        if missing
        else "Required fixture, verifier, and report files are present.",
    )

    try:
        destination = Path(output) if output is not None else Path("results")
        # The default names a parent for a future timestamped run, not the run itself.
        if output is not None and (destination.exists() or destination.is_symlink()):
            add("output", "fail", "Output already exists; choose a new run directory.")
        else:
            ancestor = destination.absolute()
            while not ancestor.exists() and not ancestor.is_symlink():
                ancestor = ancestor.parent
            writable = ancestor.is_dir() and os.access(ancestor, os.W_OK | os.X_OK)
            add(
                "output",
                "pass" if writable else "fail",
                "Output parent is writable; no directory was created."
                if writable
                else "Nearest existing output ancestor is not a writable directory.",
            )
    except (OSError, ValueError, TypeError):
        add("output", "fail", "Output path cannot be inspected.")

    add("scope", "warning", LOCAL_SCOPE)
    return {
        "ready": all(check["status"] != "fail" for check in checks),
        "scope": "local-only",
        "checks": checks,
        "adapter": "dry-run" if dry_run else provider,
        "model": "dry-run" if dry_run else resolved_model,
        "task_ids": [task.id for task in selected],
        "planned_trials": len(selected) * trials if type(trials) is int and trials > 0 else None,
        "trials_per_task": trials,
        "concurrency": concurrency,
        "setup_seconds": setup_seconds,
        "max_infra_failures": max_infra_failures,
        "template": None if dry_run else template,
    }
