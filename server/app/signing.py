"""
PAdES digital signatures (pyHanko, MIT) and signature verification.

Signing always appends an incremental update, so earlier signatures in the file stay valid.
Certificate: PDFSTUDIO_SIGN_P12 (+ _PASSWORD). Without it, a self-signed *development*
certificate is created in DATA_DIR. Documents signed with it show as "not trusted" in Acrobat;
that is expected until a certificate from a trusted CA (or the organisation's AATL / eSign
provider) is configured.
"""
from __future__ import annotations

import datetime as dt
import io
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.serialization import pkcs12
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID
from PIL import Image
from pyhanko import stamp
from pyhanko.pdf_utils import images
from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter
from pyhanko.pdf_utils.reader import PdfFileReader
from pyhanko.pdf_utils.font.basic import SimpleFontEngineFactory
from pyhanko.pdf_utils.text import TextBoxStyle
from pyhanko.sign import fields, signers, timestamps
from pyhanko.sign.validation import validate_pdf_signature
from pyhanko_certvalidator import ValidationContext

from .config import DATA_DIR, settings
from .errors import ToolError

DEV_P12 = DATA_DIR / "dev-signer.p12"
DEV_PASSWORD = b"pdf-studio-dev"


# ------------------------------------------------------------------ certificates

def _create_dev_certificate() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([
        x509.NameAttribute(NameOID.COMMON_NAME, "PDF Studio Development Signer"),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "PDF Studio (development only)"),
    ])
    now = dt.datetime.now(dt.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name).issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - dt.timedelta(days=1))
        .not_valid_after(now + dt.timedelta(days=3650))
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.KeyUsage(
            digital_signature=True, content_commitment=True, key_encipherment=False, data_encipherment=False,
            key_agreement=False, key_cert_sign=False, crl_sign=False, encipher_only=False, decipher_only=False,
        ), critical=True)
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.EMAIL_PROTECTION]), critical=False)
        .sign(key, hashes.SHA256())
    )
    blob = pkcs12.serialize_key_and_certificates(
        b"pdf-studio-dev", key, cert, None, serialization.BestAvailableEncryption(DEV_PASSWORD),
    )
    DEV_P12.write_bytes(blob)


@dataclass
class SignerInfo:
    signer: signers.SimpleSigner
    development: bool
    subject: str


@lru_cache(maxsize=1)
def get_signer() -> SignerInfo:
    if settings.sign_p12:
        path, password, dev = Path(settings.sign_p12), settings.sign_p12_password.encode(), False
    else:
        if not DEV_P12.exists():
            _create_dev_certificate()
        path, password, dev = DEV_P12, DEV_PASSWORD, True
    signer = signers.SimpleSigner.load_pkcs12(pfx_file=str(path), passphrase=password)
    if signer is None:
        raise ToolError("Could not load the signing certificate (check PDFSTUDIO_SIGN_P12 and its password).", status=500)
    return SignerInfo(signer, dev, signer.signing_cert.subject.human_friendly)


def certificate_pem() -> bytes:
    cert = get_signer().signer.signing_cert
    return x509.load_der_x509_certificate(cert.dump()).public_bytes(serialization.Encoding.PEM)


# ------------------------------------------------------------------ signing

@dataclass
class SignRequest:
    reason: str | None = None
    location: str | None = None
    signer_name: str | None = None
    contact: str | None = None
    field_name: str | None = None  # sign an existing empty signature field
    page: int = 0  # for a new visible field
    box: tuple[float, float, float, float] | None = None  # PDF user space; None = invisible
    image_png: bytes | None = None  # handwritten signature shown in the box
    certify: bool = False  # certification signature (locks the document, allows form filling)


