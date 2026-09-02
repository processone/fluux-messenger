/**
 * The ONE definition of a message's identity (XEP-0359), for 1:1 chats and MUC
 * rooms alike.
 *
 * One logical message appears as several stanzas — the optimistic local echo, the
 * MUC reflection, the MAM copy, a gateway bridge's rewrite — with no single stable
 * field common to all of them. They are matched through a tiered ladder, most
 * specific first: **stanzaId, then originId, then from+id**. Two copies are the
 * same logical message iff they share ANY tier and no stronger evidence separates
 * them (see {@link sameLogicalMessage}).
 *
 * Everything that needs message identity comes through here: the resident-window
 * dedup, the durable cache, the search index, the retraction ledger, the MAM
 * modification resolver, and the UI's reference lookups. Nothing re-derives the
 * ladder at a call site — that is the defect class this module exists to close.
 *
 * ## Scope
 *
 * Room keys are room-scoped, chat keys are not. stanzaId and originId are assigned
 * per-archive and repeat across rooms, and the cache's `identityKeys` index spans
 * the whole store, so an unscoped room key would let the finder merge messages
 * from different rooms. A 1:1 message traverses one archive (the account's own)
 * and `from` already pins the lowest tier to a sender, so chat keys are usable
 * across conversations.
 *
 * ## Two resolution policies, one ladder
 *
 * Resolving a bare `<retract id="…">`-style reference to a message needs an
 * ordering, and the codebase genuinely needs two — they disagree about where the
 * sender-assigned origin-id sits relative to the sender-assigned `id`:
 *
 * - `archive-first` ranks originId ABOVE id: an origin-id is an explicit XEP-0359
 *   identity claim, a bare `id` is just a stanza attribute a MUC may rewrite.
 * - `client-id-first` ranks originId BELOW id: an origin-id is sender-controlled
 *   and spoofable, so it must never shadow a real id/stanza-id match on a
 *   different message.
 *
 * Both are defensible and both are in use. What is NOT acceptable is choosing
 * between them implicitly: {@link resolveMessageReference} takes the policy as a
 * required argument, so a call site names the ordering it wants instead of
 * hand-rolling a `find` that silently picks one.
 *
 * ## Retraction target resolution versus wire references
 *
 * {@link canonicalReference} gives the durable retraction layer the full ladder
 * needed to expand a target into every stored copy. {@link archiveReference}
 * chooses the reference emitted on the wire. These are different jobs with
 * deliberately different ladders; target resolution does not redefine protocol
 * output.
 *
 * ## Persisted shapes
 *
 * `identityKeys` for room scope and {@link searchDocumentKey} are written to
 * IndexedDB. Their exact strings — separators included — are a stored shape:
 * changing one orphans every existing row or document. Locked by tests. A room
 * fallback {@link canonicalKey} additionally carries the occupant-id when one is
 * known, allowing future nick-reassignment collisions to coexist. Existing rows
 * keep their legacy keys; no migration can recover content already overwritten,
 * and ambiguous legacy rows remain ambiguous.
 *
 * @module Utils/MessageIdentity
 */

/** The fields the ladder reads. `Message` and `RoomMessage` both satisfy it. */
export interface IdentityFields {
  from: string
  id: string
  stanzaId?: string
  originId?: string
  /**
   * Archive ids of XEP-0308 corrections applied to this message. A resolution-only
   * tier: other clients may reference a corrected message by its correction's
   * archive entry. Never contributes a persisted key.
   */
  correctionStanzaIds?: string[]
  /** XEP-0421 occupant-id. Room messages only; see {@link occupantConflict}. */
  occupantId?: string
  /**
   * The room a MUC message belongs to; absent for 1:1. Part of the identity: the
   * same archive id in another room is another message. Build the scope from it
   * ({@link roomScope}) rather than passing a room the message is not in.
   */
  roomJid?: string
}

/** Room identity fields — the room JID is part of every key. */
export interface RoomIdentityFields extends IdentityFields {
  roomJid: string
}

