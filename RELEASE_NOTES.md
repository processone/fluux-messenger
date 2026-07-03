## What's New in v0.17.0

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
- Sliding-window message history: scroll back through unlimited conversation history instead of a fixed 5,000-message cap, loaded incrementally from the local cache and MAM
- Composer adapts to narrow widths: the text field takes the full row, with secondary controls (attach, encryption, emoji) tucked into a drawer that expands while typing
- Desktop: the native right-click menu (Reload, Inspect Element, …) is suppressed outside text fields on packaged builds
- Archived and unarchived conversations now sync live across your devices instead of only on the next reconnect

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
- Unread badges across the icon rail and room list follow a two-tier model: red for what needs attention (DMs, mentions, contact requests), grey for ambient room activity
- Admin: the raw ad-hoc command list is replaced by purpose-built screens; the user detail view adds a Ban account action and adopts the shared settings layout; the offline presence dot is dropped from user lists; user/room lists and detail panels are capped to a readable width
- Login screen footer condensed to a single credit line

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
- Group chats and DMs: the synced read position (XEP-0490) now lands correctly on the very first open of a conversation, not only after reopening it
- Search "go to message" highlight flash restored in virtualized conversations
- Icon-rail unread badges render as full filled circles and stay visible when their tab is selected
- Contact detail and admin overview cards: borders are visible again in dark mode
- DjVu attachments render as a document instead of a broken image, including previously received messages
- Composer no longer shows a spurious scrollbar on mobile Blink browsers
- Web (PWA): clicking a notification on Android now opens the right conversation instead of a blank page
- macOS: reading a conversation dismisses only its own notification instead of clearing all of them
- Admin: room counts refresh after deleting a room, and the Ban account form pre-fills user/host from the selected account
- Rooms are ordered by their last message immediately at launch instead of jumping into place only after being opened

---
[Full Changelog](https://github.com/processone/fluux-messenger/blob/main/CHANGELOG.md)
