/**
 * Internal message implementation-state.
 *
 * These fields are SDK-internal bookkeeping. On the public {@link BaseMessage}
 * they would leak onto `Message` / `RoomMessage`, and they are not part of a
 * message's public shape — no application code reads them — so they are kept
 * here, off the exported types.
 *
 * This module is deliberately NOT re-exported from the package index: it is an
 * internal seam. SDK code that needs the fields uses {@link StoredMessage} /
 * {@link StoredRoomMessage} at the write site and the read helpers below, so
 * the cast to the internal shape lives in exactly one place per field.
 */
import type { Message } from './chat'
import type { RoomMessage } from './room'

export interface MessageImplState {
  /**
   * Local persistence opt-out. When true, the message is kept in the in-memory
   * store only — not written to the local IndexedDB cache or the search index.
   * Set for Quick Chat (transient) rooms and MUC whisper placeholders.
   *
   * Independent of server archival: the XEP-0334 `<no-store>` wire hint is added
   * at the send site, not derived from this flag.
   */
  noLocalStore?: boolean
  /**
   * XEP-0308 + XEP-0359: stanza-ids from correction stanzas. When a message is
   * corrected, the MUC service archives the correction as a new stanza with its
   * own stanza-id; other clients may reference that id in replies (XEP-0461),
   * so we track them to keep reply lookups resolving correctly.
   */
  correctionStanzaIds?: string[]
  /** Content date and its provenance; device-authored dates never order archive revisions. */
  correctionTimestamp?: number
  correctionTimestampSource?: 'authored' | 'delay'
  correctionRevision?: CorrectionRevision
  correctionAlternatives?: CorrectionAlternative[]
  liveCorrection?: boolean
  correctionHandoff?: ContentSource
  contentRecovery?: ContentSource
}

export interface ContentSource {
  encryptedPayload?: string
  revisionIds: string[]
  isEdited: boolean
  from: string
  occupantId?: string
  accountScope: string | null
}

/** A stored 1:1 message: the public {@link Message} plus internal impl-state. */
export type StoredMessage = Message & MessageImplState

/** A stored room message: the public {@link RoomMessage} plus internal impl-state. */
export type StoredRoomMessage = RoomMessage & MessageImplState

/**
 * Whether a message is marked local-store-only. Centralizes the read so the
 * cast to the internal shape lives in one place.
 */
export function isNoLocalStore(msg: Message | RoomMessage): boolean {
  return (msg as MessageImplState).noLocalStore === true
}

/**
 * The correction stanza-ids tracked on a message, if any. Centralizes the read
 * so the cast to the internal shape lives in one place.
 */
export function getCorrectionStanzaIds(msg: Message | RoomMessage): string[] | undefined {
  return (msg as MessageImplState).correctionStanzaIds
}

export interface CorrectionReceiveOrder {
  replay?: boolean
  archive?: boolean
  overlapping?: number[]
  pendingLiveSequences?: number[]
  session: string
  sequence: number
}

export interface CorrectionRevision {
  receiveOrder?: CorrectionReceiveOrder
  receiveOrders?: CorrectionReceiveOrder[]
  /** Scoped to the corrected message's author, with separate client/origin/archive namespaces. */
  ids: string[]
  /** Known predecessor revisions, including aliases learned from subsequent archive echoes. */
  supersedes: string[]
  predecessors?: string[][]
  legacyStanzaIds?: string[]
  archiveTimestamp?: number
  /** Archive chronology already observed when an undated correction replaced its predecessor. */
  afterArchiveTimestamp?: number
}

export function withCorrectionStanzaId(existing: string[] | undefined, stanzaId: string): string[] {
  return existing?.includes(stanzaId) ? existing : [...(existing ?? []), stanzaId]
}

export type CorrectionAlternative = Partial<Pick<Message, 'body' | 'originalBody' | 'attachment' | 'securityContext' | 'encryptedPayload' | 'unsupportedEncryption' | 'isEdited'>> &
  Pick<MessageImplState, 'correctionRevision' | 'correctionTimestamp' | 'correctionTimestampSource' | 'correctionStanzaIds'>

export type CorrectionUpdates = MessageImplState & CorrectionAlternative & { isEdited?: boolean; isRetracted?: boolean; encryptedPayload?: string; from?: string; occupantId?: string }

