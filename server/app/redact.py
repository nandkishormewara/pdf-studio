"""
True redaction.

Covering text with a black box (what many tools do) leaves the text in the file. Here every page
that has a redaction region is *replaced* by a raster image of itself with the regions painted
out, so the underlying text, vector graphics and images are gone from the file. Optionally the
page is OCR'd again so the remaining text stays searchable.

Other leaks closed at the same time:
  * annotations / form widgets overlapping a region are removed (their text would survive);
  * the structure tree is dropped (it can carry /Alt and /ActualText copies of the text);
  * with sanitize=True: document info, XMP metadata, JavaScript, open actions and embedded
    files are removed;
  * the file is fully rewritten, so no earlier incremental revision survives.
"""
from __future__ import annotations

import io
from dataclasses import dataclass, field

import pikepdf
import pypdfium2 as pdfium
from PIL import ImageDraw
from pikepdf import Array, Dictionary, Name

from .config import settings
from .errors import ToolError
from .render import render_unrotated

Box = tuple[float, float, float, float]  # x1, y1, x2, y2 in PDF user space


@dataclass
class TextTarget:
    """Text the user marked (e.g. a search hit). Its exact glyph boxes are redacted, so an
    imprecise on-screen mark can't leave part of a word visible."""
    text: str
    near: Box


def exact_text_boxes(page: pdfium.PdfPage, targets: list[TextTarget]) -> list[Box]:
    """Finds each target's occurrence(s) overlapping `near` and returns per-line glyph boxes."""
    if not targets:
        return []
    textpage = page.get_textpage()
    boxes: list[Box] = []
    try:
        for target in targets:
            if not target.text.strip():
                continue
            searcher = textpage.search(target.text, match_case=True)
            try:
                while (hit := searcher.get_next()) is not None:
                    index, count = hit
                    chars = [textpage.get_charbox(i, loose=True) for i in range(index, index + count)]
                    lines: list[list[float]] = []
                    for left, bottom, right, top in chars:
                        if right <= left:
                            continue  # spaces / generated chars
                        line = next((ln for ln in lines if abs(ln[1] - bottom) < (top - bottom) * 0.5), None)
                        if line:
                            line[0], line[1] = min(line[0], left), min(line[1], bottom)
                            line[2], line[3] = max(line[2], right), max(line[3], top)
                        else:
                            lines.append([left, bottom, right, top])
                    found = [tuple(ln) for ln in lines]
                    if any(_intersects(_norm(f), _norm(target.near)) for f in found):  # type: ignore[arg-type]
                        boxes.extend(found)  # type: ignore[arg-type]
            finally:
                searcher.close()
    finally:
        textpage.close()
    return boxes


@dataclass
class RedactionReport:
    pages: list[int] = field(default_factory=list)
    regions: int = 0
    annotations_removed: int = 0
    sanitized: list[str] = field(default_factory=list)
    ocr_pages: list[int] = field(default_factory=list)


def _norm(b: Box) -> Box:
    x1, y1, x2, y2 = b
    return min(x1, x2), min(y1, y2), max(x1, x2), max(y1, y2)


def _intersects(a: Box, b: Box) -> bool:
    return a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]


