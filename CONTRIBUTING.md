# Contributing to PDF Studio

Thanks for helping. Bug reports, fixes, docs and new features are all welcome.

## Before you start

- **Bugs:** open an issue with the steps, the platform (web, iOS, Android or server) and, if you can, a small PDF
  that shows the problem. Don't attach documents with personal or confidential data.
- **Bigger changes** (a new annotation type, a new API, a new dependency): open an issue first so we can agree on
  the approach before you spend time on it.
- **Security problems:** don't open a public issue. See [SECURITY.md](SECURITY.md).

## Set up

You only need the parts you are changing.

| Part | Needs | Run it |
|---|---|---|
| Web app (`web/`) | Node.js (current LTS) | `cd web && npm install && npm run dev` |
| React viewer (`packages/react-viewer/`) | Node.js | `cd packages/react-viewer && npm install && npm run dev` |
| Server (`server/`) | Python 3.12+; Tesseract and LibreOffice for OCR and Office tests | `cd server && ./run.sh` |
| iOS SDK (`mobile/ios/PDFStudioKit/`) | Xcode with Swift 6 | `cd mobile/ios/PDFStudioKit && swift test` |
| Android SDK (`mobile/android/`) | JDK 17, Android SDK 36 | `cd mobile/android && ./gradlew :pdfstudio:testDebugUnitTest` |

The [developer guide](docs/developer-guide.md) explains the code layout, the architecture and the file formats.

## Run the tests

Run the tests for every part you touched. CI runs all of them on each pull request:

```bash
# Web app: lint, translations, type-checked build
cd web && npm run lint && npm run i18n:check && npm run build

# React viewer
cd packages/react-viewer && npm run typecheck && npm test

# Server
cd server && python -m pytest -q

# iOS SDK
cd mobile/ios/PDFStudioKit && swift test

# Android SDK
cd mobile/android && ./gradlew :pdfstudio:testDebugUnitTest
```

### Shared test files

`mobile/shared/` holds test files that the web, server, iOS and Android suites all check against: annotation
JSON, XFDF, geometry vectors, reading order and tables. A change to how annotations are read or written usually
needs the same change on every platform, so the suites keep agreeing.

`mobile/shared/reading-order/` and `mobile/shared/tables/` are generated. After changing the test pages in
`server/tests/conftest.py`, rebuild them and check the diff:

```bash
server/.venv/bin/python server/tests/make_reading_order_fixture.py
server/.venv/bin/python server/tests/make_tables_fixture.py
```

## Pull requests

- Keep each pull request to one change, with a short description of what it does and how you tested it.
- Add or update tests for behaviour you change.
- Update the docs in `docs/` when you change a public API or a user-visible feature.
- New text in the web app needs translations in `web/src/i18n/` (`npm run i18n:check` lists what's missing).
- Use made-up data in tests and samples (for example John Doe, User 1). Never use real people's names or
  documents.
- New dependencies must have a permissive licence (MIT, BSD, Apache-2.0 or similar), and their licence
  notices must be added (see `scripts/`).

## Licence

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
