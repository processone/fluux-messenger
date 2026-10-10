use super::*;
use quick_xml::{events::Event, name::ResolveResult, reader::NsReader};

pub(crate) struct Node {
    pub name: String,
    pub ns: String,
    pub attrs: HashMap<String, String>,
    pub children: Vec<Node>,
    pub text: String,
}
impl Node {
    pub fn child(&self, name: &str, ns: &str) -> Option<&Node> {
        self.children.iter().find(|c| c.name == name && c.ns == ns)
    }
    pub fn attr(&self, name: &str) -> &str {
        self.attrs.get(name).map(String::as_str).unwrap_or("")
    }
}
pub(crate) fn parse(bytes: &[u8]) -> Result<Node> {
    ensure!(bytes.len() <= LIMIT * 2, "XML size");
    let mut reader = NsReader::from_reader(bytes);
    let mut stack: Vec<Node> = Vec::new();
    let mut root = None;
    let mut count = 0;
    loop {
        let (ns, event) = reader.read_resolved_event()?;
        let ns = match ns {
            ResolveResult::Bound(n) => n.as_ref().to_owned(),
            ResolveResult::Unbound => String::new(),
            _ => bail!("unknown namespace"),
        };
        match event {
            Event::Start(ref e) | Event::Empty(ref e) => {
                count += 1;
                ensure!(count <= 1024 && stack.len() < 16, "XML complexity");
                let node = Node {
                    name: e.local_name().as_ref().to_owned(),
                    ns,
                    attrs: e
                        .attributes()
                        .map(|a| {
                            let a = a?;
                            Ok((
                                a.key.as_ref().to_owned(),
                                // Attribute whitespace stays literal; only references are expanded.
                                quick_xml::escape::unescape(a.value.as_ref())?.into_owned(),
                            ))
                        })
                        .collect::<Result<_>>()?,
                    children: Vec::new(),
                    text: String::new(),
                };
                if matches!(event, Event::Start(_)) {
                    stack.push(node);
                } else {
                    attach(node, &mut stack, &mut root)?;
                }
            }
            Event::End(_) => {
                let node = stack.pop().context("XML end")?;
                attach(node, &mut stack, &mut root)?;
            }
            Event::Text(t) => {
                // Preserve XML 1.1 EOL normalization for text; CDATA stays literal.
                let text = t.xml11_content();
                if let Some(parent) = stack.last_mut() {
                    parent.text.push_str(&text);
                } else {
                    ensure!(text.trim().is_empty(), "outside root");
                }
            }
            Event::CData(t) => stack
                .last_mut()
                .context("CDATA outside root")?
                .text
                .push_str(t.as_ref()),
            Event::GeneralRef(t) => {
                let text = quick_xml::escape::unescape(&format!("&{};", t.as_ref()))?.into_owned();
                stack
                    .last_mut()
                    .context("reference outside root")?
                    .text
                    .push_str(&text);
            }
            Event::DocType(_) => bail!("DOCTYPE forbidden"),
            Event::Eof => break,
            _ => {}
        }
    }
    ensure!(stack.is_empty(), "unclosed XML");
    root.context("missing XML")
}
fn attach(node: Node, stack: &mut [Node], root: &mut Option<Node>) -> Result<()> {
    if let Some(parent) = stack.last_mut() {
        parent.children.push(node);
    } else {
        ensure!(root.is_none(), "multiple roots");
        *root = Some(node);
    }
    Ok(())
}
pub(crate) fn stanza(bytes: &[u8]) -> Result<Node> {
    let mut wrapped =
        b"<root xmlns='jabber:client' xmlns:stream='http://etherx.jabber.org/streams'>".to_vec();
    wrapped.extend_from_slice(bytes);
    wrapped.extend_from_slice(b"</root>");
    let mut root = parse(&wrapped)?;
    ensure!(root.children.len() == 1, "stanza count");
    Ok(root.children.remove(0))
}
pub(crate) fn bare_jid(jid: &str) -> bool {
    let parts: Vec<_> = jid.split('@').collect();
    parts.len() == 2
        && parts.iter().all(|p| !p.is_empty())
        && jid.len() <= 3071
        && !jid.contains('/')
        && !jid.chars().any(|c| c.is_control() || c.is_whitespace())
}
pub(crate) fn ox_event(bytes: &[u8], account: &str) -> Result<EventKind> {
    let root = parse(bytes)?;
    const OX: &str = "urn:xmpp:openpgp:0";
    const CLIENT: &str = "jabber:client";
    ensure!(root.name == "signcrypt" && root.ns == OX, "OX envelope");
    ensure!(
        root.children
            .iter()
            .any(|c| c.name == "to" && c.ns == OX && c.attr("jid") == account),
        "OX recipient"
    );
    ensure!(
        !root
            .child("time", OX)
            .context("OX time")?
            .attr("stamp")
            .is_empty(),
        "OX timestamp"
    );
    let payloads: Vec<_> = root
        .children
        .iter()
        .filter(|c| c.name == "payload" && c.ns == CLIENT)
        .collect();
    ensure!(payloads.len() == 1, "OX payload");
    let payload = payloads[0];
    ensure!(
        payload.children.iter().all(|c| matches!(
            (c.name.as_str(), c.ns.as_str()),
            ("body", CLIENT)
                | ("x", "jabber:x:oob")
                | ("file", "urn:xmpp:file:metadata:0")
                | ("reactions", "urn:xmpp:reactions:0")
                | ("retract", "urn:xmpp:message-retract:1")
                | ("replace", "urn:xmpp:message-correct:0")
                | ("apply-to", "urn:xmpp:fasten:0")
                | ("easter-egg", "urn:fluux:easter-egg:0")
                | ("reply", "urn:xmpp:reply:0")
                | ("fallback", "urn:xmpp:fallback:0")
                | ("request" | "received", "urn:xmpp:receipts")
                | (
                    "markable" | "received" | "displayed" | "acknowledged",
                    "urn:xmpp:chat-markers:0"
                )
                | (
                    "active" | "composing" | "paused" | "inactive" | "gone",
                    "http://jabber.org/protocol/chatstates"
                )
        )),
        "payload namespace"
    );
    let bodies: Vec<_> = payload
        .children
        .iter()
        .filter(|c| c.name == "body" && c.ns == CLIENT)
        .collect();
    ensure!(
        bodies.len() <= 1 && bodies.iter().all(|b| b.children.is_empty()),
        "OX body"
    );
    let body = bodies
        .first()
        .map(|b| preview_text(&b.text))
        .unwrap_or_default();
    let markers: Vec<_> = payload
        .children
        .iter()
        .filter(|c| {
            matches!(
                c.name.as_str(),
                "replace"
                    | "retract"
                    | "reactions"
                    | "apply-to"
                    | "received"
                    | "displayed"
                    | "acknowledged"
                    | "easter-egg"
            )
        })
        .collect();
    ensure!(markers.len() <= 1, "ambiguous metadata");
    if let Some(marker) = markers.first() {
        let (mutation, text) = match (marker.name.as_str(), marker.ns.as_str()) {
            ("reactions", "urn:xmpp:reactions:0") => {
                ensure!(
                    marker.children.len() <= 16
                        && marker.children.iter().all(|c| c.name == "reaction"
                            && c.ns == marker.ns
                            && c.children.is_empty()
                            && c.text.chars().count() <= 32),
                    "reaction payload"
                );
                (
                    "reaction",
                    preview_text(
                        &marker
                            .children
                            .iter()
                            .map(|c| c.text.as_str())
                            .collect::<Vec<_>>()
                            .join(" "),
                    ),
                )
            }
            ("replace", "urn:xmpp:message-correct:0") => {
                ensure!(
                    !body.trim().is_empty() && marker.children.is_empty(),
                    "edit payload"
                );
                ("edit", body)
            }
            ("retract", "urn:xmpp:message-retract:1") => {
                ensure!(marker.children.is_empty(), "retraction payload");
                ("retraction", String::new())
            }
            ("apply-to", "urn:xmpp:fasten:0") => {
                if marker.children.len() == 1
                    && marker.children[0].name == "retract"
                    && marker.children[0].ns == "urn:xmpp:message-retract:0"
                    && marker.children[0].children.is_empty()
                {
                    ("retraction", String::new())
                } else if !marker.children.is_empty()
                    && marker.children.iter().all(|c| {
                        c.name == "meta"
                            && c.ns == "http://www.w3.org/1999/xhtml"
                            && c.children.is_empty()
                    })
                {
                    ("other", String::new())
                } else {
                    return Ok(EventKind::Unknown);
                }
            }
            // These authenticated events carry no user message preview.
            ("received", "urn:xmpp:receipts")
            | ("received" | "displayed" | "acknowledged", "urn:xmpp:chat-markers:0") => {
                ensure!(marker.children.is_empty(), "receipt payload");
                ("other", String::new())
            }
            ("easter-egg", "urn:fluux:easter-egg:0") => {
                return Ok(EventKind::Metadata {
                    mutation: "other".into(),
                    target: String::new(),
                    text: String::new(),
                })
            }
            _ => return Ok(EventKind::Unknown),
        };
        let target = marker.attr("id");
        ensure!(valid_id(target), "metadata target");
        return Ok(EventKind::Metadata {
            mutation: mutation.into(),
            target: target.into(),
            text,
        });
    }
    // A body accompanied by an unknown payload element must not disguise metadata.
    ensure!(
        payload
            .children
            .iter()
            .all(|c| c.name == "body" && c.ns == CLIENT
                || matches!(
                    (c.name.as_str(), c.ns.as_str()),
                    ("x", "jabber:x:oob")
                        | ("file", "urn:xmpp:file:metadata:0")
                        | ("reply", "urn:xmpp:reply:0")
                        | ("fallback", "urn:xmpp:fallback:0")
                        | ("request", "urn:xmpp:receipts")
                        | ("markable", "urn:xmpp:chat-markers:0")
                )),
        "unknown payload"
    );
    ensure!(
        bodies.len() == 1 && !body.trim().is_empty(),
        "empty preview"
    );
    Ok(EventKind::NewMessage { body })
}
pub(crate) fn valid_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 512 && !value.chars().any(char::is_control)
}
fn preview_text(text: &str) -> String {
    text.chars()
        .filter(|c| !c.is_control() || *c == '\n')
        .take(240)
        .collect()
}
#[cfg(test)]
pub(crate) fn ox_body(bytes: &[u8], account: &str) -> Result<String> {
    match ox_event(bytes, account)? {
        EventKind::NewMessage { body } => Ok(body),
        _ => bail!("not a new message"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_cdata_entities_and_attributes_preserve_decoding() {
        let node = parse(
            "<root value='a\t\r\nb&amp;&#xA;'>&lt;&#233;&#x1F642;\r\n\u{85}\u{2028}<![CDATA[<&\r\n\u{85}\u{2028}]]></root>".as_bytes(),
        )
        .unwrap();
        assert_eq!(node.attr("value"), "a\t\r\nb&\n");
        assert_eq!(node.text, "<é🙂\n\n\n<&\r\n\u{85}\u{2028}");
        for invalid in [
            b"<root>&unknown;</root>".as_slice(),
            b"<root>&#x110000;</root>",
            b"<root>&#0;</root>",
            b"<root>\xff</root>",
            b"<root><![CDATA[\xff]]></root>",
            b"<root value='\xff'/>",
            b"<root value='&unknown;'/>",
        ] {
            assert!(parse(invalid).is_err(), "accepted {invalid:?}");
        }
    }
}
