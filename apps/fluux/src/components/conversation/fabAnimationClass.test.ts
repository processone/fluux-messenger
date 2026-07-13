import { describe, it, expect } from 'vitest'
import { fabAnimationClass } from './fabAnimationClass'

describe('fabAnimationClass', () => {
  it('is statically hidden with no exit animation when never shown (fresh open at bottom)', () => {
    const cls = fabAnimationClass(false, false)
    expect(cls).not.toContain('fab-spring-out')
    expect(cls).not.toContain('fab-spring-in')
    expect(cls).toContain('opacity-0')
    expect(cls).toContain('pointer-events-none')
  })

  it('plays the spring-in animation when visible', () => {
    const cls = fabAnimationClass(true, false)
    expect(cls).toContain('fab-spring-in')
  })

  it('plays the spring-out animation only after having been visible', () => {
    const cls = fabAnimationClass(false, true)
    expect(cls).toContain('fab-spring-out')
    expect(cls).toContain('pointer-events-none')
  })

  it('prefers the spring-in animation when visible even after prior visibility', () => {
    const cls = fabAnimationClass(true, true)
    expect(cls).toContain('fab-spring-in')
    expect(cls).not.toContain('fab-spring-out')
  })
})
