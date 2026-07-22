import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { ModalShell } from './ModalShell'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('./Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

describe('ModalShell glass surface', () => {
  it('renders the panel as a glass surface', () => {
    const { container } = render(
      <ModalShell title="X" onClose={() => {}}><div /></ModalShell>
    )
    expect(container.querySelector('.fluux-glass')).not.toBeNull()
    expect(container.querySelector('.bg-black\\/50')).toBeNull()
  })

  it('renders the scrim with modal-scrim class, not bg-black/50', () => {
    const { container } = render(
      <ModalShell title="X" onClose={() => {}}><div /></ModalShell>
    )
    // The scrim is its own sibling layer (not the `[data-modal="true"]` layout
    // wrapper) so its backdrop-filter doesn't form a Backdrop Root over the panel.
    const scrim = container.querySelector('.modal-scrim')
    expect(scrim).not.toBeNull()
    expect(scrim?.classList.contains('bg-black/50')).toBe(false)
  })

  it('restores focus to its input when the window regains focus', () => {
    const { container } = render(
      <>
        <button type="button" data-testid="outside">outside</button>
        <ModalShell title="X" onClose={() => {}}>
          <input data-testid="field" autoFocus />
        </ModalShell>
      </>
    )
    const field = container.querySelector('[data-testid="field"]') as HTMLInputElement
    const outside = container.querySelector('[data-testid="outside"]') as HTMLButtonElement

    // The input is focused on open; the user types, then the OS window blurs and
    // focus collapses to an element outside the modal.
    field.focus()
    outside.focus()
    expect(document.activeElement).toBe(outside)

    window.dispatchEvent(new Event('focus'))

    expect(document.activeElement).toBe(field)
  })
})

function setMotion(value: 'full' | 'reduced') {
  document.documentElement.setAttribute('data-motion', value)
}

describe('ModalShell motion', () => {
  beforeEach(() => { vi.useFakeTimers(); setMotion('full') })
  afterEach(() => { vi.useRealTimers(); document.documentElement.removeAttribute('data-motion') })

  it('renders the enter classes on mount', () => {
    const { container } = render(<ModalShell title="T" onClose={() => {}}>body</ModalShell>)
    expect(container.querySelector('.scrim-in')).toBeTruthy()
    expect(container.querySelector('.modal-panel-in')).toBeTruthy()
  })

  it('plays the exit then calls onClose after the delay (motion full)', () => {
    const onClose = vi.fn()
    const { container } = render(<ModalShell title="T" onClose={onClose}>body</ModalShell>)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    expect(container.querySelector('.modal-panel-out')).toBeTruthy()
    vi.advanceTimersByTime(150)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes immediately when motion is reduced', () => {
    setMotion('reduced')
    const onClose = vi.fn()
    render(<ModalShell title="T" onClose={onClose}>body</ModalShell>)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
