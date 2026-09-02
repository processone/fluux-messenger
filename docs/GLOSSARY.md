# Glossary

The words this project uses, and what they are called elsewhere.

Fluux describes its own work in terms that are often *not* the ones the rest of the industry uses.
That is fine once you know the mapping and expensive before you do: a ticket or an architecture
discussion is unreadable until the vocabulary is shared. So every entry below gives, where one
exists, **the standard notion the term corresponds to**. Where our name is unusual and a common one
exists, the entry says so plainly. Where a concept is genuinely specific to XMPP or to this app, the
entry says that instead — that is a useful fact, not a gap.

Every term here was harvested from the code. Entries point at the file that defines or uses them;
that file, not this page, is authoritative.

Two other conventions to know before reading:

- Terms flagged **⚠ overloaded** are one word used for two or more different things. That is a
  naming defect, not a subtlety. Listing them here is how they become visible.
- Where two terms mean the same thing, the entry says which to prefer.

Related documents: [`MESSAGE_IDENTIFIERS.md`](MESSAGE_IDENTIFIERS.md) (which id is authoritative and
why), [`MAM_CATCHUP.md`](MAM_CATCHUP.md) (how history is fetched),
[`2026-07-23-scroll-positioning-contract.md`](2026-07-23-scroll-positioning-contract.md) (the
positioning contract).

---

### addressable / local

The two current states of a read pointer's *name*. `addressable` carries an XEP-0359 archive id and
can be published to other devices; `local` carries only the cached message id. An exact local
pointer can converge to addressable later when that same message acquires an archive id; both states
are serialized.

**Standard notion:** a wire-addressable identifier versus a cache- or device-local one. There is no
common name for making that a type-level state rather than an absent field; here it is a
discriminated union. `packages/fluux-sdk/src/stores/shared/readPointer.ts` (`makeReadPointer`,
`withArchiveId`); `packages/fluux-sdk/src/core/types/readState.ts` (`PointerIdentity`).

### ambient

Of a positioning request: one nobody asked for. It reacts to the page changing under a reader —
media finishing measurement, the unread divider moving, a message landing inside the window they are
reading — rather than to an intent. It is not one precedence class: `layout-preservation` yields to
any unsettled position, while `media-preservation`, `history-preservation`, and `ambient-live-edge`
yield only to navigation and may reassert an unsettled live-edge follow.

**Standard notion:** implicit or reactive, as opposed to user-initiated. The closest common concept
is the browser's own **scroll anchoring**, which does the same job automatically.
`apps/fluux/src/components/conversation/scrollPositionModel.ts` (`REQUEST_PRECEDENCE`).

### anchor ⚠ overloaded

1. **Fixed / viewport anchor** — a chosen point of one message kept stable in the viewport while
   content around it changes size. Its `bottom-fraction` and `top-offset` geometries are not mixed.
   `apps/fluux/src/components/conversation/scrollPositionModel.ts`.
2. **History anchor** — an archive id used as an RSM `after` or `before` cursor. The
   `chat:history-anchor-purged` and `room:history-anchor-purged` events report one that the archive
   rejected. `packages/fluux-sdk/src/core/types/sdk-events.ts`;
   `packages/fluux-sdk/src/core/modules/MAM.ts`.

**Standard notion:** sense 1 is scroll anchoring; sense 2 is a pagination cursor or checkpoint.

### archive id

An archive-assigned identifier, carried by the message's XEP-0359 `<stanza-id>` or, when that is
absent from an archived message, the MAM `<result id>` wrapper. Authoritative **only relative to the
archive that assigned it** — a message crossing a user's server and a MUC service can carry an id
from each, and those ids are not interchangeable. It carries no ordering, and it can be revoked when
the archive purges it.

**Standard notion:** a server-assigned opaque cursor key, like an offset in a log — except it is not
sortable, which is the part that surprises people. See
[`MESSAGE_IDENTIFIERS.md`](MESSAGE_IDENTIFIERS.md).

