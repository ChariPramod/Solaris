import zipfile

import pytest


@pytest.fixture
def write_ods():
    """Small ODF package builder for adversarial verifier inputs."""

    def write(
        path, rows=None, value="1400", mimetype="application/vnd.oasis.opendocument.spreadsheet"
    ):
        if rows is None:
            rows = (
                '<table:table-row table:number-rows-repeated="11"/>'
                "<table:table-row><table:table-cell/>"
                f'<table:table-cell office:value-type="float" office:value="{value}" '
                'table:formula="of:=SUM([.B2:.B11])"/></table:table-row>'
            )
        xml = (
            '<?xml version="1.0" encoding="UTF-8"?>'
            "<office:document-content "
            'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" '
            'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" '
            'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">'
            '<office:body><office:spreadsheet><table:table table:name="sales">'
            + rows
            + "</table:table></office:spreadsheet></office:body></office:document-content>"
        )
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr("mimetype", mimetype)
            archive.writestr("content.xml", xml)
        return path

    return write
