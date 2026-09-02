# Message Identifiers

Which identifiers a message carries, which one is authoritative, and why they are not
interchangeable. Read this before comparing two messages, pairing a retraction, resolving a read
position, or indexing.

Every claim below points at the file that implements it. Where the repository does not exercise a
part of XEP-0359 or XEP-0313, this document says so instead of restating the specification.

## 1. The three identifiers

`BaseMessage` declares them, each documented separately —
`packages/fluux-sdk/src/core/types/message-base.ts:99-104`:

| Field | Assigned by | What it is good for |
| --- | --- | --- |
| `id` | the client that composed the stanza | A local name. Nothing guarantees it is unique beyond its own sending stream. |
| `stanzaId` | the archive (XEP-0359 `<stanza-id>`) | The invariant identifier — **scoped to the archive that stamped it**. |
| `originId` | the sender (XEP-0359 `<origin-id>`) | Recognising the echo of one's own message before an archive id exists. |

`originId` is written on every outgoing stanza through `createOriginIdElement`
(`packages/fluux-sdk/src/core/modules/messagingUtils.ts:292`), and read back with `parseOriginId`
(same file, `:282`).

There is a fourth source of an archive id: the `<result id="…">` wrapper of a MAM page. The SDK
prefers the message's own `<stanza-id>` and falls back to the wrapper id —
`packages/fluux-sdk/src/core/modules/MAM.ts:2313` and `:2402`.

## 2. `stanzaId` is authoritative only relative to an archive

