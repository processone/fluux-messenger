# Fluux Roadmap 2026

Architectural direction and feature priorities for 2026.

---

## E2EE Strategy

### Current: OpenPGP (shipped)

OpenPGP (XEP-0373/0374) via Sequoia-PGP is the current E2EE layer on desktop. Forward secrecy
is provided via scheduled encryption subkey rotation. See `docs/ENCRYPTION.md` for details.

### OMEMO (deferred)

OMEMO 2 (XEP-0384) — full Double Ratchet implementation — is on the backlog but not scheduled.
The primary value of OMEMO is interoperability with third-party XMPP clients (Conversations,
Dino, Gajim). This will be revisited based on user demand.

### MLS (future)

MLS (RFC 9420) is the preferred long-term E2EE direction, especially for group encryption.
[OpenMLS](https://github.com/openmls/openmls) and [mls-rs](https://github.com/awslabs/mls-rs)
are production-quality Apache 2.0 Rust libraries ready to integrate. The current blocker is
the absence of a stable XMPP XEP for MLS-over-XMPP (NLnet-funded effort).

Plan: contribute to the XEP standardisation effort, implement once the wire format stabilises.

---

## Architecture: Autonomous Rust Connection Layer

### Motivation

Two features share the same root requirement — the XMPP connection surviving without an active
WebView:

- **Mobile background delivery**: WebView is frozen when the app is backgrounded; the connection
  must survive without JS running.
- **Desktop detached chat windows**: Multiple WebView windows need a shared connection and
  consistent state.

### Design

The connection backend becomes an abstraction with two platform-specific implementations:

```
ConnectionBackend (interface)
  ├── TauriConnectionBackend   — Rust owns connection + message buffer;
  │                              broadcasts state to all WebViews via app.emit_all()
  └── WebConnectionBackend     — XMPPClient.ts owns connection directly (current behaviour)
```

`XMPPProvider` detects the runtime (`window.__TAURI__`) and instantiates the appropriate
backend. Zustand stores become a synchronised cache on Tauri builds rather than the source of
truth. The existing `StoreBindings` interface is the right seam for this split.

**Hard constraint**: `packages/fluux-sdk` stays pure JS/TS with no Tauri dependency. Web builds
are unaffected. The split lives entirely in `apps/fluux`.

### Features unlocked

| Feature | Mechanism |
|---|---|
| Mobile background (foreground service) | Rust runs while WebView is frozen; buffer drains on resume |
| Desktop detached chat windows | All windows subscribe to Rust state via `emit_all()` |
| System tray message preview | Rust holds state; tray reads without opening the main window |
| Faster desktop reconnect | Rust reconnects independently of the WebView lifecycle |
| Multi-account (future) | Rust manages N connections; WebViews filter by account |

---

## Mobile

### Platform: Tauri mobile

Already on Tauri 2, which supports iOS and Android. The existing Rust backend (XMPP proxy,
E2EE crypto, OS keychain) reuses directly. The web build remains unaffected.

Reference implementation: [HuLa](https://github.com/HuLaSpark/HuLa) — a Tauri 2 chat app
shipping on all five platforms. Key native pieces required:

- **iOS keyboard**: WebView frame resize + toolbar removal via `objc2` (see HuLa's
  `webview_helper/ios.rs` and `KeyboardAccessory.mm`)
- **Android keyboard**: `windowSoftInputMode="adjustResize"` + `WindowInsetsCompat`
- **Safe areas**: CSS `env(safe-area-inset-*)` on both platforms

### Background delivery: FCM-first

Architecture approach: disconnect on background, use push notifications to wake the app,
reconnect and fetch missed messages via MAM.

Stack:
- ejabberd `mod_push` (XEP-0357) — already available server-side
- Self-hosted push proxy
- FCM for Android, APNs for iOS
- [UnifiedPush](https://unifiedpush.org) for privacy-conscious / FOSS users

The foreground service approach (persistent XMPP connection while backgrounded) is the right
long-term answer for real-time delivery but requires the autonomous Rust connection layer
described above. Implement FCM delivery first; revisit foreground service once that
architecture work is done.

---

## Priority Order

### 1 — Admin panel

An ejabberd management console: user management, room administration, server metrics,
`mod_push` configuration, invitation link generation. Built on ejabberd's admin API and
ad-hoc commands. The "complete package" (ejabberd + Fluux + admin UI) is the main product
differentiator for team and enterprise deployments.

### 2 — Mobile (Tauri, FCM path)

Sequence:
1. Responsive layout — keyboard handling, safe areas, touch targets
2. FCM + APNs token registration, ejabberd `mod_push` pipeline, push proxy
3. UnifiedPush support
4. App store submissions (iOS + Android)

### 3 — Voice / video

1. 1:1 desktop calls via Jingle — bounded scope, ships independently
2. Group calls via LiveKit SFU (already decided) — larger investment, sequenced after 1:1

### 4 — MLS

Engage with the XMPP MLS XEP effort. Implement once the wire format stabilises.

---

## Already Shipped

- Message editing, reactions, emoji, GIFs
- File sharing with inline previews
- Full-text message search
- OpenPGP E2EE (desktop, XEP-0373/0374)
- Stream Management / session resumption (XEP-0198)
- Message Archive Management (XEP-0313)
- Message Carbons (XEP-0280)
- Typing indicators (XEP-0085)
- Read markers and unread badges
- Auto-away on system idle (desktop)
- Native notifications with click-to-focus (desktop)
- Render performance optimisations (granular store selectors, render loop detection)
- Demo mode (no XMPP server required)
