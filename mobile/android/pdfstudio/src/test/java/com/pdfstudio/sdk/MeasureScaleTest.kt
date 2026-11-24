package com.pdfstudio.sdk

import org.junit.Assert.assertEquals
import org.junit.Test

/** Scale settings and labels, checked against the web SDK's measure.ts. */
class MeasureScaleTest {
    private fun line(len: Double, m: MeasureScale) =
        Annotation(page = 0, kind = AnnotationKind.DISTANCE, color = "#000000", points = listOf(Pt(0.0, 0.0), Pt(len, 0.0)), measure = m, author = "User 1")

    @Test fun defaultIsOneInchPerInchLikeTheWeb() {
        val s = ScaleSetting()
        assertEquals("1 in = 1 in", s.describe())
        val m = s.toMeasureScale()
        assertEquals(1 / 72.0, m.factor, 1e-12); assertEquals("in", m.unit); assertEquals(2, m.precision)
        assertEquals("1.00 in", Measure.label(line(72.0, m)))
    }

    @Test fun paperAndWorldUnits() {
        // 1 cm on paper = 2.5 m: a line 2 cm long is 5 m
        val m = ScaleSetting(1.0, "cm", 2.5, "m", 1).toMeasureScale()
        assertEquals(2.5 / (72 / 2.54), m.factor, 1e-12)
        assertEquals("5.0 m", Measure.label(line(2 * 72 / 2.54, m)))
        assertEquals("1 cm = 2.5 m", ScaleSetting(1.0, "cm", 2.5, "m", 1).describe())
        // 0.5 in = 10 ft, no decimals
        val ft = ScaleSetting(0.5, "in", 10.0, "ft", 0).toMeasureScale()
        assertEquals("40 ft", Measure.label(line(144.0, ft)))
        // unknown paper units count as inches (web: PAPER_UNITS[x] ?? 72)
        assertEquals(1 / 72.0, ScaleSetting(paperUnit = "furlong").toMeasureScale().factor, 1e-12)
    }

    @Test fun areaAndPerimeterLabels() {
        val m = ScaleSetting(1.0, "in", 1.0, "ft", 2).toMeasureScale()
        val square = listOf(Pt(0.0, 0.0), Pt(144.0, 0.0), Pt(144.0, 144.0), Pt(0.0, 144.0))
        val area = Annotation(page = 0, kind = AnnotationKind.AREA, color = "#000000", points = square, measure = m, author = "User 1")
        assertEquals("4.00 ft²", Measure.label(area))
        val perimeter = area.copy(kind = AnnotationKind.PERIMETER)
        assertEquals("6.00 ft", Measure.label(perimeter)) // an open polyline: three sides
        assertEquals(listOf("in", "ft", "yd", "mi", "mm", "cm", "m", "km", "pt"), Measure.WORLD_UNITS)
        assertEquals(setOf("in", "cm", "mm", "pt"), Measure.PAPER_UNITS.keys)
    }
}
