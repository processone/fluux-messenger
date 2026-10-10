import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { useSettingsStore } from '@/stores/settingsStore'
import { NotificationSoundSetting } from './NotificationSoundSetting'
import { useIOSSoundSettingsStore } from './notificationSounds'
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
beforeEach(() => { localStorage.clear(); useIOSSoundSettingsStore.getState().setAccount('me@example.com'); useSettingsStore.setState({ soundEnabled: true }) })
afterEach(() => useIOSSoundSettingsStore.getState().setAccount(null))
it('offers all bundled tones and silence without changing foreground audio', () => {
 render(<NotificationSoundSetting />)
 const select = screen.getByRole('combobox', { name: 'settings.nativeNotificationTone' })
 expect(screen.getAllByRole('option')).toHaveLength(5)
 fireEvent.change(select, { target: { value: 'silent' } })
 expect(select).toHaveValue('silent')
 expect(useSettingsStore.getState().soundEnabled).toBe(true)
 expect(localStorage.getItem('fluux-ios-notification-tone:me@example.com')).toBe('silent')
})
it('disables choices when no account owns the preference', () => {
 useIOSSoundSettingsStore.getState().setAccount(null)
 render(<NotificationSoundSetting />)
 expect(screen.getByRole('combobox')).toBeDisabled()
})
