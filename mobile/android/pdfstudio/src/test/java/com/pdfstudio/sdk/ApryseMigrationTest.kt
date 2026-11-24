package com.pdfstudio.sdk

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs

/**
 * Cases found in real-world XFDF saved by Apryse WebViewer 7.2, the same as
 * packages/react-viewer/test/apryse-migration.test.ts on the web. Each one looked different from WebViewer before.
 */
class ApryseMigrationTest {
    private val page = PageGeometry(PdfRect(0.0, 0.0, 612.0, 792.0), 0)
    private val geometry: (Int) -> PageGeometry? = { if (it in 0..1) page else null }

    private fun xfdf(annots: String) =
        """<?xml version="1.0" encoding="UTF-8"?><xfdf xmlns="http://ns.adobe.com/xfdf/"><fields/><annots>$annots</annots></xfdf>"""
    private fun roundTrip(list: List<Annotation>) = Xfdf.parse(Xfdf.export(list, geometry), geometry).annotations
    private fun close(a: Double, b: Double) = assertTrue("$a != $b", abs(a - b) < 0.02)

    @Test fun unnamedMarkInTheFileIsReplacedByItsUnnamedXfdfCopy() {
        // a name typed with Apple Markup (no /NM) that Apryse exported unnamed into the XFDF
        val name = """<freetext page="0" rect="108.415,681.688,207.415,706.688" TextColor="#FC3141" FontSize="16" title="Mobile User"><contents>Jane Doe</contents></freetext>"""
        val inFile = Xfdf.parse(xfdf(name.replace("108.415,", "108.4149,")), geometry).annotations.map { it.copy(id = "file-${it.text}") }
        val imp = Xfdf.parse(xfdf(name + """<freetext page="0" rect="300,600,310,610" title="T"><contents>2</contents></freetext>"""), geometry)
        val merged = Xfdf.merge(inFile, imp)
        assertEquals(listOf("Jane Doe", "2"), merged.map { it.text })
        assertEquals(imp.annotations[0].id, merged[0].id)
    }

