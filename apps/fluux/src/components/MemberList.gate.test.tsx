import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import { MemberList } from './MemberList'

// MemberList holds a full useRoster() subscription, which re-renders it on every
// roster/presence change. It is always mounted in ChatLayout but renders content
// only for an active group chat. The fix gates the roster subscription so it is
// NOT taken when no group chat is active — otherwise presence churn re-renders the
// right sidebar while it is invisible (see docs/2026-06-24-render-perf-phase0-baseline.md:
// MemberList = 30/100 renders on presence churn pre-fix).
const h = vi.hoisted(() => ({
  useRosterSpy: vi.fn(() => ({ sortedContacts: [], removeContact: vi.fn(), renameContact: vi.fn() })),
  state: { activeConversation: null as { type: string } | null },
}))

vi.mock('@/utils/renderLoopDetector', () => ({ detectRenderLoop: () => {} }))

vi.mock('@fluux/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fluux/sdk')>()
  return {
    ...actual,
    useChatActive: () => ({ activeConversation: h.state.activeConversation }),
    useRoster: h.useRosterSpy,
  }
})

vi.mock('@fluux/sdk/react', () => ({
  useConnectionStore: (selector: (s: { status: string }) => unknown) => selector({ status: 'online' }),
}))

vi.mock('./Avatar', () => ({ Avatar: () => null }))
vi.mock('./conversation/UserInfoPopover', () => ({
  UserInfoPopover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

describe('MemberList roster-subscription gate', () => {
  beforeEach(() => { h.useRosterSpy.mockClear() })

  it('does NOT subscribe to the roster when the active conversation is a 1:1 chat', () => {
    h.state.activeConversation = { type: 'chat' }
    render(<MemberList />)
    expect(h.useRosterSpy).not.toHaveBeenCalled()
  })

  it('does NOT subscribe to the roster when there is no active conversation', () => {
    h.state.activeConversation = null
    render(<MemberList />)
    expect(h.useRosterSpy).not.toHaveBeenCalled()
  })

  it('DOES subscribe to the roster for an active group chat', () => {
    h.state.activeConversation = { type: 'groupchat' }
    render(<MemberList />)
    expect(h.useRosterSpy).toHaveBeenCalled()
  })
})
