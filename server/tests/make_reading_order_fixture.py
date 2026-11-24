"""Writes mobile/shared/reading-order/cases.json (and columns.pdf beside it): lines in the order the file draws them (as PDFium reads
them), the tables found on the page, and the reading order every implementation must produce
(web/src/sdk/readingOrder.ts, server/app/reading_order.py, Android ReadingOrder.kt, iOS ReadingOrder.swift).

Run after changing the test pages or the ordering on purpose, then check the diff:

    server/.venv/bin/python server/tests/make_reading_order_fixture.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE), str(HERE.parent)]

import pypdfium2 as pdfium  # noqa: E402

from app import extract, tables  # noqa: E402
from app.reading_order import reading_order  # noqa: E402
from conftest import columns_pdf, tables_pdf  # noqa: E402

OUT = HERE.parents[1] / "mobile" / "shared" / "reading-order" / "cases.json"


def from_pdf(name: str, data: bytes) -> dict:
    doc = pdfium.PdfDocument(data)
    page = doc[0]
    lines = extract._page_text(page, 0)["lines"]
    found = tables.detect_tables(0, [w for line in lines for w in line["words"]], tables.page_rulings(page, extract._Geometry(page)))
    page.close()
    doc.close()
    return {"name": name, "lines": lines,
            "tables": [{"box": t["box"], "cells": [{k: c[k] for k in ("row", "col", "box")} for c in t["cells"]]} for t in found]}


def box(x: float, y: float, w: float, h: float = 12) -> dict:
    return {"x": x, "y": y, "w": w, "h": h}


def rtl_case() -> dict:
    """Two columns of Arabic, drawn left column first; right-to-left reading starts with the right column."""
    lines = []
    for col, x in (("يسار", 60), ("يمين", 320)):  # left, right
        for i in range(3):
            words = [{"text": f"{col}{i + 1}", "box": box(x + 105, 100 + 16 * i, 75)}, {"text": "سطر", "box": box(x + 60, 100 + 16 * i, 41)}]
            lines.append({"text": f"{col}{i + 1} سطر", "box": box(x + 60, 100 + 16 * i, 120), "font": "", "size": 12, "words": words})
    title = {"text": "عنوان الصفحة", "box": box(200, 50, 200, 18), "font": "", "size": 18, "words": [{"text": "عنوان", "box": box(305, 50, 95, 18)}, {"text": "الصفحة", "box": box(200, 50, 100, 18)}]}
    return {"name": "rtl-two-columns", "lines": [*lines, title], "tables": []}


def merged_rows_case(newsletter: dict) -> dict:
    """The newsletter as PDFKit (iOS) returns it: the left column's three rows and the first right-column
    row come back as one line; the other right-column rows on their own."""
    from app.reading_order import split_at_gaps
    lines, merged, rest = [], [], []
    for line in newsletter["lines"]:
        if line["text"][:2] in ("02", "03", "04"):
            left, right = split_at_gaps(line)
            merged += left["words"]
            (merged if line["text"].startswith("02") else rest).extend(right["words"] if line["text"].startswith("02") else [])
            if not line["text"].startswith("02"):
                rest.append({**right})
        else:
            lines.append(line)
    whole = {"text": " ".join(w["text"] for w in merged), "box": _box_of([w["box"] for w in merged]), "font": "", "size": 10, "words": merged}
    at = next(i for i, line in enumerate(lines) if line["text"].startswith("01")) + 1
    lines[at:at] = [whole, *rest]
    return {"name": "merged-rows", "lines": lines, "tables": newsletter["tables"]}


def _box_of(boxes: list[dict]) -> dict:
    x, y = min(b["x"] for b in boxes), min(b["y"] for b in boxes)
    return {"x": x, "y": y, "w": round(max(b["x"] + b["w"] for b in boxes) - x, 2), "h": round(max(b["y"] + b["h"] for b in boxes) - y, 2)}


def main() -> None:
    newsletter = from_pdf("newsletter", columns_pdf())
    cases = [newsletter, from_pdf("tables", tables_pdf()), rtl_case(), merged_rows_case(newsletter)]
    for c in cases:
        found = [{"box": t["box"], "cells": [{**cell} for cell in t["cells"]]} for t in c["tables"]]
        c["expected"] = [line["text"] for line in reading_order(c["lines"], found)]
    (OUT.parent / "columns.pdf").write_bytes(columns_pdf())  # for the Android device test and the iOS test
    OUT.write_text(json.dumps({
        "about": "Input (lines as drawn, tables) and expected reading order. Made by server/tests/make_reading_order_fixture.py.",
        "cases": cases,
    }, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    for c in cases:
        print(c["name"], c["expected"])


if __name__ == "__main__":
    main()
