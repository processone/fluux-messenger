import { describe, it, expect, vi, beforeEach } from 'vitest'

const invokeMock = vi.hoisted(() => vi.fn())
const listenMock = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }))

import { uploadFileTauri } from './tauriUpload'

function bytesOf(...values: number[]): ArrayBuffer {
  return new Uint8Array(values).buffer
}

describe('uploadFileTauri', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    listenMock.mockReset()
    invokeMock.mockResolvedValue({ key: null, iv: null })
    listenMock.mockResolvedValue(() => {})
  })

  it('invokes upload_file with raw bytes and metadata headers', async () => {
    await uploadFileTauri({
      bytes: bytesOf(1, 2, 3),
      putUrl: 'https://up.example.com/slot/1',
      contentType: 'image/jpeg',
      headers: { Authorization: 'Bearer t' },
      encrypt: false,
    })

    expect(invokeMock).toHaveBeenCalledTimes(1)
    const [command, payload, options] = invokeMock.mock.calls[0]
    expect(command).toBe('upload_file')
    // Raw-body invoke: the payload must be the bytes themselves, NOT a
    // JSON-serializable args object (that would re-create the number-array
    // marshaling stall this transport exists to avoid).
    expect(payload).toBeInstanceOf(Uint8Array)
    expect(Array.from(payload as Uint8Array)).toEqual([1, 2, 3])
    expect(options.headers['x-put-url']).toBe('https://up.example.com/slot/1')
    expect(options.headers['x-content-type']).toBe('image/jpeg')
    expect(options.headers['x-encrypt']).toBe('0')
    expect(options.headers['x-upload-id']).toMatch(/\S/)
    expect(JSON.parse(options.headers['x-extra-headers'])).toEqual({ Authorization: 'Bearer t' })
  })

  it('returns undefined encryption for plain uploads', async () => {
    const result = await uploadFileTauri({
      bytes: bytesOf(1),
      putUrl: 'https://up.example.com/slot/1',
      contentType: 'application/pdf',
      encrypt: false,
    })
    expect(result).toBeUndefined()
  })

  it('decodes base64 key/iv into FileEncryption for encrypted uploads', async () => {
    const key = new Uint8Array(32).fill(7)
    const iv = new Uint8Array(12).fill(9)
    invokeMock.mockResolvedValue({
      key: btoa(String.fromCharCode(...key)),
      iv: btoa(String.fromCharCode(...iv)),
    })

    const result = await uploadFileTauri({
      bytes: bytesOf(1, 2),
      putUrl: 'https://up.example.com/slot/2',
      contentType: 'image/png',
      encrypt: true,
    })

    expect(result).toEqual({ cipher: 'aes-256-gcm', key, iv })
    const [, , options] = invokeMock.mock.calls[0]
    expect(options.headers['x-encrypt']).toBe('1')
  })

  it('throws when an encrypted upload returns no key material', async () => {
    invokeMock.mockResolvedValue({ key: null, iv: null })
    await expect(
      uploadFileTauri({
        bytes: bytesOf(1),
        putUrl: 'https://up.example.com/slot/3',
        contentType: 'image/png',
        encrypt: true,
      }),
    ).rejects.toThrow(/no encryption params/)
  })

  it('reports progress only for its own upload id and unsubscribes after', async () => {
    let handler: ((event: { payload: { id: string; sent: number; total: number } }) => void) | null = null
    const unlisten = vi.fn()
    listenMock.mockImplementation(async (_event: string, cb: typeof handler) => {
      handler = cb
      return unlisten
    })
    invokeMock.mockImplementation(async (_cmd: string, _payload: unknown, options: { headers: Record<string, string> }) => {
      const id = options.headers['x-upload-id']
      handler?.({ payload: { id, sent: 50, total: 100 } })
      handler?.({ payload: { id: 'someone-else', sent: 99, total: 100 } })
      handler?.({ payload: { id, sent: 100, total: 100 } })
      return { key: null, iv: null }
    })

    const onProgress = vi.fn()
    await uploadFileTauri({
      bytes: bytesOf(1),
      putUrl: 'https://up.example.com/slot/4',
      contentType: 'application/pdf',
      encrypt: false,
      onProgress,
    })

    expect(onProgress.mock.calls.map(([p]) => p)).toEqual([50, 100])
    expect(unlisten).toHaveBeenCalledTimes(1)
  })

  it('skips the progress listener entirely when no callback is given', async () => {
    await uploadFileTauri({
      bytes: bytesOf(1),
      putUrl: 'https://up.example.com/slot/5',
      contentType: 'application/pdf',
      encrypt: false,
    })
    expect(listenMock).not.toHaveBeenCalled()
  })
})
