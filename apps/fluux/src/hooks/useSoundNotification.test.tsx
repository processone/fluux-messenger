/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useSettingsStore } from '@/stores/settingsStore'

// FLM-145: after a reconnect, a burst of messages gives one chime once the 3-second wait ends.
let status = 'online'
let onConversationMessage: ((conv: unknown, message: unknown) => void) | undefined
const oscillators = vi.fn()

vi.mock('@fluux/sdk', () => ({
  usePresence: () => ({ presenceStatus: 'online' }),
  useConnectionStatus: () => ({ status }),
}))
vi.mock('./useNotificationEvents', () => ({
  useNotificationEvents: (h: { onConversationMessage?: typeof onConversationMessage }) => { onConversationMessage = h.onConversationMessage },
}))
vi.mock('./useNativePush', () => ({ announcedByPush: () => false }))

import { useSoundNotification } from './useSoundNotification'

describe('useSoundNotification', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    oscillators.mockClear()
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
})
