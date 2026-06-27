import { describe, it, expect } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useDensity } from './useDensity'
import { useSettingsStore } from '@/stores/settingsStore'

describe('useDensity', () => {
  it('sets data-density on documentElement to the current mode', () => {
    useSettingsStore.getState().setDensityMode('compact')
    renderHook(() => useDensity())
    expect(document.documentElement.getAttribute('data-density')).toBe('compact')
  })

  it('sets data-density to comfortable by default', () => {
    useSettingsStore.getState().setDensityMode('comfortable')
    renderHook(() => useDensity())
    expect(document.documentElement.getAttribute('data-density')).toBe('comfortable')
  })
})
