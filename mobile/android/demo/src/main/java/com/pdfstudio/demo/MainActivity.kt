package com.pdfstudio.demo

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.pdfstudio.sdk.PdfStudio
import com.pdfstudio.sdk.viewer.PdfStudioViewer
import com.pdfstudio.sdk.viewer.ViewerConfig
import com.tom_roush.pdfbox.pdmodel.PDDocument
import com.tom_roush.pdfbox.pdmodel.PDPage
import com.tom_roush.pdfbox.pdmodel.PDPageContentStream
import com.tom_roush.pdfbox.pdmodel.common.PDRectangle
import com.tom_roush.pdfbox.pdmodel.font.PDType1Font
import java.io.File

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        PdfStudio.init(this)
        setContent {
            MaterialTheme {
                Surface(Modifier.fillMaxSize()) {
                    Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        Text("PDF Studio", style = MaterialTheme.typography.headlineLarge)
                        Text("Replacements for the PDFTron calls used by a typical app.", style = MaterialTheme.typography.bodyMedium)
                        Button(onClick = ::checkedCopy, modifier = Modifier.fillMaxWidth()) { Text("Reviewer-checked copy (XFDF, read-only)") }
                        Button(onClick = ::mergedFile, modifier = Modifier.fillMaxWidth()) { Text("mergeXfdf → file → viewer") }
                        OutlinedButton(onClick = ::editable, modifier = Modifier.fillMaxWidth()) { Text("Annotate (shapes, arrows, text, notes, comments)") }
                        OutlinedButton(onClick = ::form, modifier = Modifier.fillMaxWidth()) { Text("Fill a form") }
                        OutlinedButton(onClick = ::imagesToPdf, modifier = Modifier.fillMaxWidth()) { Text("Homework photos → PDF") }
                    }
                }
            }
        }
    }

    private fun xfdf() = assets.open("xfdf/apryse-annots.xfdf").bufferedReader().readText()

    private fun samplePdf(): File {
        val f = File(cacheDir, "homework.pdf")
        PDDocument().use { doc ->
            repeat(6) { i ->
                val p = PDPage(PDRectangle(612f, 792f)); doc.addPage(p)
                PDPageContentStream(doc, p).use { cs ->
                    cs.beginText(); cs.setFont(PDType1Font.HELVETICA_BOLD, 22f); cs.newLineAtOffset(56f, 730f)
                    cs.showText("Homework - checked copy - page ${i + 1}"); cs.endText()
                    listOf("1. Introduction", "2. Viewing", "3. Annotating", "4. Sharing").forEachIndexed { n, h ->
                        cs.beginText(); cs.setFont(PDType1Font.HELVETICA_BOLD, 14f); cs.newLineAtOffset(56f, 680f - n * 60); cs.showText(h); cs.endText()
                        cs.beginText(); cs.setFont(PDType1Font.HELVETICA, 11f); cs.newLineAtOffset(56f, 662f - n * 60)
                        cs.showText("Student answer text for section ${n + 1}. Lorem ipsum dolor sit amet."); cs.endText()
                    }
                    cs.addRect(56f, 140f, 500f, 200f); cs.stroke()
                }
            }
            doc.save(f)
        }
        return f
    }

    private fun checkedCopy() = PdfStudioViewer.open(this, Uri.fromFile(samplePdf()),
        ViewerConfig(title = "Checked copy", xfdfLayers = listOf(xfdf()), secure = true))

    private fun mergedFile() {
        val out = File(cacheDir, "merged.pdf")
        PdfStudio.mergeXfdf(samplePdf(), xfdf(), out)
        PdfStudioViewer.open(this, Uri.fromFile(out), ViewerConfig(title = "Merged file"))
    }

    private fun editable() = PdfStudioViewer.open(this, Uri.fromFile(samplePdf()), ViewerConfig(title = "Annotate", readOnly = false))

    private fun form() = PdfStudioViewer.open(this, Uri.fromFile(FormSample.write(File(cacheDir, "form.pdf"))), ViewerConfig(title = "Sample form", readOnly = false))

    private fun imagesToPdf() {
        val photos = listOf(Color.rgb(30, 90, 200), Color.rgb(20, 140, 90)).mapIndexed { i, c ->
            File(cacheDir, "photo$i.jpg").also { f ->
                val bmp = Bitmap.createBitmap(1600, 2200, Bitmap.Config.ARGB_8888)
                Canvas(bmp).apply {
                    drawColor(Color.WHITE)
                    drawText("Handwritten answer page ${i + 1}", 120f, 300f, Paint().apply { color = c; textSize = 90f; isAntiAlias = true })
                    drawRect(120f, 400f, 1480f, 2000f, Paint().apply { color = c; style = Paint.Style.STROKE; strokeWidth = 12f })
                }
                f.outputStream().use { bmp.compress(Bitmap.CompressFormat.JPEG, 92, it) }
            }
        }
        val pdf = PdfStudio.imagesToPdf(photos, File(cacheDir, "submission.pdf"))
        PdfStudioViewer.open(this, Uri.fromFile(pdf), ViewerConfig(title = "Submission preview"))
    }
}
