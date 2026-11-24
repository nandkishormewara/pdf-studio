from __future__ import annotations

import base64
import io
import json
import zipfile
from pathlib import Path

import pikepdf
import pytest

from app.config import settings
from conftest import columns_pdf, extract_text, scanned_pdf, tables_pdf, text_pdf

needs_tesseract = pytest.mark.skipif(not settings.tesseract, reason="tesseract not installed")
needs_soffice = pytest.mark.skipif(not settings.soffice, reason="LibreOffice not installed")


def report(resp) -> dict:
    return json.loads(base64.b64decode(resp.headers["X-PDFStudio-Report"]))


def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] and body["features"]["redact"] and body["features"]["sign"]


def test_rejects_non_pdf(client):
    r = client.post("/ocr", files={"file": ("x.pdf", b"hello", "application/pdf")})
    assert r.status_code == 415
    assert r.json() == {"error": "Not a PDF file."}


def test_missing_file_and_bad_values_use_the_same_error_shape(client):
    r = client.post("/ocr")
    assert r.status_code == 422 and "file" in r.json()["error"]
    r = client.post("/optimize", files={"file": ("a.pdf", text_pdf([(72, 700, "x")]), "application/pdf")}, data={"max_image_dpi": "5"})
    assert r.status_code == 422 and "max_image_dpi" in r.json()["error"]


# ------------------------------------------------------------------ redaction

def _with_annotation(data: bytes, rect: list[float], contents: str) -> bytes:
    pdf = pikepdf.open(io.BytesIO(data))
    annot = pdf.make_indirect(pikepdf.Dictionary(
        Type=pikepdf.Name.Annot, Subtype=pikepdf.Name.FreeText, Rect=rect, Contents=pikepdf.String(contents),
        DA=pikepdf.String("/Helv 12 Tf 0 g"),
    ))
    pdf.pages[0].obj.Annots = pikepdf.Array([annot])
    out = io.BytesIO()
    pdf.save(out)
    return out.getvalue()


def test_redaction_removes_text_annotations_and_metadata(client):
    src = text_pdf([(72, 700, "Account number 4242 4242"), (72, 600, "Public paragraph stays")])
    src = _with_annotation(src, [70, 690, 300, 720], "note about 4242 4242")
    assert "4242" in extract_text(src)

    regions = [{"page": 0, "rects": [[180, 695, 290, 715]]}]  # covers "4242 4242"
    r = client.post("/redact", files={"file": ("a.pdf", src, "application/pdf")},
                    data={"regions": json.dumps(regions), "sanitize": "true"})
    assert r.status_code == 200, r.text
    out = r.content
    rep = report(r)
    assert rep["pages"] == [0] and rep["annotationsRemoved"] == 1
    assert "document info" in rep["sanitized"]

    # The secret is not anywhere in the file: not as text, not in an annotation, not in metadata.
    assert "4242" not in extract_text(out)
    with pikepdf.open(io.BytesIO(out)) as pdf:
        assert "/Annots" not in pdf.pages[0].obj or len(pdf.pages[0].obj.Annots) == 0
        assert len(pdf.docinfo) == 0
        raw = b"".join(obj.read_bytes() for obj in pdf.objects if isinstance(obj, pikepdf.Stream) and obj.get("/Subtype") != pikepdf.Name.Image)
        assert b"4242" not in raw


@needs_tesseract
def test_redaction_with_ocr_keeps_other_text_searchable(client):
    src = text_pdf([(72, 700, "Account number 4242 4242"), (72, 600, "Public paragraph stays")])
    regions = [{"page": 0, "rects": [[180, 695, 290, 715]]}]
    r = client.post("/redact", files={"file": ("a.pdf", src, "application/pdf")},
                    data={"regions": json.dumps(regions), "ocr_languages": "eng"})
    assert r.status_code == 200, r.text
    text = extract_text(r.content)
    assert "4242" not in text
    assert "Public" in text and "paragraph" in text


def test_redaction_keeps_page_geometry_on_rotated_page(client):
    src = text_pdf([(72, 700, "Rotated secret")], rotate=90)
    r = client.post("/redact", files={"file": ("a.pdf", src, "application/pdf")},
                    data={"regions": json.dumps([{"page": 0, "rects": [[60, 690, 250, 720]]}])})
    assert r.status_code == 200
    with pikepdf.open(io.BytesIO(r.content)) as pdf:
        assert int(pdf.pages[0].obj.Rotate) == 90
        assert [float(v) for v in pdf.pages[0].mediabox] == [0, 0, 612, 792]
    assert "secret" not in extract_text(r.content)


# ------------------------------------------------------------------ OCR

