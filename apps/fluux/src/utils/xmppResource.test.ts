import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { generateResource, isValidResource } from './xmppResource'

const { nativePlatform } = vi.hoisted(() => ({ nativePlatform: vi.fn(() => 'macos') }))
vi.mock('@tauri-apps/plugin-os', () => ({ platform: nativePlatform }))

function createStorageMock(): Storage {
  const store: Record<string, string> = {}
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => { store[key] = value }),
    removeItem: vi.fn((key: string) => { delete store[key] }),
    clear: vi.fn(() => { Object.keys(store).forEach(k => delete store[k]) }),
    get length() { return Object.keys(store).length },
    key: vi.fn((index: number) => Object.keys(store)[index] ?? null),
  }
}

describe('xmppResource', () => {
  describe('generateResource', () => {
    it.each([
      ['web', 'w'],
      ['desktop', 'd'],
      ['mobile', 'm'],
    ] as const)('should identify %s with fluux-%s and a 5-char suffix', (platform, letter) => {
      expect(generateResource(platform)).toMatch(new RegExp(`^fluux-${letter}[a-z0-9]{5}$`))
    })

    it('should generate unique resources', () => {
      const resources = new Set(Array.from({ length: 20 }, () => generateResource('web')))
      expect(resources.size).toBeGreaterThan(1)
    })

  })

  describe('isValidResource', () => {
    it.each(['fluux-wabc12', 'fluux-d00000', 'fluux-mzzzzz'])(
      'should accept %s', (resource) => {
        expect(isValidResource(resource)).toBe(true)
      },
    )

    it.each([
      'fluux-w', 'fluux-wabc1', 'fluux-wabc123', 'fluux-xabc12',
      'fluux-Wabc12', 'Fluux-wabc12', 'fluux-wABC12', 'fluux-wabc!2',
    ])('should reject malformed resource %s', (resource) => {
      expect(isValidResource(resource)).toBe(false)
    })

    it('should accept valid web resources', () => {
      expect(isValidResource('web-abc123')).toBe(true)
      expect(isValidResource('web-000000')).toBe(true)
      expect(isValidResource('web-zzzzzz')).toBe(true)
    })

    it('should accept valid desktop resources', () => {
      expect(isValidResource('desktop-abc123')).toBe(true)
    })

    it('should reject bare prefix without suffix', () => {
      expect(isValidResource('web')).toBe(false)
      expect(isValidResource('desktop')).toBe(false)
    })

    it('should reject resources with wrong suffix length', () => {
      expect(isValidResource('web-abc')).toBe(false)
      expect(isValidResource('web-abc1234')).toBe(false)
    })

    it('should reject resources with invalid characters in suffix', () => {
      expect(isValidResource('web-ABC123')).toBe(false)
      expect(isValidResource('web-abc!23')).toBe(false)
    })

    it('should reject unknown prefixes', () => {
      expect(isValidResource('mobile-abc123')).toBe(false)
      expect(isValidResource('foo-abc123')).toBe(false)
    })

    it('should reject empty string', () => {
      expect(isValidResource('')).toBe(false)
    })
  })

  describe('getResource', () => {
    let mockSessionStorage: Storage
    let mockLocalStorage: Storage
    let originalSessionStorage: Storage
    let originalLocalStorage: Storage

    beforeEach(async () => {
      nativePlatform.mockReset().mockReturnValue('macos')
      mockSessionStorage = createStorageMock()
      mockLocalStorage = createStorageMock()
      originalSessionStorage = globalThis.sessionStorage
      originalLocalStorage = globalThis.localStorage
      vi.stubGlobal('sessionStorage', mockSessionStorage)
      vi.stubGlobal('localStorage', mockLocalStorage)

      // Re-import to pick up mocked storage
      vi.resetModules()
    })

    afterEach(() => {
      vi.stubGlobal('sessionStorage', originalSessionStorage)
      vi.stubGlobal('localStorage', originalLocalStorage)
      vi.restoreAllMocks()
    })

    /**
     * Load `getResource` against a stated platform.
     *
     * `vi.resetModules()` above gives each test a fresh module registry, so the
     * platform seam has to be taken from that same registry — a
     * `setPlatformForTesting` imported statically at the top of this file would
     * configure a different module instance than the one `xmppResource` reads.
     */
    async function loadGetResource(shell: 'desktop' | 'web') {
      const { setPlatformForTesting } = await import('@/platform')
      setPlatformForTesting({ shell, os: 'macos' })
      const mod = await import('./xmppResource')
      return mod.getResource
    }

    it('should generate a new web resource when sessionStorage is empty', async () => {
      const getRes = await loadGetResource('web')
      const resource = getRes()
      expect(resource).toMatch(/^fluux-w[a-z0-9]{5}$/)
      expect(mockSessionStorage.setItem).toHaveBeenCalledWith('xmpp-resource', resource)
      expect(nativePlatform).not.toHaveBeenCalled()
    })

    it('should return existing valid web resource from sessionStorage', async () => {
      mockSessionStorage.setItem('xmpp-resource', 'web-abc123')
      const getRes = await loadGetResource('web')
      expect(getRes()).toBe('web-abc123')
    })

    it('should regenerate when sessionStorage has bare "web" (stale value)', async () => {
      mockSessionStorage.setItem('xmpp-resource', 'web')
      const getRes = await loadGetResource('web')
      const resource = getRes()
      expect(resource).toMatch(/^fluux-w[a-z0-9]{5}$/)
      expect(resource).not.toBe('web')
    })

    it('should generate a new desktop resource when localStorage is empty', async () => {
      const getRes = await loadGetResource('desktop')
      const resource = getRes()
      expect(resource).toMatch(/^fluux-d[a-z0-9]{5}$/)
      expect(mockLocalStorage.setItem).toHaveBeenCalledWith('xmpp-resource', resource)
    })

    it('should return existing valid desktop resource from localStorage', async () => {
      mockLocalStorage.setItem('xmpp-resource', 'desktop-xyz789')
      const getRes = await loadGetResource('desktop')
      expect(getRes()).toBe('desktop-xyz789')
    })

    it('should regenerate when localStorage has bare "desktop" (stale value)', async () => {
      mockLocalStorage.setItem('xmpp-resource', 'desktop')
      const getRes = await loadGetResource('desktop')
      const resource = getRes()
      expect(resource).toMatch(/^fluux-d[a-z0-9]{5}$/)
      expect(resource).not.toBe('desktop')
    })

    it.each(['ios', 'android'])('should generate a persistent mobile resource on %s', async (os) => {
      nativePlatform.mockReturnValue(os)
      const getRes = await loadGetResource('desktop')
      const resource = getRes()
      expect(resource).toMatch(/^fluux-m[a-z0-9]{5}$/)
      expect(mockLocalStorage.getItem('xmpp-resource')).toBe(resource)
      expect(getRes()).toBe(resource)
      expect(mockSessionStorage.length).toBe(0)
    })

    it.each([
      ['web', 'fluux-wabc12'],
      ['desktop', 'fluux-dabc12'],
      ['desktop', 'fluux-mabc12'],
    ] as const)('should preserve a stored %s resource %s across reloads', async (shell, resource) => {
      const storage = shell === 'web' ? mockSessionStorage : mockLocalStorage
      storage.setItem('xmpp-resource', resource)
      const getRes = await loadGetResource(shell)
      expect(getRes()).toBe(resource)
      vi.resetModules()
      const getResAfterReload = await loadGetResource(shell)
      expect(getResAfterReload()).toBe(resource)
    })

    it('should fall back to desktop when the native OS is unavailable', async () => {
      nativePlatform.mockImplementation(() => { throw new Error('OS plugin unavailable') })
      const getRes = await loadGetResource('desktop')
      expect(getRes()).toMatch(/^fluux-d[a-z0-9]{5}$/)
    })

    it('should keep the web type in a mobile browser without querying the native OS', async () => {
      nativePlatform.mockReturnValue('android')
      const getRes = await loadGetResource('web')
      expect(getRes()).toMatch(/^fluux-w[a-z0-9]{5}$/)
      expect(nativePlatform).not.toHaveBeenCalled()
    })
  })
})
