package com.pdfstudio.sdk

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.double
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test

class TextLinesTest {
    /** "Hello World" in Helvetica 12 at y=100 and "Second line" in Times 10 at y=120; 10pt-wide glyphs. */
    private fun page(): PageText {
        val text = StringBuilder(); val boxes = ArrayList<Box?>(); val styles = ArrayList<GlyphStyle?>()
        listOf(Triple("Hello World", 100.0, GlyphStyle("Helvetica", 12.0)), Triple("Second line", 120.0, GlyphStyle("Times-Roman", 10.0)))
            .forEachIndexed { line, (s, y, style) ->
                if (line > 0) { text.append('\n'); boxes += null; styles += null }
                s.forEachIndexed { i, c ->
                    text.append(c)
                    boxes += if (c == ' ') null else Box(50.0 + i * 10, y, 10.0, 12.0)
                    styles += if (c == ' ') null else style
                }
            }
        return PageText(0, text.toString(), boxes, styles, 612.0, 792.0)
    }

    @Test fun linesAndWords() {
        val lines = page().lines()
        assertEquals(listOf("Hello World", "Second line"), lines.map { it.text })
        assertEquals(listOf("Hello", "World"), lines[0].words.map { it.text })
        assertEquals(Box(50.0, 100.0, 50.0, 12.0), lines[0].words[0].box)
        assertEquals(Box(110.0, 100.0, 50.0, 12.0), lines[0].words[1].box)
        assertEquals(Box(50.0, 100.0, 110.0, 12.0), lines[0].box)
        assertEquals("Helvetica" to 12.0, lines[0].font to lines[0].size)
        assertEquals("Times-Roman" to 10.0, lines[1].font to lines[1].size)
    }

    @Test fun plainTextMatchesWebAndServer() {
        assertEquals("===== Page 1 =====\nHello World\nSecond line\n", TextExport.plain(listOf(page())))
        assertEquals("Hello World\nSecond line\n", TextExport.plain(listOf(page()), pageMarkers = false))
    }

    @Test fun jsonHasTheWebShape() {
        val root = Json.parseToJsonElement(TextExport.json(listOf(page()), "a.pdf")).jsonObject
        assertEquals("pdf-studio-text", root["format"]!!.jsonPrimitive.content)
        val p = root["pages"]!!.jsonArray[0].jsonObject
        assertEquals(1, p["page"]!!.jsonPrimitive.int)
        assertEquals(612.0, p["width"]!!.jsonPrimitive.double, 0.0)
        val line = p["lines"]!!.jsonArray[0].jsonObject
        assertEquals("Hello World", line["text"]!!.jsonPrimitive.content)
        assertEquals(110.0, line["box"]!!.jsonObject["w"]!!.jsonPrimitive.double, 0.0)
        assertEquals(2, line["words"]!!.jsonArray.size)
    }

    @Test fun emptyPageHasNoLines() {
        assertEquals(emptyList<TextLine>(), PageText(0, "", emptyList()).lines())
    }
}
