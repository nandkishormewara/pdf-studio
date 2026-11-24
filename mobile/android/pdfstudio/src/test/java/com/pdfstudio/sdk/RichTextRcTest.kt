package com.pdfstudio.sdk

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** PDF `/RC` strings (XHTML) to runs: what the web SDK, Acrobat and Apryse write. */
class RichTextRcTest {
    private val runs = listOf(
        TextRun("Good "), TextRun("work", bold = true), TextRun(", ", italic = false),
        TextRun("see", italic = true, underline = true), TextRun(" page 2\nNext ", color = "#1f6feb"), TextRun("line", bold = true, italic = true),
    )

    @Test fun roundTripsWhatWeWrite() {
        val xhtml = RichText.toXhtml(runs, "#e5484d", 14.0)
        val back = RichText.relativeTo(RichText.fromXhtml(xhtml)!!, "#e5484d")
        // the same styled words on the same lines (a paragraph break comes back as its own unstyled "\n")
        assertEquals(RichText.lines(RichText.normalize(runs)), RichText.lines(back))
        assertEquals(RichText.plainText(runs), RichText.plainText(back))
    }

    @Test fun readsAcrobatStyleWithDeclarationAndBodyStyles() {
        val rc = """<?xml version="1.0"?><body xmlns="http://www.w3.org/1999/xhtml" xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/" """ +
            """xfa:APIVersion="Acrobat:11.0.0" xfa:spec="2.0.2" style="font-size:12.0pt;text-align:left;color:#FF0000;font-weight:normal;font-style:normal;font-family:Helvetica">""" +
            """<p dir="ltr"><span style="font-weight:bold">Due</span>&nbsp;today</p><p>Second <b>line</b> <span style="color:rgb(0, 128, 0)">green</span></p></body>"""
        val r = RichText.relativeTo(RichText.fromXhtml(rc)!!, "#ff0000")
        assertEquals(listOf(
            TextRun("Due", bold = true), TextRun(" today\nSecond "), TextRun("line", bold = true), TextRun(" "), TextRun("green", color = "#008000"),
        ), r)
        assertEquals("Due today\nSecond line green", RichText.plainText(r))
    }

    @Test fun emptyOrBrokenIsNull() {
        assertNull(RichText.fromXhtml(""))
        assertNull(RichText.fromXhtml("<body><p>unclosed"))
        assertNull(RichText.fromXhtml("<body xmlns=\"http://www.w3.org/1999/xhtml\"><p></p></body>"))
    }
}
