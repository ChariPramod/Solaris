"""Normalize provider usage into disjoint billable token categories."""


def count(value) -> int:
    if type(value) is not int or value < 0:
        raise ValueError("Token counts must be nonnegative integers")
    return value


def normalize_usage(provider: str, raw: dict | None) -> dict[str, int] | None:
    try:
        result = {"input": count(raw["input_tokens"]), "output": count(raw["output_tokens"])}
        if provider == "openai":
            details = raw["input_tokens_details"]
            result["cache_read"] = count(details["cached_tokens"])
            result["cache_write"] = count(details.get("cache_write_tokens", 0))
            result["input"] = count(result["input"] - result["cache_read"] - result["cache_write"])
        elif provider == "claude":
            reads = raw.get("cache_read_input_tokens")
            creation = raw.get("cache_creation_input_tokens")
            result["cache_read"] = count(0 if reads is None else reads)
            writes = count(0 if creation is None else creation)
            details = raw.get("cache_creation")
            if details:
                result["cache_write_5m"] = count(details["ephemeral_5m_input_tokens"])
                result["cache_write_1h"] = count(details["ephemeral_1h_input_tokens"])
                if result["cache_write_5m"] + result["cache_write_1h"] != writes:
                    return None
            else:
                result["cache_write"] = writes
        else:
            return None
        return result
    except (KeyError, TypeError, ValueError):
        return None


def total_input(usage: dict[str, int]) -> int:
    return sum(value for name, value in usage.items() if name != "output")
