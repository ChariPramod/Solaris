from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from gauntlet.agent.claude import ClaudeAgent
from gauntlet.harness.backends import InvalidAction, SolariDesktop
from gauntlet.models import Action


async def test_claude_adapter_reports_total_input_including_cache(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-only")
    agent = ClaudeAgent("test-model")
    assert agent.client.max_retries == 0
    await agent.client.close()
    raw = {
        "content": [{"type": "text", "text": "Done"}],
        "stop_reason": "end_turn",
        "usage": {
            "input_tokens": 10,
            "output_tokens": 5,
            "cache_read_input_tokens": 100,
            "cache_creation_input_tokens": 20,
        },
    }
    agent.client = SimpleNamespace(
        beta=SimpleNamespace(
            messages=SimpleNamespace(
                create=AsyncMock(
                    return_value=SimpleNamespace(
                        model_dump=lambda **kw: raw,
                        usage=SimpleNamespace(input_tokens=10, output_tokens=5),
                    )
                )
            )
        )
    )
    decision = await agent.next_action(b"jpeg", "Task")
    assert decision.tokens_in == 130
    assert decision.usage == {"input": 10, "output": 5, "cache_read": 100, "cache_write": 20}


async def test_claude_returns_tool_results_with_screenshot_and_error(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key-not-real")
    agent = ClaudeAgent("claude-sonnet-4-6")
    await agent.client.close()
    raw = {
        "content": [
            {
                "type": "tool_use",
                "id": "call-1",
                "name": "computer",
                "input": {"action": "key", "text": "ctrl+s"},
            }
        ],
        "stop_reason": "tool_use",
    }
    response = SimpleNamespace(
        model_dump=lambda **kw: raw, usage=SimpleNamespace(input_tokens=100, output_tokens=20)
    )
    create = AsyncMock(return_value=response)
    agent.client = SimpleNamespace(
        beta=SimpleNamespace(messages=SimpleNamespace(create=create)), close=AsyncMock()
    )
    decision = await agent.next_action(b"jpeg", "Write a note")
    assert decision.action == Action("key", {"text": "ctrl+s"})
    await agent.next_action(b"next jpeg", "Write a note", "Invalid key")
    message = agent.messages[-2]["content"][0]
    assert message["tool_use_id"] == "call-1"
    assert message["is_error"]
    assert message["content"][1]["source"]["media_type"] == "image/jpeg"
    assert create.call_args.kwargs["tools"][0]["type"] == "computer_20251124"


def backend():
    result = object.__new__(SolariDesktop)
    result.desktop = SimpleNamespace(
        mouse=SimpleNamespace(click=AsyncMock(), move=AsyncMock(), drag=AsyncMock()),
        keyboard=SimpleNamespace(press=AsyncMock(), type=AsyncMock()),
        display=SimpleNamespace(cursor=AsyncMock(return_value={"x": 10, "y": 20})),
    )
    result.command = AsyncMock()
    return result


async def test_directional_scroll_uses_explicit_x11_wheel_events():
    desktop = backend()
    await desktop.execute(
        Action("scroll", {"coordinate": [30, 40], "scroll_direction": "down", "scroll_amount": 3})
    )
    desktop.desktop.mouse.move.assert_awaited_once_with(30, 40, humanize=False)
    desktop.command.assert_awaited_once_with(
        "xdotool", ["click", "--repeat", "3", "--delay", "50", "5"]
    )


async def test_key_chords_are_separate_keys():
    desktop = backend()
    await desktop.execute(Action("key", {"text": "ctrl+s"}))
    desktop.desktop.keyboard.press.assert_awaited_once_with(["ctrl", "s"])


async def test_invalid_coordinates_never_reach_desktop():
    desktop = backend()
    with pytest.raises(InvalidAction):
        await desktop.execute(Action("left_click", {"coordinate": [1280, -1]}))
    desktop.desktop.mouse.click.assert_not_awaited()


@pytest.mark.parametrize(
    "raw",
    [
        {"content": [], "stop_reason": "max_tokens"},
        {
            "content": [{"type": "tool_use", "id": "call-1", "name": "computer", "input": {}}],
            "stop_reason": "tool_use",
        },
        {
            "content": [
                {
                    "type": "tool_use",
                    "id": "call-1",
                    "name": "bash",
                    "input": {"action": "type", "text": "shell"},
                }
            ],
            "stop_reason": "tool_use",
        },
        {
            "content": [
                {
                    "type": "tool_use",
                    "id": "call-1",
                    "name": "computer",
                    "input": {"action": "done"},
                }
            ],
            "stop_reason": "tool_use",
        },
        {
            "content": [
                {
                    "type": "tool_use",
                    "id": "call-1",
                    "name": "computer",
                    "input": {"action": "key", "text": "Return"},
                }
            ]
            * 2,
            "stop_reason": "tool_use",
        },
    ],
)
async def test_unusable_model_response_preserves_raw_and_usage(raw):
    agent = object.__new__(ClaudeAgent)
    agent.model, agent.messages, agent.pending_id = "test-model", [], None
    response = SimpleNamespace(
        model_dump=lambda **kw: raw, usage=SimpleNamespace(input_tokens=123, output_tokens=45)
    )
    agent.client = SimpleNamespace(
        beta=SimpleNamespace(messages=SimpleNamespace(create=AsyncMock(return_value=response)))
    )
    decision = await agent.next_action(b"jpeg", "Write a note")
    assert decision.action.kind == "invalid_response"
    assert decision.raw == raw
    assert (decision.tokens_in, decision.tokens_out) == (123, 45)
