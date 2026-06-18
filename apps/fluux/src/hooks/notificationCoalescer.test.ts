import { describe, it, expect } from 'vitest'
import { createNotificationCoalescer } from './notificationCoalescer'

describe('createNotificationCoalescer', () => {
  it('is closed initially and add returns false (caller dispatches immediately)', () => {
    const c = createNotificationCoalescer<string>()
    expect(c.isOpen()).toBe(false)
    expect(c.add('a', 'x')).toBe(false)
  })

  it('buffers latest payload per id while open and flushes one entry per id in insertion order', () => {
    const c = createNotificationCoalescer<string>()
    c.open()
    expect(c.isOpen()).toBe(true)
    expect(c.add('a', 'a1')).toBe(true)
    expect(c.add('a', 'a2')).toBe(true) // latest wins
    expect(c.add('b', 'b1')).toBe(true)
    expect(c.flush()).toEqual([
      { key: 'a', value: 'a2' },
      { key: 'b', value: 'b1' },
    ])
  })

  it('flush closes the window and clears the buffer', () => {
    const c = createNotificationCoalescer<string>()
    c.open()
    c.add('a', 'a1')
    c.flush()
    expect(c.isOpen()).toBe(false)
    expect(c.flush()).toEqual([])
  })

  it('drop clears the buffer and closes without returning entries', () => {
    const c = createNotificationCoalescer<string>()
    c.open()
    c.add('a', 'a1')
    c.drop()
    expect(c.isOpen()).toBe(false)
    expect(c.flush()).toEqual([])
  })
})
