"""Detached sandbox worker. Only uploads are retried; evaluation execution is once-only.

This module intentionally uses the standard library so it can report dependency-install
failures before the project dependencies are installed in a fresh Python sandbox.
"""

import base64
import hashlib
import json
import os
import re
import signal
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

MAX_ARTIFACT_BYTES = 2 * 1024 * 1024
ARTIFACT = re.compile(
    r"(?:results\.json|audit\.json|T(?:0[1-9]|1[0-2])/[1-3]/"
    r"(?:task\.json|result\.json|lifecycle\.jsonl|actions\.jsonl|[0-9]{3,6}\.jpg|final\.jpg))"
)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # A redirect must never forward the per-job upload credential elsewhere.
        return None


def post_json(url, payload, *, attempts=3, opener=None, sleep=time.sleep):
    opener = opener or urllib.request.build_opener(NoRedirect())
    data = json.dumps(payload, separators=(",", ":")).encode()
    for attempt in range(attempts):
        request = urllib.request.Request(
            url, data=data, headers={"Content-Type": "application/json"}, method="POST"
        )
        try:
            with opener.open(request, timeout=20) as response:
                if 200 <= response.status < 300:
                    return
                raise RuntimeError(f"Upload rejected ({response.status})")
        except urllib.error.HTTPError as exc:
            if exc.code not in (408, 429) and exc.code < 500:
                raise RuntimeError(f"Upload rejected ({exc.code})") from None
            if attempt == attempts - 1:
                raise RuntimeError(f"Upload unavailable ({exc.code})") from None
        except (urllib.error.URLError, TimeoutError, OSError):
            if attempt == attempts - 1:
                raise RuntimeError("Upload unavailable after bounded retries") from None
        sleep(min(2**attempt, 4))


def artifact_bytes(root, relative):
    """Read only allowed regular files; never follow links or block on special files."""
    if not ARTIFACT.fullmatch(relative):
        raise ValueError("Unsupported artifact path")
    path = root
    for part in Path(relative).parts:
        path = path / part
        if path.is_symlink():
            raise ValueError("Artifact links are not allowed")
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_ARTIFACT_BYTES:
            raise ValueError("Artifact is not a bounded regular file")
        data = stream.read(MAX_ARTIFACT_BYTES + 1)
        if len(data) > MAX_ARTIFACT_BYTES:
            raise ValueError("Artifact exceeds upload limit")
        if relative.endswith(".json"):
            json.loads(data)  # Skip files while an atomic replacement is still being prepared.
        return data


class Uploader:
    def __init__(self, root, config, post=post_json):
        self.root = root
        self.url = config["callbackUrl"]
        self.identity = {"jobId": config["jobId"], "token": config["token"]}
        self.hashes = {}
        self.post = post

    def flush(self):
        failures = []
        # No recursive glob follows unexpected directories. The job has <=36 known slots.
        paths = ["results.json", "audit.json"]
        for task in range(1, 13):
            for trial in range(1, 4):
                folder = self.root / f"T{task:02}" / str(trial)
                if folder.is_symlink() or folder.parent.is_symlink() or not folder.is_dir():
                    continue
                paths.extend(
                    f"T{task:02}/{trial}/{entry.name}"
                    for entry in folder.iterdir()
                    if ARTIFACT.fullmatch(f"T{task:02}/{trial}/{entry.name}")
                )
        for relative in paths:
            try:
                data = artifact_bytes(self.root, relative)
                digest = hashlib.sha256(data).hexdigest()
                if self.hashes.get(relative) == digest:
                    continue
                self.post(
                    self.url,
                    {
                        **self.identity,
                        "path": relative,
                        "contentBase64": base64.b64encode(data).decode("ascii"),
                    },
                )
                self.hashes[relative] = digest
            except FileNotFoundError:
                continue
            except (ValueError, OSError, RuntimeError):
                failures.append(relative)
        return failures


