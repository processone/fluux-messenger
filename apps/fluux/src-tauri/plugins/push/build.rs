fn main() {
    tauri_plugin::Builder::new(&[
        "register",
        "take_pending_tap",
        "set_sender_names",
        "set_notification_avatar",
        "set_notification_preview",
        "set_badge",
        "dismiss_notifications",
        "register_listener",
        "remove_listener",
    ])
    .ios_path("ios")
    .build();
}
