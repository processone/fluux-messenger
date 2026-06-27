# URL Schemes and Login Prefill Links

This document describes the URL schemes Fluux understands for **preconfiguring the
login screen** from a link — the `xmpp:` URI scheme on desktop and query-string
parameters on web. The goal is VPN-profile-style provisioning: hand a user a link
and Fluux opens with the login form prefilled (address and, when needed, an
explicit server endpoint). The user still types their password and presses
Connect.

For the server **field value formats** themselves (`wss://`, `tls://`, `tcp://`,
bare domain, etc.) and the transport/proxy architecture, see
[CONNECTION.md](CONNECTION.md). This document is about the **invocation links**
that feed that field; CONNECTION.md is about what the field accepts once filled.

## Principles

- **No credentials, ever.** A link carries an address and connection hints, never
  a password or token. There is no auto-connect from a link — it only seeds the
  form.
- **One validated shape.** Both platforms normalize their input into the same
  `LoginPrefill` object in the SDK (`normalizeLoginPrefill`,
  `packages/fluux-sdk/src/utils/loginPrefill.ts`). Validation — including the
  server-scheme security gate — lives in that single pure function.
- **Visible custom server.** When a link sets a non-default server, the login
  screen reveals and fills the advanced server field and shows a calm, neutral
  note (`A link set a custom server: <host>`) so the user sees the endpoint
  before typing their password.

## The `LoginPrefill` fields

| Field      | Source key | Notes                                                              |
|------------|------------|-------------------------------------------------------------------|
| `jid`      | `jid`      | `local@domain`, or a bare `domain` (web only — see Limitations).  |
| `server`   | `server`   | Explicit endpoint. Same formats as the manual server field (see below). |
| `resource` | `resource` | Optional XMPP resource (e.g. `desktop`). Overrides the default.   |
| `lang`     | `lang`     | Optional UI / `xml:lang` language tag (e.g. `fr`).                |

If neither a usable `jid` nor a usable `server` survives validation, the prefill
is discarded and the login screen behaves normally.

### Accepted `server` formats (security gate)

The `server` value accepts the same formats as the manual login server field
(see [CONNECTION.md](CONNECTION.md)):

| Format            | Example                       | Notes                          |
|-------------------|-------------------------------|--------------------------------|
| WebSocket URL     | `wss://chat.example.com/ws`   | Web and desktop.               |
| BOSH URL          | `https://chat.example.com/http-bind` | Web and desktop.        |
| `tls://` URL      | `tls://chat.example.com:5223` | Desktop only (native proxy).   |
| `tcp://` URL      | `tcp://chat.example.com:5222` | Desktop only (native proxy).   |
| Bare domain       | `process-one.net`             | Desktop only (SRV resolution). |
| `host:port`       | `chat.example.com:5222`       | Desktop only (native proxy).   |

Validation (`normalizeServer`):

- A `scheme://host` URL is accepted only when the scheme is `ws`, `wss`, `http`,
  `https`, `tls`, or `tcp`. Any other scheme (`javascript:`, `file:`, `data:`,
  `blob:`, ...) is **dropped**.
- A value without a scheme must be a **dotted hostname** (e.g. `process-one.net`)
  or `dotted-host:port` with a numeric 1–65535 port. This is what distinguishes a
  legitimate `chat.example.com:5222` from an opaque dangerous URI like
  `javascript:alert(1)` (whose part after the colon is not a port). Single-label
  hosts such as `localhost` are not accepted from a link.
- Whitespace is rejected.

When the `server` is dropped, a valid `jid` in the same link still applies.

> **Platform note:** The native-TCP formats (`tls://`, `tcp://`, bare domain,
> `host:port`) only connect on **desktop**, where the Rust proxy provides native
> TCP/TLS. On **web**, only a `wss://`/`ws://` or `https://` (BOSH) endpoint can
> actually connect — a web link should use one of those. The validator itself is
> platform-agnostic; it does not reject a desktop-only format on web, it simply
> won't connect there.

## Desktop: the `xmpp:` URI scheme

The `xmpp:` scheme (RFC 5122) is registered with the OS through the Tauri
deep-link plugin (`apps/fluux/src-tauri/tauri.conf.json`, `schemes: ["xmpp"]`).

### Forms

| URI                                                              | Effect (when logged out)                              |
|------------------------------------------------------------------|-------------------------------------------------------|
| `xmpp:alice@example.com`                                         | Prefill JID only; server auto-resolved from domain.   |
| `xmpp:alice@example.com?connect;server=<endpoint>`               | Prefill JID + explicit server (any accepted format).  |
| `xmpp:alice@example.com?connect;server=<endpoint>;resource=web;lang=fr` | Prefill JID + server + resource + lang.        |

