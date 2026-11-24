import PDFKit
import XCTest
@testable import PDFStudioKit

@MainActor
final class XFDFTests: XCTestCase {
    struct Expected: Decodable {
        struct Item: Decodable {
            let kind: String; let color: String?; let strokeWidth: Double?; let author: String?
            let firstPoint: [Double]?; let paths: Int?; let pointsInFirstPath: Int?
            let fontSize: Double?; let text: String?; let rect: [Double]?; let opacity: Double?; let comment: String?
        }
        struct AfterAnnots: Decodable { let count: Int; let byId: [String: Item]; let absent: [String]; let fields: [String: String] }
        struct Modified: Decodable { let id: String; let rect: [Double]; let strokeWidth: Double; let color: String }
        struct AfterCommands: Decodable { let count: Int; let added: String; let removed: String; let modified: Modified }
        let afterAnnots: AfterAnnots
        let afterCommands: AfterCommands
    }

    private func xfdf(_ name: String) throws -> String { String(decoding: try Fixtures.data("xfdf/\(name)"), as: UTF8.self) }

    func testApryseWebViewerXFDF() throws {
        let expected = try JSONDecoder().decode(Expected.self, from: Fixtures.data("xfdf/expected.json"))
        let doc = try XCTUnwrap(StudioDocument(data: Fixtures.pdf(pages: 2), name: "hw.pdf"))
        let result = try doc.mergeXFDF(try xfdf("apryse-annots.xfdf"))
        XCTAssertEqual(result.fields["student"], ["Jane Doe"])
        XCTAssertEqual(doc.annotations.count, expected.afterAnnots.count)
        XCTAssertFalse(doc.canUndo, "merged markup should not be undoable")
        for id in expected.afterAnnots.absent { XCTAssertNil(doc.annotation(id: id)) }

        for (id, e) in expected.afterAnnots.byId {
            let a = try XCTUnwrap(doc.annotation(id: id), id)
            XCTAssertEqual(a.kind.rawValue, e.kind, id)
            if let c = e.color { XCTAssertEqual(a.color, c, "\(id) color") }
            if let w = e.strokeWidth { assertClose(a.strokeWidth, w, 0.001, "\(id) width") }
            if let au = e.author { XCTAssertEqual(a.author, au) }
            if let fs = e.fontSize { assertClose(a.fontSize ?? 0, fs, 0.001, "\(id) font") }
            if let t = e.text { XCTAssertEqual(a.text, t, id) }
            if let o = e.opacity { assertClose(a.opacity, o, 0.001, "\(id) opacity") }
            if let c = e.comment { XCTAssertEqual(a.comment, c, id) }
            if let r = e.rect {
                let b = a.kind.isTextMarkup ? try XCTUnwrap(a.rects?.first) : try XCTUnwrap(a.rect, id)
                for (v, x, w) in [(b.x, r[0], "x"), (b.y, r[1], "y"), (b.w, r[2], "w"), (b.h, r[3], "h")] { assertClose(v, x, 0.01, "\(id) \(w)") }
            }
            if let fp = e.firstPoint {
                let p = try XCTUnwrap(a.paths?.first?.first ?? a.points?.first, id)
                assertClose(p.x, fp[0], 0.01, "\(id) fx"); assertClose(p.y, fp[1], 0.01, "\(id) fy")
            }
            if let n = e.paths { XCTAssertEqual(a.paths?.count, n, id) }
            if let n = e.pointsInFirstPath { XCTAssertEqual(a.paths?.first?.count, n, id) }
        }

        // Command-format XFDF on top: add, modify, delete.
        try doc.mergeXFDF(try xfdf("apryse-commands.xfdf"))
        let c = expected.afterCommands
        XCTAssertEqual(doc.annotations.count, c.count)
        XCTAssertNotNil(doc.annotation(id: c.added))
        XCTAssertNil(doc.annotation(id: c.removed))
        let m = try XCTUnwrap(doc.annotation(id: c.modified.id))
        XCTAssertEqual(m.color, c.modified.color)
        assertClose(m.strokeWidth, c.modified.strokeWidth)
        let r = try XCTUnwrap(m.rect)
        assertClose(r.x, c.modified.rect[0]); assertClose(r.y, c.modified.rect[1])
        XCTAssertEqual(doc.annotation(id: c.added)?.page, 1)
    }

    func testReviewerMarkupSurvivesPDFSaveAndShowsOnPages() throws {
        let doc = try XCTUnwrap(StudioDocument(data: Fixtures.pdf(pages: 2), name: "hw.pdf"))
        try doc.mergeXFDF(try xfdf("apryse-annots.xfdf"))
        XCTAssertEqual(doc.pdf.page(at: 0)!.annotations.filter { $0.type != "Popup" }.count, 11)
        let reopened = try XCTUnwrap(StudioDocument(data: try XCTUnwrap(doc.pdfData()), name: "hw.pdf"))
        XCTAssertEqual(Set(reopened.annotations.map(\.id)), Set(doc.annotations.map(\.id)))
    }

    func testExportThenImportRoundTrip() throws {
        let doc = try XCTUnwrap(StudioDocument(data: Fixtures.pdf(pages: 2, rotation: 90), name: "t.pdf"))
        try doc.importJSON(Fixtures.data("annotations.sample.json"))
        let xml = doc.exportXFDF(fields: ["a.b": ["x"]])

        let other = try XCTUnwrap(StudioDocument(data: Fixtures.pdf(pages: 2, rotation: 90), name: "t.pdf"))
        let res = try other.mergeXFDF(xml)
        XCTAssertEqual(res.fields["a.b"], ["x"])
        XCTAssertEqual(other.annotations.count, 14)
        let original = Dictionary(uniqueKeysWithValues: doc.annotations.map { ($0.id, $0) })
        for a in other.annotations {
            let o = try XCTUnwrap(original[a.id])
            XCTAssertEqual(a.kind, o.kind, a.id)
            let (ab, ob) = (a.bounds, o.bounds)
            assertClose(ab.x, ob.x, 0.05, "\(a.id) x"); assertClose(ab.y, ob.y, 0.05, "\(a.id) y")
            assertClose(ab.w, ob.w, 0.05, "\(a.id) w"); assertClose(ab.h, ob.h, 0.05, "\(a.id) h")
        }
        XCTAssertEqual(other.annotations.first { $0.kind == .distance }.map(Measure.label), "3.00 in")
        XCTAssertEqual(other.annotations.first { $0.kind == .freetext }?.text, "Reviewed by User3\nशुल्क जमा")
    }

    func testPdfDates() {
        XCTAssertEqual(XFDF.pdfDateToISO("D:20260115103000+05'30'"), "2026-01-15T05:00:00.000Z")
        XCTAssertEqual(XFDF.pdfDateToISO("D:20260116090000Z"), "2026-01-16T09:00:00.000Z")
    }
}
