import CoreGraphics
import XCTest
@testable import PDFStudioKit

final class GeometryTests: XCTestCase {
    struct Vectors: Decodable {
        struct Case: Decodable { let crop: [Double]; let rotation: Int; let pdf: [Double]; let page: [Double]; let pageSize: [Double] }
        let cases: [Case]
    }

    func testMatchesPDFJSVectors() throws {
        let v = try JSONDecoder().decode(Vectors.self, from: Fixtures.data("geometry-vectors.json"))
        XCTAssertEqual(v.cases.count, 16)
        for c in v.cases {
            let g = PageGeometry(crop: CGRect(x: c.crop[0], y: c.crop[1], width: c.crop[2] - c.crop[0], height: c.crop[3] - c.crop[1]),
                                 rotation: c.rotation)
            let what = "rot \(c.rotation) pdf \(c.pdf)"
            let p = g.toPage(CGPoint(x: c.pdf[0], y: c.pdf[1]))
            assertClose(p.x, c.page[0], 0.001, what + " → x")
            assertClose(p.y, c.page[1], 0.001, what + " → y")
            let back = g.toPDF(Pt(x: c.page[0], y: c.page[1]))
            assertClose(back.x, c.pdf[0], 0.001, what + " ← x")
            assertClose(back.y, c.pdf[1], 0.001, what + " ← y")
            assertClose(g.size.width, c.pageSize[0], 0.001, what + " width")
            assertClose(g.size.height, c.pageSize[1], 0.001, what + " height")
        }
    }

    func testBoxRoundTripOnEveryRotation() {
        for rot in [0, 90, 180, 270] {
            let g = PageGeometry(crop: CGRect(x: 10, y: 20, width: 500, height: 700), rotation: rot)
            let box = Box(x: 30, y: 40, w: 100, h: 50)
            let back = g.toPage(g.toPDF(box))
            assertClose(back.x, box.x, 0.0001, "rot \(rot) x"); assertClose(back.y, box.y, 0.0001, "rot \(rot) y")
            assertClose(back.w, box.w, 0.0001, "rot \(rot) w"); assertClose(back.h, box.h, 0.0001, "rot \(rot) h")
        }
    }

    func testDisplayTransformMatchesPageUnits() {
        for rot in [0, 90, 180, 270] {
            let g = PageGeometry(crop: CGRect(x: 10, y: 20, width: 500, height: 700), rotation: rot)
            for p in [Pt(x: 0, y: 0), Pt(x: 30, y: 40), Pt(x: 123, y: 456)] {
                let d = g.toPDF(p).applying(g.displayTransform)
                assertClose(d.x, p.x, 0.0001, "rot \(rot) x"); assertClose(d.y, g.size.height - p.y, 0.0001, "rot \(rot) y")
            }
        }
    }

    func testUprightTransformKeepsContentUpright() {
        // On a page rotated 90°, "right" on screen must map to +y in PDF space.
        let g = PageGeometry(crop: CGRect(x: 0, y: 0, width: 612, height: 792), rotation: 90)
        let t = g.uprightTransform(for: Box(x: 100, y: 100, w: 50, h: 20))
        let origin = CGPoint.zero.applying(t), right = CGPoint(x: 1, y: 0).applying(t)
        assertClose(right.y - origin.y, 1, 0.0001, "right → +y")
        assertClose(right.x - origin.x, 0, 0.0001, "no x change")
    }
}

final class ModelTests: XCTestCase {
    func testDecodesSharedSample() throws {
        let file = try AnnotationFile.decode(Fixtures.data("annotations.sample.json"))
        XCTAssertEqual(file.annotations.count, 14)
        XCTAssertEqual(Set(file.annotations.map(\.kind)).count, 14)
        let ft = try XCTUnwrap(file.annotations.first { $0.kind == .freetext })
        XCTAssertEqual(ft.text, "Reviewed by User3\nशुल्क जमा")
        XCTAssertEqual(file.annotations.first { $0.kind == .distance }.map(Measure.label), "3.00 in")
    }

    func testEncodeDecodeIsLossless() throws {
        let file = try AnnotationFile.decode(Fixtures.data("annotations.sample.json"))
        let again = try AnnotationFile.decode(try file.encoded())
        XCTAssertEqual(again.annotations, file.annotations)
    }

    func testUnknownKindsAreSkippedAndWrongFormatRejected() throws {
        let json = ##"{"format":"pdf-studio-annotations","version":3,"annotations":[{"id":"a","page":0,"kind":"hologram","color":"#000000","opacity":1,"strokeWidth":1,"status":"none","author":"x","createdAt":"2026-01-01T00:00:00.000Z","modifiedAt":"2026-01-01T00:00:00.000Z"},{"id":"b","page":0,"kind":"rect","color":"#000000","opacity":1,"strokeWidth":1,"rect":{"x":1,"y":2,"w":3,"h":4},"status":"none","author":"x","createdAt":"2026-01-01T00:00:00.000Z","modifiedAt":"2026-01-01T00:00:00.000Z"}]}"##
        let file = try AnnotationFile.decode(Data(json.utf8))
        XCTAssertEqual(file.annotations.map(\.id), ["b"])
        XCTAssertThrowsError(try AnnotationFile.decode(Data(#"{"format":"other","annotations":[]}"#.utf8)))
    }

    func testMeasureMatchesWeb() {
        let a = Annotation(page: 0, kind: .area, color: "#000000", points: [Pt(x: 0, y: 0), Pt(x: 72, y: 0), Pt(x: 72, y: 72)],
                           measure: MeasureScale(factor: 1 / 72.0, unit: "in", precision: 2), author: "t")
        XCTAssertEqual(Measure.label(a), "0.50 in²")
    }
}
