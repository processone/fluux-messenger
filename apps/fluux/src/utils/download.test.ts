/**
 * @vitest-environment jsdom
 *
 * downloadFile must NOT swallow failures: the Tauri fs plugin only permits
 * writes under $HOME, so saving elsewhere rejects writeFile, and the proxied
 * fetch can fail (or return a non-OK status). Those must surface as an error
 * toast — a cancelled save dialog must NOT.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const { saveMock, writeFileMock } = vi.hoisted(() => ({
  saveMock: vi.fn(),
  writeFileMock: vi.fn(),
}))

vi.mock('./tauri', () => ({ isTauri: () => true }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: saveMock }))
vi.mock('@tauri-apps/plugin-fs', () => ({ writeFile: writeFileMock }))

import { downloadFile } from './download'
import { useToastStore } from '@/stores/toastStore'

describe('downloadFile error feedback', () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] })
    saveMock.mockReset()
    writeFileMock.mockReset()
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => new ArrayBuffer(4),
    }) as unknown as typeof fetch
  })

  it('shows an error toast when the write fails (e.g. saving outside $HOME)', async () => {
    saveMock.mockResolvedValue('/Volumes/ext/image.png')
    writeFileMock.mockRejectedValue(new Error('forbidden path: not under $HOME'))

    await downloadFile('https://x/i.png', 'i.png', { errorMessage: 'Download failed' }).catch(() => {})

    const toasts = useToastStore.getState().toasts
    expect(toasts.some((t) => t.type === 'error' && t.message === 'Download failed')).toBe(true)
  })

  it('does NOT toast when the user cancels the save dialog', async () => {
    saveMock.mockResolvedValue(null)

    await downloadFile('https://x/i.png', 'i.png', { errorMessage: 'Download failed' })

    expect(useToastStore.getState().toasts).toHaveLength(0)
    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it('shows an error toast (and writes nothing) when the fetch is not OK', async () => {
    saveMock.mockResolvedValue('/Users/me/image.png')
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      arrayBuffer: async () => new ArrayBuffer(0),
    }) as unknown as typeof fetch

    await downloadFile('https://x/i.png', 'i.png', { errorMessage: 'Download failed' }).catch(() => {})

    expect(useToastStore.getState().toasts.some((t) => t.type === 'error')).toBe(true)
    expect(writeFileMock).not.toHaveBeenCalled()
  })
})
