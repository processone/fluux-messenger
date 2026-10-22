/** Intent FLM-39: a default change uses fresh exceptions; legacy local settings stay inert and readable. */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ArchivingPreferences } from '@fluux/sdk'
import { useSettingsStore } from '@/stores/settingsStore'
import { chooseArchiving } from './archivingOverride'

const prefs: ArchivingPreferences = { default: 'roster', always: ['romeo@montague.lit'], never: ['tybalt@capulet.lit'] }
beforeEach(() => { localStorage.clear(); useSettingsStore.setState({ archiveOverrides: {} }) })
describe('server default change', () => {
  it('serializes the entire read/write sequence, including callers outside the component', async () => {
    let resolve!: (prefs: ArchivingPreferences) => void
    const read = new Promise<ArchivingPreferences>(r => { resolve = r })
    const client = { getArchivingPreferences: vi.fn(() => read), setArchivingPreferences: vi.fn(async (p: ArchivingPreferences) => p) }
    const first = chooseArchiving(client, 'never', () => true)
    await expect(chooseArchiving(client, 'always', () => true)).rejects.toThrow()
    resolve(prefs)
    await expect(first).resolves.toEqual({ ...prefs, default: 'never' })
    expect(client.getArchivingPreferences).toHaveBeenCalledTimes(1)
    expect(client.setArchivingPreferences).toHaveBeenCalledTimes(1)
  })
  it('does not write if fresh reading fails', async () => {
    const client = { getArchivingPreferences: vi.fn().mockRejectedValue(new Error('timeout')), setArchivingPreferences: vi.fn() }
    await expect(chooseArchiving(client, 'never', () => true)).rejects.toThrow('timeout')
    expect(client.setArchivingPreferences).not.toHaveBeenCalled()
  })
  it('reads the old stored shape without rewriting or losing account data', async () => {
    const legacy = { 'me@example.com': { value: 'never', original: 'always' }, malformed: { value: 'other' } }
    const stored = JSON.stringify(legacy)
    localStorage.setItem('fluux-archive-overrides', stored)
    vi.resetModules()
    const { useSettingsStore: reloaded } = await import('@/stores/settingsStore')
    expect(reloaded.getState().archiveOverrides).toEqual({ 'me@example.com': legacy['me@example.com'] })
    expect(localStorage.getItem('fluux-archive-overrides')).toBe(stored)
  })
})
