"""Extraction on the server: text with positions, tables, embedded images and fonts.

Same results and coordinates as the web SDK (web/src/sdk/extract.ts): PDF points, origin at the
top-left of the page as displayed (rotation applied). Text comes from PDFium (exact glyph boxes),
images from PDFium (decoded pixels), fonts from pikepdf (the font dictionaries as stored).
"""
from __future__ import annotations

import ctypes
import hashlib
import io
import re
import zipfile
from dataclasses import dataclass, field

import pikepdf
import pypdfium2 as pdfium
import pypdfium2.raw as pdfium_c

from . import tables as table_detection
from .reading_order import reading_order
from .errors import ToolError

CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f�￾]")
SUBSET = re.compile(r"^[A-Z]{6}\+")


@dataclass
class Options:
    pages: list[int] | None = None  # 0-based; None = all
    text: bool = True
    tables: bool = False
    order: str = "reading"  # reading | drawn (see web/src/sdk/readingOrder.ts)
    images: bool = False
    image_format: str = "png"  # png | jpeg
    min_image_px: int = 32
    fonts: bool = False
    font_files: bool = False


@dataclass
class Result:
    pages: list[dict] = field(default_factory=list)
    tables: list[dict] = field(default_factory=list)  # pages 0-based, as detect_tables returns them
    images: list[dict] = field(default_factory=list)
    image_files: dict[str, bytes] = field(default_factory=dict)
    fonts: list[dict] = field(default_factory=list)
    font_files: dict[str, bytes] = field(default_factory=dict)


class _Geometry:
    """PDF user space → page units (top-left of the displayed page), like pdf.js's viewport at scale 1."""

    def __init__(self, page: pdfium.PdfPage):
        self.l, self.b, self.r, self.t = page.get_cropbox()
        self.rot = page.get_rotation() % 360
        w, h = self.r - self.l, self.t - self.b
        self.width, self.height = (h, w) if self.rot in (90, 270) else (w, h)

    def point(self, x: float, y: float) -> tuple[float, float]:
        if self.rot == 90:
            return y - self.b, x - self.l
        if self.rot == 180:
            return self.r - x, y - self.b
        if self.rot == 270:
            return self.t - y, self.r - x
        return x - self.l, self.t - y

    def box(self, left: float, bottom: float, right: float, top: float) -> dict:
        xs, ys = zip(*(self.point(x, y) for x in (left, right) for y in (bottom, top)))
        return {"x": round(min(xs), 2), "y": round(min(ys), 2), "w": round(max(xs) - min(xs), 2), "h": round(max(ys) - min(ys), 2)}


def _union(a: dict | None, b: dict) -> dict:
    if a is None:
        return dict(b)
    x, y = min(a["x"], b["x"]), min(a["y"], b["y"])
    return {"x": round(x, 2), "y": round(y, 2), "w": round(max(a["x"] + a["w"], b["x"] + b["w"]) - x, 2),
            "h": round(max(a["y"] + a["h"], b["y"] + b["h"]) - y, 2)}


def _font_of(textpage: pdfium.PdfTextPage, index: int) -> tuple[str, float]:
    size = pdfium_c.FPDFText_GetFontSize(textpage, index)
    flags = ctypes.c_int()
    n = pdfium_c.FPDFText_GetFontInfo(textpage, index, None, 0, ctypes.byref(flags))
    name = ""
    if n > 0:
        buf = ctypes.create_string_buffer(n)
        pdfium_c.FPDFText_GetFontInfo(textpage, index, buf, n, ctypes.byref(flags))
        name = buf.value.decode("utf-8", "replace")
    return SUBSET.sub("", name), round(float(size), 2)


