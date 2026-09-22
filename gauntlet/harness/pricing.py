"""Explicit, run-bound API token estimates; no embedded price catalog."""

import json
import math
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path

from gauntlet.agent.usage import count, total_input

CATEGORIES = {"input", "output", "cache_read", "cache_write", "cache_write_5m", "cache_write_1h"}


@dataclass(frozen=True)
class Pricing:
    provider: str
    model: str
    source: str
    usd_per_million: dict[str, float]
    max_input_tokens: int

    def estimate(self, usage: dict[str, int] | None) -> tuple[Decimal | None, str]:
        if usage is None:
            return None, "missing_usage"
        if total_input(usage) > self.max_input_tokens:
            return None, "pricing_limit_exceeded"
        total = Decimal(0)
        for category, tokens in usage.items():
            count(tokens)
            if tokens and category not in self.usd_per_million:
                return None, "missing_rate"
            total += Decimal(tokens) * Decimal(str(self.usd_per_million.get(category, 0)))
        return total / 1_000_000, "estimated"


def load_pricing(path: Path, provider: str, model: str) -> Pricing:
    raw = json.loads(path.read_text())
    required = {"provider", "model", "source", "usd_per_million", "max_input_tokens"}
    if not isinstance(raw, dict) or set(raw) != required:
        raise ValueError(f"Pricing must contain exactly: {', '.join(sorted(required))}")
    if raw["provider"] != provider or raw["model"] != model:
        raise ValueError("Pricing provider/model must match the selected adapter and model ID")
    if not isinstance(raw["source"], str) or not raw["source"].strip():
        raise ValueError("Pricing source must describe the rates and their effective date")
    if type(raw["max_input_tokens"]) is not int or raw["max_input_tokens"] < 1:
        raise ValueError("Pricing max_input_tokens must be a positive integer")
    rates = raw["usd_per_million"]
    if not isinstance(rates, dict) or not {"input", "output"} <= rates.keys() <= CATEGORIES:
        raise ValueError("Pricing requires input/output rates and only supported token categories")
    if any(type(v) not in (int, float) or not math.isfinite(v) or v < 0 for v in rates.values()):
        raise ValueError("Pricing rates must be finite nonnegative numbers")
    return Pricing(**raw)
