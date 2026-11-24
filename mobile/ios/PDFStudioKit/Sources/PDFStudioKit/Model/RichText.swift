import Foundation

/// A styled piece of a text box's text. Lines are separated by "\n" inside `text`. `color` is #rrggbb;
/// nil means the annotation's colour. Same model and JSON as the web SDK's `TextRun` (web/src/sdk/richtext.ts):
/// style flags are written only when true.
public struct TextRun: Codable, Hashable, Sendable {
    public var text: String
    public var bold: Bool?
    public var italic: Bool?
    public var underline: Bool?
    public var color: String?

    public init(text: String, bold: Bool = false, italic: Bool = false, underline: Bool = false, color: String? = nil) {
        self.text = text
        self.bold = bold ? true : nil; self.italic = italic ? true : nil; self.underline = underline ? true : nil
        self.color = color
    }

    public var isBold: Bool { bold == true }
    public var isItalic: Bool { italic == true }
    public var isUnderlined: Bool { underline == true }
}

/// Rich text for text boxes, read from and written to XFDF `<contents-richtext>`: an XHTML body of
/// `<p>`/`<span>` with CSS styles, as Acrobat and Apryse WebViewer write it. Mirrors the web SDK and Android.
public enum RichText {
    /// Only #rrggbb survives: colours come from imported files.
    static func safeColor(_ c: String?) -> String? {
        guard let c, c.range(of: "^#[0-9a-fA-F]{6}$", options: .regularExpression) != nil else { return nil }
        return c.lowercased()
    }

    private static func same(_ a: TextRun, _ b: TextRun) -> Bool {
        a.isBold == b.isBold && a.isItalic == b.isItalic && a.isUnderlined == b.isUnderlined && (a.color ?? "") == (b.color ?? "")
    }

    /// Merges neighbouring runs with the same style and drops empty ones.
    public static func normalize(_ runs: [TextRun]) -> [TextRun] {
        var out: [TextRun] = []
        for r in runs where !r.text.isEmpty {
            let clean = TextRun(text: r.text, bold: r.isBold, italic: r.isItalic, underline: r.isUnderlined, color: safeColor(r.color))
            if let last = out.last, same(last, clean) { out[out.count - 1].text += clean.text } else { out.append(clean) }
        }
        return out
    }

    public static func plainText(_ runs: [TextRun]) -> String { runs.map(\.text).joined() }

    /// True when the runs carry no styling beyond the base colour (so plain text is enough).
    public static func isPlain(_ runs: [TextRun], base: String?) -> Bool {
        runs.allSatisfy { !$0.isBold && !$0.isItalic && !$0.isUnderlined && ($0.color == nil || $0.color == base?.lowercased()) }
    }

    /// Drops colours equal to the annotation colour (imported XHTML spells it out on every span).
    public static func relative(_ runs: [TextRun], to base: String) -> [TextRun] {
        normalize(runs.map { r in
            var r = r
            if r.color == base.lowercased() { r.color = nil }
            return r
        })
    }

    /// Splits runs into lines of runs.
    public static func lines(_ runs: [TextRun]) -> [[TextRun]] {
        var lines: [[TextRun]] = [[]]
        for r in runs {
            for (i, part) in r.text.components(separatedBy: "\n").enumerated() {
                if i > 0 { lines.append([]) }
                if !part.isEmpty {
                    var piece = r; piece.text = part
                    lines[lines.count - 1].append(piece)
                }
            }
        }
        return lines
    }

    /// Lines of runs as drawn in a box `maxWidth` wide: each paragraph is wrapped between words, as Apryse WebViewer
    /// wraps a free text box. A line breaks only when the next word would pass `maxWidth`; spaces at a wrap are
    /// dropped; a word wider than the box stays whole. Same as the web SDK's `wrapRuns`.
    public static func wrap(_ runs: [TextRun], maxWidth: Double, measure: (String, TextRun) -> Double) -> [[TextRun]] {
        func isSpace(_ s: String) -> Bool { !s.isEmpty && s.allSatisfy(\.isWhitespace) }
        var out: [[TextRun]] = []
        for para in lines(runs) {
            var tokens: [TextRun] = []
            for r in para {
                var current = ""
                for ch in r.text {
                    if !current.isEmpty && (ch.isWhitespace != current.last!.isWhitespace) {
                        var t = r; t.text = current; tokens.append(t); current = ""
                    }
                    current.append(ch)
                }
                if !current.isEmpty { var t = r; t.text = current; tokens.append(t) }
            }
            var line: [TextRun] = []
            var width = 0.0
            var wrapped = false
            for t in tokens {
                let space = isSpace(t.text)
                if space && wrapped && line.isEmpty { continue }
                let w = measure(t.text, t)
                if !space && line.contains(where: { !isSpace($0.text) }) && width + w > maxWidth {
                    while let last = line.last, isSpace(last.text) { line.removeLast() }
                    out.append(normalize(line))
                    line = []; width = 0; wrapped = true
                }
                line.append(t)
                width += w
            }
            out.append(normalize(line))
        }
        return out
    }

