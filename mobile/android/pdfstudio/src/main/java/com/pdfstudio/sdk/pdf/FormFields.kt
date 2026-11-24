package com.pdfstudio.sdk.pdf

import com.pdfstudio.sdk.FormField
import com.pdfstudio.sdk.FormFieldKind
import com.tom_roush.pdfbox.io.MemoryUsageSetting
import com.tom_roush.pdfbox.pdmodel.PDDocument
import com.tom_roush.pdfbox.cos.COSDictionary
import com.tom_roush.pdfbox.pdmodel.interactive.form.PDCheckBox
import com.tom_roush.pdfbox.pdmodel.interactive.form.PDChoice
import com.tom_roush.pdfbox.pdmodel.interactive.form.PDComboBox
import com.tom_roush.pdfbox.pdmodel.interactive.form.PDField
import com.tom_roush.pdfbox.pdmodel.interactive.form.PDRadioButton
import com.tom_roush.pdfbox.pdmodel.interactive.form.PDSignatureField
import com.tom_roush.pdfbox.pdmodel.interactive.form.PDTextField
import java.io.File
import java.io.FileOutputStream

/** AcroForm fields: read them, fill them, keep the file's own widgets (PdfBox). Mirrors the web SDK's forms. */
internal object FormFields {

    fun read(file: File): List<FormField> =
        PDDocument.load(file, MemoryUsageSetting.setupTempFileOnly()).use { doc -> read(doc) }

    fun read(doc: PDDocument): List<FormField> {
        val form = doc.documentCatalog.acroForm ?: return emptyList()
        val pageOf: Map<COSDictionary, Int> = doc.pages.withIndex().flatMap { (i, p) -> p.annotations.map { it.cosObject to i } }.toMap()
        return form.fieldTree.mapNotNull { f -> describe(f, pageOf) }
    }

    /**
     * Writes a copy of [source] with [values] (field name → value) filled in. Checkboxes take "true"/"false" (or their
     * on-value), radio groups and choices take an option's export value. Unknown names and read-only fields are skipped.
     * Returns how many fields changed. With [flatten], the filled fields become page content.
     */
    fun fill(source: File, values: Map<String, String>, output: File, flatten: Boolean = false): Int =
        PDDocument.load(source, MemoryUsageSetting.setupTempFileOnly()).use { doc ->
            val form = doc.documentCatalog.acroForm ?: return@use 0.also { FileOutputStream(output).use { doc.save(it) } }
            var changed = 0
            for ((name, value) in values) {
                val f = form.getField(name) ?: continue
                if (f.isReadOnly) continue
                if (set(f, value)) changed++
            }
            // Viewers that can't draw a field (e.g. text in a font the form lacks) regenerate it from the value.
            runCatching { form.refreshAppearances() }
            form.needAppearances = true
            if (flatten) runCatching { form.needAppearances = false; form.flatten() }
            FileOutputStream(output).use { doc.save(it) }
            changed
        }

    private fun describe(f: PDField, pageOf: Map<COSDictionary, Int>): FormField? {
        val page = f.widgets.firstNotNullOfOrNull { pageOf[it.cosObject] } ?: 0
        val common = { kind: FormFieldKind, value: String, options: List<String>, labels: List<String> ->
            FormField(
                name = f.fullyQualifiedName, kind = kind, value = value, options = options, optionLabels = labels,
                readOnly = f.isReadOnly, required = f.isRequired, page = page,
                multiline = (f as? PDTextField)?.isMultiline == true, maxLength = (f as? PDTextField)?.maxLen?.takeIf { it > 0 },
            )
        }
        return when (f) {
            is PDTextField -> common(FormFieldKind.TEXT, f.value.orEmpty(), emptyList(), emptyList())
            is PDCheckBox -> common(FormFieldKind.CHECKBOX, if (f.isChecked) "true" else "false", emptyList(), emptyList())
            is PDRadioButton -> {
                val opts = f.onValues.toList().sorted()
                common(FormFieldKind.RADIO, f.value.takeIf { it != "Off" }.orEmpty(), opts, opts)
            }
            is PDChoice -> {
                val exports = f.optionsExportValues.ifEmpty { f.options }
                val labels = f.optionsDisplayValues.ifEmpty { exports }
                common(if (f is PDComboBox) FormFieldKind.DROPDOWN else FormFieldKind.LIST, f.value.firstOrNull().orEmpty(), exports, labels)
            }
            is PDSignatureField -> null // signing is a server feature
            else -> null
        }
    }

    private fun set(f: PDField, value: String): Boolean {
        val before = f.valueAsString
        when (f) {
            is PDTextField -> f.setValue(value)
            is PDCheckBox -> if (value.equals("true", true) || value == f.onValue) f.check() else f.unCheck()
            is PDRadioButton -> f.setValue(value.ifEmpty { "Off" }.takeIf { it == "Off" || it in f.onValues } ?: return false)
            is PDChoice -> {
                val exports = f.optionsExportValues.ifEmpty { f.options }
                if (value.isNotEmpty() && value !in exports && !(f is PDComboBox && f.isEdit)) return false
                if (value.isEmpty()) f.setValue(emptyList<String>()) else f.setValue(value)
            }
            else -> return false
        }
        return f.valueAsString != before
    }
}
