"""
OCR: adds an invisible, searchable text layer to scanned pages.

Pipeline per page: PDFium renders the page -> Tesseract writes a text-only PDF page
(`textonly_pdf=1`, invisible glyphs with ToUnicode) -> pikepdf overlays it onto the
original page. The original page content is untouched, so quality never degrades.
"""
from __future__ import annotations

import functools
import io
import os
import subprocess
import tempfile
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

import pikepdf
import pypdfium2 as pdfium

from .config import settings
from .errors import ToolError, ToolUnavailable
from .render import page_has_text, render_unrotated


@functools.lru_cache(maxsize=1)
def available_languages() -> list[str]:
    if not settings.tesseract:
        return []
    out = subprocess.run([settings.tesseract, "--list-langs"], capture_output=True, text=True, check=False)
    langs = [line.strip() for line in out.stdout.splitlines()[1:] if line.strip()]
    return sorted(set(langs) - {"osd"})


@dataclass
class OcrResult:
    pdf: bytes
    pages_ocrd: list[int]
    pages_skipped: list[int]


def ocr_pdf(data: bytes, languages: list[str], pages: list[int] | None = None, force: bool = False) -> OcrResult:
    if not settings.tesseract:
        raise ToolUnavailable("Tesseract OCR is not installed on the server.")
    known = available_languages()
    missing = [lang for lang in languages if lang not in known]
    if missing:
        raise ToolError(f"OCR language(s) not installed: {', '.join(missing)}. Available: {', '.join(known)}")
    lang = "+".join(languages) or "eng"

    try:
        doc = pdfium.PdfDocument(data)
    except pdfium.PdfiumError as exc:
        raise ToolError(f"Could not read the PDF: {exc}") from exc

    with tempfile.TemporaryDirectory(prefix="pdfstudio-ocr-") as tmp:
        tmpdir = Path(tmp)
        todo: list[tuple[int, Path, int]] = []
        skipped: list[int] = []
        wanted = range(len(doc)) if pages is None else [p for p in pages if 0 <= p < len(doc)]
        # Render sequentially (PDFium is not thread-safe) ...
        for i in wanted:
            page = doc[i]
            if not force and page_has_text(page):
                skipped.append(i)
                continue
            rendered = render_unrotated(page, settings.ocr_dpi, draw_annots=False)
            png = tmpdir / f"p{i}.png"
            rendered.image.save(png)
            todo.append((i, png, round(rendered.scale * 72)))
        doc.close()

        # ... then run Tesseract on several pages at once.
        def run(item: tuple[int, Path, int]) -> tuple[int, Path]:
            i, png, dpi = item
            base = tmpdir / f"p{i}"
            env = {**os.environ, "OMP_THREAD_LIMIT": "1"}
            proc = subprocess.run(
                [settings.tesseract, str(png), str(base), "-l", lang, "--dpi", str(dpi), "-c", "textonly_pdf=1", "pdf"],
                capture_output=True, env=env, check=False, timeout=600,
            )
            if proc.returncode != 0:
                raise ToolError(f"Tesseract failed on page {i + 1}: {proc.stderr.decode(errors='replace')[-300:]}", status=500)
            return i, base.with_suffix(".pdf")

        with ThreadPoolExecutor(max_workers=settings.workers) as pool:
            results = list(pool.map(run, todo))

        pdf = pikepdf.open(io.BytesIO(data))
        layers = []
        try:
            for i, text_pdf in results:
                layer = pikepdf.open(text_pdf)
                layers.append(layer)
                _place_text_layer(pdf, pdf.pages[i], layer.pages[0])
            out = io.BytesIO()
            pdf.save(out)
        finally:
            for layer in layers:
                layer.close()
            pdf.close()
    return OcrResult(out.getvalue(), [i for i, _ in results], skipped)


def _place_text_layer(pdf: pikepdf.Pdf, page: pikepdf.Page, layer_page: pikepdf.Page) -> None:
    """
    Draws Tesseract's text-only page over the crop box in *unrotated* user space.

    (pikepdf's add_overlay compensates for /Rotate, which is wrong here: the layer was produced
    from an unrotated render, so it already matches user space.)
    """
    crop = [float(v) for v in page.cropbox]
    box = [float(v) for v in layer_page.mediabox]
    sx = (crop[2] - crop[0]) / (box[2] - box[0])
    sy = (crop[3] - crop[1]) / (box[3] - box[1])
    form = pdf.copy_foreign(layer_page.as_form_xobject())
    name = page.add_resource(form, pikepdf.Name.XObject, prefix="OCR")
    # Isolate the original content so its graphics state can't leak into the overlay.
    page.contents_add(pdf.make_stream(b"q\n"), prepend=True)
    page.contents_add(pdf.make_stream(
        f"\nQ q {sx:.6f} 0 0 {sy:.6f} {crop[0] - box[0] * sx:.4f} {crop[1] - box[1] * sy:.4f} cm {name} Do Q\n".encode()
    ))
