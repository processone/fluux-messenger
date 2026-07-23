// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { useRef } from 'react'
import { useFocusTrap } from './useFocusTrap'

afterEach(cleanup)

function Trap({ active = true }: { active?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useFocusTrap(ref, { active })
  return (
    <div ref={ref}>
      <button type="button">first</button>
      <button type="button">middle</button>
      <button type="button">last</button>
    </div>
  )
}

describe('useFocusTrap', () => {
  it('moves focus into the container on mount', () => {
    const { getByText } = render(<Trap />)
    expect(document.activeElement).toBe(getByText('first'))
  })

  it('wraps Tab from the last element to the first', () => {
    const { getByText } = render(<Trap />)
    const last = getByText('last')
    last.focus()
    fireEvent.keyDown(last, { key: 'Tab' })
    expect(document.activeElement).toBe(getByText('first'))
  })

  it('wraps Shift+Tab from the first element to the last', () => {
    const { getByText } = render(<Trap />)
    const first = getByText('first')
    first.focus()
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(getByText('last'))
  })

  it('focuses the container itself when it has no focusable children', () => {
    function Empty() {
      const ref = useRef<HTMLDivElement>(null)
      useFocusTrap(ref)
      return <div ref={ref} data-testid="empty" />
    }
    const { getByTestId } = render(<Empty />)
    expect(document.activeElement).toBe(getByTestId('empty'))
  })

  it('restores focus to the opener on unmount', () => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()
    const { unmount } = render(<Trap />)
    expect(document.activeElement).not.toBe(opener)
    unmount()
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })

  it('does nothing while inactive', () => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()
    render(<Trap active={false} />)
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })

  it('focuses initialFocusRef element instead of the first focusable', () => {
    function TrapWithInitial() {
      const containerRef = useRef<HTMLDivElement>(null)
      const initialRef = useRef<HTMLButtonElement>(null)
      useFocusTrap(containerRef, { initialFocusRef: initialRef })
      return (
        <div ref={containerRef}>
          <button type="button">first</button>
          <button type="button" ref={initialRef}>second</button>
          <button type="button">third</button>
        </div>
      )
    }
    const { getByText } = render(<TrapWithInitial />)
    expect(document.activeElement).toBe(getByText('second'))
  })
})
