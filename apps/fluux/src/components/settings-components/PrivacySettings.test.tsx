import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { PrivacySettings } from './PrivacySettings'
import { useSettingsStore } from '@/stores/settingsStore'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

beforeEach(() => {
  useSettingsStore.setState({ archiveConversations: true })
})

describe('PrivacySettings', () => {
  it('shows server archiving as on by default and turns it off', () => {
    render(<PrivacySettings />)
    const toggle = screen.getByRole('switch', { name: 'settings.archiveConversations' })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText('settings.archiveConversationsDescription')).toBeInTheDocument()

    fireEvent.click(toggle)

    expect(useSettingsStore.getState().archiveConversations).toBe(false)
    expect(toggle).toHaveAttribute('aria-checked', 'false')
  })

  it('turns server archiving back on', () => {
    useSettingsStore.setState({ archiveConversations: false })
    render(<PrivacySettings />)

    fireEvent.click(screen.getByRole('switch', { name: 'settings.archiveConversations' }))

    expect(useSettingsStore.getState().archiveConversations).toBe(true)
  })
})