### around load

Fetching a slice of history *centred on* a specific message, because the target of a positioning
request is not in the loaded window.

**Standard notion:** a context query, or seek-to-key with a window either side. Common in log
viewers ("show 50 lines around this match").
`apps/fluux/src/components/conversation/scrollPositionModel.ts` (`loading-around`).

### bare JID / full JID

An XMPP address. Bare is `user@host` and names an account or a room; full is
`user@host/resource` and names one connected resource or client session, or one occupant of a room.

**Standard notion:** XMPP-specific, but the shape is an address plus an optional
connection-instance suffix. `packages/fluux-sdk/src/core/jid.ts`.

### binding / store binding

The primary layer that listens to typed SDK events and writes them into Zustand stores. `XMPPClient`
installs it for React and non-React consumers alike; direct-write exceptions include connection state
and poll-vote acknowledgement. XMPP resource binding is a different and unrelated protocol notion.

**Standard notion:** a reducer layer, or the adapter half of ports-and-adapters. Bots avoid React,
not the default bindings. `packages/fluux-sdk/src/bindings/storeBindings.ts`;
`packages/fluux-sdk/src/core/XMPPClient.ts`; `packages/fluux-sdk/src/core/modules/Poll.ts`.

### catch-up

Bringing local history back up to the present after being offline, per conversation or room. Split
into **Phase A** (align to live: page forward from the local seed — the recorded gap
boundary first, otherwise the newest eligible cached message; with no usable edge, fetch latest
backward) and **Phase B** (grow to the read pointer: page backward until the remote read position is
found).

**Standard notion:** sync, or backfill. "Phase A / Phase B" are real named parts of the algorithm,
not a work plan. [`MAM_CATCHUP.md`](MAM_CATCHUP.md);
`packages/fluux-sdk/src/core/modules/MAM.ts` (`runCatchUpHistory`).

### coverage ⚠ overloaded

1. **`CoverageRecord`** — persisted, positive data: the archive id of the oldest message *proven
   contiguous with the live edge* on this device. It survives sessions and gap closure.
   `packages/fluux-sdk/src/core/types/pagination.ts`; transitions in
   `packages/fluux-sdk/src/stores/shared/mamCoverage.ts`.
2. **`RoomMamForegroundCoverage`** — an unrelated in-memory single-flight reservation over a room's
   archive fetch, which doubles as a completion memo: `completeRoomMamForegroundCoverage` marks it
   completed but leaves it in place, and `hasRoomMamForegroundCoverage` keeps excluding the room
   from background work afterwards.
   `packages/fluux-sdk/src/core/roomMamHandoff.ts`.

Sense 1 describes contiguous *history*; sense 2 coordinates foreground ownership and remembers
completed foreground coverage. They share no concept.

**Standard notion:** sense 1 is a sync checkpoint or contiguous-range watermark; sense 2 is a
single-flight reservation plus a completion memo.

### divider / new-message divider

The horizontal line marking where unread messages begin. It is **parked**: once established, either
on activation or by an unseen arrival while the active entity is hidden, it does not follow the
reader's scrolling. A remote read marker cannot create or clear it, but can advance an existing one.

**Standard notion:** the unread separator, or "new messages" line, in any chat client.

**Naming:** the code also calls it the *new message marker* (`NewMessageMarker.tsx`, `firstNewMessageId`)
and the *unread marker* (`unreadMarkerBrowserAdapter.ts`) — three names, one thing. Prefer **divider**
in discussion; "marker" is already overloaded (see **marker**).
`packages/fluux-sdk/src/stores/shared/dividerAdvance.ts`.

### entity

A 1:1 conversation *or* a MUC room, when a rule applies to both. Much of the SDK is written twice —
`chatStore` and `roomStore` — and "entity" is the word for the thing they have in common.

