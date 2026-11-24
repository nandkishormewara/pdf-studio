"""PDF Studio processing server: conversion, OCR, redaction, digital signatures."""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import re
from typing import Annotated

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response

from . import convert, extract, ocr, optimize, redact, signing
from .config import settings
from .errors import ToolError

log = logging.getLogger("pdfstudio")
app = FastAPI(title="PDF Studio server", version="0.5.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in settings.allowed_origins if o.strip()],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
    expose_headers=["X-PDFStudio-Report", "Content-Disposition"],
)

# Heavy tools are limited so one large job can't starve the machine.
_limits = {
    "convert": asyncio.Semaphore(2),
    "ocr": asyncio.Semaphore(1),
    "redact": asyncio.Semaphore(2),
    "sign": asyncio.Semaphore(4),
    "optimize": asyncio.Semaphore(2),
    "extract": asyncio.Semaphore(2),
}
MAX_BYTES = settings.max_upload_mb * 1024 * 1024
PDF = "application/pdf"


@app.exception_handler(ToolError)
async def tool_error(_: Request, exc: ToolError):
    return JSONResponse({"error": exc.message}, status_code=exc.status)


@app.exception_handler(HTTPException)
async def http_error(_: Request, exc: HTTPException):
    # one error shape for every endpoint: {"error": "message"}
    return JSONResponse({"error": exc.detail if isinstance(exc.detail, str) else json.dumps(exc.detail)}, status_code=exc.status_code)


@app.exception_handler(RequestValidationError)
async def validation_error(_: Request, exc: RequestValidationError):
    first = exc.errors()[0] if exc.errors() else {}
    field = ".".join(str(x) for x in first.get("loc", [])[1:]) or "request"
    return JSONResponse({"error": f"Invalid '{field}': {first.get('msg', 'invalid value')}"}, status_code=422)


async def read_upload(file: UploadFile, expect_pdf: bool = True) -> bytes:
    data = await file.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise HTTPException(413, f"File is larger than {settings.max_upload_mb} MB.")
    if not data:
        raise HTTPException(400, "Empty file.")
    if expect_pdf and not data[:1024].lstrip().startswith(b"%PDF") and b"%PDF" not in data[:1024]:
        raise HTTPException(415, "Not a PDF file.")
    return data


def pdf_response(data: bytes, filename: str, report: dict | None = None) -> Response:
    headers = {"Content-Disposition": f'attachment; filename="{filename}"'}
    if report is not None:
        headers["X-PDFStudio-Report"] = base64.b64encode(json.dumps(report).encode()).decode()
    return Response(data, media_type=PDF, headers=headers)


def flag(value: str | None, default: bool) -> bool:
    """Boolean form field with a real default. FastAPI turns a *missing* bool form field into False even when the
    parameter defaults to True, so fields that default to true are read as text and parsed here."""
    if value is None or value == "":
        return default
    v = value.strip().lower()
    if v in ("true", "1", "yes", "on"):
        return True
    if v in ("false", "0", "no", "off"):
        return False
    raise HTTPException(422, f"Expected true or false, got '{value}'.")


def parse_json(value: str | None, name: str):
    if not value:
        return None
    try:
        return json.loads(value)
    except json.JSONDecodeError as exc:
        raise HTTPException(400, f"'{name}' is not valid JSON.") from exc


# ------------------------------------------------------------------ routes

@app.get("/health")
async def health():
    info = signing.get_signer()
    return {
        "ok": True,
        "version": app.version,
        "features": {
            "convert": settings.soffice is not None,
            "ocr": settings.tesseract is not None,
            "redact": True,
            "sign": True,
            "verify": True,
            "optimize": True,
            "extract": True,
        },
        "ocrLanguages": ocr.available_languages(),
        "convertExtensions": sorted(convert.SUPPORTED),
        "signer": {"subject": info.subject, "development": info.development, "timestamping": bool(settings.tsa_url)},
        "maxUploadMb": settings.max_upload_mb,
    }


@app.post("/convert")
async def convert_route(file: Annotated[UploadFile, File()]):
    data = await read_upload(file, expect_pdf=False)
    async with _limits["convert"]:
        pdf = await run_in_threadpool(convert.convert_to_pdf, data, file.filename or "document")
    stem = (file.filename or "document").rsplit(".", 1)[0]
    return pdf_response(pdf, f"{stem}.pdf")


