import PDFKit
import XCTest
@testable import PDFStudioKit

@MainActor
final class DocumentTests: XCTestCase {
    private func sample() throws -> [Annotation] { try AnnotationFile.decode(Fixtures.data("annotations.sample.json")).annotations }

    func testEditableSaveRoundTripIsLossless() throws {
        let doc = try XCTUnwrap(StudioDocument(data: Fixtures.pdf(), name: "t.pdf"))
        XCTAssertEqual(try doc.importJSON(Fixtures.data("annotations.sample.json")), 14)
        let saved = try XCTUnwrap(doc.pdfData(.editable))

        let reopened = try XCTUnwrap(StudioDocument(data: saved, name: "t.pdf"))
        XCTAssertEqual(reopened.importedCount, 14)
        let byID = Dictionary(uniqueKeysWithValues: reopened.annotations.map { ($0.id, $0) })
        for a in try sample() { XCTAssertEqual(byID[a.id], a, "\(a.kind) changed in round trip") }
        // Nothing left behind on the pages: everything became editable again.
        XCTAssertEqual((0..<reopened.pageCount).reduce(0) { $0 + reopened.pdf.page(at: $1)!.annotations.filter { $0.type != "Popup" }.count }, 14)
    }

    func testSavedAnnotationsAreRealPDFAnnotations() throws {
        let doc = try XCTUnwrap(StudioDocument(data: Fixtures.pdf(), name: "t.pdf"))
        try doc.importJSON(Fixtures.data("annotations.sample.json"))
        let plain = try XCTUnwrap(PDFDocument(data: try XCTUnwrap(doc.pdfData())))
        let types = (0..<plain.pageCount).flatMap { plain.page(at: $0)!.annotations.compactMap(\.type) }
        for t in ["Highlight", "Underline", "StrikeOut", "Square", "Circle", "Line", "Ink", "FreeText", "Text", "Stamp"] {
            XCTAssertTrue(types.contains(t), "missing \(t)")
        }
    }

    /// Files from other apps carry no PDF Studio JSON: standard keys must be enough.
    func testImportsAnnotationsFromOtherApps() throws {
        let doc = try XCTUnwrap(StudioDocument(data: Fixtures.pdf(), name: "t.pdf"))
        try doc.importJSON(Fixtures.data("annotations.sample.json"))
        let plain = try XCTUnwrap(PDFDocument(data: try XCTUnwrap(doc.pdfData())))
        for i in 0..<plain.pageCount {
            for a in plain.page(at: i)!.annotations { a.removeValue(forAnnotationKey: AnnotationBridge.jsonKey) }
        }
        let foreign = try XCTUnwrap(StudioDocument(data: try XCTUnwrap(plain.dataRepresentation()), name: "f.pdf"))
        let kinds = Set(foreign.annotations.map(\.kind))
        XCTAssertEqual(kinds, [.highlight, .underline, .strikeout, .rect, .ellipse, .line, .arrow, .ink, .freetext, .note])

        let original = Dictionary(uniqueKeysWithValues: try sample().map { ($0.id, $0) })
        for a in foreign.annotations {
            let o = try XCTUnwrap(original[a.id], "id \(a.id) not preserved via /NM")
            let (ab, ob) = (a.bounds, o.bounds)
            for (x, y, w) in [(ab.x, ob.x, "x"), (ab.y, ob.y, "y"), (ab.w, ob.w, "w"), (ab.h, ob.h, "h")] {
                assertClose(x, y, 1.5, "\(a.kind) \(w)")
            }
        }
        let ft = try XCTUnwrap(foreign.annotations.first { $0.kind == .freetext })
        XCTAssertEqual(ft.text, "Reviewed by User3\nशुल्क जमा")
        XCTAssertEqual(foreign.annotations.first { $0.kind == .note }?.comment, "Please confirm the fee amount")
    }

    func testRotatedAndCroppedPagesKeepGeometry() throws {
        for rotation in [90, 180, 270] {
            let data = Fixtures.pdf(pages: 1, rotation: rotation, crop: CGRect(x: 20, y: 30, width: 560, height: 720))
            let doc = try XCTUnwrap(StudioDocument(data: data, name: "r.pdf"))
            let rect = Annotation(page: 0, kind: .rect, color: "#e5484d", strokeWidth: 2, rect: Box(x: 40, y: 60, w: 120, h: 80), author: "t")
            let ink = Annotation(page: 0, kind: .ink, color: "#111111", paths: [[Pt(x: 50, y: 50), Pt(x: 90, y: 70), Pt(x: 130, y: 55)]], author: "t")
            doc.add(rect); doc.add(ink)

            let plain = try XCTUnwrap(PDFDocument(data: try XCTUnwrap(doc.pdfData())))
            for a in plain.page(at: 0)!.annotations { a.removeValue(forAnnotationKey: AnnotationBridge.jsonKey) }
            let back = try XCTUnwrap(StudioDocument(data: plain.dataRepresentation()!, name: "r.pdf"))
            let r = try XCTUnwrap(back.annotations.first { $0.kind == .rect }?.rect)
            assertClose(r.x, 40, 0.01, "rot \(rotation) x"); assertClose(r.y, 60, 0.01, "rot \(rotation) y")
            assertClose(r.w, 120, 0.01, "rot \(rotation) w"); assertClose(r.h, 80, 0.01, "rot \(rotation) h")
            let p = try XCTUnwrap(back.annotations.first { $0.kind == .ink }?.paths?.first)
            XCTAssertEqual(p.count, 3)
            assertClose(p[1].x, 90, 0.01, "rot \(rotation) ink x"); assertClose(p[1].y, 70, 0.01, "rot \(rotation) ink y")
        }
    }

    func testFlattenedSaveHasNoAnnotationsAndNoRedactionMarks() throws {
        let doc = try XCTUnwrap(StudioDocument(data: Fixtures.pdf(), name: "t.pdf"))
        try doc.importJSON(Fixtures.data("annotations.sample.json"))
        let flat = try XCTUnwrap(PDFDocument(data: try XCTUnwrap(doc.pdfData(.flattened))))
        XCTAssertEqual((0..<flat.pageCount).reduce(0) { $0 + flat.page(at: $1)!.annotations.count }, 0)
        // The editor still has everything, including the redaction mark.
        XCTAssertEqual(doc.annotations.count, 14)
        XCTAssertEqual(doc.pdf.page(at: 1)!.annotations.filter { $0.type != "Popup" }.count, 7)
    }

    func testUndoRedoAndLiveDrag() throws {
        let doc = try XCTUnwrap(StudioDocument(data: Fixtures.pdf(), name: "t.pdf"))
        let a = Annotation(page: 0, kind: .rect, color: "#000000", rect: Box(x: 10, y: 10, w: 20, h: 20), author: "t")
        doc.add(a)
        doc.checkpoint()
        for step in 1...5 { doc.update(a.id, live: true) { $0 = $0.translated(dx: Double(step), dy: 0) } }
        XCTAssertEqual(doc.annotations.first?.rect?.x ?? 0, 25, accuracy: 0.001)
        doc.undo()
        XCTAssertEqual(doc.annotations.first?.rect?.x, 10)
        doc.undo()
        XCTAssertTrue(doc.annotations.isEmpty)
        XCTAssertEqual(doc.pdf.page(at: 0)!.annotations.count, 0)
        doc.redo()
        XCTAssertEqual(doc.pdf.page(at: 0)!.annotations.count, 1)
    }
}
