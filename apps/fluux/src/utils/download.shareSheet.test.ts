/**
 * @vitest-environment jsdom
 *
 * iOS has no save dialog: files leave through the system share sheet, from the
 * native media cache when the file is there, otherwise from a fetched copy that
 * is removed once the sheet closes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const { invokeMock, writeFileMock, mkdirMock, removeMock, cachedPathMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  writeFileMock: vi.fn(),
  mkdirMock: vi.fn(),
  removeMock: vi.fn(),
  cachedPathMock: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@tauri-apps/api/path', () => ({
  appCacheDir: async () => '/cache',
  join: async (...parts: string[]) => parts.join('/'),
}))
vi.mock('@tauri-apps/plugin-fs', () => ({ writeFile: writeFileMock, mkdir: mkdirMock, remove: removeMock }))
vi.mock('./mediaCache', () => ({ cachedMediaFilePath: cachedPathMock }))

import { setPlatformForTesting } from '@/platform'
import { downloadFile } from './download'
import { useToastStore } from '@/stores/toastStore'

describe('downloadFile on iOS', () => {
  let restorePlatform: () => void

  beforeEach(() => {
    restorePlatform = setPlatformForTesting({ shell: 'mobile', os: 'ios' })
    useToastStore.setState({ toasts: [] })
    for (const mock of [invokeMock, writeFileMock, mkdirMock, removeMock, cachedPathMock]) mock.mockReset()
    invokeMock.mockResolvedValue({ completed: true })
    mkdirMock.mockResolvedValue(undefined)
    writeFileMock.mockResolvedValue(undefined)
    removeMock.mockResolvedValue(undefined)
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => new ArrayBuffer(4),
    }) as unknown as typeof fetch
  })

  afterEach(() => {
    restorePlatform()
  })

  it('shares a cached media file from disk under its name', async () => {
    cachedPathMock.mockReturnValue('/cache/media/abc.jpg')

    await downloadFile('asset://localhost/cache/media/abc.jpg', 'holiday.jpg')

    expect(invokeMock).toHaveBeenCalledWith('plugin:share-sheet|share_file', {
      path: '/cache/media/abc.jpg',
      name: 'holiday.jpg',
    })
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('shares a fetched copy of any other file and removes it afterwards', async () => {
    cachedPathMock.mockReturnValue(null)

    await downloadFile('https://example.com/report.pdf', 'report.pdf')

    const [[path]] = writeFileMock.mock.calls
    expect(path).toMatch(/^\/cache\/share\//)
    expect(invokeMock).toHaveBeenCalledWith('plugin:share-sheet|share_file', { path, name: 'report.pdf' })
    expect(removeMock).toHaveBeenCalledWith(path)
  })

  it('removes the fetched copy and reports the failure when the sheet fails', async () => {
    cachedPathMock.mockReturnValue(null)
    invokeMock.mockRejectedValue(new Error('no view controller'))

    await downloadFile('https://example.com/report.pdf', 'report.pdf', { errorMessage: 'Download failed' })

    expect(removeMock).toHaveBeenCalled()
    expect(useToastStore.getState().toasts.some((t) => t.type === 'error')).toBe(true)
  })
})
