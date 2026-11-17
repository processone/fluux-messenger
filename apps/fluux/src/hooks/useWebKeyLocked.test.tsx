import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { clearSessionPassphrase, setSessionPassphrase } from '@fluux/openpgp-plugin'
import { useWebKeyLocked } from './useWebKeyLocked'

const fake = vi.hoisted(() => ({ keyNeedsSessionPassphrase: true }))
vi.mock('@/platform', () => ({ platform: () => fake }))

// The passphrase store is a module singleton. These tests write through the
// package entry and read through the hook, so they fail if the app and the
// package ever load two copies of the store.
describe('useWebKeyLocked', () => {
  afterEach(() => {
    act(() => clearSessionPassphrase())
    fake.keyNeedsSessionPassphrase = true
  })

  it('follows a passphrase set and cleared through the package entry', () => {
    const { result } = renderHook(() => useWebKeyLocked())
    expect(result.current).toBe(true)

    act(() => setSessionPassphrase('correct horse'))
    expect(result.current).toBe(false)

    act(() => clearSessionPassphrase())
    expect(result.current).toBe(true)
  })

  it('never reports locked on a platform that keeps keys in the native process', () => {
    fake.keyNeedsSessionPassphrase = false
    const { result } = renderHook(() => useWebKeyLocked())
    expect(result.current).toBe(false)
  })
})
