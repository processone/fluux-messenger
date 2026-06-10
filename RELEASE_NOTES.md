## What's New in v0.16.0

### Added

- OpenPGP end-to-end encryption (XEP-0373 / XEP-0374) — encrypted 1:1 messaging with passphrase-protected key storage and secret-key backup/restore
- OpenPGP end-to-end encryption support in the web version
- Multi-TSK (Transferable Secret Key) handling in the XEP-0373 backup restore flow for accounts with multiple OpenPGP keys
- Mediated private messages in group chats ("whispers", XEP-0045 §7.5) — reply privately to a single occupant, shown as a distinct private thread
- Unread message count badge on conversation avatars
- Connection status banner shown while the app is reconnecting
- Compose messages while offline — they queue and send once you reconnect

### Changed

- XMPP Console hides Stream Management packets by default for less noise (toggle remains available)
- Major render-performance pass: cut store over-subscription across the conversation list, command palette, room config and modals, contact picker, MUC message lists, occupant panel, roster, search, and message rows — eliminating re-render storms during background sync and group-chat presence churn
- Message corrections and reactions no longer attach a duplicate plain-text fallback to outgoing messages (incoming fallbacks are still rendered)
- Simplified Chinese translation updated
- Updated dependencies

### Fixed

- Composer textarea resizes correctly when the window or panel width changes
- Group chat: message corrections (XEP-0308) are attributed via origin-id and limited to the original author
- Fixed UI freezes when search results, reply quotes, or poll results loaded after their row first rendered
- SASL2 inline Stream Management resumption handled correctly; duplicate <enable/> suppressed
- Proxy/auth: forward <open/> from= attribute so SASL2/FAST works through the desktop proxy, plus keychain fallback
- SDK: client-side FAST token cleared on logout to prevent silent re-authentication
- Wake and reconnect resilience: stale-timer detection, DarkWake handling, reload cooldown, and settle-time scaling
- Activity log: subscription events now navigate to the contact profile
- Sidebar user panel: prevent status label truncation
- RTL sidebar lists: truncate Latin names at the end instead of the start
- Blockquote decorative quote marks no longer clipped at the edge

---
[Full Changelog](https://github.com/processone/fluux-messenger/blob/main/CHANGELOG.md)
