## What's New in v0.16.2

### Added

- Touch-friendly mobile and tablet UI: long-press a message to open an action sheet, larger tap targets throughout the app, pinch-to-zoom, and the tablet occupant list as a slide-over drawer
- Login screen now explains TLS and certificate connection failures (expired, untrusted, or wrong-host certificates; timeouts; refused connections) with cause-specific guidance instead of a generic error
- Auto-download media setting (Always / Private only / Never) under a new Privacy category — media in public channels and from strangers is no longer fetched automatically
- Overflow (kebab) menu in the 1:1 chat header with View profile and Archive/Unarchive
- Join Room dialog gains a password field for password-protected rooms
- Warning before joining a non-anonymous room that would expose your real JID, shown once per room
- MUC join and invitation errors now appear in the exportable XMPP console
- Notifications for 1:1 messages that arrived while you were offline, delivered when you reconnect

### Changed

- OpenPGP: a single "Export to file" now produces one encrypted backup carrying a Passphrase-Format hint, so importing it here, in OpenKeychain, or in other XEP-0373 clients picks the right passphrase field automatically; the separate raw private-key export was removed
- OpenPGP: exported key files now include the account JID in their filename
- Already-cached media is shown even when auto-download is deferred, so you no longer re-fetch media you have already seen
- Group chats: surface why a room join fails (password required or incorrect, nickname in use, members-only, banned, full, …) across every join entry point instead of silently spinning

### Fixed

- 1:1 message history was empty on Prosody servers — MAM support is now discovered on the account bare JID as well as the server domain (XEP-0313)
- OpenPGP: import keys exported from OpenKeychain or GnuPG — the passphrase field and public-then-private key payloads are now handled
- Message history: recover stale catch-up cursors and forward-fill gaps so stretches of messages (including your own sent messages) are no longer silently skipped after offline periods
- Link previews: the "Show image" control no longer opens the link when tapped, and now shows the link title
- Own-message sender name now meets WCAG AA contrast in both light and dark themes
- Group chats: reactions, edits, and retractions are hidden in IRC gateway rooms that cannot support them (replies still work)
- Group chats: the "delete for all" moderation action is only offered in rooms whose server supports message moderation (XEP-0425)
- Group chats: @mention pills now match the mentioned person's name color
- Bookmarks added or removed on another device now sync live instead of only after the next reconnect (XEP-0402)
- Sidebar conversation preview no longer stays stuck on an encrypted placeholder after the message is decrypted
- The targeted message or cell is now highlighted while its long-press menu is open
- Conversation context menu is kept within the viewport instead of overflowing the screen edge
- Mobile: fixed dropdown, device-card, search-field, and emoji-picker layout issues, and the desktop hover toolbar no longer appears on touch devices
- Web (PWA): the app reloads automatically when a new version is installed and re-checks on focus
- The new-message marker is no longer placed on replayed history, and the scroll-to-bottom button no longer makes a wasted stop at it

---
[Full Changelog](https://github.com/processone/fluux-messenger/blob/main/CHANGELOG.md)
