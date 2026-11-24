import CoreGraphics
import CoreText
import Foundation
import PDFKit
@testable import PDFStudioKit

enum Fixtures {
    /// mobile/shared — single source of truth shared with the Android and web test suites.
    static let shared: URL = {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { url.deleteLastPathComponent() }
        return url.appendingPathComponent("shared")
    }()

    static func data(_ name: String) throws -> Data { try Data(contentsOf: shared.appendingPathComponent(name)) }

    /// A plain PDF with `pages` US-Letter pages containing a line of real text each.
    static func pdf(pages: Int = 2, rotation: Int = 0, crop: CGRect? = nil) -> Data {
        let data = NSMutableData()
        var media = CGRect(x: 0, y: 0, width: 612, height: 792)
        let ctx = CGContext(consumer: CGDataConsumer(data: data)!, mediaBox: &media, nil)!
        for i in 0..<pages {
            ctx.beginPDFPage(nil)
            let font = CTFontCreateWithName("Helvetica" as CFString, 14, nil)
            let line = CTLineCreateWithAttributedString(NSAttributedString(string: "Sample page \(i + 1) for PDF Studio", attributes: [
                NSAttributedString.Key(kCTFontAttributeName as String): font,
            ]))
            ctx.textPosition = CGPoint(x: 72, y: 700)
            CTLineDraw(line, ctx)
            ctx.endPDFPage()
        }
        ctx.closePDF()
        guard rotation != 0 || crop != nil, let doc = PDFDocument(data: data as Data) else { return data as Data }
        for i in 0..<doc.pageCount {
            if let crop { doc.page(at: i)?.setBounds(crop, for: .cropBox) }
            doc.page(at: i)?.rotation = rotation
        }
        return doc.dataRepresentation()!
    }
}

func assertClose(_ a: Double, _ b: Double, _ tol: Double = 0.01, _ what: String = "", file: StaticString = #filePath, line: UInt = #line) {
    if abs(a - b) > tol { XCTFail("\(what): \(a) != \(b) (±\(tol))", file: file, line: line) }
}

import XCTest
