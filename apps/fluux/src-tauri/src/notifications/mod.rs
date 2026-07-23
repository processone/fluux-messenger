//! Native notification presentation + click routing.
//!
//! Local notifications only (the running app shows an OS notification for a
//! message it already received). Server-initiated push is out of scope — see
//! the design spec. Web Push lives entirely on the JS side behind `!isTauri`.

pub mod backend;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
pub mod settings_pane;
#[cfg(target_os = "windows")]
mod windows;

#[cfg(target_os = "macos")]
use backend::AuthState;
use backend::{NativeNotification, NavTarget};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager};

/// App handle used by native activation callbacks.
static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

/// Latest click received before the React listener is ready. A user can only
/// act on one notification at a time, so the most recent click is authoritative.
static PENDING_TARGET: Mutex<Option<NavTarget>> = Mutex::new(None);

/// Explicit readiness avoids racing a cold-start activation against React
/// mounting: a webview window can exist before its event listener does.
static LISTENER_READY: AtomicBool = AtomicBool::new(false);

/// Wire up the active backend. Called from the Tauri `setup` hook.
pub fn setup(app: &AppHandle) {
    let _ = APP_HANDLE.set(app.clone());
    #[cfg(target_os = "macos")]
    macos::setup(app);
    #[cfg(target_os = "linux")]
    linux::setup(app);
    #[cfg(target_os = "windows")]
    windows::setup(app);
}

/// Restore the application and route a native notification click. Platform
/// backends call this from OS callback threads.
pub(crate) fn activate_target(target: NavTarget) {
    let app = APP_HANDLE.get();

    if let Some(window) = app.and_then(|a| a.get_webview_window("main")) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        // Linux may visually raise a window without focusing its WebKitGTK
        // child. The frontend already listens for this event to focus the
        // webview; it is harmless elsewhere.
        let _ = window.emit("tray-restore-focus", ());
    }

    if LISTENER_READY.load(Ordering::SeqCst) {
        if let Some(app) = app {
            let _ = app.emit("notification-activated", target);
            return;
        }
    }

    *PENDING_TARGET.lock().unwrap_or_else(|e| e.into_inner()) = Some(target);
}

#[tauri::command]
pub fn post_notification(
    title: String,
    body: String,
    nav_type: String,
    nav_target: String,
    message_id: Option<String>,
    account_id: Option<String>,
    avatar_path: Option<String>,
) -> Result<(), String> {
    let notification = NativeNotification {
        title,
        body,
        target: NavTarget {
            nav_type,
            nav_target,
            message_id,
            account_id,
        },
        avatar_path,
    };

    #[cfg(target_os = "macos")]
    return macos::post(notification);
    #[cfg(target_os = "linux")]
    return linux::post(notification);
    #[cfg(target_os = "windows")]
    return windows::post(notification);
    #[allow(unreachable_code)]
    Err("native desktop notifications are unsupported on this platform".to_string())
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

#[tauri::command]
pub fn take_pending_notification_target() -> Option<NavTarget> {
    PENDING_TARGET
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take()
}

#[tauri::command]
pub fn set_notification_listener_ready(ready: bool) {
    LISTENER_READY.store(ready, Ordering::SeqCst);
}

#[tauri::command]
pub fn dismiss_notifications(
    nav_type: String,
    nav_target: String,
    account_id: Option<String>,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return macos::dismiss(&nav_type, &nav_target, account_id.as_deref());
    #[cfg(target_os = "linux")]
    return linux::dismiss(&nav_type, &nav_target, account_id.as_deref());
    #[cfg(target_os = "windows")]
    return windows::dismiss(&nav_type, &nav_target, account_id.as_deref());
    #[allow(unreachable_code)]
    Ok(())
}
