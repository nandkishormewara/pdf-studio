package com.pdfstudio.sdk.viewer

import org.junit.Assert.assertEquals
import org.junit.Test

class DocumentTitleTest {
    @Test fun `cached copies lose their timestamps`() {
        assertEquals("Homework annotated", DocumentTitle.fromFileName("homework_annotated_1730000000000.pdf"))
        assertEquals("Homework document", DocumentTitle.fromFileName("/cache/homework_document_1730000000000_2.pdf"))
    }

    @Test fun `real file names are kept`() {
        assertEquals("Chapter-3 Current Electricity", DocumentTitle.fromFileName("Chapter-3 Current Electricity.pdf"))
    }

    @Test fun `names without an extension stay Document`() {
        assertEquals("Document", DocumentTitle.fromFileName("stream"))
        assertEquals("Document", DocumentTitle.fromFileName(null))
        assertEquals("Document", DocumentTitle.fromFileName("1730000000000.pdf"))
    }
}
