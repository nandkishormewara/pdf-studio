import Foundation
import XCTest
@testable import PDFStudioKit

/// mobile/shared/reading-order/cases.json: the same cases the web, server and Android tests run.
final class ReadingOrderTests: XCTestCase {
    struct Case: Decodable {
        let name: String
        let lines: [TextLine]
        let tables: [TableBox]
        let expected: [String]
    }

    private func cases() throws -> [Case] {
        struct File: Decodable { let cases: [Case] }
        return try JSONDecoder().decode(File.self, from: Fixtures.data("reading-order/cases.json")).cases
    }

    func testSharedCases() throws {
        let all = try cases()
        XCTAssertEqual(all.count, 4)
        for c in all {
            XCTAssertEqual(ReadingOrder.order(c.lines, tables: c.tables).map(\.text), c.expected, c.name)
        }
    }

    func testDeviceTableDetectionGivesTheSameOrder() throws {
        // what the SDK's own export does: borderless tables found on the device, no ruling lines
        for c in try cases() where ["newsletter", "merged-rows"].contains(c.name) {
            let found = StreamTables.detect(c.lines.flatMap(\.words)).map(\.tableBox)
            XCTAssertEqual(ReadingOrder.order(c.lines, tables: found).map(\.text), c.expected, c.name)
        }
    }

    func testBorderlessTablesMatchTheServer() throws {
        struct Cell: Decodable { let row: Int, col: Int, colSpan: Int, text: String }
        struct Expected: Decodable { let rows: Int, cols: Int, cells: [Cell] }
        struct Page: Decodable { let words: [TextWord]; let expectedWithoutLines: [Expected] }
        let page = try JSONDecoder().decode(Page.self, from: Fixtures.data("tables/tables-page.json"))
        let found = StreamTables.detect(page.words)
        XCTAssertEqual(found.count, page.expectedWithoutLines.count)
        for (t, e) in zip(found, page.expectedWithoutLines) {
            XCTAssertEqual([t.rows, t.cols], [e.rows, e.cols])
            XCTAssertEqual(t.cells.map { "\($0.row),\($0.col),\($0.colSpan) \($0.text)" }, e.cells.map { "\($0.row),\($0.col),\($0.colSpan) \($0.text)" })
        }
    }

    @MainActor
    func testPDFKitPageInReadingOrder() throws {
        // a newsletter drawn in a muddled order; PDFKit also merges rows of a column into one line
        let doc = try XCTUnwrap(StudioDocument(data: Fixtures.data("reading-order/columns.pdf"), name: "columns.pdf"))
        let lines = doc.extractPlainText(pageMarkers: false).split(separator: "\n").map(String.init)
        let numbers = lines.compactMap { l -> String? in
            let p = l.prefix(3)
            return p.count == 3 && p.last == " " && p.prefix(2).allSatisfy(\.isNumber) ? String(p.prefix(2)) : nil
        }
        XCTAssertEqual(numbers, (1...16).map { String(format: "%02d", $0) })
        XCTAssertTrue(lines.contains("User1\t88\t91\t79"), "\(lines)")
    }

    func testRightToLeft() throws {
        let all = try cases()
        XCTAssertTrue(ReadingOrder.isRTL(try XCTUnwrap(all.first { $0.name == "rtl-two-columns" }).lines))
        XCTAssertFalse(ReadingOrder.isRTL(try XCTUnwrap(all.first { $0.name == "newsletter" }).lines))
        XCTAssertEqual(ReadingOrder.order([]), [])
    }
}
