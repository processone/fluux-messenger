// Intent: received encrypted text files (e.g. a shared .json) must be shown
// decrypted in the preview and downloaded decrypted, not as ciphertext.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { encryptFile } from '@fluux/sdk'
import type { FileAttachment } from '@fluux/sdk'
import { TextFilePreview } from './TextFilePreview'

const { downloadAttachmentSpy } = vi.hoisted(() => ({ downloadAttachmentSpy: vi.fn() }))

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }))
vi.mock('@/utils/download', () => ({ downloadAttachment: downloadAttachmentSpy }))
vi.mock('@/hooks/useDeferredMedia', () => ({
  useDeferredMedia: () => ({ shouldLoad: true, approve: vi.fn() }),
}))

describe('TextFilePreview with an encrypted attachment', () => {
  const json = JSON.stringify({ app: 'fluux', notifications: ['a', 'b'] }, null, 2)
  let attachment: FileAttachment

  beforeEach(async () => {
    const { ciphertext, key, iv } = await encryptFile(new TextEncoder().encode(json))
    attachment = {
      url: 'https://upload.example/abc/cipher.bin',
      name: 'diagnostic.json',
      mediaType: 'application/json',
      encryption: { cipher: 'aes-256-gcm', key, iv },
    }
    global.URL.createObjectURL = vi.fn(() => 'blob:plain')
    const store = new Map<string, Response>()
    vi.stubGlobal('caches', {
      open: async () => ({
        match: async (k: string) => store.get(k)?.clone(),
        put: async (k: string, r: Response) => { store.set(k, r) },
      }),
    })
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      if (u === 'blob:plain') return new Response(json)
      return new Response(ciphertext)
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('shows the decrypted text, not the ciphertext', async () => {
    render(<TextFilePreview attachment={attachment} />)
    await waitFor(() => expect(document.querySelector('pre')).not.toBeNull())
    expect(document.querySelector('pre')!.textContent).toContain('"app": "fluux"')
  })

  it('downloads through the decrypting path instead of linking to the ciphertext URL', () => {
    render(<TextFilePreview attachment={attachment} />)
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button'))
    expect(downloadAttachmentSpy).toHaveBeenCalledWith(attachment)
  })
})
