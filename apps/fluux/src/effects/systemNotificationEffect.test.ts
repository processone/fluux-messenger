import { describe, it, expect, vi, beforeEach } from 'vitest'

const addToast = vi.fn()
vi.mock('@/stores/toastStore', () => ({ useToastStore: { getState: () => ({ addToast }) } }))

// Minimal fake eventsStore with subscribe semantics.
let listeners: Array<() => void> = []
let state = { systemNotifications: [] as Array<{ id: string; type: string; title: string; message: string }>, removeSystemNotification: vi.fn() }
vi.mock('@fluux/sdk', () => ({
  eventsStore: {
    getState: () => state,
    subscribe: (fn: () => void) => { listeners.push(fn); return () => { listeners = listeners.filter((l) => l !== fn) } },
  },
}))

import { startSystemNotificationEffect } from './systemNotificationEffect'

function emit(next: typeof state.systemNotifications) {
  state = { ...state, systemNotifications: next }
  listeners.forEach((l) => l())
}

describe('systemNotificationEffect', () => {
  beforeEach(() => { vi.clearAllMocks(); listeners = []; state.systemNotifications = [] })

  it('toasts a transient notification and removes it from the store', () => {
    const stop = startSystemNotificationEffect()
    emit([{ id: 'n1', type: 'info', title: 'Hi', message: 'Synced' }])
    expect(addToast).toHaveBeenCalledWith('info', 'Synced', expect.any(Number))
    expect(state.removeSystemNotification).toHaveBeenCalledWith('n1')
    stop()
  })

  it('does NOT toast or remove a persistent auth-error (left for the status line)', () => {
    const stop = startSystemNotificationEffect()
    emit([{ id: 'n2', type: 'auth-error', title: 'Auth', message: 'Replaced' }])
    expect(addToast).not.toHaveBeenCalled()
    expect(state.removeSystemNotification).not.toHaveBeenCalledWith('n2')
    stop()
  })
})
