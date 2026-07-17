import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Control platform detection per test.
const isTauri = vi.fn(() => false)
vi.mock('./tauri', () => ({ isTauri: () => isTauri() }))

import { requestPersistentStorage } from './persistStorage'

function stubStorage(storage: unknown) {
  vi.stubGlobal('navigator', { storage })
}

describe('requestPersistentStorage', () => {
  beforeEach(() => {
    isTauri.mockReturnValue(false)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('requests persistence when the origin is not yet persisted', async () => {
    const persist = vi.fn().mockResolvedValue(true)
    const persisted = vi.fn().mockResolvedValue(false)
    stubStorage({ persist, persisted })

    const result = await requestPersistentStorage()

    expect(persisted).toHaveBeenCalledOnce()
    expect(persist).toHaveBeenCalledOnce()
    expect(result).toBe(true)
  })

  it('skips the request when the origin is already persisted', async () => {
    const persist = vi.fn().mockResolvedValue(true)
    const persisted = vi.fn().mockResolvedValue(true)
    stubStorage({ persist, persisted })

    const result = await requestPersistentStorage()

    expect(persist).not.toHaveBeenCalled()
    expect(result).toBe(true)
  })

  it('is a no-op under Tauri', async () => {
    isTauri.mockReturnValue(true)
    const persist = vi.fn().mockResolvedValue(true)
    stubStorage({ persist, persisted: vi.fn().mockResolvedValue(false) })

    const result = await requestPersistentStorage()

    expect(persist).not.toHaveBeenCalled()
    expect(result).toBe(false)
  })

  it('is a no-op when the Storage API is unavailable', async () => {
    stubStorage(undefined)

    const result = await requestPersistentStorage()

    expect(result).toBe(false)
  })

  it('is a no-op when persist() is not implemented', async () => {
    stubStorage({ persisted: vi.fn().mockResolvedValue(false) })

    const result = await requestPersistentStorage()

    expect(result).toBe(false)
  })

  it('never throws when persist() rejects', async () => {
    const persist = vi.fn().mockRejectedValue(new Error('quota denied'))
    stubStorage({ persist, persisted: vi.fn().mockResolvedValue(false) })

    const result = await requestPersistentStorage()

    expect(result).toBe(false)
  })
})
