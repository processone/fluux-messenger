#[cfg(any(test, feature = "synthetic-lab"))]
use serde::{Deserialize, Serialize};

pub fn personal_archive_id<'a>(
    mam_uid: Option<&'a str>,
    stanza_id: Option<&'a str>,
    stanza_by: Option<&str>,
    account: &str,
) -> &'a str {
    mam_uid.unwrap_or_else(|| {
        if stanza_by == Some(account) {
            stanza_id.unwrap_or("")
        } else {
            ""
        }
    })
}
#[cfg(any(test, feature = "synthetic-lab"))]
pub fn archive_key(uid: &str) -> String {
    if uid.is_empty() {
        String::new()
    } else {
        format!("stanzaId:{uid}")
    }
}
#[cfg(any(test, feature = "synthetic-lab"))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub account: String,
    pub mam_uid: Option<String>,
    pub stanza_id: Option<String>,
    pub stanza_by: Option<String>,
    pub id: String,
    pub origin_id: Option<String>,
    #[serde(default)]
    pub uid: String,
    #[serde(default)]
    pub key: String,
}
#[cfg(any(test, feature = "synthetic-lab"))]
#[derive(Deserialize)]
pub struct Case {
    pub messages: Vec<Message>,
    pub target: String,
    pub resolved: Option<String>,
    pub batches: Option<Vec<Vec<Event>>>,
    pub steps: Option<Vec<Step>>,
}
#[cfg(any(test, feature = "synthetic-lab"))]
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub uid: String,
    pub id: String,
    pub origin_id: Option<String>,
    pub kind: String,
    pub body: Option<String>,
    pub mutation: Option<String>,
    pub target: Option<String>,
    pub text: Option<String>,
}
#[cfg(any(test, feature = "synthetic-lab"))]
#[derive(Deserialize, Serialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub body: Option<String>,
    pub claimed: Vec<String>,
    pub remove_requests: Vec<String>,
    pub handoffs: Vec<bool>,
}
#[cfg(any(test, feature = "synthetic-lab"))]
#[derive(Deserialize)]
pub struct Corpus {
    pub version: u32,
    pub cases: Vec<Case>,
}
#[cfg(any(test, feature = "synthetic-lab"))]
#[derive(Serialize, PartialEq, Debug)]
pub struct Output {
    pub keys: Vec<String>,
    pub resolved: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub steps: Option<Vec<Step>>,
}
#[cfg(any(test, feature = "synthetic-lab"))]
pub fn evaluate(case: &Case) -> Output {
    if let Some(batches) = &case.batches {
        return Output {
            keys: vec![],
            resolved: None,
            steps: Some(sequence(batches)),
        };
    }
    let messages: Vec<_> = case
        .messages
        .iter()
        .map(|m| {
            (
                m,
                personal_archive_id(
                    m.mam_uid.as_deref(),
                    m.stanza_id.as_deref(),
                    m.stanza_by.as_deref(),
                    &m.account,
                ),
            )
        })
        .collect();
    let mut resolved = None;
    for tier in 0..3 {
        let matches: Vec<_> = messages
            .iter()
            .filter(|(m, uid)| {
                !uid.is_empty()
                    && match tier {
                        0 => *uid == case.target,
                        1 => m.origin_id.as_deref() == Some(case.target.as_str()),
                        _ => m.id == case.target,
                    }
            })
            .collect();
        if !matches.is_empty() {
            if matches.len() == 1 {
                resolved = Some(matches[0].1.to_owned());
            }
            break;
        }
    }
    Output {
        keys: messages.iter().map(|(_, uid)| archive_key(uid)).collect(),
        resolved,
        steps: None,
    }
}
#[cfg(any(test, feature = "synthetic-lab"))]
fn sequence(batches: &[Vec<Event>]) -> Vec<Step> {
    use std::collections::{BTreeMap, BTreeSet};
    fn resolve(facts: &BTreeMap<String, Event>, target: &str) -> Option<String> {
        for tier in 0..3 {
            let matches: Vec<_> = facts
                .values()
                .filter(|m| match tier {
                    0 => m.uid == target,
                    1 => m.origin_id.as_deref() == Some(target),
                    _ => m.id == target,
                })
                .collect();
            if !matches.is_empty() {
                return if matches.len() == 1 {
                    Some(matches[0].uid.clone())
                } else {
                    None
                };
            }
        }
        None
    }
    let mut facts = BTreeMap::new();
    let mut pending: BTreeSet<String> = BTreeSet::new();
    let mut notified = BTreeSet::new();
    let mut handled = BTreeSet::new();
    let mut retracted = BTreeSet::new();
    let mut steps = Vec::new();
    let mut requests: BTreeMap<String, String> = BTreeMap::new();
    let mut edit_targets: BTreeMap<String, String> = BTreeMap::new();
    let mut selections: Vec<Vec<String>> = Vec::new();
    for (index, events) in batches.iter().enumerate() {
        let mut removals = BTreeSet::new();
        let cancel = |uid: &str| {
            requests
                .iter()
                .filter(|(id, _)| {
                    id.as_str() == uid || edit_targets.get(*id).is_some_and(|target| target == uid)
                })
                .map(|(_, request)| request.clone())
                .collect::<Vec<_>>()
        };
        for event in events.iter().filter(|e| e.kind == "newMessage") {
            facts.insert(event.uid.clone(), event.clone());
        }
        for target in pending.clone() {
            if let Some(uid) = resolve(&facts, &target) {
                removals.extend(cancel(&uid));
                retracted.insert(uid);
                pending.remove(&target);
            }
        }
        let mut candidates: Vec<_> = events
            .iter()
            .filter(|e| {
                e.kind == "newMessage" && !notified.contains(&e.uid) && !retracted.contains(&e.uid)
            })
            .cloned()
            .collect();
        let mut metadata: Option<Event> = None;
        let mut unresolved = false;
        for event in events.iter().filter(|e| e.kind == "metadata") {
            let target = event.target.as_deref().unwrap_or("");
            let Some(uid) = resolve(&facts, target) else {
                if event.mutation.as_deref() == Some("retraction") {
                    pending.insert(target.to_owned());
                }
                unresolved = true;
                continue;
            };
            let retract = event.mutation.as_deref() == Some("retraction");
            if !handled.contains(&event.uid)
                && !notified.contains(&event.uid)
                && (retract || !retracted.contains(&uid))
            {
                metadata = Some(event.clone());
            }
            handled.insert(event.uid.clone());
            if retract {
                removals.extend(cancel(&uid));
                pending.remove(target);
                retracted.insert(uid.clone());
                candidates.retain(|m| m.uid != uid);
            } else if !retracted.contains(&uid) {
                for candidate in candidates.iter_mut().filter(|m| m.uid == uid) {
                    candidate.body.clone_from(&event.text);
                }
            }
        }
        if metadata.as_ref().is_some_and(|e| {
            e.mutation.as_deref() != Some("retraction")
                && resolve(&facts, e.target.as_deref().unwrap_or(""))
                    .is_some_and(|uid| retracted.contains(&uid))
        }) {
            metadata = None;
        }
        if unresolved {
            candidates.clear();
            metadata = None;
        }
        let claimed: Vec<String> = if !candidates.is_empty() {
            candidates.iter().map(|m| m.uid.clone()).collect()
        } else {
            metadata.iter().map(|m| m.uid.clone()).collect()
        };
        if candidates.is_empty() {
            if let Some(event) = &metadata {
                if event.mutation.as_deref() != Some("retraction") {
                    edit_targets.insert(
                        event.uid.clone(),
                        resolve(&facts, event.target.as_deref().unwrap_or("")).unwrap(),
                    );
                }
            }
        }
        let body = if candidates.len() == 1 {
            candidates[0].body.clone()
        } else if !candidates.is_empty() {
            Some(format!("Alice: {} new messages", candidates.len()))
        } else {
            metadata.map(|m| {
                if m.mutation.as_deref() == Some("retraction") {
                    "Alice deleted a message".to_owned()
                } else {
                    format!("Alice (edit): {}", m.text.unwrap_or_default())
                }
            })
        };
        notified.extend(claimed.iter().cloned());
        for uid in &claimed {
            requests.insert(uid.clone(), format!("request-{index}"));
        }
        if !claimed.is_empty() {
            selections.push(claimed.clone());
        }
        let handoffs = selections
            .iter()
            .map(|ids| {
                ids.iter().all(|uid| {
                    !retracted.contains(uid)
                        && !edit_targets
                            .get(uid)
                            .is_some_and(|target| retracted.contains(target))
                })
            })
            .collect();
        steps.push(Step {
            body,
            claimed,
            remove_requests: removals.into_iter().collect(),
            handoffs,
        });
    }
    steps
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_sdk_identity_corpus() {
        let corpus: Corpus = serde_json::from_str(include_str!(
            "../../../../../scripts/native-tests/preview-identity-fixtures.json"
        ))
        .unwrap();
        assert_eq!(corpus.version, 1);
        for case in corpus.cases {
            let actual = evaluate(&case);
            assert_eq!(
                actual.keys,
                case.messages
                    .iter()
                    .map(|m| m.key.clone())
                    .collect::<Vec<_>>()
            );
            assert_eq!(actual.resolved, case.resolved);
            assert_eq!(actual.steps, case.steps);
            for m in &case.messages {
                assert_eq!(
                    personal_archive_id(
                        m.mam_uid.as_deref(),
                        m.stanza_id.as_deref(),
                        m.stanza_by.as_deref(),
                        &m.account
                    ),
                    m.uid
                );
            }
        }
    }
}
