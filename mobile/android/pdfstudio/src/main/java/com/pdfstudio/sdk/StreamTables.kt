package com.pdfstudio.sdk

import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/**
 * Tables without ruling lines, found from words that line up in columns: the "stream" half of the web
 * SDK's table detection (`web/src/sdk/tables.ts`), with the same steps and constants. The device reads no
 * ruling lines, so tables drawn with lines are found only when their text lines up too. Used to read
 * table rows in [ReadingOrder]; `mobile/shared/tables/tables-page.json` (`expectedWithoutLines`) checks it.
 */
object StreamTables {
    const val SNAP = 3.0
    const val ROW_GAP = 1.2
    const val MIN_STREAM_ROWS = 3

    /** A cell of a found table; [text] joins its words like the web SDK. */
    data class Cell(val row: Int, val col: Int, val colSpan: Int, val text: String, val box: Box)
    data class Table(val box: Box, val rows: Int, val cols: Int, val cells: List<Cell>) {
        fun toTableBox() = TableBox(box, cells.map { TableCellBox(it.row, it.col, it.box) })
    }

    private class Chunk(val words: MutableList<TextWord>, val x0: Double, var x1: Double)
    private class Row(val words: List<TextWord>, val top: Double, val bottom: Double, val height: Double, val chunks: List<Chunk>)

    private fun cy(b: Box) = b.y + b.h / 2
    private fun median(v: List<Double>): Double {
        if (v.isEmpty()) return 0.0
        val s = v.sorted()
        return if (s.size % 2 == 1) s[s.size / 2] else (s[s.size / 2 - 1] + s[s.size / 2]) / 2
    }
    private fun r2(v: Double) = Math.round(v * 100) / 100.0
    private fun union(boxes: List<Box>): Box {
        val x = boxes.minOf { it.x }; val y = boxes.minOf { it.y }
        return Box(r2(x), r2(y), r2(boxes.maxOf { it.maxX } - x), r2(boxes.maxOf { it.maxY } - y))
    }

    /** Lines top to bottom, words left to right (the web SDK's `wordsToText`). */
    fun wordsToText(words: List<TextWord>): String {
        val lines = ArrayList<MutableList<TextWord>>()
        for (w in words.sortedWith(compareBy({ cy(it.box) }, { it.box.x }))) {
            val line = lines.lastOrNull()
            if (line != null && abs(cy(w.box) - cy(line[0].box)) <= 0.5 * min(w.box.h, line[0].box.h)) line += w else lines += mutableListOf(w)
        }
        return lines.joinToString("\n") { l -> l.sortedBy { it.box.x }.joinToString(" ") { it.text } }
    }

    private fun textRows(words: List<TextWord>): List<Row> {
        val groups = ArrayList<MutableList<TextWord>>()
        for (w in words.sortedWith(compareBy({ cy(it.box) }, { it.box.x }))) {
            val g = groups.lastOrNull()
            if (g != null && abs(cy(w.box) - cy(g[0].box)) <= 0.5 * min(w.box.h, g[0].box.h)) g += w else groups += mutableListOf(w)
        }
        return groups.map { g ->
            val ws = g.sortedBy { it.box.x }
            val height = median(ws.map { it.box.h }).takeIf { it > 0 } ?: 1.0
            val chunks = ArrayList<Chunk>()
            for (w in ws) {
                val c = chunks.lastOrNull()
                if (c != null && w.box.x - c.x1 <= ReadingOrder.COLUMN_GAP * height) { c.words += w; c.x1 = max(c.x1, w.box.maxX) }
                else chunks += Chunk(mutableListOf(w), w.box.x, w.box.maxX)
            }
            Row(ws, ws.minOf { it.box.y }, ws.maxOf { it.box.maxY }, height, chunks)
        }
    }

    private fun columnBands(rows: List<Row>): List<DoubleArray> {
        val multi = rows.filter { it.chunks.size >= 2 }
        val counts = multi.groupingBy { it.chunks.size }.eachCount()
        val mode = counts.entries.sortedWith(compareBy({ -it.value }, { -it.key })).firstOrNull()?.key ?: return emptyList()
        val spans = multi.filter { it.chunks.size == mode }.flatMap { r -> r.chunks.map { doubleArrayOf(it.x0, it.x1) } }
            .sortedBy { it[0] }
        val bands = ArrayList<DoubleArray>()
        for (s in spans) {
            val last = bands.lastOrNull()
            if (last != null && s[0] <= last[1] + SNAP) last[1] = max(last[1], s[1]) else bands += doubleArrayOf(s[0], s[1])
        }
        return bands
    }

    private fun bandsOf(c: Chunk, bands: List<DoubleArray>): Pair<Int, Int> {
        val hit = bands.indices.filter { c.x0 < bands[it][1] - SNAP && c.x1 > bands[it][0] + SNAP }
        if (hit.isNotEmpty()) return hit.first() to hit.last()
        val mid = (c.x0 + c.x1) / 2
        var best = 0
        bands.forEachIndexed { i, b -> if (abs((b[0] + b[1]) / 2 - mid) < abs((bands[best][0] + bands[best][1]) / 2 - mid)) best = i }
        return best to best
    }

    private fun streamTable(all: List<Row>): List<Table> {
        var a = 0
        var b = all.size - 1
        while (a <= b && all[a].chunks.size < 2) a++
        while (b >= a && all[b].chunks.size < 2) b--
        if (a > b) return emptyList()
        val rows = all.subList(a, b + 1)
        val bands = columnBands(rows)
        val cut = rows.indexOfFirst { it.chunks.size == 1 && bandsOf(it.chunks[0], bands).let { (f, l) -> l > f } }
        if (cut >= 0) return streamTable(rows.subList(0, cut)) + streamTable(rows.subList(cut + 1, rows.size))
        val multi = rows.filter { it.chunks.size >= 2 }
        if (multi.size < MIN_STREAM_ROWS || bands.size < 2) return emptyList()
        val width = bands.last()[1] - bands[0][0]
        if (bands.size == 2 && median(multi.flatMap { r -> r.chunks.map { it.x1 - it.x0 } }) > 0.3 * width) return emptyList()
        val cells = ArrayList<Cell>()
        rows.forEachIndexed { ri, r ->
            val byCol = sortedMapOf<Int, Pair<MutableList<TextWord>, Int>>()
            for (c in r.chunks) {
                val (first, last) = bandsOf(c, bands)
                val cell = byCol[first]
                if (cell != null) { cell.first += c.words; byCol[first] = cell.first to max(cell.second, last) }
                else byCol[first] = c.words.toMutableList() to last
            }
            for ((col, v) in byCol) cells += Cell(ri, col, v.second - col + 1, wordsToText(v.first), union(v.first.map { it.box }))
        }
        val boxes = rows.flatMap { r -> r.words.map { it.box } } + Box(bands[0][0], rows[0].top, width, 0.0)
        return listOf(Table(union(boxes), rows.size, bands.size, cells))
    }

    /** Borderless tables among [words] (one page), top to bottom. */
    fun detect(words: List<TextWord>): List<Table> {
        val tables = ArrayList<Table>()
        var block = ArrayList<Row>()
        for (r in textRows(words)) {
            val prev = block.lastOrNull()
            if (prev != null && r.top - prev.bottom > ROW_GAP * max(prev.height, r.height)) { tables += streamTable(block); block = ArrayList() }
            block += r
        }
        tables += streamTable(block)
        return tables.sortedWith(compareBy({ it.box.y }, { it.box.x }))
    }
}
