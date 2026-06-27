# Connection prefill via `xmpp:` links (desktop) and URL params (web)

**Date:** 2026-06-27
**Status:** Approved — ready for implementation plan

## Problem

A provider (or an admin handing out access, VPN-profile style) wants to spare
users from typing technical server details on the login screen. They should be
able to hand someone a link that opens Fluux with the login form prefilled —
JID and, when the domain can't auto-advertise an endpoint, the explicit
WebSocket/BOSH server URL.

We deliberately do **not** introduce a new file format or custom file
extension. We rely on standards already in place:

- **Desktop:** the `xmpp:` URI scheme (RFC 5122), already registered via the
  Tauri deep-link plugin.
- **Web:** query-string parameters on the app URL.

No password or token is ever carried, so there is no silent auto-connect: the
flow is always "prefill the form, the user types their password, the user
presses Connect."

## Scope

In scope — links may prefill:

- JID / address (`alice@example.com`)
- Explicit server / WebSocket (or BOSH) service URL (the advanced "server"
  field)
- Optional `resource`
- Optional `lang`

Out of scope: credentials/tokens, branding/white-labelling, a bespoke config
file format or extension, auto-connect.

## Design

### 1. One shared, normalized prefill shape (SDK, pure)

Both entry points funnel into a single validated object:

```ts
interface LoginPrefill {
  jid?: string       // 'alice@example.com'
  server?: string    // 'wss://host:5443/ws' — the advanced "server" field
  resource?: string
  lang?: string
}
```

A pure SDK function performs the validation that matters for security:

```ts
function normalizeLoginPrefill(
  raw: Record<string, string | undefined>
): LoginPrefill | null
```

Validation rules:

- **jid** must match `local@domain` (or a bare `domain`). Otherwise dropped.
- **server** accepts the same formats as the manual server field: a
  `ws`/`wss`/`http`/`https`/`tls`/`tcp` `scheme://host` URL, a bare dotted
  domain, or `dotted-host:port`. Dangerous schemes (`javascript:`, `file:`,
  `data:`, ...) and single-label/whitespace values are rejected and dropped.
  This is the security gate against a malicious endpoint. (Originally restricted
  to `ws`/`wss`/`http(s)`; broadened so desktop links can carry native-TCP
  servers — see [docs/URL_SCHEMES.md](../../URL_SCHEMES.md).)
- **resource** / **lang** are passed through as trimmed strings when present.
- Returns `null` when nothing usable survives → normal login, no prefill.

Keeping this pure and in the SDK gives one tested code path for both platforms.
The vocabulary is aligned with the existing `ConnectOptions`
(`packages/fluux-sdk/src/core/types/connection.ts`): `jid`, `server`,
`resource`, `lang`.

The SDK already has `parseXmppUri` (used by `useDeepLink`). The desktop entry
point extracts `{ jid (from URI path), server, resource, lang (from query
params) }` into a record and hands it to `normalizeLoginPrefill`. The web entry
point extracts the equivalent record from the query string and does the same.

### 2. Desktop — extend the `xmpp:` deep link

The scheme and plugins are already wired:
- `apps/fluux/src-tauri/tauri.conf.json` registers the `xmpp` scheme.
- single-instance + deep-link plugins forward URIs to the running instance and
  expose the cold-start launch URL.
- `apps/fluux/src/hooks/useDeepLink.ts` listens via `onOpenUrl` and parses with
  `parseXmppUri`.

Two additions:

- A **`connect` action** carries the server override, per RFC 5122's
  `;`-delimited query params (values percent-encoded):

  ```
  xmpp:alice@example.com?connect;server=wss%3A%2F%2Fhost%3A5443%2Fws;resource=desktop
  ```

  A bare `xmpp:alice@example.com` still works → prefills just the JID; the
  server is auto-resolved from the domain exactly as today.

- **Auth-state gating** in `useDeepLink`: when the user is **not** connected,
  route the URI to login prefill (call `setPrefill`) instead of in-app
  navigation. When already connected, today's behavior is unchanged (open
  chat / join room) and connection params are ignored.

Both cold-start (double-click the link with the app closed) and
running-instance (click the link while sitting on the login screen) already
funnel through `useDeepLink`, so both are covered by the same branch.

### 3. Web — query params at boot

Parsed once from `window.location.search` (the same pattern `demo.tsx` already
uses for `?tutorial=` / `?virt=`), before the hash route:

```
https://app.fluux.io/?jid=alice@example.com&server=wss://host:5443/ws
```

Same key vocabulary as the desktop `connect` params (`jid`, `server`,
`resource`, `lang`). After the record is captured and pushed to the store, the
query is stripped via `history.replaceState` (keeping the hash route intact) so
a manual reload doesn't re-fire and the params don't linger in the address bar.

### 4. Delivery to the form + the security affordance

A small **app-level** Zustand slice `loginPrefillStore`:

```ts
{ prefill: LoginPrefill | null, setPrefill(p), clearPrefill() }
```

Both entry points call `setPrefill`. `LoginScreen`
(`apps/fluux/src/components/LoginScreen.tsx`) subscribes reactively, so a click
while already on the screen updates the form.

In `LoginScreen`:

- Prefill takes **precedence over** the localStorage seed (`xmpp-last-jid`,
  `xmpp-last-server`), but only seeds the form fields for this session. Nothing
  is persisted unless the user actually connects — the existing `handleSubmit`
  save logic continues to own persistence.
- When `prefill.server` is present, the advanced server field is **revealed**
  (`showServerField = true`) and **filled**, with a calm, neutral inline note —
  e.g. *"A link set a custom server: host"* — styled gray, not alarming, per the
  project's security-iconography convention (calm by default). The user sees the
  non-default endpoint before typing their password. This is the chosen
  "show it, make it obvious" affordance.
- Prefill is cleared (`clearPrefill`) once applied so it does not bleed across a
  later logout.

### 5. Behavior summary / edge cases

- Logged out + `connect` URI or bare JID → prefill login form.
- Logged in + any `xmpp:` URI → existing navigation; connection params ignored.
- Invalid / unparseable params → `normalizeLoginPrefill` returns `null` → normal
  login, no prefill, no error surfaced.
- Server URL with a disallowed scheme → that field is dropped; a valid JID in
  the same link still prefills.
- Explicit `resource` param wins over any resource embedded in a JID path.

## Testing

**SDK (pure vitest):**
- `normalizeLoginPrefill`: valid jid + server; rejects non-`ws`/`http` server
  schemes; percent-decoded server URL round-trips from a URI-derived record;
  bare-domain jid accepted; returns `null` on empty / all-invalid input.
- `connect`-action URI parsing produces the expected record (jid from path;
  server/resource/lang from `;`-params).

**App (vitest, mocked SDK):**
- `LoginScreen` seeds fields from the prefill store and clears it after applying.
- Server present → advanced field revealed + neutral note rendered.
- Prefill beats the localStorage seed.
- `useDeepLink` routes to login prefill when logged out vs. navigates when
  connected.

## Non-goals / future

- No credential or enrollment-token transport (would change the security model).
- No branding/white-label payload.
- No `.fluux`-style profile file or OS file-association. If a richer profile is
  ever wanted, it can serialize to / from this same `LoginPrefill` shape, so the
  validated core is reusable.
