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
