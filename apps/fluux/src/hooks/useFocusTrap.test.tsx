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

it('wraps focus through a shadow picker while excluding an inert message preview', () => {
  function ShadowTrap() {
    const ref = useRef<HTMLDivElement>(null)
    useFocusTrap(ref, { includeShadowRoots: true })
    return <div ref={ref}>
      <button type="button">Back</button>
      <div inert><a href="#">Preview link</a></div>
      <div data-testid="picker" ref={(host) => {
        if (host && !host.shadowRoot) host.attachShadow({ mode: 'open' }).innerHTML = '<input aria-label="Search"><button>Emoji</button>'
      }} />
    </div>
  }
  const { getByText, getByTestId } = render(<ShadowTrap />)
  const host = getByTestId('picker')
  const last = host.shadowRoot!.querySelector('button')!
  last.focus()
  fireEvent.keyDown(last, { key: 'Tab', composed: true })
  expect(getByText('Back')).toHaveFocus()
  fireEvent.keyDown(getByText('Back'), { key: 'Tab' })
  expect(host.shadowRoot!.activeElement).toBe(host.shadowRoot!.querySelector('input'))
  getByText('Back').focus()
  fireEvent.keyDown(getByText('Back'), { key: 'Tab', shiftKey: true })
  expect(host.shadowRoot!.activeElement).toBe(last)
})
