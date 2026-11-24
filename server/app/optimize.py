"""Make PDFs fast to open on the web: linearize ("fast web view"), recompress, optionally shrink images.

A linearized file starts with the first page and a hint table, so a viewer that loads by byte
ranges (PDF.js with a URL) can show page 1 before the rest of the file has arrived.
"""
from __future__ import annotations

import io
import logging
from dataclasses import dataclass, field

import pikepdf
from PIL import Image
from pikepdf import PdfImage

from .errors import ToolError

log = logging.getLogger("pdfstudio.optimize")


@dataclass
class OptimizeReport:
    bytes_before: int
    bytes_after: int
    linearized: bool
    images_downsampled: int = 0
    notes: list[str] = field(default_factory=list)


def _is_signed(pdf: pikepdf.Pdf) -> bool:
    acro = pdf.Root.get("/AcroForm")
    if acro is None:
        return False
    for f in acro.get("/Fields", []):
        v = f.get("/V")
        if f.get("/FT") == "/Sig" and v is not None and "/ByteRange" in v:
            return True
    return False


def _downsample(pdf: pikepdf.Pdf, max_dpi: int, quality: int) -> int:
    """Re-encodes large 8-bit RGB/grey images as JPEG at roughly `max_dpi` for the size they are drawn at."""
    count = 0
    for page in pdf.pages:
        # largest drawn size per image name, from the page's content stream
        drawn: dict[str, tuple[float, float]] = {}
        ctm_stack = [(1.0, 0.0, 0.0, 1.0)]
        for operands, op in pikepdf.parse_content_stream(page):
            name = str(op)
            if name == "q":
                ctm_stack.append(ctm_stack[-1])
            elif name == "Q" and len(ctm_stack) > 1:
                ctm_stack.pop()
            elif name == "cm":
                a, b, c, d = (float(x) for x in operands[:4])
                pa, pb, pc, pd = ctm_stack[-1]
                ctm_stack[-1] = (a * pa + b * pc, a * pb + b * pd, c * pa + d * pc, c * pb + d * pd)
            elif name == "Do":
                a, b, c, d = ctm_stack[-1]
                w, h = (a * a + b * b) ** 0.5, (c * c + d * d) ** 0.5
                key = str(operands[0])
                pw, ph = drawn.get(key, (0.0, 0.0))
                drawn[key] = (max(pw, w), max(ph, h))
        xobjects = page.Resources.get("/XObject", {}) if "/Resources" in page else {}
        for key, (w_pt, h_pt) in drawn.items():
            img = xobjects.get(key)
            if img is None or img.get("/Subtype") != "/Image" or w_pt <= 0 or h_pt <= 0:
                continue
            if "/SMask" in img or "/Mask" in img or img.get("/ImageMask", False) or int(img.get("/BitsPerComponent", 8)) != 8:
                continue
            if img.get("/ColorSpace") not in ("/DeviceRGB", "/DeviceGray"):
                continue
            px_w, px_h = int(img.Width), int(img.Height)
            target_w = max(1, round(w_pt / 72 * max_dpi))
            target_h = max(1, round(h_pt / 72 * max_dpi))
            if px_w <= target_w * 1.25 and px_h <= target_h * 1.25:
                continue  # already close to the target resolution
            try:
                pil = PdfImage(img).as_pil_image()
            except Exception:  # unusual filters/colour spaces: leave as is
                continue
            pil = pil.convert("L" if img.ColorSpace == "/DeviceGray" else "RGB").resize((target_w, target_h), Image.LANCZOS)
            buf = io.BytesIO()
            pil.save(buf, "JPEG", quality=quality, optimize=True)
            data = buf.getvalue()
            if len(data) >= len(img.read_raw_bytes()):
                continue
            img.write(data, filter=pikepdf.Name.DCTDecode)
            img.Width, img.Height = target_w, target_h
            img.ColorSpace = pikepdf.Name.DeviceGray if pil.mode == "L" else pikepdf.Name.DeviceRGB
            for k in ("/DecodeParms", "/Decode"):
                if k in img:
                    del img[k]
            count += 1
    return count


def optimize_pdf(data: bytes, max_image_dpi: int | None = None, jpeg_quality: int = 80) -> tuple[bytes, OptimizeReport]:
    try:
        pdf = pikepdf.open(io.BytesIO(data))
    except pikepdf.PasswordError as exc:
        raise ToolError("The document is password protected.", 422) from exc
    except pikepdf.PdfError as exc:
        raise ToolError("The file could not be read as a PDF.", 422) from exc
    with pdf:
        if _is_signed(pdf):
            raise ToolError("The document is digitally signed; rewriting it would invalidate the signature.", 409)
        report = OptimizeReport(bytes_before=len(data), bytes_after=0, linearized=True)
        if max_image_dpi:
            report.images_downsampled = _downsample(pdf, max_image_dpi, jpeg_quality)
        pdf.remove_unreferenced_resources()
        out = io.BytesIO()
        pdf.save(
            out,
            linearize=True,
            object_stream_mode=pikepdf.ObjectStreamMode.generate,
            compress_streams=True,
            recompress_flate=True,
        )
    result = out.getvalue()
    if len(result) > len(data) and not report.images_downsampled:
        report.notes.append("The optimised file is slightly larger (linearization hints); it still opens faster on the web.")
    report.bytes_after = len(result)
    return result, report


def is_linearized(data: bytes) -> bool:
    with pikepdf.open(io.BytesIO(data)) as pdf:
        return pdf.is_linearized
