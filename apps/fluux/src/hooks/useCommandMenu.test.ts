import { describe, it, expect } from 'vitest'
import { matchCommandMenu } from './useCommandMenu'

describe('matchCommandMenu', () => {
  it('is inactive for non-command text', () => {
    expect(matchCommandMenu('hello', 5, 'room').isActive).toBe(false)
  })
  it('is inactive once a space is typed (name is complete)', () => {
    expect(matchCommandMenu('/kick alice', 11, 'room').isActive).toBe(false)
  })
  it('activates on a bare partial command at position 0', () => {
    const m = matchCommandMenu('/ki', 3, 'room')
    expect(m.isActive).toBe(true)
    expect(m.matches.map((c) => c.name)).toContain('kick')
  })
  it('lists all context commands for a lone slash', () => {
    const m = matchCommandMenu('/', 1, 'room')
    expect(m.isActive).toBe(true)
    expect(m.matches.length).toBeGreaterThan(1)
  })
  it('matches aliases', () => {
    const m = matchCommandMenu('/lea', 4, 'room')
    expect(m.matches.map((c) => c.name)).toContain('part')
  })
  it('hides capability-gated commands the user lacks', () => {
    const m = matchCommandMenu('/', 1, 'room', { role: 'participant', affiliation: 'none' })
    expect(m.matches.map((c) => c.name)).not.toContain('kick')
  })
  it('does not activate when the cursor is not at the end of the token', () => {
    // caret at index 1 (right after the slash) while text has more chars typed later
    expect(matchCommandMenu('/kick', 0, 'room').isActive).toBe(false)
  })
})