**Standard notion:** none in wide use; project shorthand. The nearest generic word is "channel" or
"thread". Note the two kinds deliberately differ where it matters (tie-break rules, cache keys), so
"entity" does not imply "same shape". `packages/fluux-sdk/src/stores/shared/recountDiagnostics.ts`
(`RecountEntityKind`).

### executor / lease

The controller decides *what position is wanted*; an **executor** is the imperative object that
writes pixels to get there. Every positioning write goes through a **lease** — a token carrying the
conversation, the generation, an abort signal, and a frame budget — and a frame with a stale lease
writes nothing. The orchestration hook keeps three deliberate non-positioning writes outside that
rule: two static-preview operations and an emergency bottom write for when the controller cannot be
constructed at all.

**Standard notion:** the lease is a **fencing token**; the pair is a policy/mechanism split. Named
"lease" rather than "lock" because it expires.
`apps/fluux/src/components/conversation/positioningController.ts`
(`PositionExecutionLease`).

### FAB

The floating round button that scrolls to the bottom of the message list. In this codebase "the FAB"
always means that one button.

**Standard notion:** floating action button, a standard Material Design term — but generic there,
specific here. `apps/fluux/src/components/conversation/fabVisibility.ts`.

### fastening

XEP-0422: a new stanza whose `<apply-to>` attaches payload to an earlier message. Here it carries URL
preview metadata and is parsed around XEP-0425 v0 moderation; XEP-0444 reactions are separate.

**Standard notion:** XMPP-specific as a protocol, though the idea is an annotation or metadata
record. `packages/fluux-sdk/src/core/namespaces.ts` (`NS_FASTEN`);
`packages/fluux-sdk/src/core/modules/Chat.ts`.

### floor ⚠ overloaded

1. **`FloorPosition`** — a read position known only to the millisecond: "at least here", not
   "exactly here". It is what a pointer migrated from the old `lastSeenMessageId` + `lastReadAt`
   pair carries, and what an exact position degrades to when its tie-break cannot be rebuilt.
   `packages/fluux-sdk/src/core/types/readState.ts`.
2. **`historyFloor`** — the timestamp at which a conversation or room entered this client's world.
   Explicitly *not* a read position; it stops history predating the entity from counting as unread.
   `packages/fluux-sdk/src/core/types/chat.ts`, `.../room.ts`.

`computeFloor` returns whichever of the two the unread derivation should count from — the read
pointer when there is one, otherwise `historyFloor`. Deliberately not the later of the two.

**Standard notion:** both are lower bounds; sense 2 is a watermark.
`packages/fluux-sdk/src/stores/shared/readState.ts`.

### follow-live

See **live edge**. Only the live-edge position follows appended messages; a fixed anchor pinned to
the newest message with fraction `1` does not.

### gap ⚠ overloaded

1. **`GapInterval`** — a *persisted*, known hole in a conversation or room history: messages are held
   below `start` and, when `end` is present, above `end`, with nothing held between those bounds. It
   survives reloads, which keeps the "Load missing messages" marker from vanishing silently.
   `packages/fluux-sdk/src/stores/shared/mamGap.ts`; `packages/fluux-sdk/src/stores/chatStore.ts`
   (`conversationGaps`).
2. **`forwardGapTimestamp`** — a *session-scoped* field on the query state saying a forward catch-up
   stopped short of live. Not persisted. `packages/fluux-sdk/src/core/types/pagination.ts`.

Detection uses only structural signals — an incomplete forward walk, or a fetch-latest page that
provably does not connect to held history. **Never** timestamp discontinuities: a quiet night and a
real gap look identical, and archive ids are non-sequential.

**Standard notion:** a hole, or a missing range, in a partially-replicated log.

### generation ⚠ overloaded

1. In positioning: a monotonic integer stamped on every position request. Async work carrying an
   older generation is ignored. The controller keeps the highest accepted generation as a
   **watermark**, so
   a cancelled or settled request cannot be revived by a late callback.
   `apps/fluux/src/components/conversation/scrollPositionModel.ts`.
