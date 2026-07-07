# Fluux as an MCP endpoint for Claude (history + send)

Date: 2026-07-03

## Problem

Let Claude (Claude Desktop / Claude Code) read conversation history and send messages through
Fluux, without duplicating the app's E2EE stack in a second process and without Fluux building a
redundant consent system on top of what MCP clients already provide.

## Architecture

The MCP server is embedded in the running Tauri desktop app — not a standalone bot process.

- A standalone bot (a second connection via `@fluux/sdk/core`, as used for CLI/bot use cases)
  would need its own OMEMO/OpenPGP key material to decrypt anything beyond cleartext MAM history.
  Duplicating the E2EE stack just to read history is unnecessary and worse for security.
- Instead, the Rust backend hosts a local MCP endpoint over **Streamable HTTP** on a random
  loopback port (`127.0.0.1:<port>`), active only while the app is running and unlocked.
- Conversation data lives in the webview (Zustand stores, `messageCache`), not in Rust. Rather than
  mirroring a copy into Rust (cache-invalidation risk), each MCP tool call is proxied live: Rust
  receives the JSON-RPC call → forwards it to the webview via a Tauri event → webview reads the
  SDK store/`messageCache` (or calls `sendMessage`) → replies to Rust → Rust returns the MCP
  response. One round trip per call; fine for interactive, low-frequency calls.
- If the app isn't running, the port doesn't exist and the MCP client's connection fails. That is
  the intended "no background access" behavior — there is no headless/always-on mode.

## Policy & Consent Model

No in-app per-conversation allowlist. Fluux does not pre-decide which conversations Claude can
see or send into.

- The MCP client (Claude Desktop/Code) already prompts the user per tool call — "Claude wants to
  call `get_history` for `alice@example.com` — Allow / Always Allow / Deny" — and that is
  inherently task-scoped: the user reads the request in the context of whatever they just asked
  Claude to do. Fluux relies on this rather than building its own gate.
- **Global kill switch.** A single Settings toggle enables/disables the MCP server entirely.
  Off by default. This is the one thing Fluux itself must gate — there is no other way to turn the
  feature off.
- **Tool design keeps consent prompts meaningful:**
  - `get_history` / `send_message` require an explicit `conversationId` — no bulk "dump
    everything" tool — so each consent prompt names one specific person/room, not an opaque
    blanket grant.
  - Responses flag when a conversation is E2EE (`isEncrypted`), so a user approving "read history
    with alice" can see it is an encrypted thread before clicking Allow.
  - `send_message` carries MCP's non-read-only/`destructiveHint` annotation; `list_conversations`
    and `get_history` are marked read-only. Clients that auto-approve reads but prompt harder on
    writes behave correctly by default.
- **In-app audit log, not a gate.** Because the real approval happens inside the MCP client
  (outside Fluux's view), the Settings > MCP panel keeps a local activity log — "Claude read
  history with X at 14:32", "Claude sent a message to Y at 14:35" — so the user has an
  after-the-fact record even after clicking "Always Allow" for a session.
- No hard per-conversation deny-list in v1 (YAGNI) — the kill switch plus audit log is the
  starting point; a deny-list can be added later if it turns out to be needed.

## MCP Tool Surface

Minimal, matching exactly the requested use case (history + send), nothing extra:

- **`list_conversations`** — returns `{conversationId, displayName, type: 'chat' | 'groupchat',
  isEncrypted, lastMessageTimestamp}[]`. Read-only.
- **`get_history`** — params `{conversationId, limit?, before?}`, paginated (default/max cap,
  e.g. 50/200 — no unbounded full-history dump in one call). Returns messages from the
  already-decrypted `messageCache`: `{from, body, timestamp, isOutgoing, isEncrypted}`. Read-only.
- **`send_message`** — params `{conversationId, body}`. Proxies to the webview's existing SDK
  `Chat.sendMessage()`. Non-read-only / `destructiveHint`.

No search, no contacts, no other tools in v1.

## Encryption on send

`send_message` must call the real `Chat.sendMessage()` and never a lower-level stanza-building
shortcut, so it inherits the SDK's existing E2EE invariant for free instead of re-implementing it:

- Every outbound chat-like send path (send, resend, correction, reaction reply-fallback) routes
  through a single helper, `applyE2EEToOutboundChat`
  ([Chat.ts:518](../../../packages/fluux-sdk/src/core/modules/Chat.ts)), which the code documents
  as a security-critical invariant — no code path may build cleartext children and reach the wire
  without the E2EE rewrite.
- If an E2EE plugin can reach the recipient, the message is encrypted transparently — the MCP
  layer needs no special handling.
- If encryption is expected for that peer but cannot be established, `sendMessage()` throws
  `E2EEEncryptionRequiredError` instead of silently falling back to cleartext. This surfaces as a
  normal MCP tool error (see Error Handling below) — never a silent plaintext leak.

## Transport Security

Distinct from the consent policy above — this is about who can even reach the local endpoint:

- HTTP endpoint bound strictly to `127.0.0.1`, never LAN-exposed.
- A bearer token, regenerated per app launch, surfaced only in memory via the Settings panel's
  "Copy connection details" button — never written to disk, so there's no token-bearing file for
  another local process (or a backup/sync tool) to pick up. The user copies the URL + token once
  into their MCP client config. Without the token, no other local process can call in even if it
  guesses the port.
- No extra logic needed for a locked E2EE key: if the passphrase has not been entered, the
  relevant messages simply have no plaintext body yet in `messageCache`, so `get_history` returns
  exactly what the UI would show — nothing more, nothing less.

## Error Handling & Edge Cases

- App not running → connection refused; the intended "no background access" behavior.
- Unknown `conversationId` → standard MCP error response.
- `send_message` failures (offline, blocked, `E2EEEncryptionRequiredError`, etc.) → reuse the
  SDK's existing send-error path rather than a parallel one.
- Lightweight rate limit on `send_message` (e.g. capped per minute) — sending is irreversible (a
  real message lands with a third party), so a buggy or over-eager Claude session should not be
  able to mass-send. Read tools do not need this.

## Settings & Audit UI

A dedicated Settings > MCP panel:

- Enable/disable toggle (the kill switch) and current status (server running / port / whether a
  client is connected).
- A recent-activity log of tool calls (read/send, conversation, timestamp) for after-the-fact
  auditing.

No per-conversation toggle grid — superseded by the consent-delegation model above.

## Out of scope (v1)

- Standalone bot-process variant (separate credentials/connection).
- Per-conversation static allowlist / hard deny-list.
- Search, contacts, or any tool beyond `list_conversations` / `get_history` / `send_message`.
- Headless/always-on access when the desktop app is not running.

## Testing

- Rust-side HTTP/token/routing logic and JS-side proxy handlers get unit tests with existing
  mocks.
- The full loop (an actual MCP client calling in) is not something the browser preview tooling can
  verify — it needs a real Tauri build and a real MCP client config. Manual verification only, not
  covered by the automated test suite.
- This is a multi-part build (Rust HTTP server + Tauri IPC bridge + MCP protocol + Settings/audit
  UI); the implementation plan should phase it — core tool proxy first, Settings/audit UI after.
