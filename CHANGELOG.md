# Changelog

All notable changes to Fluux Messenger are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.17.0] - 2026-07-01

### Added

- Aurora: a redesigned visual identity is now the default look, with refreshed app icon and logo, display headings, per-person sender colors, softer avatar shapes, frosted-glass modals, and a curated set of accent presets (the previous look is still available as the "Indigo classic" theme)
- Conversation-first navigation: the standalone Events view is gone. Contact and subscription requests, room invitations, and message requests now appear as headed sections inside the relevant lists; Contacts moves to the bottom navigation cluster with a pending-request badge; a message request from someone not in your roster opens as a read-only thread preview with an Accept / Ignore / Block banner; and archived conversations are reached from a toggle in the Messages header
- Redesigned contact detail view: a person-forward hero over a card grid (About, Devices, Groups, Security) that surfaces organisation and role, per-device presence, and roster groups, with fingerprint verification moved into a focused Security detail (a side panel on desktop, full-screen on mobile)
- Command palette (Cmd/Ctrl-K) to jump between conversations and actions, with avatars and density-aware rows, an Unread section that surfaces unread chats and mentioned rooms first, and unread-count badges. The conversation you are already in is no longer proposed
- Web and desktop: a calm, user-triggered "Update available" button in the icon rail replaces the automatic reload when a new version is ready
- Message-list virtualization is now on by default for better performance in handling long conversations
- Read markers now sync across your devices, so a conversation you have already read elsewhere opens at the right position (XEP-0490)
- Desktop: a window app bar with back/forward navigation and affordance
- Reduce-motion setting to minimize animations, which also follows your system preference
- Admin: a friendly server overview dashboard, a usable user list (search, online status, last login), and a mobile admin launchpad
- Floating date header that shows the current day while you scroll through a conversation
- Advanced mode: an in-app toggle that reveals advanced settings and the XMPP console
- Web: opt-in 24-hour passphrase cache so OpenPGP unlock is not required on every page reload
- Login: prefill account details from xmpp: links (desktop) and URL parameters (web)
- Bulk message copy (Cmd/Ctrl-A and shift-click) that works with virtualized message lists

### Changed

- Settings are grouped and reordered for easier navigation, with a new Accessibility pane
- Scrollbars are thinner and subtler, with an always-visible thumb
- Consistent focus rings, elevated popover and menu surfaces, and empty-state screens across the app
- The encryption affordance color is unified across the chat header, message locks, and composer
- Reworked reply and quote presentation: recessed quotes and a compact, avatar-less reply chip
- Consecutive messages you send are merged into a single tinted surface
- A command-palette trigger in the app bar has been added as a compact icon button, visually distinct from the sidebar message search
- Sidebar header actions are unified across tabs, and the navigation-tab notification badges are calmer
- A 1:1 contact name in the chat header is no longer clickable: open the profile from the header overflow menu
- Rooms header: Quick Chat is now a dedicated bolt button, and room creation options fold into a single overflow menu alongside Catch up all

### Fixed

- Scroll: new messages reliably stick to the bottom under virtualization on WebKit, and returning to a conversation restores where you were reading — including deep in history — instead of drifting in time
- Own outgoing encrypted messages now show their real trust instead of a grey lock
- Group chats: reactions left by ignored users are now hidden
- Group chats: whisper corrections, reactions, retractions, and typing stay private (XEP-0045 §7.5)
- Group chats: rooms fetch their archive on first open after a resumed session (autojoin and bookmarked rooms)
- OpenPGP: expired web passphrase cache is purged at startup, malformed ciphertext is no longer retried forever, and deferred decryption runs after catch-up
- Avatars: animated GIF, APNG, and WebP avatars are frozen so they no longer distract, and the cached MIME type is sniffed from the image bytes
- Typing no longer causes the message list to reflow on every keystroke
- macOS: traffic-light buttons are vertically centered in the window app bar, and the app no longer aborts at startup when it is not launched from an app bundle
- Windows: keyboard focus is restored to the webview after alt-tab
- Contrast and readability improvements across all built-in themes (WCAG AA)
- Empty messages that strip down to a blank body are dropped instead of shown as empty bubbles
- Web: encrypted attachments that failed to decrypt because of a Cache API scheme guard now work
- Login screen centers safely on short viewports
- Keyboard focus is trapped inside modals, the command palette, and overlays instead of leaking to the interface underneath
- Screen navigation now follows a standard browser back stack
- Group chats: after a resumed session, rooms not yet caught up to live are re-synced and autojoined room previews are seeded
- Alt+3 now opens Search following the contacts relocation
- Admin: the main area uses the chat background, and the sidebar scrollbar color matches the main list across themes
- Message list stays pinned to the bottom when the occupant sidebar is toggled, not just on window resize
- Jumping to a message (search results, replies, unread marker, reactions, polls) lands it a third of the way down the viewport instead of flush against the floating date header
- Sidebar: room invitation Join/Refuse buttons no longer overflow the card on narrow widths
- Own-sent encrypted messages no longer show the "[OpenPGP-encrypted message]" placeholder as the sidebar preview
- Clicking a reaction toast now opens the correct room or conversation
- Blockquotes no longer double up their quote cue with an extra serif mark

