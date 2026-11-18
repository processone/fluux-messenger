import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { useConversationFileDropStore, DROPPED_FILE_TTL_MS } from './conversationFileDropStore'

const h = vi.hoisted(() => ({ scope: null as string | null }))
vi.mock('@fluux/sdk', () => ({ getStorageScopeJid: () => h.scope }))
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
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => { vi.useRealTimers(); setStorageScopeJid(null) })

    it('forgets an offer whose conversation never opened', () => {
      useConversationFileDropStore.getState().offer('a@x', new File([], 'a'))
      vi.advanceTimersByTime(DROPPED_FILE_TTL_MS)
      expect(useConversationFileDropStore.getState().pending).toBeNull()
    })

    it('records the account the file was dropped under', () => {
      setStorageScopeJid('me@x')
      useConversationFileDropStore.getState().offer('a@x', new File([], 'a'))
      expect(useConversationFileDropStore.getState().pending?.account).toBe('me@x')
    })
  })
})
