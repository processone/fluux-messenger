import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useTypeToFocus } from './useTypeToFocus'
import { installFocusRings } from '@/utils/focusRings'

// Sources: the documented type-to-focus contract and native keyboard list access.
// This file owns focus routing; the built reader-list journey owns activation.

describe('useTypeToFocus', () => {
  const mockFocus = vi.fn()

  // Generic focusable ref - works with any element that has focus()
  const createMockRef = () => ({
    current: {
      focus: mockFocus,
    },
  })

  let stopFocusRings: () => void
  let originalModality: string | undefined
  let originallyInteracted: boolean
  const fixtures: HTMLElement[] = []

  beforeEach(() => {
    vi.clearAllMocks()
    originalModality = document.documentElement.dataset.focusModality
    originallyInteracted = document.documentElement.classList.contains('user-interacted')
    stopFocusRings = installFocusRings()
  })

  afterEach(() => {
    stopFocusRings()
    if (originalModality === undefined) delete document.documentElement.dataset.focusModality
    else document.documentElement.dataset.focusModality = originalModality
    document.documentElement.classList.toggle('user-interacted', originallyInteracted)
    for (const fixture of fixtures.splice(0)) fixture.remove()
    vi.restoreAllMocks()
  })

  it('should focus composer when printable key is pressed', () => {
    const ref = createMockRef()
    renderHook(() => useTypeToFocus(ref))

    // Simulate pressing 'a' key
    const event = new KeyboardEvent('keydown', {
      key: 'a',
      bubbles: true,
    })
    document.body.dispatchEvent(event)

    expect(mockFocus).toHaveBeenCalledTimes(1)
  })

  it('should not focus when Ctrl modifier is pressed', () => {
    const ref = createMockRef()
    renderHook(() => useTypeToFocus(ref))

    // Simulate Ctrl+C
    const event = new KeyboardEvent('keydown', {
      key: 'c',
      ctrlKey: true,
      bubbles: true,
    })
    document.body.dispatchEvent(event)

    expect(mockFocus).not.toHaveBeenCalled()
  })

  it('should not focus when Meta (Cmd) modifier is pressed', () => {
    const ref = createMockRef()
    renderHook(() => useTypeToFocus(ref))

    // Simulate Cmd+V
    const event = new KeyboardEvent('keydown', {
      key: 'v',
      metaKey: true,
      bubbles: true,
    })
    document.body.dispatchEvent(event)

    expect(mockFocus).not.toHaveBeenCalled()
  })

  it('should not focus when Alt modifier is pressed', () => {
    const ref = createMockRef()
    renderHook(() => useTypeToFocus(ref))

    // Simulate Alt+1
    const event = new KeyboardEvent('keydown', {
      key: '1',
      altKey: true,
      bubbles: true,
    })
    document.body.dispatchEvent(event)

    expect(mockFocus).not.toHaveBeenCalled()
  })

  it('should not focus when target is an input element', () => {
    const ref = createMockRef()
    renderHook(() => useTypeToFocus(ref))

    // Create an input element
    const input = document.createElement('input')
    document.body.appendChild(input)

    // Simulate pressing 'a' in an input
    const event = new KeyboardEvent('keydown', {
      key: 'a',
      bubbles: true,
    })
    input.dispatchEvent(event)

    expect(mockFocus).not.toHaveBeenCalled()

    document.body.removeChild(input)
  })

  it('should not focus when target is a textarea element', () => {
    const ref = createMockRef()
    renderHook(() => useTypeToFocus(ref))

    // Create a textarea element
    const textarea = document.createElement('textarea')
    document.body.appendChild(textarea)

    const event = new KeyboardEvent('keydown', {
      key: 'x',
      bubbles: true,
    })
    textarea.dispatchEvent(event)

    expect(mockFocus).not.toHaveBeenCalled()

    document.body.removeChild(textarea)
  })

  it('should not focus on function keys', () => {
    const ref = createMockRef()
    renderHook(() => useTypeToFocus(ref))

    // Simulate F1 key
    const event = new KeyboardEvent('keydown', {
      key: 'F1',
      bubbles: true,
    })
    document.body.dispatchEvent(event)

    expect(mockFocus).not.toHaveBeenCalled()
  })

  it('should not focus on non-printable keys like Escape', () => {
    const ref = createMockRef()
    renderHook(() => useTypeToFocus(ref))

    const event = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
    })
    document.body.dispatchEvent(event)

    expect(mockFocus).not.toHaveBeenCalled()
  })

  it('should not focus on arrow keys', () => {
    const ref = createMockRef()
    renderHook(() => useTypeToFocus(ref))

    const event = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      bubbles: true,
    })
    document.body.dispatchEvent(event)

    expect(mockFocus).not.toHaveBeenCalled()
  })

  it('should focus on Backspace key', () => {
    const ref = createMockRef()
    renderHook(() => useTypeToFocus(ref))

    const event = new KeyboardEvent('keydown', {
      key: 'Backspace',
      bubbles: true,
    })
    document.body.dispatchEvent(event)

    expect(mockFocus).toHaveBeenCalledTimes(1)
  })

  it('should focus on Delete key', () => {
    const ref = createMockRef()
    renderHook(() => useTypeToFocus(ref))

    const event = new KeyboardEvent('keydown', {
      key: 'Delete',
      bubbles: true,
    })
    document.body.dispatchEvent(event)

    expect(mockFocus).toHaveBeenCalledTimes(1)
  })

  it('should not focus when hook is disabled', () => {
    const ref = createMockRef()
    renderHook(() => useTypeToFocus(ref, false))

    const event = new KeyboardEvent('keydown', {
      key: 'a',
      bubbles: true,
    })
    document.body.dispatchEvent(event)

    expect(mockFocus).not.toHaveBeenCalled()
  })

  it('should not throw when ref.current is null', () => {
    const ref = { current: null }
    renderHook(() => useTypeToFocus(ref))

    const event = new KeyboardEvent('keydown', {
      key: 'a',
      bubbles: true,
    })

    // Should not throw
    expect(() => document.body.dispatchEvent(event)).not.toThrow()
  })

  it('should focus with Shift modifier for capital letters', () => {
    const ref = createMockRef()
    renderHook(() => useTypeToFocus(ref))

    // Simulate Shift+A for capital letter
    const event = new KeyboardEvent('keydown', {
      key: 'A',
      shiftKey: true,
      bubbles: true,
    })
    document.body.dispatchEvent(event)

    expect(mockFocus).toHaveBeenCalledTimes(1)
  })

  it('should focus on number keys', () => {
    const ref = createMockRef()
    renderHook(() => useTypeToFocus(ref))

    const event = new KeyboardEvent('keydown', {
      key: '5',
      bubbles: true,
    })
    document.body.dispatchEvent(event)

    expect(mockFocus).toHaveBeenCalledTimes(1)
  })

  it('should focus on special characters', () => {
    const ref = createMockRef()
    renderHook(() => useTypeToFocus(ref))

    const event = new KeyboardEvent('keydown', {
      key: '@',
      shiftKey: true,
      bubbles: true,
    })
    document.body.dispatchEvent(event)

    expect(mockFocus).toHaveBeenCalledTimes(1)
  })

  const createControlFixture = (kind: 'button' | 'select' | 'option' = 'button') => {
    const fixture = document.createElement('section')
    const composer = document.createElement('input')
    composer.setAttribute('aria-label', 'Message')
    const control = document.createElement(kind === 'option' ? 'div' : kind)
    control.tabIndex = 0
    if (kind === 'button') control.setAttribute('type', 'button')
    if (kind === 'option') {
      control.setAttribute('role', 'option')
      control.setAttribute('aria-selected', 'false')
    }
    if (kind === 'select') {
      const option = document.createElement('option')
      option.textContent = 'Show readers'
      control.appendChild(option)
    } else control.textContent = 'Show readers'
    if (kind === 'option') {
      const listbox = document.createElement('div')
      listbox.setAttribute('role', 'listbox')
      listbox.appendChild(control)
      fixture.append(listbox, composer)
    } else fixture.append(control, composer)
    document.body.appendChild(fixture)
    fixtures.push(fixture)
    renderHook(() => useTypeToFocus({ current: composer }))
    return { control, composer }
  }

  it.each(['button', 'select', 'option'] as const)('leaves Space on a keyboard-focused %s', kind => {
    const { control } = createControlFixture(kind)
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    control.focus()
    const space = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })
    control.dispatchEvent(space)
    expect(document.activeElement).toBe(control)
    expect(space.defaultPrevented).toBe(false)
  })

  it('starts typing with Space after a pointer focuses a control', () => {
    const { control, composer } = createControlFixture()
    control.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    control.focus()
    control.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
    expect(document.activeElement).toBe(composer)
  })

  it('starts typing after a pointer presses an already keyboard-focused control', () => {
    const { control, composer } = createControlFixture()
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    control.focus()
    control.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    control.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
    expect(document.activeElement).toBe(composer)
  })

  it('still starts ordinary typing from a keyboard-focused control', () => {
    const { control, composer } = createControlFixture()
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    control.focus()
    control.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }))
    expect(document.activeElement).toBe(composer)
  })

  it('should work with native HTMLInputElement refs', () => {
    // Create a real input element to test with native DOM refs
    const input = document.createElement('input')
    const focusSpy = vi.spyOn(input, 'focus')
    document.body.appendChild(input)

    const ref = { current: input }
    renderHook(() => useTypeToFocus(ref))

    const event = new KeyboardEvent('keydown', {
      key: 'h',
      bubbles: true,
    })
    document.body.dispatchEvent(event)

    expect(focusSpy).toHaveBeenCalledTimes(1)

    document.body.removeChild(input)
    focusSpy.mockRestore()
  })
})
