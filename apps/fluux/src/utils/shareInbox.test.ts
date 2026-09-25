import { describe, it, expect, vi } from 'vitest'
import { deliverShare, nativeShareInbox } from './shareInbox'
import type { FileAttachment } from '@fluux/sdk'
import { invoke } from '@tauri-apps/api/core'
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

describe('shared-item delivery', () => {
  const file = new File(['photo'], 'photo.png', { type: 'image/png' })
  const attachment = { url: 'https://upload.test/photo' } as FileAttachment
  function delivery() {
    return { check: vi.fn(), upload: vi.fn().mockResolvedValue(attachment), send: vi.fn().mockResolvedValue('message'), sent: vi.fn(), remove: vi.fn().mockResolvedValue(undefined) }
  }
  it('keeps the imported item on upload or send failure', async () => {
    const d = delivery()
    d.upload.mockResolvedValue(null)
    await expect(deliverShare('', file, d)).rejects.toThrow()
    expect(d.send).not.toHaveBeenCalled()
    expect(d.remove).not.toHaveBeenCalled()
    d.upload.mockResolvedValue(attachment)
    d.send.mockRejectedValue(new Error('offline'))
    await expect(deliverShare('', file, d)).rejects.toThrow()
    expect(d.sent).not.toHaveBeenCalled()
    expect(d.remove).not.toHaveBeenCalled()
  })
  it('stops before sending if the account or encryption state changes during upload', async () => {
    const d = delivery()
    d.check.mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new Error('Account changed') })
    await expect(deliverShare('caption', file, d)).rejects.toThrow('Account changed')
    expect(d.send).not.toHaveBeenCalled()
    expect(d.remove).not.toHaveBeenCalled()
  })
  it('marks sent before cleanup, even if cleanup fails', async () => {
    const d = delivery()
    d.remove.mockRejectedValue(new Error('storage unavailable'))
    await expect(deliverShare('', file, d)).rejects.toThrow()
    expect(d.send).toHaveBeenCalledWith(attachment.url, attachment)
    expect(d.sent).toHaveBeenCalledOnce()
    expect(d.sent.mock.invocationCallOrder[0]).toBeLessThan(d.remove.mock.invocationCallOrder[0])
  })
  it('reads without acknowledging and rejects truncated files', async () => {
    vi.mocked(invoke).mockResolvedValueOnce('YWJj').mockResolvedValueOnce('')
    await expect(nativeShareInbox.file({ id: 'id', name: 'image.png', text: '', size: 4, mime: 'image/png' })).rejects.toThrow('Incomplete')
    expect(vi.mocked(invoke).mock.calls.every(([command]) => command === 'plugin:share-inbox|read')).toBe(true)
  })
})
