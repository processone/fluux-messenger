import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { EmojiPicker } from './EmojiPicker'
import { EscapeModal } from '@/test-utils/escapeModal'

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

// The captain's ruling on review R3, applied by review R5: with stacked overlays, Escape
// closes only the one on top.
describe('EmojiPicker stacked with a modal', () => {
  beforeEach(() => {
    mockHasHover.mockReturnValue(true)
    cleanup()
  })

  it('closes help first and keeps the picker open, then closes the picker', () => {
    const closePicker = vi.fn()
    const closeHelp = vi.fn()
    const Page = ({ help }: { help: boolean }) => (
      <>
        <EmojiPicker onSelect={vi.fn()} onClose={closePicker} />
        {help && <EscapeModal onClose={closeHelp} />}
      </>
    )
    const { rerender } = render(<Page help={false} />)
    rerender(<Page help />)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(closeHelp).toHaveBeenCalledTimes(1)
    expect(closePicker).not.toHaveBeenCalled()
    rerender(<Page help={false} />)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(closePicker).toHaveBeenCalledTimes(1)
  })

  // The poll window: the picker opens inside a modal that closes on Escape.
  it('opened inside a modal, closes and keeps the modal open', () => {
    const closePicker = vi.fn()
    const closeModal = vi.fn()
    const Page = ({ picker }: { picker: boolean }) => (
      <EscapeModal onClose={closeModal}>
        {picker && <EmojiPicker onSelect={vi.fn()} onClose={closePicker} />}
      </EscapeModal>
    )
    const { rerender } = render(<Page picker={false} />)
    rerender(<Page picker />)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(closePicker).toHaveBeenCalledTimes(1)
    expect(closeModal).not.toHaveBeenCalled()
  })
})
