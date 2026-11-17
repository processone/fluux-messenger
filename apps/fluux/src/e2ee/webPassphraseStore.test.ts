import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearSessionPassphrase,
  getSessionPassphrase,
  isKeyLocked,
  setSessionPassphrase,
  subscribeKeyLockState,
} from './webPassphraseStore'

describe('webPassphraseStore', () => {
  afterEach(() => clearSessionPassphrase())

  it('starts locked with no passphrase', () => {
    expect(getSessionPassphrase()).toBeNull()
    expect(isKeyLocked()).toBe(true)
  })

  it('unlocks when a passphrase is set and locks again when cleared', () => {
    setSessionPassphrase('correct horse')
    expect(getSessionPassphrase()).toBe('correct horse')
    expect(isKeyLocked()).toBe(false)

    clearSessionPassphrase()
    expect(getSessionPassphrase()).toBeNull()
    expect(isKeyLocked()).toBe(true)
  })

  it('notifies subscribers synchronously on set and on clear', () => {
    const listener = vi.fn()
    subscribeKeyLockState(listener)
    setSessionPassphrase('a')
    expect(listener).toHaveBeenCalledTimes(1)
    clearSessionPassphrase()
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('stops notifying once unsubscribed', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeKeyLockState(listener)
    unsubscribe()
    setSessionPassphrase('a')
    expect(listener).not.toHaveBeenCalled()
  })

  it('does not write the passphrase to any browser storage', () => {
    setSessionPassphrase('never-on-disk')
    for (const storage of [localStorage, sessionStorage]) {
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i)!
        expect(storage.getItem(key)).not.toContain('never-on-disk')
      }
    }
  })
})
