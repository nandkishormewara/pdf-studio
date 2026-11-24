# Product and features

**For everyone:** product owners, developers evaluating the toolkit, contributors, testers. What PDF Studio is, what it does on each platform today, and what is not built.

Status words used in this document:

| Word | Meaning |
|---|---|
| **Built** | Works today and is covered by automated tests or a recorded manual check. |
| **Partly built** | Works, with a stated limitation. |
| **Not built** | Does not exist yet. Listed so nobody assumes it does. |

## 1. What PDF Studio is

PDF Studio is an open-source PDF toolkit for viewing, annotating, filling, organising and processing PDFs on the web, iOS and Android, with an optional processing server. It can be embedded in your own apps, and it can replace Apryse / PDFTron (WebViewer, the iOS and Android SDKs, and the server features) in apps that use them today: see [Migrating from PDFTron / Apryse](migrating-from-pdftron.md). It is built only from permissively licensed open-source parts (PDF.js, pdf-lib, Apple PDFKit, PdfBox-Android, Tesseract, LibreOffice, pyHanko and others), so there is no licence fee and no licence key.

It has five parts:

| Part | Folder | What it is |
|---|---|---|
| **Web app and web SDK** | `web/` | Runs in the browser. Viewing, search, annotation, forms, measurement, pages, saving. Files stay on the user's device. |
| **Server** (optional) | `server/` | A small Python service for what browsers can't do: Office → PDF, OCR, true redaction, digital signatures, web optimisation. |
| **iOS SDK** | `mobile/ios/PDFStudioKit` | Swift package on Apple PDFKit, with a viewer and an editor (SwiftUI). |
| **Android SDK** | `mobile/android/pdfstudio` | Kotlin library on PdfBox-Android and Android's PdfRenderer, with a viewer. |
| **React viewer component** | `packages/react-viewer` | `@pdf-studio/react-viewer`: a React viewer / annotator with a WebViewer-style API (props and handle), for apps moving off `@pdftron/webviewer`. |

All parts use the same annotation data (JSON and XFDF) and the same coordinate system. So marks made on the web open correctly on iPhone and Android, and the reverse. Shared test files in `mobile/shared/` prove this on every platform.

## 2. Who uses it

| User | Typical use |
|---|---|
| **Reviewers (e.g. teachers checking answer sheets)** | Mark up documents: tick, cross, freehand, stamps, scores in text boxes, comments. Marks can be stored as XFDF in your own backend. |
| **Readers (e.g. students)** | Read material; see a reviewer's marks on a checked copy; highlight. |
| **Office staff** | Fill and sign forms, merge and reorder pages, remove private details (redaction), make scans searchable, convert Word / Excel files. |
| **Developers** | Embed the viewer in their own apps (web, iOS, Android) through the SDKs, or replace an Apryse / PDFTron integration. |

## 3. Features by platform

✅ built · ◐ partly built · — not built

