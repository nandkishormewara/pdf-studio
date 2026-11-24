import CoreGraphics
import CoreText
import Foundation
import PDFKit

/// A stamp-type annotation drawn by us. Used for kinds PDFKit can't express natively
/// (stamps, signatures, measurements, redaction marks). PDFKit calls `draw` both on screen and
/// when writing the file, so the drawing becomes the saved appearance stream.
final class StudioDrawnAnnotation: PDFAnnotation {
    var model: Annotation!
    var geometry: PageGeometry!
    /// Set while StudioDocument draws this mark into a page it rebuilds for a flattened save: the context is plain
    /// PDF user space, whatever its size.
    var drawsInUserSpace = false

    override func draw(with box: PDFDisplayBox, in context: CGContext) {
        guard let a = model, let g = geometry else { return }
        context.saveGState()
        defer { context.restoreGState() }
        if !drawsInUserSpace && Self.expectsDisplaySpace(context, g) { context.concatenate(g.displayTransform) }
        context.setAlpha(a.opacity)
        let color = CGColor(srgbRed: RGB(hex: a.color).r, green: RGB(hex: a.color).g, blue: RGB(hex: a.color).b, alpha: 1)

        switch a.kind {
        case .stamp:
            guard let r = a.rect else { return }
            context.concatenate(g.uprightTransform(for: r))
            let local = CGRect(x: 0, y: 0, width: r.w, height: r.h).insetBy(dx: a.strokeWidth / 2, dy: a.strokeWidth / 2)
            context.setStrokeColor(color)
            context.setLineWidth(a.strokeWidth)
            context.addPath(CGPath(roundedRect: local, cornerWidth: 4, cornerHeight: 4, transform: nil))
            context.strokePath()
            drawText(a.text ?? "APPROVED", in: CGRect(x: 0, y: 0, width: r.w, height: r.h), maxSize: r.h * 0.55,
                     bold: true, color: color, context: context, centered: true)

        case .signature:
            guard let r = a.rect, let url = a.image, let img = cgImage(fromDataURL: url) else { return }
            context.concatenate(g.uprightTransform(for: r))
            context.interpolationQuality = .high
            context.draw(img, in: CGRect(x: 0, y: 0, width: r.w, height: r.h))

        case .underline:
            // reached only for squiggly underlines (AnnotationBridge): a wave under each text line
            context.setStrokeColor(color)
            context.setLineWidth(max(1, a.strokeWidth))
            context.setLineCap(.round)
            for r in a.rects ?? [] {
                let amp = max(1.5, r.h * 0.08)
                let y = r.y + r.h * 0.92
                var x = r.x, up = true
                let path = CGMutablePath()
                path.move(to: g.toPDF(Pt(x: x, y: y)))
                while x < r.maxX {
                    let nx = min(x + amp * 2, r.maxX)
                    path.addQuadCurve(to: g.toPDF(Pt(x: nx, y: y)), control: g.toPDF(Pt(x: (x + nx) / 2, y: up ? y - amp : y + amp)))
                    x = nx; up.toggle()
                }
                context.addPath(path)
                context.strokePath()
            }

        case .redact:
            guard let r = a.rect else { return }
            let pdfRect = g.toPDF(r)
            context.setFillColor(CGColor(srgbRed: 0.9, green: 0.28, blue: 0.3, alpha: 0.15))
            context.fill(pdfRect)
            context.setStrokeColor(CGColor(srgbRed: 0.9, green: 0.28, blue: 0.3, alpha: 1))
            context.setLineWidth(1.2)
            context.setLineDash(phase: 0, lengths: [4, 2])
            context.stroke(pdfRect)

        case .distance, .perimeter, .area:
            let pts = (a.points ?? []).map(g.toPDF)
            guard pts.count > 1 else { return }
            context.setStrokeColor(color)
            context.setLineWidth(a.strokeWidth)
            context.setLineCap(.round)
            context.setLineJoin(.round)
            if a.kind == .area {
                context.addLines(between: pts)
                context.closePath()
                context.setFillColor(color.copy(alpha: 0.15)!)
                context.fillPath()
                context.addLines(between: pts)
                context.closePath()
            } else {
                context.addLines(between: pts)
            }
            context.strokePath()
            if a.kind == .distance, let p = a.points, p.count == 2 {
                let len = max(hypot(p[1].x - p[0].x, p[1].y - p[0].y), 1)
                let nx = -(p[1].y - p[0].y) / len * 6, ny = (p[1].x - p[0].x) / len * 6
                for e in p {
                    context.move(to: g.toPDF(Pt(x: e.x - nx, y: e.y - ny)))
                    context.addLine(to: g.toPDF(Pt(x: e.x + nx, y: e.y + ny)))
                }
                context.strokePath()
            }
            let label = Measure.label(a)
            let c = Measure.labelAnchor(a)
            let w = Double(label.count) * 5.6 + 8
            let labelBox = Box(x: c.x - w / 2, y: c.y - 8, w: w, h: 16)
            context.saveGState()
            context.concatenate(g.uprightTransform(for: labelBox))
            context.setFillColor(CGColor(gray: 1, alpha: 0.9))
            context.fill(CGRect(x: 0, y: 0, width: w, height: 16))
            drawText(label, in: CGRect(x: 0, y: 0, width: w, height: 16), maxSize: 10, bold: false, color: color,
                     context: context, centered: true)
            context.restoreGState()

        case .ink:
            // pen taps (one-point strokes) are dots the width of the pen; longer strokes as usual
            context.setStrokeColor(color)
            context.setFillColor(color)
            context.setLineWidth(a.strokeWidth)
            context.setLineCap(.round)
            context.setLineJoin(.round)
            for path in a.paths ?? [] {
                let pts = path.map(g.toPDF)
                if pts.count == 1 {
                    let r = max(0.5, a.strokeWidth / 2)
                    context.fillEllipse(in: CGRect(x: pts[0].x - r, y: pts[0].y - r, width: r * 2, height: r * 2))
                } else {
                    context.addLines(between: pts)
                    context.strokePath()
                }
            }

        case .freetext:
            guard let box = a.textBox else { return }
            if let fill = a.fill {
                let f = RGB(hex: fill)
                context.setFillColor(CGColor(srgbRed: f.r, green: f.g, blue: f.b, alpha: 1))
                context.fill(g.toPDF(box))
            }
            if let cl = a.callout, cl.count >= 2 {
                context.setStrokeColor(color)
                context.setLineWidth(a.strokeWidth)
                context.setLineJoin(.round)
                context.stroke(g.toPDF(box))
                context.addLines(between: cl.map(g.toPDF))
                context.strokePath()
                let end = a.calloutEnd ?? ""
                if end.contains("Arrow") {
                    let head = arrowHead(from: cl[1], to: cl[0], width: a.strokeWidth).map(g.toPDF)
                    if end.contains("Closed") {
                        context.setFillColor(color)
                        context.addLines(between: head)
                        context.closePath()
                        context.fillPath()
                    } else {
                        context.addLines(between: [head[1], head[0], head[2]])
                        context.strokePath()
                    }
                }
            }
            // Upright box space (origin bottom-left, y up), turned counter-clockwise about the centre.
            context.concatenate(g.uprightTransform(for: box))
            let rotation = a.rotation ?? 0
            if rotation != 0 {
                context.translateBy(x: box.w / 2, y: box.h / 2)
                context.rotate(by: CGFloat(Double(rotation) * .pi / 180))
                context.translateBy(x: -box.w / 2, y: -box.h / 2)
            }
            let lay = textLayoutBox(box, rotation: a.rotation)
            let size = a.fontSize ?? 14
            // bold / italic / underlined / coloured words, wrapped between words at the box's right edge,
            // as WebViewer wraps typed comments and the web draws them
            func attributed(_ run: TextRun) -> NSAttributedString {
                let name = run.isBold && run.isItalic ? "Helvetica-BoldOblique" : run.isBold ? "Helvetica-Bold" : run.isItalic ? "Helvetica-Oblique" : "Helvetica"
                var attrs: [NSAttributedString.Key: Any] = [
                    NSAttributedString.Key(kCTFontAttributeName as String): CTFontCreateWithName(name as CFString, size, nil),
                    NSAttributedString.Key(kCTForegroundColorAttributeName as String): run.color.map { h -> CGColor in
                        let c = RGB(hex: h); return CGColor(srgbRed: c.r, green: c.g, blue: c.b, alpha: 1)
                    } ?? color,
                ]
                if run.isUnderlined { attrs[NSAttributedString.Key(kCTUnderlineStyleAttributeName as String)] = CTUnderlineStyle.single.rawValue }
                return NSAttributedString(string: run.text, attributes: attrs)
            }
            let runs = a.richText.flatMap { $0.isEmpty ? nil : $0 } ?? [TextRun(text: a.text ?? "")]
            let first = textOrigin(lay, rotation: a.rotation, size: size, lines: 1)
            let wrapped = RichText.wrap(runs, maxWidth: lay.x + lay.w - first.x) { text, run in
                var r = run; r.text = text
                return Double(CTLineGetTypographicBounds(CTLineCreateWithAttributedString(attributed(r)), nil, nil, nil))
            }
            let at = textOrigin(lay, rotation: a.rotation, size: size, lines: wrapped.count)
            // layout box in the box's upright space: same centre, sides swapped when turned 90°/270°
            let left = (box.w - lay.w) / 2 + (at.x - lay.x)
            var top = box.h - ((box.h - lay.h) / 2 + (at.y - lay.y))
            context.textMatrix = .identity
            for line in wrapped {
                let attr = NSMutableAttributedString()
                for run in line { attr.append(attributed(run)) }
                let ctLine = CTLineCreateWithAttributedString(attr)
                top -= size
                context.textPosition = CGPoint(x: left, y: top + size * 0.15)
                CTLineDraw(ctLine, context)
                top -= size * 0.15
            }

        default:
            break
        }
    }

