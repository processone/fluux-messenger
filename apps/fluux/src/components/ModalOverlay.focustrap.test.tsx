// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { ModalOverlay } from './ModalOverlay'

afterEach(cleanup)

describe('ModalOverlay focus trap', () => {
  it('wraps Tab within the panel', () => {
    const { getByText } = render(
      <ModalOverlay onClose={vi.fn()}>
        <button>alpha</button>
        <button>omega</button>
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
})
