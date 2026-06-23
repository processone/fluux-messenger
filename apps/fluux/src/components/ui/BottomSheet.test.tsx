import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { BottomSheet } from './BottomSheet'

describe('BottomSheet', () => {
  it('renders nothing when closed', () => {
    render(
      <BottomSheet open={false} onClose={() => {}}>
        hidden
      </BottomSheet>,
    )
    expect(screen.queryByText('hidden')).toBeNull()
  })

  it('renders children in a labelled dialog when open', () => {
    render(
      <BottomSheet open onClose={() => {}} ariaLabel="Actions">
        <button>Do thing</button>
      </BottomSheet>,
    )
    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-label')).toBe('Actions')
    expect(screen.getByText('Do thing')).toBeTruthy()
  })

  it('portals to document.body so it escapes contained/clipped ancestors', () => {
    const { container } = render(
      <BottomSheet open onClose={() => {}}>
        <span>portaled</span>
      </BottomSheet>,
    )
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(document.body.querySelector('[role="dialog"]')).toBeTruthy()
  })

  it('calls onClose on Escape', () => {
    const onClose = vi.fn()
    render(
      <BottomSheet open onClose={onClose}>
        x
      </BottomSheet>,
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('calls onClose when the backdrop is tapped', () => {
    const onClose = vi.fn()
    render(
      <BottomSheet open onClose={onClose}>
        x
      </BottomSheet>,
    )
    const backdrop = document.querySelector('[data-modal="true"] button[aria-hidden="true"]')
    expect(backdrop).toBeTruthy()
    fireEvent.click(backdrop!)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('caps the panel height and makes the content scrollable (no off-screen overflow)', () => {
    render(
      <BottomSheet open onClose={() => {}}>
        x
      </BottomSheet>,
    )
    const dialog = screen.getByRole('dialog')
    expect(dialog.className).toContain('max-h-[90dvh]')
    expect(dialog.querySelector('.overflow-y-auto')).toBeTruthy()
  })
})
