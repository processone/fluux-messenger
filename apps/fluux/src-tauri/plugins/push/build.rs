fn main() {
    tauri_plugin::Builder::new(&["register", "register_listener", "remove_listener"])
        .ios_path("ios")
        .build();
}
