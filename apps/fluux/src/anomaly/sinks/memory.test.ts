// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { createMemorySink } from './memory'

type WindowWithSink = Record<string, unknown> & { __fluuxAnomalies?: string[] }
const w = () => window as unknown as WindowWithSink

beforeEach(() => {
  delete w().__fluuxAnomalies
})

describe('createMemorySink', () => {
  it('publishes the lines on window for Playwright to poll', () => {
    const sink = createMemorySink()
    sink.write('a')
    sink.write('b')
    expect(w().__fluuxAnomalies).toEqual(['a', 'b'])
  })

  it('keeps the SAME array reference across writes', () => {
    // Playwright holds this reference between polls; rebinding it on every write
    // would make `expect.poll` read a snapshot that never grows.
    const sink = createMemorySink()
    const ref = w().__fluuxAnomalies
    sink.write('a')
    sink.write('b')
    expect(w().__fluuxAnomalies).toBe(ref)
  })

  it('bounds retention in place, dropping the oldest', () => {
    const sink = createMemorySink()
    const ref = w().__fluuxAnomalies
    for (let i = 0; i < 1200; i++) sink.write(`line-${i}`)

    expect(w().__fluuxAnomalies).toBe(ref)
    expect(w().__fluuxAnomalies).toHaveLength(1000)
    expect(w().__fluuxAnomalies![0]).toBe('line-200')
    expect(w().__fluuxAnomalies![999]).toBe('line-1199')
  })

  it('never reports a failure or disables itself', () => {
    const sink = createMemorySink()
    sink.write('a')
    expect(sink.failureCount()).toBe(0)
    expect(sink.disabled()).toBe(false)
  })
})
