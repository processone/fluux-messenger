import { describe, expect, it } from 'vitest'
import { getShowColor } from './presence'

describe('presence indicator classes', () => {
  it.each(['away', 'xa'] as const)('gives %s the shared orange square cue', (show) => {
    expect(getShowColor(show)).toBe('bg-fluux-presence-away presence-away')
  })

  it('gives DND the shared hollow ring cue', () => {
    expect(getShowColor('dnd')).toBe('presence-dnd')
  })

  it.each(['away', 'xa', 'dnd'] as const)('removes the %s cue while the app is offline', (show) => {
    expect(getShowColor(show, true)).toBe('bg-slate-500')
  })

  it.each([null, undefined, 'chat'] as const)('keeps %s online green', (show) => {
    expect(getShowColor(show)).toBe('bg-fluux-green')
  })
})
