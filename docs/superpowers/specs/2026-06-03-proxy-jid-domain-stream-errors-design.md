# Proxy: JID-domain for explicit endpoints + surfacing upstream stream errors

- **Date:** 2026-06-03
- **Status:** Proposed (awaiting review)
- **Area:** `apps/fluux/src-tauri/src/xmpp_proxy/`, `packages/fluux-sdk/src/core/modules/Connection.ts`, `apps/fluux/src` (LoginScreen + i18n)

## Problem

Connecting with an explicit STARTTLS/TLS server override fails. Reproduced with
JID `mremond@process-one.net` and server `tcp://chat.process-one.net`. The login
screen shows a misleading `WebSocket ECONNERROR ws://127.0.0.1:60342`.

Evidence from `~/Library/Logs/com.processone.fluux/fluux.log.2026-06-03`
(conn_id=2, the screenshot's port 60342):

```
Using explicit endpoint host=chat.process-one.net port=5222 mode=Tcp domain=None
New WebSocket connection addr=127.0.0.1:60343          # loopback OK
Connected (TCP), performing STARTTLS                    # TCP to server OK
STARTTLS: Unexpected stanza before features stanza=<stream:error><host-unknown/></stream:error>
Endpoint failed ... STARTTLS: Server closed connection before features
-> webview: WebSocket ECONNERROR ws://127.0.0.1:60342
```

**Root cause (two independent defects):**

1. **Wrong XMPP domain.** `parse_server_input("tcp://chat.process-one.net")`
   yields `domain: None`, so `XmppEndpoint::tls_name()` falls back to the
   *connection host* `chat.process-one.net`. `perform_starttls` then sends
   `<stream:stream to='chat.process-one.net'>` and uses that host for TLS SNI.
   The ejabberd server hosts the vhost `process-one.net`, so it returns
   `<stream:error><host-unknown/></stream:error>` and closes. The connection
   host is *not* the service domain — they legitimately differ.

2. **The real error is swallowed.** The `host-unknown` failure happens during
   STARTTLS, **before the WS↔TLS bridge starts**. `handle_connection` propagates
   the error with `?` and the WebSocket is dropped **without a close frame**.
   xmpp.js sees an abnormal 1006 close and reports the generic
   `WebSocket ECONNERROR`. The existing `proxy-connection-closed` event and the
   enriched `"Bridge closed: stream-error <condition>"` close reason are only
   produced **inside** `bridge_websocket_tls` (post-bridge), so neither fires here.

Not a transport problem: loopback and TCP both succeeded. (The morning `[::1]`
loopback binds in the same log are unrelated and connected fine.)

## History / regression analysis

It *feels* like a regression — the bare domain `process-one.net` connects fine
(SRV resolves host `chat.process-one.net` + domain `process-one.net`, so STARTTLS
sends `to='process-one.net'`), yet typing that **same host** as
`tcp://chat.process-one.net` fails. The git history shows a long-standing latent
gap rather than a single-commit break:

- **`da3a38bc` (#134, "Add TCP connection support")** introduced `perform_starttls`
  and called it with the **connection host** (`perform_starttls(tcp_stream,
  &endpoint.host)`). Explicit STARTTLS endpoints have used the host as the `to=`/SNI
  ever since.
- **`8e624f54` ("…TLS SNI domain handling…")** added `XmppEndpoint.domain`,
  `tls_name()`, and the `?domain=` override, wiring the JID domain for the **SRV
  path** — but explicit endpoints kept `domain: None` (host fallback), and **no
  frontend code ever produces `?domain=`**, so that override is dead.
- **Direct TLS (`tls://`, port 5223) accidentally works:** the proxy sends no
  pre-TLS header, so the client's own `<open to='process-one.net'/>` reaches the
  server through the bridge with the correct domain. Only STARTTLS — which needs a
  proxy-generated pre-TLS header — is wrong. The fix removes that asymmetry by
  feeding the same client `<open to=>` into the STARTTLS header.

Implication for tests: a regression guard must assert the **STARTTLS pre-TLS
stream header carries the JID domain when the connection host differs** — the
exact thing that has silently been host-based since #134.

## Goals

1. Explicit endpoints (`tcp://`, `tls://`, `host:port`) use the **JID's domain**
   as the STARTTLS `to=` and TLS SNI, so connecting via a front host that serves
   a different vhost works.
2. When the upstream returns **any** stream error (`host-unknown`,
   `see-other-host`, `not-authorized`, `conflict`, …), surface that condition as
   a clear, localized message on the login screen instead of `ECONNERROR` — for
   both pre-bridge and post-bridge failures.

## Non-goals

- No change to the SRV-resolution path (it already attaches the JID domain).
- No new login form field; the existing `?domain=` override stays as the
  power-user escape hatch and keeps precedence.
- No redesign of reconnection / state machine.

## Approved decisions

- **Domain source:** read the JID domain from the **client's initial `<open to=>`**
  stanza, which xmpp.js already sends in-band (the SDK configures the client with
  `getDomain(jid)`; `from='user@domain'` is already forwarded). Pure Rust, no
  SDK/adapter/UI plumbing.
- **Error scope:** surface **any** upstream stream-error condition (generic
  mapping with per-condition messages for the common cases).

## Design

### Part 1 — JID domain from the client `<open/>`

Domain precedence for an explicit endpoint becomes:
`?domain=` (explicit override) → client `<open to=>` → connection host (today's fallback).

- **`framing.rs`:** factor the `<open>` attribute parsing currently inlined in
  `translate_ws_to_tcp` into a shared helper and expose
  `extract_open_to(text: &str) -> Option<String>` (returns a non-empty `to`).
  This avoids duplicating the quick-xml parsing (per CLAUDE.md: no duplication).
- **`mod.rs` `handle_connection`:** after `wait_for_initial_client_stanza`,
  compute `client_domain = extract_open_to(&initial_ws_text)` and pass it to
  `connect_upstream_tls`.
- **`mod.rs` `connect_upstream_tls(server_input, client_domain: Option<&str>)`:**
  for `ParsedServer::Direct(host, port, mode, parsed_domain)`, set the endpoint
  domain to `parsed_domain.or(client_domain)`. `ParsedServer::Domain` (SRV) is
  unchanged. `tls_name()` then yields the JID domain, used for both the STARTTLS
  `to=` and TLS SNI/verification — making explicit endpoints behave exactly like
  the SRV path (host = where to connect, domain = what to verify, RFC 6120 §13.7.2).

### Part 2 — Surface upstream stream errors

- **`perform_starttls`:** when an extracted stanza is a stream error
  (`extract_stream_error_condition` returns `Some`), stop and return an error that
  **carries the condition**, instead of the generic "Server closed connection
  before features".
- **Error type:** introduce a small `UpstreamConnectError { message: String,
  stream_error: Option<String> }` returned by `perform_starttls` /
  `try_connect_endpoint` / `connect_upstream_tls`, so the condition survives the
  per-endpoint aggregation (record the first condition seen).
- **`mod.rs` `handle_connection`:** on `connect_upstream_tls` error, **before
  returning**, (a) send a clean RFC7395 `<close/>` + WebSocket close frame whose
  reason is `format_bridge_close_reason(label, condition)` (e.g.
  `"Bridge closed: stream-error host-unknown"`), and (b) emit the existing
  `proxy-connection-closed` event with `{ conn_id, reason, stream_error }`. Factor
  the close handshake currently inlined in `bridge_websocket_tls` into a shared
  `send_ws_close_handshake(ws, reason)` helper used by both paths.
  - Result: the webview gets a clean **1000** close with the enriched reason
    (recognised by `Connection.ts:2086` `isExpectedBridgeClose`) instead of an
    abrupt 1006 drop, and the Tauri event now fires for pre-bridge failures too.

### Part 3 — Frontend surfacing (as built)

- **`streamErrors.ts` (new SDK module):** two pure helpers —
  `extractStreamErrorCondition(text)` (recovers the condition from the proxy's
  `"… stream-error <condition>"` encoding, including inside a verbose
  WebSocket-close message) and `humanizeStreamError(text)` (maps known conditions
  — `host-unknown`, `see-other-host`, `not-authorized`, `conflict`, `host-gone`,
  `remote-connection-failed`, `policy-violation`, … — to a clear, actionable
  sentence that still shows the raw condition; generic fallback otherwise;
  `null` when no condition is present).
- **`Connection.ts`:** call `humanizeStreamError` in the two places the
  user-facing connection error is built — the `connect()` catch (display string
  for `CONNECTION_ERROR`/`emitSDK`) and the `initialFailure` disconnect branch
  (which already folds the bridge close reason). When a condition is present the
  humanized message replaces the transport noise; otherwise the existing message
  is untouched. Machine routing stays keyed on the original message.
- **`LoginScreen.tsx`:** no change — it already renders `connection.error`
  verbatim, so the clearer message surfaces automatically (consistent with the
  other English transport messages the SDK already emits, e.g. the local-proxy
  firewall hint).
- **Deferred:** full fr/en localization of connection errors. The app does not
  localize connection errors today (they render raw), so localizing only stream
  errors would be inconsistent. `extractStreamErrorCondition` is structured so a
  later i18n pass can map the condition to `login.streamError.*` keys.

## Affected units

| Unit | Type | Responsibility |
|------|------|----------------|
| `framing::extract_open_to` | new, pure | Read `to=` from an `<open/>` frame |
| `connect_upstream_tls` | changed | Accept `client_domain`, apply domain precedence |
| `perform_starttls` | changed | Detect stream-error, return its condition |
| `UpstreamConnectError` | new | Carry `(message, stream_error)` up the stack |
| `send_ws_close_handshake` | new (extracted) | Send RFC7395+WS close with reason |
| `handle_connection` | changed | Close cleanly + emit event on upstream failure |
| `Connection.ts` close path | changed | Extract condition into `connection.error` |
| `LoginScreen` + i18n | changed | Localized message; reveal server field |

## Testing

The user explicitly asked for regression coverage. The guards below lock in the
*correct* behavior so the host-based `to=` can never silently return.

**Regression guards (must fail on today's code, pass after the fix):**

- **R1 — STARTTLS uses JID domain when host differs (the core regression).**
  Fake-upstream harness (like `test_handle_connection_*`): client sends
  `<open to='process-one.net'/>`, `server_input = tcp://127.0.0.1:<fakeport>`
  (host ≠ domain). Assert the proxy's pre-TLS `<stream:stream>` carries
  `to='process-one.net'`, **not** the connection host. This is the exact case
  that has been host-based since #134.
- **R2 — `?domain=` keeps precedence.** `server_input =
  tcp://127.0.0.1:<fakeport>?domain=explicit.example` with client
  `<open to='process-one.net'/>` → header carries `to='explicit.example'`
  (override wins over the client `<open to=>`).
- **R3 — direct-TLS / STARTTLS consistency.** Document the path that already
  works: `tls://`/5223 lets the client `<open to=>` reach the server unchanged;
  after the fix STARTTLS matches it. (Covered structurally by R1.)

**Unit tests:**

- **`framing::extract_open_to`:** with/without `to`, single/double quotes,
  non-`<open>` input, empty `to`.
- **`dns::parse_server_input`:** explicit `tcp://host` / `tls://host` /
  `host:port` still yield `domain: None` (documents that the host fallback is
  intentional and that the client `<open to=>` is what now supplies the domain).
- **Part 2 surfacing:** fake upstream replies
  `<stream:error><host-unknown/></stream:error>`; assert the client receives a
  1000 close whose reason contains `stream-error host-unknown` (today it drops
  with no frame → 1006).
- **SDK / `Connection.test.ts`:** a `Bridge closed: stream-error host-unknown`
  close reason ends up as a `host-unknown`-bearing `connection.error`.
- **App:** `streamErrorMessage` maps known conditions; new i18n keys exist in
  both locales.

Existing suites for `dns.rs`, `framing.rs`, and the proxy harness must stay green.

## Backward compatibility / risks

- Domain precedence keeps `?domain=` first and leaves the SRV path untouched →
  low risk.
- Explicit endpoints now verify the TLS cert against the **JID domain** (correct
  per RFC 6120), not the connection host. A user who relied on connecting to a
  host whose certificate only matches the host name would now need the
  `?domain=`/host certificate to cover the JID domain — this is the correct
  behavior, and `?domain=` remains available. Note in release notes.
- Pre-bridge failures now close with code 1000 (+`Bridge closed` reason) instead
  of 1006; the SDK already treats that as an expected terminal bridge close.