    /// iOS PDFKit renders page thumbnails (`PDFPage.thumbnail`, `PDFThumbnailView`) by calling `draw` with an
    /// untransformed context the size of the page as displayed (y up), not in PDF user space: drawing as usual
    /// there put marks on rotated or cropped pages turned and shifted. On screen and when saving, the context is
    /// already in PDF user space (rotation/crop applied by PDFKit, or a translated appearance-stream context).
    static func expectsDisplaySpace(_ context: CGContext, _ g: PageGeometry) -> Bool {
        guard g.rotation != 0 || g.crop.origin != .zero else { return false }
        let m = context.ctm
        guard m.b == 0, m.c == 0, m.tx == 0, m.ty == 0, m.a > 0, m.d > 0 else { return false }
        let clip = context.boundingBoxOfClipPath
        return abs(clip.minX) < 0.5 && abs(clip.minY) < 0.5
            && abs(clip.width - g.size.width) < 1 && abs(clip.height - g.size.height) < 1
    }

    private func arrowHead(from a: Pt, to b: Pt, width: Double) -> [Pt] {
        let len = max(8, width * 4), ang = atan2(b.y - a.y, b.x - a.x), s = Double.pi / 7
        return [b, Pt(x: b.x - len * cos(ang - s), y: b.y - len * sin(ang - s)), Pt(x: b.x - len * cos(ang + s), y: b.y - len * sin(ang + s))]
    }

