/**
 * Message Archive Management (XEP-0313) module.
 *
 * Provides unified archive querying for both 1:1 conversations and MUC rooms.
 * Handles result collection, pagination, and applying modifications (retractions,
 * corrections, fastenings, reactions) to archived messages.
 *
 * ## Loading Strategy
 *
 * MAM queries follow a latest-first catch-up model, orchestrated per entity
 * (1:1 conversation or room) by {@link MAM.runCatchUpHistory} / the
 * `catchUpConversationHistory` / `catchUpRoomHistory` adapters:
 *
 * - **Phase A — align to live**: forward, id-exact from the held coverage
 *   edge (the newest downloaded message's archive id), capped at
 *   `MAM_CATCHUP_FORWARD_BAIL_PAGES`. A long gap (incomplete within the cap,
 *   or an empty cache) bails to a `before:''` fetch-latest so the window
 *   jumps straight to the live edge in one round-trip.
 * - **Phase B — grow to the read pointer** (background entities only, not
 *   the active one): while the XEP-0490 read pointer is unresolved, page
 *   backward from the window bottom until the pointer's own message is
 *   found, the archive start is reached, or a page-count cap is hit.
 * - **Seams**: a gap between held history and the live edge is recorded with
 *   its coverage archive ids (`startId`/`endId`) and healed from both
 *   directions — forward catch-up resumes from the id-exact edge, backward
 *   pagination shrinks/clears it as pages reach into or across it (see
 *   `mamGap.ts`).
 *
 * On connect, preview refresh (fast, max=5) updates sidebar previews first;
 * background catch-up (max=100, concurrency=2) then runs the orchestrator
 * above for every conversation and room; discovery queries MAM for roster
 * contacts with no existing conversation. On conversation/room open, side
 * effects re-run the same orchestrator to fetch anything newer than the
 * cached edge. `fetchOlderHistory()` handles explicit scroll-up pagination
 * with a `before` cursor, independent of the catch-up orchestrator.
 *
 * @module MAM
 * @category Modules
 */

import { xml, Element } from '@xmpp/client'
import { BaseModule } from './BaseModule'
import { CorrectionReceipts } from './CorrectionReceipts'
import { getBareJid, getResource, getLocalPart } from '../jid'
import { generateUUID, generateStableMessageId } from '../../utils/uuid'
import { executeWithConcurrency } from '../../utils/concurrencyUtils'
import { parseRSMResponse } from '../../utils/rsm'
import {
  selectCatchUpQuery,
  isConnectionError,
  MAM_CATCHUP_FORWARD_MAX,
  MAM_CATCHUP_BACKWARD_MAX,
  MAM_CACHE_LOAD_LIMIT,
  MAM_ROOM_FORWARD_MAX_PAGES,
  MAM_ROOM_FORWARD_MAX_PAGES_MANUAL,
  MAM_BACKWARD_SIGNAL_RETRY_PAGES,
  MAM_CATCHUP_FORWARD_BAIL_PAGES,
  MAM_POINTER_STITCH_MAX_PAGES,
  MAM_POINTER_SEED_PROBE_LIMIT,
  oldestMessageWithStanzaId,
  walkExtentBottomId,
} from '../../utils/mamCatchUpUtils'
import {
  NS_MAM,
  NS_RSM,
  NS_DATA_FORMS,
  NS_FORWARD,
  NS_DELAY,
  NS_FASTEN,
  NS_OOB,
  NS_OCCUPANT_ID,
  NS_POLL,
} from '../namespaces'
import { parsePollElement, parsePollClosedElement } from '../poll'
import { isItemNotFoundError } from '../../hooks/shared/mamCursor'
import type {
  Message,
  RoomMessage,
  HistoryQueryOptions,
  HistoryResult,
  RoomHistoryQueryOptions,
  RoomHistoryResult,
  PageInfo,
  HistorySearchOptions,
  RoomHistorySearchOptions,
  HistoryPagingSearchOptions,
} from '../types'
import { parseMessageContent, parseOgpFastening, applyRetraction, applyCorrection, parseStanzaId, parseArchiveStanzaId, hasRenderableContent, parseReactionsSignal, parseRetractionSignal, parseCorrectionSignal, isMessageSignal } from './messagingUtils'
import { getDomain } from '../jid'
import { logInfo, logError as logErr } from '../logger'
import {
  decryptStanzaInPlace,
  deriveConversationContext,
  readStashedAuthoredAt,
  readStashedEncryptedPayload,
  readStashedSecurityContext,
  readStashedUnsupportedEncryption,
  recordUnclaimedEME,
} from '../e2ee/stanzaDecrypt'
import type { MessageSecurityContext } from '../types'
import { getCorrectionStanzaIds, correctionContent, resolveCorrectionUpdates, withCorrectionStanzaId, sameCorrection, withCorrectionPredecessor, type StoredMessage, type StoredRoomMessage, type CorrectionRevision } from '../types/message-internal'
import { parseSearchQuery, tokenize } from '../../utils/searchIndex'
import {
  chatMessageAuthor,
  CHAT_SCOPE,
  roomScope,
  sameLogicalMessage,
  correctionReferences,
  archiveIdentityConflict,
  occupantConflict,
  type CorrectionReferences,
  resolveMessageReference,
  roomMessageAuthor,
  type MessageActor,
  type ResolutionPolicy,
} from '../../utils/messageIdentity'


/** XEP-0203: the date an archive or carbon envelope stamps on what it wraps. */
function delayStamp(delayEl?: Element): Date | undefined {
  const stamp = delayEl?.attrs.stamp
  return stamp ? new Date(stamp) : undefined
}

/**
 * Raw MAM result buffered by {@link MAM.createMessageCollector} and drained
 * after the enclosing IQ resolves. The two-phase shape exists so the drain
 * loop can `await` per-entry async work (E2EE decrypt) without blocking the
 * synchronous stanza listener.
 */
interface RawArchiveEntry {
  forwarded: Element
  messageEl: Element
  archiveId?: string
}

/**
 * Internal type for collected modifications during MAM query
 */
interface MAMModifications {
  retractions: { targetId: string; from: string; occupantId?: string }[]
  corrections: { targetId: string; from: string; occupantId?: string; body: string; messageEl: Element; correctionStanzaId?: string; revisionStanzaId?: string; delayEl?: Element; authoredAt?: Date; archivePredecessor?: CorrectionRevision }[]
  fastenings: { targetId: string; applyToEl: Element }[]
  reactions: { targetId: string; from: string; emojis: string[]; timestamp?: Date }[]
}

/**
 * Modifications requiring store/cache events. Corrections and accepted retractions
 * remain here even after updating an in-page row, because deduplication may retain
 * a resident or cached copy instead. Other modifications enter only if unresolved.
 */
interface UnresolvedModifications {
  retractions: { targetId: string; from: string; occupantId?: string }[]
  corrections: { targetId: string; from: string; occupantId?: string; body: string; messageEl: Element; correctionStanzaId?: string; revisionStanzaId?: string; delayEl?: Element; authoredAt?: Date; archivePredecessor?: CorrectionRevision }[]
  fastenings: { targetId: string; applyToEl: Element }[]
  reactions: { targetId: string; from: string; emojis: string[]; timestamp?: Date }[]
}


interface CorrectionReconciliationTarget {
  message: StoredMessage | StoredRoomMessage
  isCurrent: () => boolean
  generation: number
  refresh?: boolean
  traversal?: {
    end: string
    after?: string
    cursors: Set<string>
    archiveOrder: Map<string, Set<CorrectionOrderGroup>>
  }
}

interface CorrectionReconciliation {
  isCurrent: () => boolean
  pending: Map<string, CorrectionReconciliationTarget>
  observed: Map<string, { revisions: CorrectionRevision[]; isCurrent: () => boolean }>
  generation: number
  running: boolean
}

interface CorrectionOrderGroup {
  revision: CorrectionRevision
  identity?: CorrectionReferences['identity']
}

/**
 * Message Archive Management (XEP-0313) module.
 *
 * Retrieves archived messages from the server's message archive for both
 * 1:1 conversations and MUC rooms. Supports pagination for incremental loading.
 *
 * @remarks
 * Consumers use the history and search operations on `client.messages`.
 *
 * @example Fetch recent 1:1 messages
 * ```typescript
 * const result = await client.messages.queryMAM({
 *   with: 'user@example.com',
 *   max: 50
 * })
 * console.log(`Fetched ${result.messages.length} messages, complete: ${result.complete}`)
 * ```
 *
 * @example Fetch room messages with pagination
 * ```typescript
 * // Initial fetch
 * const initial = await client.messages.queryRoomMAM({
 *   roomJid: 'room@conference.example.com',
 *   max: 50
 * })
 *
 * // Load older messages
 * if (!initial.complete && initial.page?.first) {
 *   const older = await client.messages.queryRoomMAM({
 *     roomJid: 'room@conference.example.com',
 *     before: initial.page.first
 *   })
 * }
 * ```
 *
 * @category Core
 */
export class MAM extends BaseModule {
  readonly correctionReceipts = new CorrectionReceipts(this.deps)
  private correctionQueries = new Map<string, CorrectionReconciliation>()
  private observedArchives = new Map<string, () => boolean>()

  correctionCompletion(conversationId: string, room: boolean, revision?: CorrectionRevision) {
    const session = this.captureQuery()
    return (message: StoredMessage | StoredRoomMessage, isStoreCurrent: () => boolean) => {
      const isCurrent = () => session.isCurrent() && isStoreCurrent()
      if (!isCurrent()) return
      this.deps.recoverCorrection?.(message, isCurrent, updates => {
        if (!isCurrent()) return
        const correctionActor = { actorJid: message.from, actorOccupantId: 'occupantId' in message ? message.occupantId : undefined }
        if (room) this.deps.emitSDK('room:message-updated', { roomJid: conversationId, messageId: message.stanzaId ?? message.id, updates, correctionActor })
        else this.deps.emitSDK('chat:message-updated', { conversationId, messageId: message.stanzaId ?? message.id, updates, correctionActor })
      })
      if (revision && !message.isRetracted && message.correctionAlternatives?.length) {
        void this.reconcileCorrections(conversationId, room, message, isStoreCurrent, revision)
      }
    }
  }

  private async reconcileCorrections(conversationId: string, room: boolean, message: StoredMessage | StoredRoomMessage,
    isStoreCurrent: () => boolean, revision: CorrectionRevision): Promise<void> {
    const key = JSON.stringify([room, conversationId])
    const supported = room ? this.deps.stores?.room.getRoom(conversationId)?.supportsMAM
      : this.deps.stores?.connection.getServerInfo?.()?.features?.includes(NS_MAM)
    if (!supported && !this.observedArchives.get(key)?.()) return
    const session = this.captureQuery()
    for (const [scope, request] of this.correctionQueries) {
      if (!request.isCurrent()) this.correctionQueries.delete(scope)
    }
    let request = this.correctionQueries.get(key)
    if (!request) {
      request = { isCurrent: session.isCurrent, pending: new Map(), observed: new Map(), generation: 0, running: false }
      this.correctionQueries.set(key, request)
    }
    const targetKey = JSON.stringify([message.stanzaId ?? message.id, message.from, 'occupantId' in message ? message.occupantId : undefined])
    const previous = request.observed.get(targetKey)
    const revisions = previous?.isCurrent() ? previous.revisions : []
    const observed = revisions.find(held => sameCorrection({ correctionRevision: held }, { correctionRevision: revision }))
    if (observed) {
      observed.ids = [...new Set([...observed.ids, ...revision.ids])]
      return
    }
    revisions.push({ ids: [...revision.ids], supersedes: [] })
    request.observed.set(targetKey, { revisions, isCurrent: isStoreCurrent })
    request.pending.set(targetKey, {
      message, isCurrent: isStoreCurrent, generation: ++request.generation, refresh: true,
      traversal: request.pending.get(targetKey)?.traversal,
    })
    if (request.running) return
    request.running = true
    try {
      await Promise.resolve()
      while (session.isCurrent() && request.pending.size) {
        const batch = [...request.pending.entries()].slice(0, 4)
        const targets = batch.map(([, target]) => ({ ...target, message: { ...target.message } }))
          .filter(target => target.isCurrent())
        let completed = false
        try {
          if (targets.length) await this.reconcileCorrectionBatch(conversationId, room, targets)
          completed = true
        } catch (error) {
          if (session.isCurrent()) logInfo(`Correction archive reconciliation failed: ${String(error)}`)
        } finally {
          for (const [id, target] of batch) {
            const queued = request.pending.get(id)
            const processed = targets.find(next => next.generation === target.generation)
            if (queued?.generation !== target.generation) {
              if (queued && processed?.isCurrent() && queued.isCurrent() && session.isCurrent()) {
                queued.message = { ...queued.message, ...resolveCorrectionUpdates(queued.message, {
                  ...correctionContent(processed.message), correctionAlternatives: processed.message.correctionAlternatives,
                  isRetracted: processed.message.isRetracted,
                }) }
                queued.traversal ??= processed.traversal
              }
              continue
            }
            request.pending.delete(id)
            if (completed && processed?.traversal && processed.isCurrent()) request.pending.set(id, processed)
          }
        }
      }
    } finally {
      request.running = false
      request.pending.clear()
      if (!session.isCurrent() && this.correctionQueries.get(key) === request) this.correctionQueries.delete(key)
    }
  }