function union(a: string[] = [], b: string[] = []): string[] {
  return [...new Set([...a, ...b])].sort()
}

function latest(...values: (number | undefined)[]): number | undefined {
  const valid = values.filter((value): value is number => value !== undefined && Number.isFinite(value))
  return valid.length ? Math.max(...valid) : undefined
}

function overlaps(a: string[] = [], b: string[] = []): boolean {
  return a.some(id => b.includes(id))
}

function sameRevisionIds(a: string[] = [], b: string[] = []): boolean {
  for (const prefix of ['stanza:', 'origin:']) {
    const left = a.filter(id => id.startsWith(prefix))
    const right = b.filter(id => id.startsWith(prefix))
    if (left.length && right.length) return overlaps(left, right)
  }
  return overlaps(a, b)
}

export function sameCorrection(a: MessageImplState, b: MessageImplState): boolean {
  return sameRevisionIds(a.correctionRevision?.ids, b.correctionRevision?.ids)
}

function referencesPredecessor(revision: CorrectionRevision | undefined, previous: CorrectionRevision | undefined): boolean {
  if (!revision || !previous || sameRevisionIds(revision.ids, previous.ids)) return false
  const groups = revision.predecessors ?? []
  const groupedIds = new Set(groups.flat())
  const legacyIds = revision.supersedes.filter(id => !groupedIds.has(id))
  return groups.some(ids => sameRevisionIds(ids, previous.ids)) || sameRevisionIds(legacyIds, previous.ids)
}

function mergePredecessors(...sources: (string[][] | undefined)[]): string[][] {
  const groups: string[][] = []
  const rank = (ids: string[]) => ids.some(id => id.startsWith('stanza:')) ? 2 : ids.some(id => id.startsWith('origin:')) ? 1 : 0
  const ordered = sources.flatMap(source => source ?? []).map(ids => union(ids))
    .sort((a, b) => rank(b) - rank(a) || JSON.stringify(a).localeCompare(JSON.stringify(b)))
  for (const ids of ordered) {
    const matches = groups.filter(group => sameRevisionIds(group, ids))
    if (matches.length === 0) groups.push(ids)
    else if (matches.length === 1) groups[groups.indexOf(matches[0])] = union(matches[0], ids)
  }
  return groups
}

export function withCorrectionPredecessor(revision: CorrectionRevision, previous: CorrectionRevision): CorrectionRevision {
  return {
    ...revision,
    supersedes: union(revision.supersedes, union(previous.ids, previous.supersedes)),
    predecessors: mergePredecessors(revision.predecessors, previous.predecessors, [previous.ids]),
    afterArchiveTimestamp: latest(revision.afterArchiveTimestamp, previous.afterArchiveTimestamp, previous.archiveTimestamp),
  }
}

function receiptOrders(revision: CorrectionRevision | undefined): CorrectionReceiveOrder[] {
  return [...(revision?.receiveOrder ? [revision.receiveOrder] : []), ...(revision?.receiveOrders ?? [])]
}

function mergeReceiptOrders(a: CorrectionRevision, b: CorrectionRevision | undefined): CorrectionReceiveOrder[] {
  const sessions = new Map<string, { live?: CorrectionReceiveOrder; archive?: CorrectionReceiveOrder }>()
  for (const receipt of [...receiptOrders(a), ...receiptOrders(b)]) {
    const session = sessions.get(receipt.session) ?? {}
    const channel = receipt.archive || receipt.pendingLiveSequences ? 'archive' : 'live'
    session[channel] = mergeReceiveOrder(session[channel], receipt)
    sessions.set(receipt.session, session)
  }
  return [...sessions.values()].flatMap(session => [session.live, session.archive].filter((receipt): receipt is CorrectionReceiveOrder => !!receipt))
}

function compareReceiveOrder(a: CorrectionRevision | undefined, b: CorrectionRevision | undefined): number | undefined {
  const evidence = new Set<number>()
  for (const left of receiptOrders(a)) {
    for (const right of receiptOrders(b)) {
      if (left.session !== right.session) continue
      if (left.archive || right.archive || left.pendingLiveSequences || right.pendingLiveSequences) continue
      const later = left.sequence > right.sequence ? left : right
      const revision = left.sequence > right.sequence ? a : b
      if (left.sequence !== right.sequence && (later.replay || receiptOrders(revision).some(receipt =>
        receipt.archive && (receipt.session !== later.session || receipt.sequence < later.sequence)))) continue
      evidence.add(Math.sign(left.sequence - right.sequence))
    }
  }
  return evidence.size === 1 ? [...evidence][0] : undefined
}