    /// Draws one line of text centred in `rect` (upright local space, y up), shrinking to fit.
    private func drawText(_ text: String, in rect: CGRect, maxSize: CGFloat, bold: Bool, color: CGColor,
                          context: CGContext, centered: Bool) {
        var size = maxSize
        var line: CTLine
        repeat {
            let font = CTFontCreateWithName((bold ? "Helvetica-Bold" : "Helvetica") as CFString, size, nil)
            let attr = NSAttributedString(string: text, attributes: [
                NSAttributedString.Key(kCTFontAttributeName as String): font,
                NSAttributedString.Key(kCTForegroundColorAttributeName as String): color,
            ])
            line = CTLineCreateWithAttributedString(attr)
            let width = CTLineGetTypographicBounds(line, nil, nil, nil)
            if width <= rect.width * 0.9 || size <= 4 { break }
            size *= 0.9
        } while true
        var ascent: CGFloat = 0, descent: CGFloat = 0
        let width = CTLineGetTypographicBounds(line, &ascent, &descent, nil)
        let x = centered ? rect.midX - width / 2 : rect.minX + 4
        let y = rect.midY - (ascent - descent) / 2
        context.textMatrix = .identity
        context.textPosition = CGPoint(x: x, y: y)
        CTLineDraw(line, context)
    }
}
