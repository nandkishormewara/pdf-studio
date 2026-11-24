import PDFKit
import XCTest
@testable import PDFStudioKit

/// Cases found in real-world XFDF saved by Apryse WebViewer 7.2, the same as
/// packages/react-viewer/test/apryse-migration.test.ts and ApryseMigrationTest.kt. Each looked different before.
@MainActor
final class ApryseMigrationTests: XCTestCase {
    private let page = PageGeometry(crop: CGRect(x: 0, y: 0, width: 612, height: 792), rotation: 0)
    private func geometry(_ i: Int) -> PageGeometry? { i < 2 ? page : nil }
    private func xfdf(_ annots: String) -> String {
        ##"<?xml version="1.0" encoding="UTF-8"?><xfdf xmlns="http://ns.adobe.com/xfdf/"><fields/><annots>"## + annots + "</annots></xfdf>"
    }
    private func parse(_ annots: String) throws -> [Annotation] { try XFDF.parse(xfdf(annots), geometry: geometry).annotations }
    private func roundTrip(_ list: [Annotation]) throws -> [Annotation] {
        try XFDF.parse(XFDF.export(list, geometry: geometry), geometry: geometry).annotations
    }

    func testUnnamedMarkInTheFileMatchesItsUnnamedXFDFCopy() throws {
        // a name typed with Apple Markup (no /NM) that Apryse exported unnamed into the XFDF
        let name = ##"<freetext page="0" rect="108.415,681.688,207.415,706.688" TextColor="#FC3141" FontSize="16" title="Mobile User"><contents>Jane Doe</contents></freetext>"##
        let inFile = try parse(name.replacingOccurrences(of: "108.415,", with: "108.4149,"))[0]
        let marks = try parse(name + #"<freetext page="0" rect="108.415,681.688,207.415,706.688" title="T"><contents>2</contents></freetext>"#)
        XCTAssertTrue(XFDF.sameMark(inFile, marks[0]))
        XCTAssertFalse(XFDF.sameMark(inFile, marks[1])) // different text: a different mark
    }

    func testFilledBoxesKeepTheirFill() throws {
        let box = try XCTUnwrap(parse(##"<square page="0" rect="100,500,200,540" color="#E2A1E6" interior-color="#F1A099" opacity="0.354637" width="1.94" name="b1" title="T"/>"##).first)
        XCTAssertEqual(box.fill, "#f1a099")
        XCTAssertTrue(XFDF.export([box], geometry: geometry).contains(##"interior-color="#F1A099""##))
        XCTAssertEqual(try roundTrip([box]).first?.fill, "#f1a099")
    }

    func testFreeTextColorIsTheBackgroundExceptOnTypewriterText() throws {
        let style = "<defaultstyle>font: Helvetica 12pt; text-align: left; color: #007A3B</defaultstyle>"
        let list = try parse(
            ##"<freetext page="0" rect="57,466,556,488" color="#FFFFFF" TextColor="#007A3B" name="w1" title="T"><contents>glucose</contents>"## + style + "</freetext>" +
            ##"<freetext page="0" rect="123,689,168,701" color="#0078D4" TextColor="#0077D4" IT="FreeTextTypewriter" name="t1" title="T"><contents>John Doe</contents>"## + style + "</freetext>")
        XCTAssertEqual(list[0].color, "#007a3b")
        XCTAssertEqual(list[0].fill, "#ffffff")
        XCTAssertNil(list[1].fill)
        let out = XFDF.export(list, geometry: geometry)
        let typed = try XCTUnwrap(out.split(separator: "\n").first { $0.contains(##"name="t1""##) })
        XCTAssertFalse(typed.contains(##" color=""##), String(typed))
        XCTAssertTrue(typed.contains(##"IT="FreeTextTypewriter""##))
        XCTAssertTrue(out.contains(##"color="#FFFFFF""##))
    }

    func testOlderPdfStudioFreeTextStaysUnfilled() throws {
        let a = try XCTUnwrap(parse(##"<freetext page="0" rect="10,10,90,30" color="#E5484D" name="o1" title="T"><contents>old</contents></freetext>"##).first)
        XCTAssertNil(a.fill)
    }

    func testRotatedFreeTextKeepsItsRotation() throws {
        let a = try XCTUnwrap(parse(##"<freetext page="0" rect="172.38,217.84,185.46,234.6" rotation="90" TextColor="#E44234" FontSize="12" width="0" name="r1" title="T"><contents>1</contents></freetext>"##).first)
        XCTAssertEqual(a.rotation, 90)
        XCTAssertTrue(XFDF.export([a], geometry: geometry).contains(##"rotation="90""##))
        XCTAssertEqual(try roundTrip([a]).first?.rotation, 90)
    }

    func testCalloutsKeepLineArrowAndTextBox() throws {
        let a = try XCTUnwrap(parse(##"<freetext page="1" rect="74.509,406.72,305.18,447.48" fringe="0.5,10.26,80.171,0.5" callout="304.68,408.29,267,407.22,225.01,431.98" head="OpenArrow" IT="FreeTextCallout" color="#FFFFFF" name="c1" title="T"><contents>ans: 60 degree</contents><defaultstyle>font: Helvetica 9pt; color: #E44234</defaultstyle></freetext>"##).first)
        XCTAssertEqual(a.callout?.count, 3)
        XCTAssertEqual(a.callout?[0].x ?? 0, 304.68, accuracy: 0.02)
        XCTAssertEqual(a.callout?[0].y ?? 0, 792 - 408.29, accuracy: 0.02)
        XCTAssertEqual(a.calloutEnd, "OpenArrow")
        XCTAssertEqual(a.fill, "#ffffff")
        // the fringe is Apryse's left, bottom, right, top: the leader line then ends half-way down the box, as WebViewer draws it
        for (want, got) in zip([0.5, 0.5, 80.17, 10.26], a.inset ?? []) { XCTAssertEqual(got, want, accuracy: 0.02) }
        let r = try XCTUnwrap(a.rect), i = try XCTUnwrap(a.inset)
        XCTAssertEqual(try XCTUnwrap(a.callout?.last).y, r.y + i[1] + (r.h - i[1] - i[3]) / 2, accuracy: 0.05)
        let out = XFDF.export([a], geometry: geometry)
        XCTAssertTrue(out.contains(##"callout="304.68,408.29,267,407.22,225.01,431.98""##), out)
        XCTAssertTrue(out.contains(##"head="OpenArrow""##))
        XCTAssertTrue(out.contains(##"fringe="0.5,10.26,80.17,0.5""##), out)
        XCTAssertTrue(out.contains(##"IT="FreeTextCallout""##))
    }

    func testGroupedMarksAreDrawnAndRepliesJoinTheComment() throws {
        let list = try parse(
            ##"<line page="0" rect="10,10,60,60" start="10,10" end="60,60" name="g1" title="T"/>"## +
            ##"<line page="0" rect="60,60,90,90" start="60,60" end="90,90" inreplyto="g1" replyType="group" name="g2" title="T"/>"## +
            ##"<text page="0" rect="10,10,30,30" inreplyto="g1" name="r1" title="Student"><contents>Done</contents></text>"##)
        XCTAssertEqual(list.map(\.id), ["g1", "g2"])
        XCTAssertEqual(list[0].comment, "Student: Done")
    }

    func testPenTapsAreKeptAsDots() throws {
        let list = try parse(
            ##"<ink page="0" rect="0,0,50,50" width="3.4" name="d1" title="T"><inklist><gesture>10,10;20,20</gesture><gesture>30,30</gesture></inklist></ink>"## +
            ##"<ink page="0" rect="0,0,50,50" width="3.4" name="d2" title="T"><inklist><gesture>40,40</gesture></inklist></ink>"##)
        XCTAssertEqual(list.map { $0.paths?.count ?? 0 }, [2, 1])
        XCTAssertEqual(try roundTrip(list).map { $0.paths?.count ?? 0 }, [2, 1])
        // drawn by PDF Studio (PDFKit has no dot for a one-point stroke)
        XCTAssertTrue(AnnotationBridge.makePDFAnnotation(list[1], geometry: page) is StudioDrawnAnnotation)
    }

    func testCutOffFileKeepsItsCompleteMarks() throws {
        var cut = xfdf(
            ##"<ink page="0" rect="0,0,50,50" name="i1" title="T"><inklist><gesture>1,1;20,20</gesture></inklist></ink>"## +
            ##"<ink page="0" rect="0,0,50,50" name="i2" title="T"><popup open="no" rect="0,0,1,1"></popup><inklist><gesture>2,2;30,30</gesture></inklist></ink>"## +
            ##"<ink page="0" rect="0,0,50,50" name="i3" title="T"><popup open="no" rect="0,0,1,1"></popup><inklist><gesture>3,3;40,40"##)
        cut.removeLast("</annots></xfdf>".count)
        let imp = try XFDF.parse(cut, geometry: geometry)
        XCTAssertTrue(imp.partial)
        XCTAssertEqual(imp.annotations.map(\.id), ["i1", "i2"])
    }

    func testNewFieldsSurviveTheJsonStoredInPdfs() throws {
        let a = Annotation(page: 0, kind: .freetext, color: "#e44234", rect: Box(x: 10, y: 10, w: 80, h: 20), text: "x",
                           fill: "#ffffff", rotation: 270, inset: [1, 2, 3, 4], callout: [Pt(x: 1, y: 2), Pt(x: 3, y: 4)],
                           calloutEnd: "OpenArrow", intent: "FreeTextCallout", author: "T")
        XCTAssertEqual(try JSONDecoder().decode(Annotation.self, from: JSONEncoder().encode(a)), a)
    }

    /// Bulk check before go-live, skipped unless XFDF_DIR is set:
    /// XFDF_DIR=<folder of downloaded annotations/**.xfdf> swift test --filter testAllXfdfFiles
    func testAllXfdfFiles() throws {
        guard let dir = ProcessInfo.processInfo.environment["XFDF_DIR"] else { throw XCTSkip("XFDF_DIR not set") }
        let big = PageGeometry(crop: CGRect(x: 0, y: 0, width: 595, height: 842), rotation: 0)
        var files = 0, errors = 0, partial = 0, marks = 0, resaved = 0, strokes = 0, fill = 0, textFill = 0, rotation = 0, callout = 0
        let e = FileManager.default.enumerator(atPath: dir)!
        while let rel = e.nextObject() as? String {
            guard rel.hasSuffix(".xfdf") else { continue }
            files += 1
            let xml = try String(contentsOfFile: dir + "/" + rel, encoding: .utf8)
            guard let imp = try? XFDF.parse(xml, geometry: { $0 < 400 ? big : nil }) else { errors += 1; continue }
            if imp.partial { partial += 1 }
            let a = imp.annotations
            marks += a.count
            strokes += a.filter { $0.kind == .ink }.reduce(0) { $0 + ($1.paths?.count ?? 0) }
            fill += a.filter { $0.fill != nil && $0.kind != .freetext }.count
            textFill += a.filter { $0.fill != nil && $0.kind == .freetext }.count
            rotation += a.filter { $0.rotation != nil }.count
            callout += a.filter { $0.callout != nil }.count
            resaved += (try? XFDF.parse(XFDF.export(a, geometry: { $0 < 400 ? big : nil }), geometry: { $0 < 400 ? big : nil }).annotations.count) ?? -1_000_000
        }
        print("IOS-BULK files=\(files) errors=\(errors) partial=\(partial) marks=\(marks) resaved=\(resaved) strokes=\(strokes) fill=\(fill) textFill=\(textFill) rotation=\(rotation) callout=\(callout)")
    }

    // typed comments often have bold, italic or coloured words (Apryse <contents-richtext>)
    func testRichTextKeepsBoldItalicAndColouredWords() throws {
        let rich = ##"<contents-richtext><body xmlns="http://www.w3.org/1999/xhtml" style="font-size:12pt;color:#000000"><p dir="ltr">"## +
            ##"<span style="font-weight:bold;color:#000000">Check</span><span style="color:#000000">: look at </span>"## +
            ##"<span style="font-style:italic;color:#E44234">the long leg</span></p><p dir="ltr"><span style="color:#000000">then the short one</span></p></body></contents-richtext>"##
        let a = try XCTUnwrap(parse(##"<freetext page="0" rect="57,466,356,520" TextColor="#000000" name="r1" title="T"><contents>Check: look at the long leg"## +
            "\nthen the short one</contents>" + rich + "</freetext>").first)
        XCTAssertEqual(a.text, "Check: look at the long leg\nthen the short one")
        let expected = [TextRun(text: "Check", bold: true), TextRun(text: ": look at "), TextRun(text: "the long leg", italic: true, color: "#e44234"),
                        TextRun(text: "\nthen the short one")]
        XCTAssertEqual(a.richText, expected)
        XCTAssertEqual(try roundTrip([a]).first?.richText, expected)
        let json = try JSONDecoder().decode(Annotation.self, from: JSONEncoder().encode(a))
        XCTAssertEqual(json.richText, expected)
        XCTAssertFalse(String(decoding: try JSONEncoder().encode(expected[1]), as: UTF8.self).contains("bold"), "false flags are left out, as on the web")
        let plain = try XCTUnwrap(parse(##"<freetext page="0" rect="57,466,356,520" TextColor="#000000" name="p1" title="T"><contents>ok</contents><contents-richtext><body xmlns="http://www.w3.org/1999/xhtml"><p><span style="color:#000000">ok</span></p></body></contents-richtext></freetext>"##).first)
        XCTAssertNil(plain.richText)
        // drawn by PDF Studio, not PDFKit's one-font free text
        XCTAssertTrue(AnnotationBridge.makePDFAnnotation(a, geometry: page) is StudioDrawnAnnotation)
    }

    // squiggly underlines: drawn as a wave, written back as <squiggly>
    func testSquigglyUnderlinesStaySquiggly() throws {
        let a = try XCTUnwrap(parse(##"<squiggly page="0" rect="100,500,200,512" coords="100,512,200,512,100,500,200,500" color="#E44234" name="s1" title="T"/>"##).first)
        XCTAssertEqual(a.kind, .underline)
        XCTAssertEqual(a.subtype, "squiggly")
        XCTAssertTrue(XFDF.export([a], geometry: geometry).contains("<squiggly "))
        XCTAssertEqual(try roundTrip([a]).first?.subtype, "squiggly")
        XCTAssertTrue(AnnotationBridge.makePDFAnnotation(a, geometry: page) is StudioDrawnAnnotation)
    }

    func testMarksWithoutAnAuthorAreFromUnknownAsOnTheWeb() throws {
        XCTAssertEqual(try parse(##"<square page="0" rect="100,500,200,540" color="#E44234" name="u1" title=""/>"##).first?.author, "Unknown")
    }

    // "my ans-51 kg of sugar sold in total" wraps in its 115 pt box, as WebViewer draws it
    func testTypedCommentsWrapBetweenWordsAtTheBoxEdge() {
        let measure: (String, TextRun) -> Double = { t, _ in Double(t.count) * 6 }
        let lines = RichText.wrap([TextRun(text: "my ans-"), TextRun(text: "51 kg of sugar sold in total", bold: true)], maxWidth: 120, measure: measure)
        XCTAssertEqual(lines.map { $0.map(\.text).joined() }, ["my ans-51 kg of", "sugar sold in total"])
        XCTAssertEqual(lines[0], [TextRun(text: "my ans-"), TextRun(text: "51 kg of", bold: true)])
        XCTAssertEqual(RichText.wrap([TextRun(text: "ans: 60 degree")], maxWidth: 200, measure: measure).count, 1)
        XCTAssertEqual(RichText.wrap([TextRun(text: "one\ntwo")], maxWidth: 200, measure: measure).map { $0.first?.text }, ["one", "two"])
        XCTAssertEqual(RichText.wrap([TextRun(text: "photosynthesis")], maxWidth: 30, measure: measure).map { $0.first?.text }, ["photosynthesis"])
    }
}