@app.post("/ocr")
async def ocr_route(
    file: Annotated[UploadFile, File()],
    languages: Annotated[str, Form()] = "eng",
    pages: Annotated[str | None, Form()] = None,
    force: Annotated[bool, Form()] = False,
):
    data = await read_upload(file)
    langs = [lang for lang in languages.replace(",", "+").split("+") if lang]
    page_list = parse_json(pages, "pages")
    async with _limits["ocr"]:
        result = await run_in_threadpool(ocr.ocr_pdf, data, langs, page_list, force)
    return pdf_response(result.pdf, "ocr.pdf", {"ocrPages": result.pages_ocrd, "skippedPages": result.pages_skipped})


@app.post("/redact")
async def redact_route(
    file: Annotated[UploadFile, File()],
    regions: Annotated[str, Form(description='JSON: [{"page": 0, "rects": [[x1,y1,x2,y2], ...], "texts": [{"text": "…", "near": [x1,y1,x2,y2]}]}] in PDF user space')],
    sanitize: Annotated[str | None, Form(description="true (default) or false")] = None,
    ocr_languages: Annotated[str | None, Form()] = None,
):
    data = await read_upload(file)
    spec = parse_json(regions, "regions") or []
    by_page: dict[int, list[tuple[float, float, float, float]]] = {}
    texts: dict[int, list[redact.TextTarget]] = {}
    try:
        for item in spec:
            by_page.setdefault(int(item["page"]), []).extend(tuple(map(float, r))[:4] for r in item.get("rects", []))
            for t in item.get("texts", []):
                texts.setdefault(int(item["page"]), []).append(redact.TextTarget(str(t["text"]), tuple(map(float, t["near"]))[:4]))
    except (KeyError, TypeError, ValueError) as exc:
        raise HTTPException(400, "Invalid 'regions'.") from exc
    if not any(by_page.values()) and not texts:
        raise HTTPException(400, "No redaction regions given.")
    langs = [lang for lang in (ocr_languages or "").replace(",", "+").split("+") if lang] or None
    async with _limits["redact"]:
        pdf, report = await run_in_threadpool(redact.redact_pdf, data, by_page, texts=texts, sanitize=flag(sanitize, True), ocr_languages=langs)
    return pdf_response(pdf, "redacted.pdf", {
        "pages": report.pages, "regions": report.regions, "annotationsRemoved": report.annotations_removed,
        "sanitized": report.sanitized, "ocrPages": report.ocr_pages,
    })


@app.post("/sign")
async def sign_route(
    file: Annotated[UploadFile, File()],
    reason: Annotated[str | None, Form()] = None,
    location: Annotated[str | None, Form()] = None,
    signer_name: Annotated[str | None, Form()] = None,
    contact: Annotated[str | None, Form()] = None,
    field_name: Annotated[str | None, Form()] = None,
    page: Annotated[int, Form()] = 0,
    box: Annotated[str | None, Form(description="JSON [x1,y1,x2,y2] in PDF user space; omit for invisible")] = None,
    certify: Annotated[bool, Form()] = False,
    image: Annotated[UploadFile | None, File()] = None,
):
    data = await read_upload(file)
    box_val = parse_json(box, "box")
    req = signing.SignRequest(
        reason=reason, location=location, signer_name=signer_name, contact=contact,
        field_name=field_name or None, page=page,
        box=tuple(map(float, box_val))[:4] if box_val else None,
        image_png=(await image.read()) if image is not None else None,
        certify=certify,
    )
    async with _limits["sign"]:
        signed = await run_in_threadpool(signing.sign_pdf, data, req)
    info = signing.get_signer()
    return pdf_response(signed, "signed.pdf", {"signer": info.subject, "development": info.development})


@app.post("/verify")
async def verify_route(file: Annotated[UploadFile, File()]):
    data = await read_upload(file)
    async with _limits["sign"]:
        results = await run_in_threadpool(signing.verify_pdf, data)
    return {"signatures": results}


