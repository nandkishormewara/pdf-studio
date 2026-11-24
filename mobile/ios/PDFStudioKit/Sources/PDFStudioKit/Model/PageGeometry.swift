import CoreGraphics

/// Converts between page units (top-left origin, rotation applied — the shared model) and
/// PDF user space (bottom-left origin, unrotated — what PDFKit uses for annotation bounds).
///
/// Mirrors PDF.js `PageViewport` at scale 1; verified against `mobile/shared/geometry-vectors.json`.
public struct PageGeometry: Equatable, Sendable {
    /// Crop box in PDF user space.
    public let crop: CGRect
    /// Page rotation: 0, 90, 180 or 270.
    public let rotation: Int

    public init(crop: CGRect, rotation: Int) {
        self.crop = crop.standardized
        self.rotation = ((rotation % 360) + 360) % 360
    }

    /// Size of the page as displayed, in points.
    public var size: CGSize {
        rotation % 180 == 0 ? crop.size : CGSize(width: crop.height, height: crop.width)
    }

    public func toPage(_ p: CGPoint) -> Pt {
        let (x0, y0, x1, y1) = (crop.minX, crop.minY, crop.maxX, crop.maxY)
        switch rotation {
        case 90: return Pt(x: p.y - y0, y: p.x - x0)
        case 180: return Pt(x: x1 - p.x, y: p.y - y0)
        case 270: return Pt(x: y1 - p.y, y: x1 - p.x)
        default: return Pt(x: p.x - x0, y: y1 - p.y)
        }
    }

    public func toPDF(_ p: Pt) -> CGPoint {
        let (x0, y0, x1, y1) = (crop.minX, crop.minY, crop.maxX, crop.maxY)
        switch rotation {
        case 90: return CGPoint(x: p.y + x0, y: p.x + y0)
        case 180: return CGPoint(x: x1 - p.x, y: p.y + y0)
        case 270: return CGPoint(x: x1 - p.y, y: y1 - p.x)
        default: return CGPoint(x: p.x + x0, y: y1 - p.y)
        }
    }

    public func toPDF(_ b: Box) -> CGRect {
        let a = toPDF(Pt(x: b.x, y: b.y)), c = toPDF(Pt(x: b.maxX, y: b.maxY))
        return CGRect(x: min(a.x, c.x), y: min(a.y, c.y), width: abs(a.x - c.x), height: abs(a.y - c.y))
    }

    public func toPage(_ r: CGRect) -> Box {
        let a = toPage(CGPoint(x: r.minX, y: r.minY)), c = toPage(CGPoint(x: r.maxX, y: r.maxY))
        return Box.spanning(a, c)
    }

    /// An affine transform that maps a local, upright drawing space (origin at the bottom-left of
    /// `box` as displayed, y up, 1 unit = 1 pt) into PDF user space. Used to draw text and images
    /// that must look upright on rotated pages.
    public func uprightTransform(for box: Box) -> CGAffineTransform {
        let o = toPDF(Pt(x: box.x, y: box.maxY))
        let u = toPDF(Pt(x: box.x + 1, y: box.maxY))
        let v = toPDF(Pt(x: box.x, y: box.maxY - 1))
        return CGAffineTransform(a: u.x - o.x, b: u.y - o.y, c: v.x - o.x, d: v.y - o.y, tx: o.x, ty: o.y)
    }
}
