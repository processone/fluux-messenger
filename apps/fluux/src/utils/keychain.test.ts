import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock the tauri utility before importing keychain
const mockIsTauri = vi.fn()
vi.mock('./tauri', () => ({
  isTauri: () => mockIsTauri(),
}))

// Mock the Tauri invoke function
const mockInvoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

// Import after mocking
import { hasSavedCredentials, saveCredentials, getCredentials, deleteCredentials } from './keychain'

const STORAGE_KEY = 'xmpp-has-saved-credentials'

describe('keychain utilities', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    mockIsTauri.mockReturnValue(true)
  })

  afterEach(() => {
    localStorage.clear()
  })

  describe('hasSavedCredentials', () => {
    it('should return false when localStorage flag is not set', () => {
      expect(hasSavedCredentials()).toBe(false)
    })

    it('should return false when localStorage flag is not "true"', () => {
      localStorage.setItem(STORAGE_KEY, 'false')
      expect(hasSavedCredentials()).toBe(false)
    })

    it('should return true when localStorage flag is "true"', () => {
      localStorage.setItem(STORAGE_KEY, 'true')
      expect(hasSavedCredentials()).toBe(true)
    })
  })

  describe('saveCredentials', () => {
    it('should not call invoke when not in Tauri', async () => {
      mockIsTauri.mockReturnValue(false)
      // Silence expected console.warn
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      await saveCredentials('user@example.com', 'password', 'wss://example.com')

      expect(mockInvoke).not.toHaveBeenCalled()
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
      expect(warnSpy).toHaveBeenCalledWith('Keychain storage is only available in the desktop app')
      warnSpy.mockRestore()
    })

    it('should call invoke with correct parameters when in Tauri', async () => {
      mockInvoke.mockResolvedValue(undefined)

      await saveCredentials('user@example.com', 'password', 'wss://example.com')

      expect(mockInvoke).toHaveBeenCalledWith('save_credentials', {
        jid: 'user@example.com',
        password: 'password',
        server: 'wss://example.com',
      })
    })

    it('should set localStorage flag after successful save', async () => {
      mockInvoke.mockResolvedValue(undefined)

      await saveCredentials('user@example.com', 'password', null)

      expect(localStorage.getItem(STORAGE_KEY)).toBe('true')
    })

    it('should not set localStorage flag if invoke fails', async () => {
      mockInvoke.mockRejectedValue(new Error('Keychain error'))

      await expect(saveCredentials('user@example.com', 'password', null)).rejects.toThrow()
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    })
  })

  describe('getCredentials', () => {
    it('should return null when not in Tauri', async () => {
      mockIsTauri.mockReturnValue(false)

      const result = await getCredentials()

      expect(result).toBeNull()
      expect(mockInvoke).not.toHaveBeenCalled()
    })

    it('should return credentials when found', async () => {
      const credentials = { jid: 'user@example.com', password: 'password', server: 'wss://example.com' }
      mockInvoke.mockResolvedValue(credentials)

      const result = await getCredentials()

      expect(result).toEqual(credentials)
      expect(mockInvoke).toHaveBeenCalledWith('get_credentials')
    })

    it('should clear localStorage flag when credentials not found', async () => {
      localStorage.setItem(STORAGE_KEY, 'true')
      mockInvoke.mockResolvedValue(null)

      const result = await getCredentials()

      expect(result).toBeNull()
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    })

    it('should clear localStorage flag on error', async () => {
      localStorage.setItem(STORAGE_KEY, 'true')
      mockInvoke.mockRejectedValue(new Error('Keychain access denied'))
      // Silence expected console.error
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      const result = await getCredentials()

      expect(result).toBeNull()
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
      expect(errorSpy).toHaveBeenCalled()
      errorSpy.mockRestore()
    })

    it('should keep localStorage flag when credentials found', async () => {
      localStorage.setItem(STORAGE_KEY, 'true')
      const credentials = { jid: 'user@example.com', password: 'password', server: null }
      mockInvoke.mockResolvedValue(credentials)

      await getCredentials()

      expect(localStorage.getItem(STORAGE_KEY)).toBe('true')
    })
  })

  describe('deleteCredentials', () => {
    it('should always clear localStorage flag', async () => {
      localStorage.setItem(STORAGE_KEY, 'true')
      mockIsTauri.mockReturnValue(false)

      await deleteCredentials()

      expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    })

    it('should call invoke when in Tauri', async () => {
      mockInvoke.mockResolvedValue(undefined)

      await deleteCredentials()

      expect(mockInvoke).toHaveBeenCalledWith('delete_credentials')
    })

    it('should clear localStorage flag even if invoke fails', async () => {
      localStorage.setItem(STORAGE_KEY, 'true')
      mockInvoke.mockRejectedValue(new Error('Delete failed'))
      // Silence expected console.error
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      await deleteCredentials()

      // Flag should still be cleared even though invoke failed
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
      expect(errorSpy).toHaveBeenCalled()
      errorSpy.mockRestore()
    })
  })

  describe('localStorage synchronization', () => {
    it('should stay in sync: save sets flag, delete clears it', async () => {
      mockInvoke.mockResolvedValue(undefined)

      // Initially no flag
      expect(hasSavedCredentials()).toBe(false)

      // Save sets flag
      await saveCredentials('user@example.com', 'password', null)
      expect(hasSavedCredentials()).toBe(true)

      // Delete clears flag
      await deleteCredentials()
      expect(hasSavedCredentials()).toBe(false)
    })

    it('should recover from stale flag when credentials not in keychain', async () => {
      // Simulate stale state: flag says credentials exist but keychain is empty
      localStorage.setItem(STORAGE_KEY, 'true')
      mockInvoke.mockResolvedValue(null)

      expect(hasSavedCredentials()).toBe(true)

      // getCredentials should clear the stale flag
      const result = await getCredentials()
      expect(result).toBeNull()
      expect(hasSavedCredentials()).toBe(false)
    })
  })
})
