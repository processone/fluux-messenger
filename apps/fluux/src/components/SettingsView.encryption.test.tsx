/**
 * Settings > Encryption sub-pages in the settings header (FLM-294 direction C): a back control at every
 * width on a method's screen, the screen's name as the title, and the overview for an unknown sub-page.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SettingsView } from './SettingsView'

let mockSubPage: string | null = null
const navigateToSettings = vi.fn()

vi.mock('@/hooks/useRouteSync', () => ({
  useRouteSync: () => ({ settingsCategory: 'encryption', settingsSubPage: mockSubPage, navigateToSettings }),
}))
vi.mock('@/hooks', () => ({ useWindowDrag: () => ({ dragRegionProps: {} }) }))
vi.mock('@/utils/renderLoopDetector', () => ({ detectRenderLoop: () => {} }))
vi.mock('./settings-components/EncryptionSettings', () => ({
  EncryptionSettings: ({ subPage }: { subPage: string | null }) => <div>{`encryption:${subPage}`}</div>,
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}))

beforeEach(() => {
  navigateToSettings.mockClear()
  mockSubPage = null
})

describe('SettingsView Encryption sub-pages', () => {
  it('shows the overview without a back control when no sub-page is named', () => {
    render(<SettingsView />)
    expect(screen.getByText('encryption:null')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'common.back' })).toBeNull()
  })

  it('shows the overview for an unknown sub-page', () => {
    mockSubPage = 'nope'
    render(<SettingsView />)
    expect(screen.getByText('encryption:null')).toBeTruthy()
  })

  it('titles a method screen and goes back to the overview', () => {
    mockSubPage = 'omemo'
    render(<SettingsView />)
    expect(screen.getByText('encryption:omemo')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'settings.encryption.omemoName' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'common.back' }))
    expect(navigateToSettings).toHaveBeenCalledWith('encryption', { replace: true })
  })
})
