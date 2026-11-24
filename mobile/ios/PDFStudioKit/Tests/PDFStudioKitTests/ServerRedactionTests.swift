import PDFKit
import XCTest
@testable import PDFStudioKit

/// Answers requests from a URLSession with a canned response and records what was sent. No network.
final class StubProtocol: URLProtocol {
    struct Reply { var status = 200; var headers: [String: String] = [:]; var body = Data(); var fail = false }
    nonisolated(unsafe) static var reply = Reply()
    nonisolated(unsafe) static var requests: [(URLRequest, Data)] = []

    static func session() -> URLSession {
        let c = URLSessionConfiguration.ephemeral
        c.protocolClasses = [StubProtocol.self]
        return URLSession(configuration: c)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        var body = request.httpBody ?? Data()
        if body.isEmpty, let stream = request.httpBodyStream {
            stream.open()
            var buf = [UInt8](repeating: 0, count: 65536)
            while stream.hasBytesAvailable { let n = stream.read(&buf, maxLength: buf.count); if n <= 0 { break }; body.append(buf, count: n) }
            stream.close()
        }
        Self.requests.append((request, body))
        let r = Self.reply
        if r.fail { client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost)); return }
        let response = HTTPURLResponse(url: request.url!, statusCode: r.status, httpVersion: "HTTP/1.1", headerFields: r.headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: r.body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

/// Parts of a multipart/form-data body.
func formParts(_ body: Data, contentType: String) -> [String: (filename: String?, data: Data)] {
    guard let b = contentType.components(separatedBy: "boundary=").last else { return [:] }
    let sep = Data("--\(b)".utf8)
    var parts: [String: (String?, Data)] = [:]
    var rest = body[...]
    while let r = rest.range(of: sep) {
        let after = rest[r.upperBound...]
        guard let next = after.range(of: sep) else { break }
        var part = after[after.startIndex..<next.lowerBound]
        if part.starts(with: Data("\r\n".utf8)) { part = part.dropFirst(2) }
        if part.suffix(2) == Data("\r\n".utf8) { part = part.dropLast(2) }
        if let h = part.range(of: Data("\r\n\r\n".utf8)) {
            let head = String(decoding: part[..<h.lowerBound], as: UTF8.self)
            let name = head.components(separatedBy: "name=\"").dropFirst().first?.components(separatedBy: "\"").first ?? ""
            let file = head.components(separatedBy: "filename=\"").dropFirst().first?.components(separatedBy: "\"").first
            parts[name] = (file, Data(part[h.upperBound...]))
        }
        rest = after[next.lowerBound...]
    }
    return parts
}

@MainActor
final class ServerRedactionTests: XCTestCase {
    override func setUp() {
        StubProtocol.reply = .init()
        StubProtocol.requests = []
    }

    private func document(rotation: Int = 0) throws -> StudioDocument {
        let doc = try XCTUnwrap(StudioDocument(data: Fixtures.pdf(pages: 2, rotation: rotation, crop: CGRect(x: 20, y: 30, width: 560, height: 720)), name: "Report.PDF"))
        doc.add(Annotation(page: 1, kind: .redact, color: "#e5484d", rect: Box(x: 10, y: 20, w: 100, h: 30), author: "User 1"))
        var withText = Annotation(page: 0, kind: .redact, color: "#e5484d", rect: Box(x: 50, y: 60, w: 80, h: 12), author: "User 1")
        withText.text = "John Doe"
        doc.add(withText)
        doc.add(Annotation(page: 1, kind: .redact, color: "#e5484d", rect: Box(x: 200, y: 300, w: 40, h: 40), author: "User 1"))
        doc.add(Annotation(page: 0, kind: .rect, color: "#1f6feb", rect: Box(x: 300, y: 300, w: 50, h: 50), author: "User 1"))
        return doc
    }

    func testRegionsAreGroupedByPageInPDFUserSpace() throws {
        let doc = try document()
        let regions = doc.redactionRegions()
        XCTAssertEqual(regions.map(\.page), [1, 0], "pages in order of their first mark, as the web")
        // crop (20, 30, 560, 720): page box (10, 20, 100×30) → PDF x 30…130, y 750-50…750-20
        XCTAssertEqual(regions[0].rects, [[30, 700, 130, 730], [220, 410, 260, 450]])
        XCTAssertEqual(regions[0].texts, [])
        XCTAssertEqual(regions[1].texts, [.init(text: "John Doe", near: [70, 678, 150, 690])])

        let rotated = try document(rotation: 90)
        let g = rotated.geometry(page: 1)
        let r = g.toPDF(Box(x: 10, y: 20, w: 100, h: 30))
        XCTAssertEqual(rotated.redactionRegions()[0].rects[0], [r.minX, r.minY, r.maxX, r.maxY].map(Double.init))
    }

    func testRequestMatchesTheWebClient() throws {
        let server = PDFStudioServer(baseURL: URL(string: "http://localhost:8787/")!)
        let regions = [PDFStudioServer.RedactRegion(page: 0, rects: [[1, 2, 3, 4.5]], texts: [.init(text: "a/b", near: [1, 2, 3, 4.5])])]
        let req = try server.redactRequest(pdf: Data("%PDF-1.7 test".utf8), regions: regions, sanitize: false, ocrLanguages: ["eng", "hin"])
        XCTAssertEqual(req.url?.absoluteString, "http://localhost:8787/redact")
        XCTAssertEqual(req.httpMethod, "POST")
        let parts = formParts(try XCTUnwrap(req.httpBody), contentType: try XCTUnwrap(req.value(forHTTPHeaderField: "Content-Type")))
        XCTAssertEqual(Set(parts.keys), ["file", "regions", "sanitize", "ocr_languages"])
        XCTAssertEqual(parts["file"]?.filename, "doc.pdf")
        XCTAssertEqual(parts["file"]?.data, Data("%PDF-1.7 test".utf8))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: parts["regions"]!.data) as? [[String: Any]])
        XCTAssertEqual(json.count, 1)
        XCTAssertEqual(Set(json[0].keys), ["page", "rects", "texts"])
        XCTAssertEqual(json[0]["rects"] as? [[Double]], [[1, 2, 3, 4.5]])
        XCTAssertEqual((json[0]["texts"] as? [[String: Any]])?.first?["text"] as? String, "a/b")
        XCTAssertEqual(try JSONDecoder().decode([PDFStudioServer.RedactRegion].self, from: parts["regions"]!.data), regions)
        XCTAssertEqual(String(decoding: parts["sanitize"]!.data, as: UTF8.self), "false")
        XCTAssertEqual(String(decoding: parts["ocr_languages"]!.data, as: UTF8.self), "eng+hin")
        // defaults: sanitize true, no OCR field
        let plain = try server.redactRequest(pdf: Data("%PDF".utf8), regions: regions)
        let p2 = formParts(plain.httpBody!, contentType: plain.value(forHTTPHeaderField: "Content-Type")!)
        XCTAssertEqual(String(decoding: p2["sanitize"]!.data, as: UTF8.self), "true")
        XCTAssertNil(p2["ocr_languages"])
    }

    func testApplyRedactionsSendsTheDocumentAndOpensTheResult() async throws {
        let doc = try document()
        let redacted = try XCTUnwrap(StudioDocument(data: Fixtures.pdf(pages: 2), name: "x.pdf")?.pdfData())
        let report = #"{"pages":[0,1],"regions":3,"annotationsRemoved":0,"sanitized":["metadata"],"ocrPages":[]}"#
        StubProtocol.reply = .init(status: 200, headers: ["Content-Type": "application/pdf", "X-PDFStudio-Report": Data(report.utf8).base64EncodedString()], body: redacted)
        let server = PDFStudioServer(baseURL: URL(string: "https://pdf.example.test/api")!, session: StubProtocol.session())

        let (result, r) = try await doc.applyRedactions(using: server)
        XCTAssertEqual(r, PDFStudioServer.RedactReport(pages: [0, 1], regions: 3, annotationsRemoved: 0, sanitized: ["metadata"], ocrPages: []))
        XCTAssertEqual(result.name, "Report-redacted.pdf")
        XCTAssertEqual(result.pageCount, 2)
        XCTAssertEqual(doc.annotations.count, 4, "the original document is unchanged")

        let (req, body) = try XCTUnwrap(StubProtocol.requests.first)
        XCTAssertEqual(req.url?.absoluteString, "https://pdf.example.test/api/redact")
        let parts = formParts(body, contentType: req.value(forHTTPHeaderField: "Content-Type")!)
        let regions = try JSONDecoder().decode([PDFStudioServer.RedactRegion].self, from: parts["regions"]!.data)
        XCTAssertEqual(regions, doc.redactionRegions())
        // the uploaded file keeps the other annotations (editable) but not the redaction marks
        let uploaded = try XCTUnwrap(StudioDocument(data: parts["file"]!.data, name: "u.pdf"))
        XCTAssertEqual(uploaded.annotations.map(\.kind), [.rect])
        XCTAssertEqual(doc.pdf.page(at: 1)!.annotations.count, 2, "marks are back on the page after the upload")
    }

    func testServerErrorsAreReported() async throws {
        let doc = try document()
        let server = PDFStudioServer(baseURL: URL(string: "http://localhost:8787")!, session: StubProtocol.session())
        StubProtocol.reply = .init(status: 413, body: Data(#"{"error":"File is larger than 50 MB."}"#.utf8))
        do { _ = try await doc.applyRedactions(using: server); XCTFail("expected an error") } catch let e as PDFStudioServerError {
            XCTAssertEqual(e, PDFStudioServerError(message: "File is larger than 50 MB.", status: 413))
        }
        StubProtocol.reply = .init(status: 502, body: Data("Bad gateway".utf8))
        do { _ = try await doc.applyRedactions(using: server); XCTFail("expected an error") } catch let e as PDFStudioServerError {
            XCTAssertEqual(e.message, "Server error 502")
        }
        StubProtocol.reply = .init(fail: true)
        do { _ = try await doc.applyRedactions(using: server); XCTFail("expected an error") } catch let e as PDFStudioServerError {
            XCTAssertEqual(e.message, "Can't reach the PDF Studio server at http://localhost:8787. Is it running?")
        }
        StubProtocol.reply = .init(status: 200, body: Data("<html>".utf8))
        do { _ = try await doc.applyRedactions(using: server); XCTFail("expected an error") } catch let e as PDFStudioServerError {
            XCTAssertEqual(e.message, "The server did not return a PDF.")
        }
        let empty = try XCTUnwrap(StudioDocument(data: Fixtures.pdf(), name: "e.pdf"))
        do { _ = try await empty.applyRedactions(using: server); XCTFail("expected an error") } catch let e as PDFStudioServerError {
            XCTAssertEqual(e.message, "There are no redaction marks to apply.")
        }
        XCTAssertEqual(StubProtocol.requests.count, 4, "nothing sent without marks")
    }

    func testServerAddressParsing() {
        XCTAssertEqual(PDFStudioServer(string: " localhost:8787/ ")?.baseURL.absoluteString, "http://localhost:8787")
        XCTAssertEqual(PDFStudioServer(string: "https://pdf.example.test/base//")?.baseURL.absoluteString, "https://pdf.example.test/base")
        XCTAssertNil(PDFStudioServer(string: ""))
        XCTAssertNil(PDFStudioServer(string: "ftp://x"))
    }

    /// End to end against a running server (`server/run.sh`): set PDFSTUDIO_SERVER_URL, e.g. http://localhost:8787.
    func testAgainstARunningServer() async throws {
        guard let url = ProcessInfo.processInfo.environment["PDFSTUDIO_SERVER_URL"], let server = PDFStudioServer(string: url) else {
            throw XCTSkip("PDFSTUDIO_SERVER_URL not set")
        }
        let doc = try XCTUnwrap(StudioDocument(data: Fixtures.pdf(pages: 2, rotation: 90), name: "live.pdf"))
        // the fixture's text line sits at PDF (72, 700) on every page; mark it on page 1 only, as displayed
        let g = doc.geometry(page: 0)
        doc.add(Annotation(page: 0, kind: .redact, color: "#e5484d", rect: g.toPage(CGRect(x: 60, y: 690, width: 320, height: 30)), author: "User 1"))
        doc.add(Annotation(page: 1, kind: .rect, color: "#1f6feb", rect: Box(x: 300, y: 300, w: 50, h: 50), author: "User 1"))
        XCTAssertTrue(doc.pdf.page(at: 0)!.string?.contains("Sample page 1") == true)
        let health = try await server.health()
        XCTAssertTrue(health.features.redact)
        let (out, report) = try await doc.applyRedactions(using: server)
        XCTAssertEqual(report.pages, [0])
        XCTAssertEqual(report.regions, 1)
        XCTAssertFalse(out.pdf.page(at: 0)!.string?.contains("Sample page 1") ?? false, "text under the mark removed")
        XCTAssertTrue(out.pdf.page(at: 1)!.string?.contains("Sample page 2") == true, "other pages untouched")
        XCTAssertEqual(out.pdf.page(at: 0)!.rotation, 90)
        XCTAssertEqual(out.annotations.map(\.kind), [.rect], "other annotations kept, marks gone")
    }
}
