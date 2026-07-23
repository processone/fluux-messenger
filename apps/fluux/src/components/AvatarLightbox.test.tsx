import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { AvatarLightbox } from './AvatarLightbox'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }))
vi.mock('./Avatar', () => ({ Avatar: () => null }))

describe('AvatarLightbox Escape handling', () => {
  it('closes on Escape', () => {
    const onClose = vi.fn()
    render(<AvatarLightbox identifier="user@x" onClose={onClose} />)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('consumes Escape so it never reaches the window-level shortcut handler', () => {
    // Same regression guard as ImageLightbox: closing the avatar view with Escape
    // must not also fire the window-level conversation shortcut (scroll-to-bottom).
    const onClose = vi.fn()
    const windowKeydown = vi.fn()
    window.addEventListener('keydown', windowKeydown)
    try {
      render(<AvatarLightbox identifier="user@x" onClose={onClose} />)
      fireEvent.keyDown(document.body, { key: 'Escape' })
      expect(onClose).toHaveBeenCalledTimes(1)
      expect(windowKeydown).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', windowKeydown)
    }
  })
})
