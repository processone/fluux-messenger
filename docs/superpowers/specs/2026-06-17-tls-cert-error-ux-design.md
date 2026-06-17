# Error UX for TLS / certificate failures — design

**Date:** 2026-06-17
**Source:** `docs/UX_REVIEW.md` §1 ("**Missing:** error UX for TLS/cert failures …")
**Status:** Approved design, pending implementation plan

## Problem

When a desktop connection fails during the upstream TLS handshake (untrusted,
expired, or wrong-host certificate; or the TLS layer otherwise rejects the
server), the user sees a generic red error box with an unhelpful string. The
Rust proxy already classifies the failure (`certificate_error` / `timeout` /
`connection_refused` / `other`) but **only writes it to the log** — the detail
is dropped before it reaches the UI.

Today's path:

1. [`upgrade_to_tls`](../../apps/fluux/src-tauri/src/xmpp_proxy/mod.rs) classifies the
   handshake error, logs it, returns a free-text string.
2. [`format_bridge_close_reason`](../../apps/fluux/src-tauri/src/xmpp_proxy/mod.rs) has no
   XMPP `stream-error` condition for a TLS failure, so the WebSocket close
   reason collapses to the generic `"Bridge closed: UpstreamConnectFailed"`.
   **The cert classification is lost here.**
3. The SDK ([`Connection.ts` `initialFailure` path](../../packages/fluux-sdk/src/core/modules/Connection.ts))
   runs `humanizeStreamError`, finds no condition, and falls through to a
   generic `"Connection failed: …"`.
4. [`LoginScreen.tsx`](../../apps/fluux/src/components/LoginScreen.tsx) renders that raw
   string in a plain red box. The only error *classifier* that exists is the
   local `isAuthError`.

## Goal

Give the user a clear, actionable explanation when a TLS/certificate failure
occurs, distinct from auth failures and generic network errors. No security
bypass — explanation and guidance only.

## Non-goals (YAGNI)

- **No in-UI "connect anyway / trust this cert" affordance.** Bypassing cert
  validation from the UI is a real security risk; the existing
  `--dangerous-insecure-tls` CLI flag already covers dev/self-signed servers and
  is intentionally not surfaced in the UI.
- **No web-side cert probing.** On web there is no Rust proxy; the browser
  connects the WebSocket directly and deliberately hides cert detail behind an
  opaque 1006 close. Web keeps the generic fallback. The design degrades
  gracefully — cert-specific UX is desktop-only.
- **No broad refactor of `isAuthError` call sites** beyond optionally routing
  classification through the new shared classifier.

## Architecture

Extend the existing **close-reason → humanize → render** pipeline already used
for XMPP `stream-error` conditions. That pattern is the natural seam; we add a
parallel "transport-error" track alongside the stream-error track.

### 1. Rust proxy — relay the classification it already computes

`apps/fluux/src-tauri/src/xmpp_proxy/mod.rs`

- **Embed a stable marker in the TLS error string.** Change `upgrade_to_tls`
  (and the STARTTLS-path TLS upgrade) to return `"… tls-error: <class>: <detail>"`,
  exactly mirroring how `perform_starttls` embeds `stream-error: <cond>`. The
  marker survives the `connect_first_endpoint` aggregation (which joins
  per-endpoint error strings).
- **Sub-classify cert failures** from the rustls error text (already present in
  the error), with graceful fallback:
  - `certificate-expired` — rustls `Expired` / "expired"
  - `certificate-name-mismatch` — `NotValidForName` / hostname mismatch
  - `certificate-untrusted` — `UnknownIssuer` / self-signed / unknown CA
  - `certificate` — any other cert failure
  - `timeout` — connect timed out
  - `refused` — connection refused / reset
- **Add `transport_error_class_from_error(&str) -> Option<String>`** (sibling to
  the existing `stream_error_condition_from_error`) that extracts the
  `tls-error: <class>` marker.
- **Encode it in the close reason.** Extend `format_bridge_close_reason` so that
  when there is no stream-error condition but there is a transport class, it
  emits `"Bridge closed: tls-error <class>"`. Generic failures with neither
  still collapse to `"Bridge closed: UpstreamConnectFailed"`.

### 2. SDK — humanize + expose a classifier (pure module)

`packages/fluux-sdk/src/core/modules/transportErrors.ts` (new, sibling to
`streamErrors.ts`)

