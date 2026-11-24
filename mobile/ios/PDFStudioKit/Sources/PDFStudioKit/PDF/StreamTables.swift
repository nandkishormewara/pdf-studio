import Foundation

/// Tables without ruling lines, found from words that line up in columns: the "stream" half of the web
/// SDK's table detection (`web/src/sdk/tables.ts`), with the same steps and constants. The device reads no
/// ruling lines, so tables drawn with lines are found only when their text lines up too. Used to read
/// table rows in `ReadingOrder`; `mobile/shared/tables/tables-page.json` (`expectedWithoutLines`) checks it.
public enum StreamTables {
    public static let snap = 3.0
    public static let rowGap = 1.2
    public static let minStreamRows = 3

    public struct Cell: Equatable, Sendable {
        public var row: Int, col: Int, colSpan: Int
        public var text: String
        public var box: Box
    }
    public struct Table: Equatable, Sendable {
        public var box: Box
        public var rows: Int, cols: Int
        public var cells: [Cell]
        public var tableBox: TableBox { TableBox(box: box, cells: cells.map { .init(row: $0.row, col: $0.col, box: $0.box) }) }
    }

    private final class Chunk {
        var words: [TextWord]
        let x0: Double
        var x1: Double
        init(_ w: TextWord) { words = [w]; x0 = w.box.x; x1 = w.box.maxX }
    }
    private struct Row { let words: [TextWord]; let top, bottom, height: Double; let chunks: [Chunk] }

    private static func cy(_ b: Box) -> Double { b.y + b.h / 2 }
    private static func median(_ v: [Double]) -> Double {
        guard !v.isEmpty else { return 0 }
        let s = v.sorted()
        return s.count % 2 == 1 ? s[s.count / 2] : (s[s.count / 2 - 1] + s[s.count / 2]) / 2
    }
    private static func union(_ boxes: [Box]) -> Box {
        func r(_ v: Double) -> Double { (v * 100).rounded() / 100 }
        let x = boxes.map(\.x).min()!, y = boxes.map(\.y).min()!
        return Box(x: r(x), y: r(y), w: r(boxes.map(\.maxX).max()! - x), h: r(boxes.map(\.maxY).max()! - y))
    }
    /// Stable sort by vertical centre, then x (the other implementations' sorts are stable too).
    private static func byPosition(_ words: [TextWord]) -> [TextWord] {
        words.enumerated().sorted { a, b in
            let (ya, yb) = (cy(a.element.box), cy(b.element.box))
            if ya != yb { return ya < yb }
            if a.element.box.x != b.element.box.x { return a.element.box.x < b.element.box.x }
            return a.offset < b.offset
        }.map(\.element)
    }
    private static func groupRows(_ words: [TextWord]) -> [[TextWord]] {
        var groups: [[TextWord]] = []
        for w in byPosition(words) {
            if let g = groups.last, abs(cy(w.box) - cy(g[0].box)) <= 0.5 * min(w.box.h, g[0].box.h) {
                groups[groups.count - 1].append(w)
            } else {
                groups.append([w])
            }
        }
        return groups
    }

    /// Lines top to bottom, words left to right (the web SDK's `wordsToText`).
    public static func wordsToText(_ words: [TextWord]) -> String {
        groupRows(words).map { $0.stableSorted { $0.box.x < $1.box.x }.map(\.text).joined(separator: " ") }.joined(separator: "\n")
    }

    private static func textRows(_ words: [TextWord]) -> [Row] {
        groupRows(words).map { g in
            let ws = g.stableSorted { $0.box.x < $1.box.x }
            let m = median(ws.map(\.box.h))
            let height = m > 0 ? m : 1
            var chunks: [Chunk] = []
            for w in ws {
                if let c = chunks.last, w.box.x - c.x1 <= ReadingOrder.columnGap * height {
                    c.words.append(w); c.x1 = max(c.x1, w.box.maxX)
                } else {
                    chunks.append(Chunk(w))
                }
            }
            return Row(words: ws, top: ws.map(\.box.y).min()!, bottom: ws.map(\.box.maxY).max()!, height: height, chunks: chunks)
        }
    }

