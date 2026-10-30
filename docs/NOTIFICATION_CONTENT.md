# Notification content contract

This is the content policy for app-generated message notifications, web service
worker pushes and the iOS notification service extension (NSE). The executable
examples are owned by `tests/fixtures/notification-content.json`; both
`apps/fluux/src/utils/notificationContent.test.ts` and
`scripts/native-tests/NotificationContentTests.swift` consume that file. Update the
contract and fixtures together when changing notification text.

Each fixture names a scenario and supplies the inputs and expected outputs for
the platforms that can represent it: `app` uses SDK message fields, `push` uses
the server's JSON payload, and `ios` uses notification content and optional
synthetic archive events. A missing platform projection means the input is not
available there, not that the platform may invent that information. `null` app
output means silence. The fixtures' English `words` are checked against the
current app translations and passed to the native reducer as its localized words.
No executable formatter is shared between Swift and TypeScript.

## Message content

| Input | App-generated notification | Web push | iOS remote push |
| --- | --- | --- | --- |
| Plain body | SDK preview text | Transport body | Transport body, or selected archived plain body |
| Decrypted and accepted body | SDK preview text | Already-rendered transport body only | Verified, opted-in OX archive body |
| Pending decryption/verification, failed or rejected content | Silent; the existing arrival may be reconsidered once on recovery | Generic `New message` when marked encrypted | Generic localized `New activity` unless an opted-in preview succeeds |
| Unsupported encryption | Localized named or unnamed unsupported-method notice; never the sender's fallback | Keep an already-rendered notice when supplied as plain content | Keep an already-rendered plain notice even when the archive lookup is unknown |
| Empty/whitespace body without another previewable feature | Silent | Generic `New message` | Generic `New activity`; a blank archive body is not a candidate |
| Attachment or poll | SDK preview emoji and caption/name/title | Server-rendered text only | Archive body only; the NSE does not synthesize attachment or poll labels |
| Correction | Current resolved message preview; eligibility/dedup belong to the SDK, not the builder | Server-rendered text only | Ledger replaces a unique verified candidate, or formats the existing localized edit notice |
| Reaction | Not a new message body; separate reaction-notification eligibility and text remain in the app's reaction path | Server-rendered text only | Ledger formats the localized reaction notice |
| Retraction | Deleted-message notice; Spam is silent | Server-rendered text only | Ledger hides the deleted body and uses the localized deletion notice |

The app uses `isNotificationMessageReady` before `formatLocalizedPreview`, so a
recoverable encrypted fallback cannot be mistaken for content. An attachment,
poll or unsupported-method notice may be previewable without a body. Styling and
reply quotes are stripped by the app's SDK preview formatter. The SW and NSE do
not run that formatter: server/plain archive text retains styling and reply
quotes. The NSE's bounded engine supplies bodies and typed mutation events, not
SDK attachment/poll objects. These are intentional differences.

## Transport fallback and privacy

The optional push `encrypted: true` means its body is a fallback, not readable
content. Both remote paths replace it with generic text. With no encryption flag,
they also recognize these exact legacy fallback bodies (ignoring surrounding
whitespace): `This message is encrypted`, `[OpenPGP-encrypted message]`, and
`[Encrypted message: could not decrypt]`. An explicit `encrypted: false` preserves
literal nonblank plaintext, including those same words. Arbitrary sender-selected
fallbacks cannot be recognized without encryption metadata; an unmarked,
nonblank body remains opaque server text. Neither remote path decrypts the push
body itself. No push-server schema change is required.

The web SW cannot inspect SDK message state or keys. It must surface an alert for
a received push; lookup/show failures retain its existing generic fallback.

The NSE checks the signed-in account before presentation and again before handoff.
Logout or a known recipient mismatch produces neutral `Fluux` / `New activity`
content with no sender, routing, badge or sound metadata. Missing optional `to`
remains compatible with signed-in legacy pushes. Only covered direct senders with
a current opted-in snapshot may use OX previews; rooms and explicitly unencrypted
pushes bypass that work. Preview opt-out, hidden previews, expiry, unavailable keys,
incomplete/unknown results, duplicate/read messages or revoked capability cannot
reveal a decrypted body. These outcomes retain the individual push's transport-safe
body: readable unmarked server text stays readable, while an encrypted or recognized
placeholder remains generic activity. This includes duplicate-only results after an
earlier lookup claimed every message in a burst. The extension does not infer an exact
push-to-message identity from a standard push. Suppression requires Apple's
notification-filtering entitlement.

When the server has no archive, the transport-safe push is the only content
source: apply the transport fallback rules above. The catch-up ledger still owns identity, read/notification claims,
mutation-target resolution, retraction removal and conservative unknown-event
handling. The content contract changes neither that persisted format nor its
bounded query/deadline/memory rules.

## Titles and counts

| Context | Title | Body with several unread/new candidates |
| --- | --- | --- |
| App native chat | Contact name or sender local part; append formatted unread count | Latest resolved preview |
| App native room | `nick @ room name` | Latest resolved preview |
| App web chat | Contact name or sender local part | Localized `N new messages` |
| App web room | `nick @ room name` for one, room name for several | Localized `N new messages` |
| Web push | Payload title, else `from`, else `Fluux Messenger` | Localized `N new messages`; count displayed notifications for the same tag |
| iOS remote chat | Mirrored contact name, else sender local part | Localized `nickname: N new messages` for fresh ledger candidates |
| iOS remote room | Mirrored room name with nick as subtitle | Transport-safe body; OX room preview is not supported |

Counts intentionally have different sources: the app's unread count, the SW's
still-displayed notification count, and the NSE's fresh claimed archive candidates.
These are not interchangeable. Transport tags, navigation, sound and badge policy
remain owned by their existing paths.

## Validation

Run from the repository root:

```sh
npm exec -w @xmpp/fluux -- vitest run src/utils/notificationContent.test.ts src/utils/pushNotificationCoalesce.test.ts src/sw.test.ts src/hooks/useDesktopNotifications.decryption.test.tsx
npm run test:ios-notifications
```

On macOS, the native runner compiles the actual Swift service/presentation,
completion gate and SQLite ledger with `swiftc`, a synthetic engine, synthetic
account names and isolated temporary storage. It requires no device, signing,
installed app or network. The project template has no extension test target or
XCTest scheme; these standalone Swift checks provide device-free coverage.
They do not prove APNs delivery, real archive fetching/decryption, system preview
presentation or physical-device resource limits.
