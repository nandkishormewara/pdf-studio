# Mobile SDKs: building, testing, adding to an app

**For mobile engineers and release engineers.** How to build and test the iOS and Android SDKs, run the demo apps, and add the SDKs to your own apps. If your app uses the PDFTron / Apryse mobile SDKs today, the call-by-call replacement is in [Migrating from PDFTron / Apryse](migrating-from-pdftron.md).

| Folder | What |
|---|---|
| `mobile/shared/` | Test files every SDK (and the web app) must pass: annotation JSON, PDF.js geometry vectors, Apryse-style XFDF and the expected results |
| `mobile/ios/PDFStudioKit` | Swift package (iOS 17+; macOS 14+ for running the tests) on Apple PDFKit |
| `mobile/ios/Demo` | Demo app, `PDFStudioDemo.xcodeproj` |
| `mobile/android/pdfstudio` | Android library (Kotlin, minSdk 24, compileSdk 36), PdfBox-Android 2.0.27 + Android `PdfRenderer` + Jetpack Compose |
| `mobile/android/demo` | Android demo app |

## 1. iOS — PDFStudioKit

### Requirements

Xcode 16 or newer (Swift 6 tools; the package compiles in Swift 5 language mode). iOS 17+ devices or simulators.

### Test and run

```bash
cd mobile/ios/PDFStudioKit
swift test                                # 35 tests: geometry, JSON, PDF round trips, XFDF (Apryse dialect), reading order
open ../Demo/PDFStudioDemo.xcodeproj      # then Run on an iPhone or iPad simulator
```

### Add to an app

*File ▸ Add Package Dependencies… ▸ Add Local…* → `mobile/ios/PDFStudioKit`. Or host the package in a Git repository and add it by URL, pinned to a tag. No licence key and no initialisation call are needed.

```swift
import PDFStudioKit

// Read-only copy with saved reviewer markup (replaces a read-only PTDocumentController)
let doc = StudioDocument(data: pdfData, name: "checked-copy.pdf")!   // nil = unreadable file: show your error view
try doc.mergeXFDF(inlineXFDF)
for layer in layers { try doc.mergeXFDF(layer) }
PDFStudioViewer(document: doc, allowsTextSelection: false)            // SwiftUI

// Editor
PDFStudioEditor(document: doc, author: currentUser.name)
let editable = doc.pdfData(.editable), flat = doc.pdfData(.flattened)
let xfdf = doc.exportXFDF(), json = doc.exportJSON()

// Text extraction: lines and words with boxes and fonts (the web SDK's pdf-studio-text JSON)
let pages = doc.extractText()                  // [PageTextContent]; pages: [0, 2] for some pages only
let text = doc.extractPlainText()              // with "===== Page n =====" headings; reading order (readingOrder: false for the file's order)
let data = try doc.extractTextJSON()
```

Screenshot protection, downloads and signature checks stay in the host app, as before.

### Release

The SDK has no binary of its own: it is compiled into each app. Release it by tagging the repository that holds the package, then updating the app's package reference to that tag. App Store signing and submission are unchanged.

## 2. Android — pdfstudio

### Requirements

Android Studio (its bundled JDK 21 works); Gradle wrapper 9.4.1 and Android Gradle Plugin 9.2.1 are in the project. On the command line, point `JAVA_HOME` at Android Studio's JDK:

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
```

### Test and run

```bash
cd mobile/android
./gradlew :pdfstudio:testDebugUnitTest            # JVM tests: geometry, JSON, XFDF, reading order (shared fixtures), search model
./gradlew :pdfstudio:connectedDebugAndroidTest    # on a device/emulator: PDF writing, merge, flatten, images→PDF,
                                                  # search-hit positions (0° and 90° + crop), text-markup round trip
