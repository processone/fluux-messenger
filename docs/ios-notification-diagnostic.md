# iOS notification diagnostic

After a natural notification burst, open Settings → Notifications → Export diagnostic.
The iPhone share sheet lets you save or send `fluux-notification-diagnostic.json`.
Nothing is uploaded automatically. Cancelling the sheet sends nothing.

The local App Group journal keeps at most 200 entries for a 48-hour window. One
notification can produce several entries. It records only the exact app/extension
version and build, Unix time in seconds, an allowlisted preview decision, elapsed
milliseconds when available, and a fresh random UUID correlating that processing
run. App and extension runs get independent markers; these are not message or
notification request identifiers. There are no message bodies, correspondents,
message identifiers, push payloads, tokens, keys or arbitrary error text.

The journal excludes backup and uses iOS data protection. App and extension writes
are serialized through SQLite transactions. Logout/account changes clear it and
rotate its random session marker, so a finishing old extension cannot restore it.
An export also removes expired entries. Notification processing and the running
app perform automatic cleanup; iOS does not guarantee any code execution while an
app is suspended or the phone is off. Expired entries are removed on the next
execution, never returned by export, and the active app checks every minute.
The temporary export copy is removed on share-sheet dismissal, logout, and next
app launch. A file the user saves or sends is outside Fluux's control.

This diagnostic does not change notification presentation, suppress alerts,
identify event classes missing from a push, or establish the cause of a past
burst. In particular, `nothingNew` means the existing preview selection found no
new displayable body; it does not prove the server's reason for sending a push.
`noEngineResult`, `deadline`, and `systemExpiry` distinguish missing engine output
from the local deadline and iOS extension expiry.

## Validation

- `node --test scripts/ios-notification-diagnostic.test.mjs`: native storage cap,
  age boundary, closed export schema, logout, session rotation and concurrent writers.
- `npm run test:ios-notifications`: existing delivery/presentation tests plus
  exported preview decisions and negative controls for body/identity leakage.
- `FLUUX_DIAGNOSTIC_RESULTS=/absolute/path/outside/project npm run test:ios-diagnostic`:
  creates a disposable unsigned simulator, presents the production native share
  helper, cancels without sending, and verifies temporary-copy deletion. This
  isolated native fixture is not the full Fluux application or a real APNs burst.
- `npm exec -w @xmpp/fluux -- vitest run src/components/settings-components/IosNotificationsCard.test.tsx`:
  voluntary native command, offline/permission-denied availability, disabled busy
  state and generic retryable failure. No device account is needed.
