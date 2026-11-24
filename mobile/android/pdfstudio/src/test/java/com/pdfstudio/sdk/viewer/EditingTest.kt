package com.pdfstudio.sdk.viewer

import com.pdfstudio.sdk.Annotation
import com.pdfstudio.sdk.AnnotationKind
import com.pdfstudio.sdk.Box
import com.pdfstudio.sdk.Measure
import com.pdfstudio.sdk.Pt
import com.pdfstudio.sdk.ScaleSetting
import com.pdfstudio.sdk.ReviewStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class EditingTest {
    private val drag = listOf(Pt(100.0, 100.0), Pt(140.0, 130.0), Pt(200.0, 160.0))

    @Test fun dragToolsMakeTheirShapes() {
        val rect = Editing.shape(Tool.RECT, 0, drag, "#1f6feb", "A")!!
        assertEquals(AnnotationKind.RECT, rect.kind); assertEquals(Box(100.0, 100.0, 100.0, 60.0), rect.rect); assertEquals("#1f6feb", rect.color)
        assertEquals(AnnotationKind.ELLIPSE, Editing.shape(Tool.ELLIPSE, 0, drag, "#000000", "A")!!.kind)
        val arrow = Editing.shape(Tool.ARROW, 2, drag, "#e5484d", "A")!!
        assertEquals(AnnotationKind.ARROW, arrow.kind); assertEquals(listOf(Pt(100.0, 100.0), Pt(200.0, 160.0)), arrow.points); assertEquals(2, arrow.page)
        assertEquals(AnnotationKind.LINE, Editing.shape(Tool.LINE, 0, drag, "#000000", "A")!!.kind)
        val pen = Editing.shape(Tool.PEN, 0, drag, "#7c3aed", "A")!!
        assertEquals(drag, pen.paths!!.single()); assertEquals("#7c3aed", pen.color)
        assertEquals("#ffd84d", Editing.shape(Tool.HIGHLIGHTER, 0, drag, "#7c3aed", "A")!!.color)
    }

    @Test fun tinyDragsAndTapToolsMakeNothing() {
        val tiny = listOf(Pt(10.0, 10.0), Pt(11.0, 11.0))
        assertNull(Editing.shape(Tool.RECT, 0, tiny, "#000000", "A"))
        assertNull(Editing.shape(Tool.ARROW, 0, tiny, "#000000", "A"))
        assertNull(Editing.shape(Tool.TEXT, 0, drag, "#000000", "A"))
        assertNull(Editing.shape(Tool.PEN, 0, listOf(Pt(1.0, 1.0)), "#000000", "A"))
    }

    @Test fun textBoxFitsItsTextAndStaysOnThePage() {
        val t = Editing.textBox(0, Pt(580.0, 780.0), "Good work\nSee page 2", "#e5484d", "A", 612.0, 792.0)!!
        assertEquals(AnnotationKind.FREETEXT, t.kind); assertEquals("Good work\nSee page 2", t.text)
        val r = t.rect!!
        assertTrue("inside the page: $r", r.x >= 0 && r.maxX <= 612 && r.y >= 0 && r.maxY <= 792)
        assertEquals(2 * 14 * 1.2 + 8, r.h, 1e-9)
        assertNull(Editing.textBox(0, Pt(10.0, 10.0), "   ", "#000000", "A", 612.0, 792.0))
    }

    @Test fun noteIsCentredOnTheTapAndCarriesTheComment() {
        val n = Editing.note(1, Pt(300.0, 400.0), "  Check this  ", "A", 612.0, 792.0)!!
        assertEquals(AnnotationKind.NOTE, n.kind); assertEquals("Check this", n.comment)
        assertEquals(Box(289.0, 389.0, 22.0, 22.0), n.rect)
        assertNull(Editing.note(1, Pt(0.0, 0.0), "", "A", 612.0, 792.0))
    }

    @Test fun tapPicksTheSmallestMarkUnderIt() {
        val big = Annotation(page = 0, kind = AnnotationKind.RECT, color = "#000000", rect = Box(0.0, 0.0, 400.0, 400.0), author = "A")
        val small = Annotation(page = 0, kind = AnnotationKind.NOTE, color = "#ffcd45", rect = Box(100.0, 100.0, 22.0, 22.0), author = "A")
        val other = Annotation(page = 1, kind = AnnotationKind.NOTE, color = "#ffcd45", rect = Box(100.0, 100.0, 22.0, 22.0), author = "A")
        val marks = listOf(small, big, other)
        assertSame(small, Editing.hit(marks, 0, Pt(110.0, 110.0)))
        assertSame(big, Editing.hit(marks, 0, Pt(300.0, 300.0)))
        assertSame(other, Editing.hit(marks, 1, Pt(110.0, 110.0)))
        assertNull(Editing.hit(marks, 0, Pt(500.0, 500.0)))
        // a horizontal line is hittable a few units above and below it
        val line = Annotation(page = 0, kind = AnnotationKind.LINE, color = "#000000", strokeWidth = 2.0, points = listOf(Pt(450.0, 450.0), Pt(550.0, 450.0)), author = "A")
        assertSame(line, Editing.hit(listOf(line), 0, Pt(500.0, 456.0)))
    }

    @Test fun commentAndStatusEditsStampTheModifiedTime() {
        val a = Annotation(page = 0, kind = AnnotationKind.RECT, color = "#000000", rect = Box(0.0, 0.0, 1.0, 1.0), author = "A", createdAt = "2026-01-01T00:00:00.000Z")
        assertSame(a, Editing.annotate(a, "  ", ReviewStatus.NONE))
        val b = Editing.annotate(a, " Fix the total ", ReviewStatus.REJECTED)
        assertNotSame(a, b)
        assertEquals("Fix the total", b.comment); assertEquals(ReviewStatus.REJECTED, b.status)
        assertEquals(a.createdAt, b.createdAt); assertTrue(b.modifiedAt > a.modifiedAt)
        assertNull(Editing.annotate(b, "", ReviewStatus.REJECTED).comment)
    }

    @Test fun historyUndoesInOrderAndForgetsTheOldest() {
        val h = EditHistory<List<Annotation>>(limit = 2)
        assertFalse(h.canUndo); assertNull(h.undo())
        val x = Annotation(page = 0, kind = AnnotationKind.NOTE, color = "#ffcd45", rect = Box(0.0, 0.0, 1.0, 1.0), author = "A")
        h.record(emptyList()); h.record(listOf(x)); h.record(listOf(x, x))
        assertEquals(listOf(x, x), h.undo())
        assertEquals(listOf(x), h.undo())
        assertNull(h.undo())
    }

    private val scale = ScaleSetting().toMeasureScale()

    @Test fun distanceDragMakesAMeasurementWithTheScale() {
        val d = Editing.shape(Tool.DISTANCE, 1, listOf(Pt(0.0, 0.0), Pt(40.0, 0.0), Pt(72.0, 0.0)), "#1f6feb", "User 1", scale)!!
        assertEquals(AnnotationKind.DISTANCE, d.kind); assertEquals(listOf(Pt(0.0, 0.0), Pt(72.0, 0.0)), d.points)
        assertEquals(scale, d.measure); assertEquals(1.0, d.opacity, 0.0); assertEquals("1.00 in", Measure.label(d))
        assertNull(Editing.shape(Tool.DISTANCE, 1, listOf(Pt(0.0, 0.0), Pt(2.0, 0.0)), "#1f6feb", "User 1", scale))
        assertNull(Editing.shape(Tool.DISTANCE, 1, drag, "#1f6feb", "User 1", measure = null))
        assertTrue(Tool.DISTANCE.drag && Tool.DISTANCE.measures && !Tool.DISTANCE.placesPoints)
        assertTrue(!Tool.AREA.drag && Tool.AREA.placesPoints && Tool.PERIMETER.placesPoints)
    }

    @Test fun perimeterAndAreaNeedEnoughPointsAndDropDoubleTaps() {
        val pts = listOf(Pt(0.0, 0.0), Pt(72.0, 0.0), Pt(73.0, 1.0), Pt(72.0, 72.0))
        val area = Editing.polygon(Tool.AREA, 0, pts, "#2f9e44", "User 1", scale)!!
        assertEquals(AnnotationKind.AREA, area.kind); assertEquals(listOf(Pt(0.0, 0.0), Pt(72.0, 0.0), Pt(72.0, 72.0)), area.points)
        assertEquals("0.50 in²", Measure.label(area))
        val per = Editing.polygon(Tool.PERIMETER, 0, pts.take(2), "#2f9e44", "User 1", scale)!!
        assertEquals(AnnotationKind.PERIMETER, per.kind); assertEquals("1.00 in", Measure.label(per))
        assertNull(Editing.polygon(Tool.AREA, 0, pts.take(2), "#2f9e44", "User 1", scale))
        assertNull(Editing.polygon(Tool.PERIMETER, 0, listOf(Pt(5.0, 5.0), Pt(6.0, 6.0)), "#2f9e44", "User 1", scale))
        assertNull(Editing.polygon(Tool.PEN, 0, pts, "#2f9e44", "User 1", scale))
    }

    @Test fun tappingTheFirstPointClosesTheShape() {
        val pts = listOf(Pt(100.0, 100.0), Pt(200.0, 100.0), Pt(200.0, 200.0))
        assertTrue(Editing.closesPolygon(pts, Pt(105.0, 96.0), slop = 8.0))
        assertFalse(Editing.closesPolygon(pts, Pt(120.0, 100.0), slop = 8.0))
        assertFalse(Editing.closesPolygon(pts.take(2), Pt(100.0, 100.0), slop = 8.0))
    }
}