function mergeReceiveOrder(a: CorrectionReceiveOrder | undefined, b: CorrectionReceiveOrder | undefined): CorrectionReceiveOrder | undefined {
  if (!a) return b
  if (!b || a.session !== b.session) return a
  return a.sequence <= b.sequence ? a : b
}

export function correctionContent(message: CorrectionUpdates): CorrectionAlternative {
  return {
    body: message.body, originalBody: message.originalBody, attachment: message.attachment,
    securityContext: message.securityContext, encryptedPayload: message.encryptedPayload,
    unsupportedEncryption: message.unsupportedEncryption, isEdited: message.isEdited,
    correctionRevision: message.correctionRevision, correctionTimestamp: message.correctionTimestamp,
    correctionTimestampSource: message.correctionTimestampSource, correctionStanzaIds: message.correctionStanzaIds,
  }
}

function mergeAlternatives(...groups: (CorrectionAlternative[] | undefined)[]): CorrectionAlternative[] | undefined {
  const result: CorrectionAlternative[] = []
  for (const candidate of groups.flatMap(group => group ?? [])) {
    const index = result.findIndex(held => sameCorrection(held, candidate))
    if (index < 0) result.push(candidate)
    else result[index] = { ...result[index], ...resolveCorrectionUpdate(result[index], candidate) }
  }
  return result.length ? result : undefined
}

function provenCorrectionAncestor(held: CorrectionUpdates, updates: CorrectionUpdates): boolean {
  if (!held.isEdited && updates.isEdited) return true
  const incoming = updates.correctionRevision
  const previous = held.correctionRevision
  return referencesPredecessor(incoming, previous) || ((compareReceiveOrder(incoming, previous) ?? 0) > 0 && compareCorrectionRevisions(updates, held) > 0) ||
    (incoming?.archiveTimestamp !== undefined && previous?.archiveTimestamp !== undefined && incoming.archiveTimestamp > previous.archiveTimestamp)
}

function isKnownLegacyCorrection(current: CorrectionUpdates, revision: CorrectionRevision | undefined): boolean {
  return !!current.isEdited && !current.correctionRevision &&
    (overlaps(current.correctionStanzaIds?.map(id => `stanza:${id}`), revision?.ids) ||
      overlaps(current.correctionStanzaIds, revision?.legacyStanzaIds))
}

export function compareCorrectionRevisions(a: CorrectionUpdates, b: CorrectionUpdates): number {
  const ar = a.correctionRevision
  const br = b.correctionRevision
  if (sameCorrection(a, b)) return 0
  const at = ar?.archiveTimestamp
  const bt = br?.archiveTimestamp
  if (at !== undefined && bt !== undefined && at !== bt) return Math.sign(at - bt)
  if (referencesPredecessor(ar, br)) return 1
  if (referencesPredecessor(br, ar)) return -1
  if (at !== undefined && bt === undefined && br?.afterArchiveTimestamp !== undefined && at < br.afterArchiveTimestamp) return -1
  if (bt !== undefined && at === undefined && ar?.afterArchiveTimestamp !== undefined && bt < ar.afterArchiveTimestamp) return 1
  const receivedOrder = compareReceiveOrder(ar, br)
  if (receivedOrder) return receivedOrder
  if (isKnownLegacyCorrection(a, br)) return 1
  if (isKnownLegacyCorrection(b, ar)) return -1
  if (at !== undefined && bt !== undefined) return 0
  if (!ar && br) return -1
  if (ar && !br) return 1
  return 0
}

function correctionOrderEvidence(a: CorrectionUpdates, b: CorrectionUpdates): number | undefined {
  if (sameCorrection(a, b)) return 0
  const ar = a.correctionRevision, br = b.correctionRevision
  if (!ar || !br) return undefined
  if ((ar.archiveTimestamp !== undefined && br.archiveTimestamp !== undefined) ||
      referencesPredecessor(ar, br) || referencesPredecessor(br, ar) ||
      (ar.archiveTimestamp !== undefined && br.afterArchiveTimestamp !== undefined && ar.archiveTimestamp < br.afterArchiveTimestamp) ||
      (br.archiveTimestamp !== undefined && ar.afterArchiveTimestamp !== undefined && br.archiveTimestamp < ar.afterArchiveTimestamp)) {
    return compareCorrectionRevisions(a, b)
  }
  return compareReceiveOrder(ar, br)
}

