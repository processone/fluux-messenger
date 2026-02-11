use std::borrow::Cow;
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::RwLock;
use tokio::task::JoinHandle;
use tokio_tungstenite::{accept_async, tungstenite::Message};
use futures_util::{SinkExt, StreamExt};
use quick_xml::events::Event;
use quick_xml::Reader;
use tokio_rustls::rustls::pki_types::ServerName;
use tokio_rustls::rustls::{ClientConfig, RootCertStore};
use tokio_rustls::TlsConnector;
use serde::Serialize;
use tracing::{debug, error, info, warn};
use trust_dns_resolver::TokioAsyncResolver;
use trust_dns_resolver::config::*;

/// Initialize rustls crypto provider (must be called once at startup)
fn init_crypto_provider() {
    use std::sync::Once;
    static INIT: Once = Once::new();

    INIT.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

/// Connection mode for XMPP proxy
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionMode {
    /// Plain TCP connection on port 5222 (may upgrade to TLS via STARTTLS)
    Tcp,
    /// Direct TLS connection on port 5223
    DirectTls,
}

/// Resolved XMPP server endpoint from SRV records or fallback
#[derive(Debug, Clone)]
struct XmppEndpoint {
    host: String,
    port: u16,
    mode: ConnectionMode,
}

/// Result of parsing the server input string.
#[derive(Debug, Clone, PartialEq)]
enum ParsedServer {
    /// Explicit endpoint — skip SRV, connect directly
    Direct(String, u16, ConnectionMode),
    /// Domain only — perform SRV resolution
    Domain(String),
}

/// Parse the server input string into either an explicit endpoint or a domain for SRV resolution.
///
/// Supported formats:
/// - `tls://host:port` → Direct TLS connection
/// - `tls://host`      → Direct TLS on port 5223
/// - `tcp://host:port` → STARTTLS connection
/// - `tcp://host`      → STARTTLS on port 5222
/// - `host:port`       → Direct connection (port 5223 = TLS, otherwise STARTTLS)
/// - `domain`          → SRV resolution
fn parse_server_input(server: &str) -> ParsedServer {
    let trimmed = server.trim();

    // tls:// scheme
    if let Some(rest) = trimmed.strip_prefix("tls://") {
        if let Some((host, port_str)) = rest.rsplit_once(':') {
            if let Ok(port) = port_str.parse::<u16>() {
                return ParsedServer::Direct(host.to_string(), port, ConnectionMode::DirectTls);
            }
        }
        // No port specified — default to 5223
        return ParsedServer::Direct(rest.to_string(), 5223, ConnectionMode::DirectTls);
    }

    // tcp:// scheme
    if let Some(rest) = trimmed.strip_prefix("tcp://") {
        if let Some((host, port_str)) = rest.rsplit_once(':') {
            if let Ok(port) = port_str.parse::<u16>() {
                return ParsedServer::Direct(host.to_string(), port, ConnectionMode::Tcp);
            }
        }
        // No port specified — default to 5222
        return ParsedServer::Direct(rest.to_string(), 5222, ConnectionMode::Tcp);
    }

    // host:port (no scheme) — use rsplit_once to handle IPv6 addresses
    if let Some((host, port_str)) = trimmed.rsplit_once(':') {
        if let Ok(port) = port_str.parse::<u16>() {
            let mode = if port == 5223 { ConnectionMode::DirectTls } else { ConnectionMode::Tcp };
            return ParsedServer::Direct(host.to_string(), port, mode);
        }
    }

    // Bare domain — SRV resolution
    ParsedServer::Domain(trimmed.to_string())
}

/// Resolve XMPP server using SRV records (RFC 6120)
/// Tries in order:
/// 1. _xmpps-client._tcp.{domain} (direct TLS, typically port 5223)
/// 2. _xmpp-client._tcp.{domain} (STARTTLS, typically port 5222)
/// 3. Fallback to domain:5222 with STARTTLS (standard XMPP client port per RFC 6120)
async fn resolve_xmpp_server(domain: &str) -> Result<XmppEndpoint, String> {
    let resolver = TokioAsyncResolver::tokio(
        ResolverConfig::default(),
        ResolverOpts::default()
    );

    // Try direct TLS SRV first
    let srv_name = format!("_xmpps-client._tcp.{}", domain);
    if let Ok(lookup) = resolver.srv_lookup(&srv_name).await {
        if let Some(srv) = lookup.iter().next() {
            info!(domain, host = %srv.target(), port = srv.port(), "SRV resolved (direct TLS)");
            return Ok(XmppEndpoint {
                host: srv.target().to_string().trim_end_matches('.').to_string(),
                port: srv.port(),
                mode: ConnectionMode::DirectTls,
            });
        }
    }

    // Try STARTTLS SRV
    let srv_name = format!("_xmpp-client._tcp.{}", domain);
    if let Ok(lookup) = resolver.srv_lookup(&srv_name).await {
        if let Some(srv) = lookup.iter().next() {
            info!(domain, host = %srv.target(), port = srv.port(), "SRV resolved (STARTTLS)");
            return Ok(XmppEndpoint {
                host: srv.target().to_string().trim_end_matches('.').to_string(),
                port: srv.port(),
                mode: ConnectionMode::Tcp,
            });
        }
    }

    // Fallback to direct connection on standard XMPP client port (RFC 6120)
    info!(domain, "No SRV records found, using fallback: {}:5222 (STARTTLS)", domain);
    Ok(XmppEndpoint {
        host: domain.to_string(),
        port: 5222,
        mode: ConnectionMode::Tcp,
    })
}

/// Create a TLS connector using the system's native root certificates.
///
/// Used by both `DirectTls` connections and `STARTTLS` upgrades to avoid
/// duplicating the TLS setup logic.
fn create_tls_connector() -> Result<TlsConnector, String> {
    let mut root_store = RootCertStore::empty();
    let native_certs = rustls_native_certs::load_native_certs();
    for cert in native_certs.certs {
        root_store.add(cert).map_err(|e| format!("Failed to add cert: {}", e))?;
    }

    let config = ClientConfig::builder()
        .with_root_certificates(root_store)
        .with_no_client_auth();

    Ok(TlsConnector::from(Arc::new(config)))
}

/// Upgrade a TCP stream to TLS using the given host for SNI.
async fn upgrade_to_tls(
    tcp_stream: TcpStream,
    host: &str,
) -> Result<tokio_rustls::client::TlsStream<TcpStream>, String> {
    let connector = create_tls_connector()?;
    let server_name = ServerName::try_from(host.to_string())
        .map_err(|e| format!("Invalid server name: {}", e))?;

    connector.connect(server_name, tcp_stream)
        .await
        .map_err(|e| format!("TLS handshake failed: {}", e))
}

/// RAII guard that decrements the connection counter when dropped.
/// Ensures cleanup even if the connection handler panics or returns early.
struct ConnectionGuard {
    counter: Arc<AtomicUsize>,
}

impl ConnectionGuard {
    fn new(counter: Arc<AtomicUsize>) -> Self {
        Self { counter }
    }
}

impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        let prev = self.counter.fetch_sub(1, Ordering::SeqCst);
        info!(active = prev - 1, "Connection closed");
    }
}

/// Result of starting the XMPP proxy, returned to the frontend
#[derive(Debug, Clone, Serialize)]
pub struct ProxyStartResult {
    /// Local WebSocket URL to connect to (e.g., "ws://127.0.0.1:12345")
    pub url: String,
    /// Connection method used: "tls" for direct TLS, "starttls" for STARTTLS upgrade
    pub connection_method: String,
}

/// XMPP WebSocket-to-TCP proxy state
pub struct XmppProxy {
    /// Local WebSocket server address
    local_addr: Option<SocketAddr>,
    /// Background task handle
    task: Option<JoinHandle<()>>,
    /// Shutdown signal
    shutdown_tx: Option<tokio::sync::broadcast::Sender<()>>,
    /// Active connection counter (for limiting to one connection)
    active_connections: Arc<AtomicUsize>,
}

impl XmppProxy {
    pub fn new() -> Self {
        Self {
            local_addr: None,
            task: None,
            shutdown_tx: None,
            active_connections: Arc::new(AtomicUsize::new(0)),
        }
    }