    @Test fun filledBoxesKeepTheirFill() {
        val box = Xfdf.parse(xfdf("""<square page="0" rect="100,500,200,540" color="#E2A1E6" interior-color="#F1A099" opacity="0.354637" width="1.94" name="b1" title="T"/>"""), geometry).annotations.single()
        assertEquals("#f1a099", box.fill)
        assertTrue(Xfdf.export(listOf(box), geometry).contains("""interior-color="#F1A099""""))
        assertEquals("#f1a099", roundTrip(listOf(box)).single().fill)
    }

    @Test fun freeTextColorIsTheBackgroundExceptOnTypewriterText() {
        val style = "<defaultstyle>font: Helvetica 12pt; text-align: left; color: #007A3B</defaultstyle>"
        val (boxed, typed) = Xfdf.parse(xfdf(
            """<freetext page="0" rect="57,466,556,488" color="#FFFFFF" TextColor="#007A3B" name="w1" title="T"><contents>glucose</contents>$style</freetext>""" +
                """<freetext page="0" rect="123,689,168,701" color="#0078D4" TextColor="#0077D4" IT="FreeTextTypewriter" name="t1" title="T"><contents>John Doe</contents>$style</freetext>""",
        ), geometry).annotations
        assertEquals("#007a3b", boxed.color)
        assertEquals("#ffffff", boxed.fill)
        assertNull(typed.fill)
        val out = Xfdf.export(listOf(boxed, typed), geometry)
        assertTrue(out.contains("""color="#FFFFFF""""))
        val typedOut = out.lines().first { "t1" in it }
        assertTrue("typewriter text must not carry color: $typedOut", !Regex("""\scolor="""").containsMatchIn(typedOut))
        assertTrue(typedOut.contains("""IT="FreeTextTypewriter""""))
    }

    @Test fun olderPdfStudioFreeTextStaysUnfilled() {
        val a = Xfdf.parse(xfdf("""<freetext page="0" rect="10,10,90,30" color="#E5484D" name="o1" title="T"><contents>old</contents></freetext>"""), geometry).annotations.single()
        assertNull(a.fill)
    }

    @Test fun rotatedFreeTextKeepsItsRotation() {
        val a = Xfdf.parse(xfdf("""<freetext page="0" rect="172.38,217.84,185.46,234.6" rotation="90" TextColor="#E44234" FontSize="12" width="0" name="r1" title="T"><contents>1</contents></freetext>"""), geometry).annotations.single()
        assertEquals(90, a.rotation)
        assertTrue(Xfdf.export(listOf(a), geometry).contains("""rotation="90""""))
        assertEquals(90, roundTrip(listOf(a)).single().rotation)
    }

    @Test fun calloutsKeepLineArrowAndTextBox() {
        val a = Xfdf.parse(xfdf(
            """<freetext page="1" rect="74.509,406.72,305.18,447.48" fringe="0.5,10.26,80.171,0.5" callout="304.68,408.29,267,407.22,225.01,431.98"
               head="OpenArrow" IT="FreeTextCallout" color="#FFFFFF" name="c1" title="T"><contents>ans: 60 degree</contents>
               <defaultstyle>font: Helvetica 9pt; color: #E44234</defaultstyle></freetext>""",
        ), geometry).annotations.single()
        assertEquals(3, a.callout!!.size)
        close(a.callout!![0].x, 304.68); close(a.callout!![0].y, 792 - 408.29)
        assertEquals("OpenArrow", a.calloutEnd)
        assertEquals("#ffffff", a.fill)
        // the fringe is Apryse's left, bottom, right, top: the leader line then ends half-way down the box, as WebViewer draws it
        listOf(0.5, 0.5, 80.17, 10.26).zip(a.inset!!).forEach { (want, got) -> close(got, want) }
        val r = a.rect!!; val i = a.inset!!
        close(a.callout!![2].y, r.y + i[1] + (r.h - i[1] - i[3]) / 2)
        val out = Xfdf.export(listOf(a), geometry)
        assertTrue(out, out.contains("""callout="304.68,408.29,267,407.22,225.01,431.98""""))
        assertTrue(out, out.contains("""head="OpenArrow""""))
        assertTrue(out, out.contains("""fringe="0.5,10.26,80.17,0.5""""))
        assertTrue(out, out.contains("""IT="FreeTextCallout""""))
    }

    @Test fun groupedMarksAreDrawnAndRepliesJoinTheComment() {
        val list = Xfdf.parse(xfdf(
            """<line page="0" rect="10,10,60,60" start="10,10" end="60,60" name="g1" title="T"/>""" +
                """<line page="0" rect="60,60,90,90" start="60,60" end="90,90" inreplyto="g1" replyType="group" name="g2" title="T"/>""" +
                """<text page="0" rect="10,10,30,30" inreplyto="g1" name="r1" title="Student"><contents>Done</contents></text>""",
        ), geometry).annotations
        assertEquals(listOf("g1", "g2"), list.map { it.id })
        assertEquals("Student: Done", list[0].comment)
    }

    @Test fun cutOffFileKeepsItsCompleteMarks() {
        val cut = xfdf(
            """<ink page="0" rect="0,0,50,50" name="i1" title="T"><inklist><gesture>1,1;20,20</gesture></inklist></ink>""" +
                """<ink page="0" rect="0,0,50,50" name="i2" title="T"><popup open="no" rect="0,0,1,1"></popup><inklist><gesture>2,2;30,30</gesture></inklist></ink>""" +
                """<ink page="0" rect="0,0,50,50" name="i3" title="T"><popup open="no" rect="0,0,1,1"></popup><inklist><gesture>3,3;40,40""",
        ).removeSuffix("</annots></xfdf>")
        val imp = Xfdf.parse(cut, geometry)
        assertTrue(imp.partial)
        assertEquals(listOf("i1", "i2"), imp.annotations.map { it.id })
    }

    @Test fun penTapsAreKeptAsDots() {
        // one-point strokes are common: decimal points, full stops, the dot of an i
        val ink = Xfdf.parse(xfdf(
            """<ink page="0" rect="0,0,50,50" width="3.4" name="d1" title="T"><inklist><gesture>10,10;20,20</gesture><gesture>30,30</gesture></inklist></ink>""" +
                """<ink page="0" rect="0,0,50,50" width="3.4" name="d2" title="T"><inklist><gesture>40,40</gesture></inklist></ink>""",
        ), geometry).annotations
        assertEquals(listOf(2, 1), ink.map { it.paths!!.size })
        assertEquals(listOf(2, 1), roundTrip(ink).map { it.paths!!.size })
    }

    @Test fun newFieldsSurviveTheJsonStoredInPdfs() {
        val a = Annotation(page = 0, kind = AnnotationKind.FREETEXT, color = "#e44234", author = "T", rect = Box(10.0, 10.0, 80.0, 20.0),
            text = "x", fill = "#ffffff", rotation = 270, inset = listOf(1.0, 2.0, 3.0, 4.0), callout = listOf(Pt(1.0, 2.0), Pt(3.0, 4.0)),
            calloutEnd = "OpenArrow", intent = "FreeTextCallout")
        assertEquals(a, AnnotationJson.decode(AnnotationJson.encode(a)))
    }

    // typed comments often have bold, italic or coloured words (Apryse <contents-richtext>)
    @Test fun richTextKeepsBoldItalicAndColouredWords() {
        val rich = """<contents-richtext><body xmlns="http://www.w3.org/1999/xhtml" style="font-size:12pt;color:#000000"><p dir="ltr">""" +
            """<span style="font-weight:bold;color:#000000">Check</span><span style="color:#000000">: look at </span>""" +
            """<span style="font-style:italic;color:#E44234">the long leg</span></p><p dir="ltr"><span style="color:#000000">then the short one</span></p></body></contents-richtext>"""
        val a = Xfdf.parse(xfdf("""<freetext page="0" rect="57,466,356,520" TextColor="#000000" name="r1" title="T"><contents>Check: look at the long leg
then the short one</contents>$rich</freetext>"""), geometry).annotations.single()
        assertEquals("Check: look at the long leg\nthen the short one", a.text)
        assertEquals(listOf(TextRun("Check", bold = true), TextRun(": look at "), TextRun("the long leg", italic = true, color = "#e44234"), TextRun("\nthen the short one")), a.richText)
        assertEquals(a.richText, roundTrip(listOf(a)).single().richText)
        assertEquals(a.richText, AnnotationJson.decode(AnnotationJson.encode(a))!!.richText)
        // plain text written as rich text in one colour stays plain
        val plain = Xfdf.parse(xfdf("""<freetext page="0" rect="57,466,356,520" TextColor="#000000" name="p1" title="T"><contents>ok</contents><contents-richtext><body xmlns="http://www.w3.org/1999/xhtml"><p><span style="color:#000000">ok</span></p></body></contents-richtext></freetext>"""), geometry).annotations.single()
        assertNull(plain.richText)
    }

    // squiggly underlines: drawn as a wave, written back as <squiggly>
    @Test fun squigglyUnderlinesStaySquiggly() {
        val a = Xfdf.parse(xfdf("""<squiggly page="0" rect="100,500,200,512" coords="100,512,200,512,100,500,200,500" color="#E44234" name="s1" title="T"/>"""), geometry).annotations.single()
        assertEquals(AnnotationKind.UNDERLINE, a.kind)
        assertEquals("squiggly", a.subtype)
        assertTrue(Xfdf.export(listOf(a), geometry).contains("<squiggly "))
        assertEquals("squiggly", roundTrip(listOf(a)).single().subtype)
    }

    @Test fun marksWithoutAnAuthorAreFromUnknownAsOnTheWeb() {
        val a = Xfdf.parse(xfdf("""<square page="0" rect="100,500,200,540" color="#E44234" name="u1" title=""/>"""), geometry).annotations.single()
        assertEquals("Unknown", a.author)
    }

    // "my ans-51 kg of sugar sold in total" wraps in its 115 pt box, as WebViewer draws it
    @Test fun typedCommentsWrapBetweenWordsAtTheBoxEdge() {
        val measure = { t: String, _: TextRun -> t.length * 6.0 }
        val lines = RichText.wrap(listOf(TextRun("my ans-"), TextRun("51 kg of sugar sold in total", bold = true)), 120.0, measure)
        assertEquals(listOf("my ans-51 kg of", "sugar sold in total"), lines.map { l -> l.joinToString("") { it.text } })
        assertEquals(listOf(TextRun("my ans-"), TextRun("51 kg of", bold = true)), lines[0])
        assertEquals(1, RichText.wrap(listOf(TextRun("ans: 60 degree")), 200.0, measure).size)
        assertEquals(listOf("one", "two"), RichText.wrap(listOf(TextRun("one\ntwo")), 200.0, measure).map { it.first().text })
        assertEquals(listOf("photosynthesis"), RichText.wrap(listOf(TextRun("photosynthesis")), 30.0, measure).map { it.first().text })
    }
}
