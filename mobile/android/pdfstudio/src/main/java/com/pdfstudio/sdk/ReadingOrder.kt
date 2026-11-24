package com.pdfstudio.sdk

import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min

/** What reading order needs of a detected table: its box and its cells' grid positions and boxes. */
data class TableCellBox(val row: Int, val col: Int, val box: Box)
data class TableBox(val box: Box, val cells: List<TableCellBox>)

/**
 * Reading order: a page's lines in the order a person reads them, not the order the file draws them.
 * The same steps and constants as the web SDK (`web/src/sdk/readingOrder.ts`) and the server
 * (`server/app/reading_order.py`); `mobile/shared/reading-order/cases.json` keeps them in step.
 *
 * 1. Lines are split where a gap is wider than [COLUMN_GAP] × the word height (a line drawn across two columns).
 * 2. Empty space across the page taller than [SECTION_GAP] lines ends a section; sections are read top to bottom.
 * 3. Within a section, Breuel's rules: a before b when they overlap horizontally and a is higher, or a is
 *    entirely left of b and nothing between them vertically crosses the gap; then a topological sort.
 * 4. Lines inside a table are read row by row, cells joined by tabs (tables come from the server, or none).
 */
object ReadingOrder {
    const val COLUMN_GAP = 0.9
    const val SECTION_GAP = 1.5
    private val RTL = Regex("[֐-߿יִ-﷿ﹰ-﻿]")

    private fun cy(b: Box) = b.y + b.h / 2
    private fun median(v: List<Double>): Double {
        if (v.isEmpty()) return 0.0
        val s = v.sorted()
        return if (s.size % 2 == 1) s[s.size / 2] else (s[s.size / 2 - 1] + s[s.size / 2]) / 2
    }
    private fun union(boxes: List<Box>): Box {
        val x = boxes.minOf { it.x }; val y = boxes.minOf { it.y }
        fun r(v: Double) = Math.round(v * 100) / 100.0
        return Box(r(x), r(y), r(boxes.maxOf { it.maxX } - x), r(boxes.maxOf { it.maxY } - y))
    }
    private fun inside(p: Box, b: Box): Boolean {
        val x = p.x + p.w / 2; val y = cy(p)
        return x >= b.x && x <= b.maxX && y >= b.y && y <= b.maxY
    }

    /** True when most letters on the page are in a right-to-left script. */
    fun isRtl(lines: List<TextLine>): Boolean {
        val text = lines.joinToString("") { it.text }
        val letters = text.count { it.isLetter() }
        return letters > 0 && RTL.findAll(text).count().toDouble() / letters > 0.5
    }

    /**
     * The line cut where a word starts a new row (it overlaps the row so far by less than half its height;
     * PDFKit and PdfBox can hand back several rows of a column as one line), then within each row at
     * column-wide gaps. Words keep their order in the line.
     */
    fun splitAtGaps(line: TextLine): List<TextLine> {
        val words = line.words
        if (words.size < 2 || line.box.h > line.box.w) return listOf(line)
        val rows = ArrayList<MutableList<Int>>()
        var top = 0.0
        var bottom = 0.0
        words.forEachIndexed { i, w ->
            val overlap = min(bottom, w.box.maxY) - max(top, w.box.y)
            if (rows.isNotEmpty() && overlap >= 0.5 * min(w.box.h, bottom - top)) {
                rows.last() += i
                top = min(top, w.box.y); bottom = max(bottom, w.box.maxY)
            } else {
                rows += mutableListOf(i)
                top = w.box.y; bottom = w.box.maxY
            }
        }
        val piece = IntArray(words.size)
        var n = -1
        for (row in rows) {
            val height = median(row.map { words[it].box.h }).takeIf { it > 0 } ?: 1.0
            var right = Double.NEGATIVE_INFINITY
            for (i in row.sortedBy { words[it].box.x }) {
                if (right == Double.NEGATIVE_INFINITY || words[i].box.x - right > COLUMN_GAP * height) n++
                piece[i] = n
                right = max(right, words[i].box.maxX)
            }
        }
        if (n == 0) return listOf(line)
        return (0..n).map { k ->
            val ws = words.filterIndexed { i, _ -> piece[i] == k }
            line.copy(text = ws.joinToString(" ") { it.text }, box = union(ws.map { it.box }), words = ws)
        }
    }

    private class Unit(val lines: List<TextLine>, val box: Box) {
        val cy = box.y + box.h / 2
        var x0 = 0.0
        var x1 = 0.0
    }

