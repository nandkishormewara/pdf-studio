import CoreGraphics
import Foundation

/// Result of reading an XFDF document.
public struct XFDFImport: Sendable {
    /// Annotations from `<annots>`, `<add>` and `<modify>` (in document order).
    public var annotations: [Annotation] = []
    /// ids listed in `<modify>`: these replace existing annotations with the same id.
    public var modifiedIDs: Set<String> = []
    /// ids listed in `<delete>`.
    public var deletedIDs: [String] = []
    /// Form field values from `<fields>`, keyed by full field name.
    public var fields: [String: [String]] = [:]
    /// The file was cut off; only the annotations written completely were read.
    public var partial = false
}

/// XFDF (ISO 19444-1) import and export, compatible with Acrobat, the web SDK, and Apryse
/// (PDFTron) WebViewer — including its command format (`<add>`, `<modify>`, `<delete>`),
/// `TextColor`/`FontSize` on free text, and `<imagedata>` stamps.
public enum XFDF {
    /// True when an imported mark is a copy of a mark already in the file: marks made without a name (Apple Markup,
    /// for one) have no /NM and Apryse exports them unnamed, so they cannot be matched by id. Same as the web SDK.
    static func sameMark(_ a: Annotation, _ b: Annotation) -> Bool {
        guard let r = a.rect, let q = b.rect, a.kind == b.kind, a.page == b.page,
              (a.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines) == (b.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        else { return false }
        func near(_ p: Double, _ o: Double) -> Bool { abs(p - o) <= 1.5 }
        return near(r.x, q.x) && near(r.y, q.y) && near(r.x + r.w, q.x + q.w) && near(r.y + r.h, q.y + q.h)
    }

    public enum Error: Swift.Error, LocalizedError {
        case invalid(String)
        public var errorDescription: String? {
            if case .invalid(let m) = self { return "Invalid XFDF: \(m)" }
            return nil
        }
    }

    // MARK: - Import

    public static func parse(_ xml: String, geometry: (Int) -> PageGeometry?) throws -> XFDFImport {
        var out = XFDFImport()
        let root: XMLNode
        do {
            root = try XMLNode.parse(xml)
        } catch {
            // Stored markup cut off mid-write: keep the annotations written completely (see repair).
            guard let repaired = repair(xml), let second = try? XMLNode.parse(repaired) else { throw error }
            root = second
            out.partial = true
        }
        guard root.name == "xfdf" else { throw Error.invalid("root element is <\(root.name)>") }

        for fields in root.all("fields") {
            for field in fields.children where field.name == "field" { collectField(field, prefix: "", into: &out.fields) }
        }
        // Apryse comment replies (<text inreplyto="…">, not replyType="group") join the parent's comment.
        let all = root.children.filter { ["annots", "add", "modify"].contains($0.name) }.flatMap(\.children)
        let names = Set(all.compactMap { $0["name"] })
        let replies = all.filter { ($0["inreplyto"]).map(names.contains) == true && $0["replyType"] != "group" }
        var replyText: [String: [String]] = [:]
        for r in replies {
            let text = (r.first("contents")?.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty { replyText[r["inreplyto"]!, default: []].append("\(r["title"] ?? "Reply"): \(text)") }
        }
        let replyNodes = Set(replies.map(ObjectIdentifier.init))
        func read(_ el: XMLNode) -> Annotation? {
            guard !replyNodes.contains(ObjectIdentifier(el)), var a = annotation(from: el, geometry: geometry) else { return nil }
            if let extra = replyText[a.id] { a.comment = ([a.comment].compactMap { $0 } + extra).joined(separator: "\n") }
            return a
        }
        for container in root.children {
            switch container.name {
            case "annots", "add":
                out.annotations += container.children.compactMap(read)
            case "modify":
                let mods = container.children.compactMap(read)
                out.modifiedIDs.formUnion(mods.map(\.id))
                out.annotations += mods
            case "delete":
                out.deletedIDs += container.children.filter { $0.name == "id" }.map { $0.text.trimmingCharacters(in: .whitespacesAndNewlines) }
            default:
                break
            }
        }
        return out
    }

    /// A file cut off mid-write (seen on stored Apryse markup) is not valid XML. Keeps every annotation written
    /// completely and closes the document. Nil when nothing is left. Same as the web SDK's repairXfdf.
    public static func repair(_ xml: String) -> String? {
        // not popup: it sits inside other annotations, so it can close inside one that was cut off
        let tags = "text|link|freetext|line|square|circle|polygon|polyline|highlight|underline|squiggly|strikeout|stamp|caret|ink|fileattachment|sound|redact"
        guard let annots = xml.range(of: #"<(?:\w+:)?annots[\s>]"#, options: .regularExpression),
              let regex = try? NSRegularExpression(pattern: "</(?:\\w+:)?(?:\(tags))>") else { return nil }
        let ns = xml as NSString
        guard let last = regex.matches(in: xml, range: NSRange(location: 0, length: ns.length)).last,
              let end = Range(last.range, in: xml), end.upperBound > annots.lowerBound else { return nil }
        return String(xml[..<end.upperBound]) + "</annots></xfdf>"
    }

    private static func collectField(_ node: XMLNode, prefix: String, into fields: inout [String: [String]]) {
        let name = prefix.isEmpty ? (node["name"] ?? "") : "\(prefix).\(node["name"] ?? "")"
        let values = node.children.filter { $0.name == "value" }.map(\.text)
        if !values.isEmpty { fields[name] = values }
        for child in node.children where child.name == "field" { collectField(child, prefix: name, into: &fields) }
    }

    static func annotation(from el: XMLNode, geometry: (Int) -> PageGeometry?) -> Annotation? {
        let flags = (el["flags"] ?? "").lowercased().split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
        if flags.contains("hidden") || flags.contains("noview") { return nil }
        let page = Int(el["page"] ?? "0") ?? 0
        guard let g = geometry(page) else { return nil }

        func pt(_ x: Double, _ y: Double) -> Pt { g.toPage(CGPoint(x: x, y: y)) }
        func numbers(_ s: String?) -> [Double] {
            (s ?? "").split(whereSeparator: { $0 == "," || $0 == ";" || $0.isWhitespace }).compactMap { Double($0) }
        }
        func pairs(_ v: [Double]) -> [Pt] { stride(from: 0, to: v.count - 1, by: 2).map { pt(v[$0], v[$0 + 1]) } }

        let r = numbers(el["rect"])
        let rect = r.count == 4 ? Box.spanning(pt(r[0], r[1]), pt(r[2], r[3])) : Box(x: 0, y: 0, w: 0, h: 0)
        let contents = el.first("contents")?.text ?? ""
        let date = pdfDateToISO(el["date"]) ?? Annotation.now()
        var a = Annotation(
            id: el["name"].flatMap { $0.isEmpty ? nil : $0 } ?? Annotation.newID(), page: page, kind: .rect,
            color: (el["color"] ?? "#e5484d").lowercased(), opacity: Double(el["opacity"] ?? "") ?? 1,
            strokeWidth: Double(el["width"] ?? "") ?? 1, comment: contents.isEmpty ? nil : contents,
            status: ReviewStatus(rawValue: el["pdfstudio-status"] ?? "") ?? .none, author: el["title"].flatMap { $0.isEmpty ? nil : $0 } ?? "Unknown",
            createdAt: pdfDateToISO(el["creationdate"]) ?? date, modifiedAt: date)
        if let m = el["pdfstudio-measure"], let data = m.data(using: .utf8) {
            a.measure = try? JSONDecoder().decode(MeasureScale.self, from: data)
        }

        switch el.name {
        case "highlight", "underline", "strikeout", "squiggly":
            a.kind = el.name == "highlight" ? .highlight : el.name == "strikeout" ? .strikeout : .underline
            if el.name == "squiggly" { a.subtype = "squiggly" }
            let c = numbers(el["coords"])
            var rects: [Box] = []
            var i = 0
            while i + 7 < c.count {
                if let b = Box.bounding(pairs(Array(c[i..<(i + 8)]))) { rects.append(b) }
                i += 8
            }
            a.rects = rects.isEmpty ? [rect] : rects
            if a.kind == .highlight { a.opacity = min(a.opacity, 0.45) }
        case "square", "circle":
            a.kind = el.name == "square" ? .rect : .ellipse
            a.rect = rect
            a.fill = el["interior-color"]?.lowercased()
        case "line":
            let s = numbers(el["start"]), e = numbers(el["end"])
            guard s.count >= 2, e.count >= 2 else { return nil }
            a.points = [pt(s[0], s[1]), pt(e[0], e[1])]
            let endings = (el["head"] ?? "") + (el["tail"] ?? "")
            if el["intent"] == "LineDimension", a.measure != nil {
                a.kind = .distance; a.comment = nil
            } else {
                a.kind = endings.contains("Arrow") ? .arrow : .line
            }
        case "polyline", "polygon":
            let pts = pairs(numbers(el.first("vertices")?.text))
            guard pts.count > 1 else { return nil }
            if a.measure != nil {
                a.kind = el.name == "polygon" ? .area : .perimeter
                a.points = pts
                a.comment = nil
            } else {
                a.kind = .ink
                a.paths = [el.name == "polygon" ? pts + [pts[0]] : pts]
            }
        case "ink":
            a.kind = .ink
            // keep one-point strokes: they are pen taps (dots, decimal points) and are drawn as dots
            a.paths = el.all("gesture").map { gesture -> [Pt] in
                let v = numbers(gesture.text)
                return v.count == 2 ? [pt(v[0], v[1])] : pairs(v)
            }.filter { !$0.isEmpty }
            guard a.paths?.isEmpty == false else { return nil }
        case "freetext":
            a.kind = .freetext
            a.rect = rect
            a.text = contents
            a.comment = el["pdfstudio-comment"]
            let da = el.first("defaultappearance")?.text ?? ""
            let style = el.first("defaultstyle")?.text ?? ""
            a.fontSize = Double(el["FontSize"] ?? "") ?? firstNumber(before: "Tf", in: da) ?? firstNumber(before: "pt", in: style) ?? 12
            a.color = (el["TextColor"] ?? cssColor(style) ?? "#111111").lowercased()
            a.opacity = 1
            // Bold / italic / coloured words, as in the web SDK: kept only when they add styling to the plain text
            if let rich = el.first("contents-richtext"), let runs = RichText.fromXHTML(rich).map({ RichText.relative($0, to: a.color) }) {
                if el.first("contents") == nil { a.text = RichText.plainText(runs) }
                if !RichText.isPlain(runs, base: a.color) { a.richText = runs }
            }
            freeTextExtras(el, g: g, rect: rect, into: &a)
        case "text":
            a.kind = .note
            a.rect = Box(x: rect.x, y: rect.y, w: 22, h: 22)
            a.opacity = 1
            if el["color"] == nil { a.color = "#ffd84d" }
        case "stamp":
            a.rect = rect
            a.comment = nil
            if let image = el.first("imagedata")?.text.trimmingCharacters(in: .whitespacesAndNewlines), image.hasPrefix("data:image/") {
                a.kind = .signature
                a.image = image
                a.color = "#000000"
            } else {
                a.kind = .stamp
                a.text = contents.isEmpty ? (el["icon"] ?? el["subject"] ?? "Approved").uppercased() : contents
                a.strokeWidth = 2.5
            }
        case "redact":
            a.kind = .redact
            a.rect = rect
            a.color = "#e5484d"
        default:
            return nil
        }
        return a
    }

    /// Background, rotation, callout and text-box insets of a <freetext>, as Apryse WebViewer and Acrobat write them.
    private static func freeTextExtras(_ el: XMLNode, g: PageGeometry, rect: Box, into a: inout Annotation) {
        func numbers(_ s: String?) -> [Double] {
            (s ?? "").split(whereSeparator: { $0 == "," || $0 == ";" || $0.isWhitespace }).compactMap { Double($0) }
        }
        let intent = el["IT"] ?? el["intent"]
        a.intent = intent
        // `color` is the box background when the text colour is carried separately (TextColor or the default style);
        // in PDF Studio's older files without those, `color` was the text colour. Apryse never fills typewriter text.
        let separateText = el["TextColor"] != nil || el.children.contains { $0.name == "defaultstyle" }
        if let bg = el["color"]?.lowercased(), separateText, intent != "FreeTextTypewriter", bg != a.color { a.fill = bg }
        let rotation = (((Int(Double(el["rotation"] ?? "") ?? 0) - g.rotation) % 360) + 360) % 360
        a.rotation = rotation == 0 ? nil : rotation
        let rd = numbers(el["fringe"]), r = numbers(el["rect"])
        if rd.count == 4, r.count == 4, rd.contains(where: { $0 > 0.75 }) {
            let (x1, y1, x2, y2) = (min(r[0], r[2]), min(r[1], r[3]), max(r[0], r[2]), max(r[1], r[3]))
            // fringe in Apryse WebViewer's order: left, bottom, right, top (the PDF's /RD is left, top, right, bottom)
            let inner = Box.spanning(g.toPage(CGPoint(x: x1 + rd[0], y: y1 + rd[1])), g.toPage(CGPoint(x: x2 - rd[2], y: y2 - rd[3])))
            if inner.w > 0, inner.h > 0 {
                a.inset = [inner.x - rect.x, inner.y - rect.y, rect.maxX - inner.maxX, rect.maxY - inner.maxY]
            }
        }
        let cl = numbers(el["callout"])
        if cl.count >= 4 {
            a.callout = stride(from: 0, to: cl.count - 1, by: 2).map { g.toPage(CGPoint(x: cl[$0], y: cl[$0 + 1])) }
            if let head = el["head"], head != "None" { a.calloutEnd = head }
        }
    }

    // MARK: - Export

    public static func export(_ annotations: [Annotation], geometry: (Int) -> PageGeometry?, fields: [String: [String]] = [:]) -> String {
        var out = [#"<?xml version="1.0" encoding="UTF-8"?>"#, #"<xfdf xmlns="http://ns.adobe.com/xfdf/" xml:space="preserve">"#]
        if !fields.isEmpty {
            out.append("<fields>")
            for (name, values) in fields.sorted(by: { $0.key < $1.key }) {
                out.append(#"<field name="\#(esc(name))">"# + values.map { "<value>\(esc($0))</value>" }.joined() + "</field>")
            }
            out.append("</fields>")
        }
        out.append("<annots>")
        for a in annotations {
            guard let g = geometry(a.page) else { continue }
            func pt(_ p: Pt) -> String { let q = g.toPDF(p); return "\(n(q.x)),\(n(q.y))" }
            let box = g.toPDF(a.bounds)
            var attrs: [(String, String)] = [
                ("page", "\(a.page)"), ("rect", [box.minX, box.minY, box.maxX, box.maxY].map(n).joined(separator: ",")),
                ("color", a.color.uppercased()), ("opacity", n(a.opacity)), ("width", n(a.strokeWidth)), ("name", a.id),
                ("title", a.author), ("date", isoToPdfDate(a.modifiedAt)), ("creationdate", isoToPdfDate(a.createdAt)), ("flags", "print"),
            ]
            if a.status != .none { attrs.append(("pdfstudio-status", a.status.rawValue)) }
            if let m = a.measure, let d = try? JSONEncoder().encode(m) { attrs.append(("pdfstudio-measure", String(decoding: d, as: UTF8.self))) }
            var children = ""
            var contents = a.comment ?? ""
            let tag: String
            switch a.kind {
            case .highlight, .underline, .strikeout:
                tag = a.kind == .underline && a.subtype == "squiggly" ? "squiggly" : a.kind.rawValue
                attrs.append(("coords", (a.rects ?? []).map { r in
                    [Pt(x: r.x, y: r.y), Pt(x: r.maxX, y: r.y), Pt(x: r.x, y: r.maxY), Pt(x: r.maxX, y: r.maxY)].map(pt).joined(separator: ",")
                }.joined(separator: ",")))
            case .rect, .ellipse:
                tag = a.kind == .rect ? "square" : "circle"
                if let r = a.rect { let b = g.toPDF(r); attrs[1] = ("rect", [b.minX, b.minY, b.maxX, b.maxY].map(n).joined(separator: ",")) }
                if let f = a.fill { attrs.append(("interior-color", f.uppercased())) }
            case .line, .arrow, .distance:
                tag = "line"
                let p = a.points ?? []
                if p.count == 2 { attrs += [("start", pt(p[0])), ("end", pt(p[1]))] }
                attrs += [("head", "None"), ("tail", a.kind == .arrow ? "ClosedArrow" : "None")]
                if a.kind == .distance { attrs.append(("intent", "LineDimension")); contents = [Measure.label(a), a.comment ?? ""].filter { !$0.isEmpty }.joined(separator: "\n") }
            case .perimeter, .area:
                tag = a.kind == .area ? "polygon" : "polyline"
                children += "<vertices>\((a.points ?? []).map(pt).joined(separator: ";"))</vertices>"
                attrs.append(("intent", a.kind == .area ? "PolygonDimension" : "PolyLineDimension"))
                contents = [Measure.label(a), a.comment ?? ""].filter { !$0.isEmpty }.joined(separator: "\n")
            case .ink:
                tag = "ink"
                children += "<inklist>" + (a.paths ?? []).map { "<gesture>\($0.map(pt).joined(separator: ";"))</gesture>" }.joined() + "</inklist>"
            case .freetext:
                tag = "freetext"
                contents = a.text ?? ""
                if let c = a.comment { attrs.append(("pdfstudio-comment", c)) }
                let rgb = RGB(hex: a.color)
                let size = n(a.fontSize ?? 14)
                children += "<defaultappearance>/Helv \(size) Tf \(n(rgb.r)) \(n(rgb.g)) \(n(rgb.b)) rg</defaultappearance>"
                children += "<defaultstyle>font: Helvetica \(size)pt; text-align: left; text-vertical-align: top; color: \(a.color.uppercased())</defaultstyle>"
                if let runs = a.richText, !runs.isEmpty {
                    children += "<contents-richtext>\(RichText.xhtml(runs, base: a.color, fontSize: a.fontSize ?? 14))</contents-richtext>"
                }
                // Apryse's convention: TextColor carries the text colour, `color` the background (absent = none).
                attrs += [("TextColor", a.color.uppercased()), ("FontSize", size)]
                attrs.removeAll { $0.0 == "color" }
                if let f = a.fill { attrs.append(("color", f.uppercased())) }
                if a.callout == nil { attrs.removeAll { $0.0 == "width" }; attrs.append(("width", "0")) }
                if let it = a.intent { attrs.append(("IT", it)) }
                if let rot = a.rotation, rot != 0 { attrs.append(("rotation", "\(((rot + g.rotation) % 360 + 360) % 360)")) }
                if let r = a.rect {
                    let outer = g.toPDF(r)
                    attrs[1] = ("rect", [outer.minX, outer.minY, outer.maxX, outer.maxY].map(n).joined(separator: ","))
                    if let i = a.inset, i.count == 4 {
                        let inner = g.toPDF(Box(x: r.x + i[0], y: r.y + i[1], w: r.w - i[0] - i[2], h: r.h - i[1] - i[3]))
                        attrs.append(("fringe", [inner.minX - outer.minX, inner.minY - outer.minY, outer.maxX - inner.maxX, outer.maxY - inner.maxY].map(n).joined(separator: ",")))
                    }
                }
                if let cl = a.callout { attrs += [("callout", cl.map(pt).joined(separator: ",")), ("head", a.calloutEnd ?? "None")] }
            case .note:
                tag = "text"
                attrs.append(("icon", "Comment"))
            case .stamp:
                tag = "stamp"
                attrs.append(("icon", (a.text ?? "Approved").filter(\.isLetter).isEmpty ? "Approved" : String((a.text ?? "").filter(\.isLetter))))
                contents = a.text ?? ""
            case .signature:
                tag = "stamp"
                attrs.append(("icon", "Signature"))
                if let img = a.image { children += "<imagedata>\(esc(img))</imagedata>" }
            case .redact:
                tag = "redact"
            }
            if !contents.isEmpty { children = "<contents>\(esc(contents))</contents>" + children }
            out.append("<\(tag) " + attrs.map { "\($0.0)=\"\(esc($0.1))\"" }.joined(separator: " ") + ">\(children)</\(tag)>")
        }
        out += ["</annots>", "</xfdf>"]
        return out.joined(separator: "\n")
    }

    // MARK: - Helpers

    private static func n(_ v: Double) -> String {
        let r = (v * 100).rounded() / 100
        return r == r.rounded() ? String(Int(r)) : String(r)
    }
    private static func n(_ v: CGFloat) -> String { n(Double(v)) }

    private static func esc(_ s: String) -> String {
        var o = ""
        for c in s.unicodeScalars {
            switch c {
            case "<": o += "&lt;"
            case ">": o += "&gt;"
            case "&": o += "&amp;"
            case "\"": o += "&quot;"
            case "'": o += "&apos;"
            default: o.unicodeScalars.append(c)
            }
        }
        return o
    }

    private static func firstNumber(before token: String, in s: String) -> Double? {
        guard let range = s.range(of: #"([\d.]+)\s*"# + token, options: .regularExpression) else { return nil }
        return Double(s[range].replacingOccurrences(of: token, with: "").trimmingCharacters(in: .whitespaces))
    }

    private static func cssColor(_ style: String) -> String? {
        guard let r = style.range(of: #"color:\s*#[0-9a-fA-F]{6}"#, options: .regularExpression) else { return nil }
        return String(style[r].suffix(7))
    }

    /// `D:YYYYMMDDHHmmSS+05'30'` → ISO 8601.
    public static func pdfDateToISO(_ s: String?) -> String? {
        guard let s, let m = s.range(of: #"(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Zz+\-])?(\d{2})?'?(\d{2})?"#, options: .regularExpression) else { return nil }
        let t = String(s[m])
        func part(_ from: Int, _ len: Int) -> Int? {
            guard t.count >= from + len else { return nil }
            let i = t.index(t.startIndex, offsetBy: from)
            return Int(t[i..<t.index(i, offsetBy: len)])
        }
        var c = DateComponents()
        c.year = part(0, 4); c.month = part(4, 2) ?? 1; c.day = part(6, 2) ?? 1
        c.hour = part(8, 2) ?? 0; c.minute = part(10, 2) ?? 0; c.second = part(12, 2) ?? 0
        var offset = 0
        if t.count > 14 {
            let sign = t[t.index(t.startIndex, offsetBy: 14)]
            let digits = t.dropFirst(15).filter(\.isNumber)
            let hh = Int(digits.prefix(2)) ?? 0, mm = Int(digits.dropFirst(2).prefix(2)) ?? 0
            offset = (hh * 3600 + mm * 60) * (sign == "-" ? -1 : sign == "+" ? 1 : 0)
        }
        c.timeZone = TimeZone(secondsFromGMT: offset)
        guard let date = Calendar(identifier: .gregorian).date(from: c) else { return nil }
        return Annotation.string(from: date)
    }

    static func isoToPdfDate(_ iso: String) -> String {
        guard let d = Annotation.date(from: iso) else { return "" }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "'D:'yyyyMMddHHmmss'Z'"
        return f.string(from: d)
    }
}

/// Minimal DOM over Foundation's XMLParser (namespace prefixes stripped).
final class XMLNode {
    let name: String
    let attributes: [String: String]
    var children: [XMLNode] = []
    var text = ""
    /// This node's own text and child elements in document order (rich text needs the order of words and spans).
    var parts: [Part] = []
    enum Part { case text(String), node(XMLNode) }

    init(name: String, attributes: [String: String]) { self.name = name; self.attributes = attributes }

    subscript(_ key: String) -> String? { attributes[key] }
    func first(_ name: String) -> XMLNode? { all(name).first }
    func all(_ name: String) -> [XMLNode] {
        children.flatMap { ($0.name == name ? [$0] : []) + $0.all(name) }
    }

    static func parse(_ xml: String) throws -> XMLNode {
        let builder = Builder()
        let parser = XMLParser(data: Data(xml.utf8))
        parser.shouldProcessNamespaces = true
        parser.delegate = builder
        guard parser.parse(), let root = builder.root else {
            throw XFDF.Error.invalid(parser.parserError?.localizedDescription ?? "empty document")
        }
        return root
    }

    private final class Builder: NSObject, XMLParserDelegate {
        var root: XMLNode?
        var stack: [XMLNode] = []

        func parser(_ parser: XMLParser, didStartElement elementName: String, namespaceURI: String?, qualifiedName: String?, attributes: [String: String] = [:]) {
            let node = XMLNode(name: elementName, attributes: attributes)
            if let parent = stack.last { parent.children.append(node); parent.parts.append(.node(node)) } else { root = node }
            stack.append(node)
        }

        func parser(_ parser: XMLParser, didEndElement elementName: String, namespaceURI: String?, qualifiedName: String?) {
            let node = stack.removeLast()
            // Text of rich-text children (e.g. <contents-richtext><p><span>) bubbles up for simple reading.
            if let parent = stack.last, parent.name != "xfdf", node.name != "contents", node.name != "imagedata",
               ["p", "span", "body"].contains(node.name) {
                parent.text += node.text
            }
        }

        func parser(_ parser: XMLParser, foundCharacters string: String) {
            stack.last?.text += string; stack.last?.parts.append(.text(string))
        }
        func parser(_ parser: XMLParser, foundCDATA CDATABlock: Data) {
            let s = String(decoding: CDATABlock, as: UTF8.self)
            stack.last?.text += s; stack.last?.parts.append(.text(s))
        }
    }
}
