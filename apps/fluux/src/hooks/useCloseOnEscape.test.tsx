import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { useCloseOnEscape } from './useCloseOnEscape'

function Harness({ onClose, enabled }: { onClose: () => void; enabled?: boolean }) {
  useCloseOnEscape(onClose, enabled)
  return null
}

describe('useCloseOnEscape', () => {
  it('calls onClose on Escape and stops the event reaching window', () => {
    const onClose = vi.fn()
    const windowKeydown = vi.fn()
    window.addEventListener('keydown', windowKeydown)
    try {
      render(<Harness onClose={onClose} />)
      fireEvent.keyDown(document.body, { key: 'Escape' })
      expect(onClose).toHaveBeenCalledTimes(1)
      expect(windowKeydown).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', windowKeydown)
    }
  })

  it('ignores non-Escape keys and lets them bubble to window', () => {
    const onClose = vi.fn()
    const windowKeydown = vi.fn()
    window.addEventListener('keydown', windowKeydown)
    try {
      render(<Harness onClose={onClose} />)
      fireEvent.keyDown(document.body, { key: 'Enter' })
      expect(onClose).not.toHaveBeenCalled()
      expect(windowKeydown).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener('keydown', windowKeydown)
    }
  })

  it('does not attach while disabled (Escape flows through to window, onClose not called)', () => {
    // Always-mounted overlays (dropdown/sheet menus) pass their open state as
    // `enabled`. While closed the hook must NOT consume Escape, so the window
    // handler still runs for anything else that cares about Escape.
    const onClose = vi.fn()
    const windowKeydown = vi.fn()
    window.addEventListener('keydown', windowKeydown)
    try {
      render(<Harness onClose={onClose} enabled={false} />)
      fireEvent.keyDown(document.body, { key: 'Escape' })
      expect(onClose).not.toHaveBeenCalled()
      expect(windowKeydown).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener('keydown', windowKeydown)
    }
  })

  it('consumes Escape when explicitly enabled', () => {
    const onClose = vi.fn()
    const windowKeydown = vi.fn()
    window.addEventListener('keydown', windowKeydown)
    try {
      render(<Harness onClose={onClose} enabled />)
      fireEvent.keyDown(document.body, { key: 'Escape' })
      expect(onClose).toHaveBeenCalledTimes(1)
      expect(windowKeydown).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', windowKeydown)
    }
  })

  it('detaches its listener on unmount (Escape no longer consumed)', () => {
    const onClose = vi.fn()
    const windowKeydown = vi.fn()
    window.addEventListener('keydown', windowKeydown)
    try {
      const { unmount } = render(<Harness onClose={onClose} />)
      unmount()
      fireEvent.keyDown(document.body, { key: 'Escape' })
      expect(onClose).not.toHaveBeenCalled()
      // With the overlay gone, Escape must flow through to the window handler again.
      expect(windowKeydown).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener('keydown', windowKeydown)
    }
  })
})
