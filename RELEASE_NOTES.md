## What's New in v0.18.0

### Added

- iOS: export a local, content-free notification diagnostic from Notifications settings using the iPhone share sheet. The log keeps up to 200 decisions for 48 hours and clears on logout
- Experimental native iOS support lets Fluux run on iPhone and iPad, with push notifications, system sharing, native file transfers and OpenPGP encryption
- iOS: notifications show contact and room avatars and the text of unencrypted messages, can optionally preview OpenPGP-encrypted messages on the device, and offer a choice of notification tones. Recent conversations appear as suggestions in the Share sheet, long presses and reactions give haptic feedback, and the app switcher shows a blurred cover in the app's theme instead of your conversations. Signing out turns off push for the device and hides that account's content from notifications, and opening the app clears notifications that do not belong to a specific conversation
- iOS: use Siri or Shortcuts to open an existing conversation or room, or check the unread count shown on the app icon without opening Fluux. Requires iOS 16 or later
- iOS: OpenPGP notification previews now start on for every account that has OpenPGP enabled with a usable key. You can turn them off for each account in Notifications settings
- Conversations can be read in a centred column: turn on "Limit conversation width" in Appearance settings and set the column width with the slider. Small windows keep using the full width
- Group chats: whispers to a room member can now carry attachments. Fluux first warns that the file is stored on the server and that the recipient keeps a copy, and shows how long the server keeps it when the server says so
- macOS: share links, documents and images to Fluux from any app through the system Share menu. Fluux opens so you can pick the conversation and send the content
- Notifications for room invitations and voice requests now join contact-request alerts on desktop and the web; contact-request alerts also work in Android Chrome
- On touch screens, you can now see who reacted to a message
- iOS: photos shared from other apps now open in Fluux ready to send
- iOS: large photos are reduced before sharing, with a choice to send the original when it fits the server limit

### Changed

- The search tab is now translated into the selected language, including the "Go to message" tooltip on results
- The new-message divider is labelled with the number of messages actually below it, instead of repeating the unread count of the scroll-to-bottom badge
- Moderation dialogs (single message and bulk) follow the app theme, with clearer selection and hover highlights and consistent buttons
- Joined room avatars now show the unread message count; mentions still have their own badge, so activity is easier to scan in the room list
- Windows: the app bar now serves as the window title bar, with window controls that remain available above dialogs and the image viewer
- Desktop packages, including Flatpak, now use the net.processone.fluux app identifier. Fluux migrates existing local data on first launch; macOS may ask once to allow access to saved keychain items
- Long conversations open more smoothly, even with large blocks of text, and busy rooms no longer stall or crash during message and presence bursts. Catching up on archived history is much faster in conversations with thousands of loaded messages
- The scroll-to-bottom button appears as soon as you scroll away from the latest messages
- Presence indicators are easier to tell apart, including with colour-vision deficiencies: Away is now an orange rounded square and Do Not Disturb a red ring
- Room member lists show absent members under "Offline members", with their count and their owner, admin or member role. Lists with more than 10 offline members start collapsed
- When a WebSocket sign-in fails, the error and connection log now explain which server address was tried and why discovery failed
- Privacy settings now show your server's message archiving setting (everything, contacts only or nothing) and let you override it. Until you do, Fluux leaves your server's default alone
- Fluux saves a password only after the server has accepted it, so a quick reconnection can no longer replace your saved password with an unverified one. Spaces around the account address are ignored at sign-in
- When you reopen Fluux, your conversations stay on screen while the app reconnects instead of briefly showing the login form

### Fixed

- Contact requests disappear when accepted on another device, without needing to accept them again on desktop
- Encrypted (OpenPGP) conversations interoperate better with other clients: using Fluux and Gajim on the same account no longer stops Gajim from encrypting to Fluux, and edits, replies, receipts and read markers sent by Gajim inside an encrypted message now show up correctly instead of as new messages or not at all
- Search: "Go to message" now lands on, and highlights, results buried far back in a conversation's history, in rooms and in direct chats
- Cmd-K finds the conversation you already have open when you search for its contact name or JID, instead of only showing another conversation whose latest message matches
- Unread badges are reliable after reconnecting: conversations and rooms no longer keep a stale or empty badge once their missed messages have been fetched, a room read up to its latest message clears its badge, and a read position from another device that Fluux cannot place no longer blocks unread counts. Messages from ignored room members do not add to unread or mention badges
- A sign-in on a fresh install, a cleared browser or a new machine no longer shows contacts as bare names with missing recent messages, or an empty conversation list
- The last message stays visible above the typing indicator and composer, keyboard scrolling no longer snaps back after a cancelled jump, and selecting a message with the keyboard no longer reflows its text or its quotes
- Messages no longer show a thin gap after a link preview when the same sender follows up, including at larger text sizes
- Native apps now reject connections using compromised eMudhra certificates
- macOS: Fluux no longer crashes when it wakes from sleep while running in the background
- Desktop: attaching or opening files whose names contain non-Latin characters (Cyrillic, for example) works again
- Linux: closing the window keeps Fluux running in the tray under i3 and other desktops that use XEmbed trays
- Contact photos update when a contact removes or changes their avatar, while existing photos survive temporary network failures; Fluux also stops repeatedly fetching profiles that have no photo. Quick successive avatar changes no longer leave an outdated photo, and contacts whose server never answers are no longer queried again on every launch
- Encrypted conversations and rooms keep an accurate last-message preview once messages are decrypted, and stop showing placeholders for decrypted reactions and deletions. Encrypted reactions, edits and deletions that arrive before the sender's key is available are applied once the key arrives, and reconnecting no longer brings back their placeholders or unread badges
- Notifications for encrypted messages wait until the message is decrypted and then show its current text. Web push notifications for encrypted messages show generic text instead of an encryption placeholder
- Deleted messages stay deleted: a retraction now survives an app restart, so a later archive sync cannot bring the text back into the conversation or into search, and text left over from messages deleted in earlier versions is cleared from the local cache
- Group chats: a message from someone who reuses a nickname freed by a departed member is no longer swallowed by that member's deleted message, and the new-message count no longer includes messages removed as spam
- When history has more than one gap, each gap in the loaded conversation or room can now be shown and filled separately instead of silently leaving messages missing
- When another client reuses a message ID, both direct messages remain visible and searchable, and editing or deleting one no longer affects the other
- Conversations with reply quotes no longer crash from repeated layout updates, and quotes stay inside their message bubbles
- Moderators now see when a room leaves a voice approval unanswered and can retry or dismiss the request
- An archived conversation returns to the conversation list when a newer message arrives
- System notifications now stay silent when notification sounds are turned off, and messages the app does not show no longer ring
- Notifications for a conversation you already read on another client are removed, including when Fluux reconnects and catches up on that conversation
- Group chats: messages you send from another device under a different nickname are recognised as yours, so they no longer trigger notifications or count as unread
- Link previews are no longer lost when they arrive while a conversation is in the background or still opening
- Reopening a room with short multi-line messages no longer makes the view jump, and the view stays on the latest message when a message above it changes
- On narrow screens, the member list offers Whisper again and opens the private composer directly; a long press on a member, conversation, contact or room no longer selects its text

---
[Full Changelog](https://github.com/processone/fluux-messenger/blob/main/CHANGELOG.md)