  private async reconcileCorrectionBatch(conversationId: string, room: boolean, targets: CorrectionReconciliationTarget[]): Promise<void> {
    const session = this.captureQuery()
    const isCurrent = () => session.isCurrent() && targets.some(target => target.isCurrent())
    const query = async (max: number, before?: string, after?: string, archiveOrder?: Map<string, Set<CorrectionOrderGroup>>, end?: string) => {
      session.assertCurrent()
      if (!isCurrent()) throw new DOMException('Correction target removed', 'AbortError')
      const queryId = generateUUID()
      const entries: RawArchiveEntry[] = []
      const fields = [xml('field', { var: 'FORM_TYPE', type: 'hidden' }, xml('value', {}, NS_MAM))]
      if (!room) fields.push(xml('field', { var: 'with' }, xml('value', {}, conversationId)))
      const collector = this.createMessageCollector(queryId, (forwarded, messageEl, archiveId) => entries.push({ forwarded, messageEl, archiveId }))
      const xmpp = this.deps.getXmpp()
      const unregister = this.deps.registerMAMCollector?.(queryId, collector) ?? (() => {
        xmpp?.on('stanza', collector)
        return () => xmpp?.removeListener('stanza', collector)
      })()
      try {
        const response = await this.deps.sendIQ(this.buildMAMQuery(queryId, fields, max, before, room ? conversationId : undefined, after))
        session.assertCurrent()
        if (!response.getChild('fin', NS_MAM)) throw new Error('Missing MAM completion')
        const boundaryIndex = end ? entries.findIndex(entry => entry.archiveId === end) : -1
        const boundedEntries = boundaryIndex < 0 ? entries : entries.slice(0, boundaryIndex + 1)
        const modifications: MAMModifications = { retractions: [], corrections: [], fastenings: [], reactions: [] }
        for (const { forwarded, messageEl, archiveId } of boundedEntries) {
          if (!isCurrent()) throw new DOMException('Correction target removed', 'AbortError')
          const delay = forwarded.getChild('delay', NS_DELAY)
          await this.decryptArchiveEntryIfNeeded(messageEl, conversationId, delayStamp(delay))
          session.assertCurrent()
          this.collectModification(messageEl, modifications, from => room ? from : getBareJid(from), delay,
            room ? conversationId : getBareJid(this.deps.getCurrentJid() ?? ''), archiveId)
        }
        const isAuthor = room ? roomMessageAuthor : chatMessageAuthor
        const currentMessages = () => targets.filter(target => target.isCurrent()).map(target => target.message)
        const indexedReferences = new Map<string, CorrectionReferences | null | undefined>()
        const lookup = async (id: string, actor: MessageActor) => {
          const key = JSON.stringify([id, actor.actorJid, actor.actorOccupantId])
          if (!indexedReferences.has(key)) {
            const references = room
              ? await this.deps.stores?.room.resolveCorrectionReferences?.(conversationId, id, actor)
              : await this.deps.stores?.chat.resolveCorrectionReferences?.(conversationId, id, actor)
            session.assertCurrent()
            indexedReferences.set(key, references)
          }
          const references = indexedReferences.get(key)
          return references && this.resolveCorrectionReferenceTarget(currentMessages(), references, actor, isAuthor) ? references : null
        }
        const unresolved = await this.applyModifications(currentMessages(),
          { ...modifications, fastenings: [], reactions: [] }, isAuthor, undefined, archiveOrder, lookup)
        session.assertCurrent()
        const authorized = (modification: { targetId: string; from: string; occupantId?: string }) => {
          const actor = { actorJid: modification.from, actorOccupantId: modification.occupantId }
          const resolution = resolveMessageReference(currentMessages(), modification.targetId, 'archive-first')
          if (resolution?.candidates.some(({ message: target }) => isAuthor(target, actor))) return true
          if (resolution?.authoritative) return false
          const references = indexedReferences.get(JSON.stringify([modification.targetId, actor.actorJid, actor.actorOccupantId]))
          return !!references && !!this.resolveCorrectionReferenceTarget(currentMessages(), references, actor, isAuthor)
        }
        for (const modification of [...unresolved.corrections, ...unresolved.retractions]) {
          if (!authorized(modification)) await lookup(modification.targetId, { actorJid: modification.from, actorOccupantId: modification.occupantId })
        }
        session.assertCurrent()
        const corrections = unresolved.corrections.filter(authorized)
        const retractions = unresolved.retractions.filter(authorized)
        if (isCurrent()) {
          if (room) this.emitUnresolvedRoomModifications(conversationId, { ...unresolved, corrections, retractions })
          else this.emitUnresolvedChatModifications(conversationId, { ...unresolved, corrections, retractions })
        }
        const result = this.parseMAMResponse(response)
        return {
          ...result,
          end: result.page.last || entries.at(-1)?.archiveId,
          reachedEnd: boundaryIndex >= 0,
        }
      } finally { unregister() }
    }
    const latest = targets.some(target => target.refresh) ? await query(50, '') : undefined
    for (const target of targets) target.refresh = false
    for (const target of targets) {
      const unresolved = () => target.isCurrent() && !target.message.isRetracted && !!target.message.correctionAlternatives?.length
      if (!unresolved()) { target.traversal = undefined; continue }
      if (!target.traversal) {
        if (!latest?.end) continue
        const candidates = [target.message, ...target.message.correctionAlternatives ?? []]
        const missing = candidates.find(candidate => candidate.correctionRevision?.archiveTimestamp === undefined)
        const anchor = (missing ?? target.message).correctionRevision?.ids.find(id => id.startsWith('stanza:'))?.slice(7)
        let after = target.message.stanzaId
        if (anchor) {
          const previous = await query(1, anchor)
          if (!previous.page.last && !previous.complete) continue
          after = previous.page.last || undefined
        } else if (!after) continue
        if (after === latest.end) continue
        target.traversal = { after, end: latest.end, cursors: new Set(after ? [after] : []), archiveOrder: new Map() }
      }
      const traversal = target.traversal
      for (let page = 0; page < 2 && unresolved(); page++) {
        const result = await query(50, undefined, traversal.after, traversal.archiveOrder, traversal.end)
        const next = result.page.last
        if (result.reachedEnd || result.complete || !next || next === traversal.after || traversal.cursors.has(next)) {
          target.traversal = undefined
          break
        }
        traversal.cursors.add(next)
        traversal.after = next
      }
      if (!unresolved()) target.traversal = undefined
    }
  }

  /**
   * MAM module doesn't handle incoming stanzas directly.
   * Results are collected via temporary listeners during queries.
   */
  handle(_stanza: Element): boolean {
    return false
  }

  /**
   * Query message archive for a 1:1 conversation (XEP-0313).
   *
   * @param options - Query options
   * @param options.with - The JID to fetch history with (conversation partner)
   * @param options.max - Maximum number of messages to retrieve (default: 50)
   * @param options.before - RSM cursor for pagination (empty string for latest, or message ID for older)
   * @returns Query result with messages, completion status, and pagination info
   */
  async queryArchive(options: HistoryQueryOptions): Promise<HistoryResult> {
    const session = this.captureQuery()
    const requestId = generateUUID()
    const { with: withJid, max = 50, before = '', start, end, after, preserveGapMarker, maxAutoPages: maxAutoPagesOpt } = options
    const conversationId = getBareJid(withJid)
    const mamStart = Date.now()

    // Opt-in forward catch-up: paginate OLDEST-first via the `after` cursor to
    // completion (parity with rooms). Only when a caller explicitly passes
    // maxAutoPages alongside `start`/`after`; every other caller keeps the
    // default single-page, newest-first, skip-non-displayable behavior.
    // `after` alone (the XEP-0490 pointer-seed catch-up) selects forward mode
    // exactly like `start` does — it is itself an archive-id cursor to page
    // forward from.
    const isForwardPaginate = !!(start || after) && maxAutoPagesOpt !== undefined && maxAutoPagesOpt > 0

    // Track total messages across automatic pagination
    const allMessages: Message[] = []
    // Accumulate modifications (corrections/reactions/retractions/fastenings)
    // across ALL pages, then resolve them once against the full message set
    // after the loop. A modification in a later page can target a message from
    // an earlier page; resolving per page — and emitting before the earlier
    // pages reached the store — silently dropped those cross-page edits. The
    // room path emits messages per page, so its earlier pages are already in
    // the store; the 1:1 path emits once, so it must defer modification
    // resolution until the whole catch-up has been collected.
    const modifications: MAMModifications = { retractions: [], corrections: [], fastenings: [], reactions: [] }
    // Forward pagination ignores `before` (oldest-first from `start`/`after`); backward keeps it.
    let currentBefore = isForwardPaginate ? undefined : before
    // The pointer-seed catch-up starts the FIRST page from the given `after`
    // cursor; a plain `start`-anchored catch-up has no initial cursor (the
    // timestamp filter alone selects the first page) and only acquires one
    // from `pageInfo.last` after that first page.
    let currentAfter: string | undefined = after
    let isComplete = false
    let lastPage: PageInfo = {}
    // pageInfo.last of the FIRST backward page — the newest archive entry seen by
    // this walk; stamped as the coverage record's topId (mamCoverage.ts).
    let fetchLatestTopId: string | undefined
    // Persisted coverage record: floor for the signal-only walk
    // and purge-detection anchor for a coverage-seeded before-cursor.
    const coverageRecord = !isForwardPaginate
      ? this.deps.stores?.chat.getConversationCoverage?.(conversationId)
      : undefined
    // Only a fetch-latest walk may jump DOWN to the floor; a mid-archive
    // scroll-up cursor sits below the record and must never jump UP to it.
    const canJumpToFloor = before === ''
    let jumpedToFloor = false
    // The cursor the walk would have used had it not jumped — the recovery
    // resume point when the jumped-to floor turns out purged.
    let preJumpCursor: string | undefined
    // The walk contained the record's top entry — the only accepted proof of
    // contiguity with the existing record, and the trigger for
    // the floor jump.
    let sawCoverageTop = false
    const maxAutoPages = isForwardPaginate ? maxAutoPagesOpt : MAM_BACKWARD_SIGNAL_RETRY_PAGES // cap to avoid infinite loops

    this.deps.emitSDK('chat:history-loading', { conversationId, requestId, isLoading: true })

    try {
      for (let page = 0; page < maxAutoPages; page++) {
        const queryId = `mam_${generateUUID()}`

        // Build form fields with 'with' filter for 1:1 conversations
        const formFields: Element[] = [
          xml('field', { var: 'FORM_TYPE', type: 'hidden' }, xml('value', {}, NS_MAM)),
          xml('field', { var: 'with' }, xml('value', {}, conversationId)),
        ]

        // Add time-based filters if provided (XEP-0313 Section 4.1.2)
        if (start) {
          formFields.push(xml('field', { var: 'start' }, xml('value', {}, start)))
        }
        if (end) {
          formFields.push(xml('field', { var: 'end' }, xml('value', {}, end)))
        }

        const iq = this.buildMAMQuery(queryId, formFields, max, currentBefore, undefined, currentAfter)

        const collectedMessages: Message[] = []
        const rawEntries: RawArchiveEntry[] = []

        // Collector runs synchronously as stanzas arrive; it just buffers raw
        // elements. The actual parse/decrypt pass happens after `sendIQ`
        // resolves so we can await the E2EE pipeline per entry.
        const collectMessage = this.createMessageCollector(queryId, (forwarded, messageEl, archiveId) => {
          rawEntries.push({ forwarded, messageEl, archiveId })
        })

        // Use the collector registry if available, otherwise fall back to direct listeners
        // (fallback is needed for tests that don't provide the registry)
        let unregister: () => void
        if (this.deps.registerMAMCollector) {
          unregister = this.deps.registerMAMCollector(queryId, collectMessage)
        } else {
          const xmpp = this.deps.getXmpp()
          xmpp?.on('stanza', collectMessage)
          unregister = () => xmpp?.removeListener('stanza', collectMessage)
        }

        try {
          if (page === 0) {
            logInfo(`MAM query: ...@${getDomain(conversationId) || '*'}, max=${max}, ${(start || after) ? 'forward' : 'backward'}${start ? ` from ${start}` : ''}${after ? ` after ${after}` : ''}`)
          }
          let response: Element
          try {
            response = await this.deps.sendIQ(iq)
            session.assertCurrent()
          } catch (iqError) {
            session.assertCurrent()
            if (page === 0 && after && isItemNotFoundError(iqError)) {
              // The archive no longer holds the after-anchor (expired/purged):
              // degrade to fetch-latest (spec §5 — degrade gracefully, never error).
              logInfo(`MAM after-cursor purged for ...@${getDomain(conversationId) || '*'} — degrading to fetch-latest`)
              // Strip the purged id from the persisted gap anchor (the degrade
              // site is the only place that KNOWS the id is gone): otherwise
              // every session — and every "Load missing messages" click —
              // re-anchors on it and re-degrades forever. Keeping the gap's
              // start timestamp lets the next resume fall back to it and progress.
              this.deps.emitSDK('chat:history-anchor-purged', { conversationId, after })
              const degraded = await this.queryArchive({ with: withJid, max, before: '', preserveGapMarker })
              session.assertCurrent()
              // Mark the result so callers (the catch-up orchestrator) can tell
              // this is ALREADY a fetch-latest page and skip issuing another one.
              return { ...degraded, degradedToFetchLatest: true }
            }
            if (page === 0 && !after && currentBefore && currentBefore === coverageRecord?.bottomId && isItemNotFoundError(iqError)) {
              // The coverage-seeded before-anchor was purged from the archive:
              // drop the stale record (this degrade site is the only place that
              // KNOWS the id is gone) and degrade to fetch-latest.
              logInfo(`MAM before-cursor purged for ...@${getDomain(conversationId) || '*'} — degrading to fetch-latest`)
              this.deps.emitSDK('chat:history-coverage-purged', { conversationId, before: currentBefore })
              const degraded = await this.queryArchive({ with: withJid, max, before: '', preserveGapMarker })
              session.assertCurrent()
              return { ...degraded, degradedToFetchLatest: true }
            }
            if (jumpedToFloor && preJumpCursor && coverageRecord && currentBefore === coverageRecord.bottomId && isItemNotFoundError(iqError)) {
              // The jumped-to floor was purged MID-WALK (page > 0): drop the
              // stale record and resume from the pre-jump cursor instead of
              // aborting the walk — otherwise the record survives and every
              // session re-jumps onto the dead id.
              logInfo(`MAM coverage floor purged mid-walk for ...@${getDomain(conversationId) || '*'} — resuming from pre-jump cursor`)
              this.deps.emitSDK('chat:history-coverage-purged', { conversationId, before: coverageRecord.bottomId })
              currentBefore = preJumpCursor
              preJumpCursor = undefined // one recovery per walk
              continue
            }
            throw iqError
          }
          const { complete, page: pageInfo } = this.parseMAMResponse(response)
          if (response.getChild('fin', NS_MAM)) this.observedArchives.set(JSON.stringify([false, conversationId]), session.isCurrent)

          // Drain the buffer: E2EE decrypt first (so modification bodies are
          // plaintext, not fallback hints), then modification detection, then parse.
          const correctionStart = modifications.corrections.length
          for (const { forwarded, messageEl, archiveId } of rawEntries) {
            const forwardedDelayEl = forwarded.getChild('delay', NS_DELAY)
            await this.decryptArchiveEntryIfNeeded(messageEl, conversationId, delayStamp(forwardedDelayEl))
            session.assertCurrent()
            if (this.collectModification(messageEl, modifications, (from) => getBareJid(from), forwardedDelayEl, getBareJid(this.deps.getCurrentJid() ?? ''), archiveId)) {
              continue
            }
            const msg = this.parseArchiveMessage(forwarded, conversationId, archiveId)
            if (msg) collectedMessages.push(msg)
          }

          // Modifications are accumulated across pages and resolved once after
          // the loop (see the `modifications` declaration above) so a later
          // page's correction/reaction can still land on an earlier page's message.
          if (!isForwardPaginate) modifications.corrections.unshift(...modifications.corrections.splice(correctionStart))
          allMessages.push(...collectedMessages)
          isComplete = complete
          lastPage = pageInfo
          if (page === 0 && !isForwardPaginate) fetchLatestTopId = pageInfo.last
          if (coverageRecord?.topId && rawEntries.some((e) => e.archiveId === coverageRecord.topId)) {
            sawCoverageTop = true
          }

          if (isForwardPaginate) {
            // Forward catch-up: accumulate every page, advance via `after` until complete.
            if (complete) break
            if (pageInfo.last) {
              currentAfter = pageInfo.last
            } else {
              break
            }
          } else {
            // If we got displayable messages or archive is complete, stop paginating
            if (collectedMessages.length > 0 || complete) {
              break
            }
            // No displayable messages but archive has more - continue with next page
            // Use the 'first' ID as the 'before' cursor for backward pagination
            if (pageInfo.first) {
              // Known signal-only floor (persisted coverage): once this walk
              // re-enters previously-covered territory (the page contains the
              // record's top entry), everything down to the record's bottom is
              // already proven signal-only — jump the cursor straight there so
              // successive sessions descend instead of re-walking the same
              // newest pages.
              if (canJumpToFloor && coverageRecord && sawCoverageTop && !jumpedToFloor) {
                preJumpCursor = pageInfo.first
                currentBefore = coverageRecord.bottomId
                jumpedToFloor = true
              } else {
                currentBefore = pageInfo.first
              }
              this.deps.emitSDK('console:event', {
                message: `Page ${page + 1} had no displayable messages, fetching older...`,
                category: 'sm',
              })
            } else {
              // No pagination cursor available, stop
              break
            }
          }
        } finally {
          unregister()
        }
      }

      // Determine query direction:
      // - Forward: has a `start` filter or an `after` cursor (catching up, either
      //   from a timestamp or a XEP-0490 pointer-seed archive id)
      // - Backward: neither (fetching older history with a `before` cursor)
      const direction = (start || after) ? 'forward' : 'backward'

      logInfo(`MAM result: ...@${getDomain(conversationId) || '*'} → ${allMessages.length} msg(s), complete=${isComplete}, ${Date.now() - mamStart}ms`)

      // Resolve every collected modification against the full message set in a
      // single pass (so cross-page corrections/reactions land), then emit.
      const unresolved = await this.applyModifications(allMessages, modifications, chatMessageAuthor, undefined, undefined,
        (id, actor) => this.deps.stores?.chat.resolveCorrectionReferences?.(conversationId, id, actor))
      session.assertCurrent()

      // Reported for BOTH directions: coverage never certifies over a walk whose
      // modification cache-writes are fire-and-forget, and that
      // holds for the forward bootstrap anchor just as it does for a backward
      // extent. `modifications` accumulates across every page of this query.
      const walkCarriedModifications =
        modifications.retractions.length + modifications.corrections.length +
        modifications.fastenings.length + modifications.reactions.length > 0

      this.emitUnresolvedChatModifications(conversationId, { ...unresolved, fastenings: [], reactions: [] })
      unresolved.corrections = []
      unresolved.retractions = []
      const reconciled = await this.deps.stores?.chat.reconcileHistoryMessages?.(allMessages)
      session.assertCurrent()
      if (reconciled) allMessages.splice(0, allMessages.length, ...reconciled)
      this.deps.emitSDK('chat:history-messages', {
        conversationId,
        messages: allMessages,
        page: lastPage,
        complete: isComplete,
        direction,
        preserveGapMarker,
        isFetchLatest: direction === 'backward' && !before,
        walkCarriedModifications,
        ...(direction === 'backward' ? {
          initialBefore: before,
          fetchLatestTopId,
          sawCoverageTop,
        } : {
          // The cursor this walk resumed from — anchors the coverage bottom
          // when the catch-up reports complete (mamCoverage.ts).
          initialAfter: after,
          walkOldestId: walkExtentBottomId(allMessages),
        }),
      })

      // Modifications whose target is not in this batch belong to a message
      // already in the store (prior query or cache) — emit them now that the
      // batch has been merged.
      this.emitUnresolvedChatModifications(conversationId, unresolved)

      // Surface unresolved gaps for diagnosis (parity with rooms): a forward
      // catch-up that ends without reaching live means a hole remains.
      if (isForwardPaginate && !isComplete) {
        this.deps.emitSDK('console:event', {
          message: `Conversation catch-up incomplete for ${conversationId} — gap remains after ${allMessages.length} msg(s)`,
          category: 'sm',
        })
      }

      session.assertCurrent()
      return { messages: allMessages, complete: isComplete, page: lastPage }
    } catch (error) {
      session.assertCurrent()
      const msg = error instanceof Error ? error.message : 'Unknown error'
      if (isConnectionError(error)) {
        logInfo(`MAM skipped: ...@${getDomain(conversationId) || '*'} — ${msg}`)
      } else {
        logErr(`MAM error: ...@${getDomain(conversationId) || '*'} — ${msg}`)
      }
      this.deps.emitSDK('chat:history-error', { conversationId, requestId, error: msg })
      throw error
    } finally {
      if (session.isAccountCurrent()) this.deps.emitSDK('chat:history-loading', { conversationId, requestId, isLoading: false })
    }
  }