## [0.16.2] - 2026-06-22

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
- OpenPGP: automatically recover when the stored key passphrase no longer decrypts the on-disk secret key, instead of failing encryption with an opaque error after connecting
- OpenPGP: no longer show a false "local trust data may have been tampered with" warning after a benign key recovery, since the certificate and verified peers are unchanged
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

## [0.16.1] - 2026-06-15

### Added

- macOS: clicking a notification now opens the exact conversation it belongs to (native notification routing)
- Desktop: relaunching the app focuses the already-running window instead of opening a second instance
- Linux: quit when the window is closed if the system tray is unavailable, so the app can always be reopened
- Login screen validates JID format locally before attempting to connect
- Enhanced freeze-triage diagnostic probes in fluux.log for troubleshooting

### Changed

- Group chats: skip member-list discovery for rooms that forbid affiliation lists, reducing traffic and avoiding errors
- Group chats: occupant avatar updates coalesced on room join to reduce re-renders
- Empty state screens use consistent icons from the icon rail

### Fixed

- Group chat history: closed catch-up gaps that could silently drop a stretch of messages after long offline periods, with a "load missing messages" marker to recover them (also applied to 1:1 history)
- Connections: race IPv4 and IPv6 addresses (Happy Eyeballs) so a broken IPv6 route no longer stalls connecting
- OpenPGP: publish your public-key fingerprint in upper-case as required by XEP-0373, improving cross-client key discovery
- Presence pills shown in grey while reconnecting instead of disappearing
- Encrypted reactions no longer surface as a blank conversation preview
- Show a "decrypting…" placeholder while the encryption plugin is still loading instead of a blank message
- Opening a contact profile no longer bounces back to the conversation
- Link-preview images retried once before being hidden
- Stream Management: keep sm in stream features unless it was negotiated inline, fixing some reconnection cases
- Desktop: downloading an image now uses the native save dialog
- About dialog width reduced
- Reconnection details (spinner, retry countdown, cancel) moved back to the sidebar status area — the top connection banner made the UI jump on unstable connections
- OpenPGP: fingerprint case normalized in peer-verification trust checks (green lock now reliable across clients)
- MUC occupant avatar preserved across presence updates
- Desktop: system proxy bypassed for loopback XMPP bridge hop to prevent connection failures
- Whisper: allow continuing a whispered conversation from its conversation frame
- Whisper menu action uses correct verb form across all locales
- Reply-quote bubble uses the same sender color as the original message
- Message list: fixed undefined React key on certain message rows
- Reply-quote previews render as nested vertical bars instead of raw quote markers
- Composer resize scroll correction coalesced into animation frame for smoother behavior
- Content ResizeObserver correctly created on same-commit mounts
- Image attachment placeholder reserved in error state to prevent layout shift
- MAM: bodiless encrypted messages from archive surfaced instead of dropped
- MAM: backward-pagination cursor corrected for scroll-up history loading

## [0.16.0] - 2026-06-10

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

## [0.15.2] - 2026-04-21

### Added

- Right-to-left (RTL) layout support for RTL languages
- Arabic and Hebrew translations (beta quality, please report any error or issue to help improve them)
- Decorative quotation marks for blockquotes

