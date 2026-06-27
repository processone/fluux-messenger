import { describe, it, expect } from 'vitest'
import * as pretext from '@chenglou/pretext'

describe('pretext smoke', () => {
  it('exposes a prepare and a layout function', () => {
    expect(typeof (pretext as Record<string, unknown>).prepare).toBe('function')
    expect(typeof (pretext as Record<string, unknown>).layout).toBe('function')
  })
})
