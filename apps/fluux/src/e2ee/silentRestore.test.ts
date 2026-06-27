import { describe, it, expect, vi, beforeEach } from 'vitest'

// The cache module touches IndexedDB + WebCrypto; mock it so we test the
// branching logic of the silent-restore helper, not the storage layer.
const loadCachedPassphrase = vi.fn()
const clearCachedPassphrase = vi.fn()
vi.mock('./webPassphraseCache', () => ({
  loadCachedPassphrase: (...args: unknown[]) => loadCachedPassphrase(...args),
  clearCachedPassphrase: (...args: unknown[]) => clearCachedPassphrase(...args),
}))

import { attemptCachedUnlockOrPrompt } from './silentRestore'

const JID = 'alice@example.com'

beforeEach(() => {
  loadCachedPassphrase.mockReset()
  clearCachedPassphrase.mockReset()
})

describe('attemptCachedUnlockOrPrompt', () => {
  it('unlocks silently on a cache hit and does not open the dialog', async () => {
    loadCachedPassphrase.mockResolvedValue('cached-pass')
    const unlock = vi.fn().mockResolvedValue({ recovered: false })
    const openDialog = vi.fn()

    await attemptCachedUnlockOrPrompt({
      accountJid: JID,
      getUnlockPlugin: () => ({ unlock }),
      openDialog,
    })

    expect(unlock).toHaveBeenCalledWith('cached-pass')
    expect(openDialog).not.toHaveBeenCalled()
    expect(clearCachedPassphrase).not.toHaveBeenCalled()
  })

  it('clears the stale cache entry and opens the dialog when unlock throws', async () => {
    loadCachedPassphrase.mockResolvedValue('stale-pass')
    const unlock = vi.fn().mockRejectedValue(new Error('wrong-passphrase'))
    const openDialog = vi.fn()

    await attemptCachedUnlockOrPrompt({
      accountJid: JID,
      getUnlockPlugin: () => ({ unlock }),
      openDialog,
    })

    expect(clearCachedPassphrase).toHaveBeenCalledWith(JID)
    expect(openDialog).toHaveBeenCalledTimes(1)
  })

  it('opens the dialog on a cache miss without attempting unlock', async () => {
    loadCachedPassphrase.mockResolvedValue(null)
    const unlock = vi.fn()
    const openDialog = vi.fn()

    await attemptCachedUnlockOrPrompt({
      accountJid: JID,
      getUnlockPlugin: () => ({ unlock }),
      openDialog,
    })

    expect(unlock).not.toHaveBeenCalled()
    expect(openDialog).toHaveBeenCalledTimes(1)
    expect(clearCachedPassphrase).not.toHaveBeenCalled()
  })

  it('opens the dialog when the plugin is absent (never strands the user)', async () => {
    loadCachedPassphrase.mockResolvedValue('cached-pass')
    const openDialog = vi.fn()

    await attemptCachedUnlockOrPrompt({
      accountJid: JID,
      getUnlockPlugin: () => null,
      openDialog,
    })

    expect(openDialog).toHaveBeenCalledTimes(1)
    expect(clearCachedPassphrase).not.toHaveBeenCalled()
  })

  it('skips the cache lookup and opens the dialog when accountJid is null', async () => {
    const openDialog = vi.fn()

    await attemptCachedUnlockOrPrompt({
      accountJid: null,
      getUnlockPlugin: () => ({ unlock: vi.fn() }),
      openDialog,
    })

    expect(loadCachedPassphrase).not.toHaveBeenCalled()
    expect(openDialog).toHaveBeenCalledTimes(1)
  })
})