/**
 * Which archive a message's ids were assigned in, and therefore how its keys are
 * namespaced. Build one with {@link CHAT_SCOPE} or {@link roomScope}.
 */
export type IdentityScope = { kind: 'chat' } | { kind: 'room'; roomJid: string }

/** The scope of every 1:1 message. Keys are not namespaced; see the module note. */
export const CHAT_SCOPE: IdentityScope = { kind: 'chat' }

/** The scope of every message in `roomJid`. */
export function roomScope(roomJid: string): IdentityScope {
  return { kind: 'room', roomJid }
}

/**
 * The tiers of the ladder, most specific first.
 *
 * `client-id` is not a rung: it is the `client-id-first` policy's single strong
 * pass, matching `id`, `stanzaId` and any correction archive id together.
 */
export type IdentityTier = 'stanzaId' | 'originId' | 'fallback' | 'client-id'

/** The tiers that contribute a key. `client-id` is resolution-only. */
export type KeyTier = 'stanzaId' | 'originId' | 'fallback'

/** How to order the ladder when resolving a reference. See the module note. */
export type ResolutionPolicy = 'archive-first' | 'client-id-first'

export interface IdentityProbe<T> {
  tier: IdentityTier
  /**
   * Whether a match at this tier is proof. A non-authoritative match may be a
   * collision — a reused nick with a colliding client id resolves through
   * `fallback` — so callers that act destructively on the result must corroborate
   * it (authorship, occupant-id) before doing so.
   */
  authoritative: boolean
  matches: (message: T) => boolean
}

/** An {@link IdentityProbe} carrying the reference value it was built from. */
export interface IdentityProbeWithReference<T> extends IdentityProbe<T> {
  reference: string
}

export interface IdentityResolution<T> {
  tier: IdentityTier
  authoritative: boolean
  candidates: Array<{ message: T; index: number }>
}

/** The subset a probe reads. Deliberately narrower than {@link IdentityFields}. */
type ProbeFields = Pick<IdentityFields, 'id' | 'stanzaId' | 'originId' | 'correctionStanzaIds'>

// =============================================================================
// Key derivation
// =============================================================================

// U+0000 separator: JIDs/ids/stanzaIds cannot contain it, so joins never collide.
const S = '\u0000'

/** The per-scope key prefix. Empty for chat; see the module note on scope. */
function tierPrefix(scope: IdentityScope): string {
  return scope.kind === 'room' ? `room${S}${scope.roomJid}${S}` : ''
}

/**
 * The key a single tier contributes, for a value already in hand.
 *
 * Use this to name a tier without a message — revoking a cleared alias, or
 * looking a room up by archive id. Always agrees with {@link identityKeys}.
 */
export function tierKey(scope: IdentityScope, tier: 'stanzaId' | 'originId', value: string): string {
  return scope.kind === 'room'
    ? `${tierPrefix(scope)}${tier}${S}${value}`
    : `${tier}:${value}`
}

/** The `from+id` key — the lowest, non-authoritative rung. */
function fallbackKey(scope: IdentityScope, m: Pick<IdentityFields, 'from' | 'id'>): string {
  return scope.kind === 'room'
    ? `${tierPrefix(scope)}from${S}${m.from}${S}id${S}${m.id}`
    : `from:${m.from}:id:${m.id}`
}

/**
 * Every identity key the message carries, most-specific first. For matching.
 *
 * Room keys are a PERSISTED shape (`StoredRoomMessage.identityKeys`); do not
 * change their spelling without a migration.
 *
 * THE SPELLING IS ALSO LOAD-BEARING IN MEMORY, which is not visible from here.
 * The transient unread overlay indexes its entries by these aliases and resolves
 * a removal through that index (`transientUnread.ts`'s `canonicalByAlias`) rather
 * than by recomputing a canonical key. That is what keeps the overlay addressable
 * across a change to `canonicalKey` — notably the occupant-id the room fallback
 * rung now carries. Change the alias spelling and a noted entry can no longer be
 * found to remove, which strands it and inflates one conversation's unread count
 * for the rest of the session, with no visible connection to the edit that caused
 * it.
 */
