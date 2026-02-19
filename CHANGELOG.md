# Changelog

All notable changes to Fluux Messenger are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.13.2] - 2026-02-19

### Added

- SDK: Connection state machine for more predictable connection lifecycle
- `--dangerous-insecure-tls` CLI flag to disable TLS certificate verification
- SDK diagnostic logging for user troubleshooting, with shortcut to access log file
- Russian, Belarusian, Ukrainian, and Simplified Chinese translations (31 languages total)
- Linux system tray support with close-to-tray functionality
- Mod+Q full quit shortcut on Windows/Linux
- SCRAM authentication mechanism support with browser polyfills and UI display
- Windows drag and drop support

### Changed

- Beta release process for pre-release testing
- Separated SM resumption and fresh session initialization paths
- Optimized active conversation rendering with `useChatActive` hook
- MAM guards to skip unnecessary operations during SM resumption
- Improved connection fallback: proper WebSocket URL resolution and proxy restart
- XMPP Console performance with `useCallback`/`React.memo`
- Reduced MAM traffic on connect
- Use system DNS as default with fallback to Tokio resolver

### Fixed

- Connection error handling with firewall hint for proxy mode failures
- harden shutdown/cleanup flow and add DNS timing logs
- Proxy memory handling with buffer size limits and better stanza extraction
- Reconnection logic and login display optimizations
- Connection error message formatting
- Multiple freeze conditions on reconnect after sleep/network change or server restart
- SRV priority sorting and TLS SNI domain handling
- Room avatar loss when occupant goes offline
- Duplicate messages from IRC bridges in MAM queries
- Avatar blob URL memory leak with deduplication pool
- Status message updates while staying online
- MUC nick preserved on reconnect short-circuit
- Linux logout lockups on proxy disconnect
- Non-fatal errors now keep reconnecting with capped backoff
- WebSocket protocol header compliance (RFC 7395) preventing browser rejection on Windows
- Try all SRV record endpoints on connection failure instead of only the first
- macOS reconnect reliability during sleep and focus events
- Flatpak build updated for system tray support

## [0.13.1] - 2026-02-13

### Added

- Enhanced logging and diagnostics for connection troubleshooting
- Tracing for keychain, idle detection, link preview, and startup operations

### Changed

- Improved XMPP proxy robustness and TCP streaming error handling
- Streamlined avatar restoration logic

### Fixed

- Memory and CPU leaks on connection loss
- SRV flip and double-connect on reconnect after sleep
- Background MAM catchup after reconnection
- New message marker rewinding to earlier position
- Room sorting after connection
- Occupant avatar negative cache handling
- Stuck tooltips on rapid hover
- Room members sidebar state lost across view switches
- HTTP upload discovery on server domain
- Pointer cursor missing on interactive buttons
- Windows code signing

## [0.13.0] - 2026-02-12

### Added

- Native TCP connection support via WebSocket proxy (desktop)
- Clipboard image paste support (Cmd+V / Ctrl+V)
- Clear local data option on logout
- Complete EU language coverage (26 languages)
- Improved Linux packaging with native distro tools

### Changed

- Smarter MAM strategy for better message history loading
- Dynamic locale loading for faster initial load
- Centralized notification state with viewport observer
- Windows tray behavior improvements

### Fixed

- Attachment styling consistency across themes
- Sidebar switching with Cmd+U
- Scroll-to-bottom reliability on media load
- "Copy Image" paste support (only tested with Safari)
- New message marker position on conversation switch
- Duplicate avatar fetches for unchanged hashes
- macOS layout corruption after sleep
- Markdown bold/strikethrough stripped from message previews
- Context menu positioning within viewport bounds

## [0.12.1] - 2026-02-09

### Added

- Time format preference (12-hour, 24-hour, or auto)
- Collapsible long messages with Show more/less
- Negative avatar cache to reduce redundant vCard queries
- Azure Trusted Signing for Windows builds

### Changed

- Skip MAM preview refresh on SM resume (performance)
- File attachment card styling improvements in both themes

### Fixed

- Typing indicators for group chats (room:typing event)
- Socket error handling improved with reduced redundant logs
- Failed media URLs cached to prevent repeated retry loops
- Wide horizontal images limited to prevent thin strips
- Link preview card border softened in dark mode
- Stable IDs generated for messages without ID (prevents duplicates)
- MUC occupant avatar event listener improved
- Autoscroll and input alignment improvements

## [0.12.0] - 2026-02-06

### Added

- XEP-0398: MUC occupant avatars displayed in room participant list
- Message styling for bullet points and support for markdown bold
- Toast notifications for room invites and error feedback

### Changed

- File drag-and-drop now stages files for preview before sending
- XMPP Console keyboard interaction and feedback improvements

### Fixed

- Scroll behavior for typing indicators and reactions
- Performance: improvements
- URL parsing for angle-bracketed URLs
- Profile editing disabled when offline
- Disabled room menu items render at full width
- Missing media files handled gracefully (404 errors)
- Update check no longer auto-triggers when viewing settings

## [0.11.3] - 2026-02-03

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

## [0.11.2] - 2026-01-31

### Added

- Keyboard shortcut improvements (Cmd+K in composer, better macOS Alt shortcuts)
- Debian packaging and aarch64 Linux support
- Developer documentation (DEVELOPMENT.md)

### Changed

- Command palette selection is now more visually distinct
- Reply quote text size increased for better readability
- Thumbnail resolution increased from 256px to 512px
- Fonts embedded locally (removed Google Fonts dependency)

### Fixed

- Connection stability: fixed reconnection loops and race conditions
- MAM loading race conditions in both chats and rooms
- Wake-from-sleep detection when app stays in background (macOS)
- Scroll-to-original message with special characters in IDs
- Message view alignment when clicking notification to open conversation
- German and Polish translation diacritics
- Reaction tooltip now shows localized "you" with proper nickname

## [0.11.1] - 2026-01-28

### Added

- Background refresh of conversation previews after connect
- Windows system tray with hide-to-tray on close
- Native save dialog for console log export on desktop

### Changed

- Verifying connection status indicator when waking from sleep
- Quick Chat room history is now transient (XEP-0334 noStore hint)
- Linux Flatpak distribution (replaces AppImage)

### Fixed

- XEP-0446 File Metadata for image dimensions (prevents layout shift)
- Room avatar caching restored for bookmarked rooms
- Various cosmetic and mobile UX improvements

## [0.11.0] - 2026-01-26

### Added

- Room MAM detection: rooms supporting message archives skip MUC history (faster joins)
- Loading indicator while fetching message history
- Priority shown in contact profile connected devices

### Changed

- Message toolbar locks when emoji picker or menu is open
- Event-based SDK infrastructure to make the app more reactive

### Fixed

- Tooltips hide immediately when their trigger menu opens

## [0.0.1] - 2025-12-19

### Added

- First commit: Initial XMPP web client with React SDK

