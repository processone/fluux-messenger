import { describe, it, expect, beforeEach } from 'vitest'
import { useConversationFileDropStore } from './conversationFileDropStore'

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
})
