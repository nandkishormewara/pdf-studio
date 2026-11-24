"""Table detection on the server: the same steps and constants as the web SDK (web/src/sdk/tables.ts).

Words come from extract._page_text (exact PDFium glyph boxes); ruling lines from the page's path
objects. The shared cases in mobile/shared/tables/ keep this file and the web one in step.
Units are page units: points, origin at the top-left of the page as displayed.
"""
from __future__ import annotations

import ctypes
import io
import statistics
import zipfile
from xml.sax.saxutils import escape

import pypdfium2 as pdfium
import pypdfium2.raw as pdfium_c

SNAP = 3
MIN_LINE = 5
MIN_CELL = 5
COLUMN_GAP = 0.9
ROW_GAP = 1.2
MIN_STREAM_ROWS = 3
THIN_FILL = 3


def _r(v: float) -> float:
    return round(v + 0.0, 2)


def _rect(x: float, y: float, w: float, h: float) -> dict:
    return {"x": _r(x), "y": _r(y), "w": _r(w), "h": _r(h)}


def _union(boxes: list[dict]) -> dict:
    x, y = min(b["x"] for b in boxes), min(b["y"] for b in boxes)
    return {"x": x, "y": y, "w": max(b["x"] + b["w"] for b in boxes) - x, "h": max(b["y"] + b["h"] for b in boxes) - y}


def _cx(b: dict) -> float:
    return b["x"] + b["w"] / 2


def _cy(b: dict) -> float:
    return b["y"] + b["h"] / 2


class _UnionFind:
    def __init__(self, n: int):
        self.parent = list(range(n))

    def find(self, i: int) -> int:
        while self.parent[i] != i:
            self.parent[i] = self.parent[self.parent[i]]
            i = self.parent[i]
        return i

    def union(self, a: int, b: int) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[max(ra, rb)] = min(ra, rb)


def words_to_text(words: list[dict]) -> str:
    """Lines top to bottom, words left to right."""
    lines: list[list[dict]] = []
    for w in sorted(words, key=lambda w: (_cy(w["box"]), w["box"]["x"])):
        if lines and abs(_cy(w["box"]) - _cy(lines[-1][0]["box"])) <= 0.5 * min(w["box"]["h"], lines[-1][0]["box"]["h"]):
            lines[-1].append(w)
        else:
            lines.append([w])
    return "\n".join(" ".join(w["text"] for w in sorted(line, key=lambda w: w["box"]["x"])) for line in lines)


# ------------------------------------------------------------------ lattice

def _merge_lines(lines: list[tuple[float, float, float]]) -> list[list[float]]:
    """(pos, from, to) lines on the same position that overlap or touch, joined."""
    bands: list[list[tuple[float, float, float]]] = []
    for line in sorted(lines):
        if bands and line[0] - bands[-1][0][0] <= SNAP:
            bands[-1].append(line)
        else:
            bands.append([line])
    out: list[list[float]] = []
    for band in bands:
        pos = sum(line[0] for line in band) / len(band)
        cur = None
        for _, a, b in sorted(band, key=lambda line: line[1]):
            if cur and a <= cur[2] + SNAP:
                cur[2] = max(cur[2], b)
            else:
                if cur:
                    out.append(cur)
                cur = [pos, a, b]
        if cur:
            out.append(cur)
    return out


def _grid_positions(values: list[float]) -> list[float]:
    out: list[float] = []
    for v in sorted(values):
        if not out or v - out[-1] >= MIN_CELL:
            out.append(v)
    return out


def _covers(lines: list[list[float]], pos: float, at: float) -> bool:
    return any(abs(line[0] - pos) < MIN_CELL and line[1] - SNAP <= at <= line[2] + SNAP for line in lines)


