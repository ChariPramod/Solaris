import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from gauntlet.agent.claude import DryRunAgent
from gauntlet.harness.backends import SolariDesktop
from gauntlet.harness.lifecycle import LifecycleLog
from gauntlet.harness.runner import run_suite
from gauntlet.models import load_tasks


def entries(folder):
    return [json.loads(line) for line in (folder / "lifecycle.jsonl").read_text().splitlines()]


def mock_client(monkeypatch):
    import solari_desktop

    desktop = SimpleNamespace(id="desktop-test", connect=AsyncMock(), close=AsyncMock())
    client = SimpleNamespace(
        create=AsyncMock(return_value=desktop),
        destroy=AsyncMock(return_value=SimpleNamespace(ok=True)),
        aclose=AsyncMock(),
    )
    monkeypatch.setattr(solari_desktop, "DesktopClient", lambda **kwargs: client)
    monkeypatch.setenv("SOLARI_API_KEY", "secret-must-not-be-logged")
    return client, desktop


async def run_mock(output):
    return await run_suite(
        load_tasks("T02"),
        trials=1,
        concurrency=1,
        model="mock",
        mode="test",
        output=output,
        backend_factory=SolariDesktop,
        agent_factory=DryRunAgent,
        settle_seconds=0,
    )


async def test_id_is_persisted_before_connect_and_survives_connection_failure(
    monkeypatch, tmp_path
):
    client, desktop = mock_client(monkeypatch)
    output = tmp_path / "run"

    async def failed_connect():
        log = entries(output / "T02/1")
        assert log[-1]["event"] == "allocated"
        assert log[-1]["desktop_id"] == desktop.id
        assert log[-1]["run_id"] == json.loads((output / "results.json").read_text())["run_id"]
        raise RuntimeError("Connection lost")

    desktop.connect.side_effect = failed_connect
    manifest = await run_mock(output)
    metadata = client.create.call_args.kwargs["metadata"]
    assert metadata == {
        "application": "gauntlet",
        "task": "T02",
        "trial": "1",
        "run_id": manifest["run_id"],
    }
    client.destroy.assert_awaited_once_with(desktop.id)
    desktop.close.assert_awaited_once()
    client.aclose.assert_awaited_once()
    log = entries(output / "T02/1")
    assert [entry["event"] for entry in log] == [
        "trial_started",
        "stage_started",
        "create_requested",
        "allocated",
        "cleanup_started",
        "desktop_destroyed",
    ]
    assert log[-1]["desktop_id"] == desktop.id
    assert "secret-must-not-be-logged" not in json.dumps(log)
    assert manifest["records"][0]["desktop_id"] == desktop.id


async def test_lost_create_response_keeps_unknown_allocation_evidence(monkeypatch, tmp_path):
    client, _ = mock_client(monkeypatch)
    client.create.side_effect = RuntimeError("Response lost")
    output = tmp_path / "run"
    await run_mock(output)
    log = entries(output / "T02/1")
    assert "create_requested" in [entry["event"] for entry in log]
    assert "allocated" not in [entry["event"] for entry in log]
    assert log[-1]["desktop_id"] is None
    client.destroy.assert_not_awaited()
    client.aclose.assert_awaited_once()


async def test_negative_destroy_acknowledgment_is_retried_and_never_logged_success(
    monkeypatch, tmp_path
):
    from gauntlet.harness.audit import audit_run

    client, desktop = mock_client(monkeypatch)
    desktop.connect.side_effect = RuntimeError("Connection lost")
    client.destroy.return_value = SimpleNamespace(ok=False)
    monkeypatch.setattr("gauntlet.harness.backends.asyncio.sleep", AsyncMock())
    output = tmp_path / "run"
    manifest = await run_mock(output)
    assert client.destroy.await_count == 3
    desktop.close.assert_awaited_once()
    client.aclose.assert_awaited_once()
    log = entries(output / "T02/1")
    assert log[-1]["event"] == "cleanup_failed"
    assert "desktop_destroyed" not in [entry["event"] for entry in log]
    assert "did not confirm" in manifest["records"][0]["cleanup_error"]
    audit = audit_run(output)
    assert audit["cleanup_candidates"][0]["desktop_id"] == desktop.id


@pytest.mark.parametrize("failed_event", ["allocated", "cleanup_started", "desktop_destroyed"])
async def test_journal_failure_never_prevents_resource_cleanup(monkeypatch, tmp_path, failed_event):
    client, desktop = mock_client(monkeypatch)
    desktop.connect.side_effect = RuntimeError("Connection lost")
    original = LifecycleLog.record

    def fail_record(self, event, **details):
        if event == failed_event:
            raise OSError("Simulated full disk")
        original(self, event, **details)

    monkeypatch.setattr(LifecycleLog, "record", fail_record)
    manifest = await run_mock(tmp_path / "run")
    client.destroy.assert_awaited_once_with(desktop.id)
    client.aclose.assert_awaited_once()
    row = manifest["records"][0]
    assert row["desktop_id"] == desktop.id
    assert "Simulated full disk" in (
        row["error"] if failed_event == "allocated" else row["evidence"]["lifecycle_error"]
    )
