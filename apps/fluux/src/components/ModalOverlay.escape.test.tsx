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

  // Issue #1126: the room-password prompt opens OVER Browse Rooms, and the
  // real-JID warning opens over the join modals. Each overlay listens on
  // document, and stopPropagation does not stop a sibling listener on the same
  // node — so one Escape used to collapse the whole stack.
  describe('stacked modals', () => {
    it('dismisses only the topmost modal', () => {
      const closeOuter = vi.fn()
      const closeInner = vi.fn()
      render(
        <>
          <ModalOverlay onClose={closeOuter}>
            <button type="button">outer</button>
          </ModalOverlay>
          <ModalOverlay onClose={closeInner}>
            <button type="button">inner</button>
          </ModalOverlay>
        </>,
      )

      fireEvent.keyDown(document.body, { key: 'Escape' })

      expect(closeInner).toHaveBeenCalledTimes(1)
      expect(closeOuter).not.toHaveBeenCalled()
    })

    it('dismisses the remaining modal once the top one is gone', () => {
      const closeOuter = vi.fn()
      const { rerender } = render(
        <>
          <ModalOverlay onClose={closeOuter}>
            <button type="button">outer</button>
          </ModalOverlay>
          <ModalOverlay onClose={vi.fn()}>
            <button type="button">inner</button>
          </ModalOverlay>
        </>,
      )

      rerender(
        <>
          <ModalOverlay onClose={closeOuter}>
            <button type="button">outer</button>
          </ModalOverlay>
        </>,
      )
      fireEvent.keyDown(document.body, { key: 'Escape' })

      expect(closeOuter).toHaveBeenCalledTimes(1)
    })
  })
})
