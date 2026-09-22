import json
from decimal import Decimal

import pytest

from gauntlet.agent.usage import normalize_usage, total_input
from gauntlet.harness.pricing import Pricing, load_pricing


def test_openai_cache_reads_and_writes_are_subtracted_once():
    usage = normalize_usage(
        "openai",
        {
            "input_tokens": 1000,
            "output_tokens": 200,
            "input_tokens_details": {"cached_tokens": 600, "cache_write_tokens": 100},
            "output_tokens_details": {"reasoning_tokens": 150},
        },
    )
    rates = Pricing(
        "openai",
        "test",
        "synthetic",
        {
            "input": 2,
            "output": 10,
            "cache_read": 0.2,
            "cache_write": 2.5,
        },
        1000,
    )
    assert total_input(usage) == 1000
    assert rates.estimate(usage) == (Decimal("0.00297"), "estimated")


def test_claude_usage_includes_both_cache_ttls_without_double_counting():
    usage = normalize_usage(
        "claude",
        {
            "input_tokens": 100,
            "output_tokens": 20,
            "cache_read_input_tokens": 200,
            "cache_creation_input_tokens": 80,
            "cache_creation": {"ephemeral_5m_input_tokens": 50, "ephemeral_1h_input_tokens": 30},
        },
    )
    assert total_input(usage) == 380
    rates = Pricing(
        "claude",
        "test",
        "synthetic",
        {
            "input": 3,
            "output": 15,
            "cache_read": 0.3,
            "cache_write_5m": 3.75,
            "cache_write_1h": 6,
        },
        1000,
    )
    assert rates.estimate(usage) == (Decimal("0.0010275"), "estimated")


@pytest.mark.parametrize(
    "provider,raw",
    [
        ("openai", None),
        ("openai", {"input_tokens": 1, "output_tokens": 2}),
        (
            "openai",
            {"input_tokens": 1, "output_tokens": 2, "input_tokens_details": {"cached_tokens": 2}},
        ),
        ("claude", {"input_tokens": -1, "output_tokens": 2}),
        ("claude", {"input_tokens": 1, "output_tokens": 2, "cache_read_input_tokens": False}),
        (
            "claude",
            {
                "input_tokens": 1,
                "output_tokens": 2,
                "cache_creation_input_tokens": 10,
                "cache_creation": {"ephemeral_5m_input_tokens": 5, "ephemeral_1h_input_tokens": 0},
            },
        ),
    ],
)
def test_unknown_or_inconsistent_usage_stays_unknown(provider, raw):
    assert normalize_usage(provider, raw) is None


def test_missing_cache_rate_and_context_tier_never_assume_zero():
    rates = Pricing("openai", "test", "synthetic", {"input": 2, "output": 10}, 1000)
    assert rates.estimate(None) == (None, "missing_usage")
    assert rates.estimate({"input": 1, "cache_read": 1}) == (None, "missing_rate")
    assert rates.estimate({"input": 1001}) == (None, "pricing_limit_exceeded")
    assert rates.estimate({"input": 1, "output": 0, "cache_read": 0})[0] == Decimal("0.000002")


@pytest.mark.parametrize(
    "overrides",
    [
        {"model": "wrong"},
        {"provider": "claude"},
        {"source": ""},
        {"usd_per_million": {"input": -1, "output": 1}},
        {"usd_per_million": {"input": True, "output": 1}},
        {"usd_per_million": {"input": float("inf"), "output": 1}},
        {"usd_per_million": {"input": 1, "output": 1, "typo": 1}},
        {"max_input_tokens": 0},
        {"extra": "unexpected"},
    ],
)
def test_pricing_file_validation(tmp_path, overrides):
    raw = {
        "provider": "openai",
        "model": "test",
        "source": "Synthetic test fixture",
        "max_input_tokens": 1000,
        "usd_per_million": {"input": 1, "output": 2},
    }
    path = tmp_path / "pricing.json"
    path.write_text(json.dumps(raw))
    assert load_pricing(path, "openai", "test").model == "test"
    path.write_text(json.dumps({**raw, **overrides}))
    with pytest.raises(ValueError):
        load_pricing(path, "openai", "test")