export function canReplaceCorrection(
  current: CorrectionUpdates,
  incoming: CorrectionUpdates,
  order = compareCorrectionRevisions(incoming, current),
): boolean {
  return order > 0 || (order === 0 &&
    (sameCorrection(current, incoming) || !current.correctionRevision || !incoming.correctionRevision))
}

export function mergeCorrectionMetadata(
  owner: CorrectionUpdates,
  other: CorrectionUpdates,
): MessageImplState {
  const revision = owner.correctionRevision
  const previous = other.correctionRevision
  const same = sameCorrection(owner, other)
  const predecessor = revision && previous && (
    referencesPredecessor(revision, previous) || ((compareReceiveOrder(revision, previous) ?? 0) > 0 && compareCorrectionRevisions(owner, other) > 0) ||
    (revision.archiveTimestamp !== undefined && previous.archiveTimestamp !== undefined &&
      revision.archiveTimestamp > previous.archiveTimestamp)
  )
  const correctionStanzaIds = union(owner.correctionStanzaIds, other.correctionStanzaIds)
  const alternatives = mergeAlternatives(owner.correctionAlternatives, other.correctionAlternatives,
    !owner.isRetracted && revision && previous && !same && other.isEdited && other.body !== undefined &&
      correctionOrderEvidence(owner, other) === undefined ? [correctionContent(other)] : undefined)
  return {
    ...(correctionStanzaIds.length && { correctionStanzaIds }),
    ...((alternatives || owner.correctionAlternatives || other.correctionAlternatives) && { correctionAlternatives: alternatives }),
    ...(revision && { correctionRevision: {
      ...(previous && predecessor && !same ? withCorrectionPredecessor(revision, previous) : revision),
      ids: same ? union(revision.ids, previous?.ids) : revision.ids,
      receiveOrder: same ? mergeReceiptOrders(revision, previous)[0] : revision.receiveOrder,
      ...(same && { receiveOrders: mergeReceiptOrders(revision, previous).slice(1) }),
      ...((revision.legacyStanzaIds || (same && previous?.legacyStanzaIds)) && { legacyStanzaIds: same ? union(revision.legacyStanzaIds, previous?.legacyStanzaIds) : revision.legacyStanzaIds }),
      ...(same && { supersedes: union(revision.supersedes, previous?.supersedes), predecessors: mergePredecessors(revision.predecessors, previous?.predecessors) }),
      archiveTimestamp: same ? latest(revision.archiveTimestamp, previous?.archiveTimestamp) : revision.archiveTimestamp,
      afterArchiveTimestamp: latest(revision.afterArchiveTimestamp, same || predecessor ? previous?.afterArchiveTimestamp : undefined, predecessor ? previous?.archiveTimestamp : undefined),
    } }),
  }
}

export function captureContentSource(message: CorrectionUpdates, accountScope: string | null): ContentSource {
  return {
    encryptedPayload: message.encryptedPayload,
    revisionIds: message.correctionRevision?.ids ?? [],
    isEdited: !!message.isEdited,
    from: message.from ?? '',
    occupantId: message.occupantId,
    accountScope,
  }
}

function matchesContentSource(held: CorrectionUpdates, source: ContentSource, accountScope?: string | null, allowDecryption = false): boolean {
  const matchesPayload = held.encryptedPayload === source.encryptedPayload ||
    (allowDecryption && !!held.correctionRevision && (!held.encryptedPayload || !source.encryptedPayload))
  return matchesPayload && !!held.isEdited === source.isEdited &&
    held.from === source.from && held.occupantId === source.occupantId && accountScope === source.accountScope &&
    (held.correctionRevision ? sameRevisionIds(held.correctionRevision.ids, source.revisionIds) : source.revisionIds.length === 0)
}

