fn main() {
    tauri_plugin::Builder::new(&["haptic"])
        .ios_path("ios")
        .build();
}
