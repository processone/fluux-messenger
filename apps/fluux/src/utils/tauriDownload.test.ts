import { describe, it, expect, vi, beforeEach } from 'vitest'

const invokeMock = vi.hoisted(() => vi.fn())
const listenMock = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }))

import { downloadFileTauri, parseDownloadEnvelope } from './tauriDownload'

/** Build the `[4-byte LE meta length][meta JSON][body]` envelope Rust returns. */
function envelope(meta: { contentType: string | null }, body: number[]): ArrayBuffer {
  const metaBytes = new TextEncoder().encode(JSON.stringify(meta))
  const out = new Uint8Array(4 + metaBytes.length + body.length)
  new DataView(out.buffer).setUint32(0, metaBytes.length, true)
  out.set(metaBytes, 4)
  out.set(body, 4 + metaBytes.length)
  return out.buffer
}

describe('parseDownloadEnvelope', () => {
  it('splits metadata and body apart', () => {
    const result = parseDownloadEnvelope(envelope({ contentType: 'image/png' }, [1, 2, 3]))
    expect(result.contentType).toBe('image/png')
    expect(Array.from(result.bytes)).toEqual([1, 2, 3])
  })

  it('strips content-type parameters', () => {
    const result = parseDownloadEnvelope(envelope({ contentType: 'text/plain; charset=utf-8' }, []))
    expect(result.contentType).toBe('text/plain')
  })

  it('passes null content-type through', () => {
    const result = parseDownloadEnvelope(envelope({ contentType: null }, [7]))
    expect(result.contentType).toBeNull()
    expect(Array.from(result.bytes)).toEqual([7])
  })

  it('rejects a truncated envelope', () => {
    expect(() => parseDownloadEnvelope(new Uint8Array([1, 2]).buffer)).toThrow(/malformed envelope/)
  })

  it('rejects a meta length pointing past the buffer', () => {
    const out = new Uint8Array(8)
    new DataView(out.buffer).setUint32(0, 100, true)
    expect(() => parseDownloadEnvelope(out.buffer)).toThrow(/malformed envelope/)
  })
})

describe('downloadFileTauri', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    listenMock.mockReset()
    invokeMock.mockResolvedValue(envelope({ contentType: null }, []))
    listenMock.mockResolvedValue(() => {})
  })

  it('invokes download_file with metadata headers and returns the body', async () => {
    invokeMock.mockResolvedValue(envelope({ contentType: 'image/jpeg' }, [1, 2, 3]))

    const result = await downloadFileTauri({ url: 'https://dl.example.com/file/1' })

    expect(invokeMock).toHaveBeenCalledTimes(1)
    const [command, payload, options] = invokeMock.mock.calls[0]
    expect(command).toBe('download_file')
    expect(payload).toBeUndefined()
    expect(options.headers['x-get-url']).toBe('https://dl.example.com/file/1')
    expect(options.headers['x-download-id']).toMatch(/\S/)
    expect(options.headers['x-decrypt-key']).toBeUndefined()
    expect(options.headers['x-decrypt-iv']).toBeUndefined()
    expect(result.contentType).toBe('image/jpeg')
    expect(Array.from(result.bytes)).toEqual([1, 2, 3])
  })

  it('sends base64 key/iv headers when decrypt params are given', async () => {
    const key = new Uint8Array(32).fill(7)
    const iv = new Uint8Array(12).fill(9)

    await downloadFileTauri({
      url: 'https://dl.example.com/file/2',
      decrypt: { key, iv },
    })

    const [, , options] = invokeMock.mock.calls[0]
    expect(options.headers['x-decrypt-key']).toBe(btoa(String.fromCharCode(...key)))
    expect(options.headers['x-decrypt-iv']).toBe(btoa(String.fromCharCode(...iv)))
  })

  it('reports progress only for its own download id and unsubscribes after', async () => {
    let handler: ((event: { payload: { id: string; received: number; total: number } }) => void) | null = null
    const unlisten = vi.fn()
    listenMock.mockImplementation(async (_event: string, cb: typeof handler) => {
      handler = cb
      return unlisten
    })
    invokeMock.mockImplementation(async (_cmd: string, _payload: unknown, options: { headers: Record<string, string> }) => {
      const id = options.headers['x-download-id']
      handler?.({ payload: { id, received: 50, total: 100 } })
      handler?.({ payload: { id: 'someone-else', received: 99, total: 100 } })
      handler?.({ payload: { id, received: 100, total: 100 } })
      return envelope({ contentType: null }, [])
    })

    const onProgress = vi.fn()
    await downloadFileTauri({ url: 'https://dl.example.com/file/3', onProgress })

    expect(onProgress.mock.calls.map(([p]) => p)).toEqual([50, 100])
    expect(unlisten).toHaveBeenCalledTimes(1)
  })

  it('skips the progress listener entirely when no callback is given', async () => {
    await downloadFileTauri({ url: 'https://dl.example.com/file/4' })
    expect(listenMock).not.toHaveBeenCalled()
  })

  it('unsubscribes the progress listener when the invoke rejects', async () => {
    const unlisten = vi.fn()
    listenMock.mockResolvedValue(unlisten)
    invokeMock.mockRejectedValue(new Error('Download failed: 404'))

    await expect(
      downloadFileTauri({ url: 'https://dl.example.com/file/5', onProgress: vi.fn() }),
    ).rejects.toThrow(/404/)
    expect(unlisten).toHaveBeenCalledTimes(1)
  })
})