function resolveCorrectionUpdate<T extends CorrectionUpdates>(
  current: CorrectionUpdates | undefined,
  updates: T,
  accountScope?: string | null,
): T | MessageImplState | undefined {
  const held = current ?? {}
  const { contentRecovery, correctionHandoff, liveCorrection, ...recovered } = updates
  if (correctionHandoff) {
    if (accountScope !== correctionHandoff.accountScope) return undefined
    if (!matchesContentSource(held, correctionHandoff, accountScope, true) && !sameCorrection(held, updates) && !provenCorrectionAncestor(held, updates)) {
      return mergeCorrectionMetadata(held, updates)
    }
    return resolveCorrectionUpdates(current, recovered as T, accountScope)
  }
  if (contentRecovery) {
    if (held.isRetracted || !matchesContentSource(held, contentRecovery, accountScope)) return undefined
    return { ...recovered, ...mergeCorrectionMetadata(held, updates) } as T
  }
  updates = recovered as T
  if (!updates.isEdited) {
    if (updates.correctionRevision && !sameCorrection(held, updates)) {
      const { correctionRevision: _revision, correctionTimestamp: _time, correctionTimestampSource: _source, ...metadata } = updates
      return { ...metadata, ...mergeCorrectionMetadata(held, updates) }
    }
    const { correctionRevision: _revision, ...metadata } = updates
    return { ...metadata, ...mergeCorrectionMetadata(held, updates) }
  }
  const same = sameCorrection(held, updates)
  const revision = updates.correctionRevision
  const followsHeld = revision && revision.archiveTimestamp === undefined && liveCorrection === true &&
    (compareReceiveOrder(revision, held.correctionRevision) ?? 1) > 0 &&
    !same && !isKnownLegacyCorrection(held, revision) && !referencesPredecessor(held.correctionRevision, revision)
  const order = followsHeld ? 1 : compareCorrectionRevisions(updates, held)
  if (held.isRetracted || !canReplaceCorrection(held, updates, order)) {
    return mergeCorrectionMetadata(held, updates)
  }
  if (same) {
    return {
      ...(held.encryptedPayload && !updates.encryptedPayload ? updates : {}),
      ...mergeCorrectionMetadata(held, updates),
      ...((updates.correctionTimestampSource === 'authored' || (!held.correctionTimestampSource && updates.correctionTimestampSource === 'delay')) && {
        correctionTimestamp: updates.correctionTimestamp,
        correctionTimestampSource: updates.correctionTimestampSource,
      }),
    }
  }
  const incoming = followsHeld ? {
    ...updates,
    correctionRevision: held.correctionRevision ? withCorrectionPredecessor(revision, held.correctionRevision) : revision,
  } : updates
  return { ...incoming, ...mergeCorrectionMetadata(incoming, held) }
}

export function resolveCorrectionUpdates<T extends CorrectionUpdates>(
  current: CorrectionUpdates | undefined,
  updates: T,
  accountScope?: string | null,
): T | MessageImplState | undefined {
  if (!updates.contentRecovery && !updates.correctionHandoff && !current?.isRetracted && updates.isEdited) {
    const retained = current?.correctionAlternatives?.find(candidate => sameCorrection(candidate, updates))
    if (retained) {
      updates = { ...updates, ...retained, ...resolveCorrectionUpdate(retained, updates, accountScope), liveCorrection: false }
      current = { ...current, correctionAlternatives: current!.correctionAlternatives!.map(candidate =>
        candidate === retained ? correctionContent(updates) : candidate) }
    }
  }
  const result = resolveCorrectionUpdate(current, updates, accountScope)
  if (!result) return result
  if (current?.isRetracted || updates.isRetracted) return { ...result, correctionAlternatives: undefined }
  const alternatives = mergeAlternatives(current?.correctionAlternatives, updates.correctionAlternatives, result.correctionAlternatives)
  if (!alternatives) return result
  let patch: CorrectionUpdates = result
  let held = { ...current, ...result }
  const pending = alternatives
  for (let index = 0; index < pending.length;) {
    const candidate = pending[index]
    if (!sameCorrection(held, candidate) && !correctionOrderEvidence(candidate, held)) {
      index++
      continue
    }
    pending.splice(index, 1)
    const resolved = resolveCorrectionUpdate(held, { ...candidate, liveCorrection: false }, accountScope)
    patch = { ...patch, ...resolved }
    held = { ...held, ...resolved }
    index = 0
  }
  return { ...patch, correctionAlternatives: pending.length ? pending.map(correctionContent) : undefined }
}
