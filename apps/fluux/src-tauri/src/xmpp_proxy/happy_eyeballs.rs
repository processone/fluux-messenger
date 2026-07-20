//! Happy Eyeballs (RFC 8305) connection racing for outbound XMPP connections.
//!
//! Background: `tokio::net::TcpStream::connect("host:port")` resolves the host to
//! every address (IPv6 + IPv4) and tries them *sequentially* under a single
//! timeout. On a network with broken IPv6 — e.g. a router that advertises a ULA
//! prefix but provides no working IPv6 route — the OS hands out the IPv6 address
//! first, the SYN black-holes, and the whole connect burns the entire timeout
//! budget before IPv4 is ever attempted. The user sees repeated 15s
//! "UpstreamConnectFailed" even though the server is perfectly reachable over IPv4.
//!
//! This module races connection attempts across the resolved addresses per
//! RFC 8305: attempts are staggered by a small delay, the first to succeed wins,
//! and the rest are cancelled. A black-holed IPv6 address no longer blocks a
//! reachable IPv4 address — the IPv4 attempt starts one `CONNECTION_ATTEMPT_DELAY`
//! later and wins.

use std::collections::VecDeque;
use std::future::Future;
use std::net::SocketAddr;
use std::time::Duration;

use futures_util::stream::{FuturesUnordered, StreamExt};
use tokio::net::{lookup_host, TcpStream};

use super::dns::to_ascii_host;
use tracing::info;

/// RFC 8305 "Connection Attempt Delay": how long to wait before starting the
/// next staggered connection attempt. The RFC recommends 250 ms (minimum 100 ms).
/// A reachable address usually connects well within this window, so in the common
/// case only the first attempt is ever started.
pub const CONNECTION_ATTEMPT_DELAY: Duration = Duration::from_millis(250);

/// Reorder resolved addresses for Happy Eyeballs by interleaving address families.
///
/// The resolver returns addresses already sorted by the OS destination-address
/// selection policy (RFC 6724) — typically all IPv6 first, then all IPv4. Attempting
/// them in that raw order could exhaust several unreachable IPv6 addresses before
/// reaching the first IPv4 one. Interleaving guarantees the "other" family is reached
/// by the second attempt while preserving the resolver's family preference for the
/// very first attempt.
///
/// Example: `[v6a, v6b, v4a, v4b]` -> `[v6a, v4a, v6b, v4b]`.
pub fn interleave_by_family(addrs: &[SocketAddr]) -> Vec<SocketAddr> {
    // Keep the resolver's preferred family (the first address) first.
    let first_is_v6 = addrs.first().map(SocketAddr::is_ipv6).unwrap_or(true);

    let v6: VecDeque<SocketAddr> = addrs.iter().copied().filter(SocketAddr::is_ipv6).collect();
    let v4: VecDeque<SocketAddr> = addrs.iter().copied().filter(SocketAddr::is_ipv4).collect();
    let (mut primary, mut secondary) = if first_is_v6 { (v6, v4) } else { (v4, v6) };

    let mut out = Vec::with_capacity(addrs.len());
    while !primary.is_empty() || !secondary.is_empty() {
        if let Some(a) = primary.pop_front() {
            out.push(a);
        }
        if let Some(b) = secondary.pop_front() {
            out.push(b);
        }
    }
    out
}

/// Race connection attempts across `addrs` using the Happy Eyeballs algorithm.
///
/// Starts an attempt for the first address, then every `attempt_delay` starts the
/// next address's attempt without waiting for the previous one to finish. The first
/// attempt to succeed wins and its connection is returned; the rest are dropped
/// (cancelled). An attempt that fails before the delay elapses triggers the next one
/// immediately. If every attempt fails, an aggregated error is returned. The whole
/// race is bounded by `overall_timeout`.
///
/// `connect` is injected so the racing logic is unit-testable without real sockets.
pub async fn happy_eyeballs_connect<S, F, Fut>(
    addrs: &[SocketAddr],
    attempt_delay: Duration,
    overall_timeout: Duration,
    connect: F,
) -> Result<S, String>
where
    F: Fn(SocketAddr) -> Fut,
    Fut: Future<Output = Result<S, std::io::Error>>,
{
    if addrs.is_empty() {
        return Err("no addresses to connect to".to_string());
    }

    let race = async {
        let mut in_flight = FuturesUnordered::new();
        let mut errors: Vec<String> = Vec::new();
        let mut next = 0usize;

        // Start the first (most-preferred) attempt immediately.
        in_flight.push(attempt(&connect, addrs[next]));
        next += 1;

        loop {
            let more = next < addrs.len();
            tokio::select! {
                // Prefer reporting a completed attempt over firing the next stagger.
                biased;

                Some((addr, result)) = in_flight.next() => {
                    match result {
                        Ok(stream) => return Ok(stream),
                        Err(e) => {
                            errors.push(format!("{}: {}", addr, e));
                            if more {
                                // A failure frees us to start the next attempt at once.
                                in_flight.push(attempt(&connect, addrs[next]));
                                next += 1;
                            } else if in_flight.is_empty() {
                                return Err(format!(
                                    "all {} address(es) failed:\n  - {}",
                                    errors.len(),
                                    errors.join("\n  - ")
                                ));
                            }
                        }
                    }
                }

                // Stagger elapsed with the previous attempt still pending: start the
                // next one to race alongside it (Happy Eyeballs).
                _ = tokio::time::sleep(attempt_delay), if more => {
                    in_flight.push(attempt(&connect, addrs[next]));
                    next += 1;
                }
            }
        }
    };

    match tokio::time::timeout(overall_timeout, race).await {
        Ok(result) => result,
        Err(_) => Err(format!(
            "timed out after {:?} ({} address(es) tried)",
            overall_timeout,
            addrs.len()
        )),
    }
}

