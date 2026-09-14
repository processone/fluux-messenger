# Message Identifiers

Which identifiers a message carries, which one is authoritative, and why they are not
interchangeable. Read this before comparing two messages, pairing a retraction, resolving a read
position, or indexing.

Every claim below points at the file that implements it. Where the repository does not exercise a
part of XEP-0359 or XEP-0313, this document says so instead of restating the specification.

## 1. The three identifiers

`BaseMessage` declares them, each documented separately —
`packages/fluux-sdk/src/core/types/message-base.ts`:

| Field | Assigned by | What it is good for |
| --- | --- | --- |
| `id` | the client that composed the stanza | A local name. Nothing guarantees it is unique beyond its own sending stream. |
| `stanzaId` | the archive (XEP-0359 `<stanza-id>`) | The invariant identifier — **scoped to the archive that stamped it**. |
| `originId` | the sender (XEP-0359 `<origin-id>`) | Recognising the echo of one's own message before an archive id exists. |

`originId` is written on every outgoing stanza through `createOriginIdElement`
(`packages/fluux-sdk/src/core/modules/messagingUtils.ts`), and read back with `parseOriginId`
in the same file.

There is a fourth source of an archive id: the `<result id="…">` wrapper of a MAM page. Archive
selection follows §2 before falling back to the wrapper id —
`parseArchiveMessage` and `parseRoomArchiveMessage` in `packages/fluux-sdk/src/core/modules/MAM.ts`.

## 2. `stanzaId` is authoritative only relative to an archive