def validate_config(config):
    url = urllib.parse.urlsplit(config["callbackUrl"])
    if url.scheme != "https" or not url.hostname or url.username or url.password:
        raise ValueError("Callback must use HTTPS without credentials")
    if url.path != "/api/cloud/ingest" or url.query or url.fragment:
        raise ValueError("Invalid callback endpoint")
    if not re.fullmatch(r"cloud_[a-f0-9]{32}", config["jobId"]):
        raise ValueError("Invalid job identity")
    if not re.fullmatch(r"[a-f0-9]{64}", config["token"]):
        raise ValueError("Invalid callback credential")
    if config["mode"] not in ("dry-run", "live"):
        raise ValueError("Invalid execution mode")
    setup = config["setup"]
    if not isinstance(setup["tasks"], list) or not 1 <= len(setup["tasks"]) <= 12:
        raise ValueError("Invalid tasks")
    if len(set(setup["tasks"])) != len(setup["tasks"]) or any(
        not re.fullmatch(r"T(?:0[1-9]|1[0-2])", task) for task in setup["tasks"]
    ):
        raise ValueError("Invalid tasks")
    for field, maximum in (("trials", 3), ("concurrency", 2), ("maxInfraFailures", 3)):
        if type(setup[field]) is not int or not 1 <= setup[field] <= maximum:
            raise ValueError(f"Invalid {field}")
    if setup["provider"] not in ("claude", "openai"):
        raise ValueError("Invalid provider")
    if not re.fullmatch(r"[A-Za-z0-9._:/-]{0,160}", setup["modelId"]):
        raise ValueError("Invalid model identifier")
    return config


def run_args(config, output):
    setup = config["setup"]
    args = [
        sys.executable,
        "-m",
        "gauntlet",
        "run",
        "--tasks",
        ",".join(setup["tasks"]),
        "--trials",
        str(setup["trials"]),
        "--concurrency",
        str(setup["concurrency"]),
        "--max-infra-failures",
        str(setup["maxInfraFailures"]),
        "--model",
        setup["provider"],
        "--out",
        str(output),
        "--fail-on-task-failure",
    ]
    if config["mode"] == "dry-run":
        args.append("--dry-run")
    if setup["modelId"]:
        args.extend(["--model-id", setup["modelId"]])
    return args


def execute(config, *, install=True, interval=5, wall_seconds=2400, output_root=None):
    """The harness gets one process invocation, including on upload failures."""
    validate_config(config)
    output = (output_root or Path("/tmp/gauntlet-runs")) / config["jobId"]
    uploader = Uploader(output, config)
    env = dict(os.environ)
    env.pop("GAUNTLET_CLOUD_CONFIG", None)
    if config["mode"] == "dry-run":
        for key in ("SOLARI_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"):
            env.pop(key, None)
    code, error = 2, None
    child = None
    try:
        if output.exists():
            raise RuntimeError("Job output already exists; refusing to replay execution")
        if install:
            package = ".[live]" if config["mode"] == "live" else "."
            # Installation logs can include private package URLs; do not upload them.
            result = subprocess.run(
                [sys.executable, "-m", "pip", "install", "--disable-pip-version-check", package],
                env=env,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=240,
                check=False,
            )
            if result.returncode:
                raise RuntimeError("Harness dependency installation failed")
        with open("/tmp/gauntlet-worker.log", "ab") as log:
            child = subprocess.Popen(run_args(config, output), env=env, stdout=log, stderr=log)
            deadline = time.monotonic() + wall_seconds
            while child.poll() is None:
                uploader.flush()
                if time.monotonic() >= deadline:
                    child.send_signal(signal.SIGINT)
                    try:
                        child.wait(timeout=30)
                    except subprocess.TimeoutExpired:
                        child.kill()
                        child.wait(timeout=10)
                    error = "Job time limit reached; inspect partial evidence and cleanup records"
                    break
                time.sleep(interval)
            code = child.wait()
    except Exception as exc:
        # Do not expose provider messages, env, command arguments, or callback credentials.
        error = str(exc) if isinstance(exc, RuntimeError) else "Sandbox worker failed"
    finally:
        if child is not None and child.poll() is None:
            child.kill()
            child.wait(timeout=10)
        if output.is_dir():
            try:
                from gauntlet.harness.audit import audit_run

                (output / "audit.json").write_text(json.dumps(audit_run(output)))
            except Exception:
                error = error or "Saved evidence could not be audited"
        failures = uploader.flush()
        if failures:
            error = "Some evidence could not be persisted; the run is incomplete"
        try:
            uploader.post(
                uploader.url,
                {
                    **uploader.identity,
                    "complete": True,
                    "exitCode": code,
                    **({"error": error} if error else {}),
                },
            )
        except RuntimeError:
            return 2  # Server expiry reconciliation exposes an interrupted job.
    return code


def main():
    try:
        config = validate_config(json.loads(os.environ["GAUNTLET_CLOUD_CONFIG"]))
    except (KeyError, ValueError, TypeError):
        print("Invalid cloud worker configuration", file=sys.stderr)
        return 2
    return execute(config)


if __name__ == "__main__":
    sys.exit(main())
