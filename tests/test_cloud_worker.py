import base64
import json
import urllib.error

import pytest

from gauntlet import cloud_worker
from gauntlet.cloud_worker import Uploader, artifact_bytes, post_json, run_args, validate_config


@pytest.fixture
def config():
    return {
        "jobId": "cloud_" + "a" * 32,
        "token": "b" * 64,
        "callbackUrl": "https://solaris.example.com/api/cloud/ingest",
        "mode": "dry-run",
        "setup": {
            "tasks": ["T01"],
            "trials": 1,
            "concurrency": 1,
            "maxInfraFailures": 1,
            "provider": "claude",
            "modelId": "",
        },
    }


def test_uploads_only_evidence_and_reuploads_changed_content(tmp_path, config):
    (tmp_path / "results.json").write_text('{"status":"running"}')
    folder = tmp_path / "T01/1"
    folder.mkdir(parents=True)
    (folder / "001.jpg").write_bytes(b"image")
    (folder / ".env").write_text("secret")
    (tmp_path / "report.html").write_text("private script")
    calls = []
    uploader = Uploader(tmp_path, config, post=lambda url, payload: calls.append(payload))
    assert uploader.flush() == []
    assert {row["path"] for row in calls} == {"results.json", "T01/1/001.jpg"}
    assert base64.b64decode(calls[1]["contentBase64"]) == b"image"
    uploader.flush()
    assert len(calls) == 2
    (tmp_path / "results.json").write_text('{"status":"complete"}')
    uploader.flush()
    assert len(calls) == 3


def test_failed_upload_is_retried_later_without_marking_persisted(tmp_path, config):
    (tmp_path / "results.json").write_text("{}")
    calls = []

    def post(url, payload):
        calls.append(payload)
        if len(calls) == 1:
            raise RuntimeError("offline")

    uploader = Uploader(tmp_path, config, post=post)
    assert uploader.flush() == ["results.json"]
    assert uploader.hashes == {}
    assert uploader.flush() == []
    assert len(calls) == 2


def test_unsafe_and_oversized_artifacts_rejected(tmp_path):
    (tmp_path / "outside.json").write_text("{}")
    (tmp_path / "results.json").symlink_to(tmp_path / "outside.json")
    with pytest.raises(ValueError, match="links"):
        artifact_bytes(tmp_path, "results.json")
    with pytest.raises(ValueError, match="Unsupported"):
        artifact_bytes(tmp_path, "../outside.json")
    (tmp_path / "results.json").unlink()
    (tmp_path / "results.json").write_bytes(b"x" * (2 * 1024 * 1024 + 1))
    with pytest.raises(ValueError, match="bounded"):
        artifact_bytes(tmp_path, "results.json")


@pytest.mark.parametrize(
    "url",
    [
        "http://example.com/api/cloud/ingest",
        "https://user:pass@example.com/api/cloud/ingest",
        "https://example.com/elsewhere",
        "https://example.com/api/cloud/ingest?token=secret",
    ],
)
def test_callback_validation(config, url):
    config["callbackUrl"] = url
    with pytest.raises(ValueError):
        validate_config(config)


def test_setup_validation_and_no_shell_interpolation(config, tmp_path):
    assert validate_config(config) is config
    args = run_args(config, tmp_path)
    assert "--dry-run" in args
    assert "--fail-on-task-failure" in args
    config["setup"]["modelId"] = "$(touch /tmp/pwn)"
    with pytest.raises(ValueError):
        validate_config(config)
    config["setup"]["modelId"] = ""
    config["setup"]["trials"] = True
    with pytest.raises(ValueError):
        validate_config(config)


@pytest.mark.parametrize("status, expected_calls", [(401, 1), (307, 1), (429, 3), (503, 3)])
def test_upload_retries_only_transient_errors(config, status, expected_calls):
    class Opener:
        calls = 0

        def open(self, request, timeout):
            self.calls += 1
            assert json.loads(request.data)["token"] == config["token"]
            raise urllib.error.HTTPError(request.full_url, status, "error", {}, None)

    opener = Opener()
    with pytest.raises(RuntimeError, match="Upload"):
        post_json(config["callbackUrl"], config, opener=opener, sleep=lambda _: None)
    assert opener.calls == expected_calls


