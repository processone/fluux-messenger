fn main() {
    tauri_plugin::Builder::new(&["share_file"]).ios_path("ios").build();
}