  /**
   * Query message archive for a MUC room (XEP-0313 MUC MAM).
   *
   * @param options - Query options
   * @param options.roomJid - The room JID to fetch history for
   * @param options.max - Maximum number of messages to retrieve (default: 50)
   * @param options.before - RSM cursor for pagination (empty string for latest, or message ID for older)
   * @returns Query result with messages, completion status, and pagination info
   */
  async queryRoomArchive(options: RoomHistoryQueryOptions): Promise<RoomHistoryResult> {
    const session = this.captureQuery()
    const requestId = generateUUID()
    const { roomJid, max = 50, before, after, start, preserveGapMarker, maxAutoPages: maxAutoPagesOpt } = options
    const roomMamStart = Date.now()
    // `after` alone (the XEP-0490 pointer-seed catch-up) selects forward mode
    // exactly like `start` does — it is itself an archive-id cursor to page
    // forward from.
    const isForward = !!(start || after)
    const roomDirection = isForward ? 'forward' : 'backward'

    // For forward catch-up queries, auto-paginate to retrieve all missed messages.
    // User-initiated repair passes a higher cap (maxAutoPagesOpt) so it fills large
    // gaps to completion instead of stopping at the background limit.
    // Backward queries retry past signal-only pages (zero displayable messages)
    // under the same cap as the 1:1 path — the caller still controls real
    // pagination (the loop stops as soon as a page yields displayable messages).
    const maxAutoPages = isForward ? (maxAutoPagesOpt ?? MAM_ROOM_FORWARD_MAX_PAGES) : MAM_BACKWARD_SIGNAL_RETRY_PAGES
    const allMessages: RoomMessage[] = []
    let isComplete = false
    let lastPage: PageInfo = {}
    // pageInfo.last of the FIRST backward page — the newest archive entry seen by
    // this walk; stamped as the coverage record's topId (mamCoverage.ts).
    let fetchLatestTopId: string | undefined
    // Persisted coverage record: floor for the signal-only walk
    // and purge-detection anchor for a coverage-seeded before-cursor.
    const coverageRecord = !isForward
      ? this.deps.stores?.room.getRoomCoverage?.(roomJid)
      : undefined
    // Only a fetch-latest walk may jump DOWN to the floor; a mid-archive
    // scroll-up cursor sits below the record and must never jump UP to it.
    const canJumpToFloor = !before
    let jumpedToFloor = false
    // The cursor the walk would have used had it not jumped — the recovery
    // resume point when the jumped-to floor turns out purged.
    let preJumpCursor: string | undefined
    // The walk contained the record's top entry — contiguity proof and floor
    // jump trigger; see the 1:1 twin in queryArchive.
    let sawCoverageTop = false
    let currentAfter = after
    let currentBefore = before
    // BACKWARD retry pages accumulate modifications across pages and resolve
    // them ONCE after the loop (mirrors queryArchive's 1:1 batch model): a
    // signal on the first, signal-only page targets a message only fetched by
    // a later retry page — per-page resolution would drop it.
    const forwardCorrectionOrder = new Map<string, Set<CorrectionOrderGroup>>()
    const backwardModifications: MAMModifications = { retractions: [], corrections: [], fastenings: [], reactions: [] }
    // Forward pages scope their modifications per page (see below), so the
    // walk-level fact has to be accumulated separately: the coverage bootstrap
    // is anchored by the page that reports `complete`, and it must know whether
    // ANY earlier page of the same walk carried modifications.
    let forwardWalkCarriedModifications = false

    const room = this.deps.stores?.room.getRoom(roomJid)
    const myNickname = room?.nickname || ''

    this.deps.emitSDK('room:history-loading', { roomJid, requestId, isLoading: true })

    try {
      for (let page = 0; page < maxAutoPages; page++) {
        const queryId = `mam_${generateUUID()}`

        // Room MAM doesn't need a 'with' filter - we query the room's archive directly
        const formFields: Element[] = [
          xml('field', { var: 'FORM_TYPE', type: 'hidden' }, xml('value', {}, NS_MAM)),
        ]

        // Add time filter if specified
        if (start) {
          formFields.push(xml('field', { var: 'start' }, xml('value', {}, start)))
        }

        // Send IQ to room JID (not user's archive)
        const iq = this.buildMAMQuery(queryId, formFields, max, currentBefore, roomJid, currentAfter)

        const collectedMessages: RoomMessage[] = []
        // Forward pages resolve modifications per page (earlier pages are
        // already merged in the store); backward retry pages accumulate.
        const modifications: MAMModifications = isForward
          ? { retractions: [], corrections: [], fastenings: [], reactions: [] }
          : backwardModifications
        const rawEntries: RawArchiveEntry[] = []

        // Collector only buffers; decrypt + parse happen in the async drain below.
        const collectMessage = this.createMessageCollector(queryId, (forwarded, messageEl, archiveId) => {
          rawEntries.push({ forwarded, messageEl, archiveId })
        })

        // Use the collector registry if available, otherwise fall back to direct listeners
        let unregister: () => void
        if (this.deps.registerMAMCollector) {
          unregister = this.deps.registerMAMCollector(queryId, collectMessage)
        } else {
          const xmpp = this.deps.getXmpp()
          xmpp?.on('stanza', collectMessage)
          unregister = () => xmpp?.removeListener('stanza', collectMessage)
        }

        try {
          if (page === 0) {
            logInfo(`Room MAM query: ${roomJid}, max=${max}, ${roomDirection}${start ? ` from ${start}` : ''}`)
          }
          let response: Element
          try {
            response = await this.deps.sendIQ(iq)
            session.assertCurrent()
          } catch (iqError) {
            session.assertCurrent()
            if (page === 0 && after && isItemNotFoundError(iqError)) {
              // The archive no longer holds the after-anchor (expired/purged):
              // degrade to fetch-latest (spec §5 — degrade gracefully, never error).
              logInfo(`Room MAM after-cursor purged for ${roomJid} — degrading to fetch-latest`)
              // Strip the purged id from the persisted gap anchor — see the
              // 1:1 twin in queryArchive for the full rationale.
              this.deps.emitSDK('room:history-anchor-purged', { roomJid, after })
              const degraded = await this.queryRoomArchive({ roomJid, max, before: '', preserveGapMarker })
              session.assertCurrent()
              // Mark the result so callers (the catch-up orchestrator) can tell
              // this is ALREADY a fetch-latest page and skip issuing another one.
              return { ...degraded, degradedToFetchLatest: true }
            }
            if (page === 0 && !after && currentBefore && currentBefore === coverageRecord?.bottomId && isItemNotFoundError(iqError)) {
              // The coverage-seeded before-anchor was purged from the archive:
              // drop the stale record and degrade to fetch-latest (see the 1:1
              // twin in queryArchive).
              logInfo(`Room MAM before-cursor purged for ${roomJid} — degrading to fetch-latest`)
              this.deps.emitSDK('room:history-coverage-purged', { roomJid, before: currentBefore })
              const degraded = await this.queryRoomArchive({ roomJid, max, before: '', preserveGapMarker })
              session.assertCurrent()
              return { ...degraded, degradedToFetchLatest: true }
            }
            if (jumpedToFloor && preJumpCursor && coverageRecord && currentBefore === coverageRecord.bottomId && isItemNotFoundError(iqError)) {
              // Jumped-to floor purged mid-walk — resume from the pre-jump
              // cursor (see the 1:1 twin in queryArchive).
              logInfo(`Room MAM coverage floor purged mid-walk for ${roomJid} — resuming from pre-jump cursor`)
              this.deps.emitSDK('room:history-coverage-purged', { roomJid, before: coverageRecord.bottomId })
              currentBefore = preJumpCursor
              preJumpCursor = undefined // one recovery per walk
              continue
            }
            throw iqError
          }
          const { complete, page: pageInfo } = this.parseMAMResponse(response)
          if (response.getChild('fin', NS_MAM)) this.observedArchives.set(JSON.stringify([true, roomJid]), session.isCurrent)

          // Drain buffer: E2EE decrypt first, then modification detection, then parse.
          const correctionStart = modifications.corrections.length
          for (const { forwarded, messageEl, archiveId } of rawEntries) {
            const forwardedDelayEl = forwarded.getChild('delay', NS_DELAY)
            await this.decryptArchiveEntryIfNeeded(messageEl, roomJid, delayStamp(forwardedDelayEl))
            session.assertCurrent()
            if (this.collectModification(messageEl, modifications, (from) => from, forwardedDelayEl, roomJid, archiveId)) {
              continue
            }
            const msg = this.parseRoomArchiveMessage(forwarded, roomJid, myNickname, archiveId)
            if (msg) collectedMessages.push(msg)
          }

          if (!isForward) modifications.corrections.unshift(...modifications.corrections.splice(correctionStart))

          if (isForward) {
            forwardWalkCarriedModifications ||=
              modifications.retractions.length + modifications.corrections.length +
              modifications.fastenings.length + modifications.reactions.length > 0

            // Apply modifications to collected messages (full JID comparison for rooms)
            // normalizeReactor extracts nick from full MUC JID for consistent reactor identifiers
            const unresolved = await this.applyModifications(
              collectedMessages, modifications,
              roomMessageAuthor,
              (from) => getResource(from) || from,
              forwardCorrectionOrder,
              (id, actor) => this.deps.stores?.room.resolveCorrectionReferences?.(roomJid, id, actor)
            )
            session.assertCurrent()

            // Emit modifications targeting messages already in the store (from prior queries/cache)
            this.emitUnresolvedRoomModifications(roomJid, unresolved)

            const reconciled = await this.deps.stores?.room.reconcileHistoryMessages?.(collectedMessages)
            session.assertCurrent()
            if (reconciled) collectedMessages.splice(0, collectedMessages.length, ...reconciled)
            allMessages.push(...collectedMessages)

            // Emit each page's messages immediately so the store can update incrementally
            this.deps.emitSDK('room:history-messages', {
              roomJid,
              messages: collectedMessages,
              page: pageInfo,
              complete,
              direction: 'forward',
              preserveGapMarker,
              isFetchLatest: false,
              // The cursor the WALK resumed from (not this page's), so the
              // completing page can anchor a coverage bottom (mamCoverage.ts).
              initialAfter: after,
              walkOldestId: walkExtentBottomId(allMessages),
              walkCarriedModifications: forwardWalkCarriedModifications,
            })
          } else {
            allMessages.push(...collectedMessages)
          }

          isComplete = complete
          lastPage = pageInfo
          if (page === 0 && !isForward) fetchLatestTopId = pageInfo.last
          if (coverageRecord?.topId && rawEntries.some((e) => e.archiveId === coverageRecord.topId)) {
            sawCoverageTop = true
          }

          // Stop if archive is complete (no more messages)
          if (complete) {
            break
          }

          if (isForward) {
            // Forward pagination: use `last` as the next `after` cursor
            if (pageInfo.last) {
              currentAfter = pageInfo.last
            } else {
              break
            }
          } else {
            // BACKWARD: retry past signal-only pages (parity with the 1:1
            // loop in queryArchive) — a room whose newest page is all
            // reactions/receipts must not render empty (and be marked
            // caught-up-to-live) while older real messages exist. Advance the
            // cursor to this page's oldest and fetch the next older page.
            if (allMessages.length > 0) {
              break
            }
            if (pageInfo.first) {
              // Known signal-only floor (persisted coverage) — jump below
              // covered territory; see the 1:1 twin in queryArchive.
              if (canJumpToFloor && coverageRecord && sawCoverageTop && !jumpedToFloor) {
                preJumpCursor = pageInfo.first
                currentBefore = coverageRecord.bottomId
                jumpedToFloor = true
              } else {
                currentBefore = pageInfo.first
              }
              this.deps.emitSDK('console:event', {
                message: `Page ${page + 1} had no displayable messages, fetching older...`,
                category: 'sm',
              })
            } else {
              // No pagination cursor available, stop
              break
            }
          }
        } finally {
          unregister()
        }
      }

      // BACKWARD: ONE emit with the accumulated set (the retry pages walk
      // contiguously down, so the union extent is the true coverage bottom)
      // and the ORIGINAL fetch-latest flag — the page that finally carries
      // messages must be seam-checked as part of the fetch-latest.
      // Modifications resolve against the full accumulated set first;
      // leftovers target store-resident messages and are emitted after the
      // batch merge (same ordering as the 1:1 path).
      if (!isForward) {
        const unresolved = await this.applyModifications(
          allMessages, backwardModifications,
          roomMessageAuthor,
          (from) => getResource(from) || from, undefined,
          (id, actor) => this.deps.stores?.room.resolveCorrectionReferences?.(roomJid, id, actor)
        )
        session.assertCurrent()
        this.emitUnresolvedRoomModifications(roomJid, { ...unresolved, fastenings: [], reactions: [] })
        unresolved.corrections = []
        unresolved.retractions = []
        const reconciled = await this.deps.stores?.room.reconcileHistoryMessages?.(allMessages)
        session.assertCurrent()
        if (reconciled) allMessages.splice(0, allMessages.length, ...reconciled)
        this.deps.emitSDK('room:history-messages', {
          roomJid,
          messages: allMessages,
          page: lastPage,
          complete: isComplete,
          direction: 'backward',
          preserveGapMarker,
          isFetchLatest: !before,
          initialBefore: before ?? '',
          fetchLatestTopId,
          sawCoverageTop,
          walkCarriedModifications:
            backwardModifications.retractions.length + backwardModifications.corrections.length +
            backwardModifications.fastenings.length + backwardModifications.reactions.length > 0,
        })
        this.emitUnresolvedRoomModifications(roomJid, unresolved)
        session.assertCurrent()
      }

      if (isForward) {
        const reconciled = await this.deps.stores?.room.reconcileHistoryMessages?.(allMessages)
        session.assertCurrent()
        if (reconciled) allMessages.splice(0, allMessages.length, ...reconciled)
      }

      logInfo(`Room MAM result: ${roomJid} → ${allMessages.length} msg(s), complete=${isComplete}, ${Date.now() - roomMamStart}ms`)

      // Surface unresolved gaps for diagnosis: a forward catch-up that ends without
      // reaching live (complete=false) means a hole remains. Visible in the in-app
      // console so we can measure gap prevalence before investing in range tracking.
      if (isForward && !isComplete) {
        this.deps.emitSDK('console:event', {
          message: `Room catch-up incomplete for ${roomJid} — gap remains after ${allMessages.length} msg(s)`,
          category: 'sm',
        })
      }

      session.assertCurrent()
      return { messages: allMessages, complete: isComplete, page: lastPage }
    } catch (error) {
      session.assertCurrent()
      const msg = error instanceof Error ? error.message : 'Unknown error'
      if (isConnectionError(error)) {
        logInfo(`Room MAM skipped: ${roomJid} — ${msg}`)
      } else {
        logErr(`Room MAM error: ${roomJid} — ${msg}`)
      }
      this.deps.emitSDK('room:history-error', { roomJid, requestId, error: msg })
      throw error
    } finally {
      if (session.isAccountCurrent()) this.deps.emitSDK('room:history-loading', { roomJid, requestId, isLoading: false })
    }
  }

