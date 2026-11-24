import Combine
import Foundation
import PDFKit

/// An open document plus its editable annotations.
///
/// The annotation list (the shared JSON model) is the source of truth. Every model annotation is
/// mirrored by a live PDFKit annotation on its page, so PDFKit handles drawing, zooming and
/// hit-testing, and `pdfData()` writes real, editable PDF annotations.
@MainActor
public final class StudioDocument: ObservableObject {
    public enum SaveMode { case editable, flattened }

    public let pdf: PDFDocument
    public let name: String
    @Published public private(set) var annotations: [Annotation] = []
    @Published public var selectedID: String?
    /// Number of annotations found in the file when it was opened.
    public private(set) var importedCount = 0

    private var past: [[Annotation]] = []
    private var future: [[Annotation]] = []
    private var live: [String: PDFAnnotation] = [:]
    private static let historyLimit = 200

    public var canUndo: Bool { !past.isEmpty }
    public var canRedo: Bool { !future.isEmpty }
    public var pageCount: Int { pdf.pageCount }

    public init?(data: Data, name: String) {
        guard let pdf = PDFDocument(data: data) else { return nil }
        self.pdf = pdf
        self.name = name
        importExisting(names: AnnotationNames(data: data))
    }

    public convenience init?(url: URL) {
        guard let data = try? Data(contentsOf: url) else { return nil }
        self.init(data: data, name: url.lastPathComponent)
    }

    public func geometry(page index: Int) -> PageGeometry {
        guard let page = pdf.page(at: index) else { return PageGeometry(crop: .zero, rotation: 0) }
        return PageGeometry(crop: page.bounds(for: .cropBox), rotation: page.rotation)
    }

    public func annotation(id: String) -> Annotation? { annotations.first { $0.id == id } }

    /// Finds the model annotation behind a PDFKit annotation (e.g. from a hit test).
    public func id(of pdfAnnotation: PDFAnnotation) -> String? {
        live.first { $0.value === pdfAnnotation }?.key
    }

    // MARK: - Editing

    public func add(_ a: Annotation) {
        commit(annotations + [a])
        selectedID = a.id
    }

    public func update(_ id: String, live isLive: Bool = false, _ change: (inout Annotation) -> Void) {
        let next = annotations.map { a -> Annotation in
            guard a.id == id else { return a }
            var c = a
            change(&c)
            c.modifiedAt = Annotation.now()
            return c
        }
        if isLive { apply(next) } else { commit(next) }
    }

    public func remove(_ id: String) {
        commit(annotations.filter { $0.id != id })
        if selectedID == id { selectedID = nil }
    }

    /// Call before a series of `update(..., live: true)` calls (e.g. a drag) so it undoes in one step.
    public func checkpoint() {
        past.append(annotations)
        if past.count > Self.historyLimit { past.removeFirst() }
        future.removeAll()
    }

    public func undo() {
        guard let prev = past.popLast() else { return }
        future.insert(annotations, at: 0)
        apply(prev)
    }

    public func redo() {
        guard !future.isEmpty else { return }
        let next = future.removeFirst()
        past.append(annotations)
        apply(next)
    }

    private func commit(_ next: [Annotation]) {
        checkpoint()
        apply(next)
    }

    /// Makes PDFKit's annotations match `next`, touching only what changed.
    private func apply(_ next: [Annotation]) {
        let old = Dictionary(uniqueKeysWithValues: annotations.map { ($0.id, $0) })
        let keep = Set(next.map(\.id))
        for (id, annot) in live where !keep.contains(id) {
            annot.page?.removeAnnotation(annot)
            live[id] = nil
        }
        for a in next where old[a.id] != a || live[a.id] == nil {
            live[a.id]?.page?.removeAnnotation(live[a.id]!)
            materialize(a)
        }
        annotations = next
        if let s = selectedID, !keep.contains(s) { selectedID = nil }
    }

