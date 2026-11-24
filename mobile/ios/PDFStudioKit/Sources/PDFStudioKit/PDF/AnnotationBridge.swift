import CoreGraphics
import Foundation
import PDFKit

/// Converts between the shared annotation model and PDFKit annotations.
public enum AnnotationBridge {
    /// Private keys shared with the web SDK: the annotation's full JSON (lossless round trip)
    /// and the modification date it was written with.
    static let jsonKey = PDFAnnotationKey(rawValue: "/PDFStudio")
    static let jsonDateKey = PDFAnnotationKey(rawValue: "/PDFStudioM")

    /// Subtypes we can turn into editable model annotations when no JSON is present.
    static let importableTypes: Set<String> = ["Highlight", "Underline", "StrikeOut", "Square", "Circle", "Line", "Ink", "FreeText", "Text"]

    // MARK: model -> PDFKit

    public static func makePDFAnnotation(_ a: Annotation, geometry g: PageGeometry) -> PDFAnnotation {
        let color = PlatformColor(hex: a.color, alpha: a.opacity)
        let annot: PDFAnnotation

        switch a.kind {
        case .underline where a.subtype == "squiggly":
            // PDFKit has no squiggly underline.
            let drawn = StudioDrawnAnnotation(bounds: drawnBounds(a, g), forType: .stamp, withProperties: nil)
            drawn.model = a
            drawn.geometry = g
            annot = drawn

        case .freetext:
            // Still a real FreeText annotation (an editable save is FreeText that Acrobat can edit), but drawn by PDF Studio:
            // PDFKit's free text is one font and colour, wraps differently from WebViewer and clips text to the box with
            // its own padding (Apryse's small label boxes lost their text).
            // its own box, so an editable save keeps the rect exact (a callout needs room for its line)
            let bounds = a.callout == nil ? g.toPDF(a.rect ?? Box(x: 0, y: 0, w: 120, h: 24)) : drawnBounds(a, g)
            let drawn = StudioDrawnAnnotation(bounds: bounds, forType: .freeText, withProperties: nil)
            drawn.model = a
            drawn.geometry = g
            drawn.contents = a.text ?? ""
            drawn.font = PlatformFont(name: "Helvetica", size: a.fontSize ?? 14) ?? PlatformFont.systemFont(ofSize: a.fontSize ?? 14)
            drawn.fontColor = color
            drawn.color = PlatformColor.clear
            drawn.alignment = .left
            let b = PDFBorder(); b.lineWidth = 0
            drawn.border = b
            annot = drawn

        case .highlight, .underline, .strikeout:
            let rects = (a.rects ?? []).map(g.toPDF)
            let bounds = rects.reduce(CGRect.null) { $0.union($1) }
            let type: PDFAnnotationSubtype = a.kind == .highlight ? .highlight : a.kind == .underline ? .underline : .strikeOut
            annot = PDFAnnotation(bounds: bounds.isNull ? .zero : bounds, forType: type, withProperties: nil)
            annot.quadrilateralPoints = rects.flatMap { r -> [NSValue] in
                let o = bounds.origin
                return [CGPoint(x: r.minX - o.x, y: r.maxY - o.y), CGPoint(x: r.maxX - o.x, y: r.maxY - o.y),
                        CGPoint(x: r.minX - o.x, y: r.minY - o.y), CGPoint(x: r.maxX - o.x, y: r.minY - o.y)].map(nsValue)
            }
            annot.color = color

        case .rect, .ellipse:
            let r = g.toPDF(a.rect ?? Box(x: 0, y: 0, w: 0, h: 0)).insetBy(dx: -a.strokeWidth / 2, dy: -a.strokeWidth / 2)
            annot = PDFAnnotation(bounds: r, forType: a.kind == .rect ? .square : .circle, withProperties: nil)
            annot.color = color
            annot.border = border(a.strokeWidth)
            if let fill = a.fill { annot.interiorColor = PlatformColor(hex: fill, alpha: a.opacity) }

        case .line, .arrow:
            let pts = (a.points ?? []).map(g.toPDF)
            let bounds = boundsOf(pts, pad: max(10, a.strokeWidth * 4))
            annot = PDFAnnotation(bounds: bounds, forType: .line, withProperties: nil)
            if pts.count == 2 {
                annot.startPoint = CGPoint(x: pts[0].x - bounds.minX, y: pts[0].y - bounds.minY)
                annot.endPoint = CGPoint(x: pts[1].x - bounds.minX, y: pts[1].y - bounds.minY)
            }
            annot.startLineStyle = .none
            annot.endLineStyle = a.kind == .arrow ? .closedArrow : .none
            annot.color = color
            annot.interiorColor = color
            annot.border = border(a.strokeWidth)

        case .ink where (a.paths ?? []).contains { $0.count == 1 }:
            // PDFKit draws no dot for a one-point stroke (a pen tap).
            let drawn = StudioDrawnAnnotation(bounds: drawnBounds(a, g), forType: .stamp, withProperties: nil)
            drawn.model = a
            drawn.geometry = g
            if a.kind == .freetext { drawn.contents = a.text }
            annot = drawn

        case .ink:
            let all = (a.paths ?? []).flatMap { $0 }.map(g.toPDF)
            let bounds = boundsOf(all, pad: a.strokeWidth + 2)
            annot = PDFAnnotation(bounds: bounds, forType: .ink, withProperties: nil)
            for path in a.paths ?? [] {
                annot.add(PlatformBezierPath.polyline(path.map { let p = g.toPDF($0); return CGPoint(x: p.x - bounds.minX, y: p.y - bounds.minY) }))
            }
            annot.color = color
            annot.border = border(a.strokeWidth)

        case .note:
            let r = g.toPDF(a.rect ?? Box(x: 0, y: 0, w: 22, h: 22))
            annot = PDFAnnotation(bounds: r, forType: .text, withProperties: nil)
            annot.iconType = .comment
            annot.color = color
            annot.contents = a.comment ?? ""

        case .stamp, .signature, .distance, .perimeter, .area, .redact:
            let drawn = StudioDrawnAnnotation(bounds: drawnBounds(a, g), forType: .stamp, withProperties: nil)
            drawn.model = a
            drawn.geometry = g
            if a.kind == .stamp { drawn.contents = a.text }
            if a.kind.isMeasurement { drawn.contents = Measure.label(a) }
            annot = drawn
        }

        annot.userName = a.author
        annot.modificationDate = Annotation.date(from: a.modifiedAt)
        annot.setValue(a.id, forAnnotationKey: .name)
        if a.kind != .freetext && a.kind != .note && a.kind != .stamp && !a.kind.isMeasurement, let comment = a.comment {
            annot.contents = comment
        }
        return annot
    }

