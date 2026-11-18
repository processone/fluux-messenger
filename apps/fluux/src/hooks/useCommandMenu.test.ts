import { describe, it, expect } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { CommandSelf } from '../commands/types'
import { matchCommandMenu, useCommandMenu } from './useCommandMenu'

describe('matchCommandMenu', () => {
  it('is inactive for non-command text', () => {
    expect(matchCommandMenu('hello', 5, 'room').isActive).toBe(false)
  })
  it('is inactive once a space is typed (name is complete)', () => {
    expect(matchCommandMenu('/kick alice', 11, 'room').isActive).toBe(false)
  })
  it('activates on a bare partial command at position 0', () => {
    const m = matchCommandMenu('/ki', 3, 'room', { role: 'moderator', affiliation: 'owner' })
    expect(m.isActive).toBe(true)
    expect(m.matches.map((c) => c.name)).toContain('kick')
  })
  it('hides capability-gated commands when self is unknown', () => {
    const m = matchCommandMenu('/', 1, 'room')
    expect(m.matches.map((c) => c.name)).not.toContain('kick')
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

// Intent: every edit resets the menu's highlight and dismissal, also an edit back to
// text the menu was on before, as when Backspace undoes the last key typed.
describe('useCommandMenu', () => {
  const OWNER: CommandSelf = { role: 'moderator', affiliation: 'owner' }
  const renderMenu = () =>
    renderHook(({ text }) => useCommandMenu(text, text.length, 'room', OWNER), { initialProps: { text: '/' } })

  it('shows a dismissed menu again after an edit back to the same text', () => {
    const { result, rerender } = renderMenu()
    act(() => result.current.dismiss())
    expect(result.current.state.isActive).toBe(false)
    rerender({ text: '/m' })
    rerender({ text: '/' })
    expect(result.current.state.isActive).toBe(true)
  })

  it('highlights the first command again after an edit back to the same text', () => {
    const { result, rerender } = renderMenu()
    act(() => result.current.moveSelection('down'))
    expect(result.current.state.selectedIndex).toBe(1)
    rerender({ text: '/m' })
    rerender({ text: '/' })
    expect(result.current.state.selectedIndex).toBe(0)
  })
})
