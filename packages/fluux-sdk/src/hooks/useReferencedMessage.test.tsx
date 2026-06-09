/**
 * @vitest-environment happy-dom
 *
 * Regression guard for the "frozen reply target" class: a referenced message
 * (reply/correction target) must resolve REACTIVELY from the store, so a row
 * that first renders before its target has loaded picks the target up once it
 * arrives — instead of freezing on the compatibility fallback.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useReferencedMessage } from './useReferencedMessage'
import { chatStore, roomStore } from '../stores'
import { createMessage, createRoomMessage } from './renderStability.helpers'

describe('useReferencedMessage', () => {
  beforeEach(() => {
    chatStore.setState({ messages: new Map() })
    roomStore.setState({ roomRuntime: new Map() })
  })

  describe('chat (1:1)', () => {
    it('resolves the referenced message by stanza-id', () => {
      const convId = 'alice@example.com'
      // createMessage() drops stanzaId, so attach it explicitly.
      const target = { ...createMessage(convId, 'the original', { id: 'c1' }), stanzaId: 'stanza-abc' }
      act(() => {
        chatStore.setState({ messages: new Map([[convId, [target]]]) })
      })
      const { result } = renderHook(() =>
        useReferencedMessage({ type: 'chat', conversationId: convId, id: 'stanza-abc' })
      )
      expect(result.current).toBe(target)
    })

    it('updates reactively when the target loads AFTER first render (no freeze)', () => {
      const convId = 'alice@example.com'
      const target = { ...createMessage(convId, 'the original', { id: 'c1' }), stanzaId: 'stanza-abc' }

      const { result } = renderHook(() =>
        useReferencedMessage({ type: 'chat', conversationId: convId, id: 'stanza-abc' })
      )
      expect(result.current).toBeUndefined()

      // Target paginates in later (MAM / scroll-up)
      act(() => {
        chatStore.setState({ messages: new Map([[convId, [target]]]) })
      })
      expect(result.current).toBe(target)
    })

    it('returns undefined when there is no referenced id', () => {
      const { result } = renderHook(() =>
        useReferencedMessage({ type: 'chat', conversationId: 'alice@example.com', id: undefined })
      )
      expect(result.current).toBeUndefined()
    })
  })

  describe('room (MUC)', () => {
    it('updates reactively when the referenced room message loads after first render', () => {
      const roomJid = 'board@muc.example.com'
      const target = {
        ...createRoomMessage(roomJid, 'arne', 'It would be really good to deescalate', { id: 'r1' }),
        stanzaId: '2026-06-08-33a9499a123f1e06',
      }

      const { result } = renderHook(() =>
        useReferencedMessage({ type: 'groupchat', roomJid, id: '2026-06-08-33a9499a123f1e06' })
      )
      expect(result.current).toBeUndefined()

      act(() => {
        roomStore.setState({
          roomRuntime: new Map([[roomJid, { occupants: new Map(), messages: [target] }]]),
        })
      })
      expect(result.current).toBe(target)
    })
  })
})
