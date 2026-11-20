import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { savedStore } from '@fluux/sdk'
import { useSavedRefusalToast } from './useSavedRefusalToast'
import { useToastStore } from '@/stores/toastStore'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }))

describe('useSavedRefusalToast', () => {
  beforeEach(() => {
    savedStore.getState().reset()
    useToastStore.setState({ toasts: [] })
  })

  it('toasts once for each refusal', () => {
    renderHook(() => useSavedRefusalToast())
    expect(useToastStore.getState().toasts).toHaveLength(0)
    act(() => { savedStore.setState({ pending: { a: 'publish' } }); savedStore.getState().refuse('a', 'publish') })
    expect(useToastStore.getState().toasts).toHaveLength(1)
    act(() => { savedStore.setState({ pending: { b: 'publish' } }); savedStore.getState().refuse('b', 'publish') })
    expect(useToastStore.getState().toasts).toHaveLength(2)
    act(() => savedStore.setState({ loaded: true }))
    expect(useToastStore.getState().toasts).toHaveLength(2)
  })
})
