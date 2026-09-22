import asyncio
import io
import json
import os
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw

from gauntlet.fixtures.data import seed
from gauntlet.models import Action, Task
from gauntlet.verifiers.state import inspect_state, inventory

REMOTE_ROOT = "/home/user/gauntlet"
PACKAGE = Path(__file__).resolve().parents[1]


class InvalidAction(ValueError):
    """An invalid/unsupported model action; return it to the model as feedback."""


class DryRunDesktop:
    def __init__(self):
        self.temporary = None
        self.root = None
        self.clipboard = ""

    async def start(self, task: Task) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="gauntlet-dry-")
        self.root = Path(self.temporary.name)

    async def setup(self, task: Task) -> None:
        seed(self.root)

    async def baseline(self) -> dict:
        return inventory(self.root / "docs")

    async def inspect(self, task: Task, before: dict) -> dict:
        return inspect_state(self.root, task.verifier, before, task.allowed_changes, self.clipboard)

    async def screenshot(self) -> bytes:
        screen = Image.new("RGB", (1280, 720), "#102923")
        draw = ImageDraw.Draw(screen)
        draw.text((65, 80), "GAUNTLET / DRY RUN", fill="#a9edcb", font_size=42)
        draw.text(
            (65, 170),
            "Static screenshot. No VM or model API was called.",
            fill="white",
            font_size=25,
        )
        draw.text(
            (65, 215),
            "These results are harness checks, not agent benchmarks.",
            fill="white",
            font_size=25,
        )
        buffer = io.BytesIO()
        screen.save(buffer, format="JPEG", quality=70)
        return buffer.getvalue()

    async def execute(self, action: Action) -> None:
        if action.kind not in {"wait", "screenshot"}:
            raise InvalidAction("Dry-run desktop does not execute GUI actions")

    async def destroy(self) -> None:
        if self.temporary:
            self.temporary.cleanup()


