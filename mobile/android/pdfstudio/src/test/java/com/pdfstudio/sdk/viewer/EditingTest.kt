package com.pdfstudio.sdk.viewer

import com.pdfstudio.sdk.Annotation
import com.pdfstudio.sdk.AnnotationKind
import com.pdfstudio.sdk.Box
import com.pdfstudio.sdk.Pt
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
        val h = EditHistory(limit = 2)
        assertFalse(h.canUndo); assertNull(h.undo())
        val x = Annotation(page = 0, kind = AnnotationKind.NOTE, color = "#ffcd45", rect = Box(0.0, 0.0, 1.0, 1.0), author = "A")
        h.record(emptyList()); h.record(listOf(x)); h.record(listOf(x, x))
        assertEquals(listOf(x, x), h.undo())
        assertEquals(listOf(x), h.undo())
        assertNull(h.undo())
    }
}
