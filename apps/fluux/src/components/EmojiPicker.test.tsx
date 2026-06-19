import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { EmojiPicker } from './EmojiPicker'

// Capture the config emoji-mart's Picker is constructed with.
let lastPickerConfig: Record<string, unknown> | null = null

vi.mock('emoji-mart', () => ({
  // `new Picker(config)` returns a real DOM node so the component can
  // appendChild it; we record the config to assert on autoFocus.
  Picker: class {
    constructor(config: Record<string, unknown>) {
      lastPickerConfig = config
      return document.createElement('em-emoji-picker') as unknown as object
    }
  },
}))

vi.mock('@emoji-mart/data', () => ({ default: {} }))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ i18n: { language: 'en-US' } }),
}))

vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: (selector: (s: { themeMode: string }) => unknown) =>
    selector({ themeMode: 'dark' }),
}))

// useHasHover is the capability gate under test.
const mockHasHover = vi.fn<() => boolean>()
vi.mock('@/hooks', () => ({
  useHasHover: () => mockHasHover(),
}))

describe('EmojiPicker autoFocus gating', () => {
  beforeEach(() => {
    lastPickerConfig = null
    cleanup()
  })

  it('auto-focuses the search on devices with a hovering pointer (desktop)', () => {
    mockHasHover.mockReturnValue(true)
    render(<EmojiPicker onSelect={vi.fn()} onClose={vi.fn()} />)
    expect(lastPickerConfig?.autoFocus).toBe(true)
  })

  it('does NOT auto-focus the search on touch devices (avoids the on-screen keyboard)', () => {
    mockHasHover.mockReturnValue(false)
    render(<EmojiPicker onSelect={vi.fn()} onClose={vi.fn()} />)
    expect(lastPickerConfig?.autoFocus).toBe(false)
  })
})