def _page_text(page: pdfium.PdfPage, index: int) -> dict:
    geo = _Geometry(page)
    textpage = page.get_textpage()
    lines: list[dict] = []
    try:
        count = textpage.count_chars()
        line: dict | None = None
        word: dict | None = None

        def end_word():
            nonlocal word
            if word and word["text"]:
                line["words"].append(word)
            word = None

        def end_line():
            nonlocal line
            end_word()
            if line and line["text"].strip():
                line["text"] = line["text"].strip()
                lines.append(line)
            line = None

        for i in range(count):
            ch = textpage.get_text_range(i, 1)
            if ch in ("\r", "\n"):
                end_line()
                continue
            ch = CONTROL.sub("", ch)
            if not ch:
                continue
            if line is None:
                font, size = _font_of(textpage, i)
                line = {"text": "", "box": None, "font": font, "size": size, "words": []}
            line["text"] += ch
            if ch.isspace():
                end_word()
                continue
            left, bottom, right, top = textpage.get_charbox(i, loose=True)
            box = geo.box(left, bottom, right, top)
            line["box"] = _union(line["box"], box)
            if word is None:
                word = {"text": "", "box": None}
            word["text"] += ch
            word["box"] = _union(word["box"], box)
        end_line()
    finally:
        textpage.close()
    return {"page": index + 1, "width": round(geo.width, 2), "height": round(geo.height, 2), "lines": lines}


def _page_images(page: pdfium.PdfPage, index: int, opts: Options, seen: dict[str, dict], result: Result) -> None:
    geo = _Geometry(page)
    n = 0
    for obj in page.get_objects(filter=(pdfium_c.FPDF_PAGEOBJ_IMAGE,), max_depth=8):
        try:
            pil = obj.get_bitmap(render=False).to_pil()
        except Exception:  # unsupported image (e.g. a broken stream): skip it
            continue
        if max(pil.size) < opts.min_image_px:
            continue
        digest = hashlib.sha1(pil.tobytes() + repr(pil.size).encode()).hexdigest()
        if digest in seen:  # the same picture drawn again (logo on every page)
            if index + 1 not in seen[digest]["pages"]:
                seen[digest]["pages"].append(index + 1)
            continue
        n += 1
        ext = "png" if opts.image_format == "png" else "jpg"
        name = f"page-{index + 1:03d}-image-{n:02d}.{ext}"
        buf = io.BytesIO()
        if ext == "png":
            pil.save(buf, "PNG", optimize=True)
        else:
            pil.convert("RGB").save(buf, "JPEG", quality=92)
        left, bottom, right, top = obj.get_bounds()
        info = {"name": name, "page": index + 1, "pages": [index + 1], "box": geo.box(left, bottom, right, top),
                "widthPx": pil.size[0], "heightPx": pil.size[1], "mime": "image/png" if ext == "png" else "image/jpeg"}
        seen[digest] = info
        result.images.append(info)
        result.image_files[name] = buf.getvalue()


def _fonts(data: bytes, pages: list[int], with_files: bool, result: Result) -> None:
    try:
        pdf = pikepdf.open(io.BytesIO(data))
    except pikepdf.PasswordError as exc:
        raise ToolError("The document is password protected.", 422) from exc
    fonts: dict[tuple, dict] = {}
    files: dict[tuple, tuple[str, bytes]] = {}

    def program(desc):
        if desc is None:
            return None
        for key, kind, ext in (("/FontFile2", "TrueType", "ttf"), ("/FontFile", "Type1", "pfa"), ("/FontFile3", None, None)):
            if key in desc:
                stream = desc[key]
                if kind is None:
                    kind, ext = ("OpenType", "otf") if stream.get("/Subtype") == "/OpenType" else ("CFF", "cff")
                return stream, kind, ext
        return None

    def visit(resources, page_no: int, depth: int, seen_forms: set):
        if resources is None or depth > 8:
            return
        for _, font in (resources.get("/Font") or {}).items():
            key = font.objgen if font.is_indirect else (id(font),)
            if key in fonts:
                if page_no not in fonts[key]["pages"]:
                    fonts[key]["pages"].append(page_no)
                continue
            ftype = str(font.get("/Subtype", "/Unknown"))[1:]
            base = str(font.get("/BaseFont", "/Type3 font" if ftype == "Type3" else "/Unnamed font"))[1:]
            desc = font.get("/FontDescriptor")
            if ftype == "Type0" and "/DescendantFonts" in font:
                desc = font.DescendantFonts[0].get("/FontDescriptor")
            prog = program(desc)
            fonts[key] = {"name": SUBSET.sub("", base), "baseFont": base, "type": ftype, "embedded": bool(prog) or ftype == "Type3",
                          "subset": bool(SUBSET.match(base)), "program": prog[1] if prog else ("Type3 (drawn glyphs)" if ftype == "Type3" else None),
                          "pages": [page_no]}
            if with_files and prog:
                try:
                    files[key] = (f"{re.sub(r'[^\w.+-]', '_', base)}.{prog[2]}", prog[0].read_bytes())
                except pikepdf.PdfError:
                    pass  # unsupported filter
        for _, xobj in (resources.get("/XObject") or {}).items():
            if xobj.get("/Subtype") == "/Form" and xobj.objgen not in seen_forms:
                seen_forms.add(xobj.objgen)
                visit(xobj.get("/Resources"), page_no, depth + 1, seen_forms)

    with pdf:
        for p in pages:
            visit(pdf.pages[p].obj.get("/Resources"), p + 1, 0, set())
        used: set[str] = set()
        for key, info in sorted(fonts.items(), key=lambda kv: kv[1]["name"]):
            if key in files:
                name, blob = files[key]
                stem, ext = name.rsplit(".", 1)
                i = 2
                while name in used:
                    name = f"{stem}-{i}.{ext}"
                    i += 1
                used.add(name)
                info["file"] = name
                result.font_files[name] = blob
            result.fonts.append(info)


