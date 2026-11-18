import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { useConversationFileDropStore } from './conversationFileDropStore'

const h = vi.hoisted(() => ({ scope: null as string | null, chat: null as unknown as import('zustand/vanilla').StoreApi<{ activationTarget: string | null }> }))
vi.mock('@fluux/sdk', async () => {
  const { createStore } = await import('zustand/vanilla')
  h.chat = createStore(() => ({ activationTarget: null as string | null }))
  return { getStorageScopeJid: () => h.scope, chatStore: h.chat }
})
const setStorageScopeJid = (jid: string | null) => { h.scope = jid }

// Intent: the chat view takes a dropped file once; a newer drop is not lost to a stale take.
describe('conversationFileDropStore', () => {
  beforeEach(() => useConversationFileDropStore.setState({ pending: null }))

  it('keeps a newer offer when an older one is taken', () => {
    const { offer, take } = useConversationFileDropStore.getState()
    offer('a@x', new File([], 'a'))
    const first = useConversationFileDropStore.getState().pending!
    offer('b@x', new File([], 'b'))

    take(first)

    expect(useConversationFileDropStore.getState().pending?.conversationId).toBe('b@x')
  })

  describe('abandoned and cross-account offers', () => {
    afterEach(() => { setStorageScopeJid(null); h.chat.setState({ activationTarget: null }) })
    const offerFor = (id: string) => {
      h.chat.setState({ activationTarget: id })
      useConversationFileDropStore.getState().offer(id, new File([], id))
    }

    it('abandons an offer when another conversation is selected before its own opens', () => {
      offerFor('b@x')
      h.chat.setState({ activationTarget: 'c@x' })
      expect(useConversationFileDropStore.getState().pending).toBeNull()

      h.chat.setState({ activationTarget: 'b@x' })
      expect(useConversationFileDropStore.getState().pending).toBeNull()
    })

    it('abandons an offer when the activation is cancelled', () => {
      offerFor('b@x')
      h.chat.setState({ activationTarget: null })
      expect(useConversationFileDropStore.getState().pending).toBeNull()
    })

    it('keeps an offer through a repeated request for its own conversation and a long load', () => {
      vi.useFakeTimers()
      offerFor('b@x')
      h.chat.setState({ activationTarget: null })
      offerFor('b@x')
      h.chat.setState({ activationTarget: 'b@x' })
      vi.advanceTimersByTime(10 * 60_000)
      vi.useRealTimers()
      expect(useConversationFileDropStore.getState().pending?.conversationId).toBe('b@x')
    })

    it('records the account the file was dropped under', () => {
      setStorageScopeJid('me@x')
      offerFor('a@x')
      expect(useConversationFileDropStore.getState().pending?.account).toBe('me@x')
    })
  })
})
