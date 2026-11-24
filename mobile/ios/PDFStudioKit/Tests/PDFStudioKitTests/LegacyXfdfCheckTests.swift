import CoreGraphics
import Foundation
import XCTest
@testable import PDFStudioKit

/// Opt-in check of stored PDFTron markup: every XFDF under LEGACY_DIR through the iOS reader, one JSON line per file
/// into LEGACY_OUT; scripts/compare_legacy_xfdf.py compares it with the web and Android. Skipped unless both are set.
final class LegacyXfdfCheckTests: XCTestCase {
    func testReadsEveryLegacyXFDF() throws {
        let env = ProcessInfo.processInfo.environment
        guard let dir = env["LEGACY_DIR"], let out = env["LEGACY_OUT"] else { return }
        let geometry = PageGeometry(crop: CGRect(x: 0, y: 0, width: 612, height: 792), rotation: 0)
        let root = URL(fileURLWithPath: dir)
        let files = (FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil)?.compactMap { $0 as? URL } ?? [])
            .filter { $0.pathExtension == "xfdf" }
            .map { String($0.path.dropFirst(root.path.count + 1)) }
            .sorted()
        FileManager.default.createFile(atPath: out, contents: nil)
        let handle = try XCTUnwrap(FileHandle(forWritingAtPath: out))
        let enc = JSONEncoder()
        for rel in files {
            var line: [String: Any] = ["file": rel]
            do {
                let xml = try String(contentsOf: root.appendingPathComponent(rel), encoding: .utf8)
                let imp = try XFDF.parse(xml) { _ in geometry }
                line["partial"] = imp.partial
                line["annotations"] = try imp.annotations.map { try JSONSerialization.jsonObject(with: enc.encode($0)) }
            } catch {
                line["error"] = String(describing: error).prefix(200)
            }
            handle.write(try JSONSerialization.data(withJSONObject: line))
            handle.write(Data("\n".utf8))
        }
        try handle.close()
        print("ios: \(files.count) files")
    }
}
