// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { renderHook, cleanup } from '@testing-library/react'

vi.mock('@/themes/softwareRendering', () => ({
  detectSoftwareRendering: vi.fn(() => true),
}))

import { useTheme } from './useTheme'
import { detectSoftwareRendering } from '@/themes/softwareRendering'
import { useSettingsStore } from '@/stores/settingsStore'

afterEach(cleanup)

beforeEach(() => {
  useSettingsStore.getState().setTransparencyMode('system')
  vi.mocked(detectSoftwareRendering).mockReturnValue(true)
})

describe('useTheme transparency wiring', () => {
  it('flattens glass when the probe reports software rendering', () => {
    renderHook(() => useTheme())
    expect(document.documentElement.getAttribute('data-transparency')).toBe('reduced')
  })

  it('leaves glass on when the probe reports a real GPU', () => {
    vi.mocked(detectSoftwareRendering).mockReturnValue(false)
    renderHook(() => useTheme())
    expect(document.documentElement.getAttribute('data-transparency')).toBe('full')
  })

  it('honours an explicit full preference over the probe', () => {
    useSettingsStore.getState().setTransparencyMode('full')
    renderHook(() => useTheme())
    expect(document.documentElement.getAttribute('data-transparency')).toBe('full')
  })
})
