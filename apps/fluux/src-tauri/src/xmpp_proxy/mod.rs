mod dns;
mod framing;

use dns::{parse_server_input, resolve_xmpp_server, ConnectionMode, ParsedServer, XmppEndpoint};
use framing::{extract_stanza, translate_tcp_to_ws, translate_ws_to_tcp};

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
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::{accept_async, tungstenite::Message};
use tracing::{debug, error, info, warn};

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
            let classification = if error_detail.contains("ertificate") {
                "certificate_error"
            } else if error_detail.contains("timed out") || error_detail.contains("timeout") {
                "timeout"
            } else if error_detail.contains("refused") || error_detail.contains("reset") {
                "connection_refused"
            } else {
                "other"
            };
            error!(host, error = %e, error_class = classification, "TLS handshake failed");
            format!(
                "TLS handshake failed with {} ({}): {}",
                host, classification, e
            )
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

        // Bind to localhost on a random port.
        // Try IPv6 loopback first, fall back to IPv4. On some systems (especially
        // Windows with IPv6-preferred network stacks), IPv6 loopback may be faster
        // or preferred by the WebView.
        let (listener, loopback_host) = match TcpListener::bind("[::1]:0").await {
            Ok(l) => {
                info!("WebSocket server bound to IPv6 loopback ([::1])");
                (l, "[::1]")
            }
            Err(ipv6_err) => {
                debug!(error = %ipv6_err, "IPv6 loopback bind failed, falling back to IPv4");
                let l = TcpListener::bind("127.0.0.1:0").await.map_err(|e| {
                    format!(
                        "Failed to bind WebSocket server (IPv6: {}, IPv4: {})",
                        ipv6_err, e
                    )
                })?;
                info!("WebSocket server bound to IPv4 loopback (127.0.0.1)");
                (l, "127.0.0.1")
            }
        };

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

    // Upgrade to WebSocket
    let mut ws = accept_async(ws_stream)
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

    // Buffer client text frames received while upstream connect/STARTTLS is in progress.
    // They are flushed to TLS once the bridge starts.
    let mut pending_ws_texts = vec![initial_ws_text];

    let upstream_connect_started = Instant::now();
    let connect_future = connect_upstream_tls(server_input);
    tokio::pin!(connect_future);

    let tls_stream = loop {
        tokio::select! {
            result = &mut connect_future => {
                let tls_stream = result?;
                info!(
                    conn_id,
                    connect_ms = upstream_connect_started.elapsed().as_millis() as u64,
                    "Upstream TLS connected"
                );
                break tls_stream;
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

    let bridge_result = bridge_websocket_tls(ws, tls_stream, shutdown, app_handle, pending_ws_texts, conn_id).await;
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

/// Resolve upstream endpoint and establish a TLS stream (direct TLS or STARTTLS).
async fn connect_upstream_tls(
    server_input: &str,
) -> Result<tokio_rustls::client::TlsStream<TcpStream>, String> {
    // Resolve DNS/SRV per connection (fresh resolution handles DNS changes after sleep)
    let resolve_started = Instant::now();
    let endpoint = match parse_server_input(server_input) {
        ParsedServer::Direct(host, port, mode, domain) => {
            info!(host = %host, port, mode = ?mode, domain = ?domain, "Using explicit endpoint");
            XmppEndpoint {
                host,
                port,
                mode,
                domain,
            }
        }
        ParsedServer::Domain(domain) => resolve_xmpp_server(&domain)
            .await
            .map_err(|e| format!("Failed to resolve XMPP server: {}", e))?,
    };

    let dns_resolve_ms = resolve_started.elapsed().as_millis() as u64;
    info!(host = %endpoint.host, port = endpoint.port, mode = ?endpoint.mode,
        domain = ?endpoint.domain, tls_name = endpoint.tls_name(),
        dns_resolve_ms, "Resolved endpoint");

    match endpoint.mode {
        ConnectionMode::Tcp => {
            let tcp_stream = tokio::time::timeout(
                TCP_CONNECT_TIMEOUT,
                TcpStream::connect(format!("{}:{}", endpoint.host, endpoint.port)),
            )
            .await
            .map_err(|_| {
                error!(
                    host = %endpoint.host, port = endpoint.port, mode = "starttls",
                    timeout_secs = TCP_CONNECT_TIMEOUT.as_secs(),
                    "TCP connect timed out"
                );
                format!(
                    "TCP connect timed out after {}s to {}:{}",
                    TCP_CONNECT_TIMEOUT.as_secs(),
                    endpoint.host,
                    endpoint.port
                )
            })?
            .map_err(|e| {
                error!(
                    host = %endpoint.host, port = endpoint.port, mode = "starttls",
                    error = %e, error_kind = ?e.kind(),
                    "TCP connect failed"
                );
                format!(
                    "Failed to connect to XMPP server {}:{} (STARTTLS): {}",
                    endpoint.host, endpoint.port, e
                )
            })?;
            info!(host = %endpoint.host, port = endpoint.port, "Connected (TCP), performing STARTTLS");

            // Use tls_name() for the XMPP domain (TLS SNI + stream `to=`), host for TCP target.
            let tls_stream =
                perform_starttls(tcp_stream, endpoint.tls_name(), &endpoint.host).await?;
            info!(host = %endpoint.host, port = endpoint.port, "STARTTLS upgrade complete");
            Ok(tls_stream)
        }
        ConnectionMode::DirectTls => {
            let tcp_stream = tokio::time::timeout(
                TCP_CONNECT_TIMEOUT,
                TcpStream::connect(format!("{}:{}", endpoint.host, endpoint.port)),
            )
            .await
            .map_err(|_| {
                error!(
                    host = %endpoint.host, port = endpoint.port, mode = "direct_tls",
                    timeout_secs = TCP_CONNECT_TIMEOUT.as_secs(),
                    "TCP connect timed out"
                );
                format!(
                    "TCP connect timed out after {}s to {}:{}",
                    TCP_CONNECT_TIMEOUT.as_secs(),
                    endpoint.host,
                    endpoint.port
                )
            })?
            .map_err(|e| {
                error!(
                    host = %endpoint.host, port = endpoint.port, mode = "direct_tls",
                    error = %e, error_kind = ?e.kind(),
                    "TCP connect failed"
                );
                format!(
                    "Failed to connect to XMPP server {}:{} (direct TLS): {}",
                    endpoint.host, endpoint.port, e
                )
            })?;

            // Use tls_name() for SNI — the XMPP domain, not the SRV target host
            let tls_stream = upgrade_to_tls(tcp_stream, endpoint.tls_name()).await?;

            info!(host = %endpoint.host, port = endpoint.port,
                tls_name = endpoint.tls_name(), "Connected (direct TLS)");
            Ok(tls_stream)
        }
    }
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
    }

    let bridge_started = Instant::now();
    info!(conn_id, buffered_frames = pending_ws_texts.len(), "Bridge started");

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
                        let translated = translate_tcp_to_ws(&stanza);
                        debug!(data = %translated, "TLS->WS");
                        if let Err(e) = ws_write_for_tls
                            .lock()
                            .await
                            .send(Message::Text(translated.into_owned()))
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

    // Send a proper WebSocket close frame so xmpp.js receives a 'disconnect' event.
    // Without this, the JS side never learns the connection died (especially after
    // watchdog or shutdown, where the bridge tasks are aborted without closing the WS).
    let close_result = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        let mut writer = ws_write.lock().await;
        let _ = writer
            .send(Message::Close(Some(CloseFrame {
                code: CloseCode::Normal,
                reason: "Bridge closed".into(),
            })))
            .await;
    })
    .await;
    if close_result.is_err() {
        debug!("WebSocket close frame send timed out");
    }

    let end_reason_label = format!("{:?}", end_reason);

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
                },
            );
        }
    }

    info!(
        conn_id,
        reason = %end_reason_label,
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
    use futures_util::SinkExt;
    use tokio::io::AsyncReadExt;

    // Note: DNS/parsing tests are in dns.rs, framing/stanza tests are in framing.rs.

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
}
