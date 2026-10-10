#![cfg_attr(not(target_os = "ios"), allow(dead_code))]
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConversationType {
    Chat,
    Groupchat,
}
#[derive(serde::Serialize, serde::Deserialize)]
pub struct ConversationDestination {
    pub account: String,
    pub jid: String,
    #[serde(rename = "type")]
    pub kind: ConversationType,
}
pub fn valid_bare_jid(value: &str) -> bool {
    value.len() <= 3071
        && !value.contains('/')
        && !value.chars().any(char::is_whitespace)
        && value.split('@').count() == 2
        && value.split('@').all(|part| !part.is_empty())
}
impl ConversationDestination {
    pub fn validate(&self) -> Result<(), String> {
        if valid_bare_jid(&self.account) && valid_bare_jid(&self.jid) {
            Ok(())
        } else {
            Err("Invalid conversation".into())
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn suggestions_require_bare_account_and_recipient_jids() {
        for invalid in [
            "",
            "@example.com",
            "me@",
            "me@example.com/phone",
            "me@example.com\n",
            "a@b@c",
        ] {
            assert!(!valid_bare_jid(invalid));
        }
        assert!(valid_bare_jid("me@example.com"));
        assert!(valid_bare_jid("é@example.com"));
        assert!(serde_json::from_str::<ConversationDestination>(
            r#"{"account":"me@example.com","jid":"friend@example.com","type":"unknown"}"#
        )
        .is_err());
    }
}