### Changed

- SASL2 user-agent identifier and server-side FAST token invalidation on logout
- Faster reconnection: skip redundant MAM queries on stream-management resume
- Perf: Per-conversation typing and draft subscriptions for smoother list rendering during background sync
- Security updates for several dependencies (brace-expansion, rustls-webpki, tar, rand, serialize-javascript; trust-dns-resolver migrated to hickory-resolver)

### Fixed

- Preserve MUC room state across stream-management resume and interrupted fresh sessions
- Prevent reconnection loops and UI freezes after system sleep/wake
- Keep FAST token rotation working across page-reload reconnect
- Retry FAST token authentication when the server field was initially empty
- Suppress spurious FAST token deletion log message on first login
- Set websocket stream "from" attribute so SASL2 is accepted on compliant servers
- Hydrate outbound stream-management state on resume to avoid ackQueue crash
- Recover Tauri reconnect stalls via native keepalive with proxy fallback
- fetchBookmarks no longer wipes stored room messages on reconnect
- Write live room messages directly to IndexedDB to prevent loss on reconnect
- Restore saved rooms through the connect call so history loads after SM resume
- Skip unnecessary webview reload when the app was hidden but the machine stayed awake
- Lightbox displays the full-resolution original without upscaling past its natural size
- Run discovery calls before the serial session-setup chain
- Recover when post-wake auto-connect stalls after SASL
- Handle superseded connection attempts with a dedicated error class
- Grow reconnect attempt counter past the backoff ceiling
- Probe runtime before reloading on dynamic import failure; auto-reload otherwise
- Fall back to direct URL when the web image cache fetch fails
- Display upload errors in the UI and allow HTTP upload URLs
- Use inert instead of aria-hidden on the scroll-to-bottom FAB (accessibility)
- Use ServiceWorker.showNotification() on web for reliable notifications
- Fix vertical alignment of the message toolbar "more" menu button

## [0.15.1] - 2026-04-06

### Changed

- Skip PEP avatar requests for domains that block PubSub access (reduces unnecessary traffic)

### Fixed

- Blank screen during initial connection sync caused by render loop
- False reconnections triggered by macOS timer throttling after sleep
- MUC MAM catch-up gaps after long offline periods
- Added a temporary button in the rooms sidebar, under the + menu to force catch up all joined rooms.

## [0.15.0] - 2026-03-26

### Added

- Reaction-based polls for MUC rooms with deadlines, custom emojis, close/reopen, unanswered banner, and result visualization
- Full-text message search across all conversations and rooms with local IndexedDB inverted index, prefix matching, and highlighted snippets
- Font size adjustment buttons in Appearance settings
- Theme system with 3-tier CSS design tokens (Foundation, Semantic, Component), theme picker, CSS snippets, and 12 built-in themes (Fluux, Dracula, Nord, Gruvbox, Catppuccin Mocha, Solarized, One Dark, Tokyo Night, Monokai, Rosé Pine, Kanagawa, GitHub)
- Theme import and CSS snippets
- Add reaction and vote summary to the activity log
- XEP-0388: SASL2 and XEP-0484: FAST token authentication for faster reconnection
- XEP-0012: Last Activity — display how long ago offline contacts were last seen
- Full emoji picker (emoji-mart) with dynamic viewport positioning
- Media cache: downloaded images cached to filesystem to avoid re-downloading, with storage management screen
- Per-tab XMPP resources and BroadcastChannel tab coordination for multi-tab support
- Proto-XEP drafts for appearance sync, conversation sync, ignored users, and `@all` mentions
- Unread message badge on scroll-to-bottom button with two-step scroll: first click jumps to new message marker, second click to bottom
- IRC-style mention detection with fallback highlighting in MUC rooms
- Highlight effect when navigating to a specific message from activity log
- Activity log events are clickable and navigate to the relevant conversation and message
- Scoped reaction muting in activity log (per-conversation instead of global)
- Ability to disable push notifications from settings
- Syntax highlighting for code blocks with theme integration
- Expandable code block modal with fullscreen mobile support
- MAM server archive search to supplement local IndexedDB results
- Find-on-page search within conversations (Cmd+F)
- Search rebuild progress UI and empty state improvements
- XEP-0359: Origin-id support for outgoing stanzas
- Global accent color picker with theme-specific presets
- Own nick and avatar use accent color instead of hardcoded green
- Message send slide-up animation
- Particle burst animation on reaction add
- Sidebar view fade-in transition on view switch
- VCard info popover on occupant and member list nicks
- Lazy-loaded syntax highlighting grammars per language
- Web persistent media cache with improved unavailable media UI
- Inline context preview for reaction and vote events in activity log
- Interactive demo mode with guided tutorial, room browsing, mock IQ responses, and admin panel
- Show ignored users section in MUC occupant panel
- Render markdown headings as rich messages

