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
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import kotlin.math.abs

/** Runs the cross-platform fixtures in mobile/shared — the same ones the iOS and web suites use. */
class SharedFixtureTest {
    private val shared = generateSequence(File("").absoluteFile) { it.parentFile }
        .map { File(it, "shared") }.first { File(it, "geometry-vectors.json").exists() }

    private fun text(name: String) = File(shared, name).readText()
    private fun close(a: Double, b: Double, what: String, tol: Double = 0.01) =
        assertTrue("$what: $a != $b", abs(a - b) <= tol)

    @Test fun geometryMatchesPdfJs() {
        val cases = Json.parseToJsonElement(text("geometry-vectors.json")).jsonObject["cases"]!!.jsonArray
        assertEquals(16, cases.size)
        for (c in cases.map { it.jsonObject }) {
            val crop = c["crop"]!!.jsonArray.map { it.jsonPrimitive.double }
            val g = PageGeometry(PdfRect(crop[0], crop[1], crop[2], crop[3]), c["rotation"]!!.jsonPrimitive.int)
            val pdf = c["pdf"]!!.jsonArray.map { it.jsonPrimitive.double }
            val page = c["page"]!!.jsonArray.map { it.jsonPrimitive.double }
            val size = c["pageSize"]!!.jsonArray.map { it.jsonPrimitive.double }
            val what = "rot ${g.rotation} $pdf"
            val p = g.toPage(PdfPoint(pdf[0], pdf[1]))
            close(p.x, page[0], "$what x", 0.001); close(p.y, page[1], "$what y", 0.001)
            val back = g.toPdf(Pt(page[0], page[1]))
            close(back.x, pdf[0], "$what back x", 0.001); close(back.y, pdf[1], "$what back y", 0.001)
            close(g.width, size[0], "$what w", 0.001); close(g.height, size[1], "$what h", 0.001)
        }
    }

    @Test fun jsonSampleRoundTrips() {
        val list = AnnotationJson.decodeFile(text("annotations.sample.json"))
        assertEquals(14, list.size)
        assertEquals(14, list.map { it.kind }.toSet().size)
        assertEquals("Reviewed by User3\nशुल्क जमा", list.first { it.kind == AnnotationKind.FREETEXT }.text)
        assertEquals("3.00 in", Measure.label(list.first { it.kind == AnnotationKind.DISTANCE }))
        assertEquals(list, AnnotationJson.decodeFile(AnnotationJson.encodeFile(list, "x.pdf")))
    }

    @Test fun unknownKindsSkipped() {
        val json = """{"format":"pdf-studio-annotations","annotations":[{"id":"a","page":0,"kind":"hologram","color":"#000000","status":"none","author":"x"},{"id":"b","page":0,"kind":"rect","color":"#000000","rect":{"x":1,"y":2,"w":3,"h":4},"status":"none","author":"x"}]}"""
        assertEquals(listOf("b"), AnnotationJson.decodeFile(json).map { it.id })
    }

