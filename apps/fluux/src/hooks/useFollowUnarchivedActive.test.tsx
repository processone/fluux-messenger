import { describe, it, expect, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useFollowUnarchivedActive } from './useFollowUnarchivedActive'

interface Props {
  activeConversationId: string | null
  isActiveArchived: boolean
  showArchived: boolean
  onShowActive: () => void
}

function setup(initial: Props) {
  return renderHook((props: Props) => useFollowUnarchivedActive(props), {
    initialProps: initial,
  })
}

describe('useFollowUnarchivedActive', () => {
  it('returns to the active list when the open conversation is unarchived', () => {
    const onShowActive = vi.fn()
    const { rerender } = setup({
      activeConversationId: 'a@x',
      isActiveArchived: true,
      showArchived: true,
      onShowActive,
    })

    rerender({ activeConversationId: 'a@x', isActiveArchived: false, showArchived: true, onShowActive })

    expect(onShowActive).toHaveBeenCalledTimes(1)
  })

  it('does nothing while the open conversation stays archived', () => {
    const onShowActive = vi.fn()
    const { rerender } = setup({
      activeConversationId: 'a@x',
      isActiveArchived: true,
      showArchived: true,
      onShowActive,
    })

    rerender({ activeConversationId: 'a@x', isActiveArchived: true, showArchived: true, onShowActive })

    expect(onShowActive).not.toHaveBeenCalled()
  })

  it('does nothing when the archived list is not shown', () => {
    const onShowActive = vi.fn()
    const { rerender } = setup({
      activeConversationId: 'a@x',
      isActiveArchived: true,
      showArchived: false,
      onShowActive,
    })

    rerender({ activeConversationId: 'a@x', isActiveArchived: false, showArchived: false, onShowActive })

    expect(onShowActive).not.toHaveBeenCalled()
  })

  it('does not fire when a different conversation becomes active', () => {
    const onShowActive = vi.fn()
    // Was viewing an archived conversation; a different, non-archived one becomes active.
    const { rerender } = setup({
      activeConversationId: 'a@x',
      isActiveArchived: true,
      showArchived: true,
      onShowActive,
    })

    rerender({ activeConversationId: 'b@x', isActiveArchived: false, showArchived: true, onShowActive })

    expect(onShowActive).not.toHaveBeenCalled()
  })

  it('does not fire when the active conversation is closed (id -> null)', () => {
    const onShowActive = vi.fn()
    const { rerender } = setup({
      activeConversationId: 'a@x',
      isActiveArchived: true,
      showArchived: true,
      onShowActive,
    })

    rerender({ activeConversationId: null, isActiveArchived: false, showArchived: true, onShowActive })

    expect(onShowActive).not.toHaveBeenCalled()
  })

  it('does not fire on initial mount of an already-unarchived conversation', () => {
    const onShowActive = vi.fn()
    setup({
      activeConversationId: 'a@x',
      isActiveArchived: false,
      showArchived: true,
      onShowActive,
    })

    expect(onShowActive).not.toHaveBeenCalled()
  })
})