export function identityKeys(scope: IdentityScope, m: IdentityFields): string[] {
  const keys: string[] = []
  if (m.stanzaId) keys.push(tierKey(scope, 'stanzaId', m.stanzaId))
  if (m.originId) keys.push(tierKey(scope, 'originId', m.originId))
  keys.push(fallbackKey(scope, m))
  return keys
}

/** The durable primary key for the highest tier present. */
export function canonicalKey(scope: IdentityScope, m: IdentityFields): string {
  const canonical = identityKeys(scope, m)[0]
  if (scope.kind === 'room' && !m.stanzaId && !m.originId && m.occupantId) {
    return `${canonical}${S}occupantId${S}${m.occupantId}`
  }
  return canonical
}

/**
 * The RAW id the durable retraction layer uses to resolve every stored copy of
 * a target — the highest tier present, unprefixed and unscoped.
 *
 * This is NOT the outgoing retraction reference. Wire references use
 * {@link archiveReference}; this full ladder belongs to durable target resolution
 * in `retractionStorage`. It is also not a cache key: {@link canonicalKey} is.
 *
 * An empty-string tier counts as absent, exactly as {@link identityKeys} treats it:
 * a reference that disagreed with the keys would name a message the cache cannot
 * find.
 */
export function canonicalReference(m: Pick<IdentityFields, 'id' | 'stanzaId' | 'originId'>): string {
  return m.stanzaId || m.originId || m.id
}

/**
 * The id a XEP-0461 reply, XEP-0444 reaction or XEP-0425 moderation must name:
 * the server-assigned archive id when there is one, else the client id.
 *
 * Every participant sees the same archive id, so it is the reference other clients
 * can resolve. It deliberately skips the origin-id rung — a remote has no reason to
 * have indexed the sender's own origin-id for a reply.
 */
export function archiveReference(m: Pick<IdentityFields, 'id' | 'stanzaId'>): string {
  return m.stanzaId || m.id
}

/**
 * The id a XEP-0308 correction must name: the id the ORIGINAL SENDER assigned —
 * the origin-id when present, else the message id.
 *
 * Deliberately NOT {@link archiveReference}. A MUC may rewrite the message id and
 * assign its own stanza-id, but a correction that references the stanza-id breaks
 * matching on compliant clients, which render the edit as a brand-new message.
 */
export function senderReference(m: Pick<IdentityFields, 'id' | 'originId'>): string {
  return m.originId || m.id
}

/**
 * The search index's document id for a room message.
 *
 * A PERSISTED shape with its own history: `:`-separated, and with no origin-id
 * rung. It predates the scoped ladder and every document already in a user's
 * index is stored under it, so it is reproduced here verbatim rather than
 * unified — changing it would orphan every indexed room message. It lives in this
 * module so the rule stays in one place even though its spelling differs.
 */
export function searchDocumentKey(m: RoomIdentityFields): string {
  return m.stanzaId || searchDocumentFallbackKey(m)
}

/**
 * The `from+id` composite form of {@link searchDocumentKey}, for a message that
 * also carries an archive id.
 *
 * The two forms are mutually exclusive at write time, so a room message indexed
 * before its archive id arrived lives under the composite form for good. This is
 * the read-side complement, not a second write key.
 */
export function searchDocumentFallbackKey(m: RoomIdentityFields): string {
  return `${m.roomJid}:${m.from}:${m.id}`
}

// =============================================================================
// Sameness
// =============================================================================

/**
 * Whether a whole candidate set may be merged or coalesced without crossing a
 * known XEP-0421 occupant boundary.
 *
 * At most one distinct known occupant-id may appear. Occupant-less copies remain
 * mergeable when the set has no conflicting known evidence, preserving legacy
 * and local-echo behaviour. Once two known occupant-ids disagree, an ambiguous
 * occupant-less copy is kept separate rather than acting as a bridge between
 * them.
 */