### Changed

- Room sorting by latest message with muted room flag
- Inline reactions limited to 9 with overflow indicator, sorted by count
- Inline hat badges limited to 3 with overflow tooltip
- Reaction tooltips limited to 9 names in large rooms
- Plural-aware "months ago" and "years ago" duration formatting across all locales
- External links now open in system default browser instead of Tauri webview
- Upgraded to React 19 with React Compiler for automatic memoization
- Upgraded to Vite 8 with lazy-loaded infrequent views
- Color `@mentions` with per-user consistent colors / XEP-0392
- Hide reactions UI in chat rooms when disco#info fails

### Fixed

- SM session resumption now properly attempts <resume/> on reconnect
- Draft text no longer leaks to active room on conversation switch
- Message retraction and moderation in MUC rooms
- Avatar falls back to letter display when image fails to load
- Hide typing indicator for ignored users in MUC rooms
- Prevent continuous video flickering on Linux/KDE by stabilizing dimensions
- XMPP Console blanking prevented with restored memoization and virtualization
- Resolve display name via occupant-id when message nick mismatches
- Blank screen on re-login after data clear prevented by resetting URL hash
- Message correction uses replace target ID when original is missing
- Reconnect backoff reset on wake from sleep
- Cached MUC occupant avatars restored across sessions
- More-options dropdown no longer overlaps bottom of chat on last message
- New message marker shown for conversations not yet opened in session
- Header misalignment and sidebar item spacing consistency
- Tauri control characters filtered from text input fields
- Delayed messages skipped when computing MAM catch-up cursor
- Admin user list refreshed after closing completed command
- New messages marker cleared when user scrolls past it
- Wire destroy room button to SDK MUC implementation
- Exclude ignored users from MUC room sidebar preview 

## [0.14.0] - 2026-03-16

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
- Display message delivery errors, and offer the options to retry sending the message
- Add modal to join a room using its JID

### Changed

- Improved mobile rendering layout
- Context menus close on scroll for better UX
- Reply arrow moved to avatar column in reply context for better visual alignment
- Dropdown menus aligned to the left on small screens
- Extracted reusable ModalShell, ConfirmDialog, and useNotificationPermission components
- Switched to HashRouter and relative asset paths for sub-path deployable static builds

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

## [0.13.3] - 2026-03-04

### Added

- MUC room member affiliation discovery for avatars, panel, and mentions
- MUC message history authors included in mention autocomplete
- Session persistence scoped by JID for multi-account isolation
- XMPP Console log batching with increased entry limit

### Changed

- Windows installer defaults to passive install mode
- Keyboard shortcut listener dependencies stabilized
- Stanza-id references enforced in MUCs when available

### Fixed

- SM resumption now detects cache clear and triggers full sync
- Roster subscription refusal no longer creates ghost entries
- Message reactions normalized for consistent reactor identifiers
- Viewport pending reports flushed on conversation switch to avoid stale states
- Reply behavior uses client-generated IDs for chat messages (XEP-0461)
- Unicode normalization improved for MUC nickname mention matching
- Media URLs with special characters in path handled correctly
- Linux keyring uses Secret Service backend for persistent credential storage
- Linux WebKitGTK dmabuf renderer disabled to prevent Wayland crash
- iOS safe area insets for camera cutout and home indicator (PWA)
- Deep link async URI processing errors handled explicitly
- Service worker install and audio notification guards hardened
- Clear-storage event listener made unmount-safe
- Flatpak runtime updated to GNOME 49

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

