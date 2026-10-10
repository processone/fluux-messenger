use super::*;
use quick_xml::{encoding::EncodingError, events::Event, Reader};
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
    wire: Arc<std::sync::atomic::AtomicUsize>,
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
                self.pending.len() < LIMIT * 2 && self.received < 1024 * 1024,
                "stream size"
            );
            let mut buf = [0u8; 2048];
            let n = match &mut self.transport {
                Transport::Plain(s) => s.read(&mut buf)?,
                Transport::Tls(s) => s.read(&mut buf)?,
            };
            ensure!(n > 0, "stream EOF");
            self.received += n;
            ensure!(self.received <= 1024 * 1024, "wire budget");
            ensure!(
                self.wire.fetch_add(n, Ordering::Relaxed) + n <= 1024 * 1024,
                "invocation wire budget"
            );
            self.pending.extend_from_slice(&buf[..n]);
        }
    }
    fn features(&mut self) -> Result<Node> {
        let opening = self.next()?;
        let mut reader = Reader::from_reader(opening.as_slice());
        loop {
            match reader.read_event()? {
                Event::Start(e) => {
                    ensure!(e.local_name().as_ref() == "stream", "stream open");
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
                if depth == 0 && e.local_name().as_ref() == "stream" {
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
            // A read may stop inside a UTF-8 character; invalid complete bytes remain errors.
            Err(quick_xml::Error::Encoding(EncodingError::Utf8(_))) if matches!(std::str::from_utf8(bytes), Err(e) if e.error_len().is_none()) => {
                return Ok(None)
            }
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
pub(crate) fn fetch(r: &Request, end: Instant, cancelled: Arc<AtomicBool>) -> Result<Batch> {
    ensure!(
        !r.endpoints.is_empty() && r.endpoints.len() <= 8 && r.password.len() <= 4096,
        "fetch config"
    );
    let mut last = None;
    let wire = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    for endpoint in &r.endpoints {
        ensure!(
            Instant::now() < end && !cancelled.load(Ordering::Relaxed),
            "deadline"
        );
        match fetch_endpoint(r, endpoint, end, cancelled.clone(), wire.clone()) {
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
    wire: Arc<std::sync::atomic::AtomicUsize>,
) -> Result<Batch> {
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
        wire,
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
    fetch_pages(&mut x, r)
}
pub(crate) struct Archived {
    pub uid: String,
    pub id: String,
    pub origin_id: Option<String>,
    pub replace: Option<String>,
    pub cipher: Option<Vec<u8>>,
}
pub(crate) struct Batch {
    pub entries: Vec<Archived>,
    pub complete: bool,
}
fn fetch_pages(x: &mut Xmpp, r: &Request) -> Result<Batch> {
    let start = chrono::DateTime::parse_from_rfc3339(&r.window_start)?;
    let end = chrono::DateTime::parse_from_rfc3339(&r.window_end)?;
    ensure!(
        start <= end && end.signed_duration_since(start).num_seconds() <= 72 * 3600,
        "eligibility window"
    );
    let mut before = String::new();
    let mut pages = Vec::new();
    let mut identities = std::collections::HashSet::new();
    let mut attempts = 0;
    ensure!(
        r.known_ids.len() <= 4096
            && r.known_ids.iter().all(|id| xml::valid_id(id))
            && serde_json::to_vec(&r.known_ids)?.len() <= 256 * 1024,
        "known ID budget"
    );
    let known: std::collections::HashSet<_> = r.known_ids.iter().collect();
    for page in 0..5 {
        let id = format!("nse-mam-{page}");
        let query = format!("nse-preview-{page}");
        x.send(&format!("<iq type='set' id='{id}' to='{}'><query xmlns='urn:xmpp:mam:2' queryid='{query}'><x xmlns='jabber:x:data' type='submit'><field var='FORM_TYPE' type='hidden'><value>urn:xmpp:mam:2</value></field><field var='with'><value>{}</value></field><field var='start'><value>{}</value></field><field var='end'><value>{}</value></field></x><set xmlns='http://jabber.org/protocol/rsm'><max>20</max><before>{}</before></set></query></iq>", esc(&r.account), esc(&r.sender), esc(&r.window_start), esc(&r.window_end), esc(&before)))?;
        let mut entries = Vec::new();
        let mut scanned = 0;
        let mut finished = None;
        // Results, stream chatter and unexpected stanzas all consume this bound.
        for _ in 0..40 {
            let node = stanza(&x.next()?)?;
            if node.name == "iq" && node.ns == CLIENT && node.attr("id") == id {
                ensure!(
                    node.attr("type") == "result" && archive_from(&node, r),
                    "MAM error/authority"
                );
                let fin = node.child("fin", "urn:xmpp:mam:2").context("MAM fin")?;
                let complete = matches!(fin.attr("complete"), "true" | "1");
                let first = fin
                    .child("set", "http://jabber.org/protocol/rsm")
                    .and_then(|set| set.child("first", "http://jabber.org/protocol/rsm"))
                    .map(|v| v.text.clone())
                    .unwrap_or_default();
                finished = Some((complete, first));
                break;
            }
            if node.child("result", "urn:xmpp:mam:2").is_some() {
                scanned += 1;
                ensure!(scanned <= 20, "page size");
            }
            if let Some(entry) = archived_ox(&node, r, &query)? {
                ensure!(
                    identities.insert(entry.uid.clone()),
                    "repeated archive identity"
                );
                if !known.contains(&entry.uid) {
                    attempts += 1;
                }
                ensure!(attempts <= 20, "classification budget");
                entries.push(entry);
            }
        }
        let (complete, first) = finished.context("MAM incomplete")?;
        pages.push(entries);
        if complete {
            return Ok(Batch {
                entries: pages.into_iter().rev().flatten().collect(),
                complete: true,
            });
        }
        ensure!(
            xml::valid_id(&first) && first != before && scanned > 0,
            "pagination stalled"
        );
        before = first;
    }
    Ok(Batch {
        entries: Vec::new(),
        complete: false,
    })
}
fn archive_from(node: &Node, r: &Request) -> bool {
    // The query is addressed to this account's personal archive. A different
    // archive cannot supply client_ids for this ledger (XEP-0313 / XEP-0359).
    node.attr("from").is_empty() || node.attr("from") == r.account
}
fn archived_ox(node: &Node, r: &Request, query: &str) -> Result<Option<Archived>> {
    if node.name != "message" || node.ns != CLIENT {
        return Ok(None);
    }
    let Some(result) = node.child("result", "urn:xmpp:mam:2") else {
        return Ok(None);
    };
    ensure!(
        result.attr("queryid") == query && xml::valid_id(result.attr("id")),
        "MAM query"
    );
    ensure!(archive_from(node, r), "archive sender");
    let forwarded = result
        .child("forwarded", "urn:xmpp:forward:0")
        .context("forwarded message")?;
    let delay = forwarded
        .child("delay", "urn:xmpp:delay")
        .context("archive eligibility time")?;
    let stamp = chrono::DateTime::parse_from_rfc3339(delay.attr("stamp"))?;
    ensure!(
        stamp >= chrono::DateTime::parse_from_rfc3339(&r.window_start)?
            && stamp <= chrono::DateTime::parse_from_rfc3339(&r.window_end)?,
        "outside eligibility window"
    );
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
            && recipient == Some(r.account.as_str())
            && matches!(message.attr("type"), "" | "chat" | "normal"),
        "message participants"
    );
    let id = message.attr("id").to_owned();
    let origin_id = message
        .children
        .iter()
        .find(|child| {
            child.ns == "urn:xmpp:sid:0"
                && child.name == "origin-id"
                && xml::valid_id(child.attr("id"))
        })
        .map(|child| child.attr("id").to_owned());
    let replacements: Vec<_> = message
        .children
        .iter()
        .filter(|c| c.name == "replace")
        .collect();
    ensure!(
        replacements.len() <= 1
            && replacements
                .iter()
                .all(|c| c.ns == "urn:xmpp:message-correct:0"
                    && c.children.is_empty()
                    && xml::valid_id(c.attr("id"))),
        "outer correction"
    );
    let replace = replacements.first().map(|c| c.attr("id").into());
    let cipher = if let Some(ox) = message.child("openpgp", "urn:xmpp:openpgp:0") {
        ensure!(
            message
                .children
                .iter()
                .filter(|c| c.name == "openpgp" && c.ns == ox.ns)
                .count()
                == 1
                && ox.children.is_empty()
                && ox.text.len() <= LIMIT * 4 / 3 + 4,
            "OX size"
        );
        Some(B64.decode(ox.text.trim())?)
    } else {
        None
    };
    Ok(Some(Archived {
        uid: crate::identity::personal_archive_id(Some(result.attr("id")), None, None, &r.account)
            .into(),
        id,
        origin_id,
        replace,
        cipher,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request() -> Request {
        let mut json = serde_json::json!({"account":"bob@nse.invalid", "domain":"nse.invalid", "password":"synthetic", "endpoints":[], "sender":"alice@nse.invalid", "secret_b64":"", "peers":{}, "opt_in":true,"window_start":"2026-10-10T00:00:00Z","window_end":"2026-10-10T01:00:00Z"});
        #[cfg(feature = "synthetic-lab")]
        {
            json["root_b64"] = serde_json::Value::String(String::new());
        }
        #[cfg(not(feature = "synthetic-lab"))]
        let _ = &mut json;
        serde_json::from_value(json).unwrap()
    }
    fn entry(uid: &str, page: usize) -> String {
        format!("<message from='bob@nse.invalid'><result xmlns='urn:xmpp:mam:2' queryid='nse-preview-{page}' id='{uid}'><forwarded xmlns='urn:xmpp:forward:0'><delay xmlns='urn:xmpp:delay' stamp='2026-10-10T00:30:00Z'/><message xmlns='jabber:client' id='{uid}' from='alice@nse.invalid/device' to='bob@nse.invalid/device'><openpgp xmlns='urn:xmpp:openpgp:0'>c3ludGhldGlj</openpgp><stanza-id xmlns='urn:xmpp:sid:0' by='mallory@nse.invalid' id='foreign'/></message></forwarded></result></message>")
    }
    fn pages(responses: Vec<String>) -> Result<Batch> {
        pages_known(responses, Vec::new())
    }
    fn pages_known(responses: Vec<String>, known: Vec<String>) -> Result<Batch> {
        let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
        let addr = listener.local_addr()?;
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            for (page, response) in responses.into_iter().enumerate() {
                let mut query = Vec::new();
                loop {
                    let mut byte = [0u8];
                    if stream.read_exact(&mut byte).is_err() {
                        return;
                    }
                    query.push(byte[0]);
                    if query.ends_with(b"</iq>") {
                        break;
                    }
                }
                let query = String::from_utf8(query).unwrap();
                assert!(query.contains("<max>20</max>"));
                assert!(query.contains("var='start'") && query.contains("var='end'"));
                if page > 0 {
                    assert!(!query.contains("<before></before>"));
                }
                stream.write_all(response.as_bytes()).unwrap();
            }
        });
        let mut x = Xmpp {
            transport: Transport::Plain(TcpStream::connect(addr)?),
            end: Instant::now() + Duration::from_secs(2),
            pending: Vec::new(),
            received: 0,
            wire: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
        };
        let mut r = request();
        r.known_ids = known;
        let result = fetch_pages(&mut x, &r);
        drop(x);
        server.join().unwrap();
        result
    }
    fn fin(page: usize, complete: bool) -> String {
        format!("<iq type='result' from='bob@nse.invalid' id='nse-mam-{page}'><fin xmlns='urn:xmpp:mam:2' complete='{complete}'><set xmlns='http://jabber.org/protocol/rsm'><first>opaque-z</first></set></fin></iq>")
    }
    #[test]
    fn bounded_pages_preserve_server_order_and_foreign_client_ids_are_excluded() {
        let batch = pages(vec![
            entry("three", 0) + &fin(0, false),
            entry("one", 1) + &entry("two", 1) + &fin(1, true),
        ])
        .unwrap();
        assert!(batch.complete);
        assert_eq!(
            batch
                .entries
                .iter()
                .map(|e| e.uid.as_str())
                .collect::<Vec<_>>(),
            vec!["one", "two", "three"]
        );
        assert!(batch
            .entries
            .iter()
            .all(|e| e.id != "foreign" && e.origin_id.as_deref() != Some("foreign")));
        assert!(
            pages(vec![
                entry("one", 0) + &fin(0, false),
                entry("two", 1) + &fin(1, false)
            ])
            .is_err(),
            "repeated continuation token is incomplete"
        );
        assert!(
            pages(vec![
                entry("one", 0) + &fin(0, false),
                entry("one", 1) + &fin(1, true)
            ])
            .is_err(),
            "repeated result ID is incomplete"
        );
        assert!(
            pages(vec![
                (0..21)
                    .map(|n| entry(&format!("{n}"), 0))
                    .collect::<String>()
                    + &fin(0, true)
            ])
            .is_err(),
            "classification budget is absolute"
        );
        assert!(
            pages(vec![
                entry("one", 0).replace("2026-10-10T00:30:00Z", "2026-10-09T00:00:00Z")
                    + &fin(0, true)
            ])
            .is_err(),
            "activation/window boundary uses archive delay"
        );
        let empty = pages(vec![fin(0, true)]).unwrap();
        assert!(
            empty.complete && empty.entries.is_empty(),
            "archive visibility/transient absence cannot identify the push"
        );
    }
    #[test]
    fn handled_ids_do_not_spend_the_decryption_budget_but_scan_bound_still_applies() {
        let responses = (0..5)
            .map(|page| {
                (0..20)
                    .map(|n| entry(&format!("id-{}", page * 20 + n), page))
                    .collect::<String>()
                    + &fin(page, page == 4).replace("opaque-z", &format!("opaque-{page}"))
            })
            .collect::<Vec<_>>();
        let known = (0..99).map(|n| format!("id-{n}")).collect::<Vec<_>>();
        let batch = pages_known(responses.clone(), known.clone()).unwrap();
        assert!(batch.complete);
        assert_eq!(batch.entries.len(), 100);
        assert_eq!(
            batch
                .entries
                .iter()
                .filter(|e| !known.contains(&e.uid))
                .count(),
            1
        );
        assert!(
            pages(responses).is_err(),
            "unhandled entries still spend twenty attempts across pages"
        );
        let incomplete = (0..5)
            .map(|page| {
                (0..20)
                    .map(|n| entry(&format!("id-{}", page * 20 + n), page))
                    .collect::<String>()
                    + &fin(page, false).replace("opaque-z", &format!("opaque-{page}"))
            })
            .collect::<Vec<_>>();
        let batch = pages_known(incomplete, (0..100).map(|n| format!("id-{n}")).collect()).unwrap();
        assert!(
            !batch.complete && batch.entries.is_empty(),
            "the hundred-entry scan never claims complete coverage"
        );
    }
    #[test]
    fn archive_envelope_is_bound_to_account_sender_and_query() {
        let mut json = serde_json::json!({"account":"bob@nse.invalid", "domain":"nse.invalid", "password":"synthetic", "endpoints":[], "sender":"alice@nse.invalid", "secret_b64":"", "peers":{}, "opt_in":true,"window_start":"2026-10-10T00:00:00Z","window_end":"2026-10-10T01:00:00Z"});
        #[cfg(feature = "synthetic-lab")]
        {
            json["root_b64"] = serde_json::Value::String(String::new());
        }
        #[cfg(not(feature = "synthetic-lab"))]
        let _ = &mut json;
        let r: Request = serde_json::from_value(json).unwrap();
        let valid = "<message from='bob@nse.invalid'><result xmlns='urn:xmpp:mam:2' queryid='nse-preview' id='synthetic'><forwarded xmlns='urn:xmpp:forward:0'><delay xmlns='urn:xmpp:delay' stamp='2026-10-10T00:30:00Z'/><message xmlns='jabber:client' from='alice@nse.invalid/device' to='bob@nse.invalid/device' type='chat'><openpgp xmlns='urn:xmpp:openpgp:0'>c3ludGhldGlj</openpgp></message></forwarded></result></message>";
        assert_eq!(
            archived_ox(&stanza(valid.as_bytes()).unwrap(), &r, "nse-preview")
                .unwrap()
                .unwrap()
                .cipher,
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
            if let Some(ox) =
                archived_ox(&stanza(entry.as_bytes()).unwrap(), &r, "nse-preview").unwrap()
            {
                if let Some(cipher) = ox.cipher {
                    selected = Some(cipher);
                }
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
            assert!(archived_ox(&stanza(invalid.as_bytes()).unwrap(), &r, "nse-preview").is_err());
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
        assert!(frame_end(b"<message>\xff</message>").is_err());
        assert!(frame_end(b"<message>\xff").is_err());
    }
}
