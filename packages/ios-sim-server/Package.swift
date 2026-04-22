// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "ios-sim-server",
    platforms: [
        .macOS(.v13),
    ],
    products: [
        .executable(name: "ios-sim-server", targets: ["ios-sim-server"]),
    ],
    targets: [
        .executableTarget(
            name: "ios-sim-server",
            path: "Sources",
            cSettings: [
                .unsafeFlags(["-fobjc-arc"]),
            ],
            linkerSettings: [
                .unsafeFlags([
                    "-F/Applications/Xcode.app/Contents/Developer/Library/PrivateFrameworks",
                    "-F/Library/Developer/PrivateFrameworks",
                    "-Xlinker", "-rpath",
                    "-Xlinker", "/Applications/Xcode.app/Contents/Developer/Library/PrivateFrameworks",
                    "-Xlinker", "-rpath",
                    "-Xlinker", "/Library/Developer/PrivateFrameworks",
                ]),
                .linkedFramework("Foundation"),
                .linkedFramework("AppKit"),
                .linkedFramework("CoreVideo"),
                .linkedFramework("VideoToolbox"),
                .linkedFramework("IOSurface"),
                .linkedFramework("CoreMedia"),
                .linkedFramework("CoreFoundation"),
                .linkedFramework("CoreSimulator"),
                .linkedFramework("SimulatorKit"),
            ]
        ),
    ]
)
