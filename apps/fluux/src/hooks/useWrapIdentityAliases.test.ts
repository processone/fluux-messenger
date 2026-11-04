import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { act } from 'react'
import { chatStore } from '@fluux/sdk/stores'
import type { Message } from '@fluux/sdk'
import { useWrapIdentityAliases } from './useWrapIdentityAliases'
import { useWrappedCodeBlocksStore } from '@/stores/wrappedCodeBlocksStore'
import { messageWrapIdentity } from '@/components/conversation/messageRowIdentity'

// Source: captain's choice on review FLM-404 R3 — wrap, switch chat, enrichment, return keeps the
// choice; look-alike twins stay apart (R6).
const at = new Date('2026-01-01T12:00:00Z')
const dm = (o: Partial<Message> = {}): Message =>
  ({ id: 'm1', type: 'chat', conversationId: 'bob@x.org', from: 'bob@x.org', body: '```\nx\n```', timestamp: at, isOutgoing: false, ...o }) as Message
const wrapped = (m: Message) => useWrappedCodeBlocksStore.getState().isWrapped(messageWrapIdentity(m)!, 0)
const setMessages = (list: Message[]) => act(() => { chatStore.setState({ messages: new Map([['bob@x.org', list]]) }) })

describe('useWrapIdentityAliases', () => {
  beforeEach(() => {
    useWrappedCodeBlocksStore.getState().clear()
    chatStore.setState({ messages: new Map() })
  })

  it('wrap → switch chat → enrichment → return keeps the choice on the original only', () => {
    renderHook(() => useWrapIdentityAliases())
    const original = dm()
    const twin = dm({ stanzaId: 'B' })
    setMessages([original, twin])
    useWrappedCodeBlocksStore.getState().toggle(messageWrapIdentity(original)!, 0)
    // another chat is open: the bubble is unmounted when the archive supplies the ids
    setMessages([twin, dm({ stanzaId: 'A', originId: 'o1' })])
    expect(wrapped(dm({ stanzaId: 'A', originId: 'o1' }))).toBe(true)
    expect(wrapped(twin)).toBe(false)
    expect(wrapped(original)).toBe(false)
  })

  it('stops following the stores once unmounted', () => {
    const { unmount } = renderHook(() => useWrapIdentityAliases())
    const original = dm()
    setMessages([original])
    useWrappedCodeBlocksStore.getState().toggle(messageWrapIdentity(original)!, 0)
    unmount()
    setMessages([dm({ stanzaId: 'A' })])
    expect(wrapped(dm({ stanzaId: 'A' }))).toBe(false)
  })
})
