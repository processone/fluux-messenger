//! XMPP server resolution: input parsing and SRV record lookup.
//!
//! Converts a server input string (bare domain, `tls://host:port`, etc.) into a
//! resolved `XmppEndpoint` ready for TCP connection. Handles RFC 6120 SRV record
//! lookup with priority sorting per RFC 2782.

use tracing::{info, warn};
use trust_dns_resolver::TokioAsyncResolver;
use trust_dns_resolver::config::{ResolverConfig, ResolverOpts};

fn elapsed_ms(start: std::time::Instant) -> u64 {
    start.elapsed().as_millis() as u64
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
pub struct XmppEndpoint {
    pub host: String,
    pub port: u16,
    pub mode: ConnectionMode,
    /// Original XMPP domain for TLS SNI and STARTTLS `to=` attribute.
    /// When connecting via SRV, `host` is the SRV target (e.g., "v4.mdosch.de")
    /// but TLS must use the XMPP domain (e.g., "diebesban.de") per RFC 6120 §13.7.2.
    pub domain: Option<String>,
}

impl XmppEndpoint {
    /// Returns the hostname to use for TLS SNI and certificate verification.
    /// Uses the XMPP domain if available (SRV resolution), otherwise the host.
    pub fn tls_name(&self) -> &str {
        self.domain.as_deref().unwrap_or(&self.host)
    }
}

/// Result of parsing the server input string.
#[derive(Debug, Clone, PartialEq)]
pub enum ParsedServer {
    /// Explicit endpoint — skip SRV, connect directly
    /// Fields: host, port, mode, optional XMPP domain (for TLS SNI when reconnecting via cached endpoint)
    Direct(String, u16, ConnectionMode, Option<String>),
    /// Domain only — perform SRV resolution
    Domain(String),
}

/// Extract optional `?domain=` parameter from a URI path.
/// Returns (host_port_part, optional_domain).
fn split_domain_param(input: &str) -> (&str, Option<String>) {
    if let Some((host_port, query)) = input.split_once('?') {
        let domain = query.strip_prefix("domain=").map(|d| d.to_string());
        (host_port, domain)
    } else {
        (input, None)
    }
}

/// Parse the server input string into either an explicit endpoint or a domain for SRV resolution.
///
/// Supported formats:
/// - `tls://host:port`              → Direct TLS connection
/// - `tls://host:port?domain=d`     → Direct TLS with XMPP domain for TLS SNI
/// - `tls://host`                   → Direct TLS on port 5223
/// - `tcp://host:port`              → STARTTLS connection
/// - `tcp://host:port?domain=d`     → STARTTLS with XMPP domain for TLS SNI
/// - `tcp://host`                   → STARTTLS on port 5222
/// - `host:port`                    → Direct connection (port 5223 = TLS, otherwise STARTTLS)
/// - `domain`                       → SRV resolution
pub fn parse_server_input(server: &str) -> ParsedServer {
    let trimmed = server.trim();

    // tls:// scheme
    if let Some(rest) = trimmed.strip_prefix("tls://") {
        let (host_port, domain) = split_domain_param(rest);
        if let Some((host, port_str)) = host_port.rsplit_once(':') {
            if let Ok(port) = port_str.parse::<u16>() {
                return ParsedServer::Direct(host.to_string(), port, ConnectionMode::DirectTls, domain);
            }
        }
        // No port specified — default to 5223
        return ParsedServer::Direct(host_port.to_string(), 5223, ConnectionMode::DirectTls, domain);
    }

    // tcp:// scheme
    if let Some(rest) = trimmed.strip_prefix("tcp://") {
        let (host_port, domain) = split_domain_param(rest);
        if let Some((host, port_str)) = host_port.rsplit_once(':') {
            if let Ok(port) = port_str.parse::<u16>() {
                return ParsedServer::Direct(host.to_string(), port, ConnectionMode::Tcp, domain);
            }
        }
        // No port specified — default to 5222
        return ParsedServer::Direct(host_port.to_string(), 5222, ConnectionMode::Tcp, domain);
    }

    // host:port (no scheme) — use rsplit_once to handle IPv6 addresses
    if let Some((host, port_str)) = trimmed.rsplit_once(':') {
        if let Ok(port) = port_str.parse::<u16>() {
            let mode = if port == 5223 { ConnectionMode::DirectTls } else { ConnectionMode::Tcp };
            return ParsedServer::Direct(host.to_string(), port, mode, None);
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
///
/// SRV records are sorted by priority (ascending — lower value = higher preference)
/// per RFC 2782. The XMPP domain is preserved in the returned endpoint for TLS SNI.
pub async fn resolve_xmpp_server(domain: &str) -> Result<XmppEndpoint, String> {
    let resolve_started = std::time::Instant::now();
    let resolver_init_started = std::time::Instant::now();
    let resolver = match TokioAsyncResolver::tokio_from_system_conf() {
        Ok(r) => {
            info!(
                resolver_init_ms = elapsed_ms(resolver_init_started),
                "Using system DNS resolver"
            );
            r
        }
        Err(e) => {
            warn!(
                resolver_init_ms = elapsed_ms(resolver_init_started),
                "Failed to load system DNS config: {}, falling back to default resolver",
                e
            );
            TokioAsyncResolver::tokio(ResolverConfig::default(), ResolverOpts::default())
        }
    };

    // Try direct TLS SRV first
    let srv_name = format!("_xmpps-client._tcp.{}", domain);
    info!(domain, srv = %srv_name, "SRV lookup: trying direct TLS");
    let srv_lookup_started = std::time::Instant::now();
    match resolver.srv_lookup(&srv_name).await {
        Ok(lookup) => {
            let lookup_ms = elapsed_ms(srv_lookup_started);
            let mut records: Vec<_> = lookup.iter().collect();
            if !records.is_empty() {
                // Sort by priority ascending (lower = preferred), then weight descending (higher = preferred)
                records.sort_by(|a, b| {
                    a.priority().cmp(&b.priority())
                        .then(b.weight().cmp(&a.weight()))
                });
                for r in &records {
                    info!(domain, host = %r.target(), port = r.port(),
                        priority = r.priority(), weight = r.weight(),
                        "SRV record (direct TLS)");
                }
                let srv = &records[0];
                info!(domain, host = %srv.target(), port = srv.port(),
                    priority = srv.priority(), lookup_ms,
                    resolve_total_ms = elapsed_ms(resolve_started), "SRV selected (direct TLS)");
                return Ok(XmppEndpoint {
                    host: srv.target().to_string().trim_end_matches('.').to_string(),
                    port: srv.port(),
                    mode: ConnectionMode::DirectTls,
                    domain: Some(domain.to_string()),
                });
            }
            info!(domain, srv = %srv_name, lookup_ms, "SRV lookup returned empty results");
        }
        Err(e) => {
            info!(
                domain,
                srv = %srv_name,
                lookup_ms = elapsed_ms(srv_lookup_started),
                error = %e,
                "SRV lookup failed"
            );
        }
    }

    // Try STARTTLS SRV
    let srv_name = format!("_xmpp-client._tcp.{}", domain);
    info!(domain, srv = %srv_name, "SRV lookup: trying STARTTLS");
    let srv_lookup_started = std::time::Instant::now();
    match resolver.srv_lookup(&srv_name).await {
        Ok(lookup) => {
            let lookup_ms = elapsed_ms(srv_lookup_started);
            let mut records: Vec<_> = lookup.iter().collect();
            if !records.is_empty() {
                records.sort_by(|a, b| {
                    a.priority().cmp(&b.priority())
                        .then(b.weight().cmp(&a.weight()))
                });
                for r in &records {
                    info!(domain, host = %r.target(), port = r.port(),
                        priority = r.priority(), weight = r.weight(),
                        "SRV record (STARTTLS)");
                }
                let srv = &records[0];
                info!(domain, host = %srv.target(), port = srv.port(),
                    priority = srv.priority(), lookup_ms,
                    resolve_total_ms = elapsed_ms(resolve_started), "SRV selected (STARTTLS)");
                return Ok(XmppEndpoint {
                    host: srv.target().to_string().trim_end_matches('.').to_string(),
                    port: srv.port(),
                    mode: ConnectionMode::Tcp,
                    domain: Some(domain.to_string()),
                });
            }
            info!(domain, srv = %srv_name, lookup_ms, "SRV lookup returned empty results");
        }
        Err(e) => {
            info!(
                domain,
                srv = %srv_name,
                lookup_ms = elapsed_ms(srv_lookup_started),
                error = %e,
                "SRV lookup failed"
            );
        }
    }

    // Fallback to direct connection on standard XMPP client port (RFC 6120)
    // No SRV target, so host IS the domain — no separate domain field needed
    warn!(
        domain,
        resolve_total_ms = elapsed_ms(resolve_started),
        "No SRV records found, using fallback: {}:5222 (STARTTLS)",
        domain
    );
    Ok(XmppEndpoint {
        host: domain.to_string(),
        port: 5222,
        mode: ConnectionMode::Tcp,
        domain: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- parse_server_input tests ---

    #[test]
    fn test_parse_tls_uri_with_port() {
        assert_eq!(
            parse_server_input("tls://chat.example.com:5223"),
            ParsedServer::Direct("chat.example.com".to_string(), 5223, ConnectionMode::DirectTls, None)
        );
    }

    #[test]
    fn test_parse_tls_uri_custom_port() {
        assert_eq!(
            parse_server_input("tls://chat.example.com:5270"),
            ParsedServer::Direct("chat.example.com".to_string(), 5270, ConnectionMode::DirectTls, None)
        );
    }

    #[test]
    fn test_parse_tls_uri_no_port() {
        assert_eq!(
            parse_server_input("tls://chat.example.com"),
            ParsedServer::Direct("chat.example.com".to_string(), 5223, ConnectionMode::DirectTls, None)
        );
    }

    #[test]
    fn test_parse_tcp_uri_with_port() {
        assert_eq!(
            parse_server_input("tcp://chat.example.com:5222"),
            ParsedServer::Direct("chat.example.com".to_string(), 5222, ConnectionMode::Tcp, None)
        );
    }

    #[test]
    fn test_parse_tcp_uri_no_port() {
        assert_eq!(
            parse_server_input("tcp://chat.example.com"),
            ParsedServer::Direct("chat.example.com".to_string(), 5222, ConnectionMode::Tcp, None)
        );
    }

    #[test]
    fn test_parse_host_port_5223_is_tls() {
        // Port 5223 is conventionally direct TLS
        assert_eq!(
            parse_server_input("chat.example.com:5223"),
            ParsedServer::Direct("chat.example.com".to_string(), 5223, ConnectionMode::DirectTls, None)
        );
    }

    #[test]
    fn test_parse_host_port_5222_is_tcp() {
        assert_eq!(
            parse_server_input("chat.example.com:5222"),
            ParsedServer::Direct("chat.example.com".to_string(), 5222, ConnectionMode::Tcp, None)
        );
    }

    #[test]
    fn test_parse_host_port_custom_is_tcp() {
        // Non-standard port defaults to STARTTLS mode
        assert_eq!(
            parse_server_input("chat.example.com:5280"),
            ParsedServer::Direct("chat.example.com".to_string(), 5280, ConnectionMode::Tcp, None)
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
            ParsedServer::Direct("chat.example.com".to_string(), 5223, ConnectionMode::DirectTls, None)
        );
    }

    // --- parse_server_input with ?domain= parameter ---

    #[test]
    fn test_parse_tls_uri_with_domain() {
        assert_eq!(
            parse_server_input("tls://v6.mdosch.de:5223?domain=diebesban.de"),
            ParsedServer::Direct("v6.mdosch.de".to_string(), 5223, ConnectionMode::DirectTls, Some("diebesban.de".to_string()))
        );
    }

    #[test]
    fn test_parse_tcp_uri_with_domain() {
        assert_eq!(
            parse_server_input("tcp://v4.mdosch.de:5222?domain=diebesban.de"),
            ParsedServer::Direct("v4.mdosch.de".to_string(), 5222, ConnectionMode::Tcp, Some("diebesban.de".to_string()))
        );
    }

    #[test]
    fn test_parse_tls_uri_with_domain_no_port() {
        assert_eq!(
            parse_server_input("tls://v6.mdosch.de?domain=diebesban.de"),
            ParsedServer::Direct("v6.mdosch.de".to_string(), 5223, ConnectionMode::DirectTls, Some("diebesban.de".to_string()))
        );
    }

    // --- XmppEndpoint::tls_name() tests ---

    #[test]
    fn test_endpoint_tls_name_with_domain() {
        let ep = XmppEndpoint {
            host: "v6.mdosch.de".to_string(),
            port: 5223,
            mode: ConnectionMode::DirectTls,
            domain: Some("diebesban.de".to_string()),
        };
        assert_eq!(ep.tls_name(), "diebesban.de");
    }

    #[test]
    fn test_endpoint_tls_name_without_domain() {
        let ep = XmppEndpoint {
            host: "chat.example.com".to_string(),
            port: 5223,
            mode: ConnectionMode::DirectTls,
            domain: None,
        };
        assert_eq!(ep.tls_name(), "chat.example.com");
    }

    // --- split_domain_param tests ---

    #[test]
    fn test_split_domain_param_with_domain() {
        let (host_port, domain) = split_domain_param("v6.mdosch.de:5223?domain=diebesban.de");
        assert_eq!(host_port, "v6.mdosch.de:5223");
        assert_eq!(domain, Some("diebesban.de".to_string()));
    }

    #[test]
    fn test_split_domain_param_without_domain() {
        let (host_port, domain) = split_domain_param("chat.example.com:5223");
        assert_eq!(host_port, "chat.example.com:5223");
        assert_eq!(domain, None);
    }

    #[test]
    fn test_split_domain_param_unknown_param() {
        let (host_port, domain) = split_domain_param("host:5223?other=value");
        assert_eq!(host_port, "host:5223");
        assert_eq!(domain, None);
    }
}
