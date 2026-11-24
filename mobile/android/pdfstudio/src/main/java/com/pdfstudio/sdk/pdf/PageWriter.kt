package com.pdfstudio.sdk.pdf

import com.pdfstudio.sdk.PageEdits
import com.tom_roush.pdfbox.cos.COSArray
import com.tom_roush.pdfbox.cos.COSName
import com.tom_roush.pdfbox.pdmodel.PDDocument

/** Puts a document's pages in the order and orientation of a [PageEdits.Result] (PdfBox side of page edits). */
internal object PageWriter {
    /** Writes a copy of [source] with its pages as [pages] say; annotations in the file stay on their pages. */
    fun write(source: java.io.File, output: java.io.File, pages: List<PageEdits.Page>) {
        PDDocument.load(source, com.tom_roush.pdfbox.io.MemoryUsageSetting.setupTempFileOnly()).use { doc ->
            apply(doc, pages)
            output.parentFile?.mkdirs()
            java.io.FileOutputStream(output).use { doc.save(it) }
        }
    }

    fun apply(doc: PDDocument, pages: List<PageEdits.Page>) {
        val original = (0 until doc.numberOfPages).map { doc.getPage(it) }
        val unchanged = pages.size == original.size && pages.withIndex().all { (i, p) -> p.source == i && p.turns == 0 }
        if (unchanged) return
        // Values a page inherits from its parent node would be lost when it moves to the root: copy them onto the page.
        for (p in original) {
            p.mediaBox = p.mediaBox
            p.cropBox = p.cropBox
            p.resources = p.resources
            p.rotation = p.rotation
        }
        // The same page objects are put back (not copies), so form fields and links that point at them stay linked.
        // Rebuilt as one flat list under the root (intermediate page nodes would be left empty otherwise).
        val tree = doc.pages
        tree.cosObject.setItem(COSName.KIDS, COSArray())
        tree.cosObject.setInt(COSName.COUNT, 0)
        for (p in pages) {
            val page = original[p.source]
            page.rotation = ((page.rotation + 90 * p.turns) % 360 + 360) % 360
            tree.add(page)
        }
    }
}
