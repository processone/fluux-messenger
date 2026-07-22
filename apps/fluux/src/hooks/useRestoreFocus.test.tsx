import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { useRef } from 'react'
import { useRestoreFocus } from './useRestoreFocus'

/**
 * Test harness: an "outside" control (the app behind the modal) plus a
 * modal container holding an input and a button. The hook should keep
 * keyboard focus inside the container across window blur/refocus.
 */
function Harness() {
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  useRestoreFocus(containerRef, inputRef)
  return (
    <div>
      <button type="button" data-testid="outside">outside</button>
      <div ref={containerRef} data-testid="modal">
        <input ref={inputRef} data-testid="field" />
        <button type="button" data-testid="inside-btn">inside</button>
      </div>
    </div>
  )
}

afterEach(cleanup)

describe('useRestoreFocus', () => {
  it('restores focus to the initial element when the window regains focus after focus escaped the modal', () => {
    const { getByTestId } = render(<Harness />)
    const outside = getByTestId('outside') as HTMLButtonElement
    const field = getByTestId('field') as HTMLInputElement

    // Simulate the OS window blur resetting focus outside the modal.
    outside.focus()
    expect(document.activeElement).toBe(outside)

    // Window regains focus.
    window.dispatchEvent(new Event('focus'))

    expect(document.activeElement).toBe(field)
  })

  it('does not steal focus when focus is still inside the modal', () => {
    const { getByTestId } = render(<Harness />)
    const insideBtn = getByTestId('inside-btn') as HTMLButtonElement

    insideBtn.focus()
    expect(document.activeElement).toBe(insideBtn)

    window.dispatchEvent(new Event('focus'))

    // Focus was already inside the modal, so it must be left untouched.
    expect(document.activeElement).toBe(insideBtn)
  })

  it('restores focus to the element last focused inside the modal, not just the initial one', () => {
    const { getByTestId } = render(<Harness />)
    const outside = getByTestId('outside') as HTMLButtonElement
    const insideBtn = getByTestId('inside-btn') as HTMLButtonElement

    // User moves to a different control inside the modal, then leaves the window.
    insideBtn.focus()
    outside.focus()

    window.dispatchEvent(new Event('focus'))

    expect(document.activeElement).toBe(insideBtn)
  })

  it('restores focus when the document becomes visible again', () => {
    const { getByTestId } = render(<Harness />)
    const outside = getByTestId('outside') as HTMLButtonElement
    const field = getByTestId('field') as HTMLInputElement

    outside.focus()
    document.dispatchEvent(new Event('visibilitychange'))

    expect(document.activeElement).toBe(field)
  })

  it('stops restoring focus after unmount', () => {
    const { getByTestId, unmount } = render(<Harness />)
    const outside = getByTestId('outside') as HTMLButtonElement
    const field = getByTestId('field') as HTMLInputElement

    unmount()
    // The detached field must not be re-focused by a lingering listener.
    outside.focus()
    window.dispatchEvent(new Event('focus'))

    expect(document.activeElement).not.toBe(field)
  })
})
