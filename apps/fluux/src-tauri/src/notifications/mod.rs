//! Native notification presentation + click routing.
//!
//! Local notifications only (the running app shows an OS notification for a
//! message it already received). Server-initiated push is out of scope — see
//! the design spec. Web Push lives entirely on the JS side behind `!isTauri`.

// The backend types are consumed only by the macOS commands and `macos.rs`;
// gate the module so non-macOS builds don't see them as dead code (`-D warnings`).
#[cfg(target_os = "macos")]
pub mod backend;
#[cfg(target_os = "macos")]
mod macos;
pub mod settings_pane;

#[cfg(target_os = "macos")]
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

// Async so Tauri runs them off the main thread: the macOS helpers block on an
// async OS callback, which would otherwise freeze the UI (sync commands run on
// the main thread).
#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn notification_permission_state() -> AuthState {
    tauri::async_runtime::spawn_blocking(macos::authorization_state)
        .await
        .unwrap_or(AuthState::NotDetermined)
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn request_notification_permission() -> AuthState {
    tauri::async_runtime::spawn_blocking(macos::request_authorization)
        .await
        .unwrap_or(AuthState::NotDetermined)
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

#[cfg(target_os = "macos")]
#[tauri::command]
pub fn remove_delivered_notifications(identifiers: Vec<String>) {
    macos::remove_delivered(identifiers);
}
