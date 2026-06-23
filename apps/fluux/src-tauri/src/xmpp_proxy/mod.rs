mod dns;
mod framing;
mod happy_eyeballs;

use dns::{parse_server_input, resolve_xmpp_server, ConnectionMode, ParsedServer, XmppEndpoint};
use framing::{
    extract_open_to, extract_stanza, extract_stream_error_condition, translate_tcp_to_ws,
    translate_ws_to_tcp,
};

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Instant;
use tauri::Emitter;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Mutex, RwLock};
use tokio::task::JoinHandle;
use tokio_rustls::rustls::pki_types::ServerName;
use tokio_rustls::rustls::{ClientConfig, RootCertStore};
use tokio_rustls::TlsConnector;
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::{accept_hdr_async, tungstenite::Message};
use tracing::{debug, error, info, warn};

/// Loopback bind order for the local WebSocket listener: IPv4 first on all platforms.
///
/// The proxy advertises a literal loopback URL (`ws://HOST:PORT`) that the platform
/// WebView must connect to. Both Windows WebView2 and macOS WKWebView fail to open a
/// WebSocket to a literal IPv6 URL (`ws://[::1]:PORT`) even when IPv6 loopback works
/// fine at the OS level. Binding `127.0.0.1` first means we advertise an IPv4 URL and
/// sidestep that WebView limitation. `[::1]` stays as a fallback for the rare host that
/// has IPv4 loopback disabled.
const LOOPBACK_BIND_ORDER: [(&str, &str); 2] = [("127.0.0.1:0", "127.0.0.1"), ("[::1]:0", "[::1]")];

/// Global flag to disable TLS certificate verification.
/// Set once at startup via `set_dangerous_insecure_tls()` from the CLI `--dangerous-insecure-tls` flag.
static DANGEROUS_INSECURE_TLS: std::sync::OnceLock<bool> = std::sync::OnceLock::new();

/// Set the insecure TLS flag (called once from main.rs at startup).
pub fn set_dangerous_insecure_tls(enabled: bool) {
    let _ = DANGEROUS_INSECURE_TLS.set(enabled);
}

fn is_insecure_tls() -> bool {
    DANGEROUS_INSECURE_TLS.get().copied().unwrap_or(false)
}

/// TCP connection timeout for outbound XMPP server connections.
///
/// Applied to both STARTTLS (port 5222) and direct TLS (port 5223) TCP connect calls.
/// Without this, the OS default applies — which on Windows can be 30-120 seconds for
/// unreachable hosts, leaving the user with no feedback.
///
/// 15 seconds is generous enough for high-latency international connections but short
/// enough to provide timely failure feedback. The STARTTLS negotiation phase has its
/// own separate 10-second timeout (see `perform_starttls`).
const TCP_CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// Total budget for establishing the upstream TLS connection across ALL
/// resolved endpoints. Happy Eyeballs only bounds the race WITHIN one host, so
/// without an overall cap a domain whose SRV records all black-hole would stall
/// ~N × TCP_CONNECT_TIMEOUT (e.g. 4 records → ~60s). Each endpoint still gets up
/// to TCP_CONNECT_TIMEOUT, but the sum is capped here. 30s leaves room for a
/// full first attempt plus a fallback while bounding the pathological case.
const OVERALL_CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Timeout waiting for the first client stanza after WebSocket handshake.
///
/// The proxy now waits for the initial `<open/>` from the client before starting
/// DNS/TCP/STARTTLS work. This avoids unnecessary outbound work for stale sockets
/// that disconnect immediately after handshake.
const INITIAL_CLIENT_STANZA_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// Inactivity watchdog timeout for the WebSocket-TLS bridge.
///
/// If no data flows in either direction for this duration, the connection is
/// force-closed. This prevents zombie connections from consuming resources.
///
/// 5 minutes is generous: XMPP with XEP-0198 Stream Management sends periodic
/// `<r/>` pings (typically every 60-90 seconds). A 5-minute silence means the
/// connection is definitively dead, not just quiet.
const BRIDGE_INACTIVITY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

/// How often the watchdog checks for inactivity.
/// Checking every 30 seconds is lightweight and provides reasonable granularity.
const WATCHDOG_CHECK_INTERVAL: std::time::Duration = std::time::Duration::from_secs(30);

/// Maximum allowed size for the TLS-to-WebSocket stanza extraction buffer.
///
/// If the buffer exceeds this limit after stanza extraction, the connection is
/// closed. This prevents unbounded memory growth when the server sends data
/// that never forms a complete stanza (malformed XML, malicious input, or
/// protocol errors).
///
/// 1 MB is generous for XMPP: typical stanzas are a few KB. The largest
/// legitimate stanzas (vCard avatars, MAM result pages) rarely exceed 100 KB.
const MAX_STANZA_BUFFER_SIZE: usize = 1_024 * 1_024;

/// Monotonic connection id for correlating proxy logs across tasks and frontend events.
static NEXT_PROXY_CONNECTION_ID: AtomicU64 = AtomicU64::new(1);

/// Current time as milliseconds since UNIX epoch (for activity tracking).
fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Maximum payload for a WebSocket close-frame reason: control frames cap at
/// 125 bytes and the status code consumes the first 2.
const MAX_CLOSE_REASON_BYTES: usize = 123;

/// Truncate a close-frame reason to the WebSocket byte limit on a UTF-8 char
/// boundary, so we never emit an over-long control frame or split a codepoint.
fn clamp_close_reason(mut reason: String) -> String {
    if reason.len() <= MAX_CLOSE_REASON_BYTES {
        return reason;
    }
    let mut end = MAX_CLOSE_REASON_BYTES;
    while end > 0 && !reason.is_char_boundary(end) {
        end -= 1;
    }
    reason.truncate(end);
    reason
}

/// Build the WebSocket close-frame reason sent to the client on bridge teardown.
///
/// Historically this was a constant `"Bridge closed"`, which told the user
/// nothing about *why* the connection dropped. We now encode the real cause:
/// a relayed upstream stream-error condition (e.g. `host-unknown`,
/// `see-other-host`) when one was seen — the single most actionable signal —
/// otherwise the transport-level end reason (`TlsClosed`, `WatchdogTimeout`, …).
/// The `"Bridge closed"` prefix is preserved so existing client-side detection
/// keeps working.
fn format_bridge_close_reason(end_reason_label: &str, stream_error: Option<&str>) -> String {
    let reason = match stream_error {
        Some(cond) => format!("Bridge closed: stream-error {cond}"),
        None => format!("Bridge closed: {end_reason_label}"),
    };
    clamp_close_reason(reason)
}

/// Extract the stream-error condition that an upstream-connect failure encodes.
///
/// `perform_starttls` formats a relayed upstream `<stream:error>` as
/// "… stream-error: <condition>" (e.g. `host-unknown`). `connect_upstream_tls`
/// aggregates endpoint failures into one string that preserves that substring,
/// so the connection handler can recover the condition for the WebSocket close
/// reason. Returns `None` for plain transport failures (timeouts, refused
/// connections, TLS errors), which carry no stream-level condition.
fn stream_error_condition_from_error(message: &str) -> Option<String> {
    const MARKER: &str = "stream-error: ";
    let start = message.find(MARKER)? + MARKER.len();
    let rest = &message[start..];
    // Conditions are XML element local names (e.g. `host-unknown`,
    // `see-other-host`) — no whitespace — so the first whitespace ends it.
    let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
    let condition = rest[..end].trim();
    if condition.is_empty() {
        None
    } else {
        Some(condition.to_string())
    }
}

/// Classify a rustls/transport error string into a stable transport-error class
/// used in the WebSocket close reason (recovered by `transport_error_class_from_error`).
/// Certificate failures are sub-classified so the UI can tailor its guidance.
/// Matching is substring/lower-cased and falls back to `"certificate"` / `"other"`.
fn classify_tls_error(error_detail: &str) -> &'static str {
    let lower = error_detail.to_lowercase();
    if lower.contains("certificate") || lower.contains("cert ") {
        if lower.contains("expired") {
            "certificate-expired"
        } else if lower.contains("notvalidforname") || lower.contains("not valid for") {
            "certificate-name-mismatch"
        } else if lower.contains("unknownissuer")
            || lower.contains("unknown issuer")
            || lower.contains("self-signed")
            || lower.contains("self signed")
        {
            "certificate-untrusted"
        } else {
            "certificate"
        }
    } else if lower.contains("timed out") || lower.contains("timeout") {
        "timeout"
    } else if lower.contains("refused") || lower.contains("reset") {
        "refused"
    } else {
        "other"
    }
}

