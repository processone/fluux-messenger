//! Desktop IPC is deliberately limited to the shared metadata mirror, never arbitrary paths.
use std::ffi::CString;
use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

extern "C" {
    fn fluux_desktop_widgets_apply(
        operation: *const std::ffi::c_char,
        json: *const std::ffi::c_char,
    ) -> i32;
}

fn apply(operation: &str, value: serde_json::Value) -> Result<bool, String> {
    let operation = CString::new(operation).map_err(|_| "Invalid widget operation")?;
    let json = CString::new(value.to_string()).map_err(|_| "Invalid widget metadata")?;
    // Both pointers stay alive during this synchronous call; Swift copies the bytes before returning.
    match unsafe { fluux_desktop_widgets_apply(operation.as_ptr(), json.as_ptr()) } {
        1 => Ok(true),
        0 => Ok(false),
        -2 => Err("Widget adapter unavailable".into()),
        _ => Err("Widget storage unavailable".into()),
    }
}

#[tauri::command]
async fn set_unread_list(list: Option<serde_json::Value>) -> Result<(), String> {
    apply("list", list.unwrap_or(serde_json::Value::Null)).map(|_| ())
}

#[tauri::command]
async fn set_sender_names(names: serde_json::Value) -> Result<(), String> {
    apply("names", names).map(|_| ())
}

#[derive(serde::Serialize)]
struct AvatarResult {
    written: bool,
}

#[tauri::command]
async fn set_notification_avatar(avatar: serde_json::Value) -> Result<AvatarResult, String> {
    apply("avatar", avatar).map(|written| AvatarResult { written })
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("widgets")
        .invoke_handler(tauri::generate_handler![
            set_unread_list,
            set_sender_names,
            set_notification_avatar
        ])
        .build()
}