def extract(data: bytes, opts: Options) -> Result:
    try:
        doc = pdfium.PdfDocument(data)
    except pdfium.PdfiumError as exc:
        if "password" in str(exc).lower():
            raise ToolError("The document is password protected.", 422) from exc
        raise ToolError("The file could not be read as a PDF.", 422) from exc
    result = Result()
    try:
        total = len(doc)
        pages = opts.pages if opts.pages is not None else list(range(total))
        bad = [p for p in pages if not 0 <= p < total]
        if bad:
            raise ToolError(f"Page {bad[0] + 1} does not exist (the document has {total}).")
        seen: dict[str, dict] = {}
        for p in pages:
            page = doc[p]
            try:
                text = _page_text(page, p) if opts.text or opts.tables else None
                found = None
                if opts.tables or (opts.text and opts.order == "reading"):
                    words = [w for line in text["lines"] for w in line["words"]]
                    found = table_detection.detect_tables(p, words, table_detection.page_rulings(page, _Geometry(page)))
                if opts.text:
                    if opts.order == "reading":
                        text = {**text, "lines": reading_order(text["lines"], found)}
                    result.pages.append(text)
                if opts.tables:
                    result.tables += found
                if opts.images:
                    _page_images(page, p, opts, seen, result)
            finally:
                page.close()
    finally:
        doc.close()
    if opts.fonts:
        _fonts(data, pages, opts.font_files, result)
    return result


def as_json(result: Result, opts: Options) -> dict:
    out: dict = {"format": "pdf-studio-extract", "version": 1,
                 "units": "PDF points; origin top-left of the page as displayed; box = {x, y, w, h}"}
    if opts.text:
        out["pages"] = result.pages
    if opts.tables:
        out["tables"] = tables_json(result)
    if opts.images:
        out["images"] = result.images
    if opts.fonts:
        out["fonts"] = result.fonts
    return out


def tables_json(result: Result) -> list[dict]:
    """Tables as in the web SDK's tablesToJson: 1-based page, a name, and the grid of texts."""
    return [{"name": table_detection.table_name(result.tables, t), **t, "page": t["page"] + 1, "grid": table_detection.table_grid(t)}
            for t in result.tables]


def tables_xlsx(result: Result) -> bytes:
    return table_detection.tables_xlsx(result.tables)


def plain_text(result: Result) -> str:
    return "\n\n".join(f"===== Page {p['page']} =====\n" + "\n".join(line["text"] for line in p["lines"]) for p in result.pages) + "\n"


def as_zip(result: Result, opts: Options, stem: str) -> bytes:
    import json
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        root = f"{stem}-extracted/"
        if opts.text:
            z.writestr(root + f"{stem}-text.txt", plain_text(result))
        z.writestr(root + f"{stem}-extract.json", json.dumps(as_json(result, opts), ensure_ascii=False, indent=2))
        if result.tables:
            z.writestr(root + f"{stem}-tables.xlsx", table_detection.tables_xlsx(result.tables))
            for t in result.tables:
                z.writestr(root + f"tables/{table_detection.table_name(result.tables, t)}.csv", table_detection.table_csv(t).encode("utf-8"))
        for name, blob in result.image_files.items():
            z.writestr(root + "images/" + name, blob, compress_type=zipfile.ZIP_STORED)
        for name, blob in result.font_files.items():
            z.writestr(root + "fonts/" + name, blob)
    return buf.getvalue()
