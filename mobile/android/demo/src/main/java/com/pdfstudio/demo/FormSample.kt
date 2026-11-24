package com.pdfstudio.demo

import com.tom_roush.pdfbox.cos.COSDictionary
import com.tom_roush.pdfbox.cos.COSName
import com.tom_roush.pdfbox.pdmodel.PDDocument
import com.tom_roush.pdfbox.pdmodel.PDPage
import com.tom_roush.pdfbox.pdmodel.PDPageContentStream
import com.tom_roush.pdfbox.pdmodel.PDResources
import com.tom_roush.pdfbox.pdmodel.common.PDRectangle
import com.tom_roush.pdfbox.pdmodel.font.PDType1Font
import com.tom_roush.pdfbox.pdmodel.interactive.annotation.PDAnnotationWidget
import com.tom_roush.pdfbox.pdmodel.interactive.annotation.PDAppearanceDictionary
import com.tom_roush.pdfbox.pdmodel.interactive.annotation.PDAppearanceStream
import com.tom_roush.pdfbox.pdmodel.interactive.form.PDAcroForm
import com.tom_roush.pdfbox.pdmodel.interactive.form.PDCheckBox
import com.tom_roush.pdfbox.pdmodel.interactive.form.PDComboBox
import com.tom_roush.pdfbox.pdmodel.interactive.form.PDRadioButton
import com.tom_roush.pdfbox.pdmodel.interactive.form.PDTextField
import java.io.File

/**
 * A one-page form like the web app's sample: name (text), course (dropdown), mode (radio: Online / Classroom) and
 * agree (checkbox). Checkbox and radio widgets carry on/off appearances, as Acrobat-made forms do.
 */
object FormSample {
    val NAME_RECT = PDRectangle(180f, 672f, 300f, 22f)

    fun write(file: File): File {
        PDDocument().use { doc ->
            val page = PDPage(PDRectangle(612f, 792f)); doc.addPage(page)
            val form = PDAcroForm(doc); doc.documentCatalog.acroForm = form
            form.defaultResources = PDResources().apply { put(COSName.getPDFName("Helv"), PDType1Font.HELVETICA) }
            form.defaultAppearance = "/Helv 12 Tf 0 g"

            PDPageContentStream(doc, page).use { cs ->
                cs.beginText(); cs.setFont(PDType1Font.HELVETICA_BOLD, 22f); cs.newLineAtOffset(56f, 730f); cs.showText("Sample form"); cs.endText()
                for ((label, y) in listOf("Full name" to 680f, "Course" to 640f, "Mode" to 600f, "I agree to the terms" to 560f)) {
                    cs.beginText(); cs.setFont(PDType1Font.HELVETICA, 12f); cs.newLineAtOffset(56f, y); cs.showText(label); cs.endText()
                }
            }
            val widgets = mutableListOf<PDAnnotationWidget>()
            fun place(w: PDAnnotationWidget, r: PDRectangle) { w.rectangle = r; w.page = page; w.isPrinted = true; widgets += w }

            val name = PDTextField(form).apply { partialName = "name"; defaultAppearance = "/Helv 12 Tf 0 g" }
            place(name.widgets[0], NAME_RECT)
            val course = PDComboBox(form).apply { partialName = "course"; defaultAppearance = "/Helv 12 Tf 0 g"; setOptions(listOf("Science", "Commerce", "Arts")) }
            place(course.widgets[0], PDRectangle(180f, 632f, 160f, 22f))

            val mode = PDRadioButton(form).apply { partialName = "mode" }
            val radios = listOf("Online" to 180f, "Classroom" to 280f).map { (value, x) ->
                PDAnnotationWidget().also { w -> place(w, PDRectangle(x, 596f, 14f, 14f)); onOff(doc, w, value); w.cosObject.setItem(COSName.PARENT, mode.cosObject) }
            }
            mode.widgets = radios

            val agree = PDCheckBox(form).apply { partialName = "agree" }
            place(agree.widgets[0], PDRectangle(180f, 556f, 14f, 14f)); onOff(doc, agree.widgets[0], "Yes")

            form.fields.addAll(listOf(name, course, mode, agree))
            page.annotations = widgets.toMutableList<com.tom_roush.pdfbox.pdmodel.interactive.annotation.PDAnnotation>()
            runCatching { form.refreshAppearances() }
            doc.save(file)
        }
        return file
    }

    /** A box, filled black in the [on] state and empty when Off. */
    private fun onOff(doc: PDDocument, w: PDAnnotationWidget, on: String) {
        val normal = COSDictionary()
        for (state in listOf(on, "Off")) {
            val s = PDAppearanceStream(doc).apply { bBox = PDRectangle(w.rectangle.width, w.rectangle.height); resources = PDResources() }
            PDPageContentStream(doc, s).use { cs ->
                cs.addRect(0.5f, 0.5f, w.rectangle.width - 1, w.rectangle.height - 1); cs.stroke()
                if (state != "Off") { cs.addRect(3f, 3f, w.rectangle.width - 6, w.rectangle.height - 6); cs.fill() }
            }
            normal.setItem(COSName.getPDFName(state), s)
        }
        w.appearance = PDAppearanceDictionary().apply { cosObject.setItem(COSName.N, normal) }
        w.setAppearanceState("Off")
    }
}
