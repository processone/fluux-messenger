import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { useCloseOnEscape } from './useCloseOnEscape'

function Harness({ onClose }: { onClose: () => void }) {
  useCloseOnEscape(onClose)
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
