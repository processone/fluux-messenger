fn main() {
    tauri_plugin::Builder::new(&["set_unread_list"])
        .ios_path("ios")
        .build();
}
