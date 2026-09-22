"""Rebuild the deterministic, fictional invoice used by T11 (development only)."""

from pathlib import Path

from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas


def build(target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    pdf = canvas.Canvas(str(target), pagesize=A4, invariant=1)
    pdf.setTitle("March research services invoice")
    pdf.setAuthor("Gauntlet benchmark fixtures")
    width, height = A4
    pdf.setFillColor(HexColor("#163f36"))
    pdf.rect(0, height - 160, width, 160, fill=1, stroke=0)
    pdf.setFillColor(HexColor("#d4eadf"))
    pdf.setFont("Helvetica", 11)
    pdf.drawString(48, height - 50, "PINETREE RESEARCH  /  DEMO SUPPLIER")
    pdf.setFillColor(HexColor("#ffffff"))
    pdf.setFont("Helvetica-Bold", 30)
    pdf.drawString(48, height - 96, "Invoice")
    pdf.setFont("Helvetica", 14)
    pdf.drawString(48, height - 127, "Invoice number: INV-2026-03-0142")
    pdf.setFillColor(HexColor("#203b33"))
    pdf.setFont("Helvetica-Bold", 11)
    pdf.drawString(48, height - 206, "BILL TO")
    pdf.drawString(340, height - 206, "ISSUED")
    pdf.setFont("Helvetica", 12)
    pdf.drawString(48, height - 229, "Solari Evaluation Lab")
    pdf.drawString(48, height - 250, "123 Pine Street")
    pdf.drawString(48, height - 271, "San Francisco, CA 94107")
    pdf.drawString(340, height - 229, "March 31, 2026")
    pdf.drawString(340, height - 250, "Currency: USD")
    pdf.setFillColor(HexColor("#edf4ef"))
    pdf.rect(48, height - 335, width - 96, 34, fill=1, stroke=0)
    pdf.setFillColor(HexColor("#203b33"))
    pdf.setFont("Helvetica-Bold", 11)
    pdf.drawString(60, height - 323, "DESCRIPTION")
    pdf.drawRightString(width - 60, height - 323, "AMOUNT (USD)")
    pdf.setFont("Helvetica", 12)
    for offset, description, amount in [
        (365, "Desktop evaluation services", "1,100.00"),
        (399, "Research support", "174.50"),
    ]:
        pdf.drawString(60, height - offset, description)
        pdf.drawRightString(width - 60, height - offset, amount)
    pdf.setStrokeColor(HexColor("#b9cfc2"))
    pdf.line(48, height - 423, width - 48, height - 423)
    pdf.setFont("Helvetica-Bold", 16)
    pdf.drawString(60, height - 456, "Total due")
    pdf.drawRightString(width - 60, height - 456, "$1,274.50")
    pdf.setFont("Helvetica", 10)
    pdf.setFillColor(HexColor("#536c60"))
    pdf.drawString(48, 84, "Fictional invoice for the Gauntlet computer-use benchmark.")
    pdf.drawString(48, 67, "No payment is required.")
    pdf.drawRightString(width - 48, 42, "1 / 1")
    pdf.save()


if __name__ == "__main__":
    build(Path(__file__).resolve().parents[1] / "gauntlet/fixtures/assets/invoice.pdf")
