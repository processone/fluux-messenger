/**
 * Tests for the internal message impl-state helpers.
 *
 * `noLocalStore` and `correctionStanzaIds` are implementation state kept OFF
 * the public message types (see message-internal.ts). These helpers are the
 * single, typed read path the SDK internals use so the cast to the internal
 * shape lives in exactly one place.
 */
import { describe, it, expect } from 'vitest'
import { isNoLocalStore, getCorrectionStanzaIds, compareCorrectionRevisions, resolveCorrectionUpdates, type StoredMessage } from './message-internal'
import type { Message } from './chat'

const baseMessage: Message = {
  type: 'chat',
  id: 'm1',
  conversationId: 'alice@example.com',
  from: 'alice@example.com',
  body: 'hi',
  timestamp: new Date(),
  isOutgoing: false,
}

describe('isNoLocalStore', () => {
  it('is true when the impl flag is set', () => {
    const stored: StoredMessage = { ...baseMessage, noLocalStore: true }
    expect(isNoLocalStore(stored)).toBe(true)
  })

  it('is false when the flag is absent or false', () => {
    expect(isNoLocalStore(baseMessage)).toBe(false)
    const stored: StoredMessage = { ...baseMessage, noLocalStore: false }
    expect(isNoLocalStore(stored)).toBe(false)
  })
})

describe('getCorrectionStanzaIds', () => {
  it('returns the ids when present', () => {
    const stored: StoredMessage = { ...baseMessage, correctionStanzaIds: ['s1', 's2'] }
    expect(getCorrectionStanzaIds(stored)).toEqual(['s1', 's2'])
  })

  it('returns undefined when absent', () => {
    expect(getCorrectionStanzaIds(baseMessage)).toBeUndefined()
  })
})

describe('public message type surface', () => {
  // Type-level regression guard (enforced by `tsc`, not the runtime): the impl
  // fields must NOT be reachable on the public Message type. If someone re-adds
  // one to BaseMessage, the @ts-expect-error goes unused and typecheck fails.
  it('does not expose the impl fields on the public Message type', () => {
    const m: Message = baseMessage
    // @ts-expect-error noLocalStore is internal impl-state, not on public Message
    void m.noLocalStore
    // @ts-expect-error correctionStanzaIds is internal impl-state, not on public Message
    void m.correctionStanzaIds
    expect(m).toBeDefined()
  })
})


describe('correction receive evidence', () => {
  const correction = (id: string, sequence: number, session = 'stream-one'): StoredMessage => ({
    ...baseMessage, body: id, isEdited: true, liveCorrection: true,
    correctionRevision: { ids: [`stanza:${id}`], supersedes: [], receiveOrder: { session, sequence } },
  })
  it('orders only observations from the same receive session', () => {
    expect(compareCorrectionRevisions(correction('c1', 1), correction('c2', 2))).toBe(-1)
    expect(compareCorrectionRevisions(correction('c1', 1), correction('c2', 100, 'stream-two'))).toBe(0)
    expect(compareCorrectionRevisions(correction('c1', 100), correction('c2', 1, 'stream-two'))).toBe(0)
  })
  it('does not use receive counters to order distinct archive pages', () => {
    const c1 = correction('c1', 2)
    const c2 = correction('c2', 1)
    c1.correctionRevision!.receiveOrder!.pendingLiveSequences = []
    c2.correctionRevision!.receiveOrder!.pendingLiveSequences = []
    c1.correctionRevision!.archiveTimestamp = 10
    c2.correctionRevision!.archiveTimestamp = 10
    expect(compareCorrectionRevisions(c1, c2)).toBe(0)
    expect(compareCorrectionRevisions(c2, c1)).toBe(0)
    expect(resolveCorrectionUpdates(c2, c1)).not.toHaveProperty('body')
  })
  it('retains receive order on same-revision replay and records the late predecessor', () => {
    const c2 = correction('c2', 2)
    const replayed = { ...c2, ...resolveCorrectionUpdates(c2, correction('c2', 3)) }
    expect(replayed.correctionRevision?.receiveOrder?.sequence).toBe(2)
    const current = { ...replayed, ...resolveCorrectionUpdates(replayed, correction('c1', 1)) }
    expect(current.body).toBe('c2')
    expect(current.correctionRevision?.supersedes).toEqual(['stanza:c1'])
    expect(resolveCorrectionUpdates(current, correction('c1', 4))).not.toHaveProperty('body')
  })
  it('keeps a known archive floor authoritative over a delayed receive observation', () => {
    const replay = correction('replay', 3)
    replay.liveCorrection = false
    replay.correctionRevision!.archiveTimestamp = 10
    const current = correction('current', 2)
    current.correctionRevision!.afterArchiveTimestamp = 20
    expect(compareCorrectionRevisions(replay, current)).toBe(-1)
    expect(compareCorrectionRevisions(current, replay)).toBe(1)
    const merged = { ...current, ...resolveCorrectionUpdates(current, replay) }
    expect(merged.body).toBe('current')
    expect(merged.correctionRevision?.supersedes).toEqual([])
  })
  it('keeps archive chronology authoritative and signed dates with the accepted body', () => {
    const c1 = correction('c1', 2)
    const c2 = correction('c2', 1)
    c1.correctionRevision!.archiveTimestamp = 10
    c2.correctionRevision!.archiveTimestamp = 20
    c1.correctionTimestamp = 900
    c2.correctionTimestamp = 100
    expect(compareCorrectionRevisions(c2, c1)).toBe(1)
    expect(resolveCorrectionUpdates(c1, c2)).toMatchObject({ body: 'c2', correctionTimestamp: 100 })
  })
})


