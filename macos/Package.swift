// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "PickerMuxCompanion",
  platforms: [.macOS(.v13)],
  products: [.executable(name: "PickerMuxCompanion", targets: ["PickerMuxCompanion"])],
  targets: [
    .target(name: "PickerMuxCompanionCore"),
    .executableTarget(name: "PickerMuxCompanion", dependencies: ["PickerMuxCompanionCore"]),
    .testTarget(name: "PickerMuxCompanionCoreTests", dependencies: ["PickerMuxCompanionCore"], resources: [.copy("Fixtures")]),
    .testTarget(name: "PickerMuxCompanionUITests", dependencies: ["PickerMuxCompanion"]),
  ],
  swiftLanguageModes: [.v5]
)
