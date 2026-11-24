"""Runtime settings, read from environment variables (see server/README.md)."""
from __future__ import annotations

import os
import shutil
from dataclasses import dataclass, field
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("PDFSTUDIO_DATA_DIR", BASE_DIR / "data"))


def _find_soffice() -> str | None:
    explicit = os.environ.get("PDFSTUDIO_SOFFICE")
    if explicit:  # a wrong path must show as "convert: false" in /health, not fail later
        return explicit if Path(explicit).exists() else None
    for candidate in (
        shutil.which("soffice"),
        shutil.which("libreoffice"),
        "/Applications/LibreOffice.app/Contents/MacOS/soffice",
        "/usr/lib/libreoffice/program/soffice",
        "C:/Program Files/LibreOffice/program/soffice.exe",
    ):
        if candidate and Path(candidate).exists():
            return candidate
    return None


@dataclass(frozen=True)
class Settings:
    allowed_origins: list[str] = field(default_factory=lambda: os.environ.get(
        "PDFSTUDIO_ALLOWED_ORIGINS",
        "http://localhost:5173,http://localhost:5178,http://127.0.0.1:5173",
    ).split(","))
    max_upload_mb: int = int(os.environ.get("PDFSTUDIO_MAX_UPLOAD_MB", "100"))
    soffice: str | None = _find_soffice()
    tesseract: str | None = os.environ.get("PDFSTUDIO_TESSERACT") or shutil.which("tesseract")
    convert_timeout_s: int = int(os.environ.get("PDFSTUDIO_CONVERT_TIMEOUT", "180"))
    ocr_dpi: int = int(os.environ.get("PDFSTUDIO_OCR_DPI", "300"))
    redact_dpi: int = int(os.environ.get("PDFSTUDIO_REDACT_DPI", "200"))
    # Signing: a PKCS#12 file (.p12/.pfx) with the organisation's certificate and key.
    # Without one, a self-signed development certificate is generated in DATA_DIR.
    sign_p12: str | None = os.environ.get("PDFSTUDIO_SIGN_P12")
    sign_p12_password: str = os.environ.get("PDFSTUDIO_SIGN_P12_PASSWORD", "")
    # Optional RFC 3161 timestamp authority -> PAdES B-T instead of B-B.
    tsa_url: str | None = os.environ.get("PDFSTUDIO_TSA_URL") or None
    # Extra PEM bundle of trusted roots used when verifying signatures.
    trust_roots_pem: str | None = os.environ.get("PDFSTUDIO_TRUST_ROOTS") or None
    workers: int = max(1, (os.cpu_count() or 2) // 2)


settings = Settings()
