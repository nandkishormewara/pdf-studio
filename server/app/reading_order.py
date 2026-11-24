"""Reading order on the server: the same steps as the web SDK (web/src/sdk/readingOrder.ts).

Lines are split at column-wide gaps, then ordered with Breuel's two rules and a topological sort; lines
inside a table are read row by row, cells joined by tabs. mobile/shared/reading-order/ keeps the
implementations in step.
"""
from __future__ import annotations

import bisect
import re
import statistics

from .tables import COLUMN_GAP

SECTION_GAP = 1.5  # empty space across the page taller than this many line heights separates two sections
RTL = re.compile(r"[֐-߿יִ-﷿ﹰ-﻿]")


def _cy(b: dict) -> float:
    return b["y"] + b["h"] / 2


def _union(boxes: list[dict]) -> dict:
    x, y = min(b["x"] for b in boxes), min(b["y"] for b in boxes)
    return {"x": round(x, 2), "y": round(y, 2), "w": round(max(b["x"] + b["w"] for b in boxes) - x, 2),
            "h": round(max(b["y"] + b["h"] for b in boxes) - y, 2)}


def is_rtl(lines: list[dict]) -> bool:
    text = "".join(line["text"] for line in lines)
    letters = sum(ch.isalpha() for ch in text)
    return letters > 0 and len(RTL.findall(text)) / letters > 0.5


def split_at_gaps(line: dict) -> list[dict]:
    """The line cut where a word starts a new row, then at column-wide gaps within each row (see the web SDK)."""
    words = line["words"]
    if len(words) < 2 or line["box"]["h"] > line["box"]["w"]:
        return [line]
    rows: list[list[int]] = []
    top = bottom = 0.0
    for i, w in enumerate(words):
        b = w["box"]
        overlap = min(bottom, b["y"] + b["h"]) - max(top, b["y"])
        if rows and overlap >= 0.5 * min(b["h"], bottom - top):
            rows[-1].append(i)
            top, bottom = min(top, b["y"]), max(bottom, b["y"] + b["h"])
        else:
            rows.append([i])
            top, bottom = b["y"], b["y"] + b["h"]
    piece = [0] * len(words)
    n = -1
    for row in rows:
        height = statistics.median(words[i]["box"]["h"] for i in row) or 1
        right = None
        for i in sorted(row, key=lambda i: words[i]["box"]["x"]):
            b = words[i]["box"]
            if right is None or b["x"] - right > COLUMN_GAP * height:
                n += 1
            piece[i] = n
            right = b["x"] + b["w"] if right is None else max(right, b["x"] + b["w"])
    if n == 0:
        return [line]
    out = []
    for k in range(n + 1):
        ws = [w for i, w in enumerate(words) if piece[i] == k]
        out.append({**line, "text": " ".join(w["text"] for w in ws), "box": _union([w["box"] for w in ws]), "words": ws})
    return out


def _inside(p: dict, b: dict) -> bool:
    x, y = p["x"] + p["w"] / 2, _cy(p)
    return b["x"] <= x <= b["x"] + b["w"] and b["y"] <= y <= b["y"] + b["h"]


def _table_rows(table: dict, pieces: list[dict]) -> list[dict]:
    """A table's pieces as its rows: each piece goes to the cell holding its centre (else the nearest cell)."""
    def dist(p: dict, b: dict) -> float:
        return ((p["x"] + p["w"] / 2 - b["x"] - b["w"] / 2) ** 2 + (_cy(p) - _cy(b)) ** 2) ** 0.5

    cells = table["cells"]
    by_cell: dict[int, list[dict]] = {}
    for p in pieces:
        k = next((i for i, c in enumerate(cells) if _inside(p["box"], c["box"])), -1)
        if k < 0:
            k = 0
            for i, c in enumerate(cells):
                if dist(p["box"], c["box"]) < dist(p["box"], cells[k]["box"]):
                    k = i
        by_cell.setdefault(k, []).append(p)
    rows: dict[int, list[tuple[int, list[dict]]]] = {}
    for k, ls in by_cell.items():
        ls.sort(key=lambda l: (_cy(l["box"]), l["box"]["x"]))
        rows.setdefault(cells[k]["row"], []).append((cells[k]["col"], ls))
    out = []
    for _, row in sorted(rows.items()):
        row.sort(key=lambda c: c[0])
        texts = [""] * (row[-1][0] + 1)
        for col, ls in row:
            texts[col] = " ".join(l["text"] for l in ls)
        ls = [l for _, cl in row for l in cl]
        out.append({**ls[0], "text": "\t".join(texts), "box": _union([l["box"] for l in ls]), "words": [w for l in ls for w in l["words"]]})
    return out


