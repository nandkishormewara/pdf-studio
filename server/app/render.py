"""Page rasterising with PDFium (BSD/Apache) in *unrotated* page space."""
from __future__ import annotations

from dataclasses import dataclass

import pypdfium2 as pdfium
from PIL import Image

MAX_PIXELS = 60_000_000  # guard against absurd page sizes


@dataclass
class RenderedPage:
    image: Image.Image
    crop: tuple[float, float, float, float]  # left, bottom, right, top in PDF user space
    scale: float  # pixels per point


def render_unrotated(page: pdfium.PdfPage, dpi: int, draw_annots: bool = True) -> RenderedPage:
    """Renders the crop box without applying /Rotate, so pixels map straight onto user space."""
    crop = page.get_cropbox()
    w_pt, h_pt = crop[2] - crop[0], crop[3] - crop[1]
    scale = dpi / 72
    if w_pt * h_pt * scale * scale > MAX_PIXELS:
        scale = (MAX_PIXELS / (w_pt * h_pt)) ** 0.5
    undo_rotation = (360 - page.get_rotation()) % 360
    bitmap = page.render(scale=scale, rotation=undo_rotation, draw_annots=draw_annots, may_draw_forms=draw_annots)
    return RenderedPage(bitmap.to_pil().convert("RGB"), crop, scale)


def page_has_text(page: pdfium.PdfPage, min_chars: int = 20) -> bool:
    textpage = page.get_textpage()
    try:
        text = textpage.get_text_range()
    finally:
        textpage.close()
    return len("".join(text.split())) >= min_chars
