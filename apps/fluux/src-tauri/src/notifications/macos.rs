//! macOS native notifications via `UNUserNotificationCenter`.

use crate::notifications::backend::{AuthState, NativeNotification, NavTarget};
use std::sync::Mutex;
use std::sync::OnceLock;
use tauri::AppHandle;

/// App handle for emitting `notification-activated` from the delegate.
static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

/// Target stashed when a click fires before the webview is ready (cold start).
static PENDING_TARGET: Mutex<Option<NavTarget>> = Mutex::new(None);

pub fn setup(_app: &AppHandle) {
    // A later task fills this in: store APP_HANDLE, set the delegate, request authorization.
}

pub fn post(_n: NativeNotification) -> Result<(), String> {
    // A later task fills this in.
    Ok(())
}

pub fn authorization_state() -> AuthState {
    AuthState::NotDetermined // later task
}

pub fn request_authorization() -> AuthState {
    AuthState::NotDetermined // later task
}

pub fn take_pending_target() -> Option<NavTarget> {
    PENDING_TARGET.lock().unwrap().take()
}
