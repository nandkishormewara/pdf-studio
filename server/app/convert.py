"""Office / text / image documents -> PDF using LibreOffice in headless mode."""
from __future__ import annotations

import subprocess
import tempfile
import uuid
from pathlib import Path

from .config import settings
from .errors import ToolError, ToolUnavailable

SUPPORTED = {
    # word processing
    ".doc", ".docx", ".docm", ".dot", ".dotx", ".odt", ".ott", ".rtf", ".txt", ".wpd", ".pages",
    # spreadsheets
    ".xls", ".xlsx", ".xlsm", ".ods", ".csv",
    # presentations
    ".ppt", ".pptx", ".pps", ".ppsx", ".odp", ".key",
    # drawings / other
    ".odg", ".vsd", ".vsdx", ".html", ".htm", ".xml", ".svg",
}


def convert_to_pdf(data: bytes, filename: str) -> bytes:
    if not settings.soffice:
        raise ToolUnavailable("LibreOffice is not installed on the server.")
    ext = Path(filename).suffix.lower()
    if ext not in SUPPORTED:
        raise ToolError(f"Unsupported file type '{ext or filename}'.", status=415)

    with tempfile.TemporaryDirectory(prefix="pdfstudio-convert-") as tmp:
        tmpdir = Path(tmp)
        src = tmpdir / f"input{ext}"
        src.write_bytes(data)
        out_dir = tmpdir / "out"
        out_dir.mkdir()
        # A private profile per call: LibreOffice refuses to run twice on one profile.
        profile = (tmpdir / f"profile-{uuid.uuid4().hex}").as_uri()
        cmd = [
            settings.soffice, "--headless", "--norestore", "--nolockcheck", "--nodefault", "--nologo",
            f"-env:UserInstallation={profile}",
            "--convert-to", "pdf", "--outdir", str(out_dir), str(src),
        ]
        try:
            proc = subprocess.run(cmd, capture_output=True, timeout=settings.convert_timeout_s, check=False)
        except subprocess.TimeoutExpired as exc:
            raise ToolError("Conversion timed out.", status=504) from exc
        result = out_dir / "input.pdf"
        if proc.returncode != 0 or not result.exists():
            detail = (proc.stderr or proc.stdout).decode(errors="replace").strip()[-500:]
            raise ToolError(f"LibreOffice could not convert this file. {detail}".strip(), status=422)
        return result.read_bytes()