    /// Stamps the model JSON onto an annotation right before saving.
    static func attachJSON(_ a: Annotation, to annot: PDFAnnotation) {
        guard let data = try? JSONEncoder().encode(a), let json = String(data: data, encoding: .utf8) else { return }
        annot.setValue(json, forAnnotationKey: jsonKey)
        annot.setValue(a.modifiedAt, forAnnotationKey: jsonDateKey)
    }

    private static func drawnBounds(_ a: Annotation, _ g: PageGeometry) -> CGRect {
        var box = a.bounds
        if let cl = a.callout, let b = Box.bounding(cl) { box = Box.union([box, b])!.insetBy(-6) }
        if a.kind == .ink { box = box.insetBy(-a.strokeWidth) }
        if a.kind.isMeasurement {
            // include the label and end ticks
            let c = Measure.labelAnchor(a)
            let w = Double(Measure.label(a).count) * 5.6 + 8
            box = Box.union([box, Box(x: c.x - w / 2, y: c.y - 8, w: w, h: 16)])!.insetBy(-8)
        }
        return g.toPDF(box).insetBy(dx: -2, dy: -2)
    }

    // MARK: PDFKit -> model

    /// Converts a PDF annotation to the model, or nil when it isn't one we can edit.
    public static func annotation(from pdf: PDFAnnotation, page: Int, geometry g: PageGeometry) -> Annotation? {
        if let json = pdf.value(forAnnotationKey: jsonKey) as? String,
           let data = json.data(using: .utf8),
           var a = try? JSONDecoder().decode(Annotation.self, from: data),
           isFresh(pdf, modelDate: a.modifiedAt) {
            a.page = page
            return a
        }
        guard let type = pdf.type, importableTypes.contains(type) else { return nil }

        let (rgb, alpha) = pdf.color.rgba ?? (RGB(hex: "#e5484d"), 1)
        let now = Annotation.now()
        let modified = pdf.modificationDate.map(Annotation.string(from:)) ?? now
        var a = Annotation(id: (pdf.value(forAnnotationKey: .name) as? String) ?? Annotation.newID(), page: page,
                           kind: .rect, color: rgb.hex, opacity: Double(alpha), strokeWidth: Double(pdf.border?.lineWidth ?? 1),
                           comment: pdf.contents, author: pdf.userName ?? "Unknown", createdAt: modified, modifiedAt: modified)
        let b = pdf.bounds

        switch type {
        case "Highlight", "Underline", "StrikeOut":
            a.kind = type == "Highlight" ? .highlight : type == "Underline" ? .underline : .strikeout
            let quads = (pdf.quadrilateralPoints ?? []).map { pointValue($0) }
            var rects: [Box] = []
            var i = 0
            while i + 3 < quads.count {
                let pts = quads[i..<(i + 4)].map { g.toPage(CGPoint(x: $0.x + b.minX, y: $0.y + b.minY)) }
                if let r = Box.bounding(pts) { rects.append(r) }
                i += 4
            }
            a.rects = rects.isEmpty ? [g.toPage(b)] : rects
            if a.kind == .highlight { a.opacity = min(alpha, 0.45) }
        case "Square", "Circle":
            a.kind = type == "Square" ? .rect : .ellipse
            a.rect = g.toPage(b.insetBy(dx: a.strokeWidth / 2, dy: a.strokeWidth / 2))
        case "Line":
            a.kind = pdf.endLineStyle == .none && pdf.startLineStyle == .none ? .line : .arrow
            a.points = [pdf.startPoint, pdf.endPoint].map { g.toPage(CGPoint(x: $0.x + b.minX, y: $0.y + b.minY)) }
        case "Ink":
            a.kind = .ink
            a.paths = (pdf.paths ?? []).map { $0.polylinePoints.map { g.toPage(CGPoint(x: $0.x + b.minX, y: $0.y + b.minY)) } }
        case "FreeText":
            a.kind = .freetext
            a.rect = g.toPage(b)
            a.text = pdf.contents ?? ""
            a.comment = nil
            a.fontSize = Double(pdf.font?.pointSize ?? 12)
            if let (fc, _) = pdf.fontColor?.rgba { a.color = fc.hex }
            a.opacity = 1
        case "Text":
            a.kind = .note
            let origin = g.toPage(b)
            a.rect = Box(x: origin.x, y: origin.y, w: 22, h: 22)
            a.opacity = 1
        default:
            return nil
        }
        return a
    }