    private fun tableRows(table: TableBox, pieces: List<TextLine>): List<TextLine> {
        fun dist(p: Box, b: Box) = hypot(p.x + p.w / 2 - (b.x + b.w / 2), cy(p) - cy(b))
        val byCell = LinkedHashMap<Int, MutableList<TextLine>>()
        for (p in pieces) {
            var k = table.cells.indexOfFirst { inside(p.box, it.box) }
            if (k < 0) {
                k = 0
                table.cells.forEachIndexed { i, c -> if (dist(p.box, c.box) < dist(p.box, table.cells[k].box)) k = i }
            }
            byCell.getOrPut(k) { ArrayList() } += p
        }
        val rows = HashMap<Int, MutableList<Pair<Int, List<TextLine>>>>()
        for ((k, ls) in byCell) {
            val c = table.cells[k]
            rows.getOrPut(c.row) { ArrayList() } += c.col to ls.sortedWith(compareBy({ cy(it.box) }, { it.box.x }))
        }
        return rows.entries.sortedBy { it.key }.map { (_, cells) ->
            cells.sortBy { it.first }
            val texts = Array(cells.last().first + 1) { "" }
            for ((col, ls) in cells) texts[col] = ls.joinToString(" ") { it.text }
            val ls = cells.flatMap { it.second }
            ls[0].copy(text = texts.joinToString("\t"), box = union(ls.map { it.box }), words = ls.flatMap { it.words })
        }
    }

    /** The page's lines in reading order. Lines inside one of [tables] are read as that table's rows. */
    fun order(lines: List<TextLine>, tables: List<TableBox> = emptyList(), rtl: Boolean = isRtl(lines)): List<TextLine> {
        val pieces = lines.flatMap { splitAtGaps(it) }
        val units = ArrayList<Unit>()
        val inTable = LinkedHashMap<Int, MutableList<TextLine>>()
        for (p in pieces) {
            val t = tables.indexOfFirst { inside(p.box, it.box) }
            if (t >= 0) inTable.getOrPut(t) { ArrayList() } += p else units += Unit(listOf(p), p.box)
        }
        for ((t, ls) in inTable) units += Unit(tableRows(tables[t], ls), tables[t].box)
        if (units.isEmpty()) return emptyList()

        val lineH = median(pieces.map { it.box.h }).takeIf { it > 0 } ?: 1.0
        val sections = ArrayList<MutableList<Unit>>()
        var bottom = Double.NEGATIVE_INFINITY
        for (u in units.sortedBy { it.box.y }) {
            if (sections.isEmpty() || u.box.y - bottom > SECTION_GAP * lineH) sections += ArrayList<Unit>()
            sections.last() += u
            bottom = max(bottom, u.box.maxY)
        }
        return sections.flatMap { orderSection(it, rtl) }
    }

    private fun orderSection(units: List<Unit>, rtl: Boolean): List<TextLine> {
        for (u in units) { // mirrored for right-to-left pages, so "left of" means "read first"
            u.x0 = if (rtl) -u.box.maxX else u.box.x
            u.x1 = if (rtl) -u.box.x else u.box.maxX
        }
        val n = units.size
        val before = List(n) { ArrayList<Int>() }
        for (a in 0 until n) for (b in 0 until n) {
            if (a == b) continue
            val A = units[a]; val B = units[b]
            val overlap = min(A.x1, B.x1) - max(A.x0, B.x0)
            if (overlap > 1) {
                if (A.cy < B.cy) before[b] += a
            } else if (A.x1 <= B.x0 + 1) {
                val lo = min(A.cy, B.cy); val hi = max(A.cy, B.cy)
                val blocked = units.indices.any { c ->
                    c != a && c != b && units[c].cy > lo && units[c].cy < hi && units[c].x0 < A.x1 && units[c].x1 > B.x0
                }
                if (!blocked) before[b] += a
            }
        }
        fun first(cands: List<Int>): Int = cands.reduce { best, i ->
            val y = units[i].cy; val by = units[best].cy
            if (y < by - 0.5 || (abs(y - by) <= 0.5 && units[i].x0 < units[best].x0)) i else best
        }
        val done = BooleanArray(n)
        val order = ArrayList<Int>()
        while (order.size < n) {
            val free = (0 until n).filter { !done[it] && before[it].all { j -> done[j] } }
            val pick = first(free.ifEmpty { (0 until n).filter { !done[it] } })
            done[pick] = true
            order += pick
        }
        return order.flatMap { units[it].lines }
    }
}
