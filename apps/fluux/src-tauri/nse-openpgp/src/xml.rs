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
pub(crate) fn ox_body(bytes: &[u8], account: &str) -> Result<String> {
    let root = parse(bytes)?;
    const OX: &str = "urn:xmpp:openpgp:0";
    ensure!(root.name == "signcrypt" && root.ns == OX, "OX envelope");
    ensure!(
        root.children
            .iter()
            .any(|c| c.name == "to" && c.ns == OX && c.attr("jid") == account),
        "OX recipient"
    );
    let timestamp = root.child("time", OX).context("OX time")?;
    ensure!(!timestamp.attr("stamp").is_empty(), "OX timestamp");
    let payloads: Vec<_> = root
        .children
        .iter()
        .filter(|c| c.name == "payload" && c.ns == "jabber:client")
        .collect();
    ensure!(payloads.len() == 1, "OX payload");
    let payload = payloads[0];
    ensure!(
        !payload
            .children
            .iter()
            .any(|c| matches!(c.name.as_str(), "replace" | "retract" | "apply-to")),
        "mutation message"
    );
    let bodies: Vec<_> = payload
        .children
        .iter()
        .filter(|c| c.name == "body" && c.ns == "jabber:client")
        .collect();
    ensure!(
        bodies.len() == 1 && bodies[0].children.is_empty(),
        "OX body"
    );
    let body: String = bodies[0]
        .text
        .chars()
        .filter(|c| !c.is_control() || *c == '\n')
        .take(240)
        .collect();
    ensure!(!body.trim().is_empty(), "empty preview");
    Ok(body)
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
