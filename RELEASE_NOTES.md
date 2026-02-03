## What's New in v0.11.3

### Added

- ARM64 builds for Linux
- Password visibility toggle on login screen

### Changed

- Reply quote border uses quoted person's XEP-0392 consistent color and user's avatar
- MUC rooms now sorted by last message time
- Copy behavior preserved for single message selection
- Show room info in tooltip instead of inline preview
- Standardized release asset names across platforms

### Fixed

- Rooms with MAM disabled no longer fallback to service-level MAM
- Scroll to new message marker when entering room with unread messages
- Emoji picker buttons no longer submit form accidentally
- Own MUC message detection improved for unread clearing
- Double reconnection race condition after wake from sleep
- Restored keychain credentials saving on login
- Android status bar color syncs with app theme
- Mobile layout improvements for e/OS/ and Android
- Image loading no longer proxied via Tauri HTTP plugin
- Date separator and cursor alignment in message list
- MAM catchup reliability improvements
- Sidebar message preview shows correct content
- OOB attachment URL stripped from message body
- Room avatar fetch no longer logs error when avatar missing
- Reply quotes show avatar for own messages
- Quick Chats section spacing in sidebar

---
[Full Changelog](https://github.com/processone/fluux-messenger/blob/main/CHANGELOG.md)
