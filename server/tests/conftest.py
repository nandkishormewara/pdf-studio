from __future__ import annotations

import io
import os
import sys
from pathlib import Path

import pikepdf
import pytest
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault("PDFSTUDIO_DATA_DIR", str(Path(__file__).resolve().parent / ".data"))

FONT_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    "/System/Library/Fonts/Kohinoor.ttc",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
]


def _font(size: int):
    for path in FONT_CANDIDATES:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default(size)


def text_pdf(lines: list[tuple[float, float, str]], rotate: int = 0) -> bytes:
    """A born-digital PDF with real Helvetica text at the given positions (PDF user space)."""
    pdf = pikepdf.new()
    font = pdf.make_indirect(pikepdf.Dictionary(Type=pikepdf.Name.Font, Subtype=pikepdf.Name.Type1, BaseFont=pikepdf.Name.Helvetica))
    ops = "".join(f"BT /F1 14 Tf {x} {y} Td ({t}) Tj ET\n" for x, y, t in lines)
    page = pikepdf.Dictionary(
        Type=pikepdf.Name.Page, MediaBox=[0, 0, 612, 792],
        Resources=pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=font)),
        Contents=pdf.make_stream(ops.encode()),
    )
    if rotate:
        page.Rotate = rotate
    pdf.pages.append(pikepdf.Page(page))
    pdf.docinfo["/Author"] = "Someone Private"
    pdf.docinfo["/Title"] = "Confidential report"
    out = io.BytesIO()
    pdf.save(out)
    return out.getvalue()


def tables_pdf() -> bytes:
    """One A4 page with three tables and some two-column text (the test kit's tables.pdf).

    1. Fee table drawn with stroked lines: "Class" spans two rows, "Fees (INR)" spans two columns.
    2. Small table whose borders are thin filled boxes, as office suites draw them.
    3. Borderless marks table: columns only by alignment.
    Below them, two columns of running text, which is not a table.
    """
    H = 842.0
    ops: list[str] = []

    def text(x: float, top: float, s: str, size: float = 10) -> None:
        ops.append(f"BT /F1 {size} Tf {x} {H - top - size} Td ({s}) Tj ET")

    def line(x1: float, y1: float, x2: float, y2: float) -> None:
        ops.append(f"{x1} {H - y1} m {x2} {H - y2} l S")

    def thin(x: float, y: float, w: float, h: float) -> None:
        ops.append(f"{x} {H - y - h} {w} {h} re f")

    text(60, 60, "Fee structure 2026 (test kit)", 16)
    # 1. ruled table, 5 rows x 3 columns
    ops.append("0.8 w")
    for y in (120, 170, 195, 220, 245):
        line(60, y, 460, y)
    line(200, 145, 460, 145)  # missing from 60 to 200: "Class" spans rows 1-2
    for x in (60, 200, 460):
        line(x, 120, x, 245)
    line(330, 145, 330, 245)  # missing in the top row: "Fees (INR)" spans columns 2-3
    text(66, 138, "Class")
    text(206, 126, "Fees (INR)")
    for x, s in ((206, "Term 1"), (336, "Term 2")):
        text(x, 151, s)
    for i, (grade, a, b) in enumerate((("Grade 6", "12,000", "11,500"), ("Grade 7", "12,500", "12,000"), ("Grade 8", "13,000", "12,500"))):
        top = 176 + 25 * i
        text(66, top, grade)
        text(206, top, a)
        text(336, top, b)
    # 2. borders as thin filled boxes, 3 rows x 2 columns
    for y in (290, 312, 334, 356):
        thin(60, y - 0.4, 240, 0.8)
    for x in (60, 180, 300):
        thin(x - 0.4, 290, 0.8, 66)
    for i, (item, qty) in enumerate((("Item", "Qty"), ("Pens", "4"), ("Notebooks", "6"))):
        text(66, 296 + 22 * i, item)
        text(186, 296 + 22 * i, qty)
    # 3. borderless table, 5 rows x 4 columns
    for i, row in enumerate((("Student", "Roll no.", "Maths", "Science"), ("User One", "101", "88", "91"), ("User Two", "102", "76", "84"),
                             ("User Three", "103", "93", "89"), ("User Four", "104", "67", "72"))):
        for x, s in zip((60, 220, 330, 430), row):
            text(x, 410 + 18 * i, s)
    # running text in two columns: not a table
    left = ["Results are shared with parents at the", "end of each term. Marks are out of 100", "and include class work and homework.",
            "Ask the class teacher for a copy of the", "answer sheets if a mark looks wrong."]
    right = ["Fees are due on the first working day", "of the term. A late fee applies after", "fifteen days. Scholarships are decided",
             "by the school committee each year and", "are listed on the notice board."]
    for i, (a, b) in enumerate(zip(left, right)):
        text(60, 560 + 14 * i, a)
        text(310, 560 + 14 * i, b)

    pdf = pikepdf.new()
    font = pdf.make_indirect(pikepdf.Dictionary(Type=pikepdf.Name.Font, Subtype=pikepdf.Name.Type1, BaseFont=pikepdf.Name.Helvetica,
                                                Encoding=pikepdf.Name.WinAnsiEncoding))
    page = pikepdf.Dictionary(Type=pikepdf.Name.Page, MediaBox=[0, 0, 595, 842], Resources=pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=font)),
                              Contents=pdf.make_stream("\n".join(ops).encode()))
    pdf.pages.append(pikepdf.Page(page))
    out = io.BytesIO()
    pdf.save(out)
    return out.getvalue()


