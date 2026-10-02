fn main() {
    tauri_plugin::Builder::new(&["register", "take_pending_tap", "register_listener", "remove_listener"])
        .ios_path("ios")
        .build();
}