def _lattice(page: int, words: list[dict], segments: list[tuple[float, float, float, float]], used: set[int]) -> list[dict]:
    hs, vs = [], []
    for x1, y1, x2, y2 in segments:
        dx, dy = abs(x2 - x1), abs(y2 - y1)
        if dy < 1 and dx >= MIN_LINE:
            hs.append(((y1 + y2) / 2, min(x1, x2), max(x1, x2)))
        elif dx < 1 and dy >= MIN_LINE:
            vs.append(((x1 + x2) / 2, min(y1, y2), max(y1, y2)))
    H, V = _merge_lines(hs), _merge_lines(vs)
    uf = _UnionFind(len(H) + len(V))
    for i, h in enumerate(H):
        for j, v in enumerate(V):
            if h[1] - SNAP <= v[0] <= h[2] + SNAP and v[1] - SNAP <= h[0] <= v[2] + SNAP:
                uf.union(i, len(H) + j)
    groups: dict[int, tuple[list, list]] = {}
    for i, h in enumerate(H):
        groups.setdefault(uf.find(i), ([], []))[0].append(h)
    for j, v in enumerate(V):
        groups.setdefault(uf.find(len(H) + j), ([], []))[1].append(v)

    tables = []
    for h, v in groups.values():
        if len(h) < 2 or len(v) < 2:
            continue
        ys, xs = _grid_positions([line[0] for line in h]), _grid_positions([line[0] for line in v])
        rows, cols = len(ys) - 1, len(xs) - 1
        if rows < 1 or cols < 1 or rows * cols < 2:
            continue
        cuf = _UnionFind(rows * cols)
        for r in range(rows):
            for c in range(cols):
                if c < cols - 1 and not _covers(v, xs[c + 1], (ys[r] + ys[r + 1]) / 2):
                    cuf.union(r * cols + c, r * cols + c + 1)
                if r < rows - 1 and not _covers(h, ys[r + 1], (xs[c] + xs[c + 1]) / 2):
                    cuf.union(r * cols + c, (r + 1) * cols + c)
        spans: dict[int, list[int]] = {}
        for r in range(rows):
            for c in range(cols):
                s = spans.setdefault(cuf.find(r * cols + c), [r, r, c, c])
                s[0], s[1], s[2], s[3] = min(s[0], r), max(s[1], r), min(s[2], c), max(s[3], c)
        cells, table_words = [], []
        for r0, r1, c0, c1 in sorted(spans.values(), key=lambda s: (s[0], s[2])):
            box = {"x": xs[c0], "y": ys[r0], "w": xs[c1 + 1] - xs[c0], "h": ys[r1 + 1] - ys[r0]}
            inside = []
            for i, w in enumerate(words):
                if i in used:
                    continue
                x, y = _cx(w["box"]), _cy(w["box"])
                if box["x"] <= x <= box["x"] + box["w"] and box["y"] <= y <= box["y"] + box["h"]:
                    inside.append(w)
                    table_words.append(i)
            cells.append({"row": r0, "col": c0, "rowSpan": r1 - r0 + 1, "colSpan": c1 - c0 + 1, "text": words_to_text(inside),
                          "box": _rect(**box)})
        if not table_words:
            continue
        used.update(table_words)
        tables.append({"page": page, "method": "lattice", "box": _rect(xs[0], ys[0], xs[cols] - xs[0], ys[rows] - ys[0]),
                       "rows": rows, "cols": cols, "cells": cells})
    return tables


# ------------------------------------------------------------------ stream

def _text_rows(words: list[dict]) -> list[dict]:
    groups: list[list[dict]] = []
    for w in sorted(words, key=lambda w: (_cy(w["box"]), w["box"]["x"])):
        if groups and abs(_cy(w["box"]) - _cy(groups[-1][0]["box"])) <= 0.5 * min(w["box"]["h"], groups[-1][0]["box"]["h"]):
            groups[-1].append(w)
        else:
            groups.append([w])
    rows = []
    for g in groups:
        ws = sorted(g, key=lambda w: w["box"]["x"])
        height = statistics.median(w["box"]["h"] for w in ws) or 1
        chunks: list[dict] = []
        for w in ws:
            if chunks and w["box"]["x"] - chunks[-1]["x1"] <= COLUMN_GAP * height:
                chunks[-1]["words"].append(w)
                chunks[-1]["x1"] = max(chunks[-1]["x1"], w["box"]["x"] + w["box"]["w"])
            else:
                chunks.append({"words": [w], "x0": w["box"]["x"], "x1": w["box"]["x"] + w["box"]["w"]})
        rows.append({"words": ws, "top": min(w["box"]["y"] for w in ws), "bottom": max(w["box"]["y"] + w["box"]["h"] for w in ws),
                     "height": height, "chunks": chunks})
    return rows


