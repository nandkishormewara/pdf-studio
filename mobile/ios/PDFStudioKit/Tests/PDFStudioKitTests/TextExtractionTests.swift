import Foundation
import XCTest
@testable import PDFStudioKit

@MainActor
final class TextExtractionTests: XCTestCase {
    func testLinesWordsAndFonts() throws {
        let doc = try XCTUnwrap(StudioDocument(data: Fixtures.pdf(pages: 2), name: "s.pdf"))
        let pages = doc.extractText()
        XCTAssertEqual(pages.map(\.page), [1, 2])
        XCTAssertEqual(pages[0].width, 612)
        XCTAssertEqual(pages[0].height, 792)
        let line = try XCTUnwrap(pages[0].lines.first)
        XCTAssertEqual(line.text, "Sample page 1 for PDF Studio")
        XCTAssertEqual(line.words.map(\.text), ["Sample", "page", "1", "for", "PDF", "Studio"])
        XCTAssertTrue(line.font.hasPrefix("Helvetica"), line.font)
        XCTAssertEqual(line.size, 14, accuracy: 0.5)
        // drawn at x 72, baseline 700 from the bottom: ~92 from the top, ascender above it
        XCTAssertEqual(line.box.x, 72, accuracy: 1.5)
        XCTAssertTrue((70...92).contains(line.box.y), "\(line.box)")
        XCTAssertGreaterThan(line.words[1].box.x, line.words[0].box.maxX)
    }

    func testRotatedPageUsesDisplayedSize() throws {
        let doc = try XCTUnwrap(StudioDocument(data: Fixtures.pdf(pages: 1, rotation: 90), name: "r.pdf"))
        let page = try XCTUnwrap(doc.extractText().first)
        XCTAssertEqual(page.width, 792)
        XCTAssertEqual(page.height, 612)
        let box = try XCTUnwrap(page.lines.first?.box)
        XCTAssertGreaterThan(box.h, box.w, "the line runs downwards on a page turned 90°")
    }

    func testPlainTextAndJSON() throws {
        let doc = try XCTUnwrap(StudioDocument(data: Fixtures.pdf(pages: 1), name: "s.pdf"))
        XCTAssertEqual(doc.extractPlainText(), "===== Page 1 =====\nSample page 1 for PDF Studio\n")
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: doc.extractTextJSON()) as? [String: Any])
        XCTAssertEqual(json["format"] as? String, "pdf-studio-text")
        let pages = try XCTUnwrap(json["pages"] as? [[String: Any]])
        let lines = try XCTUnwrap(pages.first?["lines"] as? [[String: Any]])
        XCTAssertEqual((lines.first?["words"] as? [Any])?.count, 6)
    }
}
