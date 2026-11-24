# Changelog

All notable changes are listed here. The project follows [semantic versioning](https://semver.org/).

## 1.0.0 (2026-11-24)

First public release.

### Web
- Web app and framework-free web SDK on PDF.js and pdf-lib: view, search, annotate, measure, fill forms,
  organise pages, and export as an editable or flattened PDF, XFDF or JSON.
- Live demo on GitHub Pages: https://nandkishormewara.github.io/pdf-studio/

### React viewer
- `@pdf-studio/react-viewer`: a React component with a WebViewer-style API (`PdfWebViewer`).

### iOS
- `PDFStudioKit` Swift package (iOS 17+) on Apple PDFKit, with a SwiftUI viewer.
- Install by repository URL with Swift Package Manager.
- Annotation ids (`/NM`) are kept on iOS and macOS 26, whose PDFKit doesn't write or read them.

### Android
- `pdfstudio` library (minSdk 24) on PdfBox-Android, with a Compose viewer. The AAR is attached to the release.

### Server (optional)
- FastAPI server for Office → PDF (LibreOffice), OCR (Tesseract), true redaction and PAdES signatures.

### Compatibility
- Reads and writes XFDF the way Acrobat and Apryse WebViewer do, including `<add>/<modify>/<delete>` commands,
  so annotations saved by an existing PDFTron app keep opening.
