fn main() {
    tauri_plugin::Builder::new(&[
        "register",
        "take_pending_tap",
        "set_sender_names",
        "donate_conversation",
        "remove_conversation_donations",
        "set_notification_sound",
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