def redact_pdf(
    data: bytes,
    regions: dict[int, list[Box]],
    *,
    texts: dict[int, list[TextTarget]] | None = None,
    sanitize: bool = True,
    fill: tuple[int, int, int] = (0, 0, 0),
    ocr_languages: list[str] | None = None,
) -> tuple[bytes, RedactionReport]:
    report = RedactionReport()
    try:
        src = pdfium.PdfDocument(data)
        pdf = pikepdf.open(io.BytesIO(data))
    except Exception as exc:  # noqa: BLE001 - surface any parse failure to the user
        raise ToolError(f"Could not read the PDF: {exc}") from exc

    removed_widget_objgens: set[tuple[int, int]] = set()
    pad = 1.0
    try:
        texts = texts or {}
        for page_index in sorted(set(regions) | set(texts)):
            if not 0 <= page_index < len(pdf.pages):
                raise ToolError(f"Page {page_index + 1} does not exist.")
            boxes = list(regions.get(page_index, [])) + exact_text_boxes(src[page_index], texts.get(page_index, []))
            if not boxes:
                continue
            boxes = [(_b[0] - pad, _b[1] - pad, _b[2] + pad, _b[3] + pad) for _b in map(_norm, boxes)]

            # 1. Rasterise page content (without annotations) and paint the regions out.
            rendered = render_unrotated(src[page_index], settings.redact_dpi, draw_annots=False)
            left, bottom, _, top = rendered.crop
            s = rendered.scale
            draw = ImageDraw.Draw(rendered.image)
            for x1, y1, x2, y2 in boxes:
                draw.rectangle([(x1 - left) * s, (top - y2) * s, (x2 - left) * s, (top - y1) * s], fill=fill)
            jpeg = io.BytesIO()
            rendered.image.save(jpeg, format="JPEG", quality=88, optimize=True)

            # 2. Replace the page's content and resources with that image.
            page = pdf.pages[page_index]
            w_px, h_px = rendered.image.size
            image = pikepdf.Stream(pdf, jpeg.getvalue())
            image.Type, image.Subtype = Name.XObject, Name.Image
            image.Width, image.Height = w_px, h_px
            image.ColorSpace, image.BitsPerComponent = Name.DeviceRGB, 8
            image.Filter = Name.DCTDecode
            crop_w = rendered.crop[2] - left
            crop_h = top - bottom
            content = f"q {crop_w:.4f} 0 0 {crop_h:.4f} {left:.4f} {bottom:.4f} cm /Redacted Do Q".encode()
            page.obj.Contents = pikepdf.Stream(pdf, content)
            page.obj.Resources = Dictionary(XObject=Dictionary(Redacted=image))
            for key in ("/Thumb", "/PieceInfo", "/StructParents", "/Group", "/AA"):
                if key in page.obj:
                    del page.obj[key]

            # 3. Drop annotations that touch a region (keep links etc. elsewhere on the page).
            if "/Annots" in page.obj:
                keep = Array()
                for annot in page.obj.Annots:
                    rect = annot.get("/Rect")
                    hit = rect is None or any(_intersects(_norm(tuple(float(v) for v in rect)), b) for b in boxes)
                    if hit:
                        report.annotations_removed += 1
                        if annot.get("/Subtype") == Name.Widget:
                            removed_widget_objgens.add(annot.objgen)
                    else:
                        keep.append(annot)
                page.obj.Annots = keep

            report.pages.append(page_index)
            report.regions += len(boxes)

        if removed_widget_objgens:
            _prune_form_fields(pdf, removed_widget_objgens)

        if report.pages:
            # The structure tree can hold /Alt and /ActualText copies of the redacted text.
            for key in ("/StructTreeRoot", "/MarkInfo"):
                if key in pdf.Root:
                    del pdf.Root[key]
        if sanitize:
            report.sanitized = _sanitize(pdf)

        out = io.BytesIO()
        pdf.save(out, compress_streams=True, object_stream_mode=pikepdf.ObjectStreamMode.generate)
    finally:
        pdf.close()
        src.close()

    result = out.getvalue()
    if ocr_languages and report.pages and settings.tesseract:
        from .ocr import ocr_pdf  # local import: OCR is optional

        ocr = ocr_pdf(result, ocr_languages, pages=report.pages, force=True)
        result = ocr.pdf
        report.ocr_pages = ocr.pages_ocrd
    return result, report


def _prune_form_fields(pdf: pikepdf.Pdf, widget_objgens: set[tuple[int, int]]) -> None:
    """Removes deleted widgets from the AcroForm field tree (and empty parents)."""
    acro = pdf.Root.get("/AcroForm")
    if acro is None or "/Fields" not in acro:
        return

    def prune(array: Array) -> Array:
        kept = Array()
        for node in array:
            if node.objgen in widget_objgens:
                continue
            if "/Kids" in node:
                node.Kids = prune(node.Kids)
                if len(node.Kids) == 0:
                    continue
            kept.append(node)
        return kept

    acro.Fields = prune(acro.Fields)


def _sanitize(pdf: pikepdf.Pdf) -> list[str]:
    done: list[str] = []
    if pdf.trailer.get("/Info") is not None and len(pdf.docinfo):
        for key in list(pdf.docinfo.keys()):
            del pdf.docinfo[key]
        done.append("document info")
    if "/Metadata" in pdf.Root:
        del pdf.Root.Metadata
        done.append("XMP metadata")
    for key, label in (("/OpenAction", "open action"), ("/AA", "document actions")):
        if key in pdf.Root:
            del pdf.Root[key]
            done.append(label)
    names = pdf.Root.get("/Names")
    if names is not None:
        for key, label in (("/JavaScript", "JavaScript"), ("/EmbeddedFiles", "embedded files")):
            if key in names:
                del names[key]
                done.append(label)
    for page in pdf.pages:
        if "/AA" in page.obj:
            del page.obj.AA
    return done
