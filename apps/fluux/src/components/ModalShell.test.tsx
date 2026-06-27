import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
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
    const scrim = container.querySelector('[data-modal="true"]')
    expect(scrim?.classList.contains('modal-scrim')).toBe(true)
    expect(scrim?.classList.contains('bg-black/50')).toBe(false)
  })

  it('restores focus to its input when the window regains focus', () => {
    const { container } = render(
      <>
        <button data-testid="outside">outside</button>
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
