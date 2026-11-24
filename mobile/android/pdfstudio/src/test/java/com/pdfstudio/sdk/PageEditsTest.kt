package com.pdfstudio.sdk

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class PageEditsTest {
    private val letter = PageGeometry(PdfRect(0.0, 0.0, 612.0, 792.0), 0)
    private fun pages(n: Int, g: PageGeometry = letter) = List(n) { g }
    private fun mark(page: Int, kind: AnnotationKind = AnnotationKind.RECT, rect: Box? = Box(100.0, 50.0, 40.0, 20.0)) =
        Annotation(id = "m$page-${kind.json}", page = page, kind = kind, color = "#e5484d", rect = rect, author = "User 1")

    private fun near(a: Pt, b: Pt, what: String) =
        assertTrue("$what: $a != $b", kotlin.math.abs(a.x - b.x) < 1e-9 && kotlin.math.abs(a.y - b.y) < 1e-9)

    @Test fun rotationFollowsThePdfPointsUnderTheMark() {
        // A mark must stay over the same spot of the page's content: compare against PageGeometry before and after.
        for (start in listOf(0, 90, 180, 270)) for (cw in listOf(true, false)) {
            val g = PageGeometry(PdfRect(10.0, 20.0, 622.0, 812.0), start)
            val pdf = listOf(PdfPoint(110.0, 700.0), PdfPoint(300.0, 21.0), PdfPoint(621.0, 400.0))
            val ink = Annotation(page = 0, kind = AnnotationKind.INK, color = "#000000", paths = listOf(pdf.map(g::toPage)), author = "User 1")
            val r = PageEdits.apply(listOf(g), listOf(ink), listOf(PageOp.Rotate(0, cw)))
            val after = r.geometries.single()
            assertEquals((start + if (cw) 90 else 270) % 360, after.rotation)
            r.annotations.single().paths!!.single().zip(pdf).forEach { (p, q) -> near(p, after.toPage(q), "start $start cw $cw") }
        }
    }

    @Test fun shapesTurnWithThePageAndFourTurnsComeBack() {
        val marks = listOf(
            mark(0),
            Annotation(page = 0, kind = AnnotationKind.HIGHLIGHT, color = "#ffd84d", rects = listOf(Box(72.0, 100.0, 200.0, 14.0)), author = "User 1"),
            Annotation(page = 0, kind = AnnotationKind.DISTANCE, color = "#000000", points = listOf(Pt(10.0, 10.0), Pt(110.0, 10.0)),
                measure = MeasureScale(1 / 72.0, "in", 2), author = "User 1"),
        )
        val once = PageEdits.apply(pages(1), marks, listOf(PageOp.Rotate(0))).annotations
        // a 40 × 20 box becomes 20 × 40: at x = 792 - 70, y = 100 on the 792 × 612 page
        assertEquals(Box(722.0, 100.0, 20.0, 40.0), once[0].rect)
        assertEquals(Box(678.0, 72.0, 14.0, 200.0), once[1].rects!!.single())
        assertEquals(Measure.label(marks[2]), Measure.label(once[2])) // lengths don't change
        val four = PageEdits.apply(pages(1), marks, List(4) { PageOp.Rotate(0) })
        assertEquals(0, four.geometries.single().rotation); assertEquals(0, four.pages.single().turns)
        assertEquals(marks[0].rect, four.annotations[0].rect)
        assertEquals(marks[1].rects, four.annotations[1].rects)
        four.annotations[2].points!!.zip(marks[2].points!!).forEach { (a, b) -> near(a, b, "distance") }
        // clockwise then counter-clockwise is no turn at all
        val back = PageEdits.apply(pages(1), marks, listOf(PageOp.Rotate(0), PageOp.Rotate(0, clockwise = false)))
        assertEquals(marks[0].rect, back.annotations[0].rect)
    }

    @Test fun textNotesAndStampsStayUprightAndReadable() {
        val text = mark(0, AnnotationKind.FREETEXT, Box(100.0, 50.0, 120.0, 30.0)).copy(text = "Good work", fontSize = 14.0)
        val note = mark(0, AnnotationKind.NOTE, Box(300.0, 300.0, 22.0, 22.0))
        val r = PageEdits.apply(pages(1), listOf(text, note), listOf(PageOp.Rotate(0))).annotations
        // same size, centre (160, 65) turned to (792 - 65, 160)
        assertEquals(Box(727.0 - 60, 160.0 - 15, 120.0, 30.0), r[0].rect)
        assertEquals(null, r[0].rotation)
        assertEquals(Box(792.0 - 311 - 11, 311.0 - 11, 22.0, 22.0), r[1].rect)
    }

    @Test fun calloutTipTurnsWithThePageAndItsLineStillMeetsTheBox() {
        // text box at the top right, leader from its left edge down-left to a tip
        val box = Box(300.0, 100.0, 120.0, 40.0)
        val tip = Pt(150.0, 300.0); val knee = Pt(200.0, 200.0); val end = Pt(300.0, 120.0)
        val outer = Box.union(listOf(box, Box.bounding(listOf(tip, knee, end))!!))!!
        val callout = Annotation(page = 0, kind = AnnotationKind.FREETEXT, color = "#e5484d", rect = outer, text = "See here",
            inset = listOf(box.x - outer.x, box.y - outer.y, outer.maxX - box.maxX, outer.maxY - box.maxY),
            callout = listOf(tip, knee, end), author = "User 1")
        assertEquals(box, callout.textBox)
        val r = PageEdits.apply(pages(1), listOf(callout), listOf(PageOp.Rotate(0))).annotations.single()
        val newBox = r.textBox!!
        assertEquals(120.0, newBox.w, 1e-9); assertEquals(40.0, newBox.h, 1e-9)
        near(r.callout!![0], PageEdits.rotatePoint(tip, 612.0, 792.0, true), "tip")
        near(r.callout!![1], PageEdits.rotatePoint(knee, 612.0, 792.0, true), "knee")
        val e = r.callout!![2]
        val onOutline = (e.x == newBox.x || e.x == newBox.maxX) && e.y in newBox.y..newBox.maxY ||
            (e.y == newBox.y || e.y == newBox.maxY) && e.x in newBox.x..newBox.maxX
        assertTrue("end $e on $newBox", onOutline)
        r.inset!!.forEach { assertTrue("inset $it", it >= -1e-9) }
        r.callout!!.forEach { assertTrue("$it inside ${r.rect}", r.rect!!.inset(-1e-9).contains(it)) }
    }

    @Test fun deleteDropsTheMarksOnThePageAndRenumbersLaterPages() {
        val marks = listOf(mark(0), mark(1), mark(2), mark(3))
        val r = PageEdits.apply(pages(4), marks, listOf(PageOp.Delete(1)))
        assertEquals(listOf(0, 2, 3), r.pages.map { it.source })
        assertEquals(listOf("m0-rect" to 0, "m2-rect" to 1, "m3-rect" to 2), r.annotations.map { it.id to it.page })
        assertThrows(IllegalArgumentException::class.java) { PageEdits.apply(pages(1), emptyList(), listOf(PageOp.Delete(0))) }
        assertThrows(IllegalArgumentException::class.java) { PageEdits.apply(pages(2), emptyList(), listOf(PageOp.Delete(2))) }
    }

    @Test fun moveRenumbersLikeTheWeb() {
        val marks = listOf(mark(0), mark(1), mark(2), mark(3))
        val r = PageEdits.apply(pages(4), marks, listOf(PageOp.Move(3, 0)))
        assertEquals(listOf(3, 0, 1, 2), r.pages.map { it.source })
        assertEquals(listOf(1, 2, 3, 0), r.annotations.map { it.page })
        val down = PageEdits.apply(pages(4), marks, listOf(PageOp.Move(0, 2)))
        assertEquals(listOf(1, 2, 0, 3), down.pages.map { it.source })
        assertEquals(listOf(2, 0, 1, 3), down.annotations.map { it.page })
        assertEquals(marks, PageEdits.apply(pages(4), marks, listOf(PageOp.Move(2, 2))).annotations)
    }

    @Test fun operationsApplyInOrderToTheDocumentAsItStands() {
        val wide = PageGeometry(PdfRect(0.0, 0.0, 842.0, 595.0), 0)
        val r = PageEdits.apply(listOf(letter, wide, letter), listOf(mark(1)), listOf(PageOp.Delete(0), PageOp.Rotate(0), PageOp.Move(0, 1)))
        assertEquals(listOf(2, 1), r.pages.map { it.source })
        assertEquals(listOf(0, 1), r.pages.map { it.turns })
        assertEquals(595.0, r.geometries[1].width, 1e-9); assertEquals(842.0, r.geometries[1].height, 1e-9)
        assertEquals(1, r.annotations.single().page)
        // marks on pages the document doesn't have are dropped
        assertTrue(PageEdits.apply(pages(1), listOf(mark(5)), emptyList()).annotations.isEmpty())
    }
}
