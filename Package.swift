// swift-tools-version: 6.0
// Lets apps add PDF Studio's iOS SDK by this repository's URL:
//   .package(url: "https://github.com/nandkishormewara/pdf-studio", from: "1.0.0")
// The SDK and its tests live in mobile/ios/PDFStudioKit (run `swift test` there).
import PackageDescription

let package = Package(
    name: "PDFStudioKit",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "PDFStudioKit", targets: ["PDFStudioKit"]),
    ],
    targets: [
        .target(name: "PDFStudioKit", path: "mobile/ios/PDFStudioKit/Sources/PDFStudioKit"),
    ],
    swiftLanguageModes: [.v5]
)
