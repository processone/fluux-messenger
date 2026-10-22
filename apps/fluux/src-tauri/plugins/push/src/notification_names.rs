#![cfg_attr(not(target_os = "ios"), allow(dead_code))]

/// Account-owned metadata forwarded to the notification service extension.
#[derive(serde::Serialize, serde::Deserialize)]
pub struct SenderNames {
    #[serde(default)]
    pub conversations: Vec<ShortcutConversation>,
    contacts: std::collections::HashMap<String, String>,
    rooms: std::collections::HashMap<String, String>,
    #[serde(default)]
    avatars: std::collections::HashMap<String, String>,
    #[serde(default, rename = "roomParticipants")]
    room_participants: std::collections::HashMap<String, RoomParticipants>,
    pub account: Option<String>,
    #[serde(default, rename = "preserveIfEmpty")]
    preserve_if_empty: bool,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RoomParticipants {
    own_nick: String,
    nicks: Vec<String>,
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct ShortcutConversation {
    pub id: String,
    name: String,
    pub kind: String,
    pub account: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bridge_preserves_real_room_participants() {
        let input = serde_json::json!({
            "contacts": {}, "rooms": { "team@muc.example.com": "Team" },
            "account": "me@example.com",
            "roomParticipants": {
                "team@muc.example.com": { "ownNick": "Me", "nicks": ["Alice", "Bob", "Me"] }
            }
        });
        let names: SenderNames = serde_json::from_value(input.clone()).unwrap();
        let forwarded = serde_json::to_value(names).unwrap();
        assert_eq!(forwarded["roomParticipants"], input["roomParticipants"]);
    }

    #[test]
    fn bridge_accepts_legacy_mirrors_and_logout() {
        for account in [Some("me@example.com"), None] {
            let names: SenderNames = serde_json::from_value(serde_json::json!({
                "contacts": {}, "rooms": {}, "account": account
            }))
            .unwrap();
            let forwarded = serde_json::to_value(names).unwrap();
            assert_eq!(forwarded["account"], serde_json::json!(account));
            assert_eq!(forwarded["roomParticipants"], serde_json::json!({}));
        }
    }
}