A single message can carry several `<stanza-id>` elements, one per archiving entity it passed
through (the user's own server *and* a MUC service). They are different values naming the same
message in different archives, and they are **not interchangeable**: using the wrong one as a MAM
RSM cursor makes the server answer `item-not-found`. `parseStanzaId` therefore selects by the `by`
attribute, compared on a bare-JID basis —
`packages/fluux-sdk/src/core/modules/messagingUtils.ts`.

The expected archive is fixed per conversation kind by the call sites in `parseMessageContent`:

- 1:1 chat → the user's own bare JID, using `parseStanzaId`
- MUC → the room's bare JID, using the strict `parseArchiveStanzaId`, then the room MAM wrapper ID

**The fallback matters to callers.** When `expectedBy` is omitted, or when no `<stanza-id>` matches
it, `parseStanzaId` returns the *first* id present — commented as preserved single-archive
behaviour (`parseStanzaId` in `messagingUtils.ts`). So a `stanzaId` obtained via this fallback may belong to
an archive you are not querying. It is still a usable dedup key against other copies of the same
message, but it is not a safe pagination cursor and not a safe cross-client reference. If the id
must address an archive, use `parseArchiveStanzaId(messageEl, expectedBy)`: it returns only an ID
stamped by that archive. Correction revision identity uses this strict lookup, falling back to
the MAM wrapper's result ID when available. A legacy fallback alias can remain usable as a
reference without becoming authoritative revision identity.

Room parsing does not use that foreign-archive fallback. A confirmed room row carries
`stanzaIdAuthority`, bound to its exact ID, room, author and account.
`getRoomModerationId(message)` in `packages/fluux-sdk/src/utils/roomStanzaId.ts` checks this proof
against the current account before returning a moderator target. The low-level
`rooms.moderateMessage` API expects its caller to supply an authoritative room ID.

Legacy cached messages without this proof remain available for display, replies and self-retraction,
but not moderator removal. Normal live or archive loading can confirm the same occurrence only
with matching client ID, stable occupant ID, timestamp, and original content or a previously
validated local alias. A reused client ID alone never confirms a row. Confirmation preserves
correction chronology and retains a `localRowRef` for saved navigation and order; that alias is
excluded from wire-reference indexes and retraction targets. Proof survives cache reloads, while
uncertain collisions remain separate without a migration or history request for verification.
The implementation is `roomStanzaIdsMergeable`/`mergeRoomStanzaId`; cache regression coverage is in
`packages/fluux-sdk/src/utils/messageCache.corrections.test.ts` and
`packages/fluux-sdk/src/utils/messageCache.test.ts`.

An archive id can also be *revoked* after the fact: when an `after:`-anchored query hits
`item-not-found`, the stale id is stripped from the message and from the persisted gap anchor,
keeping the timestamp so catch-up can resume by time. The `chat:history-anchor-purged` and
`room:history-anchor-purged` bindings in `packages/fluux-sdk/src/bindings/storeBindings.ts` route
this cleanup to the stores. Treat a stored archive id as revocable, not permanent.

## 3. Canonical identity is a tiered ladder, not a single field

One logical message arrives as several stanzas — optimistic echo, MUC reflection, MAM copy — with
no single stable field across all three. The message-identity boundary in
`packages/fluux-sdk/src/utils/messageIdentity.ts` defines the ladder used by resident-window
deduplication, caches, reference lookups, retractions and search. The order, most-specific first:

1. `stanzaId`
2. `originId`
3. `from` + `id`

Two copies are candidate logical matches when they share a tier and do not carry conflicting
XEP-0421 occupant ids (`sameLogicalMessage`). At the non-unique `from` + `id` rung, the chat
cache and retraction ledger also reject copies whose known `stanzaId` or `originId` values disagree
(`archiveIdentityConflict`): a disagreement is evidence that they are different messages, while a
missing id is not. Room merges additionally require the confirmation compatibility described in §2.
The canonical key is the highest tier present (`canonicalKey`). For room messages
on tier 3 only, a known occupant id also qualifies the durable canonical key, while the searchable
`identityKeys` strings remain unchanged. Tier 3 exists because legacy senders and bridges emit
neither XEP-0359 element —
without it those messages would have no identity at all. An absent occupant id does not separate
copies; two present, different occupant ids do, even when a nick and client id were reused.

The occupant-qualified fallback key is forward-looking. Existing cache rows are not rewritten en
masse; normal writes may rekey preserved collisions as described in §5. No migration can recover
content already overwritten by an old collision, and legacy rows
without enough occupant evidence remain ambiguous. When two new fallback rows have conflicting
known occupant ids, both survive independently; this can expose a duplicate message, but neither
body nor retraction state is destructively inherited by the other row.

Every room tier key is **scoped by room JID** (`scoped`, same file). `stanzaId` and `originId` are
assigned per archive and can repeat across rooms, while the `identityKeys` index spans the whole
store; an unscoped key would let the finder merge messages from different rooms. The room cache
carries the same rule: no unscoped `stanzaId`/`originId` index exists, and every such lookup goes
through the room-scoped alias — `packages/fluux-sdk/src/utils/messageCache.ts`.

The same boundary derives the equivalent unscoped keys for 1:1 chats. Scope is an explicit
parameter rather than a second ladder implementation.

Reference resolution has two named policies over this one ladder. `archive-first` ranks an
explicit XEP-0359 `originId` above the bare client id, while `client-id-first` tries the real id and
stanza-id matches before the sender-controlled, spoofable `originId`. Callers must choose a policy
explicitly; there is no default.

Correction stanza IDs form a reference-only tier immediately after the message's own stanza ID
under `archive-first`. The cache indexes these aliases for replies and retractions, including when
the target is absent from RAM. They never participate in canonical-row merging or change the
message's primary key. Lookups remain scoped to the conversation or room and mutations still
check the author and, for rooms, occupant identity. IndexedDB version 6 backfills correction
aliases into the existing identity index in the same atomic upgrade transaction as the older
canonical-store migrations. The alias backfill preserves existing canonical rows, primary keys
and aliases; normal reference lookups use indexes without scanning conversation history.

The full ladder also resolves a self-retraction target at the cache and search-index boundary —
`packages/fluux-sdk/src/stores/shared/retractionStorage.ts`. `canonicalReference` chooses the
highest known tier only for that durable target expansion, so every stored copy the retract
reference names can be found. It does **not** choose the outgoing wire reference: outgoing
retractions use `archiveReference`, the archive id when present and the client id otherwise,
preserving the existing protocol behaviour. A received self-retraction `<retract id="…">` names one tier chosen by
whatever the retracting client knew, so it has to be tried against the whole ladder; and the
retracted identity is remembered for the session
(`utils/retractedIdentities.ts`) because a target whose own cache write has not landed yet has
no row to tombstone.

Moderator retractions instead require the bare room service as actor and the confirmed room-assigned
target from §2 (`roomRetractionAuthorized`). Client-ID and local-row aliases cannot authorize them.
Validated moderator metadata is retained with the tombstone and pending retraction identity across
duplicate delivery and cache races; the display policy belongs to [Messaging](../README.md#messaging).

## 4. A row is not a message

The ladder above answers "which logical MESSAGE is this?". A second question — "which rendered ROW
is this?" — has a different answer, and conflating them is what a reused MUC nick exposes.

XEP-0421 lets a room reassign a nick once its owner leaves. Two occupants can then produce rows
sharing a room, a `from` and a client id, and only the occupant-id separates them. Anything that
points AT A ROW therefore starts with the row's client id and carries every available discriminator:

- a saved scroll anchor and the load-around request that restores it,
- the new-message divider,
- the viewport report that advances the read pointer, and the pointer itself.

`MessageRowRef` (`core/types/messageRow.ts`, re-exported by `utils/messageIdentity.ts`) is that currency: a client `id`, the optional
occupant-id, and the optional `stanzaId` supplied by the row. Room references also carry an
`unconfirmed` flag so uncertain cached IDs cannot collapse into confirmed rows with the same raw IDs. It is deliberately **not** a wire
reference. Its `id` is always the row's own client
id — read off a rendered row, or off a pointer's local name — never replaced by a stanza-id or an
origin-id. Resolving one (`findMessageRowIndex`) walks no tier ladder and takes no
`ResolutionPolicy`: a supplied archive discriminator must also match the candidate, and never
creates a match by itself. DOM handles carry that discriminator so distinct archive rows remain
separate even when one author reuses a client id. Older handles and references without an archive
discriminator retain their original selection rule. A display discriminator does not establish
authority to moderate the message. Read pointers persist the room confirmation flag with their local
identity. Older references without that flag still resolve through a validated local alias; explicit
confirmed and unconfirmed references stay distinct. Direct-chat row keys remain client IDs.

Two selection rules coexist, and they are not interchangeable:

- `selectOccupantRow` answers "which of these rows is meant?". A ref naming no occupant takes the
  first candidate — it supplied no evidence, and answering "not found" would strand every pointer
  and divider written before occupant-ids were carried.
- `mergeableOccupantCandidates` answers "may these be MERGED into one message?". There an
  occupant-less copy facing two disagreeing occupants must merge with neither, because it would
  bridge them. The durable cache uses this one, because its lookups feed writes that fold rows
  together.

Cross-device room publication requires confirmed archive identity for the current room and account.
A pointer minted from a confirmed row carries this `archiveScope` through persistence, so eviction
or cache unavailability cannot prevent publication. Older pointers without that proof resolve against
the combined set of resident rows, previews and indexed cache candidates using the exact timestamp, sender, client ID,
occupant and local row order. An occupant-less saved pointer must resolve to a unique occurrence across those sources. A failed cache read cannot establish uniqueness and leaves that pointer unresolved. A local name can resolve to a
confirmed archive name through its validated local alias; the saved pointer's order remains unchanged.
An older pointer without the final row-order component must still match that occurrence and identity.
Uncertain addressable pointers and local pointers without confirmation stay unresolved and retryable;
normal loading or a later verified read can resolve them without fetching history for verification.
Incoming room markers likewise require a confirmed owner, otherwise they remain pending. Direct-chat
publication keeps its existing lookup and fallback behavior.

In the DOM the ref is encoded as a row handle on `data-message-row-id`
(`apps/fluux/src/components/conversation/messageRowIdentity.ts`), which is injective over every
possible client id. Navigation accepts opaque strings for existing message-ID callers and
`MessageRowRef` objects for selected rows, including search results, quotations and poll banners.
The room target store preserves that distinction. The list encodes either target explicitly for
DOM and virtualizer positioning; `messageRowRefFromRowId` decodes only those presentation handles
before cache loading. Prefix-shaped client IDs are escaped at that boundary, never interpreted as
row identities by SDK or store callers.
Keyboard selection likewise keeps literal IDs by default and presentation handles only when
`getRowId` supplies one. Both selected-row scrolling and visible-row detection normalize literals
at the DOM boundary; Enter callbacks still receive real message IDs (`useMessageSelection.ts`).

## 5. Why rooms and 1:1 conversations differ

Both stores are keyed by a **canonical identity key**, never by a client id:

- chat messages: `keyPath: 'cacheKey'` — the canonical key qualified by
  `conversationId`, because chat identity keys are themselves unscoped (§3)
- room messages: `keyPath: 'cacheKey'` — the canonical key, already namespaced by room; an uncertain
  row colliding with a confirmed key is preserved under its qualified fallback key (§2)

A client id was the chat store's primary key until v5, and that is the shape of defect it
produces: a client that restarts and re-issues an id had its later message overwrite the
earlier one's row, then inherit its retraction tombstone. Both bodies were destroyed. Keying
alone was not enough — see `archiveIdentityConflict` in `messageIdentity.ts` for the second
half, at the `from+id` rung.

What still differs between the two is ORDER, not identity.

`CacheOrderKey` (`packages/fluux-sdk/src/core/types/readState.ts`) is discriminated by kind.
XEP-0313 §6.2 makes archive IDs opaque and unique only per archive; their values do not establish
server chronology. Chat breaks same-millisecond ties by
`id` alone; room breaks them by `from`, then `id`, the XEP-0421 occupant-id, and a final local row component. Chat
messages also carry `from`, so a single "from then id" comparator would be wrong for chat — hence
the discriminant. Do not generalise the two shapes into one.

The room key's third rung is §4's row/message split reaching the ORDER. `(from, id)` names a
message, not a row: a reassigned nick puts two occupants under one `from`, and a client id carries
no uniqueness guarantee, so two rows can share a millisecond, a `from` and an id. Without the
occupant they compare EQUAL, and a read pointer on one silently drops the other from the unread
count — the unrecoverable direction.

Three rules govern that rung, and each is load-bearing:

- **An absent occupant-id sorts first, and the direction is arbitrary; being TOTAL is not.** A rule
  that made an absent occupant compare equal to every present one would be intransitive, and
  `sortMessagesByTimestamp` hands the comparator to `Array.prototype.sort`, which answers an
  intransitive one with an arbitrary permutation of the resident array the viewport observer walks.
- **Where only one side names an occupant, the rung cannot decide**, and the two questions of §5's
  comparators answer that differently — the same asymmetry `floor` already has one rung up.
  `isAfterBoundary` counts the row to avoid hiding it. In the clearable direction, `mayAdvanceTo`
  reads the total order so a pointer holding no occupant-id may advance onto the row that names one
  and stop being ambiguous. In the opposite direction, a row holding no occupant-id cannot move a
  pointer that already names one backwards within the shared millisecond. The accepted limit needs
  three separate rows sharing that millisecond, sender JID and client id: one pre-change row without
  occupant identity and two rows with conflicting occupant ids, which keeps all three separate. The
  legacy row can then remain unread after the pointer names a qualified occupant. Even the two-row
  mixed form occurred zero times across 50,163 measured cached room rows; the wider same-room,
  same-millisecond superset had 11 pairs (0.02%), and the three-row form is narrower still. The limit
  ends for the legacy row once a new mint carrying occupant identity replaces its pre-change
  representation, because the pair is no longer mixed.
- **The occupant component is derived from stored identity.** A row stores its occupant-id
  (`StoredRoomMessage`) and a pointer stores its own (`PointerIdentity`). `room_ts_from_id`
  orders the unread cursor's walk; the full comparator decides which rows count.

**This is forward-looking, not a repair.** Rows and pointers written before the rung existed carry
no occupant identity and cannot acquire one, so a pair already ordered wrong stays ordered wrong.
Nothing recovers an occupant-id that was never stored.

The final room component is produced by `makeCacheOrderKey` from the row's archive discriminator
and confirmation state, conservatively treating absent confirmation as uncertain. The component
is absent when the reference has no archive ID. A validated `localRowRef` supplies these fields after
identity confirmation, so enrichment keeps the row in its established local order. Lexical comparison of this
component is only a deterministic local convention after all previous components tie; it never claims
that one opaque server ID was issued before another. Resident sorting, archive unread counting,
divider placement and pointer advancement use the same comparator. Direct-chat ordering is unchanged.

New pointers persist this component in `order.tiebreak.row` separately from their current reference
identity. Both JSON persistence paths retain it. Adding an archive name with `withArchiveId` preserves
the existing order object; serialization does not reconstruct order from an enriched identity.
The message cache needs no schema change or data rewrite: rows already contain the canonical or
validated local reference, and the indexed unread cursor rechecks every candidate against the full key.

Older pointers lacking `row` keep their saved timestamp, identity, and earlier tie-break components.
For rows sharing all those components, counting treats missing row evidence conservatively: every
matching row can remain unread, including the pointer's own row. An ordinary viewport read of a
uniquely matched confirmed row may refine this missing component while preserving the pointer's
identity and timestamp. An ambiguous old reference cannot refine it, and reading a different row in
that same tied group cannot infer a missing position. A read in a later millisecond, or beyond an
earlier established tie-break component, advances normally and clears the bounded overcount once
complete archive/transient derivation proves zero. Combining incomplete and complete saved pointers
within the tied group retains the conservative incomplete position. No pointer is dropped, no count
is globally reset, and no network read is used to obtain this evidence.

Room cache windows resolve their exact anchor first, retain it, and select neighbors in the same
local order. The `room_timestamp` index reads the anchor's entire timestamp group and completes
the groups at either requested window boundary before sorting and slicing. A large same-millisecond
group therefore costs a group read, but does not require scanning unrelated room history. An omitted
`after` retains the existing load-around contract of loading the remaining cached tail. Direct-chat
load-around behavior is unchanged.

Transient room unread entries carry the same occurrence and authority evidence as resident messages.
Shared aliases only locate candidates: distinct confirmed archive rows remain separate, and cache
commit or retraction removes only the validated matching entry. A failed write keeps its transient
contribution until a later valid read passes it. Live notification construction carries the complete
room message so pointers preserve both confirmation and validated local order.

Protocol references follow the same split. `getMessageReferenceId`
(`packages/fluux-sdk/src/core/modules/Chat.ts`) returns the `stanzaId` for a groupchat
message when one is known, and the message id otherwise — per XEP-0461, only groupchat references
use a stanza-id. `sendRetraction`, `sendReaction` and replies in `sendMessage` use this wire rule.
An explicitly selected room reply can supply `ReplyTarget.stanzaId`; see its API comment in
`core/types/chat.ts` for the precedence over lookup by client ID.
MUC whispers are the exception: they are `<no-store>`, so the reference is the `originId`
(see `resolveWhisperRouting`).

On the receiving side, callers select a reference-resolution policy from §3 according to the
operation's trust requirements.

## 6. When the archive id is missing

A read position names itself through `PointerIdentity`
(`packages/fluux-sdk/src/core/types/readState.ts`), a two-state discriminated union:

- **`addressable`** — the named message carried an archive id when the pointer was minted.
  Direct-chat pointers are publishable as-is; room pointers also require confirmed room/account scope.
- **`local`** — no archive id. Explicitly degraded, not degraded by omission.

`makeReadPointer` (`packages/fluux-sdk/src/stores/shared/readPointer.ts`) mints
`addressable` exactly when `message.stanzaId` is present; room publication follows §4's confirmation
rules. `local` arises for a message whose archive id has not arrived yet —
and, for the user's own 1:1 sends, may never arrive: the server does not echo them back, so their
only id is the client-generated `origin-id`, which is not publishable (`mdsSideEffects.ts`).

What a caller should do with a missing archive id:

- **Do not fabricate one.** No model can conjure it; the type is what forces the branch to be
  handled.
- **Keep using the lower tiers.** Dedup, cache lookups and local rendering work on
  `originId`/`from`+`id` (§3).
- **Wait for convergence, bound by identity.** `withArchiveId`
  (`stores/shared/readPointer.ts`) attaches a later-known archive id to a `local` pointer.
  It touches the name only, never the order; the caller must bind by identity, never by timestamp
  or by an `origin-id` two rows share; and a `floor` pointer is never enriched.
- **Fall back on order, not on name.** `PointerOrder`
  (`core/types/readState.ts`) separates an exact position from a `floor` — "at least here" —
  and comparators answer the two differently on purpose.

## 7. Do not

- **Do not treat a client `id` as an identity.** It is a name in one stream, reusable across a
  restart, and the lowest identity tier only in combination with `from` (`messageIdentity.ts`).
  **No durable message-cache row may key on it** — that is what the v5 chat migration exists to
  undo (§5).
- **Do not name a row with a client id alone.** After a nick reassignment it names two of them, and
  a bare-id lookup silently takes the first. Scroll anchors, the divider, the viewport report and
  the read pointer all speak `MessageRowRef` (§4).
- **Do not compare archive ids from different archives.** A message can carry several
  `<stanza-id>`; only the one stamped `by` the archive you are addressing is meaningful there
  (`messagingUtils.ts`). Comparing across archives, or across rooms, is what the room
  scoping exists to prevent (`messageIdentity.ts`, `messageCache.ts`).
- **Do not establish identity from a clock alone.** Archive or occupant disagreement separates
  occurrences. Timestamp equality only corroborates the other evidence required for legacy room
  confirmation (§2); missing proof can keep uncertain rows separate.
- **Do not read stability as identity.** `originId` is stable and sender-assigned, which makes it a
  good echo-dedup key — but two rows can share one, which is why `withArchiveId` forbids binding
  through it (`readPointer.ts`). Reference lookup follows the explicit policies in §3.
- **Do not assume an archive id, once seen, is permanent.** It can be revoked when the archive
  purges it (see §2).
- **Do not infer server chronology from an archive id.** The final row component in §5 establishes
  a deterministic local tie-break only, not the order in which the archive issued its IDs.

## Related

- `docs/MAM_CATCHUP.md` — how archive ids and timestamps anchor catch-up and pagination.
