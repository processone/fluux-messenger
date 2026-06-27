import { describe, it, expect } from 'vitest'
import { CORPUS } from './corpus'

describe('pretext corpus', () => {
  it('covers every category with stable unique ids', () => {
    const cats = new Set(CORPUS.map((c) => c.category))
    for (const c of ['short', 'wrap', 'mention', 'link', 'emoji', 'rtl', 'me', 'longtoken', 'code', 'mixed']) {
      expect(cats.has(c as never)).toBe(true)
    }
    const ids = CORPUS.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(CORPUS.length).toBeGreaterThanOrEqual(30)
  })
})