def columns_pdf() -> bytes:
    """One A4 page laid out like a newsletter, drawn in an unhelpful order (the test kit's columns.pdf).

    A title; two columns drawn line by line across both columns (left line, right line, as one text object
    each), so the drawing order mixes them; a full-width note; three columns, the right one drawn first; a
    borderless marks table; a footer drawn before everything else. Each line starts with its place in
    reading order (01, 02, ...) so a test can check the order at a glance.
    """
    H = 842.0
    ops: list[str] = []
    n = iter(range(1, 100))

    def label(s: str) -> str:
        return f"{next(n):02d} {s}"

    def text(x: float, top: float, s: str, size: float = 10) -> str:
        return f"BT /F1 {size} Tf {x} {H - top - size} Td ({s}) Tj ET"

    title = text(60, 50, label("School newsletter, term 2 (test kit)"), 16)
    left = [label(s) for s in ("Admissions open in May for", "classes six to ten. Forms are", "at the front office.")]
    right = [label(s) for s in ("Sports day is on the second", "Saturday of June. Parents", "are welcome to attend.")]
    note = label("Note: the library is closed for stock-taking during the last week of the term.")
    cols3 = [[label(s) for s in col] for col in (("Maths club", "meets Monday."), ("Science fair", "is in July."), ("Art show", "opens in August."))]
    table_head = label("Marks this term")
    table = [("Student", "Maths", "Science", "English"), ("User1", "88", "91", "79"), ("User2", "76", "84", "90"), ("User3", "93", "89", "85")]
    footer = text(60, 800, label("Page 1 of 1"), 9)

    ops.append(footer)  # drawn first, read last
    ops.append(title)
    for i, (a, b) in enumerate(zip(left, right)):  # one text object per row, crossing the gutter
        top = H - 100 - 16 * i - 10
        ops.append(f"BT /F1 10 Tf 60 {top} Td ({a}) Tj 250 0 Td ({b}) Tj ET")
    ops.append(text(60, 170, note))
    for x, col in reversed(list(zip((60, 230, 400), cols3))):  # right column first
        for i, s in enumerate(col):
            ops.append(text(x, 210 + 16 * i, s))
    ops.append(text(60, 270, table_head, 12))
    for i, row in enumerate(table):
        for x, s in zip((60, 200, 300, 400), row):
            ops.append(text(x, 295 + 18 * i, s))

    pdf = pikepdf.new()
    font = pdf.make_indirect(pikepdf.Dictionary(Type=pikepdf.Name.Font, Subtype=pikepdf.Name.Type1, BaseFont=pikepdf.Name.Helvetica,
                                                Encoding=pikepdf.Name.WinAnsiEncoding))
    page = pikepdf.Dictionary(Type=pikepdf.Name.Page, MediaBox=[0, 0, 595, 842], Resources=pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=font)),
                              Contents=pdf.make_stream("\n".join(ops).encode()))
    pdf.pages.append(pikepdf.Page(page))
    out = io.BytesIO()
    pdf.save(out)
    return out.getvalue()


def scanned_pdf(text: str, rotate: int = 0) -> bytes:
    """An image-only PDF (like a scan) containing `text` as pixels."""
    dpi = 200
    w, h = int(8.5 * dpi), int(11 * dpi)
    img = Image.new("RGB", (w, h), "white")
    ImageDraw.Draw(img).multiline_text((150, 200), text, fill="black", font=_font(64), spacing=30)
    jpeg = io.BytesIO()
    img.save(jpeg, format="JPEG", quality=92)
    pdf = pikepdf.new()
    image = pikepdf.Stream(pdf, jpeg.getvalue())
    image.Type, image.Subtype = pikepdf.Name.XObject, pikepdf.Name.Image
    image.Width, image.Height, image.ColorSpace, image.BitsPerComponent = w, h, pikepdf.Name.DeviceRGB, 8
    image.Filter = pikepdf.Name.DCTDecode
    page = pikepdf.Dictionary(
        Type=pikepdf.Name.Page, MediaBox=[0, 0, 612, 792],
        Resources=pikepdf.Dictionary(XObject=pikepdf.Dictionary(Im0=image)),
        Contents=pdf.make_stream(b"q 612 0 0 792 0 0 cm /Im0 Do Q"),
    )
    if rotate:
        page.Rotate = rotate
    pdf.pages.append(pikepdf.Page(page))
    out = io.BytesIO()
    pdf.save(out)
    return out.getvalue()


def extract_text(data: bytes) -> str:
    import pypdfium2 as pdfium

    doc = pdfium.PdfDocument(data)
    try:
        parts = []
        for page in doc:
            tp = page.get_textpage()
            parts.append(tp.get_text_range())
            tp.close()
        return "\n".join(parts)
    finally:
        doc.close()


@pytest.fixture
def client():
    from fastapi.testclient import TestClient

    from app.main import app

    return TestClient(app)
