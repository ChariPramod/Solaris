import csv
import io
import zipfile

import pytest

from gauntlet.fixtures.data import FILES, seed
from gauntlet.models import load_tasks
from gauntlet.verifiers.state import inspect_state, inventory, ods_cell


def test_sales_fixture_has_ten_numeric_rows_and_independent_total():
    rows = list(csv.reader(io.StringIO(FILES["sales.csv"])))
    assert rows[0] == ["Day", "Sales"]
    assert len(rows) == 11
    assert sum(int(row[1]) for row in rows[1:]) == int(load_tasks("T08")[0].verifier["expected"])


def test_saved_formula_value_is_read(write_ods, tmp_path):
    actual = ods_cell(write_ods(tmp_path / "test.ods"), "B12")
    assert actual == {
        "sheet": "sales",
        "cell": "B12",
        "value": "1400",
        "formula": "of:=SUM([.B2:.B11])",
    }


@pytest.mark.parametrize("value", ["1399", "NaN", "Infinity", "not-a-number"])
def test_wrong_or_invalid_value_is_a_failed_check(value, write_ods, tmp_path):
    seed(tmp_path)
    task = load_tasks("T08")[0]
    write_ods(tmp_path / task.verifier["path"], value=value)
    evidence = inspect_state(tmp_path, task.verifier, inventory(tmp_path / "docs"), {})
    assert not evidence["passed"]


def test_repeat_counts_do_not_expand_in_memory(write_ods, tmp_path):
    rows = (
        '<table:table-row-group><table:table-row table:number-rows-repeated="999999999">'
        '<table:table-cell table:number-columns-repeated="999999999" '
        'office:value-type="float" office:value="1400"/></table:table-row></table:table-row-group>'
    )
    assert ods_cell(write_ods(tmp_path / "repeat.ods", rows=rows), "B12")["value"] == "1400"


@pytest.mark.parametrize(
    "cell",
    [
        '<table:table-cell office:value-type="string"><text:p>1400</text:p></table:table-cell>',
        '<table:table-cell table:formula="of:=SUM([.B2:.B11])"/>',
        '<table:covered-table-cell office:value-type="float" office:value="1400"/>',
    ],
)
def test_displayed_text_or_uncalculated_formula_is_not_numeric(cell, write_ods, tmp_path):
    rows = (
        '<table:table-row table:number-rows-repeated="11"/>'
        "<table:table-row><table:table-cell/>" + cell + "</table:table-row>"
    )
    with pytest.raises(ValueError):
        ods_cell(write_ods(tmp_path / "text.ods", rows=rows), "B12")


def test_repeated_blank_columns_count_towards_position(write_ods, tmp_path):
    rows = (
        '<table:table-header-rows><table:table-row table:number-rows-repeated="11"/>'
        "</table:table-header-rows><table:table-row>"
        '<table:table-cell table:number-columns-repeated="2"/>'
        '<table:table-cell office:value-type="float" office:value="1400"/></table:table-row>'
    )
    path = write_ods(tmp_path / "columns.ods", rows=rows)
    with pytest.raises(ValueError):
        ods_cell(path, "B12")
    assert ods_cell(path, "C12")["value"] == "1400"


@pytest.mark.parametrize("content", [b"not xml", b'<!DOCTYPE foo [<!ENTITY x "1400">]><foo/>'])
def test_malformed_ods_is_task_failure_not_infrastructure_error(content, tmp_path):
    seed(tmp_path)
    task = load_tasks("T08")[0]
    with zipfile.ZipFile(tmp_path / task.verifier["path"], "w") as archive:
        archive.writestr("mimetype", "application/vnd.oasis.opendocument.spreadsheet")
        archive.writestr("content.xml", content)
    evidence = inspect_state(tmp_path, task.verifier, inventory(tmp_path / "docs"), {})
    assert not evidence["passed"]
    assert "error" in evidence


def test_wrong_document_type_is_rejected(write_ods, tmp_path):
    with pytest.raises(ValueError, match="not an ODS"):
        ods_cell(write_ods(tmp_path / "text.ods", mimetype="application/zip"), "B12")
