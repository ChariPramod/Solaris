"""Stdlib-only checks; the same file is uploaded and executed in the guest.

Verifier configuration and the before-state are supplied by the host after the
agent stops. Neither the expected answers nor the baseline live in the guest.
"""

import hashlib
import json
import re
import stat
import xml.etree.ElementTree as ET
import zipfile
from decimal import Decimal, InvalidOperation
from pathlib import Path

NS = {
    "office": "urn:oasis:names:tc:opendocument:xmlns:office:1.0",
    "table": "urn:oasis:names:tc:opendocument:xmlns:table:1.0",
}


def limited_read(path: Path, limit: int = 1_048_576) -> bytes:
    if path.is_symlink() or not stat.S_ISREG(path.stat().st_mode):
        raise ValueError("Expected a regular file, not a link or special file")
    with path.open("rb") as stream:
        content = stream.read(limit + 1)
    if len(content) > limit:
        raise ValueError(f"Output exceeds {limit} bytes")
    return content


def ods_cell(path: Path, reference: str) -> dict:
    """Read a saved numeric cell without expanding ODF repeated rows/columns.

    Reads the first sheet's cached numeric value, not displayed text or formula
    text. This verifies saved state; it does not recalculate formulas.
    """
    match = re.fullmatch(r"([A-Z]+)([1-9]\d*)", reference)
    if not match:
        raise ValueError("Invalid cell reference")
    column = 0
    for letter in match[1]:
        column = column * 26 + ord(letter) - ord("A") + 1
    row_number = int(match[2])
    if path.is_symlink() or not stat.S_ISREG(path.stat().st_mode):
        raise ValueError("Expected a regular ODS file")
    with zipfile.ZipFile(path) as archive:
        if archive.getinfo("mimetype").file_size > 128:
            raise ValueError("Invalid ODS mimetype")
        if archive.read("mimetype") != b"application/vnd.oasis.opendocument.spreadsheet":
            raise ValueError("Output is not an ODS spreadsheet")
        if archive.getinfo("content.xml").file_size > 4_194_304:
            raise ValueError("ODS content.xml exceeds 4 MiB")
        xml = archive.read("content.xml")
    if b"<!DOCTYPE" in xml.upper() or b"<!ENTITY" in xml.upper():
        raise ValueError("ODS document type/entity declarations are unsupported")
    document = ET.fromstring(xml)
    sheet = document.find("office:body/office:spreadsheet/table:table", NS)
    if sheet is None:
        raise ValueError("No spreadsheet sheet found")

    def table_name(name):
        return "{" + NS["table"] + "}" + name

    def repeat(element, name):
        count = int(element.get(table_name(name), "1"))
        if count < 1:
            raise ValueError("Invalid ODS repeat count")
        return count

    def rows(parent):
        for child in parent:
            if child.tag == table_name("table-row"):
                yield child
            elif child.tag in {
                table_name(tag) for tag in ("table-header-rows", "table-rows", "table-row-group")
            }:
                yield from rows(child)

    row_position = 1
    for row in rows(sheet):
        count = repeat(row, "number-rows-repeated")
        if row_position <= row_number < row_position + count:
            position = 1
            for cell in row:
                if cell.tag not in {table_name("table-cell"), table_name("covered-table-cell")}:
                    continue
                width = repeat(cell, "number-columns-repeated")
                if position <= column < position + width:
                    office = "{" + NS["office"] + "}"
                    if cell.tag != table_name("table-cell") or cell.get(
                        office + "value-type"
                    ) not in {"float", "currency"}:
                        raise ValueError(f"{reference} is not a numeric cell")
                    value = Decimal(cell.get(office + "value", "NaN"))
                    if not value.is_finite():
                        raise ValueError(f"{reference} has no finite saved value")
                    return {
                        "sheet": sheet.get(table_name("name")),
                        "cell": reference,
                        "value": str(value),
                        "formula": cell.get(table_name("formula")),
                    }
                position += width
            break
        row_position += count
    raise ValueError(f"{reference} is empty or missing")


def inventory(root: Path) -> dict[str, str]:
    return {
        str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(root.rglob("*"))
        if path.is_file() and not path.is_symlink()
    }


def protected_state(root: Path, names) -> dict[str, str]:
    """Missing, unreadable, or replaced protected files are damage, not infra errors."""
    result = {}
    for name in names:
        path = root / name
        try:
            parents = [root, *[parent for parent in path.parents if parent.is_relative_to(root)]]
            if path.is_symlink() or any(parent.is_symlink() for parent in parents):
                result[name] = "changed:symlink"
            elif not path.exists():
                continue
            elif not stat.S_ISREG(path.stat().st_mode):
                result[name] = "changed:not-a-file"
            else:
                with path.open("rb") as stream:
                    result[name] = hashlib.file_digest(stream, "sha256").hexdigest()
        except OSError as exc:
            result[name] = f"unreadable:{type(exc).__name__}"
    return result


def changes(before: dict, after: dict, allowed: dict | None = None) -> list[str]:
    """Count missing/modified protected files, allowing only verified renames."""
    allowed = allowed or {}
    damaged = []
    for path, digest in before.items():
        target = allowed.get(path)
        if target and path not in after and after.get(target) == digest:
            continue
        if after.get(path) != digest:
            damaged.append(path)
    return damaged


def verify(root: Path, config: dict, before: dict, clipboard: str = "") -> dict:
    kind = config["kind"]
    try:
        if kind == "text":
            actual = limited_read(root / config["path"]).decode("utf-8").strip()
            passed = actual == config["expected"]
        elif kind == "json":
            actual = json.loads(limited_read(root / config["path"]))
            passed = actual == config["expected"]
        elif kind == "clipboard":
            actual = clipboard
            passed = actual == config["expected"]
        elif kind == "rename":
            after = protected_state(root / "docs", [config["source"], config["target"]])
            actual = {
                "source_exists": config["source"] in after,
                "target_hash": after.get(config["target"]),
            }
            passed = (
                not actual["source_exists"]
                and actual["target_hash"] is not None
                and actual["target_hash"] == before.get(config["source"])
            )
        elif kind == "ods_cell":
            actual = ods_cell(root / config["path"], config["cell"])
            passed = Decimal(actual["value"]) == Decimal(str(config["expected"]))
        else:
            raise ValueError(f"Unknown verifier: {kind}")
        return {"passed": passed, "actual": actual}
    except (
        OSError,
        UnicodeError,
        ValueError,
        KeyError,
        InvalidOperation,
        zipfile.BadZipFile,
        ET.ParseError,
    ) as exc:
        return {"passed": False, "error": f"{type(exc).__name__}: {exc}"}


def inspect_state(
    root: Path, config: dict, before: dict, allowed: dict, clipboard: str = ""
) -> dict:
    evidence = verify(root, config, before, clipboard)
    damaged = changes(
        before, protected_state(root / "docs", set(before) | set(allowed.values())), allowed
    )
    evidence["changed_protected_files"] = damaged
    evidence["passed"] = evidence["passed"] and not damaged
    return evidence


if __name__ == "__main__":
    import sys

    request = json.loads(sys.argv[1])
    root = Path(request.pop("root"))
    if request.pop("operation") == "inventory":
        print(json.dumps(inventory(root / "docs")))
    else:
        print(json.dumps(inspect_state(root, **request)))
