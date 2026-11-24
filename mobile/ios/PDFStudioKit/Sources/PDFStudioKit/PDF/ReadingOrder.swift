import Foundation

/// What reading order needs of a detected table: its box and its cells' grid positions and boxes.
public struct TableBox: Codable, Equatable, Sendable {
    public struct Cell: Codable, Equatable, Sendable {
        public var row: Int
        public var col: Int
        public var box: Box
        public init(row: Int, col: Int, box: Box) { self.row = row; self.col = col; self.box = box }
    }
    public var box: Box
    public var cells: [Cell]
    public init(box: Box, cells: [Cell]) { self.box = box; self.cells = cells }
}

/// Reading order: a page's lines in the order a person reads them, not the order the file draws them.
/// The same steps and constants as the web SDK (`web/src/sdk/readingOrder.ts`), the server
/// (`server/app/reading_order.py`) and Android (`ReadingOrder.kt`); `mobile/shared/reading-order/cases.json`
/// keeps them in step.
///
/// 1. Lines are split where a gap is wider than `columnGap` × the word height (a line drawn across two columns).
/// 2. Empty space across the page taller than `sectionGap` lines ends a section; sections are read top to bottom.
/// 3. Within a section, Breuel's rules: a before b when they overlap horizontally and a is higher, or a is
///    entirely left of b and nothing between them vertically crosses the gap; then a topological sort.
/// 4. Lines inside a table are read row by row, cells joined by tabs (tables come from the server, or none).
public enum ReadingOrder {
    public static let columnGap = 0.9
    public static let sectionGap = 1.5

    private static func cy(_ b: Box) -> Double { b.y + b.h / 2 }
    private static func median(_ v: [Double]) -> Double {
        guard !v.isEmpty else { return 0 }
        let s = v.sorted()
        return s.count % 2 == 1 ? s[s.count / 2] : (s[s.count / 2 - 1] + s[s.count / 2]) / 2
    }
    private static func union(_ boxes: [Box]) -> Box {
        let x = boxes.map(\.x).min()!, y = boxes.map(\.y).min()!
        func r(_ v: Double) -> Double { (v * 100).rounded() / 100 }
        return Box(x: r(x), y: r(y), w: r(boxes.map(\.maxX).max()! - x), h: r(boxes.map(\.maxY).max()! - y))
    }
    private static func inside(_ p: Box, _ b: Box) -> Bool {
        let x = p.x + p.w / 2, y = cy(p)
        return x >= b.x && x <= b.maxX && y >= b.y && y <= b.maxY
    }

    /// True when most letters on the page are in a right-to-left script.
    public static func isRTL(_ lines: [TextLine]) -> Bool {
        var letters = 0, rtl = 0
        for line in lines {
            for s in line.text.unicodeScalars where CharacterSet.letters.contains(s) {
                letters += 1
                let v = s.value
                if (0x0590...0x07FF).contains(v) || (0xFB1D...0xFDFF).contains(v) || (0xFE70...0xFEFF).contains(v) { rtl += 1 }
            }
        }
        return letters > 0 && Double(rtl) / Double(letters) > 0.5
    }

    /// The line cut where a word starts a new row (it overlaps the row so far by less than half its height;
    /// PDFKit hands back several rows of a column as one line), then within each row at column-wide gaps.
    /// Words keep their order in the line.
    public static func splitAtGaps(_ line: TextLine) -> [TextLine] {
        let words = line.words
        guard words.count >= 2, line.box.h <= line.box.w else { return [line] }
        var rows: [[Int]] = []
        var top = 0.0, bottom = 0.0
        for (i, w) in words.enumerated() {
            let overlap = min(bottom, w.box.maxY) - max(top, w.box.y)
            if !rows.isEmpty && overlap >= 0.5 * min(w.box.h, bottom - top) {
                rows[rows.count - 1].append(i)
                top = min(top, w.box.y); bottom = max(bottom, w.box.maxY)
            } else {
                rows.append([i])
                top = w.box.y; bottom = w.box.maxY
            }
        }
        var piece = [Int](repeating: 0, count: words.count)
        var n = -1
        for row in rows {
            let m = median(row.map { words[$0].box.h })
            let height = m > 0 ? m : 1
            var right = -Double.infinity
            for i in row.sorted(by: { words[$0].box.x < words[$1].box.x }) {
                if right == -Double.infinity || words[i].box.x - right > columnGap * height { n += 1 }
                piece[i] = n
                right = max(right, words[i].box.maxX)
            }
        }
        guard n > 0 else { return [line] }
        return (0...n).map { k in
            let ws = words.indices.filter { piece[$0] == k }.map { words[$0] }
            var out = line
            out.text = ws.map(\.text).joined(separator: " ")
            out.box = union(ws.map(\.box))
            out.words = ws
            return out
        }
    }

    private final class Unit {
        let lines: [TextLine]
        let box: Box
        let cy: Double
        var x0 = 0.0, x1 = 0.0
        init(_ lines: [TextLine], _ box: Box) { self.lines = lines; self.box = box; cy = box.y + box.h / 2 }
    }

