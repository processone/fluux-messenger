use super::*;
use quick_xml::{events::Event, Reader};
use std::{
    io::{Read, Write},
    net::{Shutdown, SocketAddr, TcpStream},
    sync::mpsc,
};
use xml::{stanza, Node};
const CLIENT: &str = "jabber:client";
const STREAM: &str = "http://etherx.jabber.org/streams";
const SASL: &str = "urn:ietf:params:xml:ns:xmpp-sasl";

struct Deadline {
    done: mpsc::Sender<()>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Deadline {
    fn new(socket: &TcpStream, end: Instant, cancelled: Arc<AtomicBool>) -> Result<Self> {
        let socket = socket.try_clone()?;
        let (done, wait) = mpsc::channel();
        let thread = std::thread::Builder::new()
            .name("nse-deadline".into())
            .stack_size(64 * 1024)
            .spawn(move || loop {
                if cancelled.load(Ordering::Relaxed) || Instant::now() >= end {
                    let _ = socket.shutdown(Shutdown::Both);
                    break;
                }
                match wait.recv_timeout(Duration::from_millis(20)) {
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    _ => break,
                }
            })?;
        Ok(Self {
            done,
            thread: Some(thread),
        })
    }
}
impl Drop for Deadline {
    fn drop(&mut self) {
        let _ = self.done.send(());
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}
enum Transport {
    Plain(TcpStream),
    Tls(Box<rustls::StreamOwned<rustls::ClientConnection, TcpStream>>),
}
impl Transport {
    fn socket(&self) -> &TcpStream {
        match self {
            Self::Plain(s) => s,
            Self::Tls(s) => &s.sock,
        }
    }
}
struct Xmpp {
    transport: Transport,
    end: Instant,
    pending: Vec<u8>,
    received: usize,
}
impl Xmpp {
    fn timeout(&self) -> Result<()> {
        let remaining = self
            .end
            .checked_duration_since(Instant::now())
            .context("deadline")?;
        self.transport.socket().set_read_timeout(Some(remaining))?;
        self.transport.socket().set_write_timeout(Some(remaining))?;
        Ok(())
    }
    fn send(&mut self, text: &str) -> Result<()> {
        self.timeout()?;
        match &mut self.transport {
            Transport::Plain(s) => {
                s.write_all(text.as_bytes())?;
                s.flush()?;
            }
            Transport::Tls(s) => {
                s.write_all(text.as_bytes())?;
                s.flush()?;
            }
        }
        Ok(())
    }
    fn next(&mut self) -> Result<Vec<u8>> {
        loop {
            self.timeout()?;
            if let Some(end) = frame_end(&self.pending)? {
                return Ok(self.pending.drain(..end).collect());
            }
            ensure!(
                self.pending.len() < LIMIT * 2 && self.received < LIMIT * 4,
                "stream size"
            );
            let mut buf = [0u8; 2048];
            let n = match &mut self.transport {
                Transport::Plain(s) => s.read(&mut buf)?,
                Transport::Tls(s) => s.read(&mut buf)?,
            };
            ensure!(n > 0, "stream EOF");
            self.received += n;
            self.pending.extend_from_slice(&buf[..n]);
        }
    }
    fn features(&mut self) -> Result<Node> {
        let opening = self.next()?;
        let mut reader = Reader::from_reader(opening.as_slice());
        loop {
            match reader.read_event()? {
                Event::Start(e) => {
                    ensure!(e.local_name().as_ref() == b"stream", "stream open");
                    break;
                }
                Event::Decl(_) => {}
                _ => bail!("stream open"),
            }
        }
        let features = stanza(&self.next()?)?;
        ensure!(
            features.name == "features" && features.ns == STREAM,
            "features"
        );
        Ok(features)
    }
    fn iq(&mut self, id: &str) -> Result<Node> {
        for _ in 0..16 {
            let node = stanza(&self.next()?)?;
            if node.name == "iq" && node.ns == CLIENT && node.attr("id") == id {
                ensure!(node.attr("type") == "result", "IQ error");
                return Ok(node);
            }
            ensure!(node.name != "error", "stream error");
        }
        bail!("unrelated stanzas")
    }
}
fn frame_end(bytes: &[u8]) -> Result<Option<usize>> {
    let mut reader = Reader::from_reader(bytes);
    let mut depth = 0usize;
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => {
                if depth == 0 && e.local_name().as_ref() == b"stream" {
                    return Ok(Some(reader.buffer_position() as usize));
                }
                depth += 1;
                ensure!(depth <= 16, "XML depth");
            }
            Ok(Event::Empty(_)) if depth == 0 => {
                return Ok(Some(reader.buffer_position() as usize))
            }
            Ok(Event::End(_)) => {
                depth = depth.checked_sub(1).context("stream end")?;
                if depth == 0 {
                    return Ok(Some(reader.buffer_position() as usize));
                }
            }
            Ok(Event::DocType(_)) => bail!("DOCTYPE forbidden"),
            Ok(Event::Eof) => return Ok(None),
            Err(quick_xml::Error::Syntax(_)) => return Ok(None),
            Err(e) => return Err(e.into()),
            _ => {}
        }
    }
}
fn esc(s: &str) -> String {
    quick_xml::escape::escape(s).into_owned()
}
fn config(r: &Request) -> Result<rustls::ClientConfig> {
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    #[cfg(feature = "synthetic-lab")]
    roots.add(rustls::pki_types::CertificateDer::from(
        B64.decode(&r.root_b64)?,
    ))?;
    #[cfg(not(feature = "synthetic-lab"))]
    let _ = r;
    Ok(rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()?
    .with_root_certificates(roots)
    .with_no_client_auth())
}
pub(crate) fn fetch(r: &Request, end: Instant, cancelled: Arc<AtomicBool>) -> Result<Vec<u8>> {
    ensure!(
        !r.endpoints.is_empty() && r.endpoints.len() <= 8 && r.password.len() <= 4096,
        "fetch config"
    );
    let mut last = None;
    for endpoint in &r.endpoints {
        ensure!(
            Instant::now() < end && !cancelled.load(Ordering::Relaxed),
            "deadline"
        );
        match fetch_endpoint(r, endpoint, end, cancelled.clone()) {
            Ok(cipher) => return Ok(cipher),
            Err(e) => last = Some(e),
        }
    }
    Err(last.context("no endpoint")?)
}
fn fetch_endpoint(
    r: &Request,
    endpoint: &Endpoint,
    end: Instant,
    cancelled: Arc<AtomicBool>,
) -> Result<Vec<u8>> {
    let address: SocketAddr = endpoint.address.parse()?;
    #[cfg(feature = "synthetic-lab")]
    ensure!(address.ip().is_loopback(), "laboratory loopback only");
    let remaining = end
        .checked_duration_since(Instant::now())
        .context("deadline")?
        .min(Duration::from_secs(2));
    let socket = TcpStream::connect_timeout(&address, remaining)?;
    socket.set_nodelay(true)?;
    let _deadline = Deadline::new(&socket, end, cancelled)?;
    let mut x = Xmpp {
        transport: Transport::Plain(socket),
        end,
        pending: Vec::new(),
        received: 0,
    };
    let opening = format!(
        "<stream:stream xmlns='jabber:client' xmlns:stream='{STREAM}' to='{}' version='1.0'>",
        esc(&r.domain)
    );
    if !endpoint.direct_tls {
        x.send(&opening)?;
        let features = x.features()?;
        ensure!(
            features
                .child("starttls", "urn:ietf:params:xml:ns:xmpp-tls")
                .is_some(),
            "STARTTLS required"
        );
        x.send("<starttls xmlns='urn:ietf:params:xml:ns:xmpp-tls'/>")?;
        let proceed = stanza(&x.next()?)?;
        ensure!(
            proceed.name == "proceed"
                && proceed.ns == "urn:ietf:params:xml:ns:xmpp-tls"
                && x.pending.iter().all(u8::is_ascii_whitespace),
            "STARTTLS rejected"
        );
        x.pending.clear();
    }
    let Transport::Plain(socket) = x.transport else {
        unreachable!()
    };
    let connection = rustls::ClientConnection::new(
        Arc::new(config(r)?),
        rustls::pki_types::ServerName::try_from(endpoint.tls_name.clone())?,
    )?;
    x.transport = Transport::Tls(Box::new(rustls::StreamOwned::new(connection, socket)));
    x.send(&opening)?;
    let features = x.features()?;
    let mechanisms = features.child("mechanisms", SASL).context("SASL")?;
    ensure!(
        mechanisms
            .children
            .iter()
            .any(|c| c.name == "mechanism" && c.ns == SASL && c.text == "PLAIN"),
        "PLAIN unavailable"
    );
    let user = r.account.split('@').next().context("user")?;
    x.send(&format!(
        "<auth xmlns='{SASL}' mechanism='PLAIN'>{}</auth>",
        B64.encode(format!("\0{user}\0{}", r.password))
    ))?;
    let auth = stanza(&x.next()?)?;
    ensure!(auth.name == "success" && auth.ns == SASL, "SASL failed");
    x.send(&opening)?;
    x.features()?;
    // An unannounced, server-assigned resource never sends presence or read markers (RFC 6121 §4).
    x.send("<iq type='set' id='nse-bind'><bind xmlns='urn:ietf:params:xml:ns:xmpp-bind'/></iq>")?;
    let bind = x.iq("nse-bind")?;
    let jid = bind
        .child("bind", "urn:ietf:params:xml:ns:xmpp-bind")
        .and_then(|b| b.child("jid", "urn:ietf:params:xml:ns:xmpp-bind"))
        .context("bind JID")?;
    ensure!(
        jid.text.split('/').next() == Some(r.account.as_str()),
        "bound account"
    );
    x.send(&format!("<iq type='set' id='nse-mam' to='{}'><query xmlns='urn:xmpp:mam:2' queryid='nse-preview'><x xmlns='jabber:x:data' type='submit'><field var='FORM_TYPE' type='hidden'><value>urn:xmpp:mam:2</value></field><field var='with'><value>{}</value></field></x><set xmlns='http://jabber.org/protocol/rsm'><max>5</max><before/></set></query></iq>", esc(&r.account), esc(&r.sender)))?;
    let mut cipher = None;
    for _ in 0..16 {
        let node = stanza(&x.next()?)?;
        if node.name == "iq" && node.ns == CLIENT && node.attr("id") == "nse-mam" {
            ensure!(
                node.attr("type") == "result" && node.child("fin", "urn:xmpp:mam:2").is_some(),
                "MAM error"
            );
            return cipher.context("last incoming OX message absent");
        }
        if let Some(ox) = archived_ox(&node, r)? {
            cipher = Some(ox);
        }
    }
    bail!("MAM incomplete")
}
fn archived_ox(node: &Node, r: &Request) -> Result<Option<Vec<u8>>> {
    if node.name != "message" || node.ns != CLIENT {
        return Ok(None);
    }
    let Some(result) = node.child("result", "urn:xmpp:mam:2") else {
        return Ok(None);
    };
    ensure!(
        result.attr("queryid") == "nse-preview" && !result.attr("id").is_empty(),
        "MAM query"
    );
    let from = node.attr("from");
    ensure!(
        from.is_empty() || from == r.account || from == r.domain,
        "archive sender"
    );
    let forwarded = result
        .child("forwarded", "urn:xmpp:forward:0")
        .context("forwarded message")?;
    let message = forwarded
        .child("message", CLIENT)
        .context("archived message")?;
    let sender = message.attr("from").split('/').next();
    let recipient = message.attr("to").split('/').next();
    if sender == Some(r.account.as_str()) && recipient == Some(r.sender.as_str()) {
        return Ok(None);
    }
    ensure!(
        sender == Some(r.sender.as_str())
            && message.attr("to").split('/').next() == Some(r.account.as_str())
            && matches!(message.attr("type"), "" | "chat" | "normal"),
        "message participants"
    );
    let Some(ox) = message.child("openpgp", "urn:xmpp:openpgp:0") else {
        return Ok(None);
    };
    ensure!(
        ox.children.is_empty() && ox.text.len() <= LIMIT * 4 / 3 + 4,
        "OX size"
    );
    Ok(Some(B64.decode(ox.text.trim())?))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn archive_envelope_is_bound_to_account_sender_and_query() {
        let mut json = serde_json::json!({"account":"bob@nse.invalid", "domain":"nse.invalid", "password":"synthetic", "endpoints":[], "sender":"alice@nse.invalid", "secret_b64":"", "peers":{}, "opt_in":true});
        #[cfg(feature = "synthetic-lab")]
        {
            json["root_b64"] = serde_json::Value::String(String::new());
        }
        #[cfg(not(feature = "synthetic-lab"))]
        let _ = &mut json;
        let r: Request = serde_json::from_value(json).unwrap();
        let valid = "<message from='bob@nse.invalid'><result xmlns='urn:xmpp:mam:2' queryid='nse-preview' id='synthetic'><forwarded xmlns='urn:xmpp:forward:0'><message xmlns='jabber:client' from='alice@nse.invalid/device' to='bob@nse.invalid/device' type='chat'><openpgp xmlns='urn:xmpp:openpgp:0'>c3ludGhldGlj</openpgp></message></forwarded></result></message>";
        assert_eq!(
            archived_ox(&stanza(valid.as_bytes()).unwrap(), &r).unwrap(),
            Some(b"synthetic".to_vec())
        );
        let outgoing = valid
            .replace(
                "from='alice@nse.invalid/device'",
                "from='bob@nse.invalid/device'",
            )
            .replace(
                "to='bob@nse.invalid/device'",
                "to='alice@nse.invalid/device'",
            );
        let non_ox = valid.replace("urn:xmpp:openpgp:0", "urn:spoofed");
        let newer = valid.replace("c3ludGhldGlj", "bmV3ZXI=");
        let mut selected = None;
        for entry in [valid, newer.as_str(), non_ox.as_str(), outgoing.as_str()] {
            if let Some(ox) = archived_ox(&stanza(entry.as_bytes()).unwrap(), &r).unwrap() {
                selected = Some(ox);
            }
        }
        assert_eq!(selected, Some(b"newer".to_vec()));
        for invalid in [
            valid.replacen("bob@nse.invalid", "mallory@nse.invalid", 1),
            valid.replace("nse-preview", "another-query"),
            valid.replace("alice@nse.invalid/device", "mallory@nse.invalid/device"),
            valid.replace(
                "to='bob@nse.invalid/device'",
                "to='other@nse.invalid/device'",
            ),
            valid.replace("type='chat'", "type='groupchat'"),
        ] {
            assert!(archived_ox(&stanza(invalid.as_bytes()).unwrap(), &r).is_err());
        }
    }
    #[test]
    fn framing_survives_chunked_utf8_and_rejects_mismatched_tags() {
        let bytes = "<message><body>é</body></message>".as_bytes();
        for end in 0..bytes.len() {
            assert_eq!(frame_end(&bytes[..end]).unwrap(), None);
        }
        assert_eq!(frame_end(bytes).unwrap(), Some(bytes.len()));
        assert!(frame_end(b"<message></presence>").is_err());
        assert!(frame_end(b"<!DOCTYPE x><message/>").is_err());
    }
}
