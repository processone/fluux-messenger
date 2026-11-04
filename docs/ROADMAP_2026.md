# Fluux Roadmap 2026

Architectural direction and feature priorities for 2026.

Last reviewed: 2026-11-04 (v0.18.2).

---

## E2EE Strategy

### Current: OpenPGP (shipped)

OpenPGP (XEP-0373/0374) via Sequoia-PGP is the current E2EE layer on desktop and iOS. Forward
secrecy is provided via scheduled encryption subkey rotation. See `docs/ENCRYPTION.md` for
details.

### OMEMO (in development, not released)

The primary value of OMEMO is interoperability with third-party XMPP clients (Conversations,
Dino, Gajim, Monal). Work is on the `features/omemo` branch: a clean-room TypeScript
implementation of X3DH and the Double Ratchet, built only on permissively licensed primitives
so that no GPL or AGPL code we don't own enters the client. OMEMO 2 (`urn:xmpp:omemo:2`) comes
first, followed by the legacy `eu.siacs.conversations.axolotl` envelope, which most clients
still use. The branch has not been merged and is not scheduled for a release.

### MLS (future)

MLS (RFC 9420) is the preferred long-term E2EE direction, especially for group encryption.
[OpenMLS](https://github.com/openmls/openmls) and [mls-rs](https://github.com/awslabs/mls-rs)
are production-quality Apache 2.0 Rust libraries ready to integrate. The current blocker is
the absence of a stable XMPP XEP for MLS-over-XMPP (NLnet-funded effort).

Plan: contribute to the XEP standardisation effort, implement once the wire format stabilises.

---

## Architecture: Autonomous Rust Connection Layer

### Motivation

Two features share the same root requirement, the XMPP connection surviving without an active
WebView:

- **Mobile background delivery**: WebView is frozen when the app is backgrounded; the connection
  must survive without JS running.
- **Desktop detached chat windows**: Multiple WebView windows need a shared connection and
  consistent state.

### Design

The connection backend becomes an abstraction with two platform-specific implementations:

```
ConnectionBackend (interface)
  ├── TauriConnectionBackend   : Rust owns connection + message buffer;
  │                              broadcasts state to all WebViews via app.emit_all()
  └── WebConnectionBackend     : XMPPClient.ts owns connection directly (current behaviour)
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

### Status

- **iOS**: experimental native support shipped in 0.18.0, distributed through TestFlight
  (see [iOS development](IOS_DEVELOPMENT.md)). It includes APNs push notifications (XEP-0357
  through a push app server), system sharing, native file transfers, OpenPGP with optional
  notification previews, and Siri and Shortcuts. Native iOS requests a 24-hour stream
  resumption window so it can resume after long periods in the background.
- **Android**: experimental builds only (see [Android development](ANDROID_DEVELOPMENT.md)).
  Native push (FCM or UnifiedPush) is not implemented yet.

### Platform: Tauri mobile

Already on Tauri 2, which supports iOS and Android. The existing Rust backend (XMPP proxy,
E2EE crypto, OS keychain) reuses directly. The web build remains unaffected.

Reference implementation: [HuLa](https://github.com/HuLaSpark/HuLa), a Tauri 2 chat app
shipping on all five platforms. Key native pieces required:

- **iOS keyboard**: WebView frame resize + toolbar removal via `objc2` (see HuLa's
  `webview_helper/ios.rs` and `KeyboardAccessory.mm`)
- **Android keyboard**: see the [implemented viewport handling](ANDROID_DEVELOPMENT.md#soft-keyboard).
- **Safe areas**: CSS `env(safe-area-inset-*)` on both platforms

### Background delivery: FCM-first

Architecture approach: disconnect on background, use push notifications to wake the app,
reconnect and fetch missed messages via MAM.

Stack:
- ejabberd `mod_push` (XEP-0357), already available server-side
- Self-hosted push proxy
- FCM for Android, APNs for iOS
- [UnifiedPush](https://unifiedpush.org) for privacy-conscious / FOSS users

The foreground service approach (persistent XMPP connection while backgrounded) is the right
long-term answer for real-time delivery but requires the autonomous Rust connection layer
described above. Implement FCM delivery first; revisit foreground service once that
architecture work is done.

---

## Priority Order

### 1: Admin panel

An ejabberd management console: user management, room administration, server metrics,
`mod_push` configuration, invitation link generation. Built on ejabberd's admin API and
ad-hoc commands. The "complete package" (ejabberd + Fluux + admin UI) is the main product
differentiator for team and enterprise deployments.

Shipped in 0.17.0: server overview dashboard, user list and detail (search, online status,
last login, ban), room administration, and a mobile admin launchpad. Remaining: `mod_push`
configuration and invitation link generation.

### 2: Mobile (Tauri)

Sequence:
1. Responsive layout, keyboard handling, safe areas, touch targets (done)
2. APNs token registration, ejabberd `mod_push` pipeline, push app server (done for iOS in
   0.18.0); FCM for Android (not started)
3. UnifiedPush support (not started)
4. App store submissions: iOS through TestFlight first, then the App Store; Android on F-Droid
   and possibly Google Play

### 3: Voice / video

1. 1:1 desktop calls via Jingle, bounded scope, ships independently
2. Group calls via LiveKit SFU (already decided), larger investment, sequenced after 1:1

### 4: MLS

Engage with the XMPP MLS XEP effort. Implement once the wire format stabilises.

---

## Polish & Backlog

- **Localized emoji completion**: use locale-specific Unicode/CLDR annotations for
  emoji names and search terms in composer autocomplete, while preserving canonical
  shortcodes and English aliases for compatibility and fallback search.

- **Filter muted users from search results**: the per-room ignore (mute) list is
  applied in the room view (messages, mentions, typing indicators and reactions are
  hidden) but not in cross-room search. Messages, mentions and reactions from muted
  users still surface in `SearchContextView`. Apply the same ignore filter to search
  results so muted users stay hidden everywhere.

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
- SASL2 and FAST token authentication (XEP-0388, XEP-0484), 0.15.0
- Reaction-based polls in rooms, 0.15.0
- Local MCP server for AI assistants, desktop (see [MCP](MCP.md)), 0.17.1
- Admin panel: dashboard, user and room administration, 0.17.0
- Read markers synced across devices (XEP-0490), 0.17.0
- Command palette, Aurora visual identity, 0.17.0
- Spam removal by room moderators, 0.17.4
- Experimental native iOS app with APNs push, sharing, and Siri and Shortcuts, 0.18.0
- macOS Share menu integration, 0.18.0
