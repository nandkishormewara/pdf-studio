import XCTest
@testable import PDFStudioKit

/// Creating measurements: same scale maths and JSON as web/src/sdk/measure.ts and PageView.
final class MeasureToolTests: XCTestCase {
    func testDefaultScaleMatchesWeb() {
        let s = MeasureScaleSetting.default
        XCTAssertEqual(s.summary, "1 in = 1 in")
        XCTAssertEqual(s.measureScale, MeasureScale(factor: 1 / 72.0, unit: "in", precision: 2))
    }

    func testScaleFactorForEveryPaperUnit() {
        // web: factor = worldValue / (paperValue * PAPER_UNITS[paperUnit])
        assertClose(MeasureScaleSetting(paperValue: 1, paperUnit: "cm", worldValue: 2, worldUnit: "m").measureScale.factor, 2 / (72 / 2.54), 1e-12)
        assertClose(MeasureScaleSetting(paperValue: 10, paperUnit: "mm", worldValue: 1, worldUnit: "km").measureScale.factor, 1 / (10 * 72 / 25.4), 1e-12)
        assertClose(MeasureScaleSetting(paperValue: 2, paperUnit: "pt", worldValue: 1, worldUnit: "ft").measureScale.factor, 0.5, 1e-12)
        assertClose(MeasureScaleSetting(paperValue: 1, paperUnit: "furlong", worldValue: 72, worldUnit: "in").measureScale.factor, 1, 1e-12, "unknown unit falls back to in")
        XCTAssertEqual(MeasureScaleSetting(paperValue: 0.5, paperUnit: "in", worldValue: 10, worldUnit: "ft", precision: 1).summary, "0.5 in = 10 ft")
    }

    func testDistanceFromADrag() throws {
        let scale = MeasureScaleSetting(paperValue: 1, paperUnit: "in", worldValue: 10, worldUnit: "ft").measureScale
        let a = try XCTUnwrap(Measure.distance(page: 1, from: Pt(x: 72, y: 100), to: Pt(x: 216, y: 100), scale: scale,
                                               color: "#1f6feb", strokeWidth: 2, author: "User 1"))
        XCTAssertEqual(a.kind, .distance)
        XCTAssertEqual(a.points, [Pt(x: 72, y: 100), Pt(x: 216, y: 100)])
        XCTAssertEqual(a.opacity, 1)
        XCTAssertEqual(Measure.label(a), "20.00 ft")
        XCTAssertNil(Measure.distance(page: 0, from: Pt(x: 10, y: 10), to: Pt(x: 13, y: 12), scale: scale, color: "#000000", strokeWidth: 2, author: "User 1"))
    }

    func testPerimeterAndAreaFromTaps() throws {
        let scale = MeasureScaleSetting.default.measureScale
        XCTAssertNil(MeasureDraft(kind: .distance, page: 0))
        var p = try XCTUnwrap(MeasureDraft(kind: .perimeter, page: 2))
        XCTAssertTrue(p.add(Pt(x: 0, y: 0)))
        XCTAssertFalse(p.canFinish)
        XCTAssertNil(p.annotation(scale: scale, color: "#000000", strokeWidth: 2, author: "User 1"))
        XCTAssertFalse(p.add(Pt(x: 1, y: 1)), "a double tap does not add a second vertex")
        p.add(Pt(x: 72, y: 0)); p.add(Pt(x: 72, y: 72))
        XCTAssertEqual(p.label(scale: scale), "2.00 in")
        let perimeter = try XCTUnwrap(p.annotation(scale: scale, color: "#e5484d", strokeWidth: 2, author: "User 1"))
        XCTAssertEqual(perimeter.kind, .perimeter)
        XCTAssertEqual(perimeter.page, 2)
        XCTAssertEqual(perimeter.points?.count, 3)
        XCTAssertEqual(Measure.label(perimeter), "2.00 in")

        var area = try XCTUnwrap(MeasureDraft(kind: .area, page: 0))
        area.add(Pt(x: 0, y: 0)); area.add(Pt(x: 144, y: 0))
        XCTAssertFalse(area.canFinish)
        area.add(Pt(x: 144, y: 72)); area.add(Pt(x: 9, y: 9))
        area.removeLast()
        XCTAssertEqual(area.points.count, 3)
        let a = try XCTUnwrap(area.annotation(scale: scale, color: "#e5484d", strokeWidth: 2, author: "User 1"))
        XCTAssertEqual(Measure.label(a), "1.00 in²")
    }

    /// The JSON written for a new measurement is what the web writes: kind, points, measure {factor, unit, precision}.
    func testMeasurementJSONMatchesWebShape() throws {
        let a = try XCTUnwrap(Measure.distance(page: 0, from: Pt(x: 0, y: 0), to: Pt(x: 72, y: 0), scale: MeasureScaleSetting.default.measureScale,
                                               color: "#e5484d", strokeWidth: 2, author: "User 1"))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(a)) as? [String: Any])
        XCTAssertEqual(json["kind"] as? String, "distance")
        XCTAssertEqual((json["points"] as? [[String: Double]])?.first, ["x": 0, "y": 0])
        let m = try XCTUnwrap(json["measure"] as? [String: Any])
        XCTAssertEqual(Set(m.keys), ["factor", "unit", "precision"])
        XCTAssertEqual(m["unit"] as? String, "in")
        XCTAssertEqual(m["precision"] as? Int, 2)
    }

    func testCalibrateMatchesWeb() throws {
        // a line drawn over something known to be 12 ft long
        let a = Annotation(page: 0, kind: .distance, color: "#000000", points: [Pt(x: 0, y: 0), Pt(x: 144, y: 0)],
                           measure: MeasureScaleSetting.default.measureScale, author: "User 1")
        let s = MeasureScaleSetting(paperValue: 2, paperUnit: "cm", worldValue: 1, worldUnit: "ft", precision: 1)
        let (next, factor) = try XCTUnwrap(s.calibrated(to: a, realLength: 12))
        assertClose(factor, 12 / 144.0, 1e-12)
        XCTAssertEqual(next.summary, "1 in = 6 ft")
        XCTAssertEqual(next.precision, 1)
        var b = a; b.measure = MeasureScale(factor: factor, unit: next.worldUnit, precision: next.precision)
        XCTAssertEqual(Measure.label(b), "12.0 ft")
        XCTAssertNil(s.calibrated(to: a, realLength: 0))
    }

    func testScaleSettingDecodesPartialWebSettings() throws {
        let s = try JSONDecoder().decode(MeasureScaleSetting.self, from: Data(#"{"worldValue":10,"worldUnit":"ft"}"#.utf8))
        XCTAssertEqual(s, MeasureScaleSetting(paperValue: 1, paperUnit: "in", worldValue: 10, worldUnit: "ft", precision: 2))
        XCTAssertEqual(try JSONDecoder().decode(MeasureScaleSetting.self, from: JSONEncoder().encode(s)), s)
    }
}
