import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useLoginPrefillDeepLink } from './useLoginPrefillDeepLink'
import { useLoginPrefillStore } from '@/stores/loginPrefillStore'

describe('useLoginPrefillDeepLink', () => {
  beforeEach(() => {
    useLoginPrefillStore.getState().clearPrefill()
  })

  it('is a no-op outside Tauri (does not set a prefill or throw)', () => {
    // jsdom has no __TAURI_INTERNALS__, so the hook should not touch the store.
    expect(() => renderHook(() => useLoginPrefillDeepLink())).not.toThrow()
    expect(useLoginPrefillStore.getState().prefill).toBeNull()
  })
})
