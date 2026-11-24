# Server API testing

**For testers and engineers integrating the server.** How to call and check every PDF Studio server endpoint, the expected answers and errors, and the Postman collection.

- Collection: [server-api.postman_collection.json](server-api.postman_collection.json), 29 requests with automatic checks. It is maintained by hand: when you add or change a request, update the test-case table in §4 to match.
- Every expected result below was checked against a running server (version 0.5.0) on 26 October 2026. Re-run the collection for each new server build: the expectations are a specification, not a record of later runs.

## 1. Before you start

1. Start the server (`cd server && ./run.sh`, or your team's server address). `GET /health` must answer.
2. Prepare the sample files. Requests upload files from a `test-kit/` folder; it is **not** included in the repository, so create one next to the collection (`docs/test-kit/`, already git-ignored) with these files. The expected results in §4 assume this content:

   | File | Content |
   |---|---|
   | `convert-test.html` | A simple HTML page with a line of Hindi text and a table |
   | `form.json` | Any JSON file (used as a "wrong type" upload) |
   | `scanned.pdf` | One image-only page with English text containing "brown fox" |
   | `scanned-hindi.pdf` | One image-only page with Hindi text |
   | `redaction.pdf` | 4 text pages; the same made-up name (`Ravi Test-Kumar`) and a 12-digit number on several pages, the name on page 1 inside `[60, 690, 400, 705]`; title and author set in the document properties |
   | `signed.pdf` | The result of API-13 (a PDF signed by this server) |
   | `tampered-signed.pdf` | A copy of `signed.pdf` with one byte changed inside the signed range |
   | `large-300.pdf` | A 300-page text PDF with the word "lighthouse" on page 17 |
   | `report.pdf` | A one-page report exported from LibreOffice, titled "Quarterly report (test kit)", with 2 images (640×400 JPEG, 400×240 PNG with transparency) and 6 embedded subset fonts |
   | `tables.pdf` | A ruled table with merged cells, a table with box borders, a borderless table and two columns of prose (`tables_pdf()` in `server/tests/conftest.py` builds one) |
   | `columns.pdf` | A copy of `mobile/shared/reading-order/columns.pdf` |

   If your files differ, the status codes still apply, but adjust the content checks (page numbers, counts, words).
3. In Postman:
   - *Import* the collection file.
   - Set the collection variable `baseUrl` (default `http://127.0.0.1:8787`).
   - *Settings → General → Working directory* = the `docs` folder. Request files are written as `test-kit/…` relative to it. If Postman says a file is missing, pick it again in the request's *Body* tab.
4. Run one request, or the whole collection with *Run collection*. Each request's *Tests* tab shows what is checked.

## 2. How the API works

- **Requests:** `multipart/form-data`, with the document in the field `file`. Other fields are text: numbers as text, JSON as text, yes/no as `true` / `false` (also `1`/`0`). A yes/no field that is left out takes its documented default.
- **PDF results:** status 200, `Content-Type: application/pdf`, `Content-Disposition: attachment; filename="…"`.
- **Report:** most PDF results carry a header `X-PDFStudio-Report`, a base64-encoded JSON object (ASCII). In Postman's tests: `JSON.parse(atob(pm.response.headers.get('X-PDFStudio-Report')))`. With curl: `curl -D - … | grep -i x-pdfstudio-report | cut -d' ' -f2 | base64 -d`.
- **Errors:** always `{"error": "message"}`:

| Status | When |
|---|---|
| 400 | Bad input: invalid JSON in a field, no redaction regions, OCR language not installed, page that doesn't exist |
| 409 | The action would break a digital signature (`/optimize` on a signed file) |
| 413 | File larger than the server's limit (`maxUploadMb` in `/health`, default 100 MB) |
| 415 | Not a PDF where a PDF is needed; unsupported type for `/convert` |
| 422 | A required field is missing or a value is out of range (`Invalid 'max_image_dpi': …`); unreadable or password-protected PDF |
| 500 | Signing failed unexpectedly (report it) |
| 503 | A required program is not installed on the server (LibreOffice, Tesseract) |
| 504 | Conversion took longer than `PDFSTUDIO_CONVERT_TIMEOUT` |

- **Coordinates** (`rects`, `near`, `box`) are PDF user space: points, origin at the **bottom-left** of the unrotated page. A US Letter page is 612 × 792.
- **CORS:** browsers may call the server only from origins in `PDFSTUDIO_ALLOWED_ORIGINS`. Postman and curl are not browsers, so CORS doesn't stop them; the server must still be behind authentication outside the internal network ([server and deployment](server-and-deployment.md#9-operations)).
- **Nothing is stored:** each request is processed in a temporary folder that is deleted afterwards.

## 3. Endpoints

### `GET /health`

```json
{
  "ok": true, "version": "0.5.0",
  "features": { "convert": true, "ocr": true, "redact": true, "sign": true, "verify": true, "optimize": true, "extract": true },
  "ocrLanguages": ["afr", "…", "eng", "hin", "…"],
  "convertExtensions": [".csv", ".doc", ".docx", "…"],
  "signer": { "subject": "…", "development": true, "timestamping": false },
  "maxUploadMb": 100
}
```

`convert` / `ocr` are `false` when LibreOffice / Tesseract are not installed.

### `POST /convert`

| Field | |
|---|---|
| `file` | `.doc .docx .odt .rtf .txt .xls .xlsx .ods .csv .ppt .pptx .odp .html .svg …` (full list: `convertExtensions` in `/health`) |

Returns the PDF, named after the file. The first conversion after the server starts is slower.

### `POST /ocr`

| Field | |
|---|---|
| `file` | PDF |
| `languages` | Tesseract codes joined by `+`: `eng`, `hin`, `eng+hin`. Default `eng` |
| `pages` | optional JSON array of 0-based page numbers |
| `force` | `true` to also process pages that already have text |

Report: `{"ocrPages": [0], "skippedPages": [1, 2]}`.

### `POST /redact`

| Field | |
|---|---|
| `file` | PDF |
| `regions` | JSON: `[{"page": 0, "rects": [[x1,y1,x2,y2]], "texts": [{"text": "…", "near": [x1,y1,x2,y2]}]}]` |
| `sanitize` | `true` (default): also remove document info, XMP metadata, JavaScript, open actions, attachments |
| `ocr_languages` | optional: recognise the remaining text on redacted pages again, e.g. `eng` |

`texts` entries are found with exact glyph boxes. Only occurrences overlapping `near` are removed, and always whole: a slightly short mark can't leave half a word.

Report: `{"pages": [0], "regions": 1, "annotationsRemoved": 0, "sanitized": ["document info", …], "ocrPages": []}`.

### `POST /sign`

| Field | |
|---|---|
| `file` | PDF (not encrypted) |
| `reason`, `location`, `signer_name`, `contact` | optional text |
| `field_name` | sign this existing empty signature field |
| `page`, `box` | otherwise a new field on `page` (0-based) at `box` `[x1,y1,x2,y2]`; no `box` = invisible signature |
| `image` | optional PNG file: handwritten signature shown in the box |
| `certify` | `true`: certification signature (only form filling allowed afterwards) |

Report: `{"signer": "…", "development": true}`. The signature is PAdES B-B (B-T with `PDFSTUDIO_TSA_URL`), written as an incremental update, so earlier signatures stay valid.

### `POST /verify`

Returns `{"signatures": [...]}`, one entry per signature:

```json
{
  "field": "Signature1", "intact": true, "valid": true, "trusted": true,
  "signer": "Organization: …, Common Name: …", "issuer": "…",
  "signed_at": "2026-10-26T17:20:42+05:30", "timestamped": false,
  "coverage": "ENTIRE_FILE", "modification_level": "NONE", "docmdp_ok": true,
  "summary": "INTACT:TRUSTED,UNTOUCHED", "reason": "Approved", "location": "Head office"
}
```

- **`intact`** is the tamper check: `false` means the signed bytes were changed. A tampered file can still report `valid: true`, which only describes the signature's cryptography and certificate, so always check `intact`.
- `coverage` other than `ENTIRE_FILE` means something was added after signing. `modification_level` says whether that was harmless (form filling, another signature).
- `trusted` is relative to this server: it trusts its own development certificate, Acrobat does not.

### `POST /optimize`

| Field | |
|---|---|
| `file` | PDF (not signed) |
| `max_image_dpi` | optional, 50–600: downsample larger images to about this resolution (JPEG) |
| `jpeg_quality` | optional, 30–95, default 80 |

Report: `{"bytesBefore": …, "bytesAfter": …, "linearized": true, "imagesDownsampled": 0, "notes": []}`. File name `<name>-optimized.pdf`. Signed files: 409.

### `POST /extract`

| Field | |
|---|---|
| `file` | PDF |
| `pages` | optional JSON array of 0-based page numbers; all pages when left out |
| `text` | `true` (default): lines and words with boxes, font and size |
| `tables` | `true`: tables with rows, columns, merged cells and boxes (drawn with lines or not) |
| `order` | `reading` (default): lines in reading order, columns one after another and each table row as one line with tab-separated cells; `drawn`: the order the file draws the text |
| `images` | `true`: embedded images (decoded, full resolution) |
| `image_format` | `png` (default) or `jpeg` |
| `min_image_px` | skip images whose longer side is smaller (default 32) |
| `fonts` | `true`: the fonts used (name, type, embedded, subset, pages) |
| `font_files` | `true` with `format=zip`: also the embedded font programs |
| `format` | `json` (default), `zip` (JSON plus `report-text.txt`, `images/…`, `fonts/…`, `report-tables.xlsx`, `tables/…csv`), `txt` (plain text only) or `xlsx` (tables only, one sheet per table; 422 when there are none) |

JSON answer (`format=json`):

```json
{
  "format": "pdf-studio-extract", "version": 1,
  "units": "PDF points; origin top-left of the page as displayed; box = {x, y, w, h}",
  "pages": [{ "page": 1, "width": 595.3, "height": 841.89, "lines": [
    { "text": "Quarterly report (test kit)", "box": {"x": 56.8, "y": 40.38, "w": 349.95, "h": 27.91},
      "font": "DejaVuSans-Bold", "size": 24.0,
      "words": [{ "text": "Quarterly", "box": {"x": 56.8, "y": 40.38, "w": 115.1, "h": 27.91} }, "…"] }] }],
  "images": [{ "name": "page-001-image-01.png", "page": 1, "pages": [1], "box": {"x": 56.7, "y": 152.8, "w": 240, "h": 150},
               "widthPx": 640, "heightPx": 400, "mime": "image/png" }],
  "tables": [{ "name": "page-001-table-01", "page": 1, "method": "lattice", "box": {"x": 60, "y": 120, "w": 400, "h": 125},
               "rows": 5, "cols": 3, "cells": [{ "row": 0, "col": 0, "rowSpan": 2, "colSpan": 1, "text": "Class", "box": {"…": 0} }, "…"],
               "grid": [["Class", "Fees (INR)", ""], ["", "Term 1", "Term 2"], "…"] }],
  "fonts": [{ "name": "DejaVuSerif", "baseFont": "CAAAAA+DejaVuSerif", "type": "TrueType", "embedded": true,
              "subset": true, "program": "TrueType", "pages": [1], "file": "CAAAAA+DejaVuSerif.ttf" }]
}
```

`pages`, `tables`, `images` and `fonts` appear only when asked for. `method` is `lattice` (found from ruling lines) or `stream` (found from aligned text); a merged cell's text is in its top-left `grid` position, the others are empty. Tables are found the same way as in the web app. The coordinates and the `pages` → `lines` → `words` shape are the same as the web SDK's *Text with positions* export and the iOS / Android `extractTextJson`. Server image files come from the decoded pixels without soft masks (no transparency). Text is read by PDFium, which handles Indic scripts in office-made PDFs better than the browser.

### `GET /certificate.pem`

The current signing certificate (PEM). During development, add it as trusted in Acrobat (*Preferences ▸ Signatures ▸ Identities & Trusted Certificates*) so test signatures show as valid there.

## 4. Test cases

Priority: P1 must pass for every server release; P2 when that endpoint changed; P3 when time allows. Record results in Postman's run report or your own test log.

| ID | Pri | Request | Sends | Expected |
|---|---|---|---|---|
| API-01 | P1 | **Health**<br>`GET /health` | — | 200. `ok: true`, `version: 0.5.0`, `features` has convert, ocr, redact, sign, verify, optimize, extract (true when the tool is installed); `ocrLanguages` includes eng and hin; `maxUploadMb` 100 unless configured. |
| API-02 | P1 | **Convert HTML to PDF**<br>`POST /convert` | `file`=file test-kit/convert-test.html | 200, `application/pdf`, `Content-Disposition` filename convert-test.pdf. Hindi line and table visible when opened. |
| API-03 | P2 | **Convert: unsupported type**<br>`POST /convert` | `file`=file test-kit/form.json | 415, `{"error": "Unsupported file type '.json'."}`. |
| API-04 | P1 | **OCR a scanned page (English)**<br>`POST /ocr` | `file`=file test-kit/scanned.pdf, `languages`=eng | 200, PDF. Report header decodes to `{"ocrPages": [0], "skippedPages": []}`. Searching 'brown fox' in the result finds it. |
| API-05 | P2 | **OCR Hindi + English**<br>`POST /ocr` | `file`=file test-kit/scanned-hindi.pdf, `languages`=hin+eng | 200, PDF; ocrPages [0]. Hindi words on the page are searchable in the result. |
| API-06 | P2 | **OCR: language not installed**<br>`POST /ocr` | `file`=file test-kit/scanned.pdf, `languages`=xxx | 400, error starts `OCR language(s) not installed: xxx. Available: …`. |
| API-07 | P1 | **OCR: not a PDF**<br>`POST /ocr` | `file`=file test-kit/form.json | 415, `{"error": "Not a PDF file."}` (same for every PDF endpoint). |
| API-08 | P2 | **OCR: pages that already have text are skipped**<br>`POST /ocr` | `file`=file test-kit/redaction.pdf, `languages`=eng | 200; ocrPages [], skippedPages [0,1,2,3]. With `force=true` all four are processed. |
| API-09 | P1 | **Redact an area**<br>`POST /redact` | `file`=file test-kit/redaction.pdf, `regions`=[{"page": 0, "rects": [[60, 690, 400, 705]]}] | 200, PDF; report `{"pages": [0], "regions": 1, "annotationsRemoved": 0, "sanitized": [...], "ocrPages": []}`. The name on page 1 can't be found in the result; pages 2–4 unchanged. |
| API-10 | P1 | **Redact exact words everywhere (text targets)**<br>`POST /redact` | `file`=file test-kit/redaction.pdf, `regions`=[{"page": 0, "texts": [{"text": "Ravi Test-Kumar", "near"…, `ocr_languages`=eng | 200; pages [0, 1], ocrPages [0, 1]: the name is gone from pages 1–2 and the rest of those pages is searchable again. |
| API-11 | P2 | **Redact: no regions**<br>`POST /redact` | `file`=file test-kit/redaction.pdf, `regions`=[] | 400, `{"error": "No redaction regions given."}`. |
| API-12 | P2 | **Redact: regions not JSON**<br>`POST /redact` | `file`=file test-kit/redaction.pdf, `regions`={bad | 400, `{"error": "'regions' is not valid JSON."}`. |
| API-13 | P1 | **Sign: visible box**<br>`POST /sign` | `file`=file test-kit/redaction.pdf, `reason`=Approved, `location`=Head office, `page`=0, `box`=[400, 60, 580, 130] | 200, PDF with one signature; report `{"signer": "…", "development": true}` while the development certificate is used. Save the response as a file to use it in API-14. |
| API-14 | P1 | **Verify: intact signature**<br>`POST /verify` | `file`=file test-kit/signed.pdf | 200; one entry: `intact: true`, `valid: true`, `trusted: true` (the server trusts its own development certificate), `coverage: ENTIRE_FILE`, `modification_level: NONE`, `reason: Approved`. |
| API-15 | P1 | **Verify: tampered file**<br>`POST /verify` | `file`=file test-kit/tampered-signed.pdf | 200; `intact: false`, `summary: INVALID`. **Check `intact`**: it is the field that says the signed bytes changed (the web app shows 'altered after signing'). |
| API-16 | P2 | **Optimise for web**<br>`POST /optimize` | `file`=file test-kit/large-300.pdf | 200, PDF; report `{"bytesBefore": …, "bytesAfter": …, "linearized": true, "imagesDownsampled": 0, "notes": [...]}`; filename large-300-optimized.pdf. |
| API-17 | P3 | **Optimise and shrink a scan**<br>`POST /optimize` | `file`=file test-kit/scanned.pdf, `max_image_dpi`=100 | 200; imagesDownsampled 1, bytesAfter < bytesBefore. |
| API-18 | P2 | **Optimise: signed file refused**<br>`POST /optimize` | `file`=file test-kit/signed.pdf | 409, `{"error": "The document is digitally signed; rewriting it would invalidate the signature."}`. |
| API-19 | P3 | **Optimise: value out of range**<br>`POST /optimize` | `file`=file test-kit/scanned.pdf, `max_image_dpi`=5 | 422, `{"error": "Invalid 'max_image_dpi': …"}` (allowed 50–600). |
| API-23 | P1 | **Extract text with positions**<br>`POST /extract` | `file`=file test-kit/report.pdf | 200, JSON `{format: 'pdf-studio-extract', pages: [{page: 1, width: 595.3, height: 841.89, lines: [{text, box, font, size, words: [{text, box}]}]}]}`. First line `Quarterly report (test kit)`, font DejaVuSans-Bold, 24 pt, 4 words, box near the top (y ≈ 40). |
| API-24 | P2 | **Extract images and fonts as ZIP**<br>`POST /extract` | `file`=file test-kit/report.pdf, `images`=true, `fonts`=true, `font_files`=true, `format`=zip | 200, `application/zip`, `report-extracted.zip` containing `report-text.txt`, `report-extract.json` (with `images` and `fonts` lists), `images/page-001-image-01.png` (640×400), `images/page-001-image-02.png` (400×240) and 6 font files in `fonts/`. |
| API-25 | P2 | **Extract plain text**<br>`POST /extract` | `file`=file test-kit/large-300.pdf, `format`=txt, `pages`=[16] | 200, `text/plain`: `===== Page 17 =====` then the page's lines (includes 'lighthouse'). |
| API-26 | P2 | **Extract: page out of range**<br>`POST /extract` | `file`=file test-kit/report.pdf, `pages`=[5] | 400, `{"error": "Page 6 does not exist (the document has 1)."}`. |
| API-28 | P2 | **Extract tables**<br>`POST /extract` | `file`=file test-kit/tables.pdf, `tables`=true, `text`=false | 200, JSON with `tables`: `[{name: 'page-001-table-01', page: 1, method: 'lattice', rows: 5, cols: 3, box, cells: [{row, col, rowSpan, colSpan, text, box}], grid: [['Class', 'Fees (INR)', ''], …]}, …]`: a ruled table (5×3, 'Class' over 2 rows, 'Fees (INR)' over 2 columns), a table with box borders (3×2) and a borderless one (`stream`, 5×4). With `format=xlsx` the same tables come as `tables-tables.xlsx`, one sheet per table; with `format=zip`, also as `tables/page-001-table-0N.csv`. No tables and `format=xlsx`: 422 `No tables found on these pages.` |
| API-29 | P2 | **Extract text in reading order**<br>`POST /extract` | `file`=file test-kit/columns.pdf, `format`=txt | 200, `text/plain`: lines numbered 01 to 16 in order (title, left column, right column, note, three short columns, heading, the marks table with one row per line and tabs between cells, footer last). Send `order`=`drawn` too: the first line is then `16 Page 1 of 1`. |
| API-27 | P2 | **Redact: hidden information removed by default**<br>`POST /redact` | `file`=file test-kit/redaction.pdf, `regions`=[{"page": 0, "rects": [[60, 690, 400, 705]]}] | 200; `sanitize` not sent means true (the default): report `sanitized` includes `document info` (the kit file has a title and author). Regression check for a bug fixed in 0.5.0, where leaving the field out turned cleaning off. |
| API-20 | P3 | **Signing certificate**<br>`GET /certificate.pem` | — | 200, `application/x-pem-file`, starts with `-----BEGIN CERTIFICATE-----`. |
| API-21 | P2 | **CORS: unknown website gets no access**<br>`GET /health` | header `Origin: https://evil.example` | 200 but **no** `Access-Control-Allow-Origin` header, so a browser on that site can't read the answer. With `Origin: http://localhost:5178` the header is present. |
| API-22 | P2 | **Missing file**<br>`POST /ocr` | `languages`=eng | 422, `{"error": "Invalid 'file': Field required"}`. |

## 5. Checks by hand (not automated in Postman)

| ID | Check | Expected |
|---|---|---|
| API-M1 | Open the result of API-09 in a text editor and search for the redacted name | Not found anywhere in the file |
| API-M2 | Open the result of API-13 in Acrobat Reader | Signature panel shows one signature; "validity unknown" with the development certificate (expected) |
| API-M3 | Upload a file larger than `maxUploadMb` | 413, `File is larger than … MB.` |
| API-M4 | Send 3 OCR requests at once to one worker | They run one after another (limit 1 per worker); none fails |
| API-M5 | Stop LibreOffice from being found (`PDFSTUDIO_SOFFICE=/nonexistent`) and call `/convert` | 503, `LibreOffice is not installed on the server.`; `/health` shows `convert: false` |