A single message can carry several `<stanza-id>` elements, one per archiving entity it passed
through (the user's own server *and* a MUC service). They are different values naming the same
message in different archives, and they are **not interchangeable**: using the wrong one as a MAM
RSM cursor makes the server answer `item-not-found`. `parseStanzaId` therefore selects by the `by`
attribute, compared on a bare-JID basis —
`packages/fluux-sdk/src/core/modules/messagingUtils.ts:239-276`.

The expected archive is fixed per conversation kind by the call sites:

- 1:1 chat → the user's own bare JID (`core/modules/MAM.ts:2297`, `core/modules/Chat.ts:2143`)
- MUC → the room's bare JID (`core/modules/MAM.ts:2383`, `core/modules/Chat.ts:2227`)

**The fallback matters to callers.** When `expectedBy` is omitted, or when no `<stanza-id>` matches
it, `parseStanzaId` returns the *first* id present — commented as preserved single-archive
behaviour (`messagingUtils.ts:269`). So a `stanzaId` obtained without an `expectedBy` may belong to
an archive you are not querying. It is still a usable dedup key against other copies of the same
message, but it is not a safe pagination cursor and not a safe cross-client reference. If the id
must address an archive, pass `expectedBy`.

An archive id can also be *revoked* after the fact: when an `after:`-anchored query hits
`item-not-found`, the stale id is stripped from the message and from the persisted gap anchor,
keeping the timestamp so catch-up can resume by time — `stores/chatStore.ts:2588-2602` and
`:3414-3418`, `stores/roomStore.ts:2527-2547` and `:4472-4478`. Treat a stored archive id as
revocable, not permanent.

## 3. Canonical identity is a tiered ladder, not a single field

One logical message arrives as several stanzas — optimistic echo, MUC reflection, MAM copy — with
no single stable field across all three. The message-identity boundary in
`packages/fluux-sdk/src/utils/messageIdentity.ts` defines the ladder used by resident-window
deduplication, caches, reference lookups, retractions and search. The order, most-specific first:

1. `stanzaId`
2. `originId`
3. `from` + `id`

Two copies are the same logical message **iff they share a tier and do not carry conflicting
XEP-0421 occupant ids** (`sameLogicalMessage`). The canonical key is the highest tier present
(`canonicalKey`). For room messages on tier 3 only, a known occupant id also qualifies the durable
canonical key, while the searchable `identityKeys` strings remain unchanged. Tier 3 exists because
legacy senders and bridges emit neither XEP-0359 element —
without it those messages would have no identity at all. An absent occupant id does not separate
copies; two present, different occupant ids do, even when a nick and client id were reused.

The occupant-qualified fallback key is forward-looking. Existing cache rows keep their previous
keys, no migration can recover content already overwritten by an old collision, and legacy rows
without enough occupant evidence remain ambiguous. When two new fallback rows have conflicting
known occupant ids, both survive independently; this can expose a duplicate message, but neither
body nor retraction state is destructively inherited by the other row.

Every room tier key is **scoped by room JID** (`scoped`, same file). `stanzaId` and `originId` are
assigned per archive and can repeat across rooms, while the `identityKeys` index spans the whole
store; an unscoped key would let the finder merge messages from different rooms. The room cache
carries the same rule: no unscoped `stanzaId`/`originId` index exists, and every such lookup goes
through the room-scoped alias — `packages/fluux-sdk/src/utils/messageCache.ts:202-210`.

The same boundary derives the equivalent unscoped keys for 1:1 chats. Scope is an explicit
parameter rather than a second ladder implementation.

Reference resolution has two named policies over this one ladder. `archive-first` ranks an
explicit XEP-0359 `originId` above the bare client id, while `client-id-first` tries the real id and
stanza-id matches before the sender-controlled, spoofable `originId`. Callers must choose a policy
explicitly; there is no default.

The full ladder also resolves a retraction target at the cache and search-index boundary —
`packages/fluux-sdk/src/stores/shared/retractionStorage.ts`. `canonicalReference` chooses the
highest known tier only for that durable target expansion, so every stored copy the retract
reference names can be found. It does **not** choose the outgoing wire reference: outgoing
retractions use `archiveReference`, the archive id when present and the client id otherwise,
preserving the existing protocol behaviour. A received `<retract id="…">` names one tier chosen by
whatever the retracting client knew, so it has to be tried against the whole ladder; and the
retracted identity is remembered for the session
(`utils/retractedIdentities.ts`) because a target whose own cache write has not landed yet has
no row to tombstone.

## 4. A row is not a message

The ladder above answers "which logical MESSAGE is this?". A second question — "which rendered ROW
is this?" — has a different answer, and conflating them is what a reused MUC nick exposes.

XEP-0421 lets a room reassign a nick once its owner leaves. Two occupants can then produce rows
sharing a room, a `from` and a client id, and only the occupant-id separates them. Anything that
points AT A ROW must therefore carry both halves:

- a saved scroll anchor and the load-around request that restores it,
- the new-message divider,
- the viewport report that advances the read pointer, and the pointer itself.

`MessageRowRef` (`utils/messageIdentity.ts`) is that currency: a client `id` plus the optional
occupant-id. It is deliberately **not** a wire reference. Its `id` is always the row's own client
id — read off a rendered row, or off a pointer's local name — never a stanza-id or an origin-id, so
resolving one (`findMessageRowIndex`) walks no tier ladder and takes no `ResolutionPolicy`.
Admitting stanza-id matches there would let a read pointer advance onto a message no viewport ever
reported.

Two selection rules coexist, and they are not interchangeable:

- `selectOccupantRow` answers "which of these rows is meant?". A ref naming no occupant takes the
  first candidate — it supplied no evidence, and answering "not found" would strand every pointer
  and divider written before occupant-ids were carried.
- `mergeableOccupantCandidates` answers "may these be MERGED into one message?". There an
  occupant-less copy facing two disagreeing occupants must merge with neither, because it would
  bridge them. The durable cache uses this one, because its lookups feed writes that fold rows
  together.

Cross-device publication is stricter than local selection. When a read pointer names an occupant,
the XEP-0490 publisher requires the resolved resident, preview or cached row to carry that exact
occupant-id before publishing its stanza-id. An occupant-less fallback remains unresolved for a
later retry: a delayed forward-only position is recoverable, while a wrong one is not —
`packages/fluux-sdk/src/core/mdsSideEffects.ts:73-78`.

In the DOM the ref is encoded as a row handle on `data-message-row-id`
(`apps/fluux/src/components/conversation/messageRowIdentity.ts`), which is injective over every
possible client id. `messageRowRefFromRowId` decodes it back before it crosses into the SDK.

## 5. Why rooms and 1:1 conversations differ

The cache stores them under different primary keys:

- chat messages: `keyPath: 'id'` — the **client** id (`utils/messageCache.ts:181`)
- room messages: `keyPath: 'cacheKey'` — the **canonical identity key** above
  (`utils/messageCache.ts:202`)

`CacheOrderKey` (`packages/fluux-sdk/src/core/types/readState.ts:14-33`) is discriminated by kind
for the same reason, and states why an archive id could never serve here: XEP-0313 §6.2 makes
archive ids opaque, unique only per archive, with no ordering. Chat breaks same-millisecond ties by
`id` alone; room breaks them by `from` then `id`, matching the `room_ts_from_id` index. Chat
messages also carry `from`, so a single "from then id" comparator would be wrong for chat — hence
the discriminant. Do not generalise the two shapes into one.

Protocol references follow the same split. `getMessageReferenceId`
(`packages/fluux-sdk/src/core/modules/Chat.ts:1873-1880`) returns the `stanzaId` for a groupchat
message when one is known, and the message id otherwise — per XEP-0461, only groupchat references
use a stanza-id. Retractions (`Chat.ts:1417`), reactions (`Chat.ts:1177`) and replies
(`Chat.ts:867`) all use this archive-first wire rule. MUC whispers are the exception: they are
`<no-store>`, so the reference is the `originId` (`Chat.ts:1865`).

On the receiving side, an incoming reference is resolved by `id`/`stanzaId` first and only then by
`originId` — `stores/chatStore.ts:2457` and `:2518`.

## 6. When the archive id is missing

A read position names itself through `PointerIdentity`
(`packages/fluux-sdk/src/core/types/readState.ts:92-133`), a two-state discriminated union:

- **`addressable`** — the named message carried an archive id when the pointer was minted.
  Publishable as-is.
- **`local`** — no archive id. Explicitly degraded, not degraded by omission.

`makeReadPointer` (`packages/fluux-sdk/src/stores/shared/readPointer.ts:160-180`) mints
`addressable` exactly when `message.stanzaId` is present: every peer message and every MUC
reflection converges for free. `local` arises for a message whose archive id has not arrived yet —
and, for the user's own 1:1 sends, may never arrive: the server does not echo them back, so their
only id is the client-generated `origin-id`, which is not publishable (`readState.ts:103-109`).

What a caller should do with a missing archive id:

- **Do not fabricate one.** No model can conjure it; the type is what forces the branch to be
  handled.
- **Keep using the lower tiers.** Dedup, cache lookups and local rendering work on
  `originId`/`from`+`id` (§3).
- **Wait for convergence, bound by identity.** `withArchiveId`
  (`stores/shared/readPointer.ts:200-235`) attaches a later-known archive id to a `local` pointer.
  It touches the name only, never the order; the caller must bind by identity, never by timestamp
  or by an `origin-id` two rows share; and a `floor` pointer is never enriched.
- **Fall back on order, not on name.** `PointerOrder`
  (`core/types/readState.ts:35-90`) separates an exact position from a `floor` — "at least here" —
  and comparators answer the two differently on purpose.

## 7. Do not

- **Do not treat a client `id` as an identity.** It is a name in one stream. It is the chat cache's
  primary key (`messageCache.ts:181`) and the lowest identity tier only in combination with `from`
  (`messageIdentity.ts`).
- **Do not name a row with a client id alone.** After a nick reassignment it names two of them, and
  a bare-id lookup silently takes the first. Scroll anchors, the divider, the viewport report and
  the read pointer all speak `MessageRowRef` (§4).
- **Do not compare archive ids from different archives.** A message can carry several
  `<stanza-id>`; only the one stamped `by` the archive you are addressing is meaningful there
  (`messagingUtils.ts:239-276`). Comparing across archives, or across rooms, is what the room
  scoping exists to prevent (`messageIdentity.ts`, `messageCache.ts:202-210`).
- **Do not read stability as identity.** `originId` is stable and sender-assigned, which makes it a
  good echo-dedup key — but two rows can share one, which is why `withArchiveId` forbids binding
  through it (`readPointer.ts:200-235`) and why references resolve it last
  (`chatStore.ts:2457`, `:2518`).
- **Do not assume an archive id, once seen, is permanent.** It can be revoked when the archive
  purges it (`chatStore.ts:2588-2602`, `roomStore.ts:2527-2547`).
- **Do not use an archive id for ordering.** It carries none (`core/types/readState.ts:14-33`).

## Related

- `docs/MAM_CATCHUP.md` — how archive ids and timestamps anchor catch-up and pagination.
