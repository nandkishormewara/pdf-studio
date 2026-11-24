# PDF Studio — mobile SDKs

| Folder | What |
|---|---|
| `shared/` | Test fixtures every SDK (and the web app) must pass: annotation JSON, PDF.js geometry vectors, Apryse-style XFDF + expected results |
| `ios/PDFStudioKit` | Swift package (iOS 17+, macOS 14+ for tests) built on Apple PDFKit |
| `ios/Demo` | Demo app (`PDFStudioDemo.xcodeproj`) |
| `android/pdfstudio` | Android library (Kotlin, minSdk 24): PdfBox-Android + Android `PdfRenderer` |
| `android/demo` | Android demo app |

## iOS — PDFStudioKit

```bash
cd ios/PDFStudioKit && swift test          # 17 tests: geometry, JSON, PDF round trips, XFDF (Apryse dialect)
open ../Demo/PDFStudioDemo.xcodeproj       # run on a simulator
```

Add to an app: *File ▸ Add Package Dependencies… ▸ Add Local…* → `mobile/ios/PDFStudioKit`
(or host it in a Git repo and add by URL).

### Read-only viewer with reviewer markup (replaces a read-only `PTDocumentController`)

```swift
import PDFStudioKit

let doc = StudioDocument(data: pdfData, name: "checked-copy.pdf")!   // or StudioDocument(url:) for a local file
try doc.mergeXFDF(inlineXFDF)                                         // XFDF from your backend
for layer in layers { try doc.mergeXFDF(layer) }                      // several markup layers, if you keep them separately

PDFStudioViewer(document: doc, allowsTextSelection: false)            // SwiftUI
```

| PDFTron | PDFStudioKit |
|---|---|
| `PTDocumentController()` + `toolManager.isReadonly = true` + `areToolGroupsEnabled = false` | `PDFStudioViewer(document:)` (read-only, no tool UI) |
| `documentController.openDocument(with: url)` | `StudioDocument(data:name:)` / `StudioDocument(url:)` — keep your existing download + signature checks |
| `document.mergeXFDF(with: xfdf, opts: nil)` + `pdfViewCtrl.update(true)` | `try doc.mergeXFDF(xfdf)` (display updates automatically) |
| `documentControllerDidOpenDocument` / `didFailToOpenDocumentWithError` | `StudioDocument(...)` returns `nil` on unreadable data: show your error overlay |
| `PTPDFNet.initialize(licenseKey)` | nothing — no licence |
| Screenshot protection on `documentController.view` | unchanged, apply to the hosting view |

### Editor

```swift
PDFStudioEditor(document: doc, author: currentUser.name)
// doc.pdfData(.editable) / doc.pdfData(.flattened) / doc.exportXFDF() / doc.exportJSON()
```

### Interop guarantees (tested)

* Same annotation JSON and coordinate system as the web SDK (`shared/annotations.sample.json`, `shared/geometry-vectors.json`).
* PDFs saved on iOS contain standard annotations (Acrobat/Chrome/PDF.js) plus the `/PDFStudio` key, so the
  web and iOS SDKs reopen each other's files losslessly; annotations from other apps are imported too.
* XFDF from Apryse WebViewer — including `<add>/<modify>/<delete>`, `TextColor`, squiggly, image stamps,
  hidden flags — produces identical results on iOS and web (`shared/xfdf/expected.json`).
* Hindi free text is shaped by iOS and saved as real text.

## Android — pdfstudio

```bash
cd android
./gradlew :pdfstudio:testDebugUnitTest            # JVM: geometry, JSON, XFDF (shared fixtures), search model
./gradlew :pdfstudio:connectedDebugAndroidTest    # device/emulator: PDF writing, merge, flatten, images→PDF,
                                                  # search-hit positions (0° and 90°+crop), text markup round trip
./gradlew :demo:installDebug
```

```kotlin
PdfStudio.init(context)                                              // once, e.g. Application.onCreate
PdfStudioViewer.open(context, uri, ViewerConfig(title = "Checked copy", xfdfLayers = listOf(xfdf)))
PdfStudio.mergeXfdf(srcPdf, xfdf, outPdf)                            // ≈ PDFDoc.fdfMerge(FDFDoc.createFromXFDF(...))
PdfStudio.isValidPdf(file)
PdfStudio.imagesToPdf(photos, outPdf)                                // A4, 20 pt margin, centred, JPEG
PdfStudio.search(pdf, "photosynthesis")                              // hits with one rect per line, in page units
```

The viewer has the PDFTron `DocumentActivity` defaults apps usually rely on: **Search** in the top bar
(case-insensitive, whole document, ‹ › and a result count) and a **Pages** thumbnail sheet (tap a page
to jump to it). With `readOnly = false`, long-press-drag selects text to highlight, underline or strike
out, next to the pen, free-hand highlighter and box tools. To turn these off, use
`ViewerConfig(searchEnabled = false, thumbnailsEnabled = false, textMarkupEnabled = false)`.

Text is extracted with PdfBox `PDFTextStripper`. Each glyph box comes from its text rendering matrix and
is converted to page units with `PageGeometry`, so page rotation and crop box are handled the same way
as for annotations. PdfBox's own y-down `TextPosition.getX/getY` are not used.

See [docs/migrating-from-pdftron.md](../docs/migrating-from-pdftron.md) for the file-by-file mapping from PDFTron.

Known gaps (Android): no outline/bookmarks panel, no OCR (a scanned page without a text layer can't
be searched) and no drag handles to adjust a text selection. Office files need
`ViewerConfig.conversionServer`.

### Known gaps (iOS)

* Measurement tools (distance/perimeter/area) and redaction marks are displayed and preserved but can only be
  created on the web for now.
* Free text on rotated pages is drawn by PDFKit in unrotated page space.
* Office files: open them after converting on the PDF Studio server (`/convert`) or keep using QuickLook.