@app.post("/optimize")
async def optimize_route(
    file: Annotated[UploadFile, File()],
    max_image_dpi: Annotated[int | None, Form(ge=50, le=600, description="Downsample larger images to about this resolution; omit to keep images")] = None,
    jpeg_quality: Annotated[int, Form(ge=30, le=95)] = 80,
):
    """Linearizes (fast web view) and recompresses; optionally downsamples images."""
    data = await read_upload(file)
    async with _limits["optimize"]:
        pdf, rep = await run_in_threadpool(optimize.optimize_pdf, data, max_image_dpi, jpeg_quality)
    stem = (file.filename or "document").rsplit(".", 1)[0]
    return pdf_response(pdf, f"{stem}-optimized.pdf", {
        "bytesBefore": rep.bytes_before, "bytesAfter": rep.bytes_after, "linearized": rep.linearized,
        "imagesDownsampled": rep.images_downsampled, "notes": rep.notes,
    })


@app.post("/extract")
async def extract_route(
    file: Annotated[UploadFile, File()],
    pages: Annotated[str | None, Form(description="JSON array of 0-based page numbers; omit for all pages")] = None,
    text: Annotated[str | None, Form(description="true (default) or false")] = None,
    tables: Annotated[bool, Form(description="find tables (with or without ruling lines)")] = False,
    order: Annotated[str, Form(pattern="^(reading|drawn)$", description="reading (default): columns one after another, table rows on one line; drawn: as the file draws the text")] = "reading",
    images: Annotated[bool, Form()] = False,
    image_format: Annotated[str, Form(pattern="^(png|jpeg)$")] = "png",
    min_image_px: Annotated[int, Form(ge=0, le=10000)] = 32,
    fonts: Annotated[bool, Form()] = False,
    font_files: Annotated[bool, Form()] = False,
    format: Annotated[str, Form(pattern="^(json|zip|txt|xlsx)$", description="json: text, tables, image list and fonts; zip: also the image, font and table files; txt: plain text; xlsx: the tables as an Excel workbook")] = "json",
):
    """Text with positions, tables, embedded images and fonts. Coordinates as in the web SDK."""
    data = await read_upload(file)
    page_list = parse_json(pages, "pages")
    if page_list is not None and (not isinstance(page_list, list) or not all(isinstance(p, int) for p in page_list)):
        raise HTTPException(400, "'pages' must be a JSON array of page numbers.")
    text = flag(text, True)
    if format == "txt":
        text, tables, images, fonts = True, False, False, False
    if format == "xlsx":
        text, tables, images, fonts = False, True, False, False
    if not (text or tables or images or fonts):
        raise HTTPException(400, "Nothing to extract: set text, tables, images or fonts.")
    opts = extract.Options(pages=page_list, text=text, tables=tables, order=order, images=images, image_format=image_format, min_image_px=min_image_px,
                           fonts=fonts, font_files=font_files and format == "zip")
    async with _limits["extract"]:
        result = await run_in_threadpool(extract.extract, data, opts)
    stem = re.sub(r"[^\w.-]", "_", (file.filename or "document").rsplit(".", 1)[0]) or "document"
    if format == "txt":
        return Response(extract.plain_text(result), media_type="text/plain; charset=utf-8",
                        headers={"Content-Disposition": f'attachment; filename="{stem}-text.txt"'})
    if format == "xlsx":
        if not result.tables:
            raise HTTPException(422, "No tables found on these pages.")
        blob = await run_in_threadpool(extract.tables_xlsx, result)
        return Response(blob, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                        headers={"Content-Disposition": f'attachment; filename="{stem}-tables.xlsx"'})
    if format == "zip":
        blob = await run_in_threadpool(extract.as_zip, result, opts, stem)
        return Response(blob, media_type="application/zip", headers={"Content-Disposition": f'attachment; filename="{stem}-extracted.zip"'})
    return extract.as_json(result, opts)


@app.get("/certificate.pem")
async def certificate():
    """The server's signing certificate, e.g. to add it as trusted in Acrobat during development."""
    return Response(signing.certificate_pem(), media_type="application/x-pem-file",
                    headers={"Content-Disposition": 'attachment; filename="pdf-studio-signer.pem"'})
