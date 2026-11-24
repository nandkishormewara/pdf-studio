import CoreGraphics
import Foundation
import PDFKit

/// A word with its box in page units (points, top-left origin of the page as displayed).
public struct TextWord: Codable, Equatable, Sendable {
    public var text: String
    public var box: Box
}

/// A line of text with its words; `font` and `size` are those of its first character.
public struct TextLine: Codable, Equatable, Sendable {
    public var text: String
    public var box: Box
    public var font: String
    public var size: Double
    public var words: [TextWord]
}

/// One page's text, in the same shape as the web SDK's `pdf-studio-text` JSON.
public struct PageTextContent: Codable, Equatable, Sendable {
    /// 1-based, as in the JSON
    public var page: Int
    public var width: Double
    public var height: Double
    public var lines: [TextLine]
}

extension StudioDocument {
    /// Text of the given pages (0-based; all when nil) as lines and words with boxes and fonts.
    /// Boxes come from PDFKit's per-character bounds, converted like every other coordinate in the SDK.
    /// `readingOrder`: columns one after another (`ReadingOrder`, the default, as on the web and the server);
    /// false keeps the order the file draws the text.
    public func extractText(pages: [Int]? = nil, readingOrder: Bool = true) -> [PageTextContent] {
        (pages ?? Array(0..<pageCount)).compactMap { index in
            guard let page = pdf.page(at: index) else { return nil }
            let g = geometry(page: index)
            let size = g.toPage(page.bounds(for: .cropBox))
            let drawn = lines(of: page, geometry: g)
            return PageTextContent(page: index + 1, width: round2(size.w), height: round2(size.h),
                                   lines: readingOrder ? ReadingOrder.order(drawn, tables: StreamTables.detect(drawn.flatMap(\.words)).map(\.tableBox)) : drawn)
        }
    }

    /// Plain text with "===== Page n =====" headings, as the web SDK, Android and the server write it.
    public func extractPlainText(pages: [Int]? = nil, pageMarkers: Bool = true, readingOrder: Bool = true) -> String {
        extractText(pages: pages, readingOrder: readingOrder).map { p in
            (pageMarkers ? "===== Page \(p.page) =====\n" : "") + p.lines.map(\.text).joined(separator: "\n")
        }.joined(separator: "\n\n") + "\n"
    }

    /// The web SDK's `pdf-studio-text` JSON (version 1).
    public func extractTextJSON(pages: [Int]? = nil, readingOrder: Bool = true) throws -> Data {
        struct Envelope: Encodable {
            let format = "pdf-studio-text", version = 1
            let file: String
            let units = "PDF points; origin top-left of the page as displayed; box = {x, y, w, h}"
            let pages: [PageTextContent]
        }
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return try enc.encode(Envelope(file: name, pages: extractText(pages: pages, readingOrder: readingOrder)))
    }

    private func lines(of page: PDFPage, geometry g: PageGeometry) -> [TextLine] {
        guard let string = page.string, !string.isEmpty else { return [] }
        let attributed = page.attributedString
        let ns = string as NSString
        var out: [TextLine] = []
        ns.enumerateSubstrings(in: NSRange(location: 0, length: ns.length), options: [.byLines, .substringNotRequired]) { _, lineRange, _, _ in
            var words: [TextWord] = []
            var word = ""
            var wordBox: Box?
            func endWord() {
                if !word.isEmpty, let b = wordBox { words.append(TextWord(text: word, box: b.rounded())) }
                word = ""; wordBox = nil
            }
            // Characters (grapheme clusters) so Hindi conjuncts and emoji stay whole.
            ns.enumerateSubstrings(in: lineRange, options: .byComposedCharacterSequences) { ch, range, _, _ in
                guard let ch else { return }
                if ch.unicodeScalars.allSatisfy({ CharacterSet.whitespacesAndNewlines.contains($0) || CharacterSet.controlCharacters.contains($0) }) {
                    endWord(); return
                }
                // not characterBounds(at:): its index drifts from page.string after the spaces and line breaks
                // PDFKit inserts (one character off on the next line, two the line after); a selection maps exactly
                let rect = page.selection(for: range)?.bounds(for: page) ?? .zero
                word += ch
                if rect.width > 0 || rect.height > 0 {
                    let b = g.toPage(rect)
                    wordBox = wordBox.map { $0.union(b) } ?? b
                }
            }
            endWord()
            let text = ns.substring(with: lineRange).trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty, let first = words.first else { return }
            var font = ""
            var size = 0.0
            if let attributed, lineRange.location < attributed.length,
               let f = attributed.attribute(.font, at: lineRange.location, effectiveRange: nil) as? PlatformFont {
                font = f.fontName.replacingOccurrences(of: #"^[A-Z]{6}\+"#, with: "", options: .regularExpression)
                size = round2(Double(f.pointSize))
            }
            let box = words.dropFirst().reduce(first.box) { $0.union($1.box) }
            out.append(TextLine(text: text, box: box.rounded(), font: font, size: size, words: words))
        }
        return out
    }
}

private func round2(_ v: Double) -> Double { (v * 100).rounded() / 100 }

private extension Box {
    func union(_ o: Box) -> Box {
        let x0 = min(x, o.x), y0 = min(y, o.y)
        return Box(x: x0, y: y0, w: max(maxX, o.maxX) - x0, h: max(maxY, o.maxY) - y0)
    }
    func rounded() -> Box { Box(x: round2(x), y: round2(y), w: round2(w), h: round2(h)) }
}
