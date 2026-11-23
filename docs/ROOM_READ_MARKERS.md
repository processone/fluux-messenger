# Room read positions

Fluux can show who has read through a message in a small private room using
XEP-0333 displayed markers. These are cumulative display positions, not delivery
receipts and not proof that someone understood a message.

## Privacy and controls

Sharing starts off. Enable **Share room read positions** in Privacy, then enable
**Share my read position in this room** in each room's details. Both choices are
saved for the account on this device. Enabling one room never enables another.
The master switch stops all sending without forgetting the selected rooms.

The room and its occupants can see this metadata, and the room archive may retain
it. Opting out stops future updates; it cannot retract previously stored markers.
Incoming valid markers remain visible even when sharing is off.

## Eligibility

The room's current discovery must positively advertise all of:

- `muc_membersonly`, `muc_hidden`, and `muc_nonanonymous`;
- XEP-0421 occupant IDs and XEP-0359 stanza IDs.

Contradictory public, open or anonymous flags fail closed. Joining must be complete,
the live roster must include this session and stable occupant identities, and the
room's discovery count must match the full roster. Nineteen occupants, including
yourself, may qualify; twenty do not. Presence and configuration updates invalidate
previous discovery evidence. Fluux cannot react to a server change it has not been
told about.

## Sending and receiving

Only actual measured viewing of an incoming plaintext row in the focused window
can request a marker. Local read events alone never do. Hydration, mark-all-read,
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
positions are separate from message data and local read state. A MAM page resolves
its markers after parsing the page's targets. Unresolved, foreign or ambiguous
targets never move to a different message. Position order comes from server-ordered
archive pages and undelayed room delivery, never from opaque IDs, nicknames or
marker timestamps. When two positions have no known order, a read-only, bounded
MAM probe can establish it without inserting rows or changing archive coverage.
If the server cannot prove that order, Fluux leaves the existing position alone.

## Display

Each reader appears beneath their most recently displayed message, identified by
the room's occupant ID. Nick changes preserve identity, departures hide the reader,
and reused nicknames do not inherit another person's position. Fluux hides your
own marker. Each badge shows up to three avatars; its button opens a full named
list with keyboard and touch support. Updates use per-row snapshots rather than
replacing the timeline's messages.

Unread badges, the new-message divider, the local read pointer and private
XEP-0490 synchronization keep their existing meanings and writers. Direct chats,
private messages to room occupants, room delivery receipts and encryption changes
are not part of this feature.
