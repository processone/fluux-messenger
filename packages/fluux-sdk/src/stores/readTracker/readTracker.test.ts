import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createReadTracker, type ReadStateView, type ReadTrackerKind, type ReadTrackerStorage } from './index'
import { connectionStore } from '../connectionStore'
import { makeReadPointer, type PointerSource } from '../shared/readPointer'
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
  const inertStorage: ReadTrackerStorage = { update: () => {} }
  const makeTracker = (storage: ReadTrackerStorage = inertStorage) => createReadTracker(kind, {
    storage,
    recount: (entityId) => { recounts.push(entityId) },
    archiveReadyForCounting: () => archiveReady,
  })

  beforeEach(() => {
    archiveReady = true
    recounts = []
    setStorageScopeJid(ALICE)
    connectionStore.getState().setWindowVisible(true)
  })

  afterEach(() => {
    _resetStorageScopeForTesting()
    _resetPurgedMarkersForTesting()
    _clearAllViewportEvidenceForTesting()
  })

  it('keys registries by the current account and its own kind', () => {
    const tracker = makeTracker()
    expect(tracker.scopeKey('e1')).toEqual({ accountScope: ALICE, kind, entityId: 'e1' })
    setStorageScopeJid(BOB)
    expect(tracker.scopeKey('e1')).toEqual({ accountScope: BOB, kind, entityId: 'e1' })
  })

  it('orders recounts per entity', () => {
    const tracker = makeTracker()
    expect(tracker.recountVersion('e1')).toBeUndefined()
    expect(tracker.bumpRecountVersion('e1')).toBe(1)
    expect(tracker.bumpRecountVersion('e1')).toBe(2)
    expect(tracker.bumpRecountVersion('e2')).toBe(1)
    expect(tracker.recountVersion('e1')).toBe(2)
  })

  it('versions unread inputs per entity', () => {
    const tracker = makeTracker()
    expect(tracker.unreadInputVersion('e1')).toBeUndefined()
    tracker.bumpUnreadInputVersion('e1')
    tracker.bumpUnreadInputVersion('e1')
    expect(tracker.unreadInputVersion('e1')).toBe(2)
    expect(tracker.unreadInputVersion('e2')).toBeUndefined()
  })

  it('is ready to recount only with no pending unread write and a settled archive', () => {
    const tracker = makeTracker()
    expect(tracker.recountReady('e1')).toBe(true)

    const token = tracker.pendingUnreadWrites.begin('e1')
    expect(tracker.recountReady('e1')).toBe(false)
    expect(tracker.recountReady('e2')).toBe(true)
    tracker.pendingUnreadWrites.finish('e1', token)
    expect(tracker.recountReady('e1')).toBe(true)

    archiveReady = false
    expect(tracker.recountReady('e1')).toBe(false)
  })

  it('forgets one entity without touching another', () => {
    const tracker = makeTracker()
    tracker.bumpRecountVersion('e1')
    tracker.bumpUnreadInputVersion('e1')
    tracker.pendingUnreadWrites.begin('e1')
    tracker.recountsInFlight.begin('e1')
    tracker.bumpRecountVersion('e2')

    tracker.forgetEntity('e1')

    expect(tracker.recountVersion('e1')).toBeUndefined()
    expect(tracker.unreadInputVersion('e1')).toBeUndefined()
    expect(tracker.pendingUnreadWrites.has('e1')).toBe(false)
    expect(tracker.recountsInFlight.has('e1')).toBe(false)
    expect(tracker.recountVersion('e2')).toBe(1)
  })

  it('tears down the outgoing account on a switch, found by the scope recorded at the previous switch', () => {
    const tracker = makeTracker()
    // First switch: nothing recorded yet, so nothing is torn down.
    tracker.resetForAccountSwitch()
    notePurgedMarker(tracker.scopeKey('e1'), 'purged-a')
    const generation = beginViewportGeneration(tracker.scopeKey('e1'))
    reportViewport(tracker.scopeKey('e1'), generation, 'at-edge')
    tracker.bumpRecountVersion('e1')

    // The global scope flips to the incoming account before the store switches.
    setStorageScopeJid(BOB)
    notePurgedMarker(tracker.scopeKey('e1'), 'purged-b')
    tracker.resetForAccountSwitch()

    const aliceKey = { accountScope: ALICE, kind, entityId: 'e1' }
    expect(isMarkerPurged(aliceKey, 'purged-a')).toBe(false)
    expect(currentViewportEvidence(aliceKey)).toBe('unknown')
    expect(isMarkerPurged(tracker.scopeKey('e1'), 'purged-b')).toBe(true)
    expect(tracker.recountVersion('e1')).toBeUndefined()
  })

  it('tears down the current account on logout and lets the synced marker fold again', () => {
    const tracker = makeTracker()
    notePurgedMarker(tracker.scopeKey('e1'), 'purged-a')
    tracker.mdsGate.markFolded('e1', 'marker')
    expect(tracker.mdsGate.shouldFold('e1', 'marker')).toBe(false)
    tracker.bumpUnreadInputVersion('e1')

    tracker.resetForLogout()

    expect(isMarkerPurged(tracker.scopeKey('e1'), 'purged-a')).toBe(false)
    expect(tracker.mdsGate.shouldFold('e1', 'marker')).toBe(true)
    expect(tracker.unreadInputVersion('e1')).toBeUndefined()
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

  describe('advance', () => {
    const ENTITY = 'e1'
    const messages: PointerSource[] = Array.from({ length: 4 }, (_, index) => ({
      id: `m${index}`,
      from: `${ENTITY}/nick${index}`,
      ...(kind === 'room' ? { roomJid: ENTITY } : {}),
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
          ...overrides,
        } as ReadStateView,
      }
      const storage: ReadTrackerStorage = {
        update: (entityId, change) => {
          if (entityId !== ENTITY) return
          const patch = change(memory.view)
          if (!patch) return
          memory.writes++
          memory.view = { ...memory.view, readPointer: patch.readPointer, unreadCount: patch.unreadCount, mentionsCount: patch.mentionsCount }
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
      expect(recounts).toEqual([ENTITY])
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
      // Invalidates a recount already in flight.
      expect(tracker.recountVersion(ENTITY)).toBe(1)
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
  })
})
