// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "OPTNAppleProvider",
    platforms: [
        .iOS(.v14),
        .macOS(.v11)
    ],
    products: [
        .library(name: "OPTNAppleProvider", targets: ["OPTNAppleProvider"])
    ],
    targets: [
        .target(name: "OPTNAppleProvider"),
        .testTarget(
            name: "OPTNAppleProviderTests",
            dependencies: ["OPTNAppleProvider"]
        )
    ]
)
