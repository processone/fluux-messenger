import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { getVisibleCategories, getGroupedVisibleCategories, resolveSettingsCategory } from './types'
import { useAdvancedModeStore } from '@/stores/advancedModeStore'

function setTauriEnv(on: boolean) {
  if (on) (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  else delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
}

describe('getVisibleCategories — advanced category', () => {
  beforeEach(() => {
    useAdvancedModeStore.setState({ advancedMode: false })
  })

  it('includes the advanced category when advanced mode is OFF', () => {
    useAdvancedModeStore.getState().setAdvancedMode(false)
    const ids = getVisibleCategories().map((c) => c.id)
    expect(ids).toContain('advanced')
  })

  it('includes the advanced category when advanced mode is ON', () => {
    useAdvancedModeStore.getState().setAdvancedMode(true)
    const ids = getVisibleCategories().map((c) => c.id)
    expect(ids).toContain('advanced')
  })
})

describe('getGroupedVisibleCategories', () => {
  beforeEach(() => {
    useAdvancedModeStore.setState({ advancedMode: false })
  })

  it('returns groups in account, general, privacy, system order', () => {
    const groups = getGroupedVisibleCategories().map((g) => g.group)
    expect(groups).toEqual(['account', 'general', 'privacy', 'system'])
  })

  it('puts profile alone in the account group with no header label', () => {
    const account = getGroupedVisibleCategories().find((g) => g.group === 'account')!
    expect(account.labelKey).toBeNull()
    expect(account.items.map((c) => c.id)).toEqual(['profile'])
  })

  it('orders the privacy group encryption, privacy, blocked with a header label', () => {
    const privacy = getGroupedVisibleCategories().find((g) => g.group === 'privacy')!
    expect(privacy.labelKey).toBe('settings.groups.privacy')
    expect(privacy.items.map((c) => c.id)).toEqual(['encryption', 'privacy', 'blocked'])
  })

  it('orders the general group appearance, accessibility, language, notifications', () => {
    const general = getGroupedVisibleCategories().find((g) => g.group === 'general')!
    expect(general.labelKey).toBe('settings.groups.general')
    expect(general.items.map((c) => c.id)).toEqual([
      'appearance', 'accessibility', 'language', 'notifications',
    ])
  })

  it('omits a group whose items are all platform-filtered out', () => {
    // In the jsdom test env isTauri() is false, so storage and updates are
    // hidden; the system group still has advanced, so it is present.
    const system = getGroupedVisibleCategories().find((g) => g.group === 'system')!
    expect(system.items.map((c) => c.id)).toEqual(['advanced'])
  })
})

describe('resolveSettingsCategory — platform gating', () => {
  afterEach(() => {
    setTauriEnv(false)
  })

  it('falls back to profile for a Tauri-only category deep-linked in the web build', () => {
    setTauriEnv(false)
    expect(resolveSettingsCategory('mcp')).toBe('profile')
    expect(resolveSettingsCategory('storage')).toBe('profile')
  })

  it('keeps a Tauri-only category on the desktop build', () => {
    setTauriEnv(true)
    expect(resolveSettingsCategory('mcp')).toBe('mcp')
    expect(resolveSettingsCategory('storage')).toBe('storage')
  })

  it('defaults to profile when no category is requested', () => {
    expect(resolveSettingsCategory(undefined)).toBe('profile')
    expect(resolveSettingsCategory(null)).toBe('profile')
    expect(resolveSettingsCategory('')).toBe('profile')
  })

  it('falls back to profile for an unknown category string', () => {
    expect(resolveSettingsCategory('not-a-category')).toBe('profile')
  })

  it('passes through categories available on every platform', () => {
    expect(resolveSettingsCategory('appearance')).toBe('appearance')
    expect(resolveSettingsCategory('advanced')).toBe('advanced')
  })
})