    private struct Style { var bold = false, italic = false, underline = false; var color: String? }

    private static func apply(_ css: String, to style: Style, keepColor: Bool = true) -> Style {
        var s = style
        for decl in css.split(separator: ";") {
            let kv = decl.split(separator: ":", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces).lowercased() }
            guard kv.count == 2, !kv[0].isEmpty, !kv[1].isEmpty else { continue }
            let (k, v) = (kv[0], kv[1])
            if k == "font-weight", v == "bold" || (Int(v) ?? 0) >= 600 { s.bold = true }
            if k == "font-style", v == "italic" { s.italic = true }
            if k == "text-decoration", v.contains("underline") { s.underline = true }
            if k == "color", keepColor { s.color = toHex(v) }
        }
        return s
    }

    private static func toHex(_ c: String) -> String {
        let s = c.trimmingCharacters(in: .whitespaces)
        if s.range(of: "^#[0-9a-fA-F]{6}$", options: .regularExpression) != nil { return s.lowercased() }
        if s.range(of: "^#[0-9a-fA-F]{3}$", options: .regularExpression) != nil {
            return ("#" + s.dropFirst().map { "\($0)\($0)" }.joined()).lowercased()
        }
        if let m = s.range(of: #"rgba?\((\d+)\D+(\d+)\D+(\d+)"#, options: [.regularExpression, .caseInsensitive]) {
            let nums = s[m].split(whereSeparator: { !$0.isNumber }).compactMap { Int($0) }.prefix(3)
            if nums.count == 3 { return "#" + nums.map { String(format: "%02x", min(255, max(0, $0))) }.joined() }
        }
        return s
    }

    /// Parses an XHTML rich-text body (or an element containing one) into runs; nil when empty.
    static func fromXHTML(_ source: XMLNode) -> [TextRun]? {
        let body = source.name == "body" ? source : (source.first("body") ?? source)
        var runs: [TextRun] = []
        var first = true
        func walk(_ node: XMLNode, _ style: Style) {
            let tag = node.name.lowercased()
            if tag == "br" { runs.append(TextRun(text: "\n", bold: style.bold, italic: style.italic, underline: style.underline, color: style.color)); return }
            var s = style
            if tag == "b" || tag == "strong" { s.bold = true }
            if tag == "i" || tag == "em" { s.italic = true }
            if tag == "u" { s.underline = true }
            s = apply(node["style"] ?? "", to: s)
            if tag == "p" || tag == "div" {
                if !first { runs.append(TextRun(text: "\n")) }
                first = false
            }
            for part in node.parts {
                switch part {
                case .text(let t): runs.append(TextRun(text: t, bold: s.bold, italic: s.italic, underline: s.underline, color: s.color))
                case .node(let child): walk(child, s)
                }
            }
        }
        // the body colour is the annotation colour
        let base = apply(body["style"] ?? "", to: Style(), keepColor: false)
        for part in body.parts {
            switch part {
            case .text(let t): runs.append(TextRun(text: t, bold: base.bold, italic: base.italic, underline: base.underline))
            case .node(let child): walk(child, base)
            }
        }
        let out = normalize(runs)
        return out.isEmpty ? nil : out
    }

    private static func escape(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;").replacingOccurrences(of: "\"", with: "&quot;")
    }

    /// XHTML body for XFDF `<contents-richtext>`, as the web SDK writes it.
    public static func xhtml(_ runs: [TextRun], base: String, fontSize: Double) -> String {
        let paras = lines(runs).map { line in
            "<p dir=\"ltr\">" + line.map { r in
                let css = [r.isBold ? "font-weight:bold" : nil, r.isItalic ? "font-style:italic" : nil, r.isUnderlined ? "text-decoration:underline" : nil,
                           "color:\((safeColor(r.color) ?? safeColor(base) ?? "#000000").uppercased())"].compactMap { $0 }.joined(separator: ";")
                return "<span style=\"\(css)\">\(escape(r.text))</span>"
            }.joined() + "</p>"
        }.joined()
        let size = fontSize.rounded() == fontSize ? String(Int(fontSize)) : String(fontSize)
        return "<body xmlns=\"http://www.w3.org/1999/xhtml\" xmlns:xfa=\"http://www.xfa.org/schema/xfa-data/1.0/\" xfa:APIVersion=\"Acrobat:23.0.0\" xfa:spec=\"2.0.2\" style=\"font-size:\(size)pt;font-family:Helvetica\">\(paras)</body>"
    }
}
