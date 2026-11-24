package com.pdfstudio.sdk

import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/**
 * One change to a document's pages. Page numbers are 0-based and refer to the document as it stands when the
 * operation runs: in `listOf(Delete(0), Rotate(0))` the rotation turns the page that was second.
 */
sealed class PageOp {
    /** Turns a page a quarter turn, clockwise as displayed (or counter-clockwise). */
    data class Rotate(val page: Int, val clockwise: Boolean = true) : PageOp()

    /** Removes a page and the marks on it. A document keeps at least one page. */
    data class Delete(val page: Int) : PageOp()

    /** Moves page [from] so that it ends up at index [to] (Move(3, 0) makes the fourth page the first). */
    data class Move(val from: Int, val to: Int) : PageOp()
}

/**
 * Page operations on the model: which source page ends up where, how far it is turned, its new geometry, and the
 * annotations carried along (pure Kotlin; the PDF side is `PdfStudio.editPages`). Same rules as the web SDK
 * (web/src/sdk/pages.ts): deleting a page drops its marks and renumbers later pages; a move renumbers; a rotation
 * turns each mark's geometry with the page, while text boxes, notes, stamps and signatures keep their size and stay
 * upright (so they stay readable) with their centre turned with the page.
 */
object PageEdits {
    /** One page of the result: [source] is its index in the original document, [turns] the quarter turns added clockwise (0–3). */
    data class Page(val source: Int, val turns: Int, val geometry: PageGeometry)

    data class Result(val pages: List<Page>, val annotations: List<Annotation>) {
        val geometries get() = pages.map { it.geometry }
    }

    /**
     * Applies [ops] in order to a document whose pages have [geometries], moving [annotations] along.
     * @throws IllegalArgumentException for a page number out of range, or deleting the last page.
     */
    fun apply(geometries: List<PageGeometry>, annotations: List<Annotation>, ops: List<PageOp>): Result {
        var pages = geometries.mapIndexed { i, g -> Page(i, 0, g) }
        var marks = annotations.filter { it.page in pages.indices }
        for (op in ops) {
            when (op) {
                is PageOp.Rotate -> {
                    require(op.page in pages.indices) { "No page ${op.page + 1}" }
                    val p = pages[op.page]
                    val g = p.geometry
                    marks = marks.map { if (it.page == op.page) rotate(it, g.width, g.height, op.clockwise) else it }
                    pages = pages.toMutableList().also {
                        it[op.page] = Page(p.source, (p.turns + if (op.clockwise) 1 else 3) % 4,
                            PageGeometry(g.crop, g.rotation + if (op.clockwise) 90 else 270))
                    }
                }
                is PageOp.Delete -> {
                    require(op.page in pages.indices) { "No page ${op.page + 1}" }
                    require(pages.size > 1) { "A document needs at least one page." }
                    pages = pages.toMutableList().also { it.removeAt(op.page) }
                    marks = marks.filter { it.page != op.page }.map { if (it.page > op.page) it.copy(page = it.page - 1) else it }
                }
                is PageOp.Move -> {
                    require(op.from in pages.indices && op.to in pages.indices) { "No page ${maxOf(op.from, op.to) + 1}" }
                    if (op.from == op.to) continue
                    val order = pages.indices.toMutableList()
                    order.add(op.to, order.removeAt(op.from))
                    val newIndexOf = IntArray(order.size).also { m -> order.forEachIndexed { newIdx, oldIdx -> m[oldIdx] = newIdx } }
                    pages = order.map { pages[it] }
                    marks = marks.map { it.copy(page = newIndexOf[it.page]) }
                }
            }
        }
        return Result(pages, marks)
    }

    /** A point on a page [width] × [height] (as displayed) after the page turns a quarter turn. */
    fun rotatePoint(p: Pt, width: Double, height: Double, clockwise: Boolean): Pt =
        if (clockwise) Pt(height - p.y, p.x) else Pt(p.y, width - p.x)

    fun rotateBox(b: Box, width: Double, height: Double, clockwise: Boolean): Box =
        Box.spanning(rotatePoint(Pt(b.x, b.y), width, height, clockwise), rotatePoint(Pt(b.maxX, b.maxY), width, height, clockwise))

    /** [b] with its centre turned with the page and its size kept (content that must stay upright). */
    private fun turnCentre(b: Box, width: Double, height: Double, clockwise: Boolean): Box {
        val c = rotatePoint(Pt(b.x + b.w / 2, b.y + b.h / 2), width, height, clockwise)
        return Box(c.x - b.w / 2, c.y - b.h / 2, b.w, b.h)
    }

    /** One mark after its page (as displayed [width] × [height]) turns a quarter turn. */
    fun rotate(a: Annotation, width: Double, height: Double, clockwise: Boolean): Annotation {
        fun pt(p: Pt) = rotatePoint(p, width, height, clockwise)
        val turned = a.copy(
            rects = a.rects?.map { rotateBox(it, width, height, clockwise) },
            points = a.points?.map(::pt),
            paths = a.paths?.map { p -> p.map(::pt) },
        )
        val r = a.rect ?: return turned.copy(callout = a.callout?.map(::pt))
        return when (a.kind) {
            // Shapes turn with the page (a box drawn around a word stays around it).
            AnnotationKind.RECT, AnnotationKind.ELLIPSE, AnnotationKind.REDACT, AnnotationKind.HIGHLIGHT,
            AnnotationKind.UNDERLINE, AnnotationKind.STRIKEOUT -> turned.copy(rect = rotateBox(r, width, height, clockwise))
            AnnotationKind.FREETEXT -> {
                val callout = a.callout?.takeIf { it.size >= 2 }
                if (callout == null) return turned.copy(rect = turnCentre(r, width, height, clockwise), callout = a.callout?.map(::pt))
                // The text box stays upright; the leader's tip and knee turn with the page and its end meets the box again.
                val box = turnCentre(a.textBox ?: r, width, height, clockwise)
                val line = callout.map(::pt).toMutableList()
                line[line.size - 1] = onEdge(box, line.last())
                val outer = Box.union(listOf(box, Box.bounding(line)!!))!!
                turned.copy(rect = outer, callout = line,
                    inset = listOf(box.x - outer.x, box.y - outer.y, outer.maxX - box.maxX, outer.maxY - box.maxY))
            }
            // Notes, stamps and signatures stay upright, with the same size.
            else -> turned.copy(rect = turnCentre(r, width, height, clockwise), callout = a.callout?.map(::pt))
        }
    }

    /** The point on the outline of [b] nearest to [p]. */
    internal fun onEdge(b: Box, p: Pt): Pt {
        val x = min(max(p.x, b.x), b.maxX); val y = min(max(p.y, b.y), b.maxY)
        if (x != p.x || y != p.y) return Pt(x, y) // outside: the clamp is on the edge
        val d = listOf(abs(p.x - b.x), abs(b.maxX - p.x), abs(p.y - b.y), abs(b.maxY - p.y))
        return when (d.indexOf(d.min())) { 0 -> Pt(b.x, p.y); 1 -> Pt(b.maxX, p.y); 2 -> Pt(p.x, b.y); else -> Pt(p.x, b.maxY) }
    }
}
