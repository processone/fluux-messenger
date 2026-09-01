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
keeping the timestamp so catch-up can resume by time — `stores/chatStore.ts:2507` and `:501`,
`stores/roomStore.ts:2413` and `:1144`. Treat a stored archive id as revocable, not permanent.

## 3. Canonical identity is a tiered ladder, not a single field

One logical message arrives as several stanzas — optimistic echo, MUC reflection, MAM copy — with
no single stable field across all three. `packages/fluux-sdk/src/utils/roomMessageIdentity.ts`
defines the one identity used by both the resident-window dedup and the cache. The order,
most-specific first:

1. `stanzaId`
2. `originId`
3. `from` + `id`

Two copies are the same logical message **iff they share any one of these keys**
(`roomIdentityKeys`, same file). The canonical key is simply the highest tier present
(`roomCanonicalKey`). Tier 3 exists because legacy senders and bridges emit neither XEP-0359
element — without it those messages would have no identity at all.

Every room tier key is **scoped by room JID** (`scoped`, same file). `stanzaId` and `originId` are
assigned per archive and can repeat across rooms, while the `identityKeys` index spans the whole
store; an unscoped key would let the finder merge messages from different rooms. The room cache
carries the same rule: no unscoped `stanzaId`/`originId` index exists, and every such lookup goes
through the room-scoped alias — `packages/fluux-sdk/src/utils/messageCache.ts:197-205`.

The 1:1 side has the equivalent three tiers, unscoped, in `chatIdentityKeys`
(`packages/fluux-sdk/src/utils/chatMessageIdentity.ts`), which `chatStore`'s
`getChatMessageKeys` delegates to.

Both ladders are also what a retraction is resolved through at the cache and search-index
boundary — `packages/fluux-sdk/src/stores/shared/retractionStorage.ts`. A `<retract id="…">`
names ONE tier, chosen by whatever the retracting client knew, so it has to be tried against
the whole ladder; and the retracted identity is remembered for the session
(`utils/retractedIdentities.ts`) because a target whose own cache write has not landed yet has
no row to tombstone.

## 4. Why rooms and 1:1 conversations differ

The cache stores them under different primary keys:

- chat messages: `keyPath: 'id'` — the **client** id (`utils/messageCache.ts:176`)
- room messages: `keyPath: 'cacheKey'` — the **canonical identity key** above
  (`utils/messageCache.ts:197`)

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
(`Chat.ts:867`) all go through it. MUC whispers are the exception: they are `<no-store>`, so the
reference is the `originId` (`Chat.ts:1865`).

On the receiving side, an incoming reference is resolved by `id`/`stanzaId` first and only then by
`originId` — `stores/chatStore.ts:2374` and `:2429`.

## 5. When the archive id is missing

A read position names itself through `PointerIdentity`
(`packages/fluux-sdk/src/core/types/readState.ts:92-119`), a two-state discriminated union:

- **`addressable`** — the named message carried an archive id when the pointer was minted.
  Publishable as-is.
- **`local`** — no archive id. Explicitly degraded, not degraded by omission.

`makeReadPointer` (`packages/fluux-sdk/src/stores/shared/readPointer.ts:117-124`) mints
`addressable` exactly when `message.stanzaId` is present: every peer message and every MUC
reflection converges for free. `local` arises for a message whose archive id has not arrived yet —
and, for the user's own 1:1 sends, may never arrive: the server does not echo them back, so their
only id is the client-generated `origin-id`, which is not publishable (`readState.ts:110-115`).

What a caller should do with a missing archive id:

- **Do not fabricate one.** No model can conjure it; the type is what forces the branch to be
  handled.
- **Keep using the lower tiers.** Dedup, cache lookups and local rendering work on
  `originId`/`from`+`id` (§3).
- **Wait for convergence, bound by identity.** `withArchiveId`
  (`stores/shared/readPointer.ts:147-156`) attaches a later-known archive id to a `local` pointer.
  It touches the name only, never the order; the caller must bind by identity, never by timestamp
  or by an `origin-id` two rows share; and a `floor` pointer is never enriched.
- **Fall back on order, not on name.** `PointerOrder`
  (`core/types/readState.ts:35-90`) separates an exact position from a `floor` — "at least here" —
  and comparators answer the two differently on purpose.

## 6. Do not

- **Do not treat a client `id` as an identity.** It is a name in one stream. It is the chat cache's
  primary key (`messageCache.ts:176`) and the lowest identity tier only in combination with `from`
  (`roomMessageIdentity.ts`, `chatMessageIdentity.ts`).
- **Do not compare archive ids from different archives.** A message can carry several
  `<stanza-id>`; only the one stamped `by` the archive you are addressing is meaningful there
  (`messagingUtils.ts:239-276`). Comparing across archives, or across rooms, is what the room
  scoping exists to prevent (`roomMessageIdentity.ts`, `messageCache.ts:197-205`).
- **Do not read stability as identity.** `originId` is stable and sender-assigned, which makes it a
  good echo-dedup key — but two rows can share one, which is why `withArchiveId` forbids binding
  through it (`readPointer.ts:126-146`) and why references resolve it last
  (`chatStore.ts:2374`, `:2429`).
- **Do not assume an archive id, once seen, is permanent.** It can be revoked when the archive
  purges it (`chatStore.ts:2507`, `roomStore.ts:2413`).
- **Do not use an archive id for ordering.** It carries none (`core/types/readState.ts:14-33`).

## Related

- `docs/MAM_CATCHUP.md` — how archive ids and timestamps anchor catch-up and pagination.
