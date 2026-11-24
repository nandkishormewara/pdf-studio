import PDFKit
import XCTest
@testable import PDFStudioKit

/// Marks drawn by PDF Studio itself (stamps, measurements, signatures) must be burned into a flattened save as they
/// look on screen, not as PDFKit's generic stamp icon.
@MainActor
final class FlattenedMarksTests: XCTestCase {
    private func mark(_ kind: AnnotationKind, page: Int = 0, rect: Box? = nil, points: [Pt]? = nil, text: String? = nil) -> Annotation {
        var a = Annotation(page: page, kind: kind, color: "#e5484d", author: "Reviewer")
        a.rect = rect; a.points = points; a.text = text; a.strokeWidth = 2
        if kind.isMeasurement { a.measure = MeasureScale(factor: 1 / 72, unit: "in", precision: 2) }
        return a
    }

    /// Red ink on page 0 of a flattened save, read back by plain PDFKit (none of our classes involved).
    private func flattenedRedInk(_ marks: [Annotation], rotation: Int = 0) throws -> (CGRect?, Int) {
        let doc = try XCTUnwrap(StudioDocument(data: Fixtures.pdf(pages: 1, rotation: rotation), name: "f.pdf"))
        for m in marks { doc.add(m) }
        let flat = try XCTUnwrap(PDFDocument(data: try XCTUnwrap(doc.pdfData(.flattened))))
        let page = try XCTUnwrap(flat.page(at: 0))
        return (redInk(page), page.annotations.count)
    }

    func testStampIsBurnedInAsDrawn() throws {
        let r = Box(x: 100, y: 100, w: 160, h: 50)
        let (ink, left) = try flattenedRedInk([mark(.stamp, rect: r, text: "APPROVED")])
        XCTAssertEqual(left, 0, "flattened file keeps no annotations")
        let box = try XCTUnwrap(ink, "the stamp's red border and label are on the page")
        XCTAssertEqual(box.minX, r.x, accuracy: 4); XCTAssertEqual(box.minY, r.y, accuracy: 4)
        XCTAssertEqual(box.width, r.w, accuracy: 6); XCTAssertEqual(box.height, r.h, accuracy: 6)
    }

    func testMeasurementIsBurnedInAsDrawn() throws {
        let (ink, _) = try flattenedRedInk([mark(.distance, points: [Pt(x: 100, y: 300), Pt(x: 400, y: 300)])])
        let box = try XCTUnwrap(ink, "the distance line and its label are on the page")
        XCTAssertEqual(box.minX, 100, accuracy: 6); XCTAssertEqual(box.maxX, 400, accuracy: 6)
        XCTAssertEqual(box.midY, 300, accuracy: 14)
    }

    func testStampOnRotatedPageIsBurnedInUpright() throws {
        let r = Box(x: 120, y: 200, w: 160, h: 50)
        let (ink, _) = try flattenedRedInk([mark(.stamp, rect: r, text: "OK")], rotation: 90)
        let box = try XCTUnwrap(ink)
        // as displayed, the stamp keeps its displayed rect (wider than tall)
        XCTAssertEqual(box.minX, r.x, accuracy: 4); XCTAssertEqual(box.minY, r.y, accuracy: 4)
        XCTAssertGreaterThan(box.width, box.height)
    }
}