@needs_tesseract
def test_ocr_makes_scan_searchable(client):
    src = scanned_pdf("Admission form\nStudent name Jane Doe")
    assert extract_text(src).strip() == ""
    r = client.post("/ocr", files={"file": ("s.pdf", src, "application/pdf")}, data={"languages": "eng"})
    assert r.status_code == 200, r.text
    assert report(r)["ocrPages"] == [0]
    text = extract_text(r.content)
    assert "Admission" in text and "Jane" in text


@needs_tesseract
def test_ocr_skips_pages_that_already_have_text(client):
    src = text_pdf([(72, 700, "This page already has plenty of real text in it.")])
    r = client.post("/ocr", files={"file": ("t.pdf", src, "application/pdf")}, data={"languages": "eng"})
    assert r.status_code == 200
    assert report(r) == {"ocrPages": [], "skippedPages": [0]}


@needs_tesseract
def test_ocr_unknown_language(client):
    r = client.post("/ocr", files={"file": ("s.pdf", scanned_pdf("x"), "application/pdf")}, data={"languages": "xx_none"})
    assert r.status_code == 400
    assert "not installed" in r.json()["error"]


# ------------------------------------------------------------------ signatures

def test_sign_and_verify(client):
    src = text_pdf([(72, 700, "Contract")])
    r = client.post("/sign", files={"file": ("c.pdf", src, "application/pdf")},
                    data={"reason": "Approved", "location": "Head office", "box": json.dumps([400, 60, 580, 130])})
    assert r.status_code == 200, r.text
    signed = r.content
    v = client.post("/verify", files={"file": ("c.pdf", signed, "application/pdf")}).json()["signatures"]
    assert len(v) == 1
    assert v[0]["intact"] and v[0]["valid"] and v[0]["trusted"]
    assert v[0]["reason"] == "Approved" and v[0]["coverage"] == "ENTIRE_FILE"


def test_second_signature_keeps_first_valid(client):
    src = text_pdf([(72, 700, "Two signers")])
    once = client.post("/sign", files={"file": ("c.pdf", src, "application/pdf")}, data={"reason": "Teacher"}).content
    twice = client.post("/sign", files={"file": ("c.pdf", once, "application/pdf")},
                        data={"reason": "Principal", "box": json.dumps([400, 60, 580, 130])}).content
    v = client.post("/verify", files={"file": ("c.pdf", twice, "application/pdf")}).json()["signatures"]
    assert [s["field"] for s in v] == ["Signature1", "Signature2"]
    assert all(s["intact"] and s["valid"] for s in v)


def test_tampering_is_detected(client):
    src = text_pdf([(72, 700, "Pay 100 rupees")])
    signed = bytearray(client.post("/sign", files={"file": ("c.pdf", src, "application/pdf")}).content)
    i = signed.find(b"100")
    signed[i:i + 3] = b"900"
    v = client.post("/verify", files={"file": ("c.pdf", bytes(signed), "application/pdf")}).json()["signatures"]
    assert len(v) == 1 and not v[0]["intact"]


def test_sign_with_handwritten_image(client):
    from PIL import Image, ImageDraw

    img = Image.new("RGBA", (300, 100), (0, 0, 0, 0))
    ImageDraw.Draw(img).line([(10, 80), (100, 20), (200, 80), (290, 20)], fill=(20, 40, 120, 255), width=6)
    png = io.BytesIO()
    img.save(png, format="PNG")
    r = client.post("/sign", files={"file": ("c.pdf", text_pdf([(72, 700, "x")]), "application/pdf"),
                                    "image": ("sig.png", png.getvalue(), "image/png")},
                    data={"box": json.dumps([350, 50, 580, 140])})
    assert r.status_code == 200, r.text


# ------------------------------------------------------------------ conversion

@needs_soffice
def test_convert_html_to_pdf(client):
    html = b"<html><body><h1>Fee structure</h1><p>Class 11 - Science</p></body></html>"
    r = client.post("/convert", files={"file": ("fees.html", html, "text/html")})
    assert r.status_code == 200, r.text
    assert r.content.startswith(b"%PDF")
    assert "Fee structure" in extract_text(r.content)


def test_convert_rejects_unknown_type(client):
    if not settings.soffice:
        pytest.skip("LibreOffice not installed")
    r = client.post("/convert", files={"file": ("x.exe", b"MZ....", "application/octet-stream")})
    assert r.status_code == 415


