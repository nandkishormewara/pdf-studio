import CoreGraphics
import Foundation
import PDFKit

/// Annotation names (`/NM`) read straight from the file with Core Graphics.
///
/// PDFKit before iOS 27 / macOS 27 doesn't return `/NM` from `value(forAnnotationKey: .name)` for annotations
/// it reads from a file, so the ids that the web and Android SDKs (and Apryse WebViewer) match marks by
/// would be lost. This reads them from each page's `/Annots` array instead and hands them out by
/// subtype and rectangle. That PDFKit doesn't write /NM either, so `restoringNames(in:)` fixes saved files.
struct AnnotationNames {
    private struct Entry {
        let subtype: String
        let rect: CGRect
        let name: String
        var used = false
    }

    private var pages: [Int: [Entry]] = [:]

    init(data: Data) {
        guard let provider = CGDataProvider(data: data as CFData), let doc = CGPDFDocument(provider) else { return }
        for index in 0..<doc.numberOfPages {
            guard let dict = doc.page(at: index + 1)?.dictionary else { continue }
            var annots: CGPDFArrayRef?
            guard CGPDFDictionaryGetArray(dict, "Annots", &annots), let annots else { continue }
            var entries: [Entry] = []
            for i in 0..<CGPDFArrayGetCount(annots) {
                var annot: CGPDFDictionaryRef?
                guard CGPDFArrayGetDictionary(annots, i, &annot), let annot else { continue }
                var nm: CGPDFStringRef?
                guard CGPDFDictionaryGetString(annot, "NM", &nm), let nm,
                      let name = CGPDFStringCopyTextString(nm) as String?, !name.isEmpty else { continue }
                var subtype: UnsafePointer<CChar>?
                guard CGPDFDictionaryGetName(annot, "Subtype", &subtype), let subtype else { continue }
                entries.append(Entry(subtype: String(cString: subtype), rect: Self.rect(annot) ?? .null, name: name))
            }
            if !entries.isEmpty { pages[index] = entries }
        }
    }

    var isEmpty: Bool { pages.isEmpty }

    /// The `/NM` of the file annotation that `annot` was read from, if PDFKit left it out.
    /// Each name is handed out once.
    mutating func name(for annot: PDFAnnotation, page: Int) -> String? {
        guard var entries = pages[page], let type = annot.type else { return nil }
        let candidates = entries.indices.filter { !entries[$0].used && entries[$0].subtype == type }
        let bounds = annot.bounds
        let close = { (r: CGRect) in
            !r.isNull && abs(r.minX - bounds.minX) <= 2 && abs(r.minY - bounds.minY) <= 2
                && abs(r.maxX - bounds.maxX) <= 2 && abs(r.maxY - bounds.maxY) <= 2
        }
        // Same subtype and rectangle; otherwise the only unused one of that subtype.
        guard let i = candidates.first(where: { close(entries[$0].rect) }) ?? (candidates.count == 1 ? candidates[0] : nil)
        else { return nil }
        entries[i].used = true
        pages[page] = entries
        return entries[i].name
    }

    /// Saved bytes with `/NM` in every annotation that has an id.
    ///
    /// PDFKit before 27 drops `/NM` when it saves but keeps our own copies of the id. When the file has no `/NM`
    /// at all, each `/PDFStudioN0` key is renamed in place to `/NM` padded with spaces: the same length, so the
    /// cross-reference offsets stay valid. `/PDFStudioNM` stays, for when PDFKit saves the file again.
    /// Files that already have `/NM` are returned unchanged.
    static func restoringNames(in data: Data) -> Data {
        guard AnnotationNames(data: data).isEmpty else { return data }
        let key = Data(AnnotationBridge.nameSlotKey.rawValue.utf8)          // "/PDFStudioN0"
        let replacement = Data("/NM".utf8) + Data(repeating: 0x20, count: key.count - 3)
        let delimiters: Set<UInt8> = [0x20, 0x0A, 0x0D, 0x09, 0x0C, 0x00, 0x28, 0x3C]   // whitespace, "(", "<"
        var out = data
        var changed = false
        var from = out.startIndex
        while let r = out.range(of: key, in: from..<out.endIndex) {
            from = r.upperBound
            guard r.upperBound < out.endIndex, delimiters.contains(out[r.upperBound]) else { continue }
            out.replaceSubrange(r, with: replacement)
            changed = true
        }
        // Only keep the result if it still parses and now carries the names.
        guard changed, !AnnotationNames(data: out).isEmpty else { return data }
        return out
    }

    private static func rect(_ annot: CGPDFDictionaryRef) -> CGRect? {
        var arr: CGPDFArrayRef?
        guard CGPDFDictionaryGetArray(annot, "Rect", &arr), let arr, CGPDFArrayGetCount(arr) == 4 else { return nil }
        var v = [CGFloat](repeating: 0, count: 4)
        for i in 0..<4 {
            var n: CGPDFReal = 0
            guard CGPDFArrayGetNumber(arr, i, &n) else { return nil }
            v[i] = n
        }
        return CGRect(x: min(v[0], v[2]), y: min(v[1], v[3]), width: abs(v[2] - v[0]), height: abs(v[3] - v[1]))
    }
}