    @Test fun apryseXfdfMatchesExpectations() {
        val expected = Json.parseToJsonElement(text("xfdf/expected.json")).jsonObject
        val g = PageGeometry(PdfRect(0.0, 0.0, 612.0, 792.0), 0)
        val geometry: (Int) -> PageGeometry? = { if (it in 0..1) g else null }

        val imp = Xfdf.parse(text("xfdf/apryse-annots.xfdf"), geometry)
        var list = Xfdf.merge(emptyList(), imp)
        val after = expected["afterAnnots"]!!.jsonObject
        assertEquals(after["count"]!!.jsonPrimitive.int, list.size)
        assertEquals(listOf("Jane Doe"), imp.fields["student"])
        after["absent"]!!.jsonArray.forEach { id -> assertNull(list.firstOrNull { it.id == id.jsonPrimitive.content }) }

        for ((id, e) in after["byId"]!!.jsonObject) {
            val a = list.firstOrNull { it.id == id } ?: error("missing $id")
            val o = e.jsonObject
            assertEquals(id, o.s("kind"), a.kind.json)
            o.s("color")?.let { assertEquals("$id color", it, a.color) }
            o.d("strokeWidth")?.let { close(a.strokeWidth, it, "$id width") }
            o.s("author")?.let { assertEquals(it, a.author) }
            o.d("fontSize")?.let { close(a.fontSize ?: 0.0, it, "$id font") }
            o.s("text")?.let { assertEquals(id, it, a.text) }
            o.d("opacity")?.let { close(a.opacity, it, "$id opacity") }
            o.s("comment")?.let { assertEquals(id, it, a.comment) }
            o["rect"]?.jsonArray?.map { it.jsonPrimitive.double }?.let { r ->
                val b = if (a.kind.isTextMarkup) a.rects!!.first() else a.rect!!
                close(b.x, r[0], "$id x"); close(b.y, r[1], "$id y"); close(b.w, r[2], "$id w"); close(b.h, r[3], "$id h")
            }
            o["firstPoint"]?.jsonArray?.map { it.jsonPrimitive.double }?.let { fp ->
                val p = a.paths?.first()?.first() ?: a.points!!.first()
                close(p.x, fp[0], "$id fx"); close(p.y, fp[1], "$id fy")
            }
            o.d("paths")?.let { assertEquals(id, it.toInt(), a.paths?.size) }
            o.d("pointsInFirstPath")?.let { assertEquals(id, it.toInt(), a.paths?.first()?.size) }
        }

        list = Xfdf.merge(list, Xfdf.parse(text("xfdf/apryse-commands.xfdf"), geometry))
        val c = expected["afterCommands"]!!.jsonObject
        assertEquals(c["count"]!!.jsonPrimitive.int, list.size)
        assertNotNull(list.firstOrNull { it.id == c.s("added") })
        assertNull(list.firstOrNull { it.id == c.s("removed") })
        val mod = c["modified"]!!.jsonObject
        val m = list.first { it.id == mod.s("id") }
        assertEquals(mod.s("color"), m.color)
        close(m.strokeWidth, mod.d("strokeWidth")!!, "mod width")
        val r = mod["rect"]!!.jsonArray.map { it.jsonPrimitive.double }
        close(m.rect!!.x, r[0], "mod x"); close(m.rect!!.y, r[1], "mod y")
    }

    @Test fun xfdfExportImportRoundTripOnRotatedPage() {
        val list = AnnotationJson.decodeFile(text("annotations.sample.json"))
        val g = PageGeometry(PdfRect(0.0, 0.0, 612.0, 792.0), 90)
        val xml = Xfdf.export(list, { g }, mapOf("a.b" to listOf("x")))
        val back = Xfdf.parse(xml) { g }
        assertEquals(listOf("x"), back.fields["a.b"])
        assertEquals(14, back.annotations.size)
        val orig = list.associateBy { it.id }
        for (a in back.annotations) {
            val o = orig.getValue(a.id)
            assertEquals(a.id, o.kind, a.kind)
            val (ab, ob) = a.bounds to o.bounds
            close(ab.x, ob.x, "${a.id} x", 0.05); close(ab.y, ob.y, "${a.id} y", 0.05)
            close(ab.w, ob.w, "${a.id} w", 0.05); close(ab.h, ob.h, "${a.id} h", 0.05)
        }
        assertEquals("3.00 in", Measure.label(back.annotations.first { it.kind == AnnotationKind.DISTANCE }))
    }

    @Test fun pdfDates() {
        assertEquals("2026-01-15T05:00:00.000Z", Xfdf.pdfDateToIso("D:20260115103000+05'30'"))
        assertEquals("2026-01-16T09:00:00.000Z", Xfdf.pdfDateToIso("D:20260116090000Z"))
        assertFalse(Xfdf.isoToPdfDate("2026-01-16T09:00:00.000Z").isEmpty())
    }

    private fun JsonObject.s(k: String) = this[k]?.jsonPrimitive?.content
    private fun JsonObject.d(k: String) = this[k]?.jsonPrimitive?.content?.toDoubleOrNull()
}