    /// Start the proxy server.
    ///
    /// The `server` parameter supports multiple formats:
    /// - `tls://host:port` or `tcp://host:port` — explicit endpoint, skip SRV
    /// - `host:port` — explicit endpoint, mode inferred from port (5223=TLS, else STARTTLS)
    /// - `domain` — SRV resolution with fallback to domain:5222 STARTTLS
    pub async fn start(&mut self, server: String) -> Result<ProxyStartResult, String> {
        if self.local_addr.is_some() {
            return Err("Proxy already running".to_string());
        }

        // Parse server input and resolve endpoint
        let endpoint = match parse_server_input(&server) {
            ParsedServer::Direct(host, port, mode) => {
                info!(host = %host, port, mode = ?mode, "Using explicit endpoint");
                XmppEndpoint { host, port, mode }
            }
            ParsedServer::Domain(domain) => {
                resolve_xmpp_server(&domain)
                    .await
                    .map_err(|e| format!("Failed to resolve XMPP server: {}", e))?
            }
        };

        info!(host = %endpoint.host, port = endpoint.port, mode = ?endpoint.mode, "Resolved endpoint");

        // Determine connection method string for the frontend
        let connection_method = match endpoint.mode {
            ConnectionMode::DirectTls => "tls".to_string(),
            ConnectionMode::Tcp => "starttls".to_string(),
        };

        // Bind to localhost on a random port
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| format!("Failed to bind WebSocket server: {}", e))?;

        let local_addr = listener
            .local_addr()
            .map_err(|e| format!("Failed to get local address: {}", e))?;

        self.local_addr = Some(local_addr);

        // Create shutdown channel
        let (shutdown_tx, _) = tokio::sync::broadcast::channel(1);
        self.shutdown_tx = Some(shutdown_tx.clone());

        // Clone connection counter for the background task
        let active_connections = self.active_connections.clone();

        // Spawn background task to handle connections
        let task = tokio::spawn(async move {
            let mut shutdown_rx = shutdown_tx.subscribe();

            loop {
                tokio::select! {
                    Ok((stream, addr)) = listener.accept() => {
                        info!(addr = %addr, "New WebSocket connection");
                        let ep = endpoint.clone();
                        let shutdown = shutdown_tx.subscribe();
                        let conn_counter = active_connections.clone();

                        tokio::spawn(async move {
                            if let Err(e) = handle_connection(stream, ep, shutdown, conn_counter).await {
                                error!(error = %e, "Connection error");
                            }
                        });
                    }
                    _ = shutdown_rx.recv() => {
                        info!("Shutting down");
                        break;
                    }
                }
            }
        });

        self.task = Some(task);

        Ok(ProxyStartResult {
            url: format!("ws://127.0.0.1:{}", local_addr.port()),
            connection_method,
        })
    }

    /// Stop the proxy server
    pub async fn stop(&mut self) -> Result<(), String> {
        if let Some(shutdown_tx) = self.shutdown_tx.take() {
            let _ = shutdown_tx.send(());
        }

        if let Some(task) = self.task.take() {
            task.abort();
        }

        self.local_addr = None;
        Ok(())
    }
}

/// Handle a single WebSocket <-> XMPP server connection
async fn handle_connection(
    ws_stream: tokio::net::TcpStream,
    endpoint: XmppEndpoint,
    shutdown: tokio::sync::broadcast::Receiver<()>,
    active_connections: Arc<AtomicUsize>,
) -> Result<(), String> {
    // Check connection limit: only allow one active connection
    let current = active_connections.fetch_add(1, Ordering::SeqCst);
    if current > 0 {
        warn!(active = current, "Connection rejected: proxy already in use");
        // Decrement before returning
        active_connections.fetch_sub(1, Ordering::SeqCst);
        return Err("Proxy already in use by another connection".to_string());
    }

    // Ensure we decrement the counter when this function exits (success or error)
    let _guard = ConnectionGuard::new(active_connections.clone());

    // Upgrade to WebSocket
    let ws = accept_async(ws_stream)
        .await
        .map_err(|e| format!("WebSocket handshake failed: {}", e))?;

    info!("WebSocket connection established");

    // Connect to XMPP server (STARTTLS or direct TLS)
    match endpoint.mode {
        ConnectionMode::Tcp => {
            let tcp_stream = TcpStream::connect(format!("{}:{}", endpoint.host, endpoint.port))
                .await
                .map_err(|e| format!("Failed to connect to XMPP server: {}", e))?;
            info!(host = %endpoint.host, port = endpoint.port, "Connected (TCP), performing STARTTLS");

            // Perform STARTTLS negotiation: the proxy handles the TLS upgrade transparently
            // so that xmpp.js (which cannot do STARTTLS over WebSocket) sees a ready-to-use connection
            let tls_stream = perform_starttls(tcp_stream, &endpoint.host).await?;
            info!(host = %endpoint.host, port = endpoint.port, "STARTTLS upgrade complete");
            bridge_websocket_tls(ws, tls_stream, shutdown).await
        }
        ConnectionMode::DirectTls => {
            let tcp_stream = TcpStream::connect(format!("{}:{}", endpoint.host, endpoint.port))
                .await
                .map_err(|e| format!("Failed to connect to XMPP server: {}", e))?;

            let tls_stream = upgrade_to_tls(tcp_stream, &endpoint.host).await?;

            info!(host = %endpoint.host, port = endpoint.port, "Connected (direct TLS)");
            bridge_websocket_tls(ws, tls_stream, shutdown).await
        }
    }
}

/// Translate RFC 7395 WebSocket framing to traditional XMPP
/// - `<open/>` → `<stream:stream>`
/// - `<close/>` → `</stream:stream>`
/// - Regular stanzas pass through unchanged (zero-copy via Cow)
fn translate_ws_to_tcp<'a>(text: &'a str) -> Cow<'a, str> {
    let trimmed = text.trim();

    // Check if this is an <open/> tag (RFC 7395 WebSocket framing)
    if trimmed.starts_with("<open ") || trimmed.starts_with("<open>") {
        // Parse attributes using quick-xml for robust handling of quoting styles
        let mut reader = Reader::from_str(trimmed);
        reader.config_mut().check_end_names = false;

        let event = reader.read_event();
        let attrs = match &event {
            Ok(Event::Empty(e)) | Ok(Event::Start(e)) => Some(e.attributes()),
            _ => None,
        };

        let mut to = String::new();
        let mut version = String::from("1.0");
        let mut lang = String::new();

        if let Some(attrs) = attrs {
            for attr in attrs.flatten() {
                let key = String::from_utf8_lossy(attr.key.as_ref());
                let value = String::from_utf8_lossy(&attr.value);
                match key.as_ref() {
                    "to" => to = value.to_string(),
                    "version" => version = value.to_string(),
                    "xml:lang" => lang = value.to_string(),
                    _ => {} // Skip xmlns and other attributes
                }
            }
        }

        // Build <stream:stream> tag
        let mut stream_tag = String::from("<?xml version='1.0'?><stream:stream");
        if !to.is_empty() {
            stream_tag.push_str(&format!(" to='{}'", to));
        }
        stream_tag.push_str(&format!(" version='{}'", version));
        if !lang.is_empty() {
            stream_tag.push_str(&format!(" xml:lang='{}'", lang));
        }
        stream_tag.push_str(" xmlns='jabber:client' xmlns:stream='http://etherx.jabber.org/streams'>");

        return Cow::Owned(stream_tag);
    }

    // Check if this is a <close/> tag
    if trimmed.starts_with("<close") {
        return Cow::Borrowed("</stream:stream>");
    }

    // Regular stanza - pass through unchanged (zero-copy)
    Cow::Borrowed(text)
}