def sign_pdf(data: bytes, req: SignRequest) -> bytes:
    info = get_signer()
    try:
        writer = IncrementalPdfFileWriter(io.BytesIO(data), strict=False)
    except Exception as exc:  # noqa: BLE001
        raise ToolError(f"Could not read the PDF: {exc}") from exc
    if writer.security_handler is not None:
        raise ToolError("Encrypted PDFs can't be signed yet.")

    existing = {name for name, *_ in fields.enumerate_sig_fields(writer.prev, filled_status=None)}
    field_name = req.field_name
    if field_name:
        empties = {name for name, *_ in fields.enumerate_sig_fields(writer.prev, filled_status=False)}
        if field_name not in empties:
            raise ToolError(f"There is no empty signature field named '{field_name}'.")
    else:
        n = 1
        while f"Signature{n}" in existing:
            n += 1
        field_name = f"Signature{n}"
        page_count = int(writer.root["/Pages"]["/Count"])
        if not 0 <= req.page < page_count:
            raise ToolError(f"Page {req.page + 1} does not exist.")
        box = None
        if req.box:
            x1, y1, x2, y2 = req.box
            box = (min(x1, x2), min(y1, y2), max(x1, x2), max(y1, y2))
        fields.append_signature_field(writer, fields.SigFieldSpec(sig_field_name=field_name, on_page=req.page, box=box))

    meta = signers.PdfSignatureMetadata(
        field_name=field_name,
        reason=req.reason or None,
        location=req.location or None,
        name=req.signer_name or None,
        contact_info=req.contact or None,
        md_algorithm="sha256",
        subfilter=fields.SigSeedSubFilter.PADES,
        certify=req.certify,
        app_build_props=None,
    )
    timestamper = timestamps.HTTPTimeStamper(settings.tsa_url) if settings.tsa_url else None

    lines = ["Digitally signed by %(signer)s", "Date: %(ts)s"]
    if req.reason:
        lines.append(f"Reason: {req.reason}")
    if req.location:
        lines.append(f"Location: {req.location}")
    background = None
    if req.image_png:
        try:
            img = Image.open(io.BytesIO(req.image_png)).convert("RGBA")
            background = images.PdfImage(img)
        except Exception as exc:  # noqa: BLE001
            raise ToolError(f"Signature image could not be read: {exc}") from exc
    style = stamp.TextStampStyle(
        stamp_text="\n".join(lines),
        text_box_style=TextBoxStyle(font=SimpleFontEngineFactory("Helvetica", avg_width=0.5), font_size=7),
        background=background,
        background_opacity=1.0,
        border_width=1,
        timestamp_format="%Y-%m-%d %H:%M %Z",
    )
    pdf_signer = signers.PdfSigner(meta, signer=info.signer, timestamper=timestamper, stamp_style=style)
    try:
        out = pdf_signer.sign_pdf(writer)
    except Exception as exc:  # noqa: BLE001
        raise ToolError(f"Signing failed: {exc}", status=500) from exc
    return out.getvalue()


# ------------------------------------------------------------------ verification

def _validation_context() -> ValidationContext:
    roots = [get_signer().signer.signing_cert]  # our own (dev or org) certificate
    if settings.trust_roots_pem:
        roots += list(_load_pem_bundle(settings.trust_roots_pem))
    return ValidationContext(trust_roots=roots, allow_fetching=False)


def _load_pem_bundle(path: str):
    from asn1crypto import pem, x509 as asn1_x509

    data = Path(path).read_bytes()
    for _, _, der in pem.unarmor(data, multiple=True):
        yield asn1_x509.Certificate.load(der)


def verify_pdf(data: bytes) -> list[dict]:
    try:
        reader = PdfFileReader(io.BytesIO(data), strict=False)
    except Exception as exc:  # noqa: BLE001
        raise ToolError(f"Could not read the PDF: {exc}") from exc
    vc = _validation_context()
    results = []
    for sig in reader.embedded_signatures:
        entry: dict = {"field": sig.field_name}
        try:
            status = validate_pdf_signature(sig, vc)
            cert = status.signing_cert
            entry.update(
                intact=bool(status.intact),
                valid=bool(status.valid),
                trusted=bool(status.trusted),
                signer=cert.subject.human_friendly if cert else None,
                issuer=cert.issuer.human_friendly if cert else None,
                signed_at=(status.signer_reported_dt.isoformat() if status.signer_reported_dt else None),
                timestamped=status.timestamp_validity is not None,
                coverage=status.coverage.name if status.coverage else None,
                modification_level=status.modification_level.name if status.modification_level else None,
                docmdp_ok=status.docmdp_ok,
                summary=status.summary(),
                reason=sig.sig_object.get("/Reason"),
                location=sig.sig_object.get("/Location"),
            )
        except Exception as exc:  # noqa: BLE001
            entry.update(intact=False, valid=False, trusted=False, error=str(exc))
        for k in ("reason", "location"):
            if entry.get(k) is not None:
                entry[k] = str(entry[k])
        results.append(entry)
    return results
