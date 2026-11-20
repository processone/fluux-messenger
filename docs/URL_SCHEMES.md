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
not grant access to a room. There is no web landing page. Forward adds a quoted copy, described below.

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
original comes from the archive, the lookup reads subsequent pages (at most 100
entries each, fewer where the server caps pages lower) to apply separately archived edits and deletions before displaying
its text. To keep many links in one room from flooding the server, a lookup reads
at most ten such pages and each client instance runs at most two of these walks
at once; others wait. The first page asks only for entries from the original's time on, so a server that reports a count lets the lookup stop right away, after about three requests, when that tail alone exceeds what the cutoff can read. The time used is the archive's own time for the original, and an edit or deletion on that first page still applies before the lookup gives up. If the cutoff is reached before the archive ends, the quote
is unavailable (the same state as a failed lookup) rather than possibly stale. Live updates
also reconcile quotes whose targets are no longer in the resident window. Update
references resolve against canonical room/cache/archive targets, so a sender id
cannot shadow another message's room-assigned id. Closing or unmounting a quote
cancels further lookup pages and entry decryption; an already pending request may
finish. A deleted
target shows **Message deleted**; a failed lookup keeps an **Open message in
room** link rather than claiming deletion. Undecryptable content is never quoted.

A reader who has not joined sees only the room name and **Join the room to see
it**. No cache or archive content is disclosed to that reader. The preview opens
the same in-app navigation as the text link; it does not join automatically.
Leaving a room or changing accounts hides its quote and invalidates pending
preview reads.

**Forward message** on a linkable room message, or on a readable one-to-one message, opens a picker of contacts, existing
chats and currently joined rooms where you can send messages. On phones it is in
the long-press action menu.
Typing narrows the list by name or by the part of the address before @, and Enter
picks the highlighted entry; only listed destinations can be picked.
Choose one destination, optionally add a comment, then press **Send**. Fluux sends
one ordinary message: the comment (if any), a plain-text quote attributed to the
author (`> Nick wrote:` followed by the quoted lines, clipped at 500 characters),
then the room message link, with the same XEP-0372 data reference as a pasted link.
A source that is retracted or cannot be read is forwarded as the link only.
A forward to a room always sends this quoted form.

A one-to-one message has no room link, so its forward is the comment and the quote only, with no link or data reference. The quote names the sender by address (a room message by its occupant nick), never by your contact-list name. To a one-to-one chat it also carries the structured copy below, whose fallback marker covers the quote alone.

The generated quote and link are marked with XEP-0428 Fallback Indication:
`<fallback xmlns="urn:xmpp:fallback:0" for="urn:fluux:forward-quote:0">` with one
`<body start end/>` range covering the quote and link (code points, XEP-0426). The
comment stays outside the range. A reader keeps the marker with the link's data
reference and hides the range only while its preview shows the source's own
content, which requires the reader to be in the room and the source to be readable.
Otherwise (not joined, deleted, still loading or undecryptable) the quote and link
stay visible under the label **Quoted copy from a forwarded message**. Other clients
do not know this feature name and show the quote and link as plain text. A marker
whose range holds no room message link is ignored.

In an encrypted chat the quote, link, reference and fallback marker all travel
inside the encrypted payload; the outer body keeps only the generic encryption
notice, and a failed encryption never falls back to plaintext. A failed send that
is retried keeps the marker. Cancelling sends nothing; a send failure keeps the
picker and comment available. Forward is unavailable for whispers, unconfirmed
messages and, for a room message, messages without a room archive id, just like Copy message link.
A message read from an encrypted chat can be forwarded only into an encrypted
chat: rooms are not offered for it, and a send, retry or edit that would go out
unencrypted is refused before anything is sent. A retracted or failed one-to-one
message, or an undecryptable one, has no Forward; an undecryptable room message still
offers the link only. A message that holds a structured copy, beside a comment or alone, forwards its displayed comment and the copied text under its claimed author as one readable quote, with no nested copy.

**Structured copy (XEP-0297).** A forward to a one-to-one chat is one stanza for every
reader: the same comment, quote and link as the quoted form above, plus a standalone
`<forwarded xmlns="urn:xmpp:forward:0">` copy, and a XEP-0428
`<fallback xmlns="urn:xmpp:fallback:0" for="urn:xmpp:forward:0">` whose `<body start end/>`
marks the quote and link (code points, as in the body). Fluux asks no device what it
supports: a reader that shows the copy may hide the marked text, and any other reader
shows the whole body. Fluux hides the marked text only while it shows the copy; a message
whose copy is missing (an archive may drop extensions), malformed, retracted or still
encrypted keeps it visible, and a marker outside the body is ignored. The stored marker remembers the exact text it marked, so an edit that changes that text leaves the copy and shows the whole new body. In an encrypted chat a marker outside the payload is dropped with an outer copy, and only the payload's marker counts. Search still indexes the quote text. A reader that shows
copies but ignores XEP-0428 would show the quote and the copy together. Every room gets
the quoted form alone. The
copy holds a `<delay/>` with the original time and a `<message from=...>` whose
children are the plain body and, when known, an XEP-0359 `<stanza-id by=... id=.../>` naming the original's archive id (a room's, or the sender's own archive); the inner `id` attribute is the original's own id; `from` is the room occupant address for a room message and the sender's address for a one-to-one message; the inner message `type` is the source message's own (`groupchat` or `chat`), kept for a retry. The text is
the sender's claim, not verified history. A receiver reads only that plain body,
the sender, the time and those ids (the ids are never an identity of the message that
carries them, only a hint for finding the original), the body bounded to 4000 characters, with control and
bidirectional-override characters removed; nested forwards and every other
extension are ignored, and the inner message is never handled as a new arrival,
correction, receipt or room event. Fluux shows it as a source card naming the
claimed author, the room or direct chat and the day, and without a second preview of the link.
Clicking the card opens the original in context, looked up only on the click: the room message
link the forward generated (the link that ends the marked quote), then the carried ids, then
local history by sender, time (two minutes) and text, closest unique match only. A room original
opens through the room message link route, a direct one in its conversation at that row; when
nothing is found Fluux stays where it is and says the original is not in your history. In an encrypted
chat the copy travels inside the encrypted payload only; a copy added outside the
payload by anyone else is dropped. A retry keeps the copy and its original sender
address, a copy received before the key was available is recovered with the body,
and a copy may stand without an outer body, in which case the conversation list and
notifications preview the copied text. A comment-only edit keeps the existing copy,
while a failed signature check removes it. A retraction removes the copy from the
open conversation and from storage along with the body.

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
that opened the app wins over a saved account. On iOS, a link that launches the
closed app arrives with the window scene's connection options;
`SceneLaunch.swift` in the push plugin hands it to the deep link plugin the
same way as a link opened while the app runs.

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
