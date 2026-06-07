/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useChat } from './useChat'
import { useChatActive } from './useChatActive'
import { chatStore } from '../stores'
import {
  wrapper,
  useRenderCount,
  createMessage,
  generateConversations,
} from './renderStability.helpers'

describe('useChat render stability', () => {
  beforeEach(() => {
    chatStore.setState({
      conversations: new Map(),
      conversationEntities: new Map(),
      conversationMeta: new Map(),
      messages: new Map(),
      activeConversationId: null,
      archivedConversations: new Set(),
      typingStates: new Map(),
      drafts: new Map(),
      mamQueryStates: new Map(),
      activeAnimation: null,
    })
  })

  it('should re-render linearly (not quadratically) during background MAM sync', () => {
    // Set up 50 conversations
    const convs = generateConversations(50)

    act(() => {
      convs.forEach(c => chatStore.getState().addConversation(c))
      chatStore.getState().setActiveConversation(convs[0].id)
    })

    const { result } = renderHook(
      () => {
        const renderCount = useRenderCount()
        const hookResult = useChat()
        return { renderCount, ...hookResult }
      },
      { wrapper }
    )

    const rendersAfterMount = result.current.renderCount

    // Simulate MAM sync: add messages to 25 background conversations
    act(() => {
      for (let i = 1; i <= 25; i++) {
        chatStore.getState().addMessage(
          createMessage(convs[i].id, `MAM sync msg ${i}`, {
            id: `mam-msg-${i}`,
            from: convs[i].id,

          })
        )
      }
    })

    const totalRenders = result.current.renderCount - rendersAfterMount
    // useChat subscribes to the full conversation list, so it WILL re-render.
    // But it should be linear (at most 25), not quadratic (25*25).
    expect(totalRenders).toBeLessThanOrEqual(25)
    expect(totalRenders).toBeGreaterThan(0) // Confirm it does re-render (it subscribed to the list)
  })

  it('should NOT re-render useChatActive during the same MAM sync', () => {
    // Same scenario, but with useChatActive — proves isolation
    const convs = generateConversations(50)

    act(() => {
      convs.forEach(c => chatStore.getState().addConversation(c))
      chatStore.getState().setActiveConversation(convs[0].id)
    })

    const { result } = renderHook(
      () => {
        const renderCount = useRenderCount()
        const hookResult = useChatActive()
        return { renderCount, ...hookResult }
      },
      { wrapper }
    )

    const rendersAfterMount = result.current.renderCount

    // Same MAM sync: 25 background conversations updated
    act(() => {
      for (let i = 1; i <= 25; i++) {
        chatStore.getState().addMessage(
          createMessage(convs[i].id, `MAM sync msg ${i}`, {
            id: `mam-msg-${i}`,
            from: convs[i].id,

          })
        )
      }
    })

    // useChatActive should have 0 extra renders — it doesn't subscribe to the conversation list
    expect(result.current.renderCount).toBe(rendersAfterMount)
  })

  it('should handle adding many conversations without excessive renders', () => {
    const { result } = renderHook(
      () => {
        const renderCount = useRenderCount()
        const hookResult = useChat()
        return { renderCount, ...hookResult }
      },
      { wrapper }
    )

    const startRenders = result.current.renderCount

    // Add 50 conversations in a single act()
    const convs = generateConversations(50)
    act(() => {
      convs.forEach(c => chatStore.getState().addConversation(c))
    })

    const totalRenders = result.current.renderCount - startRenders
    // Should be bounded — linear at worst
    expect(totalRenders).toBeLessThanOrEqual(50)
    expect(result.current.conversations.length).toBe(50)
  })

  // Typing / draft churn must NOT re-render list consumers of useChat().
  // useChat() must not subscribe to the whole typingStates / drafts Maps — those
  // are replaced on every keystroke in ANY conversation, which would storm the
  // sidebar conversation list during background activity. Per-conversation typing
  // and drafts are read inside the memoized ConversationItem via narrow selectors
  // (useChatStore((s) => s.typingStates.get(id))), not at the list level.
  describe('typing/draft churn isolation (regression guard for #1)', () => {
    // setTyping schedules an auto-clear setTimeout; fake timers keep it from
    // firing after teardown (which would surface as stderr).
    beforeEach(() => { vi.useFakeTimers() })
    afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

    function setupActiveConversation() {
      const convs = generateConversations(5)
      act(() => {
        convs.forEach(c => chatStore.getState().addConversation(c))
        chatStore.getState().setActiveConversation(convs[0].id)
      })
      return convs
    }

    it('does NOT re-render a useChat() consumer when a non-active conversation starts typing', () => {
      const convs = setupActiveConversation()

      const { result } = renderHook(
        () => {
          const renderCount = useRenderCount()
          useChat()
          return { renderCount }
        },
        { wrapper }
      )

      const before = result.current.renderCount

      act(() => {
        chatStore.getState().setTyping(convs[1].id, 'someone@example.com', true)
      })

      // A typing change in a background conversation must not touch the list.
      expect(result.current.renderCount).toBe(before)
    })

    it('does NOT re-render a useChat() consumer when a draft changes', () => {
      const convs = setupActiveConversation()

      const { result } = renderHook(
        () => {
          const renderCount = useRenderCount()
          useChat()
          return { renderCount }
        },
        { wrapper }
      )

      const before = result.current.renderCount

      act(() => {
        chatStore.getState().setDraft(convs[1].id, 'a background draft')
      })

      expect(result.current.renderCount).toBe(before)
    })
  })
})
