import Foundation

/// A point in page units: PDF points, origin at the top-left of the page as displayed
/// (page /Rotate applied). Identical to the web SDK's coordinate system.
public struct Pt: Codable, Hashable, Sendable {
    public var x: Double
    public var y: Double
    public init(x: Double, y: Double) { self.x = x; self.y = y }
}

/// A rectangle in page units. JSON keys `x`, `y`, `w`, `h` match the web format.
public struct Box: Codable, Hashable, Sendable {
    public var x: Double
    public var y: Double
    public var w: Double
    public var h: Double
    public init(x: Double, y: Double, w: Double, h: Double) { self.x = x; self.y = y; self.w = w; self.h = h }

    public var maxX: Double { x + w }
    public var maxY: Double { y + h }
    public var corners: [Pt] { [Pt(x: x, y: y), Pt(x: maxX, y: y), Pt(x: maxX, y: maxY), Pt(x: x, y: maxY)] }

    public static func spanning(_ a: Pt, _ b: Pt) -> Box {
        Box(x: min(a.x, b.x), y: min(a.y, b.y), w: abs(a.x - b.x), h: abs(a.y - b.y))
    }

    public static func union(_ boxes: [Box]) -> Box? {
        guard let first = boxes.first else { return nil }
        return boxes.dropFirst().reduce(first) { u, b in
            let x = min(u.x, b.x), y = min(u.y, b.y)
            return Box(x: x, y: y, w: max(u.maxX, b.maxX) - x, h: max(u.maxY, b.maxY) - y)
        }
    }

    public static func bounding(_ points: [Pt]) -> Box? {
        guard let first = points.first else { return nil }
        var (x0, y0, x1, y1) = (first.x, first.y, first.x, first.y)
        for p in points { x0 = min(x0, p.x); y0 = min(y0, p.y); x1 = max(x1, p.x); y1 = max(y1, p.y) }
        return Box(x: x0, y: y0, w: x1 - x0, h: y1 - y0)
    }

    public func insetBy(_ d: Double) -> Box { Box(x: x + d, y: y + d, w: max(0, w - 2 * d), h: max(0, h - 2 * d)) }
    public func contains(_ p: Pt) -> Bool { p.x >= x && p.x <= maxX && p.y >= y && p.y <= maxY }
}

public enum AnnotationKind: String, Codable, CaseIterable, Sendable {
    case highlight, underline, strikeout, rect, ellipse, line, arrow, ink, freetext, note, stamp, signature
    case distance, perimeter, area, redact

    public var isTextMarkup: Bool { self == .highlight || self == .underline || self == .strikeout }
    public var isMeasurement: Bool { self == .distance || self == .perimeter || self == .area }
}

public enum ReviewStatus: String, Codable, Sendable, CaseIterable {
    case none, accepted, rejected, completed
}

public struct MeasureScale: Codable, Hashable, Sendable {
    /// Real-world units per PDF point.
    public var factor: Double
    public var unit: String
    public var precision: Int
    public init(factor: Double, unit: String, precision: Int) { self.factor = factor; self.unit = unit; self.precision = precision }
}

