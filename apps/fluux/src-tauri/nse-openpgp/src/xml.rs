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
            ResolveResult::Bound(n) => String::from_utf8(n.as_ref().to_vec())?,
            ResolveResult::Unbound => String::new(),
            _ => bail!("unknown namespace"),
        };
        match event {
            Event::Start(ref e) | Event::Empty(ref e) => {
                count += 1;
                ensure!(count <= 1024 && stack.len() < 16, "XML complexity");
                let node = Node {
                    name: String::from_utf8(e.local_name().as_ref().to_vec())?,
                    ns,
                    attrs: e
                        .attributes()
                        .map(|a| {
                            let a = a?;
                            Ok((
                                String::from_utf8(a.key.as_ref().to_vec())?,
                                a.unescape_value()?.into_owned(),
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
                let text = t.xml_content()?;
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
                .push_str(&t.decode()?),
            Event::GeneralRef(t) => {
                let text = quick_xml::escape::unescape(&format!("&{};", t.decode()?))?.into_owned();
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
