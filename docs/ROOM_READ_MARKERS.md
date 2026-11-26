# Room read positions

Fluux can show who has read through a message in a small private room using
XEP-0333 displayed markers. These are cumulative display positions, not delivery
receipts and not proof that someone understood a message.

## Privacy and controls

Sharing starts off. Enable **Share my read position in this room** in the room's
details. This is the only consent needed for sharing and showing room positions.
Each room choice is saved for the account on this device. Enabling one room never
enables another. There is no room read-position control in Privacy.

The room and its occupants can see this metadata, and the room archive may retain
it. Opting out stops future updates; it cannot retract previously stored markers.
Fluux hides other people’s positions and closes their reader list while this
room’s sharing choice is off. This does not delete received markers or change
what the room has already stored.

### Upgrading and older clients

An upgrade preserves sharing only where both the old Privacy switch and the old
room choice were on. Rooms paused by Privacy Off remain off until you choose each
one again. Missing, invalid or unreadable preferences remain off. Conversion does
not publish a marker or reset the last-sent positions.

Consent stays under the same account-scoped local storage key, in a versioned
format without a master flag. Account generations and per-room edit revisions
reject an older On that arrives after a newer Off without discarding another
room's choices. The existing migration fence also retains the epoch and per-room
edit revisions and account identity, so an older client's preference overwrite cannot hide a newer Off
from a waiting updated client or cancel an independent converted edit. Browser storage transactions serialize the actual
commits; they do not by themselves establish the order in which people made choices. Web Locks
support is not required.

Pending sends recheck durable consent. Choosing Off stops publication in this tab
while saving waits, including through a reconnect. The room switch shows its busy
state and keeps keyboard focus until saving finishes; repeated input does not
start another save. Saving and account clearing are asynchronous. Conversion
never reuses a pending view; a fresh focused observation is required afterward.

