import { describe, it, expect, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { FileEncryption } from '@fluux/sdk'
import { useAttachmentUrl } from './useAttachmentUrl'

const { proxied, decrypted } = vi.hoisted(() => ({
  proxied: vi.fn(),
  decrypted: vi.fn(),
}))

vi.mock('./useProxiedUrl', () => ({ useProxiedUrl: proxied }))
vi.mock('./useDecryptedMediaUrl', () => ({ useDecryptedMediaUrl: decrypted }))

describe('useAttachmentUrl fallback provenance', () => {
  it('preserves the plaintext direct-fallback flag', () => {
    proxied.mockReturnValue({
      url: 'https://example.com/video.mkv', isLoading: false, error: null, isDirectFallback: true,
    })
    decrypted.mockReturnValue({ url: null, isLoading: false, error: null })

    const { result } = renderHook(() => useAttachmentUrl('https://example.com/video.mkv', undefined))

    expect(result.current.isDirectFallback).toBe(true)
    expect(result.current.url).toBe('https://example.com/video.mkv')
  })

  it('marks decrypted bytes as confirmed rather than a direct fallback', () => {
    proxied.mockReturnValue({ url: null, isLoading: false, error: null, isDirectFallback: false })
    decrypted.mockReturnValue({ url: 'blob:decrypted', isLoading: false, error: null })
    const encryption: FileEncryption = {
      cipher: 'aes-256-gcm', key: new Uint8Array(32), iv: new Uint8Array(12),
    }

    const { result } = renderHook(() => useAttachmentUrl('https://example.com/encrypted', encryption))

    expect(result.current.isDirectFallback).toBe(false)
    expect(result.current.url).toBe('blob:decrypted')
    expect(proxied).toHaveBeenLastCalledWith('https://example.com/encrypted', false)
    expect(decrypted).toHaveBeenLastCalledWith('https://example.com/encrypted', encryption, true)
  })
})
