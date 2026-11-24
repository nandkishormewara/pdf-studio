package com.pdfstudio.sdk

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.double
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** mobile/shared/reading-order/cases.json: the same cases the web, server and iOS tests run. */
class ReadingOrderTest {
    private val cases = generateSequence(File("").absoluteFile) { it.parentFile }
        .map { File(it, "shared/reading-order/cases.json") }.first { it.exists() }
        .let { Json.parseToJsonElement(it.readText()).jsonObject["cases"]!!.jsonArray.map { c -> c.jsonObject } }

    private fun box(o: JsonObject) = Box(o["x"]!!.jsonPrimitive.double, o["y"]!!.jsonPrimitive.double, o["w"]!!.jsonPrimitive.double, o["h"]!!.jsonPrimitive.double)
    private fun lines(c: JsonObject) = c["lines"]!!.jsonArray.map { it.jsonObject }.map { l ->
        TextLine(l["text"]!!.jsonPrimitive.content, box(l["box"]!!.jsonObject), "", 0.0,
            l["words"]!!.jsonArray.map { it.jsonObject }.map { w -> TextWord(w["text"]!!.jsonPrimitive.content, box(w["box"]!!.jsonObject)) })
    }
    private fun tables(c: JsonObject) = c["tables"]!!.jsonArray.map { it.jsonObject }.map { t ->
        TableBox(box(t["box"]!!.jsonObject), t["cells"]!!.jsonArray.map { it.jsonObject }.map { cell ->
            TableCellBox(cell["row"]!!.jsonPrimitive.int, cell["col"]!!.jsonPrimitive.int, box(cell["box"]!!.jsonObject))
        })
    }
    private fun case(name: String) = cases.first { it["name"]!!.jsonPrimitive.content == name }

    @Test fun sharedCases() {
        assertEquals(4, cases.size)
        for (c in cases) {
            val expected = c["expected"]!!.jsonArray.map { it.jsonPrimitive.content }
            assertEquals(c["name"]!!.jsonPrimitive.content, expected, ReadingOrder.order(lines(c), tables(c)).map { it.text })
        }
    }

    @Test fun deviceTableDetectionGivesTheSameOrder() {
        // what the SDK's own export does: borderless tables found on the device, no ruling lines
        for (name in listOf("newsletter", "merged-rows")) {
            val c = case(name)
            val ls = lines(c)
            val found = StreamTables.detect(ls.flatMap { it.words }).map { it.toTableBox() }
            assertEquals(name, c["expected"]!!.jsonArray.map { it.jsonPrimitive.content }, ReadingOrder.order(ls, found).map { it.text })
        }
    }

    @Test fun borderlessTablesMatchTheServer() {
        val page = generateSequence(File("").absoluteFile) { it.parentFile }
            .map { File(it, "shared/tables/tables-page.json") }.first { it.exists() }
            .let { Json.parseToJsonElement(it.readText()).jsonObject }
        val words = page["words"]!!.jsonArray.map { it.jsonObject }.map { TextWord(it["text"]!!.jsonPrimitive.content, box(it["box"]!!.jsonObject)) }
        val expected = page["expectedWithoutLines"]!!.jsonArray.map { it.jsonObject }
        val found = StreamTables.detect(words)
        assertEquals(expected.size, found.size)
        for ((e, t) in expected.zip(found)) {
            assertEquals(e["rows"]!!.jsonPrimitive.int to e["cols"]!!.jsonPrimitive.int, t.rows to t.cols)
            assertEquals(e["cells"]!!.jsonArray.map { it.jsonObject }.map { c ->
                listOf(c["row"]!!.jsonPrimitive.int, c["col"]!!.jsonPrimitive.int, c["colSpan"]!!.jsonPrimitive.int).joinToString() + " " + c["text"]!!.jsonPrimitive.content
            }, t.cells.map { listOf(it.row, it.col, it.colSpan).joinToString() + " " + it.text })
        }
    }

    @Test fun rightToLeft() {
        assertTrue(ReadingOrder.isRtl(lines(case("rtl-two-columns"))))
        assertFalse(ReadingOrder.isRtl(lines(case("newsletter"))))
        assertEquals(emptyList<TextLine>(), ReadingOrder.order(emptyList()))
    }
}
