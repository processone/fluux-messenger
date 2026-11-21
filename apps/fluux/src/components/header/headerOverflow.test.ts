import { describe, it, expect } from 'vitest'
import { OVERFLOW_TIER, inlineClass, kebabClass } from './headerOverflow'

describe('headerOverflow tiers', () => {
  it('pinned actions are always inline and never in the kebab', () => {
    expect(inlineClass('pinned')).toBe('flex')
    expect(kebabClass('pinned')).toBe('hidden')
  })

  it('search reveals inline at the medium container width and hides its kebab copy there', () => {
    expect(inlineClass('search')).toBe('hidden @[440px]:flex')
    expect(kebabClass('search')).toBe('block @[440px]:hidden')
  })

  it('kebab rows use block (not flex) for their visible state so stacked submenu sections lay out vertically', () => {
    expect(kebabClass('search').startsWith('block ')).toBe(true)
  })

  it('uses the @[…] arbitrary container syntax, not the unsupported @min-[…] form', () => {
    // @tailwindcss/container-queries v0.1.x emits CSS only for @[Npx]; the
    // @min-[Npx] spelling silently produces nothing, breaking the collapse.
    for (const tier of Object.values(OVERFLOW_TIER)) {
      expect(tier.inline).not.toContain('@min-[')
      expect(tier.kebab).not.toContain('@min-[')
    }
  })

  it('OVERFLOW_TIER strings are literal so Tailwind JIT can see them', () => {
    // Guards against anyone refactoring to dynamic concatenation.
    expect(OVERFLOW_TIER.search.inline).toBe('hidden @[440px]:flex')
  })
})
