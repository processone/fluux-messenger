/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useChatActive } from './useChatActive'
import { chatStore } from '../stores'
import {
  wrapper,
  useRenderCount,
  createConversation,
  createMessage,
  generateConversations,
} from './renderStability.helpers'

describe('useChatActive render stability', () => {
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

  it('should not re-render when a background conversation receives messages', () => {
    // Set up: conversation A is active, conversation B exists in background
    const convA = createConversation('alice@example.com')
    const convB = createConversation('bob@example.com')

    act(() => {
      chatStore.getState().addConversation(convA)
      chatStore.getState().addConversation(convB)
      chatStore.getState().setActiveConversation('alice@example.com')
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

    // Add 10 messages to background conversation B
    act(() => {
      for (let i = 0; i < 10; i++) {
        chatStore.getState().addMessage(
          createMessage('bob@example.com', `Message ${i}`, {
            id: `msg-b-${i}`,
            from: 'bob@example.com',

          })
        )
      }
    })

    // useChatActive should NOT re-render for background messages
    expect(result.current.renderCount).toBe(rendersAfterMount)
  })

  it('should not re-render when background conversation metadata changes', () => {
    const convs = generateConversations(5)

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

    // Add messages to background conversations (changes metadata: lastMessage, unreadCount)
    act(() => {
      for (let i = 1; i < 5; i++) {
        chatStore.getState().addMessage(
          createMessage(convs[i].id, `Unread msg for conv ${i}`, {
            id: `msg-${i}`,
            from: convs[i].id,

          })
        )
      }
    })

    // useChatActive should NOT re-render for background metadata changes
    expect(result.current.renderCount).toBe(rendersAfterMount)
  })

  it('should re-render when active conversation receives a message', () => {
    const convA = createConversation('alice@example.com')

    act(() => {
      chatStore.getState().addConversation(convA)
      chatStore.getState().setActiveConversation('alice@example.com')
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

    // Add a message to the active conversation
    act(() => {
      chatStore.getState().addMessage(
        createMessage('alice@example.com', 'Hello!', {
          id: 'msg-active-1',
          from: 'alice@example.com',
        })
      )
    })

    // Should have exactly 1 additional render for the active message
    expect(result.current.renderCount).toBe(rendersAfterMount + 1)
  })

  it('should re-render exactly once when switching active conversation', () => {
    const convA = createConversation('alice@example.com')
    const convB = createConversation('bob@example.com')

    act(() => {
      chatStore.getState().addConversation(convA)
      chatStore.getState().addConversation(convB)
      chatStore.getState().setActiveConversation('alice@example.com')
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

    // Switch to conversation B
    act(() => {
      chatStore.getState().setActiveConversation('bob@example.com')
    })

    // Should re-render (at least once, at most a few due to multiple selector changes)
    const rendersAfterSwitch = result.current.renderCount - rendersAfterMount
    expect(rendersAfterSwitch).toBeGreaterThanOrEqual(1)
    expect(rendersAfterSwitch).toBeLessThanOrEqual(3) // activeId + name + type may batch differently
    expect(result.current.activeConversationId).toBe('bob@example.com')
  })

  it('should remain stable with many background conversations during simulated MAM sync', () => {
    // Simulate a user with 50 conversations
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

    // Simulate background MAM sync: add messages to 25 background conversations
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

    // useChatActive should NOT re-render during background MAM sync
    expect(result.current.renderCount).toBe(rendersAfterMount)
  })
})
