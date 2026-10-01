fn main() {
    tauri_plugin::Builder::new(&["register"])
        .ios_path("ios")
        .build();
}
