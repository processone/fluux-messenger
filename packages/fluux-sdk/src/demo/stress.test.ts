import { describe, it, expect } from 'vitest'
import { buildStressEvents } from './stress'

const ctx = { selfJid: 'you@fluux.chat', selfNick: 'you', conferenceService: 'conference.fluux.chat' }

describe('buildStressEvents (room-join)', () => {
  it('emits added/joined/self-occupant/occupants-batch then N messages per room', () => {
    const ev = buildStressEvents({ kind: 'room-join', rooms: 2, occupants: 3, messagesPerRoom: 4 }, ctx)
    const room0 = ev.filter(e =>
      e.type === 'room:added'
        ? e.payload.room.jid === 'stress-0@conference.fluux.chat'
        : e.payload.roomJid === 'stress-0@conference.fluux.chat'
    )
    const types = room0.map(e => e.type)
    expect(types.slice(0, 4)).toEqual(['room:added', 'room:joined', 'room:self-occupant', 'room:occupants-batch'])
    expect(room0.filter(e => e.type === 'room:message')).toHaveLength(4)
    // total = rooms * (4 setup + messagesPerRoom)
    expect(ev).toHaveLength(2 * (4 + 4))
  })

  it('backfill mode keeps a stable, non-increasing order (later rooms older)', () => {
    const ev = buildStressEvents({ kind: 'room-join', rooms: 3, messagesPerRoom: 2, mode: 'backfill' }, ctx)
    const tsOf = (i: number) => {
      const e = ev.find(e => e.type === 'room:message' && e.payload.roomJid === `stress-${i}@conference.fluux.chat`)!
      return e.type === 'room:message' ? e.payload.message.timestamp.getTime() : 0
    }
    expect(tsOf(0)).toBeGreaterThan(tsOf(1))
    expect(tsOf(1)).toBeGreaterThan(tsOf(2))
  })

  it('live mode assigns strictly increasing message timestamps (reorders)', () => {
    const ev = buildStressEvents({ kind: 'room-join', rooms: 2, messagesPerRoom: 3, mode: 'live' }, ctx)
    const stamps = ev
      .filter(e => e.type === 'room:message')
      .map(e => e.type === 'room:message' ? e.payload.message.timestamp.getTime() : 0)
    const sorted = [...stamps].sort((a, b) => a - b)
    expect(stamps).toEqual(sorted)
    expect(new Set(stamps).size).toBe(stamps.length) // all distinct
  })

  it('includes the self occupant first in the occupants batch', () => {
    const ev = buildStressEvents({ kind: 'room-join', rooms: 1, occupants: 2, messagesPerRoom: 0 }, ctx)
    const batch = ev.find(e => e.type === 'room:occupants-batch')!
    if (batch.type !== 'room:occupants-batch') throw new Error('expected batch')
    expect(batch.payload.occupants[0].jid).toBe(ctx.selfJid)
  })
})
