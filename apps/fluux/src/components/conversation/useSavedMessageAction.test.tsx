import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { buildSavedMessage, savedStore, type Message, type RoomMessage } from '@fluux/sdk'

vi.mock('@fluux/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@fluux/sdk')>()),
  connectionStore: { getState: () => ({ jid: 'romeo@montague.example/phone' }) },
}))
vi.mock('@fluux/sdk/react', async () => {
  const { savedStore } = await import('@fluux/sdk')
  const { useStore } = await import('zustand')
  return { useSavedStore: (selector: (s: never) => unknown) => useStore(savedStore, selector as never) }
})
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }))
import { useSavedMessageAction } from './useSavedMessageAction'
import { useToastStore } from '@/stores/toastStore'

const msg = (extra: Partial<Message> = {}): Message => ({
  type: 'chat', id: 'm1', conversationId: 'juliet@capulet.example', from: 'juliet@capulet.example/balcony',
  body: 'hi', timestamp: new Date(1000), isOutgoing: false, stanzaId: 's1', originId: undefined, ...extra,
})

describe('useSavedMessageAction', () => {
  beforeEach(() => {
    localStorage.clear()
    savedStore.getState().reset()
    useToastStore.setState({ toasts: [] })
  })

  it('offers save for a confirmed message and toggles it on and off', () => {
    const { result } = renderHook(() => useSavedMessageAction(msg()))
    expect(result.current.onToggleSaved).toBeDefined()
    expect(result.current.isSaved).toBe(false)
    act(() => result.current.onToggleSaved!())
    expect(result.current.isSaved).toBe(true)
    expect(Object.keys(savedStore.getState().entries)).toHaveLength(1)
    act(() => result.current.onToggleSaved!())
    expect(result.current.isSaved).toBe(false)
    expect(Object.keys(savedStore.getState().entries)).toHaveLength(0)
  })

  it('offers nothing for a pending or failed outgoing message', () => {
    const pending = msg({ isOutgoing: true, stanzaId: undefined, originId: undefined })
    const failed = msg({ isOutgoing: true, deliveryError: { condition: 'x' } as never })
    expect(renderHook(() => useSavedMessageAction(pending)).result.current.onToggleSaved).toBeUndefined()
    expect(renderHook(() => useSavedMessageAction(failed)).result.current.onToggleSaved).toBeUndefined()
  })

  it.each(['chat', 'groupchat'] as const)('removes only the matched %s entry by its stored ID, including stale repeat activation', (type) => {
    const message: Message | RoomMessage = type === 'chat' ? msg() : {
      type: 'groupchat', id: 'room-message', roomJid: 'team@conference.fluux.chat',
      from: 'team@conference.fluux.chat/Emma', nick: 'Emma', body: 'The checklist is ready.',
      timestamp: new Date(1000), isOutgoing: false, stanzaId: 'room-archive', occupantId: undefined, originId: undefined,
    }
    const entry = { ...buildSavedMessage(message, 'romeo@montague.example/phone', 2000), id: 'synced-entry-id' }
    const other = { ...buildSavedMessage(msg({ id: 'other-message', stanzaId: 'other-archive' }), 'romeo@montague.example/phone', 1000), id: 'other-entry' }
    savedStore.getState().reconcileFetch([entry, other])
    const { result } = renderHook(() => useSavedMessageAction(message))
    expect(result.current.isSaved).toBe(true)
    const remove = result.current.onRemoveSaved
    act(() => remove())
    expect(result.current.isSaved).toBe(false)
    expect(savedStore.getState().entries).toEqual({ 'other-entry': other })
    expect(savedStore.getState().pending).toEqual({ 'synced-entry-id': 'retract' })
    act(() => { remove(); result.current.onRemoveSaved() })
    expect(savedStore.getState().entries).toEqual({ 'other-entry': other })
    expect(savedStore.getState().pending).toEqual({ 'synced-entry-id': 'retract' })
  })

  it('never saves when remove is activated without a matching entry', () => {
    const { result } = renderHook(() => useSavedMessageAction(msg()))
    act(() => result.current.onRemoveSaved())
    expect(savedStore.getState().entries).toEqual({})
    expect(savedStore.getState().pending).toEqual({})
  })

  it('toasts an error when the saved list is full', () => {
    savedStore.getState().setLimit(0)
    const { result } = renderHook(() => useSavedMessageAction(msg()))
    act(() => result.current.onToggleSaved!())
    expect(result.current.isSaved).toBe(false)
    expect(useToastStore.getState().toasts.some((t) => t.type === 'error')).toBe(true)
  })
})
