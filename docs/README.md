# PDF Studio documentation

PDF Studio is an open-source PDF toolkit: a web viewer / editor and SDK (PDF.js + pdf-lib), an optional processing
server (FastAPI: Office conversion, OCR, true redaction, digital signatures, extraction), an iOS SDK on Apple PDFKit,
an Android SDK on PdfBox-Android, and a React component with a WebViewer-style API. It needs no licence key and can
replace Apryse / PDFTron in existing apps.

| Document | For | What's in it |
|---|---|---|
| [Product and features](product-and-features.md) | Everyone | What PDF Studio is, features per platform, known limitations, what is not built, glossary |
| [User guide](user-guide.md) | People using the web app (and the apps that embed the SDKs) | Opening, viewing, annotating, measuring, forms, pages, saving, extraction, server tools, shortcuts, troubleshooting |
| [Developer guide](developer-guide.md) | Engineers and contributors | Setup, project layout, web SDK reference, architecture, file formats (annotation JSON, XFDF mapping, form JSON), tests |
| [Mobile SDKs](mobile-sdks.md) | iOS and Android engineers | Building and testing `PDFStudioKit` and the `pdfstudio` Android library, adding them to an app, known gaps |
| [Server and deployment](server-and-deployment.md) | DevOps and release engineers | Quick start, hosting the web app, running the server (Mac, Docker, Ubuntu), configuration, signing certificates, releasing, rollback |
| [API testing](api-testing.md) | Testers and integrators | Every server endpoint with fields, answers and errors; test cases; the Postman collection |
| [Migrating from PDFTron / Apryse](migrating-from-pdftron.md) | Teams replacing WebViewer, the PDFTron mobile SDKs or PDFNet | Call-by-call mapping, `@pdf-studio/react-viewer` install and usage, known differences, keeping existing XFDF |

Also here: [server-api.postman_collection.json](server-api.postman_collection.json), the Postman collection for the
server API (see [API testing](api-testing.md)).

## Where to start

- **Try it:** `scripts/start-local.sh` from the repository root runs the web app and the server
  ([Server and deployment, quick start](server-and-deployment.md#0-quick-start)).
- **Embed it in a web app:** the [developer guide](developer-guide.md#embedding-in-another-app), or
  `@pdf-studio/react-viewer` ([migrating from PDFTron](migrating-from-pdftron.md#web-webviewer--pdftronwebviewer)).
- **Embed it in a mobile app:** [Mobile SDKs](mobile-sdks.md).
- **Move off Apryse / PDFTron:** [Migrating from PDFTron / Apryse](migrating-from-pdftron.md).