def _column_bands(rows: list[dict]) -> list[list[float]]:
    multi = [r for r in rows if len(r["chunks"]) >= 2]
    counts: dict[int, int] = {}
    for r in multi:
        counts[len(r["chunks"])] = counts.get(len(r["chunks"]), 0) + 1
    if not counts:
        return []
    mode = sorted(counts.items(), key=lambda kv: (-kv[1], -kv[0]))[0][0]
    spans = sorted([c["x0"], c["x1"]] for r in multi if len(r["chunks"]) == mode for c in r["chunks"])
    bands: list[list[float]] = []
    for a, b in spans:
        if bands and a <= bands[-1][1] + SNAP:
            bands[-1][1] = max(bands[-1][1], b)
        else:
            bands.append([a, b])
    return bands


def _bands_of(c: dict, bands: list[list[float]]) -> tuple[int, int]:
    hit = [i for i, b in enumerate(bands) if c["x0"] < b[1] - SNAP and c["x1"] > b[0] + SNAP]
    if hit:
        return hit[0], hit[-1]
    mid = (c["x0"] + c["x1"]) / 2
    best = 0
    for i, b in enumerate(bands):
        if abs((b[0] + b[1]) / 2 - mid) < abs((bands[best][0] + bands[best][1]) / 2 - mid):
            best = i
    return best, best


def _stream_table(page: int, rows: list[dict]) -> list[dict]:
    a, b = 0, len(rows) - 1
    while a <= b and len(rows[a]["chunks"]) < 2:
        a += 1
    while b >= a and len(rows[b]["chunks"]) < 2:
        b -= 1
    if a > b:
        return []
    rows = rows[a:b + 1]
    bands = _column_bands(rows)
    for i, r in enumerate(rows):
        if len(r["chunks"]) == 1:
            first, last = _bands_of(r["chunks"][0], bands)
            if last > first:
                return _stream_table(page, rows[:i]) + _stream_table(page, rows[i + 1:])
    multi = [r for r in rows if len(r["chunks"]) >= 2]
    if len(multi) < MIN_STREAM_ROWS or len(bands) < 2:
        return []
    width = bands[-1][1] - bands[0][0]
    if len(bands) == 2 and statistics.median(c["x1"] - c["x0"] for r in multi for c in r["chunks"]) > 0.3 * width:
        return []
    cells = []
    for ri, r in enumerate(rows):
        by_col: dict[int, dict] = {}
        for c in r["chunks"]:
            first, last = _bands_of(c, bands)
            if first in by_col:
                by_col[first]["words"] += c["words"]
                by_col[first]["last"] = max(by_col[first]["last"], last)
            else:
                by_col[first] = {"words": list(c["words"]), "last": last}
        for col in sorted(by_col):
            ws = by_col[col]["words"]
            cells.append({"row": ri, "col": col, "rowSpan": 1, "colSpan": by_col[col]["last"] - col + 1, "text": words_to_text(ws),
                          "box": _rect(**_union([w["box"] for w in ws]))})
    boxes = [w["box"] for r in rows for w in r["words"]] + [{"x": bands[0][0], "y": rows[0]["top"], "w": width, "h": 0}]
    return [{"page": page, "method": "stream", "box": _rect(**_union(boxes)), "rows": len(rows), "cols": len(bands), "cells": cells}]


def _stream(page: int, words: list[dict]) -> list[dict]:
    tables: list[dict] = []
    block: list[dict] = []
    for r in _text_rows(words):
        if block and r["top"] - block[-1]["bottom"] > ROW_GAP * max(block[-1]["height"], r["height"]):
            tables += _stream_table(page, block)
            block = []
        block.append(r)
    tables += _stream_table(page, block)
    return tables


