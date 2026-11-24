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

extension Measure {
    /// Real-world units per PDF point that make the distance measurement `a` read `realLength` (web `calibrate`).
    public static func calibrate(_ a: Annotation, realLength: Double) -> Double {
        let len = length(a.points ?? [])
        return len > 0 ? realLength / len : 0
    }

    /// A distance measurement dragged from `start` to `end`, or nil for a tap (shorter than 4 page units both ways,
    /// as on the web).
    public static func distance(page: Int, from start: Pt, to end: Pt, scale: MeasureScale, color: String,
                                strokeWidth: Double, author: String) -> Annotation? {
        guard abs(end.x - start.x) >= 4 || abs(end.y - start.y) >= 4 else { return nil }
        return Annotation(page: page, kind: .distance, color: color, opacity: 1, strokeWidth: strokeWidth,
                          points: [start, end], measure: scale, author: author)
    }
}

/// The scale used for new measurements: `paperValue paperUnit` on the page stands for `worldValue worldUnit`
/// (web `ScaleSetting`, same defaults: 1 in = 1 in, 2 decimals).
public struct MeasureScaleSetting: Codable, Hashable, Sendable {
    public var paperValue: Double
    public var paperUnit: String
    public var worldValue: Double
    public var worldUnit: String
    public var precision: Int

    public init(paperValue: Double = 1, paperUnit: String = "in", worldValue: Double = 1, worldUnit: String = "in", precision: Int = 2) {
        self.paperValue = paperValue; self.paperUnit = paperUnit; self.worldValue = worldValue; self.worldUnit = worldUnit
        self.precision = precision
    }

    public static let `default` = MeasureScaleSetting()
    /// PDF points per unit of paper measurement.
    public static let paperUnits: [String: Double] = ["in": 72, "cm": 72 / 2.54, "mm": 72 / 25.4, "pt": 1]
    public static let paperUnitNames = ["in", "cm", "mm", "pt"]
    public static let worldUnits = ["in", "ft", "yd", "mi", "mm", "cm", "m", "km", "pt"]

    /// The `measure` stored on new measurements.
    public var measureScale: MeasureScale {
        MeasureScale(factor: worldValue / (paperValue * (Self.paperUnits[paperUnit] ?? 72)), unit: worldUnit, precision: precision)
    }

    /// "1 in = 10 ft"
    public var summary: String { "\(Self.number(paperValue)) \(paperUnit) = \(Self.number(worldValue)) \(worldUnit)" }

    /// The setting (and exact factor) that makes the distance measurement `a` read `realLength` world units,
    /// expressed per inch of paper, as the web's Calibrate does. Nil when `a` has no length or `realLength` <= 0.
    public func calibrated(to a: Annotation, realLength: Double) -> (setting: MeasureScaleSetting, factor: Double)? {
        let factor = Measure.calibrate(a, realLength: realLength)
        guard realLength > 0, factor > 0 else { return nil }
        var next = self
        next.paperValue = 1
        next.paperUnit = "in"
        next.worldValue = Double(String(format: "%.6g", factor * 72)) ?? factor * 72
        return (next, factor)
    }

    /// JS-style number text: 1 → "1", 0.5 → "0.5".
    static func number(_ v: Double) -> String {
        v == v.rounded() && abs(v) < 1e15 ? String(Int(v)) : String(v)
    }

    public init(from decoder: Decoder) throws {
        // tolerate partial settings saved by other versions (web merges over its defaults the same way)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = MeasureScaleSetting.default
        paperValue = (try? c.decode(Double.self, forKey: .paperValue)) ?? d.paperValue
        paperUnit = (try? c.decode(String.self, forKey: .paperUnit)) ?? d.paperUnit
        worldValue = (try? c.decode(Double.self, forKey: .worldValue)) ?? d.worldValue
        worldUnit = (try? c.decode(String.self, forKey: .worldUnit)) ?? d.worldUnit
        precision = (try? c.decode(Int.self, forKey: .precision)) ?? d.precision
    }
}

/// A perimeter or area measurement being placed point by point (tap, tap, … then finish).
public struct MeasureDraft: Equatable, Sendable {
    public let kind: AnnotationKind
    public let page: Int
    public private(set) var points: [Pt] = []

    /// Nil unless `kind` is `.perimeter` or `.area`.
    public init?(kind: AnnotationKind, page: Int) {
        guard kind == .perimeter || kind == .area else { return nil }
        self.kind = kind; self.page = page
    }

    /// Points needed before the measurement can be finished: 2 for a perimeter, 3 for an area.
    public var minimumPoints: Int { kind == .area ? 3 : 2 }
    public var canFinish: Bool { points.count >= minimumPoints }

    /// Adds a vertex; one within 2 page units of the previous vertex is ignored (a double tap, as on the web).
    @discardableResult
    public mutating func add(_ p: Pt) -> Bool {
        if let last = points.last, hypot(p.x - last.x, p.y - last.y) <= 2 { return false }
        points.append(p)
        return true
    }

    public mutating func removeLast() { _ = points.popLast() }

    /// The finished measurement, or nil while there are too few points.
    public func annotation(scale: MeasureScale, color: String, strokeWidth: Double, author: String) -> Annotation? {
        guard canFinish else { return nil }
        return Annotation(page: page, kind: kind, color: color, opacity: 1, strokeWidth: strokeWidth, points: points,
                          measure: scale, author: author)
    }

    /// The label the measurement would have now (e.g. while placing points).
    public func label(scale: MeasureScale) -> String {
        Measure.label(Annotation(page: page, kind: kind, color: "#000000", points: points, measure: scale, author: ""))
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
