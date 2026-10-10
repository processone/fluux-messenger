import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import { MemberList } from './MemberList'

const h = vi.hoisted(() => ({
  useRosterSpy: vi.fn(() => ({ sortedContacts: [], removeContact: vi.fn(), renameContact: vi.fn() })),
  state: { activeConversation: null as { type: string } | null },
}))

vi.mock('@/utils/renderLoopDetector', () => ({ detectRenderLoop: () => {} }))

vi.mock('@fluux/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fluux/sdk')>()
  return {
    ...actual,
    useRoster: h.useRosterSpy,
  }
})

vi.mock('@fluux/sdk/react', () => ({
  useChatStore: (selector: (s: {
    activeConversationId: string | null
    conversationEntities: Map<string, { type: string }>
  }) => unknown) => selector({
    activeConversationId: h.state.activeConversation ? 'active' : null,
    conversationEntities: new Map(h.state.activeConversation ? [['active', h.state.activeConversation]] : []),
  }),
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
