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
})
