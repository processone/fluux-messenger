// packages/fluux-sdk/src/demo/DemoClient.stress.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { DemoClient } from './DemoClient'
import { buildStressEvents } from './stress'
import type { RoomMessage } from '../core/types/room'

describe('buildStressEvents', () => {
  it('gives every generated room message a unique stanzaId (MDS markers match on it)', () => {
    const events = buildStressEvents(
      { kind: 'room-join', rooms: 2, occupants: 2, messagesPerRoom: 5, msgStepMs: 0, roomStepMs: 0 },
      { selfJid: 'you@fluux.chat', selfNick: 'you', conferenceService: 'conference.fluux.chat' }
    )
    const messages = events
      .filter((e) => e.type === 'room:message')
      .map((e) => (e.payload as { message: RoomMessage }).message)
    expect(messages).toHaveLength(10)
    const stanzaIds = messages.map((m) => m.stanzaId)
    expect(stanzaIds.every((sid) => typeof sid === 'string' && sid.length > 0)).toBe(true)
    expect(new Set(stanzaIds).size).toBe(10)
  })
})

describe('DemoClient.runStressScenario', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('emits the generated events over time and stop() cancels the rest', () => {
    const client = new DemoClient()
    // populateDemo sets selfJid/conferenceService; emulate minimally:
    ;(client as unknown as { selfJid: string }).selfJid = 'you@fluux.chat'
    ;(client as unknown as { conferenceService: string }).conferenceService = 'conference.fluux.chat'
    const emit = vi.spyOn(client as unknown as { emitSDK: (...a: unknown[]) => void }, 'emitSDK').mockImplementation(() => {})

    const handle = client.runStressScenario({ kind: 'room-join', rooms: 1, occupants: 1, messagesPerRoom: 3, msgStepMs: 10, roomStepMs: 0 })
    vi.advanceTimersByTime(25) // setup events (delay 0) + first message (delay 20)
    const afterFirst = emit.mock.calls.length
    expect(afterFirst).toBeGreaterThanOrEqual(5) // 4 setup + >=1 message

    handle.stop()
    vi.advanceTimersByTime(1000)
    expect(emit.mock.calls.length).toBe(afterFirst) // no further emits after stop
  })

  it('resolves done only after the last scheduled event has been emitted', async () => {
    const client = makeClient()
    const emit = spyEmit(client)

    // 3 messages at msgStepMs 20 => the last message is scheduled at 20 + 2*20 = 60ms.
    const handle = client.runStressScenario({ kind: 'room-join', rooms: 1, occupants: 1, messagesPerRoom: 3, msgStepMs: 20, roomStepMs: 0 })

    let resolved = false
    void handle.done.then(() => {
      resolved = true
    })

    // One tick short of the last event: the promise must still be pending, otherwise
    // a waiter would observe a partially seeded store.
    await vi.advanceTimersByTimeAsync(59)
    expect(resolved).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    expect(resolved).toBe(true)

    // Every generated event has been emitted by the time done resolves.
    const events = buildStressEvents(
      { kind: 'room-join', rooms: 1, occupants: 1, messagesPerRoom: 3, msgStepMs: 20, roomStepMs: 0 },
      { selfJid: 'you@fluux.chat', selfNick: 'you', conferenceService: 'conference.fluux.chat' }
    )
    expect(emit.mock.calls.length).toBe(events.length)
  })

  it('settles done on stop() so a cancelled scenario never leaves a waiter pending', async () => {
    const client = makeClient()
    spyEmit(client)

    const handle = client.runStressScenario({ kind: 'room-join', rooms: 1, occupants: 1, messagesPerRoom: 500, msgStepMs: 100, roomStepMs: 0 })
    handle.stop()

    // Would hang (and fail the test by timeout) if stop() left the promise pending.
    await expect(handle.done).resolves.toBeUndefined()
  })
})

function makeClient(): DemoClient {
  const client = new DemoClient()
  // populateDemo sets selfJid/conferenceService; emulate minimally:
  ;(client as unknown as { selfJid: string }).selfJid = 'you@fluux.chat'
  ;(client as unknown as { conferenceService: string }).conferenceService = 'conference.fluux.chat'
  return client
}

function spyEmit(client: DemoClient) {
  return vi
    .spyOn(client as unknown as { emitSDK: (...a: unknown[]) => void }, 'emitSDK')
    .mockImplementation(() => {})
}
