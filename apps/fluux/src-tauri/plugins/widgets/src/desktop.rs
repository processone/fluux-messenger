//! Desktop IPC is deliberately limited to the shared metadata mirror, never arbitrary paths.
use std::{
    ffi::CString,
    sync::atomic::{AtomicBool, Ordering},
};

use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

static SUPPORTED: AtomicBool = AtomicBool::new(true);

extern "C" {
    fn fluux_desktop_widgets_apply(
        operation: *const std::ffi::c_char,
        json: *const std::ffi::c_char,
    ) -> i32;
}

#[derive(serde::Serialize, Debug, PartialEq)]
struct WriteResult {
    written: bool,
    supported: bool,
}

fn apply(operation: &str, value: serde_json::Value) -> Result<WriteResult, String> {
    if !SUPPORTED.load(Ordering::Acquire) {
        return Ok(WriteResult {
            written: false,
            supported: false,
        });
    }
    let operation = CString::new(operation).map_err(|_| "Invalid widget operation")?;
    let json = CString::new(value.to_string()).map_err(|_| "Invalid widget metadata")?;
    // Both pointers stay alive during this synchronous call; Swift copies the bytes before returning.
    match unsafe { fluux_desktop_widgets_apply(operation.as_ptr(), json.as_ptr()) } {
        1 => Ok(WriteResult {
            written: true,
            supported: true,
        }),
        0 => Ok(WriteResult {
            written: false,
            supported: true,
        }),
        -2 => {
            if SUPPORTED.swap(false, Ordering::AcqRel) {
                eprintln!("[Widgets] Optional desktop adapter unavailable; widget publication is disabled for this session");
            }
            Ok(WriteResult {
                written: false,
                supported: false,
            })
        }
        _ => Err("Widget storage unavailable".into()),
    }
}

#[tauri::command]
async fn set_unread_list(
    list: Option<serde_json::Value>,
    heartbeat: Option<bool>,
) -> Result<WriteResult, String> {
    apply(
        if heartbeat == Some(true) {
            "heartbeat"
        } else {
            "list"
        },
        list.unwrap_or(serde_json::Value::Null),
    )
}

#[tauri::command]
async fn set_sender_names(names: serde_json::Value) -> Result<WriteResult, String> {
    apply("names", names)
}

#[tauri::command]
async fn set_notification_avatar(avatar: serde_json::Value) -> Result<WriteResult, String> {
    apply("avatar", avatar)
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

#[cfg(test)]
mod tests {
    use super::*;

    // Review I7: exercise the actual unbundled native loader, then the async IPC owners.
    // No test bundle, App Group, signing program or account is opened.
    #[test]
    fn unavailable_unbundled_adapter_is_a_quiet_session_fallback() {
        let operation = CString::new("list").unwrap();
        let json = CString::new("null").unwrap();
        let native = unsafe { fluux_desktop_widgets_apply(operation.as_ptr(), json.as_ptr()) };
        assert!(
            native == -2 || native == 0,
            "unbundled host must not find a writer"
        );
        let first =
            tauri::async_runtime::block_on(set_sender_names(serde_json::json!({}))).unwrap();
        assert!(!first.written);
        if native == -2 {
            assert!(!first.supported);
            assert!(!SUPPORTED.load(Ordering::Acquire));
        }
        let next = tauri::async_runtime::block_on(set_unread_list(None, None)).unwrap();
        assert_eq!(next, first);
        let avatar =
            tauri::async_runtime::block_on(set_notification_avatar(serde_json::json!({}))).unwrap();
        assert_eq!(avatar, first);
    }
}
