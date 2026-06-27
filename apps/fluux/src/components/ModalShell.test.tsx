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
})