@needs_tesseract
def test_ocr_text_lands_in_the_right_place_on_rotated_scan(client):
    import pypdfium2 as pdfium

    src = scanned_pdf("Roll number 2041", rotate=90)
    r = client.post("/ocr", files={"file": ("s.pdf", src, "application/pdf")}, data={"languages": "eng"})
    assert r.status_code == 200
    doc = pdfium.PdfDocument(r.content)
    tp = doc[0].get_textpage()
    text = tp.get_text_range()
    assert "2041" in text
    # The text was drawn near the top-left of the unrotated image (x≈54pt, y≈720pt in user space).
    i = text.index("Roll")
    left, bottom, right, top = tp.get_charbox(i)
    assert 30 < left < 120 and 650 < top < 760
    tp.close()
    doc.close()


def _has_raqm() -> bool:
    from PIL import features
    return bool(features.check("raqm"))


@needs_tesseract
@pytest.mark.skipif(not _has_raqm(), reason="Pillow without libraqm can't draw Devanagari test images")
def test_ocr_hindi(client):
    src = scanned_pdf("प्रवेश पत्र")  # "admission letter"
    r = client.post("/ocr", files={"file": ("s.pdf", src, "application/pdf")}, data={"languages": "hin"})
    assert r.status_code == 200
    assert "प्रवेश" in extract_text(r.content)


@needs_tesseract
def test_redacted_rotated_page_keeps_layout(client):
    import pypdfium2 as pdfium

    src = text_pdf([(72, 700, "Hidden value 9911"), (72, 500, "Visible heading here")], rotate=90)
    r = client.post("/redact", files={"file": ("a.pdf", src, "application/pdf")},
                    data={"regions": json.dumps([{"page": 0, "rects": [[60, 690, 260, 720]]}]), "ocr_languages": "eng"})
    assert r.status_code == 200
    doc = pdfium.PdfDocument(r.content)
    tp = doc[0].get_textpage()
    text = tp.get_text_range()
    assert "9911" not in text and "Visible" in text
    left, bottom, right, top = tp.get_charbox(text.index("Visible"))
    assert abs(left - 72) < 12 and abs(bottom - 500) < 12  # same place as in the original
    tp.close()
    doc.close()


def test_text_targets_redact_whole_word_even_if_mark_is_short(client):
    src = text_pdf([(72, 700, "Name: John Doe, class 12")])
    # A deliberately too-short mark that only covers "Rames" — the exact text target fixes it.
    regions = [{"page": 0, "rects": [[115, 698, 150, 712]], "texts": [{"text": "John Doe", "near": [115, 698, 150, 712]}]}]
    r = client.post("/redact", files={"file": ("a.pdf", src, "application/pdf")},
                    data={"regions": json.dumps(regions), "ocr_languages": "eng" if settings.tesseract else ""})
    assert r.status_code == 200, r.text
    text = extract_text(r.content)
    assert "John" not in text and "Doe" not in text and "n D" not in text
    if settings.tesseract:
        assert "class" in text  # the rest of the line survives


# ------------------------------------------------------------------ optimise

def test_optimize_linearizes_and_keeps_text(client):
    src = text_pdf([(72, 700, "Fast web view"), (72, 650, "Second line")])
    r = client.post("/optimize", files={"file": ("a.pdf", src, "application/pdf")})
    assert r.status_code == 200, r.text
    with pikepdf.open(io.BytesIO(r.content)) as pdf:
        assert pdf.is_linearized
    assert "Fast web view" in extract_text(r.content)
    rep = report(r)
    assert rep["linearized"] and rep["bytesBefore"] == len(src) and rep["bytesAfter"] == len(r.content)
    assert 'filename="a-optimized.pdf"' in r.headers["Content-Disposition"]


def test_optimize_downsamples_scans(client):
    src = scanned_pdf("Scanned page")  # 200 dpi
    r = client.post("/optimize", files={"file": ("s.pdf", src, "application/pdf")}, data={"max_image_dpi": "100"})
    assert r.status_code == 200, r.text
    assert report(r)["imagesDownsampled"] == 1
    assert len(r.content) < len(src) * 0.6
    with pikepdf.open(io.BytesIO(r.content)) as pdf:
        img = pdf.pages[0].Resources.XObject.Im0
        assert (int(img.Width), int(img.Height)) == (850, 1100)


def test_optimize_refuses_signed(client):
    signed = client.post("/sign", files={"file": ("c.pdf", text_pdf([(72, 700, "Contract")]), "application/pdf")}).content
    r = client.post("/optimize", files={"file": ("c.pdf", signed, "application/pdf")})
    assert r.status_code == 409 and "signature" in r.json()["error"]


# ------------------------------------------------------------------ extraction