/// Run a single connection attempt, tagging the result with its address so the
/// racer can report which address failed.
async fn attempt<S, F, Fut>(
    connect: &F,
    addr: SocketAddr,
) -> (SocketAddr, Result<S, std::io::Error>)
where
    F: Fn(SocketAddr) -> Fut,
    Fut: Future<Output = Result<S, std::io::Error>>,
{
    let result = connect(addr).await;
    (addr, result)
}

/// Resolve `host:port` and establish a TCP connection using Happy Eyeballs.
///
/// This is the real-socket entry point used by the proxy. It resolves *every*
/// address for the host and races them via [`happy_eyeballs_connect`], so a
/// black-holed IPv6 address falls through to a reachable IPv4 one within
/// `attempt_delay` instead of consuming the entire `overall_timeout`.
pub async fn connect_tcp(
    host: &str,
    port: u16,
    attempt_delay: Duration,
    overall_timeout: Duration,
) -> Result<TcpStream, String> {
    // Resolve the A-label: `lookup_host` goes through the system resolver, and
    // getaddrinfo does not reliably handle Unicode hostnames across platforms.
    // Errors keep reporting the U-label the user actually typed.
    let ascii_host = to_ascii_host(host)?;
    let addrs: Vec<SocketAddr> = lookup_host((ascii_host.as_str(), port))
        .await
        .map_err(|e| format!("DNS resolution failed for {}:{}: {}", host, port, e))?
        .collect();
    if addrs.is_empty() {
        return Err(format!("no addresses resolved for {}:{}", host, port));
    }

    let ordered = interleave_by_family(&addrs);
    info!(
        host,
        port,
        addresses = ordered.len(),
        "Racing TCP connect (happy eyeballs)"
    );

    let stream = happy_eyeballs_connect(
        &ordered,
        attempt_delay,
        overall_timeout,
        |addr| async move { TcpStream::connect(addr).await },
    )
    .await
    .map_err(|e| format!("TCP connect failed to {}:{}: {}", host, port, e))?;

    if let Ok(peer) = stream.peer_addr() {
        info!(host, port, %peer, "TCP connected (happy eyeballs)");
    }
    Ok(stream)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    fn v6(n: u16) -> SocketAddr {
        format!("[2001:db8::{}]:5222", n).parse().unwrap()
    }
    fn v4(n: u16) -> SocketAddr {
        format!("192.0.2.{}:5222", n).parse().unwrap()
    }

    // --- interleave_by_family ---

    #[test]
    fn interleave_alternates_families() {
        let got = interleave_by_family(&[v6(1), v6(2), v4(1), v4(2)]);
        assert_eq!(got, vec![v6(1), v4(1), v6(2), v4(2)]);
    }

    #[test]
    fn interleave_keeps_resolver_preferred_family_first() {
        // Resolver returned IPv6 first → IPv6 stays first.
        assert_eq!(interleave_by_family(&[v6(1), v4(1)]), vec![v6(1), v4(1)]);
        // Resolver returned IPv4 first → IPv4 stays first.
        assert_eq!(interleave_by_family(&[v4(1), v6(1)]), vec![v4(1), v6(1)]);
    }

    #[test]
    fn interleave_handles_single_and_empty() {
        assert_eq!(interleave_by_family(&[v6(1)]), vec![v6(1)]);
        assert!(interleave_by_family(&[]).is_empty());
    }

    // --- happy_eyeballs_connect ---

    /// The core bug: IPv6 is handed first but black-holes; the reachable IPv4
    /// address must still win instead of the connect hanging for the full timeout.
    #[tokio::test(start_paused = true)]
    async fn returns_reachable_ipv4_when_ipv6_blackholes() {
        let addrs = vec![v6(1), v4(1)]; // IPv6 first, as the OS hands it to us
        let connect = |addr: SocketAddr| async move {
            if addr.is_ipv6() {
                tokio::time::sleep(Duration::from_secs(3600)).await; // black hole
            } else {
                tokio::time::sleep(Duration::from_millis(20)).await; // reachable
            }
            Ok::<SocketAddr, std::io::Error>(addr)
        };

        let got = happy_eyeballs_connect(
            &addrs,
            Duration::from_millis(250),
            Duration::from_secs(15),
            connect,
        )
        .await;

        assert_eq!(
            got.unwrap(),
            v4(1),
            "should fall through to the reachable IPv4 address, not hang on IPv6"
        );
    }

    /// When the first (preferred) address connects within the attempt delay, the
    /// second attempt must never be started.
    #[tokio::test(start_paused = true)]
    async fn no_second_attempt_when_first_connects_fast() {
        let started = Arc::new(AtomicUsize::new(0));
        let counter = started.clone();
        let addrs = vec![v6(1), v4(1)];
        let connect = move |addr: SocketAddr| {
            counter.fetch_add(1, Ordering::SeqCst);
            async move {
                tokio::time::sleep(Duration::from_millis(20)).await; // < attempt delay
                Ok::<SocketAddr, std::io::Error>(addr)
            }
        };

        let got = happy_eyeballs_connect(
            &addrs,
            Duration::from_millis(250),
            Duration::from_secs(15),
            connect,
        )
        .await;

        assert_eq!(got.unwrap(), v6(1));
        assert_eq!(
            started.load(Ordering::SeqCst),
            1,
            "second attempt should not start when the first connects within the delay"
        );
    }

    /// A fast failure on the first address starts the next attempt immediately —
    /// it must not wait out the full stagger delay.
    #[tokio::test(start_paused = true)]
    async fn starts_next_immediately_on_fast_failure() {
        let addrs = vec![v6(1), v4(1)];
        let connect = |addr: SocketAddr| async move {
            if addr.is_ipv6() {
                Err::<SocketAddr, std::io::Error>(std::io::Error::new(
                    std::io::ErrorKind::ConnectionRefused,
                    "refused",
                ))
            } else {
                tokio::time::sleep(Duration::from_millis(10)).await;
                Ok(addr)
            }
        };

        let start = tokio::time::Instant::now();
        let got = happy_eyeballs_connect(
            &addrs,
            Duration::from_millis(250),
            Duration::from_secs(15),
            connect,
        )
        .await;
        let elapsed = start.elapsed();

        assert_eq!(got.unwrap(), v4(1));
        assert!(
            elapsed < Duration::from_millis(250),
            "next attempt should start on failure, not after the stagger delay; elapsed={:?}",
            elapsed
        );
    }

    /// When every attempt fails, the error names every address tried.
    #[tokio::test(start_paused = true)]
    async fn aggregates_error_when_all_fail() {
        let addrs = vec![v6(1), v4(1)];
        let connect = |_addr: SocketAddr| async move {
            Err::<SocketAddr, std::io::Error>(std::io::Error::new(
                std::io::ErrorKind::ConnectionRefused,
                "refused",
            ))
        };

        let err = happy_eyeballs_connect(
            &addrs,
            Duration::from_millis(250),
            Duration::from_secs(15),
            connect,
        )
        .await
        .unwrap_err();

        assert!(err.contains("all 2 address(es) failed"), "got: {}", err);
        assert!(
            err.contains("2001:db8::1") && err.contains("192.0.2.1"),
            "should mention both addresses; got: {}",
            err
        );
    }

    /// When every address black-holes, the race ends at the overall timeout.
    #[tokio::test(start_paused = true)]
    async fn times_out_when_all_blackhole() {
        let addrs = vec![v6(1), v4(1)];
        let connect = |addr: SocketAddr| async move {
            tokio::time::sleep(Duration::from_secs(3600)).await;
            Ok::<SocketAddr, std::io::Error>(addr)
        };

        let err = happy_eyeballs_connect(
            &addrs,
            Duration::from_millis(250),
            Duration::from_secs(15),
            connect,
        )
        .await
        .unwrap_err();

        assert!(err.contains("timed out"), "got: {}", err);
    }

    #[tokio::test]
    async fn empty_addresses_is_error() {
        let addrs: Vec<SocketAddr> = vec![];
        let connect = |addr: SocketAddr| async move { Ok::<SocketAddr, std::io::Error>(addr) };

        let err = happy_eyeballs_connect(
            &addrs,
            Duration::from_millis(250),
            Duration::from_secs(15),
            connect,
        )
        .await
        .unwrap_err();

        assert!(err.contains("no addresses"), "got: {}", err);
    }

    // --- connect_tcp (real loopback sockets) ---

    #[tokio::test]
    async fn connect_tcp_reaches_local_listener() {
        use tokio::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();

        let stream = connect_tcp(
            "127.0.0.1",
            port,
            Duration::from_millis(250),
            Duration::from_secs(5),
        )
        .await
        .expect("should connect to the local listener");

        assert_eq!(stream.peer_addr().unwrap().port(), port);
    }

    #[tokio::test]
    async fn connect_tcp_errors_when_nothing_listens() {
        use tokio::net::TcpListener;
        // Bind then drop to obtain a port with (almost certainly) nothing listening.
        let port = {
            let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
            l.local_addr().unwrap().port()
        };

        let err = connect_tcp(
            "127.0.0.1",
            port,
            Duration::from_millis(250),
            Duration::from_secs(5),
        )
        .await
        .unwrap_err();

        assert!(err.contains("TCP connect failed"), "got: {}", err);
    }
}
