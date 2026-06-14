//! Platform-agnostic surface for native OS notifications.
//!
//! Each desktop platform implements `NotificationBackend`. Today only macOS
//! has a concrete backend (`super::macos`); Windows/Linux keep using the
//! Tauri notification plugin from the JS side until backends land here.

use serde::Serialize;

/// Where a notification click should navigate.
#[derive(Debug, Clone, Serialize)]
pub struct NavTarget {
    #[serde(rename = "navType")]
    pub nav_type: String, // "conversation" | "room"
    #[serde(rename = "navTarget")]
    pub nav_target: String, // bare JID
}

/// A notification to present.
#[derive(Debug, Clone)]
pub struct NativeNotification {
    pub title: String,
    pub body: String,
    pub target: NavTarget,
    /// Absolute file path to an image attachment, if any (added in a later task).
    pub avatar_path: Option<String>,
}

/// Authorization state, mirrored to the JS permission gate.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AuthState {
    Granted,
    Denied,
    NotDetermined,
}
