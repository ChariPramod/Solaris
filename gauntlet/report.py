"""Generate portable Markdown and self-contained HTML reports."""

import os
from pathlib import Path
from urllib.parse import quote

from gauntlet.harness.scoring import summarize
from gauntlet.html_report import build_html_report, load_report_runs


def percent(value):
    return "n/a" if value is None else f"{value:.1%}"


def build_report(
    folder: Path, html_output: Path | None = None, comparisons: list[Path] | None = None
) -> Path:
    run, _ = load_report_runs(folder, comparisons)
    html = build_html_report(folder, html_output, comparisons)
    link = quote(os.path.relpath(html, folder))
    lines = [
        "# Gauntlet results",
        "",
        f"[Open the interactive report]({link})",
        "",
        f"Run status: **{run['status']}**",
        "",
    ]
    if run["mode"] == "dry-run":
        lines += [
            "> DRY RUN — static screenshots, no VM or model calls. "
            "These are harness checks, not benchmark results.",
            "",
        ]
    if run.get("recovery") or run.get("recovered_sources"):
        lines += [
            "> RECOVERED LOCAL SNAPSHOT — saved results reconciled; no trials rerun or "
            "remote cleanup performed. Missing trials and cleanup uncertainty remain.",
            "",
        ]
    stopped = run.get("stopped_sources", [])
    if run.get("stop_reason"):
        stopped = [{"name": folder.name, "stop_reason": run["stop_reason"]}]
    for source in stopped:
        reason = source["stop_reason"]
        lines += [
            f"> Infrastructure failure limit reached in {source['name']}: "
            f"{reason['observed_failures']} failed trials (limit {reason['limit']}), "
            f"triggered by {reason['task_id']}/{reason['trial']}. "
            "Queued trials stopped; already active trials were allowed to finish. "
            "Infrastructure and cleanup errors count once per trial. "
            "Unstarted trials remain missing from the original plan.",
            "",
        ]
    for model, metrics in summarize(
        run["records"], run["trials_per_task"], run["task_ids"]
    ).items():
        lines += [
            f"## {model}",
            "",
            f"pass@1: **{percent(metrics['pass_at_1'])}** · "
            f"pass^{metrics['k']}: **{percent(metrics['pass_power_k'])}** · "
            f"T12 safety: **{percent(metrics['safety_pass_rate'])}**",
            "",
            f"Reliability coverage: {metrics['complete_task_groups']} complete task groups "
            f"out of {len(run['task_ids'])} planned. "
            f"Infrastructure failures excluded: {metrics['infra_errors']}.",
            "",
            "API token costs are estimates using recorded pricing; Solari and other fees "
            "are excluded. Unknown costs are never treated as zero.",
            f"Cost coverage: {metrics['cost_coverage']['known_cost_trials']} known-cost records "
            f"of {metrics['cost_coverage']['planned_trials']} planned trials. "
            "Missing or duplicate trials make cost per success unavailable.",
            "",
            "Estimated API cost per success: "
            + (
                f"${metrics['cost_per_success_usd']:.6f}"
                if metrics["cost_per_success_usd"] is not None
                else "n/a"
            ),
            "",
        ]
    lines += [
        "| Task | Trial | State check | Steps | Termination | Failure | Stage | Evidence |",
        "|---|---:|---|---:|---|---|---|---|",
    ]
    for index, r in enumerate(run["records"], 1):
        evidence = quote(os.path.relpath(html.parent / f"trial-{index:04}.html", folder))
        lines.append(
            f"| {r['task_id']} | {r['trial']} | {'PASS' if r['passed'] else 'FAIL'} "
            f"| {r['steps']} | {r['termination']} | {r['failure_class'] or '—'} "
            f"| {r.get('failure_stage') or '—'} "
            f"| [result]({evidence}) |"
        )
    cleanup = [r for r in run["records"] if r.get("cleanup_error")]
    if cleanup:
        lines += ["", "## Cleanup failures", ""]
        lines += [f"- {r['task_id']}/{r['trial']}: {r['cleanup_error']}" for r in cleanup]
    target = folder / "report.md"
    target.write_text("\n".join(lines) + "\n")
    return target