    private func materialize(_ a: Annotation) {
        guard let page = pdf.page(at: a.page) else { return }
        let annot = AnnotationBridge.makePDFAnnotation(a, geometry: geometry(page: a.page))
        page.addAnnotation(annot)
        live[a.id] = annot
    }

    // MARK: - Import / export

    /// Moves annotations we can edit from the file into the model (like the web SDK).
    private func importExisting(names: AnnotationNames) {
        var names = names
        var found: [Annotation] = []
        for i in 0..<pdf.pageCount {
            guard let page = pdf.page(at: i) else { continue }
            let g = geometry(page: i)
            for annot in page.annotations where annot.type != "Popup" {
                // PDFKit before 27 drops /NM on read: put back the id the file has, so marks keep matching
                // the web, Android and XFDF copies.
                if annot.value(forAnnotationKey: .name) == nil,
                   let nm = (annot.value(forAnnotationKey: AnnotationBridge.nameCopyKey) as? String) ?? names.name(for: annot, page: i) {
                    annot.setValue(nm, forAnnotationKey: .name)
                }
                guard let a = AnnotationBridge.annotation(from: annot, page: i, geometry: g) else { continue }
                // A popup can share its parent's keys; never import the same annotation twice.
                if found.contains(where: { $0.id == a.id }) { page.removeAnnotation(annot); continue }
                page.removeAnnotation(annot)
                if let popup = annot.popup { page.removeAnnotation(popup) }
                found.append(a)
            }
        }
        importedCount = found.count
        for a in found { materialize(a) }
        annotations = found
    }

    public func exportJSON() throws -> Data {
        try AnnotationFile(file: name, annotations: annotations).encoded()
    }

    /// Adds annotations from a PDF Studio JSON file (skipping ids that already exist). Returns how many were added.
    @discardableResult
    public func importJSON(_ data: Data) throws -> Int {
        let file = try AnnotationFile.decode(data)
        let existing = Set(annotations.map(\.id))
        let fresh = file.annotations.filter { !existing.contains($0.id) && $0.page < pdf.pageCount }
        if !fresh.isEmpty { commit(annotations + fresh) }
        return fresh.count
    }

    /// Merges an XFDF document (e.g. reviewer markup from Apryse WebViewer or Acrobat):
    /// adds new annotations, replaces ones with the same id, applies `<delete>` and fills form fields.
    ///
    /// Merges are not undoable by default: they represent markup that came with the document.
    @discardableResult
    public func mergeXFDF(_ xml: String, undoable: Bool = false) throws -> XFDFImport {
        let pageCount = pdf.pageCount
        let geometries = (0..<pageCount).map { geometry(page: $0) }
        let result = try XFDF.parse(xml) { $0 >= 0 && $0 < pageCount ? geometries[$0] : nil }
        let deleted = Set(result.deletedIDs)
        var next = annotations.filter { !deleted.contains($0.id) }
        var fromFile = Set(next.map(\.id))
        for a in result.annotations {
            let i = next.firstIndex(where: { $0.id == a.id }) ?? next.firstIndex(where: { fromFile.contains($0.id) && XFDF.sameMark($0, a) })
            if let i { fromFile.remove(next[i].id); next[i] = a } else { next.append(a) }
        }
        if undoable { commit(next) } else { apply(next) }
        fillFormFields(result.fields)
        return result
    }

    /// All annotations (and optionally form values) as XFDF.
    public func exportXFDF(fields: [String: [String]] = [:]) -> String {
        let pageCount = pdf.pageCount
        let geometries = (0..<pageCount).map { geometry(page: $0) }
        return XFDF.export(annotations, geometry: { $0 >= 0 && $0 < pageCount ? geometries[$0] : nil }, fields: fields)
    }

    private func fillFormFields(_ fields: [String: [String]]) {
        guard !fields.isEmpty else { return }
        for i in 0..<pdf.pageCount {
            for w in pdf.page(at: i)?.annotations ?? [] where w.type == "Widget" {
                guard let name = w.fieldName, let value = fields[name]?.first else { continue }
                switch w.widgetFieldType {
                case .button:
                    let on = value == w.buttonWidgetStateString || ["On", "Yes", "true", "1"].contains(value)
                    w.buttonWidgetState = on ? .onState : .offState
                default:
                    w.widgetStringValue = value
                }
            }
        }
    }

