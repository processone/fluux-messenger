//! Only closed, identity-free application observations may cross the export command.
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublisherDiagnostic {
    observed_at: Option<f64>,
    online: Option<bool>,
    verifying: Option<bool>,
    catching_up: Option<bool>,
    replaying: Option<bool>,
    #[serde(default)]
    badge_command: BadgeCommand,
    #[serde(default)]
    badge_acknowledgement: BadgeAcknowledgement,
}

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum BadgeCommand {
    #[default]
    Unknown,
    Emitted,
}

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum BadgeAcknowledgement {
    #[default]
    Unknown,
    Pending,
    Accepted,
    Rejected,
}

#[derive(Serialize)]
pub struct ExportDiagnosticArguments {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub publisher: Option<PublisherDiagnostic>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn context() -> Value {
        json!({"observedAt": 123.0, "online": true, "verifying": false,
            "catchingUp": null, "replaying": true, "badgeCommand": "emitted",
            "badgeAcknowledgement": "pending"})
    }

    #[test]
    fn only_closed_observations_are_forwarded() {
        let value = context();
        let publisher: PublisherDiagnostic = serde_json::from_value(value.clone()).unwrap();
        let encoded = serde_json::to_value(ExportDiagnosticArguments {
            publisher: Some(publisher),
        })
        .unwrap();
        assert_eq!(encoded, json!({"publisher": value}));
        assert_eq!(
            serde_json::to_value(ExportDiagnosticArguments { publisher: None }).unwrap(),
            json!({})
        );
    }

    #[test]
    fn identities_errors_and_unrecognized_states_are_rejected() {
        for key in ["account", "owner", "ownerHash", "message", "error", "snapshot"] {
            let mut value = context();
            value[key] = json!("must not be forwarded");
            assert!(serde_json::from_value::<PublisherDiagnostic>(value).is_err());
        }
        for (key, value) in [
            ("badgeCommand", json!("fixture@example.test")),
            ("badgeAcknowledgement", json!("arbitrary error")),
            ("online", json!("true")),
        ] {
            let mut input = context();
            input[key] = value;
            assert!(serde_json::from_value::<PublisherDiagnostic>(input).is_err());
        }
    }
}