  // ============================================================================
  // MAM Fulltext Search
  // ============================================================================

  /**
   * Search the message archive using server-side fulltext search.
   *
   * Requires server support for the `fulltext` form field in MAM queries
   * (supported by ejabberd and some other servers). Use
   * `connectionStore.mamFulltextSearch` to check availability.
   *
   * @param options - Search options
   * @returns Messages matching the query, with pagination info
   */
  async searchArchive(options: HistorySearchOptions): Promise<HistoryResult> {
    const session = this.captureQuery()
    const { query, with: withJid, max = 20, before } = options
    const queryId = `mam_search_${generateUUID()}`

    const formFields: Element[] = [
      xml('field', { var: 'FORM_TYPE', type: 'hidden' }, xml('value', {}, NS_MAM)),
      xml('field', { var: 'fulltext' }, xml('value', {}, query)),
    ]

    if (withJid) {
      const conversationId = getBareJid(withJid)
      formFields.push(xml('field', { var: 'with' }, xml('value', {}, conversationId)))
    }

    const iq = this.buildMAMQuery(queryId, formFields, max, before ?? '')

    const collectedMessages: Message[] = []
    const modifications: MAMModifications = { retractions: [], corrections: [], fastenings: [], reactions: [] }
    const rawEntries: RawArchiveEntry[] = []

    const collectMessage = this.createMessageCollector(queryId, (forwarded, messageEl, archiveId) => {
      rawEntries.push({ forwarded, messageEl, archiveId })
    })

    let unregister: () => void
    if (this.deps.registerMAMCollector) {
      unregister = this.deps.registerMAMCollector(queryId, collectMessage)
    } else {
      const xmpp = this.deps.getXmpp()
      xmpp?.on('stanza', collectMessage)
      unregister = () => xmpp?.removeListener('stanza', collectMessage)
    }

    try {
      logInfo(`MAM search: query="${query}"${withJid ? `, with=${getBareJid(withJid)}` : ''}, max=${max}`)
      const response = await this.deps.sendIQ(iq)
      session.assertCurrent()
      const { complete, page: pageInfo } = this.parseMAMResponse(response)

      const currentJid = this.deps.getCurrentJid()
      const ownBareJid = currentJid ? getBareJid(currentJid) : ''
      for (const { forwarded, messageEl, archiveId } of rawEntries) {
        const forwardedDelayEl = forwarded.getChild('delay', NS_DELAY)
        // Derive conversationId from the message's from/to
        const from = getBareJid(messageEl.attrs.from || '')
        const to = getBareJid(messageEl.attrs.to || '')
        const conversationId = from === ownBareJid ? to : from
        await this.decryptArchiveEntryIfNeeded(messageEl, conversationId, delayStamp(forwardedDelayEl))
        session.assertCurrent()
        if (this.collectModification(messageEl, modifications, (from) => getBareJid(from), forwardedDelayEl, ownBareJid, archiveId)) {
          continue
        }
        const msg = this.parseArchiveMessage(forwarded, conversationId, archiveId)
        if (msg) collectedMessages.push(msg)
      }

      const originalBodies = collectedMessages.map(message => message.body)
      await this.applyModifications(collectedMessages, modifications, chatMessageAuthor, undefined, undefined,
        (id, actor, messageEl) => this.deps.stores?.chat.resolveCorrectionReferences?.(
          actor.actorJid === ownBareJid ? getBareJid(messageEl.attrs.to ?? '') : actor.actorJid, id, actor))
      session.assertCurrent()
      const reconciled = await this.deps.stores?.chat.reconcileHistoryMessages?.(collectedMessages)
      session.assertCurrent()
      collectedMessages.splice(0, collectedMessages.length, ...this.filterReconciledSearchMessages(originalBodies, reconciled ?? collectedMessages, query))

      logInfo(`MAM search result: ${collectedMessages.length} msg(s), complete=${complete}`)
      return { messages: collectedMessages, complete, page: pageInfo }
    } catch (error) {
      session.assertCurrent()
      throw error
    } finally {
      unregister()
    }
  }

  /**
   * Search a room's message archive using server-side fulltext search.
   *
   * @param options - Search options
   * @returns Room messages matching the query, with pagination info
   */
  async searchRoomArchive(options: RoomHistorySearchOptions): Promise<RoomHistoryResult> {
    const session = this.captureQuery()
    const { query, roomJid, max = 20, before } = options
    const queryId = `mam_rsearch_${generateUUID()}`

    const room = this.deps.stores?.room.getRoom(roomJid)
    const myNickname = room?.nickname || ''

    const formFields: Element[] = [
      xml('field', { var: 'FORM_TYPE', type: 'hidden' }, xml('value', {}, NS_MAM)),
      xml('field', { var: 'fulltext' }, xml('value', {}, query)),
    ]

    const iq = this.buildMAMQuery(queryId, formFields, max, before ?? '', roomJid)

    const collectedMessages: RoomMessage[] = []
    const modifications: MAMModifications = { retractions: [], corrections: [], fastenings: [], reactions: [] }
    const rawEntries: RawArchiveEntry[] = []

    // Collector only buffers; decrypt + parse happen in the async drain below.
    const collectMessage = this.createMessageCollector(queryId, (forwarded, messageEl, archiveId) => {
      rawEntries.push({ forwarded, messageEl, archiveId })
    })

    let unregister: () => void
    if (this.deps.registerMAMCollector) {
      unregister = this.deps.registerMAMCollector(queryId, collectMessage)
    } else {
      const xmpp = this.deps.getXmpp()
      xmpp?.on('stanza', collectMessage)
      unregister = () => xmpp?.removeListener('stanza', collectMessage)
    }

    try {
      logInfo(`Room MAM search: query="${query}", room=${roomJid}, max=${max}`)
      const response = await this.deps.sendIQ(iq)
      session.assertCurrent()
      const { complete, page: pageInfo } = this.parseMAMResponse(response)

      for (const { forwarded, messageEl, archiveId } of rawEntries) {
        const forwardedDelayEl = forwarded.getChild('delay', NS_DELAY)
        await this.decryptArchiveEntryIfNeeded(messageEl, roomJid, delayStamp(forwardedDelayEl))
        session.assertCurrent()
        if (this.collectModification(messageEl, modifications, (from) => from, forwardedDelayEl, roomJid, archiveId)) {
          continue
        }
        const msg = this.parseRoomArchiveMessage(forwarded, roomJid, myNickname, archiveId)
        if (msg) collectedMessages.push(msg)
      }

      const originalBodies = collectedMessages.map(message => message.body)
      await this.applyModifications(collectedMessages, modifications, roomMessageAuthor, undefined, undefined,
        (id, actor) => this.deps.stores?.room.resolveCorrectionReferences?.(roomJid, id, actor))
      session.assertCurrent()
      const reconciled = await this.deps.stores?.room.reconcileHistoryMessages?.(collectedMessages)
      session.assertCurrent()
      collectedMessages.splice(0, collectedMessages.length, ...this.filterReconciledSearchMessages(originalBodies, reconciled ?? collectedMessages, query))

      logInfo(`Room MAM search result: ${collectedMessages.length} msg(s), complete=${complete}`)
      return { messages: collectedMessages, complete, page: pageInfo }
    } catch (error) {
      session.assertCurrent()
      throw error
    } finally {
      unregister()
    }
  }

  /**
   * Search a conversation by paging through MAM history and matching client-side.
   *
   * Used when the server doesn't support fulltext MAM search. Pages backward
   * through the archive, tokenizes each message body, and collects matches.
   *
   * @param options - Search options
   * @param signal - Optional AbortSignal to cancel the search
   * @returns Matching messages
   */
  async searchConversationByPaging(
    options: HistoryPagingSearchOptions,
    signal?: AbortSignal
  ): Promise<HistoryResult> {
    const session = this.captureQuery()
    const { query, with: withJid, end, maxPages = 20, maxResults = 50 } = options
    const parsed = parseSearchQuery(query)
    const phraseTokens = parsed.phrases.flatMap((p) => tokenize(p))
    const allTokens = [...new Set([...parsed.terms, ...phraseTokens])]
    if (allTokens.length === 0 && parsed.phrases.length === 0) {
      return { messages: [], complete: true, page: {} }
    }

    const matches: Message[] = []
    let beforeCursor: string | undefined
    let isComplete = false
    let lastPage: PageInfo = {}

    logInfo(`MAM paging search: query="${query}", with=${withJid}, maxPages=${maxPages}`)

    for (let page = 0; page < maxPages; page++) {
      if (signal?.aborted) break
      if (matches.length >= maxResults) break

      const result = await this.queryArchive({
        with: withJid,
        max: 100,
        before: beforeCursor ?? '',
        ...(page === 0 && end ? { end } : {}),
      })

      session.assertCurrent()
      isComplete = result.complete
      lastPage = result.page

      // Match messages client-side
      for (const msg of result.messages) {
        if (matches.length >= maxResults) break
        if (!msg.isRetracted && msg.body && this.matchesQuery(msg.body, allTokens, parsed.phrases)) {
          matches.push(msg)
        }
      }

      if (isComplete || !result.page.first) break
      beforeCursor = result.page.first

      // Small delay between pages to avoid overwhelming the server
      await new Promise(resolve => setTimeout(resolve, 100))
      session.assertCurrent()
    }

    logInfo(`MAM paging search result: scanned to find ${matches.length} match(es), complete=${isComplete}`)
    session.assertCurrent()
    return { messages: matches, complete: isComplete, page: lastPage }
  }

  private filterReconciledSearchMessages<T extends Message | RoomMessage>(originalBodies: Array<string | undefined>, reconciled: T[], query: string): T[] {
    const parsed = parseSearchQuery(query)
    const tokens = [...new Set([...parsed.terms, ...parsed.phrases.flatMap(phrase => tokenize(phrase))])]
    return reconciled.filter((message, index) => !message.isRetracted && (message.body === originalBodies[index] ||
      this.matchesQuery(message.body ?? '', tokens, parsed.phrases)))
  }

  /**
   * Check if a message body matches all query tokens and exact phrases.
   */
  private matchesQuery(body: string, queryTokens: string[], phrases: string[] = []): boolean {
    if (queryTokens.length === 0 && phrases.length === 0) return false
    const bodyLower = body.toLowerCase()
    const tokensMatch = queryTokens.every(token => bodyLower.includes(token))
    if (!tokensMatch) return false
    return phrases.every(phrase => bodyLower.includes(phrase))
  }

  /**
   * Fetch context messages around a target timestamp from MAM and store in cache.
   *
   * Used by SearchContextView when previewing MAM search results — the target
   * message may not be in the local cache yet.
   *
   * @param conversationId - Conversation JID
   * @param isRoom - Whether this is a MUC room
   * @param targetTimestamp - ISO 8601 timestamp of the target message
   * @param contextSize - Number of messages to fetch on each side (default 50)
   * @returns Messages around the target
   */
  async fetchContext(
    conversationId: string,
    isRoom: boolean,
    targetTimestamp: string,
    contextSize: number = 50
  ): Promise<{ messages: (Message | RoomMessage)[] }> {
    const session = this.captureQuery()
    // Fetch messages before and after the target timestamp
    const oneHourBefore = new Date(new Date(targetTimestamp).getTime() - 3600000).toISOString()

    // Bounded windowed forward query: its `complete` says nothing about
    // contiguity outside the [oneHourBefore, ...] window, so it must not
    // clear (or plant) a recorded gap — `preserveGapMarker` leaves it alone.
    if (isRoom) {
      const result = await this.queryRoomArchive({
        roomJid: conversationId,
        max: contextSize * 2,
        start: oneHourBefore,
        preserveGapMarker: true,
        // Bounded context fetch — one round-trip only, mirroring the 1:1
        // branch below: queryArchive doesn't opt into forward auto-pagination
        // here (no maxAutoPages passed), so it stops after its first page of
        // results too. Without this, queryRoomArchive's forward branch would
        // silently inherit its MAM_ROOM_FORWARD_MAX_PAGES (50-page) default.
        maxAutoPages: 1,
      })
      session.assertCurrent()
      return { messages: result.messages }
    } else {
      const result = await this.queryArchive({
        with: conversationId,
        max: contextSize * 2,
        start: oneHourBefore,
        end: new Date(new Date(targetTimestamp).getTime() + 3600000).toISOString(),
        preserveGapMarker: true,
      })
      session.assertCurrent()
      return { messages: result.messages }
    }
  }

  /**
   * Catch up conversation history backward from the oldest locally-cached message
   * until we reach (or pass) the target timestamp. Stores results in messageCache
   * and search index but NOT in the in-memory store.
   *
   * This fills the gap between locally-cached messages and a MAM search result,
   * ensuring the conversation history is continuous.
   *
   * @param conversationId - Conversation JID
   * @param isRoom - Whether this is a MUC room
   * @param targetTimestamp - ISO 8601 timestamp to catch up to
   * @param oldestCachedTimestamp - ISO 8601 timestamp of oldest locally-cached message (or undefined to start from now)
   */
  async catchUpToTimestamp(
    conversationId: string,
    isRoom: boolean,
    targetTimestamp: string,
    oldestCachedTimestamp?: string
  ): Promise<void> {
    const targetTime = new Date(targetTimestamp).getTime()
    const maxPages = 30 // Safety cap

    logInfo(`MAM catch-up to ${targetTimestamp} for ${conversationId}`)

    for (let page = 0; page < maxPages; page++) {
      const endFilter = page === 0 && oldestCachedTimestamp
        ? oldestCachedTimestamp
        : undefined

      if (isRoom) {
        // RoomHistoryQueryOptions has no `end` filter (unlike the 1:1 branch below) —
        // rooms rely on RSM pagination + the oldestInPage/targetTime check below
        // to stop at the target instead. `endFilter` is intentionally unused here.
        const result = await this.queryRoomArchive({
          roomJid: conversationId,
          max: 100,
          before: page === 0 ? '' : undefined,
        })
        // Check if we've reached the target
        const oldestInPage = result.messages.length > 0
          ? result.messages[0].timestamp.getTime()
          : targetTime
        if (result.complete || oldestInPage <= targetTime) break
      } else {
        const result = await this.queryArchive({
          with: conversationId,
          max: 100,
          ...(endFilter ? { end: endFilter } : {}),
          before: '',
        })
        // Check if we've reached the target
        const oldestInPage = result.messages.length > 0
          ? result.messages[0].timestamp.getTime()
          : targetTime
        if (result.complete || oldestInPage <= targetTime) break
      }

      // Small delay between pages
      await new Promise(resolve => setTimeout(resolve, 100))
    }

    logInfo(`MAM catch-up complete for ${conversationId}`)
  }

