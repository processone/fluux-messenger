# Connection Schemes

This document describes how Fluux Messenger connects to XMPP servers, including the server field formats, the TCP proxy architecture, and the resolution logic for each platform.

## Overview

Fluux supports two connection paths:

| Platform            | Transport                     | Proxy                              |
|---------------------|-------------------------------|------------------------------------|
| **Native apps** (Tauri desktop, iOS, Android) | Native TCP/TLS via Rust proxy | WebSocket ↔ TCP proxy on localhost |
| **Web**             | WebSocket (RFC 7395)          | None: direct WebSocket to server   |

In native apps, a Rust-based proxy translates between WebSocket framing (used by the xmpp.js client library) and traditional TCP XMPP framing. This allows native TCP and TLS connections without browser restrictions. For experimental mobile setup and platform limitations, see [Android development](ANDROID_DEVELOPMENT.md) and [iOS development](IOS_DEVELOPMENT.md).

## Server Field Formats

The server field in the login screen accepts several formats. Native endpoint parsing is centralized in the Rust proxy (`parse_server_input()` in `apps/fluux/src-tauri/src/xmpp_proxy/dns.rs`).

| Format             | Example                       | Behavior                                  |
|--------------------|-------------------------------|-------------------------------------------|
| *(empty)*          |                               | Domain extracted from JID, then resolved  |
| Domain only        | `process-one.net`             | XEP-0156 discovery, with platform fallbacks |
| Domain + port      | `chat.example.com:5222`       | Direct connect, STARTTLS                  |
| Domain + port 5223 | `chat.example.com:5223`       | Direct connect, direct TLS                |
| `tls://` URI       | `tls://chat.example.com:5223` | Direct TLS, skip SRV                      |
| `tls://` no port   | `tls://chat.example.com`      | Direct TLS, default port 5223             |
| `tcp://` URI       | `tcp://chat.example.com:5222` | STARTTLS, skip SRV                        |
| `tcp://` no port   | `tcp://chat.example.com`      | STARTTLS, default port 5222               |
| WebSocket URL      | `wss://chat.example.com/ws`   | Bypass proxy, direct WebSocket            |

### Scheme details

- **`tls://`**: Direct TLS connection (the TLS handshake happens immediately on connect, before any XMPP traffic). Default port: 5223.
- **`tcp://`**: Plain TCP connection with STARTTLS upgrade (the connection starts unencrypted, then upgrades to TLS via the XMPP STARTTLS mechanism). Default port: 5222.
- **`host:port`** (no scheme). Port 5223 is treated as direct TLS, any other port as STARTTLS. This is a convenience shorthand when you know the port but don't want to type a scheme.
- **`wss://`** or **`ws://`**. WebSocket URL passed directly to xmpp.js, bypassing the TCP proxy entirely. Useful when the server exposes a native WebSocket endpoint.

### Port heuristic for bare `host:port`

When only `host:port` is specified (no scheme), the proxy infers the connection mode from the port number:

- Port **5223** → Direct TLS (this is the conventional XMPP-over-TLS port)
- Any other port → STARTTLS

To override this heuristic, use an explicit `tls://` or `tcp://` scheme.

## SRV Resolution