def test_dependency_failure_reports_completion_and_does_not_launch(config, tmp_path, monkeypatch):
    callbacks = []
    launches = []

    class InstallResult:
        returncode = 1

    monkeypatch.setattr(cloud_worker.subprocess, "run", lambda *a, **kw: InstallResult())
    monkeypatch.setattr(cloud_worker.subprocess, "Popen", lambda *a, **kw: launches.append(a))
    real_uploader = cloud_worker.Uploader
    monkeypatch.setattr(
        cloud_worker,
        "Uploader",
        lambda root, conf: real_uploader(root, conf, post=lambda url, data: callbacks.append(data)),
    )
    assert cloud_worker.execute(config, output_root=tmp_path) == 2
    assert launches == []
    assert callbacks[-1]["complete"] is True
    assert callbacks[-1]["error"] == "Harness dependency installation failed"


def test_worker_evaluates_once_and_finalizes_when_uploads_fail(config, tmp_path, monkeypatch):
    launches, callbacks = [], []

    class Process:
        def poll(self):
            return 3

        def wait(self, **kw):
            return 3

    def launch(args, **kwargs):
        launches.append(args)
        assert "GAUNTLET_CLOUD_CONFIG" not in kwargs["env"]
        assert "SOLARI_API_KEY" not in kwargs["env"]
        return Process()

    class FailingUploader:
        identity = {"jobId": config["jobId"], "token": config["token"]}
        url = config["callbackUrl"]

        def __init__(self, *a):
            pass

        def flush(self):
            return ["results.json"]

        def post(self, url, data):
            callbacks.append(data)

    monkeypatch.setenv("SOLARI_API_KEY", "must-not-pass-to-dry-run")
    monkeypatch.setenv("GAUNTLET_CLOUD_CONFIG", "secret")
    monkeypatch.setattr(cloud_worker.subprocess, "Popen", launch)
    monkeypatch.setattr(cloud_worker, "Uploader", FailingUploader)
    assert cloud_worker.execute(config, install=False, output_root=tmp_path) == 3
    assert len(launches) == 1
    assert callbacks[-1]["exitCode"] == 3
    assert "incomplete" in callbacks[-1]["error"]


def test_real_dry_worker_persists_manifest_audit_and_trial_before_completion(
    config, tmp_path, monkeypatch
):
    callbacks = []
    real_uploader = cloud_worker.Uploader
    monkeypatch.setattr(
        cloud_worker,
        "Uploader",
        lambda root, conf: real_uploader(root, conf, post=lambda url, data: callbacks.append(data)),
    )
    assert cloud_worker.execute(config, install=False, interval=0.05, output_root=tmp_path) == 3
    assert callbacks[-1]["complete"] is True
    assert "error" not in callbacks[-1]
    saved = {
        row["path"]: base64.b64decode(row["contentBase64"]) for row in callbacks if "path" in row
    }
    assert {"results.json", "audit.json", "T01/1/result.json", "T01/1/task.json"} <= saved.keys()
    manifest = json.loads(saved["results.json"])
    assert manifest["mode"] == "dry-run"
    assert manifest["status"] == "complete"
    assert len(manifest["records"]) == 1
    assert json.loads(saved["audit.json"])["healthy"] is True


