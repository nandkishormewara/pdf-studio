"""Writes mobile/shared/tables/tables-page.json: the words and ruling lines of tables_pdf() as PDFium sees
them, and the tables both detectors (server/app/tables.py, web/src/sdk/tables.ts) must find in them.

Run after changing tables_pdf() or the detection on purpose, then check the diff:

    server/.venv/bin/python server/tests/make_tables_fixture.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE), str(HERE.parent)]

import pypdfium2 as pdfium  # noqa: E402

from app import extract, tables  # noqa: E402
from conftest import tables_pdf  # noqa: E402

OUT = HERE.parents[1] / "mobile" / "shared" / "tables" / "tables-page.json"


def _strip(t: dict) -> dict:
    return {"method": t["method"], "rows": t["rows"], "cols": t["cols"],
            "cells": [{k: c[k] for k in ("row", "col", "rowSpan", "colSpan", "text")} for c in t["cells"]]}


def main() -> None:
    doc = pdfium.PdfDocument(tables_pdf())
    page = doc[0]
    words = [w for line in extract._page_text(page, 0)["lines"] for w in line["words"]]
    segments = [[round(v, 2) for v in s] for s in tables.page_rulings(page, extract._Geometry(page))]
    found = tables.detect_tables(0, words, [tuple(s) for s in segments])
    without_lines = tables.detect_tables(0, words, [])  # what Android and iOS find: they read no ruling lines
    page.close()
    doc.close()
    OUT.write_text(json.dumps({
        "about": "Input and expected output for table detection (web/src/sdk/tables.ts, server/app/tables.py). Made by server/tests/make_tables_fixture.py.",
        "page": 0, "words": words, "segments": segments,
        "expected": [_strip(t) for t in found],
        "expectedWithoutLines": [_strip(t) for t in without_lines],
    }, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"{OUT}: {len(words)} words, {len(segments)} lines, {len(found)} tables")


if __name__ == "__main__":
    main()
