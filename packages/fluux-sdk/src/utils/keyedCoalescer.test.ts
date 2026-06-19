import { describe, it, expect } from 'vitest'
import { createKeyedCoalescer } from './keyedCoalescer'

describe('createKeyedCoalescer', () => {
  it('buffers latest value per key while open and flushes one entry per key in insertion order', () => {
    const c = createKeyedCoalescer<string, number>()
    expect(c.isOpen()).toBe(false)
    expect(c.add('a', 1)).toBe(false) // closed → not buffered

    c.open()
    expect(c.isOpen()).toBe(true)
    expect(c.add('a', 1)).toBe(true)
    expect(c.add('b', 2)).toBe(true)
    expect(c.add('a', 3)).toBe(true) // latest-wins for 'a'
    expect(c.size()).toBe(2)

    const entries = c.flush()
    expect(entries).toEqual([
      { key: 'a', value: 3 },
      { key: 'b', value: 2 },
    ])
    // flush() clears + closes
    expect(c.isOpen()).toBe(false)
    expect(c.size()).toBe(0)
  })

  it('drop() clears without returning entries and closes the window', () => {
    const c = createKeyedCoalescer<string, number>()
    c.open()
    c.add('a', 1)
    c.drop()
    expect(c.isOpen()).toBe(false)
    expect(c.size()).toBe(0)
    expect(c.flush()).toEqual([])
  })

  it('delete(key) drops a buffered entry so it is not flushed', () => {
    const c = createKeyedCoalescer<string, number>()
    c.open()
    c.add('a', 1)
    c.add('b', 2)
    expect(c.delete('a')).toBe(true)
    expect(c.delete('missing')).toBe(false)
    expect(c.size()).toBe(1)
    expect(c.flush()).toEqual([{ key: 'b', value: 2 }])
  })
})
