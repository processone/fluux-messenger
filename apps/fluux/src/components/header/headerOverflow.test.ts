import { describe, it, expect } from 'vitest'
import { OVERFLOW_TIER, KEBAB_TRIGGER_CLASS, inlineClass, kebabClass } from './headerOverflow'

describe('headerOverflow tiers', () => {
  it('pinned actions are always inline and never in the kebab', () => {
    expect(inlineClass('pinned')).toBe('flex')
    expect(kebabClass('pinned')).toBe('hidden')
  })

  it('search reveals inline at the medium container width and hides its kebab copy there', () => {
    expect(inlineClass('search')).toBe('hidden @min-[440px]:flex')
    expect(kebabClass('search')).toBe('flex @min-[440px]:hidden')
  })

  it('wide-tier actions reveal inline only on a wide container', () => {
    expect(inlineClass('wide')).toBe('hidden @min-[600px]:flex')
    expect(kebabClass('wide')).toBe('flex @min-[600px]:hidden')
  })

  it('the kebab trigger is hidden once the widest tier is inline', () => {
    expect(KEBAB_TRIGGER_CLASS).toContain('@min-[600px]:hidden')
  })

  it('OVERFLOW_TIER strings are literal so Tailwind JIT can see them', () => {
    // Guards against anyone refactoring to dynamic concatenation.
    expect(OVERFLOW_TIER.wide.inline).toBe('hidden @min-[600px]:flex')
  })
})
