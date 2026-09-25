fn main() {
    tauri_plugin::Builder::new(&["list", "read", "remove"])
        .android_path("android")
        .ios_path("ios")
        .build();
}
