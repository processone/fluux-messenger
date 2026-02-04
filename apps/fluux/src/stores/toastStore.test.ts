import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useToastStore } from './toastStore'

describe('toastStore', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    // Reset store state between tests
    useToastStore.setState({ toasts: [] })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('adds a toast', () => {
    const { addToast } = useToastStore.getState()
    addToast('success', 'It worked')

    const { toasts } = useToastStore.getState()
    expect(toasts).toHaveLength(1)
    expect(toasts[0].type).toBe('success')
    expect(toasts[0].message).toBe('It worked')
  })

  it('returns the toast id', () => {
    const { addToast } = useToastStore.getState()
    const id = addToast('info', 'Hello')
    expect(id).toMatch(/^toast-/)
  })

  it('removes a toast by id', () => {
    const { addToast } = useToastStore.getState()
    const id = addToast('error', 'Oops', 0) // duration 0 = no auto-dismiss

    expect(useToastStore.getState().toasts).toHaveLength(1)

    useToastStore.getState().removeToast(id)
    expect(useToastStore.getState().toasts).toHaveLength(0)
  })

  it('auto-dismisses after default duration', () => {
    const { addToast } = useToastStore.getState()
    addToast('success', 'Temporary')

    expect(useToastStore.getState().toasts).toHaveLength(1)

    vi.advanceTimersByTime(4000)
    expect(useToastStore.getState().toasts).toHaveLength(0)
  })

  it('auto-dismisses after custom duration', () => {
    const { addToast } = useToastStore.getState()
    addToast('info', 'Quick', 1000)

    expect(useToastStore.getState().toasts).toHaveLength(1)

    vi.advanceTimersByTime(999)
    expect(useToastStore.getState().toasts).toHaveLength(1)

    vi.advanceTimersByTime(1)
    expect(useToastStore.getState().toasts).toHaveLength(0)
  })

  it('does not auto-dismiss when duration is 0', () => {
    const { addToast } = useToastStore.getState()
    addToast('error', 'Persistent', 0)

    vi.advanceTimersByTime(60000)
    expect(useToastStore.getState().toasts).toHaveLength(1)
  })

  it('evicts oldest toast when exceeding max (3)', () => {
    const { addToast } = useToastStore.getState()
    addToast('info', 'First', 0)
    addToast('info', 'Second', 0)
    addToast('info', 'Third', 0)

    expect(useToastStore.getState().toasts).toHaveLength(3)

    addToast('info', 'Fourth', 0)
    const { toasts } = useToastStore.getState()
    expect(toasts).toHaveLength(3)
    expect(toasts[0].message).toBe('Second')
    expect(toasts[2].message).toBe('Fourth')
  })

  it('removeToast is a no-op for unknown id', () => {
    const { addToast, removeToast } = useToastStore.getState()
    addToast('success', 'Keep me', 0)

    removeToast('nonexistent')
    expect(useToastStore.getState().toasts).toHaveLength(1)
  })

  it('supports all toast types', () => {
    const { addToast } = useToastStore.getState()
    addToast('success', 'a', 0)
    addToast('error', 'b', 0)
    addToast('info', 'c', 0)

    const types = useToastStore.getState().toasts.map(t => t.type)
    expect(types).toEqual(['success', 'error', 'info'])
  })
})