Scoped clearing removes the target account's records before attempting to convert
unaffected preferences. Each conversion stores its self-contained choice before
its compatibility fence, so either refused write leaves valid consent intact.
Refused unrelated conversion is reported without discarding its valid choices.
Successful guard replacement permits only the exact effective choices of unaffected accounts whose conversion was
refused; it never permits the erased account to import old consent. Those
exceptions disappear when their account saves or clears its choice. Unknown
older guards remain sealed. A refused replacement retains the existing seal or
a writable account fence and reports incomplete cleanup. When all barrier writes
are denied and no usable prior barrier exists, durable revocation cannot be
guaranteed; cleanup reports failure rather than claiming completion. Successful
cleanup leaves no target-account data in the guard; failed cleanup can retain
protection records. Full clearing retries its shared seal after ordinary data frees
storage, including after compacting history fences. A refused growing save
retains a compact revocation boundary wherever storage allows it. Uncoordinated
recovery may change only the initiating unchanged storage boundary; it cannot
recreate cleared records or erase newer choices. Transaction abort never replays
destructive cleanup outside its storage turn. A failed Off instead obtains a
fresh storage turn to revoke only its still-owned choices, preserving newer
independent opt-ins. Normal and compact recovery fences retain revocations and ordering history;
they cannot authorize an unsaved On. Confirmed preferences remain the
only source of permission, with revocations overlaid after partial writes.
An independently erasable continuity proof binds the account identity to its
preference; clearing removes both, even when the import fence cannot be replaced.
During a partial legacy Off, the proof also binds the exact previously validated
input, so untouched selections survive conversion refusal without authorizing a
different replacement. Fences link that input by an opaque identifier, never a
copy of the preference. Scoped conversion retains existing proof until its
preference commits. Unconverted legacy ownership is reserved independently of
the shared token, so another tab’s later conversion cannot release a failed Off,
including when its two reads fail after that reservation already exists.
Scoped conversion reserves missing identity once; only existing input proof
waits for preference commit before replacement.
If the account-local identity reservation itself is refused, the exact legacy
exception carries its surviving identity in the shared guard; later conversion
and both Off setters keep that boundary. This fallback still requires a writable
shared guard and does not replace the total-write-denial limitation above.
When local identity exists, the exception references its opaque, erasable proof
ID instead of copying identity; a replacement proof cannot reactivate it. If continuity remains unwritable during Off, the exact
shared exception can retain room revocations and ordering while preserving
untouched choices; deleting local proof still invalidates earlier work. Repeated
scoped conversion retains that exception’s revocations and ordering. Migration
retires shared authority only after a linked replacement is saved, and delayed
failure cleanup checks the account’s shared protection as well as its token.
A retained exception links newly reserved local proof even when replacement
is refused. Exact confirmed shared or linked input survives replacement even
without a prior revocation; it never grants the proposed unsaved On. A new On
that fails before writing leaves other confirmed choices unchanged. Refused
new On writes also preserve the existing confirmed current-format record.
Focused observations retain their conversion boundary through discovery and
dispatch; another tab’s conversion requires a fresh observation even when
account identity and effective choices do not change. The erasable continuity
record reserves a pending conversion token before preference commit without
retiring linked input, then completes it after the preference is committed.
Observations captured while the token is pending cannot publish, even after
an exact older preference rewrite. Refused completion leaves publication
blocked; coordinated reads retry completion only for a confirmed current
preference. Ordinary writes retain the completed boundary. Scoped conversion
completes the token with linked-input cleanup; refusal leaves it pending,
without discarding committed independent choices.
Already-linked inputs need no duplicate exception in the shared clear guard.
Pure migration never publishes from its first write.
Refusal of a final On lift leaves its revocation in place without deleting other
saved selections. Recovery advances
ordering without changing account identity, so another room’s Off remains valid. Local room suppression survives failed saving until a fresh
choice or a new account boundary supersedes it. The legacy all-Off operation
uses the same room-scoped guards and temporarily protects an unknown selection
until its initial snapshot is available, including after repeated read refusal.
Unresolved suppression becomes room-scoped when reads recover, excluding newer
choices and retiring after target erasure, not after an unrelated logout. It never uses local suppression as saved consent. Pre-clear Off cannot modify
post-clear consent, even after a legacy overwrite or fresh opt-in. A later fresh choice preserves the fallback epoch independently of the
consent record, so an older overwrite cannot reset the erasure boundary.
The empty coordination database contains no account data.

Watermark writes share the clearing transaction and merge the durable map rather
than a cached copy. Room archive operations capture their erasure boundary once
and carry it through cursor fallbacks, hydration, paging and queued catch-up,
including both cache reads in normal room activation.
Foreground and fresh-session callers capture before loading their cache.
Generic chat archive work does not capture room consent. Discovery retry drains
the original observation after refreshing consent; it never creates a new view.
Pending publication rechecks its original observer's lifetime, current geometry, conversation,
coverage and current private read pointer after waiting for storage. The real
transport runs preflight before synchronously saving the anchor and starting its
write. A definitely unstarted send leaves no anchor; uncertain attempted delivery
retains it. A background read failure does not discard saved room choices.

An older client reads the new format as off. A still-open older tab can write and
use its cached choices, including choices revoked in the new app. The new app
cannot enforce its revocations in older code. Failed saves stop sharing and
report the failure.

Direct-chat read positions remain separate planned work in issue #5. They will
need their own Privacy preference and fresh consent, never copied from rooms.

## Eligibility

The room's current discovery must positively advertise all of:

- `muc_membersonly`, `muc_hidden`, and `muc_nonanonymous`;
- XEP-0421 occupant IDs and XEP-0359 stanza IDs.

Contradictory public, open or anonymous flags fail closed. Joining must be complete,
the live roster must include this session and stable occupant identities, and the
room's discovery count must match the full roster. Nineteen occupants, including
yourself, may qualify; twenty do not. Presence and configuration updates invalidate
previous discovery evidence. Fluux cannot react to a server change it has not been
told about. A failed room-information request is not negative room evidence:
Fluux retains the last proven display and retries with increasing delays capped
at one minute while sending remains gated. Presence, configuration or connection
changes reset that backoff.

