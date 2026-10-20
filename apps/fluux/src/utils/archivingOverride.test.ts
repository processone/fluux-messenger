/**
 * Intent (FLM-8, captain): an archiving choice the user made is saved and used on the
 * next sign-in; an account that never made one is never touched.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ArchivingPreferences } from '@fluux/sdk'
import { useSettingsStore } from '@/stores/settingsStore'
import { reapplyArchivingOverride, type ArchivingClient } from './archivingOverride'

const account = 'me@example.com'
const prefs = (policy: ArchivingPreferences['default']): ArchivingPreferences =>
  ({ default: policy, always: ['romeo@montague.lit'], never: [] })

function client(server: ArchivingPreferences): ArchivingClient & { set: ReturnType<typeof vi.fn> } {
  const set = vi.fn(async (next: ArchivingPreferences) => next)
  return { getArchivingPreferences: async () => server, setArchivingPreferences: set, set }
}

beforeEach(() => {
  localStorage.clear()
  useSettingsStore.setState({ archiveOverrides: {} })
})

describe('reapplyArchivingOverride', () => {
  it('leaves an account without an override alone, without even reading the server', async () => {
    const get = vi.fn()
    const c = { ...client(prefs('never')), getArchivingPreferences: get }

    await expect(reapplyArchivingOverride(c, account)).resolves.toBe(false)

    expect(get).not.toHaveBeenCalled()
    expect(c.set).not.toHaveBeenCalled()
  })

  it('writes the override back when the server has drifted, keeping the JID lists', async () => {
    useSettingsStore.getState().setArchiveOverride(account, { value: 'roster', original: 'always' })
    const c = client(prefs('never'))

    await expect(reapplyArchivingOverride(c, account)).resolves.toBe(true)

    expect(c.set).toHaveBeenCalledWith(prefs('roster'))
  })

  it('does nothing when the server already matches the override', async () => {
    useSettingsStore.getState().setArchiveOverride(account, { value: 'roster', original: 'always' })
    const c = client(prefs('roster'))

    await expect(reapplyArchivingOverride(c, account)).resolves.toBe(false)
    expect(c.set).not.toHaveBeenCalled()
  })
})

describe('settings store archive overrides', () => {
  it('persist per account and survive a reload, ignoring malformed entries', () => {
    useSettingsStore.getState().setArchiveOverride(account, { value: 'never', original: 'always' })
    expect(JSON.parse(localStorage.getItem('fluux-archive-overrides')!)).toEqual({ [account]: { value: 'never', original: 'always' } })

    useSettingsStore.getState().clearArchiveOverride(account)
    expect(JSON.parse(localStorage.getItem('fluux-archive-overrides')!)).toEqual({})
  })
})
