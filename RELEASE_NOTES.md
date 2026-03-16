## What's New in v0.14.0-beta.1

### Added

- XEP-0425: Message Moderation — moderators can retract other users' messages in MUC rooms, with moderator attribution and reason display
- MUC room creation, configuration, and destruction support
- MUC room user management: affiliation/role changes, kick, and ban
- MUC hat management UI for room owners (XEP-0317): define, assign, and remove hats via ad-hoc commands
- Per-room ignored user management with server-side storage (XEP-0223)
- RSM pagination support for MUC room browsing
- Contact management dropdown in the occupant room sidebar
- Contact addition button in profile screen
- Occupant context menu on right-click/long-press of nicknames in room messages
- Suppress sound and desktop notifications when presence is Do Not Disturb
- Open external links in Tauri webview popup instead of system browser
- XEP-0054: vCard info display in contact popover (full name, organisation, email, country)
- XEP-0054: vCard editing in profile settings — add, edit, and remove vCard fields (full name, company, email, country)
- XEP-0054: vCard info display in contact profile view
- Avatar lightbox overlay on click in message view
- Full-screen occupant panel on small screens
- Font size setting in appearance preferences
- PEP-based conversation list synchronisation (ConversationSync module)
- XEP-0202: Entity Time — display contact local time in chat header and contact popover

### Changed

- Improved mobile rendering layout
- Context menus close on scroll for better UX
- Reply arrow moved to avatar column in reply context for better visual alignment
- Dropdown menus aligned to the left on small screens
- Extracted reusable ModalShell, ConfirmDialog, and useNotificationPermission components

### Fixed

- Active room not moving to top of sidebar on new messages
- New message marker lagging behind when switching conversations
- Blank window in MUC rooms caused by stale ResizeObserver ref
- Reactions UI disabled in rooms without stable occupant identity
- Lazy loading pagination in room discovery
- Ignored user filtering improved by cross-matching JIDs and occupant IDs
- Notifications suppressed for replies quoting ignored users in MUC rooms
- Native window theme syncing for 'system' mode in Tauri
- Contacts sidebar button alignment
- Navigation stack management to help on mobile
- Chevron rotation logic in RoomHeader
- Modals closing when click-dragging from inside to outside
- Notification lastSeenMessageId not advancing on outgoing messages
- Devices section rendering in UserInfoPopover
- Fallback to occupant JID username when contact JID is unavailable
- Owner showing as moderator in chat view

---
[Full Changelog](https://github.com/processone/fluux-messenger/blob/main/CHANGELOG.md)