2. In room MAM handoff: a client-wide reset epoch copied into each foreground owner. It advances
   only when coverage is reset, not for every fetch attempt; owner identity and membership epoch
   distinguish attempts. `packages/fluux-sdk/src/core/roomMamHandoff.ts`.

**Standard notion:** a fencing token, epoch number, or monotonic sequence number — the standard
defence against a stale async completion clobbering current state. Both senses are that; they just
count different things.

### hat

XEP-0317: a custom badge on a room occupant (a URI, a title, optionally a colour) — "moderator",
"speaker", and so on, beyond the fixed affiliation/role ladder.

**Standard notion:** XMPP-specific. Closest common analogue is a role tag or flair.
`packages/fluux-sdk/src/core/types/room.ts` (`Hat`).

### heal

Closing a recorded gap. Gaps heal from both directions: forward catch-up resumes from the gap's
lower edge, backward pagination shrinks it as pages reach into or across it.

**Standard notion:** repair, or backfill. `packages/fluux-sdk/src/stores/shared/mamGap.ts`.

### identity tier / canonical key

One logical message arrives several times — the optimistic local echo, the MUC reflection, the MAM
copy — with no single field stable across all three. Identity is therefore a three-tier ladder:
`stanzaId`, then `originId`, then `from` + `id`. Two copies are the same message if they share a
tier and do not carry conflicting XEP-0421 occupant ids; the **canonical key** is the highest tier
present. A room fallback canonical key also carries a known occupant id so conflicting occupants
can coexist, while legacy ambiguous rows remain unchanged. Every room tier key is **scoped by room
JID**. Reference resolution explicitly chooses
`archive-first` or `client-id-first`: the former treats an origin-id as an XEP-0359 identity claim,
while the latter tries real id and stanza-id matches before that sender-controlled value. A set of
copies may be coalesced only when it contains at most one known occupant-id; an occupant-less copy
cannot bridge two conflicting known occupants. For retractions, the full ladder expands a durable
target through `canonicalReference`, while the outgoing stanza deliberately uses
`archiveReference` (archive id, then client id).

**Standard notion:** a composite or fallback deduplication key. The tiering is what is unusual, and
it exists because tier 3 is the only identity a legacy sender or bridge provides.
[`MESSAGE_IDENTIFIERS.md`](MESSAGE_IDENTIFIERS.md) §3;
`packages/fluux-sdk/src/utils/messageIdentity.ts`.

### island

A region of cached history that is not provably connected to anything else — typically left by a
search-context fetch. A catch-up may still *start* from cached rows; what an island cannot do is
*certify* anything, because arbitrary cached overlap alone proves neither that coverage exists nor
that it can be extended.

**Standard notion:** a disjoint or orphan range. `packages/fluux-sdk/src/stores/shared/mamCoverage.ts`.

### live edge

The newest end of a conversation, where new messages land — and, as a **position**, the policy of
staying pinned to it as they arrive.

**Standard notion:** a tail pointer, plus follow/tail mode (`tail -f`, "stick to bottom",
autoscroll). Our term carries both the place and the following.

**Naming:** the browser-side machinery for the same thing is called **pin-bottom** (`pinBottomRun.ts`,
`pinLoopClaim.ts`, `PinRepaintMode`) — an older name for the same concept. Prefer **live edge** for
the position and reserve "pin" for the pixel-level loop.
`apps/fluux/src/components/conversation/scrollPositionModel.ts` (`LiveEdgePosition`).

### marker ⚠ overloaded

Four unrelated things:

1. **Chat marker** — XEP-0333 `<displayed/>`: a read receipt sent to a peer.
2. **Displayed marker / MDS marker** — XEP-0490: *your own* read position, synced across your own
   devices. See **MDS**. `packages/fluux-sdk/src/core/modules/Mds.ts`.
