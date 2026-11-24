import PDFKit
import PDFStudioKit
import UIKit

@MainActor
enum Samples {
    /// A two-page US-Letter document with real text, generated on the fly.
    static func pdfData(title: String) -> Data {
        let page = CGRect(x: 0, y: 0, width: 612, height: 792)
        return UIGraphicsPDFRenderer(bounds: page).pdfData { ctx in
            let heading: [NSAttributedString.Key: Any] = [.font: UIFont.boldSystemFont(ofSize: 22)]
            let sub: [NSAttributedString.Key: Any] = [.font: UIFont.boldSystemFont(ofSize: 14)]
            let body: [NSAttributedString.Key: Any] = [.font: UIFont.systemFont(ofSize: 11), .foregroundColor: UIColor.darkGray]
            let sections = [
                ("1. Introduction", "PDF Studio is a document viewer built from open-source parts and Apple's PDFKit. Select this text and choose Highlight from the menu, draw with the pen, add notes, stamps and a signature."),
                ("2. Viewing", "Pinch to zoom, scroll through pages, open thumbnails and search the whole document."),
                ("3. Annotating", "Every annotation can be selected, moved, recoloured, commented on and given a review status."),
                ("4. Sharing", "Share a PDF whose annotations stay editable in Acrobat and the web app, or a flattened copy. शुल्क विवरण — हिंदी पाठ भी।"),
            ]
            for p in 1...2 {
                ctx.beginPage()
                NSString(string: "\(title) — page \(p)").draw(at: CGPoint(x: 56, y: 50), withAttributes: heading)
                UIColor.systemBlue.setFill()
                UIRectFill(CGRect(x: 56, y: 84, width: 500, height: 2))
                var y: CGFloat = 104
                for (h, t) in sections {
                    NSString(string: h).draw(at: CGPoint(x: 56, y: y), withAttributes: sub)
                    y += 22
                    let r = NSString(string: t).boundingRect(with: CGSize(width: 500, height: 200), options: .usesLineFragmentOrigin, attributes: body, context: nil)
                    NSString(string: t).draw(with: CGRect(x: 56, y: y, width: 500, height: r.height), options: .usesLineFragmentOrigin, attributes: body, context: nil)
                    y += r.height + 18
                }
                UIColor.lightGray.setStroke()
                UIBezierPath(rect: CGRect(x: 56, y: 450, width: 500, height: 200)).stroke()
                NSString(string: "Answer area — draw here").draw(at: CGPoint(x: 220, y: 540), withAttributes: body)
            }
        }
    }

    static func editorDocument() -> StudioDocument {
        StudioDocument(data: pdfData(title: "Sample document"), name: "sample.pdf")!
    }

    static func webAnnotationsDocument() -> StudioDocument {
        let doc = StudioDocument(data: pdfData(title: "Shared annotations"), name: "shared.pdf")!
        if let url = Bundle.main.url(forResource: "web-annotations", withExtension: "json"), let data = try? Data(contentsOf: url) {
            try? doc.importJSON(data)
        }
        return doc
    }

    /// Pages turned 0°, 90°, 180° and 270°, each with free text, a stamp and a distance measurement:
    /// everything must read upright as displayed.
    static func rotatedDocument() -> StudioDocument {
        let base = PDFDocument(data: pdfData(title: "Rotated pages"))!
        for i in 2..<4 { base.insert(base.page(at: i % 2)!.copy() as! PDFPage, at: i) }
        for i in 0..<4 { base.page(at: i)?.rotation = i * 90 }
        let doc = StudioDocument(data: base.dataRepresentation()!, name: "rotated.pdf")!
        for i in 0..<4 {
            doc.add(Annotation(page: i, kind: .freetext, color: "#e5484d", rect: Box(x: 60, y: 60, w: 260, h: 30),
                               text: "Page turned \(i * 90)° — upright text", fontSize: 14, author: "User 1"))
            doc.add(Annotation(page: i, kind: .stamp, color: "#1f6feb", strokeWidth: 2.5, rect: Box(x: 60, y: 110, w: 140, h: 34),
                               text: "APPROVED", author: "User 1"))
            doc.add(Annotation(page: i, kind: .distance, color: "#7c3aed", points: [Pt(x: 60, y: 190), Pt(x: 276, y: 190)],
                               measure: MeasureScale(factor: 1 / 72.0, unit: "in", precision: 2), author: "User 1"))
        }
        doc.selectedID = nil
        return doc
    }

    static func checkedCopy() -> StudioDocument {
        let doc = StudioDocument(data: pdfData(title: "Homework — checked copy"), name: "checked-copy.pdf")!
        if let url = Bundle.main.url(forResource: "reviewer-markup", withExtension: "xfdf"), let xml = try? String(contentsOf: url, encoding: .utf8) {
            _ = try? doc.mergeXFDF(xml)
        }
        return doc
    }
}
