import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ChangelogModal } from './ChangelogModal'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@/data/changelog', () => ({
  changelog: ['5.0.0', '4.0.0', '3.0.0', '2.0.0', '1.0.0'].map((version) => ({
    version,
    date: '2026-01-01',
    sections: [{ type: 'added', items: [`change in ${version}`] }],
  })),
}))

describe('ChangelogModal', () => {
  it('shows only the three newest releases', () => {
    render(<ChangelogModal onClose={vi.fn()} />)

    expect(screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)).toEqual([
      'v5.0.0',
      'v4.0.0',
      'v3.0.0',
    ])
    expect(screen.queryByText('change in 2.0.0')).not.toBeInTheDocument()
    expect(screen.queryByText('change in 1.0.0')).not.toBeInTheDocument()
  })

  it('links to the full changelog in a new window', () => {
    render(<ChangelogModal onClose={vi.fn()} />)

    const link = screen.getByRole('link', { name: 'changelog.viewFull' })
    expect(link).toHaveAttribute('href', 'https://github.com/processone/fluux-messenger/blob/main/CHANGELOG.md')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('does not start with focus on the changelog link', async () => {
    render(<ChangelogModal onClose={vi.fn()} />)
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))

    expect(document.activeElement).not.toBe(screen.getByRole('link', { name: 'changelog.viewFull' }))
  })
})
