## What's New in v0.16.0

### Added

- OpenPGP end-to-end encryption (XEP-0373 / XEP-0374) — encrypted 1:1 messaging with passphrase-protected key storage and secret-key backup/restore
- OpenPGP end-to-end encryption support in web version
- Multi-TSK (Transferable Secret Key) handling in the XEP-0373 backup restore flow for accounts with multiple OpenPGP keys
- Mediated private messages in group chats ("whispers", XEP-0045 §7.5) — reply privately to a single occupant, shown as a distinct private thread

### Changed

- XMPP Console hides Stream Management packets by default for less noise (toggle remains available)
- Significant render-performance pass: cut store over-subscription in ConversationList, CommandPalette, RoomConfig, ContactSelector, ContactItem, and room modals
- Simplified Chinese translation updated
- Updated dependencies

### Fixed

- SASL2 inline Stream Management resumption handled correctly; duplicate <enable/> suppressed
- Proxy/auth: forward <open/> from= attribute so SASL2/FAST works through the desktop proxy, plus keychain fallback
- SDK: client-side FAST token cleared on logout to prevent silent re-authentication
- Wake and reconnect resilience: stale-timer detection, DarkWake handling, reload cooldown, and settle-time scaling
- Activity log: subscription events now navigate to the contact profile
- Sidebar user panel: prevent status label truncation
- RTL sidebar lists: truncate Latin names at the end instead of the start
- Blockquote decorative quote marks no longer clipped at the edge
- Rendering performance improvements

---
[Full Changelog](https://github.com/processone/fluux-messenger/blob/main/CHANGELOG.md)
