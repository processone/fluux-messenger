//! Disposable startup qualification never contacts notification services.
use super::backend::{AuthState, NativeNotification};
use tauri::AppHandle;
pub fn setup(_: &AppHandle) {}
pub fn post(_: NativeNotification) -> Result<(), String> { Ok(()) }
pub fn dismiss(_: &str, _: &str, _: Option<&str>) -> Result<(), String> { Ok(()) }
pub fn authorization_state() -> AuthState { AuthState::Denied }
pub fn request_authorization() -> AuthState { AuthState::Denied }

pub fn notification_settings_state() -> Result<super::backend::NotificationSettingsState, String> {
    Ok(super::backend::NotificationSettingsState {
        authorization: super::backend::SettingsAuthorization::Denied,
        badges: super::backend::NotificationSettingState::Disabled,
        alerts: super::backend::NotificationSettingState::Disabled,
        sounds: super::backend::NotificationSettingState::Disabled,
        alert_style: super::backend::SettingsAlertStyle::None,
    })
}
