// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { ModalOverlay } from './ModalOverlay'

afterEach(cleanup)

describe('ModalOverlay focus trap', () => {
  it('wraps Tab within the panel', () => {
    const { getByText } = render(
      <ModalOverlay onClose={vi.fn()}>
        <button type="button">alpha</button>
        <button type="button">omega</button>
      </ModalOverlay>,
    )
    const omega = getByText('omega')
    omega.focus()
    fireEvent.keyDown(omega, { key: 'Tab' })
    expect(document.activeElement).toBe(getByText('alpha'))
  })

  it('focuses the first child on open by default', () => {
    const { getByText } = render(
      <ModalOverlay onClose={vi.fn()}>
        <a href="https://example.com">link</a>
      </ModalOverlay>,
    )
    expect(document.activeElement).toBe(getByText('link'))
  })

  it('focuses the panel (not a content control) with initialFocus="panel"', () => {
    const { getByText, container } = render(
      <ModalOverlay onClose={vi.fn()} initialFocus="panel">
        <a href="https://example.com">link</a>
      </ModalOverlay>,
    )
    const panel = container.querySelector('.fluux-glass')
    expect(document.activeElement).toBe(panel)
    expect(document.activeElement).not.toBe(getByText('link'))
  })

  it('opts the panel out of the global focus ring', () => {
    // The panel is a tabindex=-1 focus target, not a control: focusing it (on
    // open, or via useRestoreFocus after a window refocus) must not draw the
    // app-wide `.user-interacted *:focus` outline around the whole dialog.
    const { getByText, container } = render(
      <ModalOverlay onClose={vi.fn()} initialFocus="panel">
        <button type="button">alpha</button>
      </ModalOverlay>,
    )
    expect(container.querySelector('.fluux-glass')?.className).toContain('no-focus-ring')
    // Content controls keep theirs: the selector excludes only the class holder.
    expect(getByText('alpha').className).not.toContain('no-focus-ring')
  })
})