## Sending and receiving

Only actual measured viewing of an incoming plaintext row in the focused window
can request a marker. Covered dialogs and the phone members pane are not viewing;
closing them re-measures the exposed rows without requiring a scroll or refocus.
Local read events alone never do. Hydration, mark-all-read,
background catch-up, private XEP-0490 updates, previews and own outgoing rows are
not viewing evidence. Encrypted and undecryptable rows are excluded.

A pending advance rechecks the account, session, focus, consent, room evidence and
confirmed local read pointer. Fluux sends a bodyless groupchat stanza to the room's
bare address, containing a displayed marker with the verified room-assigned
stanza ID and an XEP-0334 `store` hint. A persistent account/room watermark prevents
backwards sends and deduplicates in-flight or restarted work. The watermark is
written before sending; an uncertain send is not sent again as a new read.
On native platforms this account-scoped record stays in synchronous webview
storage with its message-row references, rather than the asynchronous native
preference bridge. Two devices can still send the same position before either receives the other's
reflection. Storing markers depends on the server honoring the storage hint.

Live and archived markers share one validator and archive-ID resolver. Marker
positions are separate from message data and local read state. After a fresh
session, cached history in a qualifying room triggers at most one read-only page
of the latest 50 archived stanzas to restore recent peer positions. Cached preview
and catch-up share this page without waiting for recovery to finish. At most two
recovery jobs run concurrently, including discovery and archive resolution. Recovery
skips rooms the join already identifies as public, anonymous or too large. It
resolves only resident or cached targets that passed normal content processing;
newer offline rows remain the responsibility of ordinary catch-up. The recovery
page does not insert timeline rows or change archive coverage or local read
pointers. It cannot restore markers outside that page; ordinary history queries
can still resolve them when encountered. A MAM page resolves its markers after
parsing the page's targets. Only a standalone marker and its
identity/storage metadata bypass normal message processing; additional encryption,
reaction, retraction or moderation payloads still reach their existing owners.
Unresolved, foreign or ambiguous
targets never move to a different message. Position order comes from server-ordered
archive pages and undelayed room delivery, never from opaque IDs, nicknames or
marker timestamps. When two positions have no known order, a read-only, bounded
MAM probe can establish it without inserting rows or changing archive coverage.
Walks are shared by their starting position, not repeated for each candidate.
Completed probes are remembered until order evidence changes; a capped walk
resumes at its last cursor. A single archived page does not start a new capped
walk for every marker. A positively purged send anchor is older than
retained history, matching private read-sync recovery. Failed or unknown lookups
never establish order. If the server cannot prove order, Fluux leaves the existing
position alone.

## Display

A short, muted **Read through here** line follows the message and its reactions.
It marks an inclusive position, not a receipt for that message alone. Each line
shows up to three whole names in stable occupant-ID order. Short lists need no
click. When names do not fit, an underlined **+N others** link opens the full list
at that exact position; **N readers** is used when no name fits. People with later
positions are not included. Only the label is italic. Large text can wrap, and
there is no trailing text reservation or full-width peer divider.

Nick changes preserve identity, departures hide the reader, and reused nicknames
do not inherit another person's position. Fluux hides your own marker, including
other devices using your account's verified room occupant ID. An open list keeps
the names captured when it opened until you close it, even when readers advance.
Disabling sharing also closes the list. Keyboard focus returns to the link, or
to the timeline if the link disappeared. Updates use per-row snapshots rather
than replacing the timeline's messages.

Unread badges, the new-message divider, the local read pointer and private
XEP-0490 synchronization keep their existing meanings and writers. Direct chats,
private messages to room occupants, room delivery receipts and encryption changes
are not part of this feature.