/// Extract the transport-error class that an upstream-connect failure encodes.
///
/// `upgrade_to_tls` embeds `tls-error: <class>` in its error string (mirroring
/// how `perform_starttls` embeds `stream-error: <cond>`); `connect_first_endpoint`
/// aggregates endpoint failures into one string that preserves the substring.
/// Returns the class (e.g. `certificate-expired`), or `None` when no transport
/// class marker is present.
fn transport_error_class_from_error(message: &str) -> Option<String> {
    const MARKER: &str = "tls-error: ";
    let start = message.find(MARKER)? + MARKER.len();
    let rest = &message[start..];
    // The class is delimited by the next whitespace or closing paren
    // (the marker is embedded as "(tls-error: <class>): ...").
    let end = rest
        .find(|c: char| c.is_whitespace() || c == ')')
        .unwrap_or(rest.len());
    let class = rest[..end].trim();
    if class.is_empty() {
        None
    } else {
        Some(class.to_string())
    }
}

/// Send the RFC 7395 `<close/>` plus a WebSocket close frame carrying `reason`,
/// so the client (xmpp.js) gets a deterministic disconnect with the real cause
/// instead of an abrupt socket drop. Best-effort, bounded by a short timeout.
///
/// Used for pre-bridge upstream failures; the bridge teardown path has its own
/// equivalent close handshake on the split sink.
async fn send_close_with_reason(
    ws: &mut tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
    reason: String,
) {
    let _ = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        let _ = ws
            .send(Message::Text(
                r#"<close xmlns="urn:ietf:params:xml:ns:xmpp-framing"/>"#.into(),
            ))
            .await;
        let _ = ws
            .send(Message::Close(Some(CloseFrame {
                code: CloseCode::Normal,
                reason: reason.into(),
            })))
            .await;
    })
    .await;
}