def test_cancel_before_launch_skips_install_and_execution(config, tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(cloud_worker.ExecutionControl, "_check", lambda self: True)
    monkeypatch.setattr(cloud_worker.subprocess, "run", lambda *a, **kw: pytest.fail("installed"))
    monkeypatch.setattr(cloud_worker.subprocess, "Popen", lambda *a, **kw: pytest.fail("launched"))
    real_uploader = cloud_worker.Uploader
    monkeypatch.setattr(
        cloud_worker,
        "Uploader",
        lambda root, conf: real_uploader(
            root, conf, post=lambda url, payload: calls.append(payload)
        ),
    )
    assert cloud_worker.execute(config, output_root=tmp_path) == 130
    assert calls[-1]["cancelled"] is True
    assert calls[-1]["exitCode"] == 130


def test_unavailable_control_prevents_launch(config, tmp_path, monkeypatch):
    def offline(self):
        raise RuntimeError("Upload unavailable after bounded retries")

    calls = []
    monkeypatch.setattr(cloud_worker.ExecutionControl, "_check", offline)
    monkeypatch.setattr(cloud_worker.subprocess, "Popen", lambda *a, **kw: pytest.fail("launched"))
    real_uploader = cloud_worker.Uploader
    monkeypatch.setattr(
        cloud_worker,
        "Uploader",
        lambda root, conf: real_uploader(
            root, conf, post=lambda url, payload: calls.append(payload)
        ),
    )
    assert cloud_worker.execute(config, install=False, output_root=tmp_path) == 2
    assert "cancelled" not in calls[-1]
    assert "unavailable" in calls[-1]["error"]


@pytest.mark.parametrize("force", [False, True])
def test_control_interrupts_once_and_waits_for_cleanup(config, force):
    import signal
    import subprocess
    import time

    signals, kills, waits = [], [], []

    class Process:
        def poll(self):
            return None

        def send_signal(self, value):
            signals.append(value)

        def wait(self, timeout):
            waits.append(timeout)
            if force and len(waits) == 1:
                raise subprocess.TimeoutExpired("harness", timeout)
            return 130

        def kill(self):
            kills.append(True)

    control = cloud_worker.ExecutionControl(config, check=lambda: True)
    control.watch(Process(), time.monotonic() + 60)
    assert signals == [signal.SIGINT]
    assert waits[0] == 150
    assert len(kills) == int(force)
    assert control.cancelled is True
    assert ("cleanup is unconfirmed" in control.error) if force else control.error is None


def test_control_outage_stops_execution_after_three_failures(config):
    import time

    checks, signals = [], []

    def offline():
        checks.append(True)
        raise RuntimeError("offline")

    class Process:
        def poll(self):
            return None

        def send_signal(self, value):
            signals.append(value)

        def wait(self, timeout):
            return 130

    control = cloud_worker.ExecutionControl(config, check=offline, interval=0)
    control.watch(Process(), time.monotonic() + 60)
    assert len(checks) == 3
    assert len(signals) == 1
    assert control.cancelled is False
    assert "control is unavailable" in control.error


@pytest.mark.parametrize("payload", [b"{}", b'{"cancelRequested":"yes"}', b"[]", b"x" * 4097])
def test_worker_rejects_invalid_control_responses(config, payload):
    from io import BytesIO

    class Response(BytesIO):
        status = 200

    class Opener:
        def open(self, request, timeout):
            assert timeout == 5
            return Response(payload)

    with pytest.raises(RuntimeError, match="control response"):
        post_json(config["callbackUrl"], {"control": True}, opener=Opener(), timeout=5)


def test_real_child_cancellation_persists_final_evidence_during_slow_upload(
    config, tmp_path, monkeypatch
):
    import sys
    import time

    output = tmp_path / config["jobId"]
    ready = tmp_path / "ready"
    script = """
import json, signal, sys, time
from pathlib import Path
folder = Path(sys.argv[1]) / "T01/1"
folder.mkdir(parents=True)
def finish(*args):
    (folder / "lifecycle.jsonl").write_text('{"event":"test_cleanup_finished"}\\n')
    raise SystemExit(130)
signal.signal(signal.SIGINT, finish)
Path(sys.argv[2]).touch()
while True:
    time.sleep(0.01)
"""
    callbacks, children = [], []
    real_popen = cloud_worker.subprocess.Popen
    real_uploader = cloud_worker.Uploader
    real_control = cloud_worker.ExecutionControl

    def launch(*args, **kwargs):
        child = real_popen(*args, **kwargs)
        children.append(child)
        return child

    class SlowUploader(real_uploader):
        def flush(self):
            # Cancellation must remain responsive while the main upload loop blocks.
            if children and children[0].poll() is None:
                children[0].wait(timeout=5)
            return super().flush()

    monkeypatch.setattr(
        cloud_worker, "run_args", lambda *_: [sys.executable, "-c", script, str(output), str(ready)]
    )
    monkeypatch.setattr(cloud_worker.subprocess, "Popen", launch)
    monkeypatch.setattr(
        cloud_worker,
        "ExecutionControl",
        lambda conf: real_control(conf, check=ready.exists, interval=0.01),
    )
    monkeypatch.setattr(
        cloud_worker,
        "Uploader",
        lambda root, conf: SlowUploader(root, conf, post=lambda url, data: callbacks.append(data)),
    )
    started = time.monotonic()
    assert cloud_worker.execute(config, install=False, interval=0.01, output_root=tmp_path) == 130
    assert time.monotonic() - started < 5
    assert len(children) == 1
    assert children[0].poll() == 130
    assert callbacks[-1]["cancelled"] is True
    evidence = [row for row in callbacks[:-1] if row.get("path") == "T01/1/lifecycle.jsonl"]
    assert len(evidence) == 1
    assert b"test_cleanup_finished" in base64.b64decode(evidence[0]["contentBase64"])


def test_natural_completion_wins_control_response_in_flight(config):
    import time

    class Process:
        result = None

        def poll(self):
            return self.result

        def send_signal(self, value):
            pytest.fail("must not interrupt a completed process")

    child = Process()

    def late_cancel():
        child.result = 3
        return True

    control = cloud_worker.ExecutionControl(config, check=late_cancel)
    control.watch(child, time.monotonic() + 60)
    assert control.cancelled is False
    assert control.error is None
