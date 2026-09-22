import argparse
import asyncio
import importlib
import json
import os
import sys
from datetime import UTC, datetime
from pathlib import Path

from rich.console import Console
from rich.live import Live
from rich.table import Table

from gauntlet.agent.claude import ClaudeAgent, DryRunAgent
from gauntlet.agent.openai import OpenAIAgent
from gauntlet.fixtures.apps import create_app
from gauntlet.fixtures.data import seed
from gauntlet.harness.assessment import compare_runs, evaluate_gate
from gauntlet.harness.audit import audit_run
from gauntlet.harness.backends import DryRunDesktop, SolariDesktop
from gauntlet.harness.preflight import preflight
from gauntlet.harness.pricing import load_pricing
from gauntlet.harness.recovery import recover_run
from gauntlet.harness.runner import run_suite
from gauntlet.models import load_tasks
from gauntlet.report import build_report


def positive(value):
    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return number


class _ArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        # Assessment callers consume JSON even when parsing or validation fails.
        if sys.argv[1:2] in (["compare"], ["gate"]) and "--json" in sys.argv[2:]:
            print(json.dumps({"error": str(message)}))
            raise SystemExit(2)
        super().error(message)


def main():
    parser = _ArgumentParser(description="Gauntlet computer-use reliability harness")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("tasks", help="List implemented tasks")
    check = commands.add_parser("preflight", help="Check local readiness without calling services")
    check.add_argument("--tasks", default="all")
    check.add_argument("--trials", type=positive, default=3)
    check.add_argument("--concurrency", type=positive, default=2)
    check.add_argument("--model", choices=["claude", "openai"], default="claude")
    check.add_argument("--model-id")
    check.add_argument("--template", default="default")
    check.add_argument("--setup-seconds", type=positive, default=240)
    check.add_argument("--max-infra-failures", type=positive)
    check.add_argument("--pricing", type=Path)
    check.add_argument("--dry-run", action="store_true")
    check.add_argument("--out", type=Path, help="Proposed new run directory; never created")
    check.add_argument("--json", action="store_true", help="Print machine-readable JSON")
    audit = commands.add_parser("audit", help="Inspect local run artifacts without changing them")
    audit.add_argument("folder", type=Path)
    audit.add_argument("--json", action="store_true", help="Print machine-readable JSON")
    compare = commands.add_parser("compare", help="Compare validated independent run evidence")
    compare.add_argument("folder", type=Path)
    compare.add_argument("--baseline", type=Path, required=True)
    compare.add_argument("--json", action="store_true")
    gate = commands.add_parser("gate", help="Evaluate a read-only regression policy")
    gate.add_argument("folder", type=Path)
    gate.add_argument("--policy", type=Path, required=True)
    gate.add_argument("--baseline", type=Path)
    gate.add_argument("--json", action="store_true")
    recover = commands.add_parser(
        "recover", help="Export reconciled results without changing the source"
    )
    recover.add_argument("folder", type=Path)
    recover.add_argument("--out", type=Path, required=True, help="New, separate export directory")
    recover.add_argument("--json", action="store_true", help="Print machine-readable JSON")
    run = commands.add_parser("run", help="Run state-verified trials")
    run.add_argument("--tasks", default="all")
    run.add_argument("--trials", type=positive, default=3)
    run.add_argument("--concurrency", type=positive, default=2)
    run.add_argument("--model", choices=["claude", "openai"], default="claude")
    run.add_argument("--model-id", help="Provider model ID; required for OpenAI unless set in env")
    run.add_argument("--pricing", type=Path, help="Explicit provider/model pricing JSON")
    run.add_argument("--template", default="default")
    run.add_argument(
        "--setup-seconds",
        type=positive,
        default=240,
        help="Preparation timeout per desktop (separate from the task time limit)",
    )
    run.add_argument("--dry-run", action="store_true")
    run.add_argument(
        "--max-infra-failures",
        type=positive,
        help="Stop queued trials after this many trials have infrastructure or cleanup errors",
    )
    run.add_argument(
        "--fail-on-task-failure",
        action="store_true",
        help="Exit 3 if a task failed, after saving results and reports (infra errors exit 2)",
    )
    run.add_argument("--out", type=Path)
    report = commands.add_parser("report", help="Build Markdown and offline HTML reports")
    report.add_argument("folder", type=Path)
    report.add_argument("--out", type=Path, help="HTML output directory (default: RUN/html)")
    report.add_argument(
        "--compare",
        type=Path,
        action="append",
        default=[],
        help="Compare another run using identical tasks and trial counts; repeatable",
    )
    fixtures = commands.add_parser("fixtures", help="Serve local mock apps for manual inspection")
    fixtures.add_argument(
        "--root", type=Path, required=True, help="New, dedicated fixture directory"
    )
    fixtures.add_argument("--portal", action="store_true")
    fixtures.add_argument("--injection", action="store_true")
    fixtures.add_argument("--popup", action="store_true")
    args = parser.parse_args()
    console = Console()
    try:
        if args.command in {"compare", "gate"}:
            result = (
                compare_runs(args.folder, args.baseline)
                if args.command == "compare"
                else evaluate_gate(args.folder, args.policy, args.baseline)
            )
            if args.json:
                print(json.dumps(result, indent=2, allow_nan=False))
            elif args.command == "compare":
                console.print("Observed outcomes; no statistical significance is implied.")
                table = Table("Task", "Baseline pass rate", "Candidate pass rate", "Transitions")
                for task in result["tasks"]:
                    table.add_row(
                        task["task_id"],
                        str(task["baseline"]["pass_rate"]),
                        str(task["candidate"]["pass_rate"]),
                        str(task["transitions"]),
                    )
                console.print(table)
                for warning in result["warnings"]:
                    console.print(warning, markup=False)
            else:
                console.print("Gate passed." if result["passed"] else "Gate requirements unmet.")
                table = Table("Check", "Status", "Actual", "Expected")
                for item in result["checks"]:
                    table.add_row(
                        item["name"],
                        "pass" if item["passed"] else "fail",
                        str(item["actual"]),
                        str(item["expected"]),
                    )
                console.print(table)
            if args.command == "gate" and not result["passed"]:
                raise SystemExit(1)
            return
        if args.command == "recover":
            result = recover_run(args.folder, args.out)
            if args.json:
                print(json.dumps(result, indent=2))
            else:
                console.print(f"Recovered snapshot: {result['output']}")
                console.print(f"Report: {Path(result['output']) / 'html/index.html'}")
                console.print(f"Saved results added: {len(result['recovery']['added_records'])}")
                console.print("Source unchanged; no model calls or remote cleanup performed.")
                if not result["audit"]["healthy"]:
                    console.print("Audit findings remain; inspect the export with audit.")
            if not result["audit"]["healthy"]:
                raise SystemExit(1)
            return
        if args.command == "preflight":
            result = preflight(
                provider=args.model,
                model=args.model_id,
                tasks=args.tasks,
                trials=args.trials,
                concurrency=args.concurrency,
                template=args.template,
                pricing_path=args.pricing,
                dry_run=args.dry_run,
                output=args.out,
                setup_seconds=args.setup_seconds,
                max_infra_failures=args.max_infra_failures,
            )
            if args.json:
                print(json.dumps(result, indent=2))
            else:
                console.print(
                    "Local readiness only: no authentication or desktop checks performed."
                )
                console.print(f"Planned trials: {result['planned_trials']}")
                table = Table("Check", "Status", "Details")
                for item in result["checks"]:
                    table.add_row(item["name"], item["status"], item["message"])
                console.print(table)
                console.print(
                    "Ready for a live smoke test."
                    if result["ready"] and not args.dry_run
                    else "Local checks passed."
                    if result["ready"]
                    else "Resolve the failed checks before running."
                )
            if not result["ready"]:
                raise SystemExit(1)
            return
        if args.command == "audit":
            result = audit_run(args.folder)
            if args.json:
                print(json.dumps(result, indent=2))
            else:
                console.print("Local artifact audit; remote desktop status was not checked.")
                console.print(result["counts"])
                table = Table("Severity", "Finding", "Details")
                for item in result["findings"]:
                    table.add_row(item["severity"], item["code"], item["message"])
                console.print(table)
                if result["cleanup_candidates"]:
                    console.print("Desktop destruction needs provider-side verification:")
                    for item in result["cleanup_candidates"]:
                        console.print(
                            f"{item['task_id']}/{item['trial']}: "
                            f"{item['desktop_id'] or 'unknown ID'} — {item['reason']}"
                        )
                console.print(
                    "No local inconsistencies found."
                    if result["healthy"]
                    else "Review the findings; no artifacts or desktops were changed."
                )
            if not result["healthy"]:
                raise SystemExit(1)
            return
        if args.command == "tasks":
            table = Table("ID", "Tier", "Task", "Steps", "Seconds")
            for task in load_tasks():
                table.add_row(
                    task.id, str(task.tier), task.name, str(task.max_steps), str(task.max_seconds)
                )
            console.print(table)
            return
        if args.command == "report":
            console.print(f"Markdown: {build_report(args.folder, args.out, args.compare)}")
            console.print(f"HTML: {(args.out or args.folder / 'html') / 'index.html'}")
            return
        if args.command == "fixtures":
            args.root.mkdir(parents=True, exist_ok=False)
            seed(args.root)
            create_app(
                args.root, portal=args.portal, injection=args.injection, popup=args.popup
            ).run(host="127.0.0.1", port=8001 if args.portal else 8000)
            return
        tasks = load_tasks(args.tasks)
        model_id = args.model_id or os.getenv(f"GAUNTLET_{args.model.upper()}_MODEL")
        if not model_id and args.model == "claude":
            model_id = "claude-sonnet-4-6"
        if not args.dry_run and (not model_id or not model_id.strip()):
            parser.error("OpenAI requires --model-id or GAUNTLET_OPENAI_MODEL")
        if args.pricing and args.dry_run:
            parser.error("--pricing applies to live model calls; dry runs have zero API cost")
        pricing = load_pricing(args.pricing, args.model, model_id) if args.pricing else None
        output = args.out or Path("results") / datetime.now(UTC).strftime("run_%Y%m%d_%H%M%S_%f")
        readiness = preflight(
            provider=args.model,
            model=model_id,
            tasks=args.tasks,
            trials=args.trials,
            concurrency=args.concurrency,
            template=args.template,
            pricing_path=args.pricing,
            dry_run=args.dry_run,
            output=output,
            setup_seconds=args.setup_seconds,
            max_infra_failures=args.max_infra_failures,
        )
        if not readiness["ready"]:
            failures = [item["message"] for item in readiness["checks"] if item["status"] == "fail"]
            parser.error(
                "Local readiness failed: "
                + "; ".join(failures)
                + ". Use --dry-run without credentials."
            )
        if not args.dry_run:
            try:
                importlib.import_module("openai" if args.model == "openai" else "anthropic")
                importlib.import_module("solari_desktop")
            except ImportError:
                parser.error("Live dependencies missing. Install with: pip install -e '.[live]'")
        mode = "dry-run" if args.dry_run else "live"
        model = "dry-run" if args.dry_run else model_id
        agent_type = OpenAIAgent if args.model == "openai" else ClaudeAgent
        if args.dry_run:
            console.print(
                "[yellow]DRY RUN: no VMs or model calls; failed state checks are expected."
            )
        table = Table("Task", "Trial", "Result", "Steps", "Termination", "Stage", "Cleanup")
        with Live(table, console=console, refresh_per_second=4) as live:

            def completed(result):
                table.add_row(
                    result.task_id,
                    str(result.trial),
                    "[green]PASS" if result.passed else "[red]FAIL",
                    str(result.steps),
                    result.termination,
                    result.failure_stage or "—",
                    "[red]ERROR" if result.cleanup_error else "OK",
                )
                live.update(table)

            manifest = asyncio.run(
                run_suite(
                    tasks,
                    trials=args.trials,
                    concurrency=args.concurrency,
                    model=model,
                    mode=mode,
                    output=output,
                    backend_factory=DryRunDesktop
                    if args.dry_run
                    else lambda: SolariDesktop(template=args.template),
                    agent_factory=DryRunAgent if args.dry_run else lambda: agent_type(model_id),
                    on_result=completed,
                    settle_seconds=0 if args.dry_run else 0.5,
                    configuration={
                        "preflight": readiness,
                        "fail_on_task_failure": args.fail_on_task_failure,
                        "template": args.template if not args.dry_run else None,
                        "adapter": "dry-run" if args.dry_run else args.model,
                        "action_protocol": "static"
                        if args.dry_run
                        else (
                            "responses-json-v1" if args.model == "openai" else "computer_20251124"
                        ),
                    },
                    setup_seconds=args.setup_seconds,
                    max_infra_failures=args.max_infra_failures,
                    pricing=pricing,
                )
            )
        console.print(f"Results: {output / 'results.json'}")
        console.print(f"Report: {build_report(output)}")
        console.print(f"HTML: {output / 'html/index.html'}")
        if manifest.get("stop_reason"):
            reason = manifest["stop_reason"]
            console.print(
                f"Infrastructure failure limit reached ({reason['limit']}); "
                "queued trials were stopped and active trials finalized. "
                "Inspect the report and run 'gauntlet audit RUN'."
            )
        if any(
            r["failure_class"] == "infra_error" or r["cleanup_error"] for r in manifest["records"]
        ):
            raise SystemExit(2)
        if args.fail_on_task_failure and any(not r["passed"] for r in manifest["records"]):
            raise SystemExit(3)
    except (ValueError, OSError) as exc:
        parser.error(str(exc))
    except KeyboardInterrupt:
        console.print(
            "Interrupted. Inspect saved results with 'gauntlet audit RUN'. "
            "Cleanup may be incomplete after forced interruption."
        )
        raise SystemExit(130) from None
