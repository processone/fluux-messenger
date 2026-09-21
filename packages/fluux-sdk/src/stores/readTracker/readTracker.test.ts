import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createReadTracker,
  readFieldsOf,
  type ReadStatePatch,
  type ReadStateView,
  type ReadTrackerKind,
  type ReadTrackerStorage,
} from './index'
import { connectionStore } from '../connectionStore'
import { transientCounts, _clearAllTransientForTesting } from '../shared/transientUnread'

import { makeReadPointer } from '../shared/readPointer'
import type { NotificationMessage } from '../shared/notificationState'
import type { CoverageRecord } from '../../core/types/pagination'
import type { CoverageBottom } from '../shared/mamCoverage'
import { resetDiagnosticsForTesting, subscribeDiagnostics } from '../../diagnostics/channel'
import { _resetStorageScopeForTesting, setStorageScopeJid } from '../../utils/storageScope'
import { _resetPurgedMarkersForTesting, isMarkerPurged, notePurgedMarker } from '../shared/purgedMarkers'
import {
  _clearAllViewportEvidenceForTesting,
  beginViewportGeneration,
  currentViewportEvidence,
  reportViewport,
} from '../shared/viewportEvidence'

const ALICE = 'alice@example.com'
const BOB = 'bob@example.com'

describe.each<ReadTrackerKind>(['chat', 'room'])('read tracker (%s)', (kind) => {
  let archiveReady: boolean
  let recounts: string[]
  let stashedRows: NotificationMessage[] | null
  let publishCandidates: NotificationMessage[]
  let historyCaughtUp: boolean
  let coverage: CoverageRecord | undefined
  let invalidatedCoverage: string[]
  let archiveCount: { unread: number } | null
  let coverageBottom: CoverageBottom
  let archiveReads: number
  let archiveGate: Promise<void> | undefined
  const inertStorage: ReadTrackerStorage = { update: () => {}, read: () => undefined }
  const makeTracker = (storage: ReadTrackerStorage = inertStorage) => createReadTracker(kind, {
    storage,
    recount: (entityId, options) => { recounts.push(options?.allowActive ? `${entityId} (active)` : entityId) },
    loadStashedMarkerRows: async () => stashedRows,
    loadPublishCandidates: async () => publishCandidates,
    historyCaughtUp: () => historyCaughtUp,
    coverageRecord: () => coverage,
    // No record proves nothing: the real resolution answers 'missing' for it.
    resolveCoverageBottom: async (_entityId, record) => (record ? coverageBottom : 'missing'),
    invalidateCoverage: (entityId) => { invalidatedCoverage.push(entityId) },
    countUnreadFromArchive: async () => { archiveReads++; await archiveGate; return archiveCount },
    captureCacheRead: () => () => true,
    archiveReadyForCounting: () => archiveReady,
  })

  beforeEach(() => {
    archiveReady = true
    recounts = []
    stashedRows = null
    publishCandidates = []
    historyCaughtUp = true
    coverage = { bottomId: 'bottom', countBottomId: 'bottom' }
    invalidatedCoverage = []
    archiveReads = 0
    archiveGate = undefined
    archiveCount = { unread: 0 }
    coverageBottom = { timestamp: 1, tiebreak: { kind: 'chat', id: 'bottom' } } as CoverageBottom
    setStorageScopeJid(ALICE)
    connectionStore.getState().setWindowVisible(true)
  })

  afterEach(() => {
    _resetStorageScopeForTesting()
    _resetPurgedMarkersForTesting()
    _clearAllViewportEvidenceForTesting()
    _clearAllTransientForTesting()
  })

  it('keys registries by the current account and its own kind', () => {
    const tracker = makeTracker()
    expect(tracker.scopeKey('e1')).toEqual({ accountScope: ALICE, kind, entityId: 'e1' })
    setStorageScopeJid(BOB)
    expect(tracker.scopeKey('e1')).toEqual({ accountScope: BOB, kind, entityId: 'e1' })
  })

  it('is ready to recount only with a settled archive', () => {
    const tracker = makeTracker()
    expect(tracker.recountReady('e1')).toBe(true)
    archiveReady = false
    expect(tracker.recountReady('e1')).toBe(false)
  })

  it('tears down the outgoing account on a switch, found by the scope recorded at the previous switch', () => {
    const tracker = makeTracker()
    // First switch: nothing recorded yet, so nothing is torn down.
    tracker.resetForAccountSwitch()
    notePurgedMarker(tracker.scopeKey('e1'), 'purged-a')
    const generation = beginViewportGeneration(tracker.scopeKey('e1'))
    reportViewport(tracker.scopeKey('e1'), generation, 'at-edge')

    // The global scope flips to the incoming account before the store switches.
    setStorageScopeJid(BOB)
    notePurgedMarker(tracker.scopeKey('e1'), 'purged-b')
    tracker.resetForAccountSwitch()

    const aliceKey = { accountScope: ALICE, kind, entityId: 'e1' }
    expect(isMarkerPurged(aliceKey, 'purged-a')).toBe(false)
    expect(currentViewportEvidence(aliceKey)).toBe('unknown')
    expect(isMarkerPurged(tracker.scopeKey('e1'), 'purged-b')).toBe(true)
  })

  it('tears down the current account on logout and lets the synced marker fold again', () => {
    const tracker = makeTracker()
    notePurgedMarker(tracker.scopeKey('e1'), 'purged-a')
    tracker.mdsGate.markFolded('e1', 'marker')
    expect(tracker.mdsGate.shouldFold('e1', 'marker')).toBe(false)

    tracker.resetForLogout()

    expect(isMarkerPurged(tracker.scopeKey('e1'), 'purged-a')).toBe(false)
    expect(tracker.mdsGate.shouldFold('e1', 'marker')).toBe(true)
  })

  it('does not tear down the account a logout already cleared at the next switch', () => {
    const tracker = makeTracker()
    tracker.resetForAccountSwitch()
    tracker.resetForLogout()

    setStorageScopeJid(BOB)
    tracker.resetForAccountSwitch()
    notePurgedMarker(tracker.scopeKey('e1'), 'purged-b')
    setStorageScopeJid(ALICE)
    notePurgedMarker(tracker.scopeKey('e1'), 'purged-a')
    setStorageScopeJid(BOB)
    tracker.resetForAccountSwitch()

    // The switch after logout recorded BOB, so this switch tears down BOB only.
    expect(isMarkerPurged({ accountScope: BOB, kind, entityId: 'e1' }, 'purged-b')).toBe(false)
    expect(isMarkerPurged({ accountScope: ALICE, kind, entityId: 'e1' }, 'purged-a')).toBe(true)
  })

  describe('read-state commands', () => {
    const ENTITY = 'e1'
    const messages: NotificationMessage[] = Array.from({ length: 4 }, (_, index) => ({
      id: `m${index}`,
      from: `${ENTITY}/nick${index}`,
      ...(kind === 'room' ? { roomJid: ENTITY } : {}),
      body: `message ${index}`,
      stanzaId: `s${index}`,
      isOutgoing: false,
      timestamp: new Date(1000 + index),
    }))
    const mentions = kind === 'room' ? 2 : 0

    function memoryStorage(overrides: Partial<ReadStateView> = {}) {
      const memory = {
        writes: 0,
        view: {
          readPointer: makeReadPointer(messages[0], kind),
          unreadCount: 3,
          mentionsCount: mentions,
          messages,
          atLiveEdge: true,
          isActive: true,
          divider: { id: 'm1' },
          lastMessage: messages[3],
          pendingRemoteMarker: undefined,
          ...overrides,
        } as ReadStateView,
      }
      const apply = (patch: ReadStatePatch) => {
        const fields = readFieldsOf(patch)
        memory.view = {
          ...memory.view,
          ...(fields?.readPointer && { readPointer: fields.readPointer }),
          ...(fields?.unreadCount !== undefined && { unreadCount: fields.unreadCount }),
          ...(fields?.mentionsCount !== undefined && { mentionsCount: fields.mentionsCount }),
          ...(patch.pendingRemoteMarker !== undefined && { pendingRemoteMarker: fields?.pendingRemoteDisplayedStanzaId }),
          ...(patch.divider !== undefined && { divider: patch.divider ?? undefined }),
          ...(patch.becomesActive ? { isActive: true } : {}),
        }
      }
      const storage: ReadTrackerStorage = {
        read: (entityId) => (entityId === ENTITY ? memory.view : undefined),
        update: (entityId, change) => {
          if (entityId !== ENTITY) return
          const patch = change(memory.view)
          if (!patch) return
          memory.writes++
          apply(patch)
        },
      }
      return { memory, storage }
    }

    function reportAtEdge(tracker: ReturnType<typeof makeTracker>, evidence: 'at-edge' | 'away' = 'at-edge') {
      const key = tracker.scopeKey(ENTITY)
      reportViewport(key, beginViewportGeneration(key), evidence)
    }

    it('ignores what is painted while the window is hidden', () => {
      const { memory, storage } = memoryStorage()
      const tracker = makeTracker(storage)
      reportAtEdge(tracker)
      connectionStore.getState().setWindowVisible(false)
      tracker.advance(ENTITY, { id: 'm3' })
      expect(memory.writes).toBe(0)
      expect(recounts).toEqual([])
    })

    it('advances the pointer on a partial read and asks the archive for the count', () => {
      const { memory, storage } = memoryStorage()
      const tracker = makeTracker(storage)
      reportAtEdge(tracker)
      tracker.advance(ENTITY, { id: 'm1' })
      expect(memory.view.readPointer?.identity.messageId).toBe('m1')
      expect(memory.view.unreadCount).toBe(3)
      expect(memory.view.mentionsCount).toBe(mentions)
      expect(recounts).toEqual([`${ENTITY} (active)`])
    })

    it('clears the counts when the newest row is seen at the live edge, without an archive round trip', () => {
      const { memory, storage } = memoryStorage()
      const tracker = makeTracker(storage)
      reportAtEdge(tracker)
      tracker.advance(ENTITY, { id: 'm3' })
      expect(memory.view.readPointer?.identity.messageId).toBe('m3')
      expect(memory.view.unreadCount).toBe(0)
      expect(memory.view.mentionsCount).toBe(0)
      expect(recounts).toEqual([])
    })

    it('clears a count left over with the pointer already on the newest row', () => {
      const { memory, storage } = memoryStorage({ readPointer: makeReadPointer(messages[3], kind) })
      const tracker = makeTracker(storage)
      reportAtEdge(tracker)
      tracker.advance(ENTITY, { id: 'm3' })
      expect(memory.writes).toBe(1)
      expect(memory.view.unreadCount).toBe(0)
      expect(recounts).toEqual([])

      tracker.advance(ENTITY, { id: 'm3' })
      expect(memory.writes).toBe(1)
    })

    it.each([
      ['the viewport is away from the live edge', { evidence: 'away' as const }],
      ['the resident slice stops short of the newest message', { atLiveEdge: false }],
      ['the entity is not the one being viewed', { isActive: false }],
    ])('does not read through when %s', (_label, setup) => {
      const { evidence = 'at-edge', ...overrides } = setup as { evidence?: 'at-edge' | 'away' } & Partial<ReadStateView>
      const { memory, storage } = memoryStorage(overrides)
      const tracker = makeTracker(storage)
      reportAtEdge(tracker, evidence)
      tracker.advance(ENTITY, { id: 'm3' })
      expect(memory.view.unreadCount).toBe(3)
      expect(memory.view.mentionsCount).toBe(mentions)
    })

    it('reads through a newest row reported without the archive id it carries', () => {
      const archived = messages.map((m, index) => (index === 3 ? { ...m, stanzaId: 'arch-3' } : m))
      const { memory, storage } = memoryStorage({ messages: archived })
      const tracker = makeTracker(storage)
      reportAtEdge(tracker)
      tracker.advance(ENTITY, { id: 'm3' })
      expect(memory.view.unreadCount).toBe(0)
    })

    it('ignores a row absent from the resident slice', () => {
      const { memory, storage } = memoryStorage()
      const tracker = makeTracker(storage)
      reportAtEdge(tracker)
      tracker.advance(ENTITY, { id: 'missing' })
      expect(memory.writes).toBe(0)
      expect(recounts).toEqual([])
    })

    it('never moves the pointer backwards', () => {
      const { memory, storage } = memoryStorage({ readPointer: makeReadPointer(messages[2], kind) })
      const tracker = makeTracker(storage)
      reportAtEdge(tracker)
      tracker.advance(ENTITY, { id: 'm1' })
      expect(memory.writes).toBe(0)
      expect(memory.view.readPointer?.identity.messageId).toBe('m2')
    })

    describe('markAsRead', () => {
      afterEach(() => resetDiagnosticsForTesting())

      it('reads to the newest row and clears the counts at the live edge, keeping the divider', () => {
        const { memory, storage } = memoryStorage()
        const tracker = makeTracker(storage)
        reportAtEdge(tracker)
        tracker.markAsRead(ENTITY)
        expect(memory.view.readPointer?.identity.messageId).toBe('m3')
        expect(memory.view.unreadCount).toBe(0)
        expect(memory.view.mentionsCount).toBe(0)
        expect(memory.view.divider).toEqual({ id: 'm1' })
      })

      it('clears the counts without moving the pointer away from the live edge, and reports the count-only clear', () => {
        const cleared: number[] = []
        const unsubscribe = subscribeDiagnostics((event) => {
          if (event.kind === 'unread-cleared') cleared.push(event.previousCount)
        })
        const { memory, storage } = memoryStorage()
        const tracker = makeTracker(storage)
        reportAtEdge(tracker, 'away')
        tracker.markAsRead(ENTITY)
        unsubscribe()
        expect(memory.view.readPointer?.identity.messageId).toBe('m0')
        expect(memory.view.unreadCount).toBe(0)
        expect(cleared).toEqual([3])
      })

      it('writes nothing when the entity is already read', () => {
        const { memory, storage } = memoryStorage({ unreadCount: 0, mentionsCount: 0 })
        const tracker = makeTracker(storage)
        reportAtEdge(tracker, 'away')
        tracker.markAsRead(ENTITY)
        expect(memory.writes).toBe(0)
      })
    })

    describe('markReadToNewest', () => {
      it('reads to the newest resident row, zeroes the counts and removes the divider, wherever the viewport is', () => {
        const { memory, storage } = memoryStorage({ atLiveEdge: false })
        const tracker = makeTracker(storage)
        reportAtEdge(tracker, 'away')
        tracker.markReadToNewest(ENTITY)
        expect(memory.view.readPointer?.identity.messageId).toBe('m3')
        expect(memory.view.unreadCount).toBe(0)
        expect(memory.view.mentionsCount).toBe(0)
        expect(memory.view.divider).toBeUndefined()
        expect(recounts).toEqual([])
      })

      it('reads to the last known message when nothing is resident', () => {
        const { memory, storage } = memoryStorage({ messages: [] })
        const tracker = makeTracker(storage)
        tracker.markReadToNewest(ENTITY)
        expect(memory.view.readPointer?.identity.messageId).toBe('m3')
        expect(memory.view.unreadCount).toBe(0)
      })

      it('writes nothing when there is nothing to read up to', () => {
        const { memory, storage } = memoryStorage({ messages: [], lastMessage: undefined })
        const tracker = makeTracker(storage)
        tracker.markReadToNewest(ENTITY)
        expect(memory.writes).toBe(0)
      })

      it('writes nothing when already read to the newest message', () => {
        const { memory, storage } = memoryStorage({
          readPointer: makeReadPointer(messages[3], kind), unreadCount: 0, mentionsCount: 0, divider: undefined,
        })
        const tracker = makeTracker(storage)
        tracker.markReadToNewest(ENTITY)
        expect(memory.writes).toBe(0)
      })

      it('never moves the pointer back to an older last known message', () => {
        const { memory, storage } = memoryStorage({
          messages: [], lastMessage: messages[1], readPointer: makeReadPointer(messages[2], kind),
        })
        const tracker = makeTracker(storage)
        tracker.markReadToNewest(ENTITY)
        expect(memory.view.readPointer?.identity.messageId).toBe('m2')
        expect(memory.view.unreadCount).toBe(0)
      })

      it('drops a deferred remote divider advance', () => {
        const { memory, storage } = memoryStorage()
        const tracker = makeTracker(storage)
        // Reading to the newest message answers what a marker waiting for messages was asking,
        // so a later retry of that marker has nothing left to place.
        tracker.markReadToNewest(ENTITY)
        memory.view = { ...memory.view, divider: { id: 'm1' } }
        const writes = memory.writes
        tracker.retryRemoteDivider(ENTITY)
        expect(memory.writes).toBe(writes)
      })
    })

    describe('applyRemoteDisplayed', () => {
      it('advances a background entity and recounts it from the archive', () => {
        const { memory, storage } = memoryStorage({ isActive: false })
        const tracker = makeTracker(storage)
        tracker.applyRemoteDisplayed(ENTITY, 's2')
        expect(memory.view.readPointer?.identity.messageId).toBe('m2')
        expect(memory.view.unreadCount).toBe(3)
        expect(memory.view.divider).toEqual({ id: 'm1' })
        expect(recounts).toEqual([ENTITY])
      })

      it('advances the viewed entity, moves the divider past what was read, and recounts it', () => {
        const { memory, storage } = memoryStorage()
        const tracker = makeTracker(storage)
        tracker.applyRemoteDisplayed(ENTITY, 's2')
        expect(memory.view.readPointer?.identity.messageId).toBe('m2')
        expect(memory.view.divider?.id).toBe('m3')
        expect(recounts).toEqual([`${ENTITY} (active)`])
      })

      it('stashes a marker no loaded slice holds, then applies it once the cache orders it', async () => {
        const later: NotificationMessage = { ...messages[3], id: 'm4', stanzaId: 's4', timestamp: new Date(1004) }
        stashedRows = [later]
        const { memory, storage } = memoryStorage({ isActive: false })
        const tracker = makeTracker(storage)
        tracker.applyRemoteDisplayed(ENTITY, 's4')
        expect(memory.view.pendingRemoteMarker).toBe('s4')
        expect(memory.view.readPointer?.identity.messageId).toBe('m0')

        await vi.waitFor(() => expect(memory.view.readPointer?.identity.messageId).toBe('m4'))
        expect(memory.view.pendingRemoteMarker).toBeUndefined()
      })

      it('releases a stash once the marker turns out to be behind the pointer', () => {
        const { memory, storage } = memoryStorage({
          isActive: false, readPointer: makeReadPointer(messages[2], kind), pendingRemoteMarker: 's1',
        })
        const tracker = makeTracker(storage)
        tracker.applyRemoteDisplayed(ENTITY, 's1')
        expect(memory.view.pendingRemoteMarker).toBeUndefined()
        expect(memory.view.readPointer?.identity.messageId).toBe('m2')
        expect(recounts).toEqual([`${ENTITY} (active)`])
      })

      it('writes nothing for a marker behind the pointer with nothing stashed', () => {
        const { memory, storage } = memoryStorage({ isActive: false, readPointer: makeReadPointer(messages[2], kind) })
        const tracker = makeTracker(storage)
        tracker.applyRemoteDisplayed(ENTITY, 's1')
        expect(memory.writes).toBe(0)
        expect(recounts).toEqual([])
      })
    })

    describe('discardPurgedRemoteDisplayed', () => {
      it('drops the stash, recounts, and ignores the purged marker from then on', () => {
        const { memory, storage } = memoryStorage({ isActive: false, pendingRemoteMarker: 'gone' })
        const tracker = makeTracker(storage)
        tracker.discardPurgedRemoteDisplayed(ENTITY, 'gone')
        expect(memory.view.pendingRemoteMarker).toBeUndefined()
        expect(recounts).toEqual([`${ENTITY} (active)`])

        const writes = memory.writes
        tracker.applyRemoteDisplayed(ENTITY, 'gone')
        expect(memory.writes).toBe(writes)
        expect(memory.view.pendingRemoteMarker).toBeUndefined()
      })

      it('leaves a different stash alone', () => {
        const { memory, storage } = memoryStorage({ pendingRemoteMarker: 'kept' })
        const tracker = makeTracker(storage)
        tracker.discardPurgedRemoteDisplayed(ENTITY, 'gone')
        expect(memory.view.pendingRemoteMarker).toBe('kept')
        expect(memory.writes).toBe(0)
        expect(recounts).toEqual([])
      })
    })

    describe('resolvePublishPosition', () => {
      beforeEach(() => { connectionStore.setState({ jid: `${ALICE}/desktop` }) })

      it('publishes the archive id the pointer already carries', async () => {
        const addressable = makeReadPointer(messages[2], kind)
        expect(addressable.identity.state).toBe('addressable')
        const { storage } = memoryStorage({ readPointer: addressable })
        const tracker = makeTracker(storage)
        await expect(tracker.resolvePublishPosition(ENTITY)).resolves.toEqual({ stanzaId: 's2', readPointer: addressable })
      })

      it('publishes nothing for an entity with no read position', async () => {
        const { storage } = memoryStorage({ readPointer: undefined })
        const tracker = makeTracker(storage)
        await expect(tracker.resolvePublishPosition(ENTITY)).resolves.toBeUndefined()
      })

      it('resolves a pointer whose row has since been archived, from the cache', async () => {
        const unarchived = messages.map(message => ({ ...message, stanzaId: undefined }))
        const pointer = makeReadPointer(unarchived[2], kind)
        expect(pointer.identity.state).toBe('local')
        // A cached row carries its own row reference, which a local pointer is matched against.
        publishCandidates = [{ ...unarchived[2], stanzaId: 's2', localRowRef: { id: unarchived[2].id } }]
        const { storage } = memoryStorage({ readPointer: pointer, messages: unarchived, lastMessage: undefined })
        const tracker = makeTracker(storage)
        const published = await tracker.resolvePublishPosition(ENTITY)
        expect(published?.stanzaId).toBe('s2')
      })

      it('publishes nothing when the cache could not be read', async () => {
        const unarchived = messages.map(message => ({ ...message, stanzaId: undefined }))
        const { storage } = memoryStorage({
          readPointer: makeReadPointer(unarchived[2], kind), messages: unarchived, lastMessage: undefined,
        })
        const tracker = createReadTracker(kind, {
          storage,
          recount: () => {},
          loadStashedMarkerRows: async () => null,
          loadPublishCandidates: async () => null,
          captureCacheRead: () => () => true,
          historyCaughtUp: () => true,
          coverageRecord: () => undefined,
          resolveCoverageBottom: async () => 'missing' as const,
          invalidateCoverage: () => {},
          countUnreadFromArchive: async () => null,
          archiveReadyForCounting: () => true,
        })
        await expect(tracker.resolvePublishPosition(ENTITY)).resolves.toBeUndefined()
      })

      if (kind === 'chat') {
        it('falls back to the newest archived row at or behind an unarchived pointer', async () => {
          // The resting state of a 1:1 pointer: it names the user's own send, which never gets an
          // archive id. Publishing the newest row behind it keeps the position syncing.
          const rows = messages.map((message, index) => (index === 1 ? { ...message, stanzaId: undefined } : message))
          const { storage } = memoryStorage({
            readPointer: makeReadPointer(rows[1], 'chat'), messages: rows, lastMessage: undefined,
          })
          const tracker = makeTracker(storage)
          const published = await tracker.resolvePublishPosition(ENTITY)
          expect(published?.stanzaId).toBe('s0')
        })
      }

      if (kind === 'room') {
        it('publishes nothing when two rows of the room answer to the pointer', async () => {
          const unarchived = messages.map(message => ({ ...message, stanzaId: undefined }))
          const pointer = makeReadPointer(unarchived[2], 'room')
          const row = { ...unarchived[2], localRowRef: { id: unarchived[2].id } }
          // Two archived rows answer to the same local row; neither can be named with certainty.
          publishCandidates = [
            { ...row, stanzaId: 's2' },
            { ...row, stanzaId: 's2-bis' },
          ]
          const { storage } = memoryStorage({ readPointer: pointer, messages: unarchived, lastMessage: undefined })
          const tracker = makeTracker(storage)
          await expect(tracker.resolvePublishPosition(ENTITY)).resolves.toBeUndefined()
        })
      }
    })

    describe('recompute', () => {
      const verdicts: unknown[] = []
      beforeEach(() => {
        verdicts.length = 0
        resetDiagnosticsForTesting()
        subscribeDiagnostics((event) => {
          if (event.kind === 'unread-recount') verdicts.push(event.verdict)
        })
      })
      afterEach(() => resetDiagnosticsForTesting())

      const reason = () => (verdicts.at(-1) as { reason?: string } | undefined)?.reason

      it('commits the archive count and clears the mentions a zero disproves', async () => {
        archiveCount = { unread: 0 }
    coverageBottom = { timestamp: 1, tiebreak: { kind: 'chat', id: 'bottom' } } as CoverageBottom
        const { memory, storage } = memoryStorage({ isActive: false })
        await makeTracker(storage).recompute(ENTITY)
        expect(memory.view.unreadCount).toBe(0)
        expect(memory.view.mentionsCount).toBe(0)
        expect(verdicts.at(-1)).toEqual({ status: 'counted', count: 0, previousCount: 3 })
      })

      it('leaves the mentions alone while unread messages remain', async () => {
        archiveCount = { unread: 2 }
        const { memory, storage } = memoryStorage({ isActive: false })
        await makeTracker(storage).recompute(ENTITY)
        expect(memory.view.unreadCount).toBe(2)
        expect(memory.view.mentionsCount).toBe(mentions)
      })

      it('skips the entity being viewed unless the caller asks for it', async () => {
        archiveCount = { unread: 1 }
        const { memory, storage } = memoryStorage()
        const tracker = makeTracker(storage)
        await tracker.recompute(ENTITY)
        expect(memory.writes).toBe(0)
        expect(reason()).toBe('active-skipped')
        // Skipped before the archive is read, not after.
        expect(archiveReads).toBe(0)

        await tracker.recompute(ENTITY, { allowActive: true })
        expect(memory.view.unreadCount).toBe(1)
      })

      it('declines while history has not caught up', async () => {
        historyCaughtUp = false
        const { memory, storage } = memoryStorage({ isActive: false })
        await makeTracker(storage).recompute(ENTITY)
        expect(memory.writes).toBe(0)
        expect(reason()).toBe('history-not-caught-up')
      })

      it('declines without a coverage record proving contiguous history', async () => {
        coverage = undefined
        const { memory, storage } = memoryStorage({ isActive: false })
        await makeTracker(storage).recompute(ENTITY)
        expect(memory.writes).toBe(0)
        expect(reason()).toBe('coverage-missing')
      })

      it('drops a coverage record whose bottom no longer resolves', async () => {
        coverage = { bottomId: 'gone', countBottomId: 'gone' }
        coverageBottom = 'unresolvable'
        const { memory, storage } = memoryStorage({ isActive: false })
        await makeTracker(storage).recompute(ENTITY)
        expect(memory.writes).toBe(0)
        expect(reason()).toBe('coverage-unresolvable')
        expect(invalidatedCoverage).toEqual([ENTITY])
      })

      it('declines rather than report a count the cache could not produce', async () => {
        archiveCount = null
        const { memory, storage } = memoryStorage({ isActive: false })
        await makeTracker(storage).recompute(ENTITY)
        expect(memory.writes).toBe(0)
        expect(reason()).toBe('cache-unavailable')
      })

      it('discards a count the reader has overtaken while the archive was read', async () => {
        archiveCount = { unread: 2 }
        let open!: () => void
        archiveGate = new Promise<void>(resolve => { open = () => resolve() })
        const { memory, storage } = memoryStorage({ isActive: false })
        const tracker = makeTracker(storage)
        const pending = tracker.recompute(ENTITY)
        // The reader reads to the newest row while the count is being read.
        memory.view = { ...memory.view, isActive: true, atLiveEdge: true }
        const key = tracker.scopeKey(ENTITY)
        reportViewport(key, beginViewportGeneration(key), 'at-edge')
        tracker.advance(ENTITY, { id: 'm3' })
        open()
        await pending
        expect(reason()).toBe('recount-superseded')
        expect(memory.view.unreadCount).toBe(0)
      })

      it('declines a count computed from unread inputs that have since changed', async () => {
        archiveCount = { unread: 2 }
        let open!: () => void
        archiveGate = new Promise<void>(resolve => { open = () => resolve() })
        const { memory, storage } = memoryStorage({ isActive: false })
        const tracker = makeTracker(storage)
        const pending = tracker.recompute(ENTITY)
        tracker.noteUnreadInputsChanged(ENTITY)
        open()
        await pending
        expect(reason()).toBe('input-version-changed')
        expect(memory.view.unreadCount).toBe(3)
      })

      it('declines a count whose read position moved while the archive was read', async () => {
        archiveCount = { unread: 1 }
        const { memory, storage } = memoryStorage({ isActive: false })
        const tracker = makeTracker(storage)
        const pending = tracker.recompute(ENTITY)
        memory.view = { ...memory.view, readPointer: makeReadPointer(messages[3], kind) }
        await pending
        expect(memory.writes).toBe(0)
        expect(reason()).toBe('pointer-changed')
      })

      it('declines for an entity showing a count it has never established a position for', async () => {
        const { memory, storage } = memoryStorage({ isActive: false, readPointer: undefined })
        await makeTracker(storage).recompute(ENTITY)
        expect(memory.writes).toBe(0)
        expect(reason()).toBe('pointerless-defer')
      })

      it('retires a background divider the read position has overtaken', async () => {
        archiveCount = { unread: 0 }
    coverageBottom = { timestamp: 1, tiebreak: { kind: 'chat', id: 'bottom' } } as CoverageBottom
        const { memory, storage } = memoryStorage({ isActive: false, readPointer: makeReadPointer(messages[3], kind) })
        await makeTracker(storage).recompute(ENTITY)
        expect(memory.view.divider).toBeUndefined()
      })

      it('keeps the divider of the entity being viewed where the reader sees it', async () => {
        archiveCount = { unread: 0 }
    coverageBottom = { timestamp: 1, tiebreak: { kind: 'chat', id: 'bottom' } } as CoverageBottom
        const { memory, storage } = memoryStorage({ readPointer: makeReadPointer(messages[3], kind) })
        await makeTracker(storage).recompute(ENTITY, { allowActive: true })
        expect(memory.view.divider).toEqual({ id: 'm1' })
      })
    })

    describe('activate', () => {
      it('marks the entity active and places the divider at the first unread message', () => {
        const { memory, storage } = memoryStorage({
          isActive: false, divider: undefined, readPointer: makeReadPointer(messages[1], kind),
        })
        const tracker = makeTracker(storage)
        expect(tracker.activate(ENTITY)).toBe(true)
        expect(memory.view.isActive).toBe(true)
        expect(memory.view.divider?.id).toBe('m2')
        expect(memory.view.mentionsCount).toBe(0)
      })

      it('leaves the count for the archive to derive, and asks it to', () => {
        const { memory, storage } = memoryStorage({ isActive: false, unreadCount: 3 })
        makeTracker(storage).activate(ENTITY)
        // Opening an entity is not evidence of reading it.
        expect(memory.view.unreadCount).toBe(3)
        expect(recounts).toEqual([`${ENTITY} (active)`])
      })

      it('asks for no recount when nothing is unread', () => {
        const { storage } = memoryStorage({ isActive: false, unreadCount: 0, mentionsCount: 0 })
        makeTracker(storage).activate(ENTITY)
        expect(recounts).toEqual([])
      })

      it('retires viewport evidence from the previous visit', () => {
        const { storage } = memoryStorage({ isActive: false })
        const tracker = makeTracker(storage)
        const key = tracker.scopeKey(ENTITY)
        reportViewport(key, beginViewportGeneration(key), 'at-edge')
        expect(currentViewportEvidence(key)).toBe('at-edge')
        tracker.activate(ENTITY)
        expect(currentViewportEvidence(key)).toBe('unknown')
      })

      it('leaves an entity the store does not hold to its caller', () => {
        const { memory, storage } = memoryStorage()
        expect(makeTracker(storage).activate('someone-else')).toBe(false)
        expect(memory.writes).toBe(0)
      })
    })

    describe('deactivate', () => {
      it('drops the divider of the visit that ended and re-derives the count', () => {
        const { memory, storage } = memoryStorage({ isActive: false })
        makeTracker(storage).deactivate(ENTITY)
        expect(memory.view.divider).toBeUndefined()
        // Not `allowActive`: the store has already stopped naming this entity as viewed.
        expect(recounts).toEqual([ENTITY])
      })

      it('spares a fresh entity the cache read', () => {
        const { memory, storage } = memoryStorage({
          isActive: false, readPointer: undefined, unreadCount: 0, mentionsCount: 0, divider: undefined,
        })
        makeTracker(storage).deactivate(ENTITY)
        expect(memory.writes).toBe(0)
        expect(recounts).toEqual([])
      })
    })

    describe('arrivals', () => {
      const arriving = (overrides: Partial<NotificationMessage> = {}): NotificationMessage => ({
        id: 'm4',
        from: `${ENTITY}/nick4`,
        ...(kind === 'room' ? { roomJid: ENTITY, type: 'groupchat' } : { type: 'chat' }),
        body: 'a new message',
        stanzaId: 's4',
        isOutgoing: false,
        timestamp: new Date(1004),
        ...overrides,
      } as NotificationMessage)

      const overlayOptions = (message: NotificationMessage) => (kind === 'room'
        ? { roomMessage: message as never }
        : { identity: { id: message.id, aliases: [message.id] } })

      const begin = (tracker: ReturnType<typeof makeTracker>, message: NotificationMessage, evidence: { isActive: boolean; windowVisible: boolean }) =>
        tracker.beginArrival(ENTITY, message, evidence, overlayOptions(message))

      it('counts an unseen arrival once, through the overlay rather than twice', () => {
        const { memory, storage } = memoryStorage({ isActive: false, unreadCount: 3 })
        const tracker = makeTracker(storage)
        const message = arriving()
        const note = begin(tracker, message, { isActive: false, windowVisible: true })
        expect(note.noted).toBe(true)
        expect(note.unreadDelta).toBe(1)

        const read = tracker.arrivalCounts(note, message, { isActive: false, windowVisible: true })
        // 3 held + 1 from the overlay: the live transition does not add its own.
        expect(read?.unreadCount).toBe(4)
        expect(memory.writes).toBe(0)
      })

      it('does not note an arrival the reader is looking at', () => {
        const { storage } = memoryStorage()
        const tracker = makeTracker(storage)
        const key = tracker.scopeKey(ENTITY)
        reportViewport(key, beginViewportGeneration(key), 'at-edge')
        const message = arriving()
        const note = begin(tracker, message, { isActive: true, windowVisible: true })
        expect(note.noted).toBe(false)
        expect(note.unreadDelta).toBe(0)
      })

      it('notes an arrival in an entity that is open but scrolled up', () => {
        const { storage } = memoryStorage()
        const tracker = makeTracker(storage)
        const key = tracker.scopeKey(ENTITY)
        reportViewport(key, beginViewportGeneration(key), 'away')
        const message = arriving()
        expect(begin(tracker, message, { isActive: true, windowVisible: true }).noted).toBe(true)
      })

      it('does not note an arrival the caller counts for itself', () => {
        const { storage } = memoryStorage({ isActive: false })
        const tracker = makeTracker(storage)
        const message = arriving()
        const note = tracker.beginArrival(ENTITY, message, { isActive: false, windowVisible: true }, {
          increment: false, ...overlayOptions(message),
        } as never)
        expect(note.noted).toBe(false)
      })

      it('treats a delayed message as new in a chat, as replayed history in a room', () => {
        // In a 1:1 a delayed message was sent while the user was offline; in a room it is MUC
        // history being replayed, which the reader has not missed.
        const { storage } = memoryStorage({ isActive: false })
        const tracker = makeTracker(storage)
        const message = arriving({ isDelayed: true } as Partial<NotificationMessage>)
        expect(begin(tracker, message, { isActive: false, windowVisible: true }).noted).toBe(kind === 'chat')
      })

      it('drops the overlay entry when the store refuses the message', () => {
        const { storage } = memoryStorage({ isActive: false })
        const tracker = makeTracker(storage)
        const message = arriving()
        const note = begin(tracker, message, { isActive: false, windowVisible: true })
        expect(transientCounts(tracker.scopeKey(ENTITY), undefined).unread).toBe(1)
        tracker.endArrival(note, { accepted: false })
        expect(transientCounts(tracker.scopeKey(ENTITY), undefined).unread).toBe(0)
      })

      it('keeps counting the arrival in the overlay until its archive write commits', async () => {
        const { storage } = memoryStorage({ isActive: false })
        const tracker = makeTracker(storage)
        const message = arriving()
        const note = begin(tracker, message, { isActive: false, windowVisible: true })
        let commit!: (committed: boolean) => void
        tracker.endArrival(note, { accepted: true, durableWrite: new Promise<boolean>(resolve => { commit = resolve }) })
        expect(transientCounts(tracker.scopeKey(ENTITY), undefined).unread).toBe(1)
        // A recount cannot run while that write is in flight, or it would count neither copy.
        expect(tracker.recountReady(ENTITY)).toBe(false)

        commit(true)
        await vi.waitFor(() => expect(transientCounts(tracker.scopeKey(ENTITY), undefined).unread).toBe(0))
        expect(tracker.recountReady(ENTITY)).toBe(true)
      })

      it('keeps the overlay entry when the archive write fails', async () => {
        const { storage } = memoryStorage({ isActive: false })
        const tracker = makeTracker(storage)
        const message = arriving()
        const note = begin(tracker, message, { isActive: false, windowVisible: true })
        tracker.endArrival(note, { accepted: true, durableWrite: Promise.resolve(false) })
        await vi.waitFor(() => expect(tracker.recountReady(ENTITY)).toBe(true))
        expect(transientCounts(tracker.scopeKey(ENTITY), undefined).unread).toBe(1)
      })
    })
  })
})