export function canMergeOccupantSet(
  candidates: readonly Pick<IdentityFields, 'occupantId'>[]
): boolean {
  let knownOccupantId: string | undefined
  for (const candidate of candidates) {
    if (!candidate.occupantId) continue
    if (knownOccupantId && knownOccupantId !== candidate.occupantId) return false
    knownOccupantId = candidate.occupantId
  }
  return true
}

export function mergeableOccupantCandidates<
  T extends Pick<IdentityFields, 'occupantId'>,
>(
  incoming: Pick<IdentityFields, 'occupantId'>,
  candidates: readonly T[]
): T[] {
  if (canMergeOccupantSet([incoming, ...candidates])) return [...candidates]
  if (!incoming.occupantId) return []
  return candidates.filter((candidate) => candidate.occupantId === incoming.occupantId)
}

export function extendOccupantComponent<
  T extends Pick<IdentityFields, 'occupantId'>,
>(
  incoming: Pick<IdentityFields, 'occupantId'>,
  selected: readonly T[],
  candidates: readonly T[]
): T[] {
  if (canMergeOccupantSet([incoming, ...selected, ...candidates])) return [...candidates]
  const knownOccupantId = incoming.occupantId ?? selected.find((candidate) => candidate.occupantId)?.occupantId
  if (!knownOccupantId) return []
  return candidates.filter((candidate) => candidate.occupantId === knownOccupantId)
}

/**
 * Whether two copies carry XEP-0421 occupant-ids that PROVE they are different
 * occupants.
 *
 * The occupant-id is the stable, unforgeable author identity in a MUC: a nick can
 * be reassigned once its owner leaves, so a shared room, nick and client id no
 * longer imply a shared author. Only a disagreement is evidence — a local echo, a
 * pre-XEP-0421 server, or a legacy cached row carries none, and an absent id must
 * never separate two copies of the same message.
 */
export function occupantConflict(
  a: Pick<IdentityFields, 'occupantId'>,
  b: Pick<IdentityFields, 'occupantId'>
): boolean {
  return !canMergeOccupantSet([a, b])
}

/**
 * Whether two copies are the same logical message: they share a tier AND no
 * occupant-id disagreement separates them.
 *
 * This is the predicate every "is this the same message?" site must use — cache
 * merges, preview invalidation, index ownership. Spelling it per call site is how
 * a site ends up matching on a tier subset, or forgetting the occupant guard and
 * merging a new occupant's message into a departed one's row.
 */
export function sameLogicalMessage(
  scope: IdentityScope,
  a: IdentityFields,
  b: IdentityFields
): boolean {
  if (occupantConflict(a, b)) return false
  const bKeys = new Set(identityKeys(scope, b))
  return identityKeys(scope, a).some((key) => bKeys.has(key))
}

/**
 * Whether an update leaves a message's identity unchanged.
 *
 * Compares the FIELDS, not the canonical key: adding an originId to a row that
 * already has a stanzaId (or changing the id) leaves the canonical key unchanged
 * yet still expands the identity, and a row now matching the new tier must be
 * merged in. A key-only comparison would miss it. Conversely, cache writers
 * must also compare the serialized key before taking an in-place fast path,
 * because occupantId is deliberately excluded here but can qualify a fallback
 * room key.
 */
export function identityFieldsEqual(a: IdentityFields, b: IdentityFields): boolean {
  return (
    a.id === b.id &&
    a.from === b.from &&
    a.stanzaId === b.stanzaId &&
    a.originId === b.originId &&
    a.roomJid === b.roomJid
  )
}

// =============================================================================
// Row identity
// =============================================================================

