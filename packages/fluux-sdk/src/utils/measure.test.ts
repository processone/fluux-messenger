import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { measured, setMeasurementEnabled } from './measure'

beforeEach(() => {
  performance.clearMarks()
  performance.clearMeasures()
  setMeasurementEnabled(false)
})

afterEach(() => setMeasurementEnabled(false))

const names = () => performance.getEntriesByType('measure').map((e) => e.name)

describe('measured', () => {
  it('costs nothing and emits nothing while disabled, which is every release build', () => {
    // The SDK ships to consumers who never enable this. A mark per persistence write
    // would grow the performance buffer for the life of their process.
    expect(measured('persist', () => 42)).toBe(42)
    expect(names()).toEqual([])
    expect(performance.getEntriesByType('mark')).toEqual([])
  })

  it('emits one measure under a namespaced name when enabled', () => {
    setMeasurementEnabled(true)
    expect(measured('persist', () => 42)).toBe(42)
    expect(names()).toEqual(['fluux:persist'])
  })

  it('returns the value through unchanged, so a call site can wrap in place', () => {
    setMeasurementEnabled(true)
    const value = { rows: 3 }
    expect(measured('merge', () => value)).toBe(value)
  })

  it('measures a throwing operation and lets the error through', () => {
    // A persistence write that throws is exactly the slow case worth seeing, and
    // swallowing the error here would change store behaviour to serve a diagnostic.
    setMeasurementEnabled(true)
    expect(() => measured('persist', () => { throw new Error('quota') })).toThrow('quota')
    expect(names()).toEqual(['fluux:persist'])
  })

  it('leaves no marks behind, so the buffer cannot grow without bound', () => {
    setMeasurementEnabled(true)
    for (let i = 0; i < 5; i++) measured('persist', () => i)
    expect(performance.getEntriesByType('mark')).toEqual([])
  })

  it('survives a host with no performance API rather than breaking the store', () => {
    setMeasurementEnabled(true)
    const real = globalThis.performance
    // @ts-expect-error deliberately removing the global
    delete globalThis.performance
    try {
      expect(measured('persist', () => 7)).toBe(7)
    } finally {
      globalThis.performance = real
    }
  })

  it('preserves operation outcomes when User Timing methods throw', () => {
    setMeasurementEnabled(true)
    const real = globalThis.performance
    globalThis.performance = {
      mark: () => { throw new Error('mark unavailable') },
      measure: () => { throw new Error('measure unavailable') },
      clearMarks: () => { throw new Error('clear unavailable') },
    } as unknown as Performance
    const value = { rows: 3 }
    const operationError = new Error('operation failed')
    let calls = 0
    try {
      expect(measured('persist', () => {
        calls++
        return value
      })).toBe(value)
      let thrown: unknown
      try {
        measured('persist', () => {
          calls++
          throw operationError
        })
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBe(operationError)
      expect(calls).toBe(2)
    } finally {
      globalThis.performance = real
    }
  })
})

describe('a failed mark must not borrow another invocation timing', () => {
  it('emits no measure when its own start mark could not be made', () => {
    // The dangerous shape: an earlier invocation's `clearMarks` failed and left a
    // mark behind, and this one's `mark` fails too. Measuring anyway silently
    // times from the LEAKED mark and reports a duration belonging to neither
    // operation — a diagnostic that lies is worse than one that is absent.
    setMeasurementEnabled(true)
    performance.mark('fluux:persist:start') // the leaked mark
    const realMark = performance.mark.bind(performance)
    performance.mark = () => {
      throw new Error('marks unavailable')
    }
    try {
      expect(measured('persist', () => 'value')).toBe('value')
    } finally {
      performance.mark = realMark
    }

    expect(names()).toEqual([])
  })

  it('still runs the operation and returns its value when marking fails', () => {
    setMeasurementEnabled(true)
    const realMark = performance.mark.bind(performance)
    performance.mark = () => {
      throw new Error('marks unavailable')
    }
    let ran = false
    try {
      const out = measured('persist', () => {
        ran = true
        return 7
      })
      expect(out).toBe(7)
    } finally {
      performance.mark = realMark
    }
    expect(ran).toBe(true)
  })

  it('still lets the operation error through when marking fails', () => {
    // The contract this module states: a diagnostic must never be the reason a
    // store write fails, and never substitute its own outcome for the real one.
    setMeasurementEnabled(true)
    const realMark = performance.mark.bind(performance)
    performance.mark = () => {
      throw new Error('marks unavailable')
    }
    try {
      expect(() => measured('persist', () => { throw new Error('quota') })).toThrow('quota')
    } finally {
      performance.mark = realMark
    }
  })
})
