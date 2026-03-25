import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

// Mock tauri detection — default to non-Tauri (web)
const mockIsTauri = vi.fn(() => false)
vi.mock('@/utils/tauri', () => ({
  isTauri: () => mockIsTauri(),
}))

// Mock mediaCache
const mockResolveMediaUrl = vi.fn()
const mockResolveWebMediaUrl = vi.fn()
const mockResetMediaUrlCache = vi.fn()
vi.mock('@/utils/mediaCache', () => ({
  resolveMediaUrl: (url: string) => mockResolveMediaUrl(url),
  resolveWebMediaUrl: (url: string) => mockResolveWebMediaUrl(url),
  resetMediaUrlCache: () => mockResetMediaUrlCache(),
}))

import { sanitizeMediaUrl, useProxiedUrl, clearProxiedUrlCache } from './useProxiedUrl'

describe('sanitizeMediaUrl', () => {
  it('should encode & and = in URL path segments', () => {
    const url =
      'https://upload.isacloud.im:5281/file_share/019c54ed-91f2-7434-b717-6fdd8296c5b3/uuid=51B2BBEE-EAA7-4738-BEB6-F32AC33B16A2&code=001&library=1&type=3&mode=2&loc=true&cap=true.mov'
    const result = sanitizeMediaUrl(url)

    expect(result).toBe(
      'https://upload.isacloud.im:5281/file_share/019c54ed-91f2-7434-b717-6fdd8296c5b3/uuid%3D51B2BBEE-EAA7-4738-BEB6-F32AC33B16A2%26code%3D001%26library%3D1%26type%3D3%26mode%3D2%26loc%3Dtrue%26cap%3Dtrue.mov'
    )
  })

  it('should leave normal URLs unchanged', () => {
    const url = 'https://example.com/uploads/photo.jpg'
    expect(sanitizeMediaUrl(url)).toBe(url)
  })

  it('should preserve already-encoded characters', () => {
    const url = 'https://example.com/uploads/my%20photo.jpg'
    expect(sanitizeMediaUrl(url)).toBe(url)
  })

  it('should preserve query parameters', () => {
    const url = 'https://example.com/file.jpg?token=abc&expires=123'
    expect(sanitizeMediaUrl(url)).toBe(url)
  })

  it('should preserve hash fragments', () => {
    const url = 'https://example.com/file.jpg#section'
    expect(sanitizeMediaUrl(url)).toBe(url)
  })

  it('should handle URLs with port numbers', () => {
    const url = 'https://upload.example.com:5281/file.mov'
    expect(sanitizeMediaUrl(url)).toBe(url)
  })

  it('should return invalid URLs unchanged', () => {
    const invalid = 'not-a-url'
    expect(sanitizeMediaUrl(invalid)).toBe(invalid)
  })

  it('should handle root path URL', () => {
    const url = 'https://example.com/'
    expect(sanitizeMediaUrl(url)).toBe(url)
  })

  it('should be idempotent', () => {
    const url =
      'https://upload.isacloud.im:5281/file_share/uuid=FILE&code=001.mov'
    const once = sanitizeMediaUrl(url)
    const twice = sanitizeMediaUrl(once)
    expect(twice).toBe(once)
  })
})

describe('useProxiedUrl', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsTauri.mockReturnValue(false)
  })

  // --- Web mode tests ---

  it('should return sanitized URL immediately on web', () => {
    const { result } = renderHook(() =>
      useProxiedUrl('https://example.com/photo.jpg')
    )

    expect(result.current.url).toBe('https://example.com/photo.jpg')
    expect(result.current.isLoading).toBe(false)
    expect(result.current.error).toBeNull()
    // Should never call resolveMediaUrl in web mode
    expect(mockResolveMediaUrl).not.toHaveBeenCalled()
  })

  it('should return null when disabled', () => {
    const { result } = renderHook(() =>
      useProxiedUrl('https://example.com/photo.jpg', false)
    )

    expect(result.current.url).toBeNull()
    expect(result.current.isLoading).toBe(false)
  })

  it('should return null when URL is undefined', () => {
    const { result } = renderHook(() =>
      useProxiedUrl(undefined)
    )

    expect(result.current.url).toBeNull()
    expect(result.current.isLoading).toBe(false)
  })

  it('should sanitize URL on web (encode special path chars)', () => {
    const { result } = renderHook(() =>
      useProxiedUrl('https://upload.example.com/file_share/uuid=A&code=1.mov')
    )

    expect(result.current.url).toBe(
      'https://upload.example.com/file_share/uuid%3DA%26code%3D1.mov'
    )
  })

  // --- Tauri mode tests ---

  it('should resolve via media cache in Tauri mode', async () => {
    mockIsTauri.mockReturnValue(true)
    mockResolveMediaUrl.mockResolvedValue('https://asset.localhost/cached/abc.jpg')

    const { result } = renderHook(() =>
      useProxiedUrl('https://upload.example.com/photo.jpg')
    )

    // Initially loading
    expect(result.current.isLoading).toBe(true)

    await waitFor(() => {
      expect(result.current.url).toBe('https://asset.localhost/cached/abc.jpg')
    })

    expect(result.current.isLoading).toBe(false)
    expect(result.current.error).toBeNull()
    expect(mockResolveMediaUrl).toHaveBeenCalledWith('https://upload.example.com/photo.jpg')
  })

  it('should fall back to sanitized URL when media cache fails in Tauri', async () => {
    mockIsTauri.mockReturnValue(true)
    mockResolveMediaUrl.mockRejectedValue(new Error('Fetch failed: 404'))

    const { result } = renderHook(() =>
      useProxiedUrl('https://upload.example.com/photo.jpg')
    )

    // Initially loading
    expect(result.current.isLoading).toBe(true)

    await waitFor(() => {
      expect(result.current.url).toBe('https://upload.example.com/photo.jpg')
    })

    // Falls back gracefully — no error exposed, just direct URL
    expect(result.current.isLoading).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it('should not update state after unmount (cancelled)', async () => {
    mockIsTauri.mockReturnValue(true)
    // Slow resolve that will complete after unmount
    let resolvePromise: (value: string) => void
    mockResolveMediaUrl.mockReturnValue(new Promise(resolve => {
      resolvePromise = resolve
    }))

    const { result, unmount } = renderHook(() =>
      useProxiedUrl('https://upload.example.com/photo.jpg')
    )

    expect(result.current.isLoading).toBe(true)

    // Unmount before the promise resolves
    unmount()

    // Resolve the promise after unmount — should not throw or update
    await act(async () => {
      resolvePromise!('https://asset.localhost/cached.jpg')
    })

    // No error thrown means cancellation works
  })
})

describe('clearProxiedUrlCache', () => {
  it('should call resetMediaUrlCache', () => {
    clearProxiedUrlCache()
    expect(mockResetMediaUrlCache).toHaveBeenCalledTimes(1)
  })
})