/// Initialize rustls crypto provider (must be called once at startup)
fn init_crypto_provider() {
    use std::sync::Once;
    static INIT: Once = Once::new();

    INIT.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

/// TLS certificate verifier that accepts all certificates without validation.
///
/// **DANGEROUS**: Only used when `--dangerous-insecure-tls` CLI flag is set.
/// Intended for development/testing against servers with self-signed certificates.
#[derive(Debug)]
struct InsecureCertVerifier(Arc<rustls::crypto::CryptoProvider>);

impl rustls::client::danger::ServerCertVerifier for InsecureCertVerifier {
    fn verify_server_cert(
        &self,
        _end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

/// Create a TLS connector using the system's native root certificates.
///
/// Used by both `DirectTls` connections and `STARTTLS` upgrades to avoid
/// duplicating the TLS setup logic.
///
/// When `--dangerous-insecure-tls` is set, certificate verification is skipped entirely.
fn create_tls_connector() -> Result<TlsConnector, String> {
    if is_insecure_tls() {
        warn!("TLS certificate verification DISABLED (--dangerous-insecure-tls)");
        let provider = rustls::crypto::ring::default_provider();
        let config = ClientConfig::builder()
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(InsecureCertVerifier(Arc::new(provider))))
            .with_no_client_auth();
        return Ok(TlsConnector::from(Arc::new(config)));
    }

    let mut root_store = RootCertStore::empty();
    let native_certs = rustls_native_certs::load_native_certs();
    if native_certs.certs.is_empty() {
        return Err(
            "No system root certificates found. TLS connections will fail. \
            Ensure CA certificates are installed (e.g., ca-certificates package on Linux)."
                .to_string(),
        );
    }
    for cert in native_certs.certs {
        root_store
            .add(cert)
            .map_err(|e| format!("Failed to add cert: {}", e))?;
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

    connector
        .connect(server_name, tcp_stream)
        .await
        .map_err(|e| {
            let error_detail = format!("{}", e);
            let class = classify_tls_error(&error_detail);
            error!(host, error = %e, error_class = class, "TLS handshake failed");
            // Embed a stable `tls-error: <class>` marker so the connection
            // handler can recover the class for the WebSocket close reason.
            // The marker survives the `connect_first_endpoint` aggregation.
            format!("TLS handshake failed with {} (tls-error: {}): {}", host, class, e)
        })
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

/// Result of starting the XMPP proxy, returned to the frontend.
///
/// The proxy is always-on: started once and reused across reconnects.
/// DNS/SRV resolution happens per WebSocket connection, not at proxy start.
#[derive(Debug, Clone, Serialize)]
pub struct ProxyStartResult {
    /// Local WebSocket URL to connect to (e.g., "ws://127.0.0.1:12345")
    pub url: String,
}

/// XMPP WebSocket-to-TCP proxy state.
///
/// The proxy is always-on: it binds a local WebSocket listener once and keeps it
/// running. Each incoming WebSocket connection independently resolves DNS/SRV and
/// creates its own TCP/TLS connection to the XMPP server.
pub struct XmppProxy {
    /// Server input string this proxy was started for (for idempotent reuse)
    server_input: String,
    /// Full local WebSocket URL (e.g., "ws://127.0.0.1:12345")
    ws_url: String,
    /// Local WebSocket server address
    local_addr: Option<SocketAddr>,
    /// Background task handle
    task: Option<JoinHandle<()>>,
    /// Shutdown signal
    shutdown_tx: Option<tokio::sync::broadcast::Sender<()>>,
    /// Active connection counter (for diagnostics/logging)
    active_connections: Arc<AtomicUsize>,
    /// Tauri app handle for emitting events to the frontend
    app_handle: Option<tauri::AppHandle>,
}

impl XmppProxy {
    pub fn new() -> Self {
        Self {
            server_input: String::new(),
            ws_url: String::new(),
            local_addr: None,
            task: None,
            shutdown_tx: None,
            active_connections: Arc::new(AtomicUsize::new(0)),
            app_handle: None,
        }
    }

    /// Set the Tauri app handle for emitting events to the frontend.
    pub fn set_app_handle(&mut self, handle: tauri::AppHandle) {
        self.app_handle = Some(handle);
    }

    /// Start the proxy server.
    ///
    /// Binds a local WebSocket listener. DNS/SRV resolution is deferred to
    /// each incoming WebSocket connection (fresh resolution per connect).
    ///
    /// The `server` parameter supports multiple formats:
    /// - `tls://host:port` or `tcp://host:port` — explicit endpoint, skip SRV
    /// - `host:port` — explicit endpoint, mode inferred from port (5223=TLS, else STARTTLS)
    /// - `domain` — SRV resolution with fallback to domain:5222 STARTTLS
    pub async fn start(&mut self, server: String) -> Result<ProxyStartResult, String> {
        if self.local_addr.is_some() {
            return Err("Proxy already running".to_string());
        }

        info!(server = %server, "Starting proxy (DNS resolution deferred to per-connection)");

        // Bind to loopback on a random port (IPv4 first; see LOOPBACK_BIND_ORDER).
        let mut bind_errors = Vec::new();
        let mut bound = None;
        for (bind_addr, host) in LOOPBACK_BIND_ORDER {
            match TcpListener::bind(bind_addr).await {
                Ok(listener) => {
                    info!(bind_addr, host, "WebSocket server bound to loopback");
                    bound = Some((listener, host));
                    break;
                }
                Err(err) => {
                    debug!(bind_addr, error = %err, "Loopback bind attempt failed");
                    bind_errors.push(format!("{}: {}", bind_addr, err));
                }
            }
        }
        let (listener, loopback_host) = bound.ok_or_else(|| {
            format!(
                "Failed to bind WebSocket server on loopback ({})",
                bind_errors.join(", ")
            )
        })?;

        let local_addr = listener
            .local_addr()
            .map_err(|e| format!("Failed to get local address: {}", e))?;

        self.local_addr = Some(local_addr);
        let ws_url = format!("ws://{}:{}", loopback_host, local_addr.port());
        self.ws_url = ws_url.clone();
        self.server_input = server.clone();

        // Create shutdown channel
        let (shutdown_tx, _) = tokio::sync::broadcast::channel(1);
        self.shutdown_tx = Some(shutdown_tx.clone());

        // Clone connection counter for the background task
        let active_connections = self.active_connections.clone();
        let app_handle = self.app_handle.clone();

        // Spawn background task to handle connections.
        // Each connection independently resolves DNS/SRV using the server string.
        let server_for_task = Arc::new(server);
        let task = tokio::spawn(async move {
            let mut shutdown_rx = shutdown_tx.subscribe();

            loop {
                tokio::select! {
                    Ok((stream, addr)) = listener.accept() => {
                        info!(addr = %addr, "New WebSocket connection");
                        let server_str = server_for_task.clone();
                        let shutdown = shutdown_tx.subscribe();
                        let conn_counter = active_connections.clone();
                        let handle = app_handle.clone();

                        tokio::spawn(async move {
                            if let Err(e) = handle_connection(stream, &server_str, shutdown, conn_counter, handle).await {
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

        Ok(ProxyStartResult { url: ws_url })
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

/// Handle a single WebSocket <-> XMPP server connection.
///
/// Each connection independently resolves DNS/SRV using the server string,
/// creates its own TCP/TLS connection, and bridges WS ↔ TLS.
async fn handle_connection(
    ws_stream: tokio::net::TcpStream,
    server_input: &str,
    mut shutdown: tokio::sync::broadcast::Receiver<()>,
    active_connections: Arc<AtomicUsize>,
    app_handle: Option<tauri::AppHandle>,
) -> Result<(), String> {
    let conn_id = NEXT_PROXY_CONNECTION_ID.fetch_add(1, Ordering::Relaxed);
    let connection_started = Instant::now();
    info!(conn_id, server_input = %server_input, "Proxy connection handling started");

    // Track active connections for diagnostics (no connection limit)
    active_connections.fetch_add(1, Ordering::SeqCst);
    let _guard = ConnectionGuard::new(active_connections.clone());

    // Upgrade to WebSocket, echoing any requested subprotocol (e.g. "xmpp" per RFC 7395).
    // Browsers reject the connection if the server does not echo the Sec-WebSocket-Protocol
    // header back when the client sends one.
    #[allow(clippy::result_large_err)]
    let mut ws = accept_hdr_async(ws_stream, |req: &Request, mut resp: Response| {
        if let Some(protocol) = req.headers().get("Sec-WebSocket-Protocol") {
            resp.headers_mut()
                .insert("Sec-WebSocket-Protocol", protocol.clone());
        }
        Ok(resp)
    })
    .await
    .map_err(|e| format!("WebSocket handshake failed: {}", e))?;

    info!(conn_id, "WebSocket connection established");

    // Wait for the initial client stanza before doing expensive network work.
    // This avoids DNS/TCP/STARTTLS churn when stale sockets disconnect immediately.
    let initial_wait_started = Instant::now();
    let initial_ws_text = match wait_for_initial_client_stanza(&mut ws).await? {
        Some(text) => text,
        None => {
            info!(
                conn_id,
                wait_ms = initial_wait_started.elapsed().as_millis() as u64,
                "WebSocket closed before initial client stanza"
            );
            return Ok(());
        }
    };
    info!(
        conn_id,
        wait_ms = initial_wait_started.elapsed().as_millis() as u64,
        "Received initial client stanza"
    );

    // The client's initial <open to='…'/> carries the JID's service domain.
    // Use it as the STARTTLS `to=` / TLS SNI for explicit endpoints, where the
    // connection host may legitimately differ from the XMPP domain
    // (e.g. tcp://chat.process-one.net for JID me@process-one.net).
    let client_domain = extract_open_to(&initial_ws_text);

    // Buffer client text frames received while upstream connect/STARTTLS is in progress.
    // They are flushed to TLS once the bridge starts.
    let mut pending_ws_texts = vec![initial_ws_text];

    let upstream_connect_started = Instant::now();
    let connect_future = connect_upstream_tls(server_input, client_domain.as_deref());
    tokio::pin!(connect_future);

    let tls_stream = loop {
        tokio::select! {
            result = &mut connect_future => {
                match result {
                    Ok(tls_stream) => {
                        info!(
                            conn_id,
                            connect_ms = upstream_connect_started.elapsed().as_millis() as u64,
                            "Upstream TLS connected"
                        );
                        break tls_stream;
                    }
                    Err(err) => {
                        // Upstream connect/STARTTLS failed before the bridge could
                        // start. Don't just drop the WebSocket — xmpp.js would report
                        // a misleading "WebSocket ECONNERROR". Send a clean close
                        // carrying the real cause: a relayed stream-error condition
                        // (e.g. host-unknown) when the server reported one, else the
                        // transport message.
                        let condition = stream_error_condition_from_error(&err);
                        // No stream-error condition? Fall back to a transport
                        // class (TLS/cert, timeout, refused) so the client can
                        // render specific error UX. Stream errors still win.
                        let label = if condition.is_some() {
                            "UpstreamConnectFailed".to_string()
                        } else if let Some(class) = transport_error_class_from_error(&err) {
                            format!("tls-error {class}")
                        } else {
                            "UpstreamConnectFailed".to_string()
                        };
                        let reason = format_bridge_close_reason(&label, condition.as_deref());
                        warn!(
                            conn_id,
                            error = %err,
                            stream_error = ?condition,
                            connect_ms = upstream_connect_started.elapsed().as_millis() as u64,
                            "Upstream connection failed; closing WebSocket with reason"
                        );
                        send_close_with_reason(&mut ws, reason).await;
                        return Ok(());
                    }
                }
            }
            msg = ws.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        pending_ws_texts.push(text.to_string());
                    }
                    Some(Ok(Message::Close(_))) => {
                        info!(
                            conn_id,
                            setup_ms = upstream_connect_started.elapsed().as_millis() as u64,
                            "WebSocket closed by client during upstream connection setup"
                        );
                        return Ok(());
                    }
                    Some(Err(e)) => {
                        info!(
                            conn_id,
                            error = %e,
                            setup_ms = upstream_connect_started.elapsed().as_millis() as u64,
                            "WebSocket read error during upstream connection setup"
                        );
                        return Ok(());
                    }
                    Some(_) => {}
                    None => {
                        info!(
                            conn_id,
                            setup_ms = upstream_connect_started.elapsed().as_millis() as u64,
                            "WebSocket closed during upstream connection setup"
                        );
                        return Ok(());
                    }
                }
            }
            _ = shutdown.recv() => {
                info!(
                    conn_id,
                    setup_ms = upstream_connect_started.elapsed().as_millis() as u64,
                    "Connection closed by shutdown before upstream connection setup completed"
                );
                return Ok(());
            }
        }
    };

    let bridge_result = bridge_websocket_tls(
        ws,
        tls_stream,
        shutdown,
        app_handle,
        pending_ws_texts,
        conn_id,
    )
    .await;
    info!(
        conn_id,
        total_ms = connection_started.elapsed().as_millis() as u64,
        ok = bridge_result.is_ok(),
        "Proxy connection handling finished"
    );
    bridge_result
}

/// Wait for the first client text stanza after WebSocket handshake.
async fn wait_for_initial_client_stanza(
    ws: &mut tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
) -> Result<Option<String>, String> {
    let read_deadline = tokio::time::Instant::now() + INITIAL_CLIENT_STANZA_TIMEOUT;

    loop {
        let remaining = read_deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Err(format!(
                "Timed out after {}s waiting for initial client stanza",
                INITIAL_CLIENT_STANZA_TIMEOUT.as_secs()
            ));
        }

        let msg = tokio::time::timeout(remaining, ws.next())
            .await
            .map_err(|_| {
                format!(
                    "Timed out after {}s waiting for initial client stanza",
                    INITIAL_CLIENT_STANZA_TIMEOUT.as_secs()
                )
            })?;

        match msg {
            Some(Ok(Message::Text(text))) => return Ok(Some(text.to_string())),
            Some(Ok(Message::Close(_))) => return Ok(None),
            Some(Err(e)) => {
                info!(error = %e, "WebSocket read error before initial client stanza");
                return Ok(None);
            }
            Some(_) => {}
            None => return Ok(None),
        }
    }
}

/// Attempt to connect to a single XMPP endpoint (TCP + TLS or TCP + STARTTLS).
///
/// The TCP connection is established with Happy Eyeballs (RFC 8305): every
/// resolved address is raced rather than tried strictly sequentially, so a
/// black-holed IPv6 address (common on networks that advertise IPv6 without a
/// working route) no longer consumes the whole `TCP_CONNECT_TIMEOUT` before the
/// reachable IPv4 address is attempted. See [`happy_eyeballs`].
async fn try_connect_endpoint(
    endpoint: &XmppEndpoint,
) -> Result<tokio_rustls::client::TlsStream<TcpStream>, String> {
    let tcp_stream = happy_eyeballs::connect_tcp(
        &endpoint.host,
        endpoint.port,
        happy_eyeballs::CONNECTION_ATTEMPT_DELAY,
        TCP_CONNECT_TIMEOUT,
    )
    .await?;

    match endpoint.mode {
        ConnectionMode::Tcp => {
            info!(host = %endpoint.host, port = endpoint.port, "Connected (TCP), performing STARTTLS");
            let tls_stream =
                perform_starttls(tcp_stream, endpoint.tls_name(), &endpoint.host).await?;
            info!(host = %endpoint.host, port = endpoint.port, "STARTTLS upgrade complete");
            Ok(tls_stream)
        }
        ConnectionMode::DirectTls => {
            let tls_stream = upgrade_to_tls(tcp_stream, endpoint.tls_name()).await?;
            info!(host = %endpoint.host, port = endpoint.port,
                tls_name = endpoint.tls_name(), "Connected (direct TLS)");
            Ok(tls_stream)
        }
    }
}

/// Try each resolved endpoint in priority order until one connects, bounded by
/// an OVERALL deadline so a domain with several black-holed SRV records can't
/// stall ~N × `per_attempt_timeout`.
///
/// Each attempt gets `per_attempt_timeout`, but never more than the time left in
/// `overall_timeout` — and once the budget is spent the remaining endpoints are
/// skipped. The per-attempt cap wraps the WHOLE attempt (TCP race + TLS
/// handshake), so a hung TLS handshake can't escape the budget either.
///
/// Generic over the connect step purely so it can be unit-tested with a fake
/// connector under paused time; production passes [`try_connect_endpoint`].
async fn connect_first_endpoint<T, F, Fut>(
    endpoints: &[XmppEndpoint],
    overall_timeout: std::time::Duration,
    per_attempt_timeout: std::time::Duration,
    mut connect: F,
) -> Result<T, String>
where
    // Owned (cloned) endpoint, not a reference: a closure returning a future that
    // borrows its argument can't be expressed without HRTB gymnastics. Cloning a
    // resolved endpoint (a few small strings) per attempt is negligible.
    F: FnMut(XmppEndpoint) -> Fut,
    Fut: std::future::Future<Output = Result<T, String>>,
{
    // tokio::time::Instant (not std) so the deadline honours paused time in tests
    // and the runtime clock in production.
    let overall_deadline = tokio::time::Instant::now() + overall_timeout;
    let endpoint_count = endpoints.len();
    let mut errors: Vec<String> = Vec::new();

    for (i, endpoint) in endpoints.iter().enumerate() {
        let attempt = i + 1;
        let remaining = overall_deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            warn!(
                attempted = i, total = endpoint_count,
                "Overall connect budget exhausted; skipping remaining endpoint(s)"
            );
            errors.push(format!(
                "overall connect timeout ({}s) reached after {} of {} endpoint(s)",
                overall_timeout.as_secs(), i, endpoint_count
            ));
            break;
        }
        let attempt_timeout = remaining.min(per_attempt_timeout);
        info!(
            attempt, total = endpoint_count,
            host = %endpoint.host, port = endpoint.port,
            mode = ?endpoint.mode, tls_name = endpoint.tls_name(),
            "Trying endpoint"
        );

        match tokio::time::timeout(attempt_timeout, connect(endpoint.clone())).await {
            Ok(Ok(stream)) => {
                if attempt > 1 {
                    info!(
                        attempt, total = endpoint_count,
                        host = %endpoint.host, port = endpoint.port,
                        "Connected after {} failed attempt(s)", attempt - 1
                    );
                }
                return Ok(stream);
            }
            Ok(Err(e)) => {
                if attempt < endpoint_count {
                    warn!(
                        attempt, total = endpoint_count,
                        host = %endpoint.host, port = endpoint.port,
                        mode = ?endpoint.mode, error = %e,
                        "Endpoint failed, trying next"
                    );
                } else {
                    error!(
                        attempt, total = endpoint_count,
                        host = %endpoint.host, port = endpoint.port,
                        mode = ?endpoint.mode, error = %e,
                        "Endpoint failed, no more endpoints"
                    );
                }
                errors.push(format!(
                    "{}:{} ({:?}): {}",
                    endpoint.host, endpoint.port, endpoint.mode, e
                ));
            }
            Err(_elapsed) => {
                warn!(
                    attempt, total = endpoint_count,
                    host = %endpoint.host, port = endpoint.port,
                    timeout_s = attempt_timeout.as_secs(),
                    "Endpoint attempt timed out"
                );
                errors.push(format!(
                    "{}:{} ({:?}): timed out after {}s",
                    endpoint.host, endpoint.port, endpoint.mode, attempt_timeout.as_secs()
                ));
            }
        }
    }

    Err(format!(
        "All {} endpoint(s) failed:\n  - {}",
        errors.len(),
        errors.join("\n  - ")
    ))
}

/// Resolve upstream endpoint(s) and establish a TLS stream (direct TLS or STARTTLS).
///
/// For explicit endpoints (`tls://`, `tcp://`, `host:port`), tries a single connection.
/// For bare domains, resolves all SRV records and tries each in priority order,
/// falling through to the next endpoint on TCP or TLS failure (bounded by an
/// overall connect budget — see [`connect_first_endpoint`]).
async fn connect_upstream_tls(
    server_input: &str,
    client_domain: Option<&str>,
) -> Result<tokio_rustls::client::TlsStream<TcpStream>, String> {
    // Resolve DNS/SRV per connection (fresh resolution handles DNS changes after sleep)
    let resolve_started = Instant::now();
    let endpoints = match parse_server_input(server_input) {
        ParsedServer::Direct(host, port, mode, domain) => {
            // Domain precedence: explicit `?domain=` override → client `<open to=>`
            // (the JID's domain) → None (falls back to the connection host).
            let domain = domain.or_else(|| client_domain.map(|d| d.to_string()));
            info!(host = %host, port, mode = ?mode, domain = ?domain, "Using explicit endpoint");
            vec![XmppEndpoint {
                host,
                port,
                mode,
                domain,
            }]
        }
        ParsedServer::Domain(domain) => resolve_xmpp_server(&domain)
            .await
            .map_err(|e| format!("Failed to resolve XMPP server: {}", e))?,
    };

    let dns_resolve_ms = resolve_started.elapsed().as_millis() as u64;
    let endpoint_count = endpoints.len();
    info!(endpoint_count, dns_resolve_ms, "Resolved endpoints, attempting connections");

    // Try each endpoint in priority order, capped by an overall budget so a
    // multi-record domain that black-holes can't stall ~N × TCP_CONNECT_TIMEOUT.
    connect_first_endpoint(
        &endpoints,
        OVERALL_CONNECT_TIMEOUT,
        TCP_CONNECT_TIMEOUT,
        |endpoint| async move { try_connect_endpoint(&endpoint).await },
    )
    .await
}

/// Perform XMPP STARTTLS negotiation on a plain TCP connection.
///
/// This function handles the STARTTLS upgrade transparently so that xmpp.js
/// (which cannot perform STARTTLS over WebSocket) sees a ready-to-use TLS connection.
///
/// - `domain`: XMPP domain for the `to=` attribute and TLS SNI (e.g., "diebesban.de")
/// - `host`: TCP connection target for logging (e.g., "v4.mdosch.de")
///
/// Protocol flow:
/// 1. Send `<stream:stream>` to server (using XMPP domain in `to=`)
/// 2. Read server's `<stream:stream>` response + `<stream:features>` (must contain `<starttls>`)
/// 3. Send `<starttls xmlns='urn:ietf:params:xml:ns:xmpp-tls'/>`
/// 4. Read `<proceed/>` response
/// 5. Upgrade TCP socket to TLS via `TlsConnector::connect()` (using XMPP domain for SNI)
///
/// After this, xmpp.js sends its own `<open/>` which the proxy translates to a fresh
/// `<stream:stream>` over the now-encrypted connection.
async fn perform_starttls(
    mut tcp_stream: TcpStream,
    domain: &str,
    host: &str,
) -> Result<tokio_rustls::client::TlsStream<TcpStream>, String> {
    // Step 1: Send stream opening to server (use XMPP domain for `to=` attribute)
    let stream_open = format!(
        "<?xml version='1.0'?><stream:stream to='{}' version='1.0' xmlns='jabber:client' xmlns:stream='http://etherx.jabber.org/streams'>",
        domain
    );
    debug!(domain, host, "STARTTLS: Sending stream open");
    tcp_stream
        .write_all(stream_open.as_bytes())
        .await
        .map_err(|e| format!("STARTTLS: Failed to send stream open: {}", e))?;
    tcp_stream
        .flush()
        .await
        .map_err(|e| format!("STARTTLS: Failed to flush stream open: {}", e))?;

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
        let mut consumed = 0;
        while let Some((stanza, bytes_used)) = extract_stanza(&buffer[consumed..]) {
            consumed += bytes_used;
            debug!(stanza = %stanza, "STARTTLS: Extracted stanza");

            if stanza.contains("<stream:stream") {
                // Server's stream header — consume and continue
                got_stream_header = true;
                continue;
            }

            if stanza.contains("<stream:features") || stanza.contains("<features") {
                features_xml = stanza;
                break;
            }

            // A <stream:error> (e.g. host-unknown, when the connection host serves
            // a different vhost than the JID domain) terminates the stream. Surface
            // the condition so the connection handler can tell the user *why*,
            // instead of letting it look like a generic transport failure.
            if let Some(condition) = extract_stream_error_condition(&stanza) {
                warn!(condition = %condition, "STARTTLS: server returned stream error");
                return Err(format!("STARTTLS: server stream-error: {condition}"));
            }

            // Unexpected stanza before features
            warn!(stanza = %stanza, "STARTTLS: Unexpected stanza before features");
        }
        if consumed > 0 {
            buffer.drain(..consumed);
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
    tcp_stream
        .write_all(starttls_request.as_bytes())
        .await
        .map_err(|e| format!("STARTTLS: Failed to send starttls request: {}", e))?;
    tcp_stream
        .flush()
        .await
        .map_err(|e| format!("STARTTLS: Failed to flush starttls request: {}", e))?;
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

        if let Some((stanza, _)) = extract_stanza(&buffer) {
            proceed_xml = stanza;
            break;
        }
    }

    if proceed_xml.contains("<failure") {
        return Err(format!(
            "STARTTLS: Server rejected STARTTLS: {}",
            proceed_xml
        ));
    }

    if !proceed_xml.contains("<proceed") {
        return Err(format!(
            "STARTTLS: Unexpected response (expected <proceed/>): {}",
            proceed_xml
        ));
    }
    info!(
        domain,
        host, "STARTTLS: Received <proceed/>, upgrading to TLS"
    );

    // Step 5: Upgrade TCP socket to TLS (use XMPP domain for SNI, not connection host)
    let tls_stream = upgrade_to_tls(tcp_stream, domain)
        .await
        .map_err(|e| format!("STARTTLS: {}", e))?;

    info!(domain, host, "STARTTLS: TLS handshake complete");
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
    app_handle: Option<tauri::AppHandle>,
    pending_ws_texts: Vec<String>,
    conn_id: u64,
) -> Result<(), String> {
    #[derive(Debug, Clone, Serialize)]
    struct ProxyConnectionClosedEvent {
        conn_id: u64,
        reason: String,
        /// Upstream stream-error condition (e.g. "host-unknown"), when the server
        /// reported one before closing. `None` for plain transport-level closes.
        stream_error: Option<String>,
    }

    let bridge_started = Instant::now();
    info!(
        conn_id,
        buffered_frames = pending_ws_texts.len(),
        "Bridge started"
    );

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum BridgeEndReason {
        WebSocketClosedByClient,
        WebSocketReadError,
        TlsClosed,
        TlsReadError,
        WatchdogTimeout,
        Shutdown,
    }

    let (ws_write, mut ws_read) = ws.split();
    let (mut tls_read, mut tls_write) = tokio::io::split(tls_stream);

    // Wrap ws_write in Arc<Mutex<>> so the cleanup code can send a close frame
    // after aborting the tls_to_ws task that normally holds ws_write.
    let ws_write = Arc::new(Mutex::new(ws_write));

    // Shared activity timestamp for inactivity watchdog (epoch millis)
    let last_activity = Arc::new(AtomicU64::new(now_millis()));

    // Most recent upstream stream-error condition (if any), captured by the
    // TLS→WS task and read at teardown so we can report *why* the server closed.
    let last_stream_error = Arc::new(std::sync::Mutex::new(None::<String>));

    // Flush any buffered client text stanzas collected before bridge startup.
    for text in pending_ws_texts {
        let translated = translate_ws_to_tcp(&text);
        debug!(data = %translated, "WS->TLS translated (buffered pre-bridge)");
        tls_write
            .write_all(translated.as_bytes())
            .await
            .map_err(|e| format!("Failed to write buffered client stanza to TLS: {}", e))?;
        last_activity.store(now_millis(), Ordering::Relaxed);
    }

    // Task 1: WebSocket -> TLS (translate RFC 7395 WebSocket framing to traditional XMPP)
    let activity_ws = last_activity.clone();
    let mut ws_to_tls = tokio::spawn(async move {
        while let Some(msg) = ws_read.next().await {
            match msg {
                Ok(Message::Text(text)) => {
                    debug!(data = %text, "WS->TLS");

                    // Translate WebSocket framing (RFC 7395) to traditional XMPP
                    let translated = translate_ws_to_tcp(&text);

                    debug!(data = %translated, "WS->TLS translated");

                    if let Err(e) = tls_write.write_all(translated.as_bytes()).await {
                        error!(error = %e, "WS->TLS write error");
                        return BridgeEndReason::TlsReadError;
                    }
                    activity_ws.store(now_millis(), Ordering::Relaxed);
                }
                Ok(Message::Close(_)) => {
                    info!("WebSocket closed by client");
                    return BridgeEndReason::WebSocketClosedByClient;
                }
                Err(e) => {
                    error!(error = %e, "WebSocket read error");
                    return BridgeEndReason::WebSocketReadError;
                }
                _ => {}
            }
        }
        BridgeEndReason::WebSocketClosedByClient
    });

    // Task 2: TLS -> WebSocket (requires stanza boundary detection)
    let activity_tls = last_activity.clone();
    let stream_error_capture = last_stream_error.clone();
    let ws_write_for_tls = ws_write.clone();
    let mut tls_to_ws = tokio::spawn(async move {
        let mut buffer = Vec::new();
        let mut read_buf = [0u8; 8192];

        loop {
            // Read from TLS
            match tls_read.read(&mut read_buf).await {
                Ok(0) => {
                    info!("TLS connection closed");
                    return BridgeEndReason::TlsClosed;
                }
                Ok(n) => {
                    buffer.extend_from_slice(&read_buf[..n]);

                    debug!(bytes = n, "Received from TLS");

                    // Extract complete stanzas from buffer and translate to RFC 7395.
                    // Track consumed offset to avoid O(n²) memmoves — compact once at the end.
                    let mut consumed = 0;
                    while let Some((stanza, bytes_used)) = extract_stanza(&buffer[consumed..]) {
                        consumed += bytes_used;
                        // Remember any stream-error condition so teardown can report
                        // why the server closed (e.g. host-unknown, see-other-host).
                        if let Some(cond) = extract_stream_error_condition(&stanza) {
                            if let Ok(mut slot) = stream_error_capture.lock() {
                                *slot = Some(cond);
                            }
                        }
                        let translated = translate_tcp_to_ws(&stanza);
                        debug!(data = %translated, "TLS->WS");
                        if let Err(e) = ws_write_for_tls
                            .lock()
                            .await
                            .send(Message::Text(translated.into_owned().into()))
                            .await
                        {
                            debug!(error = %e, "TLS->WS write error (WebSocket likely closed)");
                            return BridgeEndReason::WebSocketReadError;
                        }
                    }
                    if consumed > 0 {
                        buffer.drain(..consumed);
                    }

                    // Guard against unbounded buffer growth from incomplete/malformed XML
                    if buffer.len() > MAX_STANZA_BUFFER_SIZE {
                        error!(
                            buffer_bytes = buffer.len(),
                            limit = MAX_STANZA_BUFFER_SIZE,
                            "Stanza buffer exceeded size limit, closing connection"
                        );
                        return BridgeEndReason::TlsReadError;
                    }

                    activity_tls.store(now_millis(), Ordering::Relaxed);
                }
                Err(e) => {
                    error!(error = %e, "TLS read error");
                    return BridgeEndReason::TlsReadError;
                }
            }
        }
    });

    // Watchdog: periodically check for inactivity to detect zombie connections
    let watchdog_activity = last_activity.clone();
    let watchdog = async move {
        loop {
            tokio::time::sleep(WATCHDOG_CHECK_INTERVAL).await;
            let last = watchdog_activity.load(Ordering::Relaxed);
            let elapsed_ms = now_millis().saturating_sub(last);
            if elapsed_ms > BRIDGE_INACTIVITY_TIMEOUT.as_millis() as u64 {
                warn!(
                    elapsed_secs = elapsed_ms / 1000,
                    timeout_secs = BRIDGE_INACTIVITY_TIMEOUT.as_secs(),
                    "Bridge inactivity watchdog triggered, closing connection"
                );
                break;
            }
        }
    };

    // Wait for any task to complete, watchdog to trigger, or shutdown signal
    let end_reason = tokio::select! {
        result = &mut ws_to_tls => {
            match result {
                Ok(reason) => reason,
                Err(e) => {
                    error!(error = %e, "WS->TLS task join error");
                    BridgeEndReason::WebSocketReadError
                }
            }
        }
        result = &mut tls_to_ws => {
            match result {
                Ok(reason) => reason,
                Err(e) => {
                    error!(error = %e, "TLS->WS task join error");
                    BridgeEndReason::TlsReadError
                }
            }
        }
        _ = watchdog => {
            info!("Connection closed by inactivity watchdog");
            BridgeEndReason::WatchdogTimeout
        }
        _ = shutdown.recv() => {
            info!("Connection closed by shutdown");
            BridgeEndReason::Shutdown
        }
    };

    // Abort both bridge tasks so they don't linger holding resources
    ws_to_tls.abort();
    tls_to_ws.abort();

    let end_reason_label = format!("{:?}", end_reason);
    // The TLS→WS task has stopped writing by now; read any captured upstream
    // stream-error condition so we can report the real cause to the client.
    let captured_stream_error = last_stream_error
        .lock()
        .ok()
        .and_then(|slot| slot.clone());
    let close_reason =
        format_bridge_close_reason(&end_reason_label, captured_stream_error.as_deref());

    // Send an explicit RFC7395 stream close and a WebSocket close frame so xmpp.js
    // receives a deterministic disconnect path even when upstream TLS died abruptly.
    // The close reason carries the real cause (e.g. "Bridge closed: stream-error
    // host-unknown") so the frontend can surface it instead of a generic message.
    let close_handshake_result = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        let mut writer = ws_write.lock().await;

        writer
            .send(Message::Text(
                r#"<close xmlns="urn:ietf:params:xml:ns:xmpp-framing"/>"#.into(),
            ))
            .await
            .map_err(|e| format!("failed to send RFC7395 <close/>: {}", e))?;

        writer
            .send(Message::Close(Some(CloseFrame {
                code: CloseCode::Normal,
                reason: close_reason.clone().into(),
            })))
            .await
            .map_err(|e| format!("failed to send WebSocket close frame: {}", e))?;

        Ok::<(), String>(())
    })
    .await;
    match close_handshake_result {
        Ok(Ok(())) => {
            info!(conn_id, reason = %close_reason, "Sent RFC7395/WebSocket close handshake to client");
        }
        Ok(Err(err)) => {
            warn!(conn_id, error = %err, "Failed to send clean close handshake to client");
        }
        Err(_) => {
            warn!(conn_id, "WebSocket close handshake send timed out");
        }
    }

    // Emit Tauri event so the frontend can immediately verify/reconnect after
    // abnormal bridge exits. Clean client-initiated close and app shutdown are excluded.
    if !matches!(
        end_reason,
        BridgeEndReason::Shutdown | BridgeEndReason::WebSocketClosedByClient
    ) {
        if let Some(ref handle) = app_handle {
            let _ = handle.emit(
                "proxy-connection-closed",
                ProxyConnectionClosedEvent {
                    conn_id,
                    reason: end_reason_label.clone(),
                    stream_error: captured_stream_error.clone(),
                },
            );
        }
    }

    info!(
        conn_id,
        reason = %end_reason_label,
        stream_error = ?captured_stream_error,
        bridge_ms = bridge_started.elapsed().as_millis() as u64,
        "Bridge ended"
    );

    Ok(())
}

/// Global proxy singleton
static PROXY: RwLock<Option<XmppProxy>> = RwLock::const_new(None);

/// Start the XMPP proxy (exposed to Tauri commands).
///
/// Idempotent: if a proxy is already running for the same server, returns
/// the existing WebSocket URL without restarting. If the server changed
/// (or on page reload), stops the old proxy and starts a new one.
///
/// The `server` parameter supports: `tls://host:port`, `tcp://host:port`, `host:port`, or bare `domain`.
pub async fn start_proxy(
    server: String,
    app_handle: Option<tauri::AppHandle>,
) -> Result<ProxyStartResult, String> {
    // Initialize crypto provider before any TLS operations
    init_crypto_provider();

    let mut proxy_guard = PROXY.write().await;

    // If proxy is already running for the same server, reuse it
    if let Some(ref existing) = *proxy_guard {
        if existing.server_input == server && existing.local_addr.is_some() {
            info!(server = %server, url = %existing.ws_url, "Proxy already running for this server, reusing");
            return Ok(ProxyStartResult {
                url: existing.ws_url.clone(),
            });
        }
    }

    // Different server or stale proxy: stop the old one and start fresh.
    // Also handles WebView reload where the Rust process stays alive but
    // the old proxy's WebSocket client is gone.
    if let Some(mut old_proxy) = proxy_guard.take() {
        info!("Stopping existing proxy before starting new one");
        old_proxy.stop().await.ok();
    }

    let mut proxy = XmppProxy::new();
    if let Some(handle) = app_handle {
        proxy.set_app_handle(handle);
    }
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
    use futures_util::{SinkExt, StreamExt};
    use tokio::io::AsyncReadExt;

    // Note: DNS/parsing tests are in dns.rs, framing/stanza tests are in framing.rs.

    // --- Loopback bind / advertised URL tests ---

    /// The proxy must advertise an IPv4 loopback URL (`ws://127.0.0.1:PORT`).
    ///
    /// Platform WebViews (Windows WebView2, macOS WKWebView) fail to open a
    /// WebSocket to a literal IPv6 URL (`ws://[::1]:PORT`), so the advertised
    /// URL must use the IPv4 loopback host even on hosts where IPv6 loopback
    /// binds successfully. Regression guard for the `[::1]`-first bind order.
    #[tokio::test]
    async fn test_start_advertises_ipv4_loopback_url() {
        let mut proxy = XmppProxy::new();
        let result = proxy
            .start("tcp://example.org:5222".to_string())
            .await
            .expect("proxy should bind a loopback listener");

        assert!(
            result.url.starts_with("ws://127.0.0.1:"),
            "proxy must advertise an IPv4 loopback URL for WebView compatibility, got: {}",
            result.url
        );

        proxy.stop().await.expect("proxy should stop cleanly");
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
    fn test_connection_guard_tracks_multiple_connections() {
        let counter = Arc::new(AtomicUsize::new(0));

        // Simulate two concurrent connections
        counter.fetch_add(1, Ordering::SeqCst);
        let _guard1 = ConnectionGuard::new(counter.clone());
        counter.fetch_add(1, Ordering::SeqCst);
        let _guard2 = ConnectionGuard::new(counter.clone());
        assert_eq!(counter.load(Ordering::SeqCst), 2);

        // Drop first connection
        drop(_guard1);
        assert_eq!(counter.load(Ordering::SeqCst), 1);

        // Drop second connection
        drop(_guard2);
        assert_eq!(counter.load(Ordering::SeqCst), 0);
    }

    // --- TLS connector helper test ---

    #[test]
    fn test_create_tls_connector() {
        init_crypto_provider();
        let result = create_tls_connector();
        assert!(
            result.is_ok(),
            "Should create TLS connector with system certs"
        );
    }

    // --- close reason formatting tests ---

    #[test]
    fn test_format_close_reason_transport_only() {
        // No stream error → encode the transport-level end reason.
        assert_eq!(
            format_bridge_close_reason("TlsClosed", None),
            "Bridge closed: TlsClosed"
        );
        assert_eq!(
            format_bridge_close_reason("WatchdogTimeout", None),
            "Bridge closed: WatchdogTimeout"
        );
    }

    #[test]
    fn test_format_close_reason_prefers_stream_error() {
        // A captured stream-error condition is the most actionable signal.
        assert_eq!(
            format_bridge_close_reason("TlsClosed", Some("host-unknown")),
            "Bridge closed: stream-error host-unknown"
        );
        assert_eq!(
            format_bridge_close_reason("TlsReadError", Some("see-other-host")),
            "Bridge closed: stream-error see-other-host"
        );
    }

    #[test]
    fn test_format_close_reason_preserves_legacy_prefix() {
        // Client-side detection keys off the "Bridge closed" prefix.
        assert!(format_bridge_close_reason("TlsClosed", None).starts_with("Bridge closed"));
        assert!(
            format_bridge_close_reason("TlsClosed", Some("conflict")).starts_with("Bridge closed")
        );
    }

    #[test]
    fn test_clamp_close_reason_within_limit() {
        let s = "Bridge closed: TlsClosed".to_string();
        assert_eq!(clamp_close_reason(s.clone()), s);
    }

    #[test]
    fn test_clamp_close_reason_truncates_on_char_boundary() {
        // A pathologically long condition must not produce an over-long frame
        // or split a multi-byte codepoint.
        let long = format!("Bridge closed: stream-error {}", "é".repeat(200));
        let clamped = clamp_close_reason(long);
        assert!(clamped.len() <= MAX_CLOSE_REASON_BYTES);
        // Still valid UTF-8 (truncated on a char boundary) — String guarantees this,
        // but assert the byte length left room rather than cutting mid-codepoint.
        assert!(clamped.is_char_boundary(clamped.len()));
    }

    #[tokio::test]
    async fn test_handle_connection_exits_when_websocket_closes_during_upstream_setup() {
        let upstream_listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind fake upstream listener");
        let upstream_port = upstream_listener
            .local_addr()
            .expect("get fake upstream listener addr")
            .port();
        let (upstream_connected_tx, upstream_connected_rx) = tokio::sync::oneshot::channel();

        tokio::spawn(async move {
            let (mut upstream_socket, _) = upstream_listener
                .accept()
                .await
                .expect("accept fake upstream connection");
            let _ = upstream_connected_tx.send(());

            // Read the client's initial stream opening and then stay silent.
            // This keeps STARTTLS setup in-flight so we can verify WS-close cancellation.
            let mut read_buf = [0u8; 2048];
            let _ = tokio::time::timeout(
                std::time::Duration::from_secs(2),
                upstream_socket.read(&mut read_buf),
            )
            .await;
            let _ = tokio::time::timeout(
                std::time::Duration::from_secs(5),
                upstream_socket.read(&mut read_buf),
            )
            .await;
        });

        let ws_listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind local WebSocket listener");
        let ws_addr = ws_listener
            .local_addr()
            .expect("get local ws listener addr");

        let (shutdown_tx, _) = tokio::sync::broadcast::channel(1);
        let active_connections = Arc::new(AtomicUsize::new(0));
        let active_for_handler = active_connections.clone();
        let server_input = format!("tcp://127.0.0.1:{upstream_port}");

        let handler_task = tokio::spawn(async move {
            let (ws_stream, _) = ws_listener.accept().await.expect("accept ws client");
            handle_connection(
                ws_stream,
                &server_input,
                shutdown_tx.subscribe(),
                active_for_handler,
                None,
            )
            .await
        });

        let ws_url = format!("ws://{}", ws_addr);
        let (mut ws_client, _) = tokio_tungstenite::connect_async(ws_url)
            .await
            .expect("connect ws client");

        ws_client
            .send(Message::Text(
                "<open xmlns='urn:ietf:params:xml:ns:xmpp-framing' to='example.org' version='1.0'/>"
                    .into(),
            ))
            .await
            .expect("send initial client stanza");

        tokio::time::timeout(std::time::Duration::from_secs(2), upstream_connected_rx)
            .await
            .expect("upstream connection should be established")
            .expect("upstream connection signal should succeed");

        // Drop without sending a close handshake to simulate abrupt WebSocket loss.
        drop(ws_client);

        let handler_result = tokio::time::timeout(std::time::Duration::from_secs(2), handler_task)
            .await
            .expect("handler should exit promptly after ws close")
            .expect("handler task should not panic");

        assert!(
            handler_result.is_ok(),
            "handle_connection should treat ws-close during setup as a clean early exit, got: {:?}",
            handler_result
        );
        assert_eq!(
            active_connections.load(Ordering::SeqCst),
            0,
            "connection guard should decrement active connection count on early exit"
        );
    }

    /// Spin up a fake upstream TCP server + the proxy `handle_connection`, send
    /// `client_open` from a WebSocket client, and return the first stream header
    /// the proxy writes upstream (the STARTTLS `<stream:stream …>`).
    ///
    /// `domain_param`, when set, is appended as `?domain=…` to the `tcp://` server
    /// input. The fake upstream stays silent after capturing the header, so the
    /// proxy's STARTTLS eventually errors — but the header is already captured.
    async fn capture_proxy_starttls_header(
        client_open: &str,
        domain_param: Option<&str>,
    ) -> String {
        let upstream = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind fake upstream");
        let upstream_port = upstream.local_addr().expect("upstream addr").port();
        let (hdr_tx, hdr_rx) = tokio::sync::oneshot::channel::<String>();

        tokio::spawn(async move {
            let (mut sock, _) = upstream.accept().await.expect("accept upstream");
            let mut buf = [0u8; 4096];
            let mut acc = Vec::new();
            loop {
                match tokio::time::timeout(std::time::Duration::from_secs(2), sock.read(&mut buf))
                    .await
                {
                    Ok(Ok(n)) if n > 0 => {
                        acc.extend_from_slice(&buf[..n]);
                        let s = String::from_utf8_lossy(&acc);
                        // Wait for the full <stream:stream …> open, skipping the
                        // leading <?xml …?> declaration (its own '>' comes first).
                        if let Some(idx) = s.find("<stream:stream") {
                            if s[idx..].contains('>') {
                                break;
                            }
                        }
                    }
                    _ => break,
                }
            }
            let _ = hdr_tx.send(String::from_utf8_lossy(&acc).to_string());
            // Keep the socket open briefly so the proxy doesn't tear down first.
            let _ = tokio::time::timeout(std::time::Duration::from_secs(1), sock.read(&mut buf))
                .await;
        });

        let server_input = match domain_param {
            Some(d) => format!("tcp://127.0.0.1:{upstream_port}?domain={d}"),
            None => format!("tcp://127.0.0.1:{upstream_port}"),
        };

        let ws_listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind ws listener");
        let ws_addr = ws_listener.local_addr().expect("ws listener addr");
        let (shutdown_tx, _) = tokio::sync::broadcast::channel(1);
        let active = Arc::new(AtomicUsize::new(0));
        let active_for_handler = active.clone();

        let handler = tokio::spawn(async move {
            let (ws_stream, _) = ws_listener.accept().await.expect("accept ws");
            let _ = handle_connection(
                ws_stream,
                &server_input,
                shutdown_tx.subscribe(),
                active_for_handler,
                None,
            )
            .await;
        });

        let ws_url = format!("ws://{}", ws_addr);
        let (mut ws_client, _) = tokio_tungstenite::connect_async(ws_url)
            .await
            .expect("connect ws client");
        ws_client
            .send(Message::Text(client_open.to_string().into()))
            .await
            .expect("send <open/>");

        let header = tokio::time::timeout(std::time::Duration::from_secs(3), hdr_rx)
            .await
            .expect("should capture upstream stream header before timeout")
            .expect("header channel should not drop");

        drop(ws_client);
        let _ = tokio::time::timeout(std::time::Duration::from_secs(2), handler).await;
        header
    }

    /// Regression guard (R1): when the connection host differs from the JID
    /// domain, the STARTTLS stream header MUST carry the JID domain (taken from
    /// the client's `<open to=>`), not the connection host. Host-based since #134.
    #[tokio::test]
    async fn test_explicit_starttls_uses_jid_domain_from_open_to() {
        let client_open = "<open xmlns='urn:ietf:params:xml:ns:xmpp-framing' to='process-one.net' from='me@process-one.net' version='1.0'/>";
        let header = capture_proxy_starttls_header(client_open, None).await;
        assert!(
            header.contains("to='process-one.net'"),
            "STARTTLS header must carry the JID domain from <open to=>, got: {header}"
        );
        assert!(
            !header.contains("to='127.0.0.1'"),
            "STARTTLS header must NOT use the connection host, got: {header}"
        );
    }

    /// Precedence guard (R2): an explicit `?domain=` override wins over the
    /// client's `<open to=>`.
    #[tokio::test]
    async fn test_explicit_starttls_domain_param_overrides_open_to() {
        let client_open = "<open xmlns='urn:ietf:params:xml:ns:xmpp-framing' to='process-one.net' version='1.0'/>";
        let header = capture_proxy_starttls_header(client_open, Some("explicit.example")).await;
        assert!(
            header.contains("to='explicit.example'"),
            "?domain= override must win over <open to=>, got: {header}"
        );
    }

    /// Part 2: an upstream stream error (host-unknown) must be relayed to the
    /// client in the WebSocket close reason, not swallowed as an abrupt socket
    /// drop (which xmpp.js reports as the misleading "WebSocket ECONNERROR").
    #[tokio::test]
    async fn test_upstream_stream_error_surfaced_in_ws_close_reason() {
        let upstream = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind fake upstream");
        let upstream_port = upstream.local_addr().expect("upstream addr").port();

        tokio::spawn(async move {
            let (mut sock, _) = upstream.accept().await.expect("accept upstream");
            let mut buf = [0u8; 4096];
            // Read the proxy's <stream:stream> opening.
            let _ =
                tokio::time::timeout(std::time::Duration::from_secs(2), sock.read(&mut buf)).await;
            // Reply with a stream header + host-unknown stream error, then close —
            // exactly what ejabberd does for an unknown vhost.
            let resp = "<?xml version='1.0'?><stream:stream xmlns='jabber:client' xmlns:stream='http://etherx.jabber.org/streams' from='process-one.net' id='x' version='1.0'><stream:error><host-unknown xmlns='urn:ietf:params:xml:ns:xmpp-streams'/></stream:error></stream:stream>";
            let _ = sock.write_all(resp.as_bytes()).await;
            let _ = sock.flush().await;
            let _ =
                tokio::time::timeout(std::time::Duration::from_secs(1), sock.read(&mut buf)).await;
        });

        let server_input = format!("tcp://127.0.0.1:{upstream_port}");
        let ws_listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind ws listener");
        let ws_addr = ws_listener.local_addr().expect("ws listener addr");
        let (shutdown_tx, _) = tokio::sync::broadcast::channel(1);
        let active = Arc::new(AtomicUsize::new(0));
        let active_for_handler = active.clone();

        tokio::spawn(async move {
            let (ws_stream, _) = ws_listener.accept().await.expect("accept ws");
            let _ = handle_connection(
                ws_stream,
                &server_input,
                shutdown_tx.subscribe(),
                active_for_handler,
                None,
            )
            .await;
        });

        let ws_url = format!("ws://{}", ws_addr);
        let (mut ws_client, _) = tokio_tungstenite::connect_async(ws_url)
            .await
            .expect("connect ws client");
        ws_client
            .send(Message::Text(
                "<open xmlns='urn:ietf:params:xml:ns:xmpp-framing' to='process-one.net' version='1.0'/>"
                    .to_string()
                    .into(),
            ))
            .await
            .expect("send <open/>");

        let mut close_reason = String::new();
        let _ = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while let Some(msg) = ws_client.next().await {
                match msg {
                    Ok(Message::Close(Some(frame))) => {
                        close_reason = frame.reason.to_string();
                        break;
                    }
                    Ok(Message::Close(None)) => break,
                    Ok(_) => {}
                    Err(_) => break,
                }
            }
        })
        .await;

        assert!(
            close_reason.contains("host-unknown"),
            "WebSocket close reason must carry the upstream stream-error condition, got: {close_reason:?}"
        );
    }

    // --- classify_tls_error / transport_error_class_from_error tests ---

    #[test]
    fn test_classify_tls_error_certificate_subclasses() {
        assert_eq!(classify_tls_error("invalid peer certificate: Expired"), "certificate-expired");
        assert_eq!(classify_tls_error("invalid peer certificate: NotValidForName"), "certificate-name-mismatch");
        assert_eq!(classify_tls_error("invalid peer certificate: UnknownIssuer"), "certificate-untrusted");
        assert_eq!(classify_tls_error("invalid peer certificate: BadEncoding"), "certificate");
    }

    #[test]
    fn test_classify_tls_error_transport() {
        assert_eq!(classify_tls_error("connection timed out"), "timeout");
        assert_eq!(classify_tls_error("connection refused"), "refused");
        assert_eq!(classify_tls_error("connection reset by peer"), "refused");
        assert_eq!(classify_tls_error("some unrecognised tls failure"), "other");
    }

    #[test]
    fn test_transport_error_class_from_marker() {
        assert_eq!(
            transport_error_class_from_error("TLS handshake failed with h (tls-error: certificate-expired): boom"),
            Some("certificate-expired".to_string())
        );
    }

    #[test]
    fn test_transport_error_class_from_aggregated_message() {
        let aggregated = "All endpoints failed:\n  - 1.2.3.4:5223: TLS handshake failed with h (tls-error: certificate-untrusted): x\n  - 5.6.7.8:5223: TLS handshake failed with h (tls-error: certificate-untrusted): y";
        assert_eq!(
            transport_error_class_from_error(aggregated),
            Some("certificate-untrusted".to_string())
        );
    }

    #[test]
    fn test_transport_error_class_absent() {
        assert_eq!(transport_error_class_from_error("STARTTLS: server stream-error: host-unknown"), None);
        assert_eq!(transport_error_class_from_error("WebSocket ECONNERROR"), None);
    }

    #[test]
    fn test_format_close_reason_with_transport_class_label() {
        // The transport class is passed as the label; the legacy prefix is preserved.
        assert_eq!(
            format_bridge_close_reason("tls-error certificate-expired", None),
            "Bridge closed: tls-error certificate-expired"
        );
        assert!(format_bridge_close_reason("tls-error certificate", None).starts_with("Bridge closed"));
    }

    // --- stream_error_condition_from_error tests ---

    #[test]
    fn test_stream_error_condition_from_error_present() {
        assert_eq!(
            stream_error_condition_from_error("STARTTLS: server stream-error: host-unknown")
                .as_deref(),
            Some("host-unknown")
        );
    }

    #[test]
    fn test_stream_error_condition_from_error_in_aggregated_message() {
        // connect_upstream_tls wraps each endpoint failure; the marker survives.
        let aggregated = "All 1 endpoint(s) failed:\n  - chat.process-one.net:5222 (Tcp): STARTTLS: server stream-error: host-unknown";
        assert_eq!(
            stream_error_condition_from_error(aggregated).as_deref(),
            Some("host-unknown")
        );
    }

    #[test]
    fn test_stream_error_condition_from_error_hyphenated_condition() {
        assert_eq!(
            stream_error_condition_from_error("STARTTLS: server stream-error: see-other-host")
                .as_deref(),
            Some("see-other-host")
        );
    }

    #[test]
    fn test_stream_error_condition_from_error_transport_failure_is_none() {
        assert_eq!(
            stream_error_condition_from_error("TCP connect timed out after 15s to host:5222"),
            None
        );
    }

    // --- connect_first_endpoint: overall budget across SRV endpoints ---

    fn test_endpoint(host: &str) -> XmppEndpoint {
        XmppEndpoint {
            host: host.to_string(),
            port: 5222,
            mode: ConnectionMode::DirectTls,
            domain: None,
        }
    }

    /// A domain whose SRV records all black-hole must NOT cost ~N × the
    /// per-endpoint timeout: the overall budget caps the total. With a 30s
    /// budget and a 15s per-attempt cap, only two of three black-holed
    /// endpoints are attempted before the budget is exhausted.
    #[tokio::test(start_paused = true)]
    async fn connect_first_endpoint_caps_total_time_across_endpoints() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        let endpoints = vec![test_endpoint("a"), test_endpoint("b"), test_endpoint("c")];
        let attempts = Arc::new(AtomicUsize::new(0));
        let attempts_c = attempts.clone();

        let result: Result<(), String> = connect_first_endpoint(
            &endpoints,
            std::time::Duration::from_secs(30),
            std::time::Duration::from_secs(15),
            move |_ep| {
                let attempts_c = attempts_c.clone();
                async move {
                    attempts_c.fetch_add(1, Ordering::SeqCst);
                    // Black-hole: never resolves before the per-attempt cap.
                    tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                    Err::<(), String>("blackhole".to_string())
                }
            },
        )
        .await;

        assert!(result.is_err());
        assert_eq!(
            attempts.load(Ordering::SeqCst),
            2,
            "overall budget must stop after 2 endpoints, not try all 3"
        );
    }

    /// The first endpoint that connects wins, and earlier failures fall through.
    #[tokio::test(start_paused = true)]
    async fn connect_first_endpoint_returns_first_success() {
        let endpoints = vec![test_endpoint("fail"), test_endpoint("ok")];

        let result: Result<u32, String> = connect_first_endpoint(
            &endpoints,
            std::time::Duration::from_secs(30),
            std::time::Duration::from_secs(15),
            |ep| {
                let host = ep.host.clone();
                async move {
                    if host == "ok" {
                        Ok(42u32)
                    } else {
                        Err("refused".to_string())
                    }
                }
            },
        )
        .await;

        assert_eq!(result, Ok(42u32));
    }
}