3. **Gap marker** — the "Load missing messages" row in the message list.
   `apps/fluux/src/components/conversation/HistoryGapMarker.tsx`.
4. **New message marker** — the unread divider. See **divider**.

Always qualify which. Unqualified "marker" in a ticket is ambiguous.

### MDS

XEP-0490, Message Displayed Synchronization: publishing your own read position to a PEP node so your
other devices agree on it. Distinct from a chat marker (sense 1 above), which tells the *other*
person you read them.

**Standard notion:** read-state sync across a user's own devices — what most products call "read
position sync". `packages/fluux-sdk/src/core/modules/Mds.ts`,
`packages/fluux-sdk/src/stores/shared/readMarkerSync.ts`.

### membership epoch

A counter bumped each time a room's joined/left state flips. Async work tagged with an old epoch is
rejected, so a reply about a room you have since left cannot act on the room you are in now.

**Standard notion:** a fencing token, again — the same defence as **generation**, scoped to
membership. `packages/fluux-sdk/src/core/roomMembershipEpoch.ts`.

### message id (client id)

The `id` attribute the sending client puts on a stanza. A **name in one stream**, not an identity:
nothing guarantees it is unique beyond the connection that issued it. It is nonetheless the chat
cache's primary key, and — combined with `from` — the lowest tier of room identity.

**Standard notion:** a client-generated request id. The trap is that its field name (`id`) reads
like a primary identity and it is not one; see **archive id** and **identity tier**.
[`MESSAGE_IDENTIFIERS.md`](MESSAGE_IDENTIFIERS.md) §1;
`packages/fluux-sdk/src/utils/messageCache.ts`.

### no-local-store

A message that must never be written to IndexedDB. Only two things set it: Quick Chat room messages
(`packages/fluux-sdk/src/stores/roomStore.ts`) and transient MUC nick-change notices
(`packages/fluux-sdk/src/core/modules/MUC.ts`). It is why **transient unread**
exists: such a message can be unread while having no durable row to count.

The field's own doc comment also claims MUC whispers — it is stale, and whispers are in fact stored
and indexed like ordinary messages.

Not the same thing as the XEP-0334 `<no-store>` wire hint, which asks the *server* not to archive
and is set at the send site. `noLocalStore` is a purely local opt-out.

**Standard notion:** ephemeral, or non-persisted. `noLocalStore` is the field;
`packages/fluux-sdk/src/core/types/message-internal.ts`.

### occupant / occupant-id

An **occupant** is someone present in a MUC room (XEP-0045), addressed by nick. An **occupant-id**
(XEP-0421) is a stable per-room pseudonymous identifier for semi-anonymous MUCs — which is why
retraction authorship prefers it: a nick can be reassigned after its owner leaves, an occupant-id
cannot.

**Standard notion:** participant; and a stable per-room pseudonymous user id.
`packages/fluux-sdk/src/core/types/room.ts` (`RoomOccupant`).

### origin id

XEP-0359 `<origin-id>`: an id the *sender* puts on a stanza so it can recognise the echo of its own
message before an archive id exists. Stable and sender-assigned: a room-scoped origin id is a
legitimate cache identity tier when no stanza id exists, but an origin-id match alone must never
attach an archive id to a read pointer.

**Standard notion:** an idempotency key or client-side correlation id.
[`MESSAGE_IDENTIFIERS.md`](MESSAGE_IDENTIFIERS.md).

### parked

Of the divider: once established, left there rather than following the reader. Scrolling past it
advances the read pointer but does not move the line.