def detect_tables(page: int, words: list[dict], segments: list[tuple[float, float, float, float]]) -> list[dict]:
    """Tables on one page (page is 0-based here, as in the web SDK); sorted top to bottom."""
    used: set[int] = set()
    lattice = _lattice(page, words, segments, used)
    stream = _stream(page, [w for i, w in enumerate(words) if i not in used])
    return sorted(lattice + stream, key=lambda t: (t["box"]["y"], t["box"]["x"]))


def table_grid(t: dict) -> list[list[str]]:
    grid = [[""] * t["cols"] for _ in range(t["rows"])]
    for c in t["cells"]:
        if c["row"] < t["rows"] and c["col"] < t["cols"]:
            grid[c["row"]][c["col"]] = c["text"]
    return grid


# ------------------------------------------------------------------ ruling lines from PDFium

def _matrix(obj) -> tuple[float, ...]:
    m = pdfium_c.FS_MATRIX()
    if not pdfium_c.FPDFPageObj_GetMatrix(obj.raw, ctypes.byref(m)):
        return (1, 0, 0, 1, 0, 0)
    return (m.a, m.b, m.c, m.d, m.e, m.f)


def _mul(m: tuple, n: tuple) -> tuple:
    """m then n (PDF order: point · m · n)."""
    a, b, c, d, e, f = m
    A, B, C, D, E, F = n
    return (a * A + b * C, a * B + b * D, c * A + d * C, c * B + d * D, e * A + f * C + E, e * B + f * D + F)


def page_rulings(page: pdfium.PdfPage, geo) -> list[tuple[float, float, float, float]]:
    """Straight lines drawn on the page (stroked paths, thin filled boxes), in page units."""
    out: list[tuple[float, float, float, float]] = []
    forms: dict[int, tuple] = {0: (1, 0, 0, 1, 0, 0)}  # level → matrix from that level's space to the page
    for obj in page.get_objects(max_depth=8):
        level = getattr(obj, "level", 0)
        parent = forms.get(level, (1, 0, 0, 1, 0, 0))
        if obj.type == pdfium_c.FPDF_PAGEOBJ_FORM:
            forms[level + 1] = _mul(_matrix(obj), parent)
            continue
        if obj.type != pdfium_c.FPDF_PAGEOBJ_PATH:
            continue
        fill_mode, stroke = ctypes.c_int(), ctypes.c_int()
        if not pdfium_c.FPDFPath_GetDrawMode(obj.raw, ctypes.byref(fill_mode), ctypes.byref(stroke)):
            continue
        if not stroke.value and not fill_mode.value:
            continue  # a clipping path: not drawn
        m = _mul(_matrix(obj), parent)

        def to_page(x: float, y: float) -> tuple[float, float]:
            return geo.point(m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5])

        subpaths: list[list[tuple[float, float]]] = []
        cur: list[tuple[float, float]] = []
        x, y = ctypes.c_float(), ctypes.c_float()
        n = pdfium_c.FPDFPath_CountSegments(obj.raw)
        for i in range(n):
            seg = pdfium_c.FPDFPath_GetPathSegment(obj.raw, i)
            pdfium_c.FPDFPathSegment_GetPoint(seg, ctypes.byref(x), ctypes.byref(y))
            kind = pdfium_c.FPDFPathSegment_GetType(seg)
            pt = to_page(x.value, y.value)
            if kind == pdfium_c.FPDF_SEGMENT_MOVETO:
                if cur:
                    subpaths.append(cur)
                cur = [pt]
            elif kind == pdfium_c.FPDF_SEGMENT_LINETO:
                cur.append(pt)
            else:  # a curve: not a line; continue from where it ends
                if cur:
                    subpaths.append(cur)
                cur = [pt]
            if pdfium_c.FPDFPathSegment_GetClose(seg) and len(cur) > 2:
                cur.append(cur[0])
        if cur:
            subpaths.append(cur)
        for pts in subpaths:
            if stroke.value:
                out += [(pts[k - 1][0], pts[k - 1][1], pts[k][0], pts[k][1]) for k in range(1, len(pts))]
            else:
                xs, ys = [p[0] for p in pts], [p[1] for p in pts]
                x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
                if y1 - y0 <= THIN_FILL < x1 - x0:
                    out.append((x0, (y0 + y1) / 2, x1, (y0 + y1) / 2))
                elif x1 - x0 <= THIN_FILL < y1 - y0:
                    out.append(((x0 + x1) / 2, y0, (x0 + x1) / 2, y1))
    return out