    private static func tableRows(_ table: TableBox, _ pieces: [TextLine]) -> [TextLine] {
        func dist(_ p: Box, _ b: Box) -> Double { hypot(p.x + p.w / 2 - (b.x + b.w / 2), cy(p) - cy(b)) }
        var byCell: [(Int, [TextLine])] = []
        for p in pieces {
            var k = table.cells.firstIndex { inside(p.box, $0.box) } ?? -1
            if k < 0 {
                k = 0
                for (i, c) in table.cells.enumerated() where dist(p.box, c.box) < dist(p.box, table.cells[k].box) { k = i }
            }
            if let j = byCell.firstIndex(where: { $0.0 == k }) { byCell[j].1.append(p) } else { byCell.append((k, [p])) }
        }
        var rows: [Int: [(Int, [TextLine])]] = [:]
        for (k, ls) in byCell {
            let c = table.cells[k]
            rows[c.row, default: []].append((c.col, ls.sorted { cy($0.box) != cy($1.box) ? cy($0.box) < cy($1.box) : $0.box.x < $1.box.x }))
        }
        return rows.keys.sorted().map { r in
            let cells = rows[r]!.sorted { $0.0 < $1.0 }
            var texts = [String](repeating: "", count: cells.last!.0 + 1)
            for (col, ls) in cells { texts[col] = ls.map(\.text).joined(separator: " ") }
            let ls = cells.flatMap(\.1)
            var out = ls[0]
            out.text = texts.joined(separator: "\t")
            out.box = union(ls.map(\.box))
            out.words = ls.flatMap(\.words)
            return out
        }
    }

    /// The page's lines in reading order. Lines inside one of `tables` are read as that table's rows.
    public static func order(_ lines: [TextLine], tables: [TableBox] = [], rtl: Bool? = nil) -> [TextLine] {
        let rtl = rtl ?? isRTL(lines)
        let pieces = lines.flatMap(splitAtGaps)
        var units: [Unit] = []
        var inTable: [(Int, [TextLine])] = []
        for p in pieces {
            if let t = tables.firstIndex(where: { inside(p.box, $0.box) }) {
                if let j = inTable.firstIndex(where: { $0.0 == t }) { inTable[j].1.append(p) } else { inTable.append((t, [p])) }
            } else {
                units.append(Unit([p], p.box))
            }
        }
        for (t, ls) in inTable { units.append(Unit(tableRows(tables[t], ls), tables[t].box)) }
        guard !units.isEmpty else { return [] }

        let m = median(pieces.map(\.box.h))
        let lineH = m > 0 ? m : 1
        var sections: [[Unit]] = []
        var bottom = -Double.infinity
        // a stable sort, like the other implementations
        for u in units.enumerated().sorted(by: { $0.element.box.y != $1.element.box.y ? $0.element.box.y < $1.element.box.y : $0.offset < $1.offset }).map(\.element) {
            if sections.isEmpty || u.box.y - bottom > sectionGap * lineH { sections.append([]) }
            sections[sections.count - 1].append(u)
            bottom = max(bottom, u.box.maxY)
        }
        return sections.flatMap { orderSection($0, rtl: rtl) }
    }

    private static func orderSection(_ units: [Unit], rtl: Bool) -> [TextLine] {
        for u in units { // mirrored for right-to-left pages, so "left of" means "read first"
            u.x0 = rtl ? -u.box.maxX : u.box.x
            u.x1 = rtl ? -u.box.x : u.box.maxX
        }
        let n = units.count
        var before = [[Int]](repeating: [], count: n)
        for a in 0..<n {
            for b in 0..<n where a != b {
                let A = units[a], B = units[b]
                let overlap = min(A.x1, B.x1) - max(A.x0, B.x0)
                if overlap > 1 {
                    if A.cy < B.cy { before[b].append(a) }
                } else if A.x1 <= B.x0 + 1 {
                    let lo = min(A.cy, B.cy), hi = max(A.cy, B.cy)
                    let blocked = units.indices.contains { c in
                        c != a && c != b && units[c].cy > lo && units[c].cy < hi && units[c].x0 < A.x1 && units[c].x1 > B.x0
                    }
                    if !blocked { before[b].append(a) }
                }
            }
        }
        func first(_ cands: [Int]) -> Int {
            cands.dropFirst().reduce(cands[0]) { best, i in
                let y = units[i].cy, by = units[best].cy
                return y < by - 0.5 || (abs(y - by) <= 0.5 && units[i].x0 < units[best].x0) ? i : best
            }
        }
        var done = [Bool](repeating: false, count: n)
        var order: [Int] = []
        while order.count < n {
            let free = (0..<n).filter { !done[$0] && before[$0].allSatisfy { done[$0] } }
            let pick = first(free.isEmpty ? (0..<n).filter { !done[$0] } : free)
            done[pick] = true
            order.append(pick)
        }
        return order.flatMap { units[$0].lines }
    }
}
