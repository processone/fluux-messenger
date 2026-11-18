/**
 * The pending-restore marker: a sessionStorage entry written before a native
 * restore is dispatched, kept when the outcome is uncertain, and read by
 * isBackupRestoreUncertain. It exists on the macOS desktop app only; the other
 * hosts must neither write nor read it. Runs in the DOM environment so
 * sessionStorage is real.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PluginContext } from '@fluux/sdk'
import { resetUncertainImportsForTesting, SequoiaPgpPlugin, type BackupRecoveryMode, type InvokeFn, type KeyBundle } from '@fluux/openpgp-plugin'
import { createAppHostStores } from './appHostStores'

const JID = 'me@example.com'
const MARKER = `__wry_pending_native_restore:${JID}`
const BUNDLE: KeyBundle = { fingerprint: 'FP1', publicArmored: 'PUB', keychainBacked: true }
const fileIO = { saveFile: async () => false, pickFile: async () => null }

class Probe extends SequoiaPgpPlugin {
  restore(recovery?: BackupRecoveryMode) {
    return this.backupImportSelected(JID, 'MSG', 'pass', 'FP1', recovery)
  }
  setAccount() {
    this.ctx = { account: { jid: JID } } as PluginContext
  }
}

function build(macosDesktop: boolean, invoke: InvokeFn) {
  const plugin = new Probe({ stores: createAppHostStores(), fileIO, macosDesktop, invoke })
  plugin.setAccount()
  return plugin
}

beforeEach(() => { resetUncertainImportsForTesting() })
afterEach(() => { resetUncertainImportsForTesting() })

describe('pending-restore marker on the macOS desktop app', () => {
  it('is written before the native call is dispatched', async () => {
    let seenDuringCall: string | null = null
    const plugin = build(true, async <T>() => {
      seenDuringCall = sessionStorage.getItem(MARKER)
      return BUNDLE as T
    })
    await plugin.restore()
    expect(seenDuringCall).toBe('1')
  })

  it('is removed after a known success', async () => {
    const plugin = build(true, async <T>() => BUNDLE as T)
    await plugin.restore()
    expect(sessionStorage.getItem(MARKER)).toBeNull()
    expect(plugin.isBackupRestoreUncertain()).toBe(false)
  })

  it('is removed after a known failure', async () => {
    const plugin = build(true, async () => { throw new Error('no SKESK matched the supplied passphrase') })
    await expect(plugin.restore()).rejects.toThrow(/SKESK/)
    expect(sessionStorage.getItem(MARKER)).toBeNull()
    expect(plugin.isBackupRestoreUncertain()).toBe(false)
  })

  it('is kept after an uncertain outcome and reports the restore as uncertain', async () => {
    const plugin = build(true, async () => { throw new Error('openpgp-restore-outcome-uncertain: not confirmed durable') })
    await expect(plugin.restore()).rejects.toMatchObject({ code: 'restore-outcome-uncertain' })
    expect(sessionStorage.getItem(MARKER)).toBe('1')
    expect(plugin.isBackupRestoreUncertain()).toBe(true)
  })

  it('blocks a restore, and reports uncertain, on a pre-existing marker alone', async () => {
    sessionStorage.setItem(MARKER, '1')
    let dispatched = false
    const plugin = build(true, async <T>() => { dispatched = true; return BUNDLE as T })
    expect(plugin.isBackupRestoreUncertain()).toBe(true)
    await expect(plugin.restore()).rejects.toMatchObject({ code: 'restore-outcome-uncertain' })
    expect(dispatched).toBe(false)
  })

  it('reports uncertain when the browser store cannot be read', () => {
    const plugin = build(true, async <T>() => BUNDLE as T)
    const original = Object.getOwnPropertyDescriptor(window, 'sessionStorage')!
    Object.defineProperty(window, 'sessionStorage', { configurable: true, get() { throw new Error('denied') } })
    try {
      expect(plugin.isBackupRestoreUncertain()).toBe(true)
    } finally {
      Object.defineProperty(window, 'sessionStorage', original)
    }
  })

  it('asks the native side to skip the migration only for a recovery restore', async () => {
    const calls: Array<Record<string, unknown> | undefined> = []
    const plugin = build(true, async <T>(_cmd: string, args?: Record<string, unknown>) => { calls.push(args); return BUNDLE as T })
    await plugin.restore({ accountJid: JID })
    await plugin.restore()
    expect(calls[0]).toMatchObject({ withoutMigration: true })
    expect(calls[1]).not.toHaveProperty('withoutMigration')
  })
})

// Windows, Linux and iOS all reach the plugin as macosDesktop: false (the
// mapping from platform values is pinned in appDesktopHost.test.ts).
describe('pending-restore marker on other hosts', () => {
  it('is never written, even while the native call is in flight', async () => {
    let seenDuringCall: string | null = 'unset'
    const plugin = build(false, async <T>() => {
      seenDuringCall = sessionStorage.getItem(MARKER)
      return BUNDLE as T
    })
    await plugin.restore({ accountJid: JID })
    expect(seenDuringCall).toBeNull()
  })

  it('leaves no marker after an uncertain outcome; only the in-memory guard holds', async () => {
    const plugin = build(false, async () => { throw new Error('openpgp-restore-outcome-uncertain: x') })
    await expect(plugin.restore()).rejects.toMatchObject({ code: 'restore-outcome-uncertain' })
    expect(sessionStorage.getItem(MARKER)).toBeNull()
    expect(plugin.isBackupRestoreUncertain()).toBe(true)
  })

  it('ignores a pre-existing marker', async () => {
    sessionStorage.setItem(MARKER, '1')
    const plugin = build(false, async <T>() => BUNDLE as T)
    expect(plugin.isBackupRestoreUncertain()).toBe(false)
    await expect(plugin.restore()).resolves.toEqual(BUNDLE)
  })

  it('does not ask the native side to skip the migration', async () => {
    let args: Record<string, unknown> | undefined
    const plugin = build(false, async <T>(_cmd: string, a?: Record<string, unknown>) => { args = a; return BUNDLE as T })
    await plugin.restore({ accountJid: JID })
    expect(args).not.toHaveProperty('withoutMigration')
  })
})