| Feature | Web | iOS | Android | Notes |
|---|---|---|---|---|
| Open PDF, password PDFs | ✅ | ✅ | ✅ | |
| Images → PDF | ✅ | — | ✅ | |
| Office files → PDF | ✅ server | ◐ server | ◐ server | Mobile apps call the server's `/convert` |
| Open large files from a link, page by page | ✅ | — | — | Byte-range loading; see §5 |
| Zoom, fit width / page, thumbnails | ✅ | ✅ | ✅ | |
| Reading modes: continuous, single, two-page, cover, right-to-left order | ✅ | ◐ | — | iOS uses PDFKit's display modes |
| Screen languages: English, Hindi, Arabic (RTL), Malay | ✅ | — | — | Mobile screens use the host app's strings |
| Layers (optional content): show / hide, headings, radio groups, remembered, saved into downloads, print matches screen | ✅ | — | — | PDFKit and Android's PdfRenderer have no layer control; mobile shows each file's default layers |
| Search (case, whole word, regex, phrases across lines) | ✅ | ✅ | ✅ | Android: case-insensitive whole-document search |
| Highlight / underline / strikeout | ✅ | ✅ | ✅ | Android: long-press-drag selection |
| Squiggly, cloud, polygon / polyline (from Apryse XFDF) | ◐ | ◐ | ◐ | Imported and shown; the React viewer package also draws them |
| Text box, sticky note, freehand, rectangle, ellipse, line, arrow | ✅ | ✅ | ✅ | Android: tap a mark to comment on it or delete it; undo covers every change |
| Rich text in text boxes (bold, italic, underline, colour) | ✅ | ◐ | ◐ | Mobile shows the plain text; styling is kept in the file |
| Stamps (incl. Hindi स्वीकृत), signature picture | ✅ | ✅ | ◐ | |
| Comments, review status, author | ✅ | ✅ | ✅ | |
| Measurement: distance, perimeter, area, scale, calibration | ✅ | ◐ | — | iOS shows and keeps them; created only on the web |
| Forms: fill, JSON in / out, reset, flatten | ✅ | ◐ | ◐ | iOS: PDFKit form filling. Android: fill text, checkbox, radio and choice fields (viewer Form sheet or `PdfStudio.fillForm`), flatten from the API |
| Pages: rotate, delete, reorder, insert, merge, extract | ✅ | — | — | |
| Save editable (Acrobat-compatible) / flattened | ✅ | ✅ | ✅ | |
| XFDF import / export (Apryse dialect incl. add / modify / delete) | ✅ | ✅ | ✅ | |
| Print | ✅ | ✅ (system) | ✅ (system) | |
| Autosave per document | ✅ | — | — | Browser storage; apps save through the host app |
| Keyboard use and screen readers | ✅ | ◐ | ◐ | Web audited with axe-core; mobile relies on PDFKit / Compose defaults |
| OCR (160+ languages) | ✅ server | — | — | |
| True redaction | ✅ server | ◐ | — | iOS can draw redaction marks; applying them (server) is done from the web |
| Digital signatures (PAdES): sign, verify, tamper detection | ✅ server | — | — | |
| Optimise for web (linearize, shrink images) | ✅ server | — | — | |
| Extract text: plain, lines and words with positions and fonts (JSON), word table (CSV) | ✅ (+ server) | ✅ | ✅ | Same JSON on every platform; positions in page units |
| Reading order: columns one after another, right-to-left pages, table rows as tab-separated lines | ✅ (+ server) | ✅ | ✅ | Same rules and order on every platform; mobile finds tables without ruling lines only |
| Extract tables (with or without lines, merged cells) to Excel, CSV or JSON | ✅ (+ server) | — | — | Mobile apps can call the server's `/extract` |
| Extract embedded images (PNG / JPEG, with where each is drawn) | ✅ (+ server) | — | — | Mobile apps can call the server's `/extract` |
| List fonts (type, embedded, subset, pages) and export embedded font files | ✅ (+ server) | — | — | Font files are usually licensed (see §6) |

## 4. How the main things work, in plain words

