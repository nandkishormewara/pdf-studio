# Migrating from PDFTron / Apryse

**For engineers whose apps use Apryse (formerly PDFTron) today**: WebViewer, the PDFTron iOS SDK, the PDFTron Android
SDK, or server-side PDFNet. For each one, this guide gives the PDF Studio equivalent, call by call, and the
differences to check. Building and adding the SDKs: [Mobile SDKs](mobile-sdks.md). Feature coverage per platform:
[Product and features](product-and-features.md). The server: [Server and deployment](server-and-deployment.md).

PDF Studio needs no licence key and no initialisation with a key: everything is built from permissively licensed
open-source parts (PDF.js, pdf-lib, Apple PDFKit, PdfBox-Android, LibreOffice, Tesseract, pyHanko and others).

## Contents

- [Before you start: XFDF is the contract](#before-you-start-xfdf-is-the-contract)
- [Web: WebViewer / `@pdftron/webviewer`](#web-webviewer--pdftronwebviewer)
- [iOS: PDFTron iOS SDK](#ios-pdftron-ios-sdk)
- [Android: PDFTron Android SDK](#android-pdftron-android-sdk)
- [Server side: PDFNet and in-browser Office viewing](#server-side-pdfnet-and-in-browser-office-viewing)
- [Existing XFDF keeps opening](#existing-xfdf-keeps-opening)
- [Rolling out safely](#rolling-out-safely)

## Before you start: XFDF is the contract

Most apps built on Apryse store annotations as **XFDF** (WebViewer's `exportAnnotations()`, the mobile SDKs'
`fdfExtract` / `mergeXFDF`), and keep the PDF itself unchanged. PDF Studio reads and writes that XFDF dialect on every
platform, so **no data migration is needed** as long as XFDF stays your storage format: the same files open in PDF
Studio, and XFDF written by PDF Studio opens in WebViewer again (useful for rollback).

Supported on web, iOS and Android:

- command files (`<add>` / `<modify>` / `<delete>`);
- `TextColor` / `FontSize` / `<defaultstyle>` and `contents-richtext` on free text;
- squiggly underlines, clouds, polylines and polygons;
- `<imagedata>` stamps;
- hidden flags;
- replies (`inreplyto`) and grouped marks (`replyType="group"`) in `@pdf-studio/react-viewer` and the iOS and
  Android SDKs.

All three SDKs pass the same expectations: `mobile/shared/xfdf/apryse-annots.xfdf` and `apryse-commands.xfdf` must
produce `mobile/shared/xfdf/expected.json`.

> Before switching, export a sample of **your own** stored XFDF and run it through PDF Studio (see
> [Existing XFDF keeps opening](#existing-xfdf-keeps-opening)). The shared fixtures are modelled on WebViewer's format,
> not taken from your data.

---

## Web: WebViewer / `@pdftron/webviewer`

Use **`@pdf-studio/react-viewer`** (`packages/react-viewer`). It is a React component with the props and handle
that a typical React wrapper around `@pdftron/webviewer` exposes, built on PDF Studio's web SDK (`web/src/sdk`,
PDF.js + pdf-lib). If your app already wraps WebViewer in a `PdfWebViewer`-like component, the call sites barely
change.

If you used WebViewer as a full-page viewer (not inside React), you can instead host the PDF Studio web app
(`web/dist`, see [Server and deployment](server-and-deployment.md#2-the-web-app)) and open documents with
`?file=<url>`.

### Call mapping

| WebViewer (typical wrapper) | `@pdf-studio/react-viewer` |
|---|---|
| `WebViewer({ path, licenseKey, initialDoc }, element)` | `<PdfWebViewer documentUrl={url} mode="view" \| "edit" />` |
| `licenseKey`, `path` / asset path | `licenseKey`, `assetPath` props: optional, accepted and ignored. No assets to copy |
| `disableElements([...])` for a read-only viewer | `mode="view"`: read-only, no tools, download, print or save (sticky notes still open on click). `VIEW_MODE_DISABLED_ELEMENTS` is still exported for code that references it |
| Annotation tools for reviewers | `mode="edit"`: toolbar (see below) |
| `loadDocument(url, { extension, filename, customHeaders })` | Handle: `loadDocument(url, { extension, filename, customHeaders, onLoadingProgress })`; props `documentExtension`, `documentFilename`, `customHeaders` |
| `extension` for URLs without a suffix | Fallback hint only: the first bytes are sniffed, so extension-less stream URLs work. PDF as is; png / jpg / webp / gif → one-page document |
| `customHeaders` (e.g. `Authorization`) | Sent with the `fetch` of the document |
| `annotationManager.importAnnotations(xfdf)` | Handle: `importAnnotations(xfdf)`; merges and applies `<add>/<modify>/<delete>`. Or the `initialXfdf` prop, imported into the freshly loaded document before `onLoad` (failures go to `onAnnotationsError`) |
| `annotationManager.exportAnnotations()` | Handle: `exportXfdf()`: WebViewer-readable XFDF |
| `documentViewer.getDocument().getFileData({ xfdfString, flatten: true })` | Handle: `exportAnnotatedPdf()`: a `Blob` with the annotations flattened into the pages |
| `documentViewer.addEventListener('documentLoaded')` | `onLoad` |
| Load errors | `onError(message)`; the built-in error overlay has **Retry** |
| Ready callback with the instance | `onReady(handle)` |
| `annotationManager.setWatermark(...)` / `documentViewer.setWatermark(...)` diagonal text | `watermark` prop: a string (WebViewer-like defaults: 22 pt, red, 22 % opacity) or `{ text, color, opacity, fontSize }`. Drawn on screen only |
| Several WebViewer instances on one page | Supported; each `<PdfWebViewer>` is independent and its styles are scoped |
| Helpers that took a `WebViewerInstance` | `createPdfWebViewerHandle`, `exportXfdfFromInstance`, `importAnnotationsIntoInstance`, `exportAnnotatedPdfFromInstance` take the package's `ViewerInstance` |

There is also a progress overlay, and after 20 s without the document loading a "Still loading…" hint with
**Reload**.

**Tools in edit mode:** select / move / resize, highlight, underline, strikeout, squiggly, free text, sticky note,
rectangle, ellipse, line, arrow, polyline, polygon, cloud, pen and eraser (drag over marks to delete them), plus
colour, line width, font size, undo / redo and delete. Text markup works on selected text; on scanned pages without a
text layer, drag a box instead.

**Apryse-specific mark types.** PDF Studio's core annotation model has no squiggly, polyline, polygon or cloud kind
(the SDK reads them as underline / ink). The package keeps that model and adds a `subtype` that it renders (zig-zag
squiggly, scalloped cloud) and writes back on export: `<squiggly>`, `<polyline>`, `<polygon>` and
`<polygon style="cloudy" intensity="2">`. Free text is exported with `TextColor`, `FontSize` and `<defaultstyle>` and
without a border `color`, as WebViewer writes it. Replies (`inreplyto`) are folded into the parent's comment. In the
flattened PDF a cloud is drawn as its polygon.

### Install

The package bundles the web SDK into `dist/`. Build it from this repository:

```bash
cd packages/react-viewer
npm install
npm run build        # tsc (declarations) + Vite library build → dist/
npm pack             # optional: a tarball to install elsewhere
```

Then add it to your app, for example as a workspace package or from the tarball:

```bash
npm install /path/to/pdf-studio/packages/react-viewer/pdf-studio-react-viewer-1.0.0.tgz
npm uninstall @pdftron/webviewer
```

`pdfjs-dist` and `pdf-lib` come in as dependencies; React 19 (`react`, `react-dom`) is a peer dependency. Remove
WebViewer's copied assets (often `public/lib/webviewer`, a `postinstall` or copy-assets script) and any licence-key
environment variables.

**PDF.js worker.** With Vite, nothing else is needed when the package is a workspace package: Vite emits the worker
(`pdfjs-dist/build/pdf.worker.min.mjs?url`) as a hashed file next to the app's chunks. If it is installed into
`node_modules` from a registry or tarball, add to the app's `vite.config.ts`:

```ts
optimizeDeps: { exclude: ['@pdf-studio/react-viewer'], include: ['pdf-lib', 'pdfjs-dist'] },
```

Non-Vite hosts (webpack, Next.js and others) call `setPdfWorkerSrc(url)` once, before the first viewer mounts, with
the URL where they serve `pdf.worker.min.mjs` from `pdfjs-dist`.

### Usage

```tsx
import { useRef } from 'react';
import { PdfWebViewer, type PdfWebViewerHandle } from '@pdf-studio/react-viewer';

function ReviewScreen({ documentUrl, token, savedXfdf }: { documentUrl: string; token: string; savedXfdf?: string }) {
  const viewerRef = useRef<PdfWebViewerHandle>(null);

  async function save() {
    const xfdf = await viewerRef.current!.exportXfdf();          // store in your backend, as before
    const blob = await viewerRef.current!.exportAnnotatedPdf();  // optional: flattened copy
    // …upload xfdf / blob
  }

  return (
    <>
      <PdfWebViewer
        ref={viewerRef}
        documentUrl={documentUrl}
        documentExtension="pdf"
        customHeaders={{ Authorization: `Bearer ${token}` }}
        mode="edit"
        initialXfdf={savedXfdf}
        watermark="Jane Doe · 12345"
        onAnnotationsError={(msg) => console.warn(msg)}
        onLoad={() => console.log('ready')}
        onError={(msg) => console.error(msg)}
      />
      <button onClick={save}>Save</button>
    </>
  );
}
```

Lower-level helpers are exported too: `importXfdf` / `exportXfdf` (XFDF ↔ the package's annotation list, with the
Apryse subtypes) and `sniffType` (detects PDF / image from the first bytes).

### Checking it

```bash
cd packages/react-viewer
npm test        # Vitest
npm run dev     # demo page
```

- The tests import `mobile/shared/xfdf/apryse-annots.xfdf` and `apryse-commands.xfdf` through the handle and must
  match `expected.json`; the export must re-import to the same result and keep squiggly / polygon / cloud as Apryse
  types; the flattened PDF must keep its pages. `test/apryse-migration.test.ts` holds regression cases taken from
  real-world WebViewer 7.2 XFDF. Loader tests cover byte sniffing, image → PDF, custom headers and progress.
- The demo shows edit mode with XFDF import / export and PDF download, view mode, two viewers side by side, an
  extension-less image stream, and the error overlay.

### Known differences from WebViewer

- The whole file is downloaded before the first page shows (no linearized / range streaming inside the component);
  the progress shown is real download progress. The full PDF Studio web app does stream by range.
- Office files (Word, Excel, PowerPoint) are not rendered in the browser: convert them to PDF on a server first (see
  [Server side](#server-side-pdfnet-and-in-browser-office-viewing)). The component shows an error for them.
- No search, thumbnails or page-navigation UI in the component; scrolling and zoom only. The full web app has them.
- Line-ending styles other than an arrow are simplified.
- The watermark is drawn on screen only; it is not written into exported PDFs.

---

## iOS: PDFTron iOS SDK

Package: `mobile/ios/PDFStudioKit` (Swift Package, iOS 17+, built on Apple PDFKit). Add it with *File ▸ Add Package
Dependencies…* ([Mobile SDKs](mobile-sdks.md#1-ios--pdfstudiokit)).

| PDFTron | PDF Studio |
|---|---|
| `PTPDFNet.initialize(licenseKey)` in the app delegate | Remove. No initialisation is needed |
| `PTDocumentController()` + `toolManager.isReadonly = true` + `areToolGroupsEnabled = false` | `PDFStudioViewer(document:allowsTextSelection:)` (SwiftUI, read-only, no tool UI) |
| `PTDocumentController` with annotation tools | `PDFStudioEditor(document:author:)` (SwiftUI) |
| `documentController.openDocument(with: url)` | `StudioDocument(data:name:)` or `StudioDocument(url:)`. Keep your own download, authentication and signature-check code |
| `documentControllerDidOpenDocument` / `didFailToOpenDocumentWithError` | The `StudioDocument` initialiser returns `nil` for an unreadable file → show your error view |
| `document.mergeXFDF(with:opts:)` + `pdfViewCtrl.update(true)` | `try doc.mergeXFDF(xfdf)` (the display updates itself) |
| `PTPDFDoc.fdfExtract` → XFDF | `doc.exportXFDF()` (or `doc.exportJSON()` for PDF Studio's lossless JSON) |
| `saveToFile` with annotations / flattened | `doc.pdfData(.editable)` / `doc.pdfData(.flattened)` |
| Screenshot protection on the controller's view | Unchanged: keep it in the host app |

Example: a read-only copy with one inline XFDF plus several stored layers:

```swift
import PDFStudioKit
import SwiftUI

struct ReviewedCopyView: View {
    @StateObject private var doc: StudioDocument
    let xfdfLayers: [String]

    init(document: StudioDocument, xfdfLayers: [String]) {
        _doc = StateObject(wrappedValue: document)
        self.xfdfLayers = xfdfLayers
    }

    var body: some View {
        PDFStudioViewer(document: doc, allowsTextSelection: false)
            .task {
                for layer in xfdfLayers { try? doc.mergeXFDF(layer) }
            }
    }
}
```

Finally remove the `pdftron-apple-package` (or `PDFNet` / `Tools` frameworks) dependency and the licence key from
`Info.plist` or your configuration.

**Office files:** PDFTron could render Office documents in-app. PDFStudioKit can't: convert them on the server
(`POST /convert`) or show them with QuickLook.

**Differences to check:** measurements are shown and kept but can only be created on the web; redaction marks can be
drawn but are applied by the server; rich text in text boxes shows as plain text (styling is kept in the file). See
[Mobile SDKs, known gaps](mobile-sdks.md#4-known-gaps).

---

## Android: PDFTron Android SDK

Library: `mobile/android/pdfstudio` (Kotlin, minSdk 24, PdfBox-Android + Android `PdfRenderer` + Jetpack Compose).

| PDFTron | PDF Studio |
|---|---|
| `DocumentActivity.openDocument(ctx, uri, config)` | `PdfStudioViewer.open(ctx, uri, ViewerConfig(title = …))` |
| `Intent` + `EXTRA_FILE_URI` + `EXTRA_CONFIG`, launched for result | `PdfStudioViewer.createIntent(ctx, uri, config)` |
| Read-only `ViewerConfig.Builder()…documentEditingEnabled(false)…` | `ViewerConfig()` (read-only is the default); `readOnly = false` enables text markup and drawing |
| `PDFDoc(path).fdfMerge(FDFDoc.createFromXFDF(xfdf)); save(…)` | `PdfStudio.mergeXfdf(src, xfdf, out)`, or skip the temporary file with `ViewerConfig(xfdfLayers = listOf(xfdf))` |
| `PDFDoc(path).initSecurityHandler() && pageCount > 0` | `PdfStudio.isValidPdf(file)` |
| Images → PDF with `Image.create` / `ElementBuilder` | `PdfStudio.imagesToPdf(files, out)` (A4, 20 pt margin, centred; longest edge 2048 px, JPEG quality 0.84 by default) |
| Text search through `PDFViewCtrl` | Built into the viewer; `PdfStudio.search(pdf, query)` returns hits with rects in page units |
| `TextExtractor` | `PdfStudio.extractText(pdf)`, `extractPlainText(pdf)`, `extractTextJson(pdf)` |
| `pdftron_license_key` manifest meta-data / `PDFNet.initialize` | Remove; call `PdfStudio.init(context)` once in `Application.onCreate` |
| `DocumentActivity` manifest entry + PDFTron theme | Remove (the library declares its own activity) |
| PDFTron Maven repository + `com.pdftron:pdftron` / `com.pdftron:tools` + ProGuard keep rules | `implementation(project(":pdfstudio"))` or the AAR plus its dependencies; consumer ProGuard rules are included |
| Office rendering inside `DocumentActivity` | `ViewerConfig(conversionServer = "https://…")` (the PDF Studio server's `/convert`), or convert on your backend first |

Other `ViewerConfig` options: `secure = true` blocks screenshots and screen recording (FLAG_SECURE); `headers` adds
HTTP headers such as `Authorization` for http(s) links; `maxDownloadBytes` (default 50 MB); `extensionHint` for links
without a file extension; `searchEnabled`, `thumbnailsEnabled`, `textMarkupEnabled` turn features off.

**Differences to check:**

- Search and thumbnails, which `DocumentActivity` shows by default, are on by default too. Search is case-insensitive
  over the whole document, shows "n / total" with ‹ › and outlines every hit. The text is indexed once per document,
  in the background, so the counter shows "Indexing…" for a moment on large files. Scanned pages without a text layer
  have nothing to search (no OCR on Android), the same as PDFTron without its OCR add-on.
- Thumbnails open in a bottom sheet from **Pages** rather than a side panel. There is no outline / bookmarks panel and
  no reflow mode.
- Editable mode (`readOnly = false`): long-press-drag selects text, then **Highlight / Underline / Strike / Copy**
  works like PDFTron's text-markup quick menu. Selection always runs in reading order and starts from the whole word
  you long-pressed. There are no drag handles to adjust it afterwards: press ✕ and select again. The marks are saved
  as standard `/Highlight`, `/Underline`, `/StrikeOut` annotations with QuadPoints (one per line), so WebViewer and
  other viewers show them. In read-only mode text can't be selected or copied, and Copy is hidden when `secure = true`.
- Search results are drawn on top of the page and are never saved into the PDF.
- If a download link returns an HTML page with status 200 (for example an expired signed URL), the loader detects it
  and shows "the link may have expired" instead of a broken document.

---

## Server side: PDFNet and in-browser Office viewing

| PDFTron / Apryse | PDF Studio |
|---|---|
| PDFNet (`@pdftron/pdfnet-node`, the Python / Java / .NET PDFNet SDK) for Office → PDF | `POST /convert` (LibreOffice) |
| PDFNet OCR module | `POST /ocr` (Tesseract, 160+ languages) |
| PDFNet redaction (`Redactor`) | `POST /redact` (true redaction: content removed, not covered) |
| PDFNet digital signatures | `POST /sign` and `POST /verify` (pyHanko, PAdES) |
| PDFNet optimiser / linearisation | `POST /optimize` |
| PDFNet `TextExtractor`, image and font extraction | `POST /extract` (text with positions, tables, images, fonts) |
| XFDF merge / flatten on the server | Not an endpoint: merge in the client SDKs (`mergeXFDF` / `mergeXfdf`), or flatten in the browser with `exportAnnotatedPdf()` |
| WebViewer's in-browser Office engine | **Not available.** Convert Office files to PDF on the server (`/convert`, or your own LibreOffice conversion) and give the viewers the PDF |
| A self-hosted WebViewer page (`public/viewer` or similar) | The PDF Studio web app (`web/dist`) with `?file=`, or a small page around `@pdf-studio/react-viewer` |
| Licence key returned to clients by an API | Remove |

Request and response details: [API testing](api-testing.md). Running the server: [Server and deployment](server-and-deployment.md).

**LibreOffice is required for Office files.** WebViewer rendered Word, Excel and PowerPoint in the browser; PDF Studio
does not. The host that converts (the PDF Studio server, or your own backend) needs LibreOffice (`soffice`)
installed. Without it, only Office files fail to open; PDFs are unaffected.

**Handwriting in PowerPoint.** Ink drawn in PowerPoint is stored as InkML (`p14:contentPart`) with a fallback image.
If your users annotate slides by hand, check that the converted PDF shows the ink; if LibreOffice doesn't draw it in
your setup, rasterise the ink into the slide (or flatten the fallback image) before conversion.

If you never stored XFDF in PDFNet-only formats, no database or API changes are needed: keep storing XFDF as before.

---

## Existing XFDF keeps opening

Both engines read and write the same XFDF, so stored marks stay where they are. PDF Studio's readers were checked
against a large set of real-world XFDF saved by WebViewer 7.2, with WebViewer open beside PDF Studio as the reference:
pen / handwriting (including highlighter pen), highlight, underline, squiggly, strikeout, boxes, circles, lines,
arrows, notes, image stamps, typed text (coloured and mixed-colour), filled translucent boxes, typed text on a
coloured background, typed text rotated on rotated photos, callouts (box + arrow) and grouped marks all look the same
on web, Android and iOS. After a re-save in PDF Studio the marks, fills, rotations and callouts are kept, and WebViewer
reads PDF Studio's XFDF.

WebViewer behaviours that PDF Studio reproduces on every platform:

| WebViewer behaviour | What PDF Studio does |
|---|---|
| XFDF `fringe` is written as left, **bottom**, right, **top** (PDF `/RD` is left, top, right, bottom) | Read and written in Apryse order, so callout boxes and arrows line up |
| When XFDF loads, marks already in the PDF with the same name (`/NM`) are replaced | Same; an unnamed XFDF mark replaces an in-file mark with the same type, page, text and box (within 1.5 pt), so marks are not drawn twice |
| Free text wraps between words at the box width | Same wrapping (`wrapRuns` on web, `RichText.wrap` on mobile); a word wider than the box stays whole |
| Highlights multiply with the page | Same (Android: `BlendMode.MULTIPLY`, darken before Android 10) |
| Free text drawn in Helvetica | iOS draws free text itself (PDFKit's native free text clips and pads); Android uses Liberation Sans, which has Helvetica's metrics |
| A truncated XFDF file shows no marks | PDF Studio shows the complete marks it can read and flags the import as `partial` |

Invisible link areas in XFDF are not imported (they are not marks).

### Check your own data before switching

Each platform has an opt-in test that reads every `.xfdf` file under a folder and writes one JSON line per file
(the annotations it read, or the error). It is skipped unless both variables are set:

```bash
# Web (React viewer package)
cd packages/react-viewer
LEGACY_DIR=/path/to/xfdf LEGACY_OUT=/tmp/web.jsonl npx vitest run test/legacy-xfdf-check.test.ts

# iOS
cd mobile/ios/PDFStudioKit
LEGACY_DIR=/path/to/xfdf LEGACY_OUT=/tmp/ios.jsonl swift test --filter LegacyXfdfCheckTests

# Android
cd mobile/android
LEGACY_DIR=/path/to/xfdf LEGACY_OUT=/tmp/android.jsonl ./gradlew :pdfstudio:testDebugUnitTest --tests '*LegacyXfdfCheckTest'
```

For large sets on the web, `LEGACY_START` and `LEGACY_COUNT` select a slice. Look for `"error"` lines and
`"partial": true`, and compare the three outputs (file by file, mark by mark) to confirm all platforms read your data
the same way. Then open a sample of real documents with their XFDF in PDF Studio and in WebViewer side by side.

Use a read-only copy of your stored XFDF for this; the check never writes to it.

---

## Rolling out safely

- **Behind a switch.** Ship PDF Studio next to PDFTron with a runtime switch (an environment variable for the web and
  the server, a remote flag for mobile apps) until each app has had one stable release on PDF Studio. Mobile releases
  can't be pulled back from devices, so a remote flag matters most there.
- **Order.** Server-side conversion first (so Office files reach every client as PDF), then the web, then the mobile
  apps.
- **Rollback is cheap** while XFDF is the storage format: WebViewer reads what PDF Studio writes, so switching back
  loses nothing.
- **Then remove PDFTron:** the SDK dependencies, the copied WebViewer assets, licence keys in configuration and
  manifests, and any server code that hands licence keys to clients.
