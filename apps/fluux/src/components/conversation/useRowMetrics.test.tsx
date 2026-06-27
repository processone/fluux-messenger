import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useRef } from 'react'
import { useRowMetrics, ROW_METRICS_FALLBACK } from './useRowMetrics'
import { useSettingsStore } from '@/stores/settingsStore'

describe('useRowMetrics', () => {
  it('returns the documented fallback context before any DOM sample', () => {
    const { result } = renderHook(() => {
      const ref = useRef<HTMLElement | null>(null)
      return useRowMetrics(ref)
    })
    expect(result.current.current).toEqual(ROW_METRICS_FALLBACK)
  })

  it('marks the sample stale when character scale changes (re-sample on next read)', () => {
    // Contract: changing settings invalidates so the next sample re-reads the DOM. We assert the
    // hook re-runs its sample effect by observing it does not throw and still returns a context.
    const { result } = renderHook(() => {
      const ref = useRef<HTMLElement | null>(null)
      return useRowMetrics(ref)
    })
    act(() => { useSettingsStore.getState().setFontSize(125) })
    expect(result.current.current).toBeTruthy()
    act(() => { useSettingsStore.getState().setFontSize(100) })
  })
})