describe('unresolved correction content', () => {
  const archive: StoredMessage = { ...baseMessage, body: 'archive', isEdited: true, correctionTimestamp: 900, correctionTimestampSource: 'authored',
    correctionRevision: { ids: ['stanza:archived'], supersedes: [], archiveTimestamp: 10,
      receiveOrder: { session: 'same', sequence: 2, archive: true, overlapping: [1] } } }
  const live: StoredMessage = { ...baseMessage, body: 'live', isEdited: true, correctionTimestamp: 100, correctionTimestampSource: 'authored',
    correctionRevision: { ids: ['stanza:live'], supersedes: [], receiveOrder: { session: 'same', sequence: 1 } } }
  it('keeps the retained plaintext and signed date when its archive echo remains encrypted', () => {
    const held = { ...archive, ...resolveCorrectionUpdates(archive, live) }
    const echo = { ...live, body: 'ciphertext hint', encryptedPayload: 'ciphertext', correctionTimestamp: 20, correctionTimestampSource: 'delay' as const,
      correctionRevision: { ...live.correctionRevision!, archiveTimestamp: 20 } }
    const resolved = { ...held, ...resolveCorrectionUpdates(held, echo) }
    expect(resolved).toMatchObject({ body: 'live', correctionTimestamp: 100, correctionTimestampSource: 'authored', id: baseMessage.id, timestamp: baseMessage.timestamp })
    expect(resolved.encryptedPayload).toBeUndefined()
    expect(resolved.correctionAlternatives).toBeUndefined()
  })
  it('clears retained content on retraction and does not restore it on replay', () => {
    const held = { ...archive, ...resolveCorrectionUpdates(archive, live) }
    expect(held.correctionAlternatives).toHaveLength(1)
    const retracted = { ...held, ...resolveCorrectionUpdates(held, { isRetracted: true }) }
    expect(retracted.correctionAlternatives).toBeUndefined()
    expect(resolveCorrectionUpdates(retracted, live)?.correctionAlternatives).toBeUndefined()
  })
})


