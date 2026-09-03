// swift-tools-version: 6.2

import PackageDescription

let package = Package(
    name: "OPTNOpalReference",
    platforms: [
        .macOS(.v26),
        .iOS(.v26)
    ],
    products: [
        .library(name: "OPTNOpalReference", targets: ["OPTNOpalReference"])
    ],
    dependencies: [
        .package(path: "../OPTNAppleProvider"),
        // SwiftFulcrum v0.8.0 annotated tag resolves to this commit.
        .package(
            url: "https://github.com/58opals/SwiftFulcrum.git",
            revision: "611a53f2047660e0dd221f75526ce11335be901a"
        ),
        // OpalDiagnostics v0.2.0 annotated tag resolves to this commit.
        .package(
            url: "https://github.com/58opals/OpalDiagnostics.git",
            revision: "8c42eeb40d64776789e70694e4e5006d2afa400c"
        )
    ],
    targets: [
        .target(
            name: "OPTNOpalReference",
            dependencies: [
                "OPTNAppleProvider",
                .product(name: "SwiftFulcrum", package: "SwiftFulcrum"),
                .product(name: "OpalDiagnostics", package: "OpalDiagnostics")
            ]
        ),
        .testTarget(
            name: "OPTNOpalReferenceTests",
            dependencies: ["OPTNOpalReference"]
        )
    ]
)
