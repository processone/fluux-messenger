// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { useRef } from 'react'
import { useFocusTrap } from './useFocusTrap'
import { getTabStops } from './composedFocus'

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

it('wraps Tab in a shadow-aware trap when a widget inside stops the key from bubbling', () => {
  function Menu() {
    const ref = useRef<HTMLDivElement>(null)
    useFocusTrap(ref, { includeShadowRoots: true })
    return <div ref={ref}><button type="button">first</button><button type="button">last</button></div>
  }
  const { getByText } = render(<Menu />)
  const last = getByText('last')
  last.focus()
  last.addEventListener('keydown', (e) => e.stopPropagation())
  fireEvent.keyDown(last, { key: 'Tab' })
  expect(getByText('first')).toHaveFocus()
})

describe('owning the Tab order, because WebKit can natively skip buttons and leave the trap', () => {
  function Form({ children }: { children: React.ReactNode }) {
    const ref = useRef<HTMLDivElement>(null)
    useFocusTrap(ref)
    return <div ref={ref} data-testid="panel">{children}</div>
  }

  it('moves Tab from the last text field to the button after it', () => {
    const { getByLabelText, getByText } = render(<Form>
      <input aria-label="search" />
      <input aria-label="reason" />
      <button type="button">Cancel</button>
      <button type="button">Send</button>
    </Form>)
    const reason = getByLabelText('reason')
    reason.focus()
    // fireEvent returns false when the browser's own Tab move was cancelled.
    expect(fireEvent.keyDown(reason, { key: 'Tab' })).toBe(false)
    expect(getByText('Cancel')).toHaveFocus()
  })

  it('moves Shift+Tab from a button to the text field before it', () => {
    const { getByLabelText, getByText } = render(<Form>
      <input aria-label="reason" />
      <button type="button">Cancel</button>
      <button type="button">Send</button>
    </Form>)
    const cancel = getByText('Cancel')
    cancel.focus()
    expect(fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true })).toBe(false)
    expect(getByLabelText('reason')).toHaveFocus()
  })

  it('keeps Shift+Tab inside when focus is on the panel itself', () => {
    const { getByTestId, getByText } = render(<Form>
      <button type="button">first</button>
      <button type="button">last</button>
    </Form>)
    const panel = getByTestId('panel')
    panel.focus()
    fireEvent.keyDown(panel, { key: 'Tab', shiftKey: true })
    expect(getByText('last')).toHaveFocus()
  })

  it('continues from a focused control that is outside the Tab order', () => {
    const { getByText } = render(<Form>
      <button type="button">before</button>
      <button type="button" tabIndex={-1}>row</button>
      <button type="button">after</button>
    </Form>)
    const row = getByText('row')
    row.focus()
    fireEvent.keyDown(row, { key: 'Tab' })
    expect(getByText('after')).toHaveFocus()
    row.focus()
    fireEvent.keyDown(row, { key: 'Tab', shiftKey: true })
    expect(getByText('before')).toHaveFocus()
  })

  it('passes over a hidden control instead of getting stuck on it', () => {
    const { getByLabelText, getByText } = render(<Form>
      <input aria-label="name" />
      <input aria-label="avatar file" type="file" style={{ display: 'none' }} />
      <button type="button">Save</button>
    </Form>)
    const name = getByLabelText('name')
    name.focus()
    fireEvent.keyDown(name, { key: 'Tab' })
    expect(getByText('Save')).toHaveFocus()
  })

  it('counts a radio group as one stop, on its checked radio', () => {
    const { getByLabelText, getByText } = render(<Form>
      <button type="button">Back</button>
      <input aria-label="key one" type="radio" name="key" defaultChecked={false} />
      <input aria-label="key two" type="radio" name="key" defaultChecked />
      <button type="button">Install</button>
    </Form>)
    const back = getByText('Back')
    back.focus()
    fireEvent.keyDown(back, { key: 'Tab' })
    const checked = getByLabelText('key two')
    expect(checked).toHaveFocus()
    fireEvent.keyDown(checked, { key: 'Tab' })
    expect(getByText('Install')).toHaveFocus()
  })

  it('keeps a scrollable region between two controls as a stop, and none outside them', () => {
    const { getByTestId, getByText } = render(<Form>
      <div data-testid="before" style={{ overflowY: 'auto' }}>intro</div>
      <button type="button">first</button>
      <div data-testid="between" style={{ overflowY: 'auto' }}>release notes</div>
      <button type="button">last</button>
      <div data-testid="after" style={{ overflowY: 'auto' }}>footnote</div>
    </Form>)
    // jsdom has no layout, so each region reports content taller than its box.
    for (const id of ['before', 'between', 'after']) {
      Object.defineProperty(getByTestId(id), 'scrollHeight', { value: 400 })
    }
    expect(getTabStops(getByTestId('panel'), null)).toEqual([
      getByText('first'), getByTestId('between'), getByText('last'),
    ])
    // A region that refuses focus, as every one does in WebKit, is passed over.
    const first = getByText('first')
    first.focus()
    fireEvent.keyDown(first, { key: 'Tab' })
    expect(getByText('last')).toHaveFocus()
  })

  it('leaves a Tab that belongs to an IME composition to the input method', () => {
    const { getByLabelText } = render(<Form>
      <input aria-label="name" />
      <button type="button">Save</button>
    </Form>)
    const name = getByLabelText('name')
    name.focus()
    expect(fireEvent.keyDown(name, { key: 'Tab', isComposing: true })).toBe(true)
    expect(name).toHaveFocus()
  })
})

it('lets an inner trap wrap before its outer trap sees Tab', () => {
  function Nested() {
    const outer = useRef<HTMLDivElement>(null)
    const inner = useRef<HTMLDivElement>(null)
    useFocusTrap(outer)
    useFocusTrap(inner)
    return <div ref={outer}>
      <button type="button">download</button>
      <div ref={inner}><button type="button">copy</button><button type="button">save</button></div>
    </div>
  }
  const { getByText } = render(<Nested />)
  const save = getByText('save')
  save.focus()
  fireEvent.keyDown(save, { key: 'Tab' })
  expect(getByText('copy')).toHaveFocus()
})
