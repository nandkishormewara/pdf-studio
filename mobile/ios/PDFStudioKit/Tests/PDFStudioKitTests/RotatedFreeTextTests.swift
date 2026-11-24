import CoreGraphics
import PDFKit
import XCTest
@testable import PDFStudioKit

/// Free text on rotated pages must read upright as displayed (like the web, which draws it in display space),
/// both when PDFKit renders the live page (our `draw`; `redInk` uses `PDFPage.thumbnail`, which on iOS calls it in
/// display space rather than PDF space) and in saved files (the appearance PDFKit writes).
@MainActor
final class RotatedFreeTextTests: XCTestCase {
    private let box = Box(x: 60, y: 80, w: 260, h: 30)

    private func document(rotation: Int) throws -> StudioDocument {
        let doc = try XCTUnwrap(StudioDocument(data: Fixtures.pdf(pages: 1, rotation: rotation, crop: CGRect(x: 20, y: 30, width: 560, height: 720)), name: "r.pdf"))
        doc.add(Annotation(page: 0, kind: .freetext, color: "#ff0000", rect: box, text: "MMMMMMMMMMMMMMMMMM", fontSize: 12, author: "User 1"))
        return doc
    }

    func testFreeTextIsUprightOnScreen() throws {
        for rotation in [0, 90, 180, 270] {
            let doc = try document(rotation: rotation)
            let ink = try XCTUnwrap(redInk(doc.pdf.page(at: 0)!), "rot \(rotation): no text drawn")
            check(ink, rotation, "screen")
        }
    }

    func testFreeTextIsUprightInSavedFiles() throws {
        for rotation in [0, 90, 180, 270] {
            let doc = try document(rotation: rotation)
            for mode in [StudioDocument.SaveMode.editable, .flattened] {
                let data = try XCTUnwrap(doc.pdfData(mode))
                // a plain PDFKit reader draws the file's own appearance streams (no PDF Studio objects involved)
                let plain = try XCTUnwrap(PDFDocument(data: data))
                if mode == .editable {
                    for a in plain.page(at: 0)!.annotations { a.removeValue(forAnnotationKey: AnnotationBridge.jsonKey) }
                }
                let ink = try XCTUnwrap(redInk(plain.page(at: 0)!), "rot \(rotation) \(mode): no text drawn")
                check(ink, rotation, "\(mode)")
            }
        }
    }

    /// Other marks drawn by PDF Studio (stamps, measurements) go through the same drawing path.
    func testStampsAndMeasurementsKeepTheirPlaceOnRotatedPages() throws {
        for rotation in [90, 180, 270] {
            let doc = try XCTUnwrap(StudioDocument(data: Fixtures.pdf(pages: 1, rotation: rotation, crop: CGRect(x: 20, y: 30, width: 560, height: 720)), name: "r.pdf"))
            doc.add(Annotation(page: 0, kind: .stamp, color: "#ff0000", strokeWidth: 2, rect: box, text: "APPROVED", author: "User 1"))
            let ink = try XCTUnwrap(redInk(doc.pdf.page(at: 0)!))
            assertClose(ink.minX, box.x, 2, "rot \(rotation) stamp x"); assertClose(ink.minY, box.y, 2, "rot \(rotation) stamp y")
            assertClose(ink.width, box.w, 3, "rot \(rotation) stamp w"); assertClose(ink.height, box.h, 3, "rot \(rotation) stamp h")
        }
    }

    /// XFDF `rotation` is relative to the unrotated page (Acrobat and WebViewer write the page's rotation for upright
    /// text): on a page turned 90°, rotation="90" is upright as displayed, as on the web.
    func testXFDFRotationOnARotatedPageIsUpright() throws {
        let doc = try XCTUnwrap(StudioDocument(data: Fixtures.pdf(pages: 1, rotation: 90, crop: CGRect(x: 20, y: 30, width: 560, height: 720)), name: "r.pdf"))
        let g = doc.geometry(page: 0)
        let r = g.toPDF(box)
        try doc.mergeXFDF(##"<?xml version="1.0"?><xfdf xmlns="http://ns.adobe.com/xfdf/"><annots><freetext page="0" rect="\##(r.minX),\##(r.minY),\##(r.maxX),\##(r.maxY)" rotation="90" name="x1" title="User 1" TextColor="#FF0000" FontSize="12" width="0"><contents>MMMMMMMMMMMMMMMMMM</contents></freetext></annots></xfdf>"##)
        XCTAssertNil(doc.annotations.first?.rotation)
        check(try XCTUnwrap(redInk(doc.pdf.page(at: 0)!)), 90, "xfdf")
    }

    private func check(_ ink: CGRect, _ rotation: Int, _ what: String, file: StaticString = #filePath, line: UInt = #line) {
        // one line of wide text: as displayed it is much wider than tall, and inside the box
        XCTAssertGreaterThan(ink.width, ink.height * 3, "rot \(rotation) \(what): text not upright, ink \(ink)", file: file, line: line)
        let slack = 3.0
        XCTAssertGreaterThanOrEqual(ink.minX, box.x - slack, "rot \(rotation) \(what): ink \(ink)", file: file, line: line)
        XCTAssertGreaterThanOrEqual(ink.minY, box.y - slack, "rot \(rotation) \(what): ink \(ink)", file: file, line: line)
        XCTAssertLessThanOrEqual(ink.maxX, box.maxX + slack, "rot \(rotation) \(what): ink \(ink)", file: file, line: line)
        XCTAssertLessThanOrEqual(ink.maxY, box.maxY + slack, "rot \(rotation) \(what): ink \(ink)", file: file, line: line)
        // text starts at the box's top-left as displayed
        XCTAssertLessThan(ink.minX - box.x, 12, "rot \(rotation) \(what): text not at the left, ink \(ink)", file: file, line: line)
        XCTAssertLessThan(ink.minY - box.y, 12, "rot \(rotation) \(what): text not at the top, ink \(ink)", file: file, line: line)
    }
}

/// Renders a page as displayed (rotation applied, 1 px per point, origin top-left) and returns the bounds of
/// strongly red pixels in page units.
@MainActor
func redInk(_ page: PDFPage) -> CGRect? {
    let g = PageGeometry(crop: page.bounds(for: .cropBox), rotation: page.rotation)
    let (w, h) = (Int(g.size.width.rounded()), Int(g.size.height.rounded()))
    // PDFKit's own "as displayed" rendering (rotation and crop applied)
    #if canImport(UIKit)
    guard let image = page.thumbnail(of: g.size, for: .cropBox).cgImage else { return nil }
    #else
    guard let image = page.thumbnail(of: g.size, for: .cropBox).cgImage(forProposedRect: nil, context: nil, hints: nil) else { return nil }
    #endif
    guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                              space: CGColorSpace(name: CGColorSpace.sRGB)!,
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
    ctx.setFillColor(CGColor(gray: 1, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
    guard let px = ctx.data?.assumingMemoryBound(to: UInt8.self) else { return nil }
    var (x0, y0, x1, y1) = (Int.max, Int.max, Int.min, Int.min)
    for row in 0..<h {
        for col in 0..<w {
            let o = row * w * 4 + col * 4
            let (r, gg, b) = (Int(px[o]), Int(px[o + 1]), Int(px[o + 2]))
            guard r > 180, gg < 110, b < 110 else { continue }
            // bitmap memory is top row first
            x0 = min(x0, col); x1 = max(x1, col); y0 = min(y0, row); y1 = max(y1, row)
        }
    }
    guard x0 <= x1 else { return nil }
    return CGRect(x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1)
}
