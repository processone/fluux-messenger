//! Disposable startup qualification never contacts notification services.
use super::backend::{AuthState, NativeNotification};
use tauri::AppHandle;
pub fn setup(_: &AppHandle) {}
pub fn post(_: NativeNotification) -> Result<(), String> { Ok(()) }
pub fn dismiss(_: &str, _: &str, _: Option<&str>) -> Result<(), String> { Ok(()) }
pub fn authorization_state() -> AuthState { AuthState::Denied }
pub fn request_authorization() -> AuthState { AuthState::Denied }
