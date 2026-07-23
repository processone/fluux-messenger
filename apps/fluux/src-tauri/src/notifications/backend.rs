//! Platform-agnostic surface for native OS notifications.

use serde::{Deserialize, Serialize};

/// Where a notification click should navigate.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct NavTarget {
    #[serde(rename = "navType")]
    pub nav_type: String, // "conversation" | "room"
    #[serde(rename = "navTarget")]
    pub nav_target: String, // bare JID
    #[serde(rename = "messageId", skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    #[serde(rename = "accountId", skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
}

impl NavTarget {
    /// Stable grouping key used to dismiss every delivered notification for a
    /// conversation without conflating notifications from different accounts.
    #[cfg(any(target_os = "linux", target_os = "macos", test))]
    pub fn group_key(&self) -> String {
        format!(
            "{}\u{1f}{}\u{1f}{}",
            self.account_id.as_deref().unwrap_or_default(),
            self.nav_type,
            self.nav_target
        )
    }
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
#[cfg(target_os = "macos")]
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AuthState {
    Granted,
    Denied,
    NotDetermined,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nav_target_json_round_trip_preserves_optional_context() {
        let target = NavTarget {
            nav_type: "room".to_string(),
            nav_target: "team@conference.example.com".to_string(),
            message_id: Some("stanza-42".to_string()),
            account_id: Some("me@example.com".to_string()),
        };

        let encoded = serde_json::to_string(&target).expect("serializes");
        let decoded: NavTarget = serde_json::from_str(&encoded).expect("deserializes");
        assert_eq!(decoded, target);
    }

    #[test]
    fn group_key_ignores_message_but_scopes_account_and_kind() {
        let first = NavTarget {
            nav_type: "conversation".to_string(),
            nav_target: "alice@example.com".to_string(),
            message_id: Some("one".to_string()),
            account_id: Some("me@example.com".to_string()),
        };
        let mut second = first.clone();
        second.message_id = Some("two".to_string());
        assert_eq!(first.group_key(), second.group_key());

        second.account_id = Some("other@example.com".to_string());
        assert_ne!(first.group_key(), second.group_key());
    }
}
