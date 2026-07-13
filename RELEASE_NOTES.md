## What's New in v0.17.1

### Added

- New "Pure" theme optimized for OLED and e-ink displays: flat, high-contrast chrome in pure-black and pure-white variants
- A "Play notification sounds" toggle in Accessibility settings, so incoming-message sounds can be turned on or off
- Group chats: slash commands in the composer, including /nick to change your nickname (reflected in the occupant list and timeline)
- Group chats: joined rooms now show a typing indicator in the sidebar, but only when a caught-up room lights up — busy or unread rooms keep their badge instead
- Copy a link from any message using right click menu
- Group chats: view a room's full topic from the Room Info modal

### Changed

- Group chats: redesigned catch-up and read-state handling so a room no longer discards your read position on launch, adopting the standard last-read anchor used by other modern chat apps
- Encryption status now uses a shield, while a lock is reserved for content that cannot be read — the two metaphors are applied consistently across the chat header, message indicators, composer reminder bar, and security panel
- Consecutive messages you send hug their content and form clean rectangular groups
- Aurora refinements: gradients harmonize with your accent color per theme, a subtler typing-indicator shimmer, a room-header hairline, a light-mode send button, and refreshed login and app-icon artwork
- The command palette surfaces rooms where you were mentioned or whispered at the top, in the "Needs attention" group
- Updated dependencies (sequoia-openpgp and other Rust crates)

### Fixed

- Read markers now sync with other XMPP clients
- A native notification is dismissed when its conversation is read on another device, and read markers synced while a room was inactive are now applied
- Read-marker sync advances correctly when you reach the live edge of a conversation
- Authentication: the saved keychain password is kept after a transient "not authorized" error, so you are no longer logged out on the next restart
- Jumping to a reacted, replied-to, or poll message now works even when the target is outside the loaded window
- Search: the message preview stays centered on the matched message instead of drifting
- Room avatars render as rounded squares instead of circles consistently across the app, including in search and lists
- Scroll no longer repaints or jumps while a group chat catches up its archive, and returning to a room at the bottom no longer causes a one-time content jump
- The jump-to-last-read pill works again after jumping to the present, and the own-message hover toolbar keeps a stable position
- Reduced the oversized gap below the last message and tightened the conversation-header spacing on mobile
- Group chats: an avatar is shown again for a message following a /me action from the same sender; occupant badges stay inline in the members panel; and Quick Chat rooms detect the allow-invites configuration correctly
- Group chats: hardened nicknames against whitespace and invisible-character impersonation
- Group chats: your profile username is now used as the default nickname everywhere you join a room from
- Encrypted conversation previews in the sidebar now heal once their decryption key becomes available
- The room identity modal is centered and no longer pulls focus to its close button on open
- Composer: the encryption lock color matches the rest of the app, the reply accent bar is inset to clear the card corner, and the send icon reverts after a slash command runs
- Typing an @domain.tld address no longer turns into a fake mention
- Link previews: interop-correct OGP fastening with a non-blocking metadata fetch
- macOS: the window title is set so system media controls show "Fluux Messenger"
- Platform-specific settings panels no longer appear on the wrong platform
- Admin: ban and delete are never offered on the signed-in admin's own account
- The message-row hover highlight is more visible, in-body blockquotes hug their longest line, and the sidebar rail activity dot stays inside its button
- Command palette: no border flash on theme toggle, and the Ctrl+K separator shows correctly on non-macOS

---
[Full Changelog](https://github.com/processone/fluux-messenger/blob/main/CHANGELOG.md)
