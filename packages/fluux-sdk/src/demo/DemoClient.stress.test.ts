// packages/fluux-sdk/src/demo/DemoClient.stress.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { DemoClient } from './DemoClient'

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
})
