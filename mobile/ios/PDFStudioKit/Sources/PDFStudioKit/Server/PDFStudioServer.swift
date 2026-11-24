import Foundation

/// Client for the PDF Studio processing server (`server/`), the counterpart of the web SDK's `PdfServer`
/// (web/src/sdk/server.ts). Requests and responses are the same as the web client's.
///
/// ```swift
/// let server = PDFStudioServer(baseURL: URL(string: "https://pdf.example.test")!)
/// let (redacted, report) = try await document.applyRedactions(using: server)
/// ```
public struct PDFStudioServer: Sendable {
    public let baseURL: URL
    public let session: URLSession

    public init(baseURL: URL, session: URLSession = .shared) {
        // like the web client: no trailing slash, paths are appended as "/redact"
        var s = baseURL.absoluteString
        while s.hasSuffix("/") { s.removeLast() }
        self.baseURL = URL(string: s) ?? baseURL
        self.session = session
    }

    /// From a user-entered address ("localhost:8787", "https://host/pdf"); nil for an empty or unusable string.
    public init?(string: String, session: URLSession = .shared) {
        var s = string.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return nil }
        if !s.contains("://") { s = "http://" + s }
        guard let url = URL(string: s), let scheme = url.scheme?.lowercased(), ["http", "https"].contains(scheme), url.host != nil else { return nil }
        self.init(baseURL: url, session: session)
    }

    // MARK: - Redaction

    /// One page's redaction areas, in PDF user space (`[x1, y1, x2, y2]`, as the server expects).
    public struct RedactRegion: Codable, Equatable, Sendable {
        public var page: Int
        public var rects: [[Double]]
        /// Exact text to remove near a mark; the server redacts its precise glyph boxes.
        public var texts: [RedactText]
        public init(page: Int, rects: [[Double]], texts: [RedactText] = []) { self.page = page; self.rects = rects; self.texts = texts }
    }

    public struct RedactText: Codable, Equatable, Sendable {
        public var text: String
        public var near: [Double]
        public init(text: String, near: [Double]) { self.text = text; self.near = near }
    }

    /// The server's `X-PDFStudio-Report` for `/redact`.
    public struct RedactReport: Codable, Equatable, Sendable {
        public var pages: [Int]
        public var regions: Int
        public var annotationsRemoved: Int
        public var sanitized: [String]
        public var ocrPages: [Int]
        public init(pages: [Int] = [], regions: Int = 0, annotationsRemoved: Int = 0, sanitized: [String] = [], ocrPages: [Int] = []) {
            self.pages = pages; self.regions = regions; self.annotationsRemoved = annotationsRemoved; self.sanitized = sanitized; self.ocrPages = ocrPages
        }
    }

    /// Sends `pdf` to `POST /redact` and returns the redacted file and the server's report.
    /// `sanitize` (default true) also removes metadata, JavaScript, attachments and other hidden content.
    public func redact(pdf: Data, regions: [RedactRegion], sanitize: Bool = true, ocrLanguages: [String] = []) async throws -> (pdf: Data, report: RedactReport) {
        let request = try redactRequest(pdf: pdf, regions: regions, sanitize: sanitize, ocrLanguages: ocrLanguages)
        let (data, response) = try await send(request)
        let report = (response.value(forHTTPHeaderField: "X-PDFStudio-Report"))
            .flatMap { Data(base64Encoded: $0) }
            .flatMap { try? JSONDecoder().decode(RedactReport.self, from: $0) } ?? RedactReport()
        guard data.starts(with: Data("%PDF".utf8)) || data.prefix(1024).range(of: Data("%PDF".utf8)) != nil else {
            throw PDFStudioServerError(message: "The server did not return a PDF.")
        }
        return (data, report)
    }

    /// The multipart request `redact` sends (fields `file`, `regions`, `sanitize`, `ocr_languages`, as the web client).
    public func redactRequest(pdf: Data, regions: [RedactRegion], sanitize: Bool = true, ocrLanguages: [String] = []) throws -> URLRequest {
        var form = MultipartForm()
        form.file("file", filename: "doc.pdf", type: "application/pdf", data: pdf)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        form.field("regions", String(decoding: try encoder.encode(regions), as: UTF8.self))
        form.field("sanitize", sanitize ? "true" : "false")
        if !ocrLanguages.isEmpty { form.field("ocr_languages", ocrLanguages.joined(separator: "+")) }
        return form.request(url: baseURL.appendingPathComponent("redact"))
    }

    // MARK: - Health

    public struct Health: Decodable, Sendable {
        public struct Features: Decodable, Sendable {
            public var redact: Bool
            public var ocr: Bool?
            public var sign: Bool?
        }
        public var ok: Bool
        public var version: String
        public var features: Features
        public var ocrLanguages: [String]?
        public var maxUploadMb: Int?
    }

    /// `GET /health`: whether the server is reachable and what it can do.
    public func health(timeout: TimeInterval = 2.5) async throws -> Health {
        var request = URLRequest(url: baseURL.appendingPathComponent("health"))
        request.timeoutInterval = timeout
        let (data, _) = try await send(request)
        do { return try JSONDecoder().decode(Health.self, from: data) } catch {
            throw PDFStudioServerError(message: "Not a PDF Studio server: \(baseURL.absoluteString)")
        }
    }

    // MARK: - Transport

    private func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let data: Data, response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw PDFStudioServerError(message: "Can't reach the PDF Studio server at \(baseURL.absoluteString). Is it running?")
        }
        guard let http = response as? HTTPURLResponse else { throw PDFStudioServerError(message: "Unexpected response from the server.") }
        guard (200..<300).contains(http.statusCode) else {
            throw PDFStudioServerError(message: Self.errorMessage(data, status: http.statusCode), status: http.statusCode)
        }
        return (data, http)
    }

    /// `{"error": "…"}` (or FastAPI's `detail`) from an error response, as the web client reads it.
    static func errorMessage(_ data: Data, status: Int) -> String {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return "Server error \(status)" }
        let v = obj["error"] ?? obj["detail"]
        if let s = v as? String { return s }
        if let v, JSONSerialization.isValidJSONObject(v), let d = try? JSONSerialization.data(withJSONObject: v) { return String(decoding: d, as: UTF8.self) }
        return "Server error \(status)"
    }
}

public struct PDFStudioServerError: LocalizedError, Equatable, Sendable {
    public var message: String
    /// HTTP status, when the server answered.
    public var status: Int?
    public init(message: String, status: Int? = nil) { self.message = message; self.status = status }
    public var errorDescription: String? { message }
}

/// multipart/form-data body, as a browser's FormData sends it.
struct MultipartForm {
    let boundary = "PDFStudio-" + UUID().uuidString
    private(set) var body = Data()

    mutating func field(_ name: String, _ value: String) {
        body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n".utf8))
    }

    mutating func file(_ name: String, filename: String, type: String, data: Data) {
        body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"; filename=\"\(filename)\"\r\nContent-Type: \(type)\r\n\r\n".utf8))
        body.append(data)
        body.append(Data("\r\n".utf8))
    }

    func request(url: URL) -> URLRequest {
        var r = URLRequest(url: url)
        r.httpMethod = "POST"
        r.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        var b = body
        b.append(Data("--\(boundary)--\r\n".utf8))
        r.httpBody = b
        return r
    }
}