    /// The document with annotations, either as editable PDF annotations or burned into the pages.
    public func pdfData(_ mode: SaveMode = .editable) -> Data? {
        pdfData(mode, redactionMarks: mode == .editable)
    }

    private func pdfData(_ mode: SaveMode, redactionMarks: Bool) -> Data? {
        for a in annotations {
            if let annot = live[a.id] { AnnotationBridge.attachJSON(a, to: annot) }
        }
        // Redaction marks are instructions, never page content: keep them out of flattened output.
        let marks = !redactionMarks ? annotations.filter { $0.kind == .redact }.compactMap { a in live[a.id].map { (a.page, $0) } } : []
        for (_, annot) in marks { annot.page?.removeAnnotation(annot) }
        defer { for (page, annot) in marks { pdf.page(at: page)?.addAnnotation(annot) } }
        switch mode {
        case .editable:
            return pdf.dataRepresentation().map(AnnotationNames.restoringNames(in:))
        case .flattened:
            let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".pdf")
            defer { try? FileManager.default.removeItem(at: url) }
            guard pdf.write(to: url, withOptions: [.burnInAnnotationsOption: true]) else { return nil }
            return try? Data(contentsOf: url)
        }
    }

    // MARK: - Redaction (server)

    /// Redaction marks that `applyRedactions` sends to the server.
    public var redactionMarks: [Annotation] { annotations.filter { $0.kind == .redact && $0.rect != nil } }

    /// The marks as the server's `regions`: one entry per page (in order of first mark), rectangles in PDF user space
    /// `[x1, y1, x2, y2]`, and a mark's `text` (e.g. from search) as text to remove near its rectangle. Same as the web.
    public func redactionRegions() -> [PDFStudioServer.RedactRegion] {
        var regions: [PDFStudioServer.RedactRegion] = []
        for m in redactionMarks {
            guard let rect = m.rect else { continue }
            let r = geometry(page: m.page).toPDF(rect)
            let box = [Double(r.minX), Double(r.minY), Double(r.maxX), Double(r.maxY)]
            var region = regions.first { $0.page == m.page } ?? PDFStudioServer.RedactRegion(page: m.page, rects: [])
            region.rects.append(box)
            if let t = m.text, !t.isEmpty { region.texts.append(.init(text: t, near: box)) }
            if let i = regions.firstIndex(where: { $0.page == m.page }) { regions[i] = region } else { regions.append(region) }
        }
        return regions
    }

    /// Sends the document (every other annotation kept as editable annotations, form values included) with its
    /// redaction marks to a PDF Studio server's `/redact`, and opens the result: content under the marks is
    /// removed for good, and with `sanitize` hidden information (metadata, scripts, attachments…) is cleaned too.
    /// This document is left unchanged; the returned one (named "…-redacted.pdf") is what to save or share.
    public func applyRedactions(using server: PDFStudioServer, sanitize: Bool = true,
                                ocrLanguages: [String] = []) async throws -> (document: StudioDocument, report: PDFStudioServer.RedactReport) {
        let regions = redactionRegions()
        guard !regions.isEmpty else { throw PDFStudioServerError(message: "There are no redaction marks to apply.") }
        guard let upload = pdfData(.editable, redactionMarks: false) else { throw PDFStudioServerError(message: "Couldn't write the document.") }
        let result = try await server.redact(pdf: upload, regions: regions, sanitize: sanitize, ocrLanguages: ocrLanguages)
        let base = name.lowercased().hasSuffix(".pdf") ? String(name.dropLast(4)) : name
        guard let doc = StudioDocument(data: result.pdf, name: base + "-redacted.pdf") else {
            throw PDFStudioServerError(message: "The server returned a PDF that couldn't be opened.")
        }
        return (doc, result.report)
    }
}
