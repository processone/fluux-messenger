import { describe, it, expect, beforeEach } from 'vitest'
import { useExpandedMessagesStore } from './expandedMessagesStore'

describe('expandedMessagesStore', () => {
  beforeEach(() => {
    // Reset store state before each test
    useExpandedMessagesStore.getState().clear()
  })

  it('should start with empty expanded set', () => {
    const { expandedIds } = useExpandedMessagesStore.getState()
    expect(expandedIds.size).toBe(0)
  })

  it('should expand a message', () => {
    const { expand, isExpanded } = useExpandedMessagesStore.getState()

    expand('msg-1')

    expect(isExpanded('msg-1')).toBe(true)
    expect(isExpanded('msg-2')).toBe(false)
  })

  it('should collapse a message', () => {
    const { expand, collapse, isExpanded } = useExpandedMessagesStore.getState()

    expand('msg-1')
    expect(isExpanded('msg-1')).toBe(true)

    collapse('msg-1')
    expect(isExpanded('msg-1')).toBe(false)
  })

  it('should toggle a message', () => {
    const { toggle, isExpanded } = useExpandedMessagesStore.getState()

    // Initially collapsed
    expect(isExpanded('msg-1')).toBe(false)

    // Toggle to expanded
    toggle('msg-1')
    expect(isExpanded('msg-1')).toBe(true)

    // Toggle back to collapsed
    toggle('msg-1')
    expect(isExpanded('msg-1')).toBe(false)
  })

  it('should track multiple messages independently', () => {
    const { expand, collapse, isExpanded } = useExpandedMessagesStore.getState()

    expand('msg-1')
    expand('msg-2')
    expand('msg-3')

    expect(isExpanded('msg-1')).toBe(true)
    expect(isExpanded('msg-2')).toBe(true)
    expect(isExpanded('msg-3')).toBe(true)

    collapse('msg-2')

    expect(isExpanded('msg-1')).toBe(true)
    expect(isExpanded('msg-2')).toBe(false)
    expect(isExpanded('msg-3')).toBe(true)
  })

  it('should clear all expanded messages', () => {
    const { expand, clear, isExpanded } = useExpandedMessagesStore.getState()

    expand('msg-1')
    expand('msg-2')
    expand('msg-3')

    clear()

    expect(isExpanded('msg-1')).toBe(false)
    expect(isExpanded('msg-2')).toBe(false)
    expect(isExpanded('msg-3')).toBe(false)
  })

  it('should handle collapsing non-expanded message gracefully', () => {
    const { collapse, isExpanded } = useExpandedMessagesStore.getState()

    // Should not throw
    collapse('non-existent')

    expect(isExpanded('non-existent')).toBe(false)
  })
})
