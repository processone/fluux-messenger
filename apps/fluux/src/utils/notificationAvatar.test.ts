import { describe, it, expect, vi, afterEach } from 'vitest'
import { setPlatformForTesting } from '@/platform'
import { getNotificationAvatarUrl } from './notificationAvatar'

const writeFile = vi.fn()
vi.mock('@tauri-apps/plugin-fs', () => ({ writeFile: (...args: unknown[]) => writeFile(...args) }))
vi.mock('@tauri-apps/api/path', () => ({
  tempDir: async () => '/private/var/tmp',
  join: async (...parts: string[]) => parts.join('/'),
}))

// FLM-201: iOS rejects blob: and data: notification attachments, so it needs the picture as a file.
describe('getNotificationAvatarUrl on iOS', () => {
  let restore = () => {}
  afterEach(() => { restore(); writeFile.mockReset() })

  it('writes the room picture to a file and returns its file:// address', async () => {
    restore = setPlatformForTesting({ shell: 'mobile', os: 'ios' })
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
    const url = await getNotificationAvatarUrl(png, 'ios-room-hash')
    expect(url).toBe('file:///private/var/tmp/avatar-ios-room-hash.png')
    const [path, data] = writeFile.mock.calls[0]
    expect(path).toBe('/private/var/tmp/avatar-ios-room-hash.png')
    expect(Array.from((data as Uint8Array).slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47])
  })
})
