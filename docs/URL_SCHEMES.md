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
| `server`   | `server`   | Explicit service URL. Allowlisted schemes only (see below).       |
| `resource` | `resource` | Optional XMPP resource (e.g. `desktop`). Overrides the default.   |
| `lang`     | `lang`     | Optional UI / `xml:lang` language tag (e.g. `fr`).                |

If neither a usable `jid` nor a usable `server` survives validation, the prefill
is discarded and the login screen behaves normally.

### Server scheme allowlist (security gate)

The `server` value must parse as a URL whose scheme is one of:

```
ws://    wss://    http://    https://
```

Any other scheme (`javascript:`, `file:`, `data:`, ...) is **dropped** — a valid
`jid` in the same link still applies. This prevents a malicious link from pointing
the password form at a dangerous URL.

> **Limitation (desktop):** This allowlist does **not** include the native-proxy
> formats `tls://`, `tcp://`, a bare domain, or `host:port` that the manual server
> field accepts (see [CONNECTION.md](CONNECTION.md)). On desktop, where
> connections normally use native TCP/TLS, a prefill link can therefore only
> carry a WebSocket (`wss://`/`ws://`) or BOSH (`https://`) endpoint, not a
> `tls://host` or bare-domain SRV target. Provisioning a desktop user with a
> native-TCP server via a link is not currently possible.

## Desktop: the `xmpp:` URI scheme

The `xmpp:` scheme (RFC 5122) is registered with the OS through the Tauri
deep-link plugin (`apps/fluux/src-tauri/tauri.conf.json`, `schemes: ["xmpp"]`).

### Forms

| URI                                                              | Effect (when logged out)                              |
|------------------------------------------------------------------|-------------------------------------------------------|
| `xmpp:alice@example.com`                                         | Prefill JID only; server auto-resolved from domain.   |
| `xmpp:alice@example.com?connect;server=<url>`                    | Prefill JID + explicit server.                        |
| `xmpp:alice@example.com?connect;server=<url>;resource=web;lang=fr` | Prefill JID + server + resource + lang.             |

- The `connect` action carries the connection hints. Parameters follow RFC 5122's
  `;`-delimited form, and values must be **percent-encoded**:

  ```
  xmpp:alice@example.com?connect;server=wss%3A%2F%2Fhost%3A5443%2Fws;resource=desktop
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
- **Desktop server formats:** only `wss://`/`ws://`/`https://` endpoints
  (see the security-gate note above); not `tls://`, `tcp://`, bare domain, or
  `host:port`.
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
