/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useSettingsStore } from '@/stores/settingsStore'

// FLM-145: after a reconnect, a burst of messages gives one chime once the 3-second wait ends.
let status = 'online'
let onConversationMessage: ((conv: unknown, message: unknown) => void) | undefined
let onConversationRead: ((id: string) => void) | undefined
let onRoomMessage: ((room: unknown, message: unknown) => void) | undefined
const oscillators = vi.fn()

const rooms = new Map<string, { notifyOffPersistent?: boolean }>()
vi.mock('@fluux/sdk', async (importOriginal) => ({
  resolveNotifyLevel: (await importOriginal<typeof import('@fluux/sdk')>()).resolveNotifyLevel,
  roomStore: { getState: () => ({ getRoom: (jid: string) => rooms.get(jid) }) },
  usePresence: () => ({ presenceStatus: 'online' }),
  useConnectionStatus: () => ({ status }),
}))
vi.mock('./useNotificationEvents', () => ({
  useNotificationEvents: (h: { onConversationMessage?: typeof onConversationMessage; onConversationRead?: typeof onConversationRead; onRoomMessage?: typeof onRoomMessage }) => {
    onConversationMessage = h.onConversationMessage
    onConversationRead = h.onConversationRead
    onRoomMessage = h.onRoomMessage
  },
}))
vi.mock('./useNativePush', () => ({ announcedByPush: () => false }))

import { useSoundNotification } from './useSoundNotification'

describe('useSoundNotification', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    oscillators.mockClear()
    rooms.clear()
    status = 'online'
    useSettingsStore.setState({ soundEnabled: true })
    ;(window as unknown as Record<string, unknown>).AudioContext = class {
      state = 'running'
      currentTime = 0
      destination = {}
      createOscillator() { oscillators(); return { connect() {}, start() {}, stop() {}, frequency: {}, type: '' } }
      createGain() { return { connect() {}, gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {} } } }
    }
  })
  afterEach(() => {
    vi.useRealTimers()
    delete (window as unknown as Record<string, unknown>).AudioContext
  })

  it('chimes once per message while already online', () => {
    const { rerender } = renderHook(() => useSoundNotification())
    rerender()
    onConversationMessage?.({}, {})
    onConversationMessage?.({}, {})
    expect(oscillators).toHaveBeenCalledTimes(4) // two tones per chime
  })

  // Captain's local-audio ownership rule: the existing hook keeps the room-message mute preference.
  it('does not chime for a room message when message sounds are disabled', () => {
    renderHook(() => useSoundNotification())
    act(() => { useSettingsStore.getState().setSoundEnabled(false) })
    onRoomMessage?.(
      { jid: 'team@muc.example.com', name: 'Team', nickname: 'me' },
      { id: 'muted-room-message', type: 'groupchat', from: 'team@muc.example.com/Alice', nick: 'Alice', body: 'Muted room message' },
    )
    expect(oscillators).not.toHaveBeenCalled()
  })

  it('chimes once for a reconnect burst, after the wait', () => {
    status = 'reconnecting'
    const { rerender } = renderHook(() => useSoundNotification())
    status = 'online'
    rerender()
    onConversationMessage?.({}, {})
    onConversationMessage?.({}, {})
    onConversationMessage?.({}, {})
    expect(oscillators).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(3000) })
    expect(oscillators).toHaveBeenCalledTimes(2)
  })

  // Review R4: a conversation read during the wait no longer needs its chime.
  it('drops the pending chime when every waiting conversation is read', () => {
    status = 'reconnecting'
    const { rerender } = renderHook(() => useSoundNotification())
    status = 'online'
    rerender()
    onConversationMessage?.({ id: 'alice' }, {})
    onConversationMessage?.({ id: 'bob' }, {})
    onConversationRead?.('alice')
    act(() => { vi.advanceTimersByTime(3000) })
    expect(oscillators).toHaveBeenCalledTimes(2)
    oscillators.mockClear()
    status = 'reconnecting'
    rerender()
    status = 'online'
    rerender()
    onConversationMessage?.({ id: 'alice' }, {})
    onConversationRead?.('alice')
    act(() => { vi.advanceTimersByTime(3000) })
    expect(oscillators).not.toHaveBeenCalled()
  })

  // FLM-189: a room set to Off while its chime waits no longer chimes; another waiting conversation still does.
  it('drops the pending chime of a room that became Off during the wait', () => {
    status = 'reconnecting'
    const { rerender } = renderHook(() => useSoundNotification())
    status = 'online'
    rerender()
    rooms.set('quiet@muc.example.com', {})
    onRoomMessage?.({ jid: 'quiet@muc.example.com' }, {})
    rooms.set('quiet@muc.example.com', { notifyOffPersistent: true })
    act(() => { vi.advanceTimersByTime(3000) })
    expect(oscillators).not.toHaveBeenCalled()
  })

  it('still chimes once when another conversation waits beside an Off room', () => {
    status = 'reconnecting'
    const { rerender } = renderHook(() => useSoundNotification())
    status = 'online'
    rerender()
    rooms.set('quiet@muc.example.com', { notifyOffPersistent: true })
    onRoomMessage?.({ jid: 'quiet@muc.example.com' }, {})
    onConversationMessage?.({ id: 'alice' }, {})
    act(() => { vi.advanceTimersByTime(3000) })
    expect(oscillators).toHaveBeenCalledTimes(2)
  })
})
