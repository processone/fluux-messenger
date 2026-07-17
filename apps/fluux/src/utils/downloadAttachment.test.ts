/**
 * @vitest-environment jsdom
 *
 * downloadAttachment must decrypt encrypted attachments before saving. For a
 * plaintext attachment it delegates to downloadFile with the raw URL; for an
 * encrypted one it resolves the DECRYPTED bytes (via the platform media-cache
 * resolver) and saves those — the ciphertext URL must never reach the save path.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const { isTauriMock, saveMock, writeFileMock, resolveTauriMock, resolveWebMock } =
  vi.hoisted(() => ({
    isTauriMock: vi.fn(),
    saveMock: vi.fn(),
    writeFileMock: vi.fn(),
    resolveTauriMock: vi.fn(),
    resolveWebMock: vi.fn(),
  }))

vi.mock('./tauri', () => ({ isTauri: isTauriMock }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: saveMock }))
vi.mock('@tauri-apps/plugin-fs', () => ({ writeFile: writeFileMock }))
vi.mock('./mediaCache', () => ({
  resolveEncryptedMediaUrl: resolveTauriMock,
  resolveWebEncryptedMediaUrl: resolveWebMock,
}))

import { downloadAttachment } from './download'
import { useToastStore } from '@/stores/toastStore'
import type { FileEncryption } from '@fluux/sdk'

const enc: FileEncryption = {
  cipher: 'aes-256-gcm',
  key: new Uint8Array(32),
  iv: new Uint8Array(12),
}

describe('downloadAttachment', () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] })
    vi.clearAllMocks()
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => new ArrayBuffer(4),
    }) as unknown as typeof fetch
    // jsdom doesn't implement navigation; stub the click so the web download
    // path (which sets href/download then calls anchor.click()) doesn't emit
    // a "Not implemented: navigation" stderr warning. The assertions only
    // check attributes set before .click() is invoked, so this is safe.
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  })

  it('Tauri: encrypted → resolves decrypted URL and saves that, never the ciphertext URL', async () => {
    isTauriMock.mockReturnValue(true)
    resolveTauriMock.mockResolvedValue('asset://localhost/decrypted.dec')
    saveMock.mockResolvedValue('/Users/me/doc.pdf')

    await downloadAttachment(
      { url: 'https://up/cipher.bin', name: 'doc.pdf', encryption: enc },
      { errorMessage: 'Download failed' },
    )

    expect(resolveTauriMock).toHaveBeenCalledWith('https://up/cipher.bin', enc)
    expect(resolveWebMock).not.toHaveBeenCalled()
    // Save dialog uses the real filename.
    expect(saveMock).toHaveBeenCalledWith({ defaultPath: 'doc.pdf' })
    // The fetch that reads the bytes to write must target the DECRYPTED url.
    expect(global.fetch).toHaveBeenCalledWith('asset://localhost/decrypted.dec')
    expect(writeFileMock).toHaveBeenCalled()
  })

  it('web: encrypted → resolves via the web resolver', async () => {
    isTauriMock.mockReturnValue(false)
    resolveWebMock.mockResolvedValue('blob:decrypted')
    const createEl = vi.spyOn(document, 'createElement')

    await downloadAttachment(
      { url: 'https://up/cipher.bin', name: 'archive.zip', encryption: enc },
    )

    expect(resolveWebMock).toHaveBeenCalledWith('https://up/cipher.bin', enc)
    expect(resolveTauriMock).not.toHaveBeenCalled()
    const anchor = createEl.mock.results
      .map((r) => r.value as HTMLElement)
      .find((el) => el instanceof HTMLAnchorElement) as HTMLAnchorElement | undefined
    expect(anchor?.getAttribute('href')).toBe('blob:decrypted')
    expect(anchor?.getAttribute('download')).toBe('archive.zip')
  })

  it('plaintext → delegates to the raw URL, resolver not called', async () => {
    isTauriMock.mockReturnValue(true)
    saveMock.mockResolvedValue('/Users/me/note.txt')

    await downloadAttachment({ url: 'https://up/note.txt', name: 'note.txt' })

    expect(resolveTauriMock).not.toHaveBeenCalled()
    expect(resolveWebMock).not.toHaveBeenCalled()
    expect(global.fetch).toHaveBeenCalledWith('https://up/note.txt')
  })

  it('encrypted resolve failure → error toast, nothing written', async () => {
    isTauriMock.mockReturnValue(true)
    resolveTauriMock.mockRejectedValue(new Error('auth tag mismatch'))

    await downloadAttachment(
      { url: 'https://up/cipher.bin', name: 'doc.pdf', encryption: enc },
      { errorMessage: 'Download failed' },
    ).catch(() => {})

    expect(saveMock).not.toHaveBeenCalled()
    expect(writeFileMock).not.toHaveBeenCalled()
    expect(
      useToastStore.getState().toasts.some((t) => t.type === 'error' && t.message === 'Download failed'),
    ).toBe(true)
  })
})
