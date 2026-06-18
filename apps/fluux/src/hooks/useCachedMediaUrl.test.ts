import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

const { peekMediaCacheSpy, peekWebMediaCacheSpy, peekEncryptedSpy, peekWebEncryptedSpy } = vi.hoisted(() => ({
  peekMediaCacheSpy: vi.fn(),
  peekWebMediaCacheSpy: vi.fn(),
  peekEncryptedSpy: vi.fn(),
  peekWebEncryptedSpy: vi.fn(),
}))
const mockIsTauri = vi.fn()

vi.mock('@/utils/tauri', () => ({ isTauri: () => mockIsTauri() }))
vi.mock('@/utils/mediaCache', () => ({
  peekMediaCache: (u: string) => peekMediaCacheSpy(u),
  peekWebMediaCache: (u: string) => peekWebMediaCacheSpy(u),
  peekEncryptedMediaCache: (u: string) => peekEncryptedSpy(u),
  peekWebEncryptedMediaCache: (u: string) => peekWebEncryptedSpy(u),
}))

import { useCachedMediaUrl } from './useCachedMediaUrl'

describe('useCachedMediaUrl', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsTauri.mockReturnValue(false)
    peekWebMediaCacheSpy.mockResolvedValue(null)
    peekMediaCacheSpy.mockResolvedValue(null)
    peekEncryptedSpy.mockResolvedValue(null)
    peekWebEncryptedSpy.mockResolvedValue(null)
  })

  it('returns the cached URL on a web plaintext hit', async () => {
    peekWebMediaCacheSpy.mockResolvedValue('blob:hit')
    const { result } = renderHook(() => useCachedMediaUrl('https://x/a.png', undefined, true))
    await waitFor(() => expect(result.current.isPeeking).toBe(false))
    expect(result.current.cachedUrl).toBe('blob:hit')
    expect(peekWebMediaCacheSpy).toHaveBeenCalledWith('https://x/a.png')
  })

  it('returns null on a miss', async () => {
    const { result } = renderHook(() => useCachedMediaUrl('https://x/a.png', undefined, true))
    await waitFor(() => expect(result.current.isPeeking).toBe(false))
    expect(result.current.cachedUrl).toBeNull()
  })

  it('does nothing when disabled', async () => {
    const { result } = renderHook(() => useCachedMediaUrl('https://x/a.png', undefined, false))
    expect(result.current).toEqual({ cachedUrl: null, isPeeking: false })
    expect(peekWebMediaCacheSpy).not.toHaveBeenCalled()
  })

  it('uses the encrypted peek when encryption is present', async () => {
    peekWebEncryptedSpy.mockResolvedValue('blob:dec')
    const enc = { key: new Uint8Array(), iv: new Uint8Array() } as never
    const { result } = renderHook(() => useCachedMediaUrl('https://x/enc.bin', enc, true))
    await waitFor(() => expect(result.current.isPeeking).toBe(false))
    expect(result.current.cachedUrl).toBe('blob:dec')
    expect(peekWebEncryptedSpy).toHaveBeenCalledWith('https://x/enc.bin')
    expect(peekWebMediaCacheSpy).not.toHaveBeenCalled()
  })

  it('uses the Tauri peek when isTauri()', async () => {
    mockIsTauri.mockReturnValue(true)
    peekMediaCacheSpy.mockResolvedValue('https://asset.localhost/x')
    const { result } = renderHook(() => useCachedMediaUrl('https://x/a.png', undefined, true))
    await waitFor(() => expect(result.current.isPeeking).toBe(false))
    expect(result.current.cachedUrl).toBe('https://asset.localhost/x')
    expect(peekMediaCacheSpy).toHaveBeenCalledWith('https://x/a.png')
  })
})