When the server field is empty or contains a bare domain (no port, no scheme), the proxy performs DNS SRV resolution per [RFC 6120](https://www.rfc-editor.org/rfc/rfc6120):

1. **`_xmpps-client._tcp.{domain}`**. Direct TLS (XEP-0368). If found, connects with direct TLS to the resolved host and port.
2. **`_xmpp-client._tcp.{domain}`**. STARTTLS. If found, connects with STARTTLS to the resolved host and port.
3. **Fallback**. If no SRV records are found, connects to `{domain}:5222` with STARTTLS (the standard XMPP client port per RFC 6120).

The TLS-first order means servers that publish `_xmpps-client` SRV records will get direct TLS connections without any user configuration.

## TCP Proxy Architecture

In native apps, TCP/TLS connections flow through a local WebSocket-to-TCP proxy:

```
xmpp.js ──WebSocket──► localhost:PORT ──TCP/TLS──► XMPP server
         (RFC 7395)    (Rust proxy)    (RFC 6120)
```

The proxy handles:

1. **Framing translation**. Converts between RFC 7395 WebSocket framing (`<open/>`, `<close/>`) and traditional TCP stream framing (`<stream:stream>`, `</stream:stream>`).
2. **Namespace rewriting**. Rewrites `<stream:features>` and `<stream:error>` to standalone XML with explicit `xmlns` attributes, since the WebSocket framing model doesn't have a parent `<stream:stream>` element to declare `xmlns:stream`.
3. **TLS/STARTTLS**. Handles direct TLS connections and STARTTLS upgrades natively in Rust (see below).
4. **SRV resolution**. Performs DNS SRV lookups to find the correct host and port.

### STARTTLS Negotiation

The proxy performs STARTTLS negotiation transparently on behalf of xmpp.js. This is necessary because xmpp.js cannot perform STARTTLS over WebSocket connections (its `canUpgrade()` guard returns false for non-TCP sockets).

When connecting to a STARTTLS endpoint (port 5222 or `tcp://`), the proxy:

1. Opens a plain TCP connection to the XMPP server
2. Sends `<stream:stream>` and reads the server's `<stream:features>`
3. Verifies the server offers `<starttls xmlns='urn:ietf:params:xml:ns:xmpp-tls'/>`
4. Sends `<starttls/>` and waits for `<proceed/>`
5. Upgrades the TCP socket to TLS using rustls

After the upgrade, the connection is handled identically to a direct TLS connection. xmpp.js never sees the STARTTLS exchange, it connects to `ws://127.0.0.1:PORT` and starts a normal XMPP session. The local WebSocket hop is treated as secure by xmpp.js (localhost exemption).

```
xmpp.js ──WebSocket──► Rust proxy ──[STARTTLS negotiation]──► TLS ──► XMPP server
         (plaintext     (localhost)   (transparent to client)          (encrypted)
          but local)
```

### Reconnection

When the connection drops, the SDK's reconnection logic:

1. Stops the old proxy (the TCP connection is dead)
2. Starts a fresh proxy using the **original** server string (not the resolved localhost URL)
3. Creates a new xmpp.js client pointing to the new proxy
4. Attempts Stream Management session resumption (XEP-0198) if state is available

The original server string is preserved separately from the resolved credentials to ensure reconnection always goes through the full resolution path.

## Connection Resolution

For a domain target, all platforms first try XEP-0156 WebSocket discovery via
`https://{domain}/.well-known/host-meta.json`, then `https://{domain}/.well-known/host-meta`
if JSON yields no usable WebSocket endpoint. A configured `ConnectOptions.fallbackWebSocketUrl`
is tried only when discovery produces no endpoint, including when discovery fails. A discovered
endpoint always wins. A `wss://` or `ws://` server value is explicit and skips discovery;
the connection log explains this skip.

After those shared steps, the platform paths differ:

- On web, the last fallback is the synthesised `wss://{domain}/ws` URL.
- In native apps, a discovered or configured WebSocket endpoint is tried first. If it fails,
  or if neither exists, the native TCP/TLS proxy performs SRV resolution.

Serving the discovery document through a redirect is an ordinary configuration. Readable redirect
chains may use at most two hops; where browsers hide redirect targets, discovery delegates one follow
to the browser and requires the reported final URL to remain HTTPS. Loops, insecure targets, and
over-budget chains produce no discovered endpoint, allowing the applicable fallback above to take over.

The `tls://` and `tcp://` schemes are not usable on web. If specified (e.g., from saved settings), the SDK falls back to WebSocket discovery using the JID domain.

### Discovery diagnostics

When discovery yields no WebSocket endpoint, the connection log lists the outcome for each
host-meta URL attempted and names the selected fallback: a configured URL, a guessed URL,
or native TCP/SRV. It distinguishes a document with no usable secure WebSocket endpoint from
an HTTP error, timeout, unreadable or unparsable document, rejected redirect, or failed request.
Known redirect rejection reasons are included; failures hidden by the browser remain request
failures.

For web clients fetching host-meta across origins, the discovery responses must include
`Access-Control-Allow-Origin` allowing the origin serving Fluux. A failed browser request may
mean a network error or a CORS restriction; the log identifies CORS as a possibility, not a
confirmed cause. Check the browser's developer console and the server's response headers to
distinguish them.

If discovery finds no endpoint, at least one document read fails, and the fallback connection
also fails, the login error includes a discovery hint with the domain and the final attempted
WebSocket URL or native TCP target. This supplements the connection error; the connection log
contains the individual discovery outcomes. Documents read successfully with no usable endpoint
do not by themselves trigger this hint.

## Debug Flags

| Flag                      | Storage        | Effect                                       |
|---------------------------|----------------|----------------------------------------------|
| `fluux:disable-tcp-proxy` | `localStorage` | Force WebSocket mode in native apps (skip proxy) |

Set via browser console: `localStorage.setItem('fluux:disable-tcp-proxy', 'true')`

## Files

| File                                                | Role                                                                       |
|-----------------------------------------------------|----------------------------------------------------------------------------|
| `apps/fluux/src-tauri/src/xmpp_proxy/`              | Rust proxy: parsing, SRV resolution, TCP/TLS bridging, framing translation |
| `apps/fluux/src-tauri/src/xmpp_proxy/commands.rs`    | Tauri commands: `start_xmpp_proxy(server)`, `stop_xmpp_proxy()`            |
| `packages/fluux-sdk/src/core/modules/Connection.ts` | SDK connection module: proxy lifecycle, reconnection, WebSocket fallback   |
| `apps/fluux/src/i18n/locales/en.json`               | UI placeholder and hint text for the server field                          |
