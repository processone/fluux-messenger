import { describe, expect, it } from 'vitest'
import {
  CHAT_SCOPE,
  chatArchiveConflict,
  identityKeys,
  mergeableOccupantCandidates,
  roomScope,
  sameChatMessage,
  sameLogicalMessage,
  selectRoomMergeTargets,
} from '../../utils/messageIdentity'
import { roomStanzaIdsMergeable } from '../../utils/roomStanzaId'
import { backfillArchiveIds, mergeAndProcessMessages } from './messageArrayUtils'
import { mergeArchive, type TimelineConfig } from './messageTimeline'

interface Row {
  id: string
  from: string
  roomJid: string
  timestamp: Date
  stanzaId?: string
  originId?: string
  occupantId?: string
}

const roomJid = 'fixture@conference.example.com'
const row = (id: string, extra: Partial<Row> = {}): Row => ({
  id, from: `${roomJid}/alice`, roomJid, timestamp: new Date(1_000), ...extra,
})

function config(kind: 'chat' | 'room'): TimelineConfig<Row> {
  const scope = kind === 'chat' ? CHAT_SCOPE : roomScope(roomJid)
  return {
    kind,
    windowSize: 1_000,
    getKeys: message => identityKeys(scope, message),
    sameMessage: kind === 'chat' ? sameChatMessage : (a, b) =>
      sameLogicalMessage(scope, a, b) && roomStanzaIdsMergeable(a, b),
    getMergeCandidates: (incoming, candidates) => kind === 'chat'
      ? candidates.filter(candidate => !chatArchiveConflict(incoming, candidate))
      : selectRoomMergeTargets(scope, incoming,
        mergeableOccupantCandidates(incoming, candidates).filter(candidate => roomStanzaIdsMergeable(incoming, candidate))),
  }
}

function scan<T>(messages: readonly T[], incoming: T, getKeys: (message: T) => string[]): T[] {
  const incomingKeys = new Set(getKeys(incoming))
  return messages.filter(message => getKeys(message).some(key => incomingKeys.has(key)))
}

function expectSameCandidates<T>(actual: readonly T[], expected: readonly T[]): void {
  expect(actual).toHaveLength(expected.length)
  expected.forEach((message, index) => expect(actual[index]).toBe(message))
}