**Standard notion:** no common name; the behaviour ("the unread line stays where the conversation
opened") is standard in chat clients but rarely named.
`packages/fluux-sdk/src/stores/shared/dividerAdvance.ts`.

### pending retraction

A retraction (XEP-0424) whose target message is not currently in memory. It is recorded and replayed
the moment the target loads, so the tombstone lands late rather than never. Capped per conversation,
since a retraction for a message never fetched would otherwise accumulate forever.

**Standard notion:** a deferred or queued operation awaiting its subject; an out-of-order-delivery
buffer. `packages/fluux-sdk/src/stores/shared/pendingRetractions.ts`.

### phase ⚠ overloaded

1. **Positioning phase** — where one position request has got to: `resolving`, `loading-around`,
   `mounting`, `reconciling`, `position-applied`, `settled`, and so on. `position-applied` means the
   first write happened, not that layout has settled.
   `apps/fluux/src/components/conversation/scrollPositionModel.ts` (`PositioningPhase`);
   [the positioning contract](2026-07-23-scroll-positioning-contract.md).
2. **Catch-up phase** — Phase A aligns history to live; Phase B grows it backward to the remote read
   pointer. `packages/fluux-sdk/src/core/modules/MAM.ts` (`runCatchUpHistory`).

**Standard notion:** sense 1 is a request state-machine state; sense 2 is a stage of a sync
algorithm.

### preview ⚠ overloaded

1. **Conversation preview** — the last-message snippet shown in the sidebar, refreshed by a fast,
   shallow query ahead of full catch-up. [`MAM_CATCHUP.md`](MAM_CATCHUP.md) §1.
2. **Link preview / `LinkPreview`** — Open Graph metadata rendered as a rich card for a URL in a
   message. `packages/fluux-sdk/src/core/types/media.ts` (`LinkPreview`).

**Standard notion:** sense 1 is a conversation snippet; sense 2 is a rich link card or URL unfurl.

### provisional ⚠ overloaded

Three senses, all meaning "not confirmed", but confirmed by different things:

1. **Provisional entry request** — the one position request chosen when a conversation is opened,
   which any explicit navigation supersedes.
   `apps/fluux/src/components/conversation/entryArbitration.ts`.
2. **Provisional divider** — the divider position derived from the local read pointer while a
   recount is still pending; rendered muted.
   `apps/fluux/src/components/conversation/NewMessageMarker.tsx`.
3. **Provisionally stored / counted** — a message written or counted before its durable state is
   known, such as an undecryptable placeholder.
   `packages/fluux-sdk/src/core/e2ee/deferredDecrypt.ts`.

Say which. **Standard notion:** optimistic, or tentative.

### Quick Chat

A Fluux feature: a transient, human-slug-named MUC room for an ad-hoc conversation. Fluux treats
these rooms as non-archived — it marks their messages **no-local-store** and skips their MAM and
cache paths explicitly. That is a client policy, not a protocol guarantee: ordinary groupchat sends
carry no XEP-0334 `<no-store>` hint, and configuring a room as non-persistent governs the room's
lifetime rather than server-side archival.

**Standard notion:** app-specific. `packages/fluux-sdk/src/core/wordlist.ts`,
`packages/fluux-sdk/src/core/jid.ts` (`isQuickChatJid`).

### read pointer

Where the user has read to, as one object written atomically: an **order** (the only comparable
data) and an **identity** (what the position is called, locally and on the wire). It replaces the
`lastSeenMessageId` + `lastReadAt` pair, which were two fields describing one fact and drifted apart
(#1081). Paths using `advance` move it only forward; `markReadToNewest` instead replaces it directly
with the resident tail, which can move it backward when the window has slid into older history.

**Standard notion:** a read cursor, or last-read watermark. Bundling order and name into one
non-splittable value is the unusual part.
`packages/fluux-sdk/src/stores/shared/readPointer.ts`;
`packages/fluux-sdk/src/stores/chatStore.ts`, `.../roomStore.ts` (`markReadToNewest`).

### reflection

A MUC service echoing your own message back to the room, including you. It is the first opportunity
for an own send to carry the room archive's id; when the service stamps one, a pointer minted from
the reflection is addressable without a lookup, otherwise it remains local.

**Standard notion:** server echo, or loopback. `packages/fluux-sdk/src/core/mdsSideEffects.ts`.

### resident / resident window

The messages currently held in memory for one conversation — capped (5000 in production) and slid as
the user pages through history. For ordinary durable, archive-backed messages, rows outside this
window can live in IndexedDB or on the server. Quick Chat messages are `noLocalStore`, skip MAM, and
may be trimmed without a durable copy. "Not resident" is otherwise a routine state, not an error: a
retraction target, a positioning target, or a read pointer's message may be absent from the window.

**Standard notion:** an in-memory working set, or a virtualized data window; the cap plus the
sliding is a sliding window.

**Naming:** *resident window*, *resident slice*, *loaded window* and *loaded slice* all appear and
mean the same thing. Prefer **resident window** for the bound and **resident slice** for the
messages in it. `packages/fluux-sdk/src/stores/shared/residentWindow.ts`;
`packages/fluux-sdk/src/stores/roomStore.ts` (`addMessage`).

### seam

The boundary between two regions of held history that provably do not connect. Recorded when it is
formed, because a boundary that is not recorded at formation cannot be recovered later — timestamps
alone can never prove one.

**Standard notion:** a discontinuity or boundary in a partially-replicated range.
`packages/fluux-sdk/src/core/modules/MAM.ts`.

### side effect / side-effect host

Not React's `useEffect`. An SDK **side effect** is a subscriber that reacts to store or client events
by calling protocol methods — for example fetching a room's archive when the user opens it. The
**side-effect host** is one shared restricted client surface, with protocol capabilities grouped
into subinterfaces. Individual setup functions accept the full `SideEffectHost`, so their
per-concern blast radius is not expressed by separate signatures.

**Standard notion:** an effect handler or reactor; the host is an interface-segregation port.
`packages/fluux-sdk/src/core/sideEffectHost.ts`,
`packages/fluux-sdk/src/core/roomSideEffects.ts`.

### stanza id

See **archive id**. `stanzaId` is the field name; "archive id" is the concept. In discussion, prefer
**archive id** — it says what the value is for, and avoids being read as "the id of the stanza",
which is what `id` is.

### stitch (read-pointer stitch)

Phase B of catch-up: paging backward from the bottom of the fetched window until the message the
remote read pointer names is found, so the unread count can be derived rather than guessed. Runs for
background entities only — pulling pages into the *active* conversation's window would evict its live
edge. It seeds from a recorded gap's `endId`, then a `CoverageRecord`, or, when neither exists and
coverage is not explicitly unproven, the first archive id from `probeCacheBottom()`, falling back to
`oldestMessageWithStanzaId(messages)` from the resident slice. These are walk seeds; arbitrary
cached overlap alone cannot prove or extend coverage.

**Standard notion:** backfilling until a known checkpoint is reached.
`packages/fluux-sdk/src/core/modules/MAM.ts`.

### storage scope

The bare JID used to namespace account-specific message, search, and count persistence. It is not a
universal storage suffix: avatar caches and device/application preferences remain global, and a key
built before a scope is available retains its base name for compatibility.

**Standard notion:** a namespace or partition key; multi-tenancy by key prefix.
`packages/fluux-sdk/src/utils/storageScope.ts`; `packages/fluux-sdk/src/utils/avatarCache.ts`;
`packages/fluux-sdk/src/stores/connectionStore.ts`.

### supersede

A newer request replacing an older one that has not finished. Governed by generation order *plus*
source precedence — a newer generation alone does not bypass the guards. An outgoing send is the
deliberate exception that may supersede an in-flight navigation, because sending is reader intent.

**Standard notion:** preemption, or last-write-wins with a fencing token.
[the positioning contract](2026-07-23-scroll-positioning-contract.md).

### takeover (user takeover)

The reader grabbing the scrollbar while automatic positioning is running. It cancels the current
reconciliation immediately, and it closes the window in which late remote read state may still
reposition the view. Deliberately distinguished from a scroll event the code itself caused.

**Standard notion:** breaking autoscroll, or a user-scroll interrupt.
`apps/fluux/src/components/conversation/scrollPositionModel.ts`
(`cancelReconciliationForUserInput`); the evidence that an input was genuine is held by
`apps/fluux/src/components/conversation/viewportSession.ts` (`genuineUserScroll`).

### tombstone

What a retracted message becomes: the row stays, with `isRetracted` set, and renders as "message
deleted" rather than disappearing. It is one of the states in which a message with an empty body is
still renderable.

**Standard notion:** standard — a tombstone is the usual name for a deletion marker that must
outlive the deleted record. `packages/fluux-sdk/src/utils/messageRenderability.ts`.

### transient unread

Unread messages that have no durable IndexedDB row — permanently for `noLocalStore` messages, and
temporarily while a write is pending or has failed. Unread is otherwise derived from the archive, so
without this in-memory overlay those messages would be silently uncounted.

**Standard notion:** an in-memory overlay over a persisted derivation; a write-behind buffer that is
also read-visible. `packages/fluux-sdk/src/stores/shared/transientUnread.ts`.

### walk

One multi-page traversal of a server archive in a single direction. "The walk's extent" is the
oldest message it carried that can anchor durable coverage: it must have an archive id and be eligible
for local storage. "A completed walk" means the server reported the direction exhausted; an
incomplete forward walk certifies no live-edge coverage, while an id-exact backward page can extend
existing coverage.

**Standard notion:** a paginated scan, or a cursor walk.
`packages/fluux-sdk/src/utils/mamCatchUpUtils.ts` (`walkExtentBottomId`).

### watermark

The highest accepted generation, retained after a request settles or is cancelled so a stale
callback cannot revive dead work. Distinct from `historyFloor`, which is also sometimes called a
watermark but is a timestamp, not a counter (see **floor**).

**Standard notion:** standard — a high-water mark.
`apps/fluux/src/components/conversation/scrollPositionModel.ts` (`PositioningModel.watermark`).

### whisper

A private message sent to one occupant inside a MUC room (XEP-0045 §7.5). Fluux sends whispers with
the XEP-0334 `<no-store>` hint; the incoming handler does not require it, so whispers sent by another
client may still be archived. Whisper operations prefer the origin id as their reference and fall
back to the client/message id for legacy or incomplete rows.

**Standard notion:** a DM inside a channel. "Whisper" is the term IRC and Twitch use; XMPP calls it a
MUC private message. `packages/fluux-sdk/src/core/types/room.ts`;
`packages/fluux-sdk/src/core/modules/Chat.ts` (`resolveWhisperRouting`).

---

## Terms with no name

Two concepts are used and have no term. They are recorded here rather than named, because inventing a
name in a glossary is how a private vocabulary starts.

- **The two read comparators.** `isAfterBoundary` answers "is this row after the read boundary?" (the
  counting question) and `mayAdvanceTo` answers "may the pointer advance to this?" (the seen
  question). Their floor rules are *exact inverses*: a floor boundary counts everything in its
  millisecond as after it, while a floor on either side of an advance never overtakes within a
  millisecond. Both directions err the recoverable way — over-counting clears when the user reads;
  a position given away is gone. There is no collective name for the pair; say which one you mean.
  `packages/fluux-sdk/src/stores/shared/readState.ts`.
- **The transition classes of a coverage record.** `created`, `deepened`, `topRefreshed` and
  `replaced` are named individually, but the property that matters — that every one except `replaced`
  errs shallow and costs only a re-walk, while `replaced` is the only one that can leave disk
  asserting coverage that does not exist — has no name.
  `packages/fluux-sdk/src/stores/shared/mamCoverage.ts` (`CoverageTransition`).