    /// JSON written by us is trusted unless another app edited the annotation afterwards.
    private static func isFresh(_ pdf: PDFAnnotation, modelDate: String) -> Bool {
        guard let m = pdf.modificationDate, let d = Annotation.date(from: modelDate) else { return true }
        return abs(m.timeIntervalSince(d)) < 2
    }

    // MARK: helpers

    private static func border(_ width: Double) -> PDFBorder {
        let b = PDFBorder()
        b.lineWidth = width
        b.style = .solid
        return b
    }

    private static func boundsOf(_ pts: [CGPoint], pad: CGFloat) -> CGRect {
        guard let f = pts.first else { return .zero }
        var r = CGRect(origin: f, size: .zero)
        for p in pts { r = r.union(CGRect(origin: p, size: .zero)) }
        return r.insetBy(dx: -pad, dy: -pad)
    }

    private static func nsValue(_ p: CGPoint) -> NSValue {
        #if canImport(UIKit)
        return NSValue(cgPoint: p)
        #else
        return NSValue(point: p)
        #endif
    }

    private static func pointValue(_ v: Any) -> CGPoint {
        guard let v = v as? NSValue else { return .zero }
        #if canImport(UIKit)
        return v.cgPointValue
        #else
        return v.pointValue
        #endif
    }
}
