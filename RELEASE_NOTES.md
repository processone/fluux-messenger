## What's New in v0.18.2

### Added

- macOS: when your OpenPGP key can no longer be unlocked, Fluux offers to restore it from your server backup or a backup file. The same recovery is available from Encryption settings. You confirm the account and the full key fingerprint before anything is saved, your existing keychain items and backup files are kept, and messages waiting to be decrypted show their text once the restore is done
- macOS: if your OpenPGP key stays locked because the keychain refused access and you have no backup, Fluux offers an advanced option to ask macOS again, in Encryption settings or in the recovery choice it shows. Fluux asks only when you press its button, and it unlocks the same key without creating a new one
- iOS and iPadOS: drag down on a conversation to hide the keyboard, in the app and in Safari
- iOS: on iPhone Duo held half open, Fluux arranges itself around the fold. In landscape, the conversation list sits on one side and the chat on the other; in portrait, messages stay above the fold and the message box below it, leaving room for the keyboard

### Changed

- Room notifications show the room name first, then the nickname of the person who wrote the message, now on iOS as well as macOS. On iPhone, room push alerts use the app icon. In-app room banners on the web and iOS show the room picture or # fallback, with the sender above the room name and message, and combined browser message counts show the room name instead of the latest sender
- iOS: Fluux asks the server to keep a disconnected session resumable for up to 24 hours, so it can pick up where it left off after a long time in the background. On every platform, Fluux follows the duration your server actually grants and no longer tries to resume a session the server has already closed

### Fixed

- Room history stays readable while you join a room: only the message box is replaced by a joining status. Reopening a room no longer shows the cached-history warning or asks you to join while it is already rejoining, and a failed join brings back the join button
- On desktop, new messages no longer move the message, action buttons or menu you are using. Typing resumes following new messages if you were following before, unless a menu is open, and the jump-to-latest button stays hidden while a message menu is open
- Scrolling up in conversations and rooms no longer jumps backward when messages above the view become shorter, and private messages in rooms no longer make the messages around them jump as you scroll. On iOS, your reading position also holds when you pull past the top or bottom and when you lift your finger
- When a delayed message arrives while older messages are still loading, the messages you are reading no longer move, whether it lands above them or, after you scrolled during the load, below them, including when you are partway through a long expanded message
- A Fluux window that is minimized or otherwise not visible no longer marks messages as read or holds back their notifications
- Encrypted messages that arrive before Fluux has the sender's key now show their text once decrypted, instead of staying encrypted
- Scrolling back now reaches older history even when the server archive holds long stretches without visible messages, and edits to older messages still appear once those messages load
- iOS: tapping a Siri suggestion to send a message to a contact now opens that conversation, instead of leaving Fluux on the screen it was showing. A suggestion for a room does the same while Fluux is running in the background
- Typing right after picking a mention no longer moves the cursor back
- The message box no longer sends the same message twice, and a message that fails to send stays in the message box so you can try again. Errors when sending, editing or deleting a message now each have their own wording, in every language
- iOS: notifications keep the message text when the preview cannot be prepared in time, and the generic wording follows the app language
- macOS: if Fluux stopped in the middle of restoring an encryption backup, it puts your previous key back at the next launch instead of leaving encryption locked
- macOS: refusing or failing one old keychain item during the first migration no longer blocks your other saved secrets. Fluux keeps the readable items available and does not repeat the full migration on every call
- macOS: a startup display check now offers native Restart Fluux, Copy diagnostics and Quit controls if Fluux cannot display, with at most one automatic recovery attempt and no clearing of saved data
- Forgetting your OpenPGP key while Fluux is still unlocking, importing or rotating it now waits for that work to finish, so a key can no longer be saved with the passphrase being deleted

---
[Full Changelog](https://github.com/processone/fluux-messenger/blob/main/CHANGELOG.md)