def reading_order(lines: list[dict], tables: list[dict] | None = None, rtl: bool | None = None) -> list[dict]:
    """The page's lines in reading order. `tables` come from detect_tables; lines inside one are read as its rows."""
    if rtl is None:
        rtl = is_rtl(lines)
    tables = tables or []
    units: list[dict] = []
    in_table: dict[int, list[dict]] = {}
    pieces = [piece for line in lines for piece in split_at_gaps(line)]
    for p in pieces:
        t = next((i for i, tb in enumerate(tables) if _inside(p["box"], tb["box"])), -1)
        if t >= 0:
            in_table.setdefault(t, []).append(p)
        else:
            units.append({"lines": [p], "box": p["box"], "cy": _cy(p["box"])})
    for t, ls in in_table.items():
        units.append({"lines": _table_rows(tables[t], ls), "box": tables[t]["box"], "cy": _cy(tables[t]["box"])})
    if not units:
        return []
    line_h = statistics.median(p["box"]["h"] for p in pieces) or 1
    return [line for sec in _sections(units, line_h) for line in _order_section(sec, rtl)]


def _sections(units: list[dict], line_h: float) -> list[list[dict]]:
    sections: list[list[dict]] = []
    bottom = None
    for u in sorted(units, key=lambda u: u["box"]["y"]):
        if not sections or u["box"]["y"] - bottom > SECTION_GAP * line_h:
            sections.append([])
        sections[-1].append(u)
        bottom = u["box"]["y"] + u["box"]["h"] if bottom is None else max(bottom, u["box"]["y"] + u["box"]["h"])
    return sections


def _order_section(units: list[dict], rtl: bool) -> list[dict]:
    """Breuel's two rules and a topological sort, within one section."""

    for u in units:  # mirrored for right-to-left pages, so "left of" means "read first"
        b = u["box"]
        u["x0"], u["x1"] = (-(b["x"] + b["w"]), -b["x"]) if rtl else (b["x"], b["x"] + b["w"])
    n = len(units)
    by_y = sorted(range(n), key=lambda i: units[i]["cy"])
    ys = [units[i]["cy"] for i in by_y]
    before: list[list[int]] = [[] for _ in range(n)]
    for a in range(n):
        A = units[a]
        for b in range(n):
            if a == b:
                continue
            B = units[b]
            overlap = min(A["x1"], B["x1"]) - max(A["x0"], B["x0"])
            if overlap > 1:
                if A["cy"] < B["cy"]:
                    before[b].append(a)
            elif A["x1"] <= B["x0"] + 1:
                lo, hi = min(A["cy"], B["cy"]), max(A["cy"], B["cy"])
                blocked = any(c not in (a, b) and units[c]["cy"] > lo and units[c]["cy"] < hi
                              and units[c]["x0"] < A["x1"] and units[c]["x1"] > B["x0"]
                              for c in by_y[bisect.bisect_right(ys, lo):bisect.bisect_left(ys, hi)])
                if not blocked:
                    before[b].append(a)

    def first(cands: list[int]) -> int:
        best = cands[0]
        for i in cands[1:]:
            y, x, by, bx = units[i]["cy"], units[i]["x0"], units[best]["cy"], units[best]["x0"]
            if y < by - 0.5 or (abs(y - by) <= 0.5 and x < bx):
                best = i
        return best

    done = [False] * n
    order: list[int] = []
    while len(order) < n:
        free = [i for i in range(n) if not done[i] and all(done[j] for j in before[i])]
        pick = first(free or [i for i in range(n) if not done[i]])
        done[pick] = True
        order.append(pick)
    return [line for i in order for line in units[i]["lines"]]
