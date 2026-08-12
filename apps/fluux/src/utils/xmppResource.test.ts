import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { generateResource, isValidResource } from './xmppResource'


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
    it('should generate a resource with the given prefix and 6-char suffix', () => {
      const resource = generateResource('web')
      expect(resource).toMatch(/^web-[a-z0-9]{6}$/)
    })

    it('should generate unique resources', () => {
      const resources = new Set(Array.from({ length: 20 }, () => generateResource('web')))
      expect(resources.size).toBeGreaterThan(1)
    })

    it('should use the provided prefix', () => {
      expect(generateResource('desktop')).toMatch(/^desktop-/)
      expect(generateResource('mobile')).toMatch(/^mobile-/)
    })
  })

  describe('isValidResource', () => {
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
      expect(resource).toMatch(/^web-[a-z0-9]{6}$/)
      expect(mockSessionStorage.setItem).toHaveBeenCalledWith('xmpp-resource', resource)
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
      expect(resource).toMatch(/^web-[a-z0-9]{6}$/)
      expect(resource).not.toBe('web')
    })

    it('should generate a new desktop resource when localStorage is empty', async () => {
      const getRes = await loadGetResource('desktop')
      const resource = getRes()
      expect(resource).toMatch(/^desktop-[a-z0-9]{6}$/)
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
      expect(resource).toMatch(/^desktop-[a-z0-9]{6}$/)
      expect(resource).not.toBe('desktop')
    })
  })
})