/// One annotation, field-for-field compatible with the web SDK's JSON (see docs/file-formats.md).
public struct Annotation: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var page: Int
    public var kind: AnnotationKind
    public var color: String
    public var opacity: Double
    public var strokeWidth: Double
    public var rect: Box?
    public var rects: [Box]?
    public var points: [Pt]?
    public var measure: MeasureScale?
    public var paths: [[Pt]]?
    public var text: String?
    public var fontSize: Double?
    public var image: String?
    public var comment: String?
    /// Interior colour: rect, ellipse; background of a freetext box. Drawn at `opacity`.
    public var fill: String?
    /// freetext: text turned counter-clockwise by this many degrees as displayed (0, 90, 180, 270)
    public var rotation: Int?
    /// freetext: text box inset from `rect` (left, top, right, bottom), e.g. room for a callout line
    public var inset: [Double]?
    /// freetext callout leader: [tip at the target, optional knee, end at the text box]
    public var callout: [Pt]?
    /// freetext callout tip ending as in PDF /LE: OpenArrow, ClosedArrow, None …
    public var calloutEnd: String?
    /// freetext intent kept for round trips: FreeTextTypewriter, FreeTextCallout
    public var intent: String?
    /// freetext: styled runs (bold, italic, underline, colour per word); `text` keeps the plain text
    public var richText: [TextRun]?
    /// underline drawn as a wave: "squiggly" (XFDF `<squiggly>`, the web's ViewerAnnotation.subtype)
    public var subtype: String?
    public var status: ReviewStatus
    public var author: String
    public var createdAt: String
    public var modifiedAt: String

    public init(id: String = Annotation.newID(), page: Int, kind: AnnotationKind, color: String, opacity: Double = 1,
                strokeWidth: Double = 2, rect: Box? = nil, rects: [Box]? = nil, points: [Pt]? = nil,
                measure: MeasureScale? = nil, paths: [[Pt]]? = nil, text: String? = nil, fontSize: Double? = nil,
                image: String? = nil, comment: String? = nil, fill: String? = nil, rotation: Int? = nil,
                inset: [Double]? = nil, callout: [Pt]? = nil, calloutEnd: String? = nil, intent: String? = nil,
                status: ReviewStatus = .none, author: String,
                createdAt: String = Annotation.now(), modifiedAt: String? = nil) {
        self.id = id; self.page = page; self.kind = kind; self.color = color; self.opacity = opacity
        self.strokeWidth = strokeWidth; self.rect = rect; self.rects = rects; self.points = points
        self.measure = measure; self.paths = paths; self.text = text; self.fontSize = fontSize
        self.image = image; self.comment = comment; self.fill = fill; self.rotation = rotation; self.inset = inset
        self.callout = callout; self.calloutEnd = calloutEnd; self.intent = intent
        self.status = status; self.author = author
        self.createdAt = createdAt; self.modifiedAt = modifiedAt ?? createdAt
    }

    public static func newID() -> String {
        String(UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased().prefix(12))
    }

    nonisolated(unsafe) private static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    public static func now() -> String { iso.string(from: Date()) }
    public static func string(from date: Date) -> String { iso.string(from: date) }
    public static func date(from string: String) -> Date? {
        iso.date(from: string) ?? ISO8601DateFormatter().date(from: string)
    }

    /// Bounding box in page units.
    public var bounds: Box {
        if let rect { return rect }
        if let rects, let u = Box.union(rects) { return u }
        let pts = (points ?? []) + (paths?.flatMap { $0 } ?? [])
        guard let b = Box.bounding(pts) else { return Box(x: 0, y: 0, w: 0, h: 0) }
        let pad = strokeWidth / 2
        return Box(x: b.x - pad, y: b.y - pad, w: b.w + 2 * pad, h: b.h + 2 * pad)
    }

    /// Returns a copy moved by (dx, dy) page units.
    public func translated(dx: Double, dy: Double) -> Annotation {
        func m(_ p: Pt) -> Pt { Pt(x: p.x + dx, y: p.y + dy) }
        func m(_ b: Box) -> Box { Box(x: b.x + dx, y: b.y + dy, w: b.w, h: b.h) }
        var c = self
        c.rect = rect.map(m)
        c.rects = rects?.map(m)
        c.points = points?.map(m)
        c.paths = paths?.map { $0.map(m) }
        c.callout = callout?.map(m)
        return c
    }

    /// A freetext's text box: its rect less `inset` (room left for a callout line).
    public var textBox: Box? {
        guard let rect else { return nil }
        guard let i = inset, i.count == 4 else { return rect }
        return Box(x: rect.x + i[0], y: rect.y + i[1], w: max(1, rect.w - i[0] - i[2]), h: max(1, rect.h - i[1] - i[3]))
    }
}

/// Where to lay out text so that, turned by `rotation` about the box centre, it fills the box.
public func textLayoutBox(_ box: Box, rotation: Int?) -> Box {
    guard let r = rotation, r % 180 != 0 else { return box }
    let cx = box.x + box.w / 2, cy = box.y + box.h / 2
    return Box(x: cx - box.h / 2, y: cy - box.w / 2, w: box.h, h: box.w)
}

/// Top-left of the first line inside a layout box. Upright text keeps the 4-unit padding; turned text (Apryse sizes
/// those boxes tightly to the text) is padded only as far as the box allows, so it stays inside. Same as the web SDK.
public func textOrigin(_ lay: Box, rotation: Int?, size: Double, lines: Int) -> Pt {
    guard let r = rotation, r != 0 else { return Pt(x: lay.x + 4, y: lay.y + 4) }
    func room(_ span: Double, _ used: Double) -> Double { min(4, max(0, (span - used) / 2)) }
    return Pt(x: lay.x + room(lay.w, size * 0.6), y: lay.y + room(lay.h, size * 1.15 * Double(lines)))
}

/// The exchange file: `{ "format": "pdf-studio-annotations", "version": 2, "annotations": [...] }`.
public struct AnnotationFile: Codable, Sendable {
    public static let format = "pdf-studio-annotations"
    public var format: String
    public var version: Int
    public var file: String?
    public var annotations: [Annotation]

    public init(file: String?, annotations: [Annotation]) {
        self.format = Self.format; self.version = 2; self.file = file; self.annotations = annotations
    }

    private enum CodingKeys: String, CodingKey { case format, version, file, annotations }

    /// Unknown annotation kinds from newer versions are skipped instead of failing the whole file.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        format = try c.decode(String.self, forKey: .format)
        guard format == Self.format else {
            throw DecodingError.dataCorruptedError(forKey: .format, in: c, debugDescription: "Not a PDF Studio annotations file")
        }
        version = try c.decodeIfPresent(Int.self, forKey: .version) ?? 1
        file = try c.decodeIfPresent(String.self, forKey: .file)
        annotations = try c.decode([Lossy<Annotation>].self, forKey: .annotations).compactMap(\.value)
    }

    public static func decode(_ data: Data) throws -> AnnotationFile {
        try JSONDecoder().decode(AnnotationFile.self, from: data)
    }

    public func encoded() throws -> Data {
        let e = JSONEncoder()
        e.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return try e.encode(self)
    }
}

private struct Lossy<T: Decodable>: Decodable {
    let value: T?
    init(from decoder: Decoder) throws { value = try? T(from: decoder) }
}
