import { describe, it, expect } from 'vitest'
import { builtinThemes, getBuiltinTheme, fluuxTheme } from './index'

describe('builtin themes', () => {
  it('default theme is named Aurora (id stays "fluux" for back-compat)', () => {
    expect(fluuxTheme.id).toBe('fluux')
    expect(fluuxTheme.name).toBe('Aurora')
    expect(getBuiltinTheme('fluux')?.name).toBe('Aurora')
  })

  it('includes the Indigo classic theme restoring the pre-Aurora palette', () => {
    const indigo = getBuiltinTheme('indigo')
    expect(indigo).toBeDefined()
    expect(indigo?.name).toBe('Indigo')
    expect(indigo?.variables.dark?.['--fluux-base-10']).toBe('#1e1f22')
    expect(indigo?.variables.dark?.['--fluux-accent-h']).toBe('235')
    expect(indigo?.variables.light?.['--fluux-base-10']).toBe('#e3e5e8')
  })

  it('lists Aurora first, then Indigo', () => {
    expect(builtinThemes[0].id).toBe('fluux')
    expect(builtinThemes[1].id).toBe('indigo')
  })

  it('registers the Pure theme optimized for OLED/e-ink', () => {
    const pure = getBuiltinTheme('pure')
    expect(pure).toBeDefined()
    expect(pure?.name).toBe('Pure')
    // Forces solid glass so true-black / flat-white is not broken by frost.
    expect(pure?.transparency).toBe('reduced')
    // OLED: the main content + sidebar chrome are true black.
    expect(pure?.variables.dark?.['--fluux-chat-bg']).toBe('#000000')
    expect(pure?.variables.dark?.['--fluux-sidebar-bg']).toBe('#000000')
    // e-ink: the main content + sidebar chrome are flat white.
    expect(pure?.variables.light?.['--fluux-chat-bg']).toBe('#ffffff')
    expect(pure?.variables.light?.['--fluux-sidebar-bg']).toBe('#ffffff')
  })
})