def test_extract_text_with_positions(client):
    src = text_pdf([(72, 700, "Invoice 4417"), (72, 650, "Total due")])
    r = client.post("/extract", files={"file": ("a.pdf", src, "application/pdf")})
    assert r.status_code == 200, r.text
    page = r.json()["pages"][0]
    assert (page["page"], page["width"], page["height"]) == (1, 612, 792)
    first = page["lines"][0]
    assert first["text"] == "Invoice 4417" and first["font"] == "Helvetica" and first["size"] == 14
    # top-left origin: baseline 700 from the bottom is ~92 from the top
    assert 70 <= first["box"]["x"] <= 74 and 75 <= first["box"]["y"] <= 95
    assert [w["text"] for w in first["words"]] == ["Invoice", "4417"]
    assert first["words"][1]["box"]["x"] > first["words"][0]["box"]["x"] + first["words"][0]["box"]["w"]


def test_extract_positions_on_rotated_page(client):
    src = text_pdf([(72, 700, "Sideways")], rotate=90)
    page = client.post("/extract", files={"file": ("r.pdf", src, "application/pdf")}).json()["pages"][0]
    assert (page["width"], page["height"]) == (792, 612)
    box = page["lines"][0]["box"]
    # on a page turned 90° clockwise, user-space y becomes x and x becomes y
    assert box["h"] > box["w"] and 680 <= box["x"] <= 720 and 70 <= box["y"] <= 75


def test_extract_images_and_fonts_zip(client):
    src = scanned_pdf("Scan")  # one 1700x2200 JPEG
    r = client.post("/extract", files={"file": ("s.pdf", src, "application/pdf")},
                    data={"images": "true", "fonts": "true", "font_files": "true", "format": "zip"})
    assert r.status_code == 200 and r.headers["content-type"] == "application/zip"
    z = zipfile.ZipFile(io.BytesIO(r.content))
    names = z.namelist()
    assert "s-extracted/images/page-001-image-01.png" in names and "s-extracted/s-extract.json" in names
    meta = json.loads(z.read("s-extracted/s-extract.json"))
    img = meta["images"][0]
    assert (img["widthPx"], img["heightPx"]) == (1700, 2200)
    assert img["box"] == {"x": 0, "y": 0, "w": 612, "h": 792}
    assert meta["pages"][0]["lines"] == []  # a scan has no text until OCR
    assert meta["fonts"] == []


def test_extract_fonts_list(client):
    src = text_pdf([(72, 700, "Fonts")])
    fonts = client.post("/extract", files={"file": ("f.pdf", src, "application/pdf")}, data={"text": "false", "fonts": "true"}).json()["fonts"]
    assert fonts == [{"name": "Helvetica", "baseFont": "Helvetica", "type": "Type1", "embedded": False, "subset": False, "program": None, "pages": [1]}]


def test_extract_plain_text_and_errors(client):
    src = text_pdf([(72, 700, "Hello")])
    r = client.post("/extract", files={"file": ("h.pdf", src, "application/pdf")}, data={"format": "txt"})
    assert r.status_code == 200 and r.text == "===== Page 1 =====\nHello\n"
    assert 'filename="h-text.txt"' in r.headers["content-disposition"]
    r = client.post("/extract", files={"file": ("h.pdf", src, "application/pdf")}, data={"pages": "[3]"})
    assert r.status_code == 400 and "Page 4 does not exist" in r.json()["error"]
    r = client.post("/extract", files={"file": ("h.pdf", src, "application/pdf")}, data={"text": "false"})
    assert r.status_code == 400 and "Nothing to extract" in r.json()["error"]
    r = client.post("/extract", files={"file": ("h.pdf", src, "application/pdf")}, data={"format": "docx"})
    assert r.status_code == 422 and "format" in r.json()["error"]


FIXTURE = json.loads((Path(__file__).resolve().parents[2] / "mobile" / "shared" / "tables" / "tables-page.json").read_text(encoding="utf-8"))


def test_table_detection_matches_the_shared_cases():
    # same input and expected tables as the web SDK's test (packages/react-viewer/test/tables.test.ts)
    from app.tables import detect_tables
    found = detect_tables(FIXTURE["page"], FIXTURE["words"], [tuple(s) for s in FIXTURE["segments"]])
    assert [{"method": t["method"], "rows": t["rows"], "cols": t["cols"],
             "cells": [{k: c[k] for k in ("row", "col", "rowSpan", "colSpan", "text")} for c in t["cells"]]} for t in found] == FIXTURE["expected"]


