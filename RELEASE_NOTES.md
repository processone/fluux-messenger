## What's New in v0.17.2

### Added

- Emoji autocomplete in the composer: type ":" followed by a keyword to complete emoji inline, with arrow-key navigation and Enter or Tab to insert
- The send button responds with a press and glow-pulse animation when a message goes out
- Web (PWA): an unread badge on the app icon, service-worker media caching for fewer re-downloads, and repeated messages from one sender coalesced into a single "N new messages" notification

### Changed

- The new-messages divider and the unread badge on the scroll-to-bottom button now follow your read position, staying consistent with the sidebar and read-marker sync
- Encryption: end-to-end-encrypted attachments now decrypt when you download or save them, not only in the inline preview, so files of every type arrive readable
- Desktop: file uploads and media downloads are handled by native code, making transfers of large files much faster and more reliable
- Updated dependencies (Rust crates)

### Fixed

- Conversation history no longer shows silent gaps: interruptions while syncing the archive are detected and healed from both directions
- History sync: opening a conversation you had already read elsewhere no longer shows an empty history on a new or freshly cleared device — the archive now downloads independently of your read position
- A conversation read on another device now opens at its live edge instead of an outdated saved scroll position after multi-device sync
- Encryption: a leftover unread badge from an undecryptable reaction now clears once its placeholder is dropped
- Web (PWA): an update already downloaded but parked is now applied automatically at launch instead of trailing the deployed build indefinitely
- Clicking a reaction notification now always jumps to the reacted message
- Reopening a conversation no longer re-posts a notification for a message you have already seen
- An encrypted message with no readable content stays silent until it is decrypted, instead of posting a blank notification and playing a sound
- A delayed message (an offline replay or a catch-up copy older than what you already have) no longer drags the sidebar preview back to older text, in both 1:1 chats and group chats
- The sidebar keeps its scroll position when conversations reorder during catch-up
- Authentication: a wrong saved password no longer triggers an endless keychain retry loop
- Connecting to a server whose domain contains non-ASCII characters now works
- Encryption: the key-backup passphrase is now used exactly as displayed, so backups restore in other XMPP clients; older backups still open and are healed to the portable format on restore
- Desktop: downloading an update no longer risks freezing the app while showing progress
- Linux: fixed a performance issue when many new messages arrived at once
- Group chats: the public room directory no longer lists duplicate rooms and no longer pulls in results beyond your server's directory
- Group chats: a room notification banner no longer reappears when the room is reopened
- Group chats: removed a redundant tooltip on the room header title
- The quoted-message and reply cards stay visually distinct when a message is selected
- Your own message group re-fits its width once an image inside it finishes loading
- The typing indicator is vertically centered between the last message and the composer
- macOS: the traffic-light window buttons stay centered in the app bar
- Web: the notification permission card in Settings uses platform-neutral wording instead of "Desktop Notifications"

---
[Full Changelog](https://github.com/processone/fluux-messenger/blob/main/CHANGELOG.md)