./gradlew :demo:installDebug                      # demo app on the connected device
./gradlew :pdfstudio:assembleRelease              # → pdfstudio/build/outputs/aar/pdfstudio-release.aar
```

### Add to an app

Either include the module (`include(":pdfstudio")` with `project(":pdfstudio").projectDir = …`), or copy the AAR. With the AAR, also add its dependencies (PdfBox-Android, kotlinx-serialization-json, Compose), because an AAR doesn't carry them. If you are replacing PDFTron, remove `com.pdftron:pdftron` and `com.pdftron:tools`.

```kotlin
PdfStudio.init(context)                                              // once, e.g. Application.onCreate
PdfStudioViewer.open(context, uri, ViewerConfig(title = "Reviewed copy", xfdfLayers = listOf(xfdf)))
PdfStudio.mergeXfdf(srcPdf, xfdf, outPdf)                            // ≈ PDFDoc.fdfMerge(FDFDoc.createFromXFDF(...))
PdfStudio.isValidPdf(file)
PdfStudio.imagesToPdf(photos, outPdf)                                // A4, 20 pt margin, centred, JPEG
PdfStudio.search(pdf, "photosynthesis")                              // hits with one rect per line, in page units
PdfStudio.extractText(pdf).map { it.lines() }                        // lines and words with boxes, font and size
PdfStudio.extractPlainText(pdf)                                      // "===== Page n =====" headings, reading order, like web and server
PdfStudio.extractTextJson(pdf)                                       // the web SDK's pdf-studio-text JSON
```

`ViewerConfig(searchEnabled = false, thumbnailsEnabled = false, textMarkupEnabled = false, readOnly = true)` turns features off. Office files need `ViewerConfig.conversionServer` (the PDF Studio server, see [server and deployment](server-and-deployment.md)).

The library's consumer ProGuard rules (`consumer-rules.pro`) keep the PdfBox classes it loads by reflection. No extra rules are needed in the app.

Other `ViewerConfig` options: `secure = true` blocks screenshots and screen recording (FLAG_SECURE); `headers` adds HTTP headers such as `Authorization` for http(s) links; `maxDownloadBytes` (default 50 MB) limits downloads; `extensionHint` helps when a link has no file extension.

## 3. What both SDKs guarantee (tested)

- The same annotation JSON and coordinate system as the web SDK (`shared/annotations.sample.json`, `shared/geometry-vectors.json`, which were produced from PDF.js).
- Saved PDFs contain standard annotations, which Acrobat, Chrome and PDF.js show, plus PDF Studio's own `/PDFStudio` key. So the web and mobile SDKs reopen each other's files without loss, and annotations from other apps are imported too.
- XFDF from Apryse WebViewer, including `<add>/<modify>/<delete>`, `TextColor`, squiggly, image stamps and hidden flags, gives the same result on every platform (`shared/xfdf/expected.json`).

## 4. Known gaps

| Platform | Gap |
|---|---|
| iOS | Measurements are shown and kept, but can only be created on the web. Redaction marks can be drawn, but are applied from the web (server). Free text on rotated pages is drawn by PDFKit in unrotated page space. Rich text in text boxes shows as plain text (styling is kept in the file). Office files: convert on the server (`/convert`) or keep using QuickLook. |
| Android | No outline (bookmarks) panel, no OCR (scanned pages can't be searched), no drag handles to adjust a text selection. Rich text shows as plain text. |
| Both | Extraction is text only: images and fonts come from the web app or the server's `/extract`. |
| Both | Screen texts are the host app's; the SDK views use a few English labels (tool names) that the host app may need to translate. |

## 5. Release checklist (SDK change)

- [ ] `swift test` passes; the demo app runs on an iPhone and an iPad simulator.
- [ ] `./gradlew :pdfstudio:testDebugUnitTest :pdfstudio:connectedDebugAndroidTest` passes on at least one Android 7–9 device and one Android 14+ device.
- [ ] The app build that includes the change passes a manual check on both platforms: open, search, thumbnails, markup, save.
- [ ] Saved markup (XFDF) from your own backend's test environment opens correctly on both platforms.
- [ ] The tag or AAR version is recorded in the app's release notes.
- [ ] Android: the app's open-source licences screen shows `assets/pdfstudio/THIRD-PARTY-NOTICES.txt` (PdfBox-Android, Liberation Sans, kotlinx.serialization, AndroidX). iOS adds no notices. The notices file is regenerated with `scripts/gen_third_party_notices.py` after a dependency change.

Rolling back an SDK means shipping an app update with the previous SDK version. Installed apps can't be downgraded remotely, so if you are replacing another PDF SDK, keep the switch behind a remote feature flag (add one if the app has none) until it has been stable for a while ([migrating from PDFTron](migrating-from-pdftron.md#rolling-out-safely)).