describe('partial correction chronology', () => {
  const live: StoredMessage = { ...baseMessage, body: 'current live text', isEdited: true,
    correctionTimestamp: 100, correctionTimestampSource: 'authored',
    correctionRevision: { ids: ['stanza:live'], supersedes: [], receiveOrder: { session: 'same', sequence: 2 } } }
  const archive: StoredMessage = { ...baseMessage, body: 'archived text', isEdited: true,
    correctionTimestamp: 900, correctionTimestampSource: 'authored',
    correctionRevision: { ids: ['stanza:archive'], supersedes: [], archiveTimestamp: 10 } }
  it.each([false, true])('retains incomparable content without scheduling markers, archive first=%s', archiveFirst => {
    const current = archiveFirst ? archive : live, incoming = archiveFirst ? live : archive
    expect(compareCorrectionRevisions(current, incoming)).toBe(0)
    expect(compareCorrectionRevisions(incoming, current)).toBe(0)
    const held = { ...current, ...resolveCorrectionUpdates(current, incoming) }
    expect(held).toMatchObject({ body: current.body, correctionTimestamp: current.correctionTimestamp })
    expect(held.correctionRevision?.supersedes).toEqual([])
    expect(held.correctionAlternatives).toEqual([expect.objectContaining({ body: incoming.body, correctionTimestamp: incoming.correctionTimestamp })])
    const echo = { ...live, correctionRevision: { ...live.correctionRevision!, archiveTimestamp: 20 } }
    const resolved = { ...held, ...resolveCorrectionUpdates(held, echo) }
    expect(resolved).toMatchObject({ body: live.body, correctionTimestamp: live.correctionTimestamp })
    expect(resolved.correctionAlternatives).toBeUndefined()
  })
  it('does not order two unknown revisions by different archive lower bounds', () => {
    const a = { ...archive, correctionRevision: { ...archive.correctionRevision!, archiveTimestamp: undefined, afterArchiveTimestamp: 10 } }
    const b = { ...live, correctionRevision: { ...live.correctionRevision!, afterArchiveTimestamp: 20 } }
    expect(compareCorrectionRevisions(a, b)).toBe(0)
    expect(compareCorrectionRevisions(b, a)).toBe(0)
  })
  it.each([false, true])('preserves the first live receipt across same-revision archive metadata, archive first=%s', archiveFirst => {
    const archived = { ...live, correctionRevision: { ...live.correctionRevision!, archiveTimestamp: 10,
      receiveOrder: { session: 'same', sequence: 1, archive: true } } }
    const current = archiveFirst ? archived : live, incoming = archiveFirst ? live : archived
    const held = { ...current, ...resolveCorrectionUpdates(current, incoming) }
    expect(held.correctionRevision?.receiveOrder).toEqual(live.correctionRevision?.receiveOrder)
    const later = { ...live, body: 'later', correctionRevision: { ids: ['stanza:later'], supersedes: [], receiveOrder: { session: 'same', sequence: 3 } } }
    expect(resolveCorrectionUpdates(held, later)).toMatchObject({ body: 'later' })
  })
})


describe('equal archive floor regression', () => {
  it('retains a distinct equal-time candidate until archive order resolves it', () => {
    const current: StoredMessage = { ...baseMessage, isEdited: true, body: 'live',
      correctionRevision: { ids: ['id:live'], supersedes: ['id:first'], predecessors: [['id:first']], afterArchiveTimestamp: 10 } }
    const candidate: StoredMessage = { ...baseMessage, isEdited: true, body: 'candidate', correctionTimestamp: 90,
      correctionRevision: { ids: ['id:candidate'], supersedes: [], archiveTimestamp: 10 } }
    expect(compareCorrectionRevisions(current, candidate)).toBe(0)
    expect(compareCorrectionRevisions(candidate, current)).toBe(0)
    const held = { ...current, ...resolveCorrectionUpdates(current, candidate) }
    expect(held.body).toBe('live')
    expect(held.correctionAlternatives).toEqual([expect.objectContaining({ body: 'candidate', correctionTimestamp: 90 })])
    const echo = { ...current, correctionRevision: { ...current.correctionRevision!, archiveTimestamp: 9 } }
    expect({ ...held, ...resolveCorrectionUpdates(held, echo) }).toMatchObject({ body: 'candidate', correctionTimestamp: 90 })
  })
})

describe('completed archive receipt provenance', () => {
  it.each([false, true])('retains an earlier unresolved live edit when a completed archive is replayed (reverse merge: %s)', reverse => {
    const archived: StoredMessage = { ...baseMessage, body: 'archive', isEdited: true,
      correctionRevision: { ids: ['stanza:c1'], supersedes: [], archiveTimestamp: 10, receiveOrder: { session: 'session', sequence: 1, archive: true } } }
    const live: StoredMessage = { ...baseMessage, body: 'current', isEdited: true, correctionTimestamp: 90, correctionTimestampSource: 'authored',
      correctionRevision: { ids: ['stanza:c2'], supersedes: [], receiveOrder: { session: 'session', sequence: 2 } } }
    const replay: StoredMessage = { ...archived, correctionRevision: { ids: ['stanza:c1'], supersedes: [], receiveOrder: { session: 'session', sequence: 3 } } }
    const held = reverse ? { ...replay, ...resolveCorrectionUpdates(replay, archived) } : { ...archived, ...resolveCorrectionUpdates(archived, replay) }
    const retained = { ...held, ...resolveCorrectionUpdates(held, live) }
    expect(retained.correctionAlternatives).toEqual([expect.objectContaining({ body: live.body, correctionTimestamp: 90 })])
    expect(retained.correctionRevision?.supersedes).not.toContain('stanza:c2')
    const echo = { ...live, correctionRevision: { ...live.correctionRevision!, archiveTimestamp: 20 } }
    expect({ ...retained, ...resolveCorrectionUpdates(retained, echo) }).toMatchObject({ body: live.body, correctionTimestamp: 90 })
  })
})