/**
 * Which RENDERED ROW something means — as opposed to which logical message.
 *
 * A client `id` names a logical message and carries no uniqueness guarantee (see
 * `docs/MESSAGE_IDENTIFIERS.md`). Once a MUC nick is reassigned, two occupants
 * can legitimately produce rows sharing a room, a `from` and an `id`, and the
 * XEP-0421 occupant-id is the only thing that tells them apart. Anything that
 * points AT A ROW — a scroll anchor, the new-message divider, a viewport report,
 * a read pointer — must carry both halves or it names an ambiguity.
 *
 * This is deliberately NOT a wire reference. `id` is always the row's own client
 * id, never a stanza-id or an origin-id, so resolving one walks no tier ladder
 * and takes no {@link ResolutionPolicy} — see {@link findMessageRowIndex}.
 */
export interface MessageRowRef {
  readonly id: string
  /** XEP-0421 occupant-id. Absent for 1:1, a local echo, or a pre-XEP-0421 room. */
  readonly occupantId?: string
}

/** The row ref naming `message`. */
export function messageRowRef(message: Pick<IdentityFields, 'id' | 'occupantId'>): MessageRowRef {
  return message.occupantId ? { id: message.id, occupantId: message.occupantId } : { id: message.id }
}

/**
 * Pick the row `ref` means from candidates that already share its id.
 *
 * Deliberately NOT {@link mergeableOccupantCandidates}, which answers a different
 * question. That one asks "may these be MERGED into one message?", and there an
 * occupant-less copy facing two disagreeing occupants must merge with neither — it
 * would bridge them. This one asks "which of these rows is meant?", where the same
 * input has an honest answer: the ref supplied no evidence, so take the first,
 * exactly as a bare-client-id lookup always did. Answering "not found" there would
 * strand every pointer and divider written before occupant-ids were carried.
 *
 * 1. A ref naming no occupant takes the first candidate.
 * 2. Otherwise prefer the exact occupant-id match.
 * 3. Otherwise take a candidate carrying NO occupant-id — absence is not evidence
 *    of difference ({@link occupantConflict}), so a local echo or a pre-XEP-0421
 *    row still answers.
 *
 * Returns `undefined` only when the ref names an occupant every candidate
 * contradicts. Callers must treat that as "this row is not here", never as "take
 * one anyway".
 */
export function selectOccupantRow<T extends Pick<IdentityFields, 'occupantId'>>(
  ref: Pick<IdentityFields, 'occupantId'>,
  candidates: readonly T[]
): T | undefined {
  if (!ref.occupantId) return candidates[0]
  return (
    candidates.find((candidate) => candidate.occupantId === ref.occupantId) ??
    candidates.find((candidate) => !occupantConflict(ref, candidate))
  )
}

/**
 * The index of the row `ref` names, or -1.
 *
 * Matches `id` EXACTLY and narrows by occupant through {@link selectOccupantRow}.
 * It walks no tier ladder on purpose: a row ref's `id` is read off a rendered row
 * or off a read pointer's local name, so it is always a client id, and admitting
 * stanza-id or origin-id matches here would let a read pointer advance onto a
 * message no viewport ever reported. Use {@link resolveMessageReference} — which
 * requires a policy — when the input really is a wire reference.
 */
export function findMessageRowIndex<T extends Pick<IdentityFields, 'id' | 'occupantId'>>(
  messages: readonly T[],
  ref: MessageRowRef
): number {
  const candidates: Array<{ occupantId?: string; index: number }> = []
  messages.forEach((message, index) => {
    if (message.id === ref.id) candidates.push({ occupantId: message.occupantId, index })
  })
  return selectOccupantRow(ref, candidates)?.index ?? -1
}

/**
 * Whether `message` is the row `ref` names.
 *
 * The predicate form of {@link findMessageRowIndex}, for a single-row test that
 * has no array to index into.
 */
export function isMessageRow(
  message: Pick<IdentityFields, 'id' | 'occupantId'>,
  ref: MessageRowRef
): boolean {
  return message.id === ref.id && !occupantConflict(message, ref)
}

/** Whether two row refs name the same row. */
export function sameMessageRow(a: MessageRowRef | undefined, b: MessageRowRef | undefined): boolean {
  if (!a || !b) return a === b
  return a.id === b.id && a.occupantId === b.occupantId
}

