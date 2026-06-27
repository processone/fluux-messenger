import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SettingsSidebar } from './SettingsSidebar'
import { useAdvancedModeStore } from '@/stores/advancedModeStore'

// t() returns the key, so headers render as their i18n key paths.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

beforeEach(() => {
  useAdvancedModeStore.setState({ advancedMode: false })
})

describe('SettingsSidebar', () => {
  it('renders a heading for general, privacy, and system groups', () => {
    render(<SettingsSidebar activeCategory="profile" onCategoryChange={vi.fn()} />)
    expect(screen.getByRole('heading', { name: 'settings.groups.general' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'settings.groups.privacy' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'settings.groups.system' })).toBeInTheDocument()
  })

  it('renders Profile bare with no account heading', () => {
    render(<SettingsSidebar activeCategory="profile" onCategoryChange={vi.fn()} />)
    expect(screen.getByRole('button', { name: /settings\.categories\.profile/ })).toBeInTheDocument()
    expect(screen.queryByText('settings.groups.account')).not.toBeInTheDocument()
    // Profile button precedes the first group heading in document order.
    const profile = screen.getByRole('button', { name: /settings\.categories\.profile/ })
    const firstHeading = screen.getByRole('heading', { name: 'settings.groups.general' })
    expect(profile.compareDocumentPosition(firstHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