  /**
   * Refresh sidebar previews for all conversations by fetching the latest message.
   *
   * After being offline, the cached lastMessage may be stale (messages exchanged on
   * other devices). This method fetches `max=1` from MAM for each conversation to
   * update the sidebar preview without affecting the message history.
   *
   * The fetched messages are NOT stored in IndexedDB or the messages array - they
   * only update the `lastMessage` field for sidebar display. When the conversation
   * is opened, a full MAM fetch will retrieve the complete history.
   *
   * @param options - Optional configuration
   * @param options.concurrency - Maximum parallel requests (default: 3)
   */
  async refreshConversationPreviews(options: { concurrency?: number } = {}): Promise<void> {
    const session = this.captureQuery()
    const { concurrency = 3 } = options
    const conversations = this.deps.stores?.chat.getAllConversations() || []
    if (conversations.length === 0) return

    logInfo(`Preview refresh for ${conversations.length} conversation(s)`)

    this.deps.emitSDK('console:event', {
      message: `Refreshing previews for ${conversations.length} conversation(s)`,
      category: 'sm',
    })

    const conversationIds = conversations.map((c) => c.id)

    await executeWithConcurrency(
      conversationIds,
      (conversationId) => session.isCurrent() ? this.fetchPreviewForConversation(conversationId) : Promise.resolve(),
      concurrency
    )

    if (!session.isCurrent()) return
    logInfo(`Preview refresh complete for ${conversations.length} conversation(s)`)
  }

  /**
   * Refresh sidebar previews for archived conversations and auto-unarchive
   * those with new incoming messages.
   *
   * This is meant to run periodically (e.g., once per day) to detect activity
   * in archived conversations that occurred on other clients while Fluux was
   * offline. When a newer incoming message is found, the conversation is
   * automatically unarchived so it appears in the main sidebar.
   *
   * @param options - Optional configuration
   * @param options.concurrency - Maximum parallel requests (default: 3)
   */
  async refreshArchivedConversationPreviews(options: { concurrency?: number } = {}): Promise<void> {
    const session = this.captureQuery()
    const { concurrency = 3 } = options
    const archivedConversations = this.deps.stores?.chat.getArchivedConversations?.() || []
    if (archivedConversations.length === 0) return

    this.deps.emitSDK('console:event', {
      message: `Checking ${archivedConversations.length} archived conversation(s) for new activity`,
      category: 'sm',
    })

    const conversationIds = archivedConversations.map((c) => c.id)

    await executeWithConcurrency(
      conversationIds,
      (conversationId) => session.isCurrent() ? this.fetchPreviewForConversation(conversationId, { unarchiveIfNewer: true }) : Promise.resolve(),
      concurrency
    )
  }

  /**
   * Background catch-up for all non-archived conversations.
   *
   * After being offline, this fetches the full message history (not just previews)
   * for all conversations so messages are ready when the user opens them.
   *
   * Uses forward queries from the newest cached message, matching the proven
   * pattern from sideEffects' lazy MAM loading. Runs with low concurrency
   * to avoid overwhelming the server.
   *
   * @param options - Optional configuration
   * @param options.concurrency - Maximum parallel requests (default: 2)
   * @param options.exclude - Conversation ID to skip (e.g., the active conversation already handled by side effects)
   * @param options.sessionStartTime - Epoch ms of the current fresh session; forward cursor
   *   excludes messages received this session so a live message can't poison it (see Bug A).
   */
  async catchUpAllConversations(options: { concurrency?: number; exclude?: string | null; sessionStartTime?: number } = {}): Promise<void> {
    const { concurrency = 2, exclude, sessionStartTime } = options
    let conversations = this.deps.stores?.chat.getAllConversations() || []
    if (exclude) {
      conversations = conversations.filter((c) => c.id !== exclude)
    }
    if (conversations.length === 0) return

    logInfo(`Background catch-up for ${conversations.length} conversation(s)`)

    this.deps.emitSDK('console:event', {
      message: `Background catch-up for ${conversations.length} conversation(s)`,
      category: 'sm',
    })

    await executeWithConcurrency(
      conversations,
      async (conv) => {
        try {
          // Skip if disconnected (avoid queuing doomed queries)
          if (this.deps.stores?.connection.getStatus() !== 'online') return

          // Read the newest cached messages to compute a proper forward cursor — a
          // PURE read (peek) that does NOT populate the store. Background catch-up
          // runs for NON-active conversations; only the active one is resident in
          // RAM, and mergeMAMMessages persists results to IndexedDB. We still need
          // the cached messages (not just the persisted preview timestamp) so the
          // cursor lands on the newest PRE-session message and fills the whole gap.
          const cached = (await this.deps.stores?.chat.loadMessagesFromCache?.(conv.id, { limit: MAM_CACHE_LOAD_LIMIT, peek: true })) as Array<{ timestamp?: Date }> | undefined
          // `cached` (the pure peek read) is the cursor source; fall back to the
          // conversation's resident messages (empty for an evicted non-active
          // conversation in production) only when the cache read is empty —
          // mirroring the prior `|| conv.messages || []` chain.
          const messages = cached && cached.length > 0 ? cached : (conv.messages ?? [])
          await this.catchUpConversationHistory(conv.id, messages, { sessionStartTime, stitchReadPointer: true })
        } catch (_error) {
          // Silently ignore — individual failures shouldn't affect others
        }
      },
      concurrency
    )

    logInfo(`Background catch-up for ${conversations.length} conversation(s) — complete`)
  }

  /**
   * Latest-first catch-up orchestrator for one 1:1 conversation, shared by the
   * active-conversation side effect and background sync.
   *
   * PHASE A — align to live:
   *   cache has messages → forward from the contiguous local edge, capped at
   *   MAM_CATCHUP_FORWARD_BAIL_PAGES (exact and cheap in the common reconnect
   *   case). Incomplete → the gap is long: BAIL with a `before:''` fetch-latest
   *   so the window jumps to the live edge. The incomplete forward records the
   *   gap and the fetch-latest reconciliation (#1019 seam machinery) keeps it
   *   honest as ONE interval, closed lazily. Empty cache → fetch-latest
   *   directly (recent history renders in one round-trip).
   *
   * PHASE B — grow to the read pointer (opt-in, background entities only):
   *   while the XEP-0490 pointer is unresolved, page BACKWARD from the window
   *   bottom. Backward growth keeps held history contiguous BY CONSTRUCTION
   *   (each page is adjacent to the window — no second hole can form), each
   *   merge shrinks the recorded seam (closeGapWithBackwardPage), and the page
   *   containing the pointer's own message resolves it (RSM `after` would
   *   never fetch its anchor). Resolution recomputes exact unread. Stops on:
   *   resolution, a live-edge descent reaching archive start (the unchanged
   *   pending marker is discarded and remembered for this session), missing
   *   cursor, or MAM_POINTER_STITCH_MAX_PAGES (deeper pointers converge across
   *   passes from the deeper cache). Archive start reached from a cache seed is
   *   inconclusive because the marker may still be inside the cached interval.
   *
   *   NOT run for the active entity: backward pages into its capped resident
   *   window would keep-oldest-evict the live edge under the user; the
   *   activation machinery (load-around + entry fold + spec §5 degrade) owns
   *   the active deep-pointer UX.
   *
   * Merges run synchronously inside each query's emit, so reading the pending
   * pointer between queries observes the previous merge's resolution — for
   * non-resident entities too (mergedForMarker override).
   */
  async catchUpConversationHistory(
    conversationId: string,
    messages: Array<{ timestamp?: Date; stanzaId?: string }>,
    options: { sessionStartTime?: number; stitchReadPointer?: boolean } = {},
  ): Promise<void> {
    await this.runCatchUpHistory(messages, options, {
      getGapStart: () => this.deps.stores?.chat.getConversationGapStart?.(conversationId),
      getGapStartId: () => this.deps.stores?.chat.getConversationGapStartId?.(conversationId),
      getGapEndId: () => this.deps.stores?.chat.getConversationGapEndId?.(conversationId),
      getCoverageBottomId: () => this.deps.stores?.chat.getConversationCoverage?.(conversationId)?.bottomId,
      getCoverageUnproven: () => this.deps.stores?.chat.getConversationCoverageUnproven?.(conversationId),
      getPendingStanzaId: () => this.deps.stores?.chat.getConversationPendingStanzaId?.(conversationId),
      markPendingPurged: (stanzaId) =>
        this.deps.stores?.chat.discardPurgedRemoteDisplayed?.(conversationId, stanzaId),
      isActive: () => this.deps.stores?.chat.getActiveConversationId?.() === conversationId,
      probeCacheBottom: async () =>
        ((await this.deps.stores?.chat.loadMessagesFromCache(conversationId, {
          limit: MAM_POINTER_SEED_PROBE_LIMIT,
          peek: true,
          oldest: true,
        })) ?? []) as Array<{ timestamp?: Date; stanzaId?: string }>,
      query: (opts) => this.queryArchive({ with: conversationId, ...opts }),
    })
  }

  /**
   * Discover new conversations from roster contacts.
   *
   * Roster contacts who sent messages while the user was offline won't have
   * a conversation entry in the store. This method queries MAM for each roster
   * contact that doesn't already have a conversation, creating conversation
   * entries for those with messages.
   *
   * Uses a preview-style query (max=5) to keep it lightweight — the full
   * catch-up will be handled by the next connection cycle or lazy loading
   * when the user opens the conversation.
   *
   * @param options - Optional configuration
   * @param options.concurrency - Maximum parallel requests (default: 2)
   */
  async discoverNewConversationsFromRoster(options: { concurrency?: number } = {}): Promise<void> {
    const { concurrency = 2 } = options
    const contacts = this.deps.stores?.roster.sortedContacts() || []
    if (contacts.length === 0) return

    // Filter to contacts that don't already have a conversation (active or archived)
    const newContacts = contacts.filter(
      (contact) => !this.deps.stores?.chat.hasConversation(contact.jid)
    )
    if (newContacts.length === 0) return

    logInfo(`Roster discovery for ${newContacts.length} contact(s)`)

    this.deps.emitSDK('console:event', {
      message: `Discovering conversations for ${newContacts.length} roster contact(s)`,
      category: 'sm',
    })

    await executeWithConcurrency(
      newContacts,
      async (contact) => {
        try {
          if (this.deps.stores?.connection.getStatus() !== 'online') return

          const result = await this.queryArchive({
            with: contact.jid,
            before: '',
            max: 5,
          })

          // Create conversation entity so it appears in the sidebar.
          // mergeMAMMessages (triggered by queryArchive's chat:mam-messages event)
          // already stored the messages but couldn't set lastMessage without an existing entity.
          if (result.messages.length > 0 && !this.deps.stores?.chat.hasConversation(contact.jid)) {
            const lastMsg = result.messages[result.messages.length - 1]
            this.deps.emitSDK('chat:conversation', {
              conversation: {
                id: contact.jid,
                name: contact.name || getLocalPart(contact.jid),
                type: 'chat' as const,
                unreadCount: 0,
                lastMessage: lastMsg,
              },
            })
          }
        } catch (_error) {
          // Silently ignore — individual failures shouldn't affect others
        }
      },
      concurrency
    )

    logInfo(`Roster discovery complete for ${newContacts.length} contact(s)`)
  }

  /**
   * Forward catch-up for a single joined room (cache-aware, shared cursor policy).
   *
   * The caller owns room selection and fan-out (joined, MAM, non-Quick-Chat, not
   * the active room, confirmed join this session); `backgroundSync` runs the
   * fresh-session pass and the SM-resume seed on top of this.
   *
   * @param roomJid - Room JID to catch up
   * @param sessionStartTime - Epoch ms of the current session; forward cursor
   *   excludes messages received this session (see `selectCatchUpQuery`).
   */
  async catchUpRoom(roomJid: string, sessionStartTime?: number): Promise<void> {
    if (this.deps.stores?.connection.getStatus() !== 'online') return

    // Read the newest cached messages to compute a proper forward cursor — a PURE
    // read (`peek`) that does NOT populate the store. Background catch-up runs only
    // for NON-active rooms (the active room is excluded), and the invariant is that
    // only the active room is resident in RAM; mergeRoomMAMMessages persists the
    // fetched history to IndexedDB. Without `peek`, every synced room would hold
    // ~MAM_CACHE_LOAD_LIMIT messages in RAM. We still need the cached messages (not
    // just the persisted preview timestamp) so the cursor lands on the newest
    // PRE-session message and the forward query fills the whole offline gap.
    const messages = (await this.deps.stores?.room.loadMessagesFromCache(roomJid, { limit: MAM_CACHE_LOAD_LIMIT, peek: true })) || []
    await this.catchUpRoomHistory(roomJid, messages, { sessionStartTime, stitchReadPointer: true })
  }

  /** Room twin of {@link catchUpConversationHistory} — same Phase A/B over queryRoomArchive. */
  async catchUpRoomHistory(
    roomJid: string,
    messages: Array<{ timestamp?: Date; stanzaId?: string }>,
    options: { sessionStartTime?: number; stitchReadPointer?: boolean } = {},
  ): Promise<void> {
    await this.runCatchUpHistory(messages, options, {
      getGapStart: () => this.deps.stores?.room.getRoomGapStart?.(roomJid),
      getGapStartId: () => this.deps.stores?.room.getRoomGapStartId?.(roomJid),
      getGapEndId: () => this.deps.stores?.room.getRoomGapEndId?.(roomJid),
      getCoverageBottomId: () => this.deps.stores?.room.getRoomCoverage?.(roomJid)?.bottomId,
      getCoverageUnproven: () => this.deps.stores?.room.getRoomCoverageUnproven?.(roomJid),
      getPendingStanzaId: () => this.deps.stores?.room.getRoomPendingStanzaId?.(roomJid),
      markPendingPurged: (stanzaId) =>
        this.deps.stores?.room.discardPurgedRemoteDisplayed?.(roomJid, stanzaId),
      isActive: () => this.deps.stores?.room.getActiveRoomJid() === roomJid,
      probeCacheBottom: async () =>
        ((await this.deps.stores?.room.loadMessagesFromCache(roomJid, {
          limit: MAM_POINTER_SEED_PROBE_LIMIT,
          peek: true,
          oldest: true,
        })) ?? []) as Array<{ timestamp?: Date; stanzaId?: string }>,
      query: (opts) => this.queryRoomArchive({ roomJid, ...opts }),
    })
  }

