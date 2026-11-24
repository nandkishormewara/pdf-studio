package com.pdfstudio.sdk

import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min

/**
 * The text of one page with a box per character, in page units (top-left origin, rotation applied).
 * Separators inserted by the extractor (word gaps, line breaks) have a `null` box.
 */
class PageText(
    val page: Int,
    val text: String,
    val boxes: List<Box?>,
    /** Font per character (same length as [text]) when the extractor knows it; empty otherwise. */
    val styles: List<GlyphStyle?> = emptyList(),
    /** Page size in page units (as displayed), when known. */
    val width: Double = 0.0,
    val height: Double = 0.0,
) {
    init {
        require(text.length == boxes.size) { "one box per character" }
        require(styles.isEmpty() || styles.size == text.length) { "one style per character" }
    }

    /** One rect per visual line covering characters `start until end`. */
    fun lineRects(start: Int, end: Int): List<Box> {
        val lines = ArrayList<Box>()
        var line: Box? = null
        var prev: Box? = null
        for (i in max(0, start) until min(end, text.length)) {
            val b = boxes[i]
            if (text[i] == '\n') { line?.let(lines::add); line = null; prev = null; continue }
            if (b == null) continue
            // Glyphs on one line share a band across the reading direction; a new line shares neither band.
            if (line != null && prev != null && !overlaps(prev.y, prev.maxY, b.y, b.maxY) && !overlaps(prev.x, prev.maxX, b.x, b.maxX)) {
                lines += line; line = null
            }
            line = line?.let { Box.union(listOf(it, b)) } ?: b
            prev = b
        }
        line?.let(lines::add)
        return lines
    }

    /** Index of the character nearest to [p] (inside its box, or the closest box), or -1 on an empty page. */
    fun charAt(p: Pt): Int {
        var best = -1; var bestD = Double.MAX_VALUE
        boxes.forEachIndexed { i, b ->
            if (b == null) return@forEachIndexed
            val dx = max(0.0, max(b.x - p.x, p.x - b.maxX)); val dy = max(0.0, max(b.y - p.y, p.y - b.maxY))
            val d = hypot(dx, dy)
            if (d < bestD) { bestD = d; best = i }
        }
        return best
    }

    private fun overlaps(a0: Double, a1: Double, b0: Double, b1: Double): Boolean {
        val o = min(a1, b1) - max(a0, b0)
        return o > 0.3 * min(a1 - a0, b1 - b0)
    }
}

/** Font of a character: name as in the file without the subset prefix, size in points. */
data class GlyphStyle(val font: String, val size: Double)

/** A search match: characters `start until end` of [page], drawn as one rect per line. */
data class SearchHit(val page: Int, val start: Int, val end: Int, val rects: List<Box>)

object TextSearch {
    /** Case-insensitive, whitespace-tolerant search across all pages, in reading order. */
    fun find(pages: List<PageText>, query: String, limit: Int = 5000): List<SearchHit> {
        val q = normalize(query.trim())
        if (q.isEmpty()) return emptyList()
        val hits = ArrayList<SearchHit>()
        for (p in pages) {
            val hay = normalize(p.text)
            var from = 0
            while (hits.size < limit) {
                val i = hay.indexOf(q, from)
                if (i < 0) break
                val rects = p.lineRects(i, i + q.length)
                if (rects.isNotEmpty()) hits += SearchHit(p.page, i, i + q.length, rects)
                from = i + 1
            }
        }
        return hits
    }

    /** Length-preserving: lower-cases and maps every whitespace (incl. line breaks) to a space. */
    private fun normalize(s: String) = String(CharArray(s.length) { i -> s[i].let { if (it.isWhitespace()) ' ' else it.lowercaseChar() } })
}
