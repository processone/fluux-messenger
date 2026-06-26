import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { EmojiPicker } from './EmojiPicker'

// Capture the config emoji-mart's Picker is constructed with.
let lastPickerConfig: Record<string, unknown> | null = null
// Every config the Picker is constructed with, in order — lets us assert how
// many times the (expensive) web component was instantiated across re-renders.
const pickerConfigs: Record<string, unknown>[] = []

vi.mock('emoji-mart', () => ({
  // `new Picker(config)` returns a real DOM node so the component can
  // appendChild it; we record the config to assert on autoFocus.
  Picker: class {
    constructor(config: Record<string, unknown>) {
      lastPickerConfig = config
      pickerConfigs.push(config)
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
    pickerConfigs.length = 0
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

describe('EmojiPicker stability across re-renders', () => {
  beforeEach(() => {
    lastPickerConfig = null
    pickerConfigs.length = 0
    mockHasHover.mockReturnValue(true)
    cleanup()
  })

  // Regression: callers pass fresh inline onSelect/onClose closures every
  // render. When the message bubble re-renders while the picker is open
  // (background presence/typing/MAM churn), the picker must NOT be torn down
  // and rebuilt — that is the "menu disappears and reappears" flicker and it
  // swallows the in-flight emoji click.
  it('does not recreate the picker when callback props change identity', () => {
    const { rerender } = render(<EmojiPicker onSelect={vi.fn()} onClose={vi.fn()} />)
    expect(pickerConfigs).toHaveLength(1)

    rerender(<EmojiPicker onSelect={vi.fn()} onClose={vi.fn()} />)
    expect(pickerConfigs).toHaveLength(1)
  })

  // The picker must still call the *latest* onSelect after a re-render, so the
  // ref indirection that keeps it stable doesn't introduce a stale closure.
  it('routes emoji selection to the latest onSelect after a re-render', () => {
    const firstSelect = vi.fn()
    const secondSelect = vi.fn()
    const { rerender } = render(<EmojiPicker onSelect={firstSelect} onClose={vi.fn()} />)
    rerender(<EmojiPicker onSelect={secondSelect} onClose={vi.fn()} />)

    const onEmojiSelect = pickerConfigs[0].onEmojiSelect as (e: { native: string }) => void
    onEmojiSelect({ native: '🎉' })

    expect(secondSelect).toHaveBeenCalledWith('🎉')
    expect(firstSelect).not.toHaveBeenCalled()
  })
})