  /**
   * Shared Phase A/B catch-up core behind {@link catchUpConversationHistory}
   * and {@link catchUpRoomHistory} — the full behavioral contract is documented
   * on the chat adapter. The `io` seam carries the only per-entity differences:
   * store getters (gap seam, XEP-0490 pending pointer, active-entity check),
   * the true-cache-bottom probe, and the archive query transport.
   */
  private async runCatchUpHistory(
    messages: Array<{ timestamp?: Date; stanzaId?: string }>,
    options: { sessionStartTime?: number; stitchReadPointer?: boolean },
    io: {
      getGapStart: () => number | undefined
      getGapStartId: () => string | undefined
      getGapEndId: () => string | undefined
      getCoverageBottomId: () => string | undefined
      getCoverageUnproven: () => boolean | undefined
      getPendingStanzaId: () => string | undefined
      /**
       * Record that the still-pending XEP-0490 marker is not in this entity's
       * archive. Called ONLY where the server proved it: a query that reported
       * `complete` — archive start reached — with the marker still pending.
       */
      markPendingPurged: (stanzaId: string) => void
      isActive: () => boolean
      probeCacheBottom: () => Promise<Array<{ timestamp?: Date; stanzaId?: string }>>
      query: (opts: {
        max: number
        before?: string
        after?: string
        start?: string
        maxAutoPages?: number
      }) => Promise<{ complete: boolean; page: { first?: string }; degradedToFetchLatest?: boolean }>
    },
  ): Promise<void> {
    const { sessionStartTime, stitchReadPointer = false } = options
    const q = selectCatchUpQuery(messages, {
      sessionStartTime,
      forwardGapTimestamp: io.getGapStart(),
      forwardGapStartId: io.getGapStartId(),
    })
    const isForward = !!(q.start || q.after)
    const frozenProofTargetStanzaId = stitchReadPointer
      ? io.getPendingStanzaId()
      : undefined

    // Phase A — align to live, anchored on the COVERAGE pointer (id-exact
    // when available; `after` here is the local downloaded edge, never the
    // XEP-0490 read pointer).
    const initial = await io.query({
      ...q,
      max: isForward ? MAM_CATCHUP_FORWARD_MAX : MAM_CATCHUP_BACKWARD_MAX,
      ...(isForward ? { maxAutoPages: MAM_CATCHUP_FORWARD_BAIL_PAGES } : {}),
    })
    let windowBottom: string | undefined
    let windowBottomDescendedFromLiveEdge = false
    // Whether the query that established `windowBottom` reported complete:
    // true — i.e. it exhausted the archive rather than merely landing on an
    // intermediate page. Used below to skip a pointless Phase B walk.
    let windowBottomComplete = false
    if (initial.degradedToFetchLatest) {
      // Phase A's forward query hit a purged after-anchor (item-not-found)
      // and queryArchive/queryRoomArchive already retried it internally as a
      // before:'' fetch-latest — `initial` IS that fetch-latest page. Treat
      // it as the fetch-latest phase directly instead of issuing a second,
      // fully-deduped `before: ''` bail query.
      windowBottom = initial.page.first
      windowBottomDescendedFromLiveEdge = true
      windowBottomComplete = initial.complete
    } else if (isForward && !initial.complete) {
      const latest = await io.query({ max: MAM_CATCHUP_BACKWARD_MAX, before: '' })
      windowBottom = latest.page.first
      windowBottomDescendedFromLiveEdge = true
      windowBottomComplete = latest.complete
    } else if (!isForward) {
      windowBottom = initial.page.first
      windowBottomDescendedFromLiveEdge = true
      windowBottomComplete = initial.complete
    }
    // (forward && complete → contiguous to live over the cache; a pending
    // pointer, if any, lives in the cache and the activation machinery
    // resolves it — no backward growth needed.)

    /**
     * Terminal outcome for the pointer stitch: the archive answered and does
     * not hold the pending marker.
     *
     * ONLY the two archive-exhausting outcomes reach this. Running out of page
     * budget (`MAM_POINTER_STITCH_MAX_PAGES`), an `isActive()` bail and a
     * seedless pass all prove nothing — we merely stopped looking — and they
     * leave the marker pending so a later session retries it. Treating those as
     * absence would discard a real read position.
     */
    const concludePurged = (): void => {
      if (!frozenProofTargetStanzaId) return
      if (io.getPendingStanzaId() !== frozenProofTargetStanzaId) return
      io.markPendingPurged(frozenProofTargetStanzaId)
    }

    // Phase B — grow the window down to the read pointer.
    if (!stitchReadPointer) return
    // The fetch-latest that established `windowBottom` already exhausted the
    // archive (complete: true) — nothing older exists, so a still-pending
    // pointer was purged rather than merely deep. Walking backward from
    // windowBottom would just issue one wasted page (the server would report
    // complete: true again). Skip the walk. This does NOT apply to the
    // cache-bottom-probe seed below — a pointer below the cache bottom is a
    // different situation, unrelated to whether a fetch-latest here exhausted
    // the archive.
    if (windowBottomComplete) {
      // Every query that can set this flag is archive-exhausting — a `before: ''`
      // fetch-latest, or a forward query that degraded into one — so `complete`
      // here means the whole archive was returned. Merges run synchronously
      // inside each query's emit, so a marker still pending after it was not in
      // the archive at all.
      concludePurged()
      return
    }
    // Cross-session convergence: Phase A can end forward-complete with no
    // fetch-latest (windowBottom unset) while the pointer is still pending —
    // e.g. the session after a capped Phase B walk, whose coverage edge is
    // already near live. Seed the backward cursor from the TRUE cache bottom:
    // an oldest-N pure read (ascending), first message WITH an archive id.
    // Each pass then descends genuinely below all prior coverage — never
    // re-fetching already-cached pages — so a deep pointer converges across
    // sessions and a purged one terminates at the archive-start `complete`.
    // (The `messages` peek param is the NEWEST-100 slice and would pin the
    // seed ~100 below live forever; it remains only the cacheless fallback.)
    if (!windowBottom && io.getPendingStanzaId()) {
      // Contiguous coverage bottom: prefer the recorded gap's proven upper
      // edge, else the persisted coverage record (positive data that survives
      // fresh sessions and gap closure). Seeding from it (not
      // the global-oldest cache row) keeps the backward walk inside the
      // contiguous region — a disjoint search/context island (with or without
      // a recorded gap) cannot mis-seed the descent.
      const seamBottom = io.getGapEndId() ?? io.getCoverageBottomId()
      if (seamBottom) {
        windowBottom = seamBottom
        windowBottomDescendedFromLiveEdge = false
      } else if (!io.getCoverageUnproven()) {
        const bottom = await io.probeCacheBottom()
        windowBottom = bottom.find((m) => m.stanzaId)?.stanzaId
          ?? oldestMessageWithStanzaId(messages)?.stanzaId
        windowBottomDescendedFromLiveEdge = false
      }
      // else: no gap edge AND coverage unproven → the cache bottom isn't provably
      // contiguous with live (a disjoint fetch-latest landed above held-below
      // history without anchoring a seam); leave windowBottom undefined so Phase B
      // no-ops this pass. A later fetch-latest that establishes a real boundary
      // lets the next pass descend.
    }
    for (let page = 0; page < MAM_POINTER_STITCH_MAX_PAGES; page++) {
      // Re-check activity EVERY iteration, not just at dispatch: a walk is up
      // to MAM_POINTER_STITCH_MAX_PAGES RTTs, and once the entity is opened
      // its resident window is capped — further backward pages would
      // keep-oldest-evict the live edge under the user. The activation
      // machinery owns the active deep-pointer UX (see the Phase B doc above).
      if (io.isActive()) return
      if (!frozenProofTargetStanzaId) return
      if (io.getPendingStanzaId() !== frozenProofTargetStanzaId) return
      if (!windowBottom) return
      const res = await io.query({
        before: windowBottom,
        max: MAM_CATCHUP_FORWARD_MAX,
      })
      if (!res.page.first || res.page.first === windowBottom) return
      if (res.complete) {
        if (windowBottomDescendedFromLiveEdge) concludePurged()
        return
      }
      windowBottom = res.page.first
    }
  }

  /**
   * Force a full MAM catch-up for all joined rooms over a given time window.
   *
   * Unlike `catchUpRoom()` which starts from the newest cached message,
   * this method queries from a fixed start date (default: 45 days ago) to
   * fill any gaps left by previous incomplete catch-ups. The store's merge
   * logic deduplicates messages that already exist.
   *
   * Manual recovery tool for repairing a local archive (sidebar "Catch up all
   * rooms"); expected to be removed once catch-up is proven reliable. Because it
   * is a *bounded* repair (a fixed window, not the contiguous edge), it sets
   * `preserveGapMarker` so a windowed completion can't hide a real gap older than
   * the window or plant a spurious one inside it. The 45-day default covers a
   * realistic "app closed for ~a month" absence.
   *
   * @param options.days - Number of days to catch up (default: 45)
   * @param options.concurrency - Max concurrent MAM queries (default: 2)
   */
  async forceCatchUpAllRooms(options: { days?: number; concurrency?: number } = {}): Promise<void> {
    const { days = 45, concurrency = 2 } = options
    const joinedRooms = this.deps.stores?.room.joinedRooms() || []
    const mamRooms = joinedRooms.filter((r) => r.supportsMAM && !r.isQuickChat)
    if (mamRooms.length === 0) return

    const start = new Date(Date.now() - days * 86_400_000).toISOString()

    logInfo(`Force catch-up for ${mamRooms.length} room(s) from last ${days} days`)
    this.deps.emitSDK('console:event', {
      message: `Force catch-up for ${mamRooms.length} room(s) from last ${days} days`,
      category: 'sm',
    })

    await executeWithConcurrency(
      mamRooms,
      async (room) => {
        try {
          if (this.deps.stores?.connection.getStatus() !== 'online') return

          await this.queryRoomArchive({
            roomJid: room.jid,
            start,
            max: MAM_CATCHUP_FORWARD_MAX,
            maxAutoPages: MAM_ROOM_FORWARD_MAX_PAGES_MANUAL,
            preserveGapMarker: true,
          })
        } catch (_error) {
          // Silently ignore — individual failures shouldn't affect others
        }
      },
      concurrency
    )

    logInfo(`Force catch-up for ${mamRooms.length} room(s) — complete`)
  }

  /**
   * Fetch the latest message for a single conversation (preview only).
   * Updates lastMessage without affecting message history.
   *
   * @param conversationId - The bare JID of the conversation
   * @param options - Optional behavior overrides
   * @param options.unarchiveIfNewer - If true, unarchive the conversation when a newer incoming message is found
   */
  private async fetchPreviewForConversation(
    conversationId: string,
    options: { unarchiveIfNewer?: boolean } = {}
  ): Promise<void> {
    const session = this.captureQuery()
    try {
      const queryId = `preview_${generateUUID()}`

      // Build form fields with 'with' filter for 1:1 conversations
      const formFields: Element[] = [
        xml('field', { var: 'FORM_TYPE', type: 'hidden' }, xml('value', {}, NS_MAM)),
        xml('field', { var: 'with' }, xml('value', {}, conversationId)),
      ]

      // Query with max=5 to find a displayable message (reactions/corrections are skipped)
      // This handles the case where recent messages are modifications that can't be previewed
      const iq = this.buildMAMQuery(queryId, formFields, 5, '')

      // Buffer raw entries and decrypt each BEFORE parsing (mirrors the
      // catch-up drain loop). Parsing an encrypted entry without decrypting
      // first surfaces the sender's cleartext XEP-0380/0428 fallback body
      // (e.g. "[OpenPGP-encrypted message]") as the sidebar preview — and for
      // our own sent messages that never self-heals via the deferred-decrypt
      // path (the local echo carries no stashed encryptedPayload), so the
      // preview stayed stuck on the fallback until the conversation was opened.
      const rawEntries: RawArchiveEntry[] = []
      const collectMessage = this.createMessageCollector(queryId, (forwarded, messageEl, archiveId) => {
        rawEntries.push({ forwarded, messageEl, archiveId })
      })

      // Use the collector registry if available, otherwise fall back to direct listeners
      let unregister: () => void
      if (this.deps.registerMAMCollector) {
        unregister = this.deps.registerMAMCollector(queryId, collectMessage)
      } else {
        const xmpp = this.deps.getXmpp()
        xmpp?.on('stanza', collectMessage)
        unregister = () => xmpp?.removeListener('stanza', collectMessage)
      }

      try {
        const response = await this.deps.sendIQ(iq)
        session.assertCurrent()

        let latestMessage: Message | null = null
        for (const { forwarded, messageEl, archiveId } of rawEntries) {
          const forwardedTimestamp = this.extractForwardedTimestamp(forwarded)
          await this.decryptArchiveEntryIfNeeded(messageEl, conversationId, forwardedTimestamp)
          session.assertCurrent()
          const msg = this.parseArchiveMessage(forwarded, conversationId, archiveId)
          if (msg) latestMessage = msg
        }

        const message = latestMessage
        session.assertCurrent()
        if (response && message) {
          // For archived conversations: check if we should unarchive BEFORE updating preview
          // (updateLastMessagePreview uses shouldUpdateLastMessage internally)
          if (options.unarchiveIfNewer && !message.isOutgoing) {
            const existingLastMessage = this.deps.stores?.chat.getLastMessage?.(conversationId)
            const existingTime = existingLastMessage?.timestamp?.getTime() ?? 0
            const newTime = message.timestamp?.getTime() ?? 0
            if (newTime > existingTime) {
              this.deps.stores?.chat.unarchiveConversation?.(conversationId)
            }
          }

          // Update only the lastMessage preview, not the message history
          session.assertCurrent()
          this.deps.stores?.chat.updateLastMessagePreview(conversationId, message)
        }
      } finally {
        unregister()
      }
    } catch (_error) {
      // Silently ignore errors - preview refresh is best-effort
      // Individual conversation failures shouldn't affect others
    }
  }

  /**
   * Refresh sidebar previews for all joined rooms by fetching the latest message.
   *
   * After being offline or auto-joining rooms, the lastMessage preview may be stale.
   * This method fetches `max=1` from MAM for each room that supports MAM to update
   * the sidebar preview without affecting the message history.
   *
   * @param options - Optional configuration
   * @param options.concurrency - Maximum parallel requests (default: 3)
   */
  async refreshRoomPreviews(options: { concurrency?: number } = {}): Promise<void> {
    const session = this.captureQuery()
    const { concurrency = 3 } = options
    // Get all joined rooms (skip QuickChat rooms)
    const joinedRooms = this.deps.stores?.room.joinedRooms() || []
    const nonQuickChatRooms = joinedRooms.filter((r) => !r.isQuickChat)
    if (nonQuickChatRooms.length === 0) return

    // Separate rooms by MAM support
    const mamRooms = nonQuickChatRooms.filter((r) => r.supportsMAM)
    const nonMamRooms = nonQuickChatRooms.filter((r) => !r.supportsMAM)

    this.deps.emitSDK('console:event', {
      message: `Refreshing previews for ${mamRooms.length} MAM room(s), ${nonMamRooms.length} non-MAM room(s)`,
      category: 'sm',
    })

    // For MAM rooms: fetch preview via MAM query
    const mamRoomJids = mamRooms.map((r) => r.jid)
    await executeWithConcurrency(
      mamRoomJids,
      (roomJid) => session.isCurrent() ? this.fetchPreviewForRoom(roomJid) : Promise.resolve(),
      concurrency
    )

    // For non-MAM rooms: load preview from cache to populate lastMessage
    // This only updates lastMessage without modifying the messages array
    for (const room of nonMamRooms) {
      if (!session.isCurrent()) return
      if (!room.lastMessage) {
        await this.deps.stores?.room.loadPreviewFromCache(room.jid)
      }
    }
  }

  /**
   * Fetch the latest message for a single room (preview only).
   * Updates lastMessage without affecting message history.
   *
   * This is called automatically when a room is successfully joined
   * to populate the sidebar preview immediately.
   *
   * @param roomJid - The bare JID of the room
   */
  async fetchPreviewForRoom(roomJid: string): Promise<void> {
    const session = this.captureQuery()
    try {
      // Cache-first: try loading preview from IndexedDB before making a network query.
      // The delayed background room catch-up will correct the preview later if stale.
      const cached = await this.deps.stores?.room.loadPreviewFromCache(roomJid)
      session.assertCurrent()
      if (cached) return

      const queryId = `preview_${generateUUID()}`

      // Room MAM doesn't need a 'with' filter
      const formFields: Element[] = [
        xml('field', { var: 'FORM_TYPE', type: 'hidden' }, xml('value', {}, NS_MAM)),
      ]

      // Query with max=30 to find a displayable message (reactions/corrections/markers are skipped)
      // High-traffic rooms may have many non-displayable messages (reactions, read markers, etc.)
      // so we request more to increase the chance of finding a message with actual body text
      const iq = this.buildMAMQuery(queryId, formFields, 30, '', roomJid)

      const room = this.deps.stores?.room.getRoom(roomJid)
      const myNickname = room?.nickname || ''
      let latestMessage: RoomMessage | null = null

      const collectMessage = this.createMessageCollector(queryId, (forwarded, _messageEl, archiveId) => {
        const msg = this.parseRoomArchiveMessage(forwarded, roomJid, myNickname, archiveId)
        if (msg) latestMessage = msg
      })

      // Use the collector registry if available, otherwise fall back to direct listeners
      let unregister: () => void
      if (this.deps.registerMAMCollector) {
        unregister = this.deps.registerMAMCollector(queryId, collectMessage)
      } else {
        const xmpp = this.deps.getXmpp()
        xmpp?.on('stanza', collectMessage)
        unregister = () => xmpp?.removeListener('stanza', collectMessage)
      }

      try {
        const response = await this.deps.sendIQ(iq)
        session.assertCurrent()
        if (response && latestMessage) {
          // Update only the lastMessage preview, not the message history
          this.deps.stores?.room.updateLastMessagePreview(roomJid, latestMessage)
        }
      } finally {
        unregister()
      }
    } catch (_error) {
      // Silently ignore errors - preview refresh is best-effort
    }
  }

