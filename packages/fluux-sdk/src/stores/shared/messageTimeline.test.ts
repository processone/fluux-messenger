import { describe, it, expect } from 'vitest'
import { appendLive, mergeArchive, loadOlderSlice, loadNewerSlice, latestSlice } from './messageTimeline'

/**
 * The resident-window timeline machine shared by chatStore and roomStore.
 *
 * Every transition here used to exist twice (once per store) and drifted —
 * missing trim, missing dedupe, missing archive-id backfill. These tests are
 * the single specification both stores now delegate to.
 */

interface TestMsg {
  id: string
  stanzaId?: string
  originId?: string
  from: string
  timestamp: Date
}

const getKeys = (m: TestMsg): string[] => {
  const keys: string[] = []
  if (m.stanzaId) keys.push(`stanzaId:${m.stanzaId}`)
  if (m.originId) keys.push(`originId:${m.originId}`)
  keys.push(`from:${m.from}:id:${m.id}`)
  return keys
}

function msg(id: string, iso: string, extra: Partial<TestMsg> = {}): TestMsg {
  return { id, from: 'peer@example.com', timestamp: new Date(iso), ...extra }
}

const cfg = { getKeys, windowSize: 3 }

describe('messageTimeline', () => {
  describe('appendLive', () => {
    it('appends and trims to the window bound at the live edge', () => {
      const resident = [msg('m1', '2024-01-15T10:01:00Z'), msg('m2', '2024-01-15T10:02:00Z'), msg('m3', '2024-01-15T10:03:00Z')]
      const result = appendLive(resident, msg('m4', '2024-01-15T10:04:00Z'), true, cfg)

      expect(result.kind).toBe('appended')
      if (result.kind === 'appended') {
        expect(result.messages.map((m) => m.id)).toEqual(['m2', 'm3', 'm4'])
      }
    })

    it('gates the append when the window slid off the live edge', () => {
      const resident = [msg('m1', '2024-01-15T10:01:00Z')]
      const result = appendLive(resident, msg('m2', '2024-01-15T10:02:00Z'), false, cfg)

      expect(result.kind).toBe('gated')
    })

    it('drops an exact duplicate without touching the array', () => {
      const original = msg('m1', '2024-01-15T10:01:00Z', { stanzaId: 'arch-1' })
      const result = appendLive([original], { ...original }, true, cfg)

      expect(result.kind).toBe('duplicate-unchanged')
    })

    it('backfills the archive stanzaId from a dropped duplicate echo', () => {
      const original = msg('m1', '2024-01-15T10:01:00Z', { originId: 'origin-1' })
      const echo = { ...original, stanzaId: 'arch-1' }

      const result = appendLive([original], echo, true, cfg)

      expect(result.kind).toBe('duplicate-backfilled')
      if (result.kind === 'duplicate-backfilled') {
        expect(result.messages[0].stanzaId).toBe('arch-1')
        expect(result.patched.map((p) => p.id)).toEqual(['m1'])
      }
    })
  })

  describe('mergeArchive', () => {
    const resident = [msg('m5', '2024-01-15T10:05:00Z'), msg('m6', '2024-01-15T10:06:00Z')]

    it('backward merge prepends older messages and keeps the oldest on overflow', () => {
      const older = [msg('m1', '2024-01-15T10:01:00Z'), msg('m2', '2024-01-15T10:02:00Z')]
      const result = mergeArchive(resident, older, 'backward', cfg)

      // window 3, keep-oldest: m1, m2, m5 — the newest tail (m6) is evicted
      expect(result.merged.map((m) => m.id)).toEqual(['m1', 'm2', 'm5'])
      expect(result.newestEvicted).toBe(true)
      expect(result.newMessages.map((m) => m.id)).toEqual(['m1', 'm2'])
    })

    it('backward merge under the bound does not evict', () => {
      const older = [msg('m4', '2024-01-15T10:04:00Z')]
      const result = mergeArchive(resident, older, 'backward', cfg)

      expect(result.merged.map((m) => m.id)).toEqual(['m4', 'm5', 'm6'])
      expect(result.newestEvicted).toBe(false)
    })

    it('forward merge sorts newer messages in and keeps the newest', () => {
      const newer = [msg('m8', '2024-01-15T10:08:00Z'), msg('m7', '2024-01-15T10:07:00Z')]
      const result = mergeArchive(resident, newer, 'forward', cfg)

      expect(result.merged.map((m) => m.id)).toEqual(['m6', 'm7', 'm8'])
      expect(result.newestEvicted).toBe(false)
    })

    it('reports no new messages when the batch is all duplicates', () => {
      const result = mergeArchive(resident, [{ ...resident[0] }], 'forward', cfg)

      expect(result.newMessages).toEqual([])
      expect(result.merged).toBe(resident)
    })

    it('backfills archive ids onto resident messages before deduping (both directions)', () => {
      const own = msg('own-1', '2024-01-15T10:06:30Z', { originId: 'origin-9' })
      const archiveEcho = { ...own, stanzaId: 'arch-9' }

      const result = mergeArchive([...resident, own], [archiveEcho], 'forward', { ...cfg, windowSize: 10 })

      const patchedResident = result.merged.find((m) => m.id === 'own-1')
      expect(patchedResident?.stanzaId).toBe('arch-9')
      expect(result.patched.map((p) => p.id)).toEqual(['own-1'])
      // The echo itself still dedups away
      expect(result.newMessages).toEqual([])
    })
  })

  describe('loadOlderSlice', () => {
    it('dedupes, sorts, and keeps the oldest on overflow, reporting the slide', () => {
      const current = [msg('m4', '2024-01-15T10:04:00Z'), msg('m5', '2024-01-15T10:05:00Z')]
      const batch = [
        { ...current[0] }, // overlap at the before: boundary
        msg('m2', '2024-01-15T10:02:00Z'),
        msg('m1', '2024-01-15T10:01:00Z'), // out of order
      ]

      const result = loadOlderSlice(current, batch, cfg)

      expect(result.merged.map((m) => m.id)).toEqual(['m1', 'm2', 'm4'])
      expect(result.newestEvicted).toBe(true)
    })

    it('does not report a slide when the batch fits under the bound', () => {
      const current = [msg('m4', '2024-01-15T10:04:00Z')]
      const result = loadOlderSlice(current, [msg('m3', '2024-01-15T10:03:00Z')], cfg)

      expect(result.merged.map((m) => m.id)).toEqual(['m3', 'm4'])
      expect(result.newestEvicted).toBe(false)
    })
  })

  describe('loadNewerSlice', () => {
    it('dedupes, sorts, and keeps the newest on overflow', () => {
      const current = [msg('m1', '2024-01-15T10:01:00Z'), msg('m2', '2024-01-15T10:02:00Z')]
      const batch = [
        msg('m4', '2024-01-15T10:04:00Z'), // out of order
        { ...current[1] }, // overlap at the after: boundary
        msg('m3', '2024-01-15T10:03:00Z'),
      ]

      const result = loadNewerSlice(current, batch, cfg)

      expect(result.merged.map((m) => m.id)).toEqual(['m2', 'm3', 'm4'])
    })
  })

  describe('latestSlice', () => {
    it('merges a cache slice into the resident array keeping the newest', () => {
      const current = [msg('m2', '2024-01-15T10:02:00Z')]
      const batch = [msg('m3', '2024-01-15T10:03:00Z'), { ...current[0] }, msg('m1', '2024-01-15T10:01:00Z')]

      const result = latestSlice(current, batch, cfg)

      expect(result.merged.map((m) => m.id)).toEqual(['m1', 'm2', 'm3'])
    })
  })
})

describe('messageTimeline slice results', () => {
  const cfgLocal = { getKeys, windowSize: 3 }

  it('slice loads report new messages and keep the input reference on all-duplicate batches', () => {
    const current = [msg('m1', '2024-01-15T10:01:00Z')]

    const older = loadOlderSlice(current, [{ ...current[0] }], cfgLocal)
    expect(older.merged).toBe(current)
    expect(older.newMessages).toEqual([])
    expect(older.newestEvicted).toBe(false)

    const newer = loadNewerSlice(current, [{ ...current[0] }], cfgLocal)
    expect(newer.merged).toBe(current)
    expect(newer.newMessages).toEqual([])

    const latest = latestSlice(current, [{ ...current[0] }], cfgLocal)
    expect(latest.merged).toBe(current)
    expect(latest.newMessages).toEqual([])
  })
})