- `extractTransportErrorClass(text: string): string | null` — recognizes the
  `tls-error <class>` / `tls-error: <class>` encoding (regex, mirroring
  `extractStreamErrorCondition`).
- `humanizeTransportError(text: string): string | null` — maps the class to a
  clear English message; returns `null` when no transport class is present so
  callers keep their existing message.
- `classifyConnectionError(error: string): ConnectionErrorKind` — the single
  source of truth for parsing, exported from the SDK index. Kinds:
  `'tls-certificate' | 'tls-other' | 'connection-refused' | 'timeout' | 'auth' | 'unknown'`.
  (Cert sub-classes collapse to `tls-certificate` for the kind; the specific
  sub-class is still available via `extractTransportErrorClass` for tailored
  copy.)

`packages/fluux-sdk/src/core/modules/Connection.ts`

- In the `initialFailure` branch, insert `humanizeTransportError` into the
  message-selection chain: `humanizeStreamError` → `humanizeTransportError` →
  existing proxy/transport fallbacks. The SDK error string stays English (it is
  the fallback shown on web and written to logs/console).

`packages/fluux-sdk/src/index.ts`

- Export `classifyConnectionError`, the `ConnectionErrorKind` type, and
  `extractTransportErrorClass`.

### 3. App / LoginScreen — dedicated, localized UX

`apps/fluux/src/components/LoginScreen.tsx`

- Replace the plain red box with a small structured error panel **when the kind
  is recognized**: alert icon + title + explanation + a short guidance list.
  - `tls-certificate`: title *"Couldn't verify the server's security
    certificate"*; cause-specific body driven by the cert sub-class
    (expired / wrong host / untrusted issuer); guidance: check the server
    address, the certificate may be self-signed or expired, contact the server
    administrator. **No bypass button.**
  - `timeout` / `connection-refused`: friendlier "Couldn't reach the server"
    copy with a retry hint.
  - `auth`: existing behavior (keychain clear + auth message).
  - `unknown`: render the raw SDK string (today's behavior — no regression).
- The server-address field already auto-reveals on non-auth errors
  (`LoginScreen.tsx` effect); that stays and is correct for cert/host
  mismatches. `classifyConnectionError(...) !== 'auth'` is the auto-reveal
  condition (replacing the local `!isAuthError(error)` check, keeping behavior
  identical for auth).
- Consider extracting the error panel into a small focused component
  (e.g. `LoginErrorPanel`) so `LoginScreen` stays readable; it has one clear
  job: given a `ConnectionErrorKind` + raw string, render the right copy.

`apps/fluux/src/i18n/locales/*.json`

- New copy under `login.errors.*` (title + body + guidance per kind/sub-class).
- Translate into all 33 locales. **No em-dash (`—` / `–`) clause connectors** —
  use `. ` + capital, `, so`, or `: ` instead.

## Module boundaries

- `transportErrors.ts` is pure (no I/O, no React, no store) — testable in
  isolation, same shape as `streamErrors.ts`.
- The Rust marker format (`tls-error: <class>`) is the contract between the
  proxy and the SDK; documented in both modules' doc comments.
- The app depends only on the SDK's `classifyConnectionError` /
  `extractTransportErrorClass` exports — it never parses raw proxy strings
  itself.

## Testing

- **Rust** (`xmpp_proxy/mod.rs` tests): `transport_error_class_from_error`
  parsing (each class + none); `format_bridge_close_reason` with a transport
  class present and absent; `upgrade_to_tls` error string includes the marker
  (unit-level on the classification helper, since a live TLS handshake is not
  unit-testable).
- **SDK** (`transportErrors.test.ts`): extraction + humanization for each class;
  `classifyConnectionError` for tls/timeout/refused/auth/unknown inputs,
  including a real aggregated multi-endpoint string.
- **App** (`LoginScreen` test): cert-class error renders the dedicated panel
  with the cert title; an unknown error renders the raw fallback string;
  auto-reveal still fires for a non-auth error and not for auth.

## Worktree note

Per project memory: this is a worktree. After editing SDK source, run
`build:sdk` and sync the built `dist` to the main repo's
`packages/fluux-sdk/dist` (and symlink `node_modules/@fluux/sdk`) before the app
typecheck/tests will see the new SDK exports. Run the root `npm run typecheck`
(tsc), not just `build:sdk` (tsup dts), to catch binding/type errors.