  // --- Private Helpers ---

  /**
   * Build MAM query IQ stanza with RSM pagination.
   *
   * @param queryId - Unique query identifier
   * @param formFields - Data form fields for filtering
   * @param max - Maximum results to return
   * @param before - RSM cursor for backward pagination (empty = latest, ID = before that ID)
   * @param toJid - Optional JID to send query to (for room MAM)
   * @param after - RSM cursor for forward pagination (get messages after this ID)
   */
  private buildMAMQuery(
    queryId: string,
    formFields: Element[],
    max: number,
    before?: string,
    toJid?: string,
    after?: string
  ): Element {
    const rsmChildren: Element[] = [xml('max', {}, String(max))]

    // RSM pagination: before and after are mutually exclusive
    if (after) {
      // Forward pagination: get messages after this ID
      rsmChildren.push(xml('after', {}, after))
    } else if (before === '') {
      // Empty before = get latest messages (backward from end)
      rsmChildren.push(xml('before', {}))
    } else if (before) {
      // Backward pagination: get messages before this ID
      rsmChildren.push(xml('before', {}, before))
    }

    const iqAttrs: Record<string, string> = { type: 'set', id: queryId }
    if (toJid) {
      iqAttrs.to = toJid
    }

    return xml(
      'iq',
      iqAttrs,
      xml(
        'query',
        { xmlns: NS_MAM, queryid: queryId },
        xml('x', { xmlns: NS_DATA_FORMS, type: 'submit' }, ...formFields),
        xml('set', { xmlns: NS_RSM }, ...rsmChildren)
      )
    )
  }

  /**
   * Create a stanza collector function that processes MAM result messages.
   */
  private createMessageCollector(
    queryId: string,
    onMessage: (forwarded: Element, messageEl: Element, archiveId?: string) => void
  ): (stanza: Element) => void {
    const session = this.captureQuery()
    return (stanza: Element) => {
      if (!session.isCurrent()) return
      // Skip error stanzas - server may return error with stale MAM result inside
      if (stanza.attrs.type === 'error') return

      const result = stanza.getChild('result', NS_MAM)
      if (!result || result.attrs.queryid !== queryId) return

      const forwarded = result.getChild('forwarded', NS_FORWARD)
      if (!forwarded) return

      const messageEl = forwarded.getChild('message')
      if (!messageEl) return

      // The <result id="..."> is the MAM archive ID — stable and unique per message
      this.correctionReceipts.observe(messageEl, true, result.attrs.id)
      onMessage(forwarded, messageEl, result.attrs.id)
    }
  }

  /**
   * Extract the XEP-0203 delay timestamp from a MAM <forwarded> wrapper.
   * Returns undefined if no delay stamp is present.
   */
  private extractForwardedTimestamp(forwarded: Element): Date | undefined {
    return delayStamp(forwarded.getChild('delay', NS_DELAY))
  }

  /** Collect modifications instead of treating them as standalone messages. */
  private collectModification(
    messageEl: Element,
    modifications: MAMModifications,
    normalizeFrom: (from: string) => string,
    delayEl?: Element,
    expectedStanzaIdBy?: string,
    archiveId?: string
  ): boolean {
    const from = messageEl.attrs.from
    if (!from) return false
    const timestamp = delayStamp(delayEl)

    // Retraction
    const retraction = parseRetractionSignal(messageEl)
    if (retraction?.targetId) {
      modifications.retractions.push({
        targetId: retraction.targetId,
        from: normalizeFrom(from),
        occupantId: messageEl.getChild('occupant-id', NS_OCCUPANT_ID)?.attrs.id,
      })
      return true
    }

    // Correction
    const correction = parseCorrectionSignal(messageEl)
    if (correction?.targetId) {
      const bodyText = messageEl.getChildText('body')
      if (bodyText) {
        // Capture the correction stanza's own stanza-id so replies referencing
        // the corrected version's archive entry can resolve to the original message.
        // XEP-0359: prefer the id stamped by the queried archive (own bare JID
        // for 1:1, room JID for MUC) so it is a valid cross-client reference.
        const correctionStanzaId = parseStanzaId(messageEl, expectedStanzaIdBy) || archiveId
        const revisionStanzaId = parseArchiveStanzaId(messageEl, expectedStanzaIdBy) || archiveId
        const authoredAt = readStashedAuthoredAt(messageEl)
        modifications.corrections.push({
          targetId: correction.targetId,
          from: normalizeFrom(from),
          occupantId: messageEl.getChild('occupant-id', NS_OCCUPANT_ID)?.attrs.id,
          body: bodyText,
          messageEl,
          correctionStanzaId,
          revisionStanzaId,
          ...(delayEl && { delayEl }),
          ...(authoredAt && { authoredAt }),
        })
      }
      return true
    }

    // Fastening (link preview)
    const applyToEl = messageEl.getChild('apply-to', NS_FASTEN)
    if (applyToEl?.attrs.id) {
      modifications.fastenings.push({ targetId: applyToEl.attrs.id, applyToEl })
      return true
    }

    // Reactions (XEP-0444)
    const reactions = parseReactionsSignal(messageEl)
    if (reactions?.targetId) {
      modifications.reactions.push({
        targetId: reactions.targetId,
        from: normalizeFrom(from),
        emojis: reactions.emojis,
        ...(timestamp && { timestamp }),
      })
      return true
    }

    return false
  }

  /**
   * The one target an in-page modification names, through the shared ladder.
   *
   * A page is a single conversation's slice, so the room scoping that separates
   * archives lives in the durable keys rather than here. The caller names the tier
   * order because destructive and non-destructive modifications have different
   * trust requirements.
   *
   * `isAuthor` gates the destructive tiers. A non-authoritative match is a
   * candidate, not proof: after a nick reassignment two occupants share room, nick
   * and client id, so an unauthorized candidate is left for the store to resolve
   * against a wider set rather than consumed here.
   */
  private resolveModificationTarget<T extends Message | RoomMessage>(
    messages: T[],
    targetId: string,
    policy: ResolutionPolicy,
    isAuthor?: (message: T) => boolean
  ): T | undefined {
    const resolution = resolveMessageReference(messages, targetId, policy)
    if (!resolution) return undefined
    if (!isAuthor) return resolution.candidates[0]?.message
    const authored = resolution.candidates.find(({ message }) => isAuthor(message))
    if (authored) return authored.message
    // An authoritative tier names one logical message: an author mismatch there is
    // a rejected modification, not an unresolved one, and must not be replayed
    // against the store.
    return resolution.authoritative ? resolution.candidates[0].message : undefined
  }

  private resolveCorrectionReferenceTarget<T extends Message | RoomMessage>(
    messages: T[], references: CorrectionReferences, actor: MessageActor, isAuthor: (message: T, actor: MessageActor) => boolean,
  ): T | undefined {
    const identity = references.identity
    const matches = messages.filter(message => isAuthor(message, actor) &&
      identity.roomJid === ('roomJid' in message ? message.roomJid : undefined) &&
      identity.conversationId === ('conversationId' in message ? message.conversationId : undefined) &&
      !archiveIdentityConflict(message, identity) &&
      sameLogicalMessage('roomJid' in message ? roomScope(message.roomJid) : CHAT_SCOPE, message, identity))
    return matches.length === 1 ? matches[0] : undefined
  }

  private async applyModifications<T extends Message | RoomMessage>(
    messages: T[],
    modifications: MAMModifications,
    isAuthor: (msg: T, actor: MessageActor) => boolean,
    normalizeReactor?: (from: string) => string,
    archiveOrder = new Map<string, Set<CorrectionOrderGroup>>(),
    lookupReferences?: (targetId: string, actor: MessageActor, messageEl: Element) => Promise<CorrectionReferences | null | undefined> | undefined,
  ): Promise<UnresolvedModifications> {
    const session = this.captureQuery()
    const unresolved: UnresolvedModifications = {
      retractions: [],
      corrections: [],
      fastenings: [],
      reactions: [],
    }

    // Apply corrections
    for (const correction of modifications.corrections) {
      const actor: MessageActor = { actorJid: correction.from, actorOccupantId: correction.occupantId }
      // Corrections accept the sender's XEP-0359 identity claim only when the same author owns the target.
      const resolution = resolveMessageReference(messages, correction.targetId, 'archive-first')
      const candidates = resolution?.candidates.filter(({ message }) => isAuthor(message, actor)) ?? []
      let target: T | undefined = candidates[0]?.message
      if (!target && resolution?.authoritative) continue
      const resolved = target ? candidates.length === 1 ? correctionReferences(target) : null
        : await lookupReferences?.(correction.targetId, actor, correction.messageEl)
      session.assertCurrent()
      if (!target && resolved) target = this.resolveCorrectionReferenceTarget(messages, resolved, actor, isAuthor)
      const data = this.correctionUpdates(target, correction)
      const revision = data.correctionRevision
      const author = correction.occupantId ? [getBareJid(correction.from), correction.occupantId] : correction.from
      const keys = resolved === null ? [] : (resolved?.references ?? [correction.targetId]).map(reference => JSON.stringify([reference, author]))
      const groups = [...new Set(keys.flatMap(key => [...(archiveOrder.get(key) ?? [])]))].filter(group => {
        if (!resolved || !group.identity) return true
        return !archiveIdentityConflict(resolved.identity, group.identity) &&
          !occupantConflict(resolved.identity, group.identity) &&
          resolved.identity.roomJid === group.identity.roomJid &&
          resolved.identity.conversationId === group.identity.conversationId
      })
      const group = groups.length === 1 ? groups[0] : undefined
      const previous = group?.revision
      if (revision && resolved !== null) {
        if (previous && revision.archiveTimestamp !== undefined && revision.archiveTimestamp === previous.archiveTimestamp &&
            !sameCorrection({ correctionRevision: revision }, { correctionRevision: previous })) {
          correction.archivePredecessor = previous
          Object.assign(revision, withCorrectionPredecessor(revision, previous))
        }
        for (const reference of [correction.correctionStanzaId, correction.revisionStanzaId]) {
          if (reference) keys.push(JSON.stringify([reference, author]))
        }
        const ordered: CorrectionOrderGroup = group ?? { revision }
        ordered.revision = revision
        if (resolved) ordered.identity = {
          ...resolved.identity,
          stanzaId: resolved.identity.stanzaId ?? ordered.identity?.stanzaId,
          originId: resolved.identity.originId ?? ordered.identity?.originId,
          occupantId: resolved.identity.occupantId ?? ordered.identity?.occupantId,
        }
        for (const key of keys) {
          const matches = archiveOrder.get(key) ?? new Set<CorrectionOrderGroup>()
          matches.add(ordered)
          archiveOrder.set(key, matches)
        }
      }
      if (target) {
        const updates = resolveCorrectionUpdates(target, data)
        if (updates) Object.assign(target, updates)
        unresolved.corrections.push(correction)
      } else if (!target) {
        unresolved.corrections.push(correction)
      }
    }

    // Apply retractions
    for (const retraction of modifications.retractions) {
      const actor: MessageActor = { actorJid: retraction.from, actorOccupantId: retraction.occupantId }
      // Retractions accept explicit XEP-0359 identity claims, with authorship gating the destructive match.
      const target = this.resolveModificationTarget(messages, retraction.targetId, 'archive-first', (m) => isAuthor(m, actor))
      if (target) {
        const retractionData = applyRetraction(isAuthor(target, actor))
        if (retractionData) {
          target.isRetracted = retractionData.isRetracted
          target.retractedAt = retractionData.retractedAt
          unresolved.retractions.push(retraction)
        }
      } else {
        unresolved.retractions.push(retraction)
      }
    }

    // Apply link previews from fastenings
    for (const fastening of modifications.fastenings) {
      // A sender-controlled origin-id must not shadow a real client or archive id for non-destructive metadata.
      const target = this.resolveModificationTarget(messages, fastening.targetId, 'client-id-first')
      if (target) {
        const linkPreview = parseOgpFastening(fastening.applyToEl)
        if (linkPreview) {
          target.linkPreview = linkPreview
        }
      } else {
        unresolved.fastenings.push(fastening)
      }
    }

    // Apply reactions (XEP-0444)
    // Reactions replace the user's previous reactions on the same message
    for (const reaction of modifications.reactions) {
      // A sender-controlled origin-id must not shadow a real client or archive id for reactions.
      const target = this.resolveModificationTarget(messages, reaction.targetId, 'client-id-first')
      if (target) {
        // Normalize reactor identifier (e.g., extract nick from full MUC JID)
        // to stay consistent with how the store identifies reactors for live reactions
        const reactorId = normalizeReactor ? normalizeReactor(reaction.from) : reaction.from

        // Initialize reactions object if not present
        if (!target.reactions) {
          target.reactions = {}
        }

        // Remove this user from all existing reactions on this message
        for (const emoji of Object.keys(target.reactions)) {
          target.reactions[emoji] = target.reactions[emoji].filter(id => id !== reactorId)
          if (target.reactions[emoji].length === 0) {
            delete target.reactions[emoji]
          }
        }

        // Add the new reactions from this user
        for (const emoji of reaction.emojis) {
          if (!target.reactions[emoji]) {
            target.reactions[emoji] = []
          }
          if (!target.reactions[emoji].includes(reactorId)) {
            target.reactions[emoji].push(reactorId)
          }
        }

        // Clean up empty reactions object
        if (Object.keys(target.reactions).length === 0) {
          target.reactions = undefined
        }
      } else {
        unresolved.reactions.push(reaction)
      }
    }

    return unresolved
  }

  /**
   * Content and provenance for an archived XEP-0308 correction. The caller
   * selects content through resolveCorrectionUpdates at the target boundary.
   *
   * A superseded correction still contributes its stanza-id: a reply or
   * retraction may name the superseded revision's archive entry and must keep
   * resolving. Store events omit `target` so the store resolves against its
   * current row, which may differ from the fetched page.
   */
  private correctionUpdates(
    target: Message | RoomMessage | undefined,
    correction: UnresolvedModifications['corrections'][number],
  ): Partial<StoredMessage> & Partial<StoredRoomMessage> {
    const correctionData = applyCorrection(
      correction.messageEl,
      correction.body,
      target?.originalBody ?? target?.body ?? '',
      {
        archiveId: correction.revisionStanzaId,
        ...(correction.delayEl && { delayEl: correction.delayEl }),
        ...(correction.authoredAt && { authoredAt: correction.authoredAt }),
      },
    )
    if (correctionData.correctionRevision && correction.archivePredecessor) {
      correctionData.correctionRevision = withCorrectionPredecessor(correctionData.correctionRevision, correction.archivePredecessor)
    }
    const existingIds = target ? getCorrectionStanzaIds(target) : undefined
    let correctionStanzaIds = correction.correctionStanzaId
      ? withCorrectionStanzaId(existingIds, correction.correctionStanzaId)
      : existingIds
    if (correction.revisionStanzaId) correctionStanzaIds = withCorrectionStanzaId(correctionStanzaIds, correction.revisionStanzaId)
    if (correctionStanzaIds?.length) correctionData.correctionStanzaIds = correctionStanzaIds
    return this.correctionReceipts.withOrder(correction.messageEl, correctionData)
  }

  private emitUnresolvedChatModifications(
    conversationId: string,
    unresolved: UnresolvedModifications
  ): void {
    for (const retraction of unresolved.retractions) {
      this.deps.emitSDK('chat:retraction-pending', {
        conversationId,
        targetId: retraction.targetId,
        actorJid: retraction.from,
      })
    }

    for (const correction of unresolved.corrections) {
      const updates = this.correctionUpdates(undefined, correction)
      this.deps.emitSDK('chat:message-updated', { conversationId, messageId: correction.targetId, updates, correctionActor: { actorJid: correction.from }, onCorrectionResolved: this.correctionCompletion(conversationId, false) })
    }

    for (const fastening of unresolved.fastenings) {
      const linkPreview = parseOgpFastening(fastening.applyToEl)
      if (linkPreview) {
        this.deps.emitSDK('chat:message-updated', {
          conversationId,
          messageId: fastening.targetId,
          updates: { linkPreview },
        })
      }
    }

    for (const reaction of unresolved.reactions) {
      this.deps.emitSDK('chat:reactions', {
        conversationId,
        messageId: reaction.targetId,
        reactorJid: reaction.from,
        emojis: reaction.emojis,
        isLive: false,
        ...(reaction.timestamp && { timestamp: reaction.timestamp }),
      })
    }
  }

