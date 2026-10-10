use super::*;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum EventKind {
    NewMessage {
        body: String,
    },
    Metadata {
        mutation: String,
        target: String,
        text: String,
    },
    Unknown,
    AlreadyHandled,
}
#[derive(Clone, Debug, Serialize)]
pub struct ArchiveEvent {
    pub uid: String,
    pub id: String,
    #[serde(rename = "originId")]
    pub origin_id: Option<String>,
    #[serde(flatten)]
    pub event: EventKind,
}

pub(crate) fn outer_correction(event: EventKind, replace: Option<String>) -> EventKind {
    match (event, replace) {
        // The marker is archive transport metadata, not part of the OX signature.
        // Target author/alias checks belong to the batch reducer before any mutation.
        (EventKind::NewMessage { body }, Some(target)) => EventKind::Metadata {
            mutation: "outerEdit".into(),
            target,
            text: body,
        },
        (EventKind::AlreadyHandled, _) => EventKind::AlreadyHandled,
        (event, None) => event,
        _ => EventKind::Unknown,
    }
}
