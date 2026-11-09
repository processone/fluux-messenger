# iOS notification diagnostic

After a natural notification burst, open Settings → Notifications → Export diagnostic.
The iPhone share sheet lets you save or send `fluux-notification-diagnostic.json`.
Nothing is uploaded automatically. Cancelling the sheet sends nothing.

The local App Group journal keeps at most 200 entries for a 48-hour window. One
notification can produce several entries. It records only the exact app/extension
version and build, Unix time in seconds, an allowlisted decision, elapsed
milliseconds when available, and a fresh random UUID correlating that processing
run. App and extension runs get independent markers; these are not message or
notification request identifiers. There are no message bodies, correspondents,
message identifiers, push payloads, tokens, keys or arbitrary error text.
The same export includes widget decisions; see [Unread conversations widget](IOS_DEVELOPMENT.md#unread-conversations-widget) for their meaning and proof limits.

The journal excludes backup and uses iOS data protection. App and extension writes
are serialized through SQLite transactions. SQLite uses a two-second busy timeout
for competing work before returning a best-effort storage failure; diagnostic
content never controls notification presentation. Automatic cleanup samples
the current time after acquiring the transaction, so waiting writers do not
mistake newer concurrent entries for a clock rollback. Logout/account changes
clear it and rotate its random session marker, so a finishing old extension cannot
restore it.
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

## Widget refusal categories and current observations

Historical `widgetAccountMismatch` remains available. Future refusals also record
exactly the guard reached: `widgetBadgeOwnerMissing`, `widgetBadgeOwnerMismatch`
or `widgetListOwnerMismatch`. A list guard reached first does not speculate about
an unread badge guard. These categories neither adopt old ownership nor change
counting, presentation or the guarded write. They cannot explain older generic
entries retroactively.

The existing voluntary export also adds a current-observation group to its
**temporary share copy**, not to another persistent log or the stored journal.
The existing five fields are unchanged. `widgetSnapshotBegin` and
`widgetSnapshotEnd` delimit the group under one fresh random `correlation`.
Each intervening entry contains one closed `decision` and its observation `time`.
There is no `snapshot` field, account value, identity hash or free-text error.
The share copy reserves space for the complete group within its 200-entry ceiling,
keeping the newest historical entries that fit. Stored historical retention
remains 200 entries/48 hours. Export does not activate a signed-out session.

The group samples these separate boundaries:

- App store facts: online, verification, catch-up and archive replay, each with an
  explicit unknown state. They do not release any readiness barrier.
- Native file ownership **relations**, separately for badge and list: missing
  owner, matching owner, different owner or unavailable/unknown. File contents
  and owners never leave the app.
- App badge-command emission and its pending, accepted or rejected acknowledgement.
- The last observed native badge reception/write outcome: received, written,
  current without writing, superseded, failed or unknown. This in-memory state
  is account-scoped and invalidated at session changes; late old completions
  cannot restore it.

These are successive observations, not an atomic cross-layer snapshot. App facts
are sampled before invoking the existing export command and retain that sample's
time; a missing, future or more-than-five-seconds-old sample becomes unknown.
Native relations and native badge phase are sampled separately during export.
App and native observations do not establish cross-layer account identity or
attribute a current state to an earlier refusal.

`WidgetDiagnostic.observations(in:)` defines the reading contract. A group missing
its start/end, mixing correlations or containing unrelated categories is unknown.
A missing or contradictory category is unknown on its own axis. An acknowledgement
without observed command emission is also unknown. A truncated group must never
be interpreted as a complete snapshot, and absent events never prove nonexecution.
A native acknowledgement does not prove a WidgetKit render or an installed native
source revision. Physical iPhone qualification remains separate.

## Validation

- `node --test scripts/ios-notification-diagnostic.test.mjs`: closed current groups,
  ownership relations, explicit unknown/incomplete/contradictory states, fresh
  correlations, identity-free output, transient share-copy snapshots and the
  unchanged native storage cap,
  age boundary, closed export schema, logout, session rotation and concurrent writers.
  The unchanged lifecycle regression runs alongside controlled SQLite contention:
  recovery after a temporary writer lock, bounded failure under a sustained lock,
  and four independent processes retaining all 200 entries before logout.
- `npm run test:ios-notifications`: existing delivery/presentation tests plus
  exported preview/widget decisions, read-before-publication/clear timing, and negative
  controls for retained read targets, verified-current native no-ops, body/identity leakage,
  wrong-account/legacy badge state and a background diagnostic queue that must not block publication.
  The same family exercises shared-file app deduplication, same-total membership reconciliation,
  concurrent badge increments, late reads, rejected stale app frames and refused writer locks.
- `FLUUX_DIAGNOSTIC_RESULTS=/absolute/path/outside/project npm run test:ios-diagnostic`:
  creates a disposable unsigned simulator, presents the production native share
  helper, cancels without sending, and verifies temporary-copy deletion. This
  isolated native fixture is not the full Fluux application or a real APNs burst.
- `npm exec -w @xmpp/fluux -- vitest run src/components/settings-components/IosNotificationsCard.test.tsx`:
  voluntary native command, offline/permission-denied availability, disabled busy
  state and generic retryable failure. No device account is needed.
