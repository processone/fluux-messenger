import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { setPlatformForTesting } from '@/platform'
import { getNotificationAvatarUrl } from './notificationAvatar'

const writeFile = vi.fn()
vi.mock('@tauri-apps/plugin-fs', () => ({ writeFile: (...args: unknown[]) => writeFile(...args) }))
vi.mock('@tauri-apps/api/path', () => ({
  tempDir: async () => '/private/var/tmp',
  join: async (...parts: string[]) => parts.join('/'),
}))

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

// FLM-201: iOS rejects browser addresses and consumes an attachment's file.
// Each notification needs its own file; desktop file reuse must stay unchanged.
describe('getNotificationAvatarUrl attachment ownership', () => {
  let restore = () => {}
  const files = new Map<string, Uint8Array>()
  beforeEach(() => {
    writeFile.mockImplementation(async (path: string, data: Uint8Array) => {
      files.set(path, new Uint8Array(data))
    })
  })
  afterEach(() => { restore(); writeFile.mockReset(); files.clear() })

  it('writes the iOS picture to a file and returns its file:// address', async () => {
    restore = setPlatformForTesting({ shell: 'mobile', os: 'ios' })
    const url = await getNotificationAvatarUrl(png, 'ios-room-hash')
    const [path, data] = writeFile.mock.calls[0]
    expect(path).toMatch(/^\/private\/var\/tmp\/avatar-.+\.png$/)
    expect(url).toBe(`file://${path}`)
    expect(Array.from((data as Uint8Array).slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47])
  })

  it('prepares a fresh iOS file after the native attachment consumes the first', async () => {
    restore = setPlatformForTesting({ shell: 'mobile', os: 'ios' })
    const first = await getNotificationAvatarUrl(png, 'ios-repeated-hash')
    files.delete(new URL(first!).pathname)
    const next = await getNotificationAvatarUrl(png, 'ios-repeated-hash')
    expect(files.get(new URL(next!).pathname)?.byteLength).toBeGreaterThan(0)
    expect(next).not.toBe(first)
  })

  it('gives overlapping iOS notifications independent files for the same picture', async () => {
    restore = setPlatformForTesting({ shell: 'mobile', os: 'ios' })
    let writing!: () => void
    let release!: () => void
    const firstWriteStarted = new Promise<void>(resolve => { writing = resolve })
    const finishFirstWrite = new Promise<void>(resolve => { release = resolve })
    writeFile.mockImplementationOnce(async (path: string, data: Uint8Array) => {
      files.set(path, new Uint8Array(data))
      writing()
      await finishFirstWrite
    })
    const preparingFirst = getNotificationAvatarUrl(png, 'ios-overlap-hash')
    await firstWriteStarted
    const next = await getNotificationAvatarUrl(png, 'ios-overlap-hash')
    release()
    const first = await preparingFirst
    files.delete(new URL(first!).pathname)
    expect(files.get(new URL(next!).pathname)?.byteLength).toBeGreaterThan(0)
    expect(next).not.toBe(first)
  })

  it('still reuses a desktop picture file for the same hash', async () => {
    restore = setPlatformForTesting({ shell: 'desktop', os: 'macos' })
    const first = await getNotificationAvatarUrl(png, 'desktop-shared-hash')
    const next = await getNotificationAvatarUrl(png, 'desktop-shared-hash')
    expect(next).toBe(first)
    expect(writeFile).toHaveBeenCalledTimes(1)
    expect(files.get(new URL(next!).pathname)?.byteLength).toBeGreaterThan(0)
  })
})
