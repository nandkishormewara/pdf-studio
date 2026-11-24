import CoreGraphics
import Foundation
import ImageIO

#if canImport(UIKit)
import UIKit
public typealias PlatformColor = UIColor
public typealias PlatformFont = UIFont
public typealias PlatformBezierPath = UIBezierPath
#else
import AppKit
public typealias PlatformColor = NSColor
public typealias PlatformFont = NSFont
public typealias PlatformBezierPath = NSBezierPath
#endif

extension PlatformColor {
    public convenience init(hex: String, alpha: Double = 1) {
        let c = RGB(hex: hex)
        self.init(red: c.r, green: c.g, blue: c.b, alpha: alpha)
    }

    /// sRGB components, or nil for pattern / clear colours.
    var rgba: (RGB, Double)? {
        #if canImport(UIKit)
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        guard getRed(&r, green: &g, blue: &b, alpha: &a) else { return nil }
        #else
        guard let c = usingColorSpace(.sRGB) else { return nil }
        let (r, g, b, a) = (c.redComponent, c.greenComponent, c.blueComponent, c.alphaComponent)
        #endif
        return (RGB(r: r, g: g, b: b), a)
    }
}

extension PlatformBezierPath {
    static func polyline(_ points: [CGPoint]) -> PlatformBezierPath {
        let p = PlatformBezierPath()
        guard let first = points.first else { return p }
        p.move(to: first)
        for q in points.dropFirst() {
            #if canImport(UIKit)
            p.addLine(to: q)
            #else
            p.line(to: q)
            #endif
        }
        return p
    }

    /// All on-curve points of the path, in order (curves are flattened to their end points).
    var polylinePoints: [CGPoint] {
        var out: [CGPoint] = []
        cgPath.applyWithBlock { el in
            let e = el.pointee
            switch e.type {
            case .moveToPoint, .addLineToPoint: out.append(e.points[0])
            case .addQuadCurveToPoint: out.append(e.points[1])
            case .addCurveToPoint: out.append(e.points[2])
            default: break
            }
        }
        return out
    }
}

/// Decodes a `data:image/png;base64,...` URL.
func cgImage(fromDataURL url: String) -> CGImage? {
    guard let comma = url.firstIndex(of: ","),
          let data = Data(base64Encoded: String(url[url.index(after: comma)...])),
          let src = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
    return CGImageSourceCreateImageAtIndex(src, 0, nil)
}

/// Encodes an image as a PNG data URL.
public func pngDataURL(_ image: CGImage) -> String? {
    let data = NSMutableData()
    guard let dest = CGImageDestinationCreateWithData(data, "public.png" as CFString, 1, nil) else { return nil }
    CGImageDestinationAddImage(dest, image, nil)
    guard CGImageDestinationFinalize(dest) else { return nil }
    return "data:image/png;base64," + (data as Data).base64EncodedString()
}
