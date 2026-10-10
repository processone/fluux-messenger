// swift-tools-version:5.5
import PackageDescription
let package = Package(
    name: "tauri-plugin-push",
    platforms: [.iOS(.v15)],
    products: [.library(name: "tauri-plugin-push", type: .static, targets: ["tauri-plugin-push"])],
    dependencies: [.package(name: "Tauri", path: "../.tauri/tauri-api")],
    targets: [.target(name: "tauri-plugin-push", dependencies: [.byName(name: "Tauri")], path: "Sources", linkerSettings: [.linkedLibrary("sqlite3")])]
)
