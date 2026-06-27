import { describe, it, expect, beforeEach } from 'vitest'
import { getVisibleCategories } from './types'
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
