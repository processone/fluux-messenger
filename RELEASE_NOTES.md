## What's New in v0.18.1

### Added

- While Fluux is reconnecting for more than two seconds, the open conversation or room shows the connection step ("Reconnecting in 5s", "Connecting...") under its name, and so does the list title on narrow screens
- After reconnecting, the open conversation's header briefly says it is fetching missed messages, then shows a small icon next to the status or topic until they have arrived
- When the Fluux window is focused, a message in another conversation, or a room message that would notify you, shows a Fluux banner instead of a system notification. Tap it to open the message. When Fluux is not focused, system notifications work as before. Turn the banner off with "Show banner" in Notifications settings

### Changed

- The push server component was updated for better compliance with Prosody

### Fixed

- A room whose picture no longer loads now shows the # tile in the Rooms list, like the Messages list and room header, and rooms keep their picture after long reconnects, on any server
- The message box no longer promises that messages will be sent on reconnection while sending is paused: it now says you can send once you are back online
- New-message dividers include all unread messages when new messages arrive after scrolling an unfocused room or chat
- Scrolling up while a message above you finishes loading no longer snaps the conversation or room back to where you were a moment earlier
- The room message box is now a single editor: the caret can no longer drift from the text (seen with inline predictive text on macOS), and @mentions stay coloured while you type
- macOS: saved sign-in, encryption keys and local integrations share one keychain approval after a one-time migration. Existing secrets remain available to the previous release
- Encrypted messages that arrive while your network is briefly down now show their text when Fluux reconnects, instead of "[OpenPGP-encrypted message]"
- Encrypted text files you receive now show their content in the preview and download decrypted, under their real name
- An open conversation you have read no longer keeps an unread badge in the list
- iOS: the conversation no longer snaps back to the bottom while your finger is on it, and messages in unsupported encryption no longer shift the view after opening
- iOS: tapping a notification Fluux showed while running now opens its conversation or room
- iOS: long-press menus in the contact, room and conversation lists are no longer cut off at the bottom of the list

---
[Full Changelog](https://github.com/processone/fluux-messenger/blob/main/CHANGELOG.md)