# ------------------------------------------------------------------ export

def table_name(tables: list[dict], t: dict) -> str:
    n = [x for x in tables if x["page"] == t["page"]].index(t) + 1
    return f"page-{t['page'] + 1:03d}-table-{n:02d}"


def table_csv(t: dict) -> str:
    def cell(v: str) -> str:
        if v[:1] in ("=", "+", "-", "@", "\t", "\r"):
            v = "'" + v  # would run as a formula in Excel
        return '"' + v.replace('"', '""') + '"' if any(ch in v for ch in ',"\n\r') else v
    return "﻿" + "".join(",".join(cell(v) for v in row) + "\r\n" for row in table_grid(t))


def _col(c: int) -> str:
    s, n = "", c + 1
    while n:
        n, rem = divmod(n - 1, 26)
        s = chr(65 + rem) + s
    return s


def _xml(s: str) -> str:
    s = "".join(ch for ch in s if ch in "\t\n\r" or ord(ch) >= 0x20 and ch not in "￾￿")
    return escape(s, {'"': "&quot;"})


def tables_xlsx(tables: list[dict]) -> bytes:
    """One workbook, one sheet per table (same layout as the web SDK's makeXlsx)."""
    names = []
    for t in tables:
        name = table_name(tables, t)
        _, page, _, n = name.split("-")
        names.append(f"Page {int(page)} table {int(n)}")
    ct = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
          '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
          '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
          + "".join(f'<Override PartName="/xl/worksheets/sheet{i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
                    for i in range(len(tables))) + "</Types>")
    rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')
    wb = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
          'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
          + "".join(f'<sheet name="{_xml(n)}" sheetId="{i + 1}" r:id="rId{i + 1}"/>' for i, n in enumerate(names)) + "</sheets></workbook>")
    wb_rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
               + "".join(f'<Relationship Id="rId{i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" '
                         f'Target="worksheets/sheet{i + 1}.xml"/>' for i in range(len(tables)))
               + f'<Relationship Id="rId{len(tables) + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>')
    styles = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
              '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill>'
              '<fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
              '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2">'
              '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1">'
              '<alignment vertical="top" wrapText="1"/></xf></cellXfs></styleSheet>')
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", ct)
        z.writestr("_rels/.rels", rels)
        z.writestr("xl/workbook.xml", wb)
        z.writestr("xl/_rels/workbook.xml.rels", wb_rels)
        z.writestr("xl/styles.xml", styles)
        for i, t in enumerate(tables):
            widths: dict[int, int] = {}
            rows = []
            for r, row in enumerate(table_grid(t)):
                cells = []
                for c, v in enumerate(row):
                    if not v:
                        continue
                    widths[c] = max(widths.get(c, 0), max(len(line) for line in v.split("\n")))
                    style = ' s="1"' if "\n" in v else ""
                    cells.append(f'<c r="{_col(c)}{r + 1}" t="inlineStr"{style}><is><t xml:space="preserve">{_xml(v)}</t></is></c>')
                rows.append(f'<row r="{r + 1}">{"".join(cells)}</row>')
            cols = "".join(f'<col min="{c + 1}" max="{c + 1}" width="{min(60, max(8, w + 2))}" customWidth="1"/>' for c, w in sorted(widths.items()))
            merges = [c for c in t["cells"] if c["rowSpan"] > 1 or c["colSpan"] > 1]
            merge_xml = (f'<mergeCells count="{len(merges)}">' + "".join(
                f'<mergeCell ref="{_col(c["col"])}{c["row"] + 1}:{_col(c["col"] + c["colSpan"] - 1)}{c["row"] + c["rowSpan"]}"/>' for c in merges)
                + "</mergeCells>") if merges else ""
            z.writestr(f"xl/worksheets/sheet{i + 1}.xml",
                       '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                       + (f"<cols>{cols}</cols>" if cols else "") + f'<sheetData>{"".join(rows)}</sheetData>{merge_xml}</worksheet>')
    return buf.getvalue()