def test_extract_tables(client):
    src = tables_pdf()
    r = client.post("/extract", files={"file": ("fees.pdf", src, "application/pdf")}, data={"tables": "true", "text": "false"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert "pages" not in body
    assert [(t["name"], t["method"], t["rows"], t["cols"], t["page"]) for t in body["tables"]] == [
        ("page-001-table-01", "lattice", 5, 3, 1), ("page-001-table-02", "lattice", 3, 2, 1), ("page-001-table-03", "stream", 5, 4, 1)]
    assert body["tables"][0]["grid"][:2] == [["Class", "Fees (INR)", ""], ["", "Term 1", "Term 2"]]
    assert body["tables"][0]["box"] == {"x": 60.0, "y": 120.0, "w": 400.0, "h": 125.0}

    r = client.post("/extract", files={"file": ("fees.pdf", src, "application/pdf")}, data={"format": "xlsx"})
    assert r.status_code == 200 and 'filename="fees-tables.xlsx"' in r.headers["content-disposition"]
    with zipfile.ZipFile(io.BytesIO(r.content)) as z:
        assert '<sheet name="Page 1 table 3"' in z.read("xl/workbook.xml").decode()
        sheet = z.read("xl/worksheets/sheet1.xml").decode()
        assert '<mergeCell ref="A1:A2"/><mergeCell ref="B1:C1"/>' in sheet and ">Fees (INR)<" in sheet

    r = client.post("/extract", files={"file": ("fees.pdf", src, "application/pdf")}, data={"tables": "true", "format": "zip"})
    with zipfile.ZipFile(io.BytesIO(r.content)) as z:
        names = z.namelist()
        assert "fees-extracted/fees-tables.xlsx" in names and "fees-extracted/fees-text.txt" in names
        assert z.read("fees-extracted/tables/page-001-table-03.csv").decode("utf-8-sig").splitlines()[1] == "User One,101,88,91"

    r = client.post("/extract", files={"file": ("h.pdf", text_pdf([(72, 700, "Hello")]), "application/pdf")}, data={"format": "xlsx"})
    assert r.status_code == 422 and "No tables" in r.json()["error"]


ORDER_CASES = json.loads((Path(__file__).resolve().parents[2] / "mobile" / "shared" / "reading-order" / "cases.json").read_text(encoding="utf-8"))["cases"]


@pytest.mark.parametrize("case", ORDER_CASES, ids=lambda c: c["name"])
def test_reading_order_matches_the_shared_cases(case):
    # same cases as the web SDK, Android and iOS tests
    from app.reading_order import reading_order
    assert [line["text"] for line in reading_order(case["lines"], case["tables"])] == case["expected"]


def test_extract_text_in_reading_order(client):
    src = columns_pdf()
    r = client.post("/extract", files={"file": ("news.pdf", src, "application/pdf")}, data={"format": "txt"})
    lines = r.text.splitlines()[1:]
    assert [line[:2] for line in lines if line[:2].isdigit()] == [f"{i:02d}" for i in range(1, 17)]
    assert "User1\t88\t91\t79" in lines
    r = client.post("/extract", files={"file": ("news.pdf", src, "application/pdf")}, data={"order": "drawn"})
    drawn = [line["text"] for line in r.json()["pages"][0]["lines"]]
    assert drawn[0] == "16 Page 1 of 1" and drawn[2].startswith("02 Admissions") and "05 Sports" in drawn[2]
    r = client.post("/extract", files={"file": ("news.pdf", src, "application/pdf")}, data={"order": "columns"})
    assert r.status_code == 422 and "order" in r.json()["error"]


def test_extract_password_protected(client):
    pdf = pikepdf.open(io.BytesIO(text_pdf([(72, 700, "Secret")])))
    out = io.BytesIO()
    pdf.save(out, encryption=pikepdf.Encryption(user="u", owner="o"))
    r = client.post("/extract", files={"file": ("p.pdf", out.getvalue(), "application/pdf")})
    assert r.status_code == 422 and "password" in r.json()["error"]


def test_redaction_cleans_hidden_information_by_default(client):
    # "sanitize" not sent: the documented default (true) must apply
    src = text_pdf([(72, 700, "Name here")])
    r = client.post("/redact", files={"file": ("a.pdf", src, "application/pdf")}, data={"regions": json.dumps([{"page": 0, "rects": [[60, 690, 300, 715]]}])})
    assert r.status_code == 200, r.text
    assert "document info" in report(r)["sanitized"]
    with pikepdf.open(io.BytesIO(r.content)) as pdf:
        assert "/Author" not in pdf.docinfo and "/Title" not in pdf.docinfo
    r = client.post("/redact", files={"file": ("a.pdf", src, "application/pdf")},
                    data={"regions": json.dumps([{"page": 0, "rects": [[60, 690, 300, 715]]}]), "sanitize": "false"})
    assert report(r)["sanitized"] == []