  private emitUnresolvedRoomModifications(
    roomJid: string,
    unresolved: UnresolvedModifications
  ): void {
    for (const retraction of unresolved.retractions) {
      this.deps.emitSDK('room:retraction-pending', {
        roomJid,
        targetId: retraction.targetId,
        actorJid: retraction.from,
        actorOccupantId: retraction.occupantId,
      })
    }

    for (const correction of unresolved.corrections) {
      const updates = this.correctionUpdates(undefined, correction)
      this.deps.emitSDK('room:message-updated', { roomJid, messageId: correction.targetId, updates, correctionActor: { actorJid: correction.from, actorOccupantId: correction.occupantId }, onCorrectionResolved: this.correctionCompletion(roomJid, true) })
    }

    for (const fastening of unresolved.fastenings) {
      const linkPreview = parseOgpFastening(fastening.applyToEl)
      if (linkPreview) {
        this.deps.emitSDK('room:message-updated', {
          roomJid,
          messageId: fastening.targetId,
          updates: { linkPreview },
        })
      }
    }

    for (const reaction of unresolved.reactions) {
      this.deps.emitSDK('room:reactions', {
        roomJid,
        messageId: reaction.targetId,
        reactorNick: getResource(reaction.from) || reaction.from,
        emojis: reaction.emojis,
        isLive: false,
        ...(reaction.timestamp && { timestamp: reaction.timestamp }),
      })
    }
  }

  /**
   * Parse MAM response to extract completion status and RSM info.
   */
  private parseMAMResponse(response: Element): { complete: boolean; page: PageInfo } {
    const fin = response.getChild('fin', NS_MAM)
    const complete = fin?.attrs.complete === 'true'
    const pageInfo = parseRSMResponse(fin?.getChild('set', NS_RSM))
    return { complete, page: pageInfo }
  }

  /**
   * Opportunistically decrypt a 1:1 archive entry in place.
   *
   * Mirrors the live-path hook in {@link Chat.tryHandleEncrypted}: if a
   * registered E2EE plugin claims one of the message's children, the
   * stanza is decrypted, the encrypted element is stripped, the hint
   * `<body>` is replaced with plaintext, and a security context is
   * stashed for {@link parseArchiveMessage} to read.
   *
   * Self-outgoing entries are decrypted just like inbound ones: outbound
   * ciphertexts are encrypted to our own key as well as the peer's, so
   * MAM replay on this device (and on any other device we log in from)
   * can recover the plaintext.
   */
  private async decryptArchiveEntryIfNeeded(
    messageEl: Element,
    peer: string,
    archiveTimestamp?: Date,
  ): Promise<void> {
    const session = this.captureQuery()
    const manager = this.deps.getE2EEManager?.()
    if (!manager) {
      // No E2EE manager yet (archive replayed before E2EE init). Mirror the
      // live path's no-manager handling: stash an EME-tagged payload for
      // deferred retry so it self-heals (decrypts, or is tagged unsupported)
      // once a manager + plugin come online. Cleartext entries are untouched.
      recordUnclaimedEME(messageEl, false)
      return
    }
    // Same helper the live path uses. The passed-in `peer` is kept as
    // an explicit input rather than deriving it here too: room
    // replays come through this function with `roomJid` (which the
    // helper would not produce for a `from = roomJid/nickname`-shaped
    // groupchat message), and our callers already do the right thing
    // for 1:1. We only need the helper to tell us whether this entry
    // is self-outgoing so the plugin can flip its envelope checks.
    const ownBareJid = getBareJid(this.deps.getCurrentJid() ?? '')
    const { isSelfOutgoing } = deriveConversationContext(messageEl, ownBareJid)
    this.correctionReceipts.observe(messageEl, true)
    const finish = this.correctionReceipts.begin(messageEl)
    try {
      await decryptStanzaInPlace(messageEl, manager, peer, 'archive', {
        isSelfOutgoing,
        archiveTimestamp,
      })
      session.assertCurrent()
    } finally {
      finish()
    }
  }

  /**
   * Extract a {@link MessageSecurityContext} from a decrypted archive
   * message, or `undefined` if the entry was cleartext. Mirrors the shape
   * narrowing done in Chat so downstream consumers don't depend on the
   * e2ee module's SecurityContext type.
   */
  private archiveSecurityContext(messageEl: Element): MessageSecurityContext | undefined {
    const stash = readStashedSecurityContext(messageEl)
    if (!stash) return undefined
    return {
      protocolId: stash.protocolId,
      trust: stash.trust,
      ...(stash.notes && { notes: stash.notes }),
      ...(stash.fingerprint && { fingerprint: stash.fingerprint }),
    }
  }

  /**
   * Parse a single archived message for 1:1 conversations.
   */
  private parseArchiveMessage(forwarded: Element, conversationId: string, archiveId?: string): Message | null {
    const messageEl = forwarded.getChild('message')
    const delayEl = forwarded.getChild('delay', NS_DELAY)
    if (!messageEl) return null

    const from = messageEl.attrs.from
    const body = messageEl.getChildText('body')

    // Skip modification messages (retractions, corrections, reactions)
    // These are handled separately by detectAndCollectModification()
    if (isMessageSignal(messageEl)) return null

    if (!from) return null

    // E2EE markers stashed by the preceding decrypt pass. An encrypted entry we
    // could not decrypt (unsupported protocol like OMEMO, or stashed for retry)
    // may carry NO usable <body> — e.g. a client that omits the optional
    // XEP-0380 fallback (notably on its own sent copy). Such an entry must still
    // surface: the UI renders a placeholder from these fields. Dropping it on
    // the "no body" gate silently loses the message — see issue #135.
    const encryptedPayload = readStashedEncryptedPayload(messageEl)
    const unsupportedEncryption = readStashedUnsupportedEncryption(messageEl)
    const hasEncryptedContent = encryptedPayload !== undefined || unsupportedEncryption !== undefined

    // Accept messages with body OR OOB attachment OR encrypted content
    // (file-only messages have no body; encrypted-but-bodiless render a placeholder)
    if (!body && !messageEl.getChild('x', NS_OOB) && !hasEncryptedContent) return null

    const bareFrom = getBareJid(from)
    const ownBareJid = getBareJid(this.deps.getCurrentJid() ?? '')
    const isOutgoing = bareFrom === ownBareJid
    const authoredAt = readStashedAuthoredAt(messageEl)
    const parsed = parseMessageContent({
      messageEl,
      body: body || '',
      delayEl,
      forceDelayed: true,
      // XEP-0359: 1:1 archive — prefer the stanza-id stamped by our own archive.
      expectedStanzaIdBy: ownBareJid,
      ...(authoredAt && { authoredAt }),
    })

    // The raw-<body> gate above passes any non-empty body, but XEP-0428 fallback
    // stripping can leave processedBody='' (e.g. a reply quote with no new text).
    // Drop it rather than store a blank row.
    if (!hasRenderableContent({
      processedBody: parsed.processedBody,
      attachment: parsed.attachment,
      hasEncryptedContent,
    })) {
      return null
    }

    // Use stanza-id from message element, or fall back to MAM archive ID (they're equivalent)
    const stanzaId = parsed.stanzaId || archiveId

    // For message ID: prefer message id attr, then generate stable ID from content
    const messageId = messageEl.attrs.id || generateStableMessageId(from, parsed.timestamp, body || '')

    const securityContext = this.archiveSecurityContext(messageEl)

    return {
      type: 'chat',
      id: messageId,
      ...(stanzaId && { stanzaId }),
      ...(parsed.originId && { originId: parsed.originId }),
      conversationId,
      from: bareFrom,
      body: parsed.processedBody,
      timestamp: parsed.timestamp,
      isOutgoing,
      isDelayed: true,
      ...(parsed.noStyling && { noStyling: parsed.noStyling }),
      ...(parsed.replyTo && { replyTo: parsed.replyTo }),
      ...(parsed.attachment && { attachment: parsed.attachment }),
      ...(securityContext && { securityContext }),
      ...(encryptedPayload && { encryptedPayload }),
      ...(unsupportedEncryption && { unsupportedEncryption }),
    }
  }

  /**
   * Parse a single archived message for MUC rooms.
   */
  private parseRoomArchiveMessage(forwarded: Element, roomJid: string, myNickname: string, archiveId?: string): RoomMessage | null {
    const messageEl = forwarded.getChild('message')
    const delayEl = forwarded.getChild('delay', NS_DELAY)
    if (!messageEl) return null

    const from = messageEl.attrs.from
    const body = messageEl.getChildText('body')

    // Skip modification messages (retractions, corrections, reactions)
    // These are handled separately by detectAndCollectModification()
    if (isMessageSignal(messageEl)) return null

    if (!from) return null

    // E2EE markers stashed by the preceding decrypt pass. An encrypted entry we
    // could not decrypt (unsupported protocol like OMEMO, or stashed for retry)
    // may carry NO usable <body> when the sender omits the optional XEP-0380
    // fallback. It must still surface — the UI renders a placeholder from these
    // fields — rather than being dropped on the "no body" gate. See issue #135.
    const roomEncryptedPayload = readStashedEncryptedPayload(messageEl)
    const roomUnsupportedEncryption = readStashedUnsupportedEncryption(messageEl)
    const hasEncryptedContent = roomEncryptedPayload !== undefined || roomUnsupportedEncryption !== undefined

    // Accept messages with body, OOB attachment, poll elements, or encrypted content
    const hasPoll = !!messageEl.getChild('poll', NS_POLL)
    const hasPollClosed = !!messageEl.getChild('poll-closed', NS_POLL)
    if (!body && !messageEl.getChild('x', NS_OOB) && !hasPoll && !hasPollClosed && !hasEncryptedContent) return null

    const nick = getResource(from) || ''
    // Case-insensitive nickname comparison - some servers may change case
    const isOutgoing = nick.toLowerCase() === myNickname.toLowerCase()
    const roomAuthoredAt = readStashedAuthoredAt(messageEl)
    const parsed = parseMessageContent({
      messageEl,
      body: body || '',
      delayEl,
      forceDelayed: true,
      preserveFullReplyToJid: true,
      messageContext: 'room',
      // XEP-0359: MUC archive — prefer the stanza-id stamped by the room itself.
      expectedStanzaIdBy: roomJid,
      ...(roomAuthoredAt && { authoredAt: roomAuthoredAt }),
    })

    // The raw-<body> gate above passes any non-empty body, but XEP-0428 fallback
    // stripping can leave processedBody='' (e.g. a reply quote with no new text).
    // Such an entry has nothing to render — dropping it here keeps a blank row out
    // of the archive (the "empty Cynthia row" reported from the XSF room).
    if (!hasRenderableContent({
      processedBody: parsed.processedBody,
      attachment: parsed.attachment,
      hasPoll,
      hasPollClosed,
      hasEncryptedContent,
    })) {
      return null
    }

    // Use stanza-id from message element, or fall back to MAM archive ID (they're equivalent)
    const stanzaId = parsed.stanzaId || archiveId

    // For message ID: prefer message id attr, then generate stable ID from content
    const messageId = messageEl.attrs.id || generateStableMessageId(from, parsed.timestamp, body || '')

    // XEP-0421: Anonymous Unique Occupant Identifiers
    const occupantId = messageEl.getChild('occupant-id', NS_OCCUPANT_ID)?.attrs.id

    const roomSecurityContext = this.archiveSecurityContext(messageEl)

    const message: RoomMessage = {
      type: 'groupchat',
      id: messageId,
      ...(stanzaId && { stanzaId }),
      ...(parsed.originId && { originId: parsed.originId }),
      roomJid,
      from,
      nick,
      body: parsed.processedBody,
      timestamp: parsed.timestamp,
      isOutgoing,
      isDelayed: true,
      ...(parsed.noStyling && { noStyling: parsed.noStyling }),
      ...(parsed.replyTo && { replyTo: parsed.replyTo }),
      ...(parsed.attachment && { attachment: parsed.attachment }),
      ...(occupantId && { occupantId }),
      ...(roomSecurityContext && { securityContext: roomSecurityContext }),
      ...(roomEncryptedPayload && { encryptedPayload: roomEncryptedPayload }),
      ...(roomUnsupportedEncryption && { unsupportedEncryption: roomUnsupportedEncryption }),
    }

    // Poll detection: parse <poll> or <poll-closed> elements from archived messages
    if (hasPoll) {
      const pollData = parsePollElement(messageEl.getChild('poll', NS_POLL)!)
      if (pollData) {
        message.poll = pollData
        if (occupantId) message.poll.creatorId = occupantId
      }
    }
    if (hasPollClosed) {
      const pollClosedData = parsePollClosedElement(messageEl.getChild('poll-closed', NS_POLL)!)
      if (pollClosedData) {
        message.pollClosed = pollClosedData
      }
    }
    return message
  }

  /**
   * Fetch a single room message by its ID using MAM.
   *
   * Checks the store first (by both client ID and stanza-id).
   * If not found, queries MAM using the `{urn:xmpp:mam:2}ids` form field.
   *
   * @param roomJid - The room JID
   * @param messageId - The message ID (client ID or stanza-id / archive ID)
   * @returns The message if found, or null
   */
  async fetchRoomMessageById(roomJid: string, messageId: string): Promise<RoomMessage | null> {
    const session = this.captureQuery()
    // Check store first — getMessage checks both id and stanzaId
    const existing = this.deps.stores?.room.getMessage(roomJid, messageId)
    if (existing) return existing

    const room = this.deps.stores?.room.getRoom(roomJid)
    const myNickname = room?.nickname || ''
    const queryId = `mam_${generateUUID()}`

    const formFields: Element[] = [
      xml('field', { var: 'FORM_TYPE', type: 'hidden' }, xml('value', {}, NS_MAM)),
      xml('field', { var: '{urn:xmpp:mam:2}ids' }, xml('value', {}, messageId)),
    ]

    const iq = this.buildMAMQuery(queryId, formFields, 1, undefined, roomJid)

    let rawEntry: RawArchiveEntry | null = null
    const collectMessage = this.createMessageCollector(queryId, (forwarded, messageEl, archiveId) => {
      rawEntry = { forwarded, messageEl, archiveId }
    })

    let unregister: () => void
    if (this.deps.registerMAMCollector) {
      unregister = this.deps.registerMAMCollector(queryId, collectMessage)
    } else {
      const xmpp = this.deps.getXmpp()
      xmpp?.on('stanza', collectMessage)
      unregister = () => xmpp?.removeListener('stanza', collectMessage)
    }

    try {
      await this.deps.sendIQ(iq)
      if (!session.isCurrent()) return null
    } catch {
      // MAM query failed — server may not support {ids} filter
      return null
    } finally {
      unregister!()
    }

    let result: RoomMessage | null = null
    if (rawEntry) {
      const { forwarded, messageEl, archiveId } = rawEntry as RawArchiveEntry
      try {
        await this.decryptArchiveEntryIfNeeded(messageEl, roomJid, this.extractForwardedTimestamp(forwarded))
      } catch (error) {
        if (!session.isCurrent()) return null
        throw error
      }
      if (!session.isCurrent()) return null
      result = this.parseRoomArchiveMessage(forwarded, roomJid, myNickname, archiveId)
    }

    // If found, add to the store so subsequent lookups don't need MAM
    if (result) {
      this.deps.emitSDK('room:message', {
        roomJid,
        message: result,
        isLiveArrival: false,
        incrementUnread: false,
        incrementMentions: false,
      })
    }

    return session.isCurrent() ? result : null
  }
}
