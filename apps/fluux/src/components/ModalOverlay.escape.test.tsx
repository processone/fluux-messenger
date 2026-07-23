// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { ModalOverlay } from './ModalOverlay'

// Skip the exit animation so the transition-aware `close` invokes onClose
// synchronously (useModalTransition otherwise defers it behind MODAL_EXIT_MS).
beforeEach(() => document.documentElement.setAttribute('data-motion', 'reduced'))
afterEach(() => {
  document.documentElement.removeAttribute('data-motion')
  cleanup()
})

describe('ModalOverlay Escape handling', () => {
  it('closes on Escape (default closeOnEscape)', () => {
    const onClose = vi.fn()
    render(
      <ModalOverlay onClose={onClose}>
        <button type="button">ok</button>
      </ModalOverlay>,
    )
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('consumes Escape so it never reaches the window-level shortcut handler', () => {
    // Regression guard (mirrors AvatarLightbox / ImageLightbox): closing a default
    // ModalOverlay modal with Escape must not ALSO fire the app's window-level
    // conversation shortcut (scroll-to-bottom + mark-read), which listens on window.
    // Without stopPropagation the Escape both closes the modal AND snaps a reader
    // who scrolled up into history back to the newest message.
    const onClose = vi.fn()
    const windowKeydown = vi.fn()
    window.addEventListener('keydown', windowKeydown)
    try {
      render(
        <ModalOverlay onClose={onClose}>
          <button type="button">ok</button>
        </ModalOverlay>,
      )
      fireEvent.keyDown(document.body, { key: 'Escape' })
      expect(onClose).toHaveBeenCalledTimes(1)
      expect(windowKeydown).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', windowKeydown)
    }
  })
})
