import Foundation

/// Measurement maths shared with the web SDK (web/src/sdk/measure.ts).
public enum Measure {
    public static func length(_ pts: [Pt], closed: Bool = false) -> Double {
        guard pts.count > 1 else { return 0 }
        var total = zip(pts, pts.dropFirst()).reduce(0) { $0 + hypot($1.1.x - $1.0.x, $1.1.y - $1.0.y) }
        if closed, pts.count > 2, let f = pts.first, let l = pts.last { total += hypot(f.x - l.x, f.y - l.y) }
        return total
    }

    public static func area(_ pts: [Pt]) -> Double {
        guard pts.count > 2 else { return 0 }
        var s = 0.0
        for i in pts.indices {
            let a = pts[i], b = pts[(i + 1) % pts.count]
            s += a.x * b.y - b.x * a.y
        }
        return abs(s) / 2
    }

    public static func value(_ a: Annotation) -> Double {
        guard let m = a.measure else { return 0 }
        let pts = a.points ?? []
        return a.kind == .area ? area(pts) * m.factor * m.factor : length(pts) * m.factor
    }

    public static func label(_ a: Annotation) -> String {
        guard let m = a.measure else { return "" }
        let v = String(format: "%.\(max(0, m.precision))f", value(a))
        return a.kind == .area ? "\(v) \(m.unit)²" : "\(v) \(m.unit)"
    }

    /// Label position in page units (same rule as the web SDK).
    public static func labelAnchor(_ a: Annotation) -> Pt {
        let pts = a.points ?? []
        guard let first = pts.first, let last = pts.last else { return Pt(x: 0, y: 0) }
        switch a.kind {
        case .area:
            let s = pts.reduce(Pt(x: 0, y: 0)) { Pt(x: $0.x + $1.x, y: $0.y + $1.y) }
            return Pt(x: s.x / Double(pts.count), y: s.y / Double(pts.count))
        case .distance where pts.count >= 2:
            return Pt(x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 - 6)
        default:
            _ = first
            return Pt(x: last.x, y: last.y - 8)
        }
    }
}

/// `#rrggbb` <-> components.
public struct RGB: Equatable, Sendable {
    public var r: Double, g: Double, b: Double

    public init(r: Double, g: Double, b: Double) { self.r = r; self.g = g; self.b = b }

    public init(hex: String) {
        let s = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        let n = UInt32(s, radix: 16) ?? 0
        r = Double((n >> 16) & 0xff) / 255; g = Double((n >> 8) & 0xff) / 255; b = Double(n & 0xff) / 255
    }

    public var hex: String {
        func h(_ v: Double) -> String { String(format: "%02x", Int((max(0, min(1, v)) * 255).rounded())) }
        return "#\(h(r))\(h(g))\(h(b))"
    }
}
