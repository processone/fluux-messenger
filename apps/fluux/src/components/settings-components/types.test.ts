import { describe, it, expect, beforeEach } from 'vitest'
import { getVisibleCategories, getGroupedVisibleCategories } from './types'
import { useAdvancedModeStore } from '@/stores/advancedModeStore'

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