// =============================================================================
// Authorship
// =============================================================================

/**
 * The author fields an authorship gate reads, and nothing else.
 *
 * A pending retraction satisfies it, and so does the actor kept alongside an
 * unresolved retraction reference (`utils/retractedIdentities.ts`), which carries
 * no target id.
 */
export interface MessageActor {
  /**
   * Author the modification claims to come from. XEP-0424 (retraction) and
   * XEP-0308 (correction) both let a message be changed only by its own author,
   * so this is re-checked when the target shows up.
   */
  actorJid: string
  /**
   * XEP-0421 occupant-id of the acting author (MUC only). Preferred over
   * {@link MessageActor.actorJid} when the target carries one too — a nick can be
   * reassigned once its owner leaves, an occupant-id cannot.
   */
  actorOccupantId?: string
}

/**
 * Authorship gate for a 1:1 message: only a message's own author may retract or
 * correct it.
 */
export const chatMessageAuthor = (
  message: Pick<IdentityFields, 'from'>,
  actor: MessageActor
): boolean => message.from === actor.actorJid

/**
 * Authorship gate, room flavour. XEP-0421 occupant-id is the stable, unforgeable
 * author identity and wins whenever BOTH sides carry one. Mirrors
 * Chat.isSameMucAuthor.
 *
 * The nick fallback is deliberate, not a gap: a pre-XEP-0421 room offers nothing
 * else. What it cannot do is separate two occupants of a reused nick, which is
 * why {@link occupantConflict} is a separate, one-directional check — evidence of
 * difference, never evidence of sameness.
 */
export const roomMessageAuthor = (
  message: Pick<IdentityFields, 'from' | 'occupantId'>,
  actor: MessageActor
): boolean =>
  message.occupantId && actor.actorOccupantId
    ? message.occupantId === actor.actorOccupantId
    : message.from === actor.actorJid

// =============================================================================
// Reference resolution
// =============================================================================

/** The one tier-matching table. Every probe in this module is built from it. */
const TIER_MATCHES: Record<
  Exclude<IdentityTier, 'client-id'> | 'correctionStanzaId',
  (message: ProbeFields, reference: string) => boolean
> = {
  stanzaId: (message, reference) => message.stanzaId === reference,
  originId: (message, reference) => message.originId === reference,
  fallback: (message, reference) => message.id === reference,
  correctionStanzaId: (message, reference) => message.correctionStanzaIds?.includes(reference) === true,
}

/**
 * The ladder, ordered by `policy`, as probes against `reference`.
 *
 * Callers that need the tier a match came from (to pick an index, or to decide
 * whether the match is proof) read it off the probe.
 */
export function referenceProbes<T extends ProbeFields>(
  reference: string,
  policy: ResolutionPolicy
): IdentityProbe<T>[] {
  if (policy === 'client-id-first') {
    return [
      {
        tier: 'client-id',
        authoritative: true,
        matches: (message) =>
          TIER_MATCHES.fallback(message, reference) ||
          TIER_MATCHES.stanzaId(message, reference) ||
          TIER_MATCHES.correctionStanzaId(message, reference),
      },
      { tier: 'originId', authoritative: false, matches: (message) => TIER_MATCHES.originId(message, reference) },
    ]
  }
  return [
    { tier: 'stanzaId', authoritative: true, matches: (message) => TIER_MATCHES.stanzaId(message, reference) },
    { tier: 'originId', authoritative: true, matches: (message) => TIER_MATCHES.originId(message, reference) },
    { tier: 'fallback', authoritative: false, matches: (message) => TIER_MATCHES.fallback(message, reference) },
  ]
}

/**
 * Every reference another copy of this message may be named by, ordered by
 * `policy`.
 *
 * The dual of {@link referenceProbes}: that answers "what does this reference
 * name?", this answers "what could name me?". Use it to look one message up in a
 * collection keyed by reference — never build the list at the call site, which is
 * how a tier gets dropped.
 */