- **Annotations are real PDF annotations.** Saved files open with their marks in Acrobat, Chrome, Edge, Firefox and macOS Preview. PDF Studio also stores its own copy inside each annotation, so reopening in PDF Studio gives back exactly what was drawn.
- **Annotations already in a file become editable** when it is opened, whether they were made in Acrobat, Chrome, Preview, Apryse or PDF Studio.
- **Hindi and other scripts** are typed and shown correctly everywhere. In a saved file, non-Latin text in annotations is stored as a sharp picture of the text. It prints and displays correctly, but can't be selected (see §6).
- **Rich text** in text boxes is saved in the same format Acrobat and Apryse use (`/RC` in the PDF, `contents-richtext` in XFDF).
- **Redaction removes content.** Every page with a redaction mark is rebuilt as an image with the marked area painted out. The page's text, fonts and drawings are deleted from the file. Annotations and form fields under a mark are removed. Hidden information (title, author, metadata, scripts, attachments) can also be removed. Remaining text can be recognised again so the page stays searchable.
- **Digital signatures** are PAdES (the European / Adobe standard for PDF signatures), made with the server's certificate. Until the organisation's own certificate is installed, the server uses a *development certificate*, which other readers show as "not trusted" ([server and deployment](server-and-deployment.md#7-signing-certificates)).
- **Without the server**, everything except the Tools menu and Office files works, and files never leave the device.

## 5. Large files

- Files opened **from a link** (`?file=` in the address or *Open from link…*) are fetched in 256 KB pieces as pages are needed. The first page appears before the rest has downloaded, and a percentage shows the background download. Saving, page changes and server tools wait for the full file; drawing does not.
  *Measured:* a 287 MB, 300-page file showed page 1 about 1.4 s after navigation (local dev server, same machine). Network speed changes this. No measurement over a real network has been made yet.
- Links are allowed from the app's own website and from origins listed in `VITE_PDFSTUDIO_FILE_ORIGINS` ([server and deployment](server-and-deployment.md#2-the-web-app)). Other links are refused.
- **Local files** without editable annotations are no longer parsed twice, so large local files open faster.
- The server's **Optimise for web** writes a *linearized* copy, with the first page at the front of the file. Over slow connections, page 1 then appears sooner. On the local dev server no difference was measurable.

## 5a. Extraction

*Save ▸ Extract text, tables, images and fonts…* runs in the browser. The file doesn't leave the device.

- **Text** as plain text (with page headings), as JSON with every line and word, its box, font and size, or as a word table for Excel (CSV, UTF-8, safe against spreadsheet formulas).
- **Reading order** (on by default): text comes out the way a person reads the page, not the order the file happens
  to draw it. A title first, then each column top to bottom, then a full-width note, then the next set of columns,
  with the footer last. Right-to-left pages (Arabic, Urdu, Hebrew) start from the right-hand column. A table's rows come out
  as one line each, cells separated by tabs (paste into Excel and the columns line up). Switch it off to get the
  file's own order. The web, the server, iOS and Android use the same rules and give the same order.
- **Tables** as an Excel workbook (one sheet per table, merged cells kept), as CSV files (one per table) or as JSON
  (rows, columns, each cell's text, span and box). Tables drawn with lines are read from the lines, including merged
  cells; tables without lines are found from text that lines up in columns. Two columns of running text are not taken
  for a table.
- **Images** as they are stored in the file (full resolution), PNG or JPEG, with a JSON index saying where each is drawn. The same picture on many pages (a logo) is exported once.
- **Fonts:** a list (name, type, embedded or not, subset, pages), and optionally the embedded font programs (`.ttf`, `.otf`, `.cff`, `.pfa`).
- One text file downloads as is; anything more comes as one ZIP.
- The same is available without a browser from the server (`POST /extract`, see [API testing](api-testing.md#post-extract); tables also as `format=xlsx`) and, for text, from the iOS and Android SDKs. All of them use the same JSON and coordinates.

Reading order was checked on `mobile/shared/reading-order/columns.pdf` (a newsletter drawn footer first, two columns line by line and three columns right to left): the web, the server, iPhone (PDFKit) and Android (PdfBox, on the emulator) all give lines 01 to 16 in order (3 Nov 2026). On the 300-page file the server takes 0.25 s with reading order and 0.29 s without.

Tables were checked on the server tests' `tables.pdf` (`tables_pdf()` in `server/tests/conftest.py`) (a ruled table with merged cells, one with box borders, one without lines, and two columns of prose) and on a timetable exported by LibreOffice with merged cells: the browser and the server give the same rows, columns and merged cells (3 Nov 2026).

Measured on test files (26 Oct 2026, Mac): text from the 300-page file in 0.5 s in the browser and 0.14 s on the server; a LibreOffice report gave its 2 images (640×400, 400×240) and 6 embedded fonts, identical on both.

## 6. Known limitations (partly built)

| Area | Limitation | Possible fix |
|---|---|---|
| Non-Latin text in saved annotations | Saved as a picture, not selectable or searchable | Embed a font subset with HarfBuzz shaping |
| Non-Latin form values | Saved correctly but drawn by the reader (`NeedAppearances`); such forms can't be flattened | Same |
| Encrypted PDFs | View, annotate and print only; no saving, redaction or signing | Decrypt on the server with the owner's password |
| Editing a signed PDF | Saving rewrites the file and breaks earlier signatures (the app warns) | Incremental save of annotations |
| Redacted pages | Become 200 dpi images (other pages untouched) | Vector-preserving glyph removal |
| Signing certificate | Development certificate until an organisation one is configured | Install an AATL / eSign certificate ([server and deployment](server-and-deployment.md#7-signing-certificates)) |
| Long-term signature validation | PAdES B-B (B-T with a timestamp server); no embedded revocation data | PAdES B-LT / LTA |
| Page operations | Not part of undo / redo | Snapshot stack |
| Autosave | Browser storage only (about 5–10 MB per site) | Storage callback for host apps |
| Layers | Layers nested in Acrobat's style (a layer followed by its sub-layers, without a heading) are listed flat; layers the file leaves out of its list are still shown; locked layers can be switched; search finds text on hidden layers | Read the layer list with pdf-lib instead of pdf.js |
| Translations | Hindi, Arabic and Malay screens are first versions, not yet reviewed by native speakers | Native-speaker review (contributions welcome) |
| Extraction | Reading order is worked out from positions: columns that share a row with a heading or table below them across the whole page, columns whose section breaks line up, and layouts like sidebars can still come out in an unexpected order (switch reading order off to get the file's own order). On iPhone and Android, tables drawn with lines are read column by column unless their text also lines up (PDFKit and PdfBox give no ruling lines; the server and the web read them). Word boxes inside a run are proportional in the browser (exact on the server, iOS and Android). Hindi and other Indic text from office-made PDFs depends on the file's character map: the browser can produce broken words where the server (PDFium) reads them correctly. Scanned pages need OCR first. Server images lose transparency (soft masks); browser PNGs keep it. Extracted font files are usually licensed. Tables: borderless tables need three or more rows with two or more columns; a cell whose text wraps onto a second line without lines around it becomes its own row; tables split across pages come out as one table per page; scanned tables need OCR first | Reading-order analysis; use the server for Indic text; join tables across pages |
| SDK error messages | A few low-level messages (e.g. "This file is not valid XFDF.") are English only | Route them through translations |
| Accessibility | Automated audit clean and keyboard tested; no full screen-reader session yet | VoiceOver / NVDA pass |
| iOS | Measurements shown and kept but created only on the web; redaction marks can be drawn but are applied from the web; free text on rotated pages drawn unrotated | Port the web tools; call the server from the SDK |
| Android | No outline panel, no OCR, no drag handles to adjust a text selection | Port |

## 7. Not built

These are **not** in PDF Studio today. They are listed in no particular order; contributions are welcome.

| Feature | What it would be | Apryse equivalent |
|---|---|---|
| **True text editing** | Change the existing text of a PDF in place (fonts, reflow) | Content editing |
| **DOCX editor** | Edit Word documents directly in the browser, without converting to PDF | DOCX editor |
| **Spreadsheet editor** | Edit Excel files in the browser | Spreadsheet editor |
| **Smart data extraction** | Recognise forms, key-value pairs and tables with machine learning | IDP / smart data extraction |
| Real-time collaboration | Several people annotating the same document live | WebViewer collaboration |
| Compare documents | Show differences between two versions | Compare |
| Video / audio annotation, 3D, CAD | — | Specialist add-ons |

## 8. Glossary

| Word | Meaning |
|---|---|
| **Annotation** | Anything added on top of a page: highlight, note, drawing, stamp, text box, signature picture. |
| **Editable / flattened** | Editable: annotations stay movable in any PDF reader. Flattened: they are printed into the page. |
| **XFDF** | An XML file holding only annotations and form values. Acrobat and Apryse use it; many apps store reviewers' marks this way in their own backend. |
| **Appearance stream** | The drawing of an annotation stored in the PDF, so every reader shows it the same way. |
| **OCR** | Optical character recognition: makes a scanned page's text searchable. |
| **PAdES** | The standard for digital signatures in PDF files. |
| **Linearized** | A PDF arranged so the first page can be shown before the whole file has downloaded. |
| **RTL** | Right-to-left (Arabic, Urdu). |
| **Page units** | PDF Studio's coordinates: points, top-left origin, on the page as displayed (after rotation). |
