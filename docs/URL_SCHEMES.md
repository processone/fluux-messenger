# URL Schemes, Room Message Links and Login Prefill Links

This document describes room message links and the URL schemes Fluux understands
for **preconfiguring the login screen** from a link: the `xmpp:` URI scheme on
desktop and query-string parameters on web. Login prefill provides
VPN-profile-style provisioning: hand a user a link and Fluux opens with the login form prefilled (address and, when needed, an
explicit server endpoint). The user still types their password and presses
Connect.

For the server **field value formats** themselves (`wss://`, `tls://`, `tcp://`,
bare domain, etc.) and the transport/proxy architecture, see
[CONNECTION.md](CONNECTION.md). This document is about the **invocation links**
that feed that field; CONNECTION.md is about what the field accepts once filled.

## Room message links

Fluux extends the XMPP room join URI with an opaque `msg` parameter:

```
xmpp:team@conference.example.org?join;msg=1731490000123456
```

The address is the bare room JID. The value of `msg` is the room-assigned
XEP-0359 stanza-id, percent-encoded as one URI component. Sender client ids and
origin ids are not interchangeable with this archive id. Use the SDK's
`buildRoomMessageLink(roomJid, stanzaId)` and `parseRoomMessageLink(uri)` to build
and read the format. The `msg` extension is a Fluux convention, not a registered
XEP-0147 parameter; other clients can still interpret the `join` action.

**Copy message link** appears in a room message's More menu and mobile long-press
actions when the room supports archiving and the public, sent message has a
room-assigned id. It is separate from **Copy link**, which copies a URL in the
message body. Private room whispers and unconfirmed messages have no message link.

Clicking an `xmpp:` link inside Fluux is handled in the app on web, desktop and
phones, without asking the operating system to select a handler. Existing macOS
and iOS system-link entry points use the same navigation after connection; this
does not register a web browser handler or add Android system-link support.

Opening a message link does not automatically join its room. A reader who is not
currently joined sees the room's Join button; the existing real-address warning
and password prompt still apply. After a successful join Fluux resumes the jump.
Only then does Fluux look in resident history, the room-scoped local cache and
finally the room archive. An archive lookup loads the entry and at most 25
entries on either side using id-exact RSM cursors, never a time-window guess.
Bounded context is stored separately from live history without claiming
continuity, advancing read state or delivering an old message as a new arrival.
The normal message target navigation scrolls to and highlights the resolved row.

When lookup confirms the target is missing or deleted, Fluux shows
**This message is no longer available**. A failed archive request produces
**Could not load this message**, not a deletion
claim. Links reveal the room address and archive id, not the message text, and do
not grant access to a room. There is no web landing page or forwarded copy.

### Sharing inside chats

Sending a body containing a room message link adds an XEP-0372 reference with
`type="data"` and `uri` set to the link. The body remains readable in other XMPP
clients; no original room text is embedded. References travel inside the encrypted
payload when the chat uses end-to-end encryption. Receivers retain references in
live messages and archived history, prefer a valid data reference, and fall back
to finding the link in the body. The SDK's `findRoomMessageLink` implements this
selection; `roomMessageLinkReferences` finds pasted links and their body ranges.

Below a shared link, a joined reader sees a quote with the room name, sender,
time and a two-line excerpt resolved from their own resident history, local
cache or archive. `readRoomMessagePreview` performs this lookup without adding
arrivals, moving a room's history window or claiming archive coverage. When the
original comes from the archive, the lookup reads subsequent pages to apply
separately archived edits and deletions before displaying its text. Live updates
also reconcile quotes whose targets are no longer in the resident window. A deleted
target shows **Message deleted**; a failed lookup keeps an **Open message in
room** link rather than claiming deletion. Undecryptable content is never quoted.

A reader who has not joined sees only the room name and **Join the room to see
it**. No cache or archive content is disclosed to that reader. The preview opens
the same in-app navigation as the text link; it does not join automatically.
Leaving a room or changing accounts hides its quote and invalidates pending
preview reads. The Forward chat picker is a separate feature.

## Login prefill principles

- **No credentials, ever.** A link carries an address and connection hints, never
  a password or token. There is no auto-connect from a link, it only seeds the
  form.
- **One validated shape.** Both platforms normalize their input into the same
  `LoginPrefill` object in the SDK (`normalizeLoginPrefill`,
  `packages/fluux-sdk/src/utils/loginPrefill.ts`). Validation, including the
  server-scheme security gate, lives in that single pure function.
- **Visible custom server.** When a link sets a non-default server, the login
  screen reveals and fills the advanced server field and shows a calm, neutral
  note (`A link set a custom server: <host>`) so the user sees the endpoint
  before typing their password.

