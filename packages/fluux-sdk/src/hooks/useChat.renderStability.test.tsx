/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useChat } from './useChat'
import { useChatActive } from './useChatActive'
import { chatStore } from '../stores'
import {
  wrapper,
  useRenderCount,
  createConversation,
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
})