describe('archive identity lookup', () => {
  it.each(['new', 'overlap', 'backfill'])('bounds identity-key work for a %s page', variant => {
    const cfg = config('chat')
    const resident = Array.from({ length: 600 }, (_, i) => row(`m${i}`, {
      stanzaId: variant === 'backfill' ? undefined : `archive-${i}`,
      timestamp: new Date(i * 1_000),
    }))
    const incoming = Array.from({ length: 100 }, (_, i) => {
      const index = (variant === 'new' ? 600 : 500) + i
      return row(`m${index}`, { stanzaId: `archive-${index}`, timestamp: new Date(index * 1_000) })
    })
    let keyReads = 0
    const result = mergeArchive(resident, incoming, 'forward', {
      ...cfg,
      getKeys: message => { keyReads++; return cfg.getKeys(message) },
    }, false, true)

    expect(result.newMessages).toHaveLength(variant === 'new' ? 100 : 0)
    expect(result.patched).toHaveLength(variant === 'backfill' ? 100 : 0)
    expect(result.resident).toHaveLength(variant === 'new' ? 700 : 600)
    expect(keyReads).toBeLessThanOrEqual(4 * (resident.length + incoming.length))
  })

  it.each(['chat', 'room'] as const)('preserves scan candidates for mixed randomized %s identities', kind => {
    let seed = 0x1394
    const random = (bound: number): number => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0
      return seed % bound
    }
    const cfg = config(kind)
    const make = (): Row => row(`m${random(8)}`, {
      stanzaId: random(3) ? `s${random(9)}` : undefined,
      originId: random(3) ? `o${random(7)}` : undefined,
      occupantId: kind === 'room' && random(3) ? `occupant-${random(2)}` : undefined,
      from: `${roomJid}/${random(2) ? 'alice' : 'bob'}`,
      timestamp: new Date(random(5) * 1_000),
    })

    for (let trial = 0; trial < 60; trial++) {
      const resident = Array.from({ length: random(35) }, make)
      const incoming = Array.from({ length: random(20) }, make)
      if (resident.length) resident.push(resident[0]) // Two positions may hold the same object.
      const donors = incoming.filter(message => message.stanzaId)
      const backfilled = backfillArchiveIds(resident, incoming, cfg.getKeys, cfg.sameMessage,
        (message, candidates) => {
          expectSameCandidates(candidates, scan(resident.includes(message) ? donors : resident, message, cfg.getKeys))
          return cfg.getMergeCandidates(message, candidates)
        })
      const expectedNew = incoming.filter(message => !cfg.getMergeCandidates(message,
        scan(backfilled.messages, message, cfg.getKeys)).some(candidate => cfg.sameMessage(candidate, message)))
      const result = mergeAndProcessMessages(backfilled.messages, incoming, cfg.getKeys, kind,
        undefined, cfg.sameMessage, (message, candidates) => {
          expectSameCandidates(candidates, scan(backfilled.messages, message, cfg.getKeys))
          return cfg.getMergeCandidates(message, candidates)
        })
      expectSameCandidates(result.newMessages, expectedNew)
    }
  })

  it('keeps repeated and empty keys equivalent to a scan, preserving candidate order and positions', () => {
    const resident = [row('a'), row('b'), row('empty'), row('a')]
    resident.push(resident[0])
    const incoming = [row('query'), row('empty')]
    const keys = (message: Row): string[] => message.id === 'empty' ? []
      : message.id === 'query' ? ['b', 'a', 'b'] : [message.id, message.id]
    const result = mergeAndProcessMessages(resident, incoming, keys, 'chat', undefined,
      () => false, (message, candidates) => {
        expectSameCandidates(candidates, scan(resident, message, keys))
        return [...candidates]
      })
    expectSameCandidates(result.newMessages, incoming)
  })

  it('preserves donor order and duplicate positions when backfilling through repeated keys', () => {
    const resident = [row('a'), row('b'), row('empty')]
    const donor = row('both', { stanzaId: 'first' })
    const incoming = [donor, row('both', { stanzaId: 'second' }), donor]
    const keys = (message: Row): string[] => message.id === 'empty' ? []
      : message.id === 'both' ? ['b', 'a', 'b'] : [message.id, message.id]
    const result = backfillArchiveIds(resident, incoming, keys, () => true,
      (message, candidates) => {
        expectSameCandidates(candidates, scan(resident.includes(message) ? incoming : resident, message, keys))
        return [...candidates]
      })
    expect(result.messages.map(message => message.stanzaId)).toEqual(['first', 'first', undefined])
    expect(result.patched).toHaveLength(2)
    expect(resident.every(message => message.stanzaId === undefined)).toBe(true)
  })

  it('deduplicates against residents without making incoming rows deduplicate each other', () => {
    const cfg = config('chat')
    const incoming = [row('new'), row('new')]
    const result = mergeAndProcessMessages([], incoming, cfg.getKeys, 'chat', undefined,
      cfg.sameMessage, cfg.getMergeCandidates)
    expectSameCandidates(result.newMessages, incoming)
    expectSameCandidates(result.merged, incoming)
  })

  it('keeps chat archive conflicts, backfills the live copy and makes an overlap replay idempotent', () => {
    const cfg = config('chat')
    const first = row('reused', { stanzaId: 'archive-first', timestamp: new Date(1_000) })
    const second = row('reused', { stanzaId: 'archive-second', timestamp: new Date(2_000) })
    const live = row('live', { originId: 'live-origin', timestamp: new Date(3_000) })
    const echo = row('other-id', { originId: 'live-origin', stanzaId: 'archive-live', timestamp: live.timestamp })
    const conflict = row('reused', { stanzaId: 'archive-third', timestamp: new Date(4_000) })
    const between = row('between', { stanzaId: 'archive-between', timestamp: second.timestamp })
    const incoming = [conflict, echo, { ...second }, between]
    const result = mergeArchive([first, second, live], incoming, 'forward', cfg, false, true)

    expect(result.newMessages).toEqual([conflict, between])
    expect(result.patched).toEqual([{ ...live, stanzaId: 'archive-live' }])
    expect(result.resident).toEqual([first, between, second, result.patched[0], conflict])
    expect(live.stanzaId).toBeUndefined()
    const replay = mergeArchive(result.resident, incoming, 'forward', cfg, false, true)
    expect(replay.newMessages).toEqual([])
    expect(replay.patched).toEqual([])
    expect(replay.resident).toEqual(result.resident)
  })

  it('does not let an occupant-less room donor bridge two occupants sharing a nick and client id', () => {
    const cfg = config('room')
    const first = row('reused', { occupantId: 'first' })
    const second = row('reused', { occupantId: 'second' })
    const ambiguous = row('reused', { stanzaId: 'archive-ambiguous' })
    const result = mergeArchive([first, second], [ambiguous], 'forward', cfg, false, true)
    expect(result.patched).toEqual([])
    expect(result.newMessages).toEqual([ambiguous])
    expect(result.resident).toHaveLength(3)

    const confirmed = { ...second, stanzaId: 'archive-second' }
    const identified = mergeArchive([first, second], [confirmed], 'forward', cfg, false, true)
    expect(identified.newMessages).toEqual([])
    expect(identified.patched).toEqual([confirmed])
    expect(identified.resident).toEqual([first, confirmed])
  })

  it('backfills only the reciprocal room target when fallback candidates have different delivery times', () => {
    const cfg = config('room')
    const older = row('reused', { timestamp: new Date(1_000) })
    const newer = row('reused', { timestamp: new Date(100_000) })
    const donor = { ...newer, stanzaId: 'archive-newer' }
    const result = backfillArchiveIds([older, newer], [donor], cfg.getKeys, cfg.sameMessage, cfg.getMergeCandidates)
    expect(result.messages).toEqual([older, donor])
    expect(result.messages[0]).toBe(older)
    expect(result.patched).toEqual([donor])
  })
})