## The `LoginPrefill` fields

| Field      | Source key | Notes                                                              |
|------------|------------|-------------------------------------------------------------------|
| `jid`      | `jid`      | `local@domain`, or a bare `domain` (web only, see Limitations).   |
| `server`   | `server`   | Explicit endpoint. Same formats as the manual server field (see below). |
| `resource` | `resource` | Optional XMPP resource (e.g. `desktop`). Overrides the default.   |
| `lang`     | `lang`     | Optional UI / `xml:lang` language tag (e.g. `fr`).                |

If neither a usable `jid` nor a usable `server` survives validation, the prefill
is discarded and the login screen behaves normally.

### Accepted `server` formats (security gate)

For server-field formats and platform transport support, see
[Connection Schemes](CONNECTION.md#server-field-formats). Prefill validation
is platform-agnostic and applies the security restrictions below.

Validation (`normalizeServer`):

- A `scheme://host` URL is accepted only when the scheme is `ws`, `wss`, `http`,
  `https`, `tls`, or `tcp`. Any other scheme (`javascript:`, `file:`, `data:`,
  `blob:`, ...) is **dropped**. A URL that embeds credentials
  (`wss://user:pass@host`) is also dropped.
- A value **without a scheme** must be a **dotted hostname** (e.g.
  `process-one.net`) or `dotted-host:port` with a numeric 1-65535 port. This is
  what distinguishes a legitimate `chat.example.com:5222` from an opaque
  dangerous URI like `javascript:alert(1)` (whose part after the colon is not a
  port). A single-label host such as `localhost` is **not** accepted in this
  shorthand form (it is ambiguous with a scheme); use an explicit
  `wss://localhost/ws` URL if you really need a single-label host.
- Whitespace is rejected.

When the `server` is dropped, a valid `jid` in the same link still applies.

Transport selection and platform fallbacks follow
[Connection Resolution](CONNECTION.md#connection-resolution).

## Desktop: the `xmpp:` URI scheme

The `xmpp:` scheme (RFC 5122) is registered with the OS through the Tauri
deep-link plugin. The base registration is in `apps/fluux/src-tauri/tauri.conf.json`.
On macOS, `tauri.macos.conf.json` registers both `xmpp` and `net.processone.fluux`;
the Dev override in `tauri.dev.conf.json` uses `xmpp` and `net.processone.fluux.dev`.
The app-specific scheme opens widget conversation links with account validation.

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

One router (`apps/fluux/src/utils/deepLinkRouter.ts`) reads the launch URL
once and keeps one live listener for the whole app. Where a link goes depends
on what is on screen:

- **Startup reconnect pending** (the app reopened with a tab session, a
  remembered FAST token or a keychain password): a login link (`connect`
  action, or a bare user address) replaces the saved account at any moment —
  the reconnect is abandoned, a connection in flight is cancelled, and the
  login form opens with the link's account. A room-join or message link is
  navigation: it waits and runs once the account is online.
- **Logged out** (login form up): a login link prefills the form; a navigation
  link waits for the next time the app is online.
- **Already connected**: `xmpp:` links keep their existing in-app navigation
  behavior (open a chat, join a room, see `apps/fluux/src/hooks/useDeepLink.ts`),
  and any connection hints are ignored.

Both cold-start (double-clicking a link with the app closed) and the
running-instance case (clicking a link while the app runs) are covered. The
login form reads the launch link before it consults the keychain, so a link
that opened the app wins over a saved account.

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
| Startup reconnect pending + login link          | Reconnect abandoned (connection cancelled); login form with the link's account. |
| Startup reconnect pending + `join` / `message` URI | Reconnect continues; the link runs once online.  |

## Limitations

- **No password / token transport** by design (would change the security model).
- **Web transport:** native-TCP server formats (`tls://`, `tcp://`, and
  `host:port`) are accepted by the validator but only connect on desktop. Bare
  domains use the web discovery path described in the platform note above.
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
| Deep-link router (one listener)    | `apps/fluux/src/utils/deepLinkRouter.ts`                       |
| Startup owner (login link replaces the saved account) | `apps/fluux/src/hooks/useSessionPersistence.ts`     |
| Web boot capture                   | `apps/fluux/src/main.tsx`                                       |
| Form consumption + custom-server note | `apps/fluux/src/components/LoginScreen.tsx`                  |
| Scheme registration (desktop)      | `apps/fluux/src-tauri/tauri.conf.json`, `tauri.macos.conf.json` and `tauri.dev.conf.json` |

See also the design spec:
[docs/superpowers/specs/2026-06-27-connection-prefill-links-design.md](superpowers/specs/2026-06-27-connection-prefill-links-design.md).
