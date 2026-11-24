package com.pdfstudio.sdk

import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** A word with its box in page units. */
data class TextWord(val text: String, val box: Box)

/** A line of text with its words; [font] and [size] are those of its first character when known. */
data class TextLine(val text: String, val box: Box, val font: String, val size: Double, val words: List<TextWord>)

/**
 * The page's text as lines and words. Lines end at the extractor's line breaks; words at its word
 * separators and at spaces in the text.
 */
fun PageText.lines(): List<TextLine> {
    val out = ArrayList<TextLine>()
    var start = 0
    while (start <= text.length) {
        var end = text.indexOf('\n', start)
        if (end < 0) end = text.length
        val words = ArrayList<TextWord>()
        val word = StringBuilder()
        var wordBoxes = ArrayList<Box>()
        fun endWord() {
            if (word.isNotEmpty()) Box.union(wordBoxes)?.let { words += TextWord(word.toString(), it) }
            word.setLength(0); wordBoxes = ArrayList()
        }
        for (i in start until end) {
            val c = text[i]
            val b = boxes[i]
            if (c.isWhitespace() || b == null) { endWord(); continue }
            word.append(c); wordBoxes += b
        }
        endWord()
        val lineText = text.substring(start, end).trim()
        if (lineText.isNotEmpty() && words.isNotEmpty()) {
            val first = (start until end).firstOrNull { styles.getOrNull(it) != null }?.let { styles[it] }
            out += TextLine(lineText, Box.union(words.map { it.box })!!, first?.font ?: "", first?.size ?: 0.0, words)
        }
        start = end + 1
    }
    return out
}

private fun Box.json() = buildJsonObject {
    put("x", round2(x)); put("y", round2(y)); put("w", round2(w)); put("h", round2(h))
}

private fun round2(v: Double) = Math.round(v * 100) / 100.0

object TextExport {
    /**
     * Lines in reading order (columns one after another, [ReadingOrder]) when [readingOrder] is true, as the
     * web SDK and the server do by default; otherwise in the order the file draws them.
     */
    private fun PageText.ordered(readingOrder: Boolean): List<TextLine> {
        val lines = lines()
        if (!readingOrder) return lines
        return ReadingOrder.order(lines, StreamTables.detect(lines.flatMap { it.words }).map { it.toTableBox() })
    }

    /** Plain text, pages separated by "===== Page n =====" headings like the web SDK and the server. */
    fun plain(pages: List<PageText>, pageMarkers: Boolean = true, readingOrder: Boolean = true): String =
        pages.joinToString("\n\n") { p ->
            (if (pageMarkers) "===== Page ${p.page + 1} =====\n" else "") + p.ordered(readingOrder).joinToString("\n") { it.text }
        } + "\n"

    /** The web SDK's `pdf-studio-text` JSON (version 1): pages → lines → words, boxes in page units. */
    fun json(pages: List<PageText>, fileName: String, readingOrder: Boolean = true): String = buildJsonObject {
        put("format", "pdf-studio-text")
        put("version", 1)
        put("file", fileName)
        put("units", "PDF points; origin top-left of the page as displayed; box = {x, y, w, h}")
        put("pages", buildJsonArray {
            for (p in pages) add(buildJsonObject {
                put("page", p.page + 1)
                put("width", round2(p.width))
                put("height", round2(p.height))
                put("lines", buildJsonArray {
                    for (l in p.ordered(readingOrder)) add(buildJsonObject {
                        put("text", l.text)
                        put("box", l.box.json())
                        put("font", l.font)
                        put("size", l.size)
                        put("words", buildJsonArray { for (w in l.words) add(buildJsonObject { put("text", w.text); put("box", w.box.json()) }) })
                    })
                })
            })
        })
    }.toString()
}