class SolariDesktop:
    """Own exactly one desktop; destroy it even if connection or setup fails."""

    def __init__(self, *, template: str = "default"):
        from solari_desktop import DesktopClient

        self.client = DesktopClient(
            api_key=os.environ["SOLARI_API_KEY"],
            base_url=os.getenv("SOLARI_BASE_URL", "https://api.getsolari.com"),
            call_timeout_ms=60_000,
        )
        self.template = template
        self.desktop = None
        self.lifecycle_callback = None
        self.run_metadata = {}

    def track_lifecycle(self, callback, *, run_id: str | None, trial: int) -> None:
        """Record allocation before connecting; identifiers contain no credentials."""
        self.lifecycle_callback = callback
        self.run_metadata = {"trial": str(trial)}
        if run_id:
            self.run_metadata["run_id"] = run_id

    async def start(self, task: Task) -> None:
        from solari_core.errors import ConcurrencyLimitError, NoCapacityError

        for attempt in range(4):
            try:
                if self.lifecycle_callback:
                    self.lifecycle_callback("create_requested", attempt=attempt + 1)
                self.desktop = await self.client.create(
                    template=self.template,
                    resolution="1280x720",
                    cpu=2,
                    mem_mb=4096,
                    timeout_ms=120_000,
                    metadata={"application": "gauntlet", "task": task.id, **self.run_metadata},
                )
                if self.lifecycle_callback:
                    self.lifecycle_callback("allocated", desktop_id=self.desktop.id)
                break
            except (ConcurrencyLimitError, NoCapacityError):
                if self.lifecycle_callback:
                    self.lifecycle_callback("create_rejected", attempt=attempt + 1)
                if attempt == 3:
                    raise
                await asyncio.sleep(2**attempt)
        await self.desktop.connect()
        while not (await self.desktop.health()).ready:
            await asyncio.sleep(0.5)

    async def command(self, command: str, args: list[str]) -> str:
        result = await self.desktop.exec(command, args=args, timeout_ms=120_000)
        if result.exitCode:
            raise RuntimeError(f"Guest {command} failed ({result.exitCode}): {result.stderr}")
        return result.stdout

    async def setup(self, task: Task) -> None:
        # Fresh VMs only. Package installation is preparation, outside agent timing.
        await self.command(
            "sh",
            [
                "-c",
                (PACKAGE / "fixtures" / "provision.sh").read_text(),
                "gauntlet-provision",
                task.id,
            ],
        )
        for name in ("apps.py", "data.py"):
            await self.desktop.fs.write(
                f"{REMOTE_ROOT}/{name}", (PACKAGE / "fixtures" / name).read_bytes()
            )
        if task.setup.get("portal"):
            await self.command("mkdir", ["-p", f"{REMOTE_ROOT}/assets"])
            await self.desktop.fs.write(
                f"{REMOTE_ROOT}/assets/invoice.pdf",
                (PACKAGE / "fixtures/assets/invoice.pdf").read_bytes(),
            )
        await self.command(
            "python3",
            [
                "-c",
                "from pathlib import Path; "
                f"import sys; sys.path.insert(0, {REMOTE_ROOT!r}); "
                f"from data import seed; seed(Path({REMOTE_ROOT!r}))",
            ],
        )
        # No stale clipboard answer can carry over from the base template.
        await self.desktop.clipboard.set("")
        for app in ("formsite", "portal"):
            if not task.setup.get(app):
                continue
            args = [f"{REMOTE_ROOT}/apps.py", "--root", REMOTE_ROOT]
            if app == "portal":
                args.append("--portal")
            else:
                args.extend(f"--{flag}" for flag in ("popup", "injection") if task.setup.get(flag))
            await self.desktop.process.start("python3", args=args)
            port = 8001 if app == "portal" else 8000
            for attempt in range(20):
                try:
                    await self.command(
                        "python3",
                        [
                            "-c",
                            "import urllib.request; "
                            f"urllib.request.urlopen('http://127.0.0.1:{port}', timeout=1).read()",
                        ],
                    )
                    break
                except RuntimeError:
                    if attempt == 19:
                        raise
                    await asyncio.sleep(0.25)

    async def state_request(self, request: dict) -> dict:
        # Re-upload trusted verifier code after agent execution. Keep the baseline on the host.
        source = (PACKAGE / "verifiers" / "state.py").read_text()
        payload = {"root": REMOTE_ROOT, **request}
        output = await self.command("python3", ["-c", source, json.dumps(payload)])
        return json.loads(output)

    async def baseline(self) -> dict:
        return await self.state_request({"operation": "inventory"})

    async def inspect(self, task: Task, before: dict) -> dict:
        clipboard = (
            await self.desktop.clipboard.get() if task.verifier["kind"] == "clipboard" else ""
        )
        return await self.state_request(
            {
                "operation": "verify",
                "config": task.verifier,
                "before": before,
                "allowed": task.allowed_changes,
                "clipboard": clipboard,
            }
        )

    async def screenshot(self) -> bytes:
        return await self.desktop.screenshot(format="jpeg", quality=70)

    async def execute(self, action: Action) -> None:
        desktop, params, kind = self.desktop, action.params, action.kind

        def coordinate(name="coordinate"):
            value = params.get(name)
            if (
                not isinstance(value, (list, tuple))
                or len(value) != 2
                or any(type(v) is not int for v in value)
                or not 0 <= value[0] < 1280
                or not 0 <= value[1] < 720
            ):
                raise InvalidAction(f"Invalid {name}: {value}")
            return value

        if kind == "screenshot":
            return
        if kind in {
            "left_click",
            "right_click",
            "middle_click",
            "double_click",
            "triple_click",
            "mouse_move",
            "left_mouse_down",
            "left_mouse_up",
        }:
            if "coordinate" in params:
                x, y = coordinate()
            else:
                cursor = await desktop.display.cursor()
                x, y = cursor["x"], cursor["y"]
            if kind.endswith("click") and kind not in {"double_click", "triple_click"}:
                await desktop.mouse.click(x, y, button=kind.split("_")[0], humanize=False)
            elif kind == "double_click":
                await desktop.mouse.double_click(x, y)
            elif kind == "triple_click":
                await desktop.mouse.double_click(x, y)
                await desktop.mouse.click(x, y, humanize=False)
            elif kind == "mouse_move":
                await desktop.mouse.move(x, y, humanize=False)
            elif kind == "left_mouse_down":
                await desktop.mouse.down(x, y)
            else:
                await desktop.mouse.up(x, y)
        elif kind in {"type", "key", "hold_key"}:
            text = params.get("text")
            if not isinstance(text, str) or not text or len(text) > 10000:
                raise InvalidAction("Expected nonempty text, at most 10000 characters")
            if kind == "type":
                await desktop.keyboard.type(text)
            elif kind == "key":
                await desktop.keyboard.press(text.split("+"))
            else:
                duration = bounded_duration(params)
                await desktop.keyboard.down(text.split("+"))
                try:
                    await asyncio.sleep(duration)
                finally:
                    await desktop.keyboard.up(text.split("+"))
        elif kind == "scroll":
            direction = params.get("scroll_direction")
            amount = params.get("scroll_amount")
            if direction not in {"up", "down", "left", "right"} or type(amount) is not int:
                raise InvalidAction("Invalid scroll direction/amount")
            if not 1 <= amount <= 20:
                raise InvalidAction("Scroll amount must be 1–20")
            if "coordinate" in params:
                await desktop.mouse.move(*coordinate(), humanize=False)
            # SDK mouse.scroll exposes neither direction nor amount. X11 wheel events
            # preserve the native tool semantics without giving the model an exec tool.
            button = {"up": "4", "down": "5", "left": "6", "right": "7"}[direction]
            await self.command(
                "xdotool", ["click", "--repeat", str(amount), "--delay", "50", button]
            )
        elif kind == "left_click_drag":
            x, y = coordinate()
            cursor = await desktop.display.cursor()
            await desktop.mouse.drag(cursor, {"x": x, "y": y})
        elif kind == "wait":
            await asyncio.sleep(bounded_duration(params))
        else:
            raise InvalidAction(f"Unsupported action: {kind}")

    async def destroy(self) -> None:
        try:
            if self.desktop:
                # close() alone leaves a billable VM alive. Retry idempotent destruction.
                try:
                    for attempt in range(3):
                        try:
                            response = await self.client.destroy(self.desktop.id)
                            if response.ok is not True:
                                raise RuntimeError("Provider did not confirm desktop destruction")
                            break
                        except Exception as exc:
                            if attempt == 2:
                                raise RuntimeError(
                                    f"Could not destroy VM {self.desktop.id}: {exc}"
                                ) from exc
                            await asyncio.sleep(2**attempt)
                finally:
                    await self.desktop.close()
        finally:
            await self.client.aclose()


def bounded_duration(params: dict) -> float:
    value = params.get("duration", 0.5)
    if type(value) not in (int, float) or not 0 <= value <= 10:
        raise InvalidAction("Duration must be between 0 and 10 seconds")
    return value
