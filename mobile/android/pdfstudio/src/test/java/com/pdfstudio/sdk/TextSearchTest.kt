package com.pdfstudio.sdk

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TextSearchTest {
    /** Two lines of 10pt-wide glyphs: "Hello World" at y=100, "hello again" at y=120. */
    private fun page(n: Int = 0): PageText {
        val text = StringBuilder(); val boxes = ArrayList<Box?>()
        listOf("Hello World" to 100.0, "hello again" to 120.0).forEachIndexed { line, (s, y) ->
            if (line > 0) { text.append('\n'); boxes += null }
            s.forEachIndexed { i, c -> text.append(c); boxes += if (c == ' ') null else Box(50.0 + i * 10, y, 10.0, 12.0) }
        }
        return PageText(n, text.toString(), boxes)
    }

    @Test fun caseInsensitiveAcrossPages() {
        val hits = TextSearch.find(listOf(page(0), page(1)), "HELLO")
        assertEquals(4, hits.size)
        assertEquals(listOf(0, 0, 1, 1), hits.map { it.page })
        assertEquals(Box(50.0, 100.0, 50.0, 12.0), hits[0].rects.single())
        assertEquals(Box(50.0, 120.0, 50.0, 12.0), hits[1].rects.single())
    }

    @Test fun matchSpanningALineBreakGivesOneRectPerLine() {
        val hits = TextSearch.find(listOf(page()), "world hello")
        assertEquals(1, hits.size)
        assertEquals(listOf(Box(110.0, 100.0, 50.0, 12.0), Box(50.0, 120.0, 50.0, 12.0)), hits[0].rects)
    }

    @Test fun blankQueryFindsNothing() = assertTrue(TextSearch.find(listOf(page()), "  ").isEmpty())

    @Test fun verticalLinesOnARotatedPageStayTogether() {
        // A 90°-rotated page shows a horizontal line of text running downwards.
        val boxes = (0 until 5).map { Box(400.0, 72.0 + it * 8, 12.0, 8.0) }
        val p = PageText(0, "abcde", boxes)
        assertEquals(listOf(Box(400.0, 72.0, 12.0, 40.0)), p.lineRects(0, 5))
        assertEquals(2, p.charAt(Pt(405.0, 90.0)))
    }

    @Test fun charAtPicksNearestGlyph() {
        val p = page()
        assertEquals(0, p.charAt(Pt(0.0, 0.0)))
        assertEquals("a", p.text[p.charAt(Pt(115.0, 126.0))].toString())
    }
}