/// Translate traditional XMPP stream framing to RFC 7395 WebSocket framing
/// - `<stream:stream ...>` → `<open xmlns="urn:ietf:params:xml:ns:xmpp-framing" .../>`
/// - `</stream:stream>` → `<close xmlns="urn:ietf:params:xml:ns:xmpp-framing"/>`
/// - `<stream:features>` → `<features xmlns="http://etherx.jabber.org/streams">` (strip prefix, add xmlns)
/// - `<stream:error>` → `<error xmlns="http://etherx.jabber.org/streams">` (strip prefix, add xmlns)
/// - Regular stanzas pass through unchanged (zero-copy via Cow)
///
/// The stream: prefix rewriting is necessary because in RFC 7395 WebSocket framing,
/// each stanza is a standalone XML document without the <stream:stream> parent that
/// declares xmlns:stream. Without rewriting, the xmpp.js client cannot resolve the
/// stream: prefix and silently drops these elements.
fn translate_tcp_to_ws<'a>(text: &'a str) -> Cow<'a, str> {
    let trimmed = text.trim();

    // Check for </stream:stream> closing tag
    if trimmed == "</stream:stream>" {
        return Cow::Borrowed(r#"<close xmlns="urn:ietf:params:xml:ns:xmpp-framing"/>"#);
    }

    // Check for <stream:stream ...> or <?xml ...?><stream:stream ...> opening
    // Strip optional XML declaration first
    let stream_text = if trimmed.starts_with("<?xml") {
        // Find end of XML declaration and skip it
        match trimmed.find("?>") {
            Some(pos) => trimmed[pos + 2..].trim(),
            None => trimmed,
        }
    } else {
        trimmed
    };

    if stream_text.starts_with("<stream:stream ") {
        // Extract attributes from <stream:stream> using quick-xml for robust parsing
        let mut reader = Reader::from_str(stream_text);
        reader.config_mut().check_end_names = false;

        if let Ok(Event::Start(e)) = reader.read_event() {
            let mut to = String::new();
            let mut from = String::new();
            let mut version = String::new();
            let mut lang = String::new();
            let mut id = String::new();

            for attr in e.attributes().flatten() {
                let key = String::from_utf8_lossy(attr.key.as_ref());
                let value = String::from_utf8_lossy(&attr.value);
                match key.as_ref() {
                    "to" => to = value.to_string(),
                    "from" => from = value.to_string(),
                    "version" => version = value.to_string(),
                    "xml:lang" => lang = value.to_string(),
                    "id" => id = value.to_string(),
                    _ => {} // Skip xmlns and xmlns:stream
                }
            }

            let mut open_tag = String::from(r#"<open xmlns="urn:ietf:params:xml:ns:xmpp-framing""#);
            if !to.is_empty() {
                open_tag.push_str(&format!(r#" to="{}""#, to));
            }
            if !from.is_empty() {
                open_tag.push_str(&format!(r#" from="{}""#, from));
            }
            if !id.is_empty() {
                open_tag.push_str(&format!(r#" id="{}""#, id));
            }
            if !version.is_empty() {
                open_tag.push_str(&format!(r#" version="{}""#, version));
            }
            if !lang.is_empty() {
                open_tag.push_str(&format!(r#" xml:lang="{}""#, lang));
            }
            open_tag.push_str("/>");

            return Cow::Owned(open_tag);
        }
    }

    // Rewrite stream:-prefixed elements (e.g. <stream:features>, <stream:error>).
    // In TCP XMPP, these rely on xmlns:stream declared on the parent <stream:stream>.
    // In RFC 7395 WebSocket framing, each message is a standalone XML fragment, so the
    // stream: prefix is unresolvable. We strip the prefix and add an explicit xmlns.
    if trimmed.starts_with("<stream:") && !trimmed.starts_with("<stream:stream") {
        let result = trimmed
            .replace("<stream:", "<")
            .replace("</stream:", "</");
        // Inject xmlns on the root element (after the first tag name, before '>', ' ', or '/')
        if let Some(pos) = result.find([' ', '>', '/']) {
            let ch = result.as_bytes()[pos] as char;
            // Check if the root tag already has xmlns= (only check up to first '>')
            let root_tag_end = result.find('>').unwrap_or(result.len());
            let root_tag = &result[..root_tag_end];
            if !root_tag.contains("xmlns=") {
                let xmlns_attr = r#" xmlns="http://etherx.jabber.org/streams""#;
                let mut rewritten = String::with_capacity(result.len() + xmlns_attr.len());
                rewritten.push_str(&result[..pos]);
                rewritten.push_str(xmlns_attr);
                rewritten.push(ch);
                rewritten.push_str(&result[pos + 1..]);
                return Cow::Owned(rewritten);
            }
        }
        return Cow::Owned(result);
    }

    // Regular stanza — pass through unchanged (zero-copy)
    Cow::Borrowed(text)
}

/// Perform XMPP STARTTLS negotiation on a plain TCP connection.
///
/// This function handles the STARTTLS upgrade transparently so that xmpp.js
/// (which cannot perform STARTTLS over WebSocket) sees a ready-to-use TLS connection.
///
/// Protocol flow:
/// 1. Send `<stream:stream>` to server
/// 2. Read server's `<stream:stream>` response + `<stream:features>` (must contain `<starttls>`)
/// 3. Send `<starttls xmlns='urn:ietf:params:xml:ns:xmpp-tls'/>`
/// 4. Read `<proceed/>` response
/// 5. Upgrade TCP socket to TLS via `TlsConnector::connect()`
///
/// After this, xmpp.js sends its own `<open/>` which the proxy translates to a fresh
/// `<stream:stream>` over the now-encrypted connection.
async fn perform_starttls(
    mut tcp_stream: TcpStream,
    host: &str,
) -> Result<tokio_rustls::client::TlsStream<TcpStream>, String> {
    // Step 1: Send stream opening to server
    let stream_open = format!(
        "<?xml version='1.0'?><stream:stream to='{}' version='1.0' xmlns='jabber:client' xmlns:stream='http://etherx.jabber.org/streams'>",
        host
    );
    debug!(host, "STARTTLS: Sending stream open");
    tcp_stream.write_all(stream_open.as_bytes()).await
        .map_err(|e| format!("STARTTLS: Failed to send stream open: {}", e))?;

    // Step 2: Read server's response (stream:stream + stream:features)
    // We need to read until we get <stream:features> with <starttls/> inside
    let mut buffer = Vec::new();
    let mut read_buf = [0u8; 8192];
    let mut got_stream_header = false;
    let mut features_xml = String::new();

    // Read with a timeout to avoid hanging forever
    let timeout_duration = std::time::Duration::from_secs(10);
    let read_deadline = tokio::time::Instant::now() + timeout_duration;

    loop {
        let remaining = read_deadline - tokio::time::Instant::now();
        if remaining.is_zero() {
            return Err("STARTTLS: Timeout waiting for server stream features".to_string());
        }

        let n = tokio::time::timeout(remaining, tcp_stream.read(&mut read_buf))
            .await
            .map_err(|_| "STARTTLS: Timeout waiting for server response".to_string())?
            .map_err(|e| format!("STARTTLS: Failed to read server response: {}", e))?;

        if n == 0 {
            return Err("STARTTLS: Server closed connection before features".to_string());
        }

        buffer.extend_from_slice(&read_buf[..n]);
        debug!(bytes = n, "STARTTLS: Received data");

        // Extract stanzas from the buffer
        while let Some((stanza, remaining)) = extract_stanza(&buffer) {
            debug!(stanza = %stanza, "STARTTLS: Extracted stanza");
            buffer = remaining;

            if stanza.contains("<stream:stream") {
                // Server's stream header — consume and continue
                got_stream_header = true;
                continue;
            }

            if stanza.contains("<stream:features") || stanza.contains("<features") {
                features_xml = stanza;
                break;
            }

            // Unexpected stanza before features
            warn!(stanza = %stanza, "STARTTLS: Unexpected stanza before features");
        }

        if !features_xml.is_empty() {
            break;
        }
    }

    if !got_stream_header {
        return Err("STARTTLS: Did not receive server stream header".to_string());
    }

    // Check that features contain <starttls>
    if !features_xml.contains("<starttls") {
        return Err(format!(
            "STARTTLS: Server does not offer STARTTLS. Features: {}",
            features_xml
        ));
    }
    debug!("STARTTLS: Server offers STARTTLS, proceeding");

    // Step 3: Send <starttls>
    let starttls_request = "<starttls xmlns='urn:ietf:params:xml:ns:xmpp-tls'/>";
    tcp_stream.write_all(starttls_request.as_bytes()).await
        .map_err(|e| format!("STARTTLS: Failed to send starttls request: {}", e))?;
    debug!("STARTTLS: Sent <starttls/> request");

    // Step 4: Read <proceed/> response
    buffer.clear();
    let read_deadline = tokio::time::Instant::now() + timeout_duration;
    let proceed_xml;

    loop {
        let remaining_time = read_deadline - tokio::time::Instant::now();
        if remaining_time.is_zero() {
            return Err("STARTTLS: Timeout waiting for proceed response".to_string());
        }

        let n = tokio::time::timeout(remaining_time, tcp_stream.read(&mut read_buf))
            .await
            .map_err(|_| "STARTTLS: Timeout waiting for proceed response".to_string())?
            .map_err(|e| format!("STARTTLS: Failed to read proceed response: {}", e))?;

        if n == 0 {
            return Err("STARTTLS: Server closed connection before proceed".to_string());
        }

        buffer.extend_from_slice(&read_buf[..n]);
        debug!(bytes = n, "STARTTLS: Received data");

        if let Some((stanza, _remaining)) = extract_stanza(&buffer) {
            proceed_xml = stanza;
            break;
        }
    }

    if proceed_xml.contains("<failure") {
        return Err(format!("STARTTLS: Server rejected STARTTLS: {}", proceed_xml));
    }

    if !proceed_xml.contains("<proceed") {
        return Err(format!(
            "STARTTLS: Unexpected response (expected <proceed/>): {}",
            proceed_xml
        ));
    }
    info!(host, "STARTTLS: Received <proceed/>, upgrading to TLS");

    // Step 5: Upgrade TCP socket to TLS (reuse shared helper)
    let tls_stream = upgrade_to_tls(tcp_stream, host).await
        .map_err(|e| format!("STARTTLS: {}", e))?;

    info!(host, "STARTTLS: TLS handshake complete");
    Ok(tls_stream)
}

/// Bridge WebSocket and TLS stream.
///
/// Both connection modes (DirectTls and Tcp/STARTTLS) end up here after TLS is established.
/// Bidirectionally bridges:
/// - WebSocket → TLS: translates RFC 7395 framing (`<open/>`) to TCP framing (`<stream:stream>`)
/// - TLS → WebSocket: translates TCP framing back to RFC 7395 and extracts stanza boundaries
async fn bridge_websocket_tls(
    ws: tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
    tls_stream: tokio_rustls::client::TlsStream<TcpStream>,
    mut shutdown: tokio::sync::broadcast::Receiver<()>,
) -> Result<(), String> {
    let (mut ws_write, mut ws_read) = ws.split();
    let (mut tls_read, mut tls_write) = tokio::io::split(tls_stream);

    // Task 1: WebSocket -> TLS (translate RFC 7395 WebSocket framing to traditional XMPP)
    let ws_to_tls = tokio::spawn(async move {
        while let Some(msg) = ws_read.next().await {
            match msg {
                Ok(Message::Text(text)) => {
                    debug!(data = %text, "WS->TLS");

                    // Translate WebSocket framing (RFC 7395) to traditional XMPP
                    let translated = translate_ws_to_tcp(&text);

                    debug!(data = %translated, "WS->TLS translated");

                    if let Err(e) = tls_write.write_all(translated.as_bytes()).await {
                        error!(error = %e, "WS->TLS write error");
                        break;
                    }
                }
                Ok(Message::Close(_)) => {
                    info!("WebSocket closed by client");
                    break;
                }
                Err(e) => {
                    error!(error = %e, "WebSocket read error");
                    break;
                }
                _ => {}
            }
        }
    });

    // Task 2: TLS -> WebSocket (requires stanza boundary detection)
    let tls_to_ws = tokio::spawn(async move {
        let mut buffer = Vec::new();
        let mut read_buf = [0u8; 8192];

        loop {
            // Read from TLS
            match tls_read.read(&mut read_buf).await {
                Ok(0) => {
                    info!("TLS connection closed");
                    break;
                }
                Ok(n) => {
                    buffer.extend_from_slice(&read_buf[..n]);

                    debug!(bytes = n, "Received from TLS");

                    // Extract complete stanzas from buffer and translate to RFC 7395
                    while let Some((stanza, remaining)) = extract_stanza(&buffer) {
                        let translated = translate_tcp_to_ws(&stanza);
                        debug!(data = %translated, "TLS->WS");
                        if let Err(e) = ws_write.send(Message::Text(translated.into_owned())).await {
                            error!(error = %e, "TLS->WS write error");
                            return;
                        }
                        buffer = remaining;
                    }
                }
                Err(e) => {
                    error!(error = %e, "TLS read error");
                    break;
                }
            }
        }
    });

    // Wait for either task to complete or shutdown signal
    tokio::select! {
        _ = ws_to_tls => {}
        _ = tls_to_ws => {}
        _ = shutdown.recv() => {
            info!("Connection closed by shutdown");
        }
    }

    Ok(())
}

/// Extract a complete XMPP stanza from the buffer using depth counting.
/// Returns (stanza_xml, remaining_buffer) if a complete stanza is found.
///
/// This uses a lightweight depth-counting approach:
/// - Depth 0: The <stream:stream> wrapper
/// - Depth 1: XMPP stanzas (<message/>, <presence/>, <iq/>, etc.)
/// - Depth 2+: Children within stanzas
///
/// A stanza is complete when we return from depth 2 to depth 1 (closing tag of depth-1 element).
/// State machine for stanza boundary detection (inspired by Fluux Agent's StanzaParser).
#[derive(Debug, Clone, Copy, PartialEq)]
enum ParserState {
    /// Waiting for a stanza to start (between stanzas, or before stream open).
    Idle,
    /// Inside a top-level stanza, collecting events.
    InStanza,
}

/// Extracts a single XMPP stanza from the front of a buffer using an event-driven state machine.
///
/// This implementation mirrors Fluux Agent's StanzaParser approach:
/// - Uses a state machine (Idle/InStanza) to track parsing progress
/// - Tracks depth and stream_depth to detect stanza boundaries correctly
/// - Lets quick-xml handle XML parsing and partial buffer handling
/// - Handles TCP fragmentation automatically (quick-xml buffers incomplete events)
///
/// Returns Some((stanza_xml, remaining_bytes)) if a complete stanza was found,
/// or None if the buffer doesn't contain a complete stanza yet.
///
/// Handles:
/// - Stream opening tags (<stream:stream>) — returned immediately as stream-level event
/// - Stream closing tags (</stream:stream>) — returned immediately as stream-level event
/// - Regular stanzas — extracted when depth returns to stream_depth while InStanza
/// - Nested children — properly tracked using depth counting
fn extract_stanza(buffer: &[u8]) -> Option<(String, Vec<u8>)> {
    // Special case: check for stream closing tag first
    // This appears alone without a matching opening tag in the buffer
    let buffer_str = String::from_utf8_lossy(buffer);
    if buffer_str.trim_start().starts_with("</stream:stream>") {
        let close_tag = "</stream:stream>".to_string();
        let tag_end = buffer_str.find("</stream:stream>").unwrap() + "</stream:stream>".len();
        let remaining = buffer[tag_end..].to_vec();
        return Some((close_tag, remaining));
    }

    let mut reader = Reader::from_reader(buffer);
    reader.config_mut().trim_text(false);
    reader.config_mut().check_end_names = false; // Faster parsing

    let mut depth: u32 = 0;
    let stream_depth: u32 = 0;
    let mut state = ParserState::Idle;
    let mut stanza_start: usize = 0;

    loop {
        let pos = reader.buffer_position() as usize;

        match reader.read_event() {
            Ok(Event::Decl(_)) | Ok(Event::PI(_)) | Ok(Event::Comment(_)) | Ok(Event::DocType(_)) => {
                // Stream-level metadata — ignore
                continue;
            }
            Ok(Event::Start(e)) => {
                let local_name = e.name().local_name();

                // Handle stream:stream wrapper
                if state == ParserState::Idle && (local_name.as_ref() == b"stream" || e.name().as_ref() == b"stream:stream") {
                    // Return the stream opening immediately
                    let tag_end = reader.buffer_position() as usize;
                    let stream_tag = String::from_utf8_lossy(&buffer[0..tag_end]).to_string();
                    let remaining = buffer[tag_end..].to_vec();
                    return Some((stream_tag, remaining));
                }

                depth += 1;

                // Start of a new top-level stanza (depth == stream_depth + 1)
                if state == ParserState::Idle && depth == stream_depth + 1 {
                    state = ParserState::InStanza;
                    stanza_start = pos;
                }
            }
            Ok(Event::Empty(e)) => {
                let local_name = e.name().local_name();

                // Self-closing stream:stream (rare, but possible)
                if state == ParserState::Idle && (local_name.as_ref() == b"stream" || e.name().as_ref() == b"stream:stream") {
                    let tag_end = reader.buffer_position() as usize;
                    let stream_tag = String::from_utf8_lossy(&buffer[0..tag_end]).to_string();
                    let remaining = buffer[tag_end..].to_vec();
                    return Some((stream_tag, remaining));
                }

                // Self-closing top-level stanza (e.g., <presence/>, <r xmlns='urn:xmpp:sm:3'/>)
                if state == ParserState::Idle && depth == stream_depth {
                    let tag_end = reader.buffer_position() as usize;
                    let stanza_xml = String::from_utf8_lossy(&buffer[pos..tag_end]).to_string();
                    let remaining = buffer[tag_end..].to_vec();
                    return Some((stanza_xml, remaining));
                }

                // Otherwise it's a self-closing child element, continue
            }
            Ok(Event::Text(_)) | Ok(Event::CData(_)) => {
                // Text content — don't change depth
            }
            Ok(Event::End(e)) => {
                let local_name = e.name().local_name();

                // Handle </stream:stream> closing
                if (local_name.as_ref() == b"stream" || e.name().as_ref() == b"stream:stream") && depth == stream_depth {
                    let tag_end = reader.buffer_position() as usize;
                    return Some(("</stream:stream>".to_string(), buffer[tag_end..].to_vec()));
                }

                depth = depth.saturating_sub(1);

                // Stanza complete when we return to stream_depth while InStanza
                if state == ParserState::InStanza && depth == stream_depth {
                    let tag_end = reader.buffer_position() as usize;
                    let stanza_xml = String::from_utf8_lossy(&buffer[stanza_start..tag_end]).to_string();
                    let remaining = buffer[tag_end..].to_vec();
                    return Some((stanza_xml, remaining));
                }
            }
            Ok(Event::Eof) => {
                // Incomplete stanza - need more data from TCP
                return None;
            }
            Err(e) => {
                error!(error = ?e, "XML parsing error");
                return None;
            }
        }
    }
}

/// Global proxy singleton
static PROXY: RwLock<Option<XmppProxy>> = RwLock::const_new(None);

/// Start the XMPP proxy (exposed to Tauri commands)
///
/// The `server` parameter supports: `tls://host:port`, `tcp://host:port`, `host:port`, or bare `domain`.
pub async fn start_proxy(server: String) -> Result<ProxyStartResult, String> {
    // Initialize crypto provider before any TLS operations
    init_crypto_provider();

    let mut proxy_guard = PROXY.write().await;

    if proxy_guard.is_some() {
        return Err("Proxy already running".to_string());
    }

    let mut proxy = XmppProxy::new();
    let result = proxy.start(server).await?;
    *proxy_guard = Some(proxy);

    Ok(result)
}

/// Stop the XMPP proxy (exposed to Tauri commands)
pub async fn stop_proxy() -> Result<(), String> {
    let mut proxy_guard = PROXY.write().await;

    if let Some(mut proxy) = proxy_guard.take() {
        proxy.stop().await?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_stream_opening() {
        let xml = b"<?xml version='1.0'?><stream:stream xmlns='jabber:client' xmlns:stream='http://etherx.jabber.org/streams' version='1.0'>";
        let result = extract_stanza(xml);
        assert!(result.is_some());
        let (stanza, remaining) = result.unwrap();
        assert!(stanza.contains("<stream:stream"));
        assert_eq!(remaining.len(), 0);
    }

    #[test]
    fn test_extract_stream_features() {
        let xml = b"<stream:features><mechanisms xmlns='urn:ietf:params:xml:ns:xmpp-sasl'><mechanism>PLAIN</mechanism><mechanism>SCRAM-SHA-1</mechanism></mechanisms><starttls xmlns='urn:ietf:params:xml:ns:xmpp-tls'/></stream:features>";
        let result = extract_stanza(xml);
        assert!(result.is_some());
        let (stanza, remaining) = result.unwrap();
        // Should extract the ENTIRE <stream:features> element
        assert!(stanza.contains("<stream:features"));
        assert!(stanza.contains("</stream:features>"));
        assert!(stanza.contains("<mechanisms"));
        assert!(stanza.contains("</mechanisms>"));
        assert!(stanza.contains("<starttls"));
        assert_eq!(remaining.len(), 0);
    }

    #[test]
    fn test_extract_simple_stanza() {
        let xml = b"<presence/>";
        let result = extract_stanza(xml);
        assert!(result.is_some());
        let (stanza, remaining) = result.unwrap();
        assert_eq!(stanza, "<presence/>");
        assert_eq!(remaining.len(), 0);
    }

    #[test]
    fn test_extract_nested_stanza() {
        let xml = b"<iq type='result'><query xmlns='jabber:iq:roster'><item jid='user@example.com'/></query></iq>";
        let result = extract_stanza(xml);
        assert!(result.is_some());
        let (stanza, remaining) = result.unwrap();
        assert!(stanza.contains("<iq"));
        assert!(stanza.contains("</iq>"));
        assert!(stanza.contains("<query"));
        assert!(stanza.contains("</query>"));
        assert_eq!(remaining.len(), 0);
    }

    #[test]
    fn test_extract_multiple_stanzas() {
        let xml = b"<presence from='user@example.com'/><message to='other@example.com'><body>Hello</body></message>";

        // First extraction
        let result1 = extract_stanza(xml);
        assert!(result1.is_some());
        let (stanza1, remaining1) = result1.unwrap();
        assert!(stanza1.contains("<presence"));
        assert!(!stanza1.contains("<message"));

        // Second extraction from remaining
        let result2 = extract_stanza(&remaining1);
        assert!(result2.is_some());
        let (stanza2, remaining2) = result2.unwrap();
        assert!(stanza2.contains("<message"));
        assert!(stanza2.contains("Hello"));
        assert_eq!(remaining2.len(), 0);
    }

    #[test]
    fn test_extract_incomplete_stanza() {
        // Incomplete XML - missing closing tag
        let xml = b"<iq type='get'><query xmlns='jabber:iq:roster'>";
        let result = extract_stanza(xml);
        // Should return None because stanza is incomplete
        assert!(result.is_none());
    }

    #[test]
    fn test_extract_stream_closing() {
        let xml = b"</stream:stream>";
        let result = extract_stanza(xml);
        assert!(result.is_some());
        let (stanza, remaining) = result.unwrap();
        assert_eq!(stanza, "</stream:stream>");
        assert_eq!(remaining.len(), 0);
    }

    #[test]
    fn test_translate_open_to_stream() {
        let open_tag = r#"<open xmlns="urn:ietf:params:xml:ns:xmpp-framing" to="example.com" version="1.0" xml:lang="en"/>"#;
        let translated = translate_ws_to_tcp(open_tag);

        assert!(translated.contains("<?xml version='1.0'?>"));
        assert!(translated.contains("<stream:stream"));
        assert!(translated.contains("to='example.com'"));
        assert!(translated.contains("version='1.0'"));
        assert!(translated.contains("xml:lang='en'"));
        assert!(translated.contains("xmlns='jabber:client'"));
        assert!(translated.contains("xmlns:stream='http://etherx.jabber.org/streams'"));
    }

    #[test]
    fn test_translate_close_to_stream_end() {
        let close_tag = r#"<close xmlns="urn:ietf:params:xml:ns:xmpp-framing"/>"#;
        let translated = translate_ws_to_tcp(close_tag);
        assert_eq!(&*translated, "</stream:stream>");
    }

    #[test]
    fn test_translate_regular_stanza_passthrough() {
        let stanza = r#"<presence type="unavailable"/>"#;
        let translated = translate_ws_to_tcp(stanza);
        assert_eq!(&*translated, stanza);
    }

    // --- translate_tcp_to_ws tests ---

    #[test]
    fn test_tcp_to_ws_stream_opening() {
        let stream_tag = r#"<?xml version='1.0'?><stream:stream xmlns='jabber:client' xmlns:stream='http://etherx.jabber.org/streams' from='example.com' id='abc123' version='1.0' xml:lang='en'>"#;
        let translated = translate_tcp_to_ws(stream_tag);

        assert!(translated.contains(r#"xmlns="urn:ietf:params:xml:ns:xmpp-framing""#));
        assert!(translated.contains(r#"from="example.com""#));
        assert!(translated.contains(r#"id="abc123""#));
        assert!(translated.contains(r#"version="1.0""#));
        assert!(translated.contains(r#"xml:lang="en""#));
        assert!(translated.ends_with("/>"));
        // Should NOT contain xmlns:stream or jabber:client — those are XMPP TCP-specific
        assert!(!translated.contains("jabber:client"));
        assert!(!translated.contains("xmlns:stream"));
    }

    #[test]
    fn test_tcp_to_ws_stream_opening_without_xml_decl() {
        let stream_tag = r#"<stream:stream xmlns='jabber:client' xmlns:stream='http://etherx.jabber.org/streams' to='example.com' version='1.0'>"#;
        let translated = translate_tcp_to_ws(stream_tag);

        assert!(translated.contains(r#"xmlns="urn:ietf:params:xml:ns:xmpp-framing""#));
        assert!(translated.contains(r#"to="example.com""#));
        assert!(translated.contains(r#"version="1.0""#));
        assert!(translated.ends_with("/>"));
    }

    #[test]
    fn test_tcp_to_ws_stream_closing() {
        let translated = translate_tcp_to_ws("</stream:stream>");
        assert_eq!(&*translated, r#"<close xmlns="urn:ietf:params:xml:ns:xmpp-framing"/>"#);
    }

    #[test]
    fn test_tcp_to_ws_regular_stanza_passthrough() {
        let stanza = r#"<message to="user@example.com"><body>Hello</body></message>"#;
        let translated = translate_tcp_to_ws(stanza);
        assert_eq!(&*translated, stanza);
    }

    #[test]
    fn test_tcp_to_ws_self_closing_stanza_passthrough() {
        let stanza = r#"<presence type="unavailable"/>"#;
        let translated = translate_tcp_to_ws(stanza);
        assert_eq!(&*translated, stanza);
    }

    // --- Roundtrip tests (WS→TCP→WS) ---

    #[test]
    fn test_roundtrip_open_tag() {
        // Client sends RFC 7395 <open/>, proxy translates to <stream:stream>, server responds
        // with <stream:stream>, proxy translates back to <open/>
        let client_open = r#"<open xmlns="urn:ietf:params:xml:ns:xmpp-framing" to="example.com" version="1.0" xml:lang="en"/>"#;
        let tcp_form = translate_ws_to_tcp(client_open);
        assert!(tcp_form.contains("<stream:stream"));

        // Simulate server response (different attributes: has from, id; no to)
        let server_response = r#"<?xml version='1.0'?><stream:stream xmlns='jabber:client' xmlns:stream='http://etherx.jabber.org/streams' from='example.com' id='sess123' version='1.0' xml:lang='en'>"#;
        let ws_form = translate_tcp_to_ws(server_response);
        assert!(ws_form.starts_with("<open "));
        assert!(ws_form.contains(r#"from="example.com""#));
        assert!(ws_form.contains(r#"id="sess123""#));
        assert!(ws_form.ends_with("/>"));
    }

    #[test]
    fn test_roundtrip_close_tag() {
        let client_close = r#"<close xmlns="urn:ietf:params:xml:ns:xmpp-framing"/>"#;
        let tcp_form = translate_ws_to_tcp(client_close);
        assert_eq!(&*tcp_form, "</stream:stream>");

        let ws_form = translate_tcp_to_ws(&tcp_form);
        assert_eq!(&*ws_form, r#"<close xmlns="urn:ietf:params:xml:ns:xmpp-framing"/>"#);
    }

    // --- Additional extract_stanza tests for real-world XMPP patterns ---

    #[test]
    fn test_extract_sm_stanzas() {
        // XEP-0198 Stream Management <r/> and <a/> are self-closing top-level stanzas
        let xml = b"<r xmlns='urn:xmpp:sm:3'/><a xmlns='urn:xmpp:sm:3' h='5'/>";

        let result1 = extract_stanza(xml);
        assert!(result1.is_some());
        let (stanza1, remaining1) = result1.unwrap();
        assert!(stanza1.contains("<r xmlns"));
        assert!(stanza1.contains("urn:xmpp:sm:3"));

        let result2 = extract_stanza(&remaining1);
        assert!(result2.is_some());
        let (stanza2, remaining2) = result2.unwrap();
        assert!(stanza2.contains("<a xmlns"));
        assert!(stanza2.contains("h="));
        assert_eq!(remaining2.len(), 0);
    }

    #[test]
    fn test_extract_message_with_body_text() {
        let xml = b"<message from='alice@example.com' to='bob@example.com' type='chat'><body>Hello, world!</body></message>";
        let result = extract_stanza(xml);
        assert!(result.is_some());
        let (stanza, remaining) = result.unwrap();
        assert!(stanza.contains("Hello, world!"));
        assert!(stanza.contains("<body>"));
        assert!(stanza.contains("</body>"));
        assert!(stanza.contains("</message>"));
        assert_eq!(remaining.len(), 0);
    }

    #[test]
    fn test_extract_stanzas_with_xml_declaration_prefix() {
        // Real server response: XML declaration followed by stream:stream followed by features
        let xml = b"<?xml version='1.0'?><stream:stream xmlns='jabber:client' xmlns:stream='http://etherx.jabber.org/streams' from='example.com' version='1.0'>";
        let result = extract_stanza(xml);
        assert!(result.is_some());
        let (stanza, remaining) = result.unwrap();
        // The XML declaration should be included in the returned stream tag
        assert!(stanza.contains("<?xml"));
        assert!(stanza.contains("<stream:stream"));
        assert_eq!(remaining.len(), 0);
    }

    #[test]
    fn test_extract_stanza_with_multiple_children_and_text() {
        // A typical message stanza with multiple children
        let xml = b"<message type='chat' from='user@example.com/res'><body>Test</body><active xmlns='http://jabber.org/protocol/chatstates'/></message>";
        let result = extract_stanza(xml);
        assert!(result.is_some());
        let (stanza, remaining) = result.unwrap();
        assert!(stanza.contains("<body>Test</body>"));
        assert!(stanza.contains("<active xmlns="));
        assert!(stanza.contains("</message>"));
        assert_eq!(remaining.len(), 0);
    }

    #[test]
    fn test_extract_empty_buffer() {
        let xml = b"";
        let result = extract_stanza(xml);
        assert!(result.is_none());
    }

    #[test]
    fn test_extract_whitespace_only_buffer() {
        let xml = b"   \n  ";
        let result = extract_stanza(xml);
        assert!(result.is_none());
    }

    #[test]
    fn test_extract_stream_close_with_leading_whitespace() {
        let xml = b"  </stream:stream>";
        let result = extract_stanza(xml);
        assert!(result.is_some());
        let (stanza, _remaining) = result.unwrap();
        assert_eq!(stanza, "</stream:stream>");
    }

    #[test]
    fn test_extract_iq_result_with_bind() {
        // Typical bind result after authentication
        let xml = b"<iq type='result' id='bind_1'><bind xmlns='urn:ietf:params:xml:ns:xmpp-bind'><jid>user@example.com/resource</jid></bind></iq>";
        let result = extract_stanza(xml);
        assert!(result.is_some());
        let (stanza, remaining) = result.unwrap();
        assert!(stanza.contains("user@example.com/resource"));
        assert!(stanza.contains("</bind>"));
        assert!(stanza.contains("</iq>"));
        assert_eq!(remaining.len(), 0);
    }

    #[test]
    fn test_extract_three_consecutive_stanzas() {
        // Three stanzas in one buffer: self-closing, regular, self-closing
        let xml = b"<r xmlns='urn:xmpp:sm:3'/><message to='a@b'><body>Hi</body></message><a xmlns='urn:xmpp:sm:3' h='1'/>";

        let result1 = extract_stanza(xml);
        assert!(result1.is_some());
        let (s1, r1) = result1.unwrap();
        assert!(s1.contains("<r xmlns"));

        let result2 = extract_stanza(&r1);
        assert!(result2.is_some());
        let (s2, r2) = result2.unwrap();
        assert!(s2.contains("<message"));
        assert!(s2.contains("Hi"));

        let result3 = extract_stanza(&r2);
        assert!(result3.is_some());
        let (s3, r3) = result3.unwrap();
        assert!(s3.contains("<a xmlns"));
        assert!(s3.contains("h="));
        assert_eq!(r3.len(), 0);
    }

    // --- stream: prefix rewriting tests ---

    #[test]
    fn test_tcp_to_ws_stream_features_prefix_rewrite() {
        // This is the critical test: <stream:features> from TCP must be rewritten
        // to <features xmlns="..."> for WebSocket, because the stream: prefix
        // relies on xmlns:stream from the parent <stream:stream> which doesn't
        // exist in RFC 7395 standalone framing.
        let features = r#"<stream:features><mechanisms xmlns='urn:ietf:params:xml:ns:xmpp-sasl'><mechanism>PLAIN</mechanism><mechanism>SCRAM-SHA-1</mechanism></mechanisms><starttls xmlns='urn:ietf:params:xml:ns:xmpp-tls'/></stream:features>"#;
        let translated = translate_tcp_to_ws(features);

        // Should strip stream: prefix and add explicit xmlns
        assert!(translated.starts_with("<features "));
        assert!(translated.contains(r#"xmlns="http://etherx.jabber.org/streams""#));
        assert!(translated.ends_with("</features>"));
        // Children should be unchanged
        assert!(translated.contains("<mechanisms xmlns="));
        assert!(translated.contains("<starttls xmlns="));
        // No stream: prefix should remain
        assert!(!translated.contains("stream:features"));
    }

    #[test]
    fn test_tcp_to_ws_stream_error_prefix_rewrite() {
        let error = r#"<stream:error><not-well-formed xmlns='urn:ietf:params:xml:ns:xmpp-streams'/></stream:error>"#;
        let translated = translate_tcp_to_ws(error);

        assert!(translated.starts_with("<error "));
        assert!(translated.contains(r#"xmlns="http://etherx.jabber.org/streams""#));
        assert!(translated.ends_with("</error>"));
        assert!(translated.contains("<not-well-formed xmlns="));
        assert!(!translated.contains("stream:error"));
    }

    #[test]
    fn test_tcp_to_ws_does_not_rewrite_stream_stream() {
        // <stream:stream> should be handled by the open tag logic, NOT the prefix rewriter
        let stream = r#"<stream:stream xmlns='jabber:client' xmlns:stream='http://etherx.jabber.org/streams' from='example.com' version='1.0'>"#;
        let translated = translate_tcp_to_ws(stream);
        // Should be converted to <open/>, not just prefix-stripped
        assert!(translated.starts_with("<open "));
        assert!(translated.contains("urn:ietf:params:xml:ns:xmpp-framing"));
    }

    #[test]
    fn test_tcp_to_ws_non_stream_prefix_passthrough() {
        // Regular stanzas without stream: prefix should pass through unchanged
        let iq = r#"<iq type='result' id='1'><query xmlns='jabber:iq:roster'/></iq>"#;
        let translated = translate_tcp_to_ws(iq);
        assert_eq!(&*translated, iq);
    }

    // --- parse_server_input tests ---

    #[test]
    fn test_parse_tls_uri_with_port() {
        assert_eq!(
            parse_server_input("tls://chat.example.com:5223"),
            ParsedServer::Direct("chat.example.com".to_string(), 5223, ConnectionMode::DirectTls)
        );
    }

    #[test]
    fn test_parse_tls_uri_custom_port() {
        assert_eq!(
            parse_server_input("tls://chat.example.com:5270"),
            ParsedServer::Direct("chat.example.com".to_string(), 5270, ConnectionMode::DirectTls)
        );
    }

    #[test]
    fn test_parse_tls_uri_no_port() {
        assert_eq!(
            parse_server_input("tls://chat.example.com"),
            ParsedServer::Direct("chat.example.com".to_string(), 5223, ConnectionMode::DirectTls)
        );
    }

    #[test]
    fn test_parse_tcp_uri_with_port() {
        assert_eq!(
            parse_server_input("tcp://chat.example.com:5222"),
            ParsedServer::Direct("chat.example.com".to_string(), 5222, ConnectionMode::Tcp)
        );
    }

    #[test]
    fn test_parse_tcp_uri_no_port() {
        assert_eq!(
            parse_server_input("tcp://chat.example.com"),
            ParsedServer::Direct("chat.example.com".to_string(), 5222, ConnectionMode::Tcp)
        );
    }

    #[test]
    fn test_parse_host_port_5223_is_tls() {
        // Port 5223 is conventionally direct TLS
        assert_eq!(
            parse_server_input("chat.example.com:5223"),
            ParsedServer::Direct("chat.example.com".to_string(), 5223, ConnectionMode::DirectTls)
        );
    }

    #[test]
    fn test_parse_host_port_5222_is_tcp() {
        assert_eq!(
            parse_server_input("chat.example.com:5222"),
            ParsedServer::Direct("chat.example.com".to_string(), 5222, ConnectionMode::Tcp)
        );
    }

    #[test]
    fn test_parse_host_port_custom_is_tcp() {
        // Non-standard port defaults to STARTTLS mode
        assert_eq!(
            parse_server_input("chat.example.com:5280"),
            ParsedServer::Direct("chat.example.com".to_string(), 5280, ConnectionMode::Tcp)
        );
    }

    #[test]
    fn test_parse_bare_domain() {
        assert_eq!(
            parse_server_input("process-one.net"),
            ParsedServer::Domain("process-one.net".to_string())
        );
    }

    #[test]
    fn test_parse_bare_domain_with_whitespace() {
        assert_eq!(
            parse_server_input("  process-one.net  "),
            ParsedServer::Domain("process-one.net".to_string())
        );
    }

    #[test]
    fn test_parse_tls_uri_with_whitespace() {
        assert_eq!(
            parse_server_input("  tls://chat.example.com:5223  "),
            ParsedServer::Direct("chat.example.com".to_string(), 5223, ConnectionMode::DirectTls)
        );
    }

    // --- STARTTLS protocol parsing tests ---
    // These test the stanza extraction and parsing patterns used by perform_starttls()

    #[test]
    fn test_starttls_extract_server_stream_and_features() {
        // Simulates the server response after proxy sends <stream:stream>:
        // First the server sends back its own <stream:stream>, then <stream:features>
        let xml = b"<?xml version='1.0'?><stream:stream xmlns='jabber:client' xmlns:stream='http://etherx.jabber.org/streams' from='example.com' id='abc' version='1.0'><stream:features><starttls xmlns='urn:ietf:params:xml:ns:xmpp-tls'><required/></starttls><mechanisms xmlns='urn:ietf:params:xml:ns:xmpp-sasl'><mechanism>SCRAM-SHA-1</mechanism></mechanisms></stream:features>";

        // First extraction: stream header
        let result1 = extract_stanza(xml);
        assert!(result1.is_some());
        let (stanza1, remaining1) = result1.unwrap();
        assert!(stanza1.contains("<stream:stream"));
        assert!(stanza1.contains("from='example.com'"));

        // Second extraction: stream features
        let result2 = extract_stanza(&remaining1);
        assert!(result2.is_some());
        let (stanza2, remaining2) = result2.unwrap();
        assert!(stanza2.contains("<stream:features"));
        assert!(stanza2.contains("</stream:features>"));
        // Verify <starttls> is present (this is what perform_starttls checks)
        assert!(stanza2.contains("<starttls"));
        assert!(stanza2.contains("urn:ietf:params:xml:ns:xmpp-tls"));
        assert_eq!(remaining2.len(), 0);
    }

    #[test]
    fn test_starttls_extract_features_without_starttls() {
        // Server that does NOT offer STARTTLS (e.g., already on direct TLS)
        let xml = b"<stream:features><mechanisms xmlns='urn:ietf:params:xml:ns:xmpp-sasl'><mechanism>SCRAM-SHA-1</mechanism></mechanisms><bind xmlns='urn:ietf:params:xml:ns:xmpp-bind'/></stream:features>";

        let result = extract_stanza(xml);
        assert!(result.is_some());
        let (stanza, _) = result.unwrap();
        // Verify <starttls> is NOT present
        assert!(!stanza.contains("<starttls"));
        // The perform_starttls function would return an error in this case
    }

    #[test]
    fn test_starttls_extract_proceed() {
        // Server sends <proceed/> after receiving <starttls/>
        let xml = b"<proceed xmlns='urn:ietf:params:xml:ns:xmpp-tls'/>";

        let result = extract_stanza(xml);
        assert!(result.is_some());
        let (stanza, remaining) = result.unwrap();
        assert!(stanza.contains("<proceed"));
        assert!(stanza.contains("urn:ietf:params:xml:ns:xmpp-tls"));
        assert_eq!(remaining.len(), 0);
    }

    #[test]
    fn test_starttls_extract_failure() {
        // Server sends <failure/> if STARTTLS is rejected
        let xml = b"<failure xmlns='urn:ietf:params:xml:ns:xmpp-tls'/>";

        let result = extract_stanza(xml);
        assert!(result.is_some());
        let (stanza, remaining) = result.unwrap();
        assert!(stanza.contains("<failure"));
        assert!(stanza.contains("urn:ietf:params:xml:ns:xmpp-tls"));
        assert_eq!(remaining.len(), 0);
    }

    #[test]
    fn test_starttls_features_with_required_flag() {
        // STARTTLS with <required/> child means server mandates TLS
        let xml = b"<stream:features><starttls xmlns='urn:ietf:params:xml:ns:xmpp-tls'><required/></starttls></stream:features>";

        let result = extract_stanza(xml);
        assert!(result.is_some());
        let (stanza, _) = result.unwrap();
        assert!(stanza.contains("<starttls"));
        assert!(stanza.contains("<required/>"));
    }

    #[test]
    fn test_starttls_features_optional() {
        // STARTTLS without <required/> means TLS is optional
        let xml = b"<stream:features><starttls xmlns='urn:ietf:params:xml:ns:xmpp-tls'/><mechanisms xmlns='urn:ietf:params:xml:ns:xmpp-sasl'><mechanism>PLAIN</mechanism></mechanisms></stream:features>";

        let result = extract_stanza(xml);
        assert!(result.is_some());
        let (stanza, _) = result.unwrap();
        assert!(stanza.contains("<starttls"));
        // We still negotiate STARTTLS even when optional (security best practice)
    }

    #[test]
    fn test_starttls_fragmented_stream_and_features() {
        // Test incremental parsing: stream header arrives first, features arrive later
        // This simulates TCP fragmentation

        // Fragment 1: just the stream header
        let frag1 = b"<?xml version='1.0'?><stream:stream xmlns='jabber:client' xmlns:stream='http://etherx.jabber.org/streams' from='example.com' version='1.0'>";
        let result1 = extract_stanza(frag1);
        assert!(result1.is_some());
        let (stanza1, remaining1) = result1.unwrap();
        assert!(stanza1.contains("<stream:stream"));
        assert_eq!(remaining1.len(), 0);

        // Fragment 2: incomplete features
        let frag2 = b"<stream:features><starttls xmlns='urn:ietf:params:xml:ns:xmpp-tls'/>";
        let result2 = extract_stanza(frag2);
        // Should be None — features not complete yet
        assert!(result2.is_none());

        // Fragment 2 + 3: complete features
        let mut combined = Vec::from(&frag2[..]);
        combined.extend_from_slice(b"</stream:features>");
        let result3 = extract_stanza(&combined);
        assert!(result3.is_some());
        let (stanza3, _) = result3.unwrap();
        assert!(stanza3.contains("<stream:features"));
        assert!(stanza3.contains("<starttls"));
        assert!(stanza3.contains("</stream:features>"));
    }

    #[test]
    fn test_starttls_stream_open_format() {
        // Verify the stream open format that perform_starttls sends matches what
        // extract_stanza can parse from the server response
        let proxy_open = "<?xml version='1.0'?><stream:stream to='example.com' version='1.0' xmlns='jabber:client' xmlns:stream='http://etherx.jabber.org/streams'>";
        let result = extract_stanza(proxy_open.as_bytes());
        assert!(result.is_some());
        let (stanza, remaining) = result.unwrap();
        assert!(stanza.contains("<stream:stream"));
        assert!(stanza.contains("to='example.com'"));
        assert_eq!(remaining.len(), 0);
    }

    // --- Cow<str> passthrough tests ---

    #[test]
    fn test_ws_to_tcp_passthrough_is_borrowed() {
        // Regular stanzas should return Cow::Borrowed (zero-copy)
        let stanza = r#"<message to="user@example.com"><body>Hello</body></message>"#;
        let result = translate_ws_to_tcp(stanza);
        assert!(matches!(result, Cow::Borrowed(_)));
        assert_eq!(&*result, stanza);
    }

    #[test]
    fn test_tcp_to_ws_passthrough_is_borrowed() {
        // Regular stanzas should return Cow::Borrowed (zero-copy)
        let stanza = r#"<iq type='result' id='1'><query xmlns='jabber:iq:roster'/></iq>"#;
        let result = translate_tcp_to_ws(stanza);
        assert!(matches!(result, Cow::Borrowed(_)));
        assert_eq!(&*result, stanza);
    }

    #[test]
    fn test_tcp_to_ws_close_is_borrowed() {
        // </stream:stream> → static string, should be Cow::Borrowed
        let result = translate_tcp_to_ws("</stream:stream>");
        assert!(matches!(result, Cow::Borrowed(_)));
    }

    #[test]
    fn test_ws_to_tcp_close_is_borrowed() {
        // <close/> → static string, should be Cow::Borrowed
        let result = translate_ws_to_tcp(r#"<close xmlns="urn:ietf:params:xml:ns:xmpp-framing"/>"#);
        assert!(matches!(result, Cow::Borrowed(_)));
    }

    // --- translate_ws_to_tcp edge case tests ---

    #[test]
    fn test_ws_to_tcp_open_with_single_quotes() {
        // quick-xml handles both quote styles
        let open_tag = r#"<open xmlns='urn:ietf:params:xml:ns:xmpp-framing' to='example.com' version='1.0'/>"#;
        let translated = translate_ws_to_tcp(open_tag);
        assert!(translated.contains("<stream:stream"));
        assert!(translated.contains("to='example.com'"));
        assert!(translated.contains("version='1.0'"));
    }

    #[test]
    fn test_ws_to_tcp_open_without_to() {
        // <open> without a 'to' attribute
        let open_tag = r#"<open xmlns="urn:ietf:params:xml:ns:xmpp-framing" version="1.0"/>"#;
        let translated = translate_ws_to_tcp(open_tag);
        assert!(translated.contains("<stream:stream"));
        assert!(translated.contains("version='1.0'"));
        assert!(!translated.contains("to="));
    }

    #[test]
    fn test_ws_to_tcp_open_with_extra_attributes() {
        // Unknown attributes should be ignored
        let open_tag = r#"<open xmlns="urn:ietf:params:xml:ns:xmpp-framing" to="example.com" version="1.0" custom="foo"/>"#;
        let translated = translate_ws_to_tcp(open_tag);
        assert!(translated.contains("<stream:stream"));
        assert!(translated.contains("to='example.com'"));
        assert!(!translated.contains("custom"));
    }

    // --- nested stream: prefix rewriting test ---

    #[test]
    fn test_tcp_to_ws_stream_error_with_nested_stream_text() {
        // <stream:error> containing <stream:text> — both stream: prefixes should be stripped
        let error = r#"<stream:error><conflict xmlns='urn:ietf:params:xml:ns:xmpp-streams'/><text xmlns='urn:ietf:params:xml:ns:xmpp-streams'>Replaced by new connection</text></stream:error>"#;
        let translated = translate_tcp_to_ws(error);

        assert!(translated.starts_with("<error "));
        assert!(translated.contains(r#"xmlns="http://etherx.jabber.org/streams""#));
        assert!(translated.ends_with("</error>"));
        assert!(!translated.contains("stream:error"));
        assert!(translated.contains("<conflict xmlns="));
        assert!(translated.contains("Replaced by new connection"));
    }

    // --- extract_stanza with CDATA and XML entities ---

    #[test]
    fn test_extract_stanza_with_xml_entities() {
        let xml = b"<message from='a@b' to='c@d'><body>Hello &amp; welcome &lt;friend&gt;</body></message>";
        let result = extract_stanza(xml);
        assert!(result.is_some());
        let (stanza, remaining) = result.unwrap();
        assert!(stanza.contains("&amp;"));
        assert!(stanza.contains("&lt;friend&gt;"));
        assert!(stanza.contains("</message>"));
        assert_eq!(remaining.len(), 0);
    }

    #[test]
    fn test_extract_stanza_with_cdata() {
        let xml = b"<message from='a@b'><body><![CDATA[Some <raw> content & stuff]]></body></message>";
        let result = extract_stanza(xml);
        assert!(result.is_some());
        let (stanza, remaining) = result.unwrap();
        assert!(stanza.contains("CDATA"));
        assert!(stanza.contains("</message>"));
        assert_eq!(remaining.len(), 0);
    }

    // --- ConnectionGuard tests ---

    #[test]
    fn test_connection_guard_decrements_on_drop() {
        let counter = Arc::new(AtomicUsize::new(1));
        {
            let _guard = ConnectionGuard::new(counter.clone());
            assert_eq!(counter.load(Ordering::SeqCst), 1);
        }
        // After guard is dropped, counter should be 0
        assert_eq!(counter.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn test_connection_limit_rejects_second_connection() {
        let counter = Arc::new(AtomicUsize::new(0));

        // Simulate first connection accepted
        let current = counter.fetch_add(1, Ordering::SeqCst);
        assert_eq!(current, 0); // First connection is accepted

        // Simulate second connection attempt
        let current = counter.fetch_add(1, Ordering::SeqCst);
        assert!(current > 0); // Should be rejected
        // Clean up the rejected attempt
        counter.fetch_sub(1, Ordering::SeqCst);

        // Counter should still be 1 (first connection active)
        assert_eq!(counter.load(Ordering::SeqCst), 1);

        // Clean up first connection
        counter.fetch_sub(1, Ordering::SeqCst);
        assert_eq!(counter.load(Ordering::SeqCst), 0);
    }

    // --- TLS connector helper test ---

    #[test]
    fn test_create_tls_connector() {
        init_crypto_provider();
        let result = create_tls_connector();
        assert!(result.is_ok(), "Should create TLS connector with system certs");
    }
}
