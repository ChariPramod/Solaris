import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import openai
import pytest

from gauntlet.agent.openai import OpenAIAgent, action_schema, parse_action
from gauntlet.models import Action


def response(action=None, **overrides):
    return {
        "id": "resp_test",
        "object": "response",
        "created_at": 1,
        "model": "test-model",
        "status": "completed",
        "parallel_tool_calls": False,
        "output": [
            {
                "type": "message",
                "id": "msg_test",
                "role": "assistant",
                "status": "completed",
                "content": [
                    {
                        "type": "output_text",
                        "annotations": [],
                        "text": json.dumps(
                            {"action": action or {"kind": "done", "reason": "saved"}}
                        ),
                    }
                ],
            }
        ],
        "usage": {
            "input_tokens": 100,
            "output_tokens": 30,
            "total_tokens": 130,
            "input_tokens_details": {"cached_tokens": 40, "cache_write_tokens": 10},
            "output_tokens_details": {"reasoning_tokens": 20},
        },
        **overrides,
    }


async def test_real_sdk_serializes_vision_schema_history_and_error_without_network(monkeypatch):
    requests = []

    def handle(request):
        requests.append(json.loads(request.content))
        action = {"kind": "key", "text": "ctrl+s"} if len(requests) == 1 else None
        return httpx.Response(200, json=response(action))

    client = openai.AsyncOpenAI(
        api_key="test-only",
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(handle)),
        max_retries=0,
    )
    constructor_args = []

    def factory(**kwargs):
        constructor_args.append(kwargs)
        return client

    monkeypatch.setattr(openai, "AsyncOpenAI", factory)
    agent = OpenAIAgent("test-model")
    try:
        first = await agent.next_action(b"jpeg", "Save the note")
        assert first.action == Action("key", {"text": "ctrl+s"})
        assert first.usage == {"input": 50, "output": 30, "cache_read": 40, "cache_write": 10}
        assert (first.tokens_in, first.tokens_out) == (100, 30)
        second = await agent.next_action(b"next", "Save the note", "Invalid key")
        assert second.action.kind == "done"
        assert requests[0]["store"] is False
        assert "tools" not in requests[0]
        assert requests[0]["text"]["format"]["schema"] == action_schema()
        assert (
            requests[0]["input"][0]["content"][1]["image_url"] == "data:image/jpeg;base64,anBlZw=="
        )
        assert requests[1]["input"][1]["role"] == "assistant"
        assert "Invalid key" in requests[1]["input"][-1]["content"][0]["text"]
        assert constructor_args == [{"max_retries": 0, "timeout": 60}]
    finally:
        await agent.close()
    assert client.is_closed()


@pytest.mark.parametrize(
    "raw",
    [
        response(status="incomplete"),
        response(output=[]),
        response(output=[{"type": "message", "content": [{"type": "refusal", "refusal": "No"}]}]),
        response({"kind": "bash", "text": "whoami"}),
        response({"kind": "left_click", "coordinate": [1280, 1]}),
        response(output=[{"type": "function_call"}]),
        response(output=[{"type": "message", "content": [{"type": "output_text", "text": "{"}]}]),
    ],
)
async def test_unusable_responses_preserve_usage_and_raw(raw):
    agent = object.__new__(OpenAIAgent)
    agent.model, agent.messages = "test-model", []
    agent.client = SimpleNamespace(
        responses=SimpleNamespace(
            create=AsyncMock(return_value=SimpleNamespace(model_dump=lambda **kw: raw))
        )
    )
    result = await agent.next_action(b"jpeg", "Task")
    assert result.action.kind == "invalid_response"
    assert result.raw == raw
    assert (result.tokens_in, result.tokens_out) == (100, 30)


@pytest.mark.parametrize(
    "action",
    [
        {"kind": "scroll", "coordinate": [20, 30], "scroll_direction": "down", "scroll_amount": 3},
        {"kind": "left_click_drag", "coordinate": [1279, 719]},
        {"kind": "hold_key", "text": "shift", "duration": 1.5},
        {"kind": "type", "text": "A note"},
        {"kind": "screenshot"},
    ],
)
def test_action_mapping(action):
    assert parse_action(json.dumps({"action": action})) == Action(
        action["kind"], {key: value for key, value in action.items() if key != "kind"}
    )


@pytest.mark.parametrize(
    "action",
    [
        {"kind": "wait", "duration": True},
        {"kind": "wait", "duration": float("nan")},
        {"kind": "done", "reason": "done", "command": "hidden"},
        {"kind": "left_click", "coordinate": [True, 2]},
        {"kind": "scroll", "coordinate": [0, 0], "scroll_direction": [], "scroll_amount": 1},
    ],
)
def test_invalid_action_parameters_are_rejected(action):
    with pytest.raises(ValueError):
        parse_action(json.dumps({"action": action}))
