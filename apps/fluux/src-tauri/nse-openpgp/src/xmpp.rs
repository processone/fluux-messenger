use super::*;
use quick_xml::{encoding::EncodingError, events::Event, Reader};
use std::{
    io::{Read, Write},
    net::{Shutdown, SocketAddr, TcpStream},
    sync::mpsc,
};
use xml::{stanza, Node};
mod sasl;
use sasl::Purpose;
pub use sasl::{FastToken, FastUnavailable, Refused};
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
/// Fetches the archive window; a FAST token issued while signing in is left in `issued`
/// whatever the outcome, since the server has already rotated it.
pub(crate) fn fetch(
    r: &Request,
    end: Instant,
    cancelled: Arc<AtomicBool>,
    issued: &mut Option<FastToken>,
) -> Result<Batch> {
    each_endpoint(r, end, cancelled, Purpose::Session, issued, fetch_settled)
}
/// Signs in with the password only and returns the FAST token the server issues for the
/// extension's user agent.
pub(crate) fn provision(
    r: &Request,
    end: Instant,
    cancelled: Arc<AtomicBool>,
) -> Result<FastToken> {
    ensure!(
        !r.password.is_empty() && r.fast_token.is_empty(),
        "provision config"
    );
    let mut issued = None;
    each_endpoint(r, end, cancelled, Purpose::Session, &mut issued, |_, _| {
        Ok(())
    })?;
    issued.context("no token issued")
}
/// Has the server drop the extension's FAST token; it issues no successor (XEP-0484 §6).
pub(crate) fn invalidate(r: &Request, end: Instant, cancelled: Arc<AtomicBool>) -> Result<()> {
    ensure!(
        r.password.is_empty() && !r.fast_token.is_empty(),
        "invalidate config"
    );
    each_endpoint(r, end, cancelled, Purpose::Invalidate, &mut None, |_, _| {
        Ok(())
    })
}
fn each_endpoint<T>(
    r: &Request,
    end: Instant,
    cancelled: Arc<AtomicBool>,
    purpose: Purpose,
    issued: &mut Option<FastToken>,
    then: fn(&mut Xmpp, &Request) -> Result<T>,
) -> Result<T> {
    ensure!(
        !r.endpoints.is_empty()
            && r.endpoints.len() <= 8
            && r.password.len() <= 4096
            && r.user_agent_id.len() <= 64,
        "fetch config"
    );
    let wire = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    // Endpoints offering FAST come first, so a stored token is used and renewed; a session
    // falls back to the plain sign-in only when no endpoint offers FAST (XEP-0484).
    let mut last = None;
    for fast_only in [true, false] {
        if !fast_only
            && (purpose != Purpose::Session
                || !last
                    .as_ref()
                    .is_some_and(|e: &anyhow::Error| e.is::<FastUnavailable>()))
        {
            break;
        }
        let mut fast_unavailable = false;
        for endpoint in &r.endpoints {
            ensure!(
                Instant::now() < end && !cancelled.load(Ordering::Relaxed),
                "deadline"
            );
            match on_endpoint(
                r,
                endpoint,
                end,
                cancelled.clone(),
                wire.clone(),
                (purpose, fast_only, &mut *issued),
                then,
            ) {
                Ok(value) => return Ok(value),
                // Every endpoint serves the same account, so neither answer changes on another one.
                Err(e) if e.is::<ArchiveUnavailable>() || e.is::<Refused>() => return Err(e),
                Err(e) => {
                    fast_unavailable |= e.is::<FastUnavailable>();
                    last = Some(e);
                }
            }
        }
        if fast_unavailable {
            last = Some(FastUnavailable.into());
        }
    }
    Err(last.context("no endpoint")?)
}
fn on_endpoint<T>(
    r: &Request,
    endpoint: &Endpoint,
    end: Instant,
    cancelled: Arc<AtomicBool>,
    wire: Arc<std::sync::atomic::AtomicUsize>,
    (purpose, fast_only, issued): (Purpose, bool, &mut Option<FastToken>),
    then: fn(&mut Xmpp, &Request) -> Result<T>,
) -> Result<T> {
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
    // ejabberd offers SASL2 only on a stream that names its sender; that is sent under TLS only (RFC 6120 §4.7.1).
    let secured = opening.replacen(
        " version=",
        &format!(" from='{}' version=", esc(&r.account)),
        1,
    );
    x.send(&secured)?;
    let features = x.features()?;
    sasl::sign_in(&mut x, r, &features, &secured, (purpose, fast_only), issued)?;
    then(&mut x, r)
}
/// Delays before re-querying an archive that holds nothing new yet.
const SETTLE_DELAYS: [Duration; 3] = [
    Duration::from_millis(600),
    Duration::from_millis(1000),
    Duration::from_millis(1600),
];
/// Time a re-query must leave for decryption and delivery before the deadline.
const SETTLE_RESERVE: Duration = Duration::from_millis(1500);
/// How far before the window end an unhandled entry counts as the pushed message.
/// The window ends a few seconds past the push, so this spans that slack too.
const SETTLE_RECENT_SECS: i64 = 25;
/// A server can send the push before its archive write commits, so a query made
/// right away misses the pushed message. Re-query until an unhandled entry from
/// just before the push appears; older unhandled entries do not stand in for it.
fn fetch_settled(x: &mut Xmpp, r: &Request) -> Result<Batch> {
    let recent = chrono::DateTime::parse_from_rfc3339(&r.window_end)?
        - chrono::Duration::seconds(SETTLE_RECENT_SECS);
    let mut batch = fetch_pages(x, r)?;
    for delay in SETTLE_DELAYS {
        let settled = !batch.complete
            || batch
                .entries
                .iter()
                .any(|e| e.stamp >= recent && !r.known_ids.contains(&e.uid));
        if settled || Instant::now() + delay + SETTLE_RESERVE > x.end {
            break;
        }
        std::thread::sleep(delay);
        batch = fetch_pages(x, r)?;
    }
    Ok(batch)
}
pub(crate) struct Archived {
    pub uid: String,
    pub id: String,
    pub origin_id: Option<String>,
    pub replace: Option<String>,
    pub cipher: Option<Vec<u8>>,
    pub plaintext: Option<String>,
    pub stamp: chrono::DateTime<chrono::FixedOffset>,
}
/// The account's server answered the archive query with a definitive refusal:
/// it has no XEP-0313 archive to fetch from.
#[derive(Debug)]
pub(crate) struct ArchiveUnavailable;
impl std::fmt::Display for ArchiveUnavailable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("archive unavailable")
    }
}
impl std::error::Error for ArchiveUnavailable {}
fn archive_missing(iq: &Node) -> bool {
    iq.child("error", CLIENT).is_some_and(|error| {
        error.children.iter().any(|c| {
            c.ns == "urn:ietf:params:xml:ns:xmpp-stanzas"
                && matches!(
                    c.name.as_str(),
                    "feature-not-implemented" | "service-unavailable"
                )
        })
    })
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
                if node.attr("type") == "error" && archive_from(&node, r) && archive_missing(&node)
                {
                    return Err(ArchiveUnavailable.into());
                }
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
/// Namespaces that make a body an encryption fallback (including XEP-0380) or a
/// mutation of another message, rather than the message's own content. A XEP-0428
/// fallback marker alone is not one: replies use it for their quote, and every
/// mutation that carries a fallback body also carries its own element.
const CONTENT_MARKERS: &[&str] = &[
    "urn:xmpp:openpgp:0",
    "eu.siacs.conversations.axolotl",
    "urn:xmpp:omemo:2",
    "jabber:x:encrypted",
    "urn:xmpp:eme:0",
    "urn:xmpp:message-retract:0",
    "urn:xmpp:message-retract:1",
    "urn:xmpp:message-moderate:0",
    "urn:xmpp:message-moderate:1",
    "urn:xmpp:fasten:0",
    "urn:xmpp:reactions:0",
    "urn:xmpp:message-correct:0",
];
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
    let marked = message
        .children
        .iter()
        .any(|c| CONTENT_MARKERS.contains(&c.ns.as_str()));
    let plaintext = message
        .child("body", CLIENT)
        .map(|body| body.text.clone())
        .filter(|body| {
            cipher.is_none() && !marked && !body.trim().is_empty() && body.len() <= LIMIT
        });
    Ok(Some(Archived {
        uid: crate::identity::personal_archive_id(Some(result.attr("id")), None, None, &r.account)
            .into(),
        id,
        origin_id,
        replace,
        cipher,
        plaintext,
        stamp,
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
        entry_at(uid, page, "2026-10-10T00:30:00Z")
    }
    fn entry_at(uid: &str, page: usize, stamp: &str) -> String {
        format!("<message from='bob@nse.invalid'><result xmlns='urn:xmpp:mam:2' queryid='nse-preview-{page}' id='{uid}'><forwarded xmlns='urn:xmpp:forward:0'><delay xmlns='urn:xmpp:delay' stamp='{stamp}'/><message xmlns='jabber:client' id='{uid}' from='alice@nse.invalid/device' to='bob@nse.invalid/device'><openpgp xmlns='urn:xmpp:openpgp:0'>c3ludGhldGlj</openpgp><stanza-id xmlns='urn:xmpp:sid:0' by='mallory@nse.invalid' id='foreign'/></message></forwarded></result></message>")
    }
    fn pages(responses: Vec<String>) -> Result<Batch> {
        pages_known(responses, Vec::new())
    }
    fn pages_known(responses: Vec<String>, known: Vec<String>) -> Result<Batch> {
        serve(responses, known, Duration::from_secs(2), fetch_pages, true)
    }
    fn serve(
        responses: Vec<String>,
        known: Vec<String>,
        budget: Duration,
        fetch: fn(&mut Xmpp, &Request) -> Result<Batch>,
        paged: bool,
    ) -> Result<Batch> {
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
                if page > 0 && paged {
                    assert!(!query.contains("<before></before>"));
                }
                stream.write_all(response.as_bytes()).unwrap();
            }
        });
        let mut x = Xmpp {
            transport: Transport::Plain(TcpStream::connect(addr)?),
            end: Instant::now() + budget,
            pending: Vec::new(),
            received: 0,
            wire: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
        };
        let mut r = request();
        r.known_ids = known;
        let result = fetch(&mut x, &r);
        drop(x);
        server.join().unwrap();
        result
    }
    fn fin(page: usize, complete: bool) -> String {
        format!("<iq type='result' from='bob@nse.invalid' id='nse-mam-{page}'><fin xmlns='urn:xmpp:mam:2' complete='{complete}'><set xmlns='http://jabber.org/protocol/rsm'><first>opaque-z</first></set></fin></iq>")
    }
    #[test]
    fn an_archive_without_the_pushed_message_is_queried_again() {
        let batch = serve(
            vec![
                fin(0, true),
                entry_at("late", 0, "2026-10-10T00:59:58Z") + &fin(0, true),
            ],
            Vec::new(),
            Duration::from_secs(5),
            fetch_settled,
            false,
        )
        .unwrap();
        assert_eq!(
            batch
                .entries
                .iter()
                .map(|e| e.uid.as_str())
                .collect::<Vec<_>>(),
            vec!["late"]
        );
    }
    #[test]
    fn handled_or_older_entries_do_not_settle_the_query() {
        let recent = |uid| entry_at(uid, 0, "2026-10-10T00:59:50Z");
        let batch = serve(
            vec![
                entry("older", 0) + &recent("seen") + &fin(0, true),
                entry("older", 0) + &recent("seen") + &recent("new") + &fin(0, true),
            ],
            vec!["seen".into()],
            Duration::from_secs(5),
            fetch_settled,
            false,
        )
        .unwrap();
        assert!(batch.entries.iter().any(|e| e.uid == "new"));
    }
    #[test]
    fn re_queries_stop_when_the_deadline_leaves_no_room() {
        let start = Instant::now();
        let batch = serve(
            vec![fin(0, true)],
            Vec::new(),
            Duration::from_secs(2),
            fetch_settled,
            false,
        )
        .unwrap();
        assert!(batch.entries.is_empty() && batch.complete);
        assert!(start.elapsed() < Duration::from_millis(500));
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
    fn a_server_without_archive_is_reported_as_such() {
        let error = |condition: &str, from: &str| {
            format!("<iq type='error' from='{from}' id='nse-mam-0'><error type='cancel'><{condition} xmlns='urn:ietf:params:xml:ns:xmpp-stanzas'/></error></iq>")
        };
        for condition in ["feature-not-implemented", "service-unavailable"] {
            let err = pages(vec![error(condition, "bob@nse.invalid")])
                .err()
                .unwrap();
            assert!(
                err.downcast_ref::<ArchiveUnavailable>().is_some(),
                "{condition}"
            );
        }
        for response in [
            error("internal-server-error", "bob@nse.invalid"),
            error("feature-not-implemented", "mallory@nse.invalid"),
        ] {
            let err = pages(vec![response]).err().unwrap();
            assert!(err.downcast_ref::<ArchiveUnavailable>().is_none());
        }
    }
    #[test]
    fn only_an_unmarked_body_is_plaintext() {
        let r = request();
        let entry = |payload: &str| {
            format!("<message from='bob@nse.invalid'><result xmlns='urn:xmpp:mam:2' queryid='nse-preview' id='synthetic'><forwarded xmlns='urn:xmpp:forward:0'><delay xmlns='urn:xmpp:delay' stamp='2026-10-10T00:30:00Z'/><message xmlns='jabber:client' from='alice@nse.invalid/device' to='bob@nse.invalid/device' type='chat'>{payload}</message></forwarded></result></message>")
        };
        let plaintext = |payload: &str| {
            archived_ox(
                &stanza(entry(payload).as_bytes()).unwrap(),
                &r,
                "nse-preview",
            )
            .unwrap()
            .unwrap()
            .plaintext
        };
        assert_eq!(
            plaintext("<body>hello</body><active xmlns='http://jabber.org/protocol/chatstates'/><origin-id xmlns='urn:xmpp:sid:0' id='o1'/>"),
            Some("hello".into())
        );
        assert_eq!(
            plaintext("<body>&gt; quoted\nreply</body><reply xmlns='urn:xmpp:reply:0' id='target'/><fallback xmlns='urn:xmpp:fallback:0' for='urn:xmpp:reply:0'><body start='0' end='9'/></fallback>"),
            Some("> quoted\nreply".into()),
            "a reply keeps its quote"
        );
        for payload in [
            "",
            "<body> </body>",
            "<active xmlns='http://jabber.org/protocol/chatstates'/>",
            "<body xmlns='urn:spoofed'>hello</body>",
            "<body>fallback</body><openpgp xmlns='urn:xmpp:openpgp:0'>c3ludGhldGlj</openpgp>",
            "<body>fallback</body><encrypted xmlns='eu.siacs.conversations.axolotl'/>",
            "<body>fallback</body><encrypted xmlns='urn:xmpp:omemo:2'/>",
            "<body>fallback</body><x xmlns='jabber:x:encrypted'>c3ludGhldGlj</x>",
            "<body>fallback</body><encryption xmlns='urn:xmpp:eme:0' namespace='urn:unknown'/>",
            "<body>fallback</body><retract xmlns='urn:xmpp:message-retract:1' id='target'/><fallback xmlns='urn:xmpp:fallback:0' for='urn:xmpp:message-retract:1'/>",
            "<body>fallback</body><moderated xmlns='urn:xmpp:message-moderate:1'/>",
            "<body>fallback</body><retract xmlns='urn:xmpp:message-retract:1' id='target'/>",
            "<body>fallback</body><retract xmlns='urn:xmpp:message-retract:0' id='target'/>",
            "<body>fallback</body><apply-to xmlns='urn:xmpp:fasten:0' id='target'/>",
            "<body>fallback</body><reactions xmlns='urn:xmpp:reactions:0' id='target'/>",
        ] {
            assert_eq!(plaintext(payload), None, "{payload}");
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