    private static func columnBands(_ rows: [Row]) -> [[Double]] {
        let multi = rows.filter { $0.chunks.count >= 2 }
        var counts: [Int: Int] = [:]
        for r in multi { counts[r.chunks.count, default: 0] += 1 }
        guard let mode = counts.sorted(by: { $0.value != $1.value ? $0.value > $1.value : $0.key > $1.key }).first?.key else { return [] }
        let spans = multi.filter { $0.chunks.count == mode }.flatMap { r in r.chunks.map { [$0.x0, $0.x1] } }.stableSorted { $0[0] < $1[0] }
        var bands: [[Double]] = []
        for s in spans {
            if let last = bands.last, s[0] <= last[1] + snap { bands[bands.count - 1][1] = max(last[1], s[1]) } else { bands.append(s) }
        }
        return bands
    }

    private static func bandsOf(_ c: Chunk, _ bands: [[Double]]) -> (Int, Int) {
        let hit = bands.indices.filter { c.x0 < bands[$0][1] - snap && c.x1 > bands[$0][0] + snap }
        if let f = hit.first, let l = hit.last { return (f, l) }
        let mid = (c.x0 + c.x1) / 2
        var best = 0
        for (i, b) in bands.enumerated() where abs((b[0] + b[1]) / 2 - mid) < abs((bands[best][0] + bands[best][1]) / 2 - mid) { best = i }
        return (best, best)
    }

    private static func streamTable(_ all: ArraySlice<Row>) -> [Table] {
        var a = all.startIndex, b = all.endIndex - 1
        while a <= b && all[a].chunks.count < 2 { a += 1 }
        while b >= a && all[b].chunks.count < 2 { b -= 1 }
        guard a <= b else { return [] }
        let rows = Array(all[a...b])
        let bands = columnBands(rows)
        // a one-column row that runs across two columns is prose, not part of the table: split there
        let crossesColumns = { (r: Row) -> Bool in
            guard r.chunks.count == 1 else { return false }
            let (f, l) = bandsOf(r.chunks[0], bands)
            return l > f
        }
        if let cut = rows.firstIndex(where: crossesColumns) {
            return streamTable(rows[0..<cut]) + streamTable(rows[(cut + 1)...])
        }
        let multi = rows.filter { $0.chunks.count >= 2 }
        guard multi.count >= minStreamRows, bands.count >= 2 else { return [] }
        let width = bands[bands.count - 1][1] - bands[0][0]
        if bands.count == 2 && median(multi.flatMap { $0.chunks.map { $0.x1 - $0.x0 } }) > 0.3 * width { return [] }
        var cells: [Cell] = []
        for (ri, r) in rows.enumerated() {
            var byCol: [Int: ([TextWord], Int)] = [:]
            for c in r.chunks {
                let (first, last) = bandsOf(c, bands)
                if let cell = byCol[first] { byCol[first] = (cell.0 + c.words, max(cell.1, last)) } else { byCol[first] = (c.words, last) }
            }
            for col in byCol.keys.sorted() {
                let (ws, last) = byCol[col]!
                cells.append(Cell(row: ri, col: col, colSpan: last - col + 1, text: wordsToText(ws), box: union(ws.map(\.box))))
            }
        }
        let boxes = rows.flatMap { $0.words.map(\.box) } + [Box(x: bands[0][0], y: rows[0].top, w: width, h: 0)]
        return [Table(box: union(boxes), rows: rows.count, cols: bands.count, cells: cells)]
    }

    /// Borderless tables among `words` (one page), top to bottom.
    public static func detect(_ words: [TextWord]) -> [Table] {
        var tables: [Table] = []
        var block: [Row] = []
        for r in textRows(words) {
            if let prev = block.last, r.top - prev.bottom > rowGap * max(prev.height, r.height) {
                tables += streamTable(block[...]); block = []
            }
            block.append(r)
        }
        tables += streamTable(block[...])
        return tables.stableSorted { $0.box.y != $1.box.y ? $0.box.y < $1.box.y : $0.box.x < $1.box.x }
    }
}

extension Array {
    /// Swift's `sorted` is not guaranteed stable; the web, server and Android sorts are.
    func stableSorted(by less: (Element, Element) -> Bool) -> [Element] {
        enumerated().sorted { less($0.element, $1.element) || (!less($1.element, $0.element) && $0.offset < $1.offset) }.map(\.element)
    }
}
