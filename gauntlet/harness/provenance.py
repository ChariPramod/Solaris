"""Record benchmark inputs and implementation hashes without environment secrets."""

import hashlib
import platform
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path


def provenance() -> dict:
    package = Path(__file__).resolve().parents[1]
    files = {
        str(path.relative_to(package)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(package.rglob("*"))
        if path.is_file() and path.suffix in {".py", ".yaml", ".sh", ".pdf", ".html", ".css", ".js"}
    }
    dependencies = {}
    for name in (
        "solari-gauntlet",
        "solari-desktop",
        "anthropic",
        "openai",
        "PyYAML",
        "Flask",
        "Pillow",
    ):
        try:
            dependencies[name] = version(name)
        except PackageNotFoundError:
            dependencies[name] = None
    return {
        "python": platform.python_version(),
        "dependencies": dependencies,
        "package_files_sha256": files,
    }
