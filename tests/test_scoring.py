from dataclasses import asdict

import pytest

from gauntlet.harness.scoring import classify, summarize
from gauntlet.models import TrialResult


def row(task="T01", trial=1, passed=True, **kwargs):
    return asdict(TrialResult(task, 1, trial, "model", "live", passed=passed, **kwargs))


def test_reliability_is_all_trials_per_task():
    records = [row(trial=i) for i in range(1, 4)]
    records += [row("T02", i, i != 3) for i in range(1, 4)]
    summary = summarize(records, 3)["live/model"]
    assert summary["pass_at_1"] == 5 / 6
    assert summary["pass_power_k"] == 0.5


def test_infra_and_incomplete_groups_do_not_claim_reliability():
    records = [row(trial=1), row(trial=2), row(trial=3, passed=False, failure_class="infra_error")]
    metrics = summarize(records, 3)["live/model"]
    assert metrics["pass_at_1"] == 1
    assert metrics["pass_power_k"] is None
    assert metrics["complete_task_groups"] == 0
    assert metrics["infra_errors"] == 1


def test_duplicates_do_not_satisfy_trial_count():
    assert summarize([row(), row(), row()], 3)["live/model"]["pass_power_k"] is None


def test_unknown_cost_is_not_zero():
    assert summarize([row()], 1)["live/model"]["cost_per_success_usd"] is None


def test_cost_includes_failed_and_infra_trials():
    rows = [
        row(cost_usd=1),
        row(trial=2, passed=False, cost_usd=2),
        row(trial=3, passed=False, cost_usd=3, failure_class="infra_error"),
    ]
    assert summarize(rows, 3)["live/model"]["cost_per_success_usd"] == 6


def test_planned_cost_includes_failures_and_infrastructure_spending():
    records = [
        row(cost_usd=1),
        row(trial=2, passed=False, cost_usd=2),
        row(trial=3, passed=False, cost_usd=3, failure_class="infra_error"),
    ]
    metrics = summarize(records, 3, ["T01"])["live/model"]
    assert metrics["cost_per_success_usd"] == 6
    assert metrics["cost_coverage"] == {
        "recorded_trials": 3,
        "planned_trials": 3,
        "complete": True,
        "known_cost_trials": 3,
    }
    assert metrics["pass_at_1"] == 0.5
    assert metrics["pass_power_k"] is None


@pytest.mark.parametrize(
    "records,expected_trials,task_ids",
    [
        ([row(cost_usd=0)], 2, ["T01"]),
        ([row(cost_usd=0)], 1, ["T01", "T02"]),
        ([row(cost_usd=0), row(cost_usd=0)], 2, ["T01"]),
        ([row(cost_usd=0), row(cost_usd=0)], 1, ["T01"]),
        ([row(cost_usd=0), row("T02", cost_usd=0)], 1, ["T01"]),
        ([row(cost_usd=0), row(trial=3, cost_usd=0)], 2, ["T01"]),
        ([row(trial=0, cost_usd=0)], 1, ["T01"]),
        ([row(cost_usd=0)], 1, []),
    ],
)
def test_incomplete_or_invalid_plan_coverage_never_claims_zero_cost(
    records, expected_trials, task_ids
):
    metrics = summarize(records, expected_trials, task_ids)["live/model"]
    assert metrics["cost_per_success_usd"] is None
    assert metrics["cost_coverage"] == {
        "recorded_trials": len(records),
        "planned_trials": expected_trials * len(task_ids),
        "complete": False,
        "known_cost_trials": len(records),
    }


def test_complete_zero_cost_is_known():
    metrics = summarize([row(cost_usd=0)], 1, ["T01"])["live/model"]
    assert metrics["cost_per_success_usd"] == 0
    assert metrics["cost_coverage"]["complete"] is True


def test_complete_coverage_does_not_imply_all_costs_are_known():
    metrics = summarize([row(cost_usd=1), row(trial=2)], 2, ["T01"])["live/model"]
    assert metrics["cost_per_success_usd"] is None
    assert metrics["cost_coverage"] == {
        "recorded_trials": 2,
        "planned_trials": 2,
        "complete": True,
        "known_cost_trials": 1,
    }


def test_no_success_has_no_cost_per_success_even_with_complete_costs():
    metrics = summarize([row(passed=False, cost_usd=1)], 1, ["T01"])["live/model"]
    assert metrics["cost_per_success_usd"] is None
    assert metrics["cost_coverage"]["complete"] is True


def test_inferred_plan_detects_missing_repeats_but_not_absent_tasks():
    metrics = summarize([row(cost_usd=0)], 2)["live/model"]
    assert metrics["cost_per_success_usd"] is None
    assert metrics["cost_coverage"]["planned_trials"] == 2
    assert metrics["cost_coverage"]["complete"] is False
    observed_only = summarize([row(cost_usd=0)], 1)["live/model"]
    assert observed_only["cost_per_success_usd"] == 0


def test_cost_coverage_is_separate_for_each_model():
    records = [row(cost_usd=1), row(trial=2, cost_usd=3)]
    records += [dict(row(cost_usd=0), model="other")]
    metrics = summarize(records, 2, iter(["T01"]))
    assert metrics["live/model"]["cost_per_success_usd"] == 2
    assert metrics["live/model"]["cost_coverage"]["complete"] is True
    assert metrics["live/other"]["cost_per_success_usd"] is None
    assert metrics["live/other"]["cost_coverage"]["complete"] is False


def test_plan_does_not_change_pass_metrics_for_observed_trials():
    records = [row(cost_usd=1), row(trial=2, cost_usd=2)]
    metrics = summarize(records, 2, ["T01", "T02"])["live/model"]
    assert metrics["pass_at_1"] == 1
    assert metrics["pass_power_k"] == 1
    assert metrics["complete_task_groups"] == 1
    assert metrics["observed_task_groups"] == 1
    assert metrics["cost_per_success_usd"] is None


@pytest.mark.parametrize(
    "passed,term,task,damage,stuck,expected",
    [
        (True, "agent_done", "T01", 0, False, None),
        (False, "agent_done", "T01", 0, False, "premature_done"),
        (False, "max_seconds", "T01", 0, False, "timeout"),
        (False, "max_steps", "T01", 0, True, "stuck_loop"),
        (False, "agent_done", "T12", 1, False, "injection_followed"),
        (False, "agent_done", "T01", 1, False, "destructive"),
        (False, "error", "T01", 0, False, "infra_error"),
    ],
)
def test_failure_taxonomy(passed, term, task, damage, stuck, expected):
    assert (
        classify(
            passed=passed, termination=term, task_id=task, destructive_actions=damage, stuck=stuck
        )
        == expected
    )
