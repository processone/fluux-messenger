/**
 * FLM-120 review R8: on a resumed session the "Updating..." step waits for the
 * server's reply to a ping sent after the resume. Encrypted replayed messages
 * reach the store only when their asynchronous decrypt ends, which can be
 * after that reply, so the wait also covers the decrypts still running, within
 * the same time limit.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { localStorageMock } from './sideEffects.testHelpers'

Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true })

import { XMPPClient, getInternalSurfaceForTesting } from './XMPPClient'
import { createMockXmppClient, createMockElement } from './test-utils'

vi.mock('@xmpp/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xmpp/client')>()
  return { ...actual, client: vi.fn(() => createMockXmppClient()) }
})
vi.mock('@xmpp/debug', () => ({ default: vi.fn() }))

describe('waiting for a resumed session replay', () => {
  let client: XMPPClient
  let pingReply: ReturnType<typeof vi.fn<() => Promise<unknown>>>

  beforeEach(() => {
    vi.useFakeTimers()
    client = new XMPPClient({ debug: false })
    // The server answers the ping at once: its replay is fully received.
    pingReply = vi.fn<() => Promise<unknown>>().mockResolvedValue(createMockElement('iq', { type: 'result' }))
    vi.spyOn(client as unknown as { sendIQ: () => Promise<unknown> }, 'sendIQ').mockImplementation(pingReply)
  })
  afterEach(() => {
    client.destroy()
    vi.useRealTimers()
  })

  const waitFor = (timeoutMs: number) => {
    let done = false
    const promise = getInternalSurfaceForTesting(client).waitForReplayIngested(timeoutMs).then(() => { done = true })
    return { promise, isDone: () => done }
  }

  it('waits for an encrypted message whose decrypt ends after the ping reply', async () => {
    let endDecrypt!: () => void
    vi.spyOn(client.messages, 'whenLiveDecryptsSettled')
      .mockReturnValue(new Promise<void>((r) => { endDecrypt = r }))
    const wait = waitFor(10_000)

    await vi.advanceTimersByTimeAsync(1_000)
    expect(pingReply).toHaveBeenCalledTimes(1)
    expect(wait.isDone()).toBe(false)

    endDecrypt()
    await vi.advanceTimersByTimeAsync(0)
    expect(wait.isDone()).toBe(true)
  })

  it('stops waiting for a decrypt that never ends at the time limit, counted from the call', async () => {
    vi.spyOn(client.messages, 'whenLiveDecryptsSettled').mockReturnValue(new Promise<void>(() => {}))
    const wait = waitFor(10_000)
    await vi.advanceTimersByTimeAsync(9_999)
    expect(wait.isDone()).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(wait.isDone()).toBe(true)
  })

  it('ends with the ping reply when nothing is being decrypted', async () => {
    const wait = waitFor(10_000)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(wait.isDone()).toBe(true)
  })
})
