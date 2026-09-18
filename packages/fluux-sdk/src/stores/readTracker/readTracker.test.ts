import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createReadTracker, type ReadTrackerKind } from './index'
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
  const makeTracker = () => createReadTracker(kind, { archiveReadyForCounting: () => archiveReady })

  beforeEach(() => {
    archiveReady = true
    setStorageScopeJid(ALICE)
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
})