- The `connect` action carries the connection hints. Parameters follow RFC 5122's
  `;`-delimited form, and values must be **percent-encoded**:

  ```
  xmpp:alice@example.com?connect;server=wss%3A%2F%2Fhost%3A5443%2Fws;resource=desktop
  xmpp:alice@example.com?connect;server=tls%3A%2F%2Fchat.example.com%3A5223
  ```

- A bare `xmpp:alice@example.com` (no action) still prefills the JID.

### When it applies

The prefill path is active **only while the user is logged out** (on the login
screen). The handler `useLoginPrefillDeepLink`
(`apps/fluux/src/hooks/useLoginPrefillDeepLink.ts`) is mounted by `LoginScreen`.

When the user is **already connected**, `xmpp:` links keep their existing
in-app navigation behavior (open a chat, join a room — see
`apps/fluux/src/hooks/useDeepLink.ts`), and any connection hints are ignored.
The two handlers are mutually exclusive because `LoginScreen` and `ChatLayout`
are never mounted at the same time.

Both cold-start (double-clicking a link with the app closed) and the
running-instance case (clicking a link while on the login screen) are covered.

## Web: query-string parameters

On web there is no custom scheme; the prefill travels as ordinary query params on
the app URL, parsed once at boot before React mounts
(`apps/fluux/src/main.tsx` → `captureWebLoginPrefill`).

```
https://app.fluux.example/?jid=alice@example.com&server=wss://chat.example.com:5443/ws
https://app.fluux.example/?jid=alice@example.com&server=wss://host/ws&resource=web&lang=fr
```

| Param      | Example                          |
|------------|----------------------------------|
| `jid`      | `alice@example.com` or `example.com` |
| `server`   | `wss://chat.example.com:5443/ws` |
| `resource` | `web`                            |
| `lang`     | `fr`                             |

After capture, the consumed params (`jid`, `server`, `resource`, `lang`) are
**stripped** from the URL via `history.replaceState`, so a manual reload does not
re-fire the prefill and the values do not linger in the address bar. Any unrelated
query params and the hash route are preserved. Stripping happens even when the
prefill is invalid, so a malformed link cannot survive a reload.

## Behavior summary

| Situation                                       | Result                                              |
|-------------------------------------------------|-----------------------------------------------------|
| Logged out + `connect` URI / bare JID           | Login form prefilled.                               |
| Logged out + web prefill params                 | Login form prefilled; params stripped from URL.     |
| Logged in + any `xmpp:` URI                      | Existing navigation; connection hints ignored.      |
| Invalid / unparseable input                     | Normal login, no prefill, no error surfaced.        |
| `server` with a disallowed scheme               | Field dropped; a valid `jid` still applies.         |
| A link prefill present at login                 | Beats the saved localStorage seed; skips keychain auto-connect for a different saved account. |

## Limitations

- **No password / token transport** by design (would change the security model).
- **Web transport:** native-TCP server formats (`tls://`, `tcp://`, bare domain,
  `host:port`) are accepted by the validator but only connect on desktop; a web
  link should use a `wss://` or `https://` endpoint (see the platform note above).
- **Bare-domain JID on desktop:** `parseXmppUri` requires a JID containing `@`, so
  `xmpp:example.com` does not parse and is ignored on desktop. The web path
  accepts a bare domain.
- **No `.fluux` profile file / OS file-association.** This was deliberately not
  built; if a richer profile format is ever wanted it can serialize to and from
  the same `LoginPrefill` shape.

## Implementation map

| Concern                            | File                                                            |
|------------------------------------|----------------------------------------------------------------|
| Validation / normalized shape      | `packages/fluux-sdk/src/utils/loginPrefill.ts`                 |
| `xmpp:` URI parsing                | `packages/fluux-sdk/src/utils/xmppUri.ts`                      |
| Source adapters (URI + web query)  | `apps/fluux/src/utils/loginPrefillSources.ts`                  |
| One-shot prefill store             | `apps/fluux/src/stores/loginPrefillStore.ts`                   |
| Desktop deep-link → prefill        | `apps/fluux/src/hooks/useLoginPrefillDeepLink.ts`              |
| Web boot capture                   | `apps/fluux/src/main.tsx`                                       |
| Form consumption + custom-server note | `apps/fluux/src/components/LoginScreen.tsx`                  |
| Scheme registration (desktop)      | `apps/fluux/src-tauri/tauri.conf.json`                         |

See also the design spec:
[docs/superpowers/specs/2026-06-27-connection-prefill-links-design.md](superpowers/specs/2026-06-27-connection-prefill-links-design.md).