export function messageReferences(m: ProbeFields, policy: ResolutionPolicy): string[] {
  const corrections = m.correctionStanzaIds ?? []
  const ordered =
    policy === 'client-id-first'
      ? [m.id, m.stanzaId, ...corrections, m.originId]
      : [m.stanzaId, m.originId, m.id, ...corrections]
  return ordered.filter((reference): reference is string => !!reference)
}

/**
 * The probes for every tier `message` itself carries — "find my other copies",
 * as opposed to {@link referenceProbes}'s "find what this reference names".
 */
export function identityProbes<T extends ProbeFields>(
  message: ProbeFields,
  policy: ResolutionPolicy
): IdentityProbeWithReference<T>[] {
  const references: Partial<Record<IdentityTier, string | undefined>> = {
    stanzaId: message.stanzaId,
    originId: message.originId,
    fallback: message.id,
    'client-id': message.id,
  }
  return referenceProbes<T>('', policy).flatMap((tierProbe) => {
    const reference = references[tierProbe.tier]
    if (!reference) return []
    const probe = referenceProbes<T>(reference, policy).find(({ tier }) => tier === tierProbe.tier)!
    return [{ ...probe, reference }]
  })
}

/**
 * Every message the reference could name, at the highest tier that matches any.
 *
 * Returns ALL candidates at that tier, not the first: a non-authoritative tier can
 * legitimately match several rows, and a caller that acts destructively needs to
 * see the ambiguity rather than silently pick one.
 */
export function resolveMessageReference<T extends ProbeFields>(
  messages: readonly T[],
  reference: string,
  policy: ResolutionPolicy
): IdentityResolution<T> | undefined {
  for (const probe of referenceProbes<T>(reference, policy)) {
    const candidates: IdentityResolution<T>['candidates'] = []
    messages.forEach((message, index) => {
      if (probe.matches(message)) candidates.push({ message, index })
    })
    if (candidates.length > 0) {
      return { tier: probe.tier, authoritative: probe.authoritative, candidates }
    }
  }
  return undefined
}

// =============================================================================
// `client-id-first` bindings (public SDK surface)
// =============================================================================

/**
 * Resolve a reference to a message index under `client-id-first`.
 *
 * XEP-0461 replies and XEP-0444 reactions reference the MUC stanza-id, XEP-0308
 * corrections reference the sender-assigned origin-id, and a reply to a corrected
 * message may reference the correction's own archive entry — so all of those
 * resolve, with the spoofable origin-id consulted last.
 *
 * @returns The index of the matching message, or -1 if none match.
 */
export function findMessageIndexById<T extends ProbeFields>(
  messages: readonly T[],
  messageId: string
): number {
  return resolveMessageReference(messages, messageId, 'client-id-first')?.candidates[0]?.index ?? -1
}

/**
 * Find a message by any reference tier. See {@link findMessageIndexById} for the
 * ordering.
 */
export function findMessageById<T extends ProbeFields>(
  messages: readonly T[],
  messageId: string
): T | undefined {
  return resolveMessageReference(messages, messageId, 'client-id-first')?.candidates[0]?.message
}

/**
 * A map from every reference a message may be named by to that message.
 *
 * The batched form of {@link findMessageById}, for a component resolving many
 * references against one array. Strong tiers are indexed first across ALL messages
 * so the spoofable origin-id can never shadow a real id/stanza-id match.
 */
export function createMessageLookup<T extends ProbeFields>(messages: readonly T[]): Map<string, T> {
  const map = new Map<string, T>()
  for (const message of messages) {
    map.set(message.id, message)
    if (message.stanzaId) map.set(message.stanzaId, message)
    if (message.correctionStanzaIds) {
      for (const cid of message.correctionStanzaIds) map.set(cid, message)
    }
  }
  for (const message of messages) {
    if (message.originId && !map.has(message.originId)) map.set(message.originId, message)
  }
  return map
}