describe('retained replay provenance before content selection', () => {
  it.each([false, true].flatMap(reload => [false, true].flatMap(alternative => [false, true].map(encrypted => ({ reload, alternative, encrypted })))))(
    'keeps content and provenance together with reload=$reload alternative=$alternative encrypted=$encrypted', ({ reload, alternative, encrypted }) => {
      const archived: StoredMessage = { ...baseMessage, body: 'earlier', originalBody: 'original', isEdited: true,
        correctionTimestamp: 900, correctionTimestampSource: 'authored',
        attachment: { url: 'https://example.test/earlier.png', mediaType: 'image/png' },
        correctionRevision: { ids: ['stanza:c1'], supersedes: [], archiveTimestamp: 10,
          receiveOrder: { session: reload ? 'old' : 'current', sequence: reload ? 900 : 1, archive: true } } }
      const live: StoredMessage = { ...baseMessage, body: 'current', originalBody: 'original', isEdited: true,
        correctionTimestamp: 100, correctionTimestampSource: 'authored',
        correctionRevision: { ids: ['stanza:c2'], supersedes: [], receiveOrder: { session: 'current', sequence: 2 } } }
      const held = alternative ? { ...live, ...resolveCorrectionUpdates(live, archived) } : { ...archived, ...resolveCorrectionUpdates(archived, live) }
      const replay: StoredMessage = { ...baseMessage, body: encrypted ? 'ciphertext' : archived.body, isEdited: true,
        encryptedPayload: encrypted ? 'encrypted-archive' : undefined, correctionTimestamp: 20, correctionTimestampSource: 'delay',
        correctionRevision: { ids: ['stanza:c1'], supersedes: [], receiveOrder: { session: 'current', sequence: 3 } } }
      const retained = { ...held, ...resolveCorrectionUpdates(held, replay) }
      expect(retained.body).toBe(held.body)
      expect(retained.correctionAlternatives).toHaveLength(1)
      const contents = [retained, ...retained.correctionAlternatives ?? []]
      const earlier = contents.find(candidate => candidate.correctionRevision?.ids.includes('stanza:c1'))
      expect(earlier).toMatchObject({
        body: archived.body, originalBody: archived.originalBody, attachment: archived.attachment,
        correctionTimestamp: 900, correctionTimestampSource: 'authored',
      })
      expect(earlier?.encryptedPayload).toBeUndefined()
      expect(earlier?.correctionRevision?.supersedes).not.toContain('stanza:c2')
      expect(contents.find(candidate => candidate.correctionRevision?.ids.includes('stanza:c2'))).toMatchObject({ body: live.body, correctionTimestamp: 100 })
      const next = { ...live, body: 'latest', correctionTimestamp: 50,
        correctionRevision: { ids: ['stanza:c3'], supersedes: [], receiveOrder: { session: 'current', sequence: 4 } } }
      const latest = { ...retained, ...resolveCorrectionUpdates(retained, next) }
      expect(latest).toMatchObject({ body: 'latest', correctionTimestamp: 50 })
      expect(latest.correctionAlternatives).toBeUndefined()
      expect({ ...latest, ...resolveCorrectionUpdates(latest, replay) }).toMatchObject({ body: 'latest', correctionTimestamp: 50 })
    })

  it.each([1, 900])('keeps new-session live progress after hydrating an archived snapshot with counter %i', sequence => {
    const old: StoredMessage = { ...baseMessage, isEdited: true, body: 'old',
      correctionRevision: { ids: ['stanza:c1'], supersedes: [], archiveTimestamp: 10,
        receiveOrder: { session: 'old', sequence, archive: true } } }
    const replay = { ...old, correctionRevision: { ids: ['stanza:c1'], supersedes: [], receiveOrder: { session: 'current', sequence: 2 } } }
    const observed = { ...old, ...resolveCorrectionUpdates(old, replay) }
    const hydrated = { ...observed, ...resolveCorrectionUpdates(observed, old) }
    const next = { ...old, body: 'current', correctionRevision: { ids: ['stanza:c2'], supersedes: [], receiveOrder: { session: 'current', sequence: 3 } } }
    expect({ ...hydrated, ...resolveCorrectionUpdates(hydrated, next) }).toMatchObject({ body: next.body })
  })
})
