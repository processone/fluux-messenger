import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useSettingsStore } from '@/stores/settingsStore'

const mockSetKeepInSystemTray = vi.fn().mockResolvedValue({ enabled: true, available: true })
let mockSupported = true

vi.mock('@/utils/windowBehavior', () => ({
  supportsTrayPreference: () => mockSupported,
  setKeepInSystemTray: (enabled: boolean) => mockSetKeepInSystemTray(enabled),
}))

import { useWindowBehaviorSync } from './useWindowBehaviorSync'

describe('useWindowBehaviorSync', () => {
  beforeEach(() => {
    mockSupported = true
    mockSetKeepInSystemTray.mockClear()
    useSettingsStore.setState({ keepInSystemTray: true })
  })

  it('pushes the initial value and later changes', async () => {
    renderHook(() => useWindowBehaviorSync())
    await waitFor(() => expect(mockSetKeepInSystemTray).toHaveBeenCalledWith(true))

    useSettingsStore.getState().setKeepInSystemTray(false)
    await waitFor(() => expect(mockSetKeepInSystemTray).toHaveBeenCalledWith(false))
  })

  it('does nothing on unsupported platforms', () => {
    mockSupported = false
    renderHook(() => useWindowBehaviorSync())
    expect(mockSetKeepInSystemTray).not.toHaveBeenCalled()
  })
})
