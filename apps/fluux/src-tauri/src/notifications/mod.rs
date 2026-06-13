//! Native notification presentation + click routing.
//!
//! Local notifications only (the running app shows an OS notification for a
//! message it already received). Server-initiated push is out of scope — see
//! the design spec. Web Push lives entirely on the JS side behind `!isTauri`.

pub mod backend;
#[cfg(target_os = "macos")]
mod macos;

use backend::{AuthState, NativeNotification, NavTarget};
use tauri::AppHandle;

/// Wire up the active backend. Called from the Tauri `setup` hook.
pub fn setup(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    macos::setup(app);
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub fn post_notification(
    title: String,
    body: String,
    nav_type: String,
    nav_target: String,
    avatar_path: Option<String>,
) -> Result<(), String> {
    macos::post(NativeNotification {
        title,
        body,
        target: NavTarget { nav_type, nav_target },
        avatar_path,
    })
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub fn notification_permission_state() -> AuthState {
    macos::authorization_state()
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub fn request_notification_permission() -> AuthState {
    macos::request_authorization()
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub fn take_pending_notification_target() -> Option<NavTarget> {
    macos::take_pending_target()
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub fn set_notification_listener_ready(ready: bool) {
    macos::set_listener_ready(ready);
}
